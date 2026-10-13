import { describe, expect, it } from 'vitest';
import { accionPorPrivilegios, problemasDePrivilegios, type PrivilegiosBd } from '../../src/infra/privilegios.js';

describe('accionPorPrivilegios', () => {
  it('sin problemas continúa en cualquier entorno', () => {
    expect(accionPorPrivilegios('production', [])).toBe('continuar');
    expect(accionPorPrivilegios('development', [])).toBe('continuar');
  });

  it('con problemas: producción aborta; desarrollo y pruebas solo avisan', () => {
    expect(accionPorPrivilegios('production', ['x es superusuario'])).toBe('abortar');
    expect(accionPorPrivilegios('development', ['x es superusuario'])).toBe('avisar');
    expect(accionPorPrivilegios('test', ['x es superusuario'])).toBe('avisar');
  });
});

const minimo: PrivilegiosBd = {
  usuario: 'cuaderno_app',
  superusuario: false,
  creaBases: false,
  creaRoles: false,
  saltaRls: false,
  tablasPropias: 0,
  creaEnPublic: false,
};

describe('problemasDePrivilegios', () => {
  it('un rol de privilegios mínimos no tiene problemas', () => {
    expect(problemasDePrivilegios(minimo)).toEqual([]);
  });

  it.each([
    ['superusuario', { superusuario: true }, /superusuario/],
    ['crear bases', { creaBases: true }, /crear bases/],
    ['crear roles', { creaRoles: true }, /crear roles/],
    ['saltarse RLS', { saltaRls: true }, /RLS/],
    ['dueño de tablas', { tablasPropias: 21 }, /dueño de 21 tablas/],
    ['crear en public', { creaEnPublic: true }, /esquema public/],
  ] as const)('detecta: %s', (_nombre, cambio, patron) => {
    const p = problemasDePrivilegios({ ...minimo, ...cambio });
    expect(p).toHaveLength(1);
    expect(p[0]).toMatch(patron);
  });

  it('el dueño de las tablas (como cuaderno en desarrollo) acumula todos sus problemas', () => {
    const dueno = { ...minimo, usuario: 'cuaderno', superusuario: true, creaBases: true, creaRoles: true, saltaRls: true, tablasPropias: 22 };
    expect(problemasDePrivilegios(dueno)).toHaveLength(5);
  });
});
