# Lifetimes and elision

A lifetime describes how long a borrowed value is valid. It is part of the static type contract;
it is not a runtime token, an allocation, or the identity of a particular owner. Concrete loans
separately track which places supply the value and which uses keep those places borrowed. LIFE-006
defines how each body's regions and loans are checked.

## LIFE-001 — Lifetime parameters name validity relationships

**Status:** Confirmed

A lifetime parameter begins with an apostrophe. Declarations and nominal applications may include
lifetimes and ordinary generic parameters in the same angle-bracket list. Their argument namespaces
are separate, so omitting a lifetime does not consume an ordinary type-argument position.

```silk
struct View<'data, T> { value: &'data T }

fn wrap<'data, T>(value: &'data T) -> View<'data, T> {
  return View<'data, T> { value: value }
}
```

References use `&'data T` or `&'data mut T`; slices use `&'data [T]` or `&'data mut [T]`.
`string<'text>` is an immutable UTF-8 view valid for `'text`. Ordinary text and byte literals carry
`'static`, the distinguished program-valid lifetime. An owned value satisfying a `'static` contents
bound may still be dropped normally; that bound does not require its owner to live forever.

**Boundary:** Shared and exclusive views may appear in fields, generic arguments, fixed arrays, and ordinary
unions. Each containing type retains their lifetimes. A reference into a local owner's inline
storage cannot become `'static`, and moving an owner together with such a reference does not make
a valid self-referential value. Exclusive fields remain affine. A dependent user `Drop` keeps all
observable borrowed components valid through cleanup, even without an explicit source read.
Effect successes and failures preserve these same lifetimes through run, propagation and recovery.

**Diagnostics:** An unknown lifetime reports `SEM0209`. Duplicate, invalid, or unsupported binders
report the corresponding declaration diagnostic, including `SEM0211` for invalid lifetime forms.
A use beyond a referent's validity reports `OWN0019`, including through generic Effect outcomes.

**Evidence:** lifetime requirements,
lifetime syntax tests,
lifetime checking tests.

## LIFE-002 — Outlives bounds constrain contents and access

**Status:** Confirmed

`'long: 'short` requires `'long` to cover `'short`. `T: 'use` requires the borrowed contents of `T`
to remain valid for `'use`. Multiple bounds use `+`. The type `&'use T` itself implies `T: 'use`.

```silk
fn shorten<'long: 'short, 'short>(value: &'long i32) -> &'short i32 {
  return value
}
```

Shared references are covariant in their lifetime and payload. Exclusive references may shorten
outer access, but their target type is invariant: `&mut Holder<'long>` cannot become a destination
for an unrelated `Holder<'short>`. Nominal lifetime variance follows its fields; opaque or interior
mutable storage retains conservative invariant boundaries. Callable inputs reverse variance and
results preserve it.

An invariant position does not stop inference. A body-local region in one, such as the element
region of `let names = List<Name>.make()`, is held equal to the region it meets, so `return move
names` checks against a result `List<Name>` whose element borrows a parameter. Two body-local
regions meet the same way, as when a `Plan<'a>` that holds a `List<Item<'a>>` is appended to `let
plans = List<Plan>.make()`; the region check then requires each loan to live as long as the other.
A section's bound regions stay exact. Two declared lifetimes in an invariant position must be equal
or bound each other both ways.

A body assumes the bounds its header declares and the bounds its parameter and result types imply.
Inside a generic body, the contents of each type parameter are one opaque region chosen by the
caller: it outlives the body, `'static` outlives it, and it outlives one of the body's lifetimes
only through a declared or implied `T: 'a`. Each call proves the callee's declared and implied
bounds, `T: 'a` included, for its arguments. A call through a callable value proves the bounds its
parameter and result types imply in the same way.

**Boundary:** A call checks the contract of the operation already selected. Lifetime failure does
not choose another implementation, conversion, or provider. A bound constrains validity; it never
makes two source owners the same owner. Mutation preserves the destination's declared type.

**Diagnostics:** An unsatisfied lifetime relation reports `SEM0212`; an unsatisfied type-contents
bound reports `SEM0213`. The diagnostic identifies the declared requirement and offending source
boundary.

**Evidence:** outlives requirements,
compatibility tests.

