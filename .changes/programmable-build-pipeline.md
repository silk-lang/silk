Replace manifest build configuration with typed compilation graphs, explicit requests, package code-generation settings, and sandboxed editor planning.

## Migration

Remove `[profiles]`, `[config]`, `[build]`, `[tasks]`, `[[generate]]`, and native source/link lists from `silk.toml`. Keep source identity and dependencies in the manifest. Put build commands in `src/tasks.silk`, publish `pub const COMMANDS: string = Task.commands<Tasks>()`, and construct `Compilation` values with `silk.build.graph`. Finish commands with `Build.compile` or `Build.write`.

Move portable native requirements to a typed `pub const PLAN: Plan` in `build.silk`. Use target conditions instead of native `os` filters, and `Plan.compileNative` or `Plan.compileSources` for per-file flags and globs. Retain pinned archives under `[native.archive]` and overrides under `[native.override]`.

Replace named profiles and `--profile-input` with compilation methods and the shared `Options` flags (`--target`, `--release`, `--optimization`, `--debug`). Bind parameters through `Package.set`; grant a physical path to a package plan through `Package.supplyPath`. Put `tools = true` on a dependency entry that may execute tools, and use the explicit `--unsandboxed-tools` flag when required.

Use `Package.path` for included dependency assets and `Built.artifacts` for output paths. Artifacts live under `build/<target>/<dev|release|size>/`; reusable compilation requests live under `build/requests/`. Package kinds are `executable` and `library`; choose object, archive, shared-library and test artifacts with `Compilation` constructors. Workspace output configuration is `[workspace].output-dir`.
