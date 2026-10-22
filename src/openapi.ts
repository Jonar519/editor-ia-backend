// Especificación OpenAPI generada desde los esquemas zod (src/http/esquemas.ts).
// `npm run openapi` la escribe en docs/openapi.json; `npm run openapi:check` falla si quedó desactualizada.
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import {
  BusquedaSolicitud,
  ExplicarSolicitud,
  IndiceEncolado,
  RespuestaIa,
  ResultadosBusqueda,
  TransformarSolicitudHttp,
  CambiarComentarioSolicitud,
  Comentario,
  ComentarioSolicitud,
  IdComentario,
  IdVersion,
  ListaComentarios,
  ListaVersiones,
  TextoActual,
  Version,
  VersionConTexto,
  ActualizarPerfil,
  AgregarMiembroSolicitud,
  CambiarRolSolicitud,
  DarPermisoSolicitud,
  Documento,
  Espacio,
  EspacioEliminado,
  ErrorPropiedadDocumentos,
  IdDocumento,
  IdEspacio,
  IdMiembro,
  IdPermiso,
  ListaDocumentos,
  ListaEspacios,
  ListaMiembros,
  ListaPermisos,
  Miembro,
  NombreEspacioSolicitud,
  SolicitudTicket,
  TicketTiempoReal,
  TituloDocumentoSolicitud,
  TransferirSolicitud,
  AvatarGuardado,
  CambioContrasena,
  CambioCorreoRespuesta,
  CambioCorreoSolicitud,
  CodigoMfa,
  CodigosRespaldo,
  CompletarConMfa,
  CompletarRespuesta,
  ConfirmarConContrasena,
  ConfirmarCorreo,
  CuentaEliminada,
  DesafioMfa,
  EliminarCuentaSolicitud,
  ErrorRespuesta,
  IdSesion,
  IdUsuario,
  ListaSesiones,
  ErrorPropiedadCompartida,
  Perfil,
  SesionesCerradas,
  InicioSesionSolicitud,
  InscripcionMfa,
  InvitacionConsulta,
  InvitacionCreada,
  InvitacionSolicitud,
  ListaInvitaciones,
  ListoRespuesta,
  MfaSolicitud,
  PaginaListado,
  RecuperacionRespuesta,
  RecuperacionSolicitud,
  RestablecerSolicitud,
  SaludRespuesta,
  SesionRespuesta,
  TokenInvitacion,
  YoRespuesta,
} from './http/esquemas.js';

const json = <T>(schema: T) => ({ content: { 'application/json': { schema } } });
const error = (description: string) => ({ description, ...json(ErrorRespuesta) });
const ERRORES_COMUNES = { 400: error('Datos inválidos'), 429: error('Demasiados intentos'), 503: error('Límites no disponibles (falla cerrado)') };

