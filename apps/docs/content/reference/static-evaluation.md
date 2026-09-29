# Static evaluation

Silk has one explicit compile-time execution phase. Static evaluation computes finite values,
selects source with `static if`, and specializes ordinary functions before the residual runtime
program is checked for ownership, reachability, target availability, and lowering.

Ordinary function and control-flow rules are defined by
[functions, callables, and control flow](functions-callables-and-control-flow.md). Runtime ownership
is defined by [ownership and borrowing](ownership-and-borrowing.md). Constants and the foundational
types admitted as constant results are defined by [values and types](values-and-types.md).

## Terminology

- A **static function** is a top-level `static fn` whose complete body executes during compilation.
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
may be a top-level module declaration or a method in an inherent `impl Type` block. Every call to
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

**Boundary:** `static` cannot combine with `unsafe` or `effect`, and is forbidden on interface
operations and operations in conformance `impl Contract for Type` blocks. Nested static function
declarations within executable bodies are unavailable. Module declaration groups may select static
functions. A static function cannot be captured or passed as a runtime callable.

**Diagnostics:** An unsupported modifier combination or declaration position reports a syntax
diagnostic at the conflicting modifier or declaration. A use requiring a runtime callable reports
a static-phase violation at that use. A static call that selects an interface or conformance
operation reports `SEM0176` at the call.

**Evidence:** [static syntax requirements](../../../../openspec/changes/add-static-evaluation-core/specs/bootstrap-syntax/spec.md),
[static function requirements](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md).

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
requires `let static`. Inside a `static fn`, ordinary locals and control flow are already static and
do not require `let static`.

**Diagnostics:** Passing a runtime value to a static parameter, reading a runtime local from static
evaluation, or using a runtime operation in a static initializer reports `SEM0176` at the operation
and identifies the static boundary that required the value.

**Evidence:** [explicit static modes](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md),
[static syntax recovery](../../../../openspec/changes/add-static-evaluation-core/specs/bootstrap-syntax/spec.md).

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

