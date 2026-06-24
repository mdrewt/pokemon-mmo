# Milestone 1 — The Pure Heart (`game-core`)

**Goal:** write the first real game rule — how a character moves one tile — as a pure, deterministic
Rust function, plus the data types and map it operates on. Prove it's deterministic with tests.

**Where it fits:** this is the "functional core" from Bet 2. Everything else in the project is plumbing
around the rules we write here. We start with movement because it's the one rule that runs in *both*
the server and the browser, so it's where determinism earns its keep.

## The crate manifest

Create `game-core/Cargo.toml`:

```toml
[package]
name = "game-core"
version = "0.1.0"
edition = "2021"

# Pure & deterministic by default: serde only. The optional `spacetimedb` feature adds
# `SpacetimeType` derives to the handful of types used as table columns / reducer arguments —
# it adds NO runtime logic and is enabled only by server-module (never by client-wasm).
[dependencies]
serde = { workspace = true }
ron = { workspace = true }
spacetimedb = { workspace = true, optional = true }

[features]
spacetimedb = ["dep:spacetimedb"]
```

The key idea: `game-core` depends on SpacetimeDB **optionally**. By default — which is how the browser
build sees it — the dependency isn't even compiled. Only the server build flips on the `spacetimedb`
feature. We'll see exactly what that buys us in a moment.

## The cross-boundary types

Our types have to travel across three boundaries: Rust → WASM → TypeScript (for prediction), and Rust →
SpacetimeDB (for storage). A type that's defined differently on each side is a classic source of bugs.
So we define each type **once**, here, and make it travel.

Here is the heart of `game-core/src/types.rs`:

```rust
//! Shared logical types — the frozen cross-boundary contract.
//!
//! Every type derives `serde` (it crosses the Rust↔WASM↔TS boundary). The few used as
//! SpacetimeDB table columns or reducer arguments additionally derive `SpacetimeType`, but only
//! when the `spacetimedb` feature is on (server build) — keeping the default/client build pure.

use serde::{Deserialize, Serialize};

/// A cardinal facing/step direction. Grid movement only — no diagonals.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Direction {
    North,
    South,
    East,
    West,
}
```

That `#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]` line is the trick of
the whole project, so let's read it slowly. `cfg_attr(CONDITION, ATTRIBUTE)` means "apply this
attribute *only if* the condition holds." The condition is "the `spacetimedb` feature is enabled." So:

- In the **browser build** (feature off): `Direction` derives only `serde`. It's a plain, pure enum.
- In the **server build** (feature on): `Direction` *additionally* derives `SpacetimeType`, which lets
  SpacetimeDB store it in a table column and generate a matching TypeScript type for it.

One definition, two capabilities, zero duplication. The browser never pays for the database derive; the
database never re-declares the type.

### Intent, not outcome

Look at `MoveInput` and read its doc comment carefully:

```rust
/// Player/NPC *intent* sent to the server (and applied locally for prediction). The server
/// computes the outcome from this — it never accepts a client-computed position.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum MoveInput {
    /// Face `Direction` and attempt to walk one tile that way.
    Step(Direction),
    /// Hop one tile in the current facing (or in place if blocked).
    Jump,
}
```

This is Bet 1 (server authority) encoded in a type. The client can send a `MoveInput` — "I intend to
step North" — but there is no variant for "I am now at tile (5,3)". Combined with the fact that *no
reducer anywhere accepts a position* (the server only ever takes a `MoveInput` and computes the
result itself), the client has no way to assert where it is. That's "make illegal states
unrepresentable": a big part of preventing a bad input is leaving no way to even write it down.

### Integer tiles, never floats

```rust
/// Authoritative position is integer tiles — never floats — so client and server cannot
/// numerically diverge. (Sub-tile visual interpolation is a client-only rendering concern.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}
```

Why integers? Floating-point results can differ between two *builds* of the same program. The basic
IEEE-754 operations (`+`, `−`, `×`, `÷`) are actually well-defined and give the same answer on any
conforming CPU — but a compiler can fuse a multiply-add into one rounding step, reassociate under
`fast-math`, or call a `sin`/`cos` whose last bit isn't standardized, and once a tiny difference creeps
into *accumulating* state it compounds: a billionth of a tile, then a thousandth, then visibly. (Our
two builds — the client's WASM and the server's native binary — are exactly the kind of pair where that
could happen; WASM pins basic float arithmetic tightly, but the native build's optimizer doesn't have
to agree on everything.) Integer tile coordinates sidestep the whole question — `2 + 1` is exactly `3`
in every build on every machine. The smooth sliding you *see* between tiles is computed only in the
renderer and never stored or sent. So this **entire class of float-rounding desync is designed out**:
position can't *numerically* drift. (Logic bugs or a stale build could still diverge — that's what the
reconciliation and tests in later chapters guard against — but the *arithmetic* can't betray you.)

### Time as a value

```rust
/// Milliseconds since an arbitrary fixed epoch. `game-core` never reads a clock — callers pass
/// time in (server: `ctx.timestamp` → ms; client: a `performance.now`-derived value).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Millis(pub u64);
```

