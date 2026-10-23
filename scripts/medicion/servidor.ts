// Servidor de la medición de P3 (ADR 0002): en UN proceso, la misma operación por dos caminos.
//
//   - gRPC: el servicio REAL (crearServicioIa), con su interceptor de token, validación y log.
//   - REST/JSON: un adaptador sobre node:http (HTTP/1.1) y node:http2 (h2c, sin TLS), SIN Express, que
//     llama a las MISMAS funciones: validarOrigen, texto, el mismo proveedor y verificarVectores.
//     Vive aquí (scripts/medicion) y no en el servicio de producción: no agrega superficie de ataque.
//
// Mismo trabajo en los dos: token Bearer comparado en tiempo constante, validación del origen y del
// contenido, proveedor simulado sin esperas y log en "silent". Los vectores viajan como float de 32 bits
// en los dos (protobuf `float`; en JSON, Math.fround): la misma información.
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer as crearH1, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as crearH2, type Http2ServerRequest, type Http2ServerResponse } from 'node:http2';
import { createServer as crearTcp, connect as conectarTcp, type AddressInfo, type Server } from 'node:net';
import { pino } from 'pino';
import { DIMENSIONES } from '../../src/ia/contrato.js';
import { ErrorProveedor, type ProveedorIa } from '../../src/ia/proveedor.js';
import { ProveedorMock } from '../../src/ia/proveedor-mock.js';
import { crearServicioIa, LIMITES_SERVICIO, texto, validarOrigen, verificarVectores } from '../../src/ia/servicio.js';

/** Tope de Explicar SOLO en la medición: deja pasar los pedidos de 64 KB (producción: 20 000 caracteres). */
export const LIMITE_EXPLICAR_MEDICION = 70_000;

export type Camino = 'grpc' | 'h1' | 'h2';

export interface ServidorMedicion {
  token: string;
  puertos: Record<Camino, number>;
  /** Proxies TCP que cuentan los bytes en el cable (solo se usan en la fase de tamaños). */
  proxies: Record<Camino, number>;
  bytes: () => Record<Camino, { pedido: number; respuesta: number }>;
  reiniciarBytes: () => void;
  cerrar: () => Promise<void>;
}

const comparar = (recibido: string, esperado: string) => {
  const a = createHash('sha256').update(recibido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return recibido !== '' && timingSafeEqual(a, b);
};

const usoJson = (u: { entrada: number; salida: number }) => ({ tokens_entrada: u.entrada, tokens_salida: u.salida });

type Pedido = IncomingMessage | Http2ServerRequest;
/** Lo que usa el adaptador de la respuesta: lo comparten la de HTTP/1.1 y la de compatibilidad de HTTP/2. */
interface Respuesta {
  headersSent: boolean;
  writeHead: (estado: number, cabeceras: Record<string, string | number>) => unknown;
  write: (trozo: string) => unknown;
  end: (trozo?: string) => unknown;
  on: (evento: 'close', f: () => void) => unknown;
}

function leer(req: Pedido): Promise<string> {
  return new Promise((resolver, rechazar) => {
    const partes: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > 4 * 1024 * 1024) rechazar(new ErrorProveedor('invalido', 'cuerpo demasiado grande'));
      else partes.push(c);
    });
    req.on('end', () => {
      resolver(Buffer.concat(partes).toString('utf8'));
    });
    req.on('error', rechazar);
  });
}

function json(res: Respuesta, estado: number, cuerpo: unknown): void {
  const t = JSON.stringify(cuerpo);
  res.writeHead(estado, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(t) });
  res.end(t);
}

/** El adaptador REST: lo mismo que hacen los handlers gRPC, con JSON. Sirve igual a HTTP/1.1 y a h2c. */
function adaptadorRest(p: ProveedorIa, token: string) {
  return async (req: Pedido, res: Respuesta): Promise<void> => {
    const auth = req.headers.authorization;
    if (typeof auth !== 'string' || !auth.startsWith('Bearer ') || !comparar(auth.slice(7), token)) {
      json(res, 401, { error: 'token de servicio inválido' });
      return;
    }
    const ac = new AbortController();
    res.on('close', () => {
      ac.abort();
    });
    try {
      const d = JSON.parse(await leer(req)) as { origen: Parameters<typeof validarOrigen>[0]; consulta?: string; contenido?: string; lenguaje?: string };
      if (req.url === '/embeber') {
        validarOrigen(d.origen, false);
        const r = await p.embeber([texto(d.consulta ?? '', LIMITES_SERVICIO.consulta, 'consulta')], ac.signal);
        const [v] = verificarVectores(r.vectores, 1);
        json(res, 200, { valores: (v ?? []).map((x) => Math.fround(x)), uso: usoJson(r.uso) });
      } else if (req.url === '/explicar') {
        validarOrigen(d.origen, true);
        const r = await p.explicar({ contenido: texto(d.contenido ?? '', LIMITE_EXPLICAR_MEDICION, 'contenido'), lenguaje: d.lenguaje ?? '' }, ac.signal);
        json(res, 200, { texto: r.texto.slice(0, LIMITES_SERVICIO.salidaExplicar), uso: usoJson(r.uso) });
      } else if (req.url === '/resumir') {
        validarOrigen(d.origen, true);
        const g = p.transformar({ tarea: 'resumir', contenido: texto(d.contenido ?? '', LIMITES_SERVICIO.transformar, 'contenido'), estilo: 'claro' }, ac.signal);
        // NDJSON: una línea por fragmento y una final con el uso, como los mensajes del stream gRPC.
        res.writeHead(200, { 'content-type': 'application/x-ndjson' });
        for (;;) {
          const r = await g.next();
          if (r.done) {
            res.end(`${JSON.stringify({ texto: '', fin: true, uso: usoJson(r.value) })}\n`);
            break;
          }
          res.write(`${JSON.stringify({ texto: r.value, fin: false, uso: null })}\n`);
        }
      } else {
        json(res, 404, { error: 'ruta desconocida' });
      }
    } catch (err) {
      if (!res.headersSent) json(res, err instanceof ErrorProveedor && err.categoria === 'invalido' ? 400 : 500, { error: err instanceof Error ? err.message : 'error' });
      else res.end();
    }
  };
}

