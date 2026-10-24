// Construcción de la app Express. No abre puertos ni conexiones: recibe sus dependencias, así las
// pruebas la levantan con dependencias reales o falsas sin tocar el entorno.
import { randomUUID } from 'node:crypto';
import express, { type Express, type Router } from 'express';
import helmet from 'helmet';
import type { Logger } from 'pino';
import { pinoHttp } from 'pino-http';
import { manejadorErrores, noEncontrado } from './http/errores.js';
import { rutasSalud, type Comprobacion, type EstadoProceso } from './http/salud.js';
import { medirPeticiones, type Metricas } from './observabilidad/metricas.js';

export interface DependenciasApp {
  log: Logger;
  metricas: Metricas;
  comprobaciones: Comprobacion[];
  estado: EstadoProceso;
  tokenMetricas: string | undefined;
  trustProxy: boolean;
  /** Rutas del API, montadas en /api. */
  api?: Router;
  /** Solo para pruebas: agrega rutas antes del 404 (por ejemplo, una ruta lenta o que falla). */
  extender?: (app: Express) => void;
}

/** Un id de solicitud entrante solo se acepta si es corto y seguro para logs; si no, se genera uno. */
const ID_VALIDO = /^[A-Za-z0-9-]{8,64}$/;

/** Límite del cuerpo JSON. Los cambios del documento viajan por WebSocket, no por aquí. */
export const LIMITE_CUERPO = '100kb';

export function crearApp(d: DependenciasApp): Express {
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', d.trustProxy);

  app.use(
    pinoHttp({
      logger: d.log,
      genReqId: (req, res) => {
        const entrante = req.headers['x-request-id'];
        const id = typeof entrante === 'string' && ID_VALIDO.test(entrante) ? entrante : randomUUID();
        res.setHeader('x-request-id', id);
        return id;
      },
      // /health y /ready se consultan cada pocos segundos: no llenan el log salvo que fallen.
      autoLogging: { ignore: (req) => (req.url === '/health' || req.url === '/ready') },
    }),
  );
  app.use(helmet());
  app.use(medirPeticiones(d.metricas));
  // inflate: false (GHSA-27r3-jxmh-p828, defensa adicional): un cuerpo comprimido (Content-Encoding
  // distinto de identity) se rechaza con 415 sin descomprimirlo. El frontend nunca comprime pedidos.
  app.use(express.json({ limit: LIMITE_CUERPO, inflate: false }));

  app.use(
    rutasSalud({
      comprobaciones: d.comprobaciones,
      estado: d.estado,
      metricas: d.metricas,
      tokenMetricas: d.tokenMetricas,
      log: d.log,
    }),
  );

  if (d.api) app.use('/api', d.api);
  d.extender?.(app);

  app.use(noEncontrado);
  app.use(manejadorErrores(d.log));
  return app;
}
