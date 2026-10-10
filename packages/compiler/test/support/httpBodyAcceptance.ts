/** One portable runtime program exercises strict bounded HTTP message framing. */
export const httpBodyAcceptanceSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.http { Header, Method }
import silk.http_body {
  Anomaly,
  BodyComponent,
  BodyError,
  BodyLimitKind,
  BodyReason,
  Completion,
  CompletionKind,
  Decoder,
  Encoder,
  Framing,
  Limits,
  Progress,
  ProgressState,
  Selection,
  TrailerIterator,
  TrailerPolicy,
  selectResponse,
  selectRequest,
  validateOutgoingRequest,
  validateOutgoingResponse,
}
import silk.http_head {
  Limits as HeadLimits,
  ParsedRequest,
  ParsedResponse,
  RequestHead,
  RequestParser,
  ResponseHead,
  ResponseParser,
  parseRequest,
  parseResponse,
}
import silk.http_headers { Headers, Limits as ValueLimits }
import silk.option { Option }
import silk.result { Result }
import silk.string { String }
import silk.u64
import silk.usize

fn valueLimits() -> ValueLimits {
  return ValueLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 128,
    maxNameBytes: 64,
    maxValueBytes: 256,
    maxFields: 8,
    maxFieldBytes: 512,
    maxOwnedBytes: 1024,
  }
}

fn headLimits() -> HeadLimits {
  return HeadLimits {
    maxHeadBytes: 1024,
    maxStartLineBytes: 256,
    maxFieldLineBytes: 256,
    maxOwnedBytes: 1536,
    values: valueLimits(),
  }
}

fn bodyLimits() -> Limits {
  return Limits {
    maxWireBytes: 1024,
    maxPayloadBytes: 512,
    maxChunkBytes: 64,
    maxChunks: 8,
    maxChunkLineBytes: 64,
    maxExtensionBytes: 128,
    maxTrailerBytes: 256,
    maxTrailerFields: 4,
    maxOwnedBytes: 2048,
    trailerValues: valueLimits(),
  }
}

fn equal(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

fn selectionCode<'head>(selected: Result<Selection<'head>, BodyError>) -> i32 {
  return match move selected {
    Result.Failure {error} => match move error.reason {
      BodyReason.InvalidFraming => 61
      BodyReason.ConflictingFraming => 62
      BodyReason.UnsupportedTransferCoding => 63
      BodyReason.InvalidLength => 64
      BodyReason.SizeOverflow => 65
      BodyReason.TrailerPolicy => 66
      _ => 69
    }
    Result.Success {value} => match move value.framing() {
      Framing.Empty => match move value.anomaly() {
        Anomaly.None => 10
        Anomaly.ProhibitedFraming => 11
        Anomaly.Http10TransferEncoding => 12
      }
      Framing.Fixed {length} => {
        if length == u64.MIN { return 20 }
        if length == u64.toU64(4) { return 24 }
        return 29
      }
      Framing.Chunked => 30
      Framing.CloseDelimited => 40
      Framing.Tunnel => 50
    }
  }
}

effect fn requestSelectionCode(input: &[u8]) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseRequest(input, headLimits())) {
    Result.Failure {error} => { return 90 }
    Result.Success {value} => move value
  }
  let head = match move RequestParser.head(&parsed.parser) {
    Result.Failure {error} => { return 91 }
    Result.Success {value} => value
  }
  return selectionCode(selectRequest(head, TrailerPolicy.defaultPolicy()))
}

effect fn responseSelectionCode(
  input: &[u8],
  methodText: string,
  outgoing: bool,
) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let method = match move Method.parse(methodText, 16) {
    Result.Failure {error} => { return 92 }
    Result.Success {value} => value
  }
  let parsed = match move (run parseResponse(input, headLimits())) {
    Result.Failure {error} => { return 93 }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { return 94 }
    Result.Success {value} => value
  }
  if outgoing {
    return selectionCode(validateOutgoingResponse(
      head,
      &method,
      TrailerPolicy.defaultPolicy(),
    ))
  }
  return selectionCode(selectResponse(head, &method, TrailerPolicy.defaultPolicy()))
}

effect fn selectionMatrixProbe() -> i32 ! OutOfMemoryError ? &mut Allocator {
  if (run requestSelectionCode(b"GET / HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n")) != 10 {
    return 11
  }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 4\\r\\n\\r\\n",
  )) != 24 { return 12 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
  )) != 30 { return 13 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 4\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
  )) != 62 { return 14 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 4\\r\\nContent-Length: 4\\r\\n\\r\\n",
  )) != 64 { return 15 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 18446744073709551616\\r\\n\\r\\n",
  )) != 65 { return 16 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: gzip\\r\\n\\r\\n",
  )) != 63 { return 17 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.0\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
  )) != 63 { return 18 }
  if (run responseSelectionCode(
    b"HTTP/1.1 101 Switching Protocols\\r\\nContent-Length: nope\\r\\n\\r\\n",
    "GET",
    false,
  )) != 11 { return 201 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked;mode=strict\\r\\n\\r\\n",
  )) != 63 { return 202 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
  )) != 63 { return 203 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 4x\\r\\n\\r\\n",
  )) != 64 { return 204 }
  if (run requestSelectionCode(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\nTrailer: Content-Length\\r\\n\\r\\n",
  )) != 66 { return 205 }
  if (run responseSelectionCode(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 9\\r\\n\\r\\n",
    "HEAD",
    false,
  )) != 10 { return 19 }
  if (run responseSelectionCode(
    b"HTTP/1.1 204 No Content\\r\\nContent-Length: nope\\r\\n\\r\\n",
    "GET",
    false,
  )) != 11 { return 20 }
  if (run responseSelectionCode(
    b"HTTP/1.0 204 No Content\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    "GET",
    false,
  )) != 12 { return 21 }
  if (run responseSelectionCode(
    b"HTTP/1.1 304 Not Modified\\r\\nContent-Length: 9\\r\\n\\r\\n",
    "GET",
    false,
  )) != 10 { return 22 }
  if (run responseSelectionCode(
    b"HTTP/1.1 205 Reset Content\\r\\nContent-Length: 0\\r\\n\\r\\n",
    "GET",
    false,
  )) != 20 { return 23 }
  if (run responseSelectionCode(b"HTTP/1.1 200 OK\\r\\n\\r\\n", "GET", false)) != 40 {
    return 24
  }
  if (run responseSelectionCode(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: nope\\r\\nTransfer-Encoding: gzip\\r\\n\\r\\n",
    "CONNECT",
    false,
  )) != 50 { return 25 }
  if (run responseSelectionCode(
    b"HTTP/1.1 204 No Content\\r\\nContent-Length: 0\\r\\n\\r\\n",
    "GET",
    true,
  )) != 61 { return 26 }
  if (run responseSelectionCode(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 0\\r\\n\\r\\n",
    "CONNECT",
    true,
  )) != 61 { return 27 }
  if (run responseSelectionCode(
    b"HTTP/1.1 200 OK\\r\\nContent-Length: 9\\r\\n\\r\\n",
    "HEAD",
    true,
  )) != 10 { return 28 }
  if (run responseSelectionCode(
    b"HTTP/1.1 304 Not Modified\\r\\nContent-Length: 9\\r\\n\\r\\n",
    "GET",
    true,
  )) != 10 { return 29 }
  return 0
}

effect fn decoderFor(input: &[u8], limits: Limits) -> Option<Decoder> ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseRequest(input, headLimits())) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => move value
  }
  let head = match move RequestParser.head(&parsed.parser) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => value
  }
  let selection = match move selectRequest(head, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => move value
  }
  let made = run Decoder.make(move selection, limits, TrailerPolicy.defaultPolicy())
  return match move made {
    Result.Failure {error} => Option.none<Decoder>()
    Result.Success {value} => Option.some<Decoder>(move value)
  }
}

effect fn decoderForResponse(
  input: &[u8],
  methodText: string,
  limits: Limits,
) -> Option<Decoder> ! OutOfMemoryError ? &mut Allocator {
  let method = match move Method.parse(methodText, 16) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => value
  }
  let parsed = match move (run parseResponse(input, headLimits())) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => value
  }
  let selection = match move selectResponse(head, &method, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => move value
  }
  let made = run Decoder.make(move selection, limits, TrailerPolicy.defaultPolicy())
  return match move made {
    Result.Failure {error} => Option.none<Decoder>()
    Result.Success {value} => Option.some<Decoder>(move value)
  }
}

effect fn decoderForHeadPolicy<'names>(
  input: &[u8],
  limits: Limits,
  policy: TrailerPolicy<'names>,
) -> Option<Decoder> ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseRequest(input, headLimits())) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => move value
  }
  let head = match move RequestParser.head(&parsed.parser) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => value
  }
  let selection = match move selectRequest(head, policy) {
    Result.Failure {error} => { return Option.none<Decoder>() }
    Result.Success {value} => move value
  }
  let made = run Decoder.make(move selection, limits, policy)
  return match move made {
    Result.Failure {error} => Option.none<Decoder>()
    Result.Success {value} => Option.some<Decoder>(move value)
  }
}

effect fn encoderFor(input: &[u8]) -> Option<Encoder> ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseRequest(input, headLimits())) {
    Result.Failure {error} => { return Option.none<Encoder>() }
    Result.Success {value} => move value
  }
  let head = match move RequestParser.head(&parsed.parser) {
    Result.Failure {error} => { return Option.none<Encoder>() }
    Result.Success {value} => value
  }
  let selection = match move validateOutgoingRequest(head, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { return Option.none<Encoder>() }
    Result.Success {value} => move value
  }
  let made = run Encoder.make(move selection, bodyLimits(), TrailerPolicy.defaultPolicy())
  return match move made {
    Result.Failure {error} => Option.none<Encoder>()
    Result.Success {value} => Option.some<Encoder>(move value)
  }
}

effect fn encoderForLimits(
  input: &[u8],
  limits: Limits,
) -> Option<Encoder> ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseRequest(input, headLimits())) {
    Result.Failure {error} => { return Option.none<Encoder>() }
    Result.Success {value} => move value
  }
  let head = match move RequestParser.head(&parsed.parser) {
    Result.Failure {error} => { return Option.none<Encoder>() }
    Result.Success {value} => value
  }
  let selection = match move validateOutgoingRequest(head, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { return Option.none<Encoder>() }
    Result.Success {value} => move value
  }
  let made = run Encoder.make(move selection, limits, TrailerPolicy.defaultPolicy())
  return match move made {
    Result.Failure {error} => Option.none<Encoder>()
    Result.Success {value} => Option.some<Encoder>(move value)
  }
}

effect fn encoderForResponse(
  input: &[u8],
  methodText: string,
) -> Result<Encoder, BodyError> ! OutOfMemoryError ? &mut Allocator {
  let method = match move Method.parse(methodText, 16) {
    Result.Failure {error} => { return Result.failResult<Encoder, BodyError>(BodyError {
      reason: BodyReason.InvalidState,
      component: BodyComponent.Encoder,
      wireOffset: u64.MIN,
      consumed: usize.ZERO,
      written: usize.ZERO,
      totalWire: u64.MIN,
      totalPayload: u64.MIN,
      fieldIndex: Option.none<usize>(),
    }) }
    Result.Success {value} => value
  }
  let parsed = match move (run parseResponse(input, headLimits())) {
    Result.Failure {error} => { return Result.failResult<Encoder, BodyError>(BodyError {
      reason: BodyReason.InvalidState,
      component: BodyComponent.Encoder,
      wireOffset: u64.MIN,
      consumed: usize.ZERO,
      written: usize.ZERO,
      totalWire: u64.MIN,
      totalPayload: u64.MIN,
      fieldIndex: Option.none<usize>(),
    }) }
    Result.Success {value} => move value
  }
  let head = match move ResponseParser.head(&parsed.parser) {
    Result.Failure {error} => { return Result.failResult<Encoder, BodyError>(BodyError {
      reason: BodyReason.InvalidState,
      component: BodyComponent.Encoder,
      wireOffset: u64.MIN,
      consumed: usize.ZERO,
      written: usize.ZERO,
      totalWire: u64.MIN,
      totalPayload: u64.MIN,
      fieldIndex: Option.none<usize>(),
    }) }
    Result.Success {value} => value
  }
  let selection = match move validateOutgoingResponse(
    head,
    &method,
    TrailerPolicy.defaultPolicy(),
  ) {
    Result.Failure {error} => { return Result.failResult<Encoder, BodyError>(move error) }
    Result.Success {value} => move value
  }
  return run Encoder.make(
    move selection,
    bodyLimits(),
    TrailerPolicy.defaultPolicy(),
  )
}

effect fn decoderMakeError(limits: Limits) -> Option<BodyError> ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseRequest(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    headLimits(),
  )) {
    Result.Failure {error} => { return Option.none<BodyError>() }
    Result.Success {value} => move value
  }
  let head = match move RequestParser.head(&parsed.parser) {
    Result.Failure {error} => { return Option.none<BodyError>() }
    Result.Success {value} => value
  }
  let selection = match move selectRequest(head, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { return Option.some<BodyError>(move error) }
    Result.Success {value} => move value
  }
  return match move (run Decoder.make(
    move selection,
    limits,
    TrailerPolicy.defaultPolicy(),
  )) {
    Result.Success {value} => Option.none<BodyError>()
    Result.Failure {error} => Option.some<BodyError>(move error)
  }
}

effect fn encoderMakeError(limits: Limits) -> Option<BodyError> ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move (run parseRequest(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    headLimits(),
  )) {
    Result.Failure {error} => { return Option.none<BodyError>() }
    Result.Success {value} => move value
  }
  let head = match move RequestParser.head(&parsed.parser) {
    Result.Failure {error} => { return Option.none<BodyError>() }
    Result.Success {value} => value
  }
  let selection = match move validateOutgoingRequest(head, TrailerPolicy.defaultPolicy()) {
    Result.Failure {error} => { return Option.some<BodyError>(move error) }
    Result.Success {value} => move value
  }
  return match move (run Encoder.make(
    move selection,
    limits,
    TrailerPolicy.defaultPolicy(),
  )) {
    Result.Success {value} => Option.none<BodyError>()
    Result.Failure {error} => Option.some<BodyError>(move error)
  }
}

fn progressIs(
  result: Result<Progress, BodyError>,
  consumed: usize,
  written: usize,
  totalWire: u64,
  totalPayload: u64,
  state: ProgressState,
) -> bool {
  return match move result {
    Result<Progress, BodyError>.Failure {error} => false
    Result<Progress, BodyError>.Success {value} => value.consumed == consumed
      && value.written == written
      && value.totalWire == totalWire
      && value.totalPayload == totalPayload
      && value.state == state
  }
}

fn nestedLimitIs(
  error: &BodyError,
  limit: BodyLimitKind,
  allowed: u64,
  attempted: u64,
  component: BodyComponent,
  wireOffset: u64,
  consumed: usize,
  hasField: bool,
) -> bool {
  let exactField = match & error.fieldIndex {
    Option.None => !hasField
    Option.Some {value} => hasField && value == usize.ZERO
  }
  return match error.reason {
    BodyReason.LimitExceeded {limit: actual, allowed: actualAllowed, attempted: actualAttempted} => {
      return actual == limit
        && actualAllowed == allowed
        && actualAttempted == attempted
        && error.component == component
        && error.wireOffset == wireOffset
        && error.consumed == consumed
        && error.written == usize.ZERO
        && error.totalWire == usize.toU64(consumed)
        && error.totalPayload == u64.MIN
        && exactField
    }
    _ => false
  }
}

effect fn trailerStepError(limits: Limits) -> Option<BodyError> ! OutOfMemoryError ? &mut Allocator {
  let made = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    limits,
  )
  let mut decoder = match move made {
    Option.None => { return Option.none<BodyError>() }
    Option.Some {value} => move value
  }
  let mut output: [u8; 0] = []
  return match move Decoder.step(
    &mut decoder,
    b"0\\r\\nContent-Digest: abc\\r\\n\\r\\n",
    &mut output,
    false,
  ) {
    Result.Success {value} => Option.none<BodyError>()
    Result.Failure {error} => Option.some<BodyError>(move error)
  }
}

effect fn chunkStepError(
  limits: Limits,
  body: &[u8],
) -> Option<BodyError> ! OutOfMemoryError ? &mut Allocator {
  let made = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    limits,
  )
  let mut decoder = match move made {
    Option.None => { return Option.none<BodyError>() }
    Option.Some {value} => move value
  }
  let mut output: [u8; 16] = [
    165, 165, 165, 165, 165, 165, 165, 165,
    165, 165, 165, 165, 165, 165, 165, 165,
  ]
  return match move Decoder.step(&mut decoder, body, &mut output, false) {
    Result.Success {value} => Option.none<BodyError>()
    Result.Failure {error} => Option.some<BodyError>(move error)
  }
}

fn bodyLimitIs(
  error: &BodyError,
  limit: BodyLimitKind,
  allowed: u64,
  attempted: u64,
  component: BodyComponent,
  wireOffset: u64,
  consumed: usize,
  written: usize,
  totalPayload: u64,
  hasField: bool,
) -> bool {
  let exactField = match & error.fieldIndex {
    Option.None => !hasField
    Option.Some {value} => hasField && value == usize.ZERO
  }
  return match error.reason {
    BodyReason.LimitExceeded {limit: actual, allowed: actualAllowed, attempted: actualAttempted} => {
      return actual == limit
        && actualAllowed == allowed
        && actualAttempted == attempted
        && error.component == component
        && error.wireOffset == wireOffset
        && error.consumed == consumed
        && error.written == written
        && error.totalWire == usize.toU64(consumed)
        && error.totalPayload == totalPayload
        && exactField
    }
    _ => false
  }
}

effect fn independentLimitProbe() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut wire = bodyLimits()
  wire.maxWireBytes = u64.toU64(2)
  let wireError = match move (run chunkStepError(wire, b"1\\r\\na\\r\\n0\\r\\n\\r\\n")) {
    Option.None => { return 141 }
    Option.Some {value} => move value
  }
  if !bodyLimitIs(
    &wireError,
    BodyLimitKind.WireBytes,
    u64.toU64(2),
    u64.toU64(3),
    BodyComponent.ChunkLine,
    u64.toU64(2),
    2,
    usize.ZERO,
    u64.MIN,
    false,
  ) { return 142 }

  let mut line = bodyLimits()
  line.maxChunkLineBytes = 2
  let lineError = match move (run chunkStepError(line, b"1\\r\\na\\r\\n0\\r\\n\\r\\n")) {
    Option.None => { return 143 }
    Option.Some {value} => move value
  }
  if !bodyLimitIs(
    &lineError,
    BodyLimitKind.ChunkLineBytes,
    u64.toU64(2),
    u64.toU64(3),
    BodyComponent.ChunkLine,
    u64.toU64(2),
    2,
    usize.ZERO,
    u64.MIN,
    false,
  ) { return 144 }

  let mut chunk = bodyLimits()
  chunk.maxChunkBytes = usize.ZERO
  let chunkError = match move (run chunkStepError(chunk, b"1\\r\\na\\r\\n0\\r\\n\\r\\n")) {
    Option.None => { return 145 }
    Option.Some {value} => move value
  }
  if !bodyLimitIs(
    &chunkError,
    BodyLimitKind.ChunkBytes,
    u64.MIN,
    u64.toU64(1),
    BodyComponent.ChunkLine,
    u64.toU64(3),
    3,
    usize.ZERO,
    u64.MIN,
    false,
  ) { return 146 }

  let mut payload = bodyLimits()
  payload.maxPayloadBytes = u64.MIN
  let payloadError = match move (run chunkStepError(payload, b"1\\r\\na\\r\\n0\\r\\n\\r\\n")) {
    Option.None => { return 147 }
    Option.Some {value} => move value
  }
  if !bodyLimitIs(
    &payloadError,
    BodyLimitKind.PayloadBytes,
    u64.MIN,
    u64.toU64(1),
    BodyComponent.ChunkPayload,
    u64.toU64(3),
    3,
    usize.ZERO,
    u64.MIN,
    false,
  ) { return 148 }

  let mut extension = bodyLimits()
  extension.maxExtensionBytes = u64.MIN
  let extensionError = match move (run chunkStepError(
    extension,
    b"1;x\\r\\na\\r\\n0\\r\\n\\r\\n",
  )) {
    Option.None => { return 149 }
    Option.Some {value} => move value
  }
  if !bodyLimitIs(
    &extensionError,
    BodyLimitKind.ExtensionBytes,
    u64.MIN,
    u64.toU64(2),
    BodyComponent.ChunkLine,
    u64.toU64(5),
    5,
    usize.ZERO,
    u64.MIN,
    false,
  ) { return 150 }

  let mut trailerBytes = bodyLimits()
  trailerBytes.maxTrailerBytes = usize.ZERO
  let trailerByteError = match move (run chunkStepError(trailerBytes, b"0\\r\\n\\r\\n")) {
    Option.None => { return 151 }
    Option.Some {value} => move value
  }
  if !bodyLimitIs(
    &trailerByteError,
    BodyLimitKind.TrailerBytes,
    u64.MIN,
    u64.toU64(1),
    BodyComponent.TrailerValue,
    u64.toU64(3),
    3,
    usize.ZERO,
    u64.MIN,
    true,
  ) { return 152 }

  let mut trailerCount = bodyLimits()
  trailerCount.maxTrailerFields = usize.ZERO
  let trailerCountError = match move (run chunkStepError(
    trailerCount,
    b"0\\r\\nContent-Digest: abc\\r\\n\\r\\n",
  )) {
    Option.None => { return 153 }
    Option.Some {value} => move value
  }
  if !bodyLimitIs(
    &trailerCountError,
    BodyLimitKind.TrailerFields,
    u64.MIN,
    u64.toU64(1),
    BodyComponent.TrailerName,
    u64.toU64(3),
    24,
    usize.ZERO,
    u64.MIN,
    true,
  ) { return 154 }
  return 0
}

