// Minimal app screen-state machine. The game has distinct screens (overworld gameplay, the monster
// box, later battle and menus); this routes which one is active so input and UI don't tangle. It is
// deliberately a plain enum + listeners — no FSM library (KISS). Added in M6 before the box/battle
// UIs multiply.

export type Screen = 'overworld' | 'box' | 'battle' | 'trade' | 'menu';

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

  /** Open `screen`, or return to overworld if it's already open (toggle). */
  toggle(screen: Screen): void {
    this.set(this.#current === screen ? 'overworld' : screen);
  }

  onChange(fn: (s: Screen) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
}
