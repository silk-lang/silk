# Lifetimes and elision

A lifetime describes how long a borrowed value is valid. It is part of the static type contract;
it is not a runtime token, an allocation, or the identity of a particular owner. Concrete loans
separately track which places supply the value and which uses keep those places borrowed.

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

**Evidence:** [lifetime requirements](../../../../openspec/specs/bootstrap-lifetimes/spec.md),
[lifetime syntax tests](../../../../packages/compiler/test/Parser.test.ts),
[lifetime checking tests](../../../../packages/compiler/test/Type.test.ts).

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

**Boundary:** A call checks the contract of the operation already selected. Lifetime failure does
not choose another implementation, conversion, or provider. A bound constrains validity; it never
makes two source owners the same owner. Mutation preserves the destination's declared type.

**Diagnostics:** An unsatisfied lifetime relation reports `SEM0212`; an unsatisfied type-contents
bound reports `SEM0213`. The diagnostic identifies the declared requirement and offending source
boundary.

**Evidence:** [outlives requirements](../../../../openspec/specs/bootstrap-lifetimes/spec.md),
[compatibility tests](../../../../packages/compiler/test/Type.test.ts).

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

Local type annotations instead infer body-scoped lifetimes from their uses and cleanup. Public
relationships never depend on return bodies, setter histories, or which constructor happened to
initialize a field.

**Boundary:** Two independent borrowed inputs with no receiver default require an explicit result
relationship. A by-value holder's stored view can be returned by naming its data lifetime; elision
does not reinterpret that stored view as an outer borrowed receiver.

**Diagnostics:** Missing or ambiguous output relationships report `SEM0210`. Editor hover shows
stable readable generated binders. **Make lifetimes explicit** offers a compiler-owned edit only
for a complete supported header, preserves comments and semantics, and disables stale actions.
Ordinary formatting preserves the author's explicit or omitted choices.

**Evidence:** [elision requirements](../../../../openspec/specs/bootstrap-lifetimes/spec.md),
[declaration tests](../../../../packages/compiler/test/DeclarationIndex.test.ts),
[editor action requirements](../../../../openspec/specs/language-server-code-actions/spec.md).

## LIFE-004 — Invocation lifetimes and retained environments are independent

**Status:** Confirmed

One outer `for<'call>` may quantify a callable contract. Each invocation must satisfy that contract
for a fresh lifetime. `fn<'env>(...) -> ...` separately names how long the callable's retained
captures remain valid; `mut` and `once` still express invocation access. A quantified signature may
refer to surrounding lifetime and type parameters.

```silk
fn identity<'call>(value: &'call i32) -> &'call i32 { return value }

fn apply<'data>(
  callback: for<'call> fn<'static>(&'call i32) -> &'call i32,
  value: &'data i32,
) -> &'data i32 {
  return callback(value)
}
```

An effect-function declaration may name its retained environment with
`effect<'env> fn retain<T: 'env, 'env>(value: T) -> i32`. The environment resolves against the
complete declaration binder list. Naming it retains every obligation of captured contents; it
does not make an invalid capture valid.

`Effect<'env; A ! E ? R>` names an Effect environment's validity independently of success `A`,
failure `E`, requirement row `R`, and run access. Omitted environments are elaborated from their
header or local context. An Effect that retains borrowed data is not detached merely because its
success and failure types contain no views.

A named function with no parameters retains nothing from inputs, so the omitted environment of its
`Effect` result is `'static`: `fn closed() -> Effect<i32>` has result `Effect<'static; i32>`, and
writing that spelling is equivalent. A parameterless `effect fn` constructs an Effect with the same
`'static` environment. Ordinary capture and lifetime checks still apply, so such an Effect cannot
retain anything that is not valid for `'static`. The default does not extend to functions with
owned or generic inputs, where an omitted output environment still needs a single borrowed input,
or to callables and Effects nested inside a callable contract.

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

**Evidence:** [quantified callable requirements](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[lifetime checking tests](../../../../packages/compiler/test/Type.test.ts).

## LIFE-005 — Dependent storage keeps cleanup and access lifetimes distinct

**Status:** Confirmed

`RawBuffer<T>` is invariant in its payload type. `Slot<'storage, T>` adds the exclusive storage
access lifetime; that lifetime may shorten, while `T` remains invariant. The elided spelling
`Slot<T>` follows ordinary nominal lifetime elision. A slot cannot escape the buffer that supplied
it. Slot projection checks the recorded element count; the caller still proves that the underlying
allocation fits that count. Taking an initialized element transfers `T`, including its external referent lifetimes;
copying one requires `T: Copy` and retains those same lifetimes. Neither operation extends a
reference into the buffer's own allocation beyond that allocation's lifetime.

`Vector<T>` uses these operations in ordinary Silk source. Its empty constructor, ordinary
replacement and extraction operations, and insertion Effects with unit outcomes admit shared
references and affine elements containing exclusive references. Extracted external references may
survive the Vector while their backing owners remain valid. A Vector's Drop cleans its initialized
elements before releasing storage, including after growth failure.

A user Drop hook conservatively retains every component its declared receiver could observe.
An empty hook body does not waive this contract. Recursive field cleanup follows the initialized
remainder: a moved whole Drop-bearing field belongs to its new owner, while its plain former
container cleans the fields it still owns. Moving through a whole-value Drop ancestor is invalid.
Replacement preserves the declared destination type and evaluates incoming expressions before
committing installation. A typed failure cleans the actual remaining state, including earlier
permitted moves, without rollback.

**Boundary:** Raw storage callers still prove bounds, initializedness and aliasing. Hooks remain
synchronous, infallible, non-allocating, requirement-free and non-escaping. Suspension preserves
partial state; cancellation cleans only initialized components. Fatal traps do not unwind source cleanup.

**Diagnostics:** Conflicting access reports `OWN0010` or `OWN0011`; invalidation beyond validity
reports `OWN0019`. Invalid replacement uses the ordinary type and lifetime diagnostics.

**Evidence:** [owned-allocation requirements](../../../../openspec/specs/bootstrap-owned-allocation/spec.md),
[dependent ownership tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts),
[Vector tests](../../../../packages/compiler/test/VectorAcceptance.test.ts).