function registrarAuth(registro: OpenAPIRegistry): void {
  registro.registerComponent('securitySchemes', 'acceso', { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' });
  registro.registerPath({
    method: 'post',
    path: '/api/auth/sesion',
    tags: ['auth'],
    summary: 'Iniciar sesión (bloqueo progresivo; misma respuesta exista o no el correo)',
    request: { body: json(InicioSesionSolicitud) },
    responses: {
      201: { description: 'Sesión abierta. Fija la cookie de refresco.', ...json(SesionRespuesta) },
      202: { description: 'La cuenta usa MFA: falta el segundo paso (POST /api/auth/mfa)', ...json(DesafioMfa) },
      401: error('Correo o contraseña incorrectos'),
      ...ERRORES_COMUNES,
    },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/auth/refresco',
    tags: ['auth'],
    summary: 'Rotar el refresh (cookie) y obtener un access token nuevo. Reutilizar uno usado revoca la sesión.',
    responses: {
      200: { description: 'Access nuevo; la cookie trae el refresh nuevo', ...json(SesionRespuesta) },
      401: error('Sin cookie, inválido o reutilizado (refresco_reutilizado: la sesión quedó revocada)'),
      403: error('Origin distinto al del frontend'),
      ...ERRORES_COMUNES,
    },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/auth/sesion',
    tags: ['auth'],
    summary: 'Cerrar la sesión actual',
    security: [{ acceso: [] }],
    responses: { 204: { description: 'Sesión revocada y cookie borrada' }, 401: error('Sin sesión viva') },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/auth/yo',
    tags: ['auth'],
    summary: 'Cuenta de la sesión actual (verifica que la sesión siga viva)',
    security: [{ acceso: [] }],
    responses: { 200: { description: 'Cuenta', ...json(YoRespuesta) }, 401: error('Sin sesión viva') },
  });
}

function registrarInvitaciones(registro: OpenAPIRegistry): void {
  const admin = { tags: ['invitaciones (admin)'], security: [{ acceso: [] }] };
  const permisos = { 401: error('Sin sesión viva'), 403: error('Solo admin') };
  registro.registerPath({
    method: 'post',
    path: '/api/admin/invitaciones',
    ...admin,
    summary: 'Invitar (crea la cuenta pendiente y envía el enlace por correo; la respuesta NUNCA trae el enlace)',
    request: { body: json(InvitacionSolicitud) },
    responses: { 201: { description: 'Invitación creada', ...json(InvitacionCreada) }, 409: error('Correo en uso'), ...permisos, ...ERRORES_COMUNES },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/admin/invitaciones',
    ...admin,
    summary: 'Invitaciones pendientes, las más recientes primero (paginado: ?limite=1..200, ?desde)',
    request: { query: PaginaListado },
    responses: { 200: { description: 'Lista', ...json(ListaInvitaciones) }, ...permisos },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/admin/invitaciones/{usuarioId}/reenviar',
    ...admin,
    summary: 'Reenviar con un enlace nuevo (el anterior deja de servir)',
    request: { params: IdUsuario },
    responses: { 200: { description: 'Reenviada', ...json(InvitacionCreada) }, 404: error('No hay invitación pendiente'), ...permisos, ...ERRORES_COMUNES },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/admin/invitaciones/{usuarioId}',
    ...admin,
    summary: 'Cancelar (borra la cuenta pendiente)',
    request: { params: IdUsuario },
    responses: { 204: { description: 'Cancelada' }, 404: error('No hay invitación pendiente'), ...permisos },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/invitaciones/consultar',
    tags: ['invitaciones'],
    summary: 'Datos de la invitación para el formulario (el token va en el cuerpo, nunca en la URL)',
    request: { body: json(TokenInvitacion) },
    responses: { 200: { description: 'Invitación vigente', ...json(InvitacionConsulta) }, 404: error('Enlace inválido o usado'), 410: error('Enlace vencido'), ...ERRORES_COMUNES },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/invitaciones/completar',
    tags: ['invitaciones'],
    summary: 'Elegir contraseña, activar la cuenta y abrir la primera sesión (un solo uso)',
    request: { body: json(CompletarConMfa) },
    responses: {
      201: { description: 'Cuenta activa y sesión abierta (fija la cookie de refresco). Un admin recibe sus códigos de respaldo.', ...json(CompletarRespuesta) },
      404: error('Enlace inválido o usado'),
      409: error('Cuenta admin sin el primer código TOTP: configurar MFA (POST /api/invitaciones/mfa)'),
      410: error('Enlace vencido'),
      ...ERRORES_COMUNES,
    },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/invitaciones/mfa',
    tags: ['invitaciones'],
    summary: 'Admin pendiente: obtener el secreto TOTP para configurar la app ANTES de completar (pedirlo otra vez devuelve el mismo)',
    request: { body: json(TokenInvitacion) },
    responses: {
      200: { description: 'Secreto y otpauth:// (el QR lo dibuja el cliente)', ...json(InscripcionMfa) },
      404: error('Enlace inválido o usado'),
      409: error('La invitación no es de una cuenta admin'),
      410: error('Enlace vencido'),
      ...ERRORES_COMUNES,
    },
  });
}

function registrarPerfilYDatos(registro: OpenAPIRegistry): void {
  const cuenta = { tags: ['cuenta'], security: [{ acceso: [] }] };
  const sinSesion = { 401: error('Sin sesión viva') };
  const reautenticacion = {
    403: error('Contraseña (o código MFA) incorrecta: suma al bloqueo de la cuenta'),
    429: error('Demasiados intentos o cuenta bloqueada'),
  };
  registro.registerPath({
    method: 'get',
    path: '/api/cuenta',
    ...cuenta,
    summary: 'Perfil de la cuenta',
    responses: { 200: { description: 'Perfil', ...json(Perfil) }, ...sinSesion },
  });
  registro.registerPath({
    method: 'patch',
    path: '/api/cuenta',
    ...cuenta,
    summary: 'Cambiar nombre o teléfono',
    request: { body: json(ActualizarPerfil) },
    responses: { 200: { description: 'Perfil actualizado', ...json(Perfil) }, 400: error('Datos inválidos'), ...sinSesion },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/cuenta/correo',
    ...cuenta,
    summary: 'Pedir el cambio de correo: enlace al correo NUEVO y aviso al anterior. Misma respuesta esté o no en uso.',
    request: { body: json(CambioCorreoSolicitud) },
    responses: { 202: { description: 'Pedido recibido', ...json(CambioCorreoRespuesta) }, 400: error('Es el mismo correo'), ...reautenticacion, ...sinSesion },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/cuenta/correo/confirmar',
    tags: ['cuenta'],
    summary: 'Confirmar el correo nuevo con el token del enlace (sin sesión; un solo uso)',
    request: { body: json(ConfirmarCorreo) },
    responses: { 204: { description: 'Correo cambiado; se avisa al anterior' }, 400: error('Enlace inválido, usado o vencido'), 409: error('La dirección ya tiene cuenta') },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/cuenta/contrasena',
    ...cuenta,
    summary: 'Cambiar la contraseña: cierra las DEMÁS sesiones y avisa por correo',
    request: { body: json(CambioContrasena) },
    responses: { 200: { description: 'Sesiones cerradas', ...json(SesionesCerradas) }, 400: error('No cumple la política'), ...reautenticacion, ...sinSesion },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/cuenta/sesiones',
    ...cuenta,
    summary: 'Sesiones activas: IP truncada, ubicación aproximada, user-agent corto',
    responses: { 200: { description: 'Sesiones', ...json(ListaSesiones) }, ...sinSesion },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/cuenta/sesiones/{id}',
    ...cuenta,
    summary: 'Cerrar una sesión de la cuenta',
    request: { params: IdSesion },
    responses: { 204: { description: 'Cerrada' }, 404: error('No hay una sesión activa con ese id en tu cuenta'), ...sinSesion },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/cuenta/sesiones/cerrar-otras',
    ...cuenta,
    summary: 'Cerrar todas las sesiones menos la actual',
    responses: { 200: { description: 'Cuántas se cerraron', ...json(SesionesCerradas) }, ...sinSesion },
  });
  registro.registerPath({
    method: 'put',
    path: '/api/cuenta/avatar',
    ...cuenta,
    summary: 'Subir el avatar (JPEG o PNG, 1 MiB). Se guarda SIN metadatos; un archivo no analizable no se guarda.',
    request: { body: { content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } }, 'image/png': { schema: { type: 'string', format: 'binary' } } } } },
    responses: {
      200: { description: 'Guardado (ya limpio)', ...json(AvatarGuardado) },
      413: error('Más de 1 MiB'),
      415: error('Content-Type distinto de image/jpeg o image/png'),
      422: error('No es un JPEG o PNG analizable'),
      ...sinSesion,
    },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/cuenta/avatar',
    ...cuenta,
    summary: 'Borrar el avatar',
    responses: { 204: { description: 'Borrado' }, ...sinSesion },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/usuarios/{usuarioId}/avatar',
    ...cuenta,
    tags: ['usuarios'],
    summary: 'Avatar de una cuenta (con ETag; CSP sin nada permitido)',
    request: { params: IdUsuario },
    responses: {
      200: { description: 'La imagen', content: { 'image/jpeg': { schema: { type: 'string', format: 'binary' } }, 'image/png': { schema: { type: 'string', format: 'binary' } } } },
      304: { description: 'Sin cambios (If-None-Match)' },
      404: error('Sin avatar'),
      ...sinSesion,
    },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/cuenta/exportacion',
    ...cuenta,
    summary: 'Exportar los datos de la cuenta en JSON (sin secretos). Exige la contraseña.',
    request: { body: json(ConfirmarConContrasena) },
    responses: {
      200: {
        description: 'Archivo JSON (Content-Disposition: attachment), formato cuaderno-exportacion/v1',
        content: { 'application/json': { schema: { type: 'object' } } },
      },
      ...reautenticacion,
      ...sinSesion,
    },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/cuenta',
    ...cuenta,
    summary: 'Eliminar la cuenta (lápida). Exige contraseña y, con MFA, un código.',
    request: { body: json(EliminarCuentaSolicitud) },
    responses: {
      200: { description: 'Eliminada; borra la cookie de refresco', ...json(CuentaEliminada) },
      400: error('Falta el código MFA'),
      409: { description: 'Propietaria de contenido con colaboradores: error.detalles lista qué transferir', ...json(ErrorPropiedadCompartida) },
      ...reautenticacion,
      ...sinSesion,
    },
  });
}

