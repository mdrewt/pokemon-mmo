// Dev/test-only introspection hook. Exposes `window.__game()` returning a JSON-safe snapshot of
// authoritative store state plus the own predicted position, so the Playwright two-window e2e can
// assert on canonical game state instead of fragile WebGL-canvas pixels.
//
// READ-ONLY: it only reads the store/predictor; it never mutates game state. The caller gates this
// behind `import.meta.env.DEV`, so it is NOT attached in production builds (no global surface, and
// bigints are stringified for `page.evaluate` serialization).

import type { NetHandle } from '../net/connection';
import type { Predictor } from '../prediction/predictor';
import { characterToWasm } from '../convert';
import type { WasmAction, WasmFacing } from '../wasm';

export interface GameCharSnapshot {
  /** entityId as a string — bigints don't survive structured-clone to the test runner. */
  entityId: string;
  tileX: number;
  tileY: number;
  facing: WasmFacing;
  action: WasmAction;
  /** True for this window's own character. */
  isOwn: boolean;
  /** True for a character with no backing player row (the wandering NPC). */
  isNpc: boolean;
}

export interface GameSnapshot {
  status: string;
  /** game-core STEP_MS (drain/tick cadence) — surfaced so the e2e doesn't hard-code it. */
  stepMs: number;
  identityHex: string | null;
  ownEntityId: string | null;
  /** player.last_input_seq (highest acked input), as a string. */
  ackedSeq: string;
  /** The own character's predicted state (what the renderer shows), or null before it exists. */
  predicted: { x: number; y: number; facing: WasmFacing; action: WasmAction } | null;
  /** Predictor internals (for e2e assertions/diagnostics): queue depth, in-flight ops, next seq. */
  predictor: { queueDepth: number; pending: number; nextSeq: string } | null;
  characters: GameCharSnapshot[];
  /** The caller's owned monsters (party + box), for box/party assertions. */
  monsters: {
    monsterId: string;
    speciesId: number;
    nickname: string;
    level: number;
    partySlot: number | null;
    currentHp: number;
    maxHp: number;
    /** Raising state (M9): loyalty + total training invested across stats. */
    bond: number;
    trainingTotal: number;
  }[];
  /** Total monster rows this client has RECEIVED (not filtered). RLS scopes this to the owner, so
   *  it should equal the owned count — a regression guard against the monster table leaking others'
   *  hidden genes. */
  visibleMonsterCount: number;
  /** The caller's total bait count (consumed when recruiting with bait). */
  baitCount: number;
  /** The active battle, or null. */
  battle: {
    outcome: string;
    turn: number;
    playerHp: number;
    playerMaxHp: number;
    /** Index of the player's active team member + the team's per-member HP (for switch assertions). */
    playerActive: number;
    playerTeam: { speciesId: number; currentHp: number; maxHp: number }[];
    enemyHp: number;
    enemyMaxHp: number;
    lastXpGain: number;
    leveledUp: boolean;
  } | null;
}

declare global {
  interface Window {
    /** Installed only in dev/test builds; see `installIntrospection`. */
    __game?: () => GameSnapshot;
  }
}

/** Attach `window.__game` returning a fresh snapshot on each call. Dev/test only. */
export function installIntrospection(
  net: NetHandle,
  getPredictor: () => Predictor | null,
  stepMs: number,
): void {
  window.__game = (): GameSnapshot => {
    const ownId = net.ownEntityId();
    const predictor = getPredictor();
    const predicted = predictor
      ? {
          x: predictor.predicted.pos.x,
          y: predictor.predicted.pos.y,
          facing: predictor.predicted.facing,
          action: predictor.predicted.action,
        }
      : null;

    const characters: GameCharSnapshot[] = [];
    for (const [entityId, stored] of net.store.characters) {
      const w = characterToWasm(stored.row);
      characters.push({
        entityId: entityId.toString(),
        tileX: w.pos.x,
        tileY: w.pos.y,
        facing: w.facing,
        action: w.action,
        isOwn: ownId !== undefined && entityId === ownId,
        isNpc: !net.store.playersByEntity.has(entityId),
      });
    }

    return {
      status: net.status(),
      stepMs,
      identityHex: net.identityHex() ?? null,
      ownEntityId: ownId === undefined ? null : ownId.toString(),
      ackedSeq: net.ackedSeq().toString(),
      predicted,
      predictor: predictor
        ? {
            queueDepth: predictor.queueDepth,
            pending: predictor.pendingCount,
            nextSeq: predictor.nextSeq.toString(),
          }
        : null,
      characters,
      monsters: net.ownMonsters().map((m) => ({
        monsterId: m.monsterId.toString(),
        speciesId: m.speciesId,
        nickname: m.nickname,
        level: m.level,
        partySlot: m.partySlot ?? null,
        currentHp: m.currentHp,
        maxHp: m.derived.hp,
        bond: m.bond,
        trainingTotal:
          m.training.hp + m.training.attack + m.training.defense + m.training.special + m.training.speed,
      })),
      visibleMonsterCount: net.store.monsters.size,
      baitCount: net.baitCount(),
      battle: (() => {
        const b = net.battle();
        if (!b) return null;
        const p = b.state.player.team[b.state.player.active];
        const e = b.state.enemy.team[b.state.enemy.active];
        return {
          outcome: b.state.outcome.tag,
          turn: b.state.turn,
          playerHp: p?.currentHp ?? 0,
          playerMaxHp: p?.maxHp ?? 0,
          playerActive: b.state.player.active,
          playerTeam: b.state.player.team.map((m) => ({
            speciesId: m.speciesId,
            currentHp: m.currentHp,
            maxHp: m.maxHp,
          })),
          enemyHp: e?.currentHp ?? 0,
          enemyMaxHp: e?.maxHp ?? 0,
          lastXpGain: b.lastXpGain,
          leveledUp: b.leveledUp,
        };
      })(),
    };
  };
}
