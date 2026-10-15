// /api/usuarios/{id}/avatar: el avatar (ya limpio) de una cuenta activa, para cualquier sesión válida
// (se muestra en la presencia y en los comentarios). La respuesta no se interpreta como documento: CSP
// sin nada permitido y sandbox, además del nosniff de helmet.
import { Router } from 'express';
import { requiereSesion } from '../auth/middleware.js';
import { leerAvatar } from '../cuenta/avatar.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import { IdUsuario } from '../http/esquemas.js';

export function rutasUsuarios(d: DependenciasApi): Router {
  const r = Router();
  r.use(requiereSesion(d));

  r.get('/:usuarioId/avatar', async (req, res) => {
    const { usuarioId } = IdUsuario.parse(req.params);
    const a = await leerAvatar(d, usuarioId);
    if (!a) throw new ErrorHttp(404, 'sin_avatar', 'Esta cuenta no tiene avatar');
    const etag = `"${a.hash}"`;
    res.setHeader('Cache-Control', 'private, no-cache');
    res.setHeader('ETag', etag);
    res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    res.setHeader('Content-Disposition', 'inline; filename="avatar"');
    if (req.headers['if-none-match'] === etag) {
      res.status(304).end();
      return;
    }
    res.type(a.tipo).send(a.datos);
  });

  return r;
}
