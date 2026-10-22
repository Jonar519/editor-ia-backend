// IA a través del API (bloque P1), con la base de PRUEBAS, Redis db 1 y el servicio gRPC REAL con el
// proveedor simulado: permisos, SSE y cancelación de punta a punta, mapeo de errores en HTTP, tope diario
// atómico, búsqueda e indexado AISLADOS por espacio, y /ready que muestra la IA sin caer en 503.
// Datos SOLO ficticios (@example.com).
import type { AddressInfo } from 'node:net';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { crearApi } from '../../src/api.js';
import type { DependenciasApi } from '../../src/dependencias.js';
import { ClienteIa } from '../../src/ia/cliente.js';
import { indexarDocumento, iniciarIndexado } from '../../src/ia/indexado.js';
import { ErrorProveedor } from '../../src/ia/proveedor.js';
import { NOMBRE_TEXTO } from '../../src/tiempo-real/documento.js';
import { accesoDirecto, appApi, cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';
import { appDePrueba, comprobacionOk, loggerEnMemoria, urlRedisPruebas } from '../_apoyo.js';
import { hasta, levantarIa, textoLargo } from '../_ia.js';

type Ia = Awaited<ReturnType<typeof levantarIa>>;
type Persona = Awaited<ReturnType<typeof cuentaActiva>> & { auth: string };

let x: Ia;
let e: EntornoApi;

beforeAll(async () => {
  x = await levantarIa({ mock: { retrasoFragmentoMs: 5 } });
  e = await entornoApi({ ia: x.cliente });
});
afterAll(async () => {
  await x.cerrar();
  await e.cerrar();
});

const app = (cambios: Partial<DependenciasApi> = {}) => appApi({ ...e.deps, ...cambios });

async function persona(rol: 'editor' | 'lector' = 'editor'): Promise<Persona> {
  const c = await cuentaActiva(e.prisma, rol, e.deps.claveMfa);
  const { token } = await accesoDirecto(e.deps, c.id);
  return { ...c, auth: `Bearer ${token}` };
}

/** Espacio de `dueno` con un documento suyo (con `texto` guardado) y los demás como miembros. */
async function espacioCon(dueno: Persona, texto: string, otros: [Persona, 'editor' | 'lector'][] = []) {
  const a = app();
  const esp = await request(a).post('/api/espacios').set('authorization', dueno.auth).send({ nombre: 'Equipo ficticio' });
  const espacioId = (esp.body as { id: string }).id;
  for (const [p, rol] of otros) await request(a).post(`/api/espacios/${espacioId}/miembros`).set('authorization', dueno.auth).send({ correo: p.correo, rol });
  const doc = await request(a).post(`/api/espacios/${espacioId}/documentos`).set('authorization', dueno.auth).send({ titulo: 'Documento ficticio' });
  const documentoId = (doc.body as { id: string }).id;
  await escribir(documentoId, dueno.id, texto);
  return { espacioId, documentoId };
}

/** Guarda texto en el documento como lo haría el tiempo real (una fila del log Yjs, con su autor). */
async function escribir(documentoId: string, autorId: string, texto: string): Promise<void> {
  const y = new Y.Doc();
  const previo = await e.prisma.$queryRaw<{ actualizacion: Uint8Array }[]>`SELECT actualizacion FROM actualizaciones_documento WHERE documento_id = ${documentoId}::uuid ORDER BY id`;
  for (const f of previo) Y.applyUpdate(y, f.actualizacion);
  const antes = Y.encodeStateVector(y);
  const t = y.getText(NOMBRE_TEXTO);
  y.transact(() => {
    t.delete(0, t.length);
    t.insert(0, texto);
  });
  await e.prisma.$executeRaw`
    INSERT INTO actualizaciones_documento (documento_id, autor_id, actualizacion)
    VALUES (${documentoId}::uuid, ${autorId}::uuid, ${Buffer.from(Y.encodeStateAsUpdate(y, antes))})`;
}

/** Eventos de una respuesta SSE. */
function eventos(cuerpo: string): { evento: string; datos: unknown }[] {
  return cuerpo
    .split('\n\n')
    .filter((b) => b.startsWith('event: '))
    .map((b) => {
      const [l1, l2] = b.split('\n');
      return { evento: (l1 ?? '').slice(7), datos: JSON.parse((l2 ?? '').slice(6)) as unknown };
    });
}

const sse = (req: request.Test) =>
  req.buffer(true).parse((res, listo) => {
    let t = '';
    res.on('data', (c: Buffer) => (t += c.toString('utf8')));
    res.on('end', () => {
      listo(null, t);
    });
  });

describe('explicar (JSON)', () => {
  it('cualquier rol con acceso; sin acceso 404; sin sesión 401; sin IA 503', async () => {
    const dueno = await persona();
    const lector = await persona('lector');
    const ajeno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto', [[lector, 'lector']]);
    const cuerpo = { documentoId, contenido: 'SELECT * FROM tabla_ficticia', lenguaje: 'sql' };
    const r = await request(app()).post('/api/ia/explicar').set('authorization', lector.auth).send(cuerpo);
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ texto: expect.stringContaining('«SELECT * FROM tabla_ficticia»') as unknown, uso: { tokensEntrada: 7 } });
    expect((await request(app()).post('/api/ia/explicar').set('authorization', ajeno.auth).send(cuerpo)).status).toBe(404);
    expect((await request(app()).post('/api/ia/explicar').send(cuerpo)).status).toBe(401);
    const depsSinIa: DependenciasApi = { ...e.deps };
    delete depsSinIa.ia;
    const sinIa = await request(appApi(depsSinIa)).post('/api/ia/explicar').set('authorization', dueno.auth).send(cuerpo);
    expect(sinIa.status).toBe(503);
    expect(sinIa.body).toMatchObject({ error: { codigo: 'ia_no_disponible' } });
  });

  it('valida: contenido vacío o demasiado largo, lenguaje raro → 400 sin llamar a la IA', async () => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto');
    for (const cuerpo of [
      { documentoId, contenido: '   ' },
      { documentoId, contenido: 'x'.repeat(8001) },
      { documentoId, contenido: 'x', lenguaje: 'ts"; DROP' },
    ]) {
      expect((await request(app()).post('/api/ia/explicar').set('authorization', dueno.auth).send(cuerpo)).status).toBe(400);
    }
  });
});

