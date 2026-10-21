// Avisos de pérdida de acceso: base → Redis → conexiones (ADR 0002, decisiones 2 y 3 de K2).
//
//   PUENTE        una conexión de la base con LISTEN cuaderno_permisos. Cada aviso (sale al COMMIT, con
//                 solo ids: miembros, permisos, sesiones, cuentas, documentos; también por SQL directo) se
//                 publica tal cual en un canal de Redis.
//   SUSCRIPCIÓN   escucha ese canal y entrega cada aviso al servidor en tiempo real, que corta o revalida.
//
// Cada instancia escucha y publica (con varias instancias, avisos repetidos: cerrar dos veces no hace
// nada). Si se cae la conexión que escucha, o la de Redis, al volver se revalidan TODAS las conexiones:
// pudo perderse un aviso en el hueco.
import type { Redis } from 'ioredis';
import pg from 'pg';
import type { Logger } from 'pino';
import type { AvisoPermisos } from './servidor.js';

export const CANAL_BASE = 'cuaderno_permisos';
export const canalRedis = (prefijo: string) => `${prefijo}tiempo-real:avisos`;

export interface Avisos {
  cerrar: () => Promise<void>;
}

export function iniciarAvisos(o: {
  databaseUrl: string;
  redis: Redis;
  prefijo: string;
  log: Logger;
  alAviso: (a: AvisoPermisos) => void;
  alReconectar: () => void;
}): Avisos {
  const canal = canalRedis(o.prefijo);
  let cerrado = false;
  let cliente: pg.Client | null = null;
  let espera = 1000;
  let primeraVez = true;

  // ─── Puente: base → Redis ───
  const conectar = async (): Promise<void> => {
    if (cerrado) return;
    const c = new pg.Client({ connectionString: o.databaseUrl, application_name: 'cuaderno-avisos' });
    c.on('notification', (n) => {
      if (n.channel !== CANAL_BASE || !n.payload) return;
      o.redis.publish(canal, n.payload).catch((err: unknown) => {
        o.log.error({ err }, 'avisos: no se pudo publicar en Redis');
      });
    });
    const reintentar = (err?: unknown) => {
      if (cliente !== c) return;
      cliente = null;
      if (cerrado) return;
      o.log.warn({ err }, 'avisos: se perdió la conexión que escucha la base; reintentando');
      setTimeout(() => void conectar(), espera);
      espera = Math.min(espera * 2, 30_000);
    };
    c.on('error', reintentar);
    c.on('end', () => { reintentar(); });
    try {
      await c.connect();
      await c.query(`LISTEN ${CANAL_BASE}`);
      cliente = c;
      espera = 1000;
      if (!primeraVez) o.alReconectar();
      primeraVez = false;
    } catch (err) {
      await c.end().catch(() => undefined);
      cliente = c;
      reintentar(err);
    }
  };
  void conectar();

  // ─── Suscripción: Redis → servidor ───
  const sub = o.redis.duplicate();
  let listo = false;
  sub.on('message', (c: string, mensaje: string) => {
    if (c !== canal) return;
    try {
      o.alAviso(JSON.parse(mensaje) as AvisoPermisos);
    } catch (err) {
      o.log.error({ err }, 'avisos: mensaje inválido');
    }
  });
  sub.on('ready', () => {
    if (listo) o.alReconectar(); // volvió Redis: pudo perderse un aviso
    listo = true;
  });
  sub.on('error', (err: unknown) => {
    o.log.warn({ err }, 'avisos: error de la suscripción de Redis');
  });
  sub.subscribe(canal).catch((err: unknown) => {
    o.log.error({ err }, 'avisos: no se pudo suscribir');
  });

  return {
    cerrar: async () => {
      cerrado = true;
      await cliente?.end().catch(() => undefined);
      sub.disconnect();
    },
  };
}
