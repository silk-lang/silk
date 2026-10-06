# Selfhost MIR core shape

**Status:** decided; Julia's answers are in §12. Roadmap #567, Step 4. Measured against `selfhost` `1ecaca3d`.
It decides the final shape of `compiler/src/backend/Mir.silk` before Steps 6 (moves and cleanup),
8 (closures) and 9 (effects), the later suspension stage, and native borrow checking. The failure
edge and suspension shapes are agreed with the Step 5 Effect calling-convention note.

## Summary

MIR is a control-flow graph for one function instance. It is built from the checked `TypedBody`
and contains no byte offsets, backend types or LLVM concepts. Every value lives in a numbered local.
A block holds statements and ends in one terminator. Operands are places or constants, never
expression trees.

Cleanup is ordinary MIR: `Drop` statements on explicit edges, guarded by Boolean drop-flag locals
where ownership is conditional. A call has a success edge and, when its callee can fail, a failure
edge that names where the failure value goes. Suspension is a separate terminator that only
suspendable instances contain.

Each later stage adds a variant, a local kind, a side table or a pass. No stage changes an existing
form. The one exception is `Call.failure`, which has no producer today and gains its final type in
the first Step 9 PR (§11).

## 1. The shape

Entries wrapped in `**…**` are added by the step named beside them. Everything else exists today.

```text
MirFunction { key, safetyChecked, result, parameters, locals, blocks, references, externs }
Local       { ty: Shared<Type>, kind, origin }
LocalKind   = Return | Parameter(i) | User(i) | Temp
            | **Failure** (Step 9) | **Provider(i)** (Step 9) | **DropFlag(Place)** (Step 6)
            | **Observer | Cause** (failure observer, observing programs only)
Place       { local, projections }
Projection  = Field(i) | Payload(tag, ty) | VariantField(variant, field)
            | Index(local) | ConstIndex(n) | Deref
Operand     = Copy(Place) | Move(Place) | Integer | Float | Boolean | Unit | StaticBytes
            | **Null(ty)** (failure observer)
Rvalue      = Use | Unary | Binary | UnsignedWiden(Operand, integer Type) | Bitcast | Ref(access, Place) | AddressOf(access, Place)
            | Aggregate | Slice { data: Operand, count: Operand /* unsigned usize */ } | SliceLength
            | Discriminant | Inject | Variant
            | **FunctionAddress(InstanceKey) | ContextOf(Place)** (failure observer)
Statement   = Assign(Place, Rvalue) | Drop(Place, InstanceKey, diagnostics)
            | **FailureContext { destination, source: Option<Place>, origin }** (failure observer)
            | **StorageLive(local) | StorageDead(local)** (borrow stage)
Terminator  = Goto | Branch | Switch | Return | Trap | Unreachable
            | Call { callee, arguments, **providers**, **diagnostics: Option<{observer, cause}>**, destination, normal,
                     failure: Option<FailureEdge> }
            | **Fail** (Step 9)
            | **Suspend { callee, arguments, providers, destination, mode, resume, failure, cancel }**
            | **Abandon** (suspension stage)
FailureEdge = { destination: Place, target: Block }                       (Step 9)
Callee      = Instance(InstanceKey) | Extern(DeclarationId) | **Indirect(Operand)** (observer callbacks)
            | **Bound(operation, provider)** (abstract checking MIR only)
InstanceKey = Function (**+ providers**, Step 5/9) | Entry | **DropGlue(type)** (Step 6)
            | **Abstract(declaration)** (borrow stage; never emitted)
```

Every statement and terminator carries an `Origin` (HIR id plus span).

## 2. Places and types (question 1)

**Decision.** A place is a local plus a projection path. The projection kinds above are the closed
set: `Field` uses the semantic declaration-order field index; `Payload` selects a structural-union
member by canonical tag; `VariantField` selects a field of a nominal-union variant by declaration
tag; `Index` reads its index from a local; `ConstIndex` is a compile-time index; `Deref` goes
through a reference or raw pointer.

Local types are semantic `Type`s with the instance's bindings applied. Lifetimes are retained as
evidence, including in semantic instance keys, where caller regions are numbered canonically (below).
A projection's type comes from
its base type and the type's `MemberShape`. Only `Payload` carries its type, because the
structural-union member list would otherwise have to be renormalized at each use.

