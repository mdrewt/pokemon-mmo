# Milestone 10 — Evolution & Fusion

**Goal:** add the two big progression sinks — **conditional evolution** (branch a monster into a
stronger form when it meets level/bond gates) and **fusion** (combine two monsters into an offspring
that inherits the best of both). Both keep the *individual* intact across the transformation.

**Where it fits:** raising (M9) produces monsters worth transforming. Evolution and fusion are the
payoff — and, with trading coming next, the backbone of the multiplayer economy.

## Evolution: conditional, branching, data-driven

Recall the `evolutions` list in `species.ron`:

```ron
evolutions: [
    (to: 5, min_level: 2, min_bond: 0),
    (to: 6, min_level: 2, min_bond: 120),
],
```

A species can evolve into several targets, each gated by a minimum level and bond. An empty list means
a final form; multiple entries are **branches the player chooses among** — and note the second branch
here needs `min_bond: 120`, so *how you raised the monster* (Milestone 9's care) decides which
evolutions it can even reach. Same species, different upbringing, different destiny.

The eligibility check is a pure `game-core` function, `eligible_evolutions(species, level, bond)`,
which returns the target ids the monster currently qualifies for. The server stores that list on the
monster's `evolves_to` column (recomputed whenever level or bond changes), and the client offers
"Evolve" options *from that list* — it never re-derives the gate.

The reducer re-validates against authoritative state before committing:

```rust
#[spacetimedb::reducer]
pub fn evolve_monster(ctx: &ReducerContext, monster_id: u64, to_species_id: u32) -> Result<(), String> {
    reject_if_in_battle(ctx)?;
    let mut monster = caller_monster(ctx, monster_id)?;
    reject_if_in_trade(ctx, monster_id)?;
    let species = /* look up monster.species_id */;
    // Re-validate eligibility from authoritative state — never trust the client's chosen target.
    let eligible = eligible_evolutions(&core_species(&species), Level(monster.level), Bond(monster.bond));
    if !eligible.contains(&to_species_id) {
        return Err("this monster can't evolve into that yet".to_string());
    }

    monster.species_id = to_species_id;
    refresh_monster_stats(ctx, &mut monster); // new species → new base/derived + fresh evolves_to
    ctx.db.monster().monster_id().update(monster);
    Ok(())
}
```

### The key idea: it's the *same monster*, evolved

Look at what changes: only `species_id`. Everything that makes the monster an *individual* —
its genes (`potential`), training, bond, XP, and nickname — **stays.** It's not replaced with a new
creature; it's the same one you raised, now in a stronger form. `refresh_monster_stats` recomputes the
derived stats against the new species base (so it gets stronger) and refreshes the evolution list for
the new form. Continuity of identity is the whole emotional point.

And the security pattern is by now familiar: the client sends a *chosen target id*, but the server
**re-checks eligibility from its own state.** A hacked client asking to evolve a level-1 monster into a
final form is rejected — the client's `evolves_to` list is a UI convenience, not an authorization.

## Fusion: inherit the best of both

Fusion combines two monsters into an offspring. Which pairs make what is data — `fusions.ron` lists
recipes (`(a: 1, b: 2, to: 10)`), seeded into a `fusion` table. The lookup is order-independent:

```rust
pub fn find_fusion(recipes: &[FusionRecipe], a: u32, b: u32) -> Option<u32> {
    recipes
        .iter()
        .find(|r| (r.a == a && r.b == b) || (r.a == b && r.b == a))
        .map(|r| r.to)
}
```

The offspring is built by a pure rule that inherits the **better gene per stat** and the higher-bond
parent's temperament:

```rust
pub fn fuse_offspring(offspring: SpeciesId, a: &MonsterInstance, b: &MonsterInstance) -> MonsterInstance {
    let potential = Potential {
        hp: a.potential.hp.max(b.potential.hp),
        attack: a.potential.attack.max(b.potential.attack),
        defense: a.potential.defense.max(b.potential.defense),
        special: a.potential.special.max(b.potential.special),
        speed: a.potential.speed.max(b.potential.speed),
    };
    let temperament = if a.bond >= b.bond { a.temperament } else { b.temperament };
    // ...fresh otherwise: level 1, no training, no nickname...
}
```

So a fused monster **out-genes either parent** (each gene is the max of the two) — the breed-for-stats
payoff — but starts fresh at level 1 with no training, so it's a real investment to re-raise. That's
the deliberate progression sink.

## The reducer: an atomic, irreversible operation

Fusion deletes two monsters and creates one. That *must* be all-or-nothing — and SpacetimeDB's
one-reducer-one-transaction model gives us that for free:

```rust
#[spacetimedb::reducer]
pub fn fuse_monsters(ctx: &ReducerContext, monster_a: u64, monster_b: u64) -> Result<(), String> {
    reject_if_in_battle(ctx)?;
    if monster_a == monster_b { return Err("pick two different monsters to fuse".to_string()); }
    let a = caller_monster(ctx, monster_a)?; // ownership of BOTH
    let b = caller_monster(ctx, monster_b)?;
    reject_if_in_trade(ctx, monster_a)?;
    reject_if_in_trade(ctx, monster_b)?;

    let offspring_id = find_fusion(&fusions_from_db(ctx), a.species_id, b.species_id)
        .ok_or("those two monsters can't be fused")?;
    let inst = fuse_offspring(SpeciesId(offspring_id), &monster_to_instance(&a), &monster_to_instance(&b));
    let slot = [a.party_slot, b.party_slot].into_iter().flatten().min();

    // Consume both parents, then create the offspring — one reducer = one transaction = atomic.
    ctx.db.monster().monster_id().delete(monster_a);
    ctx.db.monster().monster_id().delete(monster_b);
    ctx.db.monster().insert(monster_row(ctx.sender, &core_species(&offspring_species), &inst, slot));
    Ok(())
}
```

### How it works

- **Atomicity for free.** Two deletes and an insert all happen in one transaction. If anything returned
  `Err` partway, the whole thing rolls back — you can never end up with both parents gone and no
  offspring, or vice versa. This is the SpacetimeDB property from Milestone 2 paying a real dividend on
  a genuinely dangerous operation.
- **Ownership of both** is checked (`caller_monster` twice), they must be distinct, and a recipe must
  exist — otherwise reject. Nothing is consumed on a rejected fusion.
- **Slot inheritance:** the offspring takes the lower party slot of its parents (if either was in the
  party), so fusing two party members doesn't silently shrink your active team.

## Guarding the content

A few content invariants are enforced in `validate_content` (which runs as a test, so they fail the
build): fusion recipes can't reference unknown species, the same pair can't have two recipes, and —
importantly — **evolution targets and fusion offspring are excluded from wild encounters**, so you
can't just *catch* a form that's meant to be *earned*. The "starters are base forms only" rule from
Milestone 6 is the same idea. These guards are mechanical, not manual — the build won't let bad content
through.

## Common pitfalls

- **Trusting the client's chosen evolution target.** Re-validate eligibility server-side from
  authoritative level/bond. The `evolves_to` list is UI, not permission.
- **Replacing the monster on evolution.** Keep its genes/training/bond/XP/nickname — change only the
  species. Otherwise you've destroyed the individual the player grew attached to.
- **Doing fusion as multiple reducer calls** (delete, then insert). If the second call fails, you've
  vaporized two monsters. One reducer = one transaction = safe.
- **Letting evolved/fusion forms spawn wild or be granted as starters.** Then "earned" forms become
  catchable. The content guards prevent it; don't bypass them.

## Alternatives & the honest verdict

- **Linear, automatic evolution** (evolve at level N, no choice). Simpler, but it removes the "raising
  choices shape destiny" hook (the bond-gated branch). **Verdict: conditional branches are worth the
  small extra complexity for this game** — they make care mechanically meaningful.
- **Breeding (two parents → an egg) instead of fusion (two parents → offspring, both consumed).**
  Breeding keeps the parents, which is friendlier but inflationary (monsters only multiply). Fusion's
  consumption is a deliberate sink that supports the trading economy. **Verdict: fusion fits the
  economy goals; breeding would be a reasonable, more forgiving alternative** with different economic
  consequences — a real design fork, not a right/wrong.
- **A generic "combine N items via a recipe table" crafting system.** More general, but YAGNI for two
  specific operations. **Verdict: the focused reducers are clearer; generalize only if a third similar
  operation appears.**

## Checkpoint

Raise a monster past its level (and, for a branch, its bond) gate and the box offers Evolve options
drawn from `evolves_to`; evolving keeps its name and genes but bumps its stats. Fuse two compatible
monsters and get an offspring that out-genes both parents, at level 1, with the parents consumed
atomically. Try to fuse an incompatible pair and it's cleanly rejected. The single-player game is
*complete*: find, tame, raise, battle, evolve, fuse. Now we make it multiplayer for real.
