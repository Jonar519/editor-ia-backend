// Configuración de la IA (bloque P1): la del API (cliente) y la del servicio (proceso aparte). Mismas
// reglas de transporte en los dos: en producción, TLS mutuo o red privada declarada; nunca en silencio.
import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cargarConfig, ErrorConfig } from '../../src/config/entorno.js';
import { cargarConfigIa } from '../../src/ia/config.js';

const TOKEN_IA = randomBytes(32).toString('base64url');
/** Clave del proveedor real, ficticia y distinta en cada corrida (nunca un literal que parezca una clave). */
const CLAVE_FICTICIA = randomBytes(24).toString('base64url');

const apiBase = {
  DATABASE_URL: 'postgresql://cuaderno_app:clave@127.0.0.1:5435/cuaderno',
  REDIS_URL: 'redis://127.0.0.1:6381/0',
  MFA_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64'),
};

const apiProduccion = {
  ...apiBase,
  NODE_ENV: 'production',
  REDIS_URL: 'redis://:clave-redis@redis.example.com:6379/0',
  METRICS_TOKEN: 'x'.repeat(40),
  AI_PROVIDER: 'anthropic',
  EMAIL_PROVIDER: 'ses',
  GEO_PROVIDER: 'tabla_local',
  APP_URL: 'https://cuaderno.example.com',
  SES_REGION: 'us-east-1',
  IA_SERVICE_TOKEN: TOKEN_IA,
};

const TLS = { IA_TLS_CERT: 'certs/api.crt', IA_TLS_KEY: 'certs/api.key', IA_TLS_CA: 'certs/ca.crt' };

function problemas(cargar: (env: Record<string, string | undefined>) => unknown, env: Record<string, string | undefined>): string[] {
  try {
    cargar(env);
    return [];
  } catch (e) {
    if (e instanceof ErrorConfig) return e.problemas;
    throw e;
  }
}

describe('API: cliente del servicio de IA', () => {
  it('en desarrollo, sin token: arranca sin IA, apuntando a 127.0.0.1:4210', () => {
    const c = cargarConfig(apiBase);
    expect(c.IA_URL).toBe('127.0.0.1:4210');
    expect(c.IA_SERVICE_TOKEN).toBeUndefined();
    expect(c.IA_RED_PRIVADA).toBe(false);
  });

  it('el token entre servicios: 32+ bytes en base64url; el mensaje nunca trae el valor', () => {
    const corto = randomBytes(16).toString('base64url');
    expect(problemas(cargarConfig, { ...apiBase, IA_SERVICE_TOKEN: corto })).toEqual(['IA_SERVICE_TOKEN: debe ser de al menos 32 bytes en base64url']);
    expect(problemas(cargarConfig, { ...apiBase, IA_SERVICE_TOKEN: `${TOKEN_IA}+/` })).toHaveLength(1);
    expect(problemas(cargarConfig, { ...apiBase, IA_SERVICE_TOKEN: corto }).join(' ')).not.toContain(corto);
  });

  it('IA_URL es host:puerto', () => {
    expect(problemas(cargarConfig, { ...apiBase, IA_URL: 'http://127.0.0.1:4210' })).toEqual([expect.stringMatching(/^IA_URL: /)]);
  });

  it('producción: exige el token y TLS mutuo o red privada', () => {
    expect(problemas(cargarConfig, { ...apiProduccion, ...TLS })).toEqual([]);
    expect(problemas(cargarConfig, { ...apiProduccion, IA_RED_PRIVADA: 'true' })).toEqual([]);
    expect(problemas(cargarConfig, apiProduccion)).toEqual(['IA_TLS_CERT: en producción hace falta TLS mutuo (IA_TLS_*) o IA_RED_PRIVADA=true']);
    expect(problemas(cargarConfig, { ...apiProduccion, IA_RED_PRIVADA: 'true', IA_SERVICE_TOKEN: undefined })).toEqual(['IA_SERVICE_TOKEN: obligatorio en producción']);
  });

  it('TLS: los tres archivos o ninguno (también fuera de producción)', () => {
    expect(problemas(cargarConfig, { ...apiBase, IA_TLS_CERT: 'certs/api.crt' })).toEqual(['IA_TLS_CERT: TLS mutuo necesita IA_TLS_CERT, IA_TLS_KEY e IA_TLS_CA (los tres)']);
  });
});

describe('servicio de IA (proceso aparte)', () => {
  it('desarrollo: 127.0.0.1:4210, proveedor simulado; el token es obligatorio siempre', () => {
    expect(cargarConfigIa({ IA_SERVICE_TOKEN: TOKEN_IA })).toMatchObject({ IA_HOST: '127.0.0.1', IA_PORT: 4210, AI_PROVIDER: 'mock', IA_MOCK_RETRASO_MS: 40 });
    expect(problemas(cargarConfigIa, {})).toEqual([expect.stringMatching(/^IA_SERVICE_TOKEN: falta/)]);
  });

  it('AI_PROVIDER=anthropic exige su clave', () => {
    expect(problemas(cargarConfigIa, { IA_SERVICE_TOKEN: TOKEN_IA, AI_PROVIDER: 'anthropic' })).toEqual(['ANTHROPIC_API_KEY: obligatoria con AI_PROVIDER=anthropic']);
    expect(problemas(cargarConfigIa, { IA_SERVICE_TOKEN: TOKEN_IA, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: CLAVE_FICTICIA })).toEqual([]);
  });

  it('producción: sin simulado, y con TLS mutuo o red privada', () => {
    const prod = { NODE_ENV: 'production', IA_SERVICE_TOKEN: TOKEN_IA, AI_PROVIDER: 'anthropic', ANTHROPIC_API_KEY: CLAVE_FICTICIA };
    expect(problemas(cargarConfigIa, { ...prod, ...TLS })).toEqual([]);
    expect(problemas(cargarConfigIa, { ...prod, IA_RED_PRIVADA: 'true' })).toEqual([]);
    expect(problemas(cargarConfigIa, prod)).toEqual(['IA_TLS_CERT: en producción hace falta TLS mutuo (IA_TLS_*) o IA_RED_PRIVADA=true']);
    expect(problemas(cargarConfigIa, { ...prod, IA_RED_PRIVADA: 'true', AI_PROVIDER: 'mock' })).toEqual(['AI_PROVIDER: en producción no se permite el proveedor "mock"']);
  });
});