effect fn acquisitionProbe() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut decoderOwned = bodyLimits()
  decoderOwned.maxOwnedBytes = 447
  let decoderOwnedError = match move (run decoderMakeError(decoderOwned)) {
    Option.None => { return 181 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &decoderOwnedError,
    BodyLimitKind.OwnedBytes,
    u64.toU64(447),
    u64.toU64(448),
    BodyComponent.Decoder,
    u64.MIN,
    usize.ZERO,
    false,
  ) { return 182 }

  let mut decoderOverflow = bodyLimits()
  decoderOverflow.maxTrailerFields = usize.MAX
  let decoderOverflowError = match move (run decoderMakeError(decoderOverflow)) {
    Option.None => { return 183 }
    Option.Some {value} => move value
  }
  let decoderOverflowExact = match move decoderOverflowError.reason {
    BodyReason.SizeOverflow => decoderOverflowError.component == BodyComponent.Decoder
      && decoderOverflowError.wireOffset == u64.MIN
      && decoderOverflowError.totalWire == u64.MIN
      && decoderOverflowError.totalPayload == u64.MIN
    _ => false
  }
  if !decoderOverflowExact { return 184 }

  let mut encoderOwned = bodyLimits()
  encoderOwned.maxOwnedBytes = 354
  let encoderOwnedError = match move (run encoderMakeError(encoderOwned)) {
    Option.None => { return 185 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &encoderOwnedError,
    BodyLimitKind.OwnedBytes,
    u64.toU64(354),
    u64.toU64(355),
    BodyComponent.Encoder,
    u64.MIN,
    usize.ZERO,
    false,
  ) { return 186 }

  let mut encoderOverflow = bodyLimits()
  encoderOverflow.maxChunkBytes = usize.MAX
  let encoderOverflowError = match move (run encoderMakeError(encoderOverflow)) {
    Option.None => { return 187 }
    Option.Some {value} => move value
  }
  let encoderOverflowExact = match move encoderOverflowError.reason {
    BodyReason.SizeOverflow => encoderOverflowError.component == BodyComponent.Encoder
      && encoderOverflowError.wireOffset == u64.MIN
      && encoderOverflowError.totalWire == u64.MIN
      && encoderOverflowError.totalPayload == u64.MIN
    _ => false
  }
  if !encoderOverflowExact { return 188 }
  return 0
}

effect fn trailerLimitProbe() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut exact = bodyLimits()
  exact.trailerValues.maxNameBytes = 14
  exact.trailerValues.maxValueBytes = 3
  exact.trailerValues.maxFields = 1
  exact.trailerValues.maxFieldBytes = 17
  exact.trailerValues.maxOwnedBytes = 55
  let exactMade = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    exact,
  )
  let mut exactDecoder = match move exactMade {
    Option.None => { return 71 }
    Option.Some {value} => move value
  }
  let mut empty: [u8; 0] = []
  if !progressIs(
    Decoder.step(
      &mut exactDecoder,
      b"0\\r\\nContent-Digest: abc\\r\\n\\r\\n",
      &mut empty,
      false,
    ),
    26,
    usize.ZERO,
    u64.toU64(26),
    u64.MIN,
    ProgressState.Complete,
  ) { return 72 }
  let trailers = match move Decoder.trailers(&exactDecoder) {
    Option.None => { return 73 }
    Option.Some {value} => move value
  }
  if trailers.count() != usize.ONE { return 74 }
  let copied = match move (run trailers.copy(exact.trailerValues)) {
    Result.Failure {error} => { return 75 }
    Result.Success {value} => move value
  }
  let copiedView = copied.view()
  let mut copiedFields = copiedView.fields()
  let copiedField = match move TrailerIterator.next(&mut copiedFields) {
    Option.None => { return 76 }
    Option.Some {value} => value
  }
  if !equal(String.utf8Bytes(copiedField.name()), b"Content-Digest")
    || !equal(copiedField.value(), b"abc") { return 77 }
  let mut copySmall = exact.trailerValues
  copySmall.maxNameBytes = 13
  let copyFailure = run trailers.copy(copySmall)
  let copyExact = match move copyFailure {
    Result.Success {value} => false
    Result.Failure {error} => nestedLimitIs(
      &error,
      BodyLimitKind.TrailerNameBytes,
      u64.toU64(13),
      u64.toU64(14),
      BodyComponent.TrailerName,
      u64.MIN,
      usize.ZERO,
      true,
    )
  }
  if !copyExact { return 78 }

  let mut copyValueSmall = exact.trailerValues
  copyValueSmall.maxValueBytes = 2
  let copyValueFailure = run trailers.copy(copyValueSmall)
  let copyValueExact = match move copyValueFailure {
    Result.Success {value} => false
    Result.Failure {error} => nestedLimitIs(
      &error,
      BodyLimitKind.TrailerValueBytes,
      u64.toU64(2),
      u64.toU64(3),
      BodyComponent.TrailerValue,
      u64.toU64(16),
      usize.ZERO,
      true,
    )
  }
  if !copyValueExact { return 89 }

  let mut copyFieldsSmall = exact.trailerValues
  copyFieldsSmall.maxFieldBytes = 16
  let copyFieldsFailure = run trailers.copy(copyFieldsSmall)
  let copyFieldsExact = match move copyFieldsFailure {
    Result.Success {value} => false
    Result.Failure {error} => nestedLimitIs(
      &error,
      BodyLimitKind.TrailerFieldBytes,
      u64.toU64(16),
      u64.toU64(17),
      BodyComponent.TrailerValue,
      u64.MIN,
      usize.ZERO,
      true,
    )
  }
  if !copyFieldsExact { return 95 }

  let mut copyCountSmall = exact.trailerValues
  copyCountSmall.maxFields = usize.ZERO
  let copyCountFailure = run trailers.copy(copyCountSmall)
  let copyCountExact = match move copyCountFailure {
    Result.Success {value} => false
    Result.Failure {error} => nestedLimitIs(
      &error,
      BodyLimitKind.TrailerFields,
      u64.MIN,
      u64.toU64(1),
      BodyComponent.TrailerName,
      u64.MIN,
      usize.ZERO,
      true,
    )
  }
  if !copyCountExact { return 96 }

  let mut copyOwnedSmall = exact.trailerValues
  copyOwnedSmall.maxOwnedBytes = 54
  let copyOwnedFailure = run trailers.copy(copyOwnedSmall)
  let copyOwnedExact = match move copyOwnedFailure {
    Result.Success {value} => false
    Result.Failure {error} => nestedLimitIs(
      &error,
      BodyLimitKind.OwnedBytes,
      u64.toU64(54),
      u64.toU64(55),
      BodyComponent.TrailerValue,
      u64.MIN,
      usize.ZERO,
      false,
    )
  }
  if !copyOwnedExact { return 97 }

  let mut nameSmall = exact
  nameSmall.trailerValues.maxNameBytes = 13
  let nameError = match move (run trailerStepError(nameSmall)) {
    Option.None => { return 79 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &nameError,
    BodyLimitKind.TrailerNameBytes,
    u64.toU64(13),
    u64.toU64(14),
    BodyComponent.TrailerName,
    u64.toU64(3),
    24,
    true,
  ) { return 80 }

  let mut valueSmall = exact
  valueSmall.trailerValues.maxValueBytes = 2
  let valueError = match move (run trailerStepError(valueSmall)) {
    Option.None => { return 81 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &valueError,
    BodyLimitKind.TrailerValueBytes,
    u64.toU64(2),
    u64.toU64(3),
    BodyComponent.TrailerValue,
    u64.toU64(19),
    24,
    true,
  ) { return 82 }

  let mut fieldsSmall = exact
  fieldsSmall.trailerValues.maxFieldBytes = 16
  let fieldError = match move (run trailerStepError(fieldsSmall)) {
    Option.None => { return 83 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &fieldError,
    BodyLimitKind.TrailerFieldBytes,
    u64.toU64(16),
    u64.toU64(17),
    BodyComponent.TrailerValue,
    u64.toU64(3),
    24,
    true,
  ) { return 84 }

  let mut countSmall = exact
  countSmall.trailerValues.maxFields = usize.ZERO
  let countError = match move (run trailerStepError(countSmall)) {
    Option.None => { return 85 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &countError,
    BodyLimitKind.TrailerFields,
    u64.MIN,
    u64.toU64(1),
    BodyComponent.TrailerName,
    u64.toU64(3),
    24,
    true,
  ) { return 86 }

  let mut ownedSmall = exact
  ownedSmall.trailerValues.maxOwnedBytes = 54
  let ownedError = match move (run trailerStepError(ownedSmall)) {
    Option.None => { return 87 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &ownedError,
    BodyLimitKind.OwnedBytes,
    u64.toU64(54),
    u64.toU64(55),
    BodyComponent.TrailerValue,
    u64.toU64(26),
    26,
    false,
  ) { return 88 }
  return 0
}

effect fn trailerPolicyProbe() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let forbiddenNames: [string<'static>; 1] = ["Content-Length"]
  let forbidden = TrailerPolicy.fromNames(&forbiddenNames)
  let forbiddenRejected = match move forbidden {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.TrailerPolicy => error.component == BodyComponent.TrailerPolicy
        && error.wireOffset == u64.MIN
        && match move error.fieldIndex {
          Option.None => false
          Option.Some {value} => value == usize.ZERO
        }
      _ => false
    }
  }
  if !forbiddenRejected { return 161 }

  let allowedNames: [string<'static>; 1] = ["X-Trace"]
  let policy = match move TrailerPolicy.fromNames(&allowedNames) {
    Result.Failure {error} => { return 162 }
    Result.Success {value} => value
  }
  let allowedMade = run decoderForHeadPolicy(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\nTrailer: X-Trace\\r\\n\\r\\n",
    bodyLimits(),
    policy,
  )
  let mut allowed = match move allowedMade {
    Option.None => { return 163 }
    Option.Some {value} => move value
  }
  let mut output: [u8; 0] = []
  if !progressIs(
    Decoder.step(&mut allowed, b"0\\r\\nX-Trace: ok\\r\\n\\r\\n", &mut output, false),
    18,
    usize.ZERO,
    u64.toU64(18),
    u64.MIN,
    ProgressState.Complete,
  ) { return 164 }
  let allowedTrailers = match move Decoder.trailers(&allowed) {
    Option.None => { return 165 }
    Option.Some {value} => move value
  }
  if allowedTrailers.count() != usize.ONE { return 166 }

  let excludedMade = run decoderForHeadPolicy(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\nConnection: X-Trace\\r\\n\\r\\n",
    bodyLimits(),
    policy,
  )
  let mut excluded = match move excludedMade {
    Option.None => { return 167 }
    Option.Some {value} => move value
  }
  let excludedError = match move Decoder.step(
    &mut excluded,
    b"0\\r\\nX-Trace: ok\\r\\n\\r\\n",
    &mut output,
    false,
  ) {
    Result.Success {value} => { return 168 }
    Result.Failure {error} => move error
  }
  let exactExclusion = match move excludedError.reason {
    BodyReason.TrailerPolicy => excludedError.component == BodyComponent.TrailerPolicy
      && excludedError.wireOffset == u64.toU64(3)
      && excludedError.consumed == 16
      && excludedError.written == usize.ZERO
      && excludedError.totalWire == u64.toU64(16)
      && excludedError.totalPayload == u64.MIN
      && match move excludedError.fieldIndex {
        Option.None => false
        Option.Some {value} => value == usize.ZERO
      }
    _ => false
  }
  if !exactExclusion { return 169 }
  return 0
}

effect fn fixedProbe() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 4\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut decoder = match move made {
    Option<Decoder>.None => { return false }
    Option<Decoder>.Some {value} => move value
  }
  let mut first: [u8; 2] = [165, 165]
  if !progressIs(
    Decoder.step(&mut decoder, b"WikiNEXT", &mut first, true),
    2,
    2,
    u64.toU64(2),
    u64.toU64(2),
    ProgressState.NeedOutput,
  ) || !equal(&first, b"Wi") { return false }
  let mut second: [u8; 2] = [165, 165]
  if !progressIs(
    Decoder.step(&mut decoder, b"kiNEXT", &mut second, true),
    2,
    2,
    u64.toU64(4),
    u64.toU64(4),
    ProgressState.Complete,
  ) || !equal(&second, b"ki") { return false }
  return match move Decoder.completion(&decoder) {
    Option.None => false
    Option.Some {value} => value.kind() == CompletionKind.Delimited
  }
}

effect fn chunkProbe() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut decoder = match move made {
    Option<Decoder>.None => { return false }
    Option<Decoder>.Some {value} => move value
  }
  let mut output: [u8; 8] = [165, 165, 165, 165, 165, 165, 165, 165]
  let decoded = Decoder.step(
    &mut decoder,
    b"4;mode=\\x22safe\\x22\\r\\nWiki\\r\\n0\\r\\nContent-Digest: abc\\r\\n\\r\\nNEXT",
    &mut output,
    false,
  )
  let progress = match move decoded {
    Result<Progress, BodyError>.Failure {error} => { return false }
    Result<Progress, BodyError>.Success {value} => move value
  }
  if progress.written != 4
    || progress.consumed != 47
    || progress.totalWire != u64.toU64(47)
    || progress.totalPayload != u64.toU64(4)
    || progress.state != ProgressState.Complete
    || output[0] != 87
    || output[1] != 105
    || output[2] != 107
    || output[3] != 105
    || output[4] != 165
    || output[5] != 165
    || output[6] != 165
    || output[7] != 165 { return false }
  let trailers = match move Decoder.trailers(&decoder) {
    Option.None => { return false }
    Option.Some {value} => move value
  }
  if trailers.count() != usize.ONE { return false }
  let mut iterator = trailers.fields()
  return match move TrailerIterator.next(&mut iterator) {
    Option.None => false
    Option.Some {value} => equal(String.utf8Bytes(value.name()), b"Content-Digest")
      && equal(value.value(), b"abc")
  }
}

effect fn exactBoundaryProbe() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut decoder = match move made {
    Option.None => { return false }
    Option.Some {value} => move value
  }
  let mut output: [u8; 4] = [165, 165, 165, 165]
  return progressIs(
    Decoder.step(&mut decoder, b"4\\r\\nWiki\\r\\n0\\r\\n\\r\\nNEXT", &mut output, false),
    14,
    4,
    u64.toU64(14),
    u64.toU64(4),
    ProgressState.Complete,
  ) && equal(&output, b"Wiki")
}

fn chunkSyntaxFailure(result: Result<Progress, BodyError>) -> bool {
  return match move result {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.ChunkSyntax => error.wireOffset == u64.MIN
        && error.consumed == 4
        && error.written == usize.ZERO
        && error.totalWire == u64.toU64(4)
        && error.totalPayload == u64.MIN
      _ => false
    }
  }
}

