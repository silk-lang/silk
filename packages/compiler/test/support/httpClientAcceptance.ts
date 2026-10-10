/** Portable client acceptance for owned reuse, staging, bounded reads, deadlines, and tunnels. */
import {
  tlsClientRsaRootPem,
  tlsClientRsaWrongNameClientHello,
  tlsClientRsaWrongNameServerFlight,
} from './tlsClientAcceptance.js'
import {
  httpProxyPolicyImports,
  httpProxyPolicySupport,
  verifyProxyPolicy,
} from './httpProxyAcceptance.js'

const silkBytes = (bytes: Uint8Array): string =>
  `b"${[...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`

interface Scenario {
  readonly id: number
  /** Omitted when the program's witness slot handles the scenario before any exchange starts. */
  readonly callback?: string
}

const protocol: ReadonlyArray<Scenario> = [
  { id: 0, callback: 'exchange' },
  { id: 1, callback: 'continueExchange' },
  { id: 2, callback: 'earlyExchange' },
  { id: 3, callback: 'chunkedExchange' },
  { id: 4, callback: 'tunnelExchange' },
  { id: 5, callback: 'abandonExchange' },
  { id: 7, callback: 'upgradeExchange' },
  { id: 11, callback: 'discardExchange' },
  { id: 17, callback: 'failExchange' },
  { id: 22 },
  { id: 23 },
  { id: 24, callback: 'discardExchange' },
  { id: 25, callback: 'discardExchange' },
]
const boundaries: ReadonlyArray<Scenario> = [
  { id: 6, callback: 'receiveBoundaryExchange' },
  { id: 8, callback: 'deadlineExchange' },
  { id: 10, callback: 'receiveBoundaryExchange' },
  { id: 12, callback: 'receiveBoundaryExchange' },
  { id: 13, callback: 'deadlineExchange' },
]
const outputFailures: ReadonlyArray<Scenario> = [
  { id: 9, callback: 'partialExchange' },
  { id: 18, callback: 'outputTimeoutExchange' },
  { id: 19, callback: 'flushFailureExchange' },
  { id: 20, callback: 'flushFailureExchange' },
  { id: 21, callback: 'flushFailureExchange' },
]

const protocolHandler = `impl ConnectionHandler<TestTransport, i32, ClientError | OutOfMemoryError | CallbackFailure ? &mut Allocator | &mut MonotonicClock | &mut Random> for Handler {
  effect<'call> fn handle<'call>(handler: Self, connection: &'call mut Connection<TestTransport>) -> i32
  ! ClientError | OutOfMemoryError | CallbackFailure
  ? &mut Allocator | &mut MonotonicClock | &mut Random {
    let Handler {request, scenario} = move handler
    if scenario == 17 {
      let attempted = run Effect.result(
        invokeExchange(&mut connection.*, &request, RequestOptions.defaults(), scenario),
      )
      match move attempted {
        Result.Success {value} => {
          drop value
          return 124
        }
        Result.Failure {error} => match move error {
          CallbackFailure cause => {
            if cause.code != 739 || connection.phase() != ConnectionPhase.Closed {
              return 125
            }
            fail move cause
          }
          ClientError cause => {
            fail move cause
          }
          OutOfMemoryError allocation => {
            fail move allocation
          }
        }
      }
    }
    if scenario == 1 {
      let selectedOptions = RequestOptions {
        deadline: Option.none<Instant>(),
        continuePolicy: ContinuePolicy.Require100 {deadline: SystemClock.make(10, 0)},
      }
      let result = run invokeExchange(
        &mut connection.*,
        &request,
        move selectedOptions,
        scenario,
      )
      if result != 0 {
        return result
      }
      return 0
    }
    if scenario == 2 {
      let selectedOptions = RequestOptions {
        deadline: Option.none<Instant>(),
        continuePolicy: ContinuePolicy.Require100 {deadline: SystemClock.make(10, 0)},
      }
      let result = run invokeExchange(
        &mut connection.*,
        &request,
        move selectedOptions,
        scenario,
      )
      if result != 0 {
        return result
      }
      if connection.phase() != ConnectionPhase.Closed {
        return 18
      }
      return 0
    }
    if scenario == 3 {
      let selectedOptions = RequestOptions.defaults()
      let result = run invokeExchange(
        &mut connection.*,
        &request,
        move selectedOptions,
        scenario,
      )
      if result != 0 {
        return result
      }
      return 0
    }
    if scenario == 4 {
      let selectedOptions = RequestOptions.defaults()
      let result = run invokeExchange(
        &mut connection.*,
        &request,
        move selectedOptions,
        scenario,
      )
      if result != 0 {
        return result
      }
      if connection.phase() != ConnectionPhase.Closed {
        return 18
      }
      return 0
    }
    if scenario == 5 {
      let selectedOptions = RequestOptions.defaults()
      let result = run invokeExchange(
        &mut connection.*,
        &request,
        move selectedOptions,
        scenario,
      )
      if result != 0 {
        return result
      }
      if connection.phase() != ConnectionPhase.Closed {
        return 18
      }
      return 0
    }
    if scenario == 7 {
      let selectedOptions = RequestOptions.defaults()
      let result = run invokeExchange(
        &mut connection.*,
        &request,
        move selectedOptions,
        scenario,
      )
      if result != 0 {
        return result
      }
      if connection.phase() != ConnectionPhase.Closed {
        return 18
      }
      return 0
    }
    if scenario == 11 || scenario == 24 || scenario == 25 {
      let result = run invokeExchange(
        &mut connection.*,
        &request,
        RequestOptions.defaults(),
        scenario,
      )
      if result != 0 {
        return result
      }
      if scenario != 11 && connection.phase() != ConnectionPhase.Closed {
        return 18
      }
      return 0
    }
    let options = RequestOptions {
      deadline: Option.none<Instant>(),
      continuePolicy: ContinuePolicy.Disabled,
    }
    let result = run invokeExchange(&mut connection.*, &request, move options, scenario)
    if result != 200 {
      return result
    }
    if connection.phase() != ConnectionPhase.Ready {
      return 12
    }
    let options2 = RequestOptions {
      deadline: Option.none<Instant>(),
      continuePolicy: ContinuePolicy.Disabled,
    }
    let second = run invokeExchange(&mut connection.*, &request, move options2, scenario)
    if second != 404 {
      return second
    }
    return 0
  }
}`

const boundaryHandler = `impl ConnectionHandler<TestTransport, i32, ClientError | OutOfMemoryError | CallbackFailure ? &mut Allocator | &mut MonotonicClock | &mut Random> for Handler {
  effect<'call> fn handle<'call>(handler: Self, connection: &'call mut Connection<TestTransport>) -> i32
  ! ClientError | OutOfMemoryError | CallbackFailure
  ? &mut Allocator | &mut MonotonicClock | &mut Random {
    let Handler {request, scenario} = move handler
    let mut options = RequestOptions.defaults()
    if scenario == 1 || scenario == 2 || scenario == 10 || scenario == 19 {
      options.continuePolicy = ContinuePolicy.Require100 {deadline: SystemClock.make(10, 0)}
    }
    if scenario == 13 || scenario == 18 {
      options.deadline = Option.some<Instant>(SystemClock.make(5, 0))
    }
    let attempted = run Effect.result(
      invokeExchange(&mut connection.*, &request, move options, scenario),
    )
    let result = match move attempted {
      Result.Success {value} => value
      Result.Failure {error} => match move error {
        CallbackFailure cause => {
          if scenario == 17 && (cause.code != 739 || connection.phase() != ConnectionPhase.Closed) {
            return 125
          }
          fail move cause
        }
        ClientError cause => {
          fail move cause
        }
        OutOfMemoryError allocation => {
          fail move allocation
        }
      }
    }
    if scenario == 17 {
      return 124
    }
    if scenario == 0 {
      if result != 200 {
        return result
      }
      if connection.phase() != ConnectionPhase.Ready {
        return 12
      }
      let second = run invokeExchange(
        &mut connection.*,
        &request,
        RequestOptions.defaults(),
        scenario,
      )
      if second != 404 {
        return second
      }
      return 0
    }
    if result != 0 {
      return result
    }
    if scenario == 18 {
      if connection.phase() != ConnectionPhase.Closed {
        return 128
      }
    } else if scenario == 19 || scenario == 20 || scenario == 21 {
      if connection.phase() != ConnectionPhase.Closed {
        return 132
      }
    } else if scenario == 2 || scenario == 4 || scenario == 5 || scenario == 6 || scenario == 7 || scenario == 8 || scenario == 9 || scenario == 10 || scenario == 12 || scenario == 13 {
      if connection.phase() != ConnectionPhase.Closed {
        return 18
      }
    }
    return 0
  }
}`

/**
 * Optional source slots spliced into the shared client program. Named slots keep each fragment in
 * its intended position; the transport hooks run inside the scripted `TestTransport` methods.
 */
interface ProgramSlots {
  readonly imports?: string
  readonly support?: string
  readonly witness?: string
  readonly transportFields?: string
  readonly httpReadHook?: string
  readonly httpWriteHook?: string
  readonly byteWriteHook?: string
  readonly byteReadHook?: string
  readonly byteFlushHook?: string
  readonly byteShutdownHook?: string
  readonly byteCloseHook?: string
}

