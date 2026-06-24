# Milestone 7 — Turn-Based Battles

**Goal:** add combat — readable, turn-based, with a type/affinity chart — and resolve it **entirely on
the server**, with the client merely submitting a chosen skill and animating the result.

**Where it fits:** monsters exist (M6); now they fight. This milestone makes a deliberate, important
architectural choice that's the mirror image of movement: **battles use no client prediction at all.**

## Why battles need no prediction (and why that's a gift)

Movement is continuous and frequent, so we predicted it to hide latency. A battle turn is a discrete,
once-every-few-seconds event. The round-trip to the server is comfortably hidden by the attack
animation. So we *don't* predict battles: the client sends intent (a skill id), the server computes the
whole turn, and the client animates the authoritative result.

This is a huge simplification, and it's worth savoring **why**: a brand-new `game-core::combat` module
that's only ever run by the server has **zero desync surface.** There's no second implementation to
keep in sync, no reconciliation, no rollback mid-animation. All the determinism discipline still
applies (it's pure `game-core`), but the hardest part of the movement system — prediction — simply
isn't needed here. Choosing turn-based combat *bought* us netcode simplicity.

## The battle lives in a table

A battle is a row holding the whole authoritative `BattleState` plus bookkeeping:

```rust
#[spacetimedb::table(name = battle, public)]
pub struct Battle {
    #[primary_key]
    #[auto_inc]
    pub battle_id: u64,
    #[index(btree)]
    pub player_identity: Identity,
    #[index(btree)]
    pub opponent_identity: Identity,
    pub state: BattleState,        // the full authoritative state machine
    pub party_monster_ids: Vec<u64>, // maps team slots back to monster rows for HP write-back
    pub last_events: Vec<BattleEvent>, // the turn's log (damage, faints) — the client renders these
    pub last_xp_gain: u32,
    pub leveled_up: bool,
    // ...(more fields that come alive in M8 and M11)...
}
```

Storing the battle in a table (not in memory) means it's **resumable on reconnect** and visible to the
client via subscription — and, scoped by an RLS filter (`player_identity = :sender OR
opponent_identity = :sender`), only to the participants, since it carries their monsters' stats.

> A subtle but important schema decision: `player_identity` is *indexed, not the primary key*, and
> there's a separate `opponent_identity`. For a solo PvE battle the two are equal (a "self-sentinel"
> meaning "no human opponent"). That looks like over-engineering for a one-player fight — but it's the
> seam that lets PvP and co-op slot in *additively* in Milestone 11 without a migration. We'll cash
> that in later; for now, just note that both are equal in a wild battle.

## The type chart is data

