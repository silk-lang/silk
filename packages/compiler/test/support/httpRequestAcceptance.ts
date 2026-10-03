/**
 * Request preflight and exact client content-storage admission without retaining codec execution.
 * The portable program runs on every target; native acquisition and proxy admission checks reach
 * libc-only operations and therefore compose only into the native program.
 */
const portableImports = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.effect {Effect}
import silk.http {Method, Version, Header, ValueError}
import silk.http_headers {Headers, Limits}
import silk.http_request as Request
import silk.http_request {
  PreparedRequest,
  RequestError,
  HeaderPolicy,
  HeaderControl,
  BodyMode,
  Authorization,
  BasicSecurity,
}
import silk.uri {Uri}
import silk.result {Result}
import silk.usize
import silk.http_basic as Basic
import silk.http_basic {BasicError}
import silk.http_origin {Origin, OriginError}
import silk.uri_reference {ParseError}
import silk.slice {Slice}
import silk.option {Option}
import silk.system_clock {Instant, SystemClock}
import silk.bytes {Bytes}
import silk.byte_duplex {ByteDuplex, ReadTransfer}
import silk.http_client as Client
import silk.http_client {
  Connection,
  ConnectionHandler,
  Exchange,
  ClientError,
  ConnectionPhase,
  RequestOptions,
  Limits as ClientLimits,
}
import silk.http_content as Content
import silk.http_content {
  ContentReason,
  ContentLimitKind,
  Limits as ContentLimits,
  Mode,
  CodingPlan,
  ResponseContext,
}
import silk.http_body {TrailerPolicy}
import silk.layout {Layout}
import silk.inflate {Limits as InflateLimits}
import silk.zstd {ZstdLimits}
import silk.memory_byte_duplex {
  MemoryByteDuplex,
  MemoryReadEvent,
  MemoryWriteEvent,
  MemoryWriteAction,
}
import silk.monotonic_clock {MonotonicClock}
import silk.random {Random}
import silk.http_transport {HttpTransport, TransportError}
import silk.vector {Vector}
import silk.u64
`

const nativeImports = `import silk.http_client_native {
  acquireOwned,
  acquireUnixOwned,
  Options,
  NativeClientError,
  preflight,
  preflightProxyRoute,
}
import silk.native_socket {NativeSocketError}
import silk.http_proxy {
  BypassPolicy,
  ProxyAuth,
  ProxyAuthContextId,
  ProxyConfig,
  ProxyConfigId,
  ProxyError,
  Route,
  RouteMode,
  selectRoute,
}
import silk.trust_snapshot {TrustSnapshot}
`

const policySupport = `fn bytesEqual(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length {
    return false
  }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] {
      return false
    }
    index = index + usize.ONE
  }
  return true
}

fn basic() -> bool {
  let mut scratch: [u8; 19] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let mut output: [u8; 34] = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]
  let checked1 = Basic.encodeInto(b"Aladdin", b"open sesame", &mut scratch, &mut output)
  let count = match move checked1 {
    Result<usize, BasicError>.Failure {error} => {
      return false
    }
    Result<usize, BasicError>.Success {value} => value
  }
  if !bytesEqual(Slice.view<u8>(&output, usize.ZERO, count), b"Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==") {
    return false
  }
  let mut untouched: [u8; 2] = [165, 165]
  let checked2 = Basic.encodeInto(b"u", b"p", &mut scratch, &mut untouched)
  let failed = match move checked2 {
    Result<usize, BasicError>.Failure {error} => error == BasicError.OutputTooSmall
    Result<usize, BasicError>.Success {value} => false
  }
  if !failed || untouched[0] != 165 || untouched[1] != 165 {
    return false
  }
  let checked3 = Basic.encodeInto(b"u:s", b"p", &mut scratch, &mut untouched)
  let colon = match move checked3 {
    Result<usize, BasicError>.Failure {error} => error == BasicError.InvalidUsername
    Result<usize, BasicError>.Success {value} => false
  }
  let control: [u8; 1] = [127]
  let checked4 = Basic.encodeInto(b"u", &control, &mut scratch, &mut untouched)
  let rejected = match move checked4 {
    Result<usize, BasicError>.Failure {error} => error == BasicError.InvalidPassword
    Result<usize, BasicError>.Success {value} => false
  }
  return colon && rejected && untouched[0] == 165 && untouched[1] == 165
}

