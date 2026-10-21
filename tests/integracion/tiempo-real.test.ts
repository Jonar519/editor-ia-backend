// Tiempo real (bloque K2) con sockets REALES, la base de PRUEBAS y Redis db 1: entrar con ticket, el
// guardia en cada mensaje, persistencia, revocación por los avisos de la base (< 1 s) y la ventana del
// riesgo residual R-01 medida con la revalidación en 300 ms.
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compactarDocumento } from '../../src/tiempo-real/compactacion.js';
import { DocumentoVivo } from '../../src/tiempo-real/documento.js';
import { CIERRE, LIMITES_PRODUCCION } from '../../src/tiempo-real/limites.js';
import { emitirTicket } from '../../src/tiempo-real/tickets.js';
import { conectar, esperar, estadoDelUpgrade, levantar, type Entorno } from '../_tiempo-real.js';

const proto = (t: string) => ['cuaderno.v1', `ticket.${t}`];

describe('valores de producción (aprobados al abrir K2)', () => {
  it('revalidación cada 30 s y el resto de límites', () => {
    expect(LIMITES_PRODUCCION).toMatchObject({
      ticketMs: 30_000,
      mensajeBytes: 1024 * 1024,
      mensajesPorSegundo: 60,
      documentoBytes: 10 * 1024 * 1024,
      colaEnvioBytes: 4 * 1024 * 1024,
      pingMs: 30_000,
      pongMs: 10_000,
      revalidarMs: 30_000,
      descargarMs: 60_000,
      vaciarMs: 250,
      descartadasMax: 3,
      compactarFilas: 200,
      compactarInactividadMs: 5 * 60_000,
    });
  });
});

