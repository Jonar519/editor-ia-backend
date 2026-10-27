// Carga de CPU de toda la máquina (todos los núcleos), para no medir con carga ajena. La usan la medición
// de P3 (medir.ts) y las pruebas de carga del bloque R (scripts/carga).
import { cpus } from 'node:os';

/** % de CPU ocupada en toda la máquina durante `ms` (todos los núcleos). */
export async function cargaCpu(ms: number): Promise<number> {
  const tomar = () => cpus().reduce((t, c) => ({ ocupado: t.ocupado + c.times.user + c.times.nice + c.times.sys + c.times.irq, total: t.total + c.times.user + c.times.nice + c.times.sys + c.times.irq + c.times.idle }), { ocupado: 0, total: 0 });
  const antes = tomar();
  await new Promise((r) => setTimeout(r, ms));
  const despues = tomar();
  const total = despues.total - antes.total;
  return total > 0 ? Math.round(((despues.ocupado - antes.ocupado) / total) * 1000) / 10 : 0;
}
