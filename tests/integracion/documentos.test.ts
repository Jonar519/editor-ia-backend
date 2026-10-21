// Documentos y permisos propios (bloque K1) contra la base de PRUEBAS. El rol de cada respuesta es el
// EFECTIVO que calcula la base (rol_efectivo_documento): un permiso propio sube a un lector del espacio a
// editor del documento, ser propietario del espacio da "editor" (no la propiedad), y la propiedad del
// documento se transfiere.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { accesoDirecto, appApi, cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';

interface CuerpoError {
  error: { codigo: string };
}
interface DocumentoCuerpo {
  id: string;
  espacioId: string;
  titulo: string;
  rol: string;
  propietario: { id: string; nombre: string };
}
interface PermisoCuerpo {
  usuarioId: string;
  rol: string;
}

let e: EntornoApi;
let app: ReturnType<typeof appApi>;
beforeAll(async () => {
  e = await entornoApi();
  app = appApi(e.deps);
});
afterAll(async () => {
  await e.cerrar();
});

async function persona(rol: 'admin' | 'editor' | 'lector' = 'editor') {
  const c = await cuentaActiva(e.prisma, rol, e.deps.claveMfa);
  const { token } = await accesoDirecto(e.deps, c.id);
  return { ...c, auth: `Bearer ${token}` };
}
type Persona = Awaited<ReturnType<typeof persona>>;

const codigo = (r: { body: unknown }) => (r.body as CuerpoError).error.codigo;

/**
 * Espacio de Ana (propietaria) con Bruno (editor del espacio) y Carla (lectora del espacio), y un documento
 * creado por Bruno.
 */
async function escenario() {
  const [ana, bruno, carla] = [await persona(), await persona(), await persona()];
  const esp = await request(app).post('/api/espacios').set('authorization', ana.auth).send({ nombre: 'Equipo ficticio' });
  const espacioId = (esp.body as { id: string }).id;
  for (const [p, rol] of [
    [bruno, 'editor'],
    [carla, 'lector'],
  ] as const) {
    const r = await request(app).post(`/api/espacios/${espacioId}/miembros`).set('authorization', ana.auth).send({ correo: p.correo, rol });
    expect(r.status).toBe(201);
  }
  const doc = await request(app).post(`/api/espacios/${espacioId}/documentos`).set('authorization', bruno.auth).send({ titulo: 'Guía de despliegue' });
  expect(doc.status).toBe(201);
  return { ana, bruno, carla, espacioId, documentoId: (doc.body as DocumentoCuerpo).id };
}

const rolDe = async (p: Persona, documentoId: string) => {
  const r = await request(app).get(`/api/documentos/${documentoId}`).set('authorization', p.auth);
  return r.status === 200 ? (r.body as DocumentoCuerpo).rol : r.status;
};