Remember the clippy guard banned `SystemTime::now()`. `Millis` is the other half of that deal: time is
a plain number you *pass in*. The server passes its authoritative timestamp; the browser passes a value
derived from `performance.now()`; a test passes whatever constant it likes. The rule never knows or
cares where the number came from — which is exactly why it stays deterministic.

Finally, the bundle of fields the movement rule actually reads and writes — a character's logical state:

```rust
/// The full logical state of a character that the movement rule reads and writes. Crosses the
/// WASM boundary for prediction; not stored as a single table column (the table flattens it).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CharacterState {
    pub pos: TilePos,
    pub facing: Direction,
    pub action: ActionState,
    /// When the current move started (drives the slide animation / drain timing).
    pub move_started_at: Millis,
}
```

Where it stands (`pos`), which way it faces (`facing`), what it's doing (`action`), and when its
current move began (`move_started_at`). Keep these four fields in mind — they're exactly what
`apply_move` is about to touch.

## The map

The world, for now, is one hand-drawn grid — 20 tiles wide by 15 tall. From
`game-core/src/world/map.rs`:

```rust
/// The single POC map (20×15), hand-authored as string art (`#` blocked, `.` walkable, `,` tall
/// grass). Shared verbatim by client and server. Two grass patches (top-right, bottom-left) seed
/// wild encounters.
pub fn poc_map() -> TileMap {
    const ROWS: [&str; 15] = [
        "####################",
        "#..................#",
        "#..####....####....#",
        "#..........,,,,....#",
        "#....####..,,,,....#",
        "#..................#",
        "#........##........#",
        "#........##........#",
        "#..................#",
        "#..........####....#",
        "#..####............#",
        "#..,,,,............#",
        "#..,,,,............#",
        "#..................#",
        "####################",
    ];
    TileMap::from_rows(&ROWS)
}
```

The map is **string art**: `#` is a wall, `.` is floor, `,` is tall grass. `from_rows` turns those
characters into two boolean grids — one for "walkable", one for "is grass":

```rust
/// A row-major walkability grid. `true` = a character may stand on the tile.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TileMap {
    pub width: i32,
    pub height: i32,
    /// Row-major, length == `width * height`.
    pub walkable: Vec<bool>,
    /// Row-major... `true` = tall grass: walkable, but stepping onto it may trigger a wild encounter.
    pub grass: Vec<bool>,
}

impl TileMap {
    /// Whether `pos` is in bounds AND walkable.
    pub fn is_walkable(&self, pos: TilePos) -> bool {
        self.in_bounds(pos)
            && self
                .walkable
                .get((pos.y * self.width + pos.x) as usize)
                .copied()
                .unwrap_or(false)
    }
}
```

Note `is_walkable` checks `in_bounds` first and then uses `.get(...).unwrap_or(false)` — even if the
index math were somehow off, an out-of-range tile is treated as a wall, never a panic. Small, boring
defensiveness at exactly the spot a bug would be catastrophic.

> **Why is the map a function returning a `const`, not loaded from a file?** Because there's exactly
> one map. The project has an explicit rule: keep the map a hard-coded constant *until a second map
> exists*. A file-loading pipeline (Tiled, etc.) is real work and real complexity; building it for one
> map is solving a problem you don't have yet. This is "YAGNI" — You Aren't Gonna Need It — applied
> with a named exception so everyone knows the plan.

## THE movement rule

Everything so far has been setup. Here is the first actual *rule* of the game, the whole of
`game-core/src/world/movement.rs`'s core function:

```rust
/// Apply one already-due move to a character, returning the new state with `move_started_at = now`.
///
/// Never fails — a blocked `Step` is a **bump** (face the obstacle, stay put, `Idle`); a blocked
/// `Jump` hops in place. Timing/rate is enforced by the caller's drain cadence, not here.
pub fn apply_move(
    state: &CharacterState,
    input: MoveInput,
    map: &TileMap,
    now: Millis,
) -> CharacterState {
    let mut next = *state;
    next.move_started_at = now;

    match input {
        MoveInput::Step(dir) => {
            next.facing = dir;
            let target = state.pos.step(dir);
            if map.is_walkable(target) {
                next.pos = target;
                next.action = ActionState::Walking;
            } else {
                // Bump: face the obstacle, stay put.
                next.action = ActionState::Idle;
            }
        }
        MoveInput::Jump => {
            let target = state.pos.step(state.facing);
            next.action = ActionState::Jumping;
            if map.is_walkable(target) {
                next.pos = target;
            }
            // else hop in place: position unchanged, still Jumping.
        }
    }

    next
}
```

### How it works

The signature *is* the design. `apply_move` takes the current `state`, an `input`, the `map`, and the
current time `now`, and returns a **new** `CharacterState`. It reads four arguments and a copy of the
state; it touches nothing else in the universe. That's what "pure" means concretely.

The body:

