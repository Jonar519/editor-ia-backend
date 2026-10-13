import type pg from 'pg';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { comprobacionBd, comprobacionEsquema, crearPool, ESQUEMA_MINIMO } from '../../src/infra/bd.js';
import type { ListoRespuesta } from '../../src/http/esquemas.js';
import { comprobacionRedis, crearRedis } from '../../src/infra/redis.js';
import { appDePrueba, comprobacionFalla, comprobacionOk, urlBdPruebas, urlRedisPruebas } from '../_apoyo.js';

describe('/health y /ready con dependencias reales (base de pruebas, Redis db 1)', () => {
  let pool: pg.Pool;
  let redis: ReturnType<typeof crearRedis>;

  beforeAll(() => {
    pool = crearPool(urlBdPruebas());
    redis = crearRedis(urlRedisPruebas());
  });
  afterAll(async () => {
    await pool.end();
    redis.disconnect();
  });

  it('/health responde 200 aunque las dependencias fallen', async () => {
    const { app } = appDePrueba({ comprobaciones: [comprobacionFalla('bd')] });
    const r = await request(app).get('/health');
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ estado: 'ok' });
  });

  it('/ready 200 con base, esquema y Redis reales', async () => {
    const { app } = appDePrueba({ comprobaciones: [comprobacionBd(pool), comprobacionEsquema(pool), comprobacionRedis(redis)] });
    const r = await request(app).get('/ready');
    expect(r.body).toEqual({ estado: 'listo', comprobaciones: { bd: 'ok', esquema: 'ok', redis: 'ok' } });
    expect(r.status).toBe(200);
  });

  it('/ready 503 si Redis no responde (y no filtra el motivo)', async () => {
    const caido = crearRedis('redis://127.0.0.1:1/1');
    const { app, lineas } = appDePrueba({ comprobaciones: [comprobacionBd(pool), comprobacionRedis(caido)] });
    const r = await request(app).get('/ready');
    caido.disconnect();
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ estado: 'no_listo', comprobaciones: { bd: 'ok', redis: 'falla' } });
    expect(lineas.some((l) => l.comprobacion === 'redis')).toBe(true);
  });

  it('/ready 503 si la base no responde', async () => {
    const malo = crearPool('postgresql://cuaderno_app:x@127.0.0.1:1/cuaderno_test');
    const { app } = appDePrueba({ comprobaciones: [comprobacionBd(malo)] });
    const r = await request(app).get('/ready');
    await malo.end();
    expect(r.status).toBe(503);
    expect((r.body as ListoRespuesta).comprobaciones).toEqual({ bd: 'falla' });
  });

  it('/ready 503 si el esquema está por detrás del mínimo que necesita el backend', async () => {
    const { app } = appDePrueba({ comprobaciones: [comprobacionEsquema(pool, ESQUEMA_MINIMO + 1)] });
    const r = await request(app).get('/ready');
    expect(r.status).toBe(503);
    expect((r.body as ListoRespuesta).comprobaciones).toEqual({ esquema: 'falla' });
  });

  it('/ready 503 si una dependencia se cuelga (límite por comprobación)', async () => {
    const colgada = { nombre: 'lenta', comprobar: () => new Promise<void>(() => undefined) };
    const { app } = appDePrueba({ comprobaciones: [comprobacionOk('bd'), colgada] });
    const inicio = Date.now();
    const r = await request(app).get('/ready');
    expect(r.status).toBe(503);
    expect((r.body as ListoRespuesta).comprobaciones).toEqual({ bd: 'ok', lenta: 'falla' });
    expect(Date.now() - inicio).toBeLessThan(5000);
  });

  it('/ready 503 "apagando" en cuanto empieza el apagado', async () => {
    const { app } = appDePrueba({ estado: { apagando: true } });
    const r = await request(app).get('/ready');
    expect(r.status).toBe(503);
    expect(r.body).toEqual({ estado: 'apagando', comprobaciones: {} });
  });
});
