# Native borrow checking

Roadmap step 14 (#567, "Implement native borrow checking, then remove TypeScript"). Slices 1, 2 and 7
have landed and slice 6's `captures`, `effects` and `patterns` reasons are retired; slice 3 is partial
(regions remain for R3) and slice 8 has not started. `compiler/borrow-check-gap.txt` is the current
per-program record of unchecked bodies. It relies on [`region-erased-identity.md`](region-erased-identity.md) and
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
  (OWN0006), `ExclusiveMatchRequiresMutable` (OWN0007), `GuardConsumesPattern` (OWN0008),
  `InvalidMatchScrutineePlace` (OWN0009),
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

Region closure (§6) accepts the universal regions of enclosing declarations as atoms; it never
relates them to each other. A relation that names an enclosing declaration's parameter, an
invocation binder or an enclosing body's local stays pending.

The R3 2a premise check runs inside the body query. It checks retained relations made solely
of `'static` and that named body's declared lifetime atoms against `BodyPremises`, including
input well-formedness edges. Goals never become premises. A rigid relation absent from that
closure is `UnsatisfiedLifetimeBound` (SEM0212) at the retained origin; local, invocation,
supplied, and outside-owner atoms remain pending. An anonymous body's enclosing atoms retain
their identity and are left for the environment proof. Open capture contents still prevent
`Checked`. This is groundwork, with no promised gap-count reduction.

An inferred binder initially holding `'static` is not a declared static requirement. Retained
relations record that provisional origin explicitly and remain pending. Inference behavior is
unchanged; a provisional static relation must not cause SEM0212 or become a declared premise.

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

The R3 2b worklist uses these same Walker points and successor edges. A local term must map to
one exact loan; its required set includes the walk's in-flight intervals and live holder points.
Availability excludes paths before creation and after overlapping End, Expire, write, move or drop
events, restarting at creation on a loop back edge. Own declared parameters and `'static` are
available throughout this body. Required bitsets propagate from shorter to longer to a fixed point.

This first point proof uses conservative sets: numeric interval interiors may require extra
points, and retained edges stay active throughout the body. Inclusion still proves the original
relation; failed inclusion remains pending until location-sensitive requirements resolve it.
The existing exact End/access walk retains OWN0019 and conflict diagnostics. Missing or ambiguous
loan mappings, approximate loans, meets, provisional static inference, outside-owner atoms,
crossed referent loans and Contents are not promoted to Checked. The shared parameter-to-local
reborrow floor is the first target; no callee body's stage or MIR participates in its proof.

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
- A local-shared access callback gets a region bounded by the access call; a loan into the shared
  contents cannot outlive it, which typing already enforces on the callback's result.
- OWN0016 (SHARED-003) is not part of the per-body verdict. Whether an access escapes depends on
  every function its callback reaches, which a body's checking unit never reads. The build enforces
  it once over the reached instances, in the same pass that rejects suspending foreign callbacks,
  before any code is emitted. Each held access walks its callback's call graph; every `run` outside
  an Effect block and every execution readiness notification it reaches is reported at its own span
  and module, related to the call where the callback entered its access wrappers, once per pair.
  Both code-producing entries, `silk build` and `silk test`, build through that pass. A body's
  `Checked` verdict therefore covers loans and regions only.
- Only reached accesses are judged. An access in a declaration no root reaches is judged once the
  native compiler checks every loaded declaration (MODULE-004), and that work must include this
  pass.
- Ownership across suspension needs no rule of its own (SUSP-011, SUSP-013). A suspending `run`
  is a call in the walk, so a loan or a partial move live across it reports the ordinary codes,
  as the bootstrap does. OWN0020 is retired: suspension planner invariants are compiler bugs in
  both compilers. Natively, a frame that cannot store a drop flag live at a suspension point,
  reads a drop flag before any edge assigns it, or has a suspension point without a cancel exit
  is an internal compiler error in `Coroutine`, never a user diagnostic.

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
- **Who reads it.** `buildArtifact`, for the unit of every emitted instance, deduplicated by key.
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
  exclusive views included, are proved, but the body is not region-closed (below), or retains a
  region relation or capture contents; later slices prove those.
- Storage operations have no reason of their own. `replace` is checked as a write to its place
  operand that yields the displaced value. Immediate `executionDrive`, `executionNotify`,
  `executionCurrent`, `relinquish` and `slotAddress`, together with the other supported storage
  operations, are calls to their catalog contracts. `slotAddress` consumes its slot, and its
  `*mut T` result names no region, so the address holds no loan, as in the bootstrap: it keeps no
  storage alive, and every access through it is `unsafe` and proves its own validity.
  `executionFromAllocation` is one too: it consumes its allocation, body, readiness state and
  endpoint, and typing proves the last three `Intrinsic.Detached` at the call (EXEC-004, SEM0139),
  so the package retains no loan of its constructor beyond what its `Intrinsic.Execution<A>`
  result names. The proof uses the calling body's premises, as `Execution.make` declares them;
  the bootstrap checks the same property on each reached instance instead. An immediate
  drive keeps every operand and callback capture loan alive through its S2 call point; current and
  relinquish have no operand loans. Each such contract names the operand region every result view
  reaches (a raw-buffer view or slot carries its buffer
  reference's region, a string view its text's region), and `unsafe` discharges only the
  operation's memory obligations, never its aliasing.

  `sharedWithMut` consumes both take-once callbacks and holds their capture loans through the
  invocation. Its exclusive value reference comes from the SHARED-004 runtime conflict check,
  and its callback contract prevents retaining that reference in the result. Independently of a
  calling body's `Checked` status, `Semantic.buildFrom` checks every reached access callback and
  its callees for suspension and readiness-notification escapes before emitting code (OWN0016,
  SHARED-003).
- `stored-loans`: a stored or delayed `executionDrive` construction retains captures its empty
  native environment does not describe, so it stays unchecked even when its result type names no
  environment region; lowering runs only an immediate drive, so no emitted body has one. Other
  cases include a loan carried around a loop, a retaining write through a referent, a retaining
  value displaced out of a local holder, a move or drop of a place with no local root, and cleanup
  with unknown retained contents. A retaining value displaced from behind a reference carries
  what that reference reaches, as a read through it does.

  A borrow of a value with no place (a call result, a literal, a projection or dereference of
  one, or a temporary receiver) lends that value's hidden owner (BORROW-006). The walk evaluates
  the value into a root of its own, which holds the value's loans and observes its cleanup like a
  local, and ends it where lowering drops it: with the innermost statement or match arm that
  evaluates it, or with the `if` or `while` condition, guard or `&&`/`||` right operand that does.
  A view of a temporary used past its statement, such as `let left = make().left()` followed by
  `left.*`, is OWN0019 at the use (CALL-003), where the bootstrap reports it. Lowering keeps every
  temporary of the initializer of a binding whose type can hold a view (`Type.holdsView`) for the
  binding's scope, so their storage and cleanup end there, and likewise for the subject of a
  borrowing destructuring `let` and, since it may view at an instance, a binding typed by a type
  parameter. Only a viewing binding's borrowed fixed array stays valid that long, so `let view =
  identity(&[1, 2])` is valid; any other such temporary's loans expire with its statement (an
  `Expire` event, which ends validity without ending storage).
- `imprecise`: a conflict or a moved-place use is decided only by an unknown index, a partial
  replacement, a loan a retaining result carries approximately, or a move of a reference whose
  referent is reborrowed. It is an unchecked status: such a body is never `FullyChecked`, counts
  in the baseline like any other reason, and a rise in it fails the corpus guard like a rise in any
  reason. Not rejecting a body never means accepting it as checked.

A slice that meets an unsupported form answers that reason. It never answers `Checked` and skips
the form.

A call result keeps the loans its instantiated regions can hold, so the walk trusts each callee's
signature, written or elided, exactly as typing does. A body is therefore checked modulo its
callees' contracts: the program-level guarantee needs every body checked, which is what the gap
count tracks, and a callee that still leaves with `regions` is where a contract violation could
hide until the regions slice proves it.

- When every result region is a lifetime parameter of the checked declaration, or the result is
  one of its type parameters, a loan of a body local, or with a body region, is not retained: such
  a region cannot outlive what the caller chose, typing already rejects a body-local borrow given a
  caller's region or type, and safe code obtains a type parameter's value only as such a value.
- When exactly one operand's loans name a result region, the result retains them exactly.
- A loan whose regions are all body regions is not retained by a call to a declaration or interface
  operation when none of its regions can outlive a result region. Typing relates two body regions
  only by equality or a meet, which share an atom, or by a region relation it leaves open. So the
  callee can reach a result region only through those relations, taken as premises (offered
  outlives wanted), and the outlives facts its argument and result types imply: a reference's or
  slice's referent outlives its region, and a nominal's arguments may outlive one another. If
  those facts lead a loan region to a result region, or to a region from outside the body, the
  loan stays carried, approximately. A body that retains capture contents keeps every such loan.
  `stream.take()` returning `Option<&'data A>` therefore releases its `&'call mut` receiver loan,
  while `unshelve(&shelf)` returning `&'a Token` from `&'a Shelf<'b>` keeps the shelf's `'b`
  contents loan, since `'b` outlives `'a`.
- Otherwise each loan is carried approximately: every fresh borrow of one call shares the call's
  region, so several operands may name it, and a callable retains its capture loans whatever its
  type names.

CI holds the count in two ways. Both read `compiler/borrow-check-gap.txt`, which has one line per
corpus program, `<program> <reason>=<count> ...` (a bare name when nothing is unchecked), and one
`retired` line.

- The selfhost corpus job compares each program's per-reason gap (the runner's `SELFHOST_BORROW_GAP`
  receipts) with its line and fails on any difference, a fall as well as a rise, so a line never
  goes stale and a later rise cannot hide under an old high count. A program that ran without a line
  also fails. A line whose program did not run is only a notice: the job runs main's published
  corpus, so a selfhost PR can declare a new program's line before main's bundle carries the
  program. `update` writes a line for every program that ran and keeps, listing them as "not run",
  the lines of programs that did not; `update --prune` drops those instead, for programs the corpus
  no longer has. A PR that changes checking or the corpus reruns `node
  .github/scripts/check-borrow-gap.mjs update <corpus log>`, the file's only writer, and `diff <old>
  <new>` prints the per-program transition table for its description. The corpus job builds its
  programs from main's verification harness, which can differ from a local run on this branch's
  `corpus.ts`; the file must match CI, so when they disagree, run `update` on the job's
  `selfhost-corpus-timings` artifact or its log. Lines are independent and git merges the file with
  `merge=union`; two branches that changed the same program leave two lines for it, which fail until
  `update` reruns.
- A reason that a slice retires is listed on the `retired` line and must be zero everywhere. The
  corpus job and the N2 self-build step both fail if a retired reason reappears. The self-build
  totals grow with the compiler, so they are printed as a receipt and never recorded.

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

`effects` is retired. A `run` reaches its operand as `RunAccess` records it. An immediate run of an
`effect fn` call, an `effect fn` interface operation call or an `effect fn` value's invocation is
that one call (EFF-003): the Effect it constructs is a temporary only the run consumes, so its
operands are the call's arguments. Invoking an `effect fn` value without `run` constructs an Effect
that owns a `once fn` callee and borrows any other callee place, shared or exclusive, with the
callee's own loans, until the Effect's last run or drop (EFFECT-OWN-001). A run of a stored Effect
invokes it with the access its contract grants: a shared Effect is read, a `mut Effect` place is
borrowed exclusively, and a `once Effect` is moved, so the loans its environment holds stay live
through the run (EFFECT-OWN-002, CALLABLE-003).

A body the walk clears is `Checked` when it is region-closed and typing left nothing pending. It is
region-closed when every region its locals and values name is `'static`, a loan region of the
body itself, or a universal region chosen before the body runs: a lifetime parameter of its own
declaration or of a named declaration enclosing it (an impl's parameters in a method, an enclosing
function's in an anonymous body), or an anonymous body's invocation binder. Inside an anonymous
body, a loan region of the enclosing named body is a capture dependency: the enclosing body bounds its
formation and retention with its own points, and the nested body proves only its own uses. A
callable value's type also names its contract's binders (invocation binders, and a nested literal's
own parameters); each invocation instantiates them afresh, so they name no region of a value the
body holds. An enclosing literal's own binders and locals, supplied atoms and meets are not closed. No loan of the body has a universal region, and
typing defers every relation that would make a body loan outlive one as a pending region
obligation, so a body with nothing pending relies on none. A call result keeps an operand's region only by naming it, and conformance holds an
interface witness to exactly the regions its operation names, so a result typed by an open
parameter keeps no loan of the body. Such a body's
loans and their scopes are its whole region proof, because no loan of a cleared body outlives its
root's scope:

- A loan lives past the expression that creates it only through a `let` holder. Every binding has
  an initializer, so the holder is bound after its root, in the same scope or a nested one, and is
  released no later than its root; releases run in reverse declaration order, so a holder whose
  cleanup observes the loan is released first (LIFE-005).
- Every value that would carry a loan of a body local across a scope boundary leaves the walk with
  `stored-loans`: a block, branch or arm result, a subject that carries a loan, a return, an
  assignment and a `let mut` holder. A referent loan (storage behind a reference, which the body
  does not own) may cross a join, a `let mut` holder, a replacement or a return; such a body is
  marked crossed and is never `Checked`, because its region relations are the region slices' to
  prove.
- A borrow whose place has no local root, such as `&make()`, `&Pair {..}.first`, a borrowed array
  literal or a temporary receiver, borrows a hidden owner the walk roots at the borrowed value. It
  is released with its statement or arm, or with the binding's scope for an array kept by a
  viewing binding, and that release is an ordinary storage end: a holder that still requires its
  loan afterwards is OWN0019 at that use.

Pending means a region relation or capture contents typing retained. `Checked` is a claim about
one body: its own loans and regions are sound. A rule that blames a body for its callers' context
is not part of that claim. OWN0016 (SHARED-003) blames a suspending callee reached under a
local-shared access, such as a value-free `fn parks()` that runs `Execution.park`. Such a callee
and its boundary caller, which takes the access's `&mut T` parameter region, can each be `Checked`;
the build-time OWN0016 pass (§4.5) rejects the program, so no violating program is ever accepted.
Scope ends as events,
OWN0019 and the `run` failure edge arrive with the slice that lifts the `stored-loans` exits above,
the first point at which a loan can outlive its root.

The count must reach zero on the self-build before the TypeScript compiler is deleted. At zero,
the gap becomes a hard build error, and `borrow-check` leaves the gap catalog.

## 7. Diagnostic parity with the bootstrap

- **One `RejectionCode` per bootstrap code**, documented with the bootstrap code it mirrors, as the
  existing ownership codes are: `LoanConflict` (OWN0010), `AccessDuringLoan` (OWN0011),
  `StoredCallableAccess` (OWN0014), `StoredEffectAccess` (OWN0015), `LocalSharedAccessEscape`
  (OWN0016), `CaptureEscape` (OWN0018) and `LifetimeInvalidAtUse` (OWN0019). The bootstrap's own
  wording and the generated diagnostic catalog stay authoritative for text. OWN0017 has no
  bootstrap call site and is dropped from the catalog (Q5).
- **Spelling.** During the transition the native CLI prints each native name together with its
  bootstrap code, for example `AccessDuringLoan (OWN0011)` (Q7).
- **Spans:** the primary span is the later conflicting access for OWN0010 and OWN0011, relating
  the earlier loan (BORROW-004), and the violating use for OWN0019, as in the bootstrap. Typed-node
  origins carry these spans already. Answers store them relative to the declaration (Q2).
- **Parity is measured differentially**, on code, primary span and module, over the bootstrap's
  expected-diagnostic programs: the ownership and lifetime cases of the acceptance corpus, plus
  a new invalid-ownership set covering every code in §1.1. The selfhost runner has no
  expected-diagnostic mode today (`CorpusProgram.expected` is only `Completes` or `Trap`). Adding
  one changes guarded inputs (`runSelfhostCorpus.ts`, `corpus.ts`), so it lands on `main` first.
- **Where the reference and the bootstrap disagree**, the reference wins (it is prescriptive over
  both compilers). The bootstrap gets a `main` fix in the same slice. The corpus job fails on any
  `FAIL`, so a difference is never tolerated as a corpus failure.
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

For R3, the approved remaining cumulative share is **3.28 s wall / 2.83 s user CPU / 0.486 GiB
peak RSS**. Compare at least five alternating clean/R3 pairs with the same producers, command,
source and one-shot LLVM-IR endpoint. Before each run, require one-minute load below 1 and no
other Node, Silk compiler or Clang process. Report every sample, the median of adjacent R3-minus-clean
differences, and the spread. The paired median is the gate, not maximum-minus-minimum. If clean
timings vary by more than about 5%, investigate cache, memory, thermal and background scheduling
effects before trusting a delta; VM host steal time can remain even when guest processes are idle.
If the median exceeds the cap, profile the slice before proposing a cost decision. Negative or
noisy timing does not increase the remaining share. A real overrun returns to Julia; the cap is fixed.

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
   - Region-closed bodies are `Checked` (§6), lifetime parameters of the body's own declaration
     included. Then invocation lifetimes and outlives assumptions, then region relations and
     returned regions.
   - With the slice that lifts the `stored-loans` exits for joins and assignments: scope-end storage
     ends as events at a match arm's end, a block's end and body exit, OWN0019 at the first required
     point outside the root's scope (a consuming arm yielding `&value` of its arm-local binding is
     rejected at the `match`), and the failure edge from each `run` to body exit, beside the one
     `fail` already takes, with a program whose failure path alone releases a root while a holder
     whose cleanup observes its loan is still live.
