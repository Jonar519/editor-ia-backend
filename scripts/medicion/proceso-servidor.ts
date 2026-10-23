// Proceso hijo de la medición de P3: levanta el servidor (gRPC real + REST) y contesta por IPC lo que el
// medidor le pide: su CPU (process.cpuUsage), los bytes de los proxies, y cerrar. Así la CPU del servidor
// se mide en su propio proceso, separada de la del cliente.
import { levantarServidorMedicion } from './servidor.js';

const s = await levantarServidorMedicion();
const enviar = (m: unknown) => process.send?.(m);

process.on('message', (m: { tipo: string }) => {
  switch (m.tipo) {
    case 'cpu':
      enviar({ tipo: 'cpu', cpu: process.cpuUsage() });
      return;
    case 'bytes':
      enviar({ tipo: 'bytes', bytes: s.bytes() });
      return;
    case 'reiniciar-bytes':
      s.reiniciarBytes();
      enviar({ tipo: 'reiniciar-bytes' });
      return;
    case 'cerrar':
      void s.cerrar().then(() => process.exit(0));
      return;
  }
});

enviar({ tipo: 'listo', token: s.token, puertos: s.puertos, proxies: s.proxies, pid: process.pid });
