# Shared RawBuffer storage bodies: measured opportunity and bounded design

Evidence: `backend-storage-v15-duplicate-bodies.json`, its `.inputs.json` SHA receipt, and `backend-storage-v15-duplicate-rawbuffer.json`. The input is the original a63f612150a0b91a118c8111b910b12c3e124b50 compiler plus original standard library, emitted by backend-storage-v15 source 9ac1c62f1f85a0f06411ce6f5f4c25bbd5995cc9. This is an instruction/body census, not a CPU or speed estimate.

## Measured attribution

The exact duplicate census retains all non-debug callees, constants, ABI attributes, arithmetic flags and control flow. It normalizes only each body's own symbol and removes debug records. RawBuffer accounts for 4,176 matched functions across 235 groups; retaining one RawBuffer member per group leaves 3,941 redundant definitions, 261,818 instructions and 10,574,912 normalized bytes. This is 36.2% of all redundant definitions, 67.7% of redundant instructions, and 5.70% of all internal instructions. It is a subset of RawBuffer functions, not a total specialization count.

| Operation | Matched definitions | Exact groups | Redundant definitions | Redundant instructions |
|---|---:|---:|---:|---:|
| resize | 575 | 38 | 537 | 89,679 |
| copy | 577 | 38 | 539 | 50,666 |
| count | 609 | 1 | 608 | 7,296 |
| viewMut | 602 | 39 | 563 | 35,469 |
| view | 587 | 39 | 548 | 32,880 |
| from | 611 | 40 | 571 | 24,553 |
| slot | 615 | 40 | 575 | 21,275 |

All 4,176 matched RawBuffer functions have no observed non-direct address use in the captured LLVM inputs. Nevertheless their public typed wrapper identity and debug subprogram/type identity should remain intact. LLVM external linkage is needed for cross-unit generated calls and does not imply a source fixed/exported ABI. The census does not prove absent external references or interchangeable debug descriptions.

## Recommended first experiment

Outline the compiler-generated body of the sealed RawBufferResize storage operation into deterministic compiler-private helpers. Keep every source-level typed wrapper, its symbol, signature, parameters, return type, borrow/ownership checking and debug scope. Do not key semantic queries solely by runtime layout and do not recognize a standard-library path or spelling.

The existing generic wrappers in stdlib/silk/mem/raw_buffer.silk are already one-line intrinsic calls. Their costly body comes from Mir.lowerBufferResize, not authored generic business logic. A plain untyped stdlib struct cannot safely replace sealed Intrinsic.RawBuffer<T>; that would need a new sealed bridge and can erase contained-T lifetime evidence. Compiler-generated outlining instead applies to the original frozen library unchanged.

Proposed helper identity: storage operation + target/layout ABI version + measured element size/alignment + actual prepared allocator/call targets and their ABIs. Preserve any operation-specific context that affects behavior. Its storage parameter refers to the sealed RawBuffer header representation; no typed element loads, drops, copies or references escape this helper. Keep source-typed wrappers as the only boundary where T matters. Helper discovery must be explicit in the artifact dependency graph, with deterministic ownership/symbols and cache keys; emitting an untracked side function would be incorrect.

Initially retain size/alignment specialization. The 575 matched resize definitions contain 38 exact implementations: outlining can replace 537 duplicate heavy expansions with calls while retaining 575 thin typed wrappers. Net instruction savings are smaller than the measured 89,679 because wrappers acquire call/return overhead. The census does not establish that all 38 groups are precisely 38 unique layout keys; verify key equivalence before deduplication. A single dynamic-size helper could share further, but it adds runtime operands/arithmetic and should be a separate measured variant.

Resize is the clean first operation because it has no source trap path. Its contract must exactly preserve:
- zero-sized element refusal;
- system-reclaim and owned-context checks;
- no shrink, count/size/padding overflow checks, and zero-request refusal;
- realloc failure leaves every header field untouched;
- alignment after realloc and overlapping memmove when the aligned offset changes;
- updating base/count/context only on success;
- no calls to an ambient Allocator provider and no dropping of initialized elements.

Next consider RawBufferCopy. Resize+copy jointly account for 140,345 redundant instructions (3.05% of all internal instructions), before wrapper overhead. Copy needs source pointer/length, destination header/offset/length and measured stride, and must preserve memmove semantics and range checks. Trap origin/observer/site identity is a harder boundary: either keep checks at the typed callsite and share only address/move work, or explicitly carry the diagnostic context. Do not silently move all faults to a synthetic shared source location. The smaller count/view/slot/from wrappers should not be outlined blindly: an extra call can cost more than the eliminated tiny body, particularly at O0.

## Debug and runtime validation

The generic wrappers contain no substantial authored locals, but their typed parameters/result and source line must remain inspectable. Mark helper internals as artificial according to existing debug conventions; do not substitute the first encountered T's debug types for all callers. Verify source parameter/type/location inventories and stepping expectations rather than claiming byte-identical DWARF. Preserve wrapper function address identity even when the current corpus does not take it.

Structured cases should distinguish equal size/alignment but distinct T, different alignment and target word width, zero-sized T, fixed/exported wrappers and different allocator targets. Native cases should cover successful growth, refusal atomicity, over-alignment/moving allocation, overlap copies, range diagnostics, and provider noninterception. Repeat frozen compiler/Harf checks and builds with byte-correct executable behavior plus cold/direct-first-edit/subsequent-edit timings. Full corpus profiling must establish any CPU benefit: a 3.05% IR ceiling for resize+copy cannot independently achieve 3x cold build.

## Scope decision

Recommend compiler-private resize outlining as a bounded experiment, then copy only if measured benefit justifies its diagnostic complexity. It avoids heavy repeated MIR/LLVM expansion but does not erase generic wrapper semantic specializations. A broader type-erased List engine is a distinct library/API project and would require explicit matching library revisions in end-to-end comparisons. Do not change the original standard library underneath the existing baseline or implement production LLVM body merging from this census alone.
