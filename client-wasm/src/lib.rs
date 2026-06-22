use wasm_bindgen::prelude::*;

#[wasm_bindgen(start)]
pub fn main() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}

// Exports go here. Keep them thin: marshal at the boundary, delegate to game-core.
// All prediction logic lives in game-core, not here.
//
// Example pattern:
// #[wasm_bindgen]
// pub fn predict_move(state_json: &str, target_x: f32, target_y: f32) -> Result<String, JsValue> {
//     let state: PlayerState = serde_json::from_str(state_json)
//         .map_err(|e| JsValue::from_str(&e.to_string()))?;
//     let result = game_core::apply_move(&state, Vec2::new(target_x, target_y))
//         .map_err(|e| JsValue::from_str(&e))?;
//     serde_json::to_string(&result).map_err(|e| JsValue::from_str(&e.to_string()))
// }
