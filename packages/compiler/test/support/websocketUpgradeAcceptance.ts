const positiveCase = `  let runtime0 = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nOrigin: https://example.test\\r\\nSec-WebSocket-Protocol: ignored\\r\\nSec-WebSocket-Protocol: chat\\r\\nSec-WebSocket-Extensions: permessage-deflate\\r\\n\\r\\n\\x81\\x85\\x37\\xfa\\x21\\x3d\\x7f\\x9f\\x4d\\x51\\x58\\x89\\x82\\x01\\x02\\x03\\x04\\x49\\x6b\\x8a\\x82\\x09\\x0a\\x0b\\x0c\\x66\\x61\\x88\\x82\\x05\\x06\\x07\\x08\\x06\\xee", b"HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\\r\\nSec-WebSocket-Protocol: chat\\r\\nSet-Cookie: a=1\\r\\nSet-Cookie: b=2\\r\\nConnection: upgrade\\r\\n\\r\\n\\x81\\x05Hello\\x8a\\x02Hi\\x88\\x02\\x03\\xe8", 0)
  if runtime0 != 0 { return runtime0 }`

/** Consolidated WebSocket handshake validation and scoped portable duplex acceptance. */
export const websocketUpgradeAcceptanceSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.buffered_input {BufferError}
import silk.buffered_duplex {BufferedDuplex}
import silk.byte_duplex {ByteDuplex, ByteIoError, ByteIoOperation, ReadTransfer}
import silk.bytes {Bytes}
import silk.effect {Effect}
import silk.execution { Execution, Wake }
import silk.shared {Shared}
import silk.http {Header, Status}
import silk.http_body {Limits as BodyLimits}
import silk.http_head {Limits as HeadLimits, RequestParser}
import silk.http_headers {Headers, Limits as ValueLimits}
import silk.http_server {Connection, ConnectionHandler, Limits as ServerLimits, Request, ServerError, withConnection, withRequest}
import silk.monotonic_clock {MonotonicClock}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.usize
import silk.slice {Slice}
import silk.websocket_server as WebSocketServer {Event as SocketEvent, Limits as SocketLimits, PeerCloseData as SocketCloseData, ServerWebSocket, State as SocketState, WebSocketError}
import silk.websocket_upgrade {Decision, DecisionHandler, DecisionReason, LimitKind, Limits, Offer, Outcome, UpgradeError, inspect, reject, rejectionStatus, withUpgrade}

struct FixedClock {}
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

