//! SpacetimeDB 2.6 server module (authoritative game state).
//!
//! Reducers are intentionally THIN: look up rows, delegate ALL game logic to `game-core`
//! (`resolve_input` / `npc_decide`), write the result back. No game rules live here.
//!
//! Time columns are stored as `i64` milliseconds since the unix epoch (`*_ms`) so they
//! round-trip cleanly with `game_core::Millis`; the server's clock is the only authority for
//! the movement cooldown. Syntax confirmed against SpacetimeDB docs for the `spacetimedb`
//! crate 1.12.0 (which ships with CLI 2.6): `name =` table arg, `ctx.sender` field.

use game_core::{
    npc_decide, poc_map, resolve_input, ActionState, CharacterState, Direction, Millis, MoveInput,
    NpcParams, TileMap, TilePos, STEP_MS,
};
use spacetimedb::rand::Rng;
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

// --- Tuning constants ----------------------------------------------------------------------

const MAP_ID: u32 = 0;
/// How often the NPC scheduler fires, and how long between NPC steps.
const NPC_TICK_MS: u64 = 700;
const NPC_WANDER_RADIUS: i32 = 4;
const MAX_NAME_LEN: usize = 24;
const SPRITE_PLAYER: u32 = 0;
const SPRITE_NPC: u32 = 1;

// --- Tables --------------------------------------------------------------------------------

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
    /// Milliseconds since epoch when the current action began (cooldown authority).
    pub move_started_at_ms: i64,
    pub sprite_id: u32,
}

/// Links a connection's `Identity` to its character.
#[spacetimedb::table(name = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub entity_id: u64,
    pub name: String,
    pub online: bool,
    /// Last input sequence the server has applied — reconciliation ack only, never trusted.
    pub last_input_seq: u64,
}

/// Server-controlled wander state for an NPC entity.
#[spacetimedb::table(name = npc, public)]
pub struct Npc {
    #[primary_key]
    pub entity_id: u64,
    pub home_x: i32,
    pub home_y: i32,
    pub wander_radius: i32,
    /// Milliseconds since epoch when this NPC may next move.
    pub next_move_at_ms: i64,
}

/// Singleton world config.
#[spacetimedb::table(name = config, public)]
pub struct Config {
    #[primary_key]
    pub id: u32,
    pub map_id: u32,
}

/// Drives the NPC game loop. A row with an interval `scheduled_at` makes the scheduler call
/// `npc_tick` repeatedly.
#[spacetimedb::table(name = npc_tick_schedule, scheduled(npc_tick))]
pub struct NpcTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

// --- Helpers (no game rules — pure marshaling) ---------------------------------------------

/// The server clock in milliseconds since the unix epoch (the cooldown authority).
fn now_ms(ctx: &ReducerContext) -> u64 {
    ctx.timestamp.to_micros_since_unix_epoch().max(0) as u64 / 1000
}

/// Build the `game-core` logical state from a stored character row.
fn char_state(ch: &Character) -> CharacterState {
    CharacterState {
        pos: TilePos {
            x: ch.tile_x,
            y: ch.tile_y,
        },
        facing: ch.facing,
        action: ch.action,
        move_started_at: Millis(ch.move_started_at_ms.max(0) as u64),
    }
}

/// Copy a `game-core` result back onto a character row (does not write to the DB).
fn apply_state(ch: &mut Character, next: &CharacterState) {
    ch.tile_x = next.pos.x;
    ch.tile_y = next.pos.y;
    ch.facing = next.facing;
    ch.action = next.action;
    ch.move_started_at_ms = next.move_started_at.0 as i64;
}

/// A random walkable tile on `map`. Bounded retry, with a deterministic scan fallback so this
/// always terminates even on a pathological map.
fn random_walkable_tile(ctx: &ReducerContext, map: &TileMap) -> TilePos {
    for _ in 0..256 {
        let p = TilePos {
            x: ctx.rng().gen_range(0..map.width),
            y: ctx.rng().gen_range(0..map.height),
        };
        if map.is_walkable(p) {
            return p;
        }
    }
    for y in 0..map.height {
        for x in 0..map.width {
            let p = TilePos { x, y };
            if map.is_walkable(p) {
                return p;
            }
        }
    }
    TilePos { x: 0, y: 0 }
}

/// Spawn a fresh character at a random walkable tile and return the assigned `entity_id`.
fn spawn_character(ctx: &ReducerContext, sprite_id: u32) -> (u64, TilePos) {
    let pos = random_walkable_tile(ctx, &poc_map());
    let row = ctx.db.character().insert(Character {
        entity_id: 0, // auto_inc
        map_id: MAP_ID,
        tile_x: pos.x,
        tile_y: pos.y,
        facing: Direction::South,
        action: ActionState::Idle,
        move_started_at_ms: now_ms(ctx) as i64,
        sprite_id,
    });
    (row.entity_id, pos)
}

