---
bump: minor
---

Store build caches in a shared system cache under `$SILK_HOME/cache/v1` by default, add `silk cache {path, info, prune, clean}` and `silk clean --cache`, and keep the per-workspace `build/` cache layout available via `--cache-mode workspace`, `SILK_CACHE_MODE=workspace`, or `[cache] mode = "workspace"` in `$SILK_HOME/settings.toml`.
