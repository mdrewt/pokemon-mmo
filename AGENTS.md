# AGENTS.md — monster-tamer-mmo

The authoritative agent + contributor instructions for this project live in
**[CLAUDE.md](CLAUDE.md)** (architecture, the "rules live once in `game-core`" rule, SpacetimeDB 2.6
specifics, the security model, conventions, and the full build/test chain) and **[ARCHITECTURE.md](ARCHITECTURE.md)**
(the durable design record). Read CLAUDE.md first — this file is just the quick lookup table.

## What this is

A 2D top-down, server-authoritative multiplayer monster-tamer: a SpacetimeDB 2.6 Rust module + a pure
shared `game-core` crate + a `client-wasm` movement-prediction build + a PixiJS v8 / TypeScript
frontend. Published database name: `monster-tamer-mmo`.

## Commands (full chain in CLAUDE.md → Build & Test)

- Build prediction WASM: `wasm-pack build client-wasm --target bundler`
- Publish server module: `spacetime publish -p server-module monster-tamer-mmo`
- Regenerate TS bindings after ANY schema change:
  `spacetime generate --lang typescript --out-dir frontend/src/module_bindings --module-path server-module`
- Rust: `cargo test --workspace` · `cargo clippy --all-targets` · `cargo fmt`
- Frontend (in `frontend/`): `vite` / `vite build` · `vitest` · `tsc --noEmit` · `eslint .`
- Local-only e2e (needs a running `spacetime`): `npm --prefix frontend run test:e2e`

## Non-negotiables (detail in CLAUDE.md)

- **Server-authoritative.** Never trust the client; identity is `ctx.sender`, never a client-passed
  field. The client sends *intent*; the server computes the outcome and validates every reducer.
- **Rules live once in `game-core`** — pure and deterministic (no clocks/RNG read directly). Never
  reimplement a rule in TS or a reducer; that's how prediction desyncs.
- A change to `game-core` means rebuilding the WASM client **and** republishing the server **and**
  regenerating bindings — flag that chain, don't edit one side silently.
- Before merge: relevant tests pass, `clippy` clean, `tsc` clean. If you can't verify a change, say so.
