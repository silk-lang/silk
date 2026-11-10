# Native O0 scalar promotion experiment (prepared, not run)

No product source/profile/debug change. Frozen V8 source `3eb51811ab9f0cf8d2ca0529e47810f792e177a3`, compiler SHA `7f7ef0b6c309bb1da71e949ed5b66414591fa0fc2dd2225c8c7ed245122f5c68`, LLVM 22.1.8. The original V8 full-build temporary packs have been deleted, so an untimed cold capture is required. Older monolithic bitcode is deliberately not substituted.

## What is being tested

For each authentic full-debug native bitcode pack, compare the exact captured Clang O0 command against `opt -passes=function(mem2reg)` then that same command. If this works, separately test `function(sroa)`, which includes promotion and need not be followed by redundant mem2reg. There is no Silk `optnone` attribute. Ordinary allocas remain candidates, including call-result slots excluded by Silk's conservative local SSA planner.

Clang reads binary bitcode directly already. This experiment targets remaining stack traffic and native instruction-selection work, not a nonexistent textual-IR round trip. Native packs omit the target triple/layout; capture probes the exact effective layout from the same Clang target/feature flags. Both transform passes receive this exact layout and triple. No CPU/ABI/profile changes are permitted.

## Prepared commands (run only after root schedules CPU slots)

Untimed capture under the shared correctness lock:

```
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/capture-v8.py /workspace/silk/.scratch/benchmarks/llvm-promotion-v8
```

Capture retains content-addressed binary packs, link objects/stubs/maps, original argv/cwd/input digests, and exact output-to-input linkage. It forwards Clang arguments unchanged, reaps the compiler's detached writers, and uses a fresh git-archive source tree with the original V8 retained-build configuration. It does not mutate preserved V8 evidence. Captured command/input hashes make scheduling-independent inputs reviewable.

After correctness gates, run replay under an **exclusive** lock, rounds in reversed order (`baseline,mem2reg,sroa`; then `sroa,mem2reg,baseline`):

```
flock -x /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/replay.py /workspace/silk/.scratch/benchmarks/llvm-promotion-v8/capture /workspace/silk/.scratch/benchmarks/llvm-promotion-v8/round-1-baseline --layout-json /workspace/silk/.scratch/benchmarks/llvm-promotion-v8/layout.json --mode baseline
```

Use a distinct output directory for every replay. Four workers and the same deterministic largest-pack-first queue in every mode. Within each worker, opt then Clang run sequentially; the timed interval includes both subprocesses, temporary input reads/writes/deletion, and the final executable link. Captured platform-support objects are constant across modes. Report backend wall/CPU separately from full-language build time. Do not add backend savings to old end-to-end timings as if measured. Max RSS is explicitly **maximum individual process RSS**, not aggregate memory.

## Required correctness gates before timing/retaining a candidate

1. Inspect captured bitcode attributes to confirm no `optnone`; record all input sizes, function counts and checksums. The baseline replay must reproduce the captured executable or explain any deterministic linker variation before continuing.
2. On an untimed transform pass, use `-verify-each -verify-debuginfo-preserve -verify-di-preserve-export=<file>` and inspect its diagnostics. The timed harness omits these validation-only passes. Retain transformed samples and compare original/transformed LLVM function/debug-variable/type/scope identities. Counts alone are insufficient proof of fidelity.
3. Relink each transformed pack set. Run `llvm-dwarfdump --verify` on baseline and variants, compare semantic debug DIE identities (names/types/lexical scope/parameter identity, ignoring layout offsets), and inspect variable location lists for representative mutable locals/parameters. Promotion can convert `dbg_declare` to `dbg_value`; loss of debugger-visible variable availability is a failure even if types/scopes survive. No debugger was found during initial inspection; arrange a debugger probe or report this validation limit explicitly.
4. Run native SSA cases (signed/subword/bool/pointer, checked conversion/overflow/trap, foreign/variadic ABI, observing callbacks, suspension) through each resulting compiler, plus generated-compiler `--version`, successful check/build smoke and invalid-source diagnostic parity. Include a generated compiler self-check when scheduled. Byte-identical machine code is not expected after promotion; observable behavior and debug fidelity are required.
5. SROA is higher risk: Silk deliberately avoids some wide integer memory operations for Clang O0's fast selector. Inspect whether SROA invents i128/aggregate/vector operations and ensure full compiler plus Harf passes. A mem2reg result does not establish SROA safety.
6. Only after net backend wall/CPU improves, repeat an end-to-end native build with a controlled wrapper including the actual transform overhead. Keep all flags/debug/packing constant, then evaluate cold and edited workloads. No shipping switch or source implementation before evidence.

The scripts have only been Python syntax-checked. No capture, opt workload, transformed compiler, or performance claim exists yet. Disk management: compressed source already small; remove replay unit objects and duplicated executable after recording hashes/guards, retaining capture once and compact reports. Do not remove any baseline evidence used by other agents.
