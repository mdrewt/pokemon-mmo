# Contributing

A short operating guide. The deeper design rationale is in [ARCHITECTURE.md](ARCHITECTURE.md); reference
material (schema, reducers, systems, frontend) is in [docs/](docs/); agent-specific conventions are in
[CLAUDE.md](CLAUDE.md).

## The one rule that matters most

**Every game rule lives once, in `game-core`.** The server runs it for truth; the client runs the *same
compiled code* (via `client-wasm`) for movement prediction. Reimplementing a rule in TypeScript or
hand-rolling it in a reducer desyncs prediction from truth. If you need a new rule, add a pure function
to `game-core` (with a test), then call it from the server (and the predictor, if it's movement).

`game-core` stays pure: no I/O, no clocks read directly, no randomness except a seeded source passed in.
That determinism is what keeps client prediction matching server truth.

## Setup & dev loop

See [README.md → Develop](README.md#develop). In short: `spacetime start` (separate terminal), then
`npm run build:wasm` + `npm run build:server` (publish + generate bindings) + `npm run dev:client`.
`spacetime dev` auto-rebuilds/republishes/regenerates on change.

**The two-WASM / bindings chain.** There are *two* WASM builds: the server module (`spacetime publish`)
and the browser movement predictor (`wasm-pack build client-wasm --target bundler`) — don't conflate
them. A `game-core` change can ripple to **both**, plus the TS bindings. After any schema change,
regenerate and **commit** the bindings (`npm run gen` → `frontend/src/module_bindings/`); CI has no
`spacetime` CLI and builds the frontend against the committed bindings. An incompatible schema change
needs `spacetime publish … --delete-data --yes` (local dev data is disposable).

## The gate order

Run these before opening a PR — in order:

```sh
npm run check     # cargo fmt --check + clippy -D warnings + tsc --noEmit + eslint
npm test          # cargo test --workspace + frontend vitest
npm run test:e2e  # Playwright two-window suite — LOCAL ONLY (needs `spacetime start`)
```

The Rust and frontend suites run in CI. **The e2e is a local gate** — CI has no `spacetime` CLI, so it
cannot publish the module; run it locally before merging anything that touches a reducer→UI flow.
`game-core` is the test center of gravity: prefer a pure unit test there over an integration test.

## Reviews

Each milestone ships as **one PR** through the review gates:

- **`reducer-security-auditor`** — for any reducer/table/schema change. The client is hostile: the server
  validates everything, identity comes from `ctx.sender`, secrets live in private/RLS-scoped tables.
- **`desync-guard`** — for any `game-core` change or its wasm/reducer wrappers: confirms no rule is
  reimplemented in TS or the server module, and that prediction parity holds.
- **`/simplify`** then **`/code-review`** — quality + correctness.

## Conventions

- **Rust:** `cargo clippy` clean (warnings are errors in CI), `cargo fmt` before proposing changes.
  Prefer `Result` over panics anywhere reachable from a reducer or the WASM boundary.
- **TypeScript:** strict mode; no `any` without a justifying comment. Keep rendering (Pixi) separate from
  state — Pixi draws a view of state, it does not own it. Pool and mutate display objects; don't recreate
  them per frame.
- **Match the style of the file you're editing**; keep diffs minimal and focused.
- **Document as you go.** When you change a rule, table, or reducer, update the relevant inline comment
  and the affected reference in [docs/](docs/) (schema, reducers, systems). Record new latent issues in
  [docs/known-issues.md](docs/known-issues.md).
