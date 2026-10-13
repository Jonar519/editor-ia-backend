// Límites de intentos con Redis y política de bloqueo progresivo.
import { createHash } from 'node:crypto';
import type { Request, RequestHandler, Response } from 'express';
import type { Redis } from 'ioredis';
import { ErrorHttp } from '../http/errores.js';

// INCR + PEXPIRE atómicos: ventana fija que empieza con el primer intento.
const SCRIPT_CONSUMIR = `
local n = redis.call('INCR', KEYS[1])
if n == 1 then redis.call('PEXPIRE', KEYS[1], ARGV[1]) end
return {n, redis.call('PTTL', KEYS[1])}`;

export interface ResultadoLimite {
  permitido: boolean;
  restantes: number;
  reintentarEnMs: number;
}

export interface Limitador {
  consumir: (clave: string) => Promise<ResultadoLimite>;
}

export interface OpcionesLimitador {
  redis: Redis;
  prefijo: string;
  nombre: string;
  max: number;
  ventanaMs: number;
}

export function crearLimitador(o: OpcionesLimitador): Limitador {
  return {
    consumir: async (clave) => {
      const r = (await o.redis.eval(SCRIPT_CONSUMIR, 1, `${o.prefijo}rl:${o.nombre}:${clave}`, String(o.ventanaMs))) as [number, number];
      const [n, ttl] = r;
      return { permitido: n <= o.max, restantes: Math.max(0, o.max - n), reintentarEnMs: Math.max(0, ttl) };
    },
  };
}

/**
 * Middleware de límite. FALLA CERRADO: si Redis no responde, la petición se rechaza con 503 en vez de
 * quedar sin protección (un atacante no gana nada tumbando Redis).
 */
export function limitarTasa(limitador: Limitador, claveDe: (req: Request, res: Response) => string): RequestHandler {
  return async (req, res, next) => {
    let r: ResultadoLimite;
    try {
      r = await limitador.consumir(claveDe(req, res));
    } catch (err) {
      req.log.error({ err }, 'límite de tasa no disponible (Redis)');
      next(new ErrorHttp(503, 'limites_no_disponibles', 'Servicio temporalmente no disponible'));
      return;
    }
    res.setHeader('RateLimit-Remaining', String(r.restantes));
    if (!r.permitido) {
      res.setHeader('Retry-After', String(Math.ceil(r.reintentarEnMs / 1000)));
      next(new ErrorHttp(429, 'demasiados_intentos', 'Demasiados intentos. Espera un momento.'));
      return;
    }
    next();
  };
}

/** IP del cliente para las claves de límite (respeta TRUST_PROXY vía req.ip). */
export const claveIp = (req: Request): string => req.ip ?? 'desconocida';

// ─── Bloqueo progresivo de cuentas ────────────────────────────────────────────────

/** Fallos gratis antes del primer bloqueo. */
export const FALLOS_ANTES_DE_BLOQUEAR = 5;
const BLOQUEO_BASE_MS = 60_000;
const BLOQUEO_MAXIMO_MS = 60 * 60_000;

/** 5 fallos → 1 min; cada fallo siguiente duplica (2, 4, 8 ... min) hasta 1 hora. */
export function duracionBloqueoMs(fallos: number): number {
  if (fallos < FALLOS_ANTES_DE_BLOQUEAR) return 0;
  return Math.min(BLOQUEO_BASE_MS * 2 ** (fallos - FALLOS_ANTES_DE_BLOQUEAR), BLOQUEO_MAXIMO_MS);
}

export interface EstadoBloqueo {
  fallos: number;
  hasta: Date | null;
}

/**
 * Contador de fallos para correos QUE NO EXISTEN (o cuentas no activas), guardado en Redis con la
 * MISMA política que las cuentas reales (que lo guardan en la base). Así el comportamiento ante
 * intentos fallidos es idéntico y no revela qué correos existen.
 */
export function crearBloqueoFantasma(redis: Redis, prefijo: string) {
  const clave = (correo: string) => `${prefijo}bloqueo:${createHash('sha256').update(correo).digest('hex')}`;
  return {
    leer: async (correo: string): Promise<EstadoBloqueo> => {
      const [fallos, hasta] = await redis.hmget(clave(correo), 'fallos', 'hasta');
      return { fallos: Number(fallos ?? 0), hasta: hasta ? new Date(Number(hasta)) : null };
    },
    registrarFallo: async (correo: string): Promise<EstadoBloqueo> => {
      const k = clave(correo);
      const fallos = await redis.hincrby(k, 'fallos', 1);
      const ms = duracionBloqueoMs(fallos);
      const hasta = ms > 0 ? new Date(Date.now() + ms) : null;
      if (hasta) await redis.hset(k, 'hasta', String(hasta.getTime()));
      await redis.pexpire(k, 24 * 60 * 60_000);
      return { fallos, hasta };
    },
  };
}

export type BloqueoFantasma = ReturnType<typeof crearBloqueoFantasma>;
