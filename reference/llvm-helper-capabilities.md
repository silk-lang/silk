---
title: LLVM helper capabilities
description: Explicit post-legalization support contracts and closed provider objects.
---

LLVM helper requirements arise from emitted target objects, after legalization. They are distinct from source foreign declarations and language execution-runtime contracts. Every external reference must have one of those explanations before a final link. The report records the object and symbol origin, C ABI, capability family, selected provider, target availability, linkage, visibility and retention. Unexplained references diagnose; the compiler never guesses a library from a foreign symbol's spelling.

Memory, arithmetic, atomics, stack probes, stack protection, sanitizers and unwind are independent families. The initial memory contracts are C `memcpy`, `memmove`, `memset` and `memcmp`. Pointer and length widths follow the target; fill and comparison values use C `int`. `memcpy` requires non-overlap; `memmove` preserves overlap semantics; zero length accesses no byte. Hosted arithmetic initially admits `fmodf` and `fmod` with the platform's float/double semantics. GNU selects a compatible libm only for an actual helper need; Darwin uses its selected libSystem contract. Unsupported families and no-libc arithmetic providers fail explicitly.

A hosted native profile already links the platform C library, so that library supplies every admitted memory helper: GNU libc, or Darwin's libSystem. The report names the platform provider, and no helper object or extra library input is added.

Native profiles without libc use memory providers written in ordinary Silk source and compiled with explicit retained C-export roots. Their restricted support profile has object form, no application entry, no runtime root, no libc, no sanitizers and no foreign unwind. Every program copies memory through these helpers, so they are always compiled optimized, whatever the program's own optimization mode; only the memcpy/memset loop-idiom transformations that could recreate the implemented helper are disabled. The resulting object must still prove its dependency closure. Declared direct/transitive provider cycles, emitted self-calls and undeclared support dependencies all reject with an origin path.

Existing wasm32 memory support is an explicitly identified bootstrap component with its own content identity and target contract. It does not select native libc. Allocation/coroutine policy and later source runtime composition are separate responsibilities.

The final plan retains selected source-provider objects and accounts for provider contracts, dependency edges and physical input content in its identity. An object or archive can expose unresolved requirements; it must not claim the closed semantics of a final executable. LTO is unavailable until post-LTO helper discovery and provider reconciliation are verified.

Required conformance uses actual Darwin ARM64 and GNU x86-64/ARM64 objects in debug and optimized modes, independent C ABI fixtures and native execution where runners exist. Missing supplies and skipped required cases fail. The exact LLVM 22.1.8 and SDK/glibc/tool baselines and comparative implementation evidence live with the helper OpenSpec change.

## Address observation and object-local implementations

`Intrinsic.pointerAddress<P>(pointer: P) -> usize` accepts a raw data pointer and observes its unsigned address in the target pointer width. `Pointer.address` and `Pointer.addressMany` expose single-element and many-element forms. Observation does not read memory, retain a loan, or reconstruct a pointer from an integer. It is a runtime operation. The source memory provider uses unsigned address order to choose its copy direction.

Support compilation retains each requested C export while giving source implementation functions internal linkage. It rejects application entries, runtime allocation, suspension, OS operations, foreign calls/statics, indirect calls and assembly. Its export thunks forward directly because this closed source call graph cannot unwind through a foreign call. Ordinary foreign-call guards are unchanged. Darwin permits no-libc object/archive profiles for this freestanding composition; hosted final artifacts continue to require libSystem.

LLVM 22.1.8 additionally emits `bcmp` for GNU equality-only comparison and `bzero` for Darwin zero fill. Hosted profiles take both from the platform C library. Without libc, the source provider for `bcmp` returns an i32 zero/nonzero result from two byte pointers and a size_t count. The source provider for `bzero` returns void and accepts one byte pointer and a size_t count. Their selected strings.h signatures and actual optimized legalization are independently verified. These aliases are unavailable in the existing Wasm bootstrap.
