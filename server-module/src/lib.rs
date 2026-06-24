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
    apply_care, apply_move, apply_training, attempt_recruit as recruit_succeeds, battle_xp_reward,
    derive_stats, encounter_triggers, level_bounds, load_encounters, load_items, load_skills,
    load_species, load_type_chart, npc_decide, pick_best_skill, poc_map, recruit_chance,
    resolve_enemy_turn, resolve_player_swap, resolve_turn, roll_individuality, roll_starter,
    xp_for_level, ActionState, Affinity, BattleEvent, BattleMonster, BattleOutcome, BattleSide,
    BattleState, Bond, Category, CharacterState, Direction, Effectiveness, EncounterTable, Level,
    Millis, MonsterInstance, MoveInput, NpcParams, Potential, Skill as CoreSkill,
    Species as CoreSpecies, SpeciesId, Stat, StatBlock, Temperament, TileMap, TilePos, Training,
    TypeChart, Xp, MAX_VARIANCE_ROLL, MOVE_QUEUE_CAP, STEP_MS,
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
/// The single POC encounter zone (the tall-grass table). Multi-zone is a later, multi-map concern.
const ENCOUNTER_ZONE: u32 = 0;
/// The bait item id (mirrors `items.ron`) and how many a player is granted on first join.
const BAIT_ITEM_ID: u32 = 1;
const STARTER_BAIT_QTY: u32 = 5;
/// How many of each training food a player is granted on first join (enough to feel the divergence).
const STARTER_FOOD_QTY: u32 = 3;
/// Bond a freshly-recruited monster starts with (a touch above a hatchling — you befriended it).
const RECRUIT_BOND: u16 = 25;
/// Active care: minimum gap between `care_for_monster` calls, and the bond it grants (active-only
/// raising — a deliberate, cooldown-gated action, never an idle tick).
const CARE_COOLDOWN_MS: i64 = 30_000;
const CARE_BOND_GAIN: u16 = 5;

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
    /// Indexed: the movement tick maps a moved character back to its owning player (grass-encounter
    /// trigger) without scanning the table.
    #[index(btree)]
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
    /// Skill ids this species can use in battle (the client lists them from the `skill` table).
    pub skills: Vec<u32>,
    /// Base recruit chance in permille at full HP (the client can show catch difficulty). Mirrors
    /// `game_core::Species::recruit_rate`.
    pub recruit_rate: u16,
}

/// Skill templates, seeded at init from the game-core registry. Public read-only content so the
/// client shows skill names/power/affinity in the battle menu.
#[spacetimedb::table(name = skill, public)]
pub struct Skill {
    #[primary_key]
    pub skill_id: u32,
    pub name: String,
    pub affinity: Affinity,
    pub category: Category,
    pub power: u16,
}

/// The type/affinity chart as rows, seeded at init. Public so the client can show effectiveness
/// hints (a lookup on this data, not a duplicated rule). Any unlisted pair is Neutral.
#[spacetimedb::table(name = type_relation, public)]
pub struct TypeRelationRow {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    pub attack: Affinity,
    pub defend: Affinity,
    pub effect: Effectiveness,
}

/// A wild-encounter table row (one per possible spawn in a zone), seeded at init from the game-core
/// RON registry. PRIVATE: the client never needs the spawn table; the server reads it to roll a wild
/// on a grass step (the table is the cache — no per-tick RON parse).
#[spacetimedb::table(name = encounter)]
pub struct Encounter {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    /// Which zone this entry belongs to (indexed for the future multi-zone lookup; POC uses one).
    #[index(btree)]
    pub zone_id: u32,
    pub species_id: u32,
    pub weight: u32,
    pub min_level: u8,
    pub max_level: u8,
}

/// Item templates, seeded at init from the game-core registry. Public read-only content so the
/// client can show item names. Mirrors `game_core::Item`.
#[spacetimedb::table(name = item, public)]
pub struct Item {
    #[primary_key]
    pub item_id: u32,
    pub name: String,
    /// Recruit-chance bonus in permille when used during a recruit attempt (bait).
    pub recruit_bonus: u16,
    /// The stat this food trains (`None` = not food), and the investment it grants. Mirrors
    /// `game_core::Item`.
    pub train_stat: Option<Stat>,
    pub train_amount: u16,
}

