# Model, effort & orchestration routing

Two independent dials — *which model* and *how much effort/orchestration*.
Correct model routing alone saves ~60–80% vs. all-Opus.

## Model
| Tier   | Use for |
|--------|---------|
| Haiku  | test scaffolding, docs, changelog, lint-level review |
| Sonnet | features, bug fixes, standard refactors, code review (most volume) |
| Opus   | architecture, multi-file refactors, complex debugging, unfamiliar code |

Heuristics: human-in-the-loop downgrades one tier; an autonomous loop upgrades
one tier; hard latency forces Haiku. Switch mid-session with `/model`.

## Effort (`/effort`)
- Persistent levels: low / medium / high / max. Session-only: `ultracode`.
- On 4.6-class models thinking is **adaptive** — `ultrathink` is legacy; prefer
  `/effort`.
- Policy: default low/medium; **high** for features/reviews; **max / ultracode**
  for architecture, multi-file refactors, gnarly debugging, security.

## Orchestration
- **`ultracode`** — max effort + dynamic multi-step workflow with auto subagents.
  Complex tasks only; token-heavy.
- **`ultraplan`** — offloads planning to a cloud session; keeps local context lean.
- **`/deep-research`** — custom command delegating to the `researcher` subagent
  in isolation; returns a summary only.

## Token-efficiency
Escalation buys quality by spending more tokens — be selective. Efficiency comes
from: effort routing, subagent isolation, model routing, cloud offload, and
compaction. Caveat: availability of `ultracode`/`ultraplan` is version-gated —
confirm in your Claude Code build.

## Documentation lookups (cost-aware)
Library docs are a major token + quota cost. Discipline:
- **Prefer no-quota sources first** — a repo's `llms.txt`, official vendor skills,
  or a repo-serving doc MCP. Reserve **metered** services (e.g. Context7's limited
  free tier, ~1k req/month) for libraries that are BOTH version-sensitive AND lack
  usable `llms.txt`/repo docs.
- **Route by ownership** — one source per library; never double-query the same
  lookup (it burns quota *and* doubles the payload).
- **Load doc MCP tools lazily** (Tool Search), not at session start — a connected
  server costs context every session just by existing.
- **Fetch narrowly** — ask for the specific symbol/topic ("scheduled reducer
  syntax"), never "the whole docs for X". Payload size dominates the cost.
- **Verify version-sensitive identifiers** against current docs rather than
  trusting recalled tokens; prefer official vendor **skills** over model memory
  for fast-moving APIs.
