// Limpieza de metadatos de imágenes SIN dependencias: se reconstruye el archivo copiando solo los
// segmentos (JPEG) o chunks (PNG) de una LISTA BLANCA. Todo lo demás se descarta: EXIF (con GPS), XMP,
// ICC, IPTC, comentarios, textos PNG, fechas y cualquier dato pegado después del fin de la imagen.
//
// Lista blanca y no lista negra: un tipo de metadato que no conocemos tampoco pasa. No se decodifican
// los píxeles; sí se valida la estructura completa (longitudes, orden, CRC de PNG, dimensiones). Si algo
// no cuadra, el archivo se rechaza entero: el original nunca se guarda.
import { crc32 } from 'node:zlib';

export type TipoImagen = 'image/jpeg' | 'image/png';

export interface ImagenLimpia {
  tipo: TipoImagen;
  datos: Buffer;
  ancho: number;
  alto: number;
}

/** Dimensiones máximas (la base exige lo mismo). */
export const LADO_MAXIMO = 4096;

export class ErrorImagen extends Error {
  constructor(readonly motivo: string) {
    super(`Imagen no válida: ${motivo}`);
    this.name = 'ErrorImagen';
  }
}

const FIRMA_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** Detecta el formato por la FIRMA de bytes (nunca por el Content-Type ni la extensión) y limpia. */
export function limpiarImagen(entrada: Buffer): ImagenLimpia {
  if (entrada.length >= 3 && entrada[0] === 0xff && entrada[1] === 0xd8 && entrada[2] === 0xff) return limpiarJpeg(entrada);
  if (entrada.length >= 8 && entrada.subarray(0, 8).equals(FIRMA_PNG)) return limpiarPng(entrada);
  throw new ErrorImagen('formato no admitido (solo JPEG o PNG)');
}

function validarLados(ancho: number, alto: number): void {
  if (ancho < 1 || alto < 1 || ancho > LADO_MAXIMO || alto > LADO_MAXIMO) {
    throw new ErrorImagen(`dimensiones fuera de rango (${String(ancho)}x${String(alto)}; máximo ${String(LADO_MAXIMO)})`);
  }
}

// ─── JPEG ──────────────────────────────────────────────────────────────────────────

/** Segmentos con longitud que se CONSERVAN: tablas de cuantización y Huffman, intervalo de reinicio. */
const JPEG_TABLAS = new Set([0xdb, 0xc4, 0xdd]);
/** Inicio de cuadro admitido: baseline (C0), secuencial extendido (C1) y progresivo (C2), Huffman. */
const JPEG_SOF = new Set([0xc0, 0xc1, 0xc2]);
const esApp = (m: number) => m >= 0xe0 && m <= 0xef;
const COM = 0xfe;
const SOS = 0xda;
const EOI = 0xd9;

function limpiarJpeg(b: Buffer): ImagenLimpia {
  const partes: Buffer[] = [b.subarray(0, 2)]; // SOI
  let i = 2;
  let dims: { ancho: number; alto: number } | undefined;
  let escaneos = 0;

  for (;;) {
    if (i >= b.length || b[i] !== 0xff) throw new ErrorImagen('JPEG: se esperaba un marcador');
    while (b[i] === 0xff) i++; // bytes de relleno antes del marcador
    const marcador = b[i];
    if (marcador === undefined) throw new ErrorImagen('JPEG: termina sin marcador de fin');
    i++;
    if (marcador === EOI) {
      partes.push(Buffer.from([0xff, EOI])); // lo que venga después de FF D9 se descarta
      break;
    }
    if (i + 2 > b.length) throw new ErrorImagen('JPEG: segmento truncado');
    const largo = b.readUInt16BE(i);
    const fin = i + largo;
    if (largo < 2 || fin > b.length) throw new ErrorImagen('JPEG: longitud de segmento inválida');
    const segmento = Buffer.concat([Buffer.from([0xff, marcador]), b.subarray(i, fin)]);

    if (esApp(marcador) || marcador === COM) {
      // APP0–APP15 (JFIF, EXIF y GPS, XMP, ICC, IPTC, Adobe...) y comentarios: fuera.
      i = fin;
    } else if (JPEG_TABLAS.has(marcador)) {
      partes.push(segmento);
      i = fin;
    } else if (JPEG_SOF.has(marcador)) {
      if (dims) throw new ErrorImagen('JPEG: más de un inicio de cuadro');
      if (largo < 8) throw new ErrorImagen('JPEG: inicio de cuadro truncado');
      const componentes = b[i + 7];
      if (componentes !== 1 && componentes !== 3) throw new ErrorImagen('JPEG: solo escala de grises o color (1 o 3 componentes)');
      dims = { alto: b.readUInt16BE(i + 3), ancho: b.readUInt16BE(i + 5) };
      validarLados(dims.ancho, dims.alto);
      partes.push(segmento);
      i = fin;
    } else if (marcador === SOS) {
      if (!dims) throw new ErrorImagen('JPEG: datos de imagen antes del inicio de cuadro');
      // Datos comprimidos hasta el siguiente marcador real (FF 00 es un FF escapado; FF D0–D7, reinicios).
      let j = fin;
      while (j < b.length) {
        if (b[j] !== 0xff) {
          j++;
          continue;
        }
        const sig = b[j + 1];
        if (sig === 0x00 || (sig !== undefined && sig >= 0xd0 && sig <= 0xd7)) {
          j += 2;
          continue;
        }
        break;
      }
      if (j >= b.length) throw new ErrorImagen('JPEG: datos de imagen sin marcador de fin');
      partes.push(segmento, b.subarray(fin, j));
      escaneos++;
      i = j;
    } else {
      // Aritmético, sin pérdida, jerárquico, DNL, JPGn y demás: no se admiten.
      throw new ErrorImagen(`JPEG: segmento no admitido (FF ${marcador.toString(16).toUpperCase()})`);
    }
  }
  if (!dims || escaneos === 0) throw new ErrorImagen('JPEG: sin datos de imagen');
  return { tipo: 'image/jpeg', datos: Buffer.concat(partes), ...dims };
}

