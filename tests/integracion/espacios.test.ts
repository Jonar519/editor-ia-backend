// Espacios y miembros (bloque K1) contra la base de PRUEBAS y Redis db 1. Sin acceso: 404 (no se revela
// si existe); con acceso pero sin el rol: 403. La propiedad no se cambia ni se quita: se transfiere.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITES_ESPACIOS } from '../../src/espacios/rutas.js';
import { accesoDirecto, appApi, correoUnico, cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';

interface CuerpoError {
  error: { codigo: string; detalles?: unknown };
}
interface EspacioCuerpo {
  id: string;
  nombre: string;
  rol: string;
  miembros: number;
}
interface MiembroCuerpo {
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

/** Cuenta activa con su access token (sesión directa). */
async function persona(rol: 'admin' | 'editor' | 'lector' = 'editor') {
  const c = await cuentaActiva(e.prisma, rol, e.deps.claveMfa);
  const { token } = await accesoDirecto(e.deps, c.id);
  return { ...c, auth: `Bearer ${token}` };
}
type Persona = Awaited<ReturnType<typeof persona>>;

const codigo = (r: { body: unknown }) => (r.body as CuerpoError).error.codigo;

async function nuevoEspacio(p: Persona, nombre = 'Espacio de prueba'): Promise<string> {
  const r = await request(app).post('/api/espacios').set('authorization', p.auth).send({ nombre });
  expect(r.status).toBe(201);
  return (r.body as EspacioCuerpo).id;
}

async function agregar(dueno: Persona, espacioId: string, quien: Persona, rol: 'editor' | 'lector') {
  const r = await request(app).post(`/api/espacios/${espacioId}/miembros`).set('authorization', dueno.auth).send({ correo: quien.correo, rol });
  expect(r.status).toBe(201);
}

async function nuevoDocumento(p: Persona, espacioId: string, titulo = 'Documento de prueba'): Promise<string> {
  const r = await request(app).post(`/api/espacios/${espacioId}/documentos`).set('authorization', p.auth).send({ titulo });
  expect(r.status).toBe(201);
  return (r.body as { id: string }).id;
}

const rolesDe = (body: unknown) =>
  Object.fromEntries((body as { miembros: MiembroCuerpo[] }).miembros.map((m) => [m.usuarioId, m.rol]));

describe('espacios', () => {
  it('crear: quien lo crea queda como propietario y lo ve en su lista', async () => {
    const ana = await persona();
    const r = await request(app).post('/api/espacios').set('authorization', ana.auth).send({ nombre: '  Equipo ficticio  ' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ nombre: 'Equipo ficticio', rol: 'propietario', miembros: 1 });
    const lista = await request(app).get('/api/espacios').set('authorization', ana.auth);
    expect((lista.body as { espacios: EspacioCuerpo[] }).espacios.map((x) => x.id)).toContain((r.body as EspacioCuerpo).id);
  });

  it('una cuenta de solo lectura no crea espacios (403); nombre vacío o de más de 80: 400', async () => {
    const leo = await persona('lector');
    const r = await request(app).post('/api/espacios').set('authorization', leo.auth).send({ nombre: 'No' });
    expect(r.status).toBe(403);
    const ana = await persona();
    expect((await request(app).post('/api/espacios').set('authorization', ana.auth).send({ nombre: '   ' })).status).toBe(400);
    expect((await request(app).post('/api/espacios').set('authorization', ana.auth).send({ nombre: 'x'.repeat(81) })).status).toBe(400);
  });

  it('sin sesión: 401', async () => {
    expect((await request(app).get('/api/espacios')).status).toBe(401);
  });

  it('quien no es miembro recibe 404, igual que si el espacio no existiera', async () => {
    const ana = await persona();
    const extrana = await persona();
    const id = await nuevoEspacio(ana);
    const ajeno = await request(app).get(`/api/espacios/${id}`).set('authorization', extrana.auth);
    const inexistente = await request(app).get(`/api/espacios/00000000-0000-4000-8000-00000000abcd`).set('authorization', extrana.auth);
    expect([ajeno.status, codigo(ajeno)]).toEqual([404, 'espacio_no_encontrado']);
    expect([inexistente.status, codigo(inexistente)]).toEqual([404, 'espacio_no_encontrado']);
    expect((await request(app).get(`/api/espacios/${id}/miembros`).set('authorization', extrana.auth)).status).toBe(404);
    expect((await request(app).get(`/api/espacios/${id}/documentos`).set('authorization', extrana.auth)).status).toBe(404);
  });

  it('renombrar: el propietario sí; un editor del espacio no (403)', async () => {
    const ana = await persona();
    const bruno = await persona();
    const id = await nuevoEspacio(ana);
    await agregar(ana, id, bruno, 'editor');
    expect((await request(app).patch(`/api/espacios/${id}`).set('authorization', bruno.auth).send({ nombre: 'Otro' })).status).toBe(403);
    const r = await request(app).patch(`/api/espacios/${id}`).set('authorization', ana.auth).send({ nombre: 'Nombre nuevo' });
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ nombre: 'Nombre nuevo', rol: 'propietario' });
  });

  it('borrar: con otros miembros, 409; solo con el propietario, se borra con sus documentos', async () => {
    const ana = await persona();
    const bruno = await persona();
    const id = await nuevoEspacio(ana);
    await nuevoDocumento(ana, id);
    await agregar(ana, id, bruno, 'lector');
    const compartido = await request(app).delete(`/api/espacios/${id}`).set('authorization', ana.auth);
    expect([compartido.status, codigo(compartido)]).toEqual([409, 'espacio_compartido']);
    expect((await request(app).delete(`/api/espacios/${id}/miembros/${bruno.id}`).set('authorization', ana.auth)).status).toBe(204);
    const r = await request(app).delete(`/api/espacios/${id}`).set('authorization', ana.auth);
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ documentosBorrados: 1 });
    expect((await request(app).get(`/api/espacios/${id}`).set('authorization', ana.auth)).status).toBe(404);
  });

  it('borrar: un editor del espacio no puede (403)', async () => {
    const ana = await persona();
    const bruno = await persona();
    const id = await nuevoEspacio(ana);
    await agregar(ana, id, bruno, 'editor');
    expect((await request(app).delete(`/api/espacios/${id}`).set('authorization', bruno.auth)).status).toBe(403);
  });
});

