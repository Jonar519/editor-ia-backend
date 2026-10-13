// Configuración validada con zod al arrancar. Un valor inválido detiene el proceso con la lista de
// problemas (nombres de variable y motivo; nunca el valor, que puede ser un secreto).
import { z } from 'zod';

/** Proveedores externos intercambiables. "mock" es el valor por defecto y está prohibido en producción. */
export const PROVEEDORES = {
  AI_PROVIDER: ['mock', 'anthropic'],
  EMAIL_PROVIDER: ['mock', 'ses'],
  GEO_PROVIDER: ['mock', 'tabla_local'],
} as const;

/** Variables vacías en .env ("CLAVE=") cuentan como no definidas. */
const opcional = <T extends z.ZodType>(esquema: T) =>
  z.preprocess((v) => (v === '' ? undefined : v), esquema.optional());

const claveAes256 = z
  .string({ error: 'falta: genérala con scripts\\env-init.bat (ver .env.example)' })
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length === 32, {
    error: 'debe ser exactamente 32 bytes en base64 (AES-256)',
  });

const esquema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    HOST: z.string().min(1).default('127.0.0.1'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4200),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
    TRUST_PROXY: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
    DATABASE_URL: z.url({ protocol: /^postgres(ql)?$/, error: 'debe ser una URL postgresql://' }),
    REDIS_URL: z.url({ protocol: /^rediss?$/, error: 'debe ser una URL redis:// o rediss://' }),
    MFA_ENCRYPTION_KEY: claveAes256,
    METRICS_TOKEN: opcional(z.string().min(32, { error: 'debe tener 32+ caracteres' })),
    AI_PROVIDER: z.enum(PROVEEDORES.AI_PROVIDER).default('mock'),
    EMAIL_PROVIDER: z.enum(PROVEEDORES.EMAIL_PROVIDER).default('mock'),
    GEO_PROVIDER: z.enum(PROVEEDORES.GEO_PROVIDER).default('mock'),
  })
  .superRefine((c, ctx) => {
    if (c.NODE_ENV !== 'production') return;
    for (const clave of Object.keys(PROVEEDORES) as (keyof typeof PROVEEDORES)[]) {
      if (c[clave] === 'mock') {
        ctx.addIssue({ code: 'custom', path: [clave], message: 'en producción no se permite el proveedor "mock"' });
      }
    }
    if (c.METRICS_TOKEN === undefined) {
      ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'obligatorio en producción' });
    }
    const redis = new URL(c.REDIS_URL);
    if (redis.password === '' && redis.protocol !== 'rediss:') {
      ctx.addIssue({ code: 'custom', path: ['REDIS_URL'], message: 'en producción Redis necesita contraseña o TLS (rediss://)' });
    }
  });

export type Config = z.output<typeof esquema>;

export class ErrorConfig extends Error {
  constructor(readonly problemas: string[]) {
    super(`Configuración inválida:\n${problemas.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ErrorConfig';
  }
}

/** Valida el entorno y devuelve la configuración tipada, o lanza ErrorConfig con TODOS los problemas. */
export function cargarConfig(env: Record<string, string | undefined>): Config {
  const r = esquema.safeParse(env);
  if (r.success) return r.data;
  throw new ErrorConfig(r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`));
}
