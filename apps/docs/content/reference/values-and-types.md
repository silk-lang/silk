# Values and types

Every Silk expression has one precise type. Expected contexts may select the type of an exact
literal before it becomes a value, but an already-typed value changes type only through one of the
language's explicitly defined compatibility relations.

Ownership behavior is defined by [ownership and borrowing](ownership-and-borrowing.md). Function,
callable, and match result types are defined by
[functions, callables, and control flow](functions-callables-and-control-flow.md). This page defines
the identities, construction rules, and ordinary compatibility of foundational values, nominal
structs, scalar enums, nominal unions, arrays, references, slices, raw pointers, and structural
unions.

## Terminology

- A **value** is the result represented by a successfully typed expression.
- A **type** classifies a value and determines which source operations may accept it.
- A **precise type** is the expression's own type before an expected boundary performs a compatible
  injection, widening, or access weakening.
- An **expected context** is a source position that already requires a type, such as a declared
  return, parameter, struct field, array element, or assignment destination.
- **Contextual literal selection** chooses a representable type for an exact literal that has not
  yet become a typed value.
- **Compatibility** determines whether an already-typed source value may satisfy an expected type.
- A **foundational scalar** is `bool`, `char`, an integer type, or a floating-point type. A
  **scalar enum** is instead a nominal type with one fixed-width integer representation.
- A **nominal type** is identified by its declaration rather than by the shape of its fields.
- An **aggregate** is a value containing other values, such as a struct, fixed array, or structural
  union payload.
- A **view** provides lexical access to storage it does not own. References, slices, and `string`
  values may retain such access.
- **Injection** places one precise value into a structural union containing its type.
- **Widening** converts one structural union into another containing every source member.

## Foundational type identity and compatibility

### TYPE-001 — Foundational type spellings are lowercase and distinct

**Status:** Confirmed

Silk defines these scalar types:

| Category          | Types                              |
| ----------------- | ---------------------------------- |
| Boolean           | `bool`                             |
| Unicode scalar    | `char`                             |
| Unsigned integers | `u8`, `u16`, `u32`, `u64`, `usize` |
| Signed integers   | `i8`, `i16`, `i32`, `i64`, `isize` |
| Floating point    | `f32`, `f64`                       |

The foundational non-scalar types are unit `()`, bottom `never`, and immutable UTF-8 view
`string`. Every spelling denotes a distinct type. Uppercase forms such as `I32`, `Bool`, and
`String` are not aliases; `String` may instead name an ordinary standard-library owning type.

```silk
fn classify(flag: bool, scalar: char, count: usize) -> f64 {
  return 0.0
}
```

**Boundary:** Distinct foundational types are not interchangeable merely because their runtime
representations could have the same width. `u32`, `char`, and `f32` remain three different types.

**Diagnostics:** An unresolved type spelling reports `SEM0001`. A value declaration used where a
type is required reports `SEM0018`.

**Evidence:** [scalar catalog](../../../../packages/compiler/src/Scalar.ts),
[integer scalar specification](../../../../openspec/specs/bootstrap-integer-scalars/spec.md),
[floating scalar specification](../../../../openspec/specs/bootstrap-floating-point-scalars/spec.md),
[string specification](../../../../openspec/specs/bootstrap-string/spec.md).

### TYPE-002 — Unit has one value and `never` has none

**Status:** Confirmed

`()` is both the unit type's spelling and its sole value. A function result omitted from its
declaration is `()`, bare `return` returns `()`, and reaching the end of a unit body produces `()`.

`never` is uninhabited: no expression completes by producing a `never` value. An expression of type
`never` is compatible with every expected type because control does not reach that boundary with a
value.

```silk
struct StopError {}

effect fn stop() -> never ! StopError {
  fail StopError {}
}

effect fn number() -> i32 ! StopError {
  return run stop()
}
```

The return is valid. `stop` either propagates its typed failure or does not return; it never creates
an `i32` or a bottom payload.

**Boundary:** `never` is not a default value, null value, or runtime union tag. Source cannot
construct, store, inspect, or return a completed `never` value.

**Diagnostics:** Unit return mismatches use the ordinary return diagnostic. A `never` expression
receives no conversion diagnostic when used at another expected type.

