// Persistencia del documento en memoria (bloque M, mutación M01) SIN depender del tiempo: una base falsa
// retiene el INSERT del lote hasta que la prueba lo suelta, y en ese hueco llega otro cambio del mismo
// autor. Ese cambio tiene que guardarse en el lote siguiente. Si el lote fuera el MISMO arreglo que el
// búfer (y no una copia), el cambio se perdía: la prueba de convergencia lo encontró, pero solo cuando la
// carga hacía coincidir los tiempos.
import { pino } from 'pino';
import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import type { PrismaClient } from '../../src/generated/prisma/client.js';
import { DocumentoVivo, NOMBRE_TEXTO } from '../../src/tiempo-real/documento.js';
import { LIMITES_PRODUCCION } from '../../src/tiempo-real/limites.js';

const DOC = '00000000-0000-4000-8000-000000000001';
const AUTOR = '00000000-0000-4000-8000-000000000002';

/** Base falsa: el documento está vacío y cada INSERT queda en espera hasta que la prueba lo suelte. */
function baseRetenida() {
  const insertados: Uint8Array[] = [];
  const enEspera: (() => void)[] = [];
  const prisma = {
    $queryRaw: () => Promise.resolve([]),
    $executeRaw: (_partes: TemplateStringsArray, ...valores: unknown[]) =>
      new Promise<number>((resolver) => {
        enEspera.push(() => {
          insertados.push(new Uint8Array(valores[2] as Buffer));
          resolver(1);
        });
      }),
  } as unknown as PrismaClient;
  const soltar = async () => {
    while (enEspera.length === 0) await new Promise((r) => setImmediate(r));
    enEspera.shift()?.();
  };
  return { prisma, insertados, soltar };
}

/** Un cambio de Yjs que inserta `texto` al final de `origen` (y lo aplica ahí). */
function cambio(origen: Y.Doc, texto: string): Uint8Array {
  const antes = Y.encodeStateVector(origen);
  origen.getText(NOMBRE_TEXTO).insert(origen.getText(NOMBRE_TEXTO).length, texto);
  return Y.encodeStateAsUpdate(origen, antes);
}

describe('persistencia por lotes (M01, determinista)', () => {
  it('un cambio que llega MIENTRAS se inserta el lote se guarda en el lote siguiente', async () => {
    const b = baseRetenida();
    const doc = await DocumentoVivo.cargar(DOC, {
      prisma: b.prisma,
      log: pino({ level: 'silent' }),
      // Sin vaciado periódico: la prueba decide cuándo se vacía.
      limites: { ...LIMITES_PRODUCCION, vaciarMs: 2 ** 30 },
      alRechazoDeEscritura: () => undefined,
      pedirCompactacion: () => undefined,
    });
    const cliente = new Y.Doc();
    doc.guardar(AUTOR, cambio(cliente, 'uno '));
    const primero = doc.vaciar(); // el INSERT del lote 1 queda retenido…
    await new Promise((r) => setImmediate(r));
    doc.guardar(AUTOR, cambio(cliente, 'dos')); // …y en ese hueco llega otro cambio
    await b.soltar();
    await primero;
    expect(doc.tienePendientes()).toBe(true); // "dos" sigue en el búfer, no se descartó

    const segundo = doc.vaciar();
    await b.soltar();
    await segundo;
    expect(doc.tienePendientes()).toBe(false);

    // Lo guardado en la base, reconstruido de cero, es el texto completo.
    const reconstruido = new Y.Doc();
    for (const u of b.insertados) Y.applyUpdate(reconstruido, u);
    expect(b.insertados).toHaveLength(2);
    expect(reconstruido.getText(NOMBRE_TEXTO).toJSON()).toBe('uno dos');

    await doc.cerrar();
  });
});
