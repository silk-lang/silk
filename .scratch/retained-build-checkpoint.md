# Retained backend experiment checkpoint

Source: `/workspace/silk-retained-build`; binary: `/workspace/silk/.scratch/N1-retained-build` (V5). Nothing from this prototype is promoted to production.

## Behavior

`SILK_POSTCHECK_BUILD=1` performs trusted serial checking, then forks four retained semantic stores for actual-artifact MIR closure, LLVM preparation, and text emission. Provider-sensitive definition identity selects a representative; the same representative supplies graph edges and emitted body. Observation causes a real backend-mode restart before emission. Suspension explicitly falls back. NonParking obligation roots are requested only after ordinary references close and reached definition/bare coverage is known.

`SILK_FINITE_ARTIFACT=1` skips old ancestry admission after complete clean finite closure. This remains a diagnostic policy flag: shared serial/parallel finite policy must be ported before production promotion. Existing global escape and NonParking validation remain.

## Default-dev matched pair

Results: `.scratch/benchmarks/retained-build-pkntu63d/results.json`.

- Compiler: 39.449 to 34.119 seconds (1.156x). Accepted 43,141 definitions. Graph discovery 3.118s; proof 3.238s cumulative; emitted 5.283s cumulative; accepted 5.486s cumulative.
- Harfrust: 11.806 to 11.377 seconds (1.038x). All 196 artifacts byte-identical.
- These isolate backend speed only; they do not achieve 3x or remove serial checking.

Compiler output differs in six old versus nine new helper symbols. Five paired Shared/Effect/helper functions normalize to identical instructions; remaining result/map wrappers differ in inlining/layout. Semantic parity is checked separately; byte equality is not used as the only correctness oracle.

## Validation

Nine earlier off/on fixture pairs passed with identical binaries, including provider/lifetime ordering and NonParking provider cleanup; suspension reported fallback. Four ArtifactGraph focused tests and earlier DefinitionFragments tests passed.

Generated compiler parity runner: `.scratch/retained-generated-parity.py`; results directory `.scratch/benchmarks/generated-parity-bgzfd8gf`. Thirteen native corpus pairs passed exact diagnostics, expected execution, and identical downstream binaries. Both actual init commands produced identical file trees. Whole-Harfrust source checks both passed with identical diagnostics. The full runner completed exit0 and reaped detached writers.

Supplemental runner: `.scratch/retained-supplemental-parity.py`; results pointer `.scratch/retained-supplemental-root.txt`. Six negative borrow/callable diagnostic cases and four declaration-order variants target representative-selection risks. All six negative pairs and all four order variants passed; runner completed exit0 and reaped detached writers. Results: `.scratch/benchmarks/supplemental-parity-o1iovq8x/results.json`. These order probes do not prove representative selection changed without tracing.

## Next integration

Port stabilized common finite Admission/FiniteBudget policy from parallel-check experiment, preserving command-wide budgets and source diagnostics. Replace old joinFrontier proof while retaining successful workers and key tables; build dispatch/lifecycle hooks already exist. Dynamic inherited-frontier scheduling comes before worker-local fork proxies. A fork proxy must retain children owning newly interned TypeIds; transient children cannot return usable local keys. Bound active compute to four CPU tokens and bound resident child memory.

All future benchmarks use exclusive `.scratch/performance.lock`; correctness/build runners use shared lock. At most two heavy jobs. Use this worktree's frozen stdlib, not current production stdlib.
