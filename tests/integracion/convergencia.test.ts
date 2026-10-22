// Convergencia con semilla contra el servidor REAL y la base de pruebas (bloque M; era "no escrito" al
// cerrar K2). Varias réplicas con su Y.Doc PERSISTENTE (como la copia local del editor) se conectan por
// WebSocket, editan, se cortan de golpe (terminate: se pierde lo que iba en camino), editan sin conexión,
// reenvían mensajes DUPLICADOS y reconectan respondiendo al paso 1 del servidor con lo que le falta. A mitad
// se compacta la base. Al final, con todas en línea:
//   - las réplicas y el documento del servidor tienen el mismo texto;
//   - el documento RECONSTRUIDO DESDE LA BASE también;
//   - cada fragmento insertado y no borrado aparece EXACTAMENTE una vez, y ninguno borrado reaparece.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { pino } from 'pino';
import * as Y from 'yjs';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { compactarDocumento } from '../../src/tiempo-real/compactacion.js';
import { DocumentoVivo } from '../../src/tiempo-real/documento.js';
import { LIMITES_PRODUCCION } from '../../src/tiempo-real/limites.js';
import { APP_URL } from '../_api.js';
import { esperar, levantar, type Entorno, type Persona } from '../_tiempo-real.js';

/** PRNG con semilla (mulberry32). */
function azarCon(semilla: number) {
  let a = semilla >>> 0;
  const r = (): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { r, entero: (n: number) => Math.floor(r() * n), si: (p: number) => r() < p };
}

const DEL_SERVIDOR = Symbol('servidor');
const pausa = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Una réplica: su documento sobrevive a las desconexiones; la conexión va y viene. */
class Replica {
  readonly doc = new Y.Doc();
  ws: WebSocket | null = null;
  contador = 0;

  constructor(
    readonly i: number,
    readonly persona: Persona,
    private readonly t: Entorno,
    private readonly documentoId: string,
    private readonly azar: ReturnType<typeof azarCon>,
  ) {
    this.doc.on('update', (u: Uint8Array, origen: unknown) => {
      if (origen === DEL_SERVIDOR) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint8Array(e, u);
      this.mandar(encoding.toUint8Array(e));
    });
  }

  get texto(): string {
    return this.doc.getText('contenido').toJSON();
  }

  get conectada(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Manda (si hay conexión), a veces DOS veces. */
  private mandar(m: Uint8Array): void {
    if (!this.conectada) return;
    this.ws?.send(m);
    if (this.azar.si(0.1)) this.ws?.send(m);
  }

  async conectar(): Promise<void> {
    if (this.ws) return;
    const ticket = await this.t.ticket(this.persona, this.documentoId);
    const ws = new WebSocket(this.t.url, ['cuaderno.v1', `ticket.${ticket}`], { origin: APP_URL });
    this.ws = ws;
    ws.on('open', () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint8Array(e, Y.encodeStateVector(this.doc));
      ws.send(encoding.toUint8Array(e));
    });
    ws.on('message', (datos: Buffer) => {
      if (this.ws !== ws) return;
      const dec = decoding.createDecoder(new Uint8Array(datos));
      if (decoding.readVarUint(dec) !== 0) return; // presencia y control: no se prueban aquí
      const sub = decoding.readVarUint(dec);
      const carga = decoding.readVarUint8Array(dec);
      if (sub === 0) {
        // Paso 1 del servidor: se responde con TODO lo que no tiene (lo escrito sin conexión).
        const e = encoding.createEncoder();
        encoding.writeVarUint(e, 0);
        encoding.writeVarUint(e, 1);
        encoding.writeVarUint8Array(e, Y.encodeStateAsUpdate(this.doc, carga));
        this.mandar(encoding.toUint8Array(e));
      } else {
        // A veces llega dos veces (como un reintento): aplicarlo de nuevo no cambia nada.
        Y.applyUpdate(this.doc, carga, DEL_SERVIDOR);
        if (this.azar.si(0.1)) Y.applyUpdate(this.doc, carga, DEL_SERVIDOR);
      }
    });
    ws.on('close', () => {
      if (this.ws === ws) this.ws = null;
    });
    ws.on('error', () => undefined);
    await new Promise<void>((r) => {
      ws.once('open', () => {
        r();
      });
      ws.once('close', () => {
        r();
      });
    });
  }

