# Eval harness

Tests check "does it work"; **evals** check "does it preserve the boundaries we
care about". You can only safely automate a loop you can evaluate — so every
project ships a small, living eval suite in `evals/`.

## What an eval asserts (beyond unit tests)
- **Architecture invariants** (e.g. domain layer imports no IO; module X never
  depends on Y).
- **Contract conformance** at public boundaries (schemas, API shapes).
- **Behavioral regressions** the team fought to prevent (golden cases).
- For perf-sensitive code: a **benchmark gate** (no >X% regression).

## Rules
- Evals run in `just ci` and gate merges, same as tests.
- An eval is added whenever a `/compete` or `/debate` task defines an objective
  scorer — that scorer becomes a permanent eval.
- Keep evals cheap and fast; they run every loop iteration.
- When raising agent autonomy on a project, strengthen its evals first.
