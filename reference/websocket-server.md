---
title: WebSocket server messages
description: Bounded unfragmented WebSocket server frames, scoped channel ownership, and finite close-handshake policy.
---

# WebSocket server messages

`silk.http.websocket_server` provides bounded message I/O after
`silk.http.websocket_upgrade.withUpgrade` has validated and flushed an HTTP WebSocket handshake. It
wraps the exact upgraded `BufferedDuplex`, including any first-frame bytes already read with the
HTTP request, and lends one affine `ServerWebSocket` to a higher-ranked callback.

This is deliberately an **unfragmented WebSocket profile**, not complete RFC 6455 support. It
accepts final Text, Binary, Close, Ping, and Pong frames. Continuation frames and any frame with
FIN clear fail with `UnsupportedFragmentation` and select close code 1003. Extensions,
compression, message streaming, client framing, listeners, routers, TLS servers, and native `wss`
are outside this actor.

## Scoped ownership

`withServer(channel, limits, use)` is the only way to create a server session. The callback may
use the socket only while the upgraded buffered channel is borrowed. The socket, its channel, and
any callback view cannot escape or be duplicated, and an ambient `ByteDuplex` cannot bypass the
session's serialized frame output.

After callback success, typed failure, or structured cancellation, the scope terminally closes the
same buffered provider without replacing the protected result. Cleanup is nonparking and does not
flush pending output or attempt a graceful WebSocket close. Fatal traps remain outside the
structured-cleanup guarantee.

This excerpt shows the intended nesting inside an accepted HTTP upgrade. The application decides
how many events to pump; `readEvent` never hides a loop that skips control events:

```silk,ignore
import silk.option {Option}
import silk.http.websocket_server {Limits}
import silk.http.websocket_server as WebSocketServer
import silk.http.websocket_upgrade as WebSocketUpgrade

let upgraded = run WebSocketUpgrade.withUpgrade(
  &mut request,
  upgradeLimits,
  Option.some(handshakeDeadline),
  decision,
  handleUpgraded,
)

// Inside handleUpgraded, `channel` is the exact upgraded BufferedDuplex.
let event = run WebSocketServer.withServer(channel, Limits.defaults(), handleSocket)
```

The excerpt is marked `silk,ignore` because `decision`, `handleUpgraded`, `handleSocket`, `request`,
and the provider graph belong to the surrounding HTTP application. It illustrates ownership and
operation order, not a second transport or executable fixture. `handleSocket` receives the scoped
`ServerWebSocket` and may call `readEvent`, a write operation, `sendClose`, or `finishClose`.

## Limits and state

`Limits.make(maxMessageBytes, maxCloseFrames, maxCloseBytes)` validates three positive finite
bounds. `Limits.defaults()` returns:

| Field             | Default | Meaning                                                  |
| ----------------- | ------: | -------------------------------------------------------- |
| `maxMessageBytes` |   65536 | Maximum Text or Binary payload                           |
| `maxCloseFrames`  |      32 | Aggregate peer frames consumed by one `finishClose` call |
| `maxCloseBytes`   |   65536 | Aggregate frame header, mask, and payload bytes consumed |

A zero field returns `InvalidLimits` with `LimitKind.MessageBytes`, `CloseFrames`, or
`CloseBytes` before the channel is borrowed or any I/O occurs. Close-handshake counter overflow is
reported against the affected frame or byte budget as `CloseLimitExceeded`.

The public `state(socket)` query returns exactly:

| State       | Meaning                                                              |
| ----------- | -------------------------------------------------------------------- |
| `Open`      | Data, control, and an initial Close frame may be written or read.    |
| `CloseSent` | A local Close was flushed; only `finishClose` may read peer frames.  |
| `Closed`    | The close handshake and terminal provider close completed.           |
| `Failed`    | A sticky terminal failure occurred; later operations perform no I/O. |

The session preallocates no message-sized storage. It retains only fixed frame-header, mask,
control, and close-metadata scratch. Text and Binary payloads use caller storage.

## Reading events

`readEvent(socket, output, deadline)` incrementally reads and validates exactly one masked client
frame. It returns one of:

