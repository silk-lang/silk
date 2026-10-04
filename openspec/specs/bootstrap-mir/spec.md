# bootstrap-mir Specification

## Purpose

MIR: the monomorphic, backend-neutral basic-block control-flow graph over logical Silk types that
the LLVM backend consumes — its data model, structural invariants and verifier,
the compiler-owned target/layout plan, and the deterministic textual encoder, stabilized against
hand-built samples before lowering exists.

## Requirements

### Requirement: MIR names and closes the selected entry explicitly

A MIR module SHALL retain an explicit entry descriptor independent of function order. An ordinary
entry descriptor SHALL identify the selected `i32` function. An effectful entry descriptor SHALL
identify the selected `()` Effect runner, its normalized failures, canonical report identities,
payload cleanup plans, and generated closing adapter. The verifier SHALL reject a missing,
ambiguous, signature-incompatible, open, or internally inconsistent descriptor before backend
emission.

#### Scenario: Encode an ordinary entry explicitly

- **WHEN** lowering receives an ordinary `main() -> i32`
- **THEN** MIR names its canonical instance as the entry without relying on its function ordinal

#### Scenario: Encode an effectful entry adapter

- **WHEN** lowering receives an effectful `main() -> () ! SomeError`
- **THEN** MIR contains a generated scalar adapter that runs the effect and closes success and failure outcomes

#### Scenario: Verify failure cleanup metadata

- **WHEN** an effect entry descriptor's failure type, tag, payload local, and cleanup plan disagree
- **THEN** MIR verification reports deterministic entry-adapter violations

#### Scenario: Encode entry metadata deterministically

- **WHEN** equivalent programs are lowered repeatedly
- **THEN** their entry descriptors, generated adapter, failure ordering, and MIR text are identical

### Requirement: MIR represents the complete integer family

MIR SHALL carry canonical integer logical types, exact constants, conversions, arithmetic modes, comparisons, bitwise operations, shifts, rotates, and recoverable checked outcomes. Verification SHALL reject mismatched types, widths, constants, modes, or layouts; encoding SHALL remain deterministic and backend-neutral.

#### Scenario: Verify wide addition

- **WHEN** MIR contains valid checked `u64` addition
- **THEN** verification accepts one exact backend-neutral operation

#### Scenario: Reject a malformed conversion

- **WHEN** a conversion operand disagrees with its declared source type
- **THEN** verification reports the mismatch before emission

### Requirement: MIR represents unit and bottom without payloads

MIR SHALL use zero result lanes for unit and permit `never` only on non-returning paths.

#### Scenario: Lower bare return

- **WHEN** a unit function executes bare `return`
- **THEN** MIR terminates with no scalar result local

### Requirement: MIR is a backend-neutral structured control DAG over logical types

A MIR module SHALL represent each function as a structured control DAG over logical Silk types and
typed locals. Ordered operation blocks, conditional regions, loop regions, cleanup regions, and
terminal outcomes SHALL retain canonical identities and provenance. Child and continuation edges
MUST be acyclic and deterministically ordered. Repetition SHALL exist only as the semantics of an
explicit loop region whose condition and body are themselves DAG regions; arbitrary block back-edges
MUST fail verification.

MIR SHALL carry the compiler-selected target and layout plan but MUST NOT contain LLVM or WebAssembly
types, instructions, labels, nesting depths, or backend-owned physical representations. A backend
SHALL receive the preserved DAG and convert it into its own control form without recovering source
structure from flattened control flow.

#### Scenario: Model a straight-line function

- **WHEN** a hand-built function returns a called constant
- **THEN** its entry region contains ordered literal and call operations ending in a return outcome over logical `i32`

#### Scenario: Model structured repetition without a cycle

- **WHEN** MIR represents a `while` loop with a conditional `continue` and `break`
- **THEN** one loop region owns acyclic condition and body regions whose terminal outcomes name repeat or exit ports without a graph back-edge

#### Scenario: Reject an arbitrary cycle

- **WHEN** a hand-built MIR region directly or indirectly lists itself as a child or continuation
- **THEN** verification reports the cycle deterministically before emission

### Requirement: Every operation carries provenance

Every MIR operation and terminator SHALL carry a source span, and compiler-generated operations
SHALL inherit the nearest causative span and be explicitly marked generated.

#### Scenario: Mark generated cleanup

- **WHEN** a sample models compiler-generated drops in a cleanup block
- **THEN** each drop carries its causative span and an explicit generated marker, while programmer-written operations are unmarked

### Requirement: The verifier reports structural violations as data

A MIR verifier SHALL check structural invariants — a present entry block, terminator targets
naming existing blocks, and every referenced local being declared — and SHALL return an ordered,
deterministic collection of violations rather than throwing. Valid samples SHALL verify clean.

#### Scenario: Verify the samples clean

- **WHEN** the hand-built sample modules are verified
- **THEN** the verifier returns no violations

#### Scenario: Report a broken graph deterministically

- **WHEN** a module references a missing block and an undeclared local
- **THEN** the verifier returns both violations in deterministic order with their function and block identities

### Requirement: MIR encodes deterministically

MIR SHALL expose a deterministic textual encoder covering the selected target, complete ordered
layout table, functions, blocks, operations, terminators, types, and provenance including generated
markers. Identical target-aware modules SHALL encode byte-identically across fresh processes, gated
by committed golden files over the hand-built samples.

#### Scenario: Match the MIR golden encodings

- **WHEN** the hand-built samples are encoded
- **THEN** each encoding includes the canonical target and layout table and equals its committed golden text byte-for-byte

#### Scenario: Repeat encoding

- **WHEN** the same target-aware sample is constructed and encoded repeatedly in fresh processes
- **THEN** the encoded texts are byte-identical

### Requirement: MIR carries the completed compiler layout plan

Every lowered MIR program SHALL carry exactly one complete layout plan containing its canonical
target and the entries computed for its discovered runtime instances. The verifier SHALL reject a
program whose function types or operations reference a runtime type missing from the plan or whose
scalar facts conflict with the plan's target profile. MIR MUST NOT duplicate the target outside the
plan.

#### Scenario: Lower with the completed plan

- **WHEN** discovered instances using `i32` and `bool` lower successfully
- **THEN** the resulting MIR program carries the selected target and verified entries for both types

#### Scenario: Reject a missing type layout

- **WHEN** a hand-built MIR program uses `bool` but omits its layout entry
- **THEN** verification reports the missing layout deterministically as data

### Requirement: Lowering constructs MIR from elaborated instances

Lowering SHALL construct one MIR program module from the discovered instances in discovery
order: each instance's HIR body linearized into basic blocks in evaluation order (arguments
before their call, statements in source order), each `let` binding materialized as one typed
local, and concrete drops inserted exactly as the ownership phase's cleanup plan directs —
one generated `Drop` per release, in the plan's release order, before the exit's terminator.
Source provenance SHALL be attached to every lowered operation. Lowering SHALL NOT substitute a
trap or fabricated body for an instance it cannot lower: when emitted code references an instance
whose valid body native lowering does not support, the program SHALL be rejected with diagnostic
`SEM0219` at that body, and an unreferenced unlowerable instance SHALL be omitted. An ownership
violation never reaches lowering, because the ownership checker rejects the program first. Lowered programs SHALL verify clean against the MIR
structural verifier and SHALL encode deterministically, gated by committed golden files.

#### Scenario: Lower a nested call program

- **WHEN** `main` returning `identity(identity(42))` is lowered
- **THEN** the program contains `main` and `identity` functions whose blocks evaluate arguments before calls, reference canonical targets, and end in returns, verifying clean

