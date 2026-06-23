//! The monster data model: the value types that make every monster a unique individual, plus the
//! `Species` template (content) and the `MonsterInstance` (an owned individual). All pure data; the
//! derivation rules live in `derive.rs`.
//!
//! `#[cfg_attr(feature = "spacetimedb", ...)]` adds `SpacetimeType` to the types used as table
//! columns (mirrors `crate::types`), so the server can store them without a hand-written boundary.

use serde::{Deserialize, Serialize};

use crate::combat::SkillId;

/// The lean stat set (KISS — expand only if battle depth demands it). `Special` is the single
/// magic/special stat. `Stat` itself is internal (indexing/temperament); it is not a table column.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Stat {
    Hp,
    Attack,
    Defense,
    Special,
    Speed,
}

/// One value per [`Stat`]. Used for base stats (species), genes ([`Potential`] is separate), and
/// the server-derived current stats stored on a monster.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct StatBlock {
    pub hp: u16,
    pub attack: u16,
    pub defense: u16,
    pub special: u16,
    pub speed: u16,
}

impl StatBlock {
    pub fn get(&self, stat: Stat) -> u16 {
        match stat {
            Stat::Hp => self.hp,
            Stat::Attack => self.attack,
            Stat::Defense => self.defense,
            Stat::Special => self.special,
            Stat::Speed => self.speed,
        }
    }

    pub fn set(&mut self, stat: Stat, value: u16) {
        match stat {
            Stat::Hp => self.hp = value,
            Stat::Attack => self.attack = value,
            Stat::Defense => self.defense = value,
            Stat::Special => self.special = value,
            Stat::Speed => self.speed = value,
        }
    }
}

/// Elemental affinities (data-tunable). The weak/resist chart that consumes these is M7 content;
/// M6 only stores a species' affinities.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Affinity {
    Neutral,
    Fire,
    Water,
    Nature,
    Electric,
    Earth,
    Light,
    Dark,
}

/// Innate temperament (nature): nudges one battle stat up and another down (±10%), and flavors
/// behaviour later. A curated set, not the full Pokémon 5×5 grid (KISS).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Temperament {
    Hardy, // neutral
    Brave,
    Nimble,
    Stalwart,
    Mystic,
    Fierce,
    Cautious,
    Quick,
    Focused,
}

impl Temperament {
    /// `(raised, lowered)` stat, each ±10% in [`crate::derive_stats`]. `Hardy` is neutral.
    pub fn modifier(self) -> (Option<Stat>, Option<Stat>) {
        use Stat::*;
        match self {
            Temperament::Hardy => (None, None),
            Temperament::Brave => (Some(Attack), Some(Speed)),
            Temperament::Nimble => (Some(Speed), Some(Attack)),
            Temperament::Stalwart => (Some(Defense), Some(Special)),
            Temperament::Mystic => (Some(Special), Some(Defense)),
            Temperament::Fierce => (Some(Attack), Some(Defense)),
            Temperament::Cautious => (Some(Defense), Some(Attack)),
            Temperament::Quick => (Some(Speed), Some(Defense)),
            Temperament::Focused => (Some(Special), Some(Speed)),
        }
    }

    /// All temperaments, for a uniform random roll (see `roll_starter`).
    pub const ALL: [Temperament; 9] = [
        Temperament::Hardy,
        Temperament::Brave,
        Temperament::Nimble,
        Temperament::Stalwart,
        Temperament::Mystic,
        Temperament::Fierce,
        Temperament::Cautious,
        Temperament::Quick,
        Temperament::Focused,
    ];
}

/// Per-stat innate genes (IV-like), each `0..=MAX`. The dominant source of same-species variance.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct Potential {
    pub hp: u8,
    pub attack: u8,
    pub defense: u8,
    pub special: u8,
    pub speed: u8,
}

impl Potential {
    /// Inclusive max per-stat gene value.
    pub const MAX: u8 = 31;

    pub fn get(&self, stat: Stat) -> u8 {
        match stat {
            Stat::Hp => self.hp,
            Stat::Attack => self.attack,
            Stat::Defense => self.defense,
            Stat::Special => self.special,
            Stat::Speed => self.speed,
        }
    }
}

/// Per-stat training investment (EV-like). Empty in M6; populated by the M9 raising actions.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct Training {
    pub hp: u16,
    pub attack: u16,
    pub defense: u16,
    pub special: u16,
    pub speed: u16,
}

impl Training {
    pub fn get(&self, stat: Stat) -> u16 {
        match stat {
            Stat::Hp => self.hp,
            Stat::Attack => self.attack,
            Stat::Defense => self.defense,
            Stat::Special => self.special,
            Stat::Speed => self.speed,
        }
    }
}

// The newtypes below deliberately do NOT derive `SpacetimeType` — that derive panics on tuple
// structs, and (mirroring `Millis`) they round-trip as their inner primitive at the server boundary
// (e.g. `bond: u16`, `level: u8`). Only the composite structs/enums above are stored as columns.

/// Loyalty/affection, grows with active use + care (M9). Battle/evolution gates read it later.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Bond(pub u16);

/// 1..=`MAX`. Newtype so a raw integer can't be mistaken for a level.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Level(pub u8);

impl Level {
    pub const MAX: u8 = 100;
}

/// Total accumulated experience.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub struct Xp(pub u32);

/// Stable identifier for a species (the RON content key). `transparent` so it reads as a plain
/// integer in RON (`id: 1`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SpeciesId(pub u32);

/// A species TEMPLATE — pure content authored in RON (see `crate::content`). M6 keeps this lean;
/// learnsets, evolution, and recruit requirements are added by M7/M8/M10 (grow-the-schema). The
/// server maps this to its own `species` table row (it contains the `SpeciesId` newtype).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Species {
    pub id: SpeciesId,
    pub name: String,
    pub base: StatBlock,
    pub primary_affinity: Affinity,
    pub secondary_affinity: Option<Affinity>,
    pub sprite_id: u32,
    /// The skills this species can use in battle (M7 learnset; M9 will let raising shape it).
    pub skills: Vec<SkillId>,
    /// Base recruit chance in permille (0..=1000) when encountered at full HP — the species'
    /// catch difficulty (M8 taming). Weakening it in battle raises the effective chance; see
    /// `crate::recruit_chance`. Common species are higher, rarer ones lower.
    pub recruit_rate: u16,
}

/// An owned, individual monster — the in-memory domain form. The server `monster` table mirrors
/// these fields as columns (plus ownership/box-location) and reconstructs this to derive stats.
#[derive(Clone, Debug, PartialEq)]
pub struct MonsterInstance {
    pub species_id: SpeciesId,
    /// Player-given name; `None` falls back to the species name in the UI.
    pub nickname: Option<String>,
    pub level: Level,
    pub xp: Xp,
    pub potential: Potential,
    pub temperament: Temperament,
    pub training: Training,
    pub bond: Bond,
    /// Current HP (dynamic; full = derived max HP). Stored separately from derived max stats.
    pub current_hp: u16,
}
