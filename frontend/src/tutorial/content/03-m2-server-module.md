# Milestone 2 — The Server Brain (SpacetimeDB)

**Goal:** stand up the authoritative backend — the tables that hold the world's truth and the
**reducers** (server functions) that are the *only* way to change it. Make a character move, but make
the **server** decide every move, at a fixed pace, by calling the `game-core` rule we wrote.

**Where it fits:** this is the "imperative shell" on the server side. It owns state and effects;
`game-core` owns rules. The two meet in thin reducer functions.

## What SpacetimeDB is, in one minute

SpacetimeDB is a database where **your game logic runs inside the database.** You define **tables**
(like SQL tables, but declared as Rust structs) and **reducers** (Rust functions that run in a
transaction and are the only things allowed to write tables). Clients don't send SQL; they **call
reducers** and **subscribe to tables**. When a reducer changes a row, every subscribed client gets the
update pushed to it live.

Two properties make this a great fit for an authoritative multiplayer game:

1. **Reducers are transactional.** A reducer either commits fully or, if it returns an error, aborts
   with no changes. That gives us atomic multi-row operations for free (fusing two monsters into one,
   swapping ownership in a trade) — no half-finished states.
2. **The client can only express intent.** It calls `enqueue_move(Step(North))`; it cannot reach in
   and set its own position. The server computes the result. That's Bet 1, enforced by the platform.

## A table is a Rust struct

Here's the core entity — a character on the map — from `server-module/src/lib.rs`:

```rust
/// One renderable entity (player or NPC). Public: clients subscribe to render everyone.
#[spacetimedb::table(name = character, public)]
pub struct Character {
    #[primary_key]
    #[auto_inc]
    pub entity_id: u64,
    pub map_id: u32,
    pub tile_x: i32,
    pub tile_y: i32,
    pub facing: Direction,
    pub action: ActionState,
    /// Milliseconds since epoch when the current move started (drives the slide animation).
    pub move_started_at_ms: i64,
    pub sprite_id: u32,
    /// Bounded FIFO of pending moves, drained one per `movement_tick`.
    pub move_queue: Vec<MoveInput>,
}
```

Read the attributes:

- `#[spacetimedb::table(name = character, public)]` declares a table named `character`. **`public`**
  means every client can subscribe to and read its rows — correct here, because everyone needs to see
  everyone else to render the world.
- `#[primary_key]` + `#[auto_inc]` make `entity_id` a unique, server-assigned id.
- The fields are *flattened* world state: tile coordinates, facing, action, and the **move queue**.