function registrarMfaYRecuperacion(registro: OpenAPIRegistry): void {
  registro.registerPath({
    method: 'post',
    path: '/api/auth/mfa',
    tags: ['auth'],
    summary: 'Segundo paso del login: código TOTP o de respaldo. El desafío se consume al primer intento.',
    request: { body: json(MfaSolicitud) },
    responses: {
      201: { description: 'Sesión abierta con MFA verificado (fija la cookie de refresco)', ...json(SesionRespuesta) },
      401: error('Código inválido o desafío vencido/usado (misma respuesta: no revela si la cuenta existe)'),
      ...ERRORES_COMUNES,
    },
  });
  const cuenta = { tags: ['cuenta'], security: [{ acceso: [] }] };
  registro.registerPath({
    method: 'post',
    path: '/api/cuenta/mfa/iniciar',
    ...cuenta,
    summary: 'Empezar a configurar MFA (opcional para editor y lector)',
    responses: { 200: { description: 'Secreto y otpauth://', ...json(InscripcionMfa) }, 409: error('Ya está activo'), 401: error('Sin sesión viva') },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/cuenta/mfa/confirmar',
    ...cuenta,
    summary: 'Confirmar con el primer código: activa MFA y entrega 10 códigos de respaldo (una sola vez)',
    request: { body: json(CodigoMfa) },
    responses: { 200: { description: 'Códigos de respaldo', ...json(CodigosRespaldo) }, 400: error('Código inválido (suma al bloqueo)'), 401: error('Sin sesión viva') },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/cuenta/mfa/codigos-respaldo',
    ...cuenta,
    summary: 'Regenerar los códigos de respaldo (invalida los anteriores)',
    request: { body: json(CodigoMfa) },
    responses: { 200: { description: 'Códigos nuevos', ...json(CodigosRespaldo) }, 400: error('Código inválido (suma al bloqueo)'), 401: error('Sin sesión viva') },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/cuenta/mfa',
    ...cuenta,
    summary: 'Desactivar MFA (no permitido para admin)',
    request: { body: json(CodigoMfa) },
    responses: { 204: { description: 'Desactivado' }, 400: error('Código inválido (suma al bloqueo)'), 409: error('Obligatorio para admin'), 401: error('Sin sesión viva') },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/auth/recuperacion',
    tags: ['auth'],
    summary: 'Pedir un enlace para restablecer la contraseña. Respuesta idéntica e inmediata exista o no el correo.',
    request: { body: json(RecuperacionSolicitud) },
    responses: { 202: { description: 'Siempre la misma', ...json(RecuperacionRespuesta) }, ...ERRORES_COMUNES },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/auth/recuperacion/completar',
    tags: ['auth'],
    summary: 'Restablecer la contraseña con el enlace (15 min, un solo uso). Cierra todas las sesiones.',
    request: { body: json(RestablecerSolicitud) },
    responses: { 204: { description: 'Contraseña restablecida' }, ...ERRORES_COMUNES },
  });
}

