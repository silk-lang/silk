# Thread properties

Two sealed properties say which values may cross a thread boundary. Thread-spawning and
execution APIs bound their inputs on them, so a program that would share non-atomic state between
threads is rejected where the value is handed off. The compiler derives both properties from a
type's stored parts. A type that synchronizes its own storage, such as a lock built on
`silk.concurrency.atomic`, asserts them with an `impl`.

## Terms

- A value is **transferred** when ownership of it moves to code that may run on another thread.
- A value is **shared across threads** when several threads may use one shared borrow of it at
  the same time.
- A type's **stored parts** are the types it holds by value: a record's fields, a union's variant
  payloads, a structural union's members, an array's element, a closure's captures, and the
  realized storage of an opaque representation.

## THREAD-001 — `Transferable` and `Concurrent` are sealed `Intrinsic` properties published by `silk.concurrency.thread`

**Status:** Confirmed

The sealed namespace has two thread properties:

- `Intrinsic.Transferable`: ownership of a value may move to another thread.
- `Intrinsic.Concurrent`: a shared borrow of a value may be used from several threads at once.

The standard library publishes them under ordinary names through TYPE-004 aliases:

```silk,ignore
// silk/concurrency/thread.silk
pub type Transferable = Intrinsic.Transferable
pub type Concurrent = Intrinsic.Concurrent
```

Either one is a bound, `T: Transferable`, or an `impl` head, `impl Concurrent for Lock {}`, like
`Copy` (INTR-006). A bound on a type parameter is a premise inside the body and an obligation at
each use:

```silk
import silk.concurrency.thread { Transferable }

struct Job { id: i32 }

fn handOff<T: Transferable>(value: T) -> T {
  return move value
}

pub fn main() -> i32 {
  let job = handOff(Job { id: 42 })
  return job.id
}
```

**Boundary:** The properties are bounds and `impl` heads only; neither is a value type. `Drop` is
not a bound. A second bound naming the same property on the same parameter is a duplicate.

**Diagnostics:** A duplicate bound reports `SEM0083`. An unknown `Intrinsic` member reports the
unknown-intrinsic diagnostic of INTR-001.

**Current compiler:** Aligned.

## THREAD-002 — Both properties are derived from a type's stored parts

**Status:** Confirmed

A type has a thread property when the first matching row holds:

| Type | `Transferable` | `Concurrent` |
| --- | --- | --- |
| A type parameter with the property as a premise | yes | yes |
| `()`, a scalar primitive, `string`, a C function address, an enum | yes | yes |
| A raw pointer `*T`, `*mut T`, `[*]T` | no | no |
| `&T`, `&[T]` | when `T` is `Concurrent` | when `T` is `Concurrent` |
| `&mut T`, `&mut [T]` | when `T` is `Transferable` | when `T` is `Concurrent` |
| A record, union, structural union, array, anonymous tuple or record, closure or composed Effect | when every stored part is | when every stored part is |
| A nominal type with an applicable `impl` of the property (THREAD-003) | yes | yes |
| `Allocation`, `Intrinsic.StorageFailure` | yes | yes |
| `RawBuffer<T>`, `Slot<'s, T>` | when `T` is | when `T` is |
| `Shared<T>` (its `Intrinsic.SharedCore<T>`), `Intrinsic.Execution<A>`, `Intrinsic.ExecutionRef` | no | no |
| Any other type, including a parameter without the premise and a callable or Effect contract | no | no |

A raw pointer may alias storage that another thread also reaches, so it proves neither property;
the type that owns the pointer decides with an `impl`. `Shared<T>` counts references without
atomic operations, so a second thread's clone or drop would race. An execution package belongs to
the executor that created it.

A nominal type that stores itself through owned storage is checked once: reaching the same exact
type again while proving it holds. Reaching the same declaration with different arguments, such as
`Growing<T>` storing `Growing<[T; 1]>`, cannot be proved.

```silk
import silk.collections.list { List }
import silk.concurrency.thread { Concurrent, Transferable }

struct Inbox { items: List<i32> }

fn send<T: Transferable>(value: T) -> i32 { return 21 }
fn share<T: Concurrent>(value: &T) -> i32 { return 21 }

pub fn main() -> i32 {
  let inbox = Inbox { items: List<i32>.make() }
  let shared = share(&inbox)
  return shared + send(move inbox)
}
```

