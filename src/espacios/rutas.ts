// /api/espacios: espacios, sus miembros y crear o listar sus documentos (bloque K1). Todo exige sesión.
// Quién puede qué está en src/contenido/acceso.ts.
import { Router } from 'express';
import { crearLimitador, limitarTasa } from '../auth/limites.js';
import { requiereSesion, usuarioDe } from '../auth/middleware.js';
import type { DependenciasApi } from '../dependencias.js';
import { crearDocumento, listarDocumentos } from '../documentos/servicio.js';
import {
  AgregarMiembroSolicitud,
  CambiarRolSolicitud,
  IdEspacio,
  IdMiembro,
  NombreEspacioSolicitud,
  TituloDocumentoSolicitud,
  TransferirSolicitud,
} from '../http/esquemas.js';
import {
  agregarMiembro,
  cambiarRolMiembro,
  crearEspacio,
  eliminarEspacio,
  listarEspacios,
  listarMiembros,
  obtenerEspacio,
  quitarMiembro,
  renombrarEspacio,
  transferirEspacio,
} from './servicio.js';

export const LIMITES_ESPACIOS = {
  /** Agregar miembros por correo, por cuenta: acota la enumeración de correos de cuentas activas. */
  agregar_miembro: { max: 30, ventanaMs: 15 * 60_000 },
} as const;

export function rutasEspacios(d: DependenciasApi): Router {
  const r = Router();
  r.use(requiereSesion(d));
  const limAgregar = limitarTasa(
    crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'agregar_miembro', ...LIMITES_ESPACIOS.agregar_miembro }),
    (_req, res) => `cuenta:${usuarioDe(res).id}`,
  );

  // ─── Espacios ─────────────────────────────────────────────────────────────────
  r.get('/', async (_req, res) => {
    res.json({ espacios: await listarEspacios(d, usuarioDe(res).id) });
  });

  r.post('/', async (req, res) => {
    const { nombre } = NombreEspacioSolicitud.parse(req.body);
    res.status(201).json(await crearEspacio(d, usuarioDe(res), nombre));
  });

  r.get('/:espacioId', async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    res.json(await obtenerEspacio(d, usuarioDe(res).id, espacioId));
  });

  r.patch('/:espacioId', async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    const { nombre } = NombreEspacioSolicitud.parse(req.body);
    res.json(await renombrarEspacio(d, usuarioDe(res).id, espacioId, nombre));
  });

  r.delete('/:espacioId', async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    res.json(await eliminarEspacio(d, usuarioDe(res).id, espacioId));
  });

  r.post('/:espacioId/propiedad', async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    const { usuarioId } = TransferirSolicitud.parse(req.body);
    res.json({ miembros: await transferirEspacio(d, usuarioDe(res).id, espacioId, usuarioId) });
  });

  // ─── Miembros ─────────────────────────────────────────────────────────────────
  r.get('/:espacioId/miembros', async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    res.json({ miembros: await listarMiembros(d, usuarioDe(res).id, espacioId) });
  });

  r.post('/:espacioId/miembros', limAgregar, async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    const e = AgregarMiembroSolicitud.parse(req.body);
    res.status(201).json(await agregarMiembro(d, usuarioDe(res).id, espacioId, e));
  });

  r.patch('/:espacioId/miembros/:usuarioId', async (req, res) => {
    const { espacioId, usuarioId } = IdMiembro.parse(req.params);
    const { rol } = CambiarRolSolicitud.parse(req.body);
    res.json(await cambiarRolMiembro(d, usuarioDe(res).id, espacioId, usuarioId, rol));
  });

  r.delete('/:espacioId/miembros/:usuarioId', async (req, res) => {
    const { espacioId, usuarioId } = IdMiembro.parse(req.params);
    await quitarMiembro(d, usuarioDe(res).id, espacioId, usuarioId);
    res.status(204).end();
  });

  // ─── Documentos del espacio ───────────────────────────────────────────────────
  r.get('/:espacioId/documentos', async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    res.json({ documentos: await listarDocumentos(d, usuarioDe(res).id, espacioId) });
  });

  r.post('/:espacioId/documentos', async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    const { titulo } = TituloDocumentoSolicitud.parse(req.body);
    res.status(201).json(await crearDocumento(d, usuarioDe(res), espacioId, titulo));
  });

  return r;
}