function registrarEspaciosYDocumentos(registro: OpenAPIRegistry): void {
  const espacios = { tags: ['espacios'], security: [{ acceso: [] }] };
  const documentos = { tags: ['documentos'], security: [{ acceso: [] }] };
  const comunes = { 401: error('Sin sesión viva'), 400: error('Datos inválidos') };
  const sinEspacio = { 404: error('El espacio no existe o no eres miembro (no se distingue)') };
  const sinDocumento = { 404: error('El documento no existe o no tienes acceso (no se distingue)') };
  const sinRol = { 403: error('Eres miembro, pero tu rol no alcanza') };

  // ─── Espacios ───
  registro.registerPath({
    method: 'get',
    path: '/api/espacios',
    ...espacios,
    summary: 'Tus espacios, con tu rol en cada uno',
    responses: { 200: { description: 'Lista', ...json(ListaEspacios) }, ...comunes },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/espacios',
    ...espacios,
    summary: 'Crear un espacio (quedas como propietario). Una cuenta de solo lectura no puede.',
    request: { body: json(NombreEspacioSolicitud) },
    responses: { 201: { description: 'Creado', ...json(Espacio) }, 403: error('Cuenta de solo lectura'), ...comunes },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/espacios/{espacioId}',
    ...espacios,
    summary: 'Un espacio',
    request: { params: IdEspacio },
    responses: { 200: { description: 'Espacio', ...json(Espacio) }, ...sinEspacio, ...comunes },
  });
  registro.registerPath({
    method: 'patch',
    path: '/api/espacios/{espacioId}',
    ...espacios,
    summary: 'Renombrar (propietario)',
    request: { params: IdEspacio, body: json(NombreEspacioSolicitud) },
    responses: { 200: { description: 'Espacio', ...json(Espacio) }, ...sinRol, ...sinEspacio, ...comunes },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/espacios/{espacioId}',
    ...espacios,
    summary: 'Borrar con todo su contenido (propietario y único miembro)',
    request: { params: IdEspacio },
    responses: {
      200: { description: 'Borrado', ...json(EspacioEliminado) },
      409: error('espacio_compartido: tiene otros miembros'),
      ...sinRol,
      ...sinEspacio,
      ...comunes,
    },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/espacios/{espacioId}/propiedad',
    ...espacios,
    summary: 'Transferir el espacio a otro miembro (el anterior queda como editor)',
    request: { params: IdEspacio, body: json(TransferirSolicitud) },
    responses: {
      200: { description: 'Miembros con sus roles nuevos', ...json(ListaMiembros) },
      404: error('El espacio no existe, no eres miembro, o el destino no es miembro'),
      409: error('rol_excede_cuenta (cuenta de solo lectura) o ya_es_propietario'),
      ...sinRol,
      ...comunes,
    },
  });

  // ─── Miembros ───
  registro.registerPath({
    method: 'get',
    path: '/api/espacios/{espacioId}/miembros',
    ...espacios,
    summary: 'Miembros del espacio',
    request: { params: IdEspacio },
    responses: { 200: { description: 'Miembros', ...json(ListaMiembros) }, ...sinEspacio, ...comunes },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/espacios/{espacioId}/miembros',
    ...espacios,
    summary: 'Agregar una cuenta activa por su correo (propietario; límite por cuenta)',
    request: { params: IdEspacio, body: json(AgregarMiembroSolicitud) },
    responses: {
      201: { description: 'Miembro agregado', ...json(Miembro) },
      404: error('El espacio no existe, o no hay una cuenta ACTIVA con ese correo (cuenta_no_encontrada, genérico)'),
      409: error('ya_es_miembro, o rol_excede_cuenta (una cuenta de solo lectura solo puede ser lectora)'),
      429: error('Demasiadas altas seguidas'),
      ...sinRol,
      ...comunes,
    },
  });
  registro.registerPath({
    method: 'patch',
    path: '/api/espacios/{espacioId}/miembros/{usuarioId}',
    ...espacios,
    summary: 'Cambiar el rol de un miembro (propietario). La propiedad se transfiere aparte.',
    request: { params: IdMiembro, body: json(CambiarRolSolicitud) },
    responses: {
      200: { description: 'Miembro', ...json(Miembro) },
      404: error('El espacio o el miembro no existe'),
      409: error('usar_transferencia o rol_excede_cuenta'),
      ...sinRol,
      ...comunes,
    },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/espacios/{espacioId}/miembros/{usuarioId}',
    ...espacios,
    summary: 'Quitar a un miembro (propietario) o salir (tu propio id). Sus permisos de documento se van en cascada.',
    request: { params: IdMiembro },
    responses: {
      204: { description: 'Quitado' },
      404: error('El espacio o el miembro no existe'),
      409: { description: 'propietario_no_sale, o propiedad_documentos con la lista de documentos que hay que transferir', ...json(ErrorPropiedadDocumentos) },
      ...sinRol,
      ...comunes,
    },
  });

  // ─── Documentos ───
  registro.registerPath({
    method: 'get',
    path: '/api/espacios/{espacioId}/documentos',
    ...documentos,
    summary: 'Documentos del espacio, con tu rol EFECTIVO en cada uno',
    request: { params: IdEspacio },
    responses: { 200: { description: 'Documentos', ...json(ListaDocumentos) }, ...sinEspacio, ...comunes },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/espacios/{espacioId}/documentos',
    ...documentos,
    summary: 'Crear un documento (propietario o editor del espacio; quedas como propietario del documento)',
    request: { params: IdEspacio, body: json(TituloDocumentoSolicitud) },
    responses: { 201: { description: 'Creado', ...json(Documento) }, ...sinRol, ...sinEspacio, ...comunes },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/documentos/{documentoId}',
    ...documentos,
    summary: 'Metadatos de un documento (el contenido va por WebSocket, bloque K2)',
    request: { params: IdDocumento },
    responses: { 200: { description: 'Documento', ...json(Documento) }, ...sinDocumento, ...comunes },
  });
  registro.registerPath({
    method: 'patch',
    path: '/api/documentos/{documentoId}',
    ...documentos,
    summary: 'Cambiar el título (editor o propietario efectivo)',
    request: { params: IdDocumento, body: json(TituloDocumentoSolicitud) },
    responses: { 200: { description: 'Documento', ...json(Documento) }, ...sinRol, ...sinDocumento, ...comunes },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/documentos/{documentoId}',
    ...documentos,
    summary: 'Borrar el documento con su historial (propietario del documento)',
    request: { params: IdDocumento },
    responses: { 204: { description: 'Borrado' }, ...sinRol, ...sinDocumento, ...comunes },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/documentos/{documentoId}/propiedad',
    ...documentos,
    summary: 'Transferir el documento a otro miembro del espacio (el anterior queda con permiso editor)',
    request: { params: IdDocumento, body: json(TransferirSolicitud) },
    responses: {
      200: { description: 'Permisos propios del documento', ...json(ListaPermisos) },
      404: error('El documento no existe, no tienes acceso, o el destino no es miembro del espacio'),
      409: error('rol_excede_cuenta o ya_es_propietario'),
      ...sinRol,
      ...comunes,
    },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/documentos/{documentoId}/permisos',
    ...documentos,
    summary: 'Permisos propios del documento (además del rol de espacio)',
    request: { params: IdDocumento },
    responses: { 200: { description: 'Permisos', ...json(ListaPermisos) }, ...sinDocumento, ...comunes },
  });
  registro.registerPath({
    method: 'put',
    path: '/api/documentos/{documentoId}/permisos/{usuarioId}',
    ...documentos,
    summary: 'Dar "editor" sobre el documento a un miembro del espacio (propietario del documento)',
    request: { params: IdPermiso, body: json(DarPermisoSolicitud) },
    responses: {
      200: { description: 'Permisos', ...json(ListaPermisos) },
      404: error('El documento no existe, no tienes acceso, o el destino no es miembro del espacio'),
      409: error('usar_transferencia (es el propietario) o rol_excede_cuenta'),
      ...sinRol,
      ...comunes,
    },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/documentos/{documentoId}/permisos/{usuarioId}',
    ...documentos,
    summary: 'Quitar el permiso propio de un miembro (propietario del documento)',
    request: { params: IdPermiso },
    responses: {
      204: { description: 'Quitado' },
      404: error('El documento no existe, no tienes acceso, o ese permiso no existe'),
      409: error('usar_transferencia: la propiedad no se quita'),
      ...sinRol,
      ...comunes,
    },
  });
}

