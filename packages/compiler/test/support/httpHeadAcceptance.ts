/** One runtime program exercises the strict bounded HTTP-head contract without a compiler matrix. */
export const httpHeadAcceptanceSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.http {
  Header,
  Method,
  OwnedRequestHead,
  OwnedResponseHead,
  Status,
  ValueError,
  ValueReason,
  Version,
}
import silk.http_head {
  HeaderIterator,
  Limits,
  ParseComponent,
  ParseError,
  ParseLimitKind,
  ParseReason,
  ParserState,
  ParsedResponse,
  Progress,
  ProgressState,
  RequestHead,
  RequestParser,
  ResponseHead,
  ResponseParser,
  parseResponse,
  requestSerializedSize,
  responseSerializedSize,
  writeRequestInto,
  writeResponseInto,
}
import silk.http_headers { Limits as ValueLimits }
import silk.http_target { RequestTarget }
import silk.option { Option }
import silk.result { Result }
import silk.slice { Slice }
import silk.usize

fn valueLimits() -> ValueLimits {
  return ValueLimits {
    maxMethodBytes: 32,
    maxTargetBytes: 256,
    maxNameBytes: 64,
    maxValueBytes: 256,
    maxFields: 4,
    maxFieldBytes: 512,
    maxOwnedBytes: 1024,
  }
}