## LIFE-003 — Elision is determined by the declaration header

**Status:** Confirmed

An omitted lifetime on each independent borrowed input introduces a fresh declaration binder. An
outer borrowed receiver supplies omitted result lifetimes; without that receiver, exactly one
top-level borrowed input supplies the default. A string input participates as a borrowed view.

```silk
fn first(values: &[i32]) -> &i32 {
  return &values[0]
}
```

Its expanded contract is `fn first<'life0>(values: &'life0 [i32]) -> &'life0 i32`.
Each omitted lifetime in a nominal input introduces an independent binder. Borrowing a wrapper
adds its own outer lifetime; that outer borrow does not merge the wrapper's stored-data lifetimes.
Omitted nominal output lifetimes use the same result default. Each omitted borrowed field introduces
an independent parameter of its containing declaration.

An inherent impl also introduces owner binders for omitted nominal lifetimes. For example,
`impl<A> SliceStream<A>` can define `make(slice: &[A]) -> SliceStream<A>`: its returned
holder uses the input's lifetime, so `SliceStream.make(&values)` is callable. Returning `Self`
instead keeps the impl's applied owner, including its stored-data lifetimes. It does not connect
those lifetimes to an independently elided input; name the shared lifetime explicitly when a
constructor returns `Self`.

Conformance headers apply the same nominal lifetime elision. For a holder with one stored-data
lifetime, `impl<A: Copy> Stream<A, never ? never> for SliceStream<A>` introduces an independent
impl lifetime and retains it in the operation contracts. It has the same relationships as an
explicitly bound `impl<'data, A: Copy> ... for SliceStream<'data, A>`. Ordinary type arguments,
bounds and conformance selection are unchanged; `Self` still denotes that fixed applied owner.

Local type annotations instead infer body-scoped lifetimes from their uses and cleanup. A lifetime
an annotation, a literal's type arguments or a call's generic arguments write is fixed, even when an
argument beside it is inferred. For example, `PairWith<'a> {view: &src.t, extra: 1}` keeps its
borrow for `'a`. Public
relationships never depend on return bodies, setter histories, or which constructor happened to
initialize a field.

**Boundary:** Two independent borrowed inputs with no receiver default require an explicit result
relationship. A by-value holder's stored view can be returned by naming its data lifetime; elision
does not reinterpret that stored view as an outer borrowed receiver.

**Diagnostics:** Missing or ambiguous output relationships report `SEM0210`. Editor hover shows
stable readable generated binders. **Make lifetimes explicit** offers a compiler-owned edit only
for a complete supported header, preserves comments and semantics, and disables stale actions.
Ordinary formatting preserves the author's explicit or omitted choices.

**Evidence:** elision requirements,
declaration tests,
editor action requirements.

## LIFE-004 — Invocation lifetimes and retained environments are independent

**Status:** Confirmed

One outer `for<'call>` may quantify a callable contract. Each invocation must satisfy that contract
for a fresh lifetime. `fn<'env>(...) -> ...` separately names how long the callable's retained
captures remain valid; `mut` and `once` still express invocation access. A quantified signature may
refer to surrounding lifetime and type parameters. A callable parameter type that omits `fn<'env>`
has a fresh environment lifetime, as any other elided input lifetime does (LIFE-003). For example,
`use: once fn(&mut Frame<'o>) -> i32` accepts a callable whose captures only need to outlive the
call, like Rust's `impl FnOnce(&mut Frame<'o>) -> i32`. The lifetimes its parameter and result types
name are not obligations of its environment.

```silk
fn identity<'call>(value: &'call i32) -> &'call i32 { return value }

