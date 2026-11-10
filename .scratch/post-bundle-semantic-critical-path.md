# Semantic critical path after native overlap

Source-only reassessment during the V18 timing window. No compiler or benchmark was run. The evidence below spans V11/V13/V16/V17; it identifies mechanisms and bounds, not an additive forecast for V18 or CacheBundle.

## What the evidence rules out

The V17 original-baseline comparison remains below 3×: four-CPU compiler/Harf cold check22.188→9.304s and7.715→3.492s; build37.727→17.922s and11.348→5.508s. Editing also failed its gate. New V18 causal results must supersede those numbers.

The measured raw-packet transformation envelope is at most771ms compiler /478ms Harf before the new format's validation/liveness costs. Bundle cannot remove the entire post-proof phase. Module completion spread31/68ms gives ordinary chunk rescheduling little room. COMPLETE_MODULES eagerly traversed more bodies and regressed compiler/Harf about9%/6%. The completed-body registry is not a universal win: V17 controlled cold builds regressed2.3%/1.4% despite33,487 reuse hits. Removing the registry's overhead is not evidence that cross-worker duplicate typed work is absent, but repeats that experiment are not justified.

V11 samples put25.394 user CPU seconds in the initial worker phase, versus only0.778 parent CPU in cache/adoption. That is the largest remaining area, but neither sampling nor124,846 graph references over47,139 entries measures redundant query executions. Some repeated memberships are required for independently guarded module roots. Current evidence does not support calling the whole parallel-versus-serial CPU difference removable.

## 1. Turn mandatory closure completion into an exact-demand queue

Current source: `publishFrontier` completes assigned module/chunk work and publishes all fragments. Only after all workers report, `frontierComplete` unions them, calls `WalkFragments.missingBodies`, broadcasts command2 to every worker/descendant, receives every extension, and merges again. `frontierExtend` lowers the requested exact keys and preserves MIR evidence plus separate non-MIR read roots. Workers expand their canonical-key directory once because a placeholder can precede `rememberFrontier`.

Existing measurements: compiler has3,629–3,635 missing bodies; V16 merged→proved is approximately0.941s, Harf's939-body extension approximately0.183s. V11 samples attribute2.071 worker CPU seconds plus0.222 parent CPU to final-transport→proof. These are real late computations, not a proof-only serial bookkeeping tail.

A different schedule can publish an exact closure obligation when a completed capture first records a LEFT target. Keep that target's actual local InstanceKey at the publishing worker; retain a digest ticket plus supplier identity in a shared queue. Use the existing full-definition claim table so another worker's already-computed full node satisfies the ticket without lowering twice. A worker that has the key may process the obligation under an ordinary compute lease between tasks; workers without a portable key must not invent one or treat a ticket as completed. Empty module queues give closure work priority over optional artifact warming. A completed extension publishes its full facts and original MIR/non-MIR provenance, exactly as current command2 does.

This is NOT COMPLETE_MODULES: no new root is added merely because it belongs to a module. Only an exact key already reached by a completed selected capture is eligible. Initial module coverage, final root union, finite closure, escape checks, resource budget and selected cache evidence remain the final acceptance gate. Pending/in-flight/failed obligations must drain or fall back; there is no positive proof from queue emptiness alone. Retain command2 for unresolved inherited placeholders and partial-failure fallback until the new queue proves complete.

The possible gain is overlap of this measured late span with earlier work, not elimination of all2.071 CPU seconds. With four saturated workers, some work simply moves earlier and cannot improve the critical path. Both workload counts and the closure-tail difference make compiler the stronger candidate. Existing reports bound the affected late interval below roughly0.94/0.18s; they do not establish that all of it is hideable.

## 2. Prepare immutable authored fingerprints while the parent processes proof

Current source defers authored `SourceInputs` fingerprints in non-revisable stores, then a cache-export pass drains `resolver.sourceInputs.pending`, resolves the existing source/position, encodes the selected facet, hashes it and stores digest/text. Request and resolution facts remain eager. `serveFrontier` already has a command-priority, leased idle-work loop for optional artifact warming; fingerprint preparation can use that scheduling mechanism without demanding new semantic queries.

V11 late cache/adoption samples include0.576CPU in Fingerprint.encodeNode and0.131 in appendLength, plus related ContentHash work. The reported fingerprint family is about1.05CPU across the check. Raw packet worker image-build CPU totals2.614s compiler /1.271s Harf; individual ranges234–638ms /55–286ms. The parent currently cannot request final selected packet encoding until it has complete proof and selected exact roots, but the content of an already-read authored facet is immutable and does not depend on that final directory.

Split preparation from export: incrementally finalize pending authored observations while a worker is READY and the coordinator merges/validates initial evidence. Check control readiness between bounded facets and return leases promptly; a large single authored body is the practical preemption boundary. Keep encoding and graph selection after the ordinary exact selected-root request. Never speculate Request/Resolution facts, alter source selectors, stamp old guards current, skip required recorder edges, or eagerly capture an entire module. Any newly demanded extension inputs remain pending for the final normal drain. Preparation failure must leave an observation pending, never publish a zero digest as complete.

A stronger cross-worker immutable-facet memo would need exact source revision/module/selector identity, not worker-local handle or the eventual semantic digest alone. Existing evidence has no exact duplicate-facet census, so that format/shared-memory extension should wait; simple preparation overlap is independently testable. This remains bounded by the measured worker preparation tail, not the entire parent merge or the whole1.5s post-proof interval. It is complementary to Bundle only where Bundle leaves worker-side fingerprint work intact.

## Larger uncertainty worth measuring before another architecture rewrite

A cross-worker typed-query owner/service could eliminate actual duplicate Body/Signature/Layout work, unlike the completed graph registry. It would also require portable typed values or a shared arena, exact per-query dependencies/diagnostics and cycle/failure handling. Current flat samples do not supply a benefit estimate. Before that investment, instrument exact stable query identity, family and provider execution (not demand/reference counts), with pid/supplier and cumulative provider time. Distinguish required generic-template checks from concrete-instance lowering, and initial in-flight duplicates from repeated graph traversal. This is a diagnostic proposal only; no hook was added or run.

## Evidence

- `.scratch/v17-performance-results.md`
- `.scratch/benchmarks/v11-cpu-check-dfy46d5e/REPORT.md` and `phases.json`
- `.scratch/benchmarks/v13-cpu-build-cw3f9tud/REPORT.md`
- `.scratch/benchmarks/cache-packet-census-sj2akl4f/REPORT.md`
- Current `Semantic.publishFrontier`, `frontierComplete`, `frontierExtend`, `serveFrontier`, `recordSourceInput` and pending-input drain.

Native streaming of selected, fully prepared module/shard emission groups is being audited separately by build_pipeline. Its benefit must not be counted again as semantic closure/cache preparation overlap.
