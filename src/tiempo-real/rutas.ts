// POST /api/tiempo-real/tickets: ticket de un solo uso para abrir el WebSocket de un documento (ADR 0002).
// Exige sesión y ALGÚN acceso al documento; si no, 404 (no se revela si existe).
import { Router } from 'express';
import { crearLimitador, limitarTasa } from '../auth/limites.js';
import { requiereSesion, usuarioDe } from '../auth/middleware.js';
import { exigirDocumento } from '../contenido/acceso.js';
import type { DependenciasApi } from '../dependencias.js';
import { SolicitudTicket } from '../http/esquemas.js';
import { LIMITES_PRODUCCION } from './limites.js';
import { emitirTicket } from './tickets.js';

export const LIMITE_TICKETS = { max: 60, ventanaMs: 60_000 } as const;

export function rutasTiempoReal(d: DependenciasApi, vigenciaMs = LIMITES_PRODUCCION.ticketMs): Router {
  const r = Router();
  r.use(requiereSesion(d));
  const lim = limitarTasa(
    crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'ticket_rt', ...LIMITE_TICKETS }),
    (_req, res) => `cuenta:${usuarioDe(res).id}`,
  );

  r.post('/tickets', lim, async (req, res) => {
    const { documentoId } = SolicitudTicket.parse(req.body);
    const u = usuarioDe(res);
    await exigirDocumento(d.prisma, u.id, documentoId, 'lector', '');
    const ticket = await emitirTicket(d.redis, d.prefijoRedis, { usuarioId: u.id, sesionId: u.sesionId, documentoId }, vigenciaMs);
    res.status(201).json({ ticket, expiraEnSegundos: Math.round(vigenciaMs / 1000) });
  });

  return r;
}
