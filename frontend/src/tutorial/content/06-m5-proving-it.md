# Milestone 5 — Proving It Stays in Sync

**Goal:** make "two players see the same world" a thing a machine checks, not a thing you eyeball.
Build an automated two-window test and a CI pipeline that guards every layer.

**Where it fits:** M0–M4 produced a working prototype. M5 makes it *trustworthy*. From here on, every
change runs a gauntlet that would catch a regression in movement, prediction, or sync before it ships.

## The build & test command chain

First, get fluent in the commands, because the *order* encodes a dependency. The project's root
`package.json` wires them up:

```json
"scripts": {
  "build:wasm":   "wasm-pack build client-wasm --target bundler",
  "publish":      "spacetime publish -p server-module -s local monster-tamer-mmo",
  "gen":          "spacetime generate --lang typescript --out-dir frontend/src/module_bindings --module-path server-module",
  "build:server": "npm run publish && npm run gen",
  "build":        "npm run build:wasm && npm run build:server && npm --prefix frontend run build",
  "check":        "cargo fmt --all --check && cargo clippy --all-targets --all-features -- -D warnings && npm --prefix frontend run typecheck && npm --prefix frontend run lint",
  "test":         "cargo test --workspace && npm --prefix frontend exec -- vitest run --root frontend --passWithNoTests",
  "test:e2e":     "npm --prefix frontend run test:e2e"
}
```

The chain that bites newcomers: **a change to `game-core` requires three rebuilds** — `build:wasm`
(so the browser runs the new rule), `publish` (so the server runs it), and `gen` (so the TS bindings
match any schema change). `build:server` bundles the last two so you can't do one without the other.
During development, `spacetime dev` watches and re-runs this for you.

> Internalize this: `game-core` is consumed by both the WASM client and the server. Editing it and
> rebuilding only one side is the canonical way to create a desync. The scripts exist to make the full
> chain the default.

## The two-window test

