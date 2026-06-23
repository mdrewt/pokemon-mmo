# Project Instructions

<!--
Keep this lean — a lookup table, not a brain dump. If Claude already does
something correctly without being told, delete that line. Stable rules live here;
transient task context does not.
Priorities for this project, in order: code quality, correctness, efficiency,
testability, optimization. When these trade off, prefer correctness and testability
first — a fast wrong answer in a multiplayer game is worse than a slightly slower right one.
-->

## Project Overview

A 2D top-down multiplayer browser game.

- **Server-authoritative.** SpacetimeDB holds the canonical game state. The client
  predicts locally for responsiveness, but the server's state always wins — on conflict,
  the client reconciles to the server, never the reverse.
- **Frontend:** PixiJS v8.19 (rendering) + TypeScript (UI, input, networking glue).
- **Game logic:** Rust compiled to WASM, shared with the server via a common crate.
- **Backend:** SpacetimeDB 2.6 module written in Rust (tables + reducers).
- **Published database name:** `monster-tamer-mmo`.

## Architecture

```
game-core/         # Shared Rust crate: types, rules, pure simulation logic
                   #   minimal deps; NO I/O, NO platform deps (uses std; alloc is fine)
client-wasm/       # Rust → WASM. Wraps game-core for prediction; wasm-bindgen exports
server-module/     # SpacetimeDB 2.6 Rust module. Wraps game-core in reducers
frontend/          # PixiJS + TS. Renders state, captures input, calls reducers
```

The non-negotiable rule: **game rules live in `game-core` and are written once.**
The server runs them for the authoritative result; the client runs the same code for
prediction. If logic diverges between client and server, prediction breaks and the game
desyncs. Never reimplement a rule in TS or in the server module that already exists (or
should exist) in `game-core`.

- `game-core` must stay pure: deterministic, no `std::net`/`std::fs`, no clocks read
  directly (pass time in as an argument), no randomness except via a seeded RNG passed in.
  Determinism is what makes client prediction match server truth.
- The client predicts; the server confirms. TS reconciles by applying authoritative
  state from SpacetimeDB subscriptions over local prediction.
- Cross-boundary data shapes (Rust ↔ WASM ↔ TS, and Rust ↔ SpacetimeDB) are a common
  source of bugs. Keep the shared types in `game-core` and generate/derive bindings rather
  than hand-writing them on both sides.

## SpacetimeDB (server module) — version 2.6

Use the official 2.6 docs for anything non-trivial; the API has version-specific details.
The rules below are correct in principle, but a few exact identifiers (the randomness/time
accessors and the module-identity check) have shifted across SpacetimeDB versions — confirm
the literal spelling against your installed 2.6 (via GitMCP) when you write your first
reducer, rather than trusting these tokens verbatim. Key rules:

- **Reducers are the only way to mutate tables**, run in their own transaction, and are
  committed only if they return `Ok`. Return `Result<(), String>` (or similar) and let an
  `Err` abort — that's the transactional escape hatch.
- **Reducers must be deterministic and side-effect-free except for table writes.** No
  network or filesystem I/O (`std::net`/`std::fs` cause runtime errors). No mutable global
  state — SpacetimeDB may execute reducers concurrently or re-execute them on serialization
  conflicts, so store ALL state in tables. Use `ctx.rng()` for randomness, `ctx.timestamp`
  for time — never `std`'s.
- Table access is via snake_case accessors: `ctx.db.player()`, not `ctx.db.Player`.
- Add `use spacetimedb::Table` when calling `insert`, `iter`, `get_by_id`, `update`.
- Table struct/enum fields must be `pub`; custom types used as columns need
  `#[derive(SpacetimeType)]`.
- Use lifecycle reducers (`init`, `client_connected`, `client_disconnected`) for setup and
  presence. For the game loop, use **scheduled reducers** (a scheduled table with
  `#[table(..., scheduled(reducer_name))]`) — scheduling is transactional.
- Guard scheduler-only reducers: check `ctx.sender() == ctx.identity()` (module identity)
  and reject client calls.
