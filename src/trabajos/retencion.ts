// Retención diaria: un job de BullMQ agendado todos los días a las 03:15 UTC que llama a
// purgar_retencion() en la base (migración 0019). Los PLAZOS viven en la base, no aquí: el job solo
// decide CUÁNDO se ejecuta. Detalle en docs/data-retention.md.
//
// upsertJobScheduler es idempotente: si arrancan varias instancias del API, el agendado es uno solo y
// cada ejecución la toma un único worker.
import { Queue, Worker } from 'bullmq';
import type { Logger } from 'pino';
import type { PrismaClient } from '../generated/prisma/client.js';

export const COLA_RETENCION = 'retencion';
export const AGENDA_RETENCION = 'retencion-diaria';
/** Todos los días a las 03:15 UTC (hora de poco uso; UTC para no depender de la zona del servidor). */
export const PATRON_RETENCION = '15 3 * * *';
export const ZONA_RETENCION = 'UTC';

export type ResultadoRetencion = Record<string, number>;

/** Ejecuta la purga una vez y devuelve cuántas filas borró por tabla. */
export async function ejecutarRetencion(prisma: PrismaClient): Promise<ResultadoRetencion> {
  const filas = await prisma.$queryRaw<{ tabla: string; borradas: bigint }[]>`SELECT tabla, borradas FROM purgar_retencion()`;
  return Object.fromEntries(filas.map((f) => [f.tabla, Number(f.borradas)]));
}

export interface Retencion {
  cola: Queue;
  worker: Worker;
  cerrar: () => Promise<void>;
}

/**
 * Agenda el job diario y arranca su worker. `redisUrl` abre conexiones propias de BullMQ (el worker
 * necesita una bloqueante y maxRetriesPerRequest: null); `prefijo` separa sus claves.
 */
export async function iniciarRetencion(o: { redisUrl: string; prefijo: string; prisma: PrismaClient; log: Logger }): Promise<Retencion> {
  const connection = { url: o.redisUrl, maxRetriesPerRequest: null };
  const cola = new Queue(COLA_RETENCION, { connection, prefix: o.prefijo });
  await cola.upsertJobScheduler(
    AGENDA_RETENCION,
    { pattern: PATRON_RETENCION, tz: ZONA_RETENCION },
    { name: 'purgar', opts: { removeOnComplete: 30, removeOnFail: 30 } },
  );
  const worker = new Worker(
    COLA_RETENCION,
    async () => {
      const resultado = await ejecutarRetencion(o.prisma);
      o.log.info({ retencion: resultado }, 'retención diaria ejecutada');
      return resultado;
    },
    { connection, prefix: o.prefijo, concurrency: 1 },
  );
  worker.on('failed', (_job, err) => {
    o.log.error({ err }, 'retención diaria: falló');
  });
  return {
    cola,
    worker,
    cerrar: async () => {
      await worker.close();
      await cola.close();
    },
  };
}