describe('con avisos de la base', () => {
  let t: Entorno;
  beforeAll(async () => {
    t = await levantar();
  });
  afterAll(async () => {
    await t.cerrar();
  });

  it('entrar: sin ticket 401, otro Origin 403, ticket usado dos veces a la vez: uno entra y el otro 401', async () => {
    const ana = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    expect(await estadoDelUpgrade(t.url, ['cuaderno.v1'])).toBe(401);
    expect(await estadoDelUpgrade(t.url, proto(await t.ticket(ana, documentoId)), 'http://otro.example.com')).toBe(403);
    const tk = await t.ticket(ana, documentoId);
    const estados = await Promise.all([estadoDelUpgrade(t.url, proto(tk)), estadoDelUpgrade(t.url, proto(tk))]);
    expect(estados.sort()).toEqual([101, 401]);
  });

  it('entrar: un ticket vencido no sirve, y en Redis está solo su hash', async () => {
    const ana = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    const tk = await emitirTicket(t.e.deps.redis, t.e.deps.prefijoRedis, { usuarioId: ana.id, sesionId: ana.sesionId, documentoId }, 100);
    const claves = await t.e.deps.redis.keys(`${t.e.deps.prefijoRedis}ticket-rt:*`);
    expect(claves.length).toBeGreaterThan(0);
    expect(claves.join(' ')).not.toContain(tk);
    await new Promise((r) => setTimeout(r, 200));
    expect(await estadoDelUpgrade(t.url, proto(tk))).toBe(401);
  });

  it('pedir un ticket sin acceso al documento: 404 (no se revela si existe)', async () => {
    const ana = await t.persona();
    const extrana = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    const r = await request(t.app).post('/api/tiempo-real/tickets').set('authorization', extrana.auth).send({ documentoId });
    expect(r.status).toBe(404);
  });

  it('dos editores: lo que escribe uno le llega al otro y se guarda con su autoría', async () => {
    const ana = await t.persona();
    const bruno = await t.persona();
    const { documentoId } = await t.documentoCon(ana, [[bruno, 'editor']]);
    const a = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    const b = conectar(t.url, proto(await t.ticket(bruno, documentoId)));
    await Promise.all([a.abierto, b.abierto]);
    await esperar(() => a.rol === 'propietario' && b.rol === 'editor');
    a.escribir('# Guía');
    await esperar(() => b.texto === '# Guía');
    b.escribir(' ficticia');
    await esperar(() => a.texto === '# Guía ficticia');
    await esperar(async () => (await t.e.prisma.actualizaciones_documento.count({ where: { documento_id: documentoId } })) >= 2);
    const autores = await t.e.prisma.actualizaciones_documento.findMany({ where: { documento_id: documentoId }, select: { autor_id: true } });
    expect(new Set(autores.map((x) => x.autor_id))).toEqual(new Set([ana.id, bruno.id]));
    a.ws.close();
    b.ws.close();
  });

  it('GUARDIA: lo que manda un lector se descarta (no se aplica, no llega, no se guarda) y a la tercera se cierra con 4403', async () => {
    const ana = await t.persona();
    const carla = await t.persona();
    const { documentoId } = await t.documentoCon(ana, [[carla, 'lector']]);
    const a = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    const c = conectar(t.url, proto(await t.ticket(carla, documentoId)));
    await Promise.all([a.abierto, c.abierto]);
    await esperar(() => c.rol === 'lector');
    // Un cliente manipulado: escribe aunque sea lector.
    c.escribir('uno ');
    c.escribir('dos ');
    c.escribir('tres');
    const cierre = await c.cerrado;
    expect(cierre.codigo).toBe(CIERRE.sinPermiso);
    await new Promise((r) => setTimeout(r, 400)); // más que un vaciado del búfer
    expect(a.texto).toBe('');
    expect(a.recibidas).toBe(0);
    expect(await t.e.prisma.actualizaciones_documento.count({ where: { documento_id: documentoId } })).toBe(0);
    expect(t.lineas.filter((l) => l.msg === 'tiempo real: actualización descartada (sin permiso de escritura)' && l.usuarioId === carla.id)).toHaveLength(3);
    a.ws.close();
  });

  it('presencia: el nombre es el de la cuenta (no el que manda el cliente) y no se puede hablar por otro clientID', async () => {
    const ana = await t.persona();
    const bruno = await t.persona();
    const { documentoId } = await t.documentoCon(ana, [[bruno, 'lector']]);
    const a = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    const b = conectar(t.url, proto(await t.ticket(bruno, documentoId)));
    await Promise.all([a.abierto, b.abierto]);
    a.mandarPresencia({ cursor: 3, usuario: { nombre: 'Nombre Falso' } });
    await esperar(() => b.presencia.getStates().has(a.doc.clientID));
    expect(b.presencia.getStates().get(a.doc.clientID)).toEqual({ cursor: 3, usuario: { id: ana.id, nombre: ana.nombre } });
    b.mandarPresencia({ cursor: 99 }, a.doc.clientID); // Bruno intenta hablar como Ana
    await new Promise((r) => setTimeout(r, 300));
    expect(b.presencia.getStates().get(a.doc.clientID)).toMatchObject({ cursor: 3, usuario: { id: ana.id } }); // sigue siendo la de Ana
    a.ws.close();
    b.ws.close();
  });

  it('REVOCACIÓN: quitar a un miembro, cerrar su sesión o borrar el documento corta su conexión en menos de 1 s', async () => {
    const ana = await t.persona();
    const bruno = await t.persona();
    const carla = await t.persona();
    const { espacioId, documentoId } = await t.documentoCon(ana, [[bruno, 'editor'], [carla, 'editor']]);
    const b = conectar(t.url, proto(await t.ticket(bruno, documentoId)));
    const c = conectar(t.url, proto(await t.ticket(carla, documentoId)));
    const a = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    await Promise.all([a.abierto, b.abierto, c.abierto]);

    let inicio = Date.now();
    expect((await request(t.app).delete(`/api/espacios/${espacioId}/miembros/${bruno.id}`).set('authorization', ana.auth)).status).toBe(204);
    const cb = await b.cerrado;
    expect(cb.codigo).toBe(CIERRE.sinPermiso);
    const msMiembro = cb.en - inicio;

    inicio = Date.now();
    expect((await request(t.app).delete(`/api/cuenta/sesiones/${carla.sesionId}`).set('authorization', carla.auth)).status).toBe(204);
    const cc = await c.cerrado;
    expect(cc.codigo).toBe(CIERRE.sesionTerminada);
    const msSesion = cc.en - inicio;

    inicio = Date.now();
    expect((await request(t.app).delete(`/api/documentos/${documentoId}`).set('authorization', ana.auth)).status).toBe(204);
    const ca = await a.cerrado;
    expect(ca.codigo).toBe(CIERRE.documentoNoExiste);
    const msDocumento = ca.en - inicio;

    console.log(`[medido] revocación por aviso: miembro ${String(msMiembro)} ms, sesión ${String(msSesion)} ms, documento ${String(msDocumento)} ms`);
    for (const ms of [msMiembro, msSesion, msDocumento]) expect(ms).toBeLessThan(1000);
  });

  it('persistencia y compactación: el estado compactado reproduce el documento y el log queda vacío', async () => {
    const ana = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    const a = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    await a.abierto;
    for (const x of ['uno ', 'dos ', 'tres']) {
      a.escribir(x);
      await new Promise((r) => setTimeout(r, 300)); // un vaciado por escritura: varias filas
    }
    await esperar(async () => (await t.e.prisma.actualizaciones_documento.count({ where: { documento_id: documentoId } })) >= 3);
    expect(await compactarDocumento(t.e.prisma, documentoId)).toBeGreaterThanOrEqual(3);
    expect(await t.e.prisma.actualizaciones_documento.count({ where: { documento_id: documentoId } })).toBe(0);
    expect(await compactarDocumento(t.e.prisma, documentoId)).toBe(0); // nada más que compactar
    const recargado = await DocumentoVivo.cargar(documentoId, {
      prisma: t.e.prisma,
      log: (await import('pino')).pino({ level: 'silent' }),
      limites: LIMITES_PRODUCCION,
      alRechazoDeEscritura: () => undefined,
      pedirCompactacion: () => undefined,
    });
    expect(recargado.ydoc.getText('contenido').toJSON()).toBe('uno dos tres');
    await recargado.cerrar();
    a.ws.close();
  });

  it('un mensaje mal formado cierra con 4400; una ráfaga de más de 60 por segundo, con 4429', async () => {
    const ana = await t.persona();
    const { documentoId } = await t.documentoCon(ana);
    const x = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    await x.abierto;
    x.ws.send(Buffer.from([0, 9, 9, 9]));
    expect((await x.cerrado).codigo).toBe(CIERRE.malFormado);
    const y = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    await y.abierto;
    for (let i = 0; i < 80; i++) y.ws.send(Buffer.from([1, 1, 0])); // presencia vacía, válida
    expect((await y.cerrado).codigo).toBe(CIERRE.demasiadosMensajes);
  });
});

