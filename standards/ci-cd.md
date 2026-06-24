# CI/CD

GitHub Actions, one pipeline per project repo.

## Required pipeline stages (gate merge)
1. **Setup** — pinned toolchain (devcontainer/mise), cached deps.
2. **Lint + format check** — fail on drift.
3. **Typecheck.**
4. **Unit + integration tests** — services via Compose; coverage threshold.
5. **Eval harness** (`just eval`).
6. **Mutation tests** on changed lines — minimum score.
7. **Security** — gitleaks, Semgrep (SAST), dependency review/SCA, SBOM.
8. **Build** — artifacts / container.

## Branch protection
- PRs required; no direct pushes to `main`.
- All required checks must pass; at least one approving review (the `verifier`
  / human).
- Linear history; squash-merge with a Conventional Commit title.

## Releases
- Tags drive SemVer releases.
- Changelog generated from Conventional Commits (never hand-written).
- CI credentials via short-lived OIDC, never long-lived keys in the repo.
