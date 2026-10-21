// Espacios y sus miembros (bloque K1). Las reglas estructurales las garantiza la base (un propietario por
// espacio, solo cuentas activas, techo de rol de la cuenta lectora); este servicio decide QUIÉN puede hacer
// cada cambio (src/contenido/acceso.ts) y da errores claros antes de que la base los rechace.
//
// Cada cambio corre en una transacción que primero bloquea la fila del espacio (FOR UPDATE) y recién
// entonces comprueba el rol: dos cambios simultáneos sobre el mismo espacio se esperan en vez de decidir
// con datos viejos.
import type { UsuarioSesion } from '../auth/sesiones.js';
import { type Bd, espacioNoEncontrado, exigirEspacio, type RolContenido } from '../contenido/acceso.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';

type Deps = Pick<DependenciasApi, 'prisma'>;

export interface Espacio {
  id: string;
  nombre: string;
  rol: RolContenido;
  creadoEn: string;
  miembros: number;
}

export interface Miembro {
  usuarioId: string;
  nombre: string;
  correo: string;
  rol: RolContenido;
  desde: string;
}

const rolExcedeCuenta = () =>
  new ErrorHttp(409, 'rol_excede_cuenta', 'Esa cuenta es de solo lectura: en un espacio o documento solo puede ser lectora');

