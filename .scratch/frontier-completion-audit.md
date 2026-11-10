# Frontier completion audit

Read-only audit of integration after V12 freeze; no implementation or compiler jobs. Evidence: `.scratch/benchmarks/v11-cpu-check-dfy46d5e/{REPORT.md,spec.json,trace-arrival.jsonl}`. Profile is contended CPU attribution, not an authoritative wall-time measurement.

## Why 3,629 bodies were missing

The actual sampled environment omits `SILK_FRONTIER_COMPLETE_MODULES` and `SILK_FRONTIER_RESHARE`. With bounded checking, `capturedEscapesTimed` puts cross-boundary functions into LEFT before ownership is claimed. Runtime boundaries may leave non-static application instances; module boundaries leave plain functions to their own module checks. A module declaration sweep and a concrete call graph need not introduce identical specialization keys, so the union of those bounded captures is not necessarily closed. Inherited warm-prefix LEFT entries survive the fork. Private donor cuts and cross-worker claims also produce EXTERNAL placeholders, but those normally resolve against another successful worker's full capture; sparse inherited entries rely on the ancestor's retained full prefix.

`WalkFragments.missingBodies` lists unresolved LEFT/EXTERNAL entries after merging. The trace alone cannot classify the 3,629 entries by those origins; do not attribute all of them to inherited prefix or donation. Command2 broadcasts them to every retained store, expands each store's canonical-key roster once, and starts unbounded walks wherever a key is known. Six stores matched 5,821 requested roots (928+1162+750+1426+686+869). Shared claims prevent different owners lowering the same claimed body, but do not avoid redundant lookup, root capture, and same-owner repeat traversal. One extension round closed the final 47,139-entry graph.

The corrected complete-module path already removes the main cause: original pool children unbound the coordinator's inherited runtime frame, every worker module/chunk walk is unbounded, and pending-empty drains inherited LEFT visits. Keep parent finite closure, selected callback proof, exact coverage, and budget validation. Complete mode is eager scheduling of closure the parent already demands, not permission to skip proof. Measure this mode before building another scheduler.

## Descendant idleness

Children6 and4 finished runtime at trace epochs3.117s and3.849s, then published immediately with zero module tasks/chunks. `publishFrontier` explicitly restricts the common module/chunk loop to `frontierWorker < 4`; only the original fork frame can donate, and descendants cannot donate again. Shared module cursor/chunk mappings and inherited module ordinals would technically allow descendants to participate, and proxy publication already concatenates arbitrary child roots. A change must preserve exact per-module/chunk ownership, root coverage, module read evidence, publication completion and abort/reap behavior; runtime-only children cannot claim a module answer merely from inherited runtime proof.

However all four original workers remained busy until about8s: root0 ran runtime to7.859s while roots1/2/3 consumed module work. There is no evidence of unused compute capacity during that interval. The fixed four leases would make a newly active child displace a root, not add throughput. Different store locality or better straggler scheduling could help, but children being idle is not itself a demonstrated bottleneck. Late private runtime resharing can help only when a compute lease is actually free; the sample had reshare disabled.

## Recommended next work-avoidance candidate

After measuring complete mode, evaluate a worker-local, pool-lifetime registry of fully retained body proof/evidence. `claimFrontier` currently accepts an already-claimed digest again when it belongs to the same worker. Each fresh module/chunk capture resets its visited set, so an owner can repeatedly demand already-resident MIR, build suspension summaries, enumerate references, and record capture/provenance for the same body. Different workers already skip such an owned body with an EXTERNAL placeholder. Apply equivalent reuse to later captures within the owning worker, retaining roots/origins and one full supplying record.

Correctness conditions:

- Register only a successful full body with immutable exact identity, complete MIR references and summary, and retained MIR query evidence. A claim, inherited key, partial capture, LEFT/EXTERNAL row, or backend representative alone is not completion.
- The supplying record must remain in the eventual initial/extension proof union and command7 evidence export. Do not skip merely because MIR exists in the resolver: it may have been demanded during typing without a graph capture.
- Every new module/chunk keeps its concrete root identities, names/declaration roster, answer, non-MIR reads and warning sites. A repeated body can be EXTERNAL only because parent selected closure reconstructs it from the retained supplier, with destination-relative boundary/application semantics and exact per-entry guards.
- Retain all referenced visits until their work is drained or owned elsewhere. Preserve full finite/callback closure and transactional specialization budgets; incomplete/error/OOM/child-exit paths must refuse and recompute serially.
- Scope the registry to an immutable pool invocation. Clear it on coordinator reset/revision, and ensure inherited registry entries refer to an ancestor capture still guaranteed in the union. Use one canonical definition identity consistent with existing claims/merge rules.
- Extend regression coverage to repeated roots in different chunks, callback targets across the cut, altered application boundary, invalid/body edits, failed child and failed publication; compare diagnostics and cold-to-first-edit cache behavior.

This avoids work rather than merely distributing it. Its benefit is currently a source-supported hypothesis: neither the3,629 missing-body count nor124,846 record references proves how many same-owner full traversals repeat. A narrow counter of completed-owner revisit events and summaries built would establish the opportunity before promotion. Do not drop fine-cache recording: the2.75 worker CPU seconds after proof includes necessary reusable evidence and lazy source fingerprints, and extension evidence has no standalone reusable check roots.