fn origin<'text>(text: string<'text>, authority: &[u8], equivalent: string, wrong: string) -> bool {
  let checked5 = Uri.parse(text)
  let parsed = match move checked5 {
    Result<Uri<'text>, ParseError>.Failure {error} => {
      return false
    }
    Result<Uri<'text>, ParseError>.Success {value} => value
  }
  let checked6 = Origin.fromUri(&parsed)
  let originValue = match move checked6 {
    Result<Origin, OriginError>.Failure {error} => {
      return false
    }
    Result<Origin, OriginError>.Success {value} => value
  }
  let mut buffer: [u8; 32] = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]
  let checked7 = Origin.authorityInto(&originValue, &mut buffer)
  let count = match move checked7 {
    Result<usize, OriginError>.Failure {error} => {
      return false
    }
    Result<usize, OriginError>.Success {value} => value
  }
  return bytesEqual(Slice.view<u8>(&buffer, usize.ZERO, count), authority) && Origin.matchesAuthority(
    &originValue,
    equivalent,
  ) && !Origin.matchesAuthority(&originValue, wrong)
}

fn rejects<'text>(text: string<'text>) -> bool {
  let checked8 = Uri.parse(text)
  let parsed = match move checked8 {
    Result<Uri<'text>, ParseError>.Failure {error} => {
      return false
    }
    Result<Uri<'text>, ParseError>.Success {value} => value
  }
  let checked9 = Origin.fromUri(&parsed)
  return match move checked9 {
    Result<Origin, OriginError>.Failure {error} => true
    Result<Origin, OriginError>.Success {value} => false
  }
}

fn policyChecks() -> i32 {
  if !basic() {
    return 1
  }
  if !origin(
    "HTTPS://EXAMPLE.com:443/path?q=1#fragment",
    b"example.com",
    "example.COM:443",
    "other.com",
  ) {
    return 2
  }
  if !origin(
    "http://[2001:db8::1]:8080/",
    b"[2001:db8::1]:8080",
    "[2001:0db8::1]:8080",
    "[2001:db8::1]",
  ) {
    return 3
  }
  if !origin("http://127.0.0.1/", b"127.0.0.1", "127.0.0.1:80", "127.0.0.1:81") {
    return 4
  }
  if !rejects("http://user@example.com/") || !rejects("http://example.com:0/") || !rejects(
    "ftp://example.com/",
  ) {
    return 5
  }
  return 0
}
`

const nativeSupport = `fn nativeUri<'text>(text: string<'text>) -> Uri<'text> {
  let uri = match move Uri.parse(text) {
    Result.Success {value} => value
    Result.Failure {error} => {
      let invalid = 1 / 0
      return nativeUri(text)
    }
  }
  return uri
}

fn nativeOrigin(text: string) -> Origin {
  let uri = nativeUri(text)
  return match move Origin.fromUri(&uri) {
    Result.Success {value} => value
    Result.Failure {error} => {
      let invalid = 1 / 0
      return nativeOrigin(text)
    }
  }
}

struct NativeWallClock {}

impl SystemClock for NativeWallClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
}

fn expectedUnsupportedDeadline(error: NativeClientError) -> bool {
  return match move error {
    NativeClientError.UnsupportedDeadline => true
    _ => false
  }
}

fn nativeAdmissionChecks() -> i32 {
  let numeric = nativeOrigin("http://127.0.0.1/")
  let dns = nativeOrigin("https://example.com/")
  let mut options = Options.defaults()
  options.deadline = Option.some<Instant>(SystemClock.make(7, 0))
  match move preflight(&numeric, &options) {
    Result.Success {value} => {
      drop value
    }
    Result.Failure {error} => {
      drop error
      return 1
    }
  }
  match move preflight(&dns, &options) {
    Result.Success {value} => {
      return 2
    }
    Result.Failure {error} => match move error {
      NativeClientError.UnsupportedDeadline => {}
      _ => {
        return 3
      }
    }
  }
  options.deadline = Option.none<Instant>()
  return match move preflight(&dns, &options) {
    Result.Success {value} => 0
    Result.Failure {error} => 4
  }
}

