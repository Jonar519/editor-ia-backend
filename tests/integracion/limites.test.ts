import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, describe, expect, it } from 'vitest';
import { crearBloqueoFantasma, crearLimitador, limitarTasa } from '../../src/auth/limites.js';
import { crearRedis } from '../../src/infra/redis.js';
import { appDePrueba, urlRedisPruebas } from '../_apoyo.js';

const redis = crearRedis(urlRedisPruebas(), () => undefined);
const prefijo = () => `prueba:${randomBytes(6).toString('hex')}:`;
afterAll(() => {
  redis.disconnect();
});

describe('limitador con Redis real (db 1)', () => {
  it('permite hasta el máximo y luego niega, con tiempo de espera', async () => {
    const lim = crearLimitador({ redis, prefijo: prefijo(), nombre: 'x', max: 3, ventanaMs: 60_000 });
    const r = [];
    for (let i = 0; i < 4; i++) r.push(await lim.consumir('ip-1'));
    expect(r.map((x) => x.permitido)).toEqual([true, true, true, false]);
    expect(r[2]?.restantes).toBe(0);
    expect(r[3]?.reintentarEnMs).toBeGreaterThan(55_000);
  });

  it('cada clave tiene su propio contador', async () => {
    const lim = crearLimitador({ redis, prefijo: prefijo(), nombre: 'x', max: 1, ventanaMs: 60_000 });
    expect((await lim.consumir('a')).permitido).toBe(true);
    expect((await lim.consumir('b')).permitido).toBe(true);
    expect((await lim.consumir('a')).permitido).toBe(false);
  });

  it('la ventana vence y vuelve a permitir', async () => {
    const lim = crearLimitador({ redis, prefijo: prefijo(), nombre: 'x', max: 1, ventanaMs: 200 });
    expect((await lim.consumir('a')).permitido).toBe(true);
    expect((await lim.consumir('a')).permitido).toBe(false);
    await new Promise((r) => setTimeout(r, 300));
    expect((await lim.consumir('a')).permitido).toBe(true);
  });

  it('el middleware responde 429 con Retry-After', async () => {
    const lim = crearLimitador({ redis, prefijo: prefijo(), nombre: 'x', max: 1, ventanaMs: 60_000 });
    const { app } = appDePrueba({ extender: (a) => a.get('/limitada', limitarTasa(lim, () => 'k'), (_req, res) => res.json({ ok: true })) });
    expect((await request(app).get('/limitada')).status).toBe(200);
    const r = await request(app).get('/limitada');
    expect(r.status).toBe(429);
    expect((r.body as { error: { codigo: string } }).error.codigo).toBe('demasiados_intentos');
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(50);
  });

  it('FALLA CERRADO: si Redis no responde, 503 (nunca deja pasar sin límite)', async () => {
    const caido = crearRedis('redis://127.0.0.1:1/1', () => undefined);
    const lim = crearLimitador({ redis: caido, prefijo: prefijo(), nombre: 'x', max: 100, ventanaMs: 60_000 });
    const { app } = appDePrueba({ extender: (a) => a.get('/limitada', limitarTasa(lim, () => 'k'), (_req, res) => res.json({ ok: true })) });
    const r = await request(app).get('/limitada');
    caido.disconnect();
    expect(r.status).toBe(503);
    expect((r.body as { error: { codigo: string } }).error.codigo).toBe('limites_no_disponibles');
  });
});

describe('bloqueo de correos inexistentes (Redis)', () => {
  it('aplica la misma política que las cuentas reales', async () => {
    const f = crearBloqueoFantasma(redis, prefijo());
    const correo = 'nadie@example.com';
    for (let i = 1; i <= 4; i++) expect((await f.registrarFallo(correo)).hasta).toBeNull();
    const quinto = await f.registrarFallo(correo);
    expect(quinto.fallos).toBe(5);
    expect(quinto.hasta?.getTime()).toBeGreaterThan(Date.now() + 55_000);
    expect((await f.leer(correo)).hasta?.getTime()).toBe(quinto.hasta?.getTime());
  });
});
