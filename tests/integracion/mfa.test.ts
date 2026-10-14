// MFA de punta a punta contra la base de PRUEBAS y Redis db 1.
import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { verificarCodigoCuenta } from '../../src/auth/mfa.js';
import { desdeBase32, pasoDe } from '../../src/auth/totp.js';
import {
  accesoDirecto,
  appApi,
  codigoTotp,
  cookieRefresco,
  correoUnico,
  cuentaActiva,
  entornoApi,
  tokenDelCorreo,
  type EntornoApi,
} from '../_api.js';

interface CuerpoError {
  error: { codigo: string; mensaje: string };
}

let e: EntornoApi;
let tokenAdmin: string;
beforeAll(async () => {
  e = await entornoApi();
  const admin = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
  tokenAdmin = (await accesoDirecto(e.deps, admin.id)).token;
});
afterAll(async () => {
  await e.cerrar();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Mueve SOLO el reloj de Node (para pasar al siguiente paso TOTP); la base y la red siguen normales. */
function avanzarReloj(segundos: number) {
  const ahora = Date.now();
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(ahora + segundos * 1000);
}

type App = ReturnType<typeof appApi>;
const login = (app: App, correo: string, contrasena: string) => request(app).post('/api/auth/sesion').send({ correo, contrasena });
const segundoPaso = (app: App, cuerpo: Record<string, string>) => request(app).post('/api/auth/mfa').send(cuerpo);
const desafioDe = (r: { body: unknown }) => (r.body as { desafio: string }).desafio;

describe('login en dos pasos (cuenta con MFA)', () => {
  it('contraseña → desafío → código correcto: sesión con mfa_verificada y contador de fallos en cero', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const r1 = await login(app, a.correo, a.contrasena);
    expect(r1.status).toBe(202);
    const r2 = await segundoPaso(app, { desafio: desafioDe(r1), codigo: codigoTotp(a.secretoMfa) });
    expect(r2.status).toBe(201);
    expect(cookieRefresco(r2.headers)).toBeDefined();
    const acceso = (r2.body as { accessToken: string }).accessToken;
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${acceso}`)).status).toBe(200);
    const s = await e.prisma.sesiones.findFirstOrThrow({ where: { usuario_id: a.id } });
    expect(s.mfa_verificada).toBe(true);
  });

  it('el desafío es de UN SOLO USO: tras usarlo (bien o mal) ya no sirve', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const d1 = desafioDe(await login(app, a.correo, a.contrasena));
    expect((await segundoPaso(app, { desafio: d1, codigo: '000000' })).status).toBe(401);
    // El mismo desafío con el código CORRECTO ya no sirve: se consumió en el intento anterior.
    expect((await segundoPaso(app, { desafio: d1, codigo: codigoTotp(a.secretoMfa) })).status).toBe(401);
    avanzarReloj(30);
    const d2 = desafioDe(await login(app, a.correo, a.contrasena));
    expect((await segundoPaso(app, { desafio: d2, codigo: codigoTotp(a.secretoMfa) })).status).toBe(201);
    expect((await segundoPaso(app, { desafio: d2, codigo: codigoTotp(a.secretoMfa) })).status).toBe(401);
  });

  it('un fallo NO revela si la cuenta existe: desafío inventado y código incorrecto responden igual', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const malCodigo = await segundoPaso(app, { desafio: desafioDe(await login(app, a.correo, a.contrasena)), codigo: '123456' });
    const inventado = await segundoPaso(app, { desafio: 'A'.repeat(43), codigo: '123456' });
    for (const r of [malCodigo, inventado]) {
      expect(r.status).toBe(401);
      expect((r.body as CuerpoError).error).toMatchObject({ codigo: 'mfa_invalido', mensaje: 'El código no es válido o el paso venció. Inicia sesión de nuevo.' });
    }
  });

  it('ANTI-REPLAY: el mismo código no sirve dos veces (aunque siga vigente)', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const codigo = codigoTotp(a.secretoMfa);
    expect((await segundoPaso(app, { desafio: desafioDe(await login(app, a.correo, a.contrasena)), codigo })).status).toBe(201);
    const otra = await segundoPaso(app, { desafio: desafioDe(await login(app, a.correo, a.contrasena)), codigo });
    expect(otra.status).toBe(401);
  });

  it('ANTI-REPLAY bajo carrera: si otra petición guardó ese paso entre la lectura y el UPDATE, se rechaza (sin 500)', async () => {
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const codigo = codigoTotp(a.secretoMfa);
    const paso = pasoDe(Date.now());
    // Prisma envuelto: justo DESPUÉS de leer la fila, "otra petición" guarda el mismo paso.
    const prisma = e.prisma;
    const competidor = new Proxy(prisma, {
      get(objetivo, prop, receptor) {
        if (prop !== 'mfa_totp') return Reflect.get(objetivo, prop, receptor) as unknown;
        return new Proxy(objetivo.mfa_totp, {
          get(t, p2, r2) {
            if (p2 !== 'findUnique') return Reflect.get(t, p2, r2) as unknown;
            return async (args: Parameters<typeof t.findUnique>[0]) => {
              const fila = await t.findUnique(args);
              await prisma.$executeRaw`UPDATE mfa_totp SET ultimo_paso = ${paso} WHERE usuario_id = ${a.id}::uuid`;
              return fila;
            };
          },
        });
      },
    });
    const valido = await verificarCodigoCuenta({ prisma: competidor, claveMfa: e.deps.claveMfa }, a.id, codigo, { exigirConfirmado: true });
    expect(valido).toBe(false);
  });

  it('los fallos de MFA suman al bloqueo: 5 códigos malos bloquean la cuenta', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    for (let i = 0; i < 5; i++) {
      const r = await segundoPaso(app, { desafio: desafioDe(await login(app, a.correo, a.contrasena)), codigo: '000000' });
      expect(r.status).toBe(401);
    }
    const bloqueada = await login(app, a.correo, a.contrasena);
    expect(bloqueada.status).toBe(429);
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: a.id } })).fallos_login).toBe(5);
  });

  it('en Redis el desafío se guarda SOLO como hash y vence en 5 minutos', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const desafio = desafioDe(await login(app, a.correo, a.contrasena));
    const claves = await e.deps.redis.keys('*mfa:desafio:*');
    const hash = createHash('sha256').update(desafio).digest('hex');
    const mia = claves.find((k) => k.endsWith(hash));
    expect(mia).toBeDefined();
    expect(claves.some((k) => k.includes(desafio))).toBe(false);
    expect(await e.deps.redis.get(mia ?? '')).not.toContain(desafio);
    const ttl = await e.deps.redis.ttl(mia ?? '');
    expect(ttl).toBeGreaterThan(290);
    expect(ttl).toBeLessThanOrEqual(300);
  });

  it('código de respaldo: entra una vez; el mismo código ya no sirve', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const { token } = await accesoDirecto(e.deps, a.id);
    const r = await request(app).post('/api/cuenta/mfa/codigos-respaldo').set('authorization', `Bearer ${token}`).send({ codigo: codigoTotp(a.secretoMfa) });
    const codigos = (r.body as { codigosRespaldo: string[] }).codigosRespaldo;
    expect(codigos).toHaveLength(10);
    const usado = codigos[0] ?? '';
    const ok = await segundoPaso(app, { desafio: desafioDe(await login(app, a.correo, a.contrasena)), codigoRespaldo: usado.toLowerCase() });
    expect(ok.status).toBe(201);
    const otra = await segundoPaso(app, { desafio: desafioDe(await login(app, a.correo, a.contrasena)), codigoRespaldo: usado });
    expect(otra.status).toBe(401);
  });
});

describe('admin pendiente: MFA antes de activar (inscripciones_mfa)', () => {
  async function invitarAdmin(app: App) {
    const correo = correoUnico('nuevo-admin');
    const r = await request(app).post('/api/admin/invitaciones').set('authorization', `Bearer ${tokenAdmin}`).send({ nombre: 'Admin Nuevo', correo, rol: 'admin' });
    expect(r.status).toBe(201);
    const m = e.buzon.mensajes.findLast((x) => x.para === correo);
    return { correo, token: tokenDelCorreo(m?.texto ?? ''), usuarioId: (r.body as { usuario: { id: string } }).usuario.id };
  }
  const iniciar = (app: App, token: string) => request(app).post('/api/invitaciones/mfa').send({ token });
  const completarCon = (app: App, token: string, codigoTotp?: string) =>
    request(app).post('/api/invitaciones/completar').send({ token, contrasena: 'una frase larga del admin', ...(codigoTotp ? { codigoTotp } : {}) });

  it('obtiene el secreto y el otpauth://; pedirlo otra vez devuelve EL MISMO (puede recargar la página)', async () => {
    const app = appApi(e.deps);
    const inv = await invitarAdmin(app);
    const r1 = await iniciar(app, inv.token);
    expect(r1.status).toBe(200);
    const { secreto, uri } = r1.body as { secreto: string; uri: string };
    expect(uri).toContain(`secret=${secreto}`);
    expect((await iniciar(app, inv.token)).body).toMatchObject({ secreto });
  });

  it('sin código → 409; con código malo suma intentos; al quinto se reinicia con un secreto NUEVO', async () => {
    const app = appApi(e.deps);
    const inv = await invitarAdmin(app);
    const s1 = (await iniciar(app, inv.token)).body as { secreto: string };
    expect((await completarCon(app, inv.token)).status).toBe(409);
    for (let i = 1; i <= 4; i++) {
      const r = await completarCon(app, inv.token, '000000');
      expect((r.body as CuerpoError).error.codigo).toBe('codigo_mfa_invalido');
    }
    const quinto = await completarCon(app, inv.token, '000000');
    expect((quinto.body as CuerpoError).error.codigo).toBe('mfa_reiniciar');
    expect(await e.prisma.inscripciones_mfa.count({ where: { usuario_id: inv.usuarioId } })).toBe(0);
    const s2 = (await iniciar(app, inv.token)).body as { secreto: string };
    expect(s2.secreto).not.toBe(s1.secreto);
  });

  it('completa: cuenta activa con MFA confirmado (el MISMO secreto cifrado), 10 códigos una sola vez e inscripción borrada', async () => {
    const app = appApi(e.deps);
    const inv = await invitarAdmin(app);
    const { secreto } = (await iniciar(app, inv.token)).body as { secreto: string };
    const ins = await e.prisma.inscripciones_mfa.findFirstOrThrow({ where: { usuario_id: inv.usuarioId } });
    const r = await completarCon(app, inv.token, codigoTotp(desdeBase32(secreto)));
    expect(r.status).toBe(201);
    const cuerpo = r.body as { accessToken: string; codigosRespaldo: string[] };
    expect(cuerpo.codigosRespaldo).toHaveLength(10);
    const u = await e.prisma.usuarios.findUniqueOrThrow({ where: { id: inv.usuarioId } });
    expect(u.estado).toBe('activa');
    const mfa = await e.prisma.mfa_totp.findUniqueOrThrow({ where: { usuario_id: inv.usuarioId } });
    expect(mfa.confirmado_en).not.toBeNull();
    expect(Buffer.from(mfa.secreto_cifrado).equals(Buffer.from(ins.secreto_cifrado))).toBe(true);
    expect(mfa.ultimo_paso).not.toBeNull();
    expect(await e.prisma.codigos_respaldo.count({ where: { usuario_id: inv.usuarioId } })).toBe(10);
    expect(await e.prisma.inscripciones_mfa.count({ where: { usuario_id: inv.usuarioId } })).toBe(0);
    expect((await e.prisma.sesiones.findFirstOrThrow({ where: { usuario_id: inv.usuarioId } })).mfa_verificada).toBe(true);
    // Desde ahora su login pide el segundo paso.
    expect((await login(app, inv.correo, 'una frase larga del admin')).status).toBe(202);
  });

  it('una invitación de editor no usa este paso; reenviar borra la inscripción (cascada)', async () => {
    const app = appApi(e.deps);
    const correo = correoUnico('editor');
    await request(app).post('/api/admin/invitaciones').set('authorization', `Bearer ${tokenAdmin}`).send({ nombre: 'E', correo, rol: 'editor' });
    const t = tokenDelCorreo(e.buzon.mensajes.findLast((x) => x.para === correo)?.texto ?? '');
    expect(((await iniciar(app, t)).body as CuerpoError).error.codigo).toBe('mfa_no_aplica');

    const inv = await invitarAdmin(app);
    await iniciar(app, inv.token);
    expect(await e.prisma.inscripciones_mfa.count({ where: { usuario_id: inv.usuarioId } })).toBe(1);
    await request(app).post(`/api/admin/invitaciones/${inv.usuarioId}/reenviar`).set('authorization', `Bearer ${tokenAdmin}`);
    expect(await e.prisma.inscripciones_mfa.count({ where: { usuario_id: inv.usuarioId } })).toBe(0);
  });
});

describe('MFA opcional de una cuenta activa', () => {
  it('editor: iniciar → confirmar (código malo suma fallos) → desde ahora el login pide segundo paso', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma, 'editor');
    const { token } = await accesoDirecto(e.deps, c.id);
    const auth = { authorization: `Bearer ${token}` };
    const { secreto } = (await request(app).post('/api/cuenta/mfa/iniciar').set(auth)).body as { secreto: string };
    const malo = await request(app).post('/api/cuenta/mfa/confirmar').set(auth).send({ codigo: '000000' });
    expect(malo.status).toBe(400);
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: c.id } })).fallos_login).toBe(1);
    const ok = await request(app).post('/api/cuenta/mfa/confirmar').set(auth).send({ codigo: codigoTotp(desdeBase32(secreto)) });
    expect((ok.body as { codigosRespaldo: string[] }).codigosRespaldo).toHaveLength(10);
    expect((await login(app, c.correo, c.contrasena)).status).toBe(202);
    expect((await request(app).post('/api/cuenta/mfa/iniciar').set(auth)).status).toBe(409);
  });

  it('editor puede desactivarlo con un código; admin NO (obligatorio)', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma, 'editor');
    const { token } = await accesoDirecto(e.deps, c.id);
    const auth = { authorization: `Bearer ${token}` };
    const { secreto } = (await request(app).post('/api/cuenta/mfa/iniciar').set(auth)).body as { secreto: string };
    const s = desdeBase32(secreto);
    await request(app).post('/api/cuenta/mfa/confirmar').set(auth).send({ codigo: codigoTotp(s) });
    avanzarReloj(30);
    expect((await request(app).delete('/api/cuenta/mfa').set(auth).send({ codigo: codigoTotp(s) })).status).toBe(204);
    expect((await login(app, c.correo, c.contrasena)).status).toBe(201);

    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const ta = (await accesoDirecto(e.deps, a.id)).token;
    const r = await request(app).delete('/api/cuenta/mfa').set('authorization', `Bearer ${ta}`).send({ codigo: codigoTotp(a.secretoMfa) });
    expect(r.status).toBe(409);
    expect((r.body as CuerpoError).error.codigo).toBe('mfa_obligatorio');
  });

  it('regenerar códigos invalida los anteriores', async () => {
    const app = appApi(e.deps);
    const a = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const { token } = await accesoDirecto(e.deps, a.id);
    const auth = { authorization: `Bearer ${token}` };
    const viejos = ((await request(app).post('/api/cuenta/mfa/codigos-respaldo').set(auth).send({ codigo: codigoTotp(a.secretoMfa) })).body as { codigosRespaldo: string[] }).codigosRespaldo;
    avanzarReloj(30);
    await request(app).post('/api/cuenta/mfa/codigos-respaldo').set(auth).send({ codigo: codigoTotp(a.secretoMfa) });
    const r = await segundoPaso(app, { desafio: desafioDe(await login(app, a.correo, a.contrasena)), codigoRespaldo: viejos[0] ?? '' });
    expect(r.status).toBe(401);
  });
});
