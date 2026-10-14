// Sesión de punta a punta contra la base de PRUEBAS y Redis db 1.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearSenuelo, hashearContrasena } from '../../src/auth/contrasenas.js';
import { crearRedis } from '../../src/infra/redis.js';
import {
  accesoDirecto,
  APP_URL,
  appApi,
  cookieRefresco,
  correoUnico,
  cuentaActiva,
  entornoApi,
  setCookieRefresco,
  type EntornoApi,
} from '../_api.js';

interface CuerpoError {
  error: { codigo: string; mensaje: string };
}
interface CuerpoSesion {
  accessToken: string;
  expiraEn: number;
  usuario: { id: string; correo: string; rol: string };
}

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});

const login = (app: ReturnType<typeof appApi>, correo: string, contrasena: string) =>
  request(app).post('/api/auth/sesion').send({ correo, contrasena });

describe('POST /api/auth/sesion (login)', () => {
  it('entrega access token (15 min) en el cuerpo y el refresh SOLO en una cookie httpOnly, Secure, SameSite=Strict, Path=/api/auth', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const r = await login(app, c.correo.toUpperCase(), c.contrasena);
    expect(r.status).toBe(201);
    const s = r.body as CuerpoSesion;
    expect(s.usuario).toMatchObject({ id: c.id, correo: c.correo, rol: 'editor' });
    expect(s.expiraEn - Math.floor(Date.now() / 1000)).toBeGreaterThan(890);
    expect(s.expiraEn - Math.floor(Date.now() / 1000)).toBeLessThanOrEqual(900);
    const cookie = setCookieRefresco(r.headers) ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).toMatch(/Secure/);
    expect(cookie).toMatch(/SameSite=Strict/);
    expect(cookie).toMatch(/Path=\/api\/auth/);
    expect(JSON.stringify(r.body)).not.toContain(cookieRefresco(r.headers) ?? 'x');
    // Una respuesta con tokens no se guarda en caché (navegador ni proxies).
    expect(r.headers['cache-control']).toBe('no-store');
    const yo = await request(app).get('/api/auth/yo').set('authorization', `Bearer ${s.accessToken}`);
    expect(yo.status).toBe(200);
  });

  it('misma respuesta con contraseña incorrecta, correo inexistente o cuenta pendiente', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const pendiente = correoUnico('pendiente');
    await e.prisma.usuarios.create({ data: { correo: pendiente, nombre: 'Pendiente', rol: 'editor' } });
    const respuestas = [
      await login(app, c.correo, 'una contraseña que no es'),
      await login(app, correoUnico('nadie'), 'una contraseña que no es'),
      await login(app, pendiente, 'una contraseña que no es'),
    ];
    for (const r of respuestas) {
      expect(r.status).toBe(401);
      expect((r.body as CuerpoError).error).toMatchObject({ codigo: 'credenciales_invalidas', mensaje: 'Correo o contraseña incorrectos' });
    }
  });

  it('bloqueo progresivo: 5 fallos bloquean (aun con la contraseña correcta) y el bloqueo se ve igual si el correo no existe', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const fantasma = correoUnico('fantasma');
    for (let i = 0; i < 5; i++) {
      expect((await login(app, c.correo, 'mala-contraseña-123')).status).toBe(401);
      expect((await login(app, fantasma, 'mala-contraseña-123')).status).toBe(401);
    }
    const real = await login(app, c.correo, c.contrasena);
    const falso = await login(app, fantasma, 'cualquiera-123456');
    for (const r of [real, falso]) {
      expect(r.status).toBe(429);
      expect((r.body as CuerpoError).error.codigo).toBe('cuenta_bloqueada');
      expect(Number(r.headers['retry-after'])).toBeGreaterThan(50);
      expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(60);
    }
    const u = await e.prisma.usuarios.findUniqueOrThrow({ where: { id: c.id } });
    expect(u.fallos_login).toBe(5);
    expect(u.bloqueada_hasta?.getTime()).toBeGreaterThan(Date.now());
  });

  it('un login correcto reinicia el contador de fallos', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    for (let i = 0; i < 3; i++) await login(app, c.correo, 'mala-contraseña-123');
    expect((await login(app, c.correo, c.contrasena)).status).toBe(201);
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: c.id } })).fallos_login).toBe(0);
  });

  it('tarda lo mismo exista o no el correo (verifica contra un hash señuelo del mismo costo)', async () => {
    // Costo 15 (el de producción, ~50 ms): scrypt domina el tiempo de la petición y saltarse el
    // señuelo para un correo inexistente se nota claramente. Con costo 13 (~12 ms) el ruido de HTTP y
    // base lo tapaba: una mutación que quitaba el señuelo sobrevivió.
    const costo = 15;
    const app = appApi({ ...e.deps, senuelo: await crearSenuelo(costo) });
    // Dos cuentas reales: cada una recibe 4 fallos (con 5 se bloquearía y respondería sin verificar).
    const cuentas = [await cuentaActiva(e.prisma), await cuentaActiva(e.prisma)];
    for (const c of cuentas) {
      await e.prisma.usuarios.update({ where: { id: c.id }, data: { hash_contrasena: await hashearContrasena(c.contrasena, costo) } });
    }
    const medir = async (correo: string) => {
      const t0 = performance.now();
      const r = await login(app, correo, 'contraseña equivocada 123');
      expect(r.status).toBe(401);
      return performance.now() - t0;
    };
    const mediana = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] ?? 0;
    // Calentamiento (JIT, conexiones del pool): no cuenta. Usa una tercera cuenta para no gastar fallos.
    const calentamiento = await cuentaActiva(e.prisma);
    await medir(calentamiento.correo);
    await medir(correoUnico('nadie'));
    const real: number[] = [];
    const inexistente: number[] = [];
    for (let i = 0; i < 4; i++) {
      for (const c of cuentas) {
        real.push(await medir(c.correo));
        inexistente.push(await medir(correoUnico('nadie')));
      }
    }
    // Con señuelo la razón ronda 1; sin señuelo (mutación E16) cae a ~0,1. El margen absorbe el ruido
    // de una máquina ocupada sin dejar de distinguir los dos casos.
    const razon = mediana(inexistente) / mediana(real);
    expect(razon).toBeGreaterThan(0.4);
    expect(razon).toBeLessThan(2.5);
  });

  it('una cuenta con MFA no obtiene sesión solo con la contraseña: 202 con un desafío y sin cookie', async () => {
    const app = appApi(e.deps);
    const admin = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const r = await login(app, admin.correo, admin.contrasena);
    expect(r.status).toBe(202);
    expect(r.body).toMatchObject({ mfaRequerido: true, metodos: ['totp', 'respaldo'], expiraEnSegundos: 300 });
    expect((r.body as { desafio: string }).desafio).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(setCookieRefresco(r.headers)).toBeUndefined();
    expect(JSON.stringify(r.body)).not.toContain('accessToken');
  });

  it('límite por IP: el intento 21 en la ventana recibe 429', async () => {
    const app = appApi(e.deps);
    let ultimo = 0;
    for (let i = 0; i < 21; i++) ultimo = (await login(app, correoUnico('x'), 'mala-contraseña-123')).status;
    expect(ultimo).toBe(429);
  });

  it('si Redis no responde, el login falla cerrado (503)', async () => {
    const caido = crearRedis('redis://127.0.0.1:1/1', () => undefined);
    const app = appApi({ ...e.deps, redis: caido });
    const r = await login(app, correoUnico('x'), 'mala-contraseña-123');
    caido.disconnect();
    expect(r.status).toBe(503);
  });
});

