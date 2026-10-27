// Pruebas de carga del bloque R (decisiones escritas): HTTP con autocannon y WebSocket con un generador
// propio (ws + Yjs), contra el API REAL (dist/servidor.js) en un proceso aparte, con una base de pruebas
// propia (cuaderno_carga_test, recreada cada vez) y Redis db 2. Datos SOLO ficticios.
// Uso: npm run carga -- [--rapido] [--entorno windows|linux] [--umbral 10] [--forzar] [--escenarios H1,W1]
//
//   1. Carga de CPU de la máquina ANTES de empezar: si pasa del umbral (10 %), no mide. Se vuelve a medir
//      antes de CADA corrida: si sigue alta tras esperar, se aborta todo SIN escribir nada (no se mezclan
//      datos con carga ajena).
//   2. HTTP: H1 GET /health; H2 GET /api/espacios con sesión; H3 GET /api/documentos/:id/texto;
//      H4 login bajo carga (el límite responde 429) con una sonda de H2 a la vez, comparada con la sonda sola.
//      10, 50 y 100 conexiones, 30 s, 3 repeticiones, 5 s de calentamiento.
//   3. WebSocket: W1 N = 10, 50 y 100 clientes en un documento; W2 20 documentos con 5 clientes cada uno;
//      a 2 y 5 cambios por segundo por cliente, 30 s, 3 repeticiones. Latencia de ida y vuelta por el
//      servidor, pérdida, convergencia (con el servidor), cierres, CPU y memoria, filas insertadas.
//   4. Escribe docs/carga-r.json (crudo, por entorno) y genera docs/carga-r.md.
import { fork, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release, totalmem, type } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import autocannon from 'autocannon';
import { Redis } from 'ioredis';
import { hashearContrasena } from '../../src/auth/contrasenas.js';
import { crearSesion } from '../../src/auth/sesiones.js';
import { emitirAcceso } from '../../src/auth/tokens.js';
import { COSTO_HASH_MINIMO_PRODUCCION } from '../../src/config/entorno.js';
import { crearPool, crearPrisma } from '../../src/infra/bd.js';
import { cargaCpu } from '../medicion/cpu.js';
import { BASE_CARGA, conexiones, prepararBase } from './base.js';
import { ClienteCarga, ahoraNs } from './cliente-ws.js';
import { resumirHttp, resumirWs, type HuellaCliente, type ResultadoGenerador } from './contabilidad.js';
import { generarInformeCarga } from './informe-carga.js';
import type { CorridaHttp, CorridaLogin, CorridaWs, DatosCarga } from './tipos.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values: a } = parseArgs({
  options: {
    rapido: { type: 'boolean', default: false },
    entorno: { type: 'string', default: platform() === 'win32' ? 'windows' : 'linux' },
    umbral: { type: 'string', default: '10' },
    forzar: { type: 'boolean', default: false },
    escenarios: { type: 'string', default: 'H1,H2,H3,H4,W1,W2' },
    salida: { type: 'string', default: path.join(RAIZ, 'docs') },
  },
});
const SALIDA_JSON = path.join(a.salida, 'carga-r.json');
const SALIDA_MD = path.join(a.salida, 'carga-r.md');
const UMBRAL = Number(a.umbral);
const ESCENARIOS = new Set(a.escenarios.split(','));

const PARAMETROS = a.rapido
  ? { conexiones: [10], duracionS: 3, calentamientoS: 1, repeticiones: 1, sondaSolaS: 2, clientesW1: [10], tasas: [2], documentosW2: 4, clientesPorDocumentoW2: 5, esperaFinalMs: 1500 }
  : { conexiones: [10, 50, 100], duracionS: 30, calentamientoS: 5, repeticiones: 3, sondaSolaS: 10, clientesW1: [10, 50, 100], tasas: [2, 5], documentosW2: 20, clientesPorDocumentoW2: 5, esperaFinalMs: 3000 };

const PUERTO = 4290;
const BASE = `http://127.0.0.1:${String(PUERTO)}`;
const ORIGEN = 'http://127.0.0.1:5175';
const URL_WS = `ws://127.0.0.1:${String(PUERTO)}/api/tiempo-real`;
const ESPERAS_MAXIMAS = 12;

class CargaAjena extends Error {
  constructor(carga: number, donde: string) {
    super(`carga de CPU ajena persistente (${String(carga)} % > ${String(UMBRAL)} %) antes de ${donde}`);
    this.name = 'CargaAjena';
  }
}

