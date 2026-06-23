//! The turn-based battle resolver — pure & deterministic. The server runs this authoritatively per
//! submitted action; battles are turn-based so the client never predicts, it animates the resolved
//! state. M7 readable core: ONE active monster per side (the rest bench), speed-ordered attacks,
//! auto-switch the next monster in when an active faints. Multi-active + team auras + status are the
//! deferred depth layer.
//!
//! `BattleState` and its parts derive `SpacetimeType` (under the feature) so the server stores the
//! whole battle as one column and the client reads it from its subscription to render.

use serde::{Deserialize, Serialize};

use super::damage::damage;
use super::model::{Category, Effectiveness, Skill, TypeChart};
use crate::monster::Affinity;

/// One combatant — a battle-scoped snapshot of a monster (the server builds it from a `monster` row;
/// `species_id` lets the client resolve the sprite/name from the `species` table).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleMonster {
    pub species_id: u32,
    pub level: u8,
    pub affinity: Affinity,
    pub attack: u16,
    pub defense: u16,
    pub special: u16,
    pub speed: u16,
    pub max_hp: u16,
    pub current_hp: u16,
}

impl BattleMonster {
    pub fn is_fainted(&self) -> bool {
        self.current_hp == 0
    }

    fn off_stat(&self, category: Category) -> u16 {
        match category {
            Category::Physical => self.attack,
            Category::Special => self.special,
        }
    }
}

/// One side's team + which member is currently active (index into `team`).
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleSide {
    pub team: Vec<BattleMonster>,
    pub active: u8,
}

impl BattleSide {
    pub fn new(team: Vec<BattleMonster>) -> Self {
        BattleSide { team, active: 0 }
    }

    pub fn active_ref(&self) -> &BattleMonster {
        &self.team[self.active as usize]
    }

    fn active_mut(&mut self) -> &mut BattleMonster {
        &mut self.team[self.active as usize]
    }

    pub fn is_defeated(&self) -> bool {
        self.team.iter().all(BattleMonster::is_fainted)
    }

    /// If the active monster has fainted, switch to the next non-fainted member (auto-switch).
    fn advance_if_fainted(&mut self) {
        if self.active_ref().is_fainted() {
            if let Some(next) = self.team.iter().position(|m| !m.is_fainted()) {
                self.active = next as u8;
            }
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum BattleOutcome {
    Ongoing,
    PlayerWon,
    PlayerLost,
    /// The player recruited the wild monster — a terminal, non-defeat success. `resolve_turn` never
    /// produces this; the server's taming reducer sets it when a recruit attempt succeeds (which is
    /// why it ends the battle without a victory/XP screen).
    Recruited,
}

/// The full authoritative battle state.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct BattleState {
    pub player: BattleSide,
    pub enemy: BattleSide,
    pub outcome: BattleOutcome,
    pub turn: u32,
}

impl BattleState {
    pub fn new(player: BattleSide, enemy: BattleSide) -> Self {
        BattleState {
            player,
            enemy,
            outcome: BattleOutcome::Ongoing,
            turn: 0,
        }
    }

    pub fn is_over(&self) -> bool {
        self.outcome != BattleOutcome::Ongoing
    }
}

/// An attack landed (for the battle log). `by_player` = the player's monster attacked.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct AttackEvent {
    pub by_player: bool,
    pub skill_id: u32,
    pub damage: u16,
    pub effectiveness: Effectiveness,
}

/// A monster fainted (for the battle log). `player_side` = it was the player's monster.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct FaintEvent {
    pub player_side: bool,
    pub species_id: u32,
}

/// The player swapped its active monster (for the battle log). `species_id` is the monster sent in.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub struct SwitchEvent {
    pub species_id: u32,
}

/// One thing that happened during a turn, in order — the client renders these into the battle log
/// (damage numbers, "X fainted!", a switch, a resisted recruit). Stored on the battle row.
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[cfg_attr(feature = "spacetimedb", derive(spacetimedb::SpacetimeType))]
pub enum BattleEvent {
    Attack(AttackEvent),
    Fainted(FaintEvent),
    /// The player switched its active monster (`resolve_player_swap` emits this first).
    Switched(SwitchEvent),
    /// A recruit attempt failed — the wild broke free (the server's taming reducer prepends this to
    /// the turn's events; `resolve_turn`/`resolve_enemy_turn` never emit it).
    RecruitFailed,
}

