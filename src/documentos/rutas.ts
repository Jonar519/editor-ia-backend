// /api/documentos/:documentoId: metadatos de un documento y sus permisos propios (bloque K1). El contenido
// se edita por el WebSocket (bloque K2). Crear y listar están bajo /api/espacios/:espacioId/documentos.
import { Router } from 'express';
import { truncarIp } from '../auth/cliente.js';
import { requiereSesion, usuarioDe } from '../auth/middleware.js';
import type { DependenciasApi } from '../dependencias.js';
import { DarPermisoSolicitud, IdDocumento, IdPermiso, TituloDocumentoSolicitud, TransferirSolicitud } from '../http/esquemas.js';
import {
  darPermiso,
  eliminarDocumento,
  listarPermisos,
  obtenerDocumento,
  quitarPermiso,
  renombrarDocumento,
  transferirDocumento,
} from './servicio.js';

export function rutasDocumentos(d: DependenciasApi): Router {
  const r = Router();
  r.use(requiereSesion(d));

  r.get('/:documentoId', async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    res.json(await obtenerDocumento(d, usuarioDe(res).id, documentoId));
  });

  r.patch('/:documentoId', async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    const { titulo } = TituloDocumentoSolicitud.parse(req.body);
    res.json(await renombrarDocumento(d, usuarioDe(res).id, documentoId, titulo));
  });

  r.delete('/:documentoId', async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    await eliminarDocumento(d, usuarioDe(res).id, documentoId, truncarIp(req.ip));
    res.status(204).end();
  });

  r.post('/:documentoId/propiedad', async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    const { usuarioId } = TransferirSolicitud.parse(req.body);
    res.json({ permisos: await transferirDocumento(d, usuarioDe(res).id, documentoId, usuarioId, truncarIp(req.ip)) });
  });

  r.get('/:documentoId/permisos', async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    res.json({ permisos: await listarPermisos(d, usuarioDe(res).id, documentoId) });
  });

  r.put('/:documentoId/permisos/:usuarioId', async (req, res) => {
    const { documentoId, usuarioId } = IdPermiso.parse(req.params);
    DarPermisoSolicitud.parse(req.body);
    res.json({ permisos: await darPermiso(d, usuarioDe(res).id, documentoId, usuarioId, truncarIp(req.ip)) });
  });

  r.delete('/:documentoId/permisos/:usuarioId', async (req, res) => {
    const { documentoId, usuarioId } = IdPermiso.parse(req.params);
    await quitarPermiso(d, usuarioDe(res).id, documentoId, usuarioId, truncarIp(req.ip));
    res.status(204).end();
  });

  return r;
}
