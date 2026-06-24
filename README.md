# monster-tamer-mmo

A 2D top-down, pixel-art **multiplayer monster-taming game** (Pokémon Ruby/Sapphire feel) in the
browser. **Server-authoritative**: [SpacetimeDB](https://spacetimedb.com) holds the canonical game
state; the client predicts movement locally for responsiveness and **reconciles to the server — never
the reverse**.

The emotional core: **every monster is a unique individual you personally shaped.** Species are
templates; each monster you catch has hidden genes, a temperament, a name, a bond, and a stat build
that diverges from how you raise it.

## Status

The proof-of-concept (movement, prediction, two-window sync) is complete, and the game loop is
playable through **find → tame → fight**:

- **Walk** a shared map with another player, turn / step / jump, with client-side prediction and
  server reconciliation; one server-driven wandering NPC.
- **Monsters** — on join you receive a uniquely-rolled starter; inspect your box/party (stats,
  temperament, bond, EXP progress) and rename/rearrange them.
- **Battle** — turn-based and server-resolved: a readable type/affinity chart, speed-ordered turns,
  XP and levels, a damage/faint turn log, HP that **persists between battles**, on-demand healing,
  and a voluntary mid-battle **switch**.
- **Find & tame** — walk into **tall grass** to trigger wild encounters; **weaken then recruit**
  (recruit odds rise as the wild's HP drops), optionally spending **bait**; the catch joins your box.
- **Raise** — **feed** training food to shape a monster's stat spread and **care** for it to build
  bond; how you raise it makes two same-species monsters genuinely diverge.
- **Evolve & fuse** — **evolve** a monster once it meets a level/bond gate (branches you choose among),
  keeping its individuality; or **fuse** two monsters into a stronger offspring that inherits the
  better genes of each.

See [ARCHITECTURE.md](ARCHITECTURE.md) for the durable design record and the milestone roadmap
(next: **M11 — multiplayer**: trade / PvP / co-op).

## Stack & layout

| Dir | Role |
|---|---|
| [`game-core/`](game-core/) | Pure, deterministic Rust: shared types + **all game rules**. No I/O, no clocks, no platform deps. |
| [`client-wasm/`](client-wasm/) | Thin `wasm-bindgen` exports wrapping `game-core` for client-side **movement prediction**. |
| [`server-module/`](server-module/) | SpacetimeDB 2.6 module: tables + reducers. Wraps `game-core` for **authoritative** logic. |
| [`frontend/`](frontend/) | PixiJS v8 + TypeScript: rendering, input, networking glue, prediction/reconciliation. |

**The golden rule:** every game rule lives **once** in `game-core`. The server runs it for truth; the
client runs the *same compiled code* (via `client-wasm`) for movement prediction. Reimplementing a
rule in TypeScript or hand-rolling it in a reducer would desync prediction from truth — so don't;
call `game-core`. Battles are turn-based and **server-resolved with no prediction** (the client
submits intent and animates the authoritative result). Content (monsters, skills, the affinity chart,
encounter tables, items) is **data** in `game-core/content/*.ron`, seeded into read-only tables.

## Develop

Prerequisites: Rust (stable + the `wasm32-unknown-unknown` target), the `spacetime` CLI 2.6,
`wasm-pack`, and Node. Then:

```sh
# 1. start a local SpacetimeDB node (separate terminal)
spacetime start

# 2. build the prediction WASM, publish the module, generate TS bindings
npm run build:wasm
npm run build:server          # = publish (-s local) + gen

# 3. run the frontend dev server
npm run dev:client            # Vite; open the printed URL, enter a name, play

# during iteration, `spacetime dev` auto-rebuilds + republishes + regenerates bindings on change
```

A `game-core` change can ripple through three targets — rebuild the prediction WASM **and** republish
the module **and** regenerate the bindings (`npm run gen`). An incompatible schema change needs
`spacetime publish … --delete-data --yes` (local dev data is disposable).

## Test

```sh
npm run check     # cargo fmt --check + clippy -D warnings + tsc --noEmit + eslint
npm test          # cargo test --workspace + frontend vitest
npm run test:e2e  # Playwright two-window suite (LOCAL only — needs `spacetime start`; CI has no spacetime CLI)
```

`game-core` is the test center of gravity (pure, deterministic rules + a movement prediction-parity
test). CI runs the Rust and frontend suites; the e2e is a local gate. Each milestone ships as one PR
through the review gates (`reducer-security-auditor`, `desync-guard`, `/simplify`, `/code-review`).

Project conventions and the agent/skill setup live in [CLAUDE.md](CLAUDE.md).
