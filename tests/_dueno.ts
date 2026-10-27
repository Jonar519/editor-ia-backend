// Conexión como DUEÑO de la base de PRUEBAS, solo para simular lo que el API no puede hacer (y el rol
// cuaderno_app tampoco): manipular una versión saltándose el trigger de solo inserción, como haría alguien
// con acceso directo a la base. Las mismas variables que scripts/bd-preparar.mjs: en CI vienen del
// workflow; en local, del .env del repo de base (sin cargarlas en process.env). Nunca la base de desarrollo.
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { parseEnv } from 'node:util';
import pg from 'pg';

function variables(): Record<string, string | undefined> {
  const repoBase = path.resolve(process.env.DATABASE_REPO_PATH ?? '../editor-ia-database');
  const archivo = path.join(repoBase, '.env');
  const delRepo = existsSync(archivo) ? parseEnv(readFileSync(archivo, 'utf8')) : {};
  // Como process.loadEnvFile: mandan las ya definidas (las del workflow en CI).
  return { ...delRepo, ...process.env };
}

/** Corre `f` en UNA transacción como dueño de la base de pruebas: lo que haga (también DDL) es atómico. */
export async function comoDuenoEnTransaccion(f: (c: pg.Client) => Promise<void>): Promise<void> {
  const v = variables();
  const base = v.CUADERNO_TEST_DB ?? 'cuaderno_test';
  if (!/^[a-z][a-z0-9_]*_test$/.test(base)) throw new Error(`"${base}" no es una base de pruebas (debe terminar en _test).`);
  if (!v.PGUSER || v.PGUSER === 'cuaderno_app') throw new Error('Falta PGUSER del dueño de la base (del .env del repo de base o del CI).');
  const c = new pg.Client({ host: v.PGHOST ?? '127.0.0.1', port: Number(v.PGPORT ?? 5435), user: v.PGUSER, password: v.PGPASSWORD, database: base });
  await c.connect();
  try {
    await c.query('BEGIN');
    await f(c);
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    await c.end();
  }
}
