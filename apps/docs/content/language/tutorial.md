# Getting started with Silk

This tutorial takes you from an empty directory to a Silk program that runs. It assumes no
knowledge of the language. Every program on this page compiles with the current compiler.

Silk is a small, explicitly typed language. Two things make it unusual, and both appear before the
end of this page:

- **Ownership is affine and explicit.** A value of a move-only type — a struct, an owned
  collection, an exclusive borrow — is used at most once, and handing it away is written with the
  `move` keyword. Scalars, `bool`, strings, and shared borrows are copyable and are reused freely.
- **Effects are values.** A computation that can fail, or that needs a capability from its caller,
  has that fact in its type. Running it is written with the `run` keyword.

## Create a project

`silk init` writes a manifest, a source directory, and an entry point:

```console
$ silk init hello
$ cd hello
```

You get this layout:

```
hello/
  silk.toml      # [package] name, version, silk-version, root
  .gitignore     # ignores the build/ directory
  src/main.silk  # the entry point named by root
```

The generated `silk.toml` names the entry file and records, as `silk-version`, the release of the
compiler that created the project:

```toml
[package]
name = "hello"
version = "0.1.0"
silk-version = "0.1.0"
root = "src/main.silk"
```

`silk-version` is optional. When present it must be a semantic version; no command compares it with
the running compiler.

And the generated `src/main.silk` logs a greeting:

```silk
import silk.effect { Effect }
import silk.logger { LogError }
import silk.os_logger { StdoutLogger }

pub effect fn main() -> ()
  ! LogError {
  let mut logger = StdoutLogger.make()

  run Effect.log("Hello, world!", &()) |> Effect.provideMut(&mut logger)
}
```

Run it:

```console
$ silk run
```

`silk run` reports the build, then the program prints `Hello, world!`.

## Your first program

Replace `src/main.silk` with a program that computes a value. An entry point declared
`pub fn main() -> i32` returns its result as the process exit status:

```silk
pub fn main() -> i32 {
  let total = 2 + 3
  return total
}
```

Three rules are already visible:

- `pub` makes a declaration visible outside its module. Without it a declaration is private to the
  file.
- `let` binds a name. The type is inferred; an unconstrained integer literal is `i32`.
- **A non-unit path must return.** Silk has no trailing-expression return. Every reachable path of
  a function returning a value must end in `return` or another terminal operation; fallthrough is
  a `SEM0130` error.

Check the program without running it:

```console
$ silk check
```

## Functions, mutation, and loops

Bindings are immutable unless you write `let mut`. The only loop is `while`:

```silk
fn double(value: i32) -> i32 {
  return value * 2
}

pub fn main() -> i32 {
  let mut total = 0
  let mut index = 0
  while index < 5 {
    total = total + double(index)
    index = index + 1
  }
  return total
}
```

Notes on what is _not_ here:

- There is no `for` loop, no iterator, and no range. `while` is the whole vocabulary, plus `break`
  and `continue`.
- `if` is a statement, not an expression. There is no `let x = if ...`. Declare the binding `mut`
  and assign it in each branch, or `return` from the branches. (`match` _is_ an expression, but its
  scrutinee must be a struct, nominal union, structural union, or scalar enum — it does not replace a scalar
  comparison.)
- Conditions take no parentheses and the braces are mandatory.

Arithmetic is homogeneous: both operands must already be the _same_ integer type. Silk performs no
implicit widening at all, so `i32 + i64` is an error rather than a conversion. Note also that
there is no negative integer literal — a leading `-` is a separate prefix operator, and subtracting
from `0` is the common way to write a negative constant.

## Structs and ownership

A `struct` groups named fields. Fields are listed one per line with no commas, and each field
carries its own visibility:

```silk
pub struct Point {
  pub x: i32
  pub y: i32
}

fn manhattan(point: Point) -> i32 {
  let mut total = 0
  if point.x < 0 { total = total - point.x } else { total = total + point.x }
  if point.y < 0 { total = total - point.y } else { total = total + point.y }
  return total
}

pub fn main() -> i32 {
  let origin = Point { x: 3, y: 0 - 4 }
  return manhattan(move origin)
}
```

The `move` in `manhattan(move origin)` is the ownership rule in action. `Point` is a struct, and
structs are **move-only**: passing one by value hands the whole value to `manhattan`, and Silk
requires you to say so. Dropping the `move` is an `OWN0003` error, and using `origin` again _after_
the move is an `OWN0001` error.

