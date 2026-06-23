// Dev debug HUD: an HTML overlay (toggled with the backtick key) showing the own
// character's predicted vs authoritative tile, the current seq and acked lastInputSeq, and
// connection status. Reads state each frame; owns nothing.

import type { NetHandle } from '../net/connection';
import type { Predictor } from '../prediction/predictor';
import { characterToWasm } from '../convert';

export interface HudDeps {
  net: NetHandle;
  predictor: () => Predictor | null;
}

export class DebugHud {
  #el: HTMLDivElement;
  #deps: HudDeps;
  #visible = false;
  #onKey = (e: KeyboardEvent): void => {
    if (e.code === 'Backquote') {
      e.preventDefault();
      this.toggle();
    }
  };

  constructor(deps: HudDeps) {
    this.#deps = deps;
    this.#el = document.createElement('div');
    Object.assign(this.#el.style, {
      position: 'fixed',
      top: '8px',
      left: '8px',
      padding: '8px 10px',
      font: '12px/1.5 ui-monospace, monospace',
      color: '#9fe6b0',
      background: 'rgba(0, 0, 0, 0.6)',
      border: '1px solid #2a3a2f',
      borderRadius: '4px',
      whiteSpace: 'pre',
      pointerEvents: 'none',
      zIndex: '900',
      display: 'none',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.#el);
    window.addEventListener('keydown', this.#onKey);
  }

  toggle(): void {
    this.#visible = !this.#visible;
    this.#el.style.display = this.#visible ? 'block' : 'none';
  }

  /** Refresh the readout. Cheap; safe to call each frame. */
  update(): void {
    if (!this.#visible) return;
    const net = this.#deps.net;
    const predictor = this.#deps.predictor();

    const ownId = net.ownEntityId();
    const acked = net.ackedSeq();

    let predictedTile = '—';
    let authTile = '—';
    let nextSeq = '—';
    let pending = '—';

    if (predictor) {
      const p = predictor.predicted.pos;
      predictedTile = `(${p.x}, ${p.y})`;
      nextSeq = predictor.nextSeq.toString();
      pending = predictor.pendingCount.toString();
    }
    if (ownId !== undefined) {
      const stored = net.store.characters.get(ownId);
      if (stored) {
        const a = characterToWasm(stored.row).pos;
        authTile = `(${a.x}, ${a.y})`;
      }
    }

    this.#el.textContent = [
      `conn:      ${net.status()}`,
      `identity:  ${net.identityHex()?.slice(0, 12) ?? '—'}`,
      `entityId:  ${ownId?.toString() ?? '—'}`,
      `predicted: ${predictedTile}`,
      `authority: ${authTile}`,
      `nextSeq:   ${nextSeq}`,
      `ackedSeq:  ${acked.toString()}`,
      `pending:   ${pending}`,
    ].join('\n');
  }

  destroy(): void {
    window.removeEventListener('keydown', this.#onKey);
    this.#el.remove();
  }
}
