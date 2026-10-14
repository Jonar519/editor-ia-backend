// Inicio de sesión con bloqueo progresivo. La respuesta es la MISMA exista o no el correo: se verifica
// contra un hash señuelo cuando no hay cuenta, y los fallos de correos inexistentes se cuentan en Redis
// con la misma política que los de cuentas reales (que se cuentan en la base).
import type { DependenciasApi } from '../dependencias.js';
import type { SesionRespuesta } from '../http/esquemas.js';
import { verificarContrasena } from './contrasenas.js';
import { crearBloqueoFantasma, duracionBloqueoMs } from './limites.js';
import { crearSesion, type SesionNueva } from './sesiones.js';
import { emitirAcceso } from './tokens.js';

export type ResultadoInicio =
  | { tipo: 'ok'; respuesta: SesionRespuesta; sesion: SesionNueva }
  | { tipo: 'credenciales_invalidas' }
  | { tipo: 'bloqueada'; hasta: Date }
  | { tipo: 'mfa_requerido' };

export interface EntradaInicio {
  correo: string;
  contrasena: string;
  ipRed: string | null;
  userAgent: string | null;
}

/** Arma la respuesta de sesión (access token nuevo) para una cuenta. */
export function respuestaSesion(
  d: Pick<DependenciasApi, 'claveAcceso'>,
  u: { id: string; nombre: string; correo: string; rol: 'admin' | 'editor' | 'lector' },
  sesionId: string,
): SesionRespuesta {
  const { token, exp } = emitirAcceso(u.id, sesionId, d.claveAcceso);
  return { accessToken: token, expiraEn: exp, usuario: { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol } };
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
      if (ms > 0) {
        await d.prisma.usuarios.update({ where: { id: u.id }, data: { bloqueada_hasta: new Date(Date.now() + ms) } });
      }
    } else {
      await fantasma.registrarFallo(e.correo);
    }
    return { tipo: 'credenciales_invalidas' };
  }

  // MFA: el desafío TOTP llega en el bloque F. Hasta entonces una cuenta con MFA no obtiene sesión.
  const mfa = await d.prisma.mfa_totp.findUnique({ where: { usuario_id: u.id }, select: { confirmado_en: true } });
  if (mfa?.confirmado_en) return { tipo: 'mfa_requerido' };

  const correo = u.correo ?? e.correo;
  const sesion = await d.prisma.$transaction(async (tx) => {
    await tx.usuarios.update({ where: { id: u.id }, data: { fallos_login: 0, bloqueada_hasta: null } });
    return crearSesion(tx, { usuarioId: u.id, ipRed: e.ipRed, userAgent: e.userAgent });
  });
  const rol = u.rol as 'admin' | 'editor' | 'lector';
  return { tipo: 'ok', sesion, respuesta: respuestaSesion(d, { id: u.id, nombre: u.nombre ?? '', correo, rol }, sesion.sesionId) };
}
