// CORS de /api (despliegue: el frontend en cuaderno.<dominio> y el API en api-cuaderno.<dominio>, orígenes
// distintos del MISMO sitio, así que la cookie de refresco SameSite=Strict sigue viajando). Sin dependencia:
// las reglas son pocas y así se ven enteras.
//
//   - Un solo origen permitido: el de APP_URL. Con él, Access-Control-Allow-Origin exacto (nunca "*") y
//     Allow-Credentials: true (la cookie de refresco).
//   - Cualquier OTRO Origin recibe 403 origen_no_permitido antes de llegar a las rutas (ni siquiera cuenta
//     en el límite general). Sin Origin (curl, sondas, servidor a servidor) se atiende normal: CORS es una
//     regla del navegador, y las rutas siguen exigiendo token o cookie.
//   - Preflight (OPTIONS con Access-Control-Request-Method): solo los métodos y cabeceras que el frontend
//     usa; 204 con Max-Age de 10 minutos. Un método o una cabecera de más → 403.
//   - Expose-Headers: lo que el frontend LEE de una respuesta de otro origen (Retry-After en los 429,
//     Content-Disposition en las exportaciones, X-Request-Id para reportar un error).
//   - Vary: Origin siempre, para que ninguna caché mezcle respuestas de orígenes distintos.
import type { RequestHandler } from 'express';
import { ErrorHttp } from './errores.js';

export const METODOS_CORS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const;
export const CABECERAS_PERMITIDAS = ['accept', 'authorization', 'content-type', 'x-request-id'] as const;
export const CABECERAS_EXPUESTAS = ['retry-after', 'content-disposition', 'x-request-id'] as const;
export const MAX_AGE_PREFLIGHT_S = 600;

/** El origen (esquema + host + puerto) de una URL como APP_URL, aunque traiga "/" al final. */
export const origenDe = (url: string): string => new URL(url).origin;

const rechazo = () => new ErrorHttp(403, 'origen_no_permitido', 'Origen no permitido');

/**
 * Para una ruta que abre algo con efectos (el ticket del WebSocket): si el navegador manda Origin, tiene que
 * ser el del frontend. Repite a propósito la regla de cors(): la ruta no depende de cómo se monte.
 */
export function exigirOrigenApp(appUrl: string): RequestHandler {
  const permitido = origenDe(appUrl);
  return (req, _res, next) => {
    const origen = req.headers.origin;
    next(origen !== undefined && origen !== permitido ? rechazo() : undefined);
  };
}

export function cors(appUrl: string): RequestHandler {
  const permitido = origenDe(appUrl);
  const metodos = new Set<string>(METODOS_CORS);
  const cabeceras = new Set<string>(CABECERAS_PERMITIDAS);
  return (req, res, next) => {
    res.vary('Origin');
    const origen = req.headers.origin;
    if (origen === undefined) {
      next();
      return;
    }
    if (origen !== permitido) {
      next(rechazo());
      return;
    }
    res.setHeader('Access-Control-Allow-Origin', permitido);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
    const metodoPedido = req.headers['access-control-request-method'];
    if (req.method === 'OPTIONS' && typeof metodoPedido === 'string') {
      const pedidas = (req.headers['access-control-request-headers'] ?? '')
        .split(',')
        .map((h) => h.trim().toLowerCase())
        .filter(Boolean);
      if (!metodos.has(metodoPedido.toUpperCase()) || pedidas.some((h) => !cabeceras.has(h))) {
        next(rechazo());
        return;
      }
      res.setHeader('Access-Control-Allow-Methods', METODOS_CORS.join(', '));
      res.setHeader('Access-Control-Allow-Headers', CABECERAS_PERMITIDAS.join(', '));
      res.setHeader('Access-Control-Max-Age', String(MAX_AGE_PREFLIGHT_S));
      res.status(204).end();
      return;
    }
    res.setHeader('Access-Control-Expose-Headers', CABECERAS_EXPUESTAS.join(', '));
    next();
  };
}
