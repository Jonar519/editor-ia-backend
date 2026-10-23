// Servicio de IA por gRPC REAL (bloque P1): los cuatro tipos de llamada, autenticación entre servicios,
// deadline, cancelación (el simulado deja de generar), salud estándar, errores del proveedor → estado gRPC
// → HTTP, y que una corriente nunca mezcle orígenes. Sin base ni Redis: el servicio no los tiene.
import * as grpc from '@grpc/grpc-js';
import { afterEach, describe, expect, it } from 'vitest';
import { ClienteIa } from '../../src/ia/cliente.js';
import { DIMENSIONES, paquete } from '../../src/ia/contrato.js';
import { falloDeGrpc } from '../../src/ia/errores.js';
import { ErrorProveedor, type ProveedorIa } from '../../src/ia/proveedor.js';
import { ProveedorMock } from '../../src/ia/proveedor-mock.js';
import { hasta, levantarIa, origenFicticio, textoLargo } from '../_ia.js';

type Ia = Awaited<ReturnType<typeof levantarIa>>;
const abiertos: Ia[] = [];
async function ia(o: Parameters<typeof levantarIa>[0] = {}): Promise<Ia> {
  const x = await levantarIa(o);
  abiertos.push(x);
  return x;
}
afterEach(async () => {
  for (const x of abiertos.splice(0)) await x.cerrar();
});

/** El código gRPC de una promesa rechazada. */
async function codigoDe(p: Promise<unknown>): Promise<grpc.status> {
  try {
    await p;
  } catch (e) {
    return (e as grpc.ServiceError).code;
  }
  throw new Error('se esperaba un error');
}

async function leerTodo(g: AsyncGenerator<string, unknown>): Promise<{ texto: string; fin: unknown }> {
  let texto = '';
  for (;;) {
    const r = await g.next();
    if (r.done) return { texto, fin: r.value };
    texto += r.value;
  }
}

describe('autenticación entre servicios', () => {
  it('sin token o con uno equivocado: UNAUTHENTICATED antes de llegar al proveedor', async () => {
    const x = await ia();
    const otro = x.clienteCon('x'.repeat(43));
    expect(await codigoDe(otro.explicar(origenFicticio(), 'hola', ''))).toBe(grpc.status.UNAUTHENTICATED);
    otro.cerrar();
    // Sin metadato authorization: un cliente crudo.
    const crudo = new paquete.cuaderno.ia.v1.Asistente(x.url, grpc.credentials.createInsecure());
    const sinToken = await new Promise<grpc.ServiceError | null>((r) => {
      crudo.Explicar({ origen: { cuenta_id: origenFicticio().cuentaId }, contenido: 'hola' }, { deadline: Date.now() + 2000 }, (e) => {
        r(e);
      });
    });
    crudo.close();
    expect(sinToken?.code).toBe(grpc.status.UNAUTHENTICATED);
    expect(x.mock.generados).toBe(0);
    expect(x.lineas.filter((l) => l.msg === 'ia: llamada sin token de servicio válido')).toHaveLength(2);
  });

  it('la salud estándar responde sin token (la consultan los orquestadores) y dice SERVING', async () => {
    const x = await ia();
    const otro = x.clienteCon('y'.repeat(43));
    await expect(otro.saludEstandar()).resolves.toBeUndefined();
    // La de /ready además pide Describir, que SÍ exige el token.
    await expect(otro.comprobarSalud()).rejects.toMatchObject({ code: grpc.status.UNAUTHENTICATED });
    otro.cerrar();
  });
});

describe('los cuatro tipos de llamada', () => {
  it('unaria: Explicar devuelve texto y uso; EmbeberConsulta, un vector unitario de 1024', async () => {
    const x = await ia();
    const r = await x.cliente.explicar(origenFicticio(), 'const total = suma(a, b);', 'ts');
    expect(r.texto).toContain('Explicación simulada (ts)');
    expect(r.uso.entrada).toBeGreaterThan(0);
    const v = await x.cliente.embeberConsulta(origenFicticio({ documentoId: '' }), 'índice de búsqueda');
    expect(v.vector).toHaveLength(DIMENSIONES);
    expect(Math.hypot(...v.vector)).toBeCloseTo(1, 4);
  });

  it('streaming del servidor: Resumir llega de a poco y termina con el uso', async () => {
    const x = await ia();
    const trozos: string[] = [];
    const g = x.cliente.transformar('resumir', origenFicticio(), 'Primera frase del documento ficticio. Segunda frase.', 'breve');
    let r = await g.next();
    while (!r.done) {
      trozos.push(r.value);
      r = await g.next();
    }
    expect(trozos.length).toBeGreaterThan(3);
    expect(trozos.join('')).toBe('Resumen simulado (breve): Primera frase del documento ficticio. Segunda frase.');
    expect(r.value.salida).toBeGreaterThan(0);
  });

  it('streaming del cliente: IndexarDocumento devuelve un vector por fragmento, en su índice', async () => {
    const x = await ia();
    const r = await x.cliente.indexar(origenFicticio(), [
      { indice: 0, contenido: 'alfa beta' },
      { indice: 1, contenido: 'gamma delta' },
      { indice: 2, contenido: 'alfa beta' },
    ]);
    expect([...r.vectores.keys()]).toEqual([0, 1, 2]);
    for (const v of r.vectores.values()) expect(v).toHaveLength(DIMENSIONES);
    // Determinista: el mismo texto, el mismo vector (con la precisión de float de 32 bits del contrato).
    expect(r.vectores.get(2)).toEqual(r.vectores.get(0));
    expect(r.vectores.get(1)).not.toEqual(r.vectores.get(0));
  });

  it('bidireccional: un pedido nuevo cancela la sugerencia anterior (que no llega y no se genera)', async () => {
    const x = await ia({ mock: { retrasoRespuestaMs: 150 } });
    const sesion = x.cliente.autocompletado(origenFicticio());
    const primero = sesion.pedir(1, 'La función devuelve', '');
    const segundo = sesion.pedir(2, 'La función devuelve el total', '');
    expect(await primero).toBeNull();
    expect((await segundo)?.texto).toContain('«total»');
    await new Promise((r) => setTimeout(r, 300));
    expect(x.mock.generados).toBe(1); // la del pedido 1 se canceló en el servicio
    sesion.cerrar();
  });
});

