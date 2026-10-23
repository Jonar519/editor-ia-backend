// Proveedor real (esqueleto). Implementa la interfaz ProveedorIa para que el servicio, el contrato y el API
// ya estén listos; las llamadas al modelo se escriben cuando se decida el proveedor real.
// Hasta entonces cada operación arma su prompt (src/ia/prompt.ts, contra la inyección) y falla con
// "no_implementado" (UNIMPLEMENTED → 502 ia_error_interno), nunca con una respuesta inventada.
//
// Pendiente al implementarlo (ADR 0002, "Servicio de IA"):
//   - mandar prompt.sistema como mensaje de sistema y prompt.usuario como mensaje de usuario (nunca
//     concatenados en uno solo);
//   - pasar la AbortSignal al cliente HTTP del proveedor (cancelar = dejar de generar y de cobrar);
//   - traducir sus errores: 429 → "limite" (con su Retry-After), 5xx o red → "no_disponible";
//   - los embeddings vienen de un modelo que produzca EXACTAMENTE 1024 dimensiones, o hace falta una
//     migración de la columna vector(1024) (el API no busca ni indexa con otro número: Describir);
//   - evaluar la resistencia del modelo elegido a la batería de inyección (tests/unitarias/ia-prompt).
import { DIMENSIONES } from './contrato.js';
import { construirPrompt, type Prompt } from './prompt.js';
import { ErrorProveedor, type Estilo, type ProveedorIa, type Uso } from './proveedor.js';

const pendiente = () => new ErrorProveedor('no_implementado', 'el proveedor anthropic todavía no está implementado');

export class ProveedorAnthropic implements ProveedorIa {
  readonly nombre = 'anthropic';
  readonly modeloEmbeddings = 'pendiente';
  readonly dimensiones = DIMENSIONES;

  /** La clave se valida al arrancar (config.ts) y queda solo en memoria; nunca se registra. */
  constructor(private readonly clave: string) {}

  /** Cuántos caracteres tiene la clave (para un log de arranque sin revelarla). */
  get largoClave(): number {
    return this.clave.length;
  }

  /** Aquí irá la llamada al modelo con el prompt ya armado. */
  private llamar(_prompt: Prompt, _senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    return Promise.reject(pendiente());
  }

  explicar(e: { contenido: string; lenguaje: string }, senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    return this.llamar(construirPrompt('explicar', e), senal);
  }

  // eslint-disable-next-line require-yield -- esqueleto: falla antes de generar el primer fragmento
  async *transformar(e: { tarea: 'resumir' | 'mejorar'; contenido: string; estilo: Estilo }, senal: AbortSignal): AsyncGenerator<string, Uso> {
    await this.llamar(construirPrompt(e.tarea, e), senal);
    throw pendiente();
  }

  embeber(_textos: string[], _senal: AbortSignal): Promise<{ vectores: number[][]; uso: Uso }> {
    return Promise.reject(pendiente());
  }

  autocompletar(e: { antes: string; despues: string }, senal: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    return this.llamar(construirPrompt('autocompletar', e), senal);
  }
}
