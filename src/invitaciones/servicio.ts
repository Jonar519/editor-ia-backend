// Alta de cuentas SOLO por invitación. Quien invita nunca ve el enlace: el token se genera aquí, se
// guarda solo su SHA-256 y viaja únicamente dentro del correo a la persona invitada.
import { problemasDeContrasena, hashearContrasena } from '../auth/contrasenas.js';
import { respuestaSesion } from '../auth/servicio.js';
import { crearSesion, type SesionNueva, type Tx } from '../auth/sesiones.js';
import { hashToken, tokenAleatorio } from '../auth/tokens.js';
import { correoInvitacion } from '../correo/plantillas.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import type { SesionRespuesta } from '../http/esquemas.js';

/** Vigencia del enlace en horas (la base no admite más de 72). */
export const VIGENCIA_INVITACION_HORAS = 72;

/**
 * Inserta la invitación con el vencimiento calculado POR LA BASE (now() + 72 h). La base fija
 * creado_en = now() y exige expira_en <= creado_en + 72 h: si el vencimiento saliera del reloj del
 * servidor de aplicación y ese reloj fuera unos milisegundos adelantado, el INSERT fallaría a veces.
 */
async function insertarInvitacion(tx: Tx, usuarioId: string, token: string): Promise<Date> {
  const filas = await tx.$queryRaw<{ expira_en: Date }[]>`
    INSERT INTO invitaciones (usuario_id, token_hash, expira_en)
    VALUES (${usuarioId}::uuid, ${hashToken(token)}, now() + make_interval(hours => ${VIGENCIA_INVITACION_HORAS}::int))
    RETURNING expira_en`;
  const expira = filas[0]?.expira_en;
  if (!expira) throw new Error('No se creó la invitación');
  return expira;
}

type RolCuenta = 'admin' | 'editor' | 'lector';

/** Lo mínimo para invitar (también lo usa la CLI de operador, que no levanta Redis). */
export type DepsInvitar = Pick<DependenciasApi, 'prisma' | 'correo' | 'appUrl'>;

export interface Invitado {
  usuario: { id: string; nombre: string; correo: string; rol: RolCuenta; estado: 'pendiente' };
  expiraEn: Date;
  correoEnviado: boolean;
}

