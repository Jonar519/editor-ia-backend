import { Router } from 'express';
import { rutasAuth } from './auth/rutas.js';
import { rutasCuenta } from './cuenta/rutas.js';
import type { DependenciasApi } from './dependencias.js';
import { rutasAdminInvitaciones, rutasInvitacionPublica } from './invitaciones/rutas.js';
import { rutasUsuarios } from './usuarios/rutas.js';

/** Todas las rutas del API bajo /api. */
export function crearApi(d: DependenciasApi): Router {
  const api = Router();
  // Las respuestas del API pueden llevar tokens o datos personales: ni el navegador ni un proxy las guardan.
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  api.use('/auth', rutasAuth(d));
  api.use('/invitaciones', rutasInvitacionPublica(d));
  api.use('/cuenta', rutasCuenta(d));
  api.use('/usuarios', rutasUsuarios(d));
  api.use('/admin/invitaciones', rutasAdminInvitaciones(d));
  return api;
}
