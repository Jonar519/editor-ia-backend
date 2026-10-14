// Alta por invitación, de punta a punta, contra la base de PRUEBAS.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken } from '../../src/auth/tokens.js';
import { invitar } from '../../src/invitaciones/servicio.js';
import {
  accesoDirecto,
  APP_URL,
  appApi,
  cookieRefresco,
  correoUnico,
  cuentaActiva,
  entornoApi,
  tokenDelCorreo,
  type EntornoApi,
} from '../_api.js';

interface CuerpoError {
  error: { codigo: string; detalles?: unknown };
}

let e: EntornoApi;
let tokenAdmin: string;
let adminId: string;
beforeAll(async () => {
  e = await entornoApi();
  const admin = await cuentaActiva(e.prisma, 'admin');
  adminId = admin.id;
  tokenAdmin = (await accesoDirecto(e.deps, admin.id)).token;
});
afterAll(async () => {
  await e.cerrar();
});

const CLAVE_BUENA = 'una frase larga para mi cuenta';

async function invitarPorApi(app: ReturnType<typeof appApi>, rol: 'admin' | 'editor' | 'lector' = 'editor') {
  const correo = correoUnico('invitada');
  const r = await request(app).post('/api/admin/invitaciones').set('authorization', `Bearer ${tokenAdmin}`).send({ nombre: 'Ana Invitada', correo, rol });
  const m = e.buzon.mensajes.findLast((x) => x.para === correo);
  return { r, correo, token: m ? tokenDelCorreo(m.texto) : '', mensaje: m };
}

