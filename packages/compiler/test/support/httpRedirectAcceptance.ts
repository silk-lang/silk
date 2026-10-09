import { httpProxyPolicyCommonImports } from './httpProxyAcceptance.js'

const httpConnectionPoolPolicyImports = `import silk.http_connection_pool as Pool {
  Config as PoolConfig,
  ConnectionKey as PoolConnectionKey,
  Counts as PoolCounts,
  Handle as PoolHandle,
}`

const httpNativePoolImports = `import silk.http_connection_pool_native as PoolNative {Context as NativePoolContext}
import silk.http_client_native {NativeTransport}
import silk.trust_snapshot {TrustSourceError}`

const httpFetchPolicyImports = `import silk.http_fetch as HttpFetch {
  Fetch as FetchFacade,
  FetchOptions,
  FetchRequest,
}
import silk.http_fetch_native {Context as NativeFetchContext}
import silk.trust_source {TrustSource}`

const httpConnectionPoolPolicySupport = `fn poolCountsContract<P, C>(
  handle: &PoolHandle<PoolConnectionKey, P, C>,
) -> PoolCounts {
  return Pool.counts<PoolConnectionKey, P, C>(handle)
}

fn poolCountsShape(counts: PoolCounts) -> bool {
  return counts.total == counts.opening + counts.leased + counts.idle && !counts.closed
}

fn poolDeclarationsWitness() -> bool {
  let config = PoolConfig.defaults()
  let origin = match move redirectOrigin("http://pool.example") {
    Option.None => { return false }
    Option.Some {value} => value
  }
  let key = PoolConnectionKey.direct(origin)
  let selected = PoolConnectionKey.origin(&key)
  let counts = PoolCounts {
    opening: usize.ZERO,
    leased: usize.ZERO,
    idle: usize.ZERO,
    total: usize.ZERO,
    closed: false,
  }
  return config.maxTotal == Pool.DEFAULT_MAX_TOTAL
    && config.maxIdle == Pool.DEFAULT_MAX_IDLE
    && config.maxPerOrigin == Pool.DEFAULT_MAX_PER_ORIGIN
    && config.idleTimeoutNanoseconds == Pool.DEFAULT_IDLE_TIMEOUT_NANOSECONDS
    && Origin.equals(&origin, &selected)
    && poolCountsShape(counts)
}`

// The native pool copy needs a libc-backed pool, so it is analyzed but not executed.
const nativePoolCopyWitness = `effect fn nativePoolCopyWitness(
  handle: &'static PoolHandle<PoolConnectionKey, NativeTransport, NativePoolContext>,
) -> PoolHandle<PoolConnectionKey, NativeTransport, NativePoolContext>
! TrustSourceError | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run PoolNative.copyHandle(handle) |> Effect.provideMut<Allocator>(&mut allocator)
}`

const httpFetchPolicySupport = `pub effect fn nativeFetchSourceFamiliesWitness<
  'configuration,
  'emptyUri,
  'bytesUri,
  'oneShotUri,
  'replayUri,
>(
  fetch: &mut FetchFacade<NativeFetchContext<'configuration>>,
  emptyUri: Uri<'emptyUri>,
  bytesUri: Uri<'bytesUri>,
  oneShotUri: Uri<'oneShotUri>,
  replayUri: Uri<'replayUri>,
) -> ()
? &mut Allocator
  | &mut MonotonicClock
  | &mut SystemClock
  | &mut Random
  | &mut TrustSource
  | &mut RedirectProducerRequirement
  | &mut RedirectFactoryRequirement {
  let empty = run Effect.result(HttpFetch.discardEmpty(
    &mut fetch.*,
    FetchRequest.get(emptyUri),
    FetchOptions.defaults(),
    u64.toU64(1),
  ))
  drop empty
  let bytes = run Effect.result(HttpFetch.discardBytes(
    &mut fetch.*,
    FetchRequest.get(bytesUri),
    b"x",
    FetchOptions.defaults(),
    u64.toU64(1),
  ))
  drop bytes
  let oneShot = run Effect.result(HttpFetch.discardOneShot(
    &mut fetch.*,
    FetchRequest.get(oneShotUri),
    RedirectProducer {offset: usize.ZERO},
    FetchOptions.defaults(),
    u64.toU64(1),
  ))
  drop oneShot
  let replay = run Effect.result(HttpFetch.discardReplay(
    &mut fetch.*,
    FetchRequest.get(replayUri),
    RedirectFactory {},
    FetchOptions.defaults(),
    u64.toU64(1),
  ))
  drop replay
  return ()
}`

export const httpRedirectPolicyImports = `import silk.http_headers {
  Limits as RedirectHeaderLimits,
  OwnedHeaders,
}
import silk.byte_duplex {ByteDuplex, ByteIoError, ReadTransfer}
import silk.http {ValueError}
import silk.http_client {ClientError, ContinuePolicy, Exchange, RouteTransport}
import silk.http_transport {HttpTransport, TransportError}
import silk.http_redirect {
  Attempt,
  AttemptClient,
  AttemptRequest,
  AttemptStep,
  SelectedBody,
  BodyChunk,
  BodyDecision,
  BodyProducer,
  CrossOriginPolicy,
  DowngradePolicy,
  History,
  HistoryLimits,
  Mode as RedirectMode,
  NameList,
  NameListLimits,
  Policy as RedirectPolicy,
  Post301302Policy,
  PreviousResponsePolicy,
  ResponseHandler,
  RedirectComponent,
  RedirectContext,
  RedirectError,
  RedirectLimit,
  RedirectReason,
  ReplayFactory,
  Request as RedirectRequest,
  StatusDecision,
  admitOrigin,
  crossOriginHeaderPolicy,
  resolveLocation,
  sanitizeHeaders,
  statusDecision,
  transition,
  withBytesResponse,
  withEmptyResponse,
  withOneShotResponse,
  withReplayResponse,
}
import silk.http_origin {OriginError as RedirectOriginError}
import silk.monotonic_clock {MonotonicClock}
import silk.random {Random}
import silk.string {String}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.uri {OwnedUri}
import silk.uri_reference {ParseError as RedirectParseError}
`

