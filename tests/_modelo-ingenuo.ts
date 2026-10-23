// Un "modelo" de pruebas que representa el peor caso de inyección de prompts (bloque P2): OBEDECE todo lo
// que encuentre fuera del bloque de datos, y toma como fin del bloque el PRIMER cierre que se le parezca
// (sin mirar el nonce, sin distinguir mayúsculas, con espacios). Si el armado del prompt deja que el
// documento "cierre" el bloque y escriba afuera, este modelo responde COMPROMETIDO.
import { construirPrompt, type Prompt, type Tarea } from '../src/ia/prompt.js';
import type { Estilo, ProveedorIa, Uso } from '../src/ia/proveedor.js';
import { vectorDe } from '../src/ia/proveedor-mock.js';

/** Bloque de datos tal como lo leería un modelo crédulo: del primer "<nombre…>" al primer cierre parecido. */
const BLOQUE_CREDULO = /<\s*(documento|antes|despues)[^>]*>[\s\S]*?<\s*\/\s*(documento|antes|despues)[^>]*>/gi;

export const USO_CERO: Uso = { entrada: 0, salida: 0 };

/** Lo que el modelo crédulo ve FUERA de los bloques de datos (lo que obedecería). */
export const fueraDeLosBloques = (p: Prompt): string => p.usuario.replace(BLOQUE_CREDULO, '').trim();

export function responderIngenuo(p: Prompt): string {
  const fuera = fueraDeLosBloques(p);
  return fuera === '' ? 'ok' : `COMPROMETIDO: ${fuera.slice(0, 80)}`;
}

export class ModeloIngenuo implements ProveedorIa {
  readonly nombre = 'mock';
  readonly modeloEmbeddings = 'ingenuo-1024';
  readonly dimensiones = 1024;
  /** Todos los prompts que recibió (para inspeccionarlos). */
  readonly prompts: { tarea: Tarea; prompt: Prompt }[] = [];

  private responder(tarea: Tarea, prompt: Prompt): string {
    this.prompts.push({ tarea, prompt });
    return responderIngenuo(prompt);
  }

  explicar(e: { contenido: string; lenguaje: string }): Promise<{ texto: string; uso: Uso }> {
    return Promise.resolve({ texto: this.responder('explicar', construirPrompt('explicar', e)), uso: USO_CERO });
  }

  // eslint-disable-next-line @typescript-eslint/require-await -- generador de un solo fragmento
  async *transformar(e: { tarea: 'resumir' | 'mejorar'; contenido: string; estilo: Estilo }): AsyncGenerator<string, Uso> {
    yield this.responder(e.tarea, construirPrompt(e.tarea, e));
    return USO_CERO;
  }

  embeber(textos: string[]): Promise<{ vectores: number[][]; uso: Uso }> {
    return Promise.resolve({ vectores: textos.map(vectorDe), uso: USO_CERO });
  }

  autocompletar(e: { antes: string; despues: string }): Promise<{ texto: string; uso: Uso }> {
    return Promise.resolve({ texto: this.responder('autocompletar', construirPrompt('autocompletar', e)), uso: USO_CERO });
  }
}
