// /api/admin/invitaciones (solo admin) y /api/invitaciones (pública, para quien recibió el enlace).
import { Router } from 'express';
import { truncarIp, userAgentCorto } from '../auth/cliente.js';
import { claveIp, crearLimitador, limitarTasa } from '../auth/limites.js';
import { requiereRol, requiereSesion, usuarioDe } from '../auth/middleware.js';
import type { DependenciasApi } from '../dependencias.js';
import { ponerCookieRefresco } from '../http/cookies.js';
import { CompletarConMfa, IdUsuario, InvitacionSolicitud, PaginaListado, TokenInvitacion } from '../http/esquemas.js';
import { cancelar, completar, consultar, iniciarMfaInvitacion, invitar, listarPendientes, reenviar, type Invitado } from './servicio.js';

export const LIMITES_INVITACION = {
  /** Envíos de invitación por admin. */
  invitar: { max: 50, ventanaMs: 60 * 60_000 },
  /** Consultas y completados por IP (los tokens tienen 256 bits, pero no se regala fuerza bruta). */
  publico: { max: 30, ventanaMs: 15 * 60_000 },
} as const;

const cuerpoInvitado = (i: Invitado) => ({ usuario: i.usuario, expiraEn: i.expiraEn.toISOString(), correoEnviado: i.correoEnviado });

export function rutasAdminInvitaciones(d: DependenciasApi): Router {
  const r = Router();
  const limInvitar = crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'invitar', ...LIMITES_INVITACION.invitar });
  r.use(requiereSesion(d), requiereRol('admin'));
  const porAdmin = limitarTasa(limInvitar, (_req, res) => `admin:${usuarioDe(res).id}`);

  r.get('/', async (req, res) => {
    const { limite, desde } = PaginaListado.parse(req.query);
    res.json(await listarPendientes(d, { limite, desde }));
  });

  r.post('/', porAdmin, async (req, res) => {
    const e = InvitacionSolicitud.parse(req.body);
    const i = await invitar(d, { invitadaPor: usuarioDe(res).id, ...e, ipRed: truncarIp(req.ip) });
    res.status(201).json(cuerpoInvitado(i));
  });

  r.post('/:usuarioId/reenviar', porAdmin, async (req, res) => {
    const { usuarioId } = IdUsuario.parse(req.params);
    res.json(cuerpoInvitado(await reenviar(d, usuarioId, truncarIp(req.ip))));
  });

  r.delete('/:usuarioId', async (req, res) => {
    const { usuarioId } = IdUsuario.parse(req.params);
    await cancelar(d, usuarioId, truncarIp(req.ip));
    res.status(204).end();
  });

  return r;
}

export function rutasInvitacionPublica(d: DependenciasApi): Router {
  const r = Router();
  const lim = limitarTasa(crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'invitacion', ...LIMITES_INVITACION.publico }), claveIp);

  // El token viaja en el CUERPO (nunca en la URL) para no quedar en logs ni en el historial.
  r.post('/consultar', lim, async (req, res) => {
    const { token } = TokenInvitacion.parse(req.body);
    res.json(await consultar(d, token));
  });

  // Admin pendiente: obtiene el secreto TOTP (y el otpauth:// para el QR) ANTES de completar.
  r.post('/mfa', lim, async (req, res) => {
    const { token } = TokenInvitacion.parse(req.body);
    res.json(await iniciarMfaInvitacion(d, token));
  });

  r.post('/completar', lim, async (req, res) => {
    const { token, contrasena, codigoTotp } = CompletarConMfa.parse(req.body);
    const r2 = await completar(d, {
      token,
      contrasena,
      codigoTotp,
      ipRed: truncarIp(req.ip),
      userAgent: userAgentCorto(req.headers['user-agent']),
    });
    ponerCookieRefresco(res, r2.sesion.refresh, r2.sesion.expiraEn, d.cookieSegura);
    res.status(201).json(r2.codigosRespaldo ? { ...r2.respuesta, codigosRespaldo: r2.codigosRespaldo } : r2.respuesta);
  });

  return r;
}
