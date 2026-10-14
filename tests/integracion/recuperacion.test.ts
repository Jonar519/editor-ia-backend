// Recuperación de contraseña contra la base de PRUEBAS y Redis db 1.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MENSAJE_RECUPERACION } from '../../src/auth/rutas.js';
import { hashToken } from '../../src/auth/tokens.js';
import { appApi, buzonEnMemoria, cookieRefresco, correoUnico, cuentaActiva, entornoApi, esperarCorreo, type EntornoApi } from '../_api.js';

interface CuerpoError {
  error: { codigo: string };
}

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});

type App = ReturnType<typeof appApi>;
const pedir = (app: App, correo: string) => request(app).post('/api/auth/recuperacion').send({ correo });
const restablecer = (app: App, token: string, contrasena: string) => request(app).post('/api/auth/recuperacion/completar').send({ token, contrasena });
const tokenDe = (texto: string) => /\/#\/recuperar\/([A-Za-z0-9_-]{43})/.exec(texto)?.[1] ?? '';
const NUEVA = 'otra frase larga y nueva';

describe('pedir recuperación', () => {
  it('responde EXACTAMENTE lo mismo exista o no el correo (202 y el mismo mensaje)', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const real = await pedir(app, c.correo);
    const falso = await pedir(app, correoUnico('nadie'));
    for (const r of [real, falso]) {
      expect(r.status).toBe(202);
      expect(r.body).toEqual({ mensaje: MENSAJE_RECUPERACION });
    }
  });

  it('responde ANTES de hacer el trabajo: el tiempo no depende de que el correo exista', async () => {
    // Proveedor de correo lento (600 ms): si la respuesta esperara el envío, se notaría.
    const lento = buzonEnMemoria();
    const enviar = lento.enviar;
    lento.enviar = async (m) => {
      await new Promise((r) => setTimeout(r, 600));
      await enviar(m);
    };
    const app = appApi({ ...e.deps, correo: lento });
    const c = await cuentaActiva(e.prisma);
    const t0 = performance.now();
    expect((await pedir(app, c.correo)).status).toBe(202);
    expect(performance.now() - t0).toBeLessThan(400);
    // Y el correo igual llega (en segundo plano).
    await esperarCorreo(lento, c.correo, 'recuperacion');
  });

  it('el correo trae el enlace con el token en el fragmento; en la base solo su hash y 15 min', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    await pedir(app, c.correo);
    const token = tokenDe((await esperarCorreo(e.buzon, c.correo, 'recuperacion')).texto);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const fila = await e.prisma.tokens_recuperacion.findFirstOrThrow({ where: { usuario_id: c.id, usado_en: null } });
    expect(Buffer.from(fila.token_hash).equals(Buffer.from(hashToken(token)))).toBe(true);
    const min = (fila.expira_en.getTime() - fila.creado_en.getTime()) / 60_000;
    expect(min).toBeGreaterThan(14.9);
    expect(min).toBeLessThanOrEqual(15);
  });

  it('con un correo inexistente no se envía nada', async () => {
    const app = appApi(e.deps);
    const nadie = correoUnico('nadie');
    await pedir(app, nadie);
    await new Promise((r) => setTimeout(r, 300));
    expect(e.buzon.mensajes.some((m) => m.para === nadie)).toBe(false);
  });

  it('pedir otra vez invalida el enlace anterior', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    await pedir(app, c.correo);
    const t1 = tokenDe((await esperarCorreo(e.buzon, c.correo, 'recuperacion')).texto);
    e.buzon.mensajes = e.buzon.mensajes.filter((m) => m.para !== c.correo);
    await pedir(app, c.correo);
    const t2 = tokenDe((await esperarCorreo(e.buzon, c.correo, 'recuperacion')).texto);
    expect(t2).not.toBe(t1);
    expect((await restablecer(app, t1, NUEVA)).status).toBe(400);
    expect((await restablecer(app, t2, NUEVA)).status).toBe(204);
  });

  it('límite por correo: la cuarta petición en la ventana → 429, exista o no la cuenta', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const nadie = correoUnico('nadie');
    for (let i = 0; i < 3; i++) {
      expect((await pedir(app, c.correo)).status).toBe(202);
      expect((await pedir(app, nadie)).status).toBe(202);
    }
    expect((await pedir(app, c.correo)).status).toBe(429);
    expect((await pedir(app, nadie)).status).toBe(429);
  });
});

describe('restablecer', () => {
  async function enlace(app: App, correo: string) {
    await pedir(app, correo);
    return tokenDe((await esperarCorreo(e.buzon, correo, 'recuperacion')).texto);
  }

  it('cambia la contraseña, CIERRA TODAS las sesiones, levanta el bloqueo y avisa por correo', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const s = await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena });
    const acceso = (s.body as { accessToken: string }).accessToken;
    const refresh = cookieRefresco(s.headers) ?? '';
    await e.prisma.usuarios.update({ where: { id: c.id }, data: { fallos_login: 7, bloqueada_hasta: new Date(Date.now() + 3_600_000) } });

    expect((await restablecer(app, await enlace(app, c.correo), NUEVA)).status).toBe(204);

    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${acceso}`)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresco').set('cookie', `cuaderno_refresco=${refresh}`)).status).toBe(401);
    const vivas = await e.prisma.sesiones.count({ where: { usuario_id: c.id, revocada_en: null } });
    expect(vivas).toBe(0);
    expect((await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena })).status).toBe(401);
    expect((await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: NUEVA })).status).toBe(201);
    await esperarCorreo(e.buzon, c.correo, 'aviso_cambio_contrasena');
  });

  it('el enlace es de UN SOLO USO; contraseña débil → 400 sin consumirlo', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const t = await enlace(app, c.correo);
    const debil = await restablecer(app, t, 'corta');
    expect((debil.body as CuerpoError).error.codigo).toBe('contrasena_debil');
    expect((await restablecer(app, t, NUEVA)).status).toBe(204);
    const otra = await restablecer(app, t, 'y otra frase larga más');
    expect(otra.status).toBe(400);
    expect((otra.body as CuerpoError).error.codigo).toBe('enlace_invalido');
  });

  it('un enlace vencido no sirve', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const t = await enlace(app, c.correo);
    await e.prisma.$executeRaw`
      UPDATE tokens_recuperacion SET creado_en = now() - interval '20 minutes', expira_en = now() - interval '5 minutes'
      WHERE usuario_id = ${c.id}::uuid AND usado_en IS NULL`;
    expect((await restablecer(app, t, NUEVA)).status).toBe(400);
  });
});