fn invalidStateFailure(result: Result<Progress, BodyError>) -> bool {
  return match move result {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.InvalidState => error.consumed == usize.ZERO && error.written == usize.ZERO
      _ => false
    }
  }
}

effect fn decoderModesProbe() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let emptyMade = run decoderFor(b"GET / HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n", bodyLimits())
  let mut empty = match move emptyMade {
    Option.None => { return 31 }
    Option.Some {value} => move value
  }
  let mut untouched: [u8; 2] = [165, 165]
  if !progressIs(
    Decoder.step(&mut empty, b"NEXT", &mut untouched, false),
    usize.ZERO,
    usize.ZERO,
    u64.MIN,
    u64.MIN,
    ProgressState.Complete,
  ) || untouched[0] != 165 || untouched[1] != 165 { return 32 }
  let emptyTrailers = Decoder.trailers(&empty)
  let emptyHasTrailers = match & emptyTrailers {
    Option.None => false
    Option.Some {value} => true
  }
  drop emptyTrailers
  if emptyHasTrailers { return 33 }

  let closeMade = run decoderForResponse(b"HTTP/1.1 200 OK\\r\\n\\r\\n", "GET", bodyLimits())
  let mut close = match move closeMade {
    Option.None => { return 34 }
    Option.Some {value} => move value
  }
  let mut closeOutput: [u8; 4] = [165, 165, 165, 165]
  if !progressIs(
    Decoder.step(&mut close, b"Wiki", &mut closeOutput, true),
    4,
    4,
    u64.toU64(4),
    u64.toU64(4),
    ProgressState.Complete,
  ) || !equal(&closeOutput, b"Wiki") { return 35 }
  let closeCompletion = match move Decoder.completion(&close) {
    Option.None => { return 36 }
    Option.Some {value} => move value
  }
  if closeCompletion.kind() != CompletionKind.CloseDelimited { return 37 }
  drop closeCompletion
  let closeTrailers = Decoder.trailers(&close)
  let closeHasTrailers = match & closeTrailers {
    Option.None => false
    Option.Some {value} => true
  }
  drop closeTrailers
  if closeHasTrailers { return 38 }

  let tunnelMade = run decoderForResponse(
    b"HTTP/1.1 200 Connection Established\\r\\n\\r\\n",
    "CONNECT",
    bodyLimits(),
  )
  let mut tunnel = match move tunnelMade {
    Option.None => { return 39 }
    Option.Some {value} => move value
  }
  let mut tunnelOutput: [u8; 1] = [165]
  if !progressIs(
    Decoder.step(&mut tunnel, b"T", &mut tunnelOutput, false),
    usize.ZERO,
    usize.ZERO,
    u64.MIN,
    u64.MIN,
    ProgressState.Tunnel,
  ) || tunnelOutput[0] != 165 { return 40 }
  let tunnelCompletion = match move Decoder.completion(&tunnel) {
    Option.None => { return 41 }
    Option.Some {value} => move value
  }
  if tunnelCompletion.kind() != CompletionKind.Tunnel { return 206 }

  let activeMade = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 1\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut active = match move activeMade {
    Option.None => { return 207 }
    Option.Some {value} => move value
  }
  let activeCompletion = Decoder.completion(&active)
  let activeHasCompletion = match & activeCompletion {
    Option.None => false
    Option.Some {value} => true
  }
  drop activeCompletion
  if activeHasCompletion { return 208 }
  let mut noOutput: [u8; 0] = []
  if !progressIs(
    Decoder.step(&mut active, b"", &mut noOutput, false),
    usize.ZERO,
    usize.ZERO,
    u64.MIN,
    u64.MIN,
    ProgressState.NeedInput,
  ) { return 209 }

  let shortMade = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 4\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut short = match move shortMade {
    Option.None => { return 43 }
    Option.Some {value} => move value
  }
  let mut shortOutput: [u8; 4] = [165, 165, 165, 165]
  let truncated = Decoder.step(&mut short, b"Wik", &mut shortOutput, true)
  let exactTruncation = match move truncated {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.Truncated => error.wireOffset == u64.toU64(3)
        && error.consumed == 3
        && error.written == 3
        && error.totalWire == u64.toU64(3)
        && error.totalPayload == u64.toU64(3)
      _ => false
    }
  }
  if !exactTruncation { return 44 }
  let shortCompletion = Decoder.completion(&short)
  let shortHasCompletion = match & shortCompletion {
    Option.None => false
    Option.Some {value} => true
  }
  drop shortCompletion
  if shortHasCompletion { return 45 }

  let abandonMade = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 1\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut abandoned = match move abandonMade {
    Option.None => { return 46 }
    Option.Some {value} => move value
  }
  Decoder.abandon(&mut abandoned)
  let mut abandonedOutput: [u8; 1] = [165]
  if !invalidStateFailure(Decoder.step(&mut abandoned, b"x", &mut abandonedOutput, false)) {
    return 47
  }
  let abandonedCompletion = Decoder.completion(&abandoned)
  let abandonedHasCompletion = match & abandonedCompletion {
    Option.None => false
    Option.Some {value} => true
  }
  drop abandonedCompletion
  if abandonedHasCompletion { return 48 }
  return 0
}

