import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { DURACION_ACCESO_S, emitirAcceso, hashToken, tokenAleatorio, verificarAcceso } from '../../src/auth/tokens.js';

const CLAVE = randomBytes(32);
const SUB = randomUUID();
const SID = randomUUID();
const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
const firmar = (datos: string, clave = CLAVE) => createHmac('sha256', clave).update(datos).digest('base64url');

describe('access token (JWT HS256 propio)', () => {
  it('dura exactamente 15 minutos', () => {
    const ahora = Date.UTC(2026, 0, 1);
    const { token, exp } = emitirAcceso(SUB, SID, CLAVE, ahora);
    const r = verificarAcceso(token, CLAVE, ahora);
    expect(DURACION_ACCESO_S).toBe(900);
    expect(r).toEqual({ sub: SUB, sid: SID, iat: ahora / 1000, exp });
    expect(exp - ahora / 1000).toBe(900);
  });

  it('vence: un segundo antes sirve, en el instante del vencimiento ya no', () => {
    const ahora = Date.UTC(2026, 0, 1);
    const { token } = emitirAcceso(SUB, SID, CLAVE, ahora);
    expect(verificarAcceso(token, CLAVE, ahora + 899_000)).not.toBeNull();
    expect(verificarAcceso(token, CLAVE, ahora + 900_000)).toBeNull();
  });

  it('rechaza un cuerpo alterado, una firma alterada y otra clave', () => {
    const { token } = emitirAcceso(SUB, SID, CLAVE);
    const [c, , s] = token.split('.');
    const otroCuerpo = b64({ sub: randomUUID(), sid: SID, iat: 1, exp: 9_999_999_999 });
    expect(verificarAcceso(`${String(c)}.${otroCuerpo}.${String(s)}`, CLAVE)).toBeNull();
    expect(verificarAcceso(`${token.slice(0, -2)}AA`, CLAVE)).toBeNull();
    expect(verificarAcceso(token, randomBytes(32))).toBeNull();
  });

  it('rechaza cualquier otra cabecera: alg "none" y RS256 (sin confusión de algoritmo)', () => {
    const cuerpo = b64({ sub: SUB, sid: SID, iat: 1, exp: 9_999_999_999 });
    const none = b64({ alg: 'none', typ: 'JWT' });
    expect(verificarAcceso(`${none}.${cuerpo}.`, CLAVE)).toBeNull();
    const rs = b64({ alg: 'RS256', typ: 'JWT' });
    expect(verificarAcceso(`${rs}.${cuerpo}.${firmar(`${rs}.${cuerpo}`)}`, CLAVE)).toBeNull();
  });

  it('rechaza formatos raros y reclamos inválidos aunque estén bien firmados', () => {
    expect(verificarAcceso('a.b', CLAVE)).toBeNull();
    expect(verificarAcceso('', CLAVE)).toBeNull();
    const cab = b64({ alg: 'HS256', typ: 'JWT' });
    const conSub = (sub: unknown) => {
      const cuerpo = b64({ sub, sid: SID, iat: 1, exp: 9_999_999_999 });
      return `${cab}.${cuerpo}.${firmar(`${cab}.${cuerpo}`)}`;
    };
    expect(verificarAcceso(conSub(SUB), CLAVE)).not.toBeNull();
    expect(verificarAcceso(conSub('no-es-uuid'), CLAVE)).toBeNull();
    expect(verificarAcceso(conSub(123), CLAVE)).toBeNull();
  });
});

describe('tokens opacos', () => {
  it('son de 32 bytes en base64url y nunca se repiten', () => {
    const a = tokenAleatorio();
    expect(a).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(tokenAleatorio()).not.toBe(a);
  });

  it('en la base solo se guarda su SHA-256 (32 bytes)', () => {
    const t = tokenAleatorio();
    const h = hashToken(t);
    expect(h).toHaveLength(32);
    expect(Buffer.from(h).toString('hex')).not.toContain(Buffer.from(t).toString('hex'));
    expect(Buffer.from(hashToken(t)).equals(Buffer.from(h))).toBe(true);
  });
});
