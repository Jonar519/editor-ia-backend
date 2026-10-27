// Medición de P3 (ADR 0002): la misma operación por gRPC y por REST/JSON, en el mismo proceso servidor.
// Uso: npm run medir -- [--rapido] [--entorno windows|linux] [--umbral 10] [--forzar]
//
//   1. Carga de CPU de la máquina ANTES de empezar: si pasa del umbral (10 % por defecto), no mide
//      (con --forzar mide igual y queda anotado). Se registra también antes de CADA corrida.
//   2. Verifica que los tres caminos den el mismo resultado.
//   3. Tamaños: cuerpo serializado (protobuf y JSON) y bytes en el cable por llamada (proxy contador).
//   4. En serie (1 en vuelo) y en concurrencia (c en vuelo, lazo cerrado), con 5 repeticiones alternando
//      el orden; latencias p50/p95/p99/máx, pedidos por segundo y CPU de cliente y servidor.
//   5. Escribe docs/medicion-p3.json (crudo, por entorno) y genera docs/medicion-p3.md.
import { fork, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem, type } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { paquete } from '../../src/ia/contrato.js';
import { clienteGrpc, clienteH1, clienteH2, type ClienteMedicion } from './clientes.js';
import { cargaCpu } from './cpu.js';
import { resumir, type Resumen } from './estadistica.js';
import { generarInforme } from './informe.js';
import { ORIGEN_MEDICION, vectorDenso } from './servidor.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

const { values: a } = parseArgs({
  options: {
    rapido: { type: 'boolean', default: false },
    entorno: { type: 'string', default: platform() === 'win32' ? 'windows' : 'linux' },
    umbral: { type: 'string', default: '10' },
    forzar: { type: 'boolean', default: false },
    // Otra carpeta de salida (para probar el script sin tocar docs/).
    salida: { type: 'string', default: path.join(RAIZ, 'docs') },
  },
});
const SALIDA_JSON = path.join(a.salida, 'medicion-p3.json');
const SALIDA_MD = path.join(a.salida, 'medicion-p3.md');

export const PARAMETROS = a.rapido
  ? { calentamiento: 50, serie: 300, concurrencia: 1000, concurrencias: [1, 8, 32], repeticiones: 2 }
  : { calentamiento: 500, serie: 5000, concurrencia: 20_000, concurrencias: [1, 8, 32, 128], repeticiones: 5 };
const UMBRAL = Number(a.umbral);

// ─── El proceso servidor ────────────────────────────────────────────────────────

interface Listo {
  token: string;
  puertos: { grpc: number; h1: number; h2: number };
  proxies: { grpc: number; h1: number; h2: number };
}

function pedir<T>(hijo: ChildProcess, tipo: string): Promise<T> {
  return new Promise((resolver) => {
    const f = (m: { tipo: string } & T) => {
      if (m.tipo !== tipo) return;
      hijo.off('message', f);
      resolver(m);
    };
    hijo.on('message', f);
    hijo.send({ tipo });
  });
}

const cpuServidor = async (hijo: ChildProcess) => (await pedir<{ cpu: NodeJS.CpuUsage }>(hijo, 'cpu')).cpu;

// ─── Operaciones y caminos ──────────────────────────────────────────────────────

const contenido = (bytes: number) => 'palabra '.repeat(Math.ceil(bytes / 8)).slice(0, bytes);
const CONSULTA = 'consulta de búsqueda ficticia sobre migraciones';

type Operacion = 'U1' | 'U2-100B' | 'U2-8KB' | 'U2-64KB' | 'S1';
export const OPERACIONES: Record<Operacion, { nombre: string; correr: (c: ClienteMedicion) => Promise<unknown> }> = {
  U1: { nombre: 'EmbeberConsulta (respuesta: 1024 floats)', correr: (c) => c.embeber(CONSULTA) },
  'U2-100B': { nombre: 'Explicar, pedido de 100 B', correr: (c) => c.explicar(contenido(100)) },
  'U2-8KB': { nombre: 'Explicar, pedido de 8 KB', correr: (c) => c.explicar(contenido(8 * 1024)) },
  'U2-64KB': { nombre: 'Explicar, pedido de 64 KB', correr: (c) => c.explicar(contenido(64 * 1024)) },
  S1: { nombre: 'Resumir en streaming (pedido de 8 KB, 31 fragmentos)', correr: (c) => c.resumir(contenido(8 * 1024)) },
};

type Variante = 'grpc-1-canal' | 'grpc-c-canales' | 'h1-c-conexiones' | 'h1-1-conexion' | 'h2-1-sesion';