Notice the types: `facing: Direction`, `action: ActionState`, `move_queue: Vec<MoveInput>` — those are
the **exact `game-core` enums** from Milestone 1. Because they derive `SpacetimeType` (under the
server's feature flag), they drop straight into a table column with no re-declaration. The shared type
*is* the schema.

### Public, but not readable by enemies

A second table introduces a crucial distinction:

```rust
/// A wild-encounter table row ... PRIVATE: the client never needs the spawn table.
#[spacetimedb::table(name = encounter)]
pub struct Encounter {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub zone_id: u32,
    pub species_id: u32,
    pub weight: u32,
    pub min_level: u8,
    pub max_level: u8,
}
```

No `public`. This table is **private** — the server reads it, clients never see it. The spawn
weights, the catch-rate tables, anything a cheater could exploit by reading: keep it private. (We'll
meet a third, subtler option — *public table, row-level filtered* — when monsters need to be visible
to their owner but nobody else.)

`#[index(btree)]` on `zone_id` is a performance note: it lets the server find "all encounters in this
zone" without scanning the whole table. We add indexes on the columns we filter by.

## A reducer: thin, validated, delegating

Here is the reducer a client calls to ask to move. Read it against Bet 1.

```rust
/// Append a movement intent to the caller's buffer ... The move's outcome is computed later by
/// `movement_tick` — the server never accepts a client position. Rejects only when the queue is
/// full (anti-flood); the client flow-controls.
#[spacetimedb::reducer]
pub fn enqueue_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    let (player, mut ch) = caller_character(ctx, seq)?;
    if ch.move_queue.len() >= MOVE_QUEUE_CAP {
        return Err("move queue full".to_string());
    }
    ch.move_queue.push(input);
    commit_queue(ctx, player, ch, seq);
    Ok(())
}
```

### How it works

- The signature returns `Result<(), String>`. Return `Ok(())` and the transaction commits; return
  `Err(...)` and SpacetimeDB **rolls the whole thing back.** That `Err` is our transactional escape
  hatch — any validation failure aborts cleanly.
- `ctx: &ReducerContext` is the server-provided context. The critical field is **`ctx.sender`**: the
  identity of the calling client, set by SpacetimeDB itself. We **never** take the caller's identity
  from a function argument — that would let a client claim to be someone else. Identity comes from the
  platform, full stop.
- `caller_character(ctx, seq)?` looks up *the sender's own* character and enforces a monotonic
  sequence number (more on that below). The `?` propagates any error, aborting the reducer.
- Then the only mutation: push the intent onto the queue. The reducer **does not move the character.**
  It doesn't even check whether the move is legal. It just records "this player wants to do this." The
  outcome is computed later, by the tick, by `game-core`.

This is the thin-reducer discipline: look up rows, validate authorization, delegate the *rule* to
`game-core`, write the result. The module's own header comment says it outright: *"No game rules live
here."*

### The sequence-number guard

```rust
fn caller_character(ctx: &ReducerContext, seq: u64) -> Result<(Player, Character), String> {
    let player = ctx.db.player().identity().find(ctx.sender).ok_or("not in game")?;
    // The ack must be monotonic: a stale/replayed/decreasing seq could only wedge this client's
    // own reconciliation, so reject it rather than record it.
    if seq <= player.last_input_seq {
        return Err("stale input seq".to_string());
    }
    let ch = ctx.db.character().entity_id().find(player.entity_id).ok_or("character missing")?;
    Ok((player, ch))
}
```

Each input carries a `seq` that must strictly increase. This is the handshake that lets the client
reconcile its prediction against the server later: the server echoes back "I've accepted everything up
to seq N," and the client knows which of its predicted moves are now confirmed. Rejecting a stale seq
also defends against replayed or out-of-order messages. Notice the lookups go through `ctx.db` with
*accessors* — `ctx.db.player()`, `ctx.db.character()` — the snake_case table names, not the struct
names.

## The heartbeat: a scheduled reducer

Movement is **server-paced**. Clients fill a queue; the server drains it one step per `STEP_MS`, no
matter how fast a client spams. That pacing comes from a **scheduled reducer** — a reducer the database
calls itself on a timer.

You opt in by declaring a special table:

```rust
/// Drives the movement loop. A row with an interval `scheduled_at` makes the scheduler call
/// `movement_tick` every `STEP_MS`.
#[spacetimedb::table(name = movement_tick_schedule, scheduled(movement_tick))]
pub struct MovementTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}
```

The `scheduled(movement_tick)` part wires this table to a reducer. Insert one row with an *interval*
schedule (we do this in `init`, below) and SpacetimeDB calls `movement_tick` every 200 ms forever.
Here's the tick (abridged to its spine):

```rust
#[spacetimedb::reducer]
pub fn movement_tick(ctx: &ReducerContext, _schedule: MovementTickSchedule) -> Result<(), String> {
    // Reject any client that tries to drive the movement loop directly.
    if ctx.sender != ctx.identity() {
        return Err("movement_tick is scheduler-only".to_string());
    }

    let now = now_ms(ctx);
    let map = poc_map();
    let ids: Vec<u64> = ctx.db.character().iter().map(|c| c.entity_id).collect();

    for entity_id in ids {
        let Some(mut ch) = ctx.db.character().entity_id().find(entity_id) else { continue };
        // (NPCs refill their own queue here — see Milestone 1's npc_decide.)

        if ch.move_queue.is_empty() {
            if ch.action != ActionState::Idle {
                ch.action = ActionState::Idle;
                ctx.db.character().entity_id().update(ch);
            }
        } else {
            let input = ch.move_queue.remove(0);
            let next = apply_move(&char_state(&ch), input, &map, Millis(now));
            apply_state(&mut ch, &next);
            ctx.db.character().entity_id().update(ch);
        }
    }
    Ok(())
}
```

### How it works, and the security in it

- **The scheduler guard.** A scheduled reducer is still, technically, a reducer a malicious client
  could try to call directly — which would let them tick the world faster. So the very first line is
  `if ctx.sender != ctx.identity()`: `ctx.identity()` is the *module's own* identity (the scheduler
  runs as the module), and `ctx.sender` is whoever called. If they differ, a client is calling it —
  reject. **Every scheduler-only reducer needs this guard.**
- **Drain one, call the rule.** For each character with a queued move, it pops one move and calls
  `apply_move(...)` — the same pure function the browser will run for prediction. The server gets time
  from `now_ms(ctx)` (derived from `ctx.timestamp`, the authoritative clock) and passes it in, exactly
  as Milestone 1 designed. The result is written back with `.update(...)`.
- **One tile per tick.** Because the queue drains one move per 200 ms tick, a character moves at most
  one tile per 200 ms — *regardless of how many `enqueue_move` calls a client fires.* That's the rate
  limit, and it lives in the cadence, not in a per-call cooldown. A flooding client just fills its
  queue (capped at `MOVE_QUEUE_CAP`) and gets `Err("move queue full")`.