effect fn failureProbe() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut decoder = match move made {
    Option.None => { return false }
    Option.Some {value} => move value
  }
  let mut output: [u8; 1] = [165]
  if !chunkSyntaxFailure(Decoder.step(&mut decoder, b"+1\\r\\n", &mut output, false)) {
    return false
  }
  return invalidStateFailure(Decoder.step(&mut decoder, b"", &mut output, false))
}

effect fn syntaxFailure(body: &[u8]) -> bool ! OutOfMemoryError ? &mut Allocator {
  let error = match move (run chunkStepError(bodyLimits(), body)) {
    Option.None => { return false }
    Option.Some {value} => move value
  }
  return match move error.reason {
    BodyReason.ChunkSyntax => true
    _ => false
  }
}

effect fn chunkSyntaxMatrixProbe() -> i32 ! OutOfMemoryError ? &mut Allocator {
  if !(run syntaxFailure(b"\\r\\n")) { return 191 }
  if !(run syntaxFailure(b"0x1\\r\\n")) { return 192 }
  if !(run syntaxFailure(b" 1\\r\\n")) { return 193 }
  if !(run syntaxFailure(b"1\\n")) { return 194 }
  if !(run syntaxFailure(b"1;=x\\r\\n")) { return 195 }

  let made = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut decoder = match move made {
    Option.None => { return 196 }
    Option.Some {value} => move value
  }
  let mut output: [u8; 1] = [165]
  if !progressIs(
    Decoder.step(&mut decoder, b"1;mode=\\x22a\\\\", &mut output, false),
    10,
    usize.ZERO,
    u64.toU64(10),
    u64.MIN,
    ProgressState.NeedInput,
  ) || output[0] != 165 { return 197 }
  if !progressIs(
    Decoder.step(
      &mut decoder,
      b"b\\x22\\r\\nx\\r\\n0\\r\\n\\r\\n",
      &mut output,
      false,
    ),
    12,
    1,
    u64.toU64(22),
    u64.toU64(1),
    ProgressState.Complete,
  ) || output[0] != 120 { return 198 }
  return 0
}

