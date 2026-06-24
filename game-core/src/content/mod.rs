//! Data-driven content: game content (species, and later skills/encounters/evolution) is authored
//! in RON files under `game-core/content/`, embedded at build time with `include_str!`, and parsed
//! here into typed registries. This keeps `game-core` pure (no runtime file I/O) while letting
//! content live as data rather than Rust literals.
//!
//! The server calls [`load_species`] ONCE at init to seed the public `species` table; reducers then
//! read content from that table (the table is the cache — never re-parse per call). The integrity
//! test below guarantees the shipped content parses and is well-formed, so the runtime parse can't
//! fail in practice.

use std::collections::BTreeSet;

use crate::combat::{Skill, TypeChart};
use crate::monster::Species;
use crate::taming::{EncounterTable, Item};

const SPECIES_RON: &str = include_str!("../../content/species.ron");
const SKILLS_RON: &str = include_str!("../../content/skills.ron");
const AFFINITY_CHART_RON: &str = include_str!("../../content/affinity_chart.ron");
const ENCOUNTERS_RON: &str = include_str!("../../content/encounters.ron");
const ITEMS_RON: &str = include_str!("../../content/items.ron");

/// Parse + validate the embedded species content. Returns an error string on malformed RON or a
/// content-integrity violation (empty, duplicate ids).
pub fn load_species() -> Result<Vec<Species>, String> {
    let species: Vec<Species> =
        ron::from_str(SPECIES_RON).map_err(|e| format!("species.ron parse error: {e}"))?;

    if species.is_empty() {
        return Err("species.ron contains no species".to_string());
    }
    let mut seen = BTreeSet::new();
    for s in &species {
        if !seen.insert(s.id.0) {
            return Err(format!("duplicate species id {}", s.id.0));
        }
        if s.recruit_rate > 1000 {
            return Err(format!(
                "species {} recruit_rate {} exceeds 1000 permille",
                s.id.0, s.recruit_rate
            ));
        }
    }
    Ok(species)
}

/// Parse + validate the embedded wild-encounter table (non-empty, sane weights + level ranges).
/// Species-reference integrity is checked by [`validate_content`] (it needs the species list).
pub fn load_encounters() -> Result<EncounterTable, String> {
    let table: EncounterTable =
        ron::from_str(ENCOUNTERS_RON).map_err(|e| format!("encounters.ron parse error: {e}"))?;
    if table.entries.is_empty() {
        return Err("encounters.ron contains no entries".to_string());
    }
    for e in &table.entries {
        if e.weight == 0 {
            return Err(format!(
                "encounter for species {} has zero weight",
                e.species_id
            ));
        }
        if e.min_level == 0 || e.min_level > e.max_level {
            return Err(format!(
                "encounter for species {} has an invalid level range {}..={}",
                e.species_id, e.min_level, e.max_level
            ));
        }
    }
    Ok(table)
}

/// Parse + validate the embedded skill content (unique ids, non-empty).
pub fn load_skills() -> Result<Vec<Skill>, String> {
    let skills: Vec<Skill> =
        ron::from_str(SKILLS_RON).map_err(|e| format!("skills.ron parse error: {e}"))?;
    if skills.is_empty() {
        return Err("skills.ron contains no skills".to_string());
    }
    let mut seen = BTreeSet::new();
    for s in &skills {
        if !seen.insert(s.id.0) {
            return Err(format!("duplicate skill id {}", s.id.0));
        }
    }
    Ok(skills)
}

/// Parse + validate the embedded item content (unique ids, non-empty).
pub fn load_items() -> Result<Vec<Item>, String> {
    let items: Vec<Item> =
        ron::from_str(ITEMS_RON).map_err(|e| format!("items.ron parse error: {e}"))?;
    if items.is_empty() {
        return Err("items.ron contains no items".to_string());
    }
    let mut seen = BTreeSet::new();
    for i in &items {
        if !seen.insert(i.id) {
            return Err(format!("duplicate item id {}", i.id));
        }
        // A training food must grant a positive amount, or using it would be a no-op.
        if i.is_food() && i.train_amount == 0 {
            return Err(format!("food item {} has zero train_amount", i.id));
        }
    }
    Ok(items)
}

/// Parse the embedded type/affinity chart.
pub fn load_type_chart() -> Result<TypeChart, String> {
    ron::from_str(AFFINITY_CHART_RON).map_err(|e| format!("affinity_chart.ron parse error: {e}"))
}

