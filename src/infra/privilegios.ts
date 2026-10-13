// El backend debe conectarse con un usuario de privilegios mínimos (cuaderno_app), nunca con el dueño
// de las tablas: si lo hiciera, podría desactivar los triggers que protegen los datos. En producción el
// servidor se niega a arrancar si el usuario tiene privilegios de más; en desarrollo solo avisa.
import type pg from 'pg';

export interface PrivilegiosBd {
  usuario: string;
  superusuario: boolean;
  creaBases: boolean;
  creaRoles: boolean;
  saltaRls: boolean;
  tablasPropias: number;
  creaEnPublic: boolean;
}

export function problemasDePrivilegios(p: PrivilegiosBd): string[] {
  const problemas: string[] = [];
  if (p.superusuario) problemas.push(`${p.usuario} es superusuario`);
  if (p.creaBases) problemas.push(`${p.usuario} puede crear bases`);
  if (p.creaRoles) problemas.push(`${p.usuario} puede crear roles`);
  if (p.saltaRls) problemas.push(`${p.usuario} puede saltarse RLS`);
  if (p.tablasPropias > 0) problemas.push(`${p.usuario} es dueño de ${String(p.tablasPropias)} tablas (puede desactivar sus triggers)`);
  if (p.creaEnPublic) problemas.push(`${p.usuario} puede crear objetos en el esquema public`);
  return problemas;
}

/** Producción no arranca con privilegios de más; desarrollo y pruebas solo avisan. */
export function accionPorPrivilegios(entorno: 'development' | 'test' | 'production', problemas: string[]): 'continuar' | 'avisar' | 'abortar' {
  if (problemas.length === 0) return 'continuar';
  return entorno === 'production' ? 'abortar' : 'avisar';
}

export async function leerPrivilegios(pool: pg.Pool): Promise<PrivilegiosBd> {
  const { rows } = await pool.query<PrivilegiosBd>(`
    SELECT current_user AS usuario,
           r.rolsuper AS superusuario,
           r.rolcreatedb AS "creaBases",
           r.rolcreaterole AS "creaRoles",
           r.rolbypassrls AS "saltaRls",
           (SELECT count(*)::int FROM pg_tables WHERE schemaname = 'public' AND tableowner = current_user) AS "tablasPropias",
           has_schema_privilege(current_user, 'public', 'CREATE') AS "creaEnPublic"
    FROM pg_roles r WHERE r.rolname = current_user`);
  const fila = rows[0];
  if (!fila) throw new Error('No se pudo leer el rol actual de la base');
  return fila;
}
