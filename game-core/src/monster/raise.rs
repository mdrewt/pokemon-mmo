//! Active-raising rules (M9): focus-training (food shapes the stat spread) and care (builds bond).
//! Pure & deterministic — the server validates ownership + cost/cooldown, then applies these; the
//! resulting `Training`/`Bond` feed back through `derive_stats` so the monster's stats visibly
//! diverge from how it was raised. No idle growth: every change is a deliberate, server-gated action.

use super::model::{Bond, Stat, Training};

/// Apply `amount` training to `stat`, capped at the per-stat and total maxima. Returns the new
/// `Training`. **Rejects** (not silently no-ops) when there is no headroom — the stat is already at
/// its per-stat cap, or the total cap is reached — so the reducer can tell the player "already fully
/// trained" and not consume the food for nothing. With headroom but less than `amount`, it fills to
/// the cap (a food near the cap isn't wasted, it just tops off).
pub fn apply_training(mut training: Training, stat: Stat, amount: u16) -> Result<Training, String> {
    let current = training.get(stat);
    if current >= Training::PER_STAT_MAX {
        return Err("that stat is already fully trained".to_string());
    }
    let total = training.total();
    if total >= Training::TOTAL_MAX {
        return Err("this monster is fully trained".to_string());
    }
    let stat_headroom = Training::PER_STAT_MAX - current;
    let total_headroom = Training::TOTAL_MAX - total;
    let applied = amount.min(stat_headroom).min(total_headroom);
    training.set(stat, current + applied);
    Ok(training)
}

/// Increase `bond` by `amount`, capped at [`Bond::MAX`]. The server gates the cooldown; this is the
/// pure increment. Caring for an already-maxed monster is a harmless no-op (returns the cap).
pub fn apply_care(bond: Bond, amount: u16) -> Bond {
    Bond(bond.0.saturating_add(amount).min(Bond::MAX))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn training_adds_to_the_chosen_stat() {
        let t = apply_training(Training::default(), Stat::Attack, 60).unwrap();
        assert_eq!(t.attack, 60);
        assert_eq!(t.defense, 0, "other stats untouched");
        assert_eq!(t.total(), 60);
    }

    #[test]
    fn training_fills_to_the_per_stat_cap_then_rejects() {
        // 252 cap: 60*4 = 240, then +60 fills to 252 (tops off), then a further attempt rejects.
        let mut t = Training::default();
        for _ in 0..4 {
            t = apply_training(t, Stat::Speed, 60).unwrap();
        }
        assert_eq!(t.speed, 240);
        let t = apply_training(t, Stat::Speed, 60).unwrap();
        assert_eq!(
            t.speed,
            Training::PER_STAT_MAX,
            "fills to the cap, not past it"
        );
        assert!(
            apply_training(t, Stat::Speed, 60).is_err(),
            "at cap → rejected"
        );
    }

    #[test]
    fn training_respects_the_total_cap() {
        // Fill two stats to 252 (504), then a third can only take 6 before the 510 total cap.
        let mut t = Training::default();
        t.set(Stat::Attack, 252);
        t.set(Stat::Defense, 252);
        assert_eq!(t.total(), 504);
        let t = apply_training(t, Stat::Speed, 60).unwrap();
        assert_eq!(t.speed, 6, "clamped by the total cap");
        assert_eq!(t.total(), Training::TOTAL_MAX);
        assert!(
            apply_training(t, Stat::Special, 60).is_err(),
            "total cap reached → rejected"
        );
    }

    #[test]
    fn training_is_deterministic() {
        let a = apply_training(Training::default(), Stat::Special, 40);
        let b = apply_training(Training::default(), Stat::Special, 40);
        assert_eq!(a, b);
    }

    #[test]
    fn care_increases_bond_up_to_the_cap() {
        assert_eq!(apply_care(Bond(20), 5), Bond(25));
        assert_eq!(
            apply_care(Bond(Bond::MAX - 2), 10),
            Bond(Bond::MAX),
            "capped"
        );
        assert_eq!(
            apply_care(Bond(Bond::MAX), 5),
            Bond(Bond::MAX),
            "no-op at max"
        );
    }
}
