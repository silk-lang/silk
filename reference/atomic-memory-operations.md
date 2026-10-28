# Atomic memory operations

Atomic intrinsics give ordinary Silk source the indivisible memory accesses and orderings that
locks, reference counts, and lock-free queues are built from. The compiler supplies only the
accesses and the fence; every lock, counter, and queue is standard-library or user source. The
public API is `silk.concurrency.atomic`, which maps its `MemoryOrder` enum to the static ordering text these
intrinsics take.

## Terms

- An **atomic access** is one execution of an atomic intrinsic: a load, a store, or one
  read-modify-write of a single memory location.
- A **plain access** is any other read or write of memory, including `pointerRead`, `pointerWrite`,
  and ordinary place reads and writes.
- Two accesses **conflict** when they reach overlapping bytes and at least one writes.
- A **data race** is two conflicting accesses from different threads where at least one is plain
  and neither happens before the other.
- An **element** is the type `T` an atomic access reads or writes.

## ATOMIC-001 — Atomic accesses follow the C++20 memory model, and a data race is undefined

**Status:** Confirmed

Atomic accesses and fences follow the C++20 memory model without `memory_order_consume`. Each
access names one ordering:

| Text | Meaning |
| --- | --- |
| `"relaxed"` | Atomicity only; no ordering with other locations |
| `"acquire"` | Later accesses in this thread cannot move before this read |
| `"release"` | Earlier accesses in this thread cannot move after this write |
| `"acquireRelease"` | Both, for a read-modify-write or a fence |
| `"sequentiallyConsistent"` | Acquire and release, in one total order over all such operations |

An acquire read that reads a value written by a release write synchronizes with it: everything the
writer did before the release happens before everything the reader does after the acquire.

The ordering is a static argument. It must be available during specialization, as a literal or a
value derived from static parameters and bindings (STATIC-002). Each operation admits these
orderings:

| Operation | Admitted orderings |
| --- | --- |
| Load | relaxed, acquire, sequentiallyConsistent |
| Store | relaxed, release, sequentiallyConsistent |
| Swap, fetch operations, compare-exchange success | all five |
| Compare-exchange failure | relaxed, acquire, sequentiallyConsistent |
| Fence | acquire, release, acquireRelease, sequentiallyConsistent |

A compare-exchange failure ordering may be stronger than its success ordering.

**Boundary:** A data race is undefined behavior, as is an atomic access that overlaps another atomic
access of a different width. Every access to a shared location must be atomic and use one width.
Silk has no consume ordering, no volatile access, and no signal-only fence.

**Diagnostics:** Text that names no ordering, or an ordering the operation does not admit, reports
`SEM0237` at that ordering argument. A runtime value where a static ordering is required reports
`SEM0176`.

**Current compiler:** Aligned. Orderings lower to LLVM's `monotonic`, `acquire`, `release`,
`acq_rel`, and `seq_cst`.

**Evidence:** atomic intrinsic lowering tests, `corpus/invalid/atomic-operation-admission`.

## ATOMIC-002 — Loads, stores, swaps, and fetch operations access one aligned element

**Status:** Confirmed

```silk,ignore
unsafe fn atomicLoad<T>(pointer: *const T, static order: string<'static>) -> T
unsafe fn atomicStore<T>(pointer: *mut T, value: T, static order: string<'static>) -> ()
unsafe fn atomicSwap<T>(pointer: *mut T, value: T, static order: string<'static>) -> T
unsafe fn atomicFetchAdd<T>(pointer: *mut T, value: T, static order: string<'static>) -> T
```

`atomicFetchSubtract`, `atomicFetchBitAnd`, `atomicFetchBitOr`, `atomicFetchBitXor`,
`atomicFetchMinimum`, and `atomicFetchMaximum` share `atomicFetchAdd`'s contract. Each fetch
operation stores its result in the pointee and returns the previous value. Addition and
subtraction wrap. Minimum and maximum compare under `T`'s signedness.

Load, store, swap, and compare-exchange admit `u8`, `u16`, `u32`, `u64`, `usize`, `i8`, `i16`,
`i32`, `i64`, `isize`, and data pointers. The fetch operations admit the integers only.

Every operation except the fence is unsafe. The caller proves that the pointer is non-null,
addresses live storage for `T` at `T`'s natural alignment, and that the location is initialized for
every operation that reads it.

**Boundary:** `bool`, floating-point, and aggregate elements are not admitted; a library stores a
flag as `u8`. 128-bit elements are not admitted.

**Diagnostics:** A concrete element the operation does not admit reports `SEM0237` at the call. A
missing unsafe acknowledgement reports `SEM0082`.

**Current compiler:** Partially aligned. An element supplied through a caller's type parameter is
checked when the caller's instance is lowered, and an inadmissible one is a compiler gap rather
than `SEM0237`.

**Evidence:** `corpus/native/atomic-operations`, atomic intrinsic lowering tests.

## ATOMIC-003 — A compare-exchange reports success and the observed value

**Status:** Confirmed

```silk,ignore
unsafe fn atomicCompareExchange<T>(pointer: *mut T, expected: *mut T, desired: T,
  static success: string<'static>, static failure: string<'static>) -> bool
```

The operation compares the pointee with `*expected`. When they are equal it stores `desired` with
the `success` ordering and returns `true`. Otherwise it returns `false` and the read uses the
`failure` ordering. Both outcomes write the value the pointee held to `*expected`; after a success
that value equals the one already there.

`atomicCompareExchangeWeak` has the same contract, except it may return `false` while the pointee
equals `*expected`. Callers retry it in a loop.

**Boundary:** The caller additionally proves that `expected` addresses writable storage for `T`
that no other thread accesses during the call.

**Diagnostics:** A refused failure ordering reports `SEM0237` at the failure argument.

**Current compiler:** Aligned.

**Evidence:** `corpus/native/atomic-operations`, atomic intrinsic lowering tests.

## ATOMIC-004 — A fence orders accesses without accessing memory

**Status:** Confirmed

```silk,ignore
fn atomicFence(static order: string<'static>) -> ()
```

A release fence followed by an atomic store, paired with an atomic load followed by an acquire
fence, synchronizes when the load reads the stored value, exactly as a release store and an
acquire load would. A sequentially consistent fence joins the single total order.

The fence is safe: it reads and writes no memory.

**Boundary:** A fence orders only the calling thread's accesses. It is not a compiler-only barrier
for signal handlers.

**Diagnostics:** A relaxed fence reports `SEM0237`.

**Current compiler:** Aligned.

**Evidence:** atomic intrinsic lowering tests.

## ATOMIC-005 — Targets without threads lower atomics to plain accesses

**Status:** Confirmed

Every supported target accepts every atomic intrinsic. A WebAssembly build without the `atomics`
CPU feature has one thread, so LLVM lowers each atomic access to a plain one and each fence to
nothing. The same standard-library source builds for both.

**Boundary:** Shared-memory WebAssembly threads need the `atomics` feature and a shared-memory link,
which no current profile selects.

**Current compiler:** Aligned.

**Evidence:** `compiler/src/semantic/Target.silk`.
