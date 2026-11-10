# Exact-demand closure prototype

Isolated tree `.scratch/frontier-demanded-closure`, branch `codex/frontier-demanded-closure`.
Base exact V18 `2d2d0e5ed449448a8b48248eaa39ac75e1c7b9ab`.
Single coherent source checkpoint `1f37b145be1ff84dc0903a74c30143d9d3223a0d` supersedes the earlier incremental source checkpoints74b9/8a408/5ce6/75ae/db773. **Not sourcechecked or run.** Root has not assigned a heavy validation slot.

Flag `SILK_FRONTIER_DEMANDED_CLOSURE` applies only inside the existing immutable CLI frontier. It changes no host/fork permission or worker-count policy. New worker fields reset with runtime context.

Completed clean captures enqueue exact LEFT digest tickets in supplier-local FIFO lists; foreign/full/EXTERNAL rows do not enqueue. A full two-word digest set deduplicates local tickets, while the existing shared full-definition claims avoid duplicate owners. Four completed module/chunk tasks earn one batch of at most16 exact roots. A batch invokes the existing unbounded `frontierExtend`, with its ordinary visited set, budget accounting and exact MIR/non-MIR read capture. No producer snapshot is serialized to other workers and no extra process/thread is started. Unknown local keys remain for normal final canonical-key expansion/command2.

The batch runs under the worker's existing compute lease and returns/reacquires it afterward. When ordinary tasks end, the worker drains its remaining tickets; a root's reachable subtree is not preempted, so fairness is at task/batch boundaries, as it is for module tasks. Early closure cuts already-owned rows, including own previous quanta, into EXTERNAL placeholders. Such a cut is not positive proof: the coordinator still needs full supplied facts, and existing final command2 can materialize any claimed row absent from initial captures.

Early extension records travel under a separate ephemeral marker in the initial payload. They contribute no module coverage, no runtime-record count and no stable check root identity. Normal exact roster/record matching, finite closure, shared-escape proof, global budget and fine-cache selected evidence remain mandatory. Existing extension provenance lists feed persistence/export. All batch failures, including ticket allocation before lowering and retained-record allocation afterward, abort through the existing worker descendant drain/lease-release path. Parent reads all initial workers before refusing; no new command/reply protocol is introduced.

Source test `demandedFrontierClosureKeepsExactObligationsAndProof` verifies exact LEFT-only ticketing, both digest words, idempotence, unresolved external refusal and ordinary final supplier merge. It is not a native lifecycle/engagement test.

Required validation after root assigns a slot: full sourcecheck, focused test, then enabled/disabled native clean and diagnostic parity, resource rejection, CPU1/no-pool, initial worker/descendant failure and edited-cache controls. Only then build an optimized candidate and compare same-source reversed cold pairs with required early-closure engagement, remaining missing-body counts, worker CPU/PSS and first edits. No timing claim exists.

Risk: tickets can move work ahead of another module that would later supply it; useful module work may be displaced. Batching shares guard/visited work but adds supplemental record/guard bookkeeping. The observed old late interval(~0.94s compiler/~0.18s Harf) is a bound on affected late work, not an additive promised gain.
