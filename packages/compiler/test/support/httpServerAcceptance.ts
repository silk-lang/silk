/** Consolidated portable runtime program for one bounded streaming HTTP server exchange. */
export const httpServerAcceptanceSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.buffered_input {BufferError, MAX_CAPACITY}
import silk.buffered_duplex {BufferedDuplex}
import silk.byte_duplex {ByteDuplex, ByteIoError, ByteIoOperation}
import silk.bytes {Bytes}
import silk.effect {Effect}
import silk.http {Header, ResponseHead, Status, ValueError, Version}
import silk.http_body {BodyReason, Limits as BodyLimits, TrailerPolicy}
import silk.http_head {Limits as HeadLimits}
import silk.http_headers {Headers, Limits as ValueLimits}
import silk.http_server {
  BodyMode,
  Connection,
  ConnectionHandler,
  ConnectionPhase,
  Limits,
  Request,
  ResponseWriter,
  ReusePolicy,
  ServerError,
  ServerLimitKind,
  finishConnection,
  discardRemaining,
  readSome,
  reject,
  respond,
  sendInformational,
  validateLimits,
  withConnection,
  withRequest,
  withTunnel,
  withUpgrade,
}
import silk.memory_byte_duplex {
  MemoryByteDuplex,
  MemoryByteDuplexPhase,
  MemoryReadEvent,
  MemoryWriteAction,
  MemoryWriteEvent,
}
import silk.layout {Layout}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.usize
import silk.vector {Vector}

struct RefusingAllocator {calls: usize}
impl Allocator for RefusingAllocator {
  effect fn allocate(self: &mut Self, layout: Layout) -> Allocation ! OutOfMemoryError {
    drop layout
    self.calls = self.calls + usize.ONE
    fail OutOfMemoryError {}
  }
}

struct FixedClock {}
struct NormalHandler {}
struct RejectHandler {}
struct ZeroHandler {}
struct ReuseHandler {}
struct MatrixHandler { scenario: i32 }

impl MonotonicClock for FixedClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, duration: u64) -> () { drop duration return () }
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

fn limits() -> Limits {
  return Limits {
    head: headLimits(),
    body: bodyLimits(),
    values: valueLimits(),
    readCapacity: 128,
    writeCapacity: 128,
    maxRequestsPerConnection: usize.ONE,
    maxInformationalResponses: 2,
    maxDiscardWireBytes: u64.toU64(256),
    shutdownDrainBytes: 16,
  }
}

fn invalidCapacity(error: ServerError, expected: usize) -> bool {
  return match move error {
    ServerError.Buffer {error: cause} => match move cause {
      BufferError.InvalidCapacity {capacity} => capacity == expected
      _ => false
    }
    _ => false
  }
}

fn runLimitValidation() -> i32 {
  let mut candidate = limits()
  candidate.readCapacity = usize.ZERO
  let zeroRead = validateLimits(&candidate)
  match move zeroRead {
    Result.Success {value} => { drop value return 11 }
    Result.Failure {error} => {
      if !invalidCapacity(move error, usize.ZERO) { return 12 }
    }
  }
  candidate = limits()
  candidate.readCapacity = MAX_CAPACITY + usize.ONE
  let largeRead = validateLimits(&candidate)
  match move largeRead {
    Result.Success {value} => { drop value return 13 }
    Result.Failure {error} => {
      if !invalidCapacity(move error, MAX_CAPACITY + usize.ONE) { return 14 }
    }
  }
  candidate = limits()
  candidate.writeCapacity = usize.ZERO
  let zeroWrite = validateLimits(&candidate)
  match move zeroWrite {
    Result.Success {value} => { drop value return 16 }
    Result.Failure {error} => {
      if !invalidCapacity(move error, usize.ZERO) { return 17 }
    }
  }
  candidate = limits()
  candidate.writeCapacity = MAX_CAPACITY + usize.ONE
  let largeWrite = validateLimits(&candidate)
  match move largeWrite {
    Result.Success {value} => { drop value return 18 }
    Result.Failure {error} => {
      if !invalidCapacity(move error, MAX_CAPACITY + usize.ONE) { return 19 }
    }
  }
  candidate = limits()
  candidate.head.maxHeadBytes = usize.ZERO
  let zeroHead = validateLimits(&candidate)
  return match move zeroHead {
    Result.Success {value} => { drop value return 0 }
    Result.Failure {error} => { drop error return 15 }
  }
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

effect fn providerFor(inputBytes: &[u8], writeCount: usize) -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let input = run Bytes.copy(inputBytes)
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 0),
    bytes: move input,
  })
  run Vector.append(&mut reads, MemoryReadEvent.End {readyAt: SystemClock.make(0, 0)})
  let mut writes = Vector.make<MemoryWriteEvent>()
  let mut index = usize.ZERO
  while index < writeCount {
    run Vector.append(&mut writes, MemoryWriteEvent {
      readyAt: SystemClock.make(0, 0),
      action: MemoryWriteAction.Accept {count: 256},
    })
    index = index + usize.ONE
  }
  // Tiny buffers can produce one read per byte; retain writes, flushes, and lifecycle events too.
  let auditCapacity = inputBytes.length + 2 * writeCount + 8
  return run MemoryByteDuplex.make(move reads, move writes, 256, auditCapacity, Option.none<i32>())
}

