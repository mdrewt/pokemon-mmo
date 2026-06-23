// SpacetimeDB connection + subscription glue. Owns the live DbConnection, wires table
// change callbacks into the AuthoritativeStore, and exposes typed reducer wrappers.
//
// No Pixi, no wasm here. The client sends intent (joinGame / enqueueMove) and mirrors
// authoritative table state; it never computes authoritative outcomes.

import { DbConnection, type EventContext, type ErrorContext } from '../module_bindings';
import type {
  Battle,
  Character,
  Item,
  Monster,
  MoveInput,
  Player,
  PlayerItem,
  Skill,
  Species,
  TypeRelationRow,
} from '../module_bindings/types';
import type { Identity } from 'spacetimedb';
import { AuthoritativeStore } from './store';

const DEFAULT_URI = 'ws://127.0.0.1:3000';
const DEFAULT_MODULE = 'monster-tamer-mmo';

export type ConnectionStatus = 'connecting' | 'connected' | 'disconnected' | 'error';

export interface NetHandle {
  readonly store: AuthoritativeStore;
  /** This client's identity, set once `onConnect` fires. */
  identity(): Identity | undefined;
  identityHex(): string | undefined;
  status(): ConnectionStatus;
  /** The local player's character entityId, if their player row has arrived. */
  ownEntityId(): bigint | undefined;
  /** Latest acked input seq for the local player (player.lastInputSeq). */
  ackedSeq(): bigint;
  /** The caller's owned monsters (party + box), party-slot order then box. */
  ownMonsters(): Monster[];
  /** A species template by id (read-only seeded content). */
  species(speciesId: number): Species | undefined;
  /** A skill template by id. */
  skill(skillId: number): Skill | undefined;
  /** The caller's active battle, if any. */
  battle(): Battle | undefined;
  /** The caller's total bait count (any owned item with a recruit bonus) — data-driven, no magic id. */
  baitCount(): number;

  joinGame(name: string): void;
  enqueueMove(input: MoveInput, seq: bigint): void;
  setMove(input: MoveInput, seq: bigint): void;
  clearQueue(seq: bigint): void;
  renameMonster(monsterId: bigint, name: string): void;
  setPartySlot(monsterId: bigint, slot: number | undefined): void;
  startBattle(): void;
  submitAction(skillId: number): void;
  attemptRecruit(useBait: boolean): void;
  closeBattle(): void;
  healParty(): void;
  disconnect(): void;
}

function nowMs(): number {
  return performance.now();
}

/**
 * Connect to SpacetimeDB, subscribe to the world tables, and resolve once the connection is
 * established (onConnect). Table rows stream into `store` via change callbacks.
 */
