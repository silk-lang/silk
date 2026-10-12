import {
  tlsClientRsaRootPem,
  tlsClientRsaServerFlight,
  tlsClientRsaApplicationRecord,
} from './tlsClientAcceptance.js'

const silkBytes = (bytes: Uint8Array): string =>
  `b"${[...bytes].map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`

// Reuse the established authenticated peer transcript. Only its post-authentication application
// record changes: the TLS handshake and certificate evidence remain the existing TLS witness.
const plaintext = Buffer.from('HTTP/1.1 200 OK\r\nContent-Length: 4\r\n\r\nWiki')
const application = tlsClientRsaApplicationRecord(plaintext)
let offset = 0
let finalRecord = 0
while (offset < tlsClientRsaServerFlight.length) {
  finalRecord = offset
  const high = tlsClientRsaServerFlight[offset + 3]
  const low = tlsClientRsaServerFlight[offset + 4]
  if (high === undefined || low === undefined) throw new Error('Truncated TLS HTTP fixture record')
  offset += 5 + high * 256 + low
}
if (offset !== tlsClientRsaServerFlight.length)
  throw new Error('Invalid TLS HTTP fixture record boundary')
const flight = Buffer.concat([tlsClientRsaServerFlight.subarray(0, finalRecord), application])

/** One authenticated HTTP exchange using the established TLS peer. */
export const httpTransportAcceptanceSource = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.byte_duplex {ReadTransfer}
import silk.bytes {Bytes}
import silk.effect {Effect}
import silk.http {Method, Version, Header}
import silk.http_headers {Headers, Limits as ValueLimits}
import silk.http_origin {Origin}
import silk.http_request {HeaderPolicy, BodyMode, RequestError}
import silk.http_request as Request
import silk.http_client {Connection, ConnectionHandler, Exchange, Limits, ClientError, RequestOptions, ContinuePolicy}
import silk.http_client as Client
import silk.http_transport {HttpTransport, TransportError}
import silk.http_transport as Transport
import silk.memory_byte_duplex {MemoryByteDuplex, MemoryReadEvent, MemoryWriteEvent, MemoryWriteAction}
import silk.monotonic_clock {MonotonicClock}
import silk.random {Random}
import silk.option {Option}
import silk.result {Result}
import silk.system_clock {Instant, SystemClock}
import silk.uri {Uri}
import silk.u64
import silk.usize
import silk.vector {Vector}
import silk.https_identity {HttpsIdentity, IdentityError, OriginHost, ReferenceIdentity}
import silk.tls_client {AlpnConfig, ClientConfig, ClientLimits}
import silk.tls_connection as Tls {OwnedConnection, ConnectionError, ConnectionOptions}
import silk.trust_snapshot {TrustSnapshot, TrustLoadLimits, TrustSourceError}
struct FixedRandom {filled: usize}
impl Random for FixedRandom {
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
fn valueLimits() -> ValueLimits { let selected = Limits.defaults() return selected.head.values }
fn limits() -> Limits {
 let mut selected = Limits.defaults()
 selected.readCapacity = 128
 selected.writeCapacity = 128
 selected.maxRequests = 1
 return selected
}
effect fn providerFor(inputBytes: &[u8], writeCount: usize) -> MemoryByteDuplex
! OutOfMemoryError ? &mut Allocator {
 let input = run Bytes.copy(inputBytes)
 let mut reads = Vector<MemoryReadEvent>.make()
 run Vector.append(&mut reads, MemoryReadEvent.Data {readyAt: SystemClock.make(0, 0), bytes: move input})
 run Vector.append(&mut reads, MemoryReadEvent.End {readyAt: SystemClock.make(0, 0)})
 let mut writes = Vector<MemoryWriteEvent>.make()
 let mut index = usize.ZERO
 while index < writeCount {
  run Vector.append(&mut writes, MemoryWriteEvent {readyAt: SystemClock.make(0, 0), action: MemoryWriteAction.Accept {count: 65535}})
  index = index + usize.ONE
 }
 return run MemoryByteDuplex.make(move reads, move writes, 4096, 128, Option<i32>.none())
}
struct TlsClock {}
impl MonotonicClock for TlsClock {
 effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
 effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
 effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
 effect fn waitFor(self: &mut Self, duration: u64) -> () { drop duration return () }
}
struct WallClock {}
impl SystemClock for WallClock {
 effect fn now(self: &mut Self) -> Instant { return SystemClock.make(1789156800, 123456789) }
 effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
}
fn reference<'a>(bytes: &'a [u8]) -> ReferenceIdentity<'a> {
 return match move HttpsIdentity.reference(OriginHost<'a>.Dns {bytes: bytes}) {
  Result<ReferenceIdentity<'a>, IdentityError>.Success {value} => value
  Result<ReferenceIdentity<'a>, IdentityError>.Failure {error} => { let invalid = 1 / 0 return reference(bytes) }
 }
}
struct TlsTransport {inner: OwnedConnection<MemoryByteDuplex>}
impl HttpTransport for TlsTransport {
 effect fn readSomeRaw(self: &mut Self, output: &mut [u8], deadline: Option<Instant>) -> ReadTransfer
 ! TransportError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  let mut adapter = Transport.secured(&mut self.inner)
  return run HttpTransport.readSome(move output, move deadline) |> Effect.provideMut<HttpTransport>(&mut adapter)
 }
 effect fn writeSomeRaw(self: &mut Self, input: &[u8], deadline: Option<Instant>) -> usize
 ! TransportError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  let mut adapter = Transport.secured(&mut self.inner)
  return run HttpTransport.writeSome(input, move deadline) |> Effect.provideMut<HttpTransport>(&mut adapter)
 }
 effect fn flush(self: &mut Self, deadline: Option<Instant>) -> ()
 ! TransportError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  let mut adapter = Transport.secured(&mut self.inner)
  return run HttpTransport.flush(move deadline) |> Effect.provideMut<HttpTransport>(&mut adapter)
 }
 effect fn close(self: &mut Self) -> () ! TransportError {
  let mut adapter = Transport.secured(&mut self.inner)
  return run HttpTransport.close() |> Effect.provideMut<HttpTransport>(&mut adapter)
 }
}
struct Handler {}
impl ConnectionHandler<TlsTransport, i32, ClientError | RequestError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random> for Handler {
 effect<'call> fn handle<'call>(handler: Self, connection: &'call mut Connection<TlsTransport>) -> i32
 ! ClientError | RequestError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
  let uri = match move Uri.parse("https://example.com/") { Result.Failure {error} => { drop error return 31 } Result.Success {value} => value }
  let entries: [Header<'static>; 0] = []
  let headers = match move Headers.make(&entries, valueLimits()) { Result.Failure {error} => { drop error return 32 } Result.Success {value} => value }
  let policy = HeaderPolicy.defaults()
  let request = run Request.fromUri(&uri, Version.Http11, Method.get(), &headers, &policy, BodyMode.Empty, false, valueLimits(), 1024, 512)
  let options = RequestOptions {deadline: Option<Instant>.none(), continuePolicy: ContinuePolicy.Disabled}
  return run Client.withExchange(&mut connection.*, &request, move options, exchange)
 }
}
effect<'call> fn exchange<'call, 'exchange: 'call>(exchangeValue: &'call mut Exchange<'exchange, TlsTransport>) -> i32
! ClientError | OutOfMemoryError ? &mut Allocator | &mut MonotonicClock | &mut Random {
 run Client.send(&mut exchangeValue.*)
 let entries: [Header<'static>; 0] = []
 let trailers = match move Headers.make(&entries, valueLimits()) { Result.Failure {error} => { drop error return 33 } Result.Success {value} => value }
 run Client.finishRequest(&mut exchangeValue.*, &trailers)
 let status = run Client.receive(&mut exchangeValue.*)
 if status != 200 { return 34 }
 let mut bytes: [u8; 4] = [0, 0, 0, 0]
 let count = run Client.readSome(&mut exchangeValue.*, &mut bytes)
 if count != 4 || bytes[0] != 87 || bytes[3] != 105 { return 35 }
 run Client.finishResponse(&mut exchangeValue.*)
 return 0
}
effect fn authenticatedExchange() -> i32 ! ClientError | RequestError | ConnectionError | TrustSourceError | OutOfMemoryError {
 let mut allocator = Allocator.systemAllocatorProvider()
 let transport = run providerFor(${silkBytes(flight)}, 64) |> Effect.provideMut<Allocator>(&mut allocator)
 let trustResult = run TrustSnapshot.fromPem(${silkBytes(tlsClientRsaRootPem)}, TrustLoadLimits.defaults()) |> Effect.provideMut<Allocator>(&mut allocator)
 let trust = match move trustResult { Result.Success {value} => move value Result.Failure {error} => { fail move error } }
 let mut wall = WallClock {}
 let mut clock = TlsClock {}
 let mut random = FixedRandom {filled: usize.ZERO}
 let host = b"example.com"
 let config = ClientConfig {reference: reference(&host), alpn: AlpnConfig.defaults(), limits: ClientLimits.defaults()}
 let authenticated = run Tls.authenticateOwned<MemoryByteDuplex>(move transport, &config, move trust, ConnectionOptions.defaults())
   |> Effect.provideMut<SystemClock>(&mut wall)
   |> Effect.provideMut<Random>(&mut random)
   |> Effect.provideMut<MonotonicClock>(&mut clock)
   |> Effect.provideMut<Allocator>(&mut allocator)
 let uri = match move Uri.parse("https://example.com/") { Result.Failure {error} => { drop error return 36 } Result.Success {value} => value }
 let origin = match move Origin.fromUri(&uri) { Result.Failure {error} => { drop error return 37 } Result.Success {value} => value }
 return run Client.withOwned(TlsTransport {inner: move authenticated}, origin, Version.Http11, limits(), Option<Instant>.none(), Handler {})
   |> Effect.provideMut<Random>(&mut random)
   |> Effect.provideMut<MonotonicClock>(&mut clock)
   |> Effect.provideMut<Allocator>(&mut allocator)
}
effect fn recover(error: ClientError | RequestError | ConnectionError | TrustSourceError | OutOfMemoryError) -> i32 { drop error return 51 }
pub fn main() -> i32 { return run Effect.catchAll(authenticatedExchange(), recover) }
`
