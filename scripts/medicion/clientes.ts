// Clientes de la medición de P3, con la misma interfaz para los tres caminos:
//   A  gRPC        ClienteIa (el del API), HTTP/2 + protobuf. `canales` > 1: conexiones separadas.
//   B  REST 1.1    node:http con keep-alive y un pool de `conexiones`, JSON.
//   C  REST h2c    node:http2, una sesión multiplexada, JSON.
// Cada llamada lleva el token y un tiempo máximo (como el deadline de gRPC), para que el trabajo por
// pedido sea comparable.
import { Agent, request as pedirH1 } from 'node:http';
import { connect as conectarH2, constants, type ClientHttp2Session } from 'node:http2';
import { ClienteIa, DEADLINES_MS, type OrigenIa } from '../../src/ia/cliente.js';

export interface ResultadoStream {
  /** ms hasta el primer fragmento con texto. */
  primeroMs: number;
  fragmentos: number;
  texto: string;
}

export interface ClienteMedicion {
  embeber: (consulta: string) => Promise<number[]>;
  explicar: (contenido: string) => Promise<string>;
  resumir: (contenido: string) => Promise<ResultadoStream>;
  cerrar: () => Promise<void>;
}

const ahora = () => Number(process.hrtime.bigint()) / 1e6;

/** A · gRPC. Con `canales` > 1, cada canal tiene su propia conexión (pool de subcanales local) y se reparten en ronda. */
export function clienteGrpc(url: string, token: string, origen: OrigenIa, canales = 1): ClienteMedicion {
  const lista = Array.from({ length: canales }, () => new ClienteIa({ url, token, ...(canales > 1 ? { opcionesCanal: { 'grpc.use_local_subchannel_pool': 1 } } : {}) }));
  let i = 0;
  const siguiente = (): ClienteIa => lista[i++ % lista.length] as ClienteIa;
  return {
    embeber: async (consulta) => (await siguiente().embeberConsulta({ ...origen, documentoId: '' }, consulta)).vector,
    explicar: async (contenido) => (await siguiente().explicar(origen, contenido, '')).texto,
    resumir: async (contenido) => {
      const inicio = ahora();
      let primeroMs = -1;
      let texto = '';
      let fragmentos = 0;
      const g = siguiente().transformar('resumir', origen, contenido, 'claro');
      for (let r = await g.next(); !r.done; r = await g.next()) {
        if (primeroMs < 0) primeroMs = ahora() - inicio;
        texto += r.value;
        fragmentos++;
      }
      return { primeroMs, fragmentos, texto };
    },
    cerrar: () => {
      for (const c of lista) c.cerrar();
      return Promise.resolve();
    },
  };
}

/** Lee una respuesta NDJSON de a poco (h1 o h2): primer fragmento, todos los textos y la línea final. */
function leerNdjson(fuente: NodeJS.ReadableStream, inicio: number): Promise<ResultadoStream> {
  return new Promise((resolver, rechazar) => {
    let resto = '';
    let primeroMs = -1;
    let texto = '';
    let fragmentos = 0;
    let fin = false;
    fuente.setEncoding('utf8');
    fuente.on('data', (trozo: string) => {
      resto += trozo;
      let salto = resto.indexOf('\n');
      while (salto >= 0) {
        const m = JSON.parse(resto.slice(0, salto)) as { texto: string; fin: boolean };
        resto = resto.slice(salto + 1);
        if (m.fin) fin = true;
        else {
          if (primeroMs < 0) primeroMs = ahora() - inicio;
          texto += m.texto;
          fragmentos++;
        }
        salto = resto.indexOf('\n');
      }
    });
    fuente.on('end', () => {
      if (fin) resolver({ primeroMs, fragmentos, texto });
      else rechazar(new Error('la corriente terminó sin la línea final'));
    });
    fuente.on('error', rechazar);
  });
}

