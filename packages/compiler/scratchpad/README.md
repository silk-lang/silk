# Compiler scratchpad

From the repository root:

```sh
docker compose -f packages/compiler/scratchpad/compose.yaml up -d
pnpm --filter @silklang/compiler scratchpad:prepare
pnpm --filter @silklang/compiler scratchpad
packages/compiler/scratchpad/dist/hello-world
```

The executable prints `Hello, world!`. Edit `hello-world/main.silk` and its imported
module `hello-world/greeting.silk` to try multi-file programs. `compile.ts` reads
these files on every run and invokes the compiler's TypeScript sources directly.
The final executable and link plan live in the ignored `dist/` directory.
`saveTemps: true` retains intermediate files in the system temporary directory;
the link plan records their paths. Set it to `false` for automatic cleanup.
Compilation caching defaults to off so every run visits the compiler pipeline.

## Cache switch

From `packages/compiler`, select the mode for each launch:

```sh
SILK_SCRATCHPAD_CACHE=false bun run ./scratchpad/compile.ts
SILK_SCRATCHPAD_CACHE=true bun run ./scratchpad/compile.ts
```

The same environment variable works with the pnpm command and debugger. You can
also change `Config.withDefault(false)` beside `SILK_SCRATCHPAD_CACHE` near the top
of `compile.ts` to choose the default. Each run prints its cache mode.

The switch controls both checked-unit semantic persistence and backend/final
artifact caching. Enabled runs share the local `dist/cache/` directory across
processes. Disabled runs neither read nor publish those caches, and leave existing
entries intact. Delete `dist/cache/` when you want an empty cache. Enabled runs
still prepare current sources and headers and validate cached results.

After editing compiler TypeScript, run `pnpm toolchain:generate` in
`packages/compiler` before a cached launch. After editing `@silklang/llvm`, rerun
`scratchpad:prepare`, which rebuilds it before regenerating. Cache identity uses
the generated compiler distribution fingerprint, which covers the compiler sources
and the built `@silklang/llvm` JavaScript; uncached debugging does not reuse
results from that fingerprint.

## Jaeger tracing

Open [Jaeger](http://localhost:16686), select the `comp` service,
and click **Find Traces**. Each compilation has a `Scratchpad.compile` root span;
expand it to inspect the compiler phases. The `frontend.root` attribute distinguishes
the application from compiler-support compilations. Buffered spans flush when the
script exits.

The scratchpad exports OTLP/HTTP to `http://127.0.0.1:4318/v1/traces`. Set
`OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` to use another collector. Jaeger stores traces
in memory, so restarting its container clears them. Stop it with:

```sh
docker compose -f packages/compiler/scratchpad/compose.yaml down
```

## Debugging

Every run saves a new `dist/comp.chrome-trace.<datetime>.json`, including failed
compilations. The filename uses the run's start time in UTC, for example
`comp.chrome-trace.2026-09-15T23-15-42.123Z.json`. Earlier runs are preserved for
comparison, and the start time is also stored in the trace's `otherData` field.
Drag a file into Chrome DevTools' **Performance** panel to inspect the Effect spans.
Export captures spans directly, so it works even when Jaeger is unavailable. These
are elapsed span durations, without CPU samples or GC events.

In Cursor, open the repository root, select **Silk: Compiler scratchpad** in
**Run and Debug**, set a breakpoint on the `Driver.compile` call in `compile.ts`,
and press **F5**. You can also set breakpoints in `packages/compiler/src/`, for
example in `Driver.ts` or `FileSourceResolver.ts`. The launch configuration uses
Node with `--import tsx` and runs the preparation task automatically. It debugs
the TypeScript compiler; Silk source files are the compiler's inputs.

Preparation builds the LLVM dependency and refreshes generated compiler tables.
Compiler source edits need no separate compiler build. The terminal equivalent
from `packages/compiler` is `node --import tsx scratchpad/compile.ts`.

The native toolchain must be installed. The launcher uses Homebrew LLVM on Apple
Silicon when available, otherwise `clang` from `PATH`. Set `SILK_CLANG` to select
another executable. The archiver defaults to `llvm-ar` beside that compiler when
available, otherwise `llvm-ar` from `PATH`; override it with `SILK_LLVM_AR`.
Inspect `outcome` after compilation for the result and phase
report; compilation failures exit unsuccessfully and print their details.
