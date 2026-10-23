// Regenera docs/medicion-p3.md desde docs/medicion-p3.json SIN volver a medir (por ejemplo, si cambia el
// formato del informe). Uso: npm run medir:informe
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generarInforme, type DatosMedicion } from './informe.js';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const datos = JSON.parse(readFileSync(path.join(DOCS, 'medicion-p3.json'), 'utf8')) as DatosMedicion;
writeFileSync(path.join(DOCS, 'medicion-p3.md'), generarInforme(datos));
console.log('docs/medicion-p3.md regenerado desde docs/medicion-p3.json.');