Effectiveness (Fire beats Nature, etc.) is content, seeded into a `type_relation` table, exactly like
species. The client reads it to show "It's super effective!" hints<sup>[1](https://bulbapedia.bulbagarden.net/wiki/Type)</sup> —
but that's a *lookup on shared data*, not a reimplemented rule. The authoritative damage number is
always the server's.

## Resolving a turn

Here's the PvE path of `submit_action` — the reducer a client calls to attack:

```rust
#[spacetimedb::reducer]
pub fn submit_action(ctx: &ReducerContext, skill_id: u32) -> Result<(), String> {
    let mut battle = caller_battle(ctx).ok_or("not in battle")?;
    if battle.state.is_over() { return Err("battle is over".to_string()); }

    // PvE: the chosen skill must be in the active monster's learnset; resolve immediately vs the AI.
    let active_species_id = battle.state.player.active_ref().species_id;
    let player_skill = validate_known_skill(ctx, active_species_id, skill_id)?;
    let chart = type_chart_from_db(ctx);
    let enemy_skill = enemy_skill_choice(ctx, &battle.state, &chart)?;

    let (new_state, events) = resolve_turn(
        &battle.state, &player_skill, &enemy_skill, &chart, variance(ctx), variance(ctx),
    );

    let won = new_state.outcome == BattleOutcome::PlayerWon;
    battle.state = new_state;
    battle.last_events = events;
    persist_battle_hp(ctx, &battle); // HP carries between battles
    if won {
        let gain = battle_xp_reward(battle.enemy_level);
        battle.last_xp_gain = gain;
        battle.leveled_up = award_battle_xp(ctx, ctx.sender, gain);
    }
    ctx.db.battle().battle_id().update(battle);
    Ok(())
}
```

### How it works

- **Validate the intent.** `validate_known_skill` checks the chosen skill is actually in the active
  monster's learnset. The client sends a skill *id*; the server confirms it's legal for that monster.
  A hacked client sending a skill it doesn't know gets rejected, not trusted.
- **The enemy picks its move on the server.** `enemy_skill_choice` runs the AI (the wild's strongest
  move against your active). The client has no say and no foreknowledge.
- **`resolve_turn` is the pure rule.** It takes both skills, the chart, and two **variance rolls** (the
  server supplies them from `ctx.rng()` — randomness as an argument, never read inside), and returns a
  *new* `BattleState` plus a list of `BattleEvent`s for the log. Speed decides order; the damage
  formula is integer-only (no floats → deterministic). Faints, the win/lose outcome, it's all in there.
- **Persist HP.** Monsters keep their HP *between* battles — `persist_battle_hp` writes each combatant's
  post-turn HP back to its `monster` row. Get hurt, stay hurt (until you heal). This is what makes
  attrition real and gives weakening-for-recruit (next milestone) its stakes.
- **Award XP on a win**, and record whether anyone leveled up so the victory screen can show it.

The client's whole job: render `state`, show the `last_events` log, and offer skill buttons. It
computes nothing.

### Why the damage formula is integer-only

Same reason positions are integers: a float formula could differ by a hair across machines. Combat is
pure `game-core` and shares the determinism guarantee — so even though only the server runs it today,
it's *ready* to be run identically elsewhere (e.g. a client-side "preview" or a replay) without risk.
Discipline you don't strictly need yet, kept because it's cheap and future-proof.

## Visible progression

A monster-tamer lives or dies on the dopamine of growth, so the win path surfaces it: an EXP bar in the
box (with "N to next level"), a "gained N EXP / leveled up!" on victory, and a turn log of damage
numbers and "X fainted!". Notice `xp_floor`/`xp_next` are **server-derived** columns on the monster row
— the client shows a progress bar without ever knowing the XP curve (a cubic `level³`, the "Medium
Fast" growth group<sup>[2](https://bulbapedia.bulbagarden.net/wiki/Experience)</sup>). The curve, like
every rule, lives
once in `game-core`.

## Common pitfalls

- **Predicting battle outcomes on the client.** Tempting for "responsiveness," but it reintroduces the
  whole desync problem we just avoided, plus jarring rollbacks when a predicted hit was wrong. Animate
  the authoritative result instead.
- **Trusting the client's damage or chosen skill.** Validate the skill is known; compute the damage
  server-side. The client sends intent only.
- **Reading the type chart from a TS copy.** Read it from the subscribed `type_relation` table; don't
  fork the data.
- **Healing on level-up or between battles automatically.** HP persists deliberately. (There's an
  explicit `heal_party` action instead — and notably it's *rejected mid-battle*, or it would void the
  weaken-to-recruit loop you're about to build.)

## Alternatives & the honest verdict

- **Real-time / action combat** instead of turn-based. More viscerally exciting, but it would demand
  battle prediction and reconciliation — dramatically harder netcode — and clash with the "readable,
  knowledge-rewarding" design goal. **Verdict: turn-based is both the design fit and the netcode win
  here.** It's the rare case where the simpler-to-build choice is also the better design.
- **A full press-turn / multi-active 3v3 system from day one.** Richer, but much harder to balance
  before you know the base battle is fun. The project ships the readable core (one active per side,
  bench auto-switches on faint) and defers the depth layer. **Verdict: ship the simple core first; the
  depth is a deferred, named extension.** Right call — though a designer chasing competitive depth
  would feel the single-active limit quickly.
- **Storing the battle in memory instead of a table.** Loses reconnect-resumability and makes the
  client unable to subscribe to it. **Verdict: the table is correct** — resumability and the
  subscription model both depend on it.

## Checkpoint

Walk into a wild battle (or call `start_battle`). The battle screen opens via the subscription. Pick a
skill: the server resolves the turn, the log shows the damage and effectiveness, HP bars move, and on a
win you see the XP gain. Lose all your HP and your monsters stay hurt afterward (until `heal_party`).
Combat works, fully server-authoritative, with no prediction to debug. Next: finding monsters in the
wild and taming them.

## References

1. Bulbapedia — ["Type"](https://bulbapedia.bulbagarden.net/wiki/Type). *(Type effectiveness — the model behind the data-driven `type_relation` chart.)*
2. Bulbapedia — ["Experience"](https://bulbapedia.bulbagarden.net/wiki/Experience). *(Leveling curves; the "Medium Fast" group is exactly `level³`, which `xp_for_level` uses.)*
