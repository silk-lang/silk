/** Compact target-portability witness for public buffered sessions and paired transfer. */
export const bufferedByteIoWasmAcceptanceSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.buffered_duplex {BufferedDuplex, withBufferedPairCapacity}
import silk.buffered_input {BufferError}
import silk.buffered_transfer {BufferedTransfer}
import silk.byte_duplex {ByteDuplex, ByteIoOperation}
import silk.bytes {Bytes}
import silk.effect {Effect}
import silk.memory_byte_duplex {MemoryByteDuplex, MemoryByteDuplexPhase, MemoryReadEvent, MemoryWriteAction, MemoryWriteEvent}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.system_clock {Instant, SystemClock}
import silk.usize
import silk.vector {Vector}

struct FixedClock {}

impl FixedClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn resolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, duration: u64) -> () { drop duration return () }
}

impl MonotonicClock for FixedClock {
  now: FixedClock.now
  getResolution: FixedClock.resolution
  waitUntil: FixedClock.waitUntil
  waitFor: FixedClock.waitFor
}

fn equal(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

effect fn sourceProvider() -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let bytes = run Bytes.copy(&b"abcdef")
  let mut reads = Vector<MemoryReadEvent>.make()
  run Vector<MemoryReadEvent>.append(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 0),
    bytes: move bytes,
  })
  return run MemoryByteDuplex.make(
    move reads,
    Vector<MemoryWriteEvent>.make(),
    usize.ONE,
    4,
    Option<i32>.none(),
  )
}

effect fn destinationProvider() -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let mut writes = Vector<MemoryWriteEvent>.make()
  run Vector<MemoryWriteEvent>.append(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 0),
    action: MemoryWriteAction.Accept {count: 2},
  })
  run Vector<MemoryWriteEvent>.append(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 0),
    action: MemoryWriteAction.Accept {count: 2},
  })
  return run MemoryByteDuplex.make(
    Vector<MemoryReadEvent>.make(),
    move writes,
    4,
    8,
    Option<i32>.none(),
  )
}

effect<'source & 'destination> fn transfer<'source, 'destination>(
  source: &'source mut BufferedDuplex<'source, MemoryByteDuplex>,
  destination: &'destination mut BufferedDuplex<'destination, MemoryByteDuplex>,
) -> i32 ! BufferError ? &mut MonotonicClock
where &'source mut MemoryByteDuplex provides &ByteDuplex
  from &mut ByteDuplex | &mut MonotonicClock,
  &'destination mut MemoryByteDuplex provides &ByteDuplex
  from &mut ByteDuplex | &mut MonotonicClock {
  let zero = run BufferedTransfer.transferAtMost(
    &mut source.*,
    &mut destination.*,
    usize.ZERO,
    Option<Instant>.none(),
  )
  if zero.count != usize.ZERO || zero.endObserved { return 1 }
  if BufferedDuplex.unread(&source.*) != usize.ZERO { return 2 }
  if BufferedDuplex.pending(&destination.*) != usize.ZERO { return 3 }

  let moved = run BufferedTransfer.transferAtMost(
    &mut source.*,
    &mut destination.*,
    4,
    Option<Instant>.none(),
  )
  if moved.count != 4 || moved.endObserved { return 4 }
  if BufferedDuplex.unread(&source.*) != 2 { return 5 }
  let suffix = BufferedDuplex.peek(&source.*)
  if !equal(suffix, b"ef") { drop suffix return 6 }
  drop suffix

  let deadline = SystemClock.make(7, 9)
  run BufferedDuplex.shutdownWrite(
    &mut destination.*,
    Option<Instant>.some(move deadline),
  )
  run BufferedDuplex.shutdownWrite(&mut destination.*, Option<Instant>.none())
  return 42
}

effect fn program() -> i32 ! BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut source = run sourceProvider() |> Effect.provideMut<Allocator>(&mut allocator)
  let mut destination = run destinationProvider() |> Effect.provideMut<Allocator>(&mut allocator)
  let result = run withBufferedPairCapacity<i32, BufferError>(
    &mut source,
    6,
    usize.ONE,
    &mut destination,
    usize.ONE,
    2,
    transfer,
  )
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if result != 42 { return 10 + result }
  if MemoryByteDuplex.closeAttempts(&source) != usize.ONE { return 20 }
  if MemoryByteDuplex.closeAttempts(&destination) != usize.ONE { return 21 }
  if MemoryByteDuplex.phase(&source) != MemoryByteDuplexPhase.Closed { return 22 }
  if MemoryByteDuplex.phase(&destination) != MemoryByteDuplexPhase.Closed { return 23 }
  let outbound = MemoryByteDuplex.outbound(&destination)
  if !equal(outbound, b"abcd") { drop outbound return 24 }
  drop outbound

  let sourceAudit = MemoryByteDuplex.audit(&source)
  if sourceAudit.length != 2 || sourceAudit[0].operation != ByteIoOperation.Read || sourceAudit[1].operation != ByteIoOperation.Close {
    drop sourceAudit
    return 25
  }
  drop sourceAudit
  let destinationAudit = MemoryByteDuplex.audit(&destination)
  if destinationAudit.length != 6 ||
    destinationAudit[0].operation != ByteIoOperation.Write ||
    destinationAudit[1].operation != ByteIoOperation.Write ||
    destinationAudit[2].operation != ByteIoOperation.Flush ||
    destinationAudit[3].operation != ByteIoOperation.Flush ||
    destinationAudit[4].operation != ByteIoOperation.ShutdownWrite ||
    destinationAudit[5].operation != ByteIoOperation.Close {
    drop destinationAudit
    return 26
  }
  drop destinationAudit
  return 0
}

effect<'env> fn failed<E: 'env, 'env>(error: E) -> i32 { drop error return 99 }

pub fn main() -> i32 { return run Effect.catchAll(program(), failed) }
`
