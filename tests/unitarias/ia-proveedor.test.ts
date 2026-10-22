// Proveedor simulado (bloque P1): determinista, vectores unitarios de 1024 con sentido (palabras en común
// = más cerca), y cancelable. Y el esqueleto del real: falla con "no_implementado", nunca inventa.
import { describe, expect, it } from 'vitest';
import { DIMENSIONES } from '../../src/ia/contrato.js';
import { ErrorProveedor } from '../../src/ia/proveedor.js';
import { ProveedorAnthropic } from '../../src/ia/proveedor-anthropic.js';
import { ProveedorMock, vectorDe } from '../../src/ia/proveedor-mock.js';
import { verificarVectores } from '../../src/ia/servicio.js';

const coseno = (a: number[], b: number[]) => a.reduce((s, x, i) => s + x * (b[i] ?? 0), 0);
const senal = () => new AbortController().signal;

describe('proveedor simulado', () => {
  it('vectores de 1024, unitarios y deterministas; sin mayúsculas ni tildes', () => {
    const v = vectorDe('Índice de búsqueda');
    expect(v).toHaveLength(DIMENSIONES);
    expect(Math.hypot(...v)).toBeCloseTo(1, 10);
    expect(vectorDe('indice DE busqueda')).toEqual(v);
    expect(vectorDe('')).toEqual([1, ...new Array<number>(DIMENSIONES - 1).fill(0)]);
  });

  it('textos con palabras en común quedan más cerca que textos sin nada en común', () => {
    const consulta = vectorDe('migraciones de la base');
    expect(coseno(consulta, vectorDe('Cómo correr las migraciones de la base de datos'))).toBeGreaterThan(coseno(consulta, vectorDe('Receta de pan con queso')));
  });

  it('resumir y mejorar repiten el contenido recibido (así se ve una fuga entre espacios)', async () => {
    const p = new ProveedorMock();
    const trozos: string[] = [];
    for await (const t of p.transformar({ tarea: 'mejorar', contenido: 'uno dos tres', estilo: 'formal' }, senal())) trozos.push(t);
    expect(trozos.join('')).toBe('Versión formal simulada: uno dos tres');
    expect(p.generados).toBe(4);
  });

  it('cancelar: deja de generar en el acto', async () => {
    const p = new ProveedorMock({ retrasoFragmentoMs: 20 });
    const ac = new AbortController();
    const g = p.transformar({ tarea: 'mejorar', contenido: 'a b c d e f g h i j', estilo: 'claro' }, ac.signal);
    await g.next();
    ac.abort();
    await expect(g.next()).rejects.toMatchObject({ categoria: 'cancelado' });
    expect(p.generados).toBe(1);
  });

  it('verificarVectores: uno por texto y exactamente 1024 dimensiones finitas', () => {
    const v = vectorDe('alfa');
    expect(verificarVectores([v], 1)).toEqual([v]);
    expect(() => verificarVectores([v], 2)).toThrow('se esperaban 2');
    expect(() => verificarVectores([v.slice(1)], 1)).toThrow('1023 dimensiones');
    expect(() => verificarVectores([[Number.NaN, ...v.slice(1)]], 1)).toThrow('no finitos');
  });
});

describe('proveedor real (esqueleto)', () => {
  it('cada operación falla con no_implementado (502 ia_error_interno), nunca con una respuesta inventada', async () => {
    const p = new ProveedorAnthropic('clave-ficticia-de-prueba-123');
    await expect(p.explicar({ contenido: 'x', lenguaje: '' }, senal())).rejects.toBeInstanceOf(ErrorProveedor);
    await expect(p.embeber(['x'], senal())).rejects.toMatchObject({ categoria: 'no_implementado' });
    await expect(p.autocompletar({ antes: 'x', despues: '' }, senal())).rejects.toMatchObject({ categoria: 'no_implementado' });
    await expect(p.transformar({ tarea: 'resumir', contenido: 'x', estilo: 'claro' }, senal()).next()).rejects.toMatchObject({ categoria: 'no_implementado' });
  });
});
