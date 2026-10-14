// Ningún secreto (tokens de invitación, refresco y recuperación, desafíos MFA, contraseñas, secretos TOTP,
// códigos de respaldo) aparece en los LOGS de pino ni en NINGUNA columna de la base. Única excepción
// acordada: correos_simulados, que es el buzón de la demo y por diseño contiene los enlaces.
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearSesion } from '../../src/auth/sesiones.js';
import { desdeBase32 } from '../../src/auth/totp.js';
import {
  accesoDirecto,
  APP_URL,
  appApiConLog,
  codigoTotp,
  cookieRefresco,
  correoUnico,
  cuentaActiva,
  entornoApi,
  esperarCorreo,
  tokenDelCorreo,
  type EntornoApi,
} from '../_api.js';

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});

/** Tablas excluidas del barrido (con su motivo). */
const EXCLUIDAS = new Set(['correos_simulados', 'schema_migrations']);

/** Busca cada secreto en TODAS las columnas de texto y binarias de public (salvo las excluidas). */
async function barrer(secretos: string[]): Promise<string[]> {
  const columnas = await e.prisma.$queryRaw<{ tabla: string; columna: string; tipo: string }[]>`
    SELECT c.table_name AS tabla, c.column_name AS columna, c.udt_name AS tipo
    FROM information_schema.columns c JOIN information_schema.tables t
      ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
    WHERE c.table_schema = 'public' AND c.udt_name IN ('text', 'citext', 'varchar', 'bpchar', 'bytea', 'jsonb', 'json')`;
  const hallazgos: string[] = [];
  for (const { tabla, columna, tipo } of columnas) {
    if (EXCLUIDAS.has(tabla)) continue;
    // Identificadores de information_schema (no de la entrada del usuario), entrecomillados.
    const col = `"${columna.replaceAll('"', '""')}"`;
    const tab = `"${tabla.replaceAll('"', '""')}"`;
    for (const s of secretos) {
      const sql =
        tipo === 'bytea'
          ? `SELECT count(*)::int AS n FROM ${tab} WHERE position(convert_to($1, 'UTF8') in ${col}) > 0`
          : `SELECT count(*)::int AS n FROM ${tab} WHERE strpos(${col}::text, $1) > 0`;
      const filas = await e.prisma.$queryRawUnsafe<{ n: number }[]>(sql, s);
      if ((filas[0]?.n ?? 0) > 0) hallazgos.push(`${tabla}.${columna} contiene un secreto`);
    }
  }
  return hallazgos;
}

describe('ningún secreto en logs ni en la base', () => {
  let lineas: Record<string, unknown>[] = [];
  const secretos: string[] = [];

  beforeAll(async () => {
    const { app, lineas: l } = appApiConLog(e.deps);
    lineas = l;
    const admin = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const { token: tokAdmin } = await accesoDirecto(e.deps, admin.id);
    const auth = { authorization: `Bearer ${tokAdmin}` };

    // Invitar, reenviar, consultar, completar (con un intento débil y uno bueno).
    const correo = correoUnico('secretos');
    const inv = await request(app).post('/api/admin/invitaciones').set(auth).send({ nombre: 'Ana Ficticia', correo, rol: 'editor' });
    const t1 = tokenDelCorreo(e.buzon.mensajes.findLast((m) => m.para === correo)?.texto ?? '');
    const id = (inv.body as { usuario: { id: string } }).usuario.id;
    await request(app).post(`/api/admin/invitaciones/${id}/reenviar`).set(auth);
    const t2 = tokenDelCorreo(e.buzon.mensajes.findLast((m) => m.para === correo)?.texto ?? '');
    const contrasena = `frase-secreta-${randomBytes(6).toString('hex')}`;
    await request(app).post('/api/invitaciones/consultar').send({ token: t2 });
    await request(app).post('/api/invitaciones/completar').send({ token: t2, contrasena: 'corta' });
    const comp = await request(app).post('/api/invitaciones/completar').send({ token: t2, contrasena });
    const r1 = cookieRefresco(comp.headers) ?? '';
    secretos.push(t1, t2, contrasena, r1, (comp.body as { accessToken: string }).accessToken);

    // Refrescar (cookie) y reutilizar el viejo.
    const rf = await request(app).post('/api/auth/refresco').set('origin', APP_URL).set('cookie', `cuaderno_refresco=${r1}`);
    secretos.push(cookieRefresco(rf.headers) ?? '');
    await request(app).post('/api/auth/refresco').set('cookie', `cuaderno_refresco=${r1}`);

    // Recuperar y restablecer.
    await request(app).post('/api/auth/recuperacion').send({ correo });
    const tr = /\/#\/recuperar\/([A-Za-z0-9_-]{43})/.exec((await esperarCorreo(e.buzon, correo, 'recuperacion')).texto)?.[1] ?? '';
    const nueva = `otra-frase-secreta-${randomBytes(6).toString('hex')}`;
    await request(app).post('/api/auth/recuperacion/completar').send({ token: tr, contrasena: nueva });
    secretos.push(tr, nueva);

    // Login con MFA (desafío, código y código de respaldo) y admin pendiente (secreto TOTP).
    const d = (await request(app).post('/api/auth/sesion').send({ correo: admin.correo, contrasena: admin.contrasena })).body as { desafio: string };
    await request(app).post('/api/auth/mfa').send({ desafio: d.desafio, codigo: codigoTotp(admin.secretoMfa) });
    const cods = ((await request(app).post('/api/cuenta/mfa/codigos-respaldo').set(auth).send({ codigo: codigoTotp(admin.secretoMfa, Date.now() + 30_000) })).body as { codigosRespaldo?: string[] }).codigosRespaldo ?? [];
    secretos.push(d.desafio, admin.contrasena, ...cods);
    const correoAdmin = correoUnico('pend-admin');
    await request(app).post('/api/admin/invitaciones').set(auth).send({ nombre: 'Admin Pendiente', correo: correoAdmin, rol: 'admin' });
    const ta = tokenDelCorreo(e.buzon.mensajes.findLast((m) => m.para === correoAdmin)?.texto ?? '');
    const { secreto } = (await request(app).post('/api/invitaciones/mfa').send({ token: ta })).body as { secreto: string };
    secretos.push(ta, secreto, desdeBase32(secreto).toString('base64'));
  });

  it('se recolectaron los secretos de todos los flujos', () => {
    expect(secretos.length).toBeGreaterThanOrEqual(20);
    for (const s of secretos) expect(s.length).toBeGreaterThanOrEqual(10);
  });

  it('LOGS: ninguna línea de pino contiene un token, una contraseña ni un secreto', () => {
    expect(lineas.length).toBeGreaterThan(10);
    const texto = JSON.stringify(lineas);
    const filtrados = secretos.filter((s) => texto.includes(s));
    expect(filtrados).toEqual([]);
  });

  it('BASE: ninguna columna (salvo correos_simulados) contiene un secreto en claro', async () => {
    expect(await barrer(secretos)).toEqual([]);
  });

  it('control positivo: el barrido SÍ encuentra un secreto sembrado a propósito', async () => {
    const canario = `canario-${randomBytes(8).toString('hex')}`;
    const c = await cuentaActiva(e.prisma);
    await e.prisma.$transaction((tx) => crearSesion(tx, { usuarioId: c.id, ipRed: null, userAgent: canario }));
    expect(await barrer([canario])).toEqual(['sesiones.user_agent contiene un secreto']);
  });
});
