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

const claveHmac = z
  .string({ error: 'falta: genérala con scripts\\env-init.bat (ver .env.example)' })
  .refine((v) => /^[A-Za-z0-9+/]+={0,2}$/.test(v) && Buffer.from(v, 'base64').length >= 32, {
    error: 'debe ser de al menos 32 bytes en base64',
  });

/** Token entre el API y el servicio de IA: 32+ bytes aleatorios en base64url (env-init.bat lo genera). */
export const tokenServicio = z
  .string({ error: 'falta: genéralo con scripts\\env-init.bat (ver .env.example)' })
  .refine((v) => /^[A-Za-z0-9_-]+$/.test(v) && Buffer.from(v, 'base64url').length >= 32, {
    error: 'debe ser de al menos 32 bytes en base64url',
  });

/** Transporte API ↔ servicio de IA: los MISMOS nombres en los dos procesos (cada uno con sus archivos). */
export const transporteIa = {
  IA_TLS_CERT: opcional(z.string()),
  IA_TLS_KEY: opcional(z.string()),
  IA_TLS_CA: opcional(z.string()),
  IA_RED_PRIVADA: z.enum(['true', 'false']).default('false').transform((v) => v === 'true'),
};

/**
 * Regla de transporte (ADR 0002): en producción, TLS MUTUO (los tres archivos) o una red privada declarada
 * a propósito (IA_RED_PRIVADA=true); sin una de las dos, el proceso no arranca. Fuera de producción, texto
 * plano en 127.0.0.1. Con TLS van los tres archivos o ninguno.
 */
export function reglaTransporte(
  c: { NODE_ENV: string; IA_TLS_CERT?: string | undefined; IA_TLS_KEY?: string | undefined; IA_TLS_CA?: string | undefined; IA_RED_PRIVADA: boolean },
  ctx: z.RefinementCtx,
): void {
  const tls = [c.IA_TLS_CERT, c.IA_TLS_KEY, c.IA_TLS_CA].filter((x) => x !== undefined).length;
  if (tls !== 0 && tls !== 3) {
    ctx.addIssue({ code: 'custom', path: ['IA_TLS_CERT'], message: 'TLS mutuo necesita IA_TLS_CERT, IA_TLS_KEY e IA_TLS_CA (los tres)' });
  }
  if (c.NODE_ENV === 'production' && tls === 0 && !c.IA_RED_PRIVADA) {
    ctx.addIssue({ code: 'custom', path: ['IA_TLS_CERT'], message: 'en producción hace falta TLS mutuo (IA_TLS_*) o IA_RED_PRIVADA=true' });
  }
}

