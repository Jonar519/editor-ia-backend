// Tipos de los datos crudos de las pruebas de carga (docs/carga-r.json). Aparte del medidor, que corre al
// importarse: los usan el informe y sus pruebas.
import type { ResumenHttp, ResumenWs } from './contabilidad.js';

export interface CorridaHttp {
  escenario: 'H1' | 'H2' | 'H3';
  conexiones: number;
  repeticion: number;
  cargaPrevia: number;
  esperasPorCarga: number;
  resultado: ResumenHttp;
  cpuServidorPct: number;
  cpuClientePct: number;
  rssMaxMiB: number;
}

export interface CorridaLogin {
  conexiones: number;
  repeticion: number;
  cargaPrevia: number;
  esperasPorCarga: number;
  login: ResumenHttp;
  sondaSola: ResumenHttp;
  sondaConLogin: ResumenHttp;
  cpuServidorPct: number;
  rssMaxMiB: number;
}

export interface CorridaWs {
  escenario: 'W1' | 'W2';
  documentos: number;
  clientes: number;
  tasa: number;
  repeticion: number;
  generadores: number;
  cargaPrevia: number;
  esperasPorCarga: number;
  resultado: ResumenWs;
  cambiosPorSegundo: number;
  entregasPorSegundo: number;
  filasInsertadas: number;
  cpuServidorPct: number;
  cpuGeneradoresPct: number;
  rssMaxMiB: number;
}

export interface EntornoCarga {
  etiqueta: string;
  fecha: string;
  cpu: string | undefined;
  hilos: number;
  ramGiB: number;
  sistema: string;
  node: string;
  autocannon: string;
  postgres: string;
  cargaInicial: number;
  umbral: number;
  forzado: boolean;
  rapido: boolean;
}

export interface MedicionEntorno {
  entorno: EntornoCarga;
  parametros: {
    conexiones: number[];
    duracionS: number;
    calentamientoS: number;
    repeticiones: number;
    sondaSolaS: number;
    clientesW1: number[];
    tasas: number[];
    documentosW2: number;
    clientesPorDocumentoW2: number;
    esperaFinalMs: number;
  };
  http: CorridaHttp[];
  login: CorridaLogin[];
  ws: CorridaWs[];
}

export interface DatosCarga {
  corridas: Record<string, MedicionEntorno>;
}
