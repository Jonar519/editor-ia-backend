// Avatar: se limpia (lista blanca de segmentos/chunks, src/imagen/limpiar.ts) ANTES de tocar la base.
// Si el archivo no se puede analizar, se rechaza con 422 y no se guarda nada: ni el original ni una parte.
import { registrarEvento } from '../auth/eventos.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import { ErrorImagen, limpiarImagen } from '../imagen/limpiar.js';

/** Tamaño máximo del archivo subido (la base admite lo mismo para el ya limpio). */
export const BYTES_MAXIMOS_AVATAR = 1024 * 1024;

export async function guardarAvatar(d: Pick<DependenciasApi, 'prisma'>, usuarioId: string, archivo: Buffer, ipRed: string | null) {
  let limpia;
  try {
    limpia = limpiarImagen(archivo);
  } catch (e) {
    if (e instanceof ErrorImagen) throw new ErrorHttp(422, 'imagen_no_valida', 'La imagen no se pudo analizar: solo JPEG o PNG válidos', e.motivo);
    throw e;
  }
  // El hash lo calcula la base (y su CHECK lo comprueba): sirve de ETag.
  const filas = await d.prisma.$transaction(async (tx) => {
    const f = await tx.$queryRaw<{ hash: Uint8Array }[]>`
      INSERT INTO avatares (usuario_id, tipo, datos, ancho, alto, hash)
      VALUES (${usuarioId}::uuid, ${limpia.tipo}, ${limpia.datos}, ${limpia.ancho}, ${limpia.alto}, sha256(${limpia.datos}))
      ON CONFLICT (usuario_id) DO UPDATE
        SET tipo = EXCLUDED.tipo, datos = EXCLUDED.datos, ancho = EXCLUDED.ancho, alto = EXCLUDED.alto, hash = EXCLUDED.hash
      RETURNING hash`;
    await registrarEvento(tx, 'avatar_actualizado', usuarioId, ipRed);
    return f;
  });
  const hash = Buffer.from(filas[0]?.hash ?? []).toString('hex');
  return { tipo: limpia.tipo, ancho: limpia.ancho, alto: limpia.alto, bytes: limpia.datos.length, hash };
}

export async function borrarAvatar(d: Pick<DependenciasApi, 'prisma'>, usuarioId: string, ipRed: string | null): Promise<void> {
  await d.prisma.$transaction(async (tx) => {
    const { count } = await tx.avatares.deleteMany({ where: { usuario_id: usuarioId } });
    if (count > 0) await registrarEvento(tx, 'avatar_eliminado', usuarioId, ipRed);
  });
}

/** El avatar de una cuenta activa (la base no admite avatares de otras), o null. */
export async function leerAvatar(d: Pick<DependenciasApi, 'prisma'>, usuarioId: string) {
  const a = await d.prisma.avatares.findUnique({ where: { usuario_id: usuarioId }, select: { tipo: true, datos: true, hash: true } });
  return a ? { tipo: a.tipo, datos: Buffer.from(a.datos), hash: Buffer.from(a.hash).toString('hex') } : null;
}
