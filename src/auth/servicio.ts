// Inicio de sesión con bloqueo progresivo y, para cuentas con MFA, un segundo paso con desafío.
// La respuesta es la MISMA exista o no el correo: se verifica contra un hash señuelo cuando no hay cuenta,
// y los fallos de correos inexistentes se cuentan en Redis con la misma política que los de cuentas
// reales (que se cuentan en la base). Cada paso deja su evento en eventos_seguridad.
import type { DependenciasApi } from '../dependencias.js';
import type { SesionRespuesta } from '../http/esquemas.js';
import { verificarContrasena } from './contrasenas.js';
import { registrarEvento } from './eventos.js';
import { crearBloqueoFantasma, duracionBloqueoMs } from './limites.js';
import { consumirDesafio, crearDesafio, sumarFalloCuenta, usarCodigoRespaldo, verificarCodigoCuenta } from './mfa.js';
import { crearSesion, type SesionNueva } from './sesiones.js';
import { emitirAcceso } from './tokens.js';

export type ResultadoInicio =
  | { tipo: 'ok'; respuesta: SesionRespuesta; sesion: SesionNueva }
  | { tipo: 'credenciales_invalidas' }
  | { tipo: 'bloqueada'; hasta: Date }
  | { tipo: 'mfa_requerido'; desafio: string };

export interface EntradaInicio {
  correo: string;
  contrasena: string;
  ipRed: string | null;
  userAgent: string | null;
}

type Rol = 'admin' | 'editor' | 'lector';

/** Arma la respuesta de sesión (access token nuevo) para una cuenta. */
export function respuestaSesion(
  d: Pick<DependenciasApi, 'claveAcceso'>,
  u: { id: string; nombre: string; correo: string; rol: Rol },
  sesionId: string,
): SesionRespuesta {
  const { token, exp } = emitirAcceso(u.id, sesionId, d.claveAcceso);
  return { accessToken: token, expiraEn: exp, usuario: { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol } };
}

/** Abre la sesión de una cuenta ya verificada y deja el contador de fallos en cero. */
async function abrirSesion(
  d: DependenciasApi,
  u: { id: string; nombre: string | null; correo: string | null; rol: string },
  e: { ipRed: string | null; userAgent: string | null; mfaVerificada: boolean },
): Promise<{ respuesta: SesionRespuesta; sesion: SesionNueva }> {
  const sesion = await d.prisma.$transaction(async (tx) => {
    await tx.usuarios.update({ where: { id: u.id }, data: { fallos_login: 0, bloqueada_hasta: null } });
    await registrarEvento(tx, 'inicio_sesion', u.id, e.ipRed);
    return crearSesion(tx, { usuarioId: u.id, ipRed: e.ipRed, userAgent: e.userAgent, mfaVerificada: e.mfaVerificada });
  });
  const respuesta = respuestaSesion(d, { id: u.id, nombre: u.nombre ?? '', correo: u.correo ?? '', rol: u.rol as Rol }, sesion.sesionId);
  return { respuesta, sesion };
}

