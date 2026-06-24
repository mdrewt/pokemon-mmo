# Python standards
- **Toolchain:** `uv` (default) pinning Python + deps; `pyproject.toml`.
- **Lint/format:** `ruff` (lint + format); `mypy`/`pyright` in strict mode.
- **Tests:** `pytest`; property tests with `Hypothesis`; mutation via `mutmut`.
- **Contracts:** `pydantic` at boundaries; `icontract` pre/postconditions; full type hints.
- **Style:** small pure functions; explicit over implicit; no mutable default args.
