// The Trade screen — a DOM overlay (menus are HTML, not Pixi). Lets the player offer one of their
// monsters to another player and resolve pending offers. Directed, dual-consent: the initiator offers
// a monster, the recipient responds with one of theirs, then the initiator confirms and the server
// swaps ownership atomically. This is a pure view of the `trade_offer` subscription + the reducers;
// it never mutates state locally (a subscription update re-renders it). Offered monsters are escrowed
// server-side; the UI hides already-escrowed monsters from the pickers to avoid obvious rejections.

import type { NetHandle } from '../net/connection';
import type { MonsterCard, TradeOffer } from '../module_bindings/types';

export class TradeScreen {
  #net: NetHandle;
  #root: HTMLDivElement;
  #unsub: () => void;
  // Picker selections kept across re-renders (the overlay re-renders on every subscription change).
  #offerTargetHex: string | null = null;
  #offerMonsterId: bigint | null = null;
  #respondChoice = new Map<string, bigint>(); // offer id hex → chosen monster id
  // Monster ids escrowed in a visible offer — recomputed once per #render, read by the pickers.
  #escrowed = new Set<bigint>();

  constructor(net: NetHandle) {
    this.#net = net;
    this.#root = document.createElement('div');
    this.#root.id = 'trade-screen';
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
    // Re-render on trade changes AND monster/player changes (the pickers read owned monsters + peers).
    const unsubTrade = net.store.onTradeChange(() => this.#renderIfOpen());
    const unsubMon = net.store.onMonsterChange(() => this.#renderIfOpen());
    this.#unsub = () => {
      unsubTrade();
      unsubMon();
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

  /** Display name: the player-given nickname, else the species name. Works for a live Monster or a
   *  trade card (both carry `nickname` + `speciesId`). */
  #nameOf(nickname: string, speciesId: number): string {
    return nickname.length > 0 ? nickname : (this.#net.species(speciesId)?.name ?? `#${speciesId}`);
  }

  /** Recompute the set of monster ids escrowed in any visible offer (hidden from the pickers). */
  #recomputeEscrowed(): void {
    this.#escrowed = new Set<bigint>();
    for (const t of this.#net.tradeOffers()) {
      this.#escrowed.add(t.fromCard.monsterId);
      if (t.toCard) this.#escrowed.add(t.toCard.monsterId);
    }
  }

  #render(): void {
    this.#root.replaceChildren();
    this.#recomputeEscrowed();

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';
    const title = document.createElement('h1');
    title.textContent = 'Trade';
    title.style.cssText = 'font-size:22px;font-weight:600;margin:0;';
    const hint = document.createElement('span');
    hint.textContent = 'Esc to close';
    hint.style.cssText = 'opacity:0.6;font-size:12px;';
    header.append(title, hint);
    this.#root.append(header, this.#offerSection(), this.#offersSection());
  }

  // ── Create an offer ──────────────────────────────────────────────────────────

  #offerSection(): HTMLElement {
    const box = this.#panel('Offer a monster');
    const peers = this.#net.tradablePlayers();
    const escrowed = this.#escrowed;
    const available = this.#net.ownMonsters().filter((m) => !escrowed.has(m.monsterId));

    if (peers.length === 0) {
      box.append(this.#muted('No other players are online to trade with.'));
      return box;
    }
    if (available.length === 0) {
      box.append(this.#muted('You have no monsters free to offer.'));
      return box;
    }

    // Keep prior selections valid; otherwise default to the first option.
    if (!peers.some((p) => p.identity.toHexString() === this.#offerTargetHex)) {
      this.#offerTargetHex = peers[0]?.identity.toHexString() ?? null;
    }
    if (!available.some((m) => m.monsterId === this.#offerMonsterId)) {
      this.#offerMonsterId = available[0]?.monsterId ?? null;
    }

    const targetSel = document.createElement('select');
    targetSel.dataset.tradeTarget = '';
    for (const p of peers) {
      const opt = document.createElement('option');
      opt.value = p.identity.toHexString();
      opt.textContent = p.name;
      if (opt.value === this.#offerTargetHex) opt.selected = true;
      targetSel.append(opt);
    }
    targetSel.onchange = () => {
      this.#offerTargetHex = targetSel.value;
    };

    const monSel = document.createElement('select');
    monSel.dataset.tradeMonster = '';
    for (const m of available) {
      const opt = document.createElement('option');
      opt.value = String(m.monsterId);
      opt.textContent = `${this.#nameOf(m.nickname, m.speciesId)} · Lv ${m.level}`;
      if (m.monsterId === this.#offerMonsterId) opt.selected = true;
      monSel.append(opt);
    }
    monSel.onchange = () => {
      this.#offerMonsterId = BigInt(monSel.value);
    };

    const send = this.#button('Send offer');
    send.dataset.tradeSend = '';
    send.onclick = () => {
      const targetHex = this.#offerTargetHex;
      const monsterId = this.#offerMonsterId;
      if (!targetHex || monsterId === null) return;
      const target = peers.find((p) => p.identity.toHexString() === targetHex);
      if (target) this.#net.offerTrade(target.identity, monsterId);
    };

    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;';
    for (const sel of [targetSel, monSel]) {
      sel.style.cssText = 'padding:6px 8px;border-radius:6px;background:#1a2030;color:#e8ecf5;border:1px solid #2c3650;';
    }
    row.append(this.#label('To'), targetSel, this.#label('Give'), monSel, send);
    box.append(row);
    return box;
  }

  // ── Pending offers ───────────────────────────────────────────────────────────

  #offersSection(): HTMLElement {
    const box = this.#panel('Pending trades');
    const offers = this.#net
      .tradeOffers()
      .slice()
      .sort((a, b) => Number(b.createdAtMs - a.createdAtMs));
    if (offers.length === 0) {
      box.append(this.#muted('No pending trades.'));
      return box;
    }
    for (const offer of offers) box.append(this.#offerRow(offer));
    return box;
  }

  #offerRow(offer: TradeOffer): HTMLElement {
    const myHex = this.#net.identityHex();
    const amInitiator = offer.fromIdentity.toHexString() === myHex;
    const amRecipient = offer.toIdentity.toHexString() === myHex;
    const awaitingRecipient = offer.status.tag === 'AwaitingRecipient';

    const row = document.createElement('div');
    row.dataset.tradeOffer = String(offer.id);
    row.style.cssText =
      'display:flex;gap:16px;align-items:center;flex-wrap:wrap;padding:12px;border-radius:8px;' +
      'background:#11161f;border:1px solid #222c3e;';

    // What each side is putting up.
    const fromLabel = amInitiator ? 'You give' : `${this.#playerName(offer.fromIdentity.toHexString())} gives`;
    row.append(this.#cardEl(fromLabel, offer.fromCard));
    const toLabel = amRecipient ? 'You give' : `${this.#playerName(offer.toIdentity.toHexString())} gives`;
    row.append(this.#cardEl(toLabel, offer.toCard ?? null));

    row.append(this.#actions(offer, { amInitiator, amRecipient, awaitingRecipient }));
    return row;
  }

  #actions(
    offer: TradeOffer,
    role: { amInitiator: boolean; amRecipient: boolean; awaitingRecipient: boolean },
  ): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin-left:auto;';
    const idHex = String(offer.id);

    if (role.amRecipient && role.awaitingRecipient) {
      // The recipient puts up a monster in return.
      const escrowed = this.#escrowed;
      const available = this.#net.ownMonsters().filter((m) => !escrowed.has(m.monsterId));
      if (available.length === 0) {
        wrap.append(this.#muted('No monster free to offer back.'));
      } else {
        if (!available.some((m) => m.monsterId === this.#respondChoice.get(idHex))) {
          this.#respondChoice.set(idHex, available[0]!.monsterId);
        }
        const sel = document.createElement('select');
        sel.dataset.tradeRespondMonster = '';
        sel.style.cssText = 'padding:6px 8px;border-radius:6px;background:#1a2030;color:#e8ecf5;border:1px solid #2c3650;';
        for (const m of available) {
          const opt = document.createElement('option');
          opt.value = String(m.monsterId);
          opt.textContent = `${this.#nameOf(m.nickname, m.speciesId)} · Lv ${m.level}`;
          if (m.monsterId === this.#respondChoice.get(idHex)) opt.selected = true;
          sel.append(opt);
        }
        sel.onchange = () => this.#respondChoice.set(idHex, BigInt(sel.value));
        const respond = this.#button('Respond');
        respond.dataset.tradeRespond = '';
        respond.onclick = () => {
          const choice = this.#respondChoice.get(idHex);
          if (choice !== undefined) this.#net.respondTrade(offer.id, choice);
        };
        wrap.append(this.#label('Give'), sel, respond);
      }
    } else if (role.amInitiator && !role.awaitingRecipient) {
      // The recipient has responded; the initiator confirms.
      const confirm = this.#button('Confirm', '#2f7d4f');
      confirm.dataset.tradeConfirm = '';
      confirm.onclick = () => this.#net.confirmTrade(offer.id);
      wrap.append(confirm);
    } else {
      wrap.append(this.#muted(role.awaitingRecipient ? 'Awaiting their monster…' : 'Awaiting their confirmation…'));
    }

    // Either party can always back out.
    const cancel = this.#button('Cancel', '#7d3a3a');
    cancel.dataset.tradeCancel = '';
    cancel.onclick = () => this.#net.cancelTrade(offer.id);
    wrap.append(cancel);
    return wrap;
  }

  // ── Small view helpers ───────────────────────────────────────────────────────

  #cardEl(label: string, card: MonsterCard | null): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText = 'display:flex;flex-direction:column;gap:2px;min-width:140px;';
    const lab = this.#label(label);
    el.append(lab);
    const body = document.createElement('div');
    if (card) {
      body.textContent = `${this.#nameOf(card.nickname, card.speciesId)} · Lv ${card.level}`;
      body.style.cssText = 'font-weight:600;';
      const stats = document.createElement('div');
      stats.textContent = `HP ${card.derived.hp} · Atk ${card.derived.attack} · Spd ${card.derived.speed}`;
      stats.style.cssText = 'font-size:12px;opacity:0.7;font-variant-numeric:tabular-nums;';
      el.append(body, stats);
    } else {
      body.textContent = '— (not yet offered)';
      body.style.cssText = 'opacity:0.6;font-style:italic;';
      el.append(body);
    }
    return el;
  }

  #panel(heading: string): HTMLElement {
    const box = document.createElement('div');
    box.style.cssText = 'display:flex;flex-direction:column;gap:10px;';
    const h = document.createElement('h2');
    h.textContent = heading;
    h.style.cssText = 'font-size:15px;font-weight:600;margin:0;opacity:0.85;';
    box.append(h);
    return box;
  }

  #label(text: string): HTMLElement {
    const el = document.createElement('span');
    el.textContent = text;
    el.style.cssText = 'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#8a94a8;';
    return el;
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
