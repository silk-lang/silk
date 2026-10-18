# Streaming HTTP server

`silk.http_server` owns one serial HTTP/1.0 or HTTP/1.1 exchange over an explicitly supplied byte
transport. The connection, each request, each response writer, and each upgraded channel are scoped
loans; none can escape the callback that owns the concrete provider.

```silk
import silk.http_server {
  BodyMode,
  Connection,
  ConnectionHandler,
  ConnectionPhase,
  Limits,
  Request,
  ResponseWriter,
  ReusePolicy,
  ServerError,
  ServerLimitKind,
  WriteProgress,
}

fn ready<P>(connection: &Connection<P>) -> bool {
  return connection.phase() == ConnectionPhase.Ready
}

pub fn main() -> i32 { return 42 }
```

The full API requires finite head, body/trailer, input/output, request-count, informational,
discard, and shutdown-drain bounds. Input and output capacities must be positive and no larger than
the buffered-I/O maximum; they are checked before parser or buffer allocation. Other zero bounds
remain meaningful, and a zero request limit closes without reading. Deadlines are optional absolute
`Instant` values and are never refreshed between fragments.

Request bodies are method-independent and use the shared `silk.http_body` decoder. A handler must
read a body to completion or explicitly discard it under a finite wire-byte budget before reuse;
there is no automatic drain. Each discard call receives its own allowance from the current decoder
wire coordinate. If decoding fails after committing input, the server consumes that exact reported
prefix before returning `ServerError.Body`. Beginning a final response with unread content selects
close. Request head and state accessors are fallible and reject use outside RequestActive.

HTTP/1.1 `Expect: 100-continue` is sent and flushed exactly once by the first body operation.
Unsupported expectations can be rejected immediately with a final 417 without waiting for the
body. Informational output, including automatic 100, shares one finite per-request budget.

Responses validate and serialize complete heads before accepting output. Body modes are explicit:
no body, fixed content length, chunked HTTP/1.1, or close-delimited output. Bytes accepted by a
response writer may still be pending in the bounded output buffer; only explicit flush reaches the
provider boundary. Caller-supplied `Connection` fields are removed and replaced, when needed, by
the single indication computed from server persistence policy. A failure after output begins is
terminal and never triggers a fallback response. `ServerError.Output` preserves the encoder's
cumulative payload/wire totals together with the exact current writer-call payload and buffered
prefixes at a short write or provider failure.

HTTP/1.1 reuses a connection only after both message boundaries complete and neither side selected
close. HTTP/1.0 closes by default; its opt-in keep-alive additionally requires a peer keep-alive
token and self-delimited messages. A fixed request body of length zero is complete at admission. The
final admitted request advertises close before output.

`finishConnection` is the explicit graceful path: flush, write shutdown, finite drain until end or
deadline, then logical closure. Structured scope cancellation instead performs the buffered
owner's abortive nonparking close; it does not promise a graceful network exchange. Fatal traps
remain outside current structured-finalizer guarantees.

Generic Upgrade and successful CONNECT tunnel handoff fully write and flush the switching response,
then lend the same buffered channel with its exact unread suffix. HTTP operations cannot resume
afterward. `silk.http_server_native.serveNext` is available only on the native targets admitted by
`silk.native_socket`; it accepts exactly one connection per call and creates no background queue or
task.

`ConnectionHandler<P, A, E, ?R>` is the nominal compile-time adapter used by `withConnection` and
native admission. Its higher-ranked `handle` operation consumes the owned handler and receives the
temporary connection loan; the interface introduces no runtime service or dictionary, and preserves
the handler's success, typed failure, and requirement row exactly.