**Boundary:** Derivation reads stored parts, never method bodies, so editing a function never
changes a type's thread properties. An `impl` only adds a property; it never removes a derived one.

**Diagnostics:** A bound the type does not satisfy reports `SEM0121` (THREAD-004).

**Current compiler:** Aligned.

## THREAD-003 — An `impl` of a thread property is an unchecked assertion

**Status:** Confirmed

A module asserts a property for a nominal type it declares with an empty `impl`, which may carry
bounds:

```silk,ignore
struct Buffer<T> { base: *mut T, count: usize }

impl<T: Transferable> Transferable for Buffer<T> {}
impl<T: Concurrent> Concurrent for Buffer<T> {}
```

The compiler does not inspect the type's parts when such an `impl` applies. The declaring module
is responsible for every access through the storage the type reaches: transferring a `Buffer<T>`
must not leave another owner of `base`, and sharing one across threads must synchronize every
write, for example with `silk.concurrency.atomic`.

Coherence follows the sealed-property rules for `Copy`: the `impl` lives in the type's declaring
module, and at most one `impl` of a property applies to a type.

**Boundary:** The `impl` declares no members. An enum always has both properties, so an `impl` for
one is rejected.

**Diagnostics:** An `impl` with a member, or an `impl` for an enum, reports `SEM0083`.

**Current compiler:** Aligned.

## THREAD-004 — An unsatisfied thread bound is a missing conformance

**Status:** Confirmed

Each use of a function, type or `impl` head whose bounds name a thread property proves the bound
for the applied type under the caller's premises (THREAD-002). A generic caller passes its own
parameter only when it declares the same bound.

```silk,ignore
import silk.mem.shared { Shared }
import silk.concurrency.thread { Transferable }

fn send<T: Transferable>(value: T) -> () {}

pub fn main() -> i32 {
  let counter = Shared<i32>.make(1)
  send(move counter) // SEM0121: `Shared<i32>: Transferable`
  return 0
}
```

**Diagnostics:** `SEM0121` at the use, naming the goal, such as `` `Shared<i32>: Transferable` ``.

**Current compiler:** Aligned.

## THREAD-005 — `silk.concurrency.thread_native` runs a Transferable closure on a new native thread

**Status:** Confirmed

`NativeThread.spawn<T, F>(work: F) -> JoinHandle<T>` starts `work` on a new operating-system
thread. `F` is a detached, `'static`, `Transferable` closure returning a `Transferable` `T`, so the
closure owns everything it captures and nothing it holds is shared with the spawning thread.
`JoinHandle.join` waits for the thread and returns the value.

```silk,ignore
let handle = run NativeThread.spawn(fn() -> i32 { return compute(move input) })
  |> Effect.provideMut<Allocator>(&mut allocator)
let value = handle.join()
```

Each thread drives its closure as the body of one transferable Execution package (EXEC-010), so one
non-generic C entry point, passed to `pthread_create` with `threadCallbacks`, starts closures of any
type. The start and result cells come from the selected `Allocator`.

**Boundary:** Darwin and GNU libc targets, and wasm32 with `threading = "multi"` (THREAD-009);
other targets report a compile-time error at the use. Dropping an unjoined handle waits for the
thread, since the handle owns the result storage the thread writes. A fatal trap on any thread ends
the process.

**Diagnostics:** A closure or result without its bound reports `SEM0121`. Thread creation failure
is the typed `SpawnError` carrying the `pthread_create` error number.

**Evidence:** [native threads](../stdlib/silk/concurrency/thread_native.silk), native corpus
(`native-thread-spawn-join`, `native-thread-cross-wake`).

**Current compiler:** Aligned.

## THREAD-006 — `silk.concurrency.sync` shares values between native threads

**Status:** Confirmed

`Arc<T>` is a reference-counted handle whose count is atomic: `clone` adds a handle with a relaxed
increment, and the last handle dropped, on any thread, drops the value after a release decrement and
an acquire fence. `Arc.get` borrows the value for as long as the handle is borrowed. `Arc<T>` is
`Transferable` and `Concurrent` when `T` is both. `Shared<T>` stays local to one thread.

