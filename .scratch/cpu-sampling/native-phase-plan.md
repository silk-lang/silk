# V22 native attribution diagnostic (prepared, not run)

Driver hooks: `/workspace/silk-native-phase-diagnostic`, based exactly85ba82efe750a4682cc21192ad5dcb37d7bbd981. Depends on interning's `semantic.CacheWorkTrace.point(label,a,b)` pure allocation-free helper. Root merges semantic/cache/provider and driver probes once, sourcechecks once and builds one diagnostic compiler. No product optimization is included.

Gate: `SILK_CPU0_CACHE_TRACE=1` (historic name, works on1/4CPU). Trace record: `cpu0-cache LABEL at_ns=N pid=P tid=T ns=0 a=A b=B c=0`. Clock is CLOCK_MONOTONIC, matching perf `--clockid mono` and Python monotonic_ns. The launcher opens one O_APPEND file, passes its actual fd explicitly, and sets `SILK_CPU_TRACE_FD`; the fd survives the coordinator's dup2 to /dev/null. No global mutable trace state, parent environment mutation, or new native environment allowlist is needed.

Events:
- native-staging/fork/coordinator-work: private directory creation, fork and child entry.
- native-units-setup: object cache placement, fragment copying, debug metadata and job construction. Per-unit native-debug-info identifies the debug-only subsection.
- native-schedule: static batch planning. native-threads-started/joined and batch begin/end identify worker lifetimes.
- native-job: one unit's encoding and compile. a is unit ordinal within that process's compileUnits invocation. native-bitcode begin b=fragment bytes/end b=bitcode bytes; native-write begin/end b=bitcode bytes; native-clang begin/end encloses submit+wait, end b=0success/1failure. Each PID/TID carries a sequential batch; no guessed Clang PID matching is needed for wall intervals. Perf fork/exec events supply actual subprocess CPU.
- native-save-checkpoint begin/end encloses accepted semantic checkpoint creation/dispatch, not writer completion. native-cache-checkpoint is after dispatch; native-cache-completed follows tracked writer join.
- native-wait begin/end encloses waitpid; native-promote encloses completed object rename. native-coordinator-exit is emitted before process exit. Cleanup calls after a successful wait produce no second wait interval.

All job intervals are elapsed wall, may overlap across threads and with semantic/writer events, and MUST NOT be summed as end-to-end wall or called CPU. Aggregate CPU comes from99Hz weighted samples and wait4. Incomplete begin/end pairs identify errors, not zero-duration work.

Prepared commands (run only after root explicitly schedules):

```
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/cpu-sampling/v22-native-phases.py --binary DIAGNOSTIC_BINARY --compiler-source EXACT_COMBINED_REVISION --name v22-native-profile --cpus 0,1,2,3
```

For matched sampling overhead controls, use the SAME diagnostic binary/source/policy plus `--control` before/after the sampled invocation, each fresh source+build tree. `--events-off --control` separately tests instrumentation cost. `--serial` removes only frontier/retained/native-pipeline settings while retaining native packing; it is a same-binary CPU diagnosis, not the originalN0 baseline. `--operation check` separates frontend attribution. Source pins, binary/harness/launcher hashes are recorded AT DISPATCH, not recomputed during another timing window. No commands were dispatched during preparation.

The runner requires1536MiB free before snapshot; does not prune evidence. Workload is originala63 compiler+stdlib. Child launcher strips inheritedSILK settings, restores originalLD_LIBRARY_PATH, supplies exact selected flags and becomes a subreaper. Perf alone gets its extracted private library path. Perf records inherited usercpu-clock99Hz by PID/TID, mmap/task chronology and samples; every compiler/cache descendant is reaped. On fourCPU, full parallel build must show accepted semantic/artifact proof and native objects published; host refusal fails attribution acceptance. On CPU0, keep all normal policy flags and require automatic host refusal with no split/pool/native coordinator; no native-wait event is expected. Explicit --serial is a separate diagnostic and is not a substitute for the product CPU0 policy. This runner is cold-only; editing attribution must reuse the same cache in an explicit cold→settled firstedit→unchanged sequence.

Before large dispatch, combined sourcecheck and tiny native pipeline trace gate must verify: real nonzero monotonic timestamps/PID/TID; inherited fd trace survives silenceChild; every successful native job has paired bitcode/write/Clang intervals; disabled gate emits none; generated executable runs and cache followup is correct. Test perf availability with the existing cheap CPU/fork probe if the environment changed. No system installation/sysctl changes are needed.

Existing V13 sampler is retained untouched. New `launch-native-phases.py` and `v22-native-phases.py` were Python-AST checked only. Native source hooks are pending the single combined sourcecheck. Detailed program identity requires exact emitted hash-symbol mapping for the diagnostic binary; unmatched/inlined samples remain unresolved rather than borrowed address mappings from V13.

Query counters are independent: `--query-census` sets SILK_QUERY_RUN_CENSUS; absent by default. `--control --events-off --query-census` is counters-only; `--control` is events-only; normal default uses events+perf; add --query-census for combined attribution. Counter key-encoding/dump intervals are diagnostic overhead and must be separately identified. Do not claim source-key serialization CPU as compiler work removed. Avoid a large factor matrix; one combined attribution plus bounded same-binary controls is sufficient initially.