- A `Step` faces the chosen direction (you always turn, even into a wall), then moves *only if* the
  target tile is walkable. A blocked step is a **bump**: you turn to face the wall but stay put. That's
  a deliberate, friendly game-feel choice — and notice it's a legal no-op, not an error.
- A `Jump` hops one tile in the way you're already facing, or hops in place if blocked.
- Either way, `move_started_at` is stamped with `now` so the renderer knows when to start the slide.

Crucially, **`apply_move` never returns an error.** There's no "illegal move" to reject here, because
rate-limiting (you can only move so often) is handled elsewhere by *how often we call this*, not by the
rule itself. Keeping the rule total (always returns a valid state) makes it trivial to reason about and
to run identically on both sides.

Two shared constants live alongside it:

```rust
/// The step duration / drain cadence in milliseconds (one tile per `STEP_MS`).
pub const STEP_MS: u64 = 200;

/// Maximum number of moves buffered per character. The drain cadence + this cap are the movement
/// rate limit ... a character advances at most one tile per `STEP_MS`.
pub const MOVE_QUEUE_CAP: usize = 2;
```

`STEP_MS` is the game's heartbeat: one tile every 200 ms. The server drains a move queue at this pace;
the browser predicts at the same pace; the renderer animates a slide over this duration. One constant,
shared everywhere, so the three can never disagree about how fast a character walks.

`MOVE_QUEUE_CAP` bounds that buffer: each character can hold at most **2** pending moves. The real
rate limit, though, is the **cadence**: the server (we'll see in Milestone 2) drains one move per
heartbeat, so a character advances at most one tile per 200 ms **no matter how fast a client sends
input.** A hostile client spamming the move command can't outrun that — the extra messages just pile
into a 2-deep buffer (and the append reducer rejects once it's full). Rate-limiting falls out of the
buffer-and-cadence model instead of needing a per-move cooldown check. (That's Bet 1 again: you design
the system so a client you don't trust simply *can't* move faster than the tick.)

## Proving determinism

A pure function is *testable* in the cheapest possible way: call it twice, expect the same answer. From
the test module at the bottom of `movement.rs`:

```rust
#[test]
fn deterministic_same_inputs_same_output() {
    let map = open_5x5();
    let s = state_at(TilePos { x: 2, y: 2 }, Direction::North);
    let a = apply_move(&s, MoveInput::Step(Direction::West), &map, NOW);
    let b = apply_move(&s, MoveInput::Step(Direction::West), &map, NOW);
    assert_eq!(a, b);
}
```

That test looks almost silly — of *course* a pure function returns the same thing twice. But it's a
*regression net*: the day someone sneaks a clock read or a random number into the movement path, this
test (and the clippy guard) start screaming. The other tests assert the actual behavior — that a step
into a wall bumps but still turns, that a jump into a wall hops in place, that stepping off the map
edge is a bump. Behavior tests, not implementation tests; they'd survive a rewrite of the function's
internals.

## Common pitfalls

- **Reaching for the clock or RNG inside a rule.** The instinct is "I'll just check the current time
  here." Don't — pass it in as a parameter. The clippy guard from Milestone 0 will stop you anyway, but
  understanding *why* keeps you from fighting it.
- **Storing position as a float for "smoother" movement.** The smoothness belongs in the renderer.
  Authoritative state stays integer, or you reintroduce desync.
- **Making `apply_move` return a `Result`.** It's tempting to "reject" a blocked move. But then the
  client and server have to agree on *when* to reject, which is a second rule to keep in sync. Keeping
  the function total (a bump is a valid outcome) sidesteps that entire class of bug.

## Alternatives & the honest verdict

- **A continuous (float) coordinate system** would allow smooth, non-grid movement and is what many
  action games use. The price is exactly the desync risk we engineered away: float math isn't
  guaranteed bit-identical across machines, so client prediction and server truth can drift. For a
  grid-based tamer, integers are both simpler and safer. **Verdict: integers are right here.** If you
  were building a physics platformer, you'd weigh this very differently and probably accept the
  complexity of a deterministic fixed-point math library.
- **Loading the map from a data file now** (instead of a `const`). Cleaner-sounding, but it's
  premature: you'd build a parser, a file format, and error handling for a single static map. **Verdict:
  the `const` is correct until map #2.** When that second map arrives, *then* the file pipeline pays for
  itself — and the code is structured so that swap is localized.
- **Putting movement logic in TypeScript and "porting" it to the server.** This is the seductive wrong
  turn for web developers, because TS feels like the natural home for client logic. It directly breaks
  the golden rule: now the same rule exists twice and *will* drift. **Verdict: never.** The whole point
  of compiling Rust to WASM is to avoid this.

## Checkpoint

From the repo root, `cargo test -p game-core` should pass — the movement and map tests are green.
`cargo clippy -p game-core` should be clean (and would fail loudly if you'd reached for a clock). You
now have a tiny, pure, fully-tested rulebook with no way to run it interactively yet. Next we give it a
home that the world can actually talk to: the SpacetimeDB server module.
