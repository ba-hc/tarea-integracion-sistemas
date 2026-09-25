import swc from 'unplugin-swc';
import { defineConfig } from 'vitest/config';

// SWC compila los decoradores legacy de Nest (experimentalDecorators), que el
// transformador por defecto de Vite no soporta.
export default defineConfig({
  plugins: [swc.vite({ module: { type: 'es6' } })],
  test: {
    include: ['test/unit/**/*.spec.ts'],
  },
});
