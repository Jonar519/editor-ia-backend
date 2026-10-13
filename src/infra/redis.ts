import { Redis } from 'ioredis';
import type { Comprobacion } from '../http/salud.js';

/**
 * @param alError recibe los errores de conexión. Sin un oyente de "error", ioredis los imprime por
 *   consola como "Unhandled error event", fuera del log estructurado. /ready ya informa la caída.
 */
export function crearRedis(url: string, alError: (error: Error) => void): Redis {
  const redis = new Redis(url, {
    // Conecta al crear el cliente. Las órdenes enviadas mientras conecta esperan en la cola (sin ella,
    // las primeras órdenes tras arrancar fallaban con "Stream isn't writeable"); si Redis no responde,
    // cada orden falla tras UN reintento (~2 s como mucho) en vez de esperar indefinidamente.
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
    retryStrategy: (intentos) => Math.min(intentos * 200, 2000),
  });
  redis.on('error', alError);
  return redis;
}

export function comprobacionRedis(redis: Redis): Comprobacion {
  return {
    nombre: 'redis',
    comprobar: async () => {
      // ping() rechaza la promesa si Redis no responde.
      await redis.ping();
    },
  };
}
