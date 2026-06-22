import { Application } from 'pixi.js';

// Uncomment once client-wasm is built:
// import init from '../client-wasm/pkg/client_wasm';

async function bootstrap(): Promise<void> {
  // Step 1: Initialize WASM prediction module.
  // Must complete before any game-core predictions are called.
  // await init();

  // Step 2: Initialize PixiJS renderer.
  const app = new Application();
  await app.init({
    width: 800,
    height: 600,
    background: '#1a1a2e',
    antialias: true,
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });

  const container = document.getElementById('app');
  if (container == null) throw new Error('#app element not found');
  container.appendChild(app.canvas);

  // Step 3: Connect to SpacetimeDB and subscribe to tables.
  // const conn = await DbConnection.builder()
  //   .withUri('ws://localhost:3000')
  //   .withModuleName('monster-tamer-mmo')
  //   .build();

  // Step 4: Start game loop (gated on WASM init above).
  // app.ticker.add(gameLoop);
}

bootstrap().catch(console.error);
