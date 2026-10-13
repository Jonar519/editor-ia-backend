// Especificación OpenAPI generada desde los esquemas zod (src/http/esquemas.ts).
// `npm run openapi` la escribe en docs/openapi.json; `npm run openapi:check` falla si quedó desactualizada.
import { OpenAPIRegistry, OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { ErrorRespuesta, ListoRespuesta, SaludRespuesta } from './http/esquemas.js';

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
