# Reducer reference

Reducers are the **only** way to mutate tables. Each runs in its own transaction and commits only if it
returns `Ok` — an `Err(String)` aborts the whole transaction (the transactional escape hatch). The
client sends **intent** (a direction, a skill id, a target); the server computes every **outcome** from
authoritative state. Identity is always `ctx.sender`, set by the framework — never a client field.

Source of truth: [`server-module/src/lib.rs`](../server-module/src/lib.rs). On the client, each reducer
is a thin wrapper in [`frontend/src/net/connection.ts`](../frontend/src/net/connection.ts); action
reducers route their rejection (the server's `Err` string) to an error toast via the `call()` seam,
while the high-frequency movement reducers deliberately bypass it (their rejections are normal
flow-control). See [frontend.md](frontend.md#the-error-toast-call-seam).

## Lifecycle

| Reducer | Does |
|---|---|
| `init` | Seeds the content tables (`config`, `species`, `skill`, `type_relation`, `encounter`, `item`, `fusion`) from the `game-core` RON loaders, spawns one wander NPC, and inserts the `movement_tick` schedule. (`.expect()` on the loaders — a broken embedded-content build fails loud at publish.) |
| `client_connected` | No-op (presence is established by `join_game`). |
| `client_disconnected` | Deletes the caller's `character` + `player` rows; ends any active battle (a still-ongoing multiplayer battle is forfeited gracefully — PvP → the opponent wins + rating; raid → the team fails, no rating); clears the caller's challenges and trade offers. Monsters and the `profile` persist. |

## Movement

| Reducer | Args | Validations / notes |
|---|---|---|
| `join_game` | `name` | Validates the name; rejects a double-join; decides **first-join** by **zero monster rows** (items can be spent to zero, so they're not a reliable signal). Spawns a character at a random walkable tile, inserts `player`, ensures a `profile` exists. First join only: grants a starter monster + starter items. |
| `enqueue_move` | `input, seq` | Appends one `MoveInput`; rejects when the queue is full (`MOVE_QUEUE_CAP`, anti-flood). Monotonic `seq` ack (rejects `seq <= last_input_seq`). The move's **outcome** is computed later by the tick — never the client's word. |
| `set_move` | `input, seq` | Clears the un-drained queue and pushes one move (a responsive direction change). Same `seq` guard. |
| `clear_queue` | `seq` | Clears the un-drained queue. Same `seq` guard. |
| `movement_tick` | *(scheduled)* | **Scheduler-only** (guarded by `ctx.sender != ctx.identity()` → `Err`). Drains one move per character via `game_core::apply_move`; refills NPC queues with a wander; a player stepping *into* grass may trigger a wild encounter. |

## Monster management

All require ownership (`caller_monster`), reject acting **during a battle** (`reject_if_in_battle`), and
reject a monster **escrowed in a pending trade** (`reject_if_in_trade`).

| Reducer | Args | Validations / notes |
|---|---|---|
| `rename_monster` | `monster_id, name` | Validates the name. |
| `set_party_slot` | `monster_id, slot: Option<u8>` | Rejects `slot >= PARTY_SIZE`; vacates an occupied slot (bumps its occupant to the box). Atomic. |
| `train_monster` | `monster_id, item_id` | Item must be food the caller owns (`quantity > 0`). Applies the training rule **first** (rejects if the stat is maxed — so food is *not* spent on a rejected train), then recomputes stats and consumes one food. |
| `care_for_monster` | `monster_id` | Rejects if bond is already maxed (no burning the cooldown on a no-op) or if within `CARE_COOLDOWN_MS`. Bond can cross an evolution gate, so stats are refreshed. |
| `evolve_monster` | `monster_id, to_species_id` | **Re-validates** eligibility from authoritative level + bond (`eligible_evolutions`) — never trusts the client's chosen target. Swaps the species, recomputes stats; keeps genes/training/bond/XP/nickname (same individual, evolved). |
| `fuse_monsters` | `monster_a, monster_b` | Rejects identical ids; owns both. A recipe must exist for their species pair. Deletes both parents and inserts the offspring (inherits the better gene per stat + the higher-bond parent's temperament + the lower party slot) — atomic. |

## Battle

| Reducer | Args | Validations / notes |
|---|---|---|
| `start_battle` | — | Begins a PvE encounter on demand (your party vs a wild rolled from the zone table). |
| `submit_action` | `skill_id` | The skill must be in the caller's active monster's learnset. Branches by **battle mode**: **PvE** picks the wild's move (AI) and resolves immediately, awarding XP on a win; **PvP** records the caller's pick privately (`record_pick`) and resolves the symmetric turn only once *both* players have chosen, then updates ratings if decisive; **raid** records the ally's pick and, once both allies have chosen, resolves the 3-actor co-op turn (boss move is AI) and awards XP to both on a clear. |
| `swap_active` | `team_index` | **Solo-only** (rejected in any multiplayer battle). Target must be in range, not the current active, not fainted. Switching costs the turn (the wild strikes the monster sent in). |
| `attempt_recruit` | `use_bait` | **Solo-only** (PvE). Optional bait spend (any item with a `recruit_bonus`, consumed regardless of outcome). On success rebuilds *that exact* wild (kept individuality, full HP) into the box; on failure the wild strikes back. |
| `heal_party` | — | Rejected during a battle. Restores all the caller's monsters to full HP. (Currently free + untimed — see [known-issues.md](known-issues.md).) |
| `close_battle` | — | Flee / dismiss. Leaving an **ongoing multiplayer** battle ends it for both (PvP forfeit + rating; raid → the team fails, no rating) — the row goes terminal so the partner sees a result. A terminal or solo battle is just deleted. |

## Trading (M11.1) — directed, dual-consent, escrowed

| Reducer | Args | Validations / notes |
|---|---|---|
| `offer_trade` | `to_identity, offered_monster_id` | Rejects self; target must be a player; caps open offers (anti-flood). Owns the monster, not in battle, not already escrowed. Snapshots a `MonsterCard` into a new `AwaitingRecipient` offer (the monster is now locked). |
| `respond_trade` | `offer_id, offered_monster_id` | Caller must be the recipient; status `AwaitingRecipient`. Puts up their own monster (owned, free), flips to `AwaitingInitiator`. |
| `confirm_trade` | `offer_id` | Caller must be the initiator; status `AwaitingInitiator`. Neither party in battle. **Re-reads both live rows and re-checks ownership** (the card is display-only). Atomic swap: both `owner_identity` change, both go to the box (`party_slot = None`), stats re-derived, offer deleted. |
| `cancel_trade` | `offer_id` | Either party; deletes the offer (releasing the escrow lock). |

## PvP & co-op invites (M11.2 / M11.4)

| Reducer | Args | Validations / notes |
|---|---|---|
| `challenge_player` | `to_identity` | Inserts a PvP challenge (`create_invite(.., is_raid = false)`). |
| `invite_to_raid` | `to_identity` | Inserts a co-op raid invite (`create_invite(.., is_raid = true)`). Both: reject self / offline target / already-battling, require a fightable party, cap + de-dupe per (sender, target). |
| `accept_challenge` | `challenge_id` | Caller must be the invited; neither party already battling. **Raid** → builds a shared battle of both leads vs an AI boss; **PvP** → builds both full party sides into one shared battle. Clears both parties' invites. Atomic. |
| `decline_challenge` | `challenge_id` | Either party; deletes the challenge. |

## Key helpers (not reducers, but they carry the rules)

- `is_multiplayer(battle)` / `is_pvp(battle)` — `player != opponent` / `... && !is_raid`.
- `player_battle(ctx, id)` / `caller_battle(ctx)` — find a player's battle across **both** participant indexes (so a player in a battle as the opponent is correctly "in battle").
- `build_party_side` / `build_raid_battle` — assemble a `BattleSide` (or a raid) from live party rows.
- `record_pick` — the shared "record a private pick, return both once both have chosen" scaffold for PvP/raid.
- `persist_battle_hp` — write each side's post-turn HP back to its **own** owner's monster (re-checks ownership before writing).
- `apply_pvp_rating` — Elo update on a decisive PvP result; called once at the terminal transition.
- `reject_if_in_battle` / `reject_if_in_trade` — the two guards every monster-mutating reducer composes.
