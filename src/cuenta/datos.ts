// Exportar los datos de la cuenta (JSON, SIN secretos) y eliminar la cuenta por lápida.
//
// Exportación: lista blanca de columnas. Nunca salen el hash de la contraseña, hashes de tokens, el
// secreto MFA cifrado (ni su IV o etiqueta) ni los HMAC de los códigos de respaldo. La prueba
// tests/integracion/datos.test.ts lo verifica buscando esos valores en el JSON.
//
// Eliminación: la hace la base con eliminar_cuenta() (migración 0018), en una transacción. Aquí se
// re-autentica y se arma el 409 con la lista de lo que falta transferir.
import { registrarEvento } from '../auth/eventos.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import { exigirContrasena, exigirMfaSiActivo } from './reautenticar.js';

export const FORMATO_EXPORTACION = 'cuaderno-exportacion/v1';

const iso = (d: Date | null) => d?.toISOString() ?? null;

export async function exportarDatos(d: DependenciasApi, usuarioId: string, contrasena: string, ipRed: string | null) {
  await exigirContrasena(d, usuarioId, contrasena, ipRed);
  const p = d.prisma;
  const u = await p.usuarios.findUniqueOrThrow({
    where: { id: usuarioId },
    select: { id: true, nombre: true, correo: true, telefono: true, rol: true, creado_en: true, activada_en: true },
  });
  const mfa = await p.mfa_totp.findUnique({ where: { usuario_id: usuarioId }, select: { confirmado_en: true, creado_en: true } });
  const codigos = await p.codigos_respaldo.count({ where: { usuario_id: usuarioId, usado_en: null } });
  const avatar = await p.avatares.findUnique({ where: { usuario_id: usuarioId }, select: { tipo: true, datos: true, ancho: true, alto: true, actualizado_en: true } });
  const sesiones = await p.$queryRaw<
    { id: string; creado_en: Date; ultimo_uso_en: Date; expira_en: Date; revocada_en: Date | null; motivo_revocacion: string | null; ip_red: string | null; ubicacion: string | null; user_agent: string | null }[]
  >`
    SELECT id, creado_en, ultimo_uso_en, expira_en, revocada_en, motivo_revocacion, ip_red::text AS ip_red, ubicacion, user_agent
    FROM sesiones WHERE usuario_id = ${usuarioId}::uuid ORDER BY creado_en`;
  const espacios = await p.$queryRaw<{ id: string; nombre: string; rol: string; desde: Date }[]>`
    SELECT e.id, e.nombre, m.rol, m.creado_en AS desde
    FROM miembros_espacio m JOIN espacios e ON e.id = m.espacio_id
    WHERE m.usuario_id = ${usuarioId}::uuid ORDER BY e.nombre`;
  // Documentos de los que es propietaria, con el texto de su última versión.
  const documentos = await p.$queryRaw<{ id: string; espacio_id: string; titulo: string; creado_en: Date; texto: string | null }[]>`
    SELECT d.id, d.espacio_id, d.titulo, d.creado_en,
           (SELECT v.contenido_texto FROM versiones v WHERE v.documento_id = d.id ORDER BY v.numero DESC LIMIT 1) AS texto
    FROM permisos_documento pd JOIN documentos d ON d.id = pd.documento_id
    WHERE pd.usuario_id = ${usuarioId}::uuid AND pd.rol = 'propietario' ORDER BY d.creado_en`;
  const comentarios = await p.comentarios.findMany({
    where: { autor_id: usuarioId },
    select: { id: true, documento_id: true, cuerpo: true, creado_en: true, editado_en: true, resuelto_en: true },
    orderBy: { creado_en: 'asc' },
  });
  const eventos = await p.$queryRaw<{ tipo: string; ip_red: string | null; creado_en: Date }[]>`
    SELECT tipo, ip_red::text AS ip_red, creado_en FROM eventos_seguridad WHERE usuario_id = ${usuarioId}::uuid ORDER BY id`;
  const usoIa = await p.uso_ia_diario.findMany({ where: { usuario_id: usuarioId }, orderBy: { dia: 'asc' } });
  const cambio = await p.cambios_correo.findFirst({
    where: { usuario_id: usuarioId, confirmado_en: null, expira_en: { gt: new Date() } },
    select: { correo_nuevo: true, expira_en: true },
  });

  await registrarEvento(p, 'datos_exportados', usuarioId, ipRed);
  return {
    formato: FORMATO_EXPORTACION,
    generadoEn: new Date().toISOString(),
    cuenta: {
      id: u.id,
      nombre: u.nombre,
      correo: u.correo,
      telefono: u.telefono,
      rol: u.rol,
      creadaEn: iso(u.creado_en),
      activadaEn: iso(u.activada_en),
    },
    mfa: { activo: Boolean(mfa?.confirmado_en), desde: iso(mfa?.confirmado_en ?? null), codigosRespaldoSinUsar: codigos },
    cambioCorreoPendiente: cambio ? { correoNuevo: cambio.correo_nuevo, expiraEn: iso(cambio.expira_en) } : null,
    avatar: avatar
      ? { tipo: avatar.tipo, ancho: avatar.ancho, alto: avatar.alto, actualizadoEn: iso(avatar.actualizado_en), base64: Buffer.from(avatar.datos).toString('base64') }
      : null,
    sesiones: sesiones.map((s) => ({
      id: s.id,
      creadaEn: iso(s.creado_en),
      ultimoUsoEn: iso(s.ultimo_uso_en),
      expiraEn: iso(s.expira_en),
      revocadaEn: iso(s.revocada_en),
      motivoRevocacion: s.motivo_revocacion,
      ipRed: s.ip_red,
      ubicacion: s.ubicacion,
      userAgent: s.user_agent,
    })),
    espacios: espacios.map((e) => ({ id: e.id, nombre: e.nombre, rol: e.rol, desde: iso(e.desde) })),
    documentosPropios: documentos.map((x) => ({ id: x.id, espacioId: x.espacio_id, titulo: x.titulo, creadoEn: iso(x.creado_en), textoUltimaVersion: x.texto })),
    comentarios: comentarios.map((c) => ({
      id: c.id,
      documentoId: c.documento_id,
      cuerpo: c.cuerpo,
      creadoEn: iso(c.creado_en),
      editadoEn: iso(c.editado_en),
      resueltoEn: iso(c.resuelto_en),
    })),
    eventosSeguridad: eventos.map((e) => ({ tipo: e.tipo, ipRed: e.ip_red, creadoEn: iso(e.creado_en) })),
    usoIa: usoIa.map((x) => ({
      dia: x.dia.toISOString().slice(0, 10),
      peticiones: x.peticiones,
      tokensEntrada: Number(x.tokens_entrada),
      tokensSalida: Number(x.tokens_salida),
    })),
  };
}

