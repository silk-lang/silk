# Lazy Bundle adoption review

Source-only review of frontier-cache-shards-design.md against the current placeAnchors/placeImageLeaves/adoptNodes implementation. No shard implementation or benchmark is claimed.

The direction is sound: preserve immutable worker-local DAGs and let coordinator roots reference them. Do not translate the Bundle back to one CacheImage during adoption. The initial scope should preserve current leaf checking and answer policy exactly, changing reference ownership and scheduling only.

## Interfaces to settle before edits

- Bundle owns authenticated immutable shard bytes plus a global exact-key root directory. RootHandle must bind an adoption generation and root ordinal; NodeRef is a tagged shard-local or coordinator-local ordinal. Appending shards may preserve handles; replacing/refusing a bundle invalidates every previous-generation carried/budget/replay/graph-cache handle. Required-but-unavailable evidence must remain distinguishable from no evidence.
- Root lookup returns selected authority once, using exact stable key bytes after hashing. Duplicate keys do not become alternate candidates after the selected root fails its guards. This matches current first-root authority and avoids stale fallback.
- Separate structural validation from semantic node state. Structural validation scans bounded local edges and rejects forward edges, bad leaf refs, malformed framing, hash/stamp/count errors before exposing roots. Semantic state is Green / PositionOnly / Dirty, not a boolean. Existing adoptNodes distinguishes a changed diagnostic position from changed semantic content; definitions and escape entries may reuse PositionOnly evidence while full checks cannot.
- Bundle.answer(handle) is borrowed indexed bytes. Bundle.nodeState(ref) validates or returns memoized state. Semantic attachment translates selected leaf dependencies into resolver-owned handles only when a linked query needs them; serialized shard-local IDs never enter the query graph directly.

## Cross-shard source verification

Deduplicate file/anchor verification across the whole bundle before checking each shard. An unchanged file is insufficient by itself: CacheImage.alwaysPlaced explicitly includes Request/Resolution, missing-selector/no-file facts and changed-input sentinels. Every shard's always-placed facts must still pass, even if all file bytes match.

Use one adoption-scoped proof cache keyed by exact stable input bytes and the complete recorded evidence: input/file kind, digest, text digest, declaration position, and canonical file identity+recorded file digest. Never use a shard-local file ordinal as identity. The cached value includes the placed resolver input/module handle and position-only classification, not just a digest comparison. Two rows with the same authored facet but different old file snapshots or positions may share source parsing/current facet computation, but must compare their distinct recorded evidence separately.

Scope the cache to current SourceIndex revision, profile, request/application and resolution context. Request/Resolution results cannot survive a request switch merely because source files are unchanged. Existing SourceIndex/Inputs already share current parsing and many selector results; the new cache should eliminate repeated decode/verification across shards without creating a conflicting authority. Immutable CLI adoption can retain the cache for its command; linked adoption must reset or epoch it on revision/context changes.

For unchanged shards represent all nodes as implicitly Green (after anchors pass), rather than allocating one usize per node. A changed shard can scan topologically into compact two-bit states, reading edge spans from immutable bytes. Coordinator nodes evaluate those same states after their referenced shards. Initially this is simpler and lower-risk than recursive per-root validation. Demand-only closure validation is a later optimization if a measured large changed shard dominates.

## Transactions and publication

A valid packet digest is integrity evidence, not semantic greenness. Preflight all required shard identities and structural sections, then stage root bindings, node states and adoption handle generation. Publish one accepted bundle association only when this stage succeeds. On missing/corrupt/OOM input, discard staged roots and preserve the old association or explicitly invalidate every old handle; never expose a partially replaced directory.

Per-query answer attachment must be similarly transactional: decode/validate answer, stage its exact dependency edges and required budget proof, then install the memo/answer as the final step. An allocation failure may leave harmless interned identities or already validated source observations, but must not leave a reusable answer with a partial dependency list. Budget updates keep the existing checkpoint/rollback contract. Failure during later lazy attachment does not authorize falling through to a same-key stale root in another shard.

Carried evidence should retain blob references and root/node handles, not recursively copy dependency closures. Keep blob reachability rooted in the selected global directory and coordinator proof edges; a descriptor's immutable escape graph blob is also a required reference. Dropping unselected root answers must not prune a shard node still referenced by a coordinator guard.

## Required initial tests

1. Same exact source input in two shards checks once; distinct old file digest/text/position/request evidence remains distinct and gets its own match decision.
2. Unchanged authored files plus changed application/resolution still invalidate the appropriate coordinator/check root.
3. Position-only edit preserves eligible definition entries while invalidating spans/reporting roots.
4. Conflicting duplicate root keys preserve first authority even when the first root is stale; no stale alternative selection.
5. Failure after staging one shard/root/budget update, then repeated adoption and append, cannot retarget old handles or expose partial answers.
6. Linked per-query invalidation through cross-shard dependencies remains exact, including negative/missing-source observations and whole-roster guards.
7. Serial single-shard and parallel multi-shard reader paths are the same format/API, with direct first/second edit and unchanged measurements on one/four CPUs.

The measured available post-proof interval is an upper bound. A second complete graph copy, eager all-answer decode, or repeated per-shard source validation would defeat the intended structural gain. No new worker scheduling or early generation publication is required to test the representation change first.
