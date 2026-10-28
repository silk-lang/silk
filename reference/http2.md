# HTTP/2

Silk implements HTTP/2 connections in ordinary standard-library source. The protocol is RFC 9113,
with HPACK field compression from RFC 7541. Both client and server connections use the same state
machine. No native HTTP library or compiler intrinsic implements the protocol.

## Select an API

| Module | Use |
| --- | --- |
| [`silk.http.http2`](stdlib/http2.md) | Drive a connection with incoming and outgoing bytes, including several concurrent streams. |
| [`silk.http.http2_connection`](stdlib/http2-connection.md) | Drive the connection over the existing `HttpTransport` service, with buffering and absolute deadlines. |
| [`silk.http.hpack`](stdlib/hpack.md) | Encode or decode complete field blocks with a connection's compression context. |
| [`silk.http.http2_frame`](stdlib/http2-frame.md) | Read and write frame headers and use the protocol's error codes. |
| [`silk.http.http2_headers`](stdlib/http2-headers.md) | Validate request, response, or trailer fields independently. |

The existing `Http`, HTTP/1.x exchange, HTTP/1.x server, and HTTP/1.x connection-pool APIs retain
their documented protocol. Select `silk.http.http2` or `silk.http.http2_connection` when the application needs
HTTP/2 streams. The HTTP/2 connection itself multiplexes requests; no HTTP/1.x pool lease is involved.

## Connection establishment

For cleartext, agree on HTTP/2 before sending the client preface. RFC 9113 uses prior knowledge;
it removed the old `h2c` HTTP/1.1 Upgrade exchange.

For TLS, offer the protocol returned by `silk.http.http2_connection.protocol()` in
`AlpnConfig.Offered`, with `required: true`. Authenticate the peer with the existing TLS client and
trust source. `requireAlpn` checks that the authenticated connection selected `h2`. Supply the
resulting `OwnedConnection` through `silk.http.transport.secured`. The Silk TLS client uses TLS 1.3.
A server can supply an accepted plain connection or an already established TLS byte transport.

`Connection.make` queues the client preface when appropriate and initial SETTINGS. `Driver.make`
also allocates a transport read buffer. Neither operation performs I/O. The peer's first frame must
be a non-ACK SETTINGS frame. Setting reductions take effect on receive windows and the HPACK table
after acknowledgment, so data sent with the initial defaults remains valid while SETTINGS is in flight.

## Drive streams

1. Create one connection per transport and retain it until shutdown.
2. On a client, call `Connection.open` with request fields. The returned identifier belongs to that request.
3. On a server, receive `Event.Headers` and answer its stream with `sendHeaders`.
4. Send body bytes with `sendData`. It returns the number accepted. Retain the suffix until more credit
   or output space is available. END_STREAM is queued only when the complete supplied slice fits.
5. Receive `Event.Data` and call `release` after the application consumes those bytes. Padding credit
   is returned automatically. Receiving more bytes does not itself grant the sender more credit.
6. End a message with the last DATA frame or a trailing field section. Trailers require END_STREAM.

With `Driver`, borrow the protocol through `Driver.connection`, then call `Driver.next`. The driver
flushes output, handles partial transport writes, retains unread input, and returns one event. A
`None` result means clean EOF; incomplete messages or frame bytes at EOF fail. Call `Driver.flush`
when output must be sent without waiting for another event.

With `Connection` directly, send `Connection.output` in order and call `consumeOutput` with the
number actually sent. Feed a wire fragment to `receive`, then advance it by `Progress.consumed`.
A call produces at most one event, so continue with any unconsumed bytes. All wire buffering and
field lists have explicit limits. Queue exhaustion is reported instead of growing output without a bound.

## Message semantics

Field names must be lowercase tokens. Pseudo-headers precede ordinary fields and occur at most
once. Request and response pseudo-headers cannot be mixed; trailers cannot contain pseudo-headers.
Connection-specific fields are rejected. Content-Length is checked against the body, with the
HEAD and bodyless response rules. Informational responses can precede the final response.

A CONNECT request contains `:method = CONNECT` and `:authority = host:port`, without `:scheme` or
`:path`. After a successful response, DATA carries tunnel bytes. Each direction closes independently
with END_STREAM; trailing HEADERS on the established tunnel are rejected.

Client push is disabled by default. An enabled client accepts promises only for the exact scheme
and authority of the associated request. It rejects other authorities on the promised stream.
Use `reset` to cancel an unwanted push. A server uses `push` to reserve a stream, then `sendHeaders`
and `sendData` to send its response. Promised requests must be safe, cacheable GET or HEAD requests
without content. The application remains responsible for response cache policy.

HPACK decoding accepts indexed fields, all literal forms, dynamic table updates, and the complete
Huffman alphabet. The encoder uses indexed fields and literal byte strings; Huffman encoding is
optional under RFC 7541. Sensitive fields use the never-indexed representation and never enter the
encoder's dynamic table. Keep independent compression contexts for the two connection directions.

## Errors and shutdown

A malformed stream queues RST_STREAM and returns `Event.StreamError`, including the consumed byte
count. Other streams remain usable. Frames that race with a recent local reset are ignored while
HPACK and connection flow control stay synchronized. Recent closed stream records are bounded.

A connection error queues GOAWAY, returns `ProtocolError`, and makes the protocol terminal. Flush
that output before closing. `Driver.close` provides a bounded drain with an absolute deadline, which
allows GOAWAY to reach the peer before a TCP close discards unread input.

`shutdown(NO_ERROR, ...)` stops new streams and allows existing streams to finish. A received GOAWAY
reports the last stream the peer might have processed. Requests above that identifier need an
application retry decision; the connection does not replay them. Repeated local GOAWAY frames never
increase their last-stream identifier. The application supplies deadlines and calls `settingsTimeout`
if the initial SETTINGS acknowledgment does not arrive in time.

Unknown frame types, settings, flags, and reserved bits follow the RFC's extension rules. The
obsolete PRIORITY frame is validated and ignored; RFC 9113 does not require a priority scheduler.

## Evidence

The native corpus covers RFC HPACK request and response sequences, every Huffman symbol, malformed
encodings, fragmented frames, multiplexing, flow control, push, trailers, CONNECT, reset races,
SETTINGS acknowledgment races, and protocol errors. The native interoperability fixture checks
both client/server directions against Node/nghttp2, authenticated TLS with `h2` ALPN, and rejection
of an ALPN mismatch. Selfhost CI also runs all 147 strict h2spec 2.6.0 tests. Because h2spec targets
RFC 7540, separate corpus cases cover changed RFC 9113 rules, including server ENABLE_PUSH = 0.
