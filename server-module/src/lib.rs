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
    apply_move, derive_stats, load_species, npc_decide, poc_map, roll_starter, ActionState,
    Affinity, CharacterState, Direction, Millis, MonsterInstance, MoveInput, NpcParams, Potential,
    Species as CoreSpecies, SpeciesId, StatBlock, Temperament, TileMap, TilePos, Training,
    MOVE_QUEUE_CAP, STEP_MS,
};
use spacetimedb::rand::Rng;
use spacetimedb::{client_visibility_filter, Filter, Identity, ReducerContext, ScheduleAt, Table};
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
/// Active battle team size (3 active, rest in the box). `party_slot` is `0..PARTY_SIZE`.
const PARTY_SIZE: u8 = 3;

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

/// Species templates, seeded at `init` from the `game-core` RON content registry. Public + read-only
/// to clients (only the module writes it) so the client reads species data from its subscription
/// rather than duplicating content in TS. Mirrors `game_core::Species`.
#[spacetimedb::table(name = species, public)]
pub struct Species {
    #[primary_key]
    pub species_id: u32,
    pub name: String,
    pub base: StatBlock,
    pub primary_affinity: Affinity,
    pub secondary_affinity: Option<Affinity>,
    pub sprite_id: u32,
}

/// An owned, individual monster. Public so the owner's client renders its box/party; only the module
/// writes it, and every reducer authorizes against `owner_identity == ctx.sender`. `derived` is the
/// server-computed max stat block (the client reads it; the formula stays single-sourced in
/// game-core). `party_slot` is `None` in the box or `Some(0..PARTY_SIZE)` in the active team.
#[spacetimedb::table(name = monster, public)]
pub struct Monster {
    #[primary_key]
    #[auto_inc]
    pub monster_id: u64,
    /// Indexed: the hot "this player's monsters" query, and the basis for future scoped subs.
    #[index(btree)]
    pub owner_identity: Identity,
    pub species_id: u32,
    /// Player-given name; empty = fall back to the species name in the UI.
    pub nickname: String,
    pub level: u8,
    pub xp: u32,
    pub potential: Potential,
    pub temperament: Temperament,
    pub training: Training,
    pub bond: u16,
    pub current_hp: u16,
    pub derived: StatBlock,
    pub party_slot: Option<u8>,
}

/// Row-level security: a client only ever sees its OWN monsters over the subscription. The `monster`
/// table must be `public` for the SDK, but its rows carry hidden individuality (genes/`potential`,
/// `derived` stats, `current_hp`) that other players must not read — this scopes visibility to the
/// owner so that data never goes out on the wire. (RLS is experimental in 2.6.)
#[client_visibility_filter]
const MONSTER_VISIBILITY: Filter =
    Filter::Sql("SELECT * FROM monster WHERE owner_identity = :sender");

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

/// Validate + normalize a display/nick name (shared by `join_game` and `rename_monster`).
fn validate_name(name: &str) -> Result<String, String> {
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
    Ok(name.to_string())
}

/// Map a stored `species` row to the `game-core` template (so pure rules can consume it).
fn core_species(row: &Species) -> CoreSpecies {
    CoreSpecies {
        id: SpeciesId(row.species_id),
        name: row.name.clone(),
        base: row.base,
        primary_affinity: row.primary_affinity,
        secondary_affinity: row.secondary_affinity,
        sprite_id: row.sprite_id,
    }
}

/// Build a `monster` row from a freshly-rolled instance, computing its derived stats in game-core.
fn monster_row(
    owner: Identity,
    species: &CoreSpecies,
    inst: &MonsterInstance,
    party_slot: Option<u8>,
) -> Monster {
    let derived = derive_stats(
        species,
        &inst.potential,
        &inst.training,
        inst.temperament,
        inst.level,
    );
    Monster {
        monster_id: 0, // auto_inc
        owner_identity: owner,
        species_id: inst.species_id.0,
        nickname: inst.nickname.clone().unwrap_or_default(),
        level: inst.level.0,
        xp: inst.xp.0,
        potential: inst.potential,
        temperament: inst.temperament,
        training: inst.training,
        bond: inst.bond.0,
        current_hp: inst.current_hp,
        derived,
        party_slot,
    }
}

/// Grant a randomly-rolled starter monster to a player — but only on their FIRST join (monsters are
/// permanent and persist across reconnects, so a returning player keeps the ones they have).
fn grant_starter(ctx: &ReducerContext, owner: Identity) {
    if ctx.db.monster().owner_identity().filter(owner).count() > 0 {
        return;
    }
    let species: Vec<Species> = ctx.db.species().iter().collect();
    let Some(pick) = species.get(ctx.rng().gen_range(0..species.len().max(1))) else {
        return; // no species content seeded (shouldn't happen; init seeds it)
    };
    let core = core_species(pick);
    let mut next = || ctx.random::<u32>();
    let inst = roll_starter(&core, &mut next);
    ctx.db
        .monster()
        .insert(monster_row(owner, &core, &inst, Some(0)));
}

/// Look up a monster owned by the caller, or an error (used by ownership-checked monster reducers).
fn caller_monster(ctx: &ReducerContext, monster_id: u64) -> Result<Monster, String> {
    let monster = ctx
        .db
        .monster()
        .monster_id()
        .find(monster_id)
        .ok_or("monster not found")?;
    if monster.owner_identity != ctx.sender {
        return Err("not your monster".to_string());
    }
    Ok(monster)
}

