// Estadística de la medición de P3: percentiles exactos por rango más cercano.
import { describe, expect, it } from 'vitest';
import { medianaDeCorridas, percentil, resumir } from '../../scripts/medicion/estadistica.js';

describe('percentiles', () => {
  const cien = Array.from({ length: 100 }, (_, i) => i + 1); // 1..100

  it('rango más cercano sobre 1..100', () => {
    expect(percentil(cien, 50)).toBe(50);
    expect(percentil(cien, 95)).toBe(95);
    expect(percentil(cien, 99)).toBe(99);
    expect(percentil(cien, 100)).toBe(100);
    expect(percentil(cien, 0)).toBe(1);
  });

  it('pocos datos: p99 de 10 muestras es la máxima', () => {
    expect(percentil([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 99)).toBe(10);
    expect(percentil([7], 50)).toBe(7);
  });

  it('resumir ordena una copia (no toca las muestras) y calcula media y máximo', () => {
    const m = [5, 1, 4, 2, 3];
    expect(resumir(m)).toEqual({ n: 5, media: 3, p50: 3, p95: 5, p99: 5, max: 5 });
    expect(m).toEqual([5, 1, 4, 2, 3]);
  });

  it('sin muestras es un error (no un cero que parezca una medición)', () => {
    expect(() => percentil([], 50)).toThrow('sin muestras');
  });

  it('mediana de corridas con su rango', () => {
    expect(medianaDeCorridas([3, 1, 2, 5, 4])).toEqual({ mediana: 3, min: 1, max: 5 });
  });
});
