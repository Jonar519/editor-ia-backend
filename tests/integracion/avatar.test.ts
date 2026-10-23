// Avatar de punta a punta: se guarda SOLO la versión limpia; un archivo no analizable se rechaza sin
// guardar nada; se sirve con cabeceras que impiden interpretarlo como documento.
import { readFileSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appApi, cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';

const CANARIO = 'CANARIO-GPS-19.4326N-99.1332W';
const JPEG = readFileSync(new URL('../fixtures/cuadrito.jpg', import.meta.url));

/** El JPEG de prueba con un EXIF que lleva el canario y un ZIP pegado después del fin. */
function jpegConExif(): Buffer {
  const cuerpo = Buffer.from(`Exif\0\0MM\0*GPSLatitude ${CANARIO}`);
  const largo = Buffer.alloc(2);
  largo.writeUInt16BE(cuerpo.length + 2);
  return Buffer.concat([JPEG.subarray(0, 2), Buffer.from([0xff, 0xe1]), largo, cuerpo, JPEG.subarray(2), Buffer.from(`PK\x03\x04${CANARIO}`)]);
}

interface CuerpoError {
  error: { codigo: string };
}

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});

async function entrar(app: ReturnType<typeof appApi>) {
  const c = await cuentaActiva(e.prisma);
  const r = await request(app).post('/api/auth/sesion').send({ correo: c.correo, contrasena: c.contrasena });
  return { c, acceso: (r.body as { accessToken: string }).accessToken };
}

const datosGuardados = async (usuarioId: string) => {
  const a = await e.prisma.avatares.findUnique({ where: { usuario_id: usuarioId } });
  return a ? Buffer.from(a.datos) : null;
};

describe('avatar', () => {
  it('guarda la versión LIMPIA (sin EXIF/GPS ni datos pegados) y la sirve igual, con cabeceras seguras', async () => {
    const app = appApi(e.deps);
    const { c, acceso } = await entrar(app);
    const r = await request(app).put('/api/cuenta/avatar').set('authorization', `Bearer ${acceso}`).set('content-type', 'image/jpeg').send(jpegConExif());
    expect(r.status).toBe(200);
    expect(r.body).toMatchObject({ tipo: 'image/jpeg', ancho: 8, alto: 8 });
    const guardado = await datosGuardados(c.id);
    expect(guardado?.includes(Buffer.from(CANARIO))).toBe(false);
    expect(guardado?.includes(Buffer.from('Exif'))).toBe(false);

    const g = await request(app).get(`/api/usuarios/${c.id}/avatar`).set('authorization', `Bearer ${acceso}`).buffer(true);
    expect(g.status).toBe(200);
    expect(g.headers['content-type']).toBe('image/jpeg');
    expect(g.headers['x-content-type-options']).toBe('nosniff');
    expect(g.headers['content-security-policy']).toBe("default-src 'none'; sandbox");
    expect(Buffer.from(g.body as Buffer).equals(guardado ?? Buffer.alloc(0))).toBe(true);
    // ETag: si no cambió, 304 sin cuerpo.
    const etag = String(g.headers.etag);
    expect(etag).toBe(`"${(r.body as { hash: string }).hash}"`);
    const r304 = await request(app).get(`/api/usuarios/${c.id}/avatar`).set('authorization', `Bearer ${acceso}`).set('if-none-match', etag);
    expect(r304.status).toBe(304);
    expect(await e.prisma.eventos_seguridad.count({ where: { usuario_id: c.id, tipo: 'avatar_actualizado' } })).toBe(1);
  });

  it('un archivo no analizable se rechaza (422) y NO se guarda nada; el avatar anterior queda intacto', async () => {
    const app = appApi(e.deps);
    const { c, acceso } = await entrar(app);
    await request(app).put('/api/cuenta/avatar').set('authorization', `Bearer ${acceso}`).set('content-type', 'image/jpeg').send(JPEG);
    const antes = await datosGuardados(c.id);

    const roto = Buffer.concat([JPEG.subarray(0, 200), Buffer.from(CANARIO)]); // JPEG truncado con el canario
    const r = await request(app).put('/api/cuenta/avatar').set('authorization', `Bearer ${acceso}`).set('content-type', 'image/jpeg').send(roto);
    expect(r.status).toBe(422);
    expect((r.body as CuerpoError).error.codigo).toBe('imagen_no_valida');
    expect((await datosGuardados(c.id))?.equals(antes ?? Buffer.alloc(1))).toBe(true);
    // Ni el original ni un pedazo quedaron en la tabla.
    const conCanario = await e.prisma.$queryRaw<{ n: bigint }[]>`
      SELECT count(*) AS n FROM avatares WHERE position(${Buffer.from(CANARIO)}::bytea IN datos) > 0`;
    expect(Number(conCanario[0]?.n)).toBe(0);
  });

  it('un SVG o un GIF con Content-Type de imagen se rechaza: decide la firma de bytes', async () => {
    const app = appApi(e.deps);
    const { c, acceso } = await entrar(app);
    const svg = await request(app).put('/api/cuenta/avatar').set('authorization', `Bearer ${acceso}`).set('content-type', 'image/png').send(Buffer.from('<svg onload="alert(1)"/>'));
    expect(svg.status).toBe(422);
    expect(await datosGuardados(c.id)).toBeNull();
  });

  it('imagen comprimida (Content-Encoding: gzip) → 415 sin descomprimirla, y no se guarda nada (GHSA-27r3-jxmh-p828)', async () => {
    const app = appApi(e.deps);
    const { c, acceso } = await entrar(app);
    const r = await request(app)
      .put('/api/cuenta/avatar')
      .set('authorization', `Bearer ${acceso}`)
      .set('content-type', 'image/jpeg')
      .set('content-encoding', 'gzip')
      .send(gzipSync(JPEG));
    expect(r.status).toBe(415);
    expect((r.body as CuerpoError).error.codigo).toBe('codificacion_no_admitida');
    expect(await datosGuardados(c.id)).toBeNull();
  });

  it('otro Content-Type: 415; más de 1 MiB: 413', async () => {
    const app = appApi(e.deps);
    const { acceso } = await entrar(app);
    const texto = await request(app).put('/api/cuenta/avatar').set('authorization', `Bearer ${acceso}`).set('content-type', 'text/plain').send('hola');
    expect(texto.status).toBe(415);
    const grande = Buffer.concat([JPEG, Buffer.alloc(1024 * 1024)]);
    const r = await request(app).put('/api/cuenta/avatar').set('authorization', `Bearer ${acceso}`).set('content-type', 'image/jpeg').send(grande);
    expect(r.status).toBe(413);
  });

  it('borrar el avatar: 204 y luego 404', async () => {
    const app = appApi(e.deps);
    const { c, acceso } = await entrar(app);
    await request(app).put('/api/cuenta/avatar').set('authorization', `Bearer ${acceso}`).set('content-type', 'image/jpeg').send(JPEG);
    expect((await request(app).delete('/api/cuenta/avatar').set('authorization', `Bearer ${acceso}`)).status).toBe(204);
    expect((await request(app).get(`/api/usuarios/${c.id}/avatar`).set('authorization', `Bearer ${acceso}`)).status).toBe(404);
  });

  it('ver un avatar exige sesión', async () => {
    const app = appApi(e.deps);
    const { c } = await entrar(app);
    expect((await request(app).get(`/api/usuarios/${c.id}/avatar`)).status).toBe(401);
  });
});
