/** Shared native/Wasm corpus source for bounded partial-byte transport behavior. */
export const byteDuplexAcceptanceSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ByteDuplex, ByteIoError, ByteIoOperation, ReadTransfer}
import silk.bytes {Bytes}
import silk.effect {Effect}
import silk.execution { Execution, Wake }
import silk.memory_byte_duplex {MemoryByteDuplex, MemoryByteDuplexPhase, MemoryReadEvent, MemoryWriteAction, MemoryWriteEvent}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.usize
import silk.vector {Vector}

struct VirtualClock { mark: Instant nowCalls: usize waitCalls: usize }
impl MonotonicClock for VirtualClock {
  effect fn now(self: &mut Self) -> Instant {
    self.nowCalls = self.nowCalls + usize.ONE
    return SystemClock.make(SystemClock.seconds(&self.mark), SystemClock.nanoseconds(&self.mark))
  }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () {
    self.waitCalls = self.waitCalls + usize.ONE
    self.mark = move when
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () {
    self.waitCalls = self.waitCalls + usize.ONE
    self.mark = MonotonicClock.deadlineAfter(&self.mark, howLong)
    return ()
  }
}

struct ParkGuard {wake: Wake}
fn retainWake(wake: Wake) -> ParkGuard { return ParkGuard {wake: move wake} }
struct ParkingClock {}
impl MonotonicClock for ParkingClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () {
    drop when
    run Execution.park(retainWake)
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () {
    drop howLong
    run Execution.park(retainWake)
    return ()
  }
}

struct SuspensionAudit {parked: usize completed: usize}
fn suspensionReady(state: &()) -> () { return () }
fn suspensionComplete(state: &mut SuspensionAudit, value: i32) -> () {
  drop value
  state.completed = state.completed + usize.ONE
  return ()
}
fn suspensionParked(
  state: &mut SuspensionAudit,
  execution: Intrinsic.Execution<i32>,
) -> () {
  state.parked = state.parked + usize.ONE
  drop move execution
  return ()
}

struct InvalidDuplex { closeAttempts: usize closed: bool }
impl InvalidDuplex {
  unsafe effect fn invalidRead(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    drop output
    drop deadline
    return ReadTransfer.Data {count: usize.ZERO}
  }
  unsafe effect fn invalidWrite(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize ! ByteIoError ? &mut MonotonicClock {
    drop input
    drop deadline
    return usize.ZERO
  }
  unsafe effect fn invalidFlush(self: &mut Self, deadline: Option<Instant>) -> ()
  ! ByteIoError
  ? &mut MonotonicClock {
    drop deadline
    return ()
  }
  unsafe effect fn invalidShutdown(self: &mut Self, deadline: Option<Instant>) -> ()
  ! ByteIoError
  ? &mut MonotonicClock {
    drop deadline
    return ()
  }
  unsafe effect fn invalidClose(self: &mut Self) -> () ! ByteIoError {
    self.closeAttempts = self.closeAttempts + usize.ONE
    self.closed = true
    fail ByteDuplex.provider(ByteIoOperation.Close, 99)
  }
}
impl ByteDuplex for InvalidDuplex {
  readSomeRaw: InvalidDuplex.invalidRead
  writeSomeRaw: InvalidDuplex.invalidWrite
  flushRaw: InvalidDuplex.invalidFlush
  shutdownWriteRaw: InvalidDuplex.invalidShutdown
  closeRaw: InvalidDuplex.invalidClose
}

effect fn parkedOperation(reading: bool) -> i32 ! ByteIoError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let bytes = run Bytes.copy(&b"x")
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 10),
    bytes: move bytes,
  }) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut writes = Vector.make<MemoryWriteEvent>()
  run Vector.append<MemoryWriteEvent>(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 10),
    action: MemoryWriteAction.Accept {count: usize.ONE},
  }) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut provider = run MemoryByteDuplex.make(
    move reads,
    move writes,
    usize.ONE,
    4,
    Option.none<i32>(),
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut clock = ParkingClock {}
  if reading {
    let mut output: [u8; 1] = [0]
    let transfer = run ByteDuplex.readSome(&mut output, Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut provider)
      |> Effect.provideMut<MonotonicClock>(&mut clock)
    drop transfer
    return 1
  }
  let written = run ByteDuplex.writeSome(&b"x", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut provider)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  return usize.toI32(written)
}

