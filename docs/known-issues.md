# Known issues & deferred work

Status of the issues surfaced during the documentation review. The full test suite is green; nothing
here blocks normal play. The first section is what was fixed; the rest is triaged with rationale.

Cross-cutting deferred items (PvP turn-timeout reaper, schema-migration story, spatial subscriptions,
CI blind spots) live in [ARCHITECTURE.md → M11 entry-conditions](../ARCHITECTURE.md#m11-entry-conditions-decide-before-building-multiplayer)
and [Scaling path](../ARCHITECTURE.md#scaling-path).

## Resolved

- **Movement re-issue stalled after a *diverging* reconcile.** `Predictor.reconcile` now **reports
  whether the correction diverged** (the re-drained predicted tile differs from what was shown); the
  game loop clears `committedDir` on a divergence so a still-held key re-issues a move from the
  corrected position instead of stalling a step. Covered by two predictor unit tests (divergence true on
  a misprediction, false when prediction was correct). *(`frontend/src/prediction/predictor.ts`,
  `main.ts`, `predictor.test.ts`.)*
- **`load_fusions` didn't reject an empty list** (inconsistent with every other content loader) — fixed;
  it now errors like the rest. *(`game-core/src/content/mod.rs`.)*
- **`TradeScreen.#respondChoice` grew unbounded** — its picker selections are now pruned each render to
  the set of live offers. *(`frontend/src/ui/trade.ts`.)*
- **Dead code removed:** `CharacterView.snapTo()` (never invoked), `ScreenManager.toggle()` + the
  vestigial `'menu'` screen state (an earlier pass), and the unused `rand` / `rand_chacha` dev-deps
  (no source references them — RNG is injected as a closure).
- **Stale / misplaced doc comments** across all three crates were corrected (see the documentation-pass
  commit).

## Re-evaluated — safe as-is (not bugs)

- **`battle_action` double-submit has no DB unique constraint, only an in-code guard.** This is
  sufficient: SpacetimeDB serializes conflicting reducer transactions and re-executes on conflict, so
  two `submit_action` calls from the *same* identity cannot both observe an empty action set — the
  second re-runs against the first's committed row and is rejected. A unique constraint would risk
  insert-panic semantics for no real gain.
- **`apply_pvp_rating` is "called once" by convention, not structurally.** Every terminal path guards on
  `!is_over()` and the function no-ops on a non-decisive outcome, so it cannot double-count today. Kept
  as a documented invariant.
- **`get_or_init_profile` could in theory insert a blank-named profile.** Unreachable in practice: a
  profile is created with the name on join, and both battle participants have joined, so the
  rating path always finds the existing row. The empty-name fallback is dead-defensive.
- **`persist_battle_hp` raid slicing / `resolve_coop_turn` assume a 2-ally team.** Safe by construction:
  `build_raid_battle` always builds exactly two leads, and `resolve_coop_turn` degrades gracefully to one
  ally (a missing `team[1]` is treated as fainted). The invariant is documented at both sites.
- **`BattleSide::active_ref`/`active_mut` index directly.** `active` is valid by construction (set to 0,
  only advanced to an existing member, swap target range-checked by the reducer); the precondition is now
  documented on `active_ref`. A corrupt deserialized `BattleState` is the only theoretical trigger.

## Deferred by design (not bugs — awaiting content or a measurement)

- **`heal_party` is a free, untimed full heal.** It's an explicit placeholder for a Pokémon-Center-style
  healing spot; the *proper* resolution is that content (a location + cost/cooldown), which is a design
  decision, not a code fix. Until then it's intentionally permissive. *(In-battle healing is already
  rejected, so this does not affect the in-battle weaken-to-recruit loop — only between-battle attrition.)*
- **`level_for_xp` is an O(level) linear scan** (≤100 iterations) — correct and deterministic; per the
  project's "optimize last, measure first" rule, not worth a closed-form rewrite without a profile
  showing it on a hot path.
- **`baitCount()`/`foodItems()` scan all owned stacks per call**, and **`movement_tick` + subscriptions
  are O(all rows).** Negligible at the target scale (tens–low-hundreds of players); the scaling levers
  (per-zone tick, spatial subscriptions, a `character.map_id` index) are deferred to a measurement, per
  [ARCHITECTURE.md → Scaling path](../ARCHITECTURE.md#scaling-path).
- **`Scene` has no teardown path** (the handle is discarded; it self-wires into the ticker). Fine for a
  single-session POC; would matter only if reconnect-without-reload is added (YAGNI).
