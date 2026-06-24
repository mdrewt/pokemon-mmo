# Git, commits & branches

## Commits — Conventional Commits
`<type>(<scope>): <summary>` where type ∈ feat, fix, docs, style, refactor,
perf, test, build, ci, chore. Breaking changes: `!` + `BREAKING CHANGE:` footer.
These drive SemVer and the generated changelog.

## Branches & worktrees
- `main` is protected. Work on `feat/...`, `fix/...` branches.
- Parallel agent work uses **git worktrees** (one isolated worktree per
  specialist agent) so agents never collide. Merges are sequential, gated by
  the verifier.

## Merging
- Squash-merge; PR title is a Conventional Commit. Linear history.
- A merge requires green+meaningful CI and verifier/human approval.

## Recovery
- `/rewind` to roll back conversation + file changes to a checkpoint.
- Never rewrite published history without explicit human approval.
