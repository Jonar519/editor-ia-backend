// Datos mínimos del cliente para la lista de sesiones: IP truncada y user-agent corto.
import { isIPv4, isIPv6 } from 'node:net';

/** IPv4 → /24, IPv6 → /48 (lo que exige la base). IPv4 mapeada en IPv6 se trata como IPv4. */
export function truncarIp(ip: string | undefined): string | null {
  if (!ip) return null;
  const limpia = ip.startsWith('::ffff:') && isIPv4(ip.slice(7)) ? ip.slice(7) : ip;
  if (isIPv4(limpia)) {
    const [a, b, c] = limpia.split('.');
    return `${a ?? '0'}.${b ?? '0'}.${c ?? '0'}.0/24`;
  }
  if (isIPv6(limpia)) {
    const [izq = '', der = ''] = limpia.split('::');
    const partesIzq = izq ? izq.split(':') : [];
    const partesDer = der ? der.split(':') : [];
    const ceros = Array<string>(8 - partesIzq.length - partesDer.length).fill('0');
    const grupos = limpia.includes('::') ? [...partesIzq, ...ceros, ...partesDer] : limpia.split(':');
    const prefijo = grupos.slice(0, 3).map((g) => (parseInt(g || '0', 16) || 0).toString(16));
    return `${prefijo.join(':')}::/48`;
  }
  return null;
}

/** "Firefox · Windows" a partir del user-agent; nunca más de 80 caracteres. */
export function userAgentCorto(ua: string | undefined): string | null {
  if (!ua) return null;
  const navegador =
    /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : null;
  const sistema =
    /Android/.test(ua) ? 'Android' : /iPhone|iPad|iOS/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : null;
  if (navegador && sistema) return `${navegador} · ${sistema}`;
  return (navegador ?? sistema ?? ua.replace(/[^\x20-\x7e]/g, '')).slice(0, 80) || null;
}
