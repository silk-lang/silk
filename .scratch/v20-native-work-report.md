# Repaired V20 native validation and actual LLVM census

The repaired shared-storage helper and parameter-forwarding candidate passes the native gates below and removes actual loads from both real workloads. These instruction counts are not CPU or wall-time evidence. The source/library/output settings match the retained V17 captures; compiler construction differs (V17 mono-PGO versus V20 four-unit O2 without PGO), so no capture elapsed-time comparison is valid.

## Exact candidate and correction

- V20 repaired source: `0b984e03229d055fceb9d9eac71fce27a236e24e`.
- Binary: `.scratch/frontier-native-work-v20-repaired`, SHA256 `2281f561ff1ecefa62258166f7c960bc7da7560f93735a9139fd53ea5366fdc8`.
- Exact sourcecheck and four-unit O2/no-PGO construction receipts: `frontier-native-work-v20-repaired-{sourcecheck,build}.json`. Pinned producer and Clang hashes, recipe SHA, detached writer exits and source pin are recorded.
- Initial V20 native emission failed because wrappers supplied a semantic reference to address/integer conversion. Fix `837b591a1` takes the referenced header address directly; backend type-category restrictions are unchanged. Frozen failing binary/source/evidence remain available.

## Runtime, ABI, debug and cache gates

- Six native baseline/candidate pairs: resize growth/refusal and retained elements, copy, over-alignment, zero-size storage, bounds trap, observing callback. All runtime parity, DWARF verification and source debug facts pass.
- Four Wasm32 direct-backend baseline/candidate pairs execute successfully, including resized/copy/over-aligned/zero-size storage.
- Fresh-process cold→first layout edit (i32→u32)→second layout edit (u32→i64)→unchanged: outputs42→43→44→44, with separate check processes and retained cache through each mode. Baseline and repaired candidate both pass.
- The raw generated-copy ABI probe resolves the actual helper symbol from the emitted wrapper call, then uses separately compiled C to test overlapping moves both ways, zero length at count and three range refusals without writes. It constructs no authored overlapping shared slice; the four-word header is an internal lowering fixture, not a source representation promise.
- Actual authored invalid-copy observer tests cover destination start, destination end and insufficient source length. Complete callback identity/source-origin output and trap status match V19 exactly in all three cases.
- Independent parameter-forwarding lane:4native builds and14cache/reference gates pass, including debug parameter/variable identity and location-kind parity.
- Full original compiler and Harf native captures succeed. The resulting compiler additionally passes a fresh two-module check smoke.

Evidence receipt: `shared-storage-v20-native-validation.json`. Raw ABI evidence: `benchmarks/storage-raw-abi-x9pdnrn6`. Observer evidence: `benchmarks/storage-observer-erlkc224`. General resize tests do not force host allocator exhaustion or realloc movement; that remains a stronger optional allocator-interposition guard.

## Actual emitted instruction counts

All43,126 original compiler function symbols and all6,336 original Harf function symbols remain. V20 adds144 and30 generated storage helpers, respectively. The table sums unique function bodies, including those new helpers; packing duplicates cannot inflate the comparison.

| Workload | Metric | V17 | V20 repaired | Change |
| --- | --- | ---: | ---: | ---: |
| compiler | allocas | 796,728 | 789,288 | -7,440 (-0.93%) |
| compiler | loads | 993,211 | 827,497 | -165,714 (-16.68%) |
| compiler | stores | 679,322 | 669,806 | -9,516 (-1.40%) |
| compiler | calls | 556,517 | 545,777 | -10,740 (-1.93%) |
| compiler | ir_text_bytes | 262,927,863 | 250,772,173 | -12,155,690 (-4.62%) |
| harfrust | allocas | 140,174 | 140,238 | +64 (+0.05%) |
| harfrust | loads | 285,878 | 266,954 | -18,924 (-6.62%) |
| harfrust | stores | 160,393 | 160,428 | +35 (+0.02%) |
| harfrust | calls | 65,158 | 64,652 | -506 (-0.78%) |
| harfrust | ir_text_bytes | 52,312,176 | 51,234,615 | -1,077,561 (-2.06%) |

Harf's slight alloca/store increase is retained explicitly: fewer and smaller typed bodies do not guarantee fewer slots after accounting for shared helper bodies. Loads decrease on both workloads.

## Actual helper sharing

- compiler: 1,218 matched typed wrappers call 144 generated helpers. Combined wrapper/helper IR text 7,842,131→2,599,123 bytes; loads 33,495→10,299. Outside this group, loads change by -142,518.
- harfrust: 52 matched typed wrappers call 30 generated helpers. Combined wrapper/helper IR text 430,569→246,769 bytes; loads 2,054→1,088. Outside this group, loads change by -17,958.

Typed wrapper symbols, ownership checks and authored trap locations remain distinct. These helper-group counts demonstrate physical sharing in emitted native input; they do not claim all redundant semantic specialization work has disappeared. The outside-group load delta is consistent with parameter forwarding, but a separate mechanism A/B is needed for isolated CPU attribution. The old IR-only parameter-spill eligibility counter changes classification after forwarding and should not be used as an exact removed-load attribution.

## Durable input evidence

Original workloads: silk/compiler/stdlib `a63f612150a0b91a118c8111b910b12c3e124b50`, nonstd `ccb168b773bb56d7bd60a3495141d427149766d0`, default full-debug O0 target output. Matrix source/CPU metadata matches V17. Reports: `v20-{compiler,harfrust}-storage-census-comparison.json` and `v20-{compiler,harfrust}-storage-helper-sharing.json`.

Each capture retains native argv, environment, source archive hashes, exact bitcode-input hashes, compressed per-function data and artifact hash. Completed raw bitcode is now losslessly gzipped with original/decompressed SHA and byte verification in each capture's `bitcode-lossless-compression.json`; decompress to its recorded original path for replay. Executed scripts are archived by SHA. Generated executable/source copies were compressed/pruned only after success and receipts. The pre-existing support-input DICompileUnit(file:null) warning remains recorded in baseline/candidate disassembler logs; these counts do not establish a new support-DWARF validity claim.
