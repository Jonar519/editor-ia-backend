// /api/auth: iniciar sesión, refrescar (rotación), cerrar sesión y "quién soy".
import { Router, type Request } from 'express';
import type { DependenciasApi } from '../dependencias.js';
import { borrarCookieRefresco, COOKIE_REFRESCO, leerCookie, ponerCookieRefresco } from '../http/cookies.js';
import { ErrorHttp } from '../http/errores.js';
import { InicioSesionSolicitud } from '../http/esquemas.js';
import { truncarIp, userAgentCorto } from './cliente.js';
import { claveIp, crearLimitador, limitarTasa } from './limites.js';
import { requiereSesion, usuarioDe } from './middleware.js';
import { iniciarSesion, respuestaSesion } from './servicio.js';
import { revocarSesion, rotarRefresco } from './sesiones.js';

export const LIMITES = {
  inicio: { max: 20, ventanaMs: 15 * 60_000 },
  refresco: { max: 60, ventanaMs: 60_000 },
} as const;

/**
 * Las rutas que usan la cookie exigen que, si el navegador manda Origin, sea el del frontend.
 * Con SameSite=Strict ya no viaja en peticiones de otros sitios; esto es una segunda barrera (CSRF).
 */
function exigirOrigen(req: Request, appUrl: string): void {
  const origen = req.headers.origin;
  if (origen !== undefined && origen !== new URL(appUrl).origin) {
    throw new ErrorHttp(403, 'origen_no_permitido', 'Origen no permitido');
  }
}

export function rutasAuth(d: DependenciasApi): Router {
  const r = Router();
  const sesion = requiereSesion(d);
  const limInicio = crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'inicio', ...LIMITES.inicio });
  const limRefresco = crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'refresco', ...LIMITES.refresco });

  r.post('/sesion', limitarTasa(limInicio, claveIp), async (req, res) => {
    const { correo, contrasena } = InicioSesionSolicitud.parse(req.body);
    const resultado = await iniciarSesion(d, {
      correo,
      contrasena,
      ipRed: truncarIp(req.ip),
      userAgent: userAgentCorto(req.headers['user-agent']),
    });
    switch (resultado.tipo) {
      case 'ok':
        ponerCookieRefresco(res, resultado.sesion.refresh, resultado.sesion.expiraEn, d.cookieSegura);
        res.status(201).json(resultado.respuesta);
        return;
      case 'bloqueada':
        res.setHeader('Retry-After', String(Math.max(1, Math.ceil((resultado.hasta.getTime() - Date.now()) / 1000))));
        throw new ErrorHttp(429, 'cuenta_bloqueada', 'Demasiados intentos fallidos. Espera antes de volver a intentar.');
      case 'mfa_requerido':
        throw new ErrorHttp(403, 'mfa_requerido', 'Esta cuenta usa verificación en dos pasos');
      case 'credenciales_invalidas':
        throw new ErrorHttp(401, 'credenciales_invalidas', 'Correo o contraseña incorrectos');
    }
  });

  r.post('/refresco', limitarTasa(limRefresco, claveIp), async (req, res) => {
    exigirOrigen(req, d.appUrl);
    const refresh = leerCookie(req, COOKIE_REFRESCO);
    if (!refresh) throw new ErrorHttp(401, 'sin_refresco', 'Inicia sesión de nuevo');
    const rot = await rotarRefresco(d.prisma, refresh);
    if (rot.tipo !== 'ok') {
      borrarCookieRefresco(res, d.cookieSegura);
      if (rot.tipo === 'reutilizado') {
        req.log.warn({ sesionId: rot.sesionId }, 'refresh reutilizado: sesión revocada');
        throw new ErrorHttp(401, 'refresco_reutilizado', 'Por seguridad se cerró la sesión. Inicia sesión de nuevo.');
      }
      throw new ErrorHttp(401, 'refresco_invalido', 'Inicia sesión de nuevo');
    }
    const u = await d.prisma.usuarios.findUniqueOrThrow({ where: { id: rot.usuarioId }, select: { id: true, nombre: true, correo: true, rol: true } });
    ponerCookieRefresco(res, rot.refresh, rot.expiraEn, d.cookieSegura);
    res.json(
      respuestaSesion(d, { id: u.id, nombre: u.nombre ?? '', correo: u.correo ?? '', rol: u.rol as 'admin' | 'editor' | 'lector' }, rot.sesionId),
    );
  });

  r.delete('/sesion', sesion, async (req, res) => {
    exigirOrigen(req, d.appUrl);
    await revocarSesion(d.prisma, usuarioDe(res).sesionId, 'cierre');
    borrarCookieRefresco(res, d.cookieSegura);
    res.status(204).end();
  });

  r.get('/yo', sesion, (_req, res) => {
    const u = usuarioDe(res);
    res.json({ usuario: { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol } });
  });

  return r;
}