- Public tables are world-readable but only server code writes them. Put anything a client
  must not see in a private (non-public) table.

## Security (this is a multiplayer game — treat the client as hostile)

- **The server validates everything. Never trust client input.** Every reducer
  re-checks that the action is legal for that `ctx.sender()` given current server state —
  range, cooldowns, ownership, resource cost. Client-side prediction is a UX convenience,
  never an authorization.
- Never let a reducer take the client's word for a computed result (position, score,
  damage). The client sends *intent* ("move toward X", "fire"); the server computes the
  outcome from authoritative state.
- Identity comes from `ctx.sender()`, set by SpacetimeDB — never from a field the client
  passes. Don't let a client act as another identity.
- Validate bounds and rate on every reducer to resist spoofing and flooding (e.g. a client
  spamming a fire reducer). Reject, don't clamp silently, when input is out of contract.
- Keep secrets and server-only state in private tables. Assume the WASM client and all
  network traffic are fully visible to a motivated attacker.

## Conventions

### Rust (game-core, client-wasm, server-module)
- `cargo clippy` clean (treat warnings as errors in CI); `cargo fmt` before proposing changes.
- Prefer `Result` over panics in anything reachable from a reducer or the WASM boundary —
  a panic across the WASM boundary or in a reducer is a bad failure mode.
- `game-core` exposes pure functions taking explicit state + input + (seeded rng/time);
  no hidden globals. This is what keeps it testable and deterministic.
- Keep wasm-bindgen exports thin: marshal at the boundary, delegate to `game-core`.

### TypeScript / PixiJS frontend
- TS strict mode; no `any` without a comment justifying it.
- Keep rendering (PixiJS) separate from game state. Pixi draws a view of state; it does not
  own state. Input → intent → reducer call; subscription → state → render.
- WASM init is async — `await` the init before calling any exported function; gate the
  game loop on it.
- Don't recreate Pixi display objects each frame; pool and update them. Rendering is the
  hot path — mutate existing sprites, reuse textures, batch where possible.
- Match the style of the file you're editing; don't reformat untouched code.

## Build & Test

Two separate WASM builds — don't conflate them. `spacetime` compiles only the SERVER
module. The browser-side prediction WASM (`client-wasm`) is a separate `wasm-pack` build.

- Build WASM client (browser prediction): `wasm-pack build client-wasm --target bundler`
  (use the `bundler` target — NOT `web` — so Vite imports `client-wasm/pkg/` as a normal
  ES module, tree-shakes it, and needs no extra WASM plugins or manual async init)
- Build/publish server module: `spacetime publish -p server-module monster-tamer-mmo`
- Regenerate client bindings after ANY schema change:
  `spacetime generate --lang typescript --out-dir frontend/src/module_bindings --module-path server-module`
