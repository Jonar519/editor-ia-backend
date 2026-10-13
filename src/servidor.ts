// Punto de entrada: valida la configuración, abre conexiones, verifica privilegios, escucha y se apaga
// en orden con SIGTERM/SIGINT.
import { crearApagado } from './apagado.js';
import { crearApp } from './app.js';
import { cargarConfig, ErrorConfig } from './config/entorno.js';
import { comprobacionBd, comprobacionEsquema, crearPool, crearPrisma } from './infra/bd.js';
import { accionPorPrivilegios, leerPrivilegios, problemasDePrivilegios } from './infra/privilegios.js';
import { comprobacionRedis, crearRedis } from './infra/redis.js';
import { crearLogger } from './observabilidad/log.js';
import { crearMetricas } from './observabilidad/metricas.js';

async function main(): Promise<void> {
  let config;
  try {
    config = cargarConfig(process.env);
  } catch (e) {
    if (e instanceof ErrorConfig) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }

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
  const app = crearApp({
    log,
    metricas: crearMetricas(),
    comprobaciones: [comprobacionBd(pool), comprobacionEsquema(pool), comprobacionRedis(redis)],
    estado,
    tokenMetricas: config.METRICS_TOKEN,
    trustProxy: config.TRUST_PROXY,
  });

  const servidor = app.listen(config.PORT, config.HOST, () => {
    log.info({ host: config.HOST, puerto: config.PORT, entorno: config.NODE_ENV }, 'Cuaderno API escuchando');
  });

  const apagar = crearApagado({
    servidor,
    estado,
    log,
    limiteMs: config.SHUTDOWN_TIMEOUT_MS,
    cerrarRecursos: async () => {
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
