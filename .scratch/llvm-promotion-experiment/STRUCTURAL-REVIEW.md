# Promotion placement review — V11 source 044087bc4

Read-only feasibility review, no workload/compiler/plugin execution.

## Exact next capture

`capture-v11.py` now consumes the scheduled V11 matrix metadata at `benchmarks/integrated-incremental-uxdcjhol/metadata.json`. It authenticates the candidate SHA `e8937508ffd3349c93ec01f4288742a3170862119c4c3e51b76a584b99c42852`, archives original Silk `a63f612150a0b91a118c8111b910b12c3e124b50` plus nonstd `ccb168b773bb56d7bd60a3495141d427149766d0`, and uses the frozen baseline stdlib. Compiler construction source 044087bc4 is deliberately distinct from the benchmark workload source a63f61215.

Both compiler and Harf use the same matrix feature policy, native packing, default O0/debug profile, and inherited CPU affinity `[0,1,2,3]`; no reshare flag is added. Capture imports the matrix's environment policy helper. Clang child records include observed affinity. Replay restores that exact lane and refuses a worker count larger than it. No capture is currently executed.

After root schedules the slot:

```
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/capture-v11.py /workspace/silk/.scratch/benchmarks/llvm-promotion-v11-compiler --workload compiler
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/capture-v11.py /workspace/silk/.scratch/benchmarks/llvm-promotion-v11-harf --workload harfrust
```

The earlier PLAN.md debug/runtime/identity gates and external-opt replay protocol remain applicable. New input packs must pass baseline reconstruction before measuring a transform.

## Recommendation: measure external opt, then a Clang pass plugin if promotion pays

The smallest way to avoid external opt overhead is a tiny LLVM pass plugin **inside the existing Clang native compilation process**, not an LLVM runtime embedded in Silk. The shipped Clang supports `-fpass-plugin=<dso>`. LLVM 22's `llvm/Plugins/PassPlugin.h` exposes versioned `PassPluginLibraryInfo`; `PassBuilder.h:500` exposes `registerPipelineStartEPCallback`. An O0-gated module-to-function adaptor can run `PromotePass` (`Transforms/Utils/Mem2Reg.h`) or `SROAPass` (`Transforms/Scalar/SROA.h`) before the existing Clang O0 pipeline.

This could remove a second LLVM bitcode parse, transformed bitcode serialization/write/read, and the extra opt process per pack. It retains Clang's native target setup, ABI/backend options and DWARF emission, and does not need a new Silk lowering implementation. The native input's effective data layout is already available inside Clang, avoiding the external opt probe problem. It would not reduce Silk's original IR construction/serialization cost.

Compatibility is promising but **not proved**: confirm the pipeline-start callback actually runs for `clang -O0 -x ir` in this LLVM release, the plugin can resolve symbols from this statically linked LLVM distribution, and exactly one desired pass runs. A plugin can fail to load or a callback can be skipped; neither may silently become a claimed win. Shipped headers expose plugin API version 2; example code targeting older LLVM plugin layouts is not assumed compatible. `llvm-config --shared-mode` says static and RTTI is disabled. Pin the plugin to the exact toolchain/header build and record its hash. Full debug-variable location and native behavior gates remain necessary; a plugin does not make optimization debug-neutral automatically.

External opt is still the simplest independent reference for pass effectiveness. If it reduces stack operations but fails net wall/CPU due to duplication, test the plugin before discarding promotion. If even Clang CPU barely drops, a plugin's startup saving cannot establish a major structural gain. The experiment must expose transform CPU and Clang CPU separately.

## Why embedding LLVM in Silk is the larger option

The C APIs exist: `LLVMParseBitcodeInContext2`, `LLVMRunPasses`, and `LLVMTargetMachineEmitToMemoryBuffer/File`. However current Silk has no libLLVM integration and the supplied SDK exposes static component libraries rather than a libLLVM shared library. Embedding introduces target initialization, context/module ownership, versioned native linkage, thread isolation and error handling. Replacing Clang emission also requires matching target options, debug/backend behavior and the existing parallel native scheduler. Retaining Clang after embedding still serializes LLVM again, saving only opt startup. This is materially more scope than a pass plugin and is not the first experiment to pursue.

## Emit-time full SSA is a real larger architecture, but needs new control-flow/debug support

Current `StackLifetimes.scalarTemporaries` (line 131) selects only single-definition unnamed Temp locals whose direct reads follow that definition in one MIR block. `LlvmCode.emit` (around 5800) visits MIR blocks in numeric order; its single `registerValues` vector is not a reaching-definition map. Ordinary call arguments now use values, but `emitCallInner:4477` still obtains an output address unconditionally and line 4604 stores every direct scalar returned value before branching to the normal successor. `emitReturn:3746` can read through the value path, but return local zero is not selected by the Temp-only proof. These are concrete residual stack sources.

Existing reusable machinery:

- `MirFunction.successors` and the flat predecessor construction in `StackLifetimes.liveness` around 549.
- Comprehensive read/whole-write/partial-write/address-escape collection in `blockEffects`.
- `Bitcode.Module.reserve/bind` (1364/1371) for forward value references, and `Module.phi` (1610) for joins/backedges. LLVM binary serialization already supports these; no new bitcode instruction format is required.
- Storage-representation filtering and guarded Value metadata established by the current scalar SSA lowering.

A sound next architecture would create per-block SSA definitions for non-address-taken scalar Temp locals, give ordinary scalar call results definitions on their normal edge, and use dominance/phi construction at joins and loops. Emission would reserve values ahead of block order and bind definitions, rather than rely on one mutable function-wide value vector. Failure results/providers/context, indirect ABI destinations, coroutine frame storage, and projected writes remain in memory until independently modeled. LLVM helper blocks created during lowering must be reflected in phi predecessor identities, not confused with original MIR block IDs. Definite assignment/poison behavior must follow Silk's validity rules rather than synthesize arbitrary zero values.

Debug-visible User/Parameter promotion is a separate larger contract: `Bitcode.Module.variable` (1821) only describes a slot and encodes `#dbg_declare`; there is no corresponding value-location marker API. Preserving debuggability for full SSA requires `dbg_value`/assignment locations across redefinitions, edge joins and scopes, plus unavailable-value handling. Keeping source-visible slots initially avoids that work but caps the opportunity. LLVM mem2reg already owns this debug-update machinery, making the plugin a useful reference before reproducing it in Silk.

Evidence supports opportunity, not a quantified promise. The previous V8 census still had 1,112,736 allocas/1,092,033 loads/769,363 stores in the compiler, and 172,865/290,589/164,626 in Harf. That census predates the two latest bounded SSA expansions and is not a V11 count. Many remaining addresses are required aggregates/borrows/debug slots, so these totals are only an upper bound on eliminable instructions. Prior same-block SSA removed about 10% of compiler allocas with only 3.86% textual IR size reduction. No percentage of the remainder is claimed promotable without the prepared pass experiment.

Order of work: validate and measure minimal promotion; test in-process Clang plugin if extra opt costs obscure savings; use the surviving hot instruction patterns to choose a larger SSA plan. Do not replace the backend or change debug quality merely to obtain an apparent speedup.