fn serverLimits() -> ServerLimits {
  return ServerLimits {
    head: headLimits(),
    body: bodyLimits(),
    values: valueLimits(),
    readCapacity: 512,
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

effect fn inspection(input: &[u8], configured: Limits, expected: u16) -> i32
! OutOfMemoryError ? &mut Allocator {
  let made = run RequestParser.make(headLimits())
  let mut parser = match move made {
    Result.Failure {error} => { drop error return 101 }
    Result.Success {value} => move value
  }
  match move RequestParser.feed(&mut parser, input, true) {
    Result.Failure {error} => { drop error return 102 }
    Result.Success {value} => { drop value }
  }
  let head = match move RequestParser.head(&parser) {
    Result.Failure {error} => { drop error return 103 }
    Result.Success {value} => value
  }
  return match move inspect(&head, configured) {
    Result.Failure {error} => {
      let status = rejectionStatus(&error)
      if expected != 413 && status != expected { return 112 }
      return match move error {
      UpgradeError.Validation {reason} => { drop reason if expected == 400 { return 0 } return 104 }
      UpgradeError.UnsupportedVersion {supported} => { if expected == 426 && supported == 13 { return 0 } return 105 }
      UpgradeError.Limit {kind} => { drop kind if expected == 413 { return 0 } return 106 }
      _ => 107
      }
    }
    Result.Success {value: offer} => {
      if expected != 101 { return 108 }
      let mut accept: [u8; 28] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
      match move Offer.acceptInto(&offer, &mut accept) {
        Result.Failure {error} => { drop error return 109 }
        Result.Success {value} => { if value != 28 { return 110 } }
      }
      if !equal(&accept, b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo=") { return 111 }
      return 0
    }
  }
}

effect fn inspectCases() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let case0 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", Limits.default(), 101)
  if case0 != 0 { return 1 }
  let case1 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 12\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", Limits.default(), 426)
  if case1 != 0 { return 2 }
  let case2 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 013\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", Limits.default(), 400)
  if case2 != 0 { return 3 }
  let case3 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 256\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", Limits.default(), 400)
  if case3 != 0 { return 4 }
  let case4 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZR==\\r\\n\\r\\n", Limits.default(), 400)
  if case4 != 0 { return 5 }
  let case5 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: Zg==\\r\\n\\r\\n", Limits.default(), 400)
  if case5 != 0 { return 6 }
  let case6 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", Limits.default(), 400)
  if case6 != 0 { return 7 }
  let case7 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nOrigin: https://example.test\\r\\nOrigin: https://example.test\\r\\n\\r\\n", Limits.default(), 400)
  if case7 != 0 { return 8 }
  let case8 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: chat\\r\\nSec-WebSocket-Protocol: chat\\r\\n\\r\\n", Limits.default(), 400)
  if case8 != 0 { return 9 }
  let case9 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: close, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", Limits.default(), 400)
  if case9 != 0 { return 10 }
  let case10 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nContent-Length: 1\\r\\n\\r\\n", Limits.default(), 400)
  if case10 != 0 { return 11 }
  let case11 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Extensions: permessage-deflate; mode=\\"a\\\\b\\"\\r\\n\\r\\n", Limits.default(), 101)
  if case11 != 0 { return 12 }
  let case12 = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Extensions: permessage-deflate; =x\\r\\n\\r\\n", Limits.default(), 400)
  if case12 != 0 { return 13 }
  let emptyOriginHost = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nOrigin: https://:443\\r\\n\\r\\n", Limits.default(), 400)
  if emptyOriginHost != 0 { return 21 }
  let mut bounded = Limits.default()
  bounded.maxProtocols = usize.ZERO
  let protocols = run inspection(b"GET /chat HTTP/1.1\\r\\nHost: example.test\\r\\nConnection: keep-alive, Upgrade\\r\\nUpgrade: WebSocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: chat\\r\\n\\r\\n", bounded, 413)
  if protocols != 0 { return 20 }
  return 0
}

fn deadline() -> Option<Instant> { return Option.some<Instant>(SystemClock.make(7, 9)) }
fn sameDeadline(value: &Option<Instant>) -> bool {
  return match &value.* {
    Option.None => false
    Option.Some {value: instant} => SystemClock.seconds(&instant) == 7 && SystemClock.nanoseconds(&instant) == 9
  }
}
struct TransportAudit {closes: usize flushes: usize deadlines: bool complete: bool handoffs: usize}
service HandoffAudit {
  effect fn observe() -> bool ? &mut HandoffAudit
}
struct AuditProvider {state: Shared<TransportAudit>}
fn observeHandoff(state: &mut TransportAudit) -> bool {
  state.handoffs = state.handoffs + usize.ONE
  return state.handoffs == usize.ONE && state.flushes == usize.ONE
    && state.complete && state.closes == usize.ZERO
}
impl HandoffAudit for AuditProvider {
  effect fn observe(self: &mut Self) -> bool { return Shared.withMut(&self.state, observeHandoff) }
}
// Owned buffers are allocated once; this script only copies bytes and records calls.
struct ScriptedDuplex {
  first: Bytes remainder: Bytes output: Bytes readOffset: usize outputLength: usize
  mode: i32 writes: usize failed: bool writesAfterFailure: usize
  flushes: usize closed: bool closes: usize
}
impl ScriptedDuplex {
  fn outbound<'a>(self: &'a Self) -> &'a [u8] {
    return Slice.view<u8>(Bytes.asSlice(&self.output), usize.ZERO, self.outputLength)
  }
  unsafe effect fn read(self: &mut Self, output: &mut [u8], mark: Option<Instant>)
  -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    drop mark
    let firstLength = Bytes.length(&self.first)
    let mut source = Bytes.asSlice(&self.first)
    let mut offset = self.readOffset
    if offset >= firstLength {
      source = Bytes.asSlice(&self.remainder)
      offset = offset - firstLength
    }
    if offset >= source.length { return ReadTransfer.End }
    let mut count = source.length - offset
    if count > output.length { count = output.length }
    let mut index = usize.ZERO
    while index < count {
      output[index] = source[offset + index]
      index = index + usize.ONE
    }
    drop source
    self.readOffset = self.readOffset + count
    return ReadTransfer.Data {count: count}
  }
  unsafe effect fn write(self: &mut Self, input: &[u8], mark: Option<Instant>)
  -> usize ! ByteIoError ? &mut MonotonicClock {
    drop mark
    if self.failed { self.writesAfterFailure = self.writesAfterFailure + usize.ONE }
    self.writes = self.writes + usize.ONE
    if self.mode == 3 && self.writes > usize.ONE {
      self.failed = true
      fail ByteDuplex.provider(ByteIoOperation.Write, 73)
    }
    let mut count = input.length
    if self.writes == usize.ONE && count > 3 { count = 3 }
    let start = self.outputLength
    let mut target = Bytes.asMutSlice(&mut self.output)
    if count > target.length - start { fail ByteDuplex.provider(ByteIoOperation.Write, 74) }
    let mut index = usize.ZERO
    while index < count {
      target[start + index] = input[index]
      index = index + usize.ONE
    }
    drop target
    self.outputLength = start + count
    return count
  }
  unsafe effect fn flush(self: &mut Self, mark: Option<Instant>) -> () ! ByteIoError ? &mut MonotonicClock {
    drop mark self.flushes = self.flushes + usize.ONE return ()
  }
  unsafe effect fn shutdown(self: &mut Self, mark: Option<Instant>) -> () ! ByteIoError ? &mut MonotonicClock {
    drop mark return ()
  }
  unsafe effect fn close(self: &mut Self) -> () ! ByteIoError {
    if self.closed { return () }
    self.closed = true self.closes = self.closes + usize.ONE return ()
  }
}
impl ByteDuplex for ScriptedDuplex {
  readSomeRaw: ScriptedDuplex.read
  writeSomeRaw: ScriptedDuplex.write
  flushRaw: ScriptedDuplex.flush
  shutdownWriteRaw: ScriptedDuplex.shutdown
  closeRaw: ScriptedDuplex.close
}
struct UpgradeTransport {inner: ScriptedDuplex mode: i32 state: Shared<TransportAudit>}
fn auditValid(state: &mut TransportAudit) -> bool { return state.closes == usize.ONE && state.deadlines }
fn canceledValid(state: &mut TransportAudit) -> i32 {
  if state.closes == usize.ONE && state.flushes == usize.ONE && state.deadlines && state.complete && state.handoffs == usize.ZERO { return 42 }
  return 170
}
impl UpgradeTransport {
  unsafe effect fn read(self: &mut Self, output: &mut [u8], mark: Option<Instant>)
  -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    let valid = sameDeadline(&mark)
    Shared.withMut(&self.state, fn(state: &mut TransportAudit) -> () { state.deadlines = state.deadlines && valid return () })
    return run ByteDuplex.readSome(move output, move mark) |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }
  unsafe effect fn write(self: &mut Self, input: &[u8], mark: Option<Instant>)
  -> usize ! ByteIoError ? &mut MonotonicClock {
    let valid = sameDeadline(&mark)
    Shared.withMut(&self.state, fn(state: &mut TransportAudit) -> () { state.deadlines = state.deadlines && valid return () })
    return run ByteDuplex.writeSome(input, move mark) |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }
  unsafe effect fn flush(self: &mut Self, mark: Option<Instant>) -> () ! ByteIoError ? &mut MonotonicClock {
    let valid = sameDeadline(&mark)
    let complete = equal(ScriptedDuplex.outbound(&self.inner), b"HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\\r\\nSec-WebSocket-Protocol: chat\\r\\nSet-Cookie: a=1\\r\\nSet-Cookie: b=2\\r\\nConnection: upgrade\\r\\n\\r\\n")
    Shared.withMut(&self.state, fn(state: &mut TransportAudit) -> () {
      if complete { state.complete = true }
      state.deadlines = state.deadlines && valid state.flushes = state.flushes + usize.ONE return ()
    })
    if self.mode == 4 { drop mark fail ByteDuplex.timeout(ByteIoOperation.Flush) }
    if self.mode == 5 { run MonotonicClock.waitUntil(SystemClock.make(8, 0)) }
    return run ByteDuplex.flush(move mark) |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }
  unsafe effect fn shutdown(self: &mut Self, mark: Option<Instant>) -> () ! ByteIoError ? &mut MonotonicClock {
    return run ByteDuplex.shutdownWrite(move mark) |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }
  unsafe effect fn close(self: &mut Self) -> () ! ByteIoError {
    if self.inner.closed { return () }
    Shared.withMut(&self.state, fn(state: &mut TransportAudit) -> () { state.closes = state.closes + usize.ONE return () })
    return run ByteDuplex.close() |> Effect.provideMut<ByteDuplex>(&mut self.inner)
  }
}
impl ByteDuplex for UpgradeTransport {
  readSomeRaw: UpgradeTransport.read
  writeSomeRaw: UpgradeTransport.write
  flushRaw: UpgradeTransport.flush
  shutdownWriteRaw: UpgradeTransport.shutdown
  closeRaw: UpgradeTransport.close
}
struct ParkGuard {wake: Wake}
fn retainWake(wake: Wake) -> ParkGuard { return ParkGuard {wake: move wake} }
struct ParkingClock {}
impl MonotonicClock for ParkingClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when run Execution.park(retainWake) return () }
  effect fn waitFor(self: &mut Self, duration: u64) -> () { drop duration run Execution.park(retainWake) return () }
}

