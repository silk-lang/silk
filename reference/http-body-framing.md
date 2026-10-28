# HTTP body framing

Import message-body selection, incremental codecs, trailer policy, limits, progress, and completion
evidence from `silk.http.body`. The module frames exactly one HTTP/1.0 or HTTP/1.1 message body
after `silk.http.head` has validated its head. It does not read or write a transport, decode content
codings, or decide whether a connection is healthy.

```silk
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.http.body { BodyError, Framing, Selection, TrailerPolicy, selectRequest }
import silk.http.head { Limits, ParseError, Progress, RequestHead, RequestParser }
import silk.http.headers { Limits as ValueLimits }
import silk.core.result { Result }
import silk.num.u64

fn inspect<'value>(outcome: Result<RequestHead<'value>, ParseError>) -> i32 {
  let head = match move outcome {
    Result<RequestHead<'value>, ParseError>.Failure {error} => { return 3 }
    Result<RequestHead<'value>, ParseError>.Success {value} => value
  }
  let selected = selectRequest<'value>(head, TrailerPolicy<'value>.defaultPolicy())
  return match move selected {
    Result<Selection<'value>, BodyError>.Failure {error} => 4
    Result<Selection<'value>, BodyError>.Success {value} => {
      return match move value.framing() {
        Framing.Fixed {length} => { if length == u64.toU64(4) { return 0 } return 5 }
        _ => 6
      }
    }
  }
}

effect fn select() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let limits = Limits {
    maxHeadBytes: 4096,
    maxStartLineBytes: 1024,
    maxFieldLineBytes: 1024,
    maxOwnedBytes: 5120,
    values: ValueLimits {
      maxMethodBytes: 32,
      maxTargetBytes: 1024,
      maxNameBytes: 128,
      maxValueBytes: 1024,
      maxFields: 32,
      maxFieldBytes: 3072,
      maxOwnedBytes: 4096,
    },
  }
  let made = run RequestParser.make(limits)
  let mut parser = match move made {
    Result<RequestParser, ParseError>.Failure {error} => { return 1 }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  let fed = RequestParser.feed(
    &mut parser,
    b"GET / HTTP/1.1\r\nHost: example.com\r\nContent-Length: 4\r\n\r\nWikiNEXT",
    false,
  )
  if let Result<Progress, ParseError>.Failure {error} = move fed {
    return 2
  }
  return inspect(RequestParser.head(&parser))
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    select() |> Effect.provideMut<Allocator>(&mut allocator),
    recover,
  )
}
```

## Framing selection

`Framing` has five variants:

| Variant            | Message boundary                                                                 |
| ------------------ | -------------------------------------------------------------------------------- |
| `Empty`            | No body bytes follow the head.                                                   |
| `Fixed { length }` | Exactly `length` payload bytes follow the head.                                  |
| `Chunked`          | A strict chunked body ends after the terminating chunk and trailer section.      |
| `CloseDelimited`   | End of transport input delimits the body.                                        |
| `Tunnel`           | The bytes after the head belong to the upgraded tunnel rather than an HTTP body. |

`selectRequest` and `selectResponse` are pure operations over validated borrowed heads. A
`Selection` contains the selected `framing` and an `anomaly` that records any condition that makes
the received message non-reusable without changing its byte boundary. `selectResponse` also takes
the corresponding request method because HEAD and CONNECT change response framing.

`Selection` is affine. It retains a borrowed iterator over the parsed head so the eventual decoder
or encoder can preserve Connection-nominated trailer exclusions without allocating during
selection. `Decoder.make` or `Encoder.make` consumes the selection and copies the retained names
into its bounded owned storage.

`Anomaly.None` records no selection anomaly. `Anomaly.ProhibitedFraming` records framing fields on
an otherwise empty 1xx or 204 response. `Anomaly.Http10TransferEncoding` records Transfer-Encoding
on an otherwise empty HTTP/1.0 response. An anomaly is not completion evidence.

Receiving selection applies these rules in order:

1. Responses to HEAD and responses with status 1xx, 204, or 304 select `Empty`. Legal
   representation metadata on HEAD and 304 remains in the head.
2. A 2xx response to CONNECT selects `Tunnel`; Content-Length and Transfer-Encoding do not delimit
   the tunnel.
