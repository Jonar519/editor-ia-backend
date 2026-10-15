// Ubicación aproximada de una IP (ya truncada a /24 o /48) para la lista de sesiones. Sin servicios
// externos: "mock" (por defecto) devuelve un texto fijo y "tabla_local" busca en rangos_ip_geo.
// Producción se niega a arrancar con "mock". Nunca recibe la IP completa: solo la red truncada.
import type { PrismaClient } from '../generated/prisma/client.js';

export interface ProveedorGeo {
  nombre: 'mock' | 'tabla_local';
  /** "Ciudad, Región, PA", o null si no se sabe. Nunca más de 120 caracteres (lo exige la base). */
  ubicar: (ipRed: string | null) => Promise<string | null>;
}

/**
 * Redes que no se pueden ubicar: loopback, privadas y enlace local. Llegan truncadas por truncarIp:
 * "::1" se vuelve "0:0:0::/48".
 */
const LOCALES = [/^127\./, /^10\./, /^172\.(1[6-9]|2\d|3[01])\./, /^192\.168\./, /^0:0:0::\/48$/, /^f[cd][0-9a-f]{0,2}:/i, /^fe[89ab][0-9a-f]:/i];

export const esRedLocal = (ipRed: string) => LOCALES.some((r) => r.test(ipRed));

export function geoMock(): ProveedorGeo {
  return {
    nombre: 'mock',
    ubicar: (ipRed) => Promise.resolve(ipRed === null ? null : esRedLocal(ipRed) ? 'Red local' : 'Ubicación simulada'),
  };
}

export function geoTablaLocal(prisma: PrismaClient): ProveedorGeo {
  return {
    nombre: 'tabla_local',
    ubicar: async (ipRed) => {
      if (ipRed === null) return null;
      if (esRedLocal(ipRed)) return 'Red local';
      // Los rangos no se solapan (EXCLUDE en la base): a lo sumo una fila.
      const filas = await prisma.$queryRaw<{ ciudad: string | null; region: string | null; pais: string }[]>`
        SELECT ciudad, region, pais FROM rangos_ip_geo WHERE red >>= ${ipRed}::cidr LIMIT 1`;
      const f = filas[0];
      if (!f) return null;
      return [f.ciudad, f.region, f.pais].filter((x): x is string => Boolean(x)).join(', ').slice(0, 120);
    },
  };
}

export function crearProveedorGeo(c: { GEO_PROVIDER: 'mock' | 'tabla_local' }, prisma: PrismaClient): ProveedorGeo {
  return c.GEO_PROVIDER === 'tabla_local' ? geoTablaLocal(prisma) : geoMock();
}
