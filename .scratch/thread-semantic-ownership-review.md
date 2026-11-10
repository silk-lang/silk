# Thread V2 semantic ownership review

Source: `thread-frontier-prototype`, tested V2 `24b4735ce`. Read-only review; no compiler or benchmark run. Evidence: `benchmarks/threads-engagement-woz6nq1y/build.log`.

## What the counters establish

Initial four stores own 43,281 and skip 59,796 MIR visits. These are capture visits, not distinct providers: the same owner can revisit a completed MIR from another module capture. The global exact claim precedes `demandInstanceMir` (Semantic around 100190), so another owner normally does not lower that reached MIR again. Body avoided rises from 3,245 initial to 4,419 final; 6,717 published, 23,467 eligible, 12,330 refused.

The last ratio is NOT a 53% lookup refusal rate. Eligible counts admitted Body provider misses. Refused combines failed import before local computation and failed publication after local computation, potentially twice for one demand. Ready-directory misses and insertion/body-node-cap refusals are not included. Publication conflates unsupported contextual dependencies, noncurrent nodes, opaque ModuleCheck, demand-path conditions, cycles, depth/work limits, guard memory limit, and unsupported leaf forms. No measured breakdown exists.

`threadGuardUnit` checks depth/work budget and decrements work before consulting its memo. A failed child leaves the parent Entered; contextual resource failure can therefore become a permanent negative result for later shallower roots. This is conservative but may reduce coverage. Do not infer that all recorded refusals are unavoidable semantic constraints or increase limits without attribution.

## Work before and after MIR ownership

Before claim: remember/hash instance; foreign/header check; current walk boundary; closedness; owned-definition dedup; exact digest. After a losing claim: `BuildCapture.reached` calls `enter`, which rebuilds key facts, declaration bytes, and a capture row. Only successful owned full visits enter `definitionVisited`; repeated EXTERNAL/LEFT/FOREIGN targets are not deduplicated there.

After successful claim: MIR lookup/provider, source anchoring, `SuspensionSummary.make` scans CFG blocks/statements, summary encoding/hashing, reference identity/edge encoding, and reverse-order pending-reference construction. A completed MIR avoids lowering but does not avoid these repeated per-capture scans/encodings.

Possible bounded follow-up is per-capture terminal-placeholder interning, preserving root order and every reference edge while interning a terminal target row. It must preserve LEFT resumption/promotion and first-origin diagnostics; blindly marking LEFT visited is wrong. Existing counts do not establish how many placeholders repeat or the saved CPU.

## Why completed MIR sharing is not the next obvious step

Ownership already avoids many duplicate lowering providers. MirFunction additionally embeds nontransferable InstanceKey cache fields throughout references, call terminators, addresses, and helper metadata. Helper MIR lookup relies on creator-relative private mirValues positions. Observer/coroutine variants, exact dependency evidence and generated-helper lifetime would all need explicit representation. Publishing MirFunction as if it were already a transferable TypedBody is not sound. A finalized immutable MIR lane may supply that representation later, but its benefit must be established independently of skipped-visit counters.

## Opaque shared guard: concrete integration map

Current `importThreadGuard` (11179) turns every Published guard node into a local key plus synthetic ModuleCheck-8 graph node, then `imageUnit` (11768) traverses and recreates that DAG in the cache image. A narrow alternative retains one opaque Published guard root per imported identity and exports the shared DAG directly with an ImageBuild-local identity memo. It is not safe to publish an empty ordinary synthetic graph node and patch only serialization.

Required consumers/conditions:

