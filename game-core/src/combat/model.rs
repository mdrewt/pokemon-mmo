//! Combat data model: skills, the type/affinity chart, and damage effectiveness. Pure data + the
//! enums the damage formula and battle resolver operate on. Content (skills, the chart) is authored
//! in RON (see `crate::content`); this module only defines the shapes.
//!
//! As in `monster::model`, newtypes (`SkillId`) and content structs (`Skill`) do NOT derive
//! `SpacetimeType` (the derive panics on tuple structs); the server maps them to its own table rows
//! and stores ids as primitives. Only the small value enums used as columns derive it.

use serde::{Deserialize, Serialize};

use crate::monster::Affinity;

/// Which offensive stat a skill scales from. In the lean 5-stat set both are defended by `Defense`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Category {
    /// Scales from the attacker's `Attack`.
    Physical,
    /// Scales from the attacker's `Special`.
    Special,
}

/// Stable skill id (the RON content key). `transparent` so it reads as a plain integer in RON.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct SkillId(pub u32);

/// A skill/move TEMPLATE — pure content authored in RON. M7 keeps it lean (no accuracy/PP/status
/// yet; those layer on with the depth pass).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Skill {
    pub id: SkillId,
    pub name: String,
    pub affinity: Affinity,
    pub category: Category,
    pub power: u16,
}

/// How effective an attack's affinity is against a defender's affinity.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum Effectiveness {
    NoEffect,
    NotVeryEffective,
    Neutral,
    SuperEffective,
}

impl Effectiveness {
    /// Integer damage multiplier in percent (keeps the formula float-free/deterministic).
    pub fn multiplier_pct(self) -> u16 {
        match self {
            Effectiveness::NoEffect => 0,
            Effectiveness::NotVeryEffective => 50,
            Effectiveness::Neutral => 100,
            Effectiveness::SuperEffective => 200,
        }
    }
}

/// One non-neutral attack→defend affinity relationship (neutral pairs are omitted).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TypeRelation {
    pub attack: Affinity,
    pub defend: Affinity,
    pub effect: Effectiveness,
}

/// The type/affinity chart — data-driven (RON). Any pair not listed is `Neutral`.
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct TypeChart {
    pub relations: Vec<TypeRelation>,
}

impl TypeChart {
    /// Effectiveness of an `attack` affinity against a `defend` affinity (defaults to `Neutral`).
    pub fn effectiveness(&self, attack: Affinity, defend: Affinity) -> Effectiveness {
        self.relations
            .iter()
            .find(|r| r.attack == attack && r.defend == defend)
            .map(|r| r.effect)
            .unwrap_or(Effectiveness::Neutral)
    }
}
