// Sesiones activas de la cuenta: listar (IP truncada, ubicación aproximada, user-agent corto), cerrar
// una o cerrar todas las DEMÁS. Cerrar una sesión corta su access token en la petición siguiente
// (requiereSesion la consulta en cada petición) y su refresh ya no rota.
import { registrarEvento } from '../auth/eventos.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';

export async function listarSesiones(d: Pick<DependenciasApi, 'prisma'>, u: { id: string; sesionId: string }) {
  const filas = await d.prisma.$queryRaw<
    {
      id: string;
      creado_en: Date;
      ultimo_uso_en: Date;
      expira_en: Date;
      ip_red: string | null;
      ubicacion: string | null;
      user_agent: string | null;
      mfa_verificada: boolean;
    }[]
  >`
    SELECT id, creado_en, ultimo_uso_en, expira_en, ip_red::text AS ip_red, ubicacion, user_agent, mfa_verificada
    FROM sesiones
    WHERE usuario_id = ${u.id}::uuid AND revocada_en IS NULL AND expira_en > now()
    ORDER BY ultimo_uso_en DESC`;
  return filas.map((s) => ({
    id: s.id,
    actual: s.id === u.sesionId,
    creadaEn: s.creado_en.toISOString(),
    ultimoUsoEn: s.ultimo_uso_en.toISOString(),
    expiraEn: s.expira_en.toISOString(),
    ipRed: s.ip_red,
    ubicacion: s.ubicacion,
    userAgent: s.user_agent,
    mfaVerificada: s.mfa_verificada,
  }));
}

/** Cierra UNA sesión de la cuenta (también puede ser la actual). La de otra cuenta responde 404. */
export async function cerrarSesion(d: Pick<DependenciasApi, 'prisma'>, u: { id: string }, sesionId: string, ipRed: string | null): Promise<void> {
  const n = await d.prisma.$executeRaw`
    UPDATE sesiones SET revocada_en = now(), motivo_revocacion = 'cierre'
    WHERE id = ${sesionId}::uuid AND usuario_id = ${u.id}::uuid AND revocada_en IS NULL AND expira_en > now()`;
  if (n === 0) throw new ErrorHttp(404, 'sesion_no_encontrada', 'No hay una sesión activa con ese id en tu cuenta');
  await registrarEvento(d.prisma, 'sesion_cerrada', u.id, ipRed);
}

/** Cierra todas las sesiones de la cuenta MENOS la de esta petición. */
export async function cerrarOtrasSesiones(d: Pick<DependenciasApi, 'prisma'>, u: { id: string; sesionId: string }, ipRed: string | null): Promise<number> {
  const n = await d.prisma.$executeRaw`
    UPDATE sesiones SET revocada_en = now(), motivo_revocacion = 'cierre_otras'
    WHERE usuario_id = ${u.id}::uuid AND id <> ${u.sesionId}::uuid AND revocada_en IS NULL`;
  await registrarEvento(d.prisma, 'otras_sesiones_cerradas', u.id, ipRed);
  return n;
}
