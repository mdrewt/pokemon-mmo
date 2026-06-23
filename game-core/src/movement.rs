//! THE movement rule — the single source of truth for how a character moves.
//!
//! Run by the server (authoritative) AND the client (prediction, via client-wasm). It must
//! stay pure and deterministic: same `(state, input, map, now, step_ms)` ⇒ same output. This
//! identity is what makes client prediction match server truth. Never reimplement any of this
//! in TypeScript or in a reducer — call it.

use crate::map::TileMap;
use crate::types::{ActionState, CharacterState, Millis, MoveError, MoveInput};

/// The default movement cooldown in milliseconds (one tile per `STEP_MS`). Shared by the server
/// (authority) and the client (prediction) so the cooldown can never diverge — both pass this
/// into [`resolve_input`] as `step_ms`.
pub const STEP_MS: u64 = 200;

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
    // Rate limit: at most one accepted action per `step_ms`. The server checks this against
    // authoritative time; honest clients gate input on animation completion so they don't trip it.
    if now.0.saturating_sub(state.move_started_at.0) < step_ms {
        return Err(MoveError::TooSoon);
    }

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
                // Bump: face the obstacle, stay put. A legal no-op (not an error).
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

    Ok(next)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{Direction, TilePos};
    // STEP_MS comes from `super::*` (the production constant) — tests track any retune.

    fn state_at(pos: TilePos, facing: Direction) -> CharacterState {
        CharacterState {
            pos,
            facing,
            action: ActionState::Idle,
            // Old enough that the cooldown never blocks unless a test sets `now` close to it.
            move_started_at: Millis(0),
        }
    }

    fn open_5x5() -> TileMap {
        TileMap::from_rows(&[".....", ".....", ".....", ".....", "....."])
    }

    #[test]
    fn step_into_open_tile_moves_and_faces() {
        let map = open_5x5();
        let s = state_at(TilePos { x: 1, y: 1 }, Direction::North);
        let out = resolve_input(
            &s,
            MoveInput::Step(Direction::East),
            &map,
            Millis(STEP_MS),
            STEP_MS,
        )
        .unwrap();
        assert_eq!(out.pos, TilePos { x: 2, y: 1 });
        assert_eq!(out.facing, Direction::East);
        assert_eq!(out.action, ActionState::Walking);
        assert_eq!(out.move_started_at, Millis(STEP_MS));
    }

    #[test]
    fn step_into_wall_bumps_but_still_turns() {
        let map = TileMap::from_rows(&[".....", ".....", "..#..", ".....", "....."]);
        // At (2,1) facing North; stepping South targets (2,2) which is a wall.
        let s = state_at(TilePos { x: 2, y: 1 }, Direction::North);
        let out = resolve_input(
            &s,
            MoveInput::Step(Direction::South),
            &map,
            Millis(STEP_MS),
            STEP_MS,
        )
        .unwrap();
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
        let out = resolve_input(
            &s,
            MoveInput::Step(Direction::North),
            &map,
            Millis(STEP_MS),
            STEP_MS,
        )
        .unwrap();
        assert_eq!(out.pos, TilePos { x: 0, y: 0 });
        assert_eq!(out.action, ActionState::Idle);
    }

    #[test]
    fn jump_into_open_tile_hops_forward() {
        let map = open_5x5();
        let s = state_at(TilePos { x: 1, y: 1 }, Direction::East);
        let out = resolve_input(&s, MoveInput::Jump, &map, Millis(STEP_MS), STEP_MS).unwrap();
        assert_eq!(out.pos, TilePos { x: 2, y: 1 });
        assert_eq!(out.action, ActionState::Jumping);
    }

    #[test]
    fn jump_into_wall_hops_in_place() {
        let map = TileMap::from_rows(&[".....", ".....", "..#..", ".....", "....."]);
        let s = state_at(TilePos { x: 2, y: 1 }, Direction::South); // facing the wall at (2,2)
        let out = resolve_input(&s, MoveInput::Jump, &map, Millis(STEP_MS), STEP_MS).unwrap();
        assert_eq!(out.pos, TilePos { x: 2, y: 1 }, "hopped in place");
        assert_eq!(out.action, ActionState::Jumping);
    }

    #[test]
    fn cooldown_rejects_before_step_ms_elapses() {
        let map = open_5x5();
        let mut s = state_at(TilePos { x: 1, y: 1 }, Direction::East);
        s.move_started_at = Millis(1000);
        let err = resolve_input(
            &s,
            MoveInput::Step(Direction::East),
            &map,
            Millis(1100),
            STEP_MS,
        )
        .unwrap_err();
        assert_eq!(err, MoveError::TooSoon);
    }

    #[test]
    fn cooldown_allows_exactly_at_step_ms() {
        let map = open_5x5();
        let mut s = state_at(TilePos { x: 1, y: 1 }, Direction::East);
        s.move_started_at = Millis(1000);
        let out = resolve_input(
            &s,
            MoveInput::Step(Direction::East),
            &map,
            Millis(1200),
            STEP_MS,
        )
        .unwrap();
        assert_eq!(out.pos, TilePos { x: 2, y: 1 });
    }

    #[test]
    fn deterministic_same_inputs_same_output() {
        let map = open_5x5();
        let s = state_at(TilePos { x: 2, y: 2 }, Direction::North);
        let a = resolve_input(
            &s,
            MoveInput::Step(Direction::West),
            &map,
            Millis(STEP_MS),
            STEP_MS,
        );
        let b = resolve_input(
            &s,
            MoveInput::Step(Direction::West),
            &map,
            Millis(STEP_MS),
            STEP_MS,
        );
        assert_eq!(a, b);
    }
}