#### Scenario: Diagnose a referenced body that native lowering lacks

- **WHEN** emitted code references a discovered instance whose valid body native lowering does not support
- **THEN** lowering produces no MIR program and reports `SEM0219` at that body's span

#### Scenario: Match the lowered golden encoding

- **WHEN** a committed fixture program is lowered and encoded
- **THEN** the encoding equals the committed golden text byte-for-byte and repeated fresh runs are byte-identical

#### Scenario: Lower bindings to locals with exit drops

- **WHEN** a body binding `first` and `second` and returning a call result is lowered
- **THEN** each binding occupies one typed local, and the return exit carries generated `Drop` operations for `second` then `first` before the return terminator, each with its causative span and generated marker

### Requirement: Binary arithmetic is a trapping MIR operation

MIR SHALL represent arithmetic as one binary operation carrying the closed operator (`Add`,
`Subtract`, `Multiply`, `Divide`, `Remainder`), typed left and right operand locals, a typed
destination local, and provenance. The operation's semantics SHALL be trapping: signed overflow,
division by zero, and `-2147483648` divided or remaindered by `-1` abort the function exactly
like an explicit trap terminator, in every build mode. Division SHALL truncate toward zero and
remainder SHALL take the dividend's sign. Lowering SHALL map HIR builtin calls to binary
operations after their operands, the verifier SHALL check operand and destination locals like
every other operation, and the encoder SHALL cover the operator vocabulary, gated by committed
golden files.

#### Scenario: Lower a built-in call to a binary operation

- **WHEN** `main` returning `i32.add(40, 2)` is lowered
- **THEN** the block computes both literal operands and one `Add` binary operation into the returned local, verifying clean

#### Scenario: Verify binary operand references

- **WHEN** a hand-built module's binary operation references an undeclared local
- **THEN** the verifier reports that violation deterministically

#### Scenario: Match the arithmetic golden encoding

- **WHEN** a committed arithmetic fixture is lowered and encoded
- **THEN** the encoding equals the committed golden text byte-for-byte, naming each binary operator

### Requirement: Comparisons and user branches lower to real control flow

The MIR type vocabulary SHALL grow to `i32` and `bool`, and the binary operator vocabulary SHALL
grow with the non-trapping comparisons `Equals`, `NotEquals`, `LessThan`, `LessOrEqual`,
`GreaterThan`, and `GreaterOrEqual`, producing `bool` from two `i32` operands. `bool.not` SHALL
lower through existing operations rather than a new operation kind. Lowering a conditional
statement SHALL produce a user-authored `Branch` terminator on the condition local, arm blocks
in taken-then-otherwise order, and a join block where fall-through control continues; arm-local
drops follow the cleanup plan, and lowered programs SHALL verify clean and encode
deterministically, gated by committed golden files.

#### Scenario: Lower a conditional to a diamond

- **WHEN** `pub fn main() -> i32 { if i32.equals(1, 1) { return 1 } return 0 }` is lowered
- **THEN** the entry block computes the comparison and ends in a branch whose taken block returns `1` and whose otherwise path reaches the trailing return, verifying clean

#### Scenario: Keep comparisons non-trapping

- **WHEN** any comparison operation executes at any operand values
- **THEN** it produces a boolean result and never traps

#### Scenario: Match the branching golden encoding

- **WHEN** the committed conditional fixture is lowered and encoded
- **THEN** the encoding equals the committed golden text byte-for-byte

### Requirement: MIR carries canonical nominal logical types

MIR locals, parameters, call results, and function results SHALL accept canonical nominal struct
types alongside built-in scalar types. Nominal identity SHALL remain the defining module and
declaration name; MIR MUST NOT replace it with structural field shapes, physical offsets, or backend
types. Every nominal MIR type SHALL have the same reachable catalog entry and calling shape in the
program's completed layout plan.

#### Scenario: Lower a nominal factory contract

- **WHEN** a reachable factory returns `Token`
- **THEN** its MIR result and every receiving local carry the canonical `Token` logical type and reference one selected plan entry

### Requirement: Aggregate construction and projection are explicit MIR operations

MIR SHALL represent construction as one destination nominal local plus declaration-ordered source
locals identified by canonical fields. MIR SHALL represent projection as one typed destination,
one nominal source local, and one canonical field identity. Whole-value moves, calls, returns, and
drops SHALL continue to use ordinary MIR operations over the widened logical type vocabulary.

#### Scenario: Lower a reordered literal canonically

- **WHEN** HIR constructs a struct whose source initializers were reordered
- **THEN** MIR construction operands follow canonical declaration order with their field identities and source provenance

#### Scenario: Lower a chained projection

- **WHEN** HIR reads `token.span.start`
- **THEN** MIR contains two ordered projection operations whose intermediate and final locals have the declared nominal and scalar types

#### Scenario: Lower whole-value cleanup

- **WHEN** ownership plans a live aggregate release
- **THEN** MIR emits one whole-value drop carrying generated provenance and no per-backend cleanup decision

### Requirement: MIR verifies aggregate consistency

MIR verification SHALL reject aggregate operations whose nominal type, field identity, operand type,
declaration order, layout entry, calling shape, or local type disagree. It SHALL also reject a
nominal call or return that does not match the compiler-selected lane shape. Violations SHALL remain
ordered deterministic data.

#### Scenario: Reject a mismatched construction field

- **WHEN** a construction operand names a field from another nominal type
- **THEN** verification reports the canonical field/type mismatch before emission

#### Scenario: Reject a missing aggregate ABI shape

- **WHEN** a nominal parameter or result lacks its selected calling shape
- **THEN** verification reports the missing plan fact and no backend receives the module

### Requirement: Aggregate MIR encoding is deterministic

The textual MIR encoding SHALL include canonical nominal types, field identities, construction and
projection operands, whole-value moves and drops, calling shapes, and provenance in stable order.
Equivalent aggregate programs SHALL encode byte-identically across fresh processes.

#### Scenario: Repeat aggregate MIR lowering

- **WHEN** one nested construction-and-projection program is lowered repeatedly
- **THEN** its logical types, operations, lane shapes, field order, and encoding are byte-identical

### Requirement: MIR carries canonical logical array types

MIR locals, parameters, calls, and function results SHALL accept logical arrays identified by
canonical element type and length. Every reachable array use SHALL reference the same selected layout
and calling shape; MIR MUST NOT replace an array with an untyped scalar bundle.

#### Scenario: Lower an array factory

- **WHEN** a reachable function returns `Array<i32, 3>`
- **THEN** its MIR result and receiving locals retain that exact logical array type

### Requirement: Array construction and checked indexing are explicit MIR operations

MIR SHALL represent complete array construction with ascending canonical element operands. It SHALL
lower each readable Copy place chain to one checked read carrying the root aggregate local, ordered
field or index selectors, every dynamic `i32` index local and canonical length, the final Copy result
type, and exact trap provenance. Non-Copy intermediate aggregates MUST NOT become independently
owned locals. Whole moves, calls, returns, and drops SHALL continue to use ordinary operations over
complete logical values.

#### Scenario: Lower a dynamic index

- **WHEN** HIR indexes an array with a parameter
- **THEN** MIR contains one checked place read that either produces the final Copy value or traps at the index span

### Requirement: MIR verifies array consistency deterministically

Verification SHALL reject array operations whose element count, operand type, index type, canonical
length, selector path, layout entry, calling shape, destination type, or whole-value ownership mode
disagrees. Text encoding SHALL include canonical array types, lengths, selectors, operations, and
provenance in stable order.

