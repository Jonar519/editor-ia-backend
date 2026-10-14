// Apoyo para pruebas del API: dependencias reales (base de PRUEBAS como cuaderno_app, Redis db 1 con un
// prefijo propio por corrida) y un proveedor de correo que guarda los mensajes en memoria.
import { randomBytes } from 'node:crypto';
import type pg from 'pg';
import { crearApi } from '../src/api.js';
import { cifrarSecreto } from '../src/auth/cifrado.js';
import { crearSenuelo, hashearContrasena } from '../src/auth/contrasenas.js';
import { crearSesion } from '../src/auth/sesiones.js';
import { emitirAcceso } from '../src/auth/tokens.js';
import { hotp, pasoDe } from '../src/auth/totp.js';
import type { MensajeCorreo, ProveedorCorreo } from '../src/correo/proveedor.js';
import type { DependenciasApi } from '../src/dependencias.js';
import type { PrismaClient } from '../src/generated/prisma/client.js';
import { crearPool, crearPrisma } from '../src/infra/bd.js';
import { crearRedis } from '../src/infra/redis.js';
import { appDePrueba, urlBdPruebas, urlRedisPruebas } from './_apoyo.js';

/** Costo de scrypt bajo SOLO en pruebas (producción exige 15+). */
export const COSTO_PRUEBAS = 10;
export const APP_URL = 'http://127.0.0.1:5175';

export interface Buzon extends ProveedorCorreo {
  mensajes: MensajeCorreo[];
  fallar: boolean;
}

export function buzonEnMemoria(): Buzon {
  const b: Buzon = {
    nombre: 'mock',
    mensajes: [],
    fallar: false,
    enviar: (m) => {
      if (b.fallar) return Promise.reject(new Error('proveedor de correo caído'));
      b.mensajes.push(m);
      return Promise.resolve();
    },
  };
  return b;
}

export interface EntornoApi {
  pool: pg.Pool;
  prisma: PrismaClient;
  deps: DependenciasApi;
  buzon: Buzon;
  cerrar: () => Promise<void>;
}

export async function entornoApi(cambios: Partial<DependenciasApi> = {}): Promise<EntornoApi> {
  const pool = crearPool(urlBdPruebas());
  const prisma = crearPrisma(pool);
  const redis = crearRedis(urlRedisPruebas(), () => undefined);
  const buzon = buzonEnMemoria();
  const deps: DependenciasApi = {
    prisma,
    redis,
    correo: buzon,
    claveAcceso: randomBytes(32),
    claveMfa: randomBytes(32),
    appUrl: APP_URL,
    cookieSegura: true,
    costoHash: COSTO_PRUEBAS,
    senuelo: await crearSenuelo(COSTO_PRUEBAS),
    prefijoRedis: `prueba:${randomBytes(6).toString('hex')}:`,
    ...cambios,
  };
  return {
    pool,
    prisma,
    deps,
    buzon,
    cerrar: async () => {
      await prisma.$disconnect();
      await pool.end();
      redis.disconnect();
    },
  };
}

/** Cada app de prueba usa su propio prefijo de Redis: sus límites no se mezclan con los de otra prueba. */
export function appApi(deps: DependenciasApi) {
  return appApiConLog(deps).app;
}

/** Igual que appApi, pero devuelve también las líneas de log (pino) para inspeccionarlas. */
export function appApiConLog(deps: DependenciasApi) {
  return appDePrueba({ api: crearApi({ ...deps, prefijoRedis: `prueba:${randomBytes(6).toString('hex')}:` }) });
}