/** Espera a que la carga de la máquina baje del umbral; si no baja, aborta todo. */
async function cargaPrevia(donde: string): Promise<{ carga: number; esperas: number }> {
  let carga = await cargaCpu(1000);
  let esperas = 0;
  while (carga > UMBRAL && !a.forzar) {
    if (++esperas > ESPERAS_MAXIMAS) throw new CargaAjena(carga, donde);
    await new Promise((r) => setTimeout(r, 4000));
    carga = await cargaCpu(1000);
  }
  return { carga, esperas };
}

// ─── El API ─────────────────────────────────────────────────────────────────────

interface Uso {
  cpu: NodeJS.CpuUsage;
  rss: number;
}

function pedirUso(api: ChildProcess): Promise<Uso> {
  return new Promise((resolver) => {
    const f = (m: { tipo: string } & Uso) => {
      if (m.tipo !== 'uso') return;
      api.off('message', f);
      resolver(m);
    };
    api.on('message', f);
    api.send({ tipo: 'uso' });
  });
}

/** Mide el API durante `ms`: CPU (en % de UN núcleo) y memoria residente máxima (muestras cada 500 ms). */
async function medirApi<T>(api: ChildProcess, f: () => Promise<T>): Promise<{ valor: T; cpuServidorPct: number; rssMaxMiB: number }> {
  const u0 = await pedirUso(api);
  const t0 = Date.now();
  let rssMax = u0.rss;
  const estado = { seguir: true };
  const muestras = (async () => {
    while (estado.seguir) {
      await new Promise((r) => setTimeout(r, 500));
      rssMax = Math.max(rssMax, (await pedirUso(api)).rss);
    }
  })();
  const valor = await f();
  estado.seguir = false;
  await muestras;
  const u1 = await pedirUso(api);
  const cpuMs = (u1.cpu.user - u0.cpu.user + u1.cpu.system - u0.cpu.system) / 1000;
  return { valor, cpuServidorPct: Math.round((cpuMs / (Date.now() - t0)) * 1000) / 10, rssMaxMiB: Math.round((Math.max(rssMax, u1.rss) / 2 ** 20) * 10) / 10 };
}

async function levantarApi(entornoApi: Record<string, string>): Promise<ChildProcess> {
  const api = fork(path.join(RAIZ, 'scripts', 'carga', 'proceso-api.ts'), [], { execArgv: ['--import', 'tsx'], env: entornoApi, stdio: 'inherit' });
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(`${BASE}/health`)).ok) return api;
    } catch {
      // todavía no escucha
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  api.kill();
  throw new Error('el API no respondió /health en 30 s');
}

// ─── Datos ficticios ────────────────────────────────────────────────────────────

interface Cuenta {
  id: string;
  correo: string;
  sesionId: string;
}