fn limits() -> Limits {
  return Limits {
    maxHeadBytes: 1024,
    maxStartLineBytes: 256,
    maxFieldLineBytes: 256,
    maxOwnedBytes: 1152,
    values: valueLimits(),
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

fn equalPrefix(left: &[u8], right: &[u8]) -> bool {
  if left.length < right.length { return false }
  let mut index = usize.ZERO
  while index < right.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

enum ExpectedReason {
  InvalidFieldName,
  InvalidHost,
  InvalidMethod,
  DuplicateHost,
  InvalidLineEnding,
  InvalidStartLine,
  InvalidStatus,
  InvalidTarget,
  MissingHost,
  ObsFold,
  BareLf,
  UnsupportedVersion,
  WhitespaceBeforeColon,
  InvalidState,
  Truncated,
}

fn reasonIs(reason: ParseReason, expected: ExpectedReason) -> bool {
  return match move expected {
    ExpectedReason.InvalidFieldName => match move reason {
      ParseReason.InvalidFieldName => true
      _ => false
    }
    ExpectedReason.InvalidHost => match move reason {
      ParseReason.InvalidHost => true
      _ => false
    }
    ExpectedReason.InvalidMethod => match move reason {
      ParseReason.InvalidMethod => true
      _ => false
    }
    ExpectedReason.DuplicateHost => match move reason {
      ParseReason.DuplicateHost => true
      _ => false
    }
    ExpectedReason.InvalidLineEnding => match move reason {
      ParseReason.InvalidLineEnding => true
      _ => false
    }
    ExpectedReason.MissingHost => match move reason {
      ParseReason.MissingHost => true
      _ => false
    }
    ExpectedReason.InvalidStartLine => match move reason {
      ParseReason.InvalidStartLine => true
      _ => false
    }
    ExpectedReason.InvalidStatus => match move reason {
      ParseReason.InvalidStatus => true
      _ => false
    }
    ExpectedReason.InvalidTarget => match move reason {
      ParseReason.InvalidTarget => true
      _ => false
    }
    ExpectedReason.ObsFold => match move reason {
      ParseReason.ObsFold => true
      _ => false
    }
    ExpectedReason.BareLf => match move reason {
      ParseReason.BareLf => true
      _ => false
    }
    ExpectedReason.UnsupportedVersion => match move reason {
      ParseReason.UnsupportedVersion => true
      _ => false
    }
    ExpectedReason.WhitespaceBeforeColon => match move reason {
      ParseReason.WhitespaceBeforeColon => true
      _ => false
    }
    ExpectedReason.InvalidState => match move reason {
      ParseReason.InvalidState => true
      _ => false
    }
    ExpectedReason.Truncated => match move reason {
      ParseReason.Truncated => true
      _ => false
    }
  }
}

fn unindexedParseError(
  error: ParseError,
  expected: ExpectedReason,
  component: ParseComponent,
  offset: usize,
  consumed: usize,
) -> bool {
  if !reasonIs(error.reason, expected) || error.component != component
    || error.offset != offset || error.consumed != consumed {
    return false
  }
  return match move error.fieldIndex {
    Option<usize>.None => true
    Option<usize>.Some {value} => false
  }
}

fn indexedParseError(
  error: ParseError,
  expected: ExpectedReason,
  component: ParseComponent,
  fieldIndex: usize,
  offset: usize,
  consumed: usize,
) -> bool {
  if !reasonIs(error.reason, expected) || error.component != component
    || error.offset != offset || error.consumed != consumed {
    return false
  }
  return match move error.fieldIndex {
    Option<usize>.None => false
    Option<usize>.Some {value} => value == fieldIndex
  }
}

fn unindexedLimitError(
  error: ParseError,
  expectedLimit: ParseLimitKind,
  allowed: usize,
  attempted: usize,
  component: ParseComponent,
  offset: usize,
  consumed: usize,
) -> bool {
  if error.component != component || error.offset != offset || error.consumed != consumed {
    return false
  }
  match move error.fieldIndex {
    Option<usize>.Some {value} => { return false }
    Option<usize>.None => {}
  }
  return match move error.reason {
    ParseReason.LimitExceeded {limit, allowed: actualAllowed, attempted: actualAttempted} => {
      return limit == expectedLimit && actualAllowed == allowed && actualAttempted == attempted
    }
    _ => false
  }
}

fn indexedLimitError(
  error: ParseError,
  expectedLimit: ParseLimitKind,
  allowed: usize,
  attempted: usize,
  component: ParseComponent,
  fieldIndex: usize,
  offset: usize,
  consumed: usize,
) -> bool {
  if error.component != component || error.offset != offset || error.consumed != consumed {
    return false
  }
  match move error.fieldIndex {
    Option<usize>.None => { return false }
    Option<usize>.Some {value} => {
      if value != fieldIndex { return false }
    }
  }
  return match move error.reason {
    ParseReason.LimitExceeded {limit, allowed: actualAllowed, attempted: actualAttempted} => {
      return limit == expectedLimit && actualAllowed == allowed && actualAttempted == attempted
    }
    _ => false
  }
}

effect fn requestFails(
  input: &[u8],
  expected: ExpectedReason,
  configured: Limits,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run RequestParser.make(configured)
  let mut parser = match move made {
    Result<RequestParser, ParseError>.Failure {error} => {
      return reasonIs(error.reason, expected)
    }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  return match move RequestParser.feed(&mut parser, input, true) {
    Result<Progress, ParseError>.Success {value} => false
    Result<Progress, ParseError>.Failure {error} => reasonIs(error.reason, expected)
  }
}

effect fn responseFails(
  input: &[u8],
  expected: ExpectedReason,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run ResponseParser.make(limits())
  let mut parser = match move made {
    Result<ResponseParser, ParseError>.Failure {error} => { return false }
    Result<ResponseParser, ParseError>.Success {value} => move value
  }
  return match move ResponseParser.feed(&mut parser, input, true) {
    Result<Progress, ParseError>.Success {value} => false
    Result<Progress, ParseError>.Failure {error} => reasonIs(error.reason, expected)
  }
}

fn inspectRequest<'value>(result: Result<RequestHead<'value>, ParseError>) -> bool {
  let head = match move result {
    Result<RequestHead<'value>, ParseError>.Failure {error} => { return false }
    Result<RequestHead<'value>, ParseError>.Success {value} => value
  }
  if RequestHead.version(&head) != Version.Http11 || RequestHead.fieldCount(&head) != 3 {
    return false
  }
  let method = RequestHead.method(&head)
  if Method.format(&method) != "GET" { return false }
  let mut fields = RequestHead.fields(&head)
  let first = match move HeaderIterator.next(&mut fields) {
    Option<Header<'value>>.None => { return false }
    Option<Header<'value>>.Some {value} => value
  }
  if Header.name(&first) != "Host" || !equal(Header.value(&first), b"a") { return false }
  let second = match move HeaderIterator.next(&mut fields) {
    Option<Header<'value>>.None => { return false }
    Option<Header<'value>>.Some {value} => value
  }
  if Header.name(&second) != "X" || Header.value(&second).length != usize.ZERO { return false }
  let third = match move HeaderIterator.next(&mut fields) {
    Option<Header<'value>>.None => { return false }
    Option<Header<'value>>.Some {value} => value
  }
  if Header.name(&third) != "X" || !equal(Header.value(&third), b"b") { return false }
  return match move HeaderIterator.next(&mut fields) {
    Option<Header<'value>>.None => true
    Option<Header<'value>>.Some {value} => false
  }
}

effect fn splitMatrix() -> bool ! OutOfMemoryError ? &mut Allocator {
  let emptyMade = run RequestParser.make(limits())
  let mut emptyParser = match move emptyMade {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  match move RequestParser.feed(&mut emptyParser, b"", false) {
    Result<Progress, ParseError>.Failure {error} => { return false }
    Result<Progress, ParseError>.Success {value} => {
      if value.consumed != usize.ZERO || value.state != ProgressState.NeedInput
        || RequestParser.state(&emptyParser) != ParserState.Active {
        return false
      }
    }
  }
  let message = b"GET / HTTP/1.1\\r\\nHost: a\\r\\nX: \\r\\nX: b\\r\\n\\r\\nBODY"
  let headLength = message.length - 4
  let mut split = usize.ZERO
  while split <= headLength {
    let made = run RequestParser.make(limits())
    let mut parser = match move made {
      Result<RequestParser, ParseError>.Failure {error} => { return false }
      Result<RequestParser, ParseError>.Success {value} => move value
    }
    let first = RequestParser.feed(
      &mut parser,
      Slice.view<u8>(message, usize.ZERO, split),
      false,
    )
    match move first {
      Result<Progress, ParseError>.Failure {error} => { return false }
      Result<Progress, ParseError>.Success {value} => {
        if value.consumed != split { return false }
        if split < headLength && value.state != ProgressState.NeedInput { return false }
        if split == headLength && value.state != ProgressState.Complete { return false }
      }
    }
    if split < headLength {
      let second = RequestParser.feed(
        &mut parser,
        Slice.view<u8>(message, split, message.length - split),
        false,
      )
      match move second {
        Result<Progress, ParseError>.Failure {error} => { return false }
        Result<Progress, ParseError>.Success {value} => {
          if value.consumed != headLength - split || value.state != ProgressState.Complete {
            return false
          }
        }
      }
    }
    if !inspectRequest(RequestParser.head(&parser)) { return false }
    let reset = RequestParser.reset(&mut parser)
    if let Result<(), ParseError>.Failure {error} = move reset { return false }
    let reused = RequestParser.feed(&mut parser, b"GET / HTTP/1.0\\r\\n\\r\\n", true)
    if let Result<Progress, ParseError>.Failure {error} = move reused { return false }
    split = split + usize.ONE
  }
  return true
}

effect fn oneByteDelivery() -> bool ! OutOfMemoryError ? &mut Allocator {
  let message = b"GET / HTTP/1.1\\r\\nHost: a\\r\\n\\r\\n"
  let made = run RequestParser.make(limits())
  let mut parser = match move made {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  let mut index = usize.ZERO
  while index < message.length {
    let fed = RequestParser.feed(&mut parser, Slice.view<u8>(message, index, usize.ONE), false)
    match move fed {
      Result<Progress, ParseError>.Failure {error} => { return false }
      Result<Progress, ParseError>.Success {value} => {
        if value.consumed != usize.ONE { return false }
        if index + usize.ONE < message.length && value.state != ProgressState.NeedInput {
          return false
        }
        if index + usize.ONE == message.length && value.state != ProgressState.Complete {
          return false
        }
      }
    }
    index = index + usize.ONE
  }
  return RequestParser.state(&parser) == ParserState.Complete
}

effect fn failuresAndReset() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run RequestParser.make(limits())
  let mut parser = match move made {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  let broken = RequestParser.feed(&mut parser, b"GET / HTTP/1.1\\rX", false)
  match move broken {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !reasonIs(error.reason, ExpectedReason.InvalidLineEnding)
        || error.component != ParseComponent.LineEnding
        || error.offset != 14
        || error.consumed != 14 {
        return false
      }
    }
  }
  match move RequestParser.failure(&parser) {
    Option<ParseError>.None => { return false }
    Option<ParseError>.Some {value} => {
      if !reasonIs(value.reason, ExpectedReason.InvalidLineEnding) { return false }
    }
  }
  match move RequestParser.feed(&mut parser, b"x", false) {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !reasonIs(error.reason, ExpectedReason.InvalidState) || error.consumed != usize.ZERO {
        return false
      }
    }
  }
  let reset = RequestParser.reset(&mut parser)
  if let Result<(), ParseError>.Failure {error} = move reset { return false }
  let missing = RequestParser.feed(&mut parser, b"GET / HTTP/1.1\\r\\n\\r\\n", true)
  match move missing {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !reasonIs(error.reason, ExpectedReason.MissingHost)
        || error.component != ParseComponent.Host {
        return false
      }
    }
  }
  let resetAgain = RequestParser.reset(&mut parser)
  if let Result<(), ParseError>.Failure {error} = move resetAgain { return false }
  let truncated = RequestParser.feed(&mut parser, b"GET / HTTP/1.1\\r\\n", true)
  return match move truncated {
    Result<Progress, ParseError>.Success {value} => false
    Result<Progress, ParseError>.Failure {error} => {
      return reasonIs(error.reason, ExpectedReason.Truncated)
        && error.offset == 16
        && error.consumed == 16
    }
  }
}

effect fn incrementalLexicalFailures() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run RequestParser.make(limits())
  let mut parser = match move made {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  let invalidMethod = RequestParser.feed(&mut parser, b"GET\\t", false)
  match move invalidMethod {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !reasonIs(error.reason, ExpectedReason.InvalidMethod)
        || error.component != ParseComponent.Method
        || error.offset != 3
        || error.consumed != 3 {
        return false
      }
    }
  }
  let emptyFinal = RequestParser.feed(&mut parser, b"", true)
  match move emptyFinal {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !reasonIs(error.reason, ExpectedReason.InvalidState)
        || error.consumed != usize.ZERO {
        return false
      }
    }
  }

  let reset = RequestParser.reset(&mut parser)
  if let Result<(), ParseError>.Failure {error} = move reset { return false }
  let prefix = RequestParser.feed(&mut parser, b"GET / HTTP/1.1\\r\\nHo", false)
  match move prefix {
    Result<Progress, ParseError>.Failure {error} => { return false }
    Result<Progress, ParseError>.Success {value} => {
      if value.consumed != 18 || value.state != ProgressState.NeedInput { return false }
    }
  }
  let invalidName = RequestParser.feed(&mut parser, b"st\\t: a\\r\\n\\r\\n", false)
  match move invalidName {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !reasonIs(error.reason, ExpectedReason.WhitespaceBeforeColon)
        || error.component != ParseComponent.HeaderName
        || error.offset != 20
        || error.consumed != 2 {
        return false
      }
    }
  }

  let tight = Limits {
    maxHeadBytes: 1024,
    maxStartLineBytes: 256,
    maxFieldLineBytes: 256,
    maxOwnedBytes: 1152,
    values: ValueLimits {
      maxMethodBytes: 3,
      maxTargetBytes: 256,
      maxNameBytes: 64,
      maxValueBytes: 256,
      maxFields: 4,
      maxFieldBytes: 512,
      maxOwnedBytes: 1024,
    },
  }
  let tightMade = run RequestParser.make(tight)
  let mut tightParser = match move tightMade {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  return match move RequestParser.feed(&mut tightParser, b"GETX", false) {
    Result<Progress, ParseError>.Success {value} => false
    Result<Progress, ParseError>.Failure {error} => unindexedLimitError(
      move error,
      ParseLimitKind.MethodBytes,
      3,
      4,
      ParseComponent.Method,
      3,
      3,
    )
  }
}

