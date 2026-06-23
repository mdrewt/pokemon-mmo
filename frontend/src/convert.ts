// Conversions across the marshaling boundary between the SpacetimeDB SDK row shapes
// (camelCase fields, bigint for u64/i64, tagged-union enums `{ tag: "West" }`) and the
// game-core / wasm prediction shapes (plain strings, number positions).
//
// This boilerplate is intentional (see ARCHITECTURE.md: "DRY — but not across the
// marshaling boundaries"). Keep it dumb and explicit.

import { Direction, MoveInput } from './module_bindings/types';
import type { Character, ActionState } from './module_bindings/types';
import type { WasmCharacterState, WasmFacing, WasmAction, WasmMoveInput } from './wasm';

// ── Enum: SDK tagged union <-> game-core plain string ─────────────────────────

export function facingToWasm(facing: Direction): WasmFacing {
  // Direction tags are North/South/East/West — identical spelling to the wasm strings.
  return facing.tag;
}

export function actionToWasm(action: ActionState): WasmAction {
  switch (action.tag) {
    case 'Idle':
      return 'Idle';
    case 'Walking':
      return 'Walking';
    case 'Jumping':
      return 'Jumping';
  }
}

// ── Character row -> wasm CharacterState ──────────────────────────────────────

export function characterToWasm(c: Character): WasmCharacterState {
  return {
    pos: { x: c.tileX, y: c.tileY },
    facing: facingToWasm(c.facing),
    action: actionToWasm(c.action),
    move_started_at: Number(c.moveStartedAtMs),
  };
}

/**
 * Convert an authoritative Character into a prediction baseline whose `move_started_at`
 * lives in the LOCAL clock (performance.now), not the server's epoch clock.
 *
 * The server stores `move_started_at` as a Timestamp (epoch ms) — authoritative
 * bookkeeping, NOT a client interpolation/cooldown clock (ARCHITECTURE.md "No client/server
 * clock sync"). If we fed the raw epoch value into the wasm cooldown check it would compare
 * `performance.now()` (small) against an epoch value (huge) and saturate to 0, spuriously
 * rejecting the first predicted input as TooSoon. The server already enforced the real
 * cooldown, so we rebase the baseline so any next/replayed input clears the cooldown. We
 * push it a full step before `localNow` minus a margin: the FIRST input applied or replayed
 * from this baseline always clears the cooldown, while inter-input cooldowns during replay
 * are governed by the pending inputs' own (real performance.now) timestamps, which the input
 * cadence gate already spaced at least `stepMs` apart.
 */
export function characterToPredictedBaseline(
  c: Character,
  localNow: number,
  stepMs: number,
): WasmCharacterState {
  const base = characterToWasm(c);
  // 2x stepMs in the past guarantees the next input (applied at >= localNow) clears the
  // cooldown even allowing for small scheduling slack. Floor to an integer: `move_started_at`
  // is `Millis(u64)` in game-core, and `performance.now()` returns fractional ms — a fractional
  // value makes the wasm serde reject the whole CharacterState ("expected u64").
  base.move_started_at = Math.floor(localNow) - stepMs * 2;
  return base;
}

// ── MoveInput: build the SDK tagged value and the wasm serde value ────────────
//
// We construct both from a single intent so input/ stays the one place that decides a
// direction. The SDK enum value is built with the generated variant constructors imported
// by callers; here we provide the wasm-side encoding.

export function moveInputToWasm(input: MoveInput): WasmMoveInput {
  if (input.tag === 'Jump') {
    return 'Jump';
  }
  // Step carries a Direction payload.
  return { Step: input.value.tag };
}

// ── wasm serde value -> SDK tagged value (for submitting intent to the server) ─

function wasmFacingToSdk(facing: WasmFacing): Direction {
  switch (facing) {
    case 'North':
      return Direction.North;
    case 'South':
      return Direction.South;
    case 'East':
      return Direction.East;
    case 'West':
      return Direction.West;
  }
}

/** Build the SDK MoveInput value from the wasm serde intent the input layer emits. */
export function wasmToSdkMoveInput(intent: WasmMoveInput): MoveInput {
  if (intent === 'Jump') {
    return MoveInput.Jump;
  }
  return MoveInput.Step(wasmFacingToSdk(intent.Step));
}
