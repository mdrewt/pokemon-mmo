# Build a Multiplayer Monster-Tamer From Scratch

Welcome! By the end of this tutorial you will have built a **server-authoritative, 2D, multiplayer
monster-taming game** that runs in the browser — two players walking around the same world in real
time, catching monsters in the tall grass, raising them, evolving them, and battling each other.

We will build it the way the real project was built: in **milestones**, each one a small, working,
testable slice. You start with an empty folder. You end with a game.

This is written for a **junior developer** — someone comfortable with *some* programming theory but
who has never touched Rust, WebAssembly, a database that runs your game logic, or a WebGL renderer.
That's fine. We introduce each piece when you first need it, explain *why* it exists, and — this is
the part most tutorials skip — we tell you **what else you could have done instead, and when that
other choice would have been the better one.**

## What you're building

A top-down game on a grid. The pitch:

- **Two browser windows, one world.** Move in one, watch yourself move in the other. The server is
  the referee; both windows obey it.
- **Find → tame → raise → battle.** Step into grass, trigger a wild monster, weaken it, recruit it.
  Feed and care for it so it grows. Evolve or fuse it. Then fight other players.
- **Every monster is an individual.** Two players' "Sproutlings" are genuinely different — different
  hidden genes, temperament, and a stat spread shaped by how each owner raised it.

Here is the whole system on one page. Don't worry about the details yet — this is the map of the
territory we're about to cross.

```text
            ┌─────────────────────────────────────────────────────┐
            │                   game-core (Rust)                  │
            │   pure rules: movement, stats, battle, taming...    │
            │   no I/O, no clock, no randomness of its own        │
            └───────────────▲───────────────────────▲─────────────┘
        compiled to WASM    │                       │   compiled into
        for prediction      │                       │   the database
            ┌───────────────┴──────┐      ┌─────────┴──────────────┐
            │   client-wasm        │      │   server-module        │
            │   (browser, thin)    │      │   (SpacetimeDB, Rust)  │
            └───────────────▲──────┘      └─────────▲──────────────┘
                            │                       │
                    predicts│                 truth │ (tables + reducers)
                            │                       │
            ┌───────────────┴───────────────────────┴──────────────┐
            │            frontend (PixiJS + TypeScript)             │
            │   draws the world, captures input, calls the server   │
            └───────────────────────────────────────────────────────┘
```

## The three big bets

Almost every design decision in this project flows from three commitments. Internalize these now and
the rest of the tutorial will feel inevitable rather than arbitrary.

### Bet 1 — The server is the only source of truth

In a multiplayer game **you must assume the client is hostile.** A player can open the browser
console, edit memory, or send hand-crafted network messages. So we never let the client *tell* the
server what happened ("I moved to tile (5,3)", "I did 9999 damage"). The client only ever sends
**intent** ("I want to step North"), and the **server computes the outcome** from its own
authoritative state. The client's job is to make that feel instant, not to decide it.

### Bet 2 — Functional core, imperative shell

All the *rules* of the game — how a step resolves, how damage is calculated, how a wild monster's
catch odds work — live in one pure Rust library called `game-core`. "Pure" means: give it the same
inputs and it always returns the same output, with no side effects, no reading the clock, no random
numbers it conjured itself. Around that pure core sits the "imperative shell": the database, the
network, the renderer — the messy parts that talk to the outside world.

### Bet 3 — Determinism is what makes it feel fast

Here's the magic trick. Because `game-core` is pure and deterministic, we can **compile the exact
same movement code two ways**: once into the server (where it produces the official result), and once
into WebAssembly that runs in the browser. When you press a key, the browser runs the rule *locally,
right now* and moves your character immediately — then the server's official answer arrives a moment
later. Because both ran identical code on identical inputs, the answers **match**, and you never see a
correction. This is called **client-side prediction**, and determinism is the property that makes it
possible. If the client and server logic could ever disagree, prediction would constantly "rubber-
band" and the game would feel broken.

> **The golden rule, stated once:** every game rule lives exactly once, in `game-core`. We never
> reimplement a rule in TypeScript or in the server. If you ever feel tempted to, stop — that
> temptation is the bug.

## The stack, and why each piece

| Layer | Tool | Why this one |
|---|---|---|
| Shared rules | **Rust** | Compiles to both native (server) and WASM (browser) from one codebase. Strong types let us "make illegal states unrepresentable." |
| Browser prediction | **WebAssembly** (via `wasm-pack`) | Runs the *same* Rust rule in the browser — compiled, not interpreted, so it's fast and (more importantly) byte-identical to the server. |
| Backend | **SpacetimeDB 2.6** | A database where your game logic (Rust "reducers") runs *inside* the database, next to the data, in transactions. Clients subscribe to tables and get live updates. It also gives us row-level security for free. |
| Frontend | **PixiJS v8** + **TypeScript** | A fast 2D WebGL renderer; TypeScript keeps the glue code honest. |

If some of those words are unfamiliar (reducer? subscription? WASM?), good — we define each one the
first time it matters. You do not need to understand the whole table yet.

## What you'll need installed

You can install these now or when a chapter first uses them. Versions matter less than being *recent*,
except where noted.

- **Rust** — the project pins **1.96.0** (we'll see exactly how and why in Milestone 0). Install via
  [rustup](https://rustup.rs).
- **The `spacetime` CLI, version 2.6** — the SpacetimeDB toolchain. It builds and publishes the
  server module and generates TypeScript bindings. Follow the official SpacetimeDB install docs.
- **`wasm-pack`** — builds the browser prediction WASM. `cargo install wasm-pack`.
- **Node.js** (a current LTS) — runs the frontend's Vite dev server and the tests.

> **A note on honesty.** This tutorial does not pretend the chosen design is the only good one, or
> even always the best one. Multiplayer architecture is full of trade-offs, and reasonable engineers
> disagree. Where an alternative would genuinely have served better, we say so plainly. Treat the
> existing code as *a* well-reasoned answer, not *the* answer.

## How to read this

Each milestone chapter has the same shape, so you always know where to look:

- **Goal** — the one thing this step accomplishes.
- **Where it fits** — how it connects to what you've already built.
- **The code** — real excerpts from the project, with file paths. They're verbatim except where a long
  body is shortened with a `// ...` marker to keep the focus on the part that's being taught.
- **How it works** — a walkthrough.
- **Common pitfalls** — the mistakes people actually make here.
- **Alternatives & the honest verdict** — what else you could do, and whether you should.
- **Checkpoint** — how to know it works before moving on.

Ready? Let's start with an empty folder and a few decisions that will save us from a world of pain
later.
