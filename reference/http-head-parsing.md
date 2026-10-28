# HTTP head parsing and serialization

Import the incremental parsers, borrowed heads, limits, and memory serializers from
`silk.http.head`. The module parses exactly one strict HTTP/1.0 or HTTP/1.1 request or response
head. It stops at the terminating empty line; body bytes, a pipelined message, and all transport
state remain with the caller.

```silk
import silk.mem.allocator { Allocator, OutOfMemoryError }
import silk.core.effect { Effect }
import silk.http.head { Limits, ParseError, Progress, ProgressState, RequestParser }
import silk.http.headers { Limits as ValueLimits }
import silk.core.result { Result }

effect fn parse() -> i32 ! OutOfMemoryError ? &mut Allocator {
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
  let progress = RequestParser.feed(
    &mut parser,
    b"GET / HTTP/1.1\r\nHost: example.com\r\n\r\nbody",
    false,
  )
  return match move progress {
    Result<Progress, ParseError>.Failure {error} => 2
    Result<Progress, ParseError>.Success {value} => {
      if value.state == ProgressState.Complete && value.consumed == 37 { return 0 }
      return 3
    }
  }
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 4 }

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    parse() |> Effect.provideMut<Allocator>(&mut allocator),
    recover,
  )
}
```

`RequestParser.make` and `ResponseParser.make` validate checked capacity arithmetic and acquire all
parser storage before returning. `maxHeadBytes` budgets stored syntax, `maxStartLineBytes` and
`maxFieldLineBytes` bound individual lines including CRLF, the nested `ValueLimits` apply the shared
HTTP method, target, field, and owned-copy limits, and `maxOwnedBytes` covers the head backing plus
32 bytes of offset metadata per configured field. Zero is always a real bound. Feeding, head access,
reset, iteration, sizing, and serialization never grow or replace that storage.

## Exact incremental progress

`feed(input, final)` returns a `Progress` with a count relative to that call and a state of
`NeedInput` or `Complete`. A successful nonempty `NeedInput` consumes the complete supplied slice.
`Complete` consumes through the final LF and no farther, so the caller retains the exact body or
next-message suffix. Empty nonfinal input consumes zero. Final input before completion returns
`Truncated`.

A syntax or limit failure poisons the parser and preserves its original `ParseError` for `failure`.
Further feed calls return `InvalidState` and consume zero. `reset` is available after completion or
failure and reuses the original allocation. A completed `RequestHead` or `ResponseHead` borrows the
parser, including every `HeaderIterator` value; Silk therefore rejects reset or release while such a
view is live. Use `RequestHead.copy` or `ResponseHead.copy` when the values must outlive the parser.

`parseRequest` and `parseResponse` are whole-slice conveniences over the same incremental core. They
return the completed parser together with exact `Progress`, so a suffix is still never hidden.

## Selected strict grammar

Request lines require exactly `method SP request-target SP HTTP/1.0|HTTP/1.1 CRLF`. Response lines
require exactly `HTTP/1.0|HTTP/1.1 SP 3DIGIT SP reason CRLF`, including the second space for an empty
reason. Status codes are limited to 100–599. Field names must meet the shared HTTP token contract and
must touch `:` directly. Values preserve interior bytes and trim only surrounding SP and HTAB.
Original field case, order, duplicates, empty values, and permitted response obs-text are preserved.

The parser rejects leading blank lines, bare LF, CR not followed by LF, obs-fold in requests,
whitespace before a colon, invalid controls, HTTP/0.9, and `ICY`. HTTP/1.1 requests require exactly
one syntactically valid Host field. For an absolute-form target, the target authority remains effective even when Host names
a different authority.

As RFC 9112 section 5.2 requires of a client, a response field folded onto following lines (obs-fold)
is accepted: each fold, the CRLF and the whitespace that starts the next line, becomes spaces, and the
joined value counts against the value and field-byte limits. A response line that starts with
whitespace before any field still fails `ObsFold`.

`ParseError` identifies the reason, syntactic component, absolute head offset, exact valid prefix
consumed from the failing call, and a field ordinal when applicable. `LimitExceeded` additionally
reports the exact limit kind, allowed count, and attempted count. Allocation failure remains the
separate `OutOfMemoryError` channel, and transport failures are not parser errors.

## Atomic memory serialization

`requestSerializedSize` and `responseSerializedSize` validate a shared `silk.http.message` head and calculate
its exact canonical size with checked arithmetic. `writeRequestInto` and `writeResponseInto` perform
that entire pass before their first write. They emit one SP between start-line components, `: ` for
each ordered field, CRLF for every line, and one terminating empty line. Responses always retain the
required reason separator, even for an empty reason.

Invalid values, overflow, or an insufficient destination leave every output byte unchanged. These
operations write no body bytes and allocate nothing.

## Availability and boundaries

The parser and serializers are ordinary target-neutral Silk and are available on supported native
and intended LLVM-to-Wasm targets. They require no socket, TLS, buffered-I/O, stream, or operating
system service. Only construction and explicit owned copies require `Allocator`.

This module ends at the empty line. Body framing, chunk coding, trailers, connection persistence,
content decoding, transport reads and writes, proxy policy, and HTTP client/server exchange state
belong to their respective actors.

The implementation and portable acceptance evidence live in
[`http_head.silk`](../stdlib/silk/http/head.silk) and
`httpHeadAcceptance.ts`.
