import type { RequestHandler, Response } from 'express';
import type { PrismaClient } from '../generated/prisma/client.js';
import { ErrorHttp } from '../http/errores.js';
import { validarSesion, type UsuarioSesion } from './sesiones.js';
import { verificarAcceso } from './tokens.js';

/**
 * Exige un access token válido Y una sesión viva en la base. Que el token esté firmado y vigente no
 * basta: si la sesión se cerró, se revocó por reutilización o la cuenta dejó de estar activa, la
 * petición se rechaza aunque falten minutos para que el token venza.
 */
export function requiereSesion(d: { prisma: PrismaClient; claveAcceso: Buffer }): RequestHandler {
  return async (req, res, next) => {
    const cabecera = req.headers.authorization;
    const token = cabecera?.startsWith('Bearer ') ? cabecera.slice(7) : undefined;
    const reclamos = token ? verificarAcceso(token, d.claveAcceso) : null;
    const usuario = reclamos ? await validarSesion(d.prisma, reclamos.sub, reclamos.sid) : null;
    if (!usuario) {
      res.setHeader('WWW-Authenticate', 'Bearer');
      next(new ErrorHttp(401, 'no_autenticado', 'Inicia sesión de nuevo'));
      return;
    }
    res.locals.usuario = usuario;
    next();
  };
}

export function requiereRol(...roles: UsuarioSesion['rol'][]): RequestHandler {
  return (_req, res, next) => {
    if (!roles.includes(usuarioDe(res).rol)) {
      next(new ErrorHttp(403, 'sin_permiso', 'No tienes permiso para esta acción'));
      return;
    }
    next();
  };
}

export function usuarioDe(res: Response): UsuarioSesion {
  const u = res.locals.usuario as UsuarioSesion | undefined;
  if (!u) throw new Error('usuarioDe() sin requiereSesion antes');
  return u;
}
