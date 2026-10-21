// Punto de entrada: valida la configuración, abre conexiones, verifica privilegios, escucha y se apaga
// en orden con SIGTERM/SIGINT.
import { crearApagado } from './apagado.js';
import { crearApi } from './api.js';
import { crearSenuelo } from './auth/contrasenas.js';
import { crearProveedorCorreo } from './correo/proveedor.js';
import { crearApp } from './app.js';
import { cargarConfigOSalir } from './config/entorno.js';
import { crearProveedorGeo } from './geo/proveedor.js';
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

  const estado = { apagando: false };
  const api = crearApi({
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
    comprobaciones: [comprobacionBd(pool), comprobacionEsquema(pool), comprobacionRedis(redis)],
    estado,
    tokenMetricas: config.METRICS_TOKEN,
    trustProxy: config.TRUST_PROXY,
    api,
  });

  const servidor = app.listen(config.PORT, config.HOST, () => {
    log.info({ host: config.HOST, puerto: config.PORT, entorno: config.NODE_ENV }, 'Cuaderno API escuchando');
  });

  // Tiempo real (bloque K2): WebSocket en el mismo puerto, compactación con BullMQ y avisos de la base
  // reenviados por Redis. UNA sola instancia (ver src/tiempo-real/servidor.ts).
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
      await (await retencion)?.cerrar();
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
