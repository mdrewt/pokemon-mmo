# Milestone 0 — The Skeleton and the Guardrails

**Goal:** turn an empty folder into a Rust *workspace* with three crates, pin the toolchain so your
machine and CI agree, and — most importantly — install a mechanical guard that makes our "purity"
rule impossible to break by accident.

**Where it fits:** this is pure groundwork. No game yet. But the decisions here are the ones you can't
cheaply change later, so we make them deliberately and up front. (The project literally calls this
phase "contracts first.")

## The shape of the repository

We're building four things that share code, so we use a **Cargo workspace** — Rust's way of keeping
several crates (packages) in one repo with one lockfile and one `cargo build`.

```text
pokemon-mmo/
├── Cargo.toml            # the workspace root (lists the members)
├── rust-toolchain.toml   # pins the Rust version
├── clippy.toml           # the determinism guard (the star of this chapter)
├── game-core/            # pure shared rules — the heart
├── client-wasm/          # thin Rust→WASM wrapper for browser prediction
├── server-module/        # the SpacetimeDB module (tables + reducers)
└── frontend/             # PixiJS + TypeScript (added in Milestone 4)
```

## The workspace root

Create `Cargo.toml` at the repo root:

```toml
[workspace]
members = ["game-core", "client-wasm", "server-module"]
resolver = "2"

[workspace.dependencies]
# Shared versions — crates opt-in with `workspace = true`
serde = { version = "1", features = ["derive"] }
# RON content files (species/skills/etc.) are embedded via include_str! and parsed in game-core.
# Pure parser, no I/O — safe under the determinism guard.
ron = "0.8"
# Matches the installed `spacetime` CLI 2.6.0. game-core depends on this ONLY behind its
# optional `spacetimedb` feature (for SpacetimeType derives); server-module uses it directly.
spacetimedb = "1.12"
```

### How it works

