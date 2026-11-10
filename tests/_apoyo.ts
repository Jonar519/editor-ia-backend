// Utilidades de prueba: app con dependencias reales (base de pruebas, Redis db 1) o falsas.
import { Writable } from 'node:stream';
import type { Express, Router } from 'express';
import { crearApp } from '../src/app.js';
import type { Comprobacion, EstadoProceso } from '../src/http/salud.js';
import { crearLogger } from '../src/observabilidad/log.js';
import { crearMetricas } from '../src/observabilidad/metricas.js';

export const urlBdPruebas = (): string => process.env.TEST_DATABASE_URL ?? '';
export const urlRedisPruebas = (): string => process.env.TEST_REDIS_URL ?? '';

/** Logger que guarda las líneas JSON en memoria para inspeccionarlas. */
export function loggerEnMemoria() {
  const lineas: Record<string, unknown>[] = [];
  const destino = new Writable({
    write(trozo: Buffer, _codificacion, listo) {
      for (const l of trozo.toString('utf8').split('\n')) if (l.trim()) lineas.push(JSON.parse(l) as Record<string, unknown>);
      listo();
    },
  });
  return { log: crearLogger('info', destino), lineas };
}

export const comprobacionOk = (nombre: string): Comprobacion => ({ nombre, comprobar: () => Promise.resolve() });
export const comprobacionFalla = (nombre: string): Comprobacion => ({
  nombre,
  comprobar: () => Promise.reject(new Error(`${nombre} caído (detalle interno)`)),
});

export interface OpcionesAppPrueba {
  comprobaciones?: Comprobacion[];
  estado?: EstadoProceso;
  tokenMetricas?: string;
  api?: Router;
  extender?: (app: Express) => void;
  appUrl?: string;
  trustProxy?: number;
}

/** El frontend de las pruebas (el mismo valor por defecto de APP_URL). */
export const APP_URL_PRUEBA = 'http://127.0.0.1:5175';

export function appDePrueba(o: OpcionesAppPrueba = {}) {
  const { log, lineas } = loggerEnMemoria();
  const estado = o.estado ?? { apagando: false };
  const app = crearApp({
    log,
    metricas: crearMetricas(),
    comprobaciones: o.comprobaciones ?? [comprobacionOk('bd')],
    estado,
    tokenMetricas: o.tokenMetricas,
    trustProxy: o.trustProxy ?? 0,
    appUrl: o.appUrl ?? APP_URL_PRUEBA,
    ...(o.api ? { api: o.api } : {}),
    ...(o.extender ? { extender: o.extender } : {}),
  });
  return { app, lineas, estado };
}
