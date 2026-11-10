# Shared RuntimePreparation controlled disposition

Matching-construction V22 versus unconditional shared semantic preparation candidate; original compiler workload and original stdlib. One immediate sequence per mode, per CPU lane. Diagnostics off. These component controls are not original N0 acceptance or a 3× claim.

| CPUs | Operation | Stage | Foreground reference → candidate | Settled reference → candidate | CPU reference → candidate | Detached writer CPU reference → candidate |
|---|---|---|---|---|---|---|
| 0+1+2+3 | check | cold | 10.515 → 10.857s (+3.3%) | 11.346 → 11.724s (+3.3%) | 34.236 → 35.052s (+2.4%) | 0.839 → 0.883s (+5.1%) |
| 0+1+2+3 | check | first-edit | 2.591 → 2.667s (+2.9%) | 3.482 → 3.571s (+2.5%) | 2.769 → 2.830s (+2.2%) | 0.904 → 0.915s (+1.3%) |
| 0+1+2+3 | check | second-edit | 1.788 → 1.808s (+1.1%) | 2.650 → 2.695s (+1.7%) | 2.532 → 2.577s (+1.8%) | 0.871 → 0.895s (+2.8%) |
| 0+1+2+3 | check | unchanged | 1.082 → 1.109s (+2.4%) | 1.097 → 1.123s (+2.4%) | 0.784 → 0.864s (+10.2%) | 0.000 → 0.000s |
| 0+1+2+3 | build | cold | 19.862 → 21.588s (+8.7%) | 19.878 → 21.602s (+8.7%) | 63.191 → 68.332s (+8.1%) | 0.000 → 0.000s |
| 0+1+2+3 | build | first-edit | 3.112 → 3.082s (-1.0%) | 3.548 → 3.571s (+0.7%) | 4.274 → 4.273s (-0.0%) | 0.966 → 1.006s (+4.2%) |
| 0+1+2+3 | build | second-edit | 2.780 → 2.790s (+0.4%) | 3.218 → 3.291s (+2.3%) | 4.312 → 4.285s (-0.6%) | 1.027 → 1.055s (+2.7%) |
| 0+1+2+3 | build | unchanged | 0.071 → 0.077s (+9.3%) | 0.086 → 0.092s (+6.4%) | 0.070 → 0.076s (+9.3%) | 0.000 → 0.000s |

Every positive delta is shown, including small directional changes; one pair does not establish statistical significance. Detached-writer CPU excludes parent-joined writers, whose CPU remains in total. Immediate writer tails overlap, so per-invocation tails are not additive.

Evidence:
- `/workspace/silk/.scratch/benchmarks/runtime-preparation-sequence-ki9qjhmu`
