# Native packing: evidence and candidate design (not implemented)

## Corrected observation

V11 preserved artifact manifests already establish that the benchmark help-text edit adds exactly ONE new cached native object in both baseline and candidate, on both one-CPU and four-CPU lanes. The 357 emitted compiler functions do not mean 357 changed object files. The remaining regression is plausibly unrelated definitions sharing that one dirty unit.

| Workload | Original cold objects | V11 global cold objects | Original new edited object | V11 new edited object |
| --- | ---: | ---: | ---: | ---: |
| Compiler | 517 | 32 | 0.426 MiB | 1.876 MiB |
| Harfrust CLI | 192 | 8 | 0.074 MiB | 1.592 MiB |

Evidence: `integrated-incremental-opceg23d` and `integrated-incremental-uxdcjhol` artifact manifests under `.scratch/benchmarks`. Counts are preserved `.o` file deltas, not inferred Clang invocation counts. Native capture will establish exact compile/link calls, input bytes, child CPU, and dirty group membership.

`assembleUnits` normally partitions by defining ModuleId, then by symbol hash with a per-module power-of-two shard count targeting **1 MiB** (`unitShardBytes`). `devPackedGroups` replaces every definition's module ordinal with zero and uses a global power-of-two symbol-bucket count targeting **4 MiB**. The codegen cache keys objects by Clang identity/flags, head bytes, and body digest; unchanged units remain reusable even if earlier units change.

## Capture methodology

Exact V11 binary, CPU0, serial worker policy; toggle only presence of `SILK_EXPERIMENT_DEV_PACKS`. Each mode starts with empty build cache and immediately edits once, without an unchanged call. Compiler is measured first, Harfrust second. Stable wrapper path and per-stage sidecar configuration avoid changing Clang identity. Cold metadata capture omits input copies; edited capture retains bitcode for definitions/debug-file attribution. A first attempt failed before Clang because the compiler intentionally strips arbitrary tool environment variables; its failed log is retained and no timing claim comes from it.

The Python wrapper adds startup overhead per invocation. Cold whole-command time is diagnostic-only, particularly when comparing hundreds versus tens of calls. Native child wall/CPU excludes Python startup, and comparable edited calls provide the narrower causal comparison. Every compiler and cache writer is reaped before advancing.

## Candidate algorithm, contingent on capture

1. Keep large modules on existing **1 MiB** local symbol shards. Increasing this to4 MiB would itself worsen edit collateral relative to baseline.
2. Keep each small module intact. Group only modules of the same full package/source-origin identity, with a target of1 MiB per group. This avoids the current cross-package mixing without pretending workspace dependencies are immutable.
3. Use deterministic module-hash prefix partitioning, splitting only an overflowing leaf. Do not use global byte-total bucket counts or greedy size-sorted bins: a small body-size change can then rebucket unrelated modules across the program/package. Prefix partitioning bounds a threshold-crossing edit's regrouping to its old leaf. At exhausted hash bits/collisions, fall back to separate exact ModuleIds, not an infinite split or incorrect identity merge.
4. Preserve existing canonical definition order inside each group and first-definition unit order. Keep tail objects/retained roots separate, and preserve held-pack matching. Cached object names depend on actual unit contents, not transient group ordinals.

An alternative is to preserve all current-package units and group dependencies more aggressively. Existing `resolver.currentApplication`, ModuleId.samePackage and sameOrigin support this mechanically, but package membership does **not** prove immutability. It may improve these application edits while penalizing local workspace dependency edits; that tradeoff requires a dependency-edit fixture and explicit measurement. The general per-package coherent1 MiB grouping is a better initial candidate unless dirty membership contradicts it.

## Required evidence before implementation

- Native capture: exactly how many units/link commands change, their bitcode bytes and child CPU, and how many unrelated modules/functions share the dirty unit.
- Cold compile-call savings expected from grouped small modules, without extrapolating wrapper-contaminated command time.
- Stability tests for a body edit below a grouping threshold, a threshold crossing, a module add/remove, hash collisions, and discovery-order permutation.
- Native output/diagnostic parity plus cold/direct-first/second-edit timing on one and four CPUs.
- An edit in a workspace dependency, not only the entry package, if an ownership-specific grouping policy is chosen.

No compiler source changes have been made for this proposal. PGO construction screening remains prepared separately.
