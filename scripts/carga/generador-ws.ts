// Proceso generador de las pruebas de carga del WebSocket (bloque R). El medidor reparte los clientes entre
// varios generadores para que el lado cliente no sea el cuello de botella (con 100 clientes a 5 cambios
// por segundo, cada cambio se entrega a 99: unas 50 000 entregas por segundo).
//
// Protocolo con el medidor (IPC, serialización avanzada):
//   ← { tipo: 'conectar', url, origen, clientes: [{ clave, ticket }] }  → { tipo: 'conectados' } | { tipo: 'error', mensaje }
//   ← { tipo: 'correr', arranqueNs, inicioNs, finNs, tasa }              (cada cliente cambia `tasa` veces por segundo desde arranqueNs; se mide en [inicioNs, finNs))
//   ← { tipo: 'resultado', esperaMs }                                    → { tipo: 'resultado', ... }
import { ahoraNs, ClienteCarga } from './cliente-ws.js';

interface MensajeConectar {
  tipo: 'conectar';
  url: string;
  origen: string;
  clientes: { clave: string; ticket: string }[];
}
interface MensajeCorrer {
  tipo: 'correr';
  /** Desde aquí se manda (calentamiento); se mide en [inicioNs, finNs) y se deja de mandar en finNs. */
  arranqueNs: string;
  inicioNs: string;
  finNs: string;
  tasa: number;
}
interface MensajeResultado {
  tipo: 'resultado';
  esperaMs: number;
}

let clientes: ClienteCarga[] = [];
const temporizadores: NodeJS.Timeout[] = [];
/** CPU del generador desde que empieza a correr (sin contar la conexión). */
let cpu0: NodeJS.CpuUsage | undefined;
const enviar = (m: unknown) => process.send?.(m);

async function conectar(m: MensajeConectar): Promise<void> {
  clientes = m.clientes.map((c) => new ClienteCarga(m.url, c.ticket, m.origen, c.clave));
  await Promise.all(clientes.map((c) => c.sincronizado));
}

function correr(m: MensajeCorrer): void {
  const arranque = BigInt(m.arranqueNs);
  const inicio = BigInt(m.inicioNs);
  const fin = BigInt(m.finNs);
  const periodoMs = 1000 / m.tasa;
  cpu0 = process.cpuUsage();
  for (const c of clientes) {
    c.ventana = { inicio, fin };
    // Fase al azar dentro del primer período: los clientes no mandan todos en el mismo milisegundo.
    const fase = Math.random() * periodoMs;
    const esperaInicial = Math.max(0, Number(arranque - ahoraNs()) / 1e6) + fase;
    temporizadores.push(
      setTimeout(() => {
        const t = setInterval(() => {
          if (ahoraNs() >= fin) {
            clearInterval(t);
            return;
          }
          if (c.ws.readyState === c.ws.OPEN) c.cambiar();
        }, periodoMs);
        temporizadores.push(t);
        c.cambiar();
      }, esperaInicial),
    );
  }
}

async function resultado(m: MensajeResultado): Promise<void> {
  // Tiempo para que lleguen los últimos cambios en vuelo antes de contar.
  await new Promise((r) => setTimeout(r, m.esperaMs));
  for (const t of temporizadores) clearTimeout(t);
  const latencias = new Float64Array(clientes.reduce((n, c) => n + c.latencias.length, 0));
  let i = 0;
  for (const c of clientes) for (const x of c.latencias) latencias[i++] = x;
  enviar({
    tipo: 'resultado',
    latencias,
    enviados: clientes.reduce((n, c) => n + c.enviados, 0),
    recibidos: clientes.reduce((n, c) => n + c.recibidosEnVentana, 0),
    cierres: clientes.map((c) => c.cierre).filter((x): x is number => x !== null),
    huellas: clientes.map((c) => ({ clave: c.clave, enviados: c.enviados, ...c.huella() })),
    cpu: process.cpuUsage(cpu0),
  });
  for (const c of clientes) c.cerrar();
}

process.on('message', (m: MensajeConectar | MensajeCorrer | MensajeResultado) => {
  const fallar = (e: unknown) => enviar({ tipo: 'error', mensaje: e instanceof Error ? e.message : String(e) });
  if (m.tipo === 'conectar') conectar(m).then(() => enviar({ tipo: 'conectados' }), fallar);
  else if (m.tipo === 'correr') correr(m);
  else resultado(m).catch(fallar);
});
process.on('disconnect', () => process.exit(0));
