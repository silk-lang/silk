# V22 critical path: measured boundaries and remaining work

Read-only analysis of frozen V22 source85ba82efe750a4682cc21192ad5dcb37d7bbd981. No new compiler or profiling run. Same-construction control: `benchmarks/component-sequence-ur50urv4/results.json` and its cold build logs. Full-scale acceptance: `benchmarks/storage-artifact-engagement-cs9hgmg6/{result.json,build.log,passed.json}`. These single paired observations do not establish statistical significance.

## Matched compiler and Harf spans

Each increment below subtracts timers with the SAME origin. The last row subtracts artifact preparation from the enclosing codegen progress phase, so includes small surrounding driver overhead as well as the native/import overlap.

| Span | Compiler V19 | Compiler V22 | Harf V19 | Harf V22 |
|---|---:|---:|---:|---:|
| Actual artifact-edge discovery |1.618s|1.583s|.903s|.969s|
| Projection/global closure proof |.287s|.284s|.029s|.029s|
| Selected emission, packet transport/validation |1.800s|1.764s|.339s|.257s|
| Exact replay capture and unit assembly |.263s|.268s|.030s|.029s|
| Total before native coordinator starts |3.968s|3.899s|1.301s|1.284s|
| Remaining codegen phase after preparation |6.742s|6.291s|1.689s|1.886s|
| Enclosing codegen phase |10.71s|10.19s|2.99s|3.17s|
| Check progress phase |7.85s|8.00s|2.60s|2.53s|
| End-to-end foreground |19.646s|19.242s|6.589s|6.667s|
| Entire reaped process-tree CPU |61.160s|61.326s|19.137s|19.392s|

Compiler build changes improve the measured codegen span by.52s while check is.15s longer; total CPU is essentially unchanged. Harf improves selected emission by.082s, loses.066s in discovery, and loses.197s after preparation. Thus the observed smaller IR has not established a total CPU reduction. Current logs cannot identify which native substage or cache CPU cost offsets it.

## Timer origins and what is already overlapped

`Semantic.retainedArtifact` line1581 samples a NEW clock after checking/root preparation. Its discovered/proved/emitted/prepared messages use that clock. `frontierSplit` is set inside checking at line99094; descendant emission, check-cache assembly, artifact cache import, deferred artifact replay capture and final artifact accepted use THAT earlier clock. `frontierStarted` is earlier still, set before the runtime escape walk at97485; the split message uses frontierStarted. None of the ms values can be added indiscriminately.

Codegen progress begins at Semantic101562, immediately before retainedArtifact on this cold successful path. It ends in main after finishPreparedNative returns and the accepted checkpoint path has waited for native objects (main3558 onward). Consequently codegen is NOT a timer for LLVM emission alone. The successful standalone V22 fullproof codegen11.07s consisted of local discovery2.022/proof.299/emission1.907/replay+assembly.268, followed by an approximately6.574s overlap/driver envelope. That fullproof was acceptance evidence, not the matched speed result.

At main3336 a separate coordinator starts native work from the prepared artifact. The parent concurrently imports the final dependency-bearing cache image, checks exact replay, closes semantic workers, and starts the tracked cache writer. Only then does NativeCoordinator.publish wait for native completion and promote objects. BuildCheckpoint.drop joins the writer before command completion. Moving cache import alongside native work is ALREADY implemented; it cannot be counted as a fresh saving.

Native start/checkpoint/objects-published messages have no timestamp. The receipt data lacks per-child stage attribution. Final accepted time14.622s (compiler) or5.490s (Harf) is since frontierSplit, not since artifact preparation. Covered-runtime-exports is an adjacent earlier boundary, not a synchronized codegen start. Using it only as a rough alignment, compiler acceptance is several seconds before codegen finishes, whereas Harf acceptance is near its end. This suggests different critical branches, but a monotonic trace/current CPU sample is required to separate checkpoint serialization, encoding, Clang, wait and publication precisely.

## CPU lower bound rules out a five-second scheduling-only fix

V22 compiler uses61.326 CPU seconds on an inherited four-CPU affinity, including reaped persistence work. Perfect scheduling therefore cannot finish the same work below15.332s. Current foreground19.242s leaves at most3.910s for eliminating all idle time and all serialization, an unattainably optimistic scheduling bound. Saving five seconds requires at least4.357 CPU seconds of work removal even under otherwise perfect utilization. Reaching~12.7s (three times the original~38s) requires total CPU below~50.8s: at least~10.5 CPU seconds removed, plus near-perfect scheduling. The current lower bound matters more than the percentage reduction in emitted loads.

## Remaining backend barriers and their scope

