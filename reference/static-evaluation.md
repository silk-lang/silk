# Static evaluation

Silk has one explicit compile-time execution phase. Static evaluation computes finite values,
selects source with `static if`, and specializes ordinary functions before the residual runtime
program is checked for ownership, reachability, target availability, and lowering.

Ordinary function and control-flow rules are defined by
[functions, callables, and control flow](functions-callables-and-control-flow.md). Runtime ownership
is defined by [ownership and borrowing](ownership-and-borrowing.md). Constants and the foundational
types admitted as constant results are defined by [values and types](values-and-types.md).

## Terminology

- A **static function** is a module-level or inherent `static fn` whose complete body executes
  during compilation.
- A **mixed function** is an ordinary function with static parameters, static local bindings, or
  static conditionals alongside runtime work.
- A **static parameter** is an explicitly marked specialization input omitted from the runtime
  calling shape.
- A **static binding** is a `let static` local that retains a computed static value for later static
  use.
- A **static value** is finite, deterministic, identity-free compiler data admitted by the static
  value rules.
- A **static specialization** is one application identified by its declaration, target, generic
  arguments, selected evidence, and canonical static arguments.
- The **residual program** is the ordinary runtime work left after static evaluation selects source
  and embeds representable static results.

## Static declarations and function phases

### STATIC-001 — A static function is a compile-time declaration

**Status:** Confirmed

A static function is declared as `static fn` or `pub static fn`. It may be private or public and
may be a top-level module declaration, a method in an inherent `impl Type` block, an interface
operation, or the operation's witness in a conformance (INTF-008). Every call to
it occurs during static evaluation, every argument must be statically available, and its result is
one static value or one static diagnostic.

```silk
pub static fn positive(value: i32) -> bool {
  return value > 0
}

struct Limits {}

impl Limits {
  pub static fn defaultSteps() -> u32 { return 64 }
}
```

A static function has no runtime function item, callable representation, parameter lanes, instance,
symbol, or backend body.

**Boundary:** `static` cannot combine with `unsafe` or `effect`, and is forbidden on service
operations. A conformance supplies a static interface operation with a static witness and a runtime
operation with a runtime one. Nested static function
declarations within executable bodies are unavailable. Module declaration groups may select static
functions. A static function cannot be captured or passed as a runtime callable.

**Diagnostics:** An unsupported modifier combination or declaration position reports a syntax
diagnostic at the conflicting modifier or declaration. A use requiring a runtime callable reports
a static-phase violation at that use. A static call that selects a runtime interface operation, or
a runtime call of a static one, reports `SEM0176` at the call.

**Evidence:** static syntax requirements,
static function requirements.

### STATIC-002 — Static parameters and bindings make phase crossings explicit

**Status:** Confirmed

Prefixing an ordinary function parameter with `static` makes it a specialization input. The
parameter retains an explicit declared type but occupies no runtime parameter lane. `let static`
evaluates its required initializer during compilation and retains the result for later static use.

```silk
fn render(static enabled: bool, value: i32) -> i32 {
  let static selected = enabled
  static if selected {
    return value
  } else {
    compileError("rendering is disabled")
  }
}
```

A literal directly supplied to a static parameter, binding initializer, condition, or
`compileError` message is available without a call-site `static` marker. A non-literal expression
is available only when all of its dependencies and operations are static.

**Boundary:** Static parameters and `let static` bindings cannot also be `mut`. An ordinary local
remains runtime even when its initializer is a literal; preserving the value for later static use
requires `let static`. Inside a `static fn`, ordinary locals and control flow are already static, so
a local is written with plain `let`; `let static` there reports `SEM0176`.

A runtime function's body supplies static arguments to any call it writes: a type-qualified call
such as `Leaf.own(&leaf, spec)`, method-call syntax such as `leaf.own(spec)`, and a call of an
interface operation that declares a `static` parameter, through the interface (`Walk.walk(&leaf,
spec)`), method syntax, or a generic bound (`item.walk(spec)` for `T: Walk`). An interface call's
static operands select the witness instance, as a direct call's select the callee's. A `static fn`
body cannot call a function with `static` parameters yet.

**Diagnostics:** Passing a runtime value to a static parameter, reading a runtime local from static
evaluation, or using a runtime operation in a static initializer reports `SEM0176` at the operation
and identifies the static boundary that required the value. A call through method syntax or an
interface operation to a function with `static` parameters where its static arguments cannot be
selected, such as in a `static fn`, reports `SEM0249` at the call.

**Evidence:** explicit static modes,
static syntax recovery.

## Static selection and compile errors

### STATIC-003 — `static if` selects one semantic arm

**Status:** Confirmed

