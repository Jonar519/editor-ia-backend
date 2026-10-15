// Exportar los datos (JSON SIN secretos) y eliminar la cuenta por lápida (409 con propiedad compartida,
// borrado de lo que no tiene colaboradores, sin documentos huérfanos, historial de versiones intacto).
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, tokenAleatorio } from '../../src/auth/tokens.js';
import { FORMATO_EXPORTACION } from '../../src/cuenta/datos.js';
import { appApi, codigoTotp, cookieRefresco, correoUnico, cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';

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

async function entrar(app: ReturnType<typeof appApi>, c: { correo: string; contrasena: string }) {
  const r = await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena });
  expect(r.status).toBe(201);
  return { acceso: (r.body as { accessToken: string }).accessToken, refresh: cookieRefresco(r.headers) ?? '' };
}

/** Espacio con su propietario y otros miembros (en una transacción: la base exige un propietario al COMMIT). */
async function espacio(propietario: string, otros: { id: string; rol: 'editor' | 'lector' }[] = []): Promise<string> {
  return e.prisma.$transaction(async (tx) => {
    const s = await tx.espacios.create({ data: { nombre: 'Espacio Ficticio', creado_por: propietario }, select: { id: true } });
    await tx.miembros_espacio.create({ data: { espacio_id: s.id, usuario_id: propietario, rol: 'propietario' } });
    for (const o of otros) await tx.miembros_espacio.create({ data: { espacio_id: s.id, usuario_id: o.id, rol: o.rol } });
    return s.id;
  });
}

/** Documento con su propietario (quien lo crea) y una versión manual con texto. */
async function documento(espacioId: string, creador: string, texto = 'Texto ficticio'): Promise<string> {
  const id = await e.prisma.$transaction(async (tx) => {
    const d = await tx.documentos.create({ data: { espacio_id: espacioId, titulo: 'Documento Ficticio', creado_por: creador }, select: { id: true } });
    await tx.permisos_documento.create({ data: { documento_id: d.id, espacio_id: espacioId, usuario_id: creador, rol: 'propietario' } });
    return d.id;
  });
  await version(id, creador, texto);
  return id;
}

async function version(documentoId: string, autor: string, texto: string): Promise<void> {
  await e.prisma.$executeRaw`
    INSERT INTO versiones (documento_id, motivo, creado_por, estado_yjs, contenido_texto)
    VALUES (${documentoId}::uuid, 'manual', ${autor}::uuid, convert_to(${texto}, 'UTF8'), ${texto})`;
}

/** Todos los valores secretos de la cuenta, en hex, base64 y base64url. */
async function secretosDe(usuarioId: string): Promise<string[]> {
  const bytes: Uint8Array[] = [];
  const u = await e.prisma.usuarios.findUniqueOrThrow({ where: { id: usuarioId }, select: { hash_contrasena: true } });
  const mfa = await e.prisma.mfa_totp.findUnique({ where: { usuario_id: usuarioId } });
  if (mfa) bytes.push(mfa.secreto_cifrado, mfa.iv, mfa.etiqueta);
  for (const c of await e.prisma.codigos_respaldo.findMany({ where: { usuario_id: usuarioId } })) bytes.push(c.hash_codigo);
  for (const t of await e.prisma.tokens_refresco.findMany({ where: { usuario_id: usuarioId } })) bytes.push(t.token_hash);
  for (const t of await e.prisma.tokens_recuperacion.findMany({ where: { usuario_id: usuarioId } })) bytes.push(t.token_hash);
  for (const t of await e.prisma.cambios_correo.findMany({ where: { usuario_id: usuarioId } })) bytes.push(t.token_hash);
  const valores = bytes.flatMap((b) => {
    const x = Buffer.from(b);
    return [x.toString('hex'), x.toString('base64'), x.toString('base64url')];
  });
  return [u.hash_contrasena ?? '', ...(u.hash_contrasena?.split('$').slice(-2) ?? []), ...valores].filter((v) => v.length >= 8);
}