**Relation to Layout.** MIR states _which_ field, never _where_. Emission asks `Layout` for
offsets, tag encoding and ABI class. A Wasm backend would read the same MIR and `Layout`.

**Selected instance identity and LLVM answers.** `InstanceKey` retains the complete semantic
application and a canonical lifetime-erased runtime family. Semantic queries validate every
application; layout interning uses runtime type equality. Linkage symbols use the instance's
canonical content, including lifetime, static, enclosing-scope and provider evidence. Local borrow
regions in emission content are encoded as declaration-relative coordinates, so sibling-body HIR
renumbering cannot rename them. Originated context lookup uses local table ordinals, retaining only
the emitted diagnostic texts in the content subject. Definition, call,
function-address and drop references use that same body-independent identity; recursive and
mutually recursive instances require no body-derived SCC identity. Lifetime applications that
differ in `'static` or in region sharing remain distinct even when their current instructions
happen to agree. The C shim alone keeps `main`; full bytes distinguish genuine digest collisions
before assembly.

**Caller regions are numbered, not named.** A selected instance cannot observe which caller-local
region its caller lent. It observes only whether an input region is `'static` and which of its
inputs share a region: impl and cleanup selection match `'static` heads and repeated region
binders, and its proofs use only its own declared outlives bounds. Constructing an `InstanceKey`
therefore numbers every caller region of the application and its provider types by first
appearance (`Lifetime.Supplied`), in one walk over the operation contract and provider, own
arguments, enclosing scope arguments, then provider keys and types, including regions nested in
type arguments, callable environments and nested applications. A caller region is a `Local` borrow
region or the caller instance's own `Supplied` region. `'static`, declaration-owned parameters and
invocation binders keep their identities, and static values hold no caller region. The renaming is
injective, so `'static`-ness and region sharing are exact. `accepts(&first)` and
`accepts(&second)` share one instance, and every callee reached by forwarding a borrowed parameter
is lowered once per region pattern rather than once per call site. Inside an instance, `Supplied`
regions behave like caller-local regions: they are rigid, never `'static`, and never the instance
body's own loans. Requirement providers are matched against the call edge's actual application
(`CallTarget.application`) before the key numbers its regions, so a region shared between an
argument and a provider stays shared.

Source-dependent emission preparation is a query over the instance's MIR, its layouts, foreign
signatures and its callees' signatures and exact identities. It validates those facts before
interning a complete immutable content subject. Each LLVM definition is then a query answer over
that content: the instance's own selected instructions and all emission inputs, with recorded
MIR/layout/signature dependencies. Body edits can change the edited instance's text without
changing its symbol or its callers' content subjects; signature edits invalidate callers. Text
queries use the existing scoped publication rules and retain immutable completed answers.
Final assembly gathers these answers and their identity metadata, checks conflicts, and sorts
by symbol. It never rebuilds reached-graph identity or regenerates definitions outside queries.
Finite-closure evidence certifies complete lowered successors, not executable backend output;
LLVM-only restrictions remain gaps produced by the instance text query.

**Bounds checks are explicit.** `SliceLength` or the static array length, a compare, then `Branch`
to a `Trap` block. `Index` is therefore a plain address step. Arithmetic overflow and division
checks stay implicit in `Binary` (an rvalue may trap but never fails or suspends).

_Rejected:_ typed projections on every step (`Field(i, ty)`) make every producer compute types
twice for no consumer; byte-offset projections make MIR layout-dependent; a separate slice-element
projection duplicates `Index` + `Deref`.

## 3. Statements, terminators and failure edges (question 2)

**Decision: cleanup is explicit in the graph.** Lowering writes `Drop` statements on every exit
edge; there is no implicit unwinding and no landing pad.

- `Drop(place, glue)` drops one complete initialized value through the exact selected
  `DropGlue(type)` key retained in MIR; emission never reconstructs an erased callee name. Glue runs the
  `Drop` hook, then fields in declaration order, array elements in ascending order, or the active
  union payload only (CLEANUP-002). A partial parent is never passed to its glue: lowering expands
  it into drops of its remaining children.