async function sembrar(urlApp: string, claveAcceso: Buffer, contrasenaLogin: string) {
  const pool = crearPool(urlApp);
  const prisma = crearPrisma(pool);
  const hashRapido = await hashearContrasena(randomBytes(12).toString('hex'), 10);
  const cuenta = async (n: string, hash: string): Promise<Cuenta> => {
    const correo = `${n}.${randomBytes(4).toString('hex')}@example.com`;
    const id = await prisma.$transaction(async (tx) => {
      const u = await tx.usuarios.create({ data: { correo, nombre: `Persona Ficticia ${n}`, rol: 'editor' }, select: { id: true } });
      await tx.usuarios.update({ where: { id: u.id }, data: { estado: 'activa', hash_contrasena: hash, activada_en: new Date() } });
      return u.id;
    });
    const s = await prisma.$transaction((tx) => crearSesion(tx, { usuarioId: id, ipRed: null, userAgent: 'carga' }));
    return { id, correo, sesionId: s.sesionId };
  };
  const duena = await cuenta('duena', hashRapido);
  // La del login (H4) con el costo de PRODUCCIÓN: es lo que verifica el servidor en cada inicio de sesión.
  const login = await cuenta('login', await hashearContrasena(contrasenaLogin, COSTO_HASH_MINIMO_PRODUCCION));
  const clientes: Cuenta[] = [];
  for (let i = 0; i < 100; i++) clientes.push(await cuenta(`cliente${String(i)}`, hashRapido));
  const token = (c: Cuenta) => emitirAcceso(c.id, c.sesionId, claveAcceso).token;

  const post = async (ruta: string, cuerpo: unknown, c: Cuenta) => {
    const r = await fetch(`${BASE}/api${ruta}`, { method: 'POST', headers: { authorization: `Bearer ${token(c)}`, 'content-type': 'application/json' }, body: JSON.stringify(cuerpo) });
    if (!r.ok) throw new Error(`POST ${ruta}: ${String(r.status)}`);
    return (await r.json()) as { id: string };
  };
  // Espacios y documentos por el API (como los crearía una persona).
  const e1 = await post('/espacios', { nombre: 'Equipo de carga uno' }, duena);
  const e2 = await post('/espacios', { nombre: 'Equipo de carga dos' }, duena);
  const docW1 = await post(`/espacios/${e1.id}/documentos`, { titulo: 'Documento W1' }, duena);
  const docH3 = await post(`/espacios/${e1.id}/documentos`, { titulo: 'Documento H3' }, duena);
  const docsW2: string[] = [];
  for (let i = 0; i < PARAMETROS.documentosW2; i++) docsW2.push((await post(`/espacios/${e2.id}/documentos`, { titulo: `Documento W2 ${String(i + 1)}` }, duena)).id);
  // Los 100 miembros directo en la base, como cuaderno_app (el API limita agregar miembros a 30 cada 15
  // minutos por cuenta); los triggers de la base validan igual el rol y la cuenta activa.
  for (const esp of [e1.id, e2.id]) {
    for (const c of clientes) await prisma.$executeRaw`INSERT INTO miembros_espacio (espacio_id, usuario_id, rol) VALUES (${esp}::uuid, ${c.id}::uuid, 'editor')`;
  }
  // H3: un documento con 10 000 caracteres de texto, escrito por el WebSocket.
  const escritor = new ClienteCarga(URL_WS, await ticket(duena, docH3.id, token), ORIGEN, 'siembra');
  await escritor.sincronizado;
  escritor.doc.getText('contenido').insert(0, 'Texto de carga ficticio. '.repeat(400));
  await new Promise((r) => setTimeout(r, 1000));
  escritor.cerrar();

  return {
    prisma,
    pool,
    duena,
    login,
    clientes,
    token,
    documentos: { w1: docW1.id, h3: docH3.id, w2: docsW2 },
    cerrar: async () => {
      await prisma.$disconnect();
      await pool.end();
    },
  };
}

async function ticket(c: Cuenta, documentoId: string, token: (c: Cuenta) => string): Promise<string> {
  const r = await fetch(`${BASE}/api/tiempo-real/tickets`, { method: 'POST', headers: { authorization: `Bearer ${token(c)}`, 'content-type': 'application/json' }, body: JSON.stringify({ documentoId }) });
  if (r.status !== 201) throw new Error(`ticket: ${String(r.status)}`);
  return ((await r.json()) as { ticket: string }).ticket;
}

type Siembra = Awaited<ReturnType<typeof sembrar>>;

// ─── HTTP ───────────────────────────────────────────────────────────────────────

function pedidoHttp(escenario: CorridaHttp['escenario'], s: Siembra) {
  if (escenario === 'H1') return { url: `${BASE}/health` };
  const headers = { authorization: `Bearer ${s.token(s.duena)}` };
  if (escenario === 'H2') return { url: `${BASE}/api/espacios`, headers };
  return { url: `${BASE}/api/documentos/${s.documentos.h3}/texto`, headers };
}

async function corridaHttp(api: ChildProcess, s: Siembra, escenario: CorridaHttp['escenario'], c: number, repeticion: number): Promise<CorridaHttp> {
  const p = pedidoHttp(escenario, s); // token nuevo en cada corrida (vence a los 15 minutos)
  await autocannon({ ...p, connections: c, duration: PARAMETROS.calentamientoS });
  const { carga, esperas } = await cargaPrevia(`${escenario} c=${String(c)}`);
  const cliente0 = process.cpuUsage();
  const t0 = Date.now();
  const m = await medirApi(api, () => autocannon({ ...p, connections: c, duration: PARAMETROS.duracionS }));
  const cpuCliente = process.cpuUsage(cliente0);
  return {
    escenario,
    conexiones: c,
    repeticion,
    cargaPrevia: carga,
    esperasPorCarga: esperas,
    resultado: resumirHttp(m.valor),
    cpuServidorPct: m.cpuServidorPct,
    cpuClientePct: Math.round(((cpuCliente.user + cpuCliente.system) / 1000 / (Date.now() - t0)) * 1000) / 10,
    rssMaxMiB: m.rssMaxMiB,
  };
}