// --- Reducers ------------------------------------------------------------------------------

/// Module setup: world config, the wandering NPC, and the movement scheduler.
#[spacetimedb::reducer(init)]
pub fn init(ctx: &ReducerContext) {
    ctx.db.config().insert(Config {
        id: 0,
        map_id: MAP_ID,
    });

    // Seed species content from the game-core RON registry (the table is the runtime cache; reducers
    // read from it rather than re-parsing). The content integrity test guarantees this is valid, so
    // a failure here is a broken-build invariant — fail loud.
    let species = load_species().expect("embedded species content must be valid");
    for s in species {
        ctx.db.species().insert(Species {
            species_id: s.id.0,
            name: s.name,
            base: s.base,
            primary_affinity: s.primary_affinity,
            secondary_affinity: s.secondary_affinity,
            sprite_id: s.sprite_id,
        });
    }

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
    let name = validate_name(&name)?;
    if ctx.db.player().identity().find(ctx.sender).is_some() {
        return Err("already joined".to_string());
    }

    let (entity_id, _pos) = spawn_character(ctx, SPRITE_PLAYER);
    ctx.db.player().insert(Player {
        identity: ctx.sender, // identity ONLY from the framework, never a client field
        entity_id,
        name,
        online: true,
        last_input_seq: 0,
    });

    // First-ever join grants a starter monster; returning players keep theirs.
    grant_starter(ctx, ctx.sender);
    Ok(())
}

/// Look up the caller's (player, character) for a queue-mutating reducer, enforcing a monotonic
/// `seq` ack. The caller mutates `ch.move_queue` then calls `commit_queue` to persist both rows.
fn caller_character(ctx: &ReducerContext, seq: u64) -> Result<(Player, Character), String> {
    let player = ctx
        .db
        .player()
        .identity()
        .find(ctx.sender)
        .ok_or("not in game")?;
    // The ack must be monotonic: a stale/replayed/decreasing seq could only wedge this client's
    // own reconciliation, so reject it rather than record it.
    if seq <= player.last_input_seq {
        return Err("stale input seq".to_string());
    }
    let ch = ctx
        .db
        .character()
        .entity_id()
        .find(player.entity_id)
        .ok_or("character missing")?;
    Ok((player, ch))
}

/// Persist a queue mutation: write the character row and advance the player's `seq` ack.
fn commit_queue(ctx: &ReducerContext, mut player: Player, ch: Character, seq: u64) {
    ctx.db.character().entity_id().update(ch);
    player.last_input_seq = seq;
    ctx.db.player().identity().update(player);
}

/// Append a movement intent to the caller's buffer (used to top the buffer up while holding a
/// direction). The move's outcome is computed later by `movement_tick` — the server never accepts
/// a client position. Rejects only when the queue is full (anti-flood); the client flow-controls.
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

/// Replace the caller's entire un-drained buffer with a single move. Used for a responsive
/// direction change (turn now rather than finishing buffered steps) and for the first move from
/// idle. The currently-animating step (already drained out of the queue) still completes.
#[spacetimedb::reducer]
pub fn set_move(ctx: &ReducerContext, input: MoveInput, seq: u64) -> Result<(), String> {
    let (player, mut ch) = caller_character(ctx, seq)?;
    ch.move_queue.clear();
    ch.move_queue.push(input);
    commit_queue(ctx, player, ch, seq);
    Ok(())
}

/// Clear the caller's un-drained buffer (e.g. when a non-movement action stops movement). The
/// currently-animating step still completes; the character goes idle on the next empty tick.
#[spacetimedb::reducer]
pub fn clear_queue(ctx: &ReducerContext, seq: u64) -> Result<(), String> {
    let (player, mut ch) = caller_character(ctx, seq)?;
    ch.move_queue.clear();
    commit_queue(ctx, player, ch, seq);
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

/// Rename one of the caller's monsters. Ownership + name validation enforced server-side.
#[spacetimedb::reducer]
pub fn rename_monster(ctx: &ReducerContext, monster_id: u64, name: String) -> Result<(), String> {
    let mut monster = caller_monster(ctx, monster_id)?;
    monster.nickname = validate_name(&name)?;
    ctx.db.monster().monster_id().update(monster);
    Ok(())
}

/// Move one of the caller's monsters between the box (`None`) and an active party slot
/// (`Some(0..PARTY_SIZE)`). Assigning an occupied slot bumps the current occupant to the box, so a
/// slot never holds two monsters. All within one transaction (atomic).
#[spacetimedb::reducer]
pub fn set_party_slot(
    ctx: &ReducerContext,
    monster_id: u64,
    slot: Option<u8>,
) -> Result<(), String> {
    let mut monster = caller_monster(ctx, monster_id)?;

    if let Some(s) = slot {
        if s >= PARTY_SIZE {
            return Err(format!("party slot must be 0..{PARTY_SIZE}"));
        }
        // Vacate the target slot if another of the caller's monsters holds it.
        let occupants: Vec<Monster> = ctx
            .db
            .monster()
            .owner_identity()
            .filter(ctx.sender)
            .filter(|m| m.monster_id != monster_id && m.party_slot == Some(s))
            .collect();
        for mut occ in occupants {
            occ.party_slot = None;
            ctx.db.monster().monster_id().update(occ);
        }
    }

    monster.party_slot = slot;
    ctx.db.monster().monster_id().update(monster);
    Ok(())
}
