# Effect calling convention (native backend)

**Status:** approved design, roadmap Step 5 in
[#567](https://github.com/julia-script/silk/issues/567). It gates Step 9 (effects, failures and
services). It builds on [the MIR core shape](mir-core-shape.md) (Step 4) and carries forward the
B3 workspace draft, including Julia's decisions of 2026-09-30. Sources: selfhost `1ecaca3d`,
bootstrap `main` (`EffectLowering.ts`, `NativeEffectOperation.ts`,
`internal/EffectExecutionContract.ts`, `Mir.ts`, `Layout.ts`), and the reference pages
[effects and execution](../../apps/docs/content/reference/effects-and-execution.md),
[Effect contracts](../../apps/docs/content/reference/effect-contracts.md),
[requirements and services](../../apps/docs/content/reference/requirements-and-services.md),
[typed failures](../../apps/docs/content/reference/typed-failures.md),
[program entry](../../apps/docs/content/reference/program-entry.md),
[suspension](../../apps/docs/content/reference/effect-suspension.md) and
[independent execution](../../apps/docs/content/reference/independent-execution.md).

## In plain words

Running an Effect is a direct call to one compiled function. A named `effect fn` compiles to a
function with its written parameters, like an ordinary `fn`, plus one hidden address for each
service it requires. If it can fail, it writes its answer to one of two caller-owned places and
returns a success/failure flag. Nothing is looked up at run time: every provider's concrete type is
known at compile time and is part of the instance's identity, just like a generic type argument. A
closed, infallible `effect fn` has exactly the ordinary function ABI.

`Effect.catch`, `Effect.provide`, `Effect.ensuring` and the other combinators stay ordinary
standard-library source. The few sealed intrinsics under them (`catchFailure`, `bindRequirement*`,
`finalizeEffect`, ...) build an exact Effect value. The compiler expands that value where it is
`run`, into ordinary calls, branches and cleanup. MIR has no Effect-specific instruction.

Suspension is out of scope. Reaching it is a named `suspension` gap until the suspension stage.

## 1. Decisions

### D1. Effect values and runners

An Effect value has an **exact representation** (REP-001/002, MIR note §2). Its type identifies
one construction site, and its storage is that site's environment:

| Construction                                                 | Environment                      | Runner                                           |
| ------------------------------------------------------------ | -------------------------------- | ------------------------------------------------ |
| `f(a, b)` for `effect fn f`                                  | the argument tuple `{a, b}`      | the instance of `f`                              |
| `effect { ... }`, anonymous `effect fn`                      | Step 8 closure captures          | the block's instance, environment as parameter 0 |
| `Intrinsic.bindRequirement*<S>(e, p)`                        | `{inner: e, provider: p}`        | expanded at the `run` site (D4)                  |
| `Intrinsic.catchFailure<S>(e, h)`                            | `{inner: e, handler: h}`         | expanded at the `run` site                       |
| `Intrinsic.finalizeEffect(e, f)` and the NonParking variants | `{inner: e, finalizer: f}`       | expanded at the `run` site                       |
| finite join (EFF-013)                                        | tagged union of the alternatives | `Switch` on the tag, one runner per arm          |

- `run f(a)` is `Call(f, [a], providers)`. Constructing `f(a)` without `run` is only an
  `Aggregate`; it never calls `f`.
- Running a stored value built from `f` moves (`once` run) or copies (shared or exclusive run, where
  typing guarantees Copy fields) the tuple fields into `f`'s arguments.
- A generic parameter of Effect contract type, such as `self: once Effect<A ! E ? R>` in
  `Effect.catchAll`, is specialized to the argument's exact representation. This is the same
  mechanism Step 8 builds for callables (REP-002), so Step 5 adds no machinery here.

_Rejected:_ an environment pointer plus function pointer (an indirect call on every `run`, and the
MIR note already rejected it); bootstrap-style runners generated per run site (they duplicate a
body per site and need Effect-specific MIR); passing every runner's environment by address (B3's
first draft). The last one would give a closed `effect fn` a non-ordinary ABI and make its body
read its parameters through the environment, with nothing gained after monomorphization.

### D2. Providers: specialization plus hidden address parameters

