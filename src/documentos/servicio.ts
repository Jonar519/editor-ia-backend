// Documentos y sus permisos propios (bloque K1). El CONTENIDO no pasa por aquí: se edita por el WebSocket
// (bloque K2). Aquí van los metadatos (título), crear y borrar, y quién tiene qué permiso.
//
// El rol de una cuenta sobre un documento lo calcula la base (rol_efectivo_documento): el mayor entre su
// rol en el documento y su rol en el espacio (ser propietario del espacio da "editor", no la propiedad),
// con el techo de la cuenta lectora. Por eso un permiso propio solo sirve para SUBIR a "editor" a un
// lector del espacio, y la propiedad no se da: se transfiere.
//
// Cada cambio bloquea la fila del documento (FOR UPDATE) antes de comprobar el rol.
// Dar o quitar permisos, transferir y borrar quedan en eventos_seguridad en la misma transacción (a quién y
// sobre qué documento: solo ids).
import { registrarEvento } from '../auth/eventos.js';
import type { UsuarioSesion } from '../auth/sesiones.js';
import {
  type Bd,
  documentoNoEncontrado,
  espacioNoEncontrado,
  exigirCrearDocumento,
  exigirDocumento,
  exigirEspacio,
  type RolContenido,
} from '../contenido/acceso.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';

type Deps = Pick<DependenciasApi, 'prisma'>;

export interface Documento {
  id: string;
  espacioId: string;
  titulo: string;
  rol: RolContenido;
  propietario: { id: string; nombre: string };
  creadoEn: string;
  actualizadoEn: string;
}

export interface Permiso {
  usuarioId: string;
  nombre: string;
  rol: RolContenido;
}

interface FilaDocumento {
  id: string;
  espacio_id: string;
  titulo: string;
  rol: RolContenido | null;
  propietario_id: string;
  propietario_nombre: string | null;
  creado_en: Date;
  actualizado_en: Date;
}

const aDocumento = (f: FilaDocumento): Documento => ({
  id: f.id,
  espacioId: f.espacio_id,
  titulo: f.titulo,
  rol: f.rol ?? 'lector',
  propietario: { id: f.propietario_id, nombre: f.propietario_nombre ?? '' },
  creadoEn: f.creado_en.toISOString(),
  actualizadoEn: f.actualizado_en.toISOString(),
});

/** Documentos de un espacio (o uno solo) con el rol efectivo de la cuenta y su propietario. */
async function documentosDe(bd: Bd, usuarioId: string, filtro: { espacioId: string } | { documentoId: string }): Promise<Documento[]> {
  const espacioId = 'espacioId' in filtro ? filtro.espacioId : null;
  const documentoId = 'documentoId' in filtro ? filtro.documentoId : null;
  const filas = await bd.$queryRaw<FilaDocumento[]>`
    SELECT d.id, d.espacio_id, d.titulo, rol_efectivo_documento(${usuarioId}::uuid, d.id) AS rol,
           p.usuario_id AS propietario_id, u.nombre AS propietario_nombre, d.creado_en, d.actualizado_en
    FROM documentos d
    JOIN permisos_documento p ON p.documento_id = d.id AND p.rol = 'propietario'
    JOIN usuarios u ON u.id = p.usuario_id
    WHERE (${espacioId}::uuid IS NULL OR d.espacio_id = ${espacioId}::uuid)
      AND (${documentoId}::uuid IS NULL OR d.id = ${documentoId}::uuid)
    ORDER BY d.actualizado_en DESC, d.id`;
  return filas.map(aDocumento);
}

export async function listarDocumentos(d: Deps, usuarioId: string, espacioId: string): Promise<Documento[]> {
  await exigirEspacio(d.prisma, usuarioId, espacioId, 'lector', '');
  return documentosDe(d.prisma, usuarioId, { espacioId });
}

async function documentoPara(bd: Bd, usuarioId: string, documentoId: string): Promise<Documento> {
  const [doc] = await documentosDe(bd, usuarioId, { documentoId });
  if (!doc) throw documentoNoEncontrado();
  return doc;
}

export async function obtenerDocumento(d: Deps, usuarioId: string, documentoId: string): Promise<Documento> {
  await exigirDocumento(d.prisma, usuarioId, documentoId, 'lector', '');
  return documentoPara(d.prisma, usuarioId, documentoId);
}

