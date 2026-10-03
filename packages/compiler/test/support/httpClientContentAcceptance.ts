/** Minimal client response-provenance integration, isolated from the codec matrix to bound compiler memory. */
export const httpClientContentAcceptanceSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ReadTransfer}
import silk.effect {Effect}
import silk.http {Header, Method, Version}
import silk.http_content {ContentReason, Limits, Mode}
import silk.http_headers {Headers, Limits as ValueLimits}
import silk.inflate {Limits as InflateLimits}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.usize
import silk.u64
import silk.zstd {ZstdLimits}
import silk.http_client as Client
import silk.http_client {
  Connection,
  ConnectionHandler,
  Exchange,
  Limits as ClientLimits,
  ClientError,
  ConnectionPhase,
  DiscardOutcome,
  RequestOptions,
  ReuseEligibility,
}
import silk.http_request as Request
import silk.http_request {PreparedRequest, HeaderPolicy, BodyMode, RequestError}
import silk.http_origin {Origin}
import silk.http_target {RequestTarget}
import silk.http_transport {HttpTransport, TransportError}
import silk.random {Random}
import silk.uri {Uri}

struct FixedClock {}

impl MonotonicClock for FixedClock {
  effect fn now(self: &mut Self) -> Instant {
    return SystemClock.make(0, 0)
  }
  effect fn getResolution(self: &mut Self) -> u64 {
    return 1
  }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () {
    drop when
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () {
    drop howLong
    return ()
  }
}

fn valueLimits() -> ValueLimits {
  return ValueLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 128,
    maxNameBytes: 64,
    maxValueBytes: 256,
    maxFields: 16,
    maxFieldBytes: 512,
    maxOwnedBytes: 2048,
  }
}

fn contentLimits() -> Limits {
  return Limits {
    maxEncoded: 2048,
    maxIntermediate: 4096,
    maxDecoded: 4096,
    maxOwned: 2097152,
    maxDepth: 4,
    intermediateCapacity: 8,
    inflate: InflateLimits {
      maxInputBytes: 2048,
      maxOutputBytes: 4096,
      maxMembers: 8,
      maxHeaderBytes: 512,
      maxMemoryBytes: 65536,
    },
    zstd: ZstdLimits {
      inputBytes: 2048,
      outputBytes: 4096,
      frames: 8,
      skippableBytes: 512,
      windowBytes: 1024,
      workspaceBytes: 1048576,
    },
  }
}

struct ClientContentTransport {
  input: &'static [u8]
  offset: usize
}

struct ClientContentRandom {}

impl Random for ClientContentRandom {
  effect fn fillBytes(self: &mut Self, output: &mut [u8]) -> () {
    drop output
    return ()
  }
}

impl HttpTransport for ClientContentTransport {
  effect fn readSomeRaw(self: &mut Self, output: &mut [u8], deadline: Option<Instant>) -> ReadTransfer
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    drop deadline
    if self.offset == self.input.length {
      return ReadTransfer.End
    }
    let mut count = usize.ZERO
    while count < output.length && self.offset < self.input.length {
      output[count] = self.input[self.offset]
      self.offset = self.offset + usize.ONE
      count = count + usize.ONE
    }
    return ReadTransfer.Data {count: count}
  }
  effect fn writeSomeRaw(self: &mut Self, input: &[u8], deadline: Option<Instant>) -> usize
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    drop deadline
    return input.length
  }
  effect fn flush(self: &mut Self, deadline: Option<Instant>) -> ()
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    drop deadline
    return ()
  }
  effect fn close(self: &mut Self) -> () ! TransportError {
    return ()
  }
}

struct ClientContentHandler {
  request: PreparedRequest
  corrupt: bool
}

impl ConnectionHandler<ClientContentTransport, i32, ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random> for ClientContentHandler {
  effect<'call> fn handle<'call>(
    handler: Self,
    connection: &'call mut Connection<ClientContentTransport>,
  ) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
    let ClientContentHandler {request, corrupt} = move handler
    let result = run Client.withExchange(
      &mut connection.*,
      &request,
      RequestOptions.defaults(),
      clientContentExchange,
    )
    if result != 0 {
      return result
    }
    let eligibility = Client.reuseEligibility(&connection.*)
    return match move eligibility {
      ReuseEligibility.Eligible => {
        if corrupt || connection.phase() != ConnectionPhase.Ready { return 412 }
        return 0
      }
      ReuseEligibility.NotReady => {
        if !corrupt || connection.phase() != ConnectionPhase.Closed { return 413 }
        return 0
      }
      _ => 418
    }
  }
}

fn clientInvalidState(error: ClientError) -> bool {
  return match move error {
    ClientError.InvalidState => true
    _ => false
  }
}

fn clientContentInput(corrupt: bool) -> &'static [u8] {
  if !corrupt {
    return b"HTTP/1.1 200 OK\\r\\nContent-Length: 25\\r\\nContent-Encoding: gzip\\r\\n\\r\\n\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\x4b\\xce\\xc9\\x2f\\x4e\\x05\\x00\\xc4\\x81\\x01\\x13\\x05\\x00\\x00\\x00"
  }
  return b"HTTP/1.1 201 Corrupt\\r\\nContent-Length: 25\\r\\nContent-Encoding: gzip\\r\\n\\r\\n\\x1f\\x8b\\x08\\x00\\x00\\x00\\x00\\x00\\x02\\xff\\x4b\\xce\\xc9\\x2f\\x4e\\x05\\x00\\xc5\\x81\\x01\\x13\\x05\\x00\\x00\\x00"
}

