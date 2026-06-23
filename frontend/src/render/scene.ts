// The render scene: owns the Pixi stage layout, the pooled CharacterViews, and the loop
// that drives interpolation. It reads from the AuthoritativeStore (remote characters) and
// from the Predictor (the own character), but owns no game state itself.
//
// Pixi-only module. Rendering is a view of state; it never mutates authoritative or
// predicted state.

import { Application, Assets, Container, Spritesheet, type Texture } from 'pixi.js';
// Vite resolves these to URLs (PNG) and to the parsed JSON object.
import atlasUrl from '../assets/character.png';
import sheetData from '../assets/character.json';
import type { AuthoritativeStore, CharacterEvent } from '../net/store';
import type { Predictor } from '../prediction/predictor';
import { buildTilemap, pixelWidth, pixelHeight, TILE_PX } from './tilemap';
import { CharacterView, type AnimationTextures } from './characterView';
import { characterToWasm } from '../convert';
import type { WasmMap } from '../wasm';

/** Build the per-(action,direction) texture sets from a parsed Spritesheet. */
function buildAnimations(sheet: Spritesheet): AnimationTextures {
  const anims: AnimationTextures = {};
  for (const [key, textures] of Object.entries(sheet.animations)) {
    anims[key] = textures as Texture[];
  }
  return anims;
}

export interface SceneDeps {
  store: AuthoritativeStore;
  /** Returns the local player's entityId once known (to skip the remote path for it). */
  ownEntityId: () => bigint | undefined;
  /** The predictor for the own character (null until the own character exists). */
  predictor: () => Predictor | null;
  /** Step duration (ms) for slide timing. */
  stepMs: number;
}

export class Scene {
  #app: Application;
  #deps: SceneDeps;
  #anims: AnimationTextures;
  #charLayer: Container;
  #views = new Map<bigint, CharacterView>();
  #ownView: CharacterView | null = null;
  #unsub: () => void;

  private constructor(
    app: Application,
    deps: SceneDeps,
    anims: AnimationTextures,
    map: WasmMap,
  ) {
    this.#app = app;
    this.#deps = deps;
    this.#anims = anims;

    const world = new Container({ label: 'world' });
    world.addChild(buildTilemap(map));
    this.#charLayer = new Container({ label: 'characters' });
    world.addChild(this.#charLayer);

    // Center the (fixed-size) world in the canvas. No camera — the whole map fits.
    world.x = Math.round((app.screen.width - pixelWidth(map)) / 2);
    world.y = Math.round((app.screen.height - pixelHeight(map)) / 2);
    app.stage.addChild(world);

    this.#unsub = deps.store.onCharacterEvent((ev) => this.#onCharacterEvent(ev));

    // Seed views for any characters already present at scene start.
    for (const [entityId, stored] of deps.store.characters) {
      this.#ensureRemoteView(entityId, stored.row.tileX, stored.row.tileY);
    }

    app.ticker.add(() => this.#tick());
  }

  /** Load the spritesheet and construct the scene. Must be awaited before the loop runs. */
  static async create(
    app: Application,
    deps: SceneDeps,
    map: WasmMap,
  ): Promise<Scene> {
    const texture = await Assets.load({
      src: atlasUrl,
      data: { scaleMode: 'nearest' },
    });
    const sheet = new Spritesheet({ texture, data: sheetData });
    await sheet.parse();
    return new Scene(app, deps, buildAnimations(sheet), map);
  }

  // ── Store-driven remote character views ─────────────────────────────────────

  #onCharacterEvent(ev: CharacterEvent): void {
    const ownId = this.#deps.ownEntityId();
    switch (ev.kind) {
      case 'insert': {
        if (ev.entityId === ownId) return; // own character handled by prediction path
        this.#ensureRemoteView(ev.entityId, ev.char.row.tileX, ev.char.row.tileY);
        break;
      }
      case 'update': {
        if (ev.entityId === ownId) return;
        const view = this.#views.get(ev.entityId);
        if (!view) {
          this.#ensureRemoteView(ev.entityId, ev.char.row.tileX, ev.char.row.tileY);
          return;
        }
        const w = characterToWasm(ev.char.row);
        view.setAnimation(w.action, w.facing);
        // Remote interpolation is timed from LOCAL receipt time (no clock sync).
        view.moveTo(w.pos.x, w.pos.y, ev.char.receivedAt, this.#deps.stepMs);
        break;
      }
      case 'delete': {
        const view = this.#views.get(ev.entityId);
        if (view) {
          view.destroy();
          this.#views.delete(ev.entityId);
        }
        break;
      }
    }
  }

  #ensureRemoteView(entityId: bigint, tileX: number, tileY: number): void {
    if (this.#views.has(entityId)) return;
    const view = new CharacterView(this.#anims, tileX, tileY);
    this.#views.set(entityId, view);
    this.#charLayer.addChild(view.sprite);
  }

  // ── Per-frame interpolation ─────────────────────────────────────────────────

  #tick(): void {
    const now = performance.now();
    for (const view of this.#views.values()) view.update(now);
    this.#updateOwnView(now);
  }

  #updateOwnView(now: number): void {
    const predictor = this.#deps.predictor();
    const ownId = this.#deps.ownEntityId();
    if (!predictor || ownId === undefined) return;

    const predicted = predictor.predicted;
    if (!this.#ownView) {
      // The own character may have been provisionally created as a remote view if its
      // character row arrived before the player row identified it as ours. Drop that
      // duplicate now that we render the own character from prediction instead.
      const stale = this.#views.get(ownId);
      if (stale) {
        stale.destroy();
        this.#views.delete(ownId);
      }
      this.#ownView = new CharacterView(this.#anims, predicted.pos.x, predicted.pos.y);
      this.#charLayer.addChild(this.#ownView.sprite);
      this.#ownLastTarget = { x: predicted.pos.x, y: predicted.pos.y };
    }

    // Start a slide when the predicted target tile changes; time from move_started_at
    // (the local input instant). performance.now() and move_started_at share the same clock.
    if (
      this.#ownLastTarget.x !== predicted.pos.x ||
      this.#ownLastTarget.y !== predicted.pos.y
    ) {
      this.#ownView.moveTo(
        predicted.pos.x,
        predicted.pos.y,
        predicted.move_started_at,
        this.#deps.stepMs,
      );
      this.#ownLastTarget = { x: predicted.pos.x, y: predicted.pos.y };
    }
    this.#ownView.setAnimation(predicted.action, predicted.facing);
    this.#ownView.update(now);
  }

  #ownLastTarget = { x: 0, y: 0 };

  /** Pixel size of one tile, exposed for any overlay alignment. */
  get tilePx(): number {
    return TILE_PX;
  }

  destroy(): void {
    this.#unsub();
    for (const view of this.#views.values()) view.destroy();
    this.#views.clear();
    this.#ownView?.destroy();
    this.#ownView = null;
  }
}
