import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    swc.vite({
      jsc: {
        parser: { syntax: 'typescript', decorators: true },
        transform: { legacyDecorator: true, decoratorMetadata: true },
      },
    }),
  ],
  test: {
    include: ['src/**/*.spec.ts', 'test/**/*.spec.ts'],
    exclude: ['test/integration/**'],
    testTimeout: 10_000,
    hookTimeout: 10_000,
    clearMocks: true,
  },
});