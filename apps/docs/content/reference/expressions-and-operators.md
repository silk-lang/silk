# Expressions and operators

Silk expressions produce precisely typed values. Their evaluation order is part of the language:
an eager expression evaluates its children once from left to right, while syntax such as `match`,
`&&`, `||`, and `effect { ... }` states explicitly when evaluation is conditional or deferred.

Value identity and compatibility are defined by [values and types](values-and-types.md). Calls,
pipelines, `if`, loops, and `match` results are defined by
[functions, callables, and control flow](functions-callables-and-control-flow.md). Ownership-changing
forms are defined by [ownership and borrowing](ownership-and-borrowing.md). This page defines how
those forms compose into expressions and how operator syntax behaves.

## Terminology

- An **expression** is source syntax that, when it completes normally, produces one value of one
  precise type.
- A **child expression** is an expression directly evaluated by another expression, such as an
  operand, argument, index, array element, or struct field initializer.
- An **eager expression** evaluates every child before producing its own result.
- A **conditional expression** evaluates only the child selected by its control rule.
- A **deferred expression** constructs a value that describes work without performing that work at
  construction time.
- A **primary expression** is a literal, name, grouped expression, aggregate construction, `match`,
  Effect block, anonymous callable, borrow, `move`, or `run` before postfix operations are applied.
- A **postfix operation** is a field projection, index projection, or call applied after its subject.
- An **operand** is a child supplied to a prefix or infix operator.
- A **place** is storage that assignment may replace: a mutable binding or a field or index rooted
  in writable storage.
- A **trap** is a fatal runtime stop outside the typed failure channel, as defined by
  [typed failures](typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes).

## Expression shape and evaluation

### EVAL-001 — Eager child expressions evaluate once from left to right

**Status:** Confirmed

Every eager expression evaluates each child exactly once in source order from left to right. A child
must complete before the next child begins. An optimizer, backend, ownership mode, or target calling
convention cannot reorder, duplicate, or omit an observable child.

```silk
fn observe(trace: &mut [i32], index: usize, value: i32) -> i32 {
  trace[index] = value
  return value
}

pub fn main() -> i32 {
  let mut trace = [0, 0]
  let result = observe(&mut trace, 0, 20) / observe(&mut trace, 1, 5)
  return result + trace[0] + trace[1]
}
```

The first `observe` call completes before the second begins. The program returns `29`: division
produces `4`, and the later reads observe `20` and `5`.

This rule applies recursively. Struct field initializers evaluate in written source order even when
storage uses declaration order; array elements evaluate from first to last; an index subject
evaluates before its index; and an eager operator evaluates its left operand before its right.

**Boundary:** If an earlier child returns, propagates a typed failure, traps, or otherwise transfers
control, later children do not begin. Compile-time checking still diagnoses invalid source inside a
later child even when runtime control may skip it.

**Diagnostics:** Evaluation order itself needs no diagnostic. Each invalid child receives the
ordinary diagnostic for its own type, ownership, failure, requirement, or place boundary.

