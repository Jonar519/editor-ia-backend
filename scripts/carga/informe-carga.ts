// Informe de las pruebas de carga (docs/carga-r.md), generado desde los datos crudos (docs/carga-r.json).
// Por decisión escrita, ABRE con lo que la medición no permite concluir, antes de cualquier tabla, y no
// saca conclusiones: solo muestra lo medido.
import { medianaDeCorridas } from '../medicion/estadistica.js';
import type { CorridaHttp, CorridaLogin, CorridaWs, DatosCarga, MedicionEntorno } from './tipos.js';

export const TITULO_LIMITES = '## Lo que esta medición NO permite concluir';

/** Número con coma decimal. */
const n = (x: number, d = 1) => x.toFixed(d).replace('.', ',');
const rango = (xs: number[], d = 1) => {
  const m = medianaDeCorridas(xs);
  return xs.length > 1 ? `${n(m.mediana, d)} [${n(m.min, d)}–${n(m.max, d)}]` : n(m.mediana, d);
};
const mediana = (xs: number[], d = 1) => n(medianaDeCorridas(xs).mediana, d);
const suma = (xs: number[]) => xs.reduce((s, x) => s + x, 0);
const tabla = (cabecera: string[], filas: string[][]) =>
  [`| ${cabecera.join(' | ')} |`, `|${cabecera.map(() => '---').join('|')}|`, ...filas.map((f) => `| ${f.join(' | ')} |`)].join('\n');

const LIMITES = [
  '- **La capacidad en producción.** Todo corre en UNA máquina: los clientes de carga, el API, PostgreSQL y Redis comparten la CPU. Es loopback: sin red real, sin TLS, sin proxy inverso ni balanceador. Un número de esta tabla no es "cuántas personas aguanta Cuaderno".',
  '- **Escalar horizontalmente.** Se mide una sola instancia del API, que es lo único que admite hoy el tiempo real (ADR 0002).',
  '- **El costo del log y de producción.** El API corre con `NODE_ENV=development` (producción exige proveedores reales) y `LOG_LEVEL=warn`: sin la línea de log por pedido que tendría con `info`.',
  '- **Nada de la IA.** La IA está apagada (sin `IA_SERVICE_TOKEN`) y el correo es simulado: no se carga ninguna ruta de IA ni el autocompletado.',
  '- **Una base grande o vieja.** La base es nueva en cada medición y chica: 102 cuentas, 2 espacios y 23 documentos. Caché caliente y sin hinchazón.',
  '- **Efectos de largo plazo.** Cada corrida dura 30 s: no muestra fugas de memoria, la compactación por inactividad (5 min), la retención diaria ni el vencimiento de sesiones.',
  '- **Latencias altas exactas en HTTP.** autocannon mide en lazo cerrado: cada conexión espera su respuesta antes de mandar otra, así que con el servidor lento baja el ritmo (omisión coordinada) y las latencias altas pueden quedar subestimadas. Su resolución es de 1 ms: lo que tarda menos se ve como 0 o 1 ms.',
  '- **El costo de muchos inicios de sesión.** Con una sola IP de cliente, el límite por IP del login (20 cada 15 minutos) se alcanza enseguida: H4 mide sobre todo las respuestas 429 del limitador, no miles de verificaciones de contraseña.',
  '- **Solo la latencia del servidor en WebSocket.** La latencia de ida y vuelta incluye el bucle de eventos de los generadores (en la misma máquina) y aplicar el cambio de Yjs en el cliente que lo recibe.',
  '- **Windows frente a Linux como comparación de sistemas.** Las dos corridas usan el mismo equipo y los MISMOS contenedores de PostgreSQL y Redis (Docker sobre WSL2). En Windows, el API y los clientes corren en Windows y llegan a ellos por el puerto publicado; en Linux, el API y los clientes corren en un contenedor y llegan por la red de Docker. La virtualización suma su costo en los dos casos, distinto en cada uno. La referencia es Linux.',
  '- **Carga ajena del lado Windows durante la corrida de Linux.** Dentro del contenedor, la comprobación de carga previa ve la CPU de la máquina virtual de WSL2, no los procesos de Windows. Por eso la corrida de Linux se hizo con el equipo sin otros programas abiertos, igual que la de Windows.',
  '- **Comparaciones con otros sistemas** ni un "máximo" de clientes: no se buscó el punto de quiebre.',
].join('\n');