**Evidence:** [static selection requirements](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md),
[statement-only syntax](../../../../openspec/changes/add-static-evaluation-core/design.md#1-syntax-marks-phase-boundaries-without-marking-literals).

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

**Evidence:** [compile-error requirements](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md),
[dedicated syntax](../../../../openspec/changes/add-static-evaluation-core/specs/bootstrap-syntax/spec.md).

## Static values and mutation

### STATIC-005 — Static values are reusable data, not observable compile-time storage

**Status:** Confirmed

A static value is finite, deterministic, identity-free, and freely reusable during static
evaluation. Admitted values include unit, foundational scalars, scalar enums, static UTF-8 text,
and recursively pure aggregates whose members are admitted. Admission excludes values carrying a
runtime resource, borrow, opaque identity, callable execution, Effect, service, unsafe pointer, or
observable cleanup behavior.

Reusing a static value does not grant its declared runtime type the `Copy` property and does not
change runtime interface selection. When an admitted value is runtime-representable and
cleanup-free, residualization may embed it directly without retaining compiler storage.

**Boundary:** Static evaluation has no addresses, references, loans, mutable aliases, destructors,
allocator identities, or observable allocation. It cannot construct or run an Effect, invoke an
ordinary runtime function, read a runtime binding, or perform unsafe, external, or host work.

**Diagnostics:** Attempting a prohibited operation reports `SEM0176` at that operation and produces
no static result. A value outside the admitted domain is rejected at the static boundary rather
than acquiring a second compile-time ownership model.

**Evidence:** [static value requirements](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md),
[canonical static values](../../../../packages/compiler/src/StaticValue.ts).

### STATIC-006 — Static mutation replaces one complete local value

**Status:** Confirmed

Inside a `static fn`, ordinary `let mut` creates one mutable evaluator-local slot. Assignment
replaces the complete stored static value. Ordinary `if`, `while`, `break`, `continue`, and `return`
operate in the static function's compile-time phase.

```silk
static fn countTo(limit: u32) -> u32 {
  let mut current = 0
  while current < limit {
    current = current + 1
  }
  return current
}
```

**Boundary:** Static mutation cannot take a reference to the slot, project a writable place through
an alias, mutate one aggregate field in place, partially move a value, observe cleanup, or retain
the slot in a residual value. A mixed function cannot declare `let static mut`; it computes a new
static value through a static function instead.

**Diagnostics:** A static borrow, unsupported place mutation, or runtime-dependent replacement
reports `SEM0176` at the invalid operation. The failed evaluation exposes no partial value.

**Evidence:** [static mutation limits](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md).

### STATIC-007 — `silk.static_text` inspects UTF-8 bytes without exposing storage

**Status:** Confirmed

The ordinary standard-library module `silk.static_text` provides static byte operations for text
available during compilation:

| Member                     | Result   | Meaning                                                                    |
| -------------------------- | -------- | -------------------------------------------------------------------------- |
| `byteLength(value)`        | `usize`  | Number of bytes in the UTF-8 encoding                                      |
| `byteAt(value, index)`     | `u8`     | Byte at one in-bounds byte index                                           |
| `concat(left, right)`      | `string` | Concatenated static text, retaining `left` as its diagnostic source anchor |
| `slice(value, start, end)` | `string` | Text in one byte range whose endpoints are UTF-8 scalar boundaries         |

```silk,ignore
import silk.static_text { byteLength, byteAt, concat, slice }

static fn hasAccent(value: string) -> bool {
  return byteLength(value) == 3 && byteAt(value, 1) == 195 &&
    concat(slice(value, 1, 3), "!") == "é!"
}
```

These are ordinary `static fn` wrappers. They return admitted values and reveal neither an address
nor mutable compiler storage. Their sealed intrinsic primitives are static-only and cannot survive
in runtime TIR.

**Boundary:** `byteAt` rejects an out-of-bounds index. `slice` rejects an invalid range and any
endpoint that splits a UTF-8 scalar encoding. Both failures are phase violations with source text
provenance rather than runtime traps. `concat` is bounded by the ordinary retained-value budget.

**Evidence:** [static text source actor](../../../../packages/compiler/stdlib/silk/static_text.silk),
[static value requirements](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md).

## Reflection, static sequences, iteration, and formatting

### STATIC-008 — Reflection exposes finite aggregate metadata only during specialization

**Status:** Confirmed

`silk.reflect` exposes canonical descriptors for one concrete aggregate type and its fields. Named
tuples and anonymous positional aggregates expose positions; named structs and anonymous records
expose visible labels. Declaration order, nominal owner identity, generic substitution, aggregate
kind, and the reflecting declaration's visibility authority are retained.

| Member                             | Result                    | Meaning                                                |
| ---------------------------------- | ------------------------- | ------------------------------------------------------ |
| `typeOf<Owner>()`                  | `Intrinsic.Type<Owner>`   | Descriptor for one concrete aggregate owner            |
| `fields<Owner>()`                  | `Intrinsic.Fields<Owner>` | Ordered heterogeneous field collection                 |
| `typeKind(descriptor)`             | `u8`                      | Stable named/positional aggregate-kind code            |
| `fieldKind(field)`                 | `u8`                      | Stable labeled/positional member-kind code             |
| `fieldLabel(field)`                | `string`                  | Label of a labeled field                               |
| `fieldOrdinal(field)`              | `usize`                   | Position of a positional field                         |
| `borrowField(owner, static field)` | `&Value`                  | Shared runtime projection authorized by the descriptor |

Descriptors remain nominal: equal field shapes from separate structs do not become assignment-
compatible or share projection authority. Private fields are absent outside their declaring module
and their spellings cannot leak through reflection diagnostics.

**Boundary:** `Intrinsic.Type`, `Intrinsic.Fields`, and `Intrinsic.Field` are phase-only nominals
with no runtime layout, address, ownership, or backend representation. `borrowField` accepts only a
shared reference to the descriptor's exact owner and consumes its descriptor during specialization.
It cannot project an owned value, use a descriptor at runtime, or extend the result beyond the
owner's ordinary borrow lifetime.

**Evidence:** [static reflection requirements](../../../../openspec/changes/add-static-reflection-and-template-formatting/specs/static-reflection/spec.md),
[reflection source actor](../../../../packages/compiler/stdlib/silk/reflect.silk).

### STATIC-009 — Static sequences are immutable compile-time values

**Status:** Confirmed

`silk.static_sequence` provides `empty`, `append`, `concat`, `length`, and `at` over
`Intrinsic.StaticSequence<Element>`. Every operation returns a complete canonical value; append and
concatenation do not mutate the input sequence.

```silk,ignore
import silk.static_sequence { StaticSequence }

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

**Evidence:** [static sequence requirements](../../../../openspec/changes/add-static-reflection-and-template-formatting/specs/static-reflection/spec.md),
[static sequence source actor](../../../../packages/compiler/stdlib/silk/static_sequence.silk).

### STATIC-010 — `static for` generates ordinary runtime work from finite static elements

**Status:** Confirmed

`static for <binding> in <expression> { ... }` is a statement. Its iterable must evaluate to a
finite static sequence or reflected field collection. The compiler re-elaborates one fresh body
scope per element in deterministic order. A heterogeneous field collection gives each scope the
field descriptor's concrete `Field<Owner, Value>` type, so one authored body can select different
interfaces and generate differently typed runtime operations.

```silk,ignore
import silk.reflect { Reflect }

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

**Evidence:** [static iteration requirements](../../../../openspec/changes/add-static-reflection-and-template-formatting/specs/static-reflection/spec.md),
[static iteration syntax](../../../../openspec/changes/add-static-reflection-and-template-formatting/specs/bootstrap-syntax/spec.md).

### STATIC-011 — Template formatting validates statically and writes borrowed fields at runtime

**Status:** Confirmed

`silk.format.Format.format<Args>(static template: string, args: &Args)` accepts one static template
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

**Evidence:** [template formatting requirements](../../../../openspec/changes/add-static-reflection-and-template-formatting/specs/template-formatting/spec.md),
[Format source actor](../../../../packages/compiler/stdlib/silk/format.silk).

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

**Evidence:** [residual-program requirements](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md),
[residual instance requirements](../../../../openspec/changes/add-static-evaluation-core/specs/bootstrap-instances/spec.md),
[residual ownership requirements](../../../../openspec/changes/add-static-evaluation-core/specs/bootstrap-ownership/spec.md).

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

**Evidence:** [static diagnostic requirements](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md),
[diagnostic catalog](../../../../packages/compiler/src/Diagnostic.ts).

## Target information

### STATIC-014 — `silk.target` exposes target information only as static source values

**Status:** Confirmed

The ordinary standard-library module `silk.target` exposes individual machine facts:

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

Use `silk.compilation` for typed logical build choices. Source checks use the narrow domain needed
for the decision. The complete [compilation profile](compilation-profiles.md) also contains resolved
package parameters and controls static-evaluation identity.

```silk,ignore
import silk.target { Target, Arch }

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

**Boundary:** `silk.target` is ordinary source and receives no compiler-known name privilege. The
sealed individual target and profile-fact intrinsics are static-only and have no runtime lowering. Target data cannot be changed by source, inferred from the host when an
explicit target was selected, or queried dynamically at runtime. A selected cleanup-free target
value may appear in residual code only as an embedded ordinary value.

**Diagnostics:** A call that would require the sealed target-profile intrinsic to survive as
runtime work reports `SEM0176` and creates no runtime intrinsic inventory entry. Comparing target
enums from different nominal types uses the ordinary cross-enum diagnostic.

**Evidence:** [static target requirements](../../../../openspec/changes/add-static-evaluation-core/specs/static-evaluation/spec.md),
[sealed target primitive requirements](../../../../openspec/changes/add-static-evaluation-core/specs/bootstrap-intrinsic-boundary/spec.md),
[intrinsic catalog](../../../../packages/compiler/src/Intrinsic.ts).