describe('mapeo de errores gRPC → HTTP en el API (una fila del ADR 0002 por caso)', () => {
  it.each([
    ['invalido', 400, 'ia_solicitud_invalida'],
    ['limite', 429, 'ia_saturada'],
    ['no_disponible', 503, 'ia_no_disponible'],
    ['no_implementado', 502, 'ia_error_interno'],
    ['interno', 502, 'ia_error_interno'],
  ] as const)('proveedor "%s" → %s %s', async (categoria, estado, codigo) => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto');
    x.mock.fallo = new ErrorProveedor(categoria, 'falla simulada', categoria === 'limite' ? 9 : undefined);
    try {
      const r = await request(app()).post('/api/ia/explicar').set('authorization', dueno.auth).send({ documentoId, contenido: 'hola' });
      expect(r.status).toBe(estado);
      expect(r.body).toMatchObject({ error: { codigo } });
      expect(JSON.stringify(r.body)).not.toContain('falla simulada'); // el detalle del servicio no sale
      if (categoria === 'limite') expect(r.headers['retry-after']).toBe('9');
    } finally {
      x.mock.fallo = null;
    }
  });

  it('DEADLINE_EXCEEDED → 504 ia_tiempo_agotado', async () => {
    const lento = await levantarIa({ mock: { retrasoRespuestaMs: 1000 }, deadlines: { explicar: 150 } });
    try {
      const dueno = await persona();
      const { documentoId } = await espacioCon(dueno, 'texto');
      const r = await request(app({ ia: lento.cliente })).post('/api/ia/explicar').set('authorization', dueno.auth).send({ documentoId, contenido: 'hola' });
      expect(r.status).toBe(504);
      expect(r.body).toMatchObject({ error: { codigo: 'ia_tiempo_agotado' } });
    } finally {
      await lento.cerrar();
    }
  });

  it('servicio caído (UNAVAILABLE) → 503; token equivocado (UNAUTHENTICATED) → 502', async () => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto');
    const caido = new ClienteIa({ url: '127.0.0.1:1', token: x.token });
    const mal = x.clienteCon('z'.repeat(43));
    try {
      const r1 = await request(app({ ia: caido })).post('/api/ia/explicar').set('authorization', dueno.auth).send({ documentoId, contenido: 'hola' });
      expect([r1.status, (r1.body as { error: { codigo: string } }).error.codigo]).toEqual([503, 'ia_no_disponible']);
      const r2 = await request(app({ ia: mal })).post('/api/ia/explicar').set('authorization', dueno.auth).send({ documentoId, contenido: 'hola' });
      expect([r2.status, (r2.body as { error: { codigo: string } }).error.codigo]).toEqual([502, 'ia_error_interno']);
    } finally {
      caido.cerrar();
      mal.cerrar();
    }
  });
});

