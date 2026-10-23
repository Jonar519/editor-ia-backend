// Genera docs/medicion-p3.md a partir de docs/medicion-p3.json (lo llama medir.ts; no se edita a mano).
// Orden pedido: primero lo que la medición NO permite concluir, luego cómo se midió, el entorno y las
// tablas, y al final lo que los datos muestran CALCULADO (quién tuvo el menor p50 y cuánto), sin
// interpretación y sin ocultar los escenarios donde gRPC no gana.
import type { Corrida } from './medir.js';
import type { Resumen } from './estadistica.js';
import { medianaDeCorridas } from './estadistica.js';

interface DatosEntorno {
  entorno: Record<string, unknown> & { etiqueta: string; cargaInicial: number; umbral: number; forzado: boolean; rapido: boolean };
  parametros: { calentamiento: number; serie: number; concurrencia: number; concurrencias: number[]; repeticiones: number };
  tamanos: Record<string, { cuerpo: { protobuf: { pedido: number; respuesta: number }; json: { pedido: number; respuesta: number } }; cable: Record<string, { pedido: number; respuesta: number }> }>;
  serie: Corrida[];
  concurrencia: Corrida[];
}

export interface DatosMedicion {
  corridas: Record<string, DatosEntorno>;
}

const OPS: Record<string, string> = {
  U1: 'U1 · EmbeberConsulta (respuesta: vector denso de 1024 floats)',
  'U2-100B': 'U2 · Explicar, pedido de 100 B',
  'U2-8KB': 'U2 · Explicar, pedido de 8 KB',
  'U2-64KB': 'U2 · Explicar, pedido de 64 KB',
  S1: 'S1 · Resumir en streaming (pedido de 8 KB, 31 fragmentos)',
};

const VARIANTES: Record<string, string> = {
  'grpc-1-canal': 'A · gRPC, 1 canal',
  'grpc-c-canales': 'A* · gRPC, c canales',
  'h1-c-conexiones': 'B · REST 1.1, c conexiones',
  'h1-1-conexion': 'B1 · REST 1.1, 1 conexión',
  'h2-1-sesion': 'C · REST h2c, 1 sesión',
};

const num = (x: number, d = 3) => x.toLocaleString('es-ES', { minimumFractionDigits: d, maximumFractionDigits: d, useGrouping: false });
const ent = (x: number) => Math.round(x).toLocaleString('es-ES', { useGrouping: false });

interface Grupo {
  variante: string;
  p50: { mediana: number; min: number; max: number };
  p95: number;
  p99: number;
  max: number;
  rps: number;
  cpuC: number;
  cpuS: number;
  primero?: number;
  cargaMax: number;
}

/** Junta las repeticiones de cada variante: mediana de cada métrica y rango del p50. */
function agrupar(corridas: Corrida[]): Grupo[] {
  const por = new Map<string, Corrida[]>();
  for (const c of corridas) por.set(c.variante, [...(por.get(c.variante) ?? []), c]);
  const med = (cs: Corrida[], f: (c: Corrida) => number) => medianaDeCorridas(cs.map(f)).mediana;
  return [...por.entries()]
    .sort(([a], [b]) => Object.keys(VARIANTES).indexOf(a) - Object.keys(VARIANTES).indexOf(b))
    .map(([variante, cs]) => ({
      variante,
      p50: medianaDeCorridas(cs.map((c) => c.latencia.p50)),
      p95: med(cs, (c) => c.latencia.p95),
      p99: med(cs, (c) => c.latencia.p99),
      max: med(cs, (c) => c.latencia.max),
      rps: med(cs, (c) => c.pedidosPorSegundo),
      cpuC: med(cs, (c) => c.cpuClienteMsPorMil),
      cpuS: med(cs, (c) => c.cpuServidorMsPorMil),
      ...(cs[0]?.primerFragmento ? { primero: med(cs, (c) => (c.primerFragmento as Resumen).p50) } : {}),
      cargaMax: Math.max(...cs.map((c) => c.cargaPrevia)),
    }));
}

