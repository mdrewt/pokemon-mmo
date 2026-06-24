# Engineering principles

> Principles are tools, not laws. They are **tiered**, and some are deliberately
> **inverted** or excluded per project. Knowing which to apply — and which to NOT
> apply — matters as much as applying them. Don't cargo-cult "all best practices";
> several conflict. Each project declares its own tiers/inversions in its
> `AGENTS.md` (or `ARCHITECTURE.md`) with one-line rationale, and records
> non-obvious calls as ADRs.

## Tier 1 — non-negotiable (default everywhere)
- **Single source of truth (SSOT).**
- **Separation of concerns** — functional core / imperative shell wherever real IO exists.
- **Make illegal states unrepresentable** / parse-don't-validate; validate at boundaries.
- **Lightweight design-by-contract** — pre/postconditions on critical functions.
- **Errors are values; fail loud, fail early.**
- **Mechanical enforcement over discipline** — wire a check; never rely on remembering.
- **DRY — but NOT across marshaling/serialization boundaries.** Duplicated data
  *shapes* across a Rust↔TS or service boundary are often correct; coupling them is worse.
- **YAGNI with named exceptions** — state the exceptions explicitly so they aren't
  "simplified" away later.

## Tier 2 — apply with judgment
- **SOLID where it fits** (evolving services/libraries); skip for thin scripts. Note
  OCP can fight exhaustive enums — sometimes you *want* the compiler to flag every
  match site instead of an open extension point.
- **Defensive programming at trust boundaries only** — not inside pure core code.
- **Data-driven content** — things that vary (config, content, maps) are data, not code.
- **Design patterns** only when the problem matches the named pattern.
- **KISS / least astonishment / fail-fast.**
- **TDD for the core**; behavior-focused tests over implementation-coupled tests.

## Commonly inverted / unsuitable — decide per project, document the call
- **Postel's Law is often INVERTED** at security/finance boundaries: be *strict* —
  reject out-of-contract input, don't clamp silently.
- **Full SOLID** is usually cherry-picked; don't add interfaces for one implementation.
- **Heavyweight BDD/contract frameworks / uniform-access**: keep the principle, skip
  the tooling (YAGNI).

## Declaring tiers & inversions per project
A project's `AGENTS.md` lists any Tier-1 promotions, Tier-2 demotions, and inverted
principles, each with one line of rationale. Non-obvious or contested calls get an ADR.

## Mechanical enforcement map (principle → enforcer)
Wire each rule to a tool so it never depends on someone remembering:

| Concern | Enforced by |
|---------|-------------|
| Format / lint / style | formatter + linter in `just lint` (pre-commit via lefthook) |
| Types / illegal states | compiler / `tsc` / mypy + contracts (`contracts.md`) |
| Architecture invariants | the eval harness (`evals.md`) |
| Determinism | seedable RNG / injected clocks + determinism evals |
| Secrets / SAST / deps | gitleaks + Semgrep + SCA in CI (`security.md`) |
| Over-engineering / DRY / YAGNI | `/simplify` + the `reviewer` |
| Correctness / smells | `/review` + tests + mutation testing |
| Blast radius of shared changes | impact analysis before edit (below) |

**Every task's definition-of-done includes a `/simplify` and a `/review` pass.**

## Impact analysis before changing shared signatures
Before changing a signature/type used across a boundary or by multiple modules,
identify and report the affected callers/tests **first**, not after. For larger
codebases a **code-knowledge-graph MCP** (AST + type resolution) answers
"what-calls-X / what-depends-on-X" far more cheaply than grepping or reading
files — prefer it for structural questions and load it lazily. A missed caller
across a marshaling boundary is how client/server or producer/consumer contracts
silently desync.

## Red flags the reviewer enforces
- Premature abstraction; speculative generality.
- Duplicated *sources of truth* (≠ duplicated shapes across a boundary, which is fine).
- Public surface larger than the spec requires.
- Comments that restate code instead of explaining *why*.
