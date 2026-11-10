# Cold and incremental compiler comparison

**Edit latency is a separate acceptance gate. Cold speedups do not compensate for edit regressions.**

Ratios are medians of paired, same-round baseline/candidate ratios. Times are medians; >1× is faster. Ratios never cross CPU-affinity or worker-policy lanes. CPU lanes describe execution affinity, not compiler construction codegen-unit count. Settled time includes every detached cache writer. Unpaired or failed runs are excluded from ratios and listed below.

**EDIT / UNCHANGED REGRESSIONS: 10 comparisons exceed 5% slower foreground or settled time.**

- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / edits / first-edit / candidate: 0.733× foreground, 0.789× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / edits / second-edit / candidate: 0.751× foreground, 0.800× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / edits / first-edit / candidate: 0.678× foreground, 0.842× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / edits / second-edit / candidate: 0.624× foreground, 0.779× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / edits / first-edit / candidate: 0.733× foreground, 0.754× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / edits / second-edit / candidate: 0.844× foreground, 0.840× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / unchanged / unchanged / candidate: 0.362× foreground, 0.362× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / edits / first-edit / candidate: 0.815× foreground, 0.882× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / edits / second-edit / candidate: 0.863× foreground, 0.884× settled.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / unchanged / unchanged / candidate: 0.705× foreground, 0.705× settled.

## Executed scope

- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / edits / baseline: 3 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / edits / candidate: 3 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / unchanged / baseline: 2 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / unchanged / candidate: 2 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / edits / baseline: 3 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / edits / candidate: 3 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / unchanged / baseline: 2 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / unchanged / candidate: 2 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / edits / baseline: 3 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / edits / candidate: 3 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / unchanged / baseline: 2 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / unchanged / candidate: 2 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / edits / baseline: 3 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / edits / candidate: 3 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / unchanged / baseline: 2 executed invocations.
- cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / unchanged / candidate: 2 executed invocations.

Failed invocations: 0. Explicit frontier fallbacks: 0. Incompletely paired comparisons: 0.
Requested invocations: 40; actually executed: 40. COMPLETE.

## DIRECT: cold → first edit → second edit

| CPU lane / worker policy | Operation / workload | Mode | Stage | Pairs | Foreground baseline → candidate | Speedup | Settled baseline → candidate | Speedup | Writer tail baseline → candidate | CPU baseline → candidate | Status |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / compiler | candidate | cold | 1/1 | 39.738s → 22.697s | 1.751× | 39.738s → 22.697s | 1.751× | 0.000s → 0.000s | 62.231s → 66.129s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / compiler | candidate | first-edit | 1/1 | 2.677s → 3.654s | 0.733× | 3.039s → 3.852s | 0.789× | 0.362s → 0.199s | 3.781s → 4.913s | REGRESSION |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / compiler | candidate | second-edit | 1/1 | 2.433s → 3.242s | 0.751× | 2.766s → 3.457s | 0.800× | 0.333s → 0.216s | 3.735s → 4.892s | REGRESSION |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / harfrust | candidate | cold | 1/1 | 11.338s → 7.207s | 1.573× | 11.339s → 7.207s | 1.573× | 0.000s → 0.000s | 16.560s → 20.000s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / harfrust | candidate | first-edit | 1/1 | 0.752s → 1.109s | 0.678× | 0.934s → 1.109s | 0.842× | 0.182s → 0.000s | 1.277s → 1.666s | REGRESSION |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / harfrust | candidate | second-edit | 1/1 | 0.670s → 1.073s | 0.624× | 0.836s → 1.073s | 0.779× | 0.166s → 0.000s | 1.188s → 1.657s | REGRESSION |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / compiler | candidate | cold | 1/1 | 24.116s → 11.113s | 2.170× | 24.684s → 12.064s | 2.046× | 0.568s → 0.951s | 25.427s → 36.548s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / compiler | candidate | first-edit | 1/1 | 1.199s → 1.636s | 0.733× | 1.870s → 2.481s | 0.754× | 0.671s → 0.845s | 1.961s → 2.571s | REGRESSION |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / compiler | candidate | second-edit | 1/1 | 1.100s → 1.304s | 0.844× | 1.781s → 2.121s | 0.840× | 0.681s → 0.818s | 2.072s → 2.564s | REGRESSION |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / harfrust | candidate | cold | 1/1 | 7.656s → 4.004s | 1.912× | 8.085s → 4.580s | 1.765× | 0.429s → 0.576s | 8.286s → 12.733s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / harfrust | candidate | first-edit | 1/1 | 0.392s → 0.481s | 0.815× | 0.803s → 0.910s | 0.882× | 0.411s → 0.429s | 0.841s → 0.957s | REGRESSION |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / harfrust | candidate | second-edit | 1/1 | 0.379s → 0.439s | 0.863× | 0.778s → 0.880s | 0.884× | 0.399s → 0.441s | 0.852s → 0.946s | REGRESSION |

## UNCHANGED: cold → first unchanged

