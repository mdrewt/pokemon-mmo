// The battle screen — a DOM overlay. Renders the authoritative BattleState (the player's + enemy's
// active monster with HP bars, a turn log, and a skill menu) and submits the chosen skill. It is a
// pure view: it never computes outcomes (the server resolves every turn) and re-renders from the
// `battle` subscription. Effectiveness hints are a lookup on the subscribed type_relation data — no
// rule duplication, no wasm.

import type { NetHandle } from '../net/connection';
import type { BattleMonster } from '../module_bindings/types';
import { affinityColor } from './affinity';

export class BattleScreen {
  #net: NetHandle;
  #root: HTMLDivElement;
  #unsub: () => void;

  constructor(net: NetHandle) {
    this.#net = net;
    this.#root = document.createElement('div');
    this.#root.id = 'battle-screen';
    Object.assign(this.#root.style, {
      position: 'fixed',
      inset: '0',
      display: 'none',
      flexDirection: 'column',
      gap: '16px',
      padding: '32px',
      boxSizing: 'border-box',
      background: 'rgba(6, 8, 14, 0.96)',
      color: '#e8ecf5',
      font: '14px system-ui, sans-serif',
      zIndex: '950',
    } satisfies Partial<CSSStyleDeclaration>);
    document.body.appendChild(this.#root);
    this.#unsub = net.store.onBattleChange(() => {
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

  #speciesName(speciesId: number): string {
    return this.#net.species(speciesId)?.name ?? `#${speciesId}`;
  }

  /** Effectiveness of an attack affinity vs a defender affinity, from the subscribed chart. */
  #effectiveness(attack: string, defend: string): string {
    const rel = this.#net.store.typeRelations.find(
      (r) => r.attack.tag === attack && r.defend.tag === defend,
    );
    return rel?.effect.tag ?? 'Neutral';
  }

  #render(): void {
    const battle = this.#net.battle();
    this.#root.replaceChildren();
    if (!battle) return;

    const { state } = battle;
    const enemy = state.enemy.team[state.enemy.active];
    const player = state.player.team[state.player.active];
    if (!enemy || !player) return;

    // Enemy (top, right-aligned) and player (bottom, left-aligned) combatant panels.
    this.#root.append(this.#combatant(enemy, true), this.#log(battle), this.#combatant(player, false));

    const outcome = state.outcome.tag;
    if (outcome === 'Ongoing') {
      this.#root.append(this.#skillMenu(player, enemy));
    } else {
      this.#root.append(this.#result(outcome));
    }
  }

  #combatant(m: BattleMonster, isEnemy: boolean): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;flex-direction:column;gap:4px;max-width:360px;${
      isEnemy ? 'align-self:flex-end;text-align:right;' : 'align-self:flex-start;'
    }`;
    const title = document.createElement('div');
    title.textContent = `${isEnemy ? 'Wild ' : ''}${this.#speciesName(m.speciesId)}  Lv ${m.level}`;
    title.style.cssText = 'font-weight:600;font-size:16px;';
    row.append(title, this.#hpBar(m));
    return row;
  }

  #hpBar(m: BattleMonster): HTMLElement {
    const wrap = document.createElement('div');
    wrap.style.cssText = 'display:flex;flex-direction:column;gap:2px;';
    const track = document.createElement('div');
    track.style.cssText = 'height:12px;border-radius:6px;background:#222a38;overflow:hidden;width:280px;';
    const pct = m.maxHp > 0 ? Math.round((m.currentHp / m.maxHp) * 100) : 0;
    const fill = document.createElement('div');
    const color = pct > 50 ? '#5cbf5c' : pct > 20 ? '#e6c534' : '#e2553c';
    fill.style.cssText = `height:100%;width:${pct}%;background:${color};border-radius:6px;`;
    track.append(fill);
    const label = document.createElement('div');
    label.textContent = `HP ${m.currentHp} / ${m.maxHp}`;
    label.style.cssText = 'font-size:11px;font-variant-numeric:tabular-nums;opacity:0.8;';
    wrap.append(track, label);
    return wrap;
  }

  #log(battle: NonNullable<ReturnType<NetHandle['battle']>>): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText =
      'align-self:center;text-align:center;min-height:20px;opacity:0.9;font-style:italic;';
    if (battle.state.turn === 0) {
      el.textContent = `A wild ${this.#speciesName(
        battle.state.enemy.team[battle.state.enemy.active]?.speciesId ?? 0,
      )} appeared!`;
    } else {
      const p = this.#net.skill(battle.lastPlayerSkillId)?.name ?? '—';
      const e = this.#net.skill(battle.lastEnemySkillId)?.name ?? '—';
      el.textContent = `You used ${p}.   The enemy used ${e}.`;
    }
    return el;
  }

  #skillMenu(player: BattleMonster, enemy: BattleMonster): HTMLElement {
    const menu = document.createElement('div');
    menu.style.cssText = 'align-self:center;display:flex;flex-direction:column;gap:8px;margin-top:8px;';
    const grid = document.createElement('div');
    grid.style.cssText = 'display:grid;grid-template-columns:1fr 1fr;gap:8px;';

    const skillIds = this.#net.species(player.speciesId)?.skills ?? [];
    for (const id of skillIds) {
      const skill = this.#net.skill(id);
      if (!skill) continue;
      const eff = this.#effectiveness(skill.affinity.tag, enemy.affinity.tag);
      const hint =
        eff === 'SuperEffective'
          ? '  · super effective'
          : eff === 'NotVeryEffective'
            ? '  · not very effective'
            : eff === 'NoEffect'
              ? '  · no effect'
              : '';
      const btn = document.createElement('button');
      btn.style.cssText = `padding:10px 14px;border-radius:8px;border:1px solid ${affinityColor(
        skill.affinity.tag,
      )};background:#1a2030;color:#e8ecf5;cursor:pointer;text-align:left;font-size:14px;`;
      btn.innerHTML = `<b>${skill.name}</b>  <span style="opacity:0.6">${skill.affinity.tag} · ${skill.power}</span><span style="opacity:0.75">${hint}</span>`;
      btn.dataset.skill = String(id); // test hook for the e2e
      btn.onclick = () => this.#net.submitAction(id);
      grid.append(btn);
    }
    menu.append(grid);
    const flee = this.#button('Flee');
    flee.onclick = () => this.#net.closeBattle();
    menu.append(flee);
    return menu;
  }

  #result(outcome: string): HTMLElement {
    const box = document.createElement('div');
    box.style.cssText = 'align-self:center;display:flex;flex-direction:column;gap:10px;align-items:center;margin-top:8px;';
    const msg = document.createElement('div');
    msg.textContent = outcome === 'PlayerWon' ? 'Victory!' : 'Defeat…';
    msg.style.cssText = `font-size:26px;font-weight:700;color:${outcome === 'PlayerWon' ? '#5cbf5c' : '#e2553c'};`;
    const cont = this.#button('Continue');
    cont.onclick = () => this.#net.closeBattle();
    box.append(msg, cont);
    return box;
  }

  #button(label: string): HTMLButtonElement {
    const b = document.createElement('button');
    b.textContent = label;
    b.style.cssText =
      'align-self:center;padding:8px 20px;border-radius:8px;border:none;background:#3a4760;color:#fff;cursor:pointer;font-size:14px;';
    return b;
  }
}
