// The monster Box/Party screen — a DOM overlay (menus are HTML, not Pixi). Shows the player's party
// (3 active slots) and box, with a detail panel to inspect a monster, rename it, and move it between
// party and box. Reads authoritative state from the store and calls the ownership-checked reducers;
// it never mutates state locally (the subscription update re-renders it).

import type { NetHandle } from '../net/connection';
import type { Monster } from '../module_bindings/types';
import { affinityColor } from './affinity';

const PARTY_SIZE = 3;

/** Bold, muted, uppercase label — used for stat/field labels so they read as labels, not prose. */
const LABEL_STYLE =
  'font-weight:700;font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:#8a94a8;';

/** Bar denominator: the approximate ceiling a single combat stat reaches when fully raised (max
 *  level + perfect potential + training, with our derive_stats formula). A bar is thus "absolute
 *  strength" and fills as the monster is raised — a level-1 starter reads as short on purpose. */
const STAT_BAR_MAX = 255;

export class BoxScreen {
  #net: NetHandle;
  #root: HTMLDivElement;
  #selected: bigint | null = null;
  #unsub: () => void;

  constructor(net: NetHandle) {
    this.#net = net;
    this.#root = document.createElement('div');
    this.#root.id = 'box-screen';
    Object.assign(this.#root.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      flexDirection: 'column',
      gap: '12px',
      padding: '24px',
      boxSizing: 'border-box',
      background: 'rgba(8, 10, 16, 0.94)',
      color: '#e8ecf5',
      font: '14px system-ui, sans-serif',
      zIndex: '900',
      overflow: 'auto',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.#root);
    this.#unsub = net.store.onMonsterChange(() => {
      if (this.#root.style.display !== 'none') this.#render();
    });
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

  #speciesName(m: Monster): string {
    return this.#net.species(m.speciesId)?.name ?? `#${m.speciesId}`;
  }