/// Validate that every species learnset references a skill that exists (call once in tests / at
/// init). Keeps the content honest — a dangling skill id would otherwise surface only mid-battle.
pub fn validate_content() -> Result<(), String> {
    let species = load_species()?;
    let skills = load_skills()?;
    load_type_chart()?;
    load_items()?;
    let ids: BTreeSet<u32> = skills.iter().map(|s| s.id.0).collect();
    let species_ids: BTreeSet<u32> = species.iter().map(|s| s.id.0).collect();
    for sp in &species {
        if sp.skills.is_empty() {
            return Err(format!("species {} has no skills", sp.id.0));
        }
        for skill in &sp.skills {
            if !ids.contains(&skill.0) {
                return Err(format!(
                    "species {} references unknown skill id {}",
                    sp.id.0, skill.0
                ));
            }
        }
        // Every evolution must target a real, different species (a dangling/self evolution would
        // either crash an evolve or loop a monster onto itself).
        for evo in &sp.evolutions {
            if evo.to == sp.id.0 {
                return Err(format!("species {} evolves into itself", sp.id.0));
            }
            if !species_ids.contains(&evo.to) {
                return Err(format!(
                    "species {} evolves into unknown species id {}",
                    sp.id.0, evo.to
                ));
            }
        }
    }
    // Every encounter must reference a real species, or a wild roll would hit a missing template.
    for e in &load_encounters()?.entries {
        if !species_ids.contains(&e.species_id) {
            return Err(format!(
                "encounter references unknown species id {}",
                e.species_id
            ));
        }
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn embedded_species_content_is_valid() {
        let species = load_species().expect("embedded species.ron must parse + validate");
        assert!(species.len() >= 4, "expected the starter species set");
        // ids are unique (load_species enforces) and stat blocks are non-zero.
        for s in &species {
            assert!(!s.name.is_empty(), "species {} has no name", s.id.0);
            assert!(s.base.hp > 0, "species {} has zero HP base", s.id.0);
        }
        // a known species round-trips with the expected affinity.
        let sproutling = species
            .iter()
            .find(|s| s.id.0 == 1)
            .expect("Sproutling (id 1) present");
        assert_eq!(sproutling.name, "Sproutling");
        assert_eq!(
            sproutling.primary_affinity,
            crate::monster::Affinity::Nature
        );
    }

    #[test]
    fn embedded_skills_and_chart_parse() {
        let skills = load_skills().expect("skills.ron must parse");
        assert!(skills.iter().any(|s| s.name == "Tackle"));
        let chart = load_type_chart().expect("affinity_chart.ron must parse");
        use crate::combat::Effectiveness;
        use crate::monster::Affinity;
        assert_eq!(
            chart.effectiveness(Affinity::Fire, Affinity::Nature),
            Effectiveness::SuperEffective
        );
        // an unlisted pair is neutral.
        assert_eq!(
            chart.effectiveness(Affinity::Neutral, Affinity::Neutral),
            Effectiveness::Neutral
        );
    }

    #[test]
    fn content_cross_references_are_valid() {
        validate_content().expect("every species learnset must reference real skills");
    }

    #[test]
    fn embedded_species_have_valid_evolutions() {
        let species = load_species().expect("species.ron parses");
        // The base starters (1-4) each evolve into something; validate_content already checked the
        // targets exist + aren't self-references.
        for id in [1u32, 2, 3, 4] {
            let sp = species.iter().find(|s| s.id.0 == id).unwrap();
            assert!(!sp.evolutions.is_empty(), "base species {id} should evolve");
        }
        // Evolved forms (5-9) are final.
        let verdanthorn = species.iter().find(|s| s.id.0 == 5).unwrap();
        assert!(verdanthorn.evolutions.is_empty(), "evolved form is final");
    }

    #[test]
    fn embedded_items_include_bait_and_food() {
        let items = load_items().expect("items.ron must parse + validate");
        // Recruit bait (id 1) is not food; it has a recruit bonus.
        let lure = items.iter().find(|i| i.id == 1).expect("Lure present");
        assert!(!lure.is_food());
        assert!(lure.recruit_bonus > 0);
        // There is at least one training food per stat-ish; each has a positive amount + a target.
        use crate::monster::Stat;
        let food: Vec<_> = items.iter().filter(|i| i.is_food()).collect();
        assert!(food.len() >= 5, "a food per stat");
        for f in &food {
            assert!(f.train_amount > 0);
        }
        assert!(
            food.iter().any(|f| f.train_stat == Some(Stat::Attack)),
            "an Attack food exists"
        );
    }

    #[test]
    fn embedded_encounters_parse_and_resolve() {
        let table = load_encounters().expect("encounters.ron must parse + validate");
        assert!(!table.entries.is_empty());
        // A roll yields a species that exists in the species registry.
        let species = load_species().unwrap();
        let (sp, lvl) = table
            .roll_encounter(0, 0)
            .expect("non-empty table rolls a wild");
        assert!(species.iter().any(|s| s.id == sp), "wild species exists");
        assert!(lvl.0 >= 1, "wild level is in range");
    }
}
