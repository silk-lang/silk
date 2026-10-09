export const networkAddressValueAcceptanceSource = `
fn sameText(value: &Ipv4Address, expected: &[u8]) -> bool {
  let mut output: [u8; 15] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  return match move Ipv4Address.formatInto(value, &mut output) {
    Result<usize, AddressError>.Failure {error} => false
    Result<usize, AddressError>.Success {value: count} => {
      if count != expected.length { return false }
      let mut index = usize.ZERO
      while index < count {
        if output[index] != expected[index] { return false }
        index = index + usize.ONE
      }
      return true
    }
  }
}
fn sameV6Text(value: &Ipv6Address, expected: &[u8]) -> bool {
  let mut output: [u8; 39] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  return match move Ipv6Address.formatInto(value, &mut output) {
    Result<usize, AddressError>.Failure {error} => false
    Result<usize, AddressError>.Success {value: count} => {
      if count != expected.length { return false }
      let mut index = usize.ZERO
      while index < count {
        if output[index] != expected[index] { return false }
        index = index + usize.ONE
      }
      return true
    }
  }
}
fn acceptedV4(input: &[u8], expected: &[u8]) -> bool {
  return match move Ipv4Address.parse(input) {
    Result<Ipv4Address, AddressError>.Failure {error} => false
    Result<Ipv4Address, AddressError>.Success {value} => sameText(&value, expected)
  }
}
fn rejectedV4(input: &[u8]) -> bool {
  return match move Ipv4Address.parse(input) {
    Result<Ipv4Address, AddressError>.Failure {error} => true
    Result<Ipv4Address, AddressError>.Success {value} => false
  }
}
fn acceptedV6(input: &[u8], expected: &[u8]) -> bool {
  return match move Ipv6Address.parse(input) {
    Result<Ipv6Address, AddressError>.Failure {error} => false
    Result<Ipv6Address, AddressError>.Success {value} => sameV6Text(&value, expected)
  }
}
fn rejectedV6(input: &[u8]) -> bool {
  return match move Ipv6Address.parse(input) {
    Result<Ipv6Address, AddressError>.Failure {error} => true
    Result<Ipv6Address, AddressError>.Success {value} => false
  }
}
fn acceptedDomain(input: &[u8]) -> bool {
  return match move DomainHost.make(input) {
    Result<DomainHost, AddressError>.Failure {error} => false
    Result<DomainHost, AddressError>.Success {value} => DomainHost.length(&value) == input.length
  }
}
fn rejectedDomain(input: &[u8]) -> bool {
  return match move DomainHost.make(input) {
    Result<DomainHost, AddressError>.Failure {error} => true
    Result<DomainHost, AddressError>.Success {value} => false
  }
}
fn invalidALabel(input: &[u8], expectedOffset: usize) -> bool {
  return match move DomainHost.make(input) {
    Result<DomainHost, AddressError>.Success {value} => false
    Result<DomainHost, AddressError>.Failure {error} => match move error {
      AddressError.InvalidHost {reason, offset} => match move reason {
        HostReason.InvalidALabel => offset == expectedOffset
        _ => false
      }
      _ => false
    }
  }
}
fn sameDomainBytes(value: &DomainHost, expected: &[u8]) -> bool {
  let bytes = DomainHost.bytes(value)
  if bytes.length != expected.length { return false }
  let mut index = usize.ZERO
  while index < bytes.length {
    if bytes[index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}
pub fn main() -> i32 {
  if !acceptedV4(b"0.0.0.0", b"0.0.0.0") { return 1 }
  if !acceptedV4(b"192.0.2.255", b"192.0.2.255") { return 2 }
  if !rejectedV4(b"127.1") || !rejectedV4(b"2130706433") || !rejectedV4(b"0x7f.0.0.1") { return 3 }
  if !rejectedV4(b"01.2.3.4") || !rejectedV4(b"256.0.0.1") || !rejectedV4(b"1.2.3.4.5") { return 4 }
  if !acceptedV6(b"2001:0DB8:0:0:0:0:0:1", b"2001:db8::1") { return 5 }
  if !acceptedV6(b"2001:db8::1", b"2001:db8::1") { return 6 }
  if !acceptedV6(b"::ffff:192.0.2.1", b"::ffff:c000:201") { return 7 }
  if !acceptedV6(b"2001:0:0:1:0:0:1:1", b"2001::1:0:0:1:1") { return 8 }
  if !acceptedV6(b"2001:db8:0:1:1:1:1:1", b"2001:db8:0:1:1:1:1:1") { return 9 }
  if !rejectedV6(b"2001:::1") || !rejectedV6(b"1::2::3") || !rejectedV6(b"1:2:3") { return 10 }
  if !acceptedDomain(b"Example.COM") || !acceptedDomain(b"intranet") || !acceptedDomain(b"\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x61\x2e\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x62\x2e\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x63\x2e\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64\x64") { return 11 }
  if !rejectedDomain(b"") || !rejectedDomain(b"a..b") || !rejectedDomain(b"example.") { return 12 }
  if !rejectedDomain(b"-a.example") || !rejectedDomain(b"a-.example") || !rejectedDomain(b"example.123") { return 13 }
  if !acceptedDomain(b"xn--bcher-kva.example") || !acceptedDomain(b"XN--BCHER-KVA.example") { return 26 }
  if !invalidALabel(b"xn---a.example", usize.ZERO) || !invalidALabel(b"a.xn--zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz", 2) { return 27 }
  let canonical = match move DomainHost.make(b"XN--BCHER-KVA.Example") {
    Result<DomainHost, AddressError>.Failure {error} => { return 28 }
    Result<DomainHost, AddressError>.Success {value} => value
  }
  if !sameDomainBytes(&canonical, b"XN--BCHER-KVA.Example") { return 29 }
  let canonicalPeer = match move DomainHost.make(b"xn--bcher-kva.example") {
    Result<DomainHost, AddressError>.Failure {error} => { return 30 }
    Result<DomainHost, AddressError>.Success {value} => value
  }
  if !DomainHost.equals(&canonical, &canonicalPeer) { return 31 }
  let upper = match move DomainHost.make(b"Example.COM") {
    Result<DomainHost, AddressError>.Failure {error} => { return 14 }
    Result<DomainHost, AddressError>.Success {value} => value
  }
  let lower = match move DomainHost.make(b"example.com") {
    Result<DomainHost, AddressError>.Failure {error} => { return 15 }
    Result<DomainHost, AddressError>.Success {value} => value
  }
  if !DomainHost.equals(&upper, &lower) { return 16 }
  let zero = Port.make(0)
  let maximum = Port.make(65535)
  let overflow = Port.make(65536)
  match move zero {
    Result<Port, AddressError>.Failure {error} => { return 17 }
    Result<Port, AddressError>.Success {value} => {
      if Port.value(&value) != 0 { return 18 }
    }
  }
  match move maximum {
    Result<Port, AddressError>.Failure {error} => { return 19 }
    Result<Port, AddressError>.Success {value} => {
      if Port.value(&value) != 65535 { return 20 }
    }
  }
  match move overflow {
    Result<Port, AddressError>.Success {value} => { return 21 }
    Result<Port, AddressError>.Failure {error} => {}
  }
  match move Host.parse(b"192.0.2.1") {
    Result<Host, AddressError>.Failure {error} => { return 22 }
    Result<Host, AddressError>.Success {value} => match move value {
      Host.Ipv4 {value: numericV4} => {}
      Host.Domain {value: wrongDomain} => { return 23 }
      Host.Ipv6 {value: wrongV6} => { return 23 }
    }
  }
  match move Host.parse(b"[::ffff:192.0.2.1]") {
    Result<Host, AddressError>.Failure {error} => { return 24 }
    Result<Host, AddressError>.Success {value} => match move value {
      Host.Ipv6 {value: numericV6} => {}
      Host.Domain {value: wrongDomain} => { return 25 }
      Host.Ipv4 {value: wrongV4} => { return 25 }
    }
  }
  return 42
}
`