describe('resumir y mejorar (SSE sobre fetch POST)', () => {
  it('resumir: text/event-stream con fragmentos y fin; el uso queda en uso_ia_diario', async () => {
    const lector = await persona('lector');
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto', [[lector, 'lector']]);
    const r = await sse(request(app()).post('/api/ia/resumir').set('authorization', lector.auth).send({ documentoId, contenido: 'Uno dos tres cuatro.', estilo: 'breve' }));
    expect(r.status).toBe(200);
    expect(r.headers['content-type']).toBe('text/event-stream; charset=utf-8');
    expect(r.headers['x-accel-buffering']).toBe('no');
    const ev = eventos(r.body as string);
    expect(ev.at(-1)?.evento).toBe('fin');
    expect(
      ev
        .filter((v) => v.evento === 'fragmento')
        .map((v) => (v.datos as { texto: string }).texto)
        .join(''),
    ).toBe('Resumen simulado (breve): Uno dos tres cuatro.');
    const uso = await e.prisma.$queryRaw<{ peticiones: number; tokens_salida: bigint }[]>`
      SELECT peticiones, tokens_salida FROM uso_ia_diario WHERE usuario_id = ${lector.id}::uuid`;
    expect(uso[0]?.peticiones).toBe(1);
    expect(Number(uso[0]?.tokens_salida)).toBeGreaterThan(0);
  });

  it('mejorar exige editor o propietario (un lector recibe 403)', async () => {
    const lector = await persona('lector');
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto', [[lector, 'lector']]);
    const cuerpo = { documentoId, contenido: 'texto a mejorar' };
    expect((await request(app()).post('/api/ia/mejorar').set('authorization', lector.auth).send(cuerpo)).status).toBe(403);
    const ok = await sse(request(app()).post('/api/ia/mejorar').set('authorization', dueno.auth).send(cuerpo));
    expect(eventos(ok.body as string).at(-1)?.evento).toBe('fin');
  });

  it('un error ANTES del primer byte es un código HTTP (JSON), no un evento', async () => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto');
    x.mock.fallo = new ErrorProveedor('no_disponible', 'falla simulada');
    try {
      const r = await request(app()).post('/api/ia/resumir').set('authorization', dueno.auth).send({ documentoId, contenido: 'hola' });
      expect(r.status).toBe(503);
      expect(r.headers['content-type']).toMatch(/^application\/json/);
    } finally {
      x.mock.fallo = null;
    }
  });

  it('abortar el fetch a mitad: la llamada gRPC queda CANCELLED y el simulado deja de generar', async () => {
    const lento = await levantarIa({ mock: { retrasoFragmentoMs: 30 } });
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto');
    const servidor = app({ ia: lento.cliente }).listen(0, '127.0.0.1');
    await new Promise((r) => servidor.once('listening', r));
    try {
      const ac = new AbortController();
      const r = await fetch(`http://127.0.0.1:${String((servidor.address() as AddressInfo).port)}/api/ia/mejorar`, {
        method: 'POST',
        headers: { authorization: dueno.auth, 'content-type': 'application/json' },
        body: JSON.stringify({ documentoId, contenido: textoLargo('palabra', 300) }),
        signal: ac.signal,
      });
      const lector = r.body?.getReader();
      await lector?.read();
      await lector?.read();
      ac.abort();
      await hasta(() => lento.lineas.some((l) => l.metodo === 'Mejorar' && l.codigo === 'CANCELLED'));
      const alCortar = lento.mock.generados;
      await new Promise((res) => setTimeout(res, 300));
      expect(lento.mock.generados).toBe(alCortar);
      expect(alCortar).toBeLessThan(100);
      // Se cobra lo estimado hasta el corte (se registra al detectar el cierre: se espera hasta 3 s).
      const limite = Date.now() + 3000;
      let tokens = 0;
      while (tokens === 0 && Date.now() < limite) {
        const uso = await e.prisma.$queryRaw<{ tokens_entrada: bigint }[]>`SELECT tokens_entrada FROM uso_ia_diario WHERE usuario_id = ${dueno.id}::uuid`;
        tokens = Number(uso[0]?.tokens_entrada ?? 0);
        if (tokens === 0) await new Promise((res) => setTimeout(res, 25));
      }
      expect(tokens).toBeGreaterThan(0);
    } finally {
      await new Promise((r) => servidor.close(r));
      await lento.cerrar();
    }
  });
});

