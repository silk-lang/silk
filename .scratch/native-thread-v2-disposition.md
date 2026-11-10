# Native-thread V2 disposition

V22 process frontier → V2 native-thread ownership/scheduler, matching pinned N1/Clang four-unit O2/no-PGO construction and frozen original compiler+stdlib. Both binaries receive the thread request flag; V22 ignores it. CPU0 automatic no-pool admission measures unconditional source/ownership costs. This is not N0 acceptance.

All32 calls passed correctness, all8 build-stage artifact pairs were byte-identical, and all23 detached writers were reaped. The candidate engaged four native-thread logical workers with actual shared-body reuse and an observed joined marker. Warm and CPU0 commands did not create a pool. Runtime/help edit markers and ordered diagnostics matched.

| Lane | Cold check wall / totalCPU | Cold build wall / totalCPU | First build edit wall / settled | Second build edit wall / settled |
|---|---:|---:|---:|---:|
| FourCPU |11.531→15.888 /38.148→40.223s |19.671→27.803 /62.214→69.267s |3.027→3.176 /3.433→3.650s |2.627→3.133 /3.089→3.616s |
| CPU0 |20.848→21.219 /22.401→22.637s |46.808→47.843 /46.772→47.766s |3.362→3.649 /3.924→4.263s |3.657→3.786 /4.061→4.189s |

Four-core cold check regressed37.8% and build41.3%; buildCPU increased11.3%. CPU0 first-build-edit foreground/settled/CPU each increased about8.6%, even with no pool. Four-core second build edit increased19.3% foreground and17.0% settled. The source package is rejected as a performance candidate. Small positive deltas, including writerCPU and unchanged checks/builds, remain visible in per-cohort supplements; no repeats launched.

The diagnostic full-build engagement showed initial taskcounts[37,1,10,190] and MIRowned[3813,18101,14163,7204]. Initialshard completions[7.591,10.694,7.437,6.821]seconds share the frontier-start origin. Bodyreuse3245initial→4419latest (1174late); published6717, latesteligible23467/refused12330. Counts are local events, not unique keys or a CPU-savings estimate.

Artifact discovery/proof/emission events1.786/2.101/5.107seconds have the artifact-phase origin; finalacceptance21.036seconds uses frontier-start origin. These cannot be directly subtracted as if they share a clock start. The explicit join marker occurs after all final metrics and selected emission, before artifact acceptance. The candidate intentionally forgoes process-native-coordinator overlap. Ordinary detached publication is measured/reaped rather than falsely requiring the process checkpoint barrier.

Separate closure candidate822 diagnostic full build passed artifact/native/runtime but failed its engagement gate:43202 logical definitions and43202 selected/emitted, zero pruning. No selector refusal was observed, and schema/templates did engage, but no positive closure work reduction was proven. Failed cohort preserved in full; no closure formal matrix or relaxed gate.

Evidence:
- /workspace/silk/.scratch/benchmarks/component-sequence-dcq_l6u8
- /workspace/silk/.scratch/benchmarks/component-sequence-e5r3ogcm
- /workspace/silk/.scratch/benchmarks/threads-engagement-woz6nq1y
- /workspace/silk/.scratch/benchmarks/closure-engagement-uwrst7nt
