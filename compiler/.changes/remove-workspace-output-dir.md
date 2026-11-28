---
bump: minor
---

Remove `[workspace].output-dir` from `silk.toml`; workspace and package build outputs always live under `<root>/build`.

## Migration

Delete `output-dir = ...` from `[workspace]` in `silk.toml`, and update any scripts or tooling expecting a custom output path to read from `build/`.
