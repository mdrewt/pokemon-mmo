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

/// What a character is currently doing — drives which animation the renderer plays.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum ActionState {
    Idle,
    Walking,
    Jumping,
}

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

/// Authoritative position is integer tiles — never floats — so client and server cannot
/// numerically diverge. (Sub-tile visual interpolation is a client-only rendering concern.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TilePos {
    pub x: i32,
    pub y: i32,
}

/// Milliseconds since an arbitrary fixed epoch. `game-core` never reads a clock — callers pass
/// time in (server: `ctx.timestamp` → ms; client: a `performance.now`-derived value).
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Millis(pub u64);

/// The full logical state of a character that the movement rule reads and writes. Crosses the
/// WASM boundary for prediction; not stored as a single table column (the table flattens it).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CharacterState {
    pub pos: TilePos,
    pub facing: Direction,
    pub action: ActionState,
    /// When the current action began — used server-side for the cooldown check.
    pub move_started_at: Millis,
}

/// Why an input was rejected. An `Err` aborts the reducer transaction; the client reconciles.
/// (Note: a legal no-op like bumping a wall is `Ok`, not an error.)
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum MoveError {
    /// The movement cooldown has not yet elapsed since `move_started_at`.
    TooSoon,
}
