import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { cargarConfig, ErrorConfig } from '../../src/config/entorno.js';

const CLAVE = randomBytes(32).toString('base64');
const TOKEN = 'x'.repeat(40);

const base = {
  DATABASE_URL: 'postgresql://cuaderno_app:clave@127.0.0.1:5435/cuaderno',
  REDIS_URL: 'redis://127.0.0.1:6381/0',
  MFA_ENCRYPTION_KEY: CLAVE,
  ACCESS_TOKEN_SECRET: randomBytes(32).toString('base64'),
};

const produccionValida = {
  ...base,
  NODE_ENV: 'production',
  REDIS_URL: 'redis://:clave-redis@redis.example.com:6379/0',
  METRICS_TOKEN: TOKEN,
  AI_PROVIDER: 'anthropic',
  EMAIL_PROVIDER: 'ses',
  GEO_PROVIDER: 'tabla_local',
  APP_URL: 'https://cuaderno.example.com',
  SES_REGION: 'us-east-1',
  IA_SERVICE_TOKEN: randomBytes(32).toString('base64url'),
  IA_RED_PRIVADA: 'true',
};

function problemas(env: Record<string, string | undefined>): string[] {
  try {
    cargarConfig(env);
    return [];
  } catch (e) {
    if (e instanceof ErrorConfig) return e.problemas;
    throw e;
  }
}

