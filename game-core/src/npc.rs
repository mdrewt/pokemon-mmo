//! Pure NPC decision logic (server-only at runtime; the client never predicts NPCs — it
//! interpolates their subscribed positions).

use serde::{Deserialize, Serialize};

use crate::map::TileMap;
use crate::types::{CharacterState, MoveInput, TilePos};

/// An NPC's wander envelope.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct NpcParams {
    pub home: TilePos,
    pub wander_radius: i32,
}

/// Decide an NPC's next intent.
///
/// The caller supplies `roll` (a random `u32` — server: from `ctx.rng()`; tests: a seeded
/// value). Taking a plain number instead of a `rand::Rng` keeps `game-core` free of any
/// rand-crate version coupling with SpacetimeDB and makes this trivially testable. Deterministic
/// given `(params, state, map, roll)`.
pub fn npc_decide(
    params: &NpcParams,
    state: &CharacterState,
    map: &TileMap,
    roll: u32,
) -> MoveInput {
    let _ = (params, state, map, roll);
    todo!("M1: choose a random in-bounds, walkable direction within wander_radius")
}
