// SpacetimeDB connection + subscription glue. Owns the live DbConnection, wires table
// change callbacks into the AuthoritativeStore, and exposes typed reducer wrappers.
//
// No Pixi, no wasm here. The client sends intent (joinGame / submitInput) and mirrors
// authoritative table state; it never computes authoritative outcomes.

import { DbConnection, type EventContext, type ErrorContext } from '../module_bindings';
import type { Character, Player, MoveInput } from '../module_bindings/types';
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

  joinGame(name: string): void;
  submitInput(input: MoveInput, seq: bigint): void;
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

    const ownPlayer = (): Player | undefined => {
      const hex = identity?.toHexString();
      return hex ? store.playerByIdentityHex(hex) : undefined;
    };

    const handle: NetHandle = {
      store,
      identity: () => identity,
      identityHex: () => identity?.toHexString(),
      status: () => status,
      ownEntityId: () => ownPlayer()?.entityId,
      ackedSeq: () => ownPlayer()?.lastInputSeq ?? 0n,
      joinGame: (name: string) => {
        void conn.reducers.joinGame({ name });
      },
      submitInput: (input: MoveInput, seq: bigint) => {
        void conn.reducers.submitInput({ input, seq });
      },
      disconnect: () => conn.disconnect(),
    };
  });
}
