// Pruebas de mutación dirigidas: rompe a propósito cada regla crítica del catálogo
// (mutations/catalogo.json), corre el comando de pruebas indicado y exige que falle.
// Uso: node scripts/mutar.mjs [id...]
//
// Primero corre cada comando SIN mutaciones; si alguno falla, aborta (exit 4). Al final los vuelve a
// correr sin mutaciones para dejar la base de pruebas en su estado correcto.
// Resultados:
//   DETECTADA     las pruebas fallaron con la mutación (lo esperado)
//   SOBREVIVE     las pruebas pasaron con la regla rota: falta un test (hace fallar el comando)
//   EQUIVALENTE   declarada equivalente en el catálogo con su motivo; no cuenta como detectada
// El archivo original se restaura siempre (también con Ctrl+C) y se verifica por hash.

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * @typedef {{
 *   id: string, regla: string, archivo: string, buscar: string, reemplazo: string,
 *   comando: string, equivalente?: string, pruebas?: string[]
 * }} Mutacion
 */

/**
 * Comando a correr para una mutación. Con "pruebas", solo esos archivos (npm run <comando> -- <archivos>):
 * más rápido y más estricto (la mutación tiene que ser detectada por ESAS pruebas).
 * @param {Mutacion} m
 */
const comandoDe = (m) => (m.pruebas?.length ? `${m.comando} -- ${m.pruebas.join(' ')}` : m.comando);

/** @param {string} texto */
const sha = (texto) => createHash('sha256').update(texto).digest('hex');

/**
 * @param {string} texto
 * @param {string} buscado
 */
function contar(texto, buscado) {
  let n = 0;
  for (let i = texto.indexOf(buscado); i !== -1; i = texto.indexOf(buscado, i + 1)) n++;
  return n;
}

/**
 * Primera línea que identifica la prueba fallida (runner SQL: "FALLA <caso>"; Vitest: "FAIL"/"×"; error general).
 * @param {string} salida
 */
function evidenciaDe(salida) {
  const lineas = salida.split(/\r?\n/).map((l) => l.trim());
  const caso = lineas.find((l) => l.startsWith('FALLA') || /^(FAIL|×)\s/.test(l));
  return (caso ?? lineas.find((l) => l.startsWith('ERROR')) ?? '').slice(0, 160);
}

/** @type {{ ruta: string, original: string } | undefined} */
let pendiente;
function restaurar() {
  if (pendiente) {
    writeFileSync(pendiente.ruta, pendiente.original);
    pendiente = undefined;
  }
}
for (const senal of /** @type {const} */ (['SIGINT', 'SIGTERM'])) {
  process.on(senal, () => {
    restaurar();
    process.exit(130);
  });
}

/** @type {{ mutaciones: Mutacion[] }} */
const catalogo = JSON.parse(readFileSync(path.join(RAIZ, 'mutations', 'catalogo.json'), 'utf8'));
const ids = process.argv.slice(2);
const elegidas = ids.length ? catalogo.mutaciones.filter((m) => ids.includes(m.id)) : catalogo.mutaciones;
if (elegidas.length === 0) {
  console.error('No hay mutaciones que correr.');
  process.exit(2);
}

/** @param {string} comando */
function correr(comando) {
  const r = spawnSync('npm', ['run', ...comando.split(' ')], { cwd: RAIZ, shell: true, encoding: 'utf8', timeout: 600_000 });
  return { codigo: r.status ?? 1, salida: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

// Corrida base: sin mutaciones, cada comando debe pasar. Si no, un fallo por el entorno
// (base caída, variable mal puesta) se contaría falsamente como "mutación detectada".
for (const comando of new Set(elegidas.map(comandoDe))) {
  process.stdout.write(`Base sin mutaciones: "npm run ${comando}"… `);
  const base = correr(comando);
  if (base.codigo !== 0) {
    console.log('FALLA');
    console.error(`\nABORTADO: las pruebas fallan SIN mutaciones; no se puede medir nada.\n${base.salida.slice(-2000)}`);
    process.exit(4);
  }
  console.log('OK');
}

/** @type {{ m: Mutacion, estado: string }[]} */
const resultados = [];
for (const m of elegidas) {
  const ruta = path.join(RAIZ, m.archivo);
  const original = readFileSync(ruta, 'utf8');
  const apariciones = contar(original, m.buscar);
  if (apariciones !== 1) {
    console.error(`${m.id}: el texto a buscar aparece ${apariciones} veces en ${m.archivo} (debe ser exactamente 1).`);
    resultados.push({ m, estado: 'ERROR' });
    continue;
  }
  const hashOriginal = sha(original);
  pendiente = { ruta, original };
  writeFileSync(ruta, original.replace(m.buscar, () => m.reemplazo));
  process.stdout.write(`${m.id} ${m.regla}\n   corriendo "npm run ${comandoDe(m)}"… `);
  /** @type {number} */
  let codigo;
  /** @type {string} */
  let salida;
  try {
    ({ codigo, salida } = correr(comandoDe(m)));
  } finally {
    restaurar();
  }
  if (sha(readFileSync(ruta, 'utf8')) !== hashOriginal) {
    console.error(`\nABORTADO: ${m.archivo} no quedó restaurado.`);
    process.exit(3);
  }
  const detectada = codigo !== 0;
  const estado = detectada ? 'DETECTADA' : m.equivalente ? 'EQUIVALENTE' : 'SOBREVIVE';
  console.log(estado);
  // Evidencia: la primera prueba que falló. Si fue la migración (ERROR: Falló ...), se ve aquí.
  const evidencia = detectada ? evidenciaDe(salida) : '';
  if (evidencia) console.log(`   evidencia: ${evidencia}`);
  resultados.push({ m, estado });
}

// Corrida final sin mutaciones: las pruebas SQL recrean la base de pruebas, así que sin esto
// cuaderno_test quedaría con el esquema de la ÚLTIMA mutación aplicada (y otros repos que la usan,
// como el backend, verían un esquema roto). También confirma que todo sigue pasando tras restaurar.
let finalOk = true;
for (const comando of new Set(elegidas.map(comandoDe))) {
  process.stdout.write(`Final sin mutaciones: "npm run ${comando}"… `);
  const fin = correr(comando);
  finalOk &&= fin.codigo === 0;
  console.log(fin.codigo === 0 ? 'OK' : `FALLA\n   evidencia: ${evidenciaDe(fin.salida)}`);
}

console.log('\nResumen de mutaciones');
for (const { m, estado } of resultados) {
  console.log(`  ${estado.padEnd(11)} ${m.id}  ${m.regla}${estado === 'EQUIVALENTE' ? `\n              motivo: ${m.equivalente}` : ''}`);
}
const cuenta = (/** @type {string} */ e) => resultados.filter((r) => r.estado === e).length;
console.log(
  `\nDetectadas ${cuenta('DETECTADA')}, sobreviven ${cuenta('SOBREVIVE')}, equivalentes ${cuenta('EQUIVALENTE')}, errores ${cuenta('ERROR')} (de ${resultados.length}).`,
);
if (!finalOk) console.error('ERROR: la corrida final sin mutaciones falló.');
process.exit(cuenta('SOBREVIVE') + cuenta('ERROR') === 0 && finalOk ? 0 : 1);
