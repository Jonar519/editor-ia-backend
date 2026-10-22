// Indexado para la búsqueda semántica (bloque P1): un trabajo de BullMQ toma el texto GUARDADO del
// documento, lo parte en fragmentos, pide sus vectores al servicio de IA (IndexarDocumento, streaming del
// cliente) y reemplaza los embeddings del documento en una transacción.
//
// Aislamiento (tres capas):
//   1. El API verifica el rol ANTES de encolar (404 sin acceso, 403 si es lector).
//   2. El trabajo vuelve a verificarlo al correr (el permiso pudo cambiar en la cola): sin acceso, no
//      llama a la IA ni escribe nada.
//   3. La base: la clave foránea compuesta ata cada fila al espacio de su documento, y el trigger
//      embeddings_aislamiento rechaza un indexado_por sin acceso (migración 0011).
import { createHash, randomUUID } from 'node:crypto';
import { Queue, UnrecoverableError, Worker } from 'bullmq';
import type { Logger } from 'pino';
import { rolEnDocumento } from '../contenido/acceso.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { documentoGuardado } from '../tiempo-real/compactacion.js';
import { NOMBRE_TEXTO } from '../tiempo-real/documento.js';
import type { ClienteIa } from './cliente.js';
import { DIMENSIONES } from './contrato.js';
import { registrarUso, reservarUso, type TopesIa } from './uso.js';

export const COLA_INDICE = 'indice-ia';

/** Tamaño de cada fragmento (la base admite hasta 4000) y cuántos por documento como máximo. */
export const FRAGMENTOS = { caracteres: 1500, maximo: 1000 } as const;

/**
 * Parte el texto en fragmentos de hasta `caracteres`: junta párrafos (separados por una línea en blanco)
 * mientras quepan, y corta un párrafo más largo en trozos. Sin fragmentos vacíos.
 */
export function fragmentar(texto: string, caracteres: number = FRAGMENTOS.caracteres): string[] {
  const parrafos = texto
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter(Boolean);
  const salida: string[] = [];
  let actual = '';
  for (const p of parrafos) {
    if (p.length > caracteres) {
      if (actual) salida.push(actual);
      actual = '';
      for (let i = 0; i < p.length; i += caracteres) salida.push(p.slice(i, i + caracteres).trim());
      continue;
    }
    if (actual && actual.length + 2 + p.length > caracteres) {
      salida.push(actual);
      actual = p;
    } else {
      actual = actual ? `${actual}\n\n${p}` : p;
    }
  }
  if (actual) salida.push(actual);
  return salida.filter(Boolean);
}

const sha256 = (t: string) => createHash('sha256').update(t).digest();

export type ResultadoIndexado = 'indexado' | 'sin_cambios' | 'vacio' | 'sin_acceso' | 'no_existe';

export interface DepsIndexado {
  prisma: PrismaClient;
  ia: ClienteIa;
  topes: TopesIa;
}

/**
 * Indexa un documento en nombre de `usuarioId`. Si nada cambió (mismos fragmentos, mismos hashes), no
 * llama a la IA. Devuelve qué pasó; los errores de la IA (gRPC) y el tope diario se lanzan.
 */