effect fn nativeOwnedAcquisitionChecks() -> i32
? &mut Allocator | &mut MonotonicClock | &mut SystemClock | &mut Random {
  static if (Intrinsic.targetOperatingSystem() == "darwin" && Intrinsic.targetArchitecture() == "aarch64" && Intrinsic.targetAbi() == "apple" && Intrinsic.profileText(
  "libc",
) == "system") || (Intrinsic.targetOperatingSystem() == "linux" && Intrinsic.targetAbi() == "gnu" && Intrinsic.profileText(
  "libc",
) == "gnu" && (Intrinsic.targetArchitecture() == "aarch64" || Intrinsic.targetArchitecture() == "x86_64")) {
    let direct = nativeOrigin("http://127.0.0.1/")
    let mut directOptions = Options.defaults()
    directOptions.deadline = Option.some<Instant>(SystemClock.make(10, 0))
    let directAttempt = run Effect.result(acquireOwned(
      direct,
      move directOptions,
      ClientLimits.defaults(),
      Option.none<TrustSnapshot>(),
      Option.some<Instant>(SystemClock.make(0, 0)),
    ))
    match move directAttempt {
      Result.Success {value} => {
        drop value
        return 1
      }
      Result.Failure {error} => match move error {
        NativeSocketError cause => match move cause {
          NativeSocketError.Timeout => {}
          _ => { return 2 }
        }
        _ => { return 3 }
      }
    }

    let unix = nativeOrigin("http://unix.invalid/")
    let mut unixOptions = Options.defaults()
    unixOptions.deadline = Option.some<Instant>(SystemClock.make(0, 0))
    let unixAttempt = run Effect.result(acquireUnixOwned(
      b"/tmp/silk-owned-acquisition",
      unix,
      move unixOptions,
      ClientLimits.defaults(),
      Option.none<TrustSnapshot>(),
      Option.some<Instant>(SystemClock.make(10, 0)),
    ))
    match move unixAttempt {
      Result.Success {value} => {
        drop value
        return 4
      }
      Result.Failure {error} => match move error {
        NativeSocketError cause => match move cause {
          NativeSocketError.Timeout => {}
          _ => { return 5 }
        }
        _ => { return 6 }
      }
    }

    let secure = nativeOrigin("https://127.0.0.1/")
    let secureAttempt = run Effect.result(acquireOwned(
      secure,
      Options.defaults(),
      ClientLimits.defaults(),
      Option.none<TrustSnapshot>(),
      Option.none<Instant>(),
    ))
    return match move secureAttempt {
      Result.Success {value} => {
        drop value
        return 7
      }
      Result.Failure {error} => match move error {
        NativeClientError cause => match move cause {
          NativeClientError.TrustRequired => 0
          _ => 8
        }
        _ => 9
      }
    }
  } else {
    compileError("Native HTTP acquisition checks require a supported libc profile")
  }
}

