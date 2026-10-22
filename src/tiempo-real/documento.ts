// Un documento abierto en memoria (ADR 0003): el Y.Doc que comparten todas sus conexiones, la presencia y
// el búfer de persistencia.
//
// Persistencia DIRECTA a la base (decisión escrita de K2): las actualizaciones aceptadas se agrupan por
// AUTOR y se insertan cada 250 ms (o al llegar a 256 KiB) como una fila de actualizaciones_documento. La
// base vuelve a exigir permiso de escritura en cada fila (trigger): si la rechaza (42501), el autor perdió
// el permiso, y eso dispara la revalidación inmediata de sus conexiones (R-01). Si el proceso muere con
// cambios en el búfer, no se pierden: los clientes los conservan y los reenvían al reconectar.
import type { Logger } from 'pino';
import { Awareness } from 'y-protocols/awareness';
import * as Y from 'yjs';
import type { PrismaClient } from '../generated/prisma/client.js';
import type { LimitesTiempoReal } from './limites.js';

/** El único texto del documento: el Markdown (ADR 0004). */
export const NOMBRE_TEXTO = 'contenido';
/** Origen de las actualizaciones que vienen de la base (no se vuelven a guardar ni a retransmitir). */
export const ORIGEN_CARGA = Symbol('carga');

/** SQLSTATE de un error de la base, como lo entrega Prisma con el adaptador pg. */
export function sqlstateDe(e: unknown): string | undefined {
  const c = (e as { meta?: { driverAdapterError?: { cause?: { originalCode?: unknown } } } } | null)?.meta?.driverAdapterError?.cause?.originalCode;
  return typeof c === 'string' ? c : undefined;
}

interface Pendiente {
  actualizaciones: Uint8Array[];
  bytes: number;
  fallos: number;
}

export interface OpcionesDocumento {
  prisma: PrismaClient;
  log: Logger;
  limites: LimitesTiempoReal;
  /** La base rechazó por permiso una escritura de este autor: revalidar sus conexiones ya. */
  alRechazoDeEscritura: (documentoId: string, autorId: string) => void;
  /** Pedir compactación (inmediata al juntar N filas; si no, por inactividad), con el autor de lo guardado. */
  pedirCompactacion: (documentoId: string, inmediata: boolean, autorId: string) => void;
}

export class DocumentoVivo {
  readonly ydoc = new Y.Doc();
  readonly awareness: Awareness;
  /** Tamaño aproximado (por exceso) del estado: el cargado más lo aplicado desde entonces. */
  tamano = 0;
  private filasSinCompactar = 0;
  private readonly pendientes = new Map<string, Pendiente>();
  private temporizador: ReturnType<typeof setInterval> | null = null;
  private vaciando: Promise<void> = Promise.resolve();

  private constructor(
    readonly id: string,
    private readonly o: OpcionesDocumento,
  ) {
    this.awareness = new Awareness(this.ydoc);
    this.awareness.setLocalState(null); // el servidor no tiene presencia propia
  }

  /** Carga el estado guardado y aplica encima el log, en orden. */
  static async cargar(id: string, o: OpcionesDocumento): Promise<DocumentoVivo> {
    const d = new DocumentoVivo(id, o);
    const doc = await o.prisma.$queryRaw<{ estado_yjs: Uint8Array | null }[]>`SELECT estado_yjs FROM documentos WHERE id = ${id}::uuid`;
    const filas = await o.prisma.$queryRaw<{ actualizacion: Uint8Array }[]>`
      SELECT actualizacion FROM actualizaciones_documento WHERE documento_id = ${id}::uuid ORDER BY id`;
    const estado = doc[0]?.estado_yjs;
    if (estado) Y.applyUpdate(d.ydoc, estado, ORIGEN_CARGA);
    for (const f of filas) Y.applyUpdate(d.ydoc, f.actualizacion, ORIGEN_CARGA);
    d.filasSinCompactar = filas.length;
    d.tamano = Y.encodeStateAsUpdate(d.ydoc).length;
    d.temporizador = setInterval(() => void d.vaciar(), o.limites.vaciarMs);
    return d;
  }

