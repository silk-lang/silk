# Native build work reduction after V18

Read-only audit during the V18 immediate-edit timing window. No compiler jobs or source edits.

## What the existing profile rules out

The V13 diagnostic attributes15.242user-CPU seconds toClang and0.081toLLD. Work spans instruction selection, machine instruction construction, two-address lowering, fast register allocation, debug live ranges, bitstream parsing and object writing. There is no measured single removable optimization pass. Native222jobs already have four static batches finishing within~0.6s. More aggressive global packing previously regressed first edits; keep current package-coherent1MiB groups.

Selected artifact emission starts38170.086659311 and ends38171.840061245:1.7534s. Samples account for4.8586user-CPU seconds. First1.0s occupies~3.6–3.8CPUs; only final~0.55s is near1CPU. At four CPUs, at most2.155CPU-seconds remain before kernel/other shared-slot work, equivalent to~0.539s of perfectly four-way native work. This is an optimistic scheduling envelope, not an observed speedup or a strict wall-time bound. Details: `native-emission-streaming-envelope.json`.

Therefore do not build a new unit-streaming protocol solely for this measured tail. Current whole-owner cmd5 replies and byte-dependent module packing make early native readiness nontrivial. Keeping exact current groups would require incremental definition transport, per-module roster completion, package grouping readiness, global declaration conflict handling, bounded CPU sharing and deferred output publication. That complexity is not justified by the current subsecond overlap envelope.

## Strongest next evidence-driven candidate

Keep named/parameter memory storage and all stores for full debug fidelity, but reuse a proven immutable scalar value instead of loading its slot repeatedly.

Current relevant source in `performance-v18-source/compiler/src/backend/LlvmCode.silk`:

- `emitEntrySlots`~5145 spills ordinary scalar parameters into debug-addressable slots.
- `loadPlace`~2061 always loads non-register local values.
- `emitPlace`~2024 starts at the local slot and the first `Step.Load` reloads a pointer even if that pointer parameter never changes; every field access can repeat this.
- Current `StackLifetimes.scalarTemporaries` excludes named variables/parameters and rejects projected reads entirely, so V17 temporary SSA does not remove this category.

Minimal sound first scope: ordinary scalar parameters, never reassigned and whose own slot address never escapes. Preserve original alloca, initial store and `dbg.declare`; use the original LLVM argument for direct reads and for the first pointer dereference. Mutating the pointee is not mutating the pointer's own slot; the analysis must distinguish these effects. Exclude native/coerced/indirect parameter ABI, coroutine frames and any uncertain address use. A later single-definition named binding variant can preserve its store while caching its value, but does not belong in the first change.

This differs from rejected whole-function LLVM mem2reg, which removed debug storage and reduced location coverage. It changes no ABI and leaves debugger memory locations intact. Benefit is unmeasured. Profiling agent was asked to count slots with exactly one LLVM-argument store and only loads/debug-declare uses, plus total repeated loads, during the already planned V17 streamed census. Only proceed if that measured category is substantial, and then require source/runtime/alias/DWARF gates and one-core timing.

## Other candidates and limitations

- Existing `LlvmCode.directBindings`~455 is disabled inO0. Its `MirCoalesce.bindingCandidate`~1546 and `joinBindings`~1597 prove a temporary call result can write a fresh borrowed named binding directly, avoiding a later aggregate copy while preserving that binding's storage. The optimized threshold128bytes is motivated by laterLLVM promotion, not necessarily O0. But current bindingCandidate builds a fullUseTable for each candidate call, so simply enabling it can add quadratic work; a shared per-function proof table and actual copy census are prerequisites. No eligible count is available yet.
- Whole exact-body duplicate ceiling is8.414%IR, and requires preserving address/debug identity; resize/copy helper subset is3.05%IR and profiling owns it.
- Native CPU cannot be labeled redundant load/store work from the profile alone. Many payload/address ABI accesses and debug stores are required. Actual V17 load/store delta and proposed parameter-load census must guide the next change.
- Native queue scheduling cannot by itself close the current multi-second3x gap. Walks owns remaining semantic/query setup work; bundle/cache changes and SSA must be measured together without shifting cost into edits.
