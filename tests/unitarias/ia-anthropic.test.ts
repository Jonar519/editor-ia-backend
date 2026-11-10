// Proveedor real (Claude + Voyage) contra un fetch FALSO: el SDK oficial arma y lee los pedidos de verdad,
// pero nada sale a la red. Sujeta: sistema y usuario separados (también con toda la batería de inyección),
// streaming con AbortSignal, stop_reason y refusal, 429 con Retry-After, 5xx/red a no_disponible, el
// modelo del autocompletado sin reintentos, los fallbacks y los embeddings de exactamente 1024.
import { describe, expect, it } from 'vitest';
import { DIMENSIONES } from '../../src/ia/contrato.js';
import { enLotes, LOTE_MAX_TEXTOS, URL_VOYAGE } from '../../src/ia/embeddings-voyage.js';
import { escaparXml, type Tarea } from '../../src/ia/prompt.js';
import { BETA_FALLBACK, ProveedorAnthropic, type OpcionesAnthropic } from '../../src/ia/proveedor-anthropic.js';
import { ErrorProveedor } from '../../src/ia/proveedor.js';
import { claveFicticia, fetchFalso, respuestas as r, type Pedido, type Responder } from '../_anthropic-falso.js';
import { responderIngenuo } from '../_modelo-ingenuo.js';
import { CARGAS } from '../_cargas-inyeccion.js';

const senal = () => new AbortController().signal;

function proveedor(responder: Responder, o: Partial<OpcionesAnthropic> = {}) {
  const f = fetchFalso(responder);
  const p = new ProveedorAnthropic({
    clave: claveFicticia(),
    modelo: 'claude-opus-5-5',
    voyage: { clave: claveFicticia(), modelo: 'voyage-3.5' },
    fetch: f.fetch,
    reintentos: 0,
    ...o,
  });
  return { p, pedidos: f.pedidos };
}

const esAnthropic = (p: Pedido) => p.url.startsWith('https://api.anthropic.com/v1/messages');

async function consumir(g: AsyncGenerator<string, unknown>): Promise<{ trozos: string[]; fin: unknown }> {
  const trozos: string[] = [];
  for (;;) {
    const x = await g.next();
    if (x.done) return { trozos, fin: x.value };
    trozos.push(x.value);
  }
}

describe('Claude: forma del pedido', () => {
  it('explicar: sistema y usuario SEPARADOS, modelo, effort y fallbacks; devuelve texto y uso', async () => {
    const { p, pedidos } = proveedor(() => r.mensaje('Explica el bucle.', { entrada: 30, salida: 8 }));
    const out = await p.explicar({ contenido: 'for (;;) {}', lenguaje: 'ts' }, senal());
    expect(out).toEqual({ texto: 'Explica el bucle.', uso: { entrada: 30, salida: 8 } });
    const [pedido] = pedidos;
    expect(pedido && esAnthropic(pedido)).toBe(true);
    const c = pedido?.cuerpo ?? {};
    expect(c.model).toBe('claude-opus-5-5');
    expect(typeof c.system).toBe('string');
    const mensajes = c.messages as { role: string; content: string }[];
    expect(mensajes).toHaveLength(1);
    expect(mensajes[0]?.role).toBe('user');
    expect(mensajes[0]?.content).toMatch(/^<documento-[0-9a-f]{32}>\nfor \(;;\) \{\}\n<\/documento-[0-9a-f]{32}>$/);
    expect(String(c.system)).not.toContain('for (;;)');
    expect(c.output_config).toEqual({ effort: 'medium' });
    expect(c.fallbacks).toBe('default');
    expect(pedido?.headers['anthropic-beta']).toContain(BETA_FALLBACK);
    // Ni muestreo ni thinking explícito (400 con la versión de API del SDK / thinking adaptativo por defecto).
    for (const k of ['temperature', 'top_p', 'top_k', 'thinking']) expect(c).not.toHaveProperty(k);
    // El SDK 1.x manda la clave como Bearer (la ficticia de esta prueba, nunca una del entorno).
    expect(pedido?.headers.authorization).toMatch(/^Bearer falsa-/);
  });

  it('autocompletar: su propio modelo, effort low, sin reintentos aunque el cliente los tenga', async () => {
    let n = 0;
    const { p, pedidos } = proveedor(
      () => {
        n++;
        return r.errorApi(500, { 'retry-after-ms': '1' });
      },
      { modeloAutocompletar: 'claude-haiku-5-5', reintentos: 1 },
    );
    await expect(p.autocompletar({ antes: 'Hola', despues: '' }, senal())).rejects.toMatchObject({ categoria: 'no_disponible' });
    expect(n).toBe(1);
    expect(pedidos[0]?.cuerpo.model).toBe('claude-haiku-5-5');
    expect(pedidos[0]?.cuerpo.output_config).toEqual({ effort: 'low' });
    // Haiku no tiene fallback del lado del servidor: ni el parámetro ni la cabecera beta.
    expect(pedidos[0]?.cuerpo).not.toHaveProperty('fallbacks');
    expect(pedidos[0]?.headers['anthropic-beta'] ?? '').not.toContain(BETA_FALLBACK);
    // explicar sí reintenta una vez (el mismo 500, con retry-after-ms para no esperar).
    n = 0;
    await expect(p.explicar({ contenido: 'x', lenguaje: '' }, senal())).rejects.toMatchObject({ categoria: 'no_disponible' });
    expect(n).toBe(2);
  });

  it('sin ANTHROPIC_MODEL_AUTOCOMPLETAR, el autocompletado usa ANTHROPIC_MODEL', async () => {
    const { p, pedidos } = proveedor(() => r.mensaje(' y sigue.'));
    expect((await p.autocompletar({ antes: 'Esto', despues: '' }, senal())).texto).toBe(' y sigue.');
    expect(pedidos[0]?.cuerpo.model).toBe('claude-opus-5-5');
  });
});

