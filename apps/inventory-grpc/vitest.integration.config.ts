import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

try {
  process.loadEnvFile();
} catch {
  // sin .env: TEST_DATABASE_URL debe venir del entorno (p. ej. en CI)
}

// Pruebas contra un PostgreSQL real y el servidor gRPC real. Corren en serie
// porque comparten la misma base de pruebas.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/integration/**/*.spec.ts'],
    globalSetup: ['test/integration/global-setup.ts'],
    fileParallelism: false,
    testTimeout: 20_000,
    hookTimeout: 60_000,
  },
});
