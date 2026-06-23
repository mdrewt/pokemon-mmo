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
  /** Set on a stop/cancel press (Escape); consumed once by `takeClear()`. A placeholder for the
   *  real stop-movement actions (open menu, interact) until those exist. */
  #clearLatched = false;
  /** Set on a box-toggle press (B); consumed once by `takeToggleBox()`. */
  #toggleBoxLatched = false;
  /** Set on a start-battle press (F); consumed once by `takeStartBattle()`. M7 manual encounter
   *  trigger (proper encounter zones are M8). */
  #startBattleLatched = false;
  /** Set on a heal press (H); consumed once by `takeHeal()`. M7 on-demand heal (placeholder for a
   *  future healing spot). */
  #healLatched = false;
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

  /** Returns true once if a stop/cancel (Escape) was pressed since the last call. */
  takeClear(): boolean {
    const c = this.#clearLatched;
    this.#clearLatched = false;
    return c;
  }

  /** Returns true once if the box-toggle (B) was pressed since the last call. */
  takeToggleBox(): boolean {
    const b = this.#toggleBoxLatched;
    this.#toggleBoxLatched = false;
    return b;
  }

  /** Returns true once if start-battle (F) was pressed since the last call. */
  takeStartBattle(): boolean {
    const f = this.#startBattleLatched;
    this.#startBattleLatched = false;
    return f;
  }

  /** Returns true once if heal (H) was pressed since the last call. */
  takeHeal(): boolean {
    const h = this.#healLatched;
    this.#healLatched = false;
    return h;
  }

  #handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return; // hold is handled by polling, not OS key-repeat
    // Ignore game keys while typing in a text field (e.g. the box rename input).
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
      return;
    }
    if (e.code === 'Space') {
      e.preventDefault();
      this.#jumpLatched = true;
      return;
    }
    if (e.code === 'Escape') {
      this.#clearLatched = true;
      return;
    }
    if (e.code === 'KeyB') {
      this.#toggleBoxLatched = true;
      return;
    }
    if (e.code === 'KeyF') {
      this.#startBattleLatched = true;
      return;
    }
    if (e.code === 'KeyH') {
      this.#healLatched = true;
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
    this.#clearLatched = false;
    this.#toggleBoxLatched = false;
    this.#startBattleLatched = false;
    this.#healLatched = false;
  }
}