function tabla(grupos: Grupo[], conRps: boolean): string {
  const s1 = grupos.some((g) => g.primero !== undefined);
  const cab = ['Camino', ...(conRps ? ['ped/s'] : []), 'p50 ms (rango)', 'p95 ms', 'p99 ms', 'máx ms', ...(s1 ? ['1.er fragmento p50 ms'] : []), 'CPU cliente ms/1000', 'CPU servidor ms/1000'];
  const filas = grupos.map((g) => [
    VARIANTES[g.variante] ?? g.variante,
    ...(conRps ? [ent(g.rps)] : []),
    `${num(g.p50.mediana)} (${num(g.p50.min)}–${num(g.p50.max)})`,
    num(g.p95),
    num(g.p99),
    num(g.max),
    ...(s1 ? [g.primero === undefined ? '' : num(g.primero)] : []),
    num(g.cpuC, 1),
    num(g.cpuS, 1),
  ]);
  return [`| ${cab.join(' | ')} |`, `|${cab.map(() => '---').join('|')}|`, ...filas.map((f) => `| ${f.join(' | ')} |`)].join('\n');
}

/** Lo que los datos muestran, CALCULADO: el menor p50 y el mayor throughput, y cuánto más tardan los demás. */
function hechos(nombre: string, grupos: Grupo[], conRps: boolean): { linea: string; grpcNoGana: string | null } {
  const porP50 = [...grupos].sort((a, b) => a.p50.mediana - b.p50.mediana);
  const mejor = porP50[0];
  if (!mejor) return { linea: '', grpcNoGana: null };
  const resto = porP50.slice(1).map((g) => `${VARIANTES[g.variante] ?? g.variante} ×${num(g.p50.mediana / mejor.p50.mediana, 2)}`);
  let linea = `- **${nombre}**: menor p50 → ${VARIANTES[mejor.variante] ?? mejor.variante} (${num(mejor.p50.mediana)} ms); los demás: ${resto.join(', ')}.`;
  if (conRps) {
    const mas = [...grupos].sort((a, b) => b.rps - a.rps)[0];
    if (mas) linea += ` Mayor throughput → ${VARIANTES[mas.variante] ?? mas.variante} (${ent(mas.rps)} ped/s).`;
  }
  // ¿Se solapan los rangos del p50 del mejor y del segundo? Entonces la diferencia no es concluyente.
  const segundo = porP50[1];
  if (segundo && segundo.p50.min <= mejor.p50.max) linea += ' (Los rangos del p50 de los dos primeros se solapan entre repeticiones: diferencia no concluyente.)';
  const grpc = grupos.find((g) => g.variante === 'grpc-1-canal');
  const grpcNoGana = grpc && mejor.variante !== 'grpc-1-canal' && mejor.variante !== 'grpc-c-canales' ? `${nombre}: ganó ${VARIANTES[mejor.variante] ?? mejor.variante} (gRPC 1 canal ×${num(grpc.p50.mediana / mejor.p50.mediana, 2)})` : null;
  return { linea, grpcNoGana };
}

