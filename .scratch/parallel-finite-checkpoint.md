# Accepted parallel finite-check prototype

Status: **3× is not achieved.** Both large cold-check workloads now complete the parallel path with no fallback. This is an isolated Linux prototype, not a production-ready change. No parallel build speedup is claimed here.

## Reproducible state

- Worktree: `/workspace/silk/.scratch/parallel-check-experiment`
- Local checkpoint branch: `codex/parallel-finite-check-experiment`
- Commit: `2e0c210b2` (`Prototype parallel finite specialization graph checking`), not pushed.
- Stable executable: `/workspace/silk/.scratch/frontier-finite-final`
- SHA256: `59e447ccd541732c41efb1cebf27e5e28d1d8f690d82261f40aee81eff8e4945`
- Build package: `.scratch/fork-candidate-package/silk.toml`; source symlink points at experiment. Use its own `stdlib` and `tomledit`, not the updated production paths.
- Earlier full source patch: `.scratch/frontier-finite-final-snapshot.patch`. Commit includes final test expectation corrections made after the behavior-identical binary snapshot.
- Enable: `SILK_EXPERIMENT_FRONTIER=1 SILK_FRONTIER_SHARED=1`. Disable both for the same-binary serial comparison.

## Measured cold checks

Two alternating pairs per workload, four-core quota, identical binary and frozen source snapshots; caches deleted before every invocation. An exclusive performance lock covered all runs, and detached cache writers were reaped before the next invocation. All four enabled runs explicitly logged `frontier accepted`.

| Workload | Serial foreground | Parallel foreground | Speedup | Serial settled | Parallel settled |
|---|---:|---:|---:|---:|---:|
| Compiler | 23.403 s | 16.389 s | 1.428× | 24.031 s | 16.757 s |
| Harfrust | 7.971 s | 4.158 s | 1.917× | 8.427 s | 4.469 s |

Aggregate CPU grows about46%: compiler24.76→36.24 CPU-seconds, Harfrust8.65→12.47. The compiler remains imbalanced: worker2 finishes module work at11.76 s, others5.31–6.49 s. Parent adoption finishes13.85 s after the split, including roughly1.2 s of graph extension. This is not close enough to the3× goal to stop structural work.

Raw data: `.scratch/frontier-finite-clean-comparison.json` and matching `frontier-finite-clean-{compiler,harfrust}-{0,1}-{off,on}.log/json`. Runner: `.scratch/frontier_finite_compare.py`, which calls `.scratch/frontier_single.py`. Sources are the frozen `transport-family-ctvjs_tx` snapshots, not current production HEAD.

Separate compiler memory audit: peak sampled aggregate PSS **4.63 GiB**, summed RSS6.30 GiB across parent, four workers and a small Python harness. Samples every100 ms, so short peaks can be missed; these wall times are not benchmark results. `.scratch/frontier-finite-pss-memory.json` and `frontier-finite-pss-run.json` preserve separate memory/runtime outputs.

## What now works

Forked resolver snapshots share an atomic128-bit definition-ownership table. Each owner lowers a provider-sensitive definition once. Module and runtime walks publish ephemeral graph captures independently of persistent-cache fitness; complete declaration sweeps still validate bodies. Parent merges by stable digests, verifies exact module/root coverage, and accepts only a complete closed graph with ordinary checked summaries, global escape safety and global resource accounting.

Workers remain alive on socketpairs. Command2 GraphExtend finds missing LEFT/EXTERNAL keys in retained/canonical key maps, walks their roots, returns more portable records, and repeats until complete. Compiler graph has47,156 full definitions; Harfrust20,546. Both need one extension round. Every round must increase full definitions; unknown keys/no progress/diagnostics cause serial fallback. Parent closes/reaps workers on both success and fallback.

Do not remove the canonical-key snapshot from GraphExtend yet. An attempted removal left one compiler placeholder unknown in all four visited-key maps (47155/47156 full nodes), correctly refused the proof, and fell back. Initial frontier placeholders can precede the normal rememberFrontier hook. Restoring the existing snapshot costs only tens of milliseconds and restored acceptance.

The user explicitly authorized finite specialization graphs. Common serial/check/build Admission now requires closedness and bounded canonical identity, not the old ancestor-shape rejection. Existing provider-sensitive definition interning and semantic call-site region/type/borrow/effect obligations remain intact. Exact graph cycles are finite even when generic arguments change. Resource failure is NotProven, not a proof of infinity.