union PolicyError {Denied}
struct Policy<'config> {headers: Headers<'config> forbidden: Headers<'config>}
impl<'config> DecisionHandler<UpgradeError | PolicyError ? &mut MonotonicClock> for Policy<'config> {
  effect<'call> fn decide<'call, 'head: 'call>(handler: &'call Self, offer: &'call Offer<'head>)
  -> Decision<'call> ! UpgradeError | PolicyError ? &mut MonotonicClock {
  let observed = run MonotonicClock.now()
  drop observed
  // Origin is an explicit application policy; absence is intentionally allowed for this fixture.
  let mut selected: Option<Headers<'call>> = Option.none<Headers<'call>>()
  let origin = Offer.origin(&offer.*)
  match move origin {
    Option.None => {}
    Option.Some {value: suppliedOrigin} => {
      if equal(suppliedOrigin, b"null") {
        return Decision.Accept {protocol: Option.none<string<'call>>(), headers: Option.none<Headers<'call>>(), extensions: true}
      }
      if equal(suppliedOrigin, b"https://failed.test") { fail PolicyError.Denied }
      if equal(suppliedOrigin, b"https://headers.test") {
        selected = Option.some<Headers<'call>>(handler.forbidden)
      } else if equal(suppliedOrigin, b"https://example.test") {
        selected = Option.some<Headers<'call>>(handler.headers)
      } else {
        let status = match move Status.fromCode(403) {
          Result.Failure {error} => { fail UpgradeError.Value {error: move error} }
          Result.Success {value} => value
        }
        return Decision.Reject {status: status, headers: Option.none<Headers<'call>>()}
      }
    }
  }
  return Decision.Accept {protocol: Option.some<string<'call>>("chat"), headers: move selected, extensions: false}
  }
}

effect<'call> fn useSocket<'call, 'channel: 'call, 'transport: 'channel>(
  socket: &'call mut ServerWebSocket<'channel, 'transport, UpgradeTransport>,
) -> i32 ! WebSocketError ? &mut MonotonicClock {
  let mut output: [u8; 5] = [0, 0, 0, 0, 0]
  let hello = run WebSocketServer.readEvent(&mut socket.*, &mut output, deadline())
  match move hello {
    SocketEvent.Text {count} => {
      if count != 5 || !equal(&output, b"Hello") { return 183 }
    }
    _ => { return 184 }
  }
  run WebSocketServer.writeText(&mut socket.*, "Hello", deadline())
  let ping = run WebSocketServer.readEvent(&mut socket.*, &mut output, deadline())
  match move ping {
    SocketEvent.Ping {payload} => {
      let bytes = payload.asSlice()
      let valid = equal(bytes, b"Hi")
      drop bytes
      if !valid { return 185 }
    }
    _ => { return 186 }
  }
  let pong = run WebSocketServer.readEvent(&mut socket.*, &mut output, deadline())
  match move pong {
    SocketEvent.Pong {payload} => {
      let bytes = payload.asSlice()
      let valid = equal(bytes, b"ok")
      drop bytes
      if !valid { return 187 }
    }
    _ => { return 188 }
  }
  let closed = run WebSocketServer.readEvent(&mut socket.*, &mut output, deadline())
  match move closed {
    SocketEvent.PeerClose {data} => match move data {
      SocketCloseData.Absent => { return 189 }
      SocketCloseData.Present {code, reason} => {
        let bytes = reason.asSlice()
        let empty = bytes.length == usize.ZERO
        drop bytes
        if code != 1000 || !empty { return 190 }
      }
    }
    _ => { return 191 }
  }
  if WebSocketServer.state(&socket.*) != SocketState.Closed { return 192 }
  return 42
}

effect<'call> fn useChannel<'call, 'transport: 'call>(
  channel: &'call mut BufferedDuplex<'transport, UpgradeTransport>,
) -> i32 ? &mut HandoffAudit | &mut MonotonicClock {
  if !(run HandoffAudit.observe()) { return 182 }
  let served = run Effect.result(WebSocketServer.withServer(
    move channel,
    SocketLimits.defaults(),
    useSocket,
  ))
  return match move served {
    Result<i32, WebSocketError>.Success {value} => value
    Result<i32, WebSocketError>.Failure {error} => { drop error return 193 }
  }
}

effect<'call> fn request<'call, 'request: 'call, 'connection: 'request, 'transport: 'connection>(
  exchange: &'call mut Request<'request, 'connection, 'transport, UpgradeTransport>,
) -> i32 ! PolicyError | UpgradeError | ServerError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut HandoffAudit {
  let head = run Request.head(&exchange.*)
  let checked = inspect(&head, Limits.default())
  let mut configured = Limits.default()
  let mut invalid = Option.none<UpgradeError>()
  match move checked {
    Result.Success {value: offer} => {
      match move Offer.protocolAt(&offer, usize.ONE) {
        Option.None => {}
        Option.Some {value: selector} => {
          if equal(selector, b"response-limit") { configured.maxResponseBytes = usize.ZERO }
          if equal(selector, b"owned-limit") { configured.maxOwnedBytes = usize.ZERO }
        }
      }
      drop offer
    }
    Result.Failure {error} => { invalid = Option.some<UpgradeError>(move error) }
  }
  drop head
  match move invalid {
    Option.None => {}
    Option.Some {value: failure} => {
      let status = rejectionStatus(&failure)
      run reject(&mut exchange.*, &failure, Limits.default(), deadline())
      if status == 426 { return 426 }
      if status == 417 { return 417 }
      return 400
    }
  }
  let cookieA = match move Header.make("Set-Cookie", b"a=1", valueLimits()) {
    Result.Failure {error} => { fail UpgradeError.Value {error: move error} }
    Result.Success {value} => value
  }
  let cookieB = match move Header.make("Set-Cookie", b"b=2", valueLimits()) {
    Result.Failure {error} => { fail UpgradeError.Value {error: move error} }
    Result.Success {value} => value
  }
  let bad = match move Header.make("cOnNeCtIoN", b"close", valueLimits()) {
    Result.Failure {error} => { fail UpgradeError.Value {error: move error} }
    Result.Success {value} => value
  }
  let entries = [cookieA, cookieB]
  let forbiddenEntries = [bad]
  let headers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { fail UpgradeError.Value {error: move error} }
    Result.Success {value} => value
  }
  let forbidden = match move Headers.make(&forbiddenEntries, valueLimits()) {
    Result.Failure {error} => { fail UpgradeError.Value {error: move error} }
    Result.Success {value} => value
  }
  let result = run withUpgrade<i32, UpgradeError | PolicyError, never>(move exchange, configured, deadline(), Policy {headers: headers, forbidden: forbidden}, useChannel)
  return match move result {
    Outcome.Rejected {status} => { if status != 403 { return 150 } return 0 }
    Outcome.Upgraded {value} => value
  }
}

struct Handler {}
impl ConnectionHandler<UpgradeTransport, i32, PolicyError | UpgradeError | ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock | &mut HandoffAudit> for Handler {
  effect<'call> fn handle<'call, 'connection: 'call, 'transport: 'connection>(
    handler: Self,
    connection: &'call mut Connection<'connection, 'transport, UpgradeTransport>,
  ) -> i32 ! PolicyError | UpgradeError | ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock | &mut HandoffAudit
  where &'transport mut UpgradeTransport provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
    drop handler
    let handled = run withRequest(&mut connection.*, deadline(), request)
    return match move handled {
      Option.None => 152
      Option.Some {value} => value
    }
  }
}