  /** Corte abrupto: sin cierre ordenado; lo que iba en camino puede perderse. */
  cortar(): void {
    const ws = this.ws;
    this.ws = null;
    ws?.terminate();
  }
}

describe('convergencia con semilla contra el servidor real y la base', () => {
  let t: Entorno;
  beforeAll(async () => {
    t = await levantar({ avisos: false });
  });
  afterAll(async () => {
    await t.cerrar();
  });

  it.each([11, 23, 37, 41, 53])('semilla %i: 3 réplicas, cortes, ediciones sin conexión, duplicados y compactación', async (semilla) => {
    const azar = azarCon(semilla);
    const dueno = await t.persona('editor');
    const otros = [await t.persona('editor'), await t.persona('editor')];
    const { documentoId } = await t.documentoCon(dueno, otros.map((p) => [p, 'editor'] as [Persona, 'editor']));
    const replicas = [dueno, ...otros].map((p, i) => new Replica(i, p, t, documentoId, azar));
    for (const rep of replicas) await rep.conectar();
    const insertados = new Set<string>();
    const borrados = new Set<string>();

    for (let paso = 0; paso < 120; paso++) {
      const rep = replicas[azar.entero(replicas.length)];
      if (!rep) continue;
      const texto = rep.doc.getText('contenido');
      const tirada = azar.r();
      if (tirada < 0.5) {
        const frag = `<${String(rep.i)}.${String(rep.contador++)}>`;
        const bordes = [0, ...[...rep.texto.matchAll(/>/g)].map((m) => m.index + 1)];
        texto.insert(bordes[azar.entero(bordes.length)] ?? 0, frag);
        insertados.add(frag);
      } else if (tirada < 0.65) {
        const vistos = [...rep.texto.matchAll(/<\d+\.\d+>/g)];
        const elegido = vistos[azar.entero(vistos.length)];
        if (elegido) {
          texto.delete(elegido.index, elegido[0].length);
          borrados.add(elegido[0]);
        }
      } else if (tirada < 0.75) {
        rep.cortar();
      } else if (tirada < 0.9) {
        await rep.conectar();
      } else if (tirada < 0.93) {
        // Compactar a mitad de las ediciones (como el trabajo de BullMQ).
        await compactarDocumento(t.e.prisma, documentoId);
      }
      // Ritmo: por debajo del límite de mensajes por segundo de cada conexión.
      await pausa(5 + azar.entero(10));
    }

    // Sanar: todas en línea y esperar a que coincidan.
    for (const rep of replicas) await rep.conectar();
    // El documento en memoria del servidor (campo privado: solo para mirar, no se modifica).
    const servidorTexto = async () => (await t.rt['documentos'].get(documentoId))?.ydoc.getText('contenido').toJSON();
    await esperar(async () => {
      const s = await servidorTexto();
      return replicas.every((rep) => rep.texto === s);
    }, 10_000);
    const final = (await servidorTexto()) ?? '';
    const contexto = `semilla ${String(semilla)}`;

    for (const f of insertados) expect(final.split(f).length - 1, `${contexto}: ${f}`).toBe(borrados.has(f) ? 0 : 1);

    // La base: esperar el vaciado del búfer y reconstruir el documento desde las filas.
    const desdeBase = async () => {
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
    let base = '';
    await esperar(async () => (base = await desdeBase()) === final, 5000).catch(() => undefined);
    // Si falla, la diferencia dice qué fragmentos faltan en la base (o sobran).
    expect(base, `${contexto}: documento reconstruido desde la base`).toBe(final);
    for (const rep of replicas) rep.cortar();
  });
});
