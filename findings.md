Two findings that change a couple of recommendations
SpacetimeDB only compiles the server module WASM — not your client prediction WASM. This matters for the build section. spacetime publish builds your module to WebAssembly and uploads it, but that's the server side. Your client-wasm crate (shared game-core compiled for the browser) needs its own toolchain — wasm-pack — orchestrated by Vite. So "SpacetimeDB compiles the WASM" is true only for server-module/; the client WASM is a separate build step. The CLAUDE.md already separates these two lines, so it's just a matter of filling each with the right tool. GitHub
PixiJS now ships official AI-agent skills — install those instead of hand-writing a Pixi skill. As of the June 2026 releases, PixiJS ships 25 official skills that teach agents to use v8 correctly and avoid the v7 patterns they tend to hallucinate, installable into Claude Code with npx skills add https://github.com/pixijs/pixijs-skills, and as of v8.19.0 they also ship inside the npm package at node_modules/pixi.js/skills/. That's strictly better than anything I'd write for the rendering layer — it's authoritative and version-matched. Run that command in the repo and you've covered Pixi. ToseaTosea
Recommended values
Build & Test section (current PixiJS stable is v8.18.1, with v8.19.0 the latest June release — pin to the v8.19 line): McpTosea

Build WASM client: wasm-pack build client-wasm --target web (Vite imports the generated pkg/)
Build/publish server module: spacetime publish -p server-module <db-name> — and after schema changes, regenerate bindings: spacetime generate --lang typescript --out-dir frontend/src/module_bindings --project-path server-module Newline
Dev loop: spacetime dev is worth knowing — it starts the server, compiles and publishes the module, and regenerates client bindings automatically on file changes. Alexop
Frontend dev / build: vite / vite build (add vite-plugin-wasm + vite-plugin-top-level-await so the WASM and its async init work)
TS test: vitest; typecheck: tsc --noEmit; lint: eslint .
Toolchain note worth adding: SpacetimeDB Rust modules need Rust 1.81.0 or later, and the CLI auto-installs the wasm32-unknown-unknown target. AlexopGitHub

Library Documentation section:

GitMCP URL for SpacetimeDB: https://gitmcp.io/clockworklabs/SpacetimeDB (the repo is clockworklabs/SpacetimeDB)
PixiJS version pin: v8.19
A refinement to the routing, given the findings: PixiJS publishes llms.txt (that's what its skills and GitMCP both read), so GitMCP handles PixiJS fine too. With the official skills installed and llms.txt available, Context7's unique value shrinks to libraries that are both version-sensitive and lack good llms.txt. You could route PixiJS to GitMCP as well and reserve Context7 for the rare library that needs it — which saves even more of that 1,000/month quota. Your call; the current split still works.

Naming (these are free choices — just pick and be consistent):

Crate names: keep game-core, client-wasm, server-module — they're clear. SpacetimeDB's own convention names the module dir spacetimedb/, but server-module/ is fine as long as you pass -p server-module to the CLI as shown above.
<db-name>: pick your game's name in snake_case (e.g. topdown_arena). It becomes the published database identity.

.gitignore decision: I recommend the default I set — ignore module_bindings/ and regenerate. The generated TS bindings change every time the schema does; committing them creates noise and merge conflicts, and spacetime dev regenerates them automatically anyway. Keep the line as-is and delete the alternate-path comment.







AST knowledge graphs parse your code with tree-sitter into a graph of symbols, calls, and imports stored in a local DB, then answer "what calls X / what breaks if I change X" by querying that graph. Examples: code-graph-mcp, CodeGraph (two different projects share that name), codebase-memory-mcp.
LSP-based semantic retrieval wraps the actual language servers (rust-analyzer, typescript-language-server) and answers the same questions using real compiler-grade symbol resolution. The key insight one analysis draws: LSP provides structural understanding while RAG/AST provides semantic search — they're complementary, not competing. Serena is the dominant tool here. SpacetimeDB
Why this distinction is decisive for your project: your codebase is Rust-heavy (three of four components), and Rust is exactly where AST-only parsing is weakest — generics, traits, macros, and derive (which SpacetimeDB leans on heavily) are hard to resolve from a syntax tree alone but are precisely what rust-analyzer exists to handle. That single fact reshuffles the ranking.