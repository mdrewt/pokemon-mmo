# Wrap-Up — What You Built, and Where It Goes

You started with an empty folder. You now have a **server-authoritative, multiplayer, browser-based
monster-tamer**: predicted movement that feels instant, a pure deterministic rules core shared across
server and client, individual monsters you find/tame/raise/evolve/fuse, and real player-to-player
trading, ranked PvP, and co-op raids — all tested and CI-guarded.

More importantly, you learned a way of *thinking* about these systems. Let's consolidate it, be honest
about the seams, and point you onward.

## The ideas worth keeping

If you forget every line of code, keep these:

1. **The server is the only authority; the client sends intent.** Every reducer re-validates against
   its own state. The client predicts for feel, never for truth.
2. **Write each rule once, in a pure core.** `game-core` is deterministic — same inputs, same output,
   no clocks, no hidden randomness. That purity is what lets the *same* compiled rule run in the server
   (truth) and the browser (prediction) without ever disagreeing.
3. **Prefer mechanical enforcement over discipline.** A `clippy.toml` that fails the build beats a
   code-review note that asks people to remember. A `validate_content` test beats hoping the data is
   right. Make the wrong thing impossible to merge.
4. **Make illegal states unrepresentable.** The client can't even express "I'm at tile (5,3)" — there's
   no such message. Integer tiles can't numerically drift. A type that can't hold a bad value never
   does.
5. **Content is data; systems are generic.** Monsters, skills, encounters, fusion recipes are RON, not
   code, consumed by rules that don't know the specifics. New content classifies itself.

## Being honest about the seams

A tutorial that only praises its subject is lying. Here's where this design is a genuine trade-off, or
where an alternative might have served better:

- **SpacetimeDB is young.** It removed a *mountain* of plumbing (subscriptions, transactions, RLS,
  typed bindings) and made rules-in-Rust seamless — but it's a less-proven platform than a
  Node/Postgres stack a team might already run in production. For this project it was the right fit;
  for a risk-averse team it would be a real deliberation.
- **No turn timer in ranked PvP.** A stalled opponent makes you wait (you can flee). For a shipping
  ranked mode, a turn timeout genuinely *should* exist — its absence is a known gap, not a feature.
- **One map, hard-coded.** Correct under YAGNI today, but the moment a second map exists you'll want a
  real (Tiled-style) map pipeline and per-zone subscriptions — both deliberately deferred.
- **It scales to "tens to low-hundreds" of players, not millions.** The movement tick and subscriptions
  are `O(all rows)`. That's fine at the target scale and explicitly *not* prematurely optimized; the
  scaling levers (spatial subscriptions, per-zone ticks, a `map_id` index) are designed-for but
  unbuilt. Optimize when a measurement demands it, not before.
- **PixiJS over Canvas2D** is the right call for many sprites — but for a handful of entities, Canvas2D
  would have been simpler and plenty fast. We built for the crowd.

The project keeps a living `docs/known-issues.md` that triages every such item into *fixed*,
*safe-as-is (with rationale)*, and *deferred-by-design*. Honest bookkeeping of your own debt is part of
the craft.

## A note on *this page's* own trade-offs

In the spirit of practicing what we preach: this tutorial is a separate Vite multi-page entry
(`tutorial.html`) rendering Markdown with `marked` + `highlight.js`. We rejected putting it *inside* the
Pixi canvas (rendering long-form text in WebGL would be reinventing a browser) and rejected hand-written
HTML (Markdown-as-data is far easier to keep accurate). The cost is three small dependencies and a
second build entry — and we trimmed highlight.js from its ~190-language full build down to just the
handful of grammars these chapters actually need, because measuring the bundle showed the full build
dominating the route's payload (it dropped from ~1 MB to ~250 kB). Small decisions, same reasoning as
everywhere else.

## Where to go from here

The codebase has reference docs that go deeper than this tutorial's teaching pass — read them next:

- `ARCHITECTURE.md` — the durable design record: the golden rule, the data model, the prediction
  system, the security invariants, the tiered engineering principles, and the milestone history.
- `docs/data-model.md` — every table, column, index, and RLS filter.
- `docs/reducers.md` — every reducer, its arguments, validations, and rejections.
- `docs/game-systems.md` — each gameplay system end to end.
- `docs/frontend.md` — the client module map and data flows.

And to extend the game yourself, here are tractable next steps, roughly in order of difficulty:

1. **Add a species.** Author it in `species.ron`, give it a learnset and an evolution — the validation
   test and the seeding will do the rest. The smallest possible end-to-end change; do this first.
2. **Add a new item** (a different bait or a stat food). Same content-only loop.
3. **Add a turn timeout to PvP** — the honest gap above. A scheduled reducer that resolves a stalled
   turn. Good practice with scheduled reducers and terminal-state handling.
4. **The battle depth layer** — weakness-tempo combos, team auras, multi-active 3v3. Pure `game-core`
   work with the best test-to-risk ratio in the project.
5. **A second map** — the big one. Build the Tiled pipeline, add per-zone subscriptions, and add the
   `map_id` index that's been *planned* since Milestone 6 (the `map_id` column exists on the row today,
   but it isn't indexed yet — that's part of the work).

## Go build something

You now know how to build a real-time, server-authoritative multiplayer game with a deterministic
shared core — one of the harder things in applied programming, demystified into a handful of repeatable
ideas. The same architecture (pure core, authoritative server, predicted client, mechanical guards)
generalizes far beyond monster-tamers.

Close this tab, open an empty folder, and start with `cargo new`. You've got this.

*← Use the navigation to revisit any milestone. The game itself is one click away on the title screen.*
