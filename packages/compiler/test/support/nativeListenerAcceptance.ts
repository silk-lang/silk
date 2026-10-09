/** Registered-import acceptance source for JUL-191's native listener corpus. */
export const nativeListenerAcceptanceSource = `
import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ByteDuplex, ByteIoError, ByteIoOperation, ReadTransfer}
import silk.effect {Effect}
import silk.buffered_input {BufferError}
import silk.http {Header, ResponseHead, Status, Version}
import silk.http_body {Limits as BodyLimits}
import silk.http_head {Limits as HeadLimits}
import silk.http_headers {Headers, Limits as ValueLimits}
import silk.http_server {Connection as HttpConnection, ConnectionHandler, Limits as HttpLimits, Request, ServerError, reject, withRequest}
import silk.http_server_native {serveNext}
import silk.execution {Execution}
import silk.i32
import silk.i64
import silk.monotonic_clock {MonotonicClock}
import silk.native_socket {Accepted, AcceptedContext, AcceptedView, BoundAddress, Connection, ConnectionPhase, InvalidBindReason, ListenOptions, ListenOptionsError, ListenOptionsReason, Listener, ListenerPhase, NativeSocketError, NativeSocketOperation, PeerAddress, UnixPeerAddress, UnixSocketPath, accept, listen, listenUnix, withAccepted, withAcceptedContext, withListener}
import silk.network_address {Endpoint, IpAddress, Ipv4Address, Ipv6Address, Port}
import silk.option {Option}
import silk.pointer {Pointer}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.u16
import silk.u64
import silk.usize

unsafe extern "C" fn silk_listener_connect_http(port: i32) -> i32
unsafe extern "C" fn silk_listener_finish_http() -> i32
unsafe extern "C" fn silk_listener_http_ownership() -> i32
unsafe extern "C" fn silk_listener_connect_tcp(port: i32) -> i32
unsafe extern "C" fn silk_listener_connect_unix(path: ?[*]const u8, length: usize) -> i32 with Intrinsic.foreign(noCapture: ("path",))
unsafe extern "C" fn silk_listener_loopback_available() -> i32
unsafe extern "C" fn silk_listener_finish_client(expected: i32) -> i32
unsafe extern "C" fn silk_listener_path_exists(path: ?[*]const u8, length: usize) -> i32 with Intrinsic.foreign(noCapture: ("path",))
unsafe extern "C" fn silk_listener_unlink(path: ?[*]const u8, length: usize) -> i32 with Intrinsic.foreign(noCapture: ("path",))
unsafe extern "C" fn silk_listener_darwin_witness() -> i32
unsafe extern "C" fn silk_listener_gnu_witness() -> i32
unsafe extern "C" fn silk_listener_stub_reset(mode: i32) -> ()
unsafe extern "C" fn silk_listener_stub_sockets() -> i32
unsafe extern "C" fn silk_listener_stub_binds() -> i32
unsafe extern "C" fn silk_listener_stub_listens() -> i32
unsafe extern "C" fn silk_listener_stub_getsocknames() -> i32
unsafe extern "C" fn silk_listener_stub_accepts() -> i32
unsafe extern "C" fn silk_listener_stub_polls() -> i32
unsafe extern "C" fn silk_listener_stub_setsockopts() -> i32
unsafe extern "C" fn silk_listener_stub_getsockopts() -> i32
unsafe extern "C" fn silk_listener_stub_close_attempts() -> i32
unsafe extern "C" fn silk_listener_stub_closed_listener() -> i32
unsafe extern "C" fn silk_listener_stub_closed_accepted() -> i32
unsafe extern "C" fn silk_listener_stub_configuration_ok() -> i32
unsafe extern "C" fn silk_listener_stub_fcntls() -> i32
unsafe extern "C" fn silk_listener_stub_wait_registrations() -> i32
unsafe extern "C" fn silk_listener_stub_wake_releases() -> i32
unsafe extern "C" fn silk_listener_stub_context_releases() -> i32
unsafe extern "C" fn silk_listener_stub_completions() -> i32
unsafe extern "C" fn silk_listener_stub_mark_wait_registration() -> ()
unsafe extern "C" fn silk_listener_stub_mark_wake_release() -> ()
unsafe extern "C" fn silk_listener_stub_mark_context_release() -> ()
unsafe extern "C" fn silk_listener_stub_mark_completion() -> ()

struct ImmediateClock { nowValue: Instant waits: usize }
impl MonotonicClock for ImmediateClock {
  effect fn now(self: &mut Self) -> Instant {
    return SystemClock.make(SystemClock.seconds(&self.nowValue), SystemClock.nanoseconds(&self.nowValue))
  }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () with Intrinsic.nonParking() {
    self.nowValue = move when
    self.waits = self.waits + usize.ONE
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () with Intrinsic.nonParking() {
    drop howLong
    return ()
  }
}

struct ListenerParkGuard {wake: Intrinsic.Wake}
impl Drop for ListenerParkGuard {
  fn drop(self: &mut ListenerParkGuard) -> () {
    unsafe { silk_listener_stub_mark_wake_release() }
    return ()
  }
}
fn retainListenerWake(wake: Intrinsic.Wake) -> ListenerParkGuard {
  unsafe { silk_listener_stub_mark_wait_registration() }
  return ListenerParkGuard {wake: move wake}
}
struct ParkingClock {}
impl MonotonicClock for ParkingClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () {
    drop when
    run Execution.park(retainListenerWake)
    return ()
  }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () {
    drop howLong
    run Execution.park(retainListenerWake)
    return ()
  }
}

fn loopback() -> Endpoint {
  return Endpoint.make(
    IpAddress.V4 {value: Ipv4Address.fromOctets([127, 0, 0, 1])},
    Port.fromU16(0),
  )
}

fn loopbackV6() -> Endpoint {
  return Endpoint.make(
    IpAddress.V6 {value: Ipv6Address.fromOctets([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])},
    Port.fromU16(0),
  )
}

fn httpValueLimits() -> ValueLimits {
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

fn httpHeadLimits() -> HeadLimits {
  return HeadLimits {
    maxHeadBytes: 1024,
    maxStartLineBytes: 256,
    maxFieldLineBytes: 256,
    maxOwnedBytes: 2048,
    values: httpValueLimits(),
  }
}

fn httpBodyLimits() -> BodyLimits {
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
    trailerValues: httpValueLimits(),
  }
}

fn httpLimits() -> HttpLimits {
  return HttpLimits {
    head: httpHeadLimits(),
    body: httpBodyLimits(),
    values: httpValueLimits(),
    readCapacity: 128,
    writeCapacity: 128,
    maxRequestsPerConnection: usize.ONE,
    maxInformationalResponses: 2,
    maxDiscardWireBytes: u64.toU64(256),
    shutdownDrainBytes: 16,
  }
}

struct NativeHttpHandler {}

effect<'call> fn respondHttp<'call, 'request: 'call, 'connection: 'request, 'transport: 'connection>(
  request: &'call mut Request<'request, 'connection, 'transport, Connection>,
) -> i32 ! ServerError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock {
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, httpValueLimits()) {
    Result.Failure {error} => { fail ServerError.Value {error: move error} }
    Result.Success {value} => value
  }
  let status = match move Status.fromCode(204) {
    Result.Failure {error} => { fail ServerError.Value {error: move error} }
    Result.Success {value} => value
  }
  let response = match move ResponseHead.make(
    Version.Http11, status, Option.some<&'static [u8]>(b"No Content"), headers, httpValueLimits(),
  ) {
    Result.Failure {error} => { fail ServerError.Value {error: move error} }
    Result.Success {value} => value
  }
  run reject(&mut request.*, &response, Option.none<Instant>())
  return 42
}

impl ConnectionHandler<Connection, i32, ServerError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock> for NativeHttpHandler {
  effect<'call> fn handle<'call, 'connection: 'call, 'transport: 'connection>(
    handler: Self,
    connection: &'call mut HttpConnection<'connection, 'transport, Connection>,
  ) -> i32 ! ServerError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock
  where &'transport mut Connection provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock {
    drop handler
    let handled = run withRequest(&mut connection.*, Option.none<Instant>(), respondHttp)
    return match move handled {
      Option.None => 251
      Option.Some {value} => value
    }
  }
}

effect fn serveHttp(listener: &mut Listener) -> i32
! NativeSocketError | ServerError | BufferError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock {
  let bound = Listener.boundAddress(&listener.*)
  let port = match move bound {
    BoundAddress.Tcp {endpoint} => u16.toI32(Port.value(&Endpoint.port(&endpoint)))
    _ => { return 252 }
  }
  if unsafe silk_listener_connect_http(port) != 42 { return 253 }
  let served = run Effect.result(serveNext<
    i32, ServerError | OutOfMemoryError,
  >(
    &mut listener.*, httpLimits(), Option.none<Instant>(), NativeHttpHandler {},
  ))
  let client = unsafe silk_listener_finish_http()
  let code = match move served {
    Result.Failure {error} => { drop error return 254 }
    Result.Success {value} => value
  }
  if code != 42 { return code }
  if client != 42 { return 255 }
  if Listener.phase(&listener.*) != ListenerPhase.Open { return 256 }
  return 42
}

effect fn httpCase(clock: &mut ImmediateClock) -> i32 ! NativeSocketError {
  let listener = run listen(loopback(), ListenOptions.defaults())
  let mut allocator = Allocator.systemAllocatorProvider()
  let outcome = run Effect.result(withListener(move listener, serveHttp)
    |> Effect.provideMut<MonotonicClock>(&mut clock.*)
    |> Effect.provideMut<Allocator>(&mut allocator))
  let code = match move outcome {
    Result.Failure {error} => { drop error return 257 }
    Result.Success {value} => value
  }
  if code != 42 { return code }
  if unsafe silk_listener_http_ownership() != 42 { return 258 }
  return 42
}

effect fn transferTcp<'call>(view: &'call mut AcceptedView<'call>) -> i32
! ByteIoError
? &mut MonotonicClock {
  match & view.peer.* {
    PeerAddress.Tcp {endpoint} => {}
    _ => { return 11 }
  }
  let mut input: [u8; 1] = [0]
  let read = run ByteDuplex.readSome(&mut input, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut view.connection.*)
  match move read {
    ReadTransfer.Data {count} => {
      if count != usize.ONE || input[0] != 120 { return 12 }
    }
    ReadTransfer.End => { return 13 }
  }
  let written = run ByteDuplex.writeSome(b"y", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut view.connection.*)
  if written != usize.ONE { return 14 }
  return 42
}

effect fn transferUnix<'call>(view: &'call mut AcceptedView<'call>) -> i32
! ByteIoError
? &mut MonotonicClock {
  match & view.peer.* {
    PeerAddress.Unix {peer: unixPeer} => match move unixPeer {
      UnixPeerAddress.Unnamed => {}
      _ => { return 21 }
    }
    _ => { return 21 }
  }
  let mut input: [u8; 1] = [0]
  let read = run ByteDuplex.readSome(&mut input, Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut view.connection.*)
  match move read {
    ReadTransfer.Data {count} => {
      if count != usize.ONE || input[0] != 120 { return 22 }
    }
    ReadTransfer.End => { return 23 }
  }
  let written = run ByteDuplex.writeSome(b"z", Option.none<Instant>())
    |> Effect.provideMut<ByteDuplex>(&mut view.connection.*)
  if written != usize.ONE { return 24 }
  return 42
}

effect fn tcpCase(clock: &mut ImmediateClock) -> i32 ! NativeSocketError | ByteIoError {
  let opened = run Effect.result(listen(loopback(), ListenOptions.defaults()))
  let mut listener = match move opened {
    Result<Listener, NativeSocketError>.Failure {error} => {
      if unsafe silk_listener_stub_sockets() == 0 { return 129 }
      if unsafe silk_listener_stub_binds() == 0 { return 130 }
      if unsafe silk_listener_stub_listens() == 0 { return 131 }
      if unsafe silk_listener_stub_getsocknames() == 0 { return 132 }
      return 133
    }
    Result<Listener, NativeSocketError>.Success {value} => value
  }
  let bound = Listener.boundAddress(&listener)
  let port = match move bound {
    BoundAddress.Tcp {endpoint} => u16.toI32(Port.value(&Endpoint.port(&endpoint)))
    _ => { return 31 }
  }
  if port <= 0 || unsafe silk_listener_connect_tcp(port) != 42 { return 32 }
  let admitted = run Effect.result(
    accept(&mut listener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock.*)
  )
  let accepted = match move admitted {
    Result<Accepted, NativeSocketError>.Failure {error} => { return 134 }
    Result<Accepted, NativeSocketError>.Success {value} => value
  }
  run Listener.close(&mut listener)
  let used = run Effect.result(
    withAccepted<i32, ByteIoError>(move accepted, transferTcp)
      |> Effect.provideMut<MonotonicClock>(&mut clock.*)
  )
  let transferred = match move used {
    Result<i32, ByteIoError>.Failure {error} => { return 135 }
    Result<i32, ByteIoError>.Success {value} => value
  }
  if transferred != 42 { return transferred }
  if unsafe silk_listener_finish_client(121) != 42 { return 33 }
  return 42
}

effect fn unixCase(clock: &mut ImmediateClock) -> i32 ! NativeSocketError | ByteIoError {
  let path = b"/tmp/silk-jul-191-listener.sock"
  let ignored = unsafe silk_listener_unlink(Pointer.fromSlice<u8>(path), path.length)
  let opened = run Effect.result(listenUnix(path, ListenOptions.defaults()))
  let mut listener = match move opened {
    Result<Listener, NativeSocketError>.Failure {error} => { return 136 }
    Result<Listener, NativeSocketError>.Success {value} => value
  }
  if unsafe silk_listener_connect_unix(Pointer.fromSlice<u8>(path), path.length) != 42 { return 41 }
  let admitted = run Effect.result(
    accept(&mut listener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock.*)
  )
  let accepted = match move admitted {
    Result<Accepted, NativeSocketError>.Failure {error} => { return 137 }
    Result<Accepted, NativeSocketError>.Success {value} => value
  }
  run Listener.close(&mut listener)
  if unsafe silk_listener_path_exists(Pointer.fromSlice<u8>(path), path.length) != 1 { return 42 }
  let used = run Effect.result(
    withAccepted<i32, ByteIoError>(move accepted, transferUnix)
      |> Effect.provideMut<MonotonicClock>(&mut clock.*)
  )
  let transferred = match move used {
    Result<i32, ByteIoError>.Failure {error} => { return 138 }
    Result<i32, ByteIoError>.Success {value} => value
  }
  if transferred != 42 { return transferred }
  if unsafe silk_listener_finish_client(122) != 42 { return 43 }
  if unsafe silk_listener_unlink(Pointer.fromSlice<u8>(path), path.length) != 42 { return 44 }
  return 42
}

fn optionsWithReuse() -> ListenOptions {
  return match move ListenOptions.make(64, true, 7) {
    Result<ListenOptions, ListenOptionsError>.Failure {error} => ListenOptions.defaults()
    Result<ListenOptions, ListenOptionsError>.Success {value} => value
  }
}

fn samePath(path: &UnixSocketPath, expected: &[u8]) -> bool {
  let bytes = UnixSocketPath.bytes(path)
  if bytes.length != expected.length { return false }
  let mut index = usize.ZERO
  while index < bytes.length {
    if bytes[index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

effect fn inspectScriptTcp<'call>(view: &'call mut AcceptedView<'call>) -> i32
? &mut MonotonicClock {
  let peer = view.peer.*
  return match move peer {
    PeerAddress.Tcp {endpoint} => match move Endpoint.address(&endpoint) {
      IpAddress.V4 {value} => {
        let octets = Ipv4Address.octets(&value)
        if octets[0] == 192 && octets[1] == 0 && octets[2] == 2 && octets[3] == 9
          && Port.value(&Endpoint.port(&endpoint)) == 1234 { return 42 }
        return 61
      }
      _ => 62
    }
    _ => 63
  }
}

effect fn inspectScriptUnnamed<'call>(view: &'call mut AcceptedView<'call>) -> i32
? &mut MonotonicClock {
  let owned = view.peer.*
  return match move owned {
    PeerAddress.Unix {peer} => match move peer {
      UnixPeerAddress.Unnamed => 42
      _ => 64
    }
    _ => 65
  }
}

effect fn inspectScriptPath<'call>(view: &'call mut AcceptedView<'call>) -> i32
? &mut MonotonicClock {
  let owned = view.peer.*
  return match move owned {
    PeerAddress.Unix {peer} => match move peer {
      UnixPeerAddress.Pathname {path} => {
        if samePath(&path, b"peer") { return 42 }
        return 66
      }
      _ => 67
    }
    _ => 68
  }
}

struct ScriptAcceptedContext {expected: i32}
impl ScriptAcceptedContext {
  effect<'call> fn use<'call>(
    context: Self,
    view: &'call mut AcceptedView<'call>,
  ) -> i32 ? &mut MonotonicClock {
    if context.expected != 42 { return 251 }
    return run inspectScriptTcp(move view)
  }
}
impl AcceptedContext<i32, never, never ? &mut MonotonicClock> for ScriptAcceptedContext {
  use: ScriptAcceptedContext.use
}

struct FailingAcceptedContext {code: i32}
impl FailingAcceptedContext {
  effect<'call> fn use<'call>(
    context: Self,
    view: &'call mut AcceptedView<'call>,
  ) -> i32 ! ByteIoError {
    if Connection.phase(&view.connection.*) != ConnectionPhase.Open { return 252 }
    fail ByteDuplex.provider(ByteIoOperation.Flush, context.code)
  }
}
impl AcceptedContext<i32, ByteIoError, never ? never> for FailingAcceptedContext {
  use: FailingAcceptedContext.use
}

struct ParkedAcceptedContext {marker: i32}
impl Drop for ParkedAcceptedContext {
  fn drop(self: &mut ParkedAcceptedContext) -> () {
    unsafe { silk_listener_stub_mark_context_release() }
    return ()
  }
}
impl ParkedAcceptedContext {
  effect<'call> fn use<'call>(
    context: Self,
    view: &'call mut AcceptedView<'call>,
  ) -> i32 {
    if context.marker != 42 { return 258 }
    if Connection.phase(&view.connection.*) != ConnectionPhase.Open { return 253 }
    run Execution.park(retainListenerWake)
    if context.marker != 42 { return 259 }
    unsafe { silk_listener_stub_mark_completion() }
    return 1
  }
}
impl AcceptedContext<i32, never, never ? never> for ParkedAcceptedContext {
  use: ParkedAcceptedContext.use
}

effect fn scopedListenerSuccess(listener: &mut Listener) -> i32 {
  if Listener.phase(listener) != ListenerPhase.Open { return 183 }
  return 42
}

effect fn scopedListenerFailure(listener: &mut Listener) -> i32 ! ByteIoError {
  if Listener.phase(listener) != ListenerPhase.Open { return 184 }
  fail ByteDuplex.provider(ByteIoOperation.Flush, 777)
}

effect fn openScriptListener(peerKind: i32) -> Listener ! NativeSocketError {
  if peerKind == 0 { return run listen(loopback(), ListenOptions.defaults()) }
  return run listenUnix(b"/tmp/silk-jul-191-script.sock", ListenOptions.defaults())
}

effect fn inspectScriptAccepted(accepted: Accepted, peerKind: i32) -> i32
! NativeSocketError
? &mut MonotonicClock {
  if peerKind == 0 {
    return run withAcceptedContext(move accepted, ScriptAcceptedContext {expected: 42})
  }
  if peerKind == 1 {
    return run withAccepted(move accepted, inspectScriptUnnamed)
  }
  return run withAccepted(move accepted, inspectScriptPath)
}

effect fn scriptedAcceptSuccess(
  mode: i32,
  expectedWaits: usize,
  expectedAccepts: i32,
  peerKind: i32,
) -> i32 ! NativeSocketError {
  unsafe { silk_listener_stub_reset(mode) }
  let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let mut listener = run openScriptListener(peerKind)
  let accepted = run accept(&mut listener, Option.none<Instant>())
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  run Listener.close(&mut listener)
  if Listener.phase(&listener) != ListenerPhase.Closed { return 69 }
  let inspected = run inspectScriptAccepted(move accepted, peerKind)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  if inspected != 42 { return inspected }
  if unsafe silk_listener_stub_accepts() != expectedAccepts { return 70 }
  if clock.waits != expectedWaits { return 196 }
  if unsafe silk_listener_stub_closed_listener() != 1
    || unsafe silk_listener_stub_closed_accepted() != 1 { return 71 }
  if unsafe silk_listener_stub_configuration_ok() != 1 { return 72 }
  return 42
}

effect fn scriptedInvalidInputs() -> i32 {
  match move ListenOptions.make(usize.ZERO, false, 1) {
    Result<ListenOptions, ListenOptionsError>.Success {value} => { return 73 }
    Result<ListenOptions, ListenOptionsError>.Failure {error} => {
      if error.reason != ListenOptionsReason.KernelBacklog || error.value != 0 { return 74 }
    }
  }
  match move ListenOptions.make(65536, false, 1) {
    Result<ListenOptions, ListenOptionsError>.Success {value} => { return 75 }
    Result<ListenOptions, ListenOptionsError>.Failure {error} => {
      if error.reason != ListenOptionsReason.KernelBacklog || error.value != 65536 { return 76 }
    }
  }
  match move ListenOptions.make(1, false, 0) {
    Result<ListenOptions, ListenOptionsError>.Success {value} => { return 77 }
    Result<ListenOptions, ListenOptionsError>.Failure {error} => {
      if error.reason != ListenOptionsReason.PollInterval || error.value != 0 { return 78 }
    }
  }
  match move ListenOptions.make(1, false, 1000000001) {
    Result<ListenOptions, ListenOptionsError>.Success {value} => { return 79 }
    Result<ListenOptions, ListenOptionsError>.Failure {error} => {
      if error.reason != ListenOptionsReason.PollInterval || error.value != 1000000001 { return 80 }
    }
  }
  unsafe { silk_listener_stub_reset(100) }
  let relative = run Effect.result(listenUnix(b"relative.sock", ListenOptions.defaults()))
  match move relative {
    Result<Listener, NativeSocketError>.Success {value} => { return 81 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidBindAddress {reason, offset} => {
        if reason != InvalidBindReason.RelativePath || offset != usize.ZERO { return 82 }
      }
      _ => { return 83 }
    }
  }
  let nul = run Effect.result(listenUnix(b"/tmp/\x00socket", ListenOptions.defaults()))
  match move nul {
    Result<Listener, NativeSocketError>.Success {value} => { return 84 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidBindAddress {reason, offset} => {
        if reason != InvalidBindReason.NulPath || offset != 5 { return 85 }
      }
      _ => { return 86 }
    }
  }
  let empty = run Effect.result(listenUnix(b"", ListenOptions.defaults()))
  match move empty {
    Result<Listener, NativeSocketError>.Success {value} => { return 87 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidBindAddress {reason, offset} => {
        if reason != InvalidBindReason.EmptyPath { return 88 }
      }
      _ => { return 89 }
    }
  }
  let abstract = run Effect.result(listenUnix(b"\x00silk", ListenOptions.defaults()))
  match move abstract {
    Result<Listener, NativeSocketError>.Success {value} => { return 163 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidBindAddress {reason, offset} => {
        if reason != InvalidBindReason.AbstractPath || offset != usize.ZERO { return 164 }
      }
      _ => { return 165 }
    }
  }
  let oversized = run Effect.result(listenUnix(
    b"/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    ListenOptions.defaults(),
  ))
  match move oversized {
    Result<Listener, NativeSocketError>.Success {value} => { return 166 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.PathTooLong {length, limit} => {
        if length != 108 || limit != 107 { return 167 }
      }
      _ => { return 168 }
    }
  }
  if unsafe silk_listener_stub_sockets() != 0 { return 169 }
  return 42
}

effect fn scriptedSetupFailures() -> i32 {
  unsafe { silk_listener_stub_reset(111) }
  let occupied = run Effect.result(listen(loopback(), ListenOptions.defaults()))
  match move occupied {
    Result<Listener, NativeSocketError>.Success {value} => { return 91 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.AddressInUse => {}
      _ => { return 92 }
    }
  }
  if unsafe silk_listener_stub_close_attempts() != 1 { return 93 }

  unsafe { silk_listener_stub_reset(112) }
  let exhausted = run Effect.result(listen(loopback(), ListenOptions.defaults()))
  match move exhausted {
    Result<Listener, NativeSocketError>.Success {value} => { return 94 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.SystemResources => {}
      _ => { return 95 }
    }
  }
  if unsafe silk_listener_stub_close_attempts() != 0 { return 96 }

  unsafe { silk_listener_stub_reset(113) }
  let denied = run Effect.result(listen(loopback(), optionsWithReuse()))
  match move denied {
    Result<Listener, NativeSocketError>.Success {value} => { return 97 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.PermissionDenied => {}
      _ => { return 98 }
    }
  }
  if unsafe silk_listener_stub_close_attempts() != 1 { return 99 }

  unsafe { silk_listener_stub_reset(114) }
  let resources = run Effect.result(listen(loopback(), ListenOptions.defaults()))
  match move resources {
    Result<Listener, NativeSocketError>.Success {value} => { return 100 }
    Result<Listener, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.SystemResources => {}
      _ => { return 101 }
    }
  }
  if unsafe silk_listener_stub_close_attempts() != 1 { return 102 }
  return 42
}

effect fn scriptedPreciseErrnos() -> i32 ! NativeSocketError {
  let mut mode = 125
  while mode <= 128 {
    unsafe { silk_listener_stub_reset(mode) }
    let opened = run Effect.result(listen(loopback(), ListenOptions.defaults()))
    match move opened {
      Result<Listener, NativeSocketError>.Success {value} => { return 217 }
      Result<Listener, NativeSocketError>.Failure {error} => match move error {
        NativeSocketError.NativeFailure {operation, errno} => {
          let mut expectedOperation = NativeSocketOperation.Socket
          if mode == 126 { expectedOperation = NativeSocketOperation.Bind }
          if mode == 127 { expectedOperation = NativeSocketOperation.Listen }
          if mode == 128 { expectedOperation = NativeSocketOperation.GetSocketName }
          let mut expectedErrno = 111
          if mode == 128 { expectedErrno = -77 }
          if operation != expectedOperation || errno != expectedErrno { return 218 }
        }
        _ => { return 219 }
      }
    }
    let mut expectedCloses = 1
    if mode == 125 { expectedCloses = 0 }
    if unsafe silk_listener_stub_close_attempts() != expectedCloses { return 220 }
    mode = mode + 1
  }

  unsafe { silk_listener_stub_reset(129) }
  let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let mut listener = run listen(loopback(), ListenOptions.defaults())
  let attempted = run Effect.result(
    accept(&mut listener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
  )
  match move attempted {
    Result<Accepted, NativeSocketError>.Success {value} => { return 221 }
    Result<Accepted, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.NativeFailure {operation, errno} => {
        if operation != NativeSocketOperation.Accept || errno != 111 { return 222 }
      }
      _ => { return 223 }
    }
  }
  if unsafe silk_listener_stub_closed_accepted() != 0 || clock.waits != usize.ZERO { return 224 }
  run Listener.close(&mut listener)
  return 42
}

effect fn scriptedIpv6Setup() -> i32 ! NativeSocketError {
  unsafe { silk_listener_stub_reset(130) }
  let mut listener = run listen(loopbackV6(), ListenOptions.defaults())
  let bound = Listener.boundAddress(&listener)
  match move bound {
    BoundAddress.Tcp {endpoint} => match move Endpoint.address(&endpoint) {
      IpAddress.V6 {value} => {
        let octets = Ipv6Address.octets(&value)
        if Port.value(&Endpoint.port(&endpoint)) != 43211 || octets[15] != 1 { return 226 }
      }
      _ => { return 227 }
    }
    _ => { return 228 }
  }
  if unsafe silk_listener_stub_setsockopts() != 1
    || unsafe silk_listener_stub_configuration_ok() != 1 { return 229 }
  run Listener.close(&mut listener)
  return 42
}

effect fn scriptedAddressFailures() -> i32 ! NativeSocketError {
  let mut mode = 115
  while mode <= 116 {
    unsafe { silk_listener_stub_reset(mode) }
    let attempted = run Effect.result(listen(loopback(), ListenOptions.defaults()))
    match move attempted {
      Result<Listener, NativeSocketError>.Success {value} => { return 103 }
      Result<Listener, NativeSocketError>.Failure {error} => match move error {
        NativeSocketError.InvalidNativeAddress {family, length} => {
          if mode == 115 && (family != -1 || length != usize.ONE) { return 104 }
          if mode == 116 && (family != 2 || length != 17) { return 105 }
        }
        _ => { return 106 }
      }
    }
    if unsafe silk_listener_stub_close_attempts() != 1 { return 107 }
    mode = mode + 1
  }

  unsafe { silk_listener_stub_reset(106) }
  let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let mut listener = run listen(loopback(), ListenOptions.defaults())
  let short = run Effect.result(
    accept(&mut listener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
  )
  match move short {
    Result<Accepted, NativeSocketError>.Success {value} => { return 108 }
    Result<Accepted, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidNativeAddress {family, length} => {
        if family != -1 || length != usize.ONE { return 109 }
      }
      _ => { return 110 }
    }
  }
  if unsafe silk_listener_stub_closed_accepted() != 1 { return 111 }
  run Listener.close(&mut listener)

  unsafe { silk_listener_stub_reset(107) }
  let mut unknownListener = run listen(loopback(), ListenOptions.defaults())
  let unknown = run Effect.result(
    accept(&mut unknownListener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
  )
  match move unknown {
    Result<Accepted, NativeSocketError>.Success {value} => { return 112 }
    Result<Accepted, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.InvalidNativeAddress {family, length} => {
        if family != 31337 || length != 16 { return 113 }
      }
      _ => { return 114 }
    }
  }
  run Listener.close(&mut unknownListener)

  unsafe { silk_listener_stub_reset(108) }
  let mut abstractListener = run listenUnix(b"/tmp/silk-jul-191-script.sock", ListenOptions.defaults())
  let abstract = run Effect.result(
    accept(&mut abstractListener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
  )
  match move abstract {
    Result<Accepted, NativeSocketError>.Success {value} => { return 115 }
    Result<Accepted, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.UnsupportedPeerAddress {family, length} => {
        if family != 1 || length != 3 { return 116 }
      }
      _ => { return 117 }
    }
  }
  if unsafe silk_listener_stub_closed_accepted() != 1 { return 118 }
  run Listener.close(&mut abstractListener)
  return 42
}

effect fn scriptedAcceptFailures() -> i32 ! NativeSocketError {
  unsafe { silk_listener_stub_reset(105) }
  let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let mut listener = run listen(loopback(), ListenOptions.defaults())
  let denied = run Effect.result(
    accept(&mut listener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
  )
  match move denied {
    Result<Accepted, NativeSocketError>.Success {value} => { return 119 }
    Result<Accepted, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.PermissionDenied => {}
      _ => { return 120 }
    }
  }
  if unsafe silk_listener_stub_closed_accepted() != 0 { return 121 }
  run Listener.close(&mut listener)

  unsafe { silk_listener_stub_reset(117) }
  let mut configured = run listen(loopback(), ListenOptions.defaults())
  let setup = run Effect.result(
    accept(&mut configured, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
  )
  match move setup {
    Result<Accepted, NativeSocketError>.Success {value} => { return 122 }
    Result<Accepted, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.NativeFailure {operation, errno} => {
        if operation != NativeSocketOperation.Configure || errno != 5 { return 123 }
      }
      _ => { return 124 }
    }
  }
  if unsafe silk_listener_stub_closed_accepted() != 1 { return 125 }
  run Listener.close(&mut configured)
  return 42
}

effect fn scriptedDeadlineAndClose() -> i32 ! NativeSocketError {
  unsafe { silk_listener_stub_reset(119) }
  let mut clock = ImmediateClock {nowValue: SystemClock.make(5, 0), waits: usize.ZERO}
  let mut listener = run listen(loopback(), ListenOptions.defaults())
  let timed = run Effect.result(
    accept(&mut listener, Option.some<Instant>(SystemClock.make(5, 0)))
      |> Effect.provideMut<MonotonicClock>(&mut clock)
  )
  match move timed {
    Result<Accepted, NativeSocketError>.Success {value} => { return 126 }
    Result<Accepted, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.Timeout => {}
      _ => { return 127 }
    }
  }
  if unsafe silk_listener_stub_accepts() != 0 || unsafe silk_listener_stub_polls() != 0 { return 128 }
  run Listener.close(&mut listener)

  unsafe { silk_listener_stub_reset(118) }
  let mut failingClose = run listen(loopback(), ListenOptions.defaults())
  let first = run Effect.result(Listener.close(&mut failingClose))
  match move first {
    Result<(), NativeSocketError>.Success {value} => { return 129 }
    Result<(), NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.NativeFailure {operation, errno} => {
        if operation != NativeSocketOperation.Close || errno != 5 { return 130 }
      }
      _ => { return 131 }
    }
  }
  run Listener.close(&mut failingClose)
  if Listener.phase(&failingClose) != ListenerPhase.Closed
    || unsafe silk_listener_stub_close_attempts() != 1 { return 132 }

  unsafe { silk_listener_stub_reset(133) }
  let mut overflowClock = ImmediateClock {
    nowValue: SystemClock.make(i64.MAX, 999500000),
    waits: usize.ZERO,
  }
  let mut overflowListener = run listen(loopback(), ListenOptions.defaults())
  let overflowed = run Effect.result(
    accept(&mut overflowListener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut overflowClock)
  )
  match move overflowed {
    Result<Accepted, NativeSocketError>.Success {value} => { return 242 }
    Result<Accepted, NativeSocketError>.Failure {error} => match move error {
      NativeSocketError.TimeRangeError => {}
      _ => { return 243 }
    }
  }
  if overflowClock.waits != usize.ZERO || unsafe silk_listener_stub_accepts() != 1
    || unsafe silk_listener_stub_polls() != 1 { return 244 }
  run Listener.close(&mut overflowListener)
  return 42
}

effect fn scriptedPollFailures() -> i32 ! NativeSocketError {
  let mut mode = 121
  while mode <= 123 {
    unsafe { silk_listener_stub_reset(mode) }
    let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
    let mut listener = run listen(loopback(), ListenOptions.defaults())
    let attempted = run Effect.result(
      accept(&mut listener, Option.none<Instant>())
        |> Effect.provideMut<MonotonicClock>(&mut clock)
    )
    match move attempted {
      Result<Accepted, NativeSocketError>.Success {value} => { return 170 + mode - 121 }
      Result<Accepted, NativeSocketError>.Failure {error} => match move error {
        NativeSocketError.NativeFailure {operation, errno} => {
          if mode == 121 && (operation != NativeSocketOperation.Poll || errno != 9) { return 174 }
          if mode == 123 && (operation != NativeSocketOperation.GetSocketOption || errno != 5) {
            return 175
          }
          if mode == 122 { return 176 }
        }
        NativeSocketError.PermissionDenied => {
          if mode != 122 { return 177 }
        }
        _ => { return 178 }
      }
    }
    if unsafe silk_listener_stub_polls() != 1 { return 179 }
    if mode >= 122 && unsafe silk_listener_stub_getsockopts() != 1 { return 180 }
    if unsafe silk_listener_stub_closed_accepted() != 0 { return 181 }
    run Listener.close(&mut listener)
    mode = mode + 1
  }
  return 42
}

effect fn scriptedScopedLifecycles() -> i32 ! NativeSocketError {
  unsafe { silk_listener_stub_reset(101) }
  let successful = run withListener(
    run listen(loopback(), ListenOptions.defaults()),
    scopedListenerSuccess,
  )
  if successful != 42 || unsafe silk_listener_stub_closed_listener() != 1 { return 186 }

  unsafe { silk_listener_stub_reset(118) }
  let protectedListener = run Effect.result(withListener(
    run listen(loopback(), ListenOptions.defaults()),
    scopedListenerFailure,
  ))
  match move protectedListener {
    Result<i32, ByteIoError>.Success {value} => { return 187 }
    Result<i32, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Provider {operation, code} => {
        if operation != ByteIoOperation.Flush || code != 777 { return 188 }
      }
      _ => { return 189 }
    }
  }
  if unsafe silk_listener_stub_closed_listener() != 1
    || unsafe silk_listener_stub_close_attempts() != 1 { return 190 }

  unsafe { silk_listener_stub_reset(101) }
  let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let mut listener = run listen(loopback(), ListenOptions.defaults())
  let accepted = run accept(&mut listener, Option.none<Instant>())
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  unsafe { silk_listener_stub_reset(124) }
  let protectedAccepted = run Effect.result(withAcceptedContext(
    move accepted,
    FailingAcceptedContext {code: 778},
  ))
  match move protectedAccepted {
    Result<i32, ByteIoError>.Success {value} => { return 191 }
    Result<i32, ByteIoError>.Failure {error} => match move error {
      ByteIoError.Provider {operation, code} => {
        if operation != ByteIoOperation.Flush || code != 778 { return 192 }
      }
      _ => { return 193 }
    }
  }
  if unsafe silk_listener_stub_closed_accepted() != 1
    || unsafe silk_listener_stub_close_attempts() != 1 { return 194 }
  run Listener.close(&mut listener)
  return 42
}

effect fn parkedListenerAccept(listener: &mut Listener) -> i32
! NativeSocketError
? &mut MonotonicClock {
  let accepted = run accept(&mut listener.*, Option.none<Instant>())
  drop accepted
  unsafe { silk_listener_stub_mark_completion() }
  return 1
}

effect fn parkedListenerScope() -> i32 ! NativeSocketError {
  let mut clock = ParkingClock {}
  let listener = run listen(loopback(), ListenOptions.defaults())
  return run withListener<i32, NativeSocketError>(move listener, parkedListenerAccept)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
}

effect fn parkedListenerFailed(error: NativeSocketError) -> i32 {
  drop error
  return -1
}

fn listenerCancellationReady(state: &()) -> () { return () }
fn listenerCancellationComplete(state: &mut i32, value: i32) -> () {
  state.* = value
  return ()
}
fn listenerCancellationParked(state: &mut i32, execution: Intrinsic.Execution<i32>) -> () {
  drop move execution
  state.* = 42
  return ()
}

effect fn scriptedCancellation() -> i32 ! OutOfMemoryError {
  unsafe { silk_listener_stub_reset(132) }
  let mut allocator = Allocator.systemAllocatorProvider()
  let body = Effect.catchAll(parkedListenerScope(), parkedListenerFailed)
  let execution = run Execution.make(move body, (), listenerCancellationReady)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut result = 0
  run Execution.drive(
    move execution,
    &mut result,
    listenerCancellationComplete,
    listenerCancellationParked,
  )
  if result != 42 { return 198 }
  if unsafe silk_listener_stub_wait_registrations() != 1 { return 199 }
  if unsafe silk_listener_stub_wake_releases() != 1 { return 200 }
  if unsafe silk_listener_stub_configuration_ok() != 1 { return 212 }
  if unsafe silk_listener_stub_closed_listener() != 1
    || unsafe silk_listener_stub_close_attempts() != 1 { return 213 }
  if unsafe silk_listener_stub_accepts() != 1 || unsafe silk_listener_stub_polls() != 1 {
    return 214
  }
  if unsafe silk_listener_stub_closed_accepted() != 0
    || unsafe silk_listener_stub_completions() != 0 { return 215 }
  return 42
}

effect fn parkedAcceptedContextScope(accepted: Accepted) -> i32 {
  return run withAcceptedContext(move accepted, ParkedAcceptedContext {marker: 42})
}

effect fn scriptedAcceptedContextCancellation() -> i32
! NativeSocketError | OutOfMemoryError {
  unsafe { silk_listener_stub_reset(101) }
  let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let mut listener = run listen(loopback(), ListenOptions.defaults())
  let accepted = run accept(&mut listener, Option.none<Instant>())
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  run Listener.close(&mut listener)

  unsafe { silk_listener_stub_reset(134) }
  let mut allocator = Allocator.systemAllocatorProvider()
  let execution = run Execution.make(
    parkedAcceptedContextScope(move accepted),
    (),
    listenerCancellationReady,
  ) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut result = 0
  run Execution.drive(
    move execution,
    &mut result,
    listenerCancellationComplete,
    listenerCancellationParked,
  )
  if result != 42 { return 254 }
  if unsafe silk_listener_stub_wait_registrations() != 1
    || unsafe silk_listener_stub_wake_releases() != 1
    || unsafe silk_listener_stub_context_releases() != 1 { return 255 }
  if unsafe silk_listener_stub_closed_listener() != 0
    || unsafe silk_listener_stub_closed_accepted() != 1
    || unsafe silk_listener_stub_close_attempts() != 1 { return 256 }
  if unsafe silk_listener_stub_completions() != 0
    || unsafe silk_listener_stub_configuration_ok() != 1 { return 257 }
  return 42
}

effect fn openDarwinScriptListener(mode: i32) -> Listener ! NativeSocketError {
  if mode == 203 { return run listen(loopbackV6(), ListenOptions.defaults()) }
  return run listen(loopback(), ListenOptions.defaults())
}

effect fn scriptedDarwinCases() -> i32 ! NativeSocketError {
  static if Intrinsic.targetOperatingSystem() == "darwin" {
    let mut mode = 200
    while mode <= 203 {
      unsafe { silk_listener_stub_reset(mode) }
      let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
      let mut listener = run openDarwinScriptListener(mode)
      if mode == 203 {
        let bound = Listener.boundAddress(&listener)
        match move bound {
          BoundAddress.Tcp {endpoint} => match move Endpoint.address(&endpoint) {
            IpAddress.V6 {value} => {
              let octets = Ipv6Address.octets(&value)
              if Port.value(&Endpoint.port(&endpoint)) != 43211 || octets[15] != 1 { return 246 }
            }
            _ => { return 247 }
          }
          _ => { return 248 }
        }
        if unsafe silk_listener_stub_setsockopts() != 1 { return 249 }
      }
      let attempted = run Effect.result(
        accept(&mut listener, Option.none<Instant>())
          |> Effect.provideMut<MonotonicClock>(&mut clock)
      )
      match move attempted {
        Result<Accepted, NativeSocketError>.Success {value} => {
          if mode != 200 && mode != 203 { return 231 }
          let inspected = run inspectScriptAccepted(move value, 0)
            |> Effect.provideMut<MonotonicClock>(&mut clock)
          if inspected != 42 || unsafe silk_listener_stub_fcntls() != 8 { return 232 }
          if mode == 203 && unsafe silk_listener_stub_setsockopts() != 3 { return 250 }
        }
        Result<Accepted, NativeSocketError>.Failure {error} => {
          if mode == 200 { return 233 }
          match move error {
            NativeSocketError.InvalidNativeAddress {family, length} => {
              if mode != 201 || family != 2 || length != 16 { return 234 }
              if unsafe silk_listener_stub_fcntls() != 8 { return 235 }
            }
            NativeSocketError.NativeFailure {operation, errno} => {
              if mode != 202 || operation != NativeSocketOperation.Configure || errno != 5 {
                return 236
              }
              if unsafe silk_listener_stub_fcntls() != 5 { return 237 }
            }
            _ => { return 238 }
          }
          if unsafe silk_listener_stub_closed_accepted() != 1 { return 239 }
        }
      }
      if unsafe silk_listener_stub_configuration_ok() != 1 { return 240 }
      run Listener.close(&mut listener)
      mode = mode + 1
    }
  }
  return 42
}

struct BoundaryClock {samples: i64 expireAt: i64}
impl MonotonicClock for BoundaryClock {
  effect fn now(self: &mut Self) -> Instant {
    self.samples = self.samples + 1
    if self.samples >= self.expireAt { return SystemClock.make(5, 0) }
    return SystemClock.make(0, 0)
  }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { drop howLong return () }
}

effect fn scriptedBoundaryDeadlines() -> i32 ! NativeSocketError {
  let mut stage = 0
  while stage < 3 {
    let mut mode = 122
    let mut expireAt: i64 = 2
    if stage == 1 { expireAt = 3 }
    if stage == 2 { mode = 101 }
    unsafe { silk_listener_stub_reset(mode) }
    let mut listener = run openScriptListener(0)
    let mut clock = BoundaryClock {samples: 0, expireAt: expireAt}
    let result = run Effect.result(
      accept(&mut listener, Option.some<Instant>(SystemClock.make(5, 0)))
        |> Effect.provideMut<MonotonicClock>(&mut clock)
    )
    match move result {
      Result<Accepted, NativeSocketError>.Success {value} => { return 251 }
      Result<Accepted, NativeSocketError>.Failure {error} => {
        match move error { NativeSocketError.Timeout => {} _ => { return 252 } }
      }
    }
    if unsafe silk_listener_stub_accepts() != 1 { return 253 }
    if unsafe silk_listener_stub_getsockopts() != 0 { return 254 }
    if stage == 0 && unsafe silk_listener_stub_polls() != 0 { return 255 }
    if stage == 1 && unsafe silk_listener_stub_polls() != 1 { return 256 }
    if stage == 2 && unsafe silk_listener_stub_closed_accepted() != 1 { return 257 }
    if unsafe silk_listener_stub_setsockopts() != 0 { return 258 }
    run Listener.close(&mut listener)
    stage = stage + 1
  }
  unsafe { silk_listener_stub_reset(140) }
  let mut listener = run openScriptListener(1)
  let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  let result = run Effect.result(
    accept(&mut listener, Option.none<Instant>())
      |> Effect.provideMut<MonotonicClock>(&mut clock)
  )
  match move result {
    Result<Accepted, NativeSocketError>.Success {value} => { return 259 }
    Result<Accepted, NativeSocketError>.Failure {error} => {
      match move error {
        NativeSocketError.NativeFailure {operation, errno} => {
          if operation != NativeSocketOperation.Accept || errno != 103 { return 260 }
        }
        _ => { return 261 }
      }
    }
  }
  if clock.waits != usize.ZERO || unsafe silk_listener_stub_accepts() != 1 { return 262 }
  run Listener.close(&mut listener)
  return 42
}

effect fn scriptedCases() -> i32 ! NativeSocketError | OutOfMemoryError {
  let darwin = run Effect.result(scriptedDarwinCases())
  match move darwin {
    Result<i32, NativeSocketError>.Failure {error} => { return 241 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  static if Intrinsic.targetOperatingSystem() == "darwin" { return 42 }
  let boundaries = run scriptedBoundaryDeadlines()
  if boundaries != 42 { return boundaries }
  let invalid = run scriptedInvalidInputs()
  if invalid != 42 { return invalid }
  let setup = run scriptedSetupFailures()
  if setup != 42 { return setup }
  let precise = run Effect.result(scriptedPreciseErrnos())
  match move precise {
    Result<i32, NativeSocketError>.Failure {error} => { return 225 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let ipv6 = run Effect.result(scriptedIpv6Setup())
  match move ipv6 {
    Result<i32, NativeSocketError>.Failure {error} => { return 230 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let addresses = run Effect.result(scriptedAddressFailures())
  match move addresses {
    Result<i32, NativeSocketError>.Failure {error} => { return 141 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let failures = run Effect.result(scriptedAcceptFailures())
  match move failures {
    Result<i32, NativeSocketError>.Failure {error} => { return 142 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let deadline = run Effect.result(scriptedDeadlineAndClose())
  match move deadline {
    Result<i32, NativeSocketError>.Failure {error} => { return 143 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let pollFailures = run Effect.result(scriptedPollFailures())
  match move pollFailures {
    Result<i32, NativeSocketError>.Failure {error} => { return 182 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let lifecycles = run Effect.result(scriptedScopedLifecycles())
  match move lifecycles {
    Result<i32, NativeSocketError>.Failure {error} => { return 195 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let cancellation = run scriptedCancellation()
  if cancellation != 42 { return cancellation }
  let contextCancellation = run scriptedAcceptedContextCancellation()
  if contextCancellation != 42 { return contextCancellation }
  let mut mode = 101
  while mode <= 104 {
    let mut expectedWaits = usize.ONE
    if mode == 101 || mode == 102 { expectedWaits = usize.ZERO }
    let mut expectedAccepts = 2
    if mode == 101 { expectedAccepts = 1 }
    let attempted = run Effect.result(scriptedAcceptSuccess(mode, expectedWaits, expectedAccepts, 0))
    match move attempted {
      Result<i32, NativeSocketError>.Failure {error} => { return mode + 40 }
      Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
    }
    mode = mode + 1
  }
  let readinessRace = run Effect.result(scriptedAcceptSuccess(131, usize.ONE, 3, 0))
  match move readinessRace {
    Result<i32, NativeSocketError>.Failure {error} => { return 197 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let mut pendingMode = 140
  while pendingMode <= 148 {
    let pending = run Effect.result(scriptedAcceptSuccess(pendingMode, usize.ONE, 2, 0))
    match move pending {
      Result<i32, NativeSocketError>.Failure {error} => { return 245 }
      Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
    }
    pendingMode = pendingMode + 1
  }
  let pollInterrupted = run Effect.result(scriptedAcceptSuccess(120, usize.ONE, 2, 0))
  match move pollInterrupted {
    Result<i32, NativeSocketError>.Failure {error} => { return 160 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let unnamed = run Effect.result(scriptedAcceptSuccess(109, usize.ZERO, 1, 1))
  match move unnamed {
    Result<i32, NativeSocketError>.Failure {error} => { return 161 }
    Result<i32, NativeSocketError>.Success {value} => { if value != 42 { return value } }
  }
  let pathname = run Effect.result(scriptedAcceptSuccess(110, usize.ZERO, 1, 2))
  return match move pathname {
    Result<i32, NativeSocketError>.Failure {error} => 162
    Result<i32, NativeSocketError>.Success {value} => value
  }
}

effect fn runCases() -> i32 ! NativeSocketError | ByteIoError | OutOfMemoryError {
  if unsafe silk_listener_darwin_witness() != 42 { return 51 }
  if unsafe silk_listener_gnu_witness() != 42 { return 52 }
  let defaults = ListenOptions.defaults()
  if ListenOptions.kernelBacklog(&defaults) != 128 { return 53 }
  if ListenOptions.reuseAddress(&defaults) { return 54 }
  if ListenOptions.pollInterval(&defaults) != 1000000 { return 55 }
  let mut clock = ImmediateClock {nowValue: SystemClock.make(0, 0), waits: usize.ZERO}
  if unsafe silk_listener_loopback_available() == 1 {
    let http = run httpCase(&mut clock)
    if http != 42 { return http }
    let tcp = run Effect.result(tcpCase(&mut clock))
    match move tcp {
      Result<i32, NativeSocketError | ByteIoError>.Failure {error} => { return 139 }
      Result<i32, NativeSocketError | ByteIoError>.Success {value} => { if value != 42 { return value } }
    }
    let unix = run Effect.result(unixCase(&mut clock))
    match move unix {
      Result<i32, NativeSocketError | ByteIoError>.Failure {error} => { return 140 }
      Result<i32, NativeSocketError | ByteIoError>.Success {value} => { if value != 42 { return value } }
    }
  }
  static if Intrinsic.targetOperatingSystem() == "linux" || Intrinsic.targetOperatingSystem() == "darwin" {
    return run scriptedCases()
  }
  return 42
}

effect fn recover(error: NativeSocketError | ByteIoError | OutOfMemoryError) -> i32 {
  return match move error {
    NativeSocketError.AddressInUse => 201
    NativeSocketError.PermissionDenied => 202
    NativeSocketError.FamilyUnsupported => 203
    NativeSocketError.SystemResources => 204
    NativeSocketError.Timeout => 205
    NativeSocketError.Closed => 206
    NativeSocketError.TimeRangeError => 207
    NativeSocketError.InvalidNativeAddress {family, length} => 208
    NativeSocketError.UnsupportedPeerAddress {family, length} => 209
    NativeSocketError.NativeFailure {operation, errno} => {
      if errno == 5 { return 210 }
      return 211
    }
    OutOfMemoryError {} => 216
    _ => 212
  }
}
pub fn main() -> i32 { return run runCases() |> Effect.catchAll(recover) }
`

