import { Router } from 'express';
import { limiteGeneral } from './auth/limites.js';
import { rutasAuth } from './auth/rutas.js';
import { rutasComentarios, rutasComentariosDeDocumento } from './comentarios/rutas.js';
import { rutasCuenta } from './cuenta/rutas.js';
import type { DependenciasApi } from './dependencias.js';
import { rutasDocumentos } from './documentos/rutas.js';
import { rutasEspacios } from './espacios/rutas.js';
import { rutasIa } from './ia/rutas.js';
import { rutasAdminInvitaciones, rutasInvitacionPublica } from './invitaciones/rutas.js';
import { rutasTiempoReal } from './tiempo-real/rutas.js';
import { rutasUsuarios } from './usuarios/rutas.js';
import { rutasVersiones } from './versiones/rutas.js';

/** Todas las rutas del API bajo /api. */
export function crearApi(d: DependenciasApi): Router {
  const api = Router();
  // Las respuestas del API pueden llevar tokens o datos personales: ni el navegador ni un proxy las guardan.
  api.use((_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
  // R-07: antes que cualquier ruta, el límite general por cuenta.
  api.use(limiteGeneral({ redis: d.redis, prefijo: d.prefijoRedis, claveAcceso: d.claveAcceso, ...(d.limitePedidosMinuto ? { max: d.limitePedidosMinuto } : {}) }));
  api.use('/auth', rutasAuth(d));
  api.use('/invitaciones', rutasInvitacionPublica(d));
  api.use('/cuenta', rutasCuenta(d));
  api.use('/usuarios', rutasUsuarios(d));
  api.use('/admin/invitaciones', rutasAdminInvitaciones(d));
  // IA (bloque P1): búsqueda e indexado van ANTES de espacios y documentos para no pasar dos veces por la sesión.
  const ia = rutasIa(d);
  api.use('/ia', ia.ia);
  api.use('/espacios', ia.busqueda);
  api.use('/documentos', ia.indice);
  api.use('/espacios', rutasEspacios(d));
  api.use('/documentos', rutasDocumentos(d));
  api.use('/documentos', rutasVersiones(d));
  api.use('/documentos', rutasComentariosDeDocumento(d));
  api.use('/comentarios', rutasComentarios(d));
  api.use('/tiempo-real', rutasTiempoReal(d));
  return api;
}