describe('deadline y cancelación', () => {
  it('deadline: DEADLINE_EXCEEDED (→ 504) y el simulado deja de generar', async () => {
    const x = await ia({ mock: { retrasoFragmentoMs: 50 }, deadlines: { transformar: 300 } });
    const g = x.cliente.transformar('mejorar', origenFicticio(), textoLargo('palabra', 200), 'claro');
    const codigo = await codigoDe(leerTodo(g));
    expect(codigo).toBe(grpc.status.DEADLINE_EXCEEDED);
    expect(falloDeGrpc(Object.assign(new Error(), { code: codigo, details: '', metadata: new grpc.Metadata() }))?.estado).toBe(504);
    await new Promise((r) => setTimeout(r, 100));
    const alCortar = x.mock.generados;
    expect(alCortar).toBeLessThan(20);
    await new Promise((r) => setTimeout(r, 400));
    expect(x.mock.generados).toBe(alCortar);
  });

  it('cancelar (abortar la señal) corta la llamada y el simulado deja de generar', async () => {
    const x = await ia({ mock: { retrasoFragmentoMs: 30 } });
    const ac = new AbortController();
    const g = x.cliente.transformar('mejorar', origenFicticio(), textoLargo('palabra', 200), 'claro', ac.signal);
    await g.next();
    await g.next();
    ac.abort();
    expect(await codigoDe(leerTodo(g))).toBe(grpc.status.CANCELLED);
    await new Promise((r) => setTimeout(r, 100));
    const alCortar = x.mock.generados;
    await new Promise((r) => setTimeout(r, 300));
    expect(x.mock.generados).toBe(alCortar);
    expect(alCortar).toBeLessThan(10);
    await hasta(() => x.lineas.some((l) => l.metodo === 'Mejorar' && l.codigo === 'CANCELLED'));
  });

  it('dejar de leer la corriente también cancela la generación', async () => {
    const x = await ia({ mock: { retrasoFragmentoMs: 30 } });
    const g = x.cliente.transformar('mejorar', origenFicticio(), textoLargo('palabra', 200), 'claro');
    await g.next();
    await g.return(undefined as never);
    await new Promise((r) => setTimeout(r, 100));
    const alCortar = x.mock.generados;
    await new Promise((r) => setTimeout(r, 300));
    expect(x.mock.generados).toBe(alCortar);
  });
});