const escuchar = (s: Server | ReturnType<typeof crearH1> | ReturnType<typeof crearH2>): Promise<number> =>
  new Promise((r) => {
    s.listen(0, '127.0.0.1', () => {
      r((s.address() as AddressInfo).port);
    });
  });

/** Proxy TCP transparente que cuenta los bytes de cada sentido (incluye cabeceras y marcos de HTTP/2). */
function proxyContador(destino: number) {
  const c = { pedido: 0, respuesta: 0 };
  const servidor = crearTcp((entrada) => {
    const salida = conectarTcp(destino, '127.0.0.1');
    entrada.on('data', (d: Buffer) => (c.pedido += d.length));
    salida.on('data', (d: Buffer) => (c.respuesta += d.length));
    entrada.pipe(salida);
    salida.pipe(entrada);
    entrada.on('error', () => salida.destroy());
    salida.on('error', () => entrada.destroy());
  });
  return { servidor, c };
}

/**
 * Vector DENSO determinista de 1024 dimensiones, unitario: todas las dimensiones distintas de cero, como
 * los de un modelo real. (Los del simulado son dispersos: en JSON cada cero viaja como "0", lo que
 * favorecería a JSON de un modo que con un modelo real no ocurre.)
 */
export function vectorDenso(texto: string): number[] {
  const v: number[] = [];
  for (let bloque = 0; v.length < DIMENSIONES; bloque++) {
    const h = createHash('sha256').update(`${texto}:${String(bloque)}`).digest();
    for (let i = 0; i + 4 <= h.length && v.length < DIMENSIONES; i += 4) v.push(h.readUInt32BE(i) / 0xffffffff - 0.5 || 1e-6);
  }
  const norma = Math.hypot(...v);
  return v.map((x) => x / norma);
}

/** El simulado, con vectores densos (lo demás igual). */
export function proveedorMedicion(): ProveedorIa {
  const m = new ProveedorMock();
  return {
    nombre: 'mock',
    modeloEmbeddings: 'medicion-densa-1024',
    dimensiones: DIMENSIONES,
    explicar: (e, s) => m.explicar(e, s),
    transformar: (e, s) => m.transformar(e, s),
    autocompletar: (e, s) => m.autocompletar(e, s),
    embeber: (textos) => Promise.resolve({ vectores: textos.map(vectorDenso), uso: { entrada: textos.length, salida: 0 } }),
  };
}

export async function levantarServidorMedicion(o: { proveedor?: ProveedorIa } = {}): Promise<ServidorMedicion> {
  const token = randomBytes(32).toString('base64url');
  const proveedor = o.proveedor ?? proveedorMedicion();
  const log = pino({ level: 'silent' });
  const servicio = crearServicioIa({ proveedor, token, log, limiteExplicar: LIMITE_EXPLICAR_MEDICION });
  const grpc = await servicio.escuchar('127.0.0.1', 0);
  const manejar = adaptadorRest(proveedor, token);
  const h1 = crearH1({ keepAliveTimeout: 60_000 }, (req: IncomingMessage, res: ServerResponse) => void manejar(req, res as unknown as Respuesta));
  const h2 = crearH2({}, (req: Http2ServerRequest, res: Http2ServerResponse) => void manejar(req, res as unknown as Respuesta));
  const puertos = { grpc, h1: await escuchar(h1), h2: await escuchar(h2) };
  const px = { grpc: proxyContador(puertos.grpc), h1: proxyContador(puertos.h1), h2: proxyContador(puertos.h2) };
  const proxies = { grpc: await escuchar(px.grpc.servidor), h1: await escuchar(px.h1.servidor), h2: await escuchar(px.h2.servidor) };
  return {
    token,
    puertos,
    proxies,
    bytes: () => ({ grpc: { ...px.grpc.c }, h1: { ...px.h1.c }, h2: { ...px.h2.c } }),
    reiniciarBytes: () => {
      for (const p of Object.values(px)) Object.assign(p.c, { pedido: 0, respuesta: 0 });
    },
    cerrar: async () => {
      for (const s of [h1, h2, px.grpc.servidor, px.h1.servidor, px.h2.servidor]) {
        (s as { closeAllConnections?: () => void }).closeAllConnections?.();
        await new Promise<void>((r) => {
          s.close(() => {
            r();
          });
          setTimeout(r, 500).unref();
        });
      }
      await servicio.cerrar(500);
    },
  };
}

/** Origen fijo de la medición (ids ficticios). */
export const ORIGEN_MEDICION = { cuentaId: randomUUID(), espacioId: randomUUID(), documentoId: randomUUID(), solicitudId: 'medicion-p3' };
