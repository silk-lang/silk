---
title: HTTP redirects
description: Bounded redirect policy, replay sources, authority changes, scoped cleanup, and final response ownership.
---

# HTTP redirects

Use `silk.http.redirect` when one HTTP operation can follow redirect responses. The actor rebuilds
each request from semantic input. It does not parse a serialized request or retry transport
failures. One scoped operation owns URI history, body replay state, intermediate responses, and the
final response callback.

Redirect handling is target-neutral. An attempt client selects the physical route and lends one
streaming HTTP exchange. Native, proxy-aware, pooled, and higher-level fetch clients can implement
that boundary without changing redirect policy.

## Policy and defaults

`Policy.defaults()` uses these defaults:

| Policy                      | Default     |
| --------------------------- | ----------- |
| Mode                        | Manual      |
| Maximum redirects           | 10          |
| Maximum raw/resolved URI    | 8192 bytes  |
| Maximum history storage     | 90112 bytes |
| Cross-origin transition     | Deny        |
| HTTPS-to-HTTP downgrade     | Deny        |
| POST after 301 or 302       | Preserve    |
| Previous response           | Close       |
| Cross-origin custom headers | Empty       |
| Sensitive custom headers    | Empty       |

Policy construction validates every count, byte capacity, and size calculation before contact.
Header-name lists are bounded and case-insensitive. A name cannot be in both the cross-origin safe
list and the sensitive list.

Manual returns the first response through the final callback. It does not validate Location, even
when the response has a redirect status. Follow selects only 301, 302, 303, 307, and 308. Status 304
and all other statuses are final responses, and so is a selected status with no Location field
(RFC 9110 section 15.4): it has nowhere to go. If Follow has no remaining hop capacity, the first
selected redirect fails with `HopLimit`.

## Method and content transitions

The selected status controls the next method and content:

| Status  | Next method                                                       | Next content                            |
| ------- | ----------------------------------------------------------------- | --------------------------------------- |
| 301/302 | Preserve by default. `ToGet` changes exact uppercase POST to GET. | Preserve unless POST changes to GET.    |
| 303     | Preserve HEAD; use GET for every other method.                    | Drop.                                   |
| 307/308 | Preserve.                                                         | Preserve and require replay capability. |

An extension method is not POST. The 301/302 `ToGet` policy does not change it. When a transition
drops content, the operation does not call a producer or replay factory. It removes content length,
transfer coding, content type/coding/language/location, digest, trailer, and Expect fields. The
streaming client then generates framing for the body-free request.

## Request and replay ownership

The redirect request retains semantic URI, method, headers, header policy, HTTP version, continue
policy, and request limits. A `PreparedRequest` is not sufficient input because it contains emitted
bytes and admission identity, not the state needed to build another hop.

Four source-specific operations make replay authority explicit:

- `Redirect.withEmptyResponse` selects empty framing. It has neither a producer nor source error or
  requirement rows.
- `Redirect.withBytesResponse` borrows immutable caller bytes for the complete operation and
  creates a zero-resource cursor for each retained-body attempt.
- `Redirect.withOneShotResponse` moves one affine producer and exposes only that producer's error,
  requirement, and conformance rows.
- `Redirect.withReplayResponse` moves a replay factory and exposes only the factory and producer
  error, requirement, and conformance rows. The factory creates and releases one fresh scoped
  producer for every attempt, including the first attempt.

Empty and borrowed-byte calls require no placeholder producer, replay factory, or phantom source
witness. All four operations use the same private scoped iterative engine; the operation-specific
surface changes only source ownership and the source channels present in its public contract.

A retained-body redirect after OneShot returns `ReplayUnavailable` before the next contact. An
early response does not restore OneShot authority. The producer can have external effects before
the client observes upload progress.

Each producer declares its framing and known length. The redirect operation checks that metadata
for every attempt and counts observed content. A mismatch returns `ReplayContractMismatch`. The
library does not buffer complete content, compare attempts, copy affine producers, or manage file
offsets. Equal replay content remains the caller's promise.

## Location, fragments, and loops

A followed response must contain exactly one Location field; duplicate fields return
`LocationAmbiguous`. `resolveLocation` itself returns `LocationMissing` when the field is absent. An empty Location is a valid URI
reference and can identify the current target.

The operation copies Location while the response head is live, validates the raw limit and percent
escapes, and resolves it through `silk.uri.uri`. It accepts only HTTP or HTTPS with a valid host and
effective port. User information is invalid. Both the raw reference and independently owned result
use the URI byte limit, including the resolver's conservative capacity reservation.

HTTP adds one rule above RFC 3986 resolution: if Location has no fragment, the new URI inherits the
current fragment. A present empty fragment replaces the old fragment. Fragments remain final-URI
metadata and never enter the request target.

One history key contains the transformed method, normalized origin, and exact encoded path/query.
An empty path is `/`. The key excludes the fragment and preserves percent-escape spelling. Method
membership prevents POST followed by 303 GET at the same URI from becoming a false loop. Another
GET for that key returns `RedirectLoop` before contact. The hop limit still terminates aliases that
the key does not equate.

## Origins and header removal

An origin contains the normalized scheme, canonical host identity, and effective port. A parent or
child domain and a changed port are cross-origin. Cross-origin Deny stops before route acquisition.
Allow rebuilds Host and target, selects the new physical endpoint, and recomputes HTTPS identity,
SNI, and proxy routing. HTTPS-to-HTTP also requires downgrade Allow.

