// OpenAPI revisado ruta por ruta (bloque R7): toda ruta de Express está documentada (y nada documentado deja
// de existir), toda operación de /api trae los errores comunes de su cadena de middlewares (429 con
// Retry-After y 503 siempre; 401 con sesión; 400 con datos; 413 y 415 con cuerpo), y /health, /ready y /metrics
// quedan fuera de esos errores a propósito.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { generarOpenApi } from '../../src/openapi.js';

const SRC = path.join(import.meta.dirname, '..', '..', 'src');
const leer = (archivo: string) => readFileSync(path.join(SRC, archivo), 'utf8');

/**
 * Dónde se monta cada router (src/api.ts y src/app.ts). La prueba comprueba que el montaje exista tal cual,
 * así que si cambia api.ts esta tabla no puede quedar vieja sin que falle.
 */
const MONTAJES = [
  { archivo: 'auth/rutas.ts', funcion: 'rutasAuth', prefijo: '/api/auth', montaje: "api.use('/auth', rutasAuth(d))" },
  { archivo: 'invitaciones/rutas.ts', funcion: 'rutasInvitacionPublica', prefijo: '/api/invitaciones', montaje: "api.use('/invitaciones', rutasInvitacionPublica(d))" },
  { archivo: 'cuenta/rutas.ts', funcion: 'rutasCuenta', prefijo: '/api/cuenta', montaje: "api.use('/cuenta', rutasCuenta(d))" },
  { archivo: 'usuarios/rutas.ts', funcion: 'rutasUsuarios', prefijo: '/api/usuarios', montaje: "api.use('/usuarios', rutasUsuarios(d))" },
  { archivo: 'invitaciones/rutas.ts', funcion: 'rutasAdminInvitaciones', prefijo: '/api/admin/invitaciones', montaje: "api.use('/admin/invitaciones', rutasAdminInvitaciones(d))" },
  { archivo: 'ia/rutas.ts', funcion: 'rutasIa', receptor: 'ia', prefijo: '/api/ia', montaje: "api.use('/ia', ia.ia)" },
  { archivo: 'ia/rutas.ts', funcion: 'rutasIa', receptor: 'busqueda', prefijo: '/api/espacios', montaje: "api.use('/espacios', ia.busqueda)" },
  { archivo: 'ia/rutas.ts', funcion: 'rutasIa', receptor: 'indice', prefijo: '/api/documentos', montaje: "api.use('/documentos', ia.indice)" },
  { archivo: 'espacios/rutas.ts', funcion: 'rutasEspacios', prefijo: '/api/espacios', montaje: "api.use('/espacios', rutasEspacios(d))" },
  { archivo: 'documentos/rutas.ts', funcion: 'rutasDocumentos', prefijo: '/api/documentos', montaje: "api.use('/documentos', rutasDocumentos(d))" },
  { archivo: 'versiones/rutas.ts', funcion: 'rutasVersiones', prefijo: '/api/documentos', montaje: "api.use('/documentos', rutasVersiones(d))" },
  { archivo: 'comentarios/rutas.ts', funcion: 'rutasComentariosDeDocumento', prefijo: '/api/documentos', montaje: "api.use('/documentos', rutasComentariosDeDocumento(d))" },
  { archivo: 'comentarios/rutas.ts', funcion: 'rutasComentarios', prefijo: '/api/comentarios', montaje: "api.use('/comentarios', rutasComentarios(d))" },
  { archivo: 'tiempo-real/rutas.ts', funcion: 'rutasTiempoReal', prefijo: '/api/tiempo-real', montaje: "api.use('/tiempo-real', rutasTiempoReal(d))" },
] as const;

/** El cuerpo de una función exportada (hasta la siguiente `export function` o el fin del archivo). */
function cuerpoDe(texto: string, funcion: string): string {
  const inicio = texto.indexOf(`export function ${funcion}(`);
  if (inicio < 0) throw new Error(`no encontré ${funcion}`);
  const fin = texto.indexOf('export function ', inicio + 1);
  return texto.slice(inicio, fin < 0 ? undefined : fin);
}