#### Scenario: Reject a malformed construction

- **WHEN** an `Array<i32, 3>` construction carries two operands
- **THEN** verification reports the exact completeness violation before emission

### Requirement: MIR writes replace typed places explicitly

MIR SHALL represent assignment as one checked `WritePlace` carrying the root local, ordered field and
index selectors, dynamic index locals and canonical lengths, exact destination and source types,
replacement cleanup, and provenance. Place checks and right-hand evaluation SHALL precede the commit,
and the verifier SHALL reject inconsistent mutability, selectors, types, layouts, calling shapes, or
cleanup modes.

#### Scenario: Lower an array element replacement

- **WHEN** HIR assigns a complete value to `values[index]`
- **THEN** MIR checks the index and evaluates the source before one verified write commits

### Requirement: MIR loop outcomes preserve lexical cleanup

Each loop region SHALL expose canonical repeat and exit outcomes. Lowering SHALL map body fallthrough
and `continue` to repeat, `break` to exit, and `return` to the function outcome through the exact
cleanup regions selected by ownership. Cleanup sharing MAY make the representation a DAG rather than
a tree, but every owner SHALL be released at most once on any execution path.

#### Scenario: Lower continue through cleanup

- **WHEN** an iteration-local owner is live at `continue`
- **THEN** the transfer traverses its cleanup region before reaching the loop repeat outcome

### Requirement: Control DAG verification and encoding are deterministic

Verification SHALL reject missing or duplicate region identities, cyclic child/continuation edges,
invalid lexical transfer targets, incompatible loop-header locals, unreachable required outcomes,
and operation/type/layout disagreements as ordered data. Text encoding SHALL traverse regions in one
canonical topological order and encode structured children, outcomes, selectors, cleanup, and
provenance identically across fresh processes.

#### Scenario: Repeat loop encoding

- **WHEN** one nested mutable-loop program is lowered repeatedly in fresh processes
- **THEN** its region identities, topological order, operations, outcomes, and textual bytes are identical

### Requirement: MIR carries canonical logical union types

MIR SHALL represent a union as its normalized ordered ordinary member set while referencing the
compiler-selected layout and calling shape for physical facts. Locals, contracts, struct fields,
arrays, writes, calls, returns, and drops SHALL preserve that logical type. MIR MUST NOT contain
source spelling order, aliases, backend types, numeric tags chosen outside the layout plan, or
backend-local control labels.

#### Scenario: Lower an aggregate-contained union

- **WHEN** HIR constructs and transports a struct whose field is `i32 | Array<i32, 2> | Token`
- **THEN** MIR retains one canonical logical union type and the program's matching layout-plan entry

### Requirement: MIR union conversion carries a total member mapping

MIR SHALL lower ordinary-member injection and union widening to an explicit verified conversion
operation containing source and destination locals, exact represented source and target logical
types, a total canonical source-member to target-member mapping, layout/calling-shape references,
access mode, and provenance. The verifier SHALL reject unsorted or duplicate members,
non-containing targets, incomplete or incorrect mappings, inconsistent locals or layouts, and
conversions that would narrow.

#### Scenario: Lower nominal injection

- **WHEN** HIR injects an ordinary value such as `i32` or `Token` into `i32 | Token`
- **THEN** MIR contains one conversion mapping its exact source type to the compiler-planned target member

#### Scenario: Lower represented executable injection

- **WHEN** HIR injects an exact callable or opaque Effect value into a compatible union
- **THEN** MIR preserves its finite representation plan and maps it to the public canonical member

#### Scenario: Lower union widening

- **WHEN** HIR widens `i32 | Token` to `i32 | Token | Fault`
- **THEN** MIR maps every source member exactly once while preserving the structured control DAG

#### Scenario: Reject an incomplete widening map

- **WHEN** malformed MIR omits or duplicates one source member mapping
- **THEN** verification rejects the conversion before backend emission

### Requirement: Union MIR encoding is deterministic

Text encoding SHALL include canonical union types, members, conversion mappings, layout references,
active-member cleanup plans, and provenance in stable order. Equivalent programs SHALL produce
byte-identical MIR across fresh processes without materializing mutable graph identity.

#### Scenario: Repeat a widening encoding

- **WHEN** one program injects, stores, widens, and drops a union in repeated fresh compilations
- **THEN** its MIR type keys, mappings, regions, cleanup, and textual bytes are identical

### Requirement: MIR carries verified logical match regions

MIR SHALL represent a match as one evaluated scrutinee local, exact logical type and access mode,
canonical member cases in source decision order, optional guard regions, pattern-bound locals,
per-arm expression or ordinary statement regions, their completion and cleanup outcomes, and one typed match outcome. A normally completing block SHALL supply unit with zero payload lanes. Only normally completing paths SHALL assign or access a join destination; a returning, failing, breaking, continuing, or otherwise noncompleting path SHALL transfer without reading an uninitialized result or executing continuation-only operations. An all-noncompleting match SHALL require no joined result local. Member cases SHALL reference the
compiler layout plan while omitting source aliases, public numeric tags, backend types, target
blocks, branch depths, and arbitrary cyclic edges.

#### Scenario: Lower a complete two-member match

- **WHEN** HIR exhaustively matches `Token | End` with two unguarded arms
- **THEN** MIR contains one structured acyclic selection whose cases produce one verified joined result local

#### Scenario: Keep guarded member order

- **WHEN** two guarded arms and one unguarded fallback arm target the same nominal member
- **THEN** MIR preserves their source decision order and guard fallthrough without duplicating the scrutinee payload

#### Scenario: Lower selected statements with unit completion

- **WHEN** a selected ordinary block performs several statements and reaches its closing brace
- **THEN** MIR preserves statement order, produces unit without payload storage, and continues the enclosing body without a synthesized return

#### Scenario: Stop a containing expression on transfer

- **WHEN** a match nested in an argument, initializer, assignment operand, or return operand has a selected block that transfers
- **THEN** MIR terminates that path before later operands, call execution, initializer storage, destination replacement, or later statements; earlier acquired resources receive exactly their transfer cleanup

#### Scenario: Join a scalar only on its completing path

- **WHEN** one match arm returns from the enclosing body and another produces `i32`
- **THEN** only the scalar-producing path initializes the scalar join destination and no transfer path reads or writes it

### Requirement: MIR verifies match coverage bindings and cleanup

Verification SHALL reject a match whose scrutinee or result local disagrees with its logical type or
layout, whose member cases are invalid or non-exhaustive, whose source decision order contradicts
the semantic coverage facts, whose pattern field or binding types disagree, whose normally completing guard paths do not produce
`bool`, whose access mode violates ownership metadata, or whose arm result and cleanup outcomes do
not agree with the declared completion and transfer outcomes. Verification SHALL reject a join read without a value on every reaching path, a join assignment on a noncompleting path, or continuation-only operations or cleanup attached to an unconditional transfer. Violations SHALL be deterministic data produced before
backend emission.

#### Scenario: Reject a missing member case

- **WHEN** hand-built MIR omits one required unguarded member and has no universal case
- **THEN** verification identifies the exact uncovered canonical member

#### Scenario: Reject an escaping borrow local

- **WHEN** a match-local shared or exclusive binding is referenced outside its arm region
- **THEN** verification reports its arm boundary and no backend receives the program

#### Scenario: Reject use after noncompletion

- **WHEN** hand-built MIR reads a required match result after an arm transfers without reaching the join or attaches later argument evaluation to that transfer path
- **THEN** verification reports the inconsistent path and result provenance before backend emission

