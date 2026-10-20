# Source-analysis C pause checkpoint — 2026-10-20

**WIP, not merge-ready. User explicitly requested publication and a stop. Do not resume until the user says so.** This document and adjacent small evidence files are tracked; large binaries/debugger archives remain local. No build/test/replay or policy repair was started for this handoff. Both implementation children stopped cleanly and pushed their pending work separately. There were no active owned native/debugger jobs to interrupt; completed results remain valid.

## Exact integrated state

Branch: `julia/complete-source-analysis-c`, repository https://github.com/silk-lang/silk . Tested source commit: `21fa182c5174f99b1c5b75170f578b0713894bbf`. The subsequent pause commit changes documentation/evidence only, not compiler sources. `attempt55-source-hashes.json` records the complete source SHA256 inventory.

| File | Git blob | SHA256 |
| --- | --- | --- |
| SourceAnalysis.silk | aa816887832e6fb9fc932f82d7606d3f990d5e1e | d328a8580e4d9ea43071640ba1a76678e988beba53debb6187bf2646f91ff2aa |
| BorrowCheck.silk | 6cee5d5ecfffad1babcc232846e7436fd6b0b3cb | f60a878b4f728df982ea6b3482ba48013bf27e19501458a0b4b88c7422e288ab |

Latest integrated source commits are `3eb4e71fe` (logical SA7642) and `21fa182c5` (logical BCd5a): exact unplaced Dereference/Index ownership terminals, both actual Index inputs, raw Case/category/witness retained. Scalar Dereference producer remains separately scoped; Field and physical/address paths unchanged. Integrated performance commits are `3411fbf12` (Contents Case adjacency), `c2c8e3ce0` (publication rows by cell), `2300c403b` (Read/Reference origin dedup indices).

Last main integration is `0008601e9`, accepted main `60fe63464`; remote main at pause is `818b3e549c4eefb6eaba457cf9f7670b442e2706`. **This checkpoint is not current-main integrated.** No PR exists for this branch (checked at pause); no PR, review, watcher or CI dispatch was started. Parent stopped the previous PR1976 watcher.

Atomic cutover `23e7031fd` removed the old BorrowCheck walker (4,673 lines deleted across BC/Semantic); the current public path is `prepare` → `checkPrepared`, using prepared source analysis. There is no old-checker runtime fallback or compatibility shim to re-enable. Old60fe code is historical semantic comparison evidence only. Temporary production probes were removed; later native diagnostics use local debugger scripts. Assertion weakening, cap increases and guessed authority remain prohibited. Recent scope audits preserve all170 BC assertions and12 policy binding sites.

## Completed native evidence (not full acceptance)

All controls use the authentic saved runner/plan/receipt, zero cached and one executed selected test. Runtime bound is90s and6GiB address space. Do not raise either limit. Each attempt has an adjacent archived audit; original raw evidence remains in the local paths below. Some historical audit receipt fields share a recorded hash; use the actual per-run receipt/metrics when doing a later receipt-level review rather than treating a summary hash as independent evidence.

| Attempt / source | Build | Field control | Holder Field control | Other result |
| --- | --- | --- | --- | --- |
|52 /3411fbf12|PASS394.95s|PASS ~5.823s wall (test5829ms)|PASS83986ms (~84.105s wall)|Slice failed first assertion, Imprecise; exact missing Index terminal established|
|53 /c2c8e3ce0|PASS399.35s|PASS5798ms|PASS76.294s wall|Broader acceptance pending|
|54 /2300c403b|PASS396.03s|PASS6096ms|PASS64551ms (64.584s wall,1s PC sampling)|Borrowed-match failed third assertion: released expected Checked, actual Imprecise|
|55 /21fa182c5|PASS392.8286s|PASS5761ms|Not rerun on55|Slice FAIL23586ms, exit1; diagnostic FAIL24311ms, exit1, before first assertion/postsolve|

Holder passes retain the real exact diagnostic for bad and strict Checked positives for outer/sourceDropped. They are authentic, but not a claim about head55 or other fixtures. Negative conflict assertions can mask missing-source gaps.

Exact55 binary SHA256: `41816e81782922a322f7ba0518c691160e60a041cfdd95f2ec517db197efb24e`.
Plan SHA256: `d4fd076555e7b7bca080bf308a468b86484c877b405720480a41b00a35d2d91d`.
Field receipt SHA256: `118e3a88ee79304975ac9441b343f96701621e024953af652027910fab5154a8`.
Slice receipt SHA256: `aa94514d57eaabde8cb0e37b01328ddc664b47fc0ec11b39203e07e760158e33`.
Slice sampled RSS peaked3,371,056KiB; last sampled virtual size3,990,748KiB. It was not a90s timeout. **Cause remains unclassified; allocation failure is only a hypothesis.** Do not carry forward52's Imprecise assertion attribution to55.

