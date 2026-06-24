// A pooled renderable for one character entity, backed by an AnimatedSprite. Reused across
// frames: we mutate the existing sprite and swap its texture set when (action, facing)
// changes — we never recreate display objects per frame.
//
// Visual position is a lerp between a "from" tile and a "to" tile over step_ms, timed from
// a start instant. For remote characters that instant is the LOCAL receipt time of the
// subscription update; for the predicted own character it is the local input instant. The
// owner of the view sets those via `moveTo`.

import { AnimatedSprite, type Texture } from 'pixi.js';
import { TILE_PX } from './tilemap';
import type { WasmAction, WasmFacing } from '../wasm';

/** Animation frame sets keyed by `${action}_${direction}` (e.g. "walk_south"). */
export type AnimationTextures = Record<string, Texture[]>;

const DIR_KEY: Record<WasmFacing, string> = {
  North: 'north',
  South: 'south',
  East: 'east',
  West: 'west',
};

function actionKey(action: WasmAction): string {
  switch (action) {
    case 'Walking':
      return 'walk';
    case 'Jumping':
      return 'jump';
    case 'Idle':
      return 'idle';
  }
}

/** Map (action, facing) to the spritesheet animation key. */
export function animationKey(action: WasmAction, facing: WasmFacing): string {
  return `${actionKey(action)}_${DIR_KEY[facing]}`;
}

export class CharacterView {
  readonly sprite: AnimatedSprite;
  #anims: AnimationTextures;
  #currentKey = '';

  // Interpolation: slide from (fromX,fromY) to (toX,toY) starting at #startMs over #durMs.
  #fromX: number;
  #fromY: number;
  #toX: number;
  #toY: number;
  #startMs = 0;
  #durMs = 1; // avoid divide-by-zero before first move

  constructor(anims: AnimationTextures, tileX: number, tileY: number) {
    this.#anims = anims;
    this.#fromX = tileX;
    this.#fromY = tileY;
    this.#toX = tileX;
    this.#toY = tileY;

    const initial = anims['idle_south'] ?? Object.values(anims)[0] ?? [];
    this.sprite = new AnimatedSprite({
      textures: initial,
      animationSpeed: 0.12,
      loop: true,
      autoPlay: true,
      anchor: 0,
    });
    this.sprite.scale.set(TILE_PX / this.sprite.texture.width);
    this.#currentKey = 'idle_south';
    this.#placeAt(tileX, tileY);
  }

  /** Switch the active animation set if (action, facing) changed. */
  setAnimation(action: WasmAction, facing: WasmFacing): void {
    const key = animationKey(action, facing);
    if (key === this.#currentKey) return;
    const textures = this.#anims[key];
    if (!textures || textures.length === 0) return;
    this.#currentKey = key;
    this.sprite.textures = textures;
    this.sprite.play();
  }

  /**
   * Begin sliding to a new target tile. `startMs` is the interpolation start instant in the
   * same clock used by `update` (performance.now). The current interpolated position
   * becomes the new "from" so movement is continuous even mid-slide.
   */
  moveTo(toX: number, toY: number, startMs: number, durMs: number): void {
    const cur = this.#currentInterp(startMs);
    this.#fromX = cur.x;
    this.#fromY = cur.y;
    this.#toX = toX;
    this.#toY = toY;
    this.#startMs = startMs;
    this.#durMs = Math.max(1, durMs);
  }

  /** Advance the visual interpolation to wall-clock `nowMs`. */
  update(nowMs: number): void {
    const p = this.#currentInterp(nowMs);
    this.#placeAt(p.x, p.y);
  }

  #currentInterp(nowMs: number): { x: number; y: number } {
    const t = Math.min(1, Math.max(0, (nowMs - this.#startMs) / this.#durMs));
    return {
      x: this.#fromX + (this.#toX - this.#fromX) * t,
      y: this.#fromY + (this.#toY - this.#fromY) * t,
    };
  }

  #placeAt(tileX: number, tileY: number): void {
    this.sprite.x = tileX * TILE_PX;
    this.sprite.y = tileY * TILE_PX;
  }

  destroy(): void {
    this.sprite.destroy();
  }
}