**Evidence:** [call evaluation](functions-callables-and-control-flow.md#call-001--a-call-evaluates-each-argument-once-from-left-to-right),
[aggregate TIR evaluation order](../../../../packages/compiler/src/Tir.ts).

### EVAL-002 — Conditional and deferred forms state which children do not evaluate eagerly

**Status:** Confirmed

Only a form with an explicit conditional, deferred, or control-transfer rule may skip or postpone a
child:

| Form                                             | Non-eager behavior                                                               |
| ------------------------------------------------ | -------------------------------------------------------------------------------- |
| `left && right`                                  | Skips `right` when `left` is `false`.                                            |
| `left                                            |                                                                                  | right` | Skips `right` when `left` is `true`. |
| `match value { ... }`                            | Evaluates only the selected arm result after the scrutinee and applicable guard. |
| `effect { ... }` or an `effect fn` call          | Constructs an Effect; the deferred body runs only when that Effect is run.       |
| `return`, `fail`, `break`, `continue`, or a trap | Prevents later runtime evaluation on that path.                                  |

Within the child that does execute, EVAL-001 still applies.

```silk
struct Later {}
struct Now {}

effect fn later() -> i32 {
  return 42
}

fn choose(input: Later | Now) -> i32 {
  return match &input {
    Later {} => run later()
    Now {} => 0
  }
}
```

`later()` is constructed and run only in the `Later` arm.

**Boundary:** A function call, eager arithmetic operator, aggregate constructor, or grouping pair
does not become conditional merely because one child is expensive, effectful, or can trap.

The conditional right operand may contain any otherwise valid expression, including `run`, `move`,
borrowing, mutation, calls, and traps. Its ownership and Effect contracts are checked as an ordinary
conditional branch under OP-010.

**Diagnostics:** Invalid conditional operands use the rule for that form. Conditional evaluation
does not introduce a separate purity diagnostic.

**Evidence:** [short-circuit specification](../../../../openspec/specs/bootstrap-operator-semantics/spec.md),
[Effect construction](effects-and-execution.md#eff-001--calling-an-effect-function-constructs-an-effect),
[match selection](functions-callables-and-control-flow.md#match-001--a-match-states-how-it-accesses-its-scrutinee).

### EXPR-001 — An expression has one precise type and produces one value

**Status:** Confirmed

When an expression completes normally, it produces one value of its precise static type. An
expected context may select an untyped literal or accept a defined compatibility relation, but it
does not make one expression produce different runtime kinds depending on where it appears.

```silk
struct Count { value: i32 }
struct Empty {}

fn measure(input: Count | Empty) -> i32 {
  let value = match &input {
    Count { value } => value
    Empty {} => 0
  }
  return value
}
```

The `match` expression and both completing arms have type `i32`; `value` is therefore `i32`.

**Boundary:** An expression of type `never` does not produce a hidden bottom value. It is accepted
at any expected type because control cannot reach the boundary with a value. An Effect expression
produces an Effect value; it does not produce the Effect's success value until explicitly run.

**Diagnostics:** Incompatible expected boundaries report their boundary-specific type diagnostic.
Incompatible `match` arm results report `SEM0049`. Attempting to use `Effect<A>` where `A` is
required reports the ordinary type mismatch for that source position.

**Evidence:** [precise type rule](values-and-types.md#infer-001--a-binding-keeps-the-precise-type-of-its-initializer),
[nested Effect rule](effects-and-execution.md#eff-003--run-executes-exactly-one-effect-layer),
[match result rule](functions-callables-and-control-flow.md#match-001--a-match-states-how-it-accesses-its-scrutinee).

### EXPR-002 — Postfix operations bind first and compose from left to right

**Status:** Confirmed

Field projection, indexing, and calls bind more tightly than prefix, infix, and pipeline operators.
Repeated postfix operations apply from left to right to the result immediately before them.

```silk
records[row].values[column]
```

This groups as `((records[row]).values)[column]`: read `records`, evaluate `row`, project `values`,
then evaluate `column` and index that value.

```silk
struct Counter { value: i32 }

fn makeCounter() -> Counter {
  return Counter { value: 41 }
}

makeCounter().value + 1
```

The call and projection complete before addition: `(makeCounter().value) + 1`.

**Boundary:** Postfix syntax does not imply a method call, hidden borrow, or conversion. `Actor.fn`
is name qualification when `Actor` is a namespace-like declaration; `Interface<A>.operation`
selects a complete compile-time interface application; and `value.field` is projection when
`value` is a value. The resolved declaration determines which operation the source names. Applied
qualification is not available for service operations.

**Diagnostics:** Projecting a non-struct reports `SEM0026`; an unknown or inaccessible field reports
`SEM0027` or `SEM0028`. Indexing a non-indexable value reports `SEM0032`; a non-`usize` index reports
`SEM0033`; a statically invalid index reports `SEM0034`. Calling a non-callable reports `SEM0075`.

**Evidence:** [postfix parser](../../../../packages/compiler/src/Parser.ts),
[indexing syntax specification](../../../../openspec/specs/bootstrap-syntax/spec.md),
[callable application](functions-callables-and-control-flow.md#call-002--calls-satisfy-the-declared-positional-parameter-contract).

### EXPR-003 — Parentheses change grouping, not evaluation semantics

**Status:** Confirmed

Parentheses select which expression is a child of another expression. They do not copy a value,
extend a borrow, run an Effect, suppress cleanup, or evaluate their contents more than once.

```silk
fn grouped(a: i32, b: i32, c: i32) -> i32 {
  return a * (b + c)
}
```

The addition completes before multiplication because it is the grouped right operand.

**Boundary:** Parentheses cannot repair incompatible operands. `(left) + (right)` remains invalid
when the selected `+` operation cannot accept their precise types.

**Diagnostics:** Grouping introduces no semantic diagnostic. Missing or unmatched parentheses
receive a parser diagnostic at the damaged group boundary; diagnostics within the grouped
expression remain attached to their original source.

**Evidence:** [grouped expression parser](../../../../packages/compiler/src/Parser.ts),
[expression TIR](../../../../packages/compiler/src/Tir.ts).

### EXPR-004 — Assignment and bootstrap `if` are statements, not value expressions

**Status:** Confirmed

`place = value` replaces storage as a statement. It produces no value that can be bound, returned,
passed as an argument, or chained into another assignment. Bootstrap `if` likewise selects a
statement arm rather than producing a value; use an exhaustive `match` when selection must produce
a value.

```silk
pub fn main() -> i32 {
  let mut value = 1
  value = 42
  return value
}
```

**Boundary:** These forms are not valid Silk:

```silk,ignore
let assigned = (value = 42)
left = right = 42
let selected = if flag { 1 } else { 2 }
```

Assignment is distinct from equality: `value = 42` replaces a place, while `value == 42` is a
boolean expression.

**Diagnostics:** Using assignment or `if` where an expression is required receives a parser
diagnostic at that form. Invalid assignment places and replacements receive the semantic diagnostics
defined by the assignment rules later on this page.

**Evidence:** [assignment syntax specification](../../../../openspec/specs/bootstrap-syntax/spec.md),
[conditional statement rule](functions-callables-and-control-flow.md#if-001--if-selects-one-statement-branch-using-a-boolean-condition),
[assignment parser](../../../../packages/compiler/src/Parser.ts).

### EXPR-005 — A non-unit expression result must be used or explicitly discarded

**Status:** Confirmed

An expression may stand alone as a statement only when it produces `()` or has type `never`.
Otherwise the program must bind, return, pass, compose, or explicitly `drop` its result.

```silk
fn compute() -> i32 { return 42 }

pub fn main() {
  drop compute()
}
```

`drop` evaluates `compute()` exactly once and intentionally discards the completed value, including
running its ordinary cleanup when required.

**Boundary:** Merely writing `compute()` is invalid. This rule applies equally to an Effect value:
writing an effect-function call alone neither runs it nor silently throws the Effect away.

**Diagnostics:** An ignored non-unit result reports `SEM0087` at the expression statement and tells
the programmer to bind, return, compose, or explicitly drop it.

**Evidence:** [STMT-001](statements-and-discarding.md#stmt-001--a-non-unit-expression-result-must-be-handled-explicitly),
[expression statement analysis](../../../../packages/compiler/src/Elaboration.ts).

### EXPR-006 — Expression nesting is limited to 256 active child edges

**Status:** Confirmed

The outer expression starts at depth zero. Beginning a direct child expression adds one active
edge: grouped contents, prefix and infix operands, pipeline targets, indexes, arguments, container
elements, aggregate initializers, and `match` children all count. Parser-layer transitions that
still describe the same expression do not add depth. Sequential siblings derive independently
from their common parent, so finishing one argument or element does not consume another sibling's
budget.

Depths zero through 256 are valid. An attempted child at depth 257 is rejected before recursive
descent and reports `PAR0005` on that child's first significant token. The parser retains leading
trivia and scans the rejected expression region without recursion into one lossless `Error` node;
it leaves the owning comma, closing delimiter, statement boundary, or declaration boundary for the
ordinary parser so later syntax remains independently parseable.

**Boundary:** This is an expression-child limit, not a token, syntax-node, type, pattern, statement,
or declaration nesting limit. Call-delimiter recovery bookkeeping does not change the expression
depth. Parser implementation failures such as invalid token ordering remain defects: they are not
caught or converted to `PAR0005`.

**Diagnostics:** `PAR0005` records the fixed limit `256`, the attempted depth `257`, and the exact
half-open span of the first significant token in the rejected child. One maximal rejected region
produces one diagnostic; a later independent over-budget expression may produce its own.

**Evidence:** [expression nesting actor](../../../../packages/compiler/src/Parser/ExpressionNesting.ts),
[bounded expression parser](../../../../packages/compiler/src/Parser/Expression.ts),
[diagnostic catalog](../language/diagnostics.md#parser-par),
[bootstrap syntax specification](../../../../openspec/specs/bootstrap-syntax/spec.md).

### ANON-SYNTAX-001 — Anonymous callable expressions write a complete callable contract

**Status:** Confirmed

An ordinary anonymous callable expression has this form:

```silk
fn(value: i32) -> i32 { return value + 1 }
```

An effectful anonymous callable prefixes the same form with `effect` and may declare failure and
requirement channels after its success type:

```silk
effect fn(error: Failure) -> i32 ! RecoveryError ? &Logger { return 42 }
```

The parameter list, `->`, result or success type, and braced body are mandatory. The failure and
requirement rows are optional and have the same spelling and fixed empty meanings as a named effect
function. Whitespace, comments, punctuation, and source spans remain part of the lossless syntax.

**Boundary:** `effect fn(` begins an effectful anonymous callable, while `effect {` begins a direct
Effect block. Anonymous construction has no name, type-parameter list, declaration modifier,
capture list, or explicit `mut` or `once` modifier. The syntax parser retains a nested anonymous
body for recovery and formatting, but semantic analysis rejects that nesting in this language
slice.

```silk,ignore
fn invalidForms() {
  let missingParameterType = fn(value) -> i32 { return value }
  let missingResult = fn(value: i32) { return value }
  let explicitMode = mut fn(value: i32) -> i32 { return value }
  let namedExpression = fn named(value: i32) -> i32 { return value }
}
```

**Diagnostics:** A missing parameter type, result arrow or type, delimiter, or body receives a
local parser diagnostic. Recovery remains bounded to the anonymous expression so later arguments,
statements, and declarations remain independently parseable.

**Evidence:** [anonymous callable syntax specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-syntax/spec.md),
[anonymous formatting specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/silk-source-formatting/spec.md).

## Operator precedence and dispatch

### OP-001 — Operator precedence and associativity are fixed

**Status:** Confirmed

Silk groups unparenthesized operators using this table, from tightest to loosest:

| Level          | Spellings                          | Associativity   |
| -------------- | ---------------------------------- | --------------- |
| Postfix        | `.field`, `[index]`, `(arguments)` | Left            |
| Prefix         | `-value`, `!value`, `~value`       | Right           |
| Multiplicative | `*`, `/`, `%`                      | Left            |
| Additive       | `+`, `-`                           | Left            |
| Bitwise AND    | `&`                                | Left            |
| Bitwise XOR    | `^`                                | Left            |
| Bitwise OR     | <code>&#124;</code>                | Left            |
| Relational     | `<`, `<=`, `>`, `>=`               | Non-associative |
| Equality       | `==`, `!=`                         | Non-associative |
| Logical AND    | `&&`                               | Left            |
| Logical OR     | <code>&#124;&#124;</code>          | Left            |
| Pipeline       | <code>&#124;&gt;</code>            | Left            |

```silk
fn calculate(a: i32, b: i32, c: i32) -> bool {
  return a + b * c == 14 && true
}
```

`calculate(2, 3, 4)` groups as `((2 + (3 * 4)) == 14) && true` and returns `true`.

Relational and equality operators deliberately do not chain. `a < b < c` and `a == b == c` require
the programmer to state the intended boolean relationship, such as `a < b && b < c`. Parentheses
may create a different, type-checked expression: `(a == b) == flag` compares two booleans.

**Boundary:** `run` is not one of the prefix operators in this table. Its operand extends through
the complete following expression, including a pipeline, until a comma, closing delimiter, block
delimiter, or statement boundary. Use `(run operation)` when the executed success value must
participate in a surrounding expression.

```silk
return run attempt |> Effect.retry(2) // runs the transformed Effect
return (run attempt) + 1              // adds to the executed success value
```

The same boundary matters inside a larger Boolean expression:

```silk
gate && run decide()                    // the right operand is `run decide()`
gate && (run decide()) || useFallback() // `||` is outside the grouped run
```

Without the parentheses in the second line, greedy `run` would consume
`decide() || useFallback()` as its operand. Parentheses terminate `run`; they are not needed merely
to enclose an Effect pipeline.

**Diagnostics:** Missing operands and ungrouped relational or equality chaining receive parser
diagnostics at the damaged or unexpected operator. A well-grouped expression is then checked under
the operand contracts below.

**Evidence:** [operator metadata](../../../../packages/compiler/src/Operator.ts),
[precedence parser](../../../../packages/compiler/src/Parser.ts),
[operator syntax specification](../../../../openspec/specs/bootstrap-syntax/spec.md),
[pipeline rule](functions-callables-and-control-flow.md#pipe-001--a-pipeline-invokes-one-unary-callable-after-evaluating-its-left-value).

### OP-002 — An admitted eager operator is one statically selected operation

**Status:** Confirmed

For the concrete scalar and `string` contracts defined below, an eager operator selects one
operation at compile time. It has the same operand types, result type, evaluation order, trap
behavior, and allocation behavior as that operation's named scalar function.

```silk
fn operatorForm(left: i32, right: i32) -> i32 {
  return left + right
}

fn namedForm(left: i32, right: i32) -> i32 {
  return i32.add(left, right)
}
```

Both functions perform the same checked `i32` addition. Selection introduces no runtime operator
lookup, service requirement, provider slot, truthiness conversion, numeric promotion, retry, Effect
execution, or hidden allocation.

**Boundary:** The closed concrete contracts on this page require no user declaration. An ordinary
user-defined type participates only through the operator's standard-library interface under OP-009;
an operation named `add` or `lessThan` on another interface does not acquire operator syntax.

**Diagnostics:** When no admitted concrete operation accepts the operands, the current compiler
reports `SEM0012` at the incompatible operand using the selected operation's expected and received
types. A future user-defined contract must preserve an equally local diagnostic without falling
back to runtime lookup.

**Evidence:** [operator elaboration](../../../../packages/compiler/src/Elaboration.ts),
[scalar actor modules](../../../../packages/compiler/stdlib/silk),
[operator pipeline tests](../../../../packages/compiler/test/OperatorPipeline.test.ts),
[static interface evidence](../../../../packages/compiler/test/BoundOperationWitness.test.ts).

### OP-003 — Numeric operators require one identical numeric type

**Status:** Confirmed

Binary arithmetic and numeric comparison require both operands to have the same integer type or the
same floating-point type. Arithmetic returns that type; comparison returns `bool`. Unary numeric
negation preserves the operand type and is available only for signed integers and floating-point
types.

An exact literal may receive the other operand's type before it becomes a typed value:

```silk
fn increment(value: u8) -> u8 {
  return value + 1
}
```

The literal `1` is selected as `u8`. This is contextual literal selection, not conversion of an
`i32` value.

A duration literal is already `u64` and does not participate in contextual integer selection.
Consequently, `1h + 30m` is ordinary `u64` addition, while combining a duration literal with an
already typed non-`u64` operand is a type mismatch.

**Boundary:** Two already-typed numeric values never widen, narrow, change signedness, or cross
between integer and floating point to satisfy an operator.

```silk,ignore
fn invalid(left: i32, right: i64) -> i64 {
  return left + right
}
```

Unsigned integers do not admit unary `-`. A negative literal may still be selected as a signed
type; it cannot be selected as an unsigned type or `usize`.

**Diagnostics:** An incompatible typed operand reports `SEM0012` at that operand. An out-of-range
contextual integer literal reports `SEM0002`; a negative `usize` literal reports `SEM0060`.

**Evidence:** [integer literal selection](values-and-types.md#int-002--integer-literals-are-exact-until-an-immediate-context-selects-their-type),
[duration literal values](values-and-types.md#duration-001--duration-literals-are-fixed-u64-nanosecond-values),
[integer scalar specification](../../../../openspec/specs/bootstrap-integer-scalars/spec.md),
[floating scalar specification](../../../../openspec/specs/bootstrap-floating-point-scalars/spec.md).

### OP-004 — Ordinary integer arithmetic traps instead of wrapping

**Status:** Confirmed

For every integer type, `+`, `-`, and `*` trap when the mathematical result is outside that type's
range. `/` and `%` trap on a zero right operand. Signed division and remainder also trap when the
minimum value is combined with `-1`, because the quotient or mandated operation is not
representable. Unary negation traps on the minimum signed value.

Signed division truncates toward zero. Signed remainder takes the dividend's sign:

```silk
pub fn main() -> i32 {
  return (-7 / 2) * 10 + (-7 % 2)
}
```

The result is `-31`: `-7 / 2` is `-3`, and `-7 % 2` is `-1`.

**Boundary:** A trap is not a typed failure and cannot be caught, returned, or declared in an
Effect failure channel. When overflow or invalid division is recoverable application data, use a
named `checked*` operation returning `Option<T>`. When modular or clamped arithmetic is intended,
use the corresponding named `wrapping*` or `saturating*` operation where supplied.

For every signed width, `checkedRemainder(MIN, -1)` returns `Option<T>.None` on every executor exactly where
ordinary `%` traps. It never reaches a backend remainder instruction whose behavior differs at that
boundary.

Bitwise operators do not perform arithmetic overflow, and explicit wrapping or saturating
functions do not inherit the ordinary operator's trap policy.

**Diagnostics:** Valid operator types receive no compile-time diagnostic merely because a runtime
value may trap. A runtime arithmetic trap identifies the source operation and retains its
provenance consistently across supported targets.

**Evidence:** [integer operation specification](../../../../openspec/specs/bootstrap-integer-scalars/spec.md),
[trapping MIR contract](../../../../openspec/specs/bootstrap-mir/spec.md),
[integer differential corpus](../../../../packages/compiler/test/support/corpus.ts),
[trap separation](typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes).

### OP-005 — Floating operators preserve width and conservative IEEE behavior

**Status:** Confirmed

`f32` and `f64` each admit unary `-`, arithmetic `+`, `-`, `*`, `/`, `%`, equality, and ordered
comparison with operands of the same width. Arithmetic results keep that width. Basic arithmetic
rounds to nearest with ties to even, and compilation does not silently enable fast-math
assumptions.

Floating overflow and division by zero produce IEEE infinities or NaN rather than integer-style
traps. Ordinary ordered comparisons involving NaN return `false`; `NaN == NaN` is `false` and
`NaN != NaN` is `true`. Positive and negative zero compare equal, though representation operations
can distinguish them.

Floating `%` uses exact IEEE `fmod` semantics: for operands `x` and `y`, the mathematical result is
`x - n*y`, where `n` is `x/y` truncated toward zero, without exposing an intermediate rounding or
overflow. The result has the dividend's sign, including negative zero. A finite dividend modulo an
infinite divisor returns the dividend; an infinite dividend, zero divisor, or NaN operand produces
NaN. Native and LLVM-generated WebAssembly execution produce identical finite result bits.

```silk
fn unordered(value: f64) -> bool {
  let nan = value / 0.0
  return nan != nan
}
```

When `value` is zero, `nan` is NaN and the function returns `true`.

**Boundary:** `f32` and `f64` do not mix implicitly. Ordinary `<` does not provide a total order for
NaN encodings or distinguish signed zero; use the named `totalOrder` or representation operations
when that distinction is part of the program's contract.

**Diagnostics:** A mixed-width or non-floating operand reports `SEM0012`. IEEE infinity, NaN, and
rounded finite results are values, not diagnostics or traps.

**Evidence:** [floating scalar specification](../../../../openspec/specs/bootstrap-floating-point-scalars/spec.md),
[floating actor modules](../../../../packages/compiler/stdlib/silk/f32.silk),
[floating-point tests](../../../../packages/compiler/test/FloatingPointScalars.test.ts),
[pinned native arithmetic corpus](../../../../packages/compiler/test/support/corpus.ts).

### OP-006 — Concrete comparison availability is explicit and narrow

**Status:** Confirmed

The concrete comparison operators are available as follows:

| Operand type                      | `==`, `!=` | `<`, `<=`, `>`, `>=` | Meaning                                        |
| --------------------------------- | ---------- | -------------------- | ---------------------------------------------- |
| `bool`                            | Yes        | No                   | Exact Boolean equality                         |
| Any identical integer type        | Yes        | Yes                  | Signed or unsigned numeric order for that type |
| `f32` or `f64` of identical width | Yes        | Yes                  | Ordinary IEEE comparison                       |
| `char`                            | Yes        | Yes                  | Unicode scalar-value order                     |
| `string`                          | Yes        | No                   | Exact UTF-8 sequence equality                  |
| One identical scalar enum type    | Yes        | No                   | Declared member identity                       |

Every comparison returns `bool` and evaluates both operands left to right exactly once.

```silk
fn ordered(left: char, right: char) -> bool {
  return left < right
}

fn same(left: string, right: string) -> bool {
  return left == right
}
```

Character ordering is not locale collation, normalization, or grapheme ordering. String equality
does not normalize, case-fold, or allocate.

**Boundary:** Structs, arrays, unions, references, slices, callable values, Effect values, and
services do not receive implicit structural or identity equality. Boolean, string, and scalar enum
ordering are also unavailable. Enum equality additionally requires one canonical enum type under
OP-011. A future user-defined equality or ordering contract must be declared explicitly; it cannot
be inferred from representation.

**Diagnostics:** An unavailable comparison reports `SEM0012` at the incompatible operand under the
current operator diagnostic model.

**Evidence:** [scalar catalog](../../../../packages/compiler/src/Scalar.ts),
[character actor](../../../../packages/compiler/stdlib/silk/char.silk),
[string equality tests](../../../../packages/compiler/test/StringIntrinsics.test.ts),
[character tests](../../../../packages/compiler/test/CharacterScalar.test.ts).

### OP-007 — Boolean operators require booleans and preserve short-circuit order

**Status:** Confirmed

`!value`, `left && right`, and `left || right` accept only `bool` and return `bool`. Silk performs no
truthiness conversion.

`&&` evaluates its right operand only when the left operand is `true`. `||` evaluates its right
operand only when the left operand is `false`.

```silk
fn inRange(value: i32) -> bool {
  return value >= 0 && value < 10
}
```

The second comparison begins only after the first returns `true`.

**Boundary:** `&&` and `||` are language control forms rather than eager calls; no ordinary
two-argument function could preserve their skipped-right behavior. Their conditional right operand
may contain `run`, `move`, mutation, or any other otherwise-valid expression under OP-010.

**Diagnostics:** A non-boolean operand reports `SEM0012` at that operand. No separate purity
diagnostic applies to the right operand.

**Evidence:** [short-circuit specification](../../../../openspec/specs/bootstrap-operator-semantics/spec.md),
[short-circuit tests](../../../../packages/compiler/test/ShortCircuitOperatorAcceptance.test.ts),
[conditional evaluation](#eval-002--conditional-and-deferred-forms-state-which-children-do-not-evaluate-eagerly).

### OP-008 — Bitwise operators accept identical integer types only

**Status:** Confirmed

`left & right`, `left ^ right`, `left | right`, and `~value` operate on the fixed-width bit
representation of any integer type and return that same type. Binary operands must have one
identical integer type. These operations do not overflow or trap.

```silk
fn lowNibble(value: u8) -> u8 {
  return value & 15
}
```

The literal `15` is contextually selected as `u8`, and the result contains only the low four bits.

**Boundary:** Booleans, characters, floating-point values, and other values do not admit integer
bitwise operators. Silk currently has no `<<` or `>>` surface operator; shifts and rotates are named
integer functions. `rotateLeft` and `rotateRight` reduce every count by unsigned Euclidean modulo
the value's lane width, so an out-of-range count wraps and a signed count of `-1` is equivalent to
width minus one. Every executor applies the same reduction.

Prefix `&value` is borrow syntax, while infix `left & right` is bitwise AND. Their grammatical
positions distinguish them without runtime inspection.

**Diagnostics:** A non-integer or mismatched operand reports `SEM0012` at that operand. Bitwise
results themselves do not produce arithmetic traps.

**Evidence:** [bitwise operator tests](../../../../packages/compiler/test/BitwiseOperatorAcceptance.test.ts),
[operator metadata](../../../../packages/compiler/src/Operator.ts),
[integer actor modules](../../../../packages/compiler/stdlib/silk).

### OP-009 — Each overloadable operator is bound to one standard-library interface

**Status:** Confirmed

A user-defined type gets an operator by implementing that operator's interface from the standard
library. The table is closed and fixed; no declaration can bind an operator, and no other interface
or operation name has operator meaning.

| Operator                             | Interface operation                                                          |
| ------------------------------------ | ---------------------------------------------------------------------------- |
| `a + b`                              | `silk.ops.Add<Right, Output>.add(left: Self, right: Right) -> Output`        |
| `a - b`                              | `silk.ops.Subtract<Right, Output>.subtract`                                  |
| `a * b`                              | `silk.ops.Multiply<Right, Output>.multiply`                                  |
| `a / b`                              | `silk.ops.Divide<Right, Output>.divide`                                      |
| `a % b`                              | `silk.ops.Remainder<Right, Output>.remainder`                                |
| `a & b`, `a \| b`, `a ^ b`           | `silk.ops.BitAnd`, `BitOr`, `BitXor` `<Right, Output>`                       |
| `-a`, `~a`, `!a`                     | `silk.ops.Negate<Output>.negate`, `BitNot<Output>.bitNot`, `Not<Output>.not` |
| `a == b`, `a != b`                   | `silk.equal.Equal.equals(left: &Self, right: &Self) -> bool`                 |
| `a < b`, `a <= b`, `a > b`, `a >= b` | `silk.order.Order.compare(left: &Self, right: &Self) -> Ordering`            |

The left (or only) operand is the provider: `a * b` means `Multiply<B, Output>.multiply(a, b)` for
the conformance of `a`'s type, where `B` is `b`'s type and `Output` is whatever that conformance
declares. The conformance is found like any other (IMPL-004): in the interface's module or in the
module that declares the provider. No imported module is scanned for operator declarations, so
importing a module or declaring an interface elsewhere cannot change which operation an existing
use selects.

```silk,ignore
import silk.ops { Multiply }

impl Multiply<f64, Vector> for Vector { multiply: Vector.scale }
impl Multiply<Vector, f64> for Vector { multiply: Vector.dot }
impl Multiply<Vector, Vector> for Matrix { multiply: Matrix.apply }
impl Multiply<Matrix, Matrix> for Matrix { multiply: Matrix.multiply }
```

These conformances permit `Vector * f64 -> Vector`, `Vector * Vector -> f64`, `Matrix * Vector ->
Vector`, and `Matrix * Matrix -> Matrix`. The types are ordinary library types; they need not become
compiler-built-in merely to use mathematical notation.

Comparison operators evaluate both operands once, in written order, then test one result. `!=` is
the negation of `Equal.equals`. The ordering operators compare `Order.compare(a, b)` with one
`Ordering` member: `<` tests `== Less`, `<=` tests `!= Greater`, `>` tests `== Greater`, and `>=`
tests `!= Less`. Their result is `bool`.

Operator selection uses the precise operand types. It does not use the expected result type,
perform implicit conversion, inspect runtime tags, or choose by import order. Exactly one
conformance must accept the operands. Its declared result becomes the expression's type. Inside a
generic body, a bound such as `T: Add<T, T>` or `T: Order` supplies the operation.

Concrete scalar and `string` operands always use the built-in operators of OP-002 to OP-008; the
standard library's own conformances for scalars, such as `Add<i32, i32> for i32`, serve generic
bounds.

The interface operation remains available by name, independently of the operator:

```silk,ignore
let direct = Multiply<f64, Vector>.multiply(move vector, 2.0)
let symbolic = move vector * 2.0
```

Both select the same conformance and operation.

**Boundary:** Arithmetic, bitwise, and logical operators take their operands by value; comparisons
take shared references, so the source writes `&a < &b` for an affine type. Operator syntax adds no
implicit borrowing, copying, or consumption; an affine operand is written with `move`. The
operator interfaces are ordinary, non-Effect operations. Short-circuit `&&` and `||`, `|>`, `run`,
assignment, and other control forms are not overloadable. A type may implement one operator
interface for several `Right` types, but two conformances that accept the same operand types are
ambiguous; the expected result type never chooses between them.

This table is the one place the compiler knows standard-library declarations by name (the operator
exception to minimal compiler privilege). Conformance selection after the binding is ordinary.

**Diagnostics:** No conformance accepting the operands reports `SEM0135` at the operator. More than
one reports `SEM0136`, listing the competing conformances. A missing bound in a generic body reports
the ordinary unsatisfied-bound diagnostic. The former `operator` declaration marker is not syntax;
writing one reports the parser's unexpected-token diagnostic.

**Current compiler:** Aligned. Generic bounds and concrete conformances use the same fixed binding
and static witness selection.

**Evidence:** [operator interfaces](../../../../packages/compiler/stdlib/silk/ops.silk),
[equality](../../../../packages/compiler/stdlib/silk/equal.silk),
[ordering](../../../../packages/compiler/stdlib/silk/order.silk),
[operator contract tests](../../../../packages/compiler/test/OperatorContracts.test.ts),
[conformance implementation forms](requirements-and-services.md#serv-001--a-conformance-may-define-or-map-each-operation).

### OP-010 — A short-circuit right operand follows ordinary branch semantics

**Status:** Confirmed

The right operand of `&&` or `||` may contain any expression that is otherwise valid in its
enclosing function or Effect body. This includes Effect execution, moves, borrows, mutation, calls,
typed failure propagation, and expressions that can trap. The operator adds conditional evaluation,
not a separate purity system.

```silk,ignore
effect fn permitted() -> bool {
  return true
}

effect fn choose(gate: bool) -> bool {
  return gate && run permitted()
}
```

`permitted()` is constructed and run only when `gate` is `true`. Its success type must be `bool`;
its failures and requirements participate in `choose` exactly as they would inside a selected `if`
arm.

A conditional move is tracked on the path where the right operand executes:

```silk,ignore
struct Token { permitted: bool }

fn consume(token: Token) -> bool {
  return token.permitted
}

fn choose(gate: bool, token: Token) -> bool {
  return gate && consume(move token)
}
```

When `gate` is `true`, `token` moves into `consume`. When it is `false`, `token` remains owned by
`choose` and is cleaned on that return path. Each runtime path has exactly one owner.

**Boundary:** A use after the short-circuit expression is valid only when its owner is live on every
path reaching that use. This remains invalid because the `true` path may consume `token`:

```silk,ignore
fn invalid(gate: bool, token: Token) -> bool {
  let result = gate && consume(move token)
  return token.permitted
}
```

Likewise, `run` does not bypass the enclosing execution boundary. An ordinary function still must
handle every failure and requirement before running an Effect; an effect function must declare or
handle the channels that can propagate. Short-circuiting changes whether runtime execution reaches
the operation, not its static contract.

**Diagnostics:** A non-boolean completed right operand reports `SEM0012`. Invalid Effect execution
uses the ordinary `run`, unhandled-failure, or unhandled-requirement diagnostic. A later use reached
from a path where its owner moved reports `OWN0001` and relates the move. No short-circuit purity
diagnostic exists.

**Evidence:** [branch ownership](ownership-and-borrowing.md#flow-001--ownership-is-valid-on-every-path-that-reaches-an-operation),
[Effect execution boundaries](effects-and-execution.md#eff-006--an-ordinary-function-may-run-only-a-closed-effect),
[short-circuit elaboration](../../../../packages/compiler/src/Elaboration.ts),
[conditional mutation and evaluation tests](../../../../packages/compiler/test/ShortCircuitOperatorAcceptance.test.ts).

### OP-011 — Scalar enum equality is nominal and ordering requires representation access

**Status:** Confirmed

`==` and `!=` accept scalar enum operands only when both have the same canonical enum type. They
compare declared member identity and return `bool`; the enum's backing integer is not an implicit
operand.

```silk
enum Status { Pending, Ready }

fn isReady(status: Status) -> bool {
  return status == Status.Ready
}
```

`<`, `<=`, `>`, and `>=` do not order enum members. A program that deliberately wants discriminant
order first exposes both integers with `Enum.value`:

```silk
fn earlier(left: Status, right: Status) -> bool {
  return Status.value(left) < Status.value(right)
}
```

**Boundary:** Two enums with identical member names and discriminants remain incomparable by
equality because their nominal identities differ. An enum does not compare directly with its
representation integer, and declaration order alone does not create source-level ordering.

**Diagnostics:** Equality between different enums reports `SEM0156`; equality between an enum and
an integer reports `SEM0155`; direct enum ordering reports `SEM0157`. The diagnostic points at the
operator rather than pretending that either operand converted.

**Evidence:** [scalar enum operator rules](../../../../openspec/specs/bootstrap-scalar-enums/spec.md),
[enum operator tests](../../../../packages/compiler/test/OperatorContracts.test.ts),
[enum value access](values-and-types.md#enum-004--enumvalue-exposes-the-backing-integer-in-one-direction).

## Assignment and replacement

### ASSIGN-001 — Assignment replaces one complete writable place

**Status:** Confirmed

`place = value` is a statement that replaces one complete initialized value. The destination may be
a mutable binding, a field rooted in writable storage, or an indexed element rooted in writable
storage. The replacement must have the destination's exact type or satisfy one of the language's
explicit compatibility relations.

```silk
struct Counter { value: i32 }

pub fn main() -> i32 {
  let mut counter = Counter { value: 1 }
  counter.value = 42
  return counter.value
}
```

The root remains one complete initialized owner before and after the statement.

Assignment through a reference or slice requires exclusive access:

```silk
fn setFirst(values: &mut [i32], value: i32) {
  values[0] = value
}
```

**Boundary:** `mut` makes a local root writable; it does not override an active loan. A shared
reference or slice is not writable. Assignment cannot target a literal, temporary result, function,
namespace, or other expression that does not denote one writable place.

**Diagnostics:** Assignment through an immutable root reports `SEM0035`. A structurally invalid or
non-exclusive destination reports `SEM0036`. An incompatible replacement reports `SEM0037` at the
right expression. Ownership and loan conflicts retain their corresponding `OWN` diagnostic.

**Evidence:** [mutable ownership rule](ownership-and-borrowing.md#own-005--mutation-requires-one-live-mutable-root-owner),
[assignment syntax](../../../../openspec/specs/bootstrap-syntax/spec.md),
[assignment analysis](../../../../packages/compiler/src/Elaboration.ts).

### ASSIGN-002 — Assignment validates its destination before evaluating its replacement

**Status:** Confirmed

Assignment follows one observable sequence:

1. Evaluate the destination's index expressions once from left to right and validate the complete
   writable place, including dynamic bounds.
2. Evaluate the right expression exactly once.
3. Clean the displaced value exactly once when its type requires cleanup.
4. Commit the replacement, leaving the destination completely initialized.

```silk
fn replacement() -> i32 {
  return 42
}

fn write(values: &mut [i32], index: usize) {
  values[index] = replacement()
}
```

If `index` is out of bounds, the bounds trap occurs before `replacement()` begins.

**Boundary:** If destination validation does not complete, the right expression does not begin. If
the right expression propagates a typed failure, returns, or traps before commit, assignment does
not displace the old value. The old value remains the destination's initialized value until
ordinary structured exit or fatal termination applies its own rules.

Cleanup of the displaced value is part of the commit boundary, not an operation that may be moved
before right-hand evaluation. Backends may optimize this sequence only when the program cannot
observe a difference.

**Diagnostics:** Evaluation order itself has no diagnostic. Invalid places use `SEM0035` or
`SEM0036`; incompatible values use `SEM0037`. Dynamic bounds failure and runtime traps retain the
destination, right-expression, or cleanup provenance that caused them.

**Evidence:** [mutable-loop assignment specification](../../../../openspec/specs/bootstrap-mutable-loops/spec.md),
[destination-before-right test](../../../../packages/compiler/test/MutableLoops.test.ts),
[replacement MIR contract](../../../../packages/compiler/src/Mir.ts).

### ASSIGN-003 — A replacement cannot consume its own destination

**Status:** Confirmed

The destination and any source consumed to create its replacement must not overlap.

```silk,ignore
struct Token { value: i32 }

fn invalid() -> i32 {
  let mut token = Token { value: 42 }
  token = move token
  return token.value
}
```

Assignment is not a self-move or ownership-renaming operation. The source must remain valid while
the replacement is computed, and the displaced destination must retain a distinct cleanup
obligation until commit.

**Boundary:** Reading Copy data from the destination while computing its replacement is valid:

```silk
pub fn main() -> i32 {
  let mut value = 41
  value = value + 1
  return value
}
```

Disjoint borrowed places remain governed by the ordinary alias and place-overlap rules.

**Diagnostics:** A replacement that consumes an overlapping destination reports `OWN0004` at the
assignment and identifies the consumed source place.

**Evidence:** [overlap ownership rule](ownership-and-borrowing.md#own-006--an-assignment-cannot-consume-its-own-destination),
[overlapping replacement tests](../../../../packages/compiler/test/MutableLoops.test.ts).

### ASSIGN-004 — `Intrinsic.replace` swaps a place and returns its previous value

**Status:** Confirmed

`Intrinsic.replace(place, value)` uses the same writable-place and evaluation rules as assignment,
stores the replacement, and produces the previous value. The place remains initialized throughout
the swap, so the old affine value can transfer to the result without creating a partial move.

```silk
struct State { code: i32 }

fn swap(state: &mut State, code: i32) -> i32 {
  let previous = Intrinsic.replace(state.code, code)
  return previous
}
```

After `swap` completes, `state.code` contains `code` and the function returns the displaced value.

**Boundary:** This is a sealed source-callable intrinsic because an ordinary eager function argument
would read a value rather than preserve writable-place identity. A standard-library actor cannot be
recognized specially by name merely to wrap it. A future first-class place abstraction could expose
an ordinary wrapper without changing the swap contract.

The first argument must be one valid writable place; it cannot be an arbitrary value or shared
borrow. The second argument must provide the complete replacement type.

**Diagnostics:** Invalid places reuse `SEM0035` and `SEM0036`; an incompatible replacement reuses
`SEM0037`; wrong arity reports `SEM0007`. Ownership conflicts use the same diagnostics as
assignment.

**Current specifications:** Disputed in spelling. One OpenSpec requirement still says
`Place.replace`, while the implementation and the minimal compiler-privilege rule expose the
operation under the sealed `Intrinsic` namespace. Reconciliation should retain `Intrinsic.replace`
unless Silk first gains an ordinary representation of writable places.

**Evidence:** [place-replacement semantic requirement](../../../../openspec/specs/bootstrap-semantic-facts/spec.md),
[current implementation](../../../../packages/compiler/src/Elaboration.ts),
[place replacement tests](../../../../packages/compiler/test/PlaceReplace.test.ts).

### ASSIGN-005 — Compound assignment is not currently language syntax

**Status:** Confirmed

Silk currently has only plain `=` assignment. Spell a read-modify-write explicitly:

```silk
pub fn main() -> i32 {
  let mut count = 40
  count = count + 2
  return count
}
```

**Boundary:** `+=`, `-=`, `*=`, `/=`, `%=`, and bitwise assignment spellings are unsupported. If
compound assignment is added later, it must evaluate a dynamic destination only once and preserve
ASSIGN-002's validation, cleanup, and commit order; it cannot be a textual rewrite that duplicates
an index or projection computation.

**Diagnostics:** A compound-assignment spelling receives a lexer or parser diagnostic at the
unsupported token sequence. No semantic compound-assignment operation is synthesized.

**Evidence:** [assignment parser](../../../../packages/compiler/src/Parser.ts),
[operator vocabulary](../../../../packages/compiler/src/Operator.ts).

## Explicit conversion

### CONV-001 — Conversion is an explicit named operation

**Status:** Confirmed

Silk has no cast expression and operator syntax never converts an already-typed value. Numeric
conversion uses a named function on the source type's actor module:

```silk
fn widen(value: i32) -> i64 {
  return i32.toI64(value)
}

fn piped(value: i32) -> i64 {
  return value |> i32.toI64
}
```

The direct and piped forms perform the same explicit conversion.

Scalar enum representation access follows the same explicit-source principle but is not a general
cast: `Status.value(status)` exposes one declared member's backing integer, and Silk provides no
built-in integer-to-enum inverse. See
[ENUM-004](values-and-types.md#enum-004--enumvalue-exposes-the-backing-integer-in-one-direction).

**Boundary:** Contextual selection of an exact literal is not conversion. `let` inference, an
operator result context, assignment, return, and argument passing do not silently insert `toI64`,
change signedness, or cross between integer and floating point.

Syntax such as `value as i64` or `(i64)value` is not part of Silk. A library may define a more
domain-specific named conversion without changing the language rule.

**Diagnostics:** An unconverted type mismatch uses the diagnostic of its expected boundary, such as
`SEM0012` for an argument or operator operand and `SEM0037` for assignment. Unknown conversion
functions use the ordinary actor-operation diagnostic.

**Evidence:** [narrow compatibility](values-and-types.md#type-003--compatibility-is-exact-except-for-closed-named-relations),
[integer actor modules](../../../../packages/compiler/stdlib/silk/i32.silk),
[floating actor modules](../../../../packages/compiler/stdlib/silk/f64.silk),
[scalar enum representation access](values-and-types.md#enum-004--enumvalue-exposes-the-backing-integer-in-one-direction).

### CONV-002 — Integer conversion chooses trapping or checked range handling explicitly

**Status:** Confirmed

An integer actor's `toX` operation returns the destination integer type and traps when the source
value is outside its range. The corresponding `checkedToX` operation returns `Option<X>`, producing
`Option<X>.Some` when representable and `Option<X>.None` otherwise.

```silk
import silk.option { Option }

fn narrow(value: i64) -> Option<u8> {
  return i64.checkedToU8(value)
}
```

Use the checked form when range failure is recoverable input rather than a violated program
invariant.

Integer-to-floating conversion uses `toF32` or `toF64`. Every integer magnitude is within the
floating type's exponent range, but a large magnitude may round because the destination has less
integer precision.

**Boundary:** A mathematically exact conversion at one runtime value is still explicit. Signedness,
width, and pointer-sized identity remain part of the type even on a target where two representations
happen to have equal width.

**Diagnostics:** A trapping conversion with statically compatible source and destination types has
no compile-time range diagnostic for a dynamic value. An out-of-range execution traps at the
conversion operation. A checked conversion returns `Option<X>.None` rather than reporting a diagnostic or
typed failure.

**Evidence:** [integer scalar specification](../../../../openspec/specs/bootstrap-integer-scalars/spec.md),
[integer conversion APIs](../../../../packages/compiler/stdlib/silk/i64.silk),
[integer scalar tests](../../../../packages/compiler/test/IntegerScalars.test.ts).

### CONV-003 — Floating conversion states its rounding and trap boundary

**Status:** Confirmed

`f32.toF64` preserves every binary32 value exactly. `f64.toF32` rounds to binary32 using
round-to-nearest ties-to-even; a finite magnitude outside binary32 range becomes infinity.

Floating-to-integer `toX` operations discard the fractional part toward zero and trap for NaN,
infinity, or a truncated value outside the destination integer's range.

```silk
fn whole(value: f64) -> i32 {
  return f64.toI32(value)
}
```

`whole(42.9)` returns `42`; `whole(-42.9)` returns `-42`.

**Boundary:** Floating conversion is not bit reinterpretation. It may round or change the
mathematical value according to its documented destination semantics. It does not silently occur
when `f32` and `f64`, or floating and integer values, meet at an operator or call.

**Diagnostics:** A valid conversion call has no compile-time diagnostic merely because its dynamic
value may trap or round. Invalid dynamic integer conversion traps at the conversion operation with
source provenance. An unavailable conversion name or wrong source type uses the ordinary call
diagnostic.

**Evidence:** [floating scalar specification](../../../../openspec/specs/bootstrap-floating-point-scalars/spec.md),
[floating conversion APIs](../../../../packages/compiler/stdlib/silk/f64.silk),
[floating-point tests](../../../../packages/compiler/test/FloatingPointScalars.test.ts).

### CONV-004 — Bit reinterpretation is distinct from numeric conversion

**Status:** Confirmed

`f32.toBits` and `f32.fromBits` reinterpret between `f32` and `u32`; `f64.toBits` and `f64.fromBits`
reinterpret between `f64` and `u64`. They preserve the exact same-width bit pattern, including
signed zero and NaN encodings, rather than preserving a mathematical number.

```silk
fn isNegativeZero(value: f64) -> bool {
  return f64.toBits(value) == f64.toBits(-0.0)
}
```

**Boundary:** `f64.toU64(value)` is numeric conversion and can trap; `f64.toBits(value)` is
representation access and accepts every `f64` bit pattern. `f64.fromBits` accepts every `u64`
pattern, including encodings that represent NaN.

No ordinary operator performs bit reinterpretation implicitly.

**Diagnostics:** Same-width bit reinterpretation has no value-dependent diagnostic or trap.
Incorrect widths or operand types use the ordinary call type diagnostic.

**Evidence:** [floating representation specification](../../../../openspec/specs/bootstrap-floating-point-scalars/spec.md),
[floating actor modules](../../../../packages/compiler/stdlib/silk/f64.silk),
[floating representation tests](../../../../packages/compiler/test/FloatingPointScalars.test.ts).
