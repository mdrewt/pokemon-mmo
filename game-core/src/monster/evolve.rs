//! Evolution rule (M10): which forms a monster currently qualifies to evolve into. Pure — the server
//! computes this onto each monster row so the client can show Evolve options without re-deriving the
//! gate (no rule in TS, no desync). Evolution keeps the monster's individuality (genes / training /
//! bond / XP / name); only the species template — and thus the derived stats — changes.

use super::model::{Bond, Level, Species};

/// The target species ids this monster currently qualifies to evolve into — every listed evolution
/// whose level + bond gates are met. A species may offer several branches (e.g. a high-bond form vs a
/// default form); the player picks among the eligible ones. Empty when none qualify / it's a final
/// form.
pub fn eligible_evolutions(species: &Species, level: Level, bond: Bond) -> Vec<u32> {
    species
        .evolutions
        .iter()
        .filter(|e| level.0 >= e.min_level && bond.0 >= e.min_bond)
        .map(|e| e.to)
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monster::model::{Affinity, Evolution, SpeciesId, StatBlock};

    fn species_with(evolutions: Vec<Evolution>) -> Species {
        Species {
            id: SpeciesId(1),
            name: "Testmon".to_string(),
            base: StatBlock::default(),
            primary_affinity: Affinity::Nature,
            secondary_affinity: None,
            sprite_id: 0,
            skills: vec![],
            recruit_rate: 200,
            evolutions,
        }
    }

    #[test]
    fn no_evolutions_yields_none() {
        let s = species_with(vec![]);
        assert!(eligible_evolutions(&s, Level(50), Bond(200)).is_empty());
    }

    #[test]
    fn level_gate_is_enforced() {
        let s = species_with(vec![Evolution {
            to: 2,
            min_level: 16,
            min_bond: 0,
        }]);
        assert!(eligible_evolutions(&s, Level(15), Bond(0)).is_empty());
        assert_eq!(eligible_evolutions(&s, Level(16), Bond(0)), vec![2]);
    }

    #[test]
    fn branches_unlock_independently_by_their_gates() {
        // A default form (level only) and a high-bond form (level + bond).
        let s = species_with(vec![
            Evolution {
                to: 2,
                min_level: 16,
                min_bond: 0,
            },
            Evolution {
                to: 3,
                min_level: 16,
                min_bond: 120,
            },
        ]);
        // Level met, bond low → only the default branch.
        assert_eq!(eligible_evolutions(&s, Level(16), Bond(50)), vec![2]);
        // Level + bond met → both branches; the player chooses.
        assert_eq!(eligible_evolutions(&s, Level(16), Bond(120)), vec![2, 3]);
    }

    #[test]
    fn is_deterministic() {
        let s = species_with(vec![Evolution {
            to: 2,
            min_level: 10,
            min_bond: 0,
        }]);
        assert_eq!(
            eligible_evolutions(&s, Level(12), Bond(30)),
            eligible_evolutions(&s, Level(12), Bond(30))
        );
    }
}
