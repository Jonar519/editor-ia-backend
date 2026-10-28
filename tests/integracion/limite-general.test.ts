// Límite general de /api por cuenta (riesgo R-07, bloque R): 429 con Retry-After al pasarse, 503 si
// Redis no responde (falla cerrado), sin contar los pedidos sin token y sin tocar /health ni el WebSocket.
// Base de PRUEBAS y Redis db 1; el límite se baja a 5 para no mandar 600 pedidos.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITE_GENERAL } from '../../src/auth/limites.js';
import { cargarConfig } from '../../src/config/entorno.js';
import { crearRedis } from '../../src/infra/redis.js';
import { accesoDirecto, appApi, cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';
import { conectar, esperar, levantar, type Entorno } from '../_tiempo-real.js';

const MAX = 5;
let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi({ limitePedidosMinuto: MAX });
});
afterAll(async () => {
  await e.cerrar();
});

const persona = async () => {
  const c = await cuentaActiva(e.prisma);
  return `Bearer ${(await accesoDirecto(e.deps, c.id)).token}`;
};

describe('límite general por cuenta (R-07)', () => {
  it('producción: 600 pedidos por minuto, y es el valor por defecto de LIMITE_PEDIDOS_MINUTO', () => {
    expect(LIMITE_GENERAL).toEqual({ max: 600, ventanaMs: 60_000 });
    expect(cargarConfig({ DATABASE_URL: 'postgresql://x@127.0.0.1/x', REDIS_URL: 'redis://127.0.0.1:6381', MFA_ENCRYPTION_KEY: Buffer.alloc(32, 1).toString('base64'), ACCESS_TOKEN_SECRET: Buffer.alloc(32, 2).toString('base64') }).LIMITE_PEDIDOS_MINUTO).toBe(600);
  });

  it('al pasarse: 429 demasiados_intentos con Retry-After, en CUALQUIER ruta de /api', async () => {
    const app = appApi(e.deps);
    const auth = await persona();
    for (let i = 0; i < MAX; i++) expect((await request(app).get('/api/espacios').set('authorization', auth)).status).toBe(200);
    const r = await request(app).get('/api/cuenta/sesiones').set('authorization', auth);
    expect(r.status).toBe(429);
    expect((r.body as { error: { codigo: string } }).error.codigo).toBe('demasiados_intentos');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(50);
  });

  it('cada cuenta tiene su propio contador', async () => {
    const app = appApi(e.deps);
    const a = await persona();
    const b = await persona();
    for (let i = 0; i < MAX; i++) await request(app).get('/api/espacios').set('authorization', a);
    expect((await request(app).get('/api/espacios').set('authorization', a)).status).toBe(429);
    expect((await request(app).get('/api/espacios').set('authorization', b)).status).toBe(200);
  });

  it('sin token (o con uno inválido) no cuenta: responde 401, nunca 429', async () => {
    const app = appApi(e.deps);
    for (let i = 0; i < MAX + 3; i++) {
      expect((await request(app).get('/api/espacios')).status).toBe(401);
      expect((await request(app).get('/api/espacios').set('authorization', 'Bearer no.es.un.token')).status).toBe(401);
    }
  });

  it('FALLA CERRADO: si Redis no responde, 503 limites_no_disponibles', async () => {
    const caido = crearRedis('redis://127.0.0.1:1/1', () => undefined);
    const app = appApi({ ...e.deps, redis: caido });
    const r = await request(app).get('/api/espacios').set('authorization', await persona());
    caido.disconnect();
    expect(r.status).toBe(503);
    expect((r.body as { error: { codigo: string } }).error.codigo).toBe('limites_no_disponibles');
  });
});

describe('límite general: lo que queda fuera', () => {
  let t: Entorno;
  beforeAll(async () => {
    t = await levantar({ avisos: false, api: { limitePedidosMinuto: MAX } });
  });
  afterAll(async () => {
    await t.cerrar();
  });

  it('con el límite agotado, /health responde y el WebSocket ya abierto sigue editando', async () => {
    const ana = await t.persona();
    const bruno = await t.persona();
    // 3 pedidos de ana (espacio, miembro, documento) y 1 de su ticket: queda 1 hasta el límite.
    const { documentoId } = await t.documentoCon(ana, [[bruno, 'editor']]);
    const proto = async (p: typeof ana) => ['cuaderno.v1', `ticket.${await t.ticket(p, documentoId)}`];
    const a = conectar(t.url, await proto(ana));
    const b = conectar(t.url, await proto(bruno));
    expect((await request(t.app).get('/api/espacios').set('authorization', ana.auth)).status).toBe(200);
    expect((await request(t.app).get('/api/espacios').set('authorization', ana.auth)).status).toBe(429);
    for (let i = 0; i < 3; i++) expect((await request(t.app).get('/health')).status).toBe(200);
    await Promise.all([a.abierto, b.abierto]);
    // Muchos más mensajes que el límite: el WebSocket no pasa por él, y lo que escribe ana le llega a bruno.
    for (let i = 0; i < MAX * 4; i++) a.escribir('x');
    await esperar(() => b.texto.length === MAX * 4);
    a.ws.close();
    b.ws.close();
  });
});
