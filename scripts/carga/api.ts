// El API REAL (dist/servidor.js) de las mediciones del bloque R, en un proceso aparte (proceso-api.ts),
// contra la base de carga: el entorno con el que se levanta y la espera hasta que responde /health.
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { COSTO_HASH_MINIMO_PRODUCCION } from '../../src/config/entorno.js';
import type { Conexiones } from './base.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

export const PUERTO = 4290;
export const BASE = `http://127.0.0.1:${String(PUERTO)}`;
export const ORIGEN = 'http://127.0.0.1:5175';
export const URL_WS = `ws://127.0.0.1:${String(PUERTO)}/api/tiempo-real`;

/** NODE_ENV=development (producción exige TLS y proveedores reales), IA y correo simulados, secretos al azar. */
export function entornoApi(c: Conexiones, claveAcceso: Buffer): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    TZ: 'UTC',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(PUERTO),
    LOG_LEVEL: 'warn',
    DATABASE_URL: c.urlApp,
    REDIS_URL: c.urlRedis,
    ACCESS_TOKEN_SECRET: claveAcceso.toString('base64'),
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    METRICS_TOKEN: randomBytes(32).toString('base64url'),
    APP_URL: ORIGEN,
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'false',
    AI_PROVIDER: 'mock',
    EMAIL_PROVIDER: 'mock',
    GEO_PROVIDER: 'mock',
    PASSWORD_HASH_COST: String(COSTO_HASH_MINIMO_PRODUCCION),
  };
}

export async function levantarApi(entorno: Record<string, string>): Promise<ChildProcess> {
  const api = fork(path.join(RAIZ, 'scripts', 'carga', 'proceso-api.ts'), [], { execArgv: ['--import', 'tsx'], env: entorno, stdio: 'inherit' });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return api;
    } catch {
      // todavía no escucha
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  api.kill();
  throw new Error('el API no respondió /health en 30 s');
}

/** Cierra el API (SIGTERM dentro del proceso: el apagado ordenado) y espera a que salga. */
export async function cerrarApi(api: ChildProcess): Promise<void> {
  api.send({ tipo: 'cerrar' });
  await new Promise((r) => api.once('exit', r));
}
