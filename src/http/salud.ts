// /health (vivo), /ready (listo para recibir tráfico) y /metrics (Prometheus).
import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import type { Logger } from 'pino';
import type { Metricas } from '../observabilidad/metricas.js';
import { ErrorHttp } from './errores.js';
import type { ListoRespuesta } from './esquemas.js';

/** Una dependencia que /ready revisa. comprobar() lanza si no está disponible. */
export interface Comprobacion {
  nombre: string;
  comprobar: () => Promise<void>;
}

export interface EstadoProceso {
  apagando: boolean;
}

export interface OpcionesSalud {
  comprobaciones: Comprobacion[];
  estado: EstadoProceso;
  metricas: Metricas;
  tokenMetricas: string | undefined;
  log: Logger;
  /** Tiempo máximo por comprobación; una dependencia colgada no cuelga /ready. */
  limiteComprobacionMs?: number;
}

function conLimite(promesa: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolver, rechazar) => {
    const t = setTimeout(() => {
      rechazar(new Error(`sin respuesta en ${String(ms)} ms`));
    }, ms);
    promesa.then(
      () => {
        clearTimeout(t);
        resolver();
      },
      (e: unknown) => {
        clearTimeout(t);
        rechazar(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });
}

function tokenValido(cabecera: string | undefined, esperado: string): boolean {
  const recibido = Buffer.from(cabecera?.startsWith('Bearer ') ? cabecera.slice(7) : '');
  const objetivo = Buffer.from(esperado);
  return recibido.length === objetivo.length && timingSafeEqual(recibido, objetivo);
}

export function rutasSalud(o: OpcionesSalud): Router {
  const r = Router();
  const limite = o.limiteComprobacionMs ?? 2000;

  // Vivo: solo dice que el proceso responde. No toca dependencias (para que el orquestador no lo
  // reinicie por una caída de la base, que /ready ya reporta).
  r.get('/health', (_req, res) => {
    res.json({ estado: 'ok' });
  });

  r.get('/ready', async (_req, res) => {
    if (o.estado.apagando) {
      const cuerpo: ListoRespuesta = { estado: 'apagando', comprobaciones: {} };
      res.status(503).json(cuerpo);
      return;
    }
    const resultados = await Promise.all(
      o.comprobaciones.map(async (c) => {
        try {
          await conLimite(c.comprobar(), limite);
          return [c.nombre, 'ok'] as const;
        } catch (err) {
          o.log.warn({ err, comprobacion: c.nombre }, 'dependencia no disponible');
          return [c.nombre, 'falla'] as const;
        }
      }),
    );
    const listo = resultados.every(([, e]) => e === 'ok');
    const cuerpo: ListoRespuesta = { estado: listo ? 'listo' : 'no_listo', comprobaciones: Object.fromEntries(resultados) };
    res.status(listo ? 200 : 503).json(cuerpo);
  });

  r.get('/metrics', async (req, res) => {
    if (o.tokenMetricas !== undefined && !tokenValido(req.headers.authorization, o.tokenMetricas)) {
      throw new ErrorHttp(401, 'no_autorizado', 'Falta o es inválido el token de métricas');
    }
    res.type(o.metricas.registro.contentType).send(await o.metricas.registro.metrics());
  });

  return r;
}
