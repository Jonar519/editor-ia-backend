// CLI de operador: invita una cuenta sin necesitar un admin (alta del PRIMER admin, o emergencias).
// Igual que desde el API, el enlace NO se muestra aquí: viaja solo en el correo a la persona invitada.
// Uso: tsx scripts/invitar.ts --correo ana@example.com --nombre "Ana Ficticia" --rol admin
import { parseArgs } from 'node:util';
import { cargarConfigOSalir } from '../src/config/entorno.js';
import { crearProveedorCorreo } from '../src/correo/proveedor.js';
import { InvitacionSolicitud } from '../src/http/esquemas.js';
import { crearPool, crearPrisma } from '../src/infra/bd.js';
import { invitar } from '../src/invitaciones/servicio.js';

const { values } = parseArgs({
  options: { correo: { type: 'string' }, nombre: { type: 'string' }, rol: { type: 'string' } },
});
const datos = InvitacionSolicitud.safeParse(values);
if (!datos.success) {
  console.error('Uso: invitar --correo <correo> --nombre "<nombre>" --rol admin|editor|lector');
  for (const i of datos.error.issues) console.error(`  - ${i.path.join('.')}: ${i.message}`);
  process.exit(2);
}

const config = cargarConfigOSalir(process.env);
const pool = crearPool(config.DATABASE_URL);
const prisma = crearPrisma(pool);
try {
  const r = await invitar(
    { prisma, correo: crearProveedorCorreo(config, prisma), appUrl: config.APP_URL },
    { invitadaPor: null, ...datos.data },
  );
  console.log(`Invitación creada para ${r.usuario.correo} (${r.usuario.rol}). Vence: ${r.expiraEn.toISOString()}.`);
  console.log(r.correoEnviado ? 'El enlace se envió a su correo. Aquí no se muestra.' : 'AVISO: el correo no se pudo enviar; reenvía la invitación.');
  if (config.EMAIL_PROVIDER === 'mock') console.log(`(Proveedor mock: la persona invitada lo ve con scripts\\buzon.bat ${r.usuario.correo})`);
} catch (e) {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
  await pool.end();
}
