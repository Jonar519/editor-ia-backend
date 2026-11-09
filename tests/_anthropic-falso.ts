// Un fetch FALSO para el proveedor real (bloque P de despliegue): imita a la API de Anthropic (JSON y SSE) y
// a la de Voyage, y registra cada pedido. Nada sale a la red y ninguna clave real entra a las pruebas.
import { randomBytes } from 'node:crypto';

export interface Pedido {
  url: string;
  headers: Record<string, string>;
  cuerpo: Record<string, unknown>;
  senal: AbortSignal | undefined;
}

/** Respuesta que el falso devuelve a un pedido (o una excepción, para simular la red caída). */
export type Responder = (p: Pedido, n: number) => Response | Promise<Response>;

/** Clave ficticia distinta en cada corrida (nunca un literal que parezca una clave). */
export const claveFicticia = (): string => `falsa-${randomBytes(24).toString('base64url')}`;

export function fetchFalso(responder: Responder) {
  const pedidos: Pedido[] = [];
  const fn = async (entrada: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = entrada instanceof Request ? entrada.url : String(entrada);
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => {
      headers[k] = v;
    });
    const texto = typeof init?.body === 'string' ? init.body : '';
    const p: Pedido = { url, headers, cuerpo: texto ? (JSON.parse(texto) as Record<string, unknown>) : {}, senal: init?.signal ?? undefined };
    pedidos.push(p);
    return responder(p, pedidos.length);
  };
  return { fetch: fn, pedidos };
}

const json = (estado: number, cuerpo: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(cuerpo), { status: estado, headers: { 'content-type': 'application/json', 'request-id': 'req_falso', ...headers } });

/** Un mensaje completo de la API de Messages. */
export function mensaje(texto: string, o: { stop?: string; modelo?: string; entrada?: number; salida?: number } = {}) {
  return json(200, {
    id: 'msg_falso',
    type: 'message',
    role: 'assistant',
    model: o.modelo ?? 'claude-opus-5-5',
    content: texto ? [{ type: 'text', text: texto }] : [],
    stop_reason: o.stop ?? 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: o.entrada ?? 11, output_tokens: o.salida ?? 7, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 },
  });
}

/** Un error de la API (429, 500, 529…) con su cuerpo y cabeceras. */
export function errorApi(estado: number, headers: Record<string, string> = {}) {
  const tipo = estado === 429 ? 'rate_limit_error' : estado === 529 ? 'overloaded_error' : estado >= 500 ? 'api_error' : 'invalid_request_error';
  return json(estado, { type: 'error', error: { type: tipo, message: `error ${String(estado)} simulado` } }, headers);
}

const evento = (tipo: string, datos: unknown) => `event: ${tipo}\ndata: ${JSON.stringify({ type: tipo, ...(datos as object) })}\n\n`;

/**
 * Una corriente SSE de Messages con estos fragmentos. Con `colgar`, después del primer fragmento la corriente
 * queda abierta hasta que se aborta la señal del pedido (para probar la cancelación).
 */
export function corriente(fragmentos: string[], o: { stop?: string; senal?: AbortSignal | undefined; colgar?: boolean; alEnviar?: () => void } = {}) {
  const inicio = [
    evento('message_start', {
      message: { id: 'msg_falso', type: 'message', role: 'assistant', model: 'claude-opus-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 20, output_tokens: 1 } },
    }),
    evento('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
  ];
  const deltas = fragmentos.map((t) => evento('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } }));
  const fin = [
    evento('content_block_stop', { index: 0 }),
    evento('message_delta', { delta: { stop_reason: o.stop ?? 'end_turn', stop_sequence: null }, usage: { output_tokens: 9 } }),
    evento('message_stop', {}),
  ];
  const codificar = new TextEncoder();
  const cuerpo = new ReadableStream<Uint8Array>({
    start(c) {
      if (o.colgar) {
        for (const t of [...inicio, deltas[0] ?? '']) c.enqueue(codificar.encode(t));
        o.alEnviar?.();
        o.senal?.addEventListener('abort', () => {
          c.error(new DOMException('abortado', 'AbortError'));
        });
        return;
      }
      for (const t of [...inicio, ...deltas, ...fin]) c.enqueue(codificar.encode(t));
      c.close();
    },
  });
  return new Response(cuerpo, { status: 200, headers: { 'content-type': 'text/event-stream', 'request-id': 'req_falso' } });
}

/** Respuesta de Voyage con un vector de `dim` por texto (en el orden de `orden`, si se da). */
export function voyage(cantidad: number, o: { dim?: number; orden?: number[]; tokens?: number } = {}) {
  const indices = o.orden ?? Array.from({ length: cantidad }, (_, i) => i);
  return json(200, {
    object: 'list',
    data: indices.map((i) => ({ object: 'embedding', index: i, embedding: Array.from({ length: o.dim ?? 1024 }, (_, k) => (k === i % (o.dim ?? 1024) ? 1 : 0)) })),
    model: 'voyage-3.5',
    usage: { total_tokens: o.tokens ?? 5 * cantidad },
  });
}

export const respuestas = { json, mensaje, errorApi, corriente, voyage };
