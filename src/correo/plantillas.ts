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

/** Re-verificación del correo NUEVO. Como los demás, el token va en el FRAGMENTO del enlace. */
export function correoCambioCorreo(d: { para: string; nombre: string; appUrl: string; token: string; expiraEn: Date }): MensajeCorreo {
  const enlace = `${d.appUrl.replace(/\/$/, '')}/#/correo/${d.token}`;
  return {
    para: d.para,
    plantilla: 'cambio_correo',
    asunto: 'Confirma tu nuevo correo de Cuaderno',
    texto: [
      `Hola, ${d.nombre}:`,
      '',
      'Pediste usar esta dirección en tu cuenta de Cuaderno. Para confirmarla, abre este enlace:',
      '',
      enlace,
      '',
      `Sirve una sola vez y vence el ${fecha(d.expiraEn)}. Hasta que lo abras, tu cuenta sigue con el correo anterior.`,
      'Si no lo pediste, ignora este correo.',
    ].join('\n'),
  };
}

/**
 * Oculta un correo para mostrarlo a otra dirección: "an***@example.com". El aviso al correo anterior
 * dice A QUÉ dirección se pidió el cambio sin revelarla entera.
 */
export function correoOculto(correo: string): string {
  const [local = '', dominio = ''] = correo.split('@');
  return `${local.slice(0, 2)}***@${dominio}`;
}

/** Aviso al correo ANTERIOR: se pidió el cambio, o ya se hizo. Sin enlaces. */
export function correoAvisoCambioCorreo(d: { para: string; nombre: string; correoNuevo: string; momento: 'solicitado' | 'realizado' }): MensajeCorreo {
  const nuevo = correoOculto(d.correoNuevo);
  return {
    para: d.para,
    plantilla: 'aviso_cambio_correo',
    asunto: d.momento === 'solicitado' ? 'Se pidió cambiar el correo de tu cuenta de Cuaderno' : 'El correo de tu cuenta de Cuaderno cambió',
    texto: [
      `Hola, ${d.nombre}:`,
      '',
      d.momento === 'solicitado'
        ? `Se pidió cambiar el correo de tu cuenta de Cuaderno a ${nuevo}. El cambio se hace solo si se confirma desde esa dirección.`
        : `El correo de tu cuenta de Cuaderno ahora es ${nuevo}. Desde ahora los avisos llegan a esa dirección.`,
      'Si no fuiste tú, cambia tu contraseña y contacta de inmediato a la administración de tu espacio.',
    ].join('\n'),
  };
}

/** Aviso tras CAMBIAR la contraseña desde la cuenta: se cerraron las demás sesiones. */
export function correoAvisoCambioContrasena(d: { para: string; nombre: string }): MensajeCorreo {
  return {
    para: d.para,
    plantilla: 'aviso_cambio_contrasena',
    asunto: 'Tu contraseña de Cuaderno cambió',
    texto: [
      `Hola, ${d.nombre}:`,
      '',
      'La contraseña de tu cuenta de Cuaderno acaba de cambiar y se cerraron tus demás sesiones.',
      'Si no fuiste tú, restablécela desde "¿Olvidaste tu contraseña?" y contacta a la administración de tu espacio.',
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
