// Crea .env a partir de .env.example, o completa uno existente con las variables que falten.
// Genera MFA_ENCRYPTION_KEY y METRICS_TOKEN, y arma DATABASE_URL / TEST_DATABASE_URL con la contraseña
// del rol cuaderno_app que está en el .env del repo de base. Nunca cambia un valor que ya exista.

import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const DESTINO = path.join(RAIZ, '.env');
const LINEA = /^([A-Z][A-Z0-9_]*)=(.*)$/;

/** @param {string} texto */
function leerVariables(texto) {
  /** @type {Map<string, string>} */
  const mapa = new Map();
  for (const l of texto.split(/\r?\n/)) {
    const m = LINEA.exec(l);
    if (m?.[1] !== undefined) mapa.set(m[1], m[2] ?? '');
  }
  return mapa;
}

const plantilla = readFileSync(path.join(RAIZ, '.env.example'), 'utf8');
const actualTexto = existsSync(DESTINO) ? readFileSync(DESTINO, 'utf8') : null;
const actuales = leerVariables(actualTexto ?? '');
const deLaPlantilla = leerVariables(plantilla);

// Datos del repo de base para armar las URL.
const repoBase = path.resolve(RAIZ, actuales.get('DATABASE_REPO_PATH') || deLaPlantilla.get('DATABASE_REPO_PATH') || '../editor-ia-database');
const envBase = path.join(repoBase, '.env');
const base = existsSync(envBase) ? leerVariables(readFileSync(envBase, 'utf8')) : new Map();

/** @param {string} nombreBd */
function urlBd(nombreBd) {
  const clave = base.get('CUADERNO_APP_PASSWORD');
  if (!clave) return '';
  const host = base.get('PGHOST') || '127.0.0.1';
  const puerto = base.get('PGPORT') || '5435';
  return `postgresql://cuaderno_app:${encodeURIComponent(clave)}@${host}:${puerto}/${nombreBd}`;
}

/** @type {Record<string, () => string>} */
const generadores = {
  MFA_ENCRYPTION_KEY: () => randomBytes(32).toString('base64'),
  ACCESS_TOKEN_SECRET: () => randomBytes(32).toString('base64'),
  METRICS_TOKEN: () => randomBytes(32).toString('base64url'),
  DATABASE_URL: () => urlBd(base.get('CUADERNO_DEV_DB') || 'cuaderno'),
  TEST_DATABASE_URL: () => urlBd(base.get('CUADERNO_TEST_DB') || 'cuaderno_test'),
};

/** @param {string} linea */
function rellenar(linea) {
  const m = LINEA.exec(linea);
  if (m?.[1] !== undefined && m[2] === '' && generadores[m[1]]) return `${m[1]}=${generadores[m[1]]()}`;
  return linea;
}

/** @type {string[]} */
const agregadas = [];
let contenido;
if (actualTexto === null) {
  contenido = plantilla.split(/\r?\n/).map(rellenar).join('\n');
} else {
  const faltantes = plantilla.split(/\r?\n/).filter((l) => {
    const m = LINEA.exec(l);
    return m?.[1] !== undefined && !actuales.has(m[1]);
  });
  for (const l of faltantes) agregadas.push(/** @type {string} */ (LINEA.exec(l)?.[1]));
  contenido = faltantes.length
    ? `${actualTexto.endsWith('\n') ? actualTexto : `${actualTexto}\n`}\n# Agregadas por env-init (ver .env.example)\n${faltantes.map(rellenar).join('\n')}\n`
    : actualTexto;
}

if (actualTexto === null) {
  await writeFile(DESTINO, contenido, { flag: 'wx' });
  console.log('.env creado con secretos aleatorios.');
} else if (agregadas.length) {
  await writeFile(DESTINO, contenido);
  console.log(`.env completado con: ${agregadas.join(', ')} (los valores existentes no se tocaron).`);
} else {
  console.log('.env ya está completo; no se modifica.');
}
if (!base.get('CUADERNO_APP_PASSWORD')) {
  console.log(`AVISO: no encontré CUADERNO_APP_PASSWORD en ${envBase}. Ejecuta antes scripts\\db-up.bat en editor-ia-database y luego completa DATABASE_URL y TEST_DATABASE_URL.`);
}