#### Scenario: Transfer while evaluating a guard

- **WHEN** a guard contains a nested match whose selected block transfers from the enclosing computation or loop
- **THEN** MIR takes that exit with applicable cleanup and executes no later candidate; only a normally completing Boolean-false guard advances candidates, and an all-transferring guard requires no Boolean result local

### Requirement: Match MIR encoding is deterministic

Text encoding SHALL include scrutinee and result types, access mode, source-ordered decisions,
canonical members, pattern paths, guards, bound locals, cleanup, arm outcomes, join relationships,
and provenance in stable topological order. Equivalent exhaustive matches SHALL encode
byte-identically across fresh processes.

#### Scenario: Repeat guarded match lowering

- **WHEN** one guarded and destructuring match is lowered repeatedly
- **THEN** its member decisions, regions, bindings, cleanup, join, and encoded bytes are identical

### Requirement: MIR contains only monomorphic generic instances

MIR lowering SHALL consume verified concrete instance keys and substitute every parameterized
logical type and operation before constructing the structured control DAG. Each function SHALL
retain provenance naming its generic declaration and concrete arguments, while the verifier MUST
reject open type parameters or missing concrete layout entries.

#### Scenario: Lower a concrete identity

- **WHEN** discovery supplies `identity<Token>`
- **THEN** MIR contains one concrete Token-typed function whose provenance names the generic declaration and `Token` argument

#### Scenario: Reject open generic MIR

- **WHEN** a malformed MIR function still contains type parameter `T`
- **THEN** verification rejects it before backend emission

### Requirement: MIR represents Effect and owned allocation in the structured DAG

MIR SHALL represent effect entry, capture access, retry, typed outcomes, provider acquisition,
validated allocation, raw-buffer slot operations, initialization commit or rollback, explicit drop,
and automatic Drop as ordered regions and operations in the existing acyclic structured control DAG.
It MUST NOT encode source named scopes, dynamic cleanup registries, or backend control structures.

MIR SHALL carry the compiler-selected hidden Effect instance and capture-environment plan separately
from its success/failure outcome. Running a statically known instance SHALL call its generated runner
without universal runtime Effect dispatch.

#### Scenario: Encode a failed append attempt

- **WHEN** Vector growth fails with OutOfMemoryError inside a retried Effect
- **THEN** MIR orders failed acquisition, rollback of attempt-local owners, failure propagation, and retry without a leaked allocation or cyclic MIR edge

### Requirement: MIR represents typed outcomes in the structured DAG

MIR SHALL represent flow calls, success returns, nominal failure returns, propagation, and catch
dispatch as explicit target-aware structured operations and outcomes. Verification SHALL reject row,
tag, payload, calling-shape, ownership, cleanup, or target inconsistencies before execution. The
compiler representation SHALL remain a DAG.

#### Scenario: Verify propagation cleanup

- **WHEN** a flow call may fail after earlier locals became live
- **THEN** MIR contains distinct success and failure continuations with cleanup before forwarding the failure

#### Scenario: Reject a forged failure tag

- **WHEN** malformed MIR associates a payload with another nominal member's tag
- **THEN** verification rejects it before backend emission

### Requirement: MIR represents slice loans in the structured control DAG

Concrete monomorphic slice types SHALL remain logical shared or exclusive slice types in MIR. Slice
formation SHALL identify one stable backing place, loan identity, access mode, element type, and
lexical region; loan endings SHALL be explicit ordered facts on every structured exit. These
operations SHALL remain inside the existing acyclic operation and region structure, including when
loops later repeat through lexical outcomes, and MUST NOT expose a source-level raw pointer. Slice
formation SHALL retain compiler-owned temporary roots and complete field or fixed-array element
selectors. Runtime element selectors SHALL be bounds checked before address formation, and
temporary cleanup SHALL occur after the matching loan end.

#### Scenario: Lower a call-scoped borrow

- **WHEN** HIR passes one whole-array borrow to an ordinary function
- **THEN** MIR orders slice formation before the call and the matching loan end after the call in the same structured region

#### Scenario: End an iteration-local loan before repetition

- **WHEN** a loop body forms a call-scoped slice and reaches `continue`
- **THEN** the loan ends before the loop's lexical repeat outcome without introducing a cyclic MIR edge

#### Scenario: Lower a runtime indexed subplace

- **WHEN** HIR borrows `&mut matrix[index]`
- **THEN** MIR begins the loan from `matrix` with its checked element selector and never materializes a copied inner array

#### Scenario: Clean a temporary after its loan

- **WHEN** an addressable temporary contains values with cleanup obligations
- **THEN** MIR orders the matching loan end before the temporary owner's ordinary drop plan

### Requirement: MIR slice places derive bounds from one slice value

Length, check, read, projection, and write operations for a slice SHALL derive the backing address,
runtime length, access mode, and element type from the same verified slice local. Runtime indexing
MUST use unsigned `i32` comparison semantics so negative values and values at or above length trap.
An exclusive write SHALL validate its destination before evaluating the replacement and SHALL
commit only after displaced-value cleanup.

#### Scenario: Verify one runtime-bounded place

- **WHEN** MIR reads `slice[index].field`
- **THEN** verification proves that the check and place projection use the same slice local and canonical element-field path

#### Scenario: Reject mismatched slice bounds

- **WHEN** malformed MIR attempts to check against one slice but address through another slice or a fixed constant
- **THEN** MIR verification reports the inconsistency before backend emission

### Requirement: MIR verifies loan conflicts and cleanup order

MIR verification SHALL reject an owner move, direct access, write, or drop that conflicts with a
live loan; duplicate exclusive access; a missing or duplicate loan end; and cleanup scheduled before
the last applicable loan end. Shared and exclusive slices SHALL have the same runtime shape even
though their verified access permissions differ.

#### Scenario: Reject owner cleanup during a loan

- **WHEN** malformed MIR drops an array root before ending its live slice loan
- **THEN** verification identifies the owner, loan, and invalid operation without delegating borrow safety to a backend

### Requirement: MIR represents target-selected usize values in the DAG

MIR SHALL represent `usize` literals and operations with the selected compiler-owned unsigned word
lane. Verification SHALL reject out-of-range literals, mismatched operand widths or types, signed
comparison/division semantics, and arithmetic results lacking the required overflow or underflow
trap behavior. The structured control representation SHALL remain a DAG.

#### Scenario: Reject a mismatched word lane

- **WHEN** malformed native MIR assigns a 32-bit lane to `usize`
- **THEN** verification rejects it before backend emission

### Requirement: MIR represents callable environments in the structured DAG

MIR SHALL represent monomorphic callable construction, ordered captures, shared, exclusive, or
consuming environment access, direct or indirect application, and cleanup as typed operations and
regions in the existing backend-neutral acyclic control DAG. Verification SHALL reject open generic
callables, mismatched callable signatures, invalid invocation modes, duplicate capture transfers,
and cleanup that can occur before a retained dependency is released. Callable environments SHALL
keep capture evaluation order and original parameter ordinals as separate facts, so backends can
store captures in construction order and invoke targets in parameter order.

#### Scenario: Lower a reusable arithmetic section

- **WHEN** a stored `i32.add(2)` section reaches runtime
- **THEN** MIR contains one concrete callable environment and typed unary application without a surface pipeline operation

#### Scenario: Verify a consuming environment

- **WHEN** malformed MIR invokes a take-once environment twice
- **THEN** verification rejects the second application before backend emission

#### Scenario: Lower staged positional captures

