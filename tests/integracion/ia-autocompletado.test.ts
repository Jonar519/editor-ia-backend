// Autocompletado por el WebSocket del documento (bloque P1, ADR 0002 decisión 3) con sockets REALES y el
// servicio gRPC REAL: un editor recibe sugerencias, un lector no (ni se llama a la IA), un pedido nuevo
// deja sin respuesta al anterior, el tope de tokens corta, y un control mal formado cierra con 4400.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { iaTiempoReal } from '../../src/ia/autocompletado.js';
import { CIERRE } from '../../src/tiempo-real/limites.js';
import { levantarIa } from '../_ia.js';
import { conectar, esperar, levantar, type Entorno } from '../_tiempo-real.js';

let x: Awaited<ReturnType<typeof levantarIa>>;
let t: Entorno;

beforeAll(async () => {
  x = await levantarIa({ mock: { retrasoRespuestaMs: 100 } });
  t = await levantar({ avisos: false }); // sin IA
});
afterAll(async () => {
  await t.cerrar();
  await x.cerrar();
});

/** Un entorno de tiempo real CON IA (tope de tokens alto salvo en la prueba del tope). */
const entorno = (topes = { peticionesDia: 100, tokensDia: 1_000_000 }) => levantar({ avisos: false, ia: iaTiempoReal(x.cliente, t.e.prisma, topes) });

describe('autocompletado por el WebSocket', () => {
  it('un editor recibe la sugerencia con su número de pedido; el uso queda registrado', async () => {
    const e = await entorno();
    try {
      const dueno = await e.persona();
      const { documentoId } = await e.documentoCon(dueno);
      const c = conectar(e.url, ['cuaderno.v1', `ticket.${await e.ticket(dueno, documentoId)}`]);
      await c.abierto;
      await esperar(() => c.rol !== null);
      c.autocompletar(1, 'La función devuelve el total');
      await esperar(() => c.sugerencias.length === 1);
      expect(c.sugerencias[0]).toEqual({ tipo: 'ia.sugerencia', pedido: 1, texto: ' (sugerencia simulada tras «total»)' });
      await esperar(async () => {
        const u = await e.e.prisma.$queryRaw<{ tokens_salida: bigint; peticiones: number }[]>`
          SELECT tokens_salida, peticiones FROM uso_ia_diario WHERE usuario_id = ${dueno.id}::uuid`;
        return Number(u[0]?.tokens_salida ?? 0) > 0 && u[0]?.peticiones === 0; // el autocompletado no cuenta como petición
      });
      c.ws.close();
    } finally {
      await e.cerrar();
    }
  });

  it('un lector no autocompleta: responde sin_permiso y NO se llama a la IA', async () => {
    const e = await entorno();
    try {
      const dueno = await e.persona();
      const lector = await e.persona('lector');
      const { documentoId } = await e.documentoCon(dueno, [[lector, 'lector']]);
      const antes = x.lineas.filter((l) => l.metodo === 'Autocompletar').length;
      const c = conectar(e.url, ['cuaderno.v1', `ticket.${await e.ticket(lector, documentoId)}`]);
      await c.abierto;
      await esperar(() => c.rol === 'lector');
      c.autocompletar(7, 'Texto de un lector');
      await esperar(() => c.sugerencias.length === 1);
      expect(c.sugerencias[0]).toEqual({ tipo: 'ia.sugerencia', pedido: 7, error: 'sin_permiso' });
      await new Promise((r) => setTimeout(r, 200));
      expect(x.lineas.filter((l) => l.metodo === 'Autocompletar')).toHaveLength(antes);
      c.ws.close();
    } finally {
      await e.cerrar();
    }
  });

  it('un pedido nuevo deja sin respuesta al anterior (solo llega la del último)', async () => {
    const e = await entorno();
    try {
      const dueno = await e.persona();
      const { documentoId } = await e.documentoCon(dueno);
      const c = conectar(e.url, ['cuaderno.v1', `ticket.${await e.ticket(dueno, documentoId)}`]);
      await c.abierto;
      await esperar(() => c.rol !== null);
      c.autocompletar(1, 'uno');
      c.autocompletar(2, 'uno dos');
      c.autocompletar(3, 'uno dos tres');
      await esperar(() => c.sugerencias.some((s) => s.pedido === 3));
      await new Promise((r) => setTimeout(r, 300));
      expect(c.sugerencias.map((s) => s.pedido)).toEqual([3]);
      expect(c.sugerencias[0]?.texto).toContain('«tres»');
      c.ws.close();
    } finally {
      await e.cerrar();
    }
  });

  it('el tope diario de tokens corta con tope_diario_ia', async () => {
    const e = await entorno({ peticionesDia: 100, tokensDia: 1 });
    try {
      const dueno = await e.persona();
      const { documentoId } = await e.documentoCon(dueno);
      const c = conectar(e.url, ['cuaderno.v1', `ticket.${await e.ticket(dueno, documentoId)}`]);
      await c.abierto;
      await esperar(() => c.rol !== null);
      c.autocompletar(1, 'primera sugerencia');
      await esperar(() => c.sugerencias.length === 1);
      expect(c.sugerencias[0]?.texto).toBeDefined();
      await new Promise((r) => setTimeout(r, 100)); // que se registre el uso
      c.autocompletar(2, 'segunda');
      await esperar(() => c.sugerencias.length === 2);
      expect(c.sugerencias[1]).toEqual({ tipo: 'ia.sugerencia', pedido: 2, error: 'tope_diario_ia' });
      c.ws.close();
    } finally {
      await e.cerrar();
    }
  });

  it('sin IA configurada: ia_no_disponible; un control que no es JSON cierra con 4400', async () => {
    const dueno = await t.persona();
    const { documentoId } = await t.documentoCon(dueno);
    const c = conectar(t.url, ['cuaderno.v1', `ticket.${await t.ticket(dueno, documentoId)}`]);
    await c.abierto;
    await esperar(() => c.rol !== null);
    c.autocompletar(1, 'hola');
    await esperar(() => c.sugerencias.length === 1);
    expect(c.sugerencias[0]).toEqual({ tipo: 'ia.sugerencia', pedido: 1, error: 'ia_no_disponible' });
    c.mandarControl(JSON.stringify({ tipo: 'otro.tipo' })); // desconocido: se ignora
    c.mandarControl('{no es json');
    expect((await c.cerrado).codigo).toBe(CIERRE.malFormado);
  });

  it('un pedido con campos de otro tipo cierra con 4400', async () => {
    const dueno = await t.persona();
    const { documentoId } = await t.documentoCon(dueno);
    const c = conectar(t.url, ['cuaderno.v1', `ticket.${await t.ticket(dueno, documentoId)}`]);
    await c.abierto;
    await esperar(() => c.rol !== null);
    c.mandarControl(JSON.stringify({ tipo: 'ia.autocompletar', pedido: -1, antes: 'x', despues: '' }));
    expect((await c.cerrado).codigo).toBe(CIERRE.malFormado);
  });
});
