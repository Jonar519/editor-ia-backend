// Recuperación de contraseña. Pedirla responde SIEMPRE lo mismo y AL INSTANTE: el trabajo (buscar la
// cuenta, crear el token, enviar el correo) ocurre DESPUÉS de responder, así que ni el cuerpo ni el tiempo
// de respuesta dependen de que el correo exista. Token de 15 min, un solo uso, solo su SHA-256 en la base.
import { correoAvisoContrasena, correoRecuperacion } from '../correo/plantillas.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import { hashearContrasena, problemasDeContrasena } from './contrasenas.js';
import { registrarEvento } from './eventos.js';
import { hashToken, tokenAleatorio } from './tokens.js';

/** Vigencia del enlace en minutos (la base no admite más de 15). */
export const VIGENCIA_RECUPERACION_MIN = 15;

/** Trabajo en segundo plano de una solicitud. El llamador NO lo espera para responder. */
export async function procesarSolicitud(d: DependenciasApi, correo: string, ipRed: string | null): Promise<void> {
  const u = await d.prisma.usuarios.findFirst({ where: { correo, estado: 'activa' }, select: { id: true, nombre: true, correo: true } });
  if (!u?.correo) {
    await registrarEvento(d.prisma, 'recuperacion_solicitada', null, ipRed);
    return;
  }
  const token = tokenAleatorio();
  const expiraEn = await d.prisma.$transaction(async (tx) => {
    // Pedir otra invalida la anterior (la base admite como máximo una sin usar por cuenta).
    await tx.tokens_recuperacion.deleteMany({ where: { usuario_id: u.id, usado_en: null } });
    const filas = await tx.$queryRaw<{ expira_en: Date }[]>`
      INSERT INTO tokens_recuperacion (usuario_id, token_hash, expira_en)
      VALUES (${u.id}::uuid, ${hashToken(token)}, now() + make_interval(mins => ${VIGENCIA_RECUPERACION_MIN}::int))
      RETURNING expira_en`;
    await registrarEvento(tx, 'recuperacion_solicitada', u.id, ipRed);
    return filas[0]?.expira_en ?? new Date();
  });
  await d.correo.enviar(correoRecuperacion({ para: u.correo, nombre: u.nombre ?? '', appUrl: d.appUrl, token, expiraEn }));
}

/**
 * Restablece la contraseña: consume el token (FOR UPDATE: un solo uso aunque lleguen dos a la vez),
 * guarda el hash nuevo, levanta el bloqueo y CIERRA TODAS las sesiones de la cuenta.
 */
export async function restablecer(d: DependenciasApi, e: { token: string; contrasena: string; ipRed: string | null }): Promise<void> {
  const filas = await d.prisma.$queryRaw<{ usuario_id: string; correo: string | null; nombre: string | null }[]>`
    SELECT t.usuario_id, u.correo::text AS correo, u.nombre
    FROM tokens_recuperacion t JOIN usuarios u ON u.id = t.usuario_id
    WHERE t.token_hash = ${hashToken(e.token)} AND t.usado_en IS NULL AND t.expira_en > now() AND u.estado = 'activa'`;
  const u = filas[0];
  if (!u) throw new ErrorHttp(400, 'enlace_invalido', 'El enlace no es válido, ya se usó o venció. Pide uno nuevo.');
  const problemas = problemasDeContrasena(e.contrasena, { correo: u.correo ?? '', nombre: u.nombre ?? '' });
  if (problemas.length > 0) throw new ErrorHttp(400, 'contrasena_debil', 'La contraseña no cumple la política', problemas);
  const hash = await hashearContrasena(e.contrasena, d.costoHash);

  await d.prisma.$transaction(async (tx) => {
    const vivo = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM tokens_recuperacion
      WHERE token_hash = ${hashToken(e.token)} AND usado_en IS NULL AND expira_en > now() FOR UPDATE`;
    const id = vivo[0]?.id;
    if (!id) throw new ErrorHttp(400, 'enlace_invalido', 'El enlace no es válido, ya se usó o venció. Pide uno nuevo.');
    await tx.$executeRaw`UPDATE tokens_recuperacion SET usado_en = now() WHERE id = ${id}::uuid`;
    await tx.usuarios.update({ where: { id: u.usuario_id }, data: { hash_contrasena: hash, fallos_login: 0, bloqueada_hasta: null } });
    await tx.$executeRaw`
      UPDATE sesiones SET revocada_en = now(), motivo_revocacion = 'cambio_contrasena'
      WHERE usuario_id = ${u.usuario_id}::uuid AND revocada_en IS NULL`;
    await registrarEvento(tx, 'contrasena_restablecida', u.usuario_id, e.ipRed);
  });
  if (u.correo) {
    // Aviso a la persona (si no fue ella, sabe que debe actuar). Si el correo falla, el cambio ya está hecho.
    await d.correo.enviar(correoAvisoContrasena({ para: u.correo, nombre: u.nombre ?? '' })).catch(() => undefined);
  }
}
