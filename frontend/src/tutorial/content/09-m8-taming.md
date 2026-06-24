# Milestone 8 — Finding & Taming

**Goal:** complete the core loop's front half. Add tall grass that triggers wild encounters, and a
**recruit-by-weaken** mechanic — lower a wild's HP in battle, then try to recruit it, with the odds
computed from authoritative state.

**Where it fits:** monsters exist (M6) and can battle (M7). Now you can *find* and *catch* new ones —
the "find → tame" half of the gameplay loop becomes real.

## Encounters as data + a private table

Which monsters appear, and how often, is content — an encounter table seeded into a **private**
`encounter` table (the spawn weights are exactly the kind of thing a cheater shouldn't see):

```rust
#[spacetimedb::table(name = encounter)]  // no `public` → server-only
pub struct Encounter {
    #[primary_key] #[auto_inc] pub id: u64,
    #[index(btree)] pub zone_id: u32,
    pub species_id: u32,
    pub weight: u32,
    pub min_level: u8,
    pub max_level: u8,
}
```

The grass itself is already in the map: recall the `,` tiles in `poc_map()` from Milestone 1, parsed
into a `grass: Vec<bool>` parallel to `walkable`. The client renders grass tiles distinctly; the server
knows which tiles are grass via `map.is_grass(pos)`.

## Triggering an encounter from the movement tick

Here's where two systems meet. Remember the `movement_tick` drains one move per character per tick. We
extend the drain: when a *player* actually **enters** a grass tile, roll for an encounter.

```rust
// inside movement_tick, after applying a move:
let entered_grass = next.pos != from && map.is_grass(next.pos);
apply_state(&mut ch, &next);
ctx.db.character().entity_id().update(ch);
if entered_grass {
    maybe_trigger_encounter(ctx, entity_id);
}
```

```rust
fn maybe_trigger_encounter(ctx: &ReducerContext, entity_id: u64) {
    let Some(player) = ctx.db.player().entity_id().filter(entity_id).next() else {
        return; // not a player (e.g. the NPC) — no encounters
    };
    if player_battle(ctx, player.identity).is_some() {
        return; // already battling
    }
    // Roll FIRST (cheap) — only a hit touches the encounter table.
    if !encounter_triggers(ctx.random::<u32>()) {
        return;
    }
    let _ = begin_encounter(ctx, player.identity);
}
```

### How it works

- **`entered_grass` requires actually moving onto a grass tile** (`next.pos != from`). Standing still
  in grass, or bumping a wall while facing grass, doesn't roll. You have to *step in*.
- It uses the **indexed** `player.entity_id` lookup to map the moved character back to its owning
  player without scanning — and skips NPCs (they have no `player` row).
- It **rolls the cheap probability first** (`encounter_triggers`, a pure `game-core` function fed
  `ctx.random()`) — a flat `ENCOUNTER_CHANCE_PERMILLE` of 120, i.e. ~12% per grass step — and only on a
  hit does it read the encounter table and build a battle. Cheap-check-first is a small efficiency habit
  worth having.
- `begin_encounter` rolls a species+level from the zone table, rolls the wild's individuality, and
  inserts a `battle` row. The same function backs a manual `start_battle` reducer, so the "press F to
  fight" path and the grass-step path share one implementation.

## Recruit-by-weaken: the odds are a pure rule

The catch chance is the single most important number in a tamer. Our formula is custom, but the *idea*
— lower HP (and status/bait) raises the odds — is the genre's classic catch-rate mechanic<sup>[1](https://bulbapedia.bulbagarden.net/wiki/Catch_rate)</sup>.
It lives once, in `game-core`, fully deterministic:

```rust
pub fn recruit_chance(max_hp: u16, current_hp: u16, base_rate: u16, bait_bonus: u16) -> u16 {
    let max = max_hp.max(1) as u32;
    let cur = (current_hp.min(max_hp)) as u32;
    // Fraction of HP *missing*, in permille (0 at full HP, 1000 at 0 HP).
    let missing = 1000 - (cur * 1000 / max);
    let from_hp = missing * RECRUIT_HP_FACTOR / 1000;
    (base_rate as u32 + from_hp + bait_bonus as u32).min(1000) as u16
}
```

The design is legible right in the math: at full HP your chance is just the species' base rate; as you
weaken the wild, the "missing HP" term adds up to `RECRUIT_HP_FACTOR` (600 permille) on top; bait adds a
flat bonus; the total caps at 1000 (certainty). **Weakening, not luck, is the lever** — exactly the
intended feel. The `max_hp.max(1)` guards against a divide-by-zero on a degenerate combatant. Every
boundary has a test (`full < half < near_dead`, the cap, the zero-HP case).

## The recruit reducer

```rust
#[spacetimedb::reducer]
pub fn attempt_recruit(ctx: &ReducerContext, use_bait: bool) -> Result<(), String> {
    let mut battle = caller_battle(ctx).ok_or("not in battle")?;
    // ...validate it's a PvE wild battle that isn't over...

    let enemy = battle.state.enemy.active_ref().clone();
    let species = /* look up the wild's species */;

    let mut bait_bonus = 0u16;
    if use_bait {
        let stack = /* find an owned item whose template grants a recruit bonus */;
        bait_bonus = /* that item's bonus */;
        consume_one(ctx, stack); // spent regardless of outcome, like a thrown ball
    }

    let chance = recruit_chance(enemy.max_hp, enemy.current_hp, species.recruit_rate, bait_bonus);

    if recruit_succeeds(chance, ctx.random::<u32>()) {
        // Rebuild *this exact* wild as an owned monster (full HP, into the box).
        let inst = MonsterInstance {
            species_id: SpeciesId(enemy.species_id),
            potential: battle.wild_potential,      // the SAME genes it had as a wild
            temperament: battle.wild_temperament,
            bond: Bond(RECRUIT_BOND),
            // ...
        };
        ctx.db.monster().insert(monster_row(ctx.sender, &core, &inst, None));
        battle.state.outcome = BattleOutcome::Recruited;
    } else {
        // Failed: you forfeited your attack, so the wild strikes back. Lead the log with "broke free".
        let (new_state, mut events) = resolve_enemy_turn(&battle.state, &enemy_skill, &chart, variance(ctx));
        events.insert(0, BattleEvent::RecruitFailed);
        battle.state = new_state;
        battle.last_events = events;
        persist_battle_hp(ctx, &battle);
    }
    ctx.db.battle().battle_id().update(battle);
    Ok(())
}
```

> One naming note so the snippet reads cleanly: the success check calls `recruit_succeeds(...)`, which
> is the pure `game-core::attempt_recruit` function imported `as recruit_succeeds` — renamed only
> because the *reducer* is also called `attempt_recruit` and they can't share a name in the same file.
> The rule and the reducer are still distinct: one decides, one orchestrates.

### How it works, and one lovely detail

- **The server computes the odds and the roll.** The client sends only `use_bait: bool` — pure intent.
  It can't influence the chance or the outcome.
- **Bait is data-driven.** "Bait" isn't a hard-coded item id; it's *any* owned item whose template
  grants a recruit bonus. The reducer finds one, reads its bonus, and consumes it (win or lose, like a
  thrown ball). Add a new bait item in the RON and it just works.
- **The lovely detail:** when a recruit *succeeds*, the wild becomes a box monster with **the exact same
  genes and temperament it had in battle** — pulled from `battle.wild_potential`/`wild_temperament`,
  which `begin_encounter` stashed on the battle row. You catch *that* monster, the individual you
  weakened, not a freshly re-rolled one. Individuality is preserved end to end.
- **On failure, you forfeited your turn**, so only the wild acts (`resolve_enemy_turn`), and the log
  leads with an authoritative `RecruitFailed` "broke free" event — rendered by the client like any
  other event. The client never invents the "broke free" message; the server does.

## Common pitfalls

- **Letting the client send the catch chance or the success.** It sends intent (`use_bait`); the server
  computes everything. Otherwise every monster is trivially catchable.
- **Re-rolling the wild's genes on a successful catch.** You'd hand the player a different monster than
  the one they weakened. Stash and reuse the rolled individuality.
- **Triggering encounters on *standing* in grass.** Require *entering* a new grass tile, or a player
  standing still gets spammed.
- **Hard-coding a bait item id.** Derive "is this bait?" from the item template's bonus, so new content
  classifies itself.
- **Allowing `heal_party` mid-battle.** Healing to full after each weakening turn would make recruiting
  free. It's rejected during battle for exactly this reason.

## Alternatives & the honest verdict

- **A flat catch rate (no HP factor).** Simpler, but it makes weakening pointless and turns taming into
  a slot machine. **Verdict: the HP-based formula is core to the intended "puzzle, not gamble" feel.**
- **A separate "encounter tick" scheduled reducer** instead of folding the roll into `movement_tick`.
  Cleaner separation, but it'd re-scan characters and duplicate the "did this entity just move?"
  knowledge the movement tick already has. **Verdict: folding it into the existing tick is simpler and
  cheaper here** — though if encounters grew complex (weather, time-of-day, per-zone rates), a
  dedicated system would earn its keep, and splitting it out would then be the better call.
- **Client-side encounter rolling for instant feedback.** Reintroduces trust-the-client problems for no
  real UX gain (the battle screen opening *is* the feedback). **Verdict: keep it server-side.**

## Checkpoint

Walk into the tall grass and a wild encounter opens. Whittle the wild's HP down and confirm that
recruiting succeeds more reliably as it weakens (the odds live on the server — the UI just nudges you
to "lower its HP first" rather than showing a number). Throw bait, attempt a recruit: on success the
exact wild — same genes — lands in your box at full HP; on failure it "breaks free" and strikes back.
The **find → tame** loop is complete and fully authoritative. Next, we make raising those monsters matter.

## References

1. Bulbapedia — ["Catch rate"](https://bulbapedia.bulbagarden.net/wiki/Catch_rate). *(The genre mechanic — lower HP and status raise capture odds — that `recruit_chance` reinterprets.)*
