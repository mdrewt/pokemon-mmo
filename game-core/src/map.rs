//! Static map / collision data.
//!
//! For the POC the map is a hand-authored `const`-style walkability grid produced by
//! [`poc_map`], shared *verbatim* by client and server (identical bytes ⇒ zero desync surface).
//! A Tiled-authored, multi-map pipeline replaces this later — but not until a second map exists.

use crate::types::TilePos;

/// A row-major walkability grid. `true` = a character may stand on the tile.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TileMap {
    pub width: i32,
    pub height: i32,
    /// Row-major, length == `width * height`.
    pub walkable: Vec<bool>,
}

impl TileMap {
    /// Whether `pos` is inside the grid bounds. (Pure index math, not a game rule.)
    pub fn in_bounds(&self, pos: TilePos) -> bool {
        pos.x >= 0 && pos.y >= 0 && pos.x < self.width && pos.y < self.height
    }

    /// Whether `pos` is in bounds AND walkable.
    pub fn is_walkable(&self, pos: TilePos) -> bool {
        self.in_bounds(pos)
            && self
                .walkable
                .get((pos.y * self.width + pos.x) as usize)
                .copied()
                .unwrap_or(false)
    }
}

/// The single POC map (~20×15), hand-authored. Returns an owned [`TileMap`].
pub fn poc_map() -> TileMap {
    todo!("M1: author the ~20x15 POC walkability grid")
}