describe('tope diario (uso_ia_diario)', () => {
  it('al llegar al tope: 429 tope_diario_ia con Retry-After hasta la medianoche UTC', async () => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto');
    const a = app({ topesIa: { peticionesDia: 2, tokensDia: 1_000_000 } });
    const pedir = () => request(a).post('/api/ia/explicar').set('authorization', dueno.auth).send({ documentoId, contenido: 'hola' });
    expect((await pedir()).status).toBe(200);
    expect((await pedir()).status).toBe(200);
    const r = await pedir();
    expect(r.status).toBe(429);
    expect(r.body).toMatchObject({ error: { codigo: 'tope_diario_ia' } });
    expect(Number(r.headers['retry-after'])).toBeGreaterThan(0);
    expect(Number(r.headers['retry-after'])).toBeLessThanOrEqual(86_400);
  });

  it('es atómico: 8 pedidos a la vez con tope 3 → exactamente 3 pasan', async () => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto');
    const a = app({ topesIa: { peticionesDia: 3, tokensDia: 1_000_000 } });
    const r = await Promise.all(Array.from({ length: 8 }, () => request(a).post('/api/ia/explicar').set('authorization', dueno.auth).send({ documentoId, contenido: 'hola' })));
    expect(r.filter((x) => x.status === 200)).toHaveLength(3);
    expect(r.filter((x) => x.status === 429)).toHaveLength(5);
  });

  it('el tope de tokens también corta', async () => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'texto');
    const a = app({ topesIa: { peticionesDia: 100, tokensDia: 10 } });
    expect((await request(a).post('/api/ia/explicar').set('authorization', dueno.auth).send({ documentoId, contenido: 'x'.repeat(200) })).status).toBe(200);
    expect((await request(a).post('/api/ia/explicar').set('authorization', dueno.auth).send({ documentoId, contenido: 'hola' })).status).toBe(429);
  });
});

