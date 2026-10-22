// Indexado para la búsqueda semántica (bloques P1 y P2): un trabajo de BullMQ toma el texto GUARDADO del
// documento, lo parte en fragmentos, pide sus vectores al servicio de IA (IndexarDocumento, streaming del
// cliente) y reemplaza los embeddings del documento en una transacción.
//
// Dos formas de pedirlo:
//   - A MANO (POST /api/documentos/:id/indice): en nombre de quien lo pide, contra SU tope diario.
//   - AUTOMÁTICO (P2), cuando el documento lleva 5 minutos sin cambios (el mismo trabajo de la versión
//     automática): en nombre de la última persona que editó, o del propietario si ella ya no tiene
//     acceso, y contra el PRESUPUESTO DIARIO DEL ESPACIO (uso_ia_indexado_diario), no contra la cuota de
//     nadie. Agotado, se pospone al día siguiente y queda en el log.
//
// Modelo (P2): se indexa con el modelo vigente del servicio (Describir). Si no produce 1024 dimensiones,
// no se escribe nada. Si los fragmentos guardados son de otro modelo, se reindexan aunque el texto no
// haya cambiado.
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
import { ModeloIncompatible, type ClienteIa } from './cliente.js';
import { DIMENSIONES } from './contrato.js';
import { tokensAprox } from './proveedor.js';
import { ajustarIndexadoEspacio, registrarUso, reservarIndexadoEspacio, reservarUso, segundosHastaManana, type TopesIa } from './uso.js';

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

export type ResultadoIndexado = 'indexado' | 'sin_cambios' | 'vacio' | 'sin_acceso' | 'no_existe' | 'pospuesto';

/** En nombre de quién: una persona que lo pidió a mano, o el indexado automático (con el último autor). */
export type QuienIndexa = { usuarioId: string } | { automatico: true; autorId: string | null };

export interface DepsIndexado {
  prisma: PrismaClient;
  ia: ClienteIa;
  topes: TopesIa;
  /** Presupuesto diario de tokens del indexado automático, por espacio. */
  topeIndexadoEspacio: number;
}

/**
 * Indexado automático: la última persona que editó si todavía tiene acceso; si no, el propietario del
 * documento. null si nadie (el documento se borró).
 */
async function indexadorAutomatico(prisma: PrismaClient, documentoId: string, autorId: string | null): Promise<string | null> {
  if (autorId && (await rolEnDocumento(prisma, autorId, documentoId))) return autorId;
  const prop = await prisma.$queryRaw<{ usuario_id: string }[]>`
    SELECT usuario_id FROM permisos_documento WHERE documento_id = ${documentoId}::uuid AND rol = 'propietario'`;
  const propietario = prop[0]?.usuario_id ?? null;
  return propietario && (await rolEnDocumento(prisma, propietario, documentoId)) ? propietario : null;
}

/**
 * Indexa un documento. Si nada cambió (mismos fragmentos, mismos hashes, mismo modelo), no llama a la IA.
 * Devuelve qué pasó; los errores de la IA (gRPC), un modelo incompatible y el tope diario se lanzan.
 */
export async function indexarDocumento(
  d: DepsIndexado,
  documentoId: string,
  quien: QuienIndexa,
  solicitudId: string,
): Promise<{ resultado: ResultadoIndexado; fragmentos: number; indexadoPor?: string }> {
  const automatico = 'automatico' in quien;
  const usuarioId = automatico ? await indexadorAutomatico(d.prisma, documentoId, quien.autorId) : quien.usuarioId;
  const acceso = usuarioId ? await rolEnDocumento(d.prisma, usuarioId, documentoId) : null;
  if (!usuarioId || !acceso) return { resultado: 'sin_acceso', fragmentos: 0 };
  const doc = await documentoGuardado(d.prisma, documentoId);
  if (!doc) return { resultado: 'no_existe', fragmentos: 0 };
  const fragmentos = fragmentar(doc.getText(NOMBRE_TEXTO).toJSON()).slice(0, FRAGMENTOS.maximo);
  const hashes = fragmentos.map(sha256);
  // Con un modelo de otras dimensiones lanza ModeloIncompatible: no se escribe ningún vector.
  const modelo = await d.ia.modeloVigente();

  const existentes = await d.prisma.$queryRaw<{ fragmento: number; hash_texto: Uint8Array; modelo: string }[]>`
    SELECT fragmento, hash_texto, modelo FROM embeddings WHERE documento_id = ${documentoId}::uuid ORDER BY fragmento`;
  const iguales =
    existentes.length === hashes.length &&
    existentes.every((e, i) => e.fragmento === i && e.modelo === modelo && Buffer.from(e.hash_texto).equals(hashes[i] ?? Buffer.alloc(0)));
  if (iguales) return { resultado: fragmentos.length === 0 ? 'vacio' : 'sin_cambios', fragmentos: fragmentos.length };
  if (fragmentos.length === 0) {
    await d.prisma.$executeRaw`DELETE FROM embeddings WHERE documento_id = ${documentoId}::uuid`;
    return { resultado: 'vacio', fragmentos: 0 };
  }

  const estimado = fragmentos.reduce((n, f) => n + tokensAprox(f), 0);
  if (automatico) {
    if (!(await reservarIndexadoEspacio(d.prisma, acceso.espacioId, estimado, d.topeIndexadoEspacio))) {
      return { resultado: 'pospuesto', fragmentos: fragmentos.length };
    }
  } else {
    await reservarUso(d.prisma, usuarioId, d.topes);
  }
  let r: Awaited<ReturnType<ClienteIa['indexar']>>;
  try {
    r = await d.ia.indexar(
      { cuentaId: usuarioId, espacioId: acceso.espacioId, documentoId, solicitudId },
      fragmentos.map((contenido, indice) => ({ indice, contenido })),
    );
  } catch (err) {
    // Lo reservado y no usado vuelve al presupuesto del espacio.
    if (automatico) await ajustarIndexadoEspacio(d.prisma, acceso.espacioId, -estimado);
    throw err;
  }
  if (automatico) await ajustarIndexadoEspacio(d.prisma, acceso.espacioId, r.uso.entrada + r.uso.salida - estimado);
  else await registrarUso(d.prisma, usuarioId, r.uso);
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
  return { resultado: 'indexado', fragmentos: fragmentos.length, indexadoPor: usuarioId };
}

