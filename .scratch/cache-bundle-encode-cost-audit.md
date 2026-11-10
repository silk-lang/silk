# V21 immutable bundle encode cost audit

Source-only audit, 2026-11-09. No compiler, profiler, or benchmark was run for this audit. Reviewed `a0fb61fcc` CacheBundle, CacheGuardCanon and driver/CacheBundles bytes exactly match the shared codec source. The reported Harf writer CPU ~4.05 s came from a contended correctness run; it is a reason to measure, not an attributed regression or speed claim.

The removable dense-transform envelope was only ~0.77 s compiler / ~0.48 s Harf. The replacement encoder must be charged against it. Raw worker graphs were 35%/49% larger than dense output. Native pipeline completion now waits for publication, so writer work cannot be dismissed as detached tail cost.

## Work performed by one encodeFiles call

Let N/L/R be all retained virtual nodes/leaves/roots, E the reachable edges before normalization, G the needed guard-cone edges, F the total operand lengths materialized while expanding marked joins, and C the live coordinator edges. P is parts and B is total referenced encoded bytes.

1. `compactForEncoding` calls `validate` on the entire incoming bundle.
2. If any conjunction marker exists, `normalize` computes an initial full selected-root live mask (N/L/R arrays, reachable E), then scans N backwards and G edges to mark guard cones, then N forwards and G edges again to construct canonical shapes. It allocates two N-sized usize arrays, one L-sized usize array, a needed mask, and per-shape edge lists.
3. The normalizer expands marked-child operand sets (F), heap-sorts/deduplicates each marked join, hashes each ordinary or marked shape and compares full equal candidates, then copies marked coordinator operands into EdgeView. Ordinary dependency graphs remain opaque; their immediate structure is nevertheless processed once throughout the guard cone.
4. `computeView` recomputes full selected-root liveness using replacements (another N/L/R set plus reachable edges). This is required after normalization to avoid retaining old guard generations; it is not currently shared with the pre-normalization pass.
5. `encodingLayout` scans every virtual leaf and node, even dead parts. Coordinator ranges get relocation maps; partly live raw parts keep their whole ranges and bytes.
6. Coordinator reconstruction decodes live coordinator leaf keys/evidence, builds fresh leaf/node lists and translates C edges. Raw local parts stay encoded. Selected non-local answers are copied/decompressed into fresh owned roots. Anchors and overlays are translated.
7. `compactForEncoding` validates its output, then `encodeRetainedFiles` immediately validates that same output again. Therefore **three full validation passes** occur per publication: incoming plus output twice. Each pass calls `leaf` and `originalLeaf` for every leaf; without overlays this decodes each encoded leaf twice, plus a file-leaf lookup/check where applicable. Fresh coordinator edges are also checked each pass. Immutable encoded node edges are not revalidated by validate.
8. Every Fresh part is re-encoded through CacheImage (front-coded keys, leaf summaries, node varints, compressed answers, graph/root seal). Raw IndexedShard parts reuse bytes, but `addBlob` computes ContentHash.of over their entire bytes again despite IndexedShard already retaining a validated digest.
9. `addBlob` linearly compares candidate digests to existing blobs (P² digest comparisons worst case); equal digests get full byte equality, preserving collision safety. Fresh answer-root fields and directory keys are copied again into the final tail/manifest. The manifest is encoded and sealed.
10. Driver `CacheBundles.write` reads each existing blob in full and hashes it before deciding not to rewrite. This matters primarily on warm generations; cold misses do not pay that read/hash. The manifest is atomically replaced, then prune does directory-entry × kept-blob digest comparisons. These checks protect against damaged files and must not be removed as an assumed optimization.

## Potential repeated work, ranked for measurement (not yet a rewrite proposal)

