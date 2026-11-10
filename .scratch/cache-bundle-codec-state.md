# Immutable cache bundle codec prototype

Combined compiler sourcecheck passed on the frozen pre-GC snapshot. Updated codec GC tests PASS2/2 (4ms total), commit409a0133a. No optimized prototype/performance measurement yet. Module: `.scratch/cache-bundle-source/compiler/src/semantic/CacheBundle.silk`.

Implemented reader/producer/driver APIs use dense virtual node and leaf ranges over shared immutable local shards. Raw edge lists and compressed answers are not copied during append. Indexed CacheImage validation records offsets and validates exact compressed-run lengths, DAG bounds, source-file references, header seals and content digests. A selected answer is expanded only through an answer cursor. Per-part original stamps allow worker transport to be persisted under a different outer manifest stamp.

Root collection has exact first-key authority. Explicit append preserves contiguous duplicate root entries. Guard-only graph imports publish no answer. Repeated immutable source imports use a checked snapshot of all part identities/ranges/translations and evidence overlays, not just an address or mutation count. `seal` freezes a mutable held coordinator before repeated imports. Evidence overlays preserve selector/key/input identity, permit later file references, and are always visible through the common reader.

Manifest decoding bounds bytes/counts/indices, validates the entire manifest content seal, and assembles only after every required blob matches length/content digest/local stamp and range structure. Filesystem code lives in the driver. Publication failures must not replace an older held generation.

## Thread handoff

The first whole-source check correctly rejected thread-local `Frozen` handles in prefetched bundles. Codec storage and immutable byte blobs now use standard atomic `Arc` handles; no unchecked `Transferable` assertion was added. The combined sourcecheck passed with this change.

## Important unfinished items

- Local module compiler validation and focused tests passed; whole Semantic/driver passed before the GC increment. Tests cover local and cross-part roundtrips, worker→disk stamp changes, first-key versus explicit duplicate roots, repeated and divergent import snapshots, overlays, corrupt manifests, malformed DAGs and missing blobs.
- Encode-time live-part selection now drops wholly dead raw parts and compacts live coordinator ranges. An eight-generation replacement/export/read test retains exactly3nodes/4leaves and at most5blobs while preserving exact live raw blob bytes and forward file overlays. HOWEVER, this test does not inherit its previous joined guard. `composeEscapeGuard` can still make old guard coordinator chains reachable, so promotion remains blocked on scoped canonical guard representation and an actual repeated producer-path fixture. No blanket transitive DAG flattening is planned.
- No timing or memory improvement has been established. Existing census bounds the parent transform opportunity to approximately771ms compiler/478ms Harf, while raw shard payloads are35%/49% larger before coordinator metadata.

## Guard normalization implementation (pending combined validation)

The post-overlay publication path now canonicalizes explicitly marked source-guard conjunctions before its final liveness/relocation pass. Ordinary query DAG nodes remain opaque operands; only their ordered immediate-child structure is interned once to recognize newly allocated equivalent guard nodes. Leaf equality checks full stable keys, input/selector identity, digest, token text, position, and exact recorded-file evidence. Hashes select buckets only. Canonical node representatives are selected in topological order, and substitutions apply only to coordinator nodes; encoded local shard bytes and lazy answer ownership are unchanged.

The normalizer limits accumulated operand work to 16 million entries. Exhaustion refuses cache publication, never semantic checking. It uses node/leaf memo arrays and temporary shape tables; this CPU/memory cost must be measured against the small removable merge envelope. No warm or cold speedup is claimed.

Initial implementation compiled with the existing two codec tests passing (4 ms). New pending tests allocate fresh equivalent ordinary nodes/leaves across eight serialized generations, preserve a distinct application snapshot, and separately distinguish token text, position, and recorded-file digests. Walks owns the actual Semantic producer-path repeated-generation test. Wholly dead parts are collected; interiors of a partially live immutable local shard still remain intact. Distinct historical evidence that remains semantically required cannot be discarded just to force a storage bound.

Guard checkpoint `79072dbe1` is now validated by full combined compiler sourcecheck (15.92 s), codec3/3 (7 ms), and the actual Semantic producer guard composition fixture (5 ms). The producer fixture reconstructs a fresh equivalent ordinary guard plus an application atom through imageEscapeRecord/frontierBoundaryGuard on each of eight encode/decode generations and checks exact live observations and fixed retained node/leaf counts. Shared Escape lifecycle/adoption gates remain separately owned by walks. These are structural correctness and boundedness checks, not runtime benchmarks.
