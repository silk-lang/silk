# Recursion and the machine stack

Silk gives ordinary recursion **no bounded-stack guarantee**. A call costs a machine call frame, so
a recursive function is limited by the stack of whatever is running it. Recursive Effects have one
explicit alternative: a cycle that crosses `Effect.suspend` can use bounded native and WebAssembly
machine stack. Ordinary functions, uncovered Effect cycles, and recursive cleanup cannot.

This page states that boundary, shows what hitting it looks like on each engine, and gives the
pattern to use instead when a structure can be arbitrarily deep.

## 1. The guarantee, stated plainly

- An ordinary call is an ordinary call. It consumes a frame on the machine or host stack and
  releases it on return.
- **Recursion depth is bounded by the target's stack**, which is a property of the host, the profile,
  and the frame the optimizer chose — not of Silk. The bound is not a number the language promises.
- The compiler **does not** add a shadow stack, a per-call heap allocation, or a trampoline to make
  deep recursion survivable.
- A data traversal or cleanup path that must handle unbounded depth is **written iteratively**.
- A recursive Effect cycle may instead cross an explicit `Effect.suspend` boundary. That changes
  its execution representation, not the rules for ordinary calls.

### Why the compiler stays out of it

The rule is pay-for-use. Making arbitrary recursion stack-safe means spilling frames somewhere other
than the stack, and there is no version of that which only the deep call sites pay for:

- **Every call would pay.** The overwhelming majority of calls in a program are shallow. A shadow
  stack taxes all of them to protect the few that are not, and it does so in the hottest thing a
  compiler emits.
- **Every call would need an allocator.** Spilled frames live somewhere, and in Silk there is no
  ambient heap — allocation is an `Allocator` capability that a function has to require, and it can
  fail with `OutOfMemoryError`. Hidden per-call spilling would give an allocator requirement and a
  failure row to functions that declare neither.
- **Some calls cannot have one.** A `Drop` hook may declare no failure row and no capability
  requirement at all, so there is no legal place to put a hidden allocation inside cleanup. A
  guarantee the language cannot extend to cleanup is not a guarantee the language can state.

So the machine stack stays the machine stack, and depth stays the program's problem to structure.

## 2. The same limit has two target-specific faces

A deep recursion does not fail the same way twice, and a reader who has only seen one of these will
not recognise the others. They are one boundary:

| Target          | What you see                                                                                        | Recoverable?              |
| --------------- | --------------------------------------------------------------------------------------------------- | ------------------------- |
| **Native**      | The process dies on a signal: `SIGSEGV`, with no status, diagnostic, unwinding, or partial output   | No                        |
| **WebAssembly** | The host throws out of the exported call — under V8, `RangeError: Maximum call stack size exceeded` | No, but the host survives |

On WebAssembly the specific trap is **platform-sensitive**: a band of depths just below the host
limit may trap `unreachable` (`WebAssembly.RuntimeError`) rather than raise the host's `RangeError`.
Either way the meaning is the same — the engine could not carry the chain.

## 3. Measured depths, for calibration only

These are observations on one machine, at one moment, at one optimization level. They move with the
host's stack size, the profile, and the frame layout the optimizer picks, and **nothing in the
compiler promises them**. They are here so the numbers feel concrete, not so you can rely on one.

Recorded on x86_64 Linux, Node 22.22, clang 18, release profile, walking a chain of boxed nodes one
level per recursive call:

| Engine                | Deepest chain that survived | Shallowest that failed |
| --------------------- | --------------------------- | ---------------------- |
| WebAssembly (Node/V8) | 950                         | 1,000                  |
| Native (release)      | 100,000                     | 128,000                |

The two differ by more than two orders of magnitude, which is the practical point: a depth that is
comfortable natively can still be fatal in a browser.

## 4. The iterative pattern

The chain below is built, walked, and destroyed without a single recursive call. Two things carry
the weight:

- **`while`** is the loop, and
- **`Intrinsic.replace`** is what lets ownership walk down the chain. A local cannot be partially
  moved out of, and a `match` arm is an expression rather than a statement, so a loop that takes the
  next link out of the value it holds has to swap a sentinel into the place it took from.

