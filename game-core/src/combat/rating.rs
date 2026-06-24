//! PvP ladder rating (M11.3): a deterministic Elo-style update applied after a ranked battle. Pure —
//! the server runs it authoritatively when a PvP battle ends. Integer math only (no floats / `powf`),
//! so it is deterministic and reproducible.

/// The rating a new player starts at.
pub const STARTING_RATING: i32 = 1000;

/// Maximum single-match swing.
const K_FACTOR: i32 = 32;

/// New `(winner, loser)` ratings after a decisive ranked result. Elo-flavoured with integer math: the
/// swing is larger when the loser was rated at or above the winner (an upset) and smaller when the
/// favourite wins — but always between 1 and `K-1`, so a win is always worth something and never a
/// runaway. Zero-sum (the winner gains exactly what the loser drops).
pub fn elo_update(winner: i32, loser: i32) -> (i32, i32) {
    // diff > 0 when the loser was the higher-rated player (a bigger upset → bigger swing).
    let diff = loser - winner;
    let raw = K_FACTOR / 2 + diff * K_FACTOR / 800;
    let delta = raw.clamp(1, K_FACTOR - 1);
    (winner + delta, loser - delta)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn equal_ratings_swing_half_k() {
        let (w, l) = elo_update(1000, 1000);
        assert_eq!(w, 1016);
        assert_eq!(l, 984);
    }

    #[test]
    fn is_zero_sum() {
        for (a, b) in [(1000, 1000), (1200, 800), (800, 1200), (1500, 950)] {
            let (w, l) = elo_update(a, b);
            assert_eq!(w - a, b - l, "winner's gain equals the loser's drop");
        }
    }

    #[test]
    fn an_upset_swings_more_than_a_favourite_win() {
        let underdog = elo_update(800, 1200).0 - 800; // low-rated player beats a high-rated one
        let favourite = elo_update(1200, 800).0 - 1200; // high-rated player beats a low-rated one
        assert!(
            underdog > favourite,
            "beating a stronger opponent gains more"
        );
        assert!(favourite >= 1, "a win is always worth at least 1 point");
    }

    #[test]
    fn delta_is_bounded_and_deterministic() {
        // Extreme upset is capped at K-1, and the function is pure.
        let (w, l) = elo_update(100, 3000);
        assert_eq!(w - 100, K_FACTOR - 1);
        assert_eq!(elo_update(100, 3000), (w, l));
    }
}
