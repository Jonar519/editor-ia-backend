import { SendEmailCommand } from '@aws-sdk/client-sesv2';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { correoInvitacion } from '../../src/correo/plantillas.js';
import { correoMock, correoSes, crearProveedorCorreo } from '../../src/correo/proveedor.js';
import { correoUnico, entornoApi, type EntornoApi } from '../_api.js';

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});

const mensaje = (para: string) =>
  correoInvitacion({ para, nombre: 'Ana', rol: 'editor', appUrl: 'http://127.0.0.1:5175/', token: 'T'.repeat(43), expiraEn: new Date('2026-10-16T12:00:00Z') });

describe('proveedor de correo', () => {
  it('la plantilla de invitación pone el token en el fragmento y dice cuándo vence', () => {
    const m = mensaje('ana@example.com');
    expect(m.texto).toContain(`http://127.0.0.1:5175/#/invitacion/${'T'.repeat(43)}`);
    expect(m.texto).toContain('2026-10-16 12:00 (UTC)');
  });

  it('mock: guarda el correo en el buzón simulado con retención de 7 días', async () => {
    const para = correoUnico('buzon');
    await correoMock(e.prisma).enviar(mensaje(para));
    const fila = await e.prisma.correos_simulados.findFirstOrThrow({ where: { para } });
    expect(fila.plantilla).toBe('invitacion');
    const dias = (fila.expira_en.getTime() - fila.creado_en.getTime()) / 86_400_000;
    expect(dias).toBeGreaterThan(6.99);
    expect(dias).toBeLessThanOrEqual(7);
  });

  it('SES: arma el SendEmailCommand con remitente, destinatario, asunto y texto', async () => {
    const enviados: SendEmailCommand[] = [];
    const ses = correoSes({ send: (c) => (enviados.push(c), Promise.resolve({})) }, 'cuaderno@example.com');
    await ses.enviar(mensaje('ana@example.com'));
    const entrada = enviados[0]?.input;
    expect(entrada?.FromEmailAddress).toBe('cuaderno@example.com');
    expect(entrada?.Destination?.ToAddresses).toEqual(['ana@example.com']);
    expect(entrada?.Content?.Simple?.Subject?.Data).toBe('Te invitaron a Cuaderno');
    expect(entrada?.Content?.Simple?.Body?.Text?.Data).toContain('/#/invitacion/');
  });

  it('elige el proveedor según la configuración', () => {
    expect(crearProveedorCorreo({ EMAIL_PROVIDER: 'mock', EMAIL_FROM: 'a@example.com' }, e.prisma).nombre).toBe('mock');
    expect(crearProveedorCorreo({ EMAIL_PROVIDER: 'ses', EMAIL_FROM: 'a@example.com', SES_REGION: 'us-east-1' }, e.prisma).nombre).toBe('ses');
  });
});
