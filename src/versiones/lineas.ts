// Diferencia por líneas (algoritmo de Myers, O((N+M)·D)) para RESTAURAR una versión como un cambio nuevo
// (bloque N): se borra y se inserta solo lo que difiere. Así el texto que no cambia conserva su identidad
// en Yjs (y con ella, las anclas de los comentarios) y quien edita a la vez no pierde su lugar.
//
// Una "línea" incluye su salto final: unir las líneas reproduce el texto EXACTO (sin normalizar nada).
// El frontend tiene la misma función para mostrar la diferencia (en un Web Worker).
import type * as Y from 'yjs';

export type TipoOperacion = 'igual' | 'quitar' | 'agregar';
export interface Operacion {
  tipo: TipoOperacion;
  lineas: string[];
}

/** "a\nb\nc" → ["a\n", "b\n", "c"] (el texto vacío no tiene líneas). */
export function partirLineas(texto: string): string[] {
  return texto === '' ? [] : texto.split(/(?<=\n)/);
}

/** Agrega una línea a la última operación si es del mismo tipo (las operaciones quedan agrupadas). */
function empujar(ops: Operacion[], tipo: TipoOperacion, linea: string): void {
  const ultima = ops.at(-1);
  if (ultima?.tipo === tipo) ultima.lineas.push(linea);
  else ops.push({ tipo, lineas: [linea] });
}

/** Las operaciones que llevan de `a` a `b`, en orden. */
export function diferenciaPorLineas(a: string, b: string): Operacion[] {
  const A = partirLineas(a);
  const B = partirLineas(b);
  // Prefijo y sufijo comunes fuera: el caso típico (un cambio en medio) queda casi sin trabajo.
  let inicio = 0;
  while (inicio < A.length && inicio < B.length && A[inicio] === B[inicio]) inicio++;
  let finA = A.length;
  let finB = B.length;
  while (finA > inicio && finB > inicio && A[finA - 1] === B[finB - 1]) {
    finA--;
    finB--;
  }
  const ops: Operacion[] = [];
  for (let i = 0; i < inicio; i++) empujar(ops, 'igual', A[i] ?? '');
  for (const op of myers(A.slice(inicio, finA), B.slice(inicio, finB))) for (const l of op.lineas) empujar(ops, op.tipo, l);
  for (let i = finA; i < A.length; i++) empujar(ops, 'igual', A[i] ?? '');
  return ops;
}

function myers(A: string[], B: string[]): Operacion[] {
  const n = A.length;
  const m = B.length;
  const max = n + m;
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d]: los x de la vuelta d-1 para k en [-d, d] (solo esa ventana: memoria O(D²), no O(D·(N+M))).
  const trace: Int32Array[] = [];
  let fin = -1;
  for (let d = 0; d <= max && fin < 0; d++) {
    trace.push(v.slice(off - d, off + d + 1));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && (v[off + k - 1] ?? 0) < (v[off + k + 1] ?? 0)) ? (v[off + k + 1] ?? 0) : (v[off + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        fin = d;
        break;
      }
    }
  }
  // Retroceder desde (n, m).
  const pasos: { tipo: TipoOperacion; linea: string }[] = [];
  let x = n;
  let y = m;
  for (let d = fin; d > 0; d--) {
    const previa = trace[d] ?? new Int32Array(0);
    const en = (k: number) => previa[k + d] ?? 0;
    const k = x - y;
    const kPrevio = k === -d || (k !== d && en(k - 1) < en(k + 1)) ? k + 1 : k - 1;
    const xPrevio = en(kPrevio);
    const yPrevio = xPrevio - kPrevio;
    while (x > xPrevio && y > yPrevio) {
      pasos.push({ tipo: 'igual', linea: A[x - 1] ?? '' });
      x--;
      y--;
    }
    if (x === xPrevio) pasos.push({ tipo: 'agregar', linea: B[y - 1] ?? '' });
    else pasos.push({ tipo: 'quitar', linea: A[x - 1] ?? '' });
    x = xPrevio;
    y = yPrevio;
  }
  while (x > 0 && y > 0) {
    pasos.push({ tipo: 'igual', linea: A[x - 1] ?? '' });
    x--;
    y--;
  }
  const ops: Operacion[] = [];
  for (const p of pasos.reverse()) empujar(ops, p.tipo, p.linea);
  return ops;
}

/**
 * Lleva el Y.Text al texto `objetivo` borrando e insertando solo lo que difiere (dentro de la transacción
 * de quien llama). Comprueba el resultado: si no coincide, lanza (nunca deja un texto a medias sin avisar).
 */
export function llevarA(texto: Y.Text, objetivo: string): void {
  let pos = 0;
  const ops = diferenciaPorLineas(texto.toJSON(), objetivo);
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    if (!op) continue;
    const trozo = op.lineas.join('');
    const siguiente = ops[i + 1];
    if (op.tipo === 'quitar' && siguiente?.tipo === 'agregar') {
      // Líneas cambiadas: dentro de ellas, solo lo que difiere (así un comentario sobre la parte de la
      // línea que no cambió conserva su ancla; lo encontró la prueba en vivo de N).
      const nuevo = siguiente.lineas.join('');
      reemplazarDiferencia(texto, pos, trozo, nuevo);
      pos += nuevo.length;
      i++;
    } else if (op.tipo === 'igual') pos += trozo.length;
    else if (op.tipo === 'quitar') texto.delete(pos, trozo.length);
    else {
      texto.insert(pos, trozo);
      pos += trozo.length;
    }
  }
  if (texto.toJSON() !== objetivo) throw new Error('restaurar: el texto resultante no coincide con la versión');
}

/** En `pos`, cambia `viejo` por `nuevo` tocando solo el medio que difiere (prefijo y sufijo comunes quedan). */
function reemplazarDiferencia(texto: Y.Text, pos: number, viejo: string, nuevo: string): void {
  let p = 0;
  while (p < viejo.length && p < nuevo.length && viejo[p] === nuevo[p]) p++;
  let s = 0;
  while (s < viejo.length - p && s < nuevo.length - p && viejo[viejo.length - 1 - s] === nuevo[nuevo.length - 1 - s]) s++;
  const quitar = viejo.length - p - s;
  if (quitar > 0) texto.delete(pos + p, quitar);
  const poner = nuevo.slice(p, nuevo.length - s);
  if (poner) texto.insert(pos + p, poner);
}
