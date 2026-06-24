// The PvP Challenge screen — a DOM overlay. Lists online players to challenge and the player's pending
// challenges (incoming → Accept/Decline, outgoing → waiting/Cancel). Accepting builds a shared battle
// server-side, which the `battle` subscription opens as the battle screen. Pure view of the
// `battle_challenge` subscription + reducers; it never mutates state locally.

import type { NetHandle } from '../net/connection';
import type { BattleChallenge } from '../module_bindings/types';

export class ChallengeScreen {
  #net: NetHandle;
  #root: HTMLDivElement;
  #unsub: () => void;

  constructor(net: NetHandle) {
    this.#net = net;
    this.#root = document.createElement('div');
    this.#root.id = 'challenge-screen';
    Object.assign(this.#root.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      flexDirection: 'column',
      gap: '16px',
      padding: '24px',
      boxSizing: 'border-box',
      background: 'rgba(8, 10, 16, 0.94)',
      color: '#e8ecf5',
      font: '14px system-ui, sans-serif',
      zIndex: '900',
      overflow: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.#root);
    // Re-render on challenge changes AND player changes (the picker lists online peers).
    const a = net.store.onChallengeChange(() => this.#renderIfOpen());
    const b = net.store.onCharacterEvent(() => this.#renderIfOpen()); // players come/go with characters
    this.#unsub = () => {
      a();
      b();
    };
  }

  show(): void {
    this.#root.style.display = 'flex';
    this.#render();
  }

  hide(): void {
    this.#root.style.display = 'none';
  }

  destroy(): void {
    this.#unsub();
    this.#root.remove();
  }

  #renderIfOpen(): void {
    if (this.#root.style.display !== 'none') this.#render();
  }

  #playerName(hex: string): string {
    return this.#net.store.playerByIdentityHex(hex)?.name ?? 'someone';
  }

  #render(): void {
    this.#root.replaceChildren();

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';
    const title = document.createElement('h1');
    title.textContent = 'Battle a player';
    title.style.cssText = 'font-size:22px;font-weight:600;margin:0;';
    const hint = document.createElement('span');
    hint.textContent = 'Esc to close';
    hint.style.cssText = 'opacity:0.6;font-size:12px;';
    header.append(title, hint);
    this.#root.append(header, this.#challengesSection(), this.#playersSection());
  }

  // ── Pending challenges ───────────────────────────────────────────────────────

  #challengesSection(): HTMLElement {
    const box = this.#panel('Pending challenges');
    const challenges = this.#net.battleChallenges();
    if (challenges.length === 0) {
      box.append(this.#muted('No pending challenges.'));
      return box;
    }
    for (const c of challenges) box.append(this.#challengeRow(c));
    return box;
  }

  #challengeRow(c: BattleChallenge): HTMLElement {
    const myHex = this.#net.identityHex();
    const amRecipient = c.toIdentity.toHexString() === myHex;
    const row = document.createElement('div');
    row.dataset.challenge = String(c.id);
    row.style.cssText =
      'display:flex;gap:12px;align-items:center;flex-wrap:wrap;padding:12px;border-radius:8px;' +
      'background:#11161f;border:1px solid #222c3e;';

    const label = document.createElement('span');
    label.textContent = amRecipient
      ? `${this.#playerName(c.fromIdentity.toHexString())} challenges you!`
      : `Waiting for ${this.#playerName(c.toIdentity.toHexString())}…`;
    row.append(label);

    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;margin-left:auto;';
    if (amRecipient) {
      const accept = this.#button('Accept', '#2f7d4f');
      accept.dataset.challengeAccept = '';
      accept.onclick = () => this.#net.acceptChallenge(c.id);
      actions.append(accept);
    }
    const decline = this.#button(amRecipient ? 'Decline' : 'Cancel', '#7d3a3a');
    decline.dataset.challengeDecline = '';
    decline.onclick = () => this.#net.declineChallenge(c.id);
    actions.append(decline);
    row.append(actions);
    return row;
  }

  // ── Challenge a player ───────────────────────────────────────────────────────

  #playersSection(): HTMLElement {
    const box = this.#panel('Players online');
    const peers = this.#net.tradablePlayers();
    // Players you've already challenged (hide the duplicate button — the server rejects it anyway).
    const challenged = new Set(
      this.#net
        .battleChallenges()
        .filter((c) => c.fromIdentity.toHexString() === this.#net.identityHex())
        .map((c) => c.toIdentity.toHexString()),
    );
    if (peers.length === 0) {
      box.append(this.#muted('No other players are online.'));
      return box;
    }
    for (const p of peers) {
      const hex = p.identity.toHexString();
      const row = document.createElement('div');
      row.style.cssText = 'display:flex;gap:12px;align-items:center;';
      const name = document.createElement('span');
      name.textContent = p.name;
      name.style.cssText = 'min-width:120px;';
      row.append(name);
      if (challenged.has(hex)) {
        row.append(this.#muted('challenged'));
      } else {
        const btn = this.#button('Challenge');
        btn.dataset.challengePlayer = hex;
        btn.onclick = () => this.#net.challengePlayer(p.identity);
        row.append(btn);
      }
      box.append(row);
    }
    return box;
  }

  // ── Small view helpers ───────────────────────────────────────────────────────

  #panel(heading: string): HTMLElement {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const h = document.createElement('h2');
    h.textContent = heading;
    h.style.cssText = 'font-size:15px;font-weight:600;margin:0;opacity:0.85;';
    box.append(h);
    return box;
  }

  #muted(text: string): HTMLElement {
    const el = document.createElement('span');
    el.textContent = text;
    el.style.cssText = 'opacity:0.6;font-size:13px;';
    return el;
  }

  #button(label: string, bg = '#3a4760'): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText = `padding:8px 16px;border-radius:8px;border:none;background:${bg};color:#fff;cursor:pointer;font-size:14px;`;
    return b;
  }
}
