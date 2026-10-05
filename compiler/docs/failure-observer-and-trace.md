# Failure observer and diagnostic context (native backend)

**Status:** draft design for Julia's review, roadmap [#567](https://github.com/julia-script/silk/issues/567),
decision Q2 of [the Effect calling convention](effect-calling-convention.md) §7. Due before
milestone (i-b). Every open point is a numbered question in §9 with a recommended answer; the
implementation proceeds on those recommendations until Julia answers. Sources: bootstrap `main`
at `6b1679f82` (`Intrinsic.ts`, `DiagnosticObservation.ts`, `ExecutableOrigin.ts`,
`LowerExpression.ts`, `NativeDiagnostic*.ts`, `NativeTermination.ts`, `NativeDeclare.ts`,
`NativeCall.ts`, `Mir.ts`), `silk/native_diagnostics`, `silk/native_report`, `silk/native_start`,
the reference pages [program termination and reporting](../../apps/docs/content/reference/program-termination-and-reporting.md)
(TERM-001..012) and [typed failures](../../apps/docs/content/reference/typed-failures.md) (FAIL-006,
FAIL-007), and the native corpus (`packages/compiler/test/support/corpus.ts`).

## In plain words

A failure carries a small hidden record next to its payload: which failure it is and where it was
raised. The record moves with the failure through the same out-slots, catch temporaries and
cleanup edges as the payload. Nothing unwinds and nothing captures machine stack traces; this is
the Zig error-return-trace idea expressed in MIR.

Reporting is ordinary standard-library source. `Intrinsic.observeDiagnostics(state, callback, body)`
installs a lexical observer for one run of `body`. Inside it, a recovery handler calls
`Intrinsic.observeUnhandled()`, which hands the selected failure's record to the observer's
callback. `silk/native_diagnostics` turns that into the `unhandled error: ...` report.

The compiler adds two hidden addresses to instances that run inside an observer: the observer and
the record of the failure the current handler is recovering from. Code that never runs inside an
observer is compiled exactly as today and pays nothing.

The first native step is origin only: identity and origin, no logical frames and no `while
handling` causes. Frames and causes follow (§7) by filling the same MIR statement.

## 1. What the bootstrap does

### 1.1 The two intrinsics

| Intrinsic                                                                                                     | Signature                                                                                                                                                          | Checks                                                                                                                                                                                                                           |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `observeDiagnostics<S, A, ?R, F>(state: S, observer: F, protected: once Effect<A ? R>) -> once Effect<A ? R>` | `F: fn<'static>(&mut S, u8, usize, usize, string<'static>, string<'static>) -> usize + Intrinsic.NonParking`, shared access; `protected` has the empty failure row | A `protected` that can fail does not match (SEM0052, type-argument inference). SEM0216 when the callback's execution closure is not provably direct (unavailable summary, a suspension mode, or a reachable nested observation). |
| `observeUnhandled() -> usize`                                                                                 | no arguments                                                                                                                                                       | SEM0217 when the site is provably outside every selected recovery handler's inherited execution closure.                                                                                                                         |

SEM0217 seeds come from `catchFailure` handlers (the handler instance and the Effect it returns)
and close over inherited edges only. The `protected` argument of `observeDiagnostics` and an
independently started `Execution` body are independent edges, so a fresh observation starts with
no selected failure. SEM0217 is suppressed whenever recovery or a call is unresolved.

### 1.2 Callback protocol

Every event is one call `callback(&mut state, event, first, second, identity, origin) -> usize`
through a single `noinline` dispatch helper. A null observer returns `0` without calling.