const httpRedirectOperationSupport = `enum RedirectFactoryFailure { Failed }
enum RedirectProducerFailure { Failed }
enum RedirectCallbackFailure { Failed }
enum RedirectAcquisitionFailure { Rejected }

service RedirectFactoryRequirement {}
service RedirectProducerRequirement {}
service RedirectCallbackRequirement {
  effect fn accepted() -> bool ? &mut RedirectCallbackRequirement
}
service RedirectAcquisitionRequirement {
  effect fn accepted() -> bool ? &mut RedirectAcquisitionRequirement
}

struct RedirectWitnessTransport {}

impl RedirectWitnessTransport {
  unsafe effect fn readHttp(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    drop self
    drop output
    drop deadline
    return ReadTransfer.End
  }

  unsafe effect fn writeHttp(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    drop self
    drop deadline
    return input.length
  }

  effect fn flushHttp(self: &mut Self, deadline: Option<Instant>) -> ()
  ! TransportError | OutOfMemoryError
  ? &mut MonotonicClock | &mut Allocator | &mut Random {
    drop self
    drop deadline
    return ()
  }

  effect fn closeHttp(self: &mut Self) -> () ! TransportError {
    drop self
    return ()
  }

  unsafe effect fn readBytes(
    self: &mut Self,
    output: &mut [u8],
    deadline: Option<Instant>,
  ) -> ReadTransfer ! ByteIoError ? &mut MonotonicClock {
    drop self
    drop output
    drop deadline
    return ReadTransfer.End
  }

  unsafe effect fn writeBytes(
    self: &mut Self,
    input: &[u8],
    deadline: Option<Instant>,
  ) -> usize ! ByteIoError ? &mut MonotonicClock {
    drop self
    drop deadline
    return input.length
  }

  unsafe effect fn flushBytes(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    drop self
    drop deadline
    return ()
  }

  unsafe effect fn shutdownBytes(
    self: &mut Self,
    deadline: Option<Instant>,
  ) -> () ! ByteIoError ? &mut MonotonicClock {
    drop self
    drop deadline
    return ()
  }

  unsafe effect fn closeBytes(self: &mut Self) -> () ! ByteIoError {
    drop self
    return ()
  }
}

impl HttpTransport for RedirectWitnessTransport {
  readSomeRaw: RedirectWitnessTransport.readHttp
  writeSomeRaw: RedirectWitnessTransport.writeHttp
  flush: RedirectWitnessTransport.flushHttp
  close: RedirectWitnessTransport.closeHttp
}

impl ByteDuplex for RedirectWitnessTransport {
  readSomeRaw: RedirectWitnessTransport.readBytes
  writeSomeRaw: RedirectWitnessTransport.writeBytes
  flushRaw: RedirectWitnessTransport.flushBytes
  shutdownWriteRaw: RedirectWitnessTransport.shutdownBytes
  closeRaw: RedirectWitnessTransport.closeBytes
}

struct RedirectRejectingClient<'policy, ProducerError, ?ProducerRequirements> {
  policy: &'policy RedirectPolicy
}

impl<'policy, ProducerError, ?ProducerRequirements> AttemptClient<
  'policy,
  RedirectWitnessTransport,
  AttemptStep<'policy, i32>,
  RedirectError | ValueError | ProducerError | RedirectCallbackFailure | ClientError | OutOfMemoryError,
  RedirectAcquisitionFailure,
  &mut RedirectAcquisitionRequirement,
  ProducerRequirements | &mut RedirectCallbackRequirement
    | &mut SelectedBody<ProducerError, ProducerRequirements>
    | &mut MonotonicClock | &mut Allocator | &mut Random,
> for RedirectRejectingClient<'policy, ProducerError, ProducerRequirements> {
  effect fn withAttempt(
    client: &mut Self,
    request: AttemptRequest<'policy>,
    deadline: Option<Instant>,
  ) -> AttemptStep<'policy, i32>
  ! RedirectError | ValueError | ProducerError | RedirectCallbackFailure | ClientError
    | OutOfMemoryError | RedirectAcquisitionFailure
  ? ProducerRequirements | &mut RedirectCallbackRequirement
    | &mut SelectedBody<ProducerError, ProducerRequirements>
    | &mut MonotonicClock | &mut Allocator | &mut Random
    | &mut RedirectAcquisitionRequirement
    | &mut Attempt<
      'policy,
      RedirectWitnessTransport,
      AttemptStep<'policy, i32>,
      RedirectError | ValueError | ProducerError | RedirectCallbackFailure | ClientError | OutOfMemoryError,
      ProducerRequirements | &mut RedirectCallbackRequirement
        | &mut SelectedBody<ProducerError, ProducerRequirements>
        | &mut MonotonicClock | &mut Allocator | &mut Random,
    >
  where
    ProducerRequirements in Without<ProducerRequirements, ByteDuplex>,
    ProducerRequirements in Without<ProducerRequirements, HttpTransport> {
    drop client
    drop request
    drop deadline
    let accepted = run RedirectAcquisitionRequirement.accepted()
    drop accepted
    fail RedirectAcquisitionFailure.Rejected
  }
}

struct RedirectFinalUse {}

impl RedirectFinalUse {
  effect<'call> fn handle<
    'call,
    'exchangeView: 'call,
    'transport: 'exchangeView,
    'provider: 'transport,
    'tunnel: 'provider,
  >(
    handler: &mut Self,
    uri: Uri<'call>,
    hop: usize,
    exchange: &'call mut Exchange<'exchangeView, RouteTransport<
      'transport,
      'provider,
      'tunnel,
      RedirectWitnessTransport,
    >>,
  ) -> i32 ! RedirectCallbackFailure ? &mut RedirectCallbackRequirement
  where
    &mut RedirectWitnessTransport provides &HttpTransport from &mut HttpTransport | &mut MonotonicClock | &mut Allocator | &mut Random,
    &mut RedirectWitnessTransport provides &HttpTransport from &mut HttpTransport,
    &mut RedirectWitnessTransport provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock | &mut Allocator | &mut Random,
    &mut RedirectWitnessTransport provides &ByteDuplex from &mut ByteDuplex {
    drop handler
    drop uri
    drop hop
    drop exchange
    if !run RedirectCallbackRequirement.accepted() {
      fail RedirectCallbackFailure.Failed
    }
    return 17
  }
}

impl ResponseHandler<
  RedirectWitnessTransport,
  i32,
  RedirectCallbackFailure ? &mut RedirectCallbackRequirement
> for RedirectFinalUse {
  handle: RedirectFinalUse.handle
}

struct RedirectProducer { offset: usize }

impl BodyProducer<RedirectProducerFailure ? &mut RedirectProducerRequirement> for RedirectProducer {
  fn mode(producer: &Self) -> BodyMode {
    drop producer
    return BodyMode.KnownLength {length: u64.toU64(1)}
  }

  effect fn pull(producer: &mut Self, output: &mut [u8]) -> BodyChunk
  ! RedirectProducerFailure
  ? &mut RedirectProducerRequirement {
    if producer.offset == usize.ZERO && output.length > usize.ZERO {
      output[usize.ZERO] = 120
      producer.offset = usize.ONE
      return BodyChunk {length: usize.ONE, end: true}
    }
    return BodyChunk {length: usize.ZERO, end: true}
  }
}

struct RedirectFactory {}

impl RedirectFactory {
  effect fn acquire(factory: &mut Self) -> RedirectProducer
  ! RedirectFactoryFailure
  ? &mut RedirectFactoryRequirement {
    drop factory
    return RedirectProducer {offset: usize.ZERO}
  }

  fn release(factory: &mut Self, producer: &mut RedirectProducer) -> () {
    drop factory
    drop producer
    return ()
  }
}

impl ReplayFactory<
  RedirectProducer,
  RedirectFactoryFailure,
  &mut RedirectFactoryRequirement,
> for RedirectFactory {
  acquire: RedirectFactory.acquire
  release: RedirectFactory.release
}

effect fn redirectReplayRowWitness(factory: &mut RedirectFactory) -> i32
! RedirectFactoryFailure | RedirectProducerFailure
? &mut RedirectFactoryRequirement | &mut RedirectProducerRequirement {
  let producer = run ReplayFactory<
    RedirectProducer,
    RedirectFactoryFailure,
    &mut RedirectFactoryRequirement,
  >.acquire(factory)
  let use = effect fn(owned: &mut RedirectProducer) -> i32
  ! RedirectProducerFailure
  ? &mut RedirectProducerRequirement {
    let mut output: [u8; 1] = [0]
    let chunk = run BodyProducer<
      RedirectProducerFailure ? &mut RedirectProducerRequirement
    >.pull(owned, &mut output)
    if chunk.length == usize.ONE && chunk.end && output[usize.ZERO] == 120 { return 17 }
    return -1
  }
  let release = effect fn(owned: &mut RedirectProducer) -> () {
    return ReplayFactory<
      RedirectProducer,
      RedirectFactoryFailure,
      &mut RedirectFactoryRequirement,
    >.release(factory, owned)
  }
  return run Effect.useReleaseNonParking(move producer, move use, move release)
}

`

