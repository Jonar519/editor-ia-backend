// Cliente Yjs de las pruebas de carga del WebSocket (bloque R): el mismo protocolo que el navegador
// (y-protocols sync sobre ws, ticket en el subprotocolo, Origin del frontend). Cada cambio escribe una
// letra en el texto y, en el mapa "carga", su número y el instante en que se mandó (reloj monótono del
// sistema: process.hrtime, el mismo para todos los procesos de la máquina). Quien lo recibe calcula la
// latencia de ida y vuelta por el servidor.
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import { readSyncMessage, writeSyncStep1 } from 'y-protocols/sync';
import * as Y from 'yjs';
import { WebSocket } from 'ws';

export const MAPA = 'carga';
const DESDE_SERVIDOR = 'servidor';

export const ahoraNs = (): bigint => process.hrtime.bigint();

export class ClienteCarga {
  readonly doc = new Y.Doc();
  readonly ws: WebSocket;
  /** Latencias (ms) de los cambios de OTROS clientes recibidos dentro de la ventana de medición. */
  readonly latencias: number[] = [];
  enviados = 0;
  recibidosEnVentana = 0;
  cierre: number | null = null;
  readonly sincronizado: Promise<void>;
  private seq = 0;
  /** Ventana de medición [inicio, fin) en ns del reloj monótono; fuera de ella no se cuenta. */
  ventana: { inicio: bigint; fin: bigint } = { inicio: 0n, fin: 0n };

  constructor(url: string, ticket: string, origen: string, readonly clave: string) {
    this.ws = new WebSocket(url, ['cuaderno.v1', `ticket.${ticket}`], { origin: origen });
    let listo: () => void = () => undefined;
    this.sincronizado = new Promise((r, rechazo) => {
      listo = r;
      this.ws.on('error', rechazo);
      this.ws.on('close', (codigo) => {
        this.cierre = codigo;
        rechazo(new Error(`cerrado antes de sincronizar (${String(codigo)})`));
      });
    });
    this.ws.on('open', () => {
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      writeSyncStep1(e, this.doc);
      this.ws.send(encoding.toUint8Array(e));
    });
    this.ws.on('message', (datos: Buffer) => {
      const dec = decoding.createDecoder(new Uint8Array(datos));
      if (decoding.readVarUint(dec) !== 0) return; // presencia y control: no se miden
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      const sub = readSyncMessage(dec, e, this.doc, DESDE_SERVIDOR);
      if (sub === 1) listo(); // paso 2: el estado del servidor ya está aplicado
      if (encoding.length(e) > 1) this.ws.send(encoding.toUint8Array(e));
    });
    const mapa = this.doc.getMap<string>(MAPA);
    mapa.observe((ev, tr) => {
      if (tr.origin !== DESDE_SERVIDOR) return;
      const ahora = ahoraNs();
      for (const k of ev.keysChanged as Set<string>) {
        if (k === this.clave) continue;
        const v = mapa.get(k);
        if (typeof v !== 'string') continue;
        const t0 = BigInt(v.slice(v.indexOf(':') + 1));
        if (t0 < this.ventana.inicio || t0 >= this.ventana.fin) continue;
        this.recibidosEnVentana++;
        this.latencias.push(Number(ahora - t0) / 1e6);
      }
    });
    this.doc.on('update', (u: Uint8Array, origen: unknown) => {
      if (origen === DESDE_SERVIDOR || this.ws.readyState !== WebSocket.OPEN) return;
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, 0);
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint8Array(e, u);
      this.ws.send(encoding.toUint8Array(e));
    });
  }

  /** Un cambio: una letra al final del texto y, en el mapa, "número:instante". */
  cambiar(): bigint {
    const t0 = ahoraNs();
    this.doc.transact(() => {
      const texto = this.doc.getText('contenido');
      texto.insert(texto.length, 'a');
      this.doc.getMap<string>(MAPA).set(this.clave, `${String(++this.seq)}:${String(t0)}`);
    });
    if (t0 >= this.ventana.inicio && t0 < this.ventana.fin) this.enviados++;
    return t0;
  }

  /** Huella del estado (texto y mapa) para comparar la convergencia entre clientes y con el servidor. */
  huella(): { largo: number; mapa: string } {
    const m = this.doc.getMap<string>(MAPA);
    return { largo: this.doc.getText('contenido').length, mapa: JSON.stringify([...m.entries()].sort(([a], [b]) => a.localeCompare(b))) };
  }

  get texto(): string {
    return this.doc.getText('contenido').toJSON();
  }

  cerrar(): void {
    this.ws.close(1000);
  }
}
