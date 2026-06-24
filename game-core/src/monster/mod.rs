//! Monsters: the individuality data model (`model`) and the pure derivation rules (`derive`).
//! Species content is authored in RON and loaded by `crate::content`; this module only defines the
//! shapes and the rules over them.

mod derive;
mod evolve;
mod fuse;
mod model;
mod raise;

pub use derive::{
    derive_stats, level_bounds, level_for_xp, roll_individuality, roll_starter, xp_for_level,
};
pub use evolve::eligible_evolutions;
pub use fuse::{find_fusion, fuse_offspring};
pub use model::{
    Affinity, Bond, Evolution, FusionRecipe, Level, MonsterInstance, Potential, Species, SpeciesId,
    Stat, StatBlock, Temperament, Training, Xp,
};
pub use raise::{apply_care, apply_training};
