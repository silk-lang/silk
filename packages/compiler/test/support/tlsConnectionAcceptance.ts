import {
  tlsClientRsaApplicationWrite,
  tlsClientRsaClientHello,
  tlsClientRsaRootPem,
  tlsClientRsaServerCloseNotify,
  tlsClientRsaServerFlight,
} from './tlsClientAcceptance.js'

const silkBytes = (bytes: Uint8Array): string =>
  `b"${[...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`

// The capture's first record uses 0x0301; Silk emits 0x0303, as the TLS-client
// acceptance witness asserts. Preserve every handshake byte and compare the full output prefix.
const clientHello = tlsClientRsaClientHello.map((byte, index) => (index === 2 ? 3 : byte))

const firstFlight = tlsClientRsaServerFlight.subarray(0, 64)
const secondFlight = tlsClientRsaServerFlight.subarray(64, 576)
const thirdFlight = tlsClientRsaServerFlight.subarray(576)

const connectionSource = (
  includeFailureCases: boolean,
): string => `import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ByteDuplex, ByteIoError, ByteIoOperation, ReadTransfer}
import silk.bytes {Bytes}
import silk.effect {Effect}
import silk.execution {Execution}
import silk.https_identity {HttpsIdentity, IdentityError, OriginHost, ReferenceIdentity}
import silk.memory_byte_duplex {
  MemoryByteDuplex,
  MemoryByteDuplexPhase,
  MemoryReadEvent,
  MemoryWriteAction,
  MemoryWriteEvent,
}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.random {Random}
import silk.result {Result}
import silk.shared {Shared}
import silk.system_clock {Instant, SystemClock}
import silk.tls_client {AlpnConfig, Authentication, ClientConfig, ClientLimits, NamedGroup, TlsError}
import silk.tls_connection {OwnedConnection, ConnectionError, ConnectionOptions, ConnectionPhase, authenticateOwned, withClient}
import silk.tls_record {CipherSuite}
import silk.trust_snapshot {TrustLoadLimits, TrustSnapshot, TrustSourceError}
import silk.u64
import silk.usize
import silk.vector {Vector}

struct ScriptedRandom {filled: usize}
impl Random for ScriptedRandom {
  effect fn fillBytes(self: &mut Self, output: &mut [u8]) -> () {
    let mut index = usize.ZERO
    while index < output.length {
      output[index] = usize.toU8((self.filled + index + usize.ONE) % 251 + usize.ONE)
      index = index + usize.ONE
    }
    self.filled = self.filled + output.length
    return ()
  }
}

struct FixedWallClock {calls: usize}
impl SystemClock for FixedWallClock {
  effect fn now(self: &mut Self) -> Instant {
    self.calls = self.calls + usize.ONE
    return SystemClock.make(1789156800, 123456789)
  }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
}

struct VirtualClock {mark: Instant nowCalls: usize waitCalls: usize}
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

${
  includeFailureCases
    ? `struct SequencedDeadlineClock {calls: usize expireAt: usize}
impl MonotonicClock for SequencedDeadlineClock {
  effect fn now(self: &mut Self) -> Instant {
    self.calls = self.calls + usize.ONE
    if self.calls >= self.expireAt { return SystemClock.make(131, 0) }
    return SystemClock.make(100, 0)
  }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { drop howLong return () }
}

service CallbackAudit { effect fn invoked() -> () ? &mut CallbackAudit }
struct CallbackCounter {calls: usize}
effect fn countCallback(self: &mut CallbackCounter) -> () { self.calls = self.calls + usize.ONE return () }
impl CallbackAudit for CallbackCounter {invoked: CallbackCounter.countCallback}

struct DeadlineAudit {
  writes: usize
  flushes: usize
  closes: usize
  deadlineCalls: usize
  deadlineConsistent: bool
  deadlineSeconds: i64
  deadlineNanoseconds: i64
}

fn recordDeadline(
  state: &mut DeadlineAudit,
  deadline: &Option<Instant>,
) -> () {
  if let Option<Instant>.Some {value} = &deadline.* {
    let seconds = SystemClock.seconds(&value)
    let nanoseconds = SystemClock.nanoseconds(&value)
    if state.deadlineCalls == usize.ZERO {
      state.deadlineSeconds = seconds
      state.deadlineNanoseconds = nanoseconds
    } else if state.deadlineSeconds != seconds || state.deadlineNanoseconds != nanoseconds {
      state.deadlineConsistent = false
    }
    state.deadlineCalls = state.deadlineCalls + usize.ONE
  }
  return ()
}

struct TimeoutDuplex {audit: Shared<DeadlineAudit>}
impl TimeoutDuplex {
  unsafe effect fn read(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    drop output
    drop deadline
    return ReadTransfer.End
  }
  unsafe effect fn write(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.audit, fn(state: &mut DeadlineAudit) -> () {
      state.writes = state.writes + usize.ONE
      recordDeadline(move state, &deadline)
      return ()
    })
    return input.length
  }
  unsafe effect fn flush(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.audit, fn(state: &mut DeadlineAudit) -> () {
      state.flushes = state.flushes + usize.ONE
      recordDeadline(move state, &deadline)
      return ()
    })
    fail ByteDuplex.timeout(ByteIoOperation.Flush)
  }
  unsafe effect fn shutdown(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    drop deadline
    return ()
  }
  unsafe effect fn close(self: &mut Self) -> () ! ByteIoError {
    Shared.withMut(&self.audit, fn(state: &mut DeadlineAudit) -> () {
      state.closes = state.closes + usize.ONE
      return ()
    })
    fail ByteDuplex.provider(ByteIoOperation.Close, 88)
  }
}
impl ByteDuplex for TimeoutDuplex {
  readSomeRaw: TimeoutDuplex.read
  writeSomeRaw: TimeoutDuplex.write
  flushRaw: TimeoutDuplex.flush
  shutdownWriteRaw: TimeoutDuplex.shutdown
  closeRaw: TimeoutDuplex.close
}

enum PostReadResult { Data, InvalidCount }

struct PostReadState {
  readReturned: bool
  reads: usize
  writes: usize
  flushes: usize
  closes: usize
}

fn postReadReturned(state: &PostReadState) -> bool { return state.readReturned }

struct PostReadClock {state: Shared<PostReadState>}
impl MonotonicClock for PostReadClock {
  effect fn now(self: &mut Self) -> Instant {
    if Shared.with(&self.state, postReadReturned) { return SystemClock.make(130, 0) }
    return SystemClock.make(100, 0)
  }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { drop howLong return () }
}

struct PostReadDuplex {
  result: PostReadResult
  state: Shared<PostReadState>
}