export async function iniciarSesion(d: DependenciasApi, e: EntradaInicio): Promise<ResultadoInicio> {
  const fantasma = crearBloqueoFantasma(d.redis, d.prefijoRedis);
  const u = await d.prisma.usuarios.findFirst({
    where: { correo: e.correo, estado: 'activa' },
    select: { id: true, nombre: true, correo: true, rol: true, hash_contrasena: true, bloqueada_hasta: true },
  });
  const ahora = new Date();

  // Bloqueada: no se verifica la contraseña (ni gasta CPU ni da pistas).
  const bloqueadaHasta = u ? u.bloqueada_hasta : (await fantasma.leer(e.correo)).hasta;
  if (bloqueadaHasta && bloqueadaHasta > ahora) return { tipo: 'bloqueada', hasta: bloqueadaHasta };

  const valida = await verificarContrasena(e.contrasena, u?.hash_contrasena ?? d.senuelo);
  if (!u || !valida) {
    if (u) {
      const filas = await d.prisma.$queryRaw<{ fallos_login: number }[]>`
        UPDATE usuarios SET fallos_login = fallos_login + 1 WHERE id = ${u.id}::uuid RETURNING fallos_login`;
      const ms = duracionBloqueoMs(filas[0]?.fallos_login ?? 0);
      await registrarEvento(d.prisma, 'inicio_fallido', u.id, e.ipRed);
      if (ms > 0) {
        await d.prisma.usuarios.update({ where: { id: u.id }, data: { bloqueada_hasta: new Date(Date.now() + ms) } });
        await registrarEvento(d.prisma, 'cuenta_bloqueada', u.id, e.ipRed);
      }
    } else {
      await fantasma.registrarFallo(e.correo);
      await registrarEvento(d.prisma, 'inicio_fallido', null, e.ipRed);
    }
    return { tipo: 'credenciales_invalidas' };
  }

  // Con MFA confirmado: segundo paso. El contador de fallos se reinicia recién al superar el MFA.
  const mfa = await d.prisma.mfa_totp.findUnique({ where: { usuario_id: u.id }, select: { confirmado_en: true } });
  if (mfa?.confirmado_en) {
    const desafio = await crearDesafio(d, { usuarioId: u.id, ipRed: e.ipRed, userAgent: e.userAgent });
    await registrarEvento(d.prisma, 'mfa_desafio', u.id, e.ipRed);
    return { tipo: 'mfa_requerido', desafio };
  }

  const r = await abrirSesion(d, u, { ipRed: e.ipRed, userAgent: e.userAgent, mfaVerificada: false });
  return { tipo: 'ok', ...r };
}

export type ResultadoMfa = { tipo: 'ok'; respuesta: SesionRespuesta; sesion: SesionNueva } | { tipo: 'invalido' } | { tipo: 'bloqueada'; hasta: Date };

/**
 * Segundo paso: el desafío se CONSUME al primer intento (acierte o no). Un desafío inexistente, vencido o
 * ya usado responde exactamente igual que un código incorrecto: no revela si la cuenta existe.
 */
export async function completarMfa(
  d: DependenciasApi,
  e: { desafio: string; codigo?: string | undefined; codigoRespaldo?: string | undefined; ipRed: string | null },
): Promise<ResultadoMfa> {
  const datos = await consumirDesafio(d, e.desafio);
  if (!datos) return { tipo: 'invalido' };
  const u = await d.prisma.usuarios.findFirst({
    where: { id: datos.usuarioId, estado: 'activa' },
    select: { id: true, nombre: true, correo: true, rol: true, bloqueada_hasta: true },
  });
  if (!u) return { tipo: 'invalido' };
  if (u.bloqueada_hasta && u.bloqueada_hasta > new Date()) return { tipo: 'bloqueada', hasta: u.bloqueada_hasta };

  let valido = false;
  let porRespaldo = false;
  if (e.codigo !== undefined) {
    valido = await verificarCodigoCuenta(d, u.id, e.codigo, { exigirConfirmado: true });
  } else if (e.codigoRespaldo !== undefined) {
    valido = await usarCodigoRespaldo(d, u.id, e.codigoRespaldo);
    porRespaldo = valido;
  }
  if (!valido) {
    await sumarFalloCuenta(d.prisma, u.id);
    await registrarEvento(d.prisma, 'mfa_fallido', u.id, e.ipRed);
    return { tipo: 'invalido' };
  }
  await registrarEvento(d.prisma, 'mfa_correcto', u.id, e.ipRed);
  if (porRespaldo) await registrarEvento(d.prisma, 'codigo_respaldo_usado', u.id, e.ipRed);
  const r = await abrirSesion(d, u, { ipRed: datos.ipRed, userAgent: datos.userAgent, mfaVerificada: true });
  return { tipo: 'ok', ...r };
}
