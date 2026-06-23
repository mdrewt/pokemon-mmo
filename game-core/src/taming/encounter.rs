//! Wild-encounter content + the seeded rolls that pick a wild monster. Pure & deterministic: the
//! server passes in rng-derived values (the trigger roll, the species pick, the level pick);
//! `game-core` never reads a clock or rng. Encounter *tables* are data (RON), one per zone; the POC
//! has a single tall-grass zone.

use serde::{Deserialize, Serialize};

use crate::monster::{Level, SpeciesId};

/// Probability in permille (0..=1000) that a single step onto a grass tile triggers an encounter.
/// A tuning knob — high enough to find monsters quickly in the POC, low enough not to spam.
pub const ENCOUNTER_CHANCE_PERMILLE: u32 = 120;

/// One possible wild monster in a zone: a species, its relative `weight` in the table, and the
/// inclusive level range it spawns at.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct EncounterEntry {
    pub species_id: u32,
    pub weight: u32,
    pub min_level: u8,
    pub max_level: u8,
}

/// A zone's weighted encounter table (data-driven; authored in RON, seeded into the server's
/// encounter table at init).
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct EncounterTable {
    pub entries: Vec<EncounterEntry>,
}

impl EncounterTable {
    /// Sum of entry weights (0 for an empty table).
    fn total_weight(&self) -> u32 {
        self.entries.iter().map(|e| e.weight).sum()
    }

    /// Whether a grass step triggers an encounter, given a `roll` the server derives from `ctx.rng()`.
    /// Always false for an empty table (nothing spawns where nothing lives).
    pub fn triggers_encounter(&self, roll: u32) -> bool {
        !self.entries.is_empty() && (roll % 1000) < ENCOUNTER_CHANCE_PERMILLE
    }

    /// Pick a wild `(species, level)`: `species_roll` selects the weighted entry, `level_roll` picks a
    /// level uniformly in that entry's inclusive range. `None` only for an empty table.
    pub fn roll_encounter(&self, species_roll: u32, level_roll: u32) -> Option<(SpeciesId, Level)> {
        let total = self.total_weight();
        if total == 0 {
            return None;
        }
        let mut pick = species_roll % total;
        for e in &self.entries {
            if pick < e.weight {
                let lo = e.min_level.min(e.max_level);
                let hi = e.min_level.max(e.max_level);
                let span = (hi - lo) as u32 + 1;
                let level = lo + (level_roll % span) as u8;
                return Some((SpeciesId(e.species_id), Level(level)));
            }
            pick -= e.weight;
        }
        None // unreachable: pick < total == sum of weights
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn table() -> EncounterTable {
        EncounterTable {
            entries: vec![
                EncounterEntry {
                    species_id: 1,
                    weight: 30,
                    min_level: 2,
                    max_level: 4,
                },
                EncounterEntry {
                    species_id: 2,
                    weight: 70,
                    min_level: 5,
                    max_level: 5,
                },
            ],
        }
    }

    #[test]
    fn empty_table_never_encounters() {
        let empty = EncounterTable::default();
        assert!(!empty.triggers_encounter(0));
        assert_eq!(empty.roll_encounter(0, 0), None);
    }

    #[test]
    fn trigger_respects_the_chance_threshold() {
        let t = table();
        // Roll just under the threshold triggers; at/above does not.
        assert!(t.triggers_encounter(ENCOUNTER_CHANCE_PERMILLE - 1));
        assert!(!t.triggers_encounter(ENCOUNTER_CHANCE_PERMILLE));
        assert!(!t.triggers_encounter(999));
        // The roll is taken modulo 1000, so a large roll maps back into range.
        assert!(t.triggers_encounter(1000)); // 1000 % 1000 == 0 < threshold
    }

    #[test]
    fn weighted_pick_selects_the_right_entry_and_level() {
        let t = table();
        // pick 0 falls in the first entry's [0,30) weight band → species 1, level in 2..=4.
        let (sp, lvl) = t.roll_encounter(0, 0).unwrap();
        assert_eq!(sp, SpeciesId(1));
        assert_eq!(lvl, Level(2));
        // pick 30 falls in the second band → species 2, level always 5 (single-level range).
        let (sp, lvl) = t.roll_encounter(30, 999).unwrap();
        assert_eq!(sp, SpeciesId(2));
        assert_eq!(lvl, Level(5));
        // level_roll spans the inclusive range for the first entry (2..=4).
        let levels: Vec<u8> = (0..3)
            .map(|r| t.roll_encounter(0, r).unwrap().1 .0)
            .collect();
        assert_eq!(levels, vec![2, 3, 4]);
    }

    #[test]
    fn roll_is_deterministic() {
        let t = table();
        assert_eq!(t.roll_encounter(57, 13), t.roll_encounter(57, 13));
    }
}
