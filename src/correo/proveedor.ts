// Proveedor de correo intercambiable: "mock" (por defecto) guarda el correo en la tabla
// correos_simulados, que hace de buzón de la demo; "ses" lo envía con AWS SES v2.
import { SendEmailCommand, SESv2Client } from '@aws-sdk/client-sesv2';
import type { PrismaClient } from '../generated/prisma/client.js';

export type PlantillaCorreo = 'invitacion' | 'recuperacion' | 'cambio_correo' | 'aviso_cambio_correo' | 'aviso_cambio_contrasena';

export interface MensajeCorreo {
  para: string;
  plantilla: PlantillaCorreo;
  asunto: string;
  texto: string;
}

export interface ProveedorCorreo {
  nombre: 'mock' | 'ses';
  enviar: (m: MensajeCorreo) => Promise<void>;
}

/** Retención del buzón simulado en días (la base no admite más de 7). */
const RETENCION_MOCK_DIAS = 7;

export function correoMock(prisma: PrismaClient): ProveedorCorreo {
  return {
    nombre: 'mock',
    enviar: async (m) => {
      // El vencimiento lo calcula la base con su reloj: con el del servidor de aplicación, un desfase de
      // milisegundos violaba el CHECK de retención (expira_en <= creado_en + 7 días).
      await prisma.$executeRaw`
        INSERT INTO correos_simulados (para, plantilla, asunto, cuerpo_texto, expira_en)
        VALUES (${m.para}, ${m.plantilla}, ${m.asunto}, ${m.texto}, now() + make_interval(days => ${RETENCION_MOCK_DIAS}::int))`;
    },
  };
}

/** Lo único que usamos del cliente SES (permite probarlo sin AWS). */
export interface ClienteSes {
  send: (comando: SendEmailCommand) => Promise<unknown>;
}

export function correoSes(cliente: ClienteSes, remitente: string): ProveedorCorreo {
  return {
    nombre: 'ses',
    enviar: async (m) => {
      await cliente.send(
        new SendEmailCommand({
          FromEmailAddress: remitente,
          Destination: { ToAddresses: [m.para] },
          Content: {
            Simple: {
              Subject: { Data: m.asunto, Charset: 'UTF-8' },
              Body: { Text: { Data: m.texto, Charset: 'UTF-8' } },
            },
          },
        }),
      );
    },
  };
}

export function crearProveedorCorreo(
  c: { EMAIL_PROVIDER: 'mock' | 'ses'; EMAIL_FROM: string; SES_REGION?: string | undefined },
  prisma: PrismaClient,
): ProveedorCorreo {
  if (c.EMAIL_PROVIDER === 'ses') {
    // Credenciales: cadena estándar del SDK (rol de la instancia, perfil o AWS_*), nunca en .env.
    // La configuración ya exige SES_REGION cuando EMAIL_PROVIDER=ses.
    return correoSes(new SESv2Client(c.SES_REGION ? { region: c.SES_REGION } : {}), c.EMAIL_FROM);
  }
  return correoMock(prisma);
}
