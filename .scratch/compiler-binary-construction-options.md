# Compiler executable construction options

Read-only assessment, 2026-11-08. No new build or training was run.

## Existing measured evidence

The separate baseline code-quality experiment in `.scratch/benchmarks/REPORT.md` and `quality-summary.json` uses identical original source a63f61215, O2, no debug information and two cold trials per executable/workload. It measures execution speed of generated compilers, not their construction speed.

| Compiler executable | Compiler check | Harfrust check |
| --- | ---: | ---: |
| One LLVM unit, O2 | 21.843s | 7.783s |
| Four units, standard ThinLTO O2 | 22.553s | 8.488s |
| Four units, experimental full LTO | 24.595s | 8.518s |

One unit therefore saved about 3.1%/8.3% of four-unit ThinLTO time in these old-source workloads. This is not a measurement of the final finite-worker source. Baseline construction logs show 248.51s one-unit versus 107.19s four-unit. Rebuilding the final compiler as one unit is the simplest supported experiment, at a higher bootstrap cost. Full LTO did not improve runtime quality and is lower priority.

## Supported profile guidance

`main.silk::appendProfileGuidance` accepts `SILK_PROFILE_GENERATE` and `SILK_PROFILE_USE`; the profile digest participates in compilation cache flags. `.github/scripts/profile-guided-build.sh` already builds an instrumented compiler, cold-checks a copy of the compiler source and emits compiler LLVM IR, merges raw profiles with the adjacent `llvm-profdata`, then builds the optimized output. Release CI uses this, PR CI does not.

Expected effort: two optimized compiler builds, instrumented training and a matched evaluation matrix. One-unit builds roughly double the old four-unit construction cost. Preserve a single immutable source snapshot and separately report code-generation gains from architecture gains.

Training should cover both check and build and representative stdlib/corpus code, including static evaluation, generics, diagnostics and cached edits. Keep Harfrust and another substantial program held out. Existing self-training naturally exercises compiler inputs heavily; do not present a self-check-only gain as universal.

New process workers call `_exit` through `FrontierHost`, which skips ordinary atexit profile flushing. Serial training remains valid, but a parallel-only training run may omit worker counters. Use serial training initially; if measuring parallel-trained PGO, first implement and verify explicit worker profile dumping with unique process files. Do not change normal worker shutdown to libc exit merely for this experiment.

## Other options

- `codegen-units` accepts1–256; one is the supported default. Four or more invokes call-graph partitioning plus ThinLTO for eligible optimized executables.
- `optimization=speed` meansO2; there is no ordinaryO3 selector.
- CPU model/features are supported, but targeting a narrower ISA changes binary portability and should not be called a generic optimization.
- Current speed flags include inlining500 and disabled tail merging/runtime unroll, historically tuned on silkjs. Compiler-specific tuning could be measured with a controlled Clang wrapper; no evidence currently supports changing them.

## Prepared experiment runner

`.scratch/compiler_construction_experiment.py` is syntax-checked, with no heavy phase executed. It exports one exact Git revision, adds only a four-unit construction profile to the compiler manifest, hashes the producer/Clang inputs, uses the existing PGO script, scrubs experimental worker/profile/allocator environment flags for serial training, and reaps detached writers after every invocation. Heavy phases take the shared performance lock internally; do not nest another lock. Outputs record commands, construction time, input revision and executable/profile hashes.

Example preparation (substitute the final reviewed commit and frozen producer):

```
python3 .scratch/compiler_construction_experiment.py prepare \
  --work /workspace/silk/.scratch/construction-final \
  --revision EXACT_FINAL_COMMIT --producer /absolute/frozen/producer
```

Schedule the heavy phases individually, never during the exclusive benchmark window:

```
python3 .scratch/compiler_construction_experiment.py mono --work /workspace/silk/.scratch/construction-final
python3 .scratch/compiler_construction_experiment.py four --work /workspace/silk/.scratch/construction-final
python3 .scratch/compiler_construction_experiment.py train --work /workspace/silk/.scratch/construction-final
python3 .scratch/compiler_construction_experiment.py pgo --work /workspace/silk/.scratch/construction-final
```

The train phase uses existing compiler check/IR training, then stdlib checking and four explicit corpus representatives (schema-json, effect-catchall-section-handler, generic-finite-type-cycle, static-parameter-finite-chains). It does not train on Harfrust, edits or unchanged hits. It uses serial gates of the current implementation (experimental process flags absent); if final CLI policy enables workers by default, wire its explicit serial option before training. PGO and unguided mono both use the existing single-source CLI with explicit speed/no-debug settings (default unit count one); the four-unit control uses the project profile CLI. The optional four phase gives a same-revision construction baseline; an existing four-unit binary is comparable only when its exact source/compiler settings match.

Evaluation is separate, using the established cold/incremental harness on mono/four/PGO executables with identical architecture gates. Keep source workloads and directory state fixed, alternate order, clear only cold caches, record foreground and fully settled time plus CPU/PSS, and retain the first edit as a distinct result. Run native/diagnostic parity before timed evaluation. Existing construction historical numbers are context, not a prediction or substitute for the held-out measurements.
