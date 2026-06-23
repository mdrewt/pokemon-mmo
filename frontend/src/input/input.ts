// Keyboard → movement intent. Arrow/WASD = Step(dir); Space = Jump. Grid movement: no
// diagonals; when perpendicular keys are held simultaneously, the most-recently-pressed wins.
// Window blur clears held keys.
//
// This module only tracks WHAT the player wants right now; it does not pace, predict, or network.
// `main.ts` polls `heldDir()` / `takeJump()` each frame and decides whether to enqueue (the move
// buffer's free space is the pacing — flow control lives in the prediction/net layer).

import type { WasmFacing } from '../wasm';

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

export class InputController {
  /** Directions currently held, in press order (most recent last). */
  #heldDirs: WasmFacing[] = [];
  /** Set on a Space press; consumed once by `takeJump()`. */
  #jumpLatched = false;
  #enabled = false;

  #onKeyDown = (e: KeyboardEvent): void => this.#handleKeyDown(e);
  #onKeyUp = (e: KeyboardEvent): void => this.#handleKeyUp(e);
  #onBlur = (): void => this.#clear();

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

  /** The currently-held step direction (most-recent-wins), or null if none is held. */
  heldDir(): WasmFacing | null {
    return this.#heldDirs.at(-1) ?? null;
  }

  /** Returns true once if Jump was pressed since the last call (consumes the latch). */
  takeJump(): boolean {
    const j = this.#jumpLatched;
    this.#jumpLatched = false;
    return j;
  }

  #handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return; // hold is handled by polling, not OS key-repeat
    if (e.code === 'Space') {
      e.preventDefault();
      this.#jumpLatched = true;
      return;
    }
    const dir = ARROW_TO_DIR[e.code];
    if (!dir) return;
    e.preventDefault();
    // Most-recent-wins: move this direction to the end of the held list.
    this.#heldDirs = this.#heldDirs.filter((d) => d !== dir);
    this.#heldDirs.push(dir);
  }

  #handleKeyUp(e: KeyboardEvent): void {
    const dir = ARROW_TO_DIR[e.code];
    if (!dir) return;
    this.#heldDirs = this.#heldDirs.filter((d) => d !== dir);
  }

  #clear(): void {
    this.#heldDirs = [];
    this.#jumpLatched = false;
  }
}
