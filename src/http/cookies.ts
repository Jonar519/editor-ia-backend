import type { Request, Response } from 'express';

/** Cookie del refresh: httpOnly (JS no la lee), SameSite=Strict, solo para /api/auth. */
export const COOKIE_REFRESCO = 'cuaderno_refresco';
export const RUTA_COOKIE_REFRESCO = '/api/auth';

export function leerCookie(req: Request, nombre: string): string | undefined {
  const cabecera = req.headers.cookie;
  if (!cabecera) return undefined;
  for (const parte of cabecera.split(';')) {
    const i = parte.indexOf('=');
    if (i > 0 && parte.slice(0, i).trim() === nombre) {
      try {
        return decodeURIComponent(parte.slice(i + 1).trim());
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

export function ponerCookieRefresco(res: Response, valor: string, expira: Date, segura: boolean): void {
  res.cookie(COOKIE_REFRESCO, valor, {
    httpOnly: true,
    secure: segura,
    sameSite: 'strict',
    path: RUTA_COOKIE_REFRESCO,
    expires: expira,
  });
}

export function borrarCookieRefresco(res: Response, segura: boolean): void {
  res.clearCookie(COOKIE_REFRESCO, { httpOnly: true, secure: segura, sameSite: 'strict', path: RUTA_COOKIE_REFRESCO });
}