describe('cargarConfig', () => {
  it('aplica los valores por defecto de desarrollo', () => {
    const c = cargarConfig(base);
    expect(c).toMatchObject({
      NODE_ENV: 'development',
      HOST: '127.0.0.1',
      PORT: 4200,
      LOG_LEVEL: 'info',
      SHUTDOWN_TIMEOUT_MS: 10_000,
      TRUST_PROXY: false,
      AI_PROVIDER: 'mock',
      EMAIL_PROVIDER: 'mock',
      GEO_PROVIDER: 'mock',
    });
    expect(c.METRICS_TOKEN).toBeUndefined();
  });

  it('una variable vacía cuenta como no definida', () => {
    expect(cargarConfig({ ...base, METRICS_TOKEN: '' }).METRICS_TOKEN).toBeUndefined();
  });

  it('exige MFA_ENCRYPTION_KEY de exactamente 32 bytes en base64', () => {
    expect(problemas({ ...base, MFA_ENCRYPTION_KEY: undefined })).toEqual([expect.stringMatching(/^MFA_ENCRYPTION_KEY: falta/)]);
    expect(problemas({ ...base, MFA_ENCRYPTION_KEY: randomBytes(16).toString('base64') })).toEqual([
      expect.stringMatching(/^MFA_ENCRYPTION_KEY: debe ser exactamente 32 bytes/),
    ]);
    expect(problemas({ ...base, MFA_ENCRYPTION_KEY: 'no es base64!!' })).toHaveLength(1);
  });

  it('valida las URL de base y Redis', () => {
    expect(problemas({ ...base, DATABASE_URL: 'mysql://x@h/db' })).toEqual([expect.stringMatching(/^DATABASE_URL:/)]);
    expect(problemas({ ...base, REDIS_URL: 'http://127.0.0.1:6381' })).toEqual([expect.stringMatching(/^REDIS_URL:/)]);
  });

  it('valida puerto, tiempos y enumerados', () => {
    expect(problemas({ ...base, PORT: '70000' })).toEqual([expect.stringMatching(/^PORT:/)]);
    expect(problemas({ ...base, SHUTDOWN_TIMEOUT_MS: '10' })).toEqual([expect.stringMatching(/^SHUTDOWN_TIMEOUT_MS:/)]);
    expect(problemas({ ...base, AI_PROVIDER: 'openai' })).toEqual([expect.stringMatching(/^AI_PROVIDER:/)]);
    expect(problemas({ ...base, TRUST_PROXY: 'si' })).toEqual([expect.stringMatching(/^TRUST_PROXY:/)]);
  });

  it('nunca incluye el valor de un secreto en los mensajes', () => {
    const secreto = 'secreto-que-no-debe-aparecer';
    const msgs = problemas({ ...base, MFA_ENCRYPTION_KEY: secreto, METRICS_TOKEN: secreto.slice(0, 10) });
    expect(msgs.join('\n')).not.toContain(secreto.slice(0, 10));
  });

  it('una configuración de producción completa es válida', () => {
    expect(problemas(produccionValida)).toEqual([]);
  });

  it('producción se niega a arrancar con CUALQUIER proveedor mock (y los lista todos)', () => {
    expect(problemas({ ...produccionValida, AI_PROVIDER: 'mock', EMAIL_PROVIDER: 'mock', GEO_PROVIDER: 'mock' })).toEqual([
      'AI_PROVIDER: en producción no se permite el proveedor "mock"',
      'EMAIL_PROVIDER: en producción no se permite el proveedor "mock"',
      'GEO_PROVIDER: en producción no se permite el proveedor "mock"',
    ]);
    expect(problemas({ ...produccionValida, EMAIL_PROVIDER: undefined })).toEqual([
      'EMAIL_PROVIDER: en producción no se permite el proveedor "mock"',
    ]);
  });

  it('producción exige METRICS_TOKEN', () => {
    expect(problemas({ ...produccionValida, METRICS_TOKEN: undefined })).toEqual(['METRICS_TOKEN: obligatorio en producción']);
  });

  it('producción exige Redis con contraseña o TLS', () => {
    expect(problemas({ ...produccionValida, REDIS_URL: 'redis://redis.example.com:6379/0' })).toEqual([
      'REDIS_URL: en producción Redis necesita contraseña o TLS (rediss://)',
    ]);
    expect(problemas({ ...produccionValida, REDIS_URL: 'rediss://redis.example.com:6380/0' })).toEqual([]);
  });

  it('desarrollo acepta proveedores mock y Redis sin contraseña', () => {
    expect(problemas({ ...base, NODE_ENV: 'development' })).toEqual([]);
  });
  it('sesión y cuentas: valores por defecto seguros', () => {
    expect(cargarConfig(base)).toMatchObject({ APP_URL: 'http://127.0.0.1:5175', COOKIE_SECURE: true, PASSWORD_HASH_COST: 15, EMAIL_FROM: 'cuaderno@example.com' });
  });

  it('exige ACCESS_TOKEN_SECRET de 32+ bytes', () => {
    expect(problemas({ ...base, ACCESS_TOKEN_SECRET: undefined })).toEqual([expect.stringMatching(/^ACCESS_TOKEN_SECRET: falta/)]);
    expect(problemas({ ...base, ACCESS_TOKEN_SECRET: randomBytes(16).toString('base64') })).toEqual([
      expect.stringMatching(/^ACCESS_TOKEN_SECRET: debe ser de al menos 32 bytes/),
    ]);
  });

  it('APP_URL debe ser solo un origen', () => {
    expect(problemas({ ...base, APP_URL: 'http://127.0.0.1:5175/app' })).toEqual(['APP_URL: debe ser solo el origen, sin ruta']);
  });

  it('EMAIL_PROVIDER=ses exige SES_REGION (también fuera de producción)', () => {
    expect(problemas({ ...base, EMAIL_PROVIDER: 'ses' })).toEqual(['SES_REGION: obligatoria con EMAIL_PROVIDER=ses']);
    expect(problemas({ ...base, EMAIL_PROVIDER: 'ses', SES_REGION: 'us-east-1' })).toEqual([]);
  });

  it('producción exige APP_URL https, cookie Secure y scrypt con costo 15+', () => {
    expect(problemas({ ...produccionValida, APP_URL: 'http://cuaderno.example.com' })).toEqual(['APP_URL: en producción debe usar https://']);
    expect(problemas({ ...produccionValida, COOKIE_SECURE: 'false' })).toEqual(['COOKIE_SECURE: en producción debe ser true']);
    expect(problemas({ ...produccionValida, PASSWORD_HASH_COST: '12' })).toEqual(['PASSWORD_HASH_COST: en producción debe ser 15 o más']);
  });

  it('desarrollo admite costo de hash bajo (las pruebas usan 10)', () => {
    expect(problemas({ ...base, PASSWORD_HASH_COST: '10' })).toEqual([]);
  });
});