describe('sesión viva en cada petición', () => {
  it('cerrar sesión invalida el access token al instante (aunque no haya vencido) y borra la cookie', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const { accessToken } = (await login(app, c.correo, c.contrasena)).body as CuerpoSesion;
    const salida = await request(app).delete('/api/auth/sesion').set('authorization', `Bearer ${accessToken}`);
    expect(salida.status).toBe(204);
    expect(setCookieRefresco(salida.headers)).toMatch(/Expires=Thu, 01 Jan 1970/);
    const yo = await request(app).get('/api/auth/yo').set('authorization', `Bearer ${accessToken}`);
    expect(yo.status).toBe(401);
    expect(yo.headers['www-authenticate']).toBe('Bearer');
  });

  it('una sesión revocada desde otro lado deja de servir en la petición siguiente', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const { token, sesionId } = await accesoDirecto(e.deps, c.id);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${token}`)).status).toBe(200);
    await e.prisma.$executeRaw`UPDATE sesiones SET revocada_en = now(), motivo_revocacion = 'admin' WHERE id = ${sesionId}::uuid`;
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${token}`)).status).toBe(401);
  });

  it('el rol sale de la base, no del token: un cambio de rol rige en la petición siguiente', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const { token } = await accesoDirecto(e.deps, c.id);
    await e.prisma.usuarios.update({ where: { id: c.id }, data: { rol: 'lector' } });
    const yo = await request(app).get('/api/auth/yo').set('authorization', `Bearer ${token}`);
    expect((yo.body as { usuario: { rol: string } }).usuario.rol).toBe('lector');
  });

  it('sin token, con token basura o firmado con otra clave → 401', async () => {
    const app = appApi(e.deps);
    expect((await request(app).get('/api/auth/yo')).status).toBe(401);
    expect((await request(app).get('/api/auth/yo').set('authorization', 'Bearer basura')).status).toBe(401);
    const c = await cuentaActiva(e.prisma);
    const otro = await accesoDirecto({ ...e.deps, claveAcceso: Buffer.alloc(32, 7) }, c.id);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${otro.token}`)).status).toBe(401);
  });
});

describe('POST /api/auth/refresco (rotación con detección de reutilización)', () => {
  const refrescar = (app: ReturnType<typeof appApi>, cookie: string, origen?: string) => {
    const req = request(app).post('/api/auth/refresco').set('cookie', `cuaderno_refresco=${cookie}`);
    return origen ? req.set('origin', origen) : req;
  };

  it('rota: entrega access y refresh NUEVOS; el nuevo access funciona', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const r1 = await login(app, c.correo, c.contrasena);
    const ref1 = cookieRefresco(r1.headers) ?? '';
    const r2 = await refrescar(app, ref1, APP_URL);
    expect(r2.status).toBe(200);
    const ref2 = cookieRefresco(r2.headers) ?? '';
    expect(ref2).not.toBe('');
    expect(ref2).not.toBe(ref1);
    const s2 = r2.body as CuerpoSesion;
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${s2.accessToken}`)).status).toBe(200);
  });

  it('REUTILIZAR un refresh ya usado revoca la sesión entera (familia): el refresh nuevo y el access también mueren', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const ref1 = cookieRefresco((await login(app, c.correo, c.contrasena)).headers) ?? '';
    const r2 = await refrescar(app, ref1);
    const ref2 = cookieRefresco(r2.headers) ?? '';
    const access2 = (r2.body as CuerpoSesion).accessToken;

    const robo = await refrescar(app, ref1);
    expect(robo.status).toBe(401);
    expect((robo.body as CuerpoError).error.codigo).toBe('refresco_reutilizado');
    expect(setCookieRefresco(robo.headers)).toMatch(/Expires=Thu, 01 Jan 1970/);

    expect((await refrescar(app, ref2)).status).toBe(401);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${access2}`)).status).toBe(401);
    const s = await e.prisma.sesiones.findFirstOrThrow({ where: { usuario_id: c.id } });
    expect(s.motivo_revocacion).toBe('reutilizacion_refresco');
  });

  it('sin cookie → 401; cookie desconocida → 401 refresco_invalido', async () => {
    const app = appApi(e.deps);
    expect((await request(app).post('/api/auth/refresco')).status).toBe(401);
    const r = await refrescar(app, 'A'.repeat(43));
    expect((r.body as CuerpoError).error.codigo).toBe('refresco_invalido');
  });

  it('rechaza un Origin distinto al del frontend (CSRF) sin consumir el refresh', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const ref = cookieRefresco((await login(app, c.correo, c.contrasena)).headers) ?? '';
    const r = await refrescar(app, ref, 'https://sitio-malicioso.example.com');
    expect(r.status).toBe(403);
    expect((await refrescar(app, ref, APP_URL)).status).toBe(200);
  });

  it('una sesión cerrada ya no se puede refrescar', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const r = await login(app, c.correo, c.contrasena);
    await request(app).delete('/api/auth/sesion').set('authorization', `Bearer ${(r.body as CuerpoSesion).accessToken}`);
    expect((await refrescar(app, cookieRefresco(r.headers) ?? '')).status).toBe(401);
  });
});
