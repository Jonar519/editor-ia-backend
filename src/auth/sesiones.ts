// Sesiones y tokens de refresco. SQL explícito (Prisma $queryRaw) porque se necesitan FOR UPDATE y el
// tipo cidr, que Prisma no modela. La base garantiza además, por su cuenta: solo cuentas activas,
// un token vigente por sesión, uso único y ningún token nuevo para una sesión revocada.
import type { PrismaClient } from '../generated/prisma/client.js';
import { hashToken, tokenAleatorio } from './tokens.js';

/** Sesión: 7 días desde el login (absoluto). El refresh nunca dura más que su sesión. */
export const DURACION_SESION_DIAS = 7;

/** Cliente de Prisma dentro de una transacción. */
export type Tx = Omit<PrismaClient, '$connect' | '$disconnect' | '$on' | '$transaction' | '$extends'>;

export interface SesionNueva {
  sesionId: string;
  refresh: string;
  expiraEn: Date;
}

/** Crea sesión y su primer refresh. Llamar dentro de una transacción. */
export async function crearSesion(
  tx: Tx,
  d: { usuarioId: string; ipRed: string | null; userAgent: string | null; mfaVerificada?: boolean },
): Promise<SesionNueva> {
  // El vencimiento lo calcula la BASE con su reloj (ver insertarInvitacion: mismo motivo).
  const filas = await tx.$queryRaw<{ id: string; expira_en: Date }[]>`
    INSERT INTO sesiones (usuario_id, expira_en, ip_red, user_agent, mfa_verificada)
    VALUES (${d.usuarioId}::uuid, now() + make_interval(days => ${DURACION_SESION_DIAS}::int), ${d.ipRed}::cidr, ${d.userAgent}, ${d.mfaVerificada ?? false})
    RETURNING id, expira_en`;
  const sesionId = filas[0]?.id;
  const expira = filas[0]?.expira_en;
  if (!sesionId || !expira) throw new Error('No se creó la sesión');
  const refresh = tokenAleatorio();
  await tx.$executeRaw`
    INSERT INTO tokens_refresco (sesion_id, usuario_id, token_hash, expira_en)
    VALUES (${sesionId}::uuid, ${d.usuarioId}::uuid, ${hashToken(refresh)}, ${expira})`;
  return { sesionId, refresh, expiraEn: expira };
}

export interface UsuarioSesion {
  id: string;
  rol: 'admin' | 'editor' | 'lector';
  nombre: string;
  correo: string;
  sesionId: string;
}

/**
 * La sesión del access token sigue viva: no revocada, no vencida, y la cuenta sigue activa. El ROL se
 * lee de la base (no del token), así un cambio de rol rige en la siguiente petición.
 */
export async function validarSesion(db: Tx, sub: string, sid: string): Promise<UsuarioSesion | null> {
  const filas = await db.$queryRaw<{ id: string; rol: UsuarioSesion['rol']; nombre: string; correo: string }[]>`
    SELECT u.id, u.rol, u.nombre, u.correo::text AS correo
    FROM sesiones s JOIN usuarios u ON u.id = s.usuario_id
    WHERE s.id = ${sid}::uuid AND s.usuario_id = ${sub}::uuid
      AND s.revocada_en IS NULL AND s.expira_en > now() AND u.estado = 'activa'`;
  const f = filas[0];
  return f ? { ...f, sesionId: sid } : null;
}

export type ResultadoRotacion =
  | { tipo: 'ok'; usuarioId: string; sesionId: string; refresh: string; expiraEn: Date }
  | { tipo: 'reutilizado'; sesionId: string; usuarioId: string }
  | { tipo: 'invalido' };

/**
 * Rota el refresh: marca el presentado como usado y entrega uno nuevo de la misma familia (sesión).
 * Si el presentado YA estaba usado, alguien lo copió: se revoca la sesión entera, de modo que ni el
 * atacante ni la víctima puedan seguir refrescando (la víctima vuelve a iniciar sesión).
 */
export async function rotarRefresco(prisma: PrismaClient, refresh: string): Promise<ResultadoRotacion> {
  return prisma.$transaction(async (tx) => {
    const filas = await tx.$queryRaw<
      { id: string; sesion_id: string; usuario_id: string; usado_en: Date | null; expira_en: Date; revocada_en: Date | null; sesion_expira: Date; estado: string }[]
    >`
      SELECT t.id, t.sesion_id, t.usuario_id, t.usado_en, t.expira_en, s.revocada_en, s.expira_en AS sesion_expira, u.estado
      FROM tokens_refresco t
      JOIN sesiones s ON s.id = t.sesion_id
      JOIN usuarios u ON u.id = t.usuario_id
      WHERE t.token_hash = ${hashToken(refresh)}
      FOR UPDATE OF t, s`;
    const t = filas[0];
    if (!t) return { tipo: 'invalido' };
    if (t.usado_en !== null) {
      await tx.$executeRaw`
        UPDATE sesiones SET revocada_en = now(), motivo_revocacion = 'reutilizacion_refresco'
        WHERE id = ${t.sesion_id}::uuid AND revocada_en IS NULL`;
      return { tipo: 'reutilizado', sesionId: t.sesion_id, usuarioId: t.usuario_id };
    }
    const ahora = new Date();
    if (t.revocada_en !== null || t.expira_en <= ahora || t.sesion_expira <= ahora || t.estado !== 'activa') {
      return { tipo: 'invalido' };
    }
    await tx.$executeRaw`UPDATE tokens_refresco SET usado_en = now() WHERE id = ${t.id}::uuid`;
    const nuevo = tokenAleatorio();
    await tx.$executeRaw`
      INSERT INTO tokens_refresco (sesion_id, usuario_id, token_hash, expira_en)
      VALUES (${t.sesion_id}::uuid, ${t.usuario_id}::uuid, ${hashToken(nuevo)}, ${t.sesion_expira})`;
    await tx.$executeRaw`UPDATE sesiones SET ultimo_uso_en = now() WHERE id = ${t.sesion_id}::uuid`;
    return { tipo: 'ok', usuarioId: t.usuario_id, sesionId: t.sesion_id, refresh: nuevo, expiraEn: t.sesion_expira };
  });
}

export async function revocarSesion(db: Tx, sesionId: string, motivo: 'cierre' | 'cierre_otras' | 'cambio_contrasena' | 'bloqueo' | 'admin'): Promise<void> {
  await db.$executeRaw`
    UPDATE sesiones SET revocada_en = now(), motivo_revocacion = ${motivo}
    WHERE id = ${sesionId}::uuid AND revocada_en IS NULL`;
}
