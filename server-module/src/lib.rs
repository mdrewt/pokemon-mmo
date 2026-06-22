//! SpacetimeDB server module (authoritative game state).
//!
//! M0 freezes the *contract* (tables + reducer signatures) in ARCHITECTURE.md; the actual
//! `#[table]`/`#[reducer]` implementations land in **M2**, written against SpacetimeDB 2.6 syntax
//! confirmed via the `gitmcp-spacetimedb` docs and reviewed by the `reducer-security-auditor`
//! subagent. Keeping the guessable macro details out of M0 honors the CLAUDE.md rule: confirm
//! the API before writing server code.
//!
//! Frozen contract to implement in M2 (see ARCHITECTURE.md for fields & validation):
//!
//! Tables (all `public` unless noted):
//! - `character`: entity_id (pk, auto_inc), map_id, tile_x, tile_y, facing, action, move_started_at, sprite_id
//! - `player`: identity (pk), entity_id, name, online, last_input_seq
//! - `npc`: entity_id (pk), home_x, home_y, wander_radius, next_move_at
//! - `config`: id (pk), map_id, world params (singleton)
//! - `npc_tick_schedule`: scheduled(npc_tick) interval table
//!
//! Reducers (thin: lookup → game_core::{resolve_input, npc_decide} → write; ZERO game logic):
//! - `init`: seed config, spawn NPC, schedule npc_tick
//! - `client_connected`: presence
//! - `client_disconnected`: despawn the sender's character + player rows
//! - `join_game(name)`: validate name; spawn at random walkable tile; link identity
//! - `submit_input(input, seq)`: authoritative move via game_core::resolve_input
//! - `npc_tick`: scheduled; GUARD ctx.sender == ctx.identity()
//!
//! Security invariants (auditor-enforced): identity only from `ctx.sender`; outcomes computed
//! server-side from intent; full re-validation vs authoritative state; reject (`Err`), never
//! silently clamp; scheduler guarded by module identity; secrets in private tables later.
