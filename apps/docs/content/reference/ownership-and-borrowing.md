# Ownership and borrowing

Silk separates responsibility for a value from temporary access to it. An affine value has one
owner, a move transfers that ownership, and a borrow grants access without transferring ownership.
This keeps copying and cleanup visible in function contracts without requiring manual memory
management.

[`Shared<T>`](local-shared-ownership.md) adds dynamically lived, allocation-backed strong ownership
inside one local execution domain. Its callback references obey the borrowing rules on this page,
but its handles are affine owners rather than lexical references.

This page defines owned values, lexical borrowing, projection and control-flow behavior, captured
ownership, cleanup, allocation lifecycles, and returned views. Each rule states its boundary and
the diagnostic a programmer should expect when that boundary is crossed.

## Terminology

- An **owner** is a binding or owned place responsible for an affine value.
- A **Copy type** is a type whose values may be duplicated by an ordinary read.
- An **affine type** is a type whose values may have at most one owner. “At most one” means the
  program may move or discard the value; it does not have to consume it explicitly before leaving
  scope.
- A **read** obtains a Copy value without changing the source's ownership.
- A **move** transfers an initialized value to a new owner and makes its source place unavailable.
- A **place** is a stable storage location, such as a local binding, a field rooted in a local, or
  an indexed element rooted in a local.
- A **root owner** is the binding at the start of a place. The root owner of `tokens[index].kind` is
  `tokens`.
- A value is **live** when its place is initialized and available for use.
- A **partial move** transfers one initialized owned part out of an aggregate while leaving the
  aggregate itself in place.
- A **replacement** assigns a complete new value to a live place. The displaced value is cleaned
  exactly once if its type requires cleanup.
- A **borrow** grants temporary access to a place without transferring its ownership.
- A **loan** is the compiler's record that a place remains borrowed. The loan restricts conflicting
  access until the borrow ends.
- A **lifetime** is a static validity region carried by a type. A concrete loan separately records
  the borrowed place and the uses or cleanup that require it to remain valid.
- A **shared reference** `&T` permits read access to one `T`.
- An **exclusive reference** `&mut T` permits sole read and mutation access to one `T`.
- A **slice** is a borrowed runtime-length view: `&[T]` is shared and `&mut [T]` is exclusive.
- A **borrowed view** is a reference, slice, or another non-owning value such as `string` whose
  validity remains tied to a root owner.
- A **returned view** is a borrowed value passed back under the lifetimes declared in its result type.
  Concrete loans retain the caller-owned referents on which that value depends.
- A view's **provenance** identifies that source parameter, root owner, and projection path.
- A **reborrow** creates a shorter borrow through an existing reference or slice without changing
  ownership of the original value.
- A **capture** is a value or borrow retained by a callable or Effect for later execution.
- A captured value's **environment** is the hidden aggregate that retains its captures. An Effect
  environment is distinct from its service-requirement row.
- A callable's **invocation mode** states whether its environment may be accessed shared, accessed
  exclusively, or consumed when called.
- An Effect's **run access** states the corresponding access required to execute that Effect value.
- **Cleanup** releases the resources owned by a live value. It is broader than a user-defined
  `Drop` hook and is defined in Batch 5.

## Batch 1 — Owned values and transfers

### OWN-001 — Every value type is either Copy or affine

**Status:** Confirmed

An ordinary read may duplicate a value only when its type has the compiler-sealed `Copy` property.
All other values are affine: they have one owner and must not be duplicated implicitly.

Scalar value types such as `()`, `bool`, integers, and floating-point numbers are Copy. Composite
types derive or request Copy behavior under their own rules. A user-defined struct is affine unless
it explicitly requests Copy conformance:

```silk
pub struct Point {
  pub x: i32
  pub y: i32
}

impl Copy for Point {}

fn sum(point: Point) -> i32 {
  let again = point
  return point.x + again.y
}
```

The compiler accepts that declaration only when every field is Copy and the type has no cleanup
behavior. `Copy` is a compiler-checked marker for values that can be duplicated without executing
user code. Users may request Copy conformance, but cannot define custom copying behavior.

Both `point` and `again` remain available because reading a `Point` duplicates it.

**Boundary:** A struct remains affine when it does not declare `impl Copy`, even if all its fields
are Copy. A struct containing any affine field, or declaring cleanup behavior, cannot opt into Copy.
This includes owners of allocated memory: implicitly duplicating one would create two owners of the
same allocation and two cleanup obligations.

Duplicating an allocation is instead an explicit operation such as `Buffer.clone(&buffer)`. It may
allocate new storage, fail, or require an allocator, and returns a genuinely independent owner. A
raw non-owning pointer may be Copy, but copying that pointer neither copies nor owns its allocation.

**Diagnostics:** Using an affine value where an implicit copy would be required reports `OWN0003`
and suggests an explicit move when ownership transfer is valid. An invalid `impl Copy` reports
`SEM0083` and identifies the first affine, cleanup-bearing, cyclic, or unavailable reason.

### OWN-002 — Ordinary reads copy Copy values and never consume an affine owner

**Status:** Confirmed

Reading a Copy value produces an independent copy and leaves its source live. This includes reading
a Copy field or indexed leaf from inside an affine aggregate; the enclosing owner is not consumed.

```silk
struct Token { kind: i32 }

fn inspectThenTransfer(token: Token) -> i32 {
  let kind = token.kind
  let next = move token
  return kind + next.kind
}
```

Reading `token.kind` copies the `i32`. The later `move token` therefore still transfers the complete
`Token`.

An affine value cannot be passed, returned, assigned, or bound by value through an ordinary read.
The source must say `move` when that operation transfers ownership:

```silk,ignore
struct Token { kind: i32 }

fn consume(token: Token) -> i32 { return token.kind }

fn invalid(token: Token) -> i32 {
  return consume(token)
}
```

**Boundary:** Merely mentioning an affine owner is not always a by-value use. Field projection,
borrowing, assignment targets, and consuming matches have their own access rules. The compiler must
diagnose the actual operation instead of treating every name occurrence as a move.

**Diagnostics:** An affine by-value use without `move` reports `OWN0003` at that use and identifies
the source binding. Reading a Copy leaf is valid and produces no ownership diagnostic.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[fixed-array ownership tests](../../../../packages/compiler/test/FixedArraySemantics.test.ts).

### OWN-003 — `move` transfers the complete value and consumes the source binding

**Status:** Confirmed

`move value` transfers the complete value and its future cleanup responsibility to the receiving
owner. After the move, the source binding is unavailable on every path where the move occurred.

```silk
struct Token { kind: i32 }

fn consume(token: Token) -> i32 { return token.kind }

pub fn main() -> i32 {
  let token = Token { kind: 42 }
  return consume(move token)
}
```

An explicit move is consuming even when the value's type is Copy:

```silk,ignore
pub fn main() -> i32 {
  let value = 42
  let next = move value
  return next + value
}
```

This is invalid because `value` was explicitly consumed. The type being Copy changes the meaning of
an ordinary read; it does not weaken the meaning of `move`.

**Boundary:** Moving a value does not run its cleanup. It transfers the obligation to the new owner.
Moving from only a field or element is governed by OWN-004.

**Diagnostics:** Reading or moving a consumed binding reports `OWN0001` at the later use and relates
the earlier consuming move. A second move is the same use-after-move error.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### OWN-004 — Eligible owned projections support partial moves

**Status:** Confirmed

An explicit move may extract a definitely initialized visible field, nested field, or fixed-array
element at a statically known in-bounds index. The selected subtree becomes unavailable; disjoint
initialized siblings remain usable. Moving a Copy field explicitly also leaves a hole.

```silk
struct Token { kind: i32 }
struct Envelope { token: Token code: i32 }

fn take(envelope: Envelope) -> Token {
  let code = envelope.code
  return move envelope.token
}
```

The returned token owns its cleanup. The envelope's automatic cleanup visits only its remaining
initialized fields. Whole-value reads, borrows, moves, captures, returns, and ordinary receiver
calls require every component of the accessed subtree to be initialized.

**Boundary:** A move cannot leave a hole through a reference, at a dynamic index, or beneath an
ancestor with a whole-value user `Drop` hook. Moving a complete Drop-bearing child from an outer
owner without its own hook is valid. Visibility and active loans still constrain access. A union
payload requires current variant proof from `match place` before projected extraction.

**Diagnostics:** Unsupported extraction boundaries report `OWN0002`; using missing storage reports
`OWN0001`. The diagnostic identifies the source place rather than classifying every projection as
an invalid move.

