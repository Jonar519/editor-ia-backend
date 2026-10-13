// Se carga antes de cada archivo de prueba (vitest setupFiles). Lee .env si existe (en CI las variables
// vienen del workflow). Las pruebas usan SOLO TEST_DATABASE_URL y TEST_REDIS_URL: nunca la base ni la
// db de Redis de desarrollo.
import { existsSync } from 'node:fs';

if (existsSync('.env')) process.loadEnvFile('.env');

const urlBd = process.env.TEST_DATABASE_URL ?? '';
if (!/\/[a-z0-9_]+_test(\?|$)/.test(urlBd)) {
  throw new Error('TEST_DATABASE_URL debe apuntar a una base *_test (las pruebas nunca usan la de desarrollo).');
}
if (!/\/(1|2)$/.test(process.env.TEST_REDIS_URL ?? '')) {
  throw new Error('TEST_REDIS_URL debe usar la db 1 o 2 de Redis (la 0 es de desarrollo).');
}
