# Milestone 4 — The Frontend (PixiJS + Prediction)

**Goal:** draw the world, capture input, and tie everything together with the **prediction +
reconciliation** loop — so your character moves the instant you press a key, while the server stays the
final authority. This is where the three big bets pay off visibly.

**Where it fits:** the frontend is the rest of the imperative shell. It subscribes to the server's
tables (truth in), calls reducers (intent out), runs the WASM rule locally (prediction), and renders.
It owns *no* game state — it's a view.

This is the largest chapter, because it's where all the pieces meet. We'll go: **connect → store →
marshal → render → predict → reconcile → route.**

## Connect and subscribe

The frontend opens a connection to SpacetimeDB and **subscribes** to the tables it needs. A
subscription is a live query: you get every current row, and every future change, pushed to you.<sup>[1](https://spacetimedb.com/docs/subscriptions/semantics/)</sup>

```typescript
const conn = DbConnection.builder()
  .withUri(uri)
  .withDatabaseName(moduleName)
  .onConnect((connection, id) => {
    connection
      .subscriptionBuilder()
      .onApplied(() => { /* initial rows delivered — safe to start the loop */ })
      .subscribe([
        'SELECT * FROM character',
        'SELECT * FROM player',
        'SELECT * FROM monster',
        'SELECT * FROM battle',
        // ...the rest of the ~15 world tables; subscription order doesn't matter...
      ]);
  })
  .build();
```

You write SQL-ish `SELECT`s, but you don't *query* repeatedly — you subscribe once and the server pushes
diffs. Row callbacks (insert / update / delete) fire as the world changes, and we funnel them into a
store. (The real builder also wires `onError`/`onDisconnect` handlers and resolves a connection promise
in `onApplied` — trimmed here for clarity.)

## The store: a read-only mirror of truth

All those callbacks write into one object, the `AuthoritativeStore`. Its defining rule is in its header
comment: *"the client's mirror of canonical server state — never mutated by prediction or rendering."*

```typescript
export class AuthoritativeStore {
  readonly characters = new Map<bigint, StoredCharacter>();
  readonly species = new Map<number, Species>();   // read-only content
  readonly monsters = new Map<bigint, Monster>();  // RLS-scoped: only *yours*
  battle: Battle | undefined;                      // RLS-scoped: at most one
  // ...
}
```

Two design choices worth calling out:

- **Everything is a keyed `Map`, not an array.** When you reconnect, the server re-delivers every row
  as a fresh "insert." Keyed by id, re-inserting is *idempotent* — you overwrite the same slot instead
  of duplicating. (A plain array would grow a second copy of every monster on every reconnect.)
- **A `StoredCharacter` records `receivedAt`** — the local `performance.now()` when the row arrived.
  We use that to smoothly interpolate *other* players' movement without needing the client and server
  clocks to agree<sup>[2](https://www.gabrielgambetta.com/entity-interpolation.html)</sup>. (We never
  sync clocks; we rebase to local time. More on that next.)

Consumers (the renderer, the predictor) **subscribe to the store's change events**; they read it, they
never write it. State flows one way: server → store → render.

## Marshaling the boundary

The SpacetimeDB SDK and the WASM module speak slightly different dialects. The SDK gives you camelCase
fields, `bigint` for 64-bit ids, and **tagged-union enums** like `{ tag: "West" }`. `game-core`/WASM
wants plain strings and `number`s. A small, deliberately boring file, `convert.ts`, translates between
them:

```typescript
export function facingToWasm(facing: Direction): WasmFacing {
  // Direction tags are North/South/East/West — identical spelling to the wasm strings.
  return facing.tag;
}

export function characterToWasm(c: Character): WasmCharacterState {
  return {
    pos: { x: c.tileX, y: c.tileY },
    facing: facingToWasm(c.facing),
    action: actionToWasm(c.action),
    move_started_at: Number(c.moveStartedAtMs),
  };
}
```

This boilerplate is *intentional*. The project has a rule — "DRY, but **not** across marshaling
boundaries" — that says: don't build a clever shared abstraction to dodge writing these conversions.
The two shapes belong to two different systems; coupling them to save a few lines would make a change
on either side ripple painfully. Keep it dumb and explicit.

### The one genuinely tricky conversion: rebasing time

The server stores `move_started_at` as **epoch milliseconds** (a huge number like 1.7 trillion). The
predictor's local drain logic asks "is `localNow - move_started_at >= stepMs`?" using
`performance.now()`, which starts at 0 when the page loads. Feed the raw epoch value in and the first
move would *never* drain. So we rebase:

```typescript
export function characterToPredictedBaseline(
  c: Character,
  localNow: number,
  stepMs: number,
): WasmCharacterState {
  const base = characterToWasm(c);
  base.move_started_at = Math.max(0, Math.floor(localNow) - stepMs * 2);
  return base;
}
```

We set the baseline to "two steps ago" in *local* time, so the first queued move is immediately due.
We `Math.floor` because `Millis` is a `u64` and a fractional value makes the WASM serde reject the
whole object. We `Math.max(0, ...)` because a negative `u64` is also rejected — and `localNow` can be
under two steps when you join in the first ~400 ms. Two tiny clamps, each guarding a real crash. This
is the "no clock sync" decision in action: instead of synchronizing clocks, we translate timestamps at
the boundary.

## Rendering: pool sprites, never recreate

Rendering is the hot path — it runs every frame. The cardinal rule of PixiJS performance is **reuse
display objects; mutate them; never recreate them per frame.**<sup>[3](https://pixijs.com/8.x/guides/concepts/performance-tips)</sup>
Each character gets one `CharacterView`
that owns one `AnimatedSprite`, created once:

```typescript
export class CharacterView {
  readonly sprite: AnimatedSprite;
  // ...
  constructor(anims: AnimationTextures, tileX: number, tileY: number) {
    const initial = anims['idle_south'] ?? Object.values(anims)[0] ?? [];
    this.sprite = new AnimatedSprite({
      textures: initial,
      animationSpeed: 0.12,
      loop: true,
      autoPlay: true,
      anchor: 0,
    });
    this.sprite.scale.set(TILE_PX / this.sprite.texture.width);
    this.#placeAt(tileX, tileY);
  }
```

When the character's action or facing changes, we **swap the texture set** on the existing sprite
rather than building a new one:

```typescript
  setAnimation(action: WasmAction, facing: WasmFacing): void {
    const key = animationKey(action, facing);  // e.g. "walk_south"
    if (key === this.#currentKey) return;       // no-op if unchanged
    const textures = this.#anims[key];
    if (!textures || textures.length === 0) return;
    this.#currentKey = key;
    this.sprite.textures = textures;            // reuse the sprite, swap frames
    this.sprite.play();
  }
```

And the smooth slide between tiles — the thing that makes integer-tile movement *look* continuous — is
pure rendering math, a linear interpolation from the previous tile to the target over `STEP_MS`:

```typescript
  #currentInterp(nowMs: number): { x: number; y: number } {
    const t = Math.min(1, Math.max(0, (nowMs - this.#startMs) / this.#durMs));
    return {
      x: this.#fromX + (this.#toX - this.#fromX) * t,
      y: this.#fromY + (this.#toY - this.#fromY) * t,
    };
  }
```

Remember: authoritative position is integer tiles. This fractional `x`/`y` exists *only* in the
renderer, only to please your eyes. It's never stored, never sent, and can never cause desync.

## The prediction loop

Now the payoff. Here's the heart of the per-frame loop in `main.ts`. It runs only once WASM is ready,
and only for our own character.

```typescript
if (stored) {
  const acked = net.ackedSeq();
  if (stored.receivedAt !== lastReceivedAt || acked !== lastAcked) {
    const diverged = predictor.reconcile(
      characterToPredictedBaseline(stored.row, now, step),
      moveQueueToWasm(stored.row.moveQueue),
      acked,
      now,
    );
    // If the server corrected our predicted tile, drop the committed direction so a still-held key
    // re-issues a move from the corrected position (otherwise the responsive `dir !== committedDir`
    // re-issue is skipped and movement can stall a step).
    if (diverged) committedDir = null;
    lastReceivedAt = stored.receivedAt;
    lastAcked = acked;
  }
```

When you press a direction, the loop predicts immediately — it calls the WASM `applyMove` locally and
your character moves *now*, before the server has even heard about it:

```typescript
  // `room` = is there space to send another move without overflowing the server's buffer? (We flow-
  // control against MOVE_QUEUE_CAP so the server never has to reject us for a full queue.)
  const room = stored.row.moveQueue.length + predictor.pendingCount < cap;

  const dir = input.heldDir();
  if (dir === null) {
    committedDir = null;
  } else if (dir !== committedDir) {
    // Direction changed (or first step from idle): replace the buffer with the new direction.
    committedDir = dir;
    if (predictor.lastQueuedDir() !== dir) {
      const seq = predictor.setMove({ Step: dir });
      net.setMove(wasmToSdkMoveInput({ Step: dir }), seq);
    }
  } else if (predictor.queueDepth === 0 && now - predictor.predicted.move_started_at >= step && room) {
    // Sustained hold: queue the NEXT step exactly when the current one completes.
    const seq = predictor.enqueue({ Step: dir });
    net.enqueueMove(wasmToSdkMoveInput({ Step: dir }), seq);
  }
  // Drain AFTER input so a step queued at completion starts this same frame.
  predictor.drain(now);
```

Every predicted move does two things at once: it updates the local prediction (`predictor.setMove`) and
it sends the intent to the server (`net.setMove`), tagged with a `seq`. The server will, a round-trip
later, confirm it.

## Reconciliation: how prediction stays honest

Prediction is a *guess*. Reconciliation is how we correct the guess against truth without the player
ever seeing a jolt — when the guess was right, which is almost always.<sup>[4](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html)</sup>
Here's the predictor's
`reconcile`, which you'll recognize from `game-core`'s determinism guarantee:

```typescript
reconcile(authState, authQueue, ackedSeq, now): boolean {
  const prevX = this.#predicted.pos.x;
  const prevY = this.#predicted.pos.y;
  this.#pending = this.#pending.filter((p) => p.seq > ackedSeq);  // drop confirmed ops
  let queue = [...authQueue];
  for (const p of this.#pending) queue = applyOp(queue, p.op);    // replay still-unacked ops
  this.#queue = queue;
  this.#predicted = authState;                                    // snap to server truth
  this.drain(now);                                                // re-run prediction forward
  return this.#predicted.pos.x !== prevX || this.#predicted.pos.y !== prevY;
}
```

Read it as a four-step ritual that runs whenever an authoritative update for our character arrives:

1. **Drop acked ops.** Anything the server has confirmed (`seq <= ackedSeq`) is no longer "pending."
2. **Reset to truth.** Throw away the predicted state and start from the server's authoritative state.
3. **Replay the unacked ops.** Re-apply the moves we've sent but the server hasn't confirmed yet, on
   top of truth — using the same `applyMove` rule.
4. **Re-drain to now.** Advance time forward.

Here's the beautiful part: because the client and server run **identical** code on **identical**
inputs (Bet 3!), step 4 almost always lands on the *exact tile we were already showing*. The
correction is invisible — we snap to truth and truth agrees with us. The function returns `false`:
no divergence.

It returns `true` only when the server genuinely disagreed — say it rejected a move because you'd hit
a wall the client mispredicted, or you were teleported. *That's* a real correction, and the loop
responds by clearing `committedDir` so a still-held key re-issues a fresh move from the corrected
position instead of stalling.

> **A real bug lived here.** For a while, `reconcile` didn't report divergence, so after a *correcting*
> reconcile while you held a key, the input could stall for one step before self-correcting. The fix
> was exactly this boolean return plus the `if (diverged) committedDir = null` line — and two unit
> tests to lock it in. It's a nice example of the whole architecture working *and* of how a subtle
> edge case hides in the seam between prediction and truth. We don't hide it; we document and test it.

## Routing: a screen-state machine

Finally, the app needs to switch between the overworld, the box, a battle, and so on. No framework, no
router library — just a tiny enum and a listener set (KISS):

```typescript
export type Screen = 'overworld' | 'box' | 'battle' | 'trade' | 'challenge';

export class ScreenManager {
  #current: Screen = 'overworld';
  #listeners = new Set<(s: Screen) => void>();
  set(screen: Screen): void {
    if (screen === this.#current) return;
    this.#current = screen;
    for (const fn of this.#listeners) fn(screen);
  }
}
```

One subtlety from the main loop: overlays (battle, box, trade) are **server-driven and handled before
the movement gate**, so they can always be *exited* — even if the predictor hasn't initialized or your
own-character row briefly drops on a reconnect. Otherwise a transient hiccup could trap you in a menu
with a dead Escape key. Little robustness details like this are most of what separates "works in the
demo" from "works."

## Common pitfalls

- **Mutating the store from the renderer or predictor.** The store is truth-in-only. Write to it from
  reducer callbacks alone; everything else reads.
- **Recreating Pixi objects each frame.** The fast path is mutate-in-place. New `Sprite`/`Texture`
  every frame will tank your frame rate.
- **Reconciling by overwriting position with the server's and stopping there.** You'd throw away your
  unacked moves and rubber-band constantly. You must *replay* the pending ops on top of truth.
- **Storing characters in an array.** Reconnect duplicates them. Key by id.
- **Forgetting the time rebase.** Feed epoch ms into local-clock drain logic and movement just...
  never happens. The bug is silent and baffling until you spot it.

## Alternatives & the honest verdict

- **Canvas2D or DOM instead of PixiJS.** DOM is trivially easy to start but doesn't animate pixel art
  smoothly and buckles under many moving sprites. Canvas2D is fine but you'd hand-roll sprite batching
  and pooling. **Verdict: PixiJS (WebGL/WebGPU) is the right tool for many animated sprites** — though for a
  handful of entities, Canvas2D would honestly have been simpler and plenty fast. We're building for
  the "many players" case.
- **A game framework (Phaser, Kaboom).** They bundle physics, tweens, scene management — lovely for a
  standalone game. But this project's custom prediction/reconciliation loop and SpacetimeDB
  subscription model don't slot neatly into a framework's lifecycle. **Verdict: a thin renderer we
  drive ourselves fits the architecture better than a framework we'd fight.**
- **A reactive UI framework (React/Vue) for the whole app.** Great for the menus, awkward for a 60 fps
  canvas loop. The project keeps menus as plain DOM overlays and the world as Pixi. **Verdict:
  reasonable as-is; if the UI grew much more complex, wrapping the *menus* (not the canvas) in a small
  reactive layer would be a fair improvement** — an honest "an alternative could be better here, at
  scale" call-out.

## Checkpoint

This is the big one: run the server (`spacetime start`, then publish), `wasm-pack build`, and `npm run
dev`. Open the page, enter a name, and **your character moves the instant you press an arrow key** —
no perceptible lag — while a second browser window shows you moving a beat later (the authoritative
update). Walk into a wall: you bump and turn, exactly as `apply_move` decreed, on both screens. You now
have a real, responsive, server-authoritative multiplayer prototype. Next we *prove* it stays in sync,
automatically.

## References

1. SpacetimeDB Docs — ["Subscription Semantics"](https://spacetimedb.com/docs/subscriptions/semantics/). *(The subscribe-once, server-pushes-diffs model.)*
2. Gabriel Gambetta — ["Entity Interpolation"](https://www.gabrielgambetta.com/entity-interpolation.html). *(Smoothly interpolating *other* entities without clock sync.)*
3. PixiJS — ["Performance Tips"](https://pixijs.com/8.x/guides/concepts/performance-tips) (v8). *(Minimizing per-frame work, draw calls, and resource churn — why we pool and mutate sprites.)*
4. Gabriel Gambetta — ["Client-Side Prediction and Server Reconciliation"](https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html). *(The reset-and-replay reconciliation our `Predictor` implements.)*
