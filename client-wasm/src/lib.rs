//! `client-wasm`: the thin prediction boundary. Marshals at the Rust↔JS seam (via
//! `serde-wasm-bindgen`) and delegates ALL logic to `game-core`. No game rules live here.
//!
//! The client predicts movement by running the SAME `game_core::resolve_input` the server runs
//! for authority, with the SAME `game_core::STEP_MS` — so prediction can never diverge from
//! truth. `client-wasm` does NOT enable game-core's `spacetimedb` feature; it stays pure.

use game_core::{
    poc_map as core_poc_map, resolve_input, CharacterState, Millis, MoveInput, STEP_MS,
};
use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn main() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Predict the result of applying one input locally. Takes a `CharacterState` and a `MoveInput`
/// (serde-shaped JS objects) and `now` in milliseconds, runs `game_core::resolve_input` against
/// the shared map and cooldown, and returns the resulting `CharacterState`.
///
/// Mirrors the server's `submit_input` exactly. An `Err` (e.g. cooldown not elapsed) is returned
/// as a JS exception string; the caller treats it the same way the server does — no state change.
#[wasm_bindgen]
pub fn predict_input(state: JsValue, input: JsValue, now: f64) -> Result<JsValue, JsValue> {
    // `now` is milliseconds (fits f64 exactly); avoids forcing BigInt on the JS caller.
    let state: CharacterState = serde_wasm_bindgen::from_value(state)?;
    let input: MoveInput = serde_wasm_bindgen::from_value(input)?;
    let next = resolve_input(
        &state,
        input,
        &core_poc_map(),
        Millis(now.max(0.0) as u64),
        STEP_MS,
    )
    .map_err(|e| JsValue::from_str(&format!("rejected input: {e:?}")))?;
    Ok(serde_wasm_bindgen::to_value(&next)?)
}

/// The POC map (walkability grid + dimensions) for the renderer. Identical bytes to the server's
/// `game_core::poc_map()`.
#[wasm_bindgen]
pub fn poc_map() -> Result<JsValue, JsValue> {
    Ok(serde_wasm_bindgen::to_value(&core_poc_map())?)
}

/// The shared movement cooldown (ms/tile). The client uses this to pace input and time the
/// step-slide animation; it is the same value the server enforces.
#[wasm_bindgen]
pub fn step_ms() -> u32 {
    STEP_MS as u32
}