export function generarInforme(d: DatosMedicion): string {
  const e: string[] = [];
  e.push('# Medición P3 · gRPC frente a REST/JSON (enlace API ↔ servicio de IA)');
  e.push('');
  e.push('> Generado por `scripts/medicion/medir.ts` (`npm run medir`) a partir de `docs/medicion-p3.json`. No se edita a mano.');
  e.push('');
  e.push('## Lo que esta medición NO permite concluir');
  e.push('');
  e.push('- **Nada sobre la latencia que vería la persona.** El proveedor es el simulado, que responde sin esperas (0 ms): un modelo real tarda cientos de milisegundos o segundos, órdenes de magnitud más que cualquier diferencia de transporte de aquí. *No medido: la latencia de un proveedor real.*');
  e.push('- **Nada sobre una red real.** Todo va por loopback (127.0.0.1): sin latencia de red, sin pérdida de paquetes, sin ancho de banda limitado. *No medido: red real, varias máquinas, balanceadores o proxies.*');
  e.push('- **Nada sobre TLS.** Los dos caminos van en texto plano (gRPC inseguro, HTTP/1.1 y h2c). *No medido: el costo de TLS (mutuo o no).*');
  e.push('- **Nada sobre máquinas separadas.** Cliente y servidor corren en la misma máquina y compiten por la misma CPU.');
  e.push('- Tampoco: la compresión (ni la de gRPC ni gzip en JSON), la memoria a largo plazo, el costo del stack Express del API (se comparan transportes, no frameworks) ni el enlace navegador ↔ API. Todos *no medidos*.');
  e.push('- Los números son de **esta** máquina y de este momento; otra máquina da otros números. Las conclusiones de abajo son solo las que los datos de esta tabla muestran.');
  e.push('- **La corrida de Windows no sirve para comparar transportes** (ver el diagnóstico que sigue): se presenta solo como comportamiento observado en este entorno. **La referencia para comparar transportes es la corrida de Linux.**');
  e.push('');
  e.push('## Diagnóstico del entorno: piso de latencia en Windows');
  e.push('');
  e.push('Antes de medir, un diagnóstico aparte (2 000 llamadas en serie, tres pasadas, servidor en otro proceso) encontró en **Windows** un piso de unos 2–3 ms por llamada en gRPC con mensajes chicos y en REST sobre HTTP/1.1, que **no aparece en Linux** en la misma máquina (contenedor). No es calentamiento (las tres pasadas daban lo mismo) ni se debe a `noDelay` en los sockets del cliente. **Su causa no se investigó** (decisión escrita): corregirlo exigiría cambiar la configuración TCP del sistema. Mientras exista, en Windows esos caminos miden sobre todo ese piso y no el transporte.');
  e.push('');
  e.push('Los p50 en serie de **esta** medición, por tamaño de pedido (mediana de las repeticiones, ms):');
  e.push('');
  e.push('| Entorno | Camino | Explicar 100 B | Explicar 8 KB | Explicar 64 KB |');
  e.push('|---|---|---|---|---|');
  for (const [etiqueta, x] of Object.entries(d.corridas)) {
    for (const v of ['grpc-1-canal', 'h1-c-conexiones', 'h2-1-sesion']) {
      const p = (op: string) => {
        const g = agrupar(x.serie.filter((c) => c.operacion === op && c.variante === v))[0];
        return g ? num(g.p50.mediana) : '—';
      };
      e.push(`| ${etiqueta} | ${VARIANTES[v] ?? v} | ${p('U2-100B')} | ${p('U2-8KB')} | ${p('U2-64KB')} |`);
    }
  }
  e.push('');
  e.push('## Cómo se midió');
  e.push('');
  e.push('- **La misma operación por los dos caminos, en el mismo proceso servidor.** El gRPC es el servicio real (`crearServicioIa`, con su interceptor de token). El REST/JSON es **un adaptador que vive en `scripts/medicion/` (no en el servicio de producción) y corre en el mismo proceso que el gRPC real, sobre `node:http` (HTTP/1.1) y `node:http2` (h2c), sin Express**. Llama a las mismas funciones: `validarOrigen`, `texto`, el mismo proveedor y `verificarVectores`.');
  e.push('- **Mismo trabajo por pedido**: token Bearer comparado en tiempo constante, validación del origen y del contenido, log en `silent`, y un tiempo máximo por pedido en los tres clientes (como el deadline de gRPC).');
  e.push('- **Proveedor**: el simulado sin esperas, con **vectores densos** en U1 (las 1024 dimensiones distintas de cero, como los de un modelo real; los del simulado son dispersos y favorecerían a JSON, que escribe cada cero como `0`). Los vectores viajan como float de 32 bits en los dos caminos (protobuf `float`; en JSON, `Math.fround`).');
  e.push('- **Solo para medir**: el tope de caracteres de Explicar se sube a 70 000 para el pedido de 64 KB (en producción es 20 000).');
  e.push('- **Caminos**: A gRPC (HTTP/2 + protobuf, 1 canal); B REST sobre HTTP/1.1 keep-alive con *c* conexiones; C REST sobre HTTP/2 sin TLS con 1 sesión. A frente a C aísla protobuf frente a JSON; B frente a C, HTTP/2 multiplexado frente a HTTP/1.1. Con *c* > 1, además: A* gRPC con *c* canales (conexiones separadas) y B1 REST 1.1 con 1 conexión (pedidos en cola).');
  e.push('- **Métricas**: latencia con `process.hrtime`, percentiles **exactos** (rango más cercano sobre todas las muestras); en concurrencia, lazo cerrado con *c* pedidos en vuelo y pedidos por segundo; CPU del cliente (`process.cpuUsage` del medidor) y del servidor (`process.cpuUsage` del proceso servidor, pedido por IPC), en ms de CPU por cada 1 000 llamadas.');
  e.push('- **Tamaños**: cuerpo serializado (protobuf y JSON) y **bytes en el cable** por llamada, contados por un proxy TCP (cabeceras, marcos de HTTP/2 y compresión HPACK incluidos) sobre 200 llamadas. El proxy solo se usa para los tamaños, no para los tiempos.');
  e.push('- **Repeticiones**: cada escenario se corre varias veces alternando el orden de los caminos; las tablas dan la **mediana** de las repeticiones y, para el p50, su rango (mínimo–máximo).');
  e.push('- **Carga ajena**: antes de empezar se mide la carga de CPU de la máquina (5 s) y no se mide si pasa del umbral; antes de cada corrida se vuelve a registrar (300 ms).');
  e.push('');

  const noGana: string[] = [];
  const hechosTodos: string[] = [];
  for (const [etiqueta, x] of Object.entries(d.corridas)) {
    const en = x.entorno;
    e.push(`## Entorno: ${etiqueta}`);
    e.push('');
    e.push(
      etiqueta === 'linux'
        ? '> **Referencia para comparar transportes.**'
        : '> **Solo comportamiento observado en este entorno**: con el piso de latencia del diagnóstico, no sirve para comparar transportes.',
    );
    e.push('');
    e.push('| | |');
    e.push('|---|---|');
    for (const [k, v] of Object.entries(en)) e.push(`| ${k} | ${String(v)} |`);
    e.push(`| parámetros | calentamiento ${String(x.parametros.calentamiento)}, en serie ${String(x.parametros.serie)}, en concurrencia ${String(x.parametros.concurrencia)} con c = ${x.parametros.concurrencias.join(', ')}, ${String(x.parametros.repeticiones)} repeticiones |`);
    const cargas = [...x.serie, ...x.concurrencia].map((c) => c.cargaPrevia);
    const todas = [...x.serie, ...x.concurrencia];
    const conEsperas = todas.filter((c) => (c.esperasPorCarga ?? 0) > 0).length;
    const controlada = todas.every((c) => c.esperasPorCarga !== undefined);
    e.push(
      `| carga previa por corrida | máxima ${num(Math.max(...cargas), 1)} %, mediana ${num(medianaDeCorridas(cargas).mediana, 1)} %; ${String(cargas.filter((c) => c > en.umbral).length)} de ${String(cargas.length)} corridas sobre el umbral de ${String(en.umbral)} % ${
        controlada
          ? `(se esperó a que bajara antes de ${String(conEsperas)} corridas; ninguna se midió por encima)`
          : '(**esta corrida solo REGISTRABA la carga previa; no esperaba a que bajara**: las que figuran sobre el umbral se midieron así)'
      } |`,
    );
    e.push('');
    if (en.rapido) e.push('> **Corrida rápida (`--rapido`)**: pocos pedidos, solo para probar el script. No sirve para comparar.\n');

    e.push(`### Tamaños (${etiqueta})`);
    e.push('');
    e.push('| Operación | Cuerpo protobuf pedido / respuesta (B) | Cuerpo JSON pedido / respuesta (B) | Cable gRPC (B) | Cable REST 1.1 (B) | Cable REST h2c (B) |');
    e.push('|---|---|---|---|---|---|');
    for (const [op, t] of Object.entries(x.tamanos)) {
      const cable = (k: string) => `${ent(t.cable[k]?.pedido ?? 0)} / ${ent(t.cable[k]?.respuesta ?? 0)}`;
      e.push(`| ${OPS[op] ?? op} | ${ent(t.cuerpo.protobuf.pedido)} / ${ent(t.cuerpo.protobuf.respuesta)} | ${ent(t.cuerpo.json.pedido)} / ${ent(t.cuerpo.json.respuesta)} | ${cable('grpc')} | ${cable('h1')} | ${cable('h2')} |`);
    }
    e.push('');
    e.push('Cable = bytes por llamada en el socket, pedido / respuesta, con todo lo del transporte. En S1, la respuesta suma los 31 fragmentos y el final.');
    e.push('');

    e.push(`### En serie, 1 pedido en vuelo (${etiqueta})`);
    e.push('');
    for (const op of Object.keys(OPS)) {
      const g = agrupar(x.serie.filter((c) => c.operacion === op));
      if (g.length === 0) continue;
      e.push(`#### ${OPS[op] ?? op}`);
      e.push('');
      e.push(tabla(g, false));
      e.push('');
      const h = hechos(`${etiqueta} · ${op} · en serie`, g, false);
      hechosTodos.push(h.linea);
      if (h.grpcNoGana) noGana.push(h.grpcNoGana);
    }

    e.push(`### En concurrencia, lazo cerrado (${etiqueta})`);
    e.push('');
    for (const op of Object.keys(OPS)) {
      for (const c of x.parametros.concurrencias) {
        const g = agrupar(x.concurrencia.filter((k) => k.operacion === op && k.concurrencia === c));
        if (g.length === 0) continue;
        e.push(`#### ${OPS[op] ?? op} · c = ${String(c)}`);
        e.push('');
        e.push(tabla(g, true));
        e.push('');
        const h = hechos(`${etiqueta} · ${op} · c = ${String(c)}`, g, true);
        hechosTodos.push(h.linea);
        if (h.grpcNoGana) noGana.push(h.grpcNoGana);
        const a1 = g.find((k) => k.variante === 'grpc-1-canal');
        const ac = g.find((k) => k.variante === 'grpc-c-canales');
        const b1 = g.find((k) => k.variante === 'h1-1-conexion');
        const bc = g.find((k) => k.variante === 'h1-c-conexiones');
        if (a1 && ac && b1 && bc) {
          hechosTodos.push(
            `  - Multiplexación, ${op} c = ${String(c)}: gRPC 1 canal frente a ${String(c)} canales → ${ent(a1.rps)} frente a ${ent(ac.rps)} ped/s (×${num(a1.rps / ac.rps, 2)}); REST 1.1 con 1 conexión frente a ${String(c)} → ${ent(b1.rps)} frente a ${ent(bc.rps)} ped/s (×${num(b1.rps / bc.rps, 2)}).`,
          );
        }
      }
    }
  }

  e.push('## Lo que muestran los datos (calculado, sin interpretar)');
  e.push('');
  e.push('Por escenario: el camino con el menor p50 (mediana de las repeticiones), cuántas veces más tardan los demás (×) y, en concurrencia, el mayor throughput. Se marca cuando los rangos del p50 de los dos primeros se solapan. Las líneas de **linux** son la referencia para comparar transportes; las de **windows**, solo comportamiento observado en ese entorno.');
  e.push('');
  e.push(...hechosTodos.filter(Boolean));
  e.push('');
  e.push('### Escenarios donde gRPC NO tuvo el menor p50');
  e.push('');
  e.push(noGana.length === 0 ? '- Ninguno: en todos los escenarios medidos, el menor p50 fue de gRPC (con 1 o con c canales).' : noGana.map((n) => `- ${n}`).join('\n'));
  e.push('');
  return `${e.join('\n')}\n`;
}
