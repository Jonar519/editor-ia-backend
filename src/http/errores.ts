import type { ErrorRequestHandler, RequestHandler } from 'express';
import type { Logger } from 'pino';
import { ZodError } from 'zod';

/** Error con estado HTTP y código estable para el cliente. */
export class ErrorHttp extends Error {
  constructor(
    readonly estado: number,
    readonly codigo: string,
    mensaje: string,
    readonly detalles?: unknown,
  ) {
    super(mensaje);
    this.name = 'ErrorHttp';
  }
}

interface CuerpoError {
  error: { codigo: string; mensaje: string; solicitud: string; detalles?: unknown };
}

function cuerpo(codigo: string, mensaje: string, solicitud: string, detalles?: unknown): CuerpoError {
  return { error: { codigo, mensaje, solicitud, ...(detalles === undefined ? {} : { detalles }) } };
}

/** pino-http asigna req.id (siempre string aquí: lo genera crearApp). */
const idDe = (id: unknown): string => (typeof id === 'string' || typeof id === 'number' ? String(id) : '');

export const noEncontrado: RequestHandler = (req, res) => {
  res.status(404).json(cuerpo('no_encontrado', 'Ruta no encontrada', idDe(req.id)));
};

/** Errores de body-parser: traen "type" y "status". */
function esErrorDeCuerpo(e: unknown): e is { type: string; status: number } {
  return typeof e === 'object' && e !== null && 'type' in e && 'status' in e;
}

/**
 * Manejador final. Nunca devuelve la pila ni el mensaje de un error inesperado: el cliente recibe un
 * mensaje genérico con el id de la solicitud, y el detalle completo queda en el log.
 */
export function manejadorErrores(log: Logger): ErrorRequestHandler {
  return (err: unknown, req, res, _next) => {
    const solicitud = idDe(req.id);
    if (err instanceof ErrorHttp) {
      res.status(err.estado).json(cuerpo(err.codigo, err.message, solicitud, err.detalles));
      return;
    }
    if (err instanceof ZodError) {
      const detalles = err.issues.map((i) => ({ ruta: i.path.join('.'), mensaje: i.message }));
      res.status(400).json(cuerpo('validacion', 'Datos inválidos', solicitud, detalles));
      return;
    }
    if (esErrorDeCuerpo(err) && err.type === 'entity.parse.failed') {
      res.status(400).json(cuerpo('json_invalido', 'El cuerpo no es JSON válido', solicitud));
      return;
    }
    if (esErrorDeCuerpo(err) && err.type === 'entity.too.large') {
      res.status(413).json(cuerpo('cuerpo_demasiado_grande', 'El cuerpo supera el tamaño permitido', solicitud));
      return;
    }
    if (esErrorDeCuerpo(err) && err.type === 'encoding.unsupported') {
      res.status(415).json(cuerpo('codificacion_no_admitida', 'El cuerpo no puede venir comprimido (Content-Encoding)', solicitud));
      return;
    }
    log.error({ err, solicitud }, 'error no controlado');
    res.status(500).json(cuerpo('interno', 'Error interno', solicitud));
  };
}
