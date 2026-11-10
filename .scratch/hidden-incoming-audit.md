# Hidden incoming pointer forwarding

Clean source e5812895ce17f29dab294a5581e3a4032eb85c05 in /workspace/silk-hidden-incoming-values, based on repaired V20 0b984e03229d055fceb9d9eac71fce27a236e24e.

## Why the previous proof missed this class

Storage.parameters formerly covered only written parameter indices1..count. Hidden Provider/Observer/Cause/Site locals were never candidates, although emitHiddenStores and emitDiagnosticStores spill their incoming pointer arguments. Normal observer-event MIR and appendDiagnostics repeatedly read these slots through emitOperand. This is distinct from no-op Drop; no Drop exclusion is weakened.

A bounded V17 Harf packet sample identifies model/metrics/varc.deltas at fonts/parse/src/model/metrics/varc.silk400. Its source has self, index, coords slice, out slice: six LLVM lanes. OrdinaryShape then appends observer/cause/site, followed by failure/context. The 11-argument LLVM signature therefore places diagnostics at arguments6/7/8. Existing per-function census reports three high-use spill slots28/29/30 with109/33/19 loads. The sample authenticates one captured packet and confirms argument8 is stored to slot30. Other repeated stores of argument10 are failure-context copies, a different class this patch does not target. Complete workload attribution remains pending; do not equate the entire117,785 argument-spill count with these hidden locals.

Sample receipt: .scratch/hidden-incoming-harf-sample.json. Input digest b75bd6d2f4e2bdaafe643786468f6c16f4767546087b728692ca9cc7b629fa20.

## Implicit-write audit

- LlvmCode.emitHiddenStores: ordinary provider initialization; actual stores retained, cached pointer installed afterward only if the same full-MIR own-slot proof succeeds.
- emitDiagnosticStores: observer/cause/site initialization. The function also runs on coroutine resume/cancel; those paths return before ordinary storage analysis and never acquire incoming-value proofs. rememberIncomingPointer additionally refuses a nonempty writer.frame.
- emitEnter/emitStep/transferState: store/reload coroutine frame words and locals; unchanged, no incoming-value plan.
- reportTrapDescriptor: loads observer/cause/site from retained slots, then passes loaded pointer values to diagnostic.fatal. It does not expose those spill-slot addresses. Kept unchanged.
- All explicit MIR writes, Ref/AddressOf/ContextOf exposure, Drop, and unreachable mentions remain classified by the existing full effects traversal. A rewritten hidden cause/site local therefore cannot use the incoming value.
- Failure-context companion writes affect separate companion slots, not an incoming pointer slot. Provider/diagnostic pointee changes remain ordinary memory accesses.
- C/fixed-linkage entries and optimized non-fastPath emission retain the prior path. Source-visible stores, debug slots and locations are not removed.

## Validation

Pinned N1 full sourcecheck passed24.37s with five existing unused imports only. One focused test covers four hidden lane kinds × four proof scenarios (unchanged, overwritten, own address exposure, unreachable overwrite), with positive emitted IR assertions retaining all four spill slots/stores while removing their ordinary incoming reads. PASS5ms. No source fixes were necessary. Logs .scratch/hidden-incoming-sourcecheck.log and .scratch/hidden-incoming-focused.log. All processes reaped, slot1 released.

Native observer/failure/recovery/resume cases, full cache/debug gates and actual post-change load counts still await a combined candidate. No measured speed claim.