/** Crear: quien lo crea queda como propietario (la base lo exige en la misma transacción). */
export async function crearDocumento(d: Deps, u: UsuarioSesion, espacioId: string, titulo: string): Promise<Documento> {
  return d.prisma.$transaction(async (tx) => {
    // KEY SHARE: que el espacio no se borre mientras tanto, sin bloquear a otros que crean documentos.
    const e = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM espacios WHERE id = ${espacioId}::uuid FOR KEY SHARE`;
    if (e.length === 0) throw espacioNoEncontrado();
    await exigirCrearDocumento(tx, u, espacioId);
    const filas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO documentos (espacio_id, titulo, creado_por) VALUES (${espacioId}::uuid, ${titulo}, ${u.id}::uuid) RETURNING id`;
    const id = filas[0]?.id ?? '';
    await tx.$executeRaw`
      INSERT INTO permisos_documento (documento_id, espacio_id, usuario_id, rol) VALUES (${id}::uuid, ${espacioId}::uuid, ${u.id}::uuid, 'propietario')`;
    return documentoPara(tx, u.id, id);
  });
}

/** Bloquea el documento para el resto de la transacción (404 si no existe). */
async function bloquearDocumento(tx: Bd, documentoId: string): Promise<void> {
  const filas = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM documentos WHERE id = ${documentoId}::uuid FOR UPDATE`;
  if (filas.length === 0) throw documentoNoEncontrado();
}

export async function renombrarDocumento(d: Deps, usuarioId: string, documentoId: string, titulo: string): Promise<Documento> {
  return d.prisma.$transaction(async (tx) => {
    await bloquearDocumento(tx, documentoId);
    await exigirDocumento(tx, usuarioId, documentoId, 'editor', 'Un lector no cambia el título');
    await tx.$executeRaw`UPDATE documentos SET titulo = ${titulo} WHERE id = ${documentoId}::uuid`;
    return documentoPara(tx, usuarioId, documentoId);
  });
}

/** Borrar el documento con su historial (versiones, comentarios, log Yjs). Solo su propietario. */
export async function eliminarDocumento(d: Deps, usuarioId: string, documentoId: string, ipRed: string | null): Promise<void> {
  await d.prisma.$transaction(async (tx) => {
    await bloquearDocumento(tx, documentoId);
    await exigirDocumento(tx, usuarioId, documentoId, 'propietario', 'Solo el propietario borra el documento');
    await tx.$executeRaw`DELETE FROM documentos WHERE id = ${documentoId}::uuid`;
    await registrarEvento(tx, 'documento_eliminado', usuarioId, ipRed, { recursoId: documentoId });
  });
}

// ─── Permisos propios del documento ───────────────────────────────────────────────

async function permisosDe(bd: Bd, documentoId: string): Promise<Permiso[]> {
  const filas = await bd.$queryRaw<{ usuario_id: string; nombre: string | null; rol: RolContenido }[]>`
    SELECT pd.usuario_id, u.nombre, pd.rol FROM permisos_documento pd JOIN usuarios u ON u.id = pd.usuario_id
    WHERE pd.documento_id = ${documentoId}::uuid
    ORDER BY nivel_rol(pd.rol) DESC, lower(u.nombre), pd.usuario_id`;
  return filas.map((f) => ({ usuarioId: f.usuario_id, nombre: f.nombre ?? '', rol: f.rol }));
}

export async function listarPermisos(d: Deps, usuarioId: string, documentoId: string): Promise<Permiso[]> {
  await exigirDocumento(d.prisma, usuarioId, documentoId, 'lector', '');
  return permisosDe(d.prisma, documentoId);
}

/** El objetivo tiene que ser miembro del espacio del documento. Devuelve su rol de cuenta y su permiso actual. */
async function objetivoDelDocumento(tx: Bd, documentoId: string, objetivo: string): Promise<{ rolCuenta: string; permiso: RolContenido | null }> {
  const filas = await tx.$queryRaw<{ rol_cuenta: string; permiso: RolContenido | null }[]>`
    SELECT u.rol AS rol_cuenta, pd.rol AS permiso
    FROM documentos d
    JOIN miembros_espacio me ON me.espacio_id = d.espacio_id AND me.usuario_id = ${objetivo}::uuid
    JOIN usuarios u ON u.id = me.usuario_id
    LEFT JOIN permisos_documento pd ON pd.documento_id = d.id AND pd.usuario_id = me.usuario_id
    WHERE d.id = ${documentoId}::uuid`;
  const f = filas[0];
  if (!f) throw new ErrorHttp(404, 'miembro_no_encontrado', 'Solo se da permiso a miembros del espacio del documento');
  return { rolCuenta: f.rol_cuenta, permiso: f.permiso };
}

const usarTransferencia = () =>
  new ErrorHttp(409, 'usar_transferencia', 'La propiedad del documento no se da ni se quita: se transfiere');
const rolExcedeCuenta = () =>
  new ErrorHttp(409, 'rol_excede_cuenta', 'Esa cuenta es de solo lectura: en un espacio o documento solo puede ser lectora');

/** Dar "editor" sobre el documento a un miembro del espacio. Solo el propietario del documento. */
export async function darPermiso(d: Deps, usuarioId: string, documentoId: string, objetivo: string, ipRed: string | null): Promise<Permiso[]> {
  return d.prisma.$transaction(async (tx) => {
    await bloquearDocumento(tx, documentoId);
    const { espacioId } = await exigirDocumento(tx, usuarioId, documentoId, 'propietario', 'Solo el propietario del documento da permisos');
    const o = await objetivoDelDocumento(tx, documentoId, objetivo);
    if (o.permiso === 'propietario') throw usarTransferencia();
    if (o.rolCuenta === 'lector') throw rolExcedeCuenta();
    await tx.$executeRaw`
      INSERT INTO permisos_documento (documento_id, espacio_id, usuario_id, rol) VALUES (${documentoId}::uuid, ${espacioId}::uuid, ${objetivo}::uuid, 'editor')
      ON CONFLICT (documento_id, usuario_id) DO UPDATE SET rol = 'editor'`;
    await registrarEvento(tx, 'permiso_documento_dado', usuarioId, ipRed, { objetivoId: objetivo, recursoId: documentoId });
    return permisosDe(tx, documentoId);
  });
}

export async function quitarPermiso(d: Deps, usuarioId: string, documentoId: string, objetivo: string, ipRed: string | null): Promise<void> {
  await d.prisma.$transaction(async (tx) => {
    await bloquearDocumento(tx, documentoId);
    await exigirDocumento(tx, usuarioId, documentoId, 'propietario', 'Solo el propietario del documento quita permisos');
    const filas = await tx.$queryRaw<{ rol: RolContenido }[]>`
      SELECT rol FROM permisos_documento WHERE documento_id = ${documentoId}::uuid AND usuario_id = ${objetivo}::uuid`;
    const rol = filas[0]?.rol;
    if (!rol) throw new ErrorHttp(404, 'permiso_no_encontrado', 'Esa cuenta no tiene un permiso propio en el documento');
    if (rol === 'propietario') throw usarTransferencia();
    await tx.$executeRaw`DELETE FROM permisos_documento WHERE documento_id = ${documentoId}::uuid AND usuario_id = ${objetivo}::uuid`;
    await registrarEvento(tx, 'permiso_documento_quitado', usuarioId, ipRed, { objetivoId: objetivo, recursoId: documentoId });
  });
}

/** Transferir el documento a otro miembro del espacio: el anterior queda con permiso "editor". */
export async function transferirDocumento(d: Deps, usuarioId: string, documentoId: string, objetivo: string, ipRed: string | null): Promise<Permiso[]> {
  return d.prisma.$transaction(async (tx) => {
    await bloquearDocumento(tx, documentoId);
    const { espacioId } = await exigirDocumento(tx, usuarioId, documentoId, 'propietario', 'Solo el propietario transfiere el documento');
    if (objetivo === usuarioId) throw new ErrorHttp(409, 'ya_es_propietario', 'Ya eres el propietario del documento');
    const o = await objetivoDelDocumento(tx, documentoId, objetivo);
    if (o.rolCuenta === 'lector') throw rolExcedeCuenta();
    // Primero se baja al actual (índice único de un propietario por documento) y luego se sube al nuevo.
    await tx.$executeRaw`UPDATE permisos_documento SET rol = 'editor' WHERE documento_id = ${documentoId}::uuid AND usuario_id = ${usuarioId}::uuid`;
    await tx.$executeRaw`
      INSERT INTO permisos_documento (documento_id, espacio_id, usuario_id, rol) VALUES (${documentoId}::uuid, ${espacioId}::uuid, ${objetivo}::uuid, 'propietario')
      ON CONFLICT (documento_id, usuario_id) DO UPDATE SET rol = 'propietario'`;
    await registrarEvento(tx, 'documento_transferido', usuarioId, ipRed, { objetivoId: objetivo, recursoId: documentoId });
    return permisosDe(tx, documentoId);
  });
}
