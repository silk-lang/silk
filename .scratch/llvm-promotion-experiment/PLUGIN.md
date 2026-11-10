# Isolated O0 promotion plugin — source prepared, not compiled

`PromotionPlugin.cpp` uses LLVM 22.1.8 plugin API 2 and checks those header versions at compile time. It registers exactly one function-pass adaptor at PipelineStartEP **only at O0**. Default mode runs `PromotePass`; separately compiled SROA mode uses `SROAOptions::PreserveCFG`. It does not replace code generation, set target options, rewrite the profile, strip debug information, or register anything at O1/O2/O3/Os/Oz. No product source changes.

The plugin build uses this LLVM's `llvm-config --cxxflags` (C++17, no RTTI/exceptions, matching C++ ABI) and `clang++ -O2 -fPIC -shared`. This O2 setting constructs the helper plugin; it does not change the workload's O0 codegen. It deliberately does not link a second static LLVM runtime. Whether the pinned Clang exposes all required symbols remains unverified until the loading probe runs; a build success alone is not plugin availability. Version compatibility is tied to the exact Clang hash, header version and plugin digest in build.json.

## Exact future commands (root must schedule the CPU slot first)

```
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/build-plugin.py /workspace/silk/.scratch/llvm-promotion-experiment/built-mem2reg --mode mem2reg
```

Optional independent SROA build, only after mem2reg evaluation:

```
flock -s /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/build-plugin.py /workspace/silk/.scratch/llvm-promotion-experiment/built-sroa --mode sroa
```

The build helper records exact argv and tool/source/plugin hashes. Run the tiny availability and O0-only gating probe first (all outputs in a new scratch directory):

```
clang=/workspace/silk/.scratch/llvm-22.1.8/bin/clang
input=/workspace/silk/.scratch/llvm-promotion-experiment/plugin-gate.ll
plugin=/workspace/silk/.scratch/llvm-promotion-experiment/built-mem2reg/promotion-mem2reg.so
flock -s /workspace/silk/.scratch/performance.lock "$clang" -O0 -g -x ir "$input" -S -emit-llvm -o /workspace/silk/.scratch/llvm-promotion-experiment/gate-O0-before.ll
flock -s /workspace/silk/.scratch/performance.lock "$clang" -O0 -g -fpass-plugin="$plugin" -Xclang -fdebug-pass-manager -x ir "$input" -S -emit-llvm -o /workspace/silk/.scratch/llvm-promotion-experiment/gate-O0-after.ll
flock -s /workspace/silk/.scratch/performance.lock "$clang" -O2 -g -x ir "$input" -S -emit-llvm -o /workspace/silk/.scratch/llvm-promotion-experiment/gate-O2-before.ll
flock -s /workspace/silk/.scratch/performance.lock "$clang" -O2 -g -fpass-plugin="$plugin" -x ir "$input" -S -emit-llvm -o /workspace/silk/.scratch/llvm-promotion-experiment/gate-O2-after.ll
```

Capture the pipeline trace; it must show `PromotePass` executing at O0 and the O0 alloca must disappear. O2 before/after IR must agree, because no plugin pass is registered there. Failure to load, a missing callback, or unchanged O0 alloca is an availability/placement failure, not a performance result. This tiny probe is not enough for semantics/debug validation.

Then run exact V11 full-debug capture (`STRUCTURAL-REVIEW.md`) and untimed full workload parity. Add only `-fpass-plugin=<verified absolute path>` to each captured native Clang invocation. Use the usual native output/diagnostic probes and DWARF verification/variable-location gates from PLAN.md; retain target flags and debug settings unchanged. Verify the plugin processes every native pack, not just the helper probe. Full-debug source-visible variables can become `dbg_value`: verify their availability, names, types, scopes and parameter identities, not just node counts.

The replay harness supports `--mode plugin-mem2reg --plugin-build .../built-mem2reg/build.json` (or plugin-sroa) and authenticates exact host/plugin hashes. Example timed invocation after correctness passes:

```
flock -x /workspace/silk/.scratch/performance.lock python3 /workspace/silk/.scratch/llvm-promotion-experiment/replay.py /workspace/silk/.scratch/benchmarks/llvm-promotion-v11-compiler/capture /workspace/silk/.scratch/benchmarks/llvm-promotion-v11-compiler/round-1-plugin --layout-json /workspace/silk/.scratch/benchmarks/llvm-promotion-v11-compiler/layout.json --mode plugin-mem2reg --plugin-build /workspace/silk/.scratch/llvm-promotion-experiment/built-mem2reg/build.json
```

Run baseline/external-mem2reg/plugin-mem2reg in reversed matched rounds on identical packs and inherited four-core lane; Harf separately. Dynamic loading cost is included. SROA must be separately labeled; external `--mode sroa` now uses `function(sroa<preserve-cfg>)` to match the plugin precisely. No silently stronger SROA pipeline. Report backend wall/CPU separately from end-to-end compilation and debug-fidelity limits explicitly.

Status: C++ source/header API inspected; Python helpers syntax checked only. No plugin build, loading probe, capture, or promotion timing has run.

## Executed availability checkpoint

The pinned mem2reg plugin now builds and loads successfully. The original source-only draft had a missing closing brace, fixed before the successful build. Use `built-mem2reg-r2/build.json` and its `promotion-mem2reg.so`; the earlier `built-mem2reg` contains only the failed build manifest. `gate-r2/results.json` records an O0 trace with exactly one PromotePass and alloca removal, byte-identical O2 IR off/on, and both O0 native executables returning42. This is an availability/placement probe only: its tiny LLVM fixture has no source-variable debug metadata. Full DWARF, language corpus and workload performance remain unvalidated.
