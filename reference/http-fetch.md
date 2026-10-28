---
title: One-shot HTTP fetch
description: Bounded HTTP response delivery, source-specific request bodies, owned metadata, and explicit routing, pooling, redirect, content, and deadline policy.
---

# One-shot HTTP fetch

`silk.http.fetch` composes one semantic HTTP request into a completed one-shot result. It uses the
streaming client, redirect, content-decoding, proxy-routing, and connection-pool actors without
hiding request-body authority, response completion, storage limits, or transport ownership.

The actor supports three destinations: a sequential borrowed-chunk sink, an atomic bounded body
collection, and a validating bounded discard. Each destination has separate Empty, borrowed Bytes,
affine OneShot, and replay-factory operations. There is no singular body-source value or implicit
method selection from the presence of content.

## Requests and body sources

`FetchRequest<'uri, 'method, 'headers, 'policy>` contains a validated URI, an explicit method,
ordered validated request headers, and the existing request policies. It contains no prepared
request bytes, transport state, or body producer.

`FetchRequest.make(uri, method, headers, headerPolicy, version, continuePolicy, limits,
maxHeadBytes, maxCredentialBytes)` borrows the semantic values supplied by the caller.
`FetchRequest.get(uri)` constructs GET with empty caller headers, HTTP/1.1, disabled 100-continue,
the standard request header policy, the standard client header-value limits, a 65536-byte request
head cap, and an 8192-byte credential cap. Passing bytes or a producer to an operation does not
change either request's method to POST.

Request preparation remains with the existing HTTP owners. Host, request-target form, framing,
origin authentication, proxy authentication, and generated Accept-Encoding are not caller-built
wire fields. Every redirect attempt is prepared again from the semantic request and current URI.

The operation surface is the destination/source product:

| Destination | Empty          | Borrowed repeatable bytes | Affine producer  | Replay factory  |
| ----------- | -------------- | ------------------------- | ---------------- | --------------- |
| Sink        | `toSinkEmpty`  | `toSinkBytes`             | `toSinkOneShot`  | `toSinkReplay`  |
| Collect     | `collectEmpty` | `collectBytes`            | `collectOneShot` | `collectReplay` |
| Discard     | `discardEmpty` | `discardBytes`            | `discardOneShot` | `discardReplay` |

Empty and Bytes operations expose no producer or factory generic, failure row, requirement row, or
placeholder witness. OneShot operations expose only the selected producer's failures and
requirements. Replay operations expose the replay factory and producer families. The factory lends
one fresh scoped producer for every retained-body attempt, including attempt zero.

The argument order is fixed across each source family. Empty operations take `(fetch, request,
options, destination)`. Bytes, OneShot, and Replay insert their `bytes`, `producer`, or `factory`
after `request`. For a sink the destination is `sink`; for collection it is the `usize`
`maxBodyBytes`; for discard it is the `u64` `maxDiscardBytes`.

OneShot ownership is affine. An attempted write consumes its authority even if an early response,
producer failure, redirect, or later response failure prevents whole-operation success. Fetch does
not buffer an entire OneShot producer to make it replayable. Redirect transitions that retain a
body therefore require replay authority after the first attempted OneShot write.

## Destinations

All destinations use the same final-response delivery and verification path. They differ only in
what happens to each selected representation chunk.

### Sequential sink

Each `toSink*` operation lends immutable `ResponseMetadata`, one borrowed current byte chunk, and
the original absolute deadline to the sink. Calls are sequential. Fetch waits for one callback to
succeed before reading or offering another chunk, and neither the chunk nor deadline borrow can
escape its callback. `None` permits an unbounded sink wait.

Sink success means the complete offered chunk was accepted. `deliveredBodyBytes` advances only
after that success. On sink failure, the destination context reports the count accepted by earlier
successful calls and the current offered length. It does not estimate how much of the current chunk
became externally visible.

Sink output is provisional. A prefix accepted by the destination remains externally visible if a
later sink, framing, decoder, checksum, trailer, transport, or finish operation fails. Fetch does
not provide transactional external effects.

### Bounded collection

