import type { Redis } from 'ioredis';
import type { ProveedorCorreo } from './correo/proveedor.js';
import type { PrismaClient } from './generated/prisma/client.js';

/** Lo que necesitan las rutas del API. Las pruebas lo arman con la base y el Redis de pruebas. */
export interface DependenciasApi {
  prisma: PrismaClient;
  redis: Redis;
  correo: ProveedorCorreo;
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
}
