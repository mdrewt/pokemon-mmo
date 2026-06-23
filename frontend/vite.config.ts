import { defineConfig } from 'vitest/config';
import wasm from 'vite-plugin-wasm';
import topLevelAwait from 'vite-plugin-top-level-await';

export default defineConfig({
  // The client-wasm crate is built with wasm-pack `--target bundler`, whose generated JS
  // uses the "ESM integration for WASM" import form. Vite/Rollup don't support that import
  // natively, so vite-plugin-wasm handles it (and top-level-await covers the generated
  // glue). esnext target is required for the top-level await these plugins emit.
  plugins: [wasm(), topLevelAwait()],
  build: {
    target: 'esnext',
  },
  // Vitest runs the pure unit tests under src/ only. The Playwright e2e (e2e/*.spec.ts) uses its
  // own runner — without this, vitest's default *.spec.ts glob would try to load it and fail
  // ("Playwright Test did not expect test.describe() to be called here").
  test: {
    include: ['src/**/*.{test,spec}.ts'],
  },
});
