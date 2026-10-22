// Punto de entrada del SERVICIO de IA (proceso aparte del API, ADR 0002): npm run ia:dev (desarrollo) o
// npm run ia:start (compilado). Valida su configuración, elige el proveedor, escucha en IA_HOST:IA_PORT
// (127.0.0.1:4210 por defecto) y se apaga en orden con SIGTERM/SIGINT.
import { readFileSync } from 'node:fs';
import * as grpc from '@grpc/grpc-js';
import { ErrorConfig } from '../config/entorno.js';
import { crearLogger } from '../observabilidad/log.js';
import { cargarConfigIa, type ConfigIa } from './config.js';
import type { ProveedorIa } from './proveedor.js';
import { ProveedorAnthropic } from './proveedor-anthropic.js';
import { ProveedorMock } from './proveedor-mock.js';
import { crearServicioIa } from './servicio.js';

function proveedorDe(c: ConfigIa): ProveedorIa {
  if (c.AI_PROVIDER === 'anthropic') return new ProveedorAnthropic(c.ANTHROPIC_API_KEY ?? '');
  return new ProveedorMock({ retrasoFragmentoMs: c.IA_MOCK_RETRASO_MS });
}

/** TLS mutuo: el servicio presenta su certificado y EXIGE uno del API firmado por la CA indicada. */
function credencialesDe(c: ConfigIa): grpc.ServerCredentials | undefined {
  if (!c.IA_TLS_CERT || !c.IA_TLS_KEY || !c.IA_TLS_CA) return undefined;
  return grpc.ServerCredentials.createSsl(readFileSync(c.IA_TLS_CA), [{ cert_chain: readFileSync(c.IA_TLS_CERT), private_key: readFileSync(c.IA_TLS_KEY) }], true);
}

async function main(): Promise<void> {
  let config: ConfigIa;
  try {
    config = cargarConfigIa(process.env);
  } catch (e) {
    if (e instanceof ErrorConfig) {
      console.error(e.message);
      process.exit(1);
    }
    throw e;
  }
  const log = crearLogger(config.LOG_LEVEL, undefined, 'cuaderno-ia');
  const proveedor = proveedorDe(config);
  const credenciales = credencialesDe(config);
  const servicio = crearServicioIa({ proveedor, token: config.IA_SERVICE_TOKEN, log, ...(credenciales ? { credenciales } : {}) });
  const puerto = await servicio.escuchar(config.IA_HOST, config.IA_PORT);
  log.info(
    { host: config.IA_HOST, puerto, proveedor: proveedor.nombre, tls: credenciales !== undefined, redPrivada: config.IA_RED_PRIVADA, entorno: config.NODE_ENV },
    'Cuaderno IA escuchando (gRPC)',
  );

  let apagando = false;
  for (const senal of ['SIGTERM', 'SIGINT'] as const) {
    process.once(senal, () => {
      if (apagando) return;
      apagando = true;
      log.info({ senal }, 'ia: apagado ordenado');
      void servicio.cerrar(config.SHUTDOWN_TIMEOUT_MS).then(() => process.exit(0));
    });
  }
}

void main();
