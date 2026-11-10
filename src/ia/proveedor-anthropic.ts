// Proveedor real: Claude (Anthropic, SDK oficial) para explicar, resumir, mejorar y autocompletar, y Voyage AI
// para los embeddings (embeddings-voyage.ts). Implementa la MISMA interfaz que el simulado (ADR 0002).
//
//   - Contra la inyección: prompt.sistema va como mensaje de SISTEMA y prompt.usuario como único mensaje de
//     USUARIO (nunca concatenados). El armado (prompt.ts) es el mismo que prueba la batería de inyección.
//   - La AbortSignal del servicio se pasa al SDK: cancelar corta la conexión y el modelo deja de generar.
//   - Resumir y mejorar van en streaming (cada text_delta es un fragmento); explicar y autocompletar no.
//   - stop_reason se revisa ANTES de leer el contenido: "refusal" (los clasificadores de seguridad declinaron)
//     es un error "invalido", nunca una respuesta vacía; "max_tokens" entrega lo generado (el servicio igual
//     recorta la salida a sus topes); cualquier otro motivo inesperado es "interno".
//   - Errores: 429 → "limite" con su Retry-After; 5xx (incluido 529, saturado), red o tiempo →
//     "no_disponible"; abortar → "cancelado"; 413 → "invalido"; otros 4xx → "interno" (clave, modelo o
//     parámetros mal configurados: queda en el log del servicio, no es culpa de la persona).
//   - Fallbacks del lado del servidor ("default", beta server-side-fallback-2026-07-01): si un modelo declina,
//     la API reintenta en el que Anthropic recomienda. Haiku no tiene fallback: con él no se manda.
//   - Sin thinking explícito (los modelos actuales usan el adaptativo por defecto) ni parámetros de muestreo
//     (temperature y compañía dan 400 con la versión de API del SDK).
import Anthropic from '@anthropic-ai/sdk';
import { DIMENSIONES } from './contrato.js';
import { crearEmbeddingsVoyage, segundosDeEspera } from './embeddings-voyage.js';
import { construirPrompt, type Prompt } from './prompt.js';
import { ErrorProveedor, type Estilo, type ProveedorIa, type TipoEmbedding, type Uso } from './proveedor.js';

type BetaMessage = Anthropic.Beta.Messages.BetaMessage;
type ParametrosMensaje = Anthropic.Beta.Messages.MessageCreateParamsNonStreaming;

export const BETA_FALLBACK = 'server-side-fallback-2026-07-01';

/** Tope de tokens por tarea (incluye el razonamiento adaptativo; el servicio recorta la SALIDA por caracteres). */
export const MAX_TOKENS = { explicar: 4_096, transformar: 32_000, autocompletar: 1_024 } as const;

/** Esfuerzo por tarea: el autocompletado tiene 2 s en el API, así que piensa lo mínimo. */
export const ESFUERZO = { explicar: 'medium', transformar: 'medium', autocompletar: 'low' } as const;

export interface OpcionesAnthropic {
  clave: string;
  modelo: string;
  /** Modelo del autocompletado; por defecto el mismo. */
  modeloAutocompletar?: string | undefined;
  voyage: { clave: string; modelo: string };
  /** Solo pruebas: un fetch falso (lo usan el SDK y Voyage), así nada sale a la red. */
  fetch?: typeof fetch;
  /** Reintentos propios del SDK en explicar y transformar (por defecto 1; el autocompletado nunca reintenta). */
  reintentos?: number;
}

/** Haiku no tiene fallback del lado del servidor: mandarle `fallbacks` no sirve (o da 400 con una lista). */
export const usaFallback = (modelo: string): boolean => !modelo.startsWith('claude-haiku');

/** Traduce cualquier error del SDK a la categoría del servicio. */
export function traducirError(err: unknown, senal: AbortSignal): ErrorProveedor {
  if (err instanceof ErrorProveedor) return err;
  if (senal.aborted || err instanceof Anthropic.APIUserAbortError) return new ErrorProveedor('cancelado', 'cancelado');
  if (err instanceof Anthropic.RateLimitError) return new ErrorProveedor('limite', 'anthropic: límite de uso', segundosDeEspera(err.headers.get('retry-after')));
  if (err instanceof Anthropic.APIConnectionError) return new ErrorProveedor('no_disponible', 'anthropic: sin respuesta (red o tiempo)');
  if (err instanceof Anthropic.APIError) {
    const estado: number = typeof err.status === 'number' ? err.status : 0;
    if (estado >= 500) return new ErrorProveedor('no_disponible', `anthropic: error ${String(estado)}`);
    if (estado === 413) return new ErrorProveedor('invalido', 'anthropic: solicitud demasiado grande');
    return new ErrorProveedor('interno', `anthropic: respondió ${String(estado)}`);
  }
  return new ErrorProveedor('interno', 'anthropic: error inesperado');
}

