// Versiones de un documento (bloque N). La tabla es de SOLO INSERCIÓN con cadena de hash (migración 0010):
// el historial nunca se reescribe. Tres motivos:
//   - manual: una persona (editor o propietario) guarda el estado actual;
//   - automatica: el sistema, tras 5 minutos sin cambios, si el texto cambió desde la última (ver
//     compactacion.ts);
//   - restauracion: una persona lleva el documento al texto de una versión anterior. Es un CAMBIO NUEVO en
//     el documento vivo (lo reciben quienes lo tienen abierto) y una versión nueva que apunta a la
//     restaurada; las versiones intermedias siguen ahí.
//
// Ver el historial y el texto de una versión: cualquier rol. Guardar y restaurar: editor o propietario
// (además, la base lo exige al insertar: versiones_encadenar → exigir_escritura).
import type { UsuarioSesion } from '../auth/sesiones.js';
import { exigirDocumento } from '../contenido/acceso.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import { llevarA } from './lineas.js';

type Deps = Pick<DependenciasApi, 'prisma' | 'contenido'>;

export interface Version {
  numero: number;
  motivo: 'manual' | 'automatica' | 'restauracion';
  autor: { id: string; nombre: string } | null;
  restauradaDe: number | null;
  creadaEn: string;
  caracteres: number;
}

interface FilaVersion {
  numero: bigint;
  motivo: Version['motivo'];
  creado_por: string | null;
  autor_nombre: string | null;
  restaurada_numero: bigint | null;
  creado_en: Date;
  caracteres: number;
}

const aVersion = (f: FilaVersion): Version => ({
  numero: Number(f.numero),
  motivo: f.motivo,
  autor: f.creado_por ? { id: f.creado_por, nombre: f.autor_nombre ?? '' } : null,
  restauradaDe: f.restaurada_numero === null ? null : Number(f.restaurada_numero),
  creadaEn: f.creado_en.toISOString(),
  caracteres: f.caracteres,
});

const versionNoEncontrada = () => new ErrorHttp(404, 'version_no_encontrada', 'La versión no existe');
const sinTiempoReal = () => new ErrorHttp(503, 'tiempo_real_no_disponible', 'El servidor de tiempo real no está disponible');

/** Las versiones (las más nuevas primero, hasta 200), con autor y a qué versión restauran. */
async function versionesDe(d: Deps, documentoId: string, numero: number | null): Promise<Version[]> {
  const filas = await d.prisma.$queryRaw<FilaVersion[]>`
    SELECT v.numero, v.motivo, v.creado_por, u.nombre AS autor_nombre, r.numero AS restaurada_numero, v.creado_en,
           char_length(v.contenido_texto) AS caracteres
    FROM versiones v
    LEFT JOIN usuarios u ON u.id = v.creado_por
    LEFT JOIN versiones r ON r.id = v.restaurada_de
    WHERE v.documento_id = ${documentoId}::uuid AND (${numero}::bigint IS NULL OR v.numero = ${numero}::bigint)
    ORDER BY v.numero DESC
    LIMIT 200`;
  return filas.map(aVersion);
}

export async function listarVersiones(d: Deps, usuarioId: string, documentoId: string): Promise<Version[]> {
  await exigirDocumento(d.prisma, usuarioId, documentoId, 'lector', '');
  return versionesDe(d, documentoId, null);
}

/** Una versión con su texto (para compararla en el navegador). */
export async function obtenerVersion(d: Deps, usuarioId: string, documentoId: string, numero: number): Promise<Version & { texto: string }> {
  await exigirDocumento(d.prisma, usuarioId, documentoId, 'lector', '');
  const filas = await d.prisma.$queryRaw<{ contenido_texto: string }[]>`
    SELECT contenido_texto FROM versiones WHERE documento_id = ${documentoId}::uuid AND numero = ${numero}::bigint`;
  const [v] = await versionesDe(d, documentoId, numero);
  const texto = filas[0]?.contenido_texto;
  if (!v || texto === undefined) throw versionNoEncontrada();
  return { ...v, texto };
}

/** El texto actual del documento (el de la memoria del servidor, que incluye lo aún no guardado). */
export async function textoActual(d: Deps, usuarioId: string, documentoId: string): Promise<string> {
  await exigirDocumento(d.prisma, usuarioId, documentoId, 'lector', '');
  if (!d.contenido) throw sinTiempoReal();
  return (await d.contenido.estadoActual(documentoId)).texto;
}

async function insertarVersion(
  d: Deps,
  documentoId: string,
  autorId: string,
  estado: Uint8Array,
  texto: string,
  restauradaDe: string | null,
): Promise<Version> {
  // Número, hashes y fecha los pone la base (versiones_encadenar): el API no los elige.
  const filas = await d.prisma.$queryRaw<{ numero: bigint }[]>`
    INSERT INTO versiones (documento_id, motivo, creado_por, restaurada_de, estado_yjs, contenido_texto)
    VALUES (${documentoId}::uuid, ${restauradaDe ? 'restauracion' : 'manual'}, ${autorId}::uuid, ${restauradaDe}::uuid,
            ${Buffer.from(estado)}, ${texto})
    RETURNING numero`;
  const [v] = await versionesDe(d, documentoId, Number(filas[0]?.numero ?? 0));
  if (!v) throw new Error('versión recién insertada no encontrada');
  return v;
}

/** Guarda el estado actual como versión manual (editor o propietario). */
export async function crearVersion(d: Deps, u: UsuarioSesion, documentoId: string): Promise<Version> {
  await exigirDocumento(d.prisma, u.id, documentoId, 'editor', 'Solo un editor o propietario guarda versiones');
  if (!d.contenido) throw sinTiempoReal();
  const { estado, texto } = await d.contenido.estadoActual(documentoId);
  return insertarVersion(d, documentoId, u.id, estado, texto, null);
}

/**
 * Restaura una versión como CAMBIO NUEVO: el documento vivo pasa al texto de esa versión (solo lo que
 * difiere, como un cambio de esta persona) y queda una versión "restauracion" que apunta a la restaurada.
 */
export async function restaurarVersion(d: Deps, u: UsuarioSesion, documentoId: string, numero: number): Promise<Version> {
  await exigirDocumento(d.prisma, u.id, documentoId, 'editor', 'Solo un editor o propietario restaura versiones');
  if (!d.contenido) throw sinTiempoReal();
  const filas = await d.prisma.$queryRaw<{ id: string; contenido_texto: string }[]>`
    SELECT id, contenido_texto FROM versiones WHERE documento_id = ${documentoId}::uuid AND numero = ${numero}::bigint`;
  const v = filas[0];
  if (!v) throw versionNoEncontrada();
  const { estado, texto } = await d.contenido.cambiar(documentoId, u.id, (t) => {
    llevarA(t, v.contenido_texto);
  });
  return insertarVersion(d, documentoId, u.id, estado, texto, v.id);
}