/// A player's owned quantity of an item. Public so the owner's client shows counts; RLS-scoped to the
/// owner. Every reducer authorizes against `owner_identity == ctx.sender`.
#[spacetimedb::table(name = player_item, public)]
pub struct PlayerItem {
    #[primary_key]
    #[auto_inc]
    pub id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub item_id: u32,
    pub quantity: u32,
}

/// A client only ever sees its own item rows.
#[client_visibility_filter]
const PLAYER_ITEM_VISIBILITY: Filter =
    Filter::Sql("SELECT * FROM player_item WHERE owner_identity = :sender");

/// A player's active battle (at most one). Stores the whole authoritative `BattleState`; the client
/// reads it to render and submits actions. RLS-scoped to the owner (it carries the player's monster
/// stats).
#[spacetimedb::table(name = battle, public)]
pub struct Battle {
    #[primary_key]
    pub player_identity: Identity,
    pub state: BattleState,
    pub enemy_level: u8,
    /// The player party's `monster_id`s in `state.player.team` order, so post-turn HP can be written
    /// back to the right monster rows (persistent HP).
    pub party_monster_ids: Vec<u64>,
    /// The wild enemy's rolled individuality, kept so a successful recruit reconstructs *this exact*
    /// monster (not a fresh re-roll). The wild is `state.enemy`'s single active member.
    pub wild_potential: Potential,
    pub wild_temperament: Temperament,
    /// The most recent turn's log events (attacks with damage, faints) — the client renders them.
    pub last_events: Vec<BattleEvent>,
    /// XP the party gained on the most recent win (0 otherwise), and whether any party monster
    /// leveled up — shown on the victory screen.
    pub last_xp_gain: u32,
    pub leveled_up: bool,
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
    /// XP at the start of the current level and the total needed to reach the next (server-derived
    /// from `xp` via game-core, so the client can show a progress bar without the curve). At the
    /// level cap `xp_next == xp_floor`.
    pub xp_floor: u32,
    pub xp_next: u32,
    pub potential: Potential,
    pub temperament: Temperament,
    pub training: Training,
    pub bond: u16,
    pub current_hp: u16,
    pub derived: StatBlock,
    pub party_slot: Option<u8>,
    /// Milliseconds since epoch of the last `care_for_monster` (0 = never). Gates the care cooldown
    /// — active-only raising, never an idle accrual.
    pub last_care_at_ms: i64,
}

/// Row-level security: a client only ever sees its OWN monsters over the subscription. The `monster`
/// table must be `public` for the SDK, but its rows carry hidden individuality (genes/`potential`,
/// `derived` stats, `current_hp`) that other players must not read — this scopes visibility to the
/// owner so that data never goes out on the wire. (RLS is experimental in 2.6.)
#[client_visibility_filter]
const MONSTER_VISIBILITY: Filter =
    Filter::Sql("SELECT * FROM monster WHERE owner_identity = :sender");

/// A player sees only their own battle (it carries their monsters' stats).
#[client_visibility_filter]
const BATTLE_VISIBILITY: Filter =
    Filter::Sql("SELECT * FROM battle WHERE player_identity = :sender");

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
        skills: row.skills.iter().map(|&s| game_core::SkillId(s)).collect(),
        recruit_rate: row.recruit_rate,
    }
}

/// The level-dependent monster columns derived from an XP total: `(level, xp_floor, xp_next, derived
/// stats)`. The SSOT for these stored-but-derived fields; recompute whenever `xp` changes so the
/// client can read level/progress/stats without reimplementing the curve or stat formula.
fn level_fields(
    species: &CoreSpecies,
    xp: u32,
    potential: &Potential,
    training: &Training,
    temperament: Temperament,
) -> (u8, u32, u32, StatBlock) {
    let (level, floor, next) = level_bounds(Xp(xp));
    let derived = derive_stats(species, potential, training, temperament, level);
    (level.0, floor.0, next.0, derived)
}

