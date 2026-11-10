# Checked-runtime-plan controlled disposition

**Rejected as a performance package.** Cold checks improve modestly, but cold builds regress on both CPU lanes: +11.0% foreground/+6.4% CPU on CPUs0–3, and +8.4% foreground/CPU on CPU0. No broader or repeated timing is warranted for this candidate. All32 calls passed, all22 detached writers were reaped, source edits restored, and eight build-stage artifact pairs were byte-identical.

The separate diagnostic engagement completed45,017 compact plans (44,873 ordinary,144 storage),12 generated helper proofs,3,106 explicit oracle completions and43,279 Family.Mir starts. Five worker final snapshots plus coordinator accounting were complete. These counts establish actual mechanism, not saved CPU: build still materializes executable MIR and changes the preparation/overlap balance.

Matching-construction V22 versus unconditional compact checked-plan candidate; original compiler workload and original stdlib. One immediate sequence per mode, per CPU lane. Diagnostics off. These component controls are not original N0 acceptance or a 3× claim.

| CPUs | Operation | Stage | Foreground reference → candidate | Settled reference → candidate | CPU reference → candidate | Detached writer CPU reference → candidate |
|---|---|---|---|---|---|---|
| 0+1+2+3 | check | cold | 10.834 → 10.214s (-5.7%) | 11.638 → 11.036s (-5.2%) | 34.999 → 32.682s (-6.6%) | 0.816 → 0.840s (+2.9%) |
| 0+1+2+3 | check | first-edit | 2.660 → 2.657s (-0.1%) | 3.519 → 3.555s (+1.0%) | 2.823 → 2.862s (+1.4%) | 0.866 → 0.909s (+4.9%) |
| 0+1+2+3 | check | second-edit | 1.753 → 1.824s (+4.0%) | 2.607 → 2.737s (+5.0%) | 2.519 → 2.645s (+5.0%) | 0.864 → 0.923s (+6.8%) |
| 0+1+2+3 | check | unchanged | 1.064 → 1.130s (+6.1%) | 1.078 → 1.145s (+6.2%) | 0.767 → 0.846s (+10.3%) | 0.000 → 0.000s |
| 0+1+2+3 | build | cold | 19.547 → 21.693s (+11.0%) | 19.562 → 21.707s (+11.0%) | 61.558 → 65.516s (+6.4%) | 0.000 → 0.000s |
| 0+1+2+3 | build | first-edit | 3.175 → 3.120s (-1.7%) | 3.634 → 3.606s (-0.8%) | 4.403 → 4.329s (-1.7%) | 1.022 → 1.008s (-1.4%) |
| 0+1+2+3 | build | second-edit | 2.772 → 2.750s (-0.8%) | 3.218 → 3.261s (+1.3%) | 4.347 → 4.244s (-2.4%) | 0.984 → 1.044s (+6.1%) |
| 0+1+2+3 | build | unchanged | 0.070 → 0.078s (+11.1%) | 0.084 → 0.092s (+9.8%) | 0.069 → 0.077s (+11.1%) | 0.000 → 0.000s |
| 0 | check | cold | 21.100 → 20.324s (-3.7%) | 22.635 → 21.875s (-3.4%) | 22.516 → 21.762s (-3.3%) | 1.766 → 1.741s (-1.4%) |
| 0 | check | first-edit | 2.812 → 2.849s (+1.3%) | 4.073 → 4.113s (+1.0%) | 2.094 → 2.100s (+0.3%) | 0.697 → 0.691s (-0.9%) |
| 0 | check | second-edit | 2.201 → 2.126s (-3.4%) | 3.450 → 3.398s (-1.5%) | 2.217 → 2.159s (-2.6%) | 0.698 → 0.711s (+1.9%) |
| 0 | check | unchanged | 1.483 → 1.507s (+1.6%) | 1.497 → 1.521s (+1.6%) | 0.809 → 0.814s (+0.7%) | 0.000 → 0.000s |
| 0 | build | cold | 47.341 → 51.318s (+8.4%) | 47.356 → 51.332s (+8.4%) | 47.321 → 51.303s (+8.4%) | 2.302 → 2.385s (+3.6%) |
| 0 | build | first-edit | 3.434 → 3.377s (-1.7%) | 4.067 → 4.029s (-0.9%) | 3.736 → 3.690s (-1.2%) | 0.858 → 0.858s (-0.0%) |
| 0 | build | second-edit | 3.819 → 3.883s (+1.7%) | 4.193 → 4.352s (+3.8%) | 3.784 → 3.924s (+3.7%) | 0.829 → 0.907s (+9.5%) |
| 0 | build | unchanged | 0.144 → 0.146s (+1.8%) | 0.175 → 0.179s (+2.5%) | 0.071 → 0.074s (+3.6%) | 0.000 → 0.000s |

Every positive delta is shown, including small directional changes; one pair does not establish statistical significance. Detached-writer CPU excludes parent-joined writers, whose CPU remains in total. Immediate writer tails overlap, so per-invocation tails are not additive.

Evidence:
- `/workspace/silk/.scratch/benchmarks/checked-plan-sequence-0gr2g7w5`
- `/workspace/silk/.scratch/benchmarks/checked-plan-sequence-c7uhbyt6`