- `importThreadBody`/`publishThreadBody` (11156–11290): retain completed-only, same SourceEpoch/type pool/target/final-profile/application authority; no condition/private-origin/opaque-adopted checks. Preserve exact Request/Resolution validation and existing-input digest consistency before reuse. Authored values may stay deferred only because the retained epoch is immutable.
- `threadGuardUnit` (11116): recognize and retain an imported opaque root directly; never reinterpret it as an empty proof. Strong Published ownership prevents address reuse. Bounds/cycle/failed-publication behavior remain explicit.
- `imageUnit`/`imageLeaf` (11700–11830): direct guard export must rebind stable declaration handles, serialize all conjunction children, preserve exact source/request leaf evidence and file links, and memoize only within the current image/epoch. Cache node indices are not shared identities. Any failed leaf withholds the root.
- `settleSourceInputs` (8809): export currently assumes authored observations were settled before image construction. Lazy export must either enumerate/rebind needed authored leaves before this phase, or authenticate and encode them on demand without silently serializing deferred zero digests. Preserve text hash and declaration position used by adoption.
- `reachesSource` (7360), public `answerRead`, `sourcesRead`, `requestDiscovered` (95478–95530): descend the opaque proof or answer from an exact retained source-membership index. Do not make imported bodies appear independent of their callee's source.
- `reachesDemand`/`requestDemanded` (7338/95379): the current shared guard already drops original query-family identity, so preserve that documented limitation rather than inventing provenance. Any expansion of this API's guarantees needs additional metadata.
- `verifyUnit`/`bringCurrent` (12126): an opaque root must never be verified as current merely because it has no local children. Immutable epoch/context is its authority; if that authority can change, invalidate or refuse the imported answer. `DependencyGraph.sourceChanged/inputChanged` rely on reverse local edges that would no longer exist.
- `threadRequestChanged`, profile/source revision/reset/adoption paths: retain immutable-only admission and ensure old opaque roots cannot authorize a changed context. Detaching future registry lookup alone does not invalidate already-completed query answers. Existing setup setters are pre-demand configuration APIs; do not claim new post-query mutation support.
- `frontierNonMirReadsAt` (113125): preserve the dependency on the opaque root while separating only represented exact MIR roots. Do not strip it as incidental bookkeeping.
- `emittedLayoutEdges` (11835): currently examines immediate Layout children. Do not generalize opaque sharing to EmissionInputs without preserving those exact layout roots; Body-only sharing does not require changing that path.

Minimal regression gate: actual threaded body import; source-dependency introspection; cache export/adopt then unchanged-own-body cross-module signature/provider/roster edits; application/profile mismatch and existing-input mismatch refusal; repeated exports; failed export/retry; producer store destruction while Published root stays retained. No implementation proposed until root coordinates the scheduler and proof-plan lanes.

## CheckedRuntimePlan review map

This is the stronger architectural work-avoidance opportunity if it makes executable CFG construction unnecessary for check, rather than merely renaming an MIR summary.

The authoritative plan must preserve the following consumers:

- `SuspensionSummary.make` (107671): post-coalesce block/statement order of direct call targets and origins; fixed-linkage function-address callbacks; indirect addresses excluding start helpers; Drop glue; package-glue address targets. A set of HIR calls is not equivalent.
- Function metadata: observes, suspension, parks, nonParking callees/glues/declarations/exactness, shared-access callbacks, escape kind, and releasesPackages. Preserve generated Storage/DropGlue/Helper/Export cases and observer variants.
- `BuildCapture.walked/references` (107080–107160): direct callees map to ordered reference positions, and exact target/Edge encodings feed finite and callback proofs. Preserve actual concrete provider and cleanup edges, not declaration-only approximations.
- `summaryDigest` (107265): all semantic fields above, including multiplicity/order and region-pattern policy. Keep raw BodyOrigin in a reusable plan; anchoring and toolchain-call relocation depend on the current requester and must remain per-walk.
- `includeAnswerBudget` (96900): exact reference count, definition identity, runtime key bytes, and per-body charging/rollback. A smaller plan representation must not reduce semantic specialization charges.
- `verifyLowered` (73712): explicit verifyMir performs CFG freshness/use-after-drop checks and can demand semantic cleanup facts. Keep full lowering in this mode unless a separately equivalent verifier is provided.

First correctness comparison should assert plan-produced references, summary digest/facts and ordered diagnostics equal the existing MIR path for normal/generic/provider, cleanup, callback, nonParking, package-release, observer, static branch and coroutine cases; then run the existing source-edit and finite/global-budget gates. Scheduler donation addresses the measured runtime tail separately and should not be conflated with plan CPU savings.
