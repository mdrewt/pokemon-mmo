// Minimal app screen-state machine: routes which screen is active so input and UI don't tangle. A plain
// enum + listeners, no FSM library (KISS). `main.ts` reacts to `onChange` to show/hide the overlays and
// gate movement; the full-screen overlays (box/battle/trade/challenge) are each a DOM layer that reads
// authoritative state and are EXITED in the game loop before the movement-prediction gate, so they can
// always be closed (see `main.ts`). Movement input is only processed in `overworld`.

export type Screen = 'overworld' | 'box' | 'battle' | 'trade' | 'challenge';

export class ScreenManager {
  #current: Screen = 'overworld';
  #listeners = new Set<(s: Screen) => void>();

  current(): Screen {
    return this.#current;
  }

  set(screen: Screen): void {
    if (screen === this.#current) return;
    this.#current = screen;
    for (const fn of this.#listeners) fn(screen);
  }

  onChange(fn: (s: Screen) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}