fn apply<'data>(
  callback: for<'call> fn<'static>(&'call i32) -> &'call i32,
  value: &'data i32,
) -> &'data i32 {
  return callback(value)
}
```

A callable may instead mark one outer binder with `for<use 'call>`. This binder names the extent
of that particular invocation, including use of its returned computation, suspension, cancellation,
and cleanup. Every supplied input must remain valid for that whole extent. The marker does not
require generic input contents to outlive the callable's stored capture environment or `'static`.
It applies to ordinary callable contracts; no library declaration name changes its meaning.

The stored capture environment remains independent. A returned computation that retains both an
input and a capture has the intersection of their invocation and capture environments, such as
`Effect<'call & 'env; B>`. Its holder, aliases, stored fields, and cleanup remain within those
loans. A callback may return independent data. It may not conceal retained input dependencies in a
result type, return a borrowed view of a consumed parameter's former binding cell, or let a
computation retaining those inputs escape their use extent.

An unmarked `for<'data>` still quantifies an independent data lifetime. The marked binder keeps its
original position alongside such binders and cannot be chosen by an explicit call-prefix argument.
Only one outer binder may be marked, and it has no authored colon bounds. Partial application
retains each supplied original input's obligation until actual invocation; storing an input does
not turn that obligation into a premise about every value of the same generic type.

Anonymous recovery callbacks receive the marked input conditions while checking their body.
Their own captures must satisfy formation independently. A named generic callback must prove its
actual parameter, result, access, failure, and requirement contracts under those conditions; a
contextual expected result cannot replace its real implementation signature.

An anonymous callable or Effect body is checked on its own (LIFE-006). The lifetimes of its
signature and the regions its environment names are chosen outside it. A relation between those
regions that the body needs and no declared bound states does not reject the anonymous body: it
becomes a requirement of the body that constructs the callable or Effect, proved there at the
construction. A requirement the creator cannot satisfy is reported in the creator.

An effect-function declaration may name its retained environment with
`effect<'env> fn retain<T: 'env, 'env>(value: T) -> i32`. The environment resolves against the
complete declaration binder list. Naming it retains every obligation of captured contents; it
does not make an invalid capture valid.

`Effect<'env; A ! E ? R>` names an Effect environment's validity independently of success `A`,
failure `E`, requirement row `R`, and run access. Omitted environments are elaborated from their
header or local context. An Effect that retains borrowed data is not detached merely because its
success and failure types contain no views.

An `effect fn` captures every input, so an omitted `effect fn` environment is the intersection of
the regions its inputs retain, in any order and without repeats. An input retains the region of a
borrow, each non-`'static` lifetime argument of a nominal type, and the environment of a callable
or Effect, including those nested in its stored contents. The parameter, success, failure, and
requirement types of a callable or Effect input are not stored, so
`effect fn run<A, E>(pending: once Effect<'static; A ! E>) -> A ! E` has a `'static` environment and
`effect fn keep<A>(pending: once Effect<A>) -> A` retains the pending Effect's region. An input
whose stored contents involve a type parameter, such as `value: T` or `Box<T>`, has no nameable
region. The omitted environment is then ambiguous (SEM0210) at that input, and the declaration
writes `effect<'env> fn`. A written environment carries the obligation that every captured value
outlives it: each call, and each witness of an interface or service operation, must satisfy it. A
`T: 'env` bound states that obligation explicitly and is optional; it adds nothing the written
environment does not already require, including for a parameter of an enclosing `impl`,
interface, or service. A borrowed first input is not covered. As a service witness, that input is
the provider: the provision lends it, whatever the parameter is named, and no call relates it to
the operation's environment. So the body never assumes a borrowed first input outlives the written
environment. A function that returns a view of that input at the environment writes the relation in
its type, as `cell: &'env Cell`. Owned and generic first inputs remain covered.

An ordinary named function whose result is an `Effect` with an omitted environment elides it from
the header under LIFE-003. A single borrowed input supplies the environment, and several borrowed
inputs require it to be written. When no input carries borrowed data, the environment is `'static`, so
`fn closed() -> Effect<i32>` and `fn answerExplicit(input: i32) -> Effect<i32>` both have results
of the form `Effect<'static; i32>`. Any other input that retains a region or stores generic
contents, with no single borrowed input, leaves the omitted environment ambiguous (SEM0210), so
`fn f<'a>(value: Held<'a, i32>) -> Effect<i32>` writes `Effect<'a; i32>`. The `'static` default
does not apply to an `effect fn` whose success type is an Effect: `effect fn f() -> Effect<i32>` is
ambiguous and writes `Effect<'static; i32>`, whatever its own capture environment.

These defaults cover only the result's own environment. They do not apply to an Effect nested in
that result, or to callables and Effects inside a callable contract. Ordinary capture and lifetime
checks still apply, so an Effect cannot retain anything that is not valid for its environment.