/** Costo mínimo de scrypt en producción: N = 2^15. */
export const COSTO_HASH_MINIMO_PRODUCCION = 15;

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
    ACCESS_TOKEN_SECRET: claveHmac,
    METRICS_TOKEN: opcional(z.string().min(32, { error: 'debe tener 32+ caracteres' })),
    APP_URL: z.url({ protocol: /^https?$/, error: 'debe ser una URL http(s):// sin ruta' }).default('http://127.0.0.1:5175'),
    COOKIE_SECURE: z.enum(['true', 'false']).default('true').transform((v) => v === 'true'),
    PASSWORD_HASH_COST: z.coerce.number().int().min(10).max(20).default(COSTO_HASH_MINIMO_PRODUCCION),
    EMAIL_FROM: z.email({ error: 'debe ser un correo' }).default('cuaderno@example.com'),
    SES_REGION: opcional(z.string().regex(/^[a-z]{2}-[a-z]+-\d$/, { error: 'región AWS inválida (ej. us-east-1)' })),
    AI_PROVIDER: z.enum(PROVEEDORES.AI_PROVIDER).default('mock'),
    EMAIL_PROVIDER: z.enum(PROVEEDORES.EMAIL_PROVIDER).default('mock'),
    GEO_PROVIDER: z.enum(PROVEEDORES.GEO_PROVIDER).default('mock'),
    // Servicio de IA (proceso aparte, bloque P1). Sin token fuera de producción: el API arranca sin IA
    // (sus rutas responden 503 ia_no_disponible y /ready la muestra como "falla").
    IA_URL: z.string().regex(/^[A-Za-z0-9.-]+:\d{1,5}$/, { error: 'debe ser host:puerto (ej. 127.0.0.1:4210)' }).default('127.0.0.1:4210'),
    IA_SERVICE_TOKEN: opcional(tokenServicio),
    ...transporteIa,
    // Topes de IA (bloque P2): por cuenta y día UTC, y el presupuesto del indexado automático por espacio.
    IA_TOPE_PETICIONES_DIA: z.coerce.number().int().min(1).max(1_000_000).default(300),
    IA_TOPE_TOKENS_DIA: z.coerce.number().int().min(1).max(1_000_000_000).default(300_000),
    IA_TOPE_INDEXADO_ESPACIO_DIA: z.coerce.number().int().min(1).max(1_000_000_000).default(200_000),
    // Similitud coseno mínima de un resultado de búsqueda. Se recalibra con el modelo real.
    IA_SIMILITUD_MINIMA: z.coerce.number().min(0, { error: 'entre 0 y 1' }).max(1, { error: 'entre 0 y 1' }).default(0.2),
    // Límite general de /api por cuenta (riesgo R-07). La medición de su costo (R3) lo sube para que no corte.
    LIMITE_PEDIDOS_MINUTO: z.coerce.number().int().min(1).max(1_000_000_000).default(600),
  })
  .superRefine((c, ctx) => {
    reglaTransporte(c, ctx);
    if (c.EMAIL_PROVIDER === 'ses' && c.SES_REGION === undefined) {
      ctx.addIssue({ code: 'custom', path: ['SES_REGION'], message: 'obligatoria con EMAIL_PROVIDER=ses' });
    }
    if (new URL(c.APP_URL).pathname !== '/') {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'debe ser solo el origen, sin ruta' });
    }
    if (c.NODE_ENV !== 'production') return;
    if (!c.APP_URL.startsWith('https://')) {
      ctx.addIssue({ code: 'custom', path: ['APP_URL'], message: 'en producción debe usar https://' });
    }
    if (!c.COOKIE_SECURE) {
      ctx.addIssue({ code: 'custom', path: ['COOKIE_SECURE'], message: 'en producción debe ser true' });
    }
    if (c.PASSWORD_HASH_COST < COSTO_HASH_MINIMO_PRODUCCION) {
      ctx.addIssue({ code: 'custom', path: ['PASSWORD_HASH_COST'], message: `en producción debe ser ${String(COSTO_HASH_MINIMO_PRODUCCION)} o más` });
    }
    for (const clave of Object.keys(PROVEEDORES) as (keyof typeof PROVEEDORES)[]) {
      if (c[clave] === 'mock') {
        ctx.addIssue({ code: 'custom', path: [clave], message: 'en producción no se permite el proveedor "mock"' });
      }
    }
    if (c.METRICS_TOKEN === undefined) {
      ctx.addIssue({ code: 'custom', path: ['METRICS_TOKEN'], message: 'obligatorio en producción' });
    }
    if (c.IA_SERVICE_TOKEN === undefined) {
      ctx.addIssue({ code: 'custom', path: ['IA_SERVICE_TOKEN'], message: 'obligatorio en producción' });
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

/** Para puntos de entrada (servidor, CLI): ante una configuración inválida, lista los problemas y sale con 1. */
export function cargarConfigOSalir(env: Record<string, string | undefined>): Config {
  try {
    return cargarConfig(env);
  } catch (e) {
    if (e instanceof ErrorConfig) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
}

/** Valida el entorno y devuelve la configuración tipada, o lanza ErrorConfig con TODOS los problemas. */
export function cargarConfig(env: Record<string, string | undefined>): Config {
  const r = esquema.safeParse(env);
  if (r.success) return r.data;
  throw new ErrorConfig(r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`));
}