function crearCliente(l: Listo, v: Variante, c: number): ClienteMedicion {
  const url = `127.0.0.1:${String(l.puertos.grpc)}`;
  switch (v) {
    case 'grpc-1-canal':
      return clienteGrpc(url, l.token, ORIGEN_MEDICION, 1);
    case 'grpc-c-canales':
      return clienteGrpc(url, l.token, ORIGEN_MEDICION, c);
    case 'h1-c-conexiones':
      return clienteH1(l.puertos.h1, l.token, ORIGEN_MEDICION, c);
    case 'h1-1-conexion':
      return clienteH1(l.puertos.h1, l.token, ORIGEN_MEDICION, 1);
    case 'h2-1-sesion':
      return clienteH2(l.puertos.h2, l.token, ORIGEN_MEDICION);
  }
}

/** Variantes de cada concurrencia: los tres caminos y, con c > 1, las dos de multiplexación. */
const variantesDe = (c: number): Variante[] =>
  c === 1 ? ['grpc-1-canal', 'h1-c-conexiones', 'h2-1-sesion'] : ['grpc-1-canal', 'grpc-c-canales', 'h1-c-conexiones', 'h1-1-conexion', 'h2-1-sesion'];

/** Intentos (de unos 5 s) para que baje la carga antes de una corrida; después, se aborta todo. */
const ESPERAS_MAXIMAS = 12;

class CargaAjena extends Error {
  constructor(carga: number, op: string, v: string, c: number) {
    super(`carga de CPU ajena persistente (${String(carga)} % > ${String(UMBRAL)} %) antes de ${op} ${v} c=${String(c)}`);
    this.name = 'CargaAjena';
  }
}

const ahora = () => Number(process.hrtime.bigint()) / 1e6;
const msCpu = (u: NodeJS.CpuUsage) => (u.user + u.system) / 1000;

export interface Corrida {
  operacion: Operacion;
  variante: Variante;
  concurrencia: number;
  repeticion: number;
  cargaPrevia: number;
  /** Cuántas veces hubo que esperar a que bajara la carga antes de esta corrida (0 = ninguna). */
  esperasPorCarga?: number;
  latencia: Resumen;
  /** Solo S1: hasta el primer fragmento. */
  primerFragmento?: Resumen;
  pedidosPorSegundo: number;
  cpuClienteMsPorMil: number;
  cpuServidorMsPorMil: number;
}

/** c pedidos en vuelo (lazo cerrado) hasta completar `total`. Devuelve latencias y tiempo de pared. */
async function lazo(cliente: ClienteMedicion, op: Operacion, c: number, total: number) {
  const latencias: number[] = [];
  const primeros: number[] = [];
  let lanzados = 0;
  const inicio = ahora();
  await Promise.all(
    Array.from({ length: c }, async () => {
      while (lanzados < total) {
        lanzados++;
        const t0 = ahora();
        const r = await OPERACIONES[op].correr(cliente);
        latencias.push(ahora() - t0);
        if (op === 'S1') primeros.push((r as { primeroMs: number }).primeroMs);
      }
    }),
  );
  return { latencias, primeros, paredMs: ahora() - inicio };
}

async function corrida(hijo: ChildProcess, l: Listo, op: Operacion, v: Variante, c: number, total: number, repeticion: number): Promise<Corrida> {
  const cliente = crearCliente(l, v, c);
  try {
    await lazo(cliente, op, c, PARAMETROS.calentamiento);
    // No se mide con la máquina ocupada: si la carga pasa del umbral, se espera y se vuelve a medir; si
    // sigue alta, se aborta TODO sin escribir nada (no se mezclan datos con carga ajena).
    let cargaPrevia = await cargaCpu(300);
    let esperasPorCarga = 0;
    while (cargaPrevia > UMBRAL && !a.forzar) {
      if (++esperasPorCarga > ESPERAS_MAXIMAS) throw new CargaAjena(cargaPrevia, op, v, c);
      await new Promise((r) => setTimeout(r, 4000));
      cargaPrevia = await cargaCpu(1000);
    }
    const cliente0 = process.cpuUsage();
    const servidor0 = await cpuServidor(hijo);
    const r = await lazo(cliente, op, c, total);
    const cpuCliente = msCpu(process.cpuUsage(cliente0));
    const servidor1 = await cpuServidor(hijo);
    const cpuServ = msCpu({ user: servidor1.user - servidor0.user, system: servidor1.system - servidor0.system });
    return {
      operacion: op,
      variante: v,
      concurrencia: c,
      repeticion,
      cargaPrevia,
      esperasPorCarga,
      latencia: resumir(r.latencias),
      ...(op === 'S1' ? { primerFragmento: resumir(r.primeros) } : {}),
      pedidosPorSegundo: Math.round((total / r.paredMs) * 1000),
      cpuClienteMsPorMil: (cpuCliente / total) * 1000,
      cpuServidorMsPorMil: (cpuServ / total) * 1000,
    };
  } finally {
    await cliente.cerrar();
  }
}