- Dev loop (auto rebuild + publish + regenerate bindings on change): `spacetime dev`
- Frontend dev / build: `vite` / `vite build`
  (optional: a Vite Rust/WASM plugin can fold the `wasm-pack` step into Vite's build so the
  crate rebuilds automatically — verify the plugin's current maintenance before adopting)
- Rust tests: `cargo test` (workspace) — `game-core` is where most logic tests live
- Rust lint/format: `cargo clippy --all-targets` / `cargo fmt --check`
- TS test: `vitest`; TS typecheck: `tsc --noEmit`; TS lint: `eslint .`

Toolchain: Rust 1.81.0+ for the SpacetimeDB module; the `spacetime` CLI auto-installs the
`wasm32-unknown-unknown` target.

The bindings in `frontend/src/module_bindings/` are TypeScript and are how the frontend
talks to SpacetimeDB (subscribe to tables, call reducers). They are NOT the prediction WASM
— that's `client-wasm`. The frontend uses both: TS bindings for networking, the WASM for
local prediction, then reconciles WASM prediction against the authoritative subscription.

Before treating a task done: relevant tests pass, clippy clean, typecheck clean. If you
can't verify a change, say so rather than claiming it works.

## Testing strategy (priority: testability + correctness)

- **`game-core` is the test center of gravity.** Because it's pure and deterministic, test
  game rules here with plain unit tests — same input, same output, no DB or browser needed.
  This is the cheapest, highest-value coverage in the project; push logic down into it
  specifically so it can be tested in isolation.
- **Determinism tests:** assert that a given (state, input, seed) produces identical output.
  Optionally assert client-prediction output equals server-module output for the same input —
  this is your desync regression net.
- **Reducer tests:** small and deterministic, using the SpacetimeDB test harness for cases
  needing DB access; keep validation logic as pure functions in `game-core` and unit-test
  those directly, with the reducer as a thin wrapper.
- **Frontend:** test networking/reconciliation and state logic; don't pixel-test rendering.
- Always provide verification (test, assertion, or repro) for a change. If it can't be
  verified, don't ship it.

## Optimization (do it last, measure first)

- Correctness and clarity first; optimize only with a measurement showing the need. No
  speculative micro-optimization that costs readability.
- Likely real hot paths when they show up: the scheduled game-loop reducer, per-frame Pixi
  rendering, and the WASM↔JS boundary (minimize crossings and copies — batch state transfer
  rather than chatty per-entity calls).
- Profile before and after; keep the win or revert.

## Skills

Skills in `.claude/skills/` load just-in-time when their description matches the task.

- **Official PixiJS v8 skills** — installed via `npx skills add https://github.com/pixijs/pixijs-skills`
  (also ship inside the npm package at `node_modules/pixi.js/skills/`). These are the
  authoritative source for Pixi v8 patterns and exist specifically to stop agents emitting
  outdated v7 code. Prefer them for rendering/Pixi work over recalling Pixi APIs from memory.
- **Project skills** (in this repo):
  - `spacetimedb-reducer` — reducer authoring: validation, determinism, schema gotchas.
  - `game-core-testing` — determinism + client/server prediction-parity (desync) tests.
  - `wasm-boundary` — the Rust→WASM→TS seam: thin exports, async init, batching, panics.

## MCP Servers

<!-- Only list servers actually connected. More servers = more context overhead. -->

### Code knowledge graph: codebase-memory-mcp

A local code intelligence server (tree-sitter AST + Hybrid LSP type resolution, incl. Rust
and TypeScript). Use it to answer structural questions instead of grepping or reading files
across the workspace.

- For "what calls X / what depends on X / where is X defined", query the graph first —
  don't reconstruct it by reading files. This is the token win; skipping it wastes the index.
- **Before changing a shared `game-core` signature, run impact analysis.** `game-core` is
  used by both `client-wasm` and `server-module`, so the blast radius spans the whole repo —
  a missed caller means client/server prediction desync. Report the affected callers/tests
  before editing, not after.
- Trust its Rust resolution over a plain AST guess for trait/generic/macro/`derive` cases
  (SpacetimeDB leans on `derive` heavily) — that hybrid-LSP layer is why this tool was chosen.
- If the graph is missing or stale for files in scope, say so and re-index rather than
  silently falling back to a full-repo grep sweep.
- Load lazily (Tool Search), not at session start — don't pay its context cost when no
  structural lookup is needed.
- It reads the codebase AND writes to agent config files by design. Keep its index directory
  and any generated config out of git (add to `.gitignore`); review what it writes once on
  first setup.

## Library Documentation

<!--
Don't write against these APIs from training-data memory — SpacetimeDB 2.x and PixiJS v8
both have version-specific surfaces, and getting them wrong wastes a whole build/publish cycle.
Pull current/pinned docs first. Two doc servers are connected; the routing below exists to
save Context7's metered request quota and to keep doc payloads small.
-->

Two documentation MCP servers are available. Route by ownership — do not pick by guess.

### Default: GitMCP (no request quota)

GitMCP serves docs straight from a project's GitHub repo and has no metered request limit,
so it is the **default** source. Use it for:

- **SpacetimeDB 2.6** — `https://gitmcp.io/clockworklabs/SpacetimeDB`. Fetch
  module/reducer/table docs before writing or changing server code. If docs and memory
  disagree, docs win (2.x differs meaningfully from 1.x).
- **wasm-bindgen** — the JS↔Rust boundary (async init, exported types, generated `.d.ts`).
- **PixiJS v8.19** — PixiJS publishes `llms.txt`, so GitMCP serves it well too; routing it
  here (not Context7) saves quota. `https://gitmcp.io/pixijs/pixijs`. See also the note on
  official PixiJS skills below — for most Pixi work the skills cover it without a doc fetch.
- **Any niche crate** Context7's catalog covers poorly. `[list as they come up.]`

### Reserved: Context7 (metered — use sparingly)

Context7's free tier is limited (~1,000 requests/month). With SpacetimeDB, wasm-bindgen,
and PixiJS all routed to GitMCP (they publish `llms.txt` or have repos GitMCP reads well),
Context7 is reserved only for a library that is BOTH version-sensitive AND lacks usable
`llms.txt`/repo docs for GitMCP. That's rare — most lookups should never reach Context7.

- `[Add a library here only when GitMCP genuinely can't serve its docs.]`

### Rules (these are the four optimizations — keep them)

1. **GitMCP is the default; Context7 is the reserved fallback.** Reach for GitMCP first;
   only use Context7 for the pinned-mainstream cases above. This preserves Context7's quota.
2. **Route by the ownership lists above — never query both servers for the same lookup.**
   Double-querying burns Context7 quota *and* doubles the context payload, defeating the point.
   If unsure which owns a library, default to GitMCP.
3. **Load these doc tools lazily (Tool Search), not at session start.** A connected server
   costs context every session just by existing; don't pay that when no doc lookup is needed.
4. **Fetch narrowly.** Ask for the specific symbol/topic ("SpacetimeDB scheduled reducer
   syntax"), never "the whole docs for X" — payload size is the dominant token cost, and a
   focused request is smaller from either server.

## Engineering Principles (apply with judgment — see ARCHITECTURE.md for rationale)

Balance CLEAN/DRY/YAGNI case-by-case; these are this project's pre-resolved tensions so you
don't thrash or "simplify" deliberate structure away. "Bug-free" is approached, not guaranteed:
the net is a pure testable `game-core` + mechanical enforcement + parity tests + review gates.

- **DRY, but not across boundaries.** Game *rules* live once in `game-core`. Thin
  `client-wasm`/reducer/`net` wrappers are intentionally repetitive — don't abstract that
  boilerplate into clever generics that obscure the boundary.
- **YAGNI, with NAMED exceptions.** Build only current scope; defer the ARCHITECTURE.md scaling
  path. But do **not** remove as "over-engineering": (1) full WASM client prediction, (2) the
  entity/component split (`character` + `player`/`npc`). Keep the POC map a concrete `const`
  grid — no Tiled/`TileMap` abstraction until a second map exists.
- **Clean over clever.** Dependency-free domain core, I/O at the edges, small pure functions.
- **Mechanical enforcement first.** Determinism → `clippy.toml`; boundaries → the compiler +
  feature-flagged shared types; security → `reducer-security-auditor`; desync → `desync-guard`;
  DRY/YAGNI/clarity → `/simplify`; bugs → `/code-review`. Each milestone's Definition of Done
  includes a `/simplify` pass and a `/code-review` pass.

## Working Style

- For anything spanning more than ~2 files, propose a short plan before editing — this stack
  has three Rust targets plus a frontend, and a change often touches a boundary.
- A change to `game-core` may require regenerating SpacetimeDB bindings and rebuilding the
  WASM client. Flag that chain rather than editing one side silently.
- Scope work to the files I name; don't explore the whole workspace unprompted. Need context?
  Ask or use a subagent so it doesn't fill the main session.
- Keep diffs minimal and focused; flag unrelated issues separately rather than fixing inline.

## Compaction

When compacting, preserve: modified files, commands run and their output, failed tests,
schema/binding regeneration steps still pending, and any unresolved desync/validation questions.