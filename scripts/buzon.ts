// Buzón simulado (solo desarrollo, solo proveedor mock): muestra los correos recibidos por una dirección.
// Hace de "bandeja de entrada" de la persona invitada en la demo. Nunca funciona en producción.
// Uso: tsx scripts/buzon.ts ana@example.com
import { cargarConfigOSalir } from '../src/config/entorno.js';
import { Correo } from '../src/http/esquemas.js';
import { crearPool, crearPrisma } from '../src/infra/bd.js';

const config = cargarConfigOSalir(process.env);
if (config.NODE_ENV === 'production' || config.EMAIL_PROVIDER !== 'mock') {
  console.error('El buzón simulado solo existe en desarrollo con EMAIL_PROVIDER=mock.');
  process.exit(1);
}
const para = Correo.safeParse(process.argv[2]);
if (!para.success) {
  console.error('Uso: buzon <correo>');
  process.exit(2);
}

const pool = crearPool(config.DATABASE_URL);
const prisma = crearPrisma(pool);
try {
  const correos = await prisma.correos_simulados.findMany({
    where: { para: para.data, expira_en: { gt: new Date() } },
    orderBy: { creado_en: 'desc' },
    take: 5,
  });
  if (correos.length === 0) console.log(`No hay correos para ${para.data}.`);
  for (const c of correos) {
    console.log(`\n=== ${c.creado_en.toISOString()} · ${c.asunto}\n${c.cuerpo_texto}`);
  }
} finally {
  await prisma.$disconnect();
  await pool.end();
}
