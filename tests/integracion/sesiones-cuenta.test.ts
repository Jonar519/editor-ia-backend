// Sesiones activas de la cuenta (IP truncada, ubicación aproximada, user-agent corto; cerrar una o las
// demás) y los proveedores de ubicación, contra la base de PRUEBAS y Redis db 1.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { geoMock, geoTablaLocal } from '../../src/geo/proveedor.js';
import { appApi, cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';

interface Sesion {
  id: string;
  actual: boolean;
  ipRed: string | null;
  ubicacion: string | null;
  userAgent: string | null;
}

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});

async function entrar(app: ReturnType<typeof appApi>, c: { correo: string; contrasena: string }, ua: string): Promise<string> {
  const r = await request(app).post('/api/auth/sesion').set('user-agent', ua).send({ correo: c.correo, contrasena: c.contrasena });
  expect(r.status).toBe(201);
  return (r.body as { accessToken: string }).accessToken;
}

const FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0';
const CHROME_ANDROID = 'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36';

describe('sesiones de la cuenta', () => {
  it('lista las sesiones vivas con IP truncada, ubicación aproximada y user-agent corto; marca la actual', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const a = await entrar(app, c, FIREFOX);
    await entrar(app, c, CHROME_ANDROID);
    const r = await request(app).get('/api/cuenta/sesiones').set('authorization', `Bearer ${a}`);
    expect(r.status).toBe(200);
    const sesiones = (r.body as { sesiones: Sesion[] }).sesiones;
    expect(sesiones).toHaveLength(2);
    expect(sesiones.filter((s) => s.actual)).toHaveLength(1);
    expect(sesiones.find((s) => s.actual)?.userAgent).toBe('Firefox · Windows');
    expect(sesiones.map((s) => s.userAgent).sort()).toEqual(['Chrome · Android', 'Firefox · Windows']);
    for (const s of sesiones) {
      // Supertest conecta por loopback: la red truncada es 127.0.0.0/24 (o 0:0:0::/48 si es ::1) y el mock
      // dice "Red local".
      expect(s.ipRed).toMatch(/^(127\.0\.0\.0\/24|0:0:0::\/48)$/);
      expect(s.ubicacion).toBe('Red local');
    }
    expect(JSON.stringify(r.body)).not.toMatch(/token|refresh/i);
  });

  it('cerrar UNA sesión corta su access token en la petición siguiente; la actual sigue', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const a = await entrar(app, c, FIREFOX);
    const b = await entrar(app, c, CHROME_ANDROID);
    const lista = (await request(app).get('/api/cuenta/sesiones').set('authorization', `Bearer ${a}`)).body as { sesiones: Sesion[] };
    const otra = lista.sesiones.find((s) => !s.actual);
    expect(otra).toBeDefined();
    expect((await request(app).delete(`/api/cuenta/sesiones/${otra?.id ?? ''}`).set('authorization', `Bearer ${a}`)).status).toBe(204);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${b}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${a}`)).status).toBe(200);
    expect(await e.prisma.eventos_seguridad.count({ where: { usuario_id: c.id, tipo: 'sesion_cerrada' } })).toBe(1);
    // La lista ya no la muestra: solo sesiones vivas.
    const despues = (await request(app).get('/api/cuenta/sesiones').set('authorization', `Bearer ${a}`)).body as { sesiones: Sesion[] };
    expect(despues.sesiones.map((s) => s.id)).not.toContain(otra?.id);
    expect(despues.sesiones).toHaveLength(1);
  });

  it('no se puede cerrar la sesión de OTRA cuenta (404, y sigue viva)', async () => {
    const app = appApi(e.deps);
    const yo = await cuentaActiva(e.prisma);
    const otra = await cuentaActiva(e.prisma);
    const mio = await entrar(app, yo, FIREFOX);
    const suyo = await entrar(app, otra, FIREFOX);
    const suya = ((await request(app).get('/api/cuenta/sesiones').set('authorization', `Bearer ${suyo}`)).body as { sesiones: Sesion[] }).sesiones[0];
    const r = await request(app).delete(`/api/cuenta/sesiones/${suya?.id ?? ''}`).set('authorization', `Bearer ${mio}`);
    expect(r.status).toBe(404);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${suyo}`)).status).toBe(200);
  });

  it('cerrar las DEMÁS: todas menos la actual', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const a = await entrar(app, c, FIREFOX);
    const b = await entrar(app, c, CHROME_ANDROID);
    const d = await entrar(app, c, CHROME_ANDROID);
    const r = await request(app).post('/api/cuenta/sesiones/cerrar-otras').set('authorization', `Bearer ${a}`);
    expect(r.body).toEqual({ cerradas: 2 });
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${b}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${d}`)).status).toBe(401);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${a}`)).status).toBe(200);
  });
});

describe('ubicación aproximada', () => {
  it('mock: red local o texto fijo; nunca ve la IP completa', async () => {
    const g = geoMock();
    expect(await g.ubicar(null)).toBeNull();
    expect(await g.ubicar('192.168.1.0/24')).toBe('Red local');
    expect(await g.ubicar('0:0:0::/48')).toBe('Red local');
    expect(await g.ubicar('fd12:3456:789a::/48')).toBe('Red local');
    expect(await g.ubicar('203.0.113.0/24')).toBe('Ubicación simulada');
  });

  it('tabla_local: busca la red truncada en rangos_ip_geo', async () => {
    // Rango de documentación (RFC 5737), propio de esta prueba.
    await e.prisma.$executeRaw`DELETE FROM rangos_ip_geo WHERE red = '198.51.100.0/24'::cidr`;
    await e.prisma.$executeRaw`INSERT INTO rangos_ip_geo (red, pais, region, ciudad) VALUES ('198.51.100.0/24', 'MX', 'Región Ficticia', 'Ciudad Ficticia')`;
    try {
      const g = geoTablaLocal(e.prisma);
      expect(await g.ubicar('198.51.100.0/24')).toBe('Ciudad Ficticia, Región Ficticia, MX');
      expect(await g.ubicar('203.0.113.0/24')).toBeNull();
      expect(await g.ubicar('10.1.2.0/24')).toBe('Red local');
    } finally {
      await e.prisma.$executeRaw`DELETE FROM rangos_ip_geo WHERE red = '198.51.100.0/24'::cidr`;
    }
  });
});
