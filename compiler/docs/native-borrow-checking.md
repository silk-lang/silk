# Native borrow checking

Roadmap step 14 (#567, "Implement native borrow checking, then remove TypeScript"). Nothing here is
implemented yet. It relies on [`region-erased-identity.md`](region-erased-identity.md) and
follows [`incremental-architecture-v2.md`](incremental-architecture-v2.md) (§8.3, the
checking-unit rule).

**Status.** Revised after the joint review with the incremental architecture v2 note (#1433),
which Julia approved on 2026-10-11. Her decisions are recorded in §11:

- checking runs on the typed body inside the `Body` unit (option S1 of the v2 note), not on a
  separate checking MIR;
- no two-phase borrows; OWN0017 is dropped; native names are printed together with the bootstrap
  codes during the transition;
- the remaining questions take the answers the v2 note gave.

The first version of this note proposed a separate `BorrowCheck` family over a new
`Mir(Abstract)` lowering. That design is superseded and removed here.

## Summary

- The native compiler gets a borrow stage that proves the loan and lifetime rules of the reference
  (`ownership-and-borrowing.md`, `lifetimes.md`, `local-shared-ownership.md`) and reports the same
  diagnostics as the TypeScript bootstrap: OWN0010, OWN0011, OWN0012, OWN0014, OWN0015, OWN0016,
  OWN0018 and OWN0019, plus the move codes the native typing stage already reports.
- It runs on the **typed body**, inside the `Body` unit that produced it, after typing succeeds.
  One `Body` per ordinary body (generic or not) and one per static selection. Inactive static arms
  are never typed, so they are never checked. Monomorphic instances are not checked again.
- The checker builds a transient control-flow graph over the typed body's evaluation points,
  derives places and loans from typed nodes it already has (`Borrow`, receiver passes, call
  arguments, pattern bindings, captures), and solves regions as the bootstrap does
  (`Lifetime.solve`). Loan liveness is a backward dataflow over that graph. Nothing is retained
  after the check except its answer.
- The **checking unit** is the `Body` unit: keyed by declaration and selection, it reads only its
  own body, the signatures of its callees and bound operations, and type summaries. It never reads
  a callee's body, MIR or checking answer. An edit re-checks only the edited body and the callers
  of a changed signature or type summary.
- Until every body is checked, `SILK_GAP borrow-check` keeps counting unchecked emitted bodies, now
  split by reason, and the corpus job fails when any reason rises (§6). When the count reaches zero on the self-build and
  the parity corpus agrees with the bootstrap, the gap becomes a hard error and TypeScript can be
  deleted.

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
- Some move-side rules already reject natively with bootstrap-equivalent codes:
  `ExtractionBoundary` (OWN0002), `ExplicitMoveRequired` (OWN0003), `MatchBorrowEscape`
  (OWN0006), `GuardConsumesPattern` (OWN0008), `InvalidMatchScrutineePlace` (OWN0009),
  `BorrowedExtraction` (OWN0012), `ExclusiveBorrowRequiresMutable` (SEM0057) and
  `UnsatisfiedLifetimeBound` (SEM0212).
- `UseAfterMove` (OWN0001), `OverlappingAssignment` (OWN0004) and `IncompatibleLoopHeader`
  (OWN0005) come only from `CaptureAvailability`, so only a body with an anonymous-function
  capture gets them. The native compiler accepts a second move of an ordinary local. The borrow
  stage owns move flow for every body.
- Region escapes are reported as `TypeMismatch` where the bootstrap reports OWN0019 (a #567 known
  gap). The borrow stage owns that fix.
- `CaptureAvailability` already walks a typed body's control flow (blocks, branches, loops, `break`,
  `continue`, `return`, `fail`, match arms) with joined path states. The borrow stage reuses that
  walk shape for its own graph.
- The typed body is a structured tree (`TypedBody.silk:377-446`): `Block`, `Branch`, `While`,
  `Break`, `Continue`, `Return`, `Fail`, `Drop`, bindings and assignments, with expressions in
  evaluation order. Places are a root (`Local` or a matched `Subject`) plus `PlaceStep`s, and
  borrows are `Expression.Borrow{access, value}`. Anonymous functions are nested typed bodies
  (`Expression.Callable{body}`), checked inside their enclosing unit.
- The miss that matters in practice: the native compiler accepts loan conflicts. The stdlib once
  needed a fix for OWN0011 that only the bootstrap caught (PAPERCUTS, 2026-10-11).

## 2. Which bodies are checked

A **checking unit** is one body as typing proves it: the `Body` unit, keyed by declaration and
selection. Today that key is `Body{module, declaration, member}` with a declaration ordinal; once
v2 slice 0 lands it is `(DeclIndex, selection)`. The checker never introduces a key of its own.

| Body                                      | Unit                                      | Checked                       |
| ----------------------------------------- | ----------------------------------------- | ----------------------------- |
| Non-generic ordinary function             | `Body{declaration, member: 0}`            | once                          |
| Generic ordinary function                 | `Body{declaration, member: 0}`, abstract  | once, with symbolic `T`, `'a` |
| Function with static selection            | `Body{declaration, member: selected + 1}` | once per interned selection   |
| Type-dependent static condition           | the selected application's body, as above | once per selection            |
| Inactive static arm                       | none (never typed)                        | never                         |
| Monomorphic instance of a checked unit    | none; it inherits its unit's answer       | never                         |
| Drop glue and other compiler-built bodies | none; built from checked glue recipes     | marked checked, as today      |

This is the settled decision ("ordinary generic bodies are checked abstractly once; static-selected
bodies are checked per selection, including type-specific selections when a static condition reads
generic types"). A non-generic body is simply the case of an abstract body with no parameters, so
it needs no separate path.

**Why instances need no re-check.** Region-erased identity already establishes that a body's
generic bounds (`'b: 'a`, `T: 'a`) are premises proved against its own parameters, that caller
regions reach an instance only as a numbering (`Lifetime.Supplied`), and that relations between
distinct caller-local regions are obligations of the caller's body, proved before the call is
selected. A loan conflict depends on the body's places and control flow, which substitution does
not change. A static selection that changes the body produces a new selection key, which is its own
unit. Every region pattern of an application selects the same callees, each callee is checked
against its own contract, and the caller's arguments are checked against the selected callee's
signature in the caller's unit.

**Interaction with `needsStaticResidualization`.** Today `lowerMir` derives the selected body key
from `InstanceKey.selected` and `internSelectedApplication`. That key names the `Body` unit whose
checking answer covers the instance, so each emitted instance maps to exactly one unit and the
count in §6 is exact.

## 3. Checking the typed body

Borrow checking reads the `TypedBody`, the same representation the bootstrap checks (typed TIR,
§1.2). Emission MIR is unchanged and is never read by the checker. Everything below is built
inside the `Body` unit after typing succeeds, used, and dropped; only the answer is kept.

1. **Evaluation points.** Each typed node gets a point in evaluation order: operands before their
   operation, as `TypedBody` already orders them (aggregate fields, call arguments, `Index`
   subject before index, infix left before right). `Return` and `Fail` each add an exit point.
2. **Control-flow graph.** Edges follow the typed tree: `Block` in sequence, `Branch` to both arms
   and a join, `While` with its back edge, `Break` and `Continue` to their loop, `Return` and
   `Fail` to an exit, `Match` to each arm in order with guards before results. Every call and `run`
   whose callee can fail also has an edge to the failure exit, so loans live across a call are live
   on its failure path (BORROW-004). This is the walk `CaptureAvailability` already performs,
   recorded as a graph instead of folded into one state.
3. **Places.** A place is a root (`Local` or a matched `Subject`) and a path of `PlaceStep`s,
   extended through `Field`, `Index` and `Dereference` expressions. An index without a proven
   bound overlaps every index of the same root, as in the bootstrap.
4. **Loans.** One loan record `{place, access, region, origin}` for every way a body borrows:
   `Expression.Borrow`, `Shared` and `Mutable` receiver passes, call arguments for the duration of
   the call, `Shared` and `Exclusive` pattern bindings, captured places of `Callable` environments,
   Effect environments, and provider bindings. This matches the bootstrap's `LoanFact` origins one
   to one, so the checker has one rule for all of them.
5. **Storage ends.** A binding's storage ends at the exit of the `Block` that declares it, on every
   path out of the block, including `break`, `continue`, `return` and `fail` edges. `Drop`, `Move`
   and assignment of the whole owner also end its loans' validity.
6. **Reborrows.** A loan whose place goes through `Dereference` of a reference local records the
   loan it derives from. The parent is suspended while the child is live (BORROW-005), and siblings
   still conflict.
7. **Regions.** Each `Lifetime.Local` in a local's type and each loan gets a region variable. Each
   `RegionRelation` and `Contents` obligation (`TypedBody.silk:454-497`) becomes an outlives
   constraint at its origin.
8. **Generic bodies.** A generic body is already typed against its own parameters, so it is checked
   in the same pass: an abstract `T` is affine (GENERIC-001), a call through a declared bound is an
   interface operation node whose signature is known, and a drop of `T` is a drop with abstract
   glue. No symbolic lowering is needed.
9. **Selected static bodies.** `Body(D, s)` holds the selected typed body. It is checked like any
   other; inactive arms are absent.

_Rejected:_ a separate checking MIR (`Mir(Abstract)`, `Callee.Bound`, storage markers and a region
side table on MIR), the first version of this note. It costs a second lowering of every generic
body on every cold build, and incremental compilation does not need it (v2 note §8.3).

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

Points are the typed body's evaluation points (§3), plus one exit point per `Return` and `Fail`.
The bootstrap uses preorder authored anchors; evaluation points are at least as fine, and each
carries the origin the diagnostic needs. Parity is defined on reported code and span, not on
internal points (§7).

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

Loan liveness is a backward dataflow over the graph of §3, normal and failure edges alike: a loan is live at
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
- OWN0020 (ownership across suspension) is out of scope until suspension lowering exists
  (`mir-core-shape.md` §6), and is reported as a named gap if reached.

## 5. Place in the query graph

The checker is part of the `Body` unit, as the v2 note's checking-unit rule requires:

- **Key.** The `Body` key: declaration and selection.
- **Reads.** Its own typed body, `Signature` (in v2, `HeaderOf`) of each callee and bound
  operation, and type summaries: `Copy`, `Drop`, variance and generated field lifetimes, read
  through the per-declaration summary of v2 P5(a), never by walking field types. It never demands a
  callee's `Body`, MIR or checking answer. That keeps the G3 to G5 rule (callers depend only on
  callee signatures and identities).
- **Answer.** `Checked`, `Rejected{first, further}` with the same `Rejection` records typing uses,
  or a `BorrowStatus` reason for a form the checker does not handle yet (§6). Spans are relative to
  the declaration (v2 §3.5), so an edit elsewhere in the file never changes a cached answer. The
  answer is part of the `Body` result, compared by v2's cutoff (§6.3 there); only the build verdict
  reads it.
- **Who reads it.** `buildRuntime`, for the unit of every emitted instance, deduplicated by key.
  `MirFunction.safetyChecked` and `InstanceRecipe.safetyChecked` then come from the checking answer
  instead of `BodyStage.FullyChecked`. A rejection joins `BackendBuild.Rejected` exactly as typing
  rejections do.
- **Incremental behavior.** Editing a body reruns its `Body` unit, typing and checking together.
  Editing a signature reruns the `Body` units of its callers through the signature dependency.
  Editing a type reruns the units whose type summary changed. Nothing else reruns.
- **`borrowStatus()`** becomes a read of the checking answer. The `BorrowStatus` enum gains
  `Checked`, and `NotChecked` keeps its reason.

## 6. Counting unchecked bodies until it lands

`SILK_GAP borrow-check: N bodies not borrow-checked (reason n, ...)` counts emitted definitions
whose body is not `Checked`, with one count per reason. A body is `Checked` exactly when its stage
is `FullyChecked`. Every other body carries the `BorrowStatus` that names what a later slice must
cover first:

- `awaiting`: no checker covers the unit yet (selected static bodies, member bodies, and the
  compile-time prefixes static evaluation copies).
- `regions`: loans, explicit moves and by-value uses of affine values (OWN0003), forwarded
  exclusive views included, are proved; region and contents obligations wait for later slices.
- `effects`, `storage`: the body uses that form, which the loan and move walk does not enter
  yet.
- `stored-loans`: a loan is stored in a value, joined across paths, returned, or reached through a
  reference.
- `imprecise`: a conflict or a moved-place use is decided only by an unknown index or a partial
  replacement.

A slice that meets an unsupported form answers that reason. It never answers `Checked` and skips
the form.

CI holds the count in two ways. Both read `compiler/borrow-check-gap.json`.

- The selfhost corpus job sums each program's per-reason gap (the runner's `SELFHOST_BORROW_GAP`
  receipts) and fails when any reason rises above its baseline. The corpus is a fixed program set,
  so its counts change only when checking changes or a program is added. A PR that adds a corpus
  program, or a slice that checks more bodies, updates the baseline in the same diff.
