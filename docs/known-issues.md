# Known issues & deferred work

Issues and latent fragilities surfaced during the documentation review. None block normal play (the
full suite is green); these are robustness, balance, and scaling notes for the hardening phase now that
the feature roadmap is complete. Severity is **Low** unless noted.

Cross-cutting deferred items (PvP turn-timeout reaper, schema-migration story, spatial subscriptions,
CI blind spots) live in [ARCHITECTURE.md → M11 entry-conditions](../ARCHITECTURE.md#m11-entry-conditions-decide-before-building-multiplayer)
and [Scaling path](../ARCHITECTURE.md#scaling-path). This file lists the code-level items.

## Resolved in the documentation pass

- **Stale / misplaced doc comments** across `game-core`, `server-module`, and `frontend` were corrected
  (e.g. the `is_pvp` description on the `battle` struct, a duplicated `begin_encounter` doc block, the
  misattributed `roll_individuality`/`roll_starter` docs, the `damage` "primary affinity" wording, and
  several outdated milestone tags).
- **Dead `ScreenManager.toggle()`** and the **vestigial `'menu'` screen state** were removed (`'menu'`
  was never set and would have been a no-handler trap — a make-illegal-states-unrepresentable fix).

## Balance / exploit (by-design POC placeholders)

- **`heal_party` is free, untimed, and overworld-only** (`server-module/src/lib.rs`). A bot could
  heal-to-full after every turn, voiding the weaken-to-recruit loop's attrition. It's documented as a
  placeholder for a Pokémon-Center-style healing spot; gate it behind a location/cost/cooldown when that
  content lands.

## Server robustness (latent, currently safe)

- **`battle_action` double-submit guard is in-code only, not a DB unique constraint.** The guard reads a
  pre-insert snapshot and rejects a second pick. SpacetimeDB *can* re-execute reducers on serialization
  conflict; two near-simultaneous `submit_action` calls from the same identity could in principle each
  see an empty set and both insert. Very low likelihood (one identity submits serially). A unique index
  on `(battle_id, chooser_identity)` would be a backstop.
- **`apply_pvp_rating` is "called exactly once" by convention,** not structurally. It's a no-op unless
  the outcome is decisive, and every terminal path guards on `!is_over()`, so today it can't double-count
  — but a future intermediate decisive-looking outcome would break that. Keep the invariant in mind.
- **`persist_battle_hp`'s raid branch assumes the exact 2-ally team layout** (`team[..1]` / `team[1..]`
  mapping to the two owners). Safe because `build_raid_battle` always builds exactly two leads; a debug
  assertion on the team length would harden it.
- **`get_or_init_profile` can insert a blank-named profile** if called for an identity with no `player`
  row (the name backfill falls back to empty). In practice both PvP participants joined (so a profile
  already exists), but a disconnected opponent path could create a `name = ""` ladder entry. Data-quality
  only, not a crash.
- **`record_pick`'s pick lookup reads a pre-insert snapshot + a manual `or` for the caller.** Correct for
  exactly two participants; it would need rework if a battle ever had three choosers.

## game-core robustness (latent)

- **`BattleSide::active_ref` / `active_mut` index `team[active]` directly** and would panic on an
  out-of-range `active` — a contract the server must uphold (e.g. `resolve_player_swap` relies on the
  reducer validating the index, and a corrupt deserialized `BattleState` would also expose it). In an
  otherwise panic-free pure crate, consider documenting the precondition more loudly or returning a
  `Result`.
- **`resolve_coop_turn` encodes an implicit "exactly 2 allies + 1 boss" contract.** It degrades
  gracefully to one ally (a missing `team[1]` is treated as fainted) and ignores any 3rd team member or
  multi-monster boss — fine for the current raid shape, but undocumented as a hard invariant.
- **`load_fusions` does not reject an empty fusion list,** unlike every other content loader. Likely
  intentional (fusions could be optional), but inconsistent.
- **`level_for_xp` is an O(MAX) linear scan** (≤100 iterations) called per XP gain. Correct and
  deterministic; a closed-form cube root would be O(1) if it ever shows on a profile (consistent with the
  "optimize last" rule).
- **Unused dev-dependencies** `rand` / `rand_chacha` in `game-core/Cargo.toml` — no test or source
  references them (RNG is injected as a closure). Safe to remove or wire into a determinism test.

## Frontend (latent, self-correcting)

- **`committedDir` is not reset on a *diverging* reconcile** (`frontend/src/main.ts`). After the
  predictor snaps to a different tile/facing than predicted while a key is held, the responsive
  `setMove` re-issue can lag by one step (the sustained-hold branch recovers it). Deferred deliberately:
  a precise fix needs `reconcile` to report divergence + a predictor test, and getting it wrong risks a
  movement-prediction regression for a one-step latency edge.
- **`CharacterView.snapTo()` is unused** — the own view only ever *slides* (`moveTo`), so even a large
  diverging reconcile animates across the gap rather than snapping. Not a correctness bug (it converges);
  the "snap on a hard reconcile" comment describes behavior never invoked.
- **`TradeScreen.#respondChoice` is never pruned** when an offer is removed — the map grows across a long
  session (stale keys are simply never read). Harmless.
- **`Scene` has no teardown path** (`main.ts` discards the handle; the scene wires itself into the
  ticker). Fine for a single-session POC; a leak if reconnect-without-reload is ever added.

## Performance / scaling notes

- **`baitCount()` / `foodItems()` scan all owned item stacks per call** and run on every battle/box
  re-render. Negligible at POC scale (RLS-scoped to the owner) but O(items) behind a getter callers treat
  as cheap.
- **`movement_tick` and subscriptions are O(all rows)** — see [ARCHITECTURE.md → Scaling
  path](../ARCHITECTURE.md#scaling-path) for the per-zone-tick / spatial-subscription levers (schema is
  ready except a `character.map_id` index).