const httpRedirectBehaviorSupport = `fn redirectStatus(code: u16) -> Status {
  return match move Status.fromCode(code) {
    Result.Failure {error} => {
      drop error
      return redirectStatus(200)
    }
    Result.Success {value} => value
  }
}

fn redirectOrigin(text: string) -> Option<Origin> {
  let uri = match move Uri.parse(text) {
    Result.Failure {error} => {
      drop error
      return Option.none<Origin>()
    }
    Result.Success {value} => value
  }
  return match move Origin.fromUri(&uri) {
    Result.Failure {error} => {
      drop error
      return Option.none<Origin>()
    }
    Result.Success {value} => Option.some<Origin>(value)
  }
}

effect<'env> fn redirectTakeValue<T: 'env, 'env>(result: Result<T, ValueError>) -> T ! ValueError {
  return match move result {
    Result.Failure {error} => { fail move error }
    Result.Success {value} => move value
  }
}

effect<'env> fn redirectTakeRedirect<T: 'env, 'env>(result: Result<T, RedirectError>) -> T ! RedirectError {
  return match move result {
    Result.Failure {error} => { fail move error }
    Result.Success {value} => move value
  }
}

effect<'env> fn redirectTakeParse<T: 'env, 'env>(result: Result<T, RedirectParseError>) -> T ! RedirectParseError {
  return match move result {
    Result.Failure {error} => { fail move error }
    Result.Success {value} => move value
  }
}

effect<'env> fn redirectTakeOrigin<T: 'env, 'env>(result: Result<T, RedirectOriginError>) -> T ! RedirectOriginError {
  return match move result {
    Result.Failure {error} => { fail move error }
    Result.Success {value} => move value
  }
}

enum RedirectReasonTag {
  NameListOverlap,
  SizeOverflow,
  LocationMissing,
  LocationAmbiguous,
  LocationInvalid,
  RedirectSchemeDenied,
  RedirectOriginDenied,
  DowngradeDenied,
  HopLimit,
  RedirectLoop,
  ReplayUnavailable,
}

struct RedirectLocationCase {
  current: string<'static>
  location: &'static [u8]
  expected: string<'static>
}

impl Copy for RedirectLocationCase {}

fn redirectReasonIs(actual: RedirectReason, expected: RedirectReasonTag) -> bool {
  return match move actual {
    RedirectReason.NameListOverlap => expected == RedirectReasonTag.NameListOverlap
    RedirectReason.SizeOverflow => expected == RedirectReasonTag.SizeOverflow
    RedirectReason.LocationMissing => expected == RedirectReasonTag.LocationMissing
    RedirectReason.LocationAmbiguous => expected == RedirectReasonTag.LocationAmbiguous
    RedirectReason.LocationInvalid => expected == RedirectReasonTag.LocationInvalid
    RedirectReason.RedirectSchemeDenied => expected == RedirectReasonTag.RedirectSchemeDenied
    RedirectReason.RedirectOriginDenied => expected == RedirectReasonTag.RedirectOriginDenied
    RedirectReason.DowngradeDenied => expected == RedirectReasonTag.DowngradeDenied
    RedirectReason.HopLimit => expected == RedirectReasonTag.HopLimit
    RedirectReason.RedirectLoop => expected == RedirectReasonTag.RedirectLoop
    RedirectReason.ReplayUnavailable => expected == RedirectReasonTag.ReplayUnavailable
    _ => false
  }
}

fn redirectContextIs(
  context: RedirectContext,
  hop: usize,
  status: Option<u16>,
  hasCurrentUri: bool,
  hasNextUri: bool,
) -> bool {
  let RedirectContext {hop: actualHop, status: actualStatus, currentUri, nextUri} = move context
  let statusMatches = match move status {
    Option.None => match move actualStatus {
      Option.None => true
      Option.Some {value} => false
    }
    Option.Some {value: expected} => match move actualStatus {
      Option.None => false
      Option.Some {value} => Status.code(&value) == expected
    }
  }
  let currentPresent = match move currentUri {
    Option.None => false
    Option.Some {value} => true
  }
  let nextPresent = match move nextUri {
    Option.None => false
    Option.Some {value} => true
  }
  return actualHop == hop && statusMatches
    && (currentPresent && hasCurrentUri || !currentPresent && !hasCurrentUri)
    && (nextPresent && hasNextUri || !nextPresent && !hasNextUri)
}

fn redirectFailureIs<T>(
  result: Result<T, RedirectError>,
  component: RedirectComponent,
  reason: RedirectReasonTag,
  hop: usize,
  status: Option<u16>,
) -> bool {
  return match move result {
    Result.Success {value} => {
      drop value
      return false
    }
    Result.Failure {error} => {
      let RedirectError {component: actual, reason: actualReason, context} = move error
      return actual == component && redirectReasonIs(move actualReason, reason)
        && redirectContextIs(move context, hop, move status, false, false)
    }
  }
}

fn redirectLimitFailureIs<T>(
  result: Result<T, RedirectError>,
  component: RedirectComponent,
  limit: RedirectLimit,
  allowed: usize,
  attempted: usize,
  hop: usize,
  status: Option<u16>,
) -> bool {
  return match move result {
    Result.Success {value} => {
      drop value
      return false
    }
    Result.Failure {error} => {
      let RedirectError {component: actual, reason, context} = move error
      let reasonMatches = match move reason {
        RedirectReason.LimitExceeded {
          limit: actualLimit,
          allowed: actualAllowed,
          attempted: actualAttempted,
        } => actualLimit == limit && actualAllowed == allowed && actualAttempted == attempted
        _ => false
      }
      return actual == component && reasonMatches
        && redirectContextIs(move context, hop, move status, false, false)
    }
  }
}

fn redirectDecisionIs(
  policy: &RedirectPolicy,
  status: Status,
  followedHops: usize,
  expected: StatusDecision,
) -> bool {
  return match move statusDecision(policy, status, followedHops) {
    Result.Failure {error} => {
      drop error
      return false
    }
    Result.Success {value} => value == expected
  }
}

fn redirectTransitionIs(
  policy: &RedirectPolicy,
  status: Status,
  method: Method,
  expectedMethod: string,
  expectedBody: BodyDecision,
) -> bool {
  let selected = transition(policy, status, method)
  return Method.format(&selected.method) == expectedMethod && selected.body == expectedBody
}

fn redirectHeaderLimits() -> RedirectHeaderLimits {
  return RedirectHeaderLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 512,
    maxNameBytes: 64,
    maxValueBytes: 512,
    maxFields: 32,
    maxFieldBytes: 4096,
    maxOwnedBytes: 8192,
  }
}

fn redirectBytesEqual(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

fn redirectOwnedUriIs(value: &OwnedUri, expected: string) -> bool {
  let view = value.view()
  return Uri.format(&view) == expected
}

effect fn redirectHeader(name: string<'static>, value: &'static [u8]) -> Header<'static>
! ValueError {
  return run redirectTakeValue(Header.make(name, value, redirectHeaderLimits()))
}

effect fn redirectHeaders(location: &'static [u8]) -> OwnedHeaders
! ValueError | OutOfMemoryError ? &mut Allocator {
  let entries = [run redirectHeader("Location", location)]
  let view = run redirectTakeValue(Headers.make(&entries, redirectHeaderLimits()))
  return run redirectTakeValue(run Headers.copy(&view, redirectHeaderLimits()))
}

effect fn redirectResolve(
  currentText: string,
  headers: &Headers,
  limit: usize,
) -> Result<OwnedUri, RedirectError>
! RedirectParseError | OutOfMemoryError
? &mut Allocator {
  let current = run redirectTakeParse(Uri.parse(currentText))
  return run resolveLocation(
    &current,
    headers,
    HistoryLimits {maxHops: 2, maxUriBytes: limit, maxHistoryBytes: 4096},
    usize.ONE,
    redirectStatus(302),
  )
}

effect fn redirectResolvedIs(
  current: string,
  headers: &Headers,
  limit: usize,
  expected: string,
) -> bool
! RedirectParseError | RedirectError | OutOfMemoryError
? &mut Allocator {
  let result = run redirectResolve(current, headers, limit)
  let owned = run redirectTakeRedirect(move result)
  let view = owned.view()
  return Uri.format(&view) == expected
}

fn redirectFormattedIs(headers: &Headers, output: &mut [u8], expected: &[u8]) -> bool {
  return match move Headers.formatInto(headers, &mut output) {
    Result.Failure {error} => {
      drop error
      return false
    }
    Result.Success {value} => value == expected.length && redirectBytesEqual(&output, expected)
  }
}

`

