// Esquemas zod de las respuestas. Son la fuente de la especificación OpenAPI (src/openapi.ts):
// el documento se genera desde aquí, no se escribe a mano.
import { z } from 'zod';

export const ErrorRespuesta = z
  .object({
    error: z.object({
      codigo: z.string().meta({ example: 'no_encontrado' }),
      mensaje: z.string(),
      solicitud: z.string().meta({ description: 'Id de la solicitud (cabecera x-request-id) para buscarla en el log' }),
      detalles: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ErrorRespuesta' });

export const SaludRespuesta = z.object({ estado: z.literal('ok') }).meta({ id: 'SaludRespuesta' });

export const EstadoComprobacion = z.enum(['ok', 'falla']);

export const ListoRespuesta = z
  .object({
    estado: z.enum(['listo', 'no_listo', 'apagando']),
    comprobaciones: z.record(z.string(), EstadoComprobacion).meta({
      description:
        'Resultado de cada dependencia (bd, esquema, redis, ia). Sin detalles internos: el motivo va al log. "ia" es informativa: su falla no pone /ready en 503.',
    }),
  })
  .meta({ id: 'ListoRespuesta' });

export type ListoRespuesta = z.infer<typeof ListoRespuesta>;

// ─── Autenticación e invitaciones (bloque E) ──────────────────────────────────────

/** Correo normalizado: sin espacios y en minúsculas (la base compara con citext). */
export const Correo = z
  .email({ error: 'correo inválido' })
  .max(254)
  .transform((c) => c.trim().toLowerCase());

export const Rol = z.enum(['admin', 'editor', 'lector']);

export const UsuarioPublico = z
  .object({ id: z.uuid(), nombre: z.string(), correo: z.string(), rol: Rol })
  .meta({ id: 'UsuarioPublico' });

export const InicioSesionSolicitud = z
  .object({ correo: Correo, contrasena: z.string().min(1).max(1000) })
  .meta({ id: 'InicioSesionSolicitud' });

export const SesionRespuesta = z
  .object({
    accessToken: z.string().meta({ description: 'JWT HS256 de 15 min. Guárdalo SOLO en memoria.' }),
    expiraEn: z.number().int().meta({ description: 'Vencimiento del access token (segundos Unix)' }),
    usuario: UsuarioPublico,
  })
  .meta({ id: 'SesionRespuesta', description: 'Además fija la cookie httpOnly cuaderno_refresco (SameSite=Strict, Path=/api/auth).' });

export type SesionRespuesta = z.infer<typeof SesionRespuesta>;

export const YoRespuesta = z.object({ usuario: UsuarioPublico }).meta({ id: 'YoRespuesta' });

export const InvitacionSolicitud = z
  .object({
    nombre: z.string().trim().min(1).max(80),
    correo: Correo,
    rol: Rol,
  })
  .meta({ id: 'InvitacionSolicitud' });

export const InvitacionCreada = z
  .object({
    usuario: UsuarioPublico.extend({ estado: z.literal('pendiente') }),
    expiraEn: z.iso.datetime(),
    correoEnviado: z.boolean().meta({ description: 'false si el proveedor de correo falló: se puede reenviar' }),
  })
  .meta({ id: 'InvitacionCreada', description: 'NUNCA incluye el enlace ni el token: solo los recibe la persona invitada.' });

export const InvitacionPendiente = z
  .object({ usuarioId: z.uuid(), nombre: z.string(), correo: z.string(), rol: Rol, expiraEn: z.iso.datetime(), vencida: z.boolean() })
  .meta({ id: 'InvitacionPendiente' });

export const ListaInvitaciones = z
  .object({ total: z.number().int(), invitaciones: z.array(InvitacionPendiente) })
  .meta({ id: 'ListaInvitaciones' });

/** Paginación de listados: ?limite=1..200 (50 por defecto) y ?desde=0.. */
export const PaginaListado = z.object({
  limite: z.coerce.number().int().min(1).max(200).default(50),
  desde: z.coerce.number().int().min(0).default(0),
});

/** Token de invitación: 32 bytes en base64url. Viaja en el cuerpo, nunca en la URL. */
export const TokenInvitacion = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, { error: 'token inválido' }) }).meta({ id: 'TokenInvitacion' });

export const InvitacionConsulta = z
  .object({ nombre: z.string(), correo: z.string(), rol: Rol, requiereMfa: z.boolean(), expiraEn: z.iso.datetime() })
  .meta({ id: 'InvitacionConsulta' });

export const CompletarInvitacion = TokenInvitacion.extend({ contrasena: z.string().min(1).max(1000) }).meta({ id: 'CompletarInvitacion' });

export const IdUsuario = z.object({ usuarioId: z.uuid() });

// ─── MFA y recuperación (bloque F) ────────────────────────────────────────────────

const Token43 = z.string().regex(/^[A-Za-z0-9_-]{43}$/, { error: 'token inválido' });
const CodigoTotp = z.string().regex(/^\d{6}$/, { error: 'el código tiene 6 dígitos' });

export const DesafioMfa = z
  .object({
    mfaRequerido: z.literal(true),
    desafio: Token43.meta({ description: 'Opaco, 5 min, un solo uso (en Redis solo se guarda su hash)' }),
    metodos: z.array(z.enum(['totp', 'respaldo'])),
    expiraEnSegundos: z.number().int(),
  })
  .meta({ id: 'DesafioMfa', description: 'La cuenta usa MFA: falta el segundo paso (POST /api/auth/mfa).' });

export const MfaSolicitud = z
  .object({ desafio: Token43, codigo: CodigoTotp.optional(), codigoRespaldo: z.string().min(10).max(20).optional() })
  .refine((v) => (v.codigo === undefined) !== (v.codigoRespaldo === undefined), { error: 'envía codigo O codigoRespaldo' })
  .meta({ id: 'MfaSolicitud' });

export const InscripcionMfa = z
  .object({ secreto: z.string().meta({ description: 'Secreto en base32' }), uri: z.string().meta({ description: 'otpauth:// para el QR' }) })
  .meta({ id: 'InscripcionMfa' });

export const CodigoMfa = z.object({ codigo: CodigoTotp }).meta({ id: 'CodigoMfa' });

export const CodigosRespaldo = z
  .object({ codigosRespaldo: z.array(z.string()).meta({ description: 'Se muestran UNA sola vez; en la base solo queda su HMAC' }) })
  .meta({ id: 'CodigosRespaldo' });

export const CompletarConMfa = CompletarInvitacion.extend({ codigoTotp: CodigoTotp.optional() }).meta({ id: 'CompletarConMfa' });

export const CompletarRespuesta = SesionRespuesta.extend({ codigosRespaldo: z.array(z.string()).optional() }).meta({
  id: 'CompletarRespuesta',
  description: 'Para una cuenta admin incluye los 10 códigos de respaldo (se muestran una sola vez).',
});

export const RecuperacionSolicitud = z.object({ correo: Correo }).meta({ id: 'RecuperacionSolicitud' });

export const RecuperacionRespuesta = z
  .object({ mensaje: z.string() })
  .meta({ id: 'RecuperacionRespuesta', description: 'SIEMPRE la misma respuesta, exista o no el correo.' });

export const RestablecerSolicitud = z.object({ token: Token43, contrasena: z.string().min(1).max(1000) }).meta({ id: 'RestablecerSolicitud' });

// ─── Perfil, sesiones y datos (bloque G) ──────────────────────────────────────────

const Contrasena = z.string().min(1).max(1000);
/** Teléfono E.164 (+ y de 7 a 15 dígitos), lo mismo que exige la base. */
const Telefono = z.string().regex(/^\+[1-9][0-9]{6,14}$/, { error: 'teléfono en formato internacional: +15550100123' });

export const Perfil = z
  .object({
    id: z.uuid(),
    nombre: z.string(),
    correo: z.string(),
    telefono: z.string().nullable(),
    rol: Rol,
    creadaEn: z.iso.datetime(),
    activadaEn: z.iso.datetime().nullable(),
    mfaActivo: z.boolean(),
    avatar: z.object({ tipo: z.enum(['image/jpeg', 'image/png']), ancho: z.number().int(), alto: z.number().int(), hash: z.string() }).nullable(),
    cambioCorreoPendiente: z
      .object({ correoNuevo: z.string(), expiraEn: z.iso.datetime() })
      .nullable()
      .meta({ description: 'Cambio de correo pedido y aún sin confirmar desde la dirección nueva' }),
  })
  .meta({ id: 'Perfil' });

export const ActualizarPerfil = z
  .object({ nombre: z.string().trim().min(1).max(80).optional(), telefono: Telefono.nullable().optional() })
  .refine((v) => v.nombre !== undefined || v.telefono !== undefined, { error: 'envía nombre o telefono' })
  .meta({ id: 'ActualizarPerfil' });

export const CambioCorreoSolicitud = z.object({ correoNuevo: Correo, contrasena: Contrasena }).meta({ id: 'CambioCorreoSolicitud' });

export const CambioCorreoRespuesta = z
  .object({ mensaje: z.string() })
  .meta({ id: 'CambioCorreoRespuesta', description: 'SIEMPRE la misma respuesta, esté o no en uso la dirección nueva.' });

export const ConfirmarCorreo = z.object({ token: Token43 }).meta({ id: 'ConfirmarCorreo' });

export const CambioContrasena = z.object({ actual: Contrasena, nueva: Contrasena }).meta({ id: 'CambioContrasena' });

export const SesionActiva = z
  .object({
    id: z.uuid(),
    actual: z.boolean().meta({ description: 'Es la sesión de esta petición' }),
    creadaEn: z.iso.datetime(),
    ultimoUsoEn: z.iso.datetime(),
    expiraEn: z.iso.datetime(),
    ipRed: z.string().nullable().meta({ description: 'Red truncada: /24 en IPv4, /48 en IPv6. Nunca la IP completa.' }),
    ubicacion: z.string().nullable().meta({ description: 'Aproximada, a partir de la red truncada' }),
    userAgent: z.string().nullable().meta({ example: 'Firefox · Windows' }),
    mfaVerificada: z.boolean(),
  })
  .meta({ id: 'SesionActiva' });

export const ListaSesiones = z.object({ sesiones: z.array(SesionActiva) }).meta({ id: 'ListaSesiones' });

export const IdSesion = z.object({ id: z.uuid() });

export const SesionesCerradas = z.object({ cerradas: z.number().int() }).meta({ id: 'SesionesCerradas' });

export const AvatarGuardado = z
  .object({ tipo: z.enum(['image/jpeg', 'image/png']), ancho: z.number().int(), alto: z.number().int(), bytes: z.number().int(), hash: z.string() })
  .meta({ id: 'AvatarGuardado', description: 'Ya sin metadatos (EXIF, GPS, XMP, ICC, comentarios).' });

export const ConfirmarConContrasena = z.object({ contrasena: Contrasena }).meta({ id: 'ConfirmarConContrasena' });

export const EliminarCuentaSolicitud = z
  .object({ contrasena: Contrasena, codigo: CodigoTotp.optional().meta({ description: 'Obligatorio si la cuenta tiene MFA' }) })
  .meta({ id: 'EliminarCuentaSolicitud' });

export const CuentaEliminada = z
  .object({ espaciosBorrados: z.number().int(), documentosBorrados: z.number().int() })
  .meta({ id: 'CuentaEliminada', description: 'Espacios donde era el único miembro y sus documentos (sin colaboradores).' });

export const PropiedadCompartida = z
  .object({ tipo: z.enum(['documento', 'espacio']), id: z.uuid(), nombre: z.string() })
  .meta({ id: 'PropiedadCompartida', description: 'Lo que hay que transferir antes de eliminar la cuenta.' });

export const ErrorPropiedadCompartida = z
  .object({
    error: z.object({
      codigo: z.literal('propiedad_compartida'),
      mensaje: z.string(),
      solicitud: z.string(),
      detalles: z.array(PropiedadCompartida),
    }),
  })
  .meta({ id: 'ErrorPropiedadCompartida' });

// ─── Espacios, documentos y permisos (bloque K1) ──────────────────────────────────

/** Rol de una cuenta en un espacio o documento (no confundir con el rol de CUENTA). */
export const RolContenido = z.enum(['propietario', 'editor', 'lector']);
/** Roles que se pueden DAR a un miembro: la propiedad solo se transfiere. */
export const RolAsignable = z.enum(['editor', 'lector']);

/** Lo mismo que exige la base (espacios_nombre_formato y documentos_titulo_formato). */
const NombreEspacio = z.string().trim().min(1).max(80);
const TituloDocumento = z.string().trim().min(1).max(200);

export const IdEspacio = z.object({ espacioId: z.uuid() });
export const IdDocumento = z.object({ documentoId: z.uuid() });
export const IdMiembro = z.object({ espacioId: z.uuid(), usuarioId: z.uuid() });
export const IdPermiso = z.object({ documentoId: z.uuid(), usuarioId: z.uuid() });

export const NombreEspacioSolicitud = z.object({ nombre: NombreEspacio }).meta({ id: 'NombreEspacioSolicitud' });
export const TituloDocumentoSolicitud = z.object({ titulo: TituloDocumento }).meta({ id: 'TituloDocumentoSolicitud' });
export const AgregarMiembroSolicitud = z.object({ correo: Correo, rol: RolAsignable }).meta({ id: 'AgregarMiembroSolicitud' });
export const CambiarRolSolicitud = z.object({ rol: RolAsignable }).meta({ id: 'CambiarRolSolicitud' });
export const TransferirSolicitud = z
  .object({ usuarioId: z.uuid().meta({ description: 'Miembro del espacio que recibe la propiedad' }) })
  .meta({ id: 'TransferirSolicitud' });
export const DarPermisoSolicitud = z
  .object({
    rol: z.literal('editor').meta({
      description: 'Solo "editor": el rol efectivo es el MAYOR entre el del espacio y el del documento, así que un permiso "lector" no cambiaría nada.',
    }),
  })
  .meta({ id: 'DarPermisoSolicitud' });

export const Espacio = z
  .object({
    id: z.uuid(),
    nombre: z.string(),
    rol: RolContenido.meta({ description: 'Tu rol en el espacio' }),
    creadoEn: z.iso.datetime(),
    miembros: z.number().int(),
  })
  .meta({ id: 'Espacio' });

export const ListaEspacios = z.object({ espacios: z.array(Espacio) }).meta({ id: 'ListaEspacios' });

export const EspacioEliminado = z.object({ documentosBorrados: z.number().int() }).meta({ id: 'EspacioEliminado' });

export const Miembro = z
  .object({ usuarioId: z.uuid(), nombre: z.string(), correo: z.string(), rol: RolContenido, desde: z.iso.datetime() })
  .meta({ id: 'Miembro' });

export const ListaMiembros = z.object({ miembros: z.array(Miembro) }).meta({ id: 'ListaMiembros' });

export const Documento = z
  .object({
    id: z.uuid(),
    espacioId: z.uuid(),
    titulo: z.string(),
    rol: RolContenido.meta({ description: 'Tu rol EFECTIVO en el documento (rol_efectivo_documento de la base)' }),
    propietario: z.object({ id: z.uuid(), nombre: z.string() }),
    creadoEn: z.iso.datetime(),
    actualizadoEn: z.iso.datetime().meta({ description: 'Último cambio de la fila (título o estado compactado), no la última edición del texto' }),
  })
  .meta({ id: 'Documento' });

export const ListaDocumentos = z.object({ documentos: z.array(Documento) }).meta({ id: 'ListaDocumentos' });

export const PermisoDocumento = z
  .object({ usuarioId: z.uuid(), nombre: z.string(), rol: RolContenido })
  .meta({ id: 'PermisoDocumento', description: 'Permiso PROPIO del documento (además del rol de espacio)' });

export const ListaPermisos = z.object({ permisos: z.array(PermisoDocumento) }).meta({ id: 'ListaPermisos' });

// ─── Versiones y comentarios (bloque N) ───────────────────────────────────────────

export const IdVersion = z.object({ documentoId: z.uuid(), numero: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER) });
export const IdComentario = z.object({ comentarioId: z.uuid() });

