# React standards
- **Build:** Vite; TypeScript strict.
- **Components:** function components + hooks; no prop drilling beyond 2 levels (lift or context).
- **State:** local first; server state via TanStack Query; global only when justified (ADR).
- **Testing:** React Testing Library (behavior, not implementation); Playwright for flows.
- **A11y:** semantic HTML, keyboard nav, labels; Biome's `a11y` lint rules (recommended set) enforce the basics.
- **Perf:** memoize only with evidence; code-split routes.
