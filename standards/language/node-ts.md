# Node / TypeScript standards
- **Toolchain:** `pnpm`; Node pinned via `mise`/`.nvmrc`; `tsconfig` `strict: true`.
- **Lint/format:** **Biome** (`biome check .` lints + format-checks + organizes imports; `biome format --write .` to fix); `tsc --noEmit` typecheck. One tool for lint + format — no ESLint/Prettier.
- **Tests:** `vitest`; e2e with Playwright where needed; mutation via StrykerJS; property via fast-check.
- **Contracts:** `zod` to validate all external IO at the edge; branded types for invariants.
- **Modules:** ESM; explicit exports; no default exports for libraries.