effect fn nativeProxyAdmissionChecks() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let direct = nativeOrigin("http://127.0.0.1/")
  let firstForward = nativeOrigin("http://127.0.0.3/")
  let secondForward = nativeOrigin("http://127.0.0.4/")
  let proxy = nativeOrigin("http://127.0.0.2:3128/")
  let bypassEntries = [direct]
  let bypass = match move run BypassPolicy.copy(&bypassEntries) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      drop error
      return 1
    }
  }
  let authentication = match move run ProxyAuth.preparedBasic(
    ProxyAuthContextId.make(u64.toU64(2)),
    b"dXNlcjpwYXNz",
  ) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      drop error
      return 2
    }
  }
  let config = match move ProxyConfig.fromUri(
    ProxyConfigId.make(u64.toU64(1)),
    "http://127.0.0.2:3128",
    move authentication,
    move bypass,
    4096,
  ) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      drop error
      return 3
    }
  }
  let directUri = nativeUri("http://127.0.0.1/two#hidden")
  let secondUri = nativeUri("http://127.0.0.4/three#hidden")
  let firstRoute = selectRoute(&config, firstForward)
  let directRoute = Route.recompute(&firstRoute, direct)
  let secondRoute = Route.recompute(&directRoute, secondForward)
  if Route.mode(&firstRoute) != RouteMode.Forward
    || Route.mode(&directRoute) != RouteMode.Direct
    || Route.mode(&secondRoute) != RouteMode.Forward {
    return 4
  }
  let fields: [Header<'static>; 0] = []
  let headers = match move Headers.make(&fields, limits()) {
    Result.Success {value} => value
    Result.Failure {error} => {
      drop error
      return 5
    }
  }
  let policy = HeaderPolicy.defaults()
  let directPrepared = match move run Effect.result(Request.fromUri(
    &directUri,
    Version.Http11,
    Method.get(),
    &headers,
    &policy,
    BodyMode.Empty,
    false,
    limits(),
    4096,
    128,
  )) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      drop error
      return 6
    }
  }
  if !bytesEqual(
    PreparedRequest.bytes(&directPrepared),
    b"GET /two HTTP/1.1\\r\\nHost: 127.0.0.1\\r\\nUser-Agent: silk-http/1\\r\\nAccept: */*\\r\\n\\r\\n",
  ) {
    return 7
  }
  let secondPrepared = match move run Effect.result(Request.prepareForward(
    &secondRoute,
    &secondUri,
    Version.Http11,
    Method.get(),
    &headers,
    &policy,
    BodyMode.Empty,
    false,
    limits(),
    4096,
    128,
  )) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      drop error
      return 8
    }
  }
  if !bytesEqual(
    PreparedRequest.bytes(&secondPrepared),
    b"GET http://127.0.0.4/three HTTP/1.1\\r\\nProxy-Authorization: Basic dXNlcjpwYXNz\\r\\nHost: 127.0.0.4\\r\\nUser-Agent: silk-http/1\\r\\nAccept: */*\\r\\n\\r\\n",
  ) {
    return 9
  }
  let options = Options.defaults()
  match move preflightProxyRoute(&directRoute, &options) {
    Result.Success {value} => {
      if !Origin.equals(&value, &direct) { return 10 }
    }
    Result.Failure {error} => match move error {
      NativeClientError cause => {
        drop cause
        return 11
      }
      ProxyError cause => {
        drop cause
        return 12
      }
    }
  }
  match move preflightProxyRoute(&secondRoute, &options) {
    Result.Success {value} => {
      if !Origin.equals(&value, &proxy) { return 13 }
    }
    Result.Failure {error} => match move error {
      NativeClientError cause => {
        drop cause
        return 14
      }
      ProxyError cause => {
        drop cause
        return 14
      }
    }
  }

  let empty: [Origin; 0] = []
  let dnsBypass = match move run BypassPolicy.copy(&empty) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      drop error
      return 15
    }
  }
  let dnsConfig = match move ProxyConfig.fromUri(
    ProxyConfigId.make(u64.toU64(3)),
    "http://proxy.example:3128",
    ProxyAuth.none(ProxyAuthContextId.make(u64.toU64(4))),
    move dnsBypass,
    4096,
  ) {
    Result.Success {value} => move value
    Result.Failure {error} => {
      drop error
      return 16
    }
  }
  let dnsRoute = selectRoute(&dnsConfig, firstForward)
  let mut deadlineOptions = Options.defaults()
  deadlineOptions.deadline = Option.some<Instant>(SystemClock.make(7, 0))
  match move preflightProxyRoute(&dnsRoute, &deadlineOptions) {
    Result.Success {value} => { return 17 }
    Result.Failure {error} => match move error {
      NativeClientError cause => {
        if !expectedUnsupportedDeadline(move cause) { return 18 }
      }
      ProxyError cause => { return 19 }
    }
  }
  return 0
}

effect fn recoverProxyAllocation(error: OutOfMemoryError) -> i32 {
  drop error
  return 20
}
`

const programSupport = `fn limits() -> Limits {
  return Limits {
    maxMethodBytes: 32,
    maxTargetBytes: 256,
    maxNameBytes: 64,
    maxValueBytes: 512,
    maxFields: 16,
    maxFieldBytes: 2048,
    maxOwnedBytes: 4096,
  }
}

