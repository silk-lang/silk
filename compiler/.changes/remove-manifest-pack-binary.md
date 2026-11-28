---
bump: minor
---

Remove `[pack.binary]` from `silk.toml`, rebuild `silk pack --bin` from each target's build-plan root final executables, and always include package-root `build.silk` in source archives.

## Migration

Delete `[pack]` and `[pack.binary]` tables from `silk.toml`, pass `--bin` explicitly when binary archives are wanted, and declare binary targets in `build.silk`. Non-shipping executable build helpers should be marked transitive in the build graph rather than exposed as plan roots. Binary archives always place executables under `bin/` using `.zip` on Windows targets and `.tar.gz` elsewhere.