export const networkAddressPortableCorpusSource = `
import silk.network_address {AddressError, DomainHost, Host, HostReason, Ipv4Address, Ipv6Address, Port}
import silk.result {Result}
import silk.usize

${networkAddressValueAcceptanceSource}
`

const resolverPolicyNativeSource = `
struct ProbeResolver { calls: usize }

impl Resolver for ProbeResolver {
  effect fn resolveDomain(
    self: &mut Self,
    request: &ResolveRequest,
    domain: &DomainHost,
  ) -> ResolvedEndpoints
  ! ResolverError | OutOfMemoryError
  ? &mut Allocator {
    self.calls = self.calls + usize.ONE
    let made = ResolvedEndpoints.make(64)
    let mut values = match move made {
      Result<ResolvedEndpoints, ResolverError>.Failure {error} => { fail move error }
      Result<ResolvedEndpoints, ResolverError>.Success {value} => move value
    }
    let port = ResolveRequest.port(request)
    let v6 = Endpoint.make(
      IpAddress.V6 {value: Ipv6Address.fromOctets([32, 1, 13, 184, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])},
      port,
    )
    let first = Endpoint.make(
      IpAddress.V4 {value: Ipv4Address.fromOctets([192, 0, 2, 10])},
      port,
    )
    let duplicate = Endpoint.make(
      IpAddress.V4 {value: Ipv4Address.fromOctets([192, 0, 2, 10])},
      port,
    )
    let second = Endpoint.make(
      IpAddress.V4 {value: Ipv4Address.fromOctets([192, 0, 2, 11])},
      port,
    )
    let firstAdmission = run ResolvedEndpoints.admit(&mut values, move v6)
    let secondAdmission = run ResolvedEndpoints.admit(&mut values, move first)
    let thirdAdmission = run ResolvedEndpoints.admit(&mut values, move duplicate)
    let fourthAdmission = run ResolvedEndpoints.admit(&mut values, move second)
    return move values
  }
}

struct ProbeClock { nowValue: Instant calls: usize }

impl MonotonicClock for ProbeClock {
  effect fn now(self: &mut Self) -> Instant {
    self.calls = self.calls + usize.ONE
    return SystemClock.make(
      SystemClock.seconds(&self.nowValue),
      SystemClock.nanoseconds(&self.nowValue),
    )
  }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { return () }
}

effect fn numericRequest(
  family: FamilySelection,
  deadline: Option<Instant>,
) -> ResolveRequest ! ResolverError {
  return match move ResolveRequest.make(
    Host.Ipv4 {value: Ipv4Address.fromOctets([192, 0, 2, 1])},
    Port.fromU16(443),
    move family,
    2,
    move deadline,
  ) {
    Result<ResolveRequest, ResolverError>.Failure {error} => { fail move error }
    Result<ResolveRequest, ResolverError>.Success {value} => move value
  }
}

effect fn domainRequest(family: FamilySelection, maximum: usize) -> ResolveRequest ! ResolverError {
  let domain = match move DomainHost.make(b"provider.invalid") {
    Result<DomainHost, AddressError>.Failure {error} => {
      drop error
      fail ResolverError.UnsupportedForm
    }
    Result<DomainHost, AddressError>.Success {value} => value
  }
  return match move ResolveRequest.make(
    Host.Domain {value: move domain},
    Port.fromU16(443),
    move family,
    maximum,
    Option.none<Instant>(),
  ) {
    Result<ResolveRequest, ResolverError>.Failure {error} => { fail move error }
    Result<ResolveRequest, ResolverError>.Success {value} => move value
  }
}

fn endpointIsV4(endpoint: &Endpoint, last: u8) -> bool {
  let expected = IpAddress.V4 {value: Ipv4Address.fromOctets([192, 0, 2, last])}
  let actual = Endpoint.address(endpoint)
  return IpAddress.equals(&actual, &expected)
}

fn limitOne(result: Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>) -> bool {
  return match move result {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => false
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.LimitExceeded {maximum} => maximum == usize.ONE
      _ => false
    }
  }
}

fn timedOut(result: Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>) -> bool {
  return match move result {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => {
      drop value
      return false
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.Timeout => { return true }
      _ => { return false }
    }
  }
}

fn noAddress(result: Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>) -> bool {
  return match move result {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => {
      drop value
      return false
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.NoAddress => { return true }
      _ => { return false }
    }
  }
}

effect fn policyProgram() -> i32
! ResolverError | OutOfMemoryError {
  let request = run numericRequest(
    FamilySelection.Any,
    Option.some<Instant>(SystemClock.make(20, 0)),
  )
  let mut resolver = ProbeResolver {calls: usize.ZERO}
  let mut clock = ProbeClock {nowValue: SystemClock.make(10, 0), calls: usize.ZERO}
  let mut allocator = Allocator.systemAllocatorProvider()
  let resolved = run Resolver.resolve(&request)
    |> Effect.provideMut<Resolver>(&mut resolver)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if ResolvedEndpoints.length(&resolved) != usize.ONE { return 1 }
  if resolver.calls != usize.ZERO { return 2 }
  if clock.calls != usize.ONE { return 3 }

  let equal = run numericRequest(
    FamilySelection.Any,
    Option.some<Instant>(SystemClock.make(20, 0)),
  )
  clock.nowValue = SystemClock.make(20, 0)
  let equalResult = run Effect.result(
    Resolver.resolve(&equal)
      |> Effect.provideMut<Resolver>(&mut resolver)
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !timedOut(move equalResult) { return 4 }

  let past = run numericRequest(
    FamilySelection.Any,
    Option.some<Instant>(SystemClock.make(20, 0)),
  )
  clock.nowValue = SystemClock.make(21, 0)
  let pastResult = run Effect.result(
    Resolver.resolve(&past)
      |> Effect.provideMut<Resolver>(&mut resolver)
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !timedOut(move pastResult) { return 5 }

  let filtered = run numericRequest(FamilySelection.V6, Option.none<Instant>())
  let filteredResult = run Effect.result(
    Resolver.resolve(&filtered)
      |> Effect.provideMut<Resolver>(&mut resolver)
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !noAddress(move filteredResult) { return 6 }
  if resolver.calls != usize.ZERO { return 7 }
  if clock.calls != 3 { return 8 }

  let domain = run domainRequest(FamilySelection.V4, 2)
  let normalized = run Resolver.resolve(&domain)
    |> Effect.provideMut<Resolver>(&mut resolver)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if ResolvedEndpoints.length(&normalized) != 2 { return 9 }
  if !endpointIsV4(&ResolvedEndpoints.get(&normalized, usize.ZERO), 10) { return 10 }
  if !endpointIsV4(&ResolvedEndpoints.get(&normalized, usize.ONE), 11) { return 11 }

  let bounded = run domainRequest(FamilySelection.V4, usize.ONE)
  let boundedResult = run Effect.result(
    Resolver.resolve(&bounded)
      |> Effect.provideMut<Resolver>(&mut resolver)
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  if !limitOne(move boundedResult) { return 12 }
  if resolver.calls != 2 { return 13 }
  return 42
}

`

