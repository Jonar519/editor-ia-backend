// Cliente gRPC del servicio de IA, del lado del API (gateway). Tipado con el contrato generado.
//
//   - Deadline SIEMPRE (ADR 0002): 15 s Explicar y EmbeberConsulta, 60 s Resumir y Mejorar, 120 s
//     IndexarDocumento, 2 s cada sugerencia de Autocompletar (la corriente vive lo que la conexión de
//     edición; el deadline es de cada pedido).
//   - Cancelación: cada método recibe una AbortSignal; abortarla cancela la llamada gRPC (CANCELLED), y
//     el servicio deja de generar. Dejar de leer una corriente (return/throw del consumidor) también.
//   - Token entre servicios en el metadato `authorization` de cada llamada.
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { paquete, SERVICIO, type AsistenteClient, type ContextoAutocompletado, type FragmentoGrpc, type HealthClient, type SugerenciaGrpc, type UsoGrpc } from './contrato.js';
import type { Estilo, Uso } from './proveedor.js';

export const DEADLINES_MS = { explicar: 15_000, embeber: 15_000, transformar: 60_000, indexar: 120_000, sugerencia: 2_000, salud: 2_000 } as const;

export type Deadlines = { [K in keyof typeof DEADLINES_MS]: number };

/** Ids de quién pide (nunca datos personales). documentoId falta solo en la búsqueda. */
export interface OrigenIa {
  cuentaId: string;
  espacioId: string;
  documentoId?: string;
  solicitudId: string;
}

export interface SesionAutocompletado {
  /** Pide una sugerencia. Un pedido nuevo deja sin respuesta (null) al anterior: el servicio lo cancela. */
  pedir(pedido: number, antes: string, despues: string): Promise<{ texto: string; uso: Uso } | null>;
  cerrar(): void;
}

export interface OpcionesClienteIa {
  /** host:puerto del servicio (127.0.0.1:4210). */
  url: string;
  token: string;
  /** TLS mutuo en producción; sin esto, texto plano (solo 127.0.0.1). */
  credenciales?: grpc.ChannelCredentials;
  deadlines?: Partial<Deadlines>;
}

/** TLS mutuo del lado del API: su certificado de cliente y la CA que firmó el del servicio (config validada). */
export function credencialesIa(c: { IA_TLS_CERT?: string | undefined; IA_TLS_KEY?: string | undefined; IA_TLS_CA?: string | undefined }): {
  credenciales?: grpc.ChannelCredentials;
} {
  if (!c.IA_TLS_CERT || !c.IA_TLS_KEY || !c.IA_TLS_CA) return {};
  return { credenciales: grpc.credentials.createSsl(readFileSync(c.IA_TLS_CA), readFileSync(c.IA_TLS_KEY), readFileSync(c.IA_TLS_CERT)) };
}

const usoDe = (u: UsoGrpc | null): Uso => ({ entrada: u?.tokens_entrada ?? 0, salida: u?.tokens_salida ?? 0 });

/** Un ServiceError armado aquí (deadline de una sugerencia, corriente cortada) con el mismo forma que los de grpc-js. */
export function errorGrpc(code: grpc.status, details: string): grpc.ServiceError {
  return Object.assign(new Error(details), { code, details, metadata: new grpc.Metadata() });
}

const origenGrpc = (o: OrigenIa) => ({ cuenta_id: o.cuentaId, espacio_id: o.espacioId, documento_id: o.documentoId ?? '', solicitud_id: o.solicitudId });

export class ClienteIa {
  private readonly asistente: AsistenteClient;
  private readonly salud: HealthClient;
  private readonly deadlines: Deadlines;

  constructor(private readonly o: OpcionesClienteIa) {
    const credenciales = o.credenciales ?? grpc.credentials.createInsecure();
    // 16 MiB: la respuesta de IndexarDocumento lleva hasta 1000 vectores de 1024 floats (≈4 MiB).
    const opciones = { 'grpc.max_receive_message_length': 16 * 1024 * 1024 };
    this.asistente = new paquete.cuaderno.ia.v1.Asistente(o.url, credenciales, opciones);
    this.salud = new paquete.grpc.health.v1.Health(o.url, credenciales);
    this.deadlines = { ...DEADLINES_MS, ...o.deadlines };
  }

