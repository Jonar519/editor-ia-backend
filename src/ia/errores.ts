// Mapeo de errores gRPC → HTTP en el gateway (tabla del ADR 0002). La persona ve un código estable y un
// mensaje genérico; el detalle del servicio queda en el log.
import * as grpc from '@grpc/grpc-js';
import type { Response } from 'express';
import { ErrorHttp } from '../http/errores.js';

export interface FalloIa {
  estado: number;
  codigo: string;
  mensaje: string;
  /** Con 429: segundos a esperar (cabecera Retry-After), si el servicio los indicó. */
  reintentarEnS?: number;
}

const esServiceError = (e: unknown): e is grpc.ServiceError =>
  e instanceof Error && typeof (e as Partial<grpc.ServiceError>).code === 'number' && (e as Partial<grpc.ServiceError>).metadata instanceof grpc.Metadata;

/** ¿Es un error de una llamada gRPC? (los demás son errores propios del API y siguen su camino). */
export const esErrorGrpc = esServiceError;

/**
 * Traduce un error gRPC. Devuelve null para CANCELLED: la persona ya se fue (abortó el fetch o cerró el
 * WebSocket), no hay a quién responder; solo se registra.
 */
export function falloDeGrpc(e: grpc.ServiceError): FalloIa | null {
  switch (e.code) {
    case grpc.status.INVALID_ARGUMENT:
      return { estado: 400, codigo: 'ia_solicitud_invalida', mensaje: 'La IA no pudo procesar esa solicitud' };
    case grpc.status.RESOURCE_EXHAUSTED: {
      const crudo = e.metadata.get('retry-after')[0];
      const s = typeof crudo === 'string' && /^\d{1,6}$/.test(crudo) ? Number(crudo) : undefined;
      return { estado: 429, codigo: 'ia_saturada', mensaje: 'La IA está saturada. Espera un momento.', ...(s === undefined ? {} : { reintentarEnS: s }) };
    }
    case grpc.status.DEADLINE_EXCEEDED:
      return { estado: 504, codigo: 'ia_tiempo_agotado', mensaje: 'La IA tardó demasiado en responder' };
    case grpc.status.UNAVAILABLE:
      return { estado: 503, codigo: 'ia_no_disponible', mensaje: 'La IA no está disponible en este momento' };
    case grpc.status.CANCELLED:
      return null;
    default:
      // UNAUTHENTICATED y PERMISSION_DENIED son errores ENTRE servicios (token o TLS mal puestos), no de la
      // persona: como cualquier otro, 502.
      return { estado: 502, codigo: 'ia_error_interno', mensaje: 'El servicio de IA falló' };
  }
}

/**
 * Para las rutas: un error gRPC se convierte en ErrorHttp (y pone Retry-After en la respuesta); CANCELLED
 * devuelve null (no se responde). Cualquier otro error se devuelve tal cual, para el manejador general.
 */
export function errorHttpDeIa(e: unknown, res: Response): unknown {
  if (!esServiceError(e)) return e;
  const f = falloDeGrpc(e);
  if (!f) return null;
  if (f.reintentarEnS !== undefined) res.setHeader('Retry-After', String(f.reintentarEnS));
  return new ErrorHttp(f.estado, f.codigo, f.mensaje);
}