export const Version = z
  .object({
    numero: z.number().int(),
    motivo: z.enum(['manual', 'automatica', 'restauracion']),
    autor: z.object({ id: z.uuid(), nombre: z.string() }).nullable().meta({ description: 'null en las automáticas' }),
    restauradaDe: z.number().int().nullable().meta({ description: 'Número de la versión que esta restauró' }),
    creadaEn: z.iso.datetime(),
    caracteres: z.number().int(),
  })
  .meta({ id: 'Version' });
export const ListaVersiones = z.object({ versiones: z.array(Version) }).meta({ id: 'ListaVersiones', description: 'Las 200 más nuevas, de la más nueva a la más vieja' });
export const VersionConTexto = Version.extend({ texto: z.string() }).meta({ id: 'VersionConTexto' });
export const TextoActual = z.object({ texto: z.string() }).meta({ id: 'TextoActual' });

/** Lo mismo que exige la base (comentarios_cuerpo_longitud). */
const CuerpoComentario = z.string().trim().min(1).max(5000);
export const ComentarioSolicitud = z
  .object({
    cuerpo: CuerpoComentario,
    ancla: z.string().max(1400).optional().meta({ description: 'Hilo nuevo: base64url de dos posiciones relativas de Yjs (inicio y fin del tramo)' }),
    padreId: z.uuid().optional().meta({ description: 'Respuesta: el hilo al que responde (sin ancla)' }),
  })
  .meta({ id: 'ComentarioSolicitud' });