- **WHEN** a three-parameter callable captures parameter two and then parameter one
- **THEN** MIR constructs captures in that order and applies them in original parameter order after parameter zero

### Requirement: MIR run order follows the elaborated operand

Lowering SHALL place `run` around the complete elaborated Effect operand chosen by syntax and HIR,
including every ungrouped pipeline combinator. Grouped run results SHALL remain ordinary values that
may feed later callable applications.

#### Scenario: Retry before run

- **WHEN** source spells `run attempt |> Effect.retry(2)`
- **THEN** MIR constructs the retry composition before entering its run region

### Requirement: MIR verifies allocation and cleanup as a structured DAG

MIR SHALL contain compiler-planned operations and regions for checked layout formation, general
allocator witness dispatch, typed allocation outcomes, self-contained reclaim authority, raw typed
buffer construction, lexical Slot projection and value operations, shared bounds-checked reads of
recursively Copy elements including structural unions, initialization commit or rollback,
restricted Drop calls, explicit drop, and automatic field cleanup. A structural-union copy SHALL
retain its canonical sum type, active-member tag lane, complete payload lanes, and source/result
provenance. Verification SHALL reject layout/type/provenance mismatch, slot escape, conflicting live
loans, a shared read without shared buffer and canonical Copy-element provenance, a union copy with
any non-Copy member, use after consumption, invalid hook contracts, missing cleanup on a structured
exit, duplicate release, and allocator-kind or named-scope operations. Runtime initializedness
inside an unsafe buffer remains an unsafe program invariant rather than a verifier claim.

#### Scenario: Encode an exhausted construction attempt

- **WHEN** allocation fails before a construction guard receives storage
- **THEN** MIR carries the `OutOfMemoryError` branch with cleanup for earlier live owners and no allocation release operation for the rejected request

#### Scenario: Encode partial rollback

- **WHEN** a later typed failure exits after a guard initialized a prefix
- **THEN** the DAG orders the guard hook, initialized-element destruction, allocation release, and unchanged failure propagation without a control back-edge

#### Scenario: Reject forged reclaim authority

- **WHEN** malformed MIR attaches a release operation to a different allocation identity or inactive ticket
- **THEN** verification rejects the program before backend emission

#### Scenario: Preserve a shared structural-union read

- **WHEN** HIR contains a valid shared raw-buffer read of a structural union whose members are all Copy
- **THEN** MIR records the buffer, index, canonical union element and result types, checked bounds, shared access, and source provenance without a Slot or storage-state transition

#### Scenario: Reject a structural-union read with a move-only member

- **WHEN** malformed MIR requests a Slot or shared raw-buffer copy for a union containing one non-Copy member
- **THEN** verification rejects the operation before backend emission

### Requirement: MIR represents floating values and operations

MIR SHALL carry canonical float constants, arithmetic, comparisons, classification, total order, reinterpretation, and conversions with explicit width and provenance. Verification SHALL reject mismatched widths/types and deterministic encoding SHALL preserve exact constant bits.

#### Scenario: Verify f64 reinterpretation

- **WHEN** MIR reinterprets `f64` as `u64` with matching layouts
- **THEN** verification accepts one backend-neutral bit operation

### Requirement: MIR represents deterministic static data

MIR SHALL carry a canonical ordered static-data table plus immutable views with `usize` lengths. Verification SHALL reject mismatched contents, lengths, mutability, or missing entries; encoding SHALL remain deterministic.

#### Scenario: Verify a literal view

- **WHEN** a view references a static-data entry with matching length
- **THEN** MIR verification accepts it without an allocation operation

### Requirement: MIR represents explicit byte writes

MIR SHALL represent an ordered effectful write over a destination and immutable byte view with typed failure. It MUST NOT encode file descriptors, JavaScript console calls, log metadata, or backend import names.

#### Scenario: Lower stdout write

- **WHEN** HIR writes bytes to stdout
- **THEN** MIR contains one target-neutral write operation after the byte view is available

### Requirement: MIR represents indexed static-byte reads

MIR SHALL allow a checked slice-element selector whose root is a canonical immutable static byte
view, retain its static-data identity, `usize` length, index local, and source provenance, and produce
one `u8`. Verification SHALL reject selectors whose root is neither a compatible runtime slice nor
a static byte view.

#### Scenario: Verify a static byte selector

- **WHEN** a valid static byte literal is indexed by a runtime `usize`
- **THEN** MIR verification accepts the checked read and its canonical static-data reference

#### Scenario: Reject an incompatible selector root

- **WHEN** malformed MIR applies a static-byte selector to a scalar or aggregate root
- **THEN** verification rejects the module before backend emission

### Requirement: MIR represents floating transcendental operations

MIR SHALL carry explicit width-specific `Sin` and `Cos` operations with one floating operand,
same-width result, and source provenance. Verification SHALL reject integer operands, width
mismatches, and unknown transcendental operation names; deterministic encoding SHALL retain the
operation and width.

#### Scenario: Verify f64 sine

- **WHEN** a valid `f64.sin` expression lowers to MIR
- **THEN** verification accepts one `Sin` operation whose operand and result are both `f64`

#### Scenario: Reject a mismatched cosine

- **WHEN** malformed MIR assigns an `f32` cosine result to an `f64` destination
- **THEN** verification rejects the function before backend emission

### Requirement: MIR lowers composed Effect recipes completely

MIR lowering SHALL recursively realize every semantically valid Effect recipe nested beneath
`run`, including transformations whose protected recipe is provisioned, recovered, retried, or
acquired. Direct and stored forms MUST select complete deterministic runner identities, callable
environments, provider arguments, failure mappings, loan boundaries, and cleanup regions. Valid
source MUST NOT lower to an unavailable-transform trap, an unpublished region, or a compiler
implementation exception.

#### Scenario: Lower map around provision

- **WHEN** a run subject is an `Effect.map` whose protected Effect is a service-provision recipe
- **THEN** MIR contains a complete execution path for the protected runner, provider, and mapper with no unavailable region

#### Scenario: Lower provision around transformation

- **WHEN** a run subject provides a requirement after one or more transformations preserve it
- **THEN** MIR passes the provider through the transformed execution and closes its loan at the composed run boundary

#### Scenario: Lower a stored composed recipe

- **WHEN** the same recipe tree is stored in a binding before `run`
- **THEN** MIR preserves its eager construction facts and emits behavior equivalent to the direct recipe tree

#### Scenario: Reject an invalid composition before MIR

- **WHEN** types, failures, requirements, callable access, or ownership make a pipeline invalid
- **THEN** semantic analysis reports the relevant source diagnostic and MIR emission remains unavailable without a fallback trap

### Requirement: MIR normalizes static Effect construction and dispatch

Before MIR consumers run, MIR SHALL fold a direct function whose complete body only constructs and
returns an Effect, including a function that forwards its construction to one cleanup region whose
releases only drop parameters with effect-free cleanup before returning the constructed value: a
witness operation that drops its borrowed `self` is such a constructor. When the resulting Effect
environment is local, take-once, and consumed by its statically selected runner with Copy/shared
captures, MIR SHALL replace materialization and unpacking with direct static runner arguments. The
transformation MUST preserve evaluation order, typed failure propagation, provider arguments, traps,
semantic runtime observations, and cleanup. Applicability MUST derive from generic MIR shape and
compiler facts rather than pipe syntax, declaration names, module identity, or source location.

#### Scenario: Fold a direct constructor and static run

- **WHEN** a direct constructor contains only `MakeEffect` and return, and that value is consumed once by its selected synchronous runner
- **THEN** MIR contains the direct static runner operation with substituted captures and no constructor call or intermediate Effect environment

