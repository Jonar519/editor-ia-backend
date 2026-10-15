// "App autenticadora" de línea de comandos (solo para la demo): imprime el código TOTP vigente de un
// secreto base32, igual que lo haría una app del teléfono. No lee la base ni el .env, no guarda nada.
// Uso: tsx scripts/totp.ts JBSWY3DPEHPK3PXP
import { desdeBase32, PASO_S, totp } from '../src/auth/totp.js';

const secreto = process.argv[2];
if (!secreto || !/^[A-Z2-7]+=*$/i.test(secreto)) {
  console.error('Uso: totp <secreto en base32>');
  process.exit(2);
}
const ahora = Date.now();
const restan = PASO_S - (Math.floor(ahora / 1000) % PASO_S);
console.log(`${totp(desdeBase32(secreto.toUpperCase()), ahora)}  (vence en ${String(restan)} s)`);