describe('errores: proveedor → estado gRPC → HTTP (una fila de la tabla del ADR 0002 por caso)', () => {
  it.each([
    ['invalido', grpc.status.INVALID_ARGUMENT, 400, 'ia_solicitud_invalida'],
    ['limite', grpc.status.RESOURCE_EXHAUSTED, 429, 'ia_saturada'],
    ['no_disponible', grpc.status.UNAVAILABLE, 503, 'ia_no_disponible'],
    ['no_implementado', grpc.status.UNIMPLEMENTED, 502, 'ia_error_interno'],
    ['interno', grpc.status.INTERNAL, 502, 'ia_error_interno'],
  ] as const)('%s → %s → %s', async (categoria, codigo, http, nombre) => {
    const x = await ia();
    x.mock.fallo = new ErrorProveedor(categoria, 'falla simulada', categoria === 'limite' ? 7 : undefined);
    let error: grpc.ServiceError | null = null;
    try {
      await x.cliente.explicar(origenFicticio(), 'hola', '');
    } catch (e) {
      error = e as grpc.ServiceError;
    }
    expect(error?.code).toBe(codigo);
    const f = error ? falloDeGrpc(error) : null;
    expect(f?.estado).toBe(http);
    expect(f?.codigo).toBe(nombre);
    if (categoria === 'limite') expect(f?.reintentarEnS).toBe(7);
  });

  it('servicio caído: UNAVAILABLE → 503', async () => {
    const x = await ia();
    const url = x.url;
    await x.servicio.cerrar(100);
    const c = new ClienteIa({ url, token: x.token });
    expect(await codigoDe(c.explicar(origenFicticio(), 'hola', ''))).toBe(grpc.status.UNAVAILABLE);
    await expect(c.comprobarSalud()).rejects.toThrow();
    c.cerrar();
  });

  it('un vector que no es de 1024 dimensiones se rechaza (INTERNAL), nunca llega a la base', async () => {
    const corto = new ProveedorMock();
    const proveedor: ProveedorIa = {
      nombre: 'mock',
      modeloEmbeddings: 'corto',
      dimensiones: 512,
      explicar: (e, s) => corto.explicar(e, s),
      transformar: (e, s) => corto.transformar(e, s),
      autocompletar: (e, s) => corto.autocompletar(e, s),
      embeber: (textos) => Promise.resolve({ vectores: textos.map(() => new Array<number>(512).fill(0.01)), uso: { entrada: 1, salida: 0 } }),
    };
    const x = await ia({ proveedor });
    expect(await codigoDe(x.cliente.indexar(origenFicticio(), [{ indice: 0, contenido: 'alfa' }]))).toBe(grpc.status.INTERNAL);
    expect(await codigoDe(x.cliente.embeberConsulta(origenFicticio({ documentoId: '' }), 'alfa'))).toBe(grpc.status.INTERNAL);
    expect(x.lineas.some((l) => typeof l.err === 'object' && JSON.stringify(l.err).includes('512 dimensiones'))).toBe(true);
  });

  it('origen inválido, contenido vacío o demasiado largo: INVALID_ARGUMENT sin llegar al proveedor', async () => {
    const x = await ia();
    expect(await codigoDe(x.cliente.explicar(origenFicticio({ cuentaId: 'no-es-uuid' }), 'hola', ''))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await codigoDe(x.cliente.explicar(origenFicticio({ espacioId: '' }), 'hola', ''))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await codigoDe(x.cliente.explicar(origenFicticio(), '   ', ''))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(await codigoDe(x.cliente.explicar(origenFicticio(), 'x'.repeat(20_001), ''))).toBe(grpc.status.INVALID_ARGUMENT);
    expect(x.mock.generados).toBe(0);
  });
});

describe('aislamiento en el servicio', () => {
  it('una corriente de indexado no admite un segundo origen (no mezcla documentos ni espacios)', async () => {
    const x = await ia();
    const crudo = new paquete.cuaderno.ia.v1.Asistente(x.url, grpc.credentials.createInsecure());
    const md = new grpc.Metadata();
    md.set('authorization', `Bearer ${x.token}`);
    const a = origenFicticio();
    const b = origenFicticio();
    const err = await new Promise<grpc.ServiceError | null>((r) => {
      const l = crudo.IndexarDocumento(md, { deadline: Date.now() + 2000 }, (e) => {
        r(e);
      });
      l.write({ origen: { cuenta_id: a.cuentaId, espacio_id: a.espacioId, documento_id: a.documentoId ?? '' }, indice: 0, contenido: 'del espacio A' });
      l.write({ origen: { cuenta_id: b.cuentaId, espacio_id: b.espacioId, documento_id: b.documentoId ?? '' }, indice: 1, contenido: 'del espacio B' });
      l.end();
    });
    crudo.close();
    expect(err?.code).toBe(grpc.status.INVALID_ARGUMENT);
    expect(err?.details).toContain('primer mensaje');
  });

  it('dos corrientes simultáneas de espacios distintos: cada una recibe SOLO su contenido', async () => {
    const x = await ia({ mock: { retrasoFragmentoMs: 5 } });
    const [ra, rb] = await Promise.all([
      leerTodo(x.cliente.transformar('mejorar', origenFicticio(), textoLargo('espacioa', 60), 'claro')),
      leerTodo(x.cliente.transformar('mejorar', origenFicticio(), textoLargo('espaciob', 60), 'claro')),
    ]);
    expect(ra.texto).toContain('espacioa59');
    expect(ra.texto).not.toContain('espaciob');
    expect(rb.texto).toContain('espaciob59');
    expect(rb.texto).not.toContain('espacioa');
  });

  it('el log de cada llamada lleva los ids (espacio incluido), nunca el contenido', async () => {
    const x = await ia();
    const o = origenFicticio();
    await x.cliente.explicar(o, 'contenido-secreto-ficticio', '');
    await hasta(() => x.lineas.some((l) => l.metodo === 'Explicar'));
    const linea = x.lineas.find((l) => l.metodo === 'Explicar');
    expect(linea).toMatchObject({ cuenta: o.cuentaId, espacio: o.espacioId, documento: o.documentoId, codigo: 'OK' });
    expect(JSON.stringify(x.lineas)).not.toContain('contenido-secreto-ficticio');
  });
});

describe('salud estándar', () => {
  it('al apagarse pasa a NOT_SERVING (y /ready del API la vería como falla)', async () => {
    const x = await ia();
    await x.cliente.comprobarSalud();
    x.servicio.fijarSalud('NOT_SERVING');
    await expect(x.cliente.comprobarSalud()).rejects.toThrow('NOT_SERVING');
  });
});
