// Medición de almacenamiento de versiones (riesgo R-02, bloque R): cuánto ocupa en la base CADA versión
// de un documento, según su tamaño y su contenido, y si el límite de 30 por hora corta de verdad. Contra el
// API REAL y la base de PRUEBAS cuaderno_carga_test (recreada) con Redis db 2. Datos SOLO ficticios.
// Uso: npm run almacenamiento -- [--rapido] [--umbral 10] [--salida docs]
//
//   Por caso (tamaño × contenido): una cuenta nueva crea un espacio y un documento, escribe el texto por el
//   WebSocket (en trozos de 500 000 caracteres, por debajo del mensaje máximo de 1 MiB) y pide guardar
//   versión hasta que el límite responde 429. Se miden las columnas de esas versiones (pg_column_size y
//   octet_length), el crecimiento de la tabla (pg_total_relation_size) y los tiempos de guardar y verificar.
//   Los tamaños los lee el DUEÑO de la base de carga (solo lectura): cuaderno_app no ve pg_total_relation_size
//   de tablas ajenas en todos los casos.
import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { release, type } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import pg from 'pg';
import { hashearContrasena } from '../../src/auth/contrasenas.js';
import { crearSesion } from '../../src/auth/sesiones.js';
import { emitirAcceso } from '../../src/auth/tokens.js';
import { crearPool, crearPrisma } from '../../src/infra/bd.js';
import { LIMITES_VERSIONES } from '../../src/versiones/rutas.js';
import { medianaDeCorridas } from '../medicion/estadistica.js';
import { cargaCpu } from '../medicion/cpu.js';
import { BASE, ORIGEN, URL_WS, cerrarApi, entornoApi, levantarApi } from './api.js';
import { BASE_CARGA, conexiones, prepararBase } from './base.js';
import { ClienteCarga } from './cliente-ws.js';
import { generarInformeAlmacenamiento, type CasoAlmacenamiento, type DatosAlmacenamiento } from './informe-almacenamiento.js';

const RAIZ = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const { values: a } = parseArgs({
  options: {
    rapido: { type: 'boolean', default: false },
    umbral: { type: 'string', default: '10' },
    salida: { type: 'string', default: path.join(RAIZ, 'docs') },
  },
});
const UMBRAL = Number(a.umbral);
const TAMANOS = a.rapido ? [10_000] : [10_000, 1_000_000, 9_000_000];
const CONTENIDOS = ['repetitivo', 'aleatorio'] as const;
const TROZO = 500_000;

/** Texto ficticio: una frase repetida, o letras al azar (con semilla fija: el mismo en cada corrida). */
function texto(caracteres: number, contenido: CasoAlmacenamiento['contenido']): string {
  if (contenido === 'repetitivo') return 'Texto de documentación ficticio para medir. '.repeat(Math.ceil(caracteres / 44)).slice(0, caracteres);
  const letras = 'abcdefghijklmnopqrstuvwxyz      ';
  let s = 0x2545f491;
  const r: string[] = [];
  for (let i = 0; i < caracteres; i++) {
    s = (Math.imul(s, 1103515245) + 12345) >>> 0;
    r.push(letras[(s >>> 16) % letras.length] ?? 'a');
  }
  return r.join('');
}

