# Architecture

A 2D top-down, pixel-art multiplayer monster-taming game (Pokémon Ruby/Sapphire feel).
Server-authoritative: **SpacetimeDB holds canonical state; the client predicts and reconciles
to the server, never the reverse.**

> This document is the durable design record. The current build target is the **POC**: join
> with a display name, walk a small map (turn / walk / jump), see it synced to a second browser
> window, plus one server-driven wandering NPC. Features beyond that are in [Scaling path](#scaling-path).

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

## Data model (SpacetimeDB tables — frozen contract, implemented in M2)

Entity/component split: one renderable `character` row per entity, plus a role row (`player`
or `npc`) keyed by `entity_id`.

- **`character`** (public): `entity_id u64 [pk, auto_inc]`, `map_id u32`, `tile_x i32`,
  `tile_y i32`, `facing Direction`, `action ActionState`, `move_started_at Timestamp`,
  `sprite_id u32`.
- **`player`** (public): `identity Identity [pk]`, `entity_id u64`, `name String`,
  `online bool`, `last_input_seq u64` (reconciliation ack — **never** trusted for authority).
- **`npc`** (public): `entity_id u64 [pk]`, `home_x i32`, `home_y i32`, `wander_radius i32`,
  `next_move_at Timestamp`.
- **`config`** (public, singleton): `id u32 [pk]`, `map_id u32`, world params.
- **`npc_tick_schedule`**: `scheduled(npc_tick)` interval table driving the NPC loop.

`Direction`, `ActionState`, `MoveInput` are defined in `game-core` and derive `SpacetimeType`
only under its `spacetimedb` feature (enabled by `server-module`, not by `client-wasm`). The
**map is not a table** in the POC — it's a `const`-style grid from `game_core::poc_map()`,
shared verbatim by both sides.

## `game-core` API (frozen in M0)

Types (`game-core/src/types.rs`): `Direction{N,S,E,W}`, `ActionState{Idle,Walking,Jumping}`,
`MoveInput{Step(Direction),Jump}`, `TilePos{x,y:i32}`, `Millis(u64)`,
`CharacterState{pos,facing,action,move_started_at}`, `MoveError`.

Functions:
- `resolve_input(state, input, map, now: Millis, step_ms) -> Result<CharacterState, MoveError>`
  — the one movement rule (`movement.rs`).
- `TileMap::{in_bounds, is_walkable}` + `poc_map() -> TileMap` (`map.rs`).
- `npc_decide(params, state, map, roll: u32) -> MoveInput` (`npc.rs`) — takes a plain `u32`
  random roll (not a `rand::Rng`) so `game-core` has no rand-version coupling with SpacetimeDB
  and stays trivially testable.

## Movement, time & prediction

Grid movement: a character occupies a tile and steps tile-to-tile; the client animates the
slide. `resolve_input` semantics:
- **`Step(dir)`**: face `dir`; if the target tile is in-bounds & walkable, move (`Walking`);
  else **bump** — stay, facing updated, `Idle`. A bump is a legal `Ok` no-op, *not* an error.
- **`Jump`**: hop one tile in facing if clear (`Jumping`), else hop in place.
- **Cooldown**: `Err(TooSoon)` if `now - move_started_at < step_ms`. An `Err` is out-of-contract
  and aborts the reducer transaction.

### No client/server clock sync (a deliberate netcode choice)

Integer tiles protect *position*; time is the other authoritative input, handled so the two
clocks never need to agree:
- **Cooldown is server-authoritative only** — the server compares `ctx.timestamp` against the
  stored `move_started_at` (server time vs server time — always consistent).
- **Honest clients never trip it**: the client emits its *next* `Step` only when the current
  step's local animation completes (~`step_ms`), so by the time the reducer runs the cooldown
  has elapsed. Held key ⇒ one step in flight + at most one buffered.
- **Interpolation uses local time**: the client's own character animates from the local input
  instant; **remote** characters animate from the **local receipt time** of each subscription
  update. The stored `move_started_at` is authoritative bookkeeping/ordering, not a client
  interpolation clock.

### Prediction & reconciliation (client `prediction/`)

State: `predicted: CharacterState`, `pending: VecDeque<{seq, MoveInput}>`, `next_seq: u64`.
- **On input**: assign `seq`, apply via `predict_input` → update `predicted`, push to `pending`,
  call `submit_input(input, seq)`.
- **On authoritative own-row update** (carrying `player.last_input_seq = acked`): drop `pending`
  with `seq ≤ acked`; reset `predicted` to the authoritative tile/facing/action; **replay** the
  remaining `pending` through `predict_input`. Snaps only on a genuine misprediction.
- **On reducer `Err`** (illegal input → nothing written, seq never acked): replay naturally
  drops it and the character snaps back. The client logs the error.

## Security invariants (the client is hostile)

Enforced in every reducer; reviewed by the `reducer-security-auditor` subagent:
- Identity comes only from `ctx.sender` — never a client-passed field.
- The server computes outcomes from *intent*; it never accepts a client-computed position.
- Every reducer re-validates legality against authoritative state (adjacency = 1 tile,
  walkability, cooldown, bounds). Reject with `Err` — **never silently clamp**.
- The scheduled `npc_tick` is guarded by `ctx.sender == ctx.identity()`.
- Names are validated (length/charset). Secrets/server-only state go in private tables (later).
- No `panic`/`unwrap` on reachable paths; all state in tables (no mutable globals).

## Engineering principles & how we trade them off

Applied with judgment, not dogma. (CLAUDE.md carries the concise version; this is the rationale.)
"Bug-free" is *approached, not guaranteed* — the net is a pure testable core + mechanical
enforcement + parity/determinism tests + review gates (`/code-review`, `/simplify`, the
subagents).

- **DRY — but not across the marshaling boundaries.** Game *rules* live once in `game-core`.
  The thin `client-wasm` / reducer / `net` wrappers will look repetitive; that boilerplate is
  intentional. Do not abstract it into clever generics that obscure the boundary.
- **YAGNI — with NAMED exceptions.** Build only the POC scope; defer the [Scaling path](#scaling-path).
  Two structures are deliberate architectural investments and must **not** be removed as
  "over-engineering": (1) full WASM client prediction, (2) the entity/component split
  (`character` + `player`/`npc`). They exist so taming/combat/items don't force a rewrite. Keep
  the POC map a concrete `const` grid — don't pre-abstract a Tiled/`TileMap` loader until a
  *second* map exists.
- **Clean / cohesion over cleverness.** Readable, obvious code; dependency-free domain core;
  I/O at the edges; small pure functions over clever ones.
- **Mechanical enforcement beats vibes.** Determinism → `clippy.toml`; type/boundary safety →
  the compiler + feature-flagged shared types; security → `reducer-security-auditor`; desync →
  `desync-guard`; DRY/YAGNI/clarity → `/simplify`; correctness/bugs → `/code-review`. Judgment
  fills only the gaps these cannot mechanically check.

## Build & integration chain

A `game-core` change ripples — rebuild **and** republish **and** maybe regenerate bindings.
Root `package.json` scripts encode this so steps (especially binding regen) aren't forgotten:

| Script | Action |
|---|---|
| `npm run build:wasm` | `wasm-pack build client-wasm --target bundler` |
| `npm run publish` | `spacetime publish -p server-module monster-tamer-mmo` |
| `npm run gen` | regenerate TS bindings into `frontend/src/module_bindings/` |
| `npm run build` | wasm → publish → gen → frontend build |
| `npm run check` | `cargo fmt --check` + `clippy -D warnings` + `tsc --noEmit` + `eslint` |
| `npm test` | `cargo test --workspace` + frontend `vitest run` |

Before changing a shared `game-core` signature, run codebase-memory impact analysis (blast
radius spans `client-wasm` + `server-module`). Dev note: an incompatible schema change needs
`spacetime publish --clear-database` (dev data is disposable).

## Testing strategy

- **`game-core` is the test center of gravity** — pure unit tests for every rule, plus
  determinism `(state,input,now)→same` and a **prediction-parity** test (client path == server
  path). This is the desync regression net.
- **Reducers stay thin** (lookup → `game-core` → write, zero branching game logic), so
  correctness is tested in `game-core`, sidestepping SpacetimeDB's weak test harness.
- **Frontend (`vitest`)**: the `prediction/` reconciliation against a faked authoritative stream
  (ack/replay/rollback). `predict_input` is mocked — the rule itself is tested in Rust — so no
  wasm-in-node. No pixel testing.
- **End-to-end**: two browser contexts via the Playwright MCP (see milestones).

## Milestones

M0 contracts & setup (this) · M1 `game-core` (test-first) · M2 `server-module` · M3
`client-wasm` · M4 `frontend` (+ dev debug HUD) · M5 two-window integration. One PR per
milestone → CI + reviews → merge.

## Scaling path

Not built now: Tiled-authored multi-map collision in a table; spatial subscriptions (near-you /
same-map, SQL-filtered) instead of subscribing to all; private tables for secrets (inventory,
tamed-monster stats); batched WASM-boundary transfer if profiling shows cost; monster/taming,
combat, chat, items as new `game-core` rules + tables.
