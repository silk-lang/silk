# Failure observer and diagnostic context (native backend)

**Status:** draft design, roadmap [#567](https://github.com/julia-script/silk/issues/567),
decision Q2 of [the Effect calling convention](effect-calling-convention.md) §7. Due before
milestone (i-b). Julia decided §9 questions 1, 2 and 5 on 2026-10-05; the other questions carry
recommendations that the implementation follows until she answers. Sources: bootstrap `main`
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

Observation is a whole-program switch, as in the bootstrap and Zig. A program that runs no
`observeDiagnostics` scope is compiled exactly as today. A program that runs one gives every Silk
function two hidden addresses: the current observer and the failure the current handler is
recovering from. Its fallible functions also return the failure's context.

The first native step is origin only: identity and origin, no logical frames and no `while
handling` causes. Frames and causes follow (N7) on the same `FailureContext` statements.

## 1. What the bootstrap does

### 1.1 The two intrinsics

| Intrinsic                                                                                                     | Signature                                                                                                                                                          | Checks                                                                                                                                                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `observeDiagnostics<S, A, ?R, F>(state: S, observer: F, protected: once Effect<A ? R>) -> once Effect<A ? R>` | `F: fn<'static>(&mut S, u8, usize, usize, string<'static>, string<'static>) -> usize + Intrinsic.NonParking`, shared access; `protected` has the empty failure row | A `protected` that can fail, or a callback of another shape, is an argument mismatch at that argument (SEM0012). SEM0216 when the callback's execution closure is not provably direct (unavailable summary, a suspension mode, or a reachable nested observation). |
| `observeUnhandled() -> usize`                                                                                 | no arguments                                                                                                                                                       | SEM0217 when the site is provably outside every selected recovery handler's inherited execution closure.                                                                                                                                                           |

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

### N1. Observation is a whole-program switch

`observeDiagnostics` builds an exact composite like the other composition intrinsics (Effect note
D1): environment `{state, callback, body}`, type `EffectComposite { Observe, parts: [S, F, B] }`
with the contract `once Effect<A ! never ? R>`.

**The switch.** A program observes diagnostics when any reached function runs an `Observe` step.
The build walks the instance graph once without observation. If any MIR reports `observes`, it
walks the graph again, lowering every function in observing mode. The mode is an input of the MIR
query, not part of `InstanceKey`, so no instance is specialized or duplicated per observer.

**Hidden parameters.** In observing mode every Silk function, including drop glue and the observer
callbacks themselves, takes two trailing addresses after its providers:

- `LocalKind.Observer`: the address of the current observer record `[callback address, state
address]`, or null;
- `LocalKind.Cause`: the address of the selected failure's context companion (§N2), or null.

Fallible functions also take a third failure out-address for the context (§N3). `Call.diagnostics`
and `Drop.diagnostics` carry both operands. Ordinary calls pass the caller's current pair.
Independent calls pass null for both: the callback call in `observeUnhandled` and the entry shim's
call of `main`. C exports and C callbacks are not lowered by selfhost yet.

**Running an observation.** The `RunPlan.Observe` step stores `FunctionAddress(callback)` and
`AddressOf(env.0)` into a record temporary, runs `body` (part 2) with that record's address and a
null cause, then drops the state. The callback must be a direct function, because its address is
what the record holds; a capturing callback reports `observer-callback`.

### N2. The selected failure is a hidden cause address

`LocalKind.Cause` holds the address of the context companion of the failure the current recovery
handler is handling, or null.

| Call site                                                            | Cause operand passed                               |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| a handler run by a `Catch` step                                      | `ContextOf(caught temporary)`                      |
| the body run by an `Observe` step                                    | null (a fresh observation selects nothing)         |
| finalizers, `release`, provider bindings, joins and every other call | the caller's own `Cause` (inherited, not selected) |
| the callback, the entry shim                                         | null                                               |

The companion of a caught temporary lives in the frame that runs the handler, so the address stays
valid for the whole handler run. This is FAIL-006: an `ensuring` failure keeps its context but is
not selected inside the finalizer.

### N3. `FailureContext` and fixed-size companions

The context travels through the reserved statement (Effect note §2, Julia's Q2 decision):

```text
Statement.FailureContext { destination: Place, source: Option<Place>, origin: Origin }
```

- **Originate.** `fail x` emits `Assign(Failure, x)`, then `FailureContext { Failure, None,
origin }`, then the drop chain and `Fail`. The texts it stores live in the function's
  `MirFunction.contexts` side table, keyed by origin: one canonical identity per canonical member
  of the `Failure` type (one entry when it is not a union) and the site label
  `<module>.<function> (<module>:<line>:<column>)`. Emission selects the active member's identity
  by the runtime tag.
- **Carry.** Every move or conversion of a failure between failure slots (`propagateFailure`, a
  catch sink, a residual member, a finalizer hold) emits `FailureContext { to, Some(from), origin }`
  next to the payload move.
- **Call edges.** A callee writes the companion of its `FailureEdge.destination` through its context
  out-address, so a call edge needs no statement.
- **Selection.** `Rvalue.ContextOf(slot)` is the address of a slot's companion, passed as a handler's
  cause.
- **Discard.** A handler that succeeds simply stops using the caught companion. Origin-only context
  owns no resource.

Layout gives every failure slot a fixed-size companion of four words, laid out as
`[string<'static>; 2]` (identity, label). The `Failure` local's companion is the caller's
`%context` out-address; every other failure slot that a statement, a `ContextOf` or an observing
call edge names gets its own companion in the frame. Identity is the canonical type name
(`module.Name<Arguments>`, primitives by spelling, `()`); other failure types report the
`failure-identity` gap. Texts are rendered while building MIR, where module source and declaration
names are available.

ABI of a function in an observing program, after the written parameters and providers:

```text
f(arguments..., providers..., observer: address, cause: address)                       -> A
f(arguments..., providers..., observer, cause, success: address, failure: address,
  context: address)                                                                     -> status
```

### N4. The readers

- **`observeDiagnostics`**: the `Observe` run plan of N1. Its body's failure row is empty by
  typing, so no failure, and therefore no context, ever leaves an observation.
- **`observeUnhandled()`** in observing mode:

  ```text
  Branch(observer != null & cause != null) -> bb1, bb2
  bb1: Call (*observer)[0]((*observer)[1], 5u8, 0, 0, (*cause)[0], (*cause)[1])
         diagnostics (null, null) -> _r
  bb2: _r = 0
  ```

  Without observation it is the constant `0`, which is what the bootstrap's null observer returns.
  Origin-only context passes handle `0`, so `native_diagnostics` prints the identity and origin
  followed by `  [trace truncated]`. The trace marker is the honest TERM-004 presentation of
  missing frames.

Both readers stay sealed `Intrinsic` members. The compiler knows only the callback's event
protocol, never `NativeDiagnostics`, `NativeReport` or the report policy.

### N5. Context through every Effect form

| Form                                     | Failure path                                                    | Context                                                                                |
| ---------------------------------------- | --------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| direct `run f(a)`                        | edge into a temporary, widen into `Failure`, drop chain, `Fail` | callee writes the temporary's companion; carry into `Failure`                          |
| `catchFailure`                           | edge into the caught temporary, switch                          | selected: handler gets the companion address as its cause. Residual: carry to the sink |
| `finalizeEffect`, `useReleaseNonParking` | hold in a temporary, run the finalizer or `release`, deliver    | carry into the hold and out of it; the finalizer inherits the caller's cause           |
| `bindRequirement*`                       | unchanged                                                       | inherited, like every call                                                             |
| EFF-013 joins                            | one runner per arm                                              | per arm, like a direct run                                                             |
| `observeDiagnostics`                     | none (empty failure row)                                        | body starts with a null cause                                                          |

### N6. Cost model

- A program without observation: identical MIR, ABI and machine code to today, with no build mode.
- A program with observation: every Silk call passes two more addresses; every fallible call one
  more out-address; every `fail` two stores of constant strings (plus a tag select for union
  payloads); every carried failure a four-word copy. No callback runs until `observeUnhandled`,
  which calls it through the record's address.
- Code size: no duplication; each instance is emitted once, in the program's mode. Building an
  observing program lowers MIR twice (the first walk only discovers the switch) and keeps both
  modes' MIR in the query cache. Dropping the unobserving answers after the switch is a memory
  follow-up.

### N7. Logical frames and causes (follow-up)

The follow-up attaches to the same `FailureContext` statements and hidden operands.

- The companion gains a `handle` (a node of the observer's pool, `0` when refused).
- An originating statement calls the callback with event 0, then event 2 with the selected cause's
  handle when one is selected, and releases the plain node, matching the bootstrap order.
- A carrying statement on a `run` site's failure edge calls event 1 with the propagating caller's
  label. Carries inside one expansion do not.
- A selected handler that succeeds, an overwritten companion and a dropped temporary call event 4.
- `observeUnhandled` passes the cause's handle. Observed traps call event 6 before `Trap`.
- Releasing on every exit makes the companion a cleanup owner. That is the one real change to
  Step 6's cleanup stack.

Drop glue already takes the hidden pair in observing programs, so `Drop` hooks observe like any
other function; N7 needs no drop-glue key change.

## 3. What becomes reachable

Nothing in the corpus. Every program with a failure report is a `pub effect fn main` program, so
it needs `silk/native_start` (ENTRY-001). `native_start` runs the application through
`Execution.make` and `Execution.drive`, which stay `intrinsic-member` until the suspension stage.
Decision Q1 kept the `Entry { main }` shim until then. Selfhost has since removed it: every build
roots at its runtime's C exports, `silk/native_start` by default.
`test_runner.silk` is compiled by the bootstrap's `silk test`, never by selfhost today.

The origin-only step is therefore proven by structured MIR tests (§6). A program that installs its
own observer from `fn main() -> i32` already runs under the bootstrap. For example, a callback that
prints `identity` and `origin` on event 5 and returns `1` prints `main.Missing` and
`main.load (main:29:37)` and exits through the handler. That is a candidate corpus program (Q9).

One more gap sits between the readers and `native_diagnostics`, outside this note: its
`observeWith(move state, onEvent, body)` wrapper passes a named callback to a bounded generic `F`.
Selfhost lowers that callback argument in the wrapper's caller as `typed-form` today (found while
testing step 2). A direct `Intrinsic.observeDiagnostics(state, onEvent, body)` lowers. The
callable-value follow-up owns it.

## 4. Gap codes

| Code                | Change    | Raised where                                                               | Exit condition                       |
| ------------------- | --------- | -------------------------------------------------------------------------- | ------------------------------------ |
| `intrinsic-member`  | narrower  | `execution*`, `wake`; no longer `observeDiagnostics` or `observeUnhandled` | suspension stage                     |
| `observer-callback` | **new**   | an `observeDiagnostics` callback that is not a direct function             | callback environments in the record  |
| `failure-identity`  | **new**   | an observed `fail` of a type other than a nominal, primitive, string or unit type | identity rendering for the remainder |
| `entry-signature`   | removed   | no generated entry; every build roots at its runtime's C exports           | default runtime selection            |

## 5. Bootstrap parity and COMPILER_COMPATIBILITY.md

| Area                                | Bootstrap                                                                                          | Native after the origin-only step                                                                | Observable?                                        |
| ----------------------------------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ | -------------------------------------------------- |
| observer reach                      | whole-program switch, every function, callback dispatch through a pointer                          | the same: whole-program switch, every function, callback called through the record's address     | no                                                 |
| context content                     | pool handle plus fallback identity and origin                                                      | identity and origin                                                                              | yes: no frames, report ends in `[trace truncated]` |
| causes (TERM-006)                   | `while handling` chains                                                                            | none                                                                                             | yes                                                |
| fatal traps (TERM-008)              | observed traps report event 6                                                                      | bare trap                                                                                        | yes                                                |
| SEM0216, SEM0217                    | executable-closure analysis                                                                        | not diagnosed; a context-free `observeUnhandled` returns `0`                                     | yes: missing compile-time diagnostics              |
| `observeDiagnostics` type arguments | required (SEM0051 when omitted); a fallible body or misshapen callback is SEM0012 at that argument | inferred from the operands when omitted; the same mismatches are `TypeMismatch` at that argument | yes: selfhost accepts the omitted form             |

**COMPILER_COMPATIBILITY.md:** the PR that first lowers `observeUnhandled` adds one entry, "Selfhost
failure reports carry origin only", listing the rows above with their exit conditions (N7 for
frames, causes and fatal traps; the suspension-stage analysis pass for SEM0216 and SEM0217).
It is not added before then, as the Effect note §5 requires. The entry-shim entry is unchanged.

## 6. Tests and corpus

All structured and cheap, in `SemanticCallableCases.silk`, one shared source per test:

- **Typing.** `observeDiagnostics` accepts the exact composite and rejects a fallible body (the
  bootstrap's SEM0012) and a callback of the wrong shape (SEM0012), asserted by code and span.
  `observeUnhandled()` types as `usize`.
- **MIR shape.** A program running an observation is marked `observes`; in observing mode every
  function has the hidden pair, an `Observe` run passes its record and a null cause, each `fail`
  originates one `FailureContext` with the expected identities and label, and a handler's cause is
  the `ContextOf` the failure edge's slot reached through carries. `observeUnhandled` calls the
  callback indirectly with null diagnostics; without observation nothing is threaded and it is `0`.
- **Emission.** The ABI order, the `%context` stores and the caller's fixed-size companion.

No corpus program changes status (§3), so `selfhostTrack.ts` and `baselinePasses` stay as they are;
CI must still show 0 FAIL and no lost PASS.

## 7. Implementation order

1. **This note** (docs only).
2. **Origin-only context and both readers.** Typing of both intrinsics, `Composition.Observe`,
   `RunPlan.Observe`, the whole-program switch, hidden locals, `FailureContext`, companions, recipe
   and LLVM, the compatibility entry, and the Effect note's §4, §5 and §7 updated.
3. **Frames and causes** (N7), then fatal traps.
4. **SEM0216 and SEM0217**, with the suspension stage's executable-closure summary.

## 8. Privilege

| Piece                                                              | Owner                                                                |
| ------------------------------------------------------------------ | -------------------------------------------------------------------- |
| the switch, observer and cause slots, companions, event call sites | compiler (MIR lowering and emission)                                 |
| `observeDiagnostics`, `observeUnhandled`                           | sealed `Intrinsic`, already cataloged                                |
| node pool, report text, limits, policy `1`, exit status            | `silk/native_diagnostics`, `silk/native_report`, `silk/native_start` |

No standard-library declaration is recognized by name. The event numbers are the only contract
between the compiler and the library, and the bootstrap already fixes them.

## 9. Questions

Julia decided questions 1, 2 and 5 on 2026-10-05. The others carry recommendations that the
implementation follows until she answers.

1. **Observer reach. Decided: a whole-program switch.** When the program reaches any
   `observeDiagnostics` scope, every non-machine function takes the observer and cause, and
   fallible functions return the context; otherwise nothing is threaded. No instance is specialized
   per observer.
2. **Which callees receive the observer. Decided with 1:** every function of an observing program.
3. **Companion content for origin-only.** Two static strings, a one-word pointer to a static site
   record, or a pool handle from the start? **Recommended: two strings.** They are the callback's
   own arguments, so no site table is needed, and a union payload only needs a per-type identity
   selection. The handle joins in the frames step.
4. **Companion ABI.** A third failure out-address, or a companion embedded in the failure slot's
   layout? **Recommended: a third out-address**, in observing programs only. It leaves `E`'s
   layout, `Payload` and `Inject` untouched.
5. **The reserved `FailureContext` statement. Decided: keep it.** Origin and carry go through the
   statement, so N7's frame events and release calls attach to the same statement.
6. **`observeUnhandled` with origin-only context.** Pass handle `0` with the companion's texts (the
   report ends in `[trace truncated]`), or create and release an origin node so the report looks
   complete? **Recommended: handle `0`.** One callback call, no pool use, and the truncation marker
   tells the truth about the missing frames.
7. **SEM0216 and SEM0217.** Diagnose them now with a selfhost approximation, or record a
   divergence until the executable-closure summary exists? **Recommended: record a divergence.** An
   approximation would either reject valid source or miss cases. A context-free `observeUnhandled`
   returns `0` at run time, which is the bootstrap's own null-observer behavior.
8. **Observed `Drop` hooks.** Settled by 1: drop glue takes the hidden pair like any function.
9. **A corpus program for the reader.** Add a main-first corpus program (for example
   `diagnostic-observer-origin`: a custom callback reporting identity and origin from `fn main() ->
i32`) so the reader is proven natively before `native_start` compiles? **Recommended: yes, as a
   separate main-first PR** (the corpus is a bootstrap path). The program must not print module
   names, because the bootstrap harness names the root `memory/driver` and the selfhost runner
   names it `main`. It should check the identity and label suffixes instead.
10. **Entry.** Keep Q1 (no `effect fn main` adapter) even though an observer can now be lowered?
    **Recommended: keep Q1.** The termination programs need `native_start`'s `Execution`, not just
    the observer, and an adapter would duplicate source policy in the compiler.
