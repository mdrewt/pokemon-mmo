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

use crate::monster::Species;

const SPECIES_RON: &str = include_str!("../../content/species.ron");

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
}
