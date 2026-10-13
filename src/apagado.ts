// Apagado ordenado: ante SIGTERM/SIGINT el servidor deja de aceptar conexiones, marca /ready como 503,
// espera a que terminen las peticiones en curso (hasta un límite) y cierra base y Redis una sola vez.
import type { Server } from 'node:http';
import type { Logger } from 'pino';
import type { EstadoProceso } from './http/salud.js';

export interface OpcionesApagado {
  servidor: Server;
  estado: EstadoProceso;
  cerrarRecursos: () => Promise<void>;
  log: Logger;
  limiteMs: number;
}

/** Devuelve apagar(motivo). Es idempotente: llamarla varias veces devuelve la misma promesa. */
export function crearApagado(o: OpcionesApagado): (motivo: string) => Promise<void> {
  let enCurso: Promise<void> | undefined;
  return (motivo) => {
    enCurso ??= new Promise<void>((resolver) => {
      o.log.info({ motivo }, 'apagado ordenado: dejo de aceptar conexiones');
      o.estado.apagando = true;
      const forzar = setTimeout(() => {
        o.log.warn({ limiteMs: o.limiteMs }, 'apagado: se agotó el tiempo, corto las conexiones que quedan');
        o.servidor.closeAllConnections();
      }, o.limiteMs);
      forzar.unref();
      o.servidor.close(() => {
        clearTimeout(forzar);
        o.cerrarRecursos().then(
          () => {
            o.log.info('apagado: recursos cerrados');
            resolver();
          },
          (err: unknown) => {
            o.log.error({ err }, 'apagado: error al cerrar recursos');
            resolver();
          },
        );
      });
      // Las conexiones keep-alive sin petición en curso se cierran ya; las ocupadas terminan su respuesta.
      o.servidor.closeIdleConnections();
    });
    return enCurso;
  };
}
