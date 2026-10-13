# Functions, callables, and control flow

Silk functions have locally readable contracts, evaluate calls in a fixed order, and use explicit
control transfers. Named functions and anonymous callable expressions produce first-class callable
values. `if`, `while`, and `match` provide structured selection and repetition without truthiness,
implicit exception flow, or hidden ownership transfers.

Effect construction, execution, and channels are defined by [effects and execution](effects-and-execution.md)
and [Effect contracts](effect-contracts.md). This page describes the ordinary function and
control-flow behavior shared by eager and effect bodies. Moves, borrows, captures, and cleanup are
defined by [ownership and borrowing](ownership-and-borrowing.md).

## Terminology

- A **named function** is a module-level `fn` or `effect fn` declaration.
- A **function item** is the callable value denoted by naming a function without calling it.
- An **anonymous callable expression** defines a callable body at its expression site without
  declaring an importable name.
- A **callable** is a value that may be invoked with an ordered list of arguments.
- A callable's **invocation mode** is shared reusable `fn`, exclusive reusable `mut fn`, or
  consuming `once fn` access to its captured environment.
- A **section** is a callable produced by supplying a trailing suffix of a named function's
  arguments while leaving one or more leading parameters unsupplied.
- A **control transfer** is `return`, `break`, `continue`, typed failure propagation, or another
  operation that exits the current region without ordinary fallthrough.
- A **reachable path** is a possible route through the body that has not already returned, failed,
  diverged, broken, or continued.
- A **guard** is the optional boolean expression between a match pattern and `=>`.
- **Coverage** is the set of possible nominal-union variants, structural-union members, or
  scalar-enum members handled by a
  match's arms.
- **Narrowing** gives a value a more precise type within one proven branch without changing its
  declared type outside that branch.

## Function declarations, calls, and returns

### FUNC-001 — Every named function has a locally readable contract

**Status:** Confirmed

Every parameter declares its type. Omitting a result annotation declares `()`, not an inferred
result. For an effect function, the declared success, failure, and requirement channels describe
the Effect produced by calling it.

An ordinary or Effect function may prefix an owned parameter name with `mut`. This creates mutable local
storage for the transferred value without changing the callable's parameter type or identity.
Borrowed parameters use `&` or `&mut` and do not accept the binding-level `mut` prefix. Service and
interface operations describe contracts rather than local storage, so their parameters do not
accept it either.

```silk
struct LoadError {}

service Store {
  effect fn load(id: i32) -> i32 ! LoadError ? &Store
}

fn notify(message: string) {
}

effect fn load(id: i32) -> i32 ! LoadError ? &Store {
  return run Store.load(id)
}
```

`notify` has result type `()`. Calling `load` has result
`Effect<i32 ! LoadError ? &Store>`. The compiler checks bodies against those declarations without
using later callers to enlarge or replace them.

**Boundary:** A named function cannot omit a result annotation and later return another type. An
effect function cannot originate a failure or requirement omitted from its declared channels.
Generic parameters may make parts of the contract abstract, but they remain explicit declaration
parameters rather than caller-driven rewriting of the signature.

**Diagnostics:** Unknown parameter or result types receive their ordinary type diagnostic. A
non-unit return from an omitted result contract receives the return mismatch described by
RETURN-001. Undeclared Effect failures and requirements report the channel diagnostics defined by
EFF-009 and EFF-011.

