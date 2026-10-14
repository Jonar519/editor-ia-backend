// Esquemas zod de las respuestas. Son la fuente de la especificación OpenAPI (src/openapi.ts):
// el documento se genera desde aquí, no se escribe a mano.
import { z } from 'zod';

export const ErrorRespuesta = z
  .object({
    error: z.object({
      codigo: z.string().meta({ example: 'no_encontrado' }),
      mensaje: z.string(),
      solicitud: z.string().meta({ description: 'Id de la solicitud (cabecera x-request-id) para buscarla en el log' }),
      detalles: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ErrorRespuesta' });

export const SaludRespuesta = z.object({ estado: z.literal('ok') }).meta({ id: 'SaludRespuesta' });

export const EstadoComprobacion = z.enum(['ok', 'falla']);

export const ListoRespuesta = z
  .object({
    estado: z.enum(['listo', 'no_listo', 'apagando']),
    comprobaciones: z.record(z.string(), EstadoComprobacion).meta({
      description: 'Resultado de cada dependencia (bd, esquema, redis). Sin detalles internos: el motivo va al log.',
    }),
  })
  .meta({ id: 'ListoRespuesta' });

export type ListoRespuesta = z.infer<typeof ListoRespuesta>;

// ─── Autenticación e invitaciones (bloque E) ──────────────────────────────────────

/** Correo normalizado: sin espacios y en minúsculas (la base compara con citext). */
export const Correo = z
  .email({ error: 'correo inválido' })
  .max(254)
  .transform((c) => c.trim().toLowerCase());

export const Rol = z.enum(['admin', 'editor', 'lector']);

export const UsuarioPublico = z
  .object({ id: z.uuid(), nombre: z.string(), correo: z.string(), rol: Rol })
  .meta({ id: 'UsuarioPublico' });

export const InicioSesionSolicitud = z
  .object({ correo: Correo, contrasena: z.string().min(1).max(1000) })
  .meta({ id: 'InicioSesionSolicitud' });

export const SesionRespuesta = z
  .object({
    accessToken: z.string().meta({ description: 'JWT HS256 de 15 min. Guárdalo SOLO en memoria.' }),
    expiraEn: z.number().int().meta({ description: 'Vencimiento del access token (segundos Unix)' }),
    usuario: UsuarioPublico,
  })
  .meta({ id: 'SesionRespuesta', description: 'Además fija la cookie httpOnly cuaderno_refresco (SameSite=Strict, Path=/api/auth).' });

export type SesionRespuesta = z.infer<typeof SesionRespuesta>;

export const YoRespuesta = z.object({ usuario: UsuarioPublico }).meta({ id: 'YoRespuesta' });

export const InvitacionSolicitud = z
  .object({
    nombre: z.string().trim().min(1).max(80),
    correo: Correo,
    rol: Rol,
  })
  .meta({ id: 'InvitacionSolicitud' });

export const InvitacionCreada = z
  .object({
    usuario: UsuarioPublico.extend({ estado: z.literal('pendiente') }),
    expiraEn: z.iso.datetime(),
    correoEnviado: z.boolean().meta({ description: 'false si el proveedor de correo falló: se puede reenviar' }),
  })
  .meta({ id: 'InvitacionCreada', description: 'NUNCA incluye el enlace ni el token: solo los recibe la persona invitada.' });

export const InvitacionPendiente = z
  .object({ usuarioId: z.uuid(), nombre: z.string(), correo: z.string(), rol: Rol, expiraEn: z.iso.datetime(), vencida: z.boolean() })
  .meta({ id: 'InvitacionPendiente' });

export const ListaInvitaciones = z
  .object({ total: z.number().int(), invitaciones: z.array(InvitacionPendiente) })
  .meta({ id: 'ListaInvitaciones' });

/** Paginación de listados: ?limite=1..200 (50 por defecto) y ?desde=0.. */
export const PaginaListado = z.object({
  limite: z.coerce.number().int().min(1).max(200).default(50),
  desde: z.coerce.number().int().min(0).default(0),
});

/** Token de invitación: 32 bytes en base64url. Viaja en el cuerpo, nunca en la URL. */
export const TokenInvitacion = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/, { error: 'token inválido' }) }).meta({ id: 'TokenInvitacion' });

export const InvitacionConsulta = z
  .object({ nombre: z.string(), correo: z.string(), rol: Rol, requiereMfa: z.boolean(), expiraEn: z.iso.datetime() })
  .meta({ id: 'InvitacionConsulta' });

export const CompletarInvitacion = TokenInvitacion.extend({ contrasena: z.string().min(1).max(1000) }).meta({ id: 'CompletarInvitacion' });

export const IdUsuario = z.object({ usuarioId: z.uuid() });
