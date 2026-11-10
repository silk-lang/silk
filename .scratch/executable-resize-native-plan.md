Resize native gate (prepared only; not executed)

Source: .scratch/executable-specialization-resize a41f78c2c. Run only after parent authorizes an optimized diagnostic bootstrap and shared compilation slot. Invoke under flock -s .scratch/performance.lock; runner adopts/reaps descendants. No performance conclusions from this gate.

Command:
  python3 .scratch/executable-resize-native-gate.py --compiler <Resize binary> --tree .scratch/executable-specialization-resize --first-only
Then the same command without --first-only after the first actual specialization succeeds.

Fixtures:
- executable-resize-fixtures/resize.silk: a user-authored @inlineNever unsafe generic grow_buffer wrapping only Intrinsic.rawBufferResize. Five logical types: i32, u32, nominal Element{i32}, [u64;3], and (). Three initial executable footprints: (size,align)=(4,4),(24,8),(0,1). Expected exit42. Each nonzero type rejects shrink and usize.MAX, preserves count, grows, and preserves initialized values. Unit refuses. Overaligned allocation uses Layout.make(8,64), then grows to64 i32 slots and preserves values; this proves adopted alignment handling, not an author-declared over-aligned element.
- resize-adopted.silk: copies the corpus Pool allocator and exported reclaim callback. User wrapper must refuse adopted allocation without changing capacity/data, allocating again, or reclaiming early; drop invokes callback exactly once. Expected exit42. This distinguishes reclaim-tagged storage from system ownership.

Gate: cold OFF/ON, reversed representative visit order, speed OFF/ON, adopted OFF/ON; immediate cached element-layout edit (Element gains i32 padding), exact restoration, extra-local certificate refusal with same behavior, changed body returning false (exit4), restoration, unchanged cache hit and ON/OFF/ON policy transitions. Layout edit must add one canonical footprint, then exact previous binary must return on restoration. Each build verifies runtime and DWARF; unoptimized symbol scopes distinguish five logical definitions vs three canonical definitions. ON metadata must retain parameter names/storage locations and honest RawBuffer<opaque> header fields. Canonical names must be independent of logical visitation order. Gated counters prove MIR-template and text reuse actually occur.

Known limits: fixtures and runner are source-only and may need syntax or DWARF parser corrections at first execution. No malloc failure injection; usize.MAX exercises checked refusal without relying on host exhaustion. No claim that the over-aligned allocation implies over-aligned element types. No wrapper forwarding/callee inline policy tests until that extension exists. Compiler whole-build parity remains required after this small gate.
