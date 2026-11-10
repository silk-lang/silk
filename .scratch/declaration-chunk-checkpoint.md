# Declaration chunk prototype

Source: `/workspace/silk-declaration-chunks`, commit `6fde9921d`, based on integrated `2c05a4b4a`.
Binary: `/workspace/silk/.scratch/frontier-declaration-chunks`, SHA256 `f4d3c3525f6bbc1ce01c4594f51208a043767d4f39bab8b80c36692aa064a3dd`.
Package: `.scratch/chunk-candidate-package`; seed `.scratch/ci-n1-4a1fa332/N1`, LLVM22.1.8 speed-four. Full source check and optimized build passed (101 seconds after one explicit-move correction).

Opt in with `SILK_FRONTIER_CHUNKS=1` together with frontier/shared/ephemeral. Dynamic scheduling must be enabled. Modules with at least256 declarations publish64-declaration ranges in a separate shared mapping. Workers prioritize ready ranges before claiming another module. Each worker reconstructs/caches the exact authored roster once per large module. Every range runs existing declaration/name checking and existing bounded escapes; its escape memo moves immediately into an ephemeral packet so later ranges cannot overwrite it.

Parent validates exact scoped keys, requested nonruntime module membership, exact ordered declaration/name rosters, complete nonoverlapping range coverage and warning-only reports. It concatenates concrete/deferred/warnings by source range order, validates every full escape fragment through the existing global finite/escape/resource proof, and only then installs whole module results. Partial metadata is never persisted.

Validation: SweepFragments structured test1/1 passed (coverage gaps/overlap, ordering, conflicting duplicate metadata, exact names/identities, codec roundtrip/trailing bytes). `.scratch/chunk-parity.py` ran4 fixtures with320 declarations each, serial and2 enabled repetitions:8/8 complete structured output comparisons passed. Valid and unused-local warning cases accepted6 chunks each; unused body type error and cross-range duplicate name correctly rejected through serial fallback, with identical codes/spans/relatedsites/order. Detached cache writers reaped between trials.

Performance pending profiling warm-edit reservation. Same-binary workload harness `.scratch/declaration_chunk_compare.py` compares ephemeral dynamic off/on chunks against fixed original compiler+Harf snapshots, repeats reversed order, requires global graph acceptance.

Known scheduling limitation: a worker can finish scanning currently ready ranges before a later module owner publishes a new roster, then become idle. The owner still consumes every range, so coverage remains sound; current compiler's large Semantic roster appears early enough for other workers to help. Measure before adding discovery waiting/proxy wakeup logic.

## Same-binary performance
Exclusive2round reversed pairs against frozen compiler/stdlib a63 and nonstdccb168, fourCPU affinity, every proof accepted, every detached writer reaped.
- compiler ephemeral: foreground 10.106s, settled 10.296s, aggregate CPU 27.856s.
- compiler chunks: foreground 9.992s, settled 10.171s, aggregate CPU 28.162s.
- harfrust ephemeral: foreground 2.658s, settled 2.744s, aggregate CPU 7.838s.
- harfrust chunks: foreground 2.729s, settled 2.820s, aggregate CPU 8.519s.

Standalone result: compiler1.011× faster; Harf2.7% slower. Not worth standalone promotion. Compiler module phase becomes balanced (~5.7s) but private runtime remains critical (~6s); evaluate only with worker-local fork optimization. Generic>=256 threshold creates134compiler/160Harf chunks and may overpartition cheap modules. No scheduler edits after measurement. Raw .scratch/declaration-chunks-comparison.json and individual logs.
