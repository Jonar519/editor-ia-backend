// Configuración del SERVICIO de IA (proceso aparte, src/ia/principal.ts), validada con zod al arrancar.
// Comparte el .env con el API; cada proceso lee solo sus variables. Mismo trato que src/config/entorno.ts:
// ante un valor inválido, la lista de problemas (nombre y motivo, nunca el valor) y exit 1.
import { z } from 'zod';
import { ErrorConfig, PROVEEDORES, reglaTransporte, tokenServicio, transporteIa } from '../config/entorno.js';

const opcional = <T extends z.ZodType>(esquema: T) => z.preprocess((v) => (v === '' ? undefined : v), esquema.optional());

const esquema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
    SHUTDOWN_TIMEOUT_MS: z.coerce.number().int().min(100).max(120_000).default(10_000),
    IA_HOST: z.string().min(1).default('127.0.0.1'),
    IA_PORT: z.coerce.number().int().min(1).max(65535).default(4210),
    IA_SERVICE_TOKEN: tokenServicio,
    AI_PROVIDER: z.enum(PROVEEDORES.AI_PROVIDER).default('mock'),
    ANTHROPIC_API_KEY: opcional(z.string().min(20, { error: 'parece incompleta' })),
    ...transporteIa,
    /** Pausa del simulado entre fragmentos (para que el streaming se vea en la demo). */
    IA_MOCK_RETRASO_MS: z.coerce.number().int().min(0).max(5000).default(40),
  })
  .superRefine((c, ctx) => {
    if (c.AI_PROVIDER === 'anthropic' && c.ANTHROPIC_API_KEY === undefined) {
      ctx.addIssue({ code: 'custom', path: ['ANTHROPIC_API_KEY'], message: 'obligatoria con AI_PROVIDER=anthropic' });
    }
    reglaTransporte(c, ctx);
    if (c.NODE_ENV === 'production' && c.AI_PROVIDER === 'mock') {
      ctx.addIssue({ code: 'custom', path: ['AI_PROVIDER'], message: 'en producción no se permite el proveedor "mock"' });
    }
  });

export type ConfigIa = z.output<typeof esquema>;

export function cargarConfigIa(env: Record<string, string | undefined>): ConfigIa {
  const r = esquema.safeParse(env);
  if (r.success) return r.data;
  throw new ErrorConfig(r.error.issues.map((i) => `${i.path.join('.') || '(raíz)'}: ${i.message}`));
}