effect<'env> fn suspensionFailed<E: 'env, 'env>(error: E) -> i32 { drop error return -1 }

effect fn actualSuspension() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let readBody = Effect.catchAll(parkedOperation(true), suspensionFailed)
  let readExecution = run Execution.make(move readBody, (), suspensionReady)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut audit = SuspensionAudit {parked: usize.ZERO, completed: usize.ZERO}
  run Execution.drive(move readExecution, &mut audit, suspensionComplete, suspensionParked)
  let writeBody = Effect.catchAll(parkedOperation(false), suspensionFailed)
  let writeExecution = run Execution.make(move writeBody, (), suspensionReady)
    |> Effect.provideMut<Allocator>(&mut allocator)
  run Execution.drive(move writeExecution, &mut audit, suspensionComplete, suspensionParked)
  if audit.parked != 2 || audit.completed != usize.ZERO { return 1 }
  return 0
}

effect fn invalidProviderBoundary() -> i32 ? &mut MonotonicClock {
  let mut provider = InvalidDuplex {closeAttempts: usize.ZERO, closed: false}
  let mut output: [u8; 1] = [0]
  let attempted = run Effect.result(
    ByteDuplex.readSome(&mut output, Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut provider)
  )
  match move attempted {
    Result<ReadTransfer, ByteIoError>.Success {value} => { return 1 }
    Result<ReadTransfer, ByteIoError>.Failure {error} => match move error {
      ByteIoError.InvalidTransferCount {operation, count, limit} => {
        if operation != ByteIoOperation.Read || count != 0 || limit != 1 { return 2 }
      }
      ByteIoError.Timeout {operation} => { return 3 }
      ByteIoError.Closed {operation} => { return 4 }
      ByteIoError.Provider {operation, code} => { return 5 }
    }
  }
  if provider.closeAttempts != usize.ONE || !provider.closed { return 6 }
  let mut writeProvider = InvalidDuplex {closeAttempts: usize.ZERO, closed: false}
  let written = run Effect.result(
    ByteDuplex.writeSome(&b"x", Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut writeProvider)
  )
  match move written {
    Result<usize, ByteIoError>.Success {value} => { return 7 }
    Result<usize, ByteIoError>.Failure {error} => match move error {
      ByteIoError.InvalidTransferCount {operation, count, limit} => {
        if operation != ByteIoOperation.Write || count != 0 || limit != 1 { return 8 }
      }
      ByteIoError.Timeout {operation} => { return 9 }
      ByteIoError.Closed {operation} => { return 10 }
      ByteIoError.Provider {operation, code} => { return 11 }
    }
  }
  if writeProvider.closeAttempts != usize.ONE || !writeProvider.closed { return 12 }
  return 0
}

effect fn capacityBoundary() -> i32
! OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let reads = Vector.make<MemoryReadEvent>()
  let mut writes = Vector.make<MemoryWriteEvent>()
  run Vector.append<MemoryWriteEvent>(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 0),
    action: MemoryWriteAction.Accept {count: usize.ONE},
  })
  let mut provider = run MemoryByteDuplex.make(
    move reads, move writes, usize.ZERO, 2, Option.none<i32>(),
  )
  let attempted = run Effect.result(
    ByteDuplex.writeSome(&b"x", Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut provider)
  )
  match move attempted {
    Result<usize, ByteIoError>.Success {value} => { return 1 }
    Result<usize, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Provider {operation, code} => {
        if operation != ByteIoOperation.Write || code != 2 { return 2 }
      }
      ByteIoError.InvalidTransferCount {operation, count, limit} => { return 3 }
      ByteIoError.Timeout {operation} => { return 4 }
      ByteIoError.Closed {operation} => { return 5 }
    }
  }
  if MemoryByteDuplex.phase(&provider) != MemoryByteDuplexPhase.Invalid { return 6 }
  return 0
}