/** Bloquea el espacio para el resto de la transacción (o 404 si no existe). */
async function bloquearEspacio(tx: Bd, espacioId: string): Promise<void> {
  const filas = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM espacios WHERE id = ${espacioId}::uuid FOR UPDATE`;
  if (filas.length === 0) throw espacioNoEncontrado();
}

async function espacioDe(bd: Bd, usuarioId: string, espacioId: string): Promise<Espacio> {
  const filas = await bd.$queryRaw<{ id: string; nombre: string; rol: RolContenido; creado_en: Date; miembros: number }[]>`
    SELECT e.id, e.nombre, me.rol, e.creado_en,
           (SELECT count(*)::int FROM miembros_espacio m WHERE m.espacio_id = e.id) AS miembros
    FROM espacios e JOIN miembros_espacio me ON me.espacio_id = e.id AND me.usuario_id = ${usuarioId}::uuid
    WHERE e.id = ${espacioId}::uuid`;
  const f = filas[0];
  if (!f) throw espacioNoEncontrado();
  return { id: f.id, nombre: f.nombre, rol: f.rol, creadoEn: f.creado_en.toISOString(), miembros: f.miembros };
}

export async function listarEspacios(d: Deps, usuarioId: string): Promise<Espacio[]> {
  const filas = await d.prisma.$queryRaw<{ id: string; nombre: string; rol: RolContenido; creado_en: Date; miembros: number }[]>`
    SELECT e.id, e.nombre, me.rol, e.creado_en,
           (SELECT count(*)::int FROM miembros_espacio m WHERE m.espacio_id = e.id) AS miembros
    FROM miembros_espacio me JOIN espacios e ON e.id = me.espacio_id
    WHERE me.usuario_id = ${usuarioId}::uuid
    ORDER BY lower(e.nombre), e.id`;
  return filas.map((f) => ({ id: f.id, nombre: f.nombre, rol: f.rol, creadoEn: f.creado_en.toISOString(), miembros: f.miembros }));
}

export const obtenerEspacio = (d: Deps, usuarioId: string, espacioId: string) => espacioDe(d.prisma, usuarioId, espacioId);

/** Crear un espacio: quien lo crea queda como propietario (la base lo exige en la misma transacción). */
export async function crearEspacio(d: Deps, u: UsuarioSesion, nombre: string): Promise<Espacio> {
  if (u.rol === 'lector') throw new ErrorHttp(403, 'sin_permiso', 'Una cuenta de solo lectura no crea espacios');
  return d.prisma.$transaction(async (tx) => {
    const filas = await tx.$queryRaw<{ id: string }[]>`
      INSERT INTO espacios (nombre, creado_por) VALUES (${nombre}, ${u.id}::uuid) RETURNING id`;
    const id = filas[0]?.id ?? '';
    await tx.$executeRaw`INSERT INTO miembros_espacio (espacio_id, usuario_id, rol) VALUES (${id}::uuid, ${u.id}::uuid, 'propietario')`;
    return espacioDe(tx, u.id, id);
  });
}

export async function renombrarEspacio(d: Deps, usuarioId: string, espacioId: string, nombre: string): Promise<Espacio> {
  return d.prisma.$transaction(async (tx) => {
    await bloquearEspacio(tx, espacioId);
    await exigirEspacio(tx, usuarioId, espacioId, 'propietario', 'Solo el propietario renombra el espacio');
    await tx.$executeRaw`UPDATE espacios SET nombre = ${nombre} WHERE id = ${espacioId}::uuid`;
    return espacioDe(tx, usuarioId, espacioId);
  });
}

/**
 * Borrar el espacio con todo su contenido. Solo si el propietario es el ÚNICO miembro: con otros miembros,
 * borrarlo se llevaría documentos ajenos (409; primero hay que sacarlos o transferir el espacio).
 */
export async function eliminarEspacio(d: Deps, usuarioId: string, espacioId: string): Promise<{ documentosBorrados: number }> {
  return d.prisma.$transaction(async (tx) => {
    await bloquearEspacio(tx, espacioId);
    await exigirEspacio(tx, usuarioId, espacioId, 'propietario', 'Solo el propietario borra el espacio');
    const otros = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM miembros_espacio WHERE espacio_id = ${espacioId}::uuid AND usuario_id <> ${usuarioId}::uuid`;
    if ((otros[0]?.n ?? 0) > 0) {
      throw new ErrorHttp(409, 'espacio_compartido', 'El espacio tiene otros miembros: sácalos o transfiere el espacio antes de borrarlo');
    }
    const docs = await tx.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM documentos WHERE espacio_id = ${espacioId}::uuid`;
    await tx.$executeRaw`DELETE FROM espacios WHERE id = ${espacioId}::uuid`;
    return { documentosBorrados: docs[0]?.n ?? 0 };
  });
}

// ─── Miembros ─────────────────────────────────────────────────────────────────────

async function miembrosDe(bd: Bd, espacioId: string, soloUsuario?: string): Promise<Miembro[]> {
  const filas = await bd.$queryRaw<{ usuario_id: string; nombre: string | null; correo: string | null; rol: RolContenido; creado_en: Date }[]>`
    SELECT me.usuario_id, u.nombre, u.correo::text AS correo, me.rol, me.creado_en
    FROM miembros_espacio me JOIN usuarios u ON u.id = me.usuario_id
    WHERE me.espacio_id = ${espacioId}::uuid AND (${soloUsuario ?? null}::uuid IS NULL OR me.usuario_id = ${soloUsuario ?? null}::uuid)
    ORDER BY nivel_rol(me.rol) DESC, lower(u.nombre), me.usuario_id`;
  return filas.map((f) => ({ usuarioId: f.usuario_id, nombre: f.nombre ?? '', correo: f.correo ?? '', rol: f.rol, desde: f.creado_en.toISOString() }));
}

export async function listarMiembros(d: Deps, usuarioId: string, espacioId: string): Promise<Miembro[]> {
  await exigirEspacio(d.prisma, usuarioId, espacioId, 'lector', '');
  return miembrosDe(d.prisma, espacioId);
}

/**
 * Agregar una cuenta ACTIVA por su correo. Si no hay una cuenta activa con ese correo, 404 genérico (sin
 * distinguir "no existe" de "pendiente" o "eliminada"); el límite de tasa de la ruta acota la enumeración.
 */
export async function agregarMiembro(
  d: Deps,
  usuarioId: string,
  espacioId: string,
  e: { correo: string; rol: 'editor' | 'lector' },
): Promise<Miembro> {
  return d.prisma.$transaction(async (tx) => {
    await bloquearEspacio(tx, espacioId);
    await exigirEspacio(tx, usuarioId, espacioId, 'propietario', 'Solo el propietario agrega miembros');
    const cuenta = await tx.$queryRaw<{ id: string; rol: string }[]>`
      SELECT id, rol FROM usuarios WHERE correo = ${e.correo} AND estado = 'activa'`;
    const c = cuenta[0];
    if (!c) throw new ErrorHttp(404, 'cuenta_no_encontrada', 'No hay una cuenta activa con ese correo');
    const ya = await tx.$queryRaw<{ n: number }[]>`
      SELECT count(*)::int AS n FROM miembros_espacio WHERE espacio_id = ${espacioId}::uuid AND usuario_id = ${c.id}::uuid`;
    if ((ya[0]?.n ?? 0) > 0) throw new ErrorHttp(409, 'ya_es_miembro', 'Esa cuenta ya es miembro del espacio');
    if (c.rol === 'lector' && e.rol !== 'lector') throw rolExcedeCuenta();
    await tx.$executeRaw`INSERT INTO miembros_espacio (espacio_id, usuario_id, rol) VALUES (${espacioId}::uuid, ${c.id}::uuid, ${e.rol})`;
    const [m] = await miembrosDe(tx, espacioId, c.id);
    if (!m) throw new Error('miembro recién agregado no encontrado');
    return m;
  });
}

/** Rol del objetivo dentro de la transacción, con las reglas comunes de cambiar y quitar. */
async function miembroObjetivo(tx: Bd, espacioId: string, objetivo: string): Promise<{ rol: RolContenido; rolCuenta: string }> {
  const filas = await tx.$queryRaw<{ rol: RolContenido; rol_cuenta: string }[]>`
    SELECT me.rol, u.rol AS rol_cuenta FROM miembros_espacio me JOIN usuarios u ON u.id = me.usuario_id
    WHERE me.espacio_id = ${espacioId}::uuid AND me.usuario_id = ${objetivo}::uuid`;
  const f = filas[0];
  if (!f) throw new ErrorHttp(404, 'miembro_no_encontrado', 'Esa cuenta no es miembro del espacio');
  return { rol: f.rol, rolCuenta: f.rol_cuenta };
}

const usarTransferencia = () =>
  new ErrorHttp(409, 'usar_transferencia', 'La propiedad no se cambia ni se quita: se transfiere a otro miembro');

export async function cambiarRolMiembro(
  d: Deps,
  usuarioId: string,
  espacioId: string,
  objetivo: string,
  rol: 'editor' | 'lector',
): Promise<Miembro> {
  return d.prisma.$transaction(async (tx) => {
    await bloquearEspacio(tx, espacioId);
    await exigirEspacio(tx, usuarioId, espacioId, 'propietario', 'Solo el propietario cambia roles');
    const o = await miembroObjetivo(tx, espacioId, objetivo);
    if (o.rol === 'propietario') throw usarTransferencia();
    if (o.rolCuenta === 'lector' && rol !== 'lector') throw rolExcedeCuenta();
    await tx.$executeRaw`UPDATE miembros_espacio SET rol = ${rol} WHERE espacio_id = ${espacioId}::uuid AND usuario_id = ${objetivo}::uuid`;
    const [m] = await miembrosDe(tx, espacioId, objetivo);
    if (!m) throw new Error('miembro no encontrado después de cambiar su rol');
    return m;
  });
}

/** Documentos del espacio que el miembro posee: impiden quitarlo (la base no deja documentos sin propietario). */
async function documentosPropios(tx: Bd, espacioId: string, usuarioId: string): Promise<{ tipo: 'documento'; id: string; nombre: string }[]> {
  const filas = await tx.$queryRaw<{ id: string; titulo: string }[]>`
    SELECT d.id, d.titulo FROM permisos_documento pd JOIN documentos d ON d.id = pd.documento_id
    WHERE pd.espacio_id = ${espacioId}::uuid AND pd.usuario_id = ${usuarioId}::uuid AND pd.rol = 'propietario'
    ORDER BY lower(d.titulo), d.id`;
  return filas.map((f) => ({ tipo: 'documento' as const, id: f.id, nombre: f.titulo }));
}

/**
 * Quitar a un miembro (el propietario a otro) o salir (cualquier miembro, salvo el propietario). Sus
 * permisos de documento se van en cascada; si posee documentos del espacio, 409 con la lista.
 */
export async function quitarMiembro(d: Deps, usuarioId: string, espacioId: string, objetivo: string): Promise<void> {
  await d.prisma.$transaction(async (tx) => {
    await bloquearEspacio(tx, espacioId);
    if (objetivo === usuarioId) {
      await exigirEspacio(tx, usuarioId, espacioId, 'lector', '');
    } else {
      await exigirEspacio(tx, usuarioId, espacioId, 'propietario', 'Solo el propietario quita miembros');
    }
    const o = await miembroObjetivo(tx, espacioId, objetivo);
    if (o.rol === 'propietario') {
      throw new ErrorHttp(409, 'propietario_no_sale', 'El propietario no sale del espacio: primero transfiere el espacio');
    }
    const propios = await documentosPropios(tx, espacioId, objetivo);
    if (propios.length > 0) {
      throw new ErrorHttp(409, 'propiedad_documentos', 'Es propietaria o propietario de documentos del espacio: transfiérelos antes', propios);
    }
    await tx.$executeRaw`DELETE FROM miembros_espacio WHERE espacio_id = ${espacioId}::uuid AND usuario_id = ${objetivo}::uuid`;
  });
}

/** Transferir el espacio a otro miembro: el anterior queda como editor. */
export async function transferirEspacio(d: Deps, usuarioId: string, espacioId: string, objetivo: string): Promise<Miembro[]> {
  return d.prisma.$transaction(async (tx) => {
    await bloquearEspacio(tx, espacioId);
    await exigirEspacio(tx, usuarioId, espacioId, 'propietario', 'Solo el propietario transfiere el espacio');
    if (objetivo === usuarioId) throw new ErrorHttp(409, 'ya_es_propietario', 'Ya eres el propietario del espacio');
    const o = await miembroObjetivo(tx, espacioId, objetivo);
    if (o.rolCuenta === 'lector') throw rolExcedeCuenta();
    // Primero se baja al actual (índice único de un propietario por espacio) y luego se sube al nuevo; la
    // base revisa al COMMIT que haya exactamente uno.
    await tx.$executeRaw`UPDATE miembros_espacio SET rol = 'editor' WHERE espacio_id = ${espacioId}::uuid AND usuario_id = ${usuarioId}::uuid`;
    await tx.$executeRaw`UPDATE miembros_espacio SET rol = 'propietario' WHERE espacio_id = ${espacioId}::uuid AND usuario_id = ${objetivo}::uuid`;
    return miembrosDe(tx, espacioId);
  });
}
