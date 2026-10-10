# Generics, interfaces, and specialization

Generics let one declaration operate over types that are not yet concrete. Interfaces state which
operations such a type must support, conformances prove that a nominal type supplies those
operations, and specialization turns each reachable generic application into concrete executable
code.

Every interface has one implicit compile-time provider type named `Self`. Interface arguments
describe additional contract parameters; `impl Interface<Arguments> for Provider` binds `Self` to
the provider. This does not introduce methods or runtime interface values.

## Terminology

- A **generic declaration** binds one or more parameters in `<...>`.
- A **type parameter** is a canonical placeholder owned by one generic declaration.
- A **type argument** is the concrete type or other kind-correct argument applied to a parameter.
- A **generic application** pairs a generic declaration with ordered type arguments.
- A **bound** is a declared interface requirement on a type parameter.
- An **interface** is a compile-time contract containing named operation signatures.
- A **provider type** is the nominal type whose conformance supplies an interface's operations. This
  term does not imply an Effect service provider.
- **`Self`** is the implicit provider type inside an interface contract or its `impl` body.
- A **conformance** is an `impl` declaration proving that one provider type implements one interface
  application.
- A **witness** is the compiler's static evidence connecting an interface operation to its
  implementation. A witness is not a source-level runtime value.
- **Specialization** substitutes concrete generic arguments and selected conformances into a
  reachable generic declaration.
- **Monomorphic** code contains concrete types and static call targets rather than runtime generic
  parameters.
- **Coherence** means that one concrete provider/interface goal has at most one applicable
  conformance.

## Generic declarations and applications

Lifetime parameters use the same declaration list with a distinct argument namespace. For example,
`View<'data, T>` retains both a data-validity parameter and an ordinary type parameter. Omitting
lifetimes follows [header elision](lifetimes.md); the explicit-prefix and inference rules below
continue to govern ordinary arguments. `T: 'data` constrains borrowed contents, and
`'long: 'short` constrains validity regions. These predicates never initiate implementation search.
Lifetime arguments are erased from runtime specialization and physical layout identity.

### GEN-001 — Each generic parameter has a declaration-local canonical identity

**Status:** Confirmed

A generic parameter belongs to exactly one declaration. Its identity is the declaring module,
declaration, ordinal, and kind—not its source spelling alone.

```silk
struct Box<T> {
  value: T
}

fn identity<T>(value: T) -> T {
  return move value
}
```

`Box.T` and `identity.T` are distinct parameters even though both are spelled `T`. Within each
declaration, every use resolves to that declaration's parameter.

Parameters are ordered. A declaration may bind ordinary type parameters and the specialized kinds
defined by other language areas. In the confirmed Effect model, failure parameter `E` is an
ordinary type parameter; a requirement parameter is written `?R` and ranges only over requirement
rows.

```silk,ignore
effect fn preserve<A, E, ?R>(
  pending: once Effect<A ! E ? R>
) -> A ! E ? R {
  return run pending
}
```

`E` may also appear in any other ordinary type position. `R` may appear only where a requirement
row is accepted.

**Boundary:** A parameter is not visible outside its declaration, and another nominal type named
`T` does not replace it. Two parameters in one list cannot claim the same local spelling.

```silk,ignore
fn invalid<T, T>(value: T) -> T {
  return move value
}
```

Representation parameters such as `F: fn(A) -> B` have the same declaration-local identity rule;
REP-001 through REP-006 define their distinct kind, inference, joining, and result boundaries.

**Diagnostics:** A duplicate parameter reports the existing duplicate-parameter diagnostic at the
later declaration and identifies the earlier one. An unbound parameter-like name reports the
ordinary unknown-type diagnostic. Using `?R` in an ordinary value position reports `SEM0088` and
identifies the requirement-row kind. Using ordinary `E` as a failure type is valid and must not
request `!E` or `Row<!E>` syntax.

**Current compiler:** Aligned for failure parameters. `E` is an ordinary type parameter; only
requirement-row, callable-representation, and Effect-representation parameters retain specialized
kinds in this area.

