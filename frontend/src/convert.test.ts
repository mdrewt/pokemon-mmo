import { describe, it, expect } from 'vitest';
import { characterToPredictedBaseline } from './convert';
import type { Character } from './module_bindings/types';

function fakeChar(): Character {
  return {
    entityId: 1n,
    mapId: 0,
    tileX: 4,
    tileY: 5,
    facing: { tag: 'South' },
    action: { tag: 'Idle' },
    moveStartedAtMs: 0n,
    spriteId: 0,
  } as Character;
}

describe('characterToPredictedBaseline', () => {
  // Regression: `performance.now()` returns fractional ms, but game-core deserializes
  // move_started_at as `Millis(u64)` — a fractional value makes the wasm serde reject the whole
  // CharacterState ("expected u64"), which silently broke ALL client prediction.
  it('floors move_started_at to an integer', () => {
    const base = characterToPredictedBaseline(fakeChar(), 30336.30000001192, 200);
    expect(Number.isInteger(base.move_started_at)).toBe(true);
    expect(base.move_started_at).toBe(30336 - 400);
  });

  it('keeps the tile/facing/action from the row', () => {
    const base = characterToPredictedBaseline(fakeChar(), 1000.5, 200);
    expect(base.pos).toEqual({ x: 4, y: 5 });
    expect(base.facing).toBe('South');
    expect(base.action).toBe('Idle');
  });
});
