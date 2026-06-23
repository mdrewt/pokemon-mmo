// Authoritative state store, fed from SpacetimeDB table callbacks. This is the client's
// mirror of canonical server state — never mutated by prediction or rendering. Keyed by
// entityId (bigint). Consumers (render/, prediction/) subscribe to change events; they do
// not own this data.
//
// No Pixi, no wasm here — just plain data + a tiny event fan-out.

import type {
  Battle,
  Character,
  Monster,
  Player,
  Skill,
  Species,
  TypeRelationRow,
} from '../module_bindings/types';

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
  /** Species templates, keyed by speciesId. Read-only content seeded by the server. */
  readonly species = new Map<number, Species>();
  /** Owned monsters in scope, keyed by monsterId. */
  readonly monsters = new Map<bigint, Monster>();
  /** Skill templates, keyed by skillId. Read-only content. */
  readonly skills = new Map<number, Skill>();
  /** Type/affinity chart rows (seeded). */
  readonly typeRelations: TypeRelationRow[] = [];
  /** The caller's active battle, if any (RLS-scoped to the owner — at most one). */
  battle: Battle | undefined;

  #charListeners = new Set<CharacterListener>();
  /** Fired on any species/monster change so the box UI can re-render (it's not real-time). */
  #monsterListeners = new Set<() => void>();
  /** Fired on any battle change so the battle UI can re-render. */
  #battleListeners = new Set<() => void>();

  onCharacterEvent(fn: CharacterListener): () => void {
    this.#charListeners.add(fn);
    return () => this.#charListeners.delete(fn);
  }

  /** Subscribe to species/monster changes; returns an unsubscribe fn. */
  onMonsterChange(fn: () => void): () => void {
    this.#monsterListeners.add(fn);
    return () => this.#monsterListeners.delete(fn);
  }

  #emitMonsterChange(): void {
    for (const fn of this.#monsterListeners) fn();
  }

  upsertSpecies(row: Species): void {
    this.species.set(row.speciesId, row);
    this.#emitMonsterChange();
  }

  upsertMonster(row: Monster): void {
    this.monsters.set(row.monsterId, row);
    this.#emitMonsterChange();
  }

  removeMonster(monsterId: bigint): void {
    if (this.monsters.delete(monsterId)) this.#emitMonsterChange();
  }

  upsertSkill(row: Skill): void {
    this.skills.set(row.skillId, row);
  }

  upsertTypeRelation(row: TypeRelationRow): void {
    this.typeRelations.push(row);
  }

  /** Subscribe to battle changes; returns an unsubscribe fn. */
  onBattleChange(fn: () => void): () => void {
    this.#battleListeners.add(fn);
    return () => this.#battleListeners.delete(fn);
  }

  #emitBattleChange(): void {
    for (const fn of this.#battleListeners) fn();
  }

  setBattle(row: Battle): void {
    this.battle = row;
    this.#emitBattleChange();
  }

  clearBattle(): void {
    if (this.battle !== undefined) {
      this.battle = undefined;
      this.#emitBattleChange();
    }
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