- `members` lists the three Rust crates. (`frontend` is a TypeScript project, not a Rust crate, so
  it's not a workspace member.)
- `resolver = "2"` is the modern Cargo feature resolver. It matters here because our crates enable
  *different* features of shared dependencies — the v2 resolver keeps those feature sets from leaking
  between crates.
- `[workspace.dependencies]` declares a version **once**; each crate then writes `serde = { workspace
  = true }` instead of repeating `"1"`. One place to bump a version is one place to get it wrong.

> **Wait — `spacetimedb = "1.12"` for SpacetimeDB *2.6*?** Yes, and this trips everyone up. The
> SpacetimeDB *product* is version 2.6; the Rust *crate* you depend on is independently versioned at
> 1.12. They are not the same number. When in doubt, match the crate version to whatever your
> installed `spacetime` CLI expects, and confirm against the official docs rather than your memory.

## Pinning the toolchain

Create `rust-toolchain.toml`:

```toml
[toolchain]
# Pinned (not floating `stable`) so local builds == CI. Bump deliberately.
channel = "1.96.0"
components = ["rustfmt", "clippy"]
targets = ["wasm32-unknown-unknown"]
```

### How it works

`rustup` reads this file and automatically uses Rust **1.96.0** in this directory, installing the
`rustfmt` and `clippy` tools and the `wasm32-unknown-unknown` compile target (the one WASM needs).

**Why pin instead of using `stable`?** Because "stable" is a moving target. If your laptop has a newer
stable than the CI server, a build can pass for you and fail in CI (or vice-versa) over a lint that
changed between releases. A pinned version makes "works on my machine" mean "works everywhere." The
cost is that you upgrade Rust *deliberately* (change one line) rather than silently — which is exactly
what you want for reproducibility.

## The guardrail that earns this chapter its name

Here is the single most important file in the whole project's setup. Create `clippy.toml` at the root:

```toml
# Determinism guard (applies workspace-wide via `cargo clippy`).
#
# `game-core` must be pure and deterministic so client prediction matches server truth: no
# wall-clock reads, no unseeded randomness — time and RNG are passed in as arguments. These
# bans make impurity a BUILD FAILURE (CI runs `clippy -D warnings`), not just a review note.
# No crate in this workspace should read a wall clock; the server uses `ctx.timestamp` and
# `ctx.rng()`, the client passes time in, and tests seed an explicit RNG.
disallowed-methods = [
    { path = "std::time::SystemTime::now", reason = "non-deterministic — pass time in as a Millis argument (server: ctx.timestamp)" },
    { path = "std::time::Instant::now", reason = "non-deterministic — pass time in as a Millis argument" },
    { path = "rand::thread_rng", reason = "non-deterministic — pass a seeded Rng in (server: ctx.rng(); tests: ChaCha)" },
    { path = "rand::random", reason = "non-deterministic — pass a seeded Rng in" },
]
```

### How it works, and why it matters so much

Recall Bet 3 from the intro: prediction only works if the client and server run *identical* logic on
*identical* inputs. The two ways that silently breaks are:

1. Someone reads the **clock** inside a rule (`SystemTime::now()`), so the same input produces a
   different result depending on *when* it ran.
2. Someone generates a **random number** inside a rule (`rand::thread_rng()`), so the same input
   produces a different result every time.

Both are easy to write by accident, deep inside a call stack, months from now. So instead of *trusting
ourselves* to never do it, we make the compiler-adjacent tool **clippy** reject those exact function
calls. CI runs `cargo clippy -- -D warnings` ("treat every warning as an error"), so a wall-clock read
doesn't get a stern code-review comment — it **fails the build**. The rule can't rot.

This is a theme you'll see throughout the project, worth naming now: **prefer mechanical enforcement
over discipline.** Discipline is a person remembering to do the right thing under deadline pressure.
Mechanical enforcement is a machine that won't let the wrong thing merge. The second one scales.

How do we then get time and randomness, which games obviously need? We **pass them in as arguments.**
A movement rule takes the current time as a parameter; a monster roll takes a random-number source as
a parameter. The rule stays pure; the *caller* (the server, or a test) supplies the impurity. You'll
see this pattern constantly starting in the next chapter.

## Common pitfalls

- **Skipping the pin "for now."** The day CI disagrees with your laptop over a clippy lint, you'll
  wish you'd spent the 30 seconds. Pin on day one.
- **Putting the `frontend` directory in `members`.** It's not a Rust crate; Cargo will error. The
  frontend is a separate TypeScript project that *consumes* the build outputs of the Rust crates.
- **Assuming `clippy.toml` only affects one crate.** `disallowed-methods` applies to the whole
  workspace. That's intentional: no crate here should read a wall clock, not just `game-core`.

## Alternatives & the honest verdict

- **Three separate repositories instead of a workspace.** You *could* split `game-core`,
  `server-module`, and `client-wasm` into their own repos and depend on published versions. Big teams
  with independent release cadences sometimes do. For us it would be strictly worse: a single change to
  a shared type would mean publishing a crate, bumping a version, and updating two consumers — turning
  a 10-second edit into a multi-repo dance. A monorepo workspace keeps the shared code shared. **Verdict:
  workspace wins decisively at this scale.**
- **Enforcing purity by code review and tests instead of a lint.** This is the tempting "lighter"
  option. It's also the one that fails, because the failure mode (a clock read four functions deep) is
  invisible in a diff and only shows up as a rare desync that's miserable to debug. **Verdict: the lint
  is the right call; it's cheap and it never gets tired.**
- **Floating `stable` toolchain.** Lower friction day-to-day, real friction the first time a release
  shifts a lint. **Verdict: pin it.** The one scenario where floating wins is a throwaway prototype you
  will never run in CI — which this is not.

## Checkpoint

You can't *run* anything yet (the crates are empty), but you can prove the skeleton is sound. After you
add the three crate folders in the next chapters, `cargo build` from the root should compile all
members, and `cargo clippy` should pass. For now, the milestone is done when the three config files
above exist and `cargo metadata` (which reads the workspace without building) lists three members.

Next, we give the skeleton a brain: the pure rules in `game-core`.
