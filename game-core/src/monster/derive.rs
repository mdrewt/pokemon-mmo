//! Pure monster rules: derive current stats from a species + an individual's genes/training/level,
//! the XP↔level curve, and the seeded starter roll. No clocks, no rng inside — randomness is passed
//! in as a closure (mirrors `npc_decide` taking a roll), keeping this deterministic and testable.

use super::model::{
    Bond, Level, MonsterInstance, Potential, Species, Stat, StatBlock, Temperament, Training, Xp,
};

/// Bond a freshly-tamed/starter monster begins with.
pub const STARTER_BOND: u16 = 20;

/// Derive a monster's current (max) stats from its species base, genes, training, temperament, and
/// level. Gen-3-style formula with integer math (deterministic); temperament applies ±10% to the
/// raised/lowered battle stat. HP is never temperament-affected.
pub fn derive_stats(
    species: &Species,
    potential: &Potential,
    training: &Training,
    temperament: Temperament,
    level: Level,
) -> StatBlock {
    let lvl = level.0 as u32;
    let (up, down) = temperament.modifier();
    let mut out = StatBlock::default();

    for stat in [
        Stat::Hp,
        Stat::Attack,
        Stat::Defense,
        Stat::Special,
        Stat::Speed,
    ] {
        let base = species.base.get(stat) as u32;
        let iv = potential.get(stat) as u32;
        let ev = training.get(stat) as u32;
        let common = (2 * base + iv + ev / 4) * lvl / 100;

        let value = if stat == Stat::Hp {
            common + lvl + 10
        } else {
            let raw = common + 5;
            if up == Some(stat) {
                raw * 11 / 10
            } else if down == Some(stat) {
                raw * 9 / 10
            } else {
                raw
            }
        };
        out.set(stat, value.min(u16::MAX as u32) as u16);
    }
    out
}

/// Total XP required to *be* a given level — a medium-fast cubic (`level³`).
pub fn xp_for_level(level: Level) -> Xp {
    let l = level.0 as u32;
    Xp(l * l * l)
}

/// The level a monster with this much XP has reached (clamped to `[1, Level::MAX]`).
pub fn level_for_xp(xp: Xp) -> Level {
    let mut level = 1u8;
    while level < Level::MAX && xp_for_level(Level(level + 1)).0 <= xp.0 {
        level += 1;
    }
    Level(level)
}

/// For a given XP total: its `(level, xp at the start of that level, xp total needed for the next
/// level)`. At the level cap `next == floor` (no further level). Lets the UI show a progress bar +
/// "N to next level" without the client reimplementing the curve.
pub fn level_bounds(xp: Xp) -> (Level, Xp, Xp) {
    let level = level_for_xp(xp);
    let floor = xp_for_level(level);
    let next = if level.0 >= Level::MAX {
        floor
    } else {
        xp_for_level(Level(level.0 + 1))
    };
    (level, floor, next)
}

/// Roll a fresh starter/wild individual of `species`. `next_u32` supplies randomness (the server
/// wraps `ctx.rng()`); it is consumed in a fixed order — the five potential genes (hp, attack,
/// defense, special, speed) then the temperament — so the result is deterministic for a given
/// sequence. Begins at level 1, empty training, full HP.
/// Roll just the innate individuality (per-stat genes + temperament) from the seeded source. Shared
/// by starter rolls and wild encounters (which derive their stats at their own level), consumed in a
/// fixed order — the five genes (hp, attack, defense, special, speed) then the temperament.
pub fn roll_individuality(next_u32: &mut dyn FnMut() -> u32) -> (Potential, Temperament) {
    let gene = |n: &mut dyn FnMut() -> u32| (n() % (Potential::MAX as u32 + 1)) as u8;
    let potential = Potential {
        hp: gene(next_u32),
        attack: gene(next_u32),
        defense: gene(next_u32),
        special: gene(next_u32),
        speed: gene(next_u32),
    };
    let temperament = Temperament::ALL[(next_u32() as usize) % Temperament::ALL.len()];
    (potential, temperament)
}

