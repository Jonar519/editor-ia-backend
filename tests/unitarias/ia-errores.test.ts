// Tabla de errores gRPC → HTTP del ADR 0002, fila por fila (las de integración la recorren con el servicio
// real; aquí también las que el simulado no produce: UNAUTHENTICATED, PERMISSION_DENIED, CANCELLED).
import * as grpc from '@grpc/grpc-js';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { errorGrpc } from '../../src/ia/cliente.js';
import { errorHttpDeIa, falloDeGrpc } from '../../src/ia/errores.js';
import { ErrorHttp } from '../../src/http/errores.js';

describe('falloDeGrpc', () => {
  it.each([
    [grpc.status.INVALID_ARGUMENT, 400, 'ia_solicitud_invalida'],
    [grpc.status.RESOURCE_EXHAUSTED, 429, 'ia_saturada'],
    [grpc.status.DEADLINE_EXCEEDED, 504, 'ia_tiempo_agotado'],
    [grpc.status.UNAVAILABLE, 503, 'ia_no_disponible'],
    [grpc.status.UNAUTHENTICATED, 502, 'ia_error_interno'],
    [grpc.status.PERMISSION_DENIED, 502, 'ia_error_interno'],
    [grpc.status.INTERNAL, 502, 'ia_error_interno'],
    [grpc.status.UNIMPLEMENTED, 502, 'ia_error_interno'],
    [grpc.status.UNKNOWN, 502, 'ia_error_interno'],
  ])('%s → %s %s', (codigo, estado, nombre) => {
    expect(falloDeGrpc(errorGrpc(codigo, 'detalle interno'))).toMatchObject({ estado, codigo: nombre });
  });

  it('CANCELLED: la persona ya se fue; no se responde (null)', () => {
    expect(falloDeGrpc(errorGrpc(grpc.status.CANCELLED, 'cancelado'))).toBeNull();
  });

  it('RESOURCE_EXHAUSTED lleva Retry-After solo si el servicio mandó un número razonable', () => {
    const con = errorGrpc(grpc.status.RESOURCE_EXHAUSTED, 'x');
    con.metadata.set('retry-after', '12');
    expect(falloDeGrpc(con)?.reintentarEnS).toBe(12);
    const raro = errorGrpc(grpc.status.RESOURCE_EXHAUSTED, 'x');
    raro.metadata.set('retry-after', '12; DROP');
    expect(falloDeGrpc(raro)).not.toHaveProperty('reintentarEnS');
  });
});

describe('errorHttpDeIa (para las rutas)', () => {
  const respuesta = () => {
    const cabeceras: Record<string, string> = {};
    return { cabeceras, res: { setHeader: (n: string, v: string) => (cabeceras[n] = v) } as unknown as Response };
  };

  it('un error gRPC → ErrorHttp con el mensaje genérico (nunca el detalle del servicio) y Retry-After', () => {
    const { cabeceras, res } = respuesta();
    const e = errorGrpc(grpc.status.RESOURCE_EXHAUSTED, 'detalle interno del proveedor');
    e.metadata.set('retry-after', '5');
    const r = errorHttpDeIa(e, res);
    expect(r).toBeInstanceOf(ErrorHttp);
    expect((r as ErrorHttp).message).not.toContain('detalle interno');
    expect(cabeceras['Retry-After']).toBe('5');
  });

  it('CANCELLED → null; un error que no es de gRPC sigue tal cual', () => {
    const { res } = respuesta();
    expect(errorHttpDeIa(errorGrpc(grpc.status.CANCELLED, 'x'), res)).toBeNull();
    const propio = new Error('otro');
    expect(errorHttpDeIa(propio, res)).toBe(propio);
  });
});
