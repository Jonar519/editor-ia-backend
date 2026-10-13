// Uso: tsx scripts/openapi.ts [--check]
//   sin argumentos: escribe docs/openapi.json
//   --check: falla (exit 1) si docs/openapi.json no coincide con lo que generan los esquemas zod
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generarOpenApi } from '../src/openapi.js';

const DESTINO = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'openapi.json');
const generado = `${JSON.stringify(generarOpenApi(), null, 2)}\n`;

if (process.argv.includes('--check')) {
  let actual = '';
  try {
    actual = readFileSync(DESTINO, 'utf8').replace(/\r\n/g, '\n');
  } catch {
    // no existe: cuenta como desactualizado
  }
  if (actual !== generado) {
    console.error('DESACTUALIZADO: docs/openapi.json no coincide con los esquemas. Ejecuta scripts\\openapi.bat.');
    process.exit(1);
  }
  console.log('docs/openapi.json está al día.');
} else {
  writeFileSync(DESTINO, generado);
  console.log('docs/openapi.json generado.');
}
