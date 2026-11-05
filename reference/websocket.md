---
title: WebSocket
description: WebSocket clients and servers, sessions, split halves for fibers, and the close handshake.
---

# WebSocket

Silk's WebSocket support (RFC 6455, version 13) has one frame codec that the client and the server
share, and a session that runs over any HTTP transport.

| Module | Use it for |
| --- | --- |
| `silk.http.websocket` | The sans-IO codec: frames, masking, fragments, Ping, Pong, and Close. |
| `silk.http.websocket_stream` | `WebSocket`, a session over an `HttpTransport`, and its split form. |
| `silk.http.websocket_client` | `handshake`, the client side of the opening handshake. |
| `silk.http.websocket_upgrade` | The server side of the opening handshake. |
| `silk.http.websocket_native` | `connect` for `ws` and `wss` URIs, and `split` for native sessions. |
| `silk.concurrency.channel` | Bounded channels between fibers. |

## Clients

`connect(uri, headers, options, native, trust)` opens a TCP or TLS connection to the origin of a
`ws` or `wss` URI, sends the handshake, and returns the open session. It checks
`Sec-WebSocket-Accept`, the upgrade fields, and the subprotocol that the server selected.
Client frames are masked with keys from the `Random` service.

To use a connection that you opened yourself, call `handshake` of `silk.http.websocket_client` on a
`silk.http.exchange` connection. Bytes that the server sent after the 101 response go to the
session.

## Servers

Inside a `silk.http.server` request callback, `withUpgrade` checks the request, asks your
`DecisionHandler`, and lends you the channel. Make a session over it with `channelTransport`.

For a connection that a listener accepted, `acceptOwned` reads the request head, asks the handler,
answers, and returns a session that owns the transport. A request that is not a valid handshake
gets an HTTP error response, and the transport is closed.

## Sessions

`WebSocket.readEvent` returns one event: a complete Text or Binary message, a Ping (already
answered), a Pong, or a Close (already answered). Fragmented messages are joined up to
`maxMessageBytes`. A frame that breaks a rule fails the session after it sends a Close with the
right code.

## Split sessions

Call `split` of `silk.http.websocket_native` (or `fromHalves` for other transports) to get a
`ReadHalf` and a `WriteHalf`. Give the reader to one fiber. Clone the writer for each fiber that
sends: sends are serialized, so frames are never mixed. The socket, and for `wss` the TLS session,
is split too, so a read that waits does not block a write.

The reader answers a Ping with a Pong and a Close with a Close. It sends the answer at once when no
writer is sending, or else the writer that is sending sends it next. After a writer sends Close,
the reader returns the Close of the peer.

## Example

The corpus program `corpus/native/websocket-relay` runs a server that accepts two clients over
loopback and forwards each client's message to the other while all readers wait at once, then
closes both sessions from the client side. It runs on Linux, macOS, and Windows.