const httpRedirectOperationContractSupport = `fn redirectOperationRequest<'headers>(
  uri: Uri<'static>,
  headers: Headers<'headers>,
) -> RedirectRequest<'static, 'static, 'headers, 'static> {
  return RedirectRequest<'static, 'static, 'headers, 'static> {
    uri: uri,
    method: Method.post(),
    headers: headers,
    headerPolicy: HeaderPolicy.defaults(),
    version: Version.Http11,
    continuePolicy: ContinuePolicy.Disabled,
    limits: redirectHeaderLimits(),
    maxHeadBytes: 512,
    maxCredentialBytes: 128,
  }
}

effect fn redirectEmptyContractWitness<
  'uri,
  'method,
  'headers,
  'policy,
  'scratch,
>(
  client: &mut RedirectRejectingClient<'policy, never, never>,
  request: RedirectRequest<'uri, 'method, 'headers, 'policy>,
  policy: &'policy RedirectPolicy,
  scratch: &'scratch mut [u8],
) -> i32
! RedirectError
  | ValueError
  | RedirectCallbackFailure
  | ClientError
  | OutOfMemoryError
  | RedirectAcquisitionFailure
? &mut RedirectCallbackRequirement
  | &mut RedirectAcquisitionRequirement
  | &mut MonotonicClock
  | &mut Allocator
  | &mut Random {
  return run withEmptyResponse(
    move client,
    move request,
    policy,
    Option.none<Instant>(),
    move scratch,
    RedirectFinalUse {},
  )
}

effect fn redirectBytesContractWitness<
  'uri,
  'method,
  'headers,
  'policy,
  'bytes,
  'scratch,
>(
  client: &mut RedirectRejectingClient<'policy, never, never>,
  request: RedirectRequest<'uri, 'method, 'headers, 'policy>,
  policy: &'policy RedirectPolicy,
  bytes: &'bytes [u8],
  scratch: &'scratch mut [u8],
) -> i32
! RedirectError
  | ValueError
  | RedirectCallbackFailure
  | ClientError
  | OutOfMemoryError
  | RedirectAcquisitionFailure
? &mut RedirectCallbackRequirement
  | &mut RedirectAcquisitionRequirement
  | &mut MonotonicClock
  | &mut Allocator
  | &mut Random {
  return run withBytesResponse(
    move client,
    move request,
    policy,
    bytes,
    Option.none<Instant>(),
    move scratch,
    RedirectFinalUse {},
  )
}

effect fn redirectOneShotContractWitness<
  'uri,
  'method,
  'headers,
  'policy,
  'scratch,
>(
  client: &mut RedirectRejectingClient<'policy, RedirectProducerFailure, &mut RedirectProducerRequirement>,
  request: RedirectRequest<'uri, 'method, 'headers, 'policy>,
  policy: &'policy RedirectPolicy,
  producer: RedirectProducer,
  scratch: &'scratch mut [u8],
) -> i32
! RedirectError
  | ValueError
  | RedirectProducerFailure
  | RedirectCallbackFailure
  | ClientError
  | OutOfMemoryError
  | RedirectAcquisitionFailure
? &mut RedirectProducerRequirement
  | &mut RedirectCallbackRequirement
  | &mut RedirectAcquisitionRequirement
  | &mut MonotonicClock
  | &mut Allocator
  | &mut Random {
  return run withOneShotResponse(
    move client,
    move request,
    policy,
    move producer,
    Option.none<Instant>(),
    move scratch,
    RedirectFinalUse {},
  )
}

effect fn redirectReplayContractWitness<
  'uri,
  'method,
  'headers,
  'policy,
  'scratch,
>(
  client: &mut RedirectRejectingClient<'policy, RedirectProducerFailure, &mut RedirectProducerRequirement>,
  request: RedirectRequest<'uri, 'method, 'headers, 'policy>,
  policy: &'policy RedirectPolicy,
  factory: RedirectFactory,
  scratch: &'scratch mut [u8],
) -> i32
! RedirectError
  | ValueError
  | RedirectFactoryFailure
  | RedirectProducerFailure
  | RedirectCallbackFailure
  | ClientError
  | OutOfMemoryError
  | RedirectAcquisitionFailure
? &mut RedirectFactoryRequirement
  | &mut RedirectProducerRequirement
  | &mut RedirectCallbackRequirement
  | &mut RedirectAcquisitionRequirement
  | &mut MonotonicClock
  | &mut Allocator
  | &mut Random {
  return run withReplayResponse(
    move client,
    move request,
    policy,
    move factory,
    Option.none<Instant>(),
    move scratch,
    RedirectFinalUse {},
  )
}
`

const redirectPolicyCompileWitness = `pub fn redirectPolicyCompileWitness() -> i32 {
  let defaults = RedirectPolicy.defaults()
  let limits = RedirectPolicy.historyLimits(&defaults)
  if RedirectPolicy.mode(&defaults) != RedirectMode.Manual
    || limits.maxHops != 10
    || limits.maxUriBytes != 8192
    || limits.maxHistoryBytes != 90112
    || RedirectPolicy.crossOrigin(&defaults) != CrossOriginPolicy.Deny
    || RedirectPolicy.downgrade(&defaults) != DowngradePolicy.Deny
    || RedirectPolicy.post301302(&defaults) != Post301302Policy.Preserve
    || NameList.count(RedirectPolicy.safeCustom(&defaults)) != usize.ZERO
    || NameList.count(RedirectPolicy.sensitive(&defaults)) != usize.ZERO { return 101 }
  let defaultPrevious = RedirectPolicy.previousResponse(&defaults)
  match &defaultPrevious.* {
    PreviousResponsePolicy.Close => {}
    _ => { return 102 }
  }

  let s301 = redirectStatus(301)
  let s302 = redirectStatus(302)
  let s303 = redirectStatus(303)
  let s304 = redirectStatus(304)
  let s307 = redirectStatus(307)
  let s308 = redirectStatus(308)
  if !redirectDecisionIs(&defaults, s302, usize.MAX, StatusDecision.Final) { return 109 }
  if !redirectTransitionIs(&defaults, s301, Method.post(), "POST", BodyDecision.Retain)
    || !redirectTransitionIs(&defaults, s302, Method.post(), "POST", BodyDecision.Retain) {
    return 110
  }

  let follow = match move RedirectPolicy.make(
    RedirectMode.Follow,
    HistoryLimits {maxHops: 10, maxUriBytes: 8192, maxHistoryBytes: 90112},
    CrossOriginPolicy.Allow,
    DowngradePolicy.Deny,
    Post301302Policy.ToGet,
    PreviousResponsePolicy.Drain {
      maxDiscardWireBytes: 64,
      deadline: SystemClock.make(9, 0),
    },
    NameList.empty(),
    NameList.empty(),
  ) {
    Result.Failure {error} => {
      drop error
      return 111
    }
    Result.Success {value} => move value
  }
  let followPrevious = RedirectPolicy.previousResponse(&follow)
  match &followPrevious.* {
    PreviousResponsePolicy.Drain {maxDiscardWireBytes, deadline} => {
      if maxDiscardWireBytes != 64 || SystemClock.seconds(&deadline) != 9 { return 112 }
    }
    _ => { return 112 }
  }
  let selected: [u16; 5] = [301, 302, 303, 307, 308]
  let mut selectedIndex = usize.ZERO
  while selectedIndex < 5 {
    let selectedStatus = redirectStatus(selected[selectedIndex])
    if !redirectDecisionIs(&follow, selectedStatus, usize.ZERO, StatusDecision.Redirect) {
      return 113 + usize.toI32(selectedIndex)
    }
    selectedIndex = selectedIndex + usize.ONE
  }
  if !redirectDecisionIs(&follow, s304, usize.ZERO, StatusDecision.Final) { return 118 }
  if !redirectTransitionIs(&follow, s301, Method.post(), "GET", BodyDecision.Drop)
    || !redirectTransitionIs(&follow, s302, Method.post(), "GET", BodyDecision.Drop)
    || !redirectTransitionIs(&follow, s303, Method.post(), "GET", BodyDecision.Drop)
    || !redirectTransitionIs(&follow, s303, Method.head(), "HEAD", BodyDecision.Drop)
    || !redirectTransitionIs(&follow, s303, Method.patch(), "GET", BodyDecision.Drop)
    || !redirectTransitionIs(&follow, s301, Method.patch(), "PATCH", BodyDecision.Retain)
    || !redirectTransitionIs(&follow, s307, Method.post(), "POST", BodyDecision.Retain)
    || !redirectTransitionIs(&follow, s308, Method.patch(), "PATCH", BodyDecision.Retain) {
    return 119
  }

  let zero = match move RedirectPolicy.make(
    RedirectMode.Follow,
    HistoryLimits {maxHops: usize.ZERO, maxUriBytes: 64, maxHistoryBytes: 1024},
    CrossOriginPolicy.Deny,
    DowngradePolicy.Deny,
    Post301302Policy.Preserve,
    PreviousResponsePolicy.Close,
    NameList.empty(),
    NameList.empty(),
  ) {
    Result.Failure {error} => {
      drop error
      return 120
    }
    Result.Success {value} => move value
  }
  if !redirectFailureIs(
    statusDecision(&zero, s301, usize.ZERO),
    RedirectComponent.Policy,
    RedirectReasonTag.HopLimit,
    usize.ZERO,
    Option.some<u16>(301),
  ) { return 121 }
  if !redirectFailureIs(RedirectPolicy.make(
    RedirectMode.Follow,
    HistoryLimits {maxHops: usize.MAX, maxUriBytes: 64, maxHistoryBytes: usize.MAX},
    CrossOriginPolicy.Deny,
    DowngradePolicy.Deny,
    Post301302Policy.Preserve,
    PreviousResponsePolicy.Close,
    NameList.empty(),
    NameList.empty(),
  ), RedirectComponent.History, RedirectReasonTag.SizeOverflow, usize.ZERO, Option.none<u16>()) {
    return 122
  }

  let cleaned = crossOriginHeaderPolicy(HeaderPolicy {
    host: HeaderControl.Value {value: b"old.example"},
    userAgent: HeaderControl<'static>.Omit,
    accept: HeaderControl.Value {value: b"application/json"},
    authorization: Authorization.Basic {username: b"user", password: b"secret"},
    basicSecurity: BasicSecurity.AllowInsecureBasic,
    http10KeepAlive: true,
  })
  match cleaned.host { HeaderControl.Default => {} _ => { return 131 } }
  match cleaned.authorization { Authorization.Absent => {} _ => { return 132 } }
  match cleaned.userAgent { HeaderControl.Omit => {} _ => { return 133 } }
  match cleaned.accept {
    HeaderControl.Value {value} => { if !redirectBytesEqual(value, b"application/json") { return 134 } }
    _ => { return 135 }
  }

  let current = match move redirectOrigin("https://example.com") {
    Option.None => { return 136 }
    Option.Some {value} => value
  }
  let equivalent = match move redirectOrigin("https://EXAMPLE.com:443") {
    Option.None => { return 137 }
    Option.Some {value} => value
  }
  if !Origin.equals(&current, &equivalent) { return 140 }
  let changedUris: [string<'static>; 2] = ["https://example.com:444", "https://sub.example.com"]
  let mut changedIndex = usize.ZERO
  while changedIndex < 2 {
    let changed = match move redirectOrigin(changedUris[changedIndex]) {
      Option.None => { return 141 }
      Option.Some {value} => value
    }
    if changedIndex == usize.ZERO && !redirectFailureIs(
      admitOrigin(&defaults, &current, &changed, usize.ONE, s302),
      RedirectComponent.Origin,
      RedirectReasonTag.RedirectOriginDenied,
      usize.ONE,
      Option.some<u16>(302),
    ) {
      return 142
    }
    match move admitOrigin(&follow, &current, &changed, usize.ONE, s302) {
      Result.Failure {error} => {
        drop error
        return 143
      }
      Result.Success {value} => { if !value { return 144 } }
    }
    changedIndex = changedIndex + usize.ONE
  }
  let downgraded = match move redirectOrigin("http://example.com") {
    Option.None => { return 145 }
    Option.Some {value} => value
  }
  if !redirectFailureIs(
    admitOrigin(&follow, &current, &downgraded, usize.ONE, s302),
    RedirectComponent.Origin,
    RedirectReasonTag.DowngradeDenied,
    usize.ONE,
    Option.some<u16>(302),
  ) {
    return 147
  }
  return 0
}`