/// Apply `attacker`'s `skill` to `defender` (mutates the defender's HP). Returns the damage dealt and
/// the effectiveness (for the log). Pure (variance supplied).
fn apply_attack(
    attacker: &BattleMonster,
    defender: &mut BattleMonster,
    skill: &Skill,
    chart: &TypeChart,
    variance: u8,
) -> (u16, Effectiveness) {
    let eff = chart.effectiveness(skill.affinity, defender.affinity);
    let stab = skill.affinity == attacker.affinity;
    let dealt = damage(
        attacker.level,
        attacker.off_stat(skill.category),
        defender.defense,
        skill.power,
        eff,
        stab,
        variance,
    );
    defender.current_hp = defender.current_hp.saturating_sub(dealt);
    (dealt, eff)
}

/// Resolve one full turn: both sides' chosen skills, applied in speed order (player wins ties), then
/// auto-switch fainted actives and update the outcome. A side whose active faints before it acts
/// loses its action this turn (its replacement does not act until next turn). Returns the new state
/// and the ordered log events. No-op once the battle is over.
pub fn resolve_turn(
    state: &BattleState,
    player_skill: &Skill,
    enemy_skill: &Skill,
    chart: &TypeChart,
    player_variance: u8,
    enemy_variance: u8,
) -> (BattleState, Vec<BattleEvent>) {
    let mut next = state.clone();
    let mut events = Vec::new();
    if next.is_over() {
        return (next, events);
    }

    let player_first = next.player.active_ref().speed >= next.enemy.active_ref().speed;
    let order = if player_first {
        [true, false]
    } else {
        [false, true]
    };

    for is_player in order {
        if is_player {
            if next.player.active_ref().is_fainted() {
                continue; // fainted before acting → loses its action
            }
            let attacker = next.player.active_ref().clone();
            let (dmg, eff) = apply_attack(
                &attacker,
                next.enemy.active_mut(),
                player_skill,
                chart,
                player_variance,
            );
            events.push(BattleEvent::Attack(AttackEvent {
                by_player: true,
                skill_id: player_skill.id.0,
                damage: dmg,
                effectiveness: eff,
            }));
            if next.enemy.active_ref().is_fainted() {
                events.push(BattleEvent::Fainted(FaintEvent {
                    player_side: false,
                    species_id: next.enemy.active_ref().species_id,
                }));
            }
        } else {
            if next.enemy.active_ref().is_fainted() {
                continue;
            }
            let attacker = next.enemy.active_ref().clone();
            let (dmg, eff) = apply_attack(
                &attacker,
                next.player.active_mut(),
                enemy_skill,
                chart,
                enemy_variance,
            );
            events.push(BattleEvent::Attack(AttackEvent {
                by_player: false,
                skill_id: enemy_skill.id.0,
                damage: dmg,
                effectiveness: eff,
            }));
            if next.player.active_ref().is_fainted() {
                events.push(BattleEvent::Fainted(FaintEvent {
                    player_side: true,
                    species_id: next.player.active_ref().species_id,
                }));
            }
        }
    }

    finalize(&mut next);
    (next, events)
}

/// The enemy active attacks the player active (if it can), appending the attack + any faint event.
/// Shared by the player's non-attack turns (recruit attempt, switch) where only the wild gets to act.
fn enemy_acts(
    next: &mut BattleState,
    enemy_skill: &Skill,
    chart: &TypeChart,
    enemy_variance: u8,
    events: &mut Vec<BattleEvent>,
) {
    if next.enemy.active_ref().is_fainted() {
        return;
    }
    let attacker = next.enemy.active_ref().clone();
    let (dmg, eff) = apply_attack(
        &attacker,
        next.player.active_mut(),
        enemy_skill,
        chart,
        enemy_variance,
    );
    events.push(BattleEvent::Attack(AttackEvent {
        by_player: false,
        skill_id: enemy_skill.id.0,
        damage: dmg,
        effectiveness: eff,
    }));
    if next.player.active_ref().is_fainted() {
        events.push(BattleEvent::Fainted(FaintEvent {
            player_side: true,
            species_id: next.player.active_ref().species_id,
        }));
    }
}

