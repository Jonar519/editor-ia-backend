// Perfil, cambio de correo (re-verificación + aviso al anterior) y cambio de contraseña (cierra las demás
// sesiones), contra la base de PRUEBAS y Redis db 1.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, tokenAleatorio } from '../../src/auth/tokens.js';
import { MENSAJE_CAMBIO_CORREO } from '../../src/cuenta/perfil.js';
import { appApi, correoUnico, cuentaActiva, entornoApi, esperarCorreo, type CuentaPrueba, type EntornoApi } from '../_api.js';

interface CuerpoError {
  error: { codigo: string; detalles?: unknown };
}

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});

/** Login real (editor o lector, sin MFA): access token de una sesión nueva. */
async function entrar(app: ReturnType<typeof appApi>, c: { correo: string; contrasena: string }, ua = 'Mozilla/5.0 (Windows NT 10.0) Firefox/140.0'): Promise<string> {
  const r = await request(app).post('/api/auth/sesion').set('user-agent', ua).send({ correo: c.correo, contrasena: c.contrasena });
  expect(r.status).toBe(201);
  return (r.body as { accessToken: string }).accessToken;
}

const tokenDe = (texto: string, ruta: string) => {
  const m = new RegExp(`/#/${ruta}/([A-Za-z0-9_-]{43})`).exec(texto);
  if (!m?.[1]) throw new Error(`sin enlace #/${ruta}/ en el correo`);
  return m[1];
};

describe('perfil', () => {
  it('GET /api/cuenta devuelve el perfil sin secretos; PATCH cambia nombre y teléfono', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    const r = await request(app).get('/api/cuenta').set('authorization', `Bearer ${acceso}`);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ id: c.id, correo: c.correo, nombre: c.nombre, telefono: null, rol: 'editor', mfaActivo: false, avatar: null });
    expect(JSON.stringify(r.body)).not.toMatch(/scrypt|hash_contrasena/);

    const p = await request(app).patch('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ nombre: 'Nombre Nuevo', telefono: '+525512345678' });
    expect(p.status).toBe(200);
    expect(p.body).toMatchObject({ nombre: 'Nombre Nuevo', telefono: '+525512345678' });
    expect(await e.prisma.eventos_seguridad.count({ where: { usuario_id: c.id, tipo: 'perfil_actualizado' } })).toBe(1);
  });

  it('valida el teléfono (E.164) y que llegue al menos un campo', async () => {
    const app = appApi(e.deps);
    const acceso = await entrar(app, await cuentaActiva(e.prisma));
    expect((await request(app).patch('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ telefono: '55 1234 5678' })).status).toBe(400);
    expect((await request(app).patch('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({})).status).toBe(400);
  });
});

describe('cambio de correo', () => {
  async function pedir(app: ReturnType<typeof appApi>, acceso: string, c: CuentaPrueba, correoNuevo: string) {
    return request(app).post('/api/cuenta/correo').set('authorization', `Bearer ${acceso}`).send({ correoNuevo, contrasena: c.contrasena });
  }

  it('flujo completo: enlace al correo NUEVO, aviso al anterior; al confirmar cambia y se avisa de nuevo', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    const nuevo = correoUnico('nuevo');

    const r = await pedir(app, acceso, c, nuevo);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ mensaje: MENSAJE_CAMBIO_CORREO });
    const enlace = await esperarCorreo(e.buzon, nuevo, 'cambio_correo');
    const aviso = await esperarCorreo(e.buzon, c.correo, 'aviso_cambio_correo');
    expect(aviso.texto).toContain(`${nuevo.slice(0, 2)}***@example.com`);
    expect(aviso.texto).not.toContain(nuevo); // el anterior no ve la dirección entera
    expect(aviso.texto).not.toMatch(/#\//); // sin enlaces
    // Hasta confirmar, el correo no cambia.
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: c.id } })).correo).toBe(c.correo);

    const conf = await request(app).post('/api/cuenta/correo/confirmar').send({ token: tokenDe(enlace.texto, 'correo') });
    expect(conf.status).toBe(204);
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: c.id } })).correo).toBe(nuevo);
    const realizado = e.buzon.mensajes.filter((m) => m.para === c.correo && m.plantilla === 'aviso_cambio_correo');
    expect(realizado).toHaveLength(2);
    expect(realizado[1]?.asunto).toMatch(/cambió/);

    // El login funciona con el correo nuevo y no con el anterior.
    expect((await request(app).post('/api/auth/sesion').send({ correo: nuevo, contrasena: c.contrasena })).status).toBe(201);
    expect((await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena })).status).toBe(401);
    expect(await e.prisma.eventos_seguridad.count({ where: { usuario_id: c.id, tipo: 'correo_cambiado' } })).toBe(1);
  });

  it('el enlace es de un solo uso y solo vale hasta su vencimiento', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    const nuevo = correoUnico('nuevo');
    await pedir(app, acceso, c, nuevo);
    const token = tokenDe((await esperarCorreo(e.buzon, nuevo, 'cambio_correo')).texto, 'correo');
    // Vencido (se acorta el plazo: la base solo deja moverlo hacia atrás).
    await e.prisma.$executeRaw`UPDATE cambios_correo SET creado_en = now() - interval '2 hours', expira_en = now() - interval '1 minute' WHERE usuario_id = ${c.id}::uuid`;
    const vencido = await request(app).post('/api/cuenta/correo/confirmar').send({ token });
    expect(vencido.status).toBe(400);
    expect((vencido.body as CuerpoError).error.codigo).toBe('enlace_invalido');

    const otro = correoUnico('otro');
    await pedir(app, acceso, c, otro);
    const t2 = tokenDe((await esperarCorreo(e.buzon, otro, 'cambio_correo')).texto, 'correo');
    expect((await request(app).post('/api/cuenta/correo/confirmar').send({ token: t2 })).status).toBe(204);
    expect((await request(app).post('/api/cuenta/correo/confirmar').send({ token: t2 })).status).toBe(400);
  });

  it('pedir otro cambio invalida el enlace anterior', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    const primero = correoUnico('primero');
    await pedir(app, acceso, c, primero);
    const t1 = tokenDe((await esperarCorreo(e.buzon, primero, 'cambio_correo')).texto, 'correo');
    const segundo = correoUnico('segundo');
    await pedir(app, acceso, c, segundo);
    await esperarCorreo(e.buzon, segundo, 'cambio_correo');
    expect((await request(app).post('/api/cuenta/correo/confirmar').send({ token: t1 })).status).toBe(400);
  });

  it('una dirección que ya tiene cuenta: MISMA respuesta, ningún correo y ningún cambio pendiente', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const otra = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    const antes = e.buzon.mensajes.length;
    const r = await pedir(app, acceso, c, otra.correo);
    expect(r.status).toBe(202);
    expect(r.body).toEqual({ mensaje: MENSAJE_CAMBIO_CORREO });
    // El trabajo es en segundo plano: se le da tiempo de sobra antes de comprobar que no hizo nada.
    await new Promise((res) => setTimeout(res, 300));
    expect(e.buzon.mensajes.length).toBe(antes);
    expect(await e.prisma.cambios_correo.count({ where: { usuario_id: c.id } })).toBe(0);
  });

  it('exige la contraseña (un fallo suma al bloqueo) y que sea otra dirección', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    const mal = await request(app).post('/api/cuenta/correo').set('authorization', `Bearer ${acceso}`).send({ correoNuevo: correoUnico('x'), contrasena: 'no-es-la-mia-123' });
    expect(mal.status).toBe(403);
    expect((mal.body as CuerpoError).error.codigo).toBe('contrasena_incorrecta');
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: c.id } })).fallos_login).toBe(1);
    const mismo = await pedir(app, acceso, c, c.correo.toUpperCase());
    expect(mismo.status).toBe(400);
    expect((mismo.body as CuerpoError).error.codigo).toBe('mismo_correo');
  });

  it('confirmar invalida los enlaces de recuperación pendientes (se enviaron al correo anterior)', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    const rec = tokenAleatorio();
    await e.prisma.$executeRaw`
      INSERT INTO tokens_recuperacion (usuario_id, token_hash, expira_en) VALUES (${c.id}::uuid, ${hashToken(rec)}, now() + interval '10 minutes')`;
    const nuevo = correoUnico('nuevo');
    await pedir(app, acceso, c, nuevo);
    const token = tokenDe((await esperarCorreo(e.buzon, nuevo, 'cambio_correo')).texto, 'correo');
    expect((await request(app).post('/api/cuenta/correo/confirmar').send({ token })).status).toBe(204);
    const r = await request(app).post('/api/auth/recuperacion/completar').send({ token: rec, contrasena: 'una frase larga y nueva para la prueba' });
    expect(r.status).toBe(400);
  });
});

