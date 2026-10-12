# Typed failures

A typed failure is an ordinary Silk value carried through an Effect's failure channel. Failure
values do not implement a marker interface, inherit from an error hierarchy, or receive a wrapper
before they may be used with `fail`.

## Terminology

These terms have the following meanings throughout the language reference:

| Term                          | Definition                                                                                                                                                                                                                                                                     |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Typed failure**             | An unsuccessful Effect outcome carrying a value compatible with the Effect's failure type `E`.                                                                                                                                                                                 |
| **Failure payload**           | The value carried by one typed failure. In `fail "not found"`, the string value is the payload.                                                                                                                                                                                |
| **Failure type**              | The ordinary type `E` in `Effect<A ! E>`. Multiple alternatives use an ordinary union such as `NotFoundError \| InvalidInputError`; `never` means no possible typed failure.                                                                                                   |
| **Concrete type**             | A complete value type that is known when executable code is specialized. A generic function may name an ordinary type parameter while being checked, but every executable specialization resolves it to a concrete type.                                                       |
| **Owned value**               | A value that is not a borrow. The value carries responsibility for releasing the resources it owns. Moving an affine owned value transfers that responsibility; copying a `Copy` value creates an independent value.                                                           |
| **`Copy` value**              | A value that an ordinary read may duplicate. Reading it does not consume the original binding.                                                                                                                                                                                 |
| **Affine value**              | A value that cannot be duplicated implicitly. It has one owner at a time and must be moved to transfer that ownership.                                                                                                                                                         |
| **Move**                      | An ownership transfer written as `move value`. The destination becomes responsible for the value, and the source binding is no longer available on that continuing control-flow path.                                                                                          |
| **Detached value**            | A value that remains valid independently of the lexical scope and service providers where it was created. It owns everything required to remain valid or refers only to program-lifetime immutable data. It contains no escaping lexical borrow or provider-dependent storage. |
| **Self-contained allocation** | Storage whose ownership and cleanup authority travel with the value. An owning `String` or vector may therefore be detached even though it uses allocated memory.                                                                                                              |
| **Nominal type**              | A type identified by its declaration name rather than only by its representation. Two structs with identical fields remain different nominal types.                                                                                                                            |
| **Abortive expression**       | An expression that stops the current execution path instead of producing an ordinary value. Statements after an unconditional abortive expression are unreachable.                                                                                                             |
| **`never`**                   | The success type of an expression that cannot produce a success value. It is compatible with any expected success type because no value reaches that context.                                                                                                                  |
| **Propagate**                 | Forward a typed failure from one Effect execution to an enclosing Effect without recovering it or converting it into an ordinary value.                                                                                                                                        |
| **Enclosing Effect contract** | The success, failure, and requirement channels declared by the `effect fn` or `effect {}` body containing an operation.                                                                                                                                                        |
| **Residual failure type**     | The ordinary type still able to propagate after recovery and other Effect transformations have been applied.                                                                                                                                                                   |
| **Protected Effect**          | The Effect whose failure outcome a recovery operation observes. Successful execution bypasses the recovery handler.                                                                                                                                                            |
| **Recovery handler**          | A callable that receives an owned failure payload and constructs the Effect that runs for that failure.                                                                                                                                                                        |
| **Recover**                   | Handle a typed failure and continue the composed Effect with the handler's outcome instead of propagating that failure unchanged.                                                                                                                                              |
| **Normalized union**          | A union with unreachable `never` members and duplicate types removed. A one-member union is that member itself.                                                                                                                                                                |
| **Selected failure type**     | The nonempty ordinary type or union `S` that one recovery operation handles. `S` must be contained in the protected failure type `E`.                                                                                                                                          |
| **Union subset**              | A type whose every union alternative also occurs in another type. `NotFoundError                                                                                                                                                                                               | string`is a subset of`NotFoundError | string | OfflineError`. |
| **Union difference**          | The ordinary type operation `Without<E, S>`, which removes every alternative in `S` from `E`. It transforms a type; it does not by itself transform or discard a runtime value.                                                                                                |
| **Structured exit**           | Leaving one or more lexical scopes through ordinary language control flow, including `return`, `break`, `continue`, or typed-failure propagation. Every owner left behind is cleaned according to the ordinary ownership rules.                                                |
| **Diagnostic context**        | Hidden execution metadata retained for reporting a failure, such as its source origin and logical Effect call path. It is not part of the failure payload or failure type.                                                                                                     |
| **Logical Effect trace**      | The Effect execution path relevant to a failure, including its origin and meaningful execution boundaries even after the corresponding native stack frames have been exited.                                                                                                   |
| **Trap**                      | Fatal abnormal termination caused by an invalid runtime operation or violated invariant. A trap is not an Effect outcome, does not appear in `E`, and cannot be recovered.                                                                                                     |

