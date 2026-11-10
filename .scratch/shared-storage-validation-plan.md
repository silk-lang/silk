# Shared storage helper validation queue

This is a source-only compiler experiment, not production-ready. Compiler work is dispatched by the parent and uses the shared performance lock; no wall-speed claim comes from these runs.

## Source and structured MIR gates

```
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/validate-shared-storage-source.py --phase both
```

The pinned CI N1 sourcechecks the frozen helper tree and runs `storageResizeHelpersShareOnlyPreparedLayout` from SemanticRootCases at O0/debug=false. Exact argv, source revision, binary SHA, process-tree usage and detached writer exits are saved in shared-storage-validation.json. The runner refuses a dirty tree and requires at least900MiB free. Parser/type corrections get new commits and preserved attempt logs. It does not bootstrap a new compiler.

Structured coverage: same-layout typed resize/copy wrappers share a generated key; different layout, operation, target, alignment or sealed allocator identity remains distinct; typed wrappers contain tracked ordinary call edges; copy retains its authored trap; generated helper MIR is independently reconstructible without its first typed creator.

## Once a candidate compiler is explicitly scheduled and built

Use the same unchanged standard library/source tree for baseline and candidate. V17 and helper base3807 have identical standard-library source. Source wrappers retain their symbols/debug identities; extra generated helper scopes are expected, so full artifact bytes and total function counts are not equality requirements.

```
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/validate-shared-storage-runtime.py --candidate CANDIDATE --phase native
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/validate-shared-storage-runtime.py --candidate CANDIDATE --phase wasm
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/validate-shared-storage-runtime.py --candidate CANDIDATE --phase cache
```

Native: six matched baseline/candidate full-debug O0 pairs, fresh build caches, exact executable exit/stdout/stderr parity, llvm-dwarfdump verification and no lost typed source variables/types/locations. Cases include resize refusal/growth with initialized elements, ordinary copy, over-aligned storage, zero-size elements, slot trap, observing callback. A raw-pointer generated-helper ABI probe for overlapping copy in both directions and zero-length at count remains pending. The earlier authored shared-slice overlap fixture was removed: Pointer.borrowMany prohibits mutation during the borrow, so that fixture cannot establish valid language-level aliasing behavior.

Wasm32: four corresponding plain storage programs through the direct backend and Node execution. Baseline support is checked rather than assumed; an unsupported baseline target will stop and record a coverage gap. No silent fallback or claimed pass.

Fresh-process persistence: each compiler starts with its own empty package cache, then cold build, first edit i32→u32 plus changed observable result, second edit u32→i64 plus another changed result, then unchanged. All use one output path and keep caches/objects between stages. Every stage also starts a separate check process. Results42→43→44→44 prove changed source/layout reached executable output and a generated key is recovered through persisted parent MIR edges. This is correctness, not the eventual matched incremental-performance matrix.

Additional guard still needed before promotion: observed invalid-copy cases must compare actual callback identity/origin for destination start/end/source-length refusals. Structured MIR proves the trap remains authored, but is not runtime observer coverage. Realloc forced movement/refusal deserves a controlled allocator fixture if the general native growth test cannot force it. The complete compiler/Harf cold/direct-edit/warm matrices remain required before keeping the helper mechanism.

## Real cross-block SSA census (separate from helper experiment)

```
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/capture-v17-storage-census.py --workloads compiler,harfrust --include-missing-baseline
```

This performs V17 compiler+Harf captures and, only with the explicit flag, the missing V15 Harf baseline capture. Existing V15 compiler packs are reused. Three new builds in total, followed by bounded streaming disassembly; no full textual IR is retained. Input hashes, exact original workload/library revisions, argv, content-addressed raw BC, gz per-function counts and artifact/source compression receipts are durable. Unique and matched-symbol load/store totals avoid packing/support-definition noise. Existing V17 native binaries/objects cannot establish emitted LLVM instruction counts.

Disk floor remains900MiB before each capture. Retained BC is roughly76MB for the known compiler input; Completed Harf capture is roughly22MiB including evidence. All three builds and four scans are now complete; see v17-storage-census-report.md. Completed own source copies/cache trees are removed only after output/input hashes and successful process settlement are recorded; generated executables are losslessly compressed. If headroom drops below the floor, stop between workloads rather than lowering it.

## V20 first native gate and correction

Frozen V20 source232738480 built successfully as frontier-native-work-v20 (SHAe42efb932a2054a43a1717d8321ff0b3677e49a4eaab8c9b5c624ad0a500de7b). V19 baseline compiled and ran the new resize fixture with exit42. V20 refused during LLVM lowering: shared copy/resize wrappers supplied a semantic reference to AddressIntegerConversion, which intentionally accepts raw pointers or usize only. Evidence is benchmarks/shared-storage-native-_iy3v4ey; no V20 native pass is claimed.

Helper correction837b591a1 takes AddressOf the dereferenced borrowed header directly. The backend restriction stays unchanged. The structured test now checks raw header addressing without reference/integer conversion; sourcecheck passes, focused gate and repaired-compiler native evidence follow separately. The runtime harness removes --timings from positional legacy build CLI, which rejects that option; this harness correction is unrelated to the compiler defect.
