---
title: HTTP proxy routing
description: Explicit bounded forward-proxy policy, routed request admission, CONNECT tunnels, and origin TLS.
---

# HTTP proxy routing

Use `silk.http.proxy` to select an explicit route for one HTTP origin. Proxy configuration is an
owned, bounded value. Route selection is pure: it does not resolve a name, open a connection, read
ambient settings, or generate output. `silk.http.request` turns a selected route into a sealed
routed request, and `silk.http.exchange.withRoute` scopes acquisition, CONNECT, optional origin TLS,
and the final HTTP connection.

> `silk.http.proxy` supports only plaintext HTTP proxy endpoints. A Forward route exposes the
> request target, headers, and any `Proxy-Authorization` value to the proxy hop and to observers of
> that hop. HTTPS for the origin does not protect a Forward request or the CONNECT request that
> precedes an origin TLS tunnel.

This complete program constructs a credential-free proxy configuration and selects the HTTPS
Tunnel route without contacting the network:

```silk
import silk.mem.allocator {Allocator, OutOfMemoryError}
import silk.core.effect {Effect}
import silk.http.origin {Origin}
import silk.http.proxy {
  BypassPolicy,
  ProxyAuth,
  ProxyAuthContextId,
  ProxyConfig,
  ProxyConfigId,
  ProxyError,
  Route,
  RouteMode,
}
import silk.http.proxy as Proxy
import silk.core.result {Result}
import silk.uri.uri {Uri}

effect fn select() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let empty: [Origin; 0] = []
  let bypass = match move run BypassPolicy.copy(&empty) {
    Result<BypassPolicy, ProxyError>.Failure {error} => { return 1 }
    Result<BypassPolicy, ProxyError>.Success {value} => move value
  }
  let configured = ProxyConfig.fromUri(
    ProxyConfigId.make(7),
    "http://proxy.example:8080",
    ProxyAuth.none(ProxyAuthContextId.make(11)),
    move bypass,
    4096,
  )
  let config = match move configured {
    Result<ProxyConfig, ProxyError>.Failure {error} => { return 2 }
    Result<ProxyConfig, ProxyError>.Success {value} => move value
  }
  let uri = match move Uri.parse("https://service.example/a?b") {
    Result.Failure {error} => { return 3 }
    Result.Success {value} => value
  }
  let origin = match move Origin.fromUri(&uri) {
    Result.Failure {error} => { return 4 }
    Result.Success {value} => value
  }
  let route = Proxy.selectRoute(&config, origin)
  if Route.mode(&route) == RouteMode.Tunnel { return 0 }
  return 5
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 6 }

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    select() |> Effect.provideMut<Allocator>(&mut allocator),
    recover,
  )
}
```

## Configuration and caller-owned identity

`ProxyConfig.make` accepts one parsed plain proxy host, a port from 1 through 65535, a prepared
authentication value, an exact-origin bypass policy, and an explicit `maxOwnedConfigBytes`.
`ProxyConfig.fromUri` is the convenience constructor. It accepts only an `http` authority with no
userinfo, nonempty path, query, or fragment. It rejects `https` as
`UnsupportedProxyTransport` while constructing the configuration, before resolution or connection.

`BypassPolicy.copy` owns at most 64 normalized origins. `ProxyAuth.preparedBasic` accepts a nonempty
canonical standard-padded Base64 token of at most 4096 encoded bytes, which represents at most 3072
decoded bytes. It rejects whitespace, controls, URL-safe spelling, malformed padding, and nonzero
pad bits. The operation validates without decoded scratch. The caller is responsible for encoding
the username and password and for deciding when the credential is safe to use.

The caller also supplies `ProxyConfigId` and `ProxyAuthContextId` values from nonsecret `u64`
payloads. They are opaque, copyable, and compared exactly. They are not hashes of the proxy endpoint
or credential. Use a new authentication-context ID whenever the credential or its authorization
context changes. Diagnostics and formatting do not reveal ID payloads or prepared token bytes.

All configuration size arithmetic is checked before allocation or contact. `maxOwnedConfigBytes`
includes copied host, credential, bypass-entry, and index storage. A zero limit is a real limit.

## Route matrix

`selectRoute(config, origin)` applies this complete matrix:

| Origin and policy     | Selected route | Physical peer                                         | Wire form and authentication                                 |
| --------------------- | -------------- | ----------------------------------------------------- | ------------------------------------------------------------ |
| Exact bypass match    | `Direct`       | Original origin                                       | Ordinary origin-form request; no proxy credential            |
| Plain `http` origin   | `Forward`      | Plain proxy                                           | Absolute-form request; configured proxy credential only      |
| Secure `https` origin | `Tunnel`       | Plain proxy, then the original origin through CONNECT | Authority-form CONNECT, then origin TLS and origin-form HTTP |

Bypass equality includes the scheme, normalized host identity, and effective port. Canonically
equivalent numeric addresses compare equal. There is no suffix, wildcard, CIDR, DNS-result, or
same-host implicit bypass. Selection happens before proxy credential bytes are copied into request
scratch. A proxy failure never falls back to Direct, downgrades the origin, or retries.

Each route retains its original origin, proxy endpoint, mode, and the exact caller-supplied
configuration and authentication-context IDs. `Route.key` exposes that nonsecret stable identity
for later policy. `Route.recompute` reapplies the same retained configuration to a new origin.
Neither operation implements pooling, redirects, retry, replay, or capability caching.

