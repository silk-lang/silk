# WebSocket server handshake

`silk.websocket_upgrade` validates a WebSocket opening request and runs an explicit application
decision before the HTTP server switches protocols. It reuses the scoped HTTP server connection
and its buffered byte transport. Frame parsing, message writes, compression, and client handshakes
belong to separate APIs.

The pure accept transformation validates the key and writes into caller storage. This complete
program checks the RFC sample without a transport or allocator:

```silk
import silk.result {Result}
import silk.usize
import silk.websocket_upgrade as Upgrade

pub fn main() -> i32 {
  let mut output: [u8; 28] = [
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ]
  let result = Upgrade.acceptInto(b"dGhlIHNhbXBsZSBub25jZQ==", &mut output)
  let count = match move result {
    Result.Failure {error} => {
      return 1
    }
    Result.Success {value} => value
  }
  let expected = b"s3pPLMBiTxaQ9kYGzzhZRbK+xOo="
  if count != expected.length {
    return 2
  }
  let mut index = usize.ZERO
  while index < count {
    if output[index] != expected[index] {
      return 3
    }
    index = index + usize.ONE
  }
  return 0
}
```

`acceptInto` does not authorize a connection. The scoped `withUpgrade` operation always inspects
its own request and calls the application decision before creating its private response plan.

Inspection borrows the request head and performs no I/O. The accepted profile requires HTTP/1.1
GET, one valid Host, one version field, and one canonical Base64 key that represents 16 bytes.
Connection and Upgrade fields must contain the appropriate tokens. Duplicate singleton fields,
malformed token lists, `Connection: close`, any Transfer-Encoding, a nonzero Content-Length, and
Expect are rejected. Content-Length zero is permitted. Key validation trims only outer HTTP
whitespace; the accept digest uses the original trimmed encoded key.

The application decides resource access, authentication, and Origin policy explicitly. Origin is
not authentication. Absence is distinct from the literal `null`; a present Origin must contain one
HTTP(S) serialized origin. Applications can deliberately accept absence for nonbrowser clients or
apply their own allowlist. A selected subprotocol must exactly match one offered token. Protocol
offers remain ordered across repeated fields, and duplicate tokens are rejected.

`DecisionHandler` carries the application's policy context into its higher-ranked `decide`
operation. The wrapper owns that context and borrows it together with the offer for the decision
call. The decision may borrow configured headers or an offered protocol token; the wrapper copies
the response plan before those borrows end. Extra headers are optional; a rejection decision selects a status, and the
library supplies the request's HTTP version and body-free response framing.

Valid unsupported extension offers, including ordinary browser permessage-deflate offers, can be
declined. The server then emits no extension header. Malformed extension syntax and attempts to
select an unsupported extension fail before switching output.

The default bounds are 32 offered protocols, 128 bytes per protocol, 4096 aggregate extension
bytes, 8192 serialized response bytes, and 16384 owned bytes. Overrides are finite `usize` values;
zero is a real bound. Inherited HTTP head and field bounds also apply. Response planning accounts
for copied values and header storage before output. The owned-capacity budget covers dynamic
response storage; the fixed-size hash and accept scratch remain on the stack. Applications cannot override handshake,
connection, or framing fields with extra response headers. Valid repeated Set-Cookie fields keep
their order.

An invalid request maps to 400, a syntactically valid unsupported version maps to 426 with
Sec-WebSocket-Version 13, and Expect maps to 417. Typed inspection failures are available without
writing a response. Application rejection is an ordinary HTTP outcome; it can use 401 with
authentication headers, 403 for policy, or 404 for an unavailable resource.

`withUpgrade` returns `Outcome<A>.Rejected {status}` after sending an application rejection, or
`Outcome<A>.Upgraded {value}` after the channel callback succeeds. Application callback failures
retain their own error and requirement channels. `reject` writes the default response for an
inspection error; the pure `rejectionStatus` operation only returns its status code.

Pass the same absolute handshake deadline to HTTP request acquisition and the upgrade operation.
The operation does not reset the deadline between writes or flushes. Once the complete 101 response
is flushed, the callback receives the same exclusive buffered channel and exact unread suffix,
including first-frame bytes received with the request. HTTP operations cannot resume after that
transition. The enclosing provider scope retains close authority throughout. After partial 101
output, failure or cancellation closes the connection without an HTTP fallback or automatic retry.
Structured cleanup preserves the protected outcome; fatal traps remain outside that guarantee.

Physical `ws` availability follows the HTTP server's native listener targets. A caller can supply
an already-secured reliable duplex. This API does not provide native `wss`, certificates, or a TLS
server handshake.

The handshake follows [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455.html#section-4.2).
Canonical Base64 and the single-Origin restriction are explicit Silk profile choices.
