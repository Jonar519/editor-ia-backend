// Access token: JWT compacto firmado con HMAC-SHA256, implementado con node:crypto. La cabecera es
// FIJA ({"alg":"HS256","typ":"JWT"}): cualquier otra (alg "none", RS256, campos extra) se rechaza, así
// no hay confusión de algoritmo. Vive 15 minutos y el cliente lo guarda SOLO en memoria.
// Refresh token: 32 bytes aleatorios opacos; en la base solo se guarda su SHA-256.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const DURACION_ACCESO_S = 15 * 60;

const CABECERA = Buffer.from('{"alg":"HS256","typ":"JWT"}').toString('base64url');

export interface ReclamosAcceso {
  /** id de la cuenta */
  sub: string;
  /** id de la sesión: se verifica viva en cada petición */
  sid: string;
  iat: number;
  exp: number;
}

function firma(datos: string, clave: Buffer): Buffer {
  return createHmac('sha256', clave).update(datos).digest();
}

export function emitirAcceso(sub: string, sid: string, clave: Buffer, ahora = Date.now()): { token: string; exp: number } {
  const iat = Math.floor(ahora / 1000);
  const exp = iat + DURACION_ACCESO_S;
  const cuerpo = Buffer.from(JSON.stringify({ sub, sid, iat, exp })).toString('base64url');
  const datos = `${CABECERA}.${cuerpo}`;
  return { token: `${datos}.${firma(datos, clave).toString('base64url')}`, exp };
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Devuelve los reclamos si el token es auténtico y vigente; si no, null (sin decir por qué). */
export function verificarAcceso(token: string, clave: Buffer, ahora = Date.now()): ReclamosAcceso | null {
  const partes = token.split('.');
  if (partes.length !== 3) return null;
  const [cabecera, cuerpo, sello] = partes as [string, string, string];
  if (cabecera !== CABECERA) return null;
  const esperado = firma(`${cabecera}.${cuerpo}`, clave);
  const recibido = Buffer.from(sello, 'base64url');
  if (recibido.length !== esperado.length || !timingSafeEqual(recibido, esperado)) return null;
  let r: unknown;
  try {
    r = JSON.parse(Buffer.from(cuerpo, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (typeof r !== 'object' || r === null) return null;
  const { sub, sid, iat, exp } = r as Record<string, unknown>;
  if (typeof sub !== 'string' || typeof sid !== 'string' || !UUID.test(sub) || !UUID.test(sid)) return null;
  if (typeof iat !== 'number' || typeof exp !== 'number') return null;
  if (exp <= Math.floor(ahora / 1000)) return null;
  return { sub, sid, iat, exp };
}

/** Token aleatorio de un solo uso (refresh, invitación): 32 bytes en base64url. */
export function tokenAleatorio(): string {
  return randomBytes(32).toString('base64url');
}

/** Lo único que se guarda en la base de un token (bytea de 32 bytes; Prisma lo tipa como Uint8Array). */
export function hashToken(token: string): Uint8Array<ArrayBuffer> {
  return Uint8Array.from(createHash('sha256').update(token, 'utf8').digest());
}