describe('exportar datos', () => {
  it('JSON con perfil, sesiones, espacios, documentos, comentarios y eventos; ningún secreto', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    await e.prisma.codigos_respaldo.create({ data: { usuario_id: c.id, hash_codigo: randomBytes(32) } });
    await e.prisma.$executeRaw`
      INSERT INTO tokens_recuperacion (usuario_id, token_hash, expira_en) VALUES (${c.id}::uuid, ${hashToken(tokenAleatorio())}, now() + interval '10 minutes')`;
    await e.prisma.$executeRaw`
      INSERT INTO cambios_correo (usuario_id, correo_nuevo, token_hash, expira_en)
      VALUES (${c.id}::uuid, ${correoUnico('nuevo')}, ${hashToken(tokenAleatorio())}, now() + interval '1 hour')`;
    // Sesión real (con refresh) por el flujo MFA del login.
    const desafio = ((await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena })).body as { desafio: string }).desafio;
    const login = await request(app).post('/api/auth/mfa').send({ desafio, codigo: codigoTotp(c.secretoMfa) });
    expect(login.status).toBe(201);
    const acceso = (login.body as { accessToken: string }).accessToken;
    const eid = await espacio(c.id);
    const did = await documento(eid, c.id, 'Contenido de mi documento');
    await e.prisma.comentarios.create({ data: { documento_id: did, autor_id: c.id, cuerpo: 'Comentario ficticio' } });

    const mal = await request(app).post('/api/cuenta/exportacion').set('authorization', `Bearer ${acceso}`).send({ contrasena: 'no-es-la-mia-123' });
    expect(mal.status).toBe(403);

    const r = await request(app).post('/api/cuenta/exportacion').set('authorization', `Bearer ${acceso}`).send({ contrasena: c.contrasena });
    expect(r.status).toBe(200);
    expect(String(r.headers['content-disposition'])).toMatch(/^attachment; filename="cuaderno-datos-\d{4}-\d{2}-\d{2}\.json"$/);
    const datos = r.body as Record<string, unknown> & {
      cuenta: { correo: string };
      sesiones: { ipRed: string | null }[];
      documentosPropios: { textoUltimaVersion: string }[];
      comentarios: unknown[];
      eventosSeguridad: { tipo: string }[];
      mfa: { activo: boolean; codigosRespaldoSinUsar: number };
    };
    expect(datos.formato).toBe(FORMATO_EXPORTACION);
    expect(datos.cuenta.correo).toBe(c.correo);
    expect(datos.mfa).toMatchObject({ activo: true, codigosRespaldoSinUsar: 1 });
    expect(datos.sesiones.length).toBeGreaterThan(0);
    expect(datos.documentosPropios[0]?.textoUltimaVersion).toBe('Contenido de mi documento');
    expect(datos.comentarios).toHaveLength(1);
    expect(datos.eventosSeguridad.map((x) => x.tipo)).toContain('mfa_correcto');

    // Ningún secreto, en ninguna codificación (control positivo: la lista no está vacía).
    const texto = JSON.stringify(datos);
    const secretos = await secretosDe(c.id);
    expect(secretos.length).toBeGreaterThan(10);
    for (const s of secretos) expect(texto.includes(s), `secreto en la exportación: ${s.slice(0, 12)}…`).toBe(false);
    expect(texto).not.toMatch(/\$scrypt\$|hash_contrasena|token_hash|secreto_cifrado|hash_codigo|"iv"|"etiqueta"/);
    expect(await e.prisma.eventos_seguridad.count({ where: { usuario_id: c.id, tipo: 'datos_exportados' } })).toBe(1);
  });
});

