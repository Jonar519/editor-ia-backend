// /api/documentos/:documentoId/{texto,versiones}: el historial de versiones (bloque N). Todo exige sesión.
// Quién puede qué está en src/versiones/servicio.ts.
import { Router } from 'express';
import { crearLimitador, limitarTasa } from '../auth/limites.js';
import { requiereSesion, usuarioDe } from '../auth/middleware.js';
import type { DependenciasApi } from '../dependencias.js';
import { IdDocumento, IdVersion } from '../http/esquemas.js';
import { crearVersion, listarVersiones, obtenerVersion, restaurarVersion, textoActual, verificarCadena } from './servicio.js';

export const LIMITES_VERSIONES = {
  /** Guardar y restaurar, por cuenta: cada versión copia el documento entero (hasta 10 MiB). */
  versiones: { max: 30, ventanaMs: 60 * 60_000 },
  /** Verificar, por cuenta: la base recalcula el SHA-256 de cada versión (hasta 20 MiB cada una). */
  verificar: { max: 10, ventanaMs: 60_000 },
} as const;

export function rutasVersiones(d: DependenciasApi): Router {
  const r = Router();
  r.use(requiereSesion(d));
  const lim = limitarTasa(
    crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'versiones', ...LIMITES_VERSIONES.versiones }),
    (_req, res) => `cuenta:${usuarioDe(res).id}`,
  );
  const limVerificar = limitarTasa(
    crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'verificar-versiones', ...LIMITES_VERSIONES.verificar }),
    (_req, res) => `cuenta:${usuarioDe(res).id}`,
  );

  r.get('/:documentoId/texto', async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    res.json({ texto: await textoActual(d, usuarioDe(res).id, documentoId) });
  });

  r.get('/:documentoId/versiones', async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    res.json({ versiones: await listarVersiones(d, usuarioDe(res).id, documentoId) });
  });

  r.post('/:documentoId/versiones', lim, async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    res.status(201).json(await crearVersion(d, usuarioDe(res), documentoId));
  });

  // Antes de /:numero: "verificacion" no es un número.
  r.get('/:documentoId/versiones/verificacion', limVerificar, async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    res.json(await verificarCadena(d, usuarioDe(res).id, documentoId));
  });

  r.get('/:documentoId/versiones/:numero', async (req, res) => {
    const { documentoId, numero } = IdVersion.parse(req.params);
    res.json(await obtenerVersion(d, usuarioDe(res).id, documentoId, numero));
  });

  r.post('/:documentoId/versiones/:numero/restaurar', lim, async (req, res) => {
    const { documentoId, numero } = IdVersion.parse(req.params);
    res.status(201).json(await restaurarVersion(d, usuarioDe(res), documentoId, numero));
  });

  return r;
}