Shared command-wide FiniteBudget limits are250000 unique definitions,4096 definitions per exact original function declaration,4000000 MIR reference slots and536870912 retained runtime-key bytes. Duplicate definitions charge maximum observed cost; revisions clear counts but preserve injected test limits. Live check, direct build, check/build replay and parent union use the same budget. Existing per-key32768 structural-unit/65536 search-state/8MiB encoding limits remain.

## Validation and corrected failures

- Focused graph/budget/identity tests:9/9.
- Selected source policy tests:9/9 in the final matrix, including finite polymorphic/continuation/opaque/cleanup positives and precise resource diagnostics. `.scratch/finite-policy-validation.md`.
- Eight native checks/builds: finite Inner→Outer→Outer cycle returns42; infinite type growth, static n+1 and cleanup growth all reject with SEM0053 in0.14–0.39 s,50–99 MB maximum per-process RSS. No timeout/crash. `.scratch/frontier-finite-smokes/results.json` (f12e binary before restoring only the canonical-key transport snapshot).
- Repeated differential corpus:18 cases,36/36 enabled runs split and exactly match complete structured serial output;20/20 valid runs accept and16/16 invalid runs explicitly fall back. `.scratch/frontier-finite-parity-repeated/{results.json,REVIEW.md}`. One independent corpus expectation mismatch is retained: `call-result-wrapper-payload-escape` produces a single SEM0212 instead of three listed errors, identically on stock N1-one and the new binary, both wrapped and unwrapped. It predates this change; the harness exit1 records that mismatch rather than hiding it.
- `git diff --check` passed before the checkpoint commit.

The400-reference identity test exposed a real host-stack overflow in the unoptimized Type rewrite dispatcher (47,400-byte frame). Splitting22 recursive variants into smaller helpers fixed it with unchanged identity limits. Its standalone production fix and regression were independently sourcechecked/tested; see `.scratch/type-stack-validation.md`.

Two preparation branches discarded CanonicalizationFailure.reason and emitted internal Undetermined. They now preserve Resource as SpecializationBudget/SEM0053; other canonical faults retain their prior classification. StaticClosure preserves Resource as NotProven. Synthetic cleanup initially lost its authored source: capturedEscapes now carries the prior authored span/module through generated glue, matching buildFrom, and stops after the first latched resource failure with capture unreplayable. Cleanup's real triggering edge is `return ()`, where implicit cleanup requests the next instance; tests assert that exact span.

## Important remaining work

1. **No production promotion yet.** Delete obsolete ancestry oracle command1, family/witness/context proof helpers and tests, dead Decision branches and old replay ancestry guards. Executed family/runtime/witness metadata production and per-step family allocation are already removed. Full deletion map: `.scratch/finite-admission-cleanup-audit.md`.
2. Update GEN-006/reference and all remaining semantic/corpus expectations consistently with the authorized finite-graph rule. Full suites have not been run on this combined prototype. Preserve exact semantic region/provider obligations and add the requested opposite-order lifetime/provider regressions.
3. Replace fixed modulo worker assignment with shared dynamic counters for inherited frontier tasks and module sweeps. All workers inherit initial keys; no new TypeId serialization is needed. Preserve inherited Leave markers; private descendants remain local. Static worker2 imbalance is the clearest current critical path.
4. Make ephemeral capture/transport independent of Graph.recording so CLI workers can use the separately validated Transient/coarse-cache design. Current full CacheImage persistence and duplicated query bookkeeping raise aggregate CPU; this must improve, not just wall-clock balance.
5. Integrate retained backend workers with this common finite policy/budget, preserving the exact owned MIR representative and real observing/frame/NonParking closure. The separate build prototype has broad output parity evidence but still needs that policy port: `.scratch/retained-build-checkpoint.md`.
6. Target-gate POSIX fork/socketpair/mmap implementation before cross-platform compilation; ordinary serial finite checking must remain available on other hosts. Current syscall declarations/flags are Linux experimental code.

Use `flock -x /workspace/silk/.scratch/performance.lock` for whole benchmark harnesses and shared `flock -s` for correctness/build runners. At most two heavy builds; never nest shared locks inside an exclusive harness. No active jobs remain from this agent.
