# Rust standards
- **Toolchain:** stable via `rust-toolchain.toml`; `cargo` workspaces for multi-crate projects.
- **Lint/format:** `clippy -D warnings`, `rustfmt`.
- **Tests:** `cargo test`; property tests with `proptest`; mutation via `cargo-mutants`.
- **Errors:** `thiserror` for libs, `anyhow` for bins; no `unwrap()` in non-test code (use `expect` with a reason or propagate).
- **Contracts:** newtypes over primitive obsession; `#[must_use]`; `debug_assert!` invariants.
- **Docs:** `cargo doc`; doctests for public APIs.