| Event       | Emitted                                                                                                                                      | `first`, `second`, texts                                 |
| ----------- | -------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| 0 origin    | `fail` (identity chosen by the runtime tag for a union payload); allocation refusal                                                          | `0, 0`, identity, origin                                 |
| 1 frame     | every failure path that leaves a `run` site outward, and the generated propagation of `ensuring`, use/release and unselected `catch` members | old handle, `0`, frame label, `""`                       |
| 2 cause     | right after event 0 when the current selected failure belongs to this observer                                                               | new handle, cause handle, `""`, `""`                     |
| 3 retain    | defined, never emitted                                                                                                                       | -                                                        |
| 4 release   | overwriting or completing an outcome slot, a selected recovery that succeeds, every return, scope exit, cancelled frames                     | handle, `0`                                              |
| 5 unhandled | `observeUnhandled()`                                                                                                                         | selected handle, `0`, fallback identity, fallback origin |
| 6 fatal     | an observed trap block (overflow, division by zero, shift count, bounds, invalid outcome tag, MIR `Trap`)                                    | selected handle or `0`, `0`, reason, trap origin         |

Texts are static. Identity is the canonical type encoding (`memory/driver.NotFoundError`).
Origin and frame labels are `<module>.<function> (<source>:<line>:<column>)`, 1-based, with
compiler-generated Effect suffixes stripped. A frame label names the propagating caller and its
`run` span.

### 1.3 Threading

- A module-wide switch: if any function contains a `DiagnosticScope`, **every** non-machine
  function (ordinary, `effect`, drop glue, Execution helpers, callbacks) takes two trailing
  parameters, an observer pointer and a cause record `{observer, handle, identity, origin}`. A
  function whose `EffectOutcome` has a failure member also returns a cause record next to the
  outcome. Otherwise nothing changes.
- Each invocation keeps a current observer and a current cause, initialised from its arguments.
  Ordinary calls pass both. Independent calls (the callback itself, `Execution.drive` bodies, C
  exports) pass null for both.
- Entering a scope stores `{dispatch, state, captures, previous observer, previous cause}` and
  makes it current; the scope body starts with a null cause. Leaving releases outcomes and
  restores both.
- A catch handler's blocks load the cause from the caught outcome's record; calls from the
  handler inherit it. `ensuring` does not select its pending failure. `mapError` is
  `catchFailure` plus `fail` in the handler, so its new failure gets the original as a cause.
  Provider bindings are ordinary calls and inherit both.
- `observeUnhandled` borrows the current cause and dispatches to its owning observer only when that
  observer is current; otherwise it returns `0`. It does not consume the handle.

### 1.4 What gets printed

`native_diagnostics` keeps a fixed pool of reference-counted nodes (origin, frame, cause) and
renders event 5 through `native_report`:

```text
unhandled error: memory/driver.NotFoundError
  at memory/driver.load (memory/driver:4:3)
  at memory/driver.middle (memory/driver:8:11)
  at memory/driver.main (memory/driver:13:11)
  at silk/effect.Effect.flatMap (silk/effect:301:19)
```

Then each cause as `while handling: <identity>` with its own frames. With handle `0`, the
fallback identity and origin are printed followed by `  [trace truncated]`. Event 5 returns policy
`1`. `native_start` observes startup with capacity 0 and the application with 64 nodes, 4096 bytes
and 32 frames; its handler `failed` drops the payload, then returns `observeUnhandled()` as the
exit status (TERM-003, TERM-011).

Corpus programs with failure reports: `native-termination-logical-path`,
`native-termination-while-handling`, `native-termination-cleanup-preserves-primary`,
`native-termination-active-union-member`, `native-termination-cross-module-frame` and
`native-termination-fatal-trap`. All are `pub effect fn main` programs.

## 2. Native design

### N1. The observer is a lexical, specialized slot

`observeDiagnostics` builds an exact composite like the other composition intrinsics (Effect note
D1): environment `{state, callback, body}`, type `EffectComposite { Observe, parts: [S, F, B] }`
with the contract `once Effect<A ! never ? R>`. Running it expands at the run site (D4) as the
`RunPlan.Observe` step:

1. Borrow the state: `_s = Ref(mut, env.0)`, type `&mut S`.
2. Run `body` (part 2) with observer `_s` and no selected failure (§N2).
3. Drop the state with the environment.

The observer reaches instances like a provider (D2), with one difference: it is inherited by every
callee, not selected by a row.

- `InstanceKey.Function` gains `observer: Option<Shared<Observer>>`, where
  `Observer { state: S, callback: InstanceKey }`. The state type and the callback's instance are
  part of the runtime identity, exactly like a provider type.
- The callback must be a direct function (a named `fn` value): an observed instance calls the
  callback's instance with exactly the six written operands. A capturing callback reports the
  `observer-callback` gap.
- An observed instance has two hidden locals, `LocalKind.Observer` (the `&mut S` address) and
  `LocalKind.Cause` (§N2), passed after the providers.
- Semantic call preparation (`provideCall`) gives every callee the observer of the call site: the
  innermost enclosing `Observe` step, else the instance's own. `Terminator.Call` gains
  `diagnostics: Option<Diagnostics { observer, cause }>`, present exactly when the callee key is
  observed.
- The callback is the one independent edge: it is called unobserved, with no hidden operands, so it
  cannot observe itself (SEM0216's recursion case cannot arise at run time).
- The root and every instance reached only outside observation have `observer = None`: no hidden
  locals, no companions and no ABI change.

### N2. The selected failure is a hidden cause address

`LocalKind.Cause` holds the address of the context companion (§N3) of the failure the current
recovery handler is handling. "Nothing selected" is the address of a companion whose identity is
empty, so no null pointers are needed.

| Call site                                                            | Cause operand passed                                  |
| -------------------------------------------------------------------- | ----------------------------------------------------- |
| a handler run by a `Catch` step                                      | the caught temporary's companion address              |
| the body run by an `Observe` step                                    | an empty companion (a fresh observation selects none) |
| finalizers, `release`, provider bindings, joins and every other call | the caller's own `Cause` (inherited, not selected)    |

The companion of a caught temporary lives in the frame that runs the handler, so the address stays
valid for the whole handler run. This is FAIL-006: an `ensuring` failure keeps its context but is
not selected inside the finalizer.

### N3. The failure context companion is an ordinary local

Every failure slot of an observed instance has a companion local of the ordinary type
`[string<'static>; 2]`: the failure's identity and its origin label. Failure slots are the
`Failure` local and every temporary a failure moves through (failure-edge destinations, catch and
finalizer temporaries). The companion of `Failure` is `LocalKind.Context`, a second caller-owned
out-slot.

The reserved `Statement.FailureContext` is not needed and is retired. Every context operation is
ordinary MIR:

- **Raise.** `fail x` emits `Assign(Failure, x)`, then `Assign(Context, Aggregate [identity,
label])` of two static strings, then the drop chain and `Fail`. When the `Failure` type is a
  structural union, a `Discriminant` and `Switch` select the active member's identity.
- **Carry.** Every move of a failure between slots (`propagateFailure`, a catch sink, a residual
  member) moves the companion with it: `Assign(to', Use(Move from'))`.
- **Call edges.** `FailureEdge` gains `context: Option<Place>`, the companion of its destination,
  present exactly when the callee is observed. The callee writes it with its failure.
- **Discard.** A handler that succeeds simply stops using the caught companion. Origin-only context
  owns no resource.

Identity is the canonical type name (`module.Name<Arguments>`, primitives by spelling, `()`); other
failure types report the `failure-identity` gap. The label is `<module>.<function>
(<module>:<line>:<column>)`, 1-based, rendered while building MIR from the instance's module
source. Layout and LLVM emission only see constant strings.

ABI of an observed instance, after the written parameters and providers:

```text
f(arguments..., providers..., observer: address, cause: address)                       -> A
f(arguments..., providers..., observer, cause, success: address, failure: address,
  context: address)                                                                     -> status
```

### N4. The readers

- **`observeDiagnostics`**: the `Observe` run plan of N1. Its body's failure row is empty by
  typing, so no failure, and therefore no context, ever leaves an observation.
- **`observeUnhandled()`** in an observed instance:

  ```text
  _n = SliceLength((*cause)[0]); Branch(_n != 0) -> bb1, bb2
  bb1: Call callback(observer, 5u8, 0, 0, (*cause)[0], (*cause)[1]) -> _r   // unobserved
  bb2: _r = 0
  ```

  In an unobserved instance it is the constant `0`, which is what the bootstrap's null observer
  returns. Origin-only context passes handle `0`, so `native_diagnostics` prints the identity and
  origin followed by `  [trace truncated]`. The trace marker is the honest TERM-004 presentation
  of missing frames.

Both readers stay sealed `Intrinsic` members. The compiler knows only the callback's event
protocol, never `NativeDiagnostics`, `NativeReport` or the report policy.

### N5. Context through every Effect form

| Form                                     | Failure path                                                    | Context                                                                                  |
| ---------------------------------------- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| direct `run f(a)`                        | edge into a temporary, widen into `Failure`, drop chain, `Fail` | callee writes the temporary's companion; `Carry` into `Failure`                          |
| `catchFailure`                           | edge into the caught temporary, switch                          | selected: handler gets the companion address as its cause. Residual: `Carry` to the sink |
| `finalizeEffect`, `useReleaseNonParking` | hold in a temporary, run the finalizer or `release`, deliver    | `Carry` into the hold and out of it; the finalizer inherits the caller's cause           |
| `bindRequirement*`                       | unchanged                                                       | inherited, like every call                                                               |
| EFF-013 joins                            | one runner per arm                                              | per arm, like a direct run                                                               |
| `observeDiagnostics`                     | none (empty failure row)                                        | body starts with an empty cause                                                          |

### N6. Cost model

- Unobserved code: identical MIR, ABI and machine code to today. This is stronger than the
  bootstrap, whose switch is module-wide once any scope exists, and it needs no build mode, unlike
  Zig's `ReleaseFast`.
- Observed code: two hidden addresses per call; per fallible call one more out-address; per `fail`
  two stores of constant strings (plus a tag-indexed load for union payloads); per carried failure
  a 4-word copy. No callback runs until `observeUnhandled`.
- Code size: an instance reached both inside and outside observation is emitted twice, like an
  instance reached with two provider types. `native_start` reaches the application only inside its
  observers, so in practice only startup helpers duplicate.

### N7. Logical frames and causes (follow-up)

The follow-up keeps the same locals and edges; it adds calls, not forms.

- The companion gains a `handle` (a node of the observer's pool, `0` when refused).
- Raise calls the callback with event 0, then event 2 with the selected cause's handle when one is
  selected, and releases the plain node, matching the bootstrap order.
- A carry on a `run` site's failure edge calls event 1 with the propagating caller's label.
  Carries inside one expansion do not.
- A selected handler that succeeds, an overwritten companion and a dropped temporary call event 4.
- `observeUnhandled` passes the cause's handle. Observed traps call event 6 before `Trap`.
- Releasing on every exit makes the companion a cleanup owner. That is the one real change to
  Step 6's cleanup stack.

## 3. What becomes reachable

Nothing in the corpus. Every program with a failure report is a `pub effect fn main` program, so
it needs `silk/native_start` (ENTRY-001). `native_start` runs the application through
`Execution.make` and `Execution.drive`, which stay `intrinsic-member` until the suspension stage.
Decision Q1 keeps the `Entry { main }` shim until then; this note does not change it.
`test_runner.silk` is compiled by the bootstrap's `silk test`, never by selfhost today.

The origin-only step is therefore proven by structured MIR tests (§6). A program that installs its
own observer from `fn main() -> i32` already runs under the bootstrap. For example, a callback that
prints `identity` and `origin` on event 5 and returns `1` prints `main.Missing` and
`main.load (main:29:37)` and exits through the handler. That is a candidate corpus program (Q9).

## 4. Gap codes

| Code                | Change    | Raised where                                                               | Exit condition                       |
| ------------------- | --------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `intrinsic-member`  | narrower  | `execution*`, `wake`; no longer `observeDiagnostics` or `observeUnhandled` | suspension stage                     |
| `observer-callback` | **new**   | an `observeDiagnostics` callback that is not a direct function             | callback environments in the slot    |
| `failure-identity`  | **new**   | an observed `fail` of a type other than a nominal, primitive or unit type  | identity rendering for the remainder |
| `entry-signature`   | unchanged | as before                                                                  | Q1                                   |

Drop glue keys (`InstanceKey.DropGlue`) do not carry an observer in the origin-only step, so a
`Drop` hook runs unobserved. Drop glue cannot fail, so the only observable effect is an
`observeUnhandled()` inside a handler that a `Drop` hook runs: it returns `0` and reports nothing.
That is a recorded divergence (§5), retired by observed drop glue in N7.

## 5. Bootstrap parity and COMPILER_COMPATIBILITY.md

| Area                   | Bootstrap                                                | Native after the origin-only step                                      | Observable?                                        |
| ---------------------- | -------------------------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------------- |
| observer reach         | module-wide switch, every function, dispatch via pointer | specialized slot inherited by observed instances, direct callback call | no                                                 |
| context content        | pool handle plus fallback identity and origin            | identity and origin                                                    | yes: no frames, report ends in `[trace truncated]` |
| causes (TERM-006)      | `while handling` chains                                  | none                                                                   | yes                                                |
| fatal traps (TERM-008) | observed traps report event 6                            | bare trap                                                              | yes                                                |
| SEM0216, SEM0217       | executable-closure analysis                              | not diagnosed; a context-free `observeUnhandled` returns `0`           | yes: missing compile-time diagnostics              |
| observed `Drop` hooks  | inherit observer and cause                               | run unobserved                                                         | yes: `observeUnhandled` inside one returns `0`     |

**COMPILER_COMPATIBILITY.md:** the PR that first lowers `observeUnhandled` adds one entry, "Selfhost
failure reports carry origin only", listing the rows above with their exit conditions (N7 for
frames, causes, fatal and drop glue; the suspension-stage analysis pass for SEM0216 and SEM0217).
It is not added before then, as the Effect note §5 requires. The entry-shim entry is unchanged.

## 6. Tests and corpus

All structured and cheap, in `SemanticCases.silk`, one shared source per test:

- **Typing.** `observeDiagnostics` accepts the exact composite and rejects a fallible body (the
  SEM0052 counterpart) and a callback of the wrong shape, asserted by code and span.
  `observeUnhandled()` types as `usize`.
- **MIR shape.** An `Observe` run passes an observer and an empty cause to the body. An observed
  `fail` writes the context once per union member, with the expected identity and label. An
  observed catch passes the caught companion to its handler, and its edge names the companion. An
  unobserved instance has no hidden locals. `observeUnhandled` calls the callback unobserved, and
  in an unobserved instance it is `0`.

No corpus program changes status (§3), so `selfhostTrack.ts` and `baselinePasses` stay as they are;
CI must still show 0 FAIL and no lost PASS.

## 7. Implementation order

1. **This note** (docs only).
2. **Origin-only context and both readers.** Typing of both intrinsics, `Composition.Observe`,
   `RunPlan.Observe`, the observer slot in `InstanceKey`, hidden locals, companions, recipe and
   LLVM, the compatibility entry, and the Effect note's §4, §5 and §7 updated. It extends Step 9d's
   hidden-operand path.
3. **Frames and causes** (N7), then observed drop glue and fatal traps.
4. **SEM0216 and SEM0217**, with the suspension stage's executable-closure summary.

## 8. Privilege

| Piece                                                                  | Owner                                                                |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------- |
| observer slot, cause slot, companions, the event protocol's call sites | compiler (MIR lowering and emission)                                 |
| `observeDiagnostics`, `observeUnhandled`                               | sealed `Intrinsic`, already cataloged                                |
| node pool, report text, limits, policy `1`, exit status                | `silk/native_diagnostics`, `silk/native_report`, `silk/native_start` |

No standard-library declaration is recognized by name. The event numbers are the only contract
between the compiler and the library, and the bootstrap already fixes them.

## 9. Open questions

Each has a recommendation; the implementation follows it until Julia decides otherwise.

1. **Observer reach.** Specialize instances on the observer (state type and callback instance) and
   pass the state's address (as above), or copy the bootstrap's module-wide switch with a pointer-dispatched
   callback? **Recommended: specialize.** It is the provider mechanism Julia already approved (D2),
   it keeps unobserved code unchanged, and it never calls through a function pointer. The cost is
   duplicated instances reached both inside and outside observation.
2. **Inherit the observer to every callee, or only to callees that can reach an event?**
   **Recommended: every callee for now.** Pruning needs a transitive "reaches an event" summary,
   the same deferred pruning as unused provider rows (D2). Revisit with that summary.
3. **Companion content for origin-only.** Two static strings, a one-word pointer to a static site
   record, or a pool handle from the start? **Recommended: two strings.** They are the callback's
   own arguments, so no site table is needed, and a union payload only needs a per-type identity
   table. The handle joins in the frames step.
4. **Companion ABI.** A third failure out-address, or a companion embedded in the failure slot's
   layout? **Recommended: a third out-address** in observed instances only. It leaves `E`'s layout,
   `Payload` and `Inject` untouched, and unobserved instances keep the D3 ABI exactly.
5. **The reserved `FailureContext` statement.** Keep it, or express context as ordinary companion
   locals, assignments and calls? **Recommended: ordinary MIR, and retire the statement.** Raise
   and carry are plain assignments, the frames step adds plain calls, and MIR keeps its rule of no
   Effect-specific forms. Texts are rendered while building MIR, where source and names exist.
6. **`observeUnhandled` with origin-only context.** Pass handle `0` with the companion's texts (the
   report ends in `[trace truncated]`), or create and release an origin node so the report looks
   complete? **Recommended: handle `0`.** One callback call, no pool use, and the truncation marker
   tells the truth about the missing frames.