effect fn provider(input: &[u8], mode: i32) -> ScriptedDuplex
! OutOfMemoryError ? &mut Allocator {
  let mut firstLine = b"GET /chat HTTP/1.1\\r"
  if mode == 10 { firstLine = b"GET /chat HTTP/1.0\\r" }
  let first = run Bytes.copy(firstLine)
  let remainder = run Bytes.copy(input)
  let output = run Bytes.zeroed(512)
  return ScriptedDuplex {
    first: move first, remainder: move remainder, output: move output,
    readOffset: usize.ZERO, outputLength: usize.ZERO, mode: mode,
    writes: usize.ZERO, failed: false, writesAfterFailure: usize.ZERO,
    flushes: usize.ZERO, closed: false, closes: usize.ZERO,
  }
}

effect fn runtimeCase(input: &[u8], expected: &[u8], mode: i32) -> i32
! PolicyError | OutOfMemoryError | ServerError | UpgradeError | BufferError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = FixedClock {}
  let inner = run provider(input, mode) |> Effect.provideMut<Allocator>(&mut allocator)
  let auditState = run Shared.make<TransportAudit>(TransportAudit {closes: usize.ZERO, flushes: usize.ZERO, deadlines: true, complete: false, handoffs: usize.ZERO})
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut auditProvider = AuditProvider {state: Shared.clone(&auditState)}
  let mut transport = UpgradeTransport {inner: move inner, mode: mode, state: Shared.clone(&auditState)}
  let operation = withConnection(&mut transport, serverLimits(), Handler {})
  let outcome = run Effect.result(move operation)
    |> Effect.provideMut<HandoffAudit>(&mut auditProvider)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  match move outcome {
    Result.Success {value} => {
      if mode == 0 { if value != 42 { return 153 } }
      else if mode == 1 { if value != 0 { return 154 } }
      else if mode == 9 { if value != 426 { return 174 } }
      else if mode == 10 { if value != 400 { return 175 } }
      else if mode == 11 { if value != 417 { return 176 } }
      else { return 155 }
    }
    Result.Failure {error} => {
      if mode == 2 || mode == 8 {
        match move error {
          UpgradeError.InvalidDecision {reason} => {
            if mode == 2 && reason != DecisionReason.Protocol { return 180 }
            if mode == 8 && reason != DecisionReason.Header { return 181 }
          }
          _ => { return 156 }
        }
      } else if mode == 12 || mode == 13 {
        match move error {
          UpgradeError.Limit {kind} => {
            if mode == 12 && kind != LimitKind.ResponseBytes { return 177 }
            if mode == 13 && kind != LimitKind.OwnedBytes { return 178 }
          }
          _ => { return 179 }
        }
      } else if mode == 6 {
        match move error { UpgradeError.UnsupportedNegotiation => {} _ => { return 172 } }
      } else if mode == 7 {
        match move error { PolicyError.Denied => {} _ => { return 173 } }
      } else if mode == 3 || mode == 4 {
        match move error {
          ServerError.Buffer {error: cause} => match move cause {
            BufferError.WriteFailed {accepted, drained, error: transportError} => {
              drop accepted drop drained
              match move transportError {
                ByteIoError.Provider {operation: ioOperation, code} => {
                  if mode != 3 || ioOperation != ByteIoOperation.Write || code != 73 { return 165 }
                }
                ByteIoError.Timeout {operation: ioOperation} => {
                  if mode != 4 || ioOperation != ByteIoOperation.Flush { return 166 }
                }
                _ => { return 167 }
              }
            }
            _ => { return 168 }
          }
          _ => { return 157 }
        }
      } else { drop error return 158 }
    }
  }
  if !equal(ScriptedDuplex.outbound(&transport.inner), expected) { return 200 + mode }
  if !transport.inner.closed || transport.inner.closes != usize.ONE { return 160 }
  if !Shared.withMut(&auditState, auditValid) { return 164 }
  let flushes = transport.inner.flushes
  let failed = transport.inner.failed
  let writesAfterFailure = transport.inner.writesAfterFailure
  if mode == 0 && flushes != 4 { return 161 }
  if (mode == 2 || mode == 6 || mode == 7 || mode == 8 || mode == 12 || mode == 13) && flushes != usize.ZERO { return 162 }
  if mode == 3 && (!failed || writesAfterFailure != usize.ZERO || flushes != usize.ZERO) { return 163 }
  return 0
}

