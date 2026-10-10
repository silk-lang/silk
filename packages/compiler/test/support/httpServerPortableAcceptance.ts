/**
 * Compact backend-portability canary for the streaming HTTP server.
 *
 * The native corpus owns the exhaustive protocol, failure, and lifecycle matrix. This source keeps
 * only the lowering-sensitive generic provider, scoped-borrow, incremental input, and response
 * writer path that must also agree on WebAssembly.
 */
export const httpServerPortableAcceptanceSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.buffered_input {BufferError}
import silk.byte_duplex {ByteDuplex}
import silk.bytes {Bytes}
import silk.effect {Effect}
import silk.http {Header, ResponseHead, Status, Version}
import silk.http_body {Limits as BodyLimits, TrailerPolicy}
import silk.http_head {Limits as HeadLimits}
import silk.http_headers {Headers, Limits as ValueLimits}
import silk.http_server {
  BodyMode,
  Connection,
  ConnectionHandler,
  Limits,
  Request,
  ResponseWriter,
  ReusePolicy,
  ServerError,
  finishConnection,
  readSome,
  respond,
  withConnection,
  withRequest,
}
import silk.memory_byte_duplex {
  MemoryByteDuplex,
  MemoryByteDuplexPhase,
  MemoryReadEvent,
  MemoryWriteAction,
  MemoryWriteEvent,
}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.usize
import silk.vector {Vector}

struct FixedClock {}
struct NormalHandler {}

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

fn equal(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

effect fn splitProvider(firstBytes: &[u8], secondBytes: &[u8])
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
  run Vector.append(&mut writes, MemoryWriteEvent {
    readyAt: SystemClock.make(0, 0),
    action: MemoryWriteAction.Accept {count: 256},
  })
  return run MemoryByteDuplex.make(move reads, move writes, 256, 32, Option.none<i32>())
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
  if code != 31 && code != 32 && code != 33 && code != 34 {
    run finishConnection(&mut connection.*, 16, SystemClock.make(7, 9))
  }
  return code
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

effect fn program() -> i32 ! ServerError | BufferError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut transport = run splitProvider(
    b"POST / HTTP/1.1\\r",
    b"\\nHost: example.test\\r\\nContent-Length: 4\\r\\n\\r\\nWiki",
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

effect fn recover(error: ServerError | BufferError | OutOfMemoryError) -> i32 {
  drop error
  return 51
}

pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }
`