fn chunkLimitFailure(result: Result<Progress, BodyError>) -> bool {
  return match move result {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.LimitExceeded {limit, allowed, attempted} => limit == BodyLimitKind.Chunks
        && allowed == u64.toU64(1)
        && attempted == u64.toU64(2)
        && error.wireOffset == u64.toU64(9)
        && error.consumed == 9
        && error.written == 1
        && error.totalWire == u64.toU64(9)
        && error.totalPayload == u64.toU64(1)
      _ => false
    }
  }
}

fn discardLimitFailure(result: Result<Progress, BodyError>) -> bool {
  return match move result {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.DiscardLimit {allowed, attempted} => allowed == u64.toU64(6)
        && attempted == u64.toU64(7)
        && error.wireOffset == u64.toU64(6)
        && error.consumed == 6
        && error.written == usize.ZERO
        && error.totalWire == u64.toU64(6)
        && error.totalPayload == u64.toU64(1)
      _ => false
    }
  }
}

effect fn limitAndDiscardProbe() -> bool ! OutOfMemoryError ? &mut Allocator {
  let mut limited = bodyLimits()
  limited.maxChunks = 1
  let limitedMade = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    limited,
  )
  let mut limitedDecoder = match move limitedMade {
    Option.None => { return false }
    Option.Some {value} => move value
  }
  let mut output: [u8; 1] = [165]
  if !chunkLimitFailure(Decoder.step(
    &mut limitedDecoder,
    b"1\\r\\na\\r\\n0\\r\\n\\r\\n",
    &mut output,
    false,
  )) { return false }

  let discardMade = run decoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    bodyLimits(),
  )
  let mut discardDecoder = match move discardMade {
    Option.None => { return false }
    Option.Some {value} => move value
  }
  return discardLimitFailure(Decoder.discard(
    &mut discardDecoder,
    b"1\\r\\na\\r\\n0\\r\\n\\r\\n",
    false,
    u64.toU64(6),
  ))
}

effect fn encoderProbe() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run encoderFor(b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n")
  let mut encoder = match move made {
    Option<Encoder>.None => { return false }
    Option<Encoder>.Some {value} => move value
  }
  let mut first: [u8; 4] = [165, 165, 165, 165]
  let started = Encoder.step(&mut encoder, b"Wiki", &mut first)
  if !progressIs(move started, 4, 4, u64.toU64(4), u64.toU64(4), ProgressState.NeedOutput)
    || !equal(&first, b"4\\r\\nW") { return false }
  let mut second: [u8; 5] = [165, 165, 165, 165, 165]
  if !progressIs(
    Encoder.step(&mut encoder, b"", &mut second),
    usize.ZERO,
    5,
    u64.toU64(9),
    u64.toU64(4),
    ProgressState.NeedInput,
  ) || !equal(&second, b"iki\\r\\n") { return false }
  let empty: [Header<'static>; 0] = []
  let trailers = match move Headers.make(&empty, valueLimits()) {
    Result.Failure {error} => { return false }
    Result.Success {value} => value
  }
  if let Result.Failure {error} = move Encoder.beginFinish(&mut encoder, &trailers) {
    return false
  }
  let mut finish: [u8; 5] = [165, 165, 165, 165, 165]
  if !progressIs(
    Encoder.continueFinish(&mut encoder, &mut finish),
    usize.ZERO,
    5,
    u64.toU64(14),
    u64.toU64(4),
    ProgressState.Complete,
  ) || !equal(&finish, b"0\\r\\n\\r\\n") { return false }
  return match move Encoder.completion(&encoder) {
    Option.None => false
    Option.Some {value} => value.kind() == CompletionKind.Delimited
  }
}

effect fn encoderFinishError(limits: Limits) -> Option<BodyError> ! OutOfMemoryError ? &mut Allocator {
  let made = run encoderForLimits(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    limits,
  )
  let mut encoder = match move made {
    Option.None => { return Option.none<BodyError>() }
    Option.Some {value} => move value
  }
  let field = match move Header.make("Content-Digest", b"abc", valueLimits()) {
    Result.Failure {error} => { return Option.none<BodyError>() }
    Result.Success {value} => value
  }
  let entries = [field]
  let trailers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { return Option.none<BodyError>() }
    Result.Success {value} => value
  }
  return match move Encoder.beginFinish(&mut encoder, &trailers) {
    Result.Success {value} => Option.none<BodyError>()
    Result.Failure {error} => Option.some<BodyError>(move error)
  }
}

