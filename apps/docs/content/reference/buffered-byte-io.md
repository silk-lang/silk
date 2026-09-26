# Buffered byte I/O

Silk's buffered byte actors provide fixed-capacity lookahead and output retention for incremental
protocols. They build on `silk.byte_duplex.ByteDuplex`; they do not replace its exact partial
transfer contract or turn `Writer` and `StandardInput` into a duplex service.

## Storage and ownership

`BufferedInput.make` and `BufferedOutput.make` accept capacities from 1 through 1,048,576 bytes.
They validate the capacity before allocating, allocate one fully initialized buffer through the
active `Allocator`, and never grow it. `BufferedDuplex.withBuffered` uses 8,192 bytes for each
direction; `withBufferedCapacity` accepts explicit direction capacities and validates both before
allocating either buffer or acquiring the transport lease. `withBufferedCapacityContext` consumes
one affine context whose compile-time `BufferedContext` witness selects a named adapter; that
adapter receives an independently higher-ranked temporary session without adding a runtime service
or requirement-row member.
`withBufferedPairCapacity` accepts two transports plus four explicit direction capacities,
validates all four before allocation or lease acquisition, and publishes both sessions to one
callback.

The duplex operations exclusively retain one concrete transport for the callback scope. The
session and any slice returned by `peek` borrow that scope and cannot escape it. While a peek is
live, Silk's ordinary ownership rules reject `consume`, `fill`, `readSome`, and other conflicting
mutations. Callback requirements exclude independent ambient `ByteDuplex` access.

`BufferedDuplex.shutdownWrite(deadline)` is the explicit half-close operation. It drains retained
output, delegates canonical `ByteDuplex.shutdownWrite` through the session's private provider with
the unchanged absolute deadline, and keeps input readable after success. Repeated shutdown is
idempotent; later buffered output is rejected without provider I/O. A typed drain, flush, or
shutdown failure instead terminalizes the complete session. Structured cancellation during the
operation unwinds the enclosing buffered scope and terminally closes the retained provider.

Success, typed failure, and structured cancellation or interruption terminally close the provider
through the nonparking resource bracket. Fatal traps bypass finalizers and `Drop`, as they do for
other Silk resource brackets. Release never flushes pending output. Call `finish` when pending
bytes must reach the provider's flush boundary. The paired scope applies the same rule to both
transports and attempts terminal close on each exactly once without replacing the protected
structured outcome.

This complete example opens an empty in-memory transport, performs a zero-byte buffered operation,
and lets the scope close the transport:

```silk
import silk.allocator { Allocator, OutOfMemoryError }
import silk.buffered_duplex {
  BufferedContext,
  BufferedDuplex,
  withBufferedCapacityContext,
}
import silk.buffered_input { BufferError, FillOutcome }
import silk.byte_duplex { ByteDuplex }
import silk.effect { Effect }
import silk.memory_byte_duplex { MemoryByteDuplex, MemoryReadEvent, MemoryWriteEvent }
import silk.monotonic_clock { MonotonicClock }
import silk.option { Option }
import silk.system_clock { Instant, SystemClock }
import silk.u64
import silk.usize
import silk.vector { Vector }

struct FixedClock {}
struct Inspection { minimum: usize }

impl MonotonicClock for FixedClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, duration: u64) -> () { drop duration return () }
}

impl Inspection {
  effect<'session> fn use<'session, 'transport: 'session>(
    context: Self,
    session: &'session mut BufferedDuplex<'transport, MemoryByteDuplex>,
  ) -> usize ! BufferError ? &mut MonotonicClock
  where &'transport mut MemoryByteDuplex provides &ByteDuplex
    from &mut ByteDuplex | &mut MonotonicClock {
    let filled = run BufferedDuplex.fill(
      &mut session.*,
      context.minimum,
      Option.none<Instant>(),
    )
    return match move filled {
      FillOutcome.Available { count } => count
      FillOutcome.End { available } => available
    }
  }
}

impl BufferedContext<
  MemoryByteDuplex,
  usize,
  BufferError ? &mut MonotonicClock
> for Inspection {
  use: Inspection.use
}

effect fn program() -> usize ! BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut transport = run MemoryByteDuplex.make(
    Vector.make<MemoryReadEvent>(),
    Vector.make<MemoryWriteEvent>(),
    usize.ONE,
    usize.ONE,
    Option.none<i32>(),
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  return run withBufferedCapacityContext(
    &mut transport,
    16,
    16,
    Inspection { minimum: usize.ZERO },
  )
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
}

effect<'env> fn failed<E: 'env, 'env>(error: E) -> usize { drop error return usize.ZERO }

pub fn main() -> i32 {
  return usize.toI32(run Effect.catchAll(program(), failed))
}
```

