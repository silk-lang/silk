# Unsafe code, intrinsics, and targets

Unsafe code is Silk code that explicitly accepts responsibility for invariants the compiler cannot
prove. It is not a mode that disables ordinary language checks. Intrinsics are the sealed primitive
operations from which ordinary Silk source builds safe language and standard-library abstractions.

This page is a stabilization workbench. Individual rule statuses record their review with the
language author; the proposal remains Draft until its whole-language review is accepted.

## Terminology

- **Safe code** is code outside an unsafe boundary. It cannot cause undefined behavior when its
  dependencies satisfy their safe contracts.
- An **unsafe boundary** is an explicit lexical region that permits calls with additional caller
  obligations.
- An **unsafe contract** states the invariant a caller must establish before invoking an operation.
- An **intrinsic** is a source-callable compiler primitive with canonical identity in the sealed
  `Intrinsic` namespace.
- A **safe wrapper** validates or structurally guarantees an unsafe precondition and exposes an
  ordinary safe operation.
- **Undefined behavior** means execution has violated an unsafe contract and the language makes no
  further behavioral guarantee.
- A **trap** is a defined fatal termination. It is not undefined behavior or a typed failure.
- **Target availability** is the set of execution targets on which one intrinsic has defined
  behavior and lowering.
- The **executable closure** is the set of declarations and intrinsic calls reachable from the
  selected entry for one concrete program and target.
- A **foreign function** is a bodiless `unsafe extern "C" fn` declaration whose implementation is
  native code linked into the artifact under a named symbol.
- A **native export** is an `export "C" fn` declaration with a body that native code may call
  through a generated thunk under a named symbol.
- A **raw pointer** is a qualified single- or many-element machine address with no
  ownership or loan; forming one is safe and dereferencing one is unsafe.

## Safety outcomes

### SAFETY-001 — Only violating an explicit unsafe contract permits undefined behavior

**Status:** Confirmed

Safe Silk has ordinary values, typed failures, and defined fatal traps as its complete outcome
model. Undefined behavior enters only when execution violates a stated precondition of an unsafe
operation.

```silk,ignore
let value = values[index]
// invalid index: defined fatal trap

let text = unsafe Intrinsic.stringFromUtf8Unchecked(bytes)
// bytes that are not valid UTF-8: violated unsafe contract, undefined behavior
```

Entering an unsafe boundary is not itself undefined behavior and does not make surrounding code
unspecified. When every unsafe contract is upheld, the program retains the semantics promised by
its ordinary and intrinsic operations.

Debug builds, interpreters, sanitizers, or a particular target may detect some contract violations
and trap. That detection is permitted but is not a portable semantic guarantee. Invalid pointers,
aliasing, initializedness, layouts, or private ABI state cannot in general be converted into a
guaranteed trap without maintaining and checking additional runtime proof.

**Boundary:** A typed failure is expected recoverable data in an Effect contract. A fatal trap is a
defined abnormal termination that cannot be caught and promises no cleanup. Undefined behavior
makes no guarantee about results, termination, cleanup, diagnostics, or subsequent execution. It is
not a hidden failure channel and cannot be caught.

If a caller satisfies an unsafe source function's declared preconditions but its implementation
still violates an unsafe invariant, that function is unsound. Safe code cannot cause undefined
behavior unless an unsafe dependency exposes an unsound safe API or the compiler/runtime violates
its own safe-language contract.

**Diagnostics:** No compile-time diagnostic can be required for a dynamic contract violation the
compiler cannot prove. Proven violations should be diagnosed when possible; optional runtime checks
may trap with invariant context. Tooling must not describe such checks as a guarantee of release
behavior.

**Current compiler:** Partially aligned. Unsafe intrinsics carry invariant text and safe operations
retain defined trap behavior. The language documentation has not previously separated detected
debug violations from the portable undefined-behavior boundary this explicitly.

**Evidence:** [fatal traps](typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes),
[safe-code vocabulary](../language/glossary.md),
[intrinsic unsafe invariants](../../../../packages/compiler/test/fixtures/intrinsic-inventory.json).

## Unsafe boundaries and contracts

### UNSAFE-001 — An unsafe boundary permits obligations; it does not disable checking

**Status:** Confirmed

`unsafe { ... }` explicitly accepts responsibility for the unsafe operations lexically contained
by its block. Type checking, definite initialization, ownership, moves, borrows, cleanup, Effect
contracts, visibility, generic bounds, and conformance checking remain active inside it.

```silk
fn fromUtf8Unchecked(bytes: &[u8]) -> string {
  unsafe {
    return Intrinsic.stringFromUtf8Unchecked(bytes)
  }
}
```

The block permits the unchecked construction call. It does not prove the bytes valid, make an
invalid borrow live longer, duplicate an affine value, handle an Effect, or make a private name
visible.

**Boundary:** Unsafe permission is lexical. It does not propagate into a called ordinary function,
another module, a callback that may execute later, or code merely dominated by an earlier unsafe
block. Nesting an unsafe block is valid but adds no stronger permission.

**Diagnostics:** Calling an unsafe operation outside a boundary reports `SEM0082` at the call and
names the operation whose invariant requires acknowledgement. Other invalid code inside the block
retains its ordinary primary diagnostic.

**Current compiler:** Aligned. The parser represents both unsafe statement blocks and single-call
acknowledgements, and semantic analysis applies the same invocation rule to intrinsic and ordinary
source callables.

**Evidence:** [intrinsic boundary specification](../../../../openspec/specs/bootstrap-intrinsic-boundary/spec.md),
[unsafe parser](../../../../packages/compiler/src/Parser.ts),
[unsafe-call diagnostics](../../../../packages/compiler/test/StringIntrinsics.test.ts).

### UNSAFE-002 — Ordinary source may declare a caller-owned unsafe contract

**Status:** Confirmed

Source syntax:

```silk,ignore
pub unsafe fn fromUtf8Unchecked(bytes: &[u8]) -> string {
  unsafe {
    return Intrinsic.stringFromUtf8Unchecked(bytes)
  }
}
```

Calling an `unsafe fn` requires a lexical unsafe boundary whether the implementation is a
compiler intrinsic or ordinary Silk source. The declaration would not receive compiler privilege;
it would only preserve an invariant obligation across an abstraction boundary.

The body of an `unsafe fn` remains safe-by-default. Every unsafe operation it performs still needs
an explicit local unsafe boundary. The declaration and the block answer different questions:

- `unsafe fn` says that the caller must establish the declared preconditions.
- `unsafe { ... }` says where an implementation accepts responsibility for one or more unsafe
  operations it invokes.

This keeps unsafe implementation sites visible when a large function changes and prevents an
unsafe public contract from silently suppressing checks throughout its body.

Unsafe is part of the function's callable contract. Taking, storing, passing, specializing, or
returning the function does not erase the call requirement. A safe callable parameter cannot accept
an unsafe callable, while a parameter explicitly accepting an unsafe callable preserves the
requirement at its eventual invocation.

**Boundary:** Merely mentioning or moving an unsafe callable does not perform an unsafe operation;
invoking it does. An unsafe function may call ordinary safe functions without a boundary. It cannot
declare that its caller owns an obligation and then expose an ordinary safe callable type that
forgets that obligation.

**Diagnostics:** Calling an unsafe source function outside an unsafe boundary uses the same
missing-boundary diagnostic as an unsafe intrinsic and names the selected function. Assigning or
passing it where a safe callable is required reports a callable-contract mismatch at the value
transfer.

**Current compiler:** Aligned. Ordinary and effectful source declarations, callable values,
serialized module surfaces, and tooling presentations preserve the unsafe-call qualifier.

### UNSAFE-003 — `unsafe call(...)` marks one invocation; `unsafe { ... }` marks a statement region

**Status:** Confirmed

The prefix form acknowledges exactly one unsafe function or intrinsic invocation and produces that
call's ordinary result:

```silk,ignore
let text = unsafe String.fromUtf8Unchecked(bytes)
let value = unsafe Intrinsic.rawBufferRead(buffer, index)
```

It is not a general unchecked-expression operator. Permission attaches to the directly prefixed
call and does not extend into its argument expressions:

```silk,ignore
let value = unsafe outer(unsafe inner())
```

If both calls are unsafe, both markers are required. An ordinary safe call may be prefixed only if
the language permits redundant acknowledgement; the first stable model diagnoses it as unnecessary
so `unsafe` continues to identify a real obligation rather than becoming decorative.

The block form marks every directly evaluated unsafe invocation within one statement region:

```silk
unsafe {
  let text = Intrinsic.stringFromUtf8Unchecked(bytes)
  consume(move text)
}
```

`unsafe { ... }` remains a statement block. It does not introduce trailing-expression results or a
special block-return rule. Use the single-call form when an unsafe result must participate in a
larger expression, binding, argument, or return.

