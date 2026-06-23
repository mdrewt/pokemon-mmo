// Client-side prediction + reconciliation for the local player's own character.
//
// PURE of Pixi and of the wasm module: the predict function is injected, so this is
// unit-testable in node with a mocked predict_input (see predictor.test.ts). All game
// rules live in game-core via that injected function; this file only sequences inputs,
// tracks acks, and replays.
//
// See ARCHITECTURE.md "Prediction & reconciliation state machine".

import type { WasmCharacterState, WasmMoveInput } from '../wasm';

/** The injected prediction step. Mirrors `wasm.predictInput`; throws on rejection. */
export type PredictFn = (
  state: WasmCharacterState,
  input: WasmMoveInput,
  now: number,
) => WasmCharacterState;

interface PendingInput {
  seq: bigint;
  input: WasmMoveInput;
  /** Local input instant (ms) — also the predicted move_started_at for this step. */
  at: number;
}

export class Predictor {
  #predict: PredictFn;
  #predicted: WasmCharacterState;
  #pending: PendingInput[] = [];
  #nextSeq = 1n;

  constructor(predict: PredictFn, initial: WasmCharacterState) {
    this.#predict = predict;
    this.#predicted = initial;
  }

  /** The current predicted state (what the renderer should show for the own character). */
  get predicted(): WasmCharacterState {
    return this.#predicted;
  }

  /** The seq that will be assigned to the next applied input. */
  get nextSeq(): bigint {
    return this.#nextSeq;
  }

  /** Number of inputs awaiting an ack. */
  get pendingCount(): number {
    return this.#pending.length;
  }

  /**
   * Reset the predicted baseline (e.g. when the local player's character first appears, or
   * on a hard re-sync). Clears pending inputs and the seq counter is left as-is.
   */
  reset(state: WasmCharacterState): void {
    this.#predicted = state;
    this.#pending = [];
  }

  /**
   * Apply one input locally and record it as pending. Returns the assigned seq, or null if
   * the input was rejected by the rule (e.g. cooldown) — in which case nothing is recorded
   * and the caller should NOT submit it to the server.
   *
   * `at` is the local input instant in ms (used as move_started_at for prediction and for
   * the own-character interpolation clock).
   */
  applyInput(input: WasmMoveInput, at: number): bigint | null {
    let next: WasmCharacterState;
    try {
      next = this.#predict(this.#predicted, input, at);
    } catch {
      // Rejected locally (e.g. TooSoon). Do not record or submit.
      return null;
    }
    const seq = this.#nextSeq;
    this.#nextSeq += 1n;
    this.#predicted = next;
    this.#pending.push({ seq, input, at });
    return seq;
  }

  /**
   * Reconcile against an authoritative own-character update carrying `ackedSeq`
   * (= player.lastInputSeq). Drops acked inputs, resets predicted to the authoritative
   * tile/facing/action, and replays the remaining pending inputs through the rule.
   *
   * Replay naturally drops any input the server rejected (its seq was never acked but it
   * also no longer matches authoritative state, so it either re-applies cleanly or throws
   * and is discarded) — the character snaps back to truth on a genuine misprediction.
   */
  reconcile(authoritative: WasmCharacterState, ackedSeq: bigint): void {
    // Drop everything the server has acknowledged.
    this.#pending = this.#pending.filter((p) => p.seq > ackedSeq);

    // Rebuild prediction from authoritative truth + the still-pending inputs.
    let state = authoritative;
    const survivors: PendingInput[] = [];
    for (const p of this.#pending) {
      try {
        state = this.#predict(state, p.input, p.at);
        survivors.push(p);
      } catch {
        // This pending input is no longer legal against authoritative state — drop it.
      }
    }
    this.#pending = survivors;
    this.#predicted = state;
  }
}
