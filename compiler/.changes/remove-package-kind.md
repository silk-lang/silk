---
bump: minor
---

Remove `[package].kind` from `silk.toml`; package roles are determined by present conventional roots (`main.silk`, `lib.silk` / `exports`, `tests.silk`) and compiled artifacts are chosen by `Compilation.*` in `tasks.silk`.

## Migration

Delete `kind` from `[package]` in `silk.toml`. Library packages keep `src/lib.silk` and/or `[package].exports`, executable packages keep `src/main.silk`, and packages that emit archives, loadable modules, or objects construct them with `Compilation.staticArchive`, `Compilation.loadableModule`, or `Compilation.object` in `tasks.silk`:

```toml
[package]
name = "math"
version = "0.1.0"
exports = ["lib"]
```