describe('aislamiento entre espacios', () => {
  let a: Persona;
  let b: Persona;
  let lectorA: Persona;
  let espA: { espacioId: string; documentoId: string };
  let espB: { espacioId: string; documentoId: string };
  const deps = () => ({ prisma: e.prisma, ia: x.cliente, topes: { peticionesDia: 1000, tokensDia: 10_000_000 }, topeIndexadoEspacio: 10_000_000 });

  beforeAll(async () => {
    a = await persona();
    b = await persona();
    lectorA = await persona('lector');
    espA = await espacioCon(a, 'Las zanahorias moradas del huerto ficticio.\n\nOtro párrafo sobre kiwis.', [[lectorA, 'lector']]);
    espB = await espacioCon(b, 'Manzanas y peras del espacio B.');
    expect((await indexarDocumento(deps(), espA.documentoId, { usuarioId: a.id }, 'prueba')).resultado).toBe('indexado');
    expect((await indexarDocumento(deps(), espB.documentoId, { usuarioId: b.id }, 'prueba')).resultado).toBe('indexado');
  });

  const buscar = (p: Persona, espacioId: string, consulta: string) =>
    request(app()).post(`/api/espacios/${espacioId}/buscar`).set('authorization', p.auth).send({ consulta });

  it('la búsqueda de B en su espacio nunca devuelve fragmentos del espacio A', async () => {
    const r = await buscar(b, espB.espacioId, 'zanahorias moradas');
    expect(r.status).toBe(200);
    const res = (r.body as { resultados: { documentoId: string; texto: string }[] }).resultados;
    expect(res.every((x) => x.documentoId === espB.documentoId)).toBe(true);
    expect(JSON.stringify(res)).not.toContain('zanahoria');
  });

  it('B no puede buscar en el espacio A (404, no se revela que existe)', async () => {
    const r = await buscar(b, espA.espacioId, 'zanahorias');
    expect(r.status).toBe(404);
    expect(r.body).toMatchObject({ error: { codigo: 'espacio_no_encontrado' } });
  });

  it('A (y su lector) encuentran lo suyo, con título y similitud', async () => {
    for (const p of [a, lectorA]) {
      const r = await buscar(p, espA.espacioId, 'zanahorias moradas');
      const res = (r.body as { resultados: { documentoId: string; texto: string; similitud: number; titulo: string }[] }).resultados;
      expect(res).toHaveLength(1);
      expect(res[0]?.documentoId).toBe(espA.documentoId);
      expect(res[0]?.texto).toContain('zanahorias moradas');
      expect(res[0]?.titulo).toBe('Documento ficticio');
      expect(res[0]?.similitud).toBeGreaterThan(0.3);
    }
  });

  it('quien sale del espacio deja de ver sus fragmentos en el acto (404)', async () => {
    const ex = await persona('lector');
    const esp = await espacioCon(a, 'Texto del espacio temporal con limones.', [[ex, 'lector']]);
    await indexarDocumento(deps(), esp.documentoId, { usuarioId: a.id }, 'prueba');
    expect((await buscar(ex, esp.espacioId, 'limones')).status).toBe(200);
    await request(app()).delete(`/api/espacios/${esp.espacioId}/miembros/${ex.id}`).set('authorization', a.auth).expect(204);
    expect((await buscar(ex, esp.espacioId, 'limones')).status).toBe(404);
  });

  it('indexar un documento ajeno: el API responde 404 y el trabajo no llama a la IA ni escribe nada', async () => {
    expect((await request(app({ indexador: { pedir: () => Promise.resolve(), pedirAutomatico: () => Promise.resolve(), cerrar: () => Promise.resolve() } })).post(`/api/documentos/${espA.documentoId}/indice`).set('authorization', b.auth)).status).toBe(404);
    const llamadasAntes = x.lineas.filter((l) => l.metodo === 'IndexarDocumento').length;
    const filasAntes = await e.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM embeddings WHERE documento_id = ${espA.documentoId}::uuid`;
    await escribir(espA.documentoId, a.id, 'Texto nuevo de A que B intentaría indexar.');
    expect((await indexarDocumento(deps(), espA.documentoId, { usuarioId: b.id }, 'prueba')).resultado).toBe('sin_acceso');
    expect(x.lineas.filter((l) => l.metodo === 'IndexarDocumento')).toHaveLength(llamadasAntes);
    const filas = await e.prisma.$queryRaw<{ n: number; indexado_por: string }[]>`
      SELECT count(*)::int AS n, min(indexado_por::text) AS indexado_por FROM embeddings WHERE documento_id = ${espA.documentoId}::uuid`;
    expect(filas[0]?.n).toBe(filasAntes[0]?.n);
    expect(filas[0]?.indexado_por).toBe(a.id);
    // Lo deja como estaba para las demás pruebas.
    await escribir(espA.documentoId, a.id, 'Las zanahorias moradas del huerto ficticio.\n\nOtro párrafo sobre kiwis.');
  });

  it('la base rechaza un embedding con indexado_por sin acceso (última capa)', async () => {
    const vector = `[${[1, ...new Array<number>(1023).fill(0)].join(',')}]`;
    await expect(
      e.prisma.$executeRaw`
        INSERT INTO embeddings (documento_id, espacio_id, fragmento, texto, hash_texto, modelo, embedding, indexado_por)
        VALUES (${espA.documentoId}::uuid, ${espA.espacioId}::uuid, 999, 'intruso', ${Buffer.alloc(32)}, 'x', ${vector}::vector, ${b.id}::uuid)`,
    ).rejects.toThrow(/Aislamiento/);
  });

  it('pedidos simultáneos de A y B: cada respuesta trae SOLO su contenido', async () => {
    const [ra, rb] = await Promise.all([
      sse(request(app()).post('/api/ia/mejorar').set('authorization', a.auth).send({ documentoId: espA.documentoId, contenido: textoLargo('secretoa', 80) })),
      sse(request(app()).post('/api/ia/mejorar').set('authorization', b.auth).send({ documentoId: espB.documentoId, contenido: textoLargo('secretob', 80) })),
    ]);
    expect(ra.body as string).toContain('secretoa79');
    expect(ra.body as string).not.toContain('secretob');
    expect(rb.body as string).toContain('secretob79');
    expect(rb.body as string).not.toContain('secretoa');
  });
});

describe('indexado', () => {
  it('POST /indice: editor 202 (encola), lector 403, sin cola 503', async () => {
    const dueno = await persona();
    const lector = await persona('lector');
    const { documentoId } = await espacioCon(dueno, 'texto', [[lector, 'lector']]);
    const pedidos: string[] = [];
    const indexador = { pedir: (doc: string) => (pedidos.push(doc), Promise.resolve()), pedirAutomatico: () => Promise.resolve(), cerrar: () => Promise.resolve() };
    expect((await request(app({ indexador })).post(`/api/documentos/${documentoId}/indice`).set('authorization', dueno.auth)).status).toBe(202);
    expect(pedidos).toEqual([documentoId]);
    expect((await request(app({ indexador })).post(`/api/documentos/${documentoId}/indice`).set('authorization', lector.auth)).status).toBe(403);
    expect((await request(app()).post(`/api/documentos/${documentoId}/indice`).set('authorization', dueno.auth)).status).toBe(503);
  });

  it('sin cambios no vuelve a llamar a la IA; con cambios reemplaza los fragmentos', async () => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'Primer párrafo.\n\nSegundo párrafo.');
    const d = { prisma: e.prisma, ia: x.cliente, topes: { peticionesDia: 1000, tokensDia: 10_000_000 }, topeIndexadoEspacio: 10_000_000 };
    const quien = { usuarioId: dueno.id };
    expect(await indexarDocumento(d, documentoId, quien, 'p')).toEqual({ resultado: 'indexado', fragmentos: 1, indexadoPor: dueno.id });
    const llamadas = x.lineas.filter((l) => l.metodo === 'IndexarDocumento').length;
    expect(await indexarDocumento(d, documentoId, quien, 'p')).toEqual({ resultado: 'sin_cambios', fragmentos: 1 });
    expect(x.lineas.filter((l) => l.metodo === 'IndexarDocumento')).toHaveLength(llamadas);
    await escribir(documentoId, dueno.id, `${'a'.repeat(1400)}\n\n${'b'.repeat(1400)}`);
    expect(await indexarDocumento(d, documentoId, quien, 'p')).toEqual({ resultado: 'indexado', fragmentos: 2, indexadoPor: dueno.id });
    const filas = await e.prisma.$queryRaw<{ fragmento: number; modelo: string }[]>`SELECT fragmento, modelo FROM embeddings WHERE documento_id = ${documentoId}::uuid ORDER BY fragmento`;
    expect(filas).toEqual([
      { fragmento: 0, modelo: 'mock-palabras-1024' },
      { fragmento: 1, modelo: 'mock-palabras-1024' },
    ]);
    await escribir(documentoId, dueno.id, '');
    expect(await indexarDocumento(d, documentoId, quien, 'p')).toEqual({ resultado: 'vacio', fragmentos: 0 });
    expect(await e.prisma.$queryRaw`SELECT 1 FROM embeddings WHERE documento_id = ${documentoId}::uuid`).toEqual([]);
  });

  it('por la cola de BullMQ (Redis de pruebas): el trabajo indexa el documento', async () => {
    const dueno = await persona();
    const { documentoId } = await espacioCon(dueno, 'Texto ficticio para la cola.');
    const { log } = loggerEnMemoria();
    const ind = iniciarIndexado({
      prisma: e.prisma,
      ia: x.cliente,
      topes: { peticionesDia: 1000, tokensDia: 10_000_000 },
      topeIndexadoEspacio: 10_000_000,
      redisUrl: urlRedisPruebas(),
      prefijo: `${e.deps.prefijoRedis}bull`,
      log,
    });
    try {
      await ind.pedir(documentoId, dueno.id);
      const limite = Date.now() + 10_000;
      for (;;) {
        const n = await e.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM embeddings WHERE documento_id = ${documentoId}::uuid`;
        if (n[0]?.n === 1) break;
        if (Date.now() > limite) throw new Error('el trabajo no indexó');
        await new Promise((r) => setTimeout(r, 50));
      }
    } finally {
      await ind.cerrar();
    }
  });
});

describe('/ready con la IA', () => {
  it('la IA caída se MUESTRA ("ia": "falla") pero /ready sigue en 200', async () => {
    const caido = new ClienteIa({ url: '127.0.0.1:1', token: x.token });
    try {
      const { app: a } = appDePrueba({
        comprobaciones: [comprobacionOk('bd'), { nombre: 'ia', informativa: true, comprobar: () => caido.comprobarSalud() }],
        api: crearApi(e.deps),
      });
      const r = await request(a).get('/ready');
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ estado: 'listo', comprobaciones: { bd: 'ok', ia: 'falla' } });
      const { app: b } = appDePrueba({ comprobaciones: [comprobacionOk('bd'), { nombre: 'ia', informativa: true, comprobar: () => x.cliente.comprobarSalud() }] });
      expect((await request(b).get('/ready')).body).toEqual({ estado: 'listo', comprobaciones: { bd: 'ok', ia: 'ok' } });
    } finally {
      caido.cerrar();
    }
  });
});
