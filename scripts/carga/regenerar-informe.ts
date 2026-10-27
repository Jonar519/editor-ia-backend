// Vuelve a generar docs/carga-r.md desde docs/carga-r.json, sin medir (por ejemplo, después de juntar los
// datos de Windows y del contenedor de Linux). Uso: npm run carga:informe
import { readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generarInformeCarga } from './informe-carga.js';
import type { DatosCarga } from './tipos.js';

const DOCS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'docs');
const datos = JSON.parse(readFileSync(path.join(DOCS, 'carga-r.json'), 'utf8')) as DatosCarga;
writeFileSync(path.join(DOCS, 'carga-r.md'), generarInformeCarga(datos));
console.log('docs/carga-r.md generado.');