describe('batería de inyección con el proveedor real', () => {
  const TAREAS: Tarea[] = ['explicar', 'resumir', 'mejorar', 'autocompletar'];
  for (const tarea of TAREAS) {
    it(`${tarea}: ninguna carga sale del bloque de datos ni llega al mensaje de sistema`, async () => {
      const sistemas = new Set<string>();
      for (const carga of CARGAS) {
        const { p, pedidos } = proveedor((_pedido) => (tarea === 'resumir' || tarea === 'mejorar' ? r.corriente(['ok']) : r.mensaje('ok')));
        if (tarea === 'explicar') await p.explicar({ contenido: carga, lenguaje: 'ts' }, senal());
        else if (tarea === 'autocompletar') await p.autocompletar({ antes: carga, despues: carga }, senal());
        else await consumir(p.transformar({ tarea, contenido: carga, estilo: 'formal' }, senal()));
        const c = pedidos[0]?.cuerpo ?? {};
        const mensajes = c.messages as { role: string; content: string }[];
        expect(mensajes).toHaveLength(1);
        expect(mensajes[0]?.role).toBe('user');
        const usuario = mensajes[0]?.content ?? '';
        const nonce = /^<(?:documento|antes)-([0-9a-f]{32})>/.exec(usuario)?.[1] ?? '';
        expect(nonce).toMatch(/^[0-9a-f]{32}$/);
        const sistema = String(c.system);
        // El modelo crédulo no encuentra nada que obedecer fuera de los bloques.
        expect(responderIngenuo({ sistema, usuario, nonce })).toBe('ok');
        // La carga va entera y escapada en el usuario, y nunca en el sistema.
        expect(usuario).toContain(escaparXml(carga));
        if (carga.length > 12) expect(sistema).not.toContain(escaparXml(carga));
        // Las instrucciones son las mismas sea cual sea el contenido (salvo el nonce de cada llamada).
        sistemas.add(sistema.replaceAll(nonce, 'N'));
      }
      expect(sistemas.size).toBe(1);
    });
  }
});

describe('Claude: stop_reason y refusal', () => {
  it('refusal es un error "invalido" (nunca una respuesta vacía), sin leer el contenido', async () => {
    const { p } = proveedor(() => r.mensaje('', { stop: 'refusal' }));
    const e = await p.explicar({ contenido: 'x', lenguaje: '' }, senal()).catch((x: unknown) => x);
    expect(e).toBeInstanceOf(ErrorProveedor);
    expect(e).toMatchObject({ categoria: 'invalido' });
  });

  it('max_tokens entrega lo generado (el servicio recorta a sus topes)', async () => {
    const { p } = proveedor(() => r.mensaje('texto cortado', { stop: 'max_tokens' }));
    expect((await p.explicar({ contenido: 'x', lenguaje: '' }, senal())).texto).toBe('texto cortado');
  });

  it('un stop_reason inesperado (tool_use, pause_turn) es "interno"', async () => {
    for (const stop of ['tool_use', 'pause_turn']) {
      const { p } = proveedor(() => r.mensaje('x', { stop }));
      await expect(p.explicar({ contenido: 'x', lenguaje: '' }, senal())).rejects.toMatchObject({ categoria: 'interno' });
    }
  });

  it('refusal al final de una corriente: después de los fragmentos, error "invalido"', async () => {
    const { p } = proveedor(() => r.corriente(['Un ', 'resumen'], { stop: 'refusal' }));
    const g = p.transformar({ tarea: 'resumir', contenido: 'x', estilo: 'claro' }, senal());
    expect((await g.next()).value).toBe('Un ');
    expect((await g.next()).value).toBe('resumen');
    await expect(g.next()).rejects.toMatchObject({ categoria: 'invalido' });
  });
});

