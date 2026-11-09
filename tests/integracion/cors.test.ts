// CORS de /api (despliegue en orígenes distintos del mismo sitio): solo el origen de APP_URL, con
// credenciales; preflight con los métodos y cabeceras del frontend; un Origin ajeno, 403 antes de la ruta.
// Sin base ni Redis: un router de prueba basta.
import { Router } from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { CABECERAS_PERMITIDAS, MAX_AGE_PREFLIGHT_S, origenDe } from '../../src/http/cors.js';
import { APP_URL_PRUEBA, appDePrueba } from '../_apoyo.js';

const OTRO = 'https://malo.example.com';

/** El código de error de una respuesta JSON del API. */
const codigo = (cuerpo: unknown) => (cuerpo as { error: { codigo: string } }).error.codigo;

function app(appUrl?: string) {
  const llamadas: string[] = [];
  const api = Router();
  api.get('/eco', (req, res) => {
    llamadas.push('eco');
    res.setHeader('Retry-After', '5');
    res.json({ ok: true });
  });
  api.post('/eco', (_req, res) => {
    llamadas.push('post');
    res.status(201).json({ ok: true });
  });
  return { ...appDePrueba({ api, ...(appUrl ? { appUrl } : {}) }), llamadas };
}

const preflight = (a: ReturnType<typeof app>['app'], origen: string, metodo = 'POST', cabeceras = 'authorization, content-type') =>
  request(a).options('/api/eco').set('origin', origen).set('access-control-request-method', metodo).set('access-control-request-headers', cabeceras);

describe('CORS de /api', () => {
  it('preflight desde el frontend: 204 con el origen exacto, credenciales, métodos, cabeceras y Max-Age', async () => {
    const { app: a, llamadas } = app();
    const r = await preflight(a, APP_URL_PRUEBA);
    expect(r.status).toBe(204);
    expect(r.headers['access-control-allow-origin']).toBe(APP_URL_PRUEBA);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    expect(r.headers['access-control-allow-methods']).toBe('GET, POST, PUT, PATCH, DELETE');
    expect(r.headers['access-control-allow-headers']).toBe(CABECERAS_PERMITIDAS.join(', '));
    expect(r.headers['access-control-max-age']).toBe(String(MAX_AGE_PREFLIGHT_S));
    expect(r.headers.vary).toMatch(/Origin/);
    expect(llamadas).toEqual([]);
  });

  it('el avatar (content-type de imagen) y accept también pasan el preflight', async () => {
    const { app: a } = app();
    expect((await preflight(a, APP_URL_PRUEBA, 'PUT', 'accept, authorization, content-type, x-request-id')).status).toBe(204);
  });

  it('preflight con una cabecera o un método que el frontend no usa: 403', async () => {
    const { app: a } = app();
    expect((await preflight(a, APP_URL_PRUEBA, 'POST', 'authorization, x-cualquiera')).status).toBe(403);
    expect((await preflight(a, APP_URL_PRUEBA, 'TRACE', '')).status).toBe(403);
  });

  it('preflight desde otro origen: 403 sin ninguna cabecera de CORS', async () => {
    const { app: a } = app();
    const r = await preflight(a, OTRO);
    expect(r.status).toBe(403);
    expect(codigo(r.body)).toBe('origen_no_permitido');
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.headers['access-control-allow-credentials']).toBeUndefined();
  });

  it('pedido desde el frontend: origen exacto (nunca *), credenciales y las cabeceras que el frontend lee', async () => {
    const { app: a, llamadas } = app();
    const r = await request(a).get('/api/eco').set('origin', APP_URL_PRUEBA);
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(APP_URL_PRUEBA);
    expect(r.headers['access-control-allow-credentials']).toBe('true');
    expect(r.headers['access-control-expose-headers']).toBe('retry-after, content-disposition, x-request-id');
    expect(llamadas).toEqual(['eco']);
  });

  it('pedido desde otro origen (también un "null" de un iframe aislado): 403 y la ruta NO se ejecuta', async () => {
    for (const origen of [OTRO, 'null', 'http://127.0.0.1:5176']) {
      const { app: a, llamadas } = app();
      const r = await request(a).post('/api/eco').set('origin', origen).send({});
      expect(r.status, origen).toBe(403);
      expect(codigo(r.body)).toBe('origen_no_permitido');
      expect(r.headers['access-control-allow-origin']).toBeUndefined();
      expect(llamadas).toEqual([]);
    }
  });

  it('sin Origin (curl, sondas): se atiende y sin cabeceras de CORS', async () => {
    const { app: a, llamadas } = app();
    const r = await request(a).get('/api/eco');
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
    expect(llamadas).toEqual(['eco']);
  });

  it('APP_URL con "/" al final: el origen es el mismo', async () => {
    expect(origenDe('https://cuaderno.example.com/')).toBe('https://cuaderno.example.com');
    const { app: a } = app(`${APP_URL_PRUEBA}/`);
    const r = await request(a).get('/api/eco').set('origin', APP_URL_PRUEBA);
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBe(APP_URL_PRUEBA);
  });

  it('fuera de /api (sondas) no hay CORS ni rechazo por Origin', async () => {
    const { app: a } = app();
    const r = await request(a).get('/health').set('origin', OTRO);
    expect(r.status).toBe(200);
    expect(r.headers['access-control-allow-origin']).toBeUndefined();
  });
});
