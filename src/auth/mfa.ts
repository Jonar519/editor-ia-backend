// MFA TOTP: inscripción de un admin PENDIENTE (tabla inscripciones_mfa), MFA opcional de cuentas activas
// y el segundo paso del login. Los fallos de MFA suman al bloqueo progresivo de la cuenta.
import { createHash, randomBytes } from 'node:crypto';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import { claveCodigosRespaldo, cifrarSecreto, descifrarSecreto } from './cifrado.js';
import { generarCodigos, hashCodigo } from './codigos-respaldo.js';
import { registrarEvento } from './eventos.js';
import { duracionBloqueoMs } from './limites.js';
import type { Tx } from './sesiones.js';
import { tokenAleatorio } from './tokens.js';
import { base32, uriOtpauth, verificarTotp } from './totp.js';

/** Intentos fallidos de la inscripción previa antes de borrarla (la base no admite más de 5). */
export const MAX_INTENTOS_INSCRIPCION = 5;
/** Vida del desafío del segundo paso del login. */
export const DURACION_DESAFIO_S = 5 * 60;

export interface DatosInscripcion {
  /** Secreto en base32 para escribirlo a mano en la app. */
  secreto: string;
  /** otpauth:// para el QR (lo dibuja el cliente). */
  uri: string;
}

type DepsMfa = Pick<DependenciasApi, 'prisma' | 'claveMfa'>;

/** Registra un fallo de MFA en el contador de la cuenta (bloqueo progresivo). */
export async function sumarFalloCuenta(db: Tx, usuarioId: string): Promise<void> {
  const filas = await db.$queryRaw<{ fallos_login: number }[]>`
    UPDATE usuarios SET fallos_login = fallos_login + 1 WHERE id = ${usuarioId}::uuid RETURNING fallos_login`;
  const ms = duracionBloqueoMs(filas[0]?.fallos_login ?? 0);
  if (ms > 0) await db.usuarios.update({ where: { id: usuarioId }, data: { bloqueada_hasta: new Date(Date.now() + ms) } });
}

/** Guarda 10 códigos de respaldo nuevos (borra los anteriores) y los devuelve EN CLARO una única vez. */
export async function reemplazarCodigos(d: DepsMfa, tx: Tx, usuarioId: string): Promise<string[]> {
  const codigos = generarCodigos();
  const sub = claveCodigosRespaldo(d.claveMfa);
  await tx.codigos_respaldo.deleteMany({ where: { usuario_id: usuarioId } });
  await tx.codigos_respaldo.createMany({ data: codigos.map((c) => ({ usuario_id: usuarioId, hash_codigo: hashCodigo(sub, usuarioId, c) })) });
  return codigos;
}

// ─── Inscripción de un admin PENDIENTE ────────────────────────────────────────────

/**
 * Crea (o devuelve, si ya existe) la inscripción MFA de un admin pendiente, ligada a su invitación.
 * El vencimiento lo pone la base: el de la invitación (nunca más).
 */
export async function inscripcionPendiente(d: DepsMfa, inv: { invitacionId: string; usuarioId: string; correo: string }): Promise<DatosInscripcion> {
  const existente = await d.prisma.inscripciones_mfa.findUnique({
    where: { invitacion_id_usuario_id: { invitacion_id: inv.invitacionId, usuario_id: inv.usuarioId } },
  });
  let secreto: Buffer;
  if (existente) {
    secreto = descifrarSecreto(d.claveMfa, { cifrado: existente.secreto_cifrado, iv: existente.iv, etiqueta: existente.etiqueta }, inv.usuarioId);
  } else {
    secreto = randomBytes(20);
    const c = cifrarSecreto(d.claveMfa, secreto, inv.usuarioId);
    await d.prisma.$executeRaw`
      INSERT INTO inscripciones_mfa (invitacion_id, usuario_id, secreto_cifrado, iv, etiqueta, expira_en)
      SELECT id, usuario_id, ${c.cifrado}, ${c.iv}, ${c.etiqueta}, expira_en FROM invitaciones WHERE id = ${inv.invitacionId}::uuid`;
  }
  return { secreto: base32(secreto), uri: uriOtpauth(secreto, inv.correo) };
}

/**
 * Verifica el primer código contra la inscripción. Un fallo suma un intento; al quinto la inscripción se
 * borra y hay que empezar de nuevo (secreto nuevo). Devuelve el paso aceptado y el secreto cifrado.
 */
