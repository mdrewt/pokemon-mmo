//! `client-wasm`: the thin prediction boundary. Marshals at the Rust↔JS seam (via
//! `serde-wasm-bindgen`) and delegates ALL logic to `game-core`. No game rules live here.
//!
//! Signatures are frozen in M0; bodies land in M3. `client-wasm` does NOT enable game-core's
//! `spacetimedb` feature — it stays pure.

use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn main() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

/// Predict the result of applying one input locally. Deserializes a `CharacterState` and
/// `MoveInput`, runs `game_core::resolve_input`, and serializes the resulting `CharacterState`.
/// `now` is milliseconds (see `game_core::Millis`).
#[wasm_bindgen]
pub fn predict_input(state: JsValue, input: JsValue, now: u64) -> Result<JsValue, JsValue> {
    let _ = (state, input, now);
    todo!("M3: serde_wasm_bindgen marshal → game_core::resolve_input → marshal back")
}

/// Return the POC map (walkability grid + dimensions) for client rendering and prediction.
#[wasm_bindgen]
pub fn poc_map() -> Result<JsValue, JsValue> {
    todo!("M3: serialize game_core::poc_map()")
}
