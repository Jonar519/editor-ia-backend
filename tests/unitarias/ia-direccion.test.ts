// Dónde escucha el servicio de IA en un contenedor: IA_HOST configurable, también IPv6 ("::", la red privada
// de Railway), con la dirección gRPC bien formada.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cargarConfigIa } from '../../src/ia/config.js';
import { direccionGrpc } from '../../src/ia/servicio.js';

describe('dirección del servicio de IA', () => {
  it('IPv4 y nombres van tal cual; IPv6 entre corchetes (":::4210" no se entiende)', () => {
    expect(direccionGrpc('127.0.0.1', 4210)).toBe('127.0.0.1:4210');
    expect(direccionGrpc('0.0.0.0', 4210)).toBe('0.0.0.0:4210');
    expect(direccionGrpc('localhost', 0)).toBe('localhost:0');
    expect(direccionGrpc('::', 4210)).toBe('[::]:4210');
    expect(direccionGrpc('::1', 4210)).toBe('[::1]:4210');
    expect(direccionGrpc('[::1]', 4210)).toBe('[::1]:4210');
  });

  it('IA_HOST se configura (por defecto solo 127.0.0.1)', () => {
    const token = randomBytes(32).toString('base64url');
    expect(cargarConfigIa({ IA_SERVICE_TOKEN: token }).IA_HOST).toBe('127.0.0.1');
    expect(cargarConfigIa({ IA_SERVICE_TOKEN: token, IA_HOST: '::' }).IA_HOST).toBe('::');
    expect(cargarConfigIa({ IA_SERVICE_TOKEN: token, IA_HOST: '0.0.0.0', IA_PORT: '4210' })).toMatchObject({ IA_HOST: '0.0.0.0', IA_PORT: 4210 });
  });
});
