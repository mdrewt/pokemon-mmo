# ADR process (MADR)

Architecture Decision Records capture *why*, automatically, so rationale never
goes stale or lives only in someone's memory.

## Where
`docs/adr/` in each project. Files: `NNNN-title.md` (zero-padded, incrementing).

## When an ADR is REQUIRED
- Adding or removing a dependency.
- Introducing a design pattern, architectural layer, or new module boundary.
- Choosing between technologies (DB, queue, transport, framework).
- Any decision a future maintainer would ask "why did we do it this way?"

## How (automatic)
- The `/adr` command (via the `doc-keeper` subagent) detects a decision made in
  conversation and drafts the ADR.
- `/brainstorm` and `/debate` outputs populate the **Considered alternatives**
  section automatically.

## MADR template
```
# NNNN. <Title>
- Status: proposed | accepted | superseded by NNNN
- Date: YYYY-MM-DD
## Context and problem statement
## Considered alternatives
## Decision outcome
  - Chosen: <option>, because <justification>.
  - Consequences: <positive / negative / follow-ups>.
```
