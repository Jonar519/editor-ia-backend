// La base de las pruebas de carga (bloque R): una base de PRUEBAS propia, cuaderno_carga_test, que se
// borra y se vuelve a crear (migrada con el runner de editor-ia-database) antes de cada medición. Nunca la
// de desarrollo ni la de las pruebas automáticas. Redis: la db 2, que se vacía al empezar.
//
// Variables: las PG* y CUADERNO_APP_PASSWORD del repo de base (en local, de su .env, sin cargarlas en
// process.env; en el contenedor de Linux, del entorno), como scripts/bd-preparar.mjs.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';
import { Redis } from 'ioredis';
import pg from 'pg';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const BASE_CARGA = 'cuaderno_carga_test';
export const DB_REDIS_CARGA = 2;

export interface Conexiones {
  /** Del dueño: solo para borrar y crear la base de carga. */
  dueno: { host: string; port: number; user: string; password: string | undefined };
  /** Como cuaderno_app (lo que usa el API). */
  urlApp: string;
  urlRedis: string;
}

export function conexiones(): Conexiones {
  const repoBase = path.resolve(RAIZ, process.env.DATABASE_REPO_PATH ?? '../editor-ia-database');
  const archivo = path.join(repoBase, '.env');
  const v = { ...(existsSync(archivo) ? parseEnv(readFileSync(archivo, 'utf8')) : {}), ...process.env };
  const host = v.PGHOST ?? '127.0.0.1';
  const port = Number(v.PGPORT ?? 5435);
  if (!v.PGUSER || v.PGUSER === 'cuaderno_app') throw new Error('Falta PGUSER del dueño de la base (del .env del repo de base).');
  if (!v.CUADERNO_APP_PASSWORD) throw new Error('Falta CUADERNO_APP_PASSWORD (del .env del repo de base).');
  // En el contenedor de Linux (scripts/carga-linux.mjs) se llega por la red de Docker: REDIS_HOST y PGHOST.
  const hostRedis = v.REDIS_HOST ?? '127.0.0.1';
  const puertoRedis = Number(v.REDIS_PORT ?? 6381);
  return {
    dueno: { host, port, user: v.PGUSER, password: v.PGPASSWORD },
    urlApp: `postgresql://cuaderno_app:${encodeURIComponent(v.CUADERNO_APP_PASSWORD)}@${host}:${String(port)}/${BASE_CARGA}`,
    urlRedis: `redis://${hostRedis}:${String(puertoRedis)}/${String(DB_REDIS_CARGA)}`,
  };
}

/** Borra y vuelve a crear la base de carga, migrada y con cuaderno_app habilitado; vacía la db 2 de Redis. */
export async function prepararBase(c: Conexiones): Promise<void> {
  if (!/_test$/.test(BASE_CARGA)) throw new Error('la base de carga debe terminar en _test');
  const admin = new pg.Client({ ...c.dueno, database: 'postgres' });
  await admin.connect();
  try {
    await admin.query(`DROP DATABASE IF EXISTS "${BASE_CARGA}" WITH (FORCE)`);
  } finally {
    await admin.end();
  }
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'scripts', 'bd-preparar.mjs')], {
    cwd: RAIZ,
    stdio: 'inherit',
    env: { ...process.env, CUADERNO_TEST_DB: BASE_CARGA },
  });
  if (r.status !== 0) throw new Error(`bd-preparar falló (exit ${String(r.status)})`);

  const url = new URL(c.urlRedis);
  if (url.pathname !== `/${String(DB_REDIS_CARGA)}`) throw new Error('Redis de carga debe ser la db 2');
  const redis = new Redis(c.urlRedis, { lazyConnect: true, maxRetriesPerRequest: 1 });
  await redis.connect();
  try {
    await redis.flushdb();
  } finally {
    redis.disconnect();
  }
}
