// Perfil, cambio de correo (con re-verificación de la dirección nueva y aviso a la anterior) y cambio de
// contraseña (cierra las DEMÁS sesiones).
import { hashearContrasena, problemasDeContrasena } from '../auth/contrasenas.js';
import { registrarEvento } from '../auth/eventos.js';
import { hashToken, tokenAleatorio } from '../auth/tokens.js';
import { correoAvisoCambioContrasena, correoAvisoCambioCorreo, correoCambioCorreo } from '../correo/plantillas.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import { exigirContrasena } from './reautenticar.js';

/** Vigencia del enlace que confirma el correo nuevo (la base admite hasta 24 h). */
export const VIGENCIA_CAMBIO_CORREO_MIN = 60;

export async function leerPerfil(d: Pick<DependenciasApi, 'prisma'>, usuarioId: string) {
  const u = await d.prisma.usuarios.findUniqueOrThrow({
    where: { id: usuarioId },
    select: {
      id: true,
      nombre: true,
      correo: true,
      telefono: true,
      rol: true,
      creado_en: true,
      activada_en: true,
      mfa_totp: { select: { confirmado_en: true } },
      avatares: { select: { tipo: true, ancho: true, alto: true, hash: true } },
    },
  });
  const cambio = await d.prisma.cambios_correo.findFirst({
    where: { usuario_id: usuarioId, confirmado_en: null, expira_en: { gt: new Date() } },
    select: { correo_nuevo: true, expira_en: true },
  });
  return {
    id: u.id,
    nombre: u.nombre ?? '',
    correo: u.correo ?? '',
    telefono: u.telefono,
    rol: u.rol as 'admin' | 'editor' | 'lector',
    creadaEn: u.creado_en.toISOString(),
    activadaEn: u.activada_en?.toISOString() ?? null,
    mfaActivo: Boolean(u.mfa_totp?.confirmado_en),
    avatar: u.avatares
      ? { tipo: u.avatares.tipo as 'image/jpeg' | 'image/png', ancho: u.avatares.ancho, alto: u.avatares.alto, hash: Buffer.from(u.avatares.hash).toString('hex') }
      : null,
    cambioCorreoPendiente: cambio ? { correoNuevo: cambio.correo_nuevo, expiraEn: cambio.expira_en.toISOString() } : null,
  };
}

export async function actualizarPerfil(
  d: Pick<DependenciasApi, 'prisma'>,
  usuarioId: string,
  cambios: { nombre?: string | undefined; telefono?: string | null | undefined },
  ipRed: string | null,
) {
  await d.prisma.$transaction(async (tx) => {
    await tx.usuarios.update({
      where: { id: usuarioId },
      data: { ...(cambios.nombre !== undefined && { nombre: cambios.nombre }), ...(cambios.telefono !== undefined && { telefono: cambios.telefono }) },
    });
    await registrarEvento(tx, 'perfil_actualizado', usuarioId, ipRed);
  });
  return leerPerfil(d, usuarioId);
}

/** Respuesta ÚNICA de pedir un cambio de correo, esté o no en uso la dirección nueva. */
export const MENSAJE_CAMBIO_CORREO = 'Si la dirección está disponible, te enviamos un enlace para confirmarla. El cambio se hace al abrirlo.';

/**
 * Pedir el cambio. Lo que depende de la persona (contraseña, que la dirección sea otra) se valida antes
 * de responder. Lo que revelaría si la dirección ya tiene cuenta se hace DESPUÉS de responder (el
 * llamador no lo espera), igual que la recuperación: ni el cuerpo ni el tiempo dicen nada.
 */
export async function validarCambioCorreo(
  d: Pick<DependenciasApi, 'prisma' | 'senuelo' | 'claveMfa'>,
  u: { id: string; correo: string },
  e: { correoNuevo: string; contrasena: string; ipRed: string | null },
): Promise<void> {
  await exigirContrasena(d, u.id, e.contrasena, e.ipRed);
  if (e.correoNuevo.toLowerCase() === u.correo.toLowerCase()) throw new ErrorHttp(400, 'mismo_correo', 'Ese ya es tu correo');
}

/** Trabajo en segundo plano del cambio de correo. */
export async function procesarCambioCorreo(d: DependenciasApi, usuarioId: string, correoNuevo: string, ipRed: string | null): Promise<void> {
  const enUso = await d.prisma.usuarios.findFirst({ where: { correo: correoNuevo }, select: { id: true } });
  if (enUso) return; // nada que enviar: el correo ya tiene cuenta (y no se dice)
  const u = await d.prisma.usuarios.findUniqueOrThrow({ where: { id: usuarioId }, select: { nombre: true, correo: true } });
  const token = tokenAleatorio();
  const expiraEn = await d.prisma.$transaction(async (tx) => {
    // Pedir otro invalida el anterior (la base admite como máximo uno pendiente por cuenta).
    await tx.cambios_correo.deleteMany({ where: { usuario_id: usuarioId, confirmado_en: null } });
    const filas = await tx.$queryRaw<{ expira_en: Date }[]>`
      INSERT INTO cambios_correo (usuario_id, correo_nuevo, token_hash, expira_en)
      VALUES (${usuarioId}::uuid, ${correoNuevo}, ${hashToken(token)}, now() + make_interval(mins => ${VIGENCIA_CAMBIO_CORREO_MIN}::int))
      RETURNING expira_en`;
    await registrarEvento(tx, 'cambio_correo_solicitado', usuarioId, ipRed);
    return filas[0]?.expira_en ?? new Date();
  });
  const nombre = u.nombre ?? '';
  await d.correo.enviar(correoCambioCorreo({ para: correoNuevo, nombre, appUrl: d.appUrl, token, expiraEn }));
  if (u.correo) await d.correo.enviar(correoAvisoCambioCorreo({ para: u.correo, nombre, correoNuevo, momento: 'solicitado' }));
}

