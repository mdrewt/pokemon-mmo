// SpacetimeDB connection + subscription glue. Owns the live DbConnection, wires table
// change callbacks into the AuthoritativeStore, and exposes typed reducer wrappers.
//
// No Pixi, no wasm here. The client sends intent (joinGame / enqueueMove) and mirrors
// authoritative table state; it never computes authoritative outcomes.

import { DbConnection, type EventContext, type ErrorContext } from '../module_bindings';
import type {
  Battle,
  Character,
  Fusion,
  Item,
  Monster,
  MoveInput,
  Player,
  PlayerItem,
  Skill,
  Species,
  TradeOffer,
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
  /** The caller's owned training food (item id + name + count), for the box Raise UI. */
  foodItems(): { itemId: number; name: string; quantity: number }[];
  /** Owned monsters that form a valid fusion recipe with `monster` (a data lookup on the subscribed
   *  `fusion` table — not a computed outcome), each with the resulting offspring species id. */
  fusionPartners(monster: Monster): { partner: Monster; offspringSpeciesId: number }[];
  /** Pending trade offers this client is party to (initiated or received). */
  tradeOffers(): TradeOffer[];
  /** Other online players the caller can trade with (excludes self), name + identity. */
  tradablePlayers(): { identity: Identity; name: string }[];

  joinGame(name: string): void;
  enqueueMove(input: MoveInput, seq: bigint): void;
  setMove(input: MoveInput, seq: bigint): void;
  clearQueue(seq: bigint): void;
  renameMonster(monsterId: bigint, name: string): void;
  setPartySlot(monsterId: bigint, slot: number | undefined): void;
  trainMonster(monsterId: bigint, itemId: number): void;
  careForMonster(monsterId: bigint): void;
  evolveMonster(monsterId: bigint, toSpeciesId: number): void;
  fuseMonsters(monsterA: bigint, monsterB: bigint): void;
  startBattle(): void;
  submitAction(skillId: number): void;
  swapActive(teamIndex: number): void;
  attemptRecruit(useBait: boolean): void;
  closeBattle(): void;
  healParty(): void;
  offerTrade(toIdentity: Identity, offeredMonsterId: bigint): void;
  respondTrade(offerId: bigint, offeredMonsterId: bigint): void;
  confirmTrade(offerId: bigint): void;
  cancelTrade(offerId: bigint): void;
  disconnect(): void;
}

function nowMs(): number {
  return performance.now();
}

/**
 * Build the action-call seam: wraps a reducer-call promise so its rejection (the server's `Err`
 * string) is surfaced via `onActionError` instead of being swallowed by `void`. Extracted so the
 * "a rejected action reaches the handler / a resolved one doesn't" contract is unit-testable without
 * a live connection. The MOVEMENT reducers deliberately do NOT go through this (their rejections are
 * normal flow-control absorbed by reconciliation).
 */
export function makeActionCaller(
  onActionError: (message: string) => void,
): (p: Promise<void>) => void {
  return (p) => {
    void p.catch((e: unknown) => {
      onActionError(e instanceof Error ? e.message : 'That action could not be completed.');
    });
  };
}

/**
 * Connect to SpacetimeDB, subscribe to the world tables, and resolve once the connection is
 * established (onConnect). Table rows stream into `store` via change callbacks.
 *
 * `onActionError` is invoked with the server's rejection message whenever a discrete-ACTION reducer
 * this client made FAILS (the reducer returned `Err`). Those wrappers route through the `call` seam so
 * a rejected action surfaces to the player instead of silently doing nothing; the high-frequency
 * MOVEMENT reducers deliberately bypass it (their rejections are normal flow-control). Required (not
 * defaulted) so a caller can't silently re-introduce swallowed errors. The net layer stays UI-free —
 * `main` wires this to a toast.
 */