- **Drop flags are ordinary `bool` locals** with kind `DropFlag(place)`. They are set by
  `Assign(flag, Use(Boolean))` after a transfer commits and read by `Branch` before a conditional
  drop. A place whose ownership state is the same on every path gets no flag.
- **Failure edge.** `Call.failure` is `Some` exactly when the callee's failure type is not `never`.
  The `FailureEdge.destination` has the _callee's_ failure type, which may be narrower than the
  caller's. Its target block widens the value into the `Failure` local (or into a handler's
  temporary), drops each exited scope innermost first, and ends in `Fail`. `fail value` is an
  `Assign` into `Failure`, the same drop chain, and `Fail`.
- `Trap` skips all cleanup (FAIL-007). Automatic `Drop` is infallible (DROP-002), so a drop chain
  has no failure edges.
- **Diagnostic context is an explicit statement.** FAIL-006 context records the authored `fail`
  origin and travels with the payload through edge conversion, catch residual re-injection and
  `ensuring` temporaries. `FailureContext { destination, source, origin }` originates context at
  `origin` when `source` is absent (emitted by `fail x` after `Assign(Failure, x)`), and carries it
  from failure slot `source` otherwise (emitted on every move or conversion between failure slots).
  Every failure slot has a fixed-size companion; a callee writes its edge destination's companion.
  The statements, the hidden observer and cause operands and the companions exist only in a program
  that observes diagnostics ([failure-observer-and-trace.md](failure-observer-and-trace.md) N1,
  N3); trace frames later attach to the same statement.
- **Control intrinsics never appear as a MIR callee.** `Intrinsic.catchFailure`,
  `finalizeEffect` and `bindRequirement*` are expanded by lowering into ordinary calls, failure
  edges, aggregates and switches (Step 5 owns the expansion); `suspendEffect` becomes `Suspend` (§6). MIR has no
  Effect-specific or callable-specific forms.

_Rejected:_ drop elaboration from an implicit-drop MIR (the Rust order) needs a separate
initializedness dataflow on the build path; we lower drops directly and keep elaboration as an
optional later MIR→MIR pass that deletes provably constant flags. Unwind edges on every call are
rejected because Silk has no unwinding: typed failure is a value, and traps are fatal. A
`Call.failure` without a destination place would make every caller invent a failure temporary.

## 4. Owned-place tracking for Step 6 (question 3)

MIR itself records only the result: `Drop` statements, `Move` operands and `DropFlag` locals.
The facts that produce it come from typing and from a lowering-time cleanup stack.

1. **Typing records every consuming site as a consumed place**: `move`, `drop`, `match move`,
   `self: Self` receivers (`ReceiverPass.Take`), section and closure captures, Effect-block
   captures, and projected places for partial moves. Today `TypedBody.Move` wraps only a local;
   widening it is the first Step 6 PR.
2. **Lowering keeps a cleanup stack.** A scope is a lexical block or a full expression; each lists
   its owned places in acquisition order. Fallthrough, `return`, `break`, `continue`, `fail` and a
   call's failure edge each drop every scope they leave, innermost first and in reverse acquisition
   order (CLEANUP-002). The returned or failed value is moved out first.
3. **Replacement** (`x = value` for an owned `x`) drops the displaced value before the new value
   becomes live (CLEANUP-001); a partial parent uses the child expansion.
4. **Temporaries** live until the end of their full expression. A temporary borrowed by a `let`
   (BORROW-006) is promoted to the enclosing block.