/** Borra SOLO las claves del límite de inicio de sesión: cada corrida de H4 empieza con el límite entero. */
async function reiniciarLimiteLogin(urlRedis: string): Promise<void> {
  const redis = new Redis(urlRedis, { maxRetriesPerRequest: 1 });
  try {
    let cursor = '0';
    do {
      const [siguiente, claves] = await redis.scan(cursor, 'MATCH', 'cuaderno:rl:inicio:*', 'COUNT', 100);
      if (claves.length) await redis.del(...claves);
      cursor = siguiente;
    } while (cursor !== '0');
  } finally {
    redis.disconnect();
  }
}

async function corridaLogin(api: ChildProcess, s: Siembra, contrasena: string, urlRedis: string, c: number, repeticion: number): Promise<CorridaLogin> {
  const sonda = () => ({ url: `${BASE}/api/espacios`, headers: { authorization: `Bearer ${s.token(s.duena)}` }, connections: 1 });
  await reiniciarLimiteLogin(urlRedis);
  const { carga, esperas } = await cargaPrevia(`H4 c=${String(c)}`);
  const sondaSola = resumirHttp(await autocannon({ ...sonda(), duration: PARAMETROS.sondaSolaS }));
  const m = await medirApi(api, () =>
    Promise.all([
      autocannon({
        url: `${BASE}/api/auth/sesion`,
        method: 'POST',
        headers: { 'content-type': 'application/json', origin: ORIGEN },
        body: JSON.stringify({ correo: s.login.correo, contrasena }),
        connections: c,
        duration: PARAMETROS.duracionS,
      }),
      autocannon({ ...sonda(), duration: PARAMETROS.duracionS }),
    ]),
  );
  return {
    conexiones: c,
    repeticion,
    cargaPrevia: carga,
    esperasPorCarga: esperas,
    login: resumirHttp(m.valor[0]),
    sondaSola,
    sondaConLogin: resumirHttp(m.valor[1]),
    cpuServidorPct: m.cpuServidorPct,
    rssMaxMiB: m.rssMaxMiB,
  };
}

// ─── WebSocket ──────────────────────────────────────────────────────────────────

function esperar<T>(hijo: ChildProcess, tipo: string): Promise<T> {
  return new Promise((resolver, rechazar) => {
    const f = (m: { tipo: string; mensaje?: string } & T) => {
      if (m.tipo === 'error') {
        hijo.off('message', f);
        rechazar(new Error(m.mensaje));
      } else if (m.tipo === tipo) {
        hijo.off('message', f);
        resolver(m);
      }
    };
    hijo.on('message', f);
  });
}

/** Filas insertadas en actualizaciones_documento (contador acumulado de la base; la compactación no lo baja). */
async function insertadas(s: Siembra): Promise<number> {
  const f = await s.prisma.$queryRaw<{ n: bigint }[]>`SELECT n_tup_ins AS n FROM pg_stat_user_tables WHERE relname = 'actualizaciones_documento'`;
  return Number(f[0]?.n ?? 0);
}

