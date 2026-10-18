---
title: Streaming HTTP client
description: Explicit request policy, owned sessions, scoped exchanges, and bounded plain or authenticated TLS transport.
---

# Streaming HTTP client

Use `silk.http_request` to prepare an origin-bound request and `silk.http_client` to send it through
one owned session. Request preparation copies the head before network output. The session retains
its concrete transport, parser storage, buffered input suffix, origin, HTTP version, and overall
absolute deadline. `makeOwned` returns that owner; `withOwned` lends it within a terminal-close
scope. `withConnected` borrows a caller-owned transport with explicit permission to close its logical
lease. Physical descriptor ownership stays with the outer owner.

## Prepare a request

`Origin.fromUri` accepts checked `http` and `https` hosts and ports. It rejects userinfo. The origin
retains the original host identity; resolution never replaces it with the selected IP address.
`HttpRequest.fromUri` emits `/` for an empty path, preserves the query, and excludes the fragment.
A prepared request cannot be sent over a session with a different origin or HTTP version.

Header policy distinguishes `Default`, `Omit`, and `Value`. Defaults generate the normalized Host,
`User-Agent: silk-http/1`, and `Accept: */*`. HTTP/1.1 cannot omit Host. Explicit Host must match the
origin's effective host and port. Body framing owns Content-Length and Transfer-Encoding. Policy
also owns Expect and Connection; supplying a second source fails before output. Other fields retain
their order. Direct requests reject Proxy-Authorization.

`Empty`, `KnownLength`, and HTTP/1.1 `Chunked` describe uploads. HTTP/1.0 cannot send an unknown-length
upload. Raw response handling adds no Accept-Encoding, follows no redirect, converts no status into
an error, and never retries or replays output.

## Explicit Basic credentials

`silk.http_basic.encodeInto` accepts caller-encoded username and password bytes plus scratch and
output buffers. It rejects a colon in the username and controls or DEL in either field. It checks
both capacities before changing output and allocates nothing. Non-ASCII character encoding belongs
to the caller. Basic is absent unless requested, remains bound to the prepared origin, and requires
TLS unless `AllowInsecureBasic` is explicit. This option does not change HTTPS peer verification.

```silk
import silk.http_basic as Basic
import silk.result {Result}
import silk.usize as usize

pub fn main() -> i32 {
  let mut scratch: [u8; 3] = [0, 0, 0]
  let mut output: [u8; 10] = [0, 0, 0, 0, 0, 0, 0, 0, 0, 0]
  let encoded = Basic.encodeInto(b"u", b"p", &mut scratch, &mut output)
  return match move encoded {
    Result<usize, Basic.BasicError>.Failure { error } => 1
    Result<usize, Basic.BasicError>.Success { value } => {
      if value != 10 { return 2 }
      if output[6] != 100 || output[7] != 84 || output[8] != 112 || output[9] != 119 {
        return 3
      }
      return 0
    }
  }
}
```

## Exchange stages

`withExchange` lends one exclusive exchange. Send the head, write payload prefixes, finish the
request and its trailers, then receive response heads and read the framed response. Finish the
response explicitly. An illegal operation fails with InvalidState before more output. Transport
failures preserve their plain or secured cause and known prefix progress.

`Require100` is HTTP/1.1-only and needs a finite absolute continue deadline. The client sends and
flushes Expect, then exposes bounded informational heads until 100 or a final response. Upload is
permitted only after 100. An early final response skips upload and prevents reuse. Expiry ends the
lease with ContinueTimeout; there is no timeout-triggered upload fallback. `Disabled` uploads before
receiving and does not promise concurrent early-response monitoring.

Informational responses have independent finite count and cumulative wire-byte bounds. The default
bounds are 16 heads and 64 KiB. Status 103 remains informational. Status 101 returns
UnsupportedUpgrade. Final 3xx, 4xx, and 5xx responses remain ordinary values.

Response heads borrow parser storage. A mutable exchange operation cannot occur while a head loan
is live; use `ResponseHead.copy` with `ValueLimits.maxOwnedBytes` when it must survive later
operations. Completed trailers remain separate from the initial fields; `Trailers.copy` provides
an independent owner under the same explicit header-copy limits. Framing consumes only its message, leaving any next-message suffix
in the session. Successful CONNECT uses only the exclusive tunnel handoff, which reads that suffix
first and permanently consumes ordinary HTTP reuse authority.

## Decode the current response

Select content decoding before reading or discarding any raw body bytes. The exchange builds the
coding plan from its own response head and request method, then feeds the same buffered wire body
through the existing bounded framing and content decoder. A copied head cannot substitute different
metadata for this operation. Selecting decoding twice, or mixing decoded and raw body operations,
fails with InvalidState.

Decoded output remains provisional until the codecs validate their checksums and the HTTP framing
boundary completes. A decoding failure prevents reuse even if earlier bytes were returned. This
explicit operation does not add Accept-Encoding or select a coding on behalf of the caller.

## Completion and release

Reusable completion requires a finished and flushed request, a complete response framing/trailer
boundary, and permitted persistence. Failure, cancellation, abandonment, close-delimited bodies,
framing anomalies, early final responses before upload, and tunnel handoff prevent reuse. Returning
with an unread body does not trigger a hidden drain. An explicit bounded discard uses a wire-byte
budget and the same deadline.

Terminal cleanup uses the nonparking Effect bracket. It runs after success, typed failure, and
structured cancellation or interruption without replacing the original outcome. Cleanup does not
flush, drain, or perform a graceful TLS shutdown. Repeated terminal close does not release a physical
resource twice. Fatal traps remain outside structured cleanup guarantees.

## Native HTTPS and deadlines

`silk.http_client_native.withConnection` resolves and connects an owned native socket. For HTTPS it
loads the selected trust snapshot inside the resource scope and authenticates the original origin
before any HTTP bytes. TrustSource, SystemClock, MonotonicClock, Random and Allocator remain explicit
requirements. HTTP/1.1 offers only `http/1.1`; absence is accepted by default and rejected under the
required policy. Other selections fail. HTTP/1.0 disables ALPN and a session rejects requests of a
different version.

One optional absolute monotonic deadline covers resolution, connection setup, TLS and HTTP. Phase
limits clamp against that mark; they never restart the remaining duration after trust loading.
The TLS pump checks the external mark after trust/state setup and before its first transport call.
The native resolver is synchronous: a hostname with an overall deadline fails UnsupportedDeadline
before dispatch. Numeric origins bypass hostname lookup. `None` permits unbounded elapsed time;
byte and memory budgets remain finite.

Native connections are admitted for Darwin ARM64 system libc and GNU Linux x86-64/ARM64 GNU libc.
Unsupported native profiles return UnsupportedTarget; deterministic source transports remain
available for portable execution. An explicit Unix path also requires the real HTTP authority;
there is no synthetic URI scheme.
