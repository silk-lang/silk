/** Native ownership oracles: borrowed captures and exact-once release of a canceled client execution. */
export const httpClientOwnershipAcceptanceSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ByteDuplex, ReadTransfer}
import silk.effect {Effect}
import silk.execution { Execution, Wake }
import silk.shared {Shared}
import silk.http {Method, Version, Header}
import silk.http_body {Limits as BodyLimits}
import silk.http_head {Limits as HeadLimits}
import silk.http_headers {Headers, Limits as ValueLimits}
import silk.http_origin {Origin}
import silk.http_request {PreparedRequest, HeaderPolicy, BodyMode, RequestError}
import silk.http_request as Request
import silk.http_client {
  Connection,
  ConnectionHandler,
  Exchange,
  Limits,
  ClientError,
  RequestOptions,
}
import silk.http_client as Client
import silk.http_transport {HttpTransport, TransportError, Loan}
import silk.memory_byte_duplex {
  MemoryByteDuplex,
  MemoryByteDuplexPhase,
  MemoryReadEvent,
  MemoryWriteEvent,
}
import silk.monotonic_clock {MonotonicClock}
import silk.random {Random}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.uri {Uri}
import silk.u64
import silk.usize
import silk.vector {Vector}

struct FixedClock {
  mark: Instant
}

struct FixedRandom {}

impl Random for FixedRandom {
  effect fn fillBytes(self: &mut Self, output: &mut [u8]) -> () {
    drop output
    return ()
  }
}

impl MonotonicClock for FixedClock {
  effect fn now(self: &mut Self) -> Instant {
    return SystemClock.make(SystemClock.seconds(&self.mark), SystemClock.nanoseconds(&self.mark))
  }
  effect fn getResolution(self: &mut Self) -> u64 {
    return u64.toU64(1)
  }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () {
    self.mark = move when
    return ()
  }
  effect fn waitFor(self: &mut Self, duration: u64) -> () {
    self.mark = MonotonicClock.deadlineAfter(&self.mark, duration)
    return ()
  }
}

fn valueLimits() -> ValueLimits {
  return ValueLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 128,
    maxNameBytes: 64,
    maxValueBytes: 256,
    maxFields: 12,
    maxFieldBytes: 512,
    maxOwnedBytes: 2048,
  }
}

fn headLimits() -> HeadLimits {
  return HeadLimits {
    maxHeadBytes: 1024,
    maxStartLineBytes: 256,
    maxFieldLineBytes: 256,
    maxOwnedBytes: 2048,
    values: valueLimits(),
  }
}

fn bodyLimits() -> BodyLimits {
  return BodyLimits {
    maxWireBytes: 1024,
    maxPayloadBytes: 512,
    maxChunkBytes: 64,
    maxChunks: 8,
    maxChunkLineBytes: 64,
    maxExtensionBytes: 128,
    maxTrailerBytes: 256,
    maxTrailerFields: 4,
    maxOwnedBytes: 2048,
    trailerValues: valueLimits(),
  }
}

effect fn providerFor() -> MemoryByteDuplex ! OutOfMemoryError ? &mut Allocator {
  return run MemoryByteDuplex.make(Vector.make<MemoryReadEvent>(), Vector.make<MemoryWriteEvent>(), 256, 8, Option.none<i32>())
}

fn limits() -> Limits {
  return Limits {
    head: headLimits(),
    requestBody: bodyLimits(),
    responseBody: bodyLimits(),
    readCapacity: 128,
    writeCapacity: 128,
    maxRequests: 2,
    maxInformationalResponses: 16,
    maxInformationalWireBytes: 65536,
    maxDiscardWireBytes: 256,
  }
}

struct CancellationAudit {
  drops: usize
  closes: usize
}

struct TestTransport {
  memory: MemoryByteDuplex
  audit: Shared<CancellationAudit>
}


impl Drop for TestTransport {
  fn drop(self: &mut TestTransport) -> () {
    let closes = MemoryByteDuplex.closeAttempts(&self.memory)
    let record = fn(audit: &mut CancellationAudit) -> () {
      audit.drops = audit.drops + usize.ONE
      audit.closes = closes
      return ()
    }
    Shared.withMut<CancellationAudit, ()>(&self.audit, move record)
    return ()
  }
}

impl HttpTransport for TestTransport {
  effect fn readSomeRaw(self: &mut Self, output: &mut [u8], deadline: Option<Instant>) -> ReadTransfer
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    let result = run Effect.result(ByteDuplex.readSome(&mut output, move deadline))
      |> Effect.provideMut<ByteDuplex>(&mut self.memory)
    return match move result {
      Result.Success {value} => move value
      Result.Failure {error} => {
        fail TransportError.Plain {error: move error}
      }
    }
  }
  effect fn writeSomeRaw(self: &mut Self, input: &[u8], deadline: Option<Instant>) -> usize
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    let result = run Effect.result(ByteDuplex.writeSome(input, move deadline))
      |> Effect.provideMut<ByteDuplex>(&mut self.memory)
    return match move result {
      Result.Success {value} => value
      Result.Failure {error} => {
        fail TransportError.Plain {error: move error}
      }
    }
  }
  effect fn flush(self: &mut Self, deadline: Option<Instant>) -> ()
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    let result = run Effect.result(ByteDuplex.flush(move deadline))
      |> Effect.provideMut<ByteDuplex>(&mut self.memory)
    return match move result {
      Result.Success {value} => value
      Result.Failure {error} => {
        fail TransportError.Plain {error: move error}
      }
    }
  }
  effect fn close(self: &mut Self) -> () ! TransportError {
    let result = run Effect.result(ByteDuplex.close())
      |> Effect.provideMut<ByteDuplex>(&mut self.memory)
    return match move result {
      Result.Success {value} => value
      Result.Failure {error} => {
        fail TransportError.Plain {error: move error}
      }
    }
  }
}