Each `collect*` operation requires `maxBodyBytes` and returns `CollectedResponse` only after the
selected representation, framing, trailers, and response finish complete successfully. The value
owns a `FetchResult` and the collected `Bytes` body.

The collector checks its cap before allocation growth or copying beyond it. It does not reserve an
untrusted Content-Length beyond the remaining admitted budget. `maxBodyBytes = 0` accepts only an
empty selected representation. Failure releases the private partial buffer and publishes no
partial `CollectedResponse`; this atomic publication does not undo bytes already sent over the
network.

### Bounded discard

Each `discard*` operation requires `maxDiscardBytes`, stores no response body, and returns
`FetchResult` only after the selected representation, framing, trailers, decoder, and response
finish verify. The cap counts delivered representation bytes. Zero accepts only an empty selected
representation.

Reaching the discard cap before completion is an error and makes the connection ineligible for
reuse. Discard is not redirect intermediate draining: it cannot convert truncation into success,
does not stop at the response head, and performs no implicit cleanup read. Head-only handling
belongs to `silk.http.exchange`.

## Options and defaults

`FetchOptions` admits all policy and finite storage bounds before route selection, pool checkout,
resolution, trust loading, or transport contact. `FetchOptions.defaults()` returns these fetch-owned
values in addition to the standard HTTP, redirect, content, inflate, and Zstandard limits:

The independent policy defaults are:

| Field                                     | Default                                            |
| ----------------------------------------- | -------------------------------------------------- |
| `redirect`                                | `Policy.defaults()` with Manual redirect selection |
| `content`                                 | `Content.Mode.Raw`                                 |
| `pool`                                    | `PoolMode.UseContextPool`                          |
| `proxy`                                   | `ProxyMode.InheritContext`                         |
| `deadline`                                | `Option.None`                                      |
| `http`                                    | `Client.Limits.defaults()`                         |
| `maxEncodedBodyBytes`                     | 16777216                                           |
| `maxDeliveredBodyBytes`                   | 16777216                                           |
| `maxOwnedMetadataBytes`                   | 278528                                             |
| `maxBufferedBytes`                        | 16384                                              |
| Content encoded/intermediate/decoded caps | 16777216 each                                      |
| Content owned-byte cap                    | 2097152                                            |
| Content coding depth                      | 4                                                  |
| Content intermediate buffer               | 16384                                              |

`PoolMode.UseContextPool` uses a compatible pool retained by the explicit client context and
otherwise opens Fresh. `PoolMode.Fresh` never checks out or publishes through a pool.
`ProxyMode.InheritContext` recomputes only the explicit context route for every redirect origin.
`ProxyMode.Direct` bypasses configured routing without an environment lookup.

There is no unlimited numeric sentinel. `Option.None` means no absolute operation deadline.

Changing one mode does not change another. Manual does not follow redirects. Raw does not decode
content. Fresh bypasses a compatible pool. Direct bypasses configured proxy routing. A
caller-selected Direct operation performs no environment proxy lookup.

Finite options include the existing head/parser, framing, trailer, content-decoding, and redirect
limits together with `maxEncodedBodyBytes`, `maxDeliveredBodyBytes`,
`maxOwnedMetadataBytes`, and positive `maxBufferedBytes`. Collection and discard add their required
destination caps per call. Zero byte budgets permit only empty corresponding content;
`maxBufferedBytes` must be positive. Each wire, encoded, decoder-intermediate, decoded, delivered,
destination, metadata, and working-buffer bound remains separate and uses checked arithmetic.

## Response metadata and results

Fetch copies the final URI, status, ordered wire response headers, and representation metadata
before the first body read invalidates the response head. That immutable header-only
`ResponseMetadata` is the same view lent to every sink callback. It never gains trailers later.

| `ResponseMetadata` field | Meaning                                                       |
| ------------------------ | ------------------------------------------------------------- |
| `finalUri`               | Independently owned final URI                                 |
| `head`                   | Owned status, reason, and ordered wire headers                |
| `representation`         | Applied content plan plus completion and delivered-byte facts |
| `ownedBytes`             | URI and head payload plus owned index storage                 |

