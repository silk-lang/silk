# V21 immutable Bundle component: rejected for performance

Twenty-four four-core calls compared frozen V19 `d28229b60666ebe8acb8ff107ef048f72a72607d6475768fe6d1f4e53de622f3` / source `b0f222d1cddb807bc0aa2bd66965ee7b68e518be` against Bundle-only V21 `be02b4c6f56081cb7cf5a67d52332e57797dc1ffff893b370f61123e6db68ba2` / source `a0fb61fccdb28504e46f8f6ead4787447f73d8b1`. Same producer, Clang, four-unit O2/noPGO construction and identical retained/frontier/shared/private/chunk/build-packing runtime policies; build pipeline ON, completed registry OFF. Original frozen workloads and stdlib. This is a component comparison, separate from original N0 acceptance.

[Full foreground/settled/CPU report](benchmarks/component-edits-hcai7z4o/component-report.md), [raw results](benchmarks/component-edits-hcai7z4o/results.json), [phase/writer attribution](benchmarks/component-edits-hcai7z4o/stage-attribution.json), [pins](v21-component-pins.json).

One reference→candidate pair per workload/operation; no reversed repetition. These large regressions fail the editing gate despite the small sample. CPU0 was deliberately not measured for this rejected Bundle candidate; V17's known single-core regressions remain unresolved. Any fix candidate still requires single-core acceptance. No unchanged priming or unchanged benchmark was run.

| Workload / operation | Cold foreground V19 → V21 | First edit | Second edit | Entire settled cohort |
|---|---:|---:|---:|---:|
| Compiler check | 11.451 → 11.288 s | 2.589 → 10.842 s | 1.866 → 10.368 s | 16.789 → 38.952 s |
| Harf check | 4.084 → 4.732 s | 0.860 → 6.078 s | 0.697 → 6.288 s | 6.123 → 21.127 s |
| Compiler build | 21.292 → 24.776 s | 3.000 → 6.221 s | 2.706 → 11.798 s | 27.534 → 49.694 s |
| Harf build | 6.452 → 12.179 s | 0.822 → 2.840 s | 0.827 → 6.761 s | 8.316 → 25.939 s |

| Workload / operation | Cold settled V19 → V21 | First-edit settled | Second-edit settled | Whole-cohort process-tree CPU |
|---|---:|---:|---:|---:|
| Compiler check | 12.237 → 17.696 s | 3.486 → 17.201 s | 2.713 → 16.784 s | 42.187 → 63.569 s |
| Harf check | 4.619 → 8.694 s | 1.312 → 10.061 s | 1.139 → 10.281 s | 14.756 → 30.006 s |
| Compiler build | 21.305 → 24.789 s | 3.484 → 12.812 s | 3.209 → 18.661 s | 72.912 → 98.042 s |
| Harf build | 6.463 → 12.191 s | 0.983 → 7.039 s | 1.008 → 10.887 s | 22.027 → 41.017 s |

Settled intervals overlap and must not be added. Source mutation, launch gap, return and settlement timestamps are retained in raw results.

Writer behavior explains much of the added time. Compiler check writers grew from 0.80–0.91 CPU seconds to 6.30–6.43, Harf check from 0.45–0.55 to 3.97–4.00. Compiler build edit writers grew from 0.95/0.97 to 7.06/7.30 CPU seconds; Harf build from 0.47/0.49 to 4.49/4.43. All check edits launched with a prior live writer; build first edits had zero prior live cold writers, and every second build edit overlapped the first edit's writer. Thus the completion barrier still works, while warm writing and other foreground cache work impose substantial costs.

Reported build phases remain similar: Harf first-edit load/check/codegen/borrow/link is 0.02/0.16/0.02/0.00/0.27 seconds in V19 and 0.02/0.15/0.02/0.00/0.27 in V21, despite foreground 0.822→2.840 seconds. Compiler second-edit phases likewise remain near parity despite foreground 2.706→11.798. These phase timers do not independently identify every cache read/validation/locking interval; the unaccounted foreground increase should not be mislabeled entirely as writer CPU.

Final settled cache size increased: compiler check 90.56→114.66 MiB, Harf check44.46→71.44; compiler build327.57→364.26, Harf build96.35→128.30. File-by-file cache attribution was not retained because completed caches were removed between cohorts to preserve headroom.

All ordered diagnostics and same-stage native artifact hashes matched. Every edited output showed its expected revision marker. All cold four-core frontier proofs passed; all cold builds acknowledged checkpoint completion after publication. Every supervisor and observed writer exited successfully and was reaped; parent-reaped cold build writer CPU remains included in primary wait4 usage.

The disk guard refused the final candidate Harf cohort before it started, after21 completed calls. Completed V19 duplicate sources were pruned with SHA receipts; only the remaining3 calls resumed. No measured interval or immediate sequence was interrupted. The original refusal and resume receipt remain in the result directory. Exclusive timing ownership was released after all24 calls and cleanup; no CPU0 or reversed followup started.