export async function verificarInscripcion(
  d: DepsMfa,
  inv: { invitacionId: string; usuarioId: string },
  codigo: string,
): Promise<{ paso: number; cifrado: { cifrado: Uint8Array<ArrayBuffer>; iv: Uint8Array<ArrayBuffer>; etiqueta: Uint8Array<ArrayBuffer> } }> {
  const ins = await d.prisma.inscripciones_mfa.findUnique({
    where: { invitacion_id_usuario_id: { invitacion_id: inv.invitacionId, usuario_id: inv.usuarioId } },
  });
  if (!ins || ins.expira_en <= new Date()) {
    throw new ErrorHttp(409, 'mfa_requerido', 'Primero configura la verificación en dos pasos');
  }
  const secreto = descifrarSecreto(d.claveMfa, { cifrado: ins.secreto_cifrado, iv: ins.iv, etiqueta: ins.etiqueta }, inv.usuarioId);
  const paso = verificarTotp(secreto, codigo, Date.now(), null);
  if (paso === null) {
    if (ins.intentos + 1 >= MAX_INTENTOS_INSCRIPCION) {
      await d.prisma.inscripciones_mfa.delete({ where: { id: ins.id } });
      throw new ErrorHttp(400, 'mfa_reiniciar', 'Demasiados códigos incorrectos. Vuelve a configurar la app autenticadora.');
    }
    await d.prisma.inscripciones_mfa.update({ where: { id: ins.id }, data: { intentos: { increment: 1 } } });
    throw new ErrorHttp(400, 'codigo_mfa_invalido', 'El código no es válido');
  }
  return { paso, cifrado: { cifrado: ins.secreto_cifrado, iv: ins.iv, etiqueta: ins.etiqueta } };
}

// ─── MFA opcional de una cuenta ACTIVA ───────────────────────────────────────────

async function mfaDe(d: DepsMfa, usuarioId: string) {
  return d.prisma.mfa_totp.findUnique({ where: { usuario_id: usuarioId } });
}

/** Empieza (o reinicia) la configuración. Si ya hay MFA confirmado, primero hay que desactivarlo. */
export async function iniciarMfaCuenta(d: DepsMfa, u: { id: string; correo: string }): Promise<DatosInscripcion> {
  const actual = await mfaDe(d, u.id);
  if (actual?.confirmado_en) throw new ErrorHttp(409, 'mfa_ya_activo', 'La verificación en dos pasos ya está activa');
  const secreto = randomBytes(20);
  const c = cifrarSecreto(d.claveMfa, secreto, u.id);
  await d.prisma.$transaction(async (tx) => {
    await tx.mfa_totp.deleteMany({ where: { usuario_id: u.id, confirmado_en: null } });
    await tx.mfa_totp.create({ data: { usuario_id: u.id, secreto_cifrado: c.cifrado, iv: c.iv, etiqueta: c.etiqueta } });
  });
  return { secreto: base32(secreto), uri: uriOtpauth(secreto, u.correo) };
}

/**
 * Verifica un código TOTP de una cuenta activa con ANTI-REPLAY atómico: el paso aceptado se guarda solo
 * si es mayor que el último (la base también lo exige). Un fallo suma al bloqueo de la cuenta.
 */
export async function verificarCodigoCuenta(
  d: DepsMfa,
  usuarioId: string,
  codigo: string,
  o: { exigirConfirmado: boolean },
): Promise<boolean> {
  const m = await mfaDe(d, usuarioId);
  if (!m || (o.exigirConfirmado && !m.confirmado_en)) return false;
  const secreto = descifrarSecreto(d.claveMfa, { cifrado: m.secreto_cifrado, iv: m.iv, etiqueta: m.etiqueta }, usuarioId);
  const ultimo = m.ultimo_paso === null ? null : Number(m.ultimo_paso);
  const paso = verificarTotp(secreto, codigo, Date.now(), ultimo);
  if (paso === null) return false;
  const filas = await d.prisma.$executeRaw`
    UPDATE mfa_totp SET ultimo_paso = ${paso}
    WHERE usuario_id = ${usuarioId}::uuid AND (ultimo_paso IS NULL OR ultimo_paso < ${paso})`;
  return filas === 1;
}

