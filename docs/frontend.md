# Frontend architecture

The client (`frontend/src/`) is PixiJS v8 + TypeScript. It **renders a view of authoritative state and
predicts only movement** — it never owns game state and never computes a battle outcome. This guide maps
the modules and the three data flows.

## Module map

```
frontend/src/
  main.ts            Bootstrap + the per-frame game loop (the spine — read this first)
  wasm.ts            The single typed boundary to client-wasm (movement prediction)
  convert.ts         Marshaling between SDK tagged-unions and wasm plain-string shapes
  monster.ts         Display helpers (bond/training caps — copies across the marshaling boundary)
  net/
    connection.ts    NetHandle: subscriptions, reducer wrappers, the error-toast call seam
    store.ts         AuthoritativeStore: the client's mirror of canonical state + change events
  prediction/
    predictor.ts     The movement prediction/reconciliation buffer (pure of Pixi/wasm)
  input/
    input.ts         Keyboard → held directions + one-shot latches
  render/
    scene.ts         The Pixi stage; pooled character views; centers the world
    characterView.ts One pooled animated sprite; interpolates slides
    tilemap.ts       Draws the const map once (floor / wall / grass)
  ui/
    screen.ts        The screen-state machine (overworld | box | battle | trade | challenge)
    nameEntry.ts     The join overlay
    box.ts           Box/party: inspect, rename, party-slot, feed/care, evolve, fuse
    battle.ts        Battle overlay (PvE / PvP perspective-flip / co-op raid)
    trade.ts         Trade overlay (offer / respond / confirm)
    challenge.ts     PvP challenge + raid invite + leaderboard
    toast.ts         Ephemeral error/info notifications
    affinity.ts      Affinity → colour
    hud.ts           Dev-only debug HUD (backtick toggle)
  test/introspect.ts Dev-only window.__game() snapshot for the Playwright e2e
```

## The three data flows

All visible in `main.ts`'s ticker:

1. **subscription → store → render.** SpacetimeDB table callbacks (`connection.ts`) write into the
   `AuthoritativeStore`; `Scene`/overlays subscribe to its change events and render.
2. **input → intent → reducer.** `InputController` latches keys; the loop polls them and calls
   `net.*` reducer wrappers with *intent only* (a direction + seq, a skill id, a target identity) —
   never a computed outcome.
3. **movement prediction → reconcile.** The `Predictor` advances local predicted state each frame;
   `predictor.reconcile(...)` snaps it to authoritative truth whenever the own-character row or its ack
   changes.

## Movement prediction & reconciliation

`Predictor` (`prediction/predictor.ts`) mirrors the server's `movement_tick` drain at `STEP_MS` cadence.
It is **pure of Pixi and wasm** — `applyMove` is injected, so it's node-unit-testable. Three collections:

- `#predicted` — the renderer's view, advanced only by `drain(now)`.
- `#queue` — predicted-but-not-yet-drained moves.
- `#pending` — queue *operations* (`enqueue`/`setMove`/`clear`) sent to the server but not yet acked,
  kept as ops (not bare inputs) so `reconcile` can replay them faithfully.

**Reconciliation** (the "client reconciles to server, never the reverse" rule): drop acked pending ops
(`seq > ackedSeq`), reset `#predicted` to authoritative truth, **rebuild the queue by replaying the
still-pending ops on top of the authoritative queue**, then re-drain to `now`.

No clock sync: the server stores `move_started_at` as epoch ms, but the predictor compares against local
`performance.now()`. `convert.characterToPredictedBaseline` rebases the baseline to `localNow - 2*step`
(clamped at 0 — negatives/fractions make wasm serde reject the `CharacterState`), which is why the first
queued move drains immediately. `wasm.ts` is built `--target bundler` (self-initializing at import);
`initWasm()` only touches an export to defeat tree-shaking and record readiness.

## The AuthoritativeStore

