// Contraseñas: scrypt de node:crypto (sin dependencias nativas) y política de 12+ caracteres.
// Formato guardado (lo exige un CHECK de la base): $scrypt$ln=<log2 N>,r=<r>,p=<p>$<sal>$<hash>
// con sal y hash en base64 sin relleno. Cada hash guarda su costo: subir el costo no rompe los viejos.
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type ScryptOptions } from 'node:crypto';

const R = 8;
const P = 1;
const LARGO_HASH = 32;
const LARGO_SAL = 16;

export const LARGO_MINIMO = 12;
/** Tope para que una contraseña enorme no sirva para gastar CPU del servidor. */
export const LARGO_MAXIMO = 128;

function scrypt(clave: string, sal: Buffer, largo: number, opciones: ScryptOptions): Promise<Buffer> {
  return new Promise((resolver, rechazar) => {
    scryptCb(clave.normalize('NFKC'), sal, largo, opciones, (err, derivada) => {
      if (err) rechazar(err);
      else resolver(derivada);
    });
  });
}

const b64 = (b: Buffer) => b.toString('base64').replace(/=+$/, '');

/** Memoria que necesita scrypt (128·N·r bytes) más margen. */
const memoria = (ln: number) => 128 * 2 ** ln * R * 2;

export async function hashearContrasena(clave: string, ln: number): Promise<string> {
  const sal = randomBytes(LARGO_SAL);
  const derivada = await scrypt(clave, sal, LARGO_HASH, { N: 2 ** ln, r: R, p: P, maxmem: memoria(ln) });
  return `$scrypt$ln=${String(ln)},r=${String(R)},p=${String(P)}$${b64(sal)}$${b64(derivada)}`;
}

const FORMATO = /^\$scrypt\$ln=(\d+),r=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

/** Compara en tiempo constante. Un hash con formato inválido nunca valida. */
export async function verificarContrasena(clave: string, hash: string): Promise<boolean> {
  const m = FORMATO.exec(hash);
  if (!m) return false;
  const [, ln, r, p, sal, esperado] = m.map((x, i) => (i <= 3 ? Number(x) : x)) as [unknown, number, number, number, string, string];
  if (ln < 10 || ln > 20 || r !== R || p !== P) return false;
  const objetivo = Buffer.from(esperado, 'base64');
  const derivada = await scrypt(clave, Buffer.from(sal, 'base64'), objetivo.length, { N: 2 ** ln, r, p, maxmem: memoria(ln) });
  return derivada.length === objetivo.length && timingSafeEqual(derivada, objetivo);
}

/**
 * Hash señuelo: cuando el correo no existe se verifica contra él, para que la respuesta tarde lo mismo
 * que con una cuenta real (no se puede averiguar qué correos existen midiendo el tiempo).
 */
export function crearSenuelo(ln: number): Promise<string> {
  return hashearContrasena(randomBytes(24).toString('base64'), ln);
}

/** Lista corta de contraseñas comunes de 12+ caracteres (las de menos ya caen por el largo). */
const COMUNES = new Set([
  'contraseña123', 'contrasena123', 'contraseña1234', 'contrasena1234', 'password1234', 'password12345',
  'passwordpassword', '123456789012', '1234567890123', 'qwertyuiop12', 'qwertyuiopasdf', 'administrador',
  'administrator', 'iloveyou1234', 'cuadernocuaderno', 'cuaderno1234', 'abcdefghijkl', 'aaaaaaaaaaaa',
  'holahola1234', 'bienvenido123', 'welcome12345', 'letmein12345', 'superusuario1', '000000000000',
]);

export interface ContextoContrasena {
  correo: string;
  nombre: string;
}

/** Devuelve la lista de problemas (vacía si la contraseña sirve). */
export function problemasDeContrasena(clave: string, ctx: ContextoContrasena): string[] {
  const p: string[] = [];
  // Largo en puntos de código (una tilde o un emoji cuentan como un carácter, no como varios).
  const largo = Array.from(clave).length;
  if (largo < LARGO_MINIMO) p.push(`debe tener al menos ${String(LARGO_MINIMO)} caracteres`);
  if (largo > LARGO_MAXIMO) p.push(`debe tener como máximo ${String(LARGO_MAXIMO)} caracteres`);
  const minus = clave.toLowerCase();
  if (COMUNES.has(minus)) p.push('es una contraseña demasiado común');
  if (largo > 0 && new Set(clave).size <= 2) p.push('repite demasiado los mismos caracteres');
  const usuarioCorreo = ctx.correo.toLowerCase().split('@')[0] ?? '';
  if (usuarioCorreo.length >= 4 && minus.includes(usuarioCorreo)) p.push('no puede contener tu correo');
  const nombre = ctx.nombre.toLowerCase().replace(/\s+/g, '');
  if (nombre.length >= 4 && minus.replace(/\s+/g, '').includes(nombre)) p.push('no puede contener tu nombre');
  return p;
}