/// Resolve a turn in which the player took a non-attack action (a recruit attempt or item) and so
/// forfeits its attack — only the enemy's active acts, then the usual auto-switch/outcome bookkeeping.
/// Lets a failed recruit cost the player a turn (the wild strikes back). No-op once the battle is over.
pub fn resolve_enemy_turn(
    state: &BattleState,
    enemy_skill: &Skill,
    chart: &TypeChart,
    enemy_variance: u8,
) -> (BattleState, Vec<BattleEvent>) {
    let mut next = state.clone();
    let mut events = Vec::new();
    if next.is_over() {
        return (next, events);
    }
    enemy_acts(&mut next, enemy_skill, chart, enemy_variance, &mut events);
    finalize(&mut next);
    (next, events)
}

/// Resolve a turn where the player swaps its active to team member `target` instead of attacking, so
/// the wild gets a free hit on the monster sent in (switching costs the turn). The caller (server)
/// validates `target` is in range, not the current active, and not fainted. No-op once over.
pub fn resolve_player_swap(
    state: &BattleState,
    target: u8,
    enemy_skill: &Skill,
    chart: &TypeChart,
    enemy_variance: u8,
) -> (BattleState, Vec<BattleEvent>) {
    let mut next = state.clone();
    let mut events = Vec::new();
    if next.is_over() {
        return (next, events);
    }
    next.player.active = target;
    events.push(BattleEvent::Switched(SwitchEvent {
        species_id: next.player.active_ref().species_id,
    }));
    enemy_acts(&mut next, enemy_skill, chart, enemy_variance, &mut events);
    finalize(&mut next);
    (next, events)
}

/// Shared turn epilogue: auto-switch fainted actives, update the outcome, advance the turn counter.
fn finalize(next: &mut BattleState) {
    next.player.advance_if_fainted();
    next.enemy.advance_if_fainted();
    next.outcome = if next.player.is_defeated() {
        BattleOutcome::PlayerLost
    } else if next.enemy.is_defeated() {
        BattleOutcome::PlayerWon
    } else {
        BattleOutcome::Ongoing
    };
    next.turn += 1;
}

/// Pick the index of the strongest of `skills` for `attacker` to use against `defender` (highest
/// effectiveness × power × STAB). Deterministic; `roll` only breaks exact ties. Used by the server's
/// enemy AI. Returns 0 for an empty list (callers ensure a monster has ≥1 skill).
pub fn pick_best_skill(
    attacker: &BattleMonster,
    defender: &BattleMonster,
    skills: &[Skill],
    chart: &TypeChart,
    roll: u32,
) -> usize {
    if skills.is_empty() {
        return 0;
    }
    let score = |s: &Skill| -> u32 {
        let eff = chart
            .effectiveness(s.affinity, defender.affinity)
            .multiplier_pct() as u32;
        let stab = if s.affinity == attacker.affinity {
            150
        } else {
            100
        };
        s.power as u32 * eff * stab
    };
    let best = skills.iter().map(score).max().unwrap_or(0);
    let tied: Vec<usize> = skills
        .iter()
        .enumerate()
        .filter(|(_, s)| score(s) == best)
        .map(|(i, _)| i)
        .collect();
    tied[roll as usize % tied.len()]
}

