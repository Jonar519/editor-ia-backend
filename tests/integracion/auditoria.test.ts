// Cada flujo de seguridad deja su evento en eventos_seguridad: tipo, cuenta e IP truncada (nada más).
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accesoDirecto, appApi, codigoTotp, cookieRefresco, correoUnico, cuentaActiva, entornoApi, tokenDelCorreo, type EntornoApi } from '../_api.js';

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});

async function eventosDe(usuarioId: string) {
  const filas = await e.prisma.$queryRaw<{ tipo: string; ip: string | null }[]>`
    SELECT tipo, ip_red::text AS ip FROM eventos_seguridad WHERE usuario_id = ${usuarioId}::uuid ORDER BY id`;
  return filas;
}

describe('registro de auditoría', () => {
  it('login: fallido, bloqueo y correcto, con IP truncada', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    for (let i = 0; i < 5; i++) await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: 'incorrecta-123456' });
    await e.prisma.usuarios.update({ where: { id: c.id }, data: { bloqueada_hasta: null } });
    await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena });
    const ev = await eventosDe(c.id);
    expect(ev.map((x) => x.tipo)).toEqual([
      'inicio_fallido', 'inicio_fallido', 'inicio_fallido', 'inicio_fallido', 'inicio_fallido', 'cuenta_bloqueada', 'inicio_sesion',
    ]);
    for (const x of ev) expect(x.ip).toMatch(/\/(24|48)$/);
  });

  it('MFA: desafío, fallo y correcto; cierre de sesión', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const d1 = (await request(app).post('/api/auth/sesion').send({ correo: a.correo, contrasena: a.contrasena })).body as { desafio: string };
    await request(app).post('/api/auth/mfa').send({ desafio: d1.desafio, codigo: '000000' });
    const d2 = (await request(app).post('/api/auth/sesion').send({ correo: a.correo, contrasena: a.contrasena })).body as { desafio: string };
    const ok = await request(app).post('/api/auth/mfa').send({ desafio: d2.desafio, codigo: codigoTotp(a.secretoMfa) });
    await request(app).delete('/api/auth/sesion').set('authorization', `Bearer ${(ok.body as { accessToken: string }).accessToken}`);
    expect((await eventosDe(a.id)).map((x) => x.tipo)).toEqual(['mfa_desafio', 'mfa_fallido', 'mfa_desafio', 'mfa_correcto', 'inicio_sesion', 'cierre_sesion']);
  });

  it('invitación creada y completada; refresh reutilizado', async () => {
    const app = appApi(e.deps);
    const admin = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const { token } = await accesoDirecto(e.deps, admin.id);
    const correo = correoUnico('auditada');
    const inv = await request(app).post('/api/admin/invitaciones').set('authorization', `Bearer ${token}`).send({ nombre: 'Ana', correo, rol: 'lector' });
    const id = (inv.body as { usuario: { id: string } }).usuario.id;
    const t = tokenDelCorreo(e.buzon.mensajes.findLast((m) => m.para === correo)?.texto ?? '');
    const comp = await request(app).post('/api/invitaciones/completar').send({ token: t, contrasena: 'una frase larga de lectora' });
    const r1 = cookieRefresco(comp.headers) ?? '';
    await request(app).post('/api/auth/refresco').set('cookie', `cuaderno_refresco=${r1}`);
    await request(app).post('/api/auth/refresco').set('cookie', `cuaderno_refresco=${r1}`);
    expect((await eventosDe(id)).map((x) => x.tipo)).toEqual(['invitacion_creada', 'invitacion_completada', 'refresco_reutilizado']);
  });

  it('cancelar una invitación deja el evento sin cuenta (anonimizado)', async () => {
    const app = appApi(e.deps);
    const admin = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const { token } = await accesoDirecto(e.deps, admin.id);
    const inv = await request(app).post('/api/admin/invitaciones').set('authorization', `Bearer ${token}`).send({ nombre: 'X', correo: correoUnico('x'), rol: 'lector' });
    const id = (inv.body as { usuario: { id: string } }).usuario.id;
    const antes = await e.prisma.eventos_seguridad.count({ where: { tipo: 'invitacion_cancelada', usuario_id: null } });
    await request(app).delete(`/api/admin/invitaciones/${id}`).set('authorization', `Bearer ${token}`);
    expect(await eventosDe(id)).toEqual([]);
    expect(await e.prisma.eventos_seguridad.count({ where: { tipo: 'invitacion_cancelada', usuario_id: null } })).toBe(antes + 1);
  });
});