effect fn program() -> i32 ! RequestError | OutOfMemoryError ? &mut Allocator {
  let uri = match move Uri.parse("http://EXAMPLE.com?x=1#discard") {
    Result.Failure {error} => {
      drop error
      return 1
    }
    Result.Success {value} => value
  }
  let fields: [Header<'static>; 0] = []
  let headers = match move Headers.make(&fields, limits()) {
    Result.Failure {error} => {
      drop error
      return 2
    }
    Result.Success {value} => value
  }
  let policy = HeaderPolicy.defaults()
  let prepared = run Request.fromUri(
    &uri,
    Version.Http11,
    Method.get(),
    &headers,
    &policy,
    BodyMode.Empty,
    false,
    limits(),
    4096,
    128,
  )
  if !bytesEqual(
    PreparedRequest.bytes(&prepared),
    b"GET /?x=1 HTTP/1.1\\r\\nHost: example.com\\r\\nUser-Agent: silk-http/1\\r\\nAccept: */*\\r\\n\\r\\n",
  ) {
    return 3
  }
  let mut basic = HeaderPolicy.defaults()
  basic.authorization = Authorization.Basic {username: b"Aladdin", password: b"open sesame"}
  let insecure = run Effect.result(
    Request.fromUri(
      &uri,
      Version.Http11,
      Method.get(),
      &headers,
      &basic,
      BodyMode.Empty,
      false,
      limits(),
      4096,
      128,
    ),
  )
  let rejected = match move insecure {
    Result.Failure {error} => match move error {
      RequestError.InsecureBasic => true
      _ => false
    }
    Result.Success {value} => false
  }
  if !rejected {
    return 4
  }
  basic.basicSecurity = BasicSecurity.AllowInsecureBasic
  let explicit = run Request.fromUri(
    &uri,
    Version.Http11,
    Method.post(),
    &headers,
    &basic,
    BodyMode.KnownLength {length: 0},
    false,
    limits(),
    4096,
    128,
  )
  if !bytesEqual(
    PreparedRequest.bytes(&explicit),
    b"POST /?x=1 HTTP/1.1\\r\\nHost: example.com\\r\\nUser-Agent: silk-http/1\\r\\nAccept: */*\\r\\nContent-Length: 0\\r\\nAuthorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\\r\\n\\r\\n",
  ) {
    return 5
  }
  let badMode = run Effect.result(
    Request.fromUri(
      &uri,
      Version.Http10,
      Method.post(),
      &headers,
      &policy,
      BodyMode.Chunked,
      false,
      limits(),
      4096,
      128,
    ),
  )
  let badModeRejected = match move badMode {
    Result.Failure {error} => match move error {
      RequestError.InvalidBodyMode => true
      _ => false
    }
    Result.Success {value} => false
  }
  if !badModeRejected {
    return 6
  }
  let mut wrongHost = HeaderPolicy.defaults()
  wrongHost.host = HeaderControl.Value {value: b"other.test"}
  let wrong = run Effect.result(
    Request.fromUri(
      &uri,
      Version.Http11,
      Method.get(),
      &headers,
      &wrongHost,
      BodyMode.Empty,
      false,
      limits(),
      4096,
      128,
    ),
  )
  return match move wrong {
    Result.Failure {error} => match move error {
      RequestError.ConflictingAuthority => 0
      _ => 7
    }
    Result.Success {value} => {
      drop value
      return 8
    }
  }
}

struct BudgetClock {}

impl MonotonicClock for BudgetClock {
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

fn contentLimits() -> ContentLimits {
  return ContentLimits {
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

struct BudgetTransport {
  memory: MemoryByteDuplex
}

struct BudgetRandom {}

impl Random for BudgetRandom {
  effect fn fillBytes(self: &mut Self, output: &mut [u8]) -> () {
    drop output
    return ()
  }
}

impl HttpTransport for BudgetTransport {
  effect fn readSomeRaw(self: &mut Self, output: &mut [u8], deadline: Option<Instant>) -> ReadTransfer
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    let attempted = run Effect.result(ByteDuplex.readSome(&mut output, move deadline))
      |> Effect.provideMut<ByteDuplex>(&mut self.memory)
    return match move attempted {
      Result.Success {value} => move value
      Result.Failure {error} => {
        fail TransportError.Plain {error: move error}
      }
    }
  }
  effect fn writeSomeRaw(self: &mut Self, input: &[u8], deadline: Option<Instant>) -> usize
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    let attempted = run Effect.result(ByteDuplex.writeSome(input, move deadline))
      |> Effect.provideMut<ByteDuplex>(&mut self.memory)
    return match move attempted {
      Result.Success {value} => value
      Result.Failure {error} => {
        fail TransportError.Plain {error: move error}
      }
    }
  }
  effect fn flush(self: &mut Self, deadline: Option<Instant>) -> ()
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    let attempted = run Effect.result(ByteDuplex.flush(move deadline))
      |> Effect.provideMut<ByteDuplex>(&mut self.memory)
    return match move attempted {
      Result.Success {value} => value
      Result.Failure {error} => {
        fail TransportError.Plain {error: move error}
      }
    }
  }
  effect fn close(self: &mut Self) -> () ! TransportError {
    let attempted = run Effect.result(ByteDuplex.close())
      |> Effect.provideMut<ByteDuplex>(&mut self.memory)
    return match move attempted {
      Result.Success {value} => value
      Result.Failure {error} => {
        fail TransportError.Plain {error: move error}
      }
    }
  }
}

struct RejectAllocation {
  calls: usize
}

impl Allocator for RejectAllocation {
  effect fn allocate(self: &mut Self, layout: Layout) -> Allocation ! OutOfMemoryError {
    drop layout
    self.calls = self.calls + usize.ONE
    fail OutOfMemoryError {}
  }
}

effect fn reservedContent<'exchange>(exchange: &Exchange<'exchange, BudgetTransport>) -> usize
! ClientError {
  let head = run Exchange.head(exchange)
  let context = match move ResponseContext.make(head, Method.get(), TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => {
      drop error
      return usize.ZERO
    }
    Result.Success {value} => move value
  }
  let plan = match move CodingPlan.make(
    move context,
    Mode.Decode,
    ClientLimits.defaults().responseBody,
    contentLimits(),
  ) {
    Result.Failure {error} => {
      drop error
      return usize.ZERO
    }
    Result.Success {value} => move value
  }
  return plan.ownedBytes()
}