- A reason that a slice retires is listed under `retired` and must be zero everywhere. The corpus
  job and the N2 self-build step both fail if a retired reason reappears. The self-build totals
  grow with the compiler, so they are printed as a receipt and never compared.

`captures` is retired. The walk checks callable construction, sections and invocation, and each
anonymous body is checked where it is built: a borrowed capture's loan begins at construction and
travels with the callable value, a moved capture leaves its place there, a shared invocation reads
its callee, a `mut fn` invocation borrows it exclusively for the call, and a `once fn` invocation
moves it (CAPTURE-001, CAPTURE-002, CALLABLE-002, CALLABLE-003). A callable value always carries
its capture loans, whatever regions its type names, and a `let` or `let mut` binding of a callable
holds them until its last use. A callable that carries a loan anywhere else answers `stored-loans`,
as any loan-carrying value does.

`patterns` is retired. The walk enters every match: the subject is accessed once as its form
declares, then the arms are tried in written order, each pattern before its guard and the guard
before its result, and every selected arm joins after the match (MATCH-001). A bare match reads the
subject, `match move` moves it, `match &` reads its place, `match &mut` updates it (a write that
replaces nothing), and `match place` inspects its tag, which conflicts with every loan but only a
move of the whole owner makes it a use after move. As in the bootstrap's loan pass, a borrowing
match holds no loan across its arms. A binding of `match place`, `&` or `&mut` is a projection of
the subject place, so a read, write, borrow or move of it is that access to the subject's part; a
copied or moved binding, or a binding of a subject with no place, is a projection of the subject's
own storage, bound at the match (MATCH-002). Whether a binding's view outlives a later access is the
region slice's to prove. A subject or arm result that carries a loan answers `stored-loans`, as a
branch does.