describe('eliminar cuenta', () => {
  it('409 si es propietaria de documentos o espacios con colaboradores; dice qué transferir y no cambia nada', async () => {
    const app = appApi(e.deps);
    const ana = await cuentaActiva(e.prisma);
    const beto = await cuentaActiva(e.prisma);
    const { acceso } = await entrar(app, ana);
    const deAna = await espacio(ana.id, [{ id: beto.id, rol: 'editor' }]);
    const doc = await documento(deAna, ana.id);

    const r = await request(app).delete('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ contrasena: ana.contrasena });
    expect(r.status).toBe(409);
    const err = (r.body as CuerpoError).error;
    expect(err.codigo).toBe('propiedad_compartida');
    expect(err.detalles).toEqual(
      expect.arrayContaining([
        { tipo: 'documento', id: doc, nombre: 'Documento Ficticio' },
        { tipo: 'espacio', id: deAna, nombre: 'Espacio Ficticio' },
      ]),
    );
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: ana.id } })).estado).toBe('activa');
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${acceso}`)).status).toBe(200);
  });

  it('elimina: lápida, borra lo que no tiene colaboradores, cierra todo; sin huérfanos y con el historial verificable', async () => {
    const app = appApi(e.deps);
    const ana = await cuentaActiva(e.prisma);
    const beto = await cuentaActiva(e.prisma);
    const { acceso, refresh } = await entrar(app, ana);
    const propio = await espacio(ana.id);
    const docPropio = await documento(propio, ana.id);
    const deBeto = await espacio(beto.id, [{ id: ana.id, rol: 'editor' }]);
    const docBeto = await documento(deBeto, beto.id, 'v1 de Beto');
    await version(docBeto, ana.id, 'v2 con aportes de Ana');
    await e.prisma.comentarios.create({ data: { documento_id: docBeto, autor_id: ana.id, cuerpo: 'Comentario ficticio' } });

    const r = await request(app).delete('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ contrasena: ana.contrasena });
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ espaciosBorrados: 1, documentosBorrados: 1 });
    expect(String(r.headers['set-cookie'])).toMatch(/cuaderno_refresco=;.*Expires=Thu, 01 Jan 1970/);

    // La cuenta es una lápida y ya no entra por ningún lado.
    const u = await e.prisma.usuarios.findUniqueOrThrow({ where: { id: ana.id } });
    expect(u).toMatchObject({ estado: 'eliminada', correo: null, nombre: null, telefono: null, hash_contrasena: null });
    expect((await request(app).get('/api/auth/yo').set('authorization', `Bearer ${acceso}`)).status).toBe(401);
    expect((await request(app).post('/api/auth/refresco').set('cookie', `cuaderno_refresco=${refresh}`)).status).toBe(401);
    expect((await request(app).post('/api/auth/sesion').send({ correo: ana.correo, contrasena: ana.contrasena })).status).toBe(401);

    // Lo suyo sin colaboradores se fue; el documento de Beto sigue con su historial íntegro.
    expect(await e.prisma.documentos.count({ where: { id: docPropio } })).toBe(0);
    expect(await e.prisma.espacios.count({ where: { id: propio } })).toBe(0);
    expect(await e.prisma.versiones.count({ where: { documento_id: docBeto } })).toBe(2);
    const cadena = await e.prisma.$queryRaw<{ alterada: bigint | null }[]>`SELECT verificar_cadena_versiones(${docBeto}::uuid) AS alterada`;
    expect(cadena[0]?.alterada).toBeNull();
    expect((await e.prisma.comentarios.findFirstOrThrow({ where: { documento_id: docBeto } })).autor_id).toBe(ana.id);
    const huerfanos = await e.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM documentos d
      WHERE NOT EXISTS (SELECT 1 FROM permisos_documento p JOIN usuarios x ON x.id = p.usuario_id
                        WHERE p.documento_id = d.id AND p.rol = 'propietario' AND x.estado = 'activa')`;
    expect(Number(huerfanos[0]?.n)).toBe(0);
    expect(await e.prisma.eventos_seguridad.count({ where: { usuario_id: ana.id } })).toBe(0);
  });

  it('con MFA exige además un código válido', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma, 'admin', e.deps.claveMfa);
    const desafio = ((await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena })).body as { desafio: string }).desafio;
    const ahora = Date.now();
    const acceso = ((await request(app).post('/api/auth/mfa').send({ desafio, codigo: codigoTotp(c.secretoMfa, ahora) })).body as { accessToken: string }).accessToken;

    const sin = await request(app).delete('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ contrasena: c.contrasena });
    expect(sin.status).toBe(400);
    expect((sin.body as CuerpoError).error.codigo).toBe('mfa_requerido');
    const mal = await request(app).delete('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ contrasena: c.contrasena, codigo: '000000' });
    expect(mal.status).toBe(403);
    // El código del login ya se usó (anti-replay): vale el del paso siguiente, dentro de la tolerancia de ±1.
    const siguiente = codigoTotp(c.secretoMfa, ahora + 30_000);
    const ok = await request(app).delete('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ contrasena: c.contrasena, codigo: siguiente });
    expect(ok.status).toBe(200);
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: c.id } })).estado).toBe('eliminada');
  });

  it('carrera: si alguien se sumó entre la revisión del backend y la de la base, la base responde y es 409 (no 500)', async () => {
    const ana = await cuentaActiva(e.prisma);
    const beto = await cuentaActiva(e.prisma);
    const deAna = await espacio(ana.id, [{ id: beto.id, rol: 'editor' }]);
    await documento(deAna, ana.id);
    // La revisión del backend (sus dos consultas con "otro" miembro) "ve" el estado de antes de que Beto
    // se sumara: nada compartido. La base, en eliminar_cuenta(), ve el estado real.
    const atrasado = new Proxy(e.prisma, {
      get(objetivo, prop, receptor) {
        const valor = Reflect.get(objetivo, prop, receptor) as unknown;
        if (prop !== '$queryRaw' || typeof valor !== 'function') return valor;
        return (sql: TemplateStringsArray, ...valores: unknown[]) =>
          sql.join('?').includes('JOIN miembros_espacio otro') ? Promise.resolve([]) : (valor as (...a: unknown[]) => unknown).call(objetivo, sql, ...valores);
      },
    });
    const app = appApi({ ...e.deps, prisma: atrasado });
    const { acceso } = await entrar(appApi(e.deps), ana);
    const r = await request(app).delete('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ contrasena: ana.contrasena });
    expect(r.status).toBe(409);
    expect((r.body as CuerpoError).error.codigo).toBe('propiedad_compartida');
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: ana.id } })).estado).toBe('activa');
  });

  it('una contraseña incorrecta no elimina nada (403)', async () => {
    const app = appApi(e.deps);
    const c = await cuentaActiva(e.prisma);
    const { acceso } = await entrar(app, c);
    const r = await request(app).delete('/api/cuenta').set('authorization', `Bearer ${acceso}`).send({ contrasena: 'no-es-la-mia-123' });
    expect(r.status).toBe(403);
    expect((await e.prisma.usuarios.findUniqueOrThrow({ where: { id: c.id } })).estado).toBe('activa');
  });
});