export const nativeResolverAcceptanceSource = `
import silk.effect {Effect}

struct NativeProbeClock {}
impl MonotonicClock for NativeProbeClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { return () }
}

effect fn nativeProgram() -> i32
! ResolverError | OutOfMemoryError {
  let domain = match move DomainHost.make(b"intranet") {
    Result<DomainHost, AddressError>.Failure {error} => { return 0 }
    Result<DomainHost, AddressError>.Success {value} => value
  }
  let request = match move ResolveRequest.make(
    Host.Domain {value: move domain},
    Port.fromU16(443),
    FamilySelection.Any,
    4,
    Option.none<Instant>(),
  ) {
    Result<ResolveRequest, ResolverError>.Failure {error} => { fail move error }
    Result<ResolveRequest, ResolverError>.Success {value} => move value
  }
  let mut provider = NativeSystemResolver.make()
  let mut clock = NativeProbeClock {}
  let mut allocator = Allocator.systemAllocatorProvider()
  let resolved = run Resolver.resolve(&request)
    |> Effect.provideMut<Resolver>(&mut provider)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  return usize.toI32(ResolvedEndpoints.length(&resolved))
}

effect fn recoverNativeResolver(error: ResolverError) -> i32 ! OutOfMemoryError { return 0 }
effect fn recoverNativeAllocation(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 {
  return run nativeProgram()
    |> Effect.catch<ResolverError>(recoverNativeResolver)
    |> Effect.catchAll(recoverNativeAllocation)
}
`

