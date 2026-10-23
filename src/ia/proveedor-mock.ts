// Proveedor simulado: determinista, sin red y sin costo. Funciona de punta a punta para la demo y las
// pruebas. Repite trozos del contenido que recibe A PROPÓSITO: así una prueba de aislamiento ve enseguida
// si el contenido de un espacio aparece en la respuesta de otro.
//
// Embeddings por "hashing de palabras": cada palabra (sin mayúsculas ni tildes) suma ±1 en una dimensión
// elegida por su SHA-256, y el vector se normaliza. Dos textos con palabras en común quedan cerca (coseno),
// así la búsqueda semántica se puede probar con resultados que tienen sentido.
import { createHash } from 'node:crypto';
import { DIMENSIONES } from './contrato.js';
import { ErrorProveedor, esperar, tokensAprox, type Estilo, type ProveedorIa, type Uso } from './proveedor.js';

export interface OpcionesMock {
  /** Pausa entre fragmentos de un stream (resumir, mejorar). */
  retrasoFragmentoMs?: number;
  /** Pausa antes de responder explicar, embeber y autocompletar. */
  retrasoRespuestaMs?: number;
}

const palabras = (texto: string): string[] =>
  texto
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/** Vector unitario de DIMENSIONES a partir de las palabras del texto. Sin palabras: el primer eje. */
export function vectorDe(texto: string): number[] {
  const v = new Array<number>(DIMENSIONES).fill(0);
  for (const p of palabras(texto)) {
    const h = createHash('sha256').update(p).digest();
    const i = h.readUInt32BE(0) % DIMENSIONES;
    v[i] = (v[i] ?? 0) + ((h[4] ?? 0) & 1 ? 1 : -1);
  }
  const norma = Math.hypot(...v);
  if (norma === 0) {
    v[0] = 1;
    return v;
  }
  return v.map((x) => x / norma);
}

const NOMBRE_ESTILO: Record<Estilo, string> = { claro: 'claro', breve: 'breve', formal: 'formal' };

export class ProveedorMock implements ProveedorIa {
  readonly nombre = 'mock';
  readonly modeloEmbeddings = 'mock-palabras-1024';
  readonly dimensiones = DIMENSIONES;
  /** Fragmentos generados desde que se creó: una prueba de cancelación mira que deje de crecer. */
  generados = 0;
  /** Si está puesto, cada operación falla con este error (para probar el mapeo de errores). */
  fallo: ErrorProveedor | null = null;

  constructor(private readonly o: OpcionesMock = {}) {}

  private async antes(senal: AbortSignal): Promise<void> {
    if (this.fallo) throw this.fallo;
    await esperar(this.o.retrasoRespuestaMs ?? 0, senal);
  }

  async explicar(e: { contenido: string; lenguaje: string }, senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    await this.antes(senal);
    const ps = e.contenido.split(/\s+/).filter(Boolean);
    const texto = `Explicación simulada${e.lenguaje ? ` (${e.lenguaje})` : ''}: el fragmento tiene ${String(ps.length)} palabras y empieza con «${ps.slice(0, 8).join(' ')}».`;
    return { texto, uso: { entrada: tokensAprox(e.contenido), salida: tokensAprox(texto) } };
  }

  async *transformar(e: { tarea: 'resumir' | 'mejorar'; contenido: string; estilo: Estilo }, senal: AbortSignal): AsyncGenerator<string, Uso> {
    if (this.fallo) throw this.fallo;
    const ps = e.contenido.split(/\s+/).filter(Boolean);
    // Resumir: un encabezado y las primeras palabras. Mejorar: el texto entero, palabra por palabra.
    const salida =
      e.tarea === 'resumir'
        ? [`Resumen simulado (${NOMBRE_ESTILO[e.estilo]}):`, ...ps.slice(0, 30)]
        : [`Versión ${NOMBRE_ESTILO[e.estilo]} simulada:`, ...ps];
    let generado = '';
    for (const [i, p] of salida.entries()) {
      if (i > 0) await esperar(this.o.retrasoFragmentoMs ?? 0, senal);
      if (senal.aborted) throw new ErrorProveedor('cancelado', 'cancelado');
      const trozo = i === 0 ? p : ` ${p}`;
      generado += trozo;
      this.generados++;
      yield trozo;
    }
    return { entrada: tokensAprox(e.contenido), salida: tokensAprox(generado) };
  }

  async embeber(textos: string[], senal: AbortSignal): Promise<{ vectores: number[][]; uso: Uso }> {
    await this.antes(senal);
    return { vectores: textos.map(vectorDe), uso: { entrada: textos.reduce((n, t) => n + tokensAprox(t), 0), salida: 0 } };
  }

  async autocompletar(e: { antes: string; despues: string }, senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    await this.antes(senal);
    const ultima = e.antes.split(/\s+/).filter(Boolean).at(-1) ?? '';
    const texto = ultima ? ` (sugerencia simulada tras «${ultima}»)` : 'Sugerencia simulada.';
    this.generados++;
    return { texto, uso: { entrada: tokensAprox(e.antes + e.despues), salida: tokensAprox(texto) } };
  }
}
