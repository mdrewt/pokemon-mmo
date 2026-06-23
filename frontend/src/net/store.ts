// Authoritative state store, fed from SpacetimeDB table callbacks. This is the client's
// mirror of canonical server state — never mutated by prediction or rendering. Keyed by
// entityId (bigint). Consumers (render/, prediction/) subscribe to change events; they do
// not own this data.
//
// No Pixi, no wasm here — just plain data + a tiny event fan-out.

import type { Character, Player } from '../module_bindings/types';

/** A character row plus the local wall-clock time we received this version of it. */
export interface StoredCharacter {
  row: Character;
  /** performance.now() at local receipt — drives remote interpolation (no clock sync). */
  receivedAt: number;
}

export type CharacterEvent =
  | { kind: 'insert'; entityId: bigint; char: StoredCharacter }
  | { kind: 'update'; entityId: bigint; char: StoredCharacter; prev: StoredCharacter }
  | { kind: 'delete'; entityId: bigint };

type CharacterListener = (ev: CharacterEvent) => void;

export class AuthoritativeStore {
  readonly characters = new Map<bigint, StoredCharacter>();
  readonly playersByIdentity = new Map<string, Player>();
  readonly playersByEntity = new Map<bigint, Player>();

  #charListeners = new Set<CharacterListener>();

  onCharacterEvent(fn: CharacterListener): () => void {
    this.#charListeners.add(fn);
    return () => this.#charListeners.delete(fn);
  }

  #emit(ev: CharacterEvent): void {
    for (const fn of this.#charListeners) fn(ev);
  }

  // ── Character table callbacks ───────────────────────────────────────────────

  upsertCharacterInsert(row: Character, now: number): void {
    const char: StoredCharacter = { row, receivedAt: now };
    this.characters.set(row.entityId, char);
    this.#emit({ kind: 'insert', entityId: row.entityId, char });
  }

  upsertCharacterUpdate(row: Character, now: number): void {
    const prev = this.characters.get(row.entityId);
    const char: StoredCharacter = { row, receivedAt: now };
    this.characters.set(row.entityId, char);
    if (prev) {
      this.#emit({ kind: 'update', entityId: row.entityId, char, prev });
    } else {
      this.#emit({ kind: 'insert', entityId: row.entityId, char });
    }
  }

  removeCharacter(entityId: bigint): void {
    if (this.characters.delete(entityId)) {
      this.#emit({ kind: 'delete', entityId });
    }
  }

  // ── Player table callbacks ──────────────────────────────────────────────────

  upsertPlayer(row: Player): void {
    this.playersByIdentity.set(row.identity.toHexString(), row);
    this.playersByEntity.set(row.entityId, row);
  }

  removePlayer(row: Player): void {
    this.playersByIdentity.delete(row.identity.toHexString());
    this.playersByEntity.delete(row.entityId);
  }

  playerByIdentityHex(hex: string): Player | undefined {
    return this.playersByIdentity.get(hex);
  }
}