const deadlineResolverProviderSource = `
unsafe extern "C" fn silk_deadline_stub_reset() -> ()
unsafe extern "C" fn silk_deadline_stub_mark_check() -> ()
unsafe extern "C" fn silk_deadline_stub_mark_work() -> ()
unsafe extern "C" fn silk_deadline_stub_mark_registration() -> ()
unsafe extern "C" fn silk_deadline_stub_mark_registration_drop() -> ()
unsafe extern "C" fn silk_deadline_stub_mark_result_drop() -> ()
unsafe extern "C" fn silk_deadline_stub_mark_ready() -> ()
unsafe extern "C" fn silk_deadline_stub_mark_complete() -> ()
unsafe extern "C" fn silk_deadline_stub_snapshot() -> i32

fn fixtureDeadlineReached(now: &Instant, deadline: &Instant) -> bool {
  let nowSeconds = SystemClock.seconds(now)
  let deadlineSeconds = SystemClock.seconds(deadline)
  if nowSeconds > deadlineSeconds { return true }
  if nowSeconds < deadlineSeconds { return false }
  return SystemClock.nanoseconds(now) >= SystemClock.nanoseconds(deadline)
}

struct HeldRegistration { wake: Intrinsic.Wake }
impl Drop for HeldRegistration {
  fn drop(self: &mut HeldRegistration) -> () {
    unsafe { silk_deadline_stub_mark_registration_drop() }
    return ()
  }
}
fn holdRegistration(wake: Intrinsic.Wake) -> HeldRegistration {
  unsafe { silk_deadline_stub_mark_registration() }
  return HeldRegistration {wake: move wake}
}
struct CompletedRegistration {}
impl Drop for CompletedRegistration {
  fn drop(self: &mut CompletedRegistration) -> () {
    unsafe { silk_deadline_stub_mark_registration_drop() }
    return ()
  }
}
fn completeRegistration(wake: Intrinsic.Wake) -> CompletedRegistration {
  unsafe { silk_deadline_stub_mark_registration() }
  Intrinsic.wake(move wake)
  return CompletedRegistration {}
}

struct ResultOwner { marker: i32 }
impl Drop for ResultOwner {
  fn drop(self: &mut ResultOwner) -> () {
    unsafe { silk_deadline_stub_mark_result_drop() }
    return ()
  }
}

struct DeterministicDeadlineResolver { nowValue: Instant complete: bool }
impl Resolver for DeterministicDeadlineResolver {
  effect fn resolveDomain(
    self: &mut Self,
    request: &ResolveRequest,
    domain: &DomainHost,
  ) -> ResolvedEndpoints
  ! ResolverError | OutOfMemoryError
  ? &mut Allocator {
    match move ResolveRequest.deadline(request) {
      Option<Instant>.None => { fail ResolverError.DeadlineUnsupported }
      Option<Instant>.Some {value: deadline} => {
        unsafe { silk_deadline_stub_mark_check() }
        if fixtureDeadlineReached(&self.nowValue, &deadline) { fail ResolverError.Timeout }
      }
    }
    unsafe { silk_deadline_stub_mark_work() }
    let resultOwner = ResultOwner {marker: 9}
    let made = ResolvedEndpoints.make(ResolveRequest.maxResults(request))
    let mut result = match move made {
      Result<ResolvedEndpoints, ResolverError>.Failure {error} => { fail move error }
      Result<ResolvedEndpoints, ResolverError>.Success {value} => move value
    }
    let admitted = run ResolvedEndpoints.admit(
      &mut result,
      Endpoint.make(
        IpAddress.V4 {value: Ipv4Address.fromOctets([192, 0, 2, 9])},
        ResolveRequest.port(request),
      ),
    )
    if self.complete {
      run Execution.park(completeRegistration)
    } else {
      run Execution.park(holdRegistration)
    }
    if resultOwner.marker != 9 { fail ResolverError.NoAddress }
    return move result
  }
}

struct DeadlineFixtureClock {}
impl MonotonicClock for DeadlineFixtureClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { return () }
}

effect fn fixtureRequest(deadline: Instant) -> ResolveRequest ! ResolverError {
  let domain = match move DomainHost.make(b"fixture.invalid") {
    Result<DomainHost, AddressError>.Failure {error} => { drop error fail ResolverError.UnsupportedForm }
    Result<DomainHost, AddressError>.Success {value} => value
  }
  return match move ResolveRequest.make(
    Host.Domain {value: domain},
    Port.fromU16(80),
    FamilySelection.Any,
    1,
    Option.some<Instant>(move deadline),
  ) {
    Result<ResolveRequest, ResolverError>.Failure {error} => { fail move error }
    Result<ResolveRequest, ResolverError>.Success {value} => move value
  }
}

effect fn deadlineBody(complete: bool) -> i32 ! ResolverError | OutOfMemoryError {
  let request = run fixtureRequest(SystemClock.make(10, 0))
  let mut resolver = DeterministicDeadlineResolver {
    nowValue: SystemClock.make(0, 0),
    complete: complete,
  }
  let mut clock = DeadlineFixtureClock {}
  let mut allocator = Allocator.systemAllocatorProvider()
  let result = run Resolver.resolve(&request)
    |> Effect.provideMut<Resolver>(&mut resolver)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
  return usize.toI32(ResolvedEndpoints.length(&result))
}

effect fn reachedDeadlineBody() -> i32 ! ResolverError | OutOfMemoryError {
  let request = run fixtureRequest(SystemClock.make(10, 0))
  let mut resolver = DeterministicDeadlineResolver {
    nowValue: SystemClock.make(10, 0),
    complete: false,
  }
  let mut clock = DeadlineFixtureClock {}
  let mut allocator = Allocator.systemAllocatorProvider()
  let reached = run Effect.result(
    Resolver.resolve(&request)
      |> Effect.provideMut<Resolver>(&mut resolver)
      |> Effect.provideMut<MonotonicClock>(&mut clock)
      |> Effect.provideMut<Allocator>(&mut allocator)
  )
  return match move reached {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 1 }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.Timeout => 42
      _ => 2
    }
  }
}

effect fn deadlineFailure(error: ResolverError | OutOfMemoryError) -> i32 { drop error return -1 }
fn deadlineReady(state: &()) -> () { unsafe { silk_deadline_stub_mark_ready() } return () }
fn deadlineComplete(state: &mut (), value: i32) -> () {
  drop value
  unsafe { silk_deadline_stub_mark_complete() }
  return ()
}
fn deadlineCancel(state: &mut (), execution: Intrinsic.Execution<i32>) -> () {
  drop move execution
  return ()
}

struct EmptyExecution {}
struct StoredExecution { execution: Intrinsic.Execution<i32> }
struct DeadlineOwner { slot: EmptyExecution | StoredExecution result: i32 }
fn deadlineStore(owner: &mut DeadlineOwner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, StoredExecution {execution: move execution})
  drop previous
  return ()
}
fn deadlineStoreComplete(owner: &mut DeadlineOwner, value: i32) -> () {
  owner.result = value
  unsafe { silk_deadline_stub_mark_complete() }
  return ()
}
effect fn driveDeadline(execution: Intrinsic.Execution<i32>, owner: &mut DeadlineOwner) -> () {
  return run Execution.drive(move execution, move owner, deadlineStoreComplete, deadlineStore)
}
effect fn driveStoredDeadline(selected: EmptyExecution | StoredExecution, owner: &mut DeadlineOwner) -> () {
  return match move selected {
    EmptyExecution {} => ()
    StoredExecution {execution} => run driveDeadline(move execution, move owner)
  }
}

effect fn deadlineCancellationProgram() -> i32 ! ResolverError | OutOfMemoryError {
  unsafe { silk_deadline_stub_reset() }
  let mut reachedAllocator = Allocator.systemAllocatorProvider()
  let reachedBody = Effect.catchAll(reachedDeadlineBody(), deadlineFailure)
  let mut reachedOwner = DeadlineOwner {slot: EmptyExecution {}, result: 0}
  let reachedExecution = run Execution.make(move reachedBody, (), deadlineReady)
    |> Effect.provideMut<Allocator>(&mut reachedAllocator)
  run driveDeadline(move reachedExecution, &mut reachedOwner)
  if reachedOwner.result != 42 { return 1 }
  if unsafe silk_deadline_stub_snapshot() != 10000010 { return 3 }

  unsafe { silk_deadline_stub_reset() }
  let body = Effect.catchAll(deadlineBody(false), deadlineFailure)
  let execution = run Execution.make(move body, (), deadlineReady)
    |> Effect.provideMut<Allocator>(&mut reachedAllocator)
  let mut branch = ()
  run Execution.drive(move execution, &mut branch, deadlineComplete, deadlineCancel)
  if unsafe silk_deadline_stub_snapshot() != 11111000 { return 4 }

  unsafe { silk_deadline_stub_reset() }
  let successBody = Effect.catchAll(deadlineBody(true), deadlineFailure)
  let mut owner = DeadlineOwner {slot: EmptyExecution {}, result: 0}
  let successExecution = run Execution.make(move successBody, (), deadlineReady)
    |> Effect.provideMut<Allocator>(&mut reachedAllocator)
  run driveDeadline(move successExecution, &mut owner)
  let stored = Intrinsic.replace(owner.slot, EmptyExecution {})
  run driveStoredDeadline(move stored, &mut owner)
  if owner.result != 1 { return 5 }
  if unsafe silk_deadline_stub_snapshot() != 11111110 { return 6 }
  return 42
}
`