async function principal(): Promise<void> {
  const cargaInicial = await cargaCpu(5000);
  console.log(`Carga de CPU de la máquina antes de empezar (5 s): ${String(cargaInicial)} %`);
  if (cargaInicial > UMBRAL) {
    console.error(`NO SE MIDE: la carga (${String(cargaInicial)} %) pasa del umbral (${String(UMBRAL)} %).`);
    process.exit(3);
  }
  const c = conexiones();
  await prepararBase(c);
  const claveAcceso = randomBytes(32);
  const api = await levantarApi(entornoApi(c, claveAcceso));
  const pool = crearPool(c.urlApp);
  const prisma = crearPrisma(pool);
  const dueno = new pg.Client({ ...c.dueno, database: BASE_CARGA });
  await dueno.connect();
  const tamano = async (sql: string, params: unknown[] = []) => Number((await dueno.query<{ b: string }>(sql, params)).rows[0]?.b ?? 0);
  const tabla = () => tamano(`SELECT pg_total_relation_size('versiones') AS b`);
  const baseAhora = () => tamano(`SELECT pg_database_size(current_database()) AS b`);
  try {
    const baseAntesBytes = await baseAhora();
    const hash = await hashearContrasena(randomBytes(12).toString('hex'), 10);
    const casos: CasoAlmacenamiento[] = [];
    for (const caracteres of TAMANOS) {
      for (const contenido of CONTENIDOS) {
        // Una cuenta por caso: cada una empieza con su límite entero.
        const correo = `almacen.${randomBytes(4).toString('hex')}@example.com`;
        const id = await prisma.$transaction(async (tx) => {
          const u = await tx.usuarios.create({ data: { correo, nombre: 'Persona Ficticia Almacén', rol: 'editor' }, select: { id: true } });
          await tx.usuarios.update({ where: { id: u.id }, data: { estado: 'activa', hash_contrasena: hash, activada_en: new Date() } });
          return u.id;
        });
        const sesion = await prisma.$transaction((tx) => crearSesion(tx, { usuarioId: id, ipRed: null, userAgent: 'almacenamiento' }));
        const auth = { authorization: `Bearer ${emitirAcceso(id, sesion.sesionId, claveAcceso).token}`, 'content-type': 'application/json' };
        const post = async (ruta: string, cuerpo: unknown) => fetch(`${BASE}/api${ruta}`, { method: 'POST', headers: auth, body: JSON.stringify(cuerpo) });
        const espacio = (await (await post('/espacios', { nombre: 'Espacio de almacenamiento' })).json()) as { id: string };
        const doc = (await (await post(`/espacios/${espacio.id}/documentos`, { titulo: 'Documento de almacenamiento' })).json()) as { id: string };

        const t = (await (await post('/tiempo-real/tickets', { documentoId: doc.id })).json()) as { ticket: string };
        const escritor = new ClienteCarga(URL_WS, t.ticket, ORIGEN, 'almacen');
        await escritor.sincronizado;
        const todo = texto(caracteres, contenido);
        for (let i = 0; i < todo.length; i += TROZO) {
          const yt = escritor.doc.getText('contenido');
          yt.insert(yt.length, todo.slice(i, i + TROZO));
          await new Promise((r) => setTimeout(r, 150)); // muy por debajo de 60 mensajes por segundo
        }
        // El servidor tiene el texto entero (en memoria: de ahí sale la versión).
        for (let i = 0; ; i++) {
          const r = (await (await fetch(`${BASE}/api/documentos/${doc.id}/texto`, { headers: auth })).json()) as { texto: string };
          if (r.texto.length === caracteres) break;
          if (i > 120) throw new Error(`el servidor no llegó a ${String(caracteres)} caracteres`);
          await new Promise((r2) => setTimeout(r2, 500));
        }
        escritor.cerrar();

        const tabla0 = await tabla();
        const respuestas: number[] = [];
        const ms: number[] = [];
        for (let i = 0; i <= LIMITES_VERSIONES.versiones.max; i++) {
          const t0 = performance.now();
          const r = await post(`/documentos/${doc.id}/versiones`, {});
          if (r.status === 201) ms.push(performance.now() - t0);
          respuestas.push(r.status);
          await r.arrayBuffer();
        }
        const tabla1 = await tabla();
        const columnas = (
          await dueno.query<{ n: string; estado: string; texto: string; crudo: string }>(
            `SELECT count(*) AS n, avg(pg_column_size(estado_yjs)) AS estado, avg(pg_column_size(contenido_texto)) AS texto,
                    avg(octet_length(estado_yjs) + octet_length(contenido_texto)) AS crudo
             FROM versiones WHERE documento_id = $1 AND motivo = 'manual'`,
            [doc.id],
          )
        ).rows[0];
        const guardadas = Number(columnas?.n ?? 0);
        const tv0 = performance.now();
        const v = await fetch(`${BASE}/api/documentos/${doc.id}/versiones/verificacion`, { headers: auth });
        const msVerificar = performance.now() - tv0;
        const verificacion = (await v.json()) as { integra: boolean };
        if (!verificacion.integra) throw new Error('la cadena no quedó íntegra');
        const m = medianaDeCorridas(ms);
        casos.push({
          caracteres,
          contenido,
          respuestas,
          versionesGuardadas: guardadas,
          bytesEstadoPorVersion: Math.round(Number(columnas?.estado ?? 0)),
          bytesTextoPorVersion: Math.round(Number(columnas?.texto ?? 0)),
          bytesSinComprimirPorVersion: Math.round(Number(columnas?.crudo ?? 0)),
          bytesTablaPorVersion: guardadas ? Math.round((tabla1 - tabla0) / guardadas) : 0,
          msGuardarMediana: m.mediana,
          msGuardarMax: m.max,
          msVerificar,
        });
        console.log(`  ${String(caracteres)} ${contenido}: ${String(guardadas)} versiones, respuestas ${[...new Set(respuestas)].join('/')}`);
      }
    }
    const datos: DatosAlmacenamiento = {
      entorno: {
        fecha: new Date().toISOString(),
        sistema: `${type()} ${release()}`,
        node: process.version,
        postgres: (await dueno.query<{ v: string }>(`SELECT current_setting('server_version') AS v`)).rows[0]?.v ?? '?',
        cargaInicial,
      },
      rapido: a.rapido,
      limite: { ...LIMITES_VERSIONES.versiones },
      casos,
      baseAntesBytes,
      baseDespuesBytes: await baseAhora(),
    };
    const json = path.join(a.salida, 'almacenamiento-r.json');
    const md = path.join(a.salida, 'almacenamiento-r.md');
    writeFileSync(json, `${JSON.stringify(datos, null, 1)}\n`);
    writeFileSync(md, generarInformeAlmacenamiento(datos));
    console.log(`Escritos ${json} y ${md}.`);
  } finally {
    await dueno.end();
    await prisma.$disconnect();
    await pool.end();
    await cerrarApi(api);
  }
}

await principal();
