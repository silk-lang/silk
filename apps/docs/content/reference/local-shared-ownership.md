# Allocation-backed local shared ownership

The `silk.shared` module provides explicit, allocation-backed shared lifetime for values that stay
inside one local execution domain. `Shared<T>` is not a lexical borrow and is not thread-safe shared
ownership. Each handle is an affine strong obligation, and access is confined to a take-once
callback.

These rules supply the shared-state substrate used by ordinary-source schedulers, completion
cells, and readiness queues.

## Share and update a counter

This small program creates one shared counter. It updates the value through one owner and reads the
value through a second owner.

```silk
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }

struct Counter { value: i32 }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }

effect fn useCounter() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()

  // make allocates the Counter. clone adds an owner without copying the Counter.
  let counter = run Shared.make<Counter>(Counter { value: 41 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let observer = Shared.clone<Counter>(&counter)

  // withMut allows one update. with allows one read.
  let updated = Shared.withMut<Counter, i32>(&counter, increment)
  let observed = Shared.with<Counter, i32>(&observer, read)
  drop observer
  drop counter
  if updated != observed { return -1 }
  return observed
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }

pub fn main() -> i32 {
  // Returns 42, or 0 if Shared.make cannot allocate.
  return run Effect.catchAll(useCounter(), recover)
}
```

The exact public signatures are:

```silk,ignore
effect<'env> fn make<T: 'env, 'env>(value: T) -> Shared<T>
! Allocator.OutOfMemoryError
? &mut Allocator

fn clone<T>(self: &Shared<T>) -> Shared<T>
fn with<T, A>(self: &Shared<T>, use: once fn(&T) -> A) -> A
fn withMut<T, A>(self: &Shared<T>, use: once fn(&mut T) -> A) -> A
```

### SHARED-001 — Construction is the only allocation boundary

**Status:** Confirmed

`Shared.make` transfers one value into a target-sized control block obtained through the selected
`Allocator`. Successful construction returns one strong handle. Allocation refusal returns
`Allocator.OutOfMemoryError`, produces no handle, and leaves the value under ordinary Effect cleanup.

`Shared.clone`, `Shared.with`, and `Shared.withMut` allocate nothing themselves and carry no
allocator requirement.

**Boundary:** Importing `silk.shared`, moving a handle, accessing its value, and dropping a non-last
handle do not select hidden storage. The control-block layout is private and exposes no raw address
or allocation identity.

**Diagnostics:** A target layout that cannot represent `Shared<T>` reports a compile-time target
layout diagnostic. A mismatched unsafe allocation/initializer pair reports `SEM0138` and publishes
no usable shared core.

**Evidence:** [ordinary source implementation](../../../../packages/compiler/stdlib/silk/shared.silk),
[allocation specification](../../../../openspec/changes/archive/2026-08-23-add-local-shared-control-block-allocation/specs/bootstrap-owned-allocation/spec.md).

### SHARED-002 — Every handle is affine, strong, and local

**Status:** Confirmed

Every `Shared<T>` handle is affine and `LocalExecution`, independently of whether `T` is Copy.
`Shared.clone(&cell)` creates one additional strong obligation. It does not copy or access `T`.

Dropping a non-last handle decrements the strong count and preserves the value. Dropping the last
handle cleans `T` exactly once, then releases the control-block allocation. Clone-count exhaustion
is a fatal trap before count mutation and returns no partial handle.

**Boundary:** A handle may move through same-thread callables, Effects, suspension, parking, and
independently resumable Execution frames. No operation transfers it to another OS thread or makes
an aggregate containing it Copy.

**Diagnostics:** Implicit copying or transfer without `move` uses the ordinary affine ownership
diagnostics. An invalid `impl Copy` reports `SEM0083` and identifies the local shared field.

**Evidence:** [ownership rules](ownership-and-borrowing.md),
[local shared ownership tests](../../../../packages/compiler/test/SharedStdlib.test.ts).

### SHARED-003 — Access is callback-scoped and exclusive

**Status:** Confirmed

`Shared.withMut` invokes one take-once callback with `&mut T`. `Shared.with` narrows that access to
`&T`, but delegates through the same exclusive runtime access state. The reference exists only for
that callback invocation.

The callback may return owned data that does not retain the access reference. Work that can
suspend, invoke external callbacks, or access the same state again must be moved out before the
access call returns and performed afterward.

**Boundary:** The callback reference cannot escape in a return value, callable, Effect, failure
value, aggregate, or suspended frame. Access does not expose a guard, lock, raw pointer, or manual
release operation.

**Diagnostics:** An escaping result or suspension reports `OWN0016` at the escape and relates it to
the local-shared access boundary. A direct `Intrinsic.executionNotify` inside the callback reports
`OWN0016` too. Signaling a `Wake` through `Execution.wake` is ordinary source and is not rejected
statically; if the readiness endpoint reenters the same state, the SHARED-004 runtime conflict
check traps before callback entry.

**Evidence:** [standard-library access specification](../../../../openspec/changes/archive/2026-08-23-add-local-shared-standard-library/specs/bootstrap-silk-stdlib/spec.md),
[local shared pressure tests](../../../../packages/compiler/test/LocalSharedPressure.test.ts).

### SHARED-004 — Every reentrant access combination traps before callback entry

**Status:** Confirmed

While either `with` or `withMut` is active, attempting `with` or `withMut` through any alias of the
same control block is a fatal conflict. The nested callback receives no reference and does not
start. The outer access state is restored when its callback returns normally.

This four-way rule applies to `with` under `with`, `withMut` under `with`, `with` under `withMut`,
and `withMut` under `withMut`.

**Boundary:** `with` is read-only at the source type level, but it is not a concurrently shareable
reader state. Separate control blocks may be accessed independently.

**Diagnostics:** Reentrant conflict is a fatal non-unwinding trap, not a typed failure or a
recoverable busy result. No post-trap cleanup is promised.

**Evidence:** [shared implementation](../../../../packages/compiler/stdlib/silk/shared.silk),
[native lifecycle coverage](../../../../packages/compiler/test/SharedStdlib.test.ts).

### SHARED-005 — Strong cycles remain allocated

**Status:** Confirmed

The first shared-ownership model contains only strong handles. If shared values retain handles that
form a cycle, dropping every external handle does not make any strong count reach zero. Payload
cleanup and allocation release therefore do not occur.

**Boundary:** The module exposes no Weak handle, tracing collector, cycle detector, atomic count,
thread-safe variant, lock, or identity comparison. Ordinary source must avoid cycles or break them
explicitly before the last external path is lost.

**Diagnostics:** Constructing or leaking a strong cycle is not a compile-time error. Clone overflow
and reentrant access remain the fatal cases described above.

**Evidence:** [lifecycle specification](../../../../openspec/changes/archive/2026-08-23-add-local-shared-lifecycle-operations/specs/bootstrap-ownership/spec.md),
[local shared engine tests](../../../../packages/compiler/test/SharedStdlib.test.ts).
