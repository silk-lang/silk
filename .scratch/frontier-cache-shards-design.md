# Cold-check frontier span and immutable cache shards

Read-only audit against integration3626df713 and V16 source cbb2fe84f. No new compiler jobs. Exact V16 measurements: `benchmarks/integrated-incremental-mlxis3gy`; flat CPU attribution: `benchmarks/v13-cpu-build-cw3f9tud`.

## Evidence and limit

V16 direct-cold compiler check:8.963s foreground/9.804s settled,25.413user+2.703system CPU seconds in the primary process tree. Baseline22.354s,20.867user+1.856system. Harf:3.441s foreground/4.013s settled,8.995user+.972system; baseline7.746s,7.459user+.444system. The reported28.1s compiler worker CPU includes system time and is not user CPU alone.

Compiler module finishes5.100–5.131s, Harf1.651–1.719s. Queue imbalance at this boundary is only31/68ms; changing chunks or stealing tasks cannot recover1.5s. Compiler merged5.257→proved6.198s includes3635 initially missing LEFT definitions; Harf1.759→1.942s includes939. Compiler proof→cache assembled7.716s costs1.518s; adoption7.908. Harf proof→assembled2.822s costs.880s; adoption2.912. These relative times start at split, after the initial159/67ms prefix.

The registry's measured improvement is same-owner completed-capture reuse, not in-flight Body deduplication; its logs do not classify unfinished/unsupported supplier misses. Its duplicate-key hashing repair is unmeasured. Complete-module eager traversal was already measured and lost; do not repeat it.

## Operations presently repeated

`artifactCachePacket` creates the full local dependency image, selects reusable roots and encodes it. `fetchFrontierCache` requests every original/descendant image, then the coordinator's `readArtifactCache` eagerly decodes all leaves/nodes and expands all stable keys. `CacheImage.Merge.add` walks reachable dependency graphs, merges leaves/nodes/roots, copies answers and remaps local indexes. `completeFrontierChecks` needs selected roots and creates coordinator-owned escape/check roots. `appendArtifactImage` carries/remaps roots again into heldImage. Later `SemanticCache.saveDetached` calls completeCacheImage, compactDuplicateRoots and encodeFiles on the combined image.

V13 full-build leaf samples include Merge.add.263CPU, Merge.leaf.152, carry.121, pack.242, imageUnit.222; decoding includes unpackKey.061/readNodes.040/etc. This is evidence of real transformation work, not a complete attribution of V16's1.518s. The V13 artifact-cache interval had roughly.909parent+2.707worker userCPU; therefore eliminating parent graph transforms cannot be advertised as eliminating the entire interval. Worker fingerprint creation is necessary, and detached writer tail must remain measured.

## What the cold coordinator actually needs

For accepting the current check: finite closed union, exact module/chunk/root coverage, canonical budget, escape proof and diagnostics. All are already in BuildRecord/SweepFragments; none needs worker fine-query graph decoding.

For constructing reusable module/check records: the deterministic directory of exact root keys, their worker-local node handles, their availability, and immutable answers needed for selected root kinds. For each selected full MIR definition it needs the exact entry root; for each original module/subset it needs the exact non-MIR read roots, application boundary guard, roster/sweep proof and code/region-neutral graph descriptor. It does not inspect the internal edges beneath those dependency roots. Today those edges are read/remapped only because heldImage permits one index space.

For the next process: actual source leaf fingerprints, input selectors/positions/text guards, local dependency graph and reusable answers. These can remain in validated immutable shards. Retained build finishing needs root/answer access immediately, but this also needs an indexed root directory and lazy selected answer access, not eager graph merging.

## Proposed representation (one new format)

Keep CacheImage as the **local shard codec**, not the global persistent store. Add CacheBundle/CacheForest as the persistent object for both serial(single shard) and parallel(multiple shards) commands. Each immutable shard has stamp, format, content digest, bounded counts, graph/answer sections and indexed root directory. Blob filenames are content-addressed. Cache-file publication is one atomic manifest replace after every referenced blob is durable. Private staging is never discoverable before that replace.

The manifest stores ordered shard identities, the selected-root directory and a small coordinator dependency DAG. Each reference is `(shard,node)` or a preceding coordinator-node ordinal. A shard may reference only earlier nodes of itself; it can never reference the coordinator or another shard. The coordinator DAG may depend on shard nodes or earlier coordinator nodes. This makes global acyclicity mechanical and permits cross-worker module proofs without rewriting a single worker edge.

