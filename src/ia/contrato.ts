// Carga del contrato gRPC (proto/) en tiempo de ejecución, con los tipos generados por
// npm run proto:generate (src/generated/ia). Lo usan los dos lados: el servicio de IA y el API.
import { fileURLToPath } from 'node:url';
import * as grpc from '@grpc/grpc-js';
import { loadSync, type Options } from '@grpc/proto-loader';
import type { ProtoGrpcType as TiposHealth } from '../generated/ia/health.js';
import type { ProtoGrpcType as TiposIa } from '../generated/ia/ia.js';

/** Dimensión de los vectores: la de la columna vector(1024) de la base (migración 0011). */
export const DIMENSIONES = 1024;

/** Nombre completo del servicio (también es el nombre que consulta grpc.health.v1). */
export const SERVICIO = 'cuaderno.ia.v1.Asistente';

/** Tienen que coincidir con las de scripts/proto-tipos.mjs, o los tipos no describen lo que llega. */
export const OPCIONES_CARGA: Options = { keepCase: true, longs: String, enums: String, defaults: true, oneofs: true };

// Desde src/ia/ y desde dist/ia/, la carpeta proto/ está dos niveles arriba.
const RAIZ_PROTO = fileURLToPath(new URL('../../proto', import.meta.url));

const definicion = loadSync(['cuaderno/ia/v1/ia.proto', 'grpc/health/v1/health.proto'], { ...OPCIONES_CARGA, includeDirs: [RAIZ_PROTO] });

export const paquete = grpc.loadPackageDefinition(definicion) as unknown as TiposIa & TiposHealth;

export type { AsistenteClient, AsistenteHandlers } from '../generated/ia/cuaderno/ia/v1/Asistente.js';
export type { HealthClient, HealthHandlers } from '../generated/ia/grpc/health/v1/Health.js';
export type { Origen } from '../generated/ia/cuaderno/ia/v1/Origen.js';
export type { Uso__Output as UsoGrpc } from '../generated/ia/cuaderno/ia/v1/Uso.js';
export type { Fragmento__Output as FragmentoGrpc } from '../generated/ia/cuaderno/ia/v1/Fragmento.js';
export type { Sugerencia__Output as SugerenciaGrpc } from '../generated/ia/cuaderno/ia/v1/Sugerencia.js';
export type { TransformarSolicitud } from '../generated/ia/cuaderno/ia/v1/TransformarSolicitud.js';
export type { ContextoAutocompletado } from '../generated/ia/cuaderno/ia/v1/ContextoAutocompletado.js';
