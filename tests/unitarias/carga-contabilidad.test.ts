// Pruebas de carga del bloque R: la contabilidad de cada corrida (pérdida, convergencia, códigos) y que el
// informe abra con lo que la medición NO permite concluir (decisión escrita), antes de cualquier tabla.
import type { Resultado } from 'autocannon';
import { describe, expect, it } from 'vitest';
import { resumirHttp, resumirWs, type HuellaCliente } from '../../scripts/carga/contabilidad.js';
import { generarInformeCarga, TITULO_LIMITES } from '../../scripts/carga/informe-carga.js';
import type { DatosCarga } from '../../scripts/carga/tipos.js';

const huella = (clave: string, documento: string, largo = 10, mapa = 'm'): HuellaCliente => ({ clave, documento, largo, mapa });

describe('resumirWs', () => {
  it('entregas esperadas: cada cambio a cada uno de los OTROS clientes de su documento', () => {
    const r = resumirWs(
      [{ latencias: [1, 2, 3], enviados: 30, recibidos: 60, cierres: [] }],
      [{ documento: 'd1', clientes: 3, enviados: 30 }],
      [huella('a', 'd1'), huella('b', 'd1'), huella('c', 'd1')],
      { d1: 10 },
    );
    expect(r.esperados).toBe(60);
    expect(r.perdidos).toBe(0);
    expect(r.perdida).toBe(0);
    expect(r.converge).toBe(true);
    expect(r.latencia?.p50).toBe(2);
  });

  it('cuenta lo que faltó y su proporción, sumando varios generadores y documentos', () => {
    const r = resumirWs(
      [
        { latencias: [5], enviados: 10, recibidos: 15, cierres: [4429] },
        { latencias: [7], enviados: 10, recibidos: 20, cierres: [1013, 4429] },
      ],
      [
        { documento: 'd1', clientes: 2, enviados: 10 },
        { documento: 'd2', clientes: 3, enviados: 10 },
      ],
      [huella('a', 'd1'), huella('b', 'd1'), huella('c', 'd2'), huella('d', 'd2'), huella('e', 'd2')],
      { d1: 10, d2: 10 },
    );
    expect(r.esperados).toBe(10 * 1 + 10 * 2);
    expect(r.recibidos).toBe(35);
    expect(r.perdidos).toBe(0);
    expect(r.cierres).toEqual({ 4429: 2, 1013: 1 });
    const faltan = resumirWs([{ latencias: [], enviados: 10, recibidos: 15, cierres: [] }], [{ documento: 'd1', clientes: 3, enviados: 10 }], [huella('a', 'd1'), huella('b', 'd1'), huella('c', 'd1')], { d1: 10 });
    expect(faltan.perdidos).toBe(5);
    expect(faltan.perdida).toBe(0.25);
    expect(faltan.latencia).toBeNull();
  });

  it('no converge si un cliente terminó distinto, si falta un cliente o si el servidor tiene otro texto', () => {
    const base = (h: HuellaCliente[], servidor: Record<string, number>) =>
      resumirWs([{ latencias: [], enviados: 0, recibidos: 0, cierres: [] }], [{ documento: 'd1', clientes: 2, enviados: 0 }], h, servidor).converge;
    expect(base([huella('a', 'd1'), huella('b', 'd1')], { d1: 10 })).toBe(true);
    expect(base([huella('a', 'd1'), huella('b', 'd1', 11)], { d1: 10 })).toBe(false);
    expect(base([huella('a', 'd1'), huella('b', 'd1', 10, 'otro')], { d1: 10 })).toBe(false);
    expect(base([huella('a', 'd1')], { d1: 10 })).toBe(false);
    expect(base([huella('a', 'd1'), huella('b', 'd1')], { d1: 9 })).toBe(false);
  });
});

describe('resumirHttp', () => {
  it('cuenta las respuestas por código (también los 429) y separa errores y timeouts', () => {
    const r = resumirHttp({
      requests: { average: 120.5 },
      latency: { p50: 3, p90: 5, p99: 9, max: 20, average: 3.4 },
      statusCodeStats: { 201: { count: 20 }, 429: { count: 980 } },
      errors: 1,
      timeouts: 2,
    } as unknown as Resultado);
    expect(r.codigos).toEqual({ 201: 20, 429: 980 });
    expect(r.total).toBe(1000);
    expect(r.errores).toBe(1);
    expect(r.timeouts).toBe(2);
    expect(r.latenciaMs).toEqual({ p50: 3, p90: 5, p99: 9, max: 20, media: 3.4 });
  });
});

describe('informe de carga', () => {
  const datos: DatosCarga = {
    corridas: {
      linux: {
        entorno: { etiqueta: 'linux', fecha: '2026-10-26T00:00:00.000Z', cpu: 'CPU ficticia', hilos: 8, ramGiB: 16, sistema: 'Linux', node: 'v24', autocannon: '8.0.0', postgres: '16', cargaInicial: 2, umbral: 10, forzado: false, rapido: false },
        parametros: { conexiones: [10], duracionS: 30, calentamientoS: 5, repeticiones: 1, sondaSolaS: 10, clientesW1: [10], tasas: [2], documentosW2: 20, clientesPorDocumentoW2: 5, esperaFinalMs: 3000 },
        http: [],
        login: [],
        ws: [],
      },
    },
  };

  it('abre con lo que NO permite concluir, antes de cómo se midió y de cualquier tabla', () => {
    const md = generarInformeCarga(datos);
    const limites = md.indexOf(TITULO_LIMITES);
    expect(limites).toBeGreaterThan(0);
    expect(limites).toBeLessThan(md.indexOf('## Cómo se midió'));
    expect(limites).toBeLessThan(md.indexOf('|'));
    expect(md.slice(0, limites).split('\n').filter((l) => l.startsWith('## '))).toEqual([]);
    for (const tema of ['UNA máquina', 'una sola instancia', 'LOG_LEVEL=warn', 'IA está apagada', 'omisión coordinada', 'una sola IP']) expect(md).toContain(tema);
  });
});
