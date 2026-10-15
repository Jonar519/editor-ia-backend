import { readFileSync } from 'node:fs';
import { crc32, deflateSync, inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { ErrorImagen, limpiarImagen } from '../../src/imagen/limpiar.js';

// Texto que NO debe sobrevivir a la limpieza (simula coordenadas GPS y datos del autor).
const CANARIO = 'CANARIO-GPS-19.4326N-99.1332W-Persona-Ficticia';

// ─── JPEG ──────────────────────────────────────────────────────────────────────────

/** JPEG real de 8x8 generado para estas pruebas (FF D8, APP0 JFIF, tablas, SOF0, SOS, FF D9). */
const JPEG = readFileSync(new URL('../fixtures/cuadrito.jpg', import.meta.url));

const segmento = (marcador: number, cuerpo: Buffer) => {
  const s = Buffer.alloc(4);
  s.writeUInt8(0xff, 0);
  s.writeUInt8(marcador, 1);
  s.writeUInt16BE(cuerpo.length + 2, 2);
  return Buffer.concat([s, cuerpo]);
};

/** El JPEG con metadatos de todo tipo insertados tras SOI y datos pegados después de FF D9. */
function jpegConMetadatos(): Buffer {
  const exif = segmento(0xe1, Buffer.concat([Buffer.from('Exif\0\0MM\0*'), Buffer.from(`GPSLatitude ${CANARIO}`)]));
  const xmp = segmento(0xe1, Buffer.from(`http://ns.adobe.com/xap/1.0/\0<x:xmpmeta>${CANARIO}</x:xmpmeta>`));
  const icc = segmento(0xe2, Buffer.from(`ICC_PROFILE\0${CANARIO}`));
  const comentario = segmento(0xfe, Buffer.from(CANARIO));
  const pegado = Buffer.from(`PK\x03\x04${CANARIO}`); // un ZIP escondido después del fin
  return Buffer.concat([JPEG.subarray(0, 2), exif, xmp, icc, comentario, JPEG.subarray(2), pegado]);
}

/** El mismo JPEG sin su APP0 (JFIF): lo que debe quedar exactamente tras limpiar. */
function jpegEsperado(): Buffer {
  const largoApp0 = JPEG.readUInt16BE(4);
  return Buffer.concat([JPEG.subarray(0, 2), JPEG.subarray(4 + largoApp0)]);
}

describe('limpiarImagen · JPEG', () => {
  it('el archivo de prueba es un JPEG con APP0 JFIF', () => {
    expect([...JPEG.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  it('quita EXIF (GPS), XMP, ICC, comentarios y lo pegado tras FF D9; conserva TODO lo demás byte a byte', () => {
    const r = limpiarImagen(jpegConMetadatos());
    expect(r.tipo).toBe('image/jpeg');
    expect(r.datos.includes(Buffer.from(CANARIO))).toBe(false);
    expect(r.datos.includes(Buffer.from('Exif'))).toBe(false);
    expect(r.datos.includes(Buffer.from('ns.adobe.com'))).toBe(false);
    expect(r.datos.includes(Buffer.from('JFIF'))).toBe(false);
    expect(r.datos.equals(jpegEsperado())).toBe(true);
    expect([...r.datos.subarray(-2)]).toEqual([0xff, 0xd9]);
  });

  it('lee las dimensiones del inicio de cuadro', () => {
    expect(limpiarImagen(JPEG)).toMatchObject({ ancho: 8, alto: 8 });
  });

  it('limpiar lo ya limpio no cambia nada', () => {
    const una = limpiarImagen(jpegConMetadatos()).datos;
    expect(limpiarImagen(una).datos.equals(una)).toBe(true);
  });

  /** Posición del SOF0 (FF C0) en el JPEG de prueba. */
  const sof = () => JPEG.indexOf(Buffer.from([0xff, 0xc0]));

  it('rechaza un tipo de cuadro no admitido (sin pérdida, FF C3)', () => {
    const b = Buffer.from(JPEG);
    b[sof() + 1] = 0xc3;
    expect(() => limpiarImagen(b)).toThrow(/no admitido/);
  });

  it('rechaza dimensiones fuera de rango (alto 0 o ancho 5000)', () => {
    const cero = Buffer.from(JPEG);
    cero.writeUInt16BE(0, sof() + 5);
    expect(() => limpiarImagen(cero)).toThrow(/dimensiones/);
    const ancho = Buffer.from(JPEG);
    ancho.writeUInt16BE(5000, sof() + 7);
    expect(() => limpiarImagen(ancho)).toThrow(/dimensiones/);
  });

  it('rechaza CMYK (4 componentes)', () => {
    const b = Buffer.from(JPEG);
    b[sof() + 9] = 4;
    expect(() => limpiarImagen(b)).toThrow(/componentes/);
  });

  it('rechaza un JPEG truncado o sin fin', () => {
    expect(() => limpiarImagen(JPEG.subarray(0, JPEG.length - 2))).toThrow(ErrorImagen);
    expect(() => limpiarImagen(JPEG.subarray(0, 40))).toThrow(ErrorImagen);
  });

  it('rechaza una longitud de segmento que se sale del archivo', () => {
    const b = Buffer.from(JPEG);
    b.writeUInt16BE(0xfff0, 4); // APP0 dice medir casi 64 KiB
    expect(() => limpiarImagen(b)).toThrow(/longitud/);
  });
});

// ─── PNG ───────────────────────────────────────────────────────────────────────────

const chunk = (tipo: string, datos: Buffer) => {
  const largo = Buffer.alloc(4);
  largo.writeUInt32BE(datos.length);
  const td = Buffer.concat([Buffer.from(tipo, 'latin1'), datos]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([largo, td, crc]);
};

const FIRMA = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const ihdr = (ancho: number, alto: number, tipoColor = 2, bits = 8) => {
  const d = Buffer.alloc(13);
  d.writeUInt32BE(ancho, 0);
  d.writeUInt32BE(alto, 4);
  d[8] = bits;
  d[9] = tipoColor;
  return chunk('IHDR', d);
};

/** 2x2 RGB: cada fila con su byte de filtro 0. */
const PIXELES = Buffer.from([0, 255, 0, 0, 0, 255, 0, 0, 0, 0, 255, 255, 255, 255]);
const comprimido = deflateSync(PIXELES);
const mitad = Math.floor(comprimido.length / 2);

function pngConMetadatos(): Buffer {
  return Buffer.concat([
    FIRMA,
    ihdr(2, 2),
    chunk('tEXt', Buffer.from(`Author\0${CANARIO}`)),
    chunk('iTXt', Buffer.from(`XML:com.adobe.xmp\0\0\0\0\0${CANARIO}`)),
    chunk('eXIf', Buffer.from(`MM\0*${CANARIO}`)),
    chunk('tIME', Buffer.from([7, 234, 10, 14, 12, 0, 0])),
    chunk('IDAT', comprimido.subarray(0, mitad)),
    chunk('zTXt', Buffer.from(`Comment\0\0${CANARIO}`)), // entre dos IDAT
    chunk('IDAT', comprimido.subarray(mitad)),
    chunk('IEND', Buffer.alloc(0)),
    Buffer.from(`PK\x03\x04${CANARIO}`),
  ]);
}

/** Reúne los IDAT de un PNG y los descomprime: los píxeles tienen que llegar intactos. */
function pixelesDe(png: Buffer): Buffer {
  const idat: Buffer[] = [];
  for (let i = 8; i < png.length; ) {
    const largo = png.readUInt32BE(i);
    if (png.toString('latin1', i + 4, i + 8) === 'IDAT') idat.push(png.subarray(i + 8, i + 8 + largo));
    i += 12 + largo;
  }
  return inflateSync(Buffer.concat(idat));
}

const tiposDe = (png: Buffer) => {
  const t: string[] = [];
  for (let i = 8; i < png.length; i += 12 + png.readUInt32BE(i)) t.push(png.toString('latin1', i + 4, i + 8));
  return t;
};

describe('limpiarImagen · PNG', () => {
  it('quita tEXt, iTXt, zTXt, eXIf, tIME y lo pegado tras IEND; los píxeles quedan intactos', () => {
    const r = limpiarImagen(pngConMetadatos());
    expect(r).toMatchObject({ tipo: 'image/png', ancho: 2, alto: 2 });
    expect(r.datos.includes(Buffer.from(CANARIO))).toBe(false);
    expect(tiposDe(r.datos)).toEqual(['IHDR', 'IDAT', 'IDAT', 'IEND']);
    expect(pixelesDe(r.datos).equals(PIXELES)).toBe(true);
  });

  it('conserva PLTE y tRNS (imagen con paleta)', () => {
    const png = Buffer.concat([
      FIRMA,
      ihdr(1, 1, 3, 8),
      chunk('PLTE', Buffer.from([255, 0, 0])),
      chunk('tRNS', Buffer.from([128])),
      chunk('IDAT', deflateSync(Buffer.from([0, 0]))),
      chunk('IEND', Buffer.alloc(0)),
    ]);
    expect(tiposDe(limpiarImagen(png).datos)).toEqual(['IHDR', 'PLTE', 'tRNS', 'IDAT', 'IEND']);
  });

  it('rechaza un CRC incorrecto', () => {
    const b = pngConMetadatos();
    b[8 + 8 + 2] = (b[8 + 8 + 2] ?? 0) ^ 0xff; // un byte del ancho en IHDR
    expect(() => limpiarImagen(b)).toThrow(/CRC/);
  });

  it('rechaza un chunk CRÍTICO desconocido (no se sabe qué contiene)', () => {
    const png = Buffer.concat([FIRMA, ihdr(2, 2), chunk('ZZZZ', Buffer.from(CANARIO)), chunk('IDAT', comprimido), chunk('IEND', Buffer.alloc(0))]);
    expect(() => limpiarImagen(png)).toThrow(/crítico/);
  });

  it('rechaza: sin IHDR al inicio, sin IDAT, sin IEND, paleta sin PLTE, dimensiones fuera de rango', () => {
    const fin = chunk('IEND', Buffer.alloc(0));
    const datos = chunk('IDAT', comprimido);
    expect(() => limpiarImagen(Buffer.concat([FIRMA, datos, ihdr(2, 2), fin]))).toThrow(/IHDR/);
    expect(() => limpiarImagen(Buffer.concat([FIRMA, ihdr(2, 2), fin]))).toThrow(/sin datos/);
    expect(() => limpiarImagen(Buffer.concat([FIRMA, ihdr(2, 2), datos]))).toThrow(/IEND/);
    expect(() => limpiarImagen(Buffer.concat([FIRMA, ihdr(2, 2, 3), datos, fin]))).toThrow(/PLTE/);
    expect(() => limpiarImagen(Buffer.concat([FIRMA, ihdr(4097, 1), datos, fin]))).toThrow(/dimensiones/);
  });
});

describe('limpiarImagen · otros formatos', () => {
  it('rechaza lo que no es JPEG ni PNG, sin importar lo que diga el Content-Type', () => {
    expect(() => limpiarImagen(Buffer.from('GIF89a'))).toThrow(/formato/);
    expect(() => limpiarImagen(Buffer.from('<svg onload="alert(1)"/>'))).toThrow(/formato/);
    expect(() => limpiarImagen(Buffer.alloc(0))).toThrow(/formato/);
  });
});
