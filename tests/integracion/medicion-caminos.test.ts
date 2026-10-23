// Medición de P3: antes de comparar tiempos, los tres caminos (gRPC, REST 1.1, REST h2c) tienen que dar
// EXACTAMENTE el mismo resultado para la misma operación, exigir el token y contar bytes en el cable. No
// mide tiempos (eso lo hace scripts/medicion/medir.ts, fuera del CI).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { clienteGrpc, clienteH1, clienteH2, type ClienteMedicion } from '../../scripts/medicion/clientes.js';
import { levantarServidorMedicion, ORIGEN_MEDICION, type ServidorMedicion } from '../../scripts/medicion/servidor.js';

let s: ServidorMedicion;
let caminos: Record<'grpc' | 'grpcVarios' | 'h1' | 'h1Uno' | 'h2', ClienteMedicion>;

beforeAll(async () => {
  s = await levantarServidorMedicion();
  caminos = {
    grpc: clienteGrpc(`127.0.0.1:${String(s.puertos.grpc)}`, s.token, ORIGEN_MEDICION),
    grpcVarios: clienteGrpc(`127.0.0.1:${String(s.puertos.grpc)}`, s.token, ORIGEN_MEDICION, 4),
    h1: clienteH1(s.puertos.h1, s.token, ORIGEN_MEDICION, 8),
    h1Uno: clienteH1(s.puertos.h1, s.token, ORIGEN_MEDICION, 1),
    h2: clienteH2(s.puertos.h2, s.token, ORIGEN_MEDICION),
  };
});
afterAll(async () => {
  for (const c of Object.values(caminos)) await c.cerrar();
  await s.cerrar();
});

const contenido = (bytes: number) => 'palabra '.repeat(Math.ceil(bytes / 8)).slice(0, bytes);

describe('los tres caminos dan el mismo resultado', () => {
  it('U1 EmbeberConsulta: el mismo vector de 1024 floats de 32 bits, denso como uno real', async () => {
    const r = await Promise.all(Object.values(caminos).map((c) => c.embeber('índice de búsqueda ficticio')));
    for (const v of r) {
      expect(v).toHaveLength(1024);
      expect(v).toEqual(r[0]);
    }
    expect(r[0]?.every((x) => x !== 0)).toBe(true);
    expect(Math.hypot(...(r[0] ?? []))).toBeCloseTo(1, 5);
  });

  it.each([100, 8 * 1024, 64 * 1024])('U2 Explicar con %i B: el mismo texto', async (bytes) => {
    const r = await Promise.all(Object.values(caminos).map((c) => c.explicar(contenido(bytes))));
    expect(new Set(r).size).toBe(1);
    expect(r[0]).toContain('Explicación simulada');
  });

  it('S1 Resumir: los mismos fragmentos, en el mismo orden', async () => {
    const r = await Promise.all(Object.values(caminos).map((c) => c.resumir(contenido(8 * 1024))));
    for (const x of r) {
      expect(x.fragmentos).toBe(31);
      expect(x.texto).toBe(r[0]?.texto);
      expect(x.primeroMs).toBeGreaterThanOrEqual(0);
    }
  });

  it('muchos pedidos a la vez por cada camino: todos completos y correctos', async () => {
    for (const c of Object.values(caminos)) {
      const r = await Promise.all(Array.from({ length: 64 }, () => c.explicar(contenido(100))));
      expect(new Set(r).size).toBe(1);
    }
  });
});

describe('mismas reglas en los dos caminos', () => {
  it('sin el token: gRPC UNAUTHENTICATED y REST 401', async () => {
    const malos = [
      clienteGrpc(`127.0.0.1:${String(s.puertos.grpc)}`, 'x'.repeat(43), ORIGEN_MEDICION),
      clienteH1(s.puertos.h1, 'x'.repeat(43), ORIGEN_MEDICION, 1),
      clienteH2(s.puertos.h2, 'x'.repeat(43), ORIGEN_MEDICION),
    ];
    const [g, h1, h2] = await Promise.allSettled(malos.map((c) => c.explicar('hola')));
    expect(g).toMatchObject({ status: 'rejected', reason: { code: 16 } });
    expect(h1).toMatchObject({ status: 'rejected', reason: { message: 'HTTP 401' } });
    expect(h2).toMatchObject({ status: 'rejected', reason: { message: 'HTTP 401' } });
    for (const c of malos) await c.cerrar();
  });

  it('el mismo origen inválido se rechaza en los dos (INVALID_ARGUMENT y 400)', async () => {
    const malo = { ...ORIGEN_MEDICION, cuentaId: 'no-es-uuid' };
    const [g, h1] = await Promise.allSettled([
      clienteGrpc(`127.0.0.1:${String(s.puertos.grpc)}`, s.token, malo).explicar('hola'),
      clienteH1(s.puertos.h1, s.token, malo, 1).explicar('hola'),
    ]);
    expect(g).toMatchObject({ status: 'rejected', reason: { code: 3 } });
    expect(h1).toMatchObject({ status: 'rejected', reason: { message: 'HTTP 400' } });
  });
});

describe('bytes en el cable (proxy contador)', () => {
  it('cuenta pedido y respuesta de cada camino por separado', async () => {
    s.reiniciarBytes();
    const porProxy = {
      grpc: clienteGrpc(`127.0.0.1:${String(s.proxies.grpc)}`, s.token, ORIGEN_MEDICION),
      h1: clienteH1(s.proxies.h1, s.token, ORIGEN_MEDICION, 1),
      h2: clienteH2(s.proxies.h2, s.token, ORIGEN_MEDICION),
    };
    for (const c of Object.values(porProxy)) await c.embeber('hola');
    const b = s.bytes();
    for (const k of ['grpc', 'h1', 'h2'] as const) {
      expect(b[k].pedido).toBeGreaterThan(0);
      expect(b[k].respuesta).toBeGreaterThan(4096); // al menos el vector
    }
    for (const c of Object.values(porProxy)) await c.cerrar();
  });
});
