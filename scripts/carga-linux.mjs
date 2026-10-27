// Pruebas de carga del bloque R en Linux: el contenedor oficial de Playwright (Ubuntu 24.04, trae Node),
// en la red Docker de Cuaderno, contra los MISMOS contenedores de PostgreSQL y Redis que usa Windows (la
// base de PRUEBAS cuaderno_carga_test y la db 2 de Redis). No usa el node_modules de Windows: copia el
// repo (y el de base) dentro del contenedor, instala y construye ahí. Al terminar copia
// docs/carga-r.json y docs/carga-r.md de vuelta: los datos de Windows que ya estaban se conservan.
// Uso: node scripts/carga-linux.mjs [argumentos de medir-carga, por ejemplo --rapido]
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGEN = 'mcr.microsoft.com/playwright:v1.63.0-noble';
const CONTENEDOR = 'cuaderno-carga-linux';

/** @param {string} archivo */
function variables(archivo) {
  /** @type {Record<string, string>} */
  const r = {};
  if (!existsSync(archivo)) return r;
  for (const l of readFileSync(archivo, 'utf8').split(/\r?\n/)) {
    const m = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(l);
    if (m?.[1] !== undefined) r[m[1]] = m[2] ?? '';
  }
  return r;
}

const back = variables(path.join(RAIZ, '.env'));
const repoBase = path.resolve(RAIZ, back.DATABASE_REPO_PATH || '../editor-ia-database');
const base = variables(path.join(repoBase, '.env'));
if (!base.CUADERNO_APP_PASSWORD || !base.PGUSER) {
  console.error('Faltan PGUSER o CUADERNO_APP_PASSWORD en el .env del repo de base. Ejecuta db-up.bat.');
  process.exit(1);
}

/** @param {string[]} args @param {{ entrada?: Buffer, heredar?: boolean }} [o] */
function docker(args, o = {}) {
  const r = spawnSync('docker', args, { input: o.entrada, stdio: o.heredar ? ['ignore', 'inherit', 'inherit'] : undefined, maxBuffer: 1 << 30 });
  if (r.status !== 0 && !o.heredar) throw new Error(`docker ${args.join(' ')}: ${String(r.stderr)}`);
  return r.status ?? 1;
}

/** Un tar del repo (lo versionado, como lo vería un clon), con git archive. @param {string} repo */
const tarDe = (repo) => {
  const r = spawnSync('git', ['-C', repo, 'archive', '--format=tar', 'HEAD'], { maxBuffer: 1 << 30 });
  if (r.status !== 0) throw new Error(`git archive ${repo}: ${String(r.stderr)}`);
  return r.stdout;
};

spawnSync('docker', ['rm', '-f', CONTENEDOR], { stdio: 'ignore' });
docker(['run', '-d', '--name', CONTENEDOR, '--network', 'cuaderno_default', IMAGEN, 'sleep', 'infinity']);
/** @type {number} */
let codigo;
try {
  docker(['exec', CONTENEDOR, 'mkdir', '-p', '/work/backend', '/work/editor-ia-database']);
  docker(['exec', '-i', CONTENEDOR, 'tar', '-x', '-C', '/work/backend'], { entrada: tarDe(RAIZ) });
  docker(['exec', '-i', CONTENEDOR, 'tar', '-x', '-C', '/work/editor-ia-database'], { entrada: tarDe(repoBase) });
  // Los datos de Windows que ya estén en docs/ (sin versionar todavía) entran también, para juntarlos.
  for (const f of ['carga-r.json']) {
    if (existsSync(path.join(RAIZ, 'docs', f))) docker(['cp', path.join(RAIZ, 'docs', f), `${CONTENEDOR}:/work/backend/docs/${f}`]);
  }
  const env = {
    PGHOST: 'cuaderno_postgres',
    PGPORT: '5432',
    PGUSER: base.PGUSER,
    PGPASSWORD: base.PGPASSWORD ?? '',
    CUADERNO_APP_PASSWORD: base.CUADERNO_APP_PASSWORD,
    REDIS_HOST: 'cuaderno_redis',
    REDIS_PORT: '6379',
    DATABASE_REPO_PATH: '/work/editor-ia-database',
    TZ: 'UTC',
  };
  const guion = [
    'set -e',
    'cd /work/editor-ia-database && npm ci --no-audit --no-fund >/dev/null',
    'cd /work/backend && npm ci --no-audit --no-fund >/dev/null && npm run -s build',
    `npm run -s carga -- --entorno linux ${process.argv.slice(2).join(' ')}`,
  ].join(' && ');
  codigo = docker(['exec', ...Object.entries(env).flatMap(([k, v]) => ['-e', `${k}=${v}`]), CONTENEDOR, 'bash', '-c', guion], { heredar: true });
  if (codigo === 0) {
    for (const f of ['carga-r.json', 'carga-r.md']) docker(['cp', `${CONTENEDOR}:/work/backend/docs/${f}`, path.join(RAIZ, 'docs', f)]);
    console.log('Copiados docs/carga-r.json y docs/carga-r.md desde el contenedor.');
  }
} finally {
  spawnSync('docker', ['rm', '-f', CONTENEDOR], { stdio: 'ignore' });
}
process.exit(codigo);
