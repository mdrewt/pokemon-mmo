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

const SPECIES_RON: &str = include_str!("../../content/species.ron");
const SKILLS_RON: &str = include_str!("../../content/skills.ron");
const AFFINITY_CHART_RON: &str = include_str!("../../content/affinity_chart.ron");

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
    }
    Ok(species)
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
    let ids: BTreeSet<u32> = skills.iter().map(|s| s.id.0).collect();
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
}
