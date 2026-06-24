# Documentation

Reference material for the monster-tamer MMO. The two canonical top-level docs are the entry points;
this directory holds the deeper, per-area references that would bloat them.

| Doc | What it covers | Audience |
|---|---|---|
| [`../README.md`](../README.md) | Elevator pitch, feature status, build/run/test quickstart | First-time visitor |
| [`../ARCHITECTURE.md`](../ARCHITECTURE.md) | Durable design record: the golden rule, data-model overview, prediction model, security invariants, engineering principles, milestones | Contributor needing the *why* |
| [`../CLAUDE.md`](../CLAUDE.md) | Agent operating manual: conventions, build commands, skill/MCP routing | The AI agent (and humans reading its rules) |
| [`data-model.md`](data-model.md) | **Complete** table-by-table schema reference — every table, column, index, and RLS filter | Anyone touching the schema or auditing data |
| [`reducers.md`](reducers.md) | **Complete** reducer reference — every reducer, its intent args, validations, and rejections | Anyone wiring the client or auditing security |
| [`game-systems.md`](game-systems.md) | How each gameplay system works end to end: movement & prediction, battle, taming, raising, evolution & fusion, trading, PvP, leagues, co-op raids | Anyone changing game rules |
| [`frontend.md`](frontend.md) | The client (`frontend/src/`) module map: data flow, prediction, store, screens, rendering, input | Anyone working on the client |
| [`known-issues.md`](known-issues.md) | Known bugs, latent fragilities, deferred work, and balance/exploit notes — with severity | Anyone hardening the project |
| [`../CONTRIBUTING.md`](../CONTRIBUTING.md) | Branch/PR workflow, the gate order, running the local e2e | Contributors |

## How the codebase is organized

Four build targets (see [`../ARCHITECTURE.md`](../ARCHITECTURE.md#stack--crates) for the rationale):

- **`game-core/`** — pure, deterministic Rust: shared types + **all game rules**, written **once**. No
  I/O, no clocks, no randomness except via a seeded source passed in. Both the server and the client's
  movement predictor run this same code.
- **`client-wasm/`** — thin `wasm-bindgen` exports wrapping `game-core` for client-side **movement
  prediction** only (battles are not predicted).
- **`server-module/`** — the SpacetimeDB module: tables + reducers, wrapping `game-core` for the
  authoritative result. The only place tables are written.
- **`frontend/`** — PixiJS v8 + TypeScript: rendering, input, networking glue, prediction/reconciliation.

**The golden rule:** every game rule lives once in `game-core`. The server runs it for truth; the client
runs the *same compiled code* for movement prediction. Reimplementing a rule in TypeScript or
hand-rolling it in a reducer would desync prediction from truth.