  #displayName(m: Monster): string {
    return m.nickname.length > 0 ? m.nickname : this.#speciesName(m);
  }

  #affinityColor(m: Monster): string {
    return affinityColor(this.#net.species(m.speciesId)?.primaryAffinity.tag ?? 'Neutral');
  }

  #render(): void {
    const monsters = this.#net.ownMonsters();
    if (this.#selected !== null && !monsters.some((m) => m.monsterId === this.#selected)) {
      this.#selected = null;
    }
    const first = monsters[0];
    if (this.#selected === null && first) {
      this.#selected = first.monsterId;
    }

    this.#root.replaceChildren();

    const header = document.createElement('div');
    header.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';
    const title = document.createElement('h1');
    title.textContent = 'Monsters';
    title.style.cssText = 'font-size:22px;font-weight:600;margin:0;';
    const hint = document.createElement('span');
    hint.textContent = '[B] or [Esc] to close';
    hint.style.cssText = 'opacity:0.6;font-size:12px;';
    header.append(title, hint);
    this.#root.append(header);

    const party = monsters.filter((m) => m.partySlot !== undefined);
    const box = monsters.filter((m) => m.partySlot === undefined);

    this.#root.append(this.#sectionLabel(`Party (${party.length}/${PARTY_SIZE})`));
    this.#root.append(this.#grid(this.#partyCards(party)));

    this.#root.append(this.#sectionLabel(`Box (${box.length})`));
    this.#root.append(this.#grid(box.map((m) => this.#card(m))));

    if (monsters.length === 0) {
      const empty = document.createElement('p');
      empty.textContent = 'No monsters yet.';
      empty.style.opacity = '0.6';
      this.#root.append(empty);
    }

    const bait = this.#net.baitCount();
    if (bait > 0) {
      this.#root.append(this.#sectionLabel('Items'));
      const items = document.createElement('div');
      items.textContent = `Lure × ${bait}  —  use it during a battle to recruit more easily.`;
      items.style.cssText = 'font-size:13px;opacity:0.85;';
      this.#root.append(items);
    }

    const selected = monsters.find((m) => m.monsterId === this.#selected);
    if (selected) this.#root.append(this.#detail(selected));
  }

  #sectionLabel(text: string): HTMLElement {
    const el = document.createElement('h2');
    el.textContent = text;
    el.style.cssText = 'font-size:13px;text-transform:uppercase;letter-spacing:0.08em;opacity:0.7;margin:8px 0 0;';
    return el;
  }

  #grid(children: HTMLElement[]): HTMLElement {
    const g = document.createElement('div');
    g.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;';
    g.append(...children);
    return g;
  }

  /** Party slots in order, showing the occupant or an empty placeholder. */
  #partyCards(party: Monster[]): HTMLElement[] {
    const cards: HTMLElement[] = [];
    for (let slot = 0; slot < PARTY_SIZE; slot++) {
      const occupant = party.find((m) => m.partySlot === slot);
      cards.push(occupant ? this.#card(occupant) : this.#emptySlot(slot));
    }
    return cards;
  }

  #emptySlot(slot: number): HTMLElement {
    const el = document.createElement('div');
    el.textContent = `Slot ${slot + 1}`;
    el.style.cssText =
      'width:120px;height:64px;border:1px dashed #3a4760;border-radius:8px;display:flex;align-items:center;justify-content:center;opacity:0.4;';
    return el;
  }

  #card(m: Monster): HTMLElement {
    const el = document.createElement('button');
    el.dataset.monsterId = String(m.monsterId); // test hook for the e2e
    const selected = m.monsterId === this.#selected;
    el.style.cssText = `width:120px;height:64px;border-radius:8px;border:2px solid ${
      selected ? '#4f74c8' : 'transparent'
    };background:#1a2030;color:#e8ecf5;cursor:pointer;text-align:left;padding:8px;display:flex;flex-direction:column;gap:4px;`;
    const top = document.createElement('div');
    top.style.cssText = 'display:flex;align-items:center;gap:6px;';
    const swatch = document.createElement('span');
    swatch.style.cssText = `width:12px;height:12px;border-radius:3px;background:${this.#affinityColor(m)};flex:none;`;
    const name = document.createElement('span');
    name.textContent = this.#displayName(m);
    name.style.cssText = 'font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
    top.append(swatch, name);
    const sub = document.createElement('span');
    sub.textContent = `Lv ${m.level} · ${this.#speciesName(m)}`;
    sub.style.cssText = 'font-size:11px;opacity:0.7;';
    el.append(top, sub);
    el.onclick = () => {
      this.#selected = m.monsterId;
      this.#render();
    };
    return el;
  }

  #detail(m: Monster): HTMLElement {
    const panel = document.createElement('div');
    panel.style.cssText =
      'margin-top:12px;padding:16px;border:1px solid #2a3445;border-radius:10px;background:#11151f;display:flex;flex-direction:column;gap:10px;max-width:520px;';

    const heading = document.createElement('div');
    heading.style.cssText = 'display:flex;align-items:center;gap:8px;';
    const swatch = document.createElement('span');
    swatch.style.cssText = `width:16px;height:16px;border-radius:4px;background:${this.#affinityColor(m)};`;
    const h = document.createElement('h2');
    h.textContent = `${this.#displayName(m)}  ·  Lv ${m.level} ${this.#speciesName(m)}`;
    h.style.cssText = 'font-size:18px;margin:0;';
    heading.append(swatch, h);
    panel.append(heading);

    const d = m.derived;
    const t = m.training;
    const trained = t.hp + t.attack + t.defense + t.special + t.speed;
    panel.append(
      this.#infoGrid([
        ['Temperament', m.temperament.tag],
        ['Bond', `${m.bond} / 255`],
        ['HP', `${m.currentHp} / ${d.hp}`],
        ['Training', `${trained} / 510`],
      ]),
      this.#xpProgress(m),
    );

    // Combat stats as bold label + proportional bar (absolute strength vs STAT_BAR_MAX, so the bar
    // fills as the monster is raised) + tabular value, with the training invested in each stat.
    const barColor = this.#affinityColor(m);
    const statBlock = document.createElement('div');
    statBlock.style.cssText = 'display:flex;flex-direction:column;gap:5px;margin-top:2px;';
    statBlock.append(
      this.#statBar('Attack', d.attack, STAT_BAR_MAX, barColor, t.attack),
      this.#statBar('Defense', d.defense, STAT_BAR_MAX, barColor, t.defense),
      this.#statBar('Special', d.special, STAT_BAR_MAX, barColor, t.special),
      this.#statBar('Speed', d.speed, STAT_BAR_MAX, barColor, t.speed),
    );
    panel.append(statBlock);
    panel.append(this.#raiseControls(m));

    // Rename
    const renameRow = document.createElement('form');
    renameRow.style.cssText = 'display:flex;gap:6px;';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 24;
    input.placeholder = this.#speciesName(m);
    input.value = m.nickname;
    input.style.cssText =
      'flex:1;padding:6px 8px;border-radius:6px;border:1px solid #3a4760;background:#1a2030;color:#e8ecf5;';
    const renameBtn = this.#button('Rename', 'submit');
    renameRow.append(input, renameBtn);
    renameRow.onsubmit = (e) => {
      e.preventDefault();
      const name = input.value.trim();
      if (name.length > 0) this.#net.renameMonster(m.monsterId, name);
    };
    panel.append(renameRow);

    // Party / box controls
    const controls = document.createElement('div');
    controls.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';
    if (m.partySlot === undefined) {
      for (let slot = 0; slot < PARTY_SIZE; slot++) {
        const b = this.#button(`To Party ${slot + 1}`);
        b.dataset.party = String(slot); // test hook for the e2e
        b.onclick = () => this.#net.setPartySlot(m.monsterId, slot);
        controls.append(b);
      }
    } else {
      const b = this.#button('Send to Box');
      b.onclick = () => this.#net.setPartySlot(m.monsterId, undefined);
      controls.append(b);
    }
    panel.append(controls);

    return panel;
  }

  /** A two-column label/value grid with bold uppercase labels — easy to scan. */
  #infoGrid(rows: [string, string][]): HTMLElement {
    const grid = document.createElement('div');
    grid.style.cssText =
      'display:grid;grid-template-columns:max-content auto;column-gap:16px;row-gap:5px;align-items:center;';
    for (const [label, value] of rows) {
      const l = document.createElement('span');
      l.textContent = label;
      l.style.cssText = LABEL_STYLE;
      const v = document.createElement('span');
      v.textContent = value;
      v.style.cssText = 'font-variant-numeric:tabular-nums;';
      grid.append(l, v);
    }
    return grid;
  }

  /** An EXP progress bar showing how far the monster is toward its next level. */
  #xpProgress(m: Monster): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:3px;margin-top:6px;';
    const atMax = m.xpNext <= m.xpFloor;
    const span = Math.max(1, m.xpNext - m.xpFloor);
    const pct = atMax ? 100 : Math.min(100, Math.round(((m.xp - m.xpFloor) / span) * 100));

    const top = document.createElement('div');
    top.style.cssText = 'display:flex;justify-content:space-between;align-items:baseline;';
    const label = document.createElement('span');
    label.textContent = 'EXP';
    label.style.cssText = LABEL_STYLE;
    const val = document.createElement('span');
    val.style.cssText = 'font-size:11px;opacity:0.8;font-variant-numeric:tabular-nums;';
    val.textContent = atMax ? 'MAX' : `${m.xpNext - m.xp} to next level`;
    top.append(label, val);

    const track = document.createElement('div');
    track.style.cssText = 'height:8px;border-radius:4px;background:#222a38;overflow:hidden;';
    const fill = document.createElement('div');
    fill.style.cssText = `height:100%;width:${pct}%;background:#c7b34a;border-radius:4px;`;
    track.append(fill);
    wrap.append(top, track);
    return wrap;
  }

  /** One combat stat as a bold label + proportional bar + right-aligned tabular value, with the
   *  training invested in that stat shown as a dim "+N" (the visible raising divergence). */
  #statBar(label: string, value: number, max: number, color: string, ev = 0): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText =
      'display:grid;grid-template-columns:64px 1fr 64px;column-gap:10px;align-items:center;';
    const l = document.createElement('span');
    l.textContent = label;
    l.style.cssText = LABEL_STYLE;
    const track = document.createElement('div');
    track.style.cssText = 'height:8px;border-radius:4px;background:#222a38;overflow:hidden;';
    const fill = document.createElement('div');
    const pct = Math.min(100, Math.round((value / max) * 100));
    fill.style.cssText = `height:100%;width:${pct}%;background:${color};border-radius:4px;`;
    track.append(fill);
    const v = document.createElement('span');
    v.style.cssText = 'font-variant-numeric:tabular-nums;text-align:right;';
    v.textContent = String(value);
    if (ev > 0) {
      const evel = document.createElement('span');
      evel.textContent = ` +${ev}`;
      evel.style.cssText = 'opacity:0.55;font-size:11px;';
      v.append(evel);
    }
    row.append(l, track, v);
    return row;
  }

  /** The "Raise" controls: care (builds bond, cooldown-gated) + feed a training food per stat. */
  #raiseControls(m: Monster): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:6px;margin-top:6px;';
    const label = document.createElement('span');
    label.textContent = 'RAISE';
    label.style.cssText = LABEL_STYLE;
    const row = document.createElement('div');
    row.style.cssText = 'display:flex;gap:6px;flex-wrap:wrap;';

    const care = this.#button('Care · +bond');
    care.dataset.care = '1'; // test hook for the e2e
    care.onclick = () => this.#net.careForMonster(m.monsterId);
    row.append(care);

    for (const f of this.#net.foodItems()) {
      const b = this.#button(`Feed ${f.name} (×${f.quantity})`);
      b.dataset.feed = String(f.itemId); // test hook for the e2e
      b.onclick = () => this.#net.trainMonster(m.monsterId, f.itemId);
      row.append(b);
    }

    wrap.append(label, row);
    return wrap;
  }

  #button(label: string, type: 'button' | 'submit' = 'button'): HTMLButtonElement {
    const b = document.createElement('button');
    b.type = type;
    b.textContent = label;
    b.style.cssText =
      'padding:6px 12px;border-radius:6px;border:none;background:#3a4760;color:#fff;cursor:pointer;font-size:13px;';
    return b;
  }
}