effect fn clientContentCase(corrupt: bool) -> i32
! ClientError | RequestError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock | &mut Random {
  let uri = match move Uri.parse("http://example.test/") {
    Result.Failure {error} => {
      drop error
      return 414
    }
    Result.Success {value} => value
  }
  let origin = match move Origin.fromUri(&uri) {
    Result.Failure {error} => {
      drop error
      return 415
    }
    Result.Success {value} => value
  }
  let method = Method.get()
  let target = match move RequestTarget.parse(&method, "/", 128) {
    Result.Failure {error} => {
      drop error
      return 416
    }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => {
      drop error
      return 417
    }
    Result.Success {value} => value
  }
  let policy = HeaderPolicy.defaults()
  let request = run Request.prepare(
    &origin,
    Version.Http11,
    method,
    target,
    &headers,
    &policy,
    BodyMode.Empty,
    false,
    valueLimits(),
    1024,
    512,
  )
  return run Client.withOwned(
    ClientContentTransport {input: clientContentInput(corrupt), offset: usize.ZERO},
    origin,
    Version.Http11,
    ClientLimits.defaults(),
    Option.none<Instant>(),
    ClientContentHandler {request: move request, corrupt: corrupt},
  )
}

effect fn clientContentCases() -> i32 ! ClientError | RequestError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let mut random = ClientContentRandom {}
  let valid = run clientContentCase(false)
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if valid != 0 {
    return valid
  }
  return run clientContentCase(true)
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
}

effect<'call> fn clientContentExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, ClientContentTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  run Client.send(&mut exchangeValue.*)
  let trailerEntries: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&trailerEntries, valueLimits()) {
    Result.Failure {error} => {
      drop error
      return 23
    }
    Result.Success {value} => value
  }
  run Client.finishRequest(&mut exchangeValue.*, &trailers)
  let status = run Client.receive(&mut exchangeValue.*)

  if status != 200 && status != 201 {
    return 107
  }
  let mut emptyOutput: [u8; 0] = []
  let rawNoOp = run Client.readSome(&mut exchangeValue.*, &mut emptyOutput)
  if rawNoOp != usize.ZERO {
    return 119
  }
  let selected = run Effect.result(
    Client.beginContent(&mut exchangeValue.*, Mode.Decode, contentLimits()),
  )
  match move selected {
    Result.Success {value} => {
      drop value
    }
    Result.Failure {error} => {
      drop error
      return 108
    }
  }
  let contentNoOp = run Client.readContentSome(&mut exchangeValue.*, &mut emptyOutput)
  if contentNoOp.written != usize.ZERO || contentNoOp.totalEncoded != 0 || contentNoOp.totalDecoded != 0 {
    return 120
  }
  let repeated = run Effect.result(
    Client.beginContent(&mut exchangeValue.*, Mode.Decode, contentLimits()),
  )
  match move repeated {
    Result.Success {value} => {
      drop value
      return 109
    }
    Result.Failure {error} => {
      match move error {
        ClientError cause => {
          if !clientInvalidState(move cause) {
            return 110
          }
        }
        _ => {
          return 110
        }
      }
    }
  }
  let mut output: [u8; 5] = [0, 0, 0, 0, 0]
  let raw = run Effect.result(Client.readSome(&mut exchangeValue.*, &mut output))
  match move raw {
    Result.Success {value} => {
      drop value
      return 112
    }
    Result.Failure {error} => match move error {
      ClientError cause => {
        if !clientInvalidState(move cause) {
          return 113
        }
      }
      OutOfMemoryError allocation => {
        fail move allocation
      }
    }
  }
  let attempted = run Effect.result(Client.drainAndFinishAtMost(
    &mut exchangeValue.*,
    u64.toU64(65536),
    SystemClock.make(10, 0),
  ))
  return match move attempted {
    Result.Success {value} => match move value {
      DiscardOutcome.Completed => {
        if status == 201 { return 118 }
        return 0
      }
      DiscardOutcome.CapReached => 119
    }
    Result.Failure {error} => run clientContentFailure(move error, status)
  }
}

effect fn clientContentFailure(error: ClientError | OutOfMemoryError, status: u16) -> i32
! OutOfMemoryError {
  return match move error {
    OutOfMemoryError allocation => {
      fail move allocation
    }
    ClientError cause => match move cause {
      ClientError.Content {error: content} => {
        if status != 201 {
          return 114
        }
        return match move content.reason {
          ContentReason.Inflate {stage, wireIndex, error: codec} => {
            drop codec
            return 0
          }
          _ => 115
        }
      }
      _ => 116
    }
  }
}

effect fn failed(error: ClientError | RequestError | OutOfMemoryError) -> i32 {
  drop error
  return 99
}

pub fn main() -> i32 {
  return run Effect.catchAll(clientContentCases(), failed)
}
`