/// XP awarded to the victor for defeating a monster of `defeated_level`. Tuned against the `level³`
/// curve so early wins clearly advance a level (the level-(L+1) gap is `3L²+3L+1`): `L²+L+2` gives
/// ~2 wins/level early, tapering to ~3 later. A tuning knob, not a deep rule.
pub fn battle_xp_reward(defeated_level: u8) -> u32 {
    let l = defeated_level as u32;
    l * l + l + 2
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::combat::model::{Effectiveness, SkillId, TypeRelation};

    fn mon(speed: u16, hp: u16) -> BattleMonster {
        BattleMonster {
            species_id: 1,
            level: 25,
            affinity: Affinity::Neutral,
            attack: 60,
            defense: 50,
            special: 60,
            speed,
            max_hp: hp,
            current_hp: hp,
        }
    }

    fn tackle() -> Skill {
        Skill {
            id: SkillId(1),
            name: "Tackle".to_string(),
            affinity: Affinity::Neutral,
            category: Category::Physical,
            power: 40,
        }
    }

    fn empty_chart() -> TypeChart {
        TypeChart::default()
    }

    #[test]
    fn faster_side_strikes_first() {
        // Player much faster + a one-shot KO skill: enemy faints before it can act.
        let mut killer = tackle();
        killer.power = 9999;
        let state = BattleState::new(
            BattleSide::new(vec![mon(200, 100)]),
            BattleSide::new(vec![mon(10, 100)]),
        );
        let (next, events) = resolve_turn(&state, &killer, &tackle(), &empty_chart(), 15, 15);
        assert_eq!(next.outcome, BattleOutcome::PlayerWon);
        // The player took no damage — the enemy never acted.
        assert_eq!(next.player.active_ref().current_hp, 100);
        // Events: the player attacked and the enemy fainted; the enemy never got an attack event.
        assert!(matches!(
            events[0],
            BattleEvent::Attack(AttackEvent {
                by_player: true,
                ..
            })
        ));
        assert!(events.iter().any(|e| matches!(
            e,
            BattleEvent::Fainted(FaintEvent {
                player_side: false,
                ..
            })
        )));
        assert!(!events.iter().any(|e| matches!(
            e,
            BattleEvent::Attack(AttackEvent {
                by_player: false,
                ..
            })
        )));
    }

    #[test]
    fn both_act_and_lose_hp_when_neither_faints() {
        let state = BattleState::new(
            BattleSide::new(vec![mon(100, 200)]),
            BattleSide::new(vec![mon(90, 200)]),
        );
        let (next, _events) = resolve_turn(&state, &tackle(), &tackle(), &empty_chart(), 15, 15);
        assert_eq!(next.outcome, BattleOutcome::Ongoing);
        assert!(next.player.active_ref().current_hp < 200);
        assert!(next.enemy.active_ref().current_hp < 200);
        assert_eq!(next.turn, 1);
    }

    #[test]
    fn auto_switches_in_the_next_monster_on_faint() {
        let mut killer = tackle();
        killer.power = 9999;
        // Enemy has two monsters; the first is KO'd, the second steps in (battle continues).
        let state = BattleState::new(
            BattleSide::new(vec![mon(200, 100)]),
            BattleSide::new(vec![mon(10, 100), mon(10, 100)]),
        );
        let (next, _events) = resolve_turn(&state, &killer, &tackle(), &empty_chart(), 15, 15);
        assert_eq!(next.outcome, BattleOutcome::Ongoing);
        assert_eq!(next.enemy.active, 1, "second enemy monster is now active");
        assert!(next.enemy.team[0].is_fainted());
    }

    #[test]
    fn effectiveness_chart_is_applied() {
        // Fire skill, enemy is Nature → super effective. Compare HP loss vs a neutral chart.
        let mut fire = tackle();
        fire.affinity = Affinity::Fire;
        let mut enemy = mon(10, 500);
        enemy.affinity = Affinity::Nature;
        let chart = TypeChart {
            relations: vec![TypeRelation {
                attack: Affinity::Fire,
                defend: Affinity::Nature,
                effect: Effectiveness::SuperEffective,
            }],
        };
        let state = BattleState::new(
            BattleSide::new(vec![mon(200, 100)]),
            BattleSide::new(vec![enemy.clone()]),
        );
        let (strong, _) = resolve_turn(&state, &fire, &tackle(), &chart, 15, 15);
        let (weak, _) = resolve_turn(&state, &fire, &tackle(), &empty_chart(), 15, 15);
        assert!(
            strong.enemy.active_ref().current_hp < weak.enemy.active_ref().current_hp,
            "super-effective hit deals more"
        );
    }

    #[test]
    fn pick_best_skill_prefers_super_effective() {
        let attacker = mon(50, 100);
        let mut defender = mon(50, 100);
        defender.affinity = Affinity::Nature;
        let neutral = tackle();
        let mut fire = tackle();
        fire.id = SkillId(2);
        fire.affinity = Affinity::Fire;
        let chart = TypeChart {
            relations: vec![TypeRelation {
                attack: Affinity::Fire,
                defend: Affinity::Nature,
                effect: Effectiveness::SuperEffective,
            }],
        };
        let skills = vec![neutral, fire];
        assert_eq!(pick_best_skill(&attacker, &defender, &skills, &chart, 0), 1);
    }

    #[test]
    fn xp_reward_grows_with_level() {
        assert!(battle_xp_reward(30) > battle_xp_reward(10));
        assert!(battle_xp_reward(0) >= 1);
    }

    #[test]
    fn enemy_turn_only_the_enemy_acts() {
        // Player forfeits its attack (recruit attempt): the enemy hits, the player loses HP, the
        // enemy is untouched.
        let state = BattleState::new(
            BattleSide::new(vec![mon(100, 200)]),
            BattleSide::new(vec![mon(90, 200)]),
        );
        let (next, events) = resolve_enemy_turn(&state, &tackle(), &empty_chart(), 15);
        assert_eq!(next.enemy.active_ref().current_hp, 200, "enemy untouched");
        assert!(
            next.player.active_ref().current_hp < 200,
            "player took the hit"
        );
        assert_eq!(next.turn, 1);
        assert!(events.iter().all(|e| !matches!(
            e,
            BattleEvent::Attack(AttackEvent {
                by_player: true,
                ..
            })
        )));
    }

    #[test]
    fn player_swap_changes_active_and_lets_enemy_hit_the_new_monster() {
        // Two player monsters; start active=0, swap to index 1. The enemy then hits the new active.
        let state = BattleState::new(
            BattleSide::new(vec![mon(100, 200), mon(80, 200)]),
            BattleSide::new(vec![mon(90, 200)]),
        );
        let (next, events) = resolve_player_swap(&state, 1, &tackle(), &empty_chart(), 15);
        assert_eq!(
            next.player.active, 1,
            "active switched to the chosen member"
        );
        assert!(
            next.player.team[1].current_hp < 200,
            "the monster sent in took the wild's hit"
        );
        assert_eq!(
            next.player.team[0].current_hp, 200,
            "the benched monster is untouched"
        );
        // The log leads with the switch, then the enemy's attack.
        assert!(matches!(events[0], BattleEvent::Switched(_)));
        assert!(events.iter().any(|e| matches!(
            e,
            BattleEvent::Attack(AttackEvent {
                by_player: false,
                ..
            })
        )));
        assert_eq!(next.turn, 1);
    }

    #[test]
    fn player_swap_is_noop_when_over() {
        let mut state = BattleState::new(
            BattleSide::new(vec![mon(100, 200), mon(80, 200)]),
            BattleSide::new(vec![mon(90, 200)]),
        );
        state.outcome = BattleOutcome::PlayerWon;
        let (next, events) = resolve_player_swap(&state, 1, &tackle(), &empty_chart(), 15);
        assert_eq!(next, state);
        assert!(events.is_empty());
    }

    #[test]
    fn enemy_turn_is_noop_when_over() {
        let mut state = BattleState::new(
            BattleSide::new(vec![mon(100, 200)]),
            BattleSide::new(vec![mon(90, 200)]),
        );
        state.outcome = BattleOutcome::PlayerWon;
        let (next, events) = resolve_enemy_turn(&state, &tackle(), &empty_chart(), 15);
        assert_eq!(next, state);
        assert!(events.is_empty());
    }

    #[test]
    fn resolve_turn_is_deterministic() {
        let state = BattleState::new(
            BattleSide::new(vec![mon(100, 200)]),
            BattleSide::new(vec![mon(90, 200)]),
        );
        let a = resolve_turn(&state, &tackle(), &tackle(), &empty_chart(), 7, 9);
        let b = resolve_turn(&state, &tackle(), &tackle(), &empty_chart(), 7, 9);
        assert_eq!(a, b);
    }
}
