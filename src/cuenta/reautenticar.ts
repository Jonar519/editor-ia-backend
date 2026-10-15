// Re-autenticación para las acciones sensibles de la cuenta (cambiar correo o contraseña, exportar,
// eliminar): un access token robado no basta, hace falta además la contraseña (y el MFA para eliminar).
// Los fallos suman al MISMO bloqueo progresivo que el login: no hay una vía para adivinar la contraseña
// sin límite desde una sesión abierta.
import { verificarContrasena } from '../auth/contrasenas.js';
import { registrarEvento } from '../auth/eventos.js';
import { sumarFalloCuenta, verificarCodigoCuenta } from '../auth/mfa.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';

type Deps = Pick<DependenciasApi, 'prisma' | 'senuelo' | 'claveMfa'>;

const reintentarEn = (hasta: Date) => String(Math.max(1, Math.ceil((hasta.getTime() - Date.now()) / 1000)));

export async function exigirContrasena(d: Deps, usuarioId: string, contrasena: string, ipRed: string | null): Promise<void> {
  const u = await d.prisma.usuarios.findUnique({ where: { id: usuarioId }, select: { hash_contrasena: true, bloqueada_hasta: true } });
  if (u?.bloqueada_hasta && u.bloqueada_hasta > new Date()) {
    throw new ErrorHttp(429, 'cuenta_bloqueada', 'Demasiados intentos fallidos. Espera antes de volver a intentar.', {
      reintentarEnSegundos: Number(reintentarEn(u.bloqueada_hasta)),
    });
  }
  if (!(await verificarContrasena(contrasena, u?.hash_contrasena ?? d.senuelo))) {
    await sumarFalloCuenta(d.prisma, usuarioId);
    await registrarEvento(d.prisma, 'inicio_fallido', usuarioId, ipRed);
    throw new ErrorHttp(403, 'contrasena_incorrecta', 'La contraseña no es correcta');
  }
}

/** Si la cuenta tiene MFA confirmado, exige además un código TOTP válido. */
export async function exigirMfaSiActivo(d: Deps, usuarioId: string, codigo: string | undefined, ipRed: string | null): Promise<void> {
  const mfa = await d.prisma.mfa_totp.findUnique({ where: { usuario_id: usuarioId }, select: { confirmado_en: true } });
  if (!mfa?.confirmado_en) return;
  if (codigo === undefined) throw new ErrorHttp(400, 'mfa_requerido', 'Envía también un código de tu app autenticadora');
  if (!(await verificarCodigoCuenta(d, usuarioId, codigo, { exigirConfirmado: true }))) {
    await sumarFalloCuenta(d.prisma, usuarioId);
    await registrarEvento(d.prisma, 'mfa_fallido', usuarioId, ipRed);
    throw new ErrorHttp(403, 'codigo_mfa_invalido', 'El código no es válido');
  }
}