effect fn suspended(state: Shared<TransportAudit>) -> i32
! PolicyError | OutOfMemoryError | ServerError | UpgradeError | BufferError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut clock = ParkingClock {}
  let inner = run provider(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nOrigin: https://example.test\\r\\nSec-WebSocket-Protocol: ignored\\r\\nSec-WebSocket-Protocol: chat\\r\\nSec-WebSocket-Extensions: permessage-deflate\\r\\n\\r\\nXYZ", 5) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut auditProvider = AuditProvider {state: Shared.clone(&state)}
  let mut transport = UpgradeTransport {inner: move inner, mode: 5, state: move state}
  return run withConnection(&mut transport, serverLimits(), Handler {})
    |> Effect.provideMut<HandoffAudit>(&mut auditProvider)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
}
fn ready(state: &()) -> () { return () }
fn complete(state: &mut i32, value: i32) -> () { drop value state.* = 171 return () }
fn cancelParked(state: &mut i32, execution: Intrinsic.Execution<i32>) -> () {
  drop move execution
  state.* = 42
  return ()
}
effect fn canceledHandshake() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let state = run Shared.make<TransportAudit>(TransportAudit {closes: usize.ZERO, flushes: usize.ZERO, deadlines: true, complete: false, handoffs: usize.ZERO})
    |> Effect.provideMut<Allocator>(&mut allocator)
  let body = Effect.catchAll(suspended(Shared.clone(&state)), recover)
  let execution = run Execution.make(move body, (), ready) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut outcome = 0
  run Execution.drive(move execution, &mut outcome, complete, cancelParked)
  if outcome != 42 { return outcome }
  return Shared.withMut(&state, canceledValid)
}

