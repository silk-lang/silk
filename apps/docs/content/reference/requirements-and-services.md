# Requirements and services

An Effect requirement names a capability that must be available when the Effect runs. A service
declares a runtime-provided capability, and a provider supplies its operations. This page defines
those concepts and the requirement-row rules that connect them.

A service is an interface contract carrying permission to be used as an Effect dependency. The
compiler checks that permission when a dependency key is formed. After that boundary, the service
reuses Silk's ordinary interface, conformance, function, value, generic, specialization, and
ownership rules. Provider selection and requirement removal belong to Effect dependency machinery;
they do not create a second kind of contract behavior.

Interfaces appear here only where their conformance syntax overlaps with services. An interface is
a compile-time contract for operations on an explicitly supplied value; it does not create an
Effect requirement or a runtime provider slot.

## Terminology

- A **conformance** is an `impl` declaration proving that a provider or value type implements a
  service or interface contract.
- An **inline operation implementation** defines an operation body inside its conformance.
- A **mapped operation implementation** assigns an existing actor function to an operation in its
  conformance.
- A **requirement key** identifies one service capability that must be supplied before an Effect can
  run at a closed boundary.
- A **requirement selector** names one key as `Service` or `Service at Role`, without repeating its
  shared or exclusive access.
- A **provider** is a value whose type conforms to a service and whose operations satisfy that
  service at runtime.

Standard-library constructors intentionally presented as explicit provider helpers use the
`Provider` suffix, such as `systemAllocatorProvider`. Other constructors may
return conforming implementation values under ordinary actor names such as `make` or `seeded`. The
service remains the capability contract; a constructor named as a provider neither creates a new
requirement key nor changes conformance selection.

## SERV-001 — A conformance may define or map each operation

**Status:** Confirmed

Each interface or service operation may be implemented in either of two forms. An inline
implementation defines the operation directly inside the `impl` declaration:

```silk
interface Decoder {
  fn decode(value: &Self) -> i32
}

struct Schema {}

impl Decoder for Schema {
  fn decode(value: &Self) -> i32 {
    return 42
  }
}
```

The inline operation name must match the contract operation it implements. Its body is scoped to
this conformance: the example supplies `Decoder.decode` for `Schema`, but it does not declare a
separate inherent operation named `Schema.decode`.

The preferred public-API form defines behavior as an ordinary actor function and maps the contract
operation to that function explicitly:

```silk
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

One conformance may mix the two forms:

```silk
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

Inline and mapped implementations satisfy the same operation contract after substituting the
conformance's type arguments. Neither form changes whether the contract is an interface or a
service, and neither creates a second operation in the provider type's namespace.