impl PostReadDuplex {
  unsafe effect fn read(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    drop deadline
    Shared.withMut(&self.state, fn(state: &mut PostReadState) -> () {
      state.readReturned = true
      state.reads = state.reads + usize.ONE
      return ()
    })
    return match self.result {
      PostReadResult.Data => {
        output[usize.ZERO] = 255
        return ReadTransfer.Data {count: usize.ONE}
      }
      PostReadResult.InvalidCount => ReadTransfer.Data {count: output.length + usize.ONE}
    }
  }
  unsafe effect fn write(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize ! ByteIoError ? &mut MonotonicClock {
    drop deadline
    Shared.withMut(&self.state, fn(state: &mut PostReadState) -> () {
      state.writes = state.writes + usize.ONE
      return ()
    })
    return input.length
  }
  unsafe effect fn flush(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    drop deadline
    Shared.withMut(&self.state, fn(state: &mut PostReadState) -> () {
      state.flushes = state.flushes + usize.ONE
      return ()
    })
    return ()
  }
  unsafe effect fn shutdown(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock { drop deadline return () }
  unsafe effect fn close(self: &mut Self) -> () ! ByteIoError {
    Shared.withMut(&self.state, fn(state: &mut PostReadState) -> () {
      // Invalid-count validation can close before the owning scope releases the provider.
      if state.closes == usize.ZERO { state.closes = usize.ONE }
      return ()
    })
    return ()
  }
}

impl ByteDuplex for PostReadDuplex {
  readSomeRaw: PostReadDuplex.read
  writeSomeRaw: PostReadDuplex.write
  flushRaw: PostReadDuplex.flush
  shutdownWriteRaw: PostReadDuplex.shutdown
  closeRaw: PostReadDuplex.close
}
`
    : ''
}

struct OwnedMemoryAudit {
  closes: usize
  underlyingCloseAttempts: usize
  closed: bool
  laterIo: usize
  reads: usize
  writes: usize
  flushes: usize
  helloPrefix: bool
  applicationWrite: bool
  shortWritePrefix: bool
  shutdowns: usize
  shutdownAfterFlush: bool
  closeLast: bool
  handshakeCalls: usize
  handshakeReads: usize
  handshakeWrites: usize
  handshakeFlushes: usize
  handshakeShutdowns: usize
  handshakeDeadlineConsistent: bool
  handshakeDeadlineSeconds: i64
  handshakeDeadlineNanoseconds: i64
}

fn freshOwnedMemoryAudit() -> OwnedMemoryAudit {
  return OwnedMemoryAudit {
    closes: usize.ZERO,
    underlyingCloseAttempts: usize.ZERO,
    closed: false,
    laterIo: usize.ZERO,
    reads: usize.ZERO,
    writes: usize.ZERO,
    flushes: usize.ZERO,
    helloPrefix: false,
    applicationWrite: false,
    shortWritePrefix: false,
    shutdowns: usize.ZERO,
    shutdownAfterFlush: false,
    closeLast: false,
    handshakeCalls: usize.ZERO,
    handshakeReads: usize.ZERO,
    handshakeWrites: usize.ZERO,
    handshakeFlushes: usize.ZERO,
    handshakeShutdowns: usize.ZERO,
    handshakeDeadlineConsistent: true,
    handshakeDeadlineSeconds: 0,
    handshakeDeadlineNanoseconds: 0,
  }
}

fn recordOwnedMemoryIo(
  state: &mut OwnedMemoryAudit,
  operation: ByteIoOperation,
  deadline: &Option<Instant>,
) -> () {
  if state.closed { state.laterIo = state.laterIo + usize.ONE }
  match operation {
    ByteIoOperation.Read => { state.reads = state.reads + usize.ONE }
    ByteIoOperation.Write => { state.writes = state.writes + usize.ONE }
    ByteIoOperation.Flush => { state.flushes = state.flushes + usize.ONE }
    ByteIoOperation.ShutdownWrite => {}
    ByteIoOperation.Close => {}
  }
  if let Option<Instant>.Some {value} = &deadline.* {
    let seconds = SystemClock.seconds(&value)
    let nanoseconds = SystemClock.nanoseconds(&value)
    if state.handshakeCalls == usize.ZERO {
      state.handshakeDeadlineSeconds = seconds
      state.handshakeDeadlineNanoseconds = nanoseconds
    } else if state.handshakeDeadlineSeconds != seconds
      || state.handshakeDeadlineNanoseconds != nanoseconds {
      state.handshakeDeadlineConsistent = false
    }
    state.handshakeCalls = state.handshakeCalls + usize.ONE
    match operation {
      ByteIoOperation.Read => { state.handshakeReads = state.handshakeReads + usize.ONE }
      ByteIoOperation.Write => { state.handshakeWrites = state.handshakeWrites + usize.ONE }
      ByteIoOperation.Flush => { state.handshakeFlushes = state.handshakeFlushes + usize.ONE }
      ByteIoOperation.ShutdownWrite => {
        state.handshakeShutdowns = state.handshakeShutdowns + usize.ONE
      }
      ByteIoOperation.Close => {}
    }
  }
  return ()
}

struct OwnedMemoryDuplex {
  inner: MemoryByteDuplex
  audit: Shared<OwnedMemoryAudit>
}

impl OwnedMemoryDuplex {
  unsafe effect fn read(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.audit, fn(state: &mut OwnedMemoryAudit) -> () {
      recordOwnedMemoryIo(move state, ByteIoOperation.Read, &deadline)
      return ()
    })
    return run ByteDuplex.readSome(move output, move deadline)
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }

  unsafe effect fn write(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.audit, fn(state: &mut OwnedMemoryAudit) -> () {
      recordOwnedMemoryIo(move state, ByteIoOperation.Write, &deadline)
      return ()
    })
    return run ByteDuplex.writeSome(input, move deadline)
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }

  unsafe effect fn flush(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.audit, fn(state: &mut OwnedMemoryAudit) -> () {
      recordOwnedMemoryIo(move state, ByteIoOperation.Flush, &deadline)
      return ()
    })
    return run ByteDuplex.flush(move deadline)
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }

  unsafe effect fn shutdown(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.audit, fn(state: &mut OwnedMemoryAudit) -> () {
      recordOwnedMemoryIo(move state, ByteIoOperation.ShutdownWrite, &deadline)
      return ()
    })
    return run ByteDuplex.shutdownWrite(move deadline)
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }

  unsafe effect fn close(self: &mut Self) -> () ! ByteIoError {
    let attempted = run Effect.result(
      ByteDuplex.close()
        |> Effect.provideMut<ByteDuplex>(&mut self.inner)
    )
    let outbound = MemoryByteDuplex.outbound(&self.inner)
    let hello = ${silkBytes(clientHello)}
    let mut helloPrefix = outbound.length >= hello.length
    let mut helloIndex = usize.ZERO
    while helloPrefix && helloIndex < hello.length {
      if outbound[helloIndex] != hello[helloIndex] { helloPrefix = false }
      helloIndex = helloIndex + usize.ONE
    }
    let applicationWrite = contains(outbound, ${silkBytes(tlsClientRsaApplicationWrite)})
    let operations = MemoryByteDuplex.audit(&self.inner)
    let shortWritePrefix = operations.length >= 2
      && operations[0].operation == ByteIoOperation.Write
      && operations[0].count == usize.ONE
      && operations[1].operation == ByteIoOperation.Write
      && operations[1].count == 2
    let mut shutdowns = usize.ZERO
    let mut shutdownAfterFlush = false
    let mut operationIndex = usize.ONE
    while operationIndex < operations.length {
      if operations[operationIndex].operation == ByteIoOperation.ShutdownWrite {
        shutdowns = shutdowns + usize.ONE
        if operations[operationIndex - usize.ONE].operation == ByteIoOperation.Flush {
          shutdownAfterFlush = true
        }
      }
      operationIndex = operationIndex + usize.ONE
    }
    let closeLast = operations.length > usize.ZERO
      && operations[operations.length - usize.ONE].operation == ByteIoOperation.Close
    let closeAttempts = MemoryByteDuplex.closeAttempts(&self.inner)
    let closed = MemoryByteDuplex.phase(&self.inner) == MemoryByteDuplexPhase.Closed
    drop operations
    Shared.withMut(&self.audit, fn(state: &mut OwnedMemoryAudit) -> () {
      state.closes = state.closes + usize.ONE
      state.underlyingCloseAttempts = closeAttempts
      state.closed = closed
      state.helloPrefix = helloPrefix
      state.applicationWrite = applicationWrite
      state.shortWritePrefix = shortWritePrefix
      state.shutdowns = shutdowns
      state.shutdownAfterFlush = shutdownAfterFlush
      state.closeLast = closeLast
      return ()
    })
    return match move attempted {
      Result<(), ByteIoError>.Success {value} => move value
      Result<(), ByteIoError>.Failure {error} => { fail move error }
    }
  }
}

impl ByteDuplex for OwnedMemoryDuplex {
  readSomeRaw: OwnedMemoryDuplex.read
  writeSomeRaw: OwnedMemoryDuplex.write
  flushRaw: OwnedMemoryDuplex.flush
  shutdownWriteRaw: OwnedMemoryDuplex.shutdown
  closeRaw: OwnedMemoryDuplex.close
}

${
  includeFailureCases
    ? `struct CancellationState {closes: usize callbacks: usize}
fn recordCancellationClose(state: &mut CancellationState) -> () {
  state.closes = state.closes + usize.ONE
  return ()
}
fn recordCancellationCallback(state: &mut CancellationState) -> () {
  state.callbacks = state.callbacks + usize.ONE
  return ()
}
fn cancellationResult(state: &mut CancellationState) -> i32 {
  if state.closes == usize.ONE && state.callbacks == usize.ZERO { return 42 }
  return -3
}

struct SharedCallbackCounter {state: Shared<CancellationState>}
effect fn countSharedCallback(self: &mut SharedCallbackCounter) -> () {
  Shared.withMut(&self.state, recordCancellationCallback)
  return ()
}
impl CallbackAudit for SharedCallbackCounter {invoked: SharedCallbackCounter.countSharedCallback}

struct ParkingClock {}
struct ParkGuard {wake: Wake}
fn retainWake(wake: Wake) -> ParkGuard { return ParkGuard {wake: move wake} }
impl MonotonicClock for ParkingClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(100, 0) }
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

struct ParkingDuplex {state: Shared<CancellationState>}
impl ParkingDuplex {
  unsafe effect fn read(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    drop output
    let wakeAt = match move deadline {
      Option<Instant>.None => SystemClock.make(200, 0)
      Option<Instant>.Some {value} => move value
    }
    run MonotonicClock.waitUntil(move wakeAt)
    return ReadTransfer.End
  }
  unsafe effect fn write(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize ! ByteIoError ? &mut MonotonicClock {
    drop deadline
    return input.length
  }
  unsafe effect fn flush(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock { drop deadline return () }
  unsafe effect fn shutdown(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock { drop deadline return () }
  unsafe effect fn close(self: &mut Self) -> () ! ByteIoError {
    Shared.withMut(&self.state, recordCancellationClose)
    return ()
  }
}
impl ByteDuplex for ParkingDuplex {
  readSomeRaw: ParkingDuplex.read
  writeSomeRaw: ParkingDuplex.write
  flushRaw: ParkingDuplex.flush
  shutdownWriteRaw: ParkingDuplex.shutdown
  closeRaw: ParkingDuplex.close
}

struct DirectCancellationState {
  armed: bool
  closed: bool
  offers: usize
  completions: usize
  closes: usize
  laterIo: usize
  sequence: usize
  offerOrder: usize
  closeOrder: usize
  terminalOwner: bool
}

fn armDirectCancellation(state: &mut DirectCancellationState) -> () {
  state.armed = true
  return ()
}

fn recordDirectIo(state: &mut DirectCancellationState) -> () {
  if state.closed { state.laterIo = state.laterIo + usize.ONE }
  return ()
}

fn beginDirectWrite(state: &mut DirectCancellationState) -> bool {
  if state.closed { state.laterIo = state.laterIo + usize.ONE }
  if !state.armed || state.closed { return false }
  state.offers = state.offers + usize.ONE
  state.sequence = state.sequence + usize.ONE
  if state.offerOrder == usize.ZERO { state.offerOrder = state.sequence }
  return true
}

fn recordTerminalOwner(state: &mut DirectCancellationState) -> () {
  state.terminalOwner = true
  return ()
}

fn completeDirectWrite(state: &mut DirectCancellationState) -> () {
  state.completions = state.completions + usize.ONE
  return ()
}

fn closeDirectCancellation(state: &mut DirectCancellationState) -> () {
  state.closes = state.closes + usize.ONE
  state.sequence = state.sequence + usize.ONE
  if state.closeOrder == usize.ZERO { state.closeOrder = state.sequence }
  state.closed = true
  return ()
}

fn directCancellationResult(state: &mut DirectCancellationState) -> i32 {
  if state.offers != usize.ONE { return 71 }
  if state.completions != usize.ZERO { return 72 }
  if state.closes != usize.ONE { return 73 }
  if state.laterIo != usize.ZERO { return 74 }
  if state.offerOrder != usize.ONE || state.closeOrder != 2 { return 75 }
  if !state.terminalOwner { return 76 }
  return 42
}

struct DirectCancellationDuplex {
  inner: MemoryByteDuplex
  state: Shared<DirectCancellationState>
}

impl DirectCancellationDuplex {
  unsafe effect fn read(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.state, recordDirectIo)
    return run ByteDuplex.readSome(move output, move deadline)
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }

  unsafe effect fn write(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize ! ByteIoError ? &mut MonotonicClock {
    if Shared.withMut(&self.state, beginDirectWrite) {
      run MonotonicClock.waitUntil(SystemClock.make(200, 0))
      Shared.withMut(&self.state, completeDirectWrite)
    }
    return run ByteDuplex.writeSome(input, move deadline)
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }

  unsafe effect fn flush(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.state, recordDirectIo)
    return run ByteDuplex.flush(move deadline)
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }

  unsafe effect fn shutdown(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    Shared.withMut(&self.state, recordDirectIo)
    return run ByteDuplex.shutdownWrite(move deadline)
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }

  unsafe effect fn close(self: &mut Self) -> () ! ByteIoError {
    Shared.withMut(&self.state, closeDirectCancellation)
    return run ByteDuplex.close()
      |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }
}

impl ByteDuplex for DirectCancellationDuplex {
  readSomeRaw: DirectCancellationDuplex.read
  writeSomeRaw: DirectCancellationDuplex.write
  flushRaw: DirectCancellationDuplex.flush
  shutdownWriteRaw: DirectCancellationDuplex.shutdown
  closeRaw: DirectCancellationDuplex.close
}

struct CallbackFailure {code: i32}
`
    : ''
}

fn reference<'a>(bytes: &'a [u8]) -> ReferenceIdentity<'a> {
  let made = HttpsIdentity.reference(OriginHost<'a>.Dns {bytes: bytes})
  return match move made {
    Result<ReferenceIdentity<'a>, IdentityError>.Success {value} => value
    Result<ReferenceIdentity<'a>, IdentityError>.Failure {error} => {
      let invalid = 1 / 0
      return reference(bytes)
    }
  }
}

effect fn rootTrust() -> TrustSnapshot
! TrustSourceError | OutOfMemoryError
? &mut Allocator {
  let made = run TrustSnapshot.fromPem(${silkBytes(tlsClientRsaRootPem)}, TrustLoadLimits.defaults())
  return match move made {
    Result<TrustSnapshot, TrustSourceError>.Success {value} => move value
    Result<TrustSnapshot, TrustSourceError>.Failure {error} => { fail move error }
  }
}

effect fn preparedTrust(snapshot: &TrustSnapshot) -> TrustSnapshot
! TrustSourceError | OutOfMemoryError
? &mut Allocator {
  let limits = TrustLoadLimits.defaults()
  let copied = run TrustSnapshot.copy(&snapshot, limits.snapshot)
  return match move copied {
    Result<TrustSnapshot, TrustSourceError>.Success {value} => move value
    Result<TrustSnapshot, TrustSourceError>.Failure {error} => { fail move error }
  }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
  if needle.length > haystack.length { return false }
  let mut start = usize.ZERO
  while start <= haystack.length - needle.length {
    let mut equal = true
    let mut index = usize.ZERO
    while index < needle.length {
      if haystack[start + index] != needle[index] { equal = false }
      index = index + usize.ONE
    }
    if equal { return true }
    start = start + usize.ONE
  }
  return false
}

effect fn rawMemoryTransport(
  closeFailure: Option<i32>,
  peerClose: bool,
) -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let first = run Bytes.copy(${silkBytes(firstFlight)})
  let second = run Bytes.copy(${silkBytes(secondFlight)})
  let third = run Bytes.copy(${silkBytes(thirdFlight)})
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(100, 0),
    bytes: move first,
  })
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(100, 0),
    bytes: move second,
  })
  run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(100, 0),
    bytes: move third,
  })
  if peerClose {
    run Vector.append<MemoryReadEvent>(&mut reads, MemoryReadEvent.Data {
      readyAt: SystemClock.make(100, 0),
      bytes: run Bytes.copy(${silkBytes(tlsClientRsaServerCloseNotify)}),
    })
  }
  let mut writes = Vector.make<MemoryWriteEvent>()
  let mut index = usize.ZERO
  while index < 16 {
    let mut count: usize = 65535
    if index == usize.ZERO { count = usize.ONE }
    if index == usize.ONE { count = 2 }
    run Vector.append<MemoryWriteEvent>(&mut writes, MemoryWriteEvent {
      readyAt: SystemClock.make(100, 0),
      action: MemoryWriteAction.Accept {count: count},
    })
    index = index + usize.ONE
  }
  return run MemoryByteDuplex.make(move reads, move writes, 4096, 64, move closeFailure)
}

effect fn ownedMemoryTransport(
  closeFailure: Option<i32>,
  peerClose: bool,
  audit: Shared<OwnedMemoryAudit>,
) -> OwnedMemoryDuplex
! OutOfMemoryError
? &mut Allocator {
  let inner = run rawMemoryTransport(move closeFailure, peerClose)
  return OwnedMemoryDuplex {inner: move inner, audit: move audit}
}

${
  includeFailureCases
    ? `effect fn directCancellationTransport(
  state: Shared<DirectCancellationState>,
) -> DirectCancellationDuplex
! OutOfMemoryError
? &mut Allocator {
  let inner = run rawMemoryTransport(Option.none<i32>(), false)
  return DirectCancellationDuplex {inner: move inner, state: move state}
}

effect fn emptyTransport() -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let reads = Vector.make<MemoryReadEvent>()
  let mut writes = Vector.make<MemoryWriteEvent>()
  let mut index = usize.ZERO
  while index < 4 {
    run Vector.append<MemoryWriteEvent>(&mut writes, MemoryWriteEvent {
      readyAt: SystemClock.make(100, 0),
      action: MemoryWriteAction.Accept {count: 65535},
    })
    index = index + usize.ONE
  }
  return run MemoryByteDuplex.make(
    move reads,
    move writes,
    1024,
    16,
    Option.none<i32>(),
  )
}

effect fn ownedEmptyTransport(
  audit: Shared<OwnedMemoryAudit>,
) -> OwnedMemoryDuplex
! OutOfMemoryError
? &mut Allocator {
  let inner = run emptyTransport()
  return OwnedMemoryDuplex {inner: move inner, audit: move audit}
}
`
    : ''
}

fn observedTerminalClose(state: &OwnedMemoryAudit) -> bool {
  return state.closes == usize.ONE
    && state.underlyingCloseAttempts == usize.ONE
    && state.closed
    && state.closeLast
    && state.laterIo == usize.ZERO
}

fn observedSuccessfulScope(state: &OwnedMemoryAudit) -> i32 {
  if !(observedTerminalClose(state)) { return 1101 }
  if !(state.helloPrefix) { return 1102 }
  if !(state.applicationWrite) { return 1103 }
  if !(state.shortWritePrefix) { return 1104 }
  if !(state.shutdowns == usize.ONE) { return 1105 }
  if !(state.shutdownAfterFlush) { return 1106 }
  if !(state.reads >= 3) { return 1107 }
  if !(state.writes >= 2) { return 1108 }
  if !(state.flushes >= usize.ONE) { return 1109 }
  if !(state.handshakeReads == 3) { return 1110 }
  if !(state.handshakeWrites >= 3) { return 1111 }
  if !(state.handshakeFlushes >= usize.ONE) { return 1112 }
  if !(state.handshakeShutdowns == usize.ZERO) { return 1113 }
  if !(state.reads > state.handshakeReads) { return 1114 }
  if !(state.writes > state.handshakeWrites) { return 1115 }
  if !(state.flushes > state.handshakeFlushes) { return 1116 }
  if !(state.handshakeCalls == state.handshakeReads
      + state.handshakeWrites
      + state.handshakeFlushes) { return 1117 }
  if !(state.handshakeDeadlineConsistent) { return 1118 }
  if !(state.handshakeDeadlineSeconds == 130) { return 1119 }
  if !(state.handshakeDeadlineNanoseconds == 0) { return 1120 }
  return 0
}

${
  includeFailureCases
    ? `effect fn preparationFailureLeavesProvider() -> bool
! OutOfMemoryError
? &mut Allocator {
  let provider = run emptyTransport()
  let attempted = run TrustSnapshot.fromPem(b"", TrustLoadLimits.defaults())
  match move attempted {
    Result<TrustSnapshot, TrustSourceError>.Success {value} => {
      drop value
      return false
    }
    Result<TrustSnapshot, TrustSourceError>.Failure {error} => {
      drop error
    }
  }
  return MemoryByteDuplex.closeAttempts(&provider) == usize.ZERO
}
`
    : ''
}

fn validAuthentication<'a>(value: &Authentication<'a>) -> bool {
  return value.suite() == CipherSuite.ChaCha20Poly1305Sha256
    && value.group() == NamedGroup.X25519
    && value.anchorIndex() == usize.ZERO
    && value.sanIndex() == usize.ZERO
}

effect fn useAuthenticated(
  connection: &mut OwnedConnection<OwnedMemoryDuplex>,
) -> i32
! ConnectionError | OutOfMemoryError
? &mut MonotonicClock | &mut Allocator | &mut Random
{
  let authentication = OwnedConnection.authentication(&connection.*)
  match move authentication {
    Option.None => { return 1 }
    Option.Some {value} => { if !validAuthentication(&value) { return 2 } }
  }
  let mut plaintext: [u8; 40] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]
  let read = run OwnedConnection.readSome(&mut connection.*, &mut plaintext, Option.none<Instant>())
  let count = match move read {
    ReadTransfer.Data {count: transferred} => transferred
    ReadTransfer.End => { return 3 }
  }
  let expected = b"coalesced authenticated plaintext"
  if count != expected.length { return 4 }
  let mut index = usize.ZERO
  while index < count {
    if plaintext[index] != expected[index] { return 5 }
    index = index + usize.ONE
  }
  let written = run OwnedConnection.writeSome(&mut connection.*, &b"ping", Option.none<Instant>())
  if written != 4 { return 6 }
  run OwnedConnection.flush(&mut connection.*, Option.none<Instant>())
  run OwnedConnection.shutdownWrite(&mut connection.*, Option.none<Instant>())
  let ended = run OwnedConnection.readSome(&mut connection.*, &mut plaintext, Option.none<Instant>())
  match move ended {
    ReadTransfer.Data {count: unexpectedCount} => { drop unexpectedCount return 7 }
    ReadTransfer.End => {}
  }
  if OwnedConnection.phase(&connection.*) != ConnectionPhase.WriteShutdown { return 8 }
  run OwnedConnection.shutdownWrite(&mut connection.*, Option.none<Instant>())
  return 42
}

${
  includeFailureCases
    ? `effect fn expectTruncation(
  connection: &mut OwnedConnection<OwnedMemoryDuplex>,
) -> i32
! ConnectionError | OutOfMemoryError
? &mut MonotonicClock | &mut Allocator | &mut Random
{
  let mut plaintext: [u8; 40] = [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ]
  let first = run OwnedConnection.readSome(&mut connection.*, &mut plaintext, Option.none<Instant>())
  match move first {
    ReadTransfer.Data {count} => { if count != b"coalesced authenticated plaintext".length { return 1 } }
    ReadTransfer.End => { return 2 }
  }
  let truncated = run Effect.result(
    OwnedConnection.readSome(&mut connection.*, &mut plaintext, Option.none<Instant>())
  )
  match move truncated {
    Result<ReadTransfer, ConnectionError | OutOfMemoryError>.Success {value} => { return 3 }
    Result<ReadTransfer, ConnectionError | OutOfMemoryError>.Failure {error} => match move error {
      ConnectionError.Tls {error: tlsError} => match move tlsError {
        TlsError.Truncated => {}
        _ => { return 4 }
      }
      _ => { return 5 }
    }
  }
  if OwnedConnection.phase(&connection.*) != ConnectionPhase.Closed { return 6 }
  let mut empty: [u8; 0] = []
  let later = run Effect.result(
    OwnedConnection.readSome(&mut connection.*, &mut empty, Option.none<Instant>())
  )
  match move later {
    Result<ReadTransfer, ConnectionError | OutOfMemoryError>.Success {value} => { return 7 }
    Result<ReadTransfer, ConnectionError | OutOfMemoryError>.Failure {error} => match move error {
      ConnectionError.Io {error: ByteIoError.Closed {operation}} => {}
      _ => { return 8 }
    }
  }
  return 42
}

effect fn failAuthenticated(
  connection: &mut OwnedConnection<OwnedMemoryDuplex>,
) -> i32
! CallbackFailure {
  match move OwnedConnection.authentication(&connection.*) {
    Option.None => { return 1 }
    Option.Some {value} => { drop value }
  }
  fail CallbackFailure {code: 77}
}

effect fn shouldNotRunMemory(
  connection: &mut OwnedConnection<OwnedMemoryDuplex>,
) -> i32 ? &mut CallbackAudit {
  drop connection
  run CallbackAudit.invoked()
  return 1
}

effect fn shouldNotRunParking(
  connection: &mut OwnedConnection<ParkingDuplex>,
) -> i32 ? &mut CallbackAudit {
  drop connection
  run CallbackAudit.invoked()
  return 1
}

effect fn shouldNotRunTimeout(
  connection: &mut OwnedConnection<TimeoutDuplex>,
) -> i32 ? &mut CallbackAudit {
  drop connection
  run CallbackAudit.invoked()
  return 1
}

effect fn timeoutDeadlineCase(
  config: &ClientConfig,
  trust: &TrustSnapshot,
  random: &mut ScriptedRandom,
  external: Option<Instant>,
  expectedSeconds: i64,
  expectTransport: bool,
) -> bool
! TrustSourceError | OutOfMemoryError
? &mut SystemClock | &mut MonotonicClock | &mut Allocator {
  let audit = run Shared.make<DeadlineAudit>(DeadlineAudit {
    writes: usize.ZERO,
    flushes: usize.ZERO,
    closes: usize.ZERO,
    deadlineCalls: usize.ZERO,
    deadlineConsistent: true,
    deadlineSeconds: 0,
    deadlineNanoseconds: 0,
  })
  let timeout = TimeoutDuplex {audit: Shared.clone(&audit)}
  let timeoutTrust = run preparedTrust(trust)
  let mut callbacks = CallbackCounter {calls: usize.ZERO}
  let timed = run Effect.result(withClient<i32, never>(
    move timeout,
    config,
    move timeoutTrust,
    ConnectionOptions {
      handshakeTimeoutNanoseconds: u64.toU64(30000000000),
      externalDeadline: move external,
    },
    shouldNotRunTimeout,
  )
    |> Effect.provideMut<CallbackAudit>(&mut callbacks)
    |> Effect.provideMut<Random>(&mut random.*))
  let rejected = match move timed {
    Result<i32, ConnectionError | OutOfMemoryError>.Success {value} => {
      drop value
      return false
    }
    Result<i32, ConnectionError | OutOfMemoryError>.Failure {error} => match move error {
      ConnectionError.HandshakeTimeout => true
      _ => false
    }
  }
  if !rejected || callbacks.calls != usize.ZERO { return false }
  return Shared.with(&audit, fn(state: &DeadlineAudit) -> bool {
    if state.closes != usize.ONE { return false }
    if !expectTransport {
      return state.writes == usize.ZERO && state.flushes == usize.ZERO
    }
    return state.writes > usize.ZERO
      && state.flushes == usize.ONE
      && state.deadlineCalls == state.writes + state.flushes
      && state.deadlineConsistent
      && state.deadlineSeconds == expectedSeconds
      && state.deadlineNanoseconds == 0
  })
}

effect fn postReadBoundaryCase(
  config: &ClientConfig,
  trust: &TrustSnapshot,
  random: &mut ScriptedRandom,
  result: PostReadResult,
) -> bool
! TrustSourceError | OutOfMemoryError
? &mut SystemClock | &mut Allocator {
  let state = run Shared.make<PostReadState>(PostReadState {
    readReturned: false,
    reads: usize.ZERO,
    writes: usize.ZERO,
    flushes: usize.ZERO,
    closes: usize.ZERO,
  })
  let transport = PostReadDuplex {result: result, state: Shared.clone(&state)}
  let snapshot = run preparedTrust(trust)
  let mut clock = PostReadClock {state: Shared.clone(&state)}
  let attempted = run Effect.result(
    authenticateOwned<PostReadDuplex>(
      move transport,
      config,
      move snapshot,
      ConnectionOptions.defaults(),
    )
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Random>(&mut random.*)
  )
  let expected = match move attempted {
    Result<OwnedConnection<PostReadDuplex>, ConnectionError | OutOfMemoryError>.Success {value} => {
      drop value
      return false
    }
    Result<OwnedConnection<PostReadDuplex>, ConnectionError | OutOfMemoryError>.Failure {error} => match move error {
      ConnectionError.HandshakeTimeout => result == PostReadResult.Data
      ConnectionError.Io {error: ByteIoError.InvalidTransferCount {operation, count, limit}} =>
        result == PostReadResult.InvalidCount
          && operation == ByteIoOperation.Read
          && count == 16385
          && limit == 16384
      _ => false
    }
  }
  if !expected { return false }
  return Shared.with(&state, fn(observed: &PostReadState) -> bool {
    return observed.readReturned
      && observed.reads == usize.ONE
      && observed.writes > usize.ZERO
      && observed.flushes > usize.ZERO
      && observed.closes == usize.ONE
  })
}

effect fn canceledConnection(state: Shared<CancellationState>) -> i32
! ConnectionError | TrustSourceError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let snapshot = run rootTrust()
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut wall = FixedWallClock {calls: usize.ZERO}
  let mut monotonic = ParkingClock {}
  let mut random = ScriptedRandom {filled: usize.ZERO}
  let mut callbacks = SharedCallbackCounter {state: Shared.clone(&state)}
  let transport = ParkingDuplex {state: move state}
  let host = b"ExAmPlE.com"
  let config = ClientConfig {
    reference: reference(&host),
    alpn: AlpnConfig.defaults(),
    limits: ClientLimits.defaults(),
  }
  return run withClient<i32, never>(
    move transport,
    &config,
    move snapshot,
    ConnectionOptions.defaults(),
    shouldNotRunParking,
  )
    |> Effect.provideMut<CallbackAudit>(&mut callbacks)
    |> Effect.provideMut<SystemClock>(&mut wall)
    |> Effect.provideMut<MonotonicClock>(&mut monotonic)
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<Allocator>(&mut allocator)
}

fn cancellationReady(state: &()) -> () { return () }
fn cancellationComplete(state: &mut (), value: i32) -> () { drop value return () }
fn cancellationParked(state: &mut (), execution: Intrinsic.Execution<i32>) -> () {
  drop move execution
  return ()
}
effect<'env> fn cancellationFailed<E: 'env, 'env>(error: E) -> i32 { drop error return -4 }

effect fn pendingDirectWrite(
  owner: &mut OwnedConnection<DirectCancellationDuplex>,
) -> i32 ! ConnectionError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = ParkingClock {}
  let mut random = ScriptedRandom {filled: usize.ZERO}
  let written = run OwnedConnection.writeSome(&mut owner.*, &b"ambiguous", Option.none<Instant>())
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<Allocator>(&mut allocator)
  return usize.toI32(written)
}