#### Scenario: Fold a constructor that drops a borrowed parameter

- **WHEN** a provided instance runs a service operation directly and the provider's witness operation constructs its Effect without capturing `self`, then drops the borrowed `self` in a cleanup region and returns the construction
- **THEN** the fold applies as if the drop were absent, the run becomes a direct static runner operation, and the enclosing function gains no suspension point for it

#### Scenario: Identify a run piped into an erased provide section

- **WHEN** a provider-specialized execution runs an ordinary Effect piped into an erased `Effect.provideMut` section, which is one recorded call of that section's declaration
- **THEN** normalization identifies the run's runner through that recorded call exactly as for a direct call, the execution is classified from its runs rather than reported unknown, and an eligible run reaches the direct static runner operation

#### Scenario: Preserve provider and failure behavior

- **WHEN** the eligible static run carries provider references, failure mappings, or releases
- **THEN** the normalized operation retains those arguments and the same success or propagated-failure behavior

#### Scenario: Apply to copied user code

- **WHEN** a user-defined constructor has the same eligible MIR body shape as a library constructor
- **THEN** normalization reaches the same verdict without consulting its declaration or module name

#### Scenario: Refuse an unsafe candidate

- **WHEN** the constructor is complex or recursive, the Effect escapes or is reused, a capture is affine/exclusive, a parameter drop has a cleanup effect, or synchronous execution is unknown
- **THEN** MIR retains the ordinary constructor and Effect value run without partial normalization

### Requirement: Static Effect normalization is deterministic and verifiable

The normalization SHALL run once on shared target-aware MIR before LLVM lowering.
MIR SHALL record deterministic accepted and rejected verdicts with source provenance. The verifier
MUST reject dangling verdict identities, inconsistent direct-run capture facts, and an accepted
candidate whose synchronous premise is not proven. Repeating normalization MUST make no edits.

#### Scenario: Normalize once for all consumers

- **WHEN** one target-aware MIR program is emitted by LLVM for native or WebAssembly targets
- **THEN** each artifact observes the same normalized operations and verdicts

#### Scenario: Repeat normalization

- **WHEN** the same program is normalized twice or compiled in fresh processes
- **THEN** the second pass makes no structural change and encoded MIR and verdicts are deterministic

### Requirement: MIR contains only primitive intrinsic operations

After instance discovery and specialization, MIR SHALL lower source wrappers to ordinary control
and calls, service operations to general witness dispatch, and explicit intrinsic calls to the
smallest backend-neutral primitive operations. MIR MUST NOT contain operations named for
`Allocator`, `SystemAllocator`, `StandardStreams`, `Logger`, `FileSystem`, numeric interfaces, or
other standard-library policy.

#### Scenario: Inspect system allocation MIR

- **WHEN** a source-defined SystemAllocator handles an allocation request
- **THEN** MIR contains ordinary service and source-call structure plus only the primitive storage operation

#### Scenario: Inspect generic addition MIR

- **WHEN** generic integer addition specializes to `i32`
- **THEN** MIR contains the concrete integer primitive and no generic numeric dispatch

### Requirement: MIR keeps strings logical and verifiable

MIR SHALL retain concrete `string` values, string calling paths, static string formation, lexical
runtime views, UTF-8 byte viewing, and unchecked construction as operations distinct from ordinary
slices. Verification SHALL enforce matching string types, complete provenance, valid loan endings,
and unsafe authorization while leaving UTF-8 validity of unchecked input as the source program's
unsafe obligation.

#### Scenario: Lower a static string through a call

- **WHEN** a static text literal crosses one internal `string` parameter and result boundary
- **THEN** MIR retains its logical string type, storage reference, byte count, and provenance at every operation

#### Scenario: Reject a forged safe string

- **WHEN** MIR attempts to construct `string` from a byte view without the accepted checked or unsafe formation path
- **THEN** verification rejects the program before backend emission

#### Scenario: End an owned-string view loan

- **WHEN** a `string` view borrowed from `String` reaches its lexical end on success, failure, or control transfer
- **THEN** MIR ends the loan exactly once before the owner may move, mutate, or drop

### Requirement: MIR represents suspension and continuation state target-neutrally

MIR SHALL classify each specialized runner and give every explicit suspension origin and potential
suspendable-run relay a stable target-neutral identity and control-flow form. MIR normalization
SHALL preserve those forms for suspendable or unknown runners before coroutine-state liveness is
computed. Each concrete suspendable invocation SHALL have one coroutine frame descriptor with a
statically known maximum logical layout over all of its resume states. Every state SHALL name the
exact specialized MIR locals live after transfer, including source values and compiler-generated
temporaries, together with the deferred Effect runner, arguments, typed outcome, resume point,
capture access, provider references, and cleanup obligations needed after resumption. Descriptors
SHALL use canonical logical types and compiler-planned layouts while omitting native addresses,
WebAssembly table indexes, target blocks, branch depths, source allocator implementations,
scheduler objects, and public pending values. Each function's structured control regions SHALL
remain acyclic even when the module call graph contains suspended self- or mutual-recursion cycles.

`SuspendEffect` SHALL be the only form permitted to originate a fresh deferred-child transfer.
`RunSuspendableEffect` SHALL have distinct synchronous-Complete and relay-Transfer success/failure
control. Its Complete paths SHALL enter no resume state. Its Transfer path SHALL preserve the
incoming child, origin, and typed-outcome identity and SHALL transition the current invocation into
the exact resume state needed after the child. Repeated transfers by one invocation SHALL reuse its
frame rather than creating separately owned continuation records. Reachable provisional control
MUST be finalized before backend emission.

#### Scenario: Retain state after a suspended child

- **WHEN** a non-tail Effect keeps an affine owner and a scalar local across a suspended recursive run
- **THEN** MIR names both live values, their unique frame fields and state ownership, the child outcome, the resume point, and exact cleanup obligations without choosing a target ABI

#### Scenario: Retain a compiler-generated temporary

- **WHEN** a source expression computes `left + run child` and `child` transfers before completing
- **THEN** the finalized coroutine state retains the specialized MIR local containing `left` even when no source binding directly names that temporary

#### Scenario: Reuse one invocation frame

- **WHEN** one concrete Effect invocation can suspend at multiple source points or revisit one point
- **THEN** MIR describes one maximum frame layout with distinct states rather than a newly allocated continuation owner for each transfer

#### Scenario: Normalize before planning coroutine state

- **WHEN** concrete normalization folds or retains an Effect construction and its run
- **THEN** the finalized frame states name exactly the surviving post-normalization MIR locals and contain no stale pre-normalization local

#### Scenario: Encode mutual suspended recursion deterministically

- **WHEN** equivalent mutually recursive Effects are lowered in repeated fresh processes
- **THEN** their suspension operations, frame descriptors, state identities, logical layouts, and cleanup plans encode byte-identically

### Requirement: MIR verifies suspension completeness and ownership

MIR verification SHALL reject a suspension whose deferred runner or typed outcome disagrees with
the call contract; whose resume state is missing or ambiguous; whose post-normalization live local
is omitted, duplicated, or assigned incompatible access; whose maximum frame layout is incomplete;
or whose success and typed-failure plans do not preserve ownership, cleanup, loan endings, and
propagation. Verification SHALL also reject an orphan frame descriptor or suspendable-run form in a
program whose reachable MIR contains no suspension origin. Final MIR verification SHALL reject a
stale pre-normalization local, an unclassified live temporary, incomplete state initialization,
reachable provisional control, a Complete path that enters resume control, an ordinary run that
originates transfer, a relay that changes the incoming child, origin, or typed-outcome identity, or
any suspension path that introduces source allocator access or typed storage failure.

