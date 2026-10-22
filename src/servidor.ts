// Punto de entrada: valida la configuración, abre conexiones, verifica privilegios, escucha y se apaga
// en orden con SIGTERM/SIGINT.
import { crearApagado } from './apagado.js';
import { crearApi } from './api.js';
import { crearSenuelo } from './auth/contrasenas.js';
import { crearProveedorCorreo } from './correo/proveedor.js';
import { crearApp } from './app.js';
import { cargarConfigOSalir } from './config/entorno.js';
import { crearProveedorGeo } from './geo/proveedor.js';
import type { Comprobacion } from './http/salud.js';
import { ClienteIa, credencialesIa } from './ia/cliente.js';
import { iniciarIndexado } from './ia/indexado.js';
import { iaTiempoReal } from './ia/autocompletado.js';
import { TOPES_IA } from './ia/uso.js';
import { comprobacionBd, comprobacionEsquema, crearPool, crearPrisma } from './infra/bd.js';
import { accionPorPrivilegios, leerPrivilegios, problemasDePrivilegios } from './infra/privilegios.js';
import { comprobacionRedis, crearRedis } from './infra/redis.js';
import { crearLogger } from './observabilidad/log.js';
import { crearMetricas } from './observabilidad/metricas.js';
import { iniciarAvisos } from './tiempo-real/avisos.js';
import { iniciarCompactacion } from './tiempo-real/compactacion.js';
import { LIMITES_PRODUCCION } from './tiempo-real/limites.js';
import { ServidorTiempoReal } from './tiempo-real/servidor.js';
import { iniciarRetencion, PATRON_RETENCION } from './trabajos/retencion.js';

async function main(): Promise<void> {
  const config = cargarConfigOSalir(process.env);

  const log = crearLogger(config.LOG_LEVEL);
  const pool = crearPool(config.DATABASE_URL);
  const prisma = crearPrisma(pool);
  const redis = crearRedis(config.REDIS_URL, (err) => {
    log.warn({ err }, 'redis: error de conexión');
  });

  const problemas = problemasDePrivilegios(await leerPrivilegios(pool));
  const accion = accionPorPrivilegios(config.NODE_ENV, problemas);
  if (accion === 'abortar') {
    log.fatal({ problemas }, 'el usuario de base tiene privilegios de más; usa cuaderno_app');
    await pool.end();
    process.exit(1);
  }
  if (accion === 'avisar') {
    log.warn({ problemas }, 'el usuario de base tiene privilegios de más (en producción no arrancaría)');
  }

  // Servicio de IA (bloque P1, proceso aparte). Sin IA_SERVICE_TOKEN (solo fuera de producción) el API
  // arranca sin IA: sus rutas responden 503 y /ready la muestra como "falla", sin caer en 503.
  const ia = config.IA_SERVICE_TOKEN
    ? new ClienteIa({ url: config.IA_URL, token: config.IA_SERVICE_TOKEN, ...credencialesIa(config) })
    : undefined;
  if (!ia) log.warn('IA deshabilitada: falta IA_SERVICE_TOKEN (scripts\\env-init.bat lo genera)');
  const indexador = ia ? iniciarIndexado({ redisUrl: config.REDIS_URL, prefijo: 'cuaderno:bull', prisma, ia, topes: TOPES_IA, log }) : undefined;
  const comprobacionIa: Comprobacion = {
    nombre: 'ia',
    informativa: true,
    comprobar: () => (ia ? ia.comprobarSalud() : Promise.reject(new Error('IA deshabilitada'))),
  };

  const estado = { apagando: false };
  // Tiempo real (bloque K2): WebSocket en el mismo puerto, compactación con BullMQ y avisos de la base
  // reenviados por Redis. UNA sola instancia (ver src/tiempo-real/servidor.ts). Se crea ANTES que el API:
  // las versiones y los comentarios (bloque N) usan el documento en memoria.
  const compactador = iniciarCompactacion({
    redisUrl: config.REDIS_URL,
    prefijo: 'cuaderno:bull',
    prisma,
    log,
    inactividadMs: LIMITES_PRODUCCION.compactarInactividadMs,
  });
  const tiempoReal = new ServidorTiempoReal({
    prisma,
    redis,
    prefijoRedis: 'cuaderno:',
    appUrl: config.APP_URL,
    log,
    limites: LIMITES_PRODUCCION,
    pedirCompactacion: compactador.pedir,
    ...(ia ? { ia: iaTiempoReal(ia, prisma, TOPES_IA) } : {}),
  });
  const api = crearApi({
    contenido: tiempoReal,
    ...(ia ? { ia } : {}),
    ...(indexador ? { indexador } : {}),
    prisma,
    redis,
    correo: crearProveedorCorreo(config, prisma),
    geo: crearProveedorGeo(config, prisma),
    claveAcceso: Buffer.from(config.ACCESS_TOKEN_SECRET, 'base64'),
    claveMfa: Buffer.from(config.MFA_ENCRYPTION_KEY, 'base64'),
    appUrl: config.APP_URL,
    cookieSegura: config.COOKIE_SECURE,
    costoHash: config.PASSWORD_HASH_COST,
    senuelo: await crearSenuelo(config.PASSWORD_HASH_COST),
    prefijoRedis: 'cuaderno:',
  });
  const app = crearApp({
    log,
    metricas: crearMetricas(),
    comprobaciones: [comprobacionBd(pool), comprobacionEsquema(pool), comprobacionRedis(redis), comprobacionIa],
    estado,
    tokenMetricas: config.METRICS_TOKEN,
    trustProxy: config.TRUST_PROXY,
    api,
  });

  const servidor = app.listen(config.PORT, config.HOST, () => {
    log.info({ host: config.HOST, puerto: config.PORT, entorno: config.NODE_ENV }, 'Cuaderno API escuchando');
  });

  tiempoReal.adjuntar(servidor);
  const avisos = iniciarAvisos({
    databaseUrl: config.DATABASE_URL,
    redis,
    prefijo: 'cuaderno:',
    log,
    alAviso: (a) => {
      tiempoReal.aviso(a);
    },
    alReconectar: () => {
      tiempoReal.revalidarTodas();
    },
  });

  // Retención diaria (BullMQ). Arranca después de escuchar: si Redis tarda, el API no espera por ella.
  const retencion = iniciarRetencion({ redisUrl: config.REDIS_URL, prefijo: 'cuaderno:bull', prisma, log }).then(
    (r) => {
      log.info({ patron: PATRON_RETENCION, zona: 'UTC' }, 'retención diaria agendada');
      return r;
    },
    (err: unknown) => {
      log.error({ err }, 'retención diaria: no se pudo agendar');
      return undefined;
    },
  );

  const apagar = crearApagado({
    servidor,
    estado,
    log,
    limiteMs: config.SHUTDOWN_TIMEOUT_MS,
    cerrarRecursos: async () => {
      // Primero el tiempo real: cierra las conexiones (1001) y guarda lo pendiente de cada documento.
      await tiempoReal.cerrar();
      await avisos.cerrar();
      // Después los workers: esperan al job en curso (si lo hay) antes de cerrar la base.
      await compactador.cerrar();
      await indexador?.cerrar();
      await (await retencion)?.cerrar();
      ia?.cerrar();
      await prisma.$disconnect();
      await pool.end();
      redis.disconnect();
    },
  });
  for (const senal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(senal, () => {
      void apagar(senal).then(() => process.exit(0));
    });
  }
}

void main();
