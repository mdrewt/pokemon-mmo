//! `game-core`: pure, deterministic game logic shared by the server (authoritative truth) and
//! the client (prediction, via `client-wasm`).
//!
//! Invariants (see ARCHITECTURE.md for the full rationale):
//! - No I/O, no clocks, no unseeded randomness, no platform deps in the default build. Time and
//!   randomness are passed in as arguments; the `clippy.toml` determinism guard enforces this.
//! - Authoritative position is integer tiles — never floats — so client and server cannot
//!   numerically diverge.
//! - Every game rule lives here ONCE and is called by both sides. Never reimplement a rule in
//!   TypeScript or a reducer.
//!
//! The optional `spacetimedb` feature adds `SpacetimeType` derives to the types used as table
//! columns / reducer arguments. It adds no runtime logic and is enabled only by `server-module`.

mod combat;
mod content;
mod monster;
mod types;
mod world;

pub use combat::{
    battle_xp_reward, damage, pick_best_skill, resolve_turn, BattleMonster, BattleOutcome,
    BattleSide, BattleState, Category, Effectiveness, Skill, SkillId, TypeChart, TypeRelation,
    MAX_VARIANCE_ROLL,
};
pub use content::{load_skills, load_species, load_type_chart, validate_content};
pub use monster::{
    derive_stats, level_for_xp, roll_starter, xp_for_level, Affinity, Bond, Level, MonsterInstance,
    Potential, Species, SpeciesId, Stat, StatBlock, Temperament, Training, Xp,
};
pub use types::{ActionState, CharacterState, Direction, Millis, MoveInput, TilePos};
pub use world::map::{poc_map, TileMap};
pub use world::movement::{apply_move, MOVE_QUEUE_CAP, STEP_MS};
pub use world::npc::{npc_decide, NpcParams};