| CPU lane / worker policy | Operation / workload | Mode | Stage | Pairs | Foreground baseline → candidate | Speedup | Settled baseline → candidate | Speedup | Writer tail baseline → candidate | CPU baseline → candidate | Status |
|---|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / compiler | candidate | cold | 1/1 | 38.588s → 21.691s | 1.779× | 38.588s → 21.691s | 1.779× | 0.000s → 0.000s | 58.456s → 64.755s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / compiler | candidate | unchanged | 1/1 | 0.076s → 0.072s | 1.046× | 0.076s → 0.072s | 1.046× | 0.000s → 0.000s | 0.076s → 0.072s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / harfrust | candidate | cold | 1/1 | 11.576s → 7.152s | 1.619× | 11.576s → 7.152s | 1.619× | 0.000s → 0.000s | 16.726s → 19.925s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | build / harfrust | candidate | unchanged | 1/1 | 0.149s → 0.151s | 0.988× | 0.149s → 0.151s | 0.988× | 0.000s → 0.000s | 0.149s → 0.151s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / compiler | candidate | cold | 1/1 | 21.960s → 11.067s | 1.984× | 22.583s → 11.989s | 1.884× | 0.623s → 0.922s | 23.240s → 35.569s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / compiler | candidate | unchanged | 1/1 | 0.136s → 0.375s | 0.362× | 0.136s → 0.375s | 0.362× | 0.000s → 0.000s | 0.224s → 0.452s | REGRESSION |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / harfrust | candidate | cold | 1/1 | 7.547s → 4.050s | 1.863× | 7.993s → 4.649s | 1.719× | 0.446s → 0.598s | 8.183s → 12.881s | measured |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) | check / harfrust | candidate | unchanged | 1/1 | 0.189s → 0.269s | 0.705× | 0.189s → 0.269s | 0.705× | 0.000s → 0.000s | 0.224s → 0.299s | REGRESSION |

## Cache bytes and executed phase evidence

| CPU lane / policy / operation / workload / sequence / stage / mode | Baseline cache MB → candidate cache MB |
|---|---:|
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / edits / cold / candidate | 224.908 → 239.970 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / edits / first-edit / candidate | 229.873 → 245.822 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / edits / second-edit / candidate | 229.873 → 245.909 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / unchanged / cold / candidate | 224.908 → 240.825 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / compiler / unchanged / unchanged / candidate | 224.908 → 240.825 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / edits / cold / candidate | 72.181 → 76.223 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / edits / first-edit / candidate | 74.216 → 77.741 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / edits / second-edit / candidate | 74.216 → 77.741 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / unchanged / cold / candidate | 72.181 → 76.385 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / build / harfrust / unchanged / unchanged / candidate | 72.181 → 76.385 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / edits / cold / candidate | 78.051 → 89.579 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / edits / first-edit / candidate | 79.217 → 92.823 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / edits / second-edit / candidate | 79.217 → 92.893 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / unchanged / cold / candidate | 78.051 → 89.400 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / compiler / unchanged / unchanged / candidate | 78.051 → 89.401 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / edits / cold / candidate | 44.257 → 47.862 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / edits / first-edit / candidate | 45.989 → 49.130 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / edits / second-edit / candidate | 45.989 → 49.130 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / unchanged / cold / candidate | 44.257 → 48.097 |
| cpus=0,1,2,3 / prototype parallel (legacy metadata) / check / harfrust / unchanged / unchanged / candidate | 44.257 → 48.097 |

Phase seconds, body counts, and query own/inclusive/run counters for every executed invocation are preserved in the adjacent `.phases.json`; missing baseline instrumentation is left absent, not inferred.


## Reproducibility

```json
{
  "binaries": {
    "baseline": {
      "path": "/workspace/silk/.scratch/N0-one",
      "sha256": "cddf7a53933f4c8e3a28372aac55ff8300808a0ee4f3a9c6ce2f1041368a839d",
      "source_revision": "a63f612150a0b91a118c8111b910b12c3e124b50"
    },
    "candidate": {
      "path": "/workspace/silk/.scratch/frontier-cache-v9",
      "sha256": "61e34d6245dee19610ff9cd99215b33d38e863cf6bc9da994de27f8bc70ab815",
      "source_revision": "48458f80367797be7a87453aa0d3ba7471024fd2"
    }
  },
  "revisions": {
    "silk": "a63f612150a0b91a118c8111b910b12c3e124b50",
    "nonstd": "ccb168b773bb56d7bd60a3495141d427149766d0"
  },
  "features": {
    "SILK_RETAINED_CACHE": "1",
    "SILK_FRONTIER_EPHEMERAL": "1"
  },
  "cpus": [
    0,
    1,
    2,
    3
  ],
  "cpu_lane": "not recorded",
  "worker_policy": "not recorded",
  "affinity_note": "not recorded",
  "require_host_capacity_refusal": "not recorded",
  "rounds": 1,
  "profile": "default",
  "edit": "Change reachable help text in one existing function body; second edit changes only revision-one to revision-two text.",
  "harness_sha256": "57ba756c05f42bf004140897602d2d638c04db5c26d38ece68c6789a877f3ba9"
}
```

Each raw result retains its exact command, environment, source hash, log path, process/writer status and artifact marker checks. Individual-process peak RSS is not aggregate fork memory. A candidate artifact hash is not compared to a different compiler version as a correctness requirement.
