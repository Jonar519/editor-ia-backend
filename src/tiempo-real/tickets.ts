// Ticket de un solo uso para abrir el WebSocket (ADR 0002). El navegador no puede mandar Authorization en
// un WebSocket: pide un ticket con su access token y lo manda en Sec-WebSocket-Protocol (nunca en la URL).
//   - 32 bytes aleatorios; en Redis se guarda SOLO su SHA-256, con la cuenta, la sesión y el documento.
//   - Vence en 30 s.
//   - Se consume con GETDEL: atómico, así que dos conexiones simultáneas con el mismo ticket no pueden
//     usarlo las dos.
import { createHash, randomBytes } from 'node:crypto';
import type { Redis } from 'ioredis';

export interface DatosTicket {
  usuarioId: string;
  sesionId: string;
  documentoId: string;
}

const clave = (prefijo: string, ticket: string) => `${prefijo}ticket-rt:${createHash('sha256').update(ticket).digest('hex')}`;

/** Formato del ticket en el subprotocolo: "ticket.<43 caracteres base64url>". */
export const PREFIJO_PROTOCOLO_TICKET = 'ticket.';
export const PROTOCOLO = 'cuaderno.v1';

export async function emitirTicket(redis: Redis, prefijo: string, datos: DatosTicket, vigenciaMs: number): Promise<string> {
  const ticket = randomBytes(32).toString('base64url');
  await redis.set(clave(prefijo, ticket), JSON.stringify(datos), 'PX', vigenciaMs);
  return ticket;
}

/** Devuelve los datos y BORRA el ticket (un solo uso), o null si no existe o venció. */
export async function consumirTicket(redis: Redis, prefijo: string, ticket: string): Promise<DatosTicket | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(ticket)) return null;
  const valor = await redis.getdel(clave(prefijo, ticket));
  return valor ? (JSON.parse(valor) as DatosTicket) : null;
}

/** Lee los subprotocolos pedidos: tiene que venir "cuaderno.v1" y exactamente un ticket. */
export function ticketDeProtocolos(cabecera: string | undefined): string | null {
  const protocolos = (cabecera ?? '')
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
  const tickets = protocolos.filter((p) => p.startsWith(PREFIJO_PROTOCOLO_TICKET));
  if (!protocolos.includes(PROTOCOLO) || tickets.length !== 1) return null;
  return tickets[0]?.slice(PREFIJO_PROTOCOLO_TICKET.length) ?? null;
}