const ENLACE_INVALIDO = () => new ErrorHttp(400, 'enlace_invalido', 'El enlace no es válido, ya se usó o venció. Pide el cambio de nuevo.');

/**
 * Confirmar desde el enlace del correo NUEVO. Basta el token (puede abrirse en otro navegador). Al
 * confirmar se invalidan los enlaces de recuperación pendientes: se enviaron a la dirección anterior.
 */
export async function confirmarCambioCorreo(d: DependenciasApi, token: string, ipRed: string | null): Promise<void> {
  const r = await d.prisma.$transaction(async (tx) => {
    const filas = await tx.$queryRaw<{ id: string; usuario_id: string; correo_nuevo: string; anterior: string | null; nombre: string | null }[]>`
      SELECT c.id, c.usuario_id, c.correo_nuevo::text AS correo_nuevo, u.correo::text AS anterior, u.nombre
      FROM cambios_correo c JOIN usuarios u ON u.id = c.usuario_id
      WHERE c.token_hash = ${hashToken(token)} AND c.confirmado_en IS NULL AND c.expira_en > now() AND u.estado = 'activa'
      FOR UPDATE OF c, u`;
    const c = filas[0];
    if (!c) throw ENLACE_INVALIDO();
    const ocupado = await tx.usuarios.findFirst({ where: { correo: c.correo_nuevo, NOT: { id: c.usuario_id } }, select: { id: true } });
    if (ocupado) throw new ErrorHttp(409, 'correo_en_uso', 'Esa dirección ya tiene una cuenta');
    await tx.usuarios.update({ where: { id: c.usuario_id }, data: { correo: c.correo_nuevo } });
    await tx.$executeRaw`UPDATE cambios_correo SET confirmado_en = now() WHERE id = ${c.id}::uuid`;
    await tx.tokens_recuperacion.deleteMany({ where: { usuario_id: c.usuario_id, usado_en: null } });
    await registrarEvento(tx, 'correo_cambiado', c.usuario_id, ipRed);
    return c;
  });
  if (r.anterior) {
    await d.correo
      .enviar(correoAvisoCambioCorreo({ para: r.anterior, nombre: r.nombre ?? '', correoNuevo: r.correo_nuevo, momento: 'realizado' }))
      .catch(() => undefined); // el cambio ya está hecho
  }
}

/**
 * Cambiar la contraseña desde la cuenta: exige la actual, aplica la política, cierra las DEMÁS sesiones
 * (la actual sigue) e invalida los enlaces de recuperación pendientes.
 */
export async function cambiarContrasena(
  d: DependenciasApi,
  u: { id: string; sesionId: string },
  e: { actual: string; nueva: string; ipRed: string | null },
): Promise<{ cerradas: number }> {
  await exigirContrasena(d, u.id, e.actual, e.ipRed);
  const datos = await d.prisma.usuarios.findUniqueOrThrow({ where: { id: u.id }, select: { correo: true, nombre: true } });
  const problemas = problemasDeContrasena(e.nueva, { correo: datos.correo ?? '', nombre: datos.nombre ?? '' });
  if (problemas.length > 0) throw new ErrorHttp(400, 'contrasena_debil', 'La contraseña no cumple la política', problemas);
  const hash = await hashearContrasena(e.nueva, d.costoHash);
  const cerradas = await d.prisma.$transaction(async (tx) => {
    await tx.usuarios.update({ where: { id: u.id }, data: { hash_contrasena: hash, fallos_login: 0, bloqueada_hasta: null } });
    const n = await tx.$executeRaw`
      UPDATE sesiones SET revocada_en = now(), motivo_revocacion = 'cambio_contrasena'
      WHERE usuario_id = ${u.id}::uuid AND id <> ${u.sesionId}::uuid AND revocada_en IS NULL`;
    await tx.tokens_recuperacion.deleteMany({ where: { usuario_id: u.id, usado_en: null } });
    await registrarEvento(tx, 'contrasena_cambiada', u.id, e.ipRed);
    return n;
  });
  if (datos.correo) {
    await d.correo.enviar(correoAvisoCambioContrasena({ para: datos.correo, nombre: datos.nombre ?? '' })).catch(() => undefined);
  }
  return { cerradas };
}
