# Contracts & design-by-contract

Push correctness into types and validated boundaries so illegal states are hard
to represent and violations fail loudly.

## Per-language idioms
- **Rust** — the type system is the primary contract; `assert!` / `debug_assert!`
  for invariants; `#[must_use]`; newtypes over primitive obsession; `Result` at
  fallible boundaries.
- **TypeScript** — `zod` (or equivalent) to validate all external IO (API
  payloads, env, file input) at the edge; branded types for invariants; `strict`
  tsconfig.
- **Python** — `pydantic` models at boundaries; `icontract` pre/postconditions
  on critical functions; full type hints + mypy/pyright strict.

## Rules
- Validate at the boundary, trust within the core.
- A public function's contract (inputs, outputs, errors, invariants) is part of
  its doc and is the basis for its property tests.
- Breaking a published contract is a SemVer major + an ADR.