#### Scenario: Reject a missing live owner

- **WHEN** hand-built MIR suspends while an affine local remains needed after resumption but omits that local from its frame state
- **THEN** verification reports the missing ownership before backend emission

#### Scenario: Reject suspension machinery without suspension

- **WHEN** a MIR module contains a coroutine frame descriptor or suspendable-run form but no reachable suspension operation
- **THEN** verification rejects the unused machinery instead of allowing a hidden runtime cost

#### Scenario: Reject an ordinary run that originates transfer

- **WHEN** hand-built MIR gives `RunSuspendableEffect` a fresh deferred child or transfer identity instead of relaying one produced by `SuspendEffect`
- **THEN** verification rejects the invalid origin before backend emission

#### Scenario: Reject storage channels in suspension MIR

- **WHEN** hand-built suspension MIR adds an allocator requirement or an `OutOfMemoryError` outcome solely for coroutine-frame storage
- **THEN** verification rejects the contract before backend emission

### Requirement: MIR receives only concrete row-contract instances

MIR lowering SHALL accept only branded specialized contracts whose failure and requirement rows are
concrete finite rows and whose used constraint evidence is concrete. MIR SHALL contain no row
parameters, symbolic members, `Without`, member-well-formedness obligations, assumed evidence,
provider candidate selection, or constraint entailment.

Concrete requirement binding SHALL lower from the exact selected stored member and provider match
already present in specialized HIR. Selective failure handling SHALL lower from the concrete
protected row, selected nominal member, handler contract, and residual result row already present in
specialized HIR. MIR verification and encoding SHALL remain deterministic and backend-neutral.

#### Scenario: Lower an exact concrete requirement binding

- **WHEN** specialized HIR binds an exclusive provider to one concrete stored requirement
- **THEN** MIR consumes the branded selection evidence without reselecting or subtracting a row

#### Scenario: Reject symbolic row algebra at the MIR boundary

- **WHEN** a lowering request contains a residual row expression or assumed proof
- **THEN** MIR construction reports a compiler invariant violation rather than encoding symbolic state

#### Scenario: Lower executable selective catch

- **WHEN** a reachable selective catch has a concrete protected row and selected nominal member
- **THEN** MIR runs the protected Effect once, bypasses the handler on success, invokes it for the selected failure tag, and remaps every other failure into the residual row

### Requirement: MIR lowering requires proven source returns

MIR lowering SHALL accept only executable HIR bodies carrying a complete semantic return proof.
The MIR verifier SHALL continue to reject malformed compiler-generated or hand-built returns as an
internal invariant, but a source return mismatch MUST NOT first surface from MIR or a backend.

#### Scenario: Stop a source mismatch before MIR

- **WHEN** an ordinary, effectful, generic, or conformance body violates its resolved return contract
- **THEN** no MIR function is lowered for that body and the source semantic diagnostic remains the primary failure

### Requirement: MIR realizes and verifies finite Effect composites

MIR SHALL carry a closed composite Effect layout, an operation that packs one exact selected
alternative, selected-run dispatch, and active-alternative cleanup. Verification SHALL reject an
unknown alternative, a mismatched source representation, an incompatible normalized contract, or
cleanup metadata that can release an inactive alternative.

#### Scenario: Pack one selected alternative

- **WHEN** lowering reaches a branch that constructs one member of a finite Effect join
- **THEN** MIR packs that member with its canonical tag and does not construct the other members

#### Scenario: Clean only the active member

- **WHEN** a composite holding an affine capture is dropped or finishes running
- **THEN** MIR applies exactly the selected alternative's cleanup plan once

#### Scenario: Encode the composite deterministically

- **WHEN** equivalent joined Effects are lowered repeatedly
- **THEN** MIR layouts, alternative tags, operations, cleanup plans, and text are identical

### Requirement: MIR lowers statement patterns as verified selections

MIR SHALL lower local and conditional patterns through the compiler-owned match operation rather
than a second dispatch mechanism. The operation SHALL retain the specialized logical scrutinee,
canonical selected members, access, binding locals, structured outcomes, cleanup, provenance, and
whether statement bindings remain live after selection. Verification SHALL reject inconsistent
member tests, locals, access, coverage, or retained-borrow state.

#### Scenario: Lower an irrefutable let

- **WHEN** HIR contains total nested destructuring
- **THEN** MIR selects once, creates the declared binding locals, and retains them in the enclosing region

#### Scenario: Lower if-let mismatch

- **WHEN** a conditional pattern is refutable
- **THEN** MIR contains one source-ordered selected body and one deterministic mismatch body with joined cleanup

### Requirement: MIR lowers marked dispatch and short-circuit control deterministically

MIR lowering SHALL resolve marked operator evidence to the same sealed intrinsic or source witness
used by ordinary interface specialization. Short-circuit lowering SHALL evaluate the left operand
first, enter the right region only when required, and join one Boolean result with path-correct
cleanup and typed Effect behavior. LLVM lowering SHALL consume that same verified
structure.

#### Scenario: Lower a source operator witness

- **WHEN** a custom operator conformance maps its marked operation to an ordinary source function
- **THEN** MIR contains one statically selected call with the declared heterogeneous signature

#### Scenario: Skip an effectful right region

- **WHEN** the left Boolean decides a short-circuit expression
- **THEN** MIR control flow bypasses every operation and cleanup local to the right region while producing the decided Boolean

#### Scenario: Emit real artifacts consistently

- **WHEN** a valid operator and short-circuit corpus is emitted for native and LLVM-to-Wasm targets
- **THEN** structural MIR and pinned artifact outcomes agree on results, skipped work, traps, and cleanup order

### Requirement: Local shared MIR is verified before LLVM emission

Target-neutral MIR SHALL represent local-shared layout planning, initialization, clone, callback
access, and opaque-core drop with the canonical core and element types, selected-target layout
provenance, consuming initialization inputs, take-once callback modes, callback result type, access
loan provenance, and source spans. Its deterministic inspection form MUST NOT contain public actor
names, raw addresses, backend field offsets, allocator implementations, or conflict-policy types.

MIR verification SHALL reject mismatched layout provenance, reused or unconsumed initialization
inputs, unavailable core or element types, malformed callback modes or result types, and any access
result or executable state that retains the callback-scoped loan. Each rejection SHALL retain a
stable diagnostic identity and the causative source provenance. No backend SHALL enter
and no partial executable artifact SHALL exist when verification rejects the program.

#### Scenario: Verify a complete lifecycle program

- **WHEN** MIR initializes one core from matching consumed inputs, clones it, invokes callback access, and drops both handles
- **THEN** verification retains the exact target layout identity, ownership transitions, callback modes, access loan, and opaque cleanup operations for execution

#### Scenario: Reject mismatched or incomplete initialization

- **WHEN** initialization uses mismatched layout provenance, reuses an input, or leaves an allocation or value unconsumed
- **THEN** verification reports the stable diagnostic with source provenance and no execution engine or partial artifact is entered

#### Scenario: Reject malformed callback access

- **WHEN** callback modes or result types are incompatible or a result or executable state retains the restricted access loan
- **THEN** verification reports the stable diagnostic with access provenance before backend lowering

#### Scenario: Inspect target-neutral local shared MIR

- **WHEN** verified local-shared MIR is encoded repeatedly
- **THEN** its bytes are deterministic and contain canonical operation, type, layout, ownership, callback, and source facts without actor names, addresses, or backend offsets