effect fn deadlineBoundary() -> i32
! OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 10), bytes: run Bytes.copy(&b"late"),
  })
  let writes = Vector.make<MemoryWriteEvent>()
  let mut provider = run MemoryByteDuplex.make(
    move reads, move writes, usize.ZERO, 2, Option.none<i32>(),
  )
  let mut output: [u8; 2] = [0, 0]
  let attempted = run Effect.result(
    ByteDuplex.readSome(&mut output, Option.some<Instant>(SystemClock.make(0, 10)))
      |> Effect.provideMut<ByteDuplex>(&mut provider)
  )
  match move attempted {
    Result<ReadTransfer, ByteIoError>.Success {value} => { return 1 }
    Result<ReadTransfer, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Timeout {operation} => {
        if operation != ByteIoOperation.Read { return 2 }
      }
      ByteIoError.InvalidTransferCount {operation, count, limit} => { return 3 }
      ByteIoError.Closed {operation} => { return 4 }
      ByteIoError.Provider {operation, code} => { return 5 }
    }
  }
  return 0
}

effect fn closeFailureBoundary() -> i32 ! ByteIoError | OutOfMemoryError ? &mut Allocator {
  let reads = Vector.make<MemoryReadEvent>()
  let writes = Vector.make<MemoryWriteEvent>()
  let mut provider = run MemoryByteDuplex.make(
    move reads, move writes, usize.ZERO, 1, Option.some<i32>(77),
  )
  let attempted = run Effect.result(
    ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut provider)
  )
  match move attempted {
    Result<(), ByteIoError>.Success {value} => { return 1 }
    Result<(), ByteIoError>.Failure {error} => match move error {
      ByteIoError.Provider {operation, code} => {
        if operation != ByteIoOperation.Close || code != 77 { return 2 }
      }
      ByteIoError.InvalidTransferCount {operation, count, limit} => { return 3 }
      ByteIoError.Timeout {operation} => { return 4 }
      ByteIoError.Closed {operation} => { return 5 }
    }
  }
  run ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut provider)
  if MemoryByteDuplex.closeAttempts(&provider) != 2 { return 6 }
  if MemoryByteDuplex.phase(&provider) != MemoryByteDuplexPhase.Closed { return 7 }
  return 0
}

struct TransportLease<'env, P> { provider: &'env mut P }
effect fn discardClose(error: ByteIoError) -> () { drop error return () }
effect fn scopedTransport<'env, P>(provider: &'env mut P) -> usize
! ByteIoError
? &mut MonotonicClock
where &'env mut P provides &ByteDuplex from &mut ByteDuplex,
  &'env mut P provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
  let lease = TransportLease<'env, P> {provider: move provider}
  let use = effect fn(owned: &mut TransportLease<'env, P>) -> usize
  ! ByteIoError ? &mut MonotonicClock {
    return run ByteDuplex.writeSome(&b"x", Option.none<Instant>())
      |> Effect.provideMut<ByteDuplex>(&mut owned.provider.*)
  }
  let release = effect fn(owned: &mut TransportLease<'env, P>) -> () {
    let closed = ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut owned.provider.*)
    return run Effect.catchAll(move closed, discardClose)
  }
  return run Effect.useReleaseNonParking(move lease, move use, move release)
}
effect fn scopedProviderBoundary() -> i32
! ByteIoError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock {
  let reads = Vector.make<MemoryReadEvent>()
  let mut writes = Vector.make<MemoryWriteEvent>()
  run Vector.append<MemoryWriteEvent>(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 0), action: MemoryWriteAction.Accept {count: usize.ONE},
  })
  let mut provider = run MemoryByteDuplex.make(move reads, move writes, 1, 4, Option.none<i32>())
  let attempted = run Effect.result(scopedTransport(&mut provider))
  let count = match move attempted {
    Result<usize, ByteIoError>.Success {value} => value
    Result<usize, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Closed {operation} => {
        let failedAudit = MemoryByteDuplex.audit(&provider)
        if failedAudit.length == usize.ONE && failedAudit[0].operation == ByteIoOperation.Close { return 10 }
        return 11
      }
      _ => { return 12 }
    }
  }
  if count != usize.ONE { return 1 }
  if MemoryByteDuplex.closeAttempts(&provider) != usize.ONE { return 2 }
  let audit = MemoryByteDuplex.audit(&provider)
  if audit.length != 2 || audit[0].operation != ByteIoOperation.Write || audit[1].operation != ByteIoOperation.Close { return 3 }
  return 0
}