struct CancellationWake {
  wake: Wake
}

fn retainCancellationWake(wake: Wake) -> CancellationWake {
  return CancellationWake {wake: move wake}
}

effect<'call> fn canceledExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 {
  drop exchangeValue
  run Execution.park(retainCancellationWake)
  return 121
}

fn cancellationReady(state: &()) -> () {
  return ()
}

fn cancellationComplete(state: &mut i32, value: i32) -> () {
  state.* = value
  return ()
}

fn cancellationParked(state: &mut i32, execution: Intrinsic.Execution<i32>) -> () {
  drop move execution
  state.* = 42
  return ()
}

fn cancellationAuditResult(audit: &CancellationAudit) -> i32 {
  if audit.drops != usize.ONE {
    return 122
  }
  if audit.closes != usize.ONE {
    return 123
  }
  return 0
}

struct CancellationHandler {
  request: PreparedRequest
}

impl ConnectionHandler<TestTransport, i32, ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random> for CancellationHandler {
  effect<'call> fn handle<'call>(handler: Self, connection: &'call mut Connection<TestTransport>) -> i32
  ! ClientError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock | &mut Random {
    let CancellationHandler {request} = move handler
    return run Client.withExchange(
      &mut connection.*,
      &request,
      RequestOptions.defaults(),
      canceledExchange,
    )
  }
}

effect fn cancellationBody(audit: Shared<CancellationAudit>) -> i32
! ClientError | RequestError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {mark: SystemClock.make(0, 0)}
  let mut random = FixedRandom {}
  let uri = match move Uri.parse("http://example.test/") {
    Result.Failure {error} => {
      drop error
      return 31
    }
    Result.Success {value} => value
  }
  let origin = match move Origin.fromUri(&uri) {
    Result.Failure {error} => {
      drop error
      return 33
    }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => {
      drop error
      return 32
    }
    Result.Success {value} => value
  }
  let policy = HeaderPolicy.defaults()
  let request = run Request.fromUri(
    &uri,
    Version.Http11,
    Method.get(),
    &headers,
    &policy,
    BodyMode.Empty,
    false,
    valueLimits(),
    1024,
    512,
  )
    |> Effect.provideMut<Allocator>(&mut allocator)
  let memory = run providerFor()
    |> Effect.provideMut<Allocator>(&mut allocator)
  let transport = TestTransport {
    audit: move audit,
    memory: move memory,
  }
  return run Client.withOwned(
    move transport,
    origin,
    Version.Http11,
    limits(),
    Option.none<Instant>(),
    CancellationHandler {request: move request},
  )
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
}

effect fn structuredCancellation() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let audit = run Shared.make<CancellationAudit>(
    CancellationAudit {drops: usize.ZERO, closes: usize.ZERO},
  )
    |> Effect.provideMut<Allocator>(&mut allocator)
  let body = Effect.catchAll(cancellationBody(Shared.clone(&audit)), recover)
  let execution = run Execution.make(move body, (), cancellationReady)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut result = 0
  run Execution.drive(move execution, &mut result, cancellationComplete, cancellationParked)
  if result != 42 {
    return 124
  }
  return Shared.with(&audit, cancellationAuditResult)
}

struct LoanHandler<'marker, 'transport> {
  marker: &'marker i32
}

impl<'marker, 'transport> ConnectionHandler<Loan<'transport, TestTransport>, i32, ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random> for LoanHandler<
  'marker,
  'transport,
> {
  effect<'call> fn handle<'call>(
    handler: Self,
    connection: &'call mut Connection<Loan<'transport, TestTransport>>,
  ) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
    let result = handler.marker.* + 9
    drop handler
    drop connection
    return result
  }
}

effect<'transport> fn withBorrowedMarker<'marker, 'transport>(
  transport: &'transport mut TestTransport,
  marker: &'marker i32,
  origin: Origin,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  return run Client.withConnected<'transport>(
    move transport,
    origin,
    Version.Http11,
    limits(),
    Option.none<Instant>(),
    LoanHandler<'marker, 'transport> {marker: marker},
  )
}

effect fn borrowedLoan() -> i32 ! ClientError | RequestError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {mark: SystemClock.make(0, 0)}
  let mut random = FixedRandom {}
  let memory = run providerFor()
    |> Effect.provideMut<Allocator>(&mut allocator)
  let audit = run Shared.make<CancellationAudit>(CancellationAudit {drops: usize.ZERO, closes: usize.ZERO})
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut transport = TestTransport {
    audit: move audit,
    memory: move memory,
  }
  let uri = match move Uri.parse("http://example.test/") {
    Result.Failure {error} => {
      drop error
      return 103
    }
    Result.Success {value} => value
  }
  let origin = match move Origin.fromUri(&uri) {
    Result.Failure {error} => {
      drop error
      return 104
    }
    Result.Success {value} => value
  }
  let marker = 7
  let result = run withBorrowedMarker(&mut transport, &marker, origin)
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if result != 16 {
    return 105
  }
  if transport.memory.phase() != MemoryByteDuplexPhase.Closed || transport.memory.closeAttempts() != usize.ONE {
    return 106
  }
  return 0
}

effect fn recover(error: ClientError | RequestError | OutOfMemoryError) -> i32 {
  drop error
  return 51
}

effect fn ownershipCases() -> i32 ! ClientError | RequestError | OutOfMemoryError {
  let borrowed = run borrowedLoan()
  if borrowed != 0 {
    return borrowed
  }
  return run structuredCancellation()
}

pub fn main() -> i32 {
  return run Effect.catchAll(ownershipCases(), recover)
}
`