This is why the loop counters in the previous section needed no `move`. `i32`, `bool`, strings,
shared borrows, and fixed arrays of copyable elements are **copyable**: passing one to a function
copies it, the binding stays usable, and `OWN0003` never fires. Only move-only types require the
keyword.

One rule spans both categories: writing `move` explicitly always consumes the binding, even for a
copyable type. `let x = 1` followed by `f(move x)` makes any later use of `x` an `OWN0001` error,
so reach for `move` when you mean it rather than as decoration.

The distinction is the single most common surprise for a new Silk programmer, and it is deliberate:
the point at which a value stops being yours is always written down.

## Borrowing instead of giving away

When a function only needs to read or update a value in place, borrow it rather than move it.
Borrows are written `&` (shared) and `&mut` (exclusive). A direct borrow expression is formed at a
call argument:

```silk
import silk.usize

fn total(values: &[i32], length: usize) -> i32 {
  let mut sum = 0
  let mut index = usize.add(0, 0)
  while index < length {
    sum = sum + values[index]
    index = index + 1
  }
  return sum
}

fn scale(values: &mut [i32], length: usize, factor: i32) {
  let mut index = usize.add(0, 0)
  while index < length {
    values[index] = values[index] * factor
    index = index + 1
  }
  return
}

pub fn main() -> i32 {
  let mut values = [1, 2, 3, 4]
  let scaled = scale(&mut values, usize.add(4, 0), 2)
  return total(&values, usize.add(4, 0))
}
```

`[1, 2, 3, 4]` is a fixed array whose length is part of its type (`[i32; 4]`). `&values` forms a
slice over it. There is no implicit array-to-slice conversion: the `&` is required. An out-of-range
index traps rather than reading past the end.

Slice lengths and indices are `usize`, and this is where the no-implicit-conversion rule shows its
teeth. A bare `0` in an unconstrained position infers `i32`, which is not a `usize` and will not be
converted for you, so `let mut index = 0` used as an index is a `SEM0033` error. Writing
`usize.add(0, 0)` seeds the binding at the type you want; it is the idiom used throughout
`examples/algorithms/`.

`let view = &values` is rejected: a bare borrow does not become an independent local. An ordinary
function may, however, return a view derived from its single borrowed parameter, and the caller may
bind that returned view while its source remains live. This deliberately narrow rule supports
operations such as collection access without named lifetime annotations; a returned view cannot be
placed inside owned data or an Effect result.

## Enums, unions, and match

Silk has three sum forms with different jobs. A scalar `enum` is a nominal set of named, fieldless
members. Qualify each member with its enum name, including in a `match`:

```silk
enum Status {
  Pending,
  Ready,
  Done,
}

fn statusCode(status: Status) -> i32 {
  return match status {
    Status.Pending => 0
    Status.Ready => 1
    Status.Done => 2
  }
}

pub fn main() -> i32 {
  return statusCode(Status.Ready)
}
```

Scalar enums are copyable and use `u8` as their backing representation by default. You can select
another fixed-width integer with a declaration such as `enum(i16) Status`, assign explicit integer
discriminants to members, and read a member's backing value with `Status.value(status)`. Enums do
not carry payloads or convert implicitly to or from integers.

When variants belong to one named type and may carry data, declare a nominal `union`. Generic
arguments belong to the parent union, and constructors and patterns name that parent:

```silk
union LoadState<T> {
  Idle,
  Loaded { value: T }
}

fn loadedValue(state: LoadState<i32>) -> i32 {
  return match move state {
    LoadState<i32>.Idle => 0
    LoadState<i32>.Loaded { value } => value
  }
}

pub fn main() -> i32 {
  let state = LoadState<i32>.Loaded { value: 42 }
  return loadedValue(move state)
}
```

When already-independent types need to compose without a declaring parent, use a _structural union_
written `A | B`. A structural union value has one active member, and `match` takes it apart. `match`
is an expression, so it can produce a value:

```silk
pub struct Empty {}

pub struct Full {
  pub amount: i32
}

fn describe(state: Full | Empty) -> i32 {
  return match move state {
    Full { amount } => amount
    Empty nothing => 0
  }
}

pub fn main() -> i32 {
  let full = Full { amount: 7 }
  return describe(move full)
}
```

Points worth noting:

- Arms are separated by line breaks. No commas.
- `Full { amount }` destructures the field into a binding of the same name. A pattern must account
  for every field; write `..` to acknowledge the ones you skip.
