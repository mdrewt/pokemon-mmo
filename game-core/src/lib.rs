// game-core: pure, deterministic game logic.
// No wasm-bindgen, no spacetimedb, no I/O, no std clocks.
// Pass time and randomness as arguments so this stays testable and deterministic.

#[cfg(test)]
mod tests {
    #[test]
    fn placeholder() {
        // Replace with real game rule tests as logic is added.
        // Pattern: assert_eq!(apply_rule(&state, input, seed), expected_output)
    }
}
