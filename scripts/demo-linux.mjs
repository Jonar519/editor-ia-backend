// Demostraciones en Linux (contenedor oficial de Playwright, que trae Node), en la red Docker de Cuaderno
// y SIEMPRE contra la base de PRUEBAS. Requiere `npm run build` antes.
// Uso: node scripts/demo-linux.mjs sigterm | produccion
//   sigterm     arranca el servidor, consulta /health y /ready, le manda SIGTERM real y muestra el apagado
//   produccion  intenta arrancar en producción (1) con proveedores mock y (2) con el usuario dueño
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const IMAGEN = 'mcr.microsoft.com/playwright:v1.63.0-noble';

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
const base = variables(path.resolve(RAIZ, back.DATABASE_REPO_PATH || '../editor-ia-database', '.env'));
if (!base.CUADERNO_APP_PASSWORD || !back.MFA_ENCRYPTION_KEY) {
  console.error('Faltan CUADERNO_APP_PASSWORD (repo de base) o MFA_ENCRYPTION_KEY (.env). Ejecuta db-up.bat y env-init.bat.');
  process.exit(1);
}
if (!existsSync(path.join(RAIZ, 'dist', 'servidor.js'))) {
  console.error('Falta dist/servidor.js: ejecuta antes "npm run build".');
  process.exit(1);
}

const bdPruebas = base.CUADERNO_TEST_DB || 'cuaderno_test';
const urlApp = `postgresql://cuaderno_app:${encodeURIComponent(base.CUADERNO_APP_PASSWORD)}@cuaderno_postgres:5432/${bdPruebas}`;
const urlDueno = `postgresql://${base.PGUSER || 'cuaderno'}:${encodeURIComponent(base.PGPASSWORD ?? '')}@cuaderno_postgres:5432/${bdPruebas}`;

/** @param {Record<string, string>} env @param {string[]} comando */
function enLinux(env, comando) {
  const args = ['run', '--rm', '--network', 'cuaderno_default', '-v', `${RAIZ}:/app`, '-w', '/app'];
  for (const [k, v] of Object.entries(env)) args.push('-e', `${k}=${v}`);
  const r = spawnSync('docker', [...args, IMAGEN, ...comando], { encoding: 'utf8' });
  return { codigo: r.status ?? 1, salida: `${r.stdout}${r.stderr}` };
}

const comun = { MFA_ENCRYPTION_KEY: back.MFA_ENCRYPTION_KEY, HOST: '127.0.0.1', PORT: '4200', LOG_LEVEL: 'info' };
const accion = process.argv[2];

if (accion === 'sigterm') {
  const guion = [
    'node dist/servidor.js > /tmp/log.txt 2>&1 & PID=$!',
    'for i in $(seq 1 50); do node -e "fetch(\'http://127.0.0.1:4200/health\').then(()=>process.exit(0),()=>process.exit(1))" && break; sleep 0.2; done',
    'echo "GET /health -> $(node -e "fetch(\'http://127.0.0.1:4200/health\').then(r=>r.text()).then(console.log)")"',
    'echo "GET /ready  -> $(node -e "fetch(\'http://127.0.0.1:4200/ready\').then(r=>r.text()).then(console.log)")"',
    'echo "Enviando SIGTERM al proceso $PID..."; kill -TERM $PID; wait $PID; echo "El proceso terminó con código $?"',
    'echo "Mensajes del log:"; grep -oE \'"msg":"[^"]*"\' /tmp/log.txt',
  ].join('\n');
  const r = enLinux({ ...comun, NODE_ENV: 'development', DATABASE_URL: urlApp, REDIS_URL: 'redis://cuaderno_redis:6379/1' }, ['bash', '-c', guion]);
  console.log(r.salida.trim());
  process.exit(r.codigo);
} else if (accion === 'produccion') {
  console.log('== 1) Producción con proveedores mock (lo que trae .env.example):');
  const a = enLinux({ ...comun, NODE_ENV: 'production', DATABASE_URL: urlApp, REDIS_URL: 'redis://cuaderno_redis:6379/1' }, ['node', 'dist/servidor.js']);
  console.log(`${a.salida.trim()}\n   -> código de salida ${String(a.codigo)}\n`);
  console.log('== 2) Producción con todo correcto, pero conectada con el usuario DUEÑO de las tablas:');
  const b = enLinux(
    {
      ...comun,
      NODE_ENV: 'production',
      DATABASE_URL: urlDueno,
      REDIS_URL: 'rediss://cuaderno_redis:6379/1',
      METRICS_TOKEN: 'demo'.repeat(10),
      AI_PROVIDER: 'anthropic',
      EMAIL_PROVIDER: 'ses',
      GEO_PROVIDER: 'tabla_local',
    },
    ['node', 'dist/servidor.js'],
  );
  const lineas = (b.salida.match(/"msg":"[^"]*"|"problemas":\[[^\]]*\]/g) ?? []).join('\n');
  console.log(`${lineas}\n   -> código de salida ${String(b.codigo)}`);
  process.exit(a.codigo !== 0 && b.codigo !== 0 ? 0 : 1);
} else {
  console.error('Uso: demo-linux.mjs sigterm | produccion');
  process.exit(2);
}
