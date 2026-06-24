# Workflow loops

The new skill is designing loops, not writing prompts. A loop runs a fixed
structure each cycle with an **evaluable success metric** — you can only safely
automate a loop you can evaluate, which is why the eval harness is a prerequisite.

## PRERRR (the default build loop) — `/loop`
**Plan → Refine → Execute → Review → Refactor → Repeat**, entered from a Spec
Kit task (never a freeform prompt). Review gates sit between Execute and
Refactor.

1. **Plan** — `planner` decomposes the spec task into small vertical slices.
2. **Refine** — tighten acceptance criteria (EARS); `tester` derives failing tests.
3. **Execute** — `specialist` implements in an isolated git worktree to green.
4. **Review** — `reviewer` (correctness/smells/over-engineering) + `verifier`
   (tests, evals, security) gate the change.
5. **Refactor** — improve with tests green.
6. **Repeat** — next slice; `doc-keeper` records ADR/changelog/memory at close.

## Parallelism
Specialists run in separate worktrees so they never collide; merges are
sequential and verifier-gated. Subagents never spawn subagents (depth = 1).

## Success metric per cycle
`just ci` green **and meaningful** (coverage + mutation + security). If the
metric can't be evaluated cheaply, don't automate the loop — add an eval first.

## When to escalate to multi-agent patterns
See `WORKSPACE-PLAN.md` §7 and the selection policy. Default solo; escalate only
when (high value OR high risk OR hard to reverse) AND a cheap evaluator exists.

## Definition of done (every task)
Beyond green+meaningful CI, each task closes with a **`/simplify`** pass (strip
over-engineering) and a **`/review`** pass (correctness/security/smells). These
are part of the mechanical-enforcement map in `standards/principles.md`.