// Each program retains only its selected callback graph; provider and assertions stay shared.
const sourceFor = (
  scenarios: ReadonlyArray<Scenario>,
  handler: string,
  {
    imports: routeImports = '',
    support: routeSupport = '',
    witness: routeWitness = '',
    transportFields: routeTransportFields = '',
    httpReadHook: routeHttpReadHook = '',
    httpWriteHook: routeHttpWriteHook = '',
    byteWriteHook: routeByteWriteHook = '',
    byteReadHook: routeByteReadHook = '',
    byteFlushHook: routeByteFlushHook = '',
    byteShutdownHook: routeByteShutdownHook = '',
    byteCloseHook: routeByteCloseHook = '',
  }: ProgramSlots = {},
): string => `import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ByteDuplex, ByteIoError, ByteIoOperation, ReadTransfer}
import silk.effect {Effect}
import silk.http {Method, Version, Header}
import silk.http_target {RequestTarget}
import silk.http_body {BodyComponent, BodyReason, Limits as BodyLimits, Trailers}
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
  ConnectionPhase,
  DiscardOutcome,
  RequestOptions,
  ContinuePolicy,
  Tunnel,
  TransferredTunnel,
}
import silk.http_client as Client
import silk.http_transport {HttpTransport, TransportError}
import silk.monotonic_clock {MonotonicClock}
import silk.random {Random}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.uri {Uri}
import silk.u64
import silk.usize
${routeImports}

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

// Only the fixed scripts used below are modeled; accepted bytes are counted, not retained.
struct TestTransport {
  scenario: i32
  input: &'static [u8]
  readOffset: usize
  writeOrdinal: usize
  accepted: usize
  closeCount: usize
  shutdownCount: usize
  writeShutdown: bool
  closed: bool
${routeTransportFields}
}

fn reached(now: &Instant, target: &Instant) -> bool {
  if SystemClock.seconds(now) > SystemClock.seconds(target) {
    return true
  }
  if SystemClock.seconds(now) < SystemClock.seconds(target) {
    return false
  }
  return SystemClock.nanoseconds(now) >= SystemClock.nanoseconds(target)
}

effect fn checkTransportDeadline(deadline: &Option<Instant>, operation: ByteIoOperation) -> ()
! TransportError
? &mut MonotonicClock {
  let now = run MonotonicClock.now()
  if let Option<Instant>.Some {value} = &deadline.* {
    if reached(&now, &value) {
      fail TransportError.Plain {error: ByteIoError.Timeout {operation: move operation}}
    }
  }
  return ()
}

impl HttpTransport for TestTransport {
  effect fn readSomeRaw(self: &mut Self, output: &mut [u8], deadline: Option<Instant>) -> ReadTransfer
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    if output.length == usize.ZERO {
      return ReadTransfer.Data {count: usize.ZERO}
    }
    if self.closed {
      fail TransportError.Plain {error: ByteIoError.Closed {operation: ByteIoOperation.Read}}
    }
    run checkTransportDeadline(&deadline, ByteIoOperation.Read)
    if self.scenario == 10 {
      let ready = SystemClock.make(20, 0)
      if let Option<Instant>.Some {value} = &deadline {
        if reached(&ready, &value) {
          run MonotonicClock.waitUntil(
            SystemClock.make(SystemClock.seconds(&value), SystemClock.nanoseconds(&value)),
          )
          fail TransportError.Plain {error: ByteIoError.Timeout {operation: ByteIoOperation.Read}}
        }
      }
      let now = run MonotonicClock.now()
      if !reached(&now, &ready) {
        run MonotonicClock.waitUntil(move ready)
      }
      return ReadTransfer.End
    }
    if self.readOffset == self.input.length {
      return ReadTransfer.End
    }
    let mut count = self.input.length - self.readOffset
    if count > output.length {
      count = output.length
    }
    let mut index = usize.ZERO
    while index < count {
      output[index] = self.input[self.readOffset + index]
      index = index + usize.ONE
    }
    self.readOffset = self.readOffset + count
${routeHttpReadHook}
    return ReadTransfer.Data {count: count}
  }
  effect fn writeSomeRaw(self: &mut Self, input: &[u8], deadline: Option<Instant>) -> usize
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    if input.length == usize.ZERO {
      return usize.ZERO
    }
    if self.closed {
      fail TransportError.Plain {error: ByteIoError.Closed {operation: ByteIoOperation.Write}}
    }
    run checkTransportDeadline(&deadline, ByteIoOperation.Write)
${routeHttpWriteHook}
    let ordinal = self.writeOrdinal
    self.writeOrdinal = ordinal + usize.ONE
    let mut maximum: usize = 256
    let mut exhausted = ordinal >= 16
    let mut failed = false
    if self.scenario == 9 {
      if ordinal == usize.ONE {
        maximum = 2
      }
      failed = ordinal == 2
      exhausted = ordinal >= 3
    } else if self.scenario == 10 {
      exhausted = ordinal >= usize.ONE
    } else if self.scenario == 18 {
      maximum = 2
      exhausted = ordinal >= usize.ONE
    } else if self.scenario == 21 {
      if ordinal == 2 {
        maximum = 2
      }
      failed = ordinal == 3
      exhausted = ordinal >= 4
    }
    if failed || exhausted {
      self.closed = true
      let mut code = 1
      if failed {
        code = 88
      }
      fail TransportError.Plain {
        error: ByteIoError.Provider {operation: ByteIoOperation.Write, code: code},
      }
    }
    let mut count = input.length
    if count > maximum {
      count = maximum
    }
    let mut capacity: usize = 256
    if self.scenario == 22 { capacity = 512 }
    if count > capacity - self.accepted {
      self.closed = true
      fail TransportError.Plain {
        error: ByteIoError.Provider {operation: ByteIoOperation.Write, code: 2},
      }
    }
    self.accepted = self.accepted + count
    if self.scenario == 18 {
      run MonotonicClock.waitUntil(SystemClock.make(5, 0))
    }
    return count
  }
  effect fn flush(self: &mut Self, deadline: Option<Instant>) -> ()
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    if self.scenario == 19 || self.scenario == 20 {
      fail TransportError.Plain {
        error: ByteIoError.Provider {operation: ByteIoOperation.Flush, code: 93},
      }
    }
    if self.closed {
      fail TransportError.Plain {error: ByteIoError.Closed {operation: ByteIoOperation.Flush}}
    }
    run checkTransportDeadline(&deadline, ByteIoOperation.Flush)
    return ()
  }
  effect fn close(self: &mut Self) -> () ! TransportError {
    if self.closed {
      return ()
    }
    self.closed = true
    self.closeCount = self.closeCount + usize.ONE
    return ()
  }
}

effect fn checkByteDeadline(deadline: &Option<Instant>, operation: ByteIoOperation) -> ()
! ByteIoError
? &mut MonotonicClock {
  let now = run MonotonicClock.now()
  if let Option<Instant>.Some {value} = &deadline.* {
    if reached(&now, &value) {
      fail ByteIoError.Timeout {operation: move operation}
    }
  }
  return ()
}

impl TestTransport {
  unsafe effect fn readBytes(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    if output.length == usize.ZERO {
      return ReadTransfer.Data {count: usize.ZERO}
    }
    if self.closed {
      fail ByteIoError.Closed {operation: ByteIoOperation.Read}
    }
    run checkByteDeadline(&deadline, ByteIoOperation.Read)
    if self.readOffset == self.input.length {
      return ReadTransfer.End
    }
    let mut count = self.input.length - self.readOffset
    if count > output.length {
      count = output.length
    }
    let mut index = usize.ZERO
    while index < count {
      output[index] = self.input[self.readOffset + index]
      index = index + usize.ONE
    }
    self.readOffset = self.readOffset + count
${routeByteReadHook}
    return ReadTransfer.Data {count: count}
  }

  unsafe effect fn writeBytes(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize ! ByteIoError ? &mut MonotonicClock {
    if input.length == usize.ZERO {
      return usize.ZERO
    }
    if self.closed || self.writeShutdown {
      fail ByteIoError.Closed {operation: ByteIoOperation.Write}
    }
    run checkByteDeadline(&deadline, ByteIoOperation.Write)
${routeByteWriteHook}
    self.writeOrdinal = self.writeOrdinal + usize.ONE
    let mut capacity: usize = 256
    if self.scenario == 22 { capacity = 512 }
    if input.length > capacity - self.accepted {
      self.closed = true
      fail ByteIoError.Provider {operation: ByteIoOperation.Write, code: 2}
    }
    self.accepted = self.accepted + input.length
    return input.length
  }

  unsafe effect fn flushBytes(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    if self.closed || self.writeShutdown {
      fail ByteIoError.Closed {operation: ByteIoOperation.Flush}
    }
    run checkByteDeadline(&deadline, ByteIoOperation.Flush)
${routeByteFlushHook}
    return ()
  }

  unsafe effect fn shutdownBytes(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    if self.closed {
      fail ByteIoError.Closed {operation: ByteIoOperation.ShutdownWrite}
    }
    if self.writeShutdown {
      return ()
    }
    run checkByteDeadline(&deadline, ByteIoOperation.ShutdownWrite)
${routeByteShutdownHook}
    self.writeShutdown = true
    self.shutdownCount = self.shutdownCount + usize.ONE
    return ()
  }

  unsafe effect fn closeBytes(self: &mut Self) -> () ! ByteIoError {
    if self.closed {
      return ()
    }
${routeByteCloseHook}
    self.closed = true
    self.closeCount = self.closeCount + usize.ONE
    return ()
  }
}

impl ByteDuplex for TestTransport {
  readSomeRaw: TestTransport.readBytes
  writeSomeRaw: TestTransport.writeBytes
  flushRaw: TestTransport.flushBytes
  shutdownWriteRaw: TestTransport.shutdownBytes
  closeRaw: TestTransport.closeBytes
}

${routeSupport}

struct CallbackFailure {
  code: i32
}

struct Handler {
  request: PreparedRequest
  scenario: i32
}

${handler}

// One callback identity shares the exchange bracket across runtime scenarios.
service Scenario {
  effect fn selected() -> i32 ? &Scenario
}
struct SelectedScenario {
  value: i32
}
impl Scenario for SelectedScenario {
  effect fn selected(self: &Self) -> i32 {
    return self.value
  }
}

effect fn invokeExchange(
  connection: &mut Connection<TestTransport>,
  request: &PreparedRequest,
  options: RequestOptions,
  scenario: i32,
) -> i32 ! ClientError | OutOfMemoryError | CallbackFailure
? &mut Allocator | &mut MonotonicClock | &mut Random {
  let selected = SelectedScenario {value: scenario}
  return run Client.withExchange(&mut connection.*, request, move options, dispatchExchange)
    |> Effect.provide<Scenario>(&selected)
}

effect<'call> fn dispatchExchange<'call, 'exchange: 'call>(
  value: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ! ClientError | OutOfMemoryError | CallbackFailure
? &Scenario | &mut Allocator | &mut MonotonicClock | &mut Random {
  let scenario = run Scenario.selected()
${scenarios
  .flatMap(({ id, callback }) =>
    callback === undefined
      ? []
      : [
          `  if scenario == ${id} {
    return run ${callback}(&mut value.*)
  }`,
        ],
  )
  .join('\n')}
  return 143
}

effect<'call> fn exchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
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
  if status != 200 && status != 404 {
    return 21
  }
  let mut bytes: [u8; 4] = [0, 0, 0, 0]
  let count = run Client.readSome(&mut exchangeValue.*, &mut bytes)
  if count != 4 || bytes[0] != 87 || bytes[3] != 105 {
    return 22
  }
  run Client.finishResponse(&mut exchangeValue.*)
  if status == 200 {
    return 200
  }
  return 404
}

effect fn runOwned(transport: TestTransport, origin: Origin, scenario: i32, handler: Handler) -> i32
! ClientError | OutOfMemoryError | CallbackFailure
? &mut Allocator | &mut MonotonicClock | &mut Random {
  if scenario == 0 {
    let mut owner = run Client.makeOwned(
      move transport,
      origin,
      Version.Http11,
      limits(),
      Option.none<Instant>(),
    )
    let result = run Effect.result(
      ConnectionHandler<TestTransport, i32, ClientError | OutOfMemoryError | CallbackFailure ? &mut Allocator | &mut MonotonicClock | &mut Random>.handle(
        move handler,
        &mut owner,
      ),
    )
    let closed = run Effect.result(Client.close(&mut owner))
    drop closed
    return match move result {
      Result.Success {value} => value
      Result.Failure {error} => {
        fail move error
      }
    }
  }
  let mut selectedLimits = limits()
  if scenario == 6 {
    selectedLimits.maxInformationalResponses = usize.ONE
  }
  if scenario == 12 {
    selectedLimits.maxInformationalWireBytes = 10
  }
  let mut overall = Option.none<Instant>()
  if scenario == 8 {
    overall = Option.some<Instant>(SystemClock.make(0, 0))
  }
  return run Client.withOwned(
    move transport,
    origin,
    Version.Http11,
    selectedLimits,
    move overall,
    move handler,
  )
}

effect fn runCase(scenario: i32) -> i32 ! ClientError | RequestError | OutOfMemoryError {
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
  let headerEntries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&headerEntries, valueLimits()) {
    Result.Failure {error} => {
      drop error
      return 32
    }
    Result.Success {value} => value
  }
  let policy = HeaderPolicy.defaults()
  let origin = match move Origin.fromUri(&uri) {
    Result.Failure {error} => {
      drop error
      return 33
    }
    Result.Success {value} => value
  }
  let mut method = Method.get()
  if scenario == 4 {
    method = Method.connect()
  } else if scenario == 1 || scenario == 2 || scenario == 3 || scenario == 9 || scenario == 10 || scenario == 19 || scenario == 20 || scenario == 21 {
    method = Method.post()
  }
  let mut targetText = "/"
  if scenario == 4 {
    targetText = "example.test:80"
  }
  let target = match move RequestTarget.parse(&method, targetText, 128) {
    Result.Failure {error} => {
      drop error
      return 34
    }
    Result.Success {value} => value
  }
  let mut mode = BodyMode.Empty
  if scenario == 3 || scenario == 20 || scenario == 21 {
    mode = BodyMode.Chunked
  } else if scenario == 1 || scenario == 2 || scenario == 9 || scenario == 10 || scenario == 19 || scenario == 20 {
    mode = BodyMode.KnownLength {length: 4}
  }
  let request = run Request.prepare(
    &origin,
    Version.Http11,
    method,
    target,
    &headers,
    &policy,
    mode,
    scenario == 1 || scenario == 2 || scenario == 10 || scenario == 19,
    valueLimits(),
    1024,
    512,
  )
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut input = inputFor(scenario)
  if scenario == 9 || scenario == 10 || scenario == 18 || scenario == 21 { input = b"" }
  let adapter = TestTransport {
    scenario: scenario,
    input: input,
    readOffset: usize.ZERO,
    writeOrdinal: usize.ZERO,
    accepted: usize.ZERO,
    closeCount: usize.ZERO,
    shutdownCount: usize.ZERO,
    writeShutdown: false,
    closed: false,
${routeTransportFields.length > 0 ? '    routeAudit: Option.none<Shared<RouteAudit>>(),' : ''}
  }
${routeWitness}
  let handler = Handler {request: move request, scenario: scenario}
  let attempted = run Effect.result(runOwned(move adapter, origin, scenario, move handler))
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let code = match move attempted {
    Result.Success {value} => value
    Result.Failure {error} => match move error {
      CallbackFailure cause => {
        if scenario != 17 || cause.code != 739 {
          return 126
        }
        return 0
      }
      ClientError cause => {
        fail move cause
      }
      OutOfMemoryError allocation => {
        fail move allocation
      }
    }
  }
  if code != 0 {
    return code
  }
  if scenario == 17 {
    return 127
  }
  return 0
}

effect<'call> fn failExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ! CallbackFailure {
  drop exchangeValue
  fail CallbackFailure {code: 739}
}

effect<'call> fn continueExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  run Client.send(&mut exchangeValue.*)
  let observed1 = run Client.receive(&mut exchangeValue.*)
  if observed1 != 103 {
    return 63
  }
  let observed2 = run Client.receive(&mut exchangeValue.*)
  if observed2 != 100 {
    return 64
  }
  let progress = run Client.writeSome(&mut exchangeValue.*, b"Wiki")
  if progress.consumed != 4 {
    return 65
  }
  let trailerEntries: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&trailerEntries, valueLimits()) {
    Result.Failure {error} => {
      drop error
      return 23
    }
    Result.Success {value} => value
  }
  run Client.finishRequest(&mut exchangeValue.*, &trailers)
  let observed3 = run Client.receive(&mut exchangeValue.*)
  if observed3 != 417 {
    return 66
  }
  let mut output: [u8; 1] = [0]
  let count = run Client.readSome(&mut exchangeValue.*, &mut output)
  if count != usize.ZERO {
    return 62
  }
  run Client.finishResponse(&mut exchangeValue.*)
  return 0
}

effect<'call> fn earlyExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  run Client.send(&mut exchangeValue.*)
  let observed4 = run Client.receive(&mut exchangeValue.*)
  if observed4 != 103 {
    return 67
  }
  let observed5 = run Client.receive(&mut exchangeValue.*)
  if observed5 != 417 {
    return 68
  }
  let rejected = run Effect.result(Client.writeSome(&mut exchangeValue.*, b"Wiki"))
  match move rejected {
    Result.Success {value} => {
      drop value
      return 69
    }
    Result.Failure {error} => match move error {
      ClientError cause => {
        if !invalidState(move cause) {
          return 70
        }
      }
      OutOfMemoryError allocation => {
        fail move allocation
      }
    }
  }
  let mut output: [u8; 1] = [0]
  let count = run Client.readSome(&mut exchangeValue.*, &mut output)
  if count != usize.ZERO {
    return 62
  }
  run Client.finishResponse(&mut exchangeValue.*)
  return 0
}

effect<'call> fn chunkedExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  run Client.send(&mut exchangeValue.*)
  let progress = run Client.writeSome(&mut exchangeValue.*, b"Wiki")
  if progress.consumed != 4 {
    return 71
  }
  let trailerEntries: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&trailerEntries, valueLimits()) {
    Result.Failure {error} => {
      drop error
      return 23
    }
    Result.Success {value} => value
  }
  run Client.finishRequest(&mut exchangeValue.*, &trailers)
  let observed6 = run Client.receive(&mut exchangeValue.*)
  if observed6 != 200 {
    return 72
  }
  let mut body: [u8; 4] = [0, 0, 0, 0]
  let count = run Client.readSome(&mut exchangeValue.*, &mut body)
  if count != 4 || body[0] != 87 || body[3] != 105 {
    return 73
  }
  let mut empty: [u8; 1] = [0]
  let observed7 = run Client.readSome(&mut exchangeValue.*, &mut empty)
  if observed7 != usize.ZERO {
    return 74
  }
  let responseTrailers = run Client.trailers(&exchangeValue.*)
  match move responseTrailers {
    Option.None => {
      return 75
    }
    Option.Some {value} => {
      if Trailers.count(&value) != usize.ONE {
        return 76
      }
    }
  }
  run Client.finishResponse(&mut exchangeValue.*)
  return 0
}

effect<'call> fn tunnelExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
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
  let observed8 = run Client.receive(&mut exchangeValue.*)
  if observed8 != 204 {
    return 77
  }
  return run Client.withTunnel(&mut exchangeValue.*, tunnel)
}

effect<'call> fn tunnel<'call, 'tunnel: 'call>(channel: &'call mut Tunnel<'tunnel, TestTransport>) -> i32
! ClientError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock | &mut Random {
  return run Tunnel.transferByteDuplex(&mut channel.*, transferredTunnel)
}

effect<'call> fn transferredTunnel<'call, 'tunnel: 'call>(
  channel: &'call mut TransferredTunnel<'tunnel, TestTransport>,
) -> i32 ? &mut MonotonicClock {
  let mut output: [u8; 4] = [0, 0, 0, 0]
  let reading = ByteDuplex.readSome(&mut output, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut channel.*)
  let attempted = run Effect.result(move reading)
  return match move attempted {
    Result.Failure {error} => {
      drop error
      return 78
    }
    Result.Success {value} => match move value {
      ReadTransfer.End => 78
      ReadTransfer.Data {count} => {
        if count == 4 && output[0] == 84 && output[3] == 78 {
          return 0
        }
        return 79
      }
    }
  }
}

effect<'call> fn abandonExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
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
  let observed9 = run Client.receive(&mut exchangeValue.*)
  if observed9 != 200 {
    return 80
  }
  return 0
}

effect<'call> fn upgradeExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
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
  let result = run Effect.result(Client.receive(&mut exchangeValue.*))
  return match move result {
    Result.Success {value} => {
      drop value
      return 82
    }
    Result.Failure {error} => match move error {
      ClientError cause => match move cause {
        ClientError.UnsupportedUpgrade => 0
        _ => 83
      }
      OutOfMemoryError allocation => {
        fail move allocation
      }
    }
  }
}

effect<'call> fn flushFailureExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  let sent = run Effect.result(Client.send(&mut exchangeValue.*))
  match move sent {
    Result.Failure {error} => {
      return run checkFlushFailure(move error, false)
    }
    Result.Success {value} => {
      drop value
    }
  }
  let progress = run Client.writeSome(&mut exchangeValue.*, b"Wiki")
  if progress.consumed != 4 {
    return 133
  }
  let trailerEntries: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&trailerEntries, valueLimits()) {
    Result.Success {value} => value
    Result.Failure {error} => {
      drop error
      return 134
    }
  }
  let finished = run Effect.result(Client.finishRequest(&mut exchangeValue.*, &trailers))
  return match move finished {
    Result.Success {value} => {
      drop value
      return 135
    }
    Result.Failure {error} => {
      return run checkFlushFailure(move error, true)
    }
  }
}

effect fn checkFlushFailure(error: ClientError | OutOfMemoryError, finishing: bool) -> i32
! OutOfMemoryError {
  return match move error {
    OutOfMemoryError allocation => {
      fail move allocation
    }
    ClientError cause => match move cause {
      ClientError.Output {error: transport, progress} => {
        if progress.consumed != usize.ZERO || progress.written == usize.ZERO {
          return 136
        }
        if finishing && (progress.totalPayload != 4 || progress.totalWire != 14) {
          return 137
        }
        return match move transport {
          TransportError.Plain {error: plain} => match move plain {
            ByteIoError.Provider {operation, code} => {
              if operation == ByteIoOperation.Write && code == 88 {
                if !finishing || progress.written != 2 {
                  return 142
                }
                return 0
              }
              if operation != ByteIoOperation.Flush || code != 93 || (finishing && progress.written != 5) {
                return 138
              }
              return 0
            }
            _ => 139
          }
          _ => 140
        }
      }
      _ => 141
    }
  }
}

effect<'call> fn outputTimeoutExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  let result = run Effect.result(Client.send(&mut exchangeValue.*))
  return match move result {
    Result.Success {value} => {
      drop value
      return 129
    }
    Result.Failure {error} => match move error {
      ClientError cause => match move cause {
        ClientError.OutputTimeout {progress} => {
          if progress.written != 2 || progress.totalWire != 2 || progress.consumed != usize.ZERO {
            return 130
          }
          return 0
        }
        _ => 131
      }
      OutOfMemoryError allocation => {
        fail move allocation
      }
    }
  }
}

effect<'call> fn receiveBoundaryExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32
! ClientError | OutOfMemoryError
? &Scenario | &mut Allocator | &mut MonotonicClock | &mut Random {
  let scenario = run Scenario.selected()
  run Client.send(&mut exchangeValue.*)
  if scenario != 10 {
    let trailerEntries: [Header<'static>; 0] = []
    let trailers = match move Headers.make(&trailerEntries, valueLimits()) {
      Result.Failure {error} => {
        drop error
        return 23
      }
      Result.Success {value} => value
    }
    run Client.finishRequest(&mut exchangeValue.*, &trailers)
  }
  if scenario == 6 {
    let observed = run Client.receive(&mut exchangeValue.*)
    if observed != 103 {
      return 81
    }
  }
  let result = run Effect.result(Client.receive(&mut exchangeValue.*))
  return match move result {
    Result.Success {value} => {
      drop value
      if scenario == 6 {
        return 82
      }
      if scenario == 10 {
        return 92
      }
      return 95
    }
    Result.Failure {error} => match move error {
      ClientError cause => {
        let matched = match move cause {
          ClientError.ContinueTimeout => scenario == 10
          ClientError.LimitExceeded => scenario == 6 || scenario == 12
          _ => false
        }
        if matched {
          return 0
        }
        if scenario == 6 {
          return 83
        }
        if scenario == 10 {
          return 93
        }
        return 96
      }
      OutOfMemoryError allocation => {
        fail move allocation
      }
    }
  }
}


effect<'call> fn deadlineOperation<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
  stage: i32,
  output: &mut [u8],
) -> () ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  if stage == 0 {
    run Client.send(&mut exchangeValue.*)
  } else if stage == 1 {
    let count = run Client.readSome(&mut exchangeValue.*, move output)
    drop count
  } else {
    run Client.finishResponse(&mut exchangeValue.*)
  }
  return ()
}

effect<'call> fn deadlineExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32
! ClientError | OutOfMemoryError
? &Scenario | &mut Allocator | &mut MonotonicClock | &mut Random {
  let scenario = run Scenario.selected()
  let mut body: [u8; 4] = [0, 0, 0, 0]
  let mut stage = 0
  if scenario == 13 {
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
    if status != 200 {
      return 97
    }
    let read = run Client.readSome(&mut exchangeValue.*, &mut body)
    if read != 4 {
      return 98
    }
    run MonotonicClock.waitUntil(SystemClock.make(10, 0))
    stage = 1
  }
  while stage < 3 {
    let result = run Effect.result(deadlineOperation(&mut exchangeValue.*, stage, &mut body))
    match move result {
      Result.Success {value} => {
        drop value
        if stage == 0 {
          return 84
        }
        if stage == 1 {
          return 99
        }
        return 101
      }
      Result.Failure {error} => match move error {
        OutOfMemoryError allocation => {
          fail move allocation
        }
        ClientError cause => {
          let expected = match move cause {
            ClientError.Timeout => stage == 0 || stage == 1
            ClientError.InvalidState => stage == 2
            _ => false
          }
          if !expected {
            if stage == 0 {
              return 85
            }
            if stage == 1 {
              return 100
            }
            return 102
          }
        }
      }
    }
    if stage == 0 {
      return 0
    }
    stage = stage + 1
  }
  return 0
}

effect<'call> fn partialExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  run Client.send(&mut exchangeValue.*)
  let result = run Effect.result(Client.writeSome(&mut exchangeValue.*, b"Wiki"))
  return match move result {
    Result.Success {value} => {
      drop value
      return 86
    }
    Result.Failure {error} => match move error {
      OutOfMemoryError allocation => {
        fail move allocation
      }
      ClientError cause => match move cause {
        ClientError.Output {error: transport, progress} => {
          if progress.consumed != 4 || progress.written != 2 || progress.totalPayload != 4 {
            return 87
          }
          return match move transport {
            TransportError.Plain {error: plain} => match move plain {
              ByteIoError.Provider {operation, code} => {
                if code == 88 {
                  return 0
                }
                return 88
              }
              _ => 89
            }
            _ => 90
          }
        }
        _ => 91
      }
    }
  }
}

effect<'call> fn discardExchange<'call, 'exchange: 'call>(
  exchangeValue: &'call mut Exchange<'exchange, TestTransport>,
) -> i32
! ClientError | OutOfMemoryError
? &Scenario | &mut Allocator | &mut MonotonicClock | &mut Random {
  let scenario = run Scenario.selected()
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
  if scenario == 11 {
    if status != 200 {
      return 94
    }
    run Client.discardRemaining(&mut exchangeValue.*, 4)
    run Client.finishResponse(&mut exchangeValue.*)
    return 0
  }
  let budget = u64.toU64(4)
  let attempted = run Effect.result(Client.discardRemainingAtMost(
    &mut exchangeValue.*,
    budget,
    Option.none<Instant>(),
  ))
  return match move attempted {
    Result.Success {value} => match move value {
      DiscardOutcome.CapReached => {
        if scenario == 24 { return 0 }
        return 158
      }
      DiscardOutcome.Completed => 159
    }
    Result.Failure {error} => match move error {
      ClientError cause => match move cause {
        ClientError.Body {error: body} => match move body.reason {
          BodyReason.ChunkSyntax => match move body.component {
            BodyComponent.ChunkDelimiter => {
              if scenario == 25 { return 0 }
              return 160
            }
            _ => 161
          }
          _ => 162
        }
        _ => 163
      }
      OutOfMemoryError allocation => {
        fail move allocation
      }
    }
  }
}


fn invalidState(error: ClientError) -> bool {
  return match move error {
    ClientError.InvalidState => true
    _ => false
  }
}

fn inputFor(scenario: i32) -> &'static [u8] {

  if scenario == 1 {
    return b"HTTP/1.1 103 Early Hints\\r\\n\\r\\nHTTP/1.1 100 Continue\\r\\n\\r\\nHTTP/1.1 417 Rejected\\r\\nContent-Length: 0\\r\\n\\r\\n"
  }
  if scenario == 2 {
    return b"HTTP/1.1 103 Early Hints\\r\\n\\r\\nHTTP/1.1 417 Rejected\\r\\nContent-Length: 0\\r\\n\\r\\n"
  }
  if scenario == 3 {
    return b"HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\nTrailer: Content-Digest\\r\\n\\r\\n4\\r\\nWiki\\r\\n0\\r\\nContent-Digest: yes\\r\\n\\r\\n"
  }
  if scenario == 4 {
    return b"HTTP/1.1 204 Connected\\r\\nContent-Length: ignored\\r\\nTransfer-Encoding: ignored\\r\\n\\r\\nTUNN"
  }
  if scenario == 6 || scenario == 12 {
    return b"HTTP/1.1 103 Hint\\r\\n\\r\\nHTTP/1.1 103 Hint\\r\\n\\r\\n"
  }
  if scenario == 7 {
    return b"HTTP/1.1 101 Switching\\r\\n\\r\\n"
  }
  if scenario == 24 {
    return b"HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n1\\r\\nx\\r\\n0\\r\\n\\r\\n"
  }
  if scenario == 25 {
    return b"HTTP/1.1 200 OK\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n1\\r\\nxX"
  }
  return b"HTTP/1.1 200 OK\\r\\nContent-Length: 4\\r\\n\\r\\nWikiHTTP/1.1 404 Not Found\\r\\nContent-Length: 4\\r\\n\\r\\nWiki"
}

effect fn allCases() -> i32 ! ClientError | RequestError | OutOfMemoryError {
  let scenarios: [i32; ${scenarios.length}] = [${scenarios.map(({ id }) => id).join(', ')}]
  let mut index = usize.ZERO
  while index < ${scenarios.length} {
    let result = run runCase(scenarios[index])
    if result != 0 {
      return result
    }
    index = index + usize.ONE
  }
  return 0
}

effect fn recover(error: ClientError | RequestError | OutOfMemoryError) -> i32 {
  drop error
  return 51
}

pub fn main() -> i32 {
  return run Effect.catchAll(allCases(), recover)
}
`