describe('cambio de contraseña', () => {
  it('cierra las DEMÁS sesiones (la actual sigue), avisa por correo y la nueva sirve para entrar', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const actual = await entrar(app, c);
    const otra = await entrar(app, c, 'Mozilla/5.0 (Android 14) Chrome/140.0');
    const nueva = 'otra frase larga para la prueba de cambio';
    const r = await request(app).post('/api/cuenta/contrasena').set('authorization', `Bearer ${actual}`).send({ actual: c.contrasena, nueva });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ cerradas: 1 });
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${actual}`)).status).toBe(200);
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${otra}`)).status).toBe(401);
    await esperarCorreo(e.buzon, c.correo, 'aviso_cambio_contrasena');
    expect((await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: nueva })).status).toBe(201);
    expect((await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena })).status).toBe(401);
  });

  it('exige la contraseña actual y aplica la política a la nueva', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    const mal = await request(app).post('/api/cuenta/contrasena').set('authorization', `Bearer ${acceso}`).send({ actual: 'no-es-la-mia-123', nueva: 'otra frase larga para la prueba' });
    expect(mal.status).toBe(403);
    const debil = await request(app).post('/api/cuenta/contrasena').set('authorization', `Bearer ${acceso}`).send({ actual: c.contrasena, nueva: 'corta' });
    expect(debil.status).toBe(400);
    expect((debil.body as CuerpoError).error.codigo).toBe('contrasena_debil');
  });

  it('cinco contraseñas actuales incorrectas bloquean la cuenta (mismo bloqueo que el login)', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const acceso = await entrar(app, c);
    for (let i = 0; i < 5; i++) {
      await request(app).post('/api/cuenta/contrasena').set('authorization', `Bearer ${acceso}`).send({ actual: `incorrecta-${String(i)}-xyz`, nueva: 'otra frase larga para la prueba' });
    }
    const r = await request(app).post('/api/cuenta/contrasena').set('authorization', `Bearer ${acceso}`).send({ actual: c.contrasena, nueva: 'otra frase larga para la prueba' });
    expect(r.status).toBe(429);
    expect((await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena })).status).toBe(429);
  });
});
