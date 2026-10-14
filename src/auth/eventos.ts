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
  | 'contrasena_restablecida';

export async function registrarEvento(db: Tx, tipo: TipoEvento, usuarioId: string | null, ipRed: string | null): Promise<void> {
  await db.$executeRaw`
    INSERT INTO eventos_seguridad (tipo, usuario_id, ip_red) VALUES (${tipo}, ${usuarioId}::uuid, ${ipRed}::cidr)`;
}
