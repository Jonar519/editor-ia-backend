// Diferencia por líneas (restaurar como cambio nuevo, bloque N): con semilla, sobre textos al azar.
import * as Y from 'yjs';
import { describe, expect, it } from 'vitest';
import { diferenciaPorLineas, llevarA, partirLineas } from '../../src/versiones/lineas.js';

function azarCon(semilla: number) {
  let a = semilla >>> 0;
  return (n: number): number => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return Math.floor((((t ^ (t >>> 14)) >>> 0) / 4294967296) * n);
  };
}

/** Un texto de líneas cortas de un alfabeto chico (muchas coincidencias, como un documento real). */
function textoAlAzar(entero: (n: number) => number): string {
  const lineas = Array.from({ length: entero(25) }, () => ['# Título', 'uno', 'dos', '', '```', 'código', '- lista'][entero(7)] ?? '');
  return lineas.join('\n') + (entero(2) === 0 ? '\n' : '');
}

describe('diferencia por líneas', () => {
  it('partir y unir reproduce el texto exacto (con o sin salto final, con \\r\\n)', () => {
    for (const t of ['', 'a', 'a\n', 'a\nb', 'a\r\nb\r\n', '\n\n']) expect(partirLineas(t).join('')).toBe(t);
  });

  it('con semilla: las operaciones llevan de A a B y lo igual es de verdad igual', () => {
    for (let s = 1; s <= 300; s++) {
      const entero = azarCon(s);
      const a = textoAlAzar(entero);
      const b = textoAlAzar(entero);
      const ops = diferenciaPorLineas(a, b);
      const desdeA = ops.filter((o) => o.tipo !== 'agregar').flatMap((o) => o.lineas).join('');
      const haciaB = ops.filter((o) => o.tipo !== 'quitar').flatMap((o) => o.lineas).join('');
      expect(desdeA, `semilla ${String(s)}`).toBe(a);
      expect(haciaB, `semilla ${String(s)}`).toBe(b);
    }
  });

  it('mínima: cambiar una línea en medio es quitar una y agregar una', () => {
    const ops = diferenciaPorLineas('a\nb\nc\n', 'a\nX\nc\n');
    expect(ops).toEqual([
      { tipo: 'igual', lineas: ['a\n'] },
      { tipo: 'quitar', lineas: ['b\n'] },
      { tipo: 'agregar', lineas: ['X\n'] },
      { tipo: 'igual', lineas: ['c\n'] },
    ]);
  });

  it('llevarA deja el Y.Text igual a la versión y conserva lo que no cambió (su identidad en Yjs)', () => {
    for (let s = 1; s <= 100; s++) {
      const entero = azarCon(s);
      const doc = new Y.Doc();
      const t = doc.getText('contenido');
      t.insert(0, textoAlAzar(entero));
      const objetivo = textoAlAzar(entero);
      llevarA(t, objetivo);
      expect(t.toJSON(), `semilla ${String(s)}`).toBe(objetivo);
    }
    // Una posición relativa en una línea que no cambia sigue apuntando a ella después de restaurar.
    const doc = new Y.Doc();
    const t = doc.getText('contenido');
    t.insert(0, 'uno\ndos\ntres\n');
    const ancla = Y.createRelativePositionFromTypeIndex(t, 'uno\ndos\n'.length); // inicio de "tres"
    llevarA(t, 'cero\nuno\ndos cambiado\ntres\n');
    const abs = Y.createAbsolutePositionFromRelativePosition(ancla, doc);
    expect(t.toJSON().slice(abs?.index ?? -1)).toBe('tres\n');
  });

  it('en una línea cambiada, lo que no cambió de ESA línea conserva su ancla (prueba en vivo de N)', () => {
    const doc = new Y.Doc();
    const t = doc.getText('contenido');
    t.insert(0, 'Guia de la API v2\nLinea nueva');
    const inicio = Y.createRelativePositionFromTypeIndex(t, 'Guia de la '.length, 0);
    const fin = Y.createRelativePositionFromTypeIndex(t, 'Guia de la API'.length, -1);
    llevarA(t, 'Guia de la API');
    const a = Y.createAbsolutePositionFromRelativePosition(inicio, doc)?.index ?? -1;
    const b = Y.createAbsolutePositionFromRelativePosition(fin, doc)?.index ?? -1;
    expect(t.toJSON().slice(a, b)).toBe('API');
  });
});
