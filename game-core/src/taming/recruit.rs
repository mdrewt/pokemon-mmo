//! The taming rule: how likely a weakened wild monster is to be recruited. Pure & deterministic
//! (the server supplies the roll). Lower HP → higher chance; a per-species base rate sets the floor;
//! bait adds a flat bonus. All probabilities are permille (0..=1000). This is the single source of
//! truth for recruit odds — the client never computes them (it only shows the authoritative result).

/// How much fully draining a wild's HP adds to its recruit chance (permille). At full HP a wild's
/// chance is just its species base rate; near 0 HP it gains up to this much. The heart of
/// "recruit-by-weaken" — weakening, not luck, is the lever.
pub const RECRUIT_HP_FACTOR: u32 = 600;

/// Recruit probability in permille (0..=1000) for a wild at `current_hp`/`max_hp`, given its species
/// `base_rate` and any `bait_bonus` (both permille). Weakening the wild adds up to `RECRUIT_HP_FACTOR`
/// on top of the base rate; the total is capped at 1000 (certainty).
pub fn recruit_chance(max_hp: u16, current_hp: u16, base_rate: u16, bait_bonus: u16) -> u16 {
    let max = max_hp.max(1) as u32;
    let cur = (current_hp.min(max_hp)) as u32;
    // Fraction of HP *missing*, in permille (0 at full HP, 1000 at 0 HP).
    let missing = 1000 - (cur * 1000 / max);
    let from_hp = missing * RECRUIT_HP_FACTOR / 1000;
    (base_rate as u32 + from_hp + bait_bonus as u32).min(1000) as u16
}

/// Whether a recruit attempt with the given `chance` (permille) succeeds, for a `roll` the server
/// derives from `ctx.rng()`. A `chance` of 0 never succeeds; 1000 always does.
pub fn attempt_recruit(chance: u16, roll: u32) -> bool {
    (roll % 1000) < chance as u32
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn full_hp_chance_is_just_base_plus_bait() {
        assert_eq!(recruit_chance(100, 100, 150, 0), 150);
        assert_eq!(recruit_chance(100, 100, 150, 100), 250);
    }

    #[test]
    fn weakening_raises_the_chance_monotonically() {
        let full = recruit_chance(100, 100, 150, 0);
        let half = recruit_chance(100, 50, 150, 0);
        let near_dead = recruit_chance(100, 1, 150, 0);
        assert!(full < half, "half HP recruits more easily than full");
        assert!(half < near_dead, "near-fainted recruits even more easily");
        // At ~0 HP the HP term approaches the full factor.
        assert_eq!(
            recruit_chance(100, 1, 150, 0),
            150 + (990 * RECRUIT_HP_FACTOR / 1000) as u16
        );
    }

    #[test]
    fn chance_is_capped_at_certainty() {
        // High base + fully weakened + bait would overflow past 1000 without the cap.
        assert_eq!(recruit_chance(100, 0, 900, 500), 1000);
    }

    #[test]
    fn zero_max_hp_is_safe() {
        // Guards against a divide-by-zero on a degenerate combatant.
        let c = recruit_chance(0, 0, 100, 0);
        assert!(c <= 1000);
    }

    #[test]
    fn attempt_respects_the_chance() {
        assert!(!attempt_recruit(0, 0), "0% never succeeds");
        assert!(attempt_recruit(1000, 999), "100% always succeeds");
        assert!(attempt_recruit(500, 499), "roll below chance succeeds");
        assert!(!attempt_recruit(500, 500), "roll at/above chance fails");
    }
}
