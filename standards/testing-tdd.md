# Testing & TDD

## The cycle
Red → Green → Refactor. Write a failing test from an acceptance criterion,
make it pass minimally, then refactor with tests green.

## Test ownership (anti reward-hacking)
The subagent implementing a change **does not** author or edit the tests that
gate that change in the same loop. The `tester` writes tests from the spec; the
`verifier` runs them. This prevents tests fitted to buggy behavior.

## The test pyramid (right-sized per project)
- Many fast **unit** tests (pure logic, contracts).
- Fewer **integration** tests (DB/queue/cache via Docker Compose).
- Few **end-to-end** tests (critical user paths only).

## Techniques
- **Property-based testing** for logic-heavy code: proptest (Rust),
  Hypothesis (Python), fast-check (TS).
- **Mutation testing** to verify tests are meaningful: cargo-mutants, mutmut,
  StrykerJS. CI enforces a minimum mutation score on changed code.
- **Determinism**: seedable RNG, injectable clocks, deterministic simulation.
  No wall-clock or unseeded randomness in tests. Flaky tests are quarantined,
  not silently retried.

## Definition of done
`just ci` green and meaningful: coverage threshold met, mutation threshold met
on changed lines, no skipped/quarantined tests reintroduced silently.