The headline guarantee — *two players see a consistent world* — gets a Playwright<sup>[1](https://playwright.dev/)</sup>
test that drives **two real browser windows** against one authoritative server. Its header lays out the
coverage:

```typescript
// M5: two-window integration test. Two browser contexts join the same authoritative world and we
// assert end-to-end behaviour against canonical state via the dev-only `window.__game` hook
// ... Covered: both windows connect and see each other + the NPC; movement syncs both directions
// (A->B and B->A); jump advances a tile; an obstacle bump is rejected with no desync (predicted ==
// authoritative); prediction converges to authority; the NPC wanders; a disconnect despawns the
// character in the other window.
```

### How it works, and one important choice

The test does **not** read canvas pixels. Pixel-testing a WebGL renderer is brittle and tells you
nothing about correctness. Instead, the frontend exposes a **dev-only introspection hook** —
`window.__game()` — that returns a plain-data snapshot of the store: who's where, predicted vs.
authoritative, the NPC, and so on. The test reads *state*, asserts on *state*.

A few details that make it robust:

- **It reads `STEP_MS` from the hook**, never hard-codes `200`. The cadence has one source of truth
  (`game-core`); the test honors that too.
- **Spawn tiles are random**, so the test reads each character's actual tile from the snapshot and
  moves *relative* to it, rather than assuming a fixed start.
- **A global setup republishes the module with `--delete-data`**, so every run starts from a known
  world: one NPC, zero players. The two joins make it `{1 NPC, 2 players}`. Deterministic preconditions
  make for deterministic tests.

The single most valuable assertion is the desync check: after a bump into an obstacle, the test asserts
**predicted position equals authoritative position**. That one line is the regression net for the
entire prediction/reconciliation architecture. If anyone ever breaks the "rules written once"
guarantee, this turns red.

## Continuous Integration

CI runs on every pull request and every push to `main`, in two jobs (GitHub Actions<sup>[3](https://docs.github.com/en/actions)</sup>).

### Job 1 — Rust

```yaml
- name: Format check
  run: cargo fmt --all --check
- name: Clippy (deny warnings)
  run: cargo clippy --all-targets --all-features -- -D warnings
- name: Test
  run: cargo test --workspace
- name: Build client-wasm
  run: wasm-pack build client-wasm --target bundler
```

Note `cargo clippy ... -- -D warnings`: **every warning is an error.**<sup>[4](https://doc.rust-lang.org/clippy/usage.html)</sup>
This is what gives the `clippy.toml` determinism guard from Milestone 0 its teeth — a wall-clock read
isn't a warning to ignore, it fails CI. The job then builds the WASM and **uploads it as an artifact** so the frontend job
can reuse it instead of rebuilding Rust.

### Job 2 — Frontend

```yaml
- name: Restore client-wasm pkg     # download the artifact from the rust job
- name: Typecheck
  run: npx tsc --noEmit
- name: Lint
  run: npx eslint .
- name: Test
  run: npx vitest run
- name: Build
  run: npx vite build
```

The frontend job depends on the Rust job (`needs: rust`) and pulls the built WASM artifact — so the
frontend typechecks and tests against the *actual* compiled `client-wasm`, not a stub.

### The deliberate gap: e2e is local-only

The Playwright two-window test is **not** in CI. Why? Because it needs a running `spacetime` server to
publish the module against, and the CI runners don't have the `spacetime` CLI installed. So the e2e is
a **local gate** — you run `npm run test:e2e` (with a local node up) before you merge. CI covers
everything that can run hermetically; the e2e covers the full integration locally. It's an honest
trade-off: the most realistic test is also the one that's hardest to host in CI, so it lives where it
can actually run.

## Common pitfalls

- **Editing `game-core` and only rebuilding one side.** The fastest route to a desync. Run the whole
  chain (or use `spacetime dev`).
- **Pixel-testing the renderer.** Brittle and uninformative. Assert on state, not pixels.
- **Hard-coding spawn positions or `STEP_MS` in tests.** Both have authoritative sources; read them.
- **Treating clippy warnings as advisory.** With `-D warnings` they fail the build — by design.
- **Assuming CI runs the e2e.** It can't. Run it locally before merging.

## Alternatives & the honest verdict

- **A single-window unit test of the predictor instead of a two-window e2e.** The project has *both*:
  fast `vitest`<sup>[2](https://vitest.dev/)</sup> unit tests for the predictor's reconcile logic (which
  run in CI), and the heavyweight two-window test (local). **Verdict: you want both layers.** Unit tests
  catch logic bugs cheaply and in CI; the e2e catches integration/timing bugs the unit tests can't see.
- **Installing `spacetime` in CI to run the e2e there.** Possible, and arguably better — it'd make the
  strongest test a merge gate. The project chose not to, to keep CI simple and fast. **Verdict: this is
  a fair place to disagree; running the e2e in CI would genuinely raise the safety bar at the cost of
  CI complexity.** A team that's been burned by an integration regression should consider it.
- **Snapshot/pixel testing.** Rejected for good reason (brittle). **Verdict: state assertions win.**

## Checkpoint

`npm run check` is clean (fmt, clippy, typecheck, lint). `npm test` passes the Rust and vitest suites.
With a local node running, `npm run test:e2e` drives two windows and they agree on the world. Push a
branch and CI's two jobs go green. **The POC is done:** a server-authoritative, predicted, reconciled,
*tested* multiplayer foundation. Everything from here is building a game on top of a foundation you can
trust. Time to add monsters.

## References

1. ["Playwright"](https://playwright.dev/) — official site. *(The two-window end-to-end browser test runner.)*
2. ["Vitest"](https://vitest.dev/) — official site. *(The fast unit-test runner for the predictor/store logic.)*
3. GitHub Docs — ["GitHub Actions"](https://docs.github.com/en/actions). *(The CI workflow that runs the Rust and frontend jobs.)*
4. Clippy Documentation — ["Usage"](https://doc.rust-lang.org/clippy/usage.html). *(`-D warnings` turns every lint into a build failure.)*
