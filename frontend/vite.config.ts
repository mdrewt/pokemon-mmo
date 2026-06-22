import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    // Required for top-level await in WASM modules (client-wasm/pkg uses it)
    target: 'esnext',
  },
});