// ─── Tamaños ────────────────────────────────────────────────────────────────────

const servicio = paquete.cuaderno.ia.v1.Asistente.service as unknown as Record<string, { requestSerialize: (v: unknown) => Buffer; responseSerialize: (v: unknown) => Buffer }>;
const origenProto = { cuenta_id: ORIGEN_MEDICION.cuentaId, espacio_id: ORIGEN_MEDICION.espacioId, documento_id: ORIGEN_MEDICION.documentoId, solicitud_id: ORIGEN_MEDICION.solicitudId };
const largo = (v: unknown) => Buffer.byteLength(JSON.stringify(v));

/** Cuerpos serializados (sin transporte): protobuf y JSON, para el mismo contenido. */
function cuerpos(op: Operacion) {
  const uso = { tokens_entrada: 12, tokens_salida: 34 };
  if (op === 'U1') {
    const pedido = { origen: { ...origenProto, documento_id: '' }, consulta: CONSULTA };
    const valores = vectorDenso(CONSULTA).map((x) => Math.fround(x));
    return {
      protobuf: { pedido: servicio.EmbeberConsulta?.requestSerialize(pedido).length ?? 0, respuesta: servicio.EmbeberConsulta?.responseSerialize({ valores, uso }).length ?? 0 },
      json: { pedido: largo(pedido), respuesta: largo({ valores, uso }) },
    };
  }
  const bytes = op === 'U2-100B' ? 100 : op === 'U2-64KB' ? 64 * 1024 : 8 * 1024;
  const pedido = { origen: origenProto, contenido: contenido(bytes), lenguaje: '' };
  if (op === 'S1') {
    const frag = { texto: ' palabra', fin: false, uso: null };
    return {
      protobuf: { pedido: servicio.Resumir?.requestSerialize({ ...pedido, estilo: 'ESTILO_CLARO' }).length ?? 0, respuesta: (servicio.Resumir?.responseSerialize(frag).length ?? 0) * 31 },
      json: { pedido: largo({ ...pedido, estilo: 'claro' }), respuesta: (largo(frag) + 1) * 31 },
    };
  }
  const resp = { texto: 'Explicación simulada: el fragmento tiene 13 palabras y empieza con «palabra palabra palabra palabra palabra palabra palabra palabra».', uso };
  return {
    protobuf: { pedido: servicio.Explicar?.requestSerialize(pedido).length ?? 0, respuesta: servicio.Explicar?.responseSerialize(resp).length ?? 0 },
    json: { pedido: largo(pedido), respuesta: largo(resp) },
  };
}

/** Bytes en el cable por llamada (cabeceras, marcos y compresión HPACK incluidos), con 200 llamadas por camino. */
async function bytesEnCable(hijo: ChildProcess, l: Listo, op: Operacion) {
  const n = 200;
  const porCamino: Record<string, { pedido: number; respuesta: number }> = {};
  const caminos = {
    grpc: () => clienteGrpc(`127.0.0.1:${String(l.proxies.grpc)}`, l.token, ORIGEN_MEDICION),
    h1: () => clienteH1(l.proxies.h1, l.token, ORIGEN_MEDICION, 1),
    h2: () => clienteH2(l.proxies.h2, l.token, ORIGEN_MEDICION),
  };
  for (const [nombre, crear] of Object.entries(caminos)) {
    const c = crear();
    await OPERACIONES[op].correr(c); // abre la conexión fuera de la cuenta
    await pedir(hijo, 'reiniciar-bytes');
    for (let i = 0; i < n; i++) await OPERACIONES[op].correr(c);
    const b = (await pedir<{ bytes: Record<string, { pedido: number; respuesta: number }> }>(hijo, 'bytes')).bytes[nombre] ?? { pedido: 0, respuesta: 0 };
    porCamino[nombre] = { pedido: Math.round(b.pedido / n), respuesta: Math.round(b.respuesta / n) };
    await c.cerrar();
  }
  return porCamino;
}

// ─── Principal ──────────────────────────────────────────────────────────────────