**Boundary:** Permission from either form is lexical, not dynamic. It does not enter an ordinary
called function or a callback that executes later. The single-call form does not cover sibling,
receiver, argument, pipeline, or later invocations merely because they occur in the same enclosing
expression.

**Diagnostics:** Prefixing a non-call expression reports that `unsafe` must select one invocation.
Calling an unsafe operation without either form reports the missing-boundary diagnostic. A nested
unsafe call inside an argument receives its own diagnostic even when the outer call is prefixed.
Tooling may remove a redundant nested block whose complete region is already unsafe, but nesting is
not a compiler error.

**Current compiler:** Aligned. The statement block grants lexical authority, while the prefix grants
authority only to its directly wrapped complete call and not to nested argument calls.

**Evidence:** [unsafe block parser](../../../../packages/compiler/src/Parser.ts),
[unsafe semantic admission](../../../../packages/compiler/src/Elaboration.ts),
[unsafe syntax formatting](../../../../packages/compiler/src/SyntaxFormatter.ts).

### UNSAFE-004 — An unsafe effect function is acknowledged when its Effect is constructed

**Status:** Confirmed

An unsafe effect function requires acknowledgement at its call, exactly as an unsafe ordinary
function does. Calling it constructs one ordinary lazy Effect; running that valid Effect later does
not require another unsafe marker.

```silk,ignore
pub unsafe effect fn readUnchecked(
  pointer: RawPointer<u8>
) -> u8 {
  unsafe {
    return Intrinsic.pointerRead(pointer)
  }
}

let pending = unsafe Device.readUnchecked(pointer)
let value = run pending
```

The caller accepts responsibility for the returned Effect's validity over its complete lifetime
and every run its contract permits. If its invariant can be upheld only for one execution, the
function must return or construct a consuming `once Effect`; unsafe does not silently change run
access. Borrowed captures retain their ordinary lexical lifetime restrictions.

The effect function body remains lazy and safe-by-default. Its local unsafe operations still need
an `unsafe` call marker or block when the body eventually executes. The call-site marker
acknowledges the source function's construction contract; it does not eagerly execute the body.

**Boundary:** Silk has no `unsafe Effect` channel or unsafe form of `run`. Effect combinators,
storage, provision, failure handling, and execution preserve the ordinary success, failure,
requirement, representation, run-access, and cleanup contracts. An unsafe constructor cannot rely
on safe code to revalidate an undocumented condition at each run.

**Diagnostics:** Calling an unsafe effect function without acknowledgement reports the ordinary
missing-boundary diagnostic at construction. Running the resulting Effect receives only the normal
Effect, ownership, and execution-boundary diagnostics.

**Current compiler:** Aligned. Source and intrinsic unsafe Effect constructors are acknowledged when
called, and the resulting ordinary Effect runs without a second unsafe marker.

**Evidence:** [intrinsic Effect catalog](../../../../packages/compiler/src/Intrinsic.ts),
[OS intrinsic acceptance](../../../../packages/compiler/test/IntrinsicCatalog.test.ts),
[Effect construction and execution](effects-and-execution.md).

### UNSAFE-005 — Unsafety qualifies individual callable contracts and is compatible only toward safer implementations

**Status:** Confirmed

`unsafe` is part of an individual callable's use contract. It composes with invocation mode and
ordinary or effectful function kind:

```silk,ignore
unsafe fn(RawPointer<u8>) -> u8
unsafe mut fn(Buffer) -> ()
unsafe once fn(Handle) -> Result<(), CloseError>
```

Taking, moving, storing, passing, specializing, or returning an unsafe callable is safe. Invoking
it requires acknowledgement. Generic bounds and exact or opaque representation parameters preserve
the qualifier:

```silk,ignore
fn invoke<F: unsafe fn(RawPointer<u8>) -> u8>(
  operation: F,
  pointer: RawPointer<u8>
) -> u8 {
  return unsafe operation(pointer)
}
```

A safe callable may satisfy an unsafe callable contract because it requires fewer caller
obligations. The reverse is invalid. Code checked against the unsafe contract still requires
acknowledgement even when one later specialization selects a safe implementation.

Interfaces and services mark individual operations, not entire declarations or conformances:

```silk,ignore
interface RawAccess {
  unsafe fn read(pointer: RawPointer<u8>) -> u8
}
```

A safe function may implement that operation; callers continue to observe the interface's unsafe
contract. An unsafe function cannot implement an operation declared safe. The same compatibility
rule applies after substituting `Self`, generic arguments, Effect channels, ownership modes, and
service requirements.

**Boundary:** Silk has no `unsafe interface`, `unsafe service`, `unsafe impl`, `unsafe module`, or
ambient unsafe type. Unsafety neither implies nor changes ownership mode, Effect construction,
failure, requirements, visibility, target availability, or conformance coherence.

**Diagnostics:** Assigning, passing, returning, or mapping an unsafe callable where a safe contract
is required reports a callable-contract mismatch at the transfer or implementation. The diagnostic
identifies safety before reporting secondary representation details. Invoking through a statically
unsafe generic, interface, or service contract requires acknowledgement even when a selected safe
implementation is known later.

**Current compiler:** Aligned. Source callable types, generic substitution, interface and service
operations, conformance checking, and representation parameters preserve the qualifier. A safe
witness may satisfy an unsafe operation; the reverse is rejected.

