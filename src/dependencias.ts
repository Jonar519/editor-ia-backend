import type { Redis } from 'ioredis';
import type { ProveedorCorreo } from './correo/proveedor.js';
import type { PrismaClient } from './generated/prisma/client.js';
import type { ProveedorGeo } from './geo/proveedor.js';
import type { ClienteIa } from './ia/cliente.js';
import type { Indexador } from './ia/indexado.js';
import type { TopesIa } from './ia/uso.js';
import type { ContenidoVivo } from './tiempo-real/servidor.js';

/** Lo que necesitan las rutas del API. Las pruebas lo arman con la base y el Redis de pruebas. */
export interface DependenciasApi {
  prisma: PrismaClient;
  redis: Redis;
  correo: ProveedorCorreo;
  /** Ubicación aproximada de una red truncada (lista de sesiones). */
  geo: ProveedorGeo;
  /** Clave HMAC de los access tokens (ACCESS_TOKEN_SECRET decodificada). */
  claveAcceso: Buffer;
  /** Clave AES-256-GCM de los secretos TOTP (MFA_ENCRYPTION_KEY decodificada). */
  claveMfa: Buffer;
  /** Origen del frontend: enlaces de correo y verificación de Origin. */
  appUrl: string;
  cookieSegura: boolean;
  /** log2 del N de scrypt para hashes nuevos. */
  costoHash: number;
  /** Hash señuelo (mismo costo) para igualar tiempos cuando el correo no existe. */
  senuelo: string;
  /** Prefijo de las claves de Redis (las pruebas usan uno propio por corrida). */
  prefijoRedis: string;
  /**
   * El documento en memoria del servidor de tiempo real (bloque N: versiones y comentarios). Sin él
   * (pruebas que no levantan el tiempo real), esas rutas responden 503.
   */
  contenido?: ContenidoVivo;
  /** Cliente del servicio de IA (bloque P1). Sin él, las rutas de IA responden 503 ia_no_disponible. */
  ia?: ClienteIa;
  /** Cola de indexado para la búsqueda semántica (BullMQ). */
  indexador?: Indexador;
  /** Tope diario de IA por cuenta (IA_TOPE_*; las pruebas lo bajan). */
  topesIa?: TopesIa;
  /** Similitud coseno mínima de un resultado de búsqueda (IA_SIMILITUD_MINIMA). */
  similitudMinimaIa?: number;
  /** Límite general de pedidos por minuto y cuenta (LIMITE_PEDIDOS_MINUTO). Sin él, 600. */
  limitePedidosMinuto?: number;
}
