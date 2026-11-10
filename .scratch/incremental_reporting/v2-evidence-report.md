# Cold and incremental compiler comparison

**Edit latency is a separate acceptance gate. Cold speedups do not compensate for edit regressions.**

Ratios are medians of paired, same-round baseline/candidate ratios. Times are medians; >1× is faster. Settled time includes every detached cache writer. Unpaired or failed runs are excluded from ratios and listed below.

**EDIT / UNCHANGED REGRESSIONS: 21 comparisons exceed 5% slower foreground or settled time.**

- build / compiler / edits / first-edit / cached: 0.175× foreground, 0.194× settled.
- build / compiler / edits / first-edit / ephemeral: 0.236× foreground, 0.262× settled.
- build / compiler / edits / second-edit / cached: 0.154× foreground, 0.175× settled.
- build / compiler / edits / second-edit / ephemeral: 0.196× foreground, 0.223× settled.
- build / harfrust / edits / first-edit / cached: 0.150× foreground, 0.192× settled.
- build / harfrust / edits / first-edit / ephemeral: 0.177× foreground, 0.227× settled.
- build / harfrust / edits / second-edit / cached: 0.139× foreground, 0.169× settled.
- build / harfrust / edits / second-edit / ephemeral: 0.195× foreground, 0.238× settled.
- build / harfrust / unchanged / unchanged / ephemeral: 0.945× foreground, 0.945× settled.
- check / compiler / edits / first-edit / cached: 0.118× foreground, 0.182× settled.
- check / compiler / edits / first-edit / ephemeral: 0.148× foreground, 0.233× settled.
- check / compiler / edits / second-edit / cached: 0.100× foreground, 0.157× settled.
- check / compiler / edits / second-edit / ephemeral: 0.131× foreground, 0.212× settled.
- check / compiler / unchanged / unchanged / cached: 0.013× foreground, 0.012× settled.
- check / compiler / unchanged / unchanged / ephemeral: 0.015× foreground, 0.015× settled.
- check / harfrust / edits / first-edit / cached: 0.128× foreground, 0.232× settled.
- check / harfrust / edits / first-edit / ephemeral: 0.154× foreground, 0.296× settled.
- check / harfrust / edits / second-edit / cached: 0.091× foreground, 0.178× settled.
- check / harfrust / edits / second-edit / ephemeral: 0.143× foreground, 0.296× settled.
- check / harfrust / unchanged / unchanged / cached: 0.060× foreground, 0.056× settled.
- check / harfrust / unchanged / unchanged / ephemeral: 0.084× foreground, 0.083× settled.

## Executed scope

- build / compiler / edits / baseline: 3 executed invocations.
- build / compiler / edits / cached: 3 executed invocations.
- build / compiler / edits / ephemeral: 3 executed invocations.
- build / compiler / unchanged / baseline: 2 executed invocations.
- build / compiler / unchanged / cached: 2 executed invocations.
- build / compiler / unchanged / ephemeral: 2 executed invocations.
- build / harfrust / edits / baseline: 3 executed invocations.
- build / harfrust / edits / cached: 3 executed invocations.
- build / harfrust / edits / ephemeral: 3 executed invocations.
- build / harfrust / unchanged / baseline: 2 executed invocations.
- build / harfrust / unchanged / cached: 2 executed invocations.
- build / harfrust / unchanged / ephemeral: 2 executed invocations.
- check / compiler / edits / baseline: 3 executed invocations.
- check / compiler / edits / cached: 3 executed invocations.
- check / compiler / edits / ephemeral: 3 executed invocations.
- check / compiler / unchanged / baseline: 2 executed invocations.
- check / compiler / unchanged / cached: 2 executed invocations.
- check / compiler / unchanged / ephemeral: 2 executed invocations.
- check / harfrust / edits / baseline: 3 executed invocations.
- check / harfrust / edits / cached: 3 executed invocations.
- check / harfrust / edits / ephemeral: 3 executed invocations.
- check / harfrust / unchanged / baseline: 2 executed invocations.
- check / harfrust / unchanged / cached: 2 executed invocations.
- check / harfrust / unchanged / ephemeral: 2 executed invocations.

Failed invocations: 0. Explicit frontier fallbacks: 0. Incompletely paired comparisons: 0.
Original metadata does not enumerate requested scope; report only claims the invocations actually present.

## DIRECT: cold → first edit → second edit

