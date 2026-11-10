# V22 versus V19: no meaningful performance improvement demonstrated

All64 calls passed the required correctness and execution-policy gates, but the single-pair measurements show near parity and several small editing regressions. No repeat timing is warranted for a performance claim. This is a source-component comparison with matching compiler construction, not original N0 acceptance; the3× goal and original-baseline editing/single-core regressions remain unresolved.

Frozen reference V19: source `b0f222d1cddb807bc0aa2bd66965ee7b68e518be`, binary SHA `d28229b60666ebe8acb8ff107ef048f72a72607d6475768fe6d1f4e53de622f3`. Frozen V22: source `85ba82efe750a4682cc21192ad5dcb37d7bbd981`, SHA `accdfe2f81e1b109d83b1fcaed9c29837b2bdfebed3694e17a71511772fec2a6`. Both use the same producer/Clang, four O2 codegen units and no PGO. Runtime features are identical; native pipeline ON, completed registry OFF. Workloads/stdlib are the original pinned snapshots.

One reference→candidate pair per case. Every sequence is cold → first edit → second edit → unchanged, launched after foreground return without waiting for detached writers. The final unchanged invocation does not rewrite source or prime either edit. Times below are foreground seconds, V19→V22; full reports retain settled time, process-tree CPU, exact timestamps and every individual regression flag.

| Execution lane | Operation / workload | Cold | First edit | Second edit | Unchanged | Complete settled sequence |
|---|---|---:|---:|---:|---:|---:|
| Four cores | check / compiler | 10.659→10.311 | 2.606→2.574 | 1.818→1.796 | 1.072→1.081 | 16.214→15.830 |
| Four cores | check / harfrust | 4.085→3.964 | 0.918→0.902 | 0.695→0.711 | 0.525→0.549 | 6.282→6.189 |
| Four cores | build / compiler | 19.646→19.242 | 3.026→3.107 | 2.669→2.796 | 0.071→0.089 | 25.855→25.666 |
| Four cores | build / harfrust | 6.589→6.667 | 0.818→0.772 | 0.788→0.830 | 0.149→0.143 | 8.421→8.504 |
| CPU0 | check / compiler | 20.710→20.789 | 2.766→2.794 | 2.105→2.054 | 1.443→1.453 | 27.123→27.192 |
| CPU0 | check / harfrust | 7.095→7.093 | 1.297→1.366 | 0.870→0.910 | 0.700→0.745 | 10.055→10.209 |
| CPU0 | build / compiler | 47.681→47.356 | 3.361→3.401 | 3.730→3.717 | 0.147→0.152 | 55.267→54.939 |
| CPU0 | build / harfrust | 13.264→13.038 | 1.184→1.168 | 1.303→1.293 | 0.296→0.303 | 16.130→15.898 |

Observed flags requiring disclosure, not hidden by cold timings:

- Four cores: compiler unchanged build0.071→0.089s, +26% but only18ms (settled0.082→0.101). Harf second build edit0.788→0.830s, +5.4% /42ms (settled0.981→1.030,+49ms). Compiler second build edit was also4.7% slower, below the5% flag threshold.
- CPU0: Harf first check edit1.297→1.366s, +5.3% /69ms (settled1.933→2.033,+100ms). Unchanged check0.700→0.745s,+6.4% /45ms (settled0.712→0.758,+46ms). Second check edit was4.6% slower /40ms. Single-core builds were near parity, with cold gains under2%.
- Four-core cold build compiler improved2.1%, while Harf worsened1.2%; CPU0 improved0.7% and1.7%. These small single-pair changes do not establish a material benefit or statistical significance.

Clarification of the earlier55.27s message:55.267s was the V19 CPU0 **complete build sequence**, including cold+two edits+unchanged and all writers.47.681s was its **cold foreground** alone. They are different wall-time intervals, not CPU-versus-wall values. The cold process-tree CPU was47.650s.

Four-core policy evidence: all8 cold invocations accepted frontier proofs; all4 cold builds accepted native artifacts and emitted ordered checkpoint completion. Both modes had zero live cold writers at the first build edit. CPU0: all8 cold invocations automatically refused the worker pool; every stage had no frontier pool/coordinator/checkpoint. Second build edits and unchanged commands overlapped ordinary warm writers in both lanes. Actual launch gaps were13.9–23.4ms on four cores and14.6–31.8ms on CPU0. All16 unchanged invocations preserved source contents/mtime.

All64 compiler invocations, their supervisors, and44 externally adopted writers completed/reaped successfully. Parent-reaped checkpoint writer CPU is already inside primary wait4 usage. All complete plain diagnostic blocks match, including emitted notes/related locations. Human output does not contain raw byte-span endpoints; full JSON coverage belongs to separate correctness gates. Native binary hashes may differ due to emitter changes; per-stage help output/edit markers and real Latin/Arabic shaping output matched exactly. All64 runtime checks passed and their stdout/stderr/hash receipts remain. Successful artifact links were removed only after whole-cohort validation; failed V20 artifacts remain untouched.

CPU0 paused only between fully completed cohorts after8 calls because the disk guard fell just below1536MiB. Completed four-core duplicate sources were pruned with9147 per-file SHA receipts and original mains retained, then only the remaining24 CPU0 calls resumed. No measured invocation or immediate sequence was interrupted. All jobs ended before exclusive ownership was released. No further cleanup or repeat timing is queued.

Provenance:

- [Four-core report](benchmarks/component-sequence-ur50urv4/component-report.md), [raw results](benchmarks/component-sequence-ur50urv4/results.json), [metadata](benchmarks/component-sequence-ur50urv4/metadata.json), [source cleanup receipt](benchmarks/component-sequence-ur50urv4/pruned-restored-source-copies.json).
- [CPU0 report](benchmarks/component-sequence-gmp684bt/component-report.md), [raw results](benchmarks/component-sequence-gmp684bt/results.json), [metadata/resume receipt](benchmarks/component-sequence-gmp684bt/metadata.json), [original disk refusal](benchmarks/component-sequence-gmp684bt/aborted.json).
- [Frozen pins](v22-component-pins.json), [commands](v22-prepared-component-commands.json), [harness SHA freeze](v22-harness-freeze.json), [diagnostic scope/provenance](v22-diagnostic-provenance.json).
