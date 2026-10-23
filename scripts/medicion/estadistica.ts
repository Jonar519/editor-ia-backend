// Estadística de la medición de P3, sin librerías: percentiles EXACTOS (se ordenan todas las muestras) por
// rango más cercano, y la mediana de varias corridas con su rango.

export interface Resumen {
  n: number;
  media: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

/** Percentil por rango más cercano: el menor valor con al menos p% de las muestras a su izquierda o igual. */
export function percentil(ordenadas: readonly number[], p: number): number {
  if (ordenadas.length === 0) throw new Error('sin muestras');
  if (p <= 0) return ordenadas[0] ?? 0;
  const rango = Math.ceil((p / 100) * ordenadas.length);
  return ordenadas[Math.min(rango, ordenadas.length) - 1] ?? 0;
}

export function resumir(muestras: readonly number[]): Resumen {
  const o = [...muestras].sort((a, b) => a - b);
  return {
    n: o.length,
    media: o.reduce((s, x) => s + x, 0) / o.length,
    p50: percentil(o, 50),
    p95: percentil(o, 95),
    p99: percentil(o, 99),
    max: o.at(-1) ?? 0,
  };
}

/** Mediana de varias corridas y su rango (mínimo y máximo), para ver cuánto varía entre repeticiones. */
export function medianaDeCorridas(valores: readonly number[]): { mediana: number; min: number; max: number } {
  const o = [...valores].sort((a, b) => a - b);
  return { mediana: percentil(o, 50), min: o[0] ?? 0, max: o.at(-1) ?? 0 };
}