> Notice `apply_move` is imported from `game-core` and run here *byte-for-byte* the same as it'll run
> in the browser. This single shared call is the entire reason prediction works. If you ever see a
> movement rule written in this file, that's the golden rule being broken.

## Bootstrapping: `init` and presence

The `init` reducer runs once when the module is first published. It seeds content (we'll lean on this
heavily once monsters exist), spawns the wandering NPC, and — the part that matters now — **starts the
heartbeat** by inserting that schedule row:

```rust
#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config { id: 0, map_id: MAP_ID });
    // ... (content seeding arrives in Milestone 6) ...
    ctx.db.movement_tick_schedule().insert(MovementTickSchedule {
        id: 0,
        scheduled_at: ScheduleAt::Interval(Duration::from_millis(STEP_MS).into()),
    });
}
```

Two lifecycle reducers handle presence. `client_connected` does almost nothing (we wait for the player
to actually `join_game`); `client_disconnected` cleans up — despawns the character, and later forfeits
any ongoing PvP battle. And `join_game` validates a display name and spawns the player:

```rust
#[spacetimedb::reducer]
pub fn join_game(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let name = validate_name(&name)?;
    if ctx.db.player().identity().find(ctx.sender).is_some() {
        return Err("already joined".to_string());
    }
    let (entity_id, _pos) = spawn_character(ctx, SPRITE_PLAYER);
    ctx.db.player().insert(Player {
        identity: ctx.sender, // identity ONLY from the framework, never a client field
        entity_id,
        name: name.clone(),
        online: true,
        last_input_seq: 0,
    });
    // ... (starter monster + items arrive in Milestone 6) ...
    Ok(())
}
```

That `identity: ctx.sender` comment is the whole security model in one line.

## Building and the bindings

Two commands turn this into a running backend and a typed client API:

```bash
# Compile + publish the module to your local SpacetimeDB node:
spacetime publish -p server-module -s local monster-tamer-mmo

# Generate TypeScript bindings from the live schema into the frontend:
spacetime generate --lang typescript \
  --out-dir frontend/src/module_bindings --module-path server-module
```

The second command is important and easy to forget: it reads your tables and reducers and writes
**TypeScript types and reducer-call functions** into the frontend. Those generated bindings are how
the client talks to the server in a type-safe way — and they're regenerated from the schema, never
hand-written, so the two sides can't drift. **Every schema change means re-running `generate`.**

## Common pitfalls

- **Taking identity from an argument.** `fn do_thing(ctx, who: Identity, ...)` is a security hole — a
  client passes any `who` it likes. Always use `ctx.sender`.
- **Forgetting the scheduler guard.** Without `ctx.sender != ctx.identity()`, a client can call your
  tick directly. Every scheduled reducer needs it.
- **Clamping instead of rejecting.** It's tempting to silently fix bad input ("the queue's full, I'll
  just drop the oldest"). Don't — return `Err`. A strict server is a debuggable, attack-resistant
  server. (This is "Postel's Law, inverted": be *strict* in what you accept.)
- **Editing the generated bindings.** They're overwritten on every `generate`. Never hand-edit them.
- **Mutating a table while iterating it.** The tick snapshots `entity_id`s into a `Vec` first, *then*
  loops — modifying a table mid-iteration is asking for trouble.

## Alternatives & the honest verdict

- **A conventional stack (Node/Postgres + WebSockets).** Totally viable, and far more people know it.
  You'd hand-write the WebSocket protocol, the subscription/diffing layer, the transaction handling,
  and the row-level security — all of which SpacetimeDB gives you built in. **Verdict: for *this*
  project, SpacetimeDB removes a mountain of plumbing and keeps rules-in-Rust seamless. But it's a
  younger, less familiar platform** — if your team already runs Postgres in production and values
  boring reliability over reduced boilerplate, the conventional stack is a defensible, arguably safer
  choice. We're honestly trading maturity for fit.
- **An external cron/job runner for the tick** instead of a scheduled reducer. That puts your heartbeat
  outside the transactional system and adds an integration to babysit. The in-database scheduled
  reducer is transactional, co-located with the data, and guarded. **Verdict: the scheduled reducer is
  clearly better here.**
- **Trusting the client's position and validating it server-side.** Some games do send positions and
  "sanity-check" them. That's strictly more attack surface than never accepting a position at all.
  **Verdict: intent-only is the safer design, and it's free for us.**

## Checkpoint

`spacetime publish` succeeds and `spacetime generate` writes files into `frontend/src/module_bindings`.
Using `spacetime sql`, you can see the `movement_tick_schedule` row exists and that calling `join_game`
(via the CLI's reducer-call) inserts exactly one `player` and one `character` for your identity. The
NPC visibly wanders when you query its position over time. You have a living, authoritative world — it
just has no eyes yet. Next we give the browser the ability to *predict* this world so it feels instant.