`Mutex<T>` gives one thread at a time exclusive access. `lock` returns a `MutexGuard` whose
`get` and `getMut` borrow the value for as long as the guard is borrowed, and dropping the guard
unlocks. The lock word is a futex (`Atomic.wait`, `Atomic.notifyOne`): an uncontended lock and
unlock are one atomic operation each. `Mutex<T>` is `Transferable` and `Concurrent` when `T` is
`Transferable`. `Parker` holds one wakeup token for its thread, and its `Unparker`s supply it from
any thread, so an unpark before the park is not lost.

```silk,ignore
let total = run Arc<Mutex<i32>>.make(move mutex) |> Effect.provideMut<Allocator>(&mut allocator)
let mine = total.clone()
let worker = run NativeThread.spawn(fn() -> i32 { return addOne(move mine) })
  |> Effect.provideMut<Allocator>(&mut allocator)
```

Each type keeps its shared state in its own allocation, reached through raw pointers computed while
that allocation was fresh, and asserts its thread properties with an `impl` (THREAD-003). The
references they return come from the anchored borrow `Pointer.borrow` (see the native pointer
boundary), with the handle or guard as the anchor.

**Boundary:** The targets of `Atomic.wait`. Locking a mutex again on the thread that holds it
deadlocks. Reference cycles of `Arc` handles leak.

**Evidence:** [synchronization](../stdlib/silk/concurrency/sync.silk), native corpus (`sync-arc-mutex-parker`).

**Current compiler:** Aligned.

## THREAD-007 — `silk.concurrency.work_queue` moves owned values between native threads

**Status:** Confirmed

`WorkDeque.make<T>()` returns the `Worker<T>` that owns a Chase-Lev deque. The worker pushes and
pops at the bottom, and any number of `Stealer<T>`s take from the top with one compare-exchange; a
steal that loses a race reports `Steal.Retry`. The ring doubles when full, and older rings stay
allocated until the deque is dropped, because a stealer may still be reading one. `Injector<T>` is
a FIFO queue under a `Mutex` that every handle may push to and pop from. `Mailbox.make<T>()`
returns the one `MailboxReceiver<T>` of a multi-producer, single-consumer queue; each
`MailboxSender<T>` sends with one swap and one store, without a lock.

```silk,ignore
let mut worker = run WorkDeque.make<i32>() |> Effect.provideMut<Allocator>(&mut allocator)
run worker.push(42) |> Effect.provideMut<Allocator>(&mut allocator)
let stealer = worker.stealer()
let thief = run NativeThread.spawn(fn() -> Steal<i32> { return stealer.steal() })
  |> Effect.provideMut<Allocator>(&mut allocator)
```

Every pushed value moves into its own allocation, a parcel, and the queues move parcel addresses
atomically, so only the thread that wins a parcel reads its value. Handles share their queue
through `Arc` (THREAD-006), and a queue still holding values when its last handle drops drops them.
Handles are `Transferable` and `Concurrent` when `T` is `Transferable`, except that a
`MailboxReceiver` takes `receive` exclusively.

**Boundary:** The targets of `Atomic.wait`. Pushing and sending allocate, so they take an
`Allocator`. A receive can report nothing for a moment while a send is between its swap and its
store.

**Evidence:** [work queues](../stdlib/silk/concurrency/work_queue.silk), native corpus (`work-queue-threads`).

**Current compiler:** Aligned.

## THREAD-008 — `silk.concurrency.thread_pool` runs fibers on a work-stealing pool of native threads

**Status:** Confirmed

`ThreadPool.make(workers)` starts the worker threads, and `pool()` returns a `Pool` handle.
`Pool.fork(task)` starts a `Transferable`, `'static` lazy effect `A ! E` as a pool fiber and
returns a `PoolFiber<A, E>`. Its outcome is the `Outcome<A, E>` of `silk.concurrency.fiber`:
`Success`, `Failure` with the typed error, or `Cancelled`. `PoolFiber.await` parks the calling
fiber and returns the outcome as data; `PoolFiber.join` returns the success value and raises the
failure unchanged, or `Cancelled`. `PoolFiber.interrupt` cancels the fiber unless it finished
first, waits for it, and returns its final outcome. `PoolFiber.awaitEither` waits for the first
of two fibers and returns its outcome with the other, still running, as `PoolFirstLeft` or
`PoolFirstRight`; `PoolFiber.race` returns the first result and interrupts the other. Both
allocate one shared wait when neither fiber has ended. `Pool.yieldNow` puts the calling fiber at the
end of the ready list. `Pool.block(task)` runs a fiber from an ordinary thread and sleeps that
thread until it ends. Dropping the `ThreadPool` stops and joins every worker and cancels the
fibers still unfinished.

