---
bump: minor
---

Remove `requirements` from `[unstable].composition` in `silk.toml`.

## Migration

Delete any `requirements = [...]` field from `[unstable].composition` in `silk.toml`; composition configuration now keeps only `runtimes`, `defaults`, and `retention`.
