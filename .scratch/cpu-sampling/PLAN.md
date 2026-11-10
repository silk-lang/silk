# CPU sampling plan for V11 merge/publication and worker duplication

Prepared only; no sampling, installation or system changes during the exclusive benchmark window.

## Tools already available

`/workspace/silk/.scratch/profilers/root/usr/bin/perf`, `gdb`, and `valgrind` already exist from the first profiling lane. Perf's private dependencies are under `profilers/root/usr/lib/x86_64-linux-gnu`. Set a private `LD_LIBRARY_PATH` only for the profiler/analysis tools, not globally or for the compiler. Disable debuginfod network lookup with `DEBUGINFOD_URLS=`. No package installation is initially needed.

Earlier `profilers/perf-smoke.log` proves user `cpu-clock` sampling succeeded (optional systemwide BPF sideband failed harmlessly). `compiler.perf.data` contains 4,166 historical samples/34.3MB. That is a historical build and is not a substitute for V11 attribution. A later zero-byte smoke file means current-host availability must be checked again. Current host reports perf_event_paranoid=2, Seccomp=0, and no effective capabilities. User-only sampling of our own descendants is the intended permission model; do not change sysctls or request systemwide profiling.

## First scheduled step: establish validity and overhead

Use the existing extracted perf with its private library path. Run a short user-space cpu-clock probe on an expendable tiny CPU loop, not a new full workload. Verify it produces samples and exit status 0, records the launched PID, and that a forked child also appears. Sampling a sleeping `/bin/true` does not verify sampling. If events are denied, preserve errno/log and stop that route; do not silently collect empty data.

Then profile a fresh V11 compiler **check**, keeping the established a63 source/baseline stdlib, exact V11 SHA, prototype flags, inherited CPU lane 0–3 and default profile. Start with `perf record -e cpu-clock:u -F 99 --clockid mono` and no call graph. Retain fork/exec/mmap/comm records (default inheritance), disable optional BPF sideband and build-id cache writes if supported. The compiler/check workers run under the profiler's child tree, not systemwide. Use the same cold-cache preparation as the matched benchmark.

A small Python child launcher should restore the original LD_LIBRARY_PATH before executing the compiler, set PR_SET_CHILD_SUBREAPER, and keep running until all detached cache writers are reaped. This prevents perf from stopping at the frontend's exit while publication continues. Record root PID, monotonic start, root exit, each adopted child's exit and settled exit. Preserve original exit codes and wall/tree CPU. The launcher should timestamp each existing stdout/stderr line on receipt into a sidecar without changing its bytes; existing tracing emits short atomic writes, so this provides phase boundaries without compiler instrumentation. The logger runs outside the measured compiler and its samples are excluded by DSO/PID in attribution, but its overhead still counts in the paired elapsed comparison.

Record one unprofiled control with the same launcher/logging/cold preparation, then sampled, then another unprofiled control. Sampling overhead is established empirically; do not assume 99Hz is free. If wall or total CPU shift exceeds ordinary run variance (use 5% as an investigation threshold, not a promised bound), lower the sample rate or remove optional capture. Keep these diagnostic runs separate from authoritative speed results.

## Attribution products

1. Sampled **user CPU**, weighted by event period, grouped by PID/TID and DSO, with 100ms timeline buckets. Keep parent frontend, each worker/descendant, detached publication writer, and (for later build profiles) Clang/linker separate. Do not divide per-PID samples by wall time and call the result exclusive function cost without the period weights.
2. For the parent, separate pre-fork work, overlap while workers execute, and merge/proof/adoption/cache-publication intervals. Existing trace boundaries include `proved`, `adopted`, `module sweep cache assembled`, `check cache assembled`, and the separate root/settled exits.
3. For workers, compare exclusive CPU in actual query execution against RuntimeEncoding/key hashing, BuildRecord/CacheImage encoding, packet I/O and repeated escape traversal. The same hot symbol in four workers does not by itself prove duplicated semantic work: combine CPU samples with distinct work counts/proof records and the matched same-binary serial path.
4. Produce percentages **and sampled CPU seconds**, sample counts/lost counts and bin duration, not only ranked function names. The suspected `RuntimeEncoding.word`, `Bitcode.putRun` and `Bytes.zeroed` profile counters are invocation/block-frequency observations, not CPU percentages. A billion cheap executions can cost less than a million expensive ones.
5. Attribute V11 symbols from the exact sampled ELF first. It has optimized/no-debug construction, so exported/hash symbol names may need the corresponding `.ll.symbols` name map. Accept a name-map entry only when its exact symbol exists in this ELF; the older 927 training map can help identify matching symbols, but must not assign addresses or approximate nearest-name matches across different binaries. Retain unresolved symbols honestly. Inlining means IP-only samples cannot distinguish all callers.

Timeline caution: not all `frontier ... ms=` values share an epoch. `Semantic.frontierTrace` subtracts its supplied start; `split` uses frontierStarted, most worker/merge records use frontierSplit, and artifact/declaration-chunk records sometimes use local `started`. Do not globally align them by assuming one start. Monotonic log-arrival timestamps and perf timestamps provide the common clock; use each trace's internal durations only within its documented origin.

## Escalate only where the first profile identifies a material cost

If the parent publication/merge window is a large CPU fraction, collect a second diagnostic profile at 99Hz with `--call-graph dwarf,8192` across the same workload (or a proven phase-triggered capture). O2 binaries do not guarantee usable frame pointers, so `--call-graph fp` can produce misleading truncated stacks. DWARF stack copies cost more memory/I/O: at 396 samples/s and 8KiB each the nominal raw stack payload is about 3.2MB/s before other records. Validate unwind completeness and paired overhead; reduce rate to 49Hz if needed. Exact call chains require usable unwind data and cannot be inferred from function hit counts.

If a hot allocator/helper appears without meaningful callers, use this focused stack profile to distinguish repeated type encoding, graph serialization, bitcode growth or useful backend work. If code-generation hot loops remain material after that attribution, replay a single already-captured native pack with hardware cycles only if PMU events are available; user CPU-clock remains the portable primary sample source.

Do not use Valgrind callgrind for end-to-end wall comparisons: it is useful for a small isolated algorithm after a genuine CPU hotspot is established, but its instruction counts and severe slowdown are not production CPU attribution. Repeated gdb attach/stop sampling similarly perturbs scheduling and parallelism; keep it as a last-resort stack diagnostic, not the first profile or a speed measurement. No new frame-pointer rebuild should replace the matched V11 binary silently.

## Expected decision

Sampling should answer whether the extra roughly 10 seconds of V11 check CPU over the original baseline lives in worker repetition, parent proof/cache publication, or normal changed algorithms. Optimize the largest measured avoidable category. The LLVM plugin remains the independently scheduled backend experiment; no speculative micro-optimization of block-count leaders is justified before attribution.
