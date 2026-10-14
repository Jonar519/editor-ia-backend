// /api/auth: iniciar sesión (con segundo paso MFA), refrescar (rotación), cerrar sesión, "quién soy" y
// recuperación de contraseña.
import { createHash } from 'node:crypto';
import { Router, type Request } from 'express';
import type { DependenciasApi } from '../dependencias.js';
import { borrarCookieRefresco, COOKIE_REFRESCO, leerCookie, ponerCookieRefresco } from '../http/cookies.js';
import { ErrorHttp } from '../http/errores.js';
import { InicioSesionSolicitud, MfaSolicitud, RecuperacionSolicitud, RestablecerSolicitud } from '../http/esquemas.js';
import { truncarIp, userAgentCorto } from './cliente.js';
import { registrarEvento } from './eventos.js';
import { claveIp, crearLimitador, limitarTasa } from './limites.js';
import { DURACION_DESAFIO_S } from './mfa.js';
import { requiereSesion, usuarioDe } from './middleware.js';
import { procesarSolicitud, restablecer } from './recuperacion.js';
import { completarMfa, iniciarSesion, respuestaSesion } from './servicio.js';
import { revocarSesion, rotarRefresco } from './sesiones.js';

export const LIMITES = {
  inicio: { max: 20, ventanaMs: 15 * 60_000 },
  refresco: { max: 60, ventanaMs: 60_000 },
  mfa: { max: 20, ventanaMs: 15 * 60_000 },
  recuperacionIp: { max: 10, ventanaMs: 15 * 60_000 },
  /** Por correo pedido (aplica igual exista o no: no revela nada). */
  recuperacionCorreo: { max: 3, ventanaMs: 15 * 60_000 },
} as const;

/** Respuesta ÚNICA de "pedir recuperación", exista o no el correo. */
export const MENSAJE_RECUPERACION = 'Si el correo corresponde a una cuenta, te enviamos un enlace para restablecer la contraseña.';

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

const reintentarEn = (hasta: Date) => String(Math.max(1, Math.ceil((hasta.getTime() - Date.now()) / 1000)));

export function rutasAuth(d: DependenciasApi): Router {
  const r = Router();
  const sesion = requiereSesion(d);
  const lim = (nombre: keyof typeof LIMITES) => crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre, ...LIMITES[nombre] });

  r.post('/sesion', limitarTasa(lim('inicio'), claveIp), async (req, res) => {
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
      case 'mfa_requerido':
        res.status(202).json({ mfaRequerido: true, desafio: resultado.desafio, metodos: ['totp', 'respaldo'], expiraEnSegundos: DURACION_DESAFIO_S });
        return;
      case 'bloqueada':
        res.setHeader('Retry-After', reintentarEn(resultado.hasta));
        throw new ErrorHttp(429, 'cuenta_bloqueada', 'Demasiados intentos fallidos. Espera antes de volver a intentar.');
      case 'credenciales_invalidas':
        throw new ErrorHttp(401, 'credenciales_invalidas', 'Correo o contraseña incorrectos');
    }
  });

  // Segundo paso. Desafío inexistente, vencido, usado o código incorrecto: MISMA respuesta.
  r.post('/mfa', limitarTasa(lim('mfa'), claveIp), async (req, res) => {
    const { desafio, codigo, codigoRespaldo } = MfaSolicitud.parse(req.body);
    const resultado = await completarMfa(d, { desafio, codigo, codigoRespaldo, ipRed: truncarIp(req.ip) });
    if (resultado.tipo === 'ok') {
      ponerCookieRefresco(res, resultado.sesion.refresh, resultado.sesion.expiraEn, d.cookieSegura);
      res.status(201).json(resultado.respuesta);
      return;
    }
    if (resultado.tipo === 'bloqueada') {
      res.setHeader('Retry-After', reintentarEn(resultado.hasta));
      throw new ErrorHttp(429, 'cuenta_bloqueada', 'Demasiados intentos fallidos. Espera antes de volver a intentar.');
    }
    throw new ErrorHttp(401, 'mfa_invalido', 'El código no es válido o el paso venció. Inicia sesión de nuevo.');
  });

  r.post('/refresco', limitarTasa(lim('refresco'), claveIp), async (req, res) => {
    exigirOrigen(req, d.appUrl);
    const refresh = leerCookie(req, COOKIE_REFRESCO);
    if (!refresh) throw new ErrorHttp(401, 'sin_refresco', 'Inicia sesión de nuevo');
    const rot = await rotarRefresco(d.prisma, refresh);
    if (rot.tipo !== 'ok') {
      borrarCookieRefresco(res, d.cookieSegura);
      if (rot.tipo === 'reutilizado') {
        req.log.warn({ sesionId: rot.sesionId }, 'refresh reutilizado: sesión revocada');
        await registrarEvento(d.prisma, 'refresco_reutilizado', rot.usuarioId, truncarIp(req.ip));
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
    const u = usuarioDe(res);
    await revocarSesion(d.prisma, u.sesionId, 'cierre');
    await registrarEvento(d.prisma, 'cierre_sesion', u.id, truncarIp(req.ip));
    borrarCookieRefresco(res, d.cookieSegura);
    res.status(204).end();
  });

  r.get('/yo', sesion, (_req, res) => {
    const u = usuarioDe(res);
    res.json({ usuario: { id: u.id, nombre: u.nombre, correo: u.correo, rol: u.rol } });
  });

  // ─── Recuperación de contraseña ─────────────────────────────────────────────────

  const limRecIp = limitarTasa(lim('recuperacionIp'), claveIp);
  const limRecCorreo = limitarTasa(lim('recuperacionCorreo'), (req) => {
    const correo = RecuperacionSolicitud.safeParse(req.body);
    return createHash('sha256').update(correo.success ? correo.data.correo : 'invalido').digest('hex');
  });

  // Responde AL INSTANTE y siempre lo mismo; el trabajo real sigue en segundo plano.
  r.post('/recuperacion', limRecIp, limRecCorreo, (req, res) => {
    const { correo } = RecuperacionSolicitud.parse(req.body);
    const trabajo = () =>
      procesarSolicitud(d, correo, truncarIp(req.ip)).catch((err: unknown) => {
        req.log.error({ err }, 'recuperación: falló el trabajo en segundo plano');
      });
    // PRIMERO se responde; DESPUÉS se trabaja: ni el cuerpo ni el tiempo dependen de que el correo exista.
    res.status(202).json({ mensaje: MENSAJE_RECUPERACION });
    void trabajo();
  });

  r.post('/recuperacion/completar', limRecIp, async (req, res) => {
    const { token, contrasena } = RestablecerSolicitud.parse(req.body);
    await restablecer(d, { token, contrasena, ipRed: truncarIp(req.ip) });
    res.status(204).end();
  });

  return r;
}
