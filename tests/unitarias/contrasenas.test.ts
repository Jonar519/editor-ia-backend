import { describe, expect, it } from 'vitest';
import { hashearContrasena, LARGO_MINIMO, problemasDeContrasena, verificarContrasena } from '../../src/auth/contrasenas.js';

const CTX = { correo: 'ana.perez@example.com', nombre: 'Ana Pérez' };
/** El mismo patrón que exige el CHECK usuarios_hash_scrypt de la base. */
const FORMATO_BD = /^\$scrypt\$ln=[0-9]+,r=[0-9]+,p=[0-9]+\$[A-Za-z0-9+/]+\$[A-Za-z0-9+/]+$/;

describe('hash de contraseñas (scrypt)', () => {
  it('produce el formato que acepta la base y guarda su costo', async () => {
    const h = await hashearContrasena('una clave larga y segura', 10);
    expect(h).toMatch(FORMATO_BD);
    expect(h.startsWith('$scrypt$ln=10,r=8,p=1$')).toBe(true);
  });

  it('dos hashes de la misma clave son distintos (sal aleatoria)', async () => {
    expect(await hashearContrasena('una clave larga y segura', 10)).not.toBe(await hashearContrasena('una clave larga y segura', 10));
  });

  it('verifica la correcta y rechaza la incorrecta', async () => {
    const h = await hashearContrasena('una clave larga y segura', 10);
    expect(await verificarContrasena('una clave larga y segura', h)).toBe(true);
    expect(await verificarContrasena('una clave larga y segurA', h)).toBe(false);
  });

  it('normaliza Unicode (NFKC): la misma tilde escrita de dos formas vale igual', async () => {
    const compuesta = 'contraseña muy larga';
    const descompuesta = 'contraseña muy larga';
    const h = await hashearContrasena(compuesta, 10);
    expect(await verificarContrasena(descompuesta, h)).toBe(true);
  });

  it('un hash manipulado o con formato inválido nunca valida', async () => {
    const h = await hashearContrasena('una clave larga y segura', 10);
    const partes = h.split('$');
    const alterado = [...partes.slice(0, -1), `${(partes.at(-1) ?? '').slice(0, -2)}AA`].join('$');
    expect(await verificarContrasena('una clave larga y segura', alterado)).toBe(false);
    expect(await verificarContrasena('x', 'texto-plano')).toBe(false);
    expect(await verificarContrasena('x', '$scrypt$ln=99,r=8,p=1$AAAA$AAAA')).toBe(false);
  });
});

describe('política de contraseñas', () => {
  it(`exige ${String(LARGO_MINIMO)}+ caracteres (11 no, 12 sí)`, () => {
    expect(problemasDeContrasena('Kp9#mT2$vL4', CTX)).toContain('debe tener al menos 12 caracteres');
    expect(problemasDeContrasena('Kp9#mT2$vL4q', CTX)).toEqual([]);
  });

  it('cuenta caracteres, no bytes (emojis y tildes)', () => {
    expect(problemasDeContrasena('ñandú🐧ñandú🐧xy', CTX)).toEqual([]);
    expect(problemasDeContrasena('🐧🐧🐧🐧🐧🐧ab', CTX)).toContain('debe tener al menos 12 caracteres');
  });

  it('pone tope de 128 caracteres', () => {
    expect(problemasDeContrasena('ab1'.repeat(43), CTX)).toContain('debe tener como máximo 128 caracteres');
  });

  it('rechaza comunes, repetidas y las que contienen el correo o el nombre', () => {
    expect(problemasDeContrasena('Password1234', CTX)).toContain('es una contraseña demasiado común');
    expect(problemasDeContrasena('abababababab', CTX)).toContain('repite demasiado los mismos caracteres');
    expect(problemasDeContrasena('mi-ana.perez-2026', CTX)).toContain('no puede contener tu correo');
    expect(problemasDeContrasena('soy ana pérez 2026!', CTX)).toContain('no puede contener tu nombre');
  });

  it('acepta una frase larga', () => {
    expect(problemasDeContrasena('caballo correcto batería grapa', CTX)).toEqual([]);
  });
});
