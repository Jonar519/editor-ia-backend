// Comentarios anclados (bloque N). Un hilo se ancla a un tramo del texto con dos POSICIONES RELATIVAS de
// Yjs (inicio y fin): siguen al texto aunque se edite antes o después, y si el tramo se borra el navegador
// lo muestra como "texto eliminado". Las respuestas no llevan ancla: heredan la del hilo (lo exige la base).
//
// Quién puede qué (además de la base, que exige acceso al documento para comentar):
//   ver y comentar ............... cualquier rol (un lector también comenta)
//   editar el texto .............. solo quien lo escribió
//   resolver o reabrir un hilo ... quien lo abrió, o un editor o propietario del documento
//   borrar ....................... quien lo escribió, o el propietario del documento (moderación); borrar
//                                  un hilo borra sus respuestas
// Cada cambio avisa por el WebSocket a quienes tienen el documento abierto (para volver a pedir la lista).
import * as decoding from 'lib0/decoding';
import * as Y from 'yjs';
import { alcanza, exigirDocumento } from '../contenido/acceso.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';

type Deps = Pick<DependenciasApi, 'prisma' | 'contenido'>;

/** Tamaño máximo del ancla (el CHECK comentarios_ancla_tamano). */
export const ANCLA_MAXIMA_BYTES = 1024;

export interface Comentario {
  id: string;
  padreId: string | null;
  autor: { id: string; nombre: string };
  /** base64url de las dos posiciones relativas (inicio, fin); null en las respuestas. */
  ancla: string | null;
  cuerpo: string;
  resuelto: boolean;
  creadoEn: string;
  editadoEn: string | null;
}

interface FilaComentario {
  id: string;
  padre_id: string | null;
  autor_id: string;
  autor_nombre: string | null;
  ancla: Uint8Array | null;
  cuerpo: string;
  resuelto_en: Date | null;
  creado_en: Date;
  editado_en: Date | null;
}

const aComentario = (f: FilaComentario): Comentario => ({
  id: f.id,
  padreId: f.padre_id,
  autor: { id: f.autor_id, nombre: f.autor_nombre ?? '' },
  ancla: f.ancla ? Buffer.from(f.ancla).toString('base64url') : null,
  cuerpo: f.cuerpo,
  resuelto: f.resuelto_en !== null,
  creadoEn: f.creado_en.toISOString(),
  editadoEn: f.editado_en?.toISOString() ?? null,
});

const comentarioNoEncontrado = () => new ErrorHttp(404, 'comentario_no_encontrado', 'El comentario no existe');
const sinPermiso = (mensaje: string) => new ErrorHttp(403, 'sin_permiso', mensaje);

/**
 * El ancla decodificada y comprobada: exactamente dos posiciones relativas de Yjs y nada más. Una que no
 * tiene esa forma se rechaza (400) antes de guardarla.
 */
export function validarAncla(base64url: string): Uint8Array {
  const bytes = Buffer.from(base64url, 'base64url');
  const invalida = () => new ErrorHttp(400, 'ancla_invalida', 'El ancla no es válida');
  if (bytes.length === 0 || bytes.length > ANCLA_MAXIMA_BYTES || bytes.toString('base64url') !== base64url) throw invalida();
  try {
    const dec = decoding.createDecoder(new Uint8Array(bytes));
    for (let i = 0; i < 2; i++) Y.decodeRelativePosition(decoding.readVarUint8Array(dec));
    if (decoding.hasContent(dec)) throw invalida();
  } catch {
    throw invalida();
  }
  return new Uint8Array(bytes);
}

async function comentariosDe(d: Deps, documentoId: string, id: string | null): Promise<Comentario[]> {
  const filas = await d.prisma.$queryRaw<FilaComentario[]>`
    SELECT c.id, c.padre_id, c.autor_id, u.nombre AS autor_nombre, c.ancla, c.cuerpo, c.resuelto_en, c.creado_en, c.editado_en
    FROM comentarios c JOIN usuarios u ON u.id = c.autor_id
    WHERE c.documento_id = ${documentoId}::uuid AND (${id}::uuid IS NULL OR c.id = ${id}::uuid)
    ORDER BY c.creado_en, c.id
    LIMIT 2000`;
  return filas.map(aComentario);
}

export async function listarComentarios(d: Deps, usuarioId: string, documentoId: string): Promise<Comentario[]> {
  await exigirDocumento(d.prisma, usuarioId, documentoId, 'lector', '');
  return comentariosDe(d, documentoId, null);
}

