// Quién puede qué sobre espacios y documentos (bloque K1). La fuente de verdad del rol sobre un documento
// es la BASE (rol_efectivo_documento): aquí no se recalcula, se consulta. Lo que sí decide el API es qué
// acción exige qué rol, en un solo lugar:
//
//   espacio  ver (y sus miembros y documentos) .... cualquier miembro
//            crear documentos ..................... propietario o editor del espacio (y cuenta no lectora)
//            renombrar, borrar, miembros, transferir  propietario del espacio
//   documento ver (y sus permisos) ................ rol efectivo cualquiera
//            renombrar ........................... editor o propietario efectivo
//            borrar, permisos, transferir ........ propietario del documento
//
// Sin acceso, la respuesta es 404 (no se revela si el espacio o el documento existe). Con acceso pero sin
// el rol suficiente, 403.
import type { UsuarioSesion } from '../auth/sesiones.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ErrorHttp } from '../http/errores.js';

export type RolContenido = 'propietario' | 'editor' | 'lector';

/** Lo que necesitan las consultas: el cliente de Prisma o una transacción. */
export type Bd = Pick<PrismaClient, '$queryRaw' | '$executeRaw'>;

const NIVEL: Record<RolContenido, number> = { lector: 1, editor: 2, propietario: 3 };

/** ¿El rol alcanza el mínimo? (lector < editor < propietario) */
export const alcanza = (rol: RolContenido, minimo: RolContenido): boolean => NIVEL[rol] >= NIVEL[minimo];

export const espacioNoEncontrado = () => new ErrorHttp(404, 'espacio_no_encontrado', 'El espacio no existe o no tienes acceso');
export const documentoNoEncontrado = () => new ErrorHttp(404, 'documento_no_encontrado', 'El documento no existe o no tienes acceso');
const sinPermiso = (mensaje: string) => new ErrorHttp(403, 'sin_permiso', mensaje);

/** Rol de la cuenta en el espacio, o null si no es miembro. */
export async function rolEnEspacio(bd: Bd, usuarioId: string, espacioId: string): Promise<RolContenido | null> {
  const filas = await bd.$queryRaw<{ rol: RolContenido }[]>`
    SELECT rol FROM miembros_espacio WHERE espacio_id = ${espacioId}::uuid AND usuario_id = ${usuarioId}::uuid`;
  return filas[0]?.rol ?? null;
}

/** Exige ser miembro del espacio con al menos `minimo`. Devuelve el rol. */
export async function exigirEspacio(bd: Bd, usuarioId: string, espacioId: string, minimo: RolContenido, mensaje: string): Promise<RolContenido> {
  const rol = await rolEnEspacio(bd, usuarioId, espacioId);
  if (!rol) throw espacioNoEncontrado();
  if (!alcanza(rol, minimo)) throw sinPermiso(mensaje);
  return rol;
}

/** Crear documentos: propietario o editor del espacio, y una cuenta que no sea de solo lectura. */
export async function exigirCrearDocumento(bd: Bd, u: UsuarioSesion, espacioId: string): Promise<void> {
  const rol = await exigirEspacio(bd, u.id, espacioId, 'lector', '');
  if (u.rol === 'lector' || !alcanza(rol, 'editor')) throw sinPermiso('Solo un editor o propietario del espacio crea documentos');
}

/** Rol efectivo sobre el documento (de la base) y su espacio, o null si no hay acceso. */
export async function rolEnDocumento(bd: Bd, usuarioId: string, documentoId: string): Promise<{ rol: RolContenido; espacioId: string } | null> {
  const filas = await bd.$queryRaw<{ rol: RolContenido | null; espacio_id: string }[]>`
    SELECT rol_efectivo_documento(${usuarioId}::uuid, d.id) AS rol, d.espacio_id
    FROM documentos d WHERE d.id = ${documentoId}::uuid`;
  const f = filas[0];
  return f?.rol ? { rol: f.rol, espacioId: f.espacio_id } : null;
}

/** Exige un rol efectivo de al menos `minimo` sobre el documento. */
export async function exigirDocumento(
  bd: Bd,
  usuarioId: string,
  documentoId: string,
  minimo: RolContenido,
  mensaje: string,
): Promise<{ rol: RolContenido; espacioId: string }> {
  const r = await rolEnDocumento(bd, usuarioId, documentoId);
  if (!r) throw documentoNoEncontrado();
  if (!alcanza(r.rol, minimo)) throw sinPermiso(mensaje);
  return r;
}
