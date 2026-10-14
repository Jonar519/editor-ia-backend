// Regresión: los plazos (invitación 72 h, correo simulado 7 días, sesión 7 días) los calcula la BASE.
// Antes salían del reloj de Node, y la base compara contra su propio now(): con el reloj del servidor de
// aplicación unos milisegundos adelantado, los CHECK de vigencia fallaban a veces (prueba intermitente
// durante las mutaciones del bloque E). Aquí se adelanta el reloj de Node un minuto a propósito.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { crearSesion } from '../../src/auth/sesiones.js';
import { correoInvitacion } from '../../src/correo/plantillas.js';
import { correoMock } from '../../src/correo/proveedor.js';
import { invitar } from '../../src/invitaciones/servicio.js';
import { correoUnico, cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';

let e: EntornoApi;
beforeAll(async () => {
  e = await entornoApi();
});
afterAll(async () => {
  await e.cerrar();
});
afterEach(() => {
  vi.useRealTimers();
});

/** Solo Date: los temporizadores (y por tanto la red y la base) siguen normales. */
function adelantarRelojDeNode(ms: number) {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + ms);
}

describe('plazos calculados por la base aunque el reloj de la aplicación vaya adelantado', () => {
  it('invitar (72 h)', async () => {
    adelantarRelojDeNode(60_000);
    const i = await invitar(e.deps, { invitadaPor: null, nombre: 'Reloj Adelantado', correo: correoUnico('reloj'), rol: 'lector' });
    expect(i.usuario.estado).toBe('pendiente');
  });

  it('correo simulado (7 días)', async () => {
    adelantarRelojDeNode(60_000);
    const para = correoUnico('reloj');
    await correoMock(e.prisma).enviar(correoInvitacion({ para, nombre: 'X', rol: 'lector', appUrl: 'http://127.0.0.1:5175', token: 'T'.repeat(43), expiraEn: new Date() }));
    expect(await e.prisma.correos_simulados.count({ where: { para } })).toBe(1);
  });

  it('sesión (7 días)', async () => {
    const c = await cuentaActiva(e.prisma);
    adelantarRelojDeNode(60_000);
    const s = await e.prisma.$transaction((tx) => crearSesion(tx, { usuarioId: c.id, ipRed: null, userAgent: null }));
    expect(s.sesionId).toMatch(/^[0-9a-f-]{36}$/);
  });
});