effect fn encoderContractProbe() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let emptyMade = run encoderFor(b"GET / HTTP/1.1\\r\\nHost: example.com\\r\\n\\r\\n")
  let mut emptyEncoder = match move emptyMade {
    Option.None => { return 101 }
    Option.Some {value} => move value
  }
  let mut sentinel: [u8; 2] = [165, 165]
  let emptyFailure = match move Encoder.step(&mut emptyEncoder, b"x", &mut sentinel) {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.UnexpectedPayload => error.consumed == usize.ZERO
        && error.written == usize.ZERO
        && error.totalWire == u64.MIN
        && error.totalPayload == u64.MIN
      _ => false
    }
  }
  if !emptyFailure || sentinel[0] != 165 || sentinel[1] != 165 { return 102 }
  let emptyCompletion = Encoder.completion(&emptyEncoder)
  let emptyPositive = match & emptyCompletion {
    Option.None => false
    Option.Some {value} => true
  }
  drop emptyCompletion
  if emptyPositive { return 103 }

  let overMade = run encoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 4\\r\\n\\r\\n",
  )
  let mut over = match move overMade {
    Option.None => { return 104 }
    Option.Some {value} => move value
  }
  let mut overOutput: [u8; 5] = [165, 165, 165, 165, 165]
  let exactOverrun = match move Encoder.step(&mut over, b"Wiki!", &mut overOutput) {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.FixedLengthOverrun => error.consumed == usize.ZERO
        && error.written == usize.ZERO
        && error.totalWire == u64.MIN
        && error.totalPayload == u64.MIN
      _ => false
    }
  }
  if !exactOverrun || overOutput[0] != 165 { return 105 }

  let underMade = run encoderFor(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nContent-Length: 4\\r\\n\\r\\n",
  )
  let mut under = match move underMade {
    Option.None => { return 106 }
    Option.Some {value} => move value
  }
  let mut underOutput: [u8; 3] = [165, 165, 165]
  if !progressIs(
    Encoder.step(&mut under, b"Wik", &mut underOutput),
    3,
    3,
    u64.toU64(3),
    u64.toU64(3),
    ProgressState.NeedInput,
  ) { return 107 }
  let noFields: [Header<'static>; 0] = []
  let noTrailers = match move Headers.make(&noFields, valueLimits()) {
    Result.Failure {error} => { return 108 }
    Result.Success {value} => value
  }
  let exactUnderrun = match move Encoder.beginFinish(&mut under, &noTrailers) {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.FixedLengthUnderrun => error.totalWire == u64.toU64(3)
        && error.totalPayload == u64.toU64(3)
      _ => false
    }
  }
  if !exactUnderrun { return 109 }

  let closeMade = run encoderForResponse(b"HTTP/1.1 200 OK\\r\\n\\r\\n", "GET")
  let mut closeEncoder = match move closeMade {
    Result.Failure {error} => { return 110 }
    Result.Success {value} => move value
  }
  let mut closeOutput: [u8; 4] = [165, 165, 165, 165]
  if !progressIs(
    Encoder.step(&mut closeEncoder, b"Wiki", &mut closeOutput),
    4,
    4,
    u64.toU64(4),
    u64.toU64(4),
    ProgressState.NeedInput,
  ) || !equal(&closeOutput, b"Wiki") { return 111 }
  if let Result.Failure {error} = move Encoder.beginFinish(&mut closeEncoder, &noTrailers) {
    return 112
  }
  let closeCompletion = match move Encoder.completion(&closeEncoder) {
    Option.None => { return 113 }
    Option.Some {value} => move value
  }
  if closeCompletion.kind() != CompletionKind.CloseDelimited { return 114 }

  let tunnelMade = run encoderForResponse(
    b"HTTP/1.1 200 Connection Established\\r\\n\\r\\n",
    "CONNECT",
  )
  let tunnelRejected = match move tunnelMade {
    Result.Success {value} => false
    Result.Failure {error} => match move error.reason {
      BodyReason.UnsupportedTunnelEncoding => true
      _ => false
    }
  }
  if !tunnelRejected { return 115 }

  let mut exact = bodyLimits()
  exact.trailerValues.maxNameBytes = 14
  exact.trailerValues.maxValueBytes = 3
  exact.trailerValues.maxFields = 1
  exact.trailerValues.maxFieldBytes = 17
  exact.trailerValues.maxOwnedBytes = 26
  let exactMade = run encoderForLimits(
    b"POST / HTTP/1.1\\r\\nHost: example.com\\r\\nTransfer-Encoding: chunked\\r\\n\\r\\n",
    exact,
  )
  let mut exactEncoder = match move exactMade {
    Option.None => { return 116 }
    Option.Some {value} => move value
  }
  let field = match move Header.make("Content-Digest", b"abc", valueLimits()) {
    Result.Failure {error} => { return 117 }
    Result.Success {value} => value
  }
  let entries = [field]
  let finishTrailers = match move Headers.make(&entries, valueLimits()) {
    Result.Failure {error} => { return 118 }
    Result.Success {value} => value
  }
  if let Result.Failure {error} = move Encoder.beginFinish(&mut exactEncoder, &finishTrailers) {
    return 119
  }
  let mut finishOutput: [u8; 26] = [
    165, 165, 165, 165, 165, 165, 165, 165, 165, 165, 165, 165, 165,
    165, 165, 165, 165, 165, 165, 165, 165, 165, 165, 165, 165, 165,
  ]
  if !progressIs(
    Encoder.continueFinish(&mut exactEncoder, &mut finishOutput),
    usize.ZERO,
    26,
    u64.toU64(26),
    u64.MIN,
    ProgressState.Complete,
  ) || !equal(&finishOutput, b"0\\r\\nContent-Digest: abc\\r\\n\\r\\n") { return 120 }
  let mut later: [u8; 2] = [165, 165]
  if !invalidStateFailure(Encoder.continueFinish(&mut exactEncoder, &mut later))
    || later[0] != 165 || later[1] != 165 { return 121 }

  let mut nameSmall = exact
  nameSmall.trailerValues.maxNameBytes = 13
  let nameError = match move (run encoderFinishError(nameSmall)) {
    Option.None => { return 122 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &nameError,
    BodyLimitKind.TrailerNameBytes,
    u64.toU64(13),
    u64.toU64(14),
    BodyComponent.TrailerName,
    u64.MIN,
    usize.ZERO,
    true,
  ) { return 123 }
  let mut valueSmall = exact
  valueSmall.trailerValues.maxValueBytes = 2
  let valueError = match move (run encoderFinishError(valueSmall)) {
    Option.None => { return 124 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &valueError,
    BodyLimitKind.TrailerValueBytes,
    u64.toU64(2),
    u64.toU64(3),
    BodyComponent.TrailerValue,
    u64.MIN,
    usize.ZERO,
    true,
  ) { return 125 }
  let mut fieldSmall = exact
  fieldSmall.trailerValues.maxFieldBytes = 16
  let fieldError = match move (run encoderFinishError(fieldSmall)) {
    Option.None => { return 126 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &fieldError,
    BodyLimitKind.TrailerFieldBytes,
    u64.toU64(16),
    u64.toU64(17),
    BodyComponent.TrailerValue,
    u64.MIN,
    usize.ZERO,
    true,
  ) { return 127 }
  let mut countSmall = exact
  countSmall.trailerValues.maxFields = usize.ZERO
  let countError = match move (run encoderFinishError(countSmall)) {
    Option.None => { return 128 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &countError,
    BodyLimitKind.TrailerFields,
    u64.MIN,
    u64.toU64(1),
    BodyComponent.TrailerName,
    u64.MIN,
    usize.ZERO,
    true,
  ) { return 129 }
  let mut ownedSmall = exact
  ownedSmall.trailerValues.maxOwnedBytes = 25
  let ownedError = match move (run encoderFinishError(ownedSmall)) {
    Option.None => { return 130 }
    Option.Some {value} => move value
  }
  if !nestedLimitIs(
    &ownedError,
    BodyLimitKind.OwnedBytes,
    u64.toU64(25),
    u64.toU64(26),
    BodyComponent.Encoder,
    u64.MIN,
    usize.ZERO,
    true,
  ) { return 131 }
  return 0
}

effect fn program() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let selectionFailure = run selectionMatrixProbe()
  if selectionFailure != 0 { return selectionFailure }
  let decoderModeFailure = run decoderModesProbe()
  if decoderModeFailure != 0 { return decoderModeFailure }
  if !(run fixedProbe()) { return 1 }
  if !(run chunkProbe()) { return 2 }
  if !(run exactBoundaryProbe()) { return 3 }
  if !(run failureProbe()) { return 4 }
  let syntaxFailure = run chunkSyntaxMatrixProbe()
  if syntaxFailure != 0 { return syntaxFailure }
  if !(run limitAndDiscardProbe()) { return 5 }
  if !(run encoderProbe()) { return 6 }
  let trailerLimitFailure = run trailerLimitProbe()
  if trailerLimitFailure != 0 { return trailerLimitFailure }
  let encoderContractFailure = run encoderContractProbe()
  if encoderContractFailure != 0 { return encoderContractFailure }
  let independentLimitFailure = run independentLimitProbe()
  if independentLimitFailure != 0 { return independentLimitFailure }
  let trailerPolicyFailure = run trailerPolicyProbe()
  if trailerPolicyFailure != 0 { return trailerPolicyFailure }
  let acquisitionFailure = run acquisitionProbe()
  if acquisitionFailure != 0 { return acquisitionFailure }
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 5 }

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    program() |> Effect.provideMut<Allocator>(&mut allocator),
    recover,
  )
}`
