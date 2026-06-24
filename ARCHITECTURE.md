# Architecture

A 2D top-down, pixel-art multiplayer monster-taming game (Pokémon Ruby/Sapphire feel).
Server-authoritative: **SpacetimeDB holds canonical state; the client predicts and reconciles
to the server, never the reverse.**

> This document is the durable design record. The **POC** (M0–M5) is complete: join with a display
> name, walk a small map (turn / walk / jump), synced to a second browser window, plus one
> server-driven wandering NPC. The **game-systems phase** is in progress and now playable through the
> core loop — **find → tame → fight**: rolled-individual monsters (M6), a turn-based battle system
> (M7), and grass encounters + recruit-by-weaken + bait (M8). Movement keeps client prediction;
> battles are server-resolved with no prediction (see [Battle, taming & content](#battle-taming--content-m6m8)).
> Features beyond the current milestone are in [Scaling path](#scaling-path).

## Stack & crates

| Crate / dir | Role |
|---|---|
| `game-core/` | Pure, deterministic Rust: shared types + game rules. No I/O, no clocks, no platform deps (default build). |
| `client-wasm/` | Thin `wasm-bindgen` exports wrapping `game-core` for client-side **prediction**. |
| `server-module/` | SpacetimeDB 2.6 module: tables + reducers. Wraps `game-core` for **authoritative** logic. |
| `frontend/` | PixiJS v8 + TypeScript: rendering, input, networking glue, prediction/reconciliation. |

## The golden rule

**Every game rule lives once, in `game-core`.** The server runs it for authoritative truth;
the client runs the *same compiled code* (via `client-wasm`) for prediction. If a rule were
reimplemented in TypeScript or hand-rolled in a reducer, prediction would diverge from truth and
the game would desync. Never reimplement a `game-core` rule elsewhere — call it.

Two structural properties make desync hard to even express:
- **Authoritative position is integer tiles, never floats** — client and server cannot
  numerically diverge. Sub-tile motion is purely a client-side *visual* interpolation.
- **`game-core` is pure & deterministic** — same `(state, input, time, seed)` ⇒ same output.
  Enforced mechanically by `clippy.toml` (`disallowed-methods` bans wall-clock reads and
  unseeded RNG) so impurity fails the build.

## Data model (SpacetimeDB tables)

Entity/component split: one renderable `character` row per entity, plus a role row (`player`
or `npc`) keyed by `entity_id`. Time columns are `i64` milliseconds since the unix epoch (`*_ms`)
to round-trip with `game_core::Millis`.

**World / movement (M2):**
- **`character`** (public): `entity_id u64 [pk, auto_inc]`, `map_id u32`, `tile_x i32`,
  `tile_y i32`, `facing Direction`, `action ActionState`, `move_started_at_ms i64`,
  `sprite_id u32`, `move_queue Vec<MoveInput>` (bounded FIFO, drained one per tick).
- **`player`** (public): `identity Identity [pk]`, `entity_id u64 [indexed]`, `name String`,
  `online bool`, `last_input_seq u64` (reconciliation ack — **never** trusted for authority).
- **`npc`** (public): `entity_id u64 [pk]`, `home_x i32`, `home_y i32`, `wander_radius i32`,
  `next_move_at_ms i64`.
- **`config`** (public, singleton) · **`movement_tick_schedule`**: `scheduled(movement_tick)`
  interval table — the server-paced movement loop (drains one queued move per character per tick).

**Content (M6–M8), seeded at `init` from the `game-core` RON registry, read-only to clients:**
- **`species`** (public): templates — base `StatBlock`, affinities, `skills Vec<u32>` learnset,
  `recruit_rate u16`, `sprite_id`. · **`skill`** (public): name/affinity/category/power. ·
  **`type_relation`** (public): the affinity chart as rows (client shows effectiveness hints from
  this data — not a duplicated rule). · **`item`** (public): bait templates (`recruit_bonus`). ·
  **`encounter`** (**private**): per-zone weighted spawn table; the client never needs it, the
  server reads it on a grass step (the table *is* the runtime cache — no per-tick RON re-parse).

**Player-owned state (M6–M8), public but RLS-scoped to the owner:**
- **`monster`** (public, indexed `owner_identity`): an owned individual — `species_id`, `nickname`,
  `level`/`xp`/`xp_floor`/`xp_next`, `potential` (genes), `temperament`, `training`, `bond`,
  `current_hp` (**persists between battles**), server-derived `derived StatBlock`, `party_slot
  Option<u8>`. A **`client_visibility_filter`** RLS rule scopes rows to `owner_identity = :sender`
  so hidden genes/stats never reach another client's wire.
- **`battle`** (public, RLS-scoped to owner): the whole authoritative `BattleState` as one column,
  plus `party_monster_ids` (HP write-back map), the rolled `wild_potential`/`wild_temperament` (so a
  successful recruit rebuilds *that exact* wild), `last_events Vec<BattleEvent>` (turn log),
  `last_xp_gain`/`leveled_up`.
- **`player_item`** (public, RLS-scoped to owner): owned item quantities (bait).

Domain types (`Direction`, `ActionState`, `MoveInput`, `StatBlock`, `Affinity`, `Temperament`,
`BattleState`, `BattleEvent`, …) are defined in `game-core` and derive `SpacetimeType` only under its
`spacetimedb` feature (enabled by `server-module`, not `client-wasm`); the server stores them as
columns and `spacetime generate` produces the TS bindings, so cross-boundary shapes are never
hand-written twice. The **map is not a table** — it's a `const`-style grid from
`game_core::poc_map()` (now with a tall-grass layer), shared verbatim by both sides.

## `game-core` API

`game-core` is organised into modules, each a pure rule layer the server and (for movement) the
client both call. **The movement core was frozen in M0**; the rest grew with the milestones that
use it (grow-the-schema, don't speculate it). Randomness is always a seeded value passed in (a `u32`
roll or a variance byte) so there is no `rand`-version coupling with SpacetimeDB and everything is
trivially testable — `clippy.toml` bans clocks/unseeded RNG to keep it honest.

- **`world/`** — movement & the map. `apply_move(state, input, map, now: Millis) ->
  CharacterState` (the one movement rule, total — a bump is a legal no-op), `TileMap::{in_bounds,
  is_walkable, is_grass}` + `poc_map()`, `npc_decide(params, state, map, roll: u32)`, `STEP_MS`,
  `MOVE_QUEUE_CAP`.
- **`monster/`** — the individuality data model (`StatBlock`, `Affinity`, `Temperament`,
  `Potential`, `Training`, `Bond`, `Level`, `Xp`, `Species`, `MonsterInstance`) + pure rules:
  `derive_stats` (base + genes + training + temperament + level), the `level³` XP curve
  (`xp_for_level`/`level_for_xp`/`level_bounds`), and the seeded `roll_individuality`/`roll_starter`.
- **`combat/`** — the turn-based battle resolver. `BattleState`/`BattleSide`/`BattleMonster`,
  the integer (float-free) `damage` formula + data-driven `TypeChart`/`Effectiveness`, and the
  three resolution rules that emit an ordered `Vec<BattleEvent>`: `resolve_turn` (both sides attack
  in speed order), `resolve_enemy_turn` (player took a non-attack action → only the wild acts), and
  `resolve_player_swap` (switch active, then the wild hits the monster sent in). Enemy AI
  (`pick_best_skill`) + `battle_xp_reward`.
- **`taming/`** — finding & taming. `EncounterTable` (weighted, level-ranged) with
  `roll_encounter` + the free `encounter_triggers(roll)`, the recruit-by-weaken odds rule
  `recruit_chance(max_hp, current_hp, base_rate, bait_bonus)` + `attempt_recruit`, and the `Item`
  template.
- **`content/`** — `load_species`/`load_skills`/`load_type_chart`/`load_encounters`/`load_items`
  parse the embedded RON registries (`game-core/content/*.ron`) with a `validate_content`
  integrity check (no dangling skill/species refs). See [Data-driven development](#tier-2--high-value-apply-with-judgment).
- **`types.rs`** — the shared movement value types (`Direction`, `ActionState`, `MoveInput`,
  `TilePos`, `Millis`, `CharacterState`).

## Movement, time & prediction

Grid movement: a character occupies a tile and steps tile-to-tile; the client animates the
slide. `apply_move(state, input, map, now)` is a total function (returns a `CharacterState`, never an
error):
- **`Step(dir)`**: face `dir`; if the target tile is in-bounds & walkable, move (`Walking`);
  else **bump** — stay, facing updated, `Idle`. A bump is a legal no-op, *not* an error.
- **`Jump`**: hop one tile in facing if clear (`Jumping`), else hop in place.

### Server-paced movement (the move buffer)

Movement is **server-paced**, not cooldown-rejected. Each `character` carries a bounded
`move_queue`; the scheduled `movement_tick` drains *one* queued move per character every `STEP_MS`
and computes its outcome with `apply_move` at drain time — so a character advances at most one tile
per tick regardless of how fast a client sends. The queue reducers (`enqueue_move` appends and
rejects only when full = anti-flood; `set_move` replaces the un-drained buffer for a responsive
turn; `clear_queue` stops). The client flow-controls (never enqueues past `MOVE_QUEUE_CAP`) and
commits the next step *at* the current step's completion — no client lookahead — so releasing a key
stops cleanly with no overshoot.

### No client/server clock sync (a deliberate netcode choice)

Integer tiles protect *position*; time is handled so the two clocks never need to agree:
- **Pacing is server-authoritative** — the tick cadence (`STEP_MS`, server time) decides when a
  queued move applies; the client never asserts *when* it moved.
- **Interpolation uses local time**: the client's own character animates from the local input
  instant; **remote** characters animate from the **local receipt time** of each subscription
  update. The stored `move_started_at_ms` is authoritative bookkeeping/ordering, not a client
  interpolation clock.

### Prediction & reconciliation (client `prediction/`)

State: `predicted: CharacterState`, `pending: VecDeque<{seq, MoveInput}>`, `next_seq: u64`. The
client predicts the same `apply_move` (compiled to WASM) the server drains, and reconciles against
the authoritative `character` row + the `last_input_seq` ack:
- **On input**: assign `seq`, apply via the WASM `apply_move` → update `predicted`, push to
  `pending`, and call the matching queue reducer (`enqueue_move` / `set_move` / `clear_queue`).
- **On authoritative own-row update** (carrying `player.last_input_seq = acked`): drop `pending`
  with `seq ≤ acked`; reset `predicted` to the authoritative tile/facing/action + the remaining
  server `move_queue`; **replay** the rest through `apply_move`. Snaps only on a genuine misprediction.
- **On a rejected enqueue** (queue full / stale seq → nothing written, seq never acked): replay
  naturally drops it and the character converges to authority. The client logs the rejection.

## Battle, taming & content (M6–M8)

The game-systems layer is built on the same functional-core / server-authority spine as movement,
with one deliberate difference: **battles are turn-based and server-resolved, so there is NO client
prediction.** The client submits *intent* (a skill id, a swap index, a recruit attempt) and animates
the authoritative `BattleState` from its subscription — animation hides the round-trip, so there are
no damage/faint rollbacks to reconcile (much simpler netcode than movement).

- **Individuality (M6).** A `Species` is a template; each owned `monster` is a unique individual —
  hidden per-stat genes (`Potential`), a `Temperament` (nudges a stat pair), `bond`, a player name,
  and stats *derived server-side* via `derive_stats` and stored on the row (the client reads them; the
  formula stays single-sourced). On first join the player is granted one seeded-roll starter.
- **Battle (M7).** Readable core: one active per side (the rest bench), speed-ordered attacks, a
  data-driven type/affinity chart, **auto-switch** when an active faints. XP-on-win drives the `level³`
  curve with visible progression; an event-based turn log carries damage numbers + "X fainted!". HP
  **persists between battles** (written back to the monster row each turn); a placeholder `heal_party`
  restores it. Deferred depth layer: weakness-tempo combos, team auras, multi-active 3v3, status.
- **Voluntary switch.** Beyond auto-switch, `swap_active(team_index)` sends in a benched, conscious
  party member; the swap costs the turn (the wild then hits the monster sent in). The server validates
  the index (in range, not the current active, not fainted) and *rejects* an illegal choice.
- **Finding & taming (M8).** Tall-grass tiles on the shared map; the scheduled `movement_tick` rolls
  `encounter_triggers` when a player *steps into* grass and starts a wild battle from a data-driven,
  weighted per-zone `encounter` table. **Recruit-by-weaken:** `recruit_chance` rises as the wild's HP
  drops (per-species `recruit_rate` floor + an optional consumed-bait bonus); on success the wild —
  rebuilt from the individuality kept on the `battle` row, so it's *that exact* monster — joins the box
  at full HP; on failure the player forfeits the turn (the wild strikes back).
- **Data-driven content.** Every monster/skill/affinity/encounter/item is **data, not code**: RON
  files under `game-core/content/`, embedded via `include_str!`, parsed by a pure `game-core` fn
  (`load_*`, parse-don't-validate + integrity-tested), and seeded into the public read-only tables at
  `init` (the table is the cache — reducers read it by id, never re-parse). Clients read content from
  their subscription, so it's never duplicated in TS — even battle effectiveness *hints* are a lookup
  on the subscribed `type_relation` rows, not a re-implemented rule.

Reducers stay thin: they validate `ctx.sender` ownership + legality, delegate the *rule* to
`game-core`, and write tables. No battle/recruit/encounter outcome is ever computed in TS or
hand-rolled in a reducer.

## Security invariants (the client is hostile)

Enforced in every reducer; reviewed by the `reducer-security-auditor` subagent:
- Identity comes only from `ctx.sender` — never a client-passed field. Ownership is re-checked on
  every monster/battle/item write (e.g. HP write-back re-verifies `owner_identity` against current
  state, not just the battle-time snapshot).
- The server computes outcomes from *intent*; it never accepts a client-computed position, damage,
  recruit roll, or score. The client sends a direction / skill id / swap index / recruit flag; the
  server derives the result from authoritative state + `ctx.rng()`.
- Every reducer re-validates legality against authoritative state — movement (walkability, bounds,
  the per-tick drain), battle (in your own battle, not over, the active knows the skill), swap (index
  in range, not the current active, not fainted), recruit (bait owned + consumed). Reject with `Err`
  — **never silently clamp**.
- The scheduled `movement_tick` is guarded by `ctx.sender == ctx.identity()`; its grass-encounter
  trigger acts only on the moved character's true owner.
- Names are validated (length/charset). Hidden state stays off other clients' wire via **RLS
  `client_visibility_filter`s** (`monster`, `battle`, `player_item` scoped to the owner) and a
  **private** `encounter` table; public content tables are world-readable but module-write-only.
- No `panic`/`unwrap` on reachable paths; all state in tables (no mutable globals).

## Engineering principles & how we trade them off

Applied with judgment, not dogma. (CLAUDE.md carries the concise version; this is the rationale.)
"Bug-free" is *approached, not guaranteed* — the net is a pure testable core + mechanical
enforcement + parity/determinism tests + review gates (`/code-review`, `/simplify`, the
subagents).

The through-line is **functional core / imperative shell with server authority**: `game-core`
is a pure, deterministic core; reducers, the wasm boundary, and the frontend are the effectful
shell. Every principle below is kept, adapted, or *rejected* by how well it serves that shape.
This is a **curated** set on purpose — adopting all of "best practices" verbatim is harmful,
because several genuinely conflict here (Postel vs. strict validation; OCP vs. exhaustive enums;
full Design-by-Contract vs. KISS). Don't cargo-cult; follow the tiers.

### Tier 1 — Foundational (treat as non-negotiable law)

- **Single Source of Truth.** The spine. One `resolve_input`, one `STEP_MS`, one `poc_map`.
  Every desync bug is an SSOT violation.
- **Separation of Concerns / functional core + imperative shell.** Rules (game-core) ≠
  persistence (reducers) ≠ prediction marshaling (client-wasm) ≠ render/input/net (frontend).
  Rendering never owns state.
- **Determinism & purity.** Same `(state, input, time, seed)` ⇒ same output; time/RNG passed in.
  This is what makes prediction == authority. Enforced by `clippy.toml`.
- **Make illegal states unrepresentable + parse, don't validate.** Enums (`Direction`),
  newtypes (`Millis`, `TilePos`), integer-tile positions (never floats). Validate at the
  boundary, produce typed domain values, then trust types inward.
- **Design by Contract (lightweight).** `resolve_input`'s contract (legal→`Ok`, out-of-contract
  →`Err`), reducer preconditions, and the determinism guarantee are contracts — expressed via
  doc-comment invariants + `debug_assert!` + the parity tests. **Not** a runtime-contract
  framework (that fights KISS).
- **DRY — but NOT across marshaling boundaries.** Rules live once in `game-core`. The thin
  `client-wasm`/reducer/`net`/`convert` wrappers are *intentionally* repetitive; do not abstract
  that boilerplate into clever generics that obscure the boundary.
- **YAGNI — with NAMED exceptions.** Build only current scope; defer the
  [Scaling path](#scaling-path). Do **not** remove as "over-engineering": (1) full WASM client
  prediction, (2) the entity/component split (`character` + `player`/`npc`). Keep the POC map a
  concrete `const` grid until a *second* map exists.
- **Mechanical enforcement over discipline.** Determinism → `clippy.toml`; boundaries → the
  compiler + feature-flagged shared types; security → `reducer-security-auditor`; desync →
  `desync-guard`; DRY/YAGNI/clarity → `/simplify`; bugs → `/code-review`. Prefer a check that
  makes a mistake impossible over a guideline that asks people to remember.
- **Errors are values; reducers deterministic & idempotent.** `Result` everywhere; no
  `panic`/`unwrap` on reachable paths (SpacetimeDB may re-execute reducers).

### Tier 2 — High value, apply with judgment

- **Defensive programming — at trust boundaries only.** The server treats the client as hostile
  (*reject, don't clamp*). Inside the validated pure core, defensive checks are noise — types
  already guarantee validity.
- **Data-driven development.** This is a *content* game: monsters, items, moves, encounter
  tables, NPC configs, Tiled maps should be **data, not code**, driving generic systems. This is
  the difference between scaling to a real game and a pile of hardcoded special cases.
  - *Content pipeline (M6+):* content lives in **RON files under `game-core/content/`**, embedded
    at build time via `include_str!` and parsed into a typed registry by a pure `game-core` fn
    (`load_species`; parse-don't-validate, integrity-tested). The server **seeds it into a public,
    read-only table at `init`** (the table is the runtime cache — reducers read it, never re-parse;
    a module can't hold a mutable static cache). Clients read content from their subscription, so
    it's never duplicated in TS. game-core stays pure (no runtime fs).
- **Loose coupling + SRP + DIP at seams.** SRP universally; DIP where it buys testability (the
  `Predictor`'s injected `PredictFn` is exactly this). Don't add interfaces everywhere "for
  flexibility" — that fights KISS in Rust.
- **TDD for the core; behavior-focused tests generally.** game-core is built test-first (ideal
  for pure/deterministic code). Don't pixel-test rendering. Tests read as behaviors — the useful
  half of BDD without the Cucumber/Gherkin tooling (which is YAGNI here).
- **KISS + Principle of Least Astonishment + Fail Fast.** Obvious code; consistent cross-boundary
  naming/shapes; reject bad input early and loudly.

### Tier 3 — Already true or minor

- **Component-based / Modular** — already the model (entity/component data; crates + frontend
  layers). Don't regress it; nothing to add.
- **Law of Demeter** — mild; apply in our own code, but don't fight SpacetimeDB's fluent
  `ctx.db.player().identity().find()` idiom.

### Unsuitable here / inverted (to prevent cargo-culting)

- **Postel's Law / Robustness Principle — INVERTED.** "Be liberal in what you accept" is the
  opposite of a server-authoritative, hostile-client model (and a known source of security holes
  and spec erosion). Be **strict** in what you accept (reject malformed/illegal input — already
  the rule); keep only the "conservative in what you emit" half.
- **Full SOLID — CHERRY-PICK.** Keep SRP and DIP-at-seams. **OCP is often counterproductive**:
  for game rules we *want* exhaustive `match` so adding a `MoveInput`/monster variant makes the
  compiler flag every site, not hide extension behind open/closed indirection. LSP/ISP are
  near-no-ops in this mostly-non-OOP codebase.
- **Uniform Access Principle — LOW value.** The Rust field-vs-method distinction is idiomatic and
  tooling-supported; UAP adds little and getter-wrapping plain data is mildly anti-idiomatic.
- **Heavyweight BDD / runtime contract frameworks — YAGNI.** Keep the *principles* (behavior-
  focused tests, contracts); skip the tooling.

## Build & integration chain

A `game-core` change ripples — rebuild **and** republish **and** maybe regenerate bindings.
Root `package.json` scripts encode this so steps (especially binding regen) aren't forgotten:

| Script | Action |
|---|---|
| `npm run build:wasm` | `wasm-pack build client-wasm --target bundler` (the browser prediction WASM) |
| `npm run publish` | `spacetime publish -p server-module -s local monster-tamer-mmo` |
| `npm run gen` | regenerate TS bindings (`spacetime generate … --module-path server-module`) into `frontend/src/module_bindings/` (committed — CI has no `spacetime` CLI) |
| `npm run build:server` | `publish` → `gen` |
| `npm run build` | wasm → publish → gen → frontend build |
| `npm run check` | `cargo fmt --check` + `clippy -D warnings` + `tsc --noEmit` + `eslint` |
| `npm test` | `cargo test --workspace` + frontend `vitest run` |
| `npm run test:e2e` | Playwright two-window suite (local; needs `spacetime start`) |

A `game-core` change can ripple through three targets, so flag the chain: rebuild the prediction WASM
(`build:wasm`), republish the server module, **and regenerate the TS bindings** (`gen`) after any
schema/shared-type change. Before changing a shared `game-core` signature, run codebase-memory impact
analysis (blast radius spans `client-wasm` + `server-module` + the bindings). Dev note: an
incompatible schema change needs `spacetime publish … --delete-data --yes` (dev data is disposable).

## Testing strategy

- **`game-core` is the test center of gravity** — pure unit tests for every rule (movement, stat
  derivation + XP curve, damage + turn resolution + swap, encounter roll + recruit odds, content
  integrity). For *movement* there is also a determinism `(state,input,now)→same` check and a
  **prediction-parity** test (client path == server path) — the desync regression net. Combat/taming
  are server-resolved only (no `client-wasm` battle export), so their determinism unit tests suffice;
  there is no client path to diverge.
- **Reducers stay thin** (lookup → `game-core` → write, zero branching game logic), so
  correctness is tested in `game-core`, sidestepping SpacetimeDB's weak test harness.
- **Frontend (`vitest`)**: the `prediction/` reconciliation against a faked authoritative stream
  (ack/replay/rollback) + the `convert` boundary marshaling. `predict_input` is mocked — the rule
  itself is tested in Rust — so no wasm-in-node. No pixel testing.
- **End-to-end (local-only)**: two browser contexts via Playwright assert against a DEV-only
  `window.__game` introspection hook (canonical store/predictor state, never canvas pixels) — movement
  sync, no-desync, box/party, a fought battle + XP, a recruit + bait, a mid-battle switch. CI has no
  `spacetime` CLI, so e2e runs locally against `spacetime start` (`global-setup` republishes with
  `--delete-data`).

## Milestones

**POC (done):** M0 contracts & setup · M1 `game-core` (test-first) · M2 `server-module` · M3
`client-wasm` · M4 `frontend` (+ dev debug HUD) · M5 two-window integration.

**Game:** M6 monster foundation & individuality (**done**) · M7 battle — turn-based, server-resolved,
type chart + readable core, visible XP, persistent HP (**done**) · M8 finding & taming — grass
encounters, recruit-by-weaken, bait, plus a voluntary in-battle switch (**done**) · **M9 raising &
growth (next)** — active training/feeding/care shaping the stat spread + bond · M10 evolution &
fusion · M11 multiplayer (trade / PvP / co-op).

One PR per milestone → CI + the review gates (`reducer-security-auditor`, `desync-guard`,
`/simplify`, `/code-review`) → merge, with the user verifying user-facing feel first. (See the
project plan/memory for the full vision.)

### Frontend screen state (M6+)

The frontend routes distinct screens (`overworld | box | battle | menu`) through a minimal
enum-driven `ScreenManager` (`ui/screen.ts`) — no FSM library. Movement input is gated to the
overworld; menus are HTML overlays that read authoritative state from the store and call
ownership-checked reducers (input → intent → reducer; subscription → state → render). They never
mutate state locally. The box/party, battle, and item overlays are pure views of the subscription.
Owner-scoped data (monster hidden genes, an active battle, item counts) is kept off other clients'
wire via **Row-Level Security `client_visibility_filter`s** on the `monster`/`battle`/`player_item`
tables, not just `public` — see the Security invariants.

## Scaling path

Built since (no longer "scaling path"): monsters/battle/taming as `game-core` rules + tables, and
owner-scoped privacy via RLS filters (`monster`/`battle`/`player_item`) + a private `encounter` table.

Still deferred (do NOT build until load or a milestone demands it): the remaining game milestones
(M9 raising, M10 evolution & fusion, M11 multiplayer trade/PvP/co-op); Tiled-authored multi-map
collision in a table (the `const` map stays until a 2nd map); **spatial / per-zone subscriptions**
(near-you / same-map, SQL-filtered) instead of subscribing to everything — the schema is already
seeded with `map_id`/`zone_id` columns + indexes so this is a query change, not a migration;
per-zone tick scheduling; batched WASM-boundary transfer if profiling shows cost; a deeper
inventory/economy, chat, story/quests; and a schema-migration story before any real launch (once
real users exist you can't `--delete-data`). The named hot paths (subscription fan-out, the
scheduled tick, per-frame Pixi render) are the only places to optimise, and only with a measurement.
