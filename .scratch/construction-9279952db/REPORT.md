# Same-source mono / PGO construction controls

Source: `9279952dba5d0cc7f02f4f1b2439dc0607cfe162` (V9 cache corrections and both bounded SSA expansions).
Producer: pinned CI N1, SHA `d0c04d1a9b672e34fd6302ccaa9fc49b23a2ba1954c8d826dc73be626bc611db`.
Clang: LLVM 22.1.8, SHA `31a40dc31f3c15a47aa119aa148f339bf363d8f61202ddbdacbd3f24b71ba113`.

All compiler binaries use one codegen unit, O2 (`speed`), no debug, and the ordinary x86-64 target. **Mono names the number of compiler construction codegen units; it does not mean execution was pinned to one CPU.** Construction and native acceptance inherited the execution environment's affinity; their historical mask was not recorded. Neither one-CPU nor four-CPU performance/acceptance has yet been established for these controls.

PGO changes only profile-guided native construction. Compiler sources, worker gates, target ISA and language policy are identical between mono and PGO. `metadata.json` includes the source archive hash and manifest-only construction profile addition. These controls predate the later shared-graph implementation and must not be described as the final architecture.

| Binary | SHA256 |
| --- | --- |
| mono | `f89dc618349a9d7f10901c486dd276ee4154ebd8ad28ffd3707beb151b89c438` |
| instrumented | `2a2ffb023160e3e2b344d75c3f86b8a0690a9ee68f766c6a234e0074c6990047` |
| pgo | `828df69d93e65adb904269b1b684ae3cbb4571c371bf0a277fcc7036b5b20164` |

The mono construction took 250.14s; PGO construction took 338.03s. These are construction records, not compiler performance benchmarks. Mono and instrumented construction overlapped in two authorized shared slots. Maximum observed anonymous memory was about 10.3 GiB; cgroup OOM counts remained zero under the 16 GiB limit.

## Training

Training was serial: compiler cold check, compiler speed/no-debug LLVM-IR emission, compiler O0/full-debug LLVM-IR emission, the standard-library root fixture, and check/IR emission for `schema-json`, `effect-catchall-section-handler`, `generic-finite-type-cycle`, and `static-parameter-finite-chains`.

The stdlib-root fixture is explicitly negative. Frozen V8 independently reported the same ordered diagnostics: OWN0003 at schema.silk:269:45 (10325..10329), and SEM0176 at testing/runner.silk:222:28 (8606..8623) and :441:28 (16811..16828). Resumed training required exact full JSON error equality and exit 1. The first unclassified-at-the-time attempt remains recorded; its raw profile is excluded from the final merge.

Twelve raw profiles were merged, covering 8,343 functions and 325,558 blocks. Merged SHA: `596383e9556b6724cf2e7ebfea044aa2c3720cc1a4f3f72b0365e097f6c98662`. Clang's actual PGO invocation was verified to include this profile path. Compiler IR outputs (260.9 MB speed, 575.6 MB O0/debug) were hashed and removed; see `training-ir-artifacts.json`.

Harfrust and all unchanged/edit workloads were held out. Native acceptance profiles were written outside the training directory and never merged.

## Validation

All three binaries passed the same nine native parity pairs against frozen V8, including projected record mutation, scalar/direct-call arguments, pointers, aggregates, suspension, and checked traps. Full report paths and hashes are in `native-acceptance.json`. This is correctness evidence only; no compiler speedup has yet been measured for these constructions. All three binary hashes were verified again after environment recovery.

## Matched measurement requirements

Record the effective affinity mask for every measured process tree. Run separate, explicitly labeled one-CPU and four-CPU comparisons using one and four CPUs selected from the allowed mask. Apply the same mask to each compiler and all descendants, and record worker/serial gates independently from affinity. Preserve cold/first-edit/subsequent-edit distinctions, command options, cache initialization, workload/source hashes and complete process-tree settlement. Compare mono versus PGO from this exact source to isolate profile guidance; comparisons against older four-unit V9 also include the two SSA source changes. No ISA narrowing is used.

Reproduce construction with `/workspace/silk/.scratch/compiler_construction_experiment.py`; exact commands, environment overrides, statuses and durations are in `construction.jsonl`. The initial `train` phase stopped on the stdlib negative case; `train-more --stdlib-baseline stdlib-baseline.jsonl` resumes it with exact diagnostic validation and adds full-debug compiler emission. Preserve that documented distinction rather than treating arbitrary failures as successful training.
