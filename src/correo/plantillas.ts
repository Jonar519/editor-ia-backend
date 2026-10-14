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

const fecha = (d: Date) => `${d.toISOString().replace('T', ' ').slice(0, 16)} (UTC)`;

/** Recuperación de contraseña. Igual que la invitación, el token va en el FRAGMENTO del enlace. */
export function correoRecuperacion(d: { para: string; nombre: string; appUrl: string; token: string; expiraEn: Date }): MensajeCorreo {
  const enlace = `${d.appUrl.replace(/\/$/, '')}/#/recuperar/${d.token}`;
  return {
    para: d.para,
    plantilla: 'recuperacion',
    asunto: 'Restablecer tu contraseña de Cuaderno',
    texto: [
      `Hola, ${d.nombre}:`,
      '',
      'Alguien pidió restablecer la contraseña de tu cuenta de Cuaderno. Si fuiste tú, abre este enlace:',
      '',
      enlace,
      '',
      `Sirve una sola vez y vence el ${fecha(d.expiraEn)}. Al usarlo se cierran todas tus sesiones.`,
      'Si no lo pediste, ignora este correo: tu contraseña no cambia.',
    ].join('\n'),
  };
}

/** Aviso tras restablecer la contraseña (sin enlaces ni datos sensibles). */
export function correoAvisoContrasena(d: { para: string; nombre: string }): MensajeCorreo {
  return {
    para: d.para,
    plantilla: 'aviso_cambio_contrasena',
    asunto: 'Tu contraseña de Cuaderno cambió',
    texto: [
      `Hola, ${d.nombre}:`,
      '',
      'La contraseña de tu cuenta de Cuaderno acaba de cambiar y se cerraron todas tus sesiones.',
      'Si no fuiste tú, contacta de inmediato a la administración de tu espacio.',
    ].join('\n'),
  };
}