- `Event.Text { count }` or `Event.Binary { count }`, identifying the initialized prefix of the
  caller's output;
- `Event.Ping { payload }` or `Event.Pong { payload }`, carrying independently owned
  `ControlPayload`; or
- `Event.PeerClose { data }`, carrying absent close data or an owned code and `CloseReason`.

Text is published only after the complete payload passes UTF-8 validation. A failed read may have
modified a prefix of `output`, but that prefix is unusable and no successful data event is
published. Control and close metadata are copied into fixed-capacity values, so later session
mutation cannot change a returned event.

Client frames must be masked, use zero RSV bits, use a supported opcode, and encode their length
canonically. Length validation remains `u64` until the value is proven representable and within
policy. A payload above `maxMessageBytes` returns `MessageTooLarge` before payload input; a legal
payload larger than `output` returns terminal `BufferTooSmall` without reading the payload or
claiming a peer protocol error.

Ping handling is observable and serialized: the server writes and flushes a byte-identical Pong
before publishing the Ping. Pong is surfaced to the application rather than skipped. Failure of an
automatic response publishes no event, retains the exact buffered or transport failure, and never
retries uncertain bytes.

## Writing messages

These operations write one final, unmasked server frame and flush it before success:

| Operation                                | Payload rule                        |
| ---------------------------------------- | ----------------------------------- |
| `writeText(socket, message, deadline)`   | Valid `string`, at most message cap |
| `writeBinary(socket, message, deadline)` | Bytes, at most message cap          |
| `writePing(socket, message, deadline)`   | At most 125 bytes                   |
| `writePong(socket, message, deadline)`   | At most 125 bytes                   |

The actor validates state and length before accepting the first frame byte, uses the minimal
7-, 16-, or 64-bit length form, and never masks server output. The caller's complete payload stays
borrowed through short writes and the final flush; the actor does not copy or coalesce a data
message.

If a write fails or is canceled after output begins, the session becomes `Failed`, closes
terminally, and does not retry the uncertain suffix or write fallback protocol bytes. A `Buffer`
failure records aggregate `frameAccepted` bytes alongside the exact nested `BufferError` and its
accepted/drained progress.

## Close data

`CloseData.make(code, reason)` validates and copies at most 123 reason bytes. `CloseData.code()`
returns the code, while `CloseData.reason()` returns the owned `CloseReason`; its bytes are exposed
through `CloseReason.asSlice`. Incoming control payloads use `ControlPayload.asSlice`.

Allowed incoming codes are assigned 1000 through 1003 and 1007 through 1014, plus application and
private codes 3000 through 4999. Reserved, pseudo, out-of-range, and unassigned codes are rejected.
The outgoing constructor applies the same rule and additionally rejects client-only 1010. Invalid
codes return `InvalidCloseData { reason: Code }`, reasons above 123 bytes return
`InvalidCloseData { reason: ReasonTooLarge }`, and invalid UTF-8 returns
`InvalidUtf8 { component: CloseReason }`.

An absent `CloseData` encodes an empty Close payload; the actor never synthesizes pseudo-code 1005.
A peer payload of exactly one byte is a protocol error. A valid peer Close is fully parsed before
reply. While `Open`, the server replies once with identical data, except that incoming 1010 is
answered as 1000 with an empty reason. `PeerClose` is published only after the reply flush and
terminal provider close succeed.

## Finishing a close

`sendClose(socket, data, deadline)` writes and flushes one optional local Close while `Open`, then
enters `CloseSent`. Repeating it in `CloseSent` or `Closed` succeeds without validating `data` and
without writing again. In `Failed`, it returns the sticky previous-failure classification.

`finishClose(socket, deadline)` requires a finite absolute `Instant`. It is iterative, never
recursive, and passes that same deadline to every partial read, automatic Pong, write, and flush.
It checks the clock before the first step and between frames rather than renewing a duration.