const verifyRedirectPolicy = `pub effect fn verifyRedirectPolicy() -> bool
! OutOfMemoryError | RedirectError | ValueError | RedirectParseError | RedirectOriginError
? &mut Allocator {
  let oneName = ["x-safe"]
  let nameLimits = NameListLimits {maxNames: 1, maxNameBytes: 6, maxOwnedBytes: 1024}
  let probe = run redirectTakeRedirect(run NameList.copy(&oneName, nameLimits))
  let exactOwned = NameList.ownedBytes(&probe)
  if NameList.count(&probe) != usize.ONE || !NameList.contains(&probe, "X-SAFE") { return false }
  let exact = run redirectTakeRedirect(run NameList.copy(
    &oneName,
    NameListLimits {maxNames: 1, maxNameBytes: 6, maxOwnedBytes: exactOwned},
  ))
  drop exact
  if !redirectLimitFailureIs(run NameList.copy(
    &oneName,
    NameListLimits {maxNames: 1, maxNameBytes: 6, maxOwnedBytes: exactOwned - usize.ONE},
  ), RedirectComponent.Policy, RedirectLimit.PolicyOwnedBytes, exactOwned - usize.ONE, exactOwned,
    usize.ZERO, Option.none<u16>()) { return false }
  if !redirectLimitFailureIs(run NameList.copy(
    &oneName,
    NameListLimits {maxNames: usize.ZERO, maxNameBytes: 6, maxOwnedBytes: exactOwned},
  ), RedirectComponent.Policy, RedirectLimit.PolicyNames, usize.ZERO, usize.ONE,
    usize.ZERO, Option.none<u16>()) { return false }
  if !redirectLimitFailureIs(run NameList.copy(
    &oneName,
    NameListLimits {maxNames: 1, maxNameBytes: 5, maxOwnedBytes: exactOwned},
  ), RedirectComponent.Policy, RedirectLimit.PolicyNameBytes, 5, 6,
    usize.ZERO, Option.none<u16>()) { return false }
  let overlapNames = ["X-SAFE"]
  let overlapSensitive = run redirectTakeRedirect(run NameList.copy(&overlapNames, nameLimits))
  if !redirectFailureIs(RedirectPolicy.make(
    RedirectMode.Follow,
    HistoryLimits {maxHops: 2, maxUriBytes: 128, maxHistoryBytes: 4096},
    CrossOriginPolicy.Allow,
    DowngradePolicy.Allow,
    Post301302Policy.Preserve,
    PreviousResponsePolicy.Close,
    move probe,
    move overlapSensitive,
  ), RedirectComponent.Policy, RedirectReasonTag.NameListOverlap, usize.ZERO,
    Option.none<u16>()) { return false }

  let locations = [
    RedirectLocationCase {
      current: "https://example/a#old",
      location: b"../b?x",
      expected: "https://example/b?x#old",
    },
    RedirectLocationCase {
      current: "https://example/b?x#old",
      location: b"#",
      expected: "https://example/b?x#",
    },
    RedirectLocationCase {
      current: "https://example/a?x#old",
      location: b"",
      expected: "https://example/a?x#old",
    },
    RedirectLocationCase {
      current: "https://example/a?x#old",
      location: b"?y",
      expected: "https://example/a?y#old",
    },
  ]
  let mut locationIndex = usize.ZERO
  while locationIndex < 4 {
    let selected = locations[locationIndex]
    let selectedOwner = run redirectHeaders(selected.location)
    let selectedHeaders = OwnedHeaders.view(&selectedOwner)
    if !run redirectResolvedIs(selected.current, &selectedHeaders, 128, selected.expected) {
      return false
    }
    locationIndex = locationIndex + usize.ONE
  }
  let relativeOwner = run redirectHeaders(b"../b?x")
  let relativeHeaders = OwnedHeaders.view(&relativeOwner)
  let resolvedBytes = String.byteLength("https://example/b?x#old")
  if !redirectLimitFailureIs(run redirectResolve(
    "https://example/a#old",
    &relativeHeaders,
    resolvedBytes - usize.ONE,
  ), RedirectComponent.Uri, RedirectLimit.UriBytes, resolvedBytes - usize.ONE, resolvedBytes,
    usize.ONE, Option.some<u16>(302)) { return false }

  let noEntries: [Header<'static>; 0] = []
  let noHeaders = run redirectTakeValue(Headers.make(&noEntries, redirectHeaderLimits()))
  let requestUri = run redirectTakeParse(Uri.parse("https://example/a#start"))
  let request = RedirectRequest {
    uri: requestUri,
    method: Method.post(),
    headers: noHeaders,
    headerPolicy: HeaderPolicy.defaults(),
    version: Version.Http11,
    continuePolicy: ContinuePolicy.Disabled,
    limits: redirectHeaderLimits(),
    maxHeadBytes: 512,
    maxCredentialBytes: 128,
  }
  if Uri.format(&request.uri) != "https://example/a#start"
    || Method.format(&request.method) != "POST" { return false }
  let ownedContextUri = run requestUri.copy()
  let nextContextUri = run redirectTakeParse(Uri.parse("https://next.example/b#next"))
  let ownedNextUri = run nextContextUri.copy()
  let ownedContext = RedirectContext {
    hop: 3,
    status: Option.some<Status>(redirectStatus(302)),
    currentUri: Option.some<OwnedUri>(move ownedContextUri),
    nextUri: Option.some<OwnedUri>(move ownedNextUri),
  }
  drop request
  let currentContextCopied = match & ownedContext.currentUri {
    Option.None => false
    Option.Some {value} => redirectOwnedUriIs(&value, "https://example/a#start")
  }
  let nextContextCopied = match & ownedContext.nextUri {
    Option.None => false
    Option.Some {value} => redirectOwnedUriIs(&value, "https://next.example/b#next")
  }
  if !currentContextCopied || !nextContextCopied
    || !redirectContextIs(move ownedContext, 3, Option.some<u16>(302), true, true) {
    return false
  }
  if !redirectFailureIs(run redirectResolve("https://example/a", &noHeaders, 128),
    RedirectComponent.Location, RedirectReasonTag.LocationMissing, usize.ONE,
    Option.some<u16>(302)) { return false }
  let duplicates = [run redirectHeader("Location", b"/a"), run redirectHeader("location", b"/b")]
  let duplicateHeaders = run redirectTakeValue(Headers.make(&duplicates, redirectHeaderLimits()))
  if !redirectFailureIs(run redirectResolve("https://example/a", &duplicateHeaders, 128),
    RedirectComponent.Location, RedirectReasonTag.LocationAmbiguous, usize.ONE,
    Option.some<u16>(302)) { return false }
  let invalidOwner = run redirectHeaders(b"/%")
  let invalidHeaders = OwnedHeaders.view(&invalidOwner)
  if !redirectFailureIs(run redirectResolve("https://example/a", &invalidHeaders, 128),
    RedirectComponent.Location, RedirectReasonTag.LocationInvalid, usize.ONE,
    Option.some<u16>(302)) { return false }
  let schemeOwner = run redirectHeaders(b"ftp://example/a")
  let schemeHeaders = OwnedHeaders.view(&schemeOwner)
  if !redirectFailureIs(run redirectResolve("https://example/a", &schemeHeaders, 128),
    RedirectComponent.Origin, RedirectReasonTag.RedirectSchemeDenied, usize.ONE,
    Option.some<u16>(302)) { return false }

  let exactUri = "https://b.example/"
  let exactOwner = run redirectHeaders(String.utf8Bytes(exactUri))
  let exactHeaders = OwnedHeaders.view(&exactOwner)
  if !run redirectResolvedIs(
    "https://example/a",
    &exactHeaders,
    String.byteLength(exactUri),
    exactUri,
  ) { return false }
  let current = run redirectTakeParse(Uri.parse("https://example/a"))
  let status = redirectStatus(302)
  if !redirectLimitFailureIs(run resolveLocation(
    &current,
    &exactHeaders,
    HistoryLimits {
      maxHops: 2,
      maxUriBytes: String.byteLength(exactUri) - usize.ONE,
      maxHistoryBytes: 4096,
    },
    usize.ONE,
    status,
  ), RedirectComponent.Location, RedirectLimit.UriBytes,
    String.byteLength(exactUri) - usize.ONE, String.byteLength(exactUri),
    usize.ONE, Option.some<u16>(302)) {
    return false
  }

  let firstUri = run redirectTakeParse(Uri.parse("https://EXAMPLE.com/a"))
  let sameTarget = run redirectTakeParse(Uri.parse("https://example.com:443/a#ignored"))
  let firstOrigin = run redirectTakeOrigin(Origin.fromUri(&firstUri))
  let equivalentOrigin = run redirectTakeOrigin(Origin.fromUri(&sameTarget))
  let historyLimits = HistoryLimits {maxHops: 2, maxUriBytes: 128, maxHistoryBytes: 4096}
  let mut history = run redirectTakeRedirect(run History.make(historyLimits))
  let insertedPost = run redirectTakeRedirect(
    run History.insert(&mut history, Method.post(), firstOrigin, &firstUri),
  )
  let insertedGet = run redirectTakeRedirect(
    run History.insert(&mut history, Method.get(), firstOrigin, &firstUri),
  )
  if !redirectFailureIs(
    run History.insert(&mut history, Method.get(), equivalentOrigin, &sameTarget),
    RedirectComponent.History,
    RedirectReasonTag.RedirectLoop,
    usize.ONE,
    Option.none<u16>(),
  ) { return false }

  let singleLimits = HistoryLimits {maxHops: usize.ZERO, maxUriBytes: 128, maxHistoryBytes: 4096}
  let mut probeHistory = run redirectTakeRedirect(run History.make(singleLimits))
  let insertedProbe = run redirectTakeRedirect(
    run History.insert(&mut probeHistory, Method.get(), firstOrigin, &firstUri),
  )
  let exactHistoryBytes = History.ownedBytes(&probeHistory)
  let mut exactHistory = run redirectTakeRedirect(run History.make(HistoryLimits {
    maxHops: usize.ZERO,
    maxUriBytes: 128,
    maxHistoryBytes: exactHistoryBytes,
  }))
  let insertedExact = run redirectTakeRedirect(
    run History.insert(&mut exactHistory, Method.get(), firstOrigin, &firstUri),
  )
  if History.ownedBytes(&exactHistory) != exactHistoryBytes { return false }
  let secondUri = run redirectTakeParse(Uri.parse("https://example.com/b"))
  if !redirectLimitFailureIs(
    run History.insert(&mut exactHistory, Method.get(), firstOrigin, &secondUri),
    RedirectComponent.History,
    RedirectLimit.HistoryEntries,
    usize.ONE,
    2,
    usize.ZERO,
    Option.none<u16>(),
  ) { return false }
  let mut belowHistory = run redirectTakeRedirect(run History.make(HistoryLimits {
    maxHops: usize.ZERO,
    maxUriBytes: 128,
    maxHistoryBytes: exactHistoryBytes - usize.ONE,
  }))
  if !redirectLimitFailureIs(
    run History.insert(&mut belowHistory, Method.get(), firstOrigin, &firstUri),
    RedirectComponent.History,
    RedirectLimit.HistoryBytes,
    exactHistoryBytes - usize.ONE,
    exactHistoryBytes,
    usize.ZERO,
    Option.none<u16>(),
  ) { return false }

  let safeNames = ["authorization", "cookie", "origin", "referer", "proxy-authorization", "x-safe"]
  let sensitiveNames = ["accept-language"]
  let listLimits = NameListLimits {maxNames: 8, maxNameBytes: 32, maxOwnedBytes: 1024}
  let safe = run redirectTakeRedirect(run NameList.copy(&safeNames, listLimits))
  let sensitive = run redirectTakeRedirect(run NameList.copy(&sensitiveNames, listLimits))
  let policy = run redirectTakeRedirect(RedirectPolicy.make(
    RedirectMode.Follow,
    historyLimits,
    CrossOriginPolicy.Allow,
    DowngradePolicy.Allow,
    Post301302Policy.Preserve,
    PreviousResponsePolicy.Close,
    move safe,
    move sensitive,
  ))
  let fields = [
    run redirectHeader("Connection", b"X-Hop"),
    run redirectHeader("X-Hop", b"remove"),
    run redirectHeader("Host", b"old.example"),
    run redirectHeader("Keep-Alive", b"timeout=5"),
    run redirectHeader("TE", b"trailers"),
    run redirectHeader("Trailer", b"X-End"),
    run redirectHeader("Transfer-Encoding", b"chunked"),
    run redirectHeader("Upgrade", b"websocket"),
    run redirectHeader("Proxy-Connection", b"keep-alive"),
    run redirectHeader("Proxy-Authorization", b"proxy-secret"),
    run redirectHeader("Authorization", b"origin-secret"),
    run redirectHeader("Cookie", b"cookie-secret"),
    run redirectHeader("Origin", b"https://old.example"),
    run redirectHeader("Referer", b"https://old.example/a"),
    run redirectHeader("X-Safe", b"safe-value"),
    run redirectHeader("x-safe", b"second"),
    run redirectHeader("Accept-Encoding", b"gzip"),
    run redirectHeader("Accept-Language", b"en"),
    run redirectHeader("Content-Type", b"text/plain"),
    run redirectHeader("Content-Encoding", b"identity"),
    run redirectHeader("Content-Language", b"en"),
    run redirectHeader("Content-Location", b"/old"),
    run redirectHeader("Digest", b"digest"),
    run redirectHeader("Content-Digest", b"content-digest"),
    run redirectHeader("Repr-Digest", b"repr-digest"),
    run redirectHeader("Expect", b"100-continue"),
    run redirectHeader("Content-Length", b"1"),
  ]
  let headers = run redirectTakeValue(Headers.make(&fields, redirectHeaderLimits()))
  let crossOwned = run redirectTakeValue(run sanitizeHeaders(
    &headers,
    &policy,
    true,
    BodyDecision.Retain,
    redirectHeaderLimits(),
  ))
  let cross = OwnedHeaders.view(&crossOwned)
  let mut retainOutput: [u8; 135] = [${Array.from({ length: 135 }, () => 0).join(', ')}]
  if !redirectFormattedIs(
    &cross,
    &mut retainOutput,
    b"X-Safe: safe-value\\r\\nx-safe: second\\r\\nAccept-Encoding: gzip\\r\\nContent-Type: text/plain\\r\\nContent-Encoding: identity\\r\\nContent-Language: en\\r\\n",
  ) { return false }

  let droppedOwned = run redirectTakeValue(run sanitizeHeaders(
    &headers,
    &policy,
    true,
    BodyDecision.Drop,
    redirectHeaderLimits(),
  ))
  let dropped = OwnedHeaders.view(&droppedOwned)
  let mut dropOutput: [u8; 59] = [${Array.from({ length: 59 }, () => 0).join(', ')}]
  if !redirectFormattedIs(
    &dropped,
    &mut dropOutput,
    b"X-Safe: safe-value\\r\\nx-safe: second\\r\\nAccept-Encoding: gzip\\r\\n",
  ) { return false }
  return true
}`