| Operation / workload | Mode | Stage | Pairs | Foreground baseline → candidate | Speedup | Settled baseline → candidate | Speedup | Writer tail baseline → candidate | CPU baseline → candidate | Status |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| build / compiler | cached | cold | 1/1 | 39.106s → 19.669s | 1.988× | 39.106s → 19.669s | 1.988× | 0.000s → 0.000s | 59.004s → 58.920s | measured |
| build / compiler | cached | first-edit | 1/1 | 2.721s → 15.585s | 0.175× | 3.024s → 15.585s | 0.194× | 0.303s → 0.000s | 3.751s → 34.416s | REGRESSION |
| build / compiler | cached | second-edit | 1/1 | 2.387s → 15.507s | 0.154× | 2.712s → 15.507s | 0.175× | 0.325s → 0.000s | 3.595s → 41.871s | REGRESSION |
| build / compiler | ephemeral | cold | 1/1 | 39.106s → 16.950s | 2.307× | 39.106s → 16.950s | 2.307× | 0.000s → 0.000s | 59.004s → 52.424s | measured |
| build / compiler | ephemeral | first-edit | 1/1 | 2.721s → 11.530s | 0.236× | 3.024s → 11.530s | 0.262× | 0.303s → 0.000s | 3.751s → 34.707s | REGRESSION |
| build / compiler | ephemeral | second-edit | 1/1 | 2.387s → 12.183s | 0.196× | 2.712s → 12.183s | 0.223× | 0.325s → 0.000s | 3.595s → 34.912s | REGRESSION |
| build / harfrust | cached | cold | 1/1 | 11.636s → 5.866s | 1.984× | 11.637s → 5.866s | 1.984× | 0.000s → 0.000s | 16.806s → 17.368s | measured |
| build / harfrust | cached | first-edit | 1/1 | 0.701s → 4.667s | 0.150× | 0.896s → 4.667s | 0.192× | 0.195s → 0.000s | 1.196s → 13.115s | REGRESSION |
| build / harfrust | cached | second-edit | 1/1 | 0.717s → 5.157s | 0.139× | 0.874s → 5.157s | 0.169× | 0.157s → 0.000s | 1.272s → 14.163s | REGRESSION |
| build / harfrust | ephemeral | cold | 1/1 | 11.636s → 4.645s | 2.505× | 11.637s → 4.645s | 2.505× | 0.000s → 0.000s | 16.806s → 13.851s | measured |
| build / harfrust | ephemeral | first-edit | 1/1 | 0.701s → 3.949s | 0.177× | 0.896s → 3.949s | 0.227× | 0.195s → 0.000s | 1.196s → 10.954s | REGRESSION |
| build / harfrust | ephemeral | second-edit | 1/1 | 0.717s → 3.675s | 0.195× | 0.874s → 3.675s | 0.238× | 0.157s → 0.000s | 1.272s → 10.503s | REGRESSION |
| check / compiler | cached | cold | 1/1 | 22.630s → 11.868s | 1.907× | 23.238s → 12.199s | 1.905× | 0.608s → 0.331s | 23.934s → 33.853s | measured |
| check / compiler | cached | first-edit | 1/1 | 1.192s → 10.124s | 0.118× | 1.886s → 10.360s | 0.182× | 0.694s → 0.236s | 1.975s → 26.382s | REGRESSION |
| check / compiler | cached | second-edit | 1/1 | 1.068s → 10.718s | 0.100× | 1.741s → 11.064s | 0.157× | 0.673s → 0.346s | 2.022s → 33.626s | REGRESSION |
| check / compiler | ephemeral | cold | 1/1 | 22.630s → 8.510s | 2.659× | 23.238s → 8.567s | 2.713× | 0.608s → 0.057s | 23.934s → 27.243s | measured |
| check / compiler | ephemeral | first-edit | 1/1 | 1.192s → 8.045s | 0.148× | 1.886s → 8.079s | 0.233× | 0.694s → 0.034s | 1.975s → 27.406s | REGRESSION |
| check / compiler | ephemeral | second-edit | 1/1 | 1.068s → 8.162s | 0.131× | 1.741s → 8.198s | 0.212× | 0.673s → 0.036s | 2.022s → 27.287s | REGRESSION |
| check / harfrust | cached | cold | 1/1 | 7.842s → 3.655s | 2.146× | 8.259s → 3.974s | 2.078× | 0.417s → 0.319s | 8.457s → 11.797s | measured |
| check / harfrust | cached | first-edit | 1/1 | 0.424s → 3.312s | 0.128× | 0.826s → 3.562s | 0.232× | 0.402s → 0.249s | 0.867s → 10.713s | REGRESSION |
| check / harfrust | cached | second-edit | 1/1 | 0.371s → 4.071s | 0.091× | 0.777s → 4.356s | 0.178× | 0.406s → 0.285s | 0.849s → 12.037s | REGRESSION |
| check / harfrust | ephemeral | cold | 1/1 | 7.842s → 2.576s | 3.044× | 8.259s → 2.650s | 3.117× | 0.417s → 0.073s | 8.457s → 8.018s | measured |
| check / harfrust | ephemeral | first-edit | 1/1 | 0.424s → 2.752s | 0.154× | 0.826s → 2.788s | 0.296× | 0.402s → 0.037s | 0.867s → 9.011s | REGRESSION |
| check / harfrust | ephemeral | second-edit | 1/1 | 0.371s → 2.588s | 0.143× | 0.777s → 2.628s | 0.296× | 0.406s → 0.040s | 0.849s → 8.337s | REGRESSION |

## UNCHANGED: cold → first unchanged

