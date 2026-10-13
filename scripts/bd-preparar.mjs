// Deja lista la base de PRUEBAS para el backend, en cualquier máquina (también una recién creada, como el
// Postgres de un CI): 1) la crea si no existe, 2) la migra con el runner de editor-ia-database y
// 3) habilita el LOGIN del rol cuaderno_app. Nunca toca la base de desarrollo.
//
// Variables: las PG* y CUADERNO_* del repo de base. En local se leen del .env de ese repo
// (DATABASE_REPO_PATH, por defecto ../editor-ia-database); en CI vienen del workflow.
// Uso: node scripts/bd-preparar.mjs
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const repoBase = path.resolve(RAIZ, process.env.DATABASE_REPO_PATH ?? '../editor-ia-database');
const envBase = path.join(repoBase, '.env');
// process.loadEnvFile no pisa variables ya definidas: en CI mandan las del workflow.
if (existsSync(envBase)) process.loadEnvFile(envBase);

const nombre = process.env.CUADERNO_TEST_DB ?? 'cuaderno_test';
if (!/^[a-z][a-z0-9_]*_test$/.test(nombre)) {
  console.error(`ERROR: "${nombre}" no es una base de pruebas (debe terminar en _test).`);
  process.exit(1);
}

async function crearSiFalta() {
  const cliente = new pg.Client({ database: 'postgres' }); // host, puerto, usuario y clave: variables PG*
  await cliente.connect();
  try {
    const { rows } = await cliente.query('SELECT 1 FROM pg_database WHERE datname = $1', [nombre]);
    if (rows.length === 0) {
      await cliente.query(`CREATE DATABASE "${nombre}" TEMPLATE template0 ENCODING 'UTF8'`);
      console.log(`Base ${nombre} creada.`);
    } else {
      console.log(`Base ${nombre} ya existe.`);
    }
  } finally {
    await cliente.end();
  }
}

/** @param {string} script */
function correrDelRepoBase(script, ...args) {
  const r = spawnSync(process.execPath, [path.join(repoBase, 'scripts', script), ...args], { cwd: repoBase, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} ${args.join(' ')} falló (exit ${String(r.status)}).`);
}

try {
  if (!existsSync(path.join(repoBase, 'scripts', 'migrate.mjs'))) {
    throw new Error(`No encuentro el repo de base en ${repoBase} (DATABASE_REPO_PATH).`);
  }
  await crearSiFalta();
  correrDelRepoBase('migrate.mjs', 'test');
  correrDelRepoBase('usuario-app.mjs');
  console.log('Base de pruebas lista.');
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