describe('invitar (admin)', () => {
  it('crea la cuenta pendiente y envía el enlace SOLO por correo: quien invita nunca lo ve', async () => {
    const app = appApi(e.deps);
    const { r, correo, token, mensaje } = await invitarPorApi(app);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ usuario: { correo, rol: 'editor', estado: 'pendiente' }, correoEnviado: true });
    // El token existe (llegó al correo de la persona invitada)...
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // ...pero no aparece en NADA de lo que recibe quien invita.
    expect(r.text).not.toContain(token);
    expect(JSON.stringify(r.headers)).not.toContain(token);
    // El enlace lleva el token en el FRAGMENTO.
    expect(mensaje?.texto).toContain(`${APP_URL}/#/invitacion/${token}`);
  });

  it('en la base solo queda el SHA-256 del token, con vigencia de 72 h', async () => {
    const app = appApi(e.deps);
    const { r, token } = await invitarPorApi(app);
    const id = (r.body as { usuario: { id: string } }).usuario.id;
    const inv = await e.prisma.invitaciones.findUniqueOrThrow({ where: { usuario_id: id } });
    expect(Buffer.from(inv.token_hash).equals(Buffer.from(hashToken(token)))).toBe(true);
    expect(Buffer.from(inv.token_hash).toString('utf8')).not.toContain(token);
    const horas = (inv.expira_en.getTime() - inv.creado_en.getTime()) / 3_600_000;
    expect(horas).toBeGreaterThan(71.9);
    expect(horas).toBeLessThanOrEqual(72);
    const u = await e.prisma.usuarios.findUniqueOrThrow({ where: { id } });
    expect(u).toMatchObject({ estado: 'pendiente', hash_contrasena: null, invitada_por: adminId });
  });

  it('solo un admin invita: sin sesión 401, editor 403', async () => {
    const app = appApi(e.deps);
    const datos = { nombre: 'X', correo: correoUnico('x'), rol: 'lector' };
    expect((await request(app).post('/api/admin/invitaciones').send(datos)).status).toBe(401);
    const editor = await cuentaActiva(e.prisma);
    const { token } = await accesoDirecto(e.deps, editor.id);
    const r = await request(app).post('/api/admin/invitaciones').set('authorization', `Bearer ${token}`).send(datos);
    expect(r.status).toBe(403);
  });

  it('correo repetido → 409; datos inválidos → 400', async () => {
    const app = appApi(e.deps);
    const { correo } = await invitarPorApi(app);
    const dup = await request(app).post('/api/admin/invitaciones').set('authorization', `Bearer ${tokenAdmin}`).send({ nombre: 'Otra', correo: correo.toUpperCase(), rol: 'lector' });
    expect(dup.status).toBe(409);
    const malo = await request(app).post('/api/admin/invitaciones').set('authorization', `Bearer ${tokenAdmin}`).send({ nombre: '', correo: 'no-es-correo', rol: 'superadmin' });
    expect(malo.status).toBe(400);
    expect((malo.body as CuerpoError).error.codigo).toBe('validacion');
  });

  it('si el proveedor de correo falla, la invitación queda y se informa correoEnviado=false', async () => {
    const app = appApi(e.deps);
    e.buzon.fallar = true;
    const { r } = await invitarPorApi(app);
    e.buzon.fallar = false;
    expect(r.status).toBe(201);
    expect((r.body as { correoEnviado: boolean }).correoEnviado).toBe(false);
  });

  it('reenviar reemplaza el enlace: el viejo deja de servir y el nuevo funciona', async () => {
    const app = appApi(e.deps);
    const { r, correo, token: viejo } = await invitarPorApi(app);
    const id = (r.body as { usuario: { id: string } }).usuario.id;
    const re = await request(app).post(`/api/admin/invitaciones/${id}/reenviar`).set('authorization', `Bearer ${tokenAdmin}`);
    expect(re.status).toBe(200);
    const nuevo = tokenDelCorreo(e.buzon.mensajes.findLast((m) => m.para === correo)?.texto ?? '');
    expect(nuevo).not.toBe(viejo);
    expect(re.text).not.toContain(nuevo);
    expect((await request(app).post('/api/invitaciones/consultar').send({ token: viejo })).status).toBe(404);
    expect((await request(app).post('/api/invitaciones/consultar').send({ token: nuevo })).status).toBe(200);
  });

  it('cancelar borra la cuenta pendiente; listar muestra las pendientes', async () => {
    const app = appApi(e.deps);
    const { r, token } = await invitarPorApi(app);
    const id = (r.body as { usuario: { id: string } }).usuario.id;
    const lista = await request(app).get('/api/admin/invitaciones?limite=5').set('authorization', `Bearer ${tokenAdmin}`);
    const cuerpo = lista.body as { total: number; invitaciones: { usuarioId: string }[] };
    // Paginado y más recientes primero: la que acabamos de crear encabeza la primera página.
    expect(cuerpo.invitaciones).toHaveLength(5);
    expect(cuerpo.invitaciones[0]?.usuarioId).toBe(id);
    expect(cuerpo.total).toBeGreaterThanOrEqual(5);
    expect((await request(app).delete(`/api/admin/invitaciones/${id}`).set('authorization', `Bearer ${tokenAdmin}`)).status).toBe(204);
    expect(await e.prisma.usuarios.findUnique({ where: { id } })).toBeNull();
    expect((await request(app).post('/api/invitaciones/consultar').send({ token })).status).toBe(404);
  });

  it('el listado está acotado: 50 por defecto, nunca más de 200, y se puede paginar', async () => {
    const app = appApi(e.deps);
    for (let i = 0; i < 3; i++) await invitarPorApi(app);
    const ver = (q: string) => request(app).get(`/api/admin/invitaciones${q}`).set('authorization', `Bearer ${tokenAdmin}`);
    const porDefecto = (await ver('')).body as { total: number; invitaciones: { usuarioId: string }[] };
    expect(porDefecto.invitaciones.length).toBe(Math.min(porDefecto.total, 50));
    expect((await ver('?limite=201')).status).toBe(400);
    const p1 = (await ver('?limite=2&desde=0')).body as { invitaciones: { usuarioId: string }[] };
    const p2 = (await ver('?limite=2&desde=2')).body as { invitaciones: { usuarioId: string }[] };
    expect(p1.invitaciones).toHaveLength(2);
    expect(p2.invitaciones).toHaveLength(2);
    expect(p2.invitaciones.map((x) => x.usuarioId)).not.toContain(p1.invitaciones[0]?.usuarioId);
  });

  it('la CLI de operador puede invitar sin admin (alta del primer admin)', async () => {
    const correo = correoUnico('primer-admin');
    const i = await invitar(e.deps, { invitadaPor: null, nombre: 'Primera Admin', correo, rol: 'admin' });
    expect(i.usuario).toMatchObject({ correo, rol: 'admin', estado: 'pendiente' });
    expect(e.buzon.mensajes.some((m) => m.para === correo && m.plantilla === 'invitacion')).toBe(true);
  });
});