/** Envía el correo; si el proveedor falla, la invitación queda creada y se puede reenviar. */
async function enviarInvitacion(d: DepsInvitar, u: { correo: string; nombre: string; rol: RolCuenta }, token: string, expiraEn: Date) {
  try {
    await d.correo.enviar(correoInvitacion({ para: u.correo, nombre: u.nombre, rol: u.rol, appUrl: d.appUrl, token, expiraEn }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Crea la cuenta pendiente y su invitación. invitadaPor es el admin, o null para la CLI de operador
 * (alta del primer admin). La base exige que, si hay quien invita, sea un admin activo.
 */
export async function invitar(
  d: DepsInvitar,
  e: { invitadaPor: string | null; nombre: string; correo: string; rol: RolCuenta },
): Promise<Invitado> {
  const existe = await d.prisma.usuarios.findFirst({ where: { correo: e.correo }, select: { id: true } });
  if (existe) throw new ErrorHttp(409, 'correo_en_uso', 'Ya existe una cuenta o invitación con ese correo');
  const token = tokenAleatorio();
  const { usuario, expiraEn } = await d.prisma.$transaction(async (tx) => {
    const u = await tx.usuarios.create({
      data: { correo: e.correo, nombre: e.nombre, rol: e.rol, invitada_por: e.invitadaPor },
      select: { id: true },
    });
    return { usuario: u, expiraEn: await insertarInvitacion(tx, u.id, token) };
  });
  const correoEnviado = await enviarInvitacion(d, e, token, expiraEn);
  return { usuario: { id: usuario.id, nombre: e.nombre, correo: e.correo, rol: e.rol, estado: 'pendiente' }, expiraEn, correoEnviado };
}

/** Reemplaza el token (el enlace anterior deja de servir) y vuelve a enviar el correo. */
export async function reenviar(d: DepsInvitar, usuarioId: string): Promise<Invitado> {
  const u = await d.prisma.usuarios.findFirst({
    where: { id: usuarioId, estado: 'pendiente' },
    select: { id: true, nombre: true, correo: true, rol: true },
  });
  if (!u?.correo || !u.nombre) throw new ErrorHttp(404, 'invitacion_no_encontrada', 'No hay una invitación pendiente para esa cuenta');
  const token = tokenAleatorio();
  const expiraEn = await d.prisma.$transaction(async (tx) => {
    await tx.invitaciones.deleteMany({ where: { usuario_id: u.id } });
    return insertarInvitacion(tx, u.id, token);
  });
  const datos = { correo: u.correo, nombre: u.nombre, rol: u.rol as RolCuenta };
  const correoEnviado = await enviarInvitacion(d, datos, token, expiraEn);
  return { usuario: { id: u.id, ...datos, estado: 'pendiente' }, expiraEn, correoEnviado };
}

/** Cancela: borra la cuenta pendiente (la base solo permite borrar pendientes; la invitación cae en cascada). */
export async function cancelar(d: DependenciasApi, usuarioId: string): Promise<void> {
  const r = await d.prisma.usuarios.deleteMany({ where: { id: usuarioId, estado: 'pendiente' } });
  if (r.count === 0) throw new ErrorHttp(404, 'invitacion_no_encontrada', 'No hay una invitación pendiente para esa cuenta');
}

interface FilaInvitacion {
  id: string;
  nombre: string | null;
  correo: string | null;
  rol: RolCuenta;
  expira_en: Date;
  /** Calculado por la base con su reloj (no con el del servidor de aplicación). */
  vencida: boolean;
}

/** El listado nunca devuelve más que esto por página (respuesta acotada, aunque se acumulen invitaciones). */
export const LIMITE_LISTADO_MAXIMO = 200;

/** Invitaciones pendientes, las más recientes primero, de a una página. */
export async function listarPendientes(d: DependenciasApi, pagina: { limite: number; desde: number }) {
  const limite = Math.min(Math.max(pagina.limite, 1), LIMITE_LISTADO_MAXIMO);
  const [filas, total] = await Promise.all([
    d.prisma.$queryRaw<FilaInvitacion[]>`
      SELECT u.id, u.nombre, u.correo::text AS correo, u.rol, i.expira_en, i.expira_en <= now() AS vencida
      FROM invitaciones i JOIN usuarios u ON u.id = i.usuario_id
      ORDER BY i.creado_en DESC, i.id
      LIMIT ${limite} OFFSET ${Math.max(pagina.desde, 0)}`,
    d.prisma.invitaciones.count(),
  ]);
  return {
    total,
    invitaciones: filas.map((f) => ({
      usuarioId: f.id,
      nombre: f.nombre ?? '',
      correo: f.correo ?? '',
      rol: f.rol,
      expiraEn: f.expira_en.toISOString(),
      vencida: f.vencida,
    })),
  };
}

async function buscarPorToken(d: DependenciasApi, token: string): Promise<FilaInvitacion> {
  const filas = await d.prisma.$queryRaw<FilaInvitacion[]>`
    SELECT u.id, u.nombre, u.correo::text AS correo, u.rol, i.expira_en, i.expira_en <= now() AS vencida
    FROM invitaciones i JOIN usuarios u ON u.id = i.usuario_id
    WHERE i.token_hash = ${hashToken(token)}`;
  const inv = filas[0];
  if (!inv) throw new ErrorHttp(404, 'invitacion_invalida', 'El enlace no es válido o ya se usó');
  if (inv.vencida) throw new ErrorHttp(410, 'invitacion_vencida', 'El enlace venció. Pide una nueva invitación.');
  return inv;
}

export async function consultar(d: DependenciasApi, token: string) {
  const inv = await buscarPorToken(d, token);
  return { nombre: inv.nombre ?? '', correo: inv.correo ?? '', rol: inv.rol, requiereMfa: inv.rol === 'admin', expiraEn: inv.expira_en.toISOString() };
}

/**
 * Completa la cuenta: valida la contraseña, consume la invitación (se BORRA: un solo uso; la base además
 * no deja activar la cuenta mientras la invitación exista) y abre la primera sesión.
 */
export async function completar(
  d: DependenciasApi,
  e: { token: string; contrasena: string; ipRed: string | null; userAgent: string | null },
): Promise<{ respuesta: SesionRespuesta; sesion: SesionNueva }> {
  const u = await buscarPorToken(d, e.token);
  if (u.rol === 'admin') {
    // Un admin se activa con MFA en la misma transacción (lo exige la base): llega en el bloque F.
    throw new ErrorHttp(409, 'mfa_requerido', 'Las cuentas de administración se completan con verificación en dos pasos');
  }
  const problemas = problemasDeContrasena(e.contrasena, { correo: u.correo ?? '', nombre: u.nombre ?? '' });
  if (problemas.length > 0) throw new ErrorHttp(400, 'contrasena_debil', 'La contraseña no cumple la política', problemas);
  const hash = await hashearContrasena(e.contrasena, d.costoHash);

  const sesion = await d.prisma.$transaction(async (tx) => {
    // FOR UPDATE: dos envíos simultáneos del mismo enlace no pueden completar la cuenta dos veces.
    const vivas = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM invitaciones WHERE token_hash = ${hashToken(e.token)} AND expira_en > now() FOR UPDATE`;
    if (vivas.length === 0) throw new ErrorHttp(404, 'invitacion_invalida', 'El enlace no es válido o ya se usó');
    await tx.invitaciones.deleteMany({ where: { usuario_id: u.id } });
    await tx.usuarios.update({ where: { id: u.id }, data: { estado: 'activa', hash_contrasena: hash, activada_en: new Date() } });
    return crearSesion(tx, { usuarioId: u.id, ipRed: e.ipRed, userAgent: e.userAgent });
  });
  return { sesion, respuesta: respuestaSesion(d, { id: u.id, nombre: u.nombre ?? '', correo: u.correo ?? '', rol: u.rol }, sesion.sesionId) };
}