effect fn lineCompletionAtomicity() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run RequestParser.make(limits())
  let mut parser = match move made {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }

  let missingPrefix = RequestParser.feed(&mut parser, b"GET / HTTP/1.1\\r\\n\\r", false)
  match move missingPrefix {
    Result<Progress, ParseError>.Failure {error} => { return false }
    Result<Progress, ParseError>.Success {value} => {
      if value.consumed != 17 || value.state != ProgressState.NeedInput { return false }
    }
  }
  let missing = RequestParser.feed(&mut parser, b"\\n", false)
  match move missing {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !unindexedParseError(
        move error,
        ExpectedReason.MissingHost,
        ParseComponent.Host,
        16,
        usize.ZERO,
      ) { return false }
    }
  }

  let reset = RequestParser.reset(&mut parser)
  if let Result<(), ParseError>.Failure {error} = move reset { return false }
  let missingBeforeInvalidEnding = RequestParser.feed(
    &mut parser,
    b"GET / HTTP/1.1\\r\\n\\r",
    false,
  )
  if let Result<Progress, ParseError>.Failure {error} = move missingBeforeInvalidEnding {
    return false
  }
  let invalidEmptyLineEnding = RequestParser.feed(&mut parser, b"X", false)
  match move invalidEmptyLineEnding {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !indexedParseError(
        move error,
        ExpectedReason.InvalidLineEnding,
        ParseComponent.LineEnding,
        usize.ZERO,
        16,
        usize.ZERO,
      ) { return false }
    }
  }

  let resetAgain = RequestParser.reset(&mut parser)
  if let Result<(), ParseError>.Failure {error} = move resetAgain { return false }
  let startPrefix = RequestParser.feed(&mut parser, b"GET / HTTP/1.1\\r", false)
  match move startPrefix {
    Result<Progress, ParseError>.Failure {error} => { return false }
    Result<Progress, ParseError>.Success {value} => {
      if value.consumed != 15 || value.state != ProgressState.NeedInput { return false }
    }
  }
  let invalidStartEnding = RequestParser.feed(&mut parser, b"X", false)
  match move invalidStartEnding {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !unindexedParseError(
        move error,
        ExpectedReason.InvalidLineEnding,
        ParseComponent.LineEnding,
        14,
        usize.ZERO,
      ) { return false }
    }
  }

  let resetThird = RequestParser.reset(&mut parser)
  if let Result<(), ParseError>.Failure {error} = move resetThird { return false }
  let fieldPrefix = RequestParser.feed(
    &mut parser,
    b"GET / HTTP/1.1\\r\\nHost: a\\r",
    false,
  )
  match move fieldPrefix {
    Result<Progress, ParseError>.Failure {error} => { return false }
    Result<Progress, ParseError>.Success {value} => {
      if value.consumed != 24 || value.state != ProgressState.NeedInput { return false }
    }
  }
  return match move RequestParser.feed(&mut parser, b"X", false) {
    Result<Progress, ParseError>.Success {value} => false
    Result<Progress, ParseError>.Failure {error} => indexedParseError(
      move error,
      ExpectedReason.InvalidLineEnding,
      ParseComponent.LineEnding,
      usize.ZERO,
      23,
      usize.ZERO,
    )
  }
}