## Routed request admission

Routed request preparation separates the logical origin from the physical peer. The logical origin
controls the request target, `Host`, origin `Authorization`, and TLS identity. The selected proxy
origin controls which plain connection may emit the routed bytes. `Client.withExchange` rejects a
prepared request when its physical peer differs from the connection peer.

`HttpRequest.prepareForward` accepts only a sealed Forward route. It emits an absolute-form target,
preserves the accepted encoded path and query, omits userinfo and fragments, and emits `/` for an
empty path. `Host` always names the logical origin, including with HTTP/1.0. The configured route is
the only source of `Proxy-Authorization`; a caller-provided field is rejected before output.

`HttpRequest.prepareConnect` accepts only a sealed Tunnel route. It constructs a body-free HTTP/1.1
CONNECT request whose target and `Host` are the original origin's normalized authority with an
explicit effective port. IPv6 literals remain bracketed. The caller cannot provide a target,
headers, body, physical peer, origin credential, Cookie, path, query, or fragment.

The ordinary direct preparation operations remain separate. They bind logical and physical origin
to the same value and reject caller-supplied `Proxy-Authorization`. There is no public raw-token
serializer or API for asserting an arbitrary routed mode or physical peer.

## CONNECT responses and metadata limits

CONNECT uses the shared incremental HTTP head parser. Each response head permits at most 32768 wire
bytes and 100 fields. At most 8 informational responses and 65536 aggregate informational-head wire
bytes are accepted. Status 101 is an invalid transition. Any final status from 200 through 299
establishes the tunnel immediately after the head terminator; `Content-Length` and
`Transfer-Encoding` on that successful response do not consume tunneled bytes.

A 407 failure is `ProxyAuthenticationRequired` and owns the status, reason, and every
`Proxy-Authenticate` field, including duplicates in original order. Another final non-2xx response
is `ProxyRejected` and owns the status, reason, and every response field in original order. Both
owned copies use these exact limits:

| Resource                |       Limit |
| ----------------------- | ----------: |
| Fields                  |         100 |
| One field name          |   256 bytes |
| One field value         |  8192 bytes |
| Aggregate field payload | 32768 bytes |
| Total owned metadata    | 32768 bytes |

Total-owned accounting includes field-record storage as well as copied payload. Consequently
`ProxyMetadataLimit` can occur even when the final wire head fits its own 32768-byte bound. Parser,
head, and informational failures take precedence until a complete final head exists. After that
head exists, metadata overflow and `OutOfMemoryError` take precedence over the status-specific
rejection. A rejection closes without draining an unbounded body and without retrying credentials.

## Trust, deadlines, and ownership

The caller establishes one optional absolute monotonic deadline before loading trust. Trust loading
finishes outside `Client.withRoute`; the caller then passes the owned `TrustSnapshot` and the same
unchanged deadline. Trust loading is not made interruptible, but its elapsed time counts because
route entry does not create a new mark.

Forward and insecure Direct routes require no trust snapshot. Secure Direct and Tunnel routes
require exactly one caller-prepared snapshot. Invalid presence or absence fails before acquisition.
The same deadline spans physical-peer acquisition, CONNECT, tunnel TLS, and the connected HTTP
scope. TLS clamps its finite handshake duration to that mark instead of restarting it. Native
synchronous hostname resolution with a finite deadline returns its unsupported-deadline failure
before DNS dispatch; numeric routes retain the deadline.

Successful CONNECT transfers the exact unread suffix and concrete transport authority once. The
complete affine `ByteDuplex` reads the suffix before the provider, forwards writes and flushes, and
forwards write-direction shutdown once without closing reads. Its terminal close is idempotent and
attempts the concrete close at most once. After transfer, the HTTP owner cannot resume or reclaim
the connection. Structured cleanup runs after success, typed failure, or cancellation without
replacing the protected result. Fatal traps remain outside that guarantee.

For Tunnel routes, TLS starts only after a final CONNECT 2xx. It authenticates the original origin,
not the proxy hostname or a resolved alias. HTTP inside the authenticated tunnel uses origin-form
targets and emits no proxy credential.

## Error boundaries

Proxy policy distinguishes invalid configuration, unsupported encrypted proxy transport,
authentication required, rejected CONNECT status, metadata limits, incomplete CONNECT responses,
and invalid sealed-route use. Routed composition preserves the existing allocation, resolver,
connection, parser, byte-I/O, TLS, identity, trust, acquisition-adapter, and callback error
channels. It does not wrap a callback's failure or erase its requirements.

Physical native acquisition is available only on the socket profiles admitted by the native HTTP
client. Other targets return the documented unsupported-target result. Target-neutral proxy
configuration, route selection, request preparation, and scripted transport composition remain
ordinary Silk source and do not require a compiler-known proxy operation.

## Exclusions

This profile does not provide environment-variable or system proxy discovery, PAC, SOCKS,
TLS-encrypted proxy endpoints, proxy chains, reverse proxies, automatic 407 retry, fallback,
redirect following, pooling, replay, or permanent capability caching. It does not claim that a
plaintext proxy hop protects request metadata or credentials.

The implementation lives in
[`http_proxy.silk`](../stdlib/silk/http/proxy.silk),
[`http_request.silk`](../stdlib/silk/http/request.silk), and
[`http_exchange.silk`](../stdlib/silk/http/exchange.silk). The normative
delivery contract is recorded in the
`http-proxy-routing` OpenSpec.