/** Pure redirect-policy and allocation-backed behavior checks. */
const httpRedirectBehaviorSentinel = `${httpRedirectBehaviorSupport}
${redirectPolicyCompileWitness}
${verifyRedirectPolicy}`

/**
 * The redirect policy program shared by native and LLVM-to-Wasm acceptance: admitted policy
 * values, status and method transitions, origin and downgrade rules, location resolution, header
 * sanitization, and bounded history, plus every public redirect operation driven through a
 * client that rejects acquisition, and the pool declarations. Nothing acquires a connection. The
 * replay row witness stays analysis-only: native and wasm32 emission of it fails (JUL-252).
 */
export const httpRedirectAcceptanceSource = `${httpProxyPolicyCommonImports}
import silk.http {Status}
import silk.http_request {Authorization, BasicSecurity, HeaderControl}
${httpRedirectPolicyImports}
${httpConnectionPoolPolicyImports}
${httpRedirectOperationSupport}
${httpRedirectOperationContractSupport}
${httpRedirectBehaviorSentinel}
${httpConnectionPoolPolicySupport}

struct RedirectFactoryRequirementProvider {}
struct RedirectProducerRequirementProvider {}
struct RedirectCallbackRequirementProvider {}
struct RedirectAcquisitionRequirementProvider {}
struct RedirectClockProvider {}
struct RedirectRandomProvider {}

impl RedirectFactoryRequirement for RedirectFactoryRequirementProvider {}
impl RedirectProducerRequirement for RedirectProducerRequirementProvider {}
impl RedirectCallbackRequirement for RedirectCallbackRequirementProvider {
  effect fn accepted(self: &mut Self) -> bool { return true }
}
impl RedirectAcquisitionRequirement for RedirectAcquisitionRequirementProvider {
  effect fn accepted(self: &mut Self) -> bool { return true }
}
impl MonotonicClock for RedirectClockProvider {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () {
    drop self
    drop when
    return ()
  }
  effect fn waitFor(self: &mut Self, duration: u64) -> () {
    drop self
    drop duration
    return ()
  }
}
impl Random for RedirectRandomProvider {
  effect fn fillBytes(self: &mut Self, output: &mut [u8]) -> () {
    drop self
    let mut index = usize.ZERO
    while index < output.length {
      output[index] = 0
      index = index + usize.ONE
    }
    return ()
  }
}

effect fn recoverRedirectPolicy(
  error: OutOfMemoryError | RedirectError | ValueError | RedirectParseError | RedirectOriginError,
) -> bool {
  drop error
  return false
}

effect fn recoverRedirectBaseContract(
  error: RedirectError
    | ValueError
    | RedirectCallbackFailure
    | ClientError
    | OutOfMemoryError
    | RedirectAcquisitionFailure,
) -> i32 {
  return match move error {
    RedirectAcquisitionFailure cause => match move cause { RedirectAcquisitionFailure.Rejected => 17 }
    _ => -1
  }
}

effect fn recoverRedirectOneShotContract(
  error: RedirectError
    | ValueError
    | RedirectProducerFailure
    | RedirectCallbackFailure
    | ClientError
    | OutOfMemoryError
    | RedirectAcquisitionFailure,
) -> i32 {
  return match move error {
    RedirectAcquisitionFailure cause => match move cause { RedirectAcquisitionFailure.Rejected => 17 }
    _ => -1
  }
}

effect fn recoverRedirectReplayContract(
  error: RedirectError
    | ValueError
    | RedirectFactoryFailure
    | RedirectProducerFailure
    | RedirectCallbackFailure
    | ClientError
    | OutOfMemoryError
    | RedirectAcquisitionFailure,
) -> i32 {
  return match move error {
    RedirectAcquisitionFailure cause => match move cause { RedirectAcquisitionFailure.Rejected => 17 }
    _ => -1
  }
}

pub fn main() -> i32 {
  if redirectPolicyCompileWitness() != 0 { return 1 }
  if !poolDeclarationsWitness() { return 2 }
  let mut allocator = Allocator.systemAllocatorProvider()
  let verified = run Effect.catchAll(verifyRedirectPolicy(), recoverRedirectPolicy)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if !verified { return 3 }
  let mut factoryRequirement = RedirectFactoryRequirementProvider {}
  let mut producerRequirement = RedirectProducerRequirementProvider {}
  let mut callbackRequirement = RedirectCallbackRequirementProvider {}
  let mut acquisitionRequirement = RedirectAcquisitionRequirementProvider {}
  let mut clock = RedirectClockProvider {}
  let mut random = RedirectRandomProvider {}
  let operationPolicy = RedirectPolicy.defaults()
  let operationEntries: [Header<'static>; 0] = []
  let operationHeaders = match move Headers.make(&operationEntries, redirectHeaderLimits()) {
    Result.Failure {error} => {
      drop error
      return 5
    }
    Result.Success {value} => value
  }
  let operationUri = match move Uri.parse("https://example/a") {
    Result.Failure {error} => {
      drop error
      return 6
    }
    Result.Success {value} => value
  }
  let mut operationClient = RedirectRejectingClient<never, never> {policy: &operationPolicy}
  let mut operationScratch: [u8; 1] = [0]
  let emptyContract = redirectEmptyContractWitness(
    &mut operationClient,
    redirectOperationRequest(operationUri, operationHeaders),
    &operationPolicy,
    &mut operationScratch,
  )
    |> Effect.provideMut<RedirectCallbackRequirement>(&mut callbackRequirement)
    |> Effect.provideMut<RedirectAcquisitionRequirement>(&mut acquisitionRequirement)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.provideMut<Random>(&mut random)
  let emptyWitness = run Effect.catchAll(move emptyContract, recoverRedirectBaseContract)
  if emptyWitness != 17 { return 7 }
  let bytesContract = redirectBytesContractWitness(
    &mut operationClient,
    redirectOperationRequest(operationUri, operationHeaders),
    &operationPolicy,
    b"x",
    &mut operationScratch,
  )
    |> Effect.provideMut<RedirectCallbackRequirement>(&mut callbackRequirement)
    |> Effect.provideMut<RedirectAcquisitionRequirement>(&mut acquisitionRequirement)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.provideMut<Random>(&mut random)
  let bytesWitness = run Effect.catchAll(move bytesContract, recoverRedirectBaseContract)
  if bytesWitness != 17 { return 8 }
  let mut producerClient = RedirectRejectingClient<RedirectProducerFailure, &mut RedirectProducerRequirement> {policy: &operationPolicy}
  let oneShotContract = redirectOneShotContractWitness(
    &mut producerClient,
    redirectOperationRequest(operationUri, operationHeaders),
    &operationPolicy,
    RedirectProducer {offset: usize.ZERO},
    &mut operationScratch,
  )
    |> Effect.provideMut<RedirectProducerRequirement>(&mut producerRequirement)
    |> Effect.provideMut<RedirectCallbackRequirement>(&mut callbackRequirement)
    |> Effect.provideMut<RedirectAcquisitionRequirement>(&mut acquisitionRequirement)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.provideMut<Random>(&mut random)
  let oneShotWitness = run Effect.catchAll(move oneShotContract, recoverRedirectOneShotContract)
  if oneShotWitness != 17 { return 9 }
  let replayContract = redirectReplayContractWitness(
    &mut producerClient,
    redirectOperationRequest(operationUri, operationHeaders),
    &operationPolicy,
    RedirectFactory {},
    &mut operationScratch,
  )
    |> Effect.provideMut<RedirectFactoryRequirement>(&mut factoryRequirement)
    |> Effect.provideMut<RedirectProducerRequirement>(&mut producerRequirement)
    |> Effect.provideMut<RedirectCallbackRequirement>(&mut callbackRequirement)
    |> Effect.provideMut<RedirectAcquisitionRequirement>(&mut acquisitionRequirement)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.provideMut<Random>(&mut random)
  let replayContractWitness = run Effect.catchAll(move replayContract, recoverRedirectReplayContract)
  if replayContractWitness != 17 { return 10 }
  return 0
}`