`RepresentationMetadata.applied` is the exact `Content.AppliedPlan`. Sink callbacks observe
`completed = false` and `deliveredBytes = Option.None` because whole-response completion is not yet
known. The published result observes `completed = true` and
`deliveredBytes = Option.Some(total)`. Neither state adds trailers to `ResponseMetadata` or rewrites
the received headers.

After verified body, framing, and trailer completion, `FetchResult` owns:

| Field                | Meaning                                                    |
| -------------------- | ---------------------------------------------------------- |
| `metadata`           | Final owned header-only metadata                           |
| `trailers`           | Final ordered trailers, copied after content completion    |
| `redirectCount`      | Redirects followed before the final response               |
| `encodedBodyBytes`   | Deframed encoded bytes accepted by the content layer       |
| `deliveredBodyBytes` | Selected representation bytes accepted by the destination  |
| `ownedMetadataBytes` | Final URI, head, and trailer payload-plus-index accounting |

`FetchResult` contains no body buffer. `CollectedResponse` adds the separately owned collected body.
All returned metadata outlives the live response and connection owners.

Wire headers preserve received meaning and order. Decode mode does not rewrite wire
Content-Length to a decoded or delivered length. Representation metadata records content selection,
coding, and completed delivered facts separately.

Owned metadata accounting includes URI, header, and trailer payload plus their index storage. It
excludes only allocator bookkeeping. `maxOwnedMetadataBytes` is checked before an oversized owner
is published; trailers use the budget remaining after the URI and response headers were copied.

## Raw and decoded content

Raw mode delivers received representation bytes after HTTP message deframing. It preserves wire
content metadata and permits unsupported content-coding names as metadata. It does not decode or
sniff the body.

Decode mode uses the coding set, ordering, windows, checksums, completion rules, and limits from
`silk.http.content`. Unsupported coding is an error. Fetch generates Accept-Encoding only
for configured supported codings, only in Decode mode, and only when caller headers contain no
Accept-Encoding field.

Method and status rules that forbid a response body still reach verified empty completion. Fetch
does not retry with another decoder or combine coded and decoded accounting.

## Redirects, proxies, and pools

Manual mode returns the first completed response. Follow mode delegates method, body replay,
Location, origin, downgrade, header sanitization, loop, history, intermediate response, and hop
limits to [`silk.http.redirect`](http-redirects.md).

For every current redirect origin, InheritContext recomputes routing from the immutable client
context. Direct bypasses that configured routing without consulting the environment. Direct and
Tunnel routes prepare origin-form requests; Forward prepares absolute-form requests. A Tunnel
completes CONNECT before origin TLS. Proxy credentials remain route-owned and never become origin
headers or tunneled HTTP fields.

Fresh opens an owner outside the context pool. UseContextPool checks out through a compatible
explicit pool when one exists and otherwise follows the context's defined Fresh path. Pool keys
retain conservative route and security identity. Redirects can therefore select a different key,
route, or connection for each origin. A request cannot replace the context's provider, TLS
verification, ALPN, trust, proxy credential identity, or pool identity.

Unsupported or incompatible target, route, transport, trust, or pool composition fails before
contact. No failure falls back to plaintext, Direct routing, another proxy, or an ambient setting.

## Deadlines

The caller supplies one optional absolute deadline. Fetch passes the same value through validation,
route selection, pool checkout, connection acquisition, TLS, request production, redirects, final
head parsing, body delivery, sink waits, trailers, and explicit finish. Redirects and reused
connections do not renew it. A provider-specific shorter phase limit can clamp the operation but
cannot extend it.

`None` explicitly permits indefinite waiting. An absolute deadline does not claim to preempt
synchronous resolution, trust loading, or arbitrary callback CPU work.

## Status and errors

A completed HTTP 4xx or 5xx response is a successful `FetchResult` when its selected body,
trailers, and finish complete. A final 101 response or successful CONNECT returns
`UnsupportedSwitchingResponse`; Fetch transfers no duplex authority and the connection is not
reused.

`FetchError` records bounded safe context for URI, Route, Connect, Request, Redirect, Head, Decode,
Destination, or Finish phases:

