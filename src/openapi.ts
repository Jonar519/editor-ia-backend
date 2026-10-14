// Especificación OpenAPI generada desde los esquemas zod (src/http/esquemas.ts).
// `npm run openapi` la escribe en docs/openapi.json; `npm run openapi:check` falla si quedó desactualizada.
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import {
  CompletarInvitacion,
  ErrorRespuesta,
  IdUsuario,
  InicioSesionSolicitud,
  InvitacionConsulta,
  InvitacionCreada,
  InvitacionSolicitud,
  ListaInvitaciones,
  ListoRespuesta,
  PaginaListado,
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
      401: error('Correo o contraseña incorrectos'),
      403: error('La cuenta usa MFA (desafío TOTP: bloque F)'),
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
    request: { body: json(CompletarInvitacion) },
    responses: {
      201: { description: 'Cuenta activa y sesión abierta (fija la cookie de refresco)', ...json(SesionRespuesta) },
      404: error('Enlace inválido o usado'),
      409: error('Cuenta admin: se completa con MFA (bloque F)'),
      410: error('Enlace vencido'),
      ...ERRORES_COMUNES,
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
    summary: 'Listo: base, versión del esquema y Redis disponibles',
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