## Retained input

`fill(minimum, deadline)` compacts unread bytes and reads until the minimum is available or the
source ends or fails. Zero performs no I/O. A minimum larger than the fixed capacity fails before
changing state. `FillOutcome.End { available }` keeps an incomplete final prefix readable, and the
observed end remains sticky while that retained prefix is consumed.

`peek` returns exactly the initialized unread range. `consume(n)` advances only within that range
and preserves state on overrun. Together they preserve lookahead beyond a parsed boundary:

```silk,ignore
// If the provider yields b"head\r\nbody" in one read:
let state = run session.fill(6, deadline)
let bytes = session.peek()
// Parse only b"head\r\n" from bytes.
drop bytes
run session.consume(6)
let body = session.peek() // b"body"; no second provider read
```

`readSome` copies one positive prefix or reports `ReadTransfer.End`; an empty destination performs
no I/O. `readExact` reports the exact copied prefix when it encounters early end or failure.
`discardAtMost` and `discardExact` are finite: reaching an at-most limit never triggers an extra read
merely to probe for end. There is intentionally no unbounded read-to-end or delimiter helper.

`fillStandard` and `readSomeStandard` adapt the existing `StandardInput` capability without a
deadline parameter and without closing the caller-owned provider.

## Retained output and progress

`writeSome(input, deadline)` accepts a positive prefix into owned pending storage, flushing exact
pending prefixes only when it needs space. Success means the session owns those bytes; it does not
mean the peer application has received them. `writeAll` and `writeVecAll` preserve input order, and
vector aggregate overflow is rejected before output. `BufferedDuplex.writeVecAll` forwards the same
absolute deadline and private provider contract as the scalar write operations.

`flush` advances its pending cursor after each exact successful `ByteDuplex.writeSome` count, then
calls `ByteDuplex.flush`. Compaction never repeats a reported prefix. `BufferError.WriteFailed`
reports `accepted`, the exact current caller-input prefix owned by the buffer, separately from
`drained`, the exact pending prefix acknowledged during the failing transport drain. This keeps the
caller retry cursor independent from transport progress.

Any underlying read, write, or flush failure makes the entire `BufferedDuplex` session terminal.
The opposite direction rejects its next operation without consulting the provider, while `peek`,
`unread`, and `pending` keep the direction-local state inspectable for diagnostics.

Writer-only operations omit deadlines. Because `Writer.writeAll` is all-or-error, a failed call has
unknown external progress. The adapter reports `UnknownExternalTransfer`; it never fabricates a
zero prefix and never retries the uncertain value. It neither flushes nor closes on drop.

## Bounded transfer

`BufferedTransfer.transferAtMost` peeks the source, offers no more than the remaining finite limit,
and consumes only the prefix the destination reports accepting. If the destination later fails,
the complete unaccepted suffix remains in the source's unread allocation. `transferExact` adds
precise early-end reporting. A zero limit performs no I/O. Acquire the two live endpoints together
with `BufferedDuplex.withBufferedPairCapacity`; nesting the generic single-session constructor is
not required.

Both endpoints are exclusive borrows. Ownership analysis therefore rejects the same session as both
source and destination and rejects two sessions that alias one exclusive provider lease. Writer is
not an exact-prefix transfer destination. These operations promise neither zero-copy nor native
`writev`, `sendfile`, seek, pread, or streaming filesystem support.

## Deadlines

Every duplex-backed repeated operation forwards one unchanged absolute `Option<Instant>` on the
active `MonotonicClock` timeline. It does not renew a duration after a short read or write.
StandardInput and Writer adapters expose no deadline parameter because their service contracts do
not supply that capability.
