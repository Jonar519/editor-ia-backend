// Medición de almacenamiento de versiones (riesgo R-02, bloque R): la cuenta del peor caso sale del límite
// VIGENTE de guardar y restaurar, y el informe abre con lo que la medición NO permite concluir.
import { describe, expect, it } from 'vitest';
import { generarInformeAlmacenamiento, proyeccion, TITULO_LIMITES_ALMACENAMIENTO, type DatosAlmacenamiento } from '../../scripts/carga/informe-almacenamiento.js';
import { LIMITES_VERSIONES } from '../../src/versiones/rutas.js';

const datos: DatosAlmacenamiento = {
  entorno: { fecha: '2026-10-27T00:00:00.000Z', sistema: 'Linux 6.6', node: 'v24.20.0', postgres: '16.15', cargaInicial: 1 },
  rapido: false,
  limite: { ...LIMITES_VERSIONES.versiones },
  casos: [
    {
      caracteres: 9_000_000,
      contenido: 'aleatorio',
      respuestas: [...Array<number>(30).fill(201), 429],
      versionesGuardadas: 30,
      bytesEstadoPorVersion: 9 * 2 ** 20,
      bytesTextoPorVersion: 9 * 2 ** 20,
      bytesSinComprimirPorVersion: 18 * 2 ** 20,
      bytesTablaPorVersion: 18 * 2 ** 20,
      msGuardarMediana: 300,
      msGuardarMax: 400,
      msVerificar: 2000,
    },
  ],
  baseAntesBytes: 9 * 2 ** 20,
  baseDespuesBytes: 549 * 2 ** 20,
};

describe('almacenamiento de versiones (R-02)', () => {
  it('el peor caso por cuenta es el límite vigente: 30 versiones por hora, 24 horas', () => {
    expect(LIMITES_VERSIONES.versiones).toEqual({ max: 30, ventanaMs: 60 * 60_000 });
    const p = proyeccion(2 ** 20);
    expect(p.porHora).toBe(30 * 2 ** 20);
    expect(p.porDia).toBe(24 * 30 * 2 ** 20);
  });

  it('el informe abre con lo que la medición NO permite concluir, antes de cualquier tabla', () => {
    const md = generarInformeAlmacenamiento(datos);
    const limites = md.indexOf(TITULO_LIMITES_ALMACENAMIENTO);
    expect(limites).toBeGreaterThan(0);
    expect(limites).toBeLessThan(md.indexOf('|'));
  });

  it('muestra cuándo cortó el límite y la cuenta por hora y por día', () => {
    const md = generarInformeAlmacenamiento(datos);
    expect(md).toContain('| 9 000 000 caracteres, aleatorio | 30 | sí (pedido 31) | 18,0 MiB | 18,0 MiB | 18,0 MiB | 300 / 400 | 2000 |');
    expect(md).toContain('| 9 000 000 caracteres, aleatorio | 18,0 MiB | 540,0 MiB | 12,66 GiB |');
  });
});
