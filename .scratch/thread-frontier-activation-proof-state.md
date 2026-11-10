# Native thread scheduler activation checkpoint

Source: `f595e23f13757fd16d9555ca88d26c7134ae74ea` in `.scratch/thread-frontier-prototype`.

Full package sourcecheck passed at `1d9d68e90`; subsequent changes only moved the assigned-sweep filter before encoding and corrected test calls for immutable controller access. The complete Semantic and imports compiled again for this native runner.

**13 selected, 13 executed, 0 cached. All processes and writers reaped.**

The scheduler fixture launches four real private stores, validates one runtime record and complete unique module coverage, rejects an invalid callee, and joins both success/refusal. The separate body fixture proves provider avoidance and exact cache invalidation when a callee signature or roster changes while caller bytes stay unchanged. Other gates cover channel cancellation/early exit, unique dynamic tasks, portable immutable seed reconstruction, shared ready syntax, thread-safe published body/type ownership, and interner race/collision/canonical-memo isolation.

| Filter | Executed |
| --- | ---: |
| `directThread` | 3 |
| `threadFrontier` | 3 |
| `threadInstanceSeedsPreserveCanonicalTasksAndPrivateCaches` | 1 |
| `sourceEpochKeepsExactSnapshotsAndPrivateCursors` | 1 |
| `nativeSourceStoresShareOnlyCompletedSyntax` | 1 |
| `nativeThreadsShareCompletedBodiesAndCanonicalTypes` | 1 |
| `runtimeSnapshotsSurvivePublicationAndAllowNestedReads` | 1 |
| `concurrentIntern` | 2 |

Receipt: `.scratch/thread-frontier-activation-f595e23f1-focused.json`; all eight raw filter logs and the runner remain preserved.

Not yet validated: optimized CLI activation on realistic >32-module inputs; retained graph/emission/cache commands 2–7; full native output and cold/direct-edit/unchanged/immediate-writer parity; CPU0 opt-in refusal; matching-construction V22 vs thread-source CPU0 costs. No performance or promotion claim. Four-core warm commands currently choose the common interner before cache eligibility is known, an explicit incremental cost risk. First native lane joins before native coordinator/cache-writer forks, intentionally foregoing process-lane native/proof overlap.

## First optimized CLI candidate

Four-unit O2/no-PGO construction succeeded at f595e23f1. Frozen binary `.scratch/frontier-native-threads-v1`, SHA256 `a2ad27db222cad249a8654b5cc1a5c83dbb8ecb0445eea845a9513c680918e55`; construction recipe/result `.scratch/thread-frontier-bootstrap.py` and `.scratch/thread-frontier-build.json`.

First ordinary CLI build stopped at the engagement assertion: program returned42 but no native pool was started. Preserved `.scratch/benchmarks/thread-frontier-native-t9cp7qxs`. Source audit found buildArtifactHeld still required the process-only frontierExperiment flag before calling checkRuntime; thread-only opt-in did not enter that branch. This is an activation wiring failure, not successful scheduler validation. Worker owner is repairing that narrow gate. No speed claim or further automatic run.

The separately authorized fresh V1 CLI **check** engagement passed with normal admission: all four stores performed actual tasks (37/1/1/3), exactly one runtime record and42 covered modules, accepted global graph,614 imported cache roots and persisted runtime subset. All writers reaped. Evidence `.scratch/benchmarks/thread-frontier-check-iggqzjyo`. No typed-body avoidance occurred in this disjoint tiny workload; the focused crossmodule producer/consumer fixture proves that mechanism separately. This isolates the initial CLI build failure to its process-only entry gate.

## Repaired activation source

Full package sourcecheck passed at38607d988; final fixture-only2b5f85c42 passed **14 selected/executed, zero cached**. All processes/writers reaped. Exact receipt `.scratch/thread-frontier-activation-2b5f85c42-focused.json`. Production adds independent thread build opt-in, cold/admitted-only registry creation, and nonallocating post-join marker. The new warm fixture explicitly demands the changed callee body (an unchanged caller legitimately stays green), proving no ready directory, registry counters or imported guard memos on dormant misses. No V2 optimized binary or real retained-build engagement yet.

## V2 frozen candidate and first CLI lifecycle

Final source `24b4735cea271a1900c5e3a2b29f3a5a1e152cb4` passed full sourcecheck and14/14 executed native tests, including refusal of inconsistent pre-existing input evidence without overwriting it. Frozen `.scratch/frontier-native-threads-v2` SHA256 `25e928bb8f4ea75106e0e012ff14d3ec9e37d3ad9f2a263dcd10eb2cd585bd71`; four-unit O2/noPGO, pinned N1/Clang. Construction metadata `.scratch/frontier-native-threads-v2.json`.

First normal-admission CLI build lifecycle10/10 passed and reaped: `.scratch/benchmarks/thread-frontier-native-fmrl_lza/results.json`. Four native stores replied, global frontier/artifact/cache proof accepted, exact post-join marker emitted, program returned42. Direct first/second edits and unchanged command used cache without restarting workers; every positive executable was byte-identical to a fresh serial build and returned44/46. Invalid edit matched ordered primary diagnostic code/location with exit1; all detached writers exited0. These are correctness controls against fresh serial caches, **not speed ratios**.

CPU0 automatic fallback, reverse provider-order/observer/suspension, complete structured boundary diagnostics, full original compiler/Harf engagement and meaningful performance controls remain outstanding. No promotion or3x claim.

## V2 complete CLI correctness gate

**64/64 normal-admission CLI calls passed; all commands and detached writers reaped.** No forced workload threshold or process-frontier flag. Summary `.scratch/thread-frontier-v2-correctness-summary.json`.

| Gate | Calls | Evidence |
| --- | ---: | --- |
| Initial native lifecycle |10|`thread-frontier-native-fmrl_lza`|
| CPU0 automatic opt-in refusal, check/build |4|`thread-frontier-host-gate-k40joc6l`|
| Reversed provider order, observer, suspension |30|`thread-frontier-native-4wq0r640`|
| Full JSON boundary/application lifecycle |20|`thread-frontier-boundary-r7o9wrnw`|

Positive native artifacts match fresh serial ELF bytes and runtime results; direct first/second edits and unchanged stages do not restart pools. Invalid native edits match ordered primary diagnostics. Separate boundary gate matches complete ordered JSON including related spans, shifted offsets and application switches. Observer cold path performed actual observing restart, emitted332 definitions and imported980 cache roots; suspension preserved explicit fallback and check-cache evidence. CPU0 explicit THREADS opt-in automatically refused workers and matched serial artifacts.

This remains correctness evidence, not comparative performance: fresh serial controls intentionally discard caches. Full original compiler/Harf engagement, task imbalance, actual body avoidance, and cold/direct/immediate-edit/unchanged CPU0+four-core costs are now assigned to profiling under root scheduling. All execution slots released.

## Performance disposition

Root's controlled four-core V22→V2 comparison rejects this candidate as a package: coldcheck11.531→15.888s (+37.8%, CPU+5.4%); coldbuild19.671→27.803s (+41.3%, CPU+11.3%); second build edit+19.3%. CPU0 is still being measured by profiling. Passing correctness64 does not imply performance acceptance. Runtime/extension donation, quiescence, two-pass join, and safe overlap alternatives are documented source-only in `.scratch/thread-frontier-next-design.md`; no next worktree or implementation was started. Root explicitly parked scheduler implementation while pursuing other structural work.
