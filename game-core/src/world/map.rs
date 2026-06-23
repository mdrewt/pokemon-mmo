//! Static map / collision data.
//!
//! For the POC the map is a hand-authored `const`-style walkability grid produced by
//! [`poc_map`], shared *verbatim* by client and server (identical bytes ⇒ zero desync surface).
//! A Tiled-authored, multi-map pipeline replaces this later — but not until a second map exists.

use serde::{Deserialize, Serialize};

use crate::types::TilePos;

/// A row-major walkability grid. `true` = a character may stand on the tile.
/// Serializable so `client-wasm` can hand it to the renderer.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
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

    /// Build a map from string-art rows (`.` walkable, anything else blocked). All rows must
    /// share the first row's length. Used by [`poc_map`] and tests.
    pub(crate) fn from_rows(rows: &[&str]) -> TileMap {
        let height = rows.len() as i32;
        let width = rows.first().map_or(0, |r| r.len() as i32);
        let walkable: Vec<bool> = rows
            .iter()
            .flat_map(|row| row.chars().map(|c| c == '.'))
            .collect();
        debug_assert_eq!(
            walkable.len() as i32,
            width * height,
            "all rows must be the same length"
        );
        TileMap {
            width,
            height,
            walkable,
        }
    }
}

/// The single POC map (20×15), hand-authored as string art (`.` walkable, `#` blocked).
/// Shared verbatim by client and server.
pub fn poc_map() -> TileMap {
    const ROWS: [&str; 15] = [
        "####################",
        "#..................#",
        "#..####....####....#",
        "#..................#",
        "#....####..........#",
        "#..................#",
        "#........##........#",
        "#........##........#",
        "#..................#",
        "#..........####....#",
        "#..####............#",
        "#..................#",
        "#..................#",
        "#..................#",
        "####################",
    ];
    TileMap::from_rows(&ROWS)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn poc_map_dimensions_are_consistent() {
        let m = poc_map();
        assert_eq!(m.width, 20);
        assert_eq!(m.height, 15);
        assert_eq!(m.walkable.len() as i32, m.width * m.height);
    }

    #[test]
    fn border_is_blocked() {
        let m = poc_map();
        for x in 0..m.width {
            assert!(!m.is_walkable(TilePos { x, y: 0 }), "top row x={x}");
            assert!(
                !m.is_walkable(TilePos { x, y: m.height - 1 }),
                "bottom row x={x}"
            );
        }
        for y in 0..m.height {
            assert!(!m.is_walkable(TilePos { x: 0, y }), "left col y={y}");
            assert!(
                !m.is_walkable(TilePos { x: m.width - 1, y }),
                "right col y={y}"
            );
        }
    }

    #[test]
    fn interior_open_tile_is_walkable() {
        // Row 1 is all-open interior.
        assert!(poc_map().is_walkable(TilePos { x: 1, y: 1 }));
    }

    #[test]
    fn interior_obstacle_is_blocked() {
        // Row 6 has a `##` obstacle at x = 9..=10.
        assert!(!poc_map().is_walkable(TilePos { x: 9, y: 6 }));
    }

    #[test]
    fn out_of_bounds_is_not_walkable() {
        let m = poc_map();
        assert!(!m.is_walkable(TilePos { x: -1, y: 5 }));
        assert!(!m.is_walkable(TilePos { x: 5, y: -1 }));
        assert!(!m.is_walkable(TilePos {
            x: m.width,
            y: m.height
        }));
    }
}