effect fn strictFailures() -> bool ! OutOfMemoryError ? &mut Allocator {
  if !run requestFails(b"\\r\\n", ExpectedReason.InvalidStartLine, limits()) { return false }
  if !run requestFails(b"GET / HTTP/1.1\\n", ExpectedReason.BareLf, limits()) { return false }
  if !run requestFails(
    b"GET / HTTP/1.1\\r\\nHost : a\\r\\n\\r\\n",
    ExpectedReason.WhitespaceBeforeColon,
    limits(),
  ) { return false }
  if !run requestFails(
    b"GET / HTTP/1.1\\r\\n Host: a\\r\\n\\r\\n",
    ExpectedReason.ObsFold,
    limits(),
  ) { return false }
  if !run requestFails(
    b"GET / HTTP/1.1\\r\\nHost: a\\r\\nhost: b\\r\\n\\r\\n",
    ExpectedReason.DuplicateHost,
    limits(),
  ) { return false }
  if !run requestFails(
    b"GET / HTTP/1.1\\r\\nHost: @\\r\\n\\r\\n",
    ExpectedReason.InvalidHost,
    limits(),
  ) { return false }
  if !run requestFails(
    b"CONNECT / HTTP/1.1\\r\\nHost: a\\r\\n\\r\\n",
    ExpectedReason.InvalidTarget,
    limits(),
  ) { return false }
  let mut oneField = limits()
  oneField.values.maxFields = usize.ONE
  let oneFieldMade = run RequestParser.make(oneField)
  let mut oneFieldParser = match move oneFieldMade {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  match move RequestParser.feed(
    &mut oneFieldParser,
    b"GET / HTTP/1.1\\r\\nHost: a\\r\\nX: b\\r\\n\\r\\n",
    true,
  ) {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !indexedLimitError(
        move error,
        ParseLimitKind.Fields,
        usize.ONE,
        2,
        ParseComponent.HeaderName,
        usize.ONE,
        25,
        25,
      ) { return false }
    }
  }
  let mut noOwnedCapacity = limits()
  noOwnedCapacity.maxOwnedBytes = 1151
  let noOwnedMade = run RequestParser.make(noOwnedCapacity)
  match move noOwnedMade {
    Result<RequestParser, ParseError>.Success {value} => { return false }
    Result<RequestParser, ParseError>.Failure {error} => {
      if !unindexedLimitError(
        move error,
        ParseLimitKind.OwnedBytes,
        1151,
        1152,
        ParseComponent.Parser,
        usize.ZERO,
        usize.ZERO,
      ) { return false }
    }
  }
  let mut noHeadCapacity = limits()
  noHeadCapacity.maxHeadBytes = usize.ZERO
  let noHeadMade = run RequestParser.make(noHeadCapacity)
  let mut noHeadParser = match move noHeadMade {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  match move RequestParser.feed(&mut noHeadParser, b"G", true) {
    Result<Progress, ParseError>.Success {value} => { return false }
    Result<Progress, ParseError>.Failure {error} => {
      if !unindexedLimitError(
        move error,
        ParseLimitKind.HeadBytes,
        usize.ZERO,
        usize.ONE,
        ParseComponent.Parser,
        usize.ZERO,
        usize.ZERO,
      ) { return false }
    }
  }
  if !run responseFails(b"HTTP/0.9 200 ok\\r\\n\\r\\n", ExpectedReason.UnsupportedVersion) {
    return false
  }
  if !run responseFails(b"HTTP/1.1 099 no\\r\\n\\r\\n", ExpectedReason.InvalidStatus) {
    return false
  }
  if !run responseFails(b"HTTP/1.1 204\\r\\n\\r\\n", ExpectedReason.InvalidStartLine) {
    return false
  }
  return run responseFails(
    b"HTTP/1.1 200 ok\\r\\n folded\\r\\n\\r\\n",
    ExpectedReason.ObsFold,
  )
}

effect fn responseWholeSlice() -> bool ! OutOfMemoryError ? &mut Allocator {
  let parsed = run parseResponse(b"HTTP/1.1 204 \\r\\nX: \\r\\n\\r\\nBODY", limits())
  let value = match move parsed {
    Result<ParsedResponse, ParseError>.Failure {error} => { return false }
    Result<ParsedResponse, ParseError>.Success {value} => move value
  }
  let ParsedResponse {parser, progress} = move value
  return inspectResponse(ResponseParser.head(&parser), progress)
}

fn inspectResponse<'value>(
  result: Result<ResponseHead<'value>, ParseError>,
  progress: Progress,
) -> bool {
  if progress.consumed != 22 || progress.state != ProgressState.Complete { return false }
  let head = match move result {
    Result<ResponseHead<'value>, ParseError>.Failure {error} => { return false }
    Result<ResponseHead<'value>, ParseError>.Success {value} => value
  }
  let reason = ResponseHead.reason(&head)
  if ResponseHead.version(&head) != Version.Http11 || reason.length != usize.ZERO
    || ResponseHead.fieldCount(&head) != usize.ONE {
    return false
  }
  let status = ResponseHead.status(&head)
  return Status.code(&status) == 204
}