/// Build a `monster` row from an instance, (re)computing the authoritative level/progress/`derived`
/// columns from its XP — callers must never trust those from the client. Starts at full HP.
fn monster_row(
    owner: Identity,
    species: &CoreSpecies,
    inst: &MonsterInstance,
    party_slot: Option<u8>,
) -> Monster {
    let (level, xp_floor, xp_next, derived) = level_fields(
        species,
        inst.xp.0,
        &inst.potential,
        &inst.training,
        inst.temperament,
    );
    Monster {
        monster_id: 0, // auto_inc
        owner_identity: owner,
        species_id: inst.species_id.0,
        nickname: inst.nickname.clone().unwrap_or_default(),
        level,
        xp: inst.xp.0,
        xp_floor,
        xp_next,
        potential: inst.potential,
        temperament: inst.temperament,
        training: inst.training,
        bond: inst.bond.0,
        current_hp: derived.hp,
        derived,
        party_slot,
        last_care_at_ms: 0, // never cared for yet → first care is immediately allowed
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

/// Grant a player their first-join items, once (returning players keep what they have): recruit bait
/// plus a few of each training food so the raising loop is immediately playable.
fn grant_starter_items(ctx: &ReducerContext, owner: Identity) {
    if ctx.db.player_item().owner_identity().filter(owner).count() > 0 {
        return;
    }
    ctx.db.player_item().insert(PlayerItem {
        id: 0, // auto_inc
        owner_identity: owner,
        item_id: BAIT_ITEM_ID,
        quantity: STARTER_BAIT_QTY,
    });
    let foods: Vec<u32> = ctx
        .db
        .item()
        .iter()
        .filter(|i| i.train_stat.is_some())
        .map(|i| i.item_id)
        .collect();
    for item_id in foods {
        ctx.db.player_item().insert(PlayerItem {
            id: 0,
            owner_identity: owner,
            item_id,
            quantity: STARTER_FOOD_QTY,
        });
    }
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

/// Spend one of an item stack (the caller already validated ownership + `quantity > 0`). The single
/// place item consumption happens, so a future change (e.g. deleting empty stacks) lives here.
fn consume_one(ctx: &ReducerContext, mut stack: PlayerItem) {
    stack.quantity -= 1;
    ctx.db.player_item().id().update(stack);
}

// --- Battle helpers (marshaling + delegate to game-core) ------------------------------------

/// Map a stored `skill` row to the `game-core` template.
fn core_skill(row: &Skill) -> CoreSkill {
    CoreSkill {
        id: game_core::SkillId(row.skill_id),
        name: row.name.clone(),
        affinity: row.affinity,
        category: row.category,
        power: row.power,
    }
}

/// Build the in-memory `TypeChart` from the seeded `type_relation` rows (the table is the cache).
fn type_chart_from_db(ctx: &ReducerContext) -> TypeChart {
    TypeChart {
        relations: ctx
            .db
            .type_relation()
            .iter()
            .map(|r| game_core::TypeRelation {
                attack: r.attack,
                defend: r.defend,
                effect: r.effect,
            })
            .collect(),
    }
}

/// Build a combatant from a derived stat block + a current HP (so battles use the monster's
/// persistent HP). Only the primary affinity is used in combat for M7 (secondary is deferred).
fn battle_monster(
    species_id: u32,
    level: u8,
    affinity: Affinity,
    derived: &StatBlock,
    current_hp: u16,
) -> BattleMonster {
    BattleMonster {
        species_id,
        level,
        affinity,
        attack: derived.attack,
        defense: derived.defense,
        special: derived.special,
        speed: derived.speed,
        max_hp: derived.hp,
        current_hp: current_hp.min(derived.hp),
    }
}

/// A combatant built from an owned monster — using its persistent `current_hp`.
fn battle_monster_from(m: &Monster, species: &Species) -> BattleMonster {
    battle_monster(
        m.species_id,
        m.level,
        species.primary_affinity,
        &m.derived,
        m.current_hp,
    )
}

/// Roll a wild enemy combatant of `species` at `level` (genes/temperament via `ctx.rng()`). Returns
/// the combatant plus its rolled individuality, which the battle row keeps so a successful recruit
/// rebuilds this exact monster.
fn roll_wild(
    ctx: &ReducerContext,
    species: &Species,
    level: u8,
) -> (BattleMonster, Potential, Temperament) {
    let core = core_species(species);
    let (potential, temperament) = roll_individuality(&mut || ctx.random::<u32>());
    let derived = derive_stats(
        &core,
        &potential,
        &Training::default(),
        temperament,
        Level(level),
    );
    let full = derived.hp;
    let monster = battle_monster(
        species.species_id,
        level,
        species.primary_affinity,
        &derived,
        full,
    );
    (monster, potential, temperament)
}

/// Rebuild the in-memory encounter table for a zone from the seeded `encounter` rows (the table is
/// the cache — no per-tick RON parse).
fn encounter_table_from_db(ctx: &ReducerContext, zone: u32) -> EncounterTable {
    EncounterTable {
        entries: ctx
            .db
            .encounter()
            .zone_id()
            .filter(zone)
            .map(|e| game_core::EncounterEntry {
                species_id: e.species_id,
                weight: e.weight,
                min_level: e.min_level,
                max_level: e.max_level,
            })
            .collect(),
    }
}

/// The enemy AI's chosen skill for the current turn: its active's strongest move against the player's
/// active. Shared by `submit_action` and a failed recruit (where the wild still attacks).
fn enemy_skill_choice(
    ctx: &ReducerContext,
    state: &BattleState,
    chart: &TypeChart,
) -> Result<CoreSkill, String> {
    let enemy_sp = ctx
        .db
        .species()
        .species_id()
        .find(state.enemy.active_ref().species_id)
        .ok_or("enemy species missing")?;
    let enemy_skills: Vec<CoreSkill> = enemy_sp
        .skills
        .iter()
        .filter_map(|&id| ctx.db.skill().skill_id().find(id))
        .map(|r| core_skill(&r))
        .collect();
    if enemy_skills.is_empty() {
        return Err("enemy has no skills".to_string()); // content guarantees a learnset (fail-fast)
    }
    let idx = pick_best_skill(
        state.enemy.active_ref(),
        state.player.active_ref(),
        &enemy_skills,
        chart,
        ctx.random::<u32>(),
    );
    Ok(enemy_skills[idx].clone())
}

/// Write the player team's post-turn HP back to the monster rows (persistent HP), mapping each
/// combatant to its row by `party_monster_ids` order.
fn persist_party_hp(ctx: &ReducerContext, battle: &Battle) {
    for (i, &monster_id) in battle.party_monster_ids.iter().enumerate() {
        let Some(combatant) = battle.state.player.team.get(i) else {
            continue;
        };
        if let Some(mut m) = ctx.db.monster().monster_id().find(monster_id) {
            // Re-check ownership against current state (not just the battle-time snapshot) so a
            // future trade/transfer can't make this write land on someone else's monster.
            if m.owner_identity == battle.player_identity && m.current_hp != combatant.current_hp {
                m.current_hp = combatant.current_hp;
                ctx.db.monster().monster_id().update(m);
            }
        }
    }
}

/// Recompute a monster's level/progress/`derived` columns from its CURRENT xp, potential, training,
/// and temperament (call after any change to those — an XP gain or training). HP is not restored: it
/// persists, only clamped down if the new max is lower (it never is here). The single place the
/// stored-but-derived columns are refreshed.
fn refresh_monster_stats(ctx: &ReducerContext, m: &mut Monster) {
    if let Some(sp) = ctx.db.species().species_id().find(m.species_id) {
        let (level, xp_floor, xp_next, derived) = level_fields(
            &core_species(&sp),
            m.xp,
            &m.potential,
            &m.training,
            m.temperament,
        );
        m.level = level;
        m.xp_floor = xp_floor;
        m.xp_next = xp_next;
        m.current_hp = m.current_hp.min(derived.hp);
        m.derived = derived;
    }
}

/// Award XP to each of the caller's party monsters on a win: bump xp, recompute derived stats via
/// game-core (HP is NOT restored — it persists). Returns whether any leveled up.
fn award_battle_xp(ctx: &ReducerContext, owner: Identity, reward: u32) -> bool {
    let party: Vec<Monster> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(owner)
        .filter(|m| m.party_slot.is_some())
        .collect();
    let mut any_leveled = false;
    for mut m in party {
        let before = m.level;
        m.xp = m.xp.saturating_add(reward);
        refresh_monster_stats(ctx, &mut m);
        any_leveled |= m.level > before;
        ctx.db.monster().monster_id().update(m);
    }
    any_leveled
}

/// One variance roll in `0..=MAX_VARIANCE_ROLL`.
fn variance(ctx: &ReducerContext) -> u8 {
    ctx.random::<u8>() % (MAX_VARIANCE_ROLL + 1)
}

/// Start a wild battle for `identity`: validate they can fight, build their party side, roll a wild
/// from the zone's encounter table, and insert the battle row. Shared by the manual `start_battle`
/// reducer and the grass-step trigger in `movement_tick`. Returns a descriptive `Err` (no party,
/// already battling, …) which the manual path surfaces and the auto-trigger path ignores.
fn begin_encounter(ctx: &ReducerContext, identity: Identity) -> Result<(), String> {
    if ctx.db.player().identity().find(identity).is_none() {
        return Err("not in game".to_string());
    }
    if ctx.db.battle().player_identity().find(identity).is_some() {
        return Err("already in battle".to_string());
    }

    let mut party: Vec<Monster> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(identity)
        .filter(|m| m.party_slot.is_some())
        .collect();
    if party.is_empty() {
        return Err("no monsters in your party".to_string());
    }
    party.sort_by_key(|m| m.party_slot.unwrap_or(u8::MAX));
    if party.iter().all(|m| m.current_hp == 0) {
        return Err("your monsters need to heal first".to_string());
    }

    let mut team = Vec::new();
    let mut party_monster_ids = Vec::new();
    for m in &party {
        let sp = ctx
            .db
            .species()
            .species_id()
            .find(m.species_id)
            .ok_or("species missing")?;
        team.push(battle_monster_from(m, &sp));
        party_monster_ids.push(m.monster_id);
    }

    // The wild's species + level come from the zone encounter table (data-driven), not the party.
    let table = encounter_table_from_db(ctx, ENCOUNTER_ZONE);
    let (species_id, level) = table
        .roll_encounter(ctx.random::<u32>(), ctx.random::<u32>())
        .ok_or("no encounters configured")?;
    let sp = ctx
        .db
        .species()
        .species_id()
        .find(species_id.0)
        .ok_or("encounter species missing")?;
    let (enemy, wild_potential, wild_temperament) = roll_wild(ctx, &sp, level.0);

    // Lead with the first non-fainted party monster (one exists — checked above).
    let mut player_side = BattleSide::new(team);
    player_side.active = player_side
        .team
        .iter()
        .position(|m| m.current_hp > 0)
        .unwrap_or(0) as u8;

    ctx.db.battle().insert(Battle {
        player_identity: identity,
        state: BattleState::new(player_side, BattleSide::new(vec![enemy])),
        enemy_level: level.0,
        party_monster_ids,
        wild_potential,
        wild_temperament,
        last_events: Vec::new(),
        last_xp_gain: 0,
        leveled_up: false,
    });
    Ok(())
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
            skills: s.skills.iter().map(|sk| sk.0).collect(),
            recruit_rate: s.recruit_rate,
        });
    }
    for sk in load_skills().expect("embedded skill content must be valid") {
        ctx.db.skill().insert(Skill {
            skill_id: sk.id.0,
            name: sk.name,
            affinity: sk.affinity,
            category: sk.category,
            power: sk.power,
        });
    }
    for rel in load_type_chart()
        .expect("embedded chart must be valid")
        .relations
    {
        ctx.db.type_relation().insert(TypeRelationRow {
            id: 0,
            attack: rel.attack,
            defend: rel.defend,
            effect: rel.effect,
        });
    }
    // Seed the POC grass zone's encounter table (private; the tick reads it to roll wilds).
    for e in load_encounters()
        .expect("embedded encounter content must be valid")
        .entries
    {
        ctx.db.encounter().insert(Encounter {
            id: 0,
            zone_id: ENCOUNTER_ZONE,
            species_id: e.species_id,
            weight: e.weight,
            min_level: e.min_level,
            max_level: e.max_level,
        });
    }
    for it in load_items().expect("embedded item content must be valid") {
        ctx.db.item().insert(Item {
            item_id: it.id,
            name: it.name,
            recruit_bonus: it.recruit_bonus,
            train_stat: it.train_stat,
            train_amount: it.train_amount,
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
    // End any active battle (monsters persist; the transient battle does not).
    ctx.db.battle().player_identity().delete(ctx.sender);
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

    // First-ever join grants a starter monster + some bait; returning players keep what they have.
    grant_starter(ctx, ctx.sender);
    grant_starter_items(ctx, ctx.sender);
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
            let from = TilePos {
                x: ch.tile_x,
                y: ch.tile_y,
            };
            let next = apply_move(&char_state(&ch), input, &map, Millis(now));
            // A wild encounter can trigger only when the character actually *enters* a grass tile.
            let entered_grass = next.pos != from && map.is_grass(next.pos);
            apply_state(&mut ch, &next);
            ctx.db.character().entity_id().update(ch);
            if entered_grass {
                maybe_trigger_encounter(ctx, entity_id);
            }
        }
    }
    Ok(())
}

/// On a player's step into tall grass, roll for a wild encounter and start one if it fires. Skips
/// non-players (NPCs) and players already battling; a party that can't fight just means no encounter.
fn maybe_trigger_encounter(ctx: &ReducerContext, entity_id: u64) {
    let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
        return; // not a player-owned character (e.g. an NPC)
    };
    if ctx
        .db
        .battle()
        .player_identity()
        .find(player.identity)
        .is_some()
    {
        return; // already in a battle
    }
    // Roll FIRST (cheap) — only a hit reads the encounter table, which `begin_encounter` does once.
    if !encounter_triggers(ctx.random::<u32>()) {
        return;
    }
    // Ignore the Err (e.g. an all-fainted party) — that just means no encounter, not a tick failure.
    let _ = begin_encounter(ctx, player.identity);
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

/// Feed one of the caller's monsters a training food (item `item_id`), focusing growth into the
/// food's stat. Validates ownership, that the item is food the caller actually has, and that the stat
/// has training headroom (the game-core rule rejects an already-maxed stat) — then consumes one food
/// and recomputes the monster's stats. The visible "raising shapes growth" loop.
#[spacetimedb::reducer]
pub fn train_monster(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
    let mut monster = caller_monster(ctx, monster_id)?;

    let item = ctx
        .db
        .item()
        .item_id()
        .find(item_id)
        .ok_or("no such item")?;
    let stat = item.train_stat.ok_or("that item is not training food")?;

    let stack = ctx
        .db
        .player_item()
        .owner_identity()
        .filter(ctx.sender)
        .find(|pi| pi.item_id == item_id && pi.quantity > 0)
        .ok_or("you don't have that food")?;

    // Apply the rule first — if the stat has no headroom it rejects, and we DON'T spend the food.
    monster.training = apply_training(monster.training, stat, item.train_amount)?;
    refresh_monster_stats(ctx, &mut monster);

    consume_one(ctx, stack);
    ctx.db.monster().monster_id().update(monster);
    Ok(())
}

/// Spend deliberate time with one of the caller's monsters to raise its bond. Active-only: gated by a
/// per-monster cooldown (`CARE_COOLDOWN_MS`), never an idle accrual. Validates ownership + cooldown.
#[spacetimedb::reducer]
pub fn care_for_monster(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
    let mut monster = caller_monster(ctx, monster_id)?;
    let now = now_ms(ctx) as i64;
    if now - monster.last_care_at_ms < CARE_COOLDOWN_MS {
        return Err("this monster needs a little time before you care for it again".to_string());
    }
    monster.bond = apply_care(Bond(monster.bond), CARE_BOND_GAIN).0;
    monster.last_care_at_ms = now;
    ctx.db.monster().monster_id().update(monster);
    Ok(())
}

/// Start a PvE battle on demand: the caller's party vs a wild rolled from the zone encounter table.
/// Grass steps trigger the same path automatically (`maybe_trigger_encounter`); this reducer lets the
/// player also seek a fight directly. At most one battle per player.
#[spacetimedb::reducer]
pub fn start_battle(ctx: &ReducerContext) -> Result<(), String> {
    begin_encounter(ctx, ctx.sender)
}

/// Submit the caller's chosen skill for the turn. The server validates the active monster knows it,
/// picks the enemy's action (AI), resolves the turn in game-core, and on a win awards XP. The client
/// sends intent (a skill id); the server computes every outcome.
#[spacetimedb::reducer]
pub fn submit_action(ctx: &ReducerContext, skill_id: u32) -> Result<(), String> {
    let mut battle = ctx
        .db
        .battle()
        .player_identity()
        .find(ctx.sender)
        .ok_or("not in battle")?;
    if battle.state.is_over() {
        return Err("battle is over".to_string());
    }

    // The chosen skill must be in the active monster's species learnset.
    let active_species_id = battle.state.player.active_ref().species_id;
    let active_sp = ctx
        .db
        .species()
        .species_id()
        .find(active_species_id)
        .ok_or("species missing")?;
    if !active_sp.skills.contains(&skill_id) {
        return Err("your monster does not know that skill".to_string());
    }
    let player_skill = core_skill(
        &ctx.db
            .skill()
            .skill_id()
            .find(skill_id)
            .ok_or("skill missing")?,
    );

    let chart = type_chart_from_db(ctx);
    let enemy_skill = enemy_skill_choice(ctx, &battle.state, &chart)?;

    let (new_state, events) = resolve_turn(
        &battle.state,
        &player_skill,
        &enemy_skill,
        &chart,
        variance(ctx),
        variance(ctx),
    );

    let won = new_state.outcome == BattleOutcome::PlayerWon;
    let enemy_level = battle.enemy_level;
    battle.state = new_state;
    battle.last_events = events;
    battle.last_xp_gain = 0;
    battle.leveled_up = false;

    // Persist the party's post-turn HP back to their monster rows (HP carries between battles).
    persist_party_hp(ctx, &battle);

    // On a win, award XP (mutating monster rows) and record the gain + level-up flag for the screen.
    if won {
        let gain = battle_xp_reward(enemy_level);
        battle.last_xp_gain = gain;
        battle.leveled_up = award_battle_xp(ctx, ctx.sender, gain);
    }
    ctx.db.battle().player_identity().update(battle);
    Ok(())
}

/// Swap the caller's active battle monster to party member `team_index` (forfeiting the attack — the
/// wild then strikes the monster sent in). Validates the target is in range, not the current active,
/// and not fainted; rejects (never clamps) an illegal choice. The client sends only the index.
#[spacetimedb::reducer]
pub fn swap_active(ctx: &ReducerContext, team_index: u8) -> Result<(), String> {
    let mut battle = ctx
        .db
        .battle()
        .player_identity()
        .find(ctx.sender)
        .ok_or("not in battle")?;
    if battle.state.is_over() {
        return Err("battle is over".to_string());
    }

    let team = &battle.state.player.team;
    let idx = team_index as usize;
    if idx >= team.len() {
        return Err("no such party member".to_string());
    }
    if team_index == battle.state.player.active {
        return Err("that monster is already in battle".to_string());
    }
    if team[idx].is_fainted() {
        return Err("that monster has fainted".to_string());
    }

    let chart = type_chart_from_db(ctx);
    let enemy_skill = enemy_skill_choice(ctx, &battle.state, &chart)?;
    let (new_state, events) = resolve_player_swap(
        &battle.state,
        team_index,
        &enemy_skill,
        &chart,
        variance(ctx),
    );
    battle.state = new_state;
    battle.last_events = events;
    battle.last_xp_gain = 0;
    battle.leveled_up = false;
    // The swap turn can damage the player's monster (no win is possible — the player didn't attack).
    persist_party_hp(ctx, &battle);
    ctx.db.battle().player_identity().update(battle);
    Ok(())
}

/// Attempt to recruit the wild monster (recruit-by-weaken). On success it joins the caller's box and
/// the battle ends; on failure the caller forfeits the turn and the wild strikes back. `use_bait`
/// spends one bait for a recruit-chance bonus (consumed regardless of outcome, like a thrown ball).
/// The server computes the odds and the roll from authoritative state — the client only sends intent.
#[spacetimedb::reducer]
pub fn attempt_recruit(ctx: &ReducerContext, use_bait: bool) -> Result<(), String> {
    let mut battle = ctx
        .db
        .battle()
        .player_identity()
        .find(ctx.sender)
        .ok_or("not in battle")?;
    if battle.state.is_over() {
        return Err("battle is over".to_string());
    }

    let enemy = battle.state.enemy.active_ref().clone();
    let species = ctx
        .db
        .species()
        .species_id()
        .find(enemy.species_id)
        .ok_or("enemy species missing")?;

    // Optionally spend one bait for a recruit bonus (consumed regardless of the outcome).
    let mut bait_bonus = 0u16;
    if use_bait {
        let stack = ctx
            .db
            .player_item()
            .owner_identity()
            .filter(ctx.sender)
            .find(|pi| pi.item_id == BAIT_ITEM_ID && pi.quantity > 0)
            .ok_or("you have no bait")?;
        let item = ctx
            .db
            .item()
            .item_id()
            .find(BAIT_ITEM_ID)
            .ok_or("bait item missing")?;
        bait_bonus = item.recruit_bonus;
        consume_one(ctx, stack);
    }

    let chance = recruit_chance(
        enemy.max_hp,
        enemy.current_hp,
        species.recruit_rate,
        bait_bonus,
    );

    battle.last_xp_gain = 0;
    battle.leveled_up = false;

    if recruit_succeeds(chance, ctx.random::<u32>()) {
        // Rebuild *this exact* wild as an owned monster (full HP, into the box).
        let core = core_species(&species);
        let level = Level(enemy.level);
        let inst = MonsterInstance {
            species_id: SpeciesId(enemy.species_id),
            nickname: None,
            level,
            xp: xp_for_level(level),
            potential: battle.wild_potential,
            temperament: battle.wild_temperament,
            training: Training::default(),
            bond: Bond(RECRUIT_BOND),
            current_hp: 0, // monster_row recomputes to full
        };
        ctx.db
            .monster()
            .insert(monster_row(ctx.sender, &core, &inst, None));
        battle.state.outcome = BattleOutcome::Recruited;
        battle.last_events = Vec::new();
    } else {
        // The recruit failed: the player forfeited its attack, so only the wild acts. Lead the log
        // with the authoritative "broke free" event (the client renders it like any other event).
        let chart = type_chart_from_db(ctx);
        let enemy_skill = enemy_skill_choice(ctx, &battle.state, &chart)?;
        let (new_state, mut events) =
            resolve_enemy_turn(&battle.state, &enemy_skill, &chart, variance(ctx));
        events.insert(0, BattleEvent::RecruitFailed);
        battle.state = new_state;
        battle.last_events = events;
        persist_party_hp(ctx, &battle);
    }
    ctx.db.battle().player_identity().update(battle);
    Ok(())
}

/// Restore all the caller's monsters to full HP (a placeholder for a future healing spot / Pokémon
/// Center — M7 lets the player heal on demand so a fainted party isn't a dead end).
#[spacetimedb::reducer]
pub fn heal_party(ctx: &ReducerContext) -> Result<(), String> {
    let monsters: Vec<Monster> = ctx
        .db
        .monster()
        .owner_identity()
        .filter(ctx.sender)
        .collect();
    for mut m in monsters {
        if m.current_hp != m.derived.hp {
            m.current_hp = m.derived.hp;
            ctx.db.monster().monster_id().update(m);
        }
    }
    Ok(())
}

/// Leave the current battle (flee if ongoing, or dismiss the result). Returns to the overworld.
#[spacetimedb::reducer]
pub fn close_battle(ctx: &ReducerContext) -> Result<(), String> {
    ctx.db.battle().player_identity().delete(ctx.sender);
    Ok(())
}