effect fn splitProvider(firstBytes: &[u8], secondBytes: &[u8], writeCount: usize)
-> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let first = run Bytes.copy(firstBytes)
  let second = run Bytes.copy(secondBytes)
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 0),
    bytes: move first,
  })
  run Vector.append(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 0),
    bytes: move second,
  })
  run Vector.append(&mut reads, MemoryReadEvent.End {readyAt: SystemClock.make(0, 0)})
  let mut writes = Vector.make<MemoryWriteEvent>()
  let mut index = usize.ZERO
  while index < writeCount {
    run Vector.append(&mut writes, MemoryWriteEvent {
      readyAt: SystemClock.make(0, 0),
      action: MemoryWriteAction.Accept {count: 256},
    })
    index = index + usize.ONE
  }
  return run MemoryByteDuplex.make(move reads, move writes, 256, 32, Option.none<i32>())
}

effect fn failingOutputProvider(inputBytes: &[u8], successfulWrites: usize, code: i32)
-> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let input = run Bytes.copy(inputBytes)
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 0),
    bytes: move input,
  })
  run Vector.append(&mut reads, MemoryReadEvent.End {readyAt: SystemClock.make(0, 0)})
  let mut writes = Vector.make<MemoryWriteEvent>()
  let mut index = usize.ZERO
  while index < successfulWrites {
    run Vector.append(&mut writes, MemoryWriteEvent {
      readyAt: SystemClock.make(0, 0),
      action: MemoryWriteAction.Accept {count: usize.ONE},
    })
    index = index + usize.ONE
  }
  run Vector.append(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 0),
    action: MemoryWriteAction.Failure {code: code},
  })
  return run MemoryByteDuplex.make(move reads, move writes, 256, 256, Option.none<i32>())
}

effect<'call> fn finishResponse<
  'call,
  'writerView: 'call,
  'requestView: 'writerView,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  writer: &'call mut ResponseWriter<
    'writerView,
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError
? &mut MonotonicClock {
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { fail ServerError.Value {error: move error} }
    Result.Success {value} => value
  }
  run ResponseWriter.finish(&mut writer.*, &headers, Option.none<Instant>())
  return 0
}