/** Real local-loopback helper used by the shared native acceptance program. */
export const nativeListenerHelperSource = `
#define _GNU_SOURCE
#include <arpa/inet.h>
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <sys/time.h>
#include <sys/syscall.h>
#include <sys/un.h>
#include <unistd.h>
#if defined(__APPLE__)
#include <dlfcn.h>
#include <stdarg.h>
#endif

static int silk_listener_http_active = 0;
static int silk_listener_http_accepted = -1;
static int silk_listener_http_listener = -1;
static int silk_listener_http_accepts = 0;
static int silk_listener_http_accepted_closes = 0;
static int silk_listener_http_listener_closes = 0;

static int silk_listener_http_admitted(int listener, int accepted) {
  if (silk_listener_http_active && accepted >= 0) {
    silk_listener_http_listener = listener;
    silk_listener_http_accepted = accepted;
    silk_listener_http_accepts += 1;
  }
  return accepted;
}

static void silk_listener_http_closed(int fd) {
  if (!silk_listener_http_active) return;
  if (fd == silk_listener_http_accepted) silk_listener_http_accepted_closes += 1;
  if (fd == silk_listener_http_listener) silk_listener_http_listener_closes += 1;
}

static int silk_listener_mode = 0;
static int silk_listener_sockets = 0;
static int silk_listener_binds = 0;
static int silk_listener_listens = 0;
static int silk_listener_getsocknames = 0;
static int silk_listener_accepts = 0;
static int silk_listener_polls = 0;
static int silk_listener_setsockopts = 0;
static int silk_listener_getsockopts = 0;
static int silk_listener_closes = 0;
static int silk_listener_closed_listener = 0;
static int silk_listener_closed_accepted = 0;
static int silk_listener_configuration_ok = 1;
static int silk_listener_wait_registrations = 0;
static int silk_listener_wake_releases = 0;
static int silk_listener_context_releases = 0;
static int silk_listener_completions = 0;
static int silk_listener_setup_order = 0;
static int silk_listener_domain = AF_UNSPEC;
static int silk_listener_fcntls = 0;

int silk_listener_loopback_available(void) {
#if defined(__linux__)
  int fd = (int)syscall(SYS_socket, AF_INET, SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC, IPPROTO_TCP);
#else
  int fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
#endif
  if (fd < 0) return 0;
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons(0);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
#if defined(__linux__)
  int bound = (int)syscall(SYS_bind, fd, &address, sizeof(address));
  int listened = bound == 0 ? (int)syscall(SYS_listen, fd, 1) : -1;
  (void)syscall(SYS_close, fd);
#else
  int bound = bind(fd, (const struct sockaddr *)&address, sizeof(address));
  int listened = bound == 0 ? listen(fd, 1) : -1;
  (void)close(fd);
#endif
  return bound == 0 && listened == 0 ? 1 : 0;
}

void silk_listener_stub_reset(int mode) {
  silk_listener_mode = mode;
  silk_listener_sockets = 0;
  silk_listener_binds = 0;
  silk_listener_listens = 0;
  silk_listener_getsocknames = 0;
  silk_listener_accepts = 0;
  silk_listener_polls = 0;
  silk_listener_setsockopts = 0;
  silk_listener_getsockopts = 0;
  silk_listener_closes = 0;
  silk_listener_closed_listener = 0;
  silk_listener_closed_accepted = 0;
  silk_listener_configuration_ok = 1;
  silk_listener_wait_registrations = 0;
  silk_listener_wake_releases = 0;
  silk_listener_context_releases = 0;
  silk_listener_completions = 0;
  silk_listener_setup_order = 0;
  silk_listener_domain = AF_UNSPEC;
  silk_listener_fcntls = 0;
}

int silk_listener_stub_sockets(void) { return silk_listener_sockets; }
int silk_listener_stub_binds(void) { return silk_listener_binds; }
int silk_listener_stub_listens(void) { return silk_listener_listens; }
int silk_listener_stub_getsocknames(void) { return silk_listener_getsocknames; }
int silk_listener_stub_accepts(void) { return silk_listener_accepts; }
int silk_listener_stub_polls(void) { return silk_listener_polls; }
int silk_listener_stub_setsockopts(void) { return silk_listener_setsockopts; }
int silk_listener_stub_getsockopts(void) { return silk_listener_getsockopts; }
int silk_listener_stub_close_attempts(void) { return silk_listener_closes; }
int silk_listener_stub_closed_listener(void) { return silk_listener_closed_listener; }
int silk_listener_stub_closed_accepted(void) { return silk_listener_closed_accepted; }
int silk_listener_stub_configuration_ok(void) { return silk_listener_configuration_ok; }
int silk_listener_stub_fcntls(void) { return silk_listener_fcntls; }
int silk_listener_stub_wait_registrations(void) { return silk_listener_wait_registrations; }
int silk_listener_stub_wake_releases(void) { return silk_listener_wake_releases; }
int silk_listener_stub_context_releases(void) { return silk_listener_context_releases; }
int silk_listener_stub_completions(void) { return silk_listener_completions; }
void silk_listener_stub_mark_wait_registration(void) { silk_listener_wait_registrations += 1; }
void silk_listener_stub_mark_wake_release(void) { silk_listener_wake_releases += 1; }
void silk_listener_stub_mark_context_release(void) { silk_listener_context_releases += 1; }
void silk_listener_stub_mark_completion(void) { silk_listener_completions += 1; }

#if defined(__linux__)
static int silk_listener_scripted(void) { return silk_listener_mode >= 100; }

int socket(int domain, int type, int protocol) {
  silk_listener_sockets += 1;
  if (!silk_listener_scripted()) return (int)syscall(SYS_socket, domain, type, protocol);
  if (silk_listener_setup_order != 0) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 1;
  silk_listener_domain = domain;
  if (silk_listener_mode == 125) { errno = ECONNREFUSED; return -1; }
  if (silk_listener_mode == 112) { errno = ENOMEM; return -1; }
  if (domain != AF_INET && domain != AF_INET6 && domain != AF_UNIX)
    silk_listener_configuration_ok = 0;
  if ((type & (SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC))
      != (SOCK_STREAM | SOCK_NONBLOCK | SOCK_CLOEXEC))
    silk_listener_configuration_ok = 0;
  if ((domain == AF_INET || domain == AF_INET6) && protocol != IPPROTO_TCP)
    silk_listener_configuration_ok = 0;
  if (domain == AF_UNIX && protocol != 0) silk_listener_configuration_ok = 0;
  return 40;
}

int bind(int fd, const struct sockaddr *address, socklen_t length) {
  silk_listener_binds += 1;
  if (!silk_listener_scripted()) return (int)syscall(SYS_bind, fd, address, length);
  if (silk_listener_setup_order != 1 && silk_listener_setup_order != 2)
    silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 3;
  if (fd != 40 || address == NULL) silk_listener_configuration_ok = 0;
  if (address != NULL && address->sa_family == AF_INET && length != sizeof(struct sockaddr_in))
    silk_listener_configuration_ok = 0;
  if (address != NULL && address->sa_family == AF_INET6 && length != sizeof(struct sockaddr_in6))
    silk_listener_configuration_ok = 0;
  if (address != NULL && address->sa_family == AF_UNIX
      && (length < (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 2)
        || length > sizeof(struct sockaddr_un)))
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 126) { errno = ECONNREFUSED; return -1; }
  if (silk_listener_mode == 111) { errno = EADDRINUSE; return -1; }
  return 0;
}

int listen(int fd, int backlog) {
  silk_listener_listens += 1;
  if (!silk_listener_scripted()) return (int)syscall(SYS_listen, fd, backlog);
  if (silk_listener_setup_order != 3) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 4;
  int expected = silk_listener_mode == 113 ? 64 : 128;
  if (fd != 40 || backlog != expected) silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 127) { errno = ECONNREFUSED; return -1; }
  if (silk_listener_mode == 114) { errno = EMFILE; return -1; }
  return 0;
}

static void silk_listener_fill_v4(
  struct sockaddr *address,
  socklen_t *length,
  uint16_t port,
  unsigned char last
) {
  struct sockaddr_in *value = (struct sockaddr_in *)address;
  memset(value, 0, sizeof(*value));
  value->sin_family = AF_INET;
  value->sin_port = htons(port);
  value->sin_addr.s_addr = htonl(0xc0000200u + last);
  *length = (socklen_t)sizeof(*value);
}

static void silk_listener_fill_v6(
  struct sockaddr *address,
  socklen_t *length,
  uint16_t port
) {
  struct sockaddr_in6 *value = (struct sockaddr_in6 *)address;
  memset(value, 0, sizeof(*value));
  value->sin6_family = AF_INET6;
  value->sin6_port = htons(port);
  value->sin6_addr = in6addr_loopback;
  *length = (socklen_t)sizeof(*value);
}

int getsockname(int fd, struct sockaddr *address, socklen_t *length) {
  silk_listener_getsocknames += 1;
  if (!silk_listener_scripted()) return (int)syscall(SYS_getsockname, fd, address, length);
  if (silk_listener_setup_order != 4) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 5;
  if (fd != 40 || address == NULL || length == NULL || *length != 128)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 128) { errno = -77; return -1; }
  if (silk_listener_mode == 115) { *length = 1; return 0; }
  if (silk_listener_mode == 130) {
    silk_listener_fill_v6(address, length, 43211);
    return 0;
  }
  silk_listener_fill_v4(address, length, 43210, 1);
  if (silk_listener_mode == 116) *length = 17;
  return 0;
}

int setsockopt(int fd, int level, int option, const void *value, socklen_t length) {
  if (!silk_listener_scripted())
    return (int)syscall(SYS_setsockopt, fd, level, option, value, length);
  silk_listener_setsockopts += 1;
  if (value == NULL || length != 4 && length != 8) silk_listener_configuration_ok = 0;
  if (fd == 40 && silk_listener_mode == 113) {
    if (level != SOL_SOCKET || option != SO_REUSEADDR || length != 4)
      silk_listener_configuration_ok = 0;
    errno = EACCES;
    return -1;
  }
  if (fd == 40) {
    if (silk_listener_setup_order != 1) silk_listener_configuration_ok = 0;
    silk_listener_setup_order = 2;
  }
  if (fd == 40 && silk_listener_mode == 130) {
    if (level != IPPROTO_IPV6 || option != IPV6_V6ONLY || length != 4
        || *(const int *)value != 1)
      silk_listener_configuration_ok = 0;
  }
  if (fd == 41 && option != SO_LINGER) silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 117 && fd == 41) { errno = EIO; return -1; }
  return 0;
}

int accept4(int fd, struct sockaddr *address, socklen_t *length, int flags) {
  if (!silk_listener_scripted()) return silk_listener_http_admitted(fd,
    (int)syscall(SYS_accept4, fd, address, length, flags));
  silk_listener_accepts += 1;
  // Pathname Unix listeners keep their requested path, so only internet listeners ask getsockname.
  if (silk_listener_setup_order != (silk_listener_domain == AF_UNIX ? 4 : 5))
    silk_listener_configuration_ok = 0;
  if (fd != 40 || address == NULL || length == NULL || *length != 128
      || flags != (SOCK_NONBLOCK | SOCK_CLOEXEC))
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 129) { errno = ECONNREFUSED; return -1; }
  if (silk_listener_mode == 105) { errno = EACCES; return -1; }
  if (silk_listener_mode == 102 && silk_listener_accepts == 1) { errno = EAGAIN; return -1; }
  if (silk_listener_mode == 131 && silk_listener_accepts <= 2) { errno = EAGAIN; return -1; }
  if (silk_listener_mode == 132 || silk_listener_mode == 133) { errno = EAGAIN; return -1; }
  if (silk_listener_mode == 103 && silk_listener_accepts == 1) { errno = EINTR; return -1; }
  if (silk_listener_mode == 104 && silk_listener_accepts == 1) { errno = ECONNABORTED; return -1; }
  if (silk_listener_mode >= 140 && silk_listener_mode <= 148
      && silk_listener_accepts == 1) {
    static const int pending_errors[] = {
      ECONNABORTED,
      ENETDOWN,
      EPROTO,
      ENOPROTOOPT,
      EHOSTDOWN,
      ENONET,
      EHOSTUNREACH,
      EOPNOTSUPP,
      ENETUNREACH,
    };
    errno = pending_errors[silk_listener_mode - 140];
    return -1;
  }
  if ((silk_listener_mode == 120 || silk_listener_mode == 121
      || silk_listener_mode == 122 || silk_listener_mode == 123)
      && silk_listener_accepts == 1) { errno = EAGAIN; return -1; }
  if (silk_listener_mode == 106) { *length = 1; return 41; }
  if (silk_listener_mode == 107) {
    memset(address, 0, 16);
    address->sa_family = (sa_family_t)31337;
    *length = 16;
    return 41;
  }
  if (silk_listener_mode == 108) {
    struct sockaddr_un *peer = (struct sockaddr_un *)address;
    memset(peer, 0, sizeof(*peer));
    peer->sun_family = AF_UNIX;
    peer->sun_path[0] = 0;
    *length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 1);
    return 41;
  }
  if (silk_listener_mode == 109) {
    struct sockaddr_un *peer = (struct sockaddr_un *)address;
    memset(peer, 0, sizeof(*peer));
    peer->sun_family = AF_UNIX;
    *length = (socklen_t)offsetof(struct sockaddr_un, sun_path);
    return 41;
  }
  if (silk_listener_mode == 110) {
    struct sockaddr_un *peer = (struct sockaddr_un *)address;
    memset(peer, 0, sizeof(*peer));
    peer->sun_family = AF_UNIX;
    memcpy(peer->sun_path, "peer", 5);
    *length = (socklen_t)(offsetof(struct sockaddr_un, sun_path) + 5);
    return 41;
  }
  silk_listener_fill_v4(address, length, 1234, 9);
  return 41;
}

int poll(struct pollfd *fds, nfds_t count, int timeout) {
  if (!silk_listener_scripted()) return (int)syscall(SYS_poll, fds, count, timeout);
  silk_listener_polls += 1;
  if (fds == NULL || count != 1 || timeout != 0 || fds[0].fd != 40
      || fds[0].events != POLLIN)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 120 && silk_listener_polls == 1) { errno = EINTR; return -1; }
  if (silk_listener_mode == 132 || silk_listener_mode == 133) {
    fds[0].revents = 0;
    return 0;
  }
  if (silk_listener_mode == 121) { fds[0].revents = POLLNVAL; return 1; }
  if (silk_listener_mode == 122 || silk_listener_mode == 123) {
    fds[0].revents = POLLERR;
    return 1;
  }
  fds[0].revents = POLLIN;
  return 1;
}

int getsockopt(int fd, int level, int option, void *value, socklen_t *length) {
  if (!silk_listener_scripted())
    return (int)syscall(SYS_getsockopt, fd, level, option, value, length);
  silk_listener_getsockopts += 1;
  if (fd != 40 || level != SOL_SOCKET || option != SO_ERROR || value == NULL
      || length == NULL || *length < sizeof(int))
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 123) { errno = EIO; return -1; }
  *(int *)value = EACCES;
  *length = sizeof(int);
  return 0;
}

int close(int fd) {
  if (!silk_listener_scripted()) {
    silk_listener_http_closed(fd);
    return (int)syscall(SYS_close, fd);
  }
  silk_listener_closes += 1;
  if (fd == 40) silk_listener_closed_listener += 1;
  if (fd == 41) silk_listener_closed_accepted += 1;
  if (((silk_listener_mode == 132 && fd == 40)
      || (silk_listener_mode == 134 && fd == 41))
      && silk_listener_wake_releases != 1)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 134 && fd == 41 && silk_listener_context_releases != 1)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 118 && fd == 40) { errno = EIO; return -1; }
  if (silk_listener_mode == 124 && fd == 41) { errno = EIO; return -1; }
  return 0;
}
#endif

#if defined(__APPLE__)
static int silk_listener_darwin_scripted(void) { return silk_listener_mode >= 200; }

int socket(int domain, int type, int protocol) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_socket)(int, int, int) = NULL;
    if (real_socket == NULL) real_socket = dlsym(RTLD_NEXT, "socket");
    return real_socket(domain, type, protocol);
  }
  silk_listener_sockets += 1;
  int expected_domain = silk_listener_mode == 203 ? AF_INET6 : AF_INET;
  if (domain != expected_domain || type != SOCK_STREAM || protocol != IPPROTO_TCP)
    silk_listener_configuration_ok = 0;
  silk_listener_setup_order = 1;
  return 40;
}

int fcntl(int fd, int command, ...) {
  va_list arguments;
  va_start(arguments, command);
  int argument = 0;
  if (command == F_SETFL || command == F_SETFD) argument = va_arg(arguments, int);
  va_end(arguments);
  if (!silk_listener_darwin_scripted()) {
    static int (*real_fcntl)(int, int, ...) = NULL;
    if (real_fcntl == NULL) real_fcntl = dlsym(RTLD_NEXT, "fcntl");
    if (command == F_SETFL || command == F_SETFD) return real_fcntl(fd, command, argument);
    return real_fcntl(fd, command);
  }
  silk_listener_fcntls += 1;
  int position = fd == 40 ? silk_listener_fcntls : silk_listener_fcntls - 4;
  if (position == 1 && command != F_GETFL) silk_listener_configuration_ok = 0;
  if (position == 2 && (command != F_SETFL || (argument & O_NONBLOCK) == 0))
    silk_listener_configuration_ok = 0;
  if (position == 3 && command != F_GETFD) silk_listener_configuration_ok = 0;
  if (position == 4 && (command != F_SETFD || (argument & FD_CLOEXEC) == 0))
    silk_listener_configuration_ok = 0;
  if (fd == 40 && position == 4) silk_listener_setup_order = 2;
  if (silk_listener_mode == 202 && fd == 41 && position == 1) { errno = EIO; return -1; }
  return 0;
}

int bind(int fd, const struct sockaddr *address, socklen_t length) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_bind)(int, const struct sockaddr *, socklen_t) = NULL;
    if (real_bind == NULL) real_bind = dlsym(RTLD_NEXT, "bind");
    return real_bind(fd, address, length);
  }
  silk_listener_binds += 1;
  int expected_order = silk_listener_mode == 203 ? 3 : 2;
  if (silk_listener_setup_order != expected_order) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = expected_order + 1;
  if (silk_listener_mode == 203) {
    const struct sockaddr_in6 *value = (const struct sockaddr_in6 *)address;
    if (fd != 40 || address == NULL || length != sizeof(*value)
        || value->sin6_family != AF_INET6 || value->sin6_len != sizeof(*value))
      silk_listener_configuration_ok = 0;
  } else if (fd != 40 || address == NULL || length != sizeof(struct sockaddr_in)
      || address->sa_family != AF_INET || address->sa_len != sizeof(struct sockaddr_in)) {
    silk_listener_configuration_ok = 0;
  }
  return 0;
}

int listen(int fd, int backlog) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_listen)(int, int) = NULL;
    if (real_listen == NULL) real_listen = dlsym(RTLD_NEXT, "listen");
    return real_listen(fd, backlog);
  }
  silk_listener_listens += 1;
  int expected_order = silk_listener_mode == 203 ? 4 : 3;
  if (silk_listener_setup_order != expected_order) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = expected_order + 1;
  if (fd != 40 || backlog != 128) silk_listener_configuration_ok = 0;
  return 0;
}

static void silk_listener_darwin_fill_v4(
  struct sockaddr *address,
  socklen_t *length,
  uint16_t port,
  unsigned char last,
  unsigned char declared_length
) {
  struct sockaddr_in *value = (struct sockaddr_in *)address;
  memset(value, 0, sizeof(*value));
  value->sin_len = declared_length;
  value->sin_family = AF_INET;
  value->sin_port = htons(port);
  value->sin_addr.s_addr = htonl(0xc0000200u + last);
  *length = (socklen_t)sizeof(*value);
}

static void silk_listener_darwin_fill_v6(
  struct sockaddr *address,
  socklen_t *length,
  uint16_t port
) {
  struct sockaddr_in6 *value = (struct sockaddr_in6 *)address;
  memset(value, 0, sizeof(*value));
  value->sin6_len = sizeof(*value);
  value->sin6_family = AF_INET6;
  value->sin6_port = htons(port);
  value->sin6_addr = in6addr_loopback;
  *length = (socklen_t)sizeof(*value);
}

int getsockname(int fd, struct sockaddr *address, socklen_t *length) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_getsockname)(int, struct sockaddr *, socklen_t *) = NULL;
    if (real_getsockname == NULL) real_getsockname = dlsym(RTLD_NEXT, "getsockname");
    return real_getsockname(fd, address, length);
  }
  silk_listener_getsocknames += 1;
  int expected_order = silk_listener_mode == 203 ? 5 : 4;
  if (silk_listener_setup_order != expected_order) silk_listener_configuration_ok = 0;
  silk_listener_setup_order = expected_order + 1;
  if (fd != 40 || address == NULL || length == NULL || *length != 128)
    silk_listener_configuration_ok = 0;
  if (silk_listener_mode == 203) silk_listener_darwin_fill_v6(address, length, 43211);
  else silk_listener_darwin_fill_v4(address, length, 43210, 1, 16);
  return 0;
}

int accept(int fd, struct sockaddr *address, socklen_t *length) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_accept)(int, struct sockaddr *, socklen_t *) = NULL;
    if (real_accept == NULL) real_accept = dlsym(RTLD_NEXT, "accept");
    return silk_listener_http_admitted(fd, real_accept(fd, address, length));
  }
  silk_listener_accepts += 1;
  int expected_order = silk_listener_mode == 203 ? 6 : 5;
  if (silk_listener_setup_order != expected_order) silk_listener_configuration_ok = 0;
  if (fd != 40 || address == NULL || length == NULL || *length != 128)
    silk_listener_configuration_ok = 0;
  unsigned char declared_length = silk_listener_mode == 201 ? 15 : 16;
  silk_listener_darwin_fill_v4(address, length, 1234, 9, declared_length);
  return 41;
}

int setsockopt(int fd, int level, int option, const void *value, socklen_t length) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_setsockopt)(int, int, int, const void *, socklen_t) = NULL;
    if (real_setsockopt == NULL) real_setsockopt = dlsym(RTLD_NEXT, "setsockopt");
    return real_setsockopt(fd, level, option, value, length);
  }
  silk_listener_setsockopts += 1;
  if (silk_listener_mode == 203 && fd == 40) {
    if (silk_listener_setup_order != 2 || level != IPPROTO_IPV6 || option != IPV6_V6ONLY
        || value == NULL || length != sizeof(int) || *(const int *)value != 1)
      silk_listener_configuration_ok = 0;
    silk_listener_setup_order = 3;
    return 0;
  }
  if (fd != 41 || level != SOL_SOCKET || value == NULL
      || (option != SO_LINGER && option != SO_NOSIGPIPE)
      || (option == SO_LINGER && length != sizeof(struct linger))
      || (option == SO_NOSIGPIPE && length != sizeof(int)))
    silk_listener_configuration_ok = 0;
  return 0;
}

int silk_listener_close_nocancel(int fd) __asm("_close$NOCANCEL");
int silk_listener_close_nocancel(int fd) {
  if (!silk_listener_darwin_scripted()) {
    static int (*real_close)(int) = NULL;
    if (real_close == NULL) real_close = dlsym(RTLD_NEXT, "close");
    silk_listener_http_closed(fd);
    return real_close(fd);
  }
  silk_listener_closes += 1;
  if (fd == 40) silk_listener_closed_listener += 1;
  if (fd == 41) silk_listener_closed_accepted += 1;
  return 0;
}
#endif

static int silk_listener_client = -1;

static int silk_listener_http_connect_failed(int result) {
  if (silk_listener_client >= 0) (void)close(silk_listener_client);
  silk_listener_client = -1;
  silk_listener_http_active = 0;
  return result;
}

int silk_listener_connect_http(int port) {
  static const char request[] = "GET /native-admission HTTP/1.1\\r\\nHost: localhost\\r\\n\\r\\n";
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  silk_listener_http_active = 1;
  silk_listener_http_accepted = -1;
  silk_listener_http_listener = -1;
  silk_listener_http_accepts = 0;
  silk_listener_http_accepted_closes = 0;
  silk_listener_http_listener_closes = 0;
  silk_listener_client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (silk_listener_client < 0) return silk_listener_http_connect_failed(1);
  struct timeval deadline = {.tv_sec = 5, .tv_usec = 0};
  if (setsockopt(silk_listener_client, SOL_SOCKET, SO_RCVTIMEO, &deadline, sizeof(deadline)) != 0
      || setsockopt(silk_listener_client, SOL_SOCKET, SO_SNDTIMEO, &deadline, sizeof(deadline)) != 0
      || connect(silk_listener_client, (const struct sockaddr *)&address, sizeof(address)) != 0)
    return silk_listener_http_connect_failed(2);
  size_t sent = 0;
  while (sent < sizeof(request) - 1) {
    ssize_t count = write(silk_listener_client, request + sent, sizeof(request) - 1 - sent);
    if (count < 0 && errno == EINTR) continue;
    if (count <= 0) return silk_listener_http_connect_failed(3);
    sent += (size_t)count;
  }
  if (shutdown(silk_listener_client, SHUT_WR) != 0) return silk_listener_http_connect_failed(4);
  return 42;
}

int silk_listener_finish_http(void) {
  static const char expected[] = "HTTP/1.1 204 No Content\\r\\nConnection: close\\r\\n\\r\\n";
  unsigned char response[sizeof(expected)];
  size_t used = 0;
  int ended = 0;
  while (used < sizeof(response)) {
    ssize_t count = read(silk_listener_client, response + used, sizeof(response) - used);
    if (count < 0 && errno == EINTR) continue;
    if (count < 0) {
      if (errno == ECONNRESET) ended = 1; /* Accepted-owner release is abortive. */
      break;
    }
    if (count == 0) { ended = 1; break; }
    used += (size_t)count;
  }
  int result = ended && used == sizeof(expected) - 1
    && memcmp(response, expected, used) == 0
    && silk_listener_http_accepts == 1
    && silk_listener_http_accepted_closes == 1
    && silk_listener_http_listener_closes == 0 ? 42 : 5;
  if (silk_listener_client >= 0) (void)close(silk_listener_client);
  silk_listener_client = -1;
  return result;
}

int silk_listener_http_ownership(void) {
  int result = silk_listener_http_accepts == 1 && silk_listener_http_accepted_closes == 1
    && silk_listener_http_listener_closes == 1 ? 42 : 6;
  silk_listener_http_active = 0;
  return result;
}


static int silk_listener_copy_path(char *output, size_t capacity, const unsigned char *path, size_t length) {
  if (path == NULL || length == 0 || length >= capacity) return 0;
  memcpy(output, path, length);
  output[length] = 0;
  return 1;
}

int silk_listener_connect_tcp(int port) {
  struct sockaddr_in address;
  memset(&address, 0, sizeof(address));
  address.sin_family = AF_INET;
  address.sin_port = htons((uint16_t)port);
  address.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
  silk_listener_client = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
  if (silk_listener_client < 0) return 1;
  if (connect(silk_listener_client, (const struct sockaddr *)&address, sizeof(address)) != 0) return 2;
  if (write(silk_listener_client, "x", 1) != 1) return 3;
  return 42;
}

int silk_listener_connect_unix(const unsigned char *path, size_t length) {
  struct sockaddr_un address;
  memset(&address, 0, sizeof(address));
  address.sun_family = AF_UNIX;
  if (!silk_listener_copy_path(address.sun_path, sizeof(address.sun_path), path, length)) return 4;
  silk_listener_client = socket(AF_UNIX, SOCK_STREAM, 0);
  if (silk_listener_client < 0) return 5;
  if (connect(silk_listener_client, (const struct sockaddr *)&address,
      (socklen_t)(offsetof(struct sockaddr_un, sun_path) + length + 1)) != 0) return 6;
  if (write(silk_listener_client, "x", 1) != 1) return 7;
  return 42;
}

int silk_listener_finish_client(int expected) {
  unsigned char byte = 0;
  if (silk_listener_client < 0) return 8;
  if (read(silk_listener_client, &byte, 1) != 1 || byte != (unsigned char)expected) return 9;
  if (close(silk_listener_client) != 0) return 10;
  silk_listener_client = -1;
  return 42;
}

int silk_listener_path_exists(const unsigned char *path, size_t length) {
  char local[sizeof(((struct sockaddr_un *)0)->sun_path)];
  struct stat status;
  if (!silk_listener_copy_path(local, sizeof(local), path, length)) return 0;
  return lstat(local, &status) == 0 && S_ISSOCK(status.st_mode);
}

int silk_listener_unlink(const unsigned char *path, size_t length) {
  char local[sizeof(((struct sockaddr_un *)0)->sun_path)];
  if (!silk_listener_copy_path(local, sizeof(local), path, length)) return 1;
  if (unlink(local) == 0 || errno == ENOENT) return 42;
  return 2;
}
`

