import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { crearPool, crearPrisma } from '../../src/infra/bd.js';
import { leerPrivilegios, problemasDePrivilegios } from '../../src/infra/privilegios.js';
import { urlBdPruebas } from '../_apoyo.js';

describe('base de pruebas como cuaderno_app', () => {
  let pool: pg.Pool;
  beforeAll(() => {
    pool = crearPool(urlBdPruebas());
  });
  afterAll(async () => {
    await pool.end();
  });

  it('la conexión de pruebas usa el rol de privilegios mínimos y no tiene problemas', async () => {
    const p = await leerPrivilegios(pool);
    expect(p.usuario).toBe('cuaderno_app');
    expect(problemasDePrivilegios(p)).toEqual([]);
  });

  it('el rol del backend no puede desactivar triggers (aunque el código lo intentara)', async () => {
    await expect(pool.query('ALTER TABLE versiones DISABLE TRIGGER versiones_solo_insercion')).rejects.toMatchObject({ code: '42501' });
  });

  it('Prisma funciona como cliente sobre el mismo pool', async () => {
    const prisma = crearPrisma(pool);
    try {
      const n = await prisma.schema_migrations.count();
      expect(n).toBeGreaterThanOrEqual(13);
      const filas = await prisma.$queryRaw<{ uno: number }[]>`SELECT 1::int AS uno`;
      expect(filas).toEqual([{ uno: 1 }]);
    } finally {
      await prisma.$disconnect();
    }
  });

  it('las consultas que tardan más de 5 s se cortan (statement_timeout)', async () => {
    await expect(pool.query('SELECT pg_sleep(6)')).rejects.toMatchObject({ code: '57014' });
  });
});
