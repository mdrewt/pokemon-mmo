// Authoritative state store, fed from SpacetimeDB table callbacks. This is the client's
// mirror of canonical server state — never mutated by prediction or rendering. Keyed by
// entityId (bigint). Consumers (render/, prediction/) subscribe to change events; they do
// not own this data.
//
// No Pixi, no wasm here — just plain data + a tiny event fan-out.

import type {
  Battle,
  BattleAction,
  BattleChallenge,
  Character,
  Fusion,
  Item,
  Monster,
  Player,
  PlayerItem,
  Profile,
  Skill,
  Species,
  TradeOffer,
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
  /** Item templates, keyed by itemId. Read-only content. */
  readonly items = new Map<number, Item>();
  /** Fusion recipes (seeded content), keyed by row id so a re-subscribe doesn't duplicate them:
   *  fusing species a + b → species to (order-independent). */
  readonly fusions = new Map<bigint, Fusion>();
  /** The caller's owned item stacks, keyed by row id (RLS-scoped to the owner). */
  readonly playerItems = new Map<bigint, PlayerItem>();
  /** Type/affinity chart rows (seeded content), keyed by row id so a re-subscribe doesn't duplicate
   *  them (all content tables are keyed Maps — idempotent on reconnect). */
  readonly typeRelations = new Map<bigint, TypeRelationRow>();
  /** The caller's active battle, if any (RLS-scoped to the owner — at most one). */
  battle: Battle | undefined;
  /** Pending trade offers this client is party to (RLS-scoped to from/to), keyed by offer id. */
  readonly tradeOffers = new Map<bigint, TradeOffer>();
  /** Pending PvP challenges this client is party to (RLS-scoped to from/to), keyed by challenge id. */
  readonly battleChallenges = new Map<bigint, BattleChallenge>();
  /** This client's OWN queued PvP actions (RLS hides the opponent's), keyed by row id — drives the
   *  "waiting for opponent" battle state without leaking the opponent's pending pick. */
  readonly battleActions = new Map<bigint, BattleAction>();
  /** Persistent ranked profiles (the PvP ladder), keyed by identity hex. Public — the whole leaderboard. */
  readonly profiles = new Map<string, Profile>();

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

  upsertItem(row: Item): void {
    this.items.set(row.itemId, row);
  }

  upsertFusion(row: Fusion): void {
    this.fusions.set(row.id, row);
  }

  upsertPlayerItem(row: PlayerItem): void {
    this.playerItems.set(row.id, row);
    this.#emitMonsterChange(); // box UI shows item counts alongside monsters
  }

  removePlayerItem(id: bigint): void {
    if (this.playerItems.delete(id)) this.#emitMonsterChange();
  }

  upsertTypeRelation(row: TypeRelationRow): void {
    this.typeRelations.set(row.id, row);
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

  // ── Trade offers ────────────────────────────────────────────────────────────

  #tradeListeners = new Set<() => void>();

  /** Subscribe to trade-offer changes; returns an unsubscribe fn. */
  onTradeChange(fn: () => void): () => void {
    this.#tradeListeners.add(fn);
    return () => this.#tradeListeners.delete(fn);
  }

  #emitTradeChange(): void {
    for (const fn of this.#tradeListeners) fn();
  }

  upsertTradeOffer(row: TradeOffer): void {
    this.tradeOffers.set(row.id, row);
    this.#emitTradeChange();
  }

  removeTradeOffer(id: bigint): void {
    if (this.tradeOffers.delete(id)) this.#emitTradeChange();
  }

  // ── PvP challenges + queued actions ─────────────────────────────────────────

  #challengeListeners = new Set<() => void>();

  /** Subscribe to PvP challenge changes; returns an unsubscribe fn. */
  onChallengeChange(fn: () => void): () => void {
    this.#challengeListeners.add(fn);
    return () => this.#challengeListeners.delete(fn);
  }

  #emitChallengeChange(): void {
    for (const fn of this.#challengeListeners) fn();
  }

  upsertBattleChallenge(row: BattleChallenge): void {
    this.battleChallenges.set(row.id, row);
    this.#emitChallengeChange();
  }

  removeBattleChallenge(id: bigint): void {
    if (this.battleChallenges.delete(id)) this.#emitChallengeChange();
  }

  // A queued action change flips the "have I chosen this turn?" state, so re-render the battle view.
  upsertBattleAction(row: BattleAction): void {
    this.battleActions.set(row.id, row);
    this.#emitBattleChange();
  }

  removeBattleAction(id: bigint): void {
    if (this.battleActions.delete(id)) this.#emitBattleChange();
  }

  /** Whether this client has already queued an action for the given battle (RLS-scoped to own rows). */
  hasQueuedAction(battleId: bigint): boolean {
    for (const a of this.battleActions.values()) if (a.battleId === battleId) return true;
    return false;
  }

  // ── Ranked profiles (leaderboard) ───────────────────────────────────────────

  upsertProfile(row: Profile): void {
    this.profiles.set(row.identity.toHexString(), row);
    this.#emitChallengeChange(); // the leaderboard lives in the challenge overlay
  }

  removeProfile(hex: string): void {
    if (this.profiles.delete(hex)) this.#emitChallengeChange();
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