effect<'call> fn handleRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut body: [u8; 4] = [0, 0, 0, 0]
  let count = run readSome(&mut request.*, &mut body, Option.none<Instant>())
  if count != 4 || !equal(&body, b"Wiki") || !(run Request.bodyComplete(&request.*)) { return 31 }
  let callerConnection = match move Header.make("Connection", b"keep-alive", valueLimits()) {
    Result.Failure {error} => { return 32 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 1] = [callerConnection]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { return 32 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(204) {
    Result.Failure {error} => { return 33 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"No Content"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { return 34 }
    Result.Success {value} => move value
  }
  return run respond(
    move request,
    &response,
    BodyMode.NoBody,
    ReusePolicy.Automatic,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    finishResponse,
  )
}

effect<'call> fn handleConnection<
  'call,
  'connection: 'call,
  'transport: 'connection,
>(
  connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let handled = run withRequest(
    &mut connection.*,
    Option.none<Instant>(),
    handleRequest,
  )
  let code = match move handled {
    Option.None => 35
    Option.Some {value} => value
  }
  // A completed response must reach the provider before abortive scope release.
  return code
}

effect<'call> fn rejectExpectation<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  if !(run request.expectationRejected()) { return 71 }
  let length = match move Header.make("Content-Length", b"0", valueLimits()) {
    Result.Failure {error} => { return 72 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 1] = [length]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { return 72 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(417) {
    Result.Failure {error} => { return 73 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"Expectation Failed"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { return 74 }
    Result.Success {value} => move value
  }
  run reject(&mut request.*, &response, Option.none<Instant>())
  return 0
}

effect<'call> fn handleZeroBody<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  if !(run Request.bodyComplete(&request.*)) { return 81 }
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { return 82 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(204) {
    Result.Failure {error} => { return 83 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"No Content"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { return 84 }
    Result.Success {value} => move value
  }
  return run respond(
    move request,
    &response,
    BodyMode.NoBody,
    ReusePolicy.Automatic,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    finishResponse,
  )
}

effect<'call> fn zeroConnection<
  'call,
  'connection: 'call,
  'transport: 'connection,
>(
  connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let handled = run withRequest(
    &mut connection.*,
    Option.none<Instant>(),
    handleZeroBody,
  )
  let code = match move handled {
    Option.None => 85
    Option.Some {value} => value
  }
  if code == 0 { run finishConnection(&mut connection.*, 16, SystemClock.make(7, 9)) }
  return code
}

effect<'call> fn reuseConnection<
  'call,
  'connection: 'call,
  'transport: 'connection,
>(
  connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let first = run withRequest(
    &mut connection.*,
    Option.none<Instant>(),
    handleZeroBody,
  )
  let firstCode = match move first {
    Option.None => 91
    Option.Some {value} => value
  }
  if firstCode != 0 { return firstCode }
  if connection.phase() != ConnectionPhase.Ready || connection.requests() != usize.ONE {
    return 92
  }
  let second = run withRequest(
    &mut connection.*,
    Option.none<Instant>(),
    handleZeroBody,
  )
  let secondCode = match move second {
    Option.None => 93
    Option.Some {value} => value
  }
  if secondCode != 0 { return secondCode }
  if connection.phase() != ConnectionPhase.Closing || connection.requests() != 2 { return 94 }
  run finishConnection(&mut connection.*, 16, SystemClock.make(7, 9))
  return 0
}

effect<'call> fn rejectConnection<
  'call,
  'connection: 'call,
  'transport: 'connection,
>(
  connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let handled = run withRequest(
    &mut connection.*,
    Option.none<Instant>(),
    rejectExpectation,
  )
  let code = match move handled {
    Option.None => 75
    Option.Some {value} => value
  }
  // Rejection must flush without a separate graceful connection finish.
  return code
}

effect<'call> fn writeFixedResponse<
  'call,
  'writerView: 'call,
  'requestView: 'writerView,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  writer: &'call mut ResponseWriter<
    'writerView,
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError
? &mut MonotonicClock {
  let progress = run ResponseWriter.writeAll(
    &mut writer.*,
    b"Hello",
    Option.none<Instant>(),
  )
  if progress.consumed != 5
    || progress.totalPayload != u64.toU64(5)
    || progress.totalWire != u64.toU64(5) { return 101 }
  let entries: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 102 }
    Result.Success {value} => value
  }
  run ResponseWriter.finish(&mut writer.*, &trailers, Option.none<Instant>())
  let empty: [u8; 0] = []
  let emptyWrite = run Effect.result(ResponseWriter.writeAll(
    &mut writer.*,
    &empty,
    Option.none<Instant>(),
  ))
  match move emptyWrite {
    Result.Success {value} => { drop value return 231 }
    Result.Failure {error} => match move error {
      ServerError.InvalidState {phase} => {
        if phase != ConnectionPhase.Responding { return 232 }
      }
      _ => { return 233 }
    }
  }
  let repeated = run Effect.result(ResponseWriter.finish(
    &mut writer.*,
    &trailers,
    Option.none<Instant>(),
  ))
  return match move repeated {
    Result.Success {value} => { drop value return 107 }
    Result.Failure {error} => match move error {
      ServerError.InvalidState {phase} => {
        if phase == ConnectionPhase.Responding { return 0 }
        return 108
      }
      _ => 109
    }
  }
}

effect<'call> fn fixedResponseRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let length = match move Header.make("Content-Length", b"5", valueLimits()) {
    Result.Failure {error} => { drop error return 103 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 1] = [length]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 104 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(200) {
    Result.Failure {error} => { drop error return 105 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"OK"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 106 }
    Result.Success {value} => move value
  }
  return run respond(
    move request,
    &response,
    BodyMode.ContentLength {length: u64.toU64(5)},
    ReusePolicy.CloseAfterResponse,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    writeFixedResponse,
  )
}

effect<'call> fn writeChunkedResponse<
  'call,
  'writerView: 'call,
  'requestView: 'writerView,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  writer: &'call mut ResponseWriter<
    'writerView,
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError
? &mut MonotonicClock {
  let progress = run ResponseWriter.writeAll(
    &mut writer.*,
    b"Wiki",
    Option.none<Instant>(),
  )
  if progress.consumed != 4
    || progress.totalPayload != u64.toU64(4)
    || progress.totalWire != u64.toU64(9) { return 111 }
  let digest = match move Header.make("Content-Digest", b"ok", valueLimits()) {
    Result.Failure {error} => { drop error return 112 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 1] = [digest]
  let trailers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 113 }
    Result.Success {value} => value
  }
  run ResponseWriter.finish(&mut writer.*, &trailers, Option.none<Instant>())
  return 0
}

effect<'call> fn chunkedResponseRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let transfer = match move Header.make("Transfer-Encoding", b"chunked", valueLimits()) {
    Result.Failure {error} => { drop error return 114 }
    Result.Success {value} => value
  }
  let advisory = match move Header.make("Trailer", b"Content-Digest", valueLimits()) {
    Result.Failure {error} => { drop error return 115 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 2] = [transfer, advisory]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 116 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(200) {
    Result.Failure {error} => { drop error return 117 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"OK"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 118 }
    Result.Success {value} => move value
  }
  return run respond(
    move request,
    &response,
    BodyMode.Chunked,
    ReusePolicy.CloseAfterResponse,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    writeChunkedResponse,
  )
}

effect<'call> fn informationalRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut body: [u8; 4] = [0, 0, 0, 0]
  let count = run readSome(&mut request.*, &mut body, Option.none<Instant>())
  if count != 4 || !equal(&body, b"Wiki") || !(run Request.bodyComplete(&request.*)) { return 120 }
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 121 }
    Result.Success {value} => value
  }
  let continueStatus = match move Status.fromCode(100) {
    Result.Failure {error} => { drop error return 234 }
    Result.Success {value} => value
  }
  let continued = match move ResponseHead.make(
    Version.Http11,
    continueStatus,
    Option.some<&'static [u8]>(b"Continue"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 235 }
    Result.Success {value} => move value
  }
  let duplicateContinue = run Effect.result(sendInformational(
    &mut request.*,
    &continued,
    Option.none<Instant>(),
  ))
  match move duplicateContinue {
    Result.Success {value} => { drop value return 236 }
    Result.Failure {error} => match move error {
      ServerError.InvalidState {phase} => {
        if phase != ConnectionPhase.RequestActive { return 237 }
      }
      _ => { return 238 }
    }
  }
  let switchingStatus = match move Status.fromCode(101) {
    Result.Failure {error} => { drop error return 127 }
    Result.Success {value} => value
  }
  let switching = match move ResponseHead.make(
    Version.Http11,
    switchingStatus,
    Option.some<&'static [u8]>(b"Switching Protocols"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 128 }
    Result.Success {value} => move value
  }
  let invalid = run Effect.result(sendInformational(
    &mut request.*,
    &switching,
    Option.none<Instant>(),
  ))
  match move invalid {
    Result.Success {value} => { drop value return 129 }
    Result.Failure {error} => match move error {
      ServerError.InvalidState {phase} => {
        if phase != ConnectionPhase.RequestActive { return 129 }
      }
      _ => { return 129 }
    }
  }
  let trailer = match move Header.make("Trailer", b"Content-Digest", valueLimits()) {
    Result.Failure {error} => { drop error return 130 }
    Result.Success {value} => value
  }
  let trailerEntries: [Header<'static>; 1] = [trailer]
  let trailerHeaders = match move Headers.make(&trailerEntries, valueLimits()) {
    Result.Failure {error} => { drop error return 130 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(103) {
    Result.Failure {error} => { drop error return 122 }
    Result.Success {value} => value
  }
  let framedInformational = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"Early Hints"),
    trailerHeaders,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 130 }
    Result.Success {value} => move value
  }
  let framed = run Effect.result(sendInformational(
    &mut request.*,
    &framedInformational,
    Option.none<Instant>(),
  ))
  match move framed {
    Result.Success {value} => { drop value return 130 }
    Result.Failure {error} => match move error {
      ServerError.InvalidBodyMode => {}
      _ => { return 130 }
    }
  }
  let informational = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"Early Hints"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 123 }
    Result.Success {value} => move value
  }
  run sendInformational(&mut request.*, &informational, Option.none<Instant>())
  let repeated = run Effect.result(sendInformational(
    &mut request.*,
    &informational,
    Option.none<Instant>(),
  ))
  match move repeated {
    Result.Success {value} => { drop value return 124 }
    Result.Failure {error} => match move error {
      ServerError.LimitExceeded {limit, allowed, attempted} => {
        if limit != ServerLimitKind.InformationalResponses
          || allowed != u64.toU64(2)
          || attempted != u64.toU64(3) { return 125 }
      }
      _ => { return 126 }
    }
  }
  return run handleZeroBody(move request)
}