pub fn roll_starter(species: &Species, next_u32: &mut dyn FnMut() -> u32) -> MonsterInstance {
    let (potential, temperament) = roll_individuality(next_u32);

    let level = Level(1);
    let training = Training::default();
    let max = derive_stats(species, &potential, &training, temperament, level);

    MonsterInstance {
        species_id: species.id,
        nickname: None,
        level,
        xp: xp_for_level(level),
        potential,
        temperament,
        training,
        bond: Bond(STARTER_BOND),
        current_hp: max.hp,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monster::model::{Affinity, SpeciesId};

    fn test_species() -> Species {
        Species {
            id: SpeciesId(1),
            name: "Testmon".to_string(),
            base: StatBlock {
                hp: 45,
                attack: 49,
                defense: 49,
                special: 45,
                speed: 45,
            },
            primary_affinity: Affinity::Nature,
            secondary_affinity: None,
            sprite_id: 0,
            skills: vec![],
        }
    }

    #[test]
    fn derive_stats_matches_known_fixture() {
        // base hp 45, iv 31, no training, level 50 → (2*45+31)*50/100 + 50 + 10 = 60 + 60 = 120.
        let p = Potential {
            hp: 31,
            attack: 31,
            defense: 31,
            special: 31,
            speed: 31,
        };
        let s = derive_stats(
            &test_species(),
            &p,
            &Training::default(),
            Temperament::Hardy,
            Level(50),
        );
        assert_eq!(s.hp, 120);
        // attack: (2*49+31)*50/100 + 5 = 64 + 5 = 69 (Hardy = neutral).
        assert_eq!(s.attack, 69);
    }

    #[test]
    fn derive_stats_is_deterministic() {
        let p = Potential {
            hp: 7,
            attack: 11,
            defense: 13,
            special: 17,
            speed: 19,
        };
        let a = derive_stats(
            &test_species(),
            &p,
            &Training::default(),
            Temperament::Brave,
            Level(37),
        );
        let b = derive_stats(
            &test_species(),
            &p,
            &Training::default(),
            Temperament::Brave,
            Level(37),
        );
        assert_eq!(a, b);
    }

    #[test]
    fn temperament_raises_and_lowers_the_right_stats() {
        let p = Potential {
            hp: 31,
            attack: 31,
            defense: 31,
            special: 31,
            speed: 31,
        };
        let hardy = derive_stats(
            &test_species(),
            &p,
            &Training::default(),
            Temperament::Hardy,
            Level(50),
        );
        let brave = derive_stats(
            &test_species(),
            &p,
            &Training::default(),
            Temperament::Brave,
            Level(50),
        );
        assert!(brave.attack > hardy.attack, "Brave raises Attack");
        assert!(brave.speed < hardy.speed, "Brave lowers Speed");
        assert_eq!(brave.hp, hardy.hp, "HP is never temperament-affected");
        assert_eq!(
            brave.defense, hardy.defense,
            "untouched stats are unchanged"
        );
    }

    #[test]
    fn training_increases_stats() {
        let p = Potential::default();
        let untrained = derive_stats(
            &test_species(),
            &p,
            &Training::default(),
            Temperament::Hardy,
            Level(50),
        );
        let trained = derive_stats(
            &test_species(),
            &p,
            &Training {
                attack: 252,
                ..Training::default()
            },
            Temperament::Hardy,
            Level(50),
        );
        assert!(trained.attack > untrained.attack);
    }

    #[test]
    fn xp_curve_is_monotonic_and_inverts() {
        assert_eq!(xp_for_level(Level(1)).0, 1);
        assert_eq!(xp_for_level(Level(100)).0, 1_000_000);
        assert!(xp_for_level(Level(50)).0 < xp_for_level(Level(51)).0);
        assert_eq!(level_for_xp(Xp(0)).0, 1);
        assert_eq!(level_for_xp(xp_for_level(Level(50))).0, 50);
        // just-below the level-50 threshold is still level 49.
        assert_eq!(level_for_xp(Xp(xp_for_level(Level(50)).0 - 1)).0, 49);
        // overshooting the curve clamps to MAX.
        assert_eq!(level_for_xp(Xp(u32::MAX)).0, Level::MAX);
    }

    #[test]
    fn level_bounds_reports_progress_window() {
        // Mid-level: floor = this level's xp, next = the following level's xp.
        let (level, floor, next) = level_bounds(Xp(xp_for_level(Level(10)).0 + 5));
        assert_eq!(level.0, 10);
        assert_eq!(floor.0, xp_for_level(Level(10)).0);
        assert_eq!(next.0, xp_for_level(Level(11)).0);
        assert!(next.0 > floor.0);
        // At the cap, next == floor (no further level — UI shows "MAX").
        let (max_level, max_floor, max_next) = level_bounds(Xp(u32::MAX));
        assert_eq!(max_level.0, Level::MAX);
        assert_eq!(max_next.0, max_floor.0);
    }

    #[test]
    fn roll_starter_is_deterministic_and_well_formed() {
        let rolls = [5u32, 10, 15, 20, 25, 3];
        let mut i = 0;
        let mut next = || {
            let v = rolls[i % rolls.len()];
            i += 1;
            v
        };
        let m = roll_starter(&test_species(), &mut next);

        assert_eq!(m.species_id, SpeciesId(1));
        assert_eq!(m.level, Level(1));
        assert_eq!(m.potential.hp, 5);
        assert_eq!(m.potential.speed, 25);
        assert_eq!(m.temperament, Temperament::ALL[3]); // 6th roll = 3
        assert_eq!(m.bond, Bond(STARTER_BOND));
        assert_eq!(m.training, Training::default());
        // current_hp == derived max HP at level 1.
        let max = derive_stats(
            &test_species(),
            &m.potential,
            &m.training,
            m.temperament,
            m.level,
        );
        assert_eq!(m.current_hp, max.hp);
        assert!(m.potential.attack <= Potential::MAX);
    }
}
