# V21 root-directory duplication audit

Source-only, 2026-11-09; no cache blobs parsed and no compiler/profiler jobs run during the V20 timing window. Reviewed exact V21/a0fb61fcc code. Used only existing17KiB census results,1.8KiB census summary,95KiB V21 results and small text logs.

## Confirmed representation

`CacheBundle.Directory` stores `{key: Bytes, node, part, root}`. `manifestBytes` writes each complete key with `putField`, which is **fixed 64-bit little-endian length followed by raw bytes**, without front coding or zero-run packing. The referenced immutable `CacheImage.IndexedRoot` already contains that exact key and its local node. CacheImage's root serialization uses `frontKey`: common-prefix length plus packed suffix against the previous root.

Load currently retains/copies that identity at several levels:

1. Manifest bytes contain the complete raw directory key.
2. `readManifest` allocates/copies each directory key.
3. `CacheImage.indexed` separately expands each shard's root key into IndexedRoot.
4. `assemble` compares full directory/shard keys and the shifted node, then copies the directory key again into Bundle.roots and hashes it for the exact root directory.

Publication likewise copies keys into a temporary Manifest directory and writes their full bytes; fresh coordinator roots can also carry another key copy into the encoded answer shard. The duplication is real, but its measured share of writer/load CPU is unknown.

## What existing small metadata can and cannot estimate

Old packet census root counts were66,302 compiler /39,656 Harf after merge, versus71,241/41,557 raw worker roots. These are scale references from the earlier census, not measured V21 manifest counts.

At that scale, every100 average key bytes would add about6.32MiB/compiler or3.78MiB/Harf of raw manifest key payload. At1KiB/key the payload would be64.75MiB/38.73MiB. Length/node/part/root each use a fixed8-byte word, adding32bytes per root. **No retained small metadata records actual average/summed manifest key lengths**, so selecting one estimate as the observed cost would be unjustified.

V21's final check cache totals were120,224,589 vs94,963,113bytes compiler (+24.09MiB) and74,913,812 vs46,616,318bytes Harf (+26.99MiB). Build deltas were+36.69MiB/+31.95MiB. Those are whole-cache deltas: graph duplication, roots, overlays, pack files and other caches contribute. They are not estimates of directory-only overhead and must not be used as one. Completed cohort caches were deleted for disk headroom; file-level attribution was not preserved.

Next diagnostic should record root count and sum/max key lengths while traversing the directory that encoding already visits, plus final manifest bytes, without an extra scan. This determines the byte envelope before changing the wire format. The prepared phase diagnostic already reports manifest bytes and directory count; adding summed key bytes would be a tiny counter-only extension if the phase warrants it.

## Candidate structural avoidance if attribution supports it

The conservative candidate is an ordered manifest directory of **(part, root, explicit proof node)**. Only the exact stable key would derive from the authenticated IndexedRoot; proof-node rebinding remains separately represented:

- Require part/root bounds and valid shard framing/digests first.
- Derive `key = indexed.roots[root].key`; retain and validate the explicit current proof node. Do not silently replace it with the answer source root node.
- Build Bundle.roots/rootIndex from those exact bytes, preserving directory order and first exact-key authority. No hash-only identity is introduced.
- Append-selected duplicate directory entries retain their requested order. Public in-process root ordinals do not change.
- Fresh/changed roots already serialize into a coordinator root shard; their new exact key/guard node is available there too.
- Root-only selection/pruning still retains the answer-owning shard separately from normalized guard ownership. Existing association, stamp, bounds, malformed reference and corruption tests remain required.

This can remove redundant wire keys and manifest key allocation/copy. Producer-side exact key/source association must still be established before omitting the duplicate key; it must not silently reinterpret a publicly mutated directory key. It does **not** eliminate IndexedRoot key expansion, Bundle's currently owned key copy, exact first-key hashing, graph/index validation, normalization, or disk corruption checks. Further lazy/shared root-key handles would be a separate API change, not assumed savings.

Current assemble rejects a source root whose shifted node differs from the directory node, and rootMut materializes the answer and clears its lazy source before modification. However Bundle.roots is publicly mutable, validate primarily checks bounds, and guard composition/relocation conceptually separates proof ownership from answer ownership. Those observations are not a sufficient invariant to remove explicit proof-node identity. Preserve the node and association checks unless a separate audit establishes every valid producer mutation path. Format-version, rebinding, malformed-reference and exact key/source association gates are required. No implementation is proposed for integration until load/assemble or manifest attribution demonstrates a large enough envelope; V21 remains rejected.