**Evidence:** [generic Effect contract](effect-contracts.md#eff-012--ordinary-failure-types-and-generic-requirement-rows-preserve-a-contract),
[current generic specification](../../../../openspec/specs/bootstrap-type-generics/spec.md),
[type-parameter parser](../../../../packages/compiler/src/Parser.ts),
[canonical type representation](../../../../packages/compiler/src/Type.ts).

### GEN-002 — A generic nominal type application is explicit and canonical

**Status:** Confirmed

A generic nominal type used in a type position supplies exactly one ordered, kind-correct argument
for every parameter. The resulting type is identified by the nominal declaration plus its
normalized arguments.

```silk
struct Pair<A, B> {
  first: A
  second: B
}

fn first(pair: Pair<i32, bool>) -> i32 {
  return pair.first
}
```

Every occurrence of `Pair<i32, bool>` denotes the same applied nominal type. `Pair<bool, i32>` is a
different type because parameter order is part of the application.

**Boundary:** A type position does not infer omitted nominal arguments from later use. Applying
arguments to a non-generic declaration, omitting an argument, supplying an excess argument, or
supplying an argument of the wrong kind is invalid.

```silk,ignore
fn incomplete(value: Pair<i32>) -> i32 {
  return value.first
}
```

A struct construction expression is not a declared type position. It may infer omitted generic
arguments from its supplied fields under GEN-007; signatures, annotations, and nested declared
types still require complete applications.

**Diagnostics:** Wrong arity reports the expected and supplied argument counts at the application.
A wrong-kind argument identifies the parameter name, expected kind, and supplied form. Applying
arguments to a non-generic declaration reports that the declaration accepts no type arguments.
The compiler must not fabricate an unavailable partial nominal type and continue as if it were
concrete.

**Evidence:** [generic application specification](../../../../openspec/specs/bootstrap-type-generics/spec.md),
[nominal type identity](values-and-types.md),
[type resolution](../../../../packages/compiler/src/DeclarationResolution.ts).

### GEN-003 — A generic call infers only from supplied arguments and declared constraints

**Status:** Confirmed

A generic call may write a contiguous ordered prefix of type arguments. The compiler fixes that
prefix and infers every remaining parameter from the call's supplied value arguments and declared
constraints.

```silk
fn choose<A, B>(left: A, right: B) -> A {
  drop right
  return move left
}

let inferred = choose(42, true)       // A = i32, B = bool
let prefixed = choose<i32>(42, true)  // A = i32, B = bool
```

Inference is positional and must produce one consistent argument for every required parameter.
Explicit arguments do not suppress checking: the supplied values must still satisfy the resulting
parameter types and bounds.

After explicit arguments and supplied operands have fixed a provider, one direct applied-interface
bound may contribute the arguments from that provider's unique visible coherent conformance. For
example, if `context: C` fixes `C = Inspection` and the only selected conformance is
`BufferedContext<Transport, usize, BufferError, ?&mut Clock> for Inspection`, a bound
`C: BufferedContext<P, A, E, ?R>` fills `P`, `A`, `E`, and `R`. This is monotonic constraint
evidence: it fills holes but must agree with every explicit or operand-derived binding already in
the call.

This prefix form is required by existing Effect APIs that explicitly choose one service-role key
while inferring success, failure, requirement, provider, and remainder parameters from their value
arguments.

**Boundary:** Expected result types, assignments, returns, or later uses may validate a completed
call but cannot infer an otherwise unknown parameter or choose among constraint candidates.

```silk,ignore
fn empty<T>() -> T

let value: i32 = empty() // T remains unknown
let explicit = empty<i32>()
```

Written arguments cannot skip a parameter in the middle, be reordered by name, or follow an
inferred hole. The compiler queries only an already-known provider; it does not enumerate
conformances to invent an unknown provider, use the expected result to choose one, or solve
membership, subset, or difference rows backwards. Missing, ambiguous, or conflicting evidence
leaves the specialization invalid, and declaration or import order never breaks a tie.

Interface evidence remains compile-time-only. Selecting it adds no runtime witness operand,
service requirement, dispatch slot, or erased higher-ranked callable representation.

**Diagnostics:** Too many explicit arguments report their first excess argument. A wrong-kind
prefix identifies the corresponding parameter. Conflicting explicit and inferred evidence reports
the parameter, written argument, and argument implied by the supplied value. A parameter with no
valid evidence reports the existing uninferred-parameter diagnostic at the call.

**Current documentation:** The older bootstrap type-system issue states that a call must supply
every type argument or none. That direction is superseded. The current compiler, generic OpenSpec,
and stable rule use an ordered prefix because provider APIs and ordinary partial selection depend
on it.

**Evidence:** [current inference specification](../../../../openspec/specs/bootstrap-type-generics/spec.md),
[call specialization](../../../../packages/compiler/src/CallResolution.ts),
[provider inference](requirements-and-services.md#serv-007--provision-infers-exactly-one-compatible-requirement-key).

### GEN-004 — A generic body is checked once against its declared contract

**Status:** Confirmed

The compiler checks a generic declaration while its parameters are still abstract. The body may
use ordinary operations valid for every value of the parameter's kind, compiler-owned type
properties where the language exposes them, and operations promised by explicit interface bounds.

```silk
fn identity<T>(value: T) -> T {
  return move value
}
```

Moving and returning the whole value is valid independently of `T`'s eventual concrete type.

An interface bound grants only that interface's declared operations:

```silk,ignore
fn decode<T: Decoder<i32>>(value: &T) -> i32 {
  return Decoder.decode(value)
}
```

The bound states that provider `T` implements `Decoder<i32>`. The body relies on that declared
evidence rather than its future call sites.

**Boundary:** A concrete specialization cannot make an operation valid retroactively. An
unconstrained generic body is invalid when it calls an operation that merely happens to exist for
all currently known arguments.

```silk,ignore
fn decode<T>(value: &T) -> i32 {
  return Decoder.decode(value)
}
```

Silk does not use duck typing, inspect a concrete type during body checking, or re-run source-level
type checking separately for each specialization. Copy and cleanup remain compiler-verified type
properties rather than ordinary customizable interfaces.

A value-kind parameter also remains an ordinary symbolic type when used as an Effect failure. If a
generic body constructs `effect { fail move problem }` for `problem: E`, local contract collection
retains `E` in the failure channel. A later concrete specialization must preserve that failure at
every `run`; it cannot disappear merely because the generic body was checked before `E` became
nominal or concrete.

**Diagnostics:** An operation absent from the generic contract reports an unavailable-operation or
missing-bound diagnostic at the use and names the parameter involved. A later conforming call does
not suppress that declaration diagnostic. A declared bound with no visible interface reports an
unknown-interface diagnostic at the bound.

**Evidence:** [generic body specification](../../../../openspec/specs/bootstrap-type-generics/spec.md),
[ownership properties](ownership-and-borrowing.md),
[generic Effect failure regression](../../../../packages/compiler/test/EffectBlockTyping.test.ts),
[interface-bound tests](../../../../packages/compiler/test/InterfaceBounds.test.ts).

### GEN-005 — Every reachable generic application becomes finite monomorphic code

**Status:** Confirmed

A complete reachable generic application has concrete arguments before execution. Equivalent
applications reuse one canonical specialization; different arguments produce different
specializations when their runtime representation or selected operations differ.

```silk
fn identity<T>(value: T) -> T {
  return move value
}

pub fn main() -> i32 {
  let flag = identity(true)
  drop flag
  return identity(42)
}
```

The program reaches concrete `identity<bool>` and `identity<i32>` instances. Runtime code does not
receive a generic type descriptor, interface dictionary, requirement-row record, or reflective type
value.

This rule is observable through accepted programs, static call behavior, target parity, and code
size, but names or counts of backend symbols are not source-level API.

**Boundary:** An open generic callable or unresolved row cannot cross into runtime merely because
its eventual applications might be discoverable dynamically. Every executable path must close its
arguments and evidence through finite static reachability.

This first stabilization model does not include existential interface storage, heterogeneous
collections of unknown conforming values, dynamic witness lookup, or runtime specialization.

**Diagnostics:** A reachable application with unresolved parameters, ambiguous evidence, or a
non-concrete requirement row is rejected before lowering and identifies the responsible call or
escaping callable. A backend must not report an internal MIR error for a generic application that
semantic analysis could not close.

**Evidence:** [finite specialization specification](../../../../openspec/specs/bootstrap-type-generics/spec.md),
[instance discovery](../../../../packages/compiler/src/Instances.ts),
[specialization identity](../../../../packages/compiler/src/Specialization.ts).

### GEN-006 — Recursive generic calls cannot grow a new type argument chain

**Status:** Confirmed

A recursively reachable call normally reuses its current concrete generic arguments. A concrete
interface witness may delegate through a bounded helper to another concrete specialization when
its type arguments do not grow, or when a concrete field or type argument strictly descends while
other type arguments remain fixed or descend. Hidden Effect identities may differ on a strict
descent. These routes keep specialization finite.

```silk,ignore
fn walk<T>(value: T, remaining: i32) -> T {
  if remaining == 0 {
    return move value
  }
  return walk<T>(move value, remaining - 1)
}
```

The recursive call reuses the same `walk<T>` specialization. A concrete witness can also call a
bounded helper at a smaller or equally sized concrete type, such as `decodeOne<Outer>()` delegating
to `decodeOne<i32>()`. An Effect witness can delegate from a concrete aggregate to its field type
even when its hidden Effect identity changes. The reachable type shapes remain finite.

**Boundary:** Ordinary polymorphic recursion that changes a type argument is outside the stable
model. Witness delegation that grows a type argument along a recursive call cycle is also invalid:

```silk,ignore
fn grow<T>(value: T) -> i32 {
  return grow<Box<T>>(Box<T> { value: move value })
}
```

Each step would require another specialization and no finite static family follows from the source.
Mutual recursion is subject to the same rule across the complete cycle.

**Diagnostics:** A disallowed recursive call reports a polymorphic-recursion diagnostic at that
call and shows the current and requested applications. It must be rejected before instance
discovery recursively expands the family.

**Evidence:** [runtime specialization requirement](../../../../openspec/specs/bootstrap-type-generics/spec.md),
[generic instance discovery](../../../../packages/compiler/src/Instances.ts).

### GEN-007 — Struct construction infers omitted arguments from supplied fields

**Status:** Confirmed

A generic struct literal may write a contiguous ordered prefix of generic arguments and infer the
remainder from its supplied field initializers and declared parameter constraints.

```silk,ignore
struct Pair<A, B> {
  first: A
  second: B
}

let inferred = Pair {
  first: 42,
  second: true
} // Pair<i32, bool>

let prefixed = Pair<i32> {
  first: 42,
  second: true
} // Pair<i32, bool>
```

Inference treats every parameter kind uniformly. Ordinary types, requirement rows, and exact
callable or Effect representations may be inferred when field evidence determines them. A written
prefix is fixed and every initializer must remain compatible with it.

The same parameter appearing in several fields contributes one shared constraint:

```silk,ignore
struct Same<T> {
  left: T
  right: T
}

Same { left: 1, right: 2 }    // Same<i32>
Same { left: 1, right: true } // invalid: conflicting T
```

**Boundary:** Inference does not use an expected assignment type, function return type, later use,
or whichever type would make an interface bound succeed. A parameter absent from every supplied
field remains unknown and must be written explicitly:

```silk,ignore
struct Marker<T> {}

let unknown = Marker {}      // invalid
let marker = Marker<i32> {}  // valid
```

Written arguments cannot skip a parameter, and a literal must still supply every required field
exactly once. The completed inferred application is an ordinary canonical nominal type; it does not
remain partially generic at runtime.

**Diagnostics:** Conflicting initializers identify the generic parameter and the first and
conflicting field evidence. A parameter with no field or explicit evidence reports an uninferred-
parameter diagnostic at the literal. Wrong-kind and explicit-prefix conflicts use the same
application diagnostics as a generic call. All such failures occur before ownership or lowering.

**Current compiler:** Aligned. Construction collects field evidence for omitted ordinary, row, and
representation parameters after a written prefix, retains every origin, and rejects missing or
conflicting evidence before TIR lowering.

**Evidence:** [representation inference tests](../../../../packages/compiler/test/RepresentationInference.test.ts),
[struct literal analysis](../../../../packages/compiler/src/ExpressionAnalysis.ts),
[generic call inference](#gen-003--a-generic-call-infers-only-from-supplied-arguments-and-declared-constraints).

## Executable representation parameters

### REP-001 — A callable or Effect representation parameter preserves one exact implementation

**Status:** Confirmed

`F: CallableContract` and `F: EffectContract` bind an exact executable representation that satisfies
the declared use contract.

```silk
struct Parser<F: fn(i32) -> i32> {
  parse: F
}

struct Deferred<F: once Effect<i32>> {
  operation: F
}
```

The contract states how code may use the stored behavior. `F` separately identifies its exact named
function, callable-construction site, or Effect-construction site together with the environment
layout and cleanup behavior needed by that implementation.

```silk,ignore
let decimal = Parser { parse: parseDecimal }
let hexadecimal = Parser { parse: parseHexadecimal }
```

The two values have different complete `Parser` types even though both implementations satisfy
`fn(i32) -> i32`. Captured values are runtime data inside a representation; two executions of the
same construction site with different captured data still share one representation identity and
layout.

**Boundary:** A representation parameter is not an ordinary result type, interface, service,
runtime function pointer, dictionary, or reflection token. Matching callable or Effect signatures
do not make independently constructed representations equal. The exact representation retains one
intrinsic identity even when the same reusable function is admitted under both `fn` and `once fn`
use contracts.

**Diagnostics:** Supplying an ordinary type, row, callable with an incompatible invocation mode, or
Effect with incompatible success, failure, requirement, or run-access channels reports a kind or
contract mismatch at the argument. The diagnostic separates the required use contract from the
supplied exact representation.

**Current compiler:** Aligned. It already distinguishes callable and Effect representation
parameters from ordinary type and row parameters and retains intrinsic identity separately from
use-bound admissibility.

**Evidence:** [representation parameter specification](../../../../openspec/specs/bootstrap-representation-parameters/spec.md),
[callable value specialization](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[representation type tests](../../../../packages/compiler/test/RepresentationType.test.ts).

### REP-002 — Construction infers exact representations and generics preserve them

**Status:** Confirmed

Construction normally infers a representation parameter from its corresponding field. Generic
functions may accept, borrow, nest, project, and return the open parameter; every reachable call
then specializes it to one exact representation.

```silk
fn apply<F: fn(i32) -> i32>(
  parser: &Parser<F>,
  value: i32
) -> i32 {
  return parser.parse(value)
}
```

Calling `apply` with decimal and hexadecimal parsers creates distinct concrete specializations with
static call targets. A complete nominal application carries `F` as one canonical argument just as
it carries ordinary type and row arguments, but that argument produces no runtime type descriptor.

Open representation parameters may cross generic function parameters and results, nested nominal
fields, and borrows as long as the signature preserves them explicitly. Before layout, MIR, or
execution, every reachable path must substitute one finite exact representation.

**Boundary:** A generic declaration may forward `F`; an executable instance may not leave it open.
Silk does not recover a representation later from source spelling, runtime value inspection, actor
names, or backend-specific layout guesses. A structural callable or Effect contract alone has no
standalone storage layout in the first stable model.

**Diagnostics:** A reachable value whose representation remains open reports an unresolved-
representation diagnostic at the escape or application before lowering. An incompatible forwarded
bound identifies both the source parameter contract and destination field or parameter contract.

**Current compiler:** Aligned. Representation identity survives substitution, nominal nesting,
borrows, TIR, and instance discovery and must be concrete before layout and MIR.

**Evidence:** [representation forwarding](../../../../openspec/specs/bootstrap-representation-parameters/spec.md),
[representation inference tests](../../../../packages/compiler/test/RepresentationInference.test.ts),
[finite callable specialization](../../../../openspec/specs/bootstrap-callable-values/spec.md).

### REP-003 — Representation-dependent values join only at exact type equality

**Status:** Confirmed

Assignment, branch, return, and aggregate joins accept represented values only when their complete
nominal applications—including exact representation arguments—are equal.

```silk,ignore
let parser = if hexadecimal {
  Parser { parse: parseHexadecimal }
} else {
  Parser { parse: parseDecimal }
}
// invalid: the branches produce different Parser types
```

Distinct representations may instead be consumed before the join:

```silk,ignore
let result = if hexadecimal {
  Parser { parse: parseHexadecimal }.parse(16)
} else {
  Parser { parse: parseDecimal }.parse(10)
}
// result: i32
```

**Boundary:** Silk does not insert allocation, boxing, existential packaging, type erasure,
indirect dispatch, or a uniform closure ABI to make different representations join. A future
explicit erased-callable type may provide those costs and semantics, but it is not implicit and is
not part of the first stable model.

**Diagnostics:** A divergent join identifies the complete expected and supplied represented types
and points to the first deterministic origin of each representation. It suggests consuming the
values within their branches or introducing an explicit future erasure boundary rather than
claiming that equal callable signatures imply equal types.

**Current compiler:** Aligned. It rejects representation-divergent branch, assignment, result, and
aggregate joins and accepts branch-local consumption to a common ordinary result.

**Evidence:** [static representation joins](../../../../openspec/specs/bootstrap-representation-parameters/spec.md),
[representation join tests](../../../../packages/compiler/test/RepresentationInference.test.ts).

### REP-004 — `some` exposes a contract while keeping one representation private

**Status:** Confirmed

The result form `some<F: Contract> Result` binds one declaration-owned opaque executable
representation `F` over the complete result type.

```silk
fn add(left: i32, right: i32) -> i32 {
  return left + right
}

pub fn makeAdder(value: i32) -> some<F: fn(i32) -> i32> F {
  return add(value)
}
```

A caller knows that the returned value satisfies `fn(i32) -> i32` and may invoke, store, or forward
it through signatures that preserve its opaque type. The callable construction site, captures,
layout, cleanup behavior, and static call target remain private to `makeAdder`. Calls such as
`makeAdder(1)` and `makeAdder(2)` contain different runtime capture values but have the same opaque
result type and representation layout.

The binder may describe a callable or Effect representation and may occur more than once within
the complete result:

```silk
pub fn makeTask(value: i32) -> some<F: Effect<i32>> F {
  return effect {
    return value
  }
}
```

`some` is contextual result syntax, not a general runtime existential type. The first stable model
binds exactly one representation parameter, not ordinary type parameters or Effect row parameters,
and requires a function body that can establish its private realization. Bodyless interface and
service operations therefore cannot declare an opaque result.

**Boundary:** An opaque result does not erase a representation into its structural contract. It
does not insert a box, allocate storage, carry a runtime type tag, select a type per execution, or
introduce dynamic dispatch. The compiler retains and specializes the private concrete
representation while source outside the producer cannot name it.

**Diagnostics:** A non-representation binder reports an invalid-opaque-binder diagnostic. A result
that does not use the binder, cannot construct its realization, or appears on a bodyless operation
reports the corresponding error at the result declaration rather than failing during lowering.

**Current compiler:** Aligned. Callable and Effect opaque results preserve a compiler-private
realization through specialization and lower without existential packaging, allocation, or
indirect dispatch.

**Evidence:** [opaque representation result specification](../../../../openspec/specs/bootstrap-opaque-representation-results/spec.md),
[opaque result syntax tests](../../../../packages/compiler/test/OpaqueResultSyntax.test.ts),
[opaque realization tests](../../../../packages/compiler/test/OpaqueRealization.test.ts).

### REP-005 — One producer specialization has exactly one opaque realization

**Status:** Confirmed

Every reachable return from one opaque producer specialization must resolve to the same exact
representation. Returning the same representation through control flow is valid:

```silk,ignore
fn identity(value: i32) -> i32 {
  return value
}

pub fn selectIdentity(flag: bool) -> some<F: fn(i32) -> i32> F {
  if flag {
    return identity
  }
  return identity
}
```

Returning independently declared or constructed representations is invalid even when their use
contracts match:

```silk,ignore
fn decimal(value: i32) -> i32 { return value }
fn hexadecimal(value: i32) -> i32 { return value }

pub fn selectParser(hex: bool) -> some<F: fn(i32) -> i32> F {
  if hex {
    return hexadecimal
  }
  return decimal
}
// invalid: `hexadecimal` and `decimal` are different exact representations
```

Each producer declaration owns a distinct opaque family. Two producers do not return the same
opaque type merely because their contracts and private realizations happen to match. For a generic
producer, its enclosing generic arguments are part of the opaque application, so `make<i32>()` and
`make<bool>()` are distinct concrete opaque types.

A producer may forward another opaque result as its own realization. Recursive and mutually
recursive producers must nevertheless have finite local construction evidence; a cycle that can
discover its representation only by calling itself is invalid.

**Boundary:** Opaque family identity is a compile-time nominal boundary. It never appears as
runtime metadata. Values from distinct opaque families obey REP-003 and cannot join implicitly.

**Diagnostics:** Divergent reachable returns identify the first conflicting representation
origins. A producer with no construction evidence reports a missing-realization diagnostic. A
realization-only recursion or an infinitely inline opaque capture reports a cycle diagnostic before
layout.

**Current compiler:** Aligned. It distinguishes producer families, specializes them over enclosing
generic arguments, verifies every reachable return, and rejects realization and inline-layout
cycles.

**Evidence:** [opaque realization tests](../../../../packages/compiler/test/OpaqueRealization.test.ts).

### REP-006 — `typeof(item)` names a deliberately exposed exact representation

**Status:** Confirmed

`typeof(item)` names the exact representation of one fully specialized, visible named callable
item:

```silk
fn identity(value: i32) -> i32 {
  return value
}

pub fn identityFunction() -> typeof(identity) {
  return identity
}
```

Use this form only when that exact named representation is intentionally part of the signature.
Use `some<F: Contract> Result` for the ordinary public abstraction boundary. A generic item must be
fully specialized inside `typeof`, and every declaration exposed by a public exact signature must
itself be sufficiently visible.

Anonymous callable sections, Effect construction sites, local bindings, and private items cannot
escape through a public `typeof` result. Those cases use an opaque result so that the public
contract remains nameable without exposing private layout identity.

**Boundary:** `typeof` is a static representation name, not general value reflection, a runtime
type query, or a way to infer an open generic item from expected context.

**Diagnostics:** An open generic item, non-callable declaration, ambiguous name, local or anonymous
construction, or insufficiently visible item reports an exact-representation diagnostic and
suggests an opaque result when appropriate.

**Current compiler:** Aligned for named callable items and public visibility fences.

**Evidence:** [exact representation result specification](../../../../openspec/specs/bootstrap-opaque-representation-results/spec.md),
[exact representation syntax tests](../../../../packages/compiler/test/ExactRepresentationSyntax.test.ts).

## Interface declarations and bounds

### INTF-001 — Every interface has one implicit compile-time provider named `Self`

**Status:** Confirmed

`Self` names the type whose conformance supplies an interface's operations. It is available inside
the interface body without appearing in the interface's generic parameter list.

```silk,ignore
interface Decoder<A> {
  fn decode(value: &Self) -> A
}
```

`Decoder` has one explicit interface argument, `A`. Its provider is not a second argument. Applying
the contract as `Decoder<i32>` therefore means “the `Decoder` contract whose result is `i32`”; a
bound or `impl` states which type is `Self`.

`Self` may appear anywhere an ordinary type is accepted inside an operation contract, including
parameters, returns, nested generic types, and Effect success or failure types:

```silk,ignore
interface CloneValue {
  fn clone(value: &Self) -> Self
}
```

The interface may omit `Self` from an operation entirely. This supports statically selected
operations such as schema or default-value construction:

```silk,ignore
interface SchemaOf<T> {
  fn schema() -> Schema<T>
}
```

**Boundary:** `Self` is a compile-time type binding, not a value parameter, implicit runtime
receiver, method namespace, generic argument, or service requirement. The declaration above does
not create `value.decode()` syntax, inject operations into a nominal type, or permit an interface
value to be stored.

Outside an interface and its corresponding inline `impl` body, `Self` is not a general type alias.
A declaration cannot introduce another parameter named `Self` or explicitly supply a `Self`
argument inside `Decoder<...>`.

**Diagnostics:** Using `Self` outside an interface or inline conformance body reports an unavailable-
type diagnostic at that spelling. Declaring a generic parameter or nominal type named `Self` in a
scope where the implicit binding exists reports a reserved-binding collision. Supplying an extra
provider argument to an interface application reports the ordinary interface-argument arity error.

**Current compiler:** Aligned. Every interface and service contract records implicit `Self`, while
its written generic parameters contain only additional contract arguments. Bounds and
conformances bind the provider without adding a duplicated interface argument.

**Evidence:** [current interface parser](../../../../packages/compiler/src/Parser.ts),
[current interface application](../../../../packages/compiler/src/DeclarationFacts.ts).

### INTF-002 — An interface contains compile-time operation contracts, not implementations

**Status:** Confirmed

An interface body declares zero or more named operations. Each operation is an ordinary `fn` or
`effect fn` contract with the same explicit parameters, ownership modes, result, failure type, and
requirement row as a named function.

```silk,ignore
interface Decoder<A, E, ?R> {
  effect fn decode(value: &Self) -> A ! E ? R
}
```

`E` is an ordinary type parameter and may specialize to one type or union. `?R` is a requirement-
row parameter. Calling the operation constructs exactly one Effect layer under the ordinary Effect
rules; the interface does not flatten its success value.

Interface operations have no bodies. Behavior is supplied by a conformance, either inline there or
by mapping an actor function. A public interface exposes all of its operation names as one public
contract; operations do not carry separate visibility modifiers.

An empty interface is valid. It proves a nominal compile-time property without inventing operations
or runtime storage. Compiler-sealed properties such as Copy eligibility remain separate language
properties and do not become ordinary empty interfaces.

**Boundary:** An interface is not a struct, callable bundle, service slot, inherited base type, or
namespace that can be reopened. It cannot declare fields, constants, mutable state, stored values,
or default operation bodies in the first stable model.

```silk,ignore
interface Invalid {
  value: i32
}
```

A service reuses this operation model but receives the separate permission to appear in an Effect
requirement row. An ordinary interface never creates that permission.

**Diagnostics:** A field, constant, operation body, visibility modifier on an operation, or other
unsupported member reports an invalid-interface-member diagnostic at that member. Duplicate
operation names report the later declaration and identify the first. Invalid function contracts
retain their ordinary parameter, type, Effect-channel, and ownership diagnostics.

**Current compiler:** Aligned. Ordinary and effect operation contracts share the same declaration
facts for interfaces and services, including ordinary failure types and requirement-row binders.

**Evidence:** [complete interface contracts](../../../../openspec/specs/bootstrap-complete-interface-contracts/spec.md),
[service/interface boundary](requirements-and-services.md#serv-003--a-service-is-a-dependency-eligible-interface),
[interface parser](../../../../packages/compiler/src/Parser.ts).

### INTF-003 — A bound applies an interface to its provider parameter

**Status:** Confirmed

`T: Interface<Arguments>` states that open provider type `T` conforms to that complete interface
application. Inside the declaration, the bound substitutes `Self = T` and makes the interface's
operations available under that contract.

```silk,ignore
interface Decoder<A> {
  fn decode(value: &Self) -> A
}

fn decode<T: Decoder<i32>>(value: &T) -> i32 {
  return Decoder.decode(value)
}
```

When an interface has no explicit arguments, its bound uses only the interface name:

```silk,ignore
interface Hashable {
  fn hash(value: &Self) -> u64
}

fn hash<T: Hashable>(value: &T) -> u64 {
  return Hashable.hash(value)
}
```

There is no omitted provider shorthand: `T` is always the provider because it appears to the left
of `:`. Every explicit interface argument must still be present and kind-correct.

**Boundary:** A bound is compile-time evidence, not a hidden runtime parameter. It does not allocate
a witness table, change the value representation of `T`, or make the interface itself a storable
type. An interface name with missing explicit arguments is invalid rather than inferred from the
bound's result use.

A single bound does not implicitly include parent interfaces, structural operations, or every
interface implemented by its future concrete type. Multiple requirements use the explicit
conjunction defined by INTF-004.

**Diagnostics:** An unknown or non-interface bound reports an invalid-bound diagnostic at the
bound. Wrong interface-argument arity or kind uses the ordinary application diagnostic. A concrete
call whose inferred provider lacks the required conformance reports a missing-conformance
diagnostic at the generic application and names the full provider/interface goal.

**Current compiler:** Aligned. A bound records the provider on its left and the complete interface
application on its right; no provider argument is synthesized into that application.

**Evidence:** [current interface-bound tests](../../../../packages/compiler/test/InterfaceBounds.test.ts),
[conditional conformance specification](../../../../openspec/specs/bootstrap-conditional-interface-conformance/spec.md),
[bound declaration facts](../../../../packages/compiler/src/DeclarationFacts.ts).

### INTF-004 — `+` joins independent bounds on one parameter

**Status:** Confirmed

`T: First + Second<Arguments>` states that provider `T` must satisfy every listed interface
application. The conjunction is unordered compile-time evidence; it is not a type, value, runtime
witness bundle, or general intersection operator.

```silk,ignore
fn inspect<T: Hashable + Display>(value: &T) -> string {
  let hash = Hashable.hash(value)
  drop hash
  return Display.display(value)
}
```

The generic body may use operations from both contracts. A concrete call is valid only when its
provider has one coherent conformance for each complete goal. `Display + Hashable` has the same
meaning as `Hashable + Display`; source order does not affect proof, operation selection,
specialization identity, or diagnostics.

Different applications of one interface may appear together:

```silk,ignore
fn convertBoth<T: Convert<i32> + Convert<string>>() -> () {
  let number = Convert.defaultI32<T>()
  let text = Convert.defaultString<T>()
  drop number
  drop text
}
```

Both conformances are available, but a bare `Convert.default()` remains ambiguous when its
operands do not select one. Ordinary generic actor helpers establish a single bound at each call,
as defined by INTF-006.

**Boundary:** `+` has this meaning only between interface applications in a bound list. It does not
construct a union or interface value, imply inheritance, add Effect requirements, or change the
ownership of the bounded provider. A service declaration may participate as an ordinary
compile-time contract; merely naming it in a bound does not request that service at runtime.

The first stable model has no bound aliases, named bound sets, or `where` clause. Reusable behavior
may be extracted into an ordinary generic actor function, while each public generic declaration
states the bounds it actually uses.

**Diagnostics:** Repeating the same normalized application, such as `T: Display + Display`, reports
a duplicate-bound diagnostic at the later occurrence. An invalid member retains its unknown-
interface, wrong-arity, or wrong-kind diagnostic. At a concrete application, each missing or
ambiguous conformance is reported as its complete provider/interface goal; the compiler does not
stop at whichever bound happens to be written first.

**Current compiler:** Aligned. Parsing and declaration facts preserve every normalized conjunct,
static calls can select operations from each contract, and duplicate conjuncts are diagnosed.

**Evidence:** [bound parser](../../../../packages/compiler/src/Parser.ts),
[bound facts](../../../../packages/compiler/src/DeclarationFacts.ts),
[static operation selection](#intf-006--a-qualified-interface-call-requires-one-static-application).

### INTF-005 — Interface operations use their declared ownership and Effect contracts

**Status:** Confirmed

Substituting a provider and interface arguments produces one complete operation contract. Value,
shared-borrow, and exclusive-borrow operands keep their declared meanings; results and Effect
channels keep their declared types.

```silk,ignore
interface Transform<A, E, ?R> {
  effect fn transform(
    context: &Self,
    input: A
  ) -> A ! E ? R
}
```

A generic caller borrows `Self`, transfers ownership of `input`, and receives
`Effect<A ! E ? R>`. No operand gains an extra reference merely because it passes through an
interface. `input: A` is not adapted to `&A`, and `context: &Self` is not adapted to `&&Self`.

The declared failure and requirement channels are upper bounds for conforming implementations.
Calling through the interface retains the interface contract even when the selected implementation
has smaller channels.

**Boundary:** Interface dispatch does not execute an Effect, flatten a nested Effect, copy an affine
operand, upgrade shared access to exclusive access, consume a borrowed provider, or introduce
service requirements absent from the operation contract.

```silk,ignore
interface Decoder {
  effect fn decode(value: &Self) -> i32
}

// Effect<Effect<i32>> does not satisfy Effect<i32>.
effect fn nested(value: &Schema) -> Effect<i32> {
  return inner(value)
}
```

**Diagnostics:** An operation use receives the same argument, ownership, return, failure, and
requirement diagnostics as an ordinary function with the substituted contract. A nested Effect used
where its success value is required reports the ordinary type mismatch rather than an interface-
specific backend failure.

**Evidence:** [literal interface operands](../../../../openspec/specs/bootstrap-complete-interface-contracts/spec.md),
[Effect nesting](effects-and-execution.md#eff-004--nested-effects-are-ordinary-values),
[Effect declaration bounds](effect-contracts.md#eff-009--declared-failure-and-requirement-channels-are-upper-bounds).

### INTF-006 — A qualified interface call requires one static application

**Status:** Confirmed

`Interface.operation(arguments)` and `Interface<Arguments>.operation(arguments)` refer to a named
interface operation, not to an ordinary module function or runtime method. The compiler must
determine one complete interface application and one provider from the written application, the
supplied operands, or the current bound contract.

```silk,ignore
fn decode<T: Decoder<i32>>(value: &T) -> i32 {
  return Decoder.decode(value)
}
```

Here the only `Decoder` bound fixes application `Decoder<i32>` and provider `T`; the operand confirms
the same `Self`. A concrete call may similarly infer `Self` from an operand and select a unique
visible conformance.

Writing the interface arguments selects the application when one provider implements more than one
application:

```silk,ignore
impl Encodable<u32> for Age { /* ... */ }
impl Encodable<string> for Age { /* ... */ }

let numeric = run Encodable<u32>.encode(&age)
let textual = run &age |> Encodable<string>.encode
```

The direct and piped forms select the same static operation contract and witness. The pipeline's
left value is the operation's leading operand; it is not method lookup and does not add an implicit
borrow.

Interface operation lookup is distinct from a same-named actor function. The qualifier identifies
the interface declaration, while the selected static witness identifies the implementation. Import
order and expected result types do not select among applications.

**Boundary:** A call is invalid when no application is available or when multiple applications
remain possible after considering explicit source information and supplied operands. The compiler
does not guess from the expected result, declaration order, or whichever conformance it discovers
first.

Zero-operand operations use the same rule. An ordinary generic actor function can expose a concise
public operation by introducing the bound that selects the application:

```silk,ignore
// Schema.silk
fn of<T: SchemaOf>() -> Schema<T> {
  return SchemaOf.schema()
}

pub const UserSchema =
  Schema.of<User>()
    |> Schema.check(...)
```

The explicit argument to `Schema.of<User>()` fixes `T = User`. The bound inside `Schema.of` then
fixes `Self = User` and the `SchemaOf` application without runtime evidence.

The same route lets one concrete witness invoke another type's witness:

```silk,ignore
interface Decode { fn decode() -> Self }
impl Decode for i32 { fn decode() -> Self { return 42 } }

struct Outer { value: i32 }
fn decodeOne<T: Decode>() -> T { return Decode.decode() }
impl Decode for Outer {
  fn decode() -> Self { return Outer { value: decodeOne<i32>() } }
}
```

The explicit `i32` argument selects the child witness. Writing `Decode.decode()` directly in the
`Outer` body supplies no provider evidence for `i32`; the field's expected result does not select
`Self`, so that call reports `SEM0010`.

For an applied call, the compiler infers implicit `Self` from agreeing supplied operands first. A
zero-operand operation may instead use one enclosing bound whose complete interface application
matches the written application. A bare or applied qualified call is invalid when neither source
identifies exactly one provider. The expected result never supplies provider evidence.

Silk does not add a separate conformance-expression syntax such as
`<Settings as Convert<i32>>.default()`, create a runtime witness dictionary, or turn the selected
operation into a method. Applied qualification is available only for compile-time `interface`
operations; a `service` operation continues to use service requirement semantics.

**Diagnostics:** No applicable interface contract reports a missing-bound or missing-conformance
diagnostic at the operation. More than one reports an ambiguous-interface-application diagnostic
listing the complete provider/application candidates. An unknown operation reports the ordinary
unknown-interface-member diagnostic and does not fall back to a module function with the same name.

**Current compiler:** Aligned for qualified static operation calls. Bound and concrete calls use
the same `Self` substitution and witness selection. Operator eligibility remains the separate
explicit-marker rule defined by OP-009.

**Evidence:** [bound operation resolution](../../../../packages/compiler/src/CallResolution.ts),
[bound witness lowering](../../../../packages/compiler/src/WitnessLowering.ts),
[bound-operation tests](../../../../packages/compiler/test/BoundOperationWitness.test.ts),
[explicit operator eligibility](expressions-and-operators.md#op-009--an-interface-operation-may-opt-into-one-existing-operator-explicitly).

### INTF-007 — A bounded generic receiver calls its bound's operations as methods

**Status:** Confirmed

Inside a generic body, a value whose type is a bounded parameter calls a receiver operation of its
declared bounds as a method: `value.print()` in `fn show<T: Printable>(value: &T)` is the same
bound operation `Printable.print(value)` names, specialized once per instantiation.

```silk
interface Printable { fn print(value: &Self) -> i32 }

struct Document { size: i32 }

impl Printable for Document {
  fn print(value: &Self) -> i32 { return value.size }
}

fn show<T: Printable>(value: &T) -> i32 { return value.print() }

pub fn main() -> i32 {
  let document = Document { size: 42 }
  return show(&document) + document.print() - 42
}
```

The last call is the same operation reached from a concrete receiver: `Document` conforms to exactly
one visible interface supplying `print`, so `document.print()` selects the `Printable` witness for
`Document` and adapts the receiver to the declared `&Self` exactly as the generic body does.

**Boundary:** A generic receiver obtains members only from its declared bounds, so an unbounded `T`
has none. A runtime-concrete receiver instead reaches the receiver operations its conformances
supply: `document.print()` selects the same witness as the qualified call whenever exactly one
interface application supplies `print`. Only an interface the calling module can name participates,
so a dependency's private interface never contributes a member. An operation declaring its own type
parameters is not a member through either spelling.

Interface lookup runs only where the receiver's own type has no member of that name. A callable
field, an accessible inherent method, an inaccessible inherent member, a duplicate declaration, and
a receiver-less associated function all keep their existing outcome, whether that is a resolved call
or a diagnostic; a conformance never rescues a name an inherent declaration already claimed.

**Diagnostics:** An operation declared by more than one bound of the same parameter reports
`SEM0200` naming the bounds; the explicit `Bound.op(value)` form still resolves. An operation
supplied to a concrete receiver by more than one interface reports `SEM0202` naming the receiver and
each supplying application; write one applied qualified call such as `Printed<i32>.print(&report)`
to select it. Arguments never select among supplying applications.

**Evidence:** [bound receiver resolution](../../../../packages/compiler/src/ExpressionAnalysis.ts),
[method-call specification](../../../../openspec/specs/bootstrap-method-calls/spec.md).

## Conformance declarations and implementations

### IMPL-001 — `impl Interface<Arguments> for Provider` binds `Self` to the provider

**Status:** Confirmed

A conformance names one complete interface application and one nominal provider type. Within that
conformance, `Self` is an alias for the provider after applying the `impl`'s generic parameters.

```silk,ignore
interface Decoder<A> {
  fn decode(value: &Self) -> A
}

struct Schema {}

impl Decoder<i32> for Schema {
  fn decode(value: &Self) -> i32 {
    return 42
  }
}
```

The interface arguments contain only `i32`; `Schema` appears once after `for`. The inline operation
may spell its parameter as `&Self` or `&Schema`; both denote the same substituted type in this
conformance.

For a generic provider, the outer nominal declaration still determines the owning module:

```silk,ignore
struct Box<T> { value: T }

impl<T> Display for Box<T> {
  // ...
}
```

**Boundary:** `for` does not add another interface argument, and the provider need not appear in the
interface's explicit arguments. A structural union, reference, anonymous callable contract, or
interface value cannot own a conformance; the provider must have one canonical nominal identity.

**Diagnostics:** A missing, malformed, or non-nominal provider reports an invalid-provider
diagnostic at the `for` type. Wrong interface-argument arity or kind reports the application error
before operation mappings are checked. An invalid `Self` use retains the contextual type diagnostic.

**Current compiler:** Aligned. The provider appears only after `for`, binds `Self`, and may supply
operations inline, by mapping, or through both forms in one conformance.

**Evidence:** [current impl parser](../../../../packages/compiler/src/Parser.ts),
[current conformance facts](../../../../packages/compiler/src/DeclarationFacts.ts).

### IMPL-002 — A conformance supplies every interface operation exactly once

**Status:** Confirmed

Every operation declared by the interface must have one implementation in the conformance. A
conformance may define an inline operation body, map an existing actor function, or mix the two
forms across different operations.

```silk,ignore
interface SchemaInfo {
  fn decode(value: &Self) -> i32
  fn width(value: &Self) -> i32
}

struct Schema {}

fn schemaWidth(value: &Schema) -> i32 {
  return 32
}

impl SchemaInfo for Schema {
  fn decode(value: &Self) -> i32 {
    return 42
  }

  width: Schema.schemaWidth
}
```

An inline operation name matches the interface operation directly. A mapped member's left name is
the interface operation and its right side names one existing actor function. Inline operations are
scoped to the conformance and do not become members of the provider type or module namespace.

**Boundary:** Missing, unknown, or duplicate operation implementations are invalid. A conformance
cannot implement one operation both inline and through a mapping, and member order does not match an
incorrect name by position.

An ordinary empty interface needs no members in its `impl`. Compiler-sealed properties may impose
additional eligibility rules at their own language boundary; those are not customizable interface
operations.

**Diagnostics:** A missing, unknown, or duplicate member reports `SEM0083` at the offending member
when possible and otherwise at the `impl`, naming both interface and operation. An unknown inline
name explains that inline names match contract operations; it may suggest a mapping when a
differently named actor function was likely intended.

**Current compiler:** Aligned. Inline and mapped members populate one ordered witness table and are
subject to the same completeness and duplicate checks.

**Evidence:** [confirmed implementation forms](requirements-and-services.md#serv-001--a-conformance-may-define-or-map-each-operation),
[user witness tests](../../../../packages/compiler/test/UserInterfaceWitness.test.ts),
[conformance parser](../../../../packages/compiler/src/Parser.ts).

### IMPL-003 — Each implementation must satisfy the substituted operation contract

**Status:** Confirmed

After substituting `Self`, interface arguments, and any operation parameters, an implementation must
accept the interface's declared operands and produce a compatible result under the same ordinary or
effectful function kind.

```silk,ignore
interface Decoder {
  fn decode(value: &Self) -> i32
}

struct Schema {}

fn decodeSchema(value: &Schema) -> i32 {
  return 42
}

impl Decoder for Schema {
  decode: Schema.decodeSchema
}
```

The mapped function receives exactly `&Schema` after `Self = Schema` and returns `i32`. Value,
shared-borrow, and exclusive-borrow operand modes are literal; conformance checking does not
blanket-adapt owned values into borrows or add an extra reference around `Self`.

An effect implementation may declare smaller failure and requirement upper bounds than the
interface promises. Calling through the interface still exposes the interface's declared contract,
so generic code does not change type according to which witness is later selected.

```silk,ignore
interface Load<E, ?R> {
  effect fn load(source: &Self) -> i32 ! E ? R
}

// A closed effect implementation may satisfy a wider applied Load contract.
effect fn loadMemory(source: &MemorySource) -> i32 {
  return 42
}
```

**Boundary:** Ordinary and effect functions are different construction contracts. An ordinary eager
function does not directly implement an `effect fn` operation through implicit lifting, and an
effect function does not implement an ordinary operation through implicit execution. An explicit
inline adapter may construct the intended Effect when that behavior is desired.

An implementation cannot demand exclusive access where the interface promises only shared access,
consume a borrowed operand, return `Effect<A>` where the operation promises success `A`, add a
failure outside the applied failure type, or add a requirement outside the applied requirement row.

**Diagnostics:** An incompatible implementation reports `SEM0083` at the inline signature or mapped
target. The diagnostic identifies the interface operation and the first incompatible function kind,
operand mode/type, result type, failure type, or requirement. Nested Effect mismatches use the
ordinary type names and never fall through to lowering as invalid MIR.

**Current compiler:** Aligned. Substituted inline and mapped operations retain literal operand,
result, failure, and requirement contracts for both interfaces and services.

**Evidence:** [complete witness compatibility](../../../../openspec/specs/bootstrap-complete-interface-contracts/spec.md),
[witness compatibility implementation](../../../../packages/compiler/src/DeclarationResolution.ts),
[interface witness tests](../../../../packages/compiler/test/InterfaceWitnessCompatibility.test.ts),
[nested Effect contract](effects-and-execution.md#eff-004--nested-effects-are-ordinary-values).

### IMPL-004 — An interface or its nominal provider may own a conformance

**Status:** Confirmed

An interface implementation for a nominal provider may appear either in the interface's defining
module or in the module that defines the provider's outer nominal type. The two declarations must
be visible to the implementing module. A service implementation remains provider-owned.

```silk,ignore
// model/User.silk
import validation.Validatable

pub struct User {}

impl Validatable for User {
  // ...
}
```

For `Wrapper<T>`, the provider's defining module is the module that declares `Wrapper`, independent
of `T`.
The module that declares the interface may also implement it for `Wrapper<T>`, including with
conditional bounds on `T`. Both locations contribute to the same program-wide coherence check,
which rejects competing implementations.

```silk,ignore
// validation/Validatable.silk
import model.User

pub interface Validatable { /* ... */ }
impl Validatable for User { /* ... */ }
```

Scalar and borrowed `string` providers have no nominal declaration module, so only the contract's
module may implement an interface for them. The same interface module may also implement that
interface for an imported owned `String` nominal.

Third parties may define ordinary actor functions for any public type. To create a conformance
between a foreign interface and foreign type, they define an owned nominal adapter and implement the
interface for that adapter.

**Boundary:** A module that owns neither the interface nor the nominal provider cannot declare
their implementation. Imports never activate a conformance, and an `impl` in a neighboring directory
or package gains no ownership. Service and compiler-sealed intrinsic rules do not broaden.

This locality rule does not require implementations to live inside either declaration. They remain
top-level `impl` declarations, preserving data-only nominal types.

**Diagnostics:** An unrelated module's `impl` reports `SEM0083` at the conformance and identifies
the permitted module or modules. Tooling may suggest an owned adapter; it must not offer to move the
conformance into a module the author cannot modify.

**Current compiler:** Aligned for source-declared contracts. Interface-owned and provider-owned
nominal implementations share one coherence check; compiler-sealed intrinsic contracts retain their
own explicitly privileged rules.

**Evidence:** [member and conformance style](style-guide.md#style-002--operations-intrinsic-to-one-type-are-inherent-members-with-the-receiver-first).

### IMPL-005 — Conformances have no independent import or visibility modifier

**Status:** Confirmed

A valid conformance is available wherever both its provider type and interface application are
semantically available. Source imports the declarations it names; it does not separately import or
activate an `impl`.

```silk,ignore
// model/User.silk
import validation.Validatable

pub struct User {}
impl Validatable for User {}
```

Another module that imports public `User` and `Validatable` may rely on this conformance. The
conformance needs no `pub` marker because its visibility is bounded by the visibility of both
endpoints. A private provider or private interface already prevents an external module from naming
the corresponding goal.

**Boundary:** `pub impl`, selective conformance imports, wildcard conformance imports, and private
witness activation are not part of the first stable model. A caller cannot replace or hide a
canonical conformance through import order or aliasing.

**Diagnostics:** A visibility failure reports the inaccessible provider or interface declaration,
not an independently private `impl`. Unsupported `pub impl` syntax receives the parser diagnostic
for a modifier that has no conformance meaning.

**Current artifacts:** The earlier module direction described public and private conformances. That
dimension is superseded: program-wide coherence and endpoint visibility already determine every
usable goal, and current source syntax needs no general conformance visibility modifier.

**Evidence:** [current impl parser](../../../../packages/compiler/src/Parser.ts),
[non-activating imports](modules-names-and-visibility.md#module-005--imports-have-no-runtime-behavior).

### IMPL-006 — A generic `impl` may require conformances of contained parameters

**Status:** Confirmed

An `impl` may bind generic parameters with the same interface-bound syntax as a generic function.
The conformance exists for a concrete provider only when every applied bound can be proven.

```silk,ignore
struct Box<T> {
  value: T
}

impl<T: Display> Display for Box<T> {
  fn display(value: &Self) -> string {
    return Box.display(value)
  }
}
```

`Box<User>` therefore conforms to `Display` exactly when `User` conforms to `Display`. Nested
providers prove recursively: `Box<Box<User>>` first requires `Box<User>: Display`, which then
requires `User: Display`.

Multiple requirements use the ordinary bound conjunction:

```silk,ignore
impl<T: Hashable + Display> Inspectable for Box<T> {
  // ...
}
```

An inline body or mapped generic actor function is checked once under those declared bounds. It
does not gain operations from concrete types that happen to satisfy the `impl` later.

A conformance head may end in a `where` clause of provider and membership constraints over its
binders, written as on a function signature:

```silk,ignore
impl<'provider, P> HttpTransport for Plain<'provider, P>
where &mut P provides &ByteDuplex from &mut ByteDuplex {
  readSomeRaw: Plain.read
  // ...
}
```

Each clause is a premise of every inline member. A witness may require only the `where`
constraints that the head or the implemented operation states, as with its interface bounds, so a
mapped `Plain.read` that needs `&mut P provides &ByteDuplex from &mut ByteDuplex` is admitted only
under a head that states it. The constraints are discharged where a concrete provider instantiates
the witness.

**Boundary:** Every `impl` parameter must be determined by the interface application or provider
head, and every bounded provider parameter must occur structurally inside the conformance provider.
A parameter introduced only by a bound would create indistinguishable witnesses and is invalid.
An inherent head takes neither bounds nor a `where` clause, and no head bounds arbitrary
constructed types.

**Diagnostics:** An undetermined parameter reports an unconstrained-impl-parameter diagnostic at
its declaration. A witness `where` constraint the head and operation do not state reports `SEM0083`
at the mapping, and a `where` clause on an inherent head reports `SEM0194`. A bound whose provider does not occur inside the conformance provider reports the
non-descending requirement described by IMPL-008. Invalid operations inside the body retain their
ordinary missing-bound or contract diagnostics.

**Current compiler:** Aligned. Bounded `impl<...>` declarations use implicit `Self`, preserve all
bound conjuncts, and delay concrete admission until every requirement is proven.

**Evidence:** [conditional conformance specification](../../../../openspec/specs/bootstrap-conditional-interface-conformance/spec.md),
[conditional conformance fixtures](../../../../packages/compiler/test/ConditionalConformanceFixtures.test.ts).

### IMPL-007 — Potentially overlapping conformance heads are rejected

**Status:** Confirmed

For every complete provider/interface goal, at most one conformance declaration may ever apply.
Two declarations overlap when some substitution of their parameters could make both provider and
interface applications equal.

```silk,ignore
impl<T: Display> Display for Box<T> { /* ... */ }

// Invalid: both declarations apply to Box<i32> when i32: Display.
impl Display for Box<i32> { /* ... */ }
```

Bounds do not make otherwise overlapping heads distinct:

```silk,ignore
impl<T: Left> Marker for Box<T> {}
impl<T: Right> Marker for Box<T> {} // invalid: one T may satisfy both
```

The compiler checks overlap from the provider and interface applications alone. This keeps
coherence stable when another module later adds a conformance that makes two previously exclusive-
looking bounds simultaneously true.

Different complete interface applications remain distinct when they cannot unify:

```silk,ignore
impl Convert<i32> for Settings { /* ... */ }
impl Convert<string> for Settings { /* ... */ }
```

**Boundary:** Silk does not rank a concrete `impl` above a generic one, rank stronger bounds above
weaker bounds, select by source or import order, or support negative bounds. An optimized special
case that overlaps a broad generic conformance must remain an ordinary actor function until a
separate explicit-specialization model is designed.

**Diagnostics:** A duplicate head reports a duplicate-conformance diagnostic. A distinct but
potentially unifiable head reports an overlapping-conformance diagnostic at the later declaration
with the earlier declaration as a related span. The diagnostic shows the common goal shape; it
does not claim that one bound should win.

**Current compiler:** Aligned. It alpha-normalizes generic heads and conservatively rejects heads
whose provider and interface applications may unify without consulting their bounds.

**Evidence:** [coherence requirement](../../../../openspec/specs/bootstrap-conditional-interface-conformance/spec.md),
[overlap implementation](../../../../packages/compiler/src/ConformanceHead.ts),
[overlap rejection tests](../../../../packages/compiler/test/ConditionalConformanceRejection.test.ts).

### IMPL-008 — Conditional proof must descend through provider structure

**Status:** Confirmed

Every required conformance in a conditional `impl` must apply to a strict structural part of the
provider being implemented. Each proof step therefore makes the provider term smaller until it
reaches a concrete base conformance.

```silk,ignore
// Valid: T is structurally contained by Box<T>.
impl<T: Display> Display for Box<T> { /* ... */ }
```

The compiler proves termination from the declaration itself. It does not use a recursion-depth
limit, solver fuel, source order, or the set of currently reachable concrete calls.

**Boundary:** A conditional conformance cannot require the same provider, a peer unrelated to the
provider's structure, or a larger provider. It also cannot multiply an open parameter while proof
descends or repeatedly rewrite a fixed interface argument to create an infinite chain. Those forms
are rejected even when no current program happens to trigger the cycle.

This restriction intentionally excludes conformances conditioned only on a result or target type
that is not structurally contained in the provider. An ordinary generic actor function can express
that relationship without installing a global conformance fact.

**Diagnostics:** A non-descending declaration reports a conditional-conformance-termination
diagnostic at the offending bound. It names the required provider and conformance provider and
explains whether the step stayed equal, moved to an unrelated peer, grew, duplicated an open
parameter, or changed a fixed interface argument.

**Current compiler:** Aligned. Structural termination is checked against the implicit provider and
retains the strict descent and occurrence invariants.

**Evidence:** [structural termination requirement](../../../../openspec/specs/bootstrap-conditional-interface-conformance/spec.md),
[termination proof](../../../../packages/compiler/src/ConformanceHead.ts),
[termination tests](../../../../packages/compiler/test/ConformanceHead.test.ts).

### IMPL-009 — Concrete proof is complete, static, and order-independent

**Status:** Confirmed

At each reachable concrete interface goal, the compiler proves every conditional requirement
before admitting the conformance. The selected operations then become ordinary static call targets
in the concrete specialization; no witness dictionary or proof search remains at runtime.

```text
Box<Box<User>>: Display
  requires Box<User>: Display
    requires User: Display
```

Every branch of that chain must resolve to one coherent conformance. Normalized bound order,
declaration order, module loading order, and compilation target do not change the
proof or selected implementation.

**Boundary:** A missing, invalid, ambiguous, or unavailable requirement never creates a provisional
witness. Proof does not run Effects, borrow or move values, resolve service dependencies, or execute
operation bodies. A semantic proof failure must not reach MIR or a backend as an internal error.

**Diagnostics:** Failure at a concrete use reports the complete finite requirement chain from the
requested goal to the first missing, invalid, or ambiguous base goal. Declaration-time overlap and
termination failures retain their earlier source locations instead of being rediscovered as a
generic call failure.

**Current compiler:** Aligned. Conditional proof chains and concrete witness identities use the
same provider/interface goal for interfaces and services, with deterministic static selection.

**Evidence:** [concrete proof requirement](../../../../openspec/specs/bootstrap-conditional-interface-conformance/spec.md),
[conditional proof order independence](../../../../packages/compiler/test/ConditionalConformance.test.ts),
[finite specialization](#gen-005--every-reachable-generic-application-becomes-finite-monomorphic-code).

## Interface operation selection

Implicit `Self` removes provider duplication from declarations, bounds, and `impl` blocks. One
complete static application must still be identifiable at every qualified operation call. Operands
or the current generic bounds normally provide that information.

```silk,ignore
interface Convert<To> {
  fn default() -> To
}

impl Convert<i32> for Settings { /* ... */ }
impl Convert<string> for Settings { /* ... */ }
```

`Convert.default()` alone cannot choose between the two applications, and its expected result must
not decide. A call with a value operand can select both parts explicitly as
`Convert<i32>.convert(&settings)`. A zero-operand call such as `Convert<i32>.default()` additionally
needs one matching enclosing bound to establish `Self`. Interface selection introduces no separate
conformance-expression syntax, runtime dispatch, or expected-result inference.

## Confirmed cross-area constraints

The later interface rules must preserve decisions already confirmed elsewhere:

- A conformance may define an inline operation or map an existing actor function, and may mix both
  forms. See [SERV-001](requirements-and-services.md#serv-001--a-conformance-may-define-or-map-each-operation).
- A service is an interface with dependency eligibility and no other distinct conformance behavior.
  See [SERV-003](requirements-and-services.md#serv-003--a-service-is-a-dependency-eligible-interface).
- An interface conformance for a nominal provider belongs to the interface's module or the
  provider's module; a service conformance belongs to the provider's module; a scalar or `string`
  provider's conformance belongs to the interface's module. See
  [IMPL-004](#impl-004--an-interface-or-its-nominal-provider-may-own-a-conformance).
- Interface operation operands retain their declared move or borrow modes. They do not receive
  blanket reference adaptation.
- Effectful operations preserve ordinary failure types, requirement rows, and explicit Effect
  nesting.
- Operator syntax may select only an explicitly operator-eligible interface operation. Operation
  names alone have no operator meaning. See
  [OP-009](expressions-and-operators.md#op-009--an-interface-operation-may-opt-into-one-existing-operator-explicitly).
- Interfaces are not storable existential values and do not introduce runtime dispatch in the first
  stable model.

## Whole-language consequences

Static conformance selection is one compile-time mechanism shared by several language areas. It
does not give any one of those areas a second interface model.

| Area                       | Rule                                                                                                                                                                                                                                                                                                |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Services                   | A service first passes the declaration-level eligibility check that permits it in a requirement row. Bounds, `impl`, overlap, conditional proof, and operation selection then use the ordinary interface rules. Proving `T: Logger` does not request, provide, or run a logger.                     |
| Effects                    | Selecting an effectful operation constructs the one Effect layer declared by its contract. Proof does not execute, flatten, handle failures, satisfy requirements, or change a reusable Effect into a consuming one.                                                                                |
| Ownership                  | A proof is compile-time evidence and does not move, borrow, copy, or drop a value. The selected operation still applies its declared owned, shared, or exclusive operands literally.                                                                                                                |
| Operators                  | Operator syntax may invoke only an operation explicitly marked for that operator. Bounds and conformances select its static implementation; operation names and provider types receive no hidden numeric privilege.                                                                                 |
| Modules                    | A nominal interface conformance belongs in the interface's or provider's defining module; service implementations remain provider-owned. Imports make declarations nameable but never activate, replace, prioritize, or hide an `impl`; endpoint visibility determines whether a goal can be named. |
| Specialization and targets | Every admitted concrete proof selects the same static operation target before LLVM lowering. No target performs interface lookup, receives a witness dictionary, or chooses a different conformance.                                                                                                |
| Static values              | A generic helper such as `Schema.of<User>()` may select `User: SchemaOf` statically, but that fact alone does not execute the call at compile time. Const evaluation and global static composition are not defined by these rules.                                                                  |

Consequently, an interface or service declaration can be reused in an ordinary generic bound
without creating an ambient dependency, and a conditional conformance can reuse effectful
operation contracts without running Effects during proof. Diagnostics stay with the owning phase:
conformance failures during semantic analysis, ownership violations at the operation use, unhandled
Effect channels at the execution boundary, and backend parity failures only after valid static
selection.

## Reconciliation ledger

| Area                    | Current behavior or artifact                                                                                 | Stabilization direction                                                                                                                      |
| ----------------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------- |
| Failure parameters      | Generic OpenSpec and compiler use separate `!E` failure-row binders.                                         | Use ordinary type parameter `E`; only `?R` remains a special Effect-channel kind.                                                            |
| Explicit call arguments | Older type-system decision requires all arguments or none; current compiler accepts an ordered prefix.       | Keep the current ordered-prefix model for calls and struct literals; the older rule is superseded.                                           |
| Provider application    | `Decoder<Schema> for Schema` repeats the provider while `T: Decoder` hides an application.                   | Give every interface implicit `Self`; write only additional interface arguments and bind the provider after `for` or to the left of a bound. |
| Generic operator calls  | Current tests and call resolution infer bound operations from names such as `add`.                           | Use [OP-009](expressions-and-operators.md#op-009--an-interface-operation-may-opt-into-one-existing-operator-explicitly).                     |
| Service conformance     | A service first passes dependency eligibility, then uses ordinary conformance proof and operation selection. | Keep only dependency eligibility special; do not introduce service-only witness behavior.                                                    |
| Inline implementations  | General `impl` parsing accepts mappings; a narrow hook form accepts one inline function.                     | Implement the already confirmed general inline-or-mapped rule.                                                                               |

IMPL-005 resolves the former conformance-visibility question: conformances have no independently
written visibility surface. Endpoint visibility and program-wide coherence determine whether a
goal is usable.
