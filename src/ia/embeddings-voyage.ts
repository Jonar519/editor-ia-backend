// Embeddings reales con Voyage AI (POST /v1/embeddings), para el proveedor "anthropic" (Anthropic no tiene
// modelo de embeddings propio). Sin SDK: un fetch con la AbortSignal del servicio.
//
//   - output_dimension = DIMENSIONES (1024): la columna es vector(1024). voyage-3.5 la admite; un modelo que
//     no la respete sale con otro largo y el servicio lo rechaza (verificarVectores) antes de guardarlo.
//   - input_type: "query" para la consulta de búsqueda y "document" para los fragmentos (Voyage antepone
//     una instrucción distinta a cada uno: mejora la búsqueda).
//   - Lotes de a lo sumo 128 textos y ~400 000 caracteres (por debajo de los topes de Voyage por pedido).
//   - Errores: 429 → "limite" con su Retry-After; 5xx, red o tiempo → "no_disponible"; abortar → "cancelado";
//     4xx → "interno" (clave o modelo mal configurados: no es culpa de la persona). El cuerpo de la respuesta
//     nunca va al mensaje de error (podría repetir el texto enviado).
import { DIMENSIONES } from './contrato.js';
import { ErrorProveedor, type TipoEmbedding, type Uso } from './proveedor.js';

export const URL_VOYAGE = 'https://api.voyageai.com/v1/embeddings';
export const LOTE_MAX_TEXTOS = 128;
export const LOTE_MAX_CARACTERES = 400_000;

export interface OpcionesVoyage {
  clave: string;
  modelo: string;
  /** Solo pruebas: un fetch falso. */
  fetch?: typeof fetch;
}

/** Retry-After en segundos (entero ≥ 1), si viene bien formado. */
export function segundosDeEspera(valor: string | null | undefined): number | undefined {
  if (!valor || !/^\d{1,6}$/.test(valor.trim())) return undefined;
  return Math.max(1, Number(valor.trim()));
}

/** Parte los textos en lotes que respetan los topes de cantidad y de caracteres. */
export function enLotes(textos: string[]): string[][] {
  const lotes: string[][] = [];
  let actual: string[] = [];
  let caracteres = 0;
  for (const t of textos) {
    if (actual.length > 0 && (actual.length >= LOTE_MAX_TEXTOS || caracteres + t.length > LOTE_MAX_CARACTERES)) {
      lotes.push(actual);
      actual = [];
      caracteres = 0;
    }
    actual.push(t);
    caracteres += t.length;
  }
  if (actual.length > 0) lotes.push(actual);
  return lotes;
}

interface RespuestaVoyage {
  data?: { embedding?: unknown; index?: unknown }[];
  usage?: { total_tokens?: unknown };
}

export function crearEmbeddingsVoyage(o: OpcionesVoyage) {
  const pedir = o.fetch ?? globalThis.fetch.bind(globalThis);

  async function lote(textos: string[], senal: AbortSignal, tipo: TipoEmbedding): Promise<{ vectores: number[][]; tokens: number }> {
    let r: Response;
    try {
      r = await pedir(URL_VOYAGE, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${o.clave}` },
        body: JSON.stringify({ input: textos, model: o.modelo, input_type: tipo === 'consulta' ? 'query' : 'document', output_dimension: DIMENSIONES }),
        signal: senal,
      });
    } catch {
      if (senal.aborted) throw new ErrorProveedor('cancelado', 'cancelado');
      throw new ErrorProveedor('no_disponible', 'voyage: sin respuesta (red)');
    }
    if (r.status === 429) throw new ErrorProveedor('limite', 'voyage: límite de uso', segundosDeEspera(r.headers.get('retry-after')));
    if (r.status >= 500) throw new ErrorProveedor('no_disponible', `voyage: error ${String(r.status)}`);
    if (!r.ok) throw new ErrorProveedor('interno', `voyage: respondió ${String(r.status)}`);
    let cuerpo: RespuestaVoyage;
    try {
      cuerpo = (await r.json()) as RespuestaVoyage;
    } catch {
      if (senal.aborted) throw new ErrorProveedor('cancelado', 'cancelado');
      throw new ErrorProveedor('interno', 'voyage: respuesta que no es JSON');
    }
    const datos = Array.isArray(cuerpo.data) ? cuerpo.data : [];
    if (datos.length !== textos.length) throw new ErrorProveedor('interno', `voyage: ${String(datos.length)} vectores para ${String(textos.length)} textos`);
    const vectores = new Array<number[]>(textos.length);
    for (const d of datos) {
      const i = d.index;
      if (typeof i !== 'number' || !Number.isInteger(i) || i < 0 || i >= textos.length || vectores[i] !== undefined || !Array.isArray(d.embedding)) {
        throw new ErrorProveedor('interno', 'voyage: respuesta con formato inesperado');
      }
      vectores[i] = d.embedding as number[];
    }
    const tokens = typeof cuerpo.usage?.total_tokens === 'number' ? cuerpo.usage.total_tokens : 0;
    return { vectores, tokens };
  }

  return {
    modelo: o.modelo,
    async embeber(textos: string[], senal: AbortSignal, tipo: TipoEmbedding = 'documento'): Promise<{ vectores: number[][]; uso: Uso }> {
      const vectores: number[][] = [];
      let tokens = 0;
      for (const l of enLotes(textos)) {
        if (senal.aborted) throw new ErrorProveedor('cancelado', 'cancelado');
        const r = await lote(l, senal, tipo);
        vectores.push(...r.vectores);
        tokens += r.tokens;
      }
      return { vectores, uso: { entrada: tokens, salida: 0 } };
    },
  };
}