Every hop removes Connection, Keep-Alive, TE, Trailer, Transfer-Encoding, Upgrade,
Proxy-Connection, and each extension named by the previous Connection field. The request actor
regenerates required framing and connection fields.

For a cross-origin hop, the operation starts from this permitted set: Accept, Accept-Encoding,
Accept-Language, User-Agent, configured safe custom fields, and content type/coding/language fields
that a retained body needs. It then removes Authorization, Cookie, Proxy-Authorization, Origin,
Referer, and every configured sensitive field. The removal has final precedence; an allowlist
cannot retain those fields.

The same cross-origin transition resets generated Host policy to the normalized destination
default and removes generated authorization. Explicit User-Agent and Accept controls remain because
they are in the fixed safe set. This policy rebuild prevents credentials or an initial explicit Host
from reappearing when `silk.http.request` generates the next head.

The operation does not derive credentials from Location user information. It does not apply a DNS
suffix rule, cookie jar, or implicit referrer policy.

## Intermediate responses and deadlines

The operation validates the next URI, method, replay authority, headers, route, and limits before
the next contact. It then releases the current attempt and producer scopes before it acquires the
next connection.

Close is the default previous-response policy. It does not drain the response, and the incomplete
exchange loses reuse authority. Drain uses a finite aggregate wire-byte cap and a finite deadline
clamped to the operation deadline. The count includes chunk extensions and trailers. Reaching the
cap closes that connection and can continue to the next hop. Malformed framing, a read failure, or
deadline expiry stops the redirect operation.

The caller supplies one optional absolute deadline. Every routed attempt, CONNECT, TLS operation,
and intermediate drain reuses that same absolute deadline; no hop receives a new duration. A body
producer, replay factory, or response callback can perform its own effects, but those interfaces do
not receive the operation deadline automatically. Success, source or callback failure, transport
failure, and structured cancellation release each active source, response, lease, and transport
once without replacing the protected result.

## Proxy-aware attempts

For each new origin, a proxy-aware attempt client calls `Route.recompute` under the same immutable
configuration. Direct and Tunnel routes use origin-form requests. Forward routes use the sealed
absolute-form preparation path. The selected route remains the only source of
`Proxy-Authorization`; redirect header state never contains that credential.

An HTTPS Tunnel completes CONNECT before origin TLS. TLS authenticates the redirected origin, not
the proxy or a previous origin. A route, connection, authentication, or TLS failure does not fall
back to Direct and does not start a parallel attempt.

## Final response and errors

When orchestration reaches a selected final response, `Redirect.withEmptyResponse`,
`Redirect.withBytesResponse`, `Redirect.withOneShotResponse`, and `Redirect.withReplayResponse`
call the final callback exactly once with the live final exchange, final owned URI, and redirect
count. Policy, source, acquisition, or client failure before a final response does not invoke it.
The callback can borrow those values only for its scope. Its success, failure, and requirements
remain exact; the redirect actor does not wrap them as unknown values.

Redirect policy distinguishes `InvalidPolicy` for inadmissible policy values, `NameListOverlap` for
a name admitted as both safe and sensitive, `SizeOverflow` for checked storage arithmetic,
`LimitExceeded` for inclusive finite bounds, `LocationMissing`, `LocationAmbiguous`,
`LocationInvalid`, `RedirectSchemeDenied`, `RedirectOriginDenied`, `DowngradeDenied`, `HopLimit`,
`RedirectLoop`, `ReplayUnavailable`, and `ReplayContractMismatch`. Each policy failure owns only
bounded hop, status, and URI context. Existing client, URI, allocation, source, acquisition, and
callback failures remain separate channels. A failed Follow operation never returns the selected
redirect response as success.

## Standards and deliberate Zig differences

The request-transition and Location fixtures derive independently from
[RFC 9110 redirection status semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-15.4),
[RFC 9110 Location semantics](https://www.rfc-editor.org/rfc/rfc9110.html#section-10.2.2), and
[RFC 3986 reference resolution](https://www.rfc-editor.org/rfc/rfc3986.html#section-5.2). The shared
native acceptance source records the expected emitted bytes and reuses that same source for one
LLVM-to-Wasm leg.

The [Zig HTTP client at pinned revision
`1bc89211`](https://codeberg.org/ziglang/zig/src/commit/1bc892110da738d6137b3f0b7e8e3a586ce09928/lib/std/http/Client.zig#L1205-L1278)
is comparison evidence, not fixture authority. Silk deliberately differs in these ways:

- 301 and 302 preserve POST by default; changing POST to GET requires explicit `ToGet` policy.
- Cross-origin transitions and HTTPS-to-HTTP downgrade are denied by default.
- Header retention uses a bounded deny-last policy rather than an ambient browser credential model.
- Body replay authority is explicit. Silk does not infer repeatability from content type or source
  implementation.
- Intermediate draining is optional, finite, and wire-counted. Silk never starts an unbounded or
  background drain.

The profile does not provide transport retry, concurrent attempts, cookie, referrer, or permanent
redirect cache policy, browser URL behavior, IDNA, pooling, a new content decoder, or a dependency
on the higher-level Stream actor. It also introduces no compatibility alias, second prepared-request
representation, or compiler-known redirect operation.

The implementation lives in
[`http_redirect.silk`](../stdlib/silk/http/redirect.silk), with narrow
composition in [`http_exchange.silk`](../stdlib/silk/http/exchange.silk) and
the existing proxy/native actors. The normative delivery contract is the
`bounded-http-redirects` OpenSpec.
