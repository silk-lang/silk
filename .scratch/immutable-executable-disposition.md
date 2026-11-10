# Immutable executable body source control

Reference808ON → candidate7d2eON compares matching pinned N1/Clang, four-unit O2/no-PGO construction on frozen original compiler+stdlib. The candidate includes immutable executable bodies and the memo-first repair of rejected preparation factoring. It is compared directly against808, not against rejected8df, and is not original N0 acceptance.

Full original compiler diagnostic engagement passed:1218schema certifications,1073finalized-MIR template reuse events,165schema text emissions and1053text reuse events, with retained artifact/native proof and generated--help. These are combined Count/Resize event counts, not unique keys or CPU savings.

All32 measured calls passed,22 detached writers reaped, all8 matched build-stage artifact pairs byte-identical, runtime edit markers and ordered diagnostics equal. Executable traceOFF for timing; specializationON both modes. Immediate cold→firstedit→secondedit→unchanged sequence has no earlier unchanged priming. Settled tails overlap and are not additive.

| Lane | Cold check wall / totalCPU | Cold build wall / totalCPU | First build edit wall / settled | Second build edit wall / settled |
|---|---:|---:|---:|---:|
| FourCPU |10.382→10.210 /33.754→33.590s |19.782→19.685 /62.249→61.605s |3.088→3.161 /3.586→3.600s |2.761→2.642 /3.224→3.130s |
| CPU0 |20.658→20.884 /22.054→22.250s |48.128→47.084 /48.114→47.067s |3.444→3.388 /3.997→3.949s |3.694→3.666 /4.087→4.062s |

No material four-core cold-wall win. CPU0 build is2.2%lower and both edits slightly improve; rejected preparation’s9–13% CPU0 edit regressions did not recur in this pair. Countervailing increases remain: CPU0coldcheck+1.1%, four-core firstcheckedit+3.7%, secondcheckedit+2.7%, firstbuildedit+2.3%. CPU0cold detached writer CPU rises2.222→2.234s even while totalCPU falls. The per-cohort CPU/writer supplements flag every positive delta independently; no >5% foreground/settled/totalCPU regression in this run.

One directional pair per CPU lane is not a confidence estimate or a3×claim. No automatic repeat launched. All evidence retained; fourcore restored sources were losslessly archived with per-file verification to protect headroom.

Evidence:
- /workspace/silk/.scratch/benchmarks/component-sequence-3e1xrhuj
- /workspace/silk/.scratch/benchmarks/component-sequence-ztdvz7fo
