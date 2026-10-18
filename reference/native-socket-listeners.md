---
title: Native socket listeners
description: Scoped nonblocking TCP and pathname-Unix listeners with owned accepted connections.
---

# Native socket listeners

`silk.native_socket` creates one affine listening descriptor and admits one independently owned
connection at a time. The actor is ordinary selected Silk source: it is available on aarch64 Darwin
with Apple system libc and on aarch64 or x86-64 GNU/Linux with glibc. It is absent on Windows, musl,
no-libc profiles, and WebAssembly.

Use `Listener.boundAddress` after `listen` to observe the actual numeric endpoint. This matters when
the requested port is zero: the kernel-assigned nonzero port is published only after `bind`,
`listen`, and `getsockname` all succeed.

```silk
import silk.native_socket {Accepted, AcceptedContext, AcceptedView, BoundAddress, ListenOptions, Listener, NativeSocketError, listen, withAcceptedContext}
import silk.network_address {Endpoint, IpAddress, Ipv4Address, Port}

fn loopbackListener() -> Endpoint {
  return Endpoint.make(
    IpAddress.V4 {value: Ipv4Address.fromOctets([127, 0, 0, 1])},
    Port.fromU16(0),
  )
}

effect fn openLoopback() -> Listener ! NativeSocketError {
  let listener = run listen(loopbackListener(), ListenOptions.defaults())
  let bound = Listener.boundAddress(&listener)
  match move bound {
    BoundAddress.Tcp {endpoint} => {
      if Port.value(&Endpoint.port(&endpoint)) == 0 { fail NativeSocketError.InvalidNativeAddress {family: 2, length: 16} }
    }
    _ => {}
  }
  return move listener
}

struct RequestContext {requestId: i32}
impl RequestContext {
  effect<'call> fn use<'call>(
    context: Self,
    view: &'call mut AcceptedView<'call>,
  ) -> i32 {
    drop view
    return context.requestId
  }
}
impl AcceptedContext<i32, never, never ? never> for RequestContext {
  use: RequestContext.use
}

effect fn useAccepted(accepted: Accepted, requestId: i32) -> i32 {
  return run withAcceptedContext(move accepted, RequestContext {requestId: requestId})
}
```

## Options

`ListenOptions.make(kernelBacklog, reuseAddress, pollIntervalNanoseconds)` is pure. Backlog must be
1 through 65535 and the polling interval must be 1 through 1,000,000,000 nanoseconds. `defaults()`
selects backlog 128, disables reuse, and polls at one-millisecond intervals. Reuse controls only
`SO_REUSEADDR`; the actor never enables `SO_REUSEPORT` or creates an application queue.

IPv6 listeners are explicitly IPv6-only and own one descriptor. IPv4-mapped IPv6 values therefore
remain IPv6 identities rather than being silently converted to IPv4.

## Serial acceptance and ownership

`accept(&mut listener, deadline)` holds an exclusive listener borrow and returns one affine
`Accepted`. A second accept or close cannot overlap that borrow. `withAccepted` consumes the result,
lends `&mut Connection` plus `&PeerAddress`, and closes the connection after success, typed failure,
or structured cancellation. The connection remains usable if its listener is closed first, and
closing it never closes the listener.

`withListener` is the matching higher-ranked scope for an already acquired listener. It consumes
the owner, lends one exclusive listener reference to the callback, and attempts terminal close on
every structured exit. Both scopes preserve the callback outcome when close itself reports an
error. Use explicit `Listener.close` when the accepted connection must be transferred before the
listener scope ends, as in a serial server loop.

Use `AcceptedContext<A, E, ?R, ?Q>` and `withAcceptedContext` when the protected operation must
consume owned or once-callable state. `R` preserves caller-selected requirements and `Q` records
additional requirements introduced by the concrete context; the protected operation exposes their
union. Interface selection is compile-time only. `AcceptedContext.use` receives the owned context
independently from its higher-ranked `AcceptedView` loan, so neither the view nor its connection can
escape. The context is consumed once; the accepted connection closes once after success, typed
failure, or structured cancellation, and a close error does not replace the protected result. As
with `withAccepted`, neither row's union can contain `ByteDuplex`; use the explicitly loaned
connection instead.

Acceptance always tries the nonblocking syscall before parking. After temporary unavailability, a
readable zero-time poll permits exactly one immediate accept retry. If that retry also reports
temporary unavailability, the operation takes a positive `MonotonicClock` wait before trying again;
interrupted syscalls and GNU's documented pending-network errors also wait positively and never
spin. The same absolute deadline is checked before native work and after every wait. `None`
intentionally permits indefinite cooperative waiting; structured cancellation releases the parked
timer authority before the enclosing listener scope closes its descriptor. Concurrent cross-thread
close is not a supported cancellation mechanism.

TCP peers are owned numeric `Endpoint` values. Unix peers distinguish `Unnamed` from an owned
pathname spelling. An unbound peer is recognized from GNU's family-header-only length or Darwin's
family-bearing padded result with a leading-NUL pathname; Darwin has no abstract Unix namespace,
while GNU's leading-NUL form remains unsupported. A zero-length form is accepted only for a known
Unix listener. Native returned lengths are checked before any family field, port, address, or
pathname byte is read.
Abstract Unix peers are rejected as `UnsupportedPeerAddress`, and malformed families or lengths as
`InvalidNativeAddress`; only the provisional accepted descriptor is closed.

## Unix pathname ownership

`listenUnix` accepts a nonempty absolute NUL-free byte pathname that fits the platform
`sockaddr_un`, including its terminal NUL. It never removes a stale entry before bind and never
unlinks a successful entry during close or finalization. The caller must create a private directory,
remove any entry under its own policy, and explicitly unlink the socket entry after the listener is
closed. An occupied or stale pathname reports `AddressInUse` without destructive cleanup.

Listener and connection close are terminal, idempotent, and nonparking. They do not flush, drain,
wait for peers, retry an interrupted close, or mutate the Unix namespace. Structured finalizers
attempt exactly one close while preserving the protected callback outcome.

## Failures

Pure option construction reports `ListenOptionsError` with the rejected field and value. Local
pathname admission reports `InvalidBindAddress` or `PathTooLong` before socket creation. Native
listener setup distinguishes only `AddressInUse`, `PermissionDenied`, `FamilyUnsupported`, and
`SystemResources`; every other listener failure retains its exact `NativeSocketOperation` and
signed errno. In particular, connection-oriented errno values are not collapsed while creating or
accepting a listener.
Acceptance additionally reports `Timeout`, `Closed`, `InvalidNativeAddress`, or
`UnsupportedPeerAddress`. Once an `Accepted` value transfers, byte I/O continues to use the
existing `ByteIoError` contract rather than widening it with listener failures.

The accept loop retries only temporary unavailability, interruption, readiness races, and the
documented GNU pending-network errno set. Resource, permission, invalid-descriptor, and unknown
errors are terminal. No retry renews the supplied deadline, and a deadline already equal to the
current monotonic mark performs no accept or poll call.
