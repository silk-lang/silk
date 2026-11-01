# Windows semantic cache persistence

Windows uses the support plan's synchronous fallback. `DetachedWriter` holds a synchronous
`LockFileEx` lock while `SemanticCache` assembles, encodes, and publishes the image. Readers take
a shared lock before reading it. No detached writer command or serialized handoff is shipped.

POSIX `fork` gives its writer the existing store without serializing it. A Windows relaunch does
not inherit that pointer graph. Reconstructing it from the source and the previous cache adds
frontend work; serializing the whole image before launch would retain the expensive work in
the caller. A thread cannot outlive process termination. The chosen fallback keeps publication
ordering and lock ownership explicit without introducing either of those costs.

## Native relaunch experiment

The opt-in scripts instrument only a disposable compiler copy. A C companion records QPC at
`program` entry, immediately before `persist`, and after persistence. An environment switch in
that disposable copy returns at the persistence boundary, without assembling or encoding the
image. There is no measurement flag or foreign measurement function in the production compiler.

For each contender the script restores the cache that preceded a single body edit. The worker
therefore cannot benefit from the synchronous contender's completed image. The detached
contender starts the same compiler through `CreateProcessW` with `DETACHED_PROCESS` and an
explicit inherited-handle list containing only NUL. It runs `check`, never `run`, `test`, a
linker, or a user executable. The launcher waits only to measure the experiment. The worker
skips semantic persistence but still completes ordinary check cleanup.

Windows Server 2025 x64, LLVM 22.1.8, optimized compiler from source `8d1e4440f`:

| Single compiler-body edit | Existing-store persistence | Detached reconstruction to persistence boundary |
| --- | ---: | ---: |
| 1 | 1,078,694 us | 2,395,507 us |
| 2 | 963,020 us | 2,132,541 us |
| 3 | 1,386,372 us | 2,753,892 us |

The hello-project experiment measured 11,771–17,865 us for persistence and 126,616–234,284 us
for reconstruction. The full compiler's initial cold check reached persistence after
41,107,404 us and spent 1,425,043 us persisting. These are observations, not timing assertions
or universal performance bounds. A separate corpus run was active on this VM during measurement.

The detached figures exclude image assembly, encoding, writing, recipe transfer, source snapshot
validation, and lock handoff. They are a lower bound for that reconstruction design. A new
compiler could return earlier by deferring this work, but the cache would become ready later and
a following reader would wait longer. On both measured workloads, reconstruction alone cost more
than persisting the already available store. This is why Windows takes the synchronous fallback.
This experiment does not prove that every possible asynchronous design is slower.

Retained raw results:

- `.scratch/cache-probe-results-compiler-single-edit-d0fabf26e9d1492b804cf8e5cdac9624/results.json`
- `.scratch/cache-probe-results-hello-2356fa0456894fc5bf1afa37af369a66/results.json`
- `.scratch/cache-probe-results-compiler-06e91c0278014cdaba6c9f91e629ba93/seed.times`

The measured executable SHA-256 is
`8e0322ca3e78bc3705dcb018d553e79500000e1945c573918e000b2059d5ae65`.
The first compiler-project experiment changed every matching return literal; the table uses
the subsequent single-edit experiment instead.

## Reproduce

From the repository root on Windows, use an existing native compiler with LLVM 22 support:

```powershell
& compiler/fixtures/windows-runtime/prepare-cache-writer.ps1 -Compiler C:\path\silkc.exe
```

It exports the committed compiler and its `tomledit` dependency into a fresh scratch directory,
adds the measurement calls and companion object there, and prints the instrumented compiler
and disposable project paths. Pass those paths to:

```powershell
& compiler/fixtures/windows-runtime/measure-cache-writer.ps1 `
  -InstrumentedCompiler C:\path\scratch\compiler.exe `
  -Project C:\path\scratch\compiler -Label compiler
```

The runner restores the edited source even after a failure, retains its cache and evidence,
and requires successful native exit and complete measurement records. For a small comparison,
create a disposable package with `hello.silk` as `src/main.silk` and pass that project instead.
These scripts are outside CI and impose no correctness or performance budget.