export async function confirmarMfaCuenta(d: DepsMfa, usuarioId: string, codigo: string, ipRed: string | null): Promise<string[]> {
  const m = await mfaDe(d, usuarioId);
  if (!m) throw new ErrorHttp(409, 'mfa_no_iniciado', 'Primero inicia la configuración');
  if (m.confirmado_en) throw new ErrorHttp(409, 'mfa_ya_activo', 'La verificación en dos pasos ya está activa');
  if (!(await verificarCodigoCuenta(d, usuarioId, codigo, { exigirConfirmado: false }))) {
    await sumarFalloCuenta(d.prisma, usuarioId);
    await registrarEvento(d.prisma, 'mfa_fallido', usuarioId, ipRed);
    throw new ErrorHttp(400, 'codigo_mfa_invalido', 'El código no es válido');
  }
  return d.prisma.$transaction(async (tx) => {
    await tx.mfa_totp.update({ where: { usuario_id: usuarioId }, data: { confirmado_en: new Date() } });
    await registrarEvento(tx, 'mfa_activado', usuarioId, ipRed);
    return reemplazarCodigos(d, tx, usuarioId);
  });
}

/** Exige un código TOTP válido; si falla, suma al bloqueo y responde 400 genérico. */
async function exigirCodigo(d: DepsMfa, usuarioId: string, codigo: string, ipRed: string | null): Promise<void> {
  if (!(await verificarCodigoCuenta(d, usuarioId, codigo, { exigirConfirmado: true }))) {
    await sumarFalloCuenta(d.prisma, usuarioId);
    await registrarEvento(d.prisma, 'mfa_fallido', usuarioId, ipRed);
    throw new ErrorHttp(400, 'codigo_mfa_invalido', 'El código no es válido');
  }
}

/** Desactivar: solo cuentas que NO son admin (para un admin es obligatorio; la base también lo exige). */
export async function desactivarMfaCuenta(d: DepsMfa, u: { id: string; rol: string }, codigo: string, ipRed: string | null): Promise<void> {
  if (u.rol === 'admin') throw new ErrorHttp(409, 'mfa_obligatorio', 'Para una cuenta de administración la verificación en dos pasos es obligatoria');
  await exigirCodigo(d, u.id, codigo, ipRed);
  await d.prisma.$transaction(async (tx) => {
    await tx.mfa_totp.delete({ where: { usuario_id: u.id } });
    await registrarEvento(tx, 'mfa_desactivado', u.id, ipRed);
  });
}

export async function regenerarCodigos(d: DepsMfa, usuarioId: string, codigo: string, ipRed: string | null): Promise<string[]> {
  await exigirCodigo(d, usuarioId, codigo, ipRed);
  return d.prisma.$transaction(async (tx) => {
    await registrarEvento(tx, 'codigos_respaldo_regenerados', usuarioId, ipRed);
    return reemplazarCodigos(d, tx, usuarioId);
  });
}

/** Consume un código de respaldo (un solo uso). */
export async function usarCodigoRespaldo(d: DepsMfa, usuarioId: string, codigo: string): Promise<boolean> {
  const h = hashCodigo(claveCodigosRespaldo(d.claveMfa), usuarioId, codigo);
  const filas = await d.prisma.$executeRaw`
    UPDATE codigos_respaldo SET usado_en = now()
    WHERE usuario_id = ${usuarioId}::uuid AND hash_codigo = ${h} AND usado_en IS NULL`;
  return filas === 1;
}

// ─── Desafío del segundo paso del login (Redis: solo el hash, 5 min, un solo uso) ─

export interface DatosDesafio {
  usuarioId: string;
  ipRed: string | null;
  userAgent: string | null;
}

const claveDesafio = (prefijo: string, desafio: string) =>
  `${prefijo}mfa:desafio:${createHash('sha256').update(desafio).digest('hex')}`;

export async function crearDesafio(d: Pick<DependenciasApi, 'redis' | 'prefijoRedis'>, datos: DatosDesafio): Promise<string> {
  const desafio = tokenAleatorio();
  await d.redis.set(claveDesafio(d.prefijoRedis, desafio), JSON.stringify(datos), 'EX', DURACION_DESAFIO_S);
  return desafio;
}

/** Lo consume (GETDEL): un desafío sirve UNA vez, acierte o falle el código. */
export async function consumirDesafio(d: Pick<DependenciasApi, 'redis' | 'prefijoRedis'>, desafio: string): Promise<DatosDesafio | null> {
  const v = await d.redis.getdel(claveDesafio(d.prefijoRedis, desafio));
  return v ? (JSON.parse(v) as DatosDesafio) : null;
}
