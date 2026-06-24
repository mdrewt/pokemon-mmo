//! Combat: the type/affinity chart, the deterministic damage formula, and (next) the turn-based
//! battle resolver. Pure — the server runs it authoritatively; battles are turn-based so the client
//! does not predict them (it animates the server's resolved turns).

mod damage;
mod model;
mod rating;
mod resolve;

pub use damage::{damage, MAX_VARIANCE_ROLL};
pub use model::{Category, Effectiveness, Skill, SkillId, TypeChart, TypeRelation};
pub use rating::{elo_update, STARTING_RATING};
pub use resolve::{
    battle_xp_reward, pick_best_skill, resolve_enemy_turn, resolve_player_swap, resolve_turn,
    AttackEvent, BattleEvent, BattleMonster, BattleOutcome, BattleSide, BattleState, FaintEvent,
    SwitchEvent,
};