`static if` is a statement form with a statically evaluated `bool` condition, one block, and an
optional `else` block. Both arms are parsed, but only the selected arm undergoes name resolution,
type elaboration, ownership-producing residualization, and call discovery for that specialization.

```silk
fn wordSize(static wide: bool) -> u32 {
  static if wide {
    return 64
  } else {
    return 32
  }
}
```

The selected arm may contain ordinary runtime operations and values. Those operations are retained
in the residual program; static evaluation does not execute them. A false `static if` without an
`else` contributes no residual operation.

At module scope, `static if` selects a declaration group according to
[module static selection](./module-static-selection.md). Within executable bodies it remains a
statement and cannot introduce local declarations.

**Boundary:** `static if` is not an expression. An ordinary runtime `if`, loop, or `return` cannot decide whether later static
source is elaborated. Source that must be excluded during compilation belongs in an unselected
`static if` arm.

**Diagnostics:** Syntax errors in either arm are reported because both arms are parsed. Name, type,
Effect, requirement, ownership, availability, and reachability diagnostics arise only from the
selected arm. A non-static or non-`bool` condition reports its phase or type diagnostic at the
condition.

**Evidence:** static selection requirements,
statement-only syntax.

### STATIC-004 — `compileError` terminates only the selected specialization

**Status:** Confirmed

`compileError(message)` is dedicated compile-time syntax. Its one argument must produce a static
`string`. Reaching it reports `SEM0177`, terminates the current specialization, and discards every
partial static value and residual operation accumulated for that specialization. It acts as
`never` for the selected static path.

```silk
static fn requireEnabled(enabled: bool) -> bool {
  if enabled {
    return enabled
  }
  compileError("expected an enabled feature")
}
```

A `compileError` in an unselected static arm or an uncalled static function does not execute and
does not report a diagnostic.

**Boundary:** `compileError` is not an ordinary function. It cannot be imported, shadowed,
captured, or passed as a value, and it accepts exactly one argument with no trailing comma. It does
not define a runtime panic or failure mechanism. Runtime control flow cannot suppress a reachable
`compileError`.

**Diagnostics:** `SEM0177` points at the selected `compileError` and retains the static
specialization trace. A runtime message or wrong message type reports its phase or type diagnostic
instead.

**Evidence:** compile-error requirements,
dedicated syntax.

## Static values and mutation

### STATIC-005 — Static values are reusable data, not observable compile-time storage

**Status:** Confirmed

A static value is finite, deterministic, identity-free, and freely reusable during static
evaluation. Admitted values include unit, foundational scalars, scalar enums, static UTF-8 text,
recursively pure aggregates whose members are admitted (structs, tuples, fixed arrays and the
variants of nominal unions, such as `Option<i32>.Some {value: 1}`), and shared views of admitted
static data:
a `&'static T` and a `&'static [T]`. Admission excludes values carrying a runtime resource,
exclusive borrow, opaque identity, callable execution, Effect, service, unsafe pointer, or
observable cleanup behavior.

Reusing a static value does not grant its declared runtime type the `Copy` property and does not
change runtime interface selection. When an admitted value is runtime-representable and
cleanup-free, residualization may embed it directly without retaining compiler storage.

**Boundary:** Static evaluation has no observable addresses, mutable aliases, destructors,
allocator identities, or observable allocation. It cannot construct or run an Effect, invoke an
ordinary runtime function, read a runtime binding, or perform unsafe, external, or host work.

