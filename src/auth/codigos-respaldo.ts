// Códigos de respaldo: 10 por cuenta, de un solo uso, 50 bits cada uno (XXXXX-XXXXX en base32).
// En la base se guarda HMAC-SHA256(subclave, cuenta + código): con 50 bits un SHA-256 sin clave se
// podría romper por fuerza bruta si la base se filtrara; con la subclave (que no está en la base), no.
import { createHmac, randomBytes } from 'node:crypto';
import { base32 } from './totp.js';

export const CANTIDAD_CODIGOS = 10;

/** Normaliza lo que escribe la persona: mayúsculas, sin espacios ni guion. */
export const normalizarCodigo = (codigo: string) => codigo.toUpperCase().replace(/[\s-]/g, '');

export function generarCodigos(): string[] {
  return Array.from({ length: CANTIDAD_CODIGOS }, () => {
    const c = base32(randomBytes(7)).slice(0, 10);
    return `${c.slice(0, 5)}-${c.slice(5)}`;
  });
}

export function hashCodigo(subclave: Buffer, usuarioId: string, codigo: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHmac('sha256', subclave).update(`${usuarioId}:${normalizarCodigo(codigo)}`).digest());
}
