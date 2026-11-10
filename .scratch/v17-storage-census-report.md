# Actual native LLVM census: V15 to V17

Completed all three capture builds and all four streaming scans. These are static emitted-instruction counts from matching original compiler/library workloads, not measured CPU savings. Shared execution means capture wall times are not performance evidence.

The compiler matches all 43,126 unique function symbols; Harf matches all 6,336. Neither workload adds or removes symbols or changes calls/parameter counts. Comparing unique matched functions removes release-unit packing duplication from this result.

| Workload | Instruction | V15 | V17 | Change |
| --- | --- | ---: | ---: | ---: |
| compiler | allocas | 835,251 | 796,728 | -38,523 (-4.61%) |
| compiler | loads | 1,040,538 | 993,211 | -47,327 (-4.55%) |
| compiler | stores | 717,845 | 679,322 | -38,523 (-5.37%) |
| compiler | calls | 556,517 | 556,517 | +0 (+0.00%) |
| harfrust | allocas | 141,563 | 140,174 | -1,389 (-0.98%) |
| harfrust | loads | 287,739 | 285,878 | -1,861 (-0.65%) |
| harfrust | stores | 161,782 | 160,393 | -1,389 (-0.86%) |
| harfrust | calls | 65,158 | 65,158 | +0 (+0.00%) |

V17's SSA expansion removes real loads and stores on both workloads. The larger compiler change supports measuring the implementation, but does not establish how much native compilation time it saves.

## Next opportunity: stable parameter spills

A conservative IR-only scan found 210,319 loads from 75,195 unchanged direct-argument spill slots in the compiler (21.18% of remaining loads), and 117,785 loads from 27,588 such slots in Harf (41.20%). The counts are identical before/after V17. Some eligible slots have no loads; the load totals count actual instructions.

The scanner requires exactly one ordinary direct argument store and only ordinary loads/debug records referencing the scalar slot. It rejects reassignment, address exposure, slot GEP, atomic/volatile accesses and lifetime markers; transparent argument casts are not followed. It does not establish MIR LocalKind or dominance. Named parameter slots, stores and DWARF locations can remain while generated loads are forwarded, but debugger writes and language aliasing contracts need an explicit policy. The independent parameter-forwarding prototype is owned by build_pipeline.

## Reproducibility and limits

- Workload/library: original silk a63f612150a0b91a118c8111b910b12c3e124b50 and nonstd ccb168b773bb56d7bd60a3495141d427149766d0; full-debug O0 output on the same target.
- V15 compiler: source 9ac1c62f1f85a0f06411ce6f5f4c25bbd5995cc9, binary SHA256 f5e4b3a29de87ad1e562bf27d05bf1a568c7520336f2e3440fc364f4e33c3cf7.
- V17 compiler: source 060ec3a13d06eeb4517739fe740598a7561e7c40, binary SHA256 79b8f4b494f3b443a989c8ea8dfd7fc33f5c92c2fa26569d84968f5f2331e0c4.
- Per-workload comparison JSON: v17-compiler-storage-census-comparison.json and v17-harfrust-storage-census-comparison.json.
- Capture evidence: benchmarks/backend-storage-v{15,17}-{compiler,harfrust}-capture. Each contains exact native argv, input bitcode hashes, source revisions, census-ssa-inputs.json and compressed per-function data. Generated outputs are losslessly compressed with verified receipts; completed duplicate source/cache trees were pruned only after recording hashes.
- The disassembler reports an existing support input's DICompileUnit(file:null) warning in both baseline and candidate. Logs preserve it; this census does not claim new DWARF validity for that pre-existing support input.
- All compiler processes and detached writers completed successfully; V17's generated compiler additionally passed a fresh two-module check smoke.