Root selection preserves current Merge.first-key-wins order exactly (original worker order and each packet's existing descendant order); retain exact stable bytes for collision comparison. Do not key solely by hash. The manifest directory can retain globally stable root ordinals for carriedRoots/budgetRecord associations, while root.node becomes an explicit local reference. Selected record/check roots are created only after complete union, budget, escape and coverage proofs. Keep extension non-MIR roots, application boundary and per-entry MIR roots separate just as now. Inherited carried graphs become immutable prior shards; retain only referenced blobs in the manifest, never copy their closures into new blobs.

On receipt validate packet framing, counts, stamp, content digest, root directory bounds and shard-local DAG structure. A streaming validation scan need not allocate/remap nodes or expand every leaf key. Warm load rechecks blob hashes/format and does not treat a digest as authorization for semantic reuse: source-input guards still decide green status. This is integrity checking, not cryptographic authentication against a malicious compiler worker.

## Lazy adoption and transactional contract

Adopt from a Bundle rather than adding another branch beside heldImage. A common RootDirectory handles single/multiple shards. Validate anchors/file fingerprints per shard first; an entirely unchanged shard can supply green nodes without materializing its edge graph. A changed shard uses existing input/text/position checks and validates nodes in local topological order; coordinator nodes are evaluated after their referenced shard nodes. Decode selected answers lazily by indexed offsets. Cache source-input verification by exact stable input key plus recorded digest/text/file identity across shards, so preserving shards does not multiply first-edit source demands.

Missing/corrupt shards cannot produce partially published green roots or stale budgetRecord/carried-root indexes. Stage the entire manifest association, required-shard validity and coordinator node results; commit once. Initial prototype can conservatively refuse the whole bundle and run existing semantic recomputation. A partial cache miss optimization is later work, not required for correctness. Preserve all failure cleanup/reap behavior.

This has material API scope: replace heldImage/root/answer/edges access by Bundle access, not a load-time Merge adapter. A prototype that saves shards but immediately merges them on warm load moves cost into edits and would not satisfy the user. Existing adoptFrom/adoptNodes are the main adaptation points; CacheImage.readNodes/edgesOf callers identify the limited core graph surface. Serial builds use the same Bundle representation, so one-core correctness and overhead remain measurable.

## Staging and incremental completion without eager traversal

Do not wait for global closure proof to create independent fingerprint/shard data. A worker can finalize a **generation** of completed local query roots after publishing its initial fragment; extension work adds another generation of roots/evidence. The worker must snapshot non-MIR reads (frontierNonMirReads already does this), retain source/profile stamp, and export only completed immutable query units. Do not cache ImageBuild.nodes forever across a mutable ModuleCheck unit: either immutable generations or explicit per-unit revision checks are required. Retain an input-fingerprint memo only under the frozen source stamp and exact selector key.

A later extension packet can contain only new roots plus references to immutable earlier local shard nodes. If that would violate the initial shard-local-only rule, initially emit a standalone extension shard with its exact dependency closure; deduplication is optional, correctness is not. Do not reuse a failed/partial generation. Parent consumes completed packets as they become available and can assemble the selected-root directory/proof DAG while later generations finish. Failure drains every sent request before closing workers; no half manifest is published.

There is little useful overlap merely starting after the last module finishes. A more ambitious extension request stream could act on already published partial fragments and exact unclaimed LEFT keys before the global merge, but runtime-private children presently publish through their busy parent. That requires a nonblocking result mailbox, exact existing claim ownership, and finite proof retained at the end. It is separate from this cache-format prototype and should not be disguised as eager whole-module checking.

## Implementation split and minimal measurement gate

1. **Format/transport owner:** CacheBundle codec and indexed directory; bounded references and streaming shard validation; filesystem staging/content-addressed blob/atomic manifest commit; packet forwards encoded shard bytes directly. Preserve first-root precedence. Pure malformed/missing/cyclic/out-of-bounds/hash/stamp tests.
2. **Semantic proof/export owner (walks):** replace fetchFrontierCache's decoded Merge with bundle collection; completeFrontierChecks builds the coordinator DAG by exact selected MIR/non-MIR root handles; preserve boundary/roster/application guards and budget association. Initially worker export timing stays unchanged, isolating removal of transformations. No new eager work.
3. **Adoption owner (interning):** held-cache Bundle access and lazy source/leaf/node validation; carried answer/root identity and budgetRecord handling; whole/partial changed-file tests and transactional OOM/corruption reset. Serial image becomes a single shard in the same new format.
4. **Driver/persistence owner:** direct blob preservation/reuse, atomic manifest publication, retention/pruning, no worker/writer FD leaks. Retained backend definition roots and packs use the same directory; coordinate with pipeline owner before integration.

Prototype gate is explicit until validated, but use one new Bundle format on the branch: control may merge into one shard before writing; treatment preserves worker shards. This isolates sharding while exercising the same reader. Do not ship the control as a lasting duplicate architecture. First focused tests: cross-shard MIR→module dependencies; identical root keys with different candidate evidence and deterministic selection; application switch; cross-module body edit; cached warning/error spans/order; missing/corrupt one-shard refusal with no budget indexes; unchanged then direct first/second edits; selected backend definition reuse; failed worker drain and interrupted manifest writer.

Then same-binary cold check compiler/Harf plus direct first/second edit and unchanged, both1/4CPU. Record foreground/settled wall, user/system CPU, total shard/manifest bytes and PSS. Add phase timestamps for worker fingerprinting/encoding, parent validation/directory/proof creation and disk commit. The available post-proof phase is an upper bound, not promised gain. Stage earlier shard generations only if the transformation-elimination prototype shows enough benefit to justify its additional protocol complexity.

## Follow-up census completed

`benchmarks/cache-packet-census-sj2akl4f/REPORT.md` records two successful original-source cold checks with the optional packet hook. The parent decode/merge plus adoption-remap envelope is at most about771ms compiler/478ms Harf in the shared-slot diagnostic. Raw encoded shards are86.9MB/63.2MB versus64.5MB/42.4MB final persisted caches, before adding coordinator metadata. This bounds the proposal; do not claim removal of the whole post-proof interval. Root has the recommendation to prototype transport and lazy adoption together, with no eager warm-load Merge adapter.
