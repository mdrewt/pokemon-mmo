# Data model — SpacetimeDB schema reference

The complete table-by-table reference for the `server-module` schema. Source of truth:
[`server-module/src/lib.rs`](../server-module/src/lib.rs) (the `#[spacetimedb::table]` definitions) and
the generated TS bindings in `frontend/src/module_bindings/`. For the conceptual overview and the
entity/component rationale, see [ARCHITECTURE.md](../ARCHITECTURE.md#data-model-spacetimedb-tables).

## Conventions

- **Reducers are the only writers.** Clients never write tables directly — they call reducers, which
  validate and write. (See [reducers.md](reducers.md).)
- **`public` vs private.** A `public` table is replicated to subscribed clients; a private table
  (no `public`) is server-only. Several `public` tables additionally carry a
  `#[client_visibility_filter]` (**Row-Level Security**) that scopes which *rows* a client sees — so a
  table can be `public` for the SDK yet effectively private per-row. RLS is an experimental SpacetimeDB
  2.6 feature.
- **Time columns** are `i64` milliseconds since the unix epoch (`*_ms`), to round-trip with
  `game_core::Millis`. Negative values can't occur in practice (the server clamps).
- **Identity** is SpacetimeDB's per-connection `Identity`, set by the framework — never a client field.

There are **18 tables**. RLS filters exist on six of them.

---

## World & movement

| Table | Vis | PK | Indexes | Purpose |
|---|---|---|---|---|
| `character` | public | `entity_id: u64` (auto_inc) | — | One renderable entity (player **or** NPC): `map_id`, `tile_x`/`tile_y`, `facing`, `action`, `move_started_at_ms`, `sprite_id`, and a bounded FIFO `move_queue: Vec<MoveInput>` (drained one per tick). All clients subscribe to render everyone. No RLS. |
| `player` | public | `identity` | `entity_id` | Links a connection's `Identity` to its character. `name`, `online`, `last_input_seq` (the reconciliation ack — **never** trusted for authority). **Ephemeral**: deleted on disconnect. |
| `npc` | public | `entity_id` | — | Server-controlled wander state: `home_x`/`home_y`, `wander_radius`, `next_move_at_ms`. |
| `config` | public | `id: u32` (singleton) | — | World config (`map_id`). Seeded at `init`. |
| `movement_tick_schedule` | scheduled | `id: u64` (auto_inc) | — | Scheduler row (`scheduled(movement_tick)`); an `Interval(STEP_MS)` row drives the movement loop. |

## Persistent player identity

| Table | Vis | PK | Indexes | Purpose |
|---|---|---|---|---|
| `profile` | public | `identity` | — | A **persistent** ranked profile: `name`, `rating: i32` (Elo, starts at 1000), `wins: u32`, `losses: u32`. Unlike `player`, it is **never deleted** — a rating survives disconnects. Created/refreshed on join; updated when a ranked (PvP) battle ends. World-readable (the leaderboard). |

> Why two tables? `player` is *presence* (deleted on disconnect); `profile` is *persistent identity*.
> A `monster` likewise persists by `owner_identity`. Anything that must outlive a session keys on
> `identity` and is never deleted.

## Content (seeded at `init` from the `game-core` RON registry; read-only to clients)

| Table | Vis | PK | Indexes | Purpose |
|---|---|---|---|---|
| `species` | public | `species_id: u32` | — | Species template (mirrors `game_core::Species`): `name`, `base: StatBlock`, `primary`/`secondary_affinity`, `sprite_id`, `skills: Vec<u32>` (learnset), `recruit_rate: u16`, `evolutions: Vec<Evolution>`. |
| `skill` | public | `skill_id: u32` | — | Skill template: `name`, `affinity`, `category`, `power`. |
| `type_relation` | public | `id: u64` (auto_inc) | — | The affinity chart as rows (`attack`, `defend`, `effect`). Any unlisted pair is Neutral. The client shows effectiveness hints from this data — not a duplicated rule. |
| `item` | public | `item_id: u32` | — | Item template: `name`, `recruit_bonus: u16` (bait), `train_stat: Option<Stat>` + `train_amount: u16` (food). `is_food()` = `train_stat.is_some()`. |
| `fusion` | public | `id: u64` (auto_inc) | — | Fusion recipe: `a`, `b`, `to` (species ids; fusing `a + b` is order-independent → `to`). |
| `encounter` | **private** | `id: u64` (auto_inc) | `zone_id` | Per-zone weighted wild spawn-table row: `species_id`, `weight`, `min_level`, `max_level`. The client never needs it; the server reads it on a grass step (the table *is* the runtime cache — no per-tick RON re-parse). |

## Player-owned state (public, RLS-scoped to the owner)

| Table | Vis | PK | Indexes | RLS | Purpose |
|---|---|---|---|---|---|
| `monster` | public | `monster_id: u64` (auto_inc) | `owner_identity` | `owner_identity = :sender` | An owned individual: `species_id`, `nickname`, `level`/`xp`/`xp_floor`/`xp_next`, `potential` (genes), `temperament`, `training`, `bond`, `current_hp` (**persists between battles**), server-derived `derived: StatBlock`, `party_slot: Option<u8>`, `last_care_at_ms`, `evolves_to: Vec<u32>` (server-computed). RLS keeps hidden genes/stats/HP off other clients' wire. |
| `player_item` | public | `id: u64` (auto_inc) | `owner_identity` | `owner_identity = :sender` | An owned item stack: `owner_identity`, `item_id`, `quantity`. **One row per (owner, item)** — the single-stack invariant the spend logic relies on. |

## Battle & multiplayer

| Table | Vis | PK | Indexes | RLS | Purpose |
|---|---|---|---|---|---|
| `battle` | public | `battle_id: u64` (auto_inc) | `player_identity`, `opponent_identity` | `player_identity = :sender OR opponent_identity = :sender` | One active battle, holding the whole `BattleState` plus `enemy_level`, `party_monster_ids`/`opponent_monster_ids` (per-side HP write-back), `is_raid: bool`, `wild_potential`/`wild_temperament` (recruit rebuild, PvE only), `last_events`, `last_xp_gain`, `leveled_up`. See **[battle modes](#battle-modes)** below. |
| `battle_challenge` | public | `id: u64` (auto_inc) | `from_identity`, `to_identity` | `from_identity = :sender OR to_identity = :sender` | A pending PvP challenge (`is_raid = false`) or co-op raid invite (`is_raid = true`), with `created_at_ms`. Accepting builds a shared `battle`; declining/disconnecting deletes it. |
| `battle_action` | public | `id: u64` (auto_inc) | `battle_id` | `chooser_identity = :sender` | A player's chosen-but-unresolved skill for a both-submit (PvP/raid) turn: `battle_id`, `chooser_identity`, `skill_id`. **RLS hides it from the opponent** so picks are simultaneous and secret; the server (reads bypass RLS) reads both and resolves once both have chosen, then deletes them. |
| `trade_offer` | public | `id: u64` (auto_inc) | `from_identity`, `to_identity` | `from_identity = :sender OR to_identity = :sender` | A directed, dual-consent monster trade: `from_card`/`to_card: Option<MonsterCard>` (display-only snapshots), `status: TradeStatus` (`AwaitingRecipient` → `AwaitingInitiator`), `created_at_ms`. The offered monster is **escrowed** — its lock lives in this row, and monster-mutating reducers reject a monster that appears here. |

### Battle modes

The single `battle` table serves three modes, distinguished by the two participant columns and `is_raid`
(server helpers `is_multiplayer` / `is_pvp`):

| Mode | `opponent_identity` | `is_raid` | `state.player` / `state.enemy` |
|---|---|---|---|
| **PvE** (wild) | `== player_identity` (self-sentinel) | `false` | your party / an AI wild |
| **PvP** | `!= player_identity` (the foe) | `false` | challenger's party / accepter's party |
| **Raid** | `!= player_identity` (the **ally**) | `true` | both allies' leads (`[0]`=challenger, `[1]`=accepter) / an AI boss |

So `is_multiplayer = player_identity != opponent_identity` (PvP or raid) and
`is_pvp = is_multiplayer && !is_raid`. PvP/raid turns resolve only when both `battle_action` rows exist.
Ranked rating is applied only for `is_pvp`.

### Non-table column types

- **`MonsterCard`** (`#[derive(SpacetimeType)]`) — a trade-display snapshot embedded in `trade_offer`
  (`monster_id`, `species_id`, `nickname`, `level`, `derived`, `potential`, `temperament`, `bond`). Lets
  a counterparty see the offered monster *without* relaxing the per-owner `monster` RLS; the swap always
  re-reads the live monster row.
- **`TradeStatus`** — `AwaitingRecipient` | `AwaitingInitiator`.
- Game-core domain types (`Direction`, `ActionState`, `MoveInput`, `StatBlock`, `Affinity`,
  `Temperament`, `Potential`, `Training`, `BattleState`, `BattleEvent`, `Evolution`, …) derive
  `SpacetimeType` only under `game-core`'s `spacetimedb` feature; the server stores them as columns and
  `spacetime generate` produces the TS bindings, so cross-boundary shapes are never hand-written twice.

## RLS summary

Six tables scope rows per-client:

| Table | Visible to |
|---|---|
| `monster`, `player_item` | the owner |
| `battle` | the two participants |
| `battle_challenge`, `trade_offer` | the two parties |
| `battle_action` | only the chooser (the opponent can't peek at a pending pick) |

`encounter` is the only fully private (non-`public`) table. Everything else is world-readable.
