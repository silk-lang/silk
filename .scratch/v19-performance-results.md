# V19 completion-barrier causal control

Frozen binary `.scratch/frontier-native-checkpoint-completed-v19`, SHA256 `d28229b60666ebe8acb8ff107ef048f72a72607d6475768fe6d1f4e53de622f3`, source `b0f222d1cddb807bc0aa2bd66965ee7b68e518be`. Four-unit O2 compiler without PGO, running on CPUs 0–3. This isolates same-binary pipeline OFF/ON behavior; it is not a baseline acceptance comparison or a 3× claim. CPU0 acceptance remains held for a comparable final compiler; known V17 single-core regressions remain unresolved by this control.

Results: [complete report](benchmarks/immediate-pipeline-qimghwzc/immediate-pipeline-report.md), [raw results](benchmarks/immediate-pipeline-qimghwzc/results.json), [pinned command](v19-prepared-performance-command.json). Twelve build calls on the original frozen Harf workload, two reversed OFF/ON rounds, registry OFF and all ordinary frontier/cache features identical. Each cohort launches both edits immediately after the prior foreground return, with no cache priming and no deliberate writer wait.

| Stage | Foreground OFF → ON | Settled OFF → ON | Process-tree CPU OFF → ON |
|---|---:|---:|---:|
| Cold | 7.449 → 6.546 s | 7.461 → 6.558 s | 20.896 → 19.278 s |
| First edit | 0.830 → 0.808 s | 1.029 → 1.001 s | 1.409 → 1.356 s |
| Second edit | 0.803 → 0.783 s | 1.006 → 0.965 s | 1.382 → 1.336 s |
| Complete cohort | 9.318 → 8.352 s | — | 23.687 → 21.970 s |

Medians above; do not sum overlapping settled intervals. Cold foreground improvements in individual reversed pairs were 19.7% and 3.5%, so the exact cold benefit remains noisy. First-edit changes were 3.9% and 1.4% faster; second-edit changes were 6.4% faster and 1.3% slower. Small samples do not establish statistical significance. The prior V18 immediate first-edit penalty was absent in both V19 pairs.

Both ON cold runs emitted exactly one ordered coordinator-start → cache-checkpoint → native-publication → cache-completed sequence. No cold writer remained alive at either first-edit launch, in either policy. First-edit launch gaps were 13.8–14.7 ms; second-edit gaps 15.1–17.2 ms. Warm writers still overlapped the subsequent edit in all four cohorts, so the test continues to exercise ordinary asynchronous editing behavior. All twelve artifact revision markers, pairwise artifact hashes, ordered diagnostics, cold frontier/artifact acceptance, no-warm-refork checks, affinity checks and supervisor exit checks passed. All supervisors and observed descendants were reaped; ten detached writers were observed externally, while the two ON cold writers were reaped by the compiler. Their CPU is included in primary wait4 usage, never added twice. An external supervisor cannot independently check the exit status of a writer already reaped by the compiler.

Exclusive timing ownership was released after all twelve calls and cleanup. No compiler confirmation or CPU0 diagnostic run was started.