```silk
import silk.box { Box }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.usize

pub struct End {}

pub struct Link {
  next: Box<Chain>
}

pub struct Step {
  kind: End | Link
}

pub struct Chain {
  step: Step
}

// One unlink step, carrying back both the next level and whether there was one. A match arm cannot
// assign, so the loop below needs the answer as a value rather than as a side effect.
pub struct Unlinked {
  chain: Chain
  more: bool
}

fn unlink(chain: Chain) -> Unlinked {
  return match move chain {
    Chain { step } => unlinkStep(move step)
  }
}

fn unlinkStep(step: Step) -> Unlinked {
  return match move step {
    Step { kind } => unlinkKind(move kind)
  }
}

fn unlinkKind(kind: End | Link) -> Unlinked {
  return match move kind {
    End nothing => Unlinked { chain: Chain { step: Step { kind: End {} } }, more: false }
    Link { next } => Unlinked { chain: Box<Chain>.into(move next), more: true }
  }
}

// Builds outward instead of downward: each turn wraps the chain built so far in one more link.
effect fn build(depth: i32) -> Chain ! OutOfMemoryError ? &mut Allocator {
  let mut current = Chain { step: Step { kind: End {} } }
  let mut remaining = depth
  while remaining > 0 {
    let taken = Intrinsic.replace(current, Chain { step: Step { kind: End {} } })
    let boxed = run Box<Chain>.make(move taken)
    current = Chain { step: Step { kind: Link { next: move boxed } } }
    remaining = remaining - 1
  }
  return move current
}

// Counts the links by walking one level per loop turn. However long the chain is, this function's
// own stack is one frame deep.
fn length(chain: Chain) -> i32 {
  let mut current = move chain
  let mut counted = 0
  let mut going = true
  while going {
    let taken = Intrinsic.replace(current, Chain { step: Step { kind: End {} } })
    let mut stepped = unlink(move taken)
    current = Intrinsic.replace(stepped.chain, Chain { step: Step { kind: End {} } })
    going = stepped.more
    if stepped.more { counted = counted + 1 }
  }
  return counted
}

effect fn measure() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let built = run build(4096) |> Effect.provideMut(&mut allocator)
  let counted = length(move built)
  if counted == 4096 { return 0 }
  return 2
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }

pub fn main() -> i32 { return run Effect.catchAll(measure(), recover) }
```

The recursive spelling of `length` is shorter and reads better, and for a chain of known-small depth
it is the right code. The version above is what you reach for when the depth comes from input.

For comparison, this is the recursive walk that the boundary applies to — correct, idiomatic, and
bounded by the stack:

```silk
import silk.box { Box }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.usize

pub struct End {}

pub struct Link {
  next: Box<Chain>
}

pub struct Step {
  kind: End | Link
}

pub struct Chain {
  step: Step
}

// One frame per level, plus one for the view. Fine at 64 levels; fatal at a million.
fn stepDepth(step: &Step) -> i32 {
  return match &step.kind {
    End nothing => 0
    Link { next } => viewDepth(Box<Chain>.get(&next))
  }
}

fn viewDepth(view: &[Chain]) -> i32 {
  return match &view[usize.ZERO] {
    Chain { step } => 1 + stepDepth(&step)
  }
}

effect fn build(depth: i32) -> Chain ! OutOfMemoryError ? &mut Allocator {
  let mut current = Chain { step: Step { kind: End {} } }
  let mut remaining = depth
  while remaining > 0 {
    let taken = Intrinsic.replace(current, Chain { step: Step { kind: End {} } })
    let boxed = run Box<Chain>.make(move taken)
    current = Chain { step: Step { kind: Link { next: move boxed } } }
    remaining = remaining - 1
  }
  return move current
}

effect fn measure() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let built = run build(64) |> Effect.provideMut(&mut allocator)
  let counted = stepDepth(&built.step)
  drop built
  if counted == 64 { return 0 }
  return 2
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }

pub fn main() -> i32 { return run Effect.catchAll(measure(), recover) }
```