export function connect(onActionError: (message: string) => void): Promise<NetHandle> {
  const uri = import.meta.env.VITE_SPACETIME_URI ?? DEFAULT_URI;
  const moduleName = import.meta.env.VITE_MODULE_NAME ?? DEFAULT_MODULE;

  const store = new AuthoritativeStore();
  let identity: Identity | undefined;
  let status: ConnectionStatus = 'connecting';

  // A reducer call returns a Promise that REJECTS (with the server's Err string) on failure; route
  // every action call through this so the rejection is surfaced rather than discarded by `void`.
  const call = makeActionCaller(onActionError);

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
            'SELECT * FROM fusion',
            'SELECT * FROM trade_offer',
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
    conn.db.fusion.onInsert((_ctx: EventContext, row: Fusion) => {
      store.upsertFusion(row);
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

    conn.db.trade_offer.onInsert((_ctx: EventContext, row: TradeOffer) => {
      store.upsertTradeOffer(row);
    });
    conn.db.trade_offer.onUpdate(
      (_ctx: EventContext, _old: TradeOffer, row: TradeOffer) => {
        store.upsertTradeOffer(row);
      },
    );
    conn.db.trade_offer.onDelete((_ctx: EventContext, row: TradeOffer) => {
      store.removeTradeOffer(row.id);
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

    // The caller's non-empty owned item stacks — the shared basis for bait/food queries.
    const ownedStacks = (): PlayerItem[] => {
      const hex = identity?.toHexString();
      if (!hex) return [];
      return [...store.playerItems.values()].filter(
        (pi) => pi.ownerIdentity.toHexString() === hex && pi.quantity > 0,
      );
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
      baitCount: () =>
        ownedStacks().reduce(
          (sum, pi) =>
            sum + ((store.items.get(pi.itemId)?.recruitBonus ?? 0) > 0 ? pi.quantity : 0),
          0,
        ),
      foodItems: () => {
        const out: { itemId: number; name: string; quantity: number }[] = [];
        for (const pi of ownedStacks()) {
          const item = store.items.get(pi.itemId);
          if (item?.trainStat !== undefined) {
            out.push({ itemId: pi.itemId, name: item.name, quantity: pi.quantity });
          }
        }
        return out.sort((a, b) => a.itemId - b.itemId);
      },
      fusionPartners: (monster: Monster) => {
        const out: { partner: Monster; offspringSpeciesId: number }[] = [];
        for (const partner of ownMonsters()) {
          if (partner.monsterId === monster.monsterId) continue;
          const recipe = [...store.fusions.values()].find(
            (f) =>
              (f.a === monster.speciesId && f.b === partner.speciesId) ||
              (f.a === partner.speciesId && f.b === monster.speciesId),
          );
          if (recipe) out.push({ partner, offspringSpeciesId: recipe.to });
        }
        return out;
      },
      tradeOffers: () => [...store.tradeOffers.values()],
      tradablePlayers: () => {
        const hex = identity?.toHexString();
        return [...store.playersByIdentity.values()]
          .filter((p) => p.online && p.identity.toHexString() !== hex)
          .map((p) => ({ identity: p.identity, name: p.name }))
          .sort((a, b) => a.name.localeCompare(b.name));
      },
      joinGame: (name: string) => {
        call(conn.reducers.joinGame({ name }));
      },
      // Movement reducers are deliberately NOT routed through `call`: their rejections ("move queue
      // full" anti-flood, "stale input seq") are normal flow-control that prediction/reconciliation
      // already handles — surfacing them as error toasts would spam the player during normal play.
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
        call(conn.reducers.renameMonster({ monsterId, name }));
      },
      setPartySlot: (monsterId: bigint, slot: number | undefined) => {
        call(conn.reducers.setPartySlot({ monsterId, slot }));
      },
      trainMonster: (monsterId: bigint, itemId: number) => {
        call(conn.reducers.trainMonster({ monsterId, itemId }));
      },
      careForMonster: (monsterId: bigint) => {
        call(conn.reducers.careForMonster({ monsterId }));
      },
      evolveMonster: (monsterId: bigint, toSpeciesId: number) => {
        call(conn.reducers.evolveMonster({ monsterId, toSpeciesId }));
      },
      fuseMonsters: (monsterA: bigint, monsterB: bigint) => {
        call(conn.reducers.fuseMonsters({ monsterA, monsterB }));
      },
      startBattle: () => {
        call(conn.reducers.startBattle({}));
      },
      submitAction: (skillId: number) => {
        call(conn.reducers.submitAction({ skillId }));
      },
      swapActive: (teamIndex: number) => {
        call(conn.reducers.swapActive({ teamIndex }));
      },
      attemptRecruit: (useBait: boolean) => {
        call(conn.reducers.attemptRecruit({ useBait }));
      },
      closeBattle: () => {
        call(conn.reducers.closeBattle({}));
      },
      healParty: () => {
        call(conn.reducers.healParty({}));
      },
      offerTrade: (toIdentity: Identity, offeredMonsterId: bigint) => {
        call(conn.reducers.offerTrade({ toIdentity, offeredMonsterId }));
      },
      respondTrade: (offerId: bigint, offeredMonsterId: bigint) => {
        call(conn.reducers.respondTrade({ offerId, offeredMonsterId }));
      },
      confirmTrade: (offerId: bigint) => {
        call(conn.reducers.confirmTrade({ offerId }));
      },
      cancelTrade: (offerId: bigint) => {
        call(conn.reducers.cancelTrade({ offerId }));
      },
      disconnect: () => conn.disconnect(),
    };
  });
}