const routedConnectHead = Buffer.from(
  'CONNECT wrong.example:443 HTTP/1.1\r\nProxy-Authorization: Basic dXNlcjpwYXNz\r\nHost: wrong.example:443\r\nUser-Agent: silk-http/1\r\nAccept: */*\r\n\r\n',
)
const routedServerInput = Buffer.concat([
  Buffer.from('HTTP/1.1 299 Connection Established\r\n\r\n'),
  tlsClientRsaWrongNameServerFlight,
])
const proxyLifecycleHead = Buffer.from('HTTP/1.1 204 Connection Established\r\n\r\n')
const proxyLifecycleInput = Buffer.concat([proxyLifecycleHead, Buffer.from('MORE')])
const proxyHeadLimitInput = Buffer.from(
  `HTTP/1.1 407 Proxy Authentication Required\r\nProxy-Authenticate: Basic ${'a'.repeat(140)}\r\n\r\n`,
)

const routeTransportFields = `  routeAudit: Option<Shared<RouteAudit>>`
const routeHttpReadHook = `    recordRouteConnectAccepted(
      &self.routeAudit,
      self.input,
      self.readOffset,
    )`
const routeHttpWriteHook = `    if !recordRouteOutput(&self.routeAudit, input) {
      self.closed = true
      fail TransportError.Plain {
        error: ByteIoError.Provider {operation: ByteIoOperation.Write, code: 122},
      }
    }`
