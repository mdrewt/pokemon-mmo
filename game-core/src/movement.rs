//! THE movement rule — the single source of truth for how a character moves one tile.
//!
//! Run by the server (the `movement_tick` drain) AND the client (prediction, via client-wasm).
//! It must stay pure and deterministic: same `(state, input, map, now)` ⇒ same output. That
//! identity is what makes client prediction match server truth. Never reimplement it in
//! TypeScript or in a reducer — call it.
//!
//! Movement is paced by the drain *cadence* (one move per `STEP_MS`), not by a per-move cooldown
//! check, so `apply_move` itself never rejects: a blocked step is a legal in-place no-op.

use crate::map::TileMap;
use crate::types::{ActionState, CharacterState, Millis, MoveInput};

/// The step duration / drain cadence in milliseconds (one tile per `STEP_MS`). Shared by the
/// server tick and the client drain so they never diverge.
pub const STEP_MS: u64 = 200;

/// Maximum number of moves buffered per character. The drain cadence + this cap are the movement
/// rate limit (replacing the old per-move cooldown): a character advances at most one tile per
/// `STEP_MS`, and `enqueue_move` rejects once the queue is full (anti-flood). Also the client's
/// flow-control bound, exported to JS via `client-wasm` so both sides share the value.
pub const MOVE_QUEUE_CAP: usize = 2;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Direction, TilePos};

    const NOW: Millis = Millis(1000);

    fn state_at(pos: TilePos, facing: Direction) -> CharacterState {
        CharacterState {
            pos,
            facing,
            action: ActionState::Idle,
            move_started_at: Millis(0),
        }
    }

    fn open_5x5() -> TileMap {
        TileMap::from_rows(&[".....", ".....", ".....", ".....", "....."])
    }

    #[test]
    fn step_into_open_tile_moves_faces_and_stamps_time() {
        let map = open_5x5();
        let s = state_at(TilePos { x: 1, y: 1 }, Direction::North);
        let out = apply_move(&s, MoveInput::Step(Direction::East), &map, NOW);
        assert_eq!(out.pos, TilePos { x: 2, y: 1 });
        assert_eq!(out.facing, Direction::East);
        assert_eq!(out.action, ActionState::Walking);
        assert_eq!(out.move_started_at, NOW);
    }

    #[test]
    fn step_into_wall_bumps_but_still_turns() {
        let map = TileMap::from_rows(&[".....", ".....", "..#..", ".....", "....."]);
        // At (2,1) facing North; stepping South targets the wall at (2,2).
        let s = state_at(TilePos { x: 2, y: 1 }, Direction::North);
        let out = apply_move(&s, MoveInput::Step(Direction::South), &map, NOW);
        assert_eq!(out.pos, TilePos { x: 2, y: 1 }, "did not move");
        assert_eq!(
            out.facing,
            Direction::South,
            "still turned to face the wall"
        );
        assert_eq!(out.action, ActionState::Idle);
    }

    #[test]
    fn step_off_map_edge_bumps() {
        let map = open_5x5();
        let s = state_at(TilePos { x: 0, y: 0 }, Direction::South);
        let out = apply_move(&s, MoveInput::Step(Direction::North), &map, NOW);
        assert_eq!(out.pos, TilePos { x: 0, y: 0 });
        assert_eq!(out.action, ActionState::Idle);
    }

    #[test]
    fn jump_into_open_tile_hops_forward() {
        let map = open_5x5();
        let s = state_at(TilePos { x: 1, y: 1 }, Direction::East);
        let out = apply_move(&s, MoveInput::Jump, &map, NOW);
        assert_eq!(out.pos, TilePos { x: 2, y: 1 });
        assert_eq!(out.action, ActionState::Jumping);
    }

    #[test]
    fn jump_into_wall_hops_in_place() {
        let map = TileMap::from_rows(&[".....", ".....", "..#..", ".....", "....."]);
        let s = state_at(TilePos { x: 2, y: 1 }, Direction::South); // facing the wall at (2,2)
        let out = apply_move(&s, MoveInput::Jump, &map, NOW);
        assert_eq!(out.pos, TilePos { x: 2, y: 1 }, "hopped in place");
        assert_eq!(out.action, ActionState::Jumping);
    }

    #[test]
    fn deterministic_same_inputs_same_output() {
        let map = open_5x5();
        let s = state_at(TilePos { x: 2, y: 2 }, Direction::North);
        let a = apply_move(&s, MoveInput::Step(Direction::West), &map, NOW);
        let b = apply_move(&s, MoveInput::Step(Direction::West), &map, NOW);
        assert_eq!(a, b);
    }
}
