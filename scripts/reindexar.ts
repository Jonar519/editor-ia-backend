// CLI de operador (bloque P2): encola el indexado automático de TODOS los documentos, por ejemplo después
// de cambiar el modelo de embeddings (vectores de modelos distintos no se comparan). Lo procesa el
// indexador del API (BullMQ), contra el presupuesto diario de cada espacio: si un espacio se queda sin
// presupuesto, sus documentos se posponen al día siguiente y queda en el log del API.
// Uso: tsx scripts/reindexar.ts   (con el API corriendo para que la cola avance)
import { Queue } from 'bullmq';
import { cargarConfigOSalir } from '../src/config/entorno.js';
import { COLA_INDICE, encolarAutomatico } from '../src/ia/indexado.js';
import { crearPool, crearPrisma } from '../src/infra/bd.js';

const config = cargarConfigOSalir(process.env);
const pool = crearPool(config.DATABASE_URL);
const prisma = crearPrisma(pool);
const cola = new Queue(COLA_INDICE, { connection: { url: config.REDIS_URL, maxRetriesPerRequest: null }, prefix: 'cuaderno:bull' });
try {
  const documentos = await prisma.$queryRaw<{ id: string }[]>`SELECT id FROM documentos ORDER BY creado_en`;
  for (const d of documentos) await encolarAutomatico(cola, d.id, null);
  console.log(`Encolados ${String(documentos.length)} documentos para reindexar (en nombre de su propietario).`);
} catch (e) {
  console.error(`ERROR: ${e instanceof Error ? e.message : String(e)}`);
  process.exitCode = 1;
} finally {
  await cola.close();
  await prisma.$disconnect();
  await pool.end();
}
