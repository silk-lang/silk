Execute typed package build plans through the standard build graph with generated-file dependencies and explicitly supplied host paths.

## Migration

Declare `pub const PLAN: Plan` in `build.silk`. Replace generated source strings with `WriteFiles.empty().literal(...)` and `WriteFiles.result(...)`; pass deferred paths from `sourcePath`, `suppliedPath`, or `Run.result` to plan methods. Replace `Plan.tool`, `toolArgument`, `toolInput`, `toolOutput`, and `toolModule` with a `Run.command` description and `Plan.module`. Tool arguments now contain resolved input and output paths; scripts should use their arguments instead of `SILK_PACKAGE_DIR` or `SILK_TOOL`.
