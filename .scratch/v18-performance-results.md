# V18 same-binary pipeline result

Candidate `.scratch/frontier-native-checkpoint-diagnostic`, source `2d2d0e5ed449448a8b48248eaa39ac75e1c7b9ab`, SHA256 `b0c3ae6b19a3745ffd42185e0fd69ce35ab6d44c993b7591433c0b0546d7e9ba`. Construction: four O2 codegen units, no PGO. **Absolute times are not directly comparable with V17 mono-PGO.** Only pipeline OFF/ON within this frozen binary is causal evidence.

Four execution CPUs; compiler and Harf workloads use original frozen baseline sources/stdlib. Registry OFF in both modes; all normal frontier/shared/private/chunk/cache/packing flags are identical. Two rounds reverse OFF/ON order. Each cohort runs cold→first edit→second edit without waiting for a prior writer before editing. Independent supervisors preserve writer attribution. Actual source mutation, launch gaps and prior-descendant liveness are recorded.

**24/24 timed invocations passed correctness; all 24 detached writers and supervisors were reaped.** Every cold ON run emitted exactly one checkpoint ordered coordinator start→cache checkpoint→native publication. OFF and edited runs emitted none. Artifacts and full ordered diagnostics match OFF/ON; warm edits never refork. No measured interval or cohort was paused.

| Workload | Cold foreground OFF → ON | Cold settled OFF → ON | First edit foreground OFF → ON | First edit settled OFF → ON | Complete cohort OFF → ON |
|---|---:|---:|---:|---:|---:|
| Compiler |21.154→20.225s (4.4% faster)|21.166→20.237s (4.4% faster)|3.035→3.020s (near parity)|3.551→3.557s (near parity)|27.463→26.568s (3.2% faster)|
| Harf |7.101→6.426s (9.4% faster)|7.113→6.832s (3.9% faster)|0.812→1.097s (**35.1% slower**)|1.030→1.296s (**25.8% slower**)|8.965→8.558s (4.5% faster)|

Compiler first edits observed no live prior writer in either policy, so the early checkpoint removes that measured penalty. Harf first edits still observed a live prior writer in both ON rounds and none in OFF. Its checkpoint does not provide enough overlap to finish persistence before foreground exit; substantial first-edit cost remains shifted out of the cold foreground. Second edits are near parity.

The pipeline is therefore **not yet a universal regression-free default**. Harf's cold settled result remains faster, so completing any residual checkpoint writer before final command return is a candidate fix to test. This report does not claim that unimplemented policy works.

Full evidence: `.scratch/benchmarks/immediate-pipeline-ko4h80_b/immediate-pipeline-report.md`, adjacent metadata, construction pins, paired ratios, logs and results. These are two paired rounds, not confidence estimates.

CPU0 baseline diagnostics were prepared but **not run**, per root steering: the diagnostic construction differs from the prior mono-PGO candidate. Existing V17 one-core regressions remain flagged pending a comparable-construction acceptance candidate. Native CPU0 refusal correctness already passed separately.

Exclusive performance ownership was explicitly released after every process exited. No timing jobs remain. Before timing, completed V17 duplicate source snapshots were pruned with per-file SHA receipts; 15 old completed test runners were archived losslessly with decompressed SHA/mode/path receipts in `.scratch/pre-v18-performance-runner-archives.json`. Frozen compiler binaries and measurement evidence were retained.