effect<'call> fn discardChunkedRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let mut prefix: [u8; 1] = [0]
  let read = run readSome(&mut request.*, &mut prefix, Option.none<Instant>())
  if read != usize.ONE || prefix[usize.ZERO] != 87 { return 130 }
  run discardRemaining(&mut request.*, u64.toU64(10), Option.none<Instant>())
  if !(run Request.bodyComplete(&request.*)) { return 131 }
  return run handleZeroBody(move request)
}

effect<'call> fn recoverBeforeOutput<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let length = match move Header.make("Content-Length", b"2", valueLimits()) {
    Result.Failure {error} => { drop error return 141 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 1] = [length]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 142 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(200) {
    Result.Failure {error} => { drop error return 143 }
    Result.Success {value} => value
  }
  let invalid = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"OK"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 144 }
    Result.Success {value} => move value
  }
  let attempted = run Effect.result(respond(
    &mut request.*,
    &invalid,
    BodyMode.ContentLength {length: u64.toU64(1)},
    ReusePolicy.Automatic,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    finishResponse,
  ))
  match move attempted {
    Result.Success {value} => { drop value return 145 }
    Result.Failure {error} => match move error {
      ServerError.InvalidBodyMode => {}
      _ => { return 146 }
    }
  }
  return run handleZeroBody(move request)
}

effect<'call> fn writeShortFixedResponse<
  'call,
  'writerView: 'call,
  'requestView: 'writerView,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  writer: &'call mut ResponseWriter<
    'writerView,
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError
? &mut MonotonicClock {
  let progress = run ResponseWriter.writeAll(
    &mut writer.*,
    b"xy",
    Option.none<Instant>(),
  )
  drop progress
  return 151
}

effect<'call> fn failAfterOutput<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let length = match move Header.make("Content-Length", b"2", valueLimits()) {
    Result.Failure {error} => { drop error return 154 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 1] = [length]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 155 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(200) {
    Result.Failure {error} => { drop error return 156 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"OK"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 157 }
    Result.Success {value} => move value
  }
  return run respond(
    move request,
    &response,
    BodyMode.ContentLength {length: u64.toU64(2)},
    ReusePolicy.CloseAfterResponse,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    writeShortFixedResponse,
  )
}

effect<'call> fn consumeBodyFailureProgress<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError
? &mut MonotonicClock {
  let mut output: [u8; 1] = [0]
  let attempted = run Effect.result(readSome(
    &mut request.*,
    &mut output,
    Option.none<Instant>(),
  ))
  return match move attempted {
    Result.Success {value} => { drop value return 152 }
    Result.Failure {error} => match move error {
      ServerError.Body {error: cause} => {
        if cause.consumed != 3 || cause.totalWire != u64.toU64(3) { return 153 }
        return match move cause.reason {
          BodyReason.ChunkSyntax => 0
          _ => 154
        }
      }
      _ => 155
    }
  }
}

effect<'call> fn inspectUpgradeSuffix<'call, 'transport: 'call>(
  channel: &'call mut BufferedDuplex<'transport, MemoryByteDuplex>,
) -> i32 {
  let suffix = BufferedDuplex.peek(&channel.*)
  let valid = equal(suffix, b"XYZ")
  drop suffix
  if !valid { return 161 }
  return 0
}

effect<'call> fn upgradeRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let upgrade = match move Header.make("Upgrade", b"websocket", valueLimits()) {
    Result.Failure {error} => { drop error return 162 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 1] = [upgrade]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 163 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(101) {
    Result.Failure {error} => { drop error return 164 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"Switching Protocols"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 165 }
    Result.Success {value} => move value
  }
  let code = run withUpgrade<i32, never>(
    &mut request.*,
    "websocket",
    &response,
    Option.none<Instant>(),
    inspectUpgradeSuffix,
  )
  if code != 0 { return code }
  let resumed = run Effect.result(Request.bodyComplete(&request.*))
  return match move resumed {
    Result.Success {value} => { drop value return 166 }
    Result.Failure {error} => match move error {
      ServerError.InvalidState {phase} => {
        if phase == ConnectionPhase.Upgraded { return 0 }
        return 167
      }
      _ => 168
    }
  }
}

