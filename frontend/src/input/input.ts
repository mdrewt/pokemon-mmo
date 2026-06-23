// Keyboard -> MoveInput intent. Arrow/WASD = Step(dir); Space = Jump. Grid movement: no
// diagonals; when perpendicular keys are held simultaneously, the most-recently-pressed
// wins. Window blur clears held keys.
//
// The next step is gated on the current step's animation completing (~step_ms) so honest
// clients never trip the server cooldown (ARCHITECTURE.md). A held key repeats once the
// gate opens.
//
// This module only decides intent and calls back; it does not predict or network. The
// callback is wired in main.ts to: apply via prediction (immediate) AND submit to the
// server.

import type { WasmFacing, WasmMoveInput } from '../wasm';

export type IntentHandler = (input: WasmMoveInput) => void;

const ARROW_TO_DIR: Record<string, WasmFacing> = {
  ArrowUp: 'North',
  ArrowDown: 'South',
  ArrowLeft: 'West',
  ArrowRight: 'East',
  KeyW: 'North',
  KeyS: 'South',
  KeyA: 'West',
  KeyD: 'East',
};

export interface InputControllerOptions {
  /** Step cadence gate (ms) — typically step_ms. */
  stepMs: number;
  /** Called with each emitted intent. */
  onIntent: IntentHandler;
  /** Monotonic clock; injectable for tests. Defaults to performance.now. */
  now?: () => number;
}

export class InputController {
  #stepMs: number;
  #onIntent: IntentHandler;
  #now: () => number;

  /** Directions currently held, in press order (most recent last). */
  #heldDirs: WasmFacing[] = [];
  #jumpHeld = false;
  /** Last time we emitted a Step intent (for the cadence gate). */
  #lastStepAt = -Infinity;
  #enabled = false;

  #onKeyDown = (e: KeyboardEvent): void => this.#handleKeyDown(e);
  #onKeyUp = (e: KeyboardEvent): void => this.#handleKeyUp(e);
  #onBlur = (): void => this.#clear();

  constructor(opts: InputControllerOptions) {
    this.#stepMs = opts.stepMs;
    this.#onIntent = opts.onIntent;
    this.#now = opts.now ?? (() => performance.now());
  }

  /** Begin listening for keyboard input. */
  enable(): void {
    if (this.#enabled) return;
    this.#enabled = true;
    window.addEventListener('keydown', this.#onKeyDown);
    window.addEventListener('keyup', this.#onKeyUp);
    window.addEventListener('blur', this.#onBlur);
  }

  disable(): void {
    if (!this.#enabled) return;
    this.#enabled = false;
    window.removeEventListener('keydown', this.#onKeyDown);
    window.removeEventListener('keyup', this.#onKeyUp);
    window.removeEventListener('blur', this.#onBlur);
    this.#clear();
  }

  /**
   * Called each frame (from the ticker) to emit a buffered/held Step once the cadence gate
   * has elapsed. Jump is emitted on keydown directly (it does not auto-repeat).
   */
  tick(): void {
    if (this.#heldDirs.length === 0) return;
    const now = this.#now();
    if (now - this.#lastStepAt < this.#stepMs) return;
    const dir = this.#heldDirs[this.#heldDirs.length - 1];
    if (dir === undefined) return;
    this.#lastStepAt = now;
    this.#onIntent({ Step: dir });
  }

  #handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return; // OS key-repeat ignored; we pace via tick()
    if (e.code === 'Space') {
      e.preventDefault();
      if (!this.#jumpHeld) {
        this.#jumpHeld = true;
        this.#onIntent('Jump');
      }
      return;
    }
    const dir = ARROW_TO_DIR[e.code];
    if (!dir) return;
    e.preventDefault();
    // Most-recent-wins: move to the end of the held list.
    this.#heldDirs = this.#heldDirs.filter((d) => d !== dir);
    this.#heldDirs.push(dir);
    // Emit immediately if the gate is already open (responsive first step).
    const now = this.#now();
    if (now - this.#lastStepAt >= this.#stepMs) {
      this.#lastStepAt = now;
      this.#onIntent({ Step: dir });
    }
  }

  #handleKeyUp(e: KeyboardEvent): void {
    if (e.code === 'Space') {
      this.#jumpHeld = false;
      return;
    }
    const dir = ARROW_TO_DIR[e.code];
    if (!dir) return;
    this.#heldDirs = this.#heldDirs.filter((d) => d !== dir);
  }

  #clear(): void {
    this.#heldDirs = [];
    this.#jumpHeld = false;
  }
}