// --- Reducers ------------------------------------------------------------------------------

/// Module setup: world config, the wandering NPC, and the NPC scheduler.
#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config {
        id: 0,
        map_id: MAP_ID,
    });

    let (entity_id, pos) = spawn_character(ctx, SPRITE_NPC);
    ctx.db.npc().insert(Npc {
        entity_id,
        home_x: pos.x,
        home_y: pos.y,
        wander_radius: NPC_WANDER_RADIUS,
        next_move_at_ms: now_ms(ctx) as i64 + NPC_TICK_MS as i64,
    });

    ctx.db.npc_tick_schedule().insert(NpcTickSchedule {
        id: 0,
        scheduled_at: ScheduleAt::Interval(Duration::from_millis(NPC_TICK_MS).into()),
    });
}

#[spacetimedb::reducer(client_connected)]
pub fn client_connected(_ctx: &ReducerContext) {
    // Presence is established by `join_game`; nothing to do until the player spawns.
}

/// Despawn the disconnecting player's character + player rows.
#[spacetimedb::reducer(client_disconnected)]
pub fn client_disconnected(ctx: &ReducerContext) {
    if let Some(player) = ctx.db.player().identity().find(ctx.sender) {
        ctx.db.character().entity_id().delete(player.entity_id);
        ctx.db.player().identity().delete(ctx.sender);
    }
}

/// Join with a display name: validate, spawn at a random walkable tile, link the identity.
#[spacetimedb::reducer]
pub fn join_game(ctx: &ReducerContext, name: String) -> Result<(), String> {
    let name = name.trim();
    if name.is_empty() {
        return Err("name must not be empty".to_string());
    }
    if name.chars().count() > MAX_NAME_LEN {
        return Err(format!("name must be at most {MAX_NAME_LEN} characters"));
    }
    if name.chars().any(char::is_control) {
        return Err("name contains invalid characters".to_string());
    }
    if ctx.db.player().identity().find(ctx.sender).is_some() {
        return Err("already joined".to_string());
    }

    let (entity_id, _pos) = spawn_character(ctx, SPRITE_PLAYER);
    ctx.db.player().insert(Player {
        identity: ctx.sender, // identity ONLY from the framework, never a client field
        entity_id,
        name: name.to_string(),
        online: true,
        last_input_seq: 0,
    });
    Ok(())
}

/// Apply a movement intent. The server computes the outcome from authoritative state via
/// `game-core`; it never accepts a client-sent position. `seq` is reconciliation bookkeeping.
#[spacetimedb::reducer]
pub fn submit_input(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    let mut player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender)
        .ok_or("not in game")?;
    let mut ch = ctx
        .db
        .character()
        .entity_id()
        .find(player.entity_id)
        .ok_or("character missing")?;

    let next = resolve_input(
        &char_state(&ch),
        input,
        &poc_map(),
        Millis(now_ms(ctx)),
        STEP_MS,
    )
    .map_err(|e| format!("rejected input: {e:?}"))?;

    apply_state(&mut ch, &next);
    ctx.db.character().entity_id().update(ch);

    player.last_input_seq = seq;
    ctx.db.player().identity().update(player);
    Ok(())
}

/// Scheduled NPC game loop. Scheduler-only.
#[spacetimedb::reducer]
pub fn npc_tick(ctx: &ReducerContext, _schedule: NpcTickSchedule) -> Result<(), String> {
    // Reject any client that tries to drive the NPC loop directly.
    if ctx.sender != ctx.identity() {
        return Err("npc_tick is scheduler-only".to_string());
    }

    let now = now_ms(ctx);
    let map = poc_map();

    // Snapshot the due NPC ids first, so we don't mutate while iterating.
    let due: Vec<u64> = ctx
        .db
        .npc()
        .iter()
        .filter(|n| (n.next_move_at_ms.max(0) as u64) <= now)
        .map(|n| n.entity_id)
        .collect();

    for entity_id in due {
        let (Some(mut npc), Some(mut ch)) = (
            ctx.db.npc().entity_id().find(entity_id),
            ctx.db.character().entity_id().find(entity_id),
        ) else {
            continue;
        };

        let params = NpcParams {
            home: TilePos {
                x: npc.home_x,
                y: npc.home_y,
            },
            wander_radius: npc.wander_radius,
        };
        let input = npc_decide(&params, &char_state(&ch), &map, ctx.random());

        if let Ok(next) = resolve_input(&char_state(&ch), input, &map, Millis(now), STEP_MS) {
            apply_state(&mut ch, &next);
            ctx.db.character().entity_id().update(ch);
        }

        npc.next_move_at_ms = now as i64 + NPC_TICK_MS as i64;
        ctx.db.npc().entity_id().update(npc);
    }
    Ok(())
}