effect<'call> fn inspectTunnelSuffix<'call, 'transport: 'call>(
  channel: &'call mut BufferedDuplex<'transport, MemoryByteDuplex>,
) -> i32 {
  let suffix = BufferedDuplex.peek(&channel.*)
  let valid = equal(suffix, b"TLS")
  drop suffix
  if !valid { return 171 }
  return 0
}

effect<'call> fn tunnelRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let connection = match move Header.make("Connection", b"keep-alive", valueLimits()) {
    Result.Failure {error} => { drop error return 172 }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 1] = [connection]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 173 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(200) {
    Result.Failure {error} => { drop error return 174 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"Connection Established"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 175 }
    Result.Success {value} => move value
  }
  let code = run withTunnel<i32, never>(
    &mut request.*,
    &response,
    Option.none<Instant>(),
    inspectTunnelSuffix,
  )
  if code != 0 { return code }
  let resumed = run Effect.result(discardRemaining(
    &mut request.*,
    u64.toU64(1),
    Option.none<Instant>(),
  ))
  return match move resumed {
    Result.Success {value} => { drop value return 175 }
    Result.Failure {error} => match move error {
      ServerError.InvalidState {phase} => {
        if phase == ConnectionPhase.Upgraded { return 0 }
        return 176
      }
      _ => 177
    }
  }
}

effect<'call> fn http10Request<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  if !(run Request.bodyComplete(&request.*)) { return 201 }
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 202 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(204) {
    Result.Failure {error} => { drop error return 203 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http10,
    status,
    Option.some<&'static [u8]>(b"No Content"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 204 }
    Result.Success {value} => move value
  }
  return run respond(
    move request,
    &response,
    BodyMode.NoBody,
    ReusePolicy.Http10KeepAlive,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    finishResponse,
  )
}

effect<'call> fn unreadBodyRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  if (run Request.bodyComplete(&request.*)) { return 211 }
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 212 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(204) {
    Result.Failure {error} => { drop error return 213 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"No Content"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 214 }
    Result.Success {value} => move value
  }
  return run respond(
    move request,
    &response,
    BodyMode.NoBody,
    ReusePolicy.Automatic,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    finishResponse,
  )
}

effect<'call> fn writeCloseDelimitedResponse<
  'call,
  'writerView: 'call,
  'requestView: 'writerView,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  writer: &'call mut ResponseWriter<
    'writerView,
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError
? &mut MonotonicClock {
  let progress = run ResponseWriter.writeAll(
    &mut writer.*,
    b"bye",
    Option.none<Instant>(),
  )
  if progress.consumed != 3
    || progress.totalPayload != u64.toU64(3)
    || progress.totalWire != u64.toU64(3) { return 221 }
  let entries: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 222 }
    Result.Success {value} => value
  }
  run ResponseWriter.finish(&mut writer.*, &trailers, Option.none<Instant>())
  return 0
}

effect<'call> fn closeDelimitedRequest<
  'call,
  'requestView: 'call,
  'connectionView: 'requestView,
  'transportView: 'connectionView,
>(
  request: &'call mut Request<
    'requestView,
    'connectionView,
    'transportView,
    MemoryByteDuplex
  >,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { drop error return 223 }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(200) {
    Result.Failure {error} => { drop error return 224 }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'static [u8]>(b"OK"),
    headers,
    valueLimits(),
  ) {
    Result.Failure {error} => { drop error return 225 }
    Result.Success {value} => move value
  }
  return run respond(
    move request,
    &response,
    BodyMode.CloseDelimited,
    ReusePolicy.Automatic,
    TrailerPolicy.defaultPolicy(),
    Option.none<Instant>(),
    writeCloseDelimitedResponse,
  )
}

effect<'call> fn matrixConnection<
  'call,
  'connection: 'call,
  'transport: 'connection,
