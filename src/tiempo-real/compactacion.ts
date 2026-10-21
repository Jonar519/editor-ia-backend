// Compactación del log Yjs con BullMQ (ADR 0003). Se dispara:
//   - al juntar N filas sin compactar (job inmediato, uno a la vez por documento);
//   - 5 min después de la ÚLTIMA edición (job con retraso que se reprograma con cada edición: debounce).
// El trabajo pesado lo hace la base en una sola llamada: compactar_documento() escribe el estado y borra
// hasta un id (migración 0021). Aquí se arma ese estado y se comprueba antes de llamar.
import { Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';
import * as Y from 'yjs';
import type { PrismaClient } from '../generated/prisma/client.js';
import { NOMBRE_TEXTO } from './documento.js';

export const COLA_DOCUMENTOS = 'documentos';

const iguales = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((x, i) => x === b[i]);

/**
 * Compacta un documento: estado guardado + filas del log, en un estado nuevo. Comprueba que ese estado,
 * cargado de cero, tenga el MISMO texto y el MISMO vector de estado antes de entregarlo a la base.
 * Devuelve cuántas filas borró (0 si no había nada que compactar).
 */
export async function compactarDocumento(prisma: PrismaClient, documentoId: string): Promise<number> {
  const filas = await prisma.$queryRaw<{ id: bigint; actualizacion: Uint8Array }[]>`
    SELECT id, actualizacion FROM actualizaciones_documento WHERE documento_id = ${documentoId}::uuid ORDER BY id`;
  const ultima = filas.at(-1);
  if (!ultima) return 0;
  const doc = await prisma.$queryRaw<{ estado_yjs: Uint8Array | null }[]>`SELECT estado_yjs FROM documentos WHERE id = ${documentoId}::uuid`;
  if (doc.length === 0) return 0; // se borró mientras tanto

  const armado = new Y.Doc();
  const estadoPrevio = doc[0]?.estado_yjs;
  if (estadoPrevio) Y.applyUpdate(armado, estadoPrevio);
  for (const f of filas) Y.applyUpdate(armado, f.actualizacion);
  const estado = Y.encodeStateAsUpdate(armado);

  const comprobado = new Y.Doc();
  Y.applyUpdate(comprobado, estado);
  if (
    comprobado.getText(NOMBRE_TEXTO).toJSON() !== armado.getText(NOMBRE_TEXTO).toJSON() ||
    !iguales(Y.encodeStateVector(comprobado), Y.encodeStateVector(armado))
  ) {
    throw new Error('compactación: el estado nuevo no reproduce el documento; no se borra nada');
  }

  const r = await prisma.$queryRaw<{ n: bigint }[]>`
    SELECT compactar_documento(${documentoId}::uuid, ${ultima.id}, ${Buffer.from(estado)}) AS n`;
  return Number(r[0]?.n ?? 0);
}

export interface Compactador {
  /** Pide compactar: `inmediata` al juntar N filas; si no, 5 min después de la última llamada. */
  pedir: (documentoId: string, inmediata: boolean) => Promise<void>;
  cerrar: () => Promise<void>;
}

export function iniciarCompactacion(o: {
  redisUrl: string;
  prefijo: string;
  prisma: PrismaClient;
  log: Logger;
  inactividadMs: number;
}): Compactador {
  const connection = { url: o.redisUrl, maxRetriesPerRequest: null };
  const cola = new Queue(COLA_DOCUMENTOS, { connection, prefix: o.prefijo });
  const worker = new Worker(
    COLA_DOCUMENTOS,
    async (job) => {
      const { documentoId } = job.data as { documentoId: string };
      const borradas = await compactarDocumento(o.prisma, documentoId);
      o.log.info({ documentoId, borradas }, 'documento compactado');
      return borradas;
    },
    { connection, prefix: o.prefijo, concurrency: 2 },
  );
  worker.on('failed', (job, err) => {
    o.log.warn({ err, documentoId: (job?.data as { documentoId?: string } | undefined)?.documentoId }, 'compactación: falló (se reintenta)');
  });
  const reintentos = { attempts: 3, backoff: { type: 'exponential' as const, delay: 1000 }, removeOnComplete: 100, removeOnFail: 100 };
  return {
    pedir: async (documentoId, inmediata) => {
      if (inmediata) {
        await cola.add('compactar', { documentoId }, { ...reintentos, deduplication: { id: `ya:${documentoId}`, keepLastIfActive: true } });
      } else {
        await cola.add(
          'compactar',
          { documentoId },
          { ...reintentos, delay: o.inactividadMs, deduplication: { id: `inactivo:${documentoId}`, ttl: o.inactividadMs, extend: true, replace: true } },
        );
      }
    },
    cerrar: async () => {
      await worker.close();
      await cola.close();
    },
  };
}
