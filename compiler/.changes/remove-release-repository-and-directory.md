---
bump: minor
---

Remove `[release].repository` and `[release].directory` from `silk.toml`; `silk change since` now reads the GitHub repository URL from `[package].repository`.

## Migration

Delete `repository` and `directory` from `[release]` in `silk.toml` and set the package's GitHub URL under `[package]`:

```toml
[package]
repository = "https://github.com/owner/repo"
```
