//! SpacetimeDB 2.6 server module (authoritative game state).
//!
//! Reducers are intentionally THIN: look up rows, delegate ALL game logic to `game-core`
//! (`apply_move` / `npc_decide`), write the result back. No game rules live here.
//!
//! Movement is **server-paced**: each character has a bounded `move_queue`; the scheduled
//! `movement_tick` drains one move per character every `STEP_MS` (so a character advances at most
//! one tile per tick, regardless of how fast a client sends). `enqueue_move` only adds to the
//! queue (rejecting when full = anti-flood); the move's outcome is computed at drain time.
//!
//! Time columns are `i64` milliseconds since the unix epoch (`*_ms`) to round-trip with
//! `game_core::Millis`. Syntax is for `spacetimedb` crate 1.12.0 (CLI 2.6): `name =`, `ctx.sender`.

use game_core::{
    apply_move, npc_decide, poc_map, ActionState, CharacterState, Direction, Millis, MoveInput,
    NpcParams, TileMap, TilePos, MOVE_QUEUE_CAP, STEP_MS,
};
use spacetimedb::rand::Rng;
use spacetimedb::{Identity, ReducerContext, ScheduleAt, Table};
use std::time::Duration;

// --- Tuning constants ----------------------------------------------------------------------

const MAP_ID: u32 = 0;
/// How often an NPC enqueues a wander move (its queue is drained at the tick cadence like
/// everyone else, but it only refills this often, so it pauses between wanders).
const NPC_STEP_MS: u64 = 700;
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
    /// Milliseconds since epoch when the current move started (drives the slide animation).
    pub move_started_at_ms: i64,
    pub sprite_id: u32,
    /// Bounded FIFO of pending moves, drained one per `movement_tick`. Public so the client can
    /// flow-control (never enqueue past `MOVE_QUEUE_CAP`) and reconcile against it.
    pub move_queue: Vec<MoveInput>,
}

/// Links a connection's `Identity` to its character.
#[spacetimedb::table(name = player, public)]
pub struct Player {
    #[primary_key]
    pub identity: Identity,
    pub entity_id: u64,
    pub name: String,
    pub online: bool,
    /// Highest enqueue `seq` the server has accepted — the reconciliation ack. Never trusted for
    /// authority.
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
    /// Milliseconds since epoch when this NPC may next enqueue a wander move.
    pub next_move_at_ms: i64,
}

/// Singleton world config.
#[spacetimedb::table(name = config, public)]
pub struct Config {
    #[primary_key]
    pub id: u32,
    pub map_id: u32,
}

/// Drives the movement loop. A row with an interval `scheduled_at` makes the scheduler call
/// `movement_tick` every `STEP_MS`.
#[spacetimedb::table(name = movement_tick_schedule, scheduled(movement_tick))]
pub struct MovementTickSchedule {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub scheduled_at: ScheduleAt,
}

// --- Helpers (no game rules — pure marshaling) ---------------------------------------------

/// The server clock in milliseconds since the unix epoch.
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

/// Copy a `game-core` result back onto a character row (does not write to the DB or the queue).
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
        move_queue: Vec::new(),
    });
    (row.entity_id, pos)
}

// --- Reducers ------------------------------------------------------------------------------

/// Module setup: world config, the wandering NPC, and the movement scheduler.
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
        next_move_at_ms: now_ms(ctx) as i64,
    });

    ctx.db
        .movement_tick_schedule()
        .insert(MovementTickSchedule {
            id: 0,
            scheduled_at: ScheduleAt::Interval(Duration::from_millis(STEP_MS).into()),
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

/// Buffer a movement intent for the caller's character. The move's outcome is computed later by
/// `movement_tick`; the server never accepts a client-sent position. Rejects only when the queue
/// is full (anti-flood) — the client flow-controls so it normally has room. `seq` acks the enqueue.
#[spacetimedb::reducer]
pub fn enqueue_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
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

    // The ack must be monotonic: a stale/replayed/decreasing seq could only wedge this client's
    // own reconciliation, so reject it rather than record it.
    if seq <= player.last_input_seq {
        return Err("stale input seq".to_string());
    }
    if ch.move_queue.len() >= MOVE_QUEUE_CAP {
        return Err("move queue full".to_string());
    }
    ch.move_queue.push(input);
    ctx.db.character().entity_id().update(ch);

    player.last_input_seq = seq;
    ctx.db.player().identity().update(player);
    Ok(())
}

/// Scheduled, server-paced movement loop. Scheduler-only. Each tick: NPCs refill their queue when
/// empty and due; then every character drains one queued move (or goes Idle if empty).
#[spacetimedb::reducer]
pub fn movement_tick(ctx: &ReducerContext, _schedule: MovementTickSchedule) -> Result<(), String> {
    // Reject any client that tries to drive the movement loop directly.
    if ctx.sender != ctx.identity() {
        return Err("movement_tick is scheduler-only".to_string());
    }

    let now = now_ms(ctx);
    let map = poc_map();

    // Snapshot ids first so we don't mutate the table while iterating it.
    let ids: Vec<u64> = ctx.db.character().iter().map(|c| c.entity_id).collect();

    for entity_id in ids {
        let Some(mut ch) = ctx.db.character().entity_id().find(entity_id) else {
            continue;
        };

        // NPCs are server-driven: refill the queue with a wander move when empty and due.
        if let Some(mut npc) = ctx.db.npc().entity_id().find(entity_id) {
            if ch.move_queue.is_empty() && (npc.next_move_at_ms.max(0) as u64) <= now {
                let params = NpcParams {
                    home: TilePos {
                        x: npc.home_x,
                        y: npc.home_y,
                    },
                    wander_radius: npc.wander_radius,
                };
                ch.move_queue
                    .push(npc_decide(&params, &char_state(&ch), &map, ctx.random()));
                npc.next_move_at_ms = now as i64 + NPC_STEP_MS as i64;
                ctx.db.npc().entity_id().update(npc);
            }
        }

        if ch.move_queue.is_empty() {
            // Idle: only write if the animation state actually needs to change.
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