effect fn descriptorBudget<'head, 'exchange: 'head>(
  exchange: &'head mut Exchange<'exchange, BudgetTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock {
  let reserved = run reservedContent(&exchange.*)
  if reserved == usize.ZERO {
    return 421
  }
  let mut selected = contentLimits()
  selected.maxOwned = reserved
  let mut rejecting = RejectAllocation {calls: usize.ZERO}
  let attempted = run Effect.result(
    Client.beginContent<'head>(move exchange, Mode.Decode, move selected),
  )
    |> Effect.provideMut<Allocator>(&mut rejecting)
  if rejecting.calls != usize.ZERO {
    drop attempted
    return 422
  }
  return match move attempted {
    Result.Success {value} => {
      drop value
      return 423
    }
    Result.Failure {error} => match move error {
      Content.ContentError<'head> content => match move content.reason {
        ContentReason<'head>.InvalidLimit {limit, allowed, attempted: attemptedBytes} => {
          if limit != ContentLimitKind.OwnedBytes || allowed != usize.toU64(reserved) || attemptedBytes <= allowed {
            return 424
          }
          return 0
        }
        _ => 425
      }
      _ => 426
    }
  }
}

struct BudgetHandler {
  request: PreparedRequest
}

impl ConnectionHandler<BudgetTransport, i32, ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random> for BudgetHandler {
  effect<'call> fn handle<'call>(handler: Self, connection: &'call mut Connection<BudgetTransport>) -> i32
  ! ClientError | OutOfMemoryError
  ? &mut Allocator | &mut MonotonicClock | &mut Random {
    let BudgetHandler {request} = move handler
    let checked = run Client.withExchange(
      &mut connection.*,
      &request,
      RequestOptions.defaults(),
      budgetExchange,
    )
    if checked != 0 {
      return checked
    }
    if connection.phase() != ConnectionPhase.Closed {
      return 427
    }
    return 0
  }
}

effect<'call> fn budgetExchange<'call, 'exchange: 'call>(
  exchange: &'call mut Exchange<'exchange, BudgetTransport>,
) -> i32 ! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  run Client.send(&mut exchange.*)
  let entries: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&entries, limits()) {
    Result.Failure {error} => {
      drop error
      return 428
    }
    Result.Success {value} => value
  }
  run Client.finishRequest(&mut exchange.*, &trailers)
  let status = run Client.receive(&mut exchange.*)
  if status != 202 {
    return 429
  }
  return run descriptorBudget(move exchange)
}

