# CacheBundle semantic producer checkpoint

Tree: `/workspace/silk/.scratch/cache-bundle-source`.
Status: source-only implementation in progress; no compiler or runtime validation yet.

## Producer and proof path

- `ImageBuild.image`, `Semantic.cacheImage` and `completeCacheImage` use the common `CacheBundle.Bundle` representation.
- Fresh query nodes use global virtual node/leaf IDs. `imageCarriedChecks` receives selected carried root node IDs directly; it still withholds queries whose required dependency cannot be exported.
- `composeEscapeGuard` imports only immutable dependency graphs through `appendGraph`. It does not publish the prior record answer, which could otherwise replace a rebuilt narrower trace.
- `carryFrontierReads` preserves old record and exact MIR roots plus their referenced graph blobs. Missing required inherited evidence still refuses publication.
- Worker packets contain complete bundle envelopes, including carried shards when a worker reused prior proof. Parent collection validates the envelope, filters partition-only roots, and combines exact first-authoritative root directories with `collectSelected`.
- `fetchFrontierCache` still drains every dispatched worker reply before returning failure. No locally accumulated partial bundle is adopted after a bad reply.
- `completeFrontierChecks` retains the existing closure, exact MIR, root-read, application, and complete-sweep proof rules. Only storage operations change from dense graph copying to coordinator edges.
- `appendFrontierImage` preserves selected root order and duplicate ordinal associations. Sticky corrupt-generation refusal prevents a later import from rebinding stale indexes.

## Warm evidence and authority

Final publication normalizes duplicate stable root keys with fresh-first authority before computing carried-source liveness. Root ordinal associations in the active held bundle are not renumbered.

`imageCarriedFiles` retains the previous selector/digest/position validation algorithm, but records scalar evidence overlays instead of mutating immutable shard bytes. It visits only the selected live closure. It never updates an old whole-file guard merely because some input remains equal. Inputs with a changed observed digest retain the explicit changed-input sentinel.

Fresh file digests are finished through the same overlay API: an inherited guard import may have sealed the fresh segment before `fileDigests` runs. This preserves the late-digest behavior without modifying shared data.

Codec/adoption requirements surfaced during implementation:

1. Selected-root liveness must include input file references and exclude shadowed/dead roots.
2. Overlay file IDs may point to a later global file leaf; query-node dependencies remain acyclic and earlier-only.
3. Worker transport stamp and driver persistence stamp differ. Immutable parts retain their original authenticated local stamp under the current outer bundle envelope.
4. Repeated guard imports must reuse one exact source snapshot translation; address/generation-only memoization is insufficient for divergent copied branches.

## Focused tests prepared

Existing worker packet, exact root selection, sticky failed-adoption import, application-boundary, and graph-blob liveness fixtures are migrated to Bundle APIs. Transport assertions compare exact root answers and traversed dependency evidence rather than requiring the physical bytes of distinct shard layouts to match.

New `cacheBundleGuardCompositionPreservesInheritedAndFreshEvidence` verifies inherited and fresh dependencies both survive, old superset answers remain unpublished, missing inherited evidence refuses, late file digest finishing is isolated, and encode/decode retains the combined proof.

Expected removable work remains bounded by the diagnostic census: at most 771 ms compiler / 478 ms Harf foreground transform span before new validation/liveness costs. This checkpoint establishes no speed gain. Raw shard payloads were 35% / 49% larger than final dense persisted stores before coordinator metadata.

External caller migration is also prepared: `CacheAdoptCases.silk` uses Bundle and the final producer API; `CacheImageCases.silk` preserves its local codec/Merge tests through a private, test-only fixture materializer. No production flattening adapter was added. Source whitespace and lexical delimiter checks pass; this is not compiler validation.
