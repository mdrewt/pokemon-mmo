//! Fusion rule (M10): combine two monsters into a stronger offspring that inherits the BETTER of each
//! parent's genes — the breed/fuse-for-stats payoff and the multiplayer economy's backbone. Pure &
//! deterministic. Which pair makes what is data (`FusionRecipe`s); this module looks one up
//! (order-independent) and builds the offspring instance. The server fills derived stats + HP.

use super::derive::{xp_for_level, STARTER_BOND};
use super::model::{Bond, FusionRecipe, Level, MonsterInstance, Potential, SpeciesId, Training};

/// The offspring species for fusing species `a` + `b` (order-independent), or `None` if no recipe.
pub fn find_fusion(recipes: &[FusionRecipe], a: u32, b: u32) -> Option<u32> {
    recipes
        .iter()
        .find(|r| (r.a == a && r.b == b) || (r.a == b && r.b == a))
        .map(|r| r.to)
}

/// Build the offspring of fusing `a` and `b` into the `offspring` species. Inherits the better
/// potential PER STAT (so a fused monster out-genes either parent), the higher-bond parent's
/// temperament (ties → `a`), and otherwise starts fresh: level 1, no training, no nickname. `current_hp`
/// is 0 here — the server's `monster_row` recomputes it to the derived max.
pub fn fuse_offspring(
    offspring: SpeciesId,
    a: &MonsterInstance,
    b: &MonsterInstance,
) -> MonsterInstance {
    let potential = Potential {
        hp: a.potential.hp.max(b.potential.hp),
        attack: a.potential.attack.max(b.potential.attack),
        defense: a.potential.defense.max(b.potential.defense),
        special: a.potential.special.max(b.potential.special),
        speed: a.potential.speed.max(b.potential.speed),
    };
    let temperament = if a.bond >= b.bond {
        a.temperament
    } else {
        b.temperament
    };
    let level = Level(1);
    MonsterInstance {
        species_id: offspring,
        nickname: None,
        level,
        xp: xp_for_level(level),
        potential,
        temperament,
        training: Training::default(),
        bond: Bond(STARTER_BOND),
        current_hp: 0,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monster::model::{SpeciesId, Temperament};

    fn parent(
        species: u32,
        potential: Potential,
        temperament: Temperament,
        bond: u16,
    ) -> MonsterInstance {
        MonsterInstance {
            species_id: SpeciesId(species),
            nickname: Some("Parent".to_string()),
            level: Level(40),
            xp: xp_for_level(Level(40)),
            potential,
            temperament,
            training: Training {
                attack: 200,
                ..Training::default()
            },
            bond: Bond(bond),
            current_hp: 999,
        }
    }

    fn pot(hp: u8, attack: u8, defense: u8, special: u8, speed: u8) -> Potential {
        Potential {
            hp,
            attack,
            defense,
            special,
            speed,
        }
    }

    #[test]
    fn recipe_lookup_is_order_independent() {
        let recipes = vec![FusionRecipe { a: 1, b: 2, to: 10 }];
        assert_eq!(find_fusion(&recipes, 1, 2), Some(10));
        assert_eq!(find_fusion(&recipes, 2, 1), Some(10));
        assert_eq!(find_fusion(&recipes, 1, 3), None);
    }

    #[test]
    fn offspring_inherits_the_better_gene_per_stat() {
        let a = parent(1, pot(31, 5, 20, 31, 0), Temperament::Brave, 100);
        let b = parent(2, pot(0, 31, 10, 5, 31), Temperament::Nimble, 50);
        let child = fuse_offspring(SpeciesId(10), &a, &b);
        // Each gene is the max of the two parents' — the fused monster out-genes both.
        assert_eq!(child.potential, pot(31, 31, 20, 31, 31));
        assert_eq!(child.species_id, SpeciesId(10));
    }

    #[test]
    fn offspring_starts_fresh_and_takes_the_higher_bond_temperament() {
        let a = parent(1, pot(10, 10, 10, 10, 10), Temperament::Brave, 40);
        let b = parent(2, pot(10, 10, 10, 10, 10), Temperament::Mystic, 200);
        let child = fuse_offspring(SpeciesId(10), &a, &b);
        assert_eq!(
            child.temperament,
            Temperament::Mystic,
            "from the higher-bond parent"
        );
        assert_eq!(child.level, Level(1));
        assert_eq!(child.training, Training::default(), "no inherited training");
        assert_eq!(child.nickname, None);
        assert_eq!(child.bond.0, STARTER_BOND);
    }

    #[test]
    fn is_deterministic() {
        let a = parent(1, pot(1, 2, 3, 4, 5), Temperament::Hardy, 30);
        let b = parent(2, pot(5, 4, 3, 2, 1), Temperament::Fierce, 30);
        assert_eq!(
            fuse_offspring(SpeciesId(9), &a, &b),
            fuse_offspring(SpeciesId(9), &a, &b)
        );
    }
}
