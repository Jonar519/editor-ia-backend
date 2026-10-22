import { PrismaPg } from '@prisma/adapter-pg';
import pg from 'pg';
import { PrismaClient } from '../generated/prisma/client.js';
import type { Comprobacion } from '../http/salud.js';

/**
 * Versión mínima del esquema (editor-ia-database/migrations) que este backend necesita.
 * Si la base está más atrás, /ready responde 503 en vez de fallar con errores raros más tarde.
 */
export const ESQUEMA_MINIMO = 23;

export function crearPool(url: string): pg.Pool {
  return new pg.Pool({
    connectionString: url,
    max: 10,
    application_name: 'cuaderno-api',
    // Ninguna consulta del API debería tardar más; si lo hace, se corta en vez de acumular conexiones.
    options: '-c statement_timeout=5000',
  });
}

/** Prisma como cliente sobre el MISMO pool (una sola fuente de conexiones). */
export function crearPrisma(pool: pg.Pool): PrismaClient {
  return new PrismaClient({ adapter: new PrismaPg(pool) });
}

export function comprobacionBd(pool: pg.Pool): Comprobacion {
  return {
    nombre: 'bd',
    comprobar: async () => {
      await pool.query('SELECT 1');
    },
  };
}

export function comprobacionEsquema(pool: pg.Pool, minimo = ESQUEMA_MINIMO): Comprobacion {
  return {
    nombre: 'esquema',
    comprobar: async () => {
      const { rows } = await pool.query<{ version: number | null }>('SELECT max(version) AS version FROM schema_migrations');
      const version = rows[0]?.version ?? 0;
      if (version < minimo) throw new Error(`esquema en versión ${String(version)}; se necesita ${String(minimo)} o más`);
    },
  };
}