const routeByteWriteHook = `    if !recordRouteTlsOutput(&self.routeAudit, self.scenario, input) {
      self.closed = true
      fail ByteIoError.Provider {operation: ByteIoOperation.Write, code: 122}
    }`
const routeByteReadHook = `    recordProxyConcreteRead(&self.routeAudit, self.scenario)`
const routeByteFlushHook = `    recordProxyConcreteFlush(&self.routeAudit, self.scenario)`
const routeByteShutdownHook = `    recordProxyConcreteShutdown(&self.routeAudit, self.scenario)`
const routeByteCloseHook = `    if recordProxyConcreteClose(&self.routeAudit, self.scenario) {
      fail ByteIoError.Provider {operation: ByteIoOperation.Close, code: 811}
    }`

const routeImports = `${httpProxyPolicyImports}
import silk.https_identity {IdentityError}
import silk.http_head {ParseLimitKind, ParseReason}
import silk.http_client {
  AcquiredRouteContext,
  RouteClient,
  RouteHandler,
  RouteProtocol,
  RouteSettings,
  RouteTransport,
}
import silk.shared {Shared}
import silk.tls_client {CertificateIdentityFailure, ClientLimits, TlsError}
import silk.tls_connection as Tls {ConnectionError}
import silk.trust_snapshot {TrustLoadLimits, TrustSnapshot, TrustSourceError}
import silk.u8
`