function registrarTiempoReal(registro: OpenAPIRegistry): void {
  registro.registerPath({
    method: 'post',
    path: '/api/tiempo-real/tickets',
    tags: ['tiempo real'],
    security: [{ acceso: [] }],
    summary:
      'Ticket de un solo uso (30 s) para abrir el WebSocket del documento: GET /api/tiempo-real con Upgrade, Origin del frontend y Sec-WebSocket-Protocol "cuaderno.v1, ticket.<valor>"',
    request: { body: json(SolicitudTicket) },
    responses: {
      201: { description: 'Ticket', ...json(TicketTiempoReal) },
      401: error('Sin sesión viva'),
      404: error('El documento no existe o no tienes acceso (no se distingue)'),
      429: error('Demasiados tickets seguidos'),
      400: error('Datos inválidos'),
    },
  });
}

function registrarVersionesYComentarios(registro: OpenAPIRegistry): void {
  const versiones = { tags: ['versiones'], security: [{ acceso: [] }] };
  const comentarios = { tags: ['comentarios'], security: [{ acceso: [] }] };
  const comunes = { 401: error('Sin sesión viva'), 400: error('Datos inválidos') };
  const sinDocumento = { 404: error('El documento no existe o no tienes acceso (no se distingue)') };
  const sinRol = { 403: error('Tu rol no alcanza') };
  const sinTiempoReal = { 503: error('El servidor de tiempo real no está disponible') };
  registro.registerPath({
    method: 'get',
    path: '/api/documentos/{documentoId}/texto',
    ...versiones,
    summary: 'El texto actual del documento (el de la memoria del servidor; para comparar con una versión)',
    request: { params: IdDocumento },
    responses: { 200: { description: 'Texto', ...json(TextoActual) }, ...sinDocumento, ...sinTiempoReal, ...comunes },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/documentos/{documentoId}/versiones',
    ...versiones,
    summary: 'Historial de versiones (cualquier rol)',
    request: { params: IdDocumento },
    responses: { 200: { description: 'Versiones', ...json(ListaVersiones) }, ...sinDocumento, ...comunes },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/documentos/{documentoId}/versiones',
    ...versiones,
    summary: 'Guardar el estado actual como versión manual (editor o propietario)',
    request: { params: IdDocumento },
    responses: { 201: { description: 'Versión creada', ...json(Version) }, ...sinRol, ...sinDocumento, 429: error('Demasiadas versiones seguidas'), ...sinTiempoReal, ...comunes },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/documentos/{documentoId}/versiones/{numero}',
    ...versiones,
    summary: 'Una versión con su texto',
    request: { params: IdVersion },
    responses: { 200: { description: 'Versión', ...json(VersionConTexto) }, 404: error('El documento o la versión no existen, o no tienes acceso'), ...comunes },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/documentos/{documentoId}/versiones/{numero}/restaurar',
    ...versiones,
    summary: 'Restaurar una versión como CAMBIO NUEVO (editor o propietario): el historial no se reescribe y queda una versión "restauracion"',
    request: { params: IdVersion },
    responses: {
      201: { description: 'Versión de la restauración', ...json(Version) },
      404: error('El documento o la versión no existen, o no tienes acceso'),
      ...sinRol,
      429: error('Demasiadas versiones seguidas'),
      ...sinTiempoReal,
      ...comunes,
    },
  });
  registro.registerPath({
    method: 'get',
    path: '/api/documentos/{documentoId}/comentarios',
    ...comentarios,
    summary: 'Comentarios del documento: hilos (con ancla) y respuestas, en orden',
    request: { params: IdDocumento },
    responses: { 200: { description: 'Comentarios', ...json(ListaComentarios) }, ...sinDocumento, ...comunes },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/documentos/{documentoId}/comentarios',
    ...comentarios,
    summary: 'Abrir un hilo anclado o responder (cualquier rol, también un lector)',
    request: { params: IdDocumento, body: json(ComentarioSolicitud) },
    responses: {
      201: { description: 'Comentario', ...json(Comentario) },
      400: error('ancla_invalida, falta_ancla, ancla_en_respuesta, respuesta_a_respuesta o datos inválidos'),
      404: error('El documento o el hilo no existen, o no tienes acceso'),
      429: error('Demasiados comentarios seguidos'),
      401: error('Sin sesión viva'),
    },
  });
  registro.registerPath({
    method: 'patch',
    path: '/api/comentarios/{comentarioId}',
    ...comentarios,
    summary: 'Editar el texto (solo quien lo escribió) o resolver/reabrir un hilo (quien lo abrió, o un editor o propietario)',
    request: { params: IdComentario, body: json(CambiarComentarioSolicitud) },
    responses: {
      200: { description: 'Comentario', ...json(Comentario) },
      400: error('resolver_respuesta o datos inválidos'),
      403: error('No es tuyo, o tu rol no alcanza para resolver'),
      404: error('El comentario no existe o no tienes acceso al documento'),
      401: error('Sin sesión viva'),
    },
  });
  registro.registerPath({
    method: 'delete',
    path: '/api/comentarios/{comentarioId}',
    ...comentarios,
    summary: 'Borrar (quien lo escribió, o el propietario del documento); un hilo se lleva sus respuestas',
    request: { params: IdComentario },
    responses: {
      204: { description: 'Borrado' },
      403: error('No es tuyo ni eres el propietario del documento'),
      404: error('El comentario no existe o no tienes acceso al documento'),
      ...comunes,
    },
  });
}

