// Job de retención diaria (BullMQ): queda agendado todos los días a las 03:15 UTC, su worker corre la
// purga de la base y la purga borra solo lo vencido. Redis db 1 con un prefijo propio de la corrida.
// Los eventos de seguridad de más de 180 días no se pueden fabricar como cuaderno_app (la tabla es de
// solo inserción): ese caso lo cubren las pruebas SQL del repo de base (0019_retencion.test.sql).
import { randomBytes } from 'node:crypto';
import { QueueEvents } from 'bullmq';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashToken, tokenAleatorio } from '../../src/auth/tokens.js';
import { ejecutarRetencion, iniciarRetencion, PATRON_RETENCION, type Retencion } from '../../src/trabajos/retencion.js';
import { cuentaActiva, entornoApi, type EntornoApi } from '../_api.js';
import { loggerEnMemoria, urlRedisPruebas } from '../_apoyo.js';

let e: EntornoApi;
let retencion: Retencion;
const prefijo = `prueba-bull:${randomBytes(6).toString('hex')}`;
const { log, lineas } = loggerEnMemoria();

beforeAll(async () => {
  e = await entornoApi();
  retencion = await iniciarRetencion({ redisUrl: urlRedisPruebas(), prefijo, prisma: e.prisma, log });
});
afterAll(async () => {
  await retencion.cola.obliterate({ force: true });
  await retencion.cerrar();
  await e.cerrar();
});

describe('retención diaria', () => {
  it('queda agendada todos los días a las 03:15 UTC (y agendar otra vez no duplica)', async () => {
    const agendas = await retencion.cola.getJobSchedulers();
    expect(agendas).toHaveLength(1);
    expect(agendas[0]).toMatchObject({ key: 'retencion-diaria', pattern: '15 3 * * *', tz: 'UTC' });
    expect(PATRON_RETENCION).toBe('15 3 * * *');
    // El próximo disparo es una 03:15 UTC.
    const proximo = new Date(agendas[0]?.next ?? 0);
    expect([proximo.getUTCHours(), proximo.getUTCMinutes()]).toEqual([3, 15]);

    const otra = await iniciarRetencion({ redisUrl: urlRedisPruebas(), prefijo, prisma: e.prisma, log });
    await otra.cerrar();
    expect(await retencion.cola.getJobSchedulersCount()).toBe(1);
  });

  it('el worker ejecuta la purga y devuelve lo borrado por tabla', async () => {
    const eventos = new QueueEvents('retencion', { connection: { url: urlRedisPruebas() }, prefix: prefijo });
    await eventos.waitUntilReady();
    try {
      const job = await retencion.cola.add('purgar', {});
      const resultado = (await job.waitUntilFinished(eventos, 10_000)) as Record<string, number>;
      expect(Object.keys(resultado).sort()).toEqual([
        'cambios_correo',
        'correos_simulados',
        'cuentas_pendientes',
        'eventos_seguridad',
        'sesiones',
        'tokens_recuperacion',
      ]);
      expect(lineas.some((l) => l.msg === 'retención diaria ejecutada')).toBe(true);
    } finally {
      await eventos.close();
    }
  });

  it('la purga borra lo vencido (sesiones terminadas hace 30+ días, tokens, correos simulados) y deja lo vigente', async () => {
    const c = await cuentaActiva(e.prisma);
    const vieja = await e.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO sesiones (usuario_id, expira_en) VALUES (${c.id}::uuid, now() + interval '1 day') RETURNING id`;
    const viva = await e.prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO sesiones (usuario_id, expira_en) VALUES (${c.id}::uuid, now() + interval '1 day') RETURNING id`;
    // Envejecer: la base solo deja acortar los plazos (moverlos hacia atrás).
    await e.prisma.$executeRaw`
      UPDATE sesiones SET creado_en = now() - interval '45 days', expira_en = now() - interval '35 days' WHERE id = ${vieja[0]?.id ?? ''}::uuid`;
    await e.prisma.$executeRaw`
      INSERT INTO tokens_recuperacion (usuario_id, token_hash, expira_en) VALUES (${c.id}::uuid, ${hashToken(tokenAleatorio())}, now() + interval '10 minutes')`;
    await e.prisma.$executeRaw`
      UPDATE tokens_recuperacion SET creado_en = now() - interval '3 days', expira_en = now() - interval '3 days' + interval '15 minutes' WHERE usuario_id = ${c.id}::uuid`;
    const marca = randomBytes(4).toString('hex');
    await e.prisma.$executeRaw`
      INSERT INTO correos_simulados (para, plantilla, asunto, cuerpo_texto, expira_en)
      VALUES (${c.correo}, 'invitacion', ${`viejo-${marca}`}, 'Cuerpo ficticio', now() + interval '1 day'),
             (${c.correo}, 'invitacion', ${`nuevo-${marca}`}, 'Cuerpo ficticio', now() + interval '1 day')`;
    await e.prisma.$executeRaw`
      UPDATE correos_simulados SET creado_en = now() - interval '8 days', expira_en = now() - interval '1 day' WHERE asunto = ${`viejo-${marca}`}`;

    const r = await ejecutarRetencion(e.prisma);
    expect(r.sesiones).toBeGreaterThanOrEqual(1);
    expect(r.tokens_recuperacion).toBeGreaterThanOrEqual(1);
    expect(r.correos_simulados).toBeGreaterThanOrEqual(1);
    expect(await e.prisma.sesiones.count({ where: { id: vieja[0]?.id ?? '' } })).toBe(0);
    expect(await e.prisma.sesiones.count({ where: { id: viva[0]?.id ?? '' } })).toBe(1);
    expect(await e.prisma.tokens_recuperacion.count({ where: { usuario_id: c.id } })).toBe(0);
    expect(await e.prisma.correos_simulados.count({ where: { asunto: { in: [`viejo-${marca}`, `nuevo-${marca}`] } } })).toBe(1);
  });

  it('la purga borra la cuenta pendiente cuya invitación venció hace más de 7 días, con su invitación', async () => {
    const correo = `pendiente.${randomBytes(5).toString('hex')}@example.com`;
    const u = await e.prisma.usuarios.create({ data: { correo, nombre: 'Persona Ficticia', rol: 'editor' }, select: { id: true } });
    await e.prisma.$executeRaw`
      INSERT INTO invitaciones (usuario_id, token_hash, expira_en) VALUES (${u.id}::uuid, ${hashToken(tokenAleatorio())}, now() + interval '72 hours')`;
    await e.prisma.$executeRaw`
      UPDATE invitaciones SET creado_en = now() - interval '11 days', expira_en = now() - interval '8 days' WHERE usuario_id = ${u.id}::uuid`;
    await e.prisma.$executeRaw`UPDATE usuarios SET creado_en = now() - interval '11 days' WHERE id = ${u.id}::uuid`;

    const r = await ejecutarRetencion(e.prisma);
    expect(r.cuentas_pendientes).toBeGreaterThanOrEqual(1);
    expect(await e.prisma.usuarios.count({ where: { id: u.id } })).toBe(0);
    expect(await e.prisma.invitaciones.count({ where: { usuario_id: u.id } })).toBe(0);
  });
});