function seccionEntorno(m: MedicionEntorno): string {
  const e = m.entorno;
  const p = m.parametros;
  return [
    `### ${e.etiqueta}`,
    '',
    tabla(
      ['Dato', 'Valor'],
      [
        ['Fecha', e.fecha],
        ['CPU', `${e.cpu ?? '?'} (${String(e.hilos)} hilos)`],
        ['RAM', `${n(e.ramGiB)} GiB`],
        ['Sistema', e.sistema],
        ['Node', e.node],
        ['autocannon', e.autocannon],
        ['PostgreSQL', e.postgres],
        ['Carga de CPU antes de empezar', `${n(e.cargaInicial)} % (umbral ${String(e.umbral)} %)${e.forzado ? ' — FORZADO' : ''}`],
        ['Parámetros', `HTTP: ${p.conexiones.join(', ')} conexiones; WS: ${p.clientesW1.join(', ')} clientes (W1), ${String(p.documentosW2)} × ${String(p.clientesPorDocumentoW2)} (W2), ${p.tasas.join(' y ')} cambios/s; ${String(p.duracionS)} s por corrida, ${String(p.calentamientoS)} s de calentamiento, ${String(p.repeticiones)} repeticiones${e.rapido ? ' (RÁPIDO: no es una medición)' : ''}`],
      ],
    ),
  ].join('\n');
}

function seccionHttp(h: CorridaHttp[]): string {
  if (!h.length) return '_Sin corridas._';
  const grupos = new Map<string, CorridaHttp[]>();
  for (const c of h) grupos.set(`${c.escenario}|${String(c.conexiones)}`, [...(grupos.get(`${c.escenario}|${String(c.conexiones)}`) ?? []), c]);
  const filas = [...grupos.values()].map((g) => {
    const x = g[0] as CorridaHttp;
    const fallos = suma(g.map((c) => c.resultado.errores + c.resultado.timeouts + Object.entries(c.resultado.codigos).filter(([k]) => !k.startsWith('2')).reduce((s, [, v]) => s + v, 0)));
    return [
      x.escenario,
      String(x.conexiones),
      rango(g.map((c) => c.resultado.pedidosPorSegundo), 0),
      mediana(g.map((c) => c.resultado.latenciaMs.p50)),
      mediana(g.map((c) => c.resultado.latenciaMs.p90)),
      mediana(g.map((c) => c.resultado.latenciaMs.p99)),
      n(Math.max(...g.map((c) => c.resultado.latenciaMs.max)), 0),
      `${String(fallos)} de ${String(suma(g.map((c) => c.resultado.total)))}`,
      mediana(g.map((c) => c.cpuServidorPct)),
      mediana(g.map((c) => c.cpuClientePct)),
      n(Math.max(...g.map((c) => c.rssMaxMiB))),
    ];
  });
  return tabla(['Escenario', 'Conexiones', 'Pedidos/s, mediana [mín–máx]', 'p50 ms', 'p90 ms', 'p99 ms', 'Máx ms', 'Fallos o no 2xx', 'CPU API %', 'CPU cliente %', 'RSS API máx MiB'], filas);
}

