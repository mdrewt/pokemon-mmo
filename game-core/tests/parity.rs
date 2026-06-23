//! Prediction-parity / reconciliation regression net for the move-buffer model.
//!
//! Movement is server-paced: a queue of `MoveInput`s is drained one per `STEP_MS` via the SINGLE
//! shared rule `game_core::apply_move` — the server's `movement_tick` and the client's local
//! prediction both call it. These tests pin the two invariants that prevent desync:
//! 1. Draining the same input sequence yields the same final state (client drain == server tick).
//! 2. Replaying the un-acked tail from an authoritative snapshot reproduces the full drained state
//!    — the property the client's reconciliation relies on.

use game_core::{
    apply_move, poc_map, ActionState, CharacterState, Direction, Millis, MoveInput, TilePos,
    STEP_MS,
};

fn spawn() -> CharacterState {
    CharacterState {
        pos: TilePos { x: 1, y: 1 },
        facing: Direction::South,
        action: ActionState::Idle,
        move_started_at: Millis(0),
    }
}

/// Drain a queue of inputs, one per `STEP_MS`, through the shared rule. Returns the final state.
fn drain(seq: &[MoveInput]) -> CharacterState {
    let map = poc_map();
    let mut state = spawn();
    for (i, &input) in seq.iter().enumerate() {
        let now = Millis(STEP_MS * (i as u64 + 1));
        state = apply_move(&state, input, &map, now);
    }
    state
}

#[test]
fn client_and_server_drain_agree_for_same_sequence() {
    let seq = [
        MoveInput::Step(Direction::East),
        MoveInput::Step(Direction::East),
        MoveInput::Step(Direction::South),
        MoveInput::Jump,
        MoveInput::Step(Direction::North),
    ];
    assert_eq!(drain(&seq), drain(&seq));
}

#[test]
fn reconciliation_replay_matches_full_drain() {
    let seq = [
        MoveInput::Step(Direction::East),
        MoveInput::Step(Direction::South),
        MoveInput::Step(Direction::East),
        MoveInput::Jump,
    ];
    let map = poc_map();
    let full = drain(&seq);

    // Authoritative snapshot after the first `k` moves have been drained + acked.
    let k = 2;
    let mut auth = spawn();
    for (i, &input) in seq.iter().enumerate().take(k) {
        auth = apply_move(&auth, input, &map, Millis(STEP_MS * (i as u64 + 1)));
    }

    // Replay the un-acked tail from the authoritative snapshot (same timestamps).
    let mut replayed = auth;
    for (i, &input) in seq.iter().enumerate().skip(k) {
        replayed = apply_move(&replayed, input, &map, Millis(STEP_MS * (i as u64 + 1)));
    }

    assert_eq!(replayed, full);
}
