# Single-core cache cost review: V16/V17 evidence, V19 source

Read-only review. No compiler, new prototype, or new timing run. V16/V17 use mono O2 with a reused PGO profile; actual applied profile coverage is not fully known. N0-one is the pinned original baseline. V19 is four-unit O2 without PGO. Historical baseline comparisons establish user-visible regressions, but do not isolate source changes from construction. V19/V21 matched construction can isolate Bundle; V19's same-binary pipeline controls isolate pipeline policy. Do not compare absolute V17 and V19 times as an implementation A/B.

## Proven single-core effects

V16 settled-before-edit lane: `.scratch/benchmarks/integrated-incremental-t62b32h0/incremental-report.md` (40 calls, one pair each).

| Operation | Original → V16 foreground | Interpretation |
|---|---:|---|
| Compiler check first edit | 1.288 → 1.250 s | No first-edit regression once the cold writer has settled. |
| Compiler check second edit | 1.326 → 1.263 s | No repeated body-refill problem in this serial-produced cache. |
| Compiler check unchanged | 0.222 → 0.329 s | Genuine +107 ms foreground/CPU overhead; no writer tail. |
| Harf check first edit | 0.439 → 0.450 s | +11 ms foreground; settlement 0.834 → 0.892 s. |
| Harf build first edit | 0.988 → 1.103 s | +115 ms; coarse link phase 0.46 → 0.57 s accounts for most of this pair. Both lower 5 functions/borrow 8 bodies; semantic check 0.12 → 0.13 s. Do not attribute this build regression to cache adoption alone. |
| Unchanged builds | compiler 0.074 → 0.075; Harf 0.147 → 0.146 s | Artifact cache bypass remains near baseline. |

V17 immediate-edit CPU0 lane: `.scratch/benchmarks/immediate-edits-yjwhl9ga/{immediate-report.md,results.json}`. Both baseline and candidate launch their first check edit with the preceding cold writer still live.

| Check workload | First-edit foreground | Edited compiler own CPU | Previous cold writer user+system CPU |
|---|---:|---:|---:|
| Compiler | 1.882 → 2.682 s (+0.800) | 1.296 → 1.254 s (-0.042) | 0.904 → 1.740 s (+0.836) |
| Harf | 0.876 → 1.306 s (+0.430) | 0.445 → 0.453 s (+0.008) | 0.513 → 0.928 s (+0.416) |

Second immediate check edits are near baseline (compiler 2.011 → 2.006 s; Harf 0.918 → 0.882 s). This strongly attributes the alarming first-check-edit wall regression to preceding publication CPU competing on the same core, rather than extra edited-body work. It does not imply all cold gains are artificial: V16 compiler cold check settlement still improves 23.018 → 18.395 s and Harf 8.395 → 6.495 s. The extra delayed work is a smaller, but unacceptable, part of the total benefit.

V19's exact-child completion token is deliberately confined to accepted native build checkpoints. Ordinary `check` still uses `saveDetached` and explicitly disarms the token; therefore it does not repair this single-core check cost shift. Simply joining ordinary check writers would move the penalty back to cold foreground without removing CPU, so that is not the proposed optimization.

## Concrete source-level relocation

N0 `recordSourceInput` captured each new authored input when observed. V19 `recordSourceInput` instead calls `Inputs.addDeferred` in immutable Cached mode. `Semantic.cacheImageWithWalkRecords` calls `settleSourceInputs` before image graph assembly; it drains every pending observation through `captureInput`, canonical encoding, text capture, and hashing. In ordinary serial check this runs in the detached cache writer. Thus the code explicitly moved necessary authored fingerprint work from semantic foreground into publication.

Cold serial checks have no adopted image to carry. Consequently old-graph `CacheImage.carry`, shared-view expansion, and imported worker duplication cannot explain their cold writer increase. `compactDuplicateRoots` does not copy a clean unique-root image. These may matter for edited or parallel-produced images, but are not the first explanation for this CPU0 cold tail.

The V11 CPU sample provides supporting, not matched CPU0, attribution: fingerprint family 1.051 sampled user-CPU seconds; `Fingerprint.encodeNode` 0.576 seconds, entirely in late worker cache export. Parent merge only 0.354 seconds; publication Merge.add 0.141 seconds. Source: `.scratch/benchmarks/v11-cpu-check-dfy46d5e/REPORT.md`. Different version, four cores, shared correctness slot: it cannot assign a precise fraction of V17's +0.836/+0.416 writer CPU.

## Exact source-input census, and its limits

Offline breakdown of the existing seven same-stamp V14 dumps is saved as `.scratch/benchmarks/cache-work-v14-h12ixxhj/source-input-kind-summary.json`; parser `.scratch/source-input-kind-census.py`. No new compiler execution. It measures counts, not encoded bytes or weighted time.

| Potential expensive canonical operation | Pending observations | Exported | Unique exact key/value across dumps |
|---|---:|---:|---:|
| Declaration.Body | 29,368 | 25,334 | 17,353 |
| Declaration.Written | 45,731 | 43,796 | 20,519 |
| Declaration.Import | 15,422 | 13,078 | 4,747 |
| Location | 15,850 | 14,264 | 4,041 |
| Declaration.Directives | 49,315 | 42,464 | 22,384 |

