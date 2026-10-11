# Native borrow checking

Roadmap step 14 (#567, "Implement native borrow checking, then remove TypeScript"). This is a
design note for Julia's review. Nothing here is implemented. It extends
[`mir-core-shape.md`](mir-core-shape.md) §5 ("Room for borrow regions") and relies on
[`region-sensitive-identity.md`](region-sensitive-identity.md).

## Summary

- The native compiler gets a borrow stage that proves the loan and lifetime rules of the reference
  (`ownership-and-borrowing.md`, `lifetimes.md`, `local-shared-ownership.md`) and reports the same
  diagnostics as the TypeScript bootstrap: OWN0010, OWN0011, OWN0012, OWN0014, OWN0015, OWN0016,
  OWN0018 and OWN0019, plus the move codes the native typing stage already reports.
- It runs on **checking MIR**, never emitted: one `Mir(Abstract(declaration))` per ordinary body
  (generic or not), and one selected-body MIR per static selection. Inactive static arms are never
  lowered, so they are never checked. Monomorphic instances are not checked again.
- MIR gains storage markers, a region side table, explicit capture and provider loans, and calls
  through declared bounds. Regions are finite point sets over MIR locations, solved as the bootstrap
  solves them (`Lifetime.solve`). Loan liveness is a backward dataflow over the MIR control-flow
  graph.
- The check is one query family, `BorrowCheck`, keyed like the checked body it proves. It depends on
  that body, its checking MIR and its callees' signatures, never on callee bodies, so an edit
  re-checks only the edited body and the callers of a changed signature.
- Until every body is checked, `SILK_GAP borrow-check` keeps counting unchecked emitted bodies, now
  split by reason. When the count reaches zero on the self-build and the parity corpus agrees with
  the bootstrap, the gap becomes a hard error and TypeScript can be deleted.

## 1. What the checker reproduces

### 1.1 Reference rules

The borrow stage owns the loan, liveness and region rules. Move and initialization rules already
have native owners in typing (§1.3).

| Rules                                                                                       | Bootstrap codes                    |
| ------------------------------------------------------------------------------------------- | ---------------------------------- |
| BORROW-001, BORROW-002: shared and exclusive borrows, conflicts with live loans             | OWN0010, OWN0011, SEM0036, SEM0057 |
| BORROW-003, BORROW-007: a borrow preserves its owner; projections keep their access         | OWN0012, OWN0011, OWN0002          |
| BORROW-004, CALL-001: call arguments borrow for the whole call                              | OWN0010, OWN0011                   |
| BORROW-005: a reborrow suspends stronger parent access                                      | SEM0058 + loan conflict            |
| BORROW-008, VIEW-001, VIEW-002: values and returned views retain borrowed contents          | OWN0019, OWN0010, OWN0011          |
| LIFE-001, LIFE-002, LIFE-004, LIFE-005: lifetime parameters, outlives, invocation lifetimes | OWN0019, SEM0211, SEM0212, SEM0213 |
| CAPTURE-002, CALLABLE-003: captures borrow until last use or drop                           | OWN0011, OWN0001                   |
| EFFECT-OWN-002, STORAGE-001: run and invocation access through aggregates                   | OWN0014, OWN0015                   |
| Escaping callables and Effects that borrow a local                                          | OWN0018                            |
| SHARED-003: local-shared access is callback-scoped                                          | OWN0016                            |
| FLOW-001, LOOP-001, MATCH-002: on every reaching path, loop headers, match bindings         | OWN0001, OWN0005, OWN0006, OWN0008 |

### 1.2 The bootstrap checker

The bootstrap is the behavioral reference, not the architectural one.

- `Ownership.ts` checks moves, initialization and loans over typed TIR through the `LoanView`
  projection. `LifetimeFlow.ts` is the per-body region proof and the only source of OWN0019.
  `Lifetime.ts` holds the region terms (`Static | Bound | Local | Placeholder | Intersection`) and
  the solver.
- Regions are finite point sets over preorder authored anchors, plus one point per return or fail
  boundary. Outlives constraints are edges, optionally activated only at some points. Required
  points propagate by worklist. A violation is a required point the region cannot reach.
- A loan is live at an access when the access is reachable from the loan and precedes a required use
  of the holder (`LifetimeFlow.liveAt`). This is non-lexical. There are no two-phase borrows.
- Places are field-sensitive (`LoanReferent`: root binding plus field, index and slice-index path).
  An index without proven bounds overlaps every index.
- Loans have origins: value and fixed-array borrows, value and slice reborrows (which suspend the
  parent), Effect and callable captures, returned views and interface operands.
- Generic bodies are checked once per source declaration (`Ownership.checkModule`). Each prepared
  instance then goes through `ResidualOwnership.check`, which reuses the source proof unless the
  instance's body changed by static selection (`SelectedStaticBody`), and checks the selected body
  otherwise.

### 1.3 What the native compiler already has

- Typing records loans as `TypedBody` nodes and retains `SafetyObligation`s (`Contents`,
  `WholeValue`, `Invocation`, `CallableInvocation`, `ReceiverPass`, `RegionRelation`) on every
  `ContractTyped` body. A body is `ContractTyped` when it is abstract, has loans, has a receiver pass
  or retains a region relation. `RegionRelation` is exactly the caller-local relation typing could
  not prove: the borrow stage must discharge it.
- `TypedBody.borrowStatus()` is always `BorrowStatus.NotChecked`. Its doc already says only the
  native borrow stage may upgrade it.
- `Lifetime` has `Static`, `Parameter`, `Local`, `Invocation`, `Meet` and `Supplied`. `Local` is
  documented as "a borrow region rooted at a source expression, retained until the abstract borrow
  checker runs".
- Move-side rules already reject natively with bootstrap-equivalent codes: `UseAfterMove`
  (OWN0001), `ExtractionBoundary` (OWN0002), `ExplicitMoveRequired` (OWN0003),
  `OverlappingAssignment` (OWN0004), `IncompatibleLoopHeader` (OWN0005), `MatchBorrowEscape`
  (OWN0006), `GuardConsumesPattern` (OWN0008), `InvalidMatchScrutineePlace` (OWN0009),
  `BorrowedExtraction` (OWN0012), `ExclusiveBorrowRequiresMutable` (SEM0057) and
  `UnsatisfiedLifetimeBound` (SEM0212). `CaptureAvailability` is a control-flow proof for captured
  places.
- Region escapes are reported as `TypeMismatch` where the bootstrap reports OWN0019 (a #567 known
  gap). The borrow stage owns that fix.
- The miss that matters in practice: the native compiler accepts loan conflicts. The stdlib once
  needed a fix for OWN0011 that only the bootstrap caught (PAPERCUTS, 2026-10-11).

## 2. Which bodies are checked

A **checking unit** is one body as typing proves it, identified by its `Body` query key.

| Body                                      | Unit                                      | Checked                       |
| ----------------------------------------- | ----------------------------------------- | ----------------------------- |
| Non-generic ordinary function             | `Body{declaration, member: 0}`            | once                          |
| Generic ordinary function                 | `Body{declaration, member: 0}`, abstract  | once, with symbolic `T`, `'a` |
| Function with static selection            | `Body{declaration, member: selected + 1}` | once per interned selection   |
| Type-dependent static condition           | the selected application's body, as above | once per selection            |
| Inactive static arm                       | none (never lowered)                      | never                         |
| Monomorphic instance of a checked unit    | none; it inherits its unit's answer       | never                         |
| Drop glue and other compiler-built bodies | none; built from checked glue recipes     | marked checked, as today      |

This is the settled decision ("ordinary generic bodies are checked abstractly once; static-selected
bodies are checked per selection, including type-specific selections when a static condition reads
generic types"). A non-generic body is simply the case of an abstract body with no parameters, so
it needs no separate path.

**Why instances need no re-check.** Region-sensitive identity already establishes that a body's
generic bounds (`'b: 'a`, `T: 'a`) are premises proved against its own parameters, that caller
regions reach an instance only as a numbering (`Lifetime.Supplied`), and that relations between
distinct caller-local regions are obligations of the caller's body, proved before the call is
selected. A loan conflict depends on the body's places and control flow, which substitution does
not change. A static selection that changes the body produces a new selection key, which is its own
unit. A region-sensitive application selects different callees by region pattern, but each callee
is checked against its own contract, and the caller's arguments are checked against the selected
callee's signature in the caller's unit.

**Interaction with `needsStaticResidualization`.** Today `lowerMir` derives the selected body key
from `InstanceKey.selected` and `internSelectedApplication`. The checking unit must use the same
interned selection, so that each emitted instance maps to exactly one unit and the count in §6 is
exact.

## 3. Checking MIR

Borrow checking reads MIR, not `TypedBody`, as #567 and the MIR note settle. MIR already has place
operands, explicit `Ref` and `AddressOf` rvalues, origins on every statement and terminator, and
symbolic lifetimes in local types. The checking variant adds the following, each as a new variant
or side table, never as a second lowering pipeline.

1. **`InstanceKey.Abstract(declaration, selection)`.** This selects checking MIR for one unit. It
   is lowered by the same `lowerMir` with generic parameters left symbolic. Types stay layout-free
   (MIR has no layout), and an abstract `T` is treated as affine (GENERIC-001). A drop of an
   abstract `T` is a `Drop` with abstract glue. It is never emitted, and the backend rejects an
   `Abstract` key.
2. **`Callee.Bound(operation, provider)`.** A call through a declared bound or interface operation
   whose implementation is not chosen in the abstract body. The checker reads only its signature.
3. **`StorageLive` and `StorageDead`.** These come from the Step 6 scope stack, for every local
   that can be borrowed, not only owned ones. `StorageDead` kills loans of that local and makes
   any later use of a region that contains one of its loans a violation (OWN0019 for escapes).
4. **Region side table.** It is keyed by local and loan location (block, statement) and maps:
   - each reference-typed local's symbolic lifetimes to region variables;
   - each `Ref`/`AddressOf` to a loan `{place, access, region, origin}`;
   - each typing `RegionRelation` obligation to an outlives constraint at its origin.
     It is a side table, so emission MIR does not grow.
5. **Explicit loans for non-`Ref` borrows.** Capture environments, Effect environments, provider
   bindings (`bindRequirement*`, `provideMut`), call-argument borrows and returned views lower to
   the same loan record, so the checker has one rule for all of them. This matches the bootstrap's
   `LoanFact` origins one to one.
6. **Reborrow parent link.** A loan whose place goes through `Deref` of a reference local records
   the loan it derives from. The parent is suspended while the child is live (BORROW-005), and
   siblings still conflict.

Emission MIR stays as it is. The checking unit and the emission instance share `lowerMir`, so a
body cannot be checked in one shape and emitted in another.

## 4. Regions, loans and liveness

### 4.1 Region terms

Region variables live only in the side table. Each is one of:

- a **universal** region: `'static`, a lifetime parameter, an invocation lifetime (`for<'call>`),
  or the retained environment region `fn<'env>`. It holds every point of the body plus its exit
  ("end of caller");
- a **local** region: one per `Lifetime.Local` and per loan. The solver sizes it to the points
  where it is required.

Declared outlives bounds and `where` premises become assumptions between universal regions. They
are given, not proved, in the body itself (LIFE-002).

### 4.2 Points

Points are MIR locations (block, statement index), plus one exit point per `Return` and `Fail`.
The bootstrap uses authored anchors instead. MIR locations are finer, and each carries the origin
the diagnostic needs. Parity is defined on reported code and span, not on internal points (§7).

### 4.3 Solving

Solving uses the bootstrap's algorithm on the new domain:

- outlives edges `shorter → longer`, optionally activated only at the points where the constraint
  holds (location-sensitive);
- a worklist that propagates required points;
- a violation where a required point is outside the region's available points.

A region becomes unavailable at points after its owner's `StorageDead`, and after a write or move
that invalidates an overlapping place. A violation is OWN0019 at the use's origin. Point sets are
bitsets over the body's location count.

### 4.4 Liveness and conflicts

Loan liveness is a backward dataflow over the CFG, normal and failure edges alike: a loan is live at
a location if a use of its region is reachable from there before the loan is killed. At every
access, the checker compares the accessed place against live loans with the bootstrap's overlap rule
(field paths compare, unproven indices overlap everything):

| Access                 | Live shared loan | Live exclusive loan |
| ---------------------- | ---------------- | ------------------- |
| shared borrow          | allowed          | OWN0010             |
| exclusive borrow       | OWN0010          | OWN0010             |
| read through owner     | allowed          | OWN0011             |
| write or move of owner | OWN0011          | OWN0011             |

Call arguments are live for the whole call, through its failure edge (BORROW-004). Capture loans
are live until the callable's or Effect's last use or drop (CALLABLE-003). A provider loan is live
until the provided Effect completes. There are no two-phase borrows, as in the bootstrap.

### 4.5 Captures, Effects and local sharing

- Capture loans are created at construction (CAPTURE-001, EFFECT-OWN-001) and recorded on the
  environment local.
- A returned callable or Effect whose region contains a loan of a local is OWN0018.
- A run or invocation through an aggregate place weaker than the environment's access is OWN0015 or
  OWN0014, checked at the `Call` that runs it.
- A local-shared access callback gets a region bounded by the access call. A loan into the shared
  contents that outlives it is OWN0016.
- OWN0020 (ownership across suspension) is out of scope until suspension MIR exists (MIR note §6),
  and is reported as a named gap if reached.

## 5. Place in the query graph

A new family, `BorrowCheck`, takes the same `{module, declaration, member}` key as the `Body` it
proves.

- **Demands:** `Body` (its typed answer and obligations), `Mir` for `InstanceKey.Abstract` of that
  unit, and `Signature` of each callee and bound operation it calls. It never demands a callee's
  `Body`, `BorrowCheck` or `Mir`. That keeps the G3 to G5 rule (callers depend only on callee
  signatures and identities).
- **Answer:** `Checked`, or `Rejected{first, further}` with the same `Rejection` records typing
  uses, or `NotChecked{reason}` for a form the checker does not handle yet (§6). The answer is
  small and content-compared, so an unchanged answer cuts off downstream re-execution.
- **Who demands it:** `buildRuntime`, for the unit of every emitted instance, deduplicated by key.
  `MirFunction.safetyChecked` and `InstanceRecipe.safetyChecked` then come from the `BorrowCheck`
  answer instead of `BodyStage.FullyChecked`. A rejection joins `BackendBuild.Rejected` exactly as
  typing rejections do.
- **Incremental behavior:**
  - editing a body re-runs its `Body`, its checking `Mir` and its `BorrowCheck`;
  - editing a signature re-runs the `BorrowCheck` of its callers, through the signature dependency;
  - nothing else re-runs.
    Checking MIR is a separate key from emission MIR, so emission does not wait for checking or depend
    on it.
- **`borrowStatus()`** becomes a read of the `BorrowCheck` answer. The `BorrowStatus` enum gains
  `Checked`, and `NotChecked` keeps its reason.

## 6. Counting unchecked bodies until it lands

The current rule stays: `SILK_GAP borrow-check: N bodies not borrow-checked`, where N counts emitted
definitions whose unit is not `Checked`. On the self-build that is 18,009 today. During the rollout:

- `NotChecked` carries a reason: `awaiting` (no checker yet for this unit) or a named unsupported
  form (`captures`, `effects`, `abstract-generic`, `selected-static`, `local-shared`,
  `suspension`). The CLI prints the total and a per-reason breakdown, and the corpus runner records
  both, so each slice shows which bodies it moved.
- A unit is `Checked` only when every loan, region and obligation in it was proved. A slice that
  meets an unsupported form answers `NotChecked{form}`. It never answers `Checked` and skips the
  form.
- CI keeps the count visible. It must not grow on a PR without a stated reason, and it must reach
  zero on the self-build before the TypeScript compiler is deleted. At zero, the gap becomes a
  hard build error, and `borrow-check` leaves the gap catalog.

## 7. Diagnostic parity with the bootstrap

- **One `RejectionCode` per bootstrap code**, documented with the bootstrap code it mirrors, as the
  existing ownership codes are: `LoanConflict` (OWN0010), `AccessDuringLoan` (OWN0011),
  `StoredCallableAccess` (OWN0014), `StoredEffectAccess` (OWN0015), `SharedAccessEscape` (OWN0016),
  `CaptureEscape` (OWN0018) and `LifetimeInvalidAtUse` (OWN0019). The bootstrap's own wording and
  the generated diagnostic catalog stay authoritative for text.
- **Spans:** the primary span is the later conflicting access for OWN0010 and OWN0011, relating
  the earlier loan (BORROW-004), and the violating use for OWN0019, as in the bootstrap. MIR origins carry these spans already.
- **Parity is measured differentially**, on code, primary span and module, over the bootstrap's
  expected-diagnostic programs: the ownership and lifetime cases in `test/support/corpus.ts`, plus
  a new invalid-ownership set covering every code in §1.1. The selfhost runner has no
  expected-diagnostic mode today (`CorpusProgram.expected` is only `Completes` or `Trap`). Adding
  one changes guarded inputs (`runSelfhostCorpus.ts`, `corpus.ts`), so it lands on `main` first.
- **Where the reference and the bootstrap disagree**, the reference wins (it is prescriptive over
  both compilers). The bootstrap gets a `main` fix in the same slice. A difference is never added to
  `acceptedFailures`.
- **Positive parity:** the stdlib, the corpus and the compiler itself must pass the native checker
  with zero rejections, because they pass the bootstrap's.

## 8. Test strategy

Under the AGENTS.md cost rules:

- **Structural cases first.** Each rule gets source cases in an existing `Semantic*Cases` file
  (`SemanticCaptureCases` for captures, `BorrowFieldCases` for places). They build one analysis per
  source program and assert the `BorrowCheck` answer, rejection codes and spans with the existing
  `SemanticCaseSupport` helpers, never message text. A dedicated `BorrowCheckCases` root, as its own
  CI shard, is added only once the existing shards would exceed their time budget. Every test stays
  under 1 s, and the target is 500 ms.
- **The positive claim** ("this program is accepted and runs") goes in the shared native corpus,
  never in a per-feature native build.
- **Differential parity** is the corpus mode of §7. It is the only place both compilers run the
  same invalid programs.
- **Global canaries:** the self-build (N0 builds N1 with `borrow-check` at zero), and the N1/N2 IR
  fixpoint. Checking must not change emitted IR, so the fixpoint also proves the checker has no
  emission side effects.
- **No timing assertions** in the correctness suite. The cost budget (§9) is measured by the
  strict measurement receipt.

## 9. Cost budget for the self-build

Baseline: N0 builds N1 in about 384 s (Linux CI) or 348 s (macOS), of which about 290 s is the
front end. Peak RSS is 5.0 GiB on Linux. The self-build emits about 18,000 bodies. There are fewer
units than that, because instances share a unit.

Budget: the borrow stage, including checking MIR, adds at most **10% of front-end time (about 30 s)
and 0.5 GiB peak RSS** to the self-build. That is about 1.6 ms per emitted body on average, and more
per unit.

How it stays within budget:

- **Scalar fast path.** A unit with no loans, no reference-typed locals and no obligations (today's
  `FullyChecked`) answers `Checked` without lowering checking MIR.
- **Interned region and loan identities.** Regions, loans and places are ordinals within the unit.
  Nothing compares identities by bytes: the front-end profile attributes about 30% of self time to
  byte identity comparison, and the checker must not add to it.
- **Sparse dataflow.** Only locals that hold or are borrowed by a loan get liveness bitsets. Point
  sets are bitsets over the unit's location count.
- **Shared lowering.** For a non-generic unit, checking MIR and emission MIR come from the same
  lowering of the same typed body. A later optimization can share the answer when they coincide.
  The budget does not assume it.
- **Per-slice measurement.** Each slice records the borrow stage's time and RSS on the self-build
  in its PR. A slice that exceeds its share of the budget is fixed before the next one lands.

## 10. Implementation plan

Each slice is one reviewable PR on `selfhost` (guarded inputs go to `main` first), keeps the
self-build green, and leaves the unchecked count no higher than before.

1. **Plumbing and counting.**
   - Add the `BorrowCheck` family answering `NotChecked{awaiting}` for every unit.
   - Make `safetyChecked` read it, and add the per-reason breakdown to `SILK_GAP borrow-check`.
   - No behavior change; the count is unchanged.
2. **Checking MIR for non-generic units.**
   - Add `InstanceKey.Abstract` for units without parameters or selections, `StorageLive`/
     `StorageDead`, the region side table and explicit loans for `Ref`/`AddressOf`.
   - Extend the opt-in MIR check to validate markers and side-table consistency.
3. **Loans and conflicts** (OWN0010, OWN0011, BORROW-001 to BORROW-005, BORROW-007).
   - Non-generic units without captures, Effects or local sharing become `Checked`.
   - The scalar fast path lands here.
4. **Regions and OWN0019.**
   - Add universal regions, outlives assumptions, and discharge of `RegionRelation` and `Contents`
     obligations.
   - Delete the `TypeMismatch` stand-in for region escapes.
5. **Abstract generic units.** `Callee.Bound`, symbolic types, abstract drops.
6. **Selected static units**, per interned selection, including type-specific ones.
7. **Captures, callables, Effects and providers** (OWN0014, OWN0015, OWN0018, CALLABLE-003,
   EFFECT-OWN-002, provider loans).
8. **Local sharing** (OWN0016). Suspension stays a named reason until suspension MIR lands.
9. **Parity and closure.**
   - Expected-diagnostic corpus mode (`main` first), the invalid-ownership set, zero unchecked on
     the self-build.
   - The gap becomes an error.
   - Retire `BorrowStatus.NotChecked` and the `borrow-check` gap code.

Slices 5 to 8 are independent once slice 4 lands, and can run in parallel lanes.

## 11. Open questions for Julia

1. **Unit of checking IR.** #567 and the MIR note settle on MIR. The largest new piece is
   `Mir(Abstract)` for generic bodies, meaning MIR with symbolic types, bound calls and abstract
   drops. The bootstrap checks typed TIR instead. Is MIR still the choice, given that cost? This
   note assumes yes.
2. **Span parity.** Is code plus primary-span parity on the differential corpus the right bar? Or
   is code parity enough, with spans checked against the reference where the two compilers anchor
   differently?
3. **Two-phase borrows.** The bootstrap has none, and BORROW-004 says a later argument cannot
   access an owner an earlier argument borrowed exclusively, so `Vector.append(&mut v, f(&v))` is
   rejected. This note keeps that. Confirm that no two-phase relaxation is planned.
4. **One owner for move rules.** The native move-side checks live in typing and
   `CaptureAvailability`. Green-field suggests moving them into the borrow stage over MIR in a late
   slice, so one stage owns ownership. Or should they stay in typing?
5. **OWN0017 and OWN0020.** OWN0017 has no bootstrap call site. Should it be dropped from the
   catalog? Is OWN0020 in scope for step 14, or deferred with suspension MIR?
6. **When the gap becomes an error.** This note proposes making it an error only at zero on the
   self-build (slice 9). Should CI instead fail on any increase from earlier slices?
7. **Diagnostic spelling.** Should the native CLI print bootstrap codes (`OWN0011`) instead of, or
   next to, `RejectionCode` names, so the generated catalog covers both compilers?
8. **Region-sensitive applications.** This note argues that no instance is re-checked (§2). Is that
   argument accepted, or should region-sensitive instances be re-checked defensively until it is
   proved by a test?
