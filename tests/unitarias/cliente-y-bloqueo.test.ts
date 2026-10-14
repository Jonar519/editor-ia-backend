import { describe, expect, it } from 'vitest';
import { truncarIp, userAgentCorto } from '../../src/auth/cliente.js';
import { duracionBloqueoMs, FALLOS_ANTES_DE_BLOQUEAR } from '../../src/auth/limites.js';

describe('truncarIp (lo que exige la base: /24 y /48)', () => {
  it.each([
    ['203.0.113.77', '203.0.113.0/24'],
    ['::ffff:203.0.113.77', '203.0.113.0/24'],
    ['2001:db8:abcd:12:34:56:78:9', '2001:db8:abcd::/48'],
    ['2001:db8::1', '2001:db8:0::/48'],
    ['::1', '0:0:0::/48'],
  ])('%s → %s', (ip, esperado) => {
    expect(truncarIp(ip)).toBe(esperado);
  });

  it('nada válido → null', () => {
    expect(truncarIp(undefined)).toBeNull();
    expect(truncarIp('no-es-ip')).toBeNull();
  });
});

describe('userAgentCorto', () => {
  it.each([
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0', 'Firefox · Windows'],
    ['Mozilla/5.0 (Macintosh; Intel Mac OS X 14_5) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15', 'Safari · macOS'],
    ['Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Safari/537.36 Edg/140.0', 'Edge · Windows'],
    ['Mozilla/5.0 (Linux; Android 15) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0 Mobile Safari/537.36', 'Chrome · Android'],
  ])('%s', (ua, esperado) => {
    expect(userAgentCorto(ua)).toBe(esperado);
  });

  it('desconocido: se recorta a 80 caracteres imprimibles', () => {
    expect(userAgentCorto('x'.repeat(300))).toHaveLength(80);
    expect(userAgentCorto(undefined)).toBeNull();
  });
});

describe('bloqueo progresivo', () => {
  it(`los primeros ${String(FALLOS_ANTES_DE_BLOQUEAR - 1)} fallos no bloquean`, () => {
    for (let f = 0; f < FALLOS_ANTES_DE_BLOQUEAR; f++) expect(duracionBloqueoMs(f)).toBe(0);
  });

  it('5 → 1 min, 6 → 2 min, 7 → 4 min ... con tope de 1 hora', () => {
    expect(duracionBloqueoMs(5)).toBe(60_000);
    expect(duracionBloqueoMs(6)).toBe(120_000);
    expect(duracionBloqueoMs(7)).toBe(240_000);
    expect(duracionBloqueoMs(11)).toBe(60 * 60_000);
    expect(duracionBloqueoMs(50)).toBe(60 * 60_000);
  });
});
