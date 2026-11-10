# V23 settled Harf component result: reject promotion

The scalar-offset/liveness repair removes most of V21’s redundant packed-key work, but V23 still regresses V19 substantially. Both lanes passed ordered JSON parity, accepted cold proof on four cores, automatic cold host refusal on CPU0, no warm reforks, and writer exit status. All 18 calls and detached writers settled. No original-baseline speedup or immediate-edit claim.

Source and binary pins, exact flags, workload revisions and harness SHA are in each cohort metadata. V19/V21/V23 share four-unit O2/noPGO construction. Source/cache remain preserved.

## four CPU lane

Evidence: `/workspace/silk/.scratch/benchmarks/bundle-v23-settled-gx32xiz_`.

| Version | Stage | Foreground s | Settled s | Primary CPU s | Writer CPU s | Cache MB |
|---|---|---:|---:|---:|---:|---:|
| v19 | cold | 4.411 | 4.932 | 12.713 | 0.528 | 42.52 |
| v19 | first-edit | 0.494 | 0.947 | 0.531 | 0.456 | 46.72 |
| v19 | unchanged | 0.248 | 0.248 | 0.321 | 0.000 | 46.72 |
| v21 | cold | 4.818 | 8.847 | 13.100 | 4.034 | 74.33 |
| v21 | first-edit | 2.256 | 6.291 | 2.277 | 4.039 | 75.85 |
| v21 | unchanged | 1.813 | 1.813 | 1.895 | 0.000 | 75.85 |
| v23 | cold | 4.480 | 5.671 | 12.528 | 1.197 | 73.60 |
| v23 | first-edit | 1.277 | 2.491 | 1.299 | 1.219 | 75.12 |
| v23 | unchanged | 0.803 | 0.803 | 0.880 | 0.000 | 75.12 |

V23 / V19 ratios:
- cold: foreground 1.02×; settled 1.15×.
- first-edit: foreground 2.59×; settled 2.63×.
- unchanged: foreground 3.23×; settled 3.23×.

V23 measured foreground adoption phases (wall ms; not phase CPU):

| Stage | Validation | Liveness | Anchors | Leaves | Attach |
|---|---:|---:|---:|---:|---:|
| first-edit | 79 | 171 | 0 | 259 | 115 |
| unchanged | 79 | 148 | 42 | 0 | 36 |

## one CPU lane

Evidence: `/workspace/silk/.scratch/benchmarks/bundle-v23-settled-ql26cekn`.

| Version | Stage | Foreground s | Settled s | Primary CPU s | Writer CPU s | Cache MB |
|---|---|---:|---:|---:|---:|---:|
| v19 | cold | 7.092 | 7.934 | 6.943 | 0.913 | 44.02 |
| v19 | first-edit | 0.512 | 0.976 | 0.503 | 0.471 | 45.77 |
| v19 | unchanged | 0.315 | 0.315 | 0.311 | 0.000 | 45.77 |
| v21 | cold | 6.926 | 8.266 | 6.853 | 1.412 | 48.56 |
| v21 | first-edit | 1.482 | 3.774 | 1.475 | 2.298 | 49.27 |
| v21 | unchanged | 1.230 | 1.230 | 1.230 | 0.000 | 49.26 |
| v23 | cold | 6.848 | 8.039 | 6.780 | 1.258 | 48.56 |
| v23 | first-edit | 0.777 | 1.387 | 0.768 | 0.618 | 49.27 |
| v23 | unchanged | 0.608 | 0.608 | 0.608 | 0.000 | 49.26 |

V23 / V19 ratios:
- cold: foreground 0.97×; settled 1.01×.
- first-edit: foreground 1.52×; settled 1.42×.
- unchanged: foreground 1.93×; settled 1.93×.

V23 measured foreground adoption phases (wall ms; not phase CPU):

| Stage | Validation | Liveness | Anchors | Leaves | Attach |
|---|---:|---:|---:|---:|---:|
| first-edit | 28 | 78 | 0 | 103 | 74 |
| unchanged | 34 | 83 | 18 | 0 | 29 |

## Mechanism and remaining costs

- Four-core first-edit liveness falls 935→171 ms; CPU0 falls 642→78 ms. Four-core writer CPU falls 4.039→1.219 s; CPU0 falls 2.298→0.618 s. Constructor validation, exact evidence and disk repair remain intact.
- Four-core V23 first-edit measured adoption phases total 624 ms, compared with total primary CPU 1.299 s. Unchanged phases total 305 ms against primary CPU 880 ms. Remaining command time includes load/assembly and ordinary semantic/runtime work; this V23 binary does not separately time those phases, so the residual must not be called entirely load cost.
- CPU0 V23 first-edit measured adoption phases total 283 ms against primary CPU 768 ms; unchanged phases total 264 ms against CPU 608 ms. Even without worker shards, the new reader and graph handling cost remains material.
- Four-core final cache is 75.12 MB versus V19 46.72 MB (+61%); CPU0 49.26 MB versus 45.77 MB (+8%). The larger worker shard corpus remains retained and authenticated, so eliminating dense merge did not eliminate read/write/adoption work.
- Four-core V23 writer CPU 1.219 s remains 2.67× V19 0.456 s. CPU0 0.618 s remains 1.31× V19 0.471 s. V23 has no detached-writer phase file instrumentation; current writer normalization, serialization and export subdivisions are not newly attributed here. Prior exact-V21 instrumentation is historical mechanism evidence, not a V23 phase measurement.
- The prior V21 diagnostic measured canonical structural normalization at 39 ms, not a multi-second explosion; the observed repaired liveness result supports the indexed-leaf mechanism. Remaining attribution does not justify another speculative small optimization automatically.

Decision: reject whole Bundle V23 for promotion. Preserve implementation and evidence; no additional Bundle optimization prototype authorized. A future immediate-edit overlap run would be required if a materially improved candidate existed, but settled edit regressions already disqualify this candidate.
