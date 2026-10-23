// /api/cuenta: perfil, correo, contraseña, sesiones, avatar, exportación, eliminación (bloque G) y MFA
// opcional (bloque F). Todo exige sesión salvo confirmar el correo nuevo, que llega desde un enlace.
import express, { Router } from 'express';
import { truncarIp } from '../auth/cliente.js';
import { claveIp, crearLimitador, limitarTasa } from '../auth/limites.js';
import { confirmarMfaCuenta, desactivarMfaCuenta, iniciarMfaCuenta, regenerarCodigos } from '../auth/mfa.js';
import { requiereSesion, usuarioDe } from '../auth/middleware.js';
import type { DependenciasApi } from '../dependencias.js';
import { borrarCookieRefresco } from '../http/cookies.js';
import { ErrorHttp } from '../http/errores.js';
import {
  ActualizarPerfil,
  CambioContrasena,
  CambioCorreoSolicitud,
  CodigoMfa,
  ConfirmarConContrasena,
  ConfirmarCorreo,
  EliminarCuentaSolicitud,
  IdSesion,
} from '../http/esquemas.js';
import { BYTES_MAXIMOS_AVATAR, borrarAvatar, guardarAvatar } from './avatar.js';
import { eliminarCuenta, exportarDatos } from './datos.js';
import {
  actualizarPerfil,
  cambiarContrasena,
  confirmarCambioCorreo,
  leerPerfil,
  MENSAJE_CAMBIO_CORREO,
  procesarCambioCorreo,
  validarCambioCorreo,
} from './perfil.js';
import { cerrarOtrasSesiones, cerrarSesion, listarSesiones } from './sesiones.js';

export const LIMITES_CUENTA = {
  cuenta_mfa: { max: 20, ventanaMs: 15 * 60_000 },
  /** Acciones que piden la contraseña: además suman al bloqueo de la cuenta si fallan. */
  cuenta_sensible: { max: 10, ventanaMs: 15 * 60_000 },
  confirmar_correo: { max: 10, ventanaMs: 15 * 60_000 },
  avatar: { max: 20, ventanaMs: 60 * 60_000 },
} as const;