**Evidence:** [effect-function contracts](effect-contracts.md#eff-008--an-effect-function-declares-the-contract-of-its-returned-effect),
[omitted unit results](effect-contracts.md#eff-010--omitting-the-result-annotation-declares-unit),
[omitted channels](effect-contracts.md#eff-011--omitted-channels-have-fixed-empty-meanings).

### FUNC-002 — Ordinary functions execute eagerly and effect functions construct lazily

**Status:** Confirmed

Calling an ordinary `fn` executes its body immediately. Calling an `effect fn` captures its supplied
arguments and constructs one Effect whose complete body executes only when run.

```silk
fn increment(value: i32) -> i32 {
  return value + 1
}

effect fn incrementLater(value: i32) -> i32 {
  return value + 1
}
```

`increment(41)` is `42`. `incrementLater(41)` is `Effect<i32>`; `run incrementLater(41)` is `42`.

**Boundary:** The `effect fn` spelling changes execution timing, not the meaning of `return` or the
declared success type. Returning an Effect from an ordinary function does not make that function
lazy: eager setup still runs before the returned Effect is constructed.

**Diagnostics:** Calling either declaration is valid. Using `Effect<A>` where `A` is required must
report the type mismatch defined under EFF-002. Ignoring the constructed Effect as a statement
reports `SEM0087` under STMT-001.

**Evidence:** [Effect construction](effects-and-execution.md#eff-001--calling-an-effect-function-constructs-an-effect),
[eager setup](effects-and-execution.md#eff-005--an-ordinary-function-can-construct-a-deferred-effect).

### CALL-001 — A call evaluates each argument once from left to right

**Status:** Confirmed

A call evaluates its callable expression once, then evaluates supplied arguments once in source
order from left to right. Only after the arguments complete are their values bound to parameters and
the target body entered.

```silk
fn first() -> i32 { return 1 }
fn second() -> i32 { return 2 }
fn combine(left: i32, right: i32) -> i32 { return left * 10 + right }

pub fn main() -> i32 {
  return combine(first(), second())
}
```

`first()` completes before `second()`, and both complete before `combine` begins. The result is
`12`.

**Boundary:** If evaluating an earlier argument traps, propagates a typed failure, or otherwise
transfers control, later arguments do not begin. Argument evaluation order never changes to match
parameter ownership, optimizer preference, or target ABI order.

A pipeline has its own related order: it evaluates its completed left expression before evaluating
the callable expression on the right, as defined by PIPE-001.

**Diagnostics:** Evaluation order is behavior rather than a validity condition. Each invalid
argument receives its own expression, ownership, failure, or requirement diagnostic at that
argument. A control transfer prevents execution of later arguments but does not suppress independent
compile-time diagnostics in their source.

**Evidence:** [callable application specification](../../../../openspec/specs/bootstrap-callable-values/spec.md).

### CALL-002 — Calls satisfy the declared positional parameter contract

**Status:** Confirmed

A full invocation supplies one compatible argument for every positional parameter. Arguments bind
to parameters by ordinal; names at the call site do not reorder them. Silk performs no implicit
numeric conversion, truthiness conversion, or ownership-mode conversion to make an argument fit.

```silk
fn subtract(left: i32, right: i32) -> i32 {
  return left - right
}

pub fn main() -> i32 {
  return subtract(10, 3)
}
```

The result is `7`, with `10` bound to `left` and `3` to `right`.

Supplying a nonempty trailing suffix may construct a section instead of invoking the body under
CALLABLE-002. Supplying too many arguments is always invalid. Supplying no arguments to a function
that declares parameters neither invokes it nor creates a redundant section; name the function item
directly.

**Boundary:** `subtract(10, true)` is invalid rather than converting `true`. Passing an affine
binding to an owned parameter requires explicit `move`; passing a fixed array to a slice parameter
requires an explicit borrow. Parameter `mut` affects only the callee's local storage and never
weakens either transfer rule.

**Diagnostics:** Too many arguments or another non-section arity mismatch reports `SEM0007`.
Incompatible argument types report `SEM0012` at the argument. Applying a non-callable reports
`SEM0075`. A redundant empty call of a unary function reports `SEM0078`; invalid ownership uses the
corresponding `OWN` diagnostic.

**Evidence:** [call semantic diagnostics](../../../../packages/compiler/src/Diagnostic.ts),
[callable specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[parameter ownership](ownership-and-borrowing.md#call-001--parameter-types-determine-ownership-transfer-or-borrowing).

### CALL-003 — A method call is the receiver-first spelling of one member

**Status:** Confirmed

`receiver.member(args)` calls the inherent receiver method `member` of the receiver's nominal
type. It names the same statically selected member as `Type.member(receiver, args)` and
`receiver |> Type.member(args)`: no callable value is created, nothing is dispatched at run time,
and the three spellings share one contract, one declaration, and one rename.

```silk
pub struct Counter { value: i32 }

impl Counter {
  pub fn read(self: &Self) -> i32 { return self.value }
  pub fn take(self: Self) -> i32 { return self.value }
}

pub fn main() -> i32 {
  let value = Counter { value: 14 }
  let direct = Counter.read(&value)
  let piped = &value |> Counter.read
  let method = value.read()
  return direct + piped + method
}
```

The declared parameter zero decides how the receiver is passed: `self: &Self` takes a shared loan of
the receiver place, `self: &mut Self` an exclusive loan that requires a `mut` binding, and
`self: Self` consumes the place or takes an rvalue as it is. Nothing is written in front of the
receiver; the explicit spellings `Type.member(&value, ...)` and `Type.member(move value, ...)`
remain available. A callable field of the same name is applied instead, and an rvalue chains:
`Counter { value: 42 }.take()` consumes the temporary.

A receiver whose type is a reference `&T` or `&mut T` to a nominal type calls that type's receiver
methods through a reborrow of its referent, for parameter zero only. `self: &Self` takes a shared
reborrow, which an exclusive reference also permits. `self: &mut Self` takes an exclusive reborrow,
which requires an exclusive reference but not a `mut` binding: the binding is not written, its
referent is. The reborrow is exactly the explicit `Type.member(&mut counter, ...)` (BORROW-005): it
lasts for the call and suspends the reference for that time, and a method returning a reference
tied to `self` extends the reborrow to that result's uses. A `self: Self` method reads the referent
as `counter.*` would: a Copy referent is copied (OWN-002), and an affine referent cannot be moved
out of a borrow.

```silk
pub struct Counter { value: i32 }

impl Counter {
  pub fn read(self: &Self) -> i32 { return self.value }
  pub fn bump(self: &mut Self) -> () { self.value = self.value + 1 }
}

fn step(counter: &mut Counter) -> i32 {
  counter.bump()
  return counter.read()
}

pub fn main() -> i32 {
  let mut value = Counter { value: 41 }
  return step(&mut value)
}
```

`step` reborrows `counter` exclusively for `bump` and shared for `read`; each reborrow ends with its
call, so `counter` stays usable and `main` reads 42.

A receiver method named without a call is a bound method value: the section whose only capture is
the receiver, taken under the same declared mode, awaiting the member's parameters after `self`.

```silk
pub struct Counter { value: i32 }

impl Counter {
  pub fn read(self: &Self) -> i32 { return self.value }
  pub fn add(self: &Self, other: &Self) -> i32 { return self.value + other.value }
}

pub fn main() -> i32 {
  let value = Counter { value: 40 }
  let other = Counter { value: 2 }
  let read = value.read
  let add = value.add
  return read() + add(&other) - 40
}
```

`read` has type `fn() -> i32` and holds a shared loan of `value` until its last use; `add` has type
`fn(&Counter) -> i32`. A `&mut Self` receiver binds a `mut fn` that needs a `mut` binding and an
exclusive loan, and a `Self` receiver moves the place into a `once fn` that drops the receiver if it
is never invoked. The bound value lowers and executes as `Counter.read` sectioned over its first
parameter would.

**Boundary:** Apart from the reference reborrow above, a receiver is never dereferenced or coerced:
`boxed.read()` on a `Box<Counter>` does not reach `Counter.read`, and a reference to a reference is
not reborrowed twice. The reborrow applies to the receiver only. Any other argument that is an
exclusive reference is forwarded with `&mut` (BORROW-005); `counter.add(other)` with
`other: &mut Counter` reports `OWN0003` at `other`. An associated function without a receiver is not a value member, called or
not: `value.zero()` and `value.zero` are rejected. A borrowed receiver of a bound value must be a
place: `Counter { value: 1 }.read` without a call is rejected because the section would outlive
the temporary. A receiver of a generic parameter type resolves only through the parameter's bounds
(INTF-007) and does not bind: `value.print` without a call is rejected.

**Diagnostics:** Calling or naming an associated function on a value reports `SEM0198`. An unknown
member keeps the field diagnostic `SEM0027`. Receiver ownership uses the ordinary loan and move
diagnostics (`SEM0057`, `OWN0001`); a view of a borrowed temporary receiver used after its statement
reports `OWN0019` at the use (BORROW-006). Through a reference receiver, the diagnostics are those
of the explicit spelling: a `self: &mut Self` method called through a shared reference reports
`SEM0058` as `&mut counter` does, a `self: Self` method on an affine referent reports `OWN0012`, and
an outstanding loan of the referent that conflicts with the reborrow reports `OWN0010`.

**Evidence:** [method call semantics](../../../../packages/compiler/src/ExpressionAnalysis.ts),
[method-call specification](../../../../openspec/specs/bootstrap-method-calls/spec.md),
[reference receiver tests](../../../../packages/compiler/test/Ownership.test.ts),
[inherent members](modules-names-and-visibility.md#name-005--a-nominal-qualifier-exposes-only-its-associated-items).

### RETURN-001 — `return` exits with a value compatible with the declared result

**Status:** Confirmed

`return expression` evaluates the expression once and exits the current function or Effect body
with that value. The value must be compatible with the declaration's result or success type. Silk
does not infer a different result from the returned expression and does not insert numeric or Effect
conversions.

```silk
fn absolute(value: i32) -> i32 {
  if value < 0 {
    return -value
  }
  return value
}
```

Every reachable path through a non-unit body must reach a compatible `return` or another terminal
operation such as a typed failure or divergence. `return` without an expression is equivalent to
`return ()` and is valid only for a unit result. A unit body may fall through its closing brace,
which produces `()`.

```silk
fn notify() {
  return
}

fn alsoNotify() {
}
```

**Boundary:** Falling through a body declared to return `i32` is invalid. Returning
`Effect<i32>` from a body declared to produce `i32`, or returning `i32` from a body declared to
produce `Effect<i32>`, is a type mismatch; neither direction runs, wraps, or flattens automatically.

**Diagnostics:** Reachable non-unit fallthrough reports `SEM0130` at the closing boundary. An
incompatible returned expression reports `SEM0129` at that expression with the declared and actual
types. More specific union or representation diagnostics may explain those specialized joins.
Effect-specific examples are recorded under EFF-002.

The contract is semantic: a trailing return is unnecessary when no reachable path can fall through.

**Evidence:** [function syntax](../../../../openspec/specs/bootstrap-syntax/spec.md),
[Effect return semantics](effects-and-execution.md#eff-002--an-effect-body-returns-its-success-value),
[unit fallthrough tests](../../../../packages/compiler/test/IntegerScalars.test.ts).

### RETURN-002 — An Effect block derives its contract from every reachable terminal

**Status:** Confirmed

The success and failure types of `effect { ... }` come from every reachable `return` and `fail` in
the deferred block. Equal return types remain that type; distinct joinable ordinary value types form
their canonical union; `never` contributes no success member. Source order never makes the last
written terminal override earlier branches.

```silk
fn later(flag: bool) -> Effect<bool | i32> {
  return effect {
    if flag {
      return true
    }
    return 42
  }
}
```

The block has success type `bool | i32`, not `i32`. A `fail` contributes its precise ordinary value
type to the failure row, including a value-kind generic type parameter. Terminals nested in an
`unsafe { ... }` statement count exactly like terminals at the block's top level.

**Boundary:** A surrounding expected `Effect` type does not discard a block terminal or coerce its
value. If the example were returned as `Effect<i32>`, the inferred `Effect<bool | i32>` would be
incompatible. A pair of return types with no legal finite representation cannot form a block result.

Capture analysis follows the same complete block traversal. A binding used only as the argument of
`Enum.value` is still captured when the Effect is constructed and read when it runs.

**Diagnostics:** An inferred union incompatible with the surrounding expected Effect reports the
ordinary union or type mismatch at that boundary. Return types with no legal join report `SEM0163`
at the offending terminal and identify the contributing types. A failure left unhandled at `run`
reports `SEM0066`; generic failure values are not dropped from that check.

**Evidence:** [effect-block terminal specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md),
[canonical join implementation](../../../../packages/compiler/src/Match.ts),
[effect-block typing tests](../../../../packages/compiler/test/EffectBlockTyping.test.ts).

## Callable values and pipelines

### CALLABLE-001 — Naming a function produces a first-class callable value

**Status:** Confirmed

A resolved named function may be passed, returned, or bound without being invoked. A plain named
function has no captured environment and supports shared reusable invocation.

```silk
fn increment(value: i32) -> i32 { return value + 1 }

fn apply(transform: fn(i32) -> i32, value: i32) -> i32 {
  return transform(value)
}

pub fn main() -> i32 {
  return apply(increment, 41)
}
```

The result is `42`. Naming `increment` does not call it and does not require empty parentheses.

**Boundary:** A function item must satisfy the expected parameter, result, and invocation-mode
contract. Two functions with the same visible callable signature may retain distinct concrete
identities for specialization; source cannot erase those identities merely by naming the structural
callable type. Safety is also part of that contract: an `unsafe fn(A) -> B` value still requires an
`unsafe` acknowledgement when its complete invocation occurs. A safe callable may satisfy an unsafe
callable parameter, but an unsafe callable cannot satisfy a safe one. Partial application preserves
the qualifier until the final invocation; constructing the section itself does not acknowledge the
eventual call.

**Diagnostics:** Applying a non-callable reports `SEM0075`. An incompatible callable parameter,
result, or mode reports `SEM0076`. A context that would erase a required concrete callable identity
reports `SEM0080` or the more specific represented-storage diagnostic.

**Evidence:** [callable specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[indirect-call tests](../../../../packages/compiler/test/IndirectCallAcceptance.test.ts),
[unsafe callable contracts](unsafe-intrinsics-and-targets.md#unsafe-002--ordinary-source-may-declare-a-caller-owned-unsafe-contract).

### CALLABLE-002 — Supplying a trailing argument suffix constructs a section

**Status:** Confirmed

Calling an `N`-parameter named function with `K` arguments, where `0 < K < N`, binds those arguments
to the trailing `K` parameters and returns a callable awaiting the leading `N - K` parameters.

```silk
fn combine(a: i32, b: i32, c: i32) -> i32 {
  return a + b + c
}

fn staged() -> i32 {
  let withThree = combine(3)
  let withTwoAndThree = withThree(2)
  return withTwoAndThree(1)
}
```

`combine(3)(2)(1)` invokes `combine(1, 2, 3)` and produces `6`. Every stage captures one contiguous
trailing suffix; sections do not leave holes, reorder parameters, or bind a leading parameter while
omitting a later one. The one leading capture is a bound method value (CALL-003), which captures
parameter zero and awaits the rest.

**Boundary:** Supplying all parameters invokes the function. Supplying none denotes no application;
use the function name as a callable value. Supplying more than the remaining arity is invalid.

A staged argument is captured by value. Staging an exclusive reference or slice therefore forwards
it as any by-value argument does (BORROW-005): `bump(&mut first)` reborrows it for the section's
lifetime and `bump(move first)` transfers it.

**Diagnostics:** Too many arguments report the ordinary arity diagnostic. A partially applied
callable used where its eventual result is required reports a type mismatch naming the remaining
callable contract. Capture ownership errors occur when the section is constructed; staging an
exclusive reference or slice without `&mut` or `move` reports `OWN0003`.

The compiler carries every remaining leading parameter and captured trailing argument through
semantic facts, TIR, MIR, and each execution engine. `combine(3)(2)(1)` therefore preserves both
source evaluation order and the final positional call `combine(1, 2, 3)`.

**Evidence:** [captured callable rule](ownership-and-borrowing.md#callable-001--named-functions-support-trailing-partial-application).

### CALLABLE-003 — Invocation mode describes access to the callable environment

**Status:** Confirmed

Callable contracts distinguish three modes:

| Contract          | Environment access | Reuse                  |
| ----------------- | ------------------ | ---------------------- |
| `fn(A) -> B`      | shared             | repeatable             |
| `mut fn(A) -> B`  | exclusive          | repeatable in sequence |
| `once fn(A) -> B` | consuming          | at most once           |

Shared callable access may satisfy an exclusive or consuming parameter, and exclusive access may
satisfy a consuming parameter. The reverse substitutions are invalid because they promise more
reuse than the supplied callable supports.

Invocation mode applies to the hidden environment, independently from the ownership modes of newly
supplied arguments. A shared callable may still accept an owned argument; a consuming callable may
accept a Copy argument while consuming one capture.

**Boundary:** A callable that moves an affine capture during invocation is `once` even if its
visible argument and result types are Copy. A callable that mutates an exclusive capture is `mut`
even when callers invoke it sequentially.

**Diagnostics:** An incompatible callable contract reports `SEM0076`. Invoking a callable without
the required shared, exclusive, or consuming access reports `SEM0077`; represented stored values may
use ownership diagnostic `OWN0014` for the same access violation.

**Evidence:** [callable ownership](ownership-and-borrowing.md#callable-002--invocation-mode-derives-from-access-to-the-callable-environment),
[callable specification](../../../../openspec/specs/bootstrap-callable-values/spec.md).

### ANON-CALLABLE-001 — An anonymous callable has one exact source identity and explicit contract

**Status:** Confirmed

An anonymous callable defines its parameters, result, and body at an expression site. Parameter and
result types are mandatory. An effectful anonymous callable also declares any failure and
requirement channels in the ordinary Effect-contract positions.

```silk
fn apply(transform: fn(i32) -> i32, value: i32) -> i32 {
  return transform(value)
}

fn addOffset(offset: i32) -> i32 {
  return apply(fn(value: i32) -> i32 { return value + offset }, 40)
}
```

The anonymous expression in `addOffset` captures `offset` and has the visible contract
`fn(i32) -> i32`. Every accepted occurrence retains its own deterministic source identity and one
finite environment containing its implicit captures in first-reference order. Two textually
identical occurrences remain distinct, including when neither captures a value. An occurrence may
use type and row parameters declared by its enclosing function; each enclosing specialization
produces a corresponding finite anonymous target.

The source identity is not a declaration name. Anonymous callables do not enter module lookup,
imports, overload sets, or documentation as named functions. Writing a structural callable type
does not merge distinct occurrences or erase their targets and environments into a universal
closure representation or ABI.

**Boundary:** The callable's written contract must be complete. An expected callable type may check
compatibility and contribute ordinary surrounding generic constraints, but it does not infer a
missing parameter, result, failure, or requirement annotation and does not rewrite a conflicting
annotation. Anonymous callables cannot declare independent type parameters, name themselves, refer
to themselves recursively, carry declaration modifiers, or participate in overloads. An anonymous
body nested inside another anonymous body is unsupported in this language slice. Invocation mode is
derived from captures under
[ANON-OWN-001](ownership-and-borrowing.md#anon-own-001--anonymous-captures-determine-environment-ownership-and-invocation-mode);
source does not spell `mut fn` or `once fn` when constructing the value.

**Diagnostics:** An incomplete written contract receives a syntax or type diagnostic at the missing
or incompatible contract part. A nested body, self-reference, independent type parameter,
declaration modifier, or overload use receives a semantic diagnostic at that unsupported construct.

**Evidence:** [anonymous callable value specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-callable-values/spec.md),
[anonymous semantic-fact specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-semantic-facts/spec.md),
[anonymous generic-contract specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-type-generics/spec.md),
[anonymous backend specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-backend/spec.md).

### PIPE-001 — A pipeline invokes one unary callable after evaluating its left value

**Status:** Confirmed

`value |> operation` evaluates the completed left expression exactly once, then evaluates the right
expression as a unary callable and invokes it with the left value. Pipelines associate left to
right.

```silk
fn add(left: i32, right: i32) -> i32 { return left + right }
fn multiply(left: i32, right: i32) -> i32 { return left * right }

pub fn main() -> i32 {
  return 2 |> add(3) |> multiply(4)
}
```

The expression groups as `(2 |> add(3)) |> multiply(4)` and produces `20`.

The pipeline does not insert an argument into syntax. `add(3)` is first an ordinary section waiting
for `left`; the pipeline then invokes that callable with `2`.

The left expression may be an explicit `&` or `&mut` borrow when the callable expects a borrowed
view. A result follows the callable's declared or deterministically elided lifetime relationships,
just as in an equivalent direct call. Supplied arguments and retained captures preserve their
concrete loans; structural callable contracts do not require inspecting a hidden implementation.

**Boundary:** The right side may be a function item, section, binding, grouped expression, or any
other compatible unary callable. An applied interface operation such as
`Encodable<u32>.encode` is completed by the pipeline's left operand and is equivalent to the direct
static call `Encodable<u32>.encode(left)`. The pipeline does not perform method lookup, open a
namespace, import a name, infer an interface application from the result, or change the callable's
ownership contract.

**Diagnostics:** A non-callable right expression reports `SEM0075`. A callable with incompatible
arity, parameter type, result use, or invocation mode reports the corresponding callable or
argument diagnostic. Invalid transfer or borrowing of the left value reports its ordinary ownership
diagnostic.

**Evidence:** [operator pipeline specification](../../../../openspec/specs/bootstrap-operator-semantics/spec.md),
[pipeline elaboration tests](../../../../packages/compiler/test/Elaboration.test.ts),
[pipeline ownership](ownership-and-borrowing.md#pipe-001--a-pipeline-applies-ordinary-leading-parameter-ownership).

## Conditionals, loops, and transfers

### IF-001 — `if` selects one statement branch using a boolean condition

**Status:** Confirmed

An `if` statement evaluates its condition exactly once. The condition must have type `bool`; Silk
has no truthiness conversion. A true condition executes the first arm, while a false condition
executes the `else` arm when present and otherwise continues after the statement.

```silk
fn choose(flag: bool) -> i32 {
  if flag {
    return 1
  }
  return 2
}
```

Only the selected arm executes. Chained `else if` uses the same rule in source order.

**Boundary:** Bootstrap `if` is a statement, not a value-producing expression. A branch communicates
a value by returning it, binding or mutating an outer place under ordinary ownership rules, or by
continuing to a later expression. Code needing a value selected from exhaustive alternatives may use
`match`.

Pattern-conditioned `if let Pattern = expression { ... }` tests and destructures a value while
introducing bindings only in the selected body. It remains distinct from ordinary boolean `if` and
does not add implicit matching to a boolean condition. See
[PATT-007](patterns-and-destructuring.md#patt-007--if-let-tests-one-refutable-pattern).

An `if` condition cannot be an integer, nominal value, Effect, or other implicitly converted value.
An Effect returning `bool` may be executed conditionally either inside the selected statement arm or
in the right operand of `&&` or `||`. In both forms its failures, requirements, and ownership follow
the ordinary enclosing execution contract.

**Diagnostics:** A non-boolean condition reports `SEM0011` at the condition and identifies its actual
type. Invalid `if` use in expression position receives a parser diagnostic. Each arm retains its own
type, ownership, failure, and requirement diagnostics even though only one arm executes at runtime.

**Evidence:** [conditional syntax](../../../../openspec/specs/bootstrap-syntax/spec.md),
[conditional semantic facts](../../../../openspec/specs/bootstrap-semantic-facts/spec.md),
[short-circuit boundary](../../../../openspec/specs/bootstrap-operator-semantics/spec.md).

### LOOP-001 — `while` is a boolean pre-test loop

**Status:** Confirmed

`while condition { body }` evaluates `condition` before every possible iteration. It enters the body
only when the result is `true`. A false initial result executes the body zero times.

```silk
fn countToThree() -> i32 {
  let mut count = 0
  while count < 3 {
    count = count + 1
  }
  return count
}
```

The condition is evaluated four times, the body three times, and the result is `3`. Body fallthrough
or `continue` begins the next condition evaluation; `break` continues after the loop.

**Boundary:** The condition must be `bool`; there is no integer or optional-value truthiness. The
bootstrap language has no `for`, unconditional `loop`, labeled loop, or value-producing `break`.
Equivalent iteration is expressed with `while` and explicit mutable state.

Every path that repeats must restore a compatible ownership state for outer bindings. Iteration
locals are new lexical owners on each iteration and clean before the next one begins.

**Diagnostics:** A non-boolean condition reports `SEM0011`. A repeating path with incompatible owner
liveness reports `OWN0005` and identifies the loop and affected owner. Other invalid reads, writes,
moves, and borrows receive their ordinary diagnostics.

**Evidence:** [mutable loop specification](../../../../openspec/specs/bootstrap-mutable-loops/spec.md),
[loop ownership](ownership-and-borrowing.md#loop-001--every-repeating-path-must-restore-a-compatible-ownership-state),
[mutable-loop tests](../../../../packages/compiler/test/MutableLoops.test.ts).

### TRANSFER-001 — `break` and `continue` target the innermost loop

**Status:** Confirmed

`continue` ends the current iteration and begins the innermost loop's next condition evaluation.
`break` exits the innermost loop and continues with the following statement. Neither form carries a
value. The loop body establishes this transfer target; its condition is evaluated in the
surrounding transfer context. A match arm inside a condition can return from the enclosing
computation or transfer to an already enclosing loop, but cannot target the loop whose condition
is still being evaluated.

```silk
fn stopAtThree() -> i32 {
  let mut index = 0
  while true {
    if index == 3 {
      break
    }
    index = index + 1
    continue
  }
  return index
}
```

Every live owner created inside an exited arm or iteration is cleaned before the transfer reaches
its target. The transfer does not bypass borrow ending or structured cleanup.

**Boundary:** `break` and `continue` are invalid outside a loop. Bootstrap has no labels for
targeting an outer loop directly and no `break expression` form. `return` exits the function or
Effect body rather than merely exiting a loop.

**Diagnostics:** A loop transfer outside any loop reports `SEM0038`. Supplying a value or label
receives a parser diagnostic. Ownership and cleanup conflicts at a transfer use their ordinary
`OWN` diagnostics.

**Evidence:** [mutable loop specification](../../../../openspec/specs/bootstrap-mutable-loops/spec.md),
[loop cleanup specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[mutable-loop tests](../../../../packages/compiler/test/MutableLoops.test.ts).

## Exhaustive matching

### MATCH-001 — A match states how it accesses its scrutinee

**Status:** Confirmed

A match evaluates its scrutinee exactly once. `match value` is available only when the scrutinee is
Copy. `match move value` consumes one complete owner. `match &value` borrows it shared, and
`match &mut value` borrows one mutable place exclusively. `match place value` inspects the tag of
an owned place and introduces arm-local projection proof without consuming or borrowing the whole
payload. Its explicit field moves occur only after a guard succeeds.

```silk
struct Token { kind: i32 }
struct End {}

fn inspect(event: Token | End) -> i32 {
  return match &event {
    Token { kind } => kind
    End {} => 0
  }
}
```

The shared match leaves `event` owned by the function. Pattern bindings inherit the selected access
mode; a consuming match transfers complete selected payload ownership into its arm.

**Boundary:** A bare affine match is invalid because it would hide whether the operation copies,
borrows, or consumes. A shared or exclusive pattern place cannot escape its arm; a copied stored shared view keeps its
own declared data lifetime. Place refinement cannot leave missing storage through a reference or
an enclosing whole-value user `Drop` hook. An exclusive match requires a mutable place.

**Diagnostics:** A bare affine match reports `OWN0003`. Exclusive access to an immutable root
reports `OWN0007`. An invalid borrowed scrutinee place reports `OWN0009`; escaping a borrowed pattern
binding reports `OWN0006`.

**Evidence:** [match ownership](ownership-and-borrowing.md#match-001--a-match-declares-how-it-accesses-its-scrutinee),
[exhaustive matching specification](../../../../openspec/specs/bootstrap-exhaustive-matching/spec.md).

### MATCH-002 — Nominal patterns are complete or explicitly omit fields

**Status:** Confirmed

A nominal pattern names one possible nominal member and either names every field exactly once or
uses `..` to acknowledge omitted fields. Fields may bind under their own names, bind under another
local name with `field: local`, or contain a nested nominal pattern.

```silk
struct Span {
  start: i32
  end: i32
}

struct Token {
  kind: i32
  span: Span
}

fn start(token: Token) -> i32 {
  return match &token {
    Token { span: Span { start: offset, .. }, .. } => offset
  }
}
```

Pattern bindings are flat, arm-local declarations. They do not shadow an existing declaration in
the same visible scope. In a consuming arm, omitted affine fields remain that arm's cleanup
obligations; `..` does not leak or forget them.

**Boundary:** Omitting a field without `..`, naming one field twice, naming a field absent from the
member, or introducing a conflicting binding makes the arm invalid. A whole-member pattern such as
`Token token` binds the complete payload and therefore needs no per-field list or `..`.

**Diagnostics:** A missing field reports `SEM0046` and suggests naming it or using `..`. A duplicate
field reports `SEM0047`; a binding conflict reports `SEM0048`. Unknown members or fields receive
their specific match or field diagnostic while other supplied pattern facts remain available.

**Evidence:** [exhaustive matching specification](../../../../openspec/specs/bootstrap-exhaustive-matching/spec.md),
[matching tests](../../../../packages/compiler/test/ExhaustiveMatching.test.ts).

### MATCH-003 — Match coverage is exhaustive and guards do not prove coverage

**Status:** Confirmed

Arms are tested in source order. An unguarded member arm covers its member. A guarded arm handles
that member only when its guard evaluates to `true`, so it removes nothing from the remaining
coverage set. `_` covers every remaining member and makes every following arm unreachable.

```silk
struct Token { kind: i32 }
struct End {}

fn classify(event: Token | End) -> i32 {
  return match &event {
    Token { kind } if kind > 0 => kind
    Token { .. } => 0
    End {} => -1
  }
}
```

The second `Token` arm remains necessary because the first arm's guard may be false. Every guard
that completes must have type `bool` and may inspect its provisional pattern bindings without consuming them.
A guard that transfers control exits the enclosing function, Effect, or loop; it does not try another
arm. An all-transferring guard has type `never` and needs no Boolean result.

A scalar enum begins with its complete declared member set. An unguarded qualified member pattern
such as `Status.Ready` covers that exact canonical member; a guarded occurrence does not remove it.
Enum patterns bind no payload, and `_` covers every remaining member just as it does for a
structural union.

A nominal union begins with one coverage leaf for each variant of its complete applied parent.
`Option<i32>.Some { value }` covers only `Option<i32>.Some`; a guarded occurrence removes nothing.
When the parent is itself a structural-union member, coverage retains the outer member and inner
variant path rather than flattening either identity.

**Boundary:** A match missing any member is invalid. A duplicate unguarded member, an arm after `_`,
or another arm made impossible by earlier coverage is unreachable. A guarded arm alone never makes
a member exhaustive.

**Diagnostics:** An incomplete structural-union match reports `SEM0044` and lists the uncovered
members or nominal variant paths. An unreachable arm reports `SEM0043`. Scalar enums use the more
specific coverage codes:
`SEM0158` for missing members, `SEM0159` for a duplicate unguarded member, and `SEM0160` for an arm
after `_`. A non-boolean guard reports `SEM0045`. Consuming a provisional guard binding reports
`OWN0008` because later arms may still need the unchanged payload.

**Evidence:** [exhaustive matching specification](../../../../openspec/specs/bootstrap-exhaustive-matching/spec.md),
[coverage tests](../../../../packages/compiler/test/ExhaustiveMatching.test.ts).

### MATCH-004 — Matching narrows only inside the selected arm

**Status:** Confirmed

Inside a member arm, bindings and projections use that precise member type. The original
scrutinee's declared union type does not change outside the arm. A borrowed match may therefore
inspect a narrowed member and later continue using the unchanged union owner.

```silk
struct Token { kind: i32 }
struct End {}

fn inspect(event: Token | End) -> i32 {
  let result = match &event {
    Token { kind } => kind
    End {} => 0
  }
  return result
}
```

Within the first arm, `kind` comes from a precise `Token`. Outside the match, `event` remains
`Token | End`.

A scalar enum member pattern selects one value but introduces no member subtype or backing-integer
narrowing. The scrutinee and every use of it remain the enum's nominal type inside and outside the
arm.

A nominal-union variant pattern narrows only the selected arm to its active payload fields. It does
not create a variant subtype: the complete applied parent remains the value type transported into
and out of the match.

**Boundary:** Match narrowing does not introduce general subtyping, mutate a binding's declared
type, expose a union's numeric runtime tag, or carry a borrowed member binding outside its arm.

**Diagnostics:** A structural pattern member absent from the scrutinee reports `SEM0042`. A scalar
enum pattern from another enum reports `SEM0161`; an integer literal pattern against an enum reports
`SEM0162`. An unknown nominal variant reports `SEM0167`, and a qualifier that is not a nominal union
reports `SEM0168`. Using a member-only field without branch proof receives the ordinary field/type
diagnostic. Escaping a borrowed narrowed binding reports `OWN0006`.

**Evidence:** [exhaustive matching specification](../../../../openspec/specs/bootstrap-exhaustive-matching/spec.md),
[matching tests](../../../../packages/compiler/test/ExhaustiveMatching.test.ts).

### MATCH-005 — A match joins the results of reachable arms

**Status:** Confirmed

The type of a match expression is computed from reachable arm results. Equal types remain that
type. Views that differ only in their outer region join into one view: arms of `&'a T` and `&'b T`
form `&'r T`, where `'a` and `'b` both outlive `'r`, so both loans stay live while the result is
used. Distinct source-declared nominal value types form one normalized structural union. An arm of
type `never` contributes no result member. Separate occurrence-generated anonymous tuple or record
types do not implicitly join; they require an independently known named aggregate expectation that
is supplied to every arm before analysis.

```silk
struct Left { value: i32 }
struct Right { value: i32 }

fn preserve(input: Left | Right) -> Left | Right {
  return match move input {
    Left left => move left
    Right right => move right
  }
}
```

The result is the normalized union `Left | Right`, independent of arm order.

Immediately after `=>`, braces introduce an ordinary statement block. Its statements execute in
source order with the pattern bindings in scope. Reaching its closing brace produces `()`; the last
statement does not become a result expression. A block whose paths all transfer has type `never`.
A conditional return with a path to the closing brace still produces `()` on that path, and a
`break` targeting a loop inside the block does not make the block non-completing.

```silk
struct Ready { value: i32 }
struct Waiting {}

fn inspect(event: Ready | Waiting) -> i32 {
  match &event {
    Ready { value } => {
      let answer = value + 1
      return answer
    }
    Waiting {} => {}
  }
  return 0
}
```

`return` exits `inspect`, while the empty `Waiting` arm continues to `return 0`. A block creates a
lexical scope, not a callable or Effect invocation. `break` and `continue` target the nearest
lexically enclosing loop, and `fail` uses the enclosing Effect contract. These rules also apply when
the match appears inside an argument, initializer, assignment, guard, or return operand. A transfer
skips the surrounding expression's remaining operands and operations. Live arm owners and abandoned
earlier temporaries are cleaned once in reverse acquisition order before the enclosing exit.

A `()` block arm joins another `()` arm; a `never` arm contributes no value to a scalar join.
If every reachable path transfers, the entire match has type `never`. A completing block and an
`i32` arm do not form a legal join and report `SEM0049` on the match. `{ 42 }` reports the ordinary
unused-value diagnostic `SEM0087`; `{ drop 42 }` completes with `()`. Braces in other expression
positions do not introduce block expressions.

**Boundary:** Result joining does not convert any arm result or erase its ownership and lifetime
properties. If a result type is unavailable or cannot legally be stored in the resulting union, the
match result is unavailable. Same-shaped anonymous aggregate occurrences are distinct nominal
types, not candidates for structural-union synthesis.

**Diagnostics:** An invalid reachable result union reports `SEM0049` and lists the contributing
types and the precise unavailable member. An unreachable arm contributes neither a result type nor
a second result mismatch. Ownership transfers from result expressions remain governed by their
arm's access mode.

PATT-015–019 define exact whole-value bindings for non-nominal union members; nominal patterns keep
the rules in MATCH-002 and all forms share the contextual rules in
[patterns and destructuring](patterns-and-destructuring.md).

**Evidence:** [exhaustive matching specification](../../../../openspec/specs/bootstrap-exhaustive-matching/spec.md),
[match result tests](../../../../packages/compiler/test/ExhaustiveMatching.test.ts).