1. Discovery sends every breadth round to all four owners and receives them in owner order before adding the next edges (Semantic1648 onward). Compiler takes81 rounds for43,274 selected definitions; Harf grows55→59 rounds with generated helpers. Proof proper is only.284s/.029s. A cached exact build-edge record or owner-local transitive batch can remove repeated traversals/serialization, but removing every current compiler discovery+proof millisecond would save only1.867s. Check graph and actual build graph cannot simply be equated: exact representative choice, observing/frame restarts and generated-helper edges must remain correct.
2. Emission waits for the complete graph proof and returns whole worker packets. Parent collects/validates all definitions, constructs all unit groups, THEN starts native work. Streaming native-ready units earlier has a real1.764s emission overlap envelope here, not five seconds. Package grouping currently depends on emitted lengths; a streaming implementation must preserve deterministic groups, declaration closure, full debug identity, incremental locality and restart discard. Launching speculative native compilation during checking adds a larger overlap window but cannot beat the CPU floor and may steal cores from the existing critical work.
3. main.compileUnits constructs fragment copies, debug metadata and all native jobs before CodegenCache.runAll. Each native thread then performs Bitcode.compileDebug, writes the file, and synchronously runs Clang. Thus the6.291s tail includes Silk bitcode generation and job setup, not just Clang. A bounded producer/consumer pipeline could start completed jobs earlier, but current evidence does not establish a multi-second setup cost. Further global packing is disfavored by the measured edit collateral.

Prior diagnostic evidence: V13 CPU sampling (`benchmarks/v13-cpu-build-cw3f9tud/REPORT.md`) found workerCPU2.091s in discovery,4.768s in emission,2.707s in cache export plus parent.909s import; native tools15.323s. During emission resolveEmissionInputs alone sampled.828CPU, ContentHash.append.414, Type.encodeInto.172; LlvmCode family across the whole build only.485CPU. These are mechanism clues from another source/construction, not current V22 savings estimates. V13 native static-batch imbalance had only~.6s ceiling. Direct-bitcode support already preserves full DWARF; there is no large textual-LLVM parsing path to remove. The previous in-process mem2reg experiment increased native CPU~43% and is rejected.

## Frontend duplicate-work evidence and its limits

Original N0 cold compiler check in integrated-cold-ndsog2ts round0 consumed23.512 reaped CPU seconds (22.284 foreground); current V22 cold check consumes33.833 CPU (10.311 foreground). This~10.3CPU difference is a total architecture/construction/persistence difference, NOT an exact count of duplicate semantic computation. N0 has no query-family timing, and parallel --timings reports parent query counters, not aggregate worker runs.

V11 exact CPU sample located30.212 of33.142 compiler userCPU in workers. Parent-only cache merging cannot erase the excess. Initial worker transport consumed25.394 workerCPU, missing-body completion another2.071 and cache export another2.747. The graph's124,846 record references versus47,139 unique entries includes legitimate repeated root membership; it does not establish repeated MIR computation.

V14 authored-input census proves717,861 exact observations for276,363 distinct key+value pairs (61.5% repetition). However the measured fingerprint family was only~1.05CPU in V11. Broad shared source hashing therefore has a much smaller envelope than10CPU. V16 packet census proves duplicated persistence structure: compiler609,351 raw leaves→281,826 merged;497,747 raw nodes→274,474 merged, but only71,241 roots→66,302. This supports avoiding repeated provenance construction/transport, not assuming half the expensive semantic answers repeat. CacheBundle already targets its bounded transformation cost and must be evaluated separately.

The completed registry screen (`registry-screen-zqi3qiu5`) saved only~.495 checkCPU on compiler and left buildCPU55.906→55.867 while slowing foreground17.380→17.789 in two reversed rounds. Repeating fine-grained registry lookup/RPC is not the recommendation. The next structurally credible CPU lane is sharing coarse expensive immutable query results and their provenance across worker snapshots, with bounded per-family exact-run accounting first. Worker_forks is independently auditing that boundary and the existing registry evidence; no exact expensive-query duplication percentage is currently established.

## Recommendation

Do not start another subsecond scheduling tweak or claim a five-second backend win from these logs. Prioritize a current same-binary CPU attribution plus exact expensive-query duplication accounting: definition/body/MIR/emission-input runs with stable profile/context identities, separate inherited hits, actual provider runs, and transport/provenance cost. Reuse existing99Hz per-PID/TID sampler with monotonic trace arrivals; record coordinator setup/first native job/checkpoint/wait completion so the native tail is identifiable. This is a bounded diagnostic, not a new production mechanism.

A larger unified dataflow design is plausible only if it removes duplicated work: compute a reusable exact MIR+dependency result once, consume it for checking and actual build-edge discovery, and emit closed deterministic units directly from those records. It must preserve distinct check scopes/ownership/observing contexts, generated-helper identity, and fine-cache evidence; no key-only cross-context sharing. Earlier native start is a complementary consequence, not sufficient justification. The existing data provides a10CPU architecture gap to investigate, but does not yet prove10CPU is safely removable.