describe('Claude: errores', () => {
  it('429 → "limite" con el Retry-After de Anthropic', async () => {
    const { p } = proveedor(() => r.errorApi(429, { 'retry-after': '7' }));
    await expect(p.explicar({ contenido: 'x', lenguaje: '' }, senal())).rejects.toMatchObject({ categoria: 'limite', reintentarEnS: 7 });
  });

  it('429 sin Retry-After o con uno mal formado → "limite" sin segundos', async () => {
    for (const h of [{}, { 'retry-after': 'mañana' }]) {
      const { p } = proveedor(() => r.errorApi(429, h));
      const e = (await p.explicar({ contenido: 'x', lenguaje: '' }, senal()).catch((x: unknown) => x)) as ErrorProveedor;
      expect(e.categoria).toBe('limite');
      expect(e.reintentarEnS).toBeUndefined();
    }
  });

  it('5xx y 529 (saturado) → "no_disponible"', async () => {
    for (const estado of [500, 502, 503, 529]) {
      const { p } = proveedor(() => r.errorApi(estado));
      await expect(p.explicar({ contenido: 'x', lenguaje: '' }, senal())).rejects.toMatchObject({ categoria: 'no_disponible' });
    }
  });

  it('red caída → "no_disponible"', async () => {
    const { p } = proveedor(() => {
      throw new TypeError('fetch failed');
    });
    await expect(p.explicar({ contenido: 'x', lenguaje: '' }, senal())).rejects.toMatchObject({ categoria: 'no_disponible' });
  });

  it('clave o modelo mal configurados (401, 404, 400) → "interno"; 413 → "invalido"', async () => {
    for (const [estado, categoria] of [
      [401, 'interno'],
      [404, 'interno'],
      [400, 'interno'],
      [413, 'invalido'],
    ] as const) {
      const { p } = proveedor(() => r.errorApi(estado));
      await expect(p.explicar({ contenido: 'x', lenguaje: '' }, senal())).rejects.toMatchObject({ categoria });
    }
  });

  it('un error en la corriente también se traduce (429 al abrirla)', async () => {
    const { p } = proveedor(() => r.errorApi(429, { 'retry-after': '3' }));
    await expect(consumir(p.transformar({ tarea: 'mejorar', contenido: 'x', estilo: 'claro' }, senal()))).rejects.toMatchObject({
      categoria: 'limite',
      reintentarEnS: 3,
    });
  });
});

describe('Claude: streaming y cancelación', () => {
  it('resumir y mejorar: cada text_delta es un fragmento, en orden; al terminar, el uso', async () => {
    const { p, pedidos } = proveedor(() => r.corriente(['Uno', ' dos', ' tres']));
    const { trozos, fin } = await consumir(p.transformar({ tarea: 'mejorar', contenido: 'uno dos tres', estilo: 'formal' }, senal()));
    expect(trozos).toEqual(['Uno', ' dos', ' tres']);
    expect(fin).toEqual({ entrada: 20, salida: 9 });
    expect(pedidos[0]?.cuerpo.stream).toBe(true);
  });

  it('abortar la señal corta la corriente: "cancelado" y el fetch recibió esa señal abortada', async () => {
    const ac = new AbortController();
    const { p, pedidos } = proveedor((pedido) => r.corriente(['primero', 'segundo'], { colgar: true, senal: pedido.senal }));
    const g = p.transformar({ tarea: 'resumir', contenido: 'x', estilo: 'claro' }, ac.signal);
    expect((await g.next()).value).toBe('primero');
    ac.abort();
    await expect(g.next()).rejects.toMatchObject({ categoria: 'cancelado' });
    expect(pedidos[0]?.senal?.aborted).toBe(true);
  });

  it('si quien consume deja de pedir fragmentos (return), la corriente se aborta', async () => {
    const { p, pedidos } = proveedor((pedido) => r.corriente(['a', 'b'], { colgar: true, senal: pedido.senal }));
    const g = p.transformar({ tarea: 'resumir', contenido: 'x', estilo: 'claro' }, senal());
    await g.next();
    await g.return({ entrada: 0, salida: 0 });
    expect(pedidos[0]?.senal?.aborted).toBe(true);
  });

  it('una señal ya abortada: "cancelado" sin respuesta inventada', async () => {
    const ac = new AbortController();
    ac.abort();
    const { p } = proveedor(() => r.mensaje('no debería verse'));
    await expect(p.explicar({ contenido: 'x', lenguaje: '' }, ac.signal)).rejects.toMatchObject({ categoria: 'cancelado' });
  });
});