const routeSupport = `${httpProxyPolicySupport}
${verifyProxyPolicy}

struct RouteAudit {
  output: [u8; 512]
  outputLength: usize
  connectAccepted: bool
  handlerCount: usize
  publicationCount: usize
  concreteReadCount: usize
  concreteWriteCount: usize
  concreteFlushCount: usize
  concreteShutdownCount: usize
  concreteCloseCount: usize
  rejectedExchangeCallbackCount: usize
}

fn emptyRouteAudit() -> RouteAudit {
  return RouteAudit {
    output: [${Array.from({ length: 512 }, () => 0).join(', ')}],
    outputLength: usize.ZERO,
    connectAccepted: false,
    handlerCount: usize.ZERO,
    publicationCount: usize.ZERO,
    concreteReadCount: usize.ZERO,
    concreteWriteCount: usize.ZERO,
    concreteFlushCount: usize.ZERO,
    concreteShutdownCount: usize.ZERO,
    concreteCloseCount: usize.ZERO,
    rejectedExchangeCallbackCount: usize.ZERO,
  }
}

fn appendRouteOutput(state: &mut RouteAudit, input: &[u8]) -> bool {
  if input.length > 512 - state.outputLength { return false }
  let mut index = usize.ZERO
  while index < input.length {
    state.output[state.outputLength + index] = input[index]
    index = index + usize.ONE
  }
  state.outputLength = state.outputLength + input.length
  return true
}

fn recordRouteOutput(audit: &Option<Shared<RouteAudit>>, input: &[u8]) -> bool {
  return match & audit.* {
    Option.None => true
    Option.Some {value} => Shared.withMut<RouteAudit, bool>(&value, fn(state: &mut RouteAudit) -> bool {
      return appendRouteOutput(&mut state.*, input)
    })
  }
}

fn recordRouteTlsOutput(
  audit: &Option<Shared<RouteAudit>>,
  scenario: i32,
  input: &[u8],
) -> bool {
  return match & audit.* {
    Option.None => true
    Option.Some {value} => Shared.withMut<RouteAudit, bool>(&value, fn(state: &mut RouteAudit) -> bool {
      if scenario == 23 {
        state.concreteWriteCount = state.concreteWriteCount + usize.ONE
        return true
      }
      if !state.connectAccepted { return false }
      return appendRouteOutput(&mut state.*, input)
    })
  }
}

fn recordProxyConcreteRead(audit: &Option<Shared<RouteAudit>>, scenario: i32) -> () {
  if scenario != 23 { return () }
  match & audit.* {
    Option.None => {}
    Option.Some {value} => Shared.withMut<RouteAudit, ()>(&value, fn(state: &mut RouteAudit) -> () {
      state.concreteReadCount = state.concreteReadCount + usize.ONE
      return ()
    })
  }
  return ()
}

fn recordProxyConcreteFlush(audit: &Option<Shared<RouteAudit>>, scenario: i32) -> () {
  if scenario != 23 { return () }
  match & audit.* {
    Option.None => {}
    Option.Some {value} => Shared.withMut<RouteAudit, ()>(&value, fn(state: &mut RouteAudit) -> () {
      state.concreteFlushCount = state.concreteFlushCount + usize.ONE
      return ()
    })
  }
  return ()
}

fn recordProxyConcreteShutdown(audit: &Option<Shared<RouteAudit>>, scenario: i32) -> () {
  if scenario != 23 { return () }
  match & audit.* {
    Option.None => {}
    Option.Some {value} => Shared.withMut<RouteAudit, ()>(&value, fn(state: &mut RouteAudit) -> () {
      state.concreteShutdownCount = state.concreteShutdownCount + usize.ONE
      return ()
    })
  }
  return ()
}

fn recordProxyConcreteClose(audit: &Option<Shared<RouteAudit>>, scenario: i32) -> bool {
  if scenario != 23 { return false }
  return match & audit.* {
    Option.None => false
    Option.Some {value} => Shared.withMut<RouteAudit, bool>(&value, fn(state: &mut RouteAudit) -> bool {
      state.concreteCloseCount = state.concreteCloseCount + usize.ONE
      return true
    })
  }
}

fn recordRouteConnectAccepted(
  audit: &Option<Shared<RouteAudit>>,
  input: &[u8],
  readOffset: usize,
) -> () {
  let head = b"HTTP/1.1 299 Connection Established\\r\\n\\r\\n"
  if readOffset < head.length || !sameRouteBytes(input, usize.ZERO, head) { return () }
  match & audit.* {
    Option.None => {}
    Option.Some {value} => Shared.withMut<RouteAudit, ()>(&value, fn(state: &mut RouteAudit) -> () {
      state.connectAccepted = true
      return ()
    })
  }
  return ()
}

enum RouteAcquisitionError { Failed }

struct ScriptedRouteClient<A, E, ?R> {
  provider: TestTransport
  settingsValue: RouteSettings
}

impl<A, E, ?R> ScriptedRouteClient<A, E, R> {
  fn settings(client: &Self) -> RouteSettings {
    return client.settingsValue
  }

  effect<'env> fn acquire<'env>(client: Self, peer: Origin, deadline: Option<Instant>) -> A
  ! E | RouteAcquisitionError
  ? R | &mut AcquiredRouteContext<TestTransport, A, E ? R>
  where R in Without<R, ByteDuplex>, R in Without<R, HttpTransport> {
    drop peer
    drop deadline
    let ScriptedRouteClient<A, E, R> {provider, settingsValue} = move client
    drop settingsValue
    return run AcquiredRouteContext.use<TestTransport, A, E, R>(move provider)
  }
}

impl<A, E, ?R> RouteClient<TestTransport, A, E, RouteAcquisitionError, never ? R> for ScriptedRouteClient<
  A,
  E,
  R,
> {
  settings: ScriptedRouteClient.settings
  acquire: ScriptedRouteClient.acquire
}

struct RoutedNoop { audit: Option<Shared<RouteAudit>> }

impl RoutedNoop {
  effect<'call> fn handle<
    'configuration,
    'call,
    'transport: 'call,
    'provider: 'transport,
    'tunnel: 'provider,
  >(
    handler: Self,
    route: Route<'configuration>,
    connection: &'call mut Connection<
      RouteTransport<'transport, 'provider, 'tunnel, TestTransport>,
    >,
  ) -> i32 {
    if let Option.Some {value} = &handler.audit {
      Shared.withMut<RouteAudit, ()>(&value, fn(state: &mut RouteAudit) -> () {
        state.handlerCount = state.handlerCount + usize.ONE
        return ()
      })
    }
    drop handler
    drop route
    drop connection
    return 0
  }
}

impl<'configuration> RouteHandler<'configuration, TestTransport, i32, never ? never> for RoutedNoop {
  handle: RoutedNoop.handle
}

struct RouteRandom { filled: usize }

impl Random for RouteRandom {
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

struct RouteWallClock {}

impl RouteWallClock {
  effect fn now(self: &mut Self) -> Instant {
    return SystemClock.make(1789156800, 123456789)
  }

  effect fn resolution(self: &mut Self) -> u64 {
    return u64.toU64(1)
  }
}

impl SystemClock for RouteWallClock {
  now: RouteWallClock.now
  getResolution: RouteWallClock.resolution
}

fn routeInput() -> &'static [u8] {
  return ${silkBytes(routedServerInput)}
}

fn sameRouteBytes(actual: &[u8], offset: usize, expected: &[u8]) -> bool {
  if expected.length > actual.length - offset { return false }
  let mut index = usize.ZERO
  while index < expected.length {
    if actual[offset + index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

fn sameRouteHello(actual: &[u8], offset: usize, expected: &[u8]) -> bool {
  if expected.length < 5 || offset + expected.length > actual.length { return false }
  if actual[offset] != 22 || actual[offset + 1] != 3 || actual[offset + 2] != 3 {
    return false
  }
  if u8.toUsize(actual[offset + 3]) * 256 + u8.toUsize(actual[offset + 4]) + 5
    != expected.length { return false }
  let mut index: usize = 5
  while index < expected.length {
    if actual[offset + index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

fn routedAuditPassed(state: &RouteAudit) -> bool {
  let connect = ${silkBytes(routedConnectHead)}
  let hello = ${silkBytes(tlsClientRsaWrongNameClientHello)}
  let expected = connect.length + hello.length
  return state.outputLength == expected
    && sameRouteBytes(&state.output, usize.ZERO, connect)
    && sameRouteHello(&state.output, connect.length, hello)
    && state.connectAccepted
    && state.handlerCount == usize.ZERO
}

fn identityFailure(error: ConnectionError) -> bool {
  return match move error {
    ConnectionError.Tls {error: tls} => match move tls {
      TlsError.CertificateIdentity {error: certificate} => match move certificate {
        CertificateIdentityFailure.Match {error: identity} => match move identity {
          IdentityError.NoMatch => true
          _ => false
        }
        _ => false
      }
      _ => false
    }
    _ => false
  }
}

service ProxyLifecycle {
  effect fn audit() -> Shared<RouteAudit> ? &ProxyLifecycle
}

struct SelectedProxyLifecycle { value: Shared<RouteAudit> }

impl ProxyLifecycle for SelectedProxyLifecycle {
  effect fn audit(self: &Self) -> Shared<RouteAudit> {
    return Shared.clone<RouteAudit>(&self.value)
  }
}

fn proxyInvalidRequest(error: ClientError) -> bool {
  return match move error {
    ClientError.InvalidRequest => true
    _ => false
  }
}

fn proxyInvalidState(error: ClientError) -> bool {
  return match move error {
    ClientError.InvalidState => true
    _ => false
  }
}

fn proxyLifecycleAuditPassed(state: &RouteAudit) -> bool {
  return state.publicationCount == usize.ONE
    && state.concreteReadCount == usize.ONE
    && state.concreteWriteCount == usize.ONE
    && state.concreteFlushCount == 2
    && state.concreteShutdownCount == usize.ONE
    && state.concreteCloseCount == usize.ONE
    && state.rejectedExchangeCallbackCount == usize.ZERO
}

fn proxyNoOutputOrCallback(state: &RouteAudit) -> bool {
  return state.outputLength == usize.ZERO
    && state.rejectedExchangeCallbackCount == usize.ZERO
}

effect<'call> fn rejectedProxyExchange<'call, 'exchange: 'call>(
  exchange: &'call mut Exchange<'exchange, TestTransport>,
) -> i32 ? &ProxyLifecycle {
  drop exchange
  let audit = run ProxyLifecycle.audit()
  Shared.withMut<RouteAudit, ()>(&audit, fn(state: &mut RouteAudit) -> () {
    state.rejectedExchangeCallbackCount = state.rejectedExchangeCallbackCount + usize.ONE
    return ()
  })
  return 161
}

effect<'call> fn unexpectedProxyPublication<'call, 'tunnel: 'call>(
  channel: &'call mut TransferredTunnel<'tunnel, TestTransport>,
) -> i32 ? &ProxyLifecycle {
  drop channel
  let audit = run ProxyLifecycle.audit()
  Shared.withMut<RouteAudit, ()>(&audit, fn(state: &mut RouteAudit) -> () {
    state.publicationCount = state.publicationCount + usize.ONE
    return ()
  })
  return 162
}

effect<'call> fn exerciseProxyDuplex<'call, 'tunnel: 'call>(
  channel: &'call mut TransferredTunnel<'tunnel, TestTransport>,
) -> i32 ! CallbackFailure ? &ProxyLifecycle | &mut MonotonicClock {
  let audit = run ProxyLifecycle.audit()
  Shared.withMut<RouteAudit, ()>(&audit, fn(state: &mut RouteAudit) -> () {
    state.publicationCount = state.publicationCount + usize.ONE
    return ()
  })

  let writing = ByteDuplex.writeSome(b"PING", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut channel.*)
  match move run Effect.result(move writing) {
    Result.Failure {error} => { return 163 }
    Result.Success {value} => {
      if value != 4 { return 164 }
    }
  }
  let flushing = ByteDuplex.flush(Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut channel.*)
  let flushed = run Effect.result(move flushing)
  if let Result.Failure {error} = move flushed {
    drop error
    return 165
  }
  let shutdown = ByteDuplex.shutdownWrite(Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut channel.*)
  let shutDown = run Effect.result(move shutdown)
  if let Result.Failure {error} = move shutDown {
    drop error
    return 166
  }

  let mut remaining: [u8; 4] = [0, 0, 0, 0]
  let remainingRead = ByteDuplex.readSome(&mut remaining, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut channel.*)
  match move run Effect.result(move remainingRead) {
    Result.Failure {error} => { return 167 }
    Result.Success {value} => match move value {
      ReadTransfer.End => { return 168 }
      ReadTransfer.Data {count} => {
        if count != 4 || remaining[0] != 77 || remaining[3] != 69 { return 169 }
      }
    }
  }
  fail CallbackFailure {code: 811}
}

effect<'call> fn exerciseProxyTunnel<'call, 'tunnel: 'call>(
  channel: &'call mut Tunnel<'tunnel, TestTransport>,
) -> i32 ! ClientError | CallbackFailure ? &ProxyLifecycle | &mut MonotonicClock {
  let first = run Effect.result(
    Tunnel.transferByteDuplex(&mut channel.*, exerciseProxyDuplex),
  )
  let original = match move first {
    Result.Success {value} => { return 173 }
    Result.Failure {error} => match move error {
      CallbackFailure cause => move cause
      ClientError cause => { return 175 }
    }
  }
  if original.code != 811 { return 174 }
  let repeated = run Effect.result(
    Tunnel.transferByteDuplex(&mut channel.*, unexpectedProxyPublication),
  )
  match move repeated {
    Result.Success {value} => { return 176 }
    Result.Failure {error} => {
      if !proxyInvalidState(move error) { return 177 }
    }
  }
  fail move original
}

effect<'call> fn exerciseProxyConnect<'call, 'exchange: 'call>(
  exchange: &'call mut Exchange<'exchange, TestTransport>,
) -> i32
! ClientError | OutOfMemoryError | CallbackFailure
? &ProxyLifecycle | &mut Allocator | &mut MonotonicClock | &mut Random {
  run Client.send(&mut exchange.*)
  let emptyEntries: [Header<'static>; 0] = []
  let empty = match move Headers.make(&emptyEntries, valueLimits()) {
    Result.Failure {error} => { return 178 }
    Result.Success {value} => value
  }
  run Client.finishRequest(&mut exchange.*, &empty)
  let status = run Client.receive(&mut exchange.*)
  if status != 204 { return 179 }
  return run Client.withTunnel(&mut exchange.*, exerciseProxyTunnel)
}

struct ProxyLifecycleHandler {
  ordinary: PreparedRequest
  connect: PreparedRequest
  audit: Shared<RouteAudit>
}

impl ProxyLifecycleHandler {
  effect<'call> fn handle<'call>(
    handler: Self,
    connection: &'call mut Connection<TestTransport>,
  ) -> i32
  ! ClientError | OutOfMemoryError | CallbackFailure
  ? &mut Allocator | &mut MonotonicClock | &mut Random {
    let ProxyLifecycleHandler {ordinary, connect, audit} = move handler
    let selected = SelectedProxyLifecycle {value: Shared.clone<RouteAudit>(&audit)}
    let rejected = Client.withExchange(
      &mut connection.*,
      &ordinary,
      RequestOptions.defaults(),
      rejectedProxyExchange,
    ) |> Effect.provide<ProxyLifecycle>(&selected)
    match move run Effect.result(move rejected) {
      Result.Success {value} => { return 180 }
      Result.Failure {error} => match move error {
        ClientError cause => {
          if !proxyInvalidRequest(move cause) { return 181 }
        }
        OutOfMemoryError allocation => { fail move allocation }
      }
    }
    if !Shared.with<RouteAudit, bool>(&audit, proxyNoOutputOrCallback) { return 182 }
    let connected = Client.withExchange(
      &mut connection.*,
      &connect,
      RequestOptions.defaults(),
      exerciseProxyConnect,
    ) |> Effect.provide<ProxyLifecycle>(&selected)
    return run move connected
  }
}

impl ConnectionHandler<
  TestTransport,
  i32,
  ClientError | OutOfMemoryError | CallbackFailure
    ? &mut Allocator | &mut MonotonicClock | &mut Random
> for ProxyLifecycleHandler {
  handle: ProxyLifecycleHandler.handle
}

fn proxyLifecycleInput() -> &'static [u8] {
  return ${silkBytes(proxyLifecycleInput)}
}

fn proxyHeadLimitInput() -> &'static [u8] {
  return ${silkBytes(proxyHeadLimitInput)}
}

fn proxyHeadFailure(error: ClientError) -> bool {
  return match move error {
    ClientError.Head {error: head} => match move head.reason {
      ParseReason.LimitExceeded {limit, allowed, attempted} => {
        return limit == ParseLimitKind.HeadBytes && allowed == 160 && attempted == 161
      }
      _ => false
    }
    _ => false
  }
}

effect<'call> fn receiveProxyHeadLimit<'call, 'exchange: 'call>(
  exchange: &'call mut Exchange<'exchange, TestTransport>,
) -> bool
! ClientError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock | &mut Random {
  run Client.send(&mut exchange.*)
  let entries: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&entries, valueLimits()) {
    Result.Success {value} => value
    Result.Failure {error} => { return false }
  }
  run Client.finishRequest(&mut exchange.*, &trailers)
  let status = run Client.receive(&mut exchange.*)
  drop status
  return false
}

struct ProxyHeadLimitHandler { request: PreparedRequest }

impl ProxyHeadLimitHandler {
  effect<'call> fn handle<'call>(
    handler: Self,
    connection: &'call mut Connection<TestTransport>,
  ) -> bool
  ! OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock | &mut Random {
    let attempted = run Effect.result(Client.withExchange(
      &mut connection.*,
      &handler.request,
      RequestOptions.defaults(),
      receiveProxyHeadLimit,
    ))
    return match move attempted {
      Result.Success {value} => false
      Result.Failure {error} => match move error {
        ClientError cause => proxyHeadFailure(move cause)
        OutOfMemoryError allocation => { fail move allocation }
      }
    }
  }
}

impl ConnectionHandler<
  TestTransport,
  bool,
  OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random
> for ProxyHeadLimitHandler {
  handle: ProxyHeadLimitHandler.handle
}

effect fn verifyProxyHeadLimit(
  request: PreparedRequest,
  peer: Origin,
) -> bool
! OutOfMemoryError
? &mut Allocator | &mut MonotonicClock | &mut Random {
  let provider = TestTransport {
    scenario: 23,
    input: proxyHeadLimitInput(),
    readOffset: usize.ZERO,
    writeOrdinal: usize.ZERO,
    accepted: usize.ZERO,
    closeCount: usize.ZERO,
    shutdownCount: usize.ZERO,
    writeShutdown: false,
    closed: false,
    routeAudit: Option.none<Shared<RouteAudit>>(),
  }
  let mut selectedLimits = limits()
  selectedLimits.head.maxHeadBytes = 160
  let attempted = run Effect.result(Client.withOwned(
    move provider,
    peer,
    Version.Http11,
    move selectedLimits,
    Option.none<Instant>(),
    ProxyHeadLimitHandler {request: move request},
  ))
  return match move attempted {
    Result.Success {value} => value
    Result.Failure {error} => match move error {
      OutOfMemoryError allocation => { fail move allocation }
      ClientError cause => false
    }
  }
}

effect fn routedProxyLifecycle() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let policyVerification = verifyProxyPolicy()
    |> Effect.provideMut<Allocator>(&mut allocator)
  if !run move policyVerification { return 183 }
  let audit = run Shared.make<RouteAudit>(emptyRouteAudit())
    |> Effect.provideMut<Allocator>(&mut allocator)
  let emptyOrigins: [Origin; 0] = []
  let bypass = match move run BypassPolicy.copy(&emptyOrigins)
    |> Effect.provideMut<Allocator>(&mut allocator) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 184 }
  }
  let authentication = match move run ProxyAuth.preparedBasic(
    ProxyAuthContextId.make(200),
    b"dXNlcjpwYXNz",
  ) |> Effect.provideMut<Allocator>(&mut allocator) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 185 }
  }
  let config = match move ProxyConfig.fromUri(
    ProxyConfigId.make(199),
    "http://proxy.example:3128",
    move authentication,
    move bypass,
    4096,
  ) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 186 }
  }
  let uri = match move Uri.parse("https://service.example/") {
    Result.Success {value} => value
    Result.Failure {error} => { return 187 }
  }
  let origin = match move Origin.fromUri(&uri) {
    Result.Success {value} => value
    Result.Failure {error} => { return 188 }
  }

  let mut clock = FixedClock {mark: SystemClock.make(0, 0)}
  let mut random = RouteRandom {filled: usize.ZERO}
  let headRoute = selectRoute(&config, origin)
  let headRequest = match move run Effect.result(prepareConnect(
    &headRoute,
    valueLimits(),
    1024,
    512,
  )) |> Effect.provideMut<Allocator>(&mut allocator) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 189 }
  }
  let headPeer = match move Route.physicalPeer(&headRoute) {
    Result.Success {value} => value
    Result.Failure {error} => { return 190 }
  }
  let bounded = run verifyProxyHeadLimit(move headRequest, headPeer)
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if !bounded { return 191 }

  let route = selectRoute(&config, origin)
  let connect = match move run Effect.result(prepareConnect(
    &route,
    valueLimits(),
    1024,
    512,
  )) |> Effect.provideMut<Allocator>(&mut allocator) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 192 }
  }
  let fields: [Header<'static>; 0] = []
  let headers = match move Headers.make(&fields, valueLimits()) {
    Result.Success {value} => value
    Result.Failure {error} => { return 193 }
  }
  let policy = HeaderPolicy.defaults()
  let ordinary = match move run Effect.result(Request.fromUri(
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
  )) |> Effect.provideMut<Allocator>(&mut allocator) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 194 }
  }
  let peer = match move Route.physicalPeer(&route) {
    Result.Success {value} => value
    Result.Failure {error} => { return 195 }
  }
  let provider = TestTransport {
    scenario: 23,
    input: proxyLifecycleInput(),
    readOffset: usize.ZERO,
    writeOrdinal: usize.ZERO,
    accepted: usize.ZERO,
    closeCount: usize.ZERO,
    shutdownCount: usize.ZERO,
    writeShutdown: false,
    closed: false,
    routeAudit: Option.some<Shared<RouteAudit>>(Shared.clone<RouteAudit>(&audit)),
  }
  let mut selectedLimits = limits()
  selectedLimits.readCapacity = ${proxyLifecycleHead.length}
  let attempted = run Effect.result(Client.withOwned(
    move provider,
    peer,
    Version.Http11,
    move selectedLimits,
    Option.none<Instant>(),
    ProxyLifecycleHandler {
      ordinary: move ordinary,
      connect: move connect,
      audit: Shared.clone<RouteAudit>(&audit),
    },
  ))
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let preserved = match move attempted {
    Result.Success {value} => false
    Result.Failure {error} => match move error {
      CallbackFailure cause => cause.code == 811
      _ => false
    }
  }
  if !preserved { return 196 }
  if !Shared.with<RouteAudit, bool>(&audit, proxyLifecycleAuditPassed) { return 197 }
  return 0
}

effect fn routedWrongName() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let audit = run Shared.make<RouteAudit>(emptyRouteAudit())
    |> Effect.provideMut<Allocator>(&mut allocator)
  let provider = TestTransport {
    scenario: 22,
    input: routeInput(),
    readOffset: usize.ZERO,
    writeOrdinal: usize.ZERO,
    accepted: usize.ZERO,
    closeCount: usize.ZERO,
    shutdownCount: usize.ZERO,
    writeShutdown: false,
    closed: false,
    routeAudit: Option.some<Shared<RouteAudit>>(Shared.clone<RouteAudit>(&audit)),
  }
  let empty: [Origin; 0] = []
  let bypass = match move run BypassPolicy.copy(&empty)
    |> Effect.provideMut<Allocator>(&mut allocator) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 151 }
  }
  let authentication = match move run ProxyAuth.preparedBasic(
    ProxyAuthContextId.make(100),
    b"dXNlcjpwYXNz",
  ) |> Effect.provideMut<Allocator>(&mut allocator) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 152 }
  }
  let config = match move ProxyConfig.fromUri(
    ProxyConfigId.make(99),
    "http://example.com",
    move authentication,
    move bypass,
    4096,
  ) {
    Result.Success {value} => move value
    Result.Failure {error} => { return 153 }
  }
  let target = match move Uri.parse("https://wrong.example/") {
    Result.Success {value} => value
    Result.Failure {error} => { return 154 }
  }
  let origin = match move Origin.fromUri(&target) {
    Result.Success {value} => value
    Result.Failure {error} => { return 155 }
  }
  let route = selectRoute(&config, origin)
  let trustResult = run TrustSnapshot.fromPem(
    ${silkBytes(tlsClientRsaRootPem)},
    TrustLoadLimits.defaults(),
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let trust = match move trustResult {
    Result<TrustSnapshot, TrustSourceError>.Success {value} => move value
    Result<TrustSnapshot, TrustSourceError>.Failure {error} => { return 156 }
  }
  let client = ScriptedRouteClient<
    i32,
    ProxyError | ClientError | ConnectionError | IdentityError | OutOfMemoryError,
    &mut Allocator | &mut MonotonicClock | &mut SystemClock | &mut Random,
  > {
    provider: move provider,
    settingsValue: RouteSettings {
      http: limits(),
      request: valueLimits(),
      maxRequestHeadBytes: 1024,
      maxProxyCredentialBytes: 512,
      protocol: RouteProtocol.Http10,
      tls: ClientLimits.defaults(),
      handshakeDurationNanoseconds: u64.toU64(30000000000),
    },
  }
  let mut wall = RouteWallClock {}
  let mut clock = FixedClock {mark: SystemClock.make(0, 0)}
  let mut random = RouteRandom {filled: usize.ZERO}
  let attempted = run Effect.result(Client.withRoute(
    move client,
    route,
    Option.some<TrustSnapshot>(move trust),
    Option.none<Instant>(),
    RoutedNoop {audit: Option.some<Shared<RouteAudit>>(Shared.clone<RouteAudit>(&audit))},
  ))
    |> Effect.provideMut<SystemClock>(&mut wall)
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let failedByIdentity = match move attempted {
    Result<i32, ProxyError | ClientError | ConnectionError | IdentityError | RouteAcquisitionError | OutOfMemoryError>.Success {value} => false
    Result<i32, ProxyError | ClientError | ConnectionError | IdentityError | RouteAcquisitionError | OutOfMemoryError>.Failure {error} => match move error {
      ConnectionError cause => identityFailure(move cause)
      _ => false
    }
  }
  if !failedByIdentity { return 157 }
  if !Shared.with<RouteAudit, bool>(&audit, routedAuditPassed) { return 158 }
  return 0
}

effect fn typecheckRoute(transport: TestTransport) -> i32
! ProxyError
  | ClientError
  | Tls.ConnectionError
  | IdentityError
  | RouteAcquisitionError
  | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock | &mut SystemClock | &mut Random {
  let empty: [Origin; 0] = []
  let bypass = match move run BypassPolicy.copy(&empty) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      fail move error
    }
  }
  let config = match move ProxyConfig.fromUri(
    ProxyConfigId.make(99),
    "http://proxy.example:3128",
    ProxyAuth.none(ProxyAuthContextId.make(100)),
    move bypass,
    4096,
  ) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      fail move error
    }
  }
  let target = match move Uri.parse("http://origin.example/") {
    Result.Success {value} => value
    Result.Failure {error} => {
      drop error
      return 141
    }
  }
  let origin = match move Origin.fromUri(&target) {
    Result.Success {value} => value
    Result.Failure {error} => {
      drop error
      return 142
    }
  }
  let route = selectRoute(&config, origin)
  let client = ScriptedRouteClient<
    i32,
    ProxyError | ClientError | ConnectionError | IdentityError | OutOfMemoryError,
    &mut Allocator | &mut MonotonicClock | &mut SystemClock | &mut Random,
  > {
    provider: move transport,
    settingsValue: RouteSettings {
      http: limits(),
      request: valueLimits(),
      maxRequestHeadBytes: 1024,
      maxProxyCredentialBytes: 512,
      protocol: RouteProtocol.OptionalHttp11,
      tls: ClientLimits.defaults(),
      handshakeDurationNanoseconds: u64.toU64(30000000000),
    },
  }
  return run Client.withRoute(
    move client,
    route,
    Option.none<TrustSnapshot>(),
    Option.none<Instant>(),
    RoutedNoop {audit: Option.none<Shared<RouteAudit>>()},
  )
}
`