**Evidence:** [unit result rule](effect-contracts.md#eff-010--omitting-the-result-annotation-declares-unit),
[failure bottom rule](typed-failures.md#fail-002--fail-follows-ordinary-ownership-rules-and-has-type-never),
[type compatibility](../../../../packages/compiler/src/TypeCompatibility.ts).

### TYPE-003 — Compatibility is exact except for closed named relations

**Status:** Confirmed

An already-typed value satisfies an expected type when the two types are identical or one of these
relations applies:

1. `never` satisfies any expected type.
2. A precise value injects into a structural union containing its type.
3. A structural union widens into another containing every source member.
4. Callable invocation mode weakens under CALLABLE-003.
5. Effect run access weakens under the Effect ownership rules.
6. Proven outlives relationships and declared variance permit lifetime shortening; exclusive
   reference targets remain invariant. See [lifetimes](lifetimes.md).

No other subtyping or implicit conversion exists.

```silk
fn preserve(value: u8) -> u8 {
  return value
}
```

**Boundary:** Numeric width, signedness, representation, array length, ownership, text encoding, and
borrow access do not create compatibility. In particular, `i32` does not become `u8` because its
runtime value fits, an array does not decay into a slice, and `string` does not become owned
`String`.

**Diagnostics:** The enclosing boundary selects the diagnostic: arguments use `SEM0012`, struct
fields `SEM0025`, array elements `SEM0030`, assignments `SEM0037`, and incompatible union widening
`SEM0040`. Return mismatches report `SEM0129`.

**Evidence:** [compatibility implementation](../../../../packages/compiler/src/TypeCompatibility.ts),
[callable modes](functions-callables-and-control-flow.md#callable-003--invocation-mode-describes-access-to-the-callable-environment),
[Effect access](ownership-and-borrowing.md#effect-own-002--run-access-derives-from-use-of-the-effect-environment).

## Scalar values and literals

### INT-001 — Integer types have exact signedness and width

**Status:** Confirmed

The fixed-width integer name states both signedness and value width. `u8` through `u64` are
unsigned; `i8` through `i64` are signed. `usize` and `isize` use the selected target's pointer width:
64 bits on required native targets and 32 bits on `wasm32-unknown-unknown`.

Every integer type is Copy and cleanup-free. Integer types remain distinct even when two selected
types have the same physical width.

```silk
fn nativeIndex(value: usize) -> usize {
  return value
}

fn fixedIndex(value: u64) -> u64 {
  return value
}
```

`usize` and `u64` are not compatible on a 64-bit target despite using equally wide values there.

**Boundary:** Silk does not promote a narrower integer, change signedness, or convert between fixed
and pointer-sized integers implicitly. Such transformations require explicit operations.

**Diagnostics:** An out-of-range integer literal reports `SEM0002`. A negative literal selected as
`usize` reports `SEM0060`. An already-typed mismatch uses the diagnostic of its expected boundary.

**Evidence:** [integer scalar specification](../../../../openspec/specs/bootstrap-integer-scalars/spec.md),
[`usize` specification](../../../../openspec/specs/bootstrap-usize/spec.md),
[scalar catalog](../../../../packages/compiler/src/Scalar.ts).

### INT-002 — Integer literals are exact until an immediate context selects their type

**Status:** Confirmed

An integer literal retains its exact mathematical magnitude until typed. An immediate expected
integer type selects that type when the magnitude is representable. Without a numeric context, the
literal defaults to `i32`.

```silk
struct Header {
  code: u8
}

fn header() -> Header {
  return Header { code: 255 }
}
```

The field contract selects `u8` for `255`. The literal is not first made `i32` and then narrowed.
Immediate contexts include concrete parameters, returns, struct fields, contextual array elements,
assignment destinations, and a known homogeneous operator operand.

**Boundary:** Context does not retype an existing value:

```silk,ignore
fn invalid() -> Header {
  let code = 255
  return Header { code }
}
```

`code` is already `i32`, so the field reports a mismatch. A later use cannot retroactively change
the binding to `u8`.

**Diagnostics:** A literal outside the selected type's range reports `SEM0002` before MIR lowering.
The diagnostic must retain its exact magnitude rather than a rounded host-number approximation.

**Evidence:** [integer literal specification](../../../../openspec/specs/bootstrap-integer-scalars/spec.md),
[literal elaboration tests](../../../../packages/compiler/test/IntegerScalars.test.ts).

### DURATION-001 — Duration literals are fixed `u64` nanosecond values

**Status:** Confirmed

Every valid duration literal has type `u64`, independent of its surrounding context. The compiler
scales every component exactly and sums the result before TIR lowering.

| Suffix |     Exact nanoseconds |
| ------ | --------------------: |
| `ns`   |                   `1` |
| `us`   |               `1_000` |
| `ms`   |           `1_000_000` |
| `s`    |       `1_000_000_000` |
| `m`    |      `60_000_000_000` |
| `h`    |   `3_600_000_000_000` |
| `d`    |  `86_400_000_000_000` |
| `w`    | `604_800_000_000_000` |

Days and weeks are fixed spans: one day is exactly 24 hours and one week is exactly seven days.
They do not represent calendar days, time zones, daylight-saving transitions, or leap seconds.

```silk
import silk.monotonic_clock { MonotonicClock }

effect fn pause() -> () ? &mut MonotonicClock {
  return run MonotonicClock.waitFor(1h30m)
}
```

A duration literal carries no nominal dimensional identity after analysis. It is an ordinary `u64`
value, so it may be passed to any `u64` parameter, compared with another `u64`, or combined with
ordinary integer operators. `1h + 30m + 30s` therefore uses ordinary checked `u64` addition; an
arithmetic result outside the `u64` range traps under the general integer rule.

**Boundary:** Context never retypes a duration literal to `i32`, `usize`, or another integer type.
Supplying it where another type is required reports that boundary's ordinary mismatch. Duration
literals are values, not duration patterns, enum discriminants, array lengths, a nominal `Duration`
type, or a new clock API.

The largest valid total is `18_446_744_073_709_551_615` nanoseconds. A larger exact total reports
`SEM0170` before TIR is produced. Public `u64` constants may use duration literals; their exported
module surface retains the exact scaled value, not the source padding or component grouping.

**Evidence:** [duration literal specification](../../../../openspec/changes/add-duration-literals/specs/duration-literals/spec.md),
[duration analysis and lowering](../../../../packages/compiler/src/ExpressionAnalysis.ts),
[integer-scalar duration tests](../../../../packages/compiler/test/IntegerScalars.test.ts),
[clock integration tests](../../../../packages/compiler/test/Clock.test.ts).

### FLOAT-001 — Floating literals select `f32` contextually and otherwise default to `f64`

**Status:** Confirmed

`f32` and `f64` are distinct Copy scalar types using IEEE binary32 and binary64 values. A floating
literal retains its exact source value until a contextual floating type rounds it; without such a
context it defaults to `f64`.

```silk
fn small() -> f32 {
  return 1.25
}

fn defaulted() -> f64 {
  let value = 1.25
  return value
}
```

Basic floating behavior preserves signed zero and keeps NaN unordered. The complete operation and
explicit conversion APIs belong to the expressions and operators reference.

**Boundary:** Integers do not become floats implicitly, and `f32` does not widen to `f64` after it
has been typed. A conversion must be explicit even when mathematically exact.

**Diagnostics:** A floating spelling that cannot produce a supported floating value reports
`SEM0095`. Contextual type mismatches use the enclosing boundary's ordinary diagnostic.

**Evidence:** [floating scalar specification](../../../../openspec/specs/bootstrap-floating-point-scalars/spec.md),
[floating tests](../../../../packages/compiler/test/FloatingPointScalars.test.ts).

### CHAR-001 — `char` holds exactly one Unicode scalar value

**Status:** Confirmed

`char` is a Copy 32-bit scalar whose valid values are Unicode scalar values: `0` through
`0x10ffff`, excluding the surrogate range `0xd800` through `0xdfff`. A character literal contains
exactly one scalar, not one byte.

```silk
fn snowman() -> char {
  return '\u{2603}'
}
```

`'é'` is also one `char` even though its UTF-8 encoding uses more than one byte. `char` supports
equality and ordering by scalar value.

Character literals default to `char`. An immediate concrete integer context instead selects that
integer type when the decoded Unicode scalar number fits its range. The same contexts as integer
literals apply: annotated bindings, constants, concrete call and pipeline parameters, returns,
fields, contextual array elements, assignments, and known homogeneous operator operands.

```silk
fn examples(byte: u8) -> bool {
  let letter = 'A'       // char
  let ascii: u8 = 'A'    // 65
  let accented: u8 = 'é' // 233
  return byte == 'A' && 'A' == byte && letter == 'A' && ascii == 65 && accented == 233
}
```

The value 233 is a Unicode scalar number, not the UTF-8 encoding of `'é'`. An integer type does
not enforce ASCII. A literal such as `'☃'` cannot fit `u8`, and `'é'` cannot fit `i8`; both report
a compile-time range error. Unicode validation happens first, so `\u{d800}` remains an invalid
scalar escape even in a `u32` context.

**Boundary:** `char` is not an integer type. Already-typed `char` values do not adapt to integer
contexts. Arithmetic on them is unavailable, and conversion to or from an integer requires an
explicit checked or named operation. Contextual literal selection does not admit floats, Boolean
values, strings or nominal enums. When an operator has only literal operands and no applicable
integer context, its existing first-literal fallback still applies; this is not global inference.

```silk
import silk.char { fromU32, toU32 }
import silk.option { Option }

fn checked(value: u32) -> Option<char> {
  return fromU32(value)
}

fn scalarNumber(value: char) -> u32 {
  return toU32(value)
}
```

`fromU32` returns `Option<char>.Some` for `0...0xd7ff` and `0xe000...0x10ffff`. It returns
`Option<char>.None` for surrogate values and larger integers, without truncating or trapping. `toU32` is total
because every existing `char` is already a valid scalar. Canonical string traversal returns
`char`; callers choose `toU32` explicitly when they need its integer value.

**Diagnostics:** A literal containing zero or multiple scalar values reports `LEX0007`. Malformed
escapes and invalid scalar spellings receive their literal diagnostic without constructing a
partial value. An expression character literal outside the selected integer range reports `SEM0002`
with the selected type and exact bounds; invalid primitive constants use `SEM0086`. Supplying an
already-typed `u32` where `char` is required, or `char` where `u32` is required, uses
the ordinary type-mismatch diagnostic; `fromU32` represents an invalid integer as
`Option<char>.None` rather
than a diagnostic or trap.

**Evidence:** [character literal specification](../../../../openspec/specs/bootstrap-lexer/spec.md),
[character scalar catalog](../../../../packages/compiler/src/Scalar.ts),
[character tests](../../../../packages/compiler/test/CharacterScalar.test.ts),
[conversion and engine tests](../../../../packages/compiler/test/IntegerScalars.test.ts).

### TEXT-001 — `string` is immutable UTF-8 text and byte strings are byte views

**Status:** Confirmed

`string` is a Copy immutable view of valid UTF-8, distinct from every scalar and from `&[u8]`.
An ordinary text literal has type `string<'static>`. A byte-string literal has type
`&[u8]` and preserves exact bytes.

```silk
fn greeting() -> string {
  return "olá"
}

fn firstByte() -> u8 {
  return b"ok"[0]
}
```

Text-literal equality compares exact decoded Unicode scalar sequences, equivalently their canonical
UTF-8 bytes. It performs no normalization, case folding, or locale-sensitive comparison.

**Boundary:** A byte view remains binary data even when its bytes are valid UTF-8. Forming a
`string` from runtime bytes requires validation or a narrow unsafe operation. A runtime `string`
view retains the lifetime of its backing owner; copying the view does not detach that loan.

**Diagnostics:** Invalid UTF-8, malformed escapes, and invalid byte values report `SEM0085` without
publishing partial static data. Lifetime violations use the ordinary borrow diagnostics.

**Evidence:** [static text specification](../../../../openspec/specs/bootstrap-static-text/spec.md),
[string specification](../../../../openspec/specs/bootstrap-string/spec.md),
[string ownership tests](../../../../packages/compiler/test/StringOwnership.test.ts).

### TEXT-002 — Text conversions and access units are explicit

**Status:** Confirmed

Silk does not implicitly convert between `string`, owned `String`, and `&[u8]`. Conversions that
copy into owned storage, borrow owned storage, expose UTF-8 bytes, or validate bytes are explicit
operations. No conversion allocates invisibly.

`string` has no index operator and no unitless `length`. APIs name their observation unit, such as
byte length, UTF-8 bytes, Unicode scalars, or grapheme clusters.

**Boundary:** A text literal does not become an owning `String` because a field or parameter expects
one. `text[0]` is invalid because the intended unit could be a byte, Unicode scalar, or grapheme.
Because `string` is an ordinary Copy view value, it may appear in valid aggregate positions and may
itself be borrowed: `&string`, `&mut string`, and `&[string]` follow the ordinary reference,
mutation, slice, aggregate-storage, and nested-loan rules. Mutating through `&mut string` may replace
the view value; it does not make the viewed UTF-8 storage mutable. A containing value cannot outlive
a runtime string view's backing owner merely because the view is nested.

**Diagnostics:** Indexing `string` reports the non-indexable-type diagnostic. Implicit text
conversions use the enclosing type-mismatch diagnostic.

**Evidence:** [string access and conversion specification](../../../../openspec/specs/bootstrap-string/spec.md),
[string type diagnostics](../../../../packages/compiler/test/DeclarationIndex.test.ts).

## Constant values

### CONST-001 — A constant has an explicit primitive type and one static initializer

**Status:** Confirmed

A `const` declaration requires a type annotation. Its type is `bool`, `char`, a supported integer
or floating-point primitive, or `string`. Its initializer is a statically evaluated expression that
must produce exactly the declared type for the selected target. Constants do not infer their type
or hold aggregate values.

```silk
pub const limit: i32 = 2
const ratio: f64 = 1.5
const enabled: bool = true
const separator: char = ','
const pattern: string = r"\d+"
```

A constant initializer may call static functions and may depend on another statically evaluated
constant. Its selected value lowers as an immediate value with no runtime initializer, storage,
call, or cleanup. It has no address and cannot be borrowed, assigned, or moved.

**Boundary:** Type inference, aggregates, ordinary function calls, Effects, service requirements,
borrows, unsafe operations, and observable allocations are unavailable in constant initialization.
A wrong result type, dependency cycle, selected-target range failure, or static evaluation failure
exposes no usable constant value.

**Diagnostics:** A declaration outside the primitive constant contract reports `SEM0086` at the
declaration. An operation unavailable during static initialization reports `SEM0176`; selected
compile errors, cycles, and static-evaluation limits retain their diagnostic and trace.

**Evidence:** [typed constant requirements](../../../../openspec/changes/add-static-evaluation-core/specs/bootstrap-typed-constants/spec.md),
[static evaluation](static-evaluation.md),
[constant analysis](../../../../packages/compiler/src/ExpressionAnalysis.ts).

### CONST-002 — Target facts are ordinary statically evaluated source constants

**Status:** Confirmed

The ordinary `silk.target` module publishes these primitive constants. Their initializers use the
same static evaluator as every other constant, and the selected target determines their values.

| Fact          | Type    | Value                                        |
| ------------- | ------- | -------------------------------------------- |
| `usizeMax`    | `usize` | Largest `usize` at the target pointer width  |
| `isizeMax`    | `isize` | Largest `isize` at the target pointer width  |
| `isizeMin`    | `isize` | Smallest `isize` at the target pointer width |
| `pointerBits` | `u32`   | Target pointer width in bits                 |

```silk
import silk.target { pointerBits, usizeMax, isizeMax, isizeMin }

pub const MAX: usize = usizeMax
pub const BITS: u32 = pointerBits
```

The declaration and imported module surface retain the explicit type, static initializer, and
source provenance without claiming one target-selected value. Each concrete target realization
publishes exactly one canonical value before residual runtime analysis.

**Boundary:** `Target` is an ordinary import alias, not a compiler-recognized spelling. Source may
compute another primitive constant through static functions, but target selection cannot remain as
a dynamic runtime query and cannot initialize an aggregate constant. A selected target constant may
be used at runtime only as its embedded ordinary immediate value.

**Diagnostics:** An absent import or member uses the ordinary name-resolution diagnostic. A target
fact at the wrong declared type reports `SEM0086`. A target query that would survive as runtime work
reports the static-phase diagnostic `SEM0176`.

**Evidence:** [typed target constants](../../../../openspec/changes/add-static-evaluation-core/specs/bootstrap-typed-constants/spec.md),
[static target API](static-evaluation.md#static-009--silktarget-exposes-target-information-only-as-static-source-values).

## Nominal struct values

### STRUCT-001 — A struct declaration creates one nominal type

**Status:** Confirmed

A top-level `struct` declaration creates a type identified by its canonical module and declaration,
including its generic arguments when present. Field shape, import alias, source traversal order, and
target layout do not participate in nominal identity.

```silk
struct ScreenPosition { x: i32 }
struct WorldPosition { x: i32 }
```

`ScreenPosition` and `WorldPosition` are incompatible even though their fields have the same name
and type. A zero-field struct such as `struct End {}` is an ordinary nominal marker type.

Every field has one explicit type, fields are ordered by declaration, and field names are unique.
Structs and fields are private by default; `pub` exposes them under the module visibility rules.

**Boundary:** Silk has no shape-based struct compatibility. A public contract cannot expose a
private nominal type, and a direct or mutual inline field cycle does not acquire hidden indirection.

**Diagnostics:** Duplicate fields report `SEM0017`; a public contract exposing a private type
reports `SEM0019`; inline recursive layouts report `SEM0020`.

**Evidence:** [struct type specification](../../../../openspec/specs/bootstrap-struct-types/spec.md),
[declaration index](../../../../packages/compiler/src/DeclarationIndex.ts).

### STRUCT-002 — Raw struct construction is complete and visibility-based

**Status:** Confirmed

A raw struct literal is available wherever every required field is visible. It must initialize
every field exactly once with a compatible value. Initializers evaluate in source order, while the
completed value retains canonical declaration field order.

```silk
struct Point {
  pub x: i32
  pub y: i32
}

fn origin() -> Point {
  return Point { y: 0, x: 0 }
}
```

Because both fields are public, another module may construct `Point` directly. A type with any
private required field instead preserves construction control and exposes visible ordinary
constructor functions when external construction is intended.

**Boundary:** Unknown, duplicate, missing, inaccessible, or mistyped initializers produce no
partially initialized value. Construction never fills omitted fields with defaults. A diagnostic
for hidden required fields does not expose their names or types. A declarationless opaque nominal
type, such as a runtime handle, has no source constructor; an empty semantic field list does not
turn it into an ordinary zero-field struct.

**Diagnostics:** Unknown fields report `SEM0022`; duplicates `SEM0023`; missing visible fields
`SEM0024`; incompatible field values `SEM0025`. Inaccessible construction needs one stable semantic
code that does not reveal hidden field details.

**Current compiler:** Aligned. Construction resolves every named initializer to its canonical field,
checks that field's visibility, and uses `SEM0021` when a required field is inaccessible or the
nominal type has no source struct declaration.

**Evidence:** [struct value tests](../../../../packages/compiler/test/StructValues.test.ts),
[struct literal elaboration](../../../../packages/compiler/src/Elaboration.ts).

### STRUCT-003 — Field projection follows the declared nominal field

**Status:** Confirmed

`value.field` resolves the subject's nominal type and the field declared by that type. Nested
projection associates from left to right and preserves the access mode of the underlying place.

```silk
struct Position { pub start: i32 }
struct Token { pub position: Position }

fn start(token: &Token) -> i32 {
  return token.position.start
}
```

The final expression has the declared type `i32`. Reading that Copy leaf does not move `token` or
its `Position` field.

**Boundary:** A non-struct has no fields. A field name is resolved only against the subject's actual
nominal declaration; Silk does not search other same-shaped structs or extension namespaces.
Private fields are inaccessible outside their defining module.

**Diagnostics:** Projection from a non-struct reports `SEM0026`; an unknown field reports `SEM0027`;
an inaccessible field reports `SEM0028`.

**Evidence:** [struct projection specification](../../../../openspec/specs/bootstrap-struct-values/spec.md),
[projection ownership](ownership-and-borrowing.md#own-002--ordinary-reads-copy-copy-values-and-never-consume-an-affine-owner).

### STRUCT-004 — Inline aggregate dependencies must be finite

**Status:** Confirmed

Every value stored directly inside a struct contributes to its finite inline type dependency.
Acyclic nesting is valid regardless of declaration order. A direct or mutual cycle made only of
inline fields is invalid because it has no finite complete value.

```silk
struct Position { value: i32 }
struct Span {
  start: Position
  end: Position
}
```

**Boundary:** `struct Node { next: Node }` is invalid. The compiler does not guess a pointer or make
the field optional. Recursion requires an explicit finite or indirect representation supplied by
ordinary library types. A zero-length `[Node; 0]` still retains `Node` in its type identity and does
not erase an otherwise recursive dependency.

**Diagnostics:** Every member of one inline recursive component receives the canonical `SEM0020`
cycle diagnostic without losing its nominal declaration identity.

**Evidence:** [inline dependency specification](../../../../openspec/specs/bootstrap-struct-types/spec.md),
[inline reach tests](../../../../packages/compiler/test/InlineStructReach.test.ts).

### STRUCT-005 — Struct ownership follows the explicit Copy contract

**Status:** Confirmed

A struct is affine unless it explicitly requests `Copy`. The compiler accepts `impl Copy` only when
every field is Copy and the struct has no cleanup behavior. Copying never runs user code.

Complete and eligible partial moves, mutation, and cleanup are defined by the ownership
reference rather than by field shape alone.

**Boundary:** A field-only scalar struct does not become Copy automatically. An owner of allocated
memory cannot request Copy merely because its physical representation contains a copyable pointer.

**Diagnostics:** Invalid implicit copying reports `OWN0003`. An invalid `impl Copy` reports
`SEM0083` and identifies the first affine, cleanup-bearing, cyclic, or unavailable reason.

**Evidence:** [owned value classification](ownership-and-borrowing.md#own-001--every-value-type-is-either-copy-or-affine).

### STRUCT-006 — C-layout records make an explicit field-layout promise

**Status:** Confirmed

`[pub] extern "C" struct` declares an ordinary nominal Silk value and additionally promises that
its fields use the selected target's C aggregate layout. Construction, projection, visibility,
borrowing, ownership, and an explicit `Copy` implementation follow the ordinary struct rules.

```silk
pub extern "C" struct Timespec {
  pub seconds: i64
  pub nanoseconds: i64
}
```

A C-layout record is nongeneric. Its fields may be fixed-width integers, `isize`, `usize`, `f32`,
`f64`, raw pointers, non-zero fixed arrays of permitted fields, and other valid C-layout records.
The compiler places those fields in declaration order with the C ABI's alignment, internal
padding, and tail padding for the selected target.

**Boundary:** The marker does not admit a record by value in a foreign function signature; foreign
aggregates remain pointer-only. A raw pointer to an ordinary Silk struct remains a valid opaque C
handle, but only a valid C-layout pointee grants native code the right to interpret its fields.
Unit, `bool`, `char`, strings, references, slices, ordinary structs by value, unions, enums,
callables, Effect values, type parameters, represented types, and zero-length arrays cannot be
C-layout fields.

**Diagnostics:** A generic C-layout declaration and an unsupported field type each report a stable
semantic diagnostic at the source syntax that violates the layout contract. The nominal type
remains available for tooling, but the compiler withholds the C-layout promise.

**Current compiler:** Aligned. Struct facts and public module surfaces retain the layout contract,
and the shared target-layout catalog is the single authority used before native lowering.

**Evidence:** [C-layout record specification](../../../../openspec/changes/archive/2026-09-02-add-c-layout-records/specs/bootstrap-struct-types/spec.md),
[target layout specification](../../../../openspec/changes/archive/2026-09-02-add-c-layout-records/specs/bootstrap-target-layout/spec.md),
[layout implementation](../../../../packages/compiler/src/Layout.ts).

## Tuples and contextual aggregate literals

### TUPLE-001 — Named tuples are nominal positional structs

**Status:** Confirmed

`tuple Name(T0, T1)` declares a nominal aggregate whose members are positions rather than field
labels. Construction uses `Name(v0, v1)`, and projection uses `.0`, `.1`, and so on. Generic tuple
parameters follow the same substitution and inference rules as generic structs.

```silk
tuple Point(i32, i32)
tuple Box<T>(T)

fn origin() -> Point {
  return Point(0, 0)
}

fn first(box: Box<i32>) -> i32 {
  return box.0
}
```

Tuple positions do not create `_0`-style source fields. Consequently `Point {_0: 0, _1: 0}` is
invalid, labeled tuples are not a separate language form, and positional projection cannot select
a same-spelled record field.

### TUPLE-002 — Parenthesized commas distinguish tuples from grouping and unit

**Status:** Confirmed

`(first, second)` is a tuple literal, `(only,)` is a one-element tuple literal, `(value)` is a
grouped expression, and `()` is unit. When an independently known expected type is a named tuple,
the literal constructs that type. Otherwise the literal occurrence creates one anonymous nominal
positional aggregate.

```silk
tuple Point(i32, i32)

fn make() -> Point {
  let point: Point = (10, 20)
  return point
}

fn age() -> i32 {
  let args = ("Julia", 32)
  return args.1
}
```

Elements evaluate from left to right. The runtime representation and ownership behavior are the
ordinary nominal-struct rules; there is no tuple-specific runtime category.

### RECORD-001 — `.{ ... }` uses only immediate expected struct context

**Status:** Confirmed

A targetless record literal constructs a named struct when its position already has that exact
expected struct type. Declared bindings, declared returns, known call parameters, aggregate fields,
and assignment destinations may provide that context. Field authority, visibility, completeness,
generic substitution, source evaluation order, and canonical field order remain the rules of
STRUCT-002.

```silk
struct Person {
  name: string
  age: i32
}

fn age(person: Person) -> i32 {
  return person.age
}

fn juliaAge() -> i32 {
  return age(.{name: "Julia", age: 32})
}
```

The compiler does not search visible declarations by field shape, and a later use never
retroactively supplies context. If no named struct expectation is independently known, the literal
occurrence creates one anonymous nominal record instead.

### RECORD-002 — Anonymous aggregates are occurrence-nominal and affine

**Status:** Confirmed

Each uncontextualized tuple or record literal is finalized once with an identity derived from its
module, source occurrence, and aggregate kind. That exact type may flow through a local binding,
borrow, projection, or generic argument, but it has no source name and cannot be imported or
exported. Separate same-shaped occurrences are incompatible, do not compare structurally, and do
not acquire a common match-result type. An explicit named aggregate context may instead make every
branch construct the same declared type.

Anonymous aggregates follow ordinary struct ownership. Even when every member is Copy, an
anonymous aggregate remains affine because no Copy conformance was declared for its hidden nominal
type. Whole-value moves transfer its one cleanup obligation; borrows and eligible partial moves are
the ordinary struct rules.

**Evidence:** [tuple and contextual record specification](../../../../openspec/changes/add-tuples-and-contextual-record-literals/specs/tuple-and-contextual-record-literals/spec.md),
[aggregate value tests](../../../../packages/compiler/test/StructValues.test.ts).

## Nominal union values

### NUNION-001 — A `union` declaration creates one nominal tagged sum

**Status:** Confirmed

`union Name { ... }` declares one nonempty, source-ordered set of variants under a single nominal
parent type. A variant is either a unit variant or a named-field variant with at least one field.
Generic parameters belong to the parent and are available in every variant field.

```silk
union Option<T> {
  Some { value: T },
  None
}

union HttpErrorCode {
  DNSTimeout,
  DNSError { rcode: Option<string>, infoCode: Option<u16> }
}
```

`Option<i32>` is the value type. `Option<i32>.Some` and `Option<i32>.None` are constructors and
pattern selectors, not detached types or structural-union members. Two union declarations remain
different types even when their variants have identical names and fields.

A nominal union is distinct from both other sum forms:

- `enum Status { Ready, Waiting }` is a scalar enum: its members carry no payload and it has a
  fixed-width integer representation.
- `A | B` is a structural union of already complete types: its members have independent identities
  and the set normalizes without a declaring parent.

**Boundary:** Named-field variants cannot use `{}`; use a unit variant instead. Variants have no
independent generic parameters, explicit discriminants, or standalone type identity. Raw C unions
and external linkage are outside this declaration form.

**Diagnostics:** An empty union reports `SEM0164`; duplicate variants report `SEM0165`; an empty
named-field variant reports `SEM0166`. Invalid variant fields preserve declaration facts for
tooling but make the complete parent unavailable for execution.

**Evidence:** [nominal union specification](../../../../openspec/changes/add-nominal-unions/specs/bootstrap-nominal-unions/spec.md),
[declaration tests](../../../../packages/compiler/test/DeclarationIndex.test.ts).

### NUNION-002 — Construction selects a qualified variant of one complete parent

**Status:** Confirmed

A constructor first resolves its nominal parent and any explicit parent-argument prefix, then uses
only the selected variant's field initializers to infer the remaining arguments.

```silk
union Result<A, E> {
  Success { value: A },
  Failure { error: E }
}

fn succeed() -> Result<i32, string> {
  return Result<i32, string>.Success { value: 42 }
}

fn fail(error: string) -> Result<i32, string> {
  return Result<i32>.Failure { error: move error }
}
```

`Result<i32>.Success` fixes `A` and cannot infer `E` from a field the `Success` variant does not
have; the declared result type supplies no implicit inference. The success constructor therefore
writes both arguments. The failure constructor writes `A` and infers `E` from its `error` field.

Every named field must be initialized exactly once. Initializers evaluate in source order and are
stored in declaration order. A unit variant has no initializer body. Parent and field visibility
use the same module rules as structs: a private required field prevents raw construction outside
the defining module without disclosing hidden field details.

**Boundary:** A parent value has no directly projectable fields, even when every variant declares a
same-spelled field. Bind a selected variant before using its payload. Construction never creates a
variant subtype and never flattens the parent into `A | B`.

**Evidence:** [constructor and visibility tests](../../../../packages/compiler/test/StructValues.test.ts),
[generic inference rules](../../../../openspec/changes/add-nominal-unions/specs/bootstrap-type-generics/spec.md).

### NUNION-003 — Patterns select variants hierarchically and exhaustively

**Status:** Confirmed

Variant patterns spell the fully applied parent and then the variant. Named fields bind like struct
fields; unit variants have no payload pattern.

```silk
fn unwrap(option: Option<i32>) -> i32 {
  return match move option {
    Option<i32>.Some { value } => value
    Option<i32>.None => 0
  }
}
```

When a nominal union is itself a member of `A | B`, matching keeps both levels. A direct variant arm
first selects the structural member, then the nominal variant:

```silk
struct OutOfMemoryError {}

fn classify(error: HttpErrorCode | OutOfMemoryError) -> i32 {
  return match move error {
    HttpErrorCode.DNSError { rcode: _, infoCode: _ } => 2
    HttpErrorCode.DNSTimeout => 1
    OutOfMemoryError other => 0
  }
}
```

Exhaustiveness retains the complete applied parent identity. `Option<i32>` and `Option<bool>` have
distinct variant leaves when both occur in a structural union. A declared variant with a `never`
payload remains a required coverage leaf even though source cannot construct it.

**Boundary:** Pattern arguments are explicit; they are not inferred from the scrutinee. A guarded
move remains provisional until the guard succeeds, so a false guard leaves the complete payload
available to later arms.

**Evidence:** [hierarchical match tests](../../../../packages/compiler/test/StructValues.test.ts),
[pattern rules](patterns-and-destructuring.md).

### NUNION-004 — Ownership and represented fields follow aggregate rules per active variant

**Status:** Confirmed

A nominal union is affine by default, even if every payload is Copy. `impl Copy` is admitted only
when every specialized field in every variant is Copy and no cleanup behavior conflicts. `impl
Drop`, interfaces, and operators target the complete parent type, never an individual variant.

Moving a variant binding transfers the selected payload. Borrowed patterns preserve the parent
owner. Cleanup dispatches on the private active tag and releases only initialized fields of that
variant, in the ordinary aggregate order, exactly once.

Callable- and Effect-bounded generic fields use the same exact represented-storage rules as struct
fields. Their environment, runner, access, suspension, and cleanup facts exist only for the variant
that declares the field; an inactive variant has no speculative payload to evaluate or release.

**Boundary:** All-Copy fields do not imply Copy for the parent. Extracting one owned represented
field requires an initialized owned projection and current variant proof; a `match place` arm or
a complete consuming variant pattern supplies that proof. A consuming pattern's ownership accounts for the rest of the active payload.

**Evidence:** [ownership tests](../../../../packages/compiler/test/Ownership.test.ts),
[represented variant tests](../../../../packages/compiler/test/StructValues.test.ts),
[active cleanup tests](../../../../packages/compiler/test/BoxHeapIndirection.test.ts).

### NUNION-005 — Tag and payload layout are private implementation facts

**Status:** Confirmed

Each concrete nominal-union application has one target layout containing a private tag and enough
aligned payload storage for its largest variant. Source order determines private variant ordinals.
Generic applications receive concrete layouts only when reachable and fully specialized.

The active variant's stored fields use their ordinary aggregate offsets. Borrowing a payload field
therefore refers to the original field, including when another variant has wider fields. Calls use
the compiler's separate unified lane mapping, with loads and stores translating between that mapping
and the active variant's storage.

No source operation observes a tag value, payload offset, padding, or ABI choice. Construction,
calls, returns, matching, copying, and cleanup all use the compiler's verified layout and calling
shapes. Inline cycles across structs and unions are rejected unless source names an explicit finite
indirection.

**Boundary:** Layout equivalence does not create type compatibility, serialization stability, a C
ABI, or permission to reinterpret values. A backend cannot invent a fallback tag or offset that is
absent from the verified layout plan.

**Evidence:** [layout tests](../../../../packages/compiler/test/Layout.test.ts),
[MIR verification](../../../../packages/compiler/src/MirVerification.ts).

## Scalar enum values

### ENUM-001 — A scalar enum declares one closed nominal member set

**Status:** Confirmed

`enum Name { ... }` declares one nonempty, source-ordered set of uniquely named, fieldless members.
The declaration creates a nominal type identified by its canonical module and name. Only a
qualified member path such as `Status.Ready` constructs a value; the bare spelling `Ready` does not
become a module binding.

```silk
enum Status {
  Pending,
  Ready,
  Done,
}

fn initial() -> Status {
  return Status.Pending
}
```

Two enum declarations remain different types even when they use the same representation, member
names, and discriminants. Every safe value of an enum names exactly one declared member. Members
have no payload, generic arguments, fields, or independent visibility marker; the enum
declaration's visibility governs the complete member set.

**Boundary:** Silk does not infer an enum from an unqualified member name, an integer, or another
enum's same-spelled member. An empty enum, a repeated member name, or a payload-bearing member is
invalid rather than creating an open or data-carrying sum type. Use structural unions of nominal
structs when alternatives need payloads.

**Diagnostics:** An empty enum reports `SEM0146`; a repeated member name reports `SEM0148` at the
later name and relates the first declaration. An unknown qualified member reports `SEM0153`.
Using a member through another canonical enum reports `SEM0154`. A bare member name receives the
ordinary unknown-name diagnostic.

**Evidence:** [scalar enum specification](../../../../openspec/specs/bootstrap-scalar-enums/spec.md),
[enum declaration tests](../../../../packages/compiler/test/DeclarationIndex.test.ts),
[enum name-resolution tests](../../../../packages/compiler/test/NameResolution.test.ts).

### ENUM-002 — The representation and discriminant sequence are explicit and checked

**Status:** Confirmed

An enum without a representation uses exactly `u8`. `enum(R) Name` may select only `u8`, `u16`,
`u32`, `u64`, `i8`, `i16`, `i32`, or `i64`; Silk never infers a wider representation from member
values.

The first implicit discriminant is `0`. Every later implicit member takes the preceding member's
discriminant plus one, including after an explicit optionally negative decimal integer literal.

```silk
enum(i16) ExitCode {
  Success,
  Interrupted = 130,
  Failed,
}
```

The discriminants are `0`, `130`, and `131`. Each explicit value and implicit successor must fit
the selected representation, and discriminants must be unique.

**Boundary:** `usize`, `isize`, floating types, aliases, nominal integer wrappers, and inferred
representations are unavailable. An explicit discriminant is not a general constant expression;
the current syntax accepts an optionally negative decimal integer literal. An unsigned enum cannot
use a negative discriminant.

**Diagnostics:** An unsupported representation reports `SEM0147`; a duplicate discriminant
reports `SEM0149` at the later member and relates the first. An explicit out-of-range discriminant
reports `SEM0150`, an overflowing implicit successor `SEM0151`, and a negative discriminant under
an unsigned representation `SEM0152`.

**Evidence:** [scalar enum representation rules](../../../../openspec/specs/bootstrap-scalar-enums/spec.md),
[enum parser tests](../../../../packages/compiler/test/Parser.test.ts),
[discriminant tests](../../../../packages/compiler/test/DeclarationIndex.test.ts).

### ENUM-003 — A scalar enum has its representation's layout but keeps nominal identity

**Status:** Confirmed

A valid enum has exactly the size, alignment, and calling shape of its selected fixed-width integer,
with no hidden tag or metadata. This representation choice is not visible as type compatibility:
the source value remains the enum's nominal type through storage, calls, equality, and matching.

Every scalar enum is a compiler-sealed Copy value with no cleanup obligation. Reading or passing an
enum copies its member value without consuming the original binding.
An explicit `move` or `match move` still consumes its owned place. Consuming a field cannot leave
a hole through an enclosing value with a `Drop` hook, including when that field is a Copy enum.

```silk
enum Mode { Read, Write }

fn same(value: Mode) -> bool {
  let copy = value
  return copy == value
}
```

**Boundary:** Matching integer layout does not permit implicit integer conversion, cross-enum
conversion, or arbitrary bit patterns to inhabit an enum. User code cannot implement or replace
the enum's sealed `Copy` behavior, and an enum cannot admit a `Drop` implementation.

**Diagnostics:** An attempted user `Copy` conformance uses the invalid-conformance diagnostic
`SEM0083`; an invalid `Drop` implementation uses `SEM0084`. Mixing an enum with its representation
integer reports `SEM0155` at the incompatible boundary.

**Evidence:** [sealed enum ownership](../../../../openspec/specs/bootstrap-scalar-enums/spec.md),
[layout tests](../../../../packages/compiler/test/Layout.test.ts),
[enum ownership tests](../../../../packages/compiler/test/Ownership.test.ts).

### ENUM-004 — `Enum.value` exposes the backing integer in one direction

**Status:** Confirmed

For an enum `E` represented by integer type `R`, `E.value(value)` accepts exactly `E` and returns
that member's declared discriminant as `R`. The generated operation is total, allocation-free,
failure-free, and requirement-free.

```silk
enum(i8) Status {
  Unknown = -1,
  Ready,
}

fn code(status: Status) -> i8 {
  return Status.value(status)
}
```

`Status.value(Status.Unknown)` returns `-1`. There is no built-in inverse operation because only
declared discriminants are valid enum inhabitants.

**Boundary:** An enum does not become an integer in arithmetic, ordering, assignment, arguments, or
returns. An integer does not become an enum even when its value equals a member discriminant.
`Enum.value` exposes representation; it does not erase the nominal type of the original value or
promise that arbitrary representation bits can be reconstructed safely.

**Diagnostics:** Either implicit enum-to-integer or integer-to-enum use reports `SEM0155`. A wrong
enum argument uses the ordinary argument mismatch or the more specific canonical-enum diagnostic
where applicable.

**Evidence:** [enum value operation](../../../../openspec/specs/bootstrap-scalar-enums/spec.md),
[analysis facade tests](../../../../packages/compiler/test/Analysis.test.ts),
[backend enum tests](../../../../packages/compiler/test/Backend.test.ts).

## Fixed arrays, references, and slices

### ARRAY-001 — A fixed array type includes its element type and length

**Status:** Confirmed

`[T; N]` is one inline fixed-array type whose identity contains the canonical element type `T` and
non-negative integer length `N`. Different lengths are different types. Nested and zero-length
arrays retain every element type and length in their identity.

```silk
fn pair(values: [i32; 2]) -> [i32; 2] {
  return values
}
```

`[i32; 2]` is incompatible with `[i32; 3]`. `[Token; 0]` remains distinct from `[End; 0]` even
though neither contains a runtime element.

**Boundary:** `Array<T, N>` is a compiler display encoding found in older artifacts, not valid Silk
source syntax. Length is not inferred across a declared parameter or result type.

**Diagnostics:** Malformed fixed-array syntax receives a parser diagnostic. A contextual array
literal with the wrong length reports `SEM0031`.

**Evidence:** [fixed-array source syntax](../../../../openspec/specs/bootstrap-syntax/spec.md),
[fixed-array specification](../../../../openspec/specs/bootstrap-fixed-arrays/spec.md),
[array ownership](ownership-and-borrowing.md#own-007--array-ownership-derives-from-the-element-type).

### ARRAY-002 — An array literal constructs one homogeneous complete value

**Status:** Confirmed

An array literal evaluates elements once from left to right. With an expected `[T; N]`, every
element is analyzed in immediate `T` context and the written length must be `N`. Without an expected
array type, the first available element selects the precise element type, later elements must be
compatible with it, and the written count becomes the length.

```silk
fn bytes() -> [u8; 3] {
  return [1, 2, 3]
}

fn defaults() -> [i32; 3] {
  let values = [1, 2, 3]
  return values
}
```

The first literal uses contextual `u8`; the second defaults its first element to `i32` and retains
that element type. `[]` requires an expected array type because it has no element from which to
select `T`.

**Boundary:** An uncontextualized heterogeneous literal does not invent a union or numeric common
type. Invalid elements do not create a partially initialized array.

**Diagnostics:** An empty literal without context reports `SEM0029`; an incompatible element
reports `SEM0030` at that element; a contextual length mismatch reports `SEM0031` at the literal.

**Evidence:** [fixed-array specification](../../../../openspec/specs/bootstrap-fixed-arrays/spec.md),
[array elaboration](../../../../packages/compiler/src/Elaboration.ts).

### INDEX-001 — Array and slice indexing uses checked `usize`

**Status:** Confirmed

`subject[index]` requires a fixed array or slice subject and a `usize` index. A known out-of-range
literal is rejected during analysis. A dynamic index checks `index < length` at runtime and traps
before reading, projecting, or evaluating a replacement value.

```silk
fn read(values: [i32; 3], index: usize) -> i32 {
  return values[index]
}
```

Fixed arrays use their type-level length; slices use their runtime length. Zero-length and
zero-sized-element values retain their logical bounds.

**Boundary:** An `i32` variable is not an index even when non-negative. Indexing a `string` is
invalid because text access must name its unit. Ownership determines whether reading or replacing
the selected element is valid.

**Diagnostics:** A non-indexable subject reports `SEM0032`; a non-`usize` index `SEM0033`; a known
out-of-bounds index `SEM0034`. A dynamic overrun is a runtime trap rather than a typed failure.

**Evidence:** [fixed-array indexing](../../../../openspec/specs/bootstrap-fixed-arrays/spec.md),
[slice indexing](../../../../openspec/specs/bootstrap-runtime-slices/spec.md),
[index diagnostics](../../../../packages/compiler/src/Diagnostic.ts).

### VIEW-001 — References and slices include access mode in their type

**Status:** Confirmed

`&T` and `&mut T` are shared and exclusive lexical references to one complete `T`. `&[T]` and
`&mut [T]` are shared and exclusive runtime-length contiguous views. Slice type identity includes
element type, access mode, and lifetime, but not the source array's length.

```silk
fn first(values: &[i32]) -> i32 {
  return values[0]
}

fn use() -> i32 {
  let values = [1, 2]
  return first(&values)
}
```

The explicit borrow converts neither array ownership nor array type. It creates a view for the
borrow's lexical lifetime. Arrays of different lengths may therefore be borrowed for the same
`&[T]` parameter.

**Boundary:** There is no implicit array-to-slice decay. Shared access cannot strengthen to
exclusive access. Shared views may be stored in ordinary values whose declared lifetimes retain
their validity. Explicit `&'a T`, `&'a [T]`, and `string<'a>` spellings and deterministic omissions
follow the [lifetime reference](lifetimes.md). Reborrowing and loan endings follow the ownership reference.

**Diagnostics:** Invalid borrow operands report `SEM0056`; exclusive borrowing of an immutable root
uses `SEM0057`; ambiguous lifetime elision uses `SEM0210`; expired validity uses `OWN0019`; invalid reborrowing
uses `SEM0058`; implicit array decay uses `SEM0059`.

**Evidence:** [runtime slice specification](../../../../openspec/specs/bootstrap-runtime-slices/spec.md),
[borrow rules](ownership-and-borrowing.md#borrow-001--a-shared-borrow-grants-temporary-read-access),
[returned views](ownership-and-borrowing.md#view-001--an-ordinary-result-follows-declared-lifetime-relationships).

## Raw pointers

### PTR-001 — A raw pointer is one un-owned machine address

**Status:** Confirmed

`*const T` and `*mut T` are non-null single-object pointers. `[*]const T` and `[*]mut T`
carry many-element extent without a length. Prefix either form with `?` to admit foreign null.
Each pointer preserves its invariant pointee, mutability, nullability, extent, minimum alignment,
and address space, including at nested levels. All forms are Copy addresses that own nothing and
hold no loan. Non-nullness does not establish live or initialized storage. Optional `align(N)`
sets a power-of-two minimum alignment; omission means the pointee's semantic natural alignment.
Only `addrspace(0)` is admitted. See [the native boundary](native-pointer-boundary.md).

```silk
struct Opaque {}

struct Handle {
  raw: *mut Opaque
}

fn keep(handle: Handle) -> Handle {
  let again = handle.raw
  let copy = handle.raw
  return handle
}
```

Reading `handle.raw` twice is an ordinary Copy read: nothing moves and the binding records no
cleanup. `*mut T` converts to `*const T` at an immediate expected-type boundary, such as an
argument for a `*const T` parameter; the reverse direction is an ordinary type mismatch.

**Boundary:** Implicit conversions may remove mutation capability, add nullability, or weaken
alignment. They preserve extent and the invariant pointee. Unsafe qualifier conversion preserves
pointee and address space and requires proof of each strengthened guarantee. A slice remains a
distinct value. Pointer arithmetic is expressed through many-pointer indexing; no pointer-to-integer
or pointer-to-reference conversion is admitted. Only a valid C-layout record permits native field
interpretation. C function pointers have their own distinct type.

**Diagnostics:** Passing `*const T` where `*mut T` is expected reports the ordinary type mismatch.
A `*` in type position not followed by `const` or `mut` is a parser diagnostic that recovers at the
pointee.

**Current compiler:** Aligned. `Type.Pointer` is one variant whose canonical key carries the
pointee and every qualifier; the Copy proof and the layout entry mark it Copy the way builtin scalars
are, and instance keys treat it as an ordinary concrete runtime type that does not reach the
pointee's instances.

**Evidence:** [raw pointer specification](../../../../openspec/changes/add-native-pointer-boundary/specs/bootstrap-raw-pointers/spec.md),
[pointer type variant](../../../../packages/compiler/src/Type.ts),
[pointer layout](../../../../packages/compiler/src/Layout.ts),
[C ABI classification](../../../../packages/compiler/src/CAbi.ts).

### PTR-002 — Pointer primitives are sealed and split by safety

**Status:** Confirmed

The compiler exposes the pointer primitives through the sealed `Intrinsic` namespace, and the
module `silk/pointer` exposes them as the ordinary `Pointer` API:

| Operation                                                          | Safety | Result                                         |
| ------------------------------------------------------------------ | ------ | ---------------------------------------------- |
| `null<T>()`                                                        | safe   | `?*mut T`                                      |
| `isNull`, `isNullMany`                                             | safe   | `bool`                                         |
| `nonNull`, `nonNullMut`, `nonNullMany`, `nonNullManyMut`           | safe   | `Option` of the corresponding non-null pointer |
| `fromRef(value: &T)`                                               | safe   | `*const T`                                     |
| `fromMutRef(value: &mut T)`                                        | safe   | `*mut T`                                       |
| `fromSlice(values: &[T])`                                          | safe   | `?[*]const T`                                  |
| `fromMutSlice(values: &mut [T])`                                   | safe   | `?[*]mut T`                                    |
| `at(pointer: [*]const T, index: usize)`                            | unsafe | `*const T`                                     |
| `atMut(pointer: [*]mut T, index: usize)`                           | unsafe | `*mut T`                                       |
| `read<T: Copy>(pointer: *const T)`                                 | unsafe | `T`                                            |
| `write<T: Copy>(pointer: *mut T, value: T)`                        | unsafe | `()`                                           |
| `readUnaligned`, `writeUnaligned`                                  | unsafe | `T` or `()`; accepts `align(1)`                |
| `assumeAligned`, `assumeAlignedMut`, `assumeMany`, `assumeManyMut` | unsafe | Pointer with the asserted qualifier            |

Formation takes an address without reading its pointee. `at` and `atMut` use the semantic element
stride and require the selected element to lie within one live allocation. Reads require an
initialized live value; writes require live writable storage. Aligned operations require natural
alignment. Unaligned operations emit no stronger LLVM alignment than the source guarantee.

```silk
import silk.pointer { Pointer }

fn seventh() -> i32 {
  let mut value = 0
  let pointer = Pointer.fromMutRef(&mut value)
  unsafe {
    Pointer.write(pointer, 7)
  }
  return value
}
```

The `Pointer` source API bounds `read` and `write` to a Copy pointee, so `Pointer.read` on a
`*const Vector<i32>` is rejected at the bound, exactly as `RawBuffer.read` is. MIR verification
applies the same Copy rule to every pointer read and write operation as the backstop for direct
intrinsic use. Every primitive is available through LLVM on native and WebAssembly targets.

**Boundary:** A pointer cannot move a non-Copy value through raw memory. `silk/output` provides
ordinary Copy output-state owners over raw storage. `Slot.address` consumes a raw slot selection
without reading or initializing it. A foreign call does not change the owner's initialization state;
`Uninitialized.assumeInitialized` requires an unsafe proof of a complete valid value.

**Diagnostics:** Calling `read`, `write`, `at`, or `atMut` outside an unsafe boundary
reports the existing unsafe-acknowledgement diagnostic. A move-only pointee at `read` or `write`
reports the ordinary bound failure naming the Copy requirement. A pointer read or write whose
pointee is not Copy in constructed MIR is a structural verification violation and emits no artifact.

**Current compiler:** Aligned. The `Pointer` intrinsic actor carries one all-target operation per
primitive, each unsafe one with its caller invariant; `silk/pointer.silk` wraps them with the
documented bounds.

**Evidence:** [raw pointer specification](../../../../openspec/changes/add-native-pointer-boundary/specs/bootstrap-raw-pointers/spec.md),
[pointer intrinsics](../../../../packages/compiler/src/Intrinsic.ts),
[pointer source API](../../../../packages/compiler/stdlib/silk/pointer.silk),
[unsafe boundaries](unsafe-intrinsics-and-targets.md#unsafe-003--unsafe-call-marks-one-invocation-unsafe---marks-a-statement-region).

### PTR-003 — Formation ends no loan and validity is the caller's obligation

**Status:** Confirmed

Forming a pointer from a borrow is an ordinary read of that borrow: the borrow's loan ends where
it would anyway, and the pointer itself holds no loan on the root. The root stays movable,
mutable, and droppable while pointers to it exist.

```silk
import silk.pointer { Pointer }

fn address(value: i32) -> *const i32 {
  let pointer = Pointer.fromRef(&value)
  return pointer
}
```

Returning a pointer to a local is accepted; the local's storage ends with the frame, so
dereferencing the result is the caller's unsafe obligation. A dangling pointer is an
unsafe-contract violation under
[SAFETY-001](unsafe-intrinsics-and-targets.md#safety-001--only-violating-an-explicit-unsafe-contract-permits-undefined-behavior),
not a compile error.

A place from which a pointer has been formed has authoritative memory storage for the rest of its
live range, as every borrowed root does, and every call reloads such places afterwards. A foreign
call reloads them the same way, so a subsequent Silk read observes bytes native code wrote through
the pointer during the call. The compiler never caches the place's value across a foreign call.

**Boundary:** Formation does not keep the root alive, extend its scope, or reject the program when
the root's scope ends. Observability is stated for the place the pointer was formed from; writes
through a pointer obtained from native allocation are observable through pointer reads only.

**Diagnostics:** None at formation. Ownership records no loan conflict when the root is moved
after a pointer is formed from it.

**Current compiler:** Aligned. Ownership treats formation as a read of the borrow. The native
backend already materializes every borrowed root in memory and reloads every address root after
each synchronous and foreign call, so a Silk callee writing through a `*mut` parameter is observed
by its caller.

**Evidence:** [raw pointer specification](../../../../openspec/changes/add-native-pointer-boundary/specs/bootstrap-raw-pointers/spec.md),
[pointer ownership](../../../../openspec/changes/add-raw-pointers/specs/bootstrap-ownership/spec.md),
[backend reload rule](../../../../openspec/changes/add-raw-pointers/specs/bootstrap-backend/spec.md),
[borrow rules](ownership-and-borrowing.md#borrow-003--a-borrow-preserves-the-original-owner).

## Structural unions and inference

### UNION-001 — A structural union is a normalized set of ordinary value types

**Status:** Confirmed

`A | B` denotes a finite, unordered, duplicate-free set of canonical ordinary value types. Nested
unions flatten, member order does not affect identity, duplicate members disappear, `never` is the
empty union, and a one-member union normalizes to that member. Members need not be nominal: scalars,
arrays, `string`, and other detached concrete value types use the same union operation. A callable
or Effect member must additionally retain one finite exact, opaque, or composite representation;
its bare structural contract has no standalone storage layout.

```silk
struct Token { kind: i32 }
struct End {}

fn next(done: bool) -> Token | End {
  if done {
    return End {}
  }
  return Token { kind: 1 }
}
```

`Token | End`, `End | Token`, and `Token | (End | Token)` are the same type.

```silk
fn describe(code: i32) -> i32 | string {
  if code == 0 {
    return "none"
  }
  return code
}
```

Executable members use their ordinary representation syntax:

```silk
fn add(left: i32, right: i32) -> i32 { return left + right }

fn selected() -> typeof(add) | i32 {
  return add
}
```

`typeof(add)` contributes the callable's exact finite environment plan. An opaque result binder can
do the same for an Effect construction without exposing its private runner identity. By contrast,
`fn(i32) -> i32 | i32` and `Effect<i32> | i32` are invalid: those structural contracts alone do not
identify storage.

**Boundary:** Union formation does not erase ownership, lifetime, Effect requirements, callable
access, or another member property. A lexical borrow cannot become an owned union member; a union
never makes it detached. Requirement rows remain capability rows rather than value unions.

Generic unions normalize again after monomorphic substitution. If `A | B` specializes with both
parameters equal to `i32`, the instance carries `i32`, not two indistinguishable tags. TIR retains
the authored mapping and MIR deterministically recomputes the concrete mapping and canonical order.

**Diagnostics:** An unresolved or otherwise unavailable member reports that member's ordinary type
diagnostic. A borrow or bare executable contract reports `SEM0039` because it has no detached finite
storage plan. A valid non-nominal or represented executable member produces no diagnostic.

**Current compiler:** Aligned. Normalization, compatibility, target layout, ownership, cleanup,
TIR/MIR mappings and LLVM lowering for native and WebAssembly targets consume canonical ordinary
member identities. Exact and opaque executable representations remain compiler-private while their
public contract spelling is preserved.

**Evidence:** [union normalization](../../../../packages/compiler/src/Type.ts),
[ordinary failure values](typed-failures.md#fail-001--any-concrete-lifetime-valid-value-may-be-a-typed-failure).

### UNION-002 — Precise injection and union widening occur only at immediate expected boundaries

**Status:** Confirmed

A precise value is compatible with an expected union containing its type. A union value is
compatible with a wider expected union only when the target contains every source member.

```silk
struct Token { kind: i32 }
struct End {}
struct Fault {}

fn widen(value: Token | End) -> Token | End | Fault {
  return move value
}
```

The conversion preserves the active member and complete payload. Immediate union contexts
include declared returns, parameters, struct fields, contextual array elements, and assignments.

**Boundary:** Compatibility never subtracts or guesses a member. `Token | Fault` cannot become
`Token | End`, and a value does not narrow merely because control reaches a use that wants one
member. Pattern matching performs explicit narrowing.

Union conversion does not rewrite the source expression's precise type. Runtime tags distinguish
members even when their layouts happen to match, but remain internal deterministic compiler data
with no source-visible, serialization, or stable ABI identity.

**Diagnostics:** A target missing any source member reports `SEM0040`, naming the source, target,
and uncovered members. Ownership diagnostics still apply when moving an affine payload.

**Evidence:** [structural union specification](../../../../openspec/specs/bootstrap-structural-unions/spec.md),
[compatibility implementation](../../../../packages/compiler/src/TypeCompatibility.ts),
[match narrowing](functions-callables-and-control-flow.md#match-004--matching-narrows-only-inside-the-selected-arm).

### INFER-001 — A binding keeps the precise type of its initializer

**Status:** Confirmed

An unannotated local binding receives the precise type of its initializer after literal selection.
Later uses do not widen, narrow, or otherwise rewrite that type. Each use is checked independently
against its own expected context.

```silk
struct Token { kind: i32 }
struct End {}

fn accept(value: Token | End) -> i32 {
  return match move value {
    Token { kind } => kind
    End {} => 0
  }
}

fn use() -> i32 {
  let token = Token { kind: 42 }
  return accept(move token)
}
```

`token` remains `Token`; only the call argument injects it into `Token | End`.

**Boundary:** Expected types do not flow backward through an already-completed binding:

```silk,ignore
fn acceptByte(value: u8) {}

fn invalid() {
  let value = 1
  acceptByte(value)
}
```

`value` is `i32`, so the call is invalid. Writing the literal directly as `acceptByte(1)` permits
the parameter to select `u8` before the literal becomes a value.

**Diagnostics:** Binding inference itself produces no diagnostic when the initializer has a type.
An unavailable initializer leaves the binding unavailable. A later incompatible use reports at that
use, such as `SEM0012` for the call above.

**Evidence:** [semantic binding facts](../../../../openspec/specs/bootstrap-semantic-facts/spec.md),
[literal contextualization](../../../../packages/compiler/src/Elaboration.ts),
[union conversion specification](../../../../openspec/specs/bootstrap-structural-unions/spec.md).
