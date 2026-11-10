# V17 performance results

Frozen binary `.scratch/frontier-performance-v17`, SHA256 `79b8f4b494f3b443a989c8ea8dfd7fc33f5c92c2fa26569d84968f5f2331e0c4`, source `060ec3a13d06eeb4517739fe740598a7561e7c40`. Construction is mono O2 with reused PGO; actual applied coverage is unknown. Execution lanes below are independently four CPUs or CPU0. Original baseline `.scratch/N0-one` and original frozen source/stdlib were used for baseline comparisons.

**The 3× goal is not met, and V17 fails the editing regression gate. No final production/default policy was selected.** The final 80-call settled baseline matrix was intentionally held after the immediate-edit evidence exposed material regressions; root authorized repair work instead.

120 timed invocations completed successfully across the five experiments below;120 detached writers were reaped. Ordered diagnostics, edited artifact outputs and required proof/host-policy gates passed. A disk pause before the first pipeline-screen invocation and a disk refusal before the Harf causal-control cohorts interrupted no measured interval. The latter resumed only the12 missing Harf invocations; completed compiler cases were retained unchanged. Frozen binaries were not modified.

## Same-binary controls before overlap testing

- Pipeline OFF/ON, registry OFF, four CPUs, two reversed rounds, cold→first edit:16 calls. Compiler cold foreground−8.6%, settled−5.0%; Harf−12.6%/−6.3%. First edits after waiting for the cold writer showed no >5% regression. This provisionally selected pipeline ON for measurement.
- Registry OFF/ON with pipeline ON fixed, same two-round sequence:32 calls. Cold checks had small/mixed improvements (compiler~0.9%, Harf~3.4%); cold builds regressed compiler~2.3% and Harf~1.4% foreground.33,487 reuse hits proved engagement. Registry OFF was retained.

Reports: `benchmarks/pipeline-screen-wdo8bdxt/screen-report.md` and `benchmarks/registry-screen-zqi3qiu5/screen-report.md`.

## Immediate-edit original-baseline comparisons

Here the next edit starts after foreground notification without waiting for the prior cache writer. Launch gaps, source mutation, per-invocation supervisor/writer CPU and single-shot prior-descendant liveness were recorded. Every cohort settled fully before artifact validation or the next cohort. These are single matched pairs, so small differences are not confidence estimates. PipelineON/registry OFF was used for V17; CPU0 automatically refused both semantic/native worker admission and every candidate stage had no pool.

| Execution lane | Workload / operation | Cold baseline → V17 | First edit baseline → V17 | Second edit baseline → V17 |
|---|---|---:|---:|---:|
| Four CPUs | Compiler check |22.188→9.304s|1.744→2.426s (+39%)|1.411→1.721s (+22%)|
| Four CPUs | Harf check |7.715→3.492s|0.693→0.885s (+28%)|0.622→0.732s (+18%)|
| Four CPUs | Compiler build |37.727→17.922s|2.546→3.471s (+36%)|2.459→2.548s (+3.6%; settled+10%)|
| Four CPUs | Harf build |11.348→5.508s|0.693→1.069s (+54%)|0.671→0.765s (+14%)|
| CPU0 | Compiler check |22.634→16.563s|1.882→2.682s (+43%)|2.011→2.006s (near parity)|
| CPU0 | Harf check |7.906→5.549s|0.876→1.306s (+49%)|0.918→0.882s (4% faster)|
| CPU0 | Compiler build |58.346→43.025s|3.381→3.049s (10% faster)|3.617→3.430s (5% faster)|
| CPU0 | Harf build |16.490→11.629s|1.005→1.111s (+11%)|1.196→1.269s (+6%)|

Four-core report: `benchmarks/immediate-edits-_t4opvvt/immediate-report.md` (24 calls). CPU0 report: `benchmarks/immediate-edits-yjwhl9ga/immediate-report.md` (24 calls). Both reports include all-writer settlement and complete-cohort elapsed; overlapping settled intervals must not be added.

## Pipeline causality, with other flags held fixed

Same frozen V17, four CPUs, full normal frontier/cache/packing policy in both modes, registry OFF; only `SILK_NATIVE_BUILD_PIPELINE` changed. Two reversed rounds, cold→first edit→second edit without writer settlement:24 calls.

| Workload | Cold foreground OFF → ON | First edit OFF → ON | First edit settled OFF → ON | Complete cohort OFF → ON |
|---|---:|---:|---:|---:|
| Compiler |19.070→17.345s (9.0% faster)|2.677→3.409s (+27.4%)|3.226→3.953s (+22.6%)|24.855→23.829s (4.1% faster)|
| Harf |6.274→5.598s (10.7% faster)|0.858→1.047s (+22.4%)|1.054→1.246s (+18.4%)|8.156→7.669s (6.0% faster)|

Every OFF first edit had zero live prior descendants at launch; every ON first edit had one. Second edits were near parity. The pipeline provides a real total-cohort benefit but also moves a material cache-writer cost onto the first edit. The earlier settled-before-edit screen alone concealed that editing penalty.

Report: `benchmarks/immediate-pipeline-fgpejqs7/immediate-pipeline-report.md`. Original harness and its SHA are retained; resume metadata records the exact between-cohort environmental refusal. All artifacts and ordered diagnostics matched OFF/ON.

Exclusive performance ownership was explicitly released after the last writer/supervisor exited. Root and other agents may validate repair prototypes. Future acceptance needs both ordinary settled edit sequences and immediate edits, with CPU0 regressions reported separately.
