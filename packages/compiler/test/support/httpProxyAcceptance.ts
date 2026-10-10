export const httpProxyPolicyCommonImports = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.effect {Effect}
import silk.http {Header, Method, Version}
import silk.http_headers {Headers}
import silk.http_origin {Origin}
import silk.http_request as Request
import silk.http_request {BodyMode, HeaderPolicy, PreparedRequest, RequestError}
import silk.http_target {RequestTarget}
import silk.option {Option}
import silk.result {Result}
import silk.uri {Uri}
import silk.usize`

export const httpProxyPolicyImports = `import silk.bytes {Bytes}
import silk.http {OwnedResponseHead, ResponseHead as ValueResponseHead, Status, ValueError}
import silk.http_head {
  Limits as ResponseParserLimits,
  ParseError as HeadParseError,
  ParsedResponse,
  ResponseParser,
  parseResponse,
  responseSerializedSize,
  writeResponseInto,
}
import silk.http_headers {HeaderIterator, Limits as ProxyValueLimits}
import silk.http_origin {OriginError}
import silk.http_proxy {
  BypassPolicy,
  ProxyAuth,
  ProxyAuthContextId,
  ProxyAdmissionError,
  ProxyComponent,
  ProxyConfig,
  ProxyConfigId,
  ProxyError,
  ProxyLimit,
  ProxyReason,
  Route,
  RouteKey,
  RouteMode,
  classifyConnect,
  selectRoute,
}
import silk.http_request {
  Authorization,
  BasicSecurity,
  HeaderControl,
  prepareConnect,
  prepareForward,
}
import silk.uri_reference {ParseError}
`

export const httpProxyPolicySupport = `fn proxyBytesEqual(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

fn proxyReasonEquals(head: &ValueResponseHead, expected: &[u8]) -> bool {
  return match move ValueResponseHead.reason(head) {
    Option.None => false
    Option.Some {value} => proxyBytesEqual(value, expected)
  }
}

fn proxyValueLimits() -> ProxyValueLimits {
  return ProxyValueLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 256,
    maxNameBytes: 64,
    maxValueBytes: 512,
    maxFields: 16,
    maxFieldBytes: 2048,
    maxOwnedBytes: 4096,
  }
}

fn proxyConnectInputLimits() -> ProxyValueLimits {
  return ProxyValueLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 512,
    maxNameBytes: 256,
    maxValueBytes: 8192,
    maxFields: 100,
    maxFieldBytes: 32768,
    maxOwnedBytes: 65536,
  }
}

fn proxyResponseParserLimits() -> ResponseParserLimits {
  return ResponseParserLimits {
    maxHeadBytes: 65536,
    maxStartLineBytes: 8192,
    maxFieldLineBytes: 16384,
    maxOwnedBytes: 70000,
    values: proxyConnectInputLimits(),
  }
}

effect fn proxyClassifyConnect(
  head: &ValueResponseHead,
) -> () ! ProxyError | ValueError | HeadParseError | OutOfMemoryError ? &mut Allocator {
  let required = match move responseSerializedSize(head, proxyConnectInputLimits()) {
    Result.Failure {error} => { fail move error }
    Result.Success {value} => value
  }
  let mut encoded = run Bytes.zeroed(required)
  let output = Bytes.asMutSlice(&mut encoded)
  let written = match move writeResponseInto(head, &mut output, proxyConnectInputLimits()) {
    Result.Failure {error} => { fail move error }
    Result.Success {value} => value
  }
  drop output
  if written != required { fail ProxyError.ProxyMetadataLimit }
  let parsed = match move run parseResponse(Bytes.asSlice(&encoded), proxyResponseParserLimits()) {
    Result.Failure {error} => { fail move error }
    Result.Success {value} => move value
  }
  let ParsedResponse {parser, progress} = move parsed
  drop progress
  let head = match move ResponseParser.head(&parser) {
    Result.Failure {error} => { fail move error }
    Result.Success {value} => value
  }
  return run classifyConnect(&head)
}

effect fn proxyFilled(length: usize) -> Bytes ! OutOfMemoryError ? &mut Allocator {
  let mut bytes = run Bytes.zeroed(length)
  let output = Bytes.asMutSlice(&mut bytes)
  let mut index = usize.ZERO
  while index < output.length {
    output[index] = 97
    index = index + usize.ONE
  }
  drop output
  return move bytes
}

