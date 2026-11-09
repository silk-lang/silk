---
bump: minor
---

A profile can choose its root module (`main`), any `artifact` whatever `[package].kind` is, and dependencies of its own in `[profiles.<name>.dependencies]`; `silk test` uses a declared `[profiles.test]`; `silk task <name>` builds the `tasks` profile (`src/tasks.silk` by default) and runs it from the package directory; the root manifest's `[tasks]` runs tasks before and after `build`, `run`, `test` and `pack` (`--no-hooks` skips them); and `silk.cli.task` is the library for writing tasks.
