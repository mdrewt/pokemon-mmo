// Client-side prediction for the local player's own character under the server-paced
// move-buffer model.
//
// PURE of Pixi and of the wasm module: the `applyMove` function is injected, so this is
// unit-testable in node with a mock (see predictor.test.ts). All game rules live in game-core
// via that injected function; this file only buffers inputs, drains them on the same `STEP_MS`
// cadence the server ticks at, and reconciles against authoritative state.
//
// Three pieces of state:
// - `#predicted`  — the own character's predicted state (what the renderer shows). Advanced only
//                   by `drain` (discrete, so the slide animation is stable between steps).
// - `#queue`      — predicted moves not yet drained locally (rebuilt by `reconcile`).
// - `#pending`    — enqueues sent to the server but not yet acked (`seq > last_input_seq`), kept
//                   so `reconcile` can replay them on top of authoritative truth.

import type { WasmCharacterState, WasmMoveInput } from '../wasm';

/** The injected drain step. Mirrors `wasm.applyMove`; never throws (a blocked move is a no-op). */
export type ApplyMoveFn = (
  state: WasmCharacterState,
  input: WasmMoveInput,
  now: number,
) => WasmCharacterState;

interface PendingEnqueue {
  seq: bigint;
  input: WasmMoveInput;
}

export class Predictor {
  #applyMove: ApplyMoveFn;
  #stepMs: number;
  #predicted: WasmCharacterState;
  #queue: WasmMoveInput[] = [];
  #pending: PendingEnqueue[] = [];
  #nextSeq = 1n;

  constructor(applyMove: ApplyMoveFn, stepMs: number, initial: WasmCharacterState) {
    this.#applyMove = applyMove;
    this.#stepMs = stepMs;
    this.#predicted = initial;
  }

  /** The current predicted state (what the renderer shows for the own character). */
  get predicted(): WasmCharacterState {
    return this.#predicted;
  }

  /** Moves predicted-but-not-yet-drained locally. */
  get queueDepth(): number {
    return this.#queue.length;
  }

  /** Enqueues sent but not yet acked by the server. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  get nextSeq(): bigint {
    return this.#nextSeq;
  }

  /**
   * Buffer a move: predict it locally (drain will pick it up) and record it as pending so
   * reconciliation can replay it. Returns the assigned `seq` for the caller to send to the
   * server. Flow control (don't exceed the server's capacity) is the caller's job — it gates on
   * the authoritative queue depth + `pendingCount`.
   */
  enqueue(input: WasmMoveInput): bigint {
    const seq = this.#nextSeq;
    this.#nextSeq += 1n;
    this.#queue.push(input);
    this.#pending.push({ seq, input });
    return seq;
  }

  /**
   * Advance the predicted state by draining any moves whose slide has completed. Each drained
   * move starts the next slide; consecutive moves chain exactly `STEP_MS` apart (no gap → smooth),
   * but if we were idle/behind, the next slide starts at `now` rather than in the past.
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
   * Reconcile against an authoritative own-character update: drop acked enqueues, reset predicted
   * to authoritative truth, rebuild the queue as `authoritative queue ++ still-pending inputs`,
   * and re-drain to `now`. `authState.move_started_at` must already be rebased to the local clock.
   */
  reconcile(
    authState: WasmCharacterState,
    authQueue: WasmMoveInput[],
    ackedSeq: bigint,
    now: number,
  ): void {
    this.#pending = this.#pending.filter((p) => p.seq > ackedSeq);
    this.#predicted = authState;
    this.#queue = [...authQueue, ...this.#pending.map((p) => p.input)];
    this.drain(now);
  }
}
