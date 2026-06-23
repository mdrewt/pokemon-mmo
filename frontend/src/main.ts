// Bootstrap. Order matters (CLAUDE.md): await wasm init -> await app.init() -> connect to
// SpacetimeDB -> name entry -> joinGame -> start the app.ticker game loop (gated on wasm ready).
// The frontend only renders state, captures input -> intent -> reducer, and predicts/reconciles;
// all game rules live in game-core via the wasm. Movement is server-paced: the client buffers
// inputs, drains its prediction at STEP_MS, and only enqueues while the server buffer has room.

import { Application } from 'pixi.js';
import { initWasm, isWasmReady, pocMap, stepMs, applyMove, moveQueueCap } from './wasm';
import { connect, type NetHandle } from './net/connection';
import { Predictor } from './prediction/predictor';
import { Scene } from './render/scene';
import { InputController } from './input/input';
import { showNameEntry } from './ui/nameEntry';
import { DebugHud } from './ui/hud';
import { characterToPredictedBaseline, moveQueueToWasm, wasmToSdkMoveInput } from './convert';
import type { WasmFacing, WasmMoveInput } from './wasm';

async function bootstrap(): Promise<void> {
  // Step 1: prediction wasm. Must be ready before any drain or the loop runs.
  await initWasm();
  const step = stepMs();
  const cap = moveQueueCap();
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

  // The own character/player rows arrive asynchronously after join; build the predictor the
  // moment our character row exists.
  let predictor: Predictor | null = null;
  const tryInitPredictor = (): void => {
    if (predictor) return;
    const ownId = net.ownEntityId();
    if (ownId === undefined) return;
    const stored = net.store.characters.get(ownId);
    if (!stored) return;
    predictor = new Predictor(
      applyMove,
      step,
      characterToPredictedBaseline(stored.row, performance.now(), step),
    );
  };

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

  const input = new InputController();
  input.enable();

  const hud = new DebugHud({ net, predictor: () => predictor });

  // Reconcile only when the authoritative own character row OR the ack actually changes (they
  // arrive in separate table callbacks, so reading both from the store after the batch keeps them
  // consistent — see the M4 reconcile-ordering fix). Between updates the predictor drains locally,
  // so the slide animation stays smooth.
  let lastReceivedAt = -1;
  let lastAcked = -1n;

  // Tap-vs-hold tracking: a fresh press commits exactly one step (tap = one tile); only after a
  // direction has been held for a full step do we keep the buffer fed for smooth movement.
  let heldDirState: WasmFacing | null = null;
  let heldSince = 0;
  let firstStepDone = false;

  // Step 6: game loop, gated on wasm ready.
  app.ticker.add(() => {
    if (!isWasmReady()) return;
    tryInitPredictor();
    if (!predictor) {
      hud.update();
      return;
    }

    const now = performance.now();
    const ownId = net.ownEntityId();
    const stored = ownId === undefined ? undefined : net.store.characters.get(ownId);

    if (stored) {
      const acked = net.ackedSeq();
      if (stored.receivedAt !== lastReceivedAt || acked !== lastAcked) {
        predictor.reconcile(
          characterToPredictedBaseline(stored.row, now, step),
          moveQueueToWasm(stored.row.moveQueue),
          acked,
          now,
        );
        lastReceivedAt = stored.receivedAt;
        lastAcked = acked;
      }
      predictor.drain(now);

      // Track press changes (so a fresh press's first step is committed even from a full buffer).
      const dir = input.heldDir();
      if (dir !== heldDirState) {
        heldDirState = dir;
        heldSince = now;
        firstStepDone = false;
      }

      // Flow control: enqueue only while the server buffer has room (authoritative queue depth +
      // still-pending enqueues < cap) — so a held key can never overflow it (no QueueFull). A tap
      // emits one step; a sustained hold (held past one step) tops the buffer up for smoothness.
      if (stored.row.moveQueue.length + predictor.pendingCount < cap) {
        let intent: WasmMoveInput | null = null;
        if (input.takeJump()) {
          intent = 'Jump';
        } else if (dir) {
          if (!firstStepDone) {
            intent = { Step: dir };
            firstStepDone = true;
          } else if (now - heldSince >= step) {
            intent = { Step: dir };
          }
        }
        if (intent) {
          const seq = predictor.enqueue(intent);
          net.enqueueMove(wasmToSdkMoveInput(intent), seq);
        }
      }
    }

    hud.update();
  });
}

bootstrap().catch((err) => {
  console.error('[bootstrap] fatal', err);
});
