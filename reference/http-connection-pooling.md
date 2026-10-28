---
title: HTTP connection pooling
description: Bounded local HTTP/1 connection ownership, conservative reuse, deterministic eviction, and explicit closure.
---

# HTTP connection pooling

`silk.http.connection_pool` owns a finite set of complete HTTP/1 connections for one immutable
acquisition and security context. Pool state is local to one scheduler thread. Checkout is
fail-fast, release is ownership-safe, and all network and allocator effects occur outside shared
state.

The actor is target-neutral. `PoolKey` defines conservative connection identity, `PoolContextCopy`
defines fallible bounded context copying, `PoolContext` opens complete HTTP owners, and
`withConnection` lends one connection exclusively to a scoped callback. Native direct and
proxy-aware contexts implement those contracts without changing the pool state machine.

## Configuration

`Config.defaults()` returns these limits:

| Field                    | Default     | Admitted values             |
| ------------------------ | ----------- | --------------------------- |
| `maxTotal`               | 32          | 1 through 1024              |
| `maxIdle`                | 16          | 0 through `maxTotal`        |
| `maxPerOrigin`           | 8           | 1 through `maxTotal`        |
| `idleTimeoutNanoseconds` | 30000000000 | Any positive `u64` duration |

`maxTotal` counts opening, leased, and idle entries together. `maxIdle = 0` disables idle
retention without disabling checkout. Invalid limits return `PoolError.InvalidConfig` before slot
allocation, context publication, or transport contact. Every slot is preallocated before the root
pool is lent to caller code; shared-state transitions perform no allocation.

## Pool and handle ownership

`withPool` constructs the scoped root `Pool`, lends it through `PoolHandler`, and runs nonparking
closure after success, typed failure, defect, or structured cancellation. Dropping an aggregate is
not a substitute for effectful connection closure.

`Pool.handle()` borrows the root handle. `copyHandle` creates another local handle by fallibly
copying its immutable bounded context before cloning the `Shared` state alias. A copy failure
publishes neither an alias nor a partial context. Callers cannot pair arbitrary context with an
existing pool state.

Handles have no thread-safe, cross-thread, atomic, fairness, or wakeup contract. A `Shared`
callback only scans or moves already-owned slots. It never encloses a clock read, allocation,
connector call, transport close, suspension, or caller callback.

## Connection keys and frozen context

`ConnectionKey` records the normalized original HTTP or HTTPS origin and one endpoint identity:

| Endpoint identity | Included identity                                                         |
| ----------------- | ------------------------------------------------------------------------- |
| Direct            | The exact normalized original origin                                      |
| Proxy             | The sealed route key, including mode, endpoint, origin, and credential ID |
| Unix              | The exact owned pathname plus the normalized HTTP origin                  |

`ConnectionKey.direct(origin)` and `ConnectionKey.proxy(route)` construct their keys without
allocation. `ConnectionKey.unix(origin, path)` fallibly copies the pathname through the caller's
allocator. `ConnectionKey.origin()` returns the normalized original origin used by per-origin
capacity accounting.

The retained context separately partitions provider representation, HTTP version and limits, TLS
verification and ALPN policy, trust, routing policy, and connector policy. `PoolContext.accepts`
rejects a key from another immutable context with `ContextMismatch` before clock or transport
contact. DNS aliases, resolved addresses, certificates, and caller-supplied mutable tokens do not
establish key equivalence. Forward-proxy connections remain partitioned by original origin.

A context containing trust freezes one prepared trust snapshot at pool construction. Handle copy
copies that frozen context before publishing a shared alias. Each HTTPS opening consumes or copies
from the frozen snapshot; changes to the original trust source are visible only to a newly
constructed pool.

## Checkout and capacity

`withConnection` accepts a handle, conservative key, optional request deadline, optional
acquisition-only deadline, and a higher-ranked `ConnectionHandler`. The callback receives one
nonescaping exclusive connection borrow. Success returns `CheckoutResult`, whose `source` is
`Opened` or `Reused`. The callback success, failure, and requirement channels remain generic and
are not erased by the pool.

Admission samples the monotonic clock before entering shared state. One shared mutation then
performs these operations atomically:

1. Remove one or more expired idle entries as owned close work.
2. Select the most recently returned compatible idle entry, if one exists.
3. Otherwise reserve one opening slot after a legal deterministic eviction.

The sum of opening, leased, and idle entries never exceeds `maxTotal`; one normalized original
origin never exceeds `maxPerOrigin`. A full per-origin count can be relieved only by evicting an
idle entry for that same origin. Global pressure evicts the least recently returned idle entry,
with insertion sequence as the stable equal-time tie-breaker. If no legal reservation or eviction
exists, checkout returns `PoolFull` without waiting or contacting a connector.

Expired and evicted owners leave shared state before physical close. `collect` performs the same
lazy expiry explicitly and returns the number of expired owners it closed. `counts` returns a
synchronous snapshot of opening, leased, idle, total, and closed state without consulting the
clock.

## Deadlines

Pooling keeps five time domains separate:

| Domain      | Form                                 | Scope                                                         |
| ----------- | ------------------------------------ | ------------------------------------------------------------- |
| Acquisition | Optional absolute monotonic deadline | Opening only; clamped by the current request deadline         |
| Handshake   | Finite duration cap                  | TLS authentication, also clamped by the acquisition bound     |
| Request     | Optional absolute monotonic deadline | The current exchange, request body, trailers, and response    |
| Drain       | Required finite absolute deadline    | One explicit live-exchange drain, clamped by request deadline |
| Idle        | Finite positive duration             | From successful idle publication until lazy expiry            |

