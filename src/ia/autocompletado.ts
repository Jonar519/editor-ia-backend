// Autocompletado por el WebSocket del documento (ADR 0002, decisión 3): lo que el servidor de tiempo real
// necesita de la IA. El permiso (editor o propietario) lo verifica el servidor de tiempo real con el rol
// de la conexión; aquí van la corriente gRPC, el tope diario (solo tokens) y el registro del uso.
import type { Bd } from '../contenido/acceso.js';
import type { ClienteIa, OrigenIa, SesionAutocompletado } from './cliente.js';
import type { Uso } from './proveedor.js';
import { registrarUso, reservarUso, type TopesIa } from './uso.js';

/** Contexto que se manda al servicio: lo último antes del cursor y lo primero después (recortado por el API). */
export const CONTEXTO_AUTOCOMPLETADO = { antes: 2000, despues: 500 } as const;

export interface IaTiempoReal {
  /** Una corriente bidireccional por conexión de edición (se abre con el primer pedido). */
  sesion(origen: OrigenIa): SesionAutocompletado;
  /** Tope diario de tokens (el autocompletado no cuenta como petición). Lanza 429 tope_diario_ia. */
  reservar(usuarioId: string): Promise<void>;
  registrar(usuarioId: string, uso: Uso): Promise<void>;
}

export function iaTiempoReal(ia: ClienteIa, bd: Bd, topes: TopesIa): IaTiempoReal {
  return {
    sesion: (origen) => ia.autocompletado(origen),
    reservar: (usuarioId) => reservarUso(bd, usuarioId, topes, false),
    registrar: (usuarioId, uso) => registrarUso(bd, usuarioId, uso),
  };
}
