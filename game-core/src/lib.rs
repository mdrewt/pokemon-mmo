//! `game-core`: pure, deterministic game logic shared by the server (authoritative truth) and
//! the client (prediction, via `client-wasm`).
//!
//! Invariants (see ARCHITECTURE.md for the full rationale):
//! - No I/O, no clocks, no unseeded randomness, no platform deps in the default build. Time and
//!   randomness are passed in as arguments; the `clippy.toml` determinism guard enforces this.
//! - Authoritative position is integer tiles — never floats — so client and server cannot
//!   numerically diverge.
//! - Every game rule lives here ONCE and is called by both sides. Never reimplement a rule in
//!   TypeScript or a reducer.
//!
//! The optional `spacetimedb` feature adds `SpacetimeType` derives to the types used as table
//! columns / reducer arguments. It adds no runtime logic and is enabled only by `server-module`.

mod map;
mod movement;
mod npc;
mod types;

pub use map::{poc_map, TileMap};
pub use movement::resolve_input;
pub use npc::{npc_decide, NpcParams};
pub use types::{ActionState, CharacterState, Direction, Millis, MoveError, MoveInput, TilePos};
