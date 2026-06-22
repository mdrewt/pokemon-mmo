---
name: wasm-boundary
description: Working on client-wasm, wasm-bindgen exports, the WASM↔TypeScript interface, async WASM init, or batching state across the JS/Rust boundary
---

# WASM Boundary (client-wasm ↔ TypeScript)

> Fetch current wasm-bindgen docs from `gitmcp-wasm-bindgen` MCP before touching generated `.d.ts` files or export signatures.

## Key constraint: `client-wasm` wraps `game-core`

`client-wasm` is a thin shell. All prediction logic lives in `game-core`. The boundary exports:
1. Pass JS input → marshal → call `game-core` → marshal result back to JS
2. No business logic at the boundary — no rules duplicated here

```rust
// client-wasm/src/lib.rs
use wasm_bindgen::prelude::*;
use game_core::apply_move;

#[wasm_bindgen]
pub fn predict_move(state_json: &str, target_x: f32, target_y: f32) -> Result<String, JsValue> {
    let state: PlayerState = serde_json::from_str(state_json)
        .map_err(|e| JsValue::from_str(&e.to_string()))?;
    let input = MoveIntent { target: Vec2::new(target_x, target_y) };
    let result = apply_move(&state, input)
        .map_err(|e| JsValue::from_str(&e))?;
    serde_json::to_string(&result)
        .map_err(|e| JsValue::from_str(&e.to_string()))
}
```

## Async init — gate the game loop

WASM init is async. Gate everything on it:

```typescript
import init, { predict_move } from '../client-wasm/pkg/client_wasm';

let wasmReady = false;

async function initWasm() {
    await init();
    wasmReady = true;
    startGameLoop();
}

function startGameLoop() {
    if (!wasmReady) return; // never runs before init completes
    requestAnimationFrame(tick);
}
```

Never call exported WASM functions before `await init()` resolves — they will throw.

## Build target

```
wasm-pack build client-wasm --target bundler
```

Use `bundler` (not `web`). Vite then imports `client-wasm/pkg/` as a normal ES module, tree-shakes it, and handles the WASM binary automatically. No `wasm-plugin` or manual async plumbing needed in the Vite config.

## Minimize boundary crossings

The JS↔WASM call overhead is real. Design exports to transfer state in batches, not per-entity:

```rust
// BAD: called once per entity per frame
#[wasm_bindgen]
pub fn update_entity(id: u32, x: f32, y: f32) -> /* ... */ { }

// GOOD: one call transfers all entity state
#[wasm_bindgen]
pub fn update_all_entities(packed_state: &[f32]) -> Vec<f32> { }
```

Prefer packed flat arrays (`&[f32]`, `Vec<u8>`) over per-entity calls. Minimize JSON crossing the boundary on the hot path.

## Panics

A Rust panic at the WASM boundary becomes an uncatchable JS exception and crashes the game loop. In `client-wasm` exports, return `Result<_, JsValue>` for all fallible operations — let `?` propagate rather than unwrapping.

Enable the panic hook in dev builds to get useful stack traces:

```rust
#[wasm_bindgen(start)]
pub fn main() {
    #[cfg(debug_assertions)]
    console_error_panic_hook::set_once();
}
```

Add to `client-wasm/Cargo.toml`:
```toml
[dependencies]
console-error-panic-hook = { version = "0.1", optional = true }

[features]
default = ["console-error-panic-hook"]
```

## After changes to client-wasm exports

1. Rebuild: `wasm-pack build client-wasm --target bundler`
2. Check generated `.d.ts` in `client-wasm/pkg/` — Vite picks this up automatically
3. Update calling TS code to match new signature
4. Run `tsc --noEmit` to catch type mismatches before runtime
