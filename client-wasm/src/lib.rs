//! `client-wasm`: the thin prediction boundary. Marshals at the Rust↔JS seam (via
//! `serde-wasm-bindgen`) and delegates ALL logic to `game-core`. No game rules live here.
//!
//! The client predicts movement by draining its move queue through the SAME
//! `game_core::apply_move` the server's `movement_tick` runs for authority, at the SAME
//! `game_core::STEP_MS` cadence and within the SAME `MOVE_QUEUE_CAP` — so prediction can never
//! diverge from truth. `client-wasm` does NOT enable game-core's `spacetimedb` feature.

use game_core::{
    apply_move as core_apply_move, poc_map as core_poc_map, CharacterState, Millis, MoveInput,
    MOVE_QUEUE_CAP, STEP_MS,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn main() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Apply one (already-due) queued move locally, mirroring the server's drain. Takes a
/// `CharacterState` and a `MoveInput` (serde-shaped JS objects) and `now` in milliseconds, runs
/// `game_core::apply_move` against the shared map, and returns the resulting `CharacterState`.
/// Never rejects — a blocked move is a legal in-place no-op, exactly as on the server.
#[wasm_bindgen]
pub fn apply_move(state: JsValue, input: JsValue, now: f64) -> Result<JsValue, JsValue> {
    // `now` is milliseconds (fits f64 exactly); avoids forcing BigInt on the JS caller.
    let state: CharacterState = serde_wasm_bindgen::from_value(state)?;
    let input: MoveInput = serde_wasm_bindgen::from_value(input)?;
    let next = core_apply_move(&state, input, &core_poc_map(), Millis(now.max(0.0) as u64));
    Ok(serde_wasm_bindgen::to_value(&next)?)
}

/// The POC map (walkability grid + dimensions) for the renderer. Identical bytes to the server's
/// `game_core::poc_map()`.
#[wasm_bindgen]
pub fn poc_map() -> Result<JsValue, JsValue> {
    Ok(serde_wasm_bindgen::to_value(&core_poc_map())?)
}

/// The shared step duration / drain cadence (ms/tile) — used to pace the local drain and time the
/// step-slide animation. Same value the server ticks at.
#[wasm_bindgen]
pub fn step_ms() -> u32 {
    STEP_MS as u32
}

/// The shared move-buffer capacity. The client's flow control sends an enqueue only while
/// `(queue depth + in-flight) < move_queue_cap()`, so the server never rejects for a full queue.
#[wasm_bindgen]
pub fn move_queue_cap() -> u32 {
    MOVE_QUEUE_CAP as u32
}
