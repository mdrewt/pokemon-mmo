# Milestone 9 — Raising & Growth

**Goal:** make *how* you raise a monster visibly shape what it becomes. Add **focus-training** (food
that pushes a stat) and **care** (deliberate, cooldown-gated bonding) — both active, never idle.

**Where it fits:** you can now find, catch, and battle monsters (M6–M8). This milestone is the
attachment engine: two players' same-species monsters diverge based on the choices each owner made.

## The design constraint: active only

A deliberate decision shapes every rule here: **no idle/offline growth.** A monster doesn't gain
anything while you're logged off. Every bit of growth is a *deliberate action you take* — feeding,
caring, battling — that the server validates for cost and cooldown. This keeps the game honest (no
afk-farming) and makes investment feel earned. The rules are written so there's simply no "tick that
accrues bond over time" anywhere to add.

## Training: food shapes the stat spread

Training is an EV-like system<sup>[1](https://bulbapedia.bulbagarden.net/wiki/Effort_values)</sup>:
feeding a stat-food invests in that stat (within caps), and the investment flows through `derive_stats`
so the monster's numbers visibly diverge. The pure rule:

```rust
pub fn apply_training(mut training: Training, stat: Stat, amount: u16) -> Result<Training, String> {
    let current = training.get(stat);
    if current >= Training::PER_STAT_MAX {
        return Err("that stat is already fully trained".to_string());
    }
    let total = training.total();
    if total >= Training::TOTAL_MAX {
        return Err("this monster is fully trained".to_string());
    }
    let stat_headroom = Training::PER_STAT_MAX - current;
    let total_headroom = Training::TOTAL_MAX - total;
    let applied = amount.min(stat_headroom).min(total_headroom);
    training.set(stat, current + applied);
    Ok(training)
}
```

### How it works

- Two caps: a **per-stat** cap (252) and a **total** cap (510) across all stats — the exact Gen-3 EV
  caps<sup>[1](https://bulbapedia.bulbagarden.net/wiki/Effort_values)</sup> — so you can't max
  everything; raising is about *choices and tradeoffs*.
- Note the deliberate distinction between **rejecting** and **clamping**. If a stat is *already at its
  cap*, the function returns `Err` — so the reducer can tell the player "already fully trained" and
  **not consume the food** for nothing. But if there's *some* headroom less than the food's amount, it
  fills to the cap (a near-cap food tops off rather than being wasted). The error-vs-clamp line is drawn
  precisely where it serves the player.

The reducer wraps it with the usual validation, and crucially applies the rule **before** spending:

```rust
#[spacetimedb::reducer]
pub fn train_monster(ctx: &ReducerContext, monster_id: u64, item_id: u32) -> Result<(), String> {
    reject_if_in_battle(ctx)?;
    let mut monster = caller_monster(ctx, monster_id)?; // ownership check
    reject_if_in_trade(ctx, monster_id)?;               // can't alter a monster that's escrowed (M11)
    // ...find the food item and the caller's stack of it...
    let stat = item.train_stat.ok_or("that item is not training food")?;

    // Apply the rule FIRST — if the stat has no headroom it rejects, and we DON'T spend the food.
    monster.training = apply_training(monster.training, stat, item.train_amount)?;
    refresh_monster_stats(ctx, &mut monster);

    consume_one(ctx, stack);
    ctx.db.monster().monster_id().update(monster);
    Ok(())
}
```

Order matters: validate-and-apply, *then* consume. Because the reducer is one transaction, an early
`Err` rolls everything back — but doing the fallible work before the irreversible spend keeps the logic
obvious and the failure clean. `refresh_monster_stats` re-runs `derive_stats` so the new training
immediately shows up in the monster's `derived` stats (and its level/evolution-eligibility stay
correct).

## Care: cooldown-gated bonding

Bond — our take on Pokémon's *friendship/happiness*<sup>[2](https://bulbapedia.bulbagarden.net/wiki/Friendship)</sup> —
grows through deliberate care, gated by a per-monster cooldown so it can't be spammed:

```rust
#[spacetimedb::reducer]
pub fn care_for_monster(ctx: &ReducerContext, monster_id: u64) -> Result<(), String> {
    reject_if_in_battle(ctx)?;
    let mut monster = caller_monster(ctx, monster_id)?;
    reject_if_in_trade(ctx, monster_id)?; // same escrow guard every monster-mutating reducer uses
    if monster.bond >= Bond::MAX {
        return Err("this monster is already completely devoted to you".to_string());
    }
    let now = now_ms(ctx) as i64;
    if now - monster.last_care_at_ms < CARE_COOLDOWN_MS {
        return Err("this monster needs a little time before you care for it again".to_string());
    }
    monster.bond = apply_care(Bond(monster.bond), CARE_BOND_GAIN).0;
    monster.last_care_at_ms = now;
    refresh_monster_stats(ctx, &mut monster); // bond can cross an evolution gate
    ctx.db.monster().monster_id().update(monster);
    Ok(())
}
```

### How it works

- **The cooldown is server-time.** `now_ms(ctx)` comes from `ctx.timestamp` (the authoritative clock),
  and `last_care_at_ms` is stored on the monster row. The client can't fast-forward it. This is the
  "active, gated" design enforced in code — and notice it **rejects** at max bond *before* burning the
  cooldown on a no-op.
- The pure `apply_care` just does the capped increment (`saturating_add ... .min(Bond::MAX)`); the
  reducer owns the cooldown policy. Rule in `game-core`, *effect* (cooldown, persistence) in the shell.
- Bond gates evolution (Milestone 10), so `refresh_monster_stats` recomputes evolution eligibility here
  too — care your monster enough and a new evolution branch quietly unlocks.

## Common pitfalls

- **An idle accrual "for convenience."** It quietly breaks the active-only design and invites
  afk-farming. There's deliberately no timer that grows bond on its own.
- **Spending the food before checking headroom.** Validate (and let it reject) first, then consume — or
  a maxed stat eats the player's item for nothing.
- **Trusting a client-sent timestamp for the cooldown.** Use `ctx.timestamp`. A client clock is a
  client lie.
- **Forgetting to re-derive stats after training.** The investment must flow through `derive_stats` or
  the player sees no change and the system feels dead.

## Alternatives & the honest verdict

- **Idle/offline raising (a ranch that grows monsters while you're away).** Popular and engaging in many
  games. It was explicitly rejected here because the design wants attachment to come from *active*
  investment, and idle systems invite automation. **Verdict: right for this game's stated pillars —
  but genuinely a matter of design taste, not correctness.** A different game could make the opposite
  call and be better for it.
- **Free-form stat allocation (spend points anywhere).** Simpler UI, but it removes the "food is a
  resource you find/earn" texture and the item economy. **Verdict: item-driven training fits the tamer
  genre and feeds the trading economy later.**
- **A single "happiness" number with no cooldown.** Easier, but trivially maxed in seconds, killing the
  sense that bond is earned over time. **Verdict: the cooldown is what makes bond meaningful.**

## Checkpoint

Feed a monster an Attack food and watch its Attack (and `derived` stats) tick up in the box — then keep
feeding until it rejects with "already fully trained" (and doesn't consume the food). Care for a
monster and its bond rises; try again immediately and it tells you to wait. Two same-species monsters,
raised differently, now have visibly different stat spreads. Raising shapes growth — and high bond is
about to unlock something. Next: evolution and fusion.

## References

1. Bulbapedia — ["Effort values"](https://bulbapedia.bulbagarden.net/wiki/Effort_values). *(The EV system and its 252-per-stat / 510-total caps that `apply_training` enforces.)*
2. Bulbapedia — ["Friendship"](https://bulbapedia.bulbagarden.net/wiki/Friendship). *(The happiness/bond stat that grows with care and gates some evolutions.)*