fn inspectAbsoluteTarget<'value>(result: Result<RequestHead<'value>, ParseError>) -> bool {
  let head = match move result {
    Result<RequestHead<'value>, ParseError>.Failure {error} => { return false }
    Result<RequestHead<'value>, ParseError>.Success {value} => value
  }
  let target = RequestHead.target(&head)
  return RequestTarget.format(target) == "http://target.example/path"
}

effect fn absoluteTargetAuthorityWins() -> bool ! OutOfMemoryError ? &mut Allocator {
  let made = run RequestParser.make(limits())
  let mut parser = match move made {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  let fed = RequestParser.feed(
    &mut parser,
    b"GET http://target.example/path HTTP/1.1\\r\\nHost: host.example\\r\\n\\r\\n",
    true,
  )
  if let Result<Progress, ParseError>.Failure {error} = move fed { return false }
  return inspectAbsoluteTarget(RequestParser.head(&parser))
}

effect fn copyBorrowed<'value>(
  result: Result<RequestHead<'value>, ParseError>,
) -> Option<OwnedRequestHead> ! OutOfMemoryError ? &mut Allocator {
  let borrowed = match move result {
    Result<RequestHead<'value>, ParseError>.Failure {error} => {
      return Option<OwnedRequestHead>.none()
    }
    Result<RequestHead<'value>, ParseError>.Success {value} => value
  }
  let copied = run RequestHead.copy(&borrowed, valueLimits())
  return match move copied {
    Result<OwnedRequestHead, ValueError>.Failure {error} => Option<OwnedRequestHead>.none()
    Result<OwnedRequestHead, ValueError>.Success {value} => {
      return Option<OwnedRequestHead>.some(move value)
    }
  }
}