| Field                | Meaning                                                          |
| -------------------- | ---------------------------------------------------------------- |
| `phase`              | `FetchPhase` owning the failure context                          |
| `reason`             | Fetch-owned `FetchReason`                                        |
| `status`             | Final status when known without retaining the response           |
| `uri`                | Independently copied current URI when available within the bound |
| `deliveredBodyBytes` | Bytes accepted before the failing operation                      |
| `offeredBodyBytes`   | Current chunk length for a destination failure, otherwise zero   |

`FetchReason.InvalidOptions` rejects inconsistent or inadmissible finite options.
`FetchReason.SizeOverflow` reports unrepresentable checked accounting.
`FetchReason.DestinationRejected` marks a caller sink rejection inside its
`DestinationFailure<E>` wrapper. `FetchReason.Content` owns the exact `FetchContentError`, including
content progress and a bounded copy of any unsupported coding token, so it cannot borrow the
released response head.
`FetchReason.LimitExceeded` includes the exact `FetchLimit`, inclusive `allowed` value, and rejected
cumulative `attempted` value. `FetchReason.UnsupportedSwitchingResponse` includes the final 101 or
successful CONNECT status.

`FetchLimit` distinguishes encoded body, delivered body, owned metadata, working buffer,
collection, and discard bounds. `DestinationFailure<E>` retains the original sink error in `error`
and the fetch-owned progress in `context`.

URI, route, client, pool, resolver, socket, TLS, redirect, framing, decoder, checksum, allocation,
limit, finish, producer, factory, sink, and callback failures remain distinct typed alternatives.
Generic failures are not converted to strings or erased to `unknown`.

## Resource release

The active source or replay-factory loan, redirect attempt, response, decoder, destination buffer,
pool lease, reservation, and connection owner are scoped. Each published owner releases once after
success, typed failure, defect, or structured cancellation within the providers' existing cleanup
guarantee.

Automatic cleanup is nonparking. It drops private buffers, refunds reservations, and closes or
evicts transport ownership without reading, draining, retrying, flushing, or gracefully shutting
down the network. Cleanup close failures are suppressed and do not replace the protected outcome.
Explicit finish, flush, or shutdown failures remain observable. Only the HTTP client and pool reuse
state machines can publish a successfully completed owner as idle.

## Native HTTP and HTTPS

Native composition uses `silk.http.fetch_native.Context<'configuration>`. `Context.make(route,
options, limits)` owns one fresh native acquisition context without a pool.
`Context.makeWithPool(route, options, limits, pool)` additionally copies one compatible direct-pool
handle before publishing the context; trust or allocation failure leaves the source handle valid.
`Context.hasPool()` reports whether the copied pool capability is present.

The route, native options, and HTTP limits make provider, TLS, ALPN, and proxy credential choices
explicit. The selected `TrustSource` is a lexical capability, and `Options.trust` supplies its
finite load bounds. Fetch options add the absolute deadline, destination cap, content mode,
redirect mode, pool mode, and proxy mode. HTTPS authenticates the current original origin; a
redirect or Tunnel does not change that identity to a proxy or previous origin. Trust is selected
by the application context rather than the request.

The following call-site excerpts intentionally use `silk,ignore`: they show policy composition
without creating another separately compiled documentation program. `httpRoute` and `httpsRoute`
are already admitted sealed routes, `trust` is the caller-selected lexical `TrustSource`, and the
remaining standard allocator, clock, random, resolver, and socket capabilities come from the
application's explicit native provider graph.

For plaintext HTTP, this example chooses fresh native acquisition, direct routing, Manual
redirects, Raw content, a finite absolute deadline, and a 1 MiB collection cap:

```silk,ignore
import silk.core.effect {Effect}
import silk.http.exchange as Client
import silk.http.exchange_native as Native
import silk.http.content as Content
import silk.http.fetch {Fetch, FetchOptions, FetchRequest, PoolMode, ProxyMode}
import silk.http.fetch as HttpFetch
import silk.http.fetch_native as FetchNative
import silk.http.redirect as Redirect
import silk.option {Option}
import silk.tls.trust_source {TrustSource}

let mut nativeOptions = Native.Options.defaults()
nativeOptions.trust = trustLimits
let context = FetchNative.Context.make(
  httpRoute,
  move nativeOptions,
  Client.Limits.defaults(),
)
let mut fetch = Fetch.make(move context)
let request = FetchRequest.get(httpUri)
let mut options = FetchOptions.defaults()
options.redirect = Redirect.Policy.defaults() // Manual
options.content = Content.Mode.Raw
options.pool = PoolMode.Fresh
options.proxy = ProxyMode.Direct
options.deadline = Option.some(deadline)

let response = run HttpFetch.collectEmpty(
  &mut fetch,
  move request,
  move options,
  1048576,
) |> Effect.provideMut<TrustSource>(&mut trust)
```

For HTTPS, this example chooses the copied compatible native pool, inherited sealed routing,
Follow redirects, Decode content, the same kind of finite absolute deadline, and an 8 MiB discard
cap. `followPolicy` is an admitted `Redirect.Policy` constructed with `Redirect.Mode.Follow`, and
`replayFactory` supplies a fresh scoped producer for every retained-body attempt:

```silk,ignore
let mut nativeOptions = Native.Options.defaults()
nativeOptions.trust = trustLimits
let context = run FetchNative.Context.makeWithPool(
  httpsRoute,
  move nativeOptions,
  Client.Limits.defaults(),
  &pool,
)
let mut fetch = Fetch.make(move context)
let request = FetchRequest.get(httpsUri)
let mut options = FetchOptions.defaults()
options.redirect = move followPolicy // Redirect.Mode.Follow
options.content = Content.Mode.Decode
options.pool = PoolMode.UseContextPool
options.proxy = ProxyMode.InheritContext
options.deadline = Option.some(deadline)

let response = run HttpFetch.discardReplay(
  &mut fetch,
  move request,
  move replayFactory,
  move options,
  8388608,
) |> Effect.provideMut<TrustSource>(&mut trust)
```

`FetchClient` is the target-neutral extension boundary for another acquisition context. Its one
attempt operation receives the semantic request, HTTP limits, pool mode, proxy mode, and unchanged
deadline and runs under the scoped hybrid redirect-attempt capability. Implementations must retain
the same response ownership and typed handler/acquisition rows; they cannot expose a live response
or transport through Fetch results.

## Exclusions and deliberate Zig differences

The [Zig HTTP client at pinned revision
`1bc89211`](https://codeberg.org/ziglang/zig/src/commit/1bc892110da738d6137b3f0b7e8e3a586ce09928/lib/std/http/Client.zig#L1205-L1278)
is comparison evidence, not fixture authority. Silk deliberately differs in these ways:

- Request content never changes the explicit method to POST.
- Request bodies use separate Empty, Bytes, OneShot, and Replay operations rather than one body
  source value.
- Sink output is sequential and provisional; collection and discard require independent finite
  destination caps.
- Redirect, content, proxy, and pool behavior are independently selectable and never ambient.
- Returned metadata is bounded, owned, ordered, and split into wire and representation views.
- One optional absolute deadline spans the entire operation rather than resetting per redirect.
- Completed 4xx and 5xx responses are results; switching and CONNECT duplex responses cannot escape.
- Cleanup never performs hidden network reads, drain, retry, flush, or graceful shutdown.

The actor does not provide a browser Fetch API, CORS, cookies, a cache, ambient proxy discovery,
automatic authentication discovery, automatic retry, concurrent racing, background work,
transactional sinks, protocol switching, WebSocket or CONNECT-duplex handoff, HTTP/2, connection
coalescing, HTTP/3, another parser or decoder, another socket or TLS implementation, or a dependency
on an affine Stream abstraction.

The target-neutral implementation lives in
[`http_fetch.silk`](../stdlib/silk/http/fetch.silk), with supported native
composition in
[`http_fetch_native.silk`](../stdlib/silk/http/fetch_native.silk).
The lower-level contracts are documented in [`silk.http.exchange`](http-exchange.md),
[`silk.http.redirect`](http-redirects.md), [`silk.http.proxy`](http-proxy-routing.md), and
[`silk.http.connection_pool`](http-connection-pooling.md). The normative delivery contract is the
`one-shot-http-fetch` OpenSpec.