`net/store.ts` is the client's mirror of canonical state — never mutated by prediction or rendering.
Character rows carry `receivedAt` (local `performance.now()` at receipt) to drive remote interpolation
without clock sync. **Content/owned tables are keyed `Map`s so a re-subscribe is idempotent** (a
reconnect re-delivers every row as an insert; a plain array would duplicate). The single `battle` is an
optional (RLS gives ≤1 per client). Change fan-out is split into listener sets — `onCharacterEvent`,
`onMonsterChange`, `onBattleChange`, `onTradeChange`, `onChallengeChange` — and a few are deliberately
overloaded (e.g. a `battle_action` change fires `onBattleChange` to drive the "waiting for opponent"
state; a `profile` change fires `onChallengeChange` because the leaderboard lives in the challenge
overlay).

## The error-toast `call()` seam

`connection.ts`'s `makeActionCaller(onActionError)` wraps a reducer-call promise so its **rejection**
(the server's `Err` string) is surfaced via a toast instead of being swallowed by `void`. Every discrete
**action** reducer routes through it (rename, train, evolve, fuse, battle actions, trades, challenges,
heal, …). The high-frequency **movement** reducers deliberately bypass it — their rejections ("move
queue full", "stale seq") are normal flow-control already handled by prediction/reconciliation, so
toasting them would spam the player. The seam is extracted specifically so the
"a rejected action surfaces / a resolved one doesn't" contract is unit-testable without a live
connection (`connection.test.ts`).

## Screens & overlays

`ScreenManager` (`ui/screen.ts`) is a plain enum router (no FSM lib). The full-screen overlays
(box/battle/trade/challenge) are DOM layers that read authoritative state and call ownership-checked
reducers — they never mutate state locally. Two subtleties live in `main.ts`:

- **Overlays are handled *before* the movement-prediction gate.** They need neither the predictor nor
  the own-character row, so they can always be *exited* — even if a battle opens before the predictor
  exists, or the own row briefly drops on a reconnect while a menu is open. The loop also drains stray
  one-shot latches so a key pressed in an overlay doesn't fire on return to the overworld.
- **The battle screen is server-driven:** `onBattleChange` sets `'battle'` when the `battle` row appears
  and returns to `'overworld'` when it disappears. The screen never opens itself.

### Battle screen perspective

`ui/battle.ts` renders three modes from one `BattleState`:

- **PvE** — your party vs a wild; recruit + switch available.
- **PvP** — the challenge **accepter** is `state.enemy`, so the screen flips: it renders the *viewer's*
  side at the bottom, and flips the event-log "you/opponent" flags and the win/lose headline
  (`iWon = viewerIsPlayer ? PlayerWon : PlayerLost`). Recruit/switch are hidden; only Forfeit.
- **Raid** — both allies are on `state.player.team` (`[0]` challenger, `[1]` accepter); the viewer
  controls their own index, the boss is the shared foe, and the outcome is shared.

After submitting in a PvP/raid turn, the screen shows a "waiting for opponent" state (driven by whether
the viewer has a `battle_action` row).

## Rendering

`Scene` owns the Pixi stage and a pooled `Map<bigint, CharacterView>` for remotes plus a separate own
view. Remote views are store-driven; the **own view is prediction-driven** (it reads the predictor, not
the store). `CharacterView` is a pooled `AnimatedSprite` that mutates/lerps in place — it swaps texture
sets only on an `(action, facing)` change, never recreating sprites per frame. `tilemap.ts` draws the
const map once with `Graphics`. There's no camera; the fixed-size world is centered.

## Dev-only hooks

`test/introspect.ts` installs `window.__game()` (gated on `import.meta.env.DEV`) returning a JSON-safe
snapshot of authoritative state for the two-window Playwright e2e — so the e2e asserts on canonical game
state, not canvas pixels. `hud.ts` is a backtick-toggled debug overlay. Neither ships in production.

## Marshaling boundary

`convert.ts` translates between the SDK's tagged-union enum shapes and `client-wasm`'s plain-string
shapes. It is intentionally **not** DRY with the Rust types — duplicating a shape across a marshaling
boundary is a deliberate exception to DRY (a generated binding on one side, a hand-written converter on
the other) so the two layers can evolve independently. `monster.ts` similarly copies the bond/training
display caps; the server enforces the real caps.
