// Comentarios anclados (bloque N): un lector también comenta; editar solo quien escribió; resolver quien
// abrió el hilo o un editor; borrar quien escribió o el propietario del documento; el ancla se valida; y
// quien tiene el documento abierto recibe el aviso por el WebSocket. Datos SOLO ficticios.
import * as encoding from 'lib0/encoding';
import request from 'supertest';
import * as Y from 'yjs';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { conectar, esperar, levantar, type Entorno, type Persona } from '../_tiempo-real.js';

const proto = (ticket: string) => ['cuaderno.v1', `ticket.${ticket}`];

/** Un ancla válida: dos posiciones relativas de Yjs, en base64url. */
function anclaDe(inicio: number, fin: number): string {
  const doc = new Y.Doc();
  const t = doc.getText('contenido');
  t.insert(0, 'un texto cualquiera para anclar');
  const e = encoding.createEncoder();
  encoding.writeVarUint8Array(e, Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, inicio)));
  encoding.writeVarUint8Array(e, Y.encodeRelativePosition(Y.createRelativePositionFromTypeIndex(t, fin)));
  return Buffer.from(encoding.toUint8Array(e)).toString('base64url');
}

interface C {
  id: string;
  padreId: string | null;
  ancla: string | null;
  cuerpo: string;
  resuelto: boolean;
  editadoEn: string | null;
}