5. Guarded consuming match arms bind projections of the scrutinee and move only after the guard
   succeeds ([ownership MATCH-002](../../apps/docs/content/reference/ownership-and-borrowing.md#match-002--pattern-bindings-inherit-the-selected-match-ownership);
   functions MATCH-001).

Ordinary functions cannot fail (EFF-006), so Step 6 exercises return, break and continue edges.
Failure-edge cleanup uses the same stack and lands with Step 9's first fallible call.

## 5. Room for borrow regions (question 4)

Borrow checking runs on checking MIR: `Mir(Abstract(declaration))` for ordinary generic bodies,
once, and one selected-body MIR per static selection (#567 settled decisions). It is never emitted.
It needs:

| Needed                                                | Present now                                        | Added later                                             |
| ----------------------------------------------------- | -------------------------------------------------- | ------------------------------------------------------- |
| Loans as explicit `Ref`/`AddressOf` rvalues on places | yes                                                | —                                                       |
| Place operands only, no expression trees              | yes                                                | —                                                       |
| Origins on every statement and terminator             | yes                                                | —                                                       |
| Symbolic declaration lifetimes in local types         | yes (retained as evidence)                         | —                                                       |
| Loan identity                                         | derived from the `Ref` location (block, statement) | —                                                       |
| Region variables                                      | —                                                  | side table keyed by local and loan location             |
| Storage liveness for non-owned locals                 | —                                                  | `StorageLive`/`StorageDead` from the Step 6 scope stack |
| Calls through a declared bound                        | —                                                  | `Callee.Bound(operation, provider)`                     |

All later entries are new variants or side tables. Until the checker lands, the existing
`SILK_GAP borrow-check` summary stays loud.

## 6. Suspension (question 5)

**Decision.** Suspension is one terminator added by the suspension stage, never earlier:

```text
Suspend { callee, arguments, providers, destination, mode: Transfer | Nested,
          resume: Block, failure: Option<FailureEdge>, cancel: Block, origin }
Abandon { origin }
```

- `Transfer` is an explicit `Effect.suspend(child)`; `Nested` is a `run` of a callee whose
  suspension summary is `NestedTransfer`, inside a suspendable instance.
- `resume` receives the success value in `destination`; `failure` is the ordinary failure edge.
- `cancel` is the explicit drop chain of every owner live at that point, reading flags from the
  frame, and it ends in `Abandon` (no outcome). Dropping a dormant execution follows it
  (`independent-execution.md`, SUSP-011/013).
- `Mir(Function)` demands the instance's suspension _summary_, never a callee body, to choose
  `Call` or `Suspend`. A non-suspending instance contains no `Suspend` and pays nothing (SUSP-018).
  The summary is transitive over recursive call graphs, so it needs an SCC-capable query; the
  engine reports `Cycle` today.
- Providers, the `Return`/`Failure` out-slots and drop flags are ordinary locals, so the frame
  transform stores them like any live place.

Until the stage lands, lowering reports gap `suspension` where it reaches `Intrinsic.suspendEffect`;
a caller fails through its callee's gap.

_Rejected:_ a `cancel` edge on every `Call` (cost on every Effect call, contrary to SUSP-018);
deriving cancellation cleanup from the failure chain (absent for `never`-failure callees);
treating `suspendEffect` as an ordinary intrinsic call (the frame transform must find every
suspension point structurally).

## 7. Closures and captures (question 6)

- **Identity.** An anonymous callable or Effect block is its own function declaration. Its
  `DeclarationId` ends in an owner step of new kind `Anonymous` or `EffectBlock`, with no name and
  `occurrence` = its ordinal among same-kind literals in the owner's abstract body, counting every
  literal including unselected `static if` arms. Its instance is an ordinary
  `InstanceKey.Function`, so the representation type, layout, drop glue and symbol share one
  identity.
- **Environment.** The closure value _is_ its environment: a record of captures in capture order,
  built by `Aggregate` at construction (CAPTURE-001). A section's environment is its supplied
  trailing arguments. `Layout` lays it out like a record; its `DropGlue` drops the captures.
- **Invocation.** Types are exact after monomorphization, so calling a closure is a direct
  `Call(Instance(body))` with the environment as parameter 0, passed by `&`, `&mut` or move per
  its invocation mode ([ownership CALLABLE-002](../../apps/docs/content/reference/ownership-and-borrowing.md#callable-002--invocation-mode-derives-from-access-to-the-callable-environment);
  functions CALLABLE-003). A section call is a direct call of its target with the
  stored arguments appended. No `Section` key, no adapter function, no function pointer.
  A section of an abstract callable parameter retains a typing recipe for its base and newly
  supplied arguments. Substitution resolves that recipe to the original function application
  before layout, glue or invocation. Repeated staging keeps capture order while retaining each
  field's original argument ordinal. The resulting section's mode includes its new captures;
  the original anonymous target still receives its environment in that target's actual mode.
  A generic named section keeps an immutable bound blueprint and construction-selected evidence
  indexed by original binder ordinal. Remaining parameter occurrences may defer target binders;
  unused or result-only binders cannot. Each invocation opens the raw target signature before
  inserting free caller evidence, solves independently, proves the target bounds, then constructs
  an ordinary complete function application. The blueprint is type metadata; only supplied
  captures occupy the environment record. It never becomes a function key or dispatch adapter.
  Passing a generic section to a concrete callable promise opens its target binders only for
  contract comparison and proves the resulting bounds. This preserves the section's exact type
  across consumers. Inside a closed consumer, invocation solves again from its actual operands
  and selects the original target instance; the comparison contract never supplies a runtime key.
- **Named effect fn runners** keep their written parameters as ordinary `Parameter` locals, so
  `run f(a)` is `Call(f, [a], providers)`. Running a stored Effect built from `f` moves (`once`) or
  copies its fields into those arguments. Effect blocks and anonymous effect fns take the closure
  environment as parameter 0. A closed, infallible effect fn has exactly the ordinary fn ABI.
- `Operand.FunctionAddress` exists only for C callbacks.

_Rejected:_ environment pointer plus code pointer (needs indirect calls and adapters for exact
types we already know); a separate `InstanceKey.Closure` (duplicates `DeclarationId` identity).

## 8. Checking (question 7)

`MirCheck` is an opt-in module that `silkc` never links. Only the corpus runner calls it, in CI
(§12). It checks:

1. **Structure:** block 0 is the entry; indices are in range; every block has one terminator;
   switch values are distinct; `references` and `externs` are sorted and include every callee.
2. **Types:** an assignment's rvalue type equals its place type (runtime equality); `Branch`
   tests `bool`; call arguments match the callee signature; each projection is valid for its base.
3. **Edges:** `failure` is present exactly when the callee can fail; `Fail` occurs only in
   functions that can fail; `Return` and `Failure` are definitely initialized at `Return`/`Fail`.
4. **Ownership** (after Step 6): no use after `Move`; every owned local is moved or dropped exactly
   once on every path; `Drop` only on a definitely initialized complete value or under its flag.
5. **Suspension** (after the stage): `Suspend` only in suspendable instances; every `cancel`
   chain ends in `Abandon` without `Return` or `Fail`.

## 9. Worked examples

**A. Replacement and loop exit.** From corpus `recursive-box-chain-shallow-cleanup`:

```silk
let mut current = Chain { step: Step { kind: End {} } }
while remaining > 0 {
  let taken = Intrinsic.replace(current, Chain { step: Step { kind: End {} } })
  let boxed = run Box.make<Chain>(move taken)
  current = Chain { step: Step { kind: Link { next: move boxed, counter: Shared.clone(counter) } } }
  remaining = remaining - 1
}
return move current
```

```text
bb_loop:  _c = Gt(remaining, 0); Branch(_c, bb_body, bb_exit)
bb_body:  _fresh = Aggregate Chain{...End}
          _taken = move current         // Intrinsic.replace lowers to two moves
          current = move _fresh
          Call Box.make<Chain>(move _taken) providers [allocator] -> _boxed,
               normal bb_ok, failure { _err: OutOfMemoryError -> bb_fail }
bb_ok:    Call Shared.clone(counter) -> _counter, normal bb_ok2
bb_ok2:   _new = Aggregate Chain{ Variant Link{ move _boxed, move _counter } }
          Drop(current)                 // replacement drops the displaced value first
          current = move _new
          remaining = Sub(remaining, 1); Goto bb_loop
bb_fail:  Failure = move _err           // _taken already moved; only `current` is live
          Drop(current); Fail
bb_exit:  Return = move current; Return // nothing left to drop
```

No flag is needed: on every path `current` is live and `_taken` is moved.

**B. Union and array glue.** From `ordinary-union-droppable-array`:
`fn accept(value: i32 | [Token; 2]) -> i32 { drop value return 42 }` lowers to
`Drop(value); Return = 42; Return`. `DropGlue(i32 | [Token; 2])` switches on the tag and drops only
the array member, whose glue drops element 0 then element 1.

**C. Failure edge through a generic runner.** From `generic-run-cleanup-counts`:

```silk
effect fn acquiring<A, E>(self: once Effect<A ! E>, counter: &Shared<Counter>) -> A ! E {
  let held = owner(counter)
  let value = run move self
  drop held
  return move value
}
```

```text
bb0: Call owner(counter) -> held, normal bb1
bb1: Call runner(self)(move self) -> value, normal bb2, failure { _e: E -> bb3 }
bb2: Drop(held); Return = move value; Return
bb3: Failure = move _e; Drop(held); Fail
```

**D. Captures.** From `anonymous-capture-cleanup-count`: `let section = add(move sectionToken)`
is `section = Aggregate{ move sectionToken }`; `section(40)` is `Call add(40, move section.0)`
(once invocation). `let pending = effect { return consume(move effectToken) }` builds an
`EffectBlock` environment `{ effectToken }`; `run pending` is a direct call of that block's
instance with the environment, and the block body moves `effectToken` out of it.

**E. Suspension.** From `stored-effect-cleanup-counts`:

```silk
effect fn delayed(held: Guard) -> i32 {
  let base = run Effect.suspend(effect { return 40 })
  return base + held.value
}
```

```text
bb0: _child = Aggregate{}             // EffectBlock environment, no captures
     Suspend(Nested, Effect.suspend<i32, never>(move _child)) -> base, resume bb1, cancel bb2
bb1: Return = Add(base, held.value); Drop(held); Return
bb2: Drop(held); Abandon
```

`delayed` holds a `Nested` point because the stdlib `Effect.suspend` instance is `NestedTransfer`.
That instance's body `run Intrinsic.suspendEffect(move deferred)` is the `Transfer` point.

Until the suspension stage, this reports gap `suspension` at the `Effect.suspend` call.

## 10. Gap codes

| Code         | Reached when                                                                                                     | Exit             |
| ------------ | ---------------------------------------------------------------------------------------------------------------- | ---------------- |
| `cleanup`    | an owned place needs a cleanup form the current step does not lower, or emission meets `Drop` before glue exists | Step 6           |
| `capture`    | an anonymous callable, Effect block or section is constructed or called                                          | Step 8           |
| `suspension` | `Intrinsic.suspendEffect` or `Intrinsic.park`, or a `Nested` run in a suspendable instance                       | suspension stage |

Existing codes stay: `intrinsic-member` (including the Execution primitives), `bound-method`,
`generic-operation`, and the `borrow-check` summary until native borrow checking. The Step 9
provider PR deletes `effect-instance`.

## 11. Implementation order

Each field or variant lands with its first producer; nothing is reserved early.

1. **Step 6a** — Typing records consumed places (receivers, partial moves, `match move`).
2. **Step 6b** — `InstanceKey.DropGlue`, the glue producer and `Drop` emission, replacing the
   separate stopgap that reports `cleanup` when emission meets `Drop` (§12).
3. **Step 6c** — Cleanup stack, drops on fallthrough/return/break/continue, replacement drops,
   `DropFlag` locals.
4. **Step 6d** — Partial moves, union payload flags, promoted temporaries.
5. **MirCheck** — Structure, types, edges and ownership; wired into the corpus runner's CI run.
6. **Step 8** — `Anonymous`/`EffectBlock` owner steps and ordinals, environment layout and glue,
   direct invocation.
7. **Step 9 (with Step 5)** — `FailureEdge`, `LocalKind.Failure`/`Provider`, `Call.providers`,
   `Fail`, intrinsic expansion; gap `suspension`.
8. **Suspension stage** — SCC summary query, `Suspend`/`Abandon`, frame transform.
9. **Borrow stage** — `Mir(Abstract)`, `Callee.Bound`, storage markers, region side table.

## 12. Decisions (Julia, 2026-10-02)

1. **`MirCheck` trigger.** It runs only from the corpus runner in CI and is never linked into
   `silkc`.
2. **Cancellation edge.** Each suspension point carries its own explicit `cancel` chain, written by
   lowering (§6); the frame transform does not derive it.
3. **Silent `Drop` emission.** A stopgap that reports `cleanup` when emission meets `Drop` lands
   separately now; Step 6b replaces it with drop glue.

## 13. Agreed with Step 5

The Step 4 and Step 5 authors agreed this text on 2026-10-02. It appears verbatim in
[the Effect calling-convention note](effect-calling-convention.md).

### Failure edges (agreed by Steps 4 and 5)

- `Call { callee, arguments, providers, destination, normal, failure: Option<FailureEdge>, origin }`. `arguments` match the callee signature one-to-one; `providers` is a separate list in canonical requirement-key order, empty until Step 9. A provider operand is address-typed (Step 5 defines it). Abstract checking MIR later calls through `Callee.Bound(operation, provider)`.
- `FailureEdge { destination: Place, target: Block }` is present exactly when the callee's failure type is not `never`. `destination` has the callee's failure type, which may be narrower than the caller's.
- `LocalKind.Failure` (one per function that can fail) and `LocalKind.Provider { index }` are distinct from `Return` and `Parameter`; Layout's ABI classification makes `Return` and `Failure` out-addresses when the failure type is not `never`.
- `Terminator.Fail { origin }` exits with `Failure` initialized. `fail x` is `Assign(Failure, x)`, the Step 6 drop chain, then `Fail`. A failure-edge target converts or injects the value into `Failure` or a handler temporary, runs the drop chain of the exited scopes (innermost first, reverse acquisition order, flag-guarded), then reaches `Fail` or the handler call. There is no unwinding; `Trap` skips cleanup; automatic `Drop` is infallible.
- Control-affecting intrinsics never appear as MIR callees; lowering expands them into ordinary MIR (Step 5 owns the expansion). `catchAll`/`catch`: failure edge into a temporary, `Discriminant`, `Switch`, `Payload` + `Inject`, then an ordinary handler `Call`. `ensuring`: both the normal and failure targets of the protected call run the finalizer (failure type `never`); the failure path then moves the temporary into `Failure` and does `Fail`.
- `Statement.FailureContext { destination: Place, source: Option<Place>, origin }`: `source` absent originates context at `origin` (emitted by `fail x` after `Assign(Failure, x)`; the identity and site-label texts live in `MirFunction.contexts`); `source` present carries it from that failure slot (emitted on every move or conversion between failure slots). Both places are failure slots; every failure slot has a fixed-size four-word companion, and a callee writes its edge destination's companion through its context out-address. `Rvalue.ContextOf(slot)` is a companion's address, passed as a selected handler's cause. A succeeding handler discards it. Statements exist only in a program that observes diagnostics ([the failure observer note](failure-observer-and-trace.md) N1, N3); trace frames later attach to the same statement.
- Runners: a named effect fn keeps its written parameters as `Parameter` locals, so `run f(a)` is `Call(f, [a], providers)`; running a stored Effect built from `f` moves (once) or copies its fields into those arguments. Effect blocks and anonymous effect fns take the Step 8 closure environment as parameter 0. A closed, infallible effect fn has the ordinary fn ABI.

### Suspension (agreed by Steps 4 and 5)

- Added only by the suspension stage: `Terminator.Suspend { callee, arguments, providers, destination, mode: Transfer | Nested, resume: Block, failure: Option<FailureEdge>, cancel: Block, origin }` and `Terminator.Abandon { origin }`.
- `Transfer` is the explicit `Intrinsic.suspendEffect` point (inside stdlib `Effect.suspend`); `Nested` is a `run` of a callee whose suspension summary is NestedTransfer, inside a suspendable instance. `resume` receives the success value in `destination`; `failure` is the ordinary failure edge; `cancel` is the explicit drop chain of every owner live at that point, reading flags from the frame, ending in `Abandon` (no outcome).
- `Mir(Function)` demands the instance's suspension summary (an SCC-capable query; an engine addition), never a callee body, to choose `Call` or `Suspend`. Non-suspending instances contain no `Suspend` (SUSP-018). Providers, out-slots and drop flags are ordinary locals stored in the frame like any live place.
- Until that stage, reaching `Intrinsic.suspendEffect` or `Intrinsic.park` reports gap `suspension`; callers fail through the callee's gap. The Execution primitives stay `intrinsic-member`.
