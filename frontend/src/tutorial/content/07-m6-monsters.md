# Milestone 6 — Monsters & Individuality

**Goal:** introduce the data model for monsters, where the emotional core of the game lives — **every
monster is a unique individual.** Author species as *data*, roll a one-of-a-kind starter for each
player on join, and store it server-side with row-level privacy.

**Where it fits:** the POC (M0–M5) is done. This is the first "game systems" milestone, and it
establishes patterns every later system reuses: the **content pipeline**, the **individuality schema**,
and **owner-scoped data**.

## Content is data, not code

A monster *species* (Sproutling, Embercub) is a template: base stats, an elemental affinity, a
learnset, evolution branches. We author all of that as **RON** files (Rusty Object Notation — like
JSON, but it speaks Rust's structs and enums natively), embedded into the binary at compile time and
parsed by a pure `game-core` function.

Here's a slice of `game-core/content/species.ron`:

```ron
[
    (
        id: 1,
        name: "Sproutling",
        base: (hp: 45, attack: 49, defense: 49, special: 65, speed: 45),
        primary_affinity: Nature,
        secondary_affinity: None,
        sprite_id: 0,
        skills: [1, 2],
        recruit_rate: 400,
        // A default form, plus a high-bond branch (raise its bond via care to unlock Spiritbloom).
        evolutions: [
            (to: 5, min_level: 2, min_bond: 0),
            (to: 6, min_level: 2, min_bond: 120),
        ],
    ),
    // ...more species...
]
```

The loader embeds and parses it, and — crucially — **validates** it:

```rust
const SPECIES_RON: &str = include_str!("../../content/species.ron");

pub fn load_species() -> Result<Vec<Species>, String> {
    let species: Vec<Species> =
        ron::from_str(SPECIES_RON).map_err(|e| format!("species.ron parse error: {e}"))?;
    if species.is_empty() {
        return Err("species.ron contains no species".to_string());
    }
    // ...check for duplicate ids, sane recruit rates...
    Ok(species)
}
```

`include_str!` bakes the file's text into the binary at compile time, so there's **no runtime file
I/O** — which keeps `game-core` pure (remember the determinism guard). A separate `validate_content`
function cross-checks integrity: every skill a species lists must exist, every evolution must target a
real, different species, and so on. This runs as a unit test, so **shipping a dangling reference fails
the build** rather than surfacing as a crash mid-battle. Content bugs become compile-time-ish bugs.

### The "table is the cache" pattern

At `init`, the server reads the parsed content once and seeds it into public, read-only tables:

```rust
let species = load_species().expect("embedded species content must be valid");
for s in species {
    ctx.db.species().insert(Species { species_id: s.id.0, name: s.name, base: s.base, /* ... */ });
}
```

From then on, **reducers read species data from the table, never re-parse the RON.** The table *is*
the runtime cache. And because the `species` table is `public`, the client reads species data straight
from its subscription — so monster names, base stats, and learnsets are never duplicated in
TypeScript. One source of content, consumed everywhere.

## What makes a monster an individual

A species is shared. An *instance* — your particular Sproutling — carries hidden, rolled
individuality. The `monster` table:

```rust
#[spacetimedb::table(name = monster, public)]
pub struct Monster {
    #[primary_key]
    #[auto_inc]
    pub monster_id: u64,
    #[index(btree)]
    pub owner_identity: Identity,
    pub species_id: u32,
    pub nickname: String,
    pub level: u8,
    pub xp: u32,
    pub potential: Potential,    // per-stat "genes"
    pub temperament: Temperament, // a nature that nudges a stat pair
    pub training: Training,       // where you've focused growth (M9)
    pub bond: u16,                // grows with care (M9)
    pub current_hp: u16,          // persists between battles (M7)
    pub derived: StatBlock,       // server-computed final stats
    pub party_slot: Option<u8>,
    // ...
}
```

Two monsters of the same species differ in **potential** (per-stat genes rolled at birth),
**temperament** (a nature), and — later — how you raised them. The genes are rolled by a pure
`game-core` function that takes a *random-number source as an argument* (never its own RNG — the
determinism guard again):

```rust
pub fn roll_individuality(next_u32: &mut dyn FnMut() -> u32) -> (Potential, Temperament) {
    let gene = |n: &mut dyn FnMut() -> u32| (n() % (Potential::MAX as u32 + 1)) as u8;
    let potential = Potential {
        hp: gene(next_u32),
        attack: gene(next_u32),
        defense: gene(next_u32),
        special: gene(next_u32),
        speed: gene(next_u32),
    };
    let temperament = Temperament::ALL[(next_u32() as usize) % Temperament::ALL.len()];
    (potential, temperament)
}
```

Each gene is a number from `0` to `Potential::MAX` (31, IV-style), and the temperament is one of a
fixed set of natures. The randomness is *consumed in a fixed order* (five genes, then temperament), so
for a given sequence of numbers the result is fully determined — testable and reproducible. The server
feeds it `ctx.rng()`; a test feeds it a fixed sequence.

### Stats are derived on the server, read on the client

Final stats come from a pure formula, `derive_stats(species, potential, training, temperament, level)`.
It's a classic integer formula (no floats, so it's deterministic) — for each stat:

```rust
let common = (2 * base + iv + ev / 4) * lvl / 100;
let value = if stat == Stat::Hp {
    common + lvl + 10          // HP gets a flat bonus and is never nature-affected
} else {
    let raw = common + 5;
    if up == Some(stat) { raw * 11 / 10 }      // the nature's raised stat: +10%
    else if down == Some(stat) { raw * 9 / 10 } // its lowered stat: −10%
    else { raw }
};
```

`base` is the species template, `iv` the gene, `ev` the training investment, and the temperament nudges
one stat up 10% and another down 10%. The **server computes this and stores it** in the monster's
`derived` column; the client just reads `derived` and renders a stat bar. The formula lives once, in
`game-core`, and never runs in TypeScript — so the client can't be tricked into showing (or claiming)
wrong stats. And because it's the same pure, deterministic style as everything else, training the same
monster always yields the same numbers.

## Rolling a starter on join

On a player's *first ever* join, the server grants one randomly-rolled starter:

```rust
fn grant_starter(ctx: &ReducerContext, owner: Identity) {
    if ctx.db.monster().owner_identity().filter(owner).count() > 0 {
        return; // already has monsters — returning player keeps them
    }
    // Starters are BASE forms only — never an evolution target or fusion offspring.
    // ...filter those out of the candidate list (derived from content, not hard-coded)...
    let pick = /* a random base species */;
    let inst = roll_starter(&core, &mut || ctx.random::<u32>());
    ctx.db.monster().insert(monster_row(owner, &core, &inst, Some(0)));
}
```

Two nice touches: it self-guards on the *permanent* monster set (so a returning player isn't re-granted
a starter), and the "base forms only" rule is **derived from content** — it computes which species are
evolution/fusion targets and excludes them, rather than hard-coding "ids 1–4." Add a new base species
to the RON and it's automatically a possible starter; add an evolved form and it's automatically
excluded.

## Owner-scoped privacy: the third visibility mode

Your monster's genes and stats must be visible to **you** but hidden from rivals (who'd love to scout
your team). The `monster` table is `public` (the SDK needs it to be), but a **row-level security
filter** scopes which rows each client actually receives:

```rust
#[client_visibility_filter]
const MONSTER_VISIBILITY: Filter =
    Filter::Sql("SELECT * FROM monster WHERE owner_identity = :sender");
```

`:sender` is the subscribing client's identity. The result: a client's subscription only ever contains
*its own* monster rows — the hidden individuality never goes out on the wire to anyone else. This is the
third visibility mode, completing the set:

| Mode | Example | Who sees it |
|---|---|---|
| `public` | `character`, `species` | everyone |
| private (no `public`) | `encounter` | only the server |
| `public` + RLS filter | `monster`, `battle`, `player_item` (items arrive in M8) | only the owner |

## Common pitfalls

- **Duplicating content in TypeScript.** The moment the client hard-codes a species' base stats, you
  have two sources of truth. Read content from the subscription instead.
- **Re-parsing RON in a reducer.** Parse once at `init`; read the table after. (Reducers can re-execute
  on conflict — re-parsing each call is wasted work, and tempts you toward a forbidden module global.)
- **Trusting client-sent stats.** The client reads `derived`; it never computes or sends it. Re-derive
  on the server on every change.
- **Forgetting the RLS filter on a table with hidden data.** A `public` `monster` table *without* the
  filter would broadcast everyone's genes to everyone. The filter is not optional.
- **Hard-coding "which species can be starters."** Derive it from the content so new content
  classifies itself.

## Alternatives & the honest verdict

- **Hard-coding species as Rust `const`s** instead of RON. Slightly faster, no parser. But it mixes
  content with code, so a designer can't tweak balance without touching Rust, and you lose the clean
  data/logic split every later system leans on. **Verdict: data-driven content is the right backbone
  here** — this is one of the project's Tier-1 principles for good reason.
- **JSON instead of RON.** JSON is universally understood; RON is Rust-flavored. For a Rust project,
  RON's native enums/structs (no string-typing of `primary_affinity: Nature`) are more ergonomic and
  less error-prone. **Verdict: RON is the better fit here, but JSON would be a perfectly reasonable
  choice** — especially if non-Rust tooling needed to read the content too. A fair toss-up.
- **A real database table editor / CMS for content.** Overkill for a fixed content set. **Verdict:
  YAGNI — plain RON files + a validation test until authoring actually hurts.**

## Checkpoint

Publish and `generate`. Join as a new identity and `spacetime sql` shows exactly one `monster` owned
by you, with plausibly-rolled `potential` and a `temperament`. Join as a *second* identity and confirm
(via the subscription / introspection hook) that you do **not** receive the first player's monster
rows — the RLS filter is working. In the box UI, your starter appears with its unique stat spread.
You've laid the individuality foundation. Now let's make those monsters fight.
