// /api/cuenta/mfa: MFA opcional para editor y lector (obligatorio para admin: no se puede desactivar).
// Todo cambio exige un código TOTP válido; los fallos suman al bloqueo de la cuenta.
import { Router } from 'express';
import { truncarIp } from '../auth/cliente.js';
import { claveIp, crearLimitador, limitarTasa } from '../auth/limites.js';
import { confirmarMfaCuenta, desactivarMfaCuenta, iniciarMfaCuenta, regenerarCodigos } from '../auth/mfa.js';
import { requiereSesion, usuarioDe } from '../auth/middleware.js';
import type { DependenciasApi } from '../dependencias.js';
import { CodigoMfa } from '../http/esquemas.js';

export function rutasCuenta(d: DependenciasApi): Router {
  const r = Router();
  r.use(requiereSesion(d));
  const lim = limitarTasa(crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'cuenta_mfa', max: 20, ventanaMs: 15 * 60_000 }), claveIp);

  r.post('/mfa/iniciar', lim, async (_req, res) => {
    const u = usuarioDe(res);
    res.json(await iniciarMfaCuenta(d, { id: u.id, correo: u.correo }));
  });

  r.post('/mfa/confirmar', lim, async (req, res) => {
    const { codigo } = CodigoMfa.parse(req.body);
    res.json({ codigosRespaldo: await confirmarMfaCuenta(d, usuarioDe(res).id, codigo, truncarIp(req.ip)) });
  });

  r.post('/mfa/codigos-respaldo', lim, async (req, res) => {
    const { codigo } = CodigoMfa.parse(req.body);
    res.json({ codigosRespaldo: await regenerarCodigos(d, usuarioDe(res).id, codigo, truncarIp(req.ip)) });
  });

  r.delete('/mfa', lim, async (req, res) => {
    const { codigo } = CodigoMfa.parse(req.body);
    const u = usuarioDe(res);
    await desactivarMfaCuenta(d, { id: u.id, rol: u.rol }, codigo, truncarIp(req.ip));
    res.status(204).end();
  });

  return r;
}
