# Checked runtime lowering seam

Source base: V22 `85ba82efe750a4682cc21192ad5dcb37d7bbd981`.
Compact sink checkpoint: `68b67e427afc240e7e934f5b9641db3b39d22175`.
This is a staged prototype, not an accepted performance improvement.

## Scope of the first removal

`MirFunction.plan` and `planStorage` use the same decision engine as `lower` and
`storageHelper`. Ordinary lowering never reads its generated executable blocks;
its cleanup states, owners, exit trie, pending drops, reachability and logical block
ordinals are separate Builder state. The compact sink retains only direct-call
terminators and ordered address/drop events per logical block. `neverSource`,
trapping/layout checks, origin construction, references, nonparking obligations,
shared accesses and escape metadata still execute. Package and observer helpers
inherit the sink, and their controls are kept in their existing helper order.

The temporary `Lowered` result carries an optional checked control and aligned
helper controls. Its function fields provide metadata and local type state during
planning, but its executable blocks are empty. Semantic must immediately project
these into pure RuntimeProof values and drop the temporary skeleton. Executable
storage rejects checked controls. An empty executable graph is never a valid
substitute for a completed MIR answer.

Checked planning skips executable statement retention, debug line/variable
construction, coalescing and executable compaction. It still constructs transient
operand values and retains local type/state slots during lowering. Do not describe
it as eliminating all executable preparation or all lowering allocations.

## Required parity boundaries

- Finalized executable MIR remains the independent projection oracle in stage 1.
- Compare actual planning against lower plus coalesce, not only hand-authored
  compact control. Preserve complete exact keys, reference multiplicity/order,
  origins, pending borrow status and all callback/nonparking/escape facts.
- Helper controls must align exactly with generated helper identities/order.
- Cleanup joins, unreachable code, callable addresses and drop glue require
  real-body cases. Replaced terminators must replace the prior call projection.
- `verifyMir` and suspension-frame expansion remain explicit executable
  capabilities until their relevant checks/transforms have a sound plan counterpart.
- Cache keys and precise dependencies belong to the authoritative plan query;
  malformed or absent proofs must never become positive completion evidence.

## Build reuse is a separate milestone

The sink alone does not retain the prepared input recipe for later executable
materialization. A build which demands both paths still repeats preparation and
some lowering decisions. It cannot claim checked-plan reuse merely because it
compares the resulting proof.

The natural prepared-recipe boundary is the current `MirFunction.lower` argument
set: exact key/body, closed result/failure/parameters/provider addresses, selected
calls, run/storage/carrier/witness plans, partial remainders, cleanup needs,
runtime projections, anchored source and observing/frame configuration, constants.
Its source and body owners must remain alive under the exact query guard; raw HIR
or source borrows must not escape. Explicit policy/codegen fields should be
separated from stable semantic decisions, so observing and frame variants cannot
accidentally reuse a different recipe.

Most prepared tables are already read-only during lowering. The concrete mutation
seams are `takeStorage`, `takeCarrierPlan`, and `takePlan`, which remove selected
entries to move their values. A retained recipe needs immutable selected entries
plus per-materialization consumption state or ownership-safe moves, rather than
a blanket deep copy of every nested plan. `RunPlan` descendants and generated
helper recipes need the same treatment. Resolver/Query dependency discovery stays
in Semantic; the materializer must not repeat it independently.

## Validation status

Full production sourcecheck of `68b67e427` passed. Initial focused compile found a
reserved test parameter, repaired in `b42e67b2d` (also includes complete-proof
equivalence helper `3f06b344d`). Focused native execution at `b42e67b2d` passed all three selected cases (zero cached):
complete proof projection, logical control ordering/replacement, and actual query
plus persisted callee-header invalidation. All jobs were reaped. Receipt:
`.scratch/checked-runtime-plan-b42e67b2d-focused.json`. Actual compact-sink parity
is still required; no speed or build-reuse claim is justified yet.


## Actual compact-sink parity checkpoint

Frozen source `95743dc9ebddbaa5e627ece68f339a8b4d40d548` passed 8/8 selected
native tests, zero cached, through one unoptimized runner. The production changes
were full-sourcechecked at `43220160d4ac38d5a8c6a09186d5a9fab3af23c4`;
subsequent commits changed fixture setup and assertions only. Earlier failed gates
are preserved: direct exact-instance tests lacked normal signature admission, and
observer tests incorrectly expected adapter helpers before global observing mode.
Positive completeness and full exact proof-equivalence assertions were retained.

Actual-source parity now covers cleanup/early returns/unreachable calls,
observer failure paths and generated adapters in both instrumentation modes,
local-shared accesses/external parking, selected provider nonparking obligations,
exact region patterns in both demand orders, and persisted callee-header edits.
Tests assert compact source/helper proofs before materializing executable oracles.
This is bounded correctness evidence, not end-to-end workload acceptance.

Receipt: `.scratch/checked-runtime-plan-95743dc9e-focused.json`.
Logs: `.scratch/checked-runtime-plan-95743dc9e-{1,2,3}.log`.
All processes were reaped; gate slot released. No bootstrap or speed claim follows
from these results. Runtime coverage counters, native CLI/cache gates, matched
four-core/CPU0 cold/edit controls, and prepared-recipe build reuse remain separate.
