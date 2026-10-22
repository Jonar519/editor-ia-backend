// Rutas HTTP de la IA (bloque P1; la interfaz llega en Q). El API es el gateway: verifica sesión, permiso
// y tope ANTES de llamar al servicio por gRPC, y traduce sus errores (src/ia/errores.ts).
//
//   POST /api/ia/explicar                 JSON. Cualquier rol con acceso al documento.
//   POST /api/ia/resumir                  SSE (fetch POST). Cualquier rol con acceso.
//   POST /api/ia/mejorar                  SSE. Editor o propietario (es para reemplazar texto).
//   POST /api/espacios/:id/buscar         JSON. Miembro del espacio; solo fragmentos con acceso HOY.
//   POST /api/documentos/:id/indice       202. Editor o propietario: encola el indexado (BullMQ).
//
// SSE (ADR 0002): los errores ANTES del primer byte son códigos HTTP normales; a mitad, `event: error` y fin.
// Si la persona aborta el fetch, la llamada gRPC se cancela y el servicio deja de generar; se cobra lo
// estimado hasta ahí.
import { Router, type Request, type Response } from 'express';
import { crearLimitador, limitarTasa } from '../auth/limites.js';
import { requiereSesion, usuarioDe } from '../auth/middleware.js';
import { exigirDocumento, exigirEspacio } from '../contenido/acceso.js';
import type { DependenciasApi } from '../dependencias.js';
import { ErrorHttp } from '../http/errores.js';
import { BusquedaSolicitud, ExplicarSolicitud, IdDocumento, IdEspacio, TransformarSolicitudHttp } from '../http/esquemas.js';
import type { ClienteIa, OrigenIa } from './cliente.js';
import { DIMENSIONES } from './contrato.js';
import { errorHttpDeIa } from './errores.js';
import { tokensAprox, type Uso } from './proveedor.js';
import { registrarUso, reservarUso, segundosHastaManana, TOPES_IA } from './uso.js';

export const LIMITES_IA = {
  /** Pedidos por minuto y cuenta (además del tope diario). */
  minuto: { max: 30, ventanaMs: 60_000 },
  /** Latido SSE: un comentario cada 15 s para que ningún proxy corte la corriente por inactividad. */
  latidoMs: 15_000,
} as const;

const noDisponible = () => new ErrorHttp(503, 'ia_no_disponible', 'La IA no está disponible en este momento');

/** Una AbortSignal que se dispara si la persona se va antes de que terminemos de responder. */
function alIrse(res: Response): AbortSignal {
  const ac = new AbortController();
  res.on('close', () => {
    if (!res.writableFinished) ac.abort();
  });
  return ac.signal;
}

const usoHttp = (u: Uso) => ({ tokensEntrada: u.entrada, tokensSalida: u.salida });

