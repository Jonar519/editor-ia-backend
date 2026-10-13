import { Redis } from 'ioredis';
import type { Comprobacion } from '../http/salud.js';

export function crearRedis(url: string): Redis {
  return new Redis(url, {
    lazyConnect: true,
    // Sin cola offline: si Redis no está, las órdenes fallan enseguida en vez de esperar.
    enableOfflineQueue: false,
    maxRetriesPerRequest: 1,
    connectTimeout: 2000,
  });
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
