// Small monster display helpers shared by the box UI and the test introspection hook. Pure reads of
// authoritative (subscribed) state — never game rules (those live in game-core).

import type { Training } from './module_bindings/types';

/** The bond cap and total-training cap, mirroring game_core's `Bond::MAX` / `Training::TOTAL_MAX`.
 *  Display-only (the server enforces the real caps); kept here so the UI denominators aren't bare
 *  literals. The Rust↔TS copy is acceptable per CLAUDE.md ("DRY but not across marshaling boundaries"). */
export const BOND_MAX = 255;
export const TRAINING_TOTAL_MAX = 510;

/** Total training (EV-like) invested across all stats — mirrors `game_core::Training::total()`. */
export function trainingTotal(t: Training): number {
  return t.hp + t.attack + t.defense + t.special + t.speed;
}