A static function value is a static value. In a static body or a `let static` initializer, a
static function can be named as a value, partially applied
([CALLABLE-002](functions-callables-and-control-flow.md#callable-002--supplying-a-trailing-argument-suffix-constructs-a-section)),
passed to a static function's `fn(A) -> B` parameter, and called directly or through a pipeline.
A section stores its supplied arguments as static data, so it can be called again even when a
captured value is not `Copy`. A function value whose target is a `static fn` exists only during static evaluation and has no
runtime representation; one whose target is an ordinary function can reach runtime code
(STATIC-020).

```silk
static fn calc() -> Command {
  let values = Arg.named("values") |> Arg.required
  let withValues = Command.arg(values)
  return Command.make("calc", "Integer calculator")
    |> Command.subcommand("sum", Command.make("sum", "Add values") |> withValues)
    |> Command.subcommand("product", Command.make("product", "Multiply values") |> withValues)
}
```

Static data never changes and, once embedded, lives for the whole program, so a static body can
view it through a shared borrow. A view is valid for `'static`: `&value` is a `&'static T`, and a
borrowed array is a `&'static [T]` wherever a slice is expected. Indexing, `.length`, `.*` and field
reads see through the view, so constants can hold trees of static data. A view cannot borrow a
`let mut` local, whose later assignment the view would not see. When a view reaches runtime code,
its referent is emitted as immutable program-lifetime storage
([BORROW-006](ownership-and-borrowing.md#borrow-006--a-borrow-requires-an-owner-not-a-source-level-name))
and the view is that storage's address. An index past the end of a static array or slice fails the
evaluation.

```silk
pub struct Command {
  pub name: string<'static>,
  pub subcommands: &'static [&'static Command],
}

const ADD: Command = Command {name: "add", subcommands: &[]}
const ROOT: Command = Command {name: "calc", subcommands: &[&ADD]}
```

**Diagnostics:** Attempting a prohibited operation reports `SEM0176` at that operation and produces
no static result. Naming an anonymous function or a bound method value as a value in a static body
reports `SEM0176` at that expression. An exclusive borrow (`&mut`) or a borrow of a `let mut` local in a static body reports `SEM0176`. A value outside the admitted domain is rejected at the static boundary rather than
acquiring a second compile-time ownership model.

**Evidence:** static value requirements,
[canonical static values](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/StaticValue.ts).

### STATIC-006 — Static mutation assigns to a local or a part of one

**Status:** Confirmed

Inside a `static fn`, ordinary `let mut` creates one mutable evaluator-local slot. Assignment
replaces the complete stored static value, or one field or element of it: `point.x = 1`,
`items[i] = value` and `outer.inner.count = 2` store a new value in the slot with that part
replaced. Ordinary `if`, `if let`, `match`, `while`, `break`, `continue`, and `return` operate in
the static function's compile-time phase; an `if`, `if let` or `match` is also a value, and a
`return` inside one of its branches leaves the function when the branch is a whole statement, a
binding's initializer or a returned value.

```silk
union Shape { Dot, Circle { pub r: u32 } }

static fn area(shape: Shape) -> u32 {
  return match move shape {
    Shape.Dot => 0
    Shape.Circle {r} if r > 100 => 1
    Shape.Circle {r} => r * r * 3
  }
}

static fn countTo(limit: u32) -> [u32; 3] {
  let mut counts = [0, 0, 0]
  let mut at: usize = 0
  while at < 3 {
    counts[at] = limit + 1
    at = at + 1
  }
  return counts
}
```

**Boundary:** Static mutation cannot take an exclusive reference to the slot, project a writable
place through an alias or a static view, partially move a value, observe cleanup, or retain the
slot in a residual value. A `match &mut` binding is unavailable. A mixed function cannot declare
`let static mut`; it computes a new static value through a static function instead.

**Diagnostics:** An exclusive static borrow, unsupported place mutation, an index past the end of
a static array, or runtime-dependent replacement reports `SEM0176` at the invalid operation. The
failed evaluation exposes no partial value.

**Evidence:** static mutation limits.

### STATIC-007 — `silk.core.static_text` inspects UTF-8 bytes without exposing storage

**Status:** Confirmed

The ordinary standard-library module `silk.core.static_text` provides static byte operations for text
available during compilation:

| Member                                | Result   | Meaning                                                                    |
| ------------------------------------- | -------- | -------------------------------------------------------------------------- |
| `StaticText.byteLength(value)`        | `usize`  | Number of bytes in the UTF-8 encoding                                      |
| `StaticText.byteAt(value, index)`     | `u8`     | Byte at one in-bounds byte index                                           |
| `StaticText.concat(left, right)`      | `string` | Concatenated static text, retaining `left` as its diagnostic source anchor |
| `StaticText.slice(value, start, end)` | `string` | Text in one byte range whose endpoints are UTF-8 scalar boundaries         |

```silk,ignore
import silk.core.static_text { StaticText }

static fn hasAccent(value: string) -> bool {
  return StaticText.byteLength(value) == 3 && StaticText.byteAt(value, 1) == 195
    && StaticText.concat(StaticText.slice(value, 1, 3), "!") == "é!"
}
```

They are ordinary `static fn` members of `StaticText`. They return admitted values and reveal neither an address
nor mutable compiler storage. Their sealed intrinsic primitives are static-only and cannot survive
in runtime TIR.

**Boundary:** `byteAt` rejects an out-of-bounds index. `slice` rejects an invalid range and any
endpoint that splits a UTF-8 scalar encoding. Both failures are phase violations with source text
provenance rather than runtime traps. `concat` is bounded by the ordinary retained-value budget.

**Evidence:** [static text source actor](../stdlib/silk/core/static_text.silk),
static value requirements.

## Reflection, static sequences, iteration, and formatting

### STATIC-008 — Reflection exposes finite aggregate metadata only during specialization

**Status:** Confirmed

`silk.core.reflect` exposes canonical descriptors for one concrete aggregate type and its fields. Named
tuples and anonymous positional aggregates expose positions; named structs and anonymous records
expose visible labels. Declaration order, nominal owner identity, generic substitution, aggregate
kind, and the reflecting declaration's visibility authority are retained.

| Member                                | Result                      | Meaning                                                 |
| ------------------------------------- | --------------------------- | ------------------------------------------------------- |
| `typeOf<Owner>()`                     | `Intrinsic.Type<Owner>`     | Descriptor for one concrete aggregate owner             |
| `fields<Owner>()`                     | `Intrinsic.Fields<Owner>`   | Ordered heterogeneous field collection                  |
| `typeKind(descriptor)`                | `u8`                        | Stable named/positional aggregate-kind code             |
| `fieldKind(field)`                    | `u8`                        | Stable labeled/positional/variant member-kind code      |
| `fieldLabel(field)`                   | `string`                    | Label of a labeled or variant field                     |
| `fieldOrdinal(field)`                 | `usize`                     | Position of a positional or variant field               |
| `borrowField(owner, static field)`    | `&Value`                    | Shared runtime projection authorized by the descriptor  |
| `borrowFieldMut(owner, static field)` | `&mut Value`                | Mutable runtime projection authorized by the descriptor |
| `variants<Union>()`                   | `Intrinsic.Variants<Union>` | Ordered variant collection of a nominal union           |
| `variantLabel(variant)`               | `string`                    | Declared name of a variant                              |
| `variantFields(variant)`              | `Intrinsic.Fields<Union>`   | Ordered fields of one variant                           |
| `makeVariant(static variant, fields)` | `Union`                     | The variant built from a tuple of its fields            |
| `isVariant(owner, static variant)`    | `bool`                      | Whether the union holds that variant                    |

A nominal union reports `unionKind`. `makeVariant` takes a tuple of the variant's fields in
declaration order, `()` for a unit variant, and is exactly the written construction
`Union.Variant { ... }` of those values; a tuple whose types differ from the fields reports
`SEM0012`. `isVariant` is exactly a `match` on a shared view of the owner with one arm for the
variant. Construction needs every field of the variant to be visible where the variant was
reflected.

Descriptors remain nominal: equal field shapes from separate structs do not become assignment-
compatible or share projection authority. Private fields are absent outside their declaring module
and their spellings cannot leak through reflection diagnostics.

**Boundary:** `Intrinsic.Type`, `Intrinsic.Fields`, `Intrinsic.Field`, `Intrinsic.Variants`, and
`Intrinsic.Variant` are phase-only nominals
with no runtime layout, address, ownership, or backend representation. `borrowField` accepts only a
shared reference to the descriptor's exact owner, and `borrowFieldMut` only a mutable one; each
consumes its descriptor during specialization. Neither can project an owned value, use a descriptor
at runtime, or extend the result beyond the owner's ordinary borrow lifetime. A mutable projection
is an ordinary mutable loan of the field, so the owner is unusable while it lives. A variant's
field descriptor is not a place of its union, so `borrowField` refuses it (`SEM0012`).

**Evidence:** static reflection requirements,
[reflection source actor](../stdlib/silk/core/reflect.silk).

### STATIC-009 — Static sequences are immutable compile-time values

**Status:** Confirmed

`silk.core.static_sequence` provides `empty`, `append`, `concat`, `length`, and `at` over
`Intrinsic.StaticSequence<Element>`. Every operation returns a complete canonical value; append and
concatenation do not mutate the input sequence.

```silk,ignore
import silk.core.static_sequence { StaticSequence }

static fn values() -> Intrinsic.StaticSequence<i32> {
  let mut result = StaticSequence.empty<i32>()
  result = StaticSequence.append<i32>(move result, 20)
  result = StaticSequence.append<i32>(move result, 22)
  return move result
}
```

**Boundary:** A static sequence has no capacity, allocator, reference, mutable alias, destructor, or
runtime layout. It cannot appear in a residual signature, binding, call, ownership fact, or backend
artifact. `at` rejects an out-of-bounds index during static evaluation.

**Evidence:** static sequence requirements,
[static sequence source actor](../stdlib/silk/core/static_sequence.silk).

### STATIC-010 — `static for` generates ordinary runtime work from finite static elements

**Status:** Confirmed

`static for <binding> in <expression> { ... }` is a statement. Its iterable must evaluate to a
finite static sequence or reflected field collection. The compiler re-elaborates one fresh body
scope per element in deterministic order. A heterogeneous field collection gives each scope the
field descriptor's concrete `Field<Owner, Value>` type, so one authored body can select different
interfaces and generate differently typed runtime operations.

```silk,ignore
import silk.core.reflect { Reflect }

fn visit<Owner>(owner: &Owner) -> () {
  static for field in Reflect.fields<Owner>() {
    let value = Reflect.borrowField(owner, field)
    inspect(value)
  }
}
```

A zero-element loop contributes no residual statements and does not elaborate its body. If iterable
evaluation, a later iteration, or a static budget fails, the whole expansion is discarded: earlier
generated calls, TIR, ownership, cleanup, and instance facts do not survive.

**Boundary:** `static for` is not a runtime loop, expression, declaration container, or unbounded
generator protocol. Runtime values, Effects, services, unsafe operations, host input, I/O, time,
randomness, and external access cannot supply its iterable. The residual program contains only the
ordinary operations produced by successful iterations.

**Evidence:** static iteration requirements,
static iteration syntax.

### STATIC-011 — Template formatting validates statically and writes borrowed fields at runtime

**Status:** Confirmed

`silk.text.format.Format.format<Args>(static template: string, args: &Args)` accepts one static template
and one ordinary shared reference to a tuple or record argument pack. Positional `{}` placeholders
consume every tuple position in order. Named `{name}` placeholders select visible record fields;
they may repeat, and unrelated fields may remain unused. `{{` and `}}` emit literal braces.

```silk,ignore
run Format.format("My name is {}, I'm {}", &("Julia", 31))
run Format.format("Hello, {name}", &.{ name: "Julia", age: 31 })
```

Parsing, aggregate-kind checking, field lookup, and `Display` selection finish during
specialization. Runtime code retains only ordered Writer text operations, ordinary shared field
projections, and concrete `Display` calls. The template, parser plan, descriptors, static loops, and
argument-pack copy are absent. `Display<string>` writes the borrowed string's existing UTF-8 bytes
through the same Writer path as other presentations and allocates no intermediate String.

**Boundary:** One template cannot mix positional and named placeholders. The initial grammar has no
format specifiers, dynamic widths, interpolation expressions, nested fields, runtime placeholder
names, variadic calling convention, or runtime parser. Malformed braces, invalid labels, wrong
aggregate kinds or arity, unavailable fields, and missing `Display` evidence fail specialization
before Writer execution is published. An uncalled invalid application remains unevaluated.

**Evidence:** template formatting requirements,
[Format source actor](../stdlib/silk/text/format.silk).

## Demand, diagnostics, and the runtime boundary

### STATIC-012 — Static evaluation is demand-driven and leaves one runtime program

**Status:** Confirmed

The compiler evaluates a static function or mixed specialization only when a concrete selected
target and static application is demanded by a constant initializer or reachable executable work.
Loading, indexing, importing, or navigating an uncalled declaration does not execute its body.
Equal target, generic arguments, evidence, and canonical static arguments reuse one deterministic
result.

After selection, static parameters, static locals, static-function frames, inactive arms, and
static-only intrinsics are absent from runtime calling shapes, ownership facts, cleanup plans,
runtime reachability, MIR, and backend artifacts. Runtime analysis sees only the selected residual
program.

**Boundary:** Runtime control flow cannot defer static evaluation to an execution engine. Static
functions have no runtime address or callable form, and target information cannot be preserved as a
runtime query.

**Diagnostics:** A failed static application publishes its static diagnostic and no partial
residual body. An uncalled failing declaration publishes no static diagnostic.

**Evidence:** residual-program requirements,
residual instance requirements,
residual ownership requirements.

### STATIC-013 — Static diagnostics are deterministic source traces

**Status:** Confirmed

Static diagnostics retain the primary operation, selected target, ordered static calls, canonical
static arguments, and selected `static if` arms. Static-text diagnostics may also retain the source
literal and byte offset. They do not expose host stack frames, JavaScript causes, compiler
addresses, cache identities, or backend details.

| Code      | Condition                                                     |
| --------- | ------------------------------------------------------------- |
| `SEM0176` | An operation or value is unavailable during static evaluation |
| `SEM0177` | A selected `compileError` requests compilation failure        |
| `SEM0178` | A demanded static application forms a cycle                   |
| `SEM0179` | The deterministic evaluator-step limit is exhausted           |
| `SEM0180` | The logical static call-depth limit is exhausted              |
| `SEM0181` | The retained canonical-value byte limit is exhausted          |
| `SEM0182` | The residual-program growth limit is exhausted                |

Limit diagnostics name the exhausted resource and produce no partial value or residual program.
They never masquerade as a source-requested `compileError`.

**Boundary:** The concrete limit thresholds are compiler policy, not successful-program semantics.
Changing a threshold does not change the meaning of a program that remains within every limit.

**Diagnostics:** Repeating the same failing source, target, generic arguments, evidence, and static
arguments produces the same code, semantic details, related spans, and trace encoding.

**Evidence:** static diagnostic requirements,
[diagnostic catalog](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/Diagnostic.ts).

## Target information

### STATIC-014 — `silk.core.target` exposes target information only as static source values

**Status:** Confirmed

The ordinary standard-library module `silk.core.target` exposes individual machine facts:

| Member                     | Type              | Value                                  |
| -------------------------- | ----------------- | -------------------------------------- |
| `Target.arch()`            | `Arch`            | Instruction-set architecture           |
| `Target.operatingSystem()` | `OperatingSystem` | Operating system                       |
| `Target.abi()`             | `Abi`             | Platform ABI                           |
| `Target.objectFormat()`    | `ObjectFormat`    | Object-file format                     |
| `Target.endianness()`      | `Endianness`      | Byte order                             |
| `pointerBits`              | `u32`             | Data-pointer width in bits             |
| `pointerAlignment`         | `u32`             | Data-pointer alignment in bytes        |
| `usizeMax`                 | `usize`           | Largest unsigned pointer-sized integer |
| `isizeMax`                 | `isize`           | Largest signed pointer-sized integer   |
| `isizeMin`                 | `isize`           | Smallest signed pointer-sized integer  |

Use `silk.core.compilation` for typed logical build choices. Source checks use the narrow domain needed
for the decision. The complete [compilation profile](compilation-profiles.md) also contains resolved
package parameters and controls static-evaluation identity.

```silk,ignore
import silk.core.target { Target, Arch }

fn targetWordBits() -> u32 {
  static if Target.arch() == Arch.Wasm32 {
    return 32
  } else {
    return 64
  }
}
```

The selected target is fixed before any demanded specialization executes. The result of static
selection is ordinary residual source; no target-profile parameter or runtime probe remains.

**Boundary:** `silk.core.target` is ordinary source and receives no compiler-known name privilege. The
sealed individual target and profile-fact intrinsics are static-only and have no runtime lowering. Target data cannot be changed by source, inferred from the host when an
explicit target was selected, or queried dynamically at runtime. A selected cleanup-free target
value may appear in residual code only as an embedded ordinary value.

**Diagnostics:** A call that would require the sealed target-profile intrinsic to survive as
runtime work reports `SEM0176` and creates no runtime intrinsic inventory entry. Comparing target
enums from different nominal types uses the ordinary cross-enum diagnostic.

**Evidence:** static target requirements,
sealed target primitive requirements,
[intrinsic catalog](https://github.com/silk-lang/silk/blob/bbab200c9fb9c17c1611436cb031f45f4d0e8fb7/bootstrap/packages/compiler/src/Intrinsic.ts).

## Package files

### STATIC-015 — `silk.build.source` embeds files of the package

**Status:** Confirmed

The ordinary standard-library module `silk.build.source` reads a file of the calling package during
static evaluation:

| Member              | Result            | Value                                   |
| ------------------- | ----------------- | --------------------------------------- |
| `Source.read(path)` | `&'static [u8]`   | The file's bytes                        |
| `Source.text(path)` | `string<'static>` | The file's text, checked to be UTF-8    |

The path is relative to the directory that holds the package's `silk.toml`, uses `/` separators and
has no empty, `.` or `..` segment, so a package reads only its own files. Write it as a string
literal in the call: the build finds the files each module reads from those literals and publishes
them with its sources. Runtime code that calls `Source.read` receives the file as a constant, and a
`static fn` can parse the file while the package compiles.

```silk,ignore
import silk.build.source { Source }
import silk.core.static_text { StaticText }

pub fn sceneShader() -> &'static [u8] {
  return Source.read("shaders/scene.wgsl")
}

static fn composedShader() -> string<'static> {
  return StaticText.concat(Source.text("shaders/blend.wgsl"), Source.text("shaders/compose.wgsl"))
}
```

A read belongs to the package of the innermost calling frame outside the standard library, so a
library's own `static fn` reads the library's files even when another package calls it. The file
is an input of the unit that read it: editing it reruns only that unit, and an unchanged file
leaves every cached result in place. `silk check` reads the file but runs no process.

**Boundary:** The members wrap the static-only sealed primitives `Intrinsic.embed(path)` and
`Intrinsic.embedText(path)`. An embedded file's bytes are the only static `&'static [u8]` value;
they are not bounded by the retained-value budget, since they are read rather than computed.

**Diagnostics:** A path that leaves the package, a path that names no file (including one built from
anything but a literal at the call), and `Source.text` of a file that is not UTF-8 each stop static
evaluation with `SEM0176` at the call.

**Evidence:** [package file source actor](../stdlib/silk/build/source.silk).

## Ordinary functions in static code

### STATIC-016 — Static code calls pure ordinary functions

**Status:** Confirmed

A `static fn`, a `static if` condition and every other static context may call an ordinary function
whose signature is pure: it is not `effect`, `unsafe`, a test, variadic or foreign, it declares no
failures (`!`), no requirements (`?`) and no environment, and it has no `static` parameter. Its body
runs during static evaluation exactly as a `static fn` body does, and the same function stays an
ordinary runtime function for runtime callers. Methods of generic types qualify, so `Option.isSome`,
`u32.checkedToU8` and a library's own pure helpers run in static code without a static copy.

```silk
import silk.core.option {Option}
import silk.num.u32

fn clamp(value: u32, limit: u32) -> u32 {
  if value > limit { return limit }
  return value
}

static fn small(value: u32) -> bool {
  return u32.checkedToU8(clamp(value, 300)).isSome()
}
```

A receiver call that borrows its subject, as `value.isSome()`, passes a static view of the value.
The sealed scalar intrinsics such pure functions wrap evaluate with the semantics of their source
operators: arithmetic and conversions stop evaluation on overflow, and checked forms return through
their `present` and `absent` function values.

**Boundary:** A pure function body is still checked as runtime code, so reaching a runtime-only
operation inside it, such as a raw pointer read, stops static evaluation at that operation. A
scalar intrinsic without a source operator, such as a wrapping or saturating form, is not yet
evaluated.

**Diagnostics:** A static call of an impure function reports `SEM0176` at the call. Work inside a
pure body that static evaluation cannot perform reports `SEM0176` at that work, with the call in the
trace.

**Evidence:** static function requirements,
[pure call corpus program](../corpus/native/static-pure-functions/main.silk).

## Constructing types field by field

### STATIC-017 — A struct literal initializes fields from a static sequence of field descriptors

**Status:** Confirmed

Inside a struct literal, `static for field in fields { [key]: value, ... }` initializes one field
for each `[key]: value` entry of each iteration. `fields` is a static sequence, such as
`Reflect.fields<T>()`, and each `key` is a static field descriptor of the literal's type, usually
the loop binding itself. Each value is checked against the type of the field its key describes, so
one entry can initialize fields of different types. The loop unrolls during selection like a
statement-level `static for` (STATIC-010) and leaves an ordinary literal at runtime. Written
`name: value` initializers and loops combine in one literal, and together they must initialize
every field exactly once.

The literal's type may be the selected body's own type parameter, so a generic function builds
any struct whose public fields it can produce:

```silk
import silk.core.reflect {Reflect}

fn copied<T>(source: &T) -> T {
  return T {static for field in Reflect.fields<T>() { [field]: Reflect.borrowField(source, field).* }}
}
```

**Boundary:** Keys are field descriptors only; a union variant's field or another type's field
initializes nothing. A struct literal with a `static for` is runtime code, so a `static fn` body
cannot contain one.

**Diagnostics:** A key that does not describe a field of the literal's type reports `SEM0022`. A
field initialized twice, by two entries or by a written initializer and an entry, reports
`SEM0023`, and a field no entry initializes reports `SEM0024`. A value of the wrong type reports
`SEM0025` naming the field. Each names the iteration in its trace.

**Evidence:** static field initializer checker tests,
[field-by-field construction corpus program](../corpus/native/static-field-initializers/main.silk).

### STATIC-018 — A string literal can be a checked field name

**Status:** Confirmed

`Intrinsic.FieldName<Owner>` is the name of one field of `Owner`. A string literal written where
one is expected must name a field of `Owner` that the literal's module can see, and the editor links
the literal to that field. A library takes a field name where its caller names one of its own
fields, such as the field a command line option fills, and reads its text with
`Reflect.fieldNameText` or its descriptor with `Reflect.fieldNamed`.

```silk
import silk.core.reflect {Reflect}

struct Flags {
  pub verbose: bool,
}

static fn optionName<T>(name: Intrinsic.FieldName<T>) -> string<'static> {
  return Reflect.fieldNameText<T>(name)
}

static fn verbose() -> string<'static> {
  return optionName<Flags>("verbose")
}
```

A literal is checked once its owner is a closed type, so inside a generic body that still names its
own parameter, a field name passes through and is checked where the caller writes it.

For a union, a field name names a field of any of its variants. `Intrinsic.VariantName<Union>` is
the name of one variant, checked the same way and read with `Reflect.variantNameText`.

**Boundary:** A field name exists only in static code, like other reflection descriptors. Only a
literal becomes a field name; computed text does not.

**Diagnostics:** A literal that names no visible field of `Owner`, or no variant of `Union`, reports
`SEM0022` at the literal.
A field name in a runtime signature or value reports `SEM0176`.

**Evidence:** field name checker and editor table tests.

### STATIC-019 — `Union.[variant] { ... }` builds the variant a static descriptor selects

**Status:** Confirmed

`Union.[variant] { ... }` is a variant literal whose variant is chosen by `variant`, a static
`Intrinsic.Variant<Union>` descriptor, such as an element of `Reflect.variants<Union>()`. Its body
is the body of a written variant literal: named field initializers, a `static for` over
`Reflect.variantFields(variant)` whose `[field]: value` entries initialize the variant's fields
(STATIC-017), or both. `Union` may be a type parameter, so a generic body builds whichever variant
its caller selects.

```silk
import silk.core.reflect {Reflect}

union Shape {
  Dot,
  Circle {pub radius: u32},
}

fn zero<U, V>(static field: Intrinsic.Field<U, V>) -> u32 {
  return 0
}

fn build<U>(static variant: Intrinsic.Variant<U>) -> U {
  return U.[variant] { static for field in Reflect.variantFields(variant) { [field]: zero(field) } }
}

fn shapes() -> u32 {
  let mut count: u32 = 0
  static for variant in Reflect.variants<Shape>() {
    let shape = build<Shape>(variant)
    drop shape
    count = count + 1
  }
  return count
}
```

**Boundary:** The literal is runtime code; a static body cannot build a variant this way.

**Diagnostics:** A descriptor that is not a variant of `Union` reports `SEM0022` at the descriptor.
A key that is not a field of the selected variant reports `SEM0022` at the key, and a field the
literal leaves out reports `SEM0024`.

**Evidence:** variant selector checker test, corpus program `static-variant-literals`.

### STATIC-020 — Runtime code calls a static function value that names an ordinary function

**Status:** Confirmed

A static function value whose target is an ordinary function, such as one a static function
returns, can be read by runtime code. There it is the section it denotes: the target with its
captured static values as the trailing arguments, each embedded as a constant. Calling it, directly
or through a pipeline, calls the target, so a check or a parser chosen during static evaluation
costs the same as calling it by name. Its identity is the target and its captures, so editing the
target's body does not respecialize the code that reads it.

```silk
fn between(value: u32, low: u32, high: u32) -> bool {
  return value >= low && value <= high
}

static fn range(low: u32, high: u32) -> fn<'static>(u32) -> bool {
  return between(low, high)
}

fn inRange(value: u32) -> bool {
  let static check = range(1, 5)
  return check(value)
}
```

**Boundary:** The target must be an ordinary function that is not an `effect fn`, and every
captured value must be one static data can embed (STATIC-005). A function value whose target is a
`static fn` stays phase-only.

**Diagnostics:** Reading a phase-only function value in runtime code reports `SEM0176` at the
read.

**Evidence:** corpus program `static-function-values-at-runtime`.

### STATIC-021 — An erased function reference holds function values of any contract

**Status:** Confirmed

`Intrinsic.FunctionRef` holds one static function value with its contract erased, so a single
struct field or list can hold checks or parsers that take different types.
`Intrinsic.functionRef<F>(value)` erases the contract `F` of `value`, and
`Intrinsic.functionAs<F>(reference)` returns the function value again at the contract `F`. An
erased reference is static data: it exists only during static evaluation and every read sees it
again, so it is `Copy`. A restored value that names an ordinary function is called by runtime code
as that function (STATIC-020).

```silk
struct Rule {
  pub check: Intrinsic.FunctionRef,
}

fn positive(value: &u32) -> bool {
  return value.* > 0
}

static fn rule() -> Rule {
  return Rule {check: Intrinsic.functionRef<fn<'static>(&u32) -> bool>(positive)}
}

static fn checkOf(rule: Rule) -> fn<'static>(&u32) -> bool {
  return Intrinsic.functionAs<fn<'static>(&u32) -> bool>(rule.check)
}

fn valid(value: &u32) -> bool {
  let static check = checkOf(rule())
  return check(value)
}
```

**Boundary:** Both intrinsics run only in static code. Restoring compares the parameters the value
still takes and its result with `F`, by representation: the lifetimes of a reference parameter are
the call's to check.

**Diagnostics:** Restoring a reference at a contract it was not erased from stops the evaluation
with `SEM0176` at the `functionAs` call, with the static trace that reached it.

**Evidence:** corpus program `static-function-references`.
