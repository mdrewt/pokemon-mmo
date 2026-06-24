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
  /** Set on a stop/cancel press (Escape); consumed once by `takeClear()`. In an overlay it closes the
   *  screen (or flees a battle); in the overworld it stops/cancels the un-started move buffer. */
  #clearLatched = false;
  /** Set on a box-toggle press (B); consumed once by `takeToggleBox()`. */
  #toggleBoxLatched = false;
  /** Set on a start-battle press (F); consumed once by `takeStartBattle()`. Manually seeks a wild
   *  encounter (grass tiles also trigger encounters automatically while walking). */
  #startBattleLatched = false;
  /** Set on a heal press (H); consumed once by `takeHeal()`. On-demand full heal (placeholder for a
   *  future healing spot). */
  #healLatched = false;
  /** Set on a trade-toggle press (T); consumed once by `takeToggleTrade()`. M11.1 trading. */
  #toggleTradeLatched = false;
  /** Set on a challenge-toggle press (C); consumed once by `takeToggleChallenge()`. M11.2 PvP. */
  #toggleChallengeLatched = false;
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

  /** Returns true once if the trade-toggle (T) was pressed since the last call. */
  takeToggleTrade(): boolean {
    const t = this.#toggleTradeLatched;
    this.#toggleTradeLatched = false;
    return t;
  }

  /** Returns true once if the challenge-toggle (C) was pressed since the last call. */
  takeToggleChallenge(): boolean {
    const c = this.#toggleChallengeLatched;
    this.#toggleChallengeLatched = false;
    return c;
  }

  #handleKeyDown(e: KeyboardEvent): void {
    if (e.repeat) return; // hold is handled by polling, not OS key-repeat
    // Ignore game keys while a form control has focus (the box rename input, the trade dropdowns) so
    // typing/selecting in them doesn't also toggle a screen.
    const target = e.target as HTMLElement | null;
    if (
      target &&
      (target.tagName === 'INPUT' ||
        target.tagName === 'TEXTAREA' ||
        target.tagName === 'SELECT' ||
        target.isContentEditable)
    ) {
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
    if (e.code === 'KeyT') {
      this.#toggleTradeLatched = true;
      return;
    }
    if (e.code === 'KeyC') {
      this.#toggleChallengeLatched = true;
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
    this.#toggleTradeLatched = false;
    this.#toggleChallengeLatched = false;
  }
}
