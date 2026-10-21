// Registro de auditoría (tabla eventos_seguridad, de solo inserción). Solo tipo, cuenta e IP truncada:
// la tabla no tiene columnas de texto libre, así que aquí nunca puede terminar un token ni una contraseña.
import type { Tx } from './sesiones.js';

export type TipoEvento =
  | 'inicio_sesion'
  | 'inicio_fallido'
  | 'cuenta_bloqueada'
  | 'cierre_sesion'
  | 'refresco_reutilizado'
  | 'mfa_desafio'
  | 'mfa_correcto'
  | 'mfa_fallido'
  | 'codigo_respaldo_usado'
  | 'mfa_activado'
  | 'mfa_desactivado'
  | 'codigos_respaldo_regenerados'
  | 'invitacion_creada'
  | 'invitacion_reenviada'
  | 'invitacion_cancelada'
  | 'invitacion_completada'
  | 'recuperacion_solicitada'
  | 'contrasena_restablecida'
  | 'perfil_actualizado'
  | 'cambio_correo_solicitado'
  | 'correo_cambiado'
  | 'contrasena_cambiada'
  | 'sesion_cerrada'
  | 'otras_sesiones_cerradas'
  | 'avatar_actualizado'
  | 'avatar_eliminado'
  | 'datos_exportados'
  // Bloque K2: concesión y revocación de miembros, permisos y propiedad (las creaciones no se registran).
  | 'miembro_agregado'
  | 'miembro_rol_cambiado'
  | 'miembro_quitado'
  | 'espacio_transferido'
  | 'espacio_eliminado'
  | 'permiso_documento_dado'
  | 'permiso_documento_quitado'
  | 'documento_transferido'
  | 'documento_eliminado';

/**
 * @param extra objetivoId: la cuenta afectada; recursoId: el id del espacio o documento (solo un id,
 *   nunca nombres ni contenido).
 */
export async function registrarEvento(
  db: Tx,
  tipo: TipoEvento,
  usuarioId: string | null,
  ipRed: string | null,
  extra: { objetivoId?: string; recursoId?: string } = {},
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO eventos_seguridad (tipo, usuario_id, ip_red, objetivo_id, recurso_id)
    VALUES (${tipo}, ${usuarioId}::uuid, ${ipRed}::cidr, ${extra.objetivoId ?? null}::uuid, ${extra.recursoId ?? null}::uuid)`;
}