  /** ¿Cabe esta actualización sin pasar del tamaño máximo del documento? */
  cabe(actualizacion: Uint8Array): boolean {
    return this.tamano + actualizacion.length <= this.o.limites.documentoBytes;
  }

  /** Agrega al búfer del autor una actualización ya aplicada; vacía si el búfer llegó a su tope. */
  guardar(autorId: string, actualizacion: Uint8Array): void {
    this.tamano += actualizacion.length;
    const p = this.pendientes.get(autorId) ?? { actualizaciones: [], bytes: 0, fallos: 0 };
    p.actualizaciones.push(actualizacion);
    p.bytes += actualizacion.length;
    this.pendientes.set(autorId, p);
    if (p.bytes >= this.o.limites.vaciarBytes) void this.vaciar();
  }

  /** Descarta lo que tenga en el búfer un autor (perdió el permiso: no se guarda nada más de él). */
  descartarPendientes(autorId: string): void {
    this.pendientes.delete(autorId);
  }

  /** Inserta lo pendiente (una fila por autor). Las llamadas se encadenan: nunca dos vaciados a la vez. */
  vaciar(): Promise<void> {
    this.vaciando = this.vaciando.then(() => this.vaciarAhora());
    return this.vaciando;
  }

  private async vaciarAhora(): Promise<void> {
    for (const [autorId, p] of [...this.pendientes]) {
      if (p.actualizaciones.length === 0) continue;
      // Una COPIA: lo que guardar() agregue mientras se inserta no es parte de este lote (con el mismo
      // arreglo, el slice de abajo lo descartaba sin guardarlo; la prueba de convergencia lo encontró).
      const lote = p.actualizaciones.slice();
      const unida = Y.mergeUpdates(lote);
      try {
        await this.o.prisma.$executeRaw`
          INSERT INTO actualizaciones_documento (documento_id, autor_id, actualizacion)
          VALUES (${this.id}::uuid, ${autorId}::uuid, ${Buffer.from(unida)})`;
        if (this.pendientes.get(autorId) !== p) continue; // se descartó mientras se insertaba
        // Lo que llegó mientras se insertaba queda para el próximo vaciado.
        p.actualizaciones = p.actualizaciones.slice(lote.length);
        p.bytes = p.actualizaciones.reduce((t, a) => t + a.length, 0);
        p.fallos = 0;
        this.filasSinCompactar++;
        this.o.pedirCompactacion(this.id, this.filasSinCompactar >= this.o.limites.compactarFilas, autorId);
        if (this.filasSinCompactar >= this.o.limites.compactarFilas) this.filasSinCompactar = 0;
      } catch (err) {
        if (sqlstateDe(err) === '42501') {
          // La base dice que este autor ya no puede escribir: no se guarda nada más de él y se corta ya.
          this.pendientes.delete(autorId);
          this.o.log.warn({ documentoId: this.id, autorId }, 'tiempo real: la base rechazó una escritura (permiso)');
          this.o.alRechazoDeEscritura(this.id, autorId);
          continue;
        }
        // NO se descarta: el servidor ya tiene estos cambios en memoria, así que ningún cliente los
        // reenvía; si se borraran del búfer, la base los perdería. Se reintenta en el próximo vaciado.
        p.fallos++;
        this.o.log.error({ err, documentoId: this.id, autorId, fallos: p.fallos, pendientes: p.actualizaciones.length }, 'tiempo real: no se pudo guardar; se reintenta');
      }
      if (p.actualizaciones.length === 0) this.pendientes.delete(autorId);
    }
  }

  /** ¿Queda algo en el búfer sin guardar? (La descarga de memoria espera a que no quede nada.) */
  tienePendientes(): boolean {
    return [...this.pendientes.values()].some((p) => p.actualizaciones.length > 0);
  }

  /** Detiene el vaciado periódico después de vaciar lo que quede. */
  async cerrar(): Promise<void> {
    if (this.temporizador) clearInterval(this.temporizador);
    this.temporizador = null;
    await this.vaciar();
    this.awareness.destroy();
    this.ydoc.destroy();
  }
}
