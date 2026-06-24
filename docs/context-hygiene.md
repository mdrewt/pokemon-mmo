# Context hygiene (preventing context rot)

Output quality degrades as the window fills with accumulated noise. Filter
information *before* it reaches the model.

## Practices
- **Thin always-on context.** `AGENTS.md` is command-first and points to
  `standards/`; it does not inline every rule.
- **On-demand skills** for anything that matters only sometimes.
- **Subagent isolation** — research/exploration/large outputs run in their own
  context and return a clean summary. The single biggest lever. Use
  `/deep-research`.
- **Small authoritative memory.** Read `memory/index.md` (a map), then pull only
  the relevant project card.
- **Compaction discipline.** `/compact` at task boundaries; `/clear` between
  unrelated tasks; `/btw` for throwaway side questions. Start a fresh context
  per task to avoid long-horizon drift.

## Smells
- A single session spanning many unrelated tasks.
- Pasting whole files when a summary or path would do.
- Re-reading large outputs already summarized.

## What to preserve when compacting
Keep: files modified this session; commands run and their key output; failing
tests; pending migration/codegen/binding-regeneration steps; and any unresolved
questions or decisions. Drop: resolved tangents, large pasted file bodies, and
superseded attempts.
