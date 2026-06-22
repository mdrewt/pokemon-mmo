//! Pure NPC decision logic (server-only at runtime; the client never predicts NPCs — it
//! interpolates their subscribed positions).

use serde::{Deserialize, Serialize};

use crate::map::TileMap;
use crate::types::{CharacterState, Direction, MoveInput, TilePos};

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
    let start = (roll % 4) as usize;
    // Prefer a direction that is walkable AND keeps the NPC within `wander_radius` (Chebyshev).
    for i in 0..4 {
        let dir = Direction::ALL[(start + i) % 4];
        let target = state.pos.step(dir);
        if map.is_walkable(target) && target.chebyshev(params.home) <= params.wander_radius {
            return MoveInput::Step(dir);
        }
    }
    // No valid move (boxed in, or the only open tiles are out of radius). Idle by facing a
    // *blocked* tile so `resolve_input` produces a no-op — never step out of the radius.
    for i in 0..4 {
        let dir = Direction::ALL[(start + i) % 4];
        if !map.is_walkable(state.pos.step(dir)) {
            return MoveInput::Step(dir);
        }
    }
    // Degenerate: every neighbor is walkable but out of radius. Unreachable for an in-radius NPC
    // with radius >= 1 (the toward-home neighbor is always in radius), but stay safe regardless.
    MoveInput::Step(Direction::ALL[start])
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::types::{ActionState, CharacterState, Millis, TilePos};

    fn npc_at(pos: TilePos) -> CharacterState {
        CharacterState {
            pos,
            facing: Direction::North,
            action: ActionState::Idle,
            move_started_at: Millis(0),
        }
    }

    #[test]
    fn deterministic_same_roll_same_choice() {
        let map = TileMap::from_rows(&[".....", ".....", ".....", ".....", "....."]);
        let params = NpcParams {
            home: TilePos { x: 2, y: 2 },
            wander_radius: 2,
        };
        let s = npc_at(TilePos { x: 2, y: 2 });
        assert_eq!(
            npc_decide(&params, &s, &map, 7),
            npc_decide(&params, &s, &map, 7)
        );
    }

    #[test]
    fn roll_selects_starting_direction() {
        let map = TileMap::from_rows(&[".....", ".....", ".....", ".....", "....."]);
        let params = NpcParams {
            home: TilePos { x: 2, y: 2 },
            wander_radius: 2,
        };
        let s = npc_at(TilePos { x: 2, y: 2 });
        // ALL order is [North, South, East, West]; roll % 4 picks the start.
        assert_eq!(
            npc_decide(&params, &s, &map, 0),
            MoveInput::Step(Direction::North)
        );
        assert_eq!(
            npc_decide(&params, &s, &map, 1),
            MoveInput::Step(Direction::South)
        );
    }

    #[test]
    fn skips_blocked_direction() {
        // Wall directly North of the NPC at (2,2) → it falls through to South.
        let map = TileMap::from_rows(&[".....", "..#..", ".....", ".....", "....."]);
        let params = NpcParams {
            home: TilePos { x: 2, y: 2 },
            wander_radius: 2,
        };
        let s = npc_at(TilePos { x: 2, y: 2 });
        assert_eq!(
            npc_decide(&params, &s, &map, 0),
            MoveInput::Step(Direction::South)
        );
    }

    #[test]
    fn boxed_in_npc_idles_without_leaving_radius() {
        use crate::{resolve_input, Millis};
        // NPC at (2,2) with all four neighbors walled; the only open tiles are diagonal (and
        // unreachable by a cardinal step). It must idle in place, not escape its radius.
        let map = TileMap::from_rows(&[".....", "..#..", ".#.#.", "..#..", "....."]);
        let params = NpcParams {
            home: TilePos { x: 2, y: 2 },
            wander_radius: 1,
        };
        let s = npc_at(TilePos { x: 2, y: 2 });
        let decision = npc_decide(&params, &s, &map, 0);
        // Whatever direction it faces, applying it must not move the NPC.
        let after = resolve_input(&s, decision, &map, Millis(1000), 200).unwrap();
        assert_eq!(after.pos, TilePos { x: 2, y: 2 }, "must idle in place");
    }

    #[test]
    fn respects_wander_radius() {
        // NPC at (3,2), home (2,2), radius 1. Stepping East → (4,2) is distance 2 (too far), so a
        // roll starting at East must fall through to West (→ (2,2), distance 0).
        let map = TileMap::from_rows(&[".....", ".....", ".....", ".....", "....."]);
        let params = NpcParams {
            home: TilePos { x: 2, y: 2 },
            wander_radius: 1,
        };
        let s = npc_at(TilePos { x: 3, y: 2 });
        let out = npc_decide(&params, &s, &map, 2); // start = East
        assert_eq!(out, MoveInput::Step(Direction::West));
    }
}