function seccionLogin(l: CorridaLogin[]): string {
  if (!l.length) return '_Sin corridas._';
  const conexiones = [...new Set(l.map((c) => c.conexiones))];
  const filas = conexiones.map((k) => {
    const g = l.filter((c) => c.conexiones === k);
    const codigos: Record<string, number> = {};
    for (const c of g) for (const [cod, v] of Object.entries(c.login.codigos)) codigos[cod] = (codigos[cod] ?? 0) + v;
    return [
      String(k),
      Object.entries(codigos)
        .sort()
        .map(([cod, v]) => `${cod}: ${String(v)}`)
        .join(', '),
      rango(g.map((c) => c.login.pedidosPorSegundo), 0),
      mediana(g.map((c) => c.login.latenciaMs.p50)),
      mediana(g.map((c) => c.login.latenciaMs.p99)),
      `${mediana(g.map((c) => c.sondaSola.latenciaMs.p50))} / ${mediana(g.map((c) => c.sondaSola.latenciaMs.p99))}`,
      `${mediana(g.map((c) => c.sondaConLogin.latenciaMs.p50))} / ${mediana(g.map((c) => c.sondaConLogin.latenciaMs.p99))}`,
      String(suma(g.map((c) => c.sondaConLogin.errores + c.sondaConLogin.timeouts + Object.entries(c.sondaConLogin.codigos).filter(([cod]) => !cod.startsWith('2')).reduce((s, [, v]) => s + v, 0)))),
      mediana(g.map((c) => c.cpuServidorPct)),
    ];
  });
  return tabla(['Conexiones de login', 'Respuestas del login (todas las repeticiones)', 'Login pedidos/s', 'Login p50 ms', 'Login p99 ms', 'Sonda H2 sola p50 / p99 ms', 'Sonda H2 con login p50 / p99 ms', 'Sonda: fallos o no 2xx', 'CPU API %'], filas);
}

function seccionWs(w: CorridaWs[], duracionS: number): string {
  if (!w.length) return '_Sin corridas._';
  const grupos = new Map<string, CorridaWs[]>();
  for (const c of w) {
    const k = `${c.escenario}|${String(c.documentos)}|${String(c.clientes)}|${String(c.tasa)}`;
    grupos.set(k, [...(grupos.get(k) ?? []), c]);
  }
  const filas = [...grupos.values()].map((g) => {
    const x = g[0] as CorridaWs;
    const lat = g.map((c) => c.resultado.latencia).filter((r) => r !== null);
    const cierres: Record<string, number> = {};
    for (const c of g) for (const [cod, v] of Object.entries(c.resultado.cierres)) cierres[cod] = (cierres[cod] ?? 0) + v;
    const esperados = suma(g.map((c) => c.resultado.esperados));
    const perdidos = suma(g.map((c) => c.resultado.perdidos));
    return [
      x.escenario,
      `${String(x.documentos)} × ${String(x.clientes / x.documentos)}`,
      String(x.tasa),
      mediana(g.map((c) => c.cambiosPorSegundo), 0),
      mediana(g.map((c) => c.entregasPorSegundo), 0),
      lat.length ? mediana(lat.map((r) => r.p50)) : '—',
      lat.length ? mediana(lat.map((r) => r.p95)) : '—',
      lat.length ? mediana(lat.map((r) => r.p99)) : '—',
      lat.length ? n(Math.max(...lat.map((r) => r.max))) : '—',
      `${String(perdidos)} de ${String(esperados)}`,
      `${String(g.filter((c) => c.resultado.converge).length)} de ${String(g.length)}`,
      Object.keys(cierres).length ? Object.entries(cierres).map(([cod, v]) => `${cod}: ${String(v)}`).join(', ') : 'ninguno',
      mediana(g.map((c) => c.filasInsertadas / duracionS), 0),
      mediana(g.map((c) => c.cpuServidorPct)),
      mediana(g.map((c) => c.cpuGeneradoresPct)),
      n(Math.max(...g.map((c) => c.rssMaxMiB))),
    ];
  });
  return tabla(
    ['Escenario', 'Documentos × clientes', 'Cambios/s por cliente', 'Cambios/s total', 'Entregas/s', 'p50 ms', 'p95 ms', 'p99 ms', 'Máx ms', 'Entregas perdidas', 'Convergió', 'Cierres', 'Filas insertadas/s', 'CPU API %', 'CPU generadores %', 'RSS API máx MiB'],
    filas,
  );
}

