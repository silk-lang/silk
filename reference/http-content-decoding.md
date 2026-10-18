# HTTP content decoding

Import scoped response-content planning, streaming, metadata, completion, and request negotiation
from `silk.http_content`. The actor composes `silk.http_body`, `silk.buffered_duplex`,
`silk.inflate`, and `silk.zstd` in ordinary Silk source. It adds no compiler-known library actor or
target-specific codec path.

```silk
import silk.http { Header, ValueError }
import silk.http_content {
  AcceptEncoding,
  EmptyEncodingPolicy,
  EnabledCodings,
  Mode,
  acceptEncoding,
}
import silk.http_headers { Limits }
import silk.option { Option }
import silk.result { Result }

fn negotiationLimits() -> Limits {
  return Limits {
    maxMethodBytes: 32,
    maxTargetBytes: 1024,
    maxNameBytes: 64,
    maxValueBytes: 256,
    maxFields: 16,
    maxFieldBytes: 512,
    maxOwnedBytes: 2048,
  }
}

pub fn main() -> i32 {
  let generated = acceptEncoding<'static>(
    Mode.Decode,
    AcceptEncoding<'static>.Automatic {
      enabled: EnabledCodings {gzip: true, deflate: false, zstd: true},
      empty: EmptyEncodingPolicy.Omit,
    },
    negotiationLimits(),
  )
  return match move generated {
    Result<Option<Header<'static>>, ValueError>.Failure {error} => 1
    Result<Option<Header<'static>>, ValueError>.Success {value} => match move value {
      Option<Header<'static>>.None => 2
      Option<Header<'static>>.Some {value: header} => 0
    }
  }
}
```

## Plan one response atomically

`ResponseContext.make(head, method, trailerPolicy)` is the only public context constructor. It
performs response-body selection itself and atomically retains the validated head, request method,
trailer policy, framing selection, and exact `Selection.anomaly`. A caller cannot inject a framing
or anomaly selected elsewhere. `CodingPlan.make` consumes that affine context together with
`Mode`, `http_body.Limits`, and finite content `Limits`; the context and its selection cannot be
reused.

This low-level contract does not prove that bytes later supplied to `withReader` came from the
retained head. Each invocation treats its caller-supplied buffered body as that plan's encoded
representation. JUL-23's future affine response/body envelope owns byte provenance and the
decode-once guarantee.

`Mode.Raw` never parses `Content-Encoding`; malformed or unsupported coding metadata therefore
does not prevent access to the framed encoded representation. `Mode.Decode` validates the complete
coding list before codec acquisition or body I/O. Repeated fields are combined in wire order,
names are case-insensitive, and `identity`, `gzip`, `x-gzip`, `deflate`, and `zstd` are recognized.
Every entry, including `identity`, counts toward `maxDepth` from one through four. Nonidentity
decoders run in reverse wire order. HTTP `deflate` is strictly the zlib-wrapped profile; there is no
raw-DEFLATE sniff or fallback.

Semantic no-body responses (HEAD and status 1xx, 204, or 304) bypass coding validation and codec
acquisition while preserving their exact framing anomaly. A fixed-length ordinary response of
zero bytes is not a semantic no-body response: a declared codec receives final empty input and can
report truncation. Decode mode rejects a 206 response with any nonidentity coding, and no mode
turns a successful protocol tunnel into a representation reader.

## Stream within one exclusive scope

`withReader(plan, bufferedBody, callback)` consumes the plan and exclusively borrows the existing
`BufferedDuplex` for one higher-ranked callback. No raw reader, decoded reader, or competing
buffered access can coexist during that callback. The Effect bracket preserves the callback's
success, typed error, and requirement channels. The callback's executable-environment lifetime is
independent of the reader-view lifetimes: a static function or a closure borrowing caller state can
be used without turning that captured state into part of the transport borrow. An incomplete reader
is abandoned without I/O on success, typed failure, and structured cancellation or interruption;
the outer buffered scope continues to own transport close. Fatal traps that bypass Effect
finalizers and Drop are outside this cleanup guarantee.

