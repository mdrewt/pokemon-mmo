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
import { toast } from './ui/toast';
import { DebugHud } from './ui/hud';
import { ScreenManager } from './ui/screen';
import { BoxScreen } from './ui/box';
import { BattleScreen } from './ui/battle';
import { characterToPredictedBaseline, moveQueueToWasm, wasmToSdkMoveInput } from './convert';
import { installIntrospection } from './test/introspect';
import type { WasmFacing } from './wasm';

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

  // Step 3: connect + subscribe. Resolves once the initial subscription is applied. A rejected
  // reducer (e.g. "you have no bait", "can't evolve yet") surfaces as a toast instead of silently
  // doing nothing.
  const net: NetHandle = await connect((message) => toast(message));

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

  // Dev/test-only: expose a read-only state snapshot for the two-window Playwright e2e (M5).
  // Stripped from production builds (gated on import.meta.env.DEV).
  if (import.meta.env.DEV) {
    installIntrospection(net, () => predictor, step);
  }

  // Reconcile only when the authoritative own character row OR the ack actually changes (they
  // arrive in separate table callbacks, so reading both from the store after the batch keeps them
  // consistent — see the M4 reconcile-ordering fix). Between updates the predictor drains locally,
  // so the slide animation stays smooth.
  let lastReceivedAt = -1;
  let lastAcked = -1n;

  // The direction the client has committed the character to (the intent, tracked separately from
  // the queue so it survives the buffer draining). A change commits a responsive turn; a sustained
  // hold queues the next step at completion; a tap commits exactly one step.
  let committedDir: WasmFacing | null = null;

  // Screen-state machine + the menu overlays. A non-overworld screen stops the character (clears the
  // movement buffer) and gates movement input; returning to overworld restores control.
  const screen = new ScreenManager();
  const box = new BoxScreen(net);
  const battle = new BattleScreen(net);
  screen.onChange((s) => {
    box.hide();
    battle.hide();
    if (s === 'box') box.show();
    else if (s === 'battle') battle.show();
    if (s !== 'overworld') {
      if (predictor) net.clearQueue(predictor.clearQueue());
      committedDir = null;
    }
  });

  // The battle screen is server-driven: the screen follows the authoritative `battle` row appearing
  // (start_battle) or disappearing (close_battle / loss-then-dismiss).
  net.store.onBattleChange(() => {
    if (net.battle() !== undefined) screen.set('battle');
    else if (screen.current() === 'battle') screen.set('overworld');
  });

  // A small always-visible controls hint so the overworld actions are discoverable.
  const hint = document.createElement('div');
  hint.textContent = '[F] Fight   ·   [B] Box   ·   [H] Heal';
  hint.style.cssText =
    'position:fixed;left:12px;bottom:12px;padding:6px 10px;border-radius:6px;background:rgba(10,12,20,0.7);' +
    'color:#cfd6e6;font:12px system-ui,sans-serif;z-index:800;pointer-events:none;';
  document.body.appendChild(hint);
  screen.onChange((s) => {
    hint.style.display = s === 'overworld' ? 'block' : 'none';
  });

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
      // Consume one-shot latches once per frame, then route by the active screen.
      const toggleBox = input.takeToggleBox();
      const stopPressed = input.takeClear();
      const startBattlePressed = input.takeStartBattle();
      const healPressed = input.takeHeal();
      const jumpPressed = input.takeJump();
      const current = screen.current();

      if (current === 'battle') {
        // Driven by the battle screen's on-screen buttons; Escape flees (close_battle).
        if (stopPressed) net.closeBattle();
      } else if (current === 'box') {
        if (toggleBox || stopPressed) screen.set('overworld');
      } else {
        // Overworld.
        if (toggleBox) screen.set('box');
        if (healPressed) net.healParty();
        if (startBattlePressed && net.battle() === undefined) net.startBattle();
        const room = stored.row.moveQueue.length + predictor.pendingCount < cap;

        // Stop action (Escape, placeholder for menu/interact): clear the un-started buffer now.
        if (stopPressed) {
          const seq = predictor.clearQueue();
          net.clearQueue(seq);
          committedDir = null;
        }

        // Jump (one-shot): append behind the buffer if there's room.
        if (jumpPressed && room) {
          const seq = predictor.enqueue('Jump');
          net.enqueueMove(wasmToSdkMoveInput('Jump'), seq);
        }

        const dir = input.heldDir();
        if (dir === null) {
          // Released. Nothing is ever committed beyond the step currently animating (we only queue
          // the next step AT completion, below), so the character simply finishes the in-progress
          // tile and stops — no buffered move to cancel, so no clear and no snap-back race.
          committedDir = null;
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
          now - predictor.predicted.move_started_at >= step &&
          room
        ) {
          // Sustained hold: queue the NEXT step exactly when the current one completes — never ahead
          // of it. The drain just below applies it the same frame (back-dated, so the slide chains
          // with no gap), and because nothing is committed past the current tile, releasing stops
          // cleanly with no overshoot and no move for the server to race us on.
          const seq = predictor.enqueue({ Step: dir });
          net.enqueueMove(wasmToSdkMoveInput({ Step: dir }), seq);
        }
      }

      // Drain AFTER input so a step queued at completion (or a tap from idle) starts this same
      // frame — otherwise it would drain one frame late and the slide would visibly hitch.
      predictor.drain(now);
    }

    hud.update();
  });
}

bootstrap().catch((err) => {
  console.error('[bootstrap] fatal', err);
});