/** Revisa stop_reason ANTES de leer el contenido. */
export function verificarFin(stop: BetaMessage['stop_reason']): void {
  if (stop === 'refusal') throw new ErrorProveedor('invalido', 'anthropic: el modelo declinó la solicitud');
  if (stop !== 'end_turn' && stop !== 'stop_sequence' && stop !== 'max_tokens') {
    throw new ErrorProveedor('interno', `anthropic: terminó con stop_reason ${String(stop)}`);
  }
}

const textoDe = (m: BetaMessage): string =>
  m.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('');

const usoDe = (u: BetaMessage['usage']): Uso => ({
  entrada: u.input_tokens + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
  salida: u.output_tokens,
});

export class ProveedorAnthropic implements ProveedorIa {
  readonly nombre = 'anthropic';
  readonly modeloEmbeddings: string;
  readonly dimensiones = DIMENSIONES;
  private readonly cliente: Anthropic;
  private readonly embeddings: ReturnType<typeof crearEmbeddingsVoyage>;

  /** Las claves se validan al arrancar (config.ts) y quedan solo en memoria; nunca se registran. */
  constructor(private readonly o: OpcionesAnthropic) {
    // Un reintento propio del SDK (408/409/429/5xx y red); el autocompletado, ninguno (tiene 2 s).
    this.cliente = new Anthropic({ apiKey: o.clave, maxRetries: o.reintentos ?? 1, ...(o.fetch ? { fetch: o.fetch } : {}) });
    this.embeddings = crearEmbeddingsVoyage({ ...o.voyage, ...(o.fetch ? { fetch: o.fetch } : {}) });
    this.modeloEmbeddings = o.voyage.modelo;
  }

  /** Parámetros de una llamada: sistema y usuario SEPARADOS. */
  private parametros(prompt: Prompt, modelo: string, maxTokens: number, esfuerzo: 'low' | 'medium'): ParametrosMensaje {
    return {
      model: modelo,
      max_tokens: maxTokens,
      system: prompt.sistema,
      messages: [{ role: 'user', content: prompt.usuario }],
      output_config: { effort: esfuerzo },
      ...(usaFallback(modelo) ? { betas: [BETA_FALLBACK], fallbacks: 'default' as const } : {}),
    };
  }

  private async unaria(prompt: Prompt, modelo: string, tarea: 'explicar' | 'autocompletar', senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    try {
      const m = await this.cliente.beta.messages.create(this.parametros(prompt, modelo, MAX_TOKENS[tarea], ESFUERZO[tarea]), {
        signal: senal,
        ...(tarea === 'autocompletar' ? { maxRetries: 0 } : {}),
      });
      verificarFin(m.stop_reason);
      return { texto: textoDe(m), uso: usoDe(m.usage) };
    } catch (err) {
      throw traducirError(err, senal);
    }
  }

  explicar(e: { contenido: string; lenguaje: string }, senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    return this.unaria(construirPrompt('explicar', e), this.o.modelo, 'explicar', senal);
  }

  async *transformar(e: { tarea: 'resumir' | 'mejorar'; contenido: string; estilo: Estilo }, senal: AbortSignal): AsyncGenerator<string, Uso> {
    const prompt = construirPrompt(e.tarea, e);
    const corriente = this.cliente.beta.messages.stream(this.parametros(prompt, this.o.modelo, MAX_TOKENS.transformar, ESFUERZO.transformar), { signal: senal });
    let terminada = false;
    try {
      for await (const ev of corriente) {
        if (ev.type === 'content_block_delta' && ev.delta.type === 'text_delta' && ev.delta.text) yield ev.delta.text;
      }
      const m = await corriente.finalMessage();
      terminada = true;
      verificarFin(m.stop_reason);
      return usoDe(m.usage);
    } catch (err) {
      terminada = true;
      throw traducirError(err, senal);
    } finally {
      // Quien consume dejó de pedir fragmentos (return o error): se corta la corriente y deja de cobrar.
      if (!terminada) corriente.abort();
    }
  }

  async embeber(textos: string[], senal: AbortSignal, tipo: TipoEmbedding = 'documento'): Promise<{ vectores: number[][]; uso: Uso }> {
    return this.embeddings.embeber(textos, senal, tipo);
  }

  autocompletar(e: { antes: string; despues: string }, senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    return this.unaria(construirPrompt('autocompletar', e), this.o.modeloAutocompletar ?? this.o.modelo, 'autocompletar', senal);
  }
}