The count must reach zero on the self-build before the TypeScript compiler is deleted. At zero,
the gap becomes a hard build error, and `borrow-check` leaves the gap catalog.

## 7. Diagnostic parity with the bootstrap

- **One `RejectionCode` per bootstrap code**, documented with the bootstrap code it mirrors, as the
  existing ownership codes are: `LoanConflict` (OWN0010), `AccessDuringLoan` (OWN0011),
  `StoredCallableAccess` (OWN0014), `StoredEffectAccess` (OWN0015), `SharedAccessEscape` (OWN0016),
  `CaptureEscape` (OWN0018) and `LifetimeInvalidAtUse` (OWN0019). The bootstrap's own wording and
  the generated diagnostic catalog stay authoritative for text. OWN0017 has no bootstrap call site
  and is dropped from the catalog (Q5).
- **Spelling.** During the transition the native CLI prints each native name together with its
  bootstrap code, for example `AccessDuringLoan (OWN0011)` (Q7).
- **Spans:** the primary span is the later conflicting access for OWN0010 and OWN0011, relating
  the earlier loan (BORROW-004), and the violating use for OWN0019, as in the bootstrap. Typed-node
  origins carry these spans already. Answers store them relative to the declaration (Q2).
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
  source program and assert the `Body` checking answer, rejection codes and spans with the existing
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