function seccionCarga(m: MedicionEntorno): string {
  const todas = [...m.http, ...m.login, ...m.ws];
  if (!todas.length) return '';
  const max = Math.max(...todas.map((c) => c.cargaPrevia));
  const conEspera = todas.filter((c) => c.esperasPorCarga > 0).length;
  return `Carga de CPU previa de cada corrida: máxima ${n(max)} % (umbral ${String(m.entorno.umbral)} %); ${String(conEspera)} de ${String(todas.length)} corridas tuvieron que esperar a que bajara.`;
}

export function generarInformeCarga(d: DatosCarga): string {
  const entornos = Object.values(d.corridas).sort((x, y) => (x.entorno.etiqueta === 'linux' ? -1 : y.entorno.etiqueta === 'linux' ? 1 : 0));
  const partes = [
    '# Pruebas de carga (bloque R): HTTP y WebSocket',
    '',
    '> Generado por `npm run carga` (`scripts/carga/`). Datos crudos: `docs/carga-r.json`. No se edita a mano.',
    '',
    TITULO_LIMITES,
    '',
    LIMITES,
    '',
    '## Cómo se midió',
    '',
    '- **Servidor:** el API REAL (`dist/servidor.js`, el mismo arranque que producción: tiempo real, avisos de la base, compactación y retención) en su propio proceso, contra una base de pruebas propia (`cuaderno_carga_test`, recreada y migrada en cada medición) y Redis db 2. La CPU y la memoria del API se miden en su proceso.',
    '- **Datos:** solo ficticios (`@example.com`). La cuenta del login usa el costo de contraseña de producción (scrypt, 2^15).',
    '- **HTTP (autocannon):** H1 `GET /health`; H2 `GET /api/espacios` con sesión (la sesión se valida en la base en cada pedido); H3 `GET /api/documentos/:id/texto` de un documento de 10 000 caracteres. Antes de cada corrida, 5 s de calentamiento.',
    '- **H4:** `POST /api/auth/sesion` con la contraseña correcta, con el límite de inicio de sesión vaciado antes de cada corrida, y a la vez una sonda de H2 con 1 conexión, comparada con la misma sonda sola justo antes.',
    '- **WebSocket:** clientes Yjs con el protocolo del navegador, repartidos en hasta 4 procesos generadores. Cada cambio escribe una letra en el texto y, en un mapa, su número y el instante en que se mandó; quien lo recibe calcula la latencia de ida y vuelta por el servidor. **Pérdida:** entregas esperadas (cada cambio enviado en la ventana, a cada uno de los otros clientes de su documento) menos las recibidas. **Convergencia:** al final, todos los clientes de cada documento tienen el mismo estado, del mismo largo que el texto del servidor. **Filas:** inserciones en `actualizaciones_documento` dentro de la ventana medida, según la secuencia de su `id` (exacta: la compactación no la baja). El servidor inserta una fila por autor en cada vaciado (cada 250 ms).',
    '- **Carga ajena:** antes de empezar y de cada corrida se mide la CPU de la máquina; con más del umbral se espera, y si no baja se aborta todo sin escribir nada.',
    '- **Estadística:** cada fila junta las repeticiones de esa configuración. Pedidos/s: mediana [mínimo–máximo]. Latencias: mediana de las repeticiones. Máx: el mayor de todas. CPU en % de UN núcleo.',
    '',
    ...entornos.map(seccionEntorno),
  ];
  for (const m of entornos) {
    partes.push(
      '',
      `## ${m.entorno.etiqueta}: HTTP (H1–H3)`,
      '',
      seccionHttp(m.http),
      '',
      `## ${m.entorno.etiqueta}: inicio de sesión bajo carga (H4)`,
      '',
      seccionLogin(m.login),
      '',
      `## ${m.entorno.etiqueta}: WebSocket (W1–W2)`,
      '',
      seccionWs(m.ws, m.parametros.duracionS),
      '',
      seccionCarga(m),
    );
  }
  return `${partes.join('\n')}\n`;
}