/** "METODO /ruta/{param}" de cada ruta de Express de los routers montados. */
function rutasDeExpress(): Set<string> {
  const api = leer('api.ts');
  const rutas = new Set<string>();
  for (const m of MONTAJES) {
    expect(api, `montaje de ${m.funcion}`).toContain(m.montaje);
    const receptor = 'receptor' in m ? m.receptor : 'r';
    const patron = new RegExp(`\\b${receptor}\\.(get|post|put|patch|delete)\\(\\s*'([^']+)'`, 'g');
    for (const [, metodo, ruta] of cuerpoDe(leer(m.archivo), m.funcion).matchAll(patron)) {
      const completa = `${m.prefijo}${ruta === '/' ? '' : (ruta ?? '')}`.replace(/:([A-Za-z]+)/g, '{$1}');
      rutas.add(`${(metodo ?? '').toUpperCase()} ${completa}`);
    }
  }
  for (const [, ruta] of leer('http/salud.ts').matchAll(/\br\.get\(\s*'([^']+)'/g)) rutas.add(`GET ${ruta ?? ''}`);
  return rutas;
}

const doc = generarOpenApi();
type Respuestas = Record<string, { description: string; headers?: Record<string, unknown> }>;
interface Op {
  security?: Record<string, string[]>[];
  parameters?: unknown[];
  requestBody?: { content?: Record<string, unknown> };
  responses: Respuestas;
}
const operaciones = Object.entries(doc.paths ?? {}).flatMap(([ruta, item]) =>
  (['get', 'post', 'put', 'patch', 'delete'] as const).flatMap((m) => {
    const op = (item as Partial<Record<string, Op>>)[m];
    return op ? [{ clave: `${m.toUpperCase()} ${ruta}`, ruta, op }] : [];
  }),
);

describe('OpenAPI: cobertura de rutas', () => {
  it('toda ruta de Express está documentada y no hay operaciones documentadas que no existan', () => {
    const express = rutasDeExpress();
    expect(express.size).toBeGreaterThan(60); // control: de verdad se leyeron las rutas
    expect([...express].sort()).toEqual(operaciones.map((o) => o.clave).sort());
  });
});

describe('OpenAPI: errores comunes de /api', () => {
  const deApi = operaciones.filter((o) => o.ruta.startsWith('/api/'));

  it('toda operación de /api: 429 con Retry-After y 503 limites_no_disponibles', () => {
    for (const { clave, op } of deApi) {
      expect(op.responses['429']?.headers, clave).toHaveProperty('Retry-After');
      expect(op.responses['503']?.description, clave).toContain('limites_no_disponibles');
    }
    expect(doc.components?.headers).toHaveProperty('RetryAfter');
  });

  it('con sesión, 401 y el límite general en el 429', () => {
    const conSesion = deApi.filter(({ op }) => (op.security ?? []).some((s) => 'acceso' in s));
    expect(conSesion.length).toBeGreaterThan(40);
    for (const { clave, op } of conSesion) {
      expect(op.responses['401'], clave).toBeDefined();
      expect(op.responses['429']?.description, clave).toContain('600 pedidos por minuto');
    }
  });

  it('con datos, 400; con cuerpo JSON, 413 y 415; con cualquier cuerpo, 415', () => {
    for (const { clave, op } of deApi) {
      const json = op.requestBody?.content?.['application/json'] !== undefined;
      if (json || (op.parameters?.length ?? 0) > 0) expect(op.responses['400'], clave).toBeDefined();
      if (json) expect(op.responses['413']?.description, clave).toContain('100 kB');
      if (op.requestBody) expect(op.responses['415']?.description, clave).toContain('codificacion_no_admitida');
    }
  });

  it('las corrientes SSE describen fragmento, fin, error y el latido', () => {
    for (const ruta of ['/api/ia/resumir', '/api/ia/mejorar']) {
      const d = (doc.paths?.[ruta] as { post: Op }).post.responses['200']?.description ?? '';
      for (const parte of ['`fragmento`', '`fin`', '`error`', 'latido']) expect(d, `${ruta} ${parte}`).toContain(parte);
    }
  });

  it('/health, /ready y /metrics: fuera de /api, sin los errores comunes', () => {
    for (const ruta of ['/health', '/ready', '/metrics']) {
      const op = (doc.paths?.[ruta] as { get: Op & { description?: string } }).get;
      expect(op.description, ruta).toContain('Fuera de /api');
      expect(op.responses['429'], ruta).toBeUndefined();
    }
  });
});
