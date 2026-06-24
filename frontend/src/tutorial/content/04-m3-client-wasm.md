# Milestone 3 — The Prediction Bridge (`client-wasm`)

**Goal:** compile the *same* `game-core` movement rule into WebAssembly so the browser can run it
locally, and expose it to JavaScript through a tiny, dumb wrapper. This is the bridge that makes
client-side prediction possible.

**Where it fits:** `game-core` (M1) has the rule. The server (M2) runs it for truth. Now we run it in
the browser for *prediction*. Same code, three homes.

## What WebAssembly buys us here

WebAssembly (WASM)<sup>[1](https://developer.mozilla.org/en-US/docs/WebAssembly)</sup> is a compiled binary format the browser runs with fast, predictable performance —
typically within a small multiple of native, though "near-native" is an optimistic ceiling, not a
guarantee, and for tiny calls the cost of crossing the JS↔WASM boundary can eat the win. But raw speed
isn't really why we reach for it here (a hand-written JS movement function would be plenty fast). The
reason is determinism: the browser runs the *identical compiled rule* the server runs. `wasm-pack`
takes a Rust crate and produces a `.wasm` file plus JavaScript "glue" that lets you call exported Rust
functions from TypeScript. So we can take the `apply_move` we already wrote and tested, compile it to
WASM, and call it from the game loop. **The browser's prediction isn't a *reimplementation* of the
movement rule — it's the identical compiled rule.** That's the entire point, and it's why this crate
exists.

## The crate is deliberately tiny

Here is essentially the whole of `client-wasm/src/lib.rs`:

```rust
//! `client-wasm`: the thin prediction boundary. Marshals at the Rust↔JS seam (via
//! `serde-wasm-bindgen`) and delegates ALL logic to `game-core`. No game rules live here.

use game_core::{
    apply_move as core_apply_move, poc_map as core_poc_map, CharacterState, Millis, MoveInput,
    MOVE_QUEUE_CAP, STEP_MS,
};
use wasm_bindgen::prelude::*;

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
```

### How it works

This is the "marshaling boundary" pattern:

1. **Deserialize** the JavaScript objects into Rust types: `serde_wasm_bindgen::from_value(state)?`
   turns a plain JS object into a `CharacterState`. (This works because `CharacterState` derives
   `serde` — remember, every cross-boundary type does.)
2. **Delegate** to `game-core`: `core_apply_move(...)`. Not one line of game logic lives in this file.
   It imports the rule and calls it.
3. **Serialize** the result back to a JS object: `serde_wasm_bindgen::to_value(&next)?`.

The function is `pub fn` annotated with `#[wasm_bindgen]`<sup>[2](https://rustwasm.github.io/wasm-bindgen/)</sup>,
which is what makes it callable from JavaScript. The `serde_wasm_bindgen`<sup>[3](https://github.com/RReverser/serde-wasm-bindgen)</sup>
calls convert serde types to and from JS values. The signature speaks in `JsValue` (an opaque handle
to a JS value) at the edges and in real Rust types in the middle. **Marshal at the edge, delegate in the center, marshal back.** If this
file ever grows a `match` on directions or a walkability check, something has gone wrong — that logic
belongs in `game-core`.

### Sharing constants, not copying them

The crate also re-exports the shared constants so the browser never hard-codes them:

```rust
/// The shared step duration / drain cadence (ms/tile) ... Same value the server ticks at.
#[wasm_bindgen]
pub fn step_ms() -> u32 { STEP_MS as u32 }

/// The shared move-buffer capacity ...
#[wasm_bindgen]
pub fn move_queue_cap() -> u32 { MOVE_QUEUE_CAP as u32 }
```

`STEP_MS` and `MOVE_QUEUE_CAP` are defined once in `game-core`. The browser reads them through these
exports rather than writing `200` somewhere in TypeScript. If someone retunes the walk speed, all
three layers — server tick, browser drain, animation timing — move together because there's only one
number. The same goes for `poc_map()`: the browser asks the WASM module for the map so it's literally
the same bytes the server uses.

## Building it: the one flag that matters

```bash
wasm-pack build client-wasm --target bundler
```

The `--target bundler` flag is the non-obvious, important choice. `wasm-pack` can emit several output
shapes; `bundler` (the default) produces a standard ES module that a bundler like Vite imports as if it
were normal JavaScript — it tree-shakes it, and you don't need manual async-init boilerplate.<sup>[4](https://rustwasm.github.io/docs/wasm-pack/commands/build.html)</sup>
The alternative `--target web` produces output that needs you to manually `await` an init function and
fetch the `.wasm` yourself.

> **Honest caveat:** in this project the bundler output *still* requires two small Vite plugins
> (`vite-plugin-wasm` and `vite-plugin-top-level-await`) because of how the generated glue imports the
> `.wasm`. So "no extra plugins" is the goal more than the lived reality — but `bundler` is still the
> least-friction target for a Vite app, and the plugins are a one-time config.

## Async initialization

The crate has one more export — a startup hook that runs once when the module loads:

```rust
#[wasm_bindgen(start)]
pub fn main() {
    #[cfg(feature = "console_error_panic_hook")]
    console_error_panic_hook::set_once();
}
```

`#[wasm_bindgen(start)]` marks the function that runs automatically on init. Here it just installs a
panic hook so that if any Rust code *did* panic across the boundary, you'd get a readable error in the
browser console instead of a cryptic `unreachable`. (It does no game work — the logic still lives in
`game-core`.)

The reason this matters: WASM modules load **asynchronously** — the browser has to fetch and compile
the `.wasm` before any export is callable. So the very first thing the frontend does is `await` the
WASM init, and the game loop is **gated** on it being ready. You'll see that gate in the next chapter's
main loop: `if (!isWasmReady()) return;`. Calling an export before init resolves would throw. For now,
internalize the rule: **WASM is async; await it before you predict.**

## Common pitfalls

- **Putting logic in the wrapper.** The temptation is to "just add a quick check here" in Rust-that's-
  already-near-JS. Don't. The wrapper marshals; `game-core` decides.
- **Hard-coding `200` or the map in TypeScript.** Now you have two sources of truth for walk speed or
  collision, and they *will* drift. Import the constants and the map from WASM.
- **Calling an export before init resolves.** You'll get a cryptic error. Gate the loop on readiness.
- **Passing a fractional millisecond across the boundary.** `Millis` is a `u64`; a fractional JS number
  makes serde reject the whole value. (We floor it on the TS side — see the next chapter.)
- **Forgetting to rebuild WASM after a `game-core` change.** A change to the shared rule means *both*
  re-publishing the server *and* re-running `wasm-pack`. Miss the second and your prediction silently
  runs the old rule — the exact desync this architecture exists to prevent.

## Alternatives & the honest verdict

- **Reimplement movement in TypeScript for prediction.** This is what you'd do without WASM, and it's
  the single most tempting shortcut in the whole project — TypeScript is *right there*. It also
  guarantees eventual desync: two implementations of one rule drift the moment someone fixes a bug in
  only one. **Verdict: the WASM bridge exists precisely to make this shortcut unnecessary. Don't take
  it.** The cost of WASM (a build step, a marshaling layer) is the price of never debugging a
  prediction/truth mismatch.
- **No prediction at all** (wait for the server to confirm every move). Simpler — delete this whole
  crate. But at any real latency the character lags behind your keypress and the game feels broken.
  **Verdict: for a real-time feel, prediction is worth the WASM bridge.** For a turn-based-only game,
  you genuinely wouldn't need it — and indeed, *battles* in this project use no prediction at all for
  exactly that reason (Milestone 7).
- **`--target web` instead of `bundler`.** More manual wiring for no benefit in a bundled app.
  **Verdict: `bundler` is right for Vite.**

## Checkpoint

`wasm-pack build client-wasm --target bundler` produces a `client-wasm/pkg/` directory with a `.wasm`
file and a `.js`/`.d.ts` glue pair. You can't *see* anything yet — but you now hold, in the browser's
hands, the identical rule the server runs. Next we build the eyes, the hands, and the prediction loop
that ties it all together: the PixiJS frontend.

## References

1. MDN Web Docs — ["WebAssembly"](https://developer.mozilla.org/en-US/docs/WebAssembly). *(What WASM is, how it loads, and its performance characteristics.)*
2. The `wasm-bindgen` Guide — [rustwasm.github.io/wasm-bindgen](https://rustwasm.github.io/wasm-bindgen/). *(The `#[wasm_bindgen]` boundary, the `start` hook, exported functions.)*
3. `serde-wasm-bindgen` — [github.com/RReverser/serde-wasm-bindgen](https://github.com/RReverser/serde-wasm-bindgen). *(`from_value`/`to_value` marshaling of serde types across the JS boundary.)*
4. The `wasm-pack` Book — ["build" command](https://rustwasm.github.io/docs/wasm-pack/commands/build.html). *(The `--target bundler` output and why it's the default for bundlers.)*