describe('documentos', () => {
  it('crear: un editor del espacio sí y queda como propietario; un lector del espacio no (403); fuera del espacio, 404', async () => {
    const { ana, bruno, carla, espacioId, documentoId } = await escenario();
    const d = await request(app).get(`/api/documentos/${documentoId}`).set('authorization', bruno.auth);
    expect(d.body).toMatchObject({ espacioId, titulo: 'Guía de despliegue', rol: 'propietario', propietario: { id: bruno.id } });
    expect((await request(app).post(`/api/espacios/${espacioId}/documentos`).set('authorization', carla.auth).send({ titulo: 'No' })).status).toBe(403);
    const extrana = await persona();
    const fuera = await request(app).post(`/api/espacios/${espacioId}/documentos`).set('authorization', extrana.auth).send({ titulo: 'No' });
    expect([fuera.status, codigo(fuera)]).toEqual([404, 'espacio_no_encontrado']);
    expect((await request(app).post(`/api/espacios/${espacioId}/documentos`).set('authorization', ana.auth).send({ titulo: ' '.repeat(3) })).status).toBe(400);
  });

  it('una cuenta de solo lectura, aunque sea miembro, no crea documentos (403)', async () => {
    const { ana, espacioId } = await escenario();
    const leo = await persona('lector');
    expect((await request(app).post(`/api/espacios/${espacioId}/miembros`).set('authorization', ana.auth).send({ correo: leo.correo, rol: 'lector' })).status).toBe(201);
    expect((await request(app).post(`/api/espacios/${espacioId}/documentos`).set('authorization', leo.auth).send({ titulo: 'No' })).status).toBe(403);
  });

  it('listar: cada miembro ve los documentos con SU rol efectivo (la propietaria del espacio es "editor")', async () => {
    const { ana, bruno, carla, espacioId, documentoId } = await escenario();
    const roles: Record<string, string> = {};
    for (const [nombre, p] of Object.entries({ ana, bruno, carla })) {
      const r = await request(app).get(`/api/espacios/${espacioId}/documentos`).set('authorization', p.auth);
      roles[nombre] = (r.body as { documentos: DocumentoCuerpo[] }).documentos.find((x) => x.id === documentoId)?.rol ?? '';
    }
    expect(roles).toEqual({ ana: 'editor', bruno: 'propietario', carla: 'lector' });
  });

  it('quien no es miembro recibe 404 en todo, igual que si el documento no existiera', async () => {
    const { documentoId } = await escenario();
    const extrana = await persona();
    for (const r of [
      await request(app).get(`/api/documentos/${documentoId}`).set('authorization', extrana.auth),
      await request(app).get(`/api/documentos/00000000-0000-4000-8000-00000000abcd`).set('authorization', extrana.auth),
      await request(app).get(`/api/documentos/${documentoId}/permisos`).set('authorization', extrana.auth),
      await request(app).patch(`/api/documentos/${documentoId}`).set('authorization', extrana.auth).send({ titulo: 'X' }),
      await request(app).delete(`/api/documentos/${documentoId}`).set('authorization', extrana.auth),
    ]) {
      expect([r.status, codigo(r)]).toEqual([404, 'documento_no_encontrado']);
    }
  });

  it('renombrar: un editor efectivo sí; un lector no (403)', async () => {
    const { ana, carla, documentoId } = await escenario();
    expect((await request(app).patch(`/api/documentos/${documentoId}`).set('authorization', carla.auth).send({ titulo: 'No' })).status).toBe(403);
    const r = await request(app).patch(`/api/documentos/${documentoId}`).set('authorization', ana.auth).send({ titulo: 'Guía nueva' });
    expect([r.status, (r.body as DocumentoCuerpo).titulo]).toEqual([200, 'Guía nueva']);
  });

  it('borrar: solo el propietario del documento (la propietaria del espacio no: 403)', async () => {
    const { ana, bruno, documentoId } = await escenario();
    expect((await request(app).delete(`/api/documentos/${documentoId}`).set('authorization', ana.auth)).status).toBe(403);
    expect((await request(app).delete(`/api/documentos/${documentoId}`).set('authorization', bruno.auth)).status).toBe(204);
    expect((await request(app).get(`/api/documentos/${documentoId}`).set('authorization', bruno.auth)).status).toBe(404);
  });
});