export const nativeListenerDarwinWitnessSource = `
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#if defined(__APPLE__)
_Static_assert(sizeof(socklen_t) == 4, "Darwin socklen_t width");
_Static_assert(sizeof(struct sockaddr_storage) == 128, "Darwin sockaddr_storage size");
_Static_assert(_Alignof(struct sockaddr_storage) == 8, "Darwin sockaddr_storage alignment");
_Static_assert(sizeof(struct sockaddr_in) == 16 && _Alignof(struct sockaddr_in) == 4, "Darwin IPv4 layout");
_Static_assert(offsetof(struct sockaddr_in, sin_port) == 2 && offsetof(struct sockaddr_in, sin_addr) == 4, "Darwin IPv4 offsets");
_Static_assert(sizeof(struct sockaddr_in6) == 28 && _Alignof(struct sockaddr_in6) == 4, "Darwin IPv6 layout");
_Static_assert(offsetof(struct sockaddr_in6, sin6_port) == 2 && offsetof(struct sockaddr_in6, sin6_addr) == 8, "Darwin IPv6 offsets");
_Static_assert(sizeof(struct sockaddr_un) == 106 && _Alignof(struct sockaddr_un) == 1, "Darwin Unix layout");
_Static_assert(offsetof(struct sockaddr_un, sun_path) == 2, "Darwin Unix header");
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) == 104, "Darwin Unix capacity");
_Static_assert(AF_INET == 2 && AF_INET6 == 30 && AF_UNIX == 1, "Darwin families");
_Static_assert(SOCK_STREAM == 1 && IPPROTO_TCP == 6, "Darwin stream protocol");
_Static_assert(SOL_SOCKET == 0xffff && SO_ERROR == 0x1007 && SO_LINGER == 0x0080, "Darwin socket level/options");
_Static_assert(SO_REUSEADDR == 4 && SO_NOSIGPIPE == 0x1022, "Darwin listener socket options");
_Static_assert(IPPROTO_IPV6 == 41 && IPV6_V6ONLY == 27, "Darwin IPv6-only option");
_Static_assert(IPPROTO_TCP == 6 && TCP_NODELAY == 1, "Darwin TCP option");
_Static_assert(O_NONBLOCK == 4 && FD_CLOEXEC == 1, "Darwin descriptor flags");
_Static_assert(F_GETFD == 1 && F_SETFD == 2 && F_GETFL == 3 && F_SETFL == 4, "Darwin fcntl commands");
_Static_assert(POLLIN == 1 && POLLERR == 8 && POLLHUP == 16 && POLLNVAL == 32, "Darwin poll flags");
_Static_assert(SHUT_WR == 1, "Darwin shutdown write");
_Static_assert(EADDRINUSE == 48 && EAGAIN == 35 && EINTR == 4 && EACCES == 13, "Darwin listener errno values");
_Static_assert(ENOMEM == 12 && EMFILE == 24 && ENFILE == 23 && ENOBUFS == 55, "Darwin resource errno values");
_Static_assert(EAFNOSUPPORT == 47 && EBADF == 9 && EINPROGRESS == 36, "Darwin state errno values");
static int (*silk_socket_signature)(int, int, int) = socket;
static int (*silk_bind_signature)(int, const struct sockaddr *, socklen_t) = bind;
static int (*silk_listen_signature)(int, int) = listen;
static int (*silk_getsockname_signature)(int, struct sockaddr *, socklen_t *) = getsockname;
static int (*silk_accept_signature)(int, struct sockaddr *, socklen_t *) = accept;
static int (*silk_poll_signature)(struct pollfd *, nfds_t, int) = poll;
static int (*silk_setsockopt_signature)(int, int, int, const void *, socklen_t) = setsockopt;
static int (*silk_getsockopt_signature)(int, int, int, void *, socklen_t *) = getsockopt;
static int (*silk_fcntl_signature)(int, int, ...) = fcntl;
static int (*silk_close_signature)(int) = close;
#endif
int silk_listener_darwin_witness(void) { return 42; }
`