export const httpRedirectPolicySupport = `${httpRedirectOperationSupport}
${httpRedirectOperationContractSupport}
${httpRedirectBehaviorSupport}`

export const httpRedirectAffineEscapeDiagnosticSource = `effect fn redirectEscapingProducerUse(
  producer: RedirectDiagnosticProducer,
) -> &'static mut RedirectDiagnosticProducer {
  let use = effect fn(
    producer: &mut RedirectDiagnosticProducer,
  ) -> &'static mut RedirectDiagnosticProducer {
    return move producer
  }
  let release = effect fn(producer: &mut RedirectDiagnosticProducer) -> () {
    drop producer
    return ()
  }
  return run Effect.useReleaseNonParking(move producer, move use, move release)
}`

export const httpRedirectResponseEscapeDiagnosticSource = `struct RedirectEscapedUri<'escape> {
  uri: Uri<'escape>
}

struct RedirectEscapingUriUse {}

impl ResponseHandler<
  RedirectWitnessTransport,
  RedirectEscapedUri<'static>,
  never ? never
> for RedirectEscapingUriUse {
  effect<'call> fn handle<
    'call,
    'exchangeView: 'call,
    'transport: 'exchangeView,
    'provider: 'transport,
    'tunnel: 'provider,
  >(
    handler: &mut Self,
    uri: Uri<'call>,
    hop: usize,
    exchange: &'call mut Exchange<'exchangeView, RouteTransport<
      'transport,
      'provider,
      'tunnel,
      RedirectWitnessTransport,
    >>,
  ) -> RedirectEscapedUri<'static>
  where
    &mut RedirectWitnessTransport provides &HttpTransport from &mut HttpTransport | &mut MonotonicClock | &mut Allocator | &mut Random,
    &mut RedirectWitnessTransport provides &HttpTransport from &mut HttpTransport,
    &mut RedirectWitnessTransport provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock | &mut Allocator | &mut Random,
    &mut RedirectWitnessTransport provides &ByteDuplex from &mut ByteDuplex {
    drop handler
    drop hop
    drop exchange
    return RedirectEscapedUri<'static> {uri: move uri}
  }
}

struct RedirectEscapedExchange<
  'escape,
  'exchangeView: 'escape,
  'transport: 'exchangeView,
  'provider: 'transport,
  'tunnel: 'provider,
> {
  exchange: &'escape mut Exchange<'exchangeView, RouteTransport<
    'transport,
    'provider,
    'tunnel,
    RedirectWitnessTransport,
  >>
}

struct RedirectEscapingExchangeUse {}

impl ResponseHandler<
  RedirectWitnessTransport,
  RedirectEscapedExchange<'static, 'static, 'static, 'static, 'static>,
  never ? never
> for RedirectEscapingExchangeUse {
  effect<'call> fn handle<
    'call,
    'exchangeView: 'call,
    'transport: 'exchangeView,
    'provider: 'transport,
    'tunnel: 'provider,
  >(
    handler: &mut Self,
    uri: Uri<'call>,
    hop: usize,
    exchange: &'call mut Exchange<'exchangeView, RouteTransport<
      'transport,
      'provider,
      'tunnel,
      RedirectWitnessTransport,
    >>,
  ) -> RedirectEscapedExchange<'static, 'static, 'static, 'static, 'static>
  where
    &mut RedirectWitnessTransport provides &HttpTransport from &mut HttpTransport | &mut MonotonicClock | &mut Allocator | &mut Random,
    &mut RedirectWitnessTransport provides &HttpTransport from &mut HttpTransport,
    &mut RedirectWitnessTransport provides &ByteDuplex from &mut ByteDuplex | &mut MonotonicClock | &mut Allocator | &mut Random,
    &mut RedirectWitnessTransport provides &ByteDuplex from &mut ByteDuplex {
    drop handler
    drop uri
    drop hop
    return RedirectEscapedExchange<'static, 'static, 'static, 'static, 'static> {
      exchange: move exchange,
    }
  }
}`