effect fn program() -> i32 ! ByteIoError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock {
  let scoped = run scopedProviderBoundary()
  if scoped != 0 { return 70 + scoped }
  let first = run Bytes.copy(&b"abc")
  let second = run Bytes.copy(&b"de")
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 5), bytes: move first,
  })
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 6), bytes: move second,
  })
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.End {
    readyAt: SystemClock.make(0, 7),
  })
  let mut writes = Vector.make<MemoryWriteEvent>()
  run Vector.append<MemoryWriteEvent>(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 1), action: MemoryWriteAction.Accept {count: 2},
  })
  run Vector.append<MemoryWriteEvent>(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 2), action: MemoryWriteAction.Accept {count: 3},
  })
  let mut duplex = run MemoryByteDuplex.make(
    move reads, move writes, 16, 16, Option.none<i32>(),
  )
  let mut emptyInput: [u8; 0] = []
  let emptyRead = run ByteDuplex.readSome(&mut emptyInput, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  match move emptyRead {
    ReadTransfer.Data {count} => { if count != 0 { return 1 } }
    ReadTransfer.End => { return 2 }
  }
  if MemoryByteDuplex.audit(&duplex).length != 0 { return 3 }
  let mut input: [u8; 2] = [0, 0]
  let firstRead = run ByteDuplex.readSome(&mut input, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  if input[0] != 97 || input[1] != 98 { return 1 }
  match move firstRead {
    ReadTransfer.Data {count} => { if count != 2 { return 2 } }
    ReadTransfer.End => { return 3 }
  }
  let secondRead = run ByteDuplex.readSome(&mut input, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  if input[0] != 99 { return 4 }
  match move secondRead {
    ReadTransfer.Data {count} => { if count != 1 { return 5 } }
    ReadTransfer.End => { return 6 }
  }
  let thirdRead = run ByteDuplex.readSome(&mut input, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  if input[0] != 100 || input[1] != 101 { return 7 }
  match move thirdRead {
    ReadTransfer.Data {count} => { if count != 2 { return 8 } }
    ReadTransfer.End => { return 9 }
  }
  let ended = run ByteDuplex.readSome(&mut input, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  match move ended {
    ReadTransfer.Data {count} => { return 10 }
    ReadTransfer.End => {}
  }
  let endedAgain = run ByteDuplex.readSome(&mut input, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  match move endedAgain {
    ReadTransfer.Data {count} => { return 11 }
    ReadTransfer.End => {}
  }
  let sentFirst = run ByteDuplex.writeSome(&b"hello", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  if sentFirst != 2 { return 16 }
  let sentSecond = run ByteDuplex.writeSome(&b"llo", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  if sentSecond != 3 { return 17 }
  let empty = run ByteDuplex.writeSome(&b"", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  if empty != 0 { return 18 }
  run ByteDuplex.shutdownWrite(Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut duplex)
  let outbound = MemoryByteDuplex.outbound(&duplex)
  if outbound.length != 5 || outbound[0] != 104 || outbound[4] != 111 { return 19 }
  let audit = MemoryByteDuplex.audit(&duplex)
  if audit.length != 8 { return 20 }
  if audit[6].operation != ByteIoOperation.Flush { return 21 }
  if audit[7].operation != ByteIoOperation.ShutdownWrite { return 22 }
  run ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut duplex)
  run ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut duplex)
  if MemoryByteDuplex.closeAttempts(&duplex) != 2 { return 23 }
  if MemoryByteDuplex.phase(&duplex) != MemoryByteDuplexPhase.Closed { return 24 }
  let invalid = run invalidProviderBoundary()
  if invalid != 0 { return 30 + invalid }
  let capacity = run capacityBoundary()
  if capacity != 0 { return 40 + capacity }
  let deadline = run deadlineBoundary()
  if deadline != 0 { return 45 + deadline }
  let closeFailure = run closeFailureBoundary()
  if closeFailure != 0 { return 50 + closeFailure }
  let suspended = run actualSuspension()
  if suspended != 0 { return 60 + suspended }
  return 42
}

effect<'env> fn failed<E: 'env, 'env>(error: E) -> i32 { drop error return -1 }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = VirtualClock {
    mark: SystemClock.make(0, 0),
    nowCalls: usize.ZERO,
    waitCalls: usize.ZERO,
  }
  let result = run Effect.catchAll(
    program()
      |> Effect.provideMut<Allocator>(&mut allocator)
      |> Effect.provideMut<MonotonicClock>(&mut clock),
    failed,
  )
  if result != 42 { return result }
  if clock.nowCalls != 14 || clock.waitCalls != 4 { return -2 }
  return result
}`
