# Language style guide

This guide records source conventions for readable and discoverable Silk APIs. Its rules do not
change whether a program is valid. The compiler treats a type according to its declaration and use,
never according to its name.

Public source documentation follows the separate
[doc comment style guide](documentation-style-guide.md). That guide defines comment coverage,
structure, examples, links, and ASD-STE100 writing rules. This page defines naming, API shape, and
source-usage conventions.

## STYLE-001 — Nominal error types use the `Error` suffix

**Status:** Confirmed

A nominal type designed primarily to be carried through an Effect failure channel should end in
`Error`. The convention is especially important in public APIs, where the name must communicate its
role without requiring callers to inspect the implementation.

```silk
pub struct NotFoundError { id: i32 }
pub struct PermissionDeniedError { id: i32 }

pub effect fn read(id: i32) -> string ! NotFoundError | PermissionDeniedError {
  fail NotFoundError { id: id }
}
```

Use the condition or domain name first and `Error` last: `NotFoundError`, not `ErrorNotFound`.
Module qualification already groups related names, while the suffix lets the type read naturally:

```text
filesystem.NotFoundError
filesystem.PermissionDeniedError
```

Use `Failure` for an unsuccessful outcome variant that carries an error, not for the error payload
type itself. For example, `NotFoundError` names a value while
`Result<A, NotFoundError>.Failure` selects an outcome containing that value.

**Boundary:** The suffix communicates API intent only. `NotFoundError` remains an ordinary value
type and may be stored, passed, returned, or inspected outside an Effect. Conversely, every valid
ordinary type—including `string` and `i32`—may be used as a failure type without an `Error` suffix.

A nominal type that primarily represents ordinary domain data does not gain the suffix merely
because one API may fail with it. Name the type for its dominant meaning.

**Tooling:** The compiler does not enforce this convention. Language tooling may offer a
non-blocking style warning or rename action when a public nominal type is introduced primarily as a
failure type. Such tooling must not imply that the name changes the type's semantics.

**Current standard library:** Consistent. Public error payloads include `FileError`, `LogError`,
`ProcessError`, `ParseError`, `HostInputError`, `StreamReadError`, `WriterError`,
`OutOfMemoryError`, `StalledError`, and `TaskIdExhaustedError`. The `Result<A, F>.Failure` variant
keeps its existing name because it is ordinary result data rather than an error declaration, and
the fiber `Cancelled` outcome keeps its name for the same reason: it is the third arm of `Outcome`
alongside `Success` and `Failure`, not an error payload type.