export function rutasIa(d: DependenciasApi): { ia: Router; busqueda: Router; indice: Router } {
  const topes = d.topesIa ?? TOPES_IA;
  const sesion = requiereSesion(d);
  const lim = limitarTasa(
    crearLimitador({ redis: d.redis, prefijo: d.prefijoRedis, nombre: 'ia', ...LIMITES_IA.minuto }),
    (_req, res) => `cuenta:${usuarioDe(res).id}`,
  );
  const cliente = (): ClienteIa => {
    if (!d.ia) throw noDisponible();
    return d.ia;
  };

  async function reservar(res: Response, usuarioId: string): Promise<void> {
    try {
      await reservarUso(d.prisma, usuarioId, topes);
    } catch (e) {
      if (e instanceof ErrorHttp && e.codigo === 'tope_diario_ia') res.setHeader('Retry-After', String(segundosHastaManana()));
      throw e;
    }
  }

  /** Un error de la IA: lanza el ErrorHttp, o no responde nada si la persona canceló. */
  function fallo(e: unknown, req: Request, res: Response): void {
    const traducido = errorHttpDeIa(e, res);
    if (traducido === null) {
      req.log.info({ solicitud: req.id }, 'ia: la persona canceló');
      return;
    }
    throw traducido instanceof Error ? traducido : new Error('error desconocido de la IA');
  }

  const origen = (req: Request, res: Response, espacioId: string, documentoId?: string): OrigenIa => ({
    cuentaId: usuarioDe(res).id,
    espacioId,
    ...(documentoId ? { documentoId } : {}),
    solicitudId: typeof req.id === 'string' ? req.id : '',
  });

  // ─── /api/ia ──────────────────────────────────────────────────────────────────
  const ia = Router();
  ia.use(sesion);

  ia.post('/explicar', lim, async (req, res) => {
    const b = ExplicarSolicitud.parse(req.body);
    const u = usuarioDe(res);
    const { espacioId } = await exigirDocumento(d.prisma, u.id, b.documentoId, 'lector', '');
    const c = cliente();
    await reservar(res, u.id);
    try {
      const r = await c.explicar(origen(req, res, espacioId, b.documentoId), b.contenido, b.lenguaje, alIrse(res));
      await registrarUso(d.prisma, u.id, r.uso);
      res.json({ texto: r.texto, uso: usoHttp(r.uso) });
    } catch (e) {
      fallo(e, req, res);
    }
  });

  const transformar = (tarea: 'resumir' | 'mejorar') => async (req: Request, res: Response) => {
    const b = TransformarSolicitudHttp.parse(req.body);
    const u = usuarioDe(res);
    const { espacioId } = await exigirDocumento(
      d.prisma,
      u.id,
      b.documentoId,
      tarea === 'mejorar' ? 'editor' : 'lector',
      'Solo un editor o propietario puede mejorar el texto',
    );
    const c = cliente();
    await reservar(res, u.id);
    const senal = alIrse(res);
    const corriente = c.transformar(tarea, origen(req, res, espacioId, b.documentoId), b.contenido, b.estilo, senal);
    let generado = '';
    // Hasta el primer fragmento, un error es un código HTTP normal.
    let paso: IteratorResult<string, Uso>;
    try {
      paso = await corriente.next();
    } catch (e) {
      fallo(e, req, res);
      return;
    }
    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    res.setHeader('Cache-Control', 'no-cache, no-store');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const evento = (nombre: string, datos: unknown) => res.write(`event: ${nombre}\ndata: ${JSON.stringify(datos)}\n\n`);
    const latido = setInterval(() => res.write(': latido\n\n'), LIMITES_IA.latidoMs);
    try {
      while (!paso.done) {
        generado += paso.value;
        evento('fragmento', { texto: paso.value });
        paso = await corriente.next();
      }
      await registrarUso(d.prisma, u.id, paso.value);
      evento('fin', usoHttp(paso.value));
    } catch (e) {
      // Se cobra lo estimado hasta el corte (la persona canceló o la IA falló a mitad).
      await registrarUso(d.prisma, u.id, { entrada: tokensAprox(b.contenido), salida: tokensAprox(generado) }).catch((err: unknown) => {
        req.log.warn({ err }, 'ia: no se pudo registrar el uso');
      });
      const traducido = errorHttpDeIa(e, res);
      if (traducido instanceof ErrorHttp) evento('error', { codigo: traducido.codigo, mensaje: traducido.message });
      else if (traducido === null) req.log.info({ solicitud: req.id }, 'ia: la persona canceló');
      else {
        req.log.error({ err: traducido }, 'ia: error a mitad de la corriente');
        evento('error', { codigo: 'interno', mensaje: 'Error interno' });
      }
    } finally {
      clearInterval(latido);
      res.end();
    }
  };

  ia.post('/resumir', lim, transformar('resumir'));
  ia.post('/mejorar', lim, transformar('mejorar'));

  // ─── /api/espacios/:espacioId/buscar ─────────────────────────────────────────
  const busqueda = Router();
  busqueda.post('/:espacioId/buscar', sesion, lim, async (req, res) => {
    const { espacioId } = IdEspacio.parse(req.params);
    const b = BusquedaSolicitud.parse(req.body);
    const u = usuarioDe(res);
    await exigirEspacio(d.prisma, u.id, espacioId, 'lector', '');
    const c = cliente();
    await reservar(res, u.id);
    let vector: number[];
    try {
      const r = await c.embeberConsulta(origen(req, res, espacioId), b.consulta, alIrse(res));
      await registrarUso(d.prisma, u.id, r.uso);
      vector = r.vector;
    } catch (e) {
      fallo(e, req, res);
      return;
    }
    if (vector.length !== DIMENSIONES) throw new ErrorHttp(502, 'ia_error_interno', 'El servicio de IA falló');
    // buscar_fragmentos (migración 0011) filtra por espacio Y por el acceso de HOY de quien busca.
    const filas = await d.prisma.$queryRaw<{ documento_id: string; titulo: string; fragmento: number; texto: string; distancia: number }[]>`
      SELECT f.documento_id, d.titulo, f.fragmento, f.texto, f.distancia
      FROM buscar_fragmentos(${u.id}::uuid, ${espacioId}::uuid, ${`[${vector.join(',')}]`}::vector, ${b.limite}::int) f
      JOIN documentos d ON d.id = f.documento_id
      ORDER BY f.distancia`;
    res.json({
      resultados: filas.map((f) => ({ documentoId: f.documento_id, titulo: f.titulo, fragmento: f.fragmento, texto: f.texto, similitud: 1 - f.distancia })),
    });
  });

  // ─── /api/documentos/:documentoId/indice ─────────────────────────────────────
  const indice = Router();
  indice.post('/:documentoId/indice', sesion, lim, async (req, res) => {
    const { documentoId } = IdDocumento.parse(req.params);
    const u = usuarioDe(res);
    await exigirDocumento(d.prisma, u.id, documentoId, 'editor', 'Solo un editor o propietario puede indexar el documento');
    if (!d.indexador) throw noDisponible();
    await d.indexador.pedir(documentoId, u.id);
    res.status(202).json({ encolado: true });
  });

  return { ia, busqueda, indice };
}