Performance remains unacceptable against repository target under1s, preferably under500ms. Holder52→54 improved roughly84→65s and Field remains ~6s; no readiness claim. Further optimization requires measured hotspots, not policy changes. No fresh corpus run/score: **last published baseline remains9 regions /37 stored-loans**. `compiler/borrow-check-gap.txt` is unchanged; only regenerate through the prescribed corpus script after a real corpus run.

## Failures and next diagnostic, only after resume

1. **Slice55 exits before policy verdict.** Existing `slice-six-gaps-v1-debugger.json` records demandBody `bad`, no first assertion or postsolve. Next bounded diagnostic should capture the actual typed error/failed allocation, not infer a semantic gap. Exact55 candidate PCs: rawSystemAllocate failure `0x4dc048` (x20 requested size,x19 alignment), Allocator.outOfMemory `0x4a3624`, storageRefused `0x78e3fc`, test-wrapper return `0xd61b8` (failure bitx0,error24bytes atsp+32), first demandBody return `0x844b10` (error atsp+100). Save registers, native stack, process memory/status and original receipt. No new diagnostic was run at pause. Recheck binary hash before using these PCs.
2. **Borrowed-match54 direct Vacant payload demand.** First two exact rejectsRelated assertions pass; third released fails effects-only. First gap is replacement InputComplete Eval13/input1, directly observing RHS Node10/Eval11/root52, typed VariantConstruct tag1 Vacant with no fields. Root Expression is present; generic inline component enumeration demands inactive Held member0 endpoint53 and nested endpoint54. All cleanup terms were false. Pending BC fix guards only the final completed-component-empty rule using exact direct constructor/top-level member applicability, still scanning every existing Value/Unknown/publication. Copies, Input/storage observations and other occurrences remain unchanged. Pending commit is not integrated or runtime validated.
3. **Retest coherent source after review/integration.** Preserve original slice/holder/borrowed-match assertions, then broader controls and all incremental guards. The earlier wrong slice attribution to sourceFinishRead was corrected: a shared collector return joins sourceFinishOperands; exact typed Index/Physical ResultUse evidence is authoritative.

## Pending child checkpoints — saved remotely, NOT integrated

| Lane | Remote branch and commit | Status |
| --- | --- | --- |
|SA|`julia/semantic-channel-contents` / `f678a63c63757b3f4fb50b83bf7cb3fc2a00cde0`|Private ordinaryResetByCase index only, +14/-7; parser0/static audit; no native runtime validation|
|BC|`julia/borrowcheck-policy-projection` / `b61f2b250e3ac66c4150da4edbe21fb5dc91d3f3`|Direct variant applicability, parser0/static audit; root review/integration/native validation pending|

Both child trees clean, no uncommitted partial work, no owned jobs/children. Exact logical mail patches (gzip archives, to preserve their original bytes) are also stored beside this handoff; they are archival only, not applied. SA blob `df6d8950c2445d2e7982094b00380a31a503e0d8`, SHA256 `aca56a6421b786502e82512b4a6f1f9d5910e1423d102cf6498b61643b9b61a5`. BC SHA256 `4d523f437cea8eb369dd0abc54126081ebcc02f8b71a852aeb59d3da0644b257`. SA pending index removes the exact ordinaryResets.case scan observed in five54 samples, preserving original ordinal and predicate. Do not import dependency sync commits or whole-file child restores.

Child worktrees/artifacts:
- SA `/home/julia/.t3/worktrees/silk/t3-dd25bf3c`; parser `/tmp/sa-grammar-audit/SourceAnalysis-native-parse.json`.
- BC `/home/julia/.t3/worktrees/silk/t3-c50bb779/.scratch/variant-applicability-pause/` contains patch, parser, static audit and pause status.

## Incremental and broader controls

The table lists recovered per-filter historical logs, not a new run or current-head acceptance. Every current-head replay is pending. Preserve the full original reuse/capture/predicate/warm/fresh/oneshot guard, particularly Open formal versus actual capture dependencies. Kernel controls had8 passes in51; they are not latest-head evidence.

