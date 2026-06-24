# Spec-driven development (SDD)

The spec is the primary artifact; code is regenerable output. SDD is the main
defense against code that drifts from intent.

## Tooling
GitHub Spec Kit (Specify CLI), which supports Claude Code natively.
Flow: **Spec → Plan → Tasks → Implement** (`/spec`).

## Where specs live
- Greenfield bootstrapping: `specs/` at the workspace root.
- Per project thereafter: `docs/specs/` inside the project repo.

## Acceptance criteria — EARS notation
Write testable criteria using EARS so each becomes a test/eval case:

```
WHEN <trigger/condition> THE SYSTEM SHALL <observable behavior>
WHILE <state> THE SYSTEM SHALL <behavior>
IF <error condition> THEN THE SYSTEM SHALL <handling>
```

## Rules
- No implementation task starts without an accepted spec + acceptance criteria.
- Tasks are small vertical slices (one mergeable behavior each).
- Acceptance criteria are the source for the `tester` subagent's tests.
- Changing intent means changing the spec first, then regenerating code.