4. **Generic bodies**, checked abstractly in the same pass (§3, item 8). Type properties are read
   through the per-declaration summaries of v2 P5(a); this slice adds the summary for whatever it
   needs if v2 has not landed it yet.
5. **Selected static bodies**, per interned selection, including type-specific ones.
6. **Captures, callables, Effects and providers** (OWN0014, OWN0015, OWN0018, CALLABLE-003,
   EFFECT-OWN-002, provider loans).
7. **Local sharing** (OWN0016), enforced at build scope over the reached instances (§4.5), not in
   the per-body verdict.
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
2. **Span parity.** Code plus primary-span parity on the differential corpus. Accepted answers store
   positions relative to their declaration; rejections and gaps keep absolute spans and record a
   `DeclLocation` dependency (incremental v2 §3.5). Parity compares rendered spans.
3. **Two-phase borrows.** None. BORROW-004 stays as written: `Vector.append(&mut v, f(&v))` is
   rejected.
4. **One owner for move rules.** Move and initialization checks stay in typing; loan and region
   checks run after typing in the same `Body` unit. One unit and one key own both, so one body edit
   reruns both and nothing else.
5. **OWN0017 and OWN0020.** OWN0017 is dropped from the catalog; it has no bootstrap call site.
   OWN0020 is retired from both catalogs: ownership across suspension reports the ordinary codes,
   and a frame that cannot represent a live owner aborts as a compiler bug (§4.5).
6. **When the gap becomes an error.** CI fails on any increase of the unchecked count from the
   first slice; the gap becomes a hard error at zero on the self-build.
7. **Diagnostic spelling.** During the transition the native CLI prints native names together with
   bootstrap codes.
8. **Region-sensitive applications.** No instance is re-checked: instances are never checking
   units. P3 removed region-dependent sealed heads, so region-sensitive applications no longer
   exist.