export function rutasCuenta(d: DependenciasApi): Router {
  const r = Router();
  const lim = (nombre: keyof typeof LIMITES_CUENTA) =>
    limitarTasa(crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre, ...LIMITES_CUENTA[nombre] }), claveIp);
  const sensible = lim('cuenta_sensible');

  // Público: el enlace llega al correo NUEVO y puede abrirse en otro navegador (sin sesión).
  r.post('/correo/confirmar', lim('confirmar_correo'), async (req, res) => {
    const { token } = ConfirmarCorreo.parse(req.body);
    await confirmarCambioCorreo(d, token, truncarIp(req.ip));
    res.status(204).end();
  });

  r.use(requiereSesion(d));

  // ─── Perfil ─────────────────────────────────────────────────────────────────────
  r.get('/', async (_req, res) => {
    res.json(await leerPerfil(d, usuarioDe(res).id));
  });

  r.patch('/', async (req, res) => {
    const cambios = ActualizarPerfil.parse(req.body);
    res.json(await actualizarPerfil(d, usuarioDe(res).id, cambios, truncarIp(req.ip)));
  });

  // ─── Correo y contraseña ────────────────────────────────────────────────────────
  r.post('/correo', sensible, async (req, res) => {
    const { correoNuevo, contrasena } = CambioCorreoSolicitud.parse(req.body);
    const u = usuarioDe(res);
    const ipRed = truncarIp(req.ip);
    await validarCambioCorreo(d, u, { correoNuevo, contrasena, ipRed });
    // PRIMERO se responde; DESPUÉS se trabaja: ni el cuerpo ni el tiempo dicen si la dirección tiene cuenta.
    res.status(202).json({ mensaje: MENSAJE_CAMBIO_CORREO });
    void procesarCambioCorreo(d, u.id, correoNuevo, ipRed).catch((err: unknown) => {
      req.log.error({ err }, 'cambio de correo: falló el trabajo en segundo plano');
    });
  });

  r.post('/contrasena', sensible, async (req, res) => {
    const { actual, nueva } = CambioContrasena.parse(req.body);
    res.json(await cambiarContrasena(d, usuarioDe(res), { actual, nueva, ipRed: truncarIp(req.ip) }));
  });

  // ─── Sesiones ───────────────────────────────────────────────────────────────────
  r.get('/sesiones', async (_req, res) => {
    res.json({ sesiones: await listarSesiones(d, usuarioDe(res)) });
  });

  r.post('/sesiones/cerrar-otras', async (req, res) => {
    res.json({ cerradas: await cerrarOtrasSesiones(d, usuarioDe(res), truncarIp(req.ip)) });
  });

  r.delete('/sesiones/:id', async (req, res) => {
    const { id } = IdSesion.parse(req.params);
    await cerrarSesion(d, usuarioDe(res), id, truncarIp(req.ip));
    res.status(204).end();
  });

  // ─── Avatar ─────────────────────────────────────────────────────────────────────
  // El cuerpo es la imagen tal cual (sin multipart). El formato se decide por la firma de bytes.
  // inflate: false (GHSA-27r3-jxmh-p828): una imagen con Content-Encoding comprimido se rechaza (415).
  r.put('/avatar', lim('avatar'), express.raw({ type: ['image/jpeg', 'image/png'], limit: BYTES_MAXIMOS_AVATAR, inflate: false }), async (req, res) => {
    if (!Buffer.isBuffer(req.body)) throw new ErrorHttp(415, 'tipo_no_admitido', 'Envía la imagen con Content-Type image/jpeg o image/png');
    res.json(await guardarAvatar(d, usuarioDe(res).id, req.body, truncarIp(req.ip)));
  });

  r.delete('/avatar', async (req, res) => {
    await borrarAvatar(d, usuarioDe(res).id, truncarIp(req.ip));
    res.status(204).end();
  });

  // ─── Datos ──────────────────────────────────────────────────────────────────────
  r.post('/exportacion', sensible, async (req, res) => {
    const { contrasena } = ConfirmarConContrasena.parse(req.body);
    const datos = await exportarDatos(d, usuarioDe(res).id, contrasena, truncarIp(req.ip));
    res.setHeader('Content-Disposition', `attachment; filename="cuaderno-datos-${datos.generadoEn.slice(0, 10)}.json"`);
    res.json(datos);
  });

  r.delete('/', sensible, async (req, res) => {
    const { contrasena, codigo } = EliminarCuentaSolicitud.parse(req.body);
    const resultado = await eliminarCuenta(d, usuarioDe(res).id, { contrasena, codigo, ipRed: truncarIp(req.ip) });
    borrarCookieRefresco(res, d.cookieSegura);
    res.json(resultado);
  });

  // ─── MFA opcional (bloque F) ────────────────────────────────────────────────────
  const limMfa = lim('cuenta_mfa');

  r.post('/mfa/iniciar', limMfa, async (_req, res) => {
    const u = usuarioDe(res);
    res.json(await iniciarMfaCuenta(d, { id: u.id, correo: u.correo }));
  });

  r.post('/mfa/confirmar', limMfa, async (req, res) => {
    const { codigo } = CodigoMfa.parse(req.body);
    res.json({ codigosRespaldo: await confirmarMfaCuenta(d, usuarioDe(res).id, codigo, truncarIp(req.ip)) });
  });

  r.post('/mfa/codigos-respaldo', limMfa, async (req, res) => {
    const { codigo } = CodigoMfa.parse(req.body);
    res.json({ codigosRespaldo: await regenerarCodigos(d, usuarioDe(res).id, codigo, truncarIp(req.ip)) });
  });

  r.delete('/mfa', limMfa, async (req, res) => {
    const { codigo } = CodigoMfa.parse(req.body);
    const u = usuarioDe(res);
    await desactivarMfaCuenta(d, { id: u.id, rol: u.rol }, codigo, truncarIp(req.ip));
    res.status(204).end();
  });

  return r;
}