async function principal(): Promise<void> {
  const cargaInicial = await cargaCpu(5000);
  console.log(`Carga de CPU de la máquina antes de empezar (5 s): ${String(cargaInicial)} %`);
  if (cargaInicial > UMBRAL && !a.forzar) {
    console.error(`NO SE MIDE: la carga (${String(cargaInicial)} %) pasa del umbral (${String(UMBRAL)} %). Cierra otros programas o usa --forzar.`);
    process.exit(3);
  }

  const hijo = fork(path.join(RAIZ, 'scripts', 'medicion', 'proceso-servidor.ts'), [], { execArgv: ['--import', 'tsx'], stdio: 'inherit' });
  const l = await new Promise<Listo>((r) => hijo.once('message', (m) => {
    r(m as Listo);
  }));
  try {
    // Mismo resultado por los tres caminos.
    const tres = [clienteGrpc(`127.0.0.1:${String(l.puertos.grpc)}`, l.token, ORIGEN_MEDICION), clienteH1(l.puertos.h1, l.token, ORIGEN_MEDICION, 1), clienteH2(l.puertos.h2, l.token, ORIGEN_MEDICION)];
    for (const op of Object.keys(OPERACIONES) as Operacion[]) {
      const r = await Promise.all(tres.map((c) => OPERACIONES[op].correr(c)));
      if (new Set(r.map((x) => JSON.stringify(x, (k, v: unknown) => (k === 'primeroMs' ? 0 : v)))).size !== 1) throw new Error(`los caminos no dan lo mismo en ${op}`);
    }
    for (const c of tres) await c.cerrar();
    console.log('Los tres caminos dan el mismo resultado en las 5 operaciones.');

    const tamanos: Record<string, unknown> = {};
    for (const op of Object.keys(OPERACIONES) as Operacion[]) tamanos[op] = { cuerpo: cuerpos(op), cable: await bytesEnCable(hijo, l, op) };
    console.log('Tamaños medidos.');

    const corridas: Corrida[] = [];
    const ops = Object.keys(OPERACIONES) as Operacion[];
    for (const op of ops) {
      for (let rep = 1; rep <= PARAMETROS.repeticiones; rep++) {
        const orden: Variante[] = ['grpc-1-canal', 'h1-c-conexiones', 'h2-1-sesion'];
        for (const v of rep % 2 === 0 ? orden.reverse() : orden) corridas.push(await corrida(hijo, l, op, v, 1, PARAMETROS.serie, rep));
      }
      console.log(`  serie ${op}: listo`);
    }
    const serie = corridas.splice(0);
    for (const op of ops) {
      for (const c of PARAMETROS.concurrencias) {
        for (let rep = 1; rep <= PARAMETROS.repeticiones; rep++) {
          const orden = variantesDe(c);
          for (const v of rep % 2 === 0 ? orden.reverse() : orden) corridas.push(await corrida(hijo, l, op, v, c, PARAMETROS.concurrencia, rep));
        }
        console.log(`  concurrencia ${op} c=${String(c)}: listo`);
      }
    }

    const entorno = {
      etiqueta: a.entorno,
      fecha: new Date().toISOString(),
      cpu: cpus()[0]?.model.trim(),
      hilos: cpus().length,
      ramGiB: Math.round((totalmem() / 2 ** 30) * 10) / 10,
      sistema: `${type()} ${release()}`,
      node: process.version,
      grpcJs: (JSON.parse(readFileSync(path.join(RAIZ, 'node_modules', '@grpc', 'grpc-js', 'package.json'), 'utf8')) as { version: string }).version,
      cargaInicial,
      umbral: UMBRAL,
      forzado: a.forzar,
      rapido: a.rapido,
    };
    const previo = existsSync(SALIDA_JSON) ? (JSON.parse(readFileSync(SALIDA_JSON, 'utf8')) as { corridas?: Record<string, unknown> }) : {};
    const datos = { ...previo, corridas: { ...previo.corridas, [a.entorno]: { entorno, parametros: PARAMETROS, tamanos, serie, concurrencia: corridas } } };
    writeFileSync(SALIDA_JSON, `${JSON.stringify(datos, null, 1)}\n`);
    writeFileSync(SALIDA_MD, generarInforme(datos as Parameters<typeof generarInforme>[0]));
    console.log(`Escritos ${path.relative(RAIZ, SALIDA_JSON)} y ${path.relative(RAIZ, SALIDA_MD)}.`);
  } finally {
    hijo.send({ tipo: 'cerrar' });
  }
}

try {
  await principal();
} catch (e) {
  if (e instanceof CargaAjena) {
    console.error(`NO SE MIDE: ${e.message}. No se escribió nada; cierra lo que esté usando la CPU y vuelve a correr.`);
    process.exit(4);
  }
  throw e;
}
