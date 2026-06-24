//! Item content — data-driven like species/skills: authored in RON, parsed by `crate::load_items`,
//! seeded into the server's `item` table. Kept deliberately minimal (KISS) — a generic
//! inventory/crafting system is YAGNI until a milestone needs it. M8 added recruit **bait**; M9 adds
//! training **food**. An item carries whichever effect is non-zero (the others stay 0/`None`).

use serde::{Deserialize, Serialize};

use crate::monster::Stat;

/// An item TEMPLATE. Effects are independent, data-driven fields:
/// - `recruit_bonus` (permille) is added to the recruit chance when used in a recruit attempt (bait).
/// - `train_stat`/`train_amount`: training **food** — using it adds `train_amount` investment to that
///   stat (see `crate::apply_training`). `train_stat == None` ⇒ not food.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Item {
    pub id: u32,
    pub name: String,
    /// Recruit-chance bonus in permille (0..=1000) when used in a recruit attempt.
    pub recruit_bonus: u16,
    /// The stat this food trains, or `None` for a non-food item.
    pub train_stat: Option<Stat>,
    /// Training investment granted (only meaningful when `train_stat` is `Some`).
    pub train_amount: u16,
}

impl Item {
    /// Whether this item is training food (used by the box "Raise" UI + the train reducer).
    pub fn is_food(&self) -> bool {
        self.train_stat.is_some()
    }
}
