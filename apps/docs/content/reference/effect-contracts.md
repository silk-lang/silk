# Effect contracts

An Effect contract describes a deferred computation using three channels: the value produced on
success, the typed failures it may propagate, and the capabilities it needs when it runs. The
contract describes what a caller may rely on; it does not execute the Effect or expose its captured
environment.

Construction and execution timing are defined separately under
[effects and execution](effects-and-execution.md).

## EFF-007 — An Effect contract has success, failure, and requirement channels

**Status:** Confirmed

The complete structural form is `Effect<A ! E ? R>`:

| Part | Meaning                                                             |
| ---- | ------------------------------------------------------------------- |
| `A`  | the value produced when the Effect succeeds                         |
| `E`  | the ordinary value type the Effect may propagate as a typed failure |
| `R`  | the normalized row of capabilities the Effect needs when it runs    |

The `!` and `?` tokens label independently optional channels; they are not positional type
arguments. Omitting `! E` gives the failure channel type `never`. Omitting `? R` gives an empty
requirement row. Neither omission means unknown or inferred.

```silk
struct ProblemError {}

fn closed() -> Effect<i32> {
  return effect { return 42 }
}

fn fallible() -> Effect<i32 ! ProblemError> {
  return effect { fail ProblemError {} }
}
```

`Effect<i32>` therefore means an Effect that succeeds with `i32`, propagates no typed failures, and
has no unresolved requirements. `Effect<i32 ? &Clock>` may spell a requirement without inserting a
failure placeholder, while `Effect<i32 ! ProblemError>` may spell a failure without a requirement
placeholder.

**Boundary:** The three channels are independent. `Effect<i32 ! ProblemError>` is not
interchangeable with `Effect<ProblemError ! i32>`, and a nonempty failure type or requirement row is
not erased merely because a surrounding expression ignores it.

`E` is an ordinary type. Multiple failure alternatives use an ordinary union such as
`NotFoundError | OfflineError`, and `never` represents no possible failure. The ownership and
detachment constraints on values carried through this channel belong to the typed-failure
reference. The valid entries, access modes, and roles in `R` belong to the requirements reference.

**Diagnostics:** An invalid success type is diagnosed as an ordinary type error. An invalid failure
type receives its ordinary type diagnostic or the typed-failure validity diagnostic at `E`. An
invalid requirement entry reports `SEM0070` at that entry. The error must identify which channel was
malformed rather than reporting the complete Effect type as an undifferentiated type error.

**Current compiler:** Aligned. `E` resolves through the ordinary type grammar and type-parameter
kind. The compiler may normalize a failure channel with internal set machinery, but no failure-row
kind or value projection appears in source, semantic generic arguments, tooling, or runtime data.

**Evidence:** [row representation](../../../../packages/compiler/src/Type.ts).

## EFF-008 — An effect function declares the contract of its returned Effect

**Status:** Confirmed

This declaration:

```silk
effect fn answer(input: i32) -> i32 {
  let result = input + 1
  return result
}
```

has call result `Effect<i32>`. Its contract and execution timing are equivalent to writing an
ordinary function whose result is an explicit Effect:

```silk
fn answerExplicit(input: i32) -> Effect<i32> {
  return effect {
    let result = input + 1
    return result
  }
}
```

The complete body of an `effect fn` is deferred. Parameters are supplied when the function is
called, but no statement inside the body runs until the resulting Effect is run.

