// Envoltorio de Prisma como cliente del esquema de editor-ia-database.
// Uso: node scripts/prisma.mjs generate | pull | check
//   generate  genera el cliente en src/generated/prisma (no necesita base)
//   pull      reescribe prisma/schema.prisma desde la base de PRUEBAS (TEST_DATABASE_URL)
//   check     compara prisma/schema.prisma con lo que diría `db pull`; falla si hay desvío
// Nunca usa DATABASE_URL de desarrollo: pasa TEST_DATABASE_URL como DATABASE_URL al CLI.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const ESQUEMA = path.join(RAIZ, 'prisma', 'schema.prisma');

/** @param {string[]} args @param {boolean} [capturar] */
function prisma(args, capturar = false) {
  const url = process.env.TEST_DATABASE_URL;
  if (args[0] === 'db' && !url) throw new Error('Falta TEST_DATABASE_URL (scripts\\env-init.bat).');
  // Se invoca el CLI con node directamente: sin shell, los argumentos no se reinterpretan.
  const r = spawnSync(process.execPath, [path.join(RAIZ, 'node_modules', 'prisma', 'build', 'index.js'), ...args], {
    cwd: RAIZ,
    encoding: 'utf8',
    env: { ...process.env, DATABASE_URL: url ?? '' },
    stdio: capturar ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (r.status !== 0) throw new Error(`prisma ${args.join(' ')} falló (exit ${String(r.status)}).`);
  return r.stdout ?? '';
}

/** Quita espacios finales y normaliza saltos de línea para comparar. */
const normalizar = (/** @type {string} */ t) => t.replace(/\r\n/g, '\n').replace(/[ \t]+$/gm, '').trim();

const accion = process.argv[2];
try {
  if (accion === 'generate') {
    prisma(['generate']);
  } else if (accion === 'pull') {
    prisma(['db', 'pull']);
  } else if (accion === 'check') {
    const esperado = normalizar(prisma(['db', 'pull', '--print'], true));
    const actual = normalizar(readFileSync(ESQUEMA, 'utf8'));
    if (esperado !== actual) {
      console.error('DESVÍO: prisma/schema.prisma no coincide con la base. Ejecuta scripts\\prisma-pull.bat y revisa el diff.');
      process.exit(1);
    }
    console.log('prisma/schema.prisma coincide con la base de pruebas.');
  } else {
    console.error('Uso: prisma.mjs generate | pull | check');
    process.exit(2);
  }
} catch (error) {
  console.error(`ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