function registrarIa(registro: OpenAPIRegistry): void {
  const ia = { tags: ['ia'], security: [{ acceso: [] }] };
  // Errores de la IA (mapeo gRPC → HTTP del ADR 0002) y del tope diario.
  const errores = {
    400: error('Datos inválidos, o ia_solicitud_invalida'),
    401: error('Sin sesión viva'),
    429: error('demasiados_intentos (por minuto), tope_diario_ia (por día, Retry-After hasta la medianoche UTC) o ia_saturada'),
    502: error('ia_error_interno: el servicio de IA falló (o un error entre servicios)'),
    503: error('ia_no_disponible'),
    504: error('ia_tiempo_agotado'),
  };
  const sinDocumento = { 404: error('El documento no existe o no tienes acceso (no se distingue)') };
  const sse = {
    200: {
      description:
        'text/event-stream: `event: fragmento` {texto}, … y al final `event: fin` {tokensEntrada, tokensSalida}. Un error a mitad llega como `event: error` {codigo, mensaje}. Abortar el fetch cancela la generación.',
      content: { 'text/event-stream': { schema: { type: 'string' as const } } },
    },
  };
  registro.registerPath({
    method: 'post',
    path: '/api/ia/explicar',
    ...ia,
    summary: 'Explica un fragmento (cualquier rol con acceso al documento)',
    request: { body: json(ExplicarSolicitud) },
    responses: { 200: { description: 'Explicación', ...json(RespuestaIa) }, ...sinDocumento, ...errores },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/ia/resumir',
    ...ia,
    summary: 'Resume el contenido, en streaming (SSE sobre fetch POST; cualquier rol con acceso)',
    request: { body: json(TransformarSolicitudHttp) },
    responses: { ...sse, ...sinDocumento, ...errores },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/ia/mejorar',
    ...ia,
    summary: 'Propone una versión mejorada, en streaming (SSE; editor o propietario)',
    request: { body: json(TransformarSolicitudHttp) },
    responses: { ...sse, 403: error('Un lector no mejora texto'), ...sinDocumento, ...errores },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/espacios/{espacioId}/buscar',
    ...ia,
    summary: 'Búsqueda semántica en un espacio: solo fragmentos de ese espacio y de documentos con acceso HOY',
    request: { params: IdEspacio, body: json(BusquedaSolicitud) },
    responses: { 200: { description: 'Resultados, del más parecido al menos', ...json(ResultadosBusqueda) }, 404: error('El espacio no existe o no eres miembro'), ...errores },
  });
  registro.registerPath({
    method: 'post',
    path: '/api/documentos/{documentoId}/indice',
    ...ia,
    summary: 'Encola el indexado del documento para la búsqueda (editor o propietario)',
    request: { params: IdDocumento },
    responses: {
      202: { description: 'Encolado (uno a la vez por documento)', ...json(IndiceEncolado) },
      403: error('Un lector no indexa'),
      ...sinDocumento,
      401: error('Sin sesión viva'),
      429: error('Demasiados pedidos por minuto'),
      503: error('ia_no_disponible'),
    },
  });
}

