// Informe de la medición de almacenamiento de versiones (riesgo R-02, bloque R): docs/almacenamiento-r.md,
// generado desde docs/almacenamiento-r.json. Como el de carga, ABRE con lo que la medición no permite
// concluir y no saca conclusiones: muestra lo medido y la cuenta del peor caso con el límite vigente.
import { LIMITES_VERSIONES } from '../../src/versiones/rutas.js';

export const TITULO_LIMITES_ALMACENAMIENTO = '## Lo que esta medición NO permite concluir';

export interface CasoAlmacenamiento {
  caracteres: number;
  contenido: 'repetitivo' | 'aleatorio';
  /** Respuestas de los pedidos de guardar versión, en orden (se esperan `limite` 201 y después 429). */
  respuestas: number[];
  versionesGuardadas: number;
  /** Lo que ocupan en la base las columnas de UNA versión (pg_column_size: ya comprimidas por TOAST). */
  bytesEstadoPorVersion: number;
  bytesTextoPorVersion: number;
  /** Lo que ocuparían sin comprimir (octet_length). */
  bytesSinComprimirPorVersion: number;
  /** Crecimiento de la tabla `versiones` (con TOAST e índices) por versión guardada. */
  bytesTablaPorVersion: number;
  msGuardarMediana: number;
  msGuardarMax: number;
  /** Tiempo de GET .../versiones/verificacion con todas las versiones del caso. */
  msVerificar: number;
}

export interface DatosAlmacenamiento {
  entorno: { fecha: string; sistema: string; node: string; postgres: string; cargaInicial: number };
  rapido: boolean;
  limite: { max: number; ventanaMs: number };
  casos: CasoAlmacenamiento[];
  baseAntesBytes: number;
  baseDespuesBytes: number;
}

/** Peor caso por cuenta con el límite vigente: guardar o restaurar al tope, toda la hora. */
export function proyeccion(bytesPorVersion: number): { porHora: number; porDia: number } {
  const porHora = bytesPorVersion * LIMITES_VERSIONES.versiones.max * ((60 * 60_000) / LIMITES_VERSIONES.versiones.ventanaMs);
  return { porHora, porDia: porHora * 24 };
}

const n = (x: number, d = 1) => x.toFixed(d).replace('.', ',');
/** Bytes en la unidad que se lee: KiB, MiB o GiB. */
const tam = (b: number) => (b < 2 ** 20 ? `${n(b / 2 ** 10)} KiB` : b < 2 ** 30 ? `${n(b / 2 ** 20)} MiB` : `${n(b / 2 ** 30, 2)} GiB`);
const miles = (x: number) => String(x).replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
const tabla = (cabecera: string[], filas: string[][]) =>
  [`| ${cabecera.join(' | ')} |`, `|${cabecera.map(() => '---').join('|')}|`, ...filas.map((f) => `| ${f.join(' | ')} |`)].join('\n');

const LIMITES = [
  '- **El tamaño de una base real.** La base es nueva y solo tiene los documentos de esta medición. No dice cuánto ocupa Cuaderno con uso normal: mide lo que cuesta CADA versión y cuánto puede crecer la base en el peor caso permitido.',
  '- **Otro contenido.** La compresión de PostgreSQL (TOAST, pglz) depende del texto: se mide un texto muy repetitivo (comprime mucho) y uno de letras al azar (casi no comprime) como extremos. Un documento real queda entre los dos, sin saber dónde.',
  '- **El peor caso real de restaurar.** Restaurar cuesta lo mismo que guardar (copia el documento entero) y cuenta en el MISMO límite; no se midió aparte.',
  '- **Varias cuentas.** La proyección es por cuenta. Con N cuentas editoras se multiplica por N; no se midió concurrencia.',
  '- **El espacio en disco del servidor.** Los bytes son los de PostgreSQL (`pg_column_size` y `pg_total_relation_size`); no incluyen WAL, copias de seguridad ni réplicas.',
  '- **Tiempos de producción.** Los tiempos de guardar y verificar son de una máquina con todo local (base y API en el mismo equipo) y una sola corrida: indican el orden de magnitud, no una latencia garantizada.',
].join('\n');

export function generarInformeAlmacenamiento(d: DatosAlmacenamiento): string {
  const caso = (c: CasoAlmacenamiento) => `${miles(c.caracteres)} caracteres, ${c.contenido}`;
  const filas = d.casos.map((c) => [
    caso(c),
    String(c.versionesGuardadas),
    c.respuestas.includes(429) ? `sí (pedido ${String(c.respuestas.indexOf(429) + 1)})` : 'no',
    tam(c.bytesSinComprimirPorVersion),
    tam(c.bytesEstadoPorVersion + c.bytesTextoPorVersion),
    tam(c.bytesTablaPorVersion),
    `${n(c.msGuardarMediana, 0)} / ${n(c.msGuardarMax, 0)}`,
    n(c.msVerificar, 0),
  ]);
  const peor = d.casos.reduce((m, c) => Math.max(m, c.bytesTablaPorVersion), 0);
  const proyecciones = d.casos.map((c) => {
    const p = proyeccion(c.bytesTablaPorVersion);
    return [caso(c), tam(c.bytesTablaPorVersion), tam(p.porHora), tam(p.porDia)];
  });
  return [
    '# Almacenamiento de versiones (riesgo R-02)',
    '',
    'Generado por `scripts\\almacenamiento.bat` (`scripts/carga/medir-almacenamiento.ts`) contra la base de PRUEBAS `cuaderno_carga_test`. Datos ficticios. Los datos crudos están en `almacenamiento-r.json`.',
    '',
    d.rapido ? '> **CORRIDA RÁPIDA: no es una medición.** Solo comprueba que la herramienta funciona.\n' : '',
    TITULO_LIMITES_ALMACENAMIENTO,
    '',
    LIMITES,
    '',
    '## Entorno',
    '',
    tabla(['Dato', 'Valor'], [
      ['Fecha', d.entorno.fecha],
      ['Sistema', d.entorno.sistema],
      ['Node', d.entorno.node],
      ['PostgreSQL', d.entorno.postgres],
      ['Carga de CPU antes de empezar', `${n(d.entorno.cargaInicial)} %`],
      ['Límite vigente (guardar y restaurar)', `${String(d.limite.max)} cada ${String(d.limite.ventanaMs / 60_000)} min por cuenta`],
      ['Base antes / después', `${tam(d.baseAntesBytes)} / ${tam(d.baseDespuesBytes)}`],
    ]),
    '',
    '## Lo medido por versión',
    '',
    'Cada caso es una cuenta nueva, propietaria de su documento, que guarda versiones del MISMO texto hasta que el límite responde 429. «Columnas» es lo que ocupan `estado_yjs` y `contenido_texto` ya comprimidos; «tabla» es lo que creció `versiones` (con TOAST e índices) dividido por las versiones guardadas.',
    '',
    tabla(['Caso', 'Versiones guardadas', '¿429 al pasar el límite?', 'Sin comprimir', 'Columnas', 'Tabla', 'Guardar ms (mediana / máx)', 'Verificar la cadena ms'], filas),
    '',
    '## Peor caso permitido por cuenta (cuenta, no medición)',
    '',
    `Bytes de la tabla por versión × ${String(d.limite.max)} versiones por hora, sin parar. El mayor medido: ${tam(peor)} por versión.`,
    '',
    tabla(['Caso', 'Por versión', 'Por hora', 'Por día'], proyecciones),
    '',
  ].join('\n');
}
