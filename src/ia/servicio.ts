// Servicio gRPC de IA (bloque P1, ADR 0002): cuaderno.ia.v1.Asistente + grpc.health.v1.Health, en un
// PROCESO APARTE (src/ia/principal.ts) que solo escucha en 127.0.0.1. No tiene base ni Redis: el API ya
// verificó sesión, permiso y tope ANTES de llamar, y guarda los resultados él mismo.
//
//   - Autenticación entre servicios: un interceptor exige `authorization: Bearer <IA_SERVICE_TOKEN>`
//     (comparado en tiempo constante) en TODO método salvo la salud estándar, que consultan los
//     orquestadores sin token y solo dice SERVING o NOT_SERVING.
//   - Cancelación: si el API cancela o vence su deadline, la llamada se marca cancelada y la AbortSignal
//     del proveedor se dispara: deja de generar en el acto. Además, cada método tiene un tope PROPIO
//     (el doble del deadline del API), por si un cliente no pusiera deadline.
//   - Errores del proveedor → estado gRPC (ErrorProveedor.categoria); el API los traduce a HTTP.
//   - Aislamiento: el origen (cuenta, espacio, documento) va SOLO en el primer mensaje de cada corriente;
//     uno distinto después cierra la corriente con INVALID_ARGUMENT (una corriente nunca mezcla documentos).
//     Cada llamada se registra con sus ids, nunca con el contenido.
import { createHash, timingSafeEqual } from 'node:crypto';
import * as grpc from '@grpc/grpc-js';
import type { Logger } from 'pino';
import { DIMENSIONES, paquete, SERVICIO, type AsistenteHandlers, type HealthHandlers } from './contrato.js';
import type { Origen__Output } from '../generated/ia/cuaderno/ia/v1/Origen.js';
import { ErrorProveedor, tokensAprox, type Estilo, type ProveedorIa, type Uso } from './proveedor.js';

