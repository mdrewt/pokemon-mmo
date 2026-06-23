//! Finding & taming (M8): wild-encounter tables + the recruit-by-weaken rule. Pure & deterministic,
//! like the rest of `game-core` — the server supplies all randomness as seeded rolls. The combat
//! consequence of a recruit attempt (the wild gets a free turn) lives in `crate::combat`; this module
//! only decides *what* you find and *whether* it joins you.

mod encounter;
mod item;
mod recruit;

pub use encounter::{EncounterEntry, EncounterTable, ENCOUNTER_CHANCE_PERMILLE};
pub use item::Item;
pub use recruit::{attempt_recruit, recruit_chance, RECRUIT_HP_FACTOR};