Budget: the borrow stage adds at most **10% of front-end time (about 30 s) and 0.5 GiB peak RSS**
to the self-build. That is about 1.6 ms per emitted body on average, and more per unit.

How it stays within budget:

- **Scalar fast path.** A body with no loans, no reference-typed locals and no obligations (today's
  `FullyChecked`) answers `Checked` without building a graph.
- **No second lowering.** Checking reads the typed body that typing just built; generic bodies need
  no symbolic MIR.
- **Interned region and loan identities.** Regions, loans and places are ordinals within the body.
  Nothing compares identities by bytes: the front-end profile attributes about 30% of self time to
  byte identity comparison, and the checker must not add to it.
- **Sparse dataflow.** Only locals that hold or are borrowed by a loan get liveness bitsets. Point
  sets are bitsets over the body's evaluation points.
- **Measured with recording off.** Each slice records the borrow stage's time and RSS on the
  self-build in its PR, measured on a one-shot build, so the stage is not charged for revision
  bookkeeping that v2 removes. A slice that exceeds its share of the budget is fixed before the next
  one lands.

## 10. Implementation plan

Each slice is one reviewable PR on `selfhost` (guarded inputs go to `main` first), keeps the
self-build green, and never raises the unchecked count. The differential oracle is the
bootstrap's ownership checker on the corpus and the Cases roots: once a slice lands, a program the
bootstrap rejects for a rule that slice covers must not compile natively. A program the reference
rejects is never accepted.