export const httpRedirectAffineDuplicationDiagnosticSource = `effect fn redirectDuplicateOneShot(
  producer: RedirectProducer,
) -> i32
! RedirectError
  | ValueError
  | RedirectParseError
  | RedirectProducerFailure
  | RedirectCallbackFailure
  | ClientError
  | OutOfMemoryError
  | RedirectAcquisitionFailure
? &mut RedirectProducerRequirement
  | &mut RedirectCallbackRequirement
  | &mut RedirectAcquisitionRequirement
  | &mut MonotonicClock
  | &mut Allocator
  | &mut Random {
  let entries: [Header<'static>; 0] = []
  let headers = run redirectTakeValue(Headers.make(&entries, redirectHeaderLimits()))
  let uri = run redirectTakeParse(Uri.parse("https://example/a"))
  let policy = RedirectPolicy.defaults()
  let mut client = RedirectRejectingClient<RedirectProducerFailure, &mut RedirectProducerRequirement> {policy: &policy}
  let mut scratch: [u8; 1] = [0]
  let first = run withOneShotResponse(
    &mut client,
    redirectOperationRequest(uri, headers),
    &policy,
    move producer,
    Option.none<Instant>(),
    &mut scratch,
    RedirectFinalUse {},
  )
  drop first
  return run withOneShotResponse(
    &mut client,
    redirectOperationRequest(uri, headers),
    &policy,
    move producer,
    Option.none<Instant>(),
    &mut scratch,
    RedirectFinalUse {},
  )
}`

/**
 * One frontend snapshot for the native pool copy and fetch witnesses, which need libc-backed
 * contexts the shared runtime program cannot build, and for the three escape and duplication
 * programs that must be rejected.
 */
export const httpRedirectPolicyAnalysisSource = `${httpProxyPolicyCommonImports}
import silk.http {Status}
${httpRedirectPolicyImports}
${httpConnectionPoolPolicyImports}
${httpNativePoolImports}
${httpFetchPolicyImports}
${httpRedirectPolicySupport}
${httpConnectionPoolPolicySupport}
${nativePoolCopyWitness}
${httpFetchPolicySupport}

struct RedirectDiagnosticProducer {}

${httpRedirectResponseEscapeDiagnosticSource}

${httpRedirectAffineEscapeDiagnosticSource}

${httpRedirectAffineDuplicationDiagnosticSource}

pub fn main() -> i32 { return 42 }`
