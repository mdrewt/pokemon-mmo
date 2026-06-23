// Renders the POC map once into a Container of tile sprites. Walkable = floor, blocked =
// wall, with distinct colors. No camera: the whole ~20x15 map fits on screen at TILE_PX.
//
// Pixi-only module. The grid comes from game-core (via wasm.pocMap()); we never author map
// data here.

import { Container, Graphics } from 'pixi.js';
import type { WasmMap } from '../wasm';

/** Source tile size in the spritesheet (px). */
export const TILE_SRC = 16;
/** On-screen render scale (3x => 48px tiles). */
export const TILE_SCALE = 3;
/** On-screen tile size (px). */
export const TILE_PX = TILE_SRC * TILE_SCALE;

const FLOOR = 0x2e3a4f;
const FLOOR_ALT = 0x27324a;
const WALL = 0x12161f;
const WALL_TOP = 0x1c2230;
const GRID_LINE = 0x1a2233;

export function pixelWidth(map: WasmMap): number {
  return map.width * TILE_PX;
}

export function pixelHeight(map: WasmMap): number {
  return map.height * TILE_PX;
}

/** Convert a tile (x,y) to the top-left pixel of that tile. */
export function tileToPixel(tx: number, ty: number): { x: number; y: number } {
  return { x: tx * TILE_PX, y: ty * TILE_PX };
}

/**
 * Build the static tilemap container. Drawn once with Graphics (the map never changes in
 * the POC), so there is nothing to update per frame.
 */
export function buildTilemap(map: WasmMap): Container {
  const layer = new Container({ label: 'tilemap' });
  const g = new Graphics();

  for (let y = 0; y < map.height; y++) {
    for (let x = 0; x < map.width; x++) {
      const idx = y * map.width + x;
      const walkable = map.walkable[idx] ?? false;
      const px = x * TILE_PX;
      const py = y * TILE_PX;

      if (walkable) {
        const checker = (x + y) % 2 === 0 ? FLOOR : FLOOR_ALT;
        g.rect(px, py, TILE_PX, TILE_PX).fill(checker);
        // Subtle grid line for readability.
        g.rect(px, py, TILE_PX, TILE_PX).stroke({ width: 1, color: GRID_LINE });
      } else {
        g.rect(px, py, TILE_PX, TILE_PX).fill(WALL);
        // A lighter cap on the top of walls for a hint of depth.
        g.rect(px, py, TILE_PX, TILE_PX / 4).fill(WALL_TOP);
      }
    }
  }

  layer.addChild(g);
  return layer;
}