>(
  connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
  scenario: i32,
) -> i32
! ServerError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  if scenario == 14 {
    let mut refusing = RefusingAllocator {calls: usize.ZERO}
    let attempted = run Effect.result(withRequest(
      &mut connection.*,
      Option.none<Instant>(),
      handleZeroBody,
    ) |> Effect.provideMut<Allocator>(&mut refusing))
    match move attempted {
      Result.Success {value} => { drop value return 260 }
      Result.Failure {error} => match move error {
        OutOfMemoryError {} => {}
        _ => { return 261 }
      }
    }
    if refusing.calls != usize.ONE || connection.phase() != ConnectionPhase.Failed {
      return 262
    }
    let unread = connection.unread()
    let retried = run Effect.result(withRequest(
      &mut connection.*,
      Option.none<Instant>(),
      handleZeroBody,
    ))
    match move retried {
      Result.Success {value} => { drop value return 263 }
      Result.Failure {error} => match move error {
        ServerError.InvalidState {phase} => {
          if phase != ConnectionPhase.Failed { return 264 }
        }
        _ => { return 265 }
      }
    }
    if unread != 4 || connection.unread() != unread { return 266 }
    return 0
  }
  if scenario == 6 {
    let outcome = run Effect.result(withRequest(
      &mut connection.*,
      Option.none<Instant>(),
      failAfterOutput,
    ))
    match move outcome {
      Result.Success {value} => { drop value return 158 }
      Result.Failure {error} => match move error {
        ServerError.Output {error: cause, progress} => {
          if progress.consumed != 2
            || progress.buffered != usize.ONE
            || progress.totalPayload != u64.toU64(2)
            || progress.totalWire != u64.toU64(2) { return 159 }
          match move cause {
            BufferError.WriteFailed {accepted, drained, error: providerError} => {
              if accepted != usize.ONE || drained != usize.ZERO { return 159 }
              match move providerError {
                ByteIoError.Provider {operation, code} => {
                  if operation != ByteIoOperation.Write || code != 73 { return 159 }
                }
                _ => { return 159 }
              }
            }
            _ => { return 159 }
          }
        }
        _ => { return 160 }
      }
    }
    if connection.phase() != ConnectionPhase.Failed { return 169 }
    return 0
  }
  if scenario == 13 {
    let outcome = run withRequest(
      &mut connection.*,
      Option.none<Instant>(),
      consumeBodyFailureProgress,
    )
    let code = match move outcome {
      Option.None => 252
      Option.Some {value} => value
    }
    if code != 0 { return code }
    if connection.phase() != ConnectionPhase.Failed || connection.unread() != usize.ZERO {
      return 253
    }
    return 0
  }
  if scenario == 9 {
    let first = run withRequest(&mut connection.*, Option.none<Instant>(), http10Request)
    let firstCode = match move first {
      Option.None => 205
      Option.Some {value} => value
    }
    if firstCode != 0 { return firstCode }
    if connection.phase() != ConnectionPhase.Ready || connection.requests() != usize.ONE {
      return 206
    }
    let second = run withRequest(&mut connection.*, Option.none<Instant>(), http10Request)
    let secondCode = match move second {
      Option.None => 207
      Option.Some {value} => value
    }
    if secondCode != 0 { return secondCode }
    if connection.phase() != ConnectionPhase.Closing || connection.requests() != 2 { return 208 }
    run finishConnection(&mut connection.*, usize.ZERO, SystemClock.make(7, 9))
    return 0
  }
  if scenario == 11 {
    let absent = run withRequest(&mut connection.*, Option.none<Instant>(), handleZeroBody)
    match move absent {
      Option.None => {}
      Option.Some {value} => { drop value return 226 }
    }
    if connection.phase() != ConnectionPhase.Closing || connection.requests() != usize.ZERO {
      return 227
    }
    run finishConnection(&mut connection.*, usize.ZERO, SystemClock.make(7, 9))
    return 0
  }
  let mut handled: Option<i32> = Option.none<i32>()
  if scenario == 1 {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), fixedResponseRequest)
  } else if scenario == 2 {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), chunkedResponseRequest)
  } else if scenario == 3 {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), informationalRequest)
  } else if scenario == 4 {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), discardChunkedRequest)
  } else if scenario == 5 {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), recoverBeforeOutput)
  } else if scenario == 7 {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), upgradeRequest)
  } else if scenario == 8 {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), tunnelRequest)
  } else if scenario == 10 {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), unreadBodyRequest)
  } else {
    handled = run withRequest(&mut connection.*, Option.none<Instant>(), closeDelimitedRequest)
  }
  let code = match move handled {
    Option.None => 178
    Option.Some {value} => value
  }
  if code != 0 { return code }
  run finishConnection(&mut connection.*, usize.ZERO, SystemClock.make(7, 9))
  return 0
}

impl ConnectionHandler<
  MemoryByteDuplex,
  i32,
  ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
> for MatrixHandler {
  effect<'call> fn handle<'call, 'connection: 'call, 'transport: 'connection>(
    handler: Self,
    connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
  ) -> i32
  ! ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
  where &'transport mut MemoryByteDuplex provides &ByteDuplex
    from &mut ByteDuplex | &mut MonotonicClock {
    let MatrixHandler {scenario} = move handler
    return run matrixConnection(move connection, scenario)
  }
}

impl ConnectionHandler<
  MemoryByteDuplex,
  i32,
  ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
> for NormalHandler {
  effect<'call> fn handle<'call, 'connection: 'call, 'transport: 'connection>(
    handler: Self,
    connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
  ) -> i32
  ! ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
  where &'transport mut MemoryByteDuplex provides &ByteDuplex
    from &mut ByteDuplex | &mut MonotonicClock {
    drop handler
    return run handleConnection(move connection)
  }
}

impl ConnectionHandler<
  MemoryByteDuplex,
  i32,
  ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
> for RejectHandler {
  effect<'call> fn handle<'call, 'connection: 'call, 'transport: 'connection>(
    handler: Self,
    connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
  ) -> i32
  ! ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
  where &'transport mut MemoryByteDuplex provides &ByteDuplex
    from &mut ByteDuplex | &mut MonotonicClock {
    drop handler
    return run rejectConnection(move connection)
  }
}

impl ConnectionHandler<
  MemoryByteDuplex,
  i32,
  ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
> for ZeroHandler {
  effect<'call> fn handle<'call, 'connection: 'call, 'transport: 'connection>(
    handler: Self,
    connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
  ) -> i32
  ! ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
  where &'transport mut MemoryByteDuplex provides &ByteDuplex
    from &mut ByteDuplex | &mut MonotonicClock {
    drop handler
    return run zeroConnection(move connection)
  }
}

impl ConnectionHandler<
  MemoryByteDuplex,
  i32,
  ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