effect fn budgetProgram() -> i32
! ClientError | RequestError | OutOfMemoryError
? &mut Allocator | &mut MonotonicClock | &mut Random {
  let uri = match move Uri.parse("http://budget.test/") {
    Result.Failure {error} => {
      drop error
      return 430
    }
    Result.Success {value} => value
  }
  let endpoint = match move Origin.fromUri(&uri) {
    Result.Failure {error} => {
      drop error
      return 431
    }
    Result.Success {value} => value
  }
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, limits()) {
    Result.Failure {error} => {
      drop error
      return 432
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
    limits(),
    4096,
    128,
  )
  let bytes = run Bytes.copy(
    b"HTTP/1.1 202 Budget\\r\\nContent-Length: 25\\r\\nContent-Encoding: gzip\\r\\n\\r\\n",
  )
  let mut reads = Vector.make<MemoryReadEvent>()
  run Vector.append(
    &mut reads,
    MemoryReadEvent.Data {readyAt: SystemClock.make(0, 0), bytes: move bytes},
  )
  let mut writes = Vector.make<MemoryWriteEvent>()
  run Vector.append(
    &mut writes,
    MemoryWriteEvent {
      readyAt: SystemClock.make(0, 0),
      action: MemoryWriteAction.Accept {count: 1024},
    },
  )
  let memory = run MemoryByteDuplex.make(move reads, move writes, 1024, 128, Option.none<i32>())
  return run Client.withOwned(
    BudgetTransport {memory: move memory},
    endpoint,
    Version.Http11,
    ClientLimits.defaults(),
    Option.none<Instant>(),
    BudgetHandler {request: move request},
  )
}

effect fn allPrograms() -> i32 ! ClientError | RequestError | OutOfMemoryError ? &mut Allocator {
  let checked = run program()
  if checked != 0 {
    return checked
  }
  let mut clock = BudgetClock {}
  let mut random = BudgetRandom {}
  return run budgetProgram()
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
}

effect fn recover(error: ClientError | RequestError | OutOfMemoryError) -> i32 {
  drop error
  return 9
}
`

const nativeChecks = `  let admitted = nativeAdmissionChecks()
  if admitted != 0 {
    return 200 + admitted
  }
  let mut clock = BudgetClock {}
  let mut wall = NativeWallClock {}
  let mut random = BudgetRandom {}
  let ownedAdmitted = run nativeOwnedAcquisitionChecks()
    |> Effect.provideMut<Random>(&mut random)
    |> Effect.provideMut<SystemClock>(&mut wall)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if ownedAdmitted != 0 {
    return 250 + ownedAdmitted
  }
  let proxyAdmitted = run Effect.catchAll(nativeProxyAdmissionChecks(), recoverProxyAllocation)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if proxyAdmitted != 0 {
    return 300 + proxyAdmitted
  }
`

const sourceFor = (
  imports: string,
  support: string,
  checks: string,
): string => `${portableImports}${imports}
${policySupport}
${support}
${programSupport}
pub fn main() -> i32 {
  let checked = policyChecks()
  if checked != 0 {
    return 100 + checked
  }
  let mut allocator = Allocator.systemAllocatorProvider()
${checks}  return run Effect.catchAll(allPrograms(), recover)
    |> Effect.provideMut<Allocator>(&mut allocator)
}
`

/** The target-neutral request program shared by native and LLVM-to-Wasm acceptance. */
export const httpRequestPortableAcceptanceSource = sourceFor('', '', '')

/** The native program: the portable checks plus libc-backed acquisition and proxy admission. */
export const httpRequestAcceptanceSource = sourceFor(nativeImports, nativeSupport, nativeChecks)
