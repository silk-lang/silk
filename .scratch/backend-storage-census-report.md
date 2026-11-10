# V13 → V15 backend storage census

The changes remove substantial stack-slot and hidden-argument bookkeeping, but reduce complete LLVM input volume by only 4.1%. This is consistent with the absence of a clear cold-build win in the separate end-to-end samples. Counts below establish emitted-work changes, not CPU attribution or a speedup.

Both captures build frozen compiler source `a63f612150a0b91a118c8111b910b12c3e124b50` and its original standard library, default full-debug/O0 profile, four-CPU inherited affinity, identical retained/private-frontier/packing settings. V13 is source `3626df7138972a470fbfe5a419579957920cceb5`; V15 is `9ac1c62f1f85a0f06411ce6f5f4c25bbd5995cc9` (unused ordinary Temp slots plus zero-storage internal outcome payload lanes). Captures ran in a shared correctness slot, so their elapsed times are not performance evidence.

| Actual LLVM/native input | V13 | V15 | Change |
| --- | ---: | ---: | ---: |
| Native bitcode packs | 222 | 189 | −14.9% |
| Bitcode bytes | 79,003,444 | 75,759,964 | −4.1% |
| Disassembled text bytes | 388,923,210 | 376,507,354 | −3.2% |
| All emitted allocas, including duplicated support | 1,061,455 | 835,449 | −21.3% |
| Unique internal function identities | 43,126 | 43,126 | unchanged |
| Unique internal allocas | 1,061,224 | 835,251 | −225,973 |
| Unique internal loads | 1,040,538 | 1,040,538 | unchanged |
| Unique internal stores | 717,845 | 717,845 | unchanged |
| Unique internal calls | 572,361 | 556,517 | −15,844 |
| Zero-length memory intrinsic calls | 67,744 | 51,900 | −15,844 |

All removed calls in the unique internal functions are zero-length memory intrinsics. Ordinary data access and useful calls remain intact. The smaller pack count also removes 231 duplicated support definitions; it does not remove source functions.

7,420 internal functions lose a total of 10,912 parameter lanes. Weighting those reductions by actual static direct call sites removes 65,487 call argument lanes. No matching function gains a parameter lane. These are static sites, not dynamic call-frequency estimates.

Summing known declared alloca types across unique functions gives 26,577,341 → 16,935,959 nominal bytes (−9,641,382). Four unusual alloca types are excluded. This sum ignores alignment, lifetime overlap and backend transformations; it is neither live stack use nor measured machine-code frame reduction. The combined alloca delta is not an exact unused-Temp count, because omitting an aliased empty result payload can introduce a local zero-byte return slot. No 24.9% unused-alloca upper bound is presented as an implementation result.

Both full generated compiler executables successfully checked a fresh two-module project. Earlier V13/V15 acceptance passed ten native runtime pairs with full debug information, exact stdout/stderr parity, DWARF verification and no lost source-variable/type/scope/location identities; direct Wasm zero-payload/coroutine parity also passed. Evidence: `benchmarks/backend-storage-runtime-pgk1yyil/REPORT.md`.

A pre-existing debug warning is retained in the raw census log: `llvm-dis` ignores `DICompileUnit(file:null)` in an identical 221,032-byte support input present in both captures (SHA256 `e9a71bddf4ee2cfb0513283c59056ab3f9a7ec538df18df22a9ce55674adda57`). It is not a V15 input change. Full authored-fixture DWARF checks passed; this census does not silently count that support input as valid debug metadata.

Reproducibility files:

- `benchmarks/backend-storage-v13-compiler-capture/` and `benchmarks/backend-storage-v15-compiler-capture/`: exact compiler/source/Clang/flag metadata, content-addressed BC, native argv, raw logs, generated-compiler checks and losslessly compressed generated artifacts.
- `backend-storage-compiler-census-comparison.json`: full counters, function-level parameter reductions, alloca-type totals and warning identity.
- Each capture's `census.json.functions.json.gz`: complete function summaries; no giant text module is retained.
- Each source copy was verified against every Git blob before pruning; `source-files.json.gz` and `source-prune.json` preserve the file hashes and exact revision. Generated output compression was verified against its original SHA before removing raw bytes.
- `llvm-promotion-experiment/capture-backend-storage.py`, `census-backend-storage.py` and `compare-backend-storage.py` reproduce the diagnostic.

V15 construction reused the same mono/O2 profile and pinned producer/Clang as V13. Its changed lowering functions produce 24 CFG-mismatch warnings versus 15 in V13, and 154 missing-profile functions versus 150. Actual profile application coverage is unknown. This real construction difference is included in end-to-end results; raw counts should not be multiplied into a speed claim.