Written, Import and Location all invoke `Fingerprint.header` for the declaration, with different outer observation frames. Their 77,003 same-worker uses name 61,670 distinct same-worker declarations: 15,333 repeated full-header encodings, before additional Selection/name header encodings. Body observations are already interned once per exact selector in each store, so the 12,015 cross-dump Body repetitions are principally a parallel-store opportunity, not a CPU0 opportunity.

Total pending: 717,861; exported: 632,813; unexported: 85,048 (11.85%). All unexported observations in this census belong to private descendants, while four original workers export every pending input. Therefore **this 12% does not demonstrate any saving for the single-core path**. Reachable-only settlement is sound work avoidance but needs a serial census before being sold as the CPU0 solution.

Large counts of cheap Alive/Identity/Arm facts must not be treated as equally expensive as full bodies. This census cannot rank total hash cost by type, and one body can dominate many small headers. The weighted V11 sample only attributes the combined fingerprint family.

## Available identities are not interchangeable

- `SourceRevision.Observation.digest` is already computed once for the entire immutable file. It safely shortcuts unchanged-file adoption, but replacing facet guards with it would invalidate unrelated declarations on every edit.
- `ModuleIndex.Fingerprints` are absent for immutable CLI indexes (`fingerprinted=false`). Even where present, they summarize significant tokens and replace directly nested declarations with identity; that differs from the HIR canonical facet contract. They cannot substitute for current Body/Written/Location hashes.
- MIR/type/instance identities summarize semantic results and context. They are not exact authored header/body observations and can ignore source changes a facet intentionally records.
- HIR header/body digest APIs currently rebuild canonical encodings; they are not stored reusable identities. Binder references are scoped to declaration preorder, so arbitrary subtree hash reuse needs binder-context handling.

## Concrete removal plan, conditional on the next measurements

1. **Prefer exact canonical facet reuse, not an eager prehash pass.** Introduce a demand-local memo owned by one immutable IndexedSource snapshot, keyed by declaration identity/ordinal plus exact encoding domain (Header, Body, Directives and relevant SourceSyntax projections). Reuse canonical header bytes among Written/Import/Location/Selection consumers, retaining their distinct outer selectors and location evidence. Memo only requested facets; no parent prehash-all, no cross-revision authority. Request/Resolution remain contextual and eager. This removes duplicate work rather than rescheduling it. Memory cost of retained full bytes and hashing their enclosing frames must be measured; a changed representation could use domain-tagged canonical digests with a cache/version bump, but must preserve exact facet semantics and is a separate design.
2. **Finalize only exported inputs as a secondary optimization.** Graph assembly can identify referenced SourceInput IDs and fill their exact digest/text once before publication; never write a placeholder digest. Preserve input identity/order, same held source snapshot, stable keys, transactional failure and complete guards. This avoids abandoned/private-prefix observations. It is not yet a proven CPU0 win.
3. **Keep publication representation work bounded.** Bundle may remove eager graph copying and reencoding, but it still calls settlement and adds validation/liveness/GC passes. Measure whole cold+first-edit CPU and bytes, not just parent exit or graph merge time. Existing V21 shared gate's OFF writer used ~4.05 user CPU seconds; that is a correctness-run diagnostic, not a causal benchmark, but cautions against assuming Bundle is already cheaper.
4. **Address the independent unchanged-check proof cost.** V16 CPU0 unchanged check has load 0.15 → 0.12 s but check 0.01 → 0.10 s, with start_sync36.1 ms, lsp/Command27.6 ms, Semantic20.7 ms and no Body/MIR work. V19 eagerly authenticates all candidate escape records in attachEscapeBudgets, walks each selected closure to establish green entries, and on demand again hashes/decodes answers and charges rows. The indexed budget path allocates a fresh duplicate-position InternIndex on every already-validated membership set. A typed authenticated unique-selection handle can remove repeat duplicate-set construction; per-adoption row-green witnesses and per-budget exact-row accounting witnesses can avoid repeated lookups/body equality on the same immutable row. Witnesses must bind image/payload identity, current green set, budget generation and rollback; different rows with the same definition still require original-body equality and maxima. Missing/corrupt evidence and tighter budgets must still refuse. Do not skip a whole check merely because a digest was charged elsewhere.

The historical V14 attribution measured 239 green candidates and 167,975 selected-row visits for 47,139 unique definitions; unchanged attach-budgets ~125 ms, indexed budget ~69.5 ms, but root-scan costs in that same profile were subsequently fixed and stages nest. These figures motivate the unique-selection/witness design, not an additive or current V19 speedup estimate.

Before another prototype, the useful narrow evidence is one CPU0 writer breakdown on the repaired candidate: settlement by selector family/canonical bytes, image assembly/carry, root pruning, encode/write; and unchanged green/budget visited rows versus first-time rows. Reuse existing phase hooks in one diagnostic binary. Compare final all-writer CPU, unchanged, direct first/second edit, and immediate cohorts under matched construction. No prewarm or forced full first edit may be used to make the cold result look better.