// ─── PNG ───────────────────────────────────────────────────────────────────────────

/** Chunks que se CONSERVAN. Los demás auxiliares (tEXt, zTXt, iTXt, eXIf, tIME, iCCP, pHYs...) se descartan. */
const PNG_CONSERVAR = new Set(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
/** Combinaciones válidas tipo de color → profundidades de bit (especificación PNG). */
const PNG_PROFUNDIDADES: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };

function limpiarPng(b: Buffer): ImagenLimpia {
  const partes: Buffer[] = [FIRMA_PNG];
  let i = 8;
  let dims: { ancho: number; alto: number } | undefined;
  let tipoColor = -1;
  let paleta = false;
  let idat = 0;

  for (;;) {
    if (i + 12 > b.length) throw new ErrorImagen('PNG: termina sin IEND');
    const largo = b.readUInt32BE(i);
    const tipo = b.toString('latin1', i + 4, i + 8);
    const fin = i + 12 + largo;
    if (!/^[A-Za-z]{4}$/.test(tipo) || fin > b.length) throw new ErrorImagen('PNG: chunk inválido');
    if (crc32(b.subarray(i + 4, i + 8 + largo)) !== b.readUInt32BE(i + 8 + largo)) throw new ErrorImagen(`PNG: CRC incorrecto en ${tipo}`);
    const datos = b.subarray(i + 8, i + 8 + largo);
    const chunk = b.subarray(i, fin);

    if (!dims && tipo !== 'IHDR') throw new ErrorImagen('PNG: el primer chunk debe ser IHDR');
    if (tipo === 'IHDR') {
      if (dims || largo !== 13) throw new ErrorImagen('PNG: IHDR inválido');
      dims = { ancho: datos.readUInt32BE(0), alto: datos.readUInt32BE(4) };
      validarLados(dims.ancho, dims.alto);
      const bits = datos[8] ?? 0;
      tipoColor = datos[9] ?? -1;
      if (!PNG_PROFUNDIDADES[tipoColor]?.includes(bits)) throw new ErrorImagen('PNG: tipo de color o profundidad inválidos');
      if (datos[10] !== 0 || datos[11] !== 0 || (datos[12] !== 0 && datos[12] !== 1)) throw new ErrorImagen('PNG: compresión, filtro o entrelazado inválidos');
      partes.push(chunk);
    } else if (tipo === 'IEND') {
      partes.push(chunk);
      break; // lo que venga después de IEND se descarta
    } else if (tipo === 'IDAT') {
      idat++;
      partes.push(chunk);
    } else if (PNG_CONSERVAR.has(tipo)) {
      if (idat > 0) throw new ErrorImagen(`PNG: ${tipo} después de los datos de imagen`);
      if (tipo === 'PLTE') paleta = true;
      partes.push(chunk);
    } else if (tipo.charCodeAt(0) >= 0x41 && tipo.charCodeAt(0) <= 0x5a) {
      // Mayúscula inicial = chunk CRÍTICO: si no lo conocemos, no podemos garantizar qué contiene.
      throw new ErrorImagen(`PNG: chunk crítico no admitido (${tipo})`);
    }
    // Auxiliar fuera de la lista blanca: se descarta. Si estaba entre dos IDAT, al quitarlo quedan seguidos.
    i = fin;
  }
  if (!dims || idat === 0) throw new ErrorImagen('PNG: sin datos de imagen');
  if (tipoColor === 3 && !paleta) throw new ErrorImagen('PNG: imagen con paleta sin PLTE');
  return { tipo: 'image/png', datos: Buffer.concat(partes), ...dims };
}
