import { Redis } from 'ioredis';
import type { Comprobacion } from '../http/salud.js';

/**
 * @param alError recibe los errores de conexión. Sin un oyente de "error", ioredis los imprime por
 *   consola como "Unhandled error event", fuera del log estructurado. /ready ya informa la caída.
 */
export function crearRedis(url: string, alError: (error: Error) => void): Redis {
  const redis = new Redis(url, {
    lazyConnect: true,
    // Sin cola offline: si Redis no está, las órdenes fallan enseguida en vez de esperar.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
  redis.on('error', alError);
  return redis;
}

export function comprobacionRedis(redis: Redis): Comprobacion {
  return {
    nombre: 'redis',
    comprobar: async () => {
      if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
      // ping() rechaza la promesa si Redis no responde.
      await redis.ping();
    },
  };
}