“Detached” does not mean “contains no allocation.” It means that everything required to keep the
value valid and eventually clean it up travels with the value.

```silk,ignore
struct MessageView { text: string } // detached only when the text's backing data is detached
struct OwnedMessage { text: String } // owns its text; detached
```

A text literal has program-lifetime backing data and is detached. A `string` view formed from a
lexical owner retains that owner's loan and is not detached merely because the view is Copy.

The complete ownership rules are defined under
[ownership and borrowing](ownership-and-borrowing.md).

## FAIL-001 — Any concrete lifetime-valid value may be a typed failure

**Status:** Confirmed

A failure payload does not need to conform to `Report`, `Error`, or any other marker interface. Its
type does not need to be nominal. Built-in values, named structs, and other concrete value types may
appear as an Effect's failure type when the particular payload remains valid through propagation,
recovery and cleanup and can be transferred by value. An affine payload transfers ownership; a Copy payload copies its complete valid value.

A generic value-kind parameter may stand for that ordinary failure type while its declaration is
checked. If an inferred `effect {}` block executes `fail move problem` for `problem: E`, its failure
channel retains symbolic `E`; each reachable specialization substitutes one concrete lifetime-valid
value type. The compiler does not discard the failure merely because it is not nominal yet.

```silk
effect fn read() -> i32 ! string {
  fail "not found"
}
```

Nominal structs remain useful when an API needs distinct failure categories:

```silk
struct NotFoundError { id: i32 }
struct PermissionDeniedError { id: i32 }

effect fn read(id: i32) -> i32 ! NotFoundError | PermissionDeniedError {
  fail NotFoundError { id: id }
}
```

