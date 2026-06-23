//! The damage formula — pure, integer-only, deterministic. A gen-3-inspired shape adapted to the
//! lean 5-stat set: physical skills scale from `Attack`, special from `Special`, both reduced by the
//! defender's `Defense`. Variance is supplied as a seeded roll (the server passes `ctx.rng()`), so
//! there is no hidden randomness.

use super::model::Effectiveness;

/// Inclusive max value of the `variance_roll` argument (maps to 85..=100% damage).
pub const MAX_VARIANCE_ROLL: u8 = 15;

/// Compute the damage a single hit deals.
///
/// - `off` = attacker's offensive stat (Attack for Physical, Special for Special).
/// - `def` = defender's `Defense`.
/// - `stab` = the skill's affinity matches the attacker's primary affinity (Same-Type Attack Bonus).
/// - `variance_roll` = `0..=MAX_VARIANCE_ROLL`, mapped to an 85..=100% multiplier.
///
/// Returns 0 only when the hit has no effect; otherwise at least 1.
pub fn damage(
    attacker_level: u8,
    off: u16,
    def: u16,
    power: u16,
    effectiveness: Effectiveness,
    stab: bool,
    variance_roll: u8,
) -> u16 {
    if effectiveness == Effectiveness::NoEffect || power == 0 {
        return 0;
    }
    let level = attacker_level as u32;
    let off = off.max(1) as u32;
    let def = def.max(1) as u32;
    let power = power as u32;

    // Base: ((2*level/5 + 2) * power * off / def) / 50 + 2
    let mut dmg = (2 * level / 5 + 2) * power * off / def / 50 + 2;
    dmg = dmg * effectiveness.multiplier_pct() as u32 / 100;
    if stab {
        dmg = dmg * 3 / 2;
    }
    let variance = 85 + variance_roll.min(MAX_VARIANCE_ROLL) as u32; // 85..=100
    dmg = dmg * variance / 100;

    dmg.clamp(1, u16::MAX as u32) as u16
}

#[cfg(test)]
mod tests {
    use super::*;

    // A fixed mid-range hit, neutral, no STAB, max variance, used as the baseline for comparisons.
    fn base() -> u16 {
        damage(
            50,
            100,
            100,
            60,
            Effectiveness::Neutral,
            false,
            MAX_VARIANCE_ROLL,
        )
    }

    #[test]
    fn deterministic() {
        assert_eq!(base(), base());
    }

    #[test]
    fn no_effect_is_zero() {
        assert_eq!(
            damage(
                50,
                100,
                100,
                60,
                Effectiveness::NoEffect,
                true,
                MAX_VARIANCE_ROLL
            ),
            0
        );
        // zero-power (e.g. a status move) also deals no damage.
        assert_eq!(
            damage(
                50,
                100,
                100,
                0,
                Effectiveness::SuperEffective,
                true,
                MAX_VARIANCE_ROLL
            ),
            0
        );
    }

    #[test]
    fn effectiveness_orders_damage() {
        let nve = damage(50, 100, 100, 60, Effectiveness::NotVeryEffective, false, 15);
        let neu = damage(50, 100, 100, 60, Effectiveness::Neutral, false, 15);
        let sup = damage(50, 100, 100, 60, Effectiveness::SuperEffective, false, 15);
        assert!(nve < neu && neu < sup, "nve {nve} < neu {neu} < sup {sup}");
    }

    #[test]
    fn stab_increases_damage() {
        let no_stab = damage(50, 100, 100, 60, Effectiveness::Neutral, false, 15);
        let stab = damage(50, 100, 100, 60, Effectiveness::Neutral, true, 15);
        assert!(stab > no_stab);
    }

    #[test]
    fn more_power_and_offense_more_damage_more_defense_less() {
        let d = damage(50, 100, 100, 60, Effectiveness::Neutral, false, 15);
        assert!(
            damage(50, 100, 100, 90, Effectiveness::Neutral, false, 15) > d,
            "power"
        );
        assert!(
            damage(50, 150, 100, 60, Effectiveness::Neutral, false, 15) > d,
            "offense"
        );
        assert!(
            damage(50, 100, 150, 60, Effectiveness::Neutral, false, 15) < d,
            "defense"
        );
        assert!(
            damage(60, 100, 100, 60, Effectiveness::Neutral, false, 15) > d,
            "level"
        );
    }

    #[test]
    fn variance_low_is_at_most_high_and_min_one() {
        let lo = damage(50, 100, 100, 60, Effectiveness::Neutral, false, 0);
        let hi = damage(50, 100, 100, 60, Effectiveness::Neutral, false, 15);
        assert!(lo <= hi);
        // Even a tiny attacker into a huge defender does at least 1 (it had an effect).
        assert_eq!(damage(1, 1, 60000, 10, Effectiveness::Neutral, false, 0), 1);
    }
}