- **Full validation/liveness traffic:** three validations, two liveness passes, plus guard-cone passes and relocation scans. Much of this touches encoded evidence that was already authenticated at decode. Any reduction must distinguish immutable verified interiors from current overlays/coordinator/root-directory mutations.
- **Guard operand expansion:** physical node discovery is memoized, but a chain of joins that adds one distinct observation at each level materializes sets of lengths 1..k: quadratic total F and corresponding sorting/copying. The 16M accumulated operand budget bounds this work and refuses publication; it does not make it cheap. Constant-evidence eight-generation tests prove retained-size boundedness, not favorable CPU for a large distinct guard cone.
- **Exact file evidence repeats:** leafMemo prevents repeated canonicalization of the same global leaf. File evidence has no per-global-file memo, so each different input leaf can decode/hash its recorded-file key again before finding the same canonical file row.
- **Key restarts are bounded, not a hidden unbounded prefix scan:** CacheBundle.keyAt resets its local cursor when Arc identity changes. CacheImage.indexedKeyAt starts at the nearest 16-leaf restart, not leaf zero. Alternating parts/nonmonotonic leaf order can cause up to 16 key/leaf suffix decodes per lookup. File and input cursors are separate. Count restart amplification before considering a larger key memo.
- **Shape interning:** Hash buckets collision-check complete keys/evidence/ordered child arrays. Duplicate large shapes still cost hashing and equality proportional to shape length; arbitrary collisions add candidates but no observed evidence currently identifies pathological hash behavior.
- **Raw byte hashing:** authenticated raw bytes are rehashed by addBlob on every encode and warm existing files are re-read/rehashed by the driver. Fresh CacheImage serialization also computes its graph/root seal before addBlob computes the blob digest. Record byte totals by category; do not assume hash bandwidth is the dominant cost.
- **Answer handling:** raw-local answers remain lazy and shared. Non-local/coordinator answers are materialized by compactForEncoding, copied into encoding's tail and packed again. Record copied/expanded/packed bytes separately from graph bytes.
- **Small P² loops:** addBlob and prune are visibly quadratic in part/file count, unlike node interning. They may be immaterial at a few dozen parts; report actual counts before changing them.

## Minimal diagnostic plan after the exclusive window

First preserve the uninstrumented V21/V19 comparison and its source/cache states. Use one diagnostic binary with unchanged decisions and one writer-side summary per process, not per-node logging. Give each summary PID and role (worker packet / final driver) because CacheBundle.encode is also used by artifactCachePacket and calls encodeFiles itself. Do not attribute worker encoding to final writer twice.

Use non-overlapping wall-time buckets in encodeFiles and driver write:

| Bucket | Boundaries | Essential counters |
|---|---|---|
| validate-in | first validate only | parts, encoded/fresh nodes/leaves, roots, overlays |
| normalize-prelive | initial Live.compute | visited nodes/edges/leaves |
| normalize-cone | needed marking | needed nodes/edges, marked joins |
| normalize-canonical | canonical construction | F, maximum join width, ordinary shapes, unique file/leaf shapes, equality candidate/compared-element counts |
| live-final | computeView | live nodes/leaves/roots |
| relocate | encodingLayout + coordinator reconstruction | kept/dead parts, raw retained bytes, copied nodes/edges/leaves, copied answer bytes |
| validate-out | both existing output validations, separately counted | same structural counts |
| encode-parts | CacheImage.encode only | fresh graph/root/answer bytes |
| hash/dedup | addBlob hash and equality only | hashed bytes, duplicate byte comparisons, unique blobs |
| manifest | directory/overlays + manifest serialization | manifest bytes, roots, overrides, joins |
| verify-existing | driver read/hash only | files/read bytes/hash bytes, valid/missing/corrupt counts |
| write-new | atomic blob writes only | file/byte counts |
| publish/prune | manifest atomic replace and prune separately | manifest bytes, entries/kept comparisons/deletions |

Avoid nested timers in hot edge loops; counters accumulate in existing traversal state. For key-restart attribution use an optional diagnostic counter passed through the relevant cursors (keys requested, suffixes decoded, part switches), not a process-global mutable counter that would race threaded adoption. A second diagnostic-only build is justified only if coarse phase timing points at canonicalization/keys. Phase instrumentation should be off by default and validated for identical manifests, diagnostics, runtime outputs, and selected root/evidence structure.

Run cold→direct first edit→second edit and a separate unchanged sequence on the same preserved workload snapshot, with both CPU0 and CPU0–3 inherited affinity, under exclusive performance.lock. Retain foreground, settled writer wall/CPU, max RSS, cache/blob bytes and invocation flags. Use perf sampling of the writer only if available; phase wall sums alone do not give thread/process CPU attribution. Initial diagnostic target is Harf because the suspected writer envelope is large; compiler confirmation follows. No baseline-relative gain claim can come from the instrumented run.

## Safe decision boundary

If normalization is dominant, inspect measured cone size/F first and preserve explicit tags/exact evidence/post-normalization liveness. If repeated validation is dominant, reuse immutable validation certificates while rechecking all mutable metadata; do not simply delete guards. If hash/write dominates, distinguish authenticated-memory digest reuse from mandatory on-disk corruption checks and charge larger retained bytes. If final writer is small but foreground worsens, inspect worker packet export and adoption separately. A warm-load dense Merge adapter remains outside this design.