- `Empty nothing` binds the whole member rather than its fields.
- `match move state` states the access mode. The alternatives are `match value` (only for copyable
  values), `match &value`, and `match &mut value`.
- Matches are checked for exhaustiveness. Leaving out `Empty`, `Status.Done`, or
  `LoadState<i32>.Idle` is a compile error naming the member you missed, so changing any sum tells
  you every match that must change.

## Effects: failure in the type

An `effect fn` returns a computation rather than a result. Its type has three channels:
the success type, a failure row after `!`, and a requirement row after `?`. Here is a function
that can fail:

```silk
pub struct Overflowed {}

effect fn checked(value: i32) -> i32 ! Overflowed {
  if value > 100 {
    fail Overflowed {}
  }
  return value * 2
}

pub effect fn main() -> () ! Overflowed {
  let doubled = run checked(21)
  return ()
}
```

What each piece does:

- `-> i32 ! Overflowed` says: succeeds with `i32`, or fails with `Overflowed`. The failure is part
  of the signature, so a caller cannot forget it.
- `fail Overflowed {}` stops the computation with that value. It is not an exception — nothing
  unwinds invisibly, and the type system already knew it could happen.
- Calling `checked(21)` only _builds_ the computation. `run` executes it. Forgetting `run` is a
  type error, not a silently ignored value.
- `run` propagates the failure into the enclosing effect's row, which is why `main` also declares
  `! Overflowed`.
- Any concrete owned failure value may reach an effectful entry point without marker conformance.
  An unhandled failure terminates with status 1 and retains its canonical type identity.

An effectful entry point returns `()` and reports success as exit status 0. An unhandled failure
becomes a non-zero status.

Failures are handled with ordinary library functions rather than special syntax — `Effect.catch`,
`Effect.catchAll`, and `Effect.retry` are written in Silk in `effect.silk`, not built into the
compiler. The requirement row (`?`) works the same way for capabilities such as an allocator or a
logger: a caller supplies them with `provide`, and the row shrinks as they are supplied.

## Requirements: dependencies in the type

A `service` describes behavior supplied at runtime. Code that uses the service carries that need
in its Effect requirement row, so there is no ambient singleton and no hidden dependency lookup.

This program defines a clock contract, implements it with a fixed value, and provides that value
only around the computation that needs it:

```silk
import silk.effect { Effect }

service Clock {
  effect fn value() -> i32 ? &Clock
}

struct FixedClock {
  value: i32
}

impl Clock for FixedClock {
  effect fn value(self: &Self) -> i32 {
    return self.value
  }
}

effect fn readClock() -> i32 ? &Clock {
  return run Clock.value()
}

pub fn main() -> i32 {
  let clock = FixedClock { value: 42 }
  return run Effect.provide(readClock(), &clock)
}
```

Read `? &Clock` as “this computation needs shared access to a `Clock` provider.” The
`impl Clock for FixedClock` block proves at compile time that `FixedClock` can provide that
contract. `Effect.provide` lends `clock` for one lexical computation and removes the requirement;
outside that expression, nothing has been installed globally.

Services and interfaces are intentionally different:

- a `service` creates an Effect requirement and supports runtime provider replacement;
- an `interface` is a compile-time conformance bound used by generic specialization;
- `&Service`, `&mut Service`, and owned service requirements preserve shared, exclusive, and owned
  access respectively.

The standard library uses the same mechanism for allocation, logging, filesystem access, process
input, streams, randomness, child processes, and scheduling. Tests can provide in-memory actors
without mocking compiler globals.

## Where to go next

- [Ownership, borrowing, and cleanup](./ownership.md) develops the `move`, borrow, and destruction
  model used in this tutorial.
- [Effects, failures, and services](./effects.md) develops the three-channel Effect model and its
  composition operations.
- [Fibers and local scheduling](./fibers.md) introduces the source-defined structured-concurrency
  layer.
- [Alpha status and supported targets](./alpha-status.md) states the current implementation and
  compatibility boundaries.
- The [language reference](../reference/) states the rules in full: lexical form, types, memory
  and ownership, and the effect system.
- The [standard library reference](./stdlib/) lists every module and public declaration.
- The [diagnostic index](./diagnostics.md) explains every error code, including the `OWN0001` and
  `SEM0130` mentioned above.
- `examples/algorithms/` in the repository holds larger programs — quicksort, FFT, CRC-32,
  game of life — that compile and run today.