fn proxyCheckedOrigin<'text>(text: string<'text>) -> Result<Origin, ProxyError> {
  let uri = match move Uri.parse(text) {
    Result<Uri<'text>, ParseError>.Failure {error} => {
      return Result.failResult<Origin, ProxyError>(ProxyError.Admission {error: ProxyAdmissionError {
        component: ProxyComponent.Configuration,
        reason: ProxyReason.InvalidProxyUri,
      }})
    }
    Result<Uri<'text>, ParseError>.Success {value} => value
  }
  return match move Origin.fromUri(&uri) {
    Result<Origin, OriginError>.Failure {error} => Result.failResult<Origin, ProxyError>(
      ProxyError.Admission {error: ProxyAdmissionError {
        component: ProxyComponent.Configuration,
        reason: ProxyReason.InvalidProxyUri,
      }},
    )
    Result<Origin, OriginError>.Success {value} => Result.succeed<Origin, ProxyError>(value)
  }
}

fn proxyModeIs<'configuration>(route: &Route<'configuration>, expected: RouteMode) -> bool {
  return Route.mode(route) == expected
}

fn proxyIsReason(error: ProxyError, expected: ProxyReason) -> bool {
  let admission = match move error {
    ProxyError.Admission {error: admissionError} => admissionError
    _ => { return false }
  }
  return match move expected {
    ProxyReason.InvalidProxyUri => match move admission.reason {
      ProxyReason.InvalidProxyUri => true
      _ => false
    }
    ProxyReason.InvalidAuthentication => match move admission.reason {
      ProxyReason.InvalidAuthentication => true
      _ => false
    }
    ProxyReason.UnsupportedProxyTransport => match move admission.reason {
      ProxyReason.UnsupportedProxyTransport => true
      _ => false
    }
    _ => false
  }
}

fn proxyIsOwnedCapacityFailure(error: ProxyError) -> bool {
  let admission = match move error {
    ProxyError.Admission {error: admissionError} => admissionError
    _ => { return false }
  }
  return match move admission.reason {
    ProxyReason.LimitExceeded {limit, allowed, attempted} => {
      return limit == ProxyLimit.OwnedConfigurationBytes && allowed == 0 && attempted > 0
    }
    _ => false
  }
}