| Operation / workload | Mode | Stage | Pairs | Foreground baseline → candidate | Speedup | Settled baseline → candidate | Speedup | Writer tail baseline → candidate | CPU baseline → candidate | Status |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|---|
| build / compiler | cached | cold | 1/1 | 38.363s → 20.091s | 1.909× | 38.363s → 20.091s | 1.909× | 0.000s → 0.000s | 58.966s → 58.907s | measured |
| build / compiler | cached | unchanged | 1/1 | 0.078s → 0.077s | 1.019× | 0.078s → 0.077s | 1.019× | 0.000s → 0.000s | 0.078s → 0.077s | measured |
| build / compiler | ephemeral | cold | 1/1 | 38.363s → 16.208s | 2.367× | 38.363s → 16.208s | 2.367× | 0.000s → 0.000s | 58.966s → 51.270s | measured |
| build / compiler | ephemeral | unchanged | 1/1 | 0.078s → 0.071s | 1.112× | 0.078s → 0.071s | 1.111× | 0.000s → 0.000s | 0.078s → 0.070s | measured |
| build / harfrust | cached | cold | 1/1 | 11.326s → 6.028s | 1.879× | 11.326s → 6.028s | 1.879× | 0.000s → 0.000s | 16.487s → 17.500s | measured |
| build / harfrust | cached | unchanged | 1/1 | 0.159s → 0.150s | 1.059× | 0.159s → 0.150s | 1.059× | 0.000s → 0.000s | 0.159s → 0.150s | measured |
| build / harfrust | ephemeral | cold | 1/1 | 11.326s → 4.492s | 2.521× | 11.326s → 4.492s | 2.521× | 0.000s → 0.000s | 16.487s → 13.189s | measured |
| build / harfrust | ephemeral | unchanged | 1/1 | 0.159s → 0.169s | 0.945× | 0.159s → 0.169s | 0.945× | 0.000s → 0.000s | 0.159s → 0.168s | REGRESSION |
| check / compiler | cached | cold | 1/1 | 22.773s → 11.976s | 1.901× | 23.375s → 12.294s | 1.901× | 0.602s → 0.317s | 24.044s → 34.027s | measured |
| check / compiler | cached | unchanged | 1/1 | 0.120s → 9.519s | 0.013× | 0.120s → 9.691s | 0.012× | 0.000s → 0.173s | 0.196s → 25.814s | REGRESSION |
| check / compiler | ephemeral | cold | 1/1 | 22.773s → 8.086s | 2.816× | 23.375s → 8.149s | 2.868× | 0.602s → 0.063s | 24.044s → 26.248s | measured |
| check / compiler | ephemeral | unchanged | 1/1 | 0.120s → 7.815s | 0.015× | 0.120s → 7.856s | 0.015× | 0.000s → 0.041s | 0.196s → 26.487s | REGRESSION |
| check / harfrust | cached | cold | 1/1 | 7.762s → 3.966s | 1.957× | 8.205s → 4.284s | 1.915× | 0.442s → 0.318s | 8.372s → 11.947s | measured |
| check / harfrust | cached | unchanged | 1/1 | 0.207s → 3.439s | 0.060× | 0.207s → 3.666s | 0.056× | 0.000s → 0.227s | 0.257s → 10.726s | REGRESSION |
| check / harfrust | ephemeral | cold | 1/1 | 7.762s → 2.577s | 3.012× | 8.205s → 2.643s | 3.104× | 0.442s → 0.066s | 8.372s → 8.098s | measured |
| check / harfrust | ephemeral | unchanged | 1/1 | 0.207s → 2.454s | 0.084× | 0.207s → 2.497s | 0.083× | 0.000s → 0.042s | 0.257s → 8.087s | REGRESSION |

## Reproducibility

```json
{
  "binaries": {
    "baseline": {
      "path": "/workspace/silk/.scratch/N0-one",
      "sha256": "cddf7a53933f4c8e3a28372aac55ff8300808a0ee4f3a9c6ce2f1041368a839d"
    },
    "cached": {
      "path": "/workspace/silk/.scratch/frontier-integrated-v2",
      "sha256": "a05e7ba0a688d305832a85a54a29bd50f671f971341dfafadecda41ac90c99e0"
    },
    "ephemeral": {
      "path": "/workspace/silk/.scratch/frontier-integrated-v2",
      "sha256": "a05e7ba0a688d305832a85a54a29bd50f671f971341dfafadecda41ac90c99e0"
    }
  },
  "revisions": {
    "silk": "a63f612150a0b91a118c8111b910b12c3e124b50",
    "nonstd": "ccb168b773bb56d7bd60a3495141d427149766d0"
  },
  "features": "not recorded",
  "cpus": [
    0,
    1,
    2,
    3
  ],
  "rounds": 1,
  "profile": "default",
  "edit": "Change reachable help text in one existing function body; second edit changes only revision-one to revision-two text.",
  "harness_sha256": "not recorded"
}
```

Each raw result retains its exact command, environment, source hash, log path, process/writer status and artifact marker checks. Individual-process peak RSS is not aggregate fork memory. A candidate artifact hash is not compared to a different compiler version as a correctness requirement.