7. **SEM0216 and SEM0217.** Diagnose them now with a selfhost approximation, or record a
   divergence until the executable-closure summary exists? **Recommended: record a divergence.** An
   approximation would either reject valid source or miss cases. A context-free `observeUnhandled`
   returns `0` at run time, which is the bootstrap's own null-observer behavior.
8. **Observed `Drop` hooks.** Give drop glue an observer slot in the first step, report a gap at
   every observed `Drop` of a hooked type, or run drop glue unobserved? **Recommended: run it
   unobserved and record the divergence.** Drop glue cannot fail, so only a handler inside a `Drop`
   hook that calls `observeUnhandled` differs (it returns `0`). A gap would block every observed
   program that drops a `Vector`. Observed drop glue belongs with the cleanup-owner change of N7.
9. **A corpus program for the reader.** Add a main-first corpus program (for example
   `diagnostic-observer-origin`: a custom callback reporting identity and origin from `fn main() ->
i32`) so the reader is proven natively before `native_start` compiles? **Recommended: yes, as a
   separate main-first PR** (the corpus is a bootstrap path). The program must not print module
   names, because the bootstrap harness names the root `memory/driver` and the selfhost runner
   names it `main`. It should check the identity and label suffixes instead.
10. **Entry.** Keep Q1 (no `effect fn main` adapter) even though an observer can now be lowered?
    **Recommended: keep Q1.** The termination programs need `native_start`'s `Execution`, not just
    the observer, and an adapter would duplicate source policy in the compiler.