Effect environment positions also accept finite intersections: `Effect<'call & 'env; A ! E ? R>`
and `effect<'a & 'b> fn`. An intersection is valid only while every constituent is valid. It is
associative, commutative, and idempotent; `'static` is its identity. Canonical identity does not
depend on ambient outlives assumptions.

Each constituent outlives the intersection. The intersection outlives another region when every
constituent outlives that region. It cannot be promoted to a longer constituent without proof.
For example, `for<'call> once fn<'env>(&'call mut Resource) -> once Effect<'call & 'env; A ! E ? R>`
retains both a fresh resource loan and captured data. Anonymous effect callables derive this
intersection from their capture validity and retained inputs; generic contents keep their own
outlives obligations. The intersection introduces no additional binder or runtime field.

`Effect.useReleaseNonParking` uses this result contract for both callbacks. It disposes the use
Effect and ends its loan before creating the release loan; neither callback may export the resource
loan as an outcome. Release remains non-parking and runs during cancellation with the original
outcome preserved.

**Boundary:** Nested quantified callable signatures and unconstrained higher-rank inference are
unsupported. A callback cannot store a fresh invocation borrow into longer-lived surrounding
storage. An outcome may outlive its computation when it borrows independently valid external data;
it cannot borrow storage destroyed with the computation. Suspended partial owners retain their
initialized remainder and conditional cleanup flags.

**Diagnostics:** Unsupported quantifier structure reports `SEM0211`. Callable incompatibility
reports `SEM0076`; invalid retention uses the ordinary lifetime or ownership diagnostic.

**Evidence:** quantified callable requirements,
lifetime checking tests.

## LIFE-005 — Dependent storage keeps cleanup and access lifetimes distinct

**Status:** Confirmed

`Intrinsic.RawBuffer<T>` is invariant in its payload type. `Intrinsic.Slot<'storage, T>` adds the
exclusive storage access lifetime; that lifetime may shorten, while `T` remains invariant. The elided
spelling `Intrinsic.Slot<T>` follows ordinary nominal lifetime elision. A slot cannot escape the buffer that supplied
it. Slot projection checks the recorded element count; the caller still proves that the underlying
allocation fits that count. Taking an initialized element transfers `T`, including its external referent lifetimes;
copying one requires `T: Copy` and retains those same lifetimes. Neither operation extends a
reference into the buffer's own allocation beyond that allocation's lifetime.

`List<T>` uses these operations in ordinary Silk source. Its empty constructor, ordinary
replacement and extraction operations, and insertion Effects with unit outcomes admit shared
references and affine elements containing exclusive references. Extracted external references may
survive the List while their backing owners remain valid. A List's Drop cleans its initialized
elements before releasing storage, including after growth failure.

A user Drop hook conservatively retains every component its declared receiver could observe.
An empty hook body does not waive this contract, and no declaration marks one of its lifetime or
type parameters unobserved. Cleanup of a value keeps alive only the lifetimes its type's cleanup
observes. A nominal type with a hook observes every lifetime and type argument it is applied to.
A nominal type without a hook observes what its fields' cleanup observes, composed through every
nominal type they apply; a field whose type is one of its type parameters observes what the
argument's own cleanup observes. Arrays, unions, anonymous aggregates, and callable and Effect
environments observe what their parts observe. References, slices, strings, raw pointers, and
primitives run no cleanup, so a holder that only borrows keeps nothing alive through its cleanup.
Inside a generic body, a value of a type parameter keeps none of the body's regions alive through
its cleanup, because its contents outlive the body (LIFE-002). A type whose cleanup these rules do
not describe, such as an opaque callable or Effect, observes every lifetime it names.

Recursive field cleanup follows the initialized remainder: a moved whole Drop-bearing field belongs
to its new owner, while its plain former container cleans the fields it still owns. Moving through
a whole-value Drop ancestor is invalid.
Replacement preserves the declared destination type and evaluates incoming expressions before
committing installation. A typed failure cleans the actual remaining state, including earlier
permitted moves, without rollback.