The `Error` suffix follows the
[language naming convention](style-guide.md#style-001--nominal-error-types-use-the-error-suffix).
Neither the suffix nor the struct declarations opt the values into a special error system.

**Boundary:** A failure may borrow external storage when its declared lifetime relationships keep
that storage valid through propagation, recovery and cleanup. Nested fields and generic payloads
retain those relationships. A failure cannot borrow a local or consumed capture destroyed before
the payload's eventual use.

```silk
effect fn borrowed<'data>(message: &'data string) -> i32 ! &'data string {
  fail message
}
```

**Diagnostics:** An unresolved failure type receives the ordinary type diagnostic. Violated
lifetime bounds report `SEM0212`; expired payload storage reports `OWN0019`.

After a generic failure specializes successfully, an ordinary `run` that does not propagate or
recover that concrete failure reports `SEM0066`, just as it does for a directly written nominal
failure.

Using a non-nominal concrete type is valid and produces no diagnostic.

**Current compiler:** Failure channels preserve ordinary ownership and nested lifetimes through
generic propagation and recovery. Detachment is checked separately at independent execution
boundaries.

**Evidence:** [confirmed stabilization decision](index.md),
[current row validation](../../../../packages/compiler/test/DeclarationIndex.test.ts),
[generic failure preservation](../../../../packages/compiler/test/EffectBlockTyping.test.ts),
[detachment diagnostics](../../../../packages/compiler/test/Elaboration.test.ts).

## FAIL-002 — `fail` follows ordinary ownership rules and has type `never`

**Status:** Confirmed

Executing `fail payload` aborts the current Effect execution and transfers the payload into its
typed-failure channel. The expression has success type `never`, so an Effect with any declared
success type may end by failing.

`fail` does not introduce a special ownership rule:

```silk
struct ProblemError { code: i32 }

effect fn fromTemporary() -> i32 ! ProblemError {
  fail ProblemError { code: 1 }
}

effect fn fromBinding(error: ProblemError) -> i32 ! ProblemError {
  fail move error
}

effect fn fromCopy(code: i32) -> i32 ! i32 {
  fail code
}
```

A newly constructed temporary already belongs to the expression and is consumed directly. Reading
a `Copy` binding copies its value. Transferring an affine binding requires `move`, exactly as it
does when passing or returning that value elsewhere.

`fail` may execute only inside an Effect body: either an `effect fn` body or an explicit
`effect {}` block. An ordinary function may construct an Effect containing `fail`; it may not
execute `fail` directly.

**Boundary:** Omitting `move` does not implicitly consume an affine binding.

```silk,ignore
struct ProblemError { code: i32 }

effect fn invalid(error: ProblemError) -> i32 ! ProblemError {
  fail error
}
```

Spelling `fail` directly in an ordinary function is also invalid:

```silk,ignore
fn invalid() -> i32 {
  fail 1
}
```

**Diagnostics:** An implicit transfer of an affine payload reports `OWN0003` at the payload and
identifies the binding that requires `move`. Executing `fail` outside an Effect body reports
`SEM0063` at the `fail` expression. Failing with a type absent from the enclosing Effect contract
reports `SEM0064` at the payload and names the missing failure type.

The `never` result of a valid `fail` is not a return-type mismatch and produces no diagnostic.

**Evidence:** [ownership rules](ownership-and-borrowing.md),
[effect-origin diagnostics](../../../../packages/compiler/test/Elaboration.test.ts).

## FAIL-003 — `run` propagates permitted typed failures

**Status:** Confirmed

When `run` executes an Effect that fails, it forwards the same owned failure payload through the
enclosing Effect. Statements after that `run` on the failing path do not execute. No additional
propagation operator is required.

```silk
struct NotFoundError {}

effect fn load() -> i32 ! NotFoundError {
  fail NotFoundError {}
}

effect fn program() -> i32 ! NotFoundError {
  let value = run load()
  return value + 1
}
```

If `load()` fails, `value` is not created and `return value + 1` is not executed. The
`NotFoundError` payload leaves `program` through its declared failure channel. Propagation does not
copy or convert the payload.

Calling `load()` without `run` only constructs `Effect<i32 ! NotFoundError>`. Construction does not
execute the body and therefore cannot produce or propagate its failure.

The residual failure type at a `run` site must be compatible with the enclosing Effect's declared
failure type. The enclosing type may contain additional union alternatives because declarations are
upper bounds. Named effect functions do not infer a missing failure type from `run`; omission means
`never`. See [Effect contracts](effect-contracts.md#eff-009--declared-failure-and-requirement-channels-are-upper-bounds).

An ordinary function has no failure channel, so its `run` operand must have residual failure type
`never`. An effect entry is handled separately by the generated program boundary, as defined under
[program entry](program-entry.md#entry-003--source-policy-handles-unhandled-outcomes).

**Boundary:** An enclosing Effect may not silently discard a propagated failure by omitting it from
the declaration.

```silk,ignore
struct NotFoundError {}

effect fn load() -> i32 ! NotFoundError {
  fail NotFoundError {}
}

effect fn invalid() -> i32 {
  return run load()
}
```

Adding a Rust-style `?` after `run` is neither required nor part of this rule. `run` already means
that a permitted failure propagates.

**Diagnostics:** If the residual failure type at `run` is not compatible with the enclosing
contract, `SEM0066` is reported at `run` and lists every unhandled failure type. The same diagnostic
applies inside an ordinary function, whose permitted failure type is `never`. Merely constructing
or returning a fallible Effect produces no propagation diagnostic.

**Evidence:** [Effect execution rules](effects-and-execution.md),
[declared channel bounds](effect-contracts.md),
[run propagation diagnostics](../../../../packages/compiler/test/Elaboration.test.ts).

## FAIL-004 — Recovery preserves every reachable success type

**Status:** Confirmed

A recovery handler may succeed with a type different from the protected Effect's success type. If
the protected Effect succeeds with `A` and the handler succeeds with `B`, the recovered Effect's
success type is the normalized union `A | B`.

```silk
import silk.effect { Effect }

struct NotFoundError {}

effect fn load() -> i32 ! NotFoundError {
  fail NotFoundError {}
}

effect fn recover(error: NotFoundError) -> string {
  return "missing"
}

fn handled() -> Effect<i32 | string> {
  return Effect.catch<NotFoundError>(load(), recover)
}
```

If `load` succeeds, its `i32` bypasses `recover`. If it fails with `NotFoundError`, `recover` owns
the payload and may produce a `string`. The resulting value is therefore `i32 | string`; the
recovery operation does not coerce either value to the other type.

A recovery path with success type `never` contributes no success member. If both paths produce the
same type, normalization leaves that type rather than a duplicate union.

The recovery handler is lazy with the composed Effect. Constructing the recovered Effect does not
run the protected Effect or the handler. The handler runs only when the composed Effect is run and
the selected failure occurs.

**Boundary:** A caller may not assume that recovery preserves the protected success type when the
handler returns another type. It must accept or narrow the complete union.

```silk,ignore
fn invalid() -> Effect<i32> {
  return Effect.catch<NotFoundError>(load(), recover)
}
```

**Diagnostics:** Using the recovered Effect where only one member of its success union is accepted
produces `SEM0040` at that use and identifies the complete actual success type and the missing union
member.

**Current compiler:** Aligned. `Effect.catch` and `Effect.catchAll` use separate protected and
handler success types and normalize the result to `A | B`.

**Evidence:** [current recovery signatures](../../../../packages/compiler/stdlib/silk/effect.silk),
[selective recovery tests](../../../../packages/compiler/test/SelectiveCatch.test.ts).

## FAIL-005 — `catch<S>` recovers any selected nonempty subset

**Status:** Confirmed

For a protected `Effect<A ! E ? R>`, `catch<S>` accepts one or more failure alternatives as ordinary
selected type `S`. `S` must be a nonempty subset of ordinary failure type `E`. A selected failure
invokes the handler; every nonselected failure propagates unchanged.

If the handler constructs `Effect<B ! F ? Q>`, the recovered contract is:

```text
Effect<A | B ! Without<E, S> | F ? R | Q>
```

Success and failure types use ordinary union normalization. Requirement rows retain their separate
capability, access, and role normalization.

```silk
import silk.effect { Effect }

struct NotFoundError {}
struct InvalidInputError {}
struct OfflineError {}

effect fn work() -> i32 ! NotFoundError | InvalidInputError | OfflineError {
  fail OfflineError {}
}

effect fn recoverKnown(error: NotFoundError | InvalidInputError) -> string {
  return "fallback"
}

fn handled() -> Effect<i32 | string ! OfflineError> {
  return Effect.catch<NotFoundError | InvalidInputError>(work(), recoverKnown)
}
```

Here `S` is `NotFoundError | InvalidInputError`. Either selected type invokes `recoverKnown`;
`OfflineError` remains as the result's failure type. Selecting one type is the same rule with a
one-alternative `S`.

A `type` alias names a union once and is erased wherever it is used (TYPE-004). A failure row
spelled through a union alias has the same members the union spells directly, so
`Effect.catch<KnownError>` is exactly `Effect.catch<NotFoundError | InvalidInputError>`. A nominal
`union` inside the alias stays one member: `catch` removes it whole or not at all.

```silk
import silk.effect { Effect }

struct NotFoundError {}
struct InvalidInputError {}
struct OfflineError {}

type KnownError = NotFoundError | InvalidInputError

effect fn work() -> i32 ! KnownError | OfflineError {
  fail OfflineError {}
}

effect fn recoverKnown(error: KnownError) -> string {
  return "fallback"
}

fn handled() -> Effect<i32 | string ! OfflineError> {
  return Effect.catch<KnownError>(work(), recoverKnown)
}
```

The selected type may be inferred from the handler's input when the explicit type argument is
omitted. Selecting the complete protected failure type gives whole-type recovery. A
standard-library `catchAll` may remain as a convenience alias, but it has no different language
semantics.

The handler may explicitly re-fail a selected payload. That failure belongs to `F` and therefore
reappears in the result's failure type under the same ordinary rules as any other handler failure.

**Boundary:** `S` may not be empty and may not contain a type absent from `E`.

```silk,ignore
struct NotFoundError {}
struct OfflineError {}

effect fn work() -> i32 ! NotFoundError {
  fail NotFoundError {}
}

effect fn recoverOffline(error: OfflineError) -> i32 {
  return 0
}

fn invalid() -> Effect<i32> {
  return Effect.catch<OfflineError>(work(), recoverOffline)
}
```

**Diagnostics:** An empty selection or a selection that is not a subset of the protected failure
type reports `SEM0067` at the `catch` application. The diagnostic must show the selected and
protected types and identify every selected alternative that the protected Effect cannot produce. A
handler whose input does not accept the complete selected type receives an ordinary callable
compatibility diagnostic at the handler argument.

**Current compiler:** Aligned. Recovery uses ordinary `E`, `S`, and `F` types. `S in E` accepts a
selected ordinary type or union, `Without<E, S>` preserves the unselected alternatives, and the
handler receives `S` directly. The public `Effect.catch` contract and selection policy remain
ordinary standard-library Silk; the sealed target-neutral primitive performs only the owned runtime
partition.

A runtime partition must preserve both possible payloads. For `S` selected from `E`, its result is
equivalent to:

```text
Selected<S> | Unselected<Without<E, S>>
```

Returning only `Without<E, S>` is not total: when the input payload belongs to `S`, there is no
unselected value to return, and the selected payload is still needed by the handler. The outer
`Selected` or `Unselected` case also lets generic code branch without knowing every concrete member
of either union.

**Evidence:** [set-to-set `Without` behavior](../../../../packages/compiler/stdlib/silk/effect.silk),
[current singleton recovery path](../../../../packages/compiler/test/SelectiveCatch.test.ts),
[current singleton-only specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md).

## FAIL-006 — Typed failure applies ordinary cleanup and preserves diagnostic context

**Status:** Confirmed

Typed-failure propagation is a structured exit. Before control reaches a recovery handler or an
outer Effect, every live owner in each exited scope is cleaned exactly once in the ordinary
innermost-to-outermost order. Moving the failure payload out of those scopes transfers its cleanup
obligation with it; propagation neither cleans nor copies that payload.

The protected Effect's exited scopes are fully cleaned before a selected recovery handler begins.
The handler then owns the selected payload. A nonselected payload bypasses the handler and continues
outward with the same ownership obligation.

Cleanup does not erase the failure's diagnostic context. The execution records the failure origin
and relevant logical Effect path before leaving the scopes needed to describe it. This context is
runtime metadata associated with the failure outcome, not a source-visible wrapper around `E`:

```text
internal failure outcome = owned payload E + hidden diagnostic context
```

Consequently, failure values remain ordinary values. Diagnostic context does not participate in
type checking, equality, union matching, ownership, or the handler's parameter type. A value does
not need to implement a reporting interface to receive this context.

Ordinary propagation and nonselected recovery preserve the existing context. If a selected handler
succeeds, the handled context is no longer part of the composed outcome. If the handler fails, the
runtime retains the earlier failure as diagnostic context for the new one, so an unhandled report
can explain that the new failure occurred while handling the earlier failure.

**Boundary:** Infallible ownership cleanup cannot replace the typed failure being propagated.
Cleanup whose failure matters is an explicit Effect operation and must complete before propagation,
normally through a standard-library finalization combinator. A trap during cleanup belongs to the
separate trap rules and is not converted into a typed failure.

`Effect.ensuring` runs its infallible unit finalizer after the protected operation's local cleanup,
then forwards the original success or typed failure. The pending failure retains its diagnostic
owner and origin across finalizer suspension. It does not become a selected recovery cause inside
the finalizer. The source wrapper uses the sealed, target-neutral `Intrinsic.finalizeEffect` seam
to retain that outcome without converting it to `Result` and raising it again.

The language guarantees that structured cleanup preserves the information needed to report the
failure. The stable logical trace minimum and debug-versus-release boundary are defined by
[TERM-004 and TERM-007](program-termination-and-reporting.md#term-004--a-failure-report-has-one-stable-minimum).
Exact textual formatting, symbolization decoration, colors, and source excerpts remain host and
tooling policy.

**Diagnostics:** Valid cleanup and propagation produce no compile-time diagnostic. Ordinary
ownership diagnostics identify double cleanup, use after move, or an invalid implicit transfer.
When a typed failure reaches a source terminal observer, its report can include the failure
identity and available logical Effect trace after cleanup has completed. The selected source
composition controls report capacity and output.

**Implementation:** Runtime reporting retains an explicit causal history and source-level logical path
on terminal outcomes under a lexical observer. Source terminal recovery drops the owned payload
exactly once before observing the retained context. Compiler-generated coroutine-resume helpers
are not logical source frames.

**Evidence:** [ownership cleanup rule](ownership-and-borrowing.md#cleanup-001--cleanup-follows-ownership),
[effect finalization contract](../../../../packages/compiler/stdlib/silk/effect.silk),
[effect-entry trace and cleanup tests](../../../../packages/compiler/test/EffectEntry.test.ts).

## FAIL-007 — A trap is fatal and remains outside Effect outcomes

**Status:** Confirmed

Effect execution has two language-visible outcomes: success and typed failure. Silk has no
exception system and no third recoverable defect channel. A trap is instead fatal abnormal
termination caused by an operation that cannot continue while preserving the language's runtime
invariants.

Bounds violations, division by zero, arithmetic overflow from trapping operators, impossible
compiler-generated states, and violated unsafe contracts are traps. They do not add a type to `E`,
do not become a hidden failure alternative, and cannot be intercepted by `catch`, `catchAll`,
`result`, or another Effect combinator.

A trap terminates the program. It may bypass `ensuring`, `Drop` hooks, and all other structured
cleanup; the language makes no cleanup guarantee after the trapping operation. For a
compiler-generated checked operation under a lexical observer, the observer receives the reason
and source origin before termination. Without an observer the operation emits a bare machine trap. Failures such as corrupted runtime state or invalid
unsafe memory may permit only a best-effort report.

Scheduler outcomes remain on the typed side of this boundary. For example,
`Fiber.Cancelled`, `Scheduler.TaskIdExhaustedError`, and `LocalScheduler.StalledError` are ordinary
declared outcomes of the source-level Fiber and scheduler APIs; none turns a trap into a recoverable
Effect failure.

**Boundary:** A condition the program intends to recover from must be represented before a trap
occurs: as ordinary data or as a typed failure from a checked operation. An Effect handler cannot
turn a trap into `E` after the fact. A deliberate process-abort operation, if one is exposed by the
standard library, triggers terminal trap behavior rather than creating an Effect-style `die`
channel.

Silk source cannot throw. A future foreign boundary must translate an anticipated host failure into
ordinary data or a declared typed failure before it enters Silk. An unexpected foreign exception
that crosses the boundary is fatal; it does not justify adding a recoverable defect channel to every
Effect in Silk.

**Diagnostics:** A trap encountered while evaluating a required compile-time constant reports a
compile-time diagnostic at the trapping operation. A trap reached during program execution reports
abnormal termination at runtime. The runtime report must distinguish a trap from an unhandled typed
failure; stable diagnostic and process-status codes remain to be assigned.

**Current compiler:** Aligned. Current Effect combinators and acceptance tests treat arithmetic
traps as abnormal termination that bypasses typed handlers, finalizers, and Drop cleanup.

**Evidence:** [trap boundary specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md).

Typed-failure values, propagation, recovery, cleanup, diagnostic context, and the trap boundary are
now defined. Requirements and service provision remain a separate contract area.
