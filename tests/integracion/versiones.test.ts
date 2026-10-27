// Versiones (bloque N) con el servidor de tiempo real de verdad: guardar el estado en memoria (incluye lo
// aún no guardado en la base), restaurar como CAMBIO NUEVO (llega a quien tiene el documento abierto, se
// guarda y queda una versión que apunta a la restaurada, sin tocar las anteriores), permisos y la versión
// automática. Datos SOLO ficticios.
import { pino } from 'pino';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { versionAutomatica } from '../../src/tiempo-real/compactacion.js';
import { DocumentoVivo } from '../../src/tiempo-real/documento.js';
import { LIMITES_PRODUCCION } from '../../src/tiempo-real/limites.js';
import { LIMITES_VERSIONES } from '../../src/versiones/rutas.js';
import { comoDuenoEnTransaccion } from '../_dueno.js';
import { conectar, esperar, levantar, type Entorno, type Persona } from '../_tiempo-real.js';

const proto = (ticket: string) => ['cuaderno.v1', `ticket.${ticket}`];

describe('versiones', () => {
  let t: Entorno;
  beforeAll(async () => {
    t = await levantar({ avisos: false });
  });
  afterAll(async () => {
    await t.cerrar();
  });

  const api = (p: Persona) => ({
    get: (ruta: string) => request(t.app).get(`/api${ruta}`).set('authorization', p.auth),
    post: (ruta: string) => request(t.app).post(`/api${ruta}`).set('authorization', p.auth),
  });

  const textoActual = async (p: Persona, id: string) => ((await api(p).get(`/documentos/${id}/texto`)).body as { texto: string }).texto;
  const textoVersion = async (p: Persona, id: string, n: number) => ((await api(p).get(`/documentos/${id}/versiones/${String(n)}`)).body as { texto: string }).texto;
  const versiones = async (p: Persona, id: string) =>
    ((await api(p).get(`/documentos/${id}/versiones`)).body as { versiones: { numero: number; motivo: string; autor: unknown }[] }).versiones;

  /** Lo que la BASE tiene del documento (estado + log), sin la memoria del servidor. */
  const textoEnLaBase = async (documentoId: string) => {
    const d = await DocumentoVivo.cargar(documentoId, {
      prisma: t.e.prisma,
      log: pino({ level: 'silent' }),
      limites: LIMITES_PRODUCCION,
      alRechazoDeEscritura: () => undefined,
      pedirCompactacion: () => undefined,
    });
    const x = d.ydoc.getText('contenido').toJSON();
    await d.cerrar();
    return x;
  };

  it('guardar y restaurar: la restauración llega a quien edita, queda en la base y el historial no se reescribe', async () => {
    const ana = await t.persona();
    const bruno = await t.persona();
    const { documentoId } = await t.documentoCon(ana, [[bruno, 'editor']]);
    const b = conectar(t.url, proto(await t.ticket(bruno, documentoId)));
    await b.abierto;
    await esperar(() => b.rol === 'editor');
    b.escribir('uno');
    await esperar(async () => (await textoActual(ana, documentoId)) === 'uno');

    const v1 = await api(ana).post(`/documentos/${documentoId}/versiones`);
    expect(v1.status).toBe(201);
    expect(v1.body).toMatchObject({ numero: 1, motivo: 'manual', autor: { id: ana.id }, restauradaDe: null, caracteres: 3 });

    b.escribir(' dos');
    await esperar(async () => (await textoActual(ana, documentoId)) === 'uno dos');
    const r = await api(ana).post(`/documentos/${documentoId}/versiones/1/restaurar`);
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ numero: 2, motivo: 'restauracion', autor: { id: ana.id }, restauradaDe: 1 });

    // Llega a quien tiene el documento abierto, y queda en la base (no solo en memoria).
    await esperar(() => b.texto === 'uno');
    expect(await textoEnLaBase(documentoId)).toBe('uno');
    // El historial: la versión 1 sigue con su texto; la cadena de hash está íntegra.
    expect((await versiones(bruno, documentoId)).map((v) => [v.numero, v.motivo])).toEqual([
      [2, 'restauracion'],
      [1, 'manual'],
    ]);
    expect(await textoVersion(bruno, documentoId, 1)).toBe('uno');
    const cadena = await t.e.prisma.$queryRaw<{ v: bigint | null }[]>`SELECT verificar_cadena_versiones(${documentoId}::uuid) AS v`;
    expect(cadena[0]?.v).toBeNull();
    // Bruno puede seguir escribiendo después de la restauración (no quedó desincronizado).
    b.escribir(' tres');
    await esperar(async () => (await textoActual(ana, documentoId)) === 'uno tres');
    b.ws.close();
  });

  it('permisos: un lector ve el historial pero no guarda ni restaura (403); sin acceso, 404', async () => {
    const ana = await t.persona();
    const lucia = await t.persona();
    const extrano = await t.persona();
    const { documentoId } = await t.documentoCon(ana, [[lucia, 'lector']]);
    expect((await api(ana).post(`/documentos/${documentoId}/versiones`)).status).toBe(201);
    expect((await api(lucia).get(`/documentos/${documentoId}/versiones`)).status).toBe(200);
    expect((await api(lucia).get(`/documentos/${documentoId}/versiones/1`)).status).toBe(200);
    expect((await api(lucia).post(`/documentos/${documentoId}/versiones`)).status).toBe(403);
    expect((await api(lucia).post(`/documentos/${documentoId}/versiones/1/restaurar`)).status).toBe(403);
    expect((await api(extrano).get(`/documentos/${documentoId}/versiones`)).status).toBe(404);
    expect((await api(extrano).get(`/documentos/${documentoId}/texto`)).status).toBe(404);
    expect((await api(ana).get(`/documentos/${documentoId}/versiones/99`)).status).toBe(404);
    expect((await api(ana).post(`/documentos/${documentoId}/versiones/99/restaurar`)).status).toBe(404);
  });

  it('verificar la cadena (bloque R): íntegra para cualquier rol; alterada desde la versión manipulada por el dueño de la base', async () => {
    const ana = await t.persona();
    const lucia = await t.persona();
    const extrano = await t.persona();
    const { documentoId } = await t.documentoCon(ana, [[lucia, 'lector']]);
    const verificar = (p: Persona) => api(p).get(`/documentos/${documentoId}/versiones/verificacion`);

    // Sin versiones: íntegra (no hay nada que no encadene).
    expect((await verificar(lucia)).body).toEqual({ integra: true, versiones: 0, alteradaDesde: null });
    for (let i = 0; i < 3; i++) expect((await api(ana).post(`/documentos/${documentoId}/versiones`)).status).toBe(201);
    const integra = await verificar(lucia);
    expect(integra.status).toBe(200);
    expect(integra.body).toEqual({ integra: true, versiones: 3, alteradaDesde: null });

    // Alguien con acceso directo a la base (el dueño, no el API) cambia el texto de la versión 2.
    await comoDuenoEnTransaccion(async (c) => {
      await c.query('ALTER TABLE versiones DISABLE TRIGGER versiones_solo_insercion');
      const r = await c.query(`UPDATE versiones SET contenido_texto = 'manipulado' WHERE documento_id = $1 AND numero = 2`, [documentoId]);
      expect(r.rowCount).toBe(1);
      await c.query('ALTER TABLE versiones ENABLE TRIGGER versiones_solo_insercion');
    });
    expect((await verificar(lucia)).body).toEqual({ integra: false, versiones: 3, alteradaDesde: 2 });
    expect((await verificar(ana)).body).toEqual({ integra: false, versiones: 3, alteradaDesde: 2 });

    // Sin acceso: 404 (no se distingue de un documento que no existe).
    expect((await verificar(extrano)).status).toBe(404);
  });

  it('verificar la cadena tiene límite por cuenta (la base recalcula cada hash)', async () => {
    const ana = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    const estados: number[] = [];
    for (let i = 0; i <= LIMITES_VERSIONES.verificar.max; i++) estados.push((await api(ana).get(`/documentos/${documentoId}/versiones/verificacion`)).status);
    expect(estados.slice(0, -1).every((s) => s === 200)).toBe(true);
    expect(estados.at(-1)).toBe(429);
  });

  it('versión automática: solo si el texto cambió desde la última', async () => {
    const ana = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    expect(await versionAutomatica(t.e.prisma, documentoId)).toBeNull(); // vacío y sin versiones
    const a = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    await a.abierto;
    await esperar(() => a.rol === 'propietario');
    a.escribir('hola');
    await esperar(async () => (await textoEnLaBase(documentoId)) === 'hola');
    expect(await versionAutomatica(t.e.prisma, documentoId)).toBe(1);
    expect(await versionAutomatica(t.e.prisma, documentoId)).toBeNull(); // sin cambios desde la 1
    expect((await versiones(ana, documentoId))[0]).toMatchObject({ numero: 1, motivo: 'automatica', autor: null });
    a.ws.close();
  });
});
