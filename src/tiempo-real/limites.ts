// Límites de operación del servidor en tiempo real (aprobados por escrito al abrir K2; ADR 0002 y 0003).
// Las pruebas pueden acortar los tiempos (por ejemplo, revalidar cada 300 ms); producción usa estos.

export interface LimitesTiempoReal {
  /** Vigencia de un ticket de conexión. */
  ticketMs: number;
  /** Tamaño máximo de un mensaje (el mismo CHECK de actualizaciones_documento). */
  mensajeBytes: number;
  /** Mensajes por segundo por conexión; más, cierre 4429. */
  mensajesPorSegundo: number;
  /** Tamaño máximo del estado del documento (CHECK de documentos.estado_yjs). */
  documentoBytes: number;
  /** Cola de envío sin entregar a un cliente lento; más, cierre 1013. */
  colaEnvioBytes: number;
  /** Latido: ping cada tanto; sin pong en `pongMs`, cierre 4408. */
  pingMs: number;
  pongMs: number;
  /** Revalidación periódica del rol y la sesión de cada conexión (riesgo residual R-01). */
  revalidarMs: number;
  /** Un documento se descarga de memoria este tiempo después de que se va la última conexión. */
  descargarMs: number;
  /** Vaciado del búfer de persistencia: cada tanto, o al llegar a este tamaño. */
  vaciarMs: number;
  vaciarBytes: number;
  /** Actualizaciones descartadas (de quien no puede escribir) que cierran la conexión, dentro de la ventana. */
  descartadasMax: number;
  descartadasVentanaMs: number;
  /** Compactación: a las N filas sin compactar, o este tiempo después de la última edición. */
  compactarFilas: number;
  compactarInactividadMs: number;
}

export const LIMITES_PRODUCCION: LimitesTiempoReal = {
  ticketMs: 30_000,
  mensajeBytes: 1024 * 1024,
  mensajesPorSegundo: 60,
  documentoBytes: 10 * 1024 * 1024,
  colaEnvioBytes: 4 * 1024 * 1024,
  pingMs: 30_000,
  pongMs: 10_000,
  revalidarMs: 30_000,
  descargarMs: 60_000,
  vaciarMs: 250,
  vaciarBytes: 256 * 1024,
  descartadasMax: 3,
  descartadasVentanaMs: 60_000,
  compactarFilas: 200,
  compactarInactividadMs: 5 * 60_000,
};

/** Códigos de cierre propios (ADR 0002). */
export const CIERRE = {
  malFormado: 4400,
  sesionTerminada: 4401,
  sinPermiso: 4403,
  documentoNoExiste: 4404,
  sinLatido: 4408,
  documentoDemasiadoGrande: 4413,
  demasiadosMensajes: 4429,
  apagado: 1001,
  mensajeDemasiadoGrande: 1009,
  sobrecarga: 1013,
} as const;
