import { defineConfig } from 'vite';
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
});
