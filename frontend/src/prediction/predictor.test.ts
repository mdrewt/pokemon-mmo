// Unit tests for the prediction/reconciliation state machine against a FAKE authoritative
// stream with a MOCKED predict_input. No wasm is loaded in node — the movement rule itself
// is tested in game-core (Rust); here we only test sequencing, ack-drop, replay, and snap.

import { describe, it, expect, vi } from 'vitest';
import { Predictor, type PredictFn } from './predictor';
import type { WasmCharacterState, WasmMoveInput, WasmFacing } from '../wasm';

function state(x: number, y: number, facing: WasmFacing = 'South'): WasmCharacterState {
  return { pos: { x, y }, facing, action: 'Idle', move_started_at: 0 };
}

/** A deterministic mock rule: Step moves one tile in the given direction; Jump no-ops. */
const DELTA: Record<WasmFacing, { x: number; y: number }> = {
  North: { x: 0, y: -1 },
  South: { x: 0, y: 1 },
  East: { x: 1, y: 0 },
  West: { x: -1, y: 0 },
};

const mockStep: PredictFn = (s, input, now) => {
  if (input === 'Jump') {
    return { ...s, action: 'Jumping', move_started_at: now };
  }
  const dir = input.Step;
  const d = DELTA[dir];
  return {
    pos: { x: s.pos.x + d.x, y: s.pos.y + d.y },
    facing: dir,
    action: 'Walking',
    move_started_at: now,
  };
};

const stepWest: WasmMoveInput = { Step: 'West' };
const stepEast: WasmMoveInput = { Step: 'East' };

describe('Predictor', () => {
  it('applies an input locally and advances predicted state', () => {
    const p = new Predictor(mockStep, state(5, 5));
    const seq = p.applyInput(stepEast, 100);

    expect(seq).toBe(1n);
    expect(p.predicted.pos).toEqual({ x: 6, y: 5 });
    expect(p.predicted.facing).toBe('East');
    expect(p.pendingCount).toBe(1);
    expect(p.nextSeq).toBe(2n);
  });

  it('assigns increasing seqs and buffers multiple pending inputs', () => {
    const p = new Predictor(mockStep, state(0, 0));
    expect(p.applyInput(stepEast, 0)).toBe(1n);
    expect(p.applyInput(stepEast, 200)).toBe(2n);
    expect(p.applyInput(stepEast, 400)).toBe(3n);

    expect(p.predicted.pos).toEqual({ x: 3, y: 0 });
    expect(p.pendingCount).toBe(3);
  });

  it('drops acked inputs on reconcile and keeps the rest', () => {
    const p = new Predictor(mockStep, state(0, 0));
    p.applyInput(stepEast, 0); // seq 1
    p.applyInput(stepEast, 200); // seq 2
    p.applyInput(stepEast, 400); // seq 3
    expect(p.pendingCount).toBe(3);

    // Server has applied seq 1; authoritative tile is now (1,0).
    p.reconcile(state(1, 0, 'East'), 1n);

    // seq 1 dropped; seqs 2 & 3 still pending and replayed from authoritative (1,0).
    expect(p.pendingCount).toBe(2);
    expect(p.predicted.pos).toEqual({ x: 3, y: 0 });
  });

  it('replay reproduces predicted state when the server agrees (no snap)', () => {
    const p = new Predictor(mockStep, state(10, 10));
    p.applyInput(stepWest, 0); // -> (9,10)
    p.applyInput(stepWest, 200); // -> (8,10)
    const before = p.predicted.pos;

    // Server acks seq 1 with the same result the client predicted (9,10).
    p.reconcile(state(9, 10, 'West'), 1n);

    // Replaying the remaining pending input (seq 2) lands back on (8,10): no visible snap.
    expect(p.predicted.pos).toEqual(before);
    expect(p.predicted.pos).toEqual({ x: 8, y: 10 });
    expect(p.pendingCount).toBe(1);
  });

  it('snaps back to authoritative on a genuine misprediction', () => {
    const p = new Predictor(mockStep, state(5, 5));
    p.applyInput(stepEast, 0); // client predicts (6,5)
    expect(p.predicted.pos).toEqual({ x: 6, y: 5 });

    // Server rejected the step (e.g. wall) — it acks seq 1 but authoritative stayed (5,5).
    p.reconcile(state(5, 5, 'East'), 1n);

    // No pending inputs remain; predicted snaps to authoritative truth.
    expect(p.pendingCount).toBe(0);
    expect(p.predicted.pos).toEqual({ x: 5, y: 5 });
  });

  it('does not record or count an input the rule rejects locally', () => {
    const throwing: PredictFn = vi.fn(() => {
      throw new Error('TooSoon');
    });
    const p = new Predictor(throwing, state(0, 0));

    const seq = p.applyInput(stepEast, 0);
    expect(seq).toBeNull();
    expect(p.pendingCount).toBe(0);
    expect(p.nextSeq).toBe(1n); // counter not advanced
    expect(p.predicted.pos).toEqual({ x: 0, y: 0 });
  });

  it('drops a pending input during replay if it becomes illegal against truth', () => {
    // Replay-time rejection: a pending input that throws when re-applied is discarded.
    let calls = 0;
    const sometimesThrows: PredictFn = (s, input, now) => {
      calls += 1;
      // The replayed (second) call throws to simulate the input now being illegal.
      if (calls >= 2 && input !== 'Jump') throw new Error('illegal now');
      return mockStep(s, input, now);
    };

    const p = new Predictor(sometimesThrows, state(0, 0));
    p.applyInput(stepEast, 0); // seq 1, applied cleanly (calls=1)

    // Reconcile with ack 0 (nothing acked) -> replay seq 1, which now throws.
    p.reconcile(state(0, 0, 'South'), 0n);

    expect(p.pendingCount).toBe(0);
    expect(p.predicted.pos).toEqual({ x: 0, y: 0 });
  });

  it('reset clears pending and rebaselines predicted', () => {
    const p = new Predictor(mockStep, state(0, 0));
    p.applyInput(stepEast, 0);
    p.applyInput(stepEast, 200);

    p.reset(state(7, 7, 'North'));
    expect(p.pendingCount).toBe(0);
    expect(p.predicted.pos).toEqual({ x: 7, y: 7 });
    expect(p.predicted.facing).toBe('North');
  });
});