export const deadlineResolverFixtureSource = `
import silk.effect {Effect}
import silk.execution {Execution}

${deadlineResolverProviderSource}

effect fn recoverDeadlineFixture(error: ResolverError | OutOfMemoryError) -> i32 { drop error return -1 }
pub fn main() -> i32 {
  return run deadlineCancellationProgram() |> Effect.catchAll(recoverDeadlineFixture)
}
`

export const nativeResolverStubSource = `
#include <arpa/inet.h>
#include <errno.h>
#include <netdb.h>
#include <stddef.h>
#include <string.h>

static int silk_mode = 0;
static int silk_calls = 0;
static int silk_frees = 0;
static int silk_arguments_ok = 0;
static int silk_deadline_check = 0;
static int silk_deadline_work = 0;
static int silk_deadline_registration = 0;
static int silk_deadline_registration_drop = 0;
static int silk_deadline_result_drop = 0;
static int silk_deadline_ready = 0;
static int silk_deadline_complete = 0;
static struct addrinfo silk_nodes[4];
static struct sockaddr_storage silk_addresses[4];

typedef int (*silk_getaddrinfo_signature)(
  const char *, const char *, const struct addrinfo *, struct addrinfo **
);
typedef void (*silk_freeaddrinfo_signature)(struct addrinfo *);
static silk_getaddrinfo_signature silk_getaddrinfo_typecheck = &getaddrinfo;
static silk_freeaddrinfo_signature silk_freeaddrinfo_typecheck = &freeaddrinfo;

_Static_assert(sizeof(socklen_t) == 4, "socklen_t width");
_Static_assert(sizeof(struct sockaddr_in) == 16, "sockaddr_in width");
_Static_assert(offsetof(struct sockaddr_in, sin_addr) == 4, "sockaddr_in address offset");
_Static_assert(sizeof(struct sockaddr_in6) == 28, "sockaddr_in6 width");
_Static_assert(offsetof(struct sockaddr_in6, sin6_addr) == 8, "sockaddr_in6 address offset");
_Static_assert(sizeof(struct addrinfo) == 48, "addrinfo width");
_Static_assert(_Alignof(struct addrinfo) == 8, "addrinfo alignment");
#if defined(__APPLE__)
_Static_assert(offsetof(struct addrinfo, ai_addrlen) == 16, "Darwin addrlen offset");
_Static_assert(offsetof(struct addrinfo, ai_canonname) == 24, "Darwin canonname offset");
_Static_assert(offsetof(struct addrinfo, ai_addr) == 32, "Darwin address offset");
_Static_assert(offsetof(struct addrinfo, ai_next) == 40, "Darwin next offset");
_Static_assert(AF_INET6 == 30, "Darwin AF_INET6");
_Static_assert(AI_NUMERICSERV == 4096, "Darwin AI_NUMERICSERV");
_Static_assert(EAI_AGAIN == 2 && EAI_FAMILY == 5 && EAI_MEMORY == 6 && EAI_NONAME == 8 && EAI_SYSTEM == 11, "Darwin EAI values");
#else
_Static_assert(offsetof(struct addrinfo, ai_addrlen) == 16, "GNU addrlen offset");
_Static_assert(offsetof(struct addrinfo, ai_addr) == 24, "GNU address offset");
_Static_assert(offsetof(struct addrinfo, ai_canonname) == 32, "GNU canonname offset");
_Static_assert(offsetof(struct addrinfo, ai_next) == 40, "GNU next offset");
_Static_assert(AF_INET6 == 10, "GNU AF_INET6");
_Static_assert(AI_NUMERICSERV == 1024, "GNU AI_NUMERICSERV");
_Static_assert(EAI_AGAIN == -3 && EAI_FAMILY == -6 && EAI_MEMORY == -10 && EAI_NONAME == -2 && EAI_SYSTEM == -11, "GNU EAI values");
#endif
_Static_assert(AF_INET == 2, "AF_INET");
_Static_assert(SOCK_STREAM == 1, "SOCK_STREAM");
_Static_assert(IPPROTO_TCP == 6, "IPPROTO_TCP");

void silk_resolver_stub_reset(int mode) {
  silk_mode = mode;
  silk_calls = 0;
  silk_frees = 0;
  silk_arguments_ok = 0;
  memset(silk_nodes, 0, sizeof(silk_nodes));
  memset(silk_addresses, 0, sizeof(silk_addresses));
}

int silk_resolver_stub_calls(void) { return silk_calls; }
int silk_resolver_stub_frees(void) { return silk_frees; }
int silk_resolver_stub_arguments_ok(void) { return silk_arguments_ok; }
int silk_resolver_stub_eai_system(void) { return EAI_SYSTEM; }
int silk_resolver_stub_errno_value(void) { return EIO; }

void silk_deadline_stub_reset(void) {
  silk_deadline_check = 0;
  silk_deadline_work = 0;
  silk_deadline_registration = 0;
  silk_deadline_registration_drop = 0;
  silk_deadline_result_drop = 0;
  silk_deadline_ready = 0;
  silk_deadline_complete = 0;
}
void silk_deadline_stub_mark_check(void) { silk_deadline_check += 1; }
void silk_deadline_stub_mark_work(void) { silk_deadline_work += 1; }
void silk_deadline_stub_mark_registration(void) { silk_deadline_registration += 1; }
void silk_deadline_stub_mark_registration_drop(void) { silk_deadline_registration_drop += 1; }
void silk_deadline_stub_mark_result_drop(void) { silk_deadline_result_drop += 1; }
void silk_deadline_stub_mark_ready(void) { silk_deadline_ready += 1; }
void silk_deadline_stub_mark_complete(void) { silk_deadline_complete += 1; }
int silk_deadline_stub_snapshot(void) {
  return silk_deadline_check * 10000000
    + silk_deadline_work * 1000000
    + silk_deadline_registration * 100000
    + silk_deadline_registration_drop * 10000
    + silk_deadline_result_drop * 1000
    + silk_deadline_ready * 100
    + silk_deadline_complete * 10;
}

static void silk_address(size_t index, unsigned last) {
  struct sockaddr_in *address = (struct sockaddr_in *)&silk_addresses[index];
  address->sin_family = AF_INET;
  address->sin_addr.s_addr = htonl(0xc0000200u + last);
  silk_nodes[index].ai_family = AF_INET;
  silk_nodes[index].ai_socktype = SOCK_STREAM;
  silk_nodes[index].ai_protocol = IPPROTO_TCP;
  silk_nodes[index].ai_addrlen = (socklen_t)sizeof(struct sockaddr_in);
  silk_nodes[index].ai_addr = (struct sockaddr *)address;
}

static void silk_address6(size_t index, unsigned last) {
  struct sockaddr_in6 *address = (struct sockaddr_in6 *)&silk_addresses[index];
  address->sin6_family = AF_INET6;
  address->sin6_addr.s6_addr[0] = 0x20;
  address->sin6_addr.s6_addr[1] = 0x01;
  address->sin6_addr.s6_addr[2] = 0x0d;
  address->sin6_addr.s6_addr[3] = 0xb8;
  address->sin6_addr.s6_addr[15] = (unsigned char)last;
  silk_nodes[index].ai_family = AF_INET6;
  silk_nodes[index].ai_socktype = SOCK_STREAM;
  silk_nodes[index].ai_protocol = IPPROTO_TCP;
  silk_nodes[index].ai_addrlen = (socklen_t)sizeof(struct sockaddr_in6);
  silk_nodes[index].ai_addr = (struct sockaddr *)address;
}

int getaddrinfo(
  const char *node,
  const char *service,
  const struct addrinfo *hints,
  struct addrinfo **result
) {
  silk_calls += 1;
  int expected_family = silk_mode == 11 ? AF_INET : (silk_mode == 12 ? AF_INET6 : AF_UNSPEC);
  silk_arguments_ok = node != NULL && strcmp(node, "intranet.") == 0
    && service != NULL && strcmp(service, "443") == 0
    && hints != NULL && hints->ai_family == expected_family
    && hints->ai_socktype == SOCK_STREAM && hints->ai_protocol == IPPROTO_TCP
    && (hints->ai_flags & AI_NUMERICSERV) != 0 && result != NULL;
  if (silk_mode == 3) {
    errno = EIO;
    return EAI_SYSTEM;
  }
  if (silk_mode == 7) return EAI_NONAME;
  if (silk_mode == 8) return EAI_AGAIN;
  if (silk_mode == 9) return EAI_FAMILY;
  if (silk_mode == 10) return EAI_MEMORY;
  if (silk_mode == 13) return 31337;
  if (silk_mode == 6) {
    *result = NULL;
    return 0;
  }
  if (silk_mode == 4) {
    silk_address(0, 1);
    silk_nodes[0].ai_family = 31337;
    *result = &silk_nodes[0];
    return 0;
  }
  if (silk_mode == 5) {
    silk_address(0, 1);
    silk_nodes[0].ai_addr = NULL;
    *result = &silk_nodes[0];
    return 0;
  }
  if (silk_mode == 11) {
    silk_address6(0, 1);
    silk_address(1, 2);
    silk_nodes[0].ai_next = &silk_nodes[1];
    *result = &silk_nodes[0];
    return 0;
  }
  if (silk_mode == 12) {
    silk_address(0, 1);
    silk_address6(1, 2);
    silk_nodes[0].ai_next = &silk_nodes[1];
    *result = &silk_nodes[0];
    return 0;
  }
  silk_address(0, 1);
  silk_address(1, silk_mode == 0 ? 1 : 2);
  silk_nodes[0].ai_next = &silk_nodes[1];
  if (silk_mode == 0) {
    silk_address(2, 2);
    silk_nodes[1].ai_next = &silk_nodes[2];
  }
  if (silk_mode == 1) {
    silk_nodes[1].ai_addrlen = 1;
  }
  if (silk_mode == 2) {
    silk_address(2, 3);
    silk_nodes[1].ai_next = &silk_nodes[2];
  }
  *result = &silk_nodes[0];
  return 0;
}

void freeaddrinfo(struct addrinfo *result) {
  if (result != NULL) silk_frees += 1;
}
`

