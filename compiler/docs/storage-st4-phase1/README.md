# Storage St4: phase-one handoff

St4 is at design review. This directory publishes the completed census and proposal from Spike ticket 34, on the user's instruction to push the saved work and report its status. It contains no production checker changes.

## Current status

- Census and design note completed on merged S2 source `20327d2eae9a11cdef9ded50b583a33023df7c1e` ([#1644](https://github.com/silk-lang/silk/pull/1644)).
- Design approval requested from `coordinator` in Spike question 54; no approval was received before the outage.
- Spike board/question reads and progress/handoff writes returned HTTP 500. The last confirmed claim expired at `2026-10-13T13:26:38.601Z`; implementation stopped. Cursor 1258 and assignment/claim identifiers are preserved in `receipts/resume-handoff.json`. Failed writes are not confirmed board updates.
- Publication is authorized directly by the user. Resuming implementation requires live assignment/ownership confirmation and the coordinator's design approval.
- [#1647](https://github.com/silk-lang/silk/pull/1647), stable borrow-checking locations, was still open when this report was prepared. Integrate it and regenerate final evidence before implementation review.

## Completed evidence

The throwaway compiler splits the first unchecked storage reason by operation. It does not implement contract checking or change which bodies are checked.

| Operation | Corpus bodies | Programs with reason | Clean-source self-build bodies |
|---|---:|---:|---:|
| executionFromAllocation | 514 | 423 | 0 |
| executionDrive | 475 | 423 | 0 |
| executionNotify | 430 | 423 | 0 |
| executionCurrent | 68 | 44 | 0 |
| relinquish | 0 | 0 | 0 |
| slotAddress | 1 | 1 | 0 |
| Total storage | 1488 | 423 | 0 |

Full published corpus: **423 pass, 0 fail, 0 unsupported, 328 tracked**. Other corpus reasons: regions 15882, stored-loans 93, imprecise 6. These are first-reason body counts, not occurrence counts; zero for relinquish can reflect masking by an earlier reason.

The pinned seed successfully built the instrumented N1. That build's log reports regions 8816 and stored-loans 834 because it is the seed checking the probe's source; those counts are not the probe's census. The probe N1 then compiled the clean S2 compiler source to LLVM IR: regions 8931, stored-loans 137, storage 0. This single clean-source build is not an N1/N2 fixpoint verification of a St4 implementation.

The delayed-drive experiment is documented in [design.md](design.md). Bootstrap accepts the caller-lifetime control and rejects a static return with SEM0212. Native rejects both controls with `EffectFormUnavailable`; the experiment does not establish a retention bug or a retention proof.

## Proposed boundary and remaining work

The unapproved proposal is to check notify/current/relinquish and immediate drive as contract calls, classify opaque allocation and delayed drive under stored-loans until capture retention is proved, and retain storage for raw slotAddress. [design.md](design.md) connects these boundaries to BORROW-004, EXEC-001/002/004 and SHARED-003/004 and identifies the existing OWN0016 gate.

No St4 production implementation, new safety Cases, N2 IR comparison, three-entry compilation, complete Cases-root run, final gap regeneration, or ABBA cost measurement has been completed. After approval, implement the agreed boundary with exact diagnostic codes/spans and valid controls, integrate the required stable-location changes, and run those gates on the final source. This handoff is a draft for review of the findings and design, not a merge-ready St4 implementation.

## Artifacts and reproduction

- `make-probe.py`: original throwaway instrumentation generator; expects a source snapshot containing `compiler/` and `packages/compiler/stdlib/`, plus a separate scratch destination. Its anchor assertions require the frozen source above. Do not apply it to the production tree.
- `receipts/merged-corpus-census.log`: all corpus outcomes, per-program gap receipts and timings.
- `receipts/merged-census.json`, `corpus-programs.json`: aggregate census and the exact 423-program inventory.
- `receipts/merged-probe-n1-build.log`, `merged-self-build.log`: probe build and clean-source build receipts, respectively.
- `receipts/native-seed.json`: pinned seed manifest; `artifact-sha256.json` records the seed, instrumented compiler and clean-source IR hashes.
- `receipts/census-runner.ts.txt`: exact scratch runner used with the repository's corpus harness. Its absolute paths describe the original workspace; adapt them to a frozen checkout for replay. It was bundled with dependencies and source-correct `import.meta.url` values, and ran with concurrency 2 and explicit stdlib/Clang paths.
- `design-probes/`: delayed-drive fixtures, native classification probe and recorded outcomes. These are exploratory sources, outside production test discovery.
- `receipts/resume-handoff.json`: historical outage/ownership checkpoint. Its scratch paths describe the original workspace; this directory is the durable source/evidence handoff.

For a fresh scratch census build, extract the frozen source, then run:

```sh
python3 compiler/docs/storage-st4-phase1/make-probe.py /absolute/frozen-source /absolute/probe-source
export SILKC_CLANG=/absolute/clang
/absolute/verified-pinned-seed build /absolute/probe-source/compiler/src/silkc.silk -o /absolute/probe-N1 --stdlib /absolute/probe-source/packages/compiler/stdlib --optimization speed --debug false --stats
/absolute/probe-N1 build /absolute/frozen-source/compiler/src/silkc.silk -o /absolute/clean-self-build.ll --emit llvm-ir --stdlib /absolute/frozen-source/packages/compiler/stdlib --optimization speed --debug false --stats
```

Use the frozen checkout's published corpus and tracking file when adapting the archived runner. A replay on a later checkout is a new census, not reproduction of these numbers. Binaries, generated IR, bundled dependencies and duplicate source/toolchain trees are excluded from this handoff.