effect fn copyResponseBorrowed<'value>(
  result: Result<ResponseHead<'value>, ParseError>,
) -> Option<OwnedResponseHead> ! OutOfMemoryError ? &mut Allocator {
  let borrowed = match move result {
    Result<ResponseHead<'value>, ParseError>.Failure {error} => {
      return Option<OwnedResponseHead>.none()
    }
    Result<ResponseHead<'value>, ParseError>.Success {value} => value
  }
  let copied = run ResponseHead.copy(&borrowed, valueLimits())
  return match move copied {
    Result<OwnedResponseHead, ValueError>.Failure {error} => Option<OwnedResponseHead>.none()
    Result<OwnedResponseHead, ValueError>.Success {value} => {
      return Option<OwnedResponseHead>.some(move value)
    }
  }
}

effect fn copyAndSerialize() -> bool ! OutOfMemoryError ? &mut Allocator {
  let input = b"GET / HTTP/1.1\\r\\nHost: a\\r\\nX: \\r\\nX: b\\r\\n\\r\\n"
  let made = run RequestParser.make(limits())
  let mut parser = match move made {
    Result<RequestParser, ParseError>.Failure {error} => { return false }
    Result<RequestParser, ParseError>.Success {value} => move value
  }
  let fed = RequestParser.feed(&mut parser, input, true)
  if let Result<Progress, ParseError>.Failure {error} = move fed { return false }
  let copied = run copyBorrowed(RequestParser.head(&parser))
  drop parser
  let owned = match move copied {
    Option<OwnedRequestHead>.None => { return false }
    Option<OwnedRequestHead>.Some {value} => move value
  }
  let shared = OwnedRequestHead.view(&owned)
  let required = match move requestSerializedSize(&shared, valueLimits()) {
    Result<usize, ValueError>.Failure {error} => { return false }
    Result<usize, ValueError>.Success {value} => value
  }
  if required != input.length { return false }
  let mut output = run Bytes.zeroed(64)
  let written = writeRequestInto(&shared, Bytes.asMutSlice(&mut output), valueLimits())
  match move written {
    Result<usize, ValueError>.Failure {error} => { return false }
    Result<usize, ValueError>.Success {value} => {
      if value != input.length || !equalPrefix(Bytes.asSlice(&output), input) { return false }
    }
  }
  let mut short: [u8; 1] = [90]
  let rejected = writeRequestInto(&shared, &mut short, valueLimits())
  return match move rejected {
    Result<usize, ValueError>.Success {value} => false
    Result<usize, ValueError>.Failure {error} => {
      if short[0] != 90 { return false }
      return match move error.reason {
        ValueReason.OutputTooSmall {required: actual, available} => {
          return actual == required && available == usize.ONE
        }
        _ => false
      }
    }
  }
}