export const CambiarComentarioSolicitud = z
  .object({ cuerpo: CuerpoComentario.optional(), resuelto: z.boolean().optional() })
  .refine((c) => c.cuerpo !== undefined || c.resuelto !== undefined, { message: 'Indica el cuerpo o si está resuelto' })
  .meta({ id: 'CambiarComentarioSolicitud' });
export const Comentario = z
  .object({
    id: z.uuid(),
    padreId: z.uuid().nullable(),
    autor: z.object({ id: z.uuid(), nombre: z.string() }),
    ancla: z.string().nullable(),
    cuerpo: z.string(),
    resuelto: z.boolean(),
    creadoEn: z.iso.datetime(),
    editadoEn: z.iso.datetime().nullable(),
  })
  .meta({ id: 'Comentario' });
export const ListaComentarios = z.object({ comentarios: z.array(Comentario) }).meta({ id: 'ListaComentarios' });

// ─── Tiempo real (bloque K2) ──────────────────────────────────────────────────────

export const SolicitudTicket = z.object({ documentoId: z.uuid() }).meta({ id: 'SolicitudTicket' });
export const TicketTiempoReal = z
  .object({
    ticket: z.string().meta({ description: 'Un solo uso. Va en Sec-WebSocket-Protocol como "ticket.<valor>", junto a "cuaderno.v1"; nunca en la URL.' }),
    expiraEnSegundos: z.number().int(),
  })
  .meta({ id: 'TicketTiempoReal' });

