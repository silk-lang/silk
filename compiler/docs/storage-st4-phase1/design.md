# St4 phase 1: census and proposed soundness boundary

Census source: merged S2 `20327d2ea`. The throwaway build changes only the first unchecked storage operation's reported reason, following #1598. Current published corpus: 423 pass, 0 fail, 0 unsupported, 328 tracked. All 423 emitted per-program receipts.

| Primitive | Corpus bodies | Programs | Self-build |
|---|---:|---:|---:|
| `executionFromAllocation` | 514 | 423 | 0 |
| `executionDrive` | 475 | 423 | 0 |
| `executionNotify` | 430 | 423 | 0 |
| `executionCurrent` | 68 | 44 | 0 |
| `relinquish` | 0 | 0 | 0 |
| `slotAddress` | 1 | 1 | 0 |
| Total storage | 1488 | 423 | 0 |

These are first-reason body counts, not all occurrences: relinquish=0 means another reason masks it, not that it is unused. Other corpus reasons: regions 15882, stored-loans 93, imprecise 6. Clean S2 self-build under the probe: regions 8931, stored-loans 137, storage 0. Raw receipts are in `receipts/`; `make-probe.py` records the instrumentation. No production checker changes are included.

Proposed implementation:
1. executionNotify becomes an ordinary contract call on its shared ExecutionRef operand. Its loan lasts through the call (BORROW-004); counted authority does not borrow caller lexical storage. The separate reached-callback gate still rejects notification while a local-shared access is held. SHARED-003 expressly requires OWN0016 at direct notification; Semantic.buildFrom/localSharedEscapes applies it independently of a body's Checked status. Existing SemanticLoweringCases::localSharedAccessRejectsEveryReachedEscape pins the exact Intrinsic.executionNotify(&reference) primary and related wrap(&core, signals) access spans, including forwarding, recursion and other-module runs. SHARED-004 runtime reentry checks remain the ordinary-source Wake path's guard.
2. Immediate run of executionDrive becomes a contract call: consume Execution, branchState, onComplete and onSuspend; keep all operand/capture loans alive through activation and its normal/failure edges. Completion/suspension callbacks consume their supplied state under EXEC-002/EXEC-004. Do NOT clear stored/unrun drive Effects with that same rule: native currently gives the intrinsic Effect an empty environment, so its type does not account for captured operands. Keep that delayed construction explicitly StoredLoans until those captures have a retention proof; otherwise finish could end the loans too early. This is a diagnostic reason boundary, not a compatibility path.
3. relinquish and executionCurrent are zero-operand primitives. Their construction adds no caller capture loan; an immediate run is one call at the existing S2 graph point. Relinquish saves the running frame chain; current creates counted affine ExecutionRef authority. Existing S2 scope/failure edges and ordinary affine/capture checking still apply. No reference becomes Copy or thread-transferable (EXEC-004); executing a run inside local-shared access remains subject to OWN0016.
4. executionFromAllocation moves allocation/body/readyState/onReady into an opaque Execution<A>. Although the catalog and EXEC-001/EXEC-004 require detached body/state and a detached non-parking endpoint, S2's scope-end events alone do not model opaque package capture retention. Conservatively classify this producer as StoredLoans rather than Storage in this PR; do not label it Checked merely because the returned type names no capture region. A future proof can admit it when the complete retention/Detached evidence is represented.
5. slotAddress remains Storage: raw pointer provenance is not proved by a result lifetime (one body). No unchecked reason is retired falsely.

Validation plan after approval: extend existing Capture/Lowering Cases with exact code/span rejection and clear controls for checked operations; moved Execution/reference/callback reuse (OWN0001), overlapping argument/capture loans (OWN0010/OWN0011), scope-end uses (OWN0019), and direct/forwarded notify or relinquish under shared access (OWN0016). Check the package property's/unsafe-boundary failures against bootstrap before committing their code/span assertions. Pin both opaque package creation and delayed drive construction as not Checked. Cover immediate drive and staged/stored-drive controls distinctly. Require all Cases roots and seeded N1/N2 identical IR plus three entries, fresh corpus and regenerated gap guard. Measure isolated one-shot ABBA on one frozen source because more graph work is admitted. Integrate #1647 stable locations before final review and regenerate the gap from the final merged head.

Approval requested: this conservative boundary checks notify/current/relinquish and immediate drive, moves opaque allocation and delayed drive to StoredLoans, and keeps slotAddress as Storage. No production edits until coordinator OK.

## Delayed-drive experiment and limits

The explicit callback-environment bootstrap fixture returns an Effect with the caller's lifetime without diagnostics. Promising `static` instead produces SEM0212 at span 0..374. The native generic-return fixture rejects **both** controls with `EffectFormUnavailable` in `Semantic.proveOpaqueReturn`. That is a representation/return limitation, so this experiment neither demonstrates a native retention bug nor proves that delayed drive construction is universally unsupported. The proposed retention boundary still needs approval and a fixture that reaches the relevant borrow-checking path.

The native probe's two passing tests classify these typing outcomes; they are not St4 safety acceptance tests. Sources and logs are archived in `design-probes/`. The proposal above is the note posted before this additional experiment; no proposal has been implemented.