The connector constructs a pooled `Connection` with no retained overall deadline. Every exchange
receives the caller's current request deadline unchanged. A reused owner therefore retains neither
its opening bound nor a previous request's bound. `None` remains an explicitly unbounded request or
acquisition wait; it does not make synchronous resolution, trust loading, or callback CPU work
preemptible.

An opening that completes at or after its effective bound returns `OpeningExpired`, closes the
owner, and refunds its reservation once. Native finite-deadline hostname resolution retains its
`UnsupportedDeadline` preflight before resolver dispatch. Numeric, Unix, and scripted acquisition
can retain the finite bound.

## Reuse and explicit drain

The HTTP client, rather than the pool, decides reuse eligibility. Successful callback completion
publishes an owner only when the client reports all of these properties:

- Ready phase and no active exchange;
- complete request body, trailers, final-response framing, and selected decoder;
- persistent request and response messages;
- empty retained input suffix and no pending output;
- no HTTP upgrade or CONNECT ownership transfer; and
- remaining request-count budget.

Every other owner closes outside shared state. This includes an abandoned or incomplete exchange,
close-delimited response, malformed framing, transport or decoder failure, unsolicited suffix,
nonpersistent message, exhausted request budget, upgrade, and tunnel transfer. A stale idle peer's
first I/O failure evicts the owner; the pool does not replay the request.

Default callback finalization performs no hidden read, drain, flush, graceful shutdown, or other
parking operation. Bounded reuse after a partially consumed response requires the HTTP client's
explicit live-exchange drain. That operation has a 65536-byte default cap, admits at most 1048576
aggregate wire bytes, and requires a finite absolute deadline. Payload, framing, chunk extensions,
trailers, and decoder completion all count before response finish. A cap, timeout, framing, read,
allocation, transport, or decoder failure preserves its typed outcome and leaves the owner
ineligible.

## Release and closure

One local nonparking guard owns each reservation or concrete connection from admission through
release. Acquisition failure, allocation failure, typed failure, defect, cancellation, stale I/O,
or callback failure refunds capacity and closes concrete resources exactly once without replacing
the protected outcome.

On successful callback return, the pool samples one return timestamp before attempting idle
publication. Publication succeeds only for a client-eligible owner while the pool remains open and
idle capacity permits it. A pool that closes during acquisition rejects the late publication,
closes the new owner, and refunds the reservation.

`close` is idempotent. It marks state closed synchronously, extracts idle owners, and attempts to
close every one outside shared access. Explicit close preserves the first `ExchangeError` after all
idle owners have received a close attempt. New checkout and surviving handles then return
`PoolClosed`. A connection already lent to a callback remains valid until that callback ends; its
release closes instead of republishing it. Scoped finalization and explicit close use the same
transition, while scoped cleanup protects the original result from a close failure.

## Errors

| Error                     | Meaning                                                               |
| ------------------------- | --------------------------------------------------------------------- |
| `InvalidConfig { field }` | A named capacity or idle-duration field failed admission.             |
| `PoolFull`                | No idle selection, reservation, or legal eviction can satisfy limits. |
| `PoolClosed`              | Root closure prevents checkout or late publication.                   |
| `ContextMismatch`         | The key does not belong to the handle's frozen context.               |
| `OpeningExpired`          | Opening completed after its effective acquisition bound.              |

Key copying, context copying, allocation, connector, resolver, socket, TLS, trust, HTTP client,
source, and callback failures remain precise alternatives in their original error channels.
Unsupported target or route composition fails before resolver, socket, trust, or transport
contact.

## Native and proxy composition

Supported native contexts acquire complete direct TCP, pathname-Unix HTTP, and HTTPS owners through
one owned-acquisition path. HTTPS authenticates the exact original origin and uses a bounded copy
of the pool's frozen trust snapshot. The release guard remains armed from socket acquisition
through TLS and HTTP-owner publication.

Proxy-aware contexts consume the sealed [`silk.http.proxy`](http-proxy-routing.md) route identity.
Direct, Forward, and Tunnel keys are distinct. Forward reuse remains per original origin. Tunnel
opening completes CONNECT before authenticating the original origin with TLS; proxy credentials
remain route-owned and never enter tunneled origin headers. An unavailable or unsupported route
does not fall back to Direct.

Redirect orchestration can select a new key for each admitted hop. The pool does not decide
redirect policy or replay authority. Higher-level fetch composition owns request replay and policy
above the pool.

## Exclusions

This actor does not provide thread-safe handles, atomics, mutexes, waiter queues, fairness,
background expiry, automatic retry or replay, pipelining, HTTP/2, origin coalescing, HTTP/3,
WebSocket pooling, ambient proxy discovery, trust refresh inside a pool, per-request TLS/ALPN
replacement, or a general Stream abstraction.

The implementation lives in
[`http_connection_pool.silk`](../stdlib/silk/http/connection_pool.silk),
with client ownership in
[`http_exchange.silk`](../stdlib/silk/http/exchange.silk), native acquisition
in
[`http_exchange_native.silk`](../stdlib/silk/http/exchange_native.silk), and
route identity in [`http_proxy.silk`](../stdlib/silk/http/proxy.silk).
The normative delivery contract is the
`bounded-http-connection-pooling` OpenSpec.
