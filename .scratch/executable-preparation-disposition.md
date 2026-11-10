# Preparation factoring source control

Both versions enabled the combined Count/Resize executable schema and finalized-MIR templates. Reference808 and candidate8df have matching pinned producer, Clang, four-unit O2/no-PGO construction. Frozen original compiler and stdlib inputs match. This isolates preparation factoring, not schema expansion and not original-baseline acceptance.

The diagnostic full compiler build passed retained artifact/native proof and generated --help, with1218 schema certifications,1073 MIR-template reuse events,159 text emissions and1059 text reuse events. Counts combine both schema kinds and are not unique global identities.

All32 measured invocations passed;22 detached writers were reaped. All8 matched build-stage artifact pairs were byte-identical and runtime/help edit markers matched. Executable trace was disabled during measurement. Immediate edits followed foreground return without unchanged priming; settled tails overlap and cannot be added.

| Lane | Cold build wall | Cold build total CPU | First edit wall / settled | Second edit wall / settled |
|---|---:|---:|---:|---:|
| Four CPU |19.661→19.622s |62.073→61.201s |2.993→3.102 /3.458→3.538s |2.754→2.716 /3.215→3.170s |
| CPU0 |46.887→47.391s |46.879→47.375s |3.418→3.448 /3.965→4.333s |3.661→4.125 /4.070→4.510s |

Four-core cold wall is essentially flat. CPU0 first-edit settled time increased9.3%, totalCPU5.5%, detached writerCPU.810→.988s (+22%). CPU0 second edit foreground increased12.7%, settled10.8%, totalCPU7.2%; detached writer CPU was unchanged at.832s. CPU0 cold checks improved21.346→20.877s, while four-core checks were nearlyflat10.782→10.758s. These are single directional pairs, not confidence intervals.

No material cold-build gain supports promotion; the immediate CPU0 build regressions remain explicit. No repeat was launched. Per-stage foreground, settlement, totalCPU and detached writer changes (including every positive delta) are in each cohort’s cpu-writer-regressions.json/md.

Evidence:
- /workspace/silk/.scratch/benchmarks/component-sequence-ai0i03x4
- /workspace/silk/.scratch/benchmarks/component-sequence-_64fcot7
