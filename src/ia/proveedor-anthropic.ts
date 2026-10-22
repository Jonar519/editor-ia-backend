// Proveedor real (esqueleto). Implementa la interfaz ProveedorIa para que el servicio, el contrato y el API
// ya estén listos; las llamadas al modelo se escriben cuando se decida el proveedor real (después de P1).
// Hasta entonces cada operación falla con "no_implementado" (UNIMPLEMENTED → 502 ia_error_interno), nunca
// con una respuesta inventada.
//
// Pendiente al implementarlo (ADR 0002, "Servicio de IA"):
//   - armar el prompt con el contenido entre delimitadores, separado de la tarea (P2, inyección de prompts);
//   - pasar la AbortSignal al cliente HTTP del proveedor (cancelar = dejar de generar y de cobrar);
//   - traducir sus errores: 429 → "limite" (con su Retry-After), 5xx o red → "no_disponible";
//   - los embeddings vienen de un modelo que produzca EXACTAMENTE 1024 dimensiones, o hace falta una
//     migración de la columna vector(1024).
import { ErrorProveedor, type Estilo, type ProveedorIa, type Uso } from './proveedor.js';

const pendiente = () => new ErrorProveedor('no_implementado', 'el proveedor anthropic todavía no está implementado');

export class ProveedorAnthropic implements ProveedorIa {
  readonly nombre = 'anthropic';
  readonly modeloEmbeddings = 'pendiente';

  /** La clave se valida al arrancar (config.ts) y queda solo en memoria; nunca se registra. */
  constructor(private readonly clave: string) {}

  /** Cuántos caracteres tiene la clave (para un log de arranque sin revelarla). */
  get largoClave(): number {
    return this.clave.length;
  }

  explicar(_e: { contenido: string; lenguaje: string }, _senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    return Promise.reject(pendiente());
  }

  // eslint-disable-next-line require-yield -- esqueleto: falla antes de generar el primer fragmento
  async *transformar(_e: { tarea: 'resumir' | 'mejorar'; contenido: string; estilo: Estilo }, _senal: AbortSignal): AsyncGenerator<string, Uso> {
    await Promise.resolve();
    throw pendiente();
  }

  embeber(_textos: string[], _senal: AbortSignal): Promise<{ vectores: number[][]; uso: Uso }> {
    return Promise.reject(pendiente());
  }

  autocompletar(_e: { antes: string; despues: string }, _senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    return Promise.reject(pendiente());
  }
}