3. A Transfer-Encoding field selects `Chunked` only when it is the sole field and its value is one
   parameterless `chunked` token, with only optional outer SP or HTAB. HTTP/1.0 transfer coding,
   duplicate fields, comma lists, parameters, and transfer-coding stacks fail.
4. A Content-Length field selects `Fixed` only when it is the sole field and its value is one
   nonempty unsigned decimal sequence that fits `u64`. Repeated, comma-separated, signed, empty,
   non-decimal, and overflowing values fail.
5. A request without framing metadata selects `Empty`. An ordinary response without framing
   metadata selects `CloseDelimited`.

Transfer-Encoding and Content-Length on the same non-special message fail as conflicting framing.
Status 205 is not a special framing case: its framing metadata is processed by the ordinary rules.

`validateOutgoingRequest` and `validateOutgoingResponse` apply sender requirements independently
of receiving selection. Outgoing 1xx and 204 responses and successful CONNECT responses reject
Content-Length and Transfer-Encoding. HEAD and 304 responses may retain an otherwise valid
Content-Length describing a hypothetical representation while transmitting an empty body.

Trailer declarations are advisory. Selection validates every declared name against the trailer
policy, but a declaration does not require that the named field arrive and an allowed trailer may
arrive without being declared.

## Decoder

`Decoder.make(selection, limits, policy)` validates all configured capacities and acquires the
decoder's chunk-line, trailer, record, and retained-policy storage before accepting any message
bytes. Successful `step` and `discard` calls allocate nothing and retain no borrow of caller input
or output.

`Decoder.step(input, output, finalInput)` returns a `Progress` state of `NeedInput`, `NeedOutput`,
`Complete`, or `Tunnel`. Progress reports exact input consumed and payload written for that call,
together with cumulative committed wire and payload totals. Empty and tunnel framing consume and
write zero bytes. Fixed framing stops at its declared length. Chunked framing stops after the LF of
the empty line that terminates trailers. Close-delimited framing completes only at input EOF.

Payload bytes are consumed only when they are written. When output fills, `NeedOutput` leaves the
unwritten input suffix with the caller. The caller reoffers that suffix; when EOF follows it,
`finalInput` remains `true`. EOF becomes sticky only after the decoder consumes the complete offered
slice. Once sticky, a zero-input call can finish a close-delimited body or report truncation, and
EOF cannot be withdrawn.

A fixed or chunked completion leaves every byte after the exact boundary unconsumed. A
close-delimited completion cannot establish a reusable message boundary.

## Chunked bodies and trailers

Chunk sizes contain one or more hexadecimal digits with checked `u64` accumulation. Every framing
line and data delimiter uses strict CRLF. Chunk extensions may use bounded token names and optional
token or quoted-string values, including valid quoted-pair escapes. Extension semantics are
ignored, but their bytes count toward the extension and wire limits.

The decoder rejects signs, `0x` prefixes, leading whitespace, bare LF, CR not followed by LF,
malformed quoting, and bytes outside the chunk-extension grammar. The terminating zero chunk counts
as a chunk.

Trailer fields use the strict HTTP field grammar: a nonempty token name immediately followed by
`:`, a value trimmed only for surrounding SP and HTAB, and strict CRLF. Obs-fold is invalid. Trailer
bytes and records remain separate from the initial head, so trailers cannot change framing or
retroactively alter an authentication decision.

`TrailerPolicy.defaultPolicy()` admits only `Content-Digest` and `Repr-Digest` as received trailer
fields, and lets a `Trailer` header declare any name that is not statically forbidden.
`TrailerPolicy.fromNames` creates an explicit allowlist and rejects invalid tokens and the
statically forbidden names below:

- `Content-Length`, `Transfer-Encoding`, `Host`, `Connection`, `TE`, `Trailer`, or `Upgrade`;
- `Authorization`, `Proxy-Authorization`, `WWW-Authenticate`, or `Proxy-Authenticate`;
- `Cookie` or `Set-Cookie`;
- `Content-Encoding`, `Content-Type`, `Content-Range`, or `Content-Location`;
- `Range`, `Cache-Control`, `Max-Forwards`, or `Expect`.

During selection and streaming, a field named by the initial `Connection` header is also forbidden
even when it appears in an explicit application allowlist.

A received trailer field that the policy does not admit is discarded: the body still completes and
the field is absent from the trailers. Its bytes still count toward the trailer byte limit. A
statically forbidden field, a field named by `Connection`, and a malformed trailer line still fail.