// ─── R-01: la ventana si se pierde un aviso (sin puente de avisos, revalidación en 300 ms) ───────────────

describe('R-01: ventana de revocación sin avisos', () => {
  let t: Entorno;
  beforeAll(async () => {
    t = await levantar({ avisos: false, limites: { revalidarMs: 300 } });
  });
  afterAll(async () => {
    await t.cerrar();
  });

  it('CONFIDENCIALIDAD: quien perdió el acceso y solo recibe queda cortado en la siguiente revalidación (≤ 300 ms + margen)', async () => {
    const ana = await t.persona();
    const carla = await t.persona();
    const { espacioId, documentoId } = await t.documentoCon(ana, [[carla, 'lector']]);
    const a = conectar(t.url, proto(await t.ticket(ana, documentoId)));
    const c = conectar(t.url, proto(await t.ticket(carla, documentoId)));
    await Promise.all([a.abierto, c.abierto]);
    const inicio = Date.now();
    expect((await request(t.app).delete(`/api/espacios/${espacioId}/miembros/${carla.id}`).set('authorization', ana.auth)).status).toBe(204);
    // Mientras tanto Ana escribe: lo que Carla reciba DESPUÉS del corte tiene que ser cero.
    const escritura = setInterval(() => {
      a.escribir('.');
    }, 50);
    const cierre = await c.cerrado;
    const recibidasAlCerrar = c.recibidas;
    await new Promise((r) => setTimeout(r, 300));
    clearInterval(escritura);
    const ms = cierre.en - inicio;
    console.log(`[medido] R-01 confidencialidad: corte a los ${String(ms)} ms; ${String(recibidasAlCerrar)} cambios recibidos en la ventana`);
    expect(cierre.codigo).toBe(CIERRE.sinPermiso);
    expect(ms).toBeLessThan(300 + 400);
    expect(c.recibidas).toBe(recibidasAlCerrar);
    a.ws.close();
  });

  it('INTEGRIDAD: un editor rebajado que sigue escribiendo queda cortado en cuanto la base rechaza su primera escritura (sin esperar la revalidación)', async () => {
    const lento = await levantar({ avisos: false, limites: { revalidarMs: 60_000 } }); // aísla el disparo por el rechazo de la base
    try {
      const ana = await lento.persona();
      const bruno = await lento.persona();
      const { espacioId, documentoId } = await lento.documentoCon(ana, [[bruno, 'editor']]);
      const a = conectar(lento.url, proto(await lento.ticket(ana, documentoId)));
      const b = conectar(lento.url, proto(await lento.ticket(bruno, documentoId)));
      await Promise.all([a.abierto, b.abierto]);
      const inicio = Date.now();
      expect(
        (await request(lento.app).patch(`/api/espacios/${espacioId}/miembros/${bruno.id}`).set('authorization', ana.auth).send({ rol: 'lector' })).status,
      ).toBe(200);
      const escritura = setInterval(() => {
        b.escribir('x');
      }, 20);
      const cierre = await b.cerrado;
      clearInterval(escritura);
      const enLaVentana = a.recibidas;
      await new Promise((r) => setTimeout(r, 400));
      const ms = cierre.en - inicio;
      console.log(`[medido] R-01 integridad: corte a los ${String(ms)} ms; ${String(enLaVentana)} cambios llegaron a otros en la ventana`);
      expect(cierre.codigo).toBe(CIERRE.sinPermiso);
      expect(ms).toBeLessThan(1000);
      expect(a.recibidas).toBe(enLaVentana); // después del corte: cero
      expect(lento.lineas.some((l) => l.msg === 'tiempo real: la base rechazó una escritura (permiso)')).toBe(true);
      a.ws.close();
    } finally {
      await lento.cerrar();
    }
  });
});