describe('completar la invitación (persona invitada)', () => {
  it('consultar devuelve los datos para el formulario; el token viaja en el cuerpo', async () => {
    const app = appApi(e.deps);
    const { correo, token } = await invitarPorApi(app, 'lector');
    const r = await request(app).post('/api/invitaciones/consultar').send({ token });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ nombre: 'Ana Invitada', correo, rol: 'lector', requiereMfa: false });
  });

  it('contraseña débil → 400 con los motivos; la cuenta sigue pendiente', async () => {
    const app = appApi(e.deps);
    const { r: inv, token } = await invitarPorApi(app);
    const r = await request(app).post('/api/invitaciones/completar').send({ token, contrasena: 'corta' });
    expect(r.status).toBe(400);
    expect((r.body as CuerpoError).error).toMatchObject({ codigo: 'contrasena_debil', detalles: ['debe tener al menos 12 caracteres'] });
    const id = (inv.body as { usuario: { id: string } }).usuario.id;
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id } })).estado).toBe('pendiente');
  });

  it('completa: cuenta activa con hash scrypt, invitación consumida y primera sesión abierta', async () => {
    const app = appApi(e.deps);
    const { r: inv, token } = await invitarPorApi(app);
    const id = (inv.body as { usuario: { id: string } }).usuario.id;
    const r = await request(app).post('/api/invitaciones/completar').send({ token, contrasena: CLAVE_BUENA });
    expect(r.status).toBe(201);
    expect(cookieRefresco(r.headers)).toBeDefined();
    const acceso = (r.body as { accessToken: string }).accessToken;
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${acceso}`)).status).toBe(200);
    const u = await e.prisma.usuarios.findUniqueOrThrow({ where: { id } });
    expect(u.estado).toBe('activa');
    expect(u.hash_contrasena).toMatch(/^\$scrypt\$ln=10,r=8,p=1\$/);
    expect(await e.prisma.invitaciones.findUnique({ where: { usuario_id: id } })).toBeNull();
    // Y ya puede iniciar sesión con su contraseña.
    const correo = (inv.body as { usuario: { correo: string } }).usuario.correo;
    expect((await request(app).post('/api/auth/sesion').send({ correo, contrasena: CLAVE_BUENA })).status).toBe(201);
  });

  it('el enlace es de UN SOLO USO', async () => {
    const app = appApi(e.deps);
    const { token } = await invitarPorApi(app);
    expect((await request(app).post('/api/invitaciones/completar').send({ token, contrasena: CLAVE_BUENA })).status).toBe(201);
    const otra = await request(app).post('/api/invitaciones/completar').send({ token, contrasena: CLAVE_BUENA });
    expect(otra.status).toBe(404);
    expect((otra.body as CuerpoError).error.codigo).toBe('invitacion_invalida');
  });

  it('dos completados simultáneos del mismo enlace: solo uno gana', async () => {
    const app = appApi(e.deps);
    const { token } = await invitarPorApi(app);
    const [a, b] = await Promise.all([
      request(app).post('/api/invitaciones/completar').send({ token, contrasena: CLAVE_BUENA }),
      request(app).post('/api/invitaciones/completar').send({ token, contrasena: CLAVE_BUENA }),
    ]);
    expect([a.status, b.status].sort()).toEqual([201, 404]);
  });

  it('un enlace vencido → 410', async () => {
    const app = appApi(e.deps);
    const { r, token } = await invitarPorApi(app);
    const id = (r.body as { usuario: { id: string } }).usuario.id;
    // La base solo deja ACORTAR plazos: se mueven creación y vencimiento hacia el pasado.
    await e.prisma.$executeRaw`UPDATE invitaciones SET creado_en = now() - interval '73 hours', expira_en = now() - interval '1 hour' WHERE usuario_id = ${id}::uuid`;
    expect((await request(app).post('/api/invitaciones/consultar').send({ token })).status).toBe(410);
    expect((await request(app).post('/api/invitaciones/completar').send({ token, contrasena: CLAVE_BUENA })).status).toBe(410);
  });

  it('una cuenta admin no se completa sin MFA (bloque F): 409 y sigue pendiente', async () => {
    const app = appApi(e.deps);
    const { r: inv, token } = await invitarPorApi(app, 'admin');
    expect((await request(app).post('/api/invitaciones/consultar').send({ token })).body).toMatchObject({ requiereMfa: true });
    const r = await request(app).post('/api/invitaciones/completar').send({ token, contrasena: CLAVE_BUENA });
    expect(r.status).toBe(409);
    expect((r.body as CuerpoError).error.codigo).toBe('mfa_requerido');
    const id = (inv.body as { usuario: { id: string } }).usuario.id;
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id } })).estado).toBe('pendiente');
  });

  it('token con formato inválido → 400 (validación), sin tocar la base', async () => {
    const app = appApi(e.deps);
    expect((await request(app).post('/api/invitaciones/consultar').send({ token: '../../etc' })).status).toBe(400);
  });
});
