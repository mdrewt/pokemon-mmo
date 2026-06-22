//! THE movement rule — the single source of truth for how a character moves.
//!
//! Run by the server (authoritative) AND the client (prediction, via client-wasm). It must
//! stay pure and deterministic: same `(state, input, map, now, step_ms)` ⇒ same output. This
//! identity is what makes client prediction match server truth. Never reimplement any of this
//! in TypeScript or in a reducer — call it.

use crate::map::TileMap;
use crate::types::{CharacterState, Millis, MoveError, MoveInput};

/// Apply one input to a character.
///
/// - `Ok(new_state)` with the same tile is a **legal no-op** (e.g. bumping a wall): facing may
///   change, position does not.
/// - `Err(..)` is an **out-of-contract** input (cooldown not elapsed) that the reducer rejects,
///   aborting the transaction; the client then reconciles.
///
/// `now` and `step_ms` are passed in — `game-core` never reads a clock.
pub fn resolve_input(
    state: &CharacterState,
    input: MoveInput,
    map: &TileMap,
    now: Millis,
    step_ms: u64,
) -> Result<CharacterState, MoveError> {
    let _ = (state, input, map, now, step_ms);
    todo!("M1: cooldown check, Step (move/bump), Jump (hop/hop-in-place)")
}