> for ReuseHandler {
  effect<'call> fn handle<'call, 'connection: 'call, 'transport: 'connection>(
    handler: Self,
    connection: &'call mut Connection<'connection, 'transport, MemoryByteDuplex>,
  ) -> i32
  ! ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock
  where &'transport mut MemoryByteDuplex provides &ByteDuplex
    from &mut ByteDuplex | &mut MonotonicClock {
    drop handler
    return run reuseConnection(move connection)
  }
}

effect fn runServer() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut transport = run splitProvider(
    b"POST / HTTP/1.1\\r",
    b"\\nHost: example.test\\r\\nContent-Length: 4\\r\\n\\r\\nWiki",
    usize.ONE,
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let served = withConnection(&mut transport, limits(), NormalHandler {})
  let code = run move served
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if code != 0 { return code }
  if transport.phase() != MemoryByteDuplexPhase.Closed || transport.closeAttempts() != usize.ONE {
    return 41
  }
  if !equal(
    transport.outbound(),
    b"HTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
  ) { return 42 }
  return 0
}

effect fn runExpectation() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut transport = run providerFor(
    b"POST / HTTP/1.1\\r\\nHost: example.test\\r\\nContent-Length: 4\\r\\nExpect: 100-Continue, 100-continue\\r\\n\\r\\nWiki",
    2,
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let served = withConnection(&mut transport, limits(), NormalHandler {})
  let code = run move served
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if code != 0 { return 61 }
  if !equal(
    transport.outbound(),
    b"HTTP/1.1 100 Continue\\r\\n\\r\\nHTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
  ) { return 62 }
  return 0
}

effect fn runRejectedExpectation() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut transport = run providerFor(
    b"POST / HTTP/1.1\\r\\nHost: example.test\\r\\nContent-Length: 4\\r\\nExpect: kittens\\r\\n\\r\\n",
    usize.ONE,
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let served = withConnection(&mut transport, limits(), RejectHandler {})
  let code = run move served
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if code != 0 { return code }
  if !equal(
    transport.outbound(),
    b"HTTP/1.1 417 Expectation Failed\\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n",
  ) { return 76 }
  return 0
}

effect fn runFixedZero() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut transport = run providerFor(
    b"GET / HTTP/1.1\\r\\nHost: example.test\\r\\nContent-Length: 0\\r\\n\\r\\n",
    usize.ONE,
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let served = withConnection(&mut transport, limits(), ZeroHandler {})
  let code = run move served
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if code != 0 { return code }
  if !equal(
    transport.outbound(),
    b"HTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
  ) { return 86 }
  return 0
}

effect fn runCoalescedReuse() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut transport = run providerFor(
    b"GET /one HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\nGET /two HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n",
    2,
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut serverLimits = limits()
  serverLimits.maxRequestsPerConnection = 2
  let served = withConnection(&mut transport, serverLimits, ReuseHandler {})
  let code = run move served
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if code != 0 { return code }
  if !equal(
    transport.outbound(),
    b"HTTP/1.1 204 No Content\\r\\n\\r\\nHTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
  ) { return 95 }
  return 0
}

effect fn runMatrixCase(
  inputBytes: &[u8],
  expected: &[u8],
  scenario: i32,
  serverLimits: Limits,
) -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  // Each explicit flush may drain a partial buffer; allow one accepted write per wire byte.
  let writeCount = expected.length
  let mut transport = run providerFor(inputBytes, writeCount)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let served = withConnection(&mut transport, serverLimits, MatrixHandler {scenario: scenario})
  let code = run move served
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if code != 0 { return code }
  if scenario == 14 {
    let audit = transport.audit()
    let mut index = usize.ZERO
    let mut reads = usize.ZERO
    while index < audit.length {
      if audit[index].operation == ByteIoOperation.Read { reads = reads + usize.ONE }
      index = index + usize.ONE
    }
    drop audit
    if reads != usize.ONE { return 267 }
  }
  if scenario == 11 {
    let audit = transport.audit()
    let mut index = usize.ZERO
    while index < audit.length {
      if audit[index].operation == ByteIoOperation.Read {
        drop audit
        return 228
      }
      index = index + usize.ONE
    }
    drop audit
  }
  if transport.phase() != MemoryByteDuplexPhase.Closed
    || transport.closeAttempts() != usize.ONE { return 230 + scenario }
  if !equal(transport.outbound(), expected) { return 242 + scenario }
  return 0
}

effect fn runFixedResponse() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"GET /fixed HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n",
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 5\\r\\nConnection: close\\r\\n\\r\\nHello",
    1,
    limits(),
  )
}

effect fn runChunkedResponse() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"GET /chunked HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n",
    b"HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\nTrailer: Content-Digest\\r\\nConnection: close\\r\\n\\r\\n4\\r\\nWiki\\r\\n0\\r\\nContent-Digest: ok\\r\\n\\r\\n",
    2,
    limits(),
  )
}

effect fn runInformationalBudget() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"POST /hints HTTP/1.1\\r\\nHost: example.test\\r\\nContent-Length: 4\\r\\nExpect: 100-continue\\r\\n\\r\\nWiki",
    b"HTTP/1.1 100 Continue\\r\\n\\r\\nHTTP/1.1 103 Early Hints\\r\\n\\r\\nHTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
    3,
    limits(),
  )
}

effect fn runChunkedDiscard() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut serverLimits = limits()
  serverLimits.readCapacity = 3
  return run runMatrixCase(
    b"POST /discard HTTP/1.1\\r\\nHost: example.test\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n4\\r\\nWiki\\r\\n0\\r\\n\\r\\n",
    b"HTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
    4,
    serverLimits,
  )
}

