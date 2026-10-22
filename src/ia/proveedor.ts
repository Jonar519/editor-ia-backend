// Interfaz del proveedor de IA que usa el servicio gRPC (bloque P1). Hoy: el simulado (proveedor-mock.ts),
// determinista y sin red. El real (proveedor-anthropic.ts) implementa ESTA misma interfaz: cambiar de
// proveedor es cambiar AI_PROVIDER, sin tocar el servicio, el contrato ni el API.
//
// Reglas para cualquier proveedor:
//   - Cada operación recibe una AbortSignal: cuando el API cancela (la persona se fue o venció el
//     deadline), el proveedor deja de generar (y de cobrar) en el acto.
//   - El contenido es DATOS, nunca instrucciones: va separado de la tarea (P2 arma el prompt con
//     delimitadores).
//   - embeber() devuelve vectores de exactamente DIMENSIONES (1024); el servicio rechaza otro tamaño.
//   - El uso (tokens de entrada y salida) se informa siempre: el API lo cobra contra el tope diario.

/** Tokens consumidos por una operación. */
export interface Uso {
  entrada: number;
  salida: number;
}

export type Estilo = 'claro' | 'breve' | 'formal';

export interface ProveedorIa {
  readonly nombre: 'mock' | 'anthropic';
  /** Modelo de embeddings: se guarda en embeddings.modelo para saber con qué se indexó cada fragmento. */
  readonly modeloEmbeddings: string;
  explicar(e: { contenido: string; lenguaje: string }, senal: AbortSignal): Promise<{ texto: string; uso: Uso }>;
  /** El texto llega de a poco (cada valor es un fragmento); al terminar, devuelve el uso. */
  transformar(e: { tarea: 'resumir' | 'mejorar'; contenido: string; estilo: Estilo }, senal: AbortSignal): AsyncGenerator<string, Uso>;
  embeber(textos: string[], senal: AbortSignal): Promise<{ vectores: number[][]; uso: Uso }>;
  autocompletar(e: { antes: string; despues: string }, senal: AbortSignal): Promise<{ texto: string; uso: Uso }>;
}

/**
 * Error de un proveedor, con una categoría que el servicio traduce a un estado gRPC (y el API, a HTTP):
 *   invalido → INVALID_ARGUMENT · limite → RESOURCE_EXHAUSTED · no_disponible → UNAVAILABLE ·
 *   cancelado → CANCELLED · no_implementado → UNIMPLEMENTED · interno → INTERNAL
 */
export class ErrorProveedor extends Error {
  constructor(
    readonly categoria: 'invalido' | 'limite' | 'no_disponible' | 'cancelado' | 'no_implementado' | 'interno',
    mensaje: string,
    /** Con "limite": cuántos segundos esperar (llega al navegador como Retry-After). */
    readonly reintentarEnS?: number,
  ) {
    super(mensaje);
    this.name = 'ErrorProveedor';
  }
}

/** Espera `ms`, o rechaza con "cancelado" apenas se aborta la señal. */
export function esperar(ms: number, senal: AbortSignal): Promise<void> {
  return new Promise((resolver, rechazar) => {
    if (senal.aborted) {
      rechazar(new ErrorProveedor('cancelado', 'cancelado'));
      return;
    }
    const alAbortar = () => {
      clearTimeout(t);
      rechazar(new ErrorProveedor('cancelado', 'cancelado'));
    };
    const t = setTimeout(() => {
      senal.removeEventListener('abort', alAbortar);
      resolver();
    }, ms);
    senal.addEventListener('abort', alAbortar, { once: true });
  });
}

/** Estimación de tokens del simulado (unos 4 caracteres por token). */
export const tokensAprox = (texto: string): number => Math.ceil(texto.length / 4);
