// Typed, thin wrapper over the client-wasm prediction boundary.
//
// The wasm crate is built with `--target bundler`, so Vite imports it as a normal ES
// module and initialization is automatic (the generated `client_wasm.js` runs
// `__wbindgen_start()` on import — there is no async `init()` to await). We still expose
// `initWasm()` so the bootstrap order in main.ts is explicit and so this stays the single
// place that touches the wasm module.
//
// The wasm exports are typed `any` in client_wasm.d.ts because they marshal serde-shaped
// JS values. We narrow them here to the game-core CharacterState shape and never let
// `any` escape this module.

import * as wasm from '../../client-wasm/pkg/client_wasm';

/** Facing as game-core serializes it (plain string). */
export type WasmFacing = 'North' | 'South' | 'East' | 'West';

/** Action as game-core serializes it (plain string). */
export type WasmAction = 'Idle' | 'Walking' | 'Jumping';

/** The CharacterState shape exported across the wasm boundary (game-core serde). */
export interface WasmCharacterState {
  pos: { x: number; y: number };
  facing: WasmFacing;
  action: WasmAction;
  move_started_at: number;
}

/** A MoveInput as game-core serializes it: `{ Step: "West" }` or the literal `"Jump"`. */
export type WasmMoveInput = { Step: WasmFacing } | 'Jump';

/** The shared move-buffer capacity (game_core::MOVE_QUEUE_CAP). */
export function moveQueueCap(): number {
  return wasm.move_queue_cap();
}

/** The POC map (row-major walkability grid). `grass` marks tall-grass tiles (walkable + encounters). */
export interface WasmMap {
  width: number;
  height: number;
  walkable: boolean[];
  grass: boolean[];
}

let ready = false;

/**
 * Ensure the prediction wasm is initialized. With the bundler target the module is already
 * live at import time; this just records readiness so the game loop can be gated on it and
 * so a single touch of the module forces it into the bundle.
 */
export async function initWasm(): Promise<void> {
  // Touch an export so the side-effecting module import is not tree-shaken away.
  void wasm.step_ms();
  ready = true;
}

export function isWasmReady(): boolean {
  return ready;
}

/** The shared movement cooldown / step duration in ms (e.g. 200). */
export function stepMs(): number {
  return wasm.step_ms();
}

/** The POC map walkability grid. */
export function pocMap(): WasmMap {
  return wasm.poc_map() as WasmMap;
}

/**
 * Apply one (already-due) queued move locally via game-core, mirroring the server's
 * `movement_tick` drain. Never throws for a blocked move — it's a legal in-place no-op, exactly
 * as on the server.
 */
export function applyMove(
  state: WasmCharacterState,
  input: WasmMoveInput,
  now: number,
): WasmCharacterState {
  return wasm.apply_move(state, input, now) as WasmCharacterState;
}