  private metadatos(): grpc.Metadata {
    const m = new grpc.Metadata();
    m.set('authorization', `Bearer ${this.o.token}`);
    return m;
  }

  private opciones(ms: number): grpc.CallOptions {
    return { deadline: Date.now() + ms };
  }

  /** Una llamada unaria cancelable: abortar la señal cancela la llamada (CANCELLED). */
  private unaria<T>(senal: AbortSignal | undefined, llamar: (responder: (err: grpc.ServiceError | null, r?: T) => void) => grpc.ClientUnaryCall): Promise<T> {
    return new Promise((resolver, rechazar) => {
      const llamada = llamar((err, r) => {
        senal?.removeEventListener('abort', alAbortar);
        if (err) rechazar(err);
        else if (r === undefined) rechazar(errorGrpc(grpc.status.INTERNAL, 'respuesta vacía'));
        else resolver(r);
      });
      const alAbortar = () => {
        llamada.cancel();
      };
      if (senal?.aborted) llamada.cancel();
      else senal?.addEventListener('abort', alAbortar, { once: true });
    });
  }

  async explicar(origen: OrigenIa, contenido: string, lenguaje: string, senal?: AbortSignal): Promise<{ texto: string; uso: Uso }> {
    const r = await this.unaria<{ texto: string; uso: UsoGrpc | null }>(senal, (cb) =>
      this.asistente.Explicar({ origen: origenGrpc(origen), contenido, lenguaje }, this.metadatos(), this.opciones(this.deadlines.explicar), cb),
    );
    return { texto: r.texto, uso: usoDe(r.uso) };
  }

  async embeberConsulta(origen: OrigenIa, consulta: string, senal?: AbortSignal): Promise<{ vector: number[]; uso: Uso }> {
    const r = await this.unaria<{ valores: number[]; uso: UsoGrpc | null }>(senal, (cb) =>
      this.asistente.EmbeberConsulta({ origen: origenGrpc(origen), consulta }, this.metadatos(), this.opciones(this.deadlines.embeber), cb),
    );
    return { vector: r.valores, uso: usoDe(r.uso) };
  }

  /** Resumir o mejorar: cada valor es un trozo de texto; al terminar devuelve el uso. */
  async *transformar(tarea: 'resumir' | 'mejorar', origen: OrigenIa, contenido: string, estilo: Estilo, senal?: AbortSignal): AsyncGenerator<string, Uso> {
    const solicitud = { origen: origenGrpc(origen), contenido, estilo: `ESTILO_${estilo.toUpperCase()}` as 'ESTILO_CLARO' };
    const opciones = this.opciones(this.deadlines.transformar);
    const llamada =
      tarea === 'resumir' ? this.asistente.Resumir(solicitud, this.metadatos(), opciones) : this.asistente.Mejorar(solicitud, this.metadatos(), opciones);
    const alAbortar = () => {
      llamada.cancel();
    };
    if (senal?.aborted) llamada.cancel();
    else senal?.addEventListener('abort', alAbortar, { once: true });
    try {
      for await (const m of llamada as AsyncIterable<FragmentoGrpc>) {
        if (m.fin) return usoDe(m.uso);
        if (m.texto) yield m.texto;
      }
      throw errorGrpc(grpc.status.INTERNAL, 'la corriente terminó sin el mensaje final');
    } finally {
      senal?.removeEventListener('abort', alAbortar);
      // Si el consumidor dejó de leer antes del final, la generación se corta en el servicio.
      llamada.cancel();
    }
  }

