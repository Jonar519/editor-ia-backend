import type { MensajeCorreo } from './proveedor.js';

const ROLES = { admin: 'administración', editor: 'edición', lector: 'lectura' } as const;

/**
 * Invitación. El token va en el FRAGMENTO (#/invitacion/<token>): los navegadores no envían el
 * fragmento al servidor ni en el Referer, así que no queda en logs de servidores ni de proxies.
 */
export function correoInvitacion(d: {
  para: string;
  nombre: string;
  rol: keyof typeof ROLES;
  appUrl: string;
  token: string;
  expiraEn: Date;
}): MensajeCorreo {
  const enlace = `${d.appUrl.replace(/\/$/, '')}/#/invitacion/${d.token}`;
  return {
    para: d.para,
    plantilla: 'invitacion',
    asunto: 'Te invitaron a Cuaderno',
    texto: [
      `Hola, ${d.nombre}:`,
      '',
      `Te invitaron a Cuaderno con permisos de ${ROLES[d.rol]}.`,
      'Para crear tu cuenta, abre este enlace y elige tu contraseña:',
      '',
      enlace,
      '',
      `El enlace es personal, sirve una sola vez y vence el ${d.expiraEn.toISOString().replace('T', ' ').slice(0, 16)} (UTC).`,
      'Si no esperabas esta invitación, ignora este correo.',
    ].join('\n'),
  };
}