export function connect(): Promise<NetHandle> {
  const uri = import.meta.env.VITE_SPACETIME_URI ?? DEFAULT_URI;
  const moduleName = import.meta.env.VITE_MODULE_NAME ?? DEFAULT_MODULE;

  const store = new AuthoritativeStore();
  let identity: Identity | undefined;
  let status: ConnectionStatus = 'connecting';

  return new Promise<NetHandle>((resolve, reject) => {
    let settled = false;

    const conn = DbConnection.builder()
      .withUri(uri)
      .withDatabaseName(moduleName)
      .onConnect((connection, id) => {
        identity = id;
        status = 'connected';

        // Subscribe to the world tables. The POC subscribes to everything (small map);
        // spatial/filtered subscriptions are on the scaling path.
        connection
          .subscriptionBuilder()
          .onApplied(() => {
            if (!settled) {
              settled = true;
              resolve(handle);
            }
          })
          .onError((ctx: ErrorContext) => {
            status = 'error';
            console.error('[net] subscription error', ctx.event);
            if (!settled) {
              settled = true;
              reject(new Error('subscription failed'));
            }
          })
          .subscribe([
            'SELECT * FROM character',
            'SELECT * FROM player',
            'SELECT * FROM config',
            'SELECT * FROM species',
            'SELECT * FROM monster',
            'SELECT * FROM skill',
            'SELECT * FROM type_relation',
            'SELECT * FROM battle',
            'SELECT * FROM item',
            'SELECT * FROM player_item',
          ]);
      })
      .onConnectError((_ctx: ErrorContext, error: Error) => {
        status = 'error';
        if (!settled) {
          settled = true;
          reject(error);
        }
      })
      .onDisconnect(() => {
        status = 'disconnected';
        console.warn('[net] disconnected');
      })
      .build();

    // ── Table change callbacks -> store ──────────────────────────────────────
    conn.db.character.onInsert((_ctx: EventContext, row: Character) => {
      store.upsertCharacterInsert(row, nowMs());
    });
    conn.db.character.onUpdate(
      (_ctx: EventContext, _old: Character, row: Character) => {
        store.upsertCharacterUpdate(row, nowMs());
      },
    );
    conn.db.character.onDelete((_ctx: EventContext, row: Character) => {
      store.removeCharacter(row.entityId);
    });

    conn.db.player.onInsert((_ctx: EventContext, row: Player) => {
      store.upsertPlayer(row);
    });
    conn.db.player.onUpdate((_ctx: EventContext, _old: Player, row: Player) => {
      store.upsertPlayer(row);
    });
    conn.db.player.onDelete((_ctx: EventContext, row: Player) => {
      store.removePlayer(row);
    });

    conn.db.species.onInsert((_ctx: EventContext, row: Species) => {
      store.upsertSpecies(row);
    });
    conn.db.species.onUpdate((_ctx: EventContext, _old: Species, row: Species) => {
      store.upsertSpecies(row);
    });

    conn.db.monster.onInsert((_ctx: EventContext, row: Monster) => {
      store.upsertMonster(row);
    });
    conn.db.monster.onUpdate((_ctx: EventContext, _old: Monster, row: Monster) => {
      store.upsertMonster(row);
    });
    conn.db.monster.onDelete((_ctx: EventContext, row: Monster) => {
      store.removeMonster(row.monsterId);
    });

    conn.db.skill.onInsert((_ctx: EventContext, row: Skill) => {
      store.upsertSkill(row);
    });
    conn.db.type_relation.onInsert((_ctx: EventContext, row: TypeRelationRow) => {
      store.upsertTypeRelation(row);
    });

    conn.db.item.onInsert((_ctx: EventContext, row: Item) => {
      store.upsertItem(row);
    });
    conn.db.player_item.onInsert((_ctx: EventContext, row: PlayerItem) => {
      store.upsertPlayerItem(row);
    });
    conn.db.player_item.onUpdate(
      (_ctx: EventContext, _old: PlayerItem, row: PlayerItem) => {
        store.upsertPlayerItem(row);
      },
    );
    conn.db.player_item.onDelete((_ctx: EventContext, row: PlayerItem) => {
      store.removePlayerItem(row.id);
    });

    conn.db.battle.onInsert((_ctx: EventContext, row: Battle) => {
      store.setBattle(row);
    });
    conn.db.battle.onUpdate((_ctx: EventContext, _old: Battle, row: Battle) => {
      store.setBattle(row);
    });
    conn.db.battle.onDelete(() => {
      store.clearBattle();
    });

    const ownPlayer = (): Player | undefined => {
      const hex = identity?.toHexString();
      return hex ? store.playerByIdentityHex(hex) : undefined;
    };

    const ownMonsters = (): Monster[] => {
      const hex = identity?.toHexString();
      if (!hex) return [];
      const mine = [...store.monsters.values()].filter(
        (m) => m.ownerIdentity.toHexString() === hex,
      );
      // Party slots first (in slot order), then box monsters by id — a stable display order.
      return mine.sort((a, b) => {
        const sa = a.partySlot ?? 99;
        const sb = b.partySlot ?? 99;
        if (sa !== sb) return sa - sb;
        return a.monsterId < b.monsterId ? -1 : a.monsterId > b.monsterId ? 1 : 0;
      });
    };

    const handle: NetHandle = {
      store,
      identity: () => identity,
      identityHex: () => identity?.toHexString(),
      status: () => status,
      ownEntityId: () => ownPlayer()?.entityId,
      ackedSeq: () => ownPlayer()?.lastInputSeq ?? 0n,
      ownMonsters,
      species: (speciesId: number) => store.species.get(speciesId),
      skill: (skillId: number) => store.skills.get(skillId),
      battle: () => store.battle,
      baitCount: () => {
        const hex = identity?.toHexString();
        if (!hex) return 0;
        let total = 0;
        for (const pi of store.playerItems.values()) {
          if (pi.ownerIdentity.toHexString() !== hex) continue;
          if ((store.items.get(pi.itemId)?.recruitBonus ?? 0) > 0) total += pi.quantity;
        }
        return total;
      },
      joinGame: (name: string) => {
        void conn.reducers.joinGame({ name });
      },
      enqueueMove: (input: MoveInput, seq: bigint) => {
        void conn.reducers.enqueueMove({ input, seq });
      },
      setMove: (input: MoveInput, seq: bigint) => {
        void conn.reducers.setMove({ input, seq });
      },
      clearQueue: (seq: bigint) => {
        void conn.reducers.clearQueue({ seq });
      },
      renameMonster: (monsterId: bigint, name: string) => {
        void conn.reducers.renameMonster({ monsterId, name });
      },
      setPartySlot: (monsterId: bigint, slot: number | undefined) => {
        void conn.reducers.setPartySlot({ monsterId, slot });
      },
      startBattle: () => {
        void conn.reducers.startBattle({});
      },
      submitAction: (skillId: number) => {
        void conn.reducers.submitAction({ skillId });
      },
      attemptRecruit: (useBait: boolean) => {
        void conn.reducers.attemptRecruit({ useBait });
      },
      closeBattle: () => {
        void conn.reducers.closeBattle({});
      },
      healParty: () => {
        void conn.reducers.healParty({});
      },
      disconnect: () => conn.disconnect(),
    };
  });
}
