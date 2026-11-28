---
bump: minor
---

Remove `[native.override]` from `silk.toml`; machine-local native archive replacements live solely in `$SILK_HOME/native-overrides.toml`.

## Migration

Move any `[native.override.<name>]` entries out of `silk.toml` and into `$SILK_HOME/native-overrides.toml`:

```toml
[native.override.vendor]
path = "/path/to/local/checkout"
```