export interface Bloqueo {
  tipo: 'documento' | 'espacio';
  id: string;
  nombre: string;
}

/** Lo que impide eliminar la cuenta: la MISMA regla que aplica la base en eliminar_cuenta(). */
export async function bloqueosDeEliminacion(d: Pick<DependenciasApi, 'prisma'>, usuarioId: string): Promise<Bloqueo[]> {
  const docs = await d.prisma.$queryRaw<{ id: string; nombre: string }[]>`
    SELECT DISTINCT d.id, d.titulo AS nombre
    FROM permisos_documento pd
    JOIN documentos d ON d.id = pd.documento_id
    JOIN miembros_espacio otro ON otro.espacio_id = pd.espacio_id AND otro.usuario_id <> ${usuarioId}::uuid
    WHERE pd.usuario_id = ${usuarioId}::uuid AND pd.rol = 'propietario'`;
  const espacios = await d.prisma.$queryRaw<{ id: string; nombre: string }[]>`
    SELECT DISTINCT e.id, e.nombre
    FROM miembros_espacio me
    JOIN espacios e ON e.id = me.espacio_id
    JOIN miembros_espacio otro ON otro.espacio_id = me.espacio_id AND otro.usuario_id <> ${usuarioId}::uuid
    WHERE me.usuario_id = ${usuarioId}::uuid AND me.rol = 'propietario'`;
  return [...docs.map((x) => ({ tipo: 'documento' as const, ...x })), ...espacios.map((x) => ({ tipo: 'espacio' as const, ...x }))];
}

const PROPIEDAD_COMPARTIDA = 'Eres propietaria o propietario de contenido con otros colaboradores: transfiere la propiedad antes de eliminar la cuenta.';

/** Error de la base con un SQLSTATE dado (Prisma lo anida en distintos lugares según el adaptador). */
function sqlstateDe(e: unknown): string | undefined {
  const texto = e instanceof Error ? `${e.message} ${JSON.stringify(e)}` : String(e);
  return /CU409/.test(texto) ? 'CU409' : undefined;
}

export async function eliminarCuenta(
  d: DependenciasApi,
  usuarioId: string,
  e: { contrasena: string; codigo?: string | undefined; ipRed: string | null },
): Promise<{ espaciosBorrados: number; documentosBorrados: number }> {
  await exigirContrasena(d, usuarioId, e.contrasena, e.ipRed);
  await exigirMfaSiActivo(d, usuarioId, e.codigo, e.ipRed);
  const bloqueos = await bloqueosDeEliminacion(d, usuarioId);
  if (bloqueos.length > 0) throw new ErrorHttp(409, 'propiedad_compartida', PROPIEDAD_COMPARTIDA, bloqueos);
  try {
    const filas = await d.prisma.$queryRaw<{ espacios_borrados: number; documentos_borrados: number }[]>`
      SELECT espacios_borrados, documentos_borrados FROM eliminar_cuenta(${usuarioId}::uuid)`;
    return { espaciosBorrados: filas[0]?.espacios_borrados ?? 0, documentosBorrados: filas[0]?.documentos_borrados ?? 0 };
  } catch (err) {
    // Carrera: alguien se sumó a un espacio entre la revisión de aquí y la de la base.
    if (sqlstateDe(err) === 'CU409') throw new ErrorHttp(409, 'propiedad_compartida', PROPIEDAD_COMPARTIDA, await bloqueosDeEliminacion(d, usuarioId));
    throw err;
  }
}
