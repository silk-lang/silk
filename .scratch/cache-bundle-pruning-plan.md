# Encode-time bundle pruning

Current prototype deliberately retains all parts; this document describes required bounded-generation cleanup before promotion. Active held node/leaf/root ordinals never change. Only a newly encoded generation receives compact ranges.

1. Compute first-exact-key selected root authority and reachable node/leaf masks, including every live input's recorded file. Root answer sources also retain their payload part.
2. Classify a part as local/self-contained only when its stored prior-node AND prior-leaf ranges are zero (`nodeBase == nodeShift && leafBase == leafShift`). Such a worker blob can move intact by changing its interpretation base. Internal references remain local; no edge/key/answer rewriting.
3. Drop wholly dead parts. Build old-range→new-range relocation metadata before encoding anything. For retained self-contained parts, reserve their complete local ranges; for coordinator parts, reserve only live nodes/leaves, with small per-part local relocation arrays.
4. Re-encode only coordinator parts with external dependencies. Translate their live edges through the relocation map. DAG order is preserved because part order and local live-node order are preserved. Copy only selected coordinator answers; unselected answer rows are not carried into new blobs.
5. Scalar evidence overlays follow the same relocation map. Drop overlays for dead leaves. A live input's file may be in a later range: keep this as an overlay rather than placing an out-of-range future file reference into a local shard header. The common reader resolves the overlay before applying alwaysPlaced; overlay membership alone does not force placement.
6. Retain selected self-contained root answers lazily from unchanged raw blobs; rebind their public root node to the relocated local node. Fresh/coordinator selected answers are emitted in the coordinator generation.
7. Produce Files.blobs containing exactly the retained blobs, allowing the driver to prune files absent from the new atomically published manifest. Never mutate the currently held bundle while serializing.

Tests required: repeated replace→export→read generations should shed dead raw shards, avoid growth in live part/range counts, and retain exact live answers, cross-part dependencies, forward file overlays and first-root authority. Test a source graph referenced only through a coordinator guard and one retained only as an answer source. Corrupt relocation must refuse rather than leave partially valid roots.

Cost limits: one reachability traversal, no raw edge rewrite, no decompression of unselected raw answers. Report encode/prune CPU and settled writer time separately; do not advertise foreground wins by moving the same transforms into next-edit adoption.