fn isClosedFailure<A>(
  result: Result<A, ConnectionError | OutOfMemoryError>,
  expected: ByteIoOperation,
) -> bool {
  return match move result {
    Result<A, ConnectionError | OutOfMemoryError>.Success {value} => {
      drop value
      return false
    }
    Result<A, ConnectionError | OutOfMemoryError>.Failure {error} => match move error {
      ConnectionError.Io {error: ByteIoError.Closed {operation}} => operation == expected
      _ => false
    }
  }
}

effect fn rejectsLaterDirectIo<P>(
  owner: &mut OwnedConnection<P>,
) -> bool
where &mut P provides &ByteDuplex from &mut ByteDuplex,
  &mut P provides &ByteDuplex from &mut ByteDuplex
    | &mut MonotonicClock
    | &mut Allocator
    | &mut Random {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = VirtualClock {
    mark: SystemClock.make(100, 0),
    nowCalls: usize.ZERO,
    waitCalls: usize.ZERO,
  }
  let mut random = ScriptedRandom {filled: usize.ZERO}
  let mut empty: [u8; 0] = []
  let mut output: [u8; 1] = [0]
  let emptyRead = run Effect.result(
    OwnedConnection.readSome(&mut owner.*, &mut empty, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Random>(&mut random)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !isClosedFailure<ReadTransfer>(move emptyRead, ByteIoOperation.Read) { return false }
  let read = run Effect.result(
    OwnedConnection.readSome(&mut owner.*, &mut output, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Random>(&mut random)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !isClosedFailure<ReadTransfer>(move read, ByteIoOperation.Read) { return false }
  let emptyWrite = run Effect.result(
    OwnedConnection.writeSome(&mut owner.*, &b"", Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Random>(&mut random)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !isClosedFailure<usize>(move emptyWrite, ByteIoOperation.Write) { return false }
  let write = run Effect.result(
    OwnedConnection.writeSome(&mut owner.*, &b"x", Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Random>(&mut random)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !isClosedFailure<usize>(move write, ByteIoOperation.Write) { return false }
  let flushed = run Effect.result(
    OwnedConnection.flush(&mut owner.*, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Random>(&mut random)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !isClosedFailure<()>(move flushed, ByteIoOperation.Flush) { return false }
  let shutdown = run Effect.result(
    OwnedConnection.shutdownWrite(&mut owner.*, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Random>(&mut random)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  return isClosedFailure<()>(move shutdown, ByteIoOperation.ShutdownWrite)
}

struct DirectOwnedLease {
  owner: OwnedConnection<DirectCancellationDuplex>
  state: Shared<DirectCancellationState>
}

effect fn useDirectOwner(lease: &mut DirectOwnedLease) -> i32
! ConnectionError | OutOfMemoryError {
  return run pendingDirectWrite(&mut lease.owner)
}

effect fn releaseDirectOwner(lease: &mut DirectOwnedLease) -> () {
  if OwnedConnection.phase(&lease.owner) == ConnectionPhase.Closed
    && run rejectsLaterDirectIo<DirectCancellationDuplex>(&mut lease.owner) {
    Shared.withMut(&lease.state, recordTerminalOwner)
  }
  return ()
}

effect fn parkedDirectOwner(
  owner: OwnedConnection<DirectCancellationDuplex>,
  state: Shared<DirectCancellationState>,
) -> i32 ! ConnectionError | OutOfMemoryError {
  let lease = DirectOwnedLease {owner: move owner, state: move state}
  return run Effect.useReleaseNonParking(move lease, useDirectOwner, releaseDirectOwner)
}

effect fn cancelDirectOwned(
  config: &ClientConfig,
  trust: &TrustSnapshot,
  random: &mut ScriptedRandom,
) -> i32
! ConnectionError | TrustSourceError | OutOfMemoryError
? &mut SystemClock | &mut MonotonicClock | &mut Allocator {
  let state = run Shared.make<DirectCancellationState>(DirectCancellationState {
    armed: false,
    closed: false,
    offers: usize.ZERO,
    completions: usize.ZERO,
    closes: usize.ZERO,
    laterIo: usize.ZERO,
    sequence: usize.ZERO,
    offerOrder: usize.ZERO,
    closeOrder: usize.ZERO,
    terminalOwner: false,
  })
  let transport = run directCancellationTransport(Shared.clone(&state))
  let snapshot = run preparedTrust(trust)
  let mut owner = run authenticateOwned<DirectCancellationDuplex>(
    move transport,
    config,
    move snapshot,
    ConnectionOptions.defaults(),
  ) |> Effect.provideMut<Random>(&mut random.*)
  Shared.withMut(&state, armDirectCancellation)
  let body = Effect.catchAll(
    parkedDirectOwner(move owner, Shared.clone(&state)),
    cancellationFailed,
  )
  let execution = run Execution.make(move body, (), cancellationReady)
  let mut branch = ()
  run Execution.drive(move execution, &mut branch, cancellationComplete, cancellationParked)
  return Shared.withMut(&state, directCancellationResult)
}

effect fn postFinishedDeadline(
  config: &ClientConfig,
  trust: &TrustSnapshot,
  random: &mut ScriptedRandom,
) -> bool
! ConnectionError | TrustSourceError | OutOfMemoryError
? &mut SystemClock | &mut Allocator {
  let countingState = run Shared.make<DirectCancellationState>(DirectCancellationState {
    armed: false,
    closed: false,
    offers: usize.ZERO,
    completions: usize.ZERO,
    closes: usize.ZERO,
    laterIo: usize.ZERO,
    sequence: usize.ZERO,
    offerOrder: usize.ZERO,
    closeOrder: usize.ZERO,
    terminalOwner: false,
  })
  let countingTransport = run directCancellationTransport(Shared.clone(&countingState))
  let countingTrust = run preparedTrust(trust)
  let mut countingClock = SequencedDeadlineClock {
    calls: usize.ZERO,
    expireAt: usize.MAX,
  }
  let mut owner = run authenticateOwned<DirectCancellationDuplex>(
    move countingTransport,
    config,
    move countingTrust,
    ConnectionOptions.defaults(),
  )
    |> Effect.provideMut<MonotonicClock>(&mut countingClock)
    |> Effect.provideMut<Random>(&mut random.*)
  let finalCheck = countingClock.calls
  let closed = run Effect.result(OwnedConnection.close(&mut owner))
  match move closed {
    Result<(), ConnectionError>.Success {value} => { drop value }
    Result<(), ConnectionError>.Failure {error} => { drop error return false }
  }
  if !(run rejectsLaterDirectIo<DirectCancellationDuplex>(&mut owner)) { return false }
  let rejectedBeforeProvider = Shared.with(
    &countingState,
    fn(state: &DirectCancellationState) -> bool {
      return state.closes == usize.ONE && state.laterIo == usize.ZERO
    },
  )
  if !rejectedBeforeProvider { return false }
  if finalCheck <= usize.ONE { return false }

  random.filled = usize.ZERO
  let expiringState = run Shared.make<DirectCancellationState>(DirectCancellationState {
    armed: false,
    closed: false,
    offers: usize.ZERO,
    completions: usize.ZERO,
    closes: usize.ZERO,
    laterIo: usize.ZERO,
    sequence: usize.ZERO,
    offerOrder: usize.ZERO,
    closeOrder: usize.ZERO,
    terminalOwner: false,
  })
  let expiringTransport = run directCancellationTransport(Shared.clone(&expiringState))
  let expiringTrust = run preparedTrust(trust)
  let mut expiringClock = SequencedDeadlineClock {
    calls: usize.ZERO,
    expireAt: finalCheck,
  }
  let attempted = run Effect.result(
    authenticateOwned<DirectCancellationDuplex>(
      move expiringTransport,
      config,
      move expiringTrust,
      ConnectionOptions.defaults(),
    )
      |> Effect.provideMut<MonotonicClock>(&mut expiringClock)
      |> Effect.provideMut<Random>(&mut random.*)
  )
  let timedOut = match move attempted {
    Result<OwnedConnection<DirectCancellationDuplex>, ConnectionError | OutOfMemoryError>.Success {value} => {
      drop value
      return false
    }
    Result<OwnedConnection<DirectCancellationDuplex>, ConnectionError | OutOfMemoryError>.Failure {error} => match move error {
      ConnectionError.HandshakeTimeout => true
      _ => false
    }
  }
  if !timedOut || expiringClock.calls != finalCheck { return false }
  return Shared.with(&expiringState, fn(state: &DirectCancellationState) -> bool {
    return state.closes == usize.ONE
      && state.offers == usize.ZERO
      && state.completions == usize.ZERO
      && state.laterIo == usize.ZERO
  })
}

effect fn directCloseFailure(
  config: &ClientConfig,
  trust: &TrustSnapshot,
  random: &mut ScriptedRandom,
) -> bool
! ConnectionError | TrustSourceError | OutOfMemoryError
? &mut SystemClock | &mut MonotonicClock | &mut Allocator {
  let audit = run Shared.make<OwnedMemoryAudit>(freshOwnedMemoryAudit())
  let transport = run ownedMemoryTransport(
    Option.some<i32>(91),
    false,
    Shared.clone(&audit),
  )
  let snapshot = run preparedTrust(trust)
  let mut owner = run authenticateOwned<OwnedMemoryDuplex>(
    move transport,
    config,
    move snapshot,
    ConnectionOptions.defaults(),
  ) |> Effect.provideMut<Random>(&mut random.*)
  let first = run Effect.result(OwnedConnection.close(&mut owner))
  match move first {
    Result<(), ConnectionError>.Success {value} => { drop value return false }
    Result<(), ConnectionError>.Failure {error} => match move error {
      ConnectionError.Io {error: ByteIoError.Provider {operation, code}} => {
        if operation != ByteIoOperation.Close || code != 91 { return false }
      }
      _ => { return false }
    }
  }
  if OwnedConnection.phase(&owner) != ConnectionPhase.Closed { return false }
  let repeated = run Effect.result(OwnedConnection.close(&mut owner))
  match move repeated {
    Result<(), ConnectionError>.Success {value} => { drop value }
    Result<(), ConnectionError>.Failure {error} => { drop error return false }
  }
  if !(run rejectsLaterDirectIo<OwnedMemoryDuplex>(&mut owner)) { return false }
  return Shared.with(&audit, observedTerminalClose)
}

effect fn cancelSuspendedConnection() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let state = run Shared.make<CancellationState>(CancellationState {
    closes: usize.ZERO,
    callbacks: usize.ZERO,
  }) |> Effect.provideMut<Allocator>(&mut allocator)
  let body = Effect.catchAll(
    canceledConnection(Shared.clone(&state)),
    cancellationFailed,
  )
  let execution = run Execution.make(
    move body,
    (),
    cancellationReady,
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut branch = ()
  run Execution.drive(move execution, &mut branch, cancellationComplete, cancellationParked)
  return Shared.withMut(&state, cancellationResult)
}
`
    : ''
}

effect fn runCases(
  config: &ClientConfig,
  trust: &TrustSnapshot,
  random: &mut ScriptedRandom,
) -> i32
! ConnectionError | TrustSourceError | OutOfMemoryError
? &mut SystemClock
  | &mut MonotonicClock
  | &mut Allocator {
  let successAudit = run Shared.make<OwnedMemoryAudit>(freshOwnedMemoryAudit())
  let success = run ownedMemoryTransport(
    Option.none<i32>(),
    true,
    Shared.clone(&successAudit),
  )
  let successTrust = run preparedTrust(trust)
  let attempted = run Effect.result(withClient<i32, ConnectionError | OutOfMemoryError>(
    move success,
    config,
    move successTrust,
    ConnectionOptions.defaults(),
    useAuthenticated,
  ) |> Effect.provideMut<Random>(&mut random.*))
  let completed = match move attempted {
    Result<i32, ConnectionError | OutOfMemoryError>.Success {value} => value
    Result<i32, ConnectionError | OutOfMemoryError>.Failure {error} => { return run failed(move error) }
  }
  if completed != 42 { return 1000 + completed }
  let auditResult = Shared.with(&successAudit, observedSuccessfulScope)
  if auditResult != 0 { return auditResult }

${
  includeFailureCases
    ? `  if !(run preparationFailureLeavesProvider()) { return 19 }
  random.filled = usize.ZERO
  let failingAudit = run Shared.make<OwnedMemoryAudit>(freshOwnedMemoryAudit())
  let failing = run ownedMemoryTransport(
    Option.some<i32>(91),
    false,
    Shared.clone(&failingAudit),
  )
  let failingTrust = run preparedTrust(trust)
  let failed = run Effect.result(withClient<i32, CallbackFailure>(
    move failing,
    config,
    move failingTrust,
    ConnectionOptions.defaults(),
    failAuthenticated,
  ) |> Effect.provideMut<Random>(&mut random.*))
  match move failed {
    Result<i32, CallbackFailure | ConnectionError | OutOfMemoryError>.Success {value} => {
      return 20
    }
    Result<i32, CallbackFailure | ConnectionError | OutOfMemoryError>.Failure {error} => {
      match move error {
        CallbackFailure {code} => { if code != 77 { return 21 } }
        _ => { return 22 }
      }
    }
  }
  if !Shared.with(&failingAudit, observedTerminalClose) { return 23 }
  random.filled = usize.ZERO
  let truncatedAudit = run Shared.make<OwnedMemoryAudit>(freshOwnedMemoryAudit())
  let truncated = run ownedMemoryTransport(
    Option.none<i32>(),
    false,
    Shared.clone(&truncatedAudit),
  )
  let truncatedTrust = run preparedTrust(trust)
  let truncation = run withClient<i32, ConnectionError | OutOfMemoryError>(
    move truncated,
    config,
    move truncatedTrust,
    ConnectionOptions.defaults(),
    expectTruncation,
  ) |> Effect.provideMut<Random>(&mut random.*)
  if truncation != 42 { return 25 }
  if !Shared.with(&truncatedAudit, observedTerminalClose) { return 26 }
  random.filled = usize.ZERO
  let endedAudit = run Shared.make<OwnedMemoryAudit>(freshOwnedMemoryAudit())
  let ended = run ownedEmptyTransport(Shared.clone(&endedAudit))
  let endedTrust = run preparedTrust(trust)
  let mut endedCallbacks = CallbackCounter {calls: usize.ZERO}
  let handshakeEnd = run Effect.result(withClient<i32, never>(
    move ended,
    config,
    move endedTrust,
    ConnectionOptions.defaults(),
    shouldNotRunMemory,
  )
    |> Effect.provideMut<CallbackAudit>(&mut endedCallbacks)
    |> Effect.provideMut<Random>(&mut random.*))
  match move handshakeEnd {
    Result<i32, ConnectionError | OutOfMemoryError>.Success {value} => {
      return 27
    }
    Result<i32, ConnectionError | OutOfMemoryError>.Failure {error} => {
      match move error {
        ConnectionError.Tls {error: tlsError} => match move tlsError {
          TlsError.HandshakeTruncated => {}
          _ => { return 28 }
        }
        _ => { return 29 }
      }
    }
  }
  if endedCallbacks.calls != usize.ZERO { return 30 }
  if !Shared.with(&endedAudit, observedTerminalClose) { return 31 }
  random.filled = usize.ZERO
  if !(run timeoutDeadlineCase(
    config,
    trust,
    &mut random.*,
    Option.none<Instant>(),
    130,
    true,
  )) { return 32 }
  random.filled = usize.ZERO
  if !(run timeoutDeadlineCase(
    config,
    trust,
    &mut random.*,
    Option.some<Instant>(SystemClock.make(105, 0)),
    105,
    true,
  )) { return 33 }
  random.filled = usize.ZERO
  if !(run timeoutDeadlineCase(
    config,
    trust,
    &mut random.*,
    Option.some<Instant>(SystemClock.make(140, 0)),
    130,
    true,
  )) { return 34 }
  random.filled = usize.ZERO
  if !(run timeoutDeadlineCase(
    config,
    trust,
    &mut random.*,
    Option.some<Instant>(SystemClock.make(99, 0)),
    99,
    false,
  )) { return 35 }
  random.filled = usize.ZERO
  if !(run postReadBoundaryCase(
    config,
    trust,
    &mut random.*,
    PostReadResult.Data,
  )) { return 36 }
  random.filled = usize.ZERO
  if !(run postReadBoundaryCase(
    config,
    trust,
    &mut random.*,
    PostReadResult.InvalidCount,
  )) { return 3600 }
  let canceled = run cancelSuspendedConnection()
  if canceled != 42 { return 37 }
  random.filled = usize.ZERO
  let directCanceled = run cancelDirectOwned(config, trust, &mut random.*)
  if directCanceled != 42 { return 3800 + directCanceled }
  random.filled = usize.ZERO
  if !(run postFinishedDeadline(config, trust, &mut random.*)) { return 39 }
  random.filled = usize.ZERO
  if !(run directCloseFailure(config, trust, &mut random.*)) { return 40 }
`
    : ''
}  return 42
}

effect fn failed(error: ConnectionError | TrustSourceError | OutOfMemoryError) -> i32 {
  match move error {
    ConnectionError.HandshakeTimeout => { return -100 }
    ConnectionError.Io {error: io} => match move io {
      ByteIoError.Timeout {operation} => { return -201 }
      ByteIoError.InvalidTransferCount {operation, count, limit} => { return -202 }
      ByteIoError.Closed {operation} => match operation {
        ByteIoOperation.Read => { return -2031 }
        ByteIoOperation.Write => { return -2032 }
        ByteIoOperation.Flush => { return -2033 }
        ByteIoOperation.ShutdownWrite => { return -2034 }
        ByteIoOperation.Close => { return -2035 }
      }
      ByteIoError.Provider {operation, code} => { return -300 - code }
    }
    ConnectionError.Tls {error: tlsError} => match move tlsError {
      TlsError.PeerAlert {code} => { return -101 }
      TlsError.BadRecordMac => { return -102 }
      TlsError.ProtocolViolation {reason} => { return -103 }
      TlsError.CertificateDecode {error: detail} => { return -104 }
      TlsError.CertificatePath {error: detail} => { return -105 }
      TlsError.CertificateIdentity {error: detail} => { return -106 }
      TlsError.CertificateVerify {error: detail} => { return -107 }
      TlsError.Finished => { return -108 }
      TlsError.UnsupportedProfile => { return -109 }
      TlsError.LimitExceeded {kind, limit} => { return -110 }
      TlsError.InvalidState {operation} => { return -111 }
      TlsError.EmptyBuffer => { return -112 }
      TlsError.HandshakeTruncated => { return -113 }
      TlsError.Truncated => { return -114 }
      TlsError.NoApplicationProtocol => { return -115 }
    }
    OutOfMemoryError {} => { return -901 }
    _ => { return -902 }
  }
}

effect fn program() -> i32 ! TrustSourceError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let snapshot = run rootTrust()
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut wall = FixedWallClock {calls: usize.ZERO}
  let mut monotonic = VirtualClock {
    mark: SystemClock.make(100, 0),
    nowCalls: usize.ZERO,
    waitCalls: usize.ZERO,
  }
  let mut random = ScriptedRandom {filled: usize.ZERO}
  let host = b"ExAmPlE.com"
  let config = ClientConfig {
    reference: reference(&host),
    alpn: AlpnConfig.defaults(),
    limits: ClientLimits.defaults(),
  }
  let result = run Effect.catchAll(
    runCases(&config, &snapshot, &mut random)
      |> Effect.provideMut<SystemClock>(&mut wall)
      |> Effect.provideMut<MonotonicClock>(&mut monotonic)
      |> Effect.provideMut<Allocator>(&mut allocator),
    failed,
  )
  if result != 42 { return result }
  if wall.calls != ${includeFailureCases ? 14 : 1} { return -2 }
  return 42
}

effect fn startupFailed(error: TrustSourceError | OutOfMemoryError) -> i32 {
  match move error {
    OutOfMemoryError {} => { return -903 }
    _ => { return -904 }
  }
}

pub fn main() -> i32 {
  return run Effect.catchAll(program(), startupFailed)
}`

/** Full target-neutral behavior and structured-cancellation matrix for the native corpus. */
export const tlsConnectionAcceptanceSource = connectionSource(true)

/** One authenticated exchange, application I/O, and terminal release through LLVM-to-Wasm. */
export const tlsConnectionWasmSource = connectionSource(false)