describe('comentarios', () => {
  let t: Entorno;
  beforeAll(async () => {
    t = await levantar({ avisos: false });
  });
  afterAll(async () => {
    await t.cerrar();
  });

  const como = (p: Persona) => ({
    listar: async (doc: string) => ((await request(t.app).get(`/api/documentos/${doc}/comentarios`).set('authorization', p.auth)).body as { comentarios: C[] }).comentarios,
    crear: (doc: string, cuerpo: Record<string, unknown>) => request(t.app).post(`/api/documentos/${doc}/comentarios`).set('authorization', p.auth).send(cuerpo),
    cambiar: (id: string, cuerpo: Record<string, unknown>) => request(t.app).patch(`/api/comentarios/${id}`).set('authorization', p.auth).send(cuerpo),
    borrar: (id: string) => request(t.app).delete(`/api/comentarios/${id}`).set('authorization', p.auth),
  });

  it('un lector abre un hilo anclado, otra persona responde, y quien tiene el documento abierto recibe el aviso', async () => {
    const ana = await t.persona();
    const lucia = await t.persona();
    const { documentoId } = await t.documentoCon(ana, [[lucia, 'lector']]);
    const a = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    await a.abierto;
    const ancla = anclaDe(3, 8);
    const hilo = await como(lucia).crear(documentoId, { cuerpo: 'Esto no se entiende', ancla });
    expect(hilo.status).toBe(201);
    expect(hilo.body).toMatchObject({ padreId: null, ancla, cuerpo: 'Esto no se entiende', resuelto: false, autor: { id: lucia.id } });
    await esperar(() => a.controles.some((c) => c.tipo === 'comentarios'));
    const r = await como(ana).crear(documentoId, { cuerpo: 'Lo aclaro', padreId: (hilo.body as C).id });
    expect(r.status).toBe(201);
    expect((await como(lucia).listar(documentoId)).map((c) => [c.cuerpo, c.padreId === null])).toEqual([
      ['Esto no se entiende', true],
      ['Lo aclaro', false],
    ]);
    a.ws.close();
  });

  it('el ancla se valida: sin ancla en un hilo, ancla en una respuesta, ancla mal formada o respuesta a una respuesta: 400', async () => {
    const ana = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    const c = como(ana);
    expect((await c.crear(documentoId, { cuerpo: 'sin ancla' })).body).toMatchObject({ error: { codigo: 'falta_ancla' } });
    for (const mala of ['', 'AAAA', 'no es base64url!', Buffer.from([1, 2, 3]).toString('base64url'), `${anclaDe(0, 1)}AA`]) {
      const r = await c.crear(documentoId, { cuerpo: 'x', ancla: mala });
      expect(r.status, mala).toBe(400);
    }
    const hilo = (await c.crear(documentoId, { cuerpo: 'hilo', ancla: anclaDe(0, 2) })).body as C;
    expect((await c.crear(documentoId, { cuerpo: 'r', padreId: hilo.id, ancla: anclaDe(0, 1) })).body).toMatchObject({ error: { codigo: 'ancla_en_respuesta' } });
    const resp = (await c.crear(documentoId, { cuerpo: 'r', padreId: hilo.id })).body as C;
    expect((await c.crear(documentoId, { cuerpo: 'r2', padreId: resp.id })).body).toMatchObject({ error: { codigo: 'respuesta_a_respuesta' } });
  });

  it('editar solo quien escribió; resolver quien abrió el hilo o un editor; borrar quien escribió o el propietario', async () => {
    const ana = await t.persona(); // propietaria
    const bruno = await t.persona(); // editor
    const lucia = await t.persona(); // lectora
    const leo = await t.persona(); // lector
    const { documentoId } = await t.documentoCon(ana, [[bruno, 'editor'], [lucia, 'lector'], [leo, 'lector']]);
    const hilo = (await como(lucia).crear(documentoId, { cuerpo: 'Pregunta', ancla: anclaDe(1, 4) })).body as C;
    const respuesta = (await como(leo).crear(documentoId, { cuerpo: 'Opino', padreId: hilo.id })).body as C;

    // Editar.
    expect((await como(leo).cambiar(hilo.id, { cuerpo: 'otra cosa' })).status).toBe(403);
    expect((await como(ana).cambiar(hilo.id, { cuerpo: 'otra cosa' })).status).toBe(403);
    const editado = await como(lucia).cambiar(hilo.id, { cuerpo: 'Pregunta mejor escrita' });
    expect(editado.body).toMatchObject({ cuerpo: 'Pregunta mejor escrita' });
    expect((editado.body as C).editadoEn).not.toBeNull();

    // Resolver.
    expect((await como(leo).cambiar(hilo.id, { resuelto: true })).status).toBe(403);
    expect((await como(lucia).cambiar(respuesta.id, { resuelto: true })).body).toMatchObject({ error: { codigo: 'resolver_respuesta' } });
    expect((await como(lucia).cambiar(hilo.id, { resuelto: true })).body).toMatchObject({ resuelto: true });
    expect((await como(bruno).cambiar(hilo.id, { resuelto: false })).body).toMatchObject({ resuelto: false });

    // Borrar.
    expect((await como(bruno).borrar(respuesta.id)).status).toBe(403); // editor, pero no es suya ni es propietario
    expect((await como(ana).borrar(respuesta.id)).status).toBe(204); // la propietaria modera
    const otra = (await como(leo).crear(documentoId, { cuerpo: 'Otra', padreId: hilo.id })).body as C;
    expect((await como(lucia).borrar(hilo.id)).status).toBe(204); // su hilo, con las respuestas
    expect((await como(ana).listar(documentoId)).map((c) => c.id)).not.toContain(otra.id);
  });

  it('sin acceso al documento: 404 al listar, comentar, cambiar y borrar (no se revela que existe)', async () => {
    const ana = await t.persona();
    const extrano = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    const hilo = (await como(ana).crear(documentoId, { cuerpo: 'hilo', ancla: anclaDe(0, 3) })).body as C;
    expect((await request(t.app).get(`/api/documentos/${documentoId}/comentarios`).set('authorization', extrano.auth)).status).toBe(404);
    expect((await como(extrano).crear(documentoId, { cuerpo: 'x', ancla: anclaDe(0, 1) })).status).toBe(404);
    expect((await como(extrano).cambiar(hilo.id, { cuerpo: 'x' })).status).toBe(404);
    expect((await como(extrano).borrar(hilo.id)).status).toBe(404);
  });
});