For an instance whose substituted requirement row has entries `k1 < k2 < ... < kn` in canonical
service-role key order (G3, never source order):

- `InstanceKey.Function` gains `providers: [(key, P)]`, one entry for **every** row entry. `P` is
  the provider's concrete type in canonical runtime form (lifetimes erased).
- MIR gains `Provider { index }` locals, one per entry, holding an address. A `Call` passes them in
  its separate `providers` list, in callee key order.

| Component                          | In the key?   | Why                                                   |
| ---------------------------------- | ------------- | ----------------------------------------------------- |
| type, static and row arguments     | yes           | as today                                              |
| provider type `P` per row entry    | **yes (new)** | a service call selects `impl Svc for P` statically    |
| conformance witness                | no            | coherence gives one witness per `(P, Svc)` (SERV-007) |
| provider access, borrowed vs owned | no            | always one address at the ABI                         |
| `A`, `E`, the row itself           | no            | derived from the declaration and arguments            |

**Where a callee's provider comes from.** At a `run` site in instance `I`, each entry of the
callee's row resolves statically to exactly one source:

1. **`I`'s own provider:** pass `Copy(Provider i)`. SEM0071 guarantees the callee's row is
   covered by `I`'s row or by an enclosing binding.
2. **A bound Effect:** running `{inner, provider}` bound for key `S` runs `inner` with `I`'s
   providers, except that `S` gets the bound provider's address. A borrowed provider passes the
   stored reference; an owned one passes `AddressOf(bound.provider)`. That is SERV-009's lexical
   replacement: only this execution sees the replacement, and the outer provider is visible again
   afterwards because nothing was mutated. Nested bindings resolve innermost first.
3. **No third source.** Entry and startup code provide services as ordinary source (D5).

**Service operations.** `run Svc.op(args)` is `Call(Instance(witness of Svc for P).op, [provider,
args...], providers)`. The provider address is the receiver argument (`self: &P` or `&mut P`).
`Svc` and `op` are ordinary interface and witness facts; there is no vtable.

_Rejected:_ a runtime environment record or dictionary of providers (EFF-012 and SERV-005 forbid
runtime row dictionaries); a vtable per service (operations can be generic, such as
`Logger.log<Args>`, so no finite table holds them); specialization on `P` without passing an
address (provider state is runtime data). A declared but unused row entry still gets a binding,
which may duplicate code. Pruning it needs a transitive "uses key" summary, and Julia deferred it
on 2026-09-30.

### D3. Failures: a status flag and two out-slots (decided 2026-09-30)

```text
f(arguments..., providers...)                                -> A        when E = never
f(arguments..., providers..., success: address, failure: address) -> status  when E != never
                                                                 (0 = success, 1 = failure)
```

- MIR stays shape-only. `Call.failure` is `Some(FailureEdge { destination, target })` exactly when
  the callee's `E` is not `never`. Layout's ABI classification turns the `Return` and `Failure`
  locals into out-addresses, and LLVM emission passes `destination` and `FailureEdge.destination`
  and branches on the status.
- `destination` has the callee's `E`. When the caller's failure type is wider (for example
  `NotFound` into `NotFound | Offline`), the edge block injects it into the caller's `Failure`.
  When the types are equal, emission may pass the caller's `Failure` directly.
- A witness callee's `E` is the witness's own declared failure, which EFF-009 bounds by its
  operation's and may be narrower, down to `never`. The call carries that witness failure
  (`CallTarget.witnessFailure`), so a `never` witness has no edge and a narrower one is injected
  like any other narrower callee failure.
- Ordinary `fn` has no failure channel (EFF-006). A closed `run` in an ordinary function is a call
  with no failure edge.
- Traps are unchanged: no status and no cleanup (FAIL-007).