Both forms have the retained environment elaborated under
[LIFE-004](lifetimes.md#life-004--invocation-lifetimes-and-retained-environments-are-independent).
Here the only input is an owned `i32`, so `answer` and `answerExplicit` both produce an Effect with
a `'static` environment. With several borrowed inputs the two spellings differ: an `effect fn`
intersects their regions, while the explicit result must write its environment.

For a declaration `effect fn work(...) -> A ! E ? R`, calling `work(...)` produces exactly
`Effect<A ! E ? R>`.

**Boundary:** The `-> A` part names the success value, not the call result by itself. Calling
`answer(41)` produces `Effect<i32>`, while `run answer(41)` produces `i32`.

**Diagnostics:** A body whose returned value is incompatible with `A` must receive the return-type
mismatch required by EFF-002. A body that exceeds `E` or `R` is rejected under EFF-009. Merely
calling an effect function is valid and produces no diagnostic.

**Evidence:** [flow specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md),
[effect elaboration tests](../../../../packages/compiler/test/Elaboration.test.ts).

## EFF-009 — Declared failure and requirement channels are upper bounds

**Status:** Confirmed

An effect function body may use fewer failures or requirements than its declaration permits. It may
not originate or propagate a failure incompatible with its declared failure type `E`, or use a
capability absent from its declared requirement row `R`.

```silk
struct ProblemError {}

effect fn maybe(flag: bool) -> i32 ! ProblemError {
  if flag {
    fail ProblemError {}
  }
  return 42
}
```

`maybe` is allowed to succeed without producing `ProblemError`. Its declaration says that
`ProblemError` is possible, not inevitable.

The declared channels remain the function's source contract even when the current body uses only a
subset. Callers must still handle every alternative in the declared failure type and provide every
declared requirement.

The compiler may remove unreachable runtime machinery when that does not change source-observable
behavior, but it does not narrow the public contract from the implementation body.

**Boundary:** This function promises failure type `never` but originates `ProblemError`:

```silk,ignore
struct ProblemError {}

effect fn invalid() -> i32 {
  fail ProblemError {}
}
```

The same boundary applies when `run` propagates a nested Effect's failures or requirements into the
surrounding effect function.

**Diagnostics:** Originating an undeclared failure reports `SEM0064` at the `fail` expression and
names the missing failure type. Running an Effect whose residual requirements are absent from the
surrounding declaration reports `SEM0071` at `run` and lists them. Propagating failures absent from
the surrounding declaration must likewise name the residual failure type; current `run` diagnostics
use `SEM0066`.

A declared failure or requirement that the body does not currently use is valid and produces no
compiler error. Language tooling may emit a non-blocking unused-contract warning and offer to narrow
the declaration, but such a warning does not change compilation or the contract seen by callers.

**Evidence:** [failure and run diagnostics](../../../../packages/compiler/test/Elaboration.test.ts).

## EFF-010 — Omitting the result annotation declares unit

**Status:** Confirmed

For any named ordinary or effect function, omitting `-> A` is shorthand for `-> ()`. The omission
does not request result-type inference.

```silk
effect fn notify() {
}
```

`notify` is exactly `effect fn notify() -> ()`, not a function with an unknown success type.

**Boundary:** Returning a non-unit success value from a function whose result annotation is omitted
is a result-type mismatch. A caller or later use cannot infer another result type for it.

**Diagnostics:** The body receives the same result-type diagnostic it would receive if `-> ()` had
been written explicitly. Omitting `-> ()` is valid, including on `pub effect fn main()`, and must not
produce a missing-entry or unresolved-result diagnostic.

**Evidence:** [function grammar](../../../../packages/compiler/src/Parser.ts),
[declaration default](../../../../packages/compiler/src/DeclarationCollection.ts).

## EFF-011 — Omitted channels have fixed empty meanings

**Status:** Confirmed

For a named effect function, omitting `! E` declares failure type `never`, and omitting `? R`
declares an empty requirement row. The compiler does not enlarge either channel after inspecting the
body. Tooling may offer to insert a failure type or requirement row derived from a body, but
accepting that edit changes the source signature explicitly.

This does not prevent an `effect {}` expression from deriving a contract locally from its body and
its immediate expected type.

Local derivation examines every reachable `return` and `fail`, including terminals nested inside
`unsafe {}`. Return types use the canonical result join rather than lexical last-return-wins, and a
value-kind type parameter used by `fail` remains in the derived failure channel until concrete
specialization. `unsafe` changes which operations source may perform; it does not hide an Effect
terminal or erase one of its channels.

**Boundary:** A body that needs a channel omitted by its declaration is invalid under EFF-009. A
caller or later use cannot supply the missing channel through expected-type inference.

**Diagnostics:** The body receives the same undeclared-failure or unhandled-requirement diagnostic
it would receive if failure type `never` and the empty requirement row had been represented
explicitly. The compiler must not defer the error until a caller executes the Effect.

**Superseded direction:** The earlier bootstrap decision allowed private non-recursive functions to
infer failure types and requirement rows from their bodies. The confirmed rule supersedes that
direction: visibility and recursion do not change the meaning of an omitted channel. Every named
function has one locally readable contract. Tooling may propose an explicit contract edit, but the
language does not silently infer one.

**Evidence:** [function grammar](../../../../packages/compiler/src/Parser.ts),
[declaration defaults](../../../../packages/compiler/src/DeclarationCollection.ts),
[effect-block contract collection](../../../../packages/compiler/src/ExpressionAnalysis.ts),
[effect-block typing regressions](../../../../packages/compiler/test/EffectBlockTyping.test.ts).

## EFF-012 — Ordinary failure types and generic requirement rows preserve a contract

**Status:** Confirmed

A generic declaration binds failure type `E` as an ordinary type parameter. A requirement-row
parameter remains a distinct `?R` parameter. Both are inferred from their positions in an Effect
contract at a call site.

```silk
pub effect fn execute<A, E, ?R>(
  pending: once Effect<A ! E ? R>
) -> A ! E ? R {
  return run pending
}
```

`execute` preserves the pending Effect's success type, failure type, and requirements. `E` is an
ordinary type and may be used anywhere an ordinary type is valid. `R` exists only to describe a
requirement-row relationship; it is not a runtime record or value.

`A`, `E`, and `R` are unknown only while the generic declaration is checked. A concrete call infers
and specializes all three from its arguments. For example, passing
`once Effect<i32 ! ProblemError ? &Clock>` selects `A = i32`, `E = ProblemError`, and
`R = &Clock`; calling `execute` then constructs `Effect<i32 ! ProblemError ? &Clock>`. Running it
propagates exactly those known concrete channels to the caller.

No unknown failure or requirement reaches runtime. Specialization does not add a runtime row
dictionary, dynamic type test, or catch-all error channel. An ordinary union chosen for `E` uses the
same value representation and matching rules as that union outside an Effect contract.

**Boundary:** Only `?R` is restricted to requirement-row positions. A concrete specialization of
`E` used in the failure channel must still satisfy the ordinary ownership and detachment rules for
typed failures. `?R` does not support general row reflection, iteration, or arbitrary row-level
programming, and inference does not use only a later expected return type.

The `once` execution mode in this example admits any Effect and consumes the supplied value when it
runs. Shared, exclusive, and consuming execution modes will be defined under capture and reuse.

**Diagnostics:** An invalid ordinary type argument for `E` receives the ordinary type or
typed-failure validity diagnostic. Supplying an argument of the wrong kind for `?R` reports
`SEM0088`. A requirement row that cannot be specialized to one finite, unambiguous contract reports
`SEM0089` at the call and explains the missing, conflicting, or ambiguous row evidence.

**Current compiler:** Aligned. Generic failure parameters are ordinary value-kind parameters such
as `E` and may be used in every ordinary type position. A `fail` inside an inferred effect block
retains symbolic `E` in that block's failure channel; specialization substitutes the concrete
failure and the enclosing `run` must then propagate or handle it. Generic requirement parameters
remain the distinct `?R` kind.

**Evidence:** [row-preserving ownership tests](../../../../packages/compiler/test/Ownership.test.ts),
[generic effect-block failure regression](../../../../packages/compiler/test/EffectBlockTyping.test.ts),
[contract-row inference diagnostics](../../../../packages/compiler/src/Diagnostic.ts).

## EFF-013 — Compatible Effects may join across construction sites

**Status:** Confirmed

Two Effect values may expose the same `Effect<A ! E ? R>` contract while capturing different values
or coming from different construction sites. The contract makes those execution channels visible;
it does not expose the Effect's construction identity or captured environment as source-level data.

Effects from different construction sites may join when they satisfy one compatible public
contract. Compatibility includes the success and failure types, the requirement row, run access,
owned captures, and borrow lifetimes.

```silk
fn choose(flag: bool) -> Effect<i32> {
  if flag {
    return effect { return 1 }
  }
  return effect { return 2 }
}
```

`choose` has one structural result contract even though its two return paths construct different
Effects. The compiler retains a finite hidden variant, or an equivalent static representation, that
can run and clean up the selected construction correctly. Forming the join does not run either
Effect.

The join must not add an implicit heap allocation, allocator requirement, typed failure, runtime
type descriptor, or universal Effect interpreter. A generic representation parameter such as
`F: Effect<i32>` may preserve the resulting concrete composite representation through nominal
storage.

**Boundary:** Distinct construction sites alone are not an error. A join is invalid when no common
contract satisfies its declared context—for example, when success types disagree, a branch exceeds
the declared failure type or requirement row, the declared run access is stronger than one branch
permits, or a captured borrow would escape its lifetime.

This rule covers finite statically known alternatives. It does not by itself introduce arbitrary
heterogeneous Effect collections, unknown runtime implementations, universal boxing, or infinitely
recursive inline representations. Those require a separate explicit erasure, indirection, or
storage design.

This construction-site join is distinct from the success-type join used while deriving an
`effect {}` contract. Return sites first establish one observable success type through the
canonical result join; only then can Effect values with that contract join across hidden
construction identities. A non-representable return-type join reports `SEM0163`, while an
incompatible finite Effect-representation join reports `SEM0132`.

**Diagnostics:** Compatible construction sites produce no diagnostic. An incompatible join must
identify the observable contract, access, ownership, or lifetime difference at the branch that
introduces it; hidden construction identity is not a sufficient error reason.

**Current compiler:** Aligned. A finite compatible join retains every exact alternative behind one
closed tagged representation. Its layout is the maximum statically required by those alternatives;
constructing it stores only the selected alternative, running it dispatches only to that runner,
and dropping it cleans only that alternative's captures. Evaluation, native LLVM, and direct
WebAssembly implement the same allocation-free rule.

An incompatible or non-finite join reports `SEM0132` at the responsible join and explains the
contract, access, ownership, lifetime, or finite-representation boundary that failed.

**Evidence:** [flow specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md),
[representation-parameter specification](../../../../openspec/specs/bootstrap-representation-parameters/spec.md),
[callable-value specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[nominal Effect storage specification](../../../../openspec/specs/bootstrap-nominal-effect-storage/spec.md),
[finite-join elaboration test](../../../../packages/compiler/test/Elaboration.test.ts),
[finite-join structural tests](../../../../packages/compiler/test/EffectJoin.test.ts).

Typed-failure compatibility, requirement membership, and Effect execution access intentionally
remain for their own reference areas.

## EFF-014 — Completed outcomes are reified by ordinary composition

**Status:** Confirmed

`Effect.result` runs one protected `Effect<A ! E ? R>` and returns
`Result<A, E>` while preserving `R`. It first maps success into
`Result<A, E>.Success`, then uses the general `Effect.catchAll` operation to map the complete failure
value into `Result<A, E>.Failure`.

```silk
import silk.effect { Effect }
import silk.result { Result }

struct HttpError {}
struct OutOfMemoryError {}

effect fn fetch() -> i32 ! HttpError | OutOfMemoryError {
  fail HttpError {}
}

effect fn inspect() -> Result<i32, HttpError | OutOfMemoryError> {
  return run Effect.result(fetch())
}
```

The outer `Result` remains one nominal union. Its `Failure` payload is the ordinary structural union
`HttpError | OutOfMemoryError`; reification does not flatten either layer. The two constructor
adapters are exact `once fn` values, so success and failure payloads may be move-only and are
transferred exactly once. Traps are not typed failures and are not converted into `Failure`.

This behavior is not privileged. Another library can define a generic result-like nominal union and
compose the same `map` followed by `catchAll` under any legal function name. The compiler recognizes
neither `Effect.result`, `Result`, nor its variants by spelling, and exposes no completed-outcome
intrinsic.

**Boundary:** `Effect.result` handles the complete declared failure type `E`; selective recovery
remains the role of `Effect.catch`. Reification does not execute more than one Effect layer, remove
requirements, erase ownership, expose a pending state, or catch traps and future interruption.

**Diagnostics:** Invalid callbacks, failure carriers, ownership transfers, or requirement rows use
the ordinary callable, Effect, ownership, and row diagnostics. There is no diagnostic or semantic
branch specific to the names `Effect.result`, `Result`, `Success`, or `Failure`.

**Current compiler:** Aligned. The standard-library implementation is ordinary Silk source over
`map` and `catchAll`; the compiler has no `Intrinsic.effectResult` operation or replacement
completed-outcome primitive.

**Evidence:** [ordinary source implementation](../../../../packages/compiler/stdlib/silk/effect.silk),
[minimal intrinsic boundary](../../../../openspec/changes/add-nominal-unions/specs/bootstrap-intrinsic-boundary/spec.md).

## Environment validity

An explicit Effect contract may spell its retained environment as `Effect<'env; A ! E ? R>`.
This lifetime is independent of its three channels and run access. A hidden borrowed capture keeps
that environment short even when `A` and `E` contain no borrowed values. Omitted environment bounds
follow declaration or local lifetime elaboration; they do not imply detached ownership.

The current layer preserves environment validity but rejects dependent borrowed success or failure
channels. [Lifetimes and elision](lifetimes.md) defines explicit binders, outlives relationships,
ordinary storage, and the quantified callable boundary.
