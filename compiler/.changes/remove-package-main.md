---
bump: minor
---

Remove `[package].main` from `silk.toml`; built-in commands now discover optional conventional roots under `[package].source` (`main.silk`, `lib.silk` else `exports[0]`, and `tests.silk`), and custom compilation entry points belong to `tasks.silk`.

## Migration

Delete `main` from `[package]` in `silk.toml`. Keep standard entry files at `<source>/main.silk`, `<source>/lib.silk` (or exported first in `[package].exports`), and `<source>/tests.silk`, or select a custom root in `tasks.silk`:

```silk
let app = run Compilation.executable("app", "src/app/main.silk")
```