```silk,ignore
let threads = run ThreadPool.make(4) |> Effect.provideMut<Allocator>(&mut allocator)
let pool = threads.pool()
let total = run pool.block(split(pool.clone()))
```

Each fiber is packaged with `Execution.makeTransferable` (EXEC-010), so it can park on one worker
and resume on another. Its readiness endpoint links the fiber's preallocated slot onto one shared
ready list and wakes a sleeping worker; it never allocates. A worker moves a batch of ready fibers
into its own `WorkDeque` (THREAD-007), and an idle worker steals from the others' deques before
it sleeps on a `Parker`. A `Pool` is `Transferable` and `Concurrent`, so fibers capture it to fork
more fibers.

Cancellation is a flag in the fiber's slot, not in the package control words. The worker that
next takes a flagged fiber drops its execution instead of driving it, which runs the cancel exits
(EXEC-005); a guard the body owns records `Cancelled` and wakes the waiter. A fiber that is parked
and not ready is put on the ready list for that; a running fiber is flagged and cancelled when it
next parks. Each slot carries a ticket that changes when its fiber goes away, so a late wake or
interrupt for a finished or cancelled fiber does nothing.

**Boundary:** The targets of native threads and `Atomic.wait`. A fiber's effect has no
requirements. Waiting inside a fiber for anything other than a `PoolFiber` must park with
`Execution.parkTransferable`; blocking the native thread holds up a whole worker. A fiber that
never parks cannot be cancelled before it ends. A fiber forked after its pool was dropped is
cancelled before it starts. Pool fibers do not provide the `Scheduler` service.

**Evidence:** [thread pool](../stdlib/silk/concurrency/thread_pool.silk), native corpus (`thread-pool-tasks`).

**Current compiler:** Aligned.

## THREAD-009 — A multi-threaded wasm32 profile runs native threads through wasi-threads

**Status:** Confirmed

A project profile with `target = "wasm32-unknown-unknown"` and `threading = "multi"` compiles with
atomics and bulk memory and links one shared memory that the module imports as `env.memory`, with
`max-memory` as its maximum (1 GiB by default, PROFILE-001). `NativeThread.spawn` asks the host for a
thread through the wasi-threads import `wasi.thread-spawn`; the host instantiates the same module
on the same memory and calls its exported `wasi_thread_start`. The compiler's linked runtime gives
each thread a 1 MiB stack from the allocator before the thread runs, and `JoinHandle.join` and
`Atomic.wait` block with `memory.atomic.wait32`. `NativeThread.processorCount` asks the host
through `silk.concurrency.thread-parallelism`.

```toml
[profiles.web]
target = "wasm32-unknown-unknown"
threading = "multi"
max-memory = "256MiB"
```

The standard library ships a host for Node and browsers in `stdlib/host/wasm-runner.mjs`.
`node wasm-runner.mjs program` exits with the status `main` returns, and `runWasm(bytes)` resolves
to it. `main` runs in a Worker, not on the host's own thread, because a browser's main thread may
not block in `memory.atomic.wait32`; the top-level thread creates every thread's Worker.

**Boundary:** Every thread allocates through the runtime's one heap, serialized by one lock that
waits with `memory.atomic.wait32`. Joining a thread returns its stack and record to that heap; a
wasm memory never shrinks, so freed memory is reused but not handed back to the host. A browser
needs cross-origin isolation for shared memory. A wait the host refuses traps. The module also exports `silk_wasm_thread_entry_v1`,
the thread entry the runtime calls; hosts do not call it.

**Diagnostics:** `threading = "multi"` on a native target is still refused as not native. A thread
the host cannot start is the typed `SpawnError` carrying the error number the host returned.

**Evidence:** [native threads](../stdlib/silk/concurrency/thread_native.silk),
[wasm entry](../stdlib/silk/platform/wasm/start.silk), [runner](../stdlib/host/wasm-runner.mjs),
`compiler/scripts/test-native-build.ts`.

**Current compiler:** Aligned.