**Evidence:** [callable contracts](functions-callables-and-control-flow.md),
[interface operation compatibility](generics-interfaces-and-specialization.md#impl-003--each-implementation-must-satisfy-the-substituted-operation-contract),
[intrinsic catalog](../../../../packages/compiler/src/Intrinsic.ts).

### UNSAFE-006 — Unsafe permission does not suspend ownership, borrowing, or cleanup rules

**Status:** Confirmed

An unsafe boundary permits only the additional caller obligations declared by the unsafe operations
it contains. Definite initialization, ownership, moves, borrowing, aliasing of safe references,
liveness, invocation access, and cleanup remain checked normally.

```silk,ignore
unsafe {
  consume(move value)
  use(value) // invalid: `value` was moved
}
```

Unsafe is not a general “trust me” escape from a rejected safe program. A raw operation that
performs a state transition ordinary Silk cannot prove must be an explicit unsafe intrinsic or
unsafe source operation. Its signature and postcondition must expose enough semantic state for the
compiler to resume ordinary checking after the call.

```silk,ignore
let value = unsafe Intrinsic.readInitialized(pointer)
use(&value) // `value` is an ordinary initialized value from here
```

Constructing a safe reference from a raw pointer similarly requires an unsafe operation whose
contract states the validity, lifetime, alignment, and aliasing obligations. Once constructed, the
reference follows the ordinary borrow rules. Unsafe code cannot reuse a moved or dead value, forge
a longer safe lifetime through syntax alone, or create simultaneously usable safe references that
violate their aliasing contracts.

Correct unsafe code receives ordinary cleanup on successful return and typed failure. Entering an
unsafe block does not suppress `Drop` or weaken cleanup ordering. Fatal traps retain their existing
no-cleanup guarantee. After an unsafe contract is violated, behavior is undefined and therefore no
cleanup behavior is promised.

**Boundary:** Some low-level operations necessarily change initializedness, ownership, or raw
resource state. The compiler supports those transitions through their canonical operation
contracts; the unsafe boundary merely acknowledges the unproved precondition. It does not make an
untracked transition visible by convention or comments.

**Diagnostics:** Invalid moves, borrows, liveness, initialization, and invocation access inside an
unsafe region use their ordinary diagnostics. A diagnostic should not suggest adding `unsafe` when
no unsafe operation exists that expresses the required transition.

**Current compiler:** Aligned for the current checked inventory. Ordinary semantic and ownership
analysis remains active inside lexical unsafe blocks, and each unsafe catalog entry carries the
specific invariant acknowledged by its call site rather than relying on an ambient exemption.

**Evidence:** [ownership and borrowing](ownership-and-borrowing.md),
[fatal-trap cleanup boundary](typed-failures.md#fail-007--a-trap-is-fatal-and-remains-outside-effect-outcomes),
[intrinsic boundary specification](../../../../openspec/specs/bootstrap-intrinsic-boundary/spec.md),
[checked intrinsic inventory](../../../../packages/compiler/test/IntrinsicCatalog.test.ts).

### UNSAFE-007 — Partial application preserves unsafety but does not invoke it

**Status:** Confirmed

Partially applying an unsafe callable is safe because it constructs another callable without
executing the unsafe operation. The resulting callable preserves the unsafe qualifier, and only
the application that supplies its final missing arguments requires acknowledgement.

```silk,ignore
unsafe fn readAt(pointer: RawPointer<u8>, offset: usize) -> u8 {
  unsafe {
    return Intrinsic.pointerReadOffset(pointer, offset)
  }
}

let readAtFour = readAt(4)                 // unsafe fn(RawPointer<u8>) -> u8
let byte = unsafe readAtFour(pointer)      // complete invocation crosses the unsafe contract
```

The same rule applies to source functions, intrinsic operations, generic callables, interface and
service operations, and exact or opaque callable representations. Each additional partial
application remains safe until the callable's arity is satisfied.

Trailing arguments captured by a partial application still follow their ordinary ownership and
lifetime rules when the callable is formed. The unsafe precondition must hold when the completed
invocation executes. In particular, capturing a raw pointer in a trailing parameter does not
promise that it will still be valid later; satisfying that condition remains the eventual caller's
obligation.

```silk,ignore
let readAtFour = unsafe readAt(4)
// invalid: no unsafe operation is invoked by this partial application
```

**Boundary:** This rule relies on Silk's ordinary leading-argument partial application. A call that
fully satisfies the remaining arity invokes the callable even if its result is itself another
callable; result shape does not retroactively make that invocation partial.

**Diagnostics:** An unsafe callable invoked without acknowledgement reports the missing-boundary
diagnostic at its complete application. Prefixing a partial application with `unsafe` reports that
the acknowledgement is misplaced because the operation has not been invoked. Ownership and
lifetime errors in captured arguments retain their ordinary diagnostics.

**Current compiler:** Aligned. Partial application preserves the unsafe qualifier without requiring
acknowledgement, and every complete invocation through the resulting callable requires one block or
single-call marker.

**Evidence:** [partial application](functions-callables-and-control-flow.md),
[callable ownership](ownership-and-borrowing.md),
[intrinsic catalog](../../../../packages/compiler/src/Intrinsic.ts).

### UNSAFE-008 — Unsafe declarations use ordinary visibility and document their caller contract

**Status:** Confirmed

An unsafe source function follows the same module, visibility, import, qualification, and naming
rules as any other function. `unsafe` does not imply `pub`, grant access to private names, or allow
the declaration to escape its module without an ordinary export.

The attached documentation should state the caller-owned preconditions in a nonempty `# Safety`
section:

```silk,ignore
/// Constructs text without validating its encoding.
///
/// # Safety
///
/// `bytes` must contain valid UTF-8 for the complete duration of this call.
pub unsafe fn fromUtf8Unchecked(bytes: &[u8]) -> string {
  unsafe {
    return Intrinsic.stringFromUtf8Unchecked(bytes)
  }
}
```

This documentation convention is tooling and style policy, not a condition for compiling valid
Silk. The LSP warns when an unsafe source declaration has no nonempty `# Safety` section and may
offer a scaffold. Hover, signature help, completion details, and generated documentation prominently
show the unsafe qualifier and safety section when present.

Intrinsic operations have no source declaration, so their mandatory catalog invariant supplies the
same tooling information. Hover and missing-boundary diagnostics show that invariant directly.

**Boundary:** The compiler enforces that an unsafe callable is acknowledged at invocation whether
or not its documentation is present or correct. Documentation cannot make a safe declaration
unsafe, grant intrinsic privilege, or change a callable contract. An incomplete or incorrect safety
description may make a library unsound, but it does not create a second type-level contract
language.

**Diagnostics:** Missing acknowledgement remains a compiler error. Missing or empty `# Safety`
documentation is an LSP warning and does not fail parsing, semantic analysis, execution, or a
compiler-only build. Ordinary visibility and import errors retain their ordinary diagnostics.

**Current compiler:** Aligned for source-declared unsafe functions, visibility, call-site
acknowledgement, formatting, and editor presentation. Documentation comments attach to declarations
and flow into editor information. The non-blocking LSP warning for a missing or empty `# Safety`
section is not yet implemented.

**Evidence:** [module and visibility rules](modules-names-and-visibility.md),
[documentation block model](../../../../packages/compiler/src/DocBlock.ts),
[editor documentation tests](../../../../packages/compiler/test/EditorIntelligence.test.ts).

## Sealed intrinsic boundary

### INTR-001 — `Intrinsic` is sealed compiler identity available to every source module

**Status:** Confirmed

`Intrinsic` is a globally available compiler namespace. It requires no import, and every Silk
module may call its members under their individual contracts.

```silk,ignore
let previous = Intrinsic.replace(place, value)
let text = unsafe Intrinsic.stringFromUtf8Unchecked(bytes)
```

The namespace is sealed. Source cannot declare, import as, alias as, shadow, reopen, extend, or
implement `Intrinsic`. A `type` alias may name an individual member under TYPE-004; that names the
member and does not alias the namespace. Its operations have canonical compiler identities
independent of source paths or packages.

An ordinary actor or function with a matching member spelling receives no privilege:

```silk,ignore
fn stringFromUtf8Unchecked(bytes: &[u8]) -> string {
  // ordinary Silk source
}
```

Only the qualified sealed identity selects intrinsic behavior. The compiler never recognizes an
ordinary standard-library actor, service, interface, provider, type, or function by spelling.

**Boundary:** The shipped standard library has no special permission to call `Intrinsic`. Restricting
it by package, path, signature, build mode, or toolchain provenance would introduce a second hidden
trust system. Tooling and style guidance may prefer a safe public wrapper where one exists, but the
compiler does not reject direct calls merely because they occur outside the standard library.

**Diagnostics:** Declaring or importing a binding named `Intrinsic` reports a reserved-binding
collision. An unknown member reports an unknown-intrinsic diagnostic and does not search ordinary
modules for a fallback. A same-named ordinary operation under another qualifier resolves normally
and receives no intrinsic-specific diagnostic or lowering.

**Current compiler:** Aligned. Intrinsic operations carry canonical identities in one checked
catalog, scalar actor spellings resolve to shipped source wrappers, and same-spelled ordinary source
operations receive no intrinsic identity or lowering.

**Evidence:** [intrinsic boundary specification](../../../../openspec/specs/bootstrap-intrinsic-boundary/spec.md),
[intrinsic catalog tests](../../../../packages/compiler/test/IntrinsicCatalog.test.ts),
[minimal compiler privilege](../../../../AGENTS.md#minimal-compiler-privilege).

### INTR-002 — Safety belongs to each intrinsic contract, not to the namespace

**Status:** Confirmed

Every intrinsic has one canonical callable contract covering its generic parameters, value
parameters, ownership modes, result, Effect channels where present, invocation or run access,
safety classification, caller invariant when unsafe, and supported-target set.

A safe intrinsic is callable from safe code. An unsafe intrinsic requires UNSAFE-003's call marker
or block. Namespace membership alone neither makes an operation unsafe nor makes its failures,
traps, or target restrictions implicit.

Unsafe intrinsic invariants must name the exact obligation the compiler cannot prove—for example,
initialized extent, live handle kind, valid UTF-8, non-aliasing access, or private ABI layout. “May
be unsafe” and “caller must use correctly” are not sufficient contracts.

The same canonical contract drives name resolution, generic inference, signature help, hover,
diagnostics, TIR, MIR, static evaluation, target validation, and LLVM lowering. Those consumers cannot
independently reconstruct or weaken it.

**Boundary:** An intrinsic may still have defined typed failures or traps. Unsafe marks only the
additional precondition whose violation permits undefined behavior; it is not another failure
channel or a promise that every bad runtime condition becomes undefined behavior.

**Diagnostics:** A contract mismatch uses the ordinary call, ownership, generic, or Effect
diagnostic. A missing unsafe acknowledgement names the invariant-bearing operation. Catalog
verification rejects an unsafe operation without a concrete invariant, an operation without a
target, or divergent contracts across compiler phases.

**Current compiler:** Aligned in architecture. The deterministic catalog records signatures,
safety, unsafe invariants, consumers, compiler identities, targets, and private host imports, and
tests compare the checked inventory with accepted semantic calls.

**Evidence:** [intrinsic inventory](../../../../packages/compiler/test/fixtures/intrinsic-inventory.json),
[catalog implementation](../../../../packages/compiler/src/Intrinsic.ts),
[catalog verification](../../../../packages/compiler/test/IntrinsicCatalog.test.ts).

### INTR-003 — An intrinsic must be the smallest irreducible primitive with a real consumer

**Status:** Confirmed

The compiler admits an intrinsic only when ordinary Silk cannot express a required machine,
representation, language-safety, execution-boundary, or private-host operation. The operation must
be the smallest contract from which ordinary source can build the desired abstraction.

Every intrinsic must have either a shipped ordinary-Silk consumer or a direct necessity imposed by
language syntax, safety, representation, or lowering. Convenience, fewer wrapper lines, faster
initial implementation, or an existing compiler branch are not admission reasons.

Validation, domain errors, generic selection, provider types, conformance policy, retries,
buffering, allocation strategy, text policy, filesystem policy, diagnostics, and reusable safe
composition remain ordinary Silk whenever the primitive contract makes them expressible.

For example, private OS operations expose handles, primitive scalars, byte views, explicit output
storage, and low-level outcomes. They do not construct `FileError`, `ProcessOutcome`, `HostInput`,
or a service implementation. Source providers translate the primitive result into those public
domain values.

**Boundary:** Target-restricted does not mean abstraction-shaped. A native-only intrinsic remains a
narrow semantic primitive with explicit availability; it does not become permission to expose an
entire native service or platform object through the compiler.

**Diagnostics and audit:** This is primarily a catalog and release invariant rather than a
program-error condition. The deterministic inventory records the admission reason and source
consumer. Repository verification rejects missing consumers, unregistered compiler branches,
unregistered public host imports, or duplicate abstraction-shaped operations.

**Current compiler:** Aligned for the current catalog. The checked inventory records a nonempty
admission reason and concrete consumer for every operation, and catalog tests compare that inventory
with every accepted semantic intrinsic call.

**Evidence:** [minimal intrinsic requirement](../../../../openspec/specs/bootstrap-intrinsic-boundary/spec.md),
[current deterministic inventory](../../../../packages/compiler/test/IntrinsicCatalog.test.ts).

### INTR-004 — Safe wrappers are ordinary Silk proofs over unsafe contracts

**Status:** Confirmed

A safe wrapper may call an unsafe operation only after validation or ordinary type, ownership, and
construction rules establish its preconditions:

```silk,ignore
pub fn fromUtf8(bytes: &[u8]) -> Result<string, InvalidUtf8Error> {
  if Utf8.isValid(bytes) {
    let text = unsafe Intrinsic.stringFromUtf8Unchecked(bytes)
    return Result.succeed(move text)
  }
  return Result.fail(InvalidUtf8Error {})
}
```

The wrapper is ordinary Silk and receives no compiler identity, trust, or privilege from its name,
module, package, path, or relationship to an intrinsic. The compiler checks the explicit unsafe
acknowledgement and every ordinary static rule, but it does not prove that the wrapper's validation
logically establishes the documented unsafe invariant. A wrapper that exposes invalid input to the
operation through a safe signature is unsound.

The wrapper chooses its public outcome according to its own ordinary contract. It may return a
typed failure for recoverable invalid input, rely on an already-defined fatal trap for a violated
language precondition, or preserve a caller obligation through an unsafe function. No outcome or
error channel is inferred from the intrinsic it calls.

Calling `Intrinsic` directly remains legal in every module. Tooling may suggest an existing safe
wrapper when useful, but direct intrinsic access is not itself a warning or error. `Unchecked`,
`Raw`, and `Unsafe` are style signals only; the callable's actual `unsafe` qualifier determines
whether acknowledgement is required.

**Boundary:** A safe wrapper may combine several intrinsics, and several wrappers may expose
different policies over one intrinsic. No registry identifies an approved wrapper, and an
intrinsic does not nominate one privileged public actor.

**Diagnostics:** An unsafe call in a wrapper without acknowledgement reports the ordinary
missing-boundary error. Invalid wrapper logic receives only the diagnostics justified by ordinary
Silk analysis; the compiler does not claim to have proven its semantic safety argument. LSP wrapper
suggestions are optional actions, not correctness diagnostics.

**Current compiler:** Aligned. Shipped source wrappers call narrow intrinsics from ordinary Silk,
the compiler resolves only the sealed intrinsic identity, and same-spelled ordinary operations are
verified to remain ordinary source.

**Evidence:** [minimal compiler privilege](../../../../AGENTS.md#minimal-compiler-privilege),
[intrinsic boundary specification](../../../../openspec/specs/bootstrap-intrinsic-boundary/spec.md),
[standard-library source](../../../../packages/compiler/stdlib).

### INTR-005 — Core storage types are sealed `Intrinsic` members, not reserved names

**Status:** Confirmed

The compiler-owned storage types are members of the sealed namespace and are spelled through it:

- `Intrinsic.Allocation`: one affine owner of a raw allocation and its reclaim authority.
- `Intrinsic.RawBuffer<T>`: typed raw storage owned independently of its allocator provider.
- `Intrinsic.Slot<'storage, T>`: a lexical exclusive projection into one buffer element.

`Slot`, `RawBuffer` and `Allocation` are ordinary names. Source may declare, import and use types,
actors and bindings with those spellings, and they never denote the storage types:

```silk
struct Slot { value: i32 }

fn read(slot: Slot) -> i32 { return slot.value }

fn length(buffer: &Intrinsic.RawBuffer<i32>) -> usize { return Intrinsic.rawBufferCount<i32>(buffer) }
```

The standard library's `silk.raw_buffer.RawBuffer` and `silk.slot.Slot` actors are such ordinary
declarations: their sibling functions take `Intrinsic.RawBuffer<T>` and `Intrinsic.Slot<'s, T>`.

**Boundary:** There is no alias or fallback. A bare `Slot<'s, T>` where no `Slot` is declared or
imported does not resolve to the storage type.

**Diagnostics:** An unknown `Intrinsic` type member reports an unknown-intrinsic diagnostic. A bare
storage spelling with no ordinary declaration in scope reports an ordinary unknown-type diagnostic.

**Current compiler:** Aligned.

**Evidence:** [intrinsic catalog tests](../../../../packages/compiler/test/IntrinsicCatalog.test.ts).

### INTR-006 — `Copy` and `Drop` are sealed `Intrinsic` properties published by `silk.ownership`

**Status:** Confirmed

The two ownership properties are members of the sealed namespace:

- `Intrinsic.Copy`: values of the type duplicate without user code (OWN-001, STRUCT-005).
- `Intrinsic.Drop`: an affine type runs one cleanup operation when it is dropped.

The standard library publishes them under ordinary names through TYPE-004 aliases:

```silk,ignore
// silk/ownership.silk
pub type Copy = Intrinsic.Copy
pub type Drop = Intrinsic.Drop
```

A module imports `Copy` and `Drop` like any other standard-library API. Every spelling names the
same property, so `impl Copy for Point {}` and `impl Intrinsic.Copy for Point {}` are one
conformance, and a second one is a duplicate:

```silk
import silk.ownership { Copy }

struct Point { x: i32 y: i32 }

impl Copy for Point {}

fn twice<T: Intrinsic.Copy>(value: T) -> i32 {
  let first = value
  let second = value
  return 42
}

pub fn main() -> i32 { return twice(Point { x: 1, y: 2 }) }
```

**Boundary:** `Copy` and `Drop` are ordinary names. A module that declares its own `Copy`, or a
generic parameter named `Drop`, shadows the imported name. Without a declaration or import, a bare
`Copy` does not name the property. The properties are bounds and `impl` heads only; neither one is a
value type.

**Diagnostics:** An unknown `Intrinsic` member reports an unknown-intrinsic diagnostic. A second
conformance through any spelling reports `SEM0083` at the later `impl`. A property in a value
type position receives that position's wrong-kind diagnostic.

**Current compiler:** Aligned.

**Evidence:** [type alias tests](../../../../packages/compiler/test/TypeAlias.test.ts), the
`user-declared-copy` program in the [native corpus](../../../../packages/compiler/test/support/corpus.ts).

## Target availability

### TARGET-001 — Intrinsic availability is checked only for the selected executable closure

**Status:** Confirmed

Parsing, importing, resolving, and type-checking a target-restricted intrinsic is valid on every
target. After generic specialization and executable reachability select one concrete program, every
retained intrinsic call must support the requested execution target.

An imported function containing a target-specific operation does not constrain an executable
that cannot reach it. Changing the selected entry or a static call edge so that the function
becomes executable makes its intrinsic availability relevant to the selected target.

Ordinary runtime control flow does not hide a call from availability. A call guarded by a
runtime Boolean still belongs to the executable closure.

When the condition is runtime data, both branches belong to the executable behavior and the intrinsic must
support the target. Availability cannot depend on an optimizer deciding to delete source behavior.

**Boundary:** Loading a module, importing a wrapper, mentioning it in documentation, or retaining
an unreachable generic declaration does not select its intrinsic calls. Invalid syntax, types,
generic arguments, ownership, or unsafe acknowledgement are diagnosed before target selection and
do not produce secondary availability errors.

**Diagnostics:** Each distinct unavailable intrinsic/target pair reports one deterministic error
at its first reachable call, naming both. Additional reachable sites may appear as related notes.
The error occurs before layout, MIR, or LLVM emission; no internal backend failure
may substitute for it.

**Current compiler:** Aligned. Target selection consumes the concrete intrinsic calls retained by
instance discovery, deduplicates unavailable diagnostics by canonical operation identity, and runs
before LLVM lowering or emission.

**Evidence:** [intrinsic target availability specification](../../../../openspec/specs/bootstrap-intrinsic-target-availability/spec.md),
[availability selection](../../../../packages/compiler/src/IntrinsicAvailability.ts),
[target-availability tests](../../../../packages/compiler/test/IntrinsicAvailability.test.ts).

### TARGET-002 — Unreachable target-specific primitives have no artifact cost

**Status:** Confirmed

An intrinsic absent from the selected executable closure contributes no host import, runtime helper,
adapter, symbol, table entry, or backend support module to the emitted artifact. Target-specific
code is pay-for-use even when its source declaration belongs to a loaded module.

Equivalent source closure, concrete specializations, entry, and target produce deterministic
retained inventories and diagnostics. Import order, filesystem traversal, prior builds, and backend
discovery order do not affect the result.

**Boundary:** This rule does not promise that two different source programs have identical binary
layout or size. It promises only that an unreachable restricted intrinsic cannot force its own
support machinery into the artifact.

**Diagnostics:** No programmer diagnostic applies when the intrinsic is unreachable. Release and
backend inventory verification reject an artifact that contains support or imports for an absent
operation.

**Current compiler:** Aligned in the validated intrinsic inventory and backend preparation model.

**Evidence:** [pay-for-use target requirement](../../../../openspec/specs/bootstrap-intrinsic-target-availability/spec.md),
[intrinsic availability selection](../../../../packages/compiler/src/IntrinsicAvailability.ts),
[intrinsic inventory tests](../../../../packages/compiler/test/IntrinsicCatalog.test.ts).

### TARGET-003 — Target unavailability is a compile-time compatibility error

**Status:** Confirmed

A reachable intrinsic outside its supported-target set makes the selected executable invalid. The
condition is not a typed failure, service requirement, fatal trap, runtime feature probe, or dynamic
fallback.

Ordinary wrapper functions need no target annotation: their reachable primitive calls determine
compatibility transitively. Ordinary source cannot add to, subtract from, or override an intrinsic's
compiler-owned target set.

Target-conditional source uses the ordinary static `silk.target` API and `static if`. Static
selection removes an inactive intrinsic call before executable availability is checked. Runtime
conditions, target reflection, and runtime target inspection remain unavailable. Portable public
APIs may also use ordinary source abstractions and target-appropriate providers.

**Boundary:** An intrinsic may return a typed failure for a supported target's ordinary operational
failure. That does not make absence of the intrinsic implementation recoverable on an unsupported
target.

**Diagnostics:** The availability error names the canonical intrinsic and requested target and may
suggest selecting a supported target or removing the reachable dependency. It does not suggest
catching a failure, adding an unsafe block, or providing a service.

**Current compiler:** Aligned for LLVM target availability classes. Finer target-triple
availability, if needed, must refine the same compile-time rule rather than create runtime fallback.

**Evidence:** [target diagnostic](../../../../packages/compiler/src/Diagnostic.ts),
[target selection](../../../../packages/compiler/src/Target.ts),
[target availability specification](../../../../openspec/specs/bootstrap-intrinsic-target-availability/spec.md),
[static target selection](static-evaluation.md#static-009--silktarget-exposes-target-information-only-as-static-source-values).

## Foreign functions

### FFI-001 — `extern "C"` declares a native symbol under an explicit ABI

**Status:** Confirmed

Source syntax:

```silk,ignore
pub unsafe extern "C" fn abs(value: i32) -> i32

unsafe extern "C" fn cAbs(value: i32) -> i32 as "abs"
```

A foreign function declaration names one module-level function whose implementation is supplied
by native code linked into the artifact. It has no body. The declaration carries three separate
identities:

- the **Silk name** (`abs`, `cAbs`), which source uses to resolve and call it;
- the **native symbol**, which is the `as` string when present and the Silk name otherwise; and
- the **ABI**, named by the string after `extern`.

Only `"C"` is accepted as the ABI. The symbol is the logical native name: the compiler applies the
selected target's own decoration, so a Darwin `_abs` is never spelled in source. `pub` controls
Silk module visibility exactly as for an ordinary function and says nothing about native linkage;
a private foreign function still reaches the linker when it is called.

**Boundary:** Renaming with `as` creates no declaration under the symbol's spelling; `cAbs` above
does not introduce a Silk name `abs`. Two modules may declare the same symbol under different Silk
names. A public foreign function imported from another module is called under the same rules as
in its declaring module.

**Diagnostics:** An ABI string other than `"C"` reports `SEM0185` at the string and publishes no
callable.

**Current compiler:** Aligned. `extern` is a complete-identifier keyword; the declaration index
records the symbol and ABI as header facts with no body, and the module semantic surface encodes
them so a symbol change invalidates dependents.

**Evidence:** [foreign function specification](../../../../openspec/changes/add-extern-c-functions/specs/bootstrap-foreign-functions/spec.md),
[declaration collection](../../../../packages/compiler/src/DeclarationCollection.ts),
[declaration completion](../../../../packages/compiler/src/DeclarationCompletion.ts),
[foreign diagnostics](../../../../packages/compiler/src/Diagnostic.ts).

### FFI-002 — Foreign functions are unsafe by declaration

**Status:** Confirmed

Every foreign declaration carries the `unsafe` qualifier. The compiler cannot see the native
implementation, so it cannot prove any invariant about it; the caller owns the whole contract. The
qualifier makes the foreign callable an ordinary unsafe callable under
[UNSAFE-002](#unsafe-002--ordinary-source-may-declare-a-caller-owned-unsafe-contract): a call
needs a lexical unsafe boundary, and every ownership, borrowing, and type check still applies.

```silk,ignore
unsafe extern "C" fn abs(value: i32) -> i32

pub fn magnitude(value: i32) -> i32 {
  return unsafe abs(value)
}
```

**Boundary:** `unsafe` on the declaration is mandatory, not a choice the author makes per symbol.
Wrapping a foreign call in a safe function is an ordinary Silk proof under
[INTR-004](#intr-004--safe-wrappers-are-ordinary-silk-proofs-over-unsafe-contracts); the wrapper
author accepts responsibility for the native contract.

**Diagnostics:** A foreign declaration without `unsafe` reports `SEM0186` at the declaration and
publishes no callable. Calling a foreign function outside an unsafe boundary reports the same
missing-acknowledgement diagnostic as any unsafe source callable.

**Current compiler:** Aligned. The callable contract, acknowledgement checks, and tooling
presentations are reused unchanged from unsafe source functions.

**Evidence:** [foreign function specification](../../../../openspec/changes/add-extern-c-functions/specs/bootstrap-foreign-functions/spec.md),
[declaration completion](../../../../packages/compiler/src/DeclarationCompletion.ts),
[foreign diagnostics](../../../../packages/compiler/src/Diagnostic.ts).

### FFI-003 — Foreign signatures admit only the C-compatible scalar subset

**Status:** Confirmed

Each parameter and the result of a foreign function passes a foreign-ABI admission relation that is
distinct from Silk type compatibility. The admitted subset is:

- `()` as the result only;
- `i8`, `u8`, `i16`, `u16`, `i32`, `u32`, `i64`, `u64` as exact-width integers;
- `isize` and `usize` as pointer-width integers of the selected target;
- `f32` and `f64` as the C `float` and `double` classes; and
- Qualified single/many and nullable/non-null pointers for any pointee `T` as the C pointer class, without requiring the
  pointee itself to be admitted; and
- `extern "C" fn(P...) -> R` as one C function-pointer class when every parameter and result is
  admitted recursively; and
- Single-value reference parameters explicitly named by `borrow` in the sealed [foreign contract](foreign-call-contracts.md), lowered to one C pointer while retaining the full ordinary loan.

```silk,ignore
struct Opaque {}

unsafe extern "C" fn malloc(size: usize) -> ?[*]mut u8
unsafe extern "C" fn free(pointer: ?[*]mut u8) -> ()
unsafe extern "C" fn use(handle: *mut Opaque) -> i32
```

Parameters are passed by value. Every other type is rejected: `bool`, `char`, `string`,
unasserted references, slices, fixed arrays, structs, unions, enums, Silk callable types, and type parameters.

Admission checks the source types and explicit complete-call borrow assertions once per selected module. The C classification of `isize`, `usize`, and pointers
takes the selected target's pointer width when the executable is realized for that target.

**Boundary:** A type being representable in C does not admit it. `bool` has a C-compatible
layout on every supported target and is still outside the subset, because admission is a closed
relation, not a layout query. Admitting `*mut Opaque` says nothing about the pointee: an ordinary
Silk struct remains an opaque handle, while only a valid `extern "C" struct` grants native code the
right to interpret its fields. Pointer values themselves are defined by
[PTR-001](values-and-types.md#ptr-001--a-raw-pointer-is-one-un-owned-machine-address).

**Diagnostics:** A parameter or result outside the subset reports `SEM0187` at the offending
type, naming the type and the ABI. One declaration with several offending types reports one
diagnostic per type. A rejected header publishes no callable.

**Current compiler:** Aligned. `CAbi.admit` judges the spelling and accepts a pointer without
examining its pointee; C-layout field validation is a separate recursive contract.
`CAbi.classify` and `CAbi.signature` derive the target-specific C signature used by MIR,
verification, and the backend, with every pointer qualifier and invariant pointee in the signature key. Narrow integer
arguments and results use the target C ABI extension contract: sign/zero extension on Darwin ARM64
and System V x86-64, and no extension attribute under GNU AAPCS64.

**Evidence:** [foreign function specification](../../../../openspec/changes/add-extern-c-functions/specs/bootstrap-foreign-functions/spec.md),
[pointer admission](../../../../openspec/changes/add-raw-pointers/specs/bootstrap-foreign-functions/spec.md),
[C-layout field contract](values-and-types.md#struct-006--c-layout-records-make-an-explicit-field-layout-promise),
[C ABI classification](../../../../packages/compiler/src/CAbi.ts),
[declaration completion](../../../../packages/compiler/src/DeclarationCompletion.ts).

### FFI-004 — Foreign declarations carry no Silk-only contract and are callable only

**Status:** Confirmed

A foreign function declaration cannot declare type parameters, a `where` clause, a failure row, a
requirement row, the `effect` kind, the `static` phase, or a body. Each of these is a Silk-owned
contract that native code cannot honor.

```silk,ignore
unsafe extern "C" fn bad<T>(value: T) -> T
unsafe extern "C" effect fn bad() -> ()
unsafe extern "C" fn bad() -> i32 { return 1 }
```

The value of a foreign function is callable only. Binding it with `let`, passing it as a callable
argument, storing it, or partially applying it is rejected.

**Boundary:** This restriction is narrower than
[UNSAFE-007](#unsafe-007--partial-application-preserves-unsafety-but-does-not-invoke-it), which
lets ordinary unsafe source callables be taken as values. A foreign function has no Silk callable
representation. An exact `export "C"` function may instead become a C address under
[FFI-012](#ffi-012--c-function-pointers-are-exact-exported-addresses); that does not make imported
foreign functions first class.

**Diagnostics:** Retained Silk-only syntax reports `SEM0188` at the offending syntax and publishes
no callable. A first-class use reports `SEM0189` at the use.

**Current compiler:** Aligned. Header restrictions are checked in declaration completion; the
first-class check runs at the use site.

**Evidence:** [foreign function specification](../../../../openspec/changes/add-extern-c-functions/specs/bootstrap-foreign-functions/spec.md),
[declaration completion](../../../../packages/compiler/src/DeclarationCompletion.ts),
[foreign diagnostics](../../../../packages/compiler/src/Diagnostic.ts).

### FFI-005 — Foreign symbols are valid, unreserved, and unique per executable

**Status:** Confirmed

A native symbol is a non-empty ASCII identifier: a letter or underscore followed by letters,
digits, or underscores. Any other spelling, including an embedded NUL, is rejected at the
declaration.

Platform entry names such as `main` are ordinary foreign export names: a selected source
runtime may define them. The remaining private compiler symbols are reserved:
`__silk_foreign_personality`, plus the generated shapes `silk_suspend_*` and
`silk_<module>_<name>__<instance>`. Source-owned startup, storage, process, host-input and
standard-stream operations have no reserved names.

Within one executable closure, two reachable foreign declarations of one symbol are accepted when
their classified C signatures and normalized behavioral contracts are equal and rejected when either differs. The executable declares
the symbol once.

```silk,ignore
unsafe extern "C" fn f() -> () as "not a symbol"
unsafe extern "C" fn g() -> i32 as "__silk_foreign_personality"
```

**Boundary:** Agreement is judged on the classified C signature, not the Silk spelling. `isize` on
a 64-bit target and `i64` classify to the same C type and therefore agree. Unreachable source declarations do not enter executable identity. Supplied behavioral interfaces are checked against one another and against the executable inventory, with both origins retained.

**Diagnostics:** An invalid spelling reports `SEM0190` at the `as` string or, without `as`, at the
declaration. A reserved symbol reports `SEM0191` at the same position. A conflicting redeclaration
reports `SEM0192` at one declaration with a note relating the other; planning constructs no
artifact. A symbol the native backend also declares for its own use, with a disagreeing signature,
is a backend diagnostic naming the symbol.

**Current compiler:** Aligned. Spelling and reservation are checked per module; signature
agreement is checked when the executable origin collects reachable foreign calls for the target.

**Evidence:** [foreign function specification](../../../../openspec/changes/add-extern-c-functions/specs/bootstrap-foreign-functions/spec.md),
[symbol spelling and reservation](../../../../packages/compiler/src/ForeignSymbol.ts),
[C ABI signature identity](../../../../packages/compiler/src/CAbi.ts).

### FFI-006 — Foreign calls use linked symbols and enforced unwind boundaries

**Status:** Confirmed

A foreign call retains its ordinary externally linked C symbol and classified signature. The backend emits one internal, non-inlined guard per symbol. The guard invokes the actual external function with a normal-return edge and a cleanup landing pad, and has a target-native Itanium/DWARF personality that traps in either unwind phase. A foreign exception therefore terminates at this boundary, including when an enclosing C++ caller has a catch handler. The original callee receives no inferred `nounwind` promise; the guard's `nounwind` describes its enforced termination path. No runtime symbol lookup occurs.

Unannotated calls access externally reachable memory conservatively. Only the explicit sealed [foreign contract](foreign-call-contracts.md) supplies narrower memory, capture, alias or no-return assertions. Raw pointers cross as address lanes; address-taken Silk roots are still reloaded after each call. Ordinary foreign data/error-state reads stay ordinary loads, with no recognized accessor names, global volatility or hardware fences.

Link inputs are compiler-generated objects followed by the ordered structured inputs the project
manifest names. The optional `[build]` table's `native-link-inputs` array accepts object paths,
static-archive paths, named libraries with an explicit static or dynamic mode, search paths, and
Apple frameworks. Paths are resolved relative to the manifest and may not escape the project; a
name with a path separator, whitespace, NUL, or leading `-` is rejected. Arbitrary linker flags
stay out of source and manifest.

```toml
[build]
native-link-inputs = [
  { search-path = "vendor/lib" },
  { library = "m", mode = "dynamic" },
  { static-archive = "vendor/libsupport.a" },
]
```

**Boundary:** The compiler does not verify that a link input defines the symbol or that its real
C signature matches the declaration. Supplied `Driver.CompileRequest.foreignInterfaces` JSON snapshots are validated before backend/cache use; detectable signature or behavioral mismatches report both origins. Other unsafe contract violations are undefined behavior under
[SAFETY-001](#safety-001--only-violating-an-explicit-unsafe-contract-permits-undefined-behavior).
This rule does not stabilize the compiler's own runtime symbols; see
[RUNTIME-003](runtime-and-standard-library.md#runtime-003--toolchain-runtime-support-guarantees-contracts-not-implementation-abi).

**Diagnostics:** No link input defining the symbol is a typed link failure from the driver that
retains the linker output and produces no executable. It is toolchain data, not a language
diagnostic.

**Current compiler:** Aligned. The LLVM backend declares each reachable symbol once with the C
calling convention and external linkage, emits the fatal unwind guard, and records each symbol with its machine and behavioral contract.

**Evidence:** [foreign function specification](../../../../openspec/changes/add-extern-c-functions/specs/bootstrap-foreign-functions/spec.md),
[C ABI signature](../../../../packages/compiler/src/CAbi.ts).

### FFI-007 — Foreign functions use explicit pay-for-use bindings

**Status:** Confirmed

Native artifacts retain direct external symbols for the linker. Foreign calls are unavailable on
the current LLVM-to-Wasm target, under the same reachability rule as
[TARGET-001](#target-001--intrinsic-availability-is-checked-only-for-the-selected-executable-closure).

Parsing, importing, indexing, or retaining an uncalled foreign declaration does not reject a
portable program, and a call in an unselected `static if` arm does not enter the closure. A
reachable foreign function contributes exactly one external declaration to a native artifact; an
unreachable one contributes nothing, as
[TARGET-002](#target-002--unreachable-target-specific-primitives-have-no-artifact-cost) requires.

**Boundary:** This does not grant WebAssembly an ambient linker or import convention. Foreign
imports and exports are native-only during the LLVM-first phase.

**Diagnostics:** LLVM-wasm foreign calls and foreign exports on a non-native target report
`SEM0193`, naming the symbol and requested target or surface, in the
[TARGET-003](#target-003--target-unavailability-is-a-compile-time-compatibility-error) shape. It
does not suggest catching a failure or adding an unsafe block.

**Current compiler:** Aligned. The executable origin collects reachable foreign calls beside
intrinsic calls. Native LLVM emission declares their C ABI symbols and records deterministic
metadata; LLVM-to-Wasm rejects the reachable operation before emission.

**Evidence:** [foreign function specification](../../../../openspec/specs/bootstrap-foreign-functions/spec.md),
[C ABI classification](../../../../packages/compiler/src/CAbi.ts).

### FFI-008 — `export "C"` publishes one C-callable symbol behind a generated thunk

**Status:** Confirmed

Source syntax:

```silk,ignore
export "C" fn silk_test_double_v1(value: i32) -> i32 {
  return value * 2
}

pub export "C" fn add(left: i32, right: i32) -> i32 as "silk_test_add_v1" {
  return left + right
}
```

An exported function is an ordinary module-level Silk function with a body that native code may
also call. Like a foreign function it carries three separate identities:

- the **Silk name** (`silk_test_double_v1`, `add`), which source uses to resolve and call it;
- the **native symbol**, which is the `as` string when present and the Silk name otherwise; and
- the **ABI**, named by the string after `export`.

Only `"C"` is accepted as the ABI. The exported symbol names a compiler-generated thunk under the
target's C calling convention whose parameters and result follow the classified C signature. The
Silk implementation keeps its private compiler-versioned symbol and lane-flattened internal ABI;
the thunk's only body is one direct call to it. The internal symbol is never the exported one, so
a later representation change never leaks into a published ABI. Silk callers call the function as
any other function and never go through the thunk. `pub` keeps its Silk module-visibility meaning
and is neither implied by nor implies native export: a private exported function is still a native
symbol, and a `pub` function without `export` is not.

**Boundary:** Renaming with `as` creates no declaration under the symbol's spelling; `add` above
defines no native symbol named `add`. A native executable requires `main` and treats exports as
additional roots. A native shared or static library instead requires at least one export, roots
reachability at all exports, and synthesizes no process entry. Only export thunks have default
visibility in a shared library; their compiler implementations and runtime support stay hidden.
Generated C headers remain a separate proposal. Pointer and function-pointer parameters and
results are forwarded through the thunk unchanged. There is no `unsafe export`:
unsafety is a caller-side Silk contract that a C caller cannot acknowledge.

**Diagnostics:** An ABI string other than `"C"` reports `SEM0185` at the string and publishes no
callable. A missing body is a parser diagnostic, because the exported form has no bodiless shape.

**Current compiler:** Aligned. `export` is a complete-identifier keyword accepted in the same
declaration slot as `extern`; collection records the ABI and symbol as header facts on an ordinary
function declaration, and the native backend declares one external C-calling-convention thunk per
export that forwards its scalar lanes to the implementation.

**Evidence:** [export specification](../../../../openspec/changes/add-export-c-functions/specs/bootstrap-foreign-functions/spec.md),
[declaration collection](../../../../packages/compiler/src/DeclarationCollection.ts),
[native program emission](../../../../packages/compiler/src/NativeProgram.ts).

### FFI-009 — Exported signatures and contracts follow the foreign admission rules

**Status:** Confirmed

Each parameter and the result of an exported function passes the same V1 foreign-ABI admission
relation as a foreign function under
[FFI-003](#ffi-003--foreign-signatures-admit-only-the-c-compatible-scalar-subset): `()` as the
result only, exact-width integers, target-width `isize` and `usize`, `f32` and `f64`, and raw
pointers, all by value. An exported function cannot declare type parameters, a `where` clause, a failure row, a
requirement row, the `effect` kind, the `static` phase, or the `unsafe` qualifier, and its body
cannot suspend.

```silk,ignore
export "C" fn bad() -> string { return "" }
export "C" effect fn bad() -> () { return () }
unsafe export "C" fn bad(value: i32) -> i32 { return value }
```

**Boundary:** The header restrictions are those of
[FFI-004](#ffi-004--foreign-declarations-carry-no-silk-only-contract-and-are-callable-only)
plus `unsafe`; the first-class restriction does not apply, because an exported function is an
ordinary Silk callable to Silk code. Suspension is a property of the body's realized MIR, not of
its spelling, so it is judged after lowering: a body that runs an Effect classified as anything
other than synchronous is rejected even when every header check passes.

**Diagnostics:** A parameter or result outside the subset reports `SEM0187` at the offending
type. Retained Silk-only syntax, `static`, or `unsafe` reports `SEM0188` at the offending syntax.
A suspending body reports `SEM0201` at the declaration, naming the suspending call; planning
constructs no artifact. A rejected export publishes no thunk.

**Current compiler:** Aligned. Completion runs the shared foreign admission and restriction checks
on the export header; the suspension check reads the MIR function's classification at the
planning gate, the same predicate the native backend uses to decide suspendability.

**Evidence:** [export specification](../../../../openspec/changes/add-export-c-functions/specs/bootstrap-foreign-functions/spec.md),
[declaration collection](../../../../packages/compiler/src/DeclarationCollection.ts),
[C ABI classification](../../../../packages/compiler/src/CAbi.ts),
[foreign planning](../../../../packages/compiler/src/ForeignPlanning.ts).

### FFI-010 — Exported functions are discovery roots on native targets

**Status:** Confirmed

Every `export "C"` declaration in the loaded module closure is an instance-discovery root when the
selected target is native, in addition to the entry. An export that no Silk code calls is still
specialized, verified, and emitted, because its consumer is native code the compiler cannot see.
Roots are collected in canonical module then declaration order; they are monomorphic by
[FFI-009](#ffi-009--exported-signatures-and-contracts-follow-the-foreign-admission-rules), so
no specialization arguments are needed.

Exports do not replace the entry: a native executable still requires the ordinary `main`, and the
driver, shim, and termination contract are unchanged.

**Boundary:** Availability is a property of the target kind, as in
[FFI-007](#ffi-007--foreign-functions-use-explicit-pay-for-use-bindings). On a WebAssembly target an
`export "C"` declaration anywhere in the loaded closure is rejected, even when nothing calls it,
because the declaration itself demands a native symbol.

**Diagnostics:** An export in the closure of a WebAssembly build reports `SEM0193`, naming the
symbol and the target, in the
[TARGET-003](#target-003--target-unavailability-is-a-compile-time-compatibility-error) shape, and
constructs no module.

**Current compiler:** Aligned. `Instances.discover` appends the export roots after the entry when
the target kind is native and records them on the discovery result; lowering copies the inventory
onto the MIR module, which is the only input the backends receive, and into the driver's cached
emission header.

**Evidence:** [export specification](../../../../openspec/changes/add-export-c-functions/specs/bootstrap-foreign-functions/spec.md),
[instance discovery](../../../../packages/compiler/src/Instances.ts),
[foreign planning](../../../../packages/compiler/src/ForeignPlanning.ts).

### FFI-011 — Export symbols are unique across imports and exports

**Status:** Confirmed

An export symbol obeys the spelling and reservation rules of
[FFI-005](#ffi-005--foreign-symbols-are-valid-unreserved-and-unique-per-executable): a non-empty
ASCII identifier that is not a symbol the compiler owns. Within one native artifact closure, two
exported declarations of one symbol are rejected, and an exported symbol equal to a reachable
foreign import's symbol is rejected, because the executable would both define and import one name.

```silk,ignore
unsafe extern "C" fn abs(value: i32) -> i32

export "C" fn abs(value: i32) -> i32 { return value }
```

The artifact records every export with its symbol and classified C signature, sorted by symbol,
beside the foreign imports. That inventory is the source of the generated headers and ABI
manifests described by [FFI-014](#ffi-014--native-libraries-publish-c-interface-companions).

**Boundary:** Two foreign imports of one symbol agree when their C signatures match; two exports
never do, because each would define the symbol. An export in a module that is not loaded into
the closure contributes nothing and conflicts with nothing.

**Diagnostics:** An invalid spelling reports `SEM0190` and a reserved symbol `SEM0191`, at the `as`
string or, without `as`, at the declaration. A duplicate export or an export coinciding with an
import reports `SEM0192` at one declaration with a note relating the other; planning constructs no
artifact.

**Current compiler:** Aligned. Spelling and reservation are checked per module at the header; the
closure-wide symbol map over imports and exports is built at the planning gate before backend
construction, and the native backend populates the artifact's export inventory from the MIR
module.

**Evidence:** [export specification](../../../../openspec/specs/bootstrap-foreign-functions/spec.md),
[symbol spelling and reservation](../../../../packages/compiler/src/ForeignSymbol.ts),
[foreign planning](../../../../packages/compiler/src/ForeignPlanning.ts),
[native program emission](../../../../packages/compiler/src/NativeProgram.ts).

### FFI-012 — C function pointers are exact exported addresses

**Status:** Confirmed

`extern "C" fn(P...) -> R` is a distinct Copy type represented by one native address. It is not a
Silk `fn(P...) -> R` value: it has no environment, dynamic dispatch record, or ownership-bearing
capture. A named `export "C" fn` item contextually converts to the C function-pointer type only
when its signature and declared behavior match exactly and its body is synchronous with no type or value generics. Per-call lifetime binders are permitted.

```silk,ignore
import silk.pointer { Pointer }

unsafe extern "C" fn qsort(
  base: ?[*]mut i32,
  count: usize,
  size: usize,
  compare: extern "C" fn(*const i32, *const i32) -> i32
    with Intrinsic.foreign(memory: "read", locality: "arguments"),
) -> () with Intrinsic.foreign(callbacks: ("compare",))

unsafe export "C" fn compare(left: *const i32, right: *const i32) -> i32
  with Intrinsic.foreign(memory: "read", locality: "arguments") {
  let a = unsafe Pointer.read(left)
  let b = unsafe Pointer.read(right)
  if a < b { return -1 }
  if a > b { return 1 }
  return 0
}
```

The native backend supplies the address of the same C-ABI thunk published for external callers.
The address passes unchanged through the foreign call. Calling a runtime native pointer requires `unsafe` and uses a distinct guarded C-ABI indirect call. Ordinary functions, generic functions,
effect or suspending functions, naked machine functions, and anonymous or capturing callables never acquire a C callback address.

**Boundary:** Callback conversion is contextual; naming `compare` where a Silk callable is expected
still produces its ordinary Silk callable value. Imported foreign functions remain callable-only.
The LLVM-to-Wasm target rejects any reachable call whose signature contains a C function pointer
before emission and does not invent host addresses.

**Diagnostics:** A C function-pointer type containing any parameter or result outside the admitted
C subset reports `SEM0187` at that type wherever it is declared. An ineligible value at a C
callback conversion reports `SEM0207` at the value. An otherwise valid callback operation on a
non-native execution surface reports `SEM0193` with the foreign symbol and surface.

**Current compiler:** Aligned. Semantic analysis records the contextual address conversion, MIR
retains a dedicated foreign-address operation, and native lowering resolves it to the generated
export thunk. The native corpus calls libc `qsort` through a Silk comparator. The [synchronous callback contract](./synchronous-native-callbacks.md) defines invocation extent, reentrancy and boundary termination.

**Evidence:** [callback specification](../../../../openspec/specs/bootstrap-foreign-functions/spec.md),
[call resolution](../../../../packages/compiler/src/CallResolution.ts),
[native foreign lowering](../../../../packages/compiler/src/NativeForeignOperation.ts).

### FFI-013 — C statics are immutable bindings to native data symbols

**Status:** Confirmed

An imported data symbol is declared with `unsafe extern "C" static`; an exported definition uses
`export "C" static`. The optional `as` tail changes only the native symbol. The Silk binding cannot
be assigned, while a pointer stored in it retains the pointee mutability written by its type.

```silk,ignore
unsafe extern "C" static environment: ?[*]const ?[*]const u8 as "environ"
export "C" static silk_abi_version: u32 = 1
```

Reading an imported static requires a lexical unsafe boundary and loads the current value from the
external global. An exported static requires one matching integer or floating-point literal and
becomes an externally visible constant global. Native artifacts record imported and exported data
symbols, their C class, and direction in deterministic symbol order. Repeated imports with the
same classified C value type share one native global and one artifact record. Incompatible
imports, function/data collisions, duplicate exports, and import/export collisions are rejected.

**Boundary:** C statics are native-only. LLVM-to-Wasm reports a reachable read before emission and
never synthesizes ambient data. Unreferenced imports do not enter MIR or the
artifact; exports remain roots because an external C consumer can read them without Silk code doing
so.

**Diagnostics:** Invalid ABI types report `SEM0187`; invalid initializers report `SEM0086`; reads
outside an unsafe boundary report `SEM0082`; and reachable statics on non-native surfaces report
`SEM0208` naming the symbol and surface. Symbol spelling, reservation, and closure-wide collision
rules reuse `SEM0190`–`SEM0192`.

**Current compiler:** Aligned. The declaration surface, TIR/MIR, availability planner, LLVM global
emission, artifact metadata, and native shared/static-library acceptance all retain the same symbol
and C type.

**Evidence:** [data-symbol specification](../../../../openspec/specs/bootstrap-foreign-functions/spec.md),
[foreign-static lowering](../../../../packages/compiler/src/LowerExpression.ts),
[native program emission](../../../../packages/compiler/src/NativeProgram.ts).

### FFI-014 — Native libraries publish C interface companions

**Status:** Confirmed

A successful native shared- or static-library build writes `<package>.h` and
`<package>.abi.json` beside the platform library and reports all three durable paths. Executables
and WebAssembly modules write neither companion. Reusing cached backend emission regenerates both
files from the verified backend inventory, so the companions are byte-identical to an uncached
build and cannot retain stale package-specific names. Native final-artifact reuse requires complete
link-input accounting; the current toolchain model cannot establish that eligibility and therefore
performs the requested native link or archive operation on every build.

The header includes `<stdint.h>`, a package-derived include guard, and C++ `extern "C"` guards.
Integer classes use `intN_t` or `uintN_t`, floats use `float` or `double`, and no-argument functions
use `(void)`. V1 does not expose Silk pointee definitions: immutable and mutable pointers are
rendered as `const void *` and `void *`. Callback classes are rendered recursively as nested C
function-pointer declarators, preserving declarator precedence.

The UTF-8 manifest ends with one newline and has this versioned shape:

```json
{
  "silkForeignAbi": 4,
  "target": "aarch64-apple-darwin",
  "exports": [],
  "imports": []
}
```

Each entry has `kind`, `symbol`, `abi`, and lowercase `direction`. Function entries additionally
carry a required `variadic` boolean and fixed `parameters`, `result`, and a normalized `contract` containing memory, locality, noCapture/borrow/callbacks ordinals, optional returned ordinal, noReturn and forbidden unwind; data entries carry `type`. Obsolete schemas 1/2/3, missing variadic status, and unknown contract fields are rejected. Function-pointer type entries preserve nonnullness and normalized behavior; headers erase these non-C facts. Each direction array is sorted by
symbol and then kind, and target-sized integers have already been resolved to a fixed-width ABI
class before serialization.

**Current compiler:** Aligned. `CHeader` and `AbiManifest` render the verified backend inventories,
the driver invokes them on every native-library success path, and `NativeToolchain` atomically
commits the companions while removing the complete artifact set after a partial failure.

**Evidence:** [interface-artifact specification](../../../../openspec/specs/native-library-interface-artifacts/spec.md),
[header renderer](../../../../packages/compiler/src/CHeader.ts),
[manifest renderer](../../../../packages/compiler/src/AbiManifest.ts),
[driver](../../../../packages/compiler/src/Driver.ts).

### FFI-015 — The OS system clock is an ordinary libc boundary

**Status:** Confirmed

`silk/os_system_clock` declares the C-layout `Timespec` record and the libc functions
`clock_gettime` and `clock_getres` in ordinary Silk. Its service implementation calls those
functions with `CLOCK_REALTIME`, validates the returned fraction and resolution, and then constructs
the portable `SystemClock` values. Darwin and Linux use the same admitted C classes; Linux retains
the existing `glibc >= 2.17` baseline and needs no `librt` link.

The sealed intrinsic catalog has no system-clock operation, and the generated OS runtime owns no
`silk_os_system_clock_*` symbol. A reachable native system clock therefore contributes ordinary
foreign imports resolved by libc. LLVM-to-Wasm rejects the native-only provider rather than reading
ambient host time or inventing imports.

**Boundary:** `OsMonotonicClock` remains on its three target-neutral intrinsics until its separate
migration. Importing or constructing either provider remains inert; only reachable operations add
their respective foreign or runtime dependencies.

**Current compiler:** Aligned. The system-clock source owns the declarations and validation, the
foreign inventory identifies the libc functions, and the old intrinsic operations, reserved
runtime names, and generated C functions have been deleted.

**Evidence:** [clock-service specification](../../../../openspec/specs/bootstrap-clock-services/spec.md),
[system-clock source](../../../../packages/compiler/stdlib/silk/os_system_clock.silk),
[clock integration tests](../../../../packages/compiler/test/Clock.test.ts).

See [Integer C variadics](./integer-c-variadics) for true ellipsis declarations, integer promotions,
and the fixed versus unnamed parameter boundary on the admitted native targets.