The same policy validates Trailer declarations, received trailers, and emitted trailers.

After successful chunked completion, `Decoder.trailers()` returns a `Trailers` view borrowing the
decoder's packed storage. `Trailers.count()` returns its field count, and `Trailers.fields()`
iterates the validated fields without allocation. `Trailers.copy(limits)` is the explicit fallible
allocation boundary for an independently owned `OwnedTrailers` copy under the supplied HTTP value
limits. `OwnedTrailers.view()` borrows the same trailer-view interface from the independent owner.
A live trailer view prevents decoder destruction or any operation requiring exclusive ownership.
`Decoder.trailers()` returns `None` for successfully completed Empty, Fixed, and CloseDelimited
bodies; only successful Chunked completion publishes a trailer section.

## Encoder

`Encoder.make(selection, limits, policy)` validates and reserves its working, chunk, trailer,
retained-policy, and Connection-exclusion storage. Construction rejects a `Tunnel` selection,
which is a handoff rather than an HTTP body encoding. After construction, `step`, finish initiation,
and finish continuation allocate nothing and retain no caller-buffer borrow.

`Encoder.step(input, output)` reports exact accepted payload and emitted wire progress. Empty
framing rejects nonempty input. Fixed framing accepts no more than its declared length and reports
an overrun before accepting excess bytes. Chunked framing stages at most one bounded chunk and may
pause on a full output slice. Close-delimited framing copies payload without manufacturing a
reusable delimiter.

`Encoder.beginFinish(&trailers)` validates the framing state and fixed-length total. For chunked
framing, it accepts validated `silk.http.headers.Headers`, validates trailer syntax, the retained
policy and exclusions, and trailer limits, then copies the complete trailer snapshot into the
encoder's reserved storage before emitting any finish byte. An invalid chunked trailer set
therefore emits no terminating chunk or trailer prefix. `Encoder.continueFinish(output)` accepts no
replacement trailer value and emits only the immutable snapshot.

Empty, fixed, and close-delimited framing reject a nonempty trailer collection before completion.

Chunked finish emits one `0\r\n`, the serialized trailer fields, and one final CRLF. Calling finish
continuation after completion fails with `InvalidState` and never emits a second terminator. Empty
and exactly satisfied fixed bodies complete without a suffix. A fixed underrun fails at finish.
Close-delimited finish produces completion evidence that transport closure is required.

Payload already emitted by any encoder remains provisional until framing and trailers finish
successfully. Completion evidence does not assert that output was flushed or received by a peer.

## Limits and failures

`Limits` provides these independent finite bounds:

| Field               | Type                       | Governed resource                                          |
| ------------------- | -------------------------- | ---------------------------------------------------------- |
| `maxWireBytes`      | `u64`                      | Complete encoded or decoded wire bytes.                    |
| `maxPayloadBytes`   | `u64`                      | Payload bytes, excluding framing.                          |
| `maxChunkBytes`     | `usize`                    | Payload bytes in one chunk and encoder chunk staging.      |
| `maxChunks`         | `usize`                    | Data chunks plus the terminating zero chunk.               |
| `maxChunkLineBytes` | `usize`                    | One chunk-size line, including CRLF.                       |
| `maxExtensionBytes` | `u64`                      | Extension bytes accumulated across chunks.                 |
| `maxTrailerBytes`   | `usize`                    | Complete trailer section bytes, including CRLF delimiters. |
| `maxTrailerFields`  | `usize`                    | Trailer field records.                                     |
| `maxOwnedBytes`     | `usize`                    | Reserved byte backing and metadata indices.                |
| `trailerValues`     | `silk.http.headers.Limits` | Trailer name, value, field, and owned-copy limits.         |

Zero is a real bound, not an unlimited setting.

Wire accounting includes payload and framing syntax. Payload accounting excludes framing. The
chunk-line and trailer-byte limits include their CRLF delimiters. Chunk count includes the
terminating zero chunk. Owned-byte accounting includes reserved backing and metadata indices but
excludes caller buffers and allocator bookkeeping. Every counter and conversion is checked before
overflow or before accepting the unit that would exceed its limit.

