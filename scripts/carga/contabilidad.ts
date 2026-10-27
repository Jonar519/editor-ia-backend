// Contabilidad de las pruebas de carga (bloque R), sin red: lo que se informa de cada corrida. Separado
// para poder probarlo (tests/unitarias/carga-contabilidad.test.ts) y mutarlo.
import type { Resultado } from 'autocannon';
import { resumir, type Resumen } from '../medicion/estadistica.js';

// ─── WebSocket ──────────────────────────────────────────────────────────────────

export interface HuellaCliente {
  clave: string;
  documento: string;
  largo: number;
  mapa: string;
}

export interface ResultadoGenerador {
  latencias: Float64Array | number[];
  enviados: number;
  recibidos: number;
  cierres: number[];
}

export interface ResumenWs {
  latencia: Resumen | null;
  enviados: number;
  /** Entregas esperadas: cada cambio enviado en la ventana, a cada uno de los OTROS clientes de su documento. */
  esperados: number;
  recibidos: number;
  /** Entregas que faltaron (esperadas - recibidas), y su proporción. */
  perdidos: number;
  perdida: number;
  /** Todos los clientes de cada documento terminaron con el mismo estado, igual al del servidor. */
  converge: boolean;
  cierres: Record<string, number>;
}

/**
 * @param porDocumento cuántos clientes hay en cada documento y cuántos cambios mandaron en la ventana
 * @param huellas el estado final de cada cliente
 * @param servidor el largo del texto que el servidor tiene de cada documento
 */
export function resumirWs(
  generadores: ResultadoGenerador[],
  porDocumento: { documento: string; clientes: number; enviados: number }[],
  huellas: HuellaCliente[],
  servidor: Record<string, number>,
): ResumenWs {
  const latencias = generadores.flatMap((g) => Array.from(g.latencias));
  const enviados = generadores.reduce((n, g) => n + g.enviados, 0);
  const recibidos = generadores.reduce((n, g) => n + g.recibidos, 0);
  const esperados = porDocumento.reduce((n, d) => n + d.enviados * (d.clientes - 1), 0);
  const perdidos = Math.max(0, esperados - recibidos);
  const converge = porDocumento.every((d) => {
    const deEste = huellas.filter((h) => h.documento === d.documento);
    const primera = deEste[0];
    return (
      primera !== undefined &&
      deEste.length === d.clientes &&
      deEste.every((h) => h.largo === primera.largo && h.mapa === primera.mapa) &&
      servidor[d.documento] === primera.largo
    );
  });
  const cierres: Record<string, number> = {};
  for (const c of generadores.flatMap((g) => g.cierres)) cierres[String(c)] = (cierres[String(c)] ?? 0) + 1;
  return {
    latencia: latencias.length ? resumir(latencias) : null,
    enviados,
    esperados,
    recibidos,
    perdidos,
    perdida: esperados ? perdidos / esperados : 0,
    converge,
    cierres,
  };
}

// ─── HTTP (autocannon) ──────────────────────────────────────────────────────────

export interface ResumenHttp {
  pedidosPorSegundo: number;
  total: number;
  latenciaMs: { p50: number; p90: number; p99: number; max: number; media: number };
  /** Respuestas por código, y fallos sin respuesta. */
  codigos: Record<string, number>;
  errores: number;
  timeouts: number;
}

export function resumirHttp(r: Resultado): ResumenHttp {
  const codigos: Record<string, number> = {};
  for (const [c, v] of Object.entries(r.statusCodeStats)) codigos[c] = v.count;
  return {
    pedidosPorSegundo: r.requests.average,
    total: Object.values(codigos).reduce((n, x) => n + x, 0),
    latenciaMs: { p50: r.latency.p50, p90: r.latency.p90, p99: r.latency.p99, max: r.latency.max, media: r.latency.average },
    codigos,
    errores: r.errors,
    timeouts: r.timeouts,
  };
}