effect fn allCases() -> i32 ! PolicyError | OutOfMemoryError | ServerError | UpgradeError | BufferError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let inspected = run inspectCases() |> Effect.provideMut<Allocator>(&mut allocator)
  if inspected != 0 { return inspected }
${positiveCase}
  let runtime1 = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nOrigin: https://denied.test\\r\\n\\r\\n", b"HTTP/1.1 403 \\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n", 1)
  if runtime1 != 0 { return runtime1 }
  let runtime2 = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", b"", 2)
  if runtime2 != 0 { return runtime2 }
  let runtime4 = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nOrigin: https://example.test\\r\\nSec-WebSocket-Protocol: ignored\\r\\nSec-WebSocket-Protocol: chat\\r\\nSec-WebSocket-Extensions: permessage-deflate\\r\\n\\r\\nXYZ", b"HTTP/1.1 101 Switching Protocols\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Accept: s3pPLMBiTxaQ9kYGzzhZRbK+xOo=\\r\\nSec-WebSocket-Protocol: chat\\r\\nSet-Cookie: a=1\\r\\nSet-Cookie: b=2\\r\\nConnection: upgrade\\r\\n\\r\\n", 4)
  if runtime4 != 0 { return runtime4 }
  let runtime3 = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nOrigin: https://example.test\\r\\nSec-WebSocket-Protocol: ignored\\r\\nSec-WebSocket-Protocol: chat\\r\\nSec-WebSocket-Extensions: permessage-deflate\\r\\n\\r\\nXYZ", b"HTT", 3)
  if runtime3 != 0 { return runtime3 }
  let extension = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: chat\\r\\nOrigin: null\\r\\n\\r\\n", b"", 6)
  if extension != 0 { return extension }
  let callback = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: chat\\r\\nOrigin: https://failed.test\\r\\n\\r\\n", b"", 7)
  if callback != 0 { return callback }
  let forbidden = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: chat\\r\\nOrigin: https://headers.test\\r\\n\\r\\n", b"", 8)
  if forbidden != 0 { return forbidden }
  let version = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 12\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", b"HTTP/1.1 426 \\r\\nContent-Length: 0\\r\\nSec-WebSocket-Version: 13\\r\\nConnection: close\\r\\n\\r\\n", 9)
  if version != 0 { return version }
  let http10 = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\n\\r\\n", b"HTTP/1.0 400 \\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n", 10)
  if http10 != 0 { return http10 }
  let expectation = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nExpect: 100-continue\\r\\n\\r\\n", b"HTTP/1.1 417 \\r\\nContent-Length: 0\\r\\nConnection: close\\r\\n\\r\\n", 11)
  if expectation != 0 { return expectation }
  let responselimit = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: chat\\r\\nSec-WebSocket-Protocol: response-limit\\r\\n\\r\\n", b"", 12)
  if responselimit != 0 { return responselimit }
  let ownedlimit = run runtimeCase(b"\\nHost: example.test\\r\\nConnection: upgrade\\r\\nUpgrade: websocket\\r\\nSec-WebSocket-Version: 13\\r\\nSec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==\\r\\nSec-WebSocket-Protocol: chat\\r\\nSec-WebSocket-Protocol: owned-limit\\r\\n\\r\\n", b"", 13)
  if ownedlimit != 0 { return ownedlimit }
  let canceled = run canceledHandshake()
  if canceled != 42 { return canceled }
  return 0
}
effect<'env> fn recover<E: 'env, 'env>(error: E) -> i32 {
  drop error
  return 199
}
pub fn main() -> i32 { return run Effect.catchAll(allCases(), recover) }
`

/** The intended Wasm leg covers one successful fragmented handshake and its preserved suffix. */
export const websocketUpgradePortableAcceptanceSource = websocketUpgradeAcceptanceSource
  .replace(/effect fn inspection\([\s\S]*?(?=fn deadline\()/, '')
  .replace(/effect fn suspended\([\s\S]*?(?=effect fn allCases\()/, '')
  .replace(
    /effect fn allCases\([\s\S]*?(?=effect<'env> fn recover)/,
    `effect fn allCases() -> i32 ! PolicyError | OutOfMemoryError | ServerError | UpgradeError | BufferError {
${positiveCase}
  return 0
}
`,
  )
