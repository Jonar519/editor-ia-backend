import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cifrarSecreto, descifrarSecreto } from '../../src/auth/cifrado.js';
import { generarCodigos, hashCodigo, normalizarCodigo } from '../../src/auth/codigos-respaldo.js';
import { base32, desdeBase32, hotp, pasoDe, totp, uriOtpauth, verificarTotp } from '../../src/auth/totp.js';

const ascii = (s: string) => Buffer.from(s, 'ascii');

describe('RFC 6238, Apéndice B (vectores oficiales, 8 dígitos)', () => {
  const SEMILLA = {
    sha1: ascii('12345678901234567890'),
    sha256: ascii('12345678901234567890123456789012'),
    sha512: ascii('1234567890123456789012345678901234567890123456789012345678901234'),
  } as const;
  const TABLA: [number, string, string, string][] = [
    [59, '94287082', '46119246', '90693936'],
    [1111111109, '07081804', '68084774', '25091201'],
    [1111111111, '14050471', '67062674', '99943326'],
    [1234567890, '89005924', '91819424', '93441116'],
    [2000000000, '69279037', '90698825', '38618901'],
    [20000000000, '65353130', '77737706', '47863826'],
  ];
  it.each(TABLA)('T=%i s → SHA1 %s, SHA256 %s, SHA512 %s', (segundos, sha1, sha256, sha512) => {
    const ms = segundos * 1000;
    expect(totp(SEMILLA.sha1, ms, { digitos: 8, algoritmo: 'sha1' })).toBe(sha1);
    expect(totp(SEMILLA.sha256, ms, { digitos: 8, algoritmo: 'sha256' })).toBe(sha256);
    expect(totp(SEMILLA.sha512, ms, { digitos: 8, algoritmo: 'sha512' })).toBe(sha512);
  });
});

describe('RFC 4226, Apéndice D (HOTP, 6 dígitos)', () => {
  const ESPERADOS = ['755224', '287082', '359152', '969429', '338314', '254676', '287922', '162583', '399871', '520489'];
  it.each(ESPERADOS.map((c, i) => [i, c] as const))('contador %i → %s', (contador, codigo) => {
    expect(hotp(ascii('12345678901234567890'), contador)).toBe(codigo);
  });
});

describe('Base32 (RFC 4648, sin relleno)', () => {
  it.each([
    ['f', 'MY'],
    ['fo', 'MZXQ'],
    ['foo', 'MZXW6'],
    ['foob', 'MZXW6YQ'],
    ['fooba', 'MZXW6YTB'],
    ['foobar', 'MZXW6YTBOI'],
  ])('%s ↔ %s', (texto, b32) => {
    expect(base32(ascii(texto))).toBe(b32);
    expect(desdeBase32(b32).toString('ascii')).toBe(texto);
  });

  it('ida y vuelta de un secreto de 20 bytes; rechaza caracteres inválidos', () => {
    const s = randomBytes(20);
    expect(desdeBase32(base32(s)).equals(s)).toBe(true);
    expect(() => desdeBase32('ABC1')).toThrow();
  });
});

describe('verificarTotp (6 dígitos, ±1 paso, anti-replay)', () => {
  const s = randomBytes(20);
  const ahora = Date.UTC(2026, 9, 14, 12, 0, 15);
  const p = pasoDe(ahora);

  it('acepta el paso actual y los vecinos (reloj del teléfono desfasado ±30 s), no más', () => {
    expect(verificarTotp(s, hotp(s, p), ahora, null)).toBe(p);
    expect(verificarTotp(s, hotp(s, p - 1), ahora, null)).toBe(p - 1);
    expect(verificarTotp(s, hotp(s, p + 1), ahora, null)).toBe(p + 1);
    expect(verificarTotp(s, hotp(s, p - 2), ahora, null)).toBeNull();
    expect(verificarTotp(s, hotp(s, p + 2), ahora, null)).toBeNull();
  });

  it('ANTI-REPLAY: un paso igual o anterior al último aceptado no vale', () => {
    expect(verificarTotp(s, hotp(s, p), ahora, p)).toBeNull();
    expect(verificarTotp(s, hotp(s, p - 1), ahora, p - 1)).toBeNull();
    expect(verificarTotp(s, hotp(s, p + 1), ahora, p)).toBe(p + 1);
  });

  it('rechaza formatos que no son 6 dígitos y otro secreto', () => {
    expect(verificarTotp(s, '12345', ahora, null)).toBeNull();
    expect(verificarTotp(s, 'abcdef', ahora, null)).toBeNull();
    expect(verificarTotp(randomBytes(20), hotp(s, p), ahora, null)).toBeNull();
  });

  it('el URI otpauth trae el secreto en base32 y los parámetros estándar', () => {
    const u = uriOtpauth(s, 'ana@example.com');
    expect(u).toBe(`otpauth://totp/Cuaderno:ana%40example.com?secret=${base32(s)}&issuer=Cuaderno&algorithm=SHA1&digits=6&period=30`);
  });
});

describe('cifrado del secreto (AES-256-GCM ligado a la cuenta)', () => {
  const clave = randomBytes(32);
  const cuenta = randomUUID();

  it('cifra y descifra con la misma cuenta', () => {
    const secreto = randomBytes(20);
    const c = cifrarSecreto(clave, secreto, cuenta);
    expect(c.iv).toHaveLength(12);
    expect(c.etiqueta).toHaveLength(16);
    expect(descifrarSecreto(clave, c, cuenta).equals(secreto)).toBe(true);
  });

  it('copiado a OTRA cuenta no se descifra (datos asociados = id de la cuenta)', () => {
    const c = cifrarSecreto(clave, randomBytes(20), cuenta);
    expect(() => descifrarSecreto(clave, c, randomUUID())).toThrow();
  });

  it('con otra clave o un byte alterado no se descifra', () => {
    const c = cifrarSecreto(clave, randomBytes(20), cuenta);
    expect(() => descifrarSecreto(randomBytes(32), c, cuenta)).toThrow();
    const alterado = Uint8Array.from(c.cifrado);
    alterado[0] = (alterado[0] ?? 0) ^ 1;
    expect(() => descifrarSecreto(clave, { ...c, cifrado: alterado }, cuenta)).toThrow();
  });
});

describe('códigos de respaldo', () => {
  it('10 códigos distintos con formato XXXXX-XXXXX', () => {
    const c = generarCodigos();
    expect(c).toHaveLength(10);
    expect(new Set(c).size).toBe(10);
    for (const x of c) expect(x).toMatch(/^[A-Z2-7]{5}-[A-Z2-7]{5}$/);
  });

  it('el hash depende de la cuenta y de la subclave; tolera minúsculas y espacios al escribirlo', () => {
    const sub = randomBytes(32);
    const cuenta = randomUUID();
    const h = Buffer.from(hashCodigo(sub, cuenta, 'ABCDE-FGHIJ'));
    expect(h).toHaveLength(32);
    expect(Buffer.from(hashCodigo(sub, cuenta, ' abcde fghij ')).equals(h)).toBe(true);
    expect(Buffer.from(hashCodigo(sub, randomUUID(), 'ABCDE-FGHIJ')).equals(h)).toBe(false);
    expect(Buffer.from(hashCodigo(randomBytes(32), cuenta, 'ABCDE-FGHIJ')).equals(h)).toBe(false);
    expect(normalizarCodigo('ab-cd ef')).toBe('ABCDEF');
  });
});
