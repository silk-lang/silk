# Balanced frontend authoritative cold check comparison

Candidate source `c7b163a85`, binary `.scratch/frontier-balanced`, SHA256 `f78f295f9e01681533295b9890c7b315bdf554e822b5b06ab4d8715859bf380d`. Baseline `.scratch/N0-one`. Same original compiler/stdlib snapshot `a63f61215` and nonstd workload pin `ccb168…` under `.scratch/benchmarks/transport-family-ctvjs_tx`; 4CPU affinity0–3; one exclusive lock around all trials; empty build caches; two reversed pairs per workload; all detached writers reaped. Raw data `.scratch/balanced-frontier-comparison.json`.

| Workload | Mode | Foreground mean | Settled mean | Aggregate CPU mean |
|---|---|---:|---:|---:|
| compiler | baseline | 22.292s | 22.934s | 23.619s |
| compiler | balanced | 8.195s | 8.264s | 27.206s |
| harfrust | baseline | 7.788s | 8.221s | 8.414s |
| harfrust | balanced | 2.714s | 2.780s | 8.631s |

Compiler foreground speedup **2.720×**; Harf **2.870×**. The3× cold-check target remains unmet. All four balanced trials accepted the complete finite/escape/resource proof. Compiler spawned2 actual descendants per run and134 chunks; Harf2 then1 descendants and160 chunks. Fork logs appear once in both parent and child; raw log counts are preserved separately as `fork_log_events`.

Compiler trial0: descendants finish2.84/2.94s aftersplit; longest root runtime5.63s; all module workers5.78–5.82s; union read5.98s; final proof6.96s. Trial1 similar (runtime5.79s, modules5.81–5.83s, proof7.03s). Critical work is now balanced across roots; duplication/record costs and remaining serial proof are next targets.

Correctness on this exact binary: four320-declaration native fixtures, each serial and two enabled runs, eight exact JSON output comparisons passed. Valid and real unused-local warning accept6chunks; unused-body error and cross-range name collision explicitly fallback. Compiler cached-frontier cold/warm and balanced cold/warm all accept and preserve identical JSON diagnostics. Warm7.85s still repeats substantial work; no warm-cache speed claim.

Next source-only candidate adds callable-body-weighted chunk ranges (`1fe9fe526`), runtime Admission allocation/Leave removal, retained backend/proxy, scanner, and cache budget corrections in root integration. No measurement here includes those unbuilt changes.