_Rejected:_ returning a tagged outcome by value, which is what the bootstrap does (an `i32` tag lane
plus the widest payload's lanes; copies and unifies lanes at every propagation); a direct small
return for the success value plus a failure out-parameter (Julia chose uniform out-slots and
revisits only on measurement).

### D4. Composition intrinsics expand at the `run` site

Every Effect combinator in `silk/effect.silk` is ordinary source over seven sealed intrinsics.
Running their results lowers as follows. "Run `x`" means D1 applied to `x`, recursively.

- **`catchFailure<S>(inner, handler)`**: run `inner` with a `FailureEdge` into temporary `t` of
  `inner`'s `E`. On the edge: `Discriminant(t)`, `Switch`. Members in `S` build the handler's
  argument with `Payload` + `Inject` and run `handler`, whose own success and failure become this
  run's. Members outside `S` are injected into the caller's failure and propagate. When `S` is the
  whole `E` (`catchAll`), the switch disappears.
- **`finalizeEffect(inner, finalizer)`**: run `inner`, with its failure edge into `t`. The normal
  target and the failure target both run `finalizer` (`E = never`, so no edge). The failure path
  then moves `t` into `Failure` and does `Fail`. `finalizeEffectNonParking` lowers identically;
  `NonParking` is a compile-time bound.
- **`useReleaseNonParking(resource, use, release)`**: own `resource`, call `use(&mut resource)`
  and run the Effect it returns, with a failure edge into `t`. Both targets then call
  `release(&mut resource)` and run its Effect (`E = never`), drop `resource`, and forward success,
  or move `t` into `Failure` and `Fail`. It is `finalizeEffect` with an owned resource lent to both
  callables.
- **`bindRequirement`, `bindRequirementMut`, `bindRequirementOwned`**: D2 rule 2. The owned form
  drops the provider with the environment.
- **`suspendEffect`**: gap `suspension` (D6).

Because the representation is exact, the expansion is a finite structural recursion over the
value's type. `Effect.catchAll` is itself `return run Intrinsic.catchFailure<E>(...)`, so the
expansion happens once, inside the `catchAll` instance specialized to its arguments.

_Rejected:_ synthesizing an instance per intrinsic composite (a new key variant with no gain, since
the run site already knows everything); recognizing `Effect.catchAll`, `Effect.result` or
`Result` by name (forbidden by minimal compiler privilege, EFF-014).

### D5. `run` at entry and exit codes

ENTRY-001..003 put entry in source: the runtime module `silk/native_start` calls `app.main`,
provides `HostInput`, catches unhandled failures with `Effect.catchAll(..., failed)` and returns
status 1. The compiler has no entry adapter and no root providers. Nothing in D1–D4 is special at
entry: `catchAll` and `provideMut` there lower like anywhere else.

The explicit source module `silk/native_start_sync` supplies an ordinary lexical mutable
`HostInput` provider to an i32 application Effect. The exclusive provider also satisfies shared
access (SERV-006). Its ordinary generic failure callback drops the owned error and returns
status 1, including initialization failure; the local provider releases its captured input
after the loan ends. Its `NonParking` bound rejects parking. This composition needs neither
Execution nor an observer; full `silk/native_start` retains those separate dependencies. See
[the source startup contract](source-synchronous-startup.md).

Selfhost has no generated C entry: a package without a composition takes the catalog runtime for
its target and libc, `silk/native_start` on hosted targets, and every build roots at that
runtime's C exports. Full suspension and observer support remain separate work.

### D6. Suspension stays a named gap

Agreed with Step 4 (quoted in §2). Reaching `Intrinsic.suspendEffect` or `Intrinsic.park` while
building MIR reports gap `suspension` at that site. Every caller fails through that gap, so no
transitive summary is needed before the suspension stage. `executionDrive`,
`executionFromAllocation`, `executionLayout`, `executionNotifyInitial` and `wake` keep reporting
`intrinsic-member`. Nothing in D1–D4 blocks the later frame transform: providers, out-slots and
drop flags are ordinary locals the frame stores like any live place.

### D7. Cleanup on failure edges (Step 6)

A failure edge is one more exit edge for Step 6's cleanup stack:

1. The callee has already written its payload to `FailureEdge.destination`, which lies outside
   every scope the edge leaves.
2. The edge block converts or injects the payload into `Failure` or a handler temporary, then
   drops each exited scope innermost first, places in reverse acquisition order, flag-guarded where
   Step 6 needs a flag.
3. It ends in `Fail` or continues into the handler's `Call`.

`fail x` is `Assign(Failure, x)`, the same drop chain, then `Fail`. A caught failure's scopes are
fully cleaned before the handler starts (FAIL-006), because the handler call sits after the drop
chain. Cleanup is infallible, there is no unwinding, and `Trap` skips cleanup.

### D8. Privilege

| Piece                                                                                                                                                                                       | Owner                                                        |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `run`, `fail`, `effect {}`, `effect fn`, requirement rows, `service`                                                                                                                        | language (typing + MIR lowering)                             |
| `catchFailure`, `finalizeEffect(NonParking)`, `useReleaseNonParking`, `bindRequirement(Mut/Owned)`, `suspendEffect`, `park`, `observeUnhandled`, `observeDiagnostics`, `execution*`, `wake` | sealed `Intrinsic`, already in the catalog; Step 5 adds none |
| `catch`, `catchAll`, `mapError`, `result`, `provide`, `provideMut`, `provideEffect`, `ensuring`, `retry`, `flatMap`, `zip`, `suspend`, ...                                                  | ordinary `silk/effect.silk` source                           |
| entry, `HostInput`, unhandled-failure policy and exit status                                                                                                                                | ordinary `silk/native_start` source                          |

No standard-library declaration is recognized by spelling. `service` declares runtime provider
slots, and `interface` never creates one.

## 2. MIR shape agreed by Steps 4 and 5

Quoted verbatim from the Step 4 author; the same text appears in [mir-core-shape.md](mir-core-shape.md).

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

## 3. Worked examples

All four are native corpus programs (`packages/compiler/test/support/corpus.ts`). MIR is
abbreviated: `bbN` are blocks, `_r` is `Return`, `_f` is `Failure`, `_pN` is `Provider N`.

### `effect-selective-catch` (catch, catchAll, failure unions)

```silk
effect fn risky(mode: i32) -> i32 ! Selected | Residual { ... fail Selected { code: 10 } ... }
effect fn selective(mode: i32) -> i32 ! Residual {
  return run Effect.catch<Selected>(risky(mode), recoverSelected)
}
effect fn completed(mode: i32) -> i32 {
  return run Effect.catchAll(selective(mode), recoverResidual)
}
pub fn main() -> i32 { return (run completed(0)) + (run completed(1)) + (run completed(2)) }
```

- `risky(mode)` has signature `(i32, success: &i32, failure: &(Selected | Residual)) -> status`.
  `fail Selected {code: 10}` is `_f = Inject(tag Selected, Aggregate{10})`, then `Fail`.
- `Effect.catch[S = Selected, inner = risky-site, handler = recoverSelected]` runs
  `Intrinsic.catchFailure`, which expands to:

  ```text
  bb0: Call risky(Move(self.0)) -> _r, normal bb1, failure (_t: Selected | Residual) -> bb2
  bb1: Return
  bb2: Switch Discriminant(_t) [Selected -> bb3] otherwise bb4
  bb3: Call recoverSelected(Move(_t as Selected)) -> _r, normal bb1      // handler E = never
  bb4: _f = Inject(Residual, Move(_t as Residual)); Fail
  ```

- `completed` is infallible, so it has the ordinary ABI `(i32) -> i32`. `main` calls it three
  times with no failure edges.

### `role-keyed-service-provider-selection` (rows, roles, lexical binding)

```silk
effect fn total() -> i32 ? &Values at Left | &Values at Right {
  let leftValue = run Values.left()
  let rightValue = run Values.right()
  return leftValue * 10 + rightValue
}
pub fn main() -> i32 {
  let selected = total()
    |> Intrinsic.bindRequirement<Values at Left>(&leftProvider)
    |> Intrinsic.bindRequirement<Values at Right>(&rightProvider)
  return run selected
}
```

- Instance key: `total{providers: [(Values at Left, Fixed), (Values at Right, Fixed)]}`, with
  signature `(_p0: &Fixed, _p1: &Fixed) -> i32`. Both providers have the same type, so roles are
  what keep the keys apart.
- In `total`, `run Values.left()` is `Call(Fixed.left, [Copy(_p0)])`, and `Values.right()` uses
  `_p1`.
- In `main`, `selected` is `{inner: {inner: total-site, provider: &leftProvider}, provider:
&rightProvider}`. `run selected` resolves `Right` from the outer binding and `Left` from the
  inner one: `Call(total, [], providers [Copy(selected.0.1), Copy(selected.1)])`.

### `owned-provider-shared-dispatch` (owned provider, `&mut` access)

```silk
effect fn both() -> i32 ? &mut Counter { run Counter.bump(); run Counter.bump(); return run Counter.get() }
let observed = run Effect.bindRequirementOwned<Counter>(both(), Cell { value: 1 })
```

- The stdlib instance `Effect.bindRequirementOwned[S = Counter, P = Cell, ...]` has an empty
  residual row. Its body `run Intrinsic.bindRequirementOwned<S>(move self, move provider)`
  becomes:

  ```text
  _b = Aggregate{Move(self), Move(provider)}
  Call both[Counter -> Cell]([], providers [AddressOf(mut, _b.1)]) -> _r, normal bb1
  bb1: Drop(_b); Return          // the owned Cell is dropped with the environment
  ```

- In `both`, `bump` gets an exclusive reborrow of `*_p0` (`&mut Cell`), and `get` gets a shared
  reborrow.

### `native-termination-logical-path` (`effect fn main`, unhandled failure)

```silk
effect fn load() -> i32 ! NotFoundError { fail NotFoundError {} }
effect fn middle() -> i32 ! NotFoundError { let v = run load(); return v + 1 }
pub effect fn main() ! NotFoundError { let v = run middle(); return () }
```

- `load` and `middle` lower under D3. In `middle`, `load`'s failure edge targets `_f` directly
  because the types are equal, then `Fail`.
- The program as a whole runs through `silk/native_start`. Its expected stderr prints a logical
  trace, which also needs the trace follow-up (Q2).

## 4. Gap codes

| Code                       | Change                      | Raised where                                                                                                                    | Exit condition                                                                           |
| -------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| `suspension`               | **new** (named with Step 4) | MIR lowering reaches `suspendEffect` or `park`                                                                                  | suspension stage                                                                         |
| `effect-instance`          | **deleted**                 | was: instance with a non-empty row, or an `effect fn` interface witness                                                         | Step 9 provider PR                                                                       |
| `entry-signature`          | **deleted**                 | was: `Entry { main }` with any signature except `fn main() -> i32`                                                              | default runtime selection                                                                |
| `intrinsic-member`         | narrower                    | `execution*`, `wake`; no longer `observeUnhandled` or `observeDiagnostics` ([the observer note](failure-observer-and-trace.md)) | suspension stage                                                                         |
| `observer-callback`        | **new** (observer note)     | an `observeDiagnostics` callback that is not a direct function                                                                  | callback environments in the observer record                                             |
| `failure-identity`         | **new** (observer note)     | an observed `fail` of a type other than a nominal, primitive, string or unit type                                               | identity rendering for the remaining types                                               |
| `typed-form`               | narrower                    | `run`, `fail` and `effect {}` stop producing it as Step 9 PRs land                                                              | per PR                                                                                   |
| `interface-effect-witness` | narrower                    | an `effect fn` interface call that no `run` executes in place                                                                   | lowering stored interface Effect constructions; owner: Step 9 follow-up                  |
| `cleanup` (owned provider) | extended (Step 9d)          | `bindRequirementOwned` whose provider owns cleanup (needs a drop on both exits of the inner run)                                | provider drop in `RunPlan.Bind`; owner: Step 9 follow-up                                 |

Every gap is a structured `Unsupported` result naming the owner instance and span. None becomes a
trap stub.

## 5. Bootstrap parity

| Area               | Bootstrap (`main`)                                                                                                                                                                                                                  | Native (this note)                                                                                                               | Observable?                       |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| MIR                | Effect-specific operations: `MakeEffect`, `RunEffect`, `RunEffectValue`, `RunEffectComposite`, `RunStaticEffect`, `CatchEffect`, `PackEffectOutcome`, `UnpackEffectSuccess`, `Pack/UnpackEffectComposite`, `PropagateEffectFailure` | ordinary `Call` with `FailureEdge`, `Switch`, `Aggregate`; no Effect forms                                                       | no                                |
| runners            | generated per Effect site (`CatchEffectRunner`, ...), keyed by `EffectExecutionContract.key` (success, failure row, requirement row)                                                                                                | the construction site's own instance, keyed by application plus providers; intrinsic composites expanded at run sites            | no                                |
| providers          | statically selected provider references appended after captures; runner specialized per provider witness (`effectRunner.providers`)                                                                                                 | the same idea: `providers` in the key, address `Provider` locals                                                                 | no                                |
| failure return     | `EffectOutcome` sum returned by value (tag lane, widest payload's lanes)                                                                                                                                                            | status flag plus success and failure out-slots                                                                                   | no                                |
| diagnostic context | hidden per-invocation observer and cause parameters; full logical trace                                                                                                                                                             | origin-only identity and origin under an observer ([the observer note](failure-observer-and-trace.md)); frames and causes follow | yes, in unhandled-failure reports |
| entry              | source runtime `silk/native_start` (ENTRY-001), no compiler adapter                                                                                                                                                                 | the same source runtime, selected from the standard-library catalog by target and libc                                           | no                                |
| suspension         | coroutine frames, `SuspendEffectRegion`                                                                                                                                                                                             | gap `suspension`                                                                                                                 | yes: unsupported                  |

`EffectExecutionContract.matches`, which proves provider subtraction by row algebra, has no native
runtime counterpart. Selfhost proves `Without<R, S>` during semantic checking, and lowering only
reads the proven selection.

**COMPILER_COMPATIBILITY.md** changes in this PR:

- Add the entry-shim divergence (D5 and Q1), with its exit condition.
- Narrow the existing "Effect lowering, execution storage, `Exit`, and panic behavior" entry: the
  native lowering direction (D1–D4) is approved for selfhost. Storage, `Exit`, cancellation and
  panic stay deferred proposals, and the bootstrap is unchanged.
- The failure-report divergence (no trace) gets an entry in the PR that first makes an unhandled
  failure reportable, not before.

## 6. Implementation order (Step 9)

Step 9 needs Step 6 (cleanup and drop flags) and Step 8 (closures and exact representations). Each
PR measures and pins the corpus programs it unlocks.

1. **Failures in direct calls.** TypedBody `Run` and `Fail` nodes for direct `run f(a)`; MIR
   `Failure` local, `FailureEdge`, `Fail`; Layout fallible ABI classification and emission;
   `suspension` gap. Only empty rows.
2. **Effect values and joins.** Construction without `run`, running stored values, `effect {}`
   through Step 8 environments, EFF-013 joins as `Switch`.
3. **`catchFailure`.** Expansion per D4; unlocks `catch`, `catchAll`, `mapError`, `result`.
4. **Providers.** `InstanceKey` providers, `Provider` locals, service operation calls,
   `bindRequirement*`; delete `effect-instance`.
5. **Finalizers.** `finalizeEffect`, `finalizeEffectNonParking`, `useReleaseNonParking`.

Entry (Q1) and the observer and trace follow-up (Q2) come after the suspension stage, not in Step 9.

## 7. Decisions (Julia, 2026-10-02)

All three recommendations accepted on PR #708:

1. **Entry (Q1).** Keep the generated `Entry { main }` C shim, limited to `fn main() -> i32`,
   until selfhost compiles `silk/native_start`. It is recorded in COMPILER_COMPATIBILITY.md as a
   temporary difference from the bootstrap and ENTRY-001. `pub effect fn main` stays
   `entry-signature` until then. No compiler entry adapter is added for `effect fn main`.
   Done: selfhost now selects `silk/native_start` by default and the shim, `entry-signature` and
   the compatibility entry are removed.
2. **Failure context (Q2).** Origin-only context is carried by `Statement.FailureContext`, added
   with its first reader by the observer and trace work
   ([failure-observer-and-trace.md](failure-observer-and-trace.md), shipped in its §7 step 2), not
   in Step 9. The trace gap belongs to that work.
3. **`effect-instance` (Q3).** Deleted in Step 9 PR 4 (providers), not renamed. Everything it
   covers becomes either supported or `suspension`.
