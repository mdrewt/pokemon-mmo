# Game systems

How each gameplay system actually works — the rules and how they compose. Every rule lives in
`game-core` (pure, deterministic, tested); the server runs it authoritatively and the client only
renders the result (except movement, which the client also predicts). Tables and reducers are detailed
in [data-model.md](data-model.md) and [reducers.md](reducers.md).

---

## Movement & prediction

A shared 20×15 tile map (`game_core::poc_map()`, a `const`-style grid with a tall-grass layer, shared
verbatim by both sides). Movement is **server-paced**: the client enqueues *intent* (`Step(dir)` /
`Jump`) into a bounded buffer; a scheduled `movement_tick` drains one move per character every
`STEP_MS` (200 ms) via `game_core::apply_move` — the single movement rule. `apply_move` never fails: a
blocked step is a "bump" (face the wall, don't move), a blocked jump hops in place.

Because the same `apply_move` is compiled into `client-wasm`, the client **predicts** locally for
responsiveness and **reconciles** to the server: when the authoritative `character` row (or its ack)
changes, the predictor resets to truth and replays its still-unacked operations on top. There is no
clock sync — the client rebases the server's `move_started_at` epoch ms onto its local
`performance.now()` clock. See [frontend.md](frontend.md#movement-prediction--reconciliation) for the
client side. NPCs wander via `npc_decide` (a seeded roll picks a walkable direction within a radius).

Walking *into* a grass tile rolls `encounter_triggers` (≈12%); a hit starts a wild battle.

## Battle

Turn-based and **server-resolved with no client prediction** — the client submits a skill id and
animates the authoritative `BattleState`. The readable core is **one active monster per side** (the rest
bench; a fainted active auto-switches to the next conscious member).

- **Stats & damage.** A combatant (`BattleMonster`) carries one affinity (a species' primary). Damage is
  a Gen-3-style integer formula (`game_core::damage`): level, the offensive stat (Attack/Special by skill
  category), the defender's Defense, skill power, type **effectiveness** (×0 / ×0.5 / ×1 / ×2 from the
  affinity chart), **STAB** (×1.5 when the skill's affinity matches the attacker's), and a small
  variance roll. Minimum 1 damage on any non-immune hit.
- **Type chart.** Data, not code: `type_relation` rows; the client shows effectiveness hints by looking
  them up (no rule duplication). Any unlisted pair is Neutral.
- **A turn** (`resolve_turn`): both sides act in speed order (the `state.player` side wins exact ties); a
  side whose active faints before acting loses its action. After both act, fainted actives auto-switch
  and the outcome updates (`PlayerWon` / `PlayerLost` / `Ongoing`).
- **Enemy AI** (`pick_best_skill`): scores each skill by `power × effectiveness × STAB`; a roll breaks
  exact ties. Used for the wild (PvE) and the raid boss.
- **XP & levels.** Winning awards XP to the whole party (`battle_xp_reward(level)`); levels follow a
  cubic curve (`xp_for_level = level³`). **HP persists** between battles (it's stored on the `monster`
  row, written back each turn) — you heal on demand (`heal_party`, a placeholder for a healing spot).

## Taming (finding & recruiting)

Wild encounters come from data-driven zone tables (`encounter`, seeded from RON; private to the server).
A wild rolls a species (weighted) + a level (uniform in the entry's range) and gets fresh individuality.

To recruit, **weaken then recruit**: `recruit_chance` rises as the wild's HP drops (missing-HP fraction
× a factor) plus the species' base `recruit_rate` and any **bait** bonus, capped. `attempt_recruit`
rolls against it; a failure forfeits your turn (the wild strikes back, a "broke free" log line). On
success the server rebuilds *that exact* wild (its rolled genes/temperament, full HP) as an owned
monster in your box — not a fresh re-roll. Bait is any item with a `recruit_bonus`, consumed per attempt.

## Raising (active growth)

Two hands-on, server-validated actions diverge how two same-species monsters grow:

- **Train** (`train_monster`): feed a training **food** item to add EV-like `Training` to one stat,
  capped at 252/stat and 510 total. The food is consumed only if it actually applies (a maxed stat is
  rejected without spending it). Stats are recomputed (`derive_stats`) so the divergence is visible.
- **Care** (`care_for_monster`): a cooldown-gated **bond** gain (capped at 255). Bond gates evolution.

`derive_stats` combines species base + genes (`Potential`, IV-like) + training + temperament (±10% to one
stat pair) at the current level — so a monster's strength reflects *how you raised it*.

## Evolution & fusion

- **Evolution** (`evolve_monster`): data-driven `Species.evolutions` define branches gated by level
  and/or bond. The server computes eligibility (`eligible_evolutions`) onto `monster.evolves_to`; the
  client offers only those, and the reducer re-validates from authoritative state before swapping the
  species. The monster keeps its genes, training, bond, XP, and name — the **same individual, evolved**.
- **Fusion** (`fuse_monsters`): data-driven recipes (`fusion` table) map an unordered species pair → an
  offspring species. The offspring inherits the **better gene per stat** from the two parents and the
  higher-bond parent's temperament; both parents are consumed and the offspring inserted, atomically.

Content integrity is enforced in `game_core::validate_content`: no dangling skill/evolution/fusion refs,
no duplicate fusion pairs, and evolution/fusion-only forms are never catchable in the wild.

---

## Multiplayer (M11)

All four multiplayer systems reuse the existing infrastructure heavily — there is no separate
"multiplayer engine". They are detailed below; the common thread is that they're built as
**server-authoritative orchestration over the existing rules**, with cross-player state in
RLS-scoped shared rows.

### Trading

A directed, dual-consent, **escrowed** monster swap (no dupes, no scams). Because the per-owner
`monster` RLS hides each player's monsters, a display-only `MonsterCard` snapshot is embedded in the
`trade_offer` row (visible to the two parties) so a counterparty can see the offered monster *without*
relaxing RLS. Flow: **offer → respond → confirm**. The offered monster is locked (escrowed) while the
offer is pending; `confirm_trade` re-reads both live monsters, re-checks ownership, and swaps ownership
atomically (each goes to the other's box). See [reducers.md](reducers.md#trading-m111--directed-dual-consent-escrowed).

### PvP battles

Two players share **one** `battle` row (the M11.2 re-key to a synthetic `battle_id` made this possible).
The challenger is `state.player`, the accepter is `state.enemy`. Key insight: `game_core::resolve_turn`
is already symmetric, so PvP needed **no new battle rule** — it's pure orchestration. Each player's pick
goes into a **private** `battle_action` row (RLS hides it from the opponent), and the turn resolves only
once both have chosen — so choices are simultaneous and secret. Fleeing or disconnecting forfeits (the
other player wins). On the client, the BattleScreen is perspective-aware: the accepter is `state.enemy`,
so it flips sides, the event log, and the win/lose headline so each player sees *their* monster at the
bottom.

### Ranked leagues

PvP results have stakes via a persistent **Elo ladder**. Each player has a `profile` row (keyed by
identity, never deleted, so a rating survives disconnects). `game_core::elo_update` is a pure,
deterministic, integer (no floats) zero-sum rule: the winner gains what the loser drops, swing clamped
so a win is always worth ≥1 and never a runaway. It's applied **exactly once** per ranked battle, at the
terminal transition (resolve / forfeit / disconnect) — never for PvE or co-op. A leaderboard shows the
standings.

### Co-op raids

Team up against a shared AI boss. A raid reuses the shared-battle + private-both-submit machinery, with
`is_raid` set and `opponent_identity` being the **ally** (not a foe): both allies' lead monsters sit on
`state.player.team` (`[0]` = challenger, `[1]` = accepter) and the boss is `state.enemy`. The one new
rule is `game_core::resolve_coop_turn` — additive and server-only (battles aren't predicted, so it has
**zero desync surface** and doesn't touch `resolve_turn`): both allies attack the boss, the boss strikes
one ally, all three act in speed order. Clearing the boss awards XP to both parties; a wipe (or either
ally leaving) ends the raid. Invites flow through the same `battle_challenge` table (`is_raid = true`).
