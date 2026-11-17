---
bump: minor
---

Replace manifest build configuration with typed compilation graphs, explicit requests, and sandboxed package plans.

## Migration

Move profiles, config tables, task hooks, generators, and native source/link lists out of `silk.toml`. Keep package identity, dependencies, workspace layout, and pinned native archives in the manifest. Package kinds are `executable` and `library`.

Define commands in `src/tasks.silk` with `TaskSet` and the shared `silk.build.graph.Options`. Construct compilations with `Compilation.fromPackage`, `Compilation.executable`, or `Compilation.fromDefinition`; configure their settings before requesting an artifact. End build commands with `Build.compile()` and editor planning with `Build.write()`. Set package optimization, debug information, and declared parameters through `Package`; mark tool dependencies with `tools = true`.

Declare `pub const PLAN: Plan` in a package's `build.silk`. Use typed `Run` and `WriteFiles` descriptions for native inputs and generated modules, with deferred paths from `sourcePath`, `suppliedPath`, and `Run.result`. Supply external paths explicitly and pass tool paths as arguments instead of reading `SILK_PACKAGE_DIR` or `SILK_TOOL`. Dependency tools require a supported sandbox; the editor never enables unsandboxed tools.

Replace `--profile-input` and generated manifests with compilation definitions and requests. Use `silkc compile --request <file>` to replay a resolved request; requests include `root-module` alongside the physical `root` path. Editor requests are published under `build/requests/`.
