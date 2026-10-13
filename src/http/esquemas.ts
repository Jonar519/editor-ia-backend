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