describe('miembros', () => {
  it('agregar por correo (sin importar mayúsculas); listar con roles', async () => {
    const ana = await persona();
    const bruno = await persona();
    const id = await nuevoEspacio(ana);
    const r = await request(app).post(`/api/espacios/${id}/miembros`).set('authorization', ana.auth).send({ correo: bruno.correo.toUpperCase(), rol: 'editor' });
    expect(r.status).toBe(201);
    expect(r.body).toMatchObject({ usuarioId: bruno.id, rol: 'editor', correo: bruno.correo });
    const lista = await request(app).get(`/api/espacios/${id}/miembros`).set('authorization', bruno.auth);
    expect(rolesDe(lista.body)).toEqual({ [ana.id]: 'propietario', [bruno.id]: 'editor' });
  });

  it('agregar: ya es miembro (409), sin cuenta activa (404 genérico), cuenta lectora como editora (409)', async () => {
    const ana = await persona();
    const bruno = await persona();
    const leo = await persona('lector');
    const id = await nuevoEspacio(ana);
    await agregar(ana, id, bruno, 'lector');
    const otraVez = await request(app).post(`/api/espacios/${id}/miembros`).set('authorization', ana.auth).send({ correo: bruno.correo, rol: 'editor' });
    expect([otraVez.status, codigo(otraVez)]).toEqual([409, 'ya_es_miembro']);

    const nadie = await request(app).post(`/api/espacios/${id}/miembros`).set('authorization', ana.auth).send({ correo: correoUnico('nadie'), rol: 'lector' });
    expect([nadie.status, codigo(nadie)]).toEqual([404, 'cuenta_no_encontrada']);
    // Una cuenta pendiente (invitada, sin activar) responde igual que una que no existe.
    const pendiente = await e.prisma.usuarios.create({ data: { correo: correoUnico('pendiente'), nombre: 'Pendiente Ficticia', rol: 'editor' } });
    const p = await request(app).post(`/api/espacios/${id}/miembros`).set('authorization', ana.auth).send({ correo: pendiente.correo, rol: 'lector' });
    expect([p.status, codigo(p)]).toEqual([404, 'cuenta_no_encontrada']);

    const lectorComoEditor = await request(app).post(`/api/espacios/${id}/miembros`).set('authorization', ana.auth).send({ correo: leo.correo, rol: 'editor' });
    expect([lectorComoEditor.status, codigo(lectorComoEditor)]).toEqual([409, 'rol_excede_cuenta']);
    await agregar(ana, id, leo, 'lector');
  });

  it('agregar: un editor del espacio no puede (403); un rol "propietario" no se acepta (400)', async () => {
    const ana = await persona();
    const bruno = await persona();
    const carla = await persona();
    const id = await nuevoEspacio(ana);
    await agregar(ana, id, bruno, 'editor');
    expect((await request(app).post(`/api/espacios/${id}/miembros`).set('authorization', bruno.auth).send({ correo: carla.correo, rol: 'lector' })).status).toBe(403);
    expect((await request(app).post(`/api/espacios/${id}/miembros`).set('authorization', ana.auth).send({ correo: carla.correo, rol: 'propietario' })).status).toBe(400);
  });

  it('agregar tiene límite por cuenta (30 en 15 min): la alta 31, 429', async () => {
    // La política se fija AQUÍ con su número, no se lee del código que se prueba: si el código cambiara el
    // límite, esta prueba tiene que fallar.
    const LIMITE = 30;
    expect(LIMITES_ESPACIOS.agregar_miembro).toEqual({ max: LIMITE, ventanaMs: 15 * 60_000 });
    const ana = await persona();
    const id = await nuevoEspacio(ana);
    const estados: number[] = [];
    for (let i = 0; i <= LIMITE; i++) {
      estados.push((await request(app).post(`/api/espacios/${id}/miembros`).set('authorization', ana.auth).send({ correo: correoUnico('enumera'), rol: 'lector' })).status);
    }
    expect(estados.slice(0, -1).every((s) => s === 404)).toBe(true);
    expect(estados.at(-1)).toBe(429);
  });

  it('cambiar rol: el propietario sí; la propiedad no se cambia (409); cuenta lectora a editora (409); no miembro (404)', async () => {
    const ana = await persona();
    const bruno = await persona();
    const leo = await persona('lector');
    const extrana = await persona();
    const id = await nuevoEspacio(ana);
    await agregar(ana, id, bruno, 'lector');
    await agregar(ana, id, leo, 'lector');
    const r = await request(app).patch(`/api/espacios/${id}/miembros/${bruno.id}`).set('authorization', ana.auth).send({ rol: 'editor' });
    expect([r.status, (r.body as MiembroCuerpo).rol]).toEqual([200, 'editor']);
    const prop = await request(app).patch(`/api/espacios/${id}/miembros/${ana.id}`).set('authorization', ana.auth).send({ rol: 'editor' });
    expect([prop.status, codigo(prop)]).toEqual([409, 'usar_transferencia']);
    const lec = await request(app).patch(`/api/espacios/${id}/miembros/${leo.id}`).set('authorization', ana.auth).send({ rol: 'editor' });
    expect([lec.status, codigo(lec)]).toEqual([409, 'rol_excede_cuenta']);
    const nm = await request(app).patch(`/api/espacios/${id}/miembros/${extrana.id}`).set('authorization', ana.auth).send({ rol: 'editor' });
    expect([nm.status, codigo(nm)]).toEqual([404, 'miembro_no_encontrado']);
    expect((await request(app).patch(`/api/espacios/${id}/miembros/${leo.id}`).set('authorization', bruno.auth).send({ rol: 'lector' })).status).toBe(403);
  });

  it('salir y quitar: cualquiera sale; el propietario no (409); un editor no quita a otros (403)', async () => {
    const ana = await persona();
    const bruno = await persona();
    const carla = await persona();
    const id = await nuevoEspacio(ana);
    await agregar(ana, id, bruno, 'editor');
    await agregar(ana, id, carla, 'lector');
    expect((await request(app).delete(`/api/espacios/${id}/miembros/${carla.id}`).set('authorization', bruno.auth)).status).toBe(403);
    expect((await request(app).delete(`/api/espacios/${id}/miembros/${carla.id}`).set('authorization', carla.auth)).status).toBe(204);
    const sale = await request(app).delete(`/api/espacios/${id}/miembros/${ana.id}`).set('authorization', ana.auth);
    expect([sale.status, codigo(sale)]).toEqual([409, 'propietario_no_sale']);
    expect((await request(app).get(`/api/espacios/${id}`).set('authorization', carla.auth)).status).toBe(404);
  });

  it('quitar a quien posee documentos del espacio: 409 con la lista; después de transferirlos, sí', async () => {
    const ana = await persona();
    const bruno = await persona();
    const id = await nuevoEspacio(ana);
    await agregar(ana, id, bruno, 'editor');
    const doc = await nuevoDocumento(bruno, id, 'Guía ficticia');
    const r = await request(app).delete(`/api/espacios/${id}/miembros/${bruno.id}`).set('authorization', ana.auth);
    expect([r.status, codigo(r)]).toEqual([409, 'propiedad_documentos']);
    expect((r.body as CuerpoError).error.detalles).toEqual([{ tipo: 'documento', id: doc, nombre: 'Guía ficticia' }]);
    expect((await request(app).post(`/api/documentos/${doc}/propiedad`).set('authorization', bruno.auth).send({ usuarioId: ana.id })).status).toBe(200);
    expect((await request(app).delete(`/api/espacios/${id}/miembros/${bruno.id}`).set('authorization', ana.auth)).status).toBe(204);
    // Sus permisos de documento se fueron en cascada.
    expect(await e.prisma.permisos_documento.count({ where: { documento_id: doc, usuario_id: bruno.id } })).toBe(0);
  });

  it('transferir el espacio: el nuevo queda propietario y el anterior editor', async () => {
    const ana = await persona();
    const bruno = await persona();
    const leo = await persona('lector');
    const extrana = await persona();
    const id = await nuevoEspacio(ana);
    await agregar(ana, id, bruno, 'lector');
    await agregar(ana, id, leo, 'lector');
    const lec = await request(app).post(`/api/espacios/${id}/propiedad`).set('authorization', ana.auth).send({ usuarioId: leo.id });
    expect([lec.status, codigo(lec)]).toEqual([409, 'rol_excede_cuenta']);
    expect((await request(app).post(`/api/espacios/${id}/propiedad`).set('authorization', ana.auth).send({ usuarioId: extrana.id })).status).toBe(404);
    expect((await request(app).post(`/api/espacios/${id}/propiedad`).set('authorization', bruno.auth).send({ usuarioId: bruno.id })).status).toBe(403);
    const r = await request(app).post(`/api/espacios/${id}/propiedad`).set('authorization', ana.auth).send({ usuarioId: bruno.id });
    expect(r.status).toBe(200);
    expect(rolesDe(r.body)).toMatchObject({ [ana.id]: 'editor', [bruno.id]: 'propietario' });
    // El anterior ya no puede administrar.
    expect((await request(app).patch(`/api/espacios/${id}`).set('authorization', ana.auth).send({ nombre: 'X' })).status).toBe(403);
  });

  it('tres altas simultáneas de la misma cuenta: una entra y las otras reciben 409 (no un 500)', async () => {
    const ana = await persona();
    const bruno = await persona();
    const id = await nuevoEspacio(ana);
    // Para que se SOLAPEN de verdad: otra conexión bloquea la fila de Bruno. La inserción en
    // miembros_espacio necesita esa fila (clave foránea), así que cada alta queda esperando justo antes de
    // insertar. Sin el bloqueo del espacio, las tres pasarían la comprobación "ya es miembro" y dos
    // chocarían con la clave primaria (500); con él, esperan en fila y ven que ya es miembro.
    const bloqueo = await e.pool.connect();
    try {
      await bloqueo.query('BEGIN');
      await bloqueo.query('SELECT 1 FROM usuarios WHERE id = $1 FOR UPDATE', [bruno.id]);
      const pedir = () => request(app).post(`/api/espacios/${id}/miembros`).set('authorization', ana.auth).send({ correo: bruno.correo, rol: 'lector' });
      const enCurso = Promise.all([pedir(), pedir(), pedir()]);
      await new Promise((r) => setTimeout(r, 500));
      await bloqueo.query('COMMIT');
      const estados = (await enCurso).map((r) => r.status).sort();
      expect(estados).toEqual([201, 409, 409]);
    } finally {
      bloqueo.release();
    }
  });
});
