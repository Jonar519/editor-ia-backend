// Apoyo para probar el tiempo real con sockets REALES: el API escuchando en un puerto libre, el servidor
// WebSocket adjunto, los avisos de la base (opcional) y un cliente Yjs mínimo.
import type { AddressInfo } from 'node:net';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import request from 'supertest';
import * as awarenessProtocol from 'y-protocols/awareness';
import { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { crearApi } from '../src/api.js';
import { iniciarAvisos, type Avisos } from '../src/tiempo-real/avisos.js';
import { LIMITES_PRODUCCION, type LimitesTiempoReal } from '../src/tiempo-real/limites.js';
import { ServidorTiempoReal } from '../src/tiempo-real/servidor.js';
import { accesoDirecto, APP_URL, cuentaActiva, entornoApi } from './_api.js';
import { appDePrueba, loggerEnMemoria, urlBdPruebas } from './_apoyo.js';

export type Persona = Awaited<ReturnType<typeof cuentaActiva>> & { sesionId: string; auth: string };

export async function levantar(o: { limites?: Partial<LimitesTiempoReal>; avisos?: boolean } = {}) {
  const e = await entornoApi();
  const { app } = appDePrueba({ api: crearApi(e.deps) });
  const servidor = app.listen(0, '127.0.0.1');
  await new Promise((r) => servidor.once('listening', r));
  const puerto = (servidor.address() as AddressInfo).port;
  const { log, lineas } = loggerEnMemoria();
  const rt = new ServidorTiempoReal({
    prisma: e.prisma,
    redis: e.deps.redis,
    prefijoRedis: e.deps.prefijoRedis,
    appUrl: APP_URL,
    log,
    limites: { ...LIMITES_PRODUCCION, ...o.limites },
    pedirCompactacion: null,
  });
  rt.adjuntar(servidor);
  let avisos: Avisos | null = null;
  if (o.avisos !== false) {
    avisos = iniciarAvisos({
      databaseUrl: urlBdPruebas(),
      redis: e.deps.redis,
      prefijo: e.deps.prefijoRedis,
      log,
      alAviso: (a) => {
        rt.aviso(a);
      },
      alReconectar: () => {
        rt.revalidarTodas();
      },
    });
    await new Promise((r) => setTimeout(r, 300)); // que el LISTEN y la suscripción estén listos
  }

  async function persona(rol: 'editor' | 'lector' = 'editor'): Promise<Persona> {
    const c = await cuentaActiva(e.prisma, rol, e.deps.claveMfa);
    const { token, sesionId } = await accesoDirecto(e.deps, c.id);
    return { ...c, sesionId, auth: `Bearer ${token}` };
  }

  /** Espacio de `dueno` con un documento suyo; agrega a los demás con su rol de espacio. */
  async function documentoCon(dueno: Persona, otros: [Persona, 'editor' | 'lector'][] = []) {
    const esp = await request(app).post('/api/espacios').set('authorization', dueno.auth).send({ nombre: 'Equipo ficticio' });
    const espacioId = (esp.body as { id: string }).id;
    for (const [p, rol] of otros) {
      await request(app).post(`/api/espacios/${espacioId}/miembros`).set('authorization', dueno.auth).send({ correo: p.correo, rol });
    }
    const doc = await request(app).post(`/api/espacios/${espacioId}/documentos`).set('authorization', dueno.auth).send({ titulo: 'Documento ficticio' });
    return { espacioId, documentoId: (doc.body as { id: string }).id };
  }

  async function ticket(p: Persona, documentoId: string): Promise<string> {
    const r = await request(app).post('/api/tiempo-real/tickets').set('authorization', p.auth).send({ documentoId });
    if (r.status !== 201) throw new Error(`ticket: ${String(r.status)}`);
    return (r.body as { ticket: string }).ticket;
  }

  return {
    e,
    app,
    rt,
    lineas,
    puerto,
    persona,
    documentoCon,
    ticket,
    url: `ws://127.0.0.1:${String(puerto)}/api/tiempo-real`,
    cerrar: async () => {
      await rt.cerrar();
      await avisos?.cerrar();
      await new Promise((r) => servidor.close(r));
      await e.cerrar();
    },
  };
}

export type Entorno = Awaited<ReturnType<typeof levantar>>;

export interface Cierre {
  codigo: number;
  en: number;
}

/** Cliente Yjs mínimo: sincroniza, manda sus cambios y guarda lo que recibe. */
export class Cliente {
  readonly doc = new Y.Doc();
  readonly presencia = new awarenessProtocol.Awareness(this.doc);
  rol: string | null = null;
  recibidas = 0;
  readonly cerrado: Promise<Cierre>;
  readonly abierto: Promise<void>;

  constructor(readonly ws: WebSocket) {
    this.cerrado = new Promise((r) => ws.on('close', (codigo) => { r({ codigo, en: Date.now() }); }));
    this.abierto = new Promise((r, rechazo) => {
      ws.on('open', () => {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        writeSyncStep1(e, this.doc);
        ws.send(encoding.toUint8Array(e));
        r();
      });
      ws.on('error', rechazo);
    });
    ws.on('message', (datos: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(datos));
      const tipo = decoding.readVarUint(dec);
      if (tipo === 0) {
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        const sub = readSyncMessage(dec, e, this.doc, 'servidor');
        if (sub === 2) this.recibidas++;
        if (encoding.length(e) > 1) ws.send(encoding.toUint8Array(e));
      } else if (tipo === 1) {
        awarenessProtocol.applyAwarenessUpdate(this.presencia, decoding.readVarUint8Array(dec), 'servidor');
      } else if (tipo === 2) {
        this.rol = (JSON.parse(decoding.readVarString(dec)) as { rol: string }).rol;
      }
    });
    this.doc.on('update', (u: Uint8Array, origen: unknown) => {
      if (origen === 'servidor' || ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint8Array(e, u);
      ws.send(encoding.toUint8Array(e));
    });
  }

  get texto(): string {
    return this.doc.getText('contenido').toJSON();
  }

  escribir(t: string): void {
    const x = this.doc.getText('contenido');
    x.insert(x.length, t);
  }

  /** Manda presencia propia (con lo que el cliente quiera poner, incluido un nombre falso). */
  mandarPresencia(estado: Record<string, unknown>, clientId = this.doc.clientID): void {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, 1);
    encoding.writeVarUint(e, clientId);
    encoding.writeVarUint(e, 1);
    encoding.writeVarString(e, JSON.stringify(estado));
    const m = encoding.createEncoder();
    encoding.writeVarUint(m, 1);
    encoding.writeVarUint8Array(m, encoding.toUint8Array(e));
    this.ws.send(encoding.toUint8Array(m));
  }
}

export function conectar(url: string, protocolos: string[], origen = APP_URL): Cliente {
  return new Cliente(new WebSocket(url, protocolos, { origin: origen }));
}

/** Estado HTTP con el que el servidor rechazó el upgrade (o 101 si abrió). */
export function estadoDelUpgrade(url: string, protocolos: string[], origen = APP_URL): Promise<number> {
  return new Promise((r) => {
    const ws = new WebSocket(url, protocolos, { origin: origen });
    ws.on('open', () => {
      ws.close();
      r(101);
    });
    ws.on('unexpected-response', (_req, res) => {
      r(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.on('error', () => undefined);
  });
}

/** Espera hasta que la condición se cumpla (o falla a los `ms`). */
export async function esperar(cond: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const limite = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > limite) throw new Error('la condición no se cumplió a tiempo');
    await new Promise((r) => setTimeout(r, 20));
  }
}
