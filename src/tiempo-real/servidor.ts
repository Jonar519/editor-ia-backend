// Servidor de colaboración en tiempo real (bloque K2, ADR 0002 y 0003). Vive en el MISMO proceso y puerto
// que el API: GET /api/tiempo-real con Upgrade: websocket.
//
// Entrar (antes de responder 101): Origin igual a APP_URL, subprotocolo "cuaderno.v1" + un ticket de un
// solo uso (GETDEL), sesión de login viva, cuenta activa y algún rol sobre el documento. Si algo falla, se
// responde 401, 403 o 503 SIN abrir el WebSocket.
//
// GUARDIA: cada mensaje que entra se verifica contra el rol de la conexión ANTES de aplicarlo o
// retransmitirlo. Una actualización exige editor o propietario; la de un lector se descarta (no se aplica,
// no se retransmite, no se guarda), se registra, y a la tercera en 60 s se cierra con 4403.
//
// El rol vive en memoria por conexión y se mantiene al día por tres vías (ADR 0002, decisión 1):
//   - los avisos de la base (cuaderno_permisos), reenviados por Redis: revalidación inmediata;
//   - la base rechaza una escritura de ese autor al guardar (42501): revalidación inmediata;
//   - la revalidación periódica (30 s), por si se perdió un aviso (riesgo residual R-01).
// Si la revalidación encuentra otro rol, la conexión queda CORTADA en el acto (no se aplica ni se
// retransmite nada más de ella) y se cierra con 4403; si la sesión terminó, 4401; si el documento ya no
// existe, 4404.
//
// UNA SOLA INSTANCIA (decisión escrita de K2): el documento abierto vive en la memoria de este proceso.
// Con dos instancias, dos personas en instancias distintas no se verían; reenviar los cambios por Redis
// queda para cuando se despliegue con más de una.
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import * as decoding from 'lib0/decoding';
import * as encoding from 'lib0/encoding';
import type { Logger } from 'pino';
import { applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from 'y-protocols/awareness';
import { readSyncStep1, writeSyncStep1 } from 'y-protocols/sync';
import * as Y from 'yjs';
import type { Redis } from 'ioredis';
import { WebSocket, WebSocketServer } from 'ws';
import { validarSesion } from '../auth/sesiones.js';
import { type RolContenido, rolEnDocumento } from '../contenido/acceso.js';
import type { PrismaClient } from '../generated/prisma/client.js';
import { DocumentoVivo } from './documento.js';
import { CIERRE, type LimitesTiempoReal } from './limites.js';
import { consumirTicket, PROTOCOLO, ticketDeProtocolos } from './tickets.js';

export const RUTA_TIEMPO_REAL = '/api/tiempo-real';

/** Tipos de mensaje (primer entero variable del marco). */
const MENSAJE = { sync: 0, presencia: 1, control: 2 } as const;
/** Subtipos de sync (y-protocols). */
const SYNC = { paso1: 0, paso2: 1, actualizacion: 2 } as const;

/** Un aviso de la base (cuaderno_permisos), con solo ids. */
export interface AvisoPermisos {
  tabla?: string;
  usuario_id?: string;
  sesion_id?: string;
  espacio_id?: string;
  documento_id?: string;
}

export interface DepsTiempoReal {
  prisma: PrismaClient;
  redis: Redis;
  prefijoRedis: string;
  appUrl: string;
  log: Logger;
  limites: LimitesTiempoReal;
  /** Pedir compactación del documento (BullMQ); null en pruebas que no la usan. */
  pedirCompactacion: ((documentoId: string, inmediata: boolean) => Promise<void>) | null;
}

interface Conexion {
  ws: WebSocket;
  usuarioId: string;
  sesionId: string;
  nombre: string;
  documentoId: string;
  espacioId: string;
  rol: RolContenido;
  /** Cortada: ya no se aplica ni se retransmite nada de ella (se está cerrando). */
  cortada: boolean;
  /** clientID de Yjs que pertenecen a esta conexión (presencia). */
  clientIds: Set<number>;
  descartadas: number[];
  ventana: { inicio: number; n: number };
  sesionEdicionId: string | null;
  esperandoPong: boolean;
  temporizadores: ReturnType<typeof setTimeout>[];
}

const puedeEscribir = (c: Conexion) => !c.cortada && (c.rol === 'editor' || c.rol === 'propietario');

/** Una actualización de Yjs sin cambios (sin estructuras ni borrados): la manda cualquier cliente al sincronizar. */
const esVacia = (u: Uint8Array) => u.length === 2 && u[0] === 0 && u[1] === 0;

function rechazar(socket: Duplex, estado: number, texto: string): void {
  socket.write(`HTTP/1.1 ${String(estado)} ${texto}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

export class ServidorTiempoReal {
  private readonly wss: WebSocketServer;
  private readonly documentos = new Map<string, Promise<DocumentoVivo>>();
  private readonly descargas = new Map<string, ReturnType<typeof setTimeout>>();
  readonly conexiones = new Set<Conexion>();
  private servidor: Server | null = null;
  private readonly alUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer) => void this.upgrade(req, socket, head);

  constructor(private readonly d: DepsTiempoReal) {
    this.wss = new WebSocketServer({ noServer: true, maxPayload: d.limites.mensajeBytes, handleProtocols: () => PROTOCOLO });
  }

  adjuntar(servidor: Server): void {
    this.servidor = servidor;
    servidor.on('upgrade', this.alUpgrade);
  }

  // ─── Entrar ─────────────────────────────────────────────────────────────────────

  private async upgrade(req: IncomingMessage, socket: Duplex, head: Buffer): Promise<void> {
    if (new URL(req.url ?? '/', 'http://x').pathname !== RUTA_TIEMPO_REAL) { rechazar(socket, 404, 'Not Found'); return; }
    // Contra el secuestro de WebSocket entre sitios: solo el origen del frontend.
    if (req.headers.origin !== this.d.appUrl) { rechazar(socket, 403, 'Forbidden'); return; }
    const ticket = ticketDeProtocolos(req.headers['sec-websocket-protocol']);
    if (!ticket) { rechazar(socket, 401, 'Unauthorized'); return; }
    let datos;
    try {
      datos = await consumirTicket(this.d.redis, this.d.prefijoRedis, ticket);
    } catch (err) {
      this.d.log.error({ err }, 'tiempo real: Redis no disponible (falla cerrado)');
      rechazar(socket, 503, 'Service Unavailable'); return;
    }
    if (!datos) { rechazar(socket, 401, 'Unauthorized'); return; }
    try {
      const u = await validarSesion(this.d.prisma, datos.usuarioId, datos.sesionId);
      if (!u) { rechazar(socket, 401, 'Unauthorized'); return; }
      const acceso = await rolEnDocumento(this.d.prisma, u.id, datos.documentoId);
      if (!acceso) { rechazar(socket, 403, 'Forbidden'); return; }
      const sesion = await this.d.prisma.$queryRaw<{ expira_en: Date }[]>`SELECT expira_en FROM sesiones WHERE id = ${datos.sesionId}::uuid`;
      const fila = await this.d.prisma.$queryRaw<{ id: string }[]>`
        INSERT INTO sesiones_edicion (documento_id, usuario_id, sesion_id, rol)
        VALUES (${datos.documentoId}::uuid, ${u.id}::uuid, ${datos.sesionId}::uuid, ${acceso.rol}) RETURNING id`;
      const doc = await this.documento(datos.documentoId);
      this.wss.handleUpgrade(req, socket, head, (ws) => {
        const c: Conexion = {
          ws,
          usuarioId: u.id,
          sesionId: datos.sesionId,
          nombre: u.nombre,
          documentoId: datos.documentoId,
          espacioId: acceso.espacioId,
          rol: acceso.rol,
          cortada: false,
          clientIds: new Set(),
          descartadas: [],
          ventana: { inicio: Date.now(), n: 0 },
          sesionEdicionId: fila[0]?.id ?? null,
          esperandoPong: false,
          temporizadores: [],
        };
        this.abrir(c, doc, sesion[0]?.expira_en ?? null);
      });
    } catch (err) {
      this.d.log.error({ err }, 'tiempo real: no se pudo abrir la conexión');
      rechazar(socket, 500, 'Internal Server Error');
    }
  }

  /** El documento en memoria (lo carga una sola vez aunque entren varias conexiones a la vez). */
  private documento(id: string): Promise<DocumentoVivo> {
    const descarga = this.descargas.get(id);
    if (descarga) {
      clearTimeout(descarga);
      this.descargas.delete(id);
    }
    let p = this.documentos.get(id);
    if (!p) {
      p = DocumentoVivo.cargar(id, {
        prisma: this.d.prisma,
        log: this.d.log,
        limites: this.d.limites,
        alRechazoDeEscritura: (doc, autor) => { this.revalidarDonde((c) => c.documentoId === doc && c.usuarioId === autor); },
        pedirCompactacion: (doc, inmediata) => {
          void this.d.pedirCompactacion?.(doc, inmediata).catch((err: unknown) => {
            this.d.log.warn({ err, documentoId: doc }, 'compactación: no se pudo encolar');
          });
        },
      }).then((doc) => {
        this.escucharDocumento(doc);
        return doc;
      });
      p.catch(() => this.documentos.delete(id));
      this.documentos.set(id, p);
    }
    return p;
  }

  private delDocumento(id: string): Conexion[] {
    return [...this.conexiones].filter((c) => c.documentoId === id);
  }

  /** Retransmisión: un cambio aplicado va a las DEMÁS conexiones del documento, y se guarda. */
  private escucharDocumento(doc: DocumentoVivo): void {
    doc.ydoc.on('update', (actualizacion: Uint8Array, origen: unknown) => {
      if (!this.conexiones.has(origen as Conexion)) return; // cargado de la base
      const autor = origen as Conexion;
      doc.guardar(autor.usuarioId, actualizacion);
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MENSAJE.sync);
      encoding.writeVarUint(e, SYNC.actualizacion);
      encoding.writeVarUint8Array(e, actualizacion);
      const marco = encoding.toUint8Array(e);
      for (const c of this.delDocumento(doc.id)) if (c !== autor && !c.cortada) this.enviar(c, marco);
    });
    doc.awareness.on('update', ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origen: unknown) => {
      const cambiados = [...added, ...updated, ...removed];
      const e = encoding.createEncoder();
      encoding.writeVarUint(e, MENSAJE.presencia);
      encoding.writeVarUint8Array(e, encodeAwarenessUpdate(doc.awareness, cambiados));
      const marco = encoding.toUint8Array(e);
      for (const c of this.delDocumento(doc.id)) if (c !== origen && !c.cortada) this.enviar(c, marco);
    });
  }

  private abrir(c: Conexion, doc: DocumentoVivo, expiraSesion: Date | null): void {
    this.conexiones.add(c);
    // Al entrar: su rol, el vector de estado del servidor (paso 1) y la presencia actual.
    this.enviar(c, this.control({ tipo: 'rol', rol: c.rol }));
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MENSAJE.sync);
    writeSyncStep1(e, doc.ydoc);
    this.enviar(c, encoding.toUint8Array(e));
    const estados = [...doc.awareness.getStates().keys()];
    if (estados.length > 0) {
      const p = encoding.createEncoder();
      encoding.writeVarUint(p, MENSAJE.presencia);
      encoding.writeVarUint8Array(p, encodeAwarenessUpdate(doc.awareness, estados));
      this.enviar(c, encoding.toUint8Array(p));
    }

    c.ws.on('message', (datos: Buffer, binario: boolean) => {
      this.mensaje(c, doc, datos, binario);
    });
    c.ws.on('pong', () => {
      c.esperandoPong = false;
    });
    c.ws.on('close', () => void this.cerrada(c, doc));

    const l = this.d.limites;
    c.temporizadores.push(setInterval(() => void this.revalidar(c), l.revalidarMs));
    c.temporizadores.push(
      setInterval(() => {
        c.esperandoPong = true;
        c.ws.ping();
        c.temporizadores.push(
          setTimeout(() => {
            if (c.esperandoPong) this.cortar(c, CIERRE.sinLatido, 'sin latido');
          }, l.pongMs),
        );
      }, l.pingMs),
    );
    // La sesión de login vence con la conexión abierta: se cierra a esa hora.
    if (expiraSesion) {
      const resta = Math.min(expiraSesion.getTime() - Date.now(), 2 ** 31 - 1);
      c.temporizadores.push(setTimeout(() => { this.cortar(c, CIERRE.sesionTerminada, 'la sesión venció'); }, Math.max(0, resta)));
    }
  }

  // ─── Mensajes: el guardia ───────────────────────────────────────────────────────

  private mensaje(c: Conexion, doc: DocumentoVivo, datos: Buffer, binario: boolean): void {
    if (c.cortada) return;
    if (!binario) { this.cortar(c, CIERRE.malFormado, 'mensaje de texto'); return; }
    const ahora = Date.now();
    if (ahora - c.ventana.inicio >= 1000) c.ventana = { inicio: ahora, n: 0 };
    if (++c.ventana.n > this.d.limites.mensajesPorSegundo) { this.cortar(c, CIERRE.demasiadosMensajes, 'demasiados mensajes'); return; }
    try {
      const dec = decoding.createDecoder(new Uint8Array(datos));
      const tipo = decoding.readVarUint(dec);
      if (tipo === MENSAJE.sync) {
        const sub = decoding.readVarUint(dec);
        if (sub === SYNC.paso1) {
          const e = encoding.createEncoder();
          encoding.writeVarUint(e, MENSAJE.sync);
          readSyncStep1(dec, e, doc.ydoc);
          this.enviar(c, encoding.toUint8Array(e));
        } else if (sub === SYNC.paso2 || sub === SYNC.actualizacion) {
          const actualizacion = decoding.readVarUint8Array(dec);
          if (esVacia(actualizacion)) return;
          if (!puedeEscribir(c)) { this.descartar(c); return; }
          if (!doc.cabe(actualizacion)) { this.cortar(c, CIERRE.documentoDemasiadoGrande, 'documento demasiado grande'); return; }
          Y.applyUpdate(doc.ydoc, actualizacion, c);
        } else {
          this.cortar(c, CIERRE.malFormado, 'subtipo de sync desconocido');
        }
      } else if (tipo === MENSAJE.presencia) {
        this.presencia(c, doc, decoding.readVarUint8Array(dec));
      } else if (tipo !== MENSAJE.control) {
        // Los mensajes de control del cliente (tramo 4: autocompletado) todavía no se usan.
        this.cortar(c, CIERRE.malFormado, 'tipo de mensaje desconocido');
      }
    } catch (err) {
      this.d.log.warn({ err, documentoId: c.documentoId, usuarioId: c.usuarioId }, 'tiempo real: mensaje mal formado');
      this.cortar(c, CIERRE.malFormado, 'mensaje mal formado');
    }
  }

  /** Actualización de quien no puede escribir: no se aplica ni se retransmite; a la tercera, 4403. */
  private descartar(c: Conexion): void {
    const ahora = Date.now();
    c.descartadas = c.descartadas.filter((t) => ahora - t < this.d.limites.descartadasVentanaMs);
    c.descartadas.push(ahora);
    this.d.log.warn({ documentoId: c.documentoId, usuarioId: c.usuarioId, sesionId: c.sesionId, rol: c.rol }, 'tiempo real: actualización descartada (sin permiso de escritura)');
    if (c.descartadas.length >= this.d.limites.descartadasMax) this.cortar(c, CIERRE.sinPermiso, 'escrituras sin permiso');
  }

  /**
   * Presencia: solo de los clientID de ESTA conexión (el primero que manda queda como suyo; uno que ya es
   * de otra conexión se descarta) y con el nombre de la cuenta autenticada, no el que diga el cliente.
   */
  private presencia(c: Conexion, doc: DocumentoVivo, actualizacion: Uint8Array): void {
    const dec = decoding.createDecoder(actualizacion);
    const n = decoding.readVarUint(dec);
    const ajenos = new Set(this.delDocumento(doc.id).filter((o) => o !== c).flatMap((o) => [...o.clientIds]));
    const aceptados: { id: number; reloj: number; estado: string }[] = [];
    for (let i = 0; i < n; i++) {
      const id = decoding.readVarUint(dec);
      const reloj = decoding.readVarUint(dec);
      const crudo = decoding.readVarString(dec);
      if (ajenos.has(id)) continue;
      c.clientIds.add(id);
      const estado = JSON.parse(crudo) as Record<string, unknown> | null;
      // "user" es lo que dibuja el editor (y-codemirror.next: name y color): el cliente pone el color, el
      // NOMBRE lo pone el servidor.
      const user = typeof estado?.user === 'object' && estado.user !== null ? estado.user : {};
      aceptados.push({
        id,
        reloj,
        estado: JSON.stringify(estado === null ? null : { ...estado, usuario: { id: c.usuarioId, nombre: c.nombre }, user: { ...user, name: c.nombre } }),
      });
    }
    if (aceptados.length === 0) return;
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, aceptados.length);
    for (const a of aceptados) {
      encoding.writeVarUint(e, a.id);
      encoding.writeVarUint(e, a.reloj);
      encoding.writeVarString(e, a.estado);
    }
    applyAwarenessUpdate(doc.awareness, encoding.toUint8Array(e), c);
  }

  // ─── Rol al día y cierres ───────────────────────────────────────────────────────

  /** Vuelve a leer sesión y rol en la base. Si cambió algo, la conexión queda cortada en el acto. */
  async revalidar(c: Conexion): Promise<void> {
    if (c.cortada) return;
    try {
      const u = await validarSesion(this.d.prisma, c.usuarioId, c.sesionId);
      if (!u) { this.cortar(c, CIERRE.sesionTerminada, 'la sesión terminó'); return; }
      const acceso = await rolEnDocumento(this.d.prisma, c.usuarioId, c.documentoId);
      if (!acceso) {
        const existe = await this.d.prisma.$queryRaw<{ n: number }[]>`SELECT count(*)::int AS n FROM documentos WHERE id = ${c.documentoId}::uuid`;
        this.cortar(c, (existe[0]?.n ?? 0) > 0 ? CIERRE.sinPermiso : CIERRE.documentoNoExiste, 'sin acceso'); return;
      }
      if (acceso.rol !== c.rol) this.cortar(c, CIERRE.sinPermiso, 'el permiso cambió');
    } catch (err) {
      this.d.log.error({ err, documentoId: c.documentoId }, 'tiempo real: no se pudo revalidar');
    }
  }

  private revalidarDonde(filtro: (c: Conexion) => boolean): void {
    for (const c of this.conexiones) if (filtro(c)) void this.revalidar(c);
  }

  /** Todas las conexiones (al reconectar el puente o Redis: pudo haberse perdido un aviso). */
  revalidarTodas(): void {
    this.revalidarDonde(() => true);
  }

  /** Un aviso de la base (reenviado por Redis): corta o revalida lo que corresponda. */
  aviso(a: AvisoPermisos): void {
    switch (a.tabla) {
      case 'sesiones':
        for (const c of this.conexiones) if (c.sesionId === a.sesion_id) this.cortar(c, CIERRE.sesionTerminada, 'sesión revocada');
        return;
      case 'documentos':
        for (const c of this.conexiones) if (c.documentoId === a.documento_id) this.cortar(c, CIERRE.documentoNoExiste, 'documento borrado');
        return;
      case 'usuarios':
        { this.revalidarDonde((c) => c.usuarioId === a.usuario_id); return; }
      case 'miembros_espacio':
        { this.revalidarDonde((c) => c.usuarioId === a.usuario_id && c.espacioId === a.espacio_id); return; }
      case 'permisos_documento':
        { this.revalidarDonde((c) => c.usuarioId === a.usuario_id && c.documentoId === a.documento_id); return; }
      default:
        { this.revalidarTodas(); return; }
    }
  }

  /** Corta la conexión YA (no se aplica ni retransmite nada más de ella) y la cierra con el código. */
  private cortar(c: Conexion, codigo: number, motivo: string): void {
    if (c.cortada) return;
    c.cortada = true;
    if (codigo === CIERRE.sinPermiso || codigo === CIERRE.documentoNoExiste) {
      // Perdió el permiso: lo que tenga en el búfer de ESE autor en ese documento no se guarda.
      void this.documentos.get(c.documentoId)?.then((d) => { d.descartarPendientes(c.usuarioId); });
    }
    this.d.log.info({ documentoId: c.documentoId, usuarioId: c.usuarioId, codigo, motivo }, 'tiempo real: conexión cortada');
    c.ws.close(codigo, motivo);
  }

  private async cerrada(c: Conexion, doc: DocumentoVivo): Promise<void> {
    c.cortada = true;
    for (const t of c.temporizadores) clearTimeout(t);
    this.conexiones.delete(c);
    if (c.clientIds.size > 0) removeAwarenessStates(doc.awareness, [...c.clientIds], 'cierre');
    if (c.sesionEdicionId) {
      await this.d.prisma.$executeRaw`DELETE FROM sesiones_edicion WHERE id = ${c.sesionEdicionId}::uuid`.catch((err: unknown) => {
        this.d.log.warn({ err }, 'tiempo real: no se pudo borrar la sesión de edición');
      });
    }
    if (this.delDocumento(doc.id).length === 0) this.programarDescarga(doc);
  }

  /**
   * Descarga de memoria un documento sin conexiones, pasado `descargarMs`. Si quedan cambios sin guardar
   * (la base falló), espera otra vuelta: en memoria es la única copia.
   */
  private programarDescarga(doc: DocumentoVivo): void {
    if (this.descargas.has(doc.id)) return;
    this.descargas.set(
      doc.id,
      setTimeout(() => {
        this.descargas.delete(doc.id);
        if (this.delDocumento(doc.id).length > 0) return;
        if (doc.tienePendientes()) {
          this.d.log.warn({ documentoId: doc.id }, 'tiempo real: cambios sin guardar; la descarga del documento espera');
          this.programarDescarga(doc);
          return;
        }
        this.documentos.delete(doc.id);
        void doc.cerrar();
      }, this.d.limites.descargarMs),
    );
  }

  private control(o: unknown): Uint8Array {
    const e = encoding.createEncoder();
    encoding.writeVarUint(e, MENSAJE.control);
    encoding.writeVarString(e, JSON.stringify(o));
    return encoding.toUint8Array(e);
  }

  /** Enviar sin acumular memoria por un cliente lento: con la cola llena, 1013. */
  private enviar(c: Conexion, marco: Uint8Array): void {
    if (c.ws.readyState !== WebSocket.OPEN) return;
    if (c.ws.bufferedAmount > this.d.limites.colaEnvioBytes) { this.cortar(c, CIERRE.sobrecarga, 'cliente lento'); return; }
    c.ws.send(marco);
  }

  /** Apagado ordenado: no acepta más, cierra con 1001 y guarda lo pendiente de cada documento. */
  async cerrar(): Promise<void> {
    this.servidor?.off('upgrade', this.alUpgrade);
    for (const c of this.conexiones) this.cortar(c, CIERRE.apagado, 'apagado');
    for (const t of this.descargas.values()) clearTimeout(t);
    this.descargas.clear();
    const docs = await Promise.allSettled([...this.documentos.values()]);
    for (const r of docs) if (r.status === 'fulfilled') await r.value.cerrar();
    this.documentos.clear();
    this.wss.close();
  }
}