`ContentReader.readSome(output, deadline)` peeks retained input, advances the pure composition
core, consumes exactly the committed wire prefix, and calls buffered `fill` only when no internal
transition can run. Every fill receives the same absolute deadline. An empty output is inert before
and after completion: it performs no transport, clock, framing, or codec work.

HTTP framing always runs first. Chunk markers and trailers never enter a content decoder, and bytes
already buffered for the next message remain unread. Final input moves through one staging edge at
a time only after the immediate upstream producer has completed and its pending bytes have been
offered. Gzip preserves concatenated-member behavior, Zstandard preserves its frame, skippable,
dictionary, window, workspace, and checksum policy, and a completed zlib stream followed by any
encoded suffix fails with `TrailingEncodedData`.

## Limits, progress, and failure

Content `Limits` apply independently:

| Field                  | Accounting boundary                                                                                        |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| `maxEncoded`           | Representation bytes emitted by body deframing                                                             |
| `maxIntermediate`      | Sum of bytes produced by every nonfinal decoder stage                                                      |
| `maxDecoded`           | Bytes returned by the final representation stage                                                           |
| `maxOwned`             | Inline reader state, every staging reservation, inflate storage, and configured Zstandard window/workspace |
| `maxDepth`             | All declared codings, including `identity`, from one through four                                          |
| `intermediateCapacity` | Each active staging edge, from one through 65,536 bytes                                                    |

Codec-specific limits remain part of the same plan. Body-decoder storage remains governed by
`http_body.Limits.maxOwnedBytes` and is not double-counted. The inline reader charge excludes that
body state and active codec state already included in codec reservations. It includes inactive
stage slots, edge descriptors, metadata, padding, and the transport reference. Zero byte allowances
are real limits.
Owned-size multiplication and addition are checked before allocation; encoded, intermediate, and
decoded limits are checked before committing the excess byte.

Every `ContentProgress` reports the current call's `written` prefix and cumulative encoded,
intermediate, and decoded totals. A decoder may consume input and return zero output, so callers
must use progress rather than treating zero written bytes as end. `ContentError` carries the same
coordinates and retains typed body, buffer/byte-I/O, inflate, or Zstandard causes. Codec failures
identify both reverse decoding stage and original wire coding index. Any failure poisons the reader;
later reads and evidence queries return zero-progress `InvalidState`. There is no automatic Raw
fallback or hidden drain after streaming starts.

Returned bytes are provisional until every selected codec validates its terminal state and the
body decoder reaches its exact boundary. A later checksum, trailer, framing, or transport failure
can invalidate bytes returned earlier.

## Metadata, completion, and reuse

`ContentReader.representation()` borrows a `RepresentationView` containing the untouched original
response head, applied plan, exact anomaly, whether a nonidentity decoder actually ran, and decoded
length when known. It never deletes or rewrites `Content-Encoding` or encoded `Content-Length`.
Length is unknown until completion except for a semantic no-body response, whose decoded length is
immediately zero.

`ContentReader.completion()` returns opaque borrowed `ContentCompletion` only after body framing,
all codecs, and final output drain have completed successfully. `trailers()` is gated by the same
condition. Completion carries the body completion kind, decoded byte total, exact anomaly, and
`ReuseDisposition`. A delimited response with `Anomaly.None` becomes `Reusable`; close-delimited
or anomalous completion is `NonReusable`. Live clean plans are only
`EligibleAfterCompletion`. Failure, abandonment, and structured early exit never publish reusable
evidence.

## Generate `Accept-Encoding`

`acceptEncoding(mode, policy, headerLimits)` is pure and returns
`Result<Option<http.Header>, http.ValueError>`. Automatic Decode mode emits enabled values in the
stable order `gzip, deflate, zstd`; `x-gzip` is accepted in responses but never advertised. When no
codec is enabled, `EmptyEncodingPolicy.Identity` emits `identity` and `Omit` emits no field. Raw
automatic mode emits no field.

`AcceptEncoding.Override` preserves exact borrowed value bytes but does not authorize unsupported
response codings. Automatic and override values both pass through `Header.make`, so forbidden
bytes, surrounding OWS, and configured name/value/field limits retain the standard precise
`ValueError` coordinates.
