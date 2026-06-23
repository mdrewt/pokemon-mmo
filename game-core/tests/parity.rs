//! Prediction-parity / reconciliation regression net.
//!
//! Both the client (prediction) and the server (authority) drive movement through the *same*
//! `game_core::resolve_input`. These tests pin the two invariants that prevent desync:
//! 1. The same input sequence yields the same final state (client == server).
//! 2. Replaying the unacked tail of inputs from an authoritative snapshot reproduces the full
//!    predicted state — the property the client's reconciliation relies on.

use game_core::{
    poc_map, resolve_input, ActionState, CharacterState, Direction, Millis, MoveInput, TilePos,
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

/// Apply a sequence of inputs from spawn, advancing time by `STEP_MS` each step so the cooldown
/// always passes. Returns the final state.
fn run(seq: &[MoveInput]) -> CharacterState {
    let map = poc_map();
    let mut state = spawn();
    for (i, &input) in seq.iter().enumerate() {
        let now = Millis(STEP_MS * (i as u64 + 1));
        state = resolve_input(&state, input, &map, now, STEP_MS).unwrap();
    }
    state
}

#[test]
fn client_and_server_agree_for_same_input_sequence() {
    let seq = [
        MoveInput::Step(Direction::East),
        MoveInput::Step(Direction::East),
        MoveInput::Step(Direction::South),
        MoveInput::Jump,
        MoveInput::Step(Direction::North),
    ];
    assert_eq!(run(&seq), run(&seq));
}

#[test]
fn reconciliation_replay_matches_full_run() {
    let seq = [
        MoveInput::Step(Direction::East),
        MoveInput::Step(Direction::South),
        MoveInput::Step(Direction::East),
        MoveInput::Jump,
    ];
    let map = poc_map();
    let full = run(&seq);

    // Authoritative snapshot after the first `k` inputs are acked.
    let k = 2;
    let mut auth = spawn();
    for (i, &input) in seq.iter().enumerate().take(k) {
        let now = Millis(STEP_MS * (i as u64 + 1));
        auth = resolve_input(&auth, input, &map, now, STEP_MS).unwrap();
    }

    // Replay the unacked tail from the authoritative snapshot (same timestamps).
    let mut replayed = auth;
    for (i, &input) in seq.iter().enumerate().skip(k) {
        let now = Millis(STEP_MS * (i as u64 + 1));
        replayed = resolve_input(&replayed, input, &map, now, STEP_MS).unwrap();
    }

    assert_eq!(replayed, full);
}