export interface Indexador {
  /** Encola el indexado pedido a mano (uno a la vez por documento: si ya hay uno esperando, no se duplica). */
  pedir: (documentoId: string, usuarioId: string) => Promise<void>;
  /** Encola el indexado automático (al dejar de editar), con la última persona que editó. */
  pedirAutomatico: (documentoId: string, autorId: string | null) => Promise<void>;
  cerrar: () => Promise<void>;
}

type DatosTrabajo = { documentoId: string; usuarioId?: string; autorId?: string | null };

const opciones = { attempts: 3, backoff: { type: 'exponential' as const, delay: 2000 }, removeOnComplete: 100, removeOnFail: 100 };

/**
 * Encola un indexado automático en una cola ya abierta (lo usan el indexador y scripts/reindexar.ts, que
 * encola todos los documentos al cambiar de modelo). Uno a la vez por documento.
 */
export async function encolarAutomatico(cola: Queue, documentoId: string, autorId: string | null): Promise<void> {
  await cola.add('indexar', { documentoId, autorId }, { ...opciones, deduplication: { id: `indice:${documentoId}` } });
}

export function iniciarIndexado(o: DepsIndexado & { redisUrl: string; prefijo: string; log: Logger }): Indexador {
  const connection = { url: o.redisUrl, maxRetriesPerRequest: null };
  const cola = new Queue(COLA_INDICE, { connection, prefix: o.prefijo });
  const worker = new Worker(
    COLA_INDICE,
    async (job) => {
      const datos = job.data as DatosTrabajo;
      const quien: QuienIndexa = datos.usuarioId ? { usuarioId: datos.usuarioId } : { automatico: true, autorId: datos.autorId ?? null };
      try {
        const r = await indexarDocumento(o, datos.documentoId, quien, job.id ?? randomUUID());
        if (r.resultado === 'pospuesto') {
          // Presupuesto del espacio agotado: se reintenta después de la medianoche UTC. No falla en silencio.
          const demoraMs = (segundosHastaManana() + 60) * 1000;
          o.log.warn({ documentoId: datos.documentoId, reintentaEnS: Math.round(demoraMs / 1000) }, 'ia: presupuesto diario de indexado del espacio agotado; se pospone al día siguiente');
          await cola.add('indexar', { documentoId: datos.documentoId, autorId: datos.autorId ?? null }, { ...opciones, delay: demoraMs, deduplication: { id: `indice-pospuesto:${datos.documentoId}` } });
        } else {
          o.log.info({ documentoId: datos.documentoId, automatico: !datos.usuarioId, ...r }, 'ia: documento indexado');
        }
        return r;
      } catch (err) {
        // Sin tope o con un modelo incompatible no tiene sentido reintentar.
        if ((err as { codigo?: unknown }).codigo === 'tope_diario_ia') throw new UnrecoverableError('tope diario de IA');
        if (err instanceof ModeloIncompatible) throw new UnrecoverableError(err.message);
        throw err;
      }
    },
    { connection, prefix: o.prefijo, concurrency: 1 },
  );
  worker.on('failed', (job, err) => {
    o.log.warn({ err, documentoId: (job?.data as DatosTrabajo | undefined)?.documentoId }, 'ia: indexado falló');
  });
  return {
    pedir: async (documentoId, usuarioId) => {
      await cola.add('indexar', { documentoId, usuarioId }, { ...opciones, deduplication: { id: `indice:${documentoId}` } });
    },
    pedirAutomatico: (documentoId, autorId) => encolarAutomatico(cola, documentoId, autorId),
    cerrar: async () => {
      await worker.close();
      await cola.close();
    },
  };
}
