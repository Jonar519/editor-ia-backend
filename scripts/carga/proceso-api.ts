// Proceso hijo de las pruebas de carga (bloque R): el API REAL, con el mismo arranque que producción
// (dist/servidor.js: tiempo real, avisos de la base, compactación y retención), y la configuración que le
// pasa el medidor por variables de entorno. Además contesta por IPC su CPU y su memoria, para medir el
// servidor en su propio proceso, separado de los clientes.
//
// "cerrar" emite SIGTERM dentro del proceso (también en Windows, donde kill no deja correr el apagado):
// el apagado ordenado guarda lo pendiente de cada documento y cierra las conexiones.
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const entrada = path.join(RAIZ, 'dist', 'servidor.js');
if (!existsSync(entrada)) {
  console.error('No hay build del API: corre "npm run build" antes de medir.');
  process.exit(2);
}

process.on('message', (m: { tipo: string }) => {
  if (m.tipo === 'uso') process.send?.({ tipo: 'uso', cpu: process.cpuUsage(), rss: process.memoryUsage().rss });
  if (m.tipo === 'cerrar') process.emit('SIGTERM');
});
// Si el medidor termina (o aborta por carga ajena), el API no queda escuchando.
process.on('disconnect', () => process.emit('SIGTERM'));

await import(pathToFileURL(entrada).href);
process.send?.({ tipo: 'cargado', pid: process.pid });
