// Unit tests for the move-buffer prediction state machine with a MOCKED apply_move. No wasm is
// loaded in node — the movement rule itself is tested in game-core (Rust); here we only test the
// queue buffering, the STEP_MS drain cadence, and reconciliation (ack-drop + replay + snap).

import { describe, it, expect } from 'vitest';
import { Predictor, type ApplyMoveFn } from './predictor';
import type { WasmCharacterState, WasmFacing, WasmMoveInput } from '../wasm';

const DELTA: Record<WasmFacing, [number, number]> = {
  North: [0, -1],
  South: [0, 1],
  East: [1, 0],
  West: [-1, 0],
};

// Mock of game-core's apply_move: Step/Jump move one tile in the (new) facing; sets
// move_started_at = now. Lets the queue/drain/reconcile logic be tested without the wasm.
const mockApply: ApplyMoveFn = (state, input: WasmMoveInput, now) => {
  const next: WasmCharacterState = { ...state, pos: { ...state.pos }, move_started_at: now };
  if (input === 'Jump') {
    const [dx, dy] = DELTA[state.facing];
    next.pos = { x: state.pos.x + dx, y: state.pos.y + dy };
    next.action = 'Jumping';
  } else {
    next.facing = input.Step;
    const [dx, dy] = DELTA[input.Step];
    next.pos = { x: state.pos.x + dx, y: state.pos.y + dy };
    next.action = 'Walking';
  }
  return next;
};

const STEP = 200;
const initial = (): WasmCharacterState => ({
  pos: { x: 0, y: 0 },
  facing: 'South',
  action: 'Idle',
  move_started_at: 0,
});

describe('Predictor (server-paced move buffer)', () => {
  it('enqueue assigns sequential seqs and buffers locally', () => {
    const p = new Predictor(mockApply, STEP, initial());
    expect(p.enqueue({ Step: 'East' })).toBe(1n);
    expect(p.enqueue({ Step: 'East' })).toBe(2n);
    expect(p.queueDepth).toBe(2);
    expect(p.pendingCount).toBe(2);
    expect(p.nextSeq).toBe(3n);
  });

  it('drain advances at most one tile per STEP_MS', () => {
    const p = new Predictor(mockApply, STEP, initial());
    p.enqueue({ Step: 'East' });
    p.enqueue({ Step: 'East' });

    p.drain(STEP); // first move is due (move_started_at started at 0)
    expect(p.predicted.pos).toEqual({ x: 1, y: 0 });
    expect(p.queueDepth).toBe(1);

    p.drain(STEP + 50); // second not yet due
    expect(p.predicted.pos).toEqual({ x: 1, y: 0 });

    p.drain(2 * STEP); // now due
    expect(p.predicted.pos).toEqual({ x: 2, y: 0 });
    expect(p.queueDepth).toBe(0);
  });

  it('drain is a no-op with an empty queue', () => {
    const p = new Predictor(mockApply, STEP, initial());
    p.drain(10 * STEP);
    expect(p.predicted.pos).toEqual({ x: 0, y: 0 });
  });

  it('reconcile drops acked pending and replays the un-acked tail', () => {
    const p = new Predictor(mockApply, STEP, initial());
    p.enqueue({ Step: 'East' }); // seq 1
    p.enqueue({ Step: 'East' }); // seq 2

    // Server acked seq 1; authoritative moved to (1,0) with an empty server queue.
    const auth: WasmCharacterState = {
      pos: { x: 1, y: 0 },
      facing: 'East',
      action: 'Walking',
      move_started_at: 1000,
    };
    p.reconcile(auth, [], 1n, 1000 + STEP);

    expect(p.pendingCount).toBe(1); // seq 2 still pending
    expect(p.predicted.pos).toEqual({ x: 2, y: 0 }); // auth (1,0) + replayed seq 2, drained
  });

  it('reconcile snaps to authoritative on a misprediction', () => {
    const p = new Predictor(mockApply, STEP, initial());
    p.enqueue({ Step: 'East' });
    p.drain(STEP);
    expect(p.predicted.pos).toEqual({ x: 1, y: 0 });

    // Server says the move didn't land (e.g. a bump): authoritative (0,0), acked seq 1, empty queue.
    const auth: WasmCharacterState = {
      pos: { x: 0, y: 0 },
      facing: 'East',
      action: 'Idle',
      move_started_at: 1000,
    };
    p.reconcile(auth, [], 1n, 1000);
    expect(p.pendingCount).toBe(0);
    expect(p.predicted.pos).toEqual({ x: 0, y: 0 }); // snapped back to truth
  });

  it('rebuilds with the authoritative server queue ahead of pending', () => {
    const p = new Predictor(mockApply, STEP, initial());
    p.enqueue({ Step: 'South' }); // seq 1, still pending

    // Authoritative at (0,0); the server already has a queued East move; our South is un-acked.
    const auth: WasmCharacterState = {
      pos: { x: 0, y: 0 },
      facing: 'South',
      action: 'Idle',
      move_started_at: 0,
    };
    p.reconcile(auth, [{ Step: 'East' }], 0n, STEP); // one move due at now=STEP
    expect(p.predicted.pos).toEqual({ x: 1, y: 0 }); // server-queued East drains first
    expect(p.queueDepth).toBe(1); // South still queued
  });

  it('setMove replaces the whole un-drained buffer (responsive turn)', () => {
    const p = new Predictor(mockApply, STEP, initial());
    p.enqueue({ Step: 'East' });
    p.enqueue({ Step: 'East' });
    expect(p.queueDepth).toBe(2);
    p.setMove({ Step: 'South' });
    expect(p.queueDepth).toBe(1);
    expect(p.lastQueuedDir()).toBe('South');
  });

  it('clearQueue empties the un-drained buffer', () => {
    const p = new Predictor(mockApply, STEP, initial());
    p.enqueue({ Step: 'East' });
    p.clearQueue();
    expect(p.queueDepth).toBe(0);
  });

  it('reconcile replays a pending setMove, clearing the stale authoritative queue', () => {
    const p = new Predictor(mockApply, STEP, initial());
    p.enqueue({ Step: 'East' }); // seq 1
    p.setMove({ Step: 'South' }); // seq 2 — turns; locally clears the East

    // Server hasn't applied either yet: authoritative still has a stale East queued, ack 0.
    const auth: WasmCharacterState = {
      pos: { x: 0, y: 0 },
      facing: 'East',
      action: 'Idle',
      move_started_at: 0,
    };
    p.reconcile(auth, [{ Step: 'East' }], 0n, STEP);
    // Replay: authQueue [East] -> enqueue East -> [East,East] -> setMove South -> [South]. One due.
    expect(p.predicted.pos).toEqual({ x: 0, y: 1 }); // moved South, not East
    expect(p.queueDepth).toBe(0);
  });
});