1. **Loans and conflicts in plain bodies.** The smallest slice that rejects a real class of unsafe
   programs.
   - The checking answer inside the `Body` result, `borrowStatus()` reading it, the per-reason
     breakdown in `SILK_GAP borrow-check`, and the corpus guard of §6. These landed after the move
     flow of slice 2.
   - The evaluation graph, places and loans of §3 for non-generic, non-selected bodies without
     captures, Effects or local sharing, plus the scalar fast path.
   - OWN0010 and OWN0011 (BORROW-001 to BORROW-005, BORROW-007, CALL-001), with structured cases
     asserting codes and spans. Every other body answers `NotChecked{reason}`.
2. **Move flow** in every body the checker enters, abstract bodies included.
   - Forward reaching moves over the same graph, with bindings and covering replacements as
     reinitialization.
   - OWN0001 at a use of a moved place, OWN0004 at a replacement whose right-hand side moves out of
     its target, and OWN0005 at a loop that repeats with different moved places of its outer
     locals than it entered with.
3. **Regions and OWN0019.**
   - Universal regions, outlives assumptions, and discharge of `RegionRelation` and `Contents`
     obligations.
   - Delete the `TypeMismatch` stand-in for region escapes.
4. **Generic bodies**, checked abstractly in the same pass (§3, item 8). Type properties are read
   through the per-declaration summaries of v2 P5(a); this slice adds the summary for whatever it
   needs if v2 has not landed it yet.
5. **Selected static bodies**, per interned selection, including type-specific ones.
6. **Captures, callables, Effects and providers** (OWN0014, OWN0015, OWN0018, CALLABLE-003,
   EFFECT-OWN-002, provider loans).
7. **Local sharing** (OWN0016). Suspension stays a named reason until suspension lowering lands.
8. **Parity and closure.**
   - Expected-diagnostic corpus mode (`main` first), the invalid-ownership set, zero unchecked on
     the self-build.
   - The gap becomes an error.
   - Retire `BorrowStatus.NotChecked` and the `borrow-check` gap code.

Slices 4 to 7 are independent once slice 3 lands, and can run in parallel lanes. None depends on a
v2 slice: the checker uses today's `Body` key and the v2 slices attach their edges to it later.

## 11. Decisions

Julia decided the open questions in the joint review with #1433 (2026-10-11):

1. **Unit of checking IR.** The typed body, inside the `Body` unit (v2 option S1). No checking MIR.
2. **Span parity.** Code plus primary-span parity on the differential corpus. Answers store spans
   relative to their declaration, so parity compares rendered spans.
3. **Two-phase borrows.** None. BORROW-004 stays as written: `Vector.append(&mut v, f(&v))` is
   rejected.
4. **One owner for move rules.** Move and initialization checks stay in typing; loan and region
   checks run after typing in the same `Body` unit. One unit and one key own both, so one body edit
   reruns both and nothing else.
5. **OWN0017 and OWN0020.** OWN0017 is dropped from the catalog; it has no bootstrap call site.
   OWN0020 waits for suspension lowering and is a named gap until then.
6. **When the gap becomes an error.** CI fails on any increase of the unchecked count from the
   first slice; the gap becomes a hard error at zero on the self-build.
7. **Diagnostic spelling.** During the transition the native CLI prints native names together with
   bootstrap codes.
8. **Region-sensitive applications.** No instance is re-checked: instances are never checking
   units. P3 removed region-dependent sealed heads, so region-sensitive applications no longer
   exist.
