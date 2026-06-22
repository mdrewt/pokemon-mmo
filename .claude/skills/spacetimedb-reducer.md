---
name: spacetimedb-reducer
description: Writing or modifying SpacetimeDB reducers, table definitions, schema changes, or server-module Rust code
---

# SpacetimeDB 2.6 Reducer Authoring

> Before writing or changing server code, fetch current docs:
> `gitmcp-spacetimedb` MCP server → SpacetimeDB 2.6 API

## Reducer contract

- Return `Result<(), String>` (or `Result<(), MyError>`). An `Err` aborts the transaction — use it.
- Deterministic and side-effect-free except for table writes. No `std::net`, `std::fs`, no mutable globals.
- All state lives in tables. SpacetimeDB may re-execute on serialization conflicts.
- Time: `ctx.timestamp` — never `std::time`. Randomness: `ctx.rng()` — never `rand::thread_rng()`.
- Identity: `ctx.sender()` — never trust a field the client passes.

## Validation checklist (every reducer that takes client input)

1. `ctx.sender()` owns or is authorized for the target entity
2. Resources/cooldowns are sufficient (read from authoritative table rows)
3. Input is within valid range — reject with `Err`, never silently clamp
4. Rate limiting: reject flooding (e.g. repeated fire calls) with a cooldown check

```rust
pub fn move_player(ctx: &ReducerContext, target: Vector2) -> Result<(), String> {
    let sender = ctx.sender();
    let mut player = ctx.db.player()
        .identity()
        .find(sender)
        .ok_or("player not found")?;

    // Validate — server recomputes, never trusts the client's arithmetic
    let distance = (target - player.position).length();
    if distance > MAX_MOVE_DISTANCE {
        return Err(format!("move distance {} exceeds limit", distance));
    }

    player.position = target;
    ctx.db.player().identity().update(player);
    Ok(())
}
```

## Table definitions

- Struct fields must be `pub`. Custom column types need `#[derive(SpacetimeType)]`.
- Table access: snake_case accessors — `ctx.db.player()`, not `ctx.db.Player`.
- Add `use spacetimedb::Table` when calling `insert`, `iter`, `get_by_id`, `update`.
- `#[primarykey]` columns autogenerate identity-based lookup methods.

## Scheduled reducers

Use a scheduled table for the game loop — scheduling is transactional:

```rust
#[table(name = tick_schedule, scheduled(game_tick))]
pub struct TickSchedule {
    #[primarykey]
    #[autoinc]
    pub scheduled_id: u64,
    pub scheduled_at: spacetimedb::Timestamp,
}
```

Guard against client calls:
```rust
pub fn game_tick(ctx: &ReducerContext, _: TickSchedule) -> Result<(), String> {
    if ctx.sender() != ctx.identity() {
        return Err("scheduler only".into());
    }
    // ... game logic from game-core ...
    Ok(())
}
```

## Schema change checklist

After ANY table/type change:
1. `spacetime publish -p server-module monster-tamer-mmo`
2. `spacetime generate --lang typescript --out-dir frontend/src/module_bindings --project-path server-module`
3. Rebuild client WASM if `game-core` types changed: `wasm-pack build client-wasm --target bundler`

## game-core boundary

The reducer is a thin shell around `game-core`. The rule: **game logic lives in `game-core`**. The reducer:
1. Reads authoritative state from tables
2. Calls the pure `game-core` function with that state + client intent
3. Writes the result back to tables

Never re-implement a rule in the reducer that belongs in `game-core`.