**Evidence:** [partial-move requirements](../../../../openspec/specs/bootstrap-ownership/spec.md),
[ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### OWN-005 — Mutation requires one live mutable root owner

**Status:** Confirmed

Assignment may replace or initialize a local, field, or indexed element when its root permits
mutation and no conflicting borrow is active. Writing a missing subtree restores it; replacing a
live or conditionally live subtree cleans only its old initialized contents.

```silk
struct Token { kind: i32 }

pub fn main() -> i32 {
  let mut token = Token { kind: 1 }
  token.kind = 42
  return token.kind
}
```

Replacing a non-Copy value transfers the new value into the destination and cleans the displaced
value exactly once:

```silk
struct Token { kind: i32 }

fn replace() -> i32 {
  let mut token = Token { kind: 1 }
  token = Token { kind: 42 }
  return token.kind
}
```

The destination is initialized after replacement. A partial enclosing owner becomes complete once
all its required components are definitely initialized on every reaching path.

The same storage rule applies to an owned ordinary-function parameter declared `mut name: T`.
Calling the function and returning an affine value still require explicit `move`; the prefix only
makes the callee's parameter root writable. Whole-parameter replacement cleans the displaced value
once, and a value explicitly moved out may be reinitialized before later use.

**Boundary:** `mut` grants one owned local or parameter root permission to change; it does not
override an active shared or exclusive loan under BORROW-001 and BORROW-002. Assignment must
install a complete value of the unchanged destination type. A projection inside a wholly missing
subtree is unavailable until that subtree itself is initialized. `mut` is invalid on borrowed parameters and on service or interface contract parameters.

**Diagnostics:** Mutation through an immutable root reports `SEM0035` at the assignment target.
Invalid parameter-level `mut` reports `SEM0143` at the keyword.
An explicit assignment may reinitialize consumed owned storage. Borrowed storage cannot be left
uninitialized, and active loans still report the applicable ownership diagnostic.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[mutable-loop and replacement tests](../../../../packages/compiler/test/MutableLoops.test.ts).

### OWN-006 — An assignment cannot consume its own destination

**Status:** Confirmed

The destination of an assignment and a value consumed to produce its replacement must not overlap.

```silk,ignore
struct Token { kind: i32 }

fn invalid() -> i32 {
  let mut token = Token { kind: 42 }
  token = move token
  return token.kind
}
```

This is not treated as a no-op. Replacement must preserve one unambiguous sequence: compute and
transfer a value from sources that remain valid for that computation, clean the displaced
destination, then leave the destination initialized with the replacement. Making the destination
its own consumed source would collapse those roles and make cleanup order ambiguous.

**Boundary:** Reading a Copy value from the destination while computing a replacement is not a
consuming overlap. Borrowed aliases and indexed-place overlap are subject to the more general loan
and place rules in Batch 2.

**Diagnostics:** A replacement that consumes its destination reports `OWN0004` at the assignment
and identifies the overlapping source place.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[overlapping replacement test](../../../../packages/compiler/test/MutableLoops.test.ts).

### OWN-007 — Array ownership derives from the element type

**Status:** Confirmed

`[T; N]` is Copy when `T` is Copy. If `T` is affine, the array is one affine owner regardless of
its length. A whole-array move transfers every element together.

```silk
fn copy(values: [i32; 2]) -> i32 {
  let again = values
  return values[0] + again[1]
}
```

An array of affine values can expose Copy leaves without being consumed. A known index may move
one initialized element under OWN-004; a dynamic index cannot:

```silk,ignore
struct Token { kind: i32 }

fn invalid(tokens: [Token; 2], index: usize) -> Token {
  return move tokens[index]
}
```

A complete `move tokens` or a known-index extraction such as `move tokens[0]` is valid when its
accessed storage is initialized. A mutable array may restore that element under OWN-005.

**Boundary:** `[Token; 0]` remains affine because ownership is derived uniformly from `Token`, not
special-cased by the runtime element count. This keeps generic ownership independent of a particular
length value, but it is an explicit stabilization choice to review.

**Diagnostics:** Moving an element at a dynamic index reports `OWN0002`. Passing, returning, or binding
an affine array by value without `move` reports `OWN0003`.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[fixed-array ownership tests](../../../../packages/compiler/test/FixedArraySemantics.test.ts).

### OWN-008 — Union ownership derives from every alternative

**Status:** Confirmed

A union is Copy only when every alternative is Copy and cleanup-free. Otherwise it is one affine
owner, regardless of which alternative is currently active.

```silk
struct Token { kind: i32 }
struct End {}

fn widen(token: Token) -> Token | End {
  return move token
}
```

Injecting an affine value into a union transfers its ownership into the union. Widening an affine
union into a larger union likewise transfers the one active value; it does not duplicate or expose
the payload.

**Boundary:** The compiler does not refine the ownership mode of a union from its runtime tag. A
`Token | i32` value is affine even while it contains `i32`, because a binding's ownership rules must
remain valid before its active alternative is inspected. A consuming match is the operation that
can transfer the selected payload under Batch 3's rules.

**Diagnostics:** An implicit by-value transfer of an affine union reports `OWN0003`; a later use
after moving the union reports `OWN0001`. Invalid extraction of a non-Copy active payload is handled
as an aggregate partial move rather than an implicit runtime copy.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[exhaustive-match tests](../../../../packages/compiler/test/ExhaustiveMatching.test.ts).

## Batch 2 — Borrowed access

### BORROW-001 — A shared borrow grants temporary read access

**Status:** Confirmed

`&place` creates shared access to a place without transferring ownership. Any number of compatible
shared borrows may coexist. The borrowed value may be read, and Copy values may be copied from it.

```silk
struct Counter { value: i32 }

fn peek(counter: &Counter) -> i32 {
  return counter.value
}

pub fn main() -> i32 {
  let counter = Counter { value: 42 }
  return peek(&counter) + peek(&counter) - 42
}
```

While a shared loan is active, the borrowed place may not be mutated, moved, dropped, or borrowed
exclusively. Compatible reads and additional shared borrows remain valid.

**Boundary:** A shared reference does not own its referent and does not become responsible for its
cleanup. Reading a Copy field through `&T` copies only that field; it does not copy the complete `T`.

**Diagnostics:** Assignment through a shared reference reports `SEM0036`. A conflicting exclusive
loan reports `OWN0010` for slices. Moving or dropping an owner while a longer shared loan is active
reports `OWN0011` and relates the loan's origin.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[reference projection tests](../../../../packages/compiler/test/ReferenceProjection.test.ts),
[slice ownership tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts).

### BORROW-002 — An exclusive borrow grants temporary sole access

**Status:** Confirmed

`&mut place` creates exclusive access. The root owner must be mutable, and no other read, write,
borrow, move, or drop of the borrowed place may overlap the exclusive loan.

```silk
struct Counter { value: i32 }

fn bump(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}

pub fn main() -> i32 {
  let mut counter = Counter { value: 40 }
  let first = bump(&mut counter)
  return bump(&mut counter)
}
```

The first loan ends when the first call returns, so the second exclusive borrow is valid.

**Boundary:** `let mut` permits an owner to be borrowed exclusively; it does not itself create a
borrow. An exclusive reference may read and replace values through its place, but it still may not
move an affine field out of borrowed storage. The holder of `&mut T` may read through that
reference; only independent access paths are excluded. An exclusive loan is active as soon as it is
formed rather than having a separate reserved-but-not-yet-active phase.

**Diagnostics:** Creating an exclusive slice borrow from an immutable root reports `SEM0057`.
Overlapping an exclusive slice loan with any other loan reports `OWN0010`. Direct owner access while
an exclusive loan remains active reports `OWN0011`.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[reference projection tests](../../../../packages/compiler/test/ReferenceProjection.test.ts),
[slice ownership tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts).

### BORROW-003 — A borrow preserves the original owner

**Status:** Confirmed

Borrowing does not consume, copy, or transfer the borrowed value. The original owner remains
responsible for the value and becomes fully available again when the loan ends.

```silk
struct Token { kind: i32 }

fn inspect(token: &Token) -> i32 { return token.kind }
fn consume(token: Token) -> i32 { return token.kind }

fn inspectThenConsume(token: Token) -> i32 {
  let kind = inspect(&token)
  return kind + consume(move token)
}
```

The call to `inspect` does not change ownership of `token`. Its shared loan ends when the call
returns, so the following whole-value move is valid.

**Boundary:** The owner cannot be moved or cleaned while a loan that still refers to it is active.
Ending a loan does not create a new owner; it only removes the temporary access restriction from the
existing owner.

**Diagnostics:** Moving through borrowed storage reports `OWN0012` for a borrowed slice element.
Moving or dropping the root owner while a longer loan is active reports `OWN0011`.

**Evidence:** [slice ownership tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts).

### BORROW-004 — Call arguments borrow for the complete call

**Status:** Confirmed

A borrow created as an ordinary function argument begins when that argument is evaluated and remains
active until the call returns. All argument accesses must therefore be mutually compatible for the
complete call.

Two shared borrows of the same owner are valid:

```silk
fn compare(left: &[i32], right: &[i32]) -> i32 { return 1 }

fn valid() -> i32 {
  let values = [1, 2, 3]
  return compare(&values, &values)
}
```

A shared and exclusive borrow of the same owner are not:

```silk,ignore
fn mixed(left: &[i32], right: &mut [i32]) -> i32 { return 1 }

fn invalid() -> i32 {
  let mut values = [1, 2, 3]
  return mixed(&values, &mut values)
}
```

**Boundary:** Later arguments cannot access an owner already borrowed exclusively by an earlier
argument. Argument evaluation order does not shorten an earlier loan to the end of that argument's
evaluation; the callee receives all arguments together.

Reading `.length` of any place while an exclusive loan of it is live is an access, whether the
place is a fixed-size array, a slice or a `Vector`, even though a fixed array's length is part of
its type. For `values: [i32; 2]`, `replace(&mut values, values.length - 1)` reports `OWN0011` at
the length read and relates the first argument's loan. Bind the length before the call instead:
`let last = values.length - 1` and then `replace(&mut values, last)`.

**Diagnostics:** Conflicting slice arguments report `OWN0010` at the later borrow and relate the
earlier loan. Directly reading the owner in a later argument while an exclusive loan is active
reports `OWN0011`.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[slice ownership tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts).

### BORROW-005 — Reborrowing temporarily suspends stronger parent access

**Status:** Confirmed

A shared reference or slice may be reborrowed only as shared. An exclusive reference or slice may be
reborrowed as shared or exclusive. The parent access is suspended for the nested call and restored
when the reborrow ends.

```silk
fn read(values: &[i32]) -> i32 { return 1 }
fn edit(values: &mut [i32]) -> i32 { return 2 }

fn inspectThroughExclusive(values: &mut [i32]) -> i32 {
  return read(&values)
}

fn forwardExclusive(values: &mut [i32]) -> i32 {
  return edit(&mut values)
}
```

An exclusive parent cannot be used through the parent parameter during a child reborrow. Once the
child call returns, the parent becomes available with its original access.

**Boundary:** Reborrowing never strengthens access. `&mut values` is invalid when `values` is only
`&[T]`. An exclusive reference is not copied when forwarded; the nested call receives a temporary
exclusive reborrow. Forwarding an exclusive reference is written `&mut values`; passing the binding
by value without `move` reports `OWN0003`.

**Diagnostics:** Attempting to strengthen a shared slice into an exclusive reborrow reports
`SEM0058`. Accessing a suspended parent during a child loan reports the applicable loan conflict.

**Evidence:** [runtime-slice specification](../../../../openspec/specs/bootstrap-runtime-slices/spec.md),
[slice semantics tests](../../../../packages/compiler/test/RuntimeSliceSemantics.test.ts),
[slice ownership tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts).

### BORROW-006 — A borrow requires an owner, not a source-level name

**Status:** Confirmed

Borrowing an existing place ties the loan to that place's root owner. Valid places include live
locals, pattern bindings, borrowed parameters, nominal field projections, and indexed projections.
The reference retains its projection path and accesses the original storage rather than copying the
projected value. When the compiler cannot prove indexed places disjoint, it may conservatively treat
their complete root as borrowed.

Borrowing an owned temporary creates a hidden owner. The compiler keeps that owner live for the
complete lifetime of every view derived from the borrow, then cleans it under the ordinary ownership
rules.

```silk
fn read(values: &[i32]) -> i32 { return 1 }

fn valid() -> i32 {
  return read(&[1, 2])
}
```

The array temporary remains live through `read` and is cleaned after the call. `&mut [1, 2]` may
similarly create a mutable hidden owner; mutations are discarded when that owner is cleaned.

Fixed arrays do not decay to slices implicitly. The borrow must be explicit:

```silk
fn read(values: &[i32]) -> i32 { return 1 }

fn valid() -> i32 {
  let values = [1, 2]
  return read(&values)
}
```

**Boundary:** `&array` creates a shared slice only when the expected parameter type is `&[T]`;
`&mut array` analogously creates `&mut [T]`. The array length is not part of the resulting slice
type.

A local view may also extend a hidden temporary owner's lifetime:

```silk
fn identity(values: &[i32]) -> &[i32] { return values }

fn useTemporary() -> i32 {
  let view = identity(&[1, 2])
  return view[0]
}
```

This has the same ownership behavior as borrowing a named local. A borrowed array evaluated in a
binding initializer receives a hidden local owner in the originating block, selected branch, or
loop iteration. Its producer runs exactly once at its original evaluation point, preserving earlier
argument effects and ordinary element inference. An uncontextualized `[1, 2]` still has `i32`
elements.

The owner remains live through dependent views and lifetime-bearing aggregates, including a holder
returned by `SliceStream.make(&[1, 2])`. It survives suspension while a dependent value remains live.
Ordinary cleanup ends the dependent loans before cleaning the backing storage, including affine
elements, on normal completion, early structured exits and interruption. Each loop iteration owns
and cleans its own storage. Fatal traps retain their existing no-unwind behavior.

Storage in an aggregate or capture by an Effect does not detach the view. Returning any such value
from the function is rejected when it retains the function-local hidden storage.

**Diagnostics:** Forming an exclusive borrow from an immutable existing root reports `SEM0057`.
Passing a fixed array directly where a slice is expected reports `SEM0059` and requires an explicit
borrow. A temporary-derived view that escapes its hidden owner reports the applicable returned-view
or stored-borrow diagnostic at the escape boundary.

The compiler materializes temporary owners and retains indexed-place selectors through TIR and MIR.
`SEM0056` remains appropriate only for operands that cannot denote or produce owned storage.

**Evidence:** [runtime-slice specification](../../../../openspec/specs/bootstrap-runtime-slices/spec.md),
[slice semantics tests](../../../../packages/compiler/test/RuntimeSliceSemantics.test.ts).

### BORROW-007 — Borrowed projections preserve their access mode

**Status:** Confirmed

Projecting a field or indexing a slice produces another borrowed place with the same access mode.
A Copy leaf may be read through either shared or exclusive access. Mutation requires exclusive
access and replaces a complete value in the borrowed place.

```silk
struct Token { kind: i32 }

fn inspect(values: &[Token], index: usize) -> i32 {
  return values[index].kind
}

fn replace(values: &mut [Token], index: usize) -> i32 {
  values[index] = Token { kind: 42 }
  return values[index].kind
}
```

Neither shared nor exclusive access permits moving an affine field or element out of borrowed
storage. The original owner must remain complete and responsible for its cleanup.

**Boundary:** Exclusive replacement is valid because it leaves the borrowed place completely
initialized and cleans the displaced value exactly once. It does not transfer ownership of the
backing aggregate to the borrower.

**Diagnostics:** Mutation through shared access reports `SEM0036`. Moving a non-Copy slice element
reports `OWN0012`; moving a non-Copy field through an ordinary reference currently reports the
aggregate partial-move diagnostic `OWN0002`.

**Evidence:** [runtime-slice specification](../../../../openspec/specs/bootstrap-runtime-slices/spec.md),
[reference projection tests](../../../../packages/compiler/test/ReferenceProjection.test.ts),
[slice ownership tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts).

### BORROW-008 — Ordinary values retain their borrowed contents

**Status:** Confirmed

Shared references, shared slices, and strings may appear in generic arguments, named or synthesized
aggregate fields, fixed arrays, and ordinary unions. Their containing values retain the declared
lifetimes and the concrete loans needed by later uses and cleanup.

```silk
struct View<'data> { value: &'data i32 }

fn wrap<'data>(value: &'data i32) -> View<'data> {
  return View<'data> { value: value }
}
```

Moving the wrapper transfers its dependencies; it does not move its external referent. Copying an
eligible shared view retains another dependent use rather than detaching the source. A Copy
aggregate still needs an admitted `impl Copy`, and every realized field must satisfy that property.

**Boundary:** Moving an owner together with a reference into its own inline storage does not create
a valid self-referential value. Exclusive borrowed storage remains affine, and a user `Drop` hook
requires every observable borrowed component to remain valid through its invocation. Generic
recursive cleanup keeps the same conservative obligation without inspecting hook bodies.
Effect success and failure channels
cannot yet carry dependent borrowed values. Callable and Effect environments retain their explicit
environment bounds even when their public result channels contain no references.

**Diagnostics:** Invalid validity escape reports `OWN0019` at the violating use or retention
boundary. Conflicting access during a retained loan reports `OWN0010` or `OWN0011`.
Named lifetime and elision failures follow [the lifetime reference](lifetimes.md).

**Evidence:** [lifetime requirements](../../../../openspec/specs/bootstrap-lifetimes/spec.md),
[lifetime tests](../../../../packages/compiler/test/Type.test.ts).

### BORROW-009 — Slice length is runtime information

**Status:** Confirmed

`&[T]` and `&mut [T]` identify the element type and access mode, but not the source array's length.
Arrays of different lengths may therefore be passed to the same slice parameter.

`values.length` has type `usize`. Indexing checks `index < values.length` before accessing the
element. An out-of-bounds access traps; an out-of-bounds assignment traps before evaluating its
replacement expression.

**Boundary:** Zero-length slices and slices of zero-sized elements retain their logical lengths.
Slice indexing never permits moving a non-Copy element out of borrowed storage; BORROW-007 still
applies after the bounds check.

**Diagnostics:** An invalid static index type is a semantic type error. A runtime out-of-bounds
index traps rather than entering the typed failure channel. Borrow and ownership violations are
reported statically before bounds behavior is relevant.

**Evidence:** [runtime-slice specification](../../../../openspec/specs/bootstrap-runtime-slices/spec.md),
[slice semantic tests](../../../../packages/compiler/test/RuntimeSliceSemantics.test.ts).

## Batch 3 — Boundaries and control flow

### CALL-001 — Parameter types determine ownership transfer or borrowing

**Status:** Confirmed

A plain parameter `value: T` receives a value by value. Passing a Copy argument copies it. Passing
an affine argument transfers ownership to the parameter and therefore requires `move` at the call
site.

```silk
struct Token { kind: i32 }

fn consume(token: Token) -> i32 { return token.kind }

fn call(token: Token) -> i32 {
  return consume(move token)
}
```

The callee owns an affine by-value parameter and cleans it if the body does not transfer or drop it.
A reference parameter `&T` or `&mut T` borrows instead and never becomes the owner of its referent.

```silk
struct Token { kind: i32 }

fn inspect(token: &Token) -> i32 { return token.kind }

fn callBorrowed(token: Token) -> i32 {
  let result = inspect(&token)
  return result + token.kind
}
```

**Boundary:** Plain parameter syntax does not imply an invisible move. The declaration defines a
by-value boundary, but each affine caller still writes `move` to transfer its particular source
binding. Fresh literals and newly returned values already produce new owners and do not require a
source-binding move.

**Diagnostics:** Passing an affine binding to a by-value parameter without `move` reports `OWN0003`.
Using the caller's binding after a valid transfer reports `OWN0001`. Borrow arguments use the
BORROW-001 through BORROW-008 diagnostics instead.

**Evidence:** [ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### CALL-002 — An owned return transfers a value to the caller

**Status:** Confirmed

Returning an affine local or parameter transfers ownership out of the function. The returned value
becomes a new owner in the caller, and the source binding is not cleaned in the callee.

```silk
struct Token { kind: i32 }

fn identity(token: Token) -> Token {
  return move token
}

fn use(token: Token) -> i32 {
  let returned = identity(move token)
  return returned.kind
}
```

Returning a freshly constructed affine value needs no `move` because no existing source binding is
being consumed:

```silk
struct Token { kind: i32 }

fn makeToken() -> Token {
  return Token { kind: 42 }
}
```

**Boundary:** This rule covers owned result types. Returning a reference or slice does not transfer
ownership; its validity depends on provenance from an owner outside the returning function and is
defined in the returned-view batch.

**Diagnostics:** Returning an affine binding without `move` reports `OWN0003`. A later use of a
binding explicitly returned by move reports `OWN0001`. Returning a borrowed view from a local owner
reports the returned-view origin or escape diagnostic instead.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[generic identity tests](../../../../packages/compiler/test/TypeGenerics.test.ts).

### FLOW-001 — Ownership is valid on every path that reaches an operation

**Status:** Confirmed

Silk tracks ownership independently along structured control-flow paths. A binding may be used after
a branch only when it is live and completely initialized on every path that reaches that use.

A move in a branch that immediately returns does not consume the owner on the remaining path:

```silk
struct Token { kind: i32 }

fn consume(token: Token) -> i32 { return token.kind }

fn choose(token: Token, consumeNow: bool) -> i32 {
  if consumeNow {
    return consume(move token)
  }
  return token.kind
}
```

If the moving path reaches the later use, the program is invalid:

```silk,ignore
struct Token { kind: i32 }

fn consume(token: Token) -> i32 { return token.kind }

fn invalid(token: Token, consumeNow: bool) -> i32 {
  if consumeNow {
    let consumed = consume(move token)
  }
  return token.kind
}
```

**Boundary:** A complete replacement may restore moved mutable storage before paths join.
Initializedness is joined independently for each place. Differing branches may leave a root or
field conditionally initialized; disjoint initialized siblings remain available, and later cleanup
visits only the live remainder on the executed path.

**Diagnostics:** A use requiring a complete value reports `OWN0001` when any reaching path leaves
its accessed place uninitialized, and relates the consuming move. A join with no invalid subsequent
use does not itself report an ownership error. Branch-local
bindings are unavailable outside their declared region and use the ordinary name or scope
diagnostic rather than an ownership merge error.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[branch ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### MATCH-001 — A match declares how it accesses its scrutinee

**Status:** Confirmed

The match prefix selects ownership access:

- `match value` reads a Copy scrutinee.
- `match move value` consumes an affine or Copy scrutinee.
- `match &value` holds one shared loan through the selected arm.
- `match &mut value` holds one exclusive loan through the selected arm and requires a mutable place.
- `match place value` reads an owned place's discriminant without borrowing or consuming its payload.
  Its arm bindings denote refined places; explicit moves may extract initialized fields after a
  guard succeeds. Variant proof ends with the arm and must be re-established after a join.

```silk
struct Token { kind: i32 }
struct End {}

fn inspect(event: Token | End) -> i32 {
  let code = match &event {
    Token { kind } => kind
    End {} => 0
  }
  return code
}
```

A shared or exclusive match leaves the source owner live after the selected arm ends. A consuming
match makes the source unavailable and transfers its active payload into exactly one selected arm.

**Boundary:** Borrowed match modes require a borrowable place. They cannot borrow an expression that
has no owner or hidden owner satisfying BORROW-006. Bare match syntax never implicitly consumes an
affine scrutinee. Complete copy, consuming, and borrowed matches require initialized scrutinees;
`match place` may inspect the tag of a partial owner without reading its missing payload.

**Diagnostics:** A bare affine match reports `OWN0003`. An exclusive match of an immutable root
reports `OWN0007`. An invalid borrowed scrutinee place reports `OWN0009`. Using a source after
`match move` reports `OWN0001`.

**Evidence:** [exhaustive matching tests](../../../../packages/compiler/test/ExhaustiveMatching.test.ts).

### MATCH-002 — Pattern bindings inherit the selected match ownership

**Status:** Confirmed

In a borrowed match, pattern bindings are borrowed projections valid only within their selected arm.
Copy leaves may be read, but an affine borrowed payload cannot be consumed or escape the arm.
An exclusive binding mutates the original selected payload. A scoped call or Effect capture retains
that same referent across suspension, so moving the owner after the match preserves those mutations.

In a consuming match, the complete active payload enters the selected arm. Bound non-Copy fields
become arm-local owners. Copy fields are ordinary Copy bindings. Fields omitted with `..` remain
owned cleanup obligations of that arm.

```silk
struct Payload { value: i32 }
struct Box {
  payload: Payload
  code: i32
}

fn take(box: Box) -> Payload {
  return match move box {
    Box { payload, .. } => move payload
  }
}
```

Pattern bindings in a guarded consuming arm remain provisional until the guard succeeds. A guard
may inspect them but cannot move, drop, or otherwise consume them, because a later arm must still be
able to receive the unchanged payload when the guard is false.

**Boundary:** Complete consuming destructuring is not a partial move under OWN-004. The source owner
has already entered the match, and exactly one selected arm receives or cleans each active field.

**Diagnostics:** Escaping an affine binding from a borrowed pattern reports `OWN0006`. Consuming a
provisional guarded binding reports `OWN0008`. A later use of the complete consumed scrutinee reports
`OWN0001`.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[exhaustive matching tests](../../../../packages/compiler/test/ExhaustiveMatching.test.ts).

### LOOP-001 — Every repeating path must restore a compatible ownership state

**Status:** Confirmed

A loop may repeat only when every path reaching the next iteration agrees on which outer bindings
are live and completely initialized. Moving a mutable owner during one iteration is valid only when
that path assigns a complete replacement before it continues.

```silk
struct Token { kind: i32 }

fn consume(token: Token) -> i32 { return token.kind }

fn repeat(token: Token, again: bool) -> i32 {
  let mut current = move token
  while again {
    let consumed = consume(move current)
    current = Token { kind: consumed }
    continue
  }
  return current.kind
}
```

A path may move an owner and then `break` or `return` because it does not re-enter the loop. Whether
the owner is usable after the loop still depends on every path that reaches that later use.

**Boundary:** The loop-header baseline is the ownership state before the condition runs, because the
condition is evaluated again on every iteration. A condition that consumes an outer owner therefore
cannot silently establish a weaker repeating state. Reassigning only one field after moving the
complete owner does not restore it. The replacement must initialize the complete binding under
OWN-005. Loans created inside an iteration must also end or have one compatible continuing state
before the next iteration.

**Diagnostics:** A repeating path that reaches the loop header with an owner missing or
incompatibly borrowed reports `OWN0005`. A direct later use after an unconditional move reports the
ordinary `OWN0001` use-after-move diagnostic.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[mutable-loop tests](../../../../packages/compiler/test/MutableLoops.test.ts),
[ownership regression tests](../../../../packages/compiler/test/Ownership.test.ts).

### GENERIC-001 — Unconstrained type parameters may be affine

**Status:** Confirmed

A generic body is checked without assuming that an unconstrained type parameter is Copy. Whole-value
transfer therefore uses `move` and remains valid when specialized with either Copy or affine types.

```silk
fn identity<T>(value: T) -> T {
  return move value
}
```

An operation that duplicates `T` requires the sealed Copy constraint:

```silk
fn duplicate<T: Copy>(value: T) -> [T; 2] {
  return [value, value]
}
```

Ownership is checked once against the generic contract. Each specialization substitutes its
concrete Copy and cleanup properties without changing what the source body was permitted to do.

**Boundary:** A specialization with `T = i32` does not retroactively make an unconstrained body
valid if that body attempted to copy `T`. Concrete-only behavior must be expressed by an applicable
constraint or a separately specialized interface operation.

**Diagnostics:** An implicit duplicate or by-value read of unconstrained `T` reports the ownership
error applicable to a potentially affine value. A concrete type that does not satisfy `T: Copy`
reports a constraint error at specialization. Stable diagnostics for the accepted sealed Copy
constraint remain to be assigned with `impl Copy` implementation.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[type-generic tests](../../../../packages/compiler/test/TypeGenerics.test.ts).

### PIPE-001 — A pipeline applies ordinary leading-parameter ownership

**Status:** Confirmed

`value |> operation` evaluates `value` exactly once, then supplies it as the operation's leading
argument. That parameter's ordinary by-value, shared-borrow, or exclusive-borrow contract determines
what happens to the pipeline input.

```silk
struct Token { value: i32 }

fn consume(token: Token, adjustment: i32) -> i32 {
  return token.value + adjustment
}

fn adjusted(token: Token) -> i32 {
  return move token |> consume(2)
}
```

The explicit `move` consumes `token` exactly once. A pipeline into a borrowed leading parameter must
similarly provide the appropriate explicit borrow. Pipeline syntax does not add, remove, or infer an
ownership conversion.

A returned borrowed view carries the same source root through a pipeline as through a direct call.
For an exact callable section, that source may be either the newly supplied leading argument or one
known trailing capture. An opaque callable contract does not guess which captured value backs the
result.

**Boundary:** The left expression evaluates before the callable or leading-argument section on the
right is constructed or accessed. Pipelines associate left-to-right, and each stage applies the
next operation's ordinary parameter contract to the previous stage's result.

**Diagnostics:** Reusing an affine source after piping it by move reports `OWN0001`. Omitting the
required move reports `OWN0003`. Borrow conflicts are the same as the equivalent direct call.

**Evidence:** [callable specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[pipeline ownership tests](../../../../packages/compiler/test/Ownership.test.ts),
[operator pipeline tests](../../../../packages/compiler/test/OperatorPipeline.test.ts).

## Batch 4 — Captured ownership

### CAPTURE-001 — Delayed values acquire their captures when constructed

**Status:** Confirmed

Constructing a callable or Effect retains everything it will need when invoked or run later. The
body remains delayed, but capture ownership and loans begin at construction rather than waiting for
execution.

Automatic leading-argument sections are the simplest form of callable construction:

```silk
fn add(a: i32, b: i32) -> i32 { return a + b }

fn example() -> i32 {
  let addTwo = add(2)
  return addTwo(40)
}
```

`add(2)` constructs a unary callable awaiting `a`. It captures the supplied trailing argument
`b = 2` immediately. Invoking `addTwo(40)` later evaluates `add(40, 2)` and returns `42`.

```silk
struct Token { value: i32 }

fn addToken(value: i32, token: Token) -> i32 {
  return value + token.value
}

fn prepare(token: Token) -> once fn(i32) -> i32 {
  return addToken(move token)
}
```

`addToken(move token)` constructs a leading-argument section. Construction transfers `token` into
the callable environment immediately; invoking the returned callable later supplies `value` and
consumes the captured `Token`.

An Effect block follows the same timing:

```silk
struct Token { value: i32 }

fn prepareEffect(token: Token) -> once Effect<Token> {
  return effect {
    return move token
  }
}
```

The Effect body does not run during construction, but `token` must enter the Effect environment then
so the outer binding cannot be moved, dropped, or changed before the deferred body uses it.

**Boundary:** Eager expressions outside an `effect` block execute before the Effect is constructed,
as defined by EFF-005. This rule covers the ownership of values retained for delayed execution; it
does not make the delayed body eager.

**Diagnostics:** Reusing an affine source after it was moved into a delayed environment reports
`OWN0001`. Omitting `move` when construction must retain an affine value by ownership reports
`OWN0003`. An invalid borrow escape reports the capture boundary's loan diagnostic.

**Evidence:** [callable specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[Effect execution rules](effects-and-execution.md#eff-005--an-ordinary-function-can-construct-a-deferred-effect).

### CAPTURE-002 — Captures use ordinary Copy, borrow, and move rules

**Status:** Confirmed

The source access used to construct a delayed value determines each capture:

- A Copy read captures an independent snapshot.
- `&place` captures a shared loan.
- `&mut place` captures an exclusive loan.
- `move value` transfers ownership into the environment.

```silk
fn select(value: i32, values: &mut [i32]) -> i32 {
  return value + values[0]
}

fn prepare(values: &mut [i32]) -> mut fn(i32) -> i32 {
  return select(&mut values)
}
```

The returned callable retains an exclusive reborrow of `values`. The parent access remains
suspended for as long as that callable can still be invoked.

**Boundary:** Capture does not create a separate ownership system. A captured owner is an affine
field of the hidden environment, and a captured borrow remains tied to its root owner. Copying a
Copy capture does not make an affine environment Copy when another capture prevents it.

**Diagnostics:** Conflicting use of a capture's root while its loan is retained reports `OWN0011`.
Moving a captured source twice reports `OWN0001`. Capture types incompatible with an explicitly
declared callable or Effect access contract report that contract mismatch at construction.

**Evidence:** [callable specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[callable ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### ANON-OWN-001 — Anonymous captures determine environment ownership and invocation mode

**Status:** Confirmed

An anonymous callable captures references to the nearest visible outer local or parameter
implicitly. Its own parameters, locals, pattern bindings, module declarations, and type names are
not captures. Each outer binding is captured once, in the order of its first reference in the body,
even when later references use it again.

The body operation determines both capture access and the callable's strongest invocation mode:

| Body access to an outer binding       | Environment capture | Derived mode |
| ------------------------------------- | ------------------- | ------------ |
| Copy read or move of a Copy value     | Copy snapshot       | `fn`         |
| Shared read through a borrowed value  | shared loan         | `fn`         |
| Mutation or exclusive borrowed access | exclusive loan      | `mut fn`     |
| Move of an affine owner               | ownership transfer  | `once fn`    |

```silk
struct Token { value: i32 }

fn prepare(token: Token) -> once fn() -> Token {
  return fn() -> Token { return move token }
}
```

The source constructs the callable with `fn`, while the move of `token` derives the resulting
`once fn() -> Token` type. There is no explicit anonymous `once fn` construction spelling.

Construction acquires every capture exactly once in first-reference order. Borrowed captures keep
their loans live for as long as the callable may still use them and cannot escape their roots.
Dropping an uninvoked environment releases loans and cleans owned captures exactly once in reverse
acquisition order. A consuming invocation transfers or cleans every owned capture exactly once; a
second invocation cannot duplicate the environment.

**Boundary:** Invocation mode describes access to the retained environment, not ownership of newly
supplied arguments. Copy moves remain reusable. A shared anonymous callable may satisfy a `mut fn`
or `once fn` requirement, and a `mut fn` may satisfy a `once fn` requirement; the reverse
substitutions are invalid. Anonymous captures use the same escape, storage, and cleanup rules as
other exact callable environments.

**Diagnostics:** Conflicting access to a captured root reports the ordinary retained-loan
diagnostic. A borrowed environment that escapes its root reports an ownership escape. Invoking a
consuming anonymous callable twice reports use after move, and supplying a derived consuming or
exclusive mode where shared reusable access is required reports a callable-contract mismatch.

**Evidence:** [anonymous ownership specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-ownership/spec.md),
[anonymous semantic-fact specification](../../../../openspec/changes/add-anonymous-callable-expressions/specs/bootstrap-semantic-facts/spec.md).

### CALLABLE-001 — Named functions support trailing partial application

**Status:** Confirmed

A named function is a callable value. Calling an `N`-parameter function with `K` arguments has the
following behavior:

- `K = N` invokes the function.
- `0 < K < N` captures the supplied arguments as a contiguous trailing suffix and returns a
  callable awaiting the leading `N - K` parameters.
- `K > N` is an arity error.

A nonzero-parameter function is referenced by name when no arguments are supplied. An empty call
does not create a redundant partial application.

```silk
fn add(a: i32, b: i32) -> i32 { return a + b }

fn example() -> i32 {
  let addTwo = add(2)
  return addTwo(40) // add(40, 2)
}
```

Partial application may leave more than one leading parameter:

```silk
fn combine(a: i32, b: i32, c: i32) -> i32 { return a + b + c }

fn example() -> i32 {
  let withThree = combine(3)
  return withThree(1, 2) // combine(1, 2, 3)
}
```

The resulting callable supports the same trailing partial-application rule, so applications may be
staged further:

```silk
fn combine(a: i32, b: i32, c: i32) -> i32 { return a + b + c }

fn staged() -> i32 {
  let withThree = combine(3)
  let withTwoAndThree = withThree(2)
  return withTwoAndThree(1) // combine(1, 2, 3)
}
```

This is trailing partial application rather than arbitrary argument binding. Every application
binds a contiguous suffix of the parameters that remain. It cannot leave holes, bind a leading
parameter while omitting a later one, or reorder parameters. Because Silk binds trailing arguments,
`combine(3)(2)(1)` invokes `combine(1, 2, 3)`.

**Boundary:** Section construction evaluates and captures the supplied trailing arguments from
left to right under CAPTURE-001 and CAPTURE-002. The later invocation applies the ordinary
ownership contracts of the leading parameter and the stored trailing parameters. Pipeline syntax
may supply the missing leading argument, but it does not change section formation.

**Diagnostics:** Supplying too many arguments reports the ordinary arity diagnostic. Using a
partially applied callable where a non-callable result is required reports a type mismatch that
identifies the remaining callable parameters. A supplied argument with the wrong type reports its
ordinary argument-type diagnostic. Invalid ownership at construction reports the corresponding
move or borrow diagnostic.

The compiler represents the complete ordered remaining-parameter prefix and captured trailing
suffix. Successive direct stages retain capture evaluation order while invocation orders values by
their original parameter positions.

**Evidence:** [indirect-call acceptance tests](../../../../packages/compiler/test/IndirectCallAcceptance.test.ts),
[operator pipeline tests](../../../../packages/compiler/test/OperatorPipeline.test.ts).

### CALLABLE-002 — Invocation mode derives from access to the callable environment

**Status:** Confirmed

Callable types distinguish three invocation modes:

- `fn(A) -> B` uses shared access and may be invoked repeatedly.
- `mut fn(A) -> B` uses exclusive access and may be invoked repeatedly in sequence.
- `once fn(A) -> B` consumes its environment and may be invoked once.

A Copy-only or shared-read capture can produce `fn`. A callable that mutates its environment or uses
an exclusive captured loan requires `mut fn`. An invocation that moves or otherwise consumes an
owned capture requires `once fn`.

Invocation mode describes access to previously captured state. It does not change the ownership
contract of arguments newly supplied to each invocation.

**Boundary:** A callable offering more reuse may satisfy a weaker usage promise:

- `fn` may be used where `fn`, `mut fn`, or `once fn` is required.
- `mut fn` may be used where `mut fn` or `once fn` is required.
- `once fn` may be used only where `once fn` is required.

A parameter of type `once fn` promises to invoke its argument at most once; it does not require the
argument itself to be inherently take-once.

**Diagnostics:** Calling a `once fn` a second time reports `OWN0001` at the second invocation.
Supplying a consuming or exclusive callable where a reusable shared callable is required reports a
callable-contract mismatch before lowering.

**Evidence:** [callable specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[indirect-call acceptance tests](../../../../packages/compiler/test/IndirectCallAcceptance.test.ts).

### CALLABLE-003 — A callable retains capture loans until its last use or drop

**Status:** Confirmed

A callable holding a shared or exclusive capture keeps that loan active while a future invocation
may still use it. The root owner remains restricted according to the captured access. The loan ends
after the callable's last invocation, when a consuming invocation takes it, or when the callable is
dropped without being invoked.

```silk
fn read(value: i32, values: &mut [i32]) -> i32 { return value + values[0] }

fn use(values: &mut [i32]) -> i32 {
  let mut callback = read(&mut values)
  let result = callback(41)
  drop callback
  values[0] = 1
  return result
}
```

The exclusive capture lasts through `callback(41)`. Explicitly dropping the callback releases the
capture and restores parent access before the following assignment. When the compiler can prove the
callback has no later use, its capture loan may end at that last use without requiring source-level
`drop`.

**Boundary:** A callable with a captured loan cannot escape its root owner. Moving the callable may
transfer the loan to another local or aggregate, but it does not detach the loan from its original
root. Dropping an uninvoked callable ends its loans and cleans its owned captures under Batch 5.

**Diagnostics:** Accessing a captured root while the callable may still use it reports `OWN0011`.
Invoking an exclusive callable through shared access reports the callable-access diagnostic.
Escaping the callable beyond a captured root reports an ownership escape at the boundary.

**Current compiler:** Aligned. Capture loans retained by callable sections end after a statically
proven last invocation or an explicit `drop`; Effect capture loans analogously end after their last
run. A later non-invocation use that may store, move, or escape the callable prevents the earlier
invocation from being treated as final.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[callable ownership tests](../../../../packages/compiler/test/Ownership.test.ts),
[callable loan last-use tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts).

### EFFECT-OWN-001 — Effect construction captures without executing

**Status:** Confirmed

Calling an `effect fn` or evaluating an `effect` block constructs an Effect environment without
running its body. Arguments and referenced outer values enter that environment using CAPTURE-002.

```silk
effect fn inspect(values: &[i32]) -> i32 {
  return values[0]
}

fn prepare(values: &[i32]) -> Effect<i32> {
  return inspect(&values)
}
```

`prepare` returns an Effect retaining a shared reborrow of `values`. No indexing occurs until the
Effect runs, but the loan must remain valid from construction through the Effect's last possible
run or drop.

Effect service provision follows the same rule. Providing `&clock`, `&mut logger`, or `move
provider` captures a shared loan, exclusive loan, or owner respectively; service providers do not
receive a separate ownership model.

**Boundary:** The Effect's success, failure, and requirement channels describe execution outcomes
and dependencies. They do not expose or replace the captured environment. Two Effects with the same
channels may still require different run access because their captures differ.

**Diagnostics:** Mutating, moving, or dropping a captured root while an Effect may still run reports
`OWN0011`. Reusing a source moved into an Effect reports `OWN0001`. A capture that would outlive its
root reports an ownership escape at Effect construction or transfer.

**Evidence:** [Effect execution rules](effects-and-execution.md),
[ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[Effect ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### EFFECT-OWN-002 — Run access derives from use of the Effect environment

**Status:** Confirmed

Effect values distinguish three run-access modes:

- `Effect<A ! E ? R>` runs through shared access and may be run repeatedly.
- `mut Effect<A ! E ? R>` runs through exclusive access and may be run repeatedly in sequence.
- `once Effect<A ! E ? R>` consumes its environment and may be run once.

A Copy-only or shared-read environment may be shared. An Effect that mutates captured state or uses
an exclusive capture requires exclusive run access. An Effect whose run moves or otherwise consumes
an owned capture requires take-once access.

```silk
struct Payload { value: i32 }

fn prepare(payload: Payload) -> once Effect<Payload> {
  return effect { return move payload }
}
```

The first `run` of the returned value consumes its environment. A second run is a use after move.

**Boundary:** Run access has the same admission ordering as callable invocation:

- `Effect` may satisfy `Effect`, `mut Effect`, or `once Effect`.
- `mut Effect` may satisfy `mut Effect` or `once Effect`.
- `once Effect` may satisfy only `once Effect`.

Running a take-once Effect consumes it automatically. Passing that Effect onward as an affine value
still requires an explicit `move` under CALL-001.

**Diagnostics:** Running a take-once Effect twice reports `OWN0001`. Running an exclusive Effect
through shared access or a take-once Effect through borrowed access reports the required run-access
diagnostic. A stored Effect uses `OWN0015` for an insufficient aggregate receiver.

**Evidence:** [nominal Effect storage specification](../../../../openspec/specs/bootstrap-nominal-effect-storage/spec.md),
[Effect ownership tests](../../../../packages/compiler/test/Ownership.test.ts),
[stored Effect ownership tests](../../../../packages/compiler/test/StoredEffectOwnership.test.ts).

### COMPOSE-001 — Composition preserves retained ownership obligations

**Status:** Confirmed

Higher-order functions and Effect helpers preserve the callable modes, Effect run access, owners,
and loans that the composed value retains for later execution. The result's access mode derives
from that retained environment under CAPTURE-002; helper names do not receive separate ownership
rules.

For example, a mapping operation that stores a take-once callback in its returned Effect produces a
take-once composition because the stored callback environment can be consumed only once. Capturing
an exclusive provider makes the composition require exclusive run access until that provider loan
ends.

A temporary callable or Effect constructed and completely consumed during one run does not by
itself constrain later runs. Its mode governs access to that temporary during the current run. The
surrounding composition is reusable when its retained environment can legally construct a fresh
temporary on every run.

`Effect.flatten` retains its outer Effect. During each flattened run, it runs that outer Effect and
then runs the inner Effect produced for that run. Flattening
`Effect<Effect<i32 ? &Clock> ? &Clock>` therefore produces `Effect<i32 ? &Clock>`: both layers are
shared reusable, and the duplicate `Clock` requirement normalizes independently of capture
ownership.

An inner `once Effect` does not automatically make the flattened result take-once when a reusable
outer Effect constructs a fresh inner value on every run. Conversely, a `flatten` signature that
captures its outer input as `once Effect` produces a take-once result because the retained outer
environment may be consumed only once.

**Boundary:** This behavior derives from ordinary function bodies and representation bounds rather
than from compiler recognition of helper names such as `map`, `flatten`, or `provideEffect`. A
source-defined combinator must preserve exactly the same obligations.

**Diagnostics:** Retaining a once callable while promising repeated invocation reports a
callable-contract mismatch. Running a composition more often or through weaker access than its
retained environment permits reports the corresponding `OWN0001`, callable-access, or Effect-access
diagnostic. A temporary value's stricter local mode does not produce a composition-level mismatch
when every execution constructs and consumes a fresh value legally.

**Evidence:** [callable specification](../../../../openspec/specs/bootstrap-callable-values/spec.md),
[Effect contract rules](effect-contracts.md),
[Effect ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### STORAGE-001 — Stored callables and Effects obey aggregate ownership

**Status:** Confirmed

A nominal value may store a concrete callable or Effect environment. The stored value retains its
captures, loans, invocation or run access, and cleanup obligations. The enclosing aggregate derives
Copy or affine ownership from those actual fields under OWN-001; storage does not create a separate
ownership category merely because a field is executable.

Access to the aggregate bounds access to its executable field:

- Shared aggregate access may invoke or run only shared reusable fields.
- Exclusive aggregate access may also invoke or run exclusive reusable fields.
- Whole-owner access may invoke or run any field, including a take-once field.

Take-once invocation consumes its complete executable value and transfers the environment.
Explicitly extracting an initialized field first follows OWN-004 and leaves its eligible enclosing
aggregate partial.

**Boundary:** Direct extraction of an affine callable or Effect field obeys the same verified
partial-move boundaries as an ordinary field under OWN-004. A Copy executable field may be read like any other Copy field. Compiler representation and
layout choices must not force an otherwise Copy, cleanup-free source value to become affine.

**Diagnostics:** Insufficient access to a stored callable reports `OWN0014`; insufficient access to
a stored Effect reports `OWN0015`. An extraction through a borrowed or whole-value Drop boundary reports `OWN0002`. Executable representation does not introduce another diagnostic or
ownership category.

**Evidence:** [nominal callable storage specification](../../../../openspec/specs/bootstrap-nominal-callable-storage/spec.md),
[nominal Effect storage specification](../../../../openspec/specs/bootstrap-nominal-effect-storage/spec.md),
[stored callable ownership tests](../../../../packages/compiler/test/StoredCallableOwnership.test.ts),
[stored Effect ownership tests](../../../../packages/compiler/test/StoredEffectOwnership.test.ts).

## Batch 5 — Cleanup and resource ownership

### CLEANUP-001 — Cleanup follows ownership

**Status:** Confirmed

Every live affine owner carries one cleanup obligation. Moving the value transfers that obligation
to the destination. Cleanup consumes the current owner exactly once when its ownership ends; a
moved source and a value already consumed by an operation receive no later cleanup.

Cleanup includes the complete value recursively: its restricted `Drop` hook when present, its
owned fields or active union payload, and any compiler-managed environment captures. A Copy value
has no cleanup behavior. An affine value with no cleanup-bearing contents still has one logical
ownership ending, but that cleanup emits no runtime work.

```silk
struct Resource {}

fn transfer(resource: Resource) -> Resource {
  let next = move resource
  return move next
}
```

The parameter owner transfers to `next`, then to the caller. Neither consumed source is cleaned;
the caller receives the single remaining obligation.

**Boundary:** Cleanup is ownership termination, not garbage collection. Reachability does not keep
an owner alive, and losing the last apparent reference does not trigger a separate tracing pass.
Replacement cleans the displaced value before the new value becomes the place's live obligation.

**Diagnostics:** Using, moving, or dropping an already cleaned owner reports `OWN0001` and relates
the earlier consuming operation. A path that could duplicate or omit an obligation is rejected by
the corresponding move, initialization, or control-flow ownership diagnostic.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### CLEANUP-002 — Structured exits clean every region they leave

**Status:** Confirmed

Lexical fallthrough, `return`, `break`, `continue`, and typed-failure propagation are structured
exits. Before control reaches the destination, every loan belonging to an exited region ends and
every live owner left in that region is cleaned.

Cleanup proceeds from the innermost exited region outward. Within one region, locals clean in
reverse acquisition order. A returned or failed value is moved to its destination first and is not
among the owners left behind.

```silk
struct Resource {}

fn choose(first: Resource, second: Resource) -> Resource {
  return move first
}
```

`first` transfers to the caller. `second` cleans before the function returns.

Aggregate cleanup is recursive and deterministic:

- A nominal value runs its restricted `Drop` hook first, then cleans fields in declaration order.
- An array cleans elements in ascending index order.
- A union cleans only its active payload.

**Boundary:** A `break` or `continue` cleans only the regions it leaves. Owners declared outside the
target loop remain live. Cleanup never invalidates a live borrow; the compiler ends applicable loans
first or rejects the exit when a surviving view would outlive its owner.

**Diagnostics:** A structured exit that would leave incompatible ownership states or invalidate a
surviving borrow reports the applicable ownership or borrow diagnostic. Valid cleanup ordering is
automatic and produces no source diagnostic.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[owned-allocation specification](../../../../openspec/specs/bootstrap-owned-allocation/spec.md),
[typed-failure cleanup](typed-failures.md#fail-006--typed-failure-applies-ordinary-cleanup-and-preserves-diagnostic-context).

### DROP-001 — `drop` cleans the live remainder of an owned place

**Status:** Confirmed

`drop value` ends `value`'s ownership at that statement and performs its ordinary cleanup there.
The binding is unavailable afterward and is omitted from automatic cleanup at the later region
exit.

```silk
struct Resource {}

fn finish(resource: Resource) -> () {
  drop resource
  return ()
}
```

`drop` is consuming even when its operand is Copy. Dropping a Copy value ends that binding without
emitting runtime cleanup, just as an explicit `move` of a Copy value still consumes its source.

**Boundary:** `drop place` is an explicit cleanup statement, so it may terminate a partial owner
and clean its initialized remainder. It does not pass an incomplete value to a generic function.
Cleanup of a projected owned place obeys the same borrowing and whole-value Drop boundaries as
OWN-004. An owner cannot be dropped while a live loan still depends on it.
The loan may end at its last use or through explicit cleanup of the value retaining it before the
owner is dropped.

**Diagnostics:** Any later use or second drop reports `OWN0001`. Dropping a projection across an unsupported extraction boundary reports `OWN0002`. Dropping a borrowed root while its loan remains live reports `OWN0011`.

**Evidence:** [owned-allocation specification](../../../../openspec/specs/bootstrap-owned-allocation/spec.md),
[Drop execution tests](../../../../packages/compiler/test/DropHookExecution.test.ts),
[ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### DROP-002 — A restricted `Drop` hook is automatic and infallible

**Status:** Confirmed

An affine nominal type may declare one restricted cleanup hook:

```silk
struct Guard { allocation: Allocation }

impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    return ()
  }
}
```

The hook runs automatically once before the value's fields are cleaned. It is not an ordinary
callable operation and cannot be invoked directly.

A valid hook is synchronous, infallible, non-allocating, and requirement-free. It receives
`&mut self`, cannot move or replace the complete `self`, and cannot let a borrow derived from
`self` escape. It may perform compiler-checked field replacement that leaves a valid whole value,
which permits containers to destroy initialized values hidden in raw storage before automatic field
cleanup releases that storage.

**Boundary:** A type with a `Drop` hook is affine and cannot implement `Copy`. The `Drop` head
gives each region position its own unbounded binder (IMPL-007), so the same hook runs for every
region a value carries. The hook cannot add a
typed failure, run an open Effect, acquire services, or perform asynchronous work. Cleanup that
needs any of those capabilities is an explicit operation under CLOSE-001.

**Diagnostics:** A duplicate or malformed `Drop` implementation, an invalid receiver or return
type, a failure or requirement channel, an Effect body, an illegal move from `self`, or an escaping
self-borrow reports `SEM0083` at the declaration or forbidden operation. Calling the hook by name is
rejected because it has no ordinary callable surface.

**Evidence:** [owned-allocation specification](../../../../openspec/specs/bootstrap-owned-allocation/spec.md),
[Drop declaration tests](../../../../packages/compiler/test/DeclarationIndex.test.ts),
[Drop execution tests](../../../../packages/compiler/test/DropHookExecution.test.ts).

### CLOSE-001 — Cleanup whose failure matters is an explicit operation

**Status:** Confirmed

Closing, flushing, committing, shutting down, or otherwise releasing a resource may be represented
by an ordinary consuming function or Effect when its outcome matters. Automatic cleanup and a
`Drop` hook remain infallible and cannot add failures to the surrounding control flow.

```silk
struct CloseError {}
struct Resource {}

effect fn close(resource: Resource) -> () ! CloseError {
  return ()
}

effect fn finish(resource: Resource) -> () ! CloseError {
  return run close(move resource)
}
```

The explicit operation owns the resource and decides how success or typed failure affects its
internal state. If it finishes or consumes the external resource, later fallback cleanup is
disarmed or becomes a no-op. If the operation propagates a typed failure while still owning
cleanup state, ordinary structured cleanup runs before that failure leaves its scope.

**Boundary:** The language does not implicitly merge a cleanup failure with an existing typed
failure. A library finalization combinator defines that policy explicitly—for example, preserving
the original operation failure while deliberately ignoring a close failure. Bootstrap has no
language-level `defer`, `errdefer`, asynchronous exit hook, or dynamic finalizer registry.

**Diagnostics:** Calling an explicit close operation with an implicit affine transfer reports
`OWN0003`; reusing the consumed resource reports `OWN0001`. Unhandled close failures and requirements
produce the ordinary Effect boundary diagnostics. Automatic Drop cannot replace an in-flight typed
failure.

**Evidence:** [typed-failure cleanup](typed-failures.md#fail-006--typed-failure-applies-ordinary-cleanup-and-preserves-diagnostic-context).

### ALLOC-001 — An allocation is a self-contained affine owner

**Status:** Confirmed

A successful allocation returns one affine `Allocation` carrying private, unforgeable authority for
its eventual infallible release. The value neither borrows nor later rediscovers the allocator
provider that created it. The provider loan ends after the allocation call; ownership of the
allocation may then move independently.

```silk
struct Layout {}
struct Allocation {}
struct OutOfMemoryError {}

service Allocator {
  effect fn allocate(layout: Layout) -> Allocation
    ! OutOfMemoryError
    ? &mut Allocator
}
```

A failed request creates no storage owner and no cleanup obligation. Dropping a successful
`Allocation` consumes its reclaim authority exactly once. Silk exposes no public `free` operation
derived from that authority.

Safe containers are ordinary affine owners built above allocations. `RawBuffer<T>` is a narrow
unsafe storage owner: releasing it releases its allocation but does not discover initialized
elements. A safe container's restricted `Drop` hook must destroy its initialized elements before
its buffer field cleans.

**Boundary:** Layout validation occurs before allocation. Allocator implementations are ordinary
service providers and receive no compiler privilege. Provider-dependent escaping allocation, such
as an arena value whose validity borrows its arena, remains outside the bootstrap model until the
language can express that relationship generally.

**Diagnostics:** Invalid layouts are validation results rather than created allocations. Exhaustion
is the typed failure `OutOfMemoryError`. Duplicate movement or cleanup reports ordinary ownership
diagnostics; unsafe buffer misuse reports the relevant unsafe-contract or ownership diagnostic.

**Evidence:** [owned-allocation specification](../../../../openspec/specs/bootstrap-owned-allocation/spec.md),
[allocation tests](../../../../packages/compiler/test/OwnedAllocation.test.ts),
[allocation acceptance tests](../../../../packages/compiler/test/OwnedAllocationAcceptance.test.ts).

### EFFECT-LIFE-001 — Effect execution cleans per-run state and preserves reusable captures

**Status:** Confirmed

Dropping an unrun Effect does not execute its body. It ends every capture loan and cleans every
owned capture retained by the Effect environment exactly once.

Running an Effect creates execution-local ownership for that run. Success and typed failure clean
all live per-run locals in the regions they exit. Reusable shared or exclusive Effects retain their
environment captures for later runs; a take-once run consumes its environment, cleaning any capture
not transferred into the result or failure payload.

**Boundary:** A typed failure cleans exited execution regions before propagation or recovery under
FAIL-006. Retry cleans the completed attempt's per-run locals before starting another attempt, while
retaining only the captures that its reusable Effect contract permits. Suspension transfers each
live value into exactly one later-execution owner and applies the same cleanup rules when execution
resumes and completes, as defined by the
[suspension ownership rules](effect-suspension.md#ownership-and-lifecycle).

An explicit finalization Effect such as `ensuring` is an ordinary composed operation. It runs on the
structured success and typed-failure paths promised by its contract, not merely because a hidden
runtime finalizer exists.
Its held outcome remains owned while the finalizer is suspended. Destroying that parked composition
drops the held payload, diagnostic handles and remaining captures exactly once; destruction does
not drive the suspended finalizer to completion.

**Diagnostics:** Running a consumed Effect reports `OWN0001`. Dropping a captured root while the
Effect still retains a loan reports `OWN0011`. A retry or reusable composition that would consume a
retained capture reports the corresponding run-access or ownership-contract mismatch.

**Evidence:** [ownership specification](../../../../openspec/specs/bootstrap-ownership/spec.md),
[Effect entry cleanup tests](../../../../packages/compiler/test/EffectEntry.test.ts),
[stored Effect cleanup tests](../../../../packages/compiler/test/StoredEffectCleanupVerification.test.ts),
[suspension ownership tests](../../../../packages/compiler/test/SuspensionOwnership.test.ts).

### TRAP-001 — A trap has no cleanup guarantee

**Status:** Confirmed

A trap is fatal abnormal termination rather than a structured exit. After a trapping operation,
Silk does not guarantee that lexical cleanup, `Drop` hooks, explicit finalizers such as `ensuring`,
or Effect-environment cleanup runs.

This rule applies to bounds violations, division by zero, trapping arithmetic overflow, violated
unsafe contracts, impossible compiler-generated states, and unexpected failures crossing a foreign
boundary. A trap does not become a hidden Effect failure and cannot be caught.

**Boundary:** A condition that must be recoverable must be represented before it traps, as ordinary
data or a typed failure from a checked operation. The runtime may report source and logical Effect
context before terminating, but such reporting does not imply that cleanup ran. Cancellation,
interruption, detached tasks, and concurrency remain outside the bootstrap lifecycle model.

**Diagnostics:** A trap during required compile-time evaluation reports a compile-time diagnostic.
A runtime trap terminates abnormally and must be distinguished from an unhandled typed failure.
Stable process-status and presentation rules remain to be assigned.

**Evidence:** [typed trap rule](typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes),
[trap specification](../../../../openspec/specs/bootstrap-flow-functions/spec.md).

## Batch 6 — Returned views

### VIEW-001 — An ordinary result follows declared lifetime relationships

**Status:** Confirmed

An ordinary function may return a direct view or an aggregate containing views when its body proves
the lifetimes declared by its result. Several inputs may share a declared lifetime without sharing
a concrete source owner.

```silk
fn choose<'data>(flag: bool, left: &'data i32, right: &'data i32) -> &'data i32 {
  if flag { return left }
  return right
}
```

The caller must keep either possible referent valid for the selected result's uses. An explicit
result may instead name only one independent input lifetime. Returning external data from a
by-value holder is valid when its field type carries that data lifetime; returning a reference to
the holder's own inline storage is invalid.

**Boundary:** [Header elision](lifetimes.md) supplies omitted output lifetimes from an outer borrowed
receiver, otherwise one top-level borrowed input. Two independent inputs without such a default
require explicit output relationships. Bodies never choose a public relationship. Shared access
cannot strengthen into exclusive access. Effect successes and failures obey these same declared
relationships, including when a short receiver borrow returns a longer externally backed view.

**Diagnostics:** Ambiguous output elision reports `SEM0210`. A violated declared lifetime bound
reports `SEM0212`; a result retaining expired local or temporary storage reports `OWN0019`.

**Evidence:** [returned-value requirements](../../../../openspec/specs/bootstrap-runtime-slices/spec.md),
[lifetime tests](../../../../packages/compiler/test/Type.test.ts).

### VIEW-002 — A returned view remains lexical and tied to its source owner

**Status:** Confirmed

The caller may bind, pass, reborrow, project, or transitively return a compatible returned view while
its source owner remains live. The view carries its provenance through those operations.

```silk
fn identity(values: &[i32]) -> &[i32] { return values }

fn use() -> i32 {
  let mut values = [1, 2]
  let view = identity(&values)
  let first = view[0]
  values[0] = 3
  return first
}
```

The shared loan lasts through `view`'s last use at `view[0]`. Mutation of `values` is valid
afterward. While a shared returned view remains live, its root cannot be mutated, moved, dropped, or
borrowed exclusively. An exclusive returned view suspends every independent access to its root.

A temporary passed to a returned-view function gains a hidden owner in the caller:

```silk
fn identity(values: &[i32]) -> &[i32] { return values }

fn useTemporary() -> i32 {
  let view = identity(&[1, 2])
  return view[0]
}
```

That hidden owner remains live until the view's last use, then cleans. It cannot travel out of the
caller's function:

```silk,ignore
fn identity(values: &[i32]) -> &[i32] { return values }

fn invalid() -> &[i32] {
  let local = [1, 2]
  return identity(&local)
}
```

**Boundary:** A returned view may be stored in an ordinary lifetime-bearing aggregate or captured
by a delayed value when its containing type preserves validity. Storage and copying never detach
its concrete loans. Dependent Effect success and failure values remain unsupported in this layer.

A wrapper may return the view again when its own declared result satisfies VIEW-001. No operation may detach a view from its root.

**Diagnostics:** Conflicting source-owner access while the view remains live reports `OWN0011` and
relates the view's origin. Returning or retaining a view beyond the validity of its source reports
`OWN0019`; unsatisfied public outlives bounds report `SEM0212`.

**Evidence:** [runtime-slice specification](../../../../openspec/specs/bootstrap-runtime-slices/spec.md),
[returned-view ownership tests](../../../../packages/compiler/test/RuntimeSliceOwnership.test.ts),
[runtime slice semantics tests](../../../../packages/compiler/test/RuntimeSliceSemantics.test.ts).