effect fn copyAndSerializeResponse() -> bool ! OutOfMemoryError ? &mut Allocator {
  let input = b"HTTP/1.1 204 \\r\\nX: \\r\\n\\r\\n"
  let made = run ResponseParser.make(limits())
  let mut parser = match move made {
    Result<ResponseParser, ParseError>.Failure {error} => { return false }
    Result<ResponseParser, ParseError>.Success {value} => move value
  }
  let fed = ResponseParser.feed(&mut parser, input, true)
  if let Result<Progress, ParseError>.Failure {error} = move fed { return false }
  let copied = run copyResponseBorrowed(ResponseParser.head(&parser))
  drop parser
  let owned = match move copied {
    Option<OwnedResponseHead>.None => { return false }
    Option<OwnedResponseHead>.Some {value} => move value
  }
  let shared = OwnedResponseHead.view(&owned)
  let required = match move responseSerializedSize(&shared, valueLimits()) {
    Result<usize, ValueError>.Failure {error} => { return false }
    Result<usize, ValueError>.Success {value} => value
  }
  if required != input.length { return false }
  let mut output = run Bytes.zeroed(32)
  let written = writeResponseInto(&shared, Bytes.asMutSlice(&mut output), valueLimits())
  match move written {
    Result<usize, ValueError>.Failure {error} => { return false }
    Result<usize, ValueError>.Success {value} => {
      if value != input.length || !equalPrefix(Bytes.asSlice(&output), input) { return false }
    }
  }
  let mut short: [u8; 4] = [91,92,93,94]
  let rejected = writeResponseInto(&shared, &mut short, valueLimits())
  return match move rejected {
    Result<usize, ValueError>.Success {value} => false
    Result<usize, ValueError>.Failure {error} => {
      if short[0] != 91 || short[1] != 92 || short[2] != 93 || short[3] != 94 {
        return false
      }
      return match move error.reason {
        ValueReason.OutputTooSmall {required: actual, available} => {
          return actual == required && available == 4
        }
        _ => false
      }
    }
  }
}

effect fn checks() -> i32 ! OutOfMemoryError ? &mut Allocator {
  if !run splitMatrix() { return 1 }
  if !run oneByteDelivery() { return 2 }
  if !run failuresAndReset() { return 3 }
  if !run incrementalLexicalFailures() { return 14 }
  if !run lineCompletionAtomicity() { return 15 }
  if !run strictFailures() { return 4 }
  if !run responseWholeSlice() { return 5 }
  if !run absoluteTargetAuthorityWins() { return 16 }
  if !run copyAndSerialize() { return 6 }
  if !run copyAndSerializeResponse() { return 7 }
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 8 }

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(
    checks() |> Effect.provideMut<Allocator>(&mut allocator),
    recover,
  )
}
`