describe('permisos del documento', () => {
  it('dar "editor" a una lectora del espacio sube su rol efectivo; quitarlo lo devuelve a lector', async () => {
    const { bruno, carla, documentoId } = await escenario();
    expect(await rolDe(carla, documentoId)).toBe('lector');
    const r = await request(app).put(`/api/documentos/${documentoId}/permisos/${carla.id}`).set('authorization', bruno.auth).send({ rol: 'editor' });
    expect(r.status).toBe(200);
    expect((r.body as { permisos: PermisoCuerpo[] }).permisos).toEqual(
      expect.arrayContaining([expect.objectContaining({ usuarioId: carla.id, rol: 'editor' }), expect.objectContaining({ usuarioId: bruno.id, rol: 'propietario' })]),
    );
    expect(await rolDe(carla, documentoId)).toBe('editor');
    expect((await request(app).delete(`/api/documentos/${documentoId}/permisos/${carla.id}`).set('authorization', bruno.auth)).status).toBe(204);
    expect(await rolDe(carla, documentoId)).toBe('lector');
  });

  it('dar: solo el propietario (403); "lector" no se acepta (400); a quien no es miembro (404); a una cuenta lectora (409); al propietario (409)', async () => {
    const { ana, bruno, carla, espacioId, documentoId } = await escenario();
    const permiso = (quien: Persona, objetivo: string, rol = 'editor') =>
      request(app).put(`/api/documentos/${documentoId}/permisos/${objetivo}`).set('authorization', quien.auth).send({ rol });
    expect((await permiso(ana, carla.id)).status).toBe(403);
    expect((await permiso(bruno, carla.id, 'lector')).status).toBe(400);
    const extrana = await persona();
    const nm = await permiso(bruno, extrana.id);
    expect([nm.status, codigo(nm)]).toEqual([404, 'miembro_no_encontrado']);
    const leo = await persona('lector');
    expect((await request(app).post(`/api/espacios/${espacioId}/miembros`).set('authorization', ana.auth).send({ correo: leo.correo, rol: 'lector' })).status).toBe(201);
    const lec = await permiso(bruno, leo.id);
    expect([lec.status, codigo(lec)]).toEqual([409, 'rol_excede_cuenta']);
    const prop = await permiso(bruno, bruno.id);
    expect([prop.status, codigo(prop)]).toEqual([409, 'usar_transferencia']);
  });

  it('quitar: al propietario no (409); un permiso que no existe (404); solo el propietario (403)', async () => {
    const { ana, bruno, carla, documentoId } = await escenario();
    const prop = await request(app).delete(`/api/documentos/${documentoId}/permisos/${bruno.id}`).set('authorization', bruno.auth);
    expect([prop.status, codigo(prop)]).toEqual([409, 'usar_transferencia']);
    const nada = await request(app).delete(`/api/documentos/${documentoId}/permisos/${carla.id}`).set('authorization', bruno.auth);
    expect([nada.status, codigo(nada)]).toEqual([404, 'permiso_no_encontrado']);
    expect((await request(app).delete(`/api/documentos/${documentoId}/permisos/${carla.id}`).set('authorization', ana.auth)).status).toBe(403);
  });

  it('cualquiera con acceso ve los permisos propios del documento', async () => {
    const { carla, bruno, documentoId } = await escenario();
    const r = await request(app).get(`/api/documentos/${documentoId}/permisos`).set('authorization', carla.auth);
    expect(r.status).toBe(200);
    expect((r.body as { permisos: PermisoCuerpo[] }).permisos).toEqual([expect.objectContaining({ usuarioId: bruno.id, rol: 'propietario' })]);
  });
});

describe('transferir el documento', () => {
  it('el nuevo queda propietario y el anterior con permiso "editor"', async () => {
    const { bruno, carla, documentoId } = await escenario();
    const r = await request(app).post(`/api/documentos/${documentoId}/propiedad`).set('authorization', bruno.auth).send({ usuarioId: carla.id });
    expect(r.status).toBe(200);
    expect(await rolDe(carla, documentoId)).toBe('propietario');
    expect(await rolDe(bruno, documentoId)).toBe('editor');
    expect((await request(app).delete(`/api/documentos/${documentoId}`).set('authorization', bruno.auth)).status).toBe(403);
  });

  it('a una cuenta lectora (409), a sí mismo (409), a quien no es miembro (404), sin ser propietario (403)', async () => {
    const { ana, bruno, espacioId, documentoId } = await escenario();
    const leo = await persona('lector');
    expect((await request(app).post(`/api/espacios/${espacioId}/miembros`).set('authorization', ana.auth).send({ correo: leo.correo, rol: 'lector' })).status).toBe(201);
    const transferir = (quien: Persona, usuarioId: string) => request(app).post(`/api/documentos/${documentoId}/propiedad`).set('authorization', quien.auth).send({ usuarioId });
    const lec = await transferir(bruno, leo.id);
    expect([lec.status, codigo(lec)]).toEqual([409, 'rol_excede_cuenta']);
    const mismo = await transferir(bruno, bruno.id);
    expect([mismo.status, codigo(mismo)]).toEqual([409, 'ya_es_propietario']);
    const extrana = await persona();
    expect((await transferir(bruno, extrana.id)).status).toBe(404);
    expect((await transferir(ana, ana.id)).status).toBe(403);
  });
});