`

export const verifyProxyPolicy = `effect fn verifyProxyPolicy() -> bool ! OutOfMemoryError ? &mut Allocator {
  let bypassOrigin = match move proxyCheckedOrigin("http://[2001:0db8::1]") {
    Result<Origin, ProxyError>.Failure {error} => { return false }
    Result<Origin, ProxyError>.Success {value} => value
  }
  let bypassEntries = [bypassOrigin]
  let bypass = match move run BypassPolicy.copy(&bypassEntries) {
    Result<BypassPolicy, ProxyError>.Failure {error} => { return false }
    Result<BypassPolicy, ProxyError>.Success {value} => move value
  }
  let configId = ProxyConfigId.make(11)
  let authId = ProxyAuthContextId.make(21)
  let authentication = match move run ProxyAuth.preparedBasic(
    authId,
    b"QWxhZGRpbjpvcGVuIHNlc2FtZQ==",
  ) {
    Result<ProxyAuth, ProxyError>.Failure {error} => { return false }
    Result<ProxyAuth, ProxyError>.Success {value} => move value
  }
  let config = match move ProxyConfig.fromUri(
    configId,
    "http://proxy.example:3128",
    move authentication,
    move bypass,
    65536,
  ) {
    Result<ProxyConfig, ProxyError>.Failure {error} => { return false }
    Result<ProxyConfig, ProxyError>.Success {value} => move value
  }

  let numericEquivalent = match move proxyCheckedOrigin("http://[2001:db8::1]:80") {
    Result<Origin, ProxyError>.Failure {error} => { return false }
    Result<Origin, ProxyError>.Success {value} => value
  }
  let direct = selectRoute(&config, numericEquivalent)
  if !proxyModeIs(&direct, RouteMode.Direct) { return false }
  if !ProxyConfigId.equals(&Route.configId(&direct), &configId) { return false }
  if !ProxyAuthContextId.equals(&Route.authContextId(&direct), &authId) { return false }

  let insecure = match move proxyCheckedOrigin("http://service.example") {
    Result<Origin, ProxyError>.Failure {error} => { return false }
    Result<Origin, ProxyError>.Success {value} => value
  }
  let forward = selectRoute(&config, insecure)
  if !proxyModeIs(&forward, RouteMode.Forward) { return false }
  let proxyOrigin = match move proxyCheckedOrigin("http://proxy.example:3128") {
    Result<Origin, ProxyError>.Failure {error} => { return false }
    Result<Origin, ProxyError>.Success {value} => value
  }
  let equalEndpointRoute = selectRoute(&config, proxyOrigin)
  if !proxyModeIs(&equalEndpointRoute, RouteMode.Forward) { return false }

  let secure = match move proxyCheckedOrigin("https://service.example") {
    Result<Origin, ProxyError>.Failure {error} => { return false }
    Result<Origin, ProxyError>.Success {value} => value
  }
  let tunnel = selectRoute(&config, secure)
  if !proxyModeIs(&tunnel, RouteMode.Tunnel) { return false }

  let differentScheme = match move proxyCheckedOrigin("https://[2001:db8::1]") {
    Result<Origin, ProxyError>.Failure {error} => { return false }
    Result<Origin, ProxyError>.Success {value} => value
  }
  let schemeRoute = selectRoute(&config, differentScheme)
  if !proxyModeIs(&schemeRoute, RouteMode.Tunnel) { return false }
  let differentPort = match move proxyCheckedOrigin("http://[2001:db8::1]:81") {
    Result<Origin, ProxyError>.Failure {error} => { return false }
    Result<Origin, ProxyError>.Success {value} => value
  }
  let portRoute = selectRoute(&config, differentPort)
  if !proxyModeIs(&portRoute, RouteMode.Forward) { return false }

  let recomputed = Route.recompute(&forward, secure)
  if !proxyModeIs(&recomputed, RouteMode.Tunnel) { return false }
  if !ProxyAuthContextId.equals(&Route.authContextId(&recomputed), &authId) { return false }
  let copiedRoute = direct
  if !RouteKey.equals(&Route.key(&direct), &Route.key(&copiedRoute)) { return false }

  let forwardUri = match move Uri.parse("http://example.com/a?b#discard") {
    Result<Uri<'static>, ParseError>.Failure {error} => { return false }
    Result<Uri<'static>, ParseError>.Success {value} => value
  }
  let forwardOrigin = match move Origin.fromUri(&forwardUri) {
    Result<Origin, OriginError>.Failure {error} => { return false }
    Result<Origin, OriginError>.Success {value} => value
  }
  let selectedForward = selectRoute(&config, forwardOrigin)
  let emptyFields: [Header<'static>; 0] = []
  let emptyHeaders = match move Headers.make(&emptyFields, proxyValueLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let headerPolicy = HeaderPolicy.defaults()
  let forwarded = match move run Effect.result(prepareForward(
    &selectedForward,
    &forwardUri,
    Version.Http11,
    Method.get(),
    &emptyHeaders,
    &headerPolicy,
    BodyMode.Empty,
    false,
    proxyValueLimits(),
    4096,
    128,
  )) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  if !proxyBytesEqual(
    PreparedRequest.bytes(&forwarded),
    b"GET http://example.com/a?b HTTP/1.1\\r\\nProxy-Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\\r\\nHost: example.com\\r\\nUser-Agent: silk-http/1\\r\\nAccept: */*\\r\\n\\r\\n",
  ) {
    return false
  }
  let ipv6Connect = match move run Effect.result(prepareConnect(
    &schemeRoute,
    proxyValueLimits(),
    4096,
    128,
  )) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  if !proxyBytesEqual(
    PreparedRequest.bytes(&ipv6Connect),
    b"CONNECT [2001:db8::1]:443 HTTP/1.1\\r\\nProxy-Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\\r\\nHost: [2001:db8::1]:443\\r\\nUser-Agent: silk-http/1\\r\\nAccept: */*\\r\\n\\r\\n",
  ) {
    return false
  }
  if !Origin.equals(&PreparedRequest.origin(&forwarded), &forwardOrigin) { return false }
  let expectedProxyPeer = match move proxyCheckedOrigin("http://proxy.example:3128") {
    Result<Origin, ProxyError>.Failure {error} => { return false }
    Result<Origin, ProxyError>.Success {value} => value
  }
  if !Origin.equals(&PreparedRequest.physicalPeer(&forwarded), &expectedProxyPeer) { return false }
  if Origin.equals(&PreparedRequest.origin(&forwarded), &PreparedRequest.physicalPeer(&forwarded)) {
    return false
  }

  let tunnelAdmission = match move run Effect.result(prepareConnect(
    &tunnel,
    proxyValueLimits(),
    4096,
    128,
  )) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  if !Origin.equals(&PreparedRequest.origin(&tunnelAdmission), &secure) { return false }
  if !Origin.equals(&PreparedRequest.physicalPeer(&tunnelAdmission), &expectedProxyPeer) { return false }
  if Origin.equals(&PreparedRequest.origin(&tunnelAdmission), &PreparedRequest.physicalPeer(&tunnelAdmission)) {
    return false
  }
  if !proxyBytesEqual(
    PreparedRequest.bytes(&tunnelAdmission),
    b"CONNECT service.example:443 HTTP/1.1\\r\\nProxy-Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\\r\\nHost: service.example:443\\r\\nUser-Agent: silk-http/1\\r\\nAccept: */*\\r\\n\\r\\n",
  ) {
    return false
  }

  let successStatus = match move Status.fromCode(204) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let successHead = match move ValueResponseHead.make(
    Version.Http11,
    successStatus,
    Option.none<&'static [u8]>(),
    emptyHeaders,
    proxyConnectInputLimits(),
  ) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  match move run Effect.result(proxyClassifyConnect(&successHead)) {
    Result.Failure {error} => { return false }
    Result.Success {value} => {}
  }

  let upgradeFields: [Header<'static>; 0] = []
  let upgradeHeaders = match move Headers.make(&upgradeFields, proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let upgradeStatus = match move Status.fromCode(101) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let upgradeHead = match move ValueResponseHead.make(
    Version.Http11,
    upgradeStatus,
    Option.none<&'static [u8]>(),
    upgradeHeaders,
    proxyConnectInputLimits(),
  ) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  match move run Effect.result(proxyClassifyConnect(&upgradeHead)) {
    Result.Success {value} => { return false }
    Result.Failure {error} => match move error {
      ProxyError.InvalidConnectResponse => {}
      _ => { return false }
    }
  }

  let challengeOne = match move Header.make("Proxy-Authenticate", b"Basic realm=one", proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let unrelated = match move Header.make("X-Ignored", b"not retained", proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let challengeTwo = match move Header.make("proxy-authenticate", b"Negotiate", proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let challengeFields = [challengeOne, unrelated, challengeTwo]
  let challengeHeaders = match move Headers.make(&challengeFields, proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let authenticationStatus = match move Status.fromCode(407) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let authenticationHead = match move ValueResponseHead.make(
    Version.Http11,
    authenticationStatus,
    Option.some<&'static [u8]>(b"Proxy Authentication Required"),
    challengeHeaders,
    proxyConnectInputLimits(),
  ) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  match move run Effect.result(proxyClassifyConnect(&authenticationHead)) {
    Result.Success {value} => { return false }
    Result.Failure {error} => match move error {
      ProxyError.ProxyAuthenticationRequired {response} => {
        let view = OwnedResponseHead.view(&response)
        let status = ValueResponseHead.status(&view)
        if Status.code(&status) != 407 || !proxyReasonEquals(&view, b"Proxy Authentication Required") {
          return false
        }
        let fields = ValueResponseHead.headers(&view)
        if Headers.count(&fields) != 2 { return false }
        let mut selected = Headers.getAll(&fields, "Proxy-Authenticate")
        let first = match move HeaderIterator.next(&mut selected) {
          Option.None => { return false }
          Option.Some {value} => value
        }
        if !proxyBytesEqual(Header.value(&first), b"Basic realm=one") { return false }
        let second = match move HeaderIterator.next(&mut selected) {
          Option.None => { return false }
          Option.Some {value} => value
        }
        if !proxyBytesEqual(Header.value(&second), b"Negotiate") { return false }
      }
      _ => { return false }
    }
  }

  let retainedOne = match move Header.make("Retry-After", b"5", proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let retainedTwo = match move Header.make("X-Trace", b"later", proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let rejectionFields = [retainedOne, retainedTwo]
  let rejectionHeaders = match move Headers.make(&rejectionFields, proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let rejectionStatus = match move Status.fromCode(502) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let rejectionHead = match move ValueResponseHead.make(
    Version.Http11,
    rejectionStatus,
    Option.some<&'static [u8]>(b"Bad Gateway"),
    rejectionHeaders,
    proxyConnectInputLimits(),
  ) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  match move run Effect.result(proxyClassifyConnect(&rejectionHead)) {
    Result.Success {value} => { return false }
    Result.Failure {error} => match move error {
      ProxyError.ProxyRejected {response} => {
        let view = OwnedResponseHead.view(&response)
        let status = ValueResponseHead.status(&view)
        if Status.code(&status) != 502 || !proxyReasonEquals(&view, b"Bad Gateway") { return false }
        let fields = ValueResponseHead.headers(&view)
        if Headers.count(&fields) != 2 { return false }
        let mut ordered = Headers.iter(&fields)
        let first = match move HeaderIterator.next(&mut ordered) {
          Option.None => { return false }
          Option.Some {value} => value
        }
        if Header.name(&first) != "Retry-After"
          || !proxyBytesEqual(Header.value(&first), b"5") { return false }
        let second = match move HeaderIterator.next(&mut ordered) {
          Option.None => { return false }
          Option.Some {value} => value
        }
        if Header.name(&second) != "X-Trace"
          || !proxyBytesEqual(Header.value(&second), b"later") { return false }
      }
      _ => { return false }
    }
  }

  // The wire head fits 32768 bytes, but payload plus four field records exceeds the 32768-byte
  // owned bound even with 32-bit records, so the overflow holds on native and wasm32 targets.
  let largeOne = run proxyFilled(8178)
  let largeTwo = run proxyFilled(8178)
  let largeThree = run proxyFilled(8178)
  let largeFour = run proxyFilled(8178)
  let overflowOne = match move Header.make("A", Bytes.asSlice(&largeOne), proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let overflowTwo = match move Header.make("B", Bytes.asSlice(&largeTwo), proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let overflowThree = match move Header.make("C", Bytes.asSlice(&largeThree), proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let overflowFour = match move Header.make("D", Bytes.asSlice(&largeFour), proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let overflowFields = [overflowOne, overflowTwo, overflowThree, overflowFour]
  let overflowHeaders = match move Headers.make(&overflowFields, proxyConnectInputLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let overflowHead = match move ValueResponseHead.make(
    Version.Http11,
    rejectionStatus,
    Option.none<&'static [u8]>(),
    overflowHeaders,
    proxyConnectInputLimits(),
  ) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  match move run Effect.result(proxyClassifyConnect(&overflowHead)) {
    Result.Success {value} => { return false }
    Result.Failure {error} => match move error {
      ProxyError.ProxyMetadataLimit => {}
      _ => { return false }
    }
  }

  let omittedHostPolicy = HeaderPolicy {
    host: HeaderControl<'static>.Omit,
    userAgent: HeaderControl<'static>.Omit,
    accept: HeaderControl<'static>.Omit,
    authorization: Authorization<'static>.Absent,
    basicSecurity: BasicSecurity.RequireTls,
    http10KeepAlive: false,
  }
  let forwardedHttp10 = match move run Effect.result(prepareForward(
    &selectedForward,
    &forwardUri,
    Version.Http10,
    Method.get(),
    &emptyHeaders,
    &omittedHostPolicy,
    BodyMode.Empty,
    false,
    proxyValueLimits(),
    4096,
    128,
  )) {
    Result.Failure {error} => { return false }
    Result.Success {value} => move value
  }
  if !proxyBytesEqual(
    PreparedRequest.bytes(&forwardedHttp10),
    b"GET http://example.com/a?b HTTP/1.0\\r\\nProxy-Authorization: Basic QWxhZGRpbjpvcGVuIHNlc2FtZQ==\\r\\nHost: example.com\\r\\nConnection: close\\r\\n\\r\\n",
  ) {
    return false
  }

  let proxyField = match move Header.make("Proxy-Authorization", b"Basic override", proxyValueLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let proxyFields = [proxyField]
  let proxyHeaders = match move Headers.make(&proxyFields, proxyValueLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let directTarget = match move RequestTarget.parse(&Method.get(), "/", 256) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  let rejectedDirect = run Effect.result(Request.prepare(
    &forwardOrigin,
    Version.Http11,
    Method.get(),
    directTarget,
    &proxyHeaders,
    &headerPolicy,
    BodyMode.Empty,
    false,
    proxyValueLimits(),
    4096,
    128,
  ))
  match move rejectedDirect {
    Result.Failure {error} => match move error {
      RequestError.ProxyAuthorization => {}
      _ => { return false }
    }
    Result.Success {value} => { return false }
  }
  let rejectedOverride = run Effect.result(prepareForward(
    &selectedForward,
    &forwardUri,
    Version.Http11,
    Method.get(),
    &proxyHeaders,
    &headerPolicy,
    BodyMode.Empty,
    false,
    proxyValueLimits(),
    4096,
    128,
  ))
  match move rejectedOverride {
    Result.Failure {error} => match move error {
      RequestError.ProxyAuthorization => {}
      _ => { return false }
    }
    Result.Success {value} => { return false }
  }

  let emptyOrigins: [Origin; 0] = []
  let emptyForHttps = match move run BypassPolicy.copy(&emptyOrigins) {
    Result<BypassPolicy, ProxyError>.Failure {error} => { return false }
    Result<BypassPolicy, ProxyError>.Success {value} => move value
  }
  match move ProxyConfig.fromUri(
    ProxyConfigId.make(12),
    "https://proxy.example:443",
    ProxyAuth.none(ProxyAuthContextId.make(22)),
    move emptyForHttps,
    65536,
  ) {
    Result<ProxyConfig, ProxyError>.Success {value} => { return false }
    Result<ProxyConfig, ProxyError>.Failure {error} => {
      if !proxyIsReason(move error, ProxyReason.UnsupportedProxyTransport) { return false }
    }
  }

  let emptyForPath = match move run BypassPolicy.copy(&emptyOrigins) {
    Result<BypassPolicy, ProxyError>.Failure {error} => { return false }
    Result<BypassPolicy, ProxyError>.Success {value} => move value
  }
  match move ProxyConfig.fromUri(
    ProxyConfigId.make(13),
    "http://proxy.example/path",
    ProxyAuth.none(ProxyAuthContextId.make(23)),
    move emptyForPath,
    65536,
  ) {
    Result<ProxyConfig, ProxyError>.Success {value} => { return false }
    Result<ProxyConfig, ProxyError>.Failure {error} => {
      if !proxyIsReason(move error, ProxyReason.InvalidProxyUri) { return false }
    }
  }

  match move run ProxyAuth.preparedBasic(ProxyAuthContextId.make(24), b"not base64") {
    Result<ProxyAuth, ProxyError>.Success {value} => { return false }
    Result<ProxyAuth, ProxyError>.Failure {error} => {
      if !proxyIsReason(move error, ProxyReason.InvalidAuthentication) { return false }
    }
  }

  let emptyForCapacity = match move run BypassPolicy.copy(&emptyOrigins) {
    Result<BypassPolicy, ProxyError>.Failure {error} => { return false }
    Result<BypassPolicy, ProxyError>.Success {value} => move value
  }
  match move ProxyConfig.fromUri(
    ProxyConfigId.make(14),
    "http://proxy.example:3128",
    ProxyAuth.none(ProxyAuthContextId.make(25)),
    move emptyForCapacity,
    0,
  ) {
    Result<ProxyConfig, ProxyError>.Success {value} => { return false }
    Result<ProxyConfig, ProxyError>.Failure {error} => {
      if !proxyIsOwnedCapacityFailure(move error) { return false }
    }
  }

  let emptyForRotated = match move run BypassPolicy.copy(&emptyOrigins) {
    Result<BypassPolicy, ProxyError>.Failure {error} => { return false }
    Result<BypassPolicy, ProxyError>.Success {value} => move value
  }
  let rotated = match move ProxyConfig.fromUri(
    configId,
    "http://proxy.example:3128",
    ProxyAuth.none(ProxyAuthContextId.make(99)),
    move emptyForRotated,
    65536,
  ) {
    Result<ProxyConfig, ProxyError>.Failure {error} => { return false }
    Result<ProxyConfig, ProxyError>.Success {value} => move value
  }
  let rotatedRoute = selectRoute(&rotated, insecure)
  let retainedRoute = Route.recompute(&forward, insecure)
  if !ProxyAuthContextId.equals(&Route.authContextId(&retainedRoute), &authId) { return false }
  return !RouteKey.equals(&Route.key(&forward), &Route.key(&rotatedRoute))
}`

export const httpProxyPolicyStandaloneMain = `effect fn recover(error: OutOfMemoryError) -> bool { return false }

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  let checked = verifyProxyPolicy() |> Effect.provideMut<Allocator>(&mut allocator)
  if run Effect.catchAll(checked, recover) { return 42 }
  return 0
}
`

export const httpProxyPolicyAcceptanceSource = `${httpProxyPolicyCommonImports}
${httpProxyPolicyImports}
${httpProxyPolicySupport}
${verifyProxyPolicy}
${httpProxyPolicyStandaloneMain}`
