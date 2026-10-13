// Prisma se usa SOLO como cliente: el esquema vive en editor-ia-database (migraciones SQL numeradas).
// prisma/schema.prisma se obtiene con `prisma db pull` contra la base de pruebas y nunca se migra desde
// aquí. scripts/prisma.mjs pasa TEST_DATABASE_URL como DATABASE_URL a los comandos que la necesitan.
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  datasource: { url: process.env.DATABASE_URL ?? '' },
});
