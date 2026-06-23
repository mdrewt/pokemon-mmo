// Generates a license-clean placeholder character spritesheet (PNG atlas + Pixi v8
// spritesheet JSON) into frontend/src/assets/. Zero external deps: the PNG is encoded
// with Node's built-in zlib. Run with `node scripts/gen-spritesheet.mjs`.
//
// One character, 16x16 frames, 4 facing directions x {idle:1, walk:2, jump:1}.
// The art is deliberately crude (a colored body block + a facing "eye" marker + a
// per-frame leg-offset for the walk cycle) — it only exists so the real
// Assets -> Spritesheet -> AnimatedSprite path is exercised. Swap in real art later by
// replacing the two output files; the renderer keys animations by name only.

import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ASSETS_DIR = join(__dirname, '..', 'src', 'assets');

const TILE = 16;

// Frame layout: 4 rows (one per direction) x 4 columns (idle, walk0, walk1, jump).
const DIRECTIONS = ['south', 'north', 'east', 'west'];
const COLUMNS = ['idle', 'walk0', 'walk1', 'jump'];
const COLS = COLUMNS.length;
const ROWS = DIRECTIONS.length;
const SHEET_W = TILE * COLS;
const SHEET_H = TILE * ROWS;

// Body tint per direction so each facing reads differently in the placeholder.
const BODY = {
  south: [70, 130, 200],
  north: [60, 100, 170],
  east: [90, 150, 210],
  west: [50, 110, 190],
};
const OUTLINE = [20, 24, 40];
const EYE = [250, 250, 250];

// RGBA pixel buffer for the whole atlas, transparent by default.
const px = new Uint8Array(SHEET_W * SHEET_H * 4);

function set(x, y, [r, g, b], a = 255) {
  if (x < 0 || y < 0 || x >= SHEET_W || y >= SHEET_H) return;
  const i = (y * SHEET_W + x) * 4;
  px[i] = r;
  px[i + 1] = g;
  px[i + 2] = b;
  px[i + 3] = a;
}

// Draw one 16x16 frame at tile (col,row).
function drawFrame(col, row, dir, kind) {
  const ox = col * TILE;
  const oy = row * TILE;
  const body = BODY[dir];

  // Walk cycle bobs the body 1px; jump lifts it 2px.
  let lift = 0;
  if (kind === 'walk1') lift = 1;
  if (kind === 'jump') lift = 2;

  // Body block (a rounded-ish rectangle) inset 2px, shifted up by `lift`.
  for (let y = 2; y < 14; y++) {
    for (let x = 3; x < 13; x++) {
      // Trim the corners for a softer silhouette.
      const corner =
        (x <= 3 || x >= 12) && (y <= 2 || y >= 13);
      if (corner) continue;
      const edge = x === 3 || x === 12 || y === 2 || y === 13;
      set(ox + x, oy + y - lift, edge ? OUTLINE : body);
    }
  }

  // Facing "eye" marker so direction is visible at a glance.
  const eyeRow = 6 - lift;
  if (dir === 'south') {
    set(ox + 6, oy + eyeRow, EYE);
    set(ox + 9, oy + eyeRow, EYE);
  } else if (dir === 'north') {
    // No eyes (back of head); add a small nub instead.
    set(ox + 7, oy + 3 - lift, OUTLINE);
    set(ox + 8, oy + 3 - lift, OUTLINE);
  } else if (dir === 'east') {
    set(ox + 10, oy + eyeRow, EYE);
  } else if (dir === 'west') {
    set(ox + 5, oy + eyeRow, EYE);
  }

  // Legs: idle/jump centered; walk frames alternate which leg steps forward.
  const legY = 13 - lift;
  if (kind === 'walk0') {
    set(ox + 5, oy + legY + 1, OUTLINE);
    set(ox + 10, oy + legY, OUTLINE);
  } else if (kind === 'walk1') {
    set(ox + 5, oy + legY, OUTLINE);
    set(ox + 10, oy + legY + 1, OUTLINE);
  } else {
    set(ox + 6, oy + legY + 1, OUTLINE);
    set(ox + 9, oy + legY + 1, OUTLINE);
  }
}

for (let r = 0; r < ROWS; r++) {
  for (let c = 0; c < COLS; c++) {
    drawFrame(c, r, DIRECTIONS[r], COLUMNS[c]);
  }
}

// ── Minimal PNG encoder (RGBA, 8-bit, no interlace) ───────────────────────────
function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(width, height, rgba) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace

  // Each scanline prefixed with a filter byte (0 = none).
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    rgba.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });

  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Spritesheet JSON (Pixi v8 format) ─────────────────────────────────────────
const frames = {};
const animations = {};

for (let r = 0; r < ROWS; r++) {
  const dir = DIRECTIONS[r];
  for (let c = 0; c < COLS; c++) {
    const kind = COLUMNS[c];
    const name = `${dir}_${kind}`;
    frames[name] = {
      frame: { x: c * TILE, y: r * TILE, w: TILE, h: TILE },
      sourceSize: { w: TILE, h: TILE },
      spriteSourceSize: { x: 0, y: 0, w: TILE, h: TILE },
    };
  }
  // Animation names are (action_direction); the renderer maps state -> these keys.
  animations[`idle_${dir}`] = [`${dir}_idle`];
  animations[`walk_${dir}`] = [`${dir}_walk0`, `${dir}_walk1`];
  animations[`jump_${dir}`] = [`${dir}_jump`];
}

const sheetJson = {
  frames,
  animations,
  meta: {
    image: 'character.png',
    format: 'RGBA8888',
    size: { w: SHEET_W, h: SHEET_H },
    scale: '1',
  },
};

mkdirSync(ASSETS_DIR, { recursive: true });
writeFileSync(join(ASSETS_DIR, 'character.png'), encodePng(SHEET_W, SHEET_H, px));
writeFileSync(
  join(ASSETS_DIR, 'character.json'),
  `${JSON.stringify(sheetJson, null, 2)}\n`,
);

console.log(
  `Wrote ${SHEET_W}x${SHEET_H} atlas (${Object.keys(frames).length} frames, ` +
    `${Object.keys(animations).length} animations) to src/assets/`,
);