## 5. What about effects?

Wrapping recursion in `effect fn` is not enough. A recursive Effect call that is simply `run` still
uses the ordinary machine stack. Stack safety is requested at the exact call site with
`Effect.suspend`:

```silk
import silk.effect { Effect }

effect fn count(value: i32) -> i32 {
  if value == 0 {
    return 0
  }
  let inner = run Effect.suspend(count(value - 1))
  return inner + 1
}

pub fn main() -> i32 {
  return run count(42)
}
```

The rule is graph-shaped: every possible recursive cycle must cross a suspension boundary. In a
mutually recursive pair, one covered edge can be sufficient; a suspension on an unrelated branch
does not cover a cycle that can avoid it.

Suspension preserves the child's success, typed failure, and requirement channels. It is not
asynchronous execution: it does not park, yield to another task, or install a scheduler. The
compiler-owned execution stack is still finite, and exhausting it is a fatal trap rather than an
`OutOfMemoryError`.

## 6. Cleanup has the same limit and fewer ways out

Everything above is about recursion you wrote. Automatic cleanup is the same boundary reached from
the other side, and it is the harder half.

A `Box` releases the value it holds, so releasing the outermost link of a chain calls the hook of
the link below it, which calls the hook below that. Destroying a chain of a million boxed nodes is a
million-deep recursion **that nobody wrote and no call site can see**. It runs wherever the value
happens to go out of scope, including on paths you did not think about.

The escapes offered above do not carry over:

- **It is not a traversal you control.** There is no call site to rewrite as a loop; the recursion
  is the cleanup plan descending through hooks.
- **It cannot cross a suspension boundary.** A `Drop` hook may declare neither a failure row nor a
  capability requirement. Cleanup cannot allocate, cannot fail, and cannot suspend, so the "express
  it as an Effect" answer is closed to it — and closed permanently, not just until the coroutine
  work lands.

### What to do

**Give any type that can form a deep chain an explicit, consuming, iterative teardown, and call it
before the value goes out of scope.** The `length` loop in §4 is exactly that shape: it consumes the
chain one link per loop turn, so by the time automatic cleanup runs, the value it sees is one level
deep. A teardown that returns nothing is the same loop without the counter.

This works today. It is also, honestly, incomplete, and it is worth knowing where it stops:

- **Nothing enforces it.** Forgetting to drain compiles, passes review, and works — until the chain
  gets deep in production. There is no diagnostic for "this type recurses through cleanup".
- **It cannot be written once.** Only the holder knows which field is the next link, so every
  recursive type hand-rolls its own teardown. `silk.box` cannot provide a generic one.
- **The failure path is not covered at all.** If construction runs out of allocations halfway down,
  the half-built chain is released by the ordinary failure path, and there is no point in the source
  at which a teardown could be called on it — the value never becomes yours. A program that drains
  religiously still meets recursive cleanup on its `OutOfMemoryError` path, at whatever depth
  construction had reached. That is a real gap, and today it has no answer beyond bounding the
  depth you build.

### Measured depths for cleanup

Same machine and profile as §3, dropping a chain built iteratively:

| Engine                | Deepest chain released | Shallowest that failed |
| --------------------- | ---------------------- | ---------------------- |
| WebAssembly (Node/V8) | 5,000                  | 6,000                  |
| Native (release)      | 200,000                | 1,000,000              |

Cleanup frames are narrower than the walk's, so the numbers are larger than §3's — and that is the
trap. The two limits differ by roughly a factor of five, so neither calibrates the other: a chain
comfortably droppable is not necessarily walkable, and a depth that survived a walk on one engine
says nothing about a teardown on another. Both are the same rule — a call costs a frame.

## See also

- [Language reference](../reference/) — `while`, `match`, and the ownership rules the loops above
  are working within.
- [Effects, failures, and services](./effects.md) — Effect construction, execution, provision, and
  explicit suspension.
- [Fibers and local scheduling](./fibers.md) — parking and cooperative scheduling, which are
  separate from `Effect.suspend`.
- [Standard library](./stdlib/) — `silk.box` and the rest of the modules.