/** Espera hasta que llegue un correo (los de recuperación se envían en segundo plano). */
export async function esperarCorreo(buzon: Buzon, para: string, plantilla: string, ms = 5000): Promise<MensajeCorreo> {
  const limite = Date.now() + ms;
  for (;;) {
    const m = buzon.mensajes.findLast((x) => x.para === para && x.plantilla === plantilla);
    if (m) return m;
    if (Date.now() > limite) throw new Error(`no llegó el correo ${plantilla} a ${para}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Correo ficticio único por prueba (la base de pruebas acumula cuentas: no se pueden borrar activas). */
export const correoUnico = (prefijo: string) => `${prefijo}.${randomBytes(5).toString('hex')}@example.com`;

export interface CuentaPrueba {
  id: string;
  correo: string;
  nombre: string;
  contrasena: string;
  /** Secreto TOTP en claro (solo admin), para generar códigos en las pruebas. */
  secretoMfa: Buffer;
}

/**
 * Cuenta activa siguiendo el flujo real de la base (nace pendiente, se activa con contraseña). Un admin
 * se activa con MFA confirmado en la misma transacción, como exige la base; su secreto se cifra con
 * claveMfa (pasar la de las dependencias de la prueba para poder verificar códigos).
 */
export async function cuentaActiva(
  prisma: PrismaClient,
  rol: 'admin' | 'editor' | 'lector' = 'editor',
  claveMfa: Buffer = randomBytes(32),
): Promise<CuentaPrueba> {
  const correo = correoUnico(rol);
  const contrasena = `clave-de-prueba-${randomBytes(4).toString('hex')}`;
  const hash = await hashearContrasena(contrasena, COSTO_PRUEBAS);
  const nombre = 'Persona Ficticia';
  const secretoMfa = randomBytes(20);
  const id = await prisma.$transaction(async (tx) => {
    const u = await tx.usuarios.create({ data: { correo, nombre, rol }, select: { id: true } });
    await tx.usuarios.update({ where: { id: u.id }, data: { estado: 'activa', hash_contrasena: hash, activada_en: new Date() } });
    if (rol === 'admin') {
      const c = cifrarSecreto(claveMfa, secretoMfa, u.id);
      await tx.mfa_totp.create({
        data: { usuario_id: u.id, secreto_cifrado: c.cifrado, iv: c.iv, etiqueta: c.etiqueta, confirmado_en: new Date() },
      });
    }
    return u.id;
  });
  return { id, correo, nombre, contrasena, secretoMfa };
}

/** Código TOTP válido para un instante (por defecto, ahora). */
export const codigoTotp = (secreto: Buffer, ms = Date.now()) => hotp(secreto, pasoDe(ms));

/**
 * Access token de una sesión creada directamente. Se usa para el admin, cuyo login real pasa por el
 * desafío MFA (bloque F).
 */
export async function accesoDirecto(deps: DependenciasApi, usuarioId: string): Promise<{ token: string; sesionId: string }> {
  const s = await deps.prisma.$transaction((tx) => crearSesion(tx, { usuarioId, ipRed: null, userAgent: null }));
  return { token: emitirAcceso(usuarioId, s.sesionId, deps.claveAcceso).token, sesionId: s.sesionId };
}

/** Extrae el token del enlace de un correo de invitación (lo que haría la persona invitada). */
export function tokenDelCorreo(texto: string): string {
  const m = /\/#\/invitacion\/([A-Za-z0-9_-]{43})/.exec(texto);
  if (!m?.[1]) throw new Error('el correo no trae un enlace de invitación');
  return m[1];
}

/** Valor de la cookie de refresco en una respuesta. */
export function cookieRefresco(cabeceras: Record<string, unknown>): string | undefined {
  const sc = cabeceras['set-cookie'];
  const lista = Array.isArray(sc) ? (sc as string[]) : typeof sc === 'string' ? [sc] : [];
  const c = lista.find((x) => x.startsWith('cuaderno_refresco='));
  return c?.split(';')[0]?.slice('cuaderno_refresco='.length);
}

export function setCookieRefresco(cabeceras: Record<string, unknown>): string | undefined {
  const sc = cabeceras['set-cookie'];
  const lista = Array.isArray(sc) ? (sc as string[]) : typeof sc === 'string' ? [sc] : [];
  return lista.find((x) => x.startsWith('cuaderno_refresco='));
}
