import { gzipSync } from 'node:zlib';
import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { ErrorHttp } from '../../src/http/errores.js';
import { appDePrueba } from '../_apoyo.js';

interface CuerpoError {
  error: { codigo: string; mensaje: string; solicitud: string; detalles?: unknown };
}

describe('HTTP: formato de errores y seguridad básica', () => {
  it('404 en JSON con código, mensaje e id de solicitud', async () => {
    const { app } = appDePrueba();
    const r = await request(app).get('/no-existe');
    expect(r.status).toBe(404);
    expect(r.body).toEqual({ error: { codigo: 'no_encontrado', mensaje: 'Ruta no encontrada', solicitud: r.headers['x-request-id'] } });
  });

  it('JSON mal formado → 400 json_invalido', async () => {
    const { app } = appDePrueba({ extender: (a) => a.post('/eco', (req, res) => res.json(req.body)) });
    const r = await request(app).post('/eco').set('content-type', 'application/json').send('{"roto":');
    expect(r.status).toBe(400);
    expect((r.body as CuerpoError).error.codigo).toBe('json_invalido');
  });

  it('cuerpo JSON comprimido (Content-Encoding: gzip) → 415 sin descomprimirlo (GHSA-27r3-jxmh-p828)', async () => {
    const { app } = appDePrueba({ extender: (a) => a.post('/eco', (req, res) => res.json(req.body)) });
    const comprimido = gzipSync(Buffer.from('{"saludo":"hola"}'));
    const r = await request(app).post('/eco').set('content-type', 'application/json').set('content-encoding', 'gzip').send(comprimido);
    expect(r.status).toBe(415);
    expect((r.body as CuerpoError).error.codigo).toBe('codificacion_no_admitida');
    // Sin comprimir, el mismo cuerpo pasa.
    const plano = await request(app).post('/eco').set('content-type', 'application/json').send('{"saludo":"hola"}');
    expect(plano.body).toEqual({ saludo: 'hola' });
  });

  it('cuerpo de más de 100 kB → 413', async () => {
    const { app } = appDePrueba({ extender: (a) => a.post('/eco', (req, res) => res.json(req.body)) });
    const r = await request(app).post('/eco').send({ texto: 'x'.repeat(110 * 1024) });
    expect(r.status).toBe(413);
    expect((r.body as CuerpoError).error.codigo).toBe('cuerpo_demasiado_grande');
  });

  it('ErrorHttp conserva estado, código y detalles', async () => {
    const { app } = appDePrueba({
      extender: (a) =>
        a.get('/prohibido', () => {
          throw new ErrorHttp(403, 'sin_permiso', 'No puedes', { recurso: 'doc' });
        }),
    });
    const r = await request(app).get('/prohibido');
    expect(r.status).toBe(403);
    expect((r.body as CuerpoError).error).toMatchObject({ codigo: 'sin_permiso', mensaje: 'No puedes', detalles: { recurso: 'doc' } });
  });

  it('un error inesperado → 500 genérico, sin mensaje ni pila; el detalle va solo al log', async () => {
    const { app, lineas } = appDePrueba({
      extender: (a) =>
        a.get('/explota', () => {
          throw new Error('contraseña de la base: hunter2');
        }),
    });
    const r = await request(app).get('/explota');
    expect(r.status).toBe(500);
    expect((r.body as CuerpoError).error).toMatchObject({ codigo: 'interno', mensaje: 'Error interno' });
    expect(JSON.stringify(r.body)).not.toContain('hunter2');
    expect(r.text).not.toMatch(/at .*\.ts/);
    expect(lineas.some((l) => l.msg === 'error no controlado')).toBe(true);
  });

  it('cabeceras de seguridad (helmet) y sin x-powered-by', async () => {
    const { app } = appDePrueba();
    const r = await request(app).get('/health');
    expect(r.headers['x-content-type-options']).toBe('nosniff');
    expect(r.headers['content-security-policy']).toBeDefined();
    expect(r.headers['x-powered-by']).toBeUndefined();
  });

  it('id de solicitud: acepta uno válido y reemplaza uno peligroso', async () => {
    const { app } = appDePrueba();
    const valido = await request(app).get('/health').set('x-request-id', 'prueba-1234-abcd');
    expect(valido.headers['x-request-id']).toBe('prueba-1234-abcd');
    const malo = await request(app).get('/health').set('x-request-id', '<script>alert(1)</script> {"nivel":"falso"}');
    expect(malo.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    const largo = await request(app).get('/health').set('x-request-id', 'a'.repeat(65));
    expect(largo.headers['x-request-id']).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('el log nunca guarda Authorization ni cookies', async () => {
    const { app, lineas } = appDePrueba();
    await request(app).get('/no-existe').set('authorization', 'Bearer token-secreto-123').set('cookie', 'refresco=secreto-456');
    const texto = JSON.stringify(lineas);
    expect(texto).not.toContain('token-secreto-123');
    expect(texto).not.toContain('secreto-456');
    expect(texto).toContain('[REDACTADO]');
  });
});

describe('/metrics', () => {
  it('expone métricas por defecto y la duración por PATRÓN de ruta', async () => {
    const { app } = appDePrueba({ extender: (a) => a.get('/doc/:id', (_req, res) => res.json({})) });
    await request(app).get('/doc/123');
    await request(app).get('/doc/456');
    const r = await request(app).get('/metrics');
    expect(r.status).toBe(200);
    expect(r.text).toContain('cuaderno_process_cpu_user_seconds_total');
    expect(r.text).toMatch(/cuaderno_http_duracion_segundos_count\{metodo="GET",ruta="\/doc\/:id",estado="200"\} 2/);
    expect(r.text).not.toContain('/doc/123');
  });

  it('la ruta lleva el prefijo de su router también cuando termina en error (next(err))', async () => {
    // Como el API: /api y, adentro, un router por recurso. Al salir de un router con un error, Express
    // restaura req.baseUrl antes de que se responda.
    const espacios = express.Router();
    espacios.get('/', (_req, res) => res.json([]));
    espacios.get('/:id', (req) => {
      throw new ErrorHttp(404, 'no_encontrado', `No existe ${req.params.id}`);
    });
    const auth = express.Router();
    auth.post('/refresco', () => {
      throw new ErrorHttp(401, 'no_autenticado', 'Sin refresco');
    });
    const api = express.Router();
    api.use('/espacios', espacios);
    api.use('/auth', auth);
    const { app } = appDePrueba({ api });
    expect((await request(app).post('/api/auth/refresco')).status).toBe(401);
    expect((await request(app).get('/api/espacios/e1')).status).toBe(404);
    expect((await request(app).get('/api/espacios')).status).toBe(200);
    const r = await request(app).get('/metrics');
    expect(r.text).toMatch(/cuaderno_http_duracion_segundos_count\{metodo="POST",ruta="\/api\/auth\/refresco",estado="401"\} 1/);
    expect(r.text).toMatch(/cuaderno_http_duracion_segundos_count\{metodo="GET",ruta="\/api\/espacios\/:id",estado="404"\} 1/);
    // Una ruta '/' es el patrón tal cual de Express: el prefijo y la barra.
    expect(r.text).toMatch(/cuaderno_http_duracion_segundos_count\{metodo="GET",ruta="\/api\/espacios\/",estado="200"\} 1/);
    expect(r.text).not.toMatch(/ruta="\/refresco"|ruta="\/:id"/);
  });

  it('con token configurado: 401 sin token o con uno incorrecto, 200 con el correcto', async () => {
    const token = 'z'.repeat(40);
    const { app } = appDePrueba({ tokenMetricas: token });
    expect((await request(app).get('/metrics')).status).toBe(401);
    expect((await request(app).get('/metrics').set('authorization', `Bearer ${'y'.repeat(40)}`)).status).toBe(401);
    expect((await request(app).get('/metrics').set('authorization', `Bearer ${token}`)).status).toBe(200);
  });
});
