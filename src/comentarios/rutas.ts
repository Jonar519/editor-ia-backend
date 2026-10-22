// Comentarios anclados (bloque N): listar y crear bajo /api/documentos/:documentoId/comentarios; editar,
// resolver y borrar en /api/comentarios/:comentarioId. Todo exige sesión. Quién puede qué está en
// src/comentarios/servicio.ts.
import { Router } from 'express';
import { crearLimitador, limitarTasa } from '../auth/limites.js';
import { requiereSesion, usuarioDe } from '../auth/middleware.js';
import type { DependenciasApi } from '../dependencias.js';
import { CambiarComentarioSolicitud, ComentarioSolicitud, IdComentario, IdDocumento } from '../http/esquemas.js';
import { borrarComentario, cambiarComentario, crearComentario, listarComentarios } from './servicio.js';

export const LIMITES_COMENTARIOS = {
  /** Comentar, por cuenta. */
  comentar: { max: 60, ventanaMs: 10 * 60_000 },
} as const;

export function rutasComentariosDeDocumento(d: DependenciasApi): Router {
  const r = Router();
  r.use(requiereSesion(d));
  const lim = limitarTasa(
    crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'comentar', ...LIMITES_COMENTARIOS.comentar }),
    (_req, res) => `cuenta:${usuarioDe(res).id}`,
  );

  r.get('/:documentoId/comentarios', async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    res.json({ comentarios: await listarComentarios(d, usuarioDe(res).id, documentoId) });
  });

  r.post('/:documentoId/comentarios', lim, async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    res.status(201).json(await crearComentario(d, usuarioDe(res).id, documentoId, ComentarioSolicitud.parse(req.body)));
  });

  return r;
}

export function rutasComentarios(d: DependenciasApi): Router {
  const r = Router();
  r.use(requiereSesion(d));

  r.patch('/:comentarioId', async (req, res) => {
    const { comentarioId } = IdComentario.parse(req.params);
    res.json(await cambiarComentario(d, usuarioDe(res).id, comentarioId, CambiarComentarioSolicitud.parse(req.body)));
  });

  r.delete('/:comentarioId', async (req, res) => {
    const { comentarioId } = IdComentario.parse(req.params);
    await borrarComentario(d, usuarioDe(res).id, comentarioId);
    res.status(204).end();
  });

  return r;
}