| Incremental control | Last recovered historical per-filter log | Current head |
| --- | --- | --- |
| `sourcePreparationTracksUnreadStorageRevisions` | attempt30-once: PASS 23 ms | Pending |
| `preparedOriginalContractsRetainNarrowDependencies` | attempt30-once: PASS 14 ms | Pending |
| `preparedRunsUseDeclaredRepresentationChannels` | attempt30-once: PASS 13 ms | Pending |
| `preparedSectionsSeparateOpenFormalAndCaptureDependencies` | attempt30-once: PASS 56 ms | Pending |
| `primitivePhaseMembersRetainRevisionDependencies` | attempt30-once: PASS 2 ms | Pending |
| `primitivePhaseMembersRespectBinderAndAliasResolution` | attempt30-once: PASS 1 ms | Pending |
| `sourceFrontierKeepsSameModuleAndAnonymousBodies` | attempt30-once: PASS 15 ms | Pending |
| `sourceFrontierRetainsFailedMemberAndSiblingFacts` | attempt30-once: PASS 1 ms | Pending |
| `sourceFrontierKeepsEmptyImplementationCatalog` | attempt30-once: PASS 864 us | Pending |
| `sourceFrontierRetainsOperationCatalogValidation` | attempt30-once: PASS 756 us | Pending |
| `fieldLifetimeReferencesRetainPreciseInputs` | attempt30-once: PASS 1 ms | Pending |
| `fieldLifetimeArgumentsRetainPreciseInputs` | attempt30-once: PASS 1 ms | Pending |
| `sectionOutputIdentityPreservesNormalizedContributors` | attempt30-once: PASS 323 us | Pending |
| `stagedAnonymousEffectsStoreTheInvocationEnvironment` | No verified per-filter log recovered in this pause audit | Pending |

Broader pending controls include movedPlacesInPlainBodies, carriedLoansAreKeptWhereTheyLie, implicitReceiverBorrowsRetainStoredSources, initializedStorageCoversEarlierCallArguments, reborrowSourcesMustAllReachTheirTarget, selectedSectionCapturesKeepTheirActualLoans, crossedBodyLocalReborrowsKeepTheirUniversalParentBound, symbolicReborrowParentsKeepEverySourceBound and all storedLoansS2 controls. `continuation-status.json` contains the explicit list. Final coherent review, main merge and exact-head required CI remain owed.

Language changes were discussed as possible later work (explicit retention contracts/simpler precision rules); none was authorized or implemented. Do not treat that discussion as a decision to relax current policy.

## Local evidence and resume commands

Root: `/home/julia/.t3/worktrees/silk/t3-a37112dc`.
Artifacts base: `.scratch/complete-source-c/atomic-validation/`.
Attempt directories: `attempt52-contents-case-index`, `attempt53-field-publication-index`, `attempt54-origin-dedup-index`, `attempt55-unplaced-projection`. Each retains `callable`, `.symbols`, saved plan/receipt and source hashes; LLVM text may have been removed.55 uses `callable.saved.receipt`, not `.saved.result`.

Important54 evidence: `borrowed-match-replacement-v5-debugger.json`, `borrowed-match-contributions-v4-debugger.json`, `holder-pc-sampling-symbolized.json`. Important55 evidence: `audit.json`, `scope-audit.json`, `broader-slice-metrics.json`, `broader-slice.receipt`, `slice-six-gaps-v1-{diagnostic.py,console.log,debugger.json,debugger.log,debugger.receipt}`. `/tmp/nm55.txt`, `/tmp/solve55.disasm`, `/tmp/slice55-wrapper.disasm`, `/tmp/slice55-claims.disasm` retain decoder coordinates. Debugger archives/binaries are local, not pushed. Raw logs/receipts were not rewritten; only summary audit/ledger stale statuses were reconciled at pause.

After explicit user resume, first inspect status and fetch pending branches. Review each pending logical diff before cherry-picking; do not automatically integrate them based on this handoff. Run only one native build/control/debugger at a time through the existing gate. Example commands (not executed for pause):

```sh
cd /home/julia/.t3/worktrees/silk/t3-a37112dc
git status --short
git fetch origin julia/semantic-channel-contents julia/borrowcheck-policy-projection
# After review/integration, build a fresh uniquely named attempt:
SILK_VALIDATE_OPTIMIZATION=speed SILK_DIAGNOSTIC_SYMBOLS=1 python3 .scratch/complete-source-c/atomic-validation/run.py attempt56-resumed fieldStoredLoansJoinRegionProofs compiler/src/semantic/SemanticCaptureCases.silk
python3 .scratch/complete-source-c/atomic-validation/bounded-control.py .scratch/complete-source-c/atomic-validation/attempt56-resumed holderTransferFieldLoans resumed-holder
```

Use the same bounded-control tool for slice and borrowed-match after diagnosing the typed failure. Callable incremental guards need their own authentic `SemanticCallableCases.silk` runner. Native gate: `/home/julia/.t3/worktrees/silk/t3-0a77f05d/.scratch/lifetime-coordination/native-gate.py`. Verify original plan/receipt identity, executed>0/cached0 and source hashes. No assertion weakening, increased limits, stale binary substitution, completion waiver or generic Unknown suppression.