const routeWitness = `  // Compile-only witness: the runtime corpus does not select this scenario.
  if scenario == -1 {
    let mut wall = RouteWallClock {}
    let attempted = run Effect.result(typecheckRoute(move adapter))
      |> Effect.provideMut<SystemClock>(&mut wall)
      |> Effect.provideMut<Random>(&mut random)
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Allocator>(&mut allocator)
    return match move attempted {
      Result.Success {value} => value
      Result.Failure {error} => {
        drop error
        return 140
      }
    }
  }
  if scenario == 22 {
    drop adapter
    return run routedWrongName()
  }
  if scenario == 23 {
    drop adapter
    return run routedProxyLifecycle()
  }`

const routeSlots: ProgramSlots = {
  imports: routeImports,
  support: routeSupport,
  witness: routeWitness,
  transportFields: routeTransportFields,
  httpReadHook: routeHttpReadHook,
  httpWriteHook: routeHttpWriteHook,
  byteWriteHook: routeByteWriteHook,
  byteReadHook: routeByteReadHook,
  byteFlushHook: routeByteFlushHook,
  byteShutdownHook: routeByteShutdownHook,
  byteCloseHook: routeByteCloseHook,
}

export const httpClientAcceptanceSource = sourceFor(protocol, protocolHandler, routeSlots)

/**
 * The LLVM-to-Wasm program omits scenario 22, the routed CONNECT tunnel with TLS origin
 * authentication, which traps with an out-of-bounds memory access on wasm32 (JUL-251).
 */
export const httpClientPortableAcceptanceSource = sourceFor(
  protocol.filter(({ id }) => id !== 22),
  protocolHandler,
  routeSlots,
)
export const httpClientBoundariesAcceptanceSource = sourceFor(boundaries, boundaryHandler)
export const httpClientOutputFailuresAcceptanceSource = sourceFor(outputFailures, boundaryHandler)
