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
import type { WasmFacing } from './wasm';

// While holding, queue the NEXT step only once the current step is this far through its slide.
// This keeps exactly one move of lookahead (smooth) while bounding how far the character drifts
// past where you release: smaller = more responsive (less overshoot), larger = smoother. Tunable.
const LOOKAHEAD_FRACTION = 0.5;

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

  // The direction the client has committed the character to (the intent, tracked separately from
  // the queue so it survives the buffer draining). A change commits a responsive turn; a sustained
  // hold queues one lookahead at a time; a tap commits exactly one step.
  let committedDir: WasmFacing | null = null;

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

      const room = stored.row.moveQueue.length + predictor.pendingCount < cap;

      // Stop action (Escape, placeholder for menu/interact): clear the un-started buffer now.
      if (input.takeClear()) {
        const seq = predictor.clearQueue();
        net.clearQueue(seq);
        committedDir = null;
      }

      // Jump (one-shot): append behind the buffer if there's room.
      if (input.takeJump() && room) {
        const seq = predictor.enqueue('Jump');
        net.enqueueMove(wasmToSdkMoveInput('Jump'), seq);
      }

      const dir = input.heldDir();
      if (dir === null) {
        committedDir = null; // released — the buffer drains and the character goes idle
      } else if (dir !== committedDir) {
        // Direction changed (or first step from idle): turn responsively by REPLACING the whole
        // un-drained buffer with the new direction (no overshoot beyond the step already animating).
        // Not flow-gated — set_move replaces rather than grows. Skip if it's already queued (no
        // redundant same-direction requests).
        committedDir = dir;
        if (predictor.lastQueuedDir() !== dir) {
          const seq = predictor.setMove({ Step: dir });
          net.setMove(wasmToSdkMoveInput({ Step: dir }), seq);
        }
      } else if (
        predictor.queueDepth === 0 &&
        now - predictor.predicted.move_started_at >= step * LOOKAHEAD_FRACTION &&
        room
      ) {
        // Sustained hold: queue exactly ONE lookahead step, and only once the current step is past
        // LOOKAHEAD_FRACTION of its slide — so movement stays smooth but releasing overshoots by at
        // most one tile (and usually zero, if you let go before the midpoint).
        const seq = predictor.enqueue({ Step: dir });
        net.enqueueMove(wasmToSdkMoveInput({ Step: dir }), seq);
      }
    }

    hud.update();
  });
}

bootstrap().catch((err) => {
  console.error('[bootstrap] fatal', err);
});