export function generarOpenApi(): ReturnType<OpenApiGeneratorV31['generateDocument']> {
  const registro = new OpenAPIRegistry();

  registro.registerPath({
    method: 'get',
    path: '/health',
    tags: ['salud'],
    summary: 'Vivo: el proceso responde (no revisa dependencias)',
    responses: { 200: { description: 'Proceso vivo', content: { 'application/json': { schema: SaludRespuesta } } } },
  });

  registro.registerPath({
    method: 'get',
    path: '/ready',
    tags: ['salud'],
    summary: 'Listo: base, versión del esquema y Redis disponibles. La IA se muestra ("ia") pero su falla no da 503',
    responses: {
      200: { description: 'Listo para recibir tráfico', content: { 'application/json': { schema: ListoRespuesta } } },
      503: {
        description: 'Alguna dependencia falla, o el proceso se está apagando',
        content: { 'application/json': { schema: ListoRespuesta } },
      },
    },
  });

  registro.registerComponent('securitySchemes', 'tokenMetricas', { type: 'http', scheme: 'bearer' });
  registro.registerPath({
    method: 'get',
    path: '/metrics',
    tags: ['salud'],
    summary: 'Métricas Prometheus (token obligatorio en producción)',
    security: [{ tokenMetricas: [] }],
    responses: {
      200: { description: 'Métricas en formato de texto de Prometheus', content: { 'text/plain': { schema: { type: 'string' } } } },
      401: { description: 'Falta o es inválido el token', content: { 'application/json': { schema: ErrorRespuesta } } },
    },
  });

  registrarAuth(registro);
  registrarInvitaciones(registro);
  registrarMfaYRecuperacion(registro);
  registrarPerfilYDatos(registro);
  registrarEspaciosYDocumentos(registro);
  registrarTiempoReal(registro);
  registrarVersionesYComentarios(registro);
  registrarIa(registro);

  return new OpenApiGeneratorV31(registro.definitions).generateDocument({
    openapi: '3.1.0',
    info: {
      title: 'Cuaderno API',
      version: '0.1.0',
      description: 'API de Cuaderno, editor colaborativo de documentación técnica con IA. Generada desde los esquemas zod.',
    },
    servers: [{ url: 'http://127.0.0.1:4200', description: 'Desarrollo local' }],
  });
}
