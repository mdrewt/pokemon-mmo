// The battle screen — a DOM overlay. Renders the authoritative BattleState (active monsters with HP
// bars, a turn log, and a skill menu) and submits the chosen skill. A pure view: it never computes
// outcomes (the server resolves every turn) and re-renders from the `battle` subscription;
// effectiveness hints are a lookup on the subscribed type_relation data (no rule duplication, no wasm).
//
// Handles all three battle modes (`#render`):
//   • PvE   — your party vs a wild; recruit + switch available.
//   • PvP   — vs another player. PERSPECTIVE-AWARE: the challenge ACCEPTER is `state.enemy`, so the
//             viewer's own side is flipped to render at the bottom, and the log/result are flipped too.
//   • Raid  — co-op: you + an ally on `state.player.team` vs an AI boss; shared result, no recruit/switch.
// While waiting for the other player to submit (PvP/raid), shows a "waiting for opponent" state.

import type { NetHandle } from '../net/connection';
import type { BattleMonster, BattleSide } from '../module_bindings/types';
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
    for (const r of this.#net.store.typeRelations.values()) {
      if (r.attack.tag === attack && r.defend.tag === defend) return r.effect.tag;
    }
    return 'Neutral';
  }

  #render(): void {
    const battle = this.#net.battle();
    this.#root.replaceChildren();
    if (!battle) return;

    const { state } = battle;
    const myHex = this.#net.identityHex();
    const viewerIsChallenger = battle.playerIdentity.toHexString() === myHex;

    // Co-op RAID: both allies sit on `state.player.team` (challenger=0, accepter=1) vs the AI boss in
    // `state.enemy`. The viewer controls their own monster; the boss is the shared foe.
    if (battle.isRaid) {
      const myIdx = viewerIsChallenger ? 0 : 1;
      const me = state.player.team[myIdx];
      const ally = state.player.team[viewerIsChallenger ? 1 : 0];
      const boss = state.enemy.team[state.enemy.active];
      if (!me || !boss) return;
      this.#root.append(this.#combatant(boss, 'Boss ', true));
      if (ally) this.#root.append(this.#allyPanel(ally));
      this.#root.append(this.#log(battle, false, true, true), this.#combatant(me, '', false));
      if (state.outcome.tag === 'Ongoing') {
        if (this.#net.hasQueuedAction(battle.battleId)) this.#root.append(this.#waiting());
        else this.#root.append(this.#skillMenu(me, state.player, boss, true));
      } else {
        // A raid is shared: PlayerWon = the team cleared it (XP shown), PlayerLost = the team wiped.
        this.#root.append(this.#result(battle, false, true));
      }
      return;
    }

    // PvE / PvP perspective: the PvP ACCEPTER is `state.enemy`, so render the VIEWER's own side at the
    // bottom and the foe at the top regardless of which slot they occupy. For PvE the viewer is always
    // the player side, so this is a no-op there.
    const viewerIsPlayer = viewerIsChallenger;
    const pvp = battle.playerIdentity.toHexString() !== battle.opponentIdentity.toHexString();
    const mySide = viewerIsPlayer ? state.player : state.enemy;
    const foeSide = viewerIsPlayer ? state.enemy : state.player;
    const me = mySide.team[mySide.active];
    const foe = foeSide.team[foeSide.active];
    if (!me || !foe) return;

    // Foe (top, right-aligned) and the viewer's monster (bottom, left-aligned).
    this.#root.append(
      this.#combatant(foe, pvp ? '' : 'Wild ', true),
      this.#log(battle, pvp, viewerIsPlayer),
      this.#combatant(me, '', false),
    );

    if (state.outcome.tag === 'Ongoing') {
      if (pvp && this.#net.hasQueuedAction(battle.battleId)) {
        this.#root.append(this.#waiting());
      } else {
        this.#root.append(this.#skillMenu(me, mySide, foe, pvp));
      }
    } else {
      this.#root.append(this.#result(battle, pvp, viewerIsPlayer));
    }
  }

  /** A compact panel for the co-op ally's monster (name + HP), shown beside the boss in a raid. */
  #allyPanel(m: BattleMonster): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = 'align-self:flex-end;text-align:right;opacity:0.85;font-size:13px;';
    const pct = m.maxHp > 0 ? Math.round((m.currentHp / m.maxHp) * 100) : 0;
    row.textContent = `Ally: ${this.#speciesName(m.speciesId)}  (${pct}% HP)`;
    return row;
  }

  #combatant(m: BattleMonster, prefix: string, alignEnd: boolean): HTMLElement {
    const row = document.createElement('div');
    row.style.cssText = `display:flex;flex-direction:column;gap:4px;max-width:360px;${
      alignEnd ? 'align-self:flex-end;text-align:right;' : 'align-self:flex-start;'
    }`;
    const title = document.createElement('div');
    title.textContent = `${prefix}${this.#speciesName(m.speciesId)}  Lv ${m.level}`;
    title.style.cssText = 'font-weight:600;font-size:16px;';
    row.append(title, this.#hpBar(m));
    return row;
  }

  #waiting(): HTMLElement {
    const el = document.createElement('div');
    el.id = 'pvp-waiting';
    el.textContent = 'Waiting for your opponent…';
    el.style.cssText = 'align-self:center;margin-top:12px;opacity:0.85;font-style:italic;';
    return el;
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

  #log(
    battle: NonNullable<ReturnType<NetHandle['battle']>>,
    pvp: boolean,
    viewerIsPlayer: boolean,
    raid = false,
  ): HTMLElement {
    const el = document.createElement('div');
    el.style.cssText =
      'align-self:center;text-align:center;min-height:40px;display:flex;flex-direction:column;gap:2px;opacity:0.9;font-style:italic;';
    // Show the turn's events whenever there are any (a failed recruit can push a "broke free" event
    // without advancing the turn counter — gating on turn===0 would swallow it). With no events, show
    // the opening line ONLY at the true start (turn 0); later empty-event states — e.g. a successful
    // recruit, which clears last_events without advancing the turn — render blank, not a stale "appeared".
    const opening = raid
      ? 'The raid begins!'
      : pvp
        ? 'The battle begins!'
        : `A wild ${this.#speciesName(
            battle.state.enemy.team[battle.state.enemy.active]?.speciesId ?? 0,
          )} appeared!`;
    const lines =
      battle.lastEvents.length > 0
        ? battle.lastEvents.map((ev) => this.#eventLine(ev, pvp, viewerIsPlayer, raid))
        : battle.state.turn === 0
          ? [opening]
          : [];
    for (const text of lines) {
      const line = document.createElement('div');
      line.textContent = text;
      el.append(line);
    }
    return el;
  }

  /** Render one turn event to a log line, from the VIEWER's perspective (event flags are relative to
   *  `state.player` = the challenger; flip them for the accepter). In a raid, `by_player` = an ally hit
   *  the boss. */
  #eventLine(
    ev: NonNullable<ReturnType<NetHandle['battle']>>['lastEvents'][number],
    pvp: boolean,
    viewerIsPlayer: boolean,
    raid = false,
  ): string {
    const foeWord = raid ? 'The boss' : pvp ? 'Your opponent' : 'The enemy';
    if (ev.tag === 'Attack') {
      const a = ev.value;
      const mine = raid ? a.byPlayer : a.byPlayer === viewerIsPlayer;
      const who = raid ? (a.byPlayer ? 'Your team' : 'The boss') : mine ? 'You' : foeWord;
      const skill = this.#net.skill(a.skillId)?.name ?? 'a move';
      const eff =
        a.effectiveness.tag === 'SuperEffective'
          ? " It's super effective!"
          : a.effectiveness.tag === 'NotVeryEffective'
            ? " It's not very effective…"
            : a.effectiveness.tag === 'NoEffect'
              ? ' It had no effect…'
              : '';
      const dmg = a.effectiveness.tag === 'NoEffect' ? '' : ` (${a.damage} dmg)`;
      return `${who} used ${skill}!${eff}${dmg}`;
    }
    if (ev.tag === 'RecruitFailed') {
      return 'The wild broke free!';
    }
    if (ev.tag === 'Switched') {
      return `Go, ${this.#speciesName(ev.value.speciesId)}!`;
    }
    // Faint
    const f = ev.value;
    const name = this.#speciesName(f.speciesId);
    if (raid) {
      return f.playerSide ? `${name} fainted!` : `The boss ${name} fell!`;
    }
    const mine = f.playerSide === viewerIsPlayer;
    return mine
      ? `Your ${name} fainted!`
      : pvp
        ? `The opposing ${name} fainted!`
        : `The wild ${name} fainted!`;
  }

  #skillMenu(
    player: BattleMonster,
    playerSide: BattleSide,
    enemy: BattleMonster,
    pvp: boolean,
  ): HTMLElement {
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

    // Action row. Recruit + switch are PvE-only; PvP just lets you Flee (a forfeit).
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;';

    if (!pvp) {
      const bait = this.#net.baitCount();
      if (bait > 0) {
        const baitBtn = this.#button(`Recruit + Bait (${bait})`);
        baitBtn.dataset.recruit = 'bait';
        baitBtn.onclick = () => this.#net.attemptRecruit(true);
        actions.append(baitBtn);
      }
      const recruit = this.#button('Recruit');
      recruit.dataset.recruit = 'plain';
      recruit.title = 'Lower its HP first for a better chance';
      recruit.onclick = () => this.#net.attemptRecruit(false);
      actions.append(recruit);
    }

    const flee = this.#button(pvp ? 'Forfeit' : 'Flee');
    flee.onclick = () => this.#net.closeBattle();
    actions.append(flee);

    menu.append(actions);

    // Switch row (PvE only for now): any benched, still-conscious party member can be sent in.
    const benched = pvp
      ? []
      : playerSide.team
          .map((m, i) => ({ m, i }))
          .filter(({ m, i }) => i !== playerSide.active && m.currentHp > 0);
    if (benched.length > 0) {
      const switchRow = document.createElement('div');
      switchRow.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;justify-content:center;align-items:center;';
      const label = document.createElement('span');
      label.textContent = 'Switch:';
      label.style.cssText = 'opacity:0.6;font-size:12px;';
      switchRow.append(label);
      for (const { m, i } of benched) {
        const btn = this.#button(`${this.#speciesName(m.speciesId)} (Lv ${m.level} · ${m.currentHp}/${m.maxHp})`);
        btn.dataset.swap = String(i); // test hook for the e2e
        btn.onclick = () => this.#net.swapActive(i);
        switchRow.append(btn);
      }
      menu.append(switchRow);
    }

    return menu;
  }

  #result(
    battle: NonNullable<ReturnType<NetHandle['battle']>>,
    pvp: boolean,
    viewerIsPlayer: boolean,
  ): HTMLElement {
    const outcome = battle.state.outcome.tag;
    const box = document.createElement('div');
    box.style.cssText =
      'align-self:center;display:flex;flex-direction:column;gap:8px;align-items:center;margin-top:8px;';

    const wildName = this.#speciesName(
      battle.state.enemy.team[battle.state.enemy.active]?.speciesId ?? 0,
    );
    // The outcome is from the challenger's (state.player) perspective; the accepter wins on PlayerLost.
    const iWon = viewerIsPlayer ? outcome === 'PlayerWon' : outcome === 'PlayerLost';
    const headline = outcome === 'Recruited' ? 'Gotcha!' : iWon ? 'Victory!' : 'Defeat…';
    const color = outcome === 'Recruited' || iWon ? '#5cbf5c' : '#e2553c';
    const msg = document.createElement('div');
    msg.textContent = headline;
    msg.style.cssText = `font-size:26px;font-weight:700;color:${color};`;
    box.append(msg);

    if (outcome === 'PlayerWon' && !pvp) {
      const xp = document.createElement('div');
      xp.textContent = battle.leveledUp
        ? `Your party gained ${battle.lastXpGain} EXP — and leveled up!`
        : `Your party gained ${battle.lastXpGain} EXP.`;
      xp.style.cssText = 'opacity:0.9;';
      box.append(xp);
    } else if (outcome === 'Recruited') {
      const note = document.createElement('div');
      note.textContent = `${wildName} joined your team! Find it in your Box.`;
      note.style.cssText = 'opacity:0.9;';
      box.append(note);
    }

    const cont = this.#button('Continue');
    cont.onclick = () => this.#net.closeBattle();
    box.append(cont);
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
