// Apoyo para probar la IA con gRPC REAL: el servicio escuchando en un puerto libre de 127.0.0.1 con el
// proveedor simulado (o uno propio) y un cliente del API con el token correcto.
import { randomBytes, randomUUID } from 'node:crypto';
import { ClienteIa, type Deadlines, type OrigenIa } from '../src/ia/cliente.js';
import type { ProveedorIa } from '../src/ia/proveedor.js';
import { ProveedorMock, type OpcionesMock } from '../src/ia/proveedor-mock.js';
import { crearServicioIa } from '../src/ia/servicio.js';
import { loggerEnMemoria } from './_apoyo.js';

export async function levantarIa(o: { mock?: OpcionesMock; proveedor?: ProveedorIa; deadlines?: Partial<Deadlines> } = {}) {
  const token = randomBytes(32).toString('base64url');
  const mock = new ProveedorMock(o.mock);
  const proveedor = o.proveedor ?? mock;
  const { log, lineas } = loggerEnMemoria();
  const servicio = crearServicioIa({ proveedor, token, log });
  const puerto = await servicio.escuchar('127.0.0.1', 0);
  const url = `127.0.0.1:${String(puerto)}`;
  const cliente = new ClienteIa({ url, token, ...(o.deadlines ? { deadlines: o.deadlines } : {}) });
  return {
    servicio,
    mock,
    lineas,
    token,
    url,
    cliente,
    /** Otro cliente contra el mismo servicio (con otro token, para probar la autenticación). */
    clienteCon: (t: string, deadlines?: Partial<Deadlines>) => new ClienteIa({ url, token: t, ...(deadlines ? { deadlines } : {}) }),
    cerrar: async () => {
      cliente.cerrar();
      await servicio.cerrar(1000);
    },
  };
}

export const origenFicticio = (o: Partial<OrigenIa> = {}): OrigenIa => ({
  cuentaId: randomUUID(),
  espacioId: randomUUID(),
  documentoId: randomUUID(),
  solicitudId: 'prueba-ia',
  ...o,
});

/** Espera a que una condición se cumpla (o falla a los `ms`). */
export async function hasta(condicion: () => boolean, ms = 3000): Promise<void> {
  const limite = Date.now() + ms;
  while (!condicion()) {
    if (Date.now() > limite) throw new Error('la condición no se cumplió a tiempo');
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** Texto ficticio largo (para corrientes con muchos fragmentos). */
export const textoLargo = (palabra: string, n: number) => Array.from({ length: n }, (_, i) => `${palabra}${String(i)}`).join(' ');
