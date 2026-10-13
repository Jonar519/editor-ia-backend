import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/_entorno.ts'],
    // Las pruebas de integración comparten la base cuaderno_test y la db 1 de Redis.
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 30_000,
    env: { NODE_ENV: 'test' },
  },
});
