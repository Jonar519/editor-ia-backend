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

/** Valores por defecto (los mismos de IA_TOPE_PETICIONES_DIA e IA_TOPE_TOKENS_DIA; el servidor usa la config). */
export const TOPES_IA: TopesIa = { peticionesDia: 300, tokensDia: 300_000 };

/** Presupuesto diario del indexado automático por espacio (IA_TOPE_INDEXADO_ESPACIO_DIA). */
export const TOPE_INDEXADO_ESPACIO = 200_000;

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

/**
 * Presupuesto diario del indexado AUTOMÁTICO por espacio (uso_ia_indexado_diario, migración 0023). Reserva
 * `estimado` tokens si caben en `tope`, en una sola sentencia (dos trabajos a la vez no pasan los dos el
 * último lugar). Devuelve false si no caben: el indexado se pospone al día siguiente.
 */
export async function reservarIndexadoEspacio(bd: Bd, espacioId: string, estimado: number, tope: number): Promise<boolean> {
  if (estimado > tope) return false;
  const filas = await bd.$queryRaw<{ ok: number }[]>`
    INSERT INTO uso_ia_indexado_diario AS u (espacio_id, dia, tokens)
    VALUES (${espacioId}::uuid, (now() AT TIME ZONE 'UTC')::date, ${estimado}::bigint)
    ON CONFLICT (espacio_id, dia) DO UPDATE SET tokens = u.tokens + EXCLUDED.tokens
      WHERE u.tokens + EXCLUDED.tokens <= ${tope}::bigint
    RETURNING 1 AS ok`;
  return filas.length > 0;
}

/** Corrige la reserva con lo que informó el servicio (nunca por debajo de cero). */
export async function ajustarIndexadoEspacio(bd: Bd, espacioId: string, diferencia: number): Promise<void> {
  if (diferencia === 0) return;
  await bd.$executeRaw`
    UPDATE uso_ia_indexado_diario SET tokens = greatest(tokens + ${diferencia}::bigint, 0)
    WHERE espacio_id = ${espacioId}::uuid AND dia = (now() AT TIME ZONE 'UTC')::date`;
}

/** El uso de hoy de una cuenta (GET /api/ia/uso). */
export async function usoDeHoy(bd: Bd, usuarioId: string): Promise<{ peticiones: number; tokensEntrada: number; tokensSalida: number }> {
  const filas = await bd.$queryRaw<{ peticiones: number; tokens_entrada: bigint; tokens_salida: bigint }[]>`
    SELECT peticiones, tokens_entrada, tokens_salida FROM uso_ia_diario
    WHERE usuario_id = ${usuarioId}::uuid AND dia = (now() AT TIME ZONE 'UTC')::date`;
  const f = filas[0];
  return { peticiones: f?.peticiones ?? 0, tokensEntrada: Number(f?.tokens_entrada ?? 0), tokensSalida: Number(f?.tokens_salida ?? 0) };
}

/** Suma los tokens que informó el servicio (o la estimación, si la persona canceló a mitad). */
export async function registrarUso(bd: Bd, usuarioId: string, uso: Uso): Promise<void> {
  await bd.$executeRaw`
    INSERT INTO uso_ia_diario AS u (usuario_id, dia, tokens_entrada, tokens_salida)
    VALUES (${usuarioId}::uuid, (now() AT TIME ZONE 'UTC')::date, ${uso.entrada}::bigint, ${uso.salida}::bigint)
    ON CONFLICT (usuario_id, dia) DO UPDATE
      SET tokens_entrada = u.tokens_entrada + EXCLUDED.tokens_entrada, tokens_salida = u.tokens_salida + EXCLUDED.tokens_salida`;
}