async function corridaWs(api: ChildProcess, s: Siembra, escenario: 'W1' | 'W2', grupos: { documento: string; cuentas: Cuenta[] }[], tasa: number, repeticion: number): Promise<CorridaWs> {
  const todos = grupos.flatMap((g) => g.cuentas.map((c, i) => ({ documento: g.documento, cuenta: c, clave: `${g.documento.slice(0, 8)}-${String(i)}` })));
  const nGeneradores = Math.min(4, Math.ceil(todos.length / 25));
  const generadores = Array.from({ length: nGeneradores }, () =>
    fork(path.join(RAIZ, 'scripts', 'carga', 'generador-ws.ts'), [], { execArgv: ['--import', 'tsx'], serialization: 'advanced', stdio: 'inherit' }),
  );
  try {
    const conTicket: ((typeof todos)[number] & { ticket: string })[] = [];
    for (const t of todos) conTicket.push({ ...t, ticket: await ticket(t.cuenta, t.documento, s.token) });
    await Promise.all(
      generadores.map((g, k) => {
        const listo = esperar(g, 'conectados');
        g.send({ tipo: 'conectar', url: URL_WS, origen: ORIGEN, clientes: conTicket.filter((_x, i) => i % nGeneradores === k).map((x) => ({ clave: x.clave, ticket: x.ticket })) });
        return listo;
      }),
    );
    const { carga, esperas } = await cargaPrevia(`${escenario} n=${String(todos.length)} tasa=${String(tasa)}`);
    const filas0 = await insertadas(s);
    const arranque = ahoraNs() + 500_000_000n;
    const inicio = arranque + BigInt(PARAMETROS.calentamientoS) * 1_000_000_000n;
    const fin = inicio + BigInt(PARAMETROS.duracionS) * 1_000_000_000n;
    for (const g of generadores) g.send({ tipo: 'correr', arranqueNs: String(arranque), inicioNs: String(inicio), finNs: String(fin), tasa });
    // El API se mide solo dentro de la ventana.
    await new Promise((r) => setTimeout(r, Number(inicio - ahoraNs()) / 1e6));
    const m = await medirApi(api, () => new Promise((r) => setTimeout(r, Number(fin - ahoraNs()) / 1e6)));
    const resultados = await Promise.all(
      generadores.map((g) => {
        const r = esperar<ResultadoGenerador & { huellas: (Omit<HuellaCliente, 'documento'> & { enviados: number })[]; cpu: NodeJS.CpuUsage }>(g, 'resultado');
        g.send({ tipo: 'resultado', esperaMs: PARAMETROS.esperaFinalMs });
        return r;
      }),
    );
    await new Promise((r) => setTimeout(r, 2000)); // las estadísticas de la base se publican con algo de demora
    const filas = (await insertadas(s)) - filas0;
    const docDe = new Map(todos.map((t) => [t.clave, t.documento]));
    const huellas = resultados.flatMap((r) => r.huellas.map((h) => ({ ...h, documento: docDe.get(h.clave) ?? '' })));
    const porDocumento = grupos.map((g) => ({
      documento: g.documento,
      clientes: g.cuentas.length,
      enviados: huellas.filter((h) => h.documento === g.documento).reduce((n, h) => n + h.enviados, 0),
    }));
    const servidor: Record<string, number> = {};
    for (const g of grupos) {
      const r = await fetch(`${BASE}/api/documentos/${g.documento}/texto`, { headers: { authorization: `Bearer ${s.token(s.duena)}` } });
      servidor[g.documento] = ((await r.json()) as { texto: string }).texto.length;
    }
    const resumen = resumirWs(resultados, porDocumento, huellas, servidor);
    const cpuGen = resultados.reduce((n, r) => n + (r.cpu.user + r.cpu.system) / 1000, 0);
    return {
      escenario,
      documentos: grupos.length,
      clientes: todos.length,
      tasa,
      repeticion,
      generadores: nGeneradores,
      cargaPrevia: carga,
      esperasPorCarga: esperas,
      resultado: resumen,
      cambiosPorSegundo: Math.round(resumen.enviados / PARAMETROS.duracionS),
      entregasPorSegundo: Math.round(resumen.recibidos / PARAMETROS.duracionS),
      filasInsertadas: filas,
      cpuServidorPct: m.cpuServidorPct,
      // CPU de los generadores desde el arranque (calentamiento incluido), en % de UN núcleo.
      cpuGeneradoresPct: Math.round((cpuGen / ((PARAMETROS.calentamientoS + PARAMETROS.duracionS) * 1000 + 500 + PARAMETROS.esperaFinalMs)) * 1000) / 10,
      rssMaxMiB: m.rssMaxMiB,
    };
  } finally {
    for (const g of generadores) g.kill();
  }
}

// ─── Principal ──────────────────────────────────────────────────────────────────

