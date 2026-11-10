# Immutable Bundle normalization and lifecycle validation

Combined clean source commit `734e29b197d903ceb11929cadc3117a3daf27c43` in `.scratch/cache-bundle-source`. Source ownership was frozen before checks: walks producer/export and external case migration; interning reader/adoption/lifecycle; parallel_semantics codec/guard normalizer; root driver publication. Committing after checks changed no source bytes.

Exact source receipt `.scratch/cache-bundle-normalized-source-receipt.json`, SHA256 `54783e44ade69df75c3dfe5cc046e0638654ddf40252106e3b75cb48133e2734`, records basea07c13105 plus the five changed/new source files. Those file bytes were copied to `.scratch/cache-bundle-normalized-snapshot` and matched again after all gates. Codec then committed79072dbe1; the final commit records remaining Semantic/case changes.

Pinned N1 `.scratch/ci-n1-4a1fa332/N1`; pinned Clang22.1.8. All commands held the shared performance lock and reaped descendants. No timing/performance claim; another independent V20 construction occupied the other slot.

- Full compiler sourcecheck PASS15.92s: `cache-bundle-normalized-sourcecheck.log`.
- Codec3/3 PASS7ms: `cache-bundle-normalized-codec-tests.log`. Includes exact evidence/position/text/file distinctions, fresh equivalent IDs across8 generations, replacement pruning, immutable references/stamps/overlays/corruption.
- Actual producer guard1/1 PASS5ms: `cache-bundle-normalized-semantic-tests.log`. Each generation invokes imageEscapeRecord with a fresh reconstructed record (`carriedRecord=MAX`) and inherited guard, constructs a fresh equivalent ordinary guard node/leaf, invokes frontierBoundaryGuard for equivalent application evidence, then encodes/decodes. Eight generations preserve exact live observations, lazy answer placeholders and bounded retained node/leaf counts.
- Same compiled Semantic binary:10/10 selected lifecycle/export cases pass. JSON `cache-bundle-normalized-lifecycle-tests.json`, logs0–6. Covers encoded body-edit/order/application/header/roster lifecycle, winning blobs, failed replacement, linked dependency identity, authenticated handles, artifact transport/entry/packet proof and repeated lazy corruption.
- Latest normalized driver publication1/1 PASS2ms: `cache-bundle-normalized-driver-tests.log`. Missing/corrupt shard repair, failure preserving the previous manifest, invalid bundle publication refusal, prune ordering and no detached recreation after clean.

Total15 selected correctness tests, all executed and passed. External CacheAdoptCases/CacheImageCases were migrated and sourcechecked, but their broad runtime suites were not run here. The earlier four minimal frozen-snapshot gates are separate evidence and are not counted twice.

The first manual invocation of the standalone Semantic runner exited2 before executing tests because it lacked the required authenticated plan. The corrected harness derived the65-entry catalog from `.inputs`, supplied an uncached256-byte plan and empty environment, and verified nonzero selected counts for every filter. No semantic assertion failure was concealed by this harness adjustment.

Completed test object directories were hashed then removed: `cache-bundle-completed-test-object-cleanup.json` records826 files/138,611,631 bytes. All frozen executable binaries, input catalogs, plans/receipts, logs, source snapshots and reports remain.

Native V18+Bundle integration, cold/edited storage growth, one/four-CPU parity, and performance are still pending. Bounded fixture storage is not a measured workload speedup.
