// Apagado ordenado probado con un servidor HTTP real en un puerto efímero. Se llama a apagar()
// directamente: así la prueba no depende de cómo cada sistema operativo entrega SIGTERM.
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { crearApagado } from '../../src/apagado.js';
import { appDePrueba, loggerEnMemoria } from '../_apoyo.js';

let servidor: Server | undefined;
afterEach(() => {
  servidor?.closeAllConnections();
  servidor?.close();
  servidor = undefined;
});

async function levantar(retardoMs: number) {
  const { app, estado } = appDePrueba({
    extender: (a) =>
      a.get('/lenta', (_req, res) => {
        setTimeout(() => res.json({ terminada: true }), retardoMs);
      }),
  });
  const s = app.listen(0, '127.0.0.1');
  await new Promise<void>((r) => {
    s.once('listening', () => {
      r();
    });
  });
  servidor = s;
  const { port } = s.address() as AddressInfo;
  return { s, estado, url: `http://127.0.0.1:${String(port)}` };
}

describe('apagado ordenado', () => {
  it('termina la petición en curso, rechaza nuevas conexiones y cierra recursos una sola vez', async () => {
    const { s, estado, url } = await levantar(400);
    let cierres = 0;
    const apagar = crearApagado({
      servidor: s,
      estado,
      log: loggerEnMemoria().log,
      limiteMs: 5000,
      cerrarRecursos: () => {
        cierres++;
        return Promise.resolve();
      },
    });

    const enCurso = fetch(`${url}/lenta`);
    await new Promise((r) => setTimeout(r, 50));
    const fin = apagar('SIGTERM');
    expect(estado.apagando).toBe(true);
    expect(apagar('SIGTERM')).toBe(fin);

    await expect(fetch(`${url}/health`)).rejects.toThrow();
    const r = await enCurso;
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ terminada: true });

    await fin;
    expect(cierres).toBe(1);
    expect(s.listening).toBe(false);
  });

  it('si se agota el límite, corta las conexiones que quedan y termina igual', async () => {
    const { s, estado, url } = await levantar(10_000);
    let cerrado = false;
    const apagar = crearApagado({
      servidor: s,
      estado,
      log: loggerEnMemoria().log,
      limiteMs: 200,
      cerrarRecursos: () => {
        cerrado = true;
        return Promise.resolve();
      },
    });
    const enCurso = fetch(`${url}/lenta`).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 50));
    const inicio = Date.now();
    await apagar('SIGTERM');
    expect(Date.now() - inicio).toBeLessThan(3000);
    expect(cerrado).toBe(true);
    expect(await enCurso).toBeInstanceOf(Error);
  });
});
