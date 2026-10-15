// Cifrado del secreto TOTP: AES-256-GCM con MFA_ENCRYPTION_KEY. Los DATOS ASOCIADOS son el id de la
// cuenta: un secreto cifrado copiado a la fila de otra cuenta no se descifra (la etiqueta GCM falla).
import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

export interface SecretoCifrado {
  cifrado: Uint8Array<ArrayBuffer>;
  iv: Uint8Array<ArrayBuffer>;
  etiqueta: Uint8Array<ArrayBuffer>;
}

export function cifrarSecreto(clave: Buffer, secreto: Uint8Array, usuarioId: string): SecretoCifrado {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', clave, iv);
  c.setAAD(Buffer.from(usuarioId, 'utf8'));
  const cifrado = Buffer.concat([c.update(secreto), c.final()]);
  return { cifrado: Uint8Array.from(cifrado), iv: Uint8Array.from(iv), etiqueta: Uint8Array.from(c.getAuthTag()) };
}

/** Lanza si la clave, el IV, la etiqueta o la cuenta no corresponden. */
export function descifrarSecreto(clave: Buffer, s: { cifrado: Uint8Array; iv: Uint8Array; etiqueta: Uint8Array }, usuarioId: string): Buffer {
  const d = createDecipheriv('aes-256-gcm', clave, s.iv);
  d.setAAD(Buffer.from(usuarioId, 'utf8'));
  d.setAuthTag(s.etiqueta);
  return Buffer.concat([d.update(s.cifrado), d.final()]);
}

/**
 * Subclave para los códigos de respaldo (HKDF-SHA256 desde MFA_ENCRYPTION_KEY). Separar claves por uso
 * evita que una misma clave sirva para cifrar y para hashear.
 */
export function claveCodigosRespaldo(claveMfa: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', claveMfa, Buffer.alloc(0), 'cuaderno/codigos-respaldo/v1', 32));
}
