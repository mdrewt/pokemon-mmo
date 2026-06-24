# Milestone 11 — Going Multiplayer

**Goal:** the big one — player-to-player **trading**, ranked **PvP battles** with an Elo ladder, and
**co-op raids**. Make individual monsters genuinely valuable by letting players trade and fight over
them.

**Where it fits:** monsters are now unique, raised individuals (M6–M10), which is exactly when
multiplayer becomes meaningful. This milestone has more moving parts than any other — so it opens with
a lesson about *deciding before building.*

## Decide before you build

Multiplayer touched almost every table. Before writing a line, the project worked through a set of
**entry conditions** — breaking decisions that are cheap to make now and expensive to make later:

- The `battle` table's identity model had to change to support two human participants.
- Trades need an escrow model so a monster can't be in two places at once.
- Disconnects mid-battle need a defined outcome (forfeit? abandon?).

Why front-load this? Because the `battle` schema change is **breaking**, and it's cheapest while you can
still wipe the database (`--delete-data`) without consequence — i.e., before real players have monsters
they'd lose. Once you have users, you can't casually reshape a table. The lesson generalizes: **the
schema decisions you can't easily reverse are the ones to make deliberately and early.** Plumbing is
cheap to change; foundations are not.

## Trading: escrow + dual consent

A trade is a directed, three-step handshake with the offered monsters **escrowed** so neither can be
altered or double-spent mid-trade: the initiator offers a monster (`offer_trade`), the recipient
responds with theirs (`respond_trade`), the initiator confirms (`confirm_trade`) — and only then does
the atomic swap run.

The escrow is enforced by a guard that *every* monster-mutating reducer already calls — `reject_if_in_trade`
— so an offered monster can't be evolved, fused, trained, or re-offered while it's on the table. The
swap itself re-validates everything against live state, because the displayed "cards" are just a
snapshot:

```rust
#[spacetimedb::reducer]
pub fn confirm_trade(ctx: &ReducerContext, offer_id: u64) -> Result<(), String> {
    // ...only the initiator, only when the recipient has responded...
    // Neither party may be mid-battle (a traded monster could be a combatant).
    // Re-read both LIVE rows and re-check ownership — the snapshot is display-only and may be stale.
    if from_mon.owner_identity != offer.from_identity || to_mon.owner_identity != offer.to_identity {
        return Err("a monster changed owner; trade cancelled".to_string());
    }
    // Atomic swap: each monster moves to the other player's box (one reducer = one transaction).
    from_mon.owner_identity = offer.to_identity;
    to_mon.owner_identity = offer.from_identity;
    // ...refresh stats, delete the offer...
    Ok(())
}
```

The pattern to absorb: **display data is a snapshot; the authoritative action always re-reads live
state and re-checks ownership.** The card the counterparty saw is a UI convenience; the swap trusts only
the current rows. And cancelling or disconnecting deletes the offer, which releases the escrow lock —
the lock *lives in the offer row*, so there's no separate state to leak.

## The participant model: one table, three battle kinds

Here's that breaking schema decision, paid off. The `battle` row carries **two identities**:

```rust
#[index(btree)] pub player_identity: Identity,   // the challenger / the human whose battle this is
#[index(btree)] pub opponent_identity: Identity, // the second human, IF any
pub is_raid: bool,
```

From those two fields, three battle kinds fall out with no new tables:

| Kind | `opponent_identity` | `is_raid` | Meaning |
|---|---|---|---|
| **PvE wild** | equals `player_identity` (self-sentinel) | false | no human opponent; enemy is an AI wild |
| **PvP duel** | the foe | false | two humans, opposing sides |
| **Co-op raid** | the ally | true | two humans on the *same* side vs an AI boss |

So `is_multiplayer = player != opponent`, and `is_pvp = is_multiplayer && !is_raid`. The PvE battle from
Milestone 7 — where both identities were equal — was quietly *already* in this shape. That "pointless"
duplication was the seam, and now it absorbs PvP and raids **additively**, exactly as planned.

The best part: `resolve_turn`, the pure combat rule from Milestone 7, is **symmetric** — it already
resolves "player side vs enemy side" without caring whether the enemy is an AI or another human. So PvP
needed *no new battle rule at all*. Only co-op raids (two allies + one boss, a three-actor turn) needed
a new pure function, `resolve_coop_turn`. The functional core kept multiplayer cheap.

## The hard part: simultaneous secret choices

In PvP, both players choose a move and they resolve *together* — and **neither may see the other's pick
first**, or it's not a fair simultaneous turn. A field on the shared `battle` row can't provide that
(both players can read that row). So picks go into a separate, **per-chooser private** table:

```rust
#[spacetimedb::table(name = battle_action, public)]
pub struct BattleAction {
    #[primary_key] #[auto_inc] pub id: u64,
    #[index(btree)] pub battle_id: u64,
    pub chooser_identity: Identity,
    pub skill_id: u32,
}

/// A player sees only their OWN queued action — never the opponent's pending skill.
#[client_visibility_filter]
const BATTLE_ACTION_VISIBILITY: Filter =
    Filter::Sql("SELECT * FROM battle_action WHERE chooser_identity = :sender");
```

The RLS filter is doing real security work here: it makes each player's pending pick **invisible to the
other** over the wire. The server (whose reads bypass RLS) sees both, and resolves the turn only once
*both* have chosen:

```rust
fn record_pick(ctx: &ReducerContext, battle: &Battle, skill_id: u32) -> Result<Option<(u32, u32)>, String> {
    // ...reject a double-submit within the turn...
    ctx.db.battle_action().insert(BattleAction { /* this player's pick */ });
    // Returns Some((player_skill, opponent_skill)) once BOTH have chosen, else None.
}
```

```rust
// inside submit_action, the PvP branch:
if let Some((ps, es)) = record_pick(ctx, &battle, skill_id)? {
    let (new_state, events) = resolve_turn(&battle.state, &player_skill, &enemy_skill, &chart,
                                           variance(ctx), variance(ctx));
    // ...persist HP for BOTH sides, apply rating if decisive, clear actions for next turn...
}
```

So a PvP `submit_action` either records your pick and waits (returns having inserted one row), or — if
your opponent already picked — resolves the whole turn. Same symmetric `resolve_turn`, no AI, no
peeking. (The very same `record_pick` "wait for both, then resolve" mechanism also drives **co-op raid**
turns — both allies choose secretly before the boss acts — which is why the helper isn't named
anything PvP-specific.)

> **Why not a unique DB constraint to prevent double-submits**, instead of the in-code `record_pick`
> check? Because SpacetimeDB *serializes conflicting reducer transactions* — two `submit_action` calls
> from the same identity can't both observe an empty action set; the second re-runs against the first's
> committed row and is rejected by the in-code guard. The constraint would add insert-panic semantics
> for no real gain. (This is the kind of platform-specific reasoning you confirm against the docs, not
> your instincts.)

## Ranked: a pure Elo update

A decisive PvP result updates both players' ladder ratings via a pure, integer-only Elo rule (floats
would break determinism):

```rust
pub fn elo_update(winner: i32, loser: i32) -> (i32, i32) {
    let diff = loser - winner; // > 0 when the loser was higher-rated (an upset)
    let raw = K_FACTOR / 2 + diff * K_FACTOR / 800;
    let delta = raw.clamp(1, K_FACTOR - 1);
    (winner + delta, loser - delta)
}
```

Everyone starts at `STARTING_RATING` (1000). It's zero-sum (the winner gains exactly what the loser
drops), an upset swings more than a favorite's win, and a win is always worth at least 1 point. Ratings
live in a **persistent `profile` table keyed by identity** that — unlike the ephemeral `player`
presence row — *survives disconnects*, so your ladder rating is durable. `apply_pvp_rating` is called at
exactly one place: the terminal transition (resolve, forfeit, or disconnect).

## Disconnects and forfeits

Mid-battle disconnects needed a defined meaning, handled in `client_disconnected` and `close_battle`:
fleeing or disconnecting from an ongoing **PvP** battle is a **forfeit** — the other player wins, takes
the ranked win, and the battle is marked terminal so they see the result and dismiss it. Abandoning a
**raid** fails it for the team (no rating). A solo PvE battle just vanishes (your monsters persist).
The rule "an ongoing multiplayer battle must reach a defined terminal state for the other human" is the
kind of thing that's invisible until you test a disconnect — so it's handled explicitly in both the
flee path and the disconnect path.

## Common pitfalls

- **Putting PvP picks on the shared battle row.** Both players can read it — you've leaked the
  simultaneous choice. Use a per-chooser private table with an RLS filter.
- **Trusting the trade "card" snapshot at swap time.** Re-read live rows and re-check ownership; a lot
  can change between offer and confirm.
- **Doing the breaking `battle` schema change *after* you have real users.** Do it while
  `--delete-data` is still free.
- **Floating-point Elo.** Non-deterministic. Integer math only.
- **Forgetting to define the disconnect outcome.** An ongoing PvP battle whose opponent vanished must
  resolve for the survivor, or they're stuck.
- **Reaching for a unique constraint where serialized transactions already suffice** — verify the
  platform's concurrency semantics first.

## Alternatives & the honest verdict

- **A turn timer that auto-resolves if a player stalls.** The project notes this as a deferred entry
  condition rather than building it — today a stalled PvP turn waits indefinitely (you can flee). **Verdict:
  honestly, a turn timeout *should* exist for a shipping ranked mode**, and its absence is a known gap,
  not a virtue. It's a fair example of "good enough for the milestone, not for launch."
- **Separate tables per battle kind** (`pve_battle`, `pvp_battle`, `raid`). More explicit, but it'd
  triple the battle plumbing and fork `submit_action` three ways. **Verdict: the one-table participant
  model is the better design** — it reused the symmetric combat rule and added kinds additively.
- **Trustless peer-to-peer trading / battling.** Not applicable — the server is authoritative, which is
  the whole security model. **Verdict: server-mediated is correct for an authoritative game.**

## Checkpoint

Two players, two windows: offer a monster, respond with one, confirm — ownership swaps atomically, and
neither could tamper with an escrowed monster mid-trade. Challenge the other player; both pick a skill
without seeing the other's; the turn resolves simultaneously and the ladder ratings update on a
decisive result. Team up for a raid against a boss and share the XP on a win. Disconnect mid-PvP and the
other player sees a clean win. **The game is multiplayer, end to end, server-authoritative throughout.**
One chapter left — let's reflect honestly on what we built and where it goes next.