/** Topes de tamaño (caracteres) y de tiempo del lado del servicio. */
export const LIMITES_SERVICIO = {
  explicar: 20_000,
  transformar: 200_000,
  consulta: 2_000,
  fragmentoTexto: 4_000,
  fragmentos: 2_000,
  antes: 4_000,
  despues: 1_000,
  /** Topes de SALIDA (P2): lo que genera el modelo tampoco es de confianza; más largo, se recorta. */
  salidaExplicar: 4_000,
  salidaTransformar: 60_000,
  salidaSugerencia: 300,
  /** El doble de los deadlines del API (ADR 0002): 15 s, 60 s, 120 s y 2 s por sugerencia. */
  unariaMs: 30_000,
  transformarMs: 120_000,
  indexarMs: 240_000,
  sugerenciaMs: 4_000,
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RUTA_SALUD = '/grpc.health.v1.Health/';

const invalido = (mensaje: string) => new ErrorProveedor('invalido', mensaje);

/** El origen: cuenta y espacio siempre; documento salvo en EmbeberConsulta. Solo ids, nunca datos personales. */
function validarOrigen(o: Origen__Output | null, conDocumento: boolean): Origen__Output {
  if (!o) throw invalido('falta el origen');
  if (!UUID.test(o.cuenta_id) || !UUID.test(o.espacio_id)) throw invalido('origen: cuenta_id y espacio_id deben ser uuid');
  if (conDocumento ? !UUID.test(o.documento_id) : o.documento_id !== '' && !UUID.test(o.documento_id)) throw invalido('origen: documento_id inválido');
  if (o.solicitud_id.length > 64) throw invalido('origen: solicitud_id demasiado largo');
  return o;
}

function texto(valor: string, maximo: number, campo: string): string {
  if (valor.trim() === '') throw invalido(`${campo} vacío`);
  if (valor.length > maximo) throw invalido(`${campo} supera ${String(maximo)} caracteres`);
  return valor;
}

const ESTILOS: Record<string, Estilo> = { ESTILO_SIN_ESPECIFICAR: 'claro', ESTILO_CLARO: 'claro', ESTILO_BREVE: 'breve', ESTILO_FORMAL: 'formal' };

const CODIGOS: Record<ErrorProveedor['categoria'], grpc.status> = {
  invalido: grpc.status.INVALID_ARGUMENT,
  limite: grpc.status.RESOURCE_EXHAUSTED,
  no_disponible: grpc.status.UNAVAILABLE,
  cancelado: grpc.status.CANCELLED,
  no_implementado: grpc.status.UNIMPLEMENTED,
  interno: grpc.status.INTERNAL,
};

type ErrorGrpc = grpc.ServiceError;

const usoGrpc = (u: Uso) => ({ tokens_entrada: u.entrada, tokens_salida: u.salida });

/** Vectores del proveedor: uno por texto y de EXACTAMENTE 1024 dimensiones finitas, o error interno. */
export function verificarVectores(vectores: number[][], esperados: number): number[][] {
  if (vectores.length !== esperados) throw new ErrorProveedor('interno', `el proveedor devolvió ${String(vectores.length)} vectores; se esperaban ${String(esperados)}`);
  for (const v of vectores) {
    if (v.length !== DIMENSIONES) {
      throw new ErrorProveedor('interno', `el proveedor devolvió vectores de ${String(v.length)} dimensiones; la base espera ${String(DIMENSIONES)}`);
    }
    if (!v.every(Number.isFinite)) throw new ErrorProveedor('interno', 'el proveedor devolvió un vector con valores no finitos');
  }
  return vectores;
}

/** Comparación en tiempo constante (también en la longitud: se comparan los SHA-256). */
function tokenValido(metadatos: grpc.Metadata, esperado: Buffer): boolean {
  const valor = metadatos.get('authorization')[0];
  const recibido = typeof valor === 'string' && valor.startsWith('Bearer ') ? valor.slice(7) : '';
  const a = createHash('sha256').update(recibido).digest();
  const b = createHash('sha256').update(esperado).digest();
  return recibido !== '' && timingSafeEqual(a, b);
}

/** Interceptor de autenticación entre servicios: sin el token, UNAUTHENTICATED antes de llegar al método. */
export function interceptorAutenticacion(token: string, log: Logger): grpc.ServerInterceptor {
  const esperado = Buffer.from(token);
  return (metodo, llamada) =>
    new grpc.ServerInterceptingCall(llamada, {
      start: (siguiente) => {
        siguiente({
          onReceiveMetadata: (metadatos, seguir) => {
            if (metodo.path.startsWith(RUTA_SALUD) || tokenValido(metadatos, esperado)) {
              seguir(metadatos);
              return;
            }
            log.warn({ metodo: metodo.path, par: llamada.getPeer() }, 'ia: llamada sin token de servicio válido');
            llamada.sendStatus({ code: grpc.status.UNAUTHENTICATED, details: 'token de servicio inválido', metadata: new grpc.Metadata() });
          },
        });
      },
    });
}

type Estado = 'SERVING' | 'NOT_SERVING';

/** grpc.health.v1.Health: "" (el proceso) y cuaderno.ia.v1.Asistente. Watch avisa cada cambio. */
function crearSalud() {
  const estados = new Map<string, Estado>([
    ['', 'SERVING'],
    [SERVICIO, 'SERVING'],
  ]);
  const observadores = new Set<{ servicio: string; llamada: grpc.ServerWritableStream<unknown, { status: string }> }>();
  const manejadores: HealthHandlers = {
    Check: (llamada, responder) => {
      const estado = estados.get(llamada.request.service);
      if (!estado) {
        responder({ code: grpc.status.NOT_FOUND, details: 'servicio desconocido' });
        return;
      }
      responder(null, { status: estado });
    },
    Watch: (llamada) => {
      const o = { servicio: llamada.request.service, llamada: llamada as unknown as grpc.ServerWritableStream<unknown, { status: string }> };
      observadores.add(o);
      llamada.write({ status: estados.get(o.servicio) ?? 'SERVICE_UNKNOWN' });
      llamada.on('cancelled', () => observadores.delete(o));
    },
  };
  return {
    manejadores,
    fijar(estado: Estado): void {
      for (const s of estados.keys()) estados.set(s, estado);
      for (const o of observadores) o.llamada.write({ status: estados.get(o.servicio) ?? 'SERVICE_UNKNOWN' });
    },
    cerrarObservadores(): void {
      for (const o of observadores) o.llamada.end();
      observadores.clear();
    },
  };
}

export interface OpcionesServicioIa {
  proveedor: ProveedorIa;
  token: string;
  log: Logger;
  /** TLS mutuo en producción; sin esto, texto plano (solo 127.0.0.1). */
  credenciales?: grpc.ServerCredentials;
}

export function crearServicioIa(o: OpcionesServicioIa) {
  const { proveedor: p, log } = o;
  const salud = crearSalud();

  /** Traduce cualquier error a un estado gRPC. Lo inesperado queda en el log y sale como INTERNAL sin detalle. */
  function aGrpc(err: unknown, metodo: string, origen: Origen__Output | null): ErrorGrpc {
    const metadata = new grpc.Metadata();
    if (err instanceof ErrorProveedor) {
      if (err.reintentarEnS !== undefined) metadata.set('retry-after', String(err.reintentarEnS));
      if (err.categoria === 'interno') log.error({ err, metodo, ...ids(origen) }, 'ia: error interno del proveedor');
      return Object.assign(new Error(err.message), { code: CODIGOS[err.categoria], details: err.message, metadata });
    }
    log.error({ err, metodo, ...ids(origen) }, 'ia: error no controlado');
    return Object.assign(new Error('error interno'), { code: grpc.status.INTERNAL, details: 'error interno', metadata });
  }

  const ids = (origen: Origen__Output | null) =>
    origen ? { cuenta: origen.cuenta_id, espacio: origen.espacio_id, documento: origen.documento_id || undefined, solicitud: origen.solicitud_id || undefined } : {};

  function registrar(metodo: string, origen: Origen__Output | null, inicio: number, codigo: grpc.status): void {
    log.info({ metodo, ...ids(origen), ms: Date.now() - inicio, codigo: grpc.status[codigo] }, 'ia: llamada');
  }

  /** AbortController que se dispara si el API cancela (o vence su deadline) o si pasa el tope propio. */
  function controlador(llamada: { on(evento: 'cancelled', f: () => void): unknown }, topeMs: number): AbortController {
    const ac = new AbortController();
    const t = setTimeout(() => {
      ac.abort();
    }, topeMs);
    ac.signal.addEventListener('abort', () => {
      clearTimeout(t);
    });
    llamada.on('cancelled', () => {
      ac.abort();
    });
    return ac;
  }

  /** Error de una corriente: si la llamada ya se canceló, no hay a quién contestar. */
  const cancelada = (err: unknown) => err instanceof ErrorProveedor && err.categoria === 'cancelado';

  /** Escribe en una corriente respetando la contrapresión (espera a "drain" si el búfer está lleno). */
  function escribir<T>(llamada: grpc.ServerWritableStream<unknown, T> | grpc.ServerDuplexStream<unknown, T>, mensaje: T): Promise<void> {
    return new Promise((resolver) => {
      if (llamada.write(mensaje)) resolver();
      else llamada.once('drain', resolver);
    });
  }

  const transformar =
    (tarea: 'resumir' | 'mejorar'): AsistenteHandlers['Resumir'] =>
    (llamada) => {
      const inicio = Date.now();
      const metodo = tarea === 'resumir' ? 'Resumir' : 'Mejorar';
      const ac = controlador(llamada, LIMITES_SERVICIO.transformarMs);
      let origen: Origen__Output | null = null;
      void (async () => {
        origen = validarOrigen(llamada.request.origen, true);
        const contenido = texto(llamada.request.contenido, LIMITES_SERVICIO.transformar, 'contenido');
        const generador = p.transformar({ tarea, contenido, estilo: ESTILOS[llamada.request.estilo] ?? 'claro' }, ac.signal);
        let emitido = 0;
        for (;;) {
          const r = await generador.next();
          if (r.done) {
            await escribir(llamada, { texto: '', fin: true, uso: usoGrpc(r.value) });
            break;
          }
          const trozo = r.value.slice(0, LIMITES_SERVICIO.salidaTransformar - emitido);
          emitido += trozo.length;
          if (trozo) await escribir(llamada, { texto: trozo, fin: false, uso: null });
          if (emitido >= LIMITES_SERVICIO.salidaTransformar) {
            // Tope de salida: se corta la generación y se cierra con el uso estimado hasta aquí.
            ac.abort();
            log.warn({ metodo, ...ids(origen), caracteres: emitido }, 'ia: salida recortada al tope');
            await escribir(llamada, { texto: '', fin: true, uso: usoGrpc({ entrada: tokensAprox(contenido), salida: Math.ceil(emitido / 4) }) });
            break;
          }
        }
        llamada.end();
        registrar(metodo, origen, inicio, grpc.status.OK);
      })().catch((err: unknown) => {
        ac.abort();
        if (llamada.cancelled || cancelada(err)) {
          registrar(metodo, origen, inicio, grpc.status.CANCELLED);
          return;
        }
        const e = aGrpc(err, metodo, origen);
        registrar(metodo, origen, inicio, e.code);
        llamada.emit('error', e);
      });
    };

  const asistente: AsistenteHandlers = {
    Describir: (_llamada, responder) => {
      responder(null, { proveedor: p.nombre, modelo_embeddings: p.modeloEmbeddings, dimensiones: p.dimensiones });
    },

    Explicar: (llamada, responder) => {
      const inicio = Date.now();
      const ac = controlador(llamada, LIMITES_SERVICIO.unariaMs);
      let origen: Origen__Output | null = null;
      void (async () => {
        origen = validarOrigen(llamada.request.origen, true);
        const contenido = texto(llamada.request.contenido, LIMITES_SERVICIO.explicar, 'contenido');
        if (llamada.request.lenguaje.length > 40) throw invalido('lenguaje demasiado largo');
        const r = await p.explicar({ contenido, lenguaje: llamada.request.lenguaje }, ac.signal);
        ac.abort();
        registrar('Explicar', origen, inicio, grpc.status.OK);
        responder(null, { texto: r.texto.slice(0, LIMITES_SERVICIO.salidaExplicar), uso: usoGrpc(r.uso) });
      })().catch((err: unknown) => {
        ac.abort();
        const e = aGrpc(err, 'Explicar', origen);
        registrar('Explicar', origen, inicio, e.code);
        responder(e);
      });
    },

    EmbeberConsulta: (llamada, responder) => {
      const inicio = Date.now();
      const ac = controlador(llamada, LIMITES_SERVICIO.unariaMs);
      let origen: Origen__Output | null = null;
      void (async () => {
        origen = validarOrigen(llamada.request.origen, false);
        const consulta = texto(llamada.request.consulta, LIMITES_SERVICIO.consulta, 'consulta');
        const r = await p.embeber([consulta], ac.signal);
        const [vector] = verificarVectores(r.vectores, 1);
        ac.abort();
        registrar('EmbeberConsulta', origen, inicio, grpc.status.OK);
        responder(null, { valores: vector ?? [], uso: usoGrpc(r.uso) });
      })().catch((err: unknown) => {
        ac.abort();
        const e = aGrpc(err, 'EmbeberConsulta', origen);
        registrar('EmbeberConsulta', origen, inicio, e.code);
        responder(e);
      });
    },

    Resumir: transformar('resumir'),
    Mejorar: transformar('mejorar'),

    IndexarDocumento: (llamada, responder) => {
      const inicio = Date.now();
      const ac = controlador(llamada, LIMITES_SERVICIO.indexarMs);
      let origen: Origen__Output | null = null;
      const fragmentos: { indice: number; contenido: string }[] = [];
      const indices = new Set<number>();
      let problema: Error | null = null;
      llamada.on('data', (m: { origen: Origen__Output | null; indice: number; contenido: string }) => {
        if (problema) return;
        try {
          if (origen === null) origen = validarOrigen(m.origen, true);
          else if (m.origen) throw invalido('el origen va solo en el primer mensaje');
          if (fragmentos.length >= LIMITES_SERVICIO.fragmentos) throw invalido(`más de ${String(LIMITES_SERVICIO.fragmentos)} fragmentos`);
          if (indices.has(m.indice)) throw invalido(`fragmento ${String(m.indice)} repetido`);
          indices.add(m.indice);
          fragmentos.push({ indice: m.indice, contenido: texto(m.contenido, LIMITES_SERVICIO.fragmentoTexto, 'fragmento') });
        } catch (err) {
          problema = err instanceof Error ? err : invalido(String(err));
        }
      });
      llamada.on('end', () => {
        void (async () => {
          if (problema) throw problema;
          if (!origen || fragmentos.length === 0) throw invalido('sin fragmentos');
          const r = await p.embeber(
            fragmentos.map((f) => f.contenido),
            ac.signal,
          );
          const vectores = verificarVectores(r.vectores, fragmentos.length);
          ac.abort();
          registrar('IndexarDocumento', origen, inicio, grpc.status.OK);
          responder(null, {
            vectores: fragmentos.map((f, i) => ({ indice: f.indice, vector: { valores: vectores[i] ?? [] } })),
            uso: usoGrpc(r.uso),
            modelo: p.modeloEmbeddings,
          });
        })().catch((err: unknown) => {
          ac.abort();
          const e = aGrpc(err, 'IndexarDocumento', origen);
          registrar('IndexarDocumento', origen, inicio, e.code);
          responder(e);
        });
      });
    },

    Autocompletar: (llamada) => {
      let origen: Origen__Output | null = null;
      let actual: AbortController | null = null;
      let terminada = false;
      const terminar = (err: unknown) => {
        if (terminada) return;
        terminada = true;
        actual?.abort();
        llamada.emit('error', aGrpc(err, 'Autocompletar', origen));
      };
      llamada.on('data', (m: { origen: Origen__Output | null; pedido_id: string; antes: string; despues: string }) => {
        if (terminada) return;
        try {
          if (origen === null) origen = validarOrigen(m.origen, true);
          else if (m.origen) throw invalido('el origen va solo en el primer mensaje');
          if (m.antes.length > LIMITES_SERVICIO.antes || m.despues.length > LIMITES_SERVICIO.despues) throw invalido('contexto demasiado largo');
        } catch (err) {
          terminar(err);
          return;
        }
        // Un contexto nuevo cancela la sugerencia anterior: el proveedor deja de generarla.
        actual?.abort();
        const ac = new AbortController();
        actual = ac;
        const t = setTimeout(() => {
          ac.abort();
        }, LIMITES_SERVICIO.sugerenciaMs);
        const inicio = Date.now();
        const pedido = m.pedido_id;
        p.autocompletar({ antes: m.antes, despues: m.despues }, ac.signal).then(
          (r) => {
            clearTimeout(t);
            if (ac.signal.aborted || terminada) return;
            registrar('Autocompletar', origen, inicio, grpc.status.OK);
            llamada.write({ pedido_id: pedido, texto: r.texto.slice(0, LIMITES_SERVICIO.salidaSugerencia), uso: usoGrpc(r.uso) });
          },
          (err: unknown) => {
            clearTimeout(t);
            if (cancelada(err) || ac.signal.aborted) return;
            terminar(err);
          },
        );
      });
      llamada.on('end', () => {
        actual?.abort();
        if (!terminada) {
          terminada = true;
          llamada.end();
        }
      });
      llamada.on('cancelled', () => {
        terminada = true;
        actual?.abort();
      });
    },
  };

  const servidor = new grpc.Server({ interceptors: [interceptorAutenticacion(o.token, log)] });
  servidor.addService(paquete.cuaderno.ia.v1.Asistente.service, asistente);
  servidor.addService(paquete.grpc.health.v1.Health.service, salud.manejadores);

  return {
    /** Escucha en host:puerto (0 = uno libre, para las pruebas). Devuelve el puerto. */
    escuchar: (host: string, puerto: number): Promise<number> =>
      new Promise((resolver, rechazar) => {
        servidor.bindAsync(`${host}:${String(puerto)}`, o.credenciales ?? grpc.ServerCredentials.createInsecure(), (err, real) => {
          if (err) rechazar(err);
          else resolver(real);
        });
      }),
    /** Apagado ordenado: NOT_SERVING, espera las llamadas en curso hasta `limiteMs` y luego corta. */
    cerrar: (limiteMs = 5000): Promise<void> => {
      salud.fijar('NOT_SERVING');
      salud.cerrarObservadores();
      return new Promise((resolver) => {
        const t = setTimeout(() => {
          servidor.forceShutdown();
          resolver();
        }, limiteMs);
        servidor.tryShutdown(() => {
          clearTimeout(t);
          resolver();
        });
      });
    },
    fijarSalud: (estado: Estado): void => {
      salud.fijar(estado);
    },
  };
}

export type ServicioIa = ReturnType<typeof crearServicioIa>;
