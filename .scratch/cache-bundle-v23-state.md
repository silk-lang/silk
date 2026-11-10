# V23 validated component candidate

Frozen source: `5a5be2109e8f65472869ef147ae6364df91cb62d`. Binary: `.scratch/frontier-cache-bundle-v23`, SHA256 `9a10d1e7cc23e27d8b6ad773f30d457aebed95a28dc71591a9ecea0f5d206c78`. Construction is pinned producer/LLVM, four units, O2, no debug, no PGO, matching V21. Build metadata/receipt: `frontier-cache-bundle-v23-{build,receipt}.json`.

Changes: authenticated compact leaf scalar offsets (4 bytes/leaf); independent direct-examined and verified-file temporary liveness memos (2 bytes/leaf); validated private encoder duplicate-check removal and authenticated immutable blob digest reuse. Untrusted constructor, overlay, exact evidence, digest collision, and disk corruption validation remain. Independent build_pipeline source review found no blocker.

Validation: full compiler sourcecheck; combined focused 9/9 including disk corruption/atomic publication, encoded offset restart and unusual file-link semantics; native boundary/application 20 calls with exact ordered JSON and artifact/runtime parity; native pipeline 13 calls covering native publication, injected fallback, early writer checkpoint completion, and automatic CPU0 host refusal/no pool. Native evidence: `benchmarks/boundary-cache-rqphxa5h`, `benchmarks/native-pipeline-zkextgl1`. All processes and detached writers reaped.

Completed bootstrap build outputs removed only after per-file SHA receipt (`frontier-cache-bundle-v23-build-cleanup.json`, 280295967 bytes). Source, immutable binary, logs and metadata retained.

Performance is UNMEASURED. Rejected V21 remains rejected. Prepared `cache-bundle-v23-settled-probe.py --cpus 0,1,2,3` compares V19/V21/V23 Harf cold→direct first edit→unchanged with every writer settled and exact diagnostic parity; CPU0 follows if mechanism improves. Root schedules V22 comparison first. Settled measurement isolates cost and cannot establish immediate-edit behavior; separate overlap test required if promising.

## Measurement completed

Both CPU lanes 18/18 correctness checks passed. V23 rejected for promotion: first-edit settled vsV19 2.63× four cores and1.42× CPU0; unchanged3.23×/1.93×. Full report `cache-bundle-v23-results.md`; sources/caches preserved in gx32xiz_/ql26cekn cohorts. All writer processes reaped, lock released. No further Bundle optimization prototype scheduled.