export const ErrorPropiedadDocumentos = z
  .object({
    error: z.object({
      codigo: z.literal('propiedad_documentos'),
      mensaje: z.string(),
      solicitud: z.string(),
      detalles: z.array(PropiedadCompartida),
    }),
  })
  .meta({ id: 'ErrorPropiedadDocumentos', description: 'Documentos del espacio que el miembro posee: hay que transferirlos antes de quitarlo.' });

// ─── IA (bloque P1) ───────────────────────────────────────────────────────────────

/** Topes de tamaño de lo que manda el navegador (el cuerpo JSON admite hasta 100 kB). */
export const MAXIMOS_IA = { explicar: 8_000, transformar: 40_000, consulta: 500 } as const;

const ContenidoIa = (maximo: number) =>
  z
    .string()
    .refine((t) => t.trim() !== '', { error: 'vacío' })
    .refine((t) => t.length <= maximo, { error: `hasta ${String(maximo)} caracteres` });

export const ExplicarSolicitud = z
  .object({
    documentoId: z.uuid(),
    contenido: ContenidoIa(MAXIMOS_IA.explicar).meta({ description: 'El fragmento seleccionado. Se trata como DATOS, nunca como instrucciones.' }),
    lenguaje: z
      .string()
      .regex(/^[A-Za-z0-9+#._-]{0,40}$/)
      .default('')
      .meta({ description: 'Lenguaje del bloque de código ("ts", "sql"…); vacío si es prosa' }),
  })
  .meta({ id: 'ExplicarSolicitud' });

export const UsoIa = z.object({ tokensEntrada: z.number().int(), tokensSalida: z.number().int() }).meta({ id: 'UsoIa' });

export const RespuestaIa = z.object({ texto: z.string(), uso: UsoIa }).meta({ id: 'RespuestaIa' });

export const TransformarSolicitudHttp = z
  .object({
    documentoId: z.uuid(),
    contenido: ContenidoIa(MAXIMOS_IA.transformar),
    estilo: z.enum(['claro', 'breve', 'formal']).default('claro').meta({ description: 'Conjunto cerrado: no se escriben instrucciones libres al modelo' }),
  })
  .meta({ id: 'TransformarSolicitud' });

export const BusquedaSolicitud = z
  .object({
    consulta: z.string().trim().min(1).max(MAXIMOS_IA.consulta),
    limite: z.number().int().min(1).max(20).default(10),
  })
  .meta({ id: 'BusquedaSolicitud' });

export const ResultadosBusqueda = z
  .object({
    resultados: z.array(
      z.object({
        documentoId: z.uuid(),
        titulo: z.string(),
        fragmento: z.number().int().meta({ description: 'Posición del fragmento dentro del documento (0, 1, 2…)' }),
        texto: z.string(),
        similitud: z.number().meta({ description: 'Coseno entre la consulta y el fragmento (1 = idénticos)' }),
      }),
    ),
  })
  .meta({ id: 'ResultadosBusqueda', description: 'Solo del espacio pedido y de documentos a los que tienes acceso HOY' });

export const IndiceEncolado = z.object({ encolado: z.literal(true) }).meta({ id: 'IndiceEncolado' });
