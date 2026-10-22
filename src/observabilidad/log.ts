import { pino, type DestinationStream, type Logger, type LevelWithSilent } from 'pino';

/** Nunca se registran credenciales ni secretos, aunque alguien loguee el objeto entero. */
export const RUTAS_REDACTADAS = [
  'req.headers.authorization',
  'req.headers.cookie',
  'res.headers["set-cookie"]',
  '*.contrasena',
  '*.password',
  '*.token',
  '*.secreto',
  '*.codigo_mfa',
];

export function crearLogger(nivel: LevelWithSilent, destino?: DestinationStream, servicio = 'cuaderno-api'): Logger {
  const opciones = {
    level: nivel,
    base: { servicio },
    redact: { paths: RUTAS_REDACTADAS, censor: '[REDACTADO]' },
  };
  return destino ? pino(opciones, destino) : pino(opciones);
}
