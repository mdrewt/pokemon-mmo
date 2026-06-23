// Bootstrap. Order matters (CLAUDE.md): await wasm init -> await app.init() -> connect to
// SpacetimeDB -> show name entry -> joinGame -> start the app.ticker game loop (gated on
// wasm ready). The frontend only renders state, captures input -> intent -> reducer, and
// reconciles; all game rules live in game-core via the wasm.

import { Application } from 'pixi.js';
import { initWasm, isWasmReady, pocMap, stepMs, predictInput } from './wasm';
import { connect, type NetHandle } from './net/connection';
import { Predictor } from './prediction/predictor';
import { Scene } from './render/scene';
import { InputController } from './input/input';
import { showNameEntry } from './ui/nameEntry';
import { DebugHud } from './ui/hud';
import { characterToPredictedBaseline, wasmToSdkMoveInput } from './convert';
import type { WasmMoveInput } from './wasm';

async function bootstrap(): Promise<void> {
  // Step 1: prediction wasm. Must be ready before any predict call or the loop runs.
  await initWasm();
  const step = stepMs();
  const map = pocMap();

  // Step 2: renderer.
  const app = new Application();
  await app.init({
    width: 1024,
    height: 768,
    background: '#0c0e14',
    antialias: false, // pixel art: no AA on sprites
    autoDensity: true,
    resolution: window.devicePixelRatio || 1,
  });
  const container = document.getElementById('app');
  if (container == null) throw new Error('#app element not found');
  container.appendChild(app.canvas);

  // Step 3: connect + subscribe. Resolves once the initial subscription is applied.
  const net: NetHandle = await connect();

  // Step 4: name entry -> join.
  const name = await showNameEntry();
  net.joinGame(name);

  // The own character/player rows arrive asynchronously after join; build the predictor
  // the moment our character row exists.
  let predictor: Predictor | null = null;

  const tryInitPredictor = (): void => {
    if (predictor) return;
    const ownId = net.ownEntityId();
    if (ownId === undefined) return;
    const stored = net.store.characters.get(ownId);
    if (!stored) return;
    predictor = new Predictor(
      predictInput,
      characterToPredictedBaseline(stored.row, performance.now(), step),
    );
  };

  // Reconciliation runs once per frame in the game loop (below), NOT in a table callback: the
  // authoritative tile (character row) and the ack (player.lastInputSeq) update in SEPARATE
  // callbacks whose order isn't guaranteed, so reconciling inside one would read a stale ack and
  // replay an already-acked input (predicting a tile too far). Reading both after the whole
  // subscription batch has applied keeps them consistent.

  // Step 5: scene (loads spritesheet -> AnimatedSprite path).
  const scene = await Scene.create(
    app,
    {
      store: net.store,
      ownEntityId: () => net.ownEntityId(),
      predictor: () => predictor,
      stepMs: step,
    },
    map,
  );
  void scene;

  // Input -> intent: apply via prediction (immediate) AND submit to the server.
  const input = new InputController({
    stepMs: step,
    onIntent: (intent: WasmMoveInput) => {
      tryInitPredictor();
      if (!predictor) return;
      const at = performance.now();
      const seq = predictor.applyInput(intent, at);
      if (seq === null) return; // rejected locally (cooldown) — do not submit
      net.submitInput(wasmToSdkMoveInput(intent), seq);
    },
  });
  input.enable();

  // Debug HUD (toggle with backtick).
  const hud = new DebugHud({ net, predictor: () => predictor });

  // Step 6: game loop, gated on wasm ready.
  app.ticker.add(() => {
    if (!isWasmReady()) return;
    tryInitPredictor();
    // Reconcile against the authoritative own character + ack, read together after the batch.
    if (predictor) {
      const ownId = net.ownEntityId();
      const stored = ownId === undefined ? undefined : net.store.characters.get(ownId);
      if (stored) {
        predictor.reconcile(
          characterToPredictedBaseline(stored.row, performance.now(), step),
          net.ackedSeq(),
        );
      }
    }
    input.tick();
    hud.update();
  });
}

bootstrap().catch((err) => {
  console.error('[bootstrap] fatal', err);
});
