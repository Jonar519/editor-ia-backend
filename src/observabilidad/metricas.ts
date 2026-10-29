import type { RequestHandler } from 'express';
import { collectDefaultMetrics, Histogram, Registry } from 'prom-client';

export interface Metricas {
  registro: Registry;
  duracionHttp: Histogram<'metodo' | 'ruta' | 'estado'>;
}

/** Un registro por instancia de la app (las pruebas crean varias sin chocar). */
export function crearMetricas(): Metricas {
  const registro = new Registry();
  collectDefaultMetrics({ register: registro, prefix: 'cuaderno_' });
  const duracionHttp = new Histogram({
    name: 'cuaderno_http_duracion_segundos',
    help: 'Duración de las peticiones HTTP por método, ruta (patrón, no URL) y estado.',
    labelNames: ['metodo', 'ruta', 'estado'] as const,
    buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5],
    registers: [registro],
  });
  return { registro, duracionHttp };
}

/**
 * Mide cada petición. La etiqueta "ruta" es el PATRÓN de Express (/documentos/:id), nunca la URL real,
 * para que la cardinalidad no crezca con los ids; lo que no coincide con ninguna ruta va como "sin_ruta".
 *
 * El patrón se anota cuando Express elige la ruta (asigna req.route), porque ahí req.baseUrl todavía
 * tiene el prefijo de los routers. En el 'finish' ya no siempre: si la ruta terminó en next(err), el
 * router restauró baseUrl al salir y la etiqueta perdía el prefijo ("/refresco" en vez de
 * "/api/auth/refresco").
 */
export function medirPeticiones(metricas: Metricas): RequestHandler {
  return (req, res, next) => {
    const fin = metricas.duracionHttp.startTimer();
    let ruta = 'sin_ruta';
    let elegida: unknown;
    Object.defineProperty(req, 'route', {
      configurable: true,
      enumerable: true,
      get: () => elegida,
      set: (r: unknown) => {
        elegida = r;
        const patron: unknown = (r as { path?: unknown } | undefined)?.path;
        ruta = typeof patron === 'string' ? `${req.baseUrl}${patron}` : 'sin_ruta';
      },
    });
    res.on('finish', () => {
      fin({ metodo: req.method, ruta, estado: String(res.statusCode) });
    });
    next();
  };
}
