//! Item content (M8 ships only taming bait). Data-driven like species/skills: authored in RON,
//! parsed by `crate::load_items`, seeded into the server's `item` table. Kept deliberately minimal
//! (KISS) — a generic inventory/crafting system is YAGNI until a milestone needs it.

use serde::{Deserialize, Serialize};

/// An item TEMPLATE. M8's only kind is recruit bait: `recruit_bonus` permille is added to the
/// recruit chance when the item is used during a recruit attempt (see `crate::recruit_chance`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: u32,
    pub name: String,
    /// Recruit-chance bonus in permille (0..=1000) when used in a recruit attempt.
    pub recruit_bonus: u16,
}
