# Effects and execution

An Effect is a lazy computation. Calling an effect function constructs an Effect; `run` executes
exactly one Effect layer. An Effect may succeed with another Effect as an ordinary nested value.

## EFF-001 — Calling an effect function constructs an Effect

**Status:** Confirmed

An effect function declared with success type `A`, failure type `E`, and requirement row `R` has call
result `Effect<A ! E ? R>`. Calling it does not execute its body.

```silk
effect fn answer() -> i32 { return 42 }

pub fn main() -> i32 {
  let pending = answer()
  return run pending
}
```

**Boundary:** An ordinary function call executes immediately and returns its declared result rather
than constructing an Effect.

**Diagnostics:** Calling an effect function is not itself an error. Using its `Effect<A>` result in
a context that requires `A` must produce a type-mismatch diagnostic naming both types at the use
site. Returning it from a body whose contract requires `A` produces `SEM0129`. Ignoring the Effect
as an expression statement is the separate `SEM0087` boundary described under
[statements and discarded values](statements-and-discarding.md).

**Evidence:** [flow specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md).

## EFF-002 — An effect body returns its success value

**Status:** Confirmed

Inside `effect {}` or an effect function body, `return` accepts the Effect's success value. It does
not implicitly execute or flatten an Effect expression.

An ordinary statement block immediately after a match arm's `=>` shares that enclosing Effect
body. Its `run` statements execute eagerly in source order, and its `return` and `fail` transfer
through the enclosing Effect contract. The braces neither construct an Effect nor create a new
provider scope; lexical provider selection remains in force. A returned Effect value still requires
an explicit `effect { ... }` expression when a new lazy computation is intended. See
[match arm completion](functions-callables-and-control-flow.md#match-005--a-match-joins-the-results-of-reachable-arms).

```silk
effect fn inner() -> i32 { return 42 }

effect fn outer() -> i32 {
  return run inner()
}

pub fn main() -> i32 { return run outer() }
```

**Boundary:** The following body attempts to return `Effect<i32>` where its success type is `i32` and
must receive a source diagnostic:

```silk,ignore
effect fn inner() -> i32 { return 42 }
effect fn outer() -> i32 { return inner() }
```

**Diagnostics:** Returning a value incompatible with an effect body's declared success type must
produce a return-type mismatch at the returned expression, naming the declared success type and the
actual expression type. `SEM0129` reports an incompatible explicit return at the returned
expression. `SEM0130` reports reachable fallthrough from a body whose declared result is not `()`.
TIR may retain explicitly unavailable structure for inspection, but realization, layout, MIR, and
backends are unavailable while either diagnostic exists.

This is not intentional tail propagation. Issue
[#226](https://github.com/julia-script/silk/issues/226) records the interface-dispatched version of
the former source/backend disagreement and is now a semantic regression case.

The opposite direction is equally invalid:

```silk,ignore
effect fn inner() -> i32 { return 42 }

fn outer() -> Effect<i32> {
  return run inner()
}

pub fn main() -> i32 {
  return run outer()
}
```

Here `run inner()` is `i32`, which cannot satisfy `outer`'s declared `Effect<i32>` result. Analysis
reports `SEM0129`; it does not construct MIR or an executable program.

Both valid alternatives make the boundary explicit:

```silk
effect fn inner() -> i32 { return 42 }

fn deferred() -> Effect<i32> { return inner() }
fn executed() -> i32 { return run inner() }
```

**Local inference:** An explicit `effect {}` block derives its success and failure channels from
every reachable `return` and `fail`, including terminals nested inside `unsafe {}`. Every available
return type participates in the language's canonical result join. Equal types remain equal,
joinable distinct types form their normalized union, and a set with no representable join is
invalid; lexical order never lets the last return silently choose the block's success type.

**Diagnostics:** A joinable block whose return sites produce, for example, `bool` and `i32` has
success type `bool | i32`; a surrounding `Effect<i32>` context rejects that union with the ordinary
conversion diagnostic such as `SEM0040`. When the return sites themselves have no representable
join, `SEM0163` is reported at the first disagreeing return. A terminal inside `unsafe {}` keeps the
same success or failure contribution it would have outside `unsafe`.

**Evidence:** [statement return analysis](../../../../packages/compiler/src/StatementAnalysis.ts),
[effect-block analysis](../../../../packages/compiler/src/ExpressionAnalysis.ts),
[return-contract regressions](../../../../packages/compiler/test/InterfaceBounds.test.ts),
[effect-block terminal regressions](../../../../packages/compiler/test/EffectBlockTyping.test.ts),
[MIR return verification](../../../../packages/compiler/src/Mir.ts).

## EFF-003 — `run` executes exactly one Effect layer

**Status:** Confirmed

For `pending: Effect<A ! E ? R>`, `run pending` produces `A` while propagating unhandled failures and
requirements through the surrounding Effect execution boundary. One `run` never removes two nested
Effect layers.

```silk
effect fn inner() -> i32 { return 42 }
effect fn outer() -> Effect<'static; i32> { return inner() }

pub fn main() -> i32 {
  return run run outer()
}
```

**Boundary:** Running `outer()` once produces `Effect<'static; i32>`, not `i32`. The inner
environment is written: an `effect fn` success type that is an Effect gets no omitted-environment
default.

The following invalid case does not demonstrate automatic flattening:

```silk,ignore
effect fn inner() -> i32 { return 42 }
effect fn outer() -> i32 { return inner() }

pub effect fn main() {
  let value = run outer()
}
```

`outer()` has type `Effect<i32>` from its declaration, so one `run` would give `value` type `i32`.
The program is nevertheless invalid because `outer` returns `Effect<i32>` where its success
contract requires `i32`; `SEM0129` rejects the declaration before lowering.

**Diagnostics:** Applying `run` to a non-Effect value reports `SEM0065` at the operand and identifies
its actual type. A `run` that leaves failures or requirements outside the surrounding contract
reports `SEM0066` or `SEM0071`, respectively. If one `run` validly produces another Effect but its
context requires the nested success value, the required error is the type mismatch described under
EFF-002; `run` must not silently remove the second layer.

**Evidence:** [one-layer execution test](../../../../packages/compiler/test/Elaboration.test.ts),
[Effect runtime tests](../../../../packages/compiler/test/EffectRuntime.test.ts).

## EFF-004 — Nested Effects are ordinary values

**Status:** Confirmed

An Effect may succeed with another Effect. The resulting `Effect<Effect<A>>` remains nested until
source executes each layer or applies an explicit flattening operation.

```silk
effect fn inner() -> i32 { return 42 }
effect fn nested() -> Effect<'static; i32> { return inner() }
```

**Boundary:** Declaring the success type as `i32` does not request implicit flattening. Returning an
`Effect<i32>` from that body produces `SEM0129` as recorded under EFF-002.

**Diagnostics:** Constructing or returning a nested Effect is valid and produces no diagnostic.
Using `Effect<A>` where `A` is required must produce the type mismatch described under EFF-002.

**Evidence:** [Effect flattening runtime tests](../../../../packages/compiler/test/EffectRuntime.test.ts).

## EFF-005 — An ordinary function can construct a deferred Effect

**Status:** Confirmed

Calling an ordinary function executes its body immediately. Evaluating an `effect {}` expression
constructs an Effect but does not execute the statements inside the block. Values computed by the
ordinary function may therefore be used later by the deferred block.

```silk
fn prepareAnswer() -> Effect<i32> {
  let n = 123 // executes when prepareAnswer() is called
  return effect {
    return n // executes when the returned Effect is run
  }
}

pub fn main() -> i32 {
  return run prepareAnswer()
}
```

Evaluation of `run prepareAnswer()` has two ordered steps:

1. Call `prepareAnswer()`, compute `n`, and construct the returned `Effect<i32>`.
2. Run that Effect, which executes the `effect` block and returns `n`.

**Boundary:** Calling `prepareAnswer()` without `run` still computes `n` and constructs the Effect;
it does not execute `return n` inside the `effect` block. This rule describes execution timing only.
Values retained by the deferred block follow the ordinary
[capture rules](ownership-and-borrowing.md#capture-001--delayed-values-acquire-their-captures-when-constructed).

**Diagnostics:** This evaluation order is valid behavior, not a source restriction, so it has no
diagnostic. Invalid captures receive the corresponding capture, borrow, move, or escape diagnostic.

Capture discovery visits every expression operand in the deferred body. In particular, a binding
used only as the argument of `Enum.value(binding)` is still captured; enum conversion does not hide
the dependency from the Effect environment.

**Evidence:** [effect-block capture analysis](../../../../packages/compiler/src/ExpressionAnalysis.ts),
[effect-block capture parity corpus](../../../../packages/compiler/test/support/corpus.ts),
[effect-block lowering](../../../../packages/compiler/src/Lower.ts).

## EFF-006 — An ordinary function may run only a closed Effect

**Status:** Confirmed

An ordinary `fn` has no typed-failure or requirement channels. The Effect at a `run` site inside an
ordinary function must therefore have failure type `never` and an empty requirement row. All typed
failures must be recovered or reified as values, and all requirements must be provided, before
execution crosses that boundary.

The rule applies to the final residual channels after composition. A recovery operation whose
handler can fail, or a provision operation whose acquisition has requirements, does not close the
boundary unless those new channels are also eliminated.

```silk
import silk.effect { Effect }

struct ProblemError {}

effect fn risky() -> i32 ! ProblemError {
  fail ProblemError {}
}

effect fn recover(error: ProblemError) -> i32 {
  return 0
}

pub fn main() -> i32 {
  return run Effect.catch<ProblemError>(risky(), recover)
}
```

An `effect fn` may instead propagate residual failures and requirements when its own contract
contains them.

An executable `effect fn main` is itself an Effect boundary handled by the generated program entry
adapter; it is not an ordinary-function exception to this rule. See
[program entry](program-entry.md).

**Boundary:** Neither a non-`never` failure type nor a nonempty requirement row may escape through an
ordinary function's `run`.

```silk,ignore
struct ProblemError {}

effect fn risky() -> i32 ! ProblemError {
  fail ProblemError {}
}

pub fn main() -> i32 {
  return run risky()
}
```

```silk,ignore
service Counter {
  effect fn get() -> i32 ? &Counter
}

effect fn read() -> i32 ? &Counter {
  return run Counter.get()
}

pub fn main() -> i32 {
  return run read()
}
```

**Diagnostics:** A residual failure type other than `never` reports `SEM0066` at `run` and names every
unhandled failure member. A nonempty residual requirement row reports `SEM0071` at `run` and names
every unsatisfied requirement member. When both channels remain open, the diagnostics must expose
both rather than stopping after the first category.

**Evidence:** [flow specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md),
[run diagnostics](../../../../packages/compiler/test/Elaboration.test.ts).

## ANON-EFF-001 — An effectful anonymous callable preserves two delayed boundaries

**Status:** Confirmed

Evaluating an `effect fn` anonymous expression acquires its implicit lexical captures and produces
an exact callable value without entering the authored body. Invoking that callable evaluates its
arguments and constructs an Effect with the written success, failure, and requirement channels,
again without entering the body. Only `run` enters the body.

```silk
struct Failure {}

fn recover(answer: i32) -> Effect<i32> {
  let handler = effect fn(error: Failure) -> i32 {
    return answer
  }
  return handler(Failure {})
}

pub fn main() -> i32 {
  return run recover(42)
}
```

Evaluating `handler` captures `answer`. Calling `handler(Failure {})` constructs the returned
`Effect<i32>`. The body reads `answer` only when `main` runs that Effect.

**Boundary:** `effect fn(...) -> ... { ... }` is an anonymous callable whose invocation returns an
Effect. `effect { ... }` directly constructs an Effect and has no intervening callable-invocation
boundary. An effectful anonymous callable that moves an affine capture derives `once fn`; its one
invocation transfers the environment into the returned Effect, and constructing a second Effect
from the consumed callable is invalid.

**Diagnostics:** Using the callable result where its Effect success value is required receives the
ordinary Effect type mismatch. Repeating a consuming invocation reports use after move. Invalid
failure or requirement channels receive the same contract diagnostics as a named effect function.

**Evidence:** [anonymous flow-function specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-flow-functions/spec.md),
[anonymous callable value specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-callable-values/spec.md),
[anonymous ownership specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-ownership/spec.md).

## Related Effect rules

The confirmed rules above define construction, one-layer execution, nested success values, the
eager/deferred boundary, and closure at an ordinary execution boundary. The rest of the current
language-level Effect model is defined in focused pages:

| Area                                                            | Reference                                                             |
| --------------------------------------------------------------- | --------------------------------------------------------------------- |
| Success, failure, and requirement channels                      | [Effect contracts](effect-contracts.md)                               |
| Requirements, services, roles, and provision                    | [Requirements and services](requirements-and-services.md)             |
| Captures, run access, reuse, and cleanup                        | [Ownership and borrowing](ownership-and-borrowing.md)                 |
| Typed propagation, recovery, and traps                          | [Typed failures](typed-failures.md)                                   |
| Stack-safe recursive transfer                                   | [Effect suspension and stack-safe recursion](effect-suspension.md)    |
| Owner-controlled parking and resumption                         | [Independently resumable Effect executions](independent-execution.md) |
| Single-threaded scheduling, Fibers, and structured cancellation | [Single-threaded schedulers and Fibers](single-threaded-fibers.md)    |

These execution facilities are explicit source-level layers. They do not make ordinary Effect
construction concurrent, add an ambient scheduler, or turn `Effect.suspend` into a parking
operation. Parallel execution, ambient interruption, and a general async-I/O model remain outside
the stabilized language.

The standard-library operations built from these rules—including `of`, `result`, `mapBoth`, `map`,
`mapError`, `flatMap`, `flatten`, `zip`, `zip3`, `tap`, `catch`, `catchAll`, `ensuring`,
`ifThenElse`, `retry`, the requirement-binding and provision operations, and `suspend`—belong in an
Effect API reference rather than on this language-semantics page.

The signature-level rules for Effect channels, declaration bounds, generic failure types and
requirement rows, and concrete identity are defined in [Effect contracts](effect-contracts.md).
Valid failure values, propagation, recovery, cleanup, diagnostic context, and fatal traps are
defined in [typed failures](typed-failures.md).