The operation counts every inbound frame and every header, mask, and payload byte against the two
close bounds. It may discard bounded data, answers Ping, counts and ignores Pong, and completes
only after a valid peer Close. Bound exhaustion returns `CloseLimitExceeded` and performs no
further drain. Clean byte-stream end before Peer Close is `Truncated`, not successful closure.

`finishClose` rejects `Open`, pumps only in `CloseSent`, succeeds without I/O in `Closed`, and
returns the sticky failure in `Failed`. A simultaneous peer Close emits no second Close frame.

## Errors and terminal behavior

`WebSocketError` keeps policy, protocol, state, and I/O failures distinct:

| Variant                    | Meaning                                                         |
| -------------------------- | --------------------------------------------------------------- |
| `InvalidLimits`            | A named public limit failed admission.                          |
| `InvalidState`             | An operation is unavailable in the current state.               |
| `PreviousFailure`          | A prior terminal failure; no new I/O occurs.                    |
| `BufferTooSmall`           | Caller capacity cannot hold one otherwise legal message.        |
| `MessageTooLarge`          | Peer data exceeds the configured message policy.                |
| `UnsupportedFragmentation` | Data FIN is clear or the opcode is Continuation.                |
| `ProtocolError`            | Mask, RSV, opcode, length, control, or close syntax is invalid. |
| `InvalidCloseData`         | Caller-provided close code or reason length is invalid.         |
| `InvalidUtf8`              | Text or close-reason bytes are not complete UTF-8.              |
| `CloseLimitExceeded`       | Close-frame or close-byte work reached its aggregate cap.       |
| `Truncated`                | The byte stream ended before a complete required frame.         |
| `Buffer`                   | Buffered I/O failed with exact progress.                        |
| `Transport`                | A direct terminal provider operation failed.                    |

The first failure returns its complete structured cause. Because `BufferError` and `ByteIoError`
are affine external errors, the session stores only a copyable `Failure` classification for later
`PreviousFailure` results. `Closed` and `Failed` remain distinct.

For unsupported fragmentation, protocol error, invalid UTF-8, and oversized peer messages, the
actor may attempt one mapped Close (1003, 1002, 1007, or 1009) only when the originating operation
received an unreached `Some(deadline)` and output is still unambiguous. No deadline, an expired
deadline, partial output, truncation, caller capacity failure, or close-limit exhaustion skips
graceful output and closes terminally. A graceful-Close or cleanup failure never replaces the
primary error, and no failure path reads more peer bytes.

## Standards, vectors, and exclusions

The frame profile follows [RFC 6455 section 5](https://www.rfc-editor.org/rfc/rfc6455.html#section-5),
with close-code handling from [section 7.4](https://www.rfc-editor.org/rfc/rfc6455.html#section-7.4)
and UTF-8 requirements from [section 8.1](https://www.rfc-editor.org/rfc/rfc6455.html#section-8.1).
The RFC section 5.7 masked Text vector
`81 85 37 fa 21 3d 7f 9f 4d 51 58` decodes to `Hello`; the corresponding minimal unmasked server
frame is `81 05 48 65 6c 6c 6f`.

The committed acceptance vectors independently derive the canonical length-form boundaries 125,
126, 65,535, and 65,536 and record each negative vector's purpose. They distinguish WebSocket
message fragmentation from arbitrary fragmentation of transport reads and short writes. The same
scripted upgrade-plus-session source is intended for native execution and one LLVM-to-Wasm leg;
the profile requires no compiler-known WebSocket operation.

This actor does not provide continuation assembly, fragmented messages, extensions,
permessage-deflate, compression, message streaming, a `Stream` adapter, a ping timer, ambient
concurrency, a client API, listener or router ownership, a server framework, TLS-server setup,
native `wss`, or an automatic retry path.

The implementation lives in
[`websocket_server.silk`](../stdlib/silk/http/websocket_server.silk) and uses
the scoped upgrade actor in
[`websocket_upgrade.silk`](../stdlib/silk/http/websocket_upgrade.silk) plus
the shared buffered channel in
[`buffered_duplex.silk`](../stdlib/silk/io/buffered_duplex.silk). The
normative contract is the
`websocket-server-messages` OpenSpec.