The choice between the forms does not affect validity, but it does affect API shape. Mapping keeps
the `impl` focused on conformance, leaves the operation directly callable without a contract, and
lets the actor function compose with ordinary higher-order functions and pipelines. An inline body
is useful when the implementation exists only to satisfy that conformance and has no independent
API value. Public libraries should follow the
[receiver-first member convention](style-guide.md#style-002--operations-intrinsic-to-one-type-are-inherent-members-with-the-receiver-first)
instead of accumulating their public behavior inside conformance bodies.

**Boundary:** Every declared contract operation must have exactly one implementation. A member is
invalid when its name is absent from the contract, when the same operation is supplied both inline
and by mapping, or when its callable contract is incompatible with the declared operation.

An inline function with a different name is not matched by position or inferred intent:

```silk,ignore
impl Decoder for Schema {
  fn decodeSchema(value: &Schema) -> i32 {
    return 42
  }
}
```

It must instead be named `decode`, or be declared as an actor function and connected with
`decode: Schema.decodeSchema`.

**Diagnostics:** A missing, unknown, duplicate, or incompatible operation reports `SEM0083` at the
offending conformance member when one exists, otherwise at the `impl` declaration. The diagnostic
must name both the contract and operation. For an unknown inline name, it must explain that inline
names match contract operations and suggest an explicit mapping when a differently named actor
function was intended.

**Current compiler:** Aligned. General conformances accept inline bodies, mapped actor functions,
and mixtures of both forms. Completeness and compatibility are checked through one ordered witness
table for interfaces and services.

**Evidence:** [earlier service mapping requirement](../../../../openspec/specs/bootstrap-service-declarations/spec.md),
[interface witness specification](../../../../openspec/specs/bootstrap-complete-interface-contracts/spec.md),
[current parser](../../../../packages/compiler/src/Parser.ts),
[current conformance facts](../../../../packages/compiler/src/DeclarationFacts.ts).

## SERV-002 — Only services may be Effect requirements

**Status:** Confirmed

Every entry in an Effect's requirement row must name a nominal type declared with `service`.
Ordinary structs, unions, scalars, interfaces, and other value types cannot become ambient
requirements merely by appearing after `?`.

```silk
service Clock {}

effect fn timestamp() -> i64 ? &Clock {
  return 0
}
```

`Clock` is the capability required by `timestamp`. A concrete provider is a normal value whose type
conforms to that service:

```silk
struct SystemClock {}

impl Clock for SystemClock {}
```

The requirement is keyed by `Clock`, not by `SystemClock`. Different conforming provider types may
satisfy the same requirement without changing the Effect contract.

**Boundary:** Ordinary data is passed explicitly rather than injected through a requirement row:

```silk,ignore
struct Configuration { port: i32 }

effect fn start() -> () ? &Configuration {
}
```

This is invalid because `Configuration` is a struct, not a service. A function that needs this value
directly accepts `configuration: &Configuration`. A library may later offer a generic service that
wraps ordinary values for dependency-injection patterns, but that wrapper remains an ordinary
declared service and does not make arbitrary value types valid requirement keys.

Interfaces remain compile-time operation contracts. Implementing an interface does not create a
runtime provider slot or make the interface valid in a requirement row.

**Diagnostics:** A non-service requirement reports `SEM0070` at the invalid row entry. The
diagnostic must identify the named type and state that Effect requirements must be declared
services. When the named type is an ordinary value type, tooling may suggest passing it explicitly;
it must not silently synthesize a service declaration or wrapper.

**Current compiler:** Aligned. Requirement construction admits service declarations and generic
requirement parameters, while concrete structs and ordinary interfaces receive `SEM0070`.

**Evidence:** [service declaration specification](../../../../openspec/specs/bootstrap-service-declarations/spec.md),
[requirement validation](../../../../packages/compiler/src/DeclarationResolution.ts).

## SERV-003 — A service is a dependency-eligible interface

**Status:** Confirmed

Apart from dependency eligibility, a declaration written with `service` has exactly the semantics
of an `interface`. It uses the same operation contracts, generic constraints, conformance rules,
inline and mapped implementations, witness compatibility, visibility, specialization, and
ownership checking.

A service may therefore be used as an ordinary static constraint:

```silk
service Clock {}

struct SystemClock {}

impl Clock for SystemClock {}

fn acceptsClock<T: Clock>(provider: &T) -> i32 {
  return 1
}
```

The `service` keyword adds one permission: `Clock` may also be used as a requirement key under
SERV-002. An ordinary `interface` lacks that permission. The distinction is checked when forming a
requirement entry or selecting a dependency for provision, not repeatedly throughout interface
analysis.

Once a provider and its conformance witness have been selected, invoking an operation uses ordinary
interface operation and witness semantics. Ambient dependency syntax may obtain the provider
operand from the Effect environment, but it must not change the underlying operation contract or
admit a mapping that the equivalent ordinary interface would reject.

**Boundary:** No feature may branch on `service` merely to give its operations different variance,
failure or requirement subsumption, receiver adaptation, generic inference, dispatch behavior, or
implementation syntax. A feature needing one of those behaviors must define it for interfaces in
general or justify a dependency-boundary operation that leaves the interface contract unchanged.

This rule does not permit an ordinary interface in a requirement row. Dependency eligibility is the
single declaration-level distinction and remains explicit rather than inferred from how a contract
is used.

**Diagnostics:** Using a service as a generic constraint or implementing it produces the same
diagnostics as the equivalent interface operation. A service-specific diagnostic applies only when
dependency eligibility itself is relevant. The compiler must not report an “unknown interface” or
parallel service-conformance diagnostic merely because a service appears in an ordinary interface
position.

**Current compiler:** Aligned. Services and interfaces share contract, conformance, bound,
specialization, and static-call machinery. The service eligibility bit is consulted only where an
Effect dependency key is formed.

**Evidence:** [earlier service/interface distinction](../../../../openspec/specs/bootstrap-service-declarations/spec.md),
[interface contract specification](../../../../openspec/specs/bootstrap-complete-interface-contracts/spec.md),
[current conformance facts](../../../../packages/compiler/src/DeclarationFacts.ts),
[current conformance proof](../../../../packages/compiler/src/ConformanceProof.ts).

## SERV-004 — A requirement key is a service and nominal role

**Status:** Confirmed

Each requirement-row entry is keyed by the canonical identity of a service declaration and a
nominal role declaration. Access is retained as the strength required for that key; it is not a
second key component.

Most dependencies use the implicit default role and require no role syntax:

```silk
effect fn currentTime() -> i64 ? &Clock {
  return 0
}
```

When one Effect needs the same service in distinct positions, it declares nominal roles and uses
`at` to select them:

```silk
role Primary
role Replica

effect fn compareTimes() -> i64
  ? &Clock at Primary | &Clock at Replica {
  return 0
}
```

Omitting `at Role` selects the compiler-defined `DefaultRole`. A role is a compile-time nominal
identity, not a string, runtime lookup key, provider name, or lexical variable. Two declarations
with the same spelling in different modules are different roles; importing or aliasing one
declaration preserves its identity.

A requirement row is unordered and duplicate-free after normalization. Combining entries with the
same service-role key retains the strongest required access:

```silk
&Clock | &mut Clock
// normalizes to:
&mut Clock
```

Entries with different service or role identities remain separate regardless of their access:

```silk
&Clock at Primary | &mut Clock at Replica | &Logger at Primary
```

Source order, union nesting, repeated aliases, and repeated identical entries do not affect the
normalized row's identity.

**Boundary:** The `at` suffix must name a visible `role` declaration. An ordinary type, value,
string, undeclared identifier, or service cannot be used as a role. Roles distinguish dependency
positions only; declaring a role does not create a provider, implement a service, or add a
requirement by itself.

Using distinct roles solely to evade an otherwise incompatible borrow does not relax ordinary
ownership. The same provider may satisfy multiple roles only when its actual captures and borrows
permit that use.

**Diagnostics:** An invalid role or malformed requirement entry reports `SEM0070` at that entry and
identifies the expected service and nominal-role structure. Repeating or reordering a valid entry
is normalization, not an error. Tooling may offer to remove redundant entries or show their
normalized form.

**Current compiler:** Aligned. Requirement entries use nominal service-role identity, the implicit
`DefaultRole`, strongest-access union normalization, and `at` spelling. The superseded `@` role
spelling is not accepted as a compatibility alias.

**Evidence:** [current requirement representation](../../../../packages/compiler/src/Type.ts),
[current row resolution](../../../../packages/compiler/src/DeclarationResolution.ts),
[current generic-row specification](../../../../openspec/specs/bootstrap-type-generics/spec.md).

## SERV-005 — Generic requirement rows preserve normalized entries

**Status:** Confirmed

A `?R` generic parameter ranges over one complete normalized requirement row. Passing an Effect
through a row-polymorphic function preserves every service, nominal role, and required access in
that row:

```silk
fn preserve<'env, A, ?R>(
  pending: once Effect<'env; A ? R>
) -> Effect<'env; A ? R> {
  return move pending
}
```

Passing `Effect<i32 ? &Clock at Primary | &Logger>` to `preserve` produces that same concrete
contract. The role does not revert to the default, and normalization does not depend on the generic
function's source order or spelling.

`R` is unknown only while the generic declaration is checked. Each concrete specialization derives
one finite row from call arguments before runtime; no runtime service-row dictionary, reflection,
iteration, or unknown dependency set is introduced.

**Boundary:** `R` may appear only in requirement-row positions and operations explicitly defined
for requirement rows. It is not an ordinary value type, runtime record, structural object, or
iterable collection. A generic function cannot silently discard an entry, weaken required access,
replace a role, or add a dependency absent from its declared result contract.

**Diagnostics:** Using `R` outside a requirement-row position reports `SEM0088`. A call that cannot
infer one finite unambiguous row reports `SEM0089` and identifies the conflicting or missing row
evidence. Preserving a valid row produces no diagnostic even when its concrete services are unknown
while the generic body is checked.

**Current compiler:** Aligned. Generic requirement-row binders preserve finite normalized rows,
including nominal roles and access, and concrete specializations and diagnostics use `at` spelling.

**Evidence:** [generic Effect-contract rule](effect-contracts.md#eff-012--ordinary-failure-types-and-generic-requirement-rows-preserve-a-contract),
[current row inference](../../../../packages/compiler/src/internal/TypeInference.ts),
[generic-row tests](../../../../packages/compiler/test/TypeGenerics.test.ts).

## SERV-006 — Requirement access and provider ownership are separate

**Status:** Confirmed

A requirement entry records only how execution needs to borrow its provider:

| Entry        | Required provider access |
| ------------ | ------------------------ |
| `&Clock`     | shared                   |
| `&mut Clock` | exclusive                |

There is no owned or consuming requirement-entry form. Ownership belongs to the operation that
provides a concrete value to an Effect, not to the Effect's unresolved requirement row.

The same shared requirement may be satisfied by a shared borrow, an exclusive borrow, or an owned
provider because each can expose shared access. An exclusive requirement needs an exclusive borrow
or an owned provider capable of exposing exclusive access; a shared borrow cannot satisfy it.

```silk
effect fn observe() -> i64 ? &Clock {
  return 0
}

effect fn advance() -> i64 ? &mut Clock {
  return 0
}
```

Whether provision borrows a provider or moves it into the resulting Effect changes capture,
lifetime, cleanup, and reuse behavior. It does not rewrite `&Clock` into an owned requirement or add
a third access strength to the row.

**Boundary:** An ambient service operation cannot consume its provider. An operation that must
consume a value receives that value as an explicit owned argument. A stateful provider may instead
update owned state through an exclusive `&mut Service` requirement while the provider itself
remains available for the rest of the Effect execution.

A source form such as `? Clock`, `? move Clock`, or an owned provider type in place of a borrowed
service requirement is invalid. It cannot be used to encode one-shot execution or provider
lifetime.

**Diagnostics:** An owned or otherwise malformed requirement entry reports `SEM0070` at that entry
and explains that requirements permit only shared or exclusive service access. Providing only
shared access for an exclusive requirement reports a provider-access mismatch at the provision
call. The diagnostic must distinguish insufficient access from missing service conformance.

**Current compiler:** Aligned. Requirement rows store shared or exclusive access independently from
provider binding, while provision separately supports shared, exclusive, and owned capture.

**Evidence:** [provider-binding intrinsics](../../../../packages/compiler/src/Intrinsic.ts),
[provider-selection rules](../../../../packages/compiler/src/ProviderSelection.ts),
[ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

## SERV-007 — Provision infers exactly one compatible requirement key

**Status:** Confirmed

A provision operation compares its provider type and capture access with the target Effect's
normalized requirement row. When exactly one service-role key is compatible, that key is inferred:

```silk
// The Effect has one &Clock requirement and SystemClock conforms to Clock.
let specialized = Effect.provide(target, &systemClock)
```

Compatibility requires both an ordinary interface conformance from the provider type to the
service and enough provider access for the stored requirement. Shared capture can satisfy only a
shared requirement; exclusive or owned capture can satisfy shared or exclusive requirements.

When zero keys match, provision is invalid. When more than one key matches, the caller selects the
intended service-role key explicitly:

```silk
effect fn compareTimes() -> i64
  ? &Clock at Primary | &Clock at Replica {
  return 0
}

let specialized = Effect.provide<Clock at Primary>(compareTimes(), &primaryClock)
```

The selector is `Service` for the default role or `Service at Role` for a non-default role. It does
not include `&` or `&mut`: access is a property of the selected row entry and is checked against the
provider argument independently.

Selection considers the complete candidate set. Source order, normalized row order, conformance
discovery order, import order, and provider declaration order never choose a winner.

**Boundary:** An explicit selector must name exactly one service-role key present in the input row,
the provider must conform to that service, and the capture must offer sufficient access. A provider
that conforms to multiple required services, or one service repeated under multiple roles, is
ambiguous without a selector.

A selector resolves row-key ambiguity only. It does not resolve multiple competing conformance
witnesses for the same provider and service; conformance coherence must still produce one witness.

**Diagnostics:** A missing row key or missing service conformance reports `SEM0123` at the provision
call. A selected key whose provider capture has insufficient access reports `SEM0131`, after key
and conformance selection. Multiple compatible keys report `SEM0125` and list every service-role
candidate using `at` spelling. Ambiguous conformance evidence for the selected key reports
`SEM0127` and identifies the competing witnesses.

**Current compiler:** Aligned. Inferred and explicit selection operate on access-independent
service-role keys; provider access is checked afterward. Selectors use `Clock` or
`Clock at Primary`, and access-bearing selectors and the superseded `@` spelling are rejected.

**Evidence:** [provider-selection implementation](../../../../packages/compiler/src/ProviderSelection.ts),
[provider-selection diagnostics](../../../../packages/compiler/src/Diagnostic.ts),
[provider-selection tests](../../../../packages/compiler/test/ProviderSelection.test.ts),
[flow-function provision specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md).

## SERV-008 — Requirement subtraction removes service-role keys

**Status:** Confirmed

`Without<R, K>` removes the selected service-role key `K` from normalized requirement row `R`.
Access does not participate in key matching:

```silk
Without<
  &mut Clock at Primary | &Logger,
  Clock at Primary
>
// resolves to:
&Logger
```

Removing a key removes its complete normalized entry whether its retained access is shared or
exclusive. Removing a key absent from the row leaves the row unchanged.

Successful provision of key `K` from `Effect<A ! E ? R>` therefore produces
`Effect<A ! E ? Without<R, K>>`. Provider access is validated before subtraction; the result row
does not retain a weaker shadow entry for the same key.

**Boundary:** The second operand names service-role keys, not requirement entries. It uses `Clock`
or `Clock at Primary`, never `&Clock`, `&mut Clock`, or `&Clock at Primary`. A selector does not
claim that a provider exists or that its access is sufficient.

Requirement subtraction changes only the static dependency contract. It does not execute an
Effect, release a provider, mutate an environment, or perform runtime set operations.

**Diagnostics:** A malformed selector or one naming a non-service reports the requirement-selector
diagnostic at the second operand. An absent but otherwise valid key is not an error for `Without`
itself. Provision remains stricter under SERV-007 and reports `SEM0123` rather than silently
providing nothing when its selected key is absent.

**Current compiler:** Aligned. `Without` compares access-independent service-role keys, removes the
complete normalized entry regardless of its retained access, and uses `at` for non-default roles.

**Evidence:** [current generic-row specification](../../../../openspec/specs/bootstrap-type-generics/spec.md),
[current type-level subtraction](../../../../packages/compiler/src/Type.ts),
[current provider wrappers](../../../../packages/compiler/src/Stdlib.generated.ts).

## SERV-009 — Provision is lazy, lexical, and applies to one Effect layer

**Status:** Confirmed

Provision constructs a new lazy Effect that captures a provider for one selected service-role key.
It does not execute the target Effect, initialize a global registry, or change the provider visible
to unrelated Effects.

Provider lifetime follows the capture used to construct the specialized Effect:

- a shared provider borrow remains live until the specialized Effect is consumed or dropped;
- an exclusive borrow prevents conflicting access for that same lifetime and preserves mutations
  in the original provider value; and
- a moved provider is owned and eventually cleaned up by the specialized Effect under ordinary
  ownership rules.

The current standard library exposes those modes explicitly: `Effect.provide` (or
`bindRequirement`) stores a shared borrow, `Effect.provideMut` (or `bindRequirementMut`) stores an
exclusive borrow, and `Effect.bindRequirementOwned` stores an owned provider.

During execution, the captured provider overrides an outer provider for the selected key. Once that
execution finishes, the outer provider is visible again. This is lexical replacement attached to
the Effect value, not mutation of process-wide dependency state.

Provision removes a requirement from only the Effect layer it wraps. It does not recursively alter
an Effect returned as the success value:

```silk
Effect<Effect<i32 ? &Clock> ? &Clock>
// provide Clock once:
Effect<Effect<i32 ? &Clock>>
```

`Effect.flatten` instead executes two layers in sequence and unions their contracts:

```text
Effect.flatten:
  Effect<Effect<A ! F ? S> ! E ? R>
  -> Effect<A ! E | F ? R | S>
```

Consequently, flattening the example first normalizes its duplicate key:

```silk
Effect<Effect<i32 ? &Clock> ? &Clock>
// flatten:
Effect<i32 ? &Clock | &Clock>
// normalize:
Effect<i32 ? &Clock>
```

Providing after flattening supplies the same selected provider to both executions. Providing the
outer Effect before flattening closes only the outer layer; the returned inner Effect still needs
its own provider. `flatten` and provision therefore do not commute.

When the two layers require the same service-role key at different access strengths, row union
retains the strongest access. Different roles remain distinct.

**Boundary:** A captured provider does not leak into an Effect returned as data unless that inner
Effect captured it explicitly. Provision does not eagerly validate runtime branches by executing
them, and dropping an unrun specialized Effect never runs its target.

Normal cleanup follows ownership on success, typed failure, or dropping an unrun Effect. A fatal
trap retains the language-wide rule that structured cleanup is not guaranteed.

**Diagnostics:** A borrowed provider that would escape its lifetime, an overlapping exclusive
borrow, or use of a moved provider receives the ordinary ownership diagnostic at the capture or
conflicting use. Provision-specific no-match and ambiguity diagnostics follow SERV-007. No
diagnostic is produced merely because the same requirement exists in a nested Effect success value.

**Current compiler:** Aligned. Provider capture is lazy and lexical, provision closes one Effect
layer, selectors and subtraction use access-independent keys, and `flatten` unions and normalizes
both layers' requirement rows.

**Evidence:** [effect construction and execution](effects-and-execution.md),
[nested Effect rule](effects-and-execution.md#eff-004--nested-effects-are-ordinary-values),
[flow-function provision specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md),
[provider ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

## SERV-010 — `Effect.provideEffect` acquires a fresh scoped provider

**Status:** Confirmed

`Effect.provideEffect<K>` accepts an acquisition Effect whose success value conforms to selected
service-role key `K`. It constructs a new lazy Effect that acquires a fresh provider each time it
runs, uses that provider for the target execution, and then cleans it under ordinary ownership
rules.

For target `Effect<A ! E ? R>` and acquisition `Effect<P ! F ? Q>`, where `P` conforms to `K`, the
resulting contract is:

```text
Effect<A ! E | F ? Without<R, K> | Q>
```

Conceptually, the combinator is ordinary Effect composition:

```silk
effect {
  let mut provider = run acquireProvider()
  return run Effect.provideMut<K>(target, &mut provider)
}
```

Acquisition runs before the target. If it fails, the target does not run. The provider is not
visible during its own acquisition, so acquisition requirements `Q` remain in the result even when
they contain the same key `K`. Successfully acquired provider state is scoped to the target and is
cleaned after target success or typed failure before that outcome propagates.

Because acquisition belongs to ordinary Effect execution, composition order controls repetition.
Retrying outside `provideEffect` reacquires for each attempt; placing retry inside the provided
target acquires once and reuses that provider across those inner attempts, subject to ordinary
access and reuse rules.

**Boundary:** `provideEffect` does not acquire at composition time, cache across executions,
memoize globally, expose the provider before acquisition completes, or construct a dependency
graph. A provider that needs its own service-role key during acquisition must receive an outer
provider for that key; it cannot satisfy its own construction retroactively.

A fatal trap preserves the language-wide rule that structured cleanup is not guaranteed.

**Diagnostics:** Provider selection follows SERV-007. Acquisition and target failures or
requirements compose normally rather than producing service-specific diagnostics. A provider whose
type does not conform to `K` reports the ordinary conformance mismatch at the acquisition argument.

**Current standard library:** `Effect.provideEffect` uses the access-independent service-role
selector `K`. No compatibility alias is retained in this green-field codebase.

**Evidence:** [current Effect standard library](../../../../packages/compiler/stdlib/silk/effect.silk),
[provider elaboration tests](../../../../packages/compiler/test/Elaboration.test.ts).