/** Un hilo nuevo (con ancla) o una respuesta (con padreId, sin ancla). Cualquier rol. */
export async function crearComentario(
  d: Deps,
  usuarioId: string,
  documentoId: string,
  c: { cuerpo: string; ancla?: string | undefined; padreId?: string | undefined },
): Promise<Comentario> {
  await exigirDocumento(d.prisma, usuarioId, documentoId, 'lector', '');
  if (c.padreId && c.ancla) throw new ErrorHttp(400, 'ancla_en_respuesta', 'Una respuesta no lleva ancla: usa la del hilo');
  if (!c.padreId && !c.ancla) throw new ErrorHttp(400, 'falta_ancla', 'Un hilo nuevo se ancla a un tramo del texto');
  const ancla = c.ancla ? validarAncla(c.ancla) : null;
  if (c.padreId) {
    const padre = await d.prisma.$queryRaw<{ padre_id: string | null }[]>`
      SELECT padre_id FROM comentarios WHERE id = ${c.padreId}::uuid AND documento_id = ${documentoId}::uuid`;
    if (!padre[0]) throw comentarioNoEncontrado();
    if (padre[0].padre_id !== null) throw new ErrorHttp(400, 'respuesta_a_respuesta', 'Se responde al hilo, no a otra respuesta');
  }
  const filas = await d.prisma.$queryRaw<{ id: string }[]>`
    INSERT INTO comentarios (documento_id, autor_id, padre_id, ancla, cuerpo)
    VALUES (${documentoId}::uuid, ${usuarioId}::uuid, ${c.padreId ?? null}::uuid, ${ancla ? Buffer.from(ancla) : null}, ${c.cuerpo})
    RETURNING id`;
  const [nuevo] = await comentariosDe(d, documentoId, filas[0]?.id ?? null);
  if (!nuevo) throw new Error('comentario recién insertado no encontrado');
  d.contenido?.avisarComentarios(documentoId);
  return nuevo;
}

/** El comentario (de un documento al que la cuenta tiene acceso) y el rol de la cuenta sobre ese documento. */
async function comentarioConRol(d: Deps, usuarioId: string, id: string) {
  const filas = await d.prisma.$queryRaw<{ documento_id: string; autor_id: string; padre_id: string | null }[]>`
    SELECT documento_id, autor_id, padre_id FROM comentarios WHERE id = ${id}::uuid`;
  const f = filas[0];
  if (!f) throw comentarioNoEncontrado();
  // Sin acceso al documento: el mismo 404 (no se revela que el comentario existe).
  const acceso = await exigirDocumento(d.prisma, usuarioId, f.documento_id, 'lector', '').catch(() => {
    throw comentarioNoEncontrado();
  });
  return { ...f, rol: acceso.rol };
}

/** Editar el texto (solo quien lo escribió) o resolver/reabrir un hilo (quien lo abrió, o editor o propietario). */
export async function cambiarComentario(d: Deps, usuarioId: string, id: string, c: { cuerpo?: string | undefined; resuelto?: boolean | undefined }): Promise<Comentario> {
  const f = await comentarioConRol(d, usuarioId, id);
  if (c.cuerpo !== undefined) {
    if (f.autor_id !== usuarioId) throw sinPermiso('Solo quien escribió el comentario lo edita');
    await d.prisma.$executeRaw`UPDATE comentarios SET cuerpo = ${c.cuerpo}, editado_en = now() WHERE id = ${id}::uuid`;
  }
  if (c.resuelto !== undefined) {
    if (f.padre_id !== null) throw new ErrorHttp(400, 'resolver_respuesta', 'Se resuelve el hilo, no una respuesta');
    if (f.autor_id !== usuarioId && !alcanza(f.rol, 'editor')) throw sinPermiso('Resuelve el hilo quien lo abrió, o un editor o propietario');
    await d.prisma.$executeRaw`
      UPDATE comentarios SET resuelto_en = CASE WHEN ${c.resuelto} THEN coalesce(resuelto_en, now()) ELSE NULL END WHERE id = ${id}::uuid`;
  }
  const [r] = await comentariosDe(d, f.documento_id, id);
  if (!r) throw comentarioNoEncontrado();
  d.contenido?.avisarComentarios(f.documento_id);
  return r;
}

/** Borrar (quien lo escribió, o el propietario del documento). Un hilo se lleva sus respuestas. */
export async function borrarComentario(d: Deps, usuarioId: string, id: string): Promise<void> {
  const f = await comentarioConRol(d, usuarioId, id);
  if (f.autor_id !== usuarioId && f.rol !== 'propietario') throw sinPermiso('Borra el comentario quien lo escribió, o el propietario del documento');
  await d.prisma.$executeRaw`DELETE FROM comentarios WHERE id = ${id}::uuid`;
  d.contenido?.avisarComentarios(f.documento_id);
}