**Boundary:** Raw storage callers still prove bounds, initializedness and aliasing. Hooks remain
synchronous, infallible, non-allocating, requirement-free and non-escaping. Suspension preserves
partial state; cancellation cleans only initialized components. Fatal traps do not unwind source cleanup.

**Diagnostics:** Conflicting access reports `OWN0010` or `OWN0011`; invalidation beyond validity
reports `OWN0019`. Invalid replacement uses the ordinary type and lifetime diagnostics.

**Evidence:** owned-allocation requirements,
dependent ownership tests,
List tests.

## LIFE-006 — Regions are sets of program points

**Status:** Confirmed

Every runtime function body, including the body of an anonymous callable or Effect, is either
checked completely or rejected. The compiler proves every loan, move, and region relation in the
body, or it reports a diagnostic. No body is accepted with an obligation left open.

Inside a body, each lifetime denotes a region: a set of points in the body's control flow. A value
has one region for each distinct lifetime its type names. A region holds every point where a value
whose type names it is live, plus whatever the outlives relations required by the body's bindings,
assignments, calls, returns, field stores, and captures add. A value is live at a point when some
path from that point reads it before it is written again. Cleanup counts as a read only for the
lifetimes that cleanup observes (LIFE-005). The lifetime parameters of the body and its enclosing
declarations, and `'static`, are chosen by the caller: their regions hold the whole body.

A borrow creates a loan whose region is the region of the resulting reference. The loan is in scope
from the borrow along each path until the path reaches a point its region does not hold, or a write
of the borrowed place or a prefix of it. While a loan is in scope, conflicting access to its place
is rejected (BORROW-001, BORROW-002), and so is the end of that place's storage.

Writing a whole local, or moving or dropping it, ends the liveness of its old value. Its regions
therefore need not hold the points between the old value's last use and the write that replaces it,
and a loan carried only by the old value leaves scope in that gap:

```silk
struct Token { value: i32 }
struct View<'a> { left: &'a Token }

fn replaced(restore: bool) -> i32 {
  let base = Token { value: 42 }
  let mut view = View { left: &base }
  if restore {
    let owner = Token { value: 3 }
    view = View { left: &owner }
    view = View { left: &base }
  }
  return view.left.value
}
```

The loan of `owner` ends at the first replacement, before `owner`'s storage ends. A replaced value's
cleanup runs at the write, so for a lifetime that cleanup observes there is no gap: replacing a
holder whose `Drop` hook observes the loan keeps the loan in scope up to the write.

**Boundary:** Regions are not location-sensitive. Precision is per lifetime: a value has one region
for each lifetime its type names, not one per field or per write, so fields that share a lifetime
share every loan stored in either of them. Writing a field, or writing through a reference, does
not end the holder's liveness, and a later use of any part of a local keeps every region its type
names. A program that is valid only if such a write released a loan is rejected:

```silk,ignore
struct Token { value: i32 }
struct View<'a> { left: &'a Token }

fn restored(restore: bool) -> i32 {
  let base = Token { value: 42 }
  let mut view = View { left: &base }
  if restore {
    let owner = Token { value: 3 }
    view.left = &owner
    view.left = &base
  }
  return view.left.value
}
```

The field writes leave `view` live, so its region still holds the loan of `owner` when `owner`'s
storage ends, and the return's `view.left.value` reports `OWN0019`. Location-sensitive regions, which would accept this program, are not part of the
language; GitHub issue #2022 tracks them.

Static evaluation has no loans (STATIC-005), so a `static fn` body and an expression selected for
static evaluation are not region-checked.

**Diagnostics:** A borrow of local or temporary storage whose loan must outlive a lifetime chosen by
the caller, such as a lifetime parameter or `'static`, reports `SEM0212` at the borrow. A relation
between two caller-chosen lifetimes that no declared or implied bound gives reports `SEM0212` at
the flow that requires it. A use of a view after its referent's storage has ended reports `OWN0019`
at that use. Storage that ends with a block ends at the block's closing brace, which is the reported
span when the use is cleanup there. A write, move, or drop that conflicts with a loan in scope
reports `OWN0011` at that access, and the next use of a view carrying the loan reports `OWN0019`.

**Evidence:** region checker decisions,
rustc NLL comparison,
lifetime checking tests.