export const nativeResolverStubAcceptanceSource = `
import silk.allocator {Allocator, OutOfMemoryError}
import silk.effect {Effect}
import silk.execution {Execution}
import silk.layout {Layout}
import silk.monotonic_clock {MonotonicClock}
import silk.native_resolver {NativeSystemResolver}
import silk.network_address {AddressError, DomainHost, Endpoint, Host, IpAddress, Ipv4Address, Ipv6Address, Port}
import silk.option {Option}
import silk.resolver {FamilySelection, NativeResolverOperation, NativeResultReason, ResolveRequest, ResolvedEndpoints, Resolver, ResolverError}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.u64
import silk.usize

${resolverPolicyNativeSource}

${deadlineResolverProviderSource}

unsafe extern "C" fn silk_resolver_stub_reset(mode: i32) -> ()
unsafe extern "C" fn silk_resolver_stub_calls() -> i32
unsafe extern "C" fn silk_resolver_stub_frees() -> i32
unsafe extern "C" fn silk_resolver_stub_arguments_ok() -> i32
unsafe extern "C" fn silk_resolver_stub_eai_system() -> i32
unsafe extern "C" fn silk_resolver_stub_errno_value() -> i32

struct StubClock {}
impl MonotonicClock for StubClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return 1 }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { return () }
}

struct RefusingAllocator {}
effect fn allocate(self: &mut RefusingAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  return run Allocator.outOfMemory()
}
impl Allocator for RefusingAllocator { allocate: RefusingAllocator.allocate }

effect fn request(
  family: FamilySelection,
  maximum: usize,
  deadline: Option<Instant>,
) -> ResolveRequest ! ResolverError {
  let domain = match move DomainHost.make(b"intranet") {
    Result<DomainHost, AddressError>.Failure {error} => {
      drop error
      fail ResolverError.UnsupportedForm
    }
    Result<DomainHost, AddressError>.Success {value} => value
  }
  return match move ResolveRequest.make(
    Host.Domain {value: move domain},
    Port.fromU16(443),
    move family,
    maximum,
    move deadline,
  ) {
    Result<ResolveRequest, ResolverError>.Failure {error} => { fail move error }
    Result<ResolveRequest, ResolverError>.Success {value} => move value
  }
}

effect fn resolveSystem(
  family: FamilySelection,
  maximum: usize,
  deadline: Option<Instant>,
) -> ResolvedEndpoints
! ResolverError | OutOfMemoryError {
  let admitted = run request(move family, maximum, move deadline)
  let mut resolver = NativeSystemResolver.make()
  let mut clock = StubClock {}
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Resolver.resolve(&admitted)
    |> Effect.provideMut<Resolver>(&mut resolver)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
}

effect fn resolveRefused() -> ResolvedEndpoints ! ResolverError | OutOfMemoryError {
  let admitted = run request(FamilySelection.Any, 2, Option.none<Instant>())
  let mut resolver = NativeSystemResolver.make()
  let mut clock = StubClock {}
  let mut allocator = RefusingAllocator {}
  return run Resolver.resolve(&admitted)
    |> Effect.provideMut<Resolver>(&mut resolver)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
    |> Effect.provideMut<Allocator>(&mut allocator)
}

fn counters(calls: i32, frees: i32, arguments: i32) -> bool {
  let observedCalls = unsafe silk_resolver_stub_calls()
  let observedFrees = unsafe silk_resolver_stub_frees()
  let observedArguments = unsafe silk_resolver_stub_arguments_ok()
  return observedCalls == calls && observedFrees == frees && observedArguments == arguments
}

effect fn nativeCases() -> i32 {
  let policy = run Effect.result(policyProgram())
  match move policy {
    Result<i32, ResolverError | OutOfMemoryError>.Failure {error} => {
      drop error
      return 21
    }
    Result<i32, ResolverError | OutOfMemoryError>.Success {value} => {
      if value != 42 { return 22 }
    }
  }

  unsafe { silk_resolver_stub_reset(0) }
  let success = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move success {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => {
      drop error
      return 1
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => {
      if ResolvedEndpoints.length(&value) != 2 { return 2 }
    }
  }
  if !counters(1, 1, 1) { return 3 }

  unsafe { silk_resolver_stub_reset(1) }
  let malformed = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move malformed {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => {
      drop value
      return 4
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.InvalidNativeResult {reason, index} => {
        if reason != NativeResultReason.ShortAddress || index != usize.ONE { return 5 }
      }
      _ => { return 5 }
    }
  }
  if !counters(1, 1, 1) { return 6 }

  unsafe { silk_resolver_stub_reset(2) }
  let limited = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move limited {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => {
      drop value
      return 7
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.LimitExceeded {maximum} => { if maximum != 2 { return 8 } }
      _ => { return 9 }
    }
  }
  if !counters(1, 1, 1) { return 10 }

  unsafe { silk_resolver_stub_reset(3) }
  let system = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move system {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => {
      drop value
      return 11
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.NativeFailure {operation, eai, errno} => match move errno {
        Option<i32>.None => { return 12 }
        Option<i32>.Some {value} => {
          if eai != unsafe silk_resolver_stub_eai_system() { return 12 }
          if value != unsafe silk_resolver_stub_errno_value() { return 12 }
          match move operation {
            NativeResolverOperation.GetAddrInfo => {}
          }
        }
      }
      _ => { return 13 }
    }
  }
  if !counters(1, 0, 1) { return 14 }

  unsafe { silk_resolver_stub_reset(0) }
  let deadline = run Effect.result(resolveSystem(
    FamilySelection.Any,
    2,
    Option.some<Instant>(SystemClock.make(10, 0)),
  ))
  match move deadline {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => {
      drop value
      return 15
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.DeadlineUnsupported => {}
      _ => { return 16 }
    }
  }
  if !counters(0, 0, 0) { return 17 }

  unsafe { silk_resolver_stub_reset(0) }
  let refused = run Effect.result(resolveRefused())
  match move refused {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => {
      drop value
      return 18
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      OutOfMemoryError {} => {}
      _ => { return 19 }
    }
  }
  if !counters(1, 1, 1) { return 20 }

  unsafe { silk_resolver_stub_reset(4) }
  let unknown = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move unknown {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 25 }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.InvalidNativeResult {reason, index} => {
        if reason != NativeResultReason.UnknownFamily || index != usize.ZERO { return 26 }
      }
      _ => { return 26 }
    }
  }
  if !counters(1, 1, 1) { return 27 }

  unsafe { silk_resolver_stub_reset(5) }
  let nullAddress = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move nullAddress {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 28 }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.InvalidNativeResult {reason, index} => {
        if reason != NativeResultReason.NullAddress || index != usize.ZERO { return 29 }
      }
      _ => { return 29 }
    }
  }
  if !counters(1, 1, 1) { return 30 }

  unsafe { silk_resolver_stub_reset(6) }
  let nullChain = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move nullChain {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 31 }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.InvalidNativeResult {reason, index} => {
        if reason != NativeResultReason.NullChain || index != usize.ZERO { return 32 }
      }
      _ => { return 32 }
    }
  }
  if !counters(1, 0, 1) { return 33 }

  unsafe { silk_resolver_stub_reset(7) }
  let noname = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move noname {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.NameNotFound => {}
      _ => { return 34 }
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 34 }
  }
  if !counters(1, 0, 1) { return 35 }

  unsafe { silk_resolver_stub_reset(8) }
  let again = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move again {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.TemporaryFailure => {}
      _ => { return 36 }
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 36 }
  }
  if !counters(1, 0, 1) { return 44 }

  unsafe { silk_resolver_stub_reset(9) }
  let family = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move family {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.FamilyUnsupported => {}
      _ => { return 37 }
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 37 }
  }
  if !counters(1, 0, 1) { return 45 }

  unsafe { silk_resolver_stub_reset(10) }
  let memory = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move memory {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.SystemResources => {}
      _ => { return 38 }
    }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 38 }
  }
  if !counters(1, 0, 1) { return 46 }

  unsafe { silk_resolver_stub_reset(13) }
  let unknownStatus = run Effect.result(resolveSystem(FamilySelection.Any, 2, Option.none<Instant>()))
  match move unknownStatus {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => { drop value return 47 }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => match move error {
      ResolverError.NativeFailure {operation, eai, errno} => {
        if eai != 31337 { return 48 }
        match move operation { NativeResolverOperation.GetAddrInfo => {} }
        match move errno {
          Option<i32>.None => {}
          Option<i32>.Some {value} => { return 48 }
        }
      }
      _ => { return 48 }
    }
  }
  if !counters(1, 0, 1) { return 49 }

  unsafe { silk_resolver_stub_reset(11) }
  let v4Result = run Effect.result(resolveSystem(FamilySelection.V4, 2, Option.none<Instant>()))
  let v4 = match move v4Result {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => { drop error return 39 }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => move value
  }
  if ResolvedEndpoints.length(&v4) != usize.ONE { return 39 }
  let v4Endpoint = ResolvedEndpoints.get(&v4, usize.ZERO)
  let v4Address = Endpoint.address(&v4Endpoint)
  if !IpAddress.isV4(&v4Address) || !counters(1, 1, 1) { return 40 }

  unsafe { silk_resolver_stub_reset(12) }
  let v6Result = run Effect.result(resolveSystem(FamilySelection.V6, 2, Option.none<Instant>()))
  let v6 = match move v6Result {
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Failure {error} => { drop error return 41 }
    Result<ResolvedEndpoints, ResolverError | OutOfMemoryError>.Success {value} => move value
  }
  if ResolvedEndpoints.length(&v6) != usize.ONE { return 41 }
  let v6Endpoint = ResolvedEndpoints.get(&v6, usize.ZERO)
  let v6Address = Endpoint.address(&v6Endpoint)
  if IpAddress.isV4(&v6Address) || !counters(1, 1, 1) { return 43 }

  let deadlineProvider = run Effect.result(deadlineCancellationProgram())
  match move deadlineProvider {
    Result<i32, ResolverError | OutOfMemoryError>.Failure {error} => { drop error return 23 }
    Result<i32, ResolverError | OutOfMemoryError>.Success {value} => {
      if value != 42 { return value }
    }
  }
  return 42
}

pub fn main() -> i32 { return run nativeCases() }
`

/**
 * Complete shared-corpus entry for JUL-190. It needs no memory imports or non-default runtime
 * components: the registered standard-library actors and default native runtime are sufficient.
 */
export const networkAddressResolutionCorpusProgram = Object.freeze({
  name: 'network-address-resolution',
  source: networkAddressPortableCorpusSource,
  nativeSource: nativeResolverStubAcceptanceSource,
  nativeCSources: Object.freeze({ native_resolver_stub: nativeResolverStubSource }),
  expected: Object.freeze({ _tag: 'Completes' as const, result: 42 }),
})