**Evidence:** [ordinary failure values](typed-failures.md#fail-001--any-concrete-lifetime-valid-value-may-be-a-typed-failure).

## STYLE-002 — Operations intrinsic to one type are inherent members with the receiver first

**Status:** Confirmed

An operation intrinsic to one nominal type is declared in that type's inherent `impl` block, with
the value it operates on as the first parameter. Callers qualify the operation through the owner
type:

```silk
pub struct Counter { value: i32 }

impl Counter {
  pub fn increment(self: Self, amount: i32) -> Counter {
    return Counter { value: self.value + amount }
  }
}

pub fn main() -> i32 {
  let direct = Counter.increment(Counter { value: 40 }, 1)
  let piped = Counter { value: 40 } |> Counter.increment(1)
  let method = Counter { value: 40 }.increment(1)
  return direct.value + piped.value + method.value - 81
}
```

The direct, pipeline, and method forms share one contract. `Counter.increment` is an ordinary function whose
parameter zero is the receiver, so supplying a non-empty trailing suffix of its arguments creates a
callable waiting for that receiver. This is not special treatment for Effect APIs: `Effect.provide`
is an inherent member of the `Effect` struct and has the same shape:

```silk
import silk.effect { Effect }

let specialized = Effect.provide(computation, &clock)
let piped = computation |> Effect.provide(&clock)
```

An operation that relates several peer types, or that expresses a module-level concept rather than
one type, stays a free function at the module root and is imported or namespace-qualified:

```silk
pub struct Meters { value: i32 }
pub struct Seconds { value: i32 }

pub fn speed(distance: &Meters, elapsed: &Seconds) -> i32 {
  return distance.value / elapsed.value
}

pub fn main() -> i32 {
  return speed(&Meters { value: 84 }, &Seconds { value: 2 })
}
```

Put an operation where its receiver is. A function whose first parameter is the owner and whose
meaning belongs to that type is a member; a function that would pick one owner arbitrarily among
equals is free. The standard library follows this split with one deliberate exception:
`Order.compare`, `Order.less`, `Order.equal`, `Order.isLess`, `Order.isEqual`, and
`Order.isGreater` are associated functions of the `Order` interface although their parameters are
`T: Order` values or an `Ordering`, so the spelling callers already use stays stable.

Nominal data types remain primarily data. An inherent `impl` collects the operations intrinsic to
its owner; a conformance `impl Contract for Type` exists because the type conforms to an interface
or service, not to collect functions. When a contract operation is also a useful concrete API,
declare it as an inherent member and map the conformance operation to it; an inline conformance
body remains valid when no separately callable operation is useful.

Only the module declaring a nominal type may declare its inherent impls. A conformance belongs to
the provider's module or, for an interface, to the interface's module, as
[IMPL-004](generics-interfaces-and-specialization.md#impl-004--an-interface-or-its-nominal-provider-may-own-a-conformance)
defines.
Another module adds behavior for an existing public type as a free function qualified by the
module that defines it—or imported directly—never by injecting a member into the owner. Modules and
nominal types are not reopenable namespaces. If two imported modules or selected functions would
introduce the same local name, the import is a collision and the caller must alias at least one of
them. Silk does not select by import order or form an overload set.

**Boundary:** This is an API convention, not a validity rule. A member may place another argument
first when its domain meaning calls for that order, and a valid inline conformance is not rejected
for lacking a mapped member. A receiver method is also callable as `counter.increment(1)`; that
spelling resolves to the same member as `Counter.increment(counter, 1)` and
`counter |> Counter.increment(1)`, with the receiver's ownership taken from the declared `self`
parameter (`Self` consumes, `&Self` borrows, `&mut Self` borrows exclusively). Only a member whose
first parameter is `self` is callable through a value; an associated function such as
`Counter.zero()` is not, and `counter.increment` without a call is not a callable value. The
receiver-first contract described here is what lets all three spellings share one member without a
second calling convention.

Extension functions do not retroactively make an external type conform to an interface or service;
a third-party type/interface combination requires an owned adapter type. This coherence boundary is
independent from the ability to add ordinary functions anywhere.

**Tooling:** The compiler does not require an operation to be a member or a free function. Language
tooling and API documentation present a member under its owner, label it a method when parameter
zero is a `self` receiver of the owner type and an associated function otherwise, and may show the
direct and pipeline forms together. Reopening another module or type remains an invalid language
boundary, not a style warning.

**Evidence:** [inherent member index](../../../../openspec/specs/bootstrap-declaration-index/spec.md),
[callable pipeline specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[nominal qualifiers](modules-names-and-visibility.md#name-005--a-nominal-qualifier-exposes-only-its-associated-items).

## STYLE-003 — Examples import the owner type and qualify operations through it

**Status:** Confirmed

Documentation, tutorials, and public API examples import the type that owns an operation and
qualify the operation through that name:

```silk
import model.User { User }

let user = User.make(42)
let reassigned = User.withId(move user, 43)
```

This keeps the operation's owner visible where it is used. A reader identifies `make` and `withId`
as members of `User` without searching the import list or relying on a globally distinct function
name, and the spelling matches the receiver-first convention in STYLE-002. A selected type binding
exposes exactly the type's associated items—variants, contract operations, and inherent members—so
one import names both the type and its operations:

```silk
import silk.effect { Effect }

let provided = computation |> Effect.provide(&clock)
return run provided
```

Import a module namespace when the module itself is the subject being taught, or when the operation
is a root declaration with no owner type, as in the primitive namespaces `silk.i32` and
`silk.usize`. A namespace binding exposes only root declarations and never reaches an inherent
member, so `import silk.option` followed by `option.map(...)` is not a
substitute for the owner import. Select a root declaration directly when an example reads it
unqualified or when repeated qualification would obscure the example's actual point; an inherent
member cannot be selected on its own.

```silk
import model.User { User }

fn id(user: &User) -> i32 {
  return user.id
}
```

Use canonical names without aliases. Standard-library operation modules provide a public owner,
using a zero-data scope struct when there is no principal data type. Import that owner selectively,
for example `import silk.static_sequence { StaticSequence }` or `import silk.pointer { Pointer }`.
Primitive modules keep their lowercase names: `import silk.usize` makes `usize.ZERO` available.

Use an alias only to resolve a real name collision. First consider giving the declarations more
specific canonical names. When both names must remain, alias one selected type and keep its
operations qualified:

```silk
import model.User { User }
import audit.User { User as UserAudit }

let user = User.make(42)
UserAudit.record(&user)
```

**Boundary:** This is a documentation and API-style preference, not a compiler restriction.
Namespace imports, member aliases, and hybrid imports have their ordinary language meaning. A
reference page specifically documenting those forms should show them directly even though general
examples prefer the owner import. A root type declared beside an owner is not an associated item of
that owner: select `ParseError` directly with `import silk.format { Format, ParseError }` rather
than writing `Format.ParseError`. A conformance still belongs to the module IMPL-004 permits,
whichever type an example imports.

**Tooling:** Formatters do not rewrite between namespace and selective imports. Documentation lint
may prefer qualification in general examples but must permit selective imports where the example is
teaching that syntax or naming an imported type directly.

**Evidence:** [nominal qualifiers](modules-names-and-visibility.md#name-005--a-nominal-qualifier-exposes-only-its-associated-items),
[namespace imports](modules-names-and-visibility.md#import-001--a-namespace-import-binds-the-targets-final-path-segment),
[receiver-first members](#style-002--operations-intrinsic-to-one-type-are-inherent-members-with-the-receiver-first).