### Requirement: MIR verifies logical scalar enums over one physical representation plan

MIR SHALL carry canonical enum logical types and member constants together with the validated
fixed-width representation plan used for physical lowering. MIR verification SHALL reject a member
from another enum, a discriminant not belonging to a declared member, a representation-lane mismatch,
or an enum match decision that is invalid for the scrutinee's canonical enum. Equality, `value`, and
match operations SHALL remain target-neutral.

#### Scenario: Verify a complete enum match region

- **WHEN** HIR lowers an exhaustive enum match
- **THEN** MIR records decisions for the scrutinee enum's canonical members and one validated scalar representation without arbitrary integer cases

#### Scenario: Reject an undeclared MIR discriminant

- **WHEN** malformed MIR associates an enum constant with a backing value no member declares
- **THEN** MIR verification rejects the program before backend lowering

### Requirement: MIR verifies monomorphic nominal union operations

MIR SHALL contain only concrete nominal-union applications whose construction, tag selection,
payload fields, moves, projections, matches, and cleanup refer to one verified target-layout entry.
Verification SHALL reject a foreign variant, wrong parent application, duplicate or missing field,
invalid tag decision, payload-layout mismatch, incomplete hierarchical coverage, or cleanup path for
an inactive variant.

#### Scenario: Verify one concrete constructor

- **WHEN** lowering emits a `Result<i32, Problem>.Failure` value
- **THEN** MIR verifies the canonical parent and variant, the specialized `Problem` payload, and the exact planned representation before execution

#### Scenario: Reject incomplete nested coverage

- **WHEN** a match plan over `HttpError | OutOfMemoryError` omits one `HttpError` variant without a covering parent or wildcard decision
- **THEN** MIR verification rejects the region rather than allowing a backend default branch

### Requirement: Nominal union MIR encoding is deterministic

Equivalent concrete union programs SHALL encode parent, variant, field, hierarchical coverage,
layout, and cleanup identities in canonical order independent of discovery or source-map traversal.

#### Scenario: Repeat nominal union MIR

- **WHEN** equivalent generic union facts are lowered under distinct valid discovery traversals
- **THEN** their concrete instance ordering and committed MIR encoding are byte-identical

### Requirement: MIR represents verified referent-place operations

MIR SHALL lower referent Copy reads, compatible reborrows, and exclusive replacements through the
canonical place model. Verification SHALL check the reference subject, target type, access,
provenance, and operation compatibility. MIR encoding SHALL be deterministic and SHALL introduce no
formatting or referent intrinsic.

#### Scenario: Lower a scalar referent read

- **WHEN** HIR reads `u32` through a shared referent place
- **THEN** MIR loads the canonical place into a Copy result without consuming its owner

#### Scenario: Lower an exclusive replacement

- **WHEN** HIR replaces an exclusive referent
- **THEN** MIR emits the ordinary cleanup and store operations for that place

#### Scenario: Reject a forged place mismatch

- **WHEN** MIR claims a referent target or access incompatible with its reference subject
- **THEN** MIR verification rejects the program

### Requirement: Foreign calls are explicit verified MIR operations

A call to a foreign function SHALL lower to one dedicated MIR operation carrying the native symbol,
the ABI, the classified C signature, the argument locals, the destination local, the logical result
type, and provenance. The verifier SHALL reject an operation whose argument count or argument local
types disagree with its signature or whose destination type disagrees with the signature result.
The operation SHALL encode deterministically, and equal source SHALL produce byte-identical
encodings across processes.

#### Scenario: Lower a foreign call

- **WHEN** a reachable function calls `unsafe extern "C" fn silk_test_add(a: i32, b: i32) -> i32`
- **THEN** its MIR contains one foreign-call operation with symbol `silk_test_add`, ABI `C`, signature `(i32, i32) -> i32`, two argument locals, and an `i32` destination

#### Scenario: Verify an arity mismatch as data

- **WHEN** a constructed foreign-call operation supplies one argument to a two-parameter signature
- **THEN** verification reports one structural violation naming the operation and neither trap nor throw occurs

### Requirement: MIR carries raw pointer types and primitives

MIR SHALL carry `*const T` and `*mut T` as a logical pointer type with the canonical pointee and
mutability, realized by the layout plan as one address-width scalar. Pointer null, null test,
formation from a reference or slice place, offset, read, and write SHALL be explicit verified
operations; verification SHALL reject a read or write whose pointee is not Copy and an operation
whose operand types disagree with the pointer type. Pointer MIR SHALL encode deterministically.

#### Scenario: Lower a slice pointer formation

- **WHEN** a function calls `Pointer.fromMutSlice(&mut bytes)`
- **THEN** its MIR contains one pointer-formation operation from the slice's address lane to a `*mut u8` destination

#### Scenario: Verify a move-only write as data

- **WHEN** a constructed pointer-write operation targets a `*mut Vector<i32>`
- **THEN** verification reports one structural violation and no artifact is emitted

### Requirement: MIR lowers anonymous callables as finite exact environments

MIR lowering SHALL create a statically selected executable body and one finite concrete environment
layout for each realized anonymous callable identity. Environment fields SHALL follow semantic
capture order and retain their Copy, borrowed, exclusive, or owned representation and cleanup plan.
Construction, invocation, ordinary result delivery, effect construction, dropped-uninvoked cleanup,
and consuming cleanup SHALL preserve source and ownership order through MIR and LLVM lowering.
Structural callable types MUST NOT gain a standalone layout, universal closure
ABI, runtime target table, or heap-allocation requirement from anonymous callables.

#### Scenario: Lower an environment-bearing callable

- **WHEN** a realized anonymous callable captures one Copy value and one moved affine owner
- **THEN** MIR names its static body, lays out the two fields in semantic capture order, and emits exactly-once cleanup for the owner

#### Scenario: Lower a capture-free handler

- **WHEN** a capture-free effectful anonymous handler is passed through a generic combinator
- **THEN** specialization retains its exact empty-environment identity and lowers invocation to its static body

#### Scenario: Keep structural contracts unlayoutable

- **WHEN** layout receives only an anonymous callable's structural `fn(A) -> B` contract without its hidden concrete identity
- **THEN** it remains unavailable rather than choosing an erased closure representation

### Requirement: Slice field indexing retains descriptor bounds and element layout

Indexing a slice projected from a borrowed aggregate SHALL retain that slice's backing address, runtime length and element layout through lowering. Direct field indexing and indexing a copied local view SHALL have equivalent consumed values and bounds behavior. A slice descriptor SHALL NOT be addressed as inline repeated element storage.

#### Scenario: Index a slice field through a borrowed receiver

- **WHEN** a borrowed holder reads self.slice[i] directly
- **THEN** lowering emits the same runtime-bounded element access as reading through a local copy of self.slice without a backend defect
- **AND** an index at or beyond the runtime length traps under the ordinary bounds contract

### Requirement: Hidden initializer owners use ordinary storage lifecycles

Materialized array owners retained by binding initializers SHALL have ordinary local storage, initialized-state tracking, ordered cleanup and suspension-frame liveness. Lowering SHALL preserve the original producer evaluation point and SHALL NOT duplicate producers or retain iteration owners beyond their lexical exit.

#### Scenario: Retain a hidden backing array across suspension

- **WHEN** a dependent holder is live in a suspended computation
- **THEN** its hidden backing owner is stored for the suspension and restored for resumed use
- **AND** completion or interruption cleans the initialized owner exactly once after its dependents