describe('Voyage: embeddings de exactamente 1024', () => {
  it('modelo, output_dimension 1024, input_type según el uso y la clave como Bearer', async () => {
    const { p, pedidos } = proveedor((pedido) => r.voyage((pedido.cuerpo.input as string[]).length));
    expect(p.modeloEmbeddings).toBe('voyage-3.5');
    expect(p.dimensiones).toBe(DIMENSIONES);
    const out = await p.embeber(['uno', 'dos'], senal(), 'documento');
    expect(out.vectores).toHaveLength(2);
    expect(out.vectores[0]).toHaveLength(1024);
    expect(out.uso).toEqual({ entrada: 10, salida: 0 });
    await p.embeber(['¿cómo migro?'], senal(), 'consulta');
    expect(pedidos.map((x) => x.url)).toEqual([URL_VOYAGE, URL_VOYAGE]);
    expect(pedidos[0]?.cuerpo).toEqual({ input: ['uno', 'dos'], model: 'voyage-3.5', input_type: 'document', output_dimension: 1024 });
    expect(pedidos[1]?.cuerpo.input_type).toBe('query');
    expect(pedidos[0]?.headers.authorization).toMatch(/^Bearer falsa-/);
  });

  it('respeta el índice de cada vector aunque lleguen desordenados', async () => {
    const { p } = proveedor(() => r.voyage(3, { orden: [2, 0, 1] }));
    const { vectores } = await p.embeber(['a', 'b', 'c'], senal());
    expect(vectores.map((v) => v.indexOf(1))).toEqual([0, 1, 2]);
  });

  it('lotes: de a lo sumo 128 textos y ~400 000 caracteres, en orden', async () => {
    expect(enLotes(Array.from({ length: 300 }, () => 'x')).map((l) => l.length)).toEqual([128, 128, 44]);
    expect(enLotes(['a'.repeat(300_000), 'b'.repeat(300_000), 'c']).map((l) => l.length)).toEqual([1, 2]);
    const { p, pedidos } = proveedor((pedido) => r.voyage((pedido.cuerpo.input as string[]).length));
    const textos = Array.from({ length: LOTE_MAX_TEXTOS + 1 }, (_, i) => `t${String(i)}`);
    const { vectores } = await p.embeber(textos, senal());
    expect(vectores).toHaveLength(129);
    expect(pedidos.map((x) => (x.cuerpo.input as string[]).length)).toEqual([128, 1]);
    expect((pedidos[1]?.cuerpo.input as string[])[0]).toBe('t128');
  });

  it('errores: 429 → limite con Retry-After; 5xx y red → no_disponible; 401 → interno', async () => {
    const casos: [Responder, Record<string, unknown>][] = [
      [() => r.json(429, {}, { 'retry-after': '4' }), { categoria: 'limite', reintentarEnS: 4 }],
      [() => r.json(503, {}), { categoria: 'no_disponible' }],
      [
        () => {
          throw new TypeError('fetch failed');
        },
        { categoria: 'no_disponible' },
      ],
      [() => r.json(401, {}), { categoria: 'interno' }],
    ];
    for (const [responder, esperado] of casos) {
      const { p } = proveedor(responder);
      await expect(p.embeber(['x'], senal())).rejects.toMatchObject(esperado);
    }
  });

  it('una respuesta con otra cantidad de vectores o mal formada → interno (nunca se guarda a medias)', async () => {
    for (const responder of [() => r.voyage(1), () => r.json(200, { data: [{ index: 0 }, { index: 0, embedding: [] }] })]) {
      const { p } = proveedor(responder);
      await expect(p.embeber(['a', 'b'], senal())).rejects.toMatchObject({ categoria: 'interno' });
    }
  });

  it('abortar: "cancelado"', async () => {
    const ac = new AbortController();
    const { p } = proveedor((pedido) => {
      ac.abort();
      if (pedido.senal?.aborted) throw new DOMException('abortado', 'AbortError');
      return r.voyage(1);
    });
    await expect(p.embeber(['x'], ac.signal)).rejects.toMatchObject({ categoria: 'cancelado' });
  });
});