/** B · REST sobre HTTP/1.1 con keep-alive: un pedido por conexión a la vez, `conexiones` en el pool. */
export function clienteH1(puerto: number, token: string, origen: OrigenIa, conexiones: number): ClienteMedicion {
  const agente = new Agent({ keepAlive: true, maxSockets: conexiones });
  const enviar = (ruta: string, cuerpo: unknown, plazoMs: number) =>
    new Promise<import('node:http').IncomingMessage>((resolver, rechazar) => {
      const datos = JSON.stringify(cuerpo);
      const req = pedirH1(
        {
          host: '127.0.0.1',
          port: puerto,
          path: ruta,
          method: 'POST',
          agent: agente,
          timeout: plazoMs,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(datos) },
        },
        resolver,
      );
      req.on('timeout', () => req.destroy(new Error('tiempo agotado')));
      req.on('error', rechazar);
      req.end(datos);
    });
  const cuerpoJson = async (ruta: string, cuerpo: unknown, plazoMs: number) => {
    const res = await enviar(ruta, cuerpo, plazoMs);
    const partes: Buffer[] = [];
    for await (const p of res) partes.push(p as Buffer);
    if (res.statusCode !== 200) throw new Error(`HTTP ${String(res.statusCode)}`);
    return JSON.parse(Buffer.concat(partes).toString('utf8')) as Record<string, unknown>;
  };
  return {
    embeber: async (consulta) => (await cuerpoJson('/embeber', { origen: origenJson(origen, false), consulta }, DEADLINES_MS.embeber)).valores as number[],
    explicar: async (contenido) => (await cuerpoJson('/explicar', { origen: origenJson(origen, true), contenido, lenguaje: '' }, DEADLINES_MS.explicar)).texto as string,
    resumir: async (contenido) => {
      const inicio = ahora();
      const res = await enviar('/resumir', { origen: origenJson(origen, true), contenido }, DEADLINES_MS.transformar);
      if (res.statusCode !== 200) throw new Error(`HTTP ${String(res.statusCode)}`);
      return leerNdjson(res, inicio);
    },
    cerrar: () => {
      agente.destroy();
      return Promise.resolve();
    },
  };
}

/** C · REST sobre HTTP/2 sin TLS (h2c): una sola sesión, todos los pedidos multiplexados en ella. */
export function clienteH2(puerto: number, token: string, origen: OrigenIa): ClienteMedicion {
  const sesion: ClientHttp2Session = conectarH2(`http://127.0.0.1:${String(puerto)}`);
  const enviar = (ruta: string, cuerpo: unknown, plazoMs: number) => {
    const datos = JSON.stringify(cuerpo);
    const s = sesion.request({
      [constants.HTTP2_HEADER_METHOD]: 'POST',
      [constants.HTTP2_HEADER_PATH]: ruta,
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(datos),
    });
    s.setTimeout(plazoMs, () => {
      s.close(constants.NGHTTP2_CANCEL);
    });
    s.end(datos);
    const estado = new Promise<number>((resolver, rechazar) => {
      s.once('response', (h) => {
        resolver(Number(h[constants.HTTP2_HEADER_STATUS]));
      });
      s.once('error', rechazar);
    });
    return { s, estado };
  };
  const cuerpoJson = async (ruta: string, cuerpo: unknown, plazoMs: number) => {
    const { s, estado } = enviar(ruta, cuerpo, plazoMs);
    const partes: Buffer[] = [];
    for await (const p of s) partes.push(p as Buffer);
    if ((await estado) !== 200) throw new Error(`HTTP ${String(await estado)}`);
    return JSON.parse(Buffer.concat(partes).toString('utf8')) as Record<string, unknown>;
  };
  return {
    embeber: async (consulta) => (await cuerpoJson('/embeber', { origen: origenJson(origen, false), consulta }, DEADLINES_MS.embeber)).valores as number[],
    explicar: async (contenido) => (await cuerpoJson('/explicar', { origen: origenJson(origen, true), contenido, lenguaje: '' }, DEADLINES_MS.explicar)).texto as string,
    resumir: async (contenido) => {
      const inicio = ahora();
      const { s, estado } = enviar('/resumir', { origen: origenJson(origen, true), contenido }, DEADLINES_MS.transformar);
      const lectura = leerNdjson(s, inicio);
      if ((await estado) !== 200) throw new Error(`HTTP ${String(await estado)}`);
      return lectura;
    },
    cerrar: () =>
      new Promise((r) => {
        sesion.close(() => {
          r();
        });
      }),
  };
}

/** El origen como lo manda el contrato (snake_case), en JSON. */
function origenJson(o: OrigenIa, conDocumento: boolean) {
  return { cuenta_id: o.cuentaId, espacio_id: o.espacioId, documento_id: conDocumento ? (o.documentoId ?? '') : '', solicitud_id: o.solicitudId };
}