  /** Streaming del cliente: manda los fragmentos (el origen solo en el primero) y recibe todos los vectores. */
  async indexar(
    origen: OrigenIa,
    fragmentos: { indice: number; contenido: string }[],
    senal?: AbortSignal,
  ): Promise<{ vectores: Map<number, number[]>; uso: Uso; modelo: string }> {
    const r = await new Promise<{ vectores: { indice: number; vector: { valores: number[] } | null }[]; uso: UsoGrpc | null; modelo: string }>((resolver, rechazar) => {
      const llamada = this.asistente.IndexarDocumento(this.metadatos(), this.opciones(this.deadlines.indexar), (err, res) => {
        senal?.removeEventListener('abort', alAbortar);
        if (err) rechazar(err);
        else if (!res) rechazar(errorGrpc(grpc.status.INTERNAL, 'respuesta vacía'));
        else resolver(res);
      });
      const alAbortar = () => {
        llamada.cancel();
      };
      senal?.addEventListener('abort', alAbortar, { once: true });
      fragmentos.forEach((f, i) => {
        llamada.write({ ...(i === 0 ? { origen: origenGrpc(origen) } : {}), indice: f.indice, contenido: f.contenido });
      });
      llamada.end();
    });
    return { vectores: new Map(r.vectores.map((v) => [v.indice, v.vector?.valores ?? []])), uso: usoDe(r.uso), modelo: r.modelo };
  }

  /** Corriente bidireccional de una conexión de edición. Se abre al primer pedido y se reabre si se corta. */
  autocompletado(origen: OrigenIa): SesionAutocompletado {
    type Espera = { resolver: (r: { texto: string; uso: Uso } | null) => void; rechazar: (e: unknown) => void; t: ReturnType<typeof setTimeout> };
    let llamada: grpc.ClientDuplexStream<ContextoAutocompletado, SugerenciaGrpc> | null = null;
    let espera: { pedido: string; e: Espera } | null = null;
    const soltar = (r: { texto: string; uso: Uso } | null) => {
      if (!espera) return;
      clearTimeout(espera.e.t);
      espera.e.resolver(r);
      espera = null;
    };
    const fallar = (err: unknown) => {
      if (!espera) return;
      clearTimeout(espera.e.t);
      espera.e.rechazar(err);
      espera = null;
    };
    const abrir = () => {
      const l = this.asistente.Autocompletar(this.metadatos(), {});
      l.on('data', (s: SugerenciaGrpc) => {
        if (espera?.pedido === s.pedido_id) soltar({ texto: s.texto, uso: usoDe(s.uso) });
      });
      l.on('error', (err: unknown) => {
        if (llamada === l) llamada = null;
        fallar(err);
      });
      l.on('end', () => {
        if (llamada === l) llamada = null;
        fallar(errorGrpc(grpc.status.UNAVAILABLE, 'la corriente de autocompletado se cerró'));
      });
      llamada = l;
      return l;
    };
    return {
      pedir: (pedido, antes, despues) =>
        new Promise((resolver, rechazar) => {
          soltar(null); // el pedido anterior ya no importa
          const nueva = llamada === null;
          const l = llamada ?? abrir();
          const id = String(pedido);
          const t = setTimeout(() => {
            if (espera?.pedido === id) fallar(errorGrpc(grpc.status.DEADLINE_EXCEEDED, 'la sugerencia tardó demasiado'));
          }, this.deadlines.sugerencia);
          espera = { pedido: id, e: { resolver, rechazar, t } };
          l.write({ ...(nueva ? { origen: origenGrpc(origen) } : {}), pedido_id: id, antes, despues });
        }),
      cerrar: () => {
        soltar(null);
        const l = llamada;
        llamada = null;
        l?.end();
      },
    };
  }

  /** Salud estándar (grpc.health.v1): resuelve si el servicio dice SERVING; si no, rechaza. */
  comprobarSalud(): Promise<void> {
    return new Promise((resolver, rechazar) => {
      this.salud.Check({ service: SERVICIO }, this.opciones(this.deadlines.salud), (err, r) => {
        if (err) rechazar(err);
        else if (r?.status !== 'SERVING') rechazar(new Error(`servicio de IA: ${r?.status ?? 'sin respuesta'}`));
        else resolver();
      });
    });
  }

  cerrar(): void {
    this.asistente.close();
    this.salud.close();
  }
}