`BodyError.reason` is a `BodyReason` value. The closed reasons are `InvalidFraming`,
`ConflictingFraming`, `UnsupportedTransferCoding`, `InvalidLength`, `SizeOverflow`, `ChunkSyntax`,
`TrailerSyntax`, `TrailerPolicy`, `Truncated`, `FixedLengthUnderrun`, `FixedLengthOverrun`,
`UnexpectedPayload`, `UnsupportedTunnelEncoding`, `DiscardLimit { allowed, attempted }`,
`LimitExceeded { limit, allowed, attempted }`, and `InvalidState`.

`BodyError.component` identifies selection, Content-Length, Transfer-Encoding, chunk line, chunk
payload, chunk delimiter, trailer name, trailer value, trailer policy, decoder, encoder, or discard.
`wireOffset` is the zero-based wire coordinate. `consumed` and `written` are the exact committed
progress from the failing call; `totalWire` and `totalPayload` are cumulative committed totals.
`fieldIndex` is present when the failure belongs to one zero-based field ordinal.

A framing, syntax, limit, discard, or truncation failure terminally poisons the current message;
subsequent operations fail with `InvalidState` without replacing the original failure or exposing
completion evidence. `BodyLimitKind` distinguishes `WireBytes`, `PayloadBytes`, `ChunkBytes`,
`Chunks`, `ChunkLineBytes`, `ExtensionBytes`, `TrailerBytes`, `TrailerFields`,
`TrailerNameBytes`, `TrailerValueBytes`, `TrailerFieldBytes`, and `OwnedBytes`. The nested
`trailerValues` name, value, field-count, aggregate-field-byte, and owned-byte limits are enforced
again when receiving trailers, copying completed trailers, and snapshotting encoder trailers; a
collection constructed under looser limits cannot bypass the body-framing limits.

The separate `OutOfMemoryError` effect failure can occur only during decoder or encoder acquisition
and explicit trailer copying. It cannot arise from allocation-free stepping, discarding, or finish
continuation.

## Discard and abandonment

`Decoder.discard(input, finalInput, maxDiscardWireBytes)` advances the same framing machine without
producing payload. Its explicit finite budget counts every consumed wire byte, including chunk
lines, payload, delimiters, and trailers. Exhausting the budget is a terminal `DiscardLimit`
failure. The operation performs no hidden transport read or drain loop.

`Decoder.abandon()` and `Encoder.abandon()` make an active owner terminal without reading, writing,
flushing, or draining a transport. Abandonment, cancellation, framing failure, and discard failure
provide no reusable completion evidence; the transport owner must close or otherwise retire its
connection.

Each decoder owns exactly one parsed-head `Selection` and trailer policy. A distinct message must
construct a new decoder from that message's fresh selection and policy. This prevents retained
Connection-nominated exclusions or allowlists from leaking across messages.

## Completion evidence

`Decoder.completion()` and `Encoder.completion()` return an opaque borrowed `Completion` only after
a positive terminal outcome. Callers can inspect `Completion.kind()`:

| Kind                            | Meaning                                                   |
| ------------------------------- | --------------------------------------------------------- |
| `CompletionKind.Delimited`      | The body ended at an explicit reusable message boundary.  |
| `CompletionKind.CloseDelimited` | Input EOF or required output closure delimited the body.  |
| `CompletionKind.Tunnel`         | The decoder handed untouched post-head bytes to a tunnel. |

The evidence cannot be constructed by application code. Active, abandoned, and failed owners
expose no positive evidence. A live evidence view borrows its owner and cannot outlive destruction
or overlap exclusive mutation.

Completion evidence establishes only the framing outcome for one body. It does not prove that
encoded bytes were flushed, that the peer is healthy, that an incoming connection is otherwise
persistent, or that an application may reuse a connection without considering the head anomaly
and transport state.

## Availability and boundaries

The framing selectors, decoder, encoder, trailer policy, and evidence actors are ordinary
target-neutral Silk and are available on supported native and intended LLVM-to-Wasm targets. They
require no socket, TLS, buffered-I/O, stream, or operating-system service. Construction and explicit
owned copies require `Allocator`; incremental operations have no hidden service requirements.

The module owns HTTP/1 message-body boundaries and chunk syntax. Transport reads and writes,
content-coding decompression, application interpretation of trailers, authentication, 205
response semantics, cancellation-driven draining, connection pooling, and proxy policy belong to
their respective actors.

The implementation and portable acceptance evidence live in
[`http_body.silk`](../stdlib/silk/http/body.silk) and
`httpBodyAcceptance.ts`.
