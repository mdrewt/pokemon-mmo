---
name: game-core-testing
description: Writing tests for game-core, determinism tests, desync regression tests, or client-server prediction parity
---

# game-core Testing

`game-core` is the test center of gravity. It's pure and deterministic — no DB, no browser, no network needed. All game rule tests live here.

## Unit test template

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn player_cannot_move_beyond_max_distance() {
        let state = PlayerState { position: Vec2::ZERO, ..Default::default() };
        let input = MoveIntent { target: Vec2::new(9999.0, 0.0) };
        let result = apply_move(&state, input);
        assert!(result.is_err(), "expected rejection for out-of-range move");
    }
}
```

## Determinism tests

Same (state, input, seed) must always produce identical output. Test this explicitly:

```rust
#[test]
fn apply_move_is_deterministic() {
    let state = make_test_state();
    let input = make_test_input();
    let result_a = apply_move(&state, input.clone());
    let result_b = apply_move(&state, input.clone());
    assert_eq!(result_a, result_b);
}
```

For randomness, pass a seeded RNG:

```rust
use rand::SeedableRng;
use rand_chacha::ChaCha8Rng;

fn make_rng() -> ChaCha8Rng {
    ChaCha8Rng::seed_from_u64(42)
}
```

## Client-server prediction parity (desync regression)

The most valuable test type: assert that the `game-core` function called by the client predicts identically to the same function called by the server reducer.

```rust
#[test]
fn client_prediction_matches_server_result() {
    let state = make_test_state();
    let input = make_test_input();
    let seed = 12345u64;
    let timestamp = 0u64;

    // Both sides call the same game-core function — any divergence here is a desync bug
    let server_result = apply_game_rule(&state, input.clone(), seed, timestamp);
    let client_result = apply_game_rule(&state, input.clone(), seed, timestamp);

    assert_eq!(server_result, client_result,
        "client prediction diverged from server result — desync bug");
}
```

Add a parity test whenever you add a new game rule. This is your desync regression net.

## Test helpers

Keep test fixtures close to the tests. Prefer explicit construction over defaults so test failures are readable:

```rust
fn make_test_state() -> GameState {
    GameState {
        player_position: Vec2::new(10.0, 10.0),
        health: 100,
        last_action_tick: 0,
        // ... explicit values, not ..Default::default() unless defaults are meaningful here
    }
}
```

## Running tests

```
cargo test -p game-core          # just game-core
cargo test --workspace           # everything
cargo test -- --nocapture        # see println! output
```

## When to push logic into game-core

If you find yourself writing the same rule in both a reducer (`server-module/`) and a TS function (`frontend/`), that's the wrong pattern. Extract it to `game-core` so it's tested once and shared.

Signal: if you can't write a `game-core` unit test for a rule, the rule is probably in the wrong place.
