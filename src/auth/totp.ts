// TOTP (RFC 6238) sobre HOTP (RFC 4226), implementado con node:crypto, sin librerías.
// Validado contra los vectores de prueba del Apéndice B del RFC 6238 (tests/unitarias/totp.test.ts).
import { createHmac, timingSafeEqual } from 'node:crypto';

export type AlgoritmoTotp = 'sha1' | 'sha256' | 'sha512';

/** Lo que usan las apps autenticadoras por defecto. */
export const PASO_S = 30;
export const DIGITOS = 6;
/** Pasos de tolerancia hacia atrás y hacia adelante (reloj del teléfono desfasado). */
export const VENTANA = 1;

// ─── Base32 (RFC 4648, sin relleno): formato del secreto en apps y en otpauth:// ─────

const ALFABETO = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function base32(datos: Uint8Array): string {
  let bits = 0;
  let valor = 0;
  let salida = '';
  for (const byte of datos) {
    valor = (valor << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      salida += ALFABETO.charAt((valor >>> (bits - 5)) & 31);
      bits -= 5;
    }
  }
  if (bits > 0) salida += ALFABETO.charAt((valor << (5 - bits)) & 31);
  return salida;
}

export function desdeBase32(texto: string): Buffer {
  const limpio = texto.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let valor = 0;
  const bytes: number[] = [];
  for (const c of limpio) {
    const i = ALFABETO.indexOf(c);
    if (i === -1) throw new Error('base32 inválido');
    valor = (valor << 5) | i;
    bits += 5;
    if (bits >= 8) {
      bytes.push((valor >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

// ─── HOTP / TOTP ─────────────────────────────────────────────────────────────────

/** HOTP (RFC 4226 §5.3): HMAC del contador de 8 bytes, truncamiento dinámico, módulo 10^dígitos. */
export function hotp(secreto: Uint8Array, contador: number, digitos = DIGITOS, algoritmo: AlgoritmoTotp = 'sha1'): string {
  const mensaje = Buffer.alloc(8);
  mensaje.writeBigUInt64BE(BigInt(contador));
  const hmac = createHmac(algoritmo, secreto).update(mensaje).digest();
  const desplazamiento = (hmac[hmac.length - 1] ?? 0) & 0x0f;
  const binario = (hmac.readUInt32BE(desplazamiento) & 0x7fffffff) % 10 ** digitos;
  return binario.toString().padStart(digitos, '0');
}

/** Paso de tiempo T = floor(segundos Unix / 30). */
export const pasoDe = (ahoraMs: number, pasoS = PASO_S) => Math.floor(ahoraMs / 1000 / pasoS);

export function totp(secreto: Uint8Array, ahoraMs: number, o: { digitos?: number; algoritmo?: AlgoritmoTotp; pasoS?: number } = {}): string {
  return hotp(secreto, pasoDe(ahoraMs, o.pasoS), o.digitos, o.algoritmo);
}

/**
 * Verifica un código de 6 dígitos con ±1 paso de tolerancia. ANTI-REPLAY: solo acepta pasos MAYORES que
 * el último aceptado (ultimoPaso). Devuelve el paso aceptado (para guardarlo) o null.
 */
export function verificarTotp(secreto: Uint8Array, codigo: string, ahoraMs: number, ultimoPaso: number | null): number | null {
  if (!/^\d{6}$/.test(codigo)) return null;
  const actual = pasoDe(ahoraMs);
  let aceptado: number | null = null;
  // Se evalúan todos los pasos de la ventana (tiempo constante respecto de cuál coincide).
  for (let p = actual - VENTANA; p <= actual + VENTANA; p++) {
    const coincide = timingSafeEqual(Buffer.from(hotp(secreto, p)), Buffer.from(codigo));
    if (coincide && (ultimoPaso === null || p > ultimoPaso) && aceptado === null) aceptado = p;
  }
  return aceptado;
}

/** URI para el QR de la app autenticadora (el QR lo dibuja el cliente). */
export function uriOtpauth(secreto: Uint8Array, cuenta: string, emisor = 'Cuaderno'): string {
  const etiqueta = `${encodeURIComponent(emisor)}:${encodeURIComponent(cuenta)}`;
  return `otpauth://totp/${etiqueta}?secret=${base32(secreto)}&issuer=${encodeURIComponent(emisor)}&algorithm=SHA1&digits=${String(DIGITOS)}&period=${String(PASO_S)}`;
}
