// Client-side prediction for the local player's own character under the server-paced move-buffer
// model.
//
// PURE of Pixi and of the wasm module: the `applyMove` function is injected, so this is
// unit-testable in node with a mock (see predictor.test.ts). All game rules live in game-core via
// that injected function; this file only buffers inputs, drains them on the same `STEP_MS` cadence
// the server ticks at, and reconciles against authoritative state.
//
// State:
// - `#predicted` — the own character's predicted state (what the renderer shows). Advanced only by
//                  `drain` (discrete, so the slide animation stays stable between steps).
// - `#queue`     — predicted moves not yet drained locally (rebuilt by `reconcile`).
// - `#pending`   — queue OPERATIONS sent to the server but not yet acked (`seq > last_input_seq`).
//                  Kept as ops (enqueue / setMove / clear) — not bare inputs — so `reconcile` can
//                  replay them faithfully on top of authoritative truth (a setMove/clear that the
//                  server hasn't applied yet still clears the stale authoritative queue in replay).

import type { WasmCharacterState, WasmFacing, WasmMoveInput } from '../wasm';

/** The injected drain step. Mirrors `wasm.applyMove`; never throws (a blocked move is a no-op). */
export type ApplyMoveFn = (
  state: WasmCharacterState,
  input: WasmMoveInput,
  now: number,
) => WasmCharacterState;

type QueueOp =
  | { kind: 'enqueue'; input: WasmMoveInput }
  | { kind: 'setMove'; input: WasmMoveInput }
  | { kind: 'clear' };

interface PendingOp {
  seq: bigint;
  op: QueueOp;
}

function applyOp(queue: WasmMoveInput[], op: QueueOp): WasmMoveInput[] {
  switch (op.kind) {
    case 'enqueue':
      return [...queue, op.input];
    case 'setMove':
      return [op.input];
    case 'clear':
      return [];
  }
}

export class Predictor {
  #applyMove: ApplyMoveFn;
  #stepMs: number;
  #predicted: WasmCharacterState;
  #queue: WasmMoveInput[] = [];
  #pending: PendingOp[] = [];
  #nextSeq = 1n;

  constructor(applyMove: ApplyMoveFn, stepMs: number, initial: WasmCharacterState) {
    this.#applyMove = applyMove;
    this.#stepMs = stepMs;
    this.#predicted = initial;
  }

  get predicted(): WasmCharacterState {
    return this.#predicted;
  }

  /** Moves predicted-but-not-yet-drained locally. */
  get queueDepth(): number {
    return this.#queue.length;
  }

  /** Queue operations sent but not yet acked by the server. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  get nextSeq(): bigint {
    return this.#nextSeq;
  }

  /** The facing of the last queued `Step`, or null if the queue is empty or ends in a `Jump`. */
  lastQueuedDir(): WasmFacing | null {
    const last = this.#queue.at(-1);
    return last && last !== 'Jump' ? last.Step : null;
  }

  #record(op: QueueOp): bigint {
    const seq = this.#nextSeq;
    this.#nextSeq += 1n;
    this.#queue = applyOp(this.#queue, op);
    this.#pending.push({ seq, op });
    return seq;
  }

  /** Append a move to the buffer (top up while holding). Returns the seq for the caller to send. */
  enqueue(input: WasmMoveInput): bigint {
    return this.#record({ kind: 'enqueue', input });
  }

  /** Replace the whole un-drained buffer with one move (responsive turn / first step from idle). */
  setMove(input: WasmMoveInput): bigint {
    return this.#record({ kind: 'setMove', input });
  }

  /** Clear the un-drained buffer (stop-movement action). */
  clearQueue(): bigint {
    return this.#record({ kind: 'clear' });
  }

  /**
   * Advance the predicted state by draining any moves whose slide has completed. Each drained move
   * starts the next slide; consecutive moves chain exactly `STEP_MS` apart (no gap → smooth), but
   * if we were idle/behind, the next slide starts at `now` rather than in the past.
   */
  drain(now: number): void {
    while (this.#queue.length > 0 && now - this.#predicted.move_started_at >= this.#stepMs) {
      const input = this.#queue.shift() as WasmMoveInput;
      const chained = this.#predicted.move_started_at + this.#stepMs;
      const start = now - chained > this.#stepMs ? now : chained;
      this.#predicted = this.#applyMove(this.#predicted, input, start);
    }
  }

  /**
   * Reconcile against an authoritative own-character update: drop acked operations, reset predicted
   * to authoritative truth, rebuild the queue by replaying the still-pending OPS on top of the
   * authoritative queue, and re-drain to `now`. `authState.move_started_at` must already be rebased
   * to the local clock.
   */
  reconcile(
    authState: WasmCharacterState,
    authQueue: WasmMoveInput[],
    ackedSeq: bigint,
    now: number,
  ): void {
    this.#pending = this.#pending.filter((p) => p.seq > ackedSeq);
    let queue = [...authQueue];
    for (const p of this.#pending) queue = applyOp(queue, p.op);
    this.#queue = queue;
    this.#predicted = authState;
    this.drain(now);
  }
}