export async function indexarDocumento(d: DepsIndexado, documentoId: string, usuarioId: string, solicitudId: string): Promise<{ resultado: ResultadoIndexado; fragmentos: number }> {
  const acceso = await rolEnDocumento(d.prisma, usuarioId, documentoId);
  if (!acceso) return { resultado: 'sin_acceso', fragmentos: 0 };
  const doc = await documentoGuardado(d.prisma, documentoId);
  if (!doc) return { resultado: 'no_existe', fragmentos: 0 };
  const fragmentos = fragmentar(doc.getText(NOMBRE_TEXTO).toJSON()).slice(0, FRAGMENTOS.maximo);
  const hashes = fragmentos.map(sha256);

  const existentes = await d.prisma.$queryRaw<{ fragmento: number; hash_texto: Uint8Array }[]>`
    SELECT fragmento, hash_texto FROM embeddings WHERE documento_id = ${documentoId}::uuid ORDER BY fragmento`;
  const iguales =
    existentes.length === hashes.length && existentes.every((e, i) => e.fragmento === i && Buffer.from(e.hash_texto).equals(hashes[i] ?? Buffer.alloc(0)));
  if (iguales) return { resultado: fragmentos.length === 0 ? 'vacio' : 'sin_cambios', fragmentos: fragmentos.length };
  if (fragmentos.length === 0) {
    await d.prisma.$executeRaw`DELETE FROM embeddings WHERE documento_id = ${documentoId}::uuid`;
    return { resultado: 'vacio', fragmentos: 0 };
  }

  await reservarUso(d.prisma, usuarioId, d.topes);
  const r = await d.ia.indexar(
    { cuentaId: usuarioId, espacioId: acceso.espacioId, documentoId, solicitudId },
    fragmentos.map((contenido, indice) => ({ indice, contenido })),
  );
  await registrarUso(d.prisma, usuarioId, r.uso);
  const vectores = fragmentos.map((_, i) => r.vectores.get(i));
  if (vectores.some((v) => v?.length !== DIMENSIONES)) throw new Error(`indexado: el servicio no devolvió ${String(fragmentos.length)} vectores de ${String(DIMENSIONES)}`);
  if (!/^.{1,100}$/.test(r.modelo)) throw new Error('indexado: el servicio no informó el modelo de embeddings');

  await d.prisma.$transaction(async (tx) => {
    await tx.$executeRaw`DELETE FROM embeddings WHERE documento_id = ${documentoId}::uuid`;
    for (const [i, texto] of fragmentos.entries()) {
      await tx.$executeRaw`
        INSERT INTO embeddings (documento_id, espacio_id, fragmento, texto, hash_texto, modelo, embedding, indexado_por)
        VALUES (${documentoId}::uuid, ${acceso.espacioId}::uuid, ${i}::int, ${texto}, ${hashes[i]}, ${r.modelo},
                ${`[${(vectores[i] ?? []).join(',')}]`}::vector, ${usuarioId}::uuid)`;
    }
  });
  return { resultado: 'indexado', fragmentos: fragmentos.length };
}

export interface Indexador {
  /** Encola el indexado (uno a la vez por documento: si ya hay uno esperando, no se duplica). */
  pedir: (documentoId: string, usuarioId: string) => Promise<void>;
  cerrar: () => Promise<void>;
}

export function iniciarIndexado(o: DepsIndexado & { redisUrl: string; prefijo: string; log: Logger }): Indexador {
  const connection = { url: o.redisUrl, maxRetriesPerRequest: null };
  const cola = new Queue(COLA_INDICE, { connection, prefix: o.prefijo });
  const worker = new Worker(
    COLA_INDICE,
    async (job) => {
      const { documentoId, usuarioId } = job.data as { documentoId: string; usuarioId: string };
      try {
        const r = await indexarDocumento(o, documentoId, usuarioId, job.id ?? randomUUID());
        o.log.info({ documentoId, usuarioId, ...r }, 'ia: documento indexado');
        return r;
      } catch (err) {
        // Sin tope o con un pedido inválido no tiene sentido reintentar.
        const codigo = (err as { codigo?: unknown; code?: unknown }).codigo;
        if (codigo === 'tope_diario_ia') throw new UnrecoverableError('tope diario de IA');
        throw err;
      }
    },
    { connection, prefix: o.prefijo, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    o.log.warn({ err, documentoId: (job?.data as { documentoId?: string } | undefined)?.documentoId }, 'ia: indexado falló');
  });
  return {
    pedir: async (documentoId, usuarioId) => {
      await cola.add(
        'indexar',
        { documentoId, usuarioId },
        { attempts: 3, backoff: { type: 'exponential', delay: 2000 }, removeOnComplete: 100, removeOnFail: 100, deduplication: { id: `indice:${documentoId}` } },
      );
    },
    cerrar: async () => {
      await worker.close();
      await cola.close();
    },
  };
}