async function principal(): Promise<void> {
  const cargaInicial = await cargaCpu(5000);
  console.log(`Carga de CPU de la máquina antes de empezar (5 s): ${String(cargaInicial)} %`);
  if (cargaInicial > UMBRAL && !a.forzar) {
    console.error(`NO SE MIDE: la carga (${String(cargaInicial)} %) pasa del umbral (${String(UMBRAL)} %). Cierra otros programas.`);
    process.exit(3);
  }
  const c = conexiones();
  await prepararBase(c);
  console.log(`Base ${BASE_CARGA} recreada y migrada; Redis db 2 vacía.`);

  const claveAcceso = randomBytes(32);
  const contrasenaLogin = `clave-de-carga-${randomBytes(6).toString('hex')}`;
  const entornoApi: Record<string, string> = {
    PATH: process.env.PATH ?? '',
    ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
    TZ: 'UTC',
    NODE_ENV: 'development',
    HOST: '127.0.0.1',
    PORT: String(PUERTO),
    LOG_LEVEL: 'warn',
    DATABASE_URL: c.urlApp,
    REDIS_URL: c.urlRedis,
    ACCESS_TOKEN_SECRET: claveAcceso.toString('base64'),
    MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    METRICS_TOKEN: randomBytes(32).toString('base64url'),
    APP_URL: ORIGEN,
    COOKIE_SECURE: 'true',
    TRUST_PROXY: 'false',
    AI_PROVIDER: 'mock',
    EMAIL_PROVIDER: 'mock',
    GEO_PROVIDER: 'mock',
    PASSWORD_HASH_COST: String(COSTO_HASH_MINIMO_PRODUCCION),
  };
  const api = await levantarApi(entornoApi);
  let s: Siembra | undefined;
  try {
    s = await sembrar(c.urlApp, claveAcceso, contrasenaLogin);
    console.log('Datos ficticios sembrados (102 cuentas, 2 espacios, documentos de W1, H3 y W2).');
    const http: CorridaHttp[] = [];
    for (const e of ['H1', 'H2', 'H3'] as const) {
      if (!ESCENARIOS.has(e)) continue;
      for (let rep = 1; rep <= PARAMETROS.repeticiones; rep++) {
        const orden = rep % 2 === 0 ? [...PARAMETROS.conexiones].reverse() : PARAMETROS.conexiones;
        for (const n of orden) http.push(await corridaHttp(api, s, e, n, rep));
      }
      console.log(`  ${e}: listo`);
    }
    const login: CorridaLogin[] = [];
    if (ESCENARIOS.has('H4')) {
      for (let rep = 1; rep <= PARAMETROS.repeticiones; rep++) {
        const orden = rep % 2 === 0 ? [...PARAMETROS.conexiones].reverse() : PARAMETROS.conexiones;
        for (const n of orden) login.push(await corridaLogin(api, s, contrasenaLogin, c.urlRedis, n, rep));
      }
      console.log('  H4: listo');
    }
    const ws: CorridaWs[] = [];
    const sm = s;
    if (ESCENARIOS.has('W1')) {
      for (const n of PARAMETROS.clientesW1) {
        for (const tasa of PARAMETROS.tasas) {
          for (let rep = 1; rep <= PARAMETROS.repeticiones; rep++) ws.push(await corridaWs(api, sm, 'W1', [{ documento: sm.documentos.w1, cuentas: sm.clientes.slice(0, n) }], tasa, rep));
          console.log(`  W1 n=${String(n)} tasa=${String(tasa)}: listo`);
        }
      }
    }
    if (ESCENARIOS.has('W2')) {
      const grupos = sm.documentos.w2.map((d, i) => ({ documento: d, cuentas: sm.clientes.slice(i * PARAMETROS.clientesPorDocumentoW2, (i + 1) * PARAMETROS.clientesPorDocumentoW2) }));
      for (const tasa of PARAMETROS.tasas) {
        for (let rep = 1; rep <= PARAMETROS.repeticiones; rep++) ws.push(await corridaWs(api, sm, 'W2', grupos, tasa, rep));
        console.log(`  W2 tasa=${String(tasa)}: listo`);
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
      autocannon: (JSON.parse(readFileSync(path.join(RAIZ, 'node_modules', 'autocannon', 'package.json'), 'utf8')) as { version: string }).version,
      postgres: ((await sm.prisma.$queryRaw<{ v: string }[]>`SELECT current_setting('server_version') AS v`)[0]?.v ?? '?'),
      cargaInicial,
      umbral: UMBRAL,
      forzado: a.forzar,
      rapido: a.rapido,
    };
    const previo = existsSync(SALIDA_JSON) ? (JSON.parse(readFileSync(SALIDA_JSON, 'utf8')) as DatosCarga) : { corridas: {} };
    const datos: DatosCarga = { ...previo, corridas: { ...previo.corridas, [a.entorno]: { entorno, parametros: PARAMETROS, http, login, ws } } };
    writeFileSync(SALIDA_JSON, `${JSON.stringify(datos, null, 1)}\n`);
    writeFileSync(SALIDA_MD, generarInformeCarga(datos));
    console.log(`Escritos ${path.relative(RAIZ, SALIDA_JSON)} y ${path.relative(RAIZ, SALIDA_MD)}.`);
  } finally {
    await s?.cerrar();
    api.send({ tipo: 'cerrar' });
    await new Promise((r) => api.once('exit', r));
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
