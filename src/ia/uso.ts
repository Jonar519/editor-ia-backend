// Tope diario de IA por cuenta (tabla uso_ia_diario, migración 0011; día en UTC). Se RESERVA antes de
// llamar al servicio con un solo INSERT … ON CONFLICT DO UPDATE … WHERE condicional (atómico: dos pedidos
// a la vez no pasan los dos el último lugar) y los tokens se suman después, con lo que informó el servicio.
import type { Bd } from '../contenido/acceso.js';
import { ErrorHttp } from '../http/errores.js';
import type { Uso } from './proveedor.js';

export interface TopesIa {
  /** Pedidos por día (explicar, resumir, mejorar, buscar, indexar). El autocompletado no cuenta aquí. */
  peticionesDia: number;
  /** Tokens (entrada + salida) por día, de TODO lo anterior más el autocompletado. */
  tokensDia: number;
}

export const TOPES_IA: TopesIa = { peticionesDia: 300, tokensDia: 300_000 };

/** Segundos hasta la próxima medianoche UTC (cuando se renueva el tope). */
export const segundosHastaManana = (ahora = Date.now()): number => 86_400 - (Math.floor(ahora / 1000) % 86_400);

export function topeAlcanzado(): ErrorHttp {
  return new ErrorHttp(429, 'tope_diario_ia', 'Llegaste al uso diario de la IA. Se renueva a medianoche (UTC).', { reintentarEnS: segundosHastaManana() });
}

/**
 * Reserva un uso para hoy o lanza 429 tope_diario_ia. Con `contarPeticion` false (autocompletado) solo
 * mira los tokens. El tope de peticiones también frena las demás aunque queden tokens.
 */
export async function reservarUso(bd: Bd, usuarioId: string, topes: TopesIa, contarPeticion = true): Promise<void> {
  const suma = contarPeticion ? 1 : 0;
  const filas = await bd.$queryRaw<{ ok: number }[]>`
    INSERT INTO uso_ia_diario AS u (usuario_id, dia, peticiones)
    VALUES (${usuarioId}::uuid, (now() AT TIME ZONE 'UTC')::date, ${suma}::int)
    ON CONFLICT (usuario_id, dia) DO UPDATE SET peticiones = u.peticiones + ${suma}::int
      WHERE (${!contarPeticion}::boolean OR u.peticiones < ${topes.peticionesDia}::int)
        AND u.tokens_entrada + u.tokens_salida < ${topes.tokensDia}::bigint
    RETURNING 1 AS ok`;
  if (filas.length === 0) throw topeAlcanzado();
}

/** Suma los tokens que informó el servicio (o la estimación, si la persona canceló a mitad). */
export async function registrarUso(bd: Bd, usuarioId: string, uso: Uso): Promise<void> {
  await bd.$executeRaw`
    INSERT INTO uso_ia_diario AS u (usuario_id, dia, tokens_entrada, tokens_salida)
    VALUES (${usuarioId}::uuid, (now() AT TIME ZONE 'UTC')::date, ${uso.entrada}::bigint, ${uso.salida}::bigint)
    ON CONFLICT (usuario_id, dia) DO UPDATE
      SET tokens_entrada = u.tokens_entrada + EXCLUDED.tokens_entrada, tokens_salida = u.tokens_salida + EXCLUDED.tokens_salida`;
}