effect fn runPreOutputRecovery() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"GET /recover HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n",
    b"HTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
    5,
    limits(),
  )
}

effect fn runPostOutputFailure() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let expected = b"HTTP/1.1 200 OK\\r\\nContent-Length: 2\\r\\nConnection: close\\r\\n\\r\\n"
  let mut transport = run failingOutputProvider(
    b"GET /partial HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n",
    expected.length,
    73,
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut serverLimits = limits()
  serverLimits.writeCapacity = usize.ONE
  let served = withConnection(&mut transport, serverLimits, MatrixHandler {scenario: 6})
  let code = run move served
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if code != 0 { return code }
  if transport.phase() != MemoryByteDuplexPhase.Closed
    || transport.closeAttempts() != usize.ONE { return 236 }
  if !equal(transport.outbound(), expected) { return 248 }
  let audit = transport.audit()
  let mut index = usize.ZERO
  let mut sawFailedWrite = false
  while index < audit.length {
    if audit[index].operation == ByteIoOperation.Write && audit[index].count == usize.ZERO {
      if sawFailedWrite { drop audit return 249 }
      sawFailedWrite = true
    } else if sawFailedWrite && audit[index].operation == ByteIoOperation.Write {
      drop audit
      return 250
    }
    index = index + usize.ONE
  }
  drop audit
  if !sawFailedWrite { return 251 }
  return 0
}

effect fn runUpgradeHandoff() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: websocket\\r\\n\\r\\nXYZ",
    b"HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nConnection: upgrade\\r\\n\\r\\n",
    7,
    limits(),
  )
}

effect fn runTunnelHandoff() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"CONNECT example.test:443 HTTP/1.1\\r\\nHost: example.test:443\\r\\n\\r\\nTLS",
    b"HTTP/1.1 200 Connection Established\\r\\n\\r\\n",
    8,
    limits(),
  )
}

effect fn runHttp10KeepAlive() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut serverLimits = limits()
  serverLimits.maxRequestsPerConnection = 2
  return run runMatrixCase(
    b"GET /one HTTP/1.0\\r\\nConnection: keep-alive\\r\\n\\r\\nGET /two HTTP/1.0\\r\\nConnection: keep-alive\\r\\n\\r\\n",
    b"HTTP/1.0 204 No Content\\r\\nConnection: keep-alive\\r\\n\\r\\nHTTP/1.0 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
    9,
    serverLimits,
  )
}

effect fn runUnreadBodyClose() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"POST /unread HTTP/1.1\\r\\nHost: example.test\\r\\nContent-Length: 4\\r\\n\\r\\n",
    b"HTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n",
    10,
    limits(),
  )
}

effect fn runZeroRequestBound() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut serverLimits = limits()
  serverLimits.maxRequestsPerConnection = usize.ZERO
  return run runMatrixCase(
    b"GET /not-read HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n",
    b"",
    11,
    serverLimits,
  )
}

effect fn runCloseDelimitedResponse() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"GET /close HTTP/1.1\\r\\nHost: example.test\\r\\n\\r\\n",
    b"HTTP/1.1 200 OK\\r\\nConnection: close\\r\\n\\r\\nbye",
    12,
    limits(),
  )
}

effect fn runBodyFailureProgress() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  return run runMatrixCase(
    b"POST /bad HTTP/1.1\\r\\nHost: example.test\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\nZ\\r\\n",
    b"",
    13,
    limits(),
  )
}

effect fn recoverServer(error: ServerError | BufferError | OutOfMemoryError) -> i32 {
  drop error
  return 51
}

effect fn allCases() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let validated = runLimitValidation()
  if validated != 0 { return validated }
  let mut acquisitionLimits = limits()
  acquisitionLimits.maxRequestsPerConnection = 2
  let acquisition = run runMatrixCase(
    b"POST /oom HTTP/1.1\\r\\nHost: example.test\\r\\nContent-Length: 4\\r\\n\\r\\nBODY",
    b"",
    14,
    acquisitionLimits,
  )
  if acquisition != 0 { return acquisition }
  let normal = run runServer()
  if normal != 0 { return normal }
  let expectation = run runExpectation()
  if expectation != 0 { return expectation }
  let rejected = run runRejectedExpectation()
  if rejected != 0 { return rejected }
  let zero = run runFixedZero()
  if zero != 0 { return zero }
  let reuse = run runCoalescedReuse()
  if reuse != 0 { return reuse }
  let fixed = run runFixedResponse()
  if fixed != 0 { return fixed }
  let chunked = run runChunkedResponse()
  if chunked != 0 { return chunked }
  let informational = run runInformationalBudget()
  if informational != 0 { return informational }
  let discarded = run runChunkedDiscard()
  if discarded != 0 { return discarded }
  let recovered = run runPreOutputRecovery()
  if recovered != 0 { return recovered }
  let partial = run runPostOutputFailure()
  if partial != 0 { return partial }
  let upgraded = run runUpgradeHandoff()
  if upgraded != 0 { return upgraded }
  let tunneled = run runTunnelHandoff()
  if tunneled != 0 { return tunneled }
  let http10 = run runHttp10KeepAlive()
  if http10 != 0 { return http10 }
  let unread = run runUnreadBodyClose()
  if unread != 0 { return unread }
  let zeroRequests = run runZeroRequestBound()
  if zeroRequests != 0 { return zeroRequests }
  let bodyFailure = run runBodyFailureProgress()
  if bodyFailure != 0 { return bodyFailure }
  return run runCloseDelimitedResponse()
}

pub fn main() -> i32 { return run Effect.catchAll(allCases(), recoverServer) }
`