export const nativeListenerGnuWitnessSource = `
#define _GNU_SOURCE
#include <errno.h>
#include <fcntl.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <poll.h>
#include <stddef.h>
#include <stdint.h>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>
#if defined(__linux__) && defined(__GLIBC__)
_Static_assert(sizeof(socklen_t) == 4, "GNU socklen_t width");
_Static_assert(sizeof(struct sockaddr_storage) == 128, "GNU sockaddr_storage size");
_Static_assert(_Alignof(struct sockaddr_storage) == 8, "GNU sockaddr_storage alignment");
_Static_assert(sizeof(struct sockaddr_in) == 16 && _Alignof(struct sockaddr_in) == 4, "GNU IPv4 layout");
_Static_assert(offsetof(struct sockaddr_in, sin_port) == 2 && offsetof(struct sockaddr_in, sin_addr) == 4, "GNU IPv4 offsets");
_Static_assert(sizeof(struct sockaddr_in6) == 28 && _Alignof(struct sockaddr_in6) == 4, "GNU IPv6 layout");
_Static_assert(offsetof(struct sockaddr_in6, sin6_port) == 2 && offsetof(struct sockaddr_in6, sin6_addr) == 8, "GNU IPv6 offsets");
_Static_assert(sizeof(struct sockaddr_un) == 110 && _Alignof(struct sockaddr_un) == 2, "GNU Unix layout");
_Static_assert(offsetof(struct sockaddr_un, sun_path) == 2, "GNU Unix header");
_Static_assert(sizeof(((struct sockaddr_un *)0)->sun_path) == 108, "GNU Unix capacity");
_Static_assert(AF_INET == 2 && AF_INET6 == 10 && AF_UNIX == 1, "GNU families");
_Static_assert(SOCK_STREAM == 1 && IPPROTO_TCP == 6, "GNU stream protocol");
_Static_assert(SOL_SOCKET == 1 && SO_ERROR == 4 && SO_LINGER == 13, "GNU socket level/options");
_Static_assert(SO_REUSEADDR == 2 && IPPROTO_IPV6 == 41 && IPV6_V6ONLY == 26, "GNU listener options");
_Static_assert(IPPROTO_TCP == 6 && TCP_NODELAY == 1, "GNU TCP option");
_Static_assert(SOCK_NONBLOCK == 2048 && SOCK_CLOEXEC == 524288, "GNU atomic flags");
_Static_assert(POLLIN == 1 && POLLERR == 8 && POLLHUP == 16 && POLLNVAL == 32, "GNU poll flags");
_Static_assert(MSG_NOSIGNAL == 16384 && SHUT_WR == 1, "GNU transfer flags");
_Static_assert(EADDRINUSE == 98 && ECONNABORTED == 103 && ENETDOWN == 100, "GNU accept errno values");
_Static_assert(EPROTO == 71 && ENOPROTOOPT == 92 && EHOSTDOWN == 112, "GNU pending errno values");
_Static_assert(ENONET == 64 && EHOSTUNREACH == 113 && EOPNOTSUPP == 95 && ENETUNREACH == 101, "GNU pending network values");
_Static_assert(EAGAIN == 11 && EINTR == 4 && EACCES == 13 && EPERM == 1, "GNU retry/permission errno values");
_Static_assert(ENOMEM == 12 && EMFILE == 24 && ENFILE == 23 && ENOBUFS == 105, "GNU resource errno values");
_Static_assert(EAFNOSUPPORT == 97 && EBADF == 9 && EINPROGRESS == 115, "GNU state errno values");
static int (*silk_socket_signature)(int, int, int) = socket;
static int (*silk_bind_signature)(int, const struct sockaddr *, socklen_t) = bind;
static int (*silk_listen_signature)(int, int) = listen;
static int (*silk_getsockname_signature)(int, struct sockaddr *, socklen_t *) = getsockname;
static int (*silk_accept4_signature)(int, struct sockaddr *, socklen_t *, int) = accept4;
static int (*silk_poll_signature)(struct pollfd *, nfds_t, int) = poll;
static int (*silk_setsockopt_signature)(int, int, int, const void *, socklen_t) = setsockopt;
static int (*silk_getsockopt_signature)(int, int, int, void *, socklen_t *) = getsockopt;
static int (*silk_close_signature)(int) = close;
#endif
int silk_listener_gnu_witness(void) { return 42; }
`

/** Profile-agnostic JUL-191 entry; the shared harness owns debug/optimized profiles. */
export const nativeListenerCorpusProgram = Object.freeze({
  name: 'native-socket-listeners',
  source: 'pub fn main() -> i32 { return 42 }',
  nativeSource: nativeListenerAcceptanceSource,
  nativeCSources: Object.freeze({
    native_listener_helper: nativeListenerHelperSource,
    native_listener_darwin_witness: nativeListenerDarwinWitnessSource,
    native_listener_gnu_witness: nativeListenerGnuWitnessSource,
  }),
  expected: Object.freeze({ _tag: 'Completes' as const, result: 42 }),
})
