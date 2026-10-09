export const httpValuesAcceptanceSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.http {
  Header,
  LimitKind,
  Method,
  OwnedRequestHead,
  OwnedResponseHead,
  RequestHead,
  ResponseHead,
  Status,
  StatusClass,
  ValueComponent,
  ValueError,
  ValueReason,
  Version,
}
import silk.layout { Layout }
import silk.http_headers {
  HeaderIterator,
  Headers,
  Limits,
  MetadataIterator,
  MetadataToken,
  OwnedHeaders,
}
import silk.http_target {
  HttpAuthority,
  RequestTarget,
  TargetForm,
  effectiveAuthority,
  hostForUri,
  validateRequestHost,
}
import silk.option { Option }
import silk.result { Result }
import silk.string { InvalidUtf8, String }
import silk.uri { Uri }
import silk.uri_reference { ParseError }
import silk.usize

fn limits(maxOwnedBytes: usize) -> Limits {
  return Limits {
    maxMethodBytes: 32,
    maxTargetBytes: 256,
    maxNameBytes: 64,
    maxValueBytes: 256,
    maxFields: 16,
    maxFieldBytes: 1024,
    maxOwnedBytes: maxOwnedBytes,
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

enum ExpectedReason {
  InvalidToken,
  InvalidValueByte,
  UnsupportedVersion,
  InvalidStatus,
  InvalidTarget,
  InvalidAuthority,
  InvalidPort,
  MethodTargetMismatch,
  MissingHost,
  DuplicateHost,
}

fn reasonIs(reason: ValueReason, expected: ExpectedReason) -> bool {
  return match move expected {
    ExpectedReason.InvalidToken => match move reason {
      ValueReason.InvalidToken => true
      _ => false
    }
    ExpectedReason.InvalidValueByte => match move reason {
      ValueReason.InvalidValueByte => true
      _ => false
    }
    ExpectedReason.UnsupportedVersion => match move reason {
      ValueReason.UnsupportedVersion => true
      _ => false
    }
    ExpectedReason.InvalidStatus => match move reason {
      ValueReason.InvalidStatus => true
      _ => false
    }
    ExpectedReason.InvalidTarget => match move reason {
      ValueReason.InvalidTarget => true
      _ => false
    }
    ExpectedReason.InvalidAuthority => match move reason {
      ValueReason.InvalidAuthority => true
      _ => false
    }
    ExpectedReason.InvalidPort => match move reason {
      ValueReason.InvalidPort => true
      _ => false
    }
    ExpectedReason.MethodTargetMismatch => match move reason {
      ValueReason.MethodTargetMismatch => true
      _ => false
    }
    ExpectedReason.MissingHost => match move reason {
      ValueReason.MissingHost => true
      _ => false
    }
    ExpectedReason.DuplicateHost => match move reason {
      ValueReason.DuplicateHost => true
      _ => false
    }
  }
}

fn unindexedError(
  error: ValueError,
  expected: ExpectedReason,
  component: ValueComponent,
  offset: usize,
) -> bool {
  if error.component != component || error.offset != offset || !reasonIs(error.reason, expected) {
    return false
  }
  return match move error.fieldIndex {
    Option<usize>.None => true
    Option<usize>.Some {value} => false
  }
}

fn indexedError(
  error: ValueError,
  expected: ExpectedReason,
  component: ValueComponent,
  fieldIndex: usize,
  offset: usize,
) -> bool {
  if error.component != component || error.offset != offset || !reasonIs(error.reason, expected) {
    return false
  }
  return match move error.fieldIndex {
    Option<usize>.None => false
    Option<usize>.Some {value} => value == fieldIndex
  }
}

fn limitError(
  error: ValueError,
  component: ValueComponent,
  expected: LimitKind,
  allowed: usize,
  attempted: usize,
) -> bool {
  if error.component != component || error.offset != attempted { return false }
  match move error.fieldIndex {
    Option<usize>.Some {value} => { return false }
    Option<usize>.None => {}
  }
  return match move error.reason {
    ValueReason.LimitExceeded {limit, allowed: actualAllowed, attempted: actualAttempted} => {
      return limit == expected && actualAllowed == allowed && actualAttempted == attempted
    }
    _ => false
  }
}

fn indexedLimitError(
  error: ValueError,
  component: ValueComponent,
  expected: LimitKind,
  allowed: usize,
  attempted: usize,
  fieldIndex: usize,
) -> bool {
  if error.component != component || error.offset != attempted { return false }
  match move error.fieldIndex {
    Option<usize>.None => { return false }
    Option<usize>.Some {value} => {
      if value != fieldIndex { return false }
    }
  }
  return match move error.reason {
    ValueReason.LimitExceeded {limit, allowed: actualAllowed, attempted: actualAttempted} => {
      return limit == expected && actualAllowed == allowed && actualAttempted == attempted
    }
    _ => false
  }
}

fn outputError(error: ValueError, component: ValueComponent, required: usize, available: usize) -> bool {
  if error.component != component || error.offset != available { return false }
  match move error.fieldIndex {
    Option<usize>.Some {value} => { return false }
    Option<usize>.None => {}
  }
  return match move error.reason {
    ValueReason.OutputTooSmall {required: actualRequired, available: actualAvailable} => {
      return actualRequired == required && actualAvailable == available
    }
    _ => false
  }
}

fn filledWith(bytes: &[u8], expected: u8) -> bool {
  let mut index = usize.ZERO
  while index < bytes.length {
    if bytes[index] != expected { return false }
    index = index + usize.ONE
  }
  return true
}

fn rejectsHeaderValue<'value>(
  value: &'value [u8],
  configured: Limits,
  offset: usize,
) -> bool {
  match move Header.make("X-Control", move value, configured) {
    Result<Header<'value>, ValueError>.Success {value: header} => {
      drop header
      return false
    }
    Result<Header<'value>, ValueError>.Failure {error} => {
      return unindexedError(
        move error,
        ExpectedReason.InvalidValueByte,
        ValueComponent.HeaderValue,
        offset,
      )
    }
  }
  return false
}

fn scalars() -> bool {
  let http10 = Version.parse("HTTP/1.0")
  match move http10 {
    Result<Version, ValueError>.Failure {error} => { return false }
    Result<Version, ValueError>.Success {value} => {
      if Version.format(&value) != "HTTP/1.0" { return false }
    }
  }
  let http11 = Version.parse("HTTP/1.1")
  match move http11 {
    Result<Version, ValueError>.Failure {error} => { return false }
    Result<Version, ValueError>.Success {value} => {
      if Version.format(&value) != "HTTP/1.1" { return false }
    }
  }
  let extension = Method.parse("CuStOm", 6)
  match move extension {
    Result<Method<'static>, ValueError>.Failure {error} => { return false }
    Result<Method<'static>, ValueError>.Success {value} => {
      if Method.format(&value) != "CuStOm" || !Method.equals(&value, &value) { return false }
    }
  }
  let unknown = Status.fromCode(299)
  match move unknown {
    Result<Status, ValueError>.Failure {error} => { return false }
    Result<Status, ValueError>.Success {value} => {
      if Status.code(&value) != 299 || Status.class(&value) != StatusClass.Successful { return false }
    }
  }
  return true
}

fn scalarErrors() -> bool {
  match move Version.parse("HTTP/2") {
    Result<Version, ValueError>.Success {value} => { return false }
    Result<Version, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.UnsupportedVersion,
        ValueComponent.Version,
        usize.ZERO,
      ) { return false }
    }
  }
  match move Method.parse("", usize.ZERO) {
    Result<Method<'static>, ValueError>.Success {value} => { return false }
    Result<Method<'static>, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.InvalidToken,
        ValueComponent.Method,
        usize.ZERO,
      ) { return false }
    }
  }
  match move Method.parse("bad method", 32) {
    Result<Method<'static>, ValueError>.Success {value} => { return false }
    Result<Method<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidToken, ValueComponent.Method, 3) {
        return false
      }
    }
  }
  match move Method.parse("A", usize.ZERO) {
    Result<Method<'static>, ValueError>.Success {value} => { return false }
    Result<Method<'static>, ValueError>.Failure {error} => {
      if !limitError(move error, ValueComponent.Method, LimitKind.MethodBytes, usize.ZERO, usize.ONE) {
        return false
      }
    }
  }
  let upper = match move Method.parse("PURGE", 5) {
    Result<Method<'static>, ValueError>.Failure {error} => { return false }
    Result<Method<'static>, ValueError>.Success {value} => value
  }
  let lower = match move Method.parse("purge", 5) {
    Result<Method<'static>, ValueError>.Failure {error} => { return false }
    Result<Method<'static>, ValueError>.Success {value} => value
  }
  if Method.format(&upper) != "PURGE" || Method.format(&lower) != "purge"
    || Method.equals(&upper, &lower) { return false }
  match move Status.fromCode(99) {
    Result<Status, ValueError>.Success {value} => { return false }
    Result<Status, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.InvalidStatus,
        ValueComponent.Status,
        usize.ZERO,
      ) { return false }
    }
  }
  return match move Status.fromCode(600) {
    Result<Status, ValueError>.Success {value} => false
    Result<Status, ValueError>.Failure {error} => unindexedError(
      move error,
      ExpectedReason.InvalidStatus,
      ValueComponent.Status,
      usize.ZERO,
    )
  }
}

fn headerValidation() -> bool {
  let configured = limits(4096)
  match move Header.make("X-Empty", b"", configured) {
    Result<Header<'static>, ValueError>.Failure {error} => { return false }
    Result<Header<'static>, ValueError>.Success {value} => {}
  }
  match move Header.make("X-Bytes", b"a\\tb \\x80\\xFF", configured) {
    Result<Header<'static>, ValueError>.Failure {error} => { return false }
    Result<Header<'static>, ValueError>.Success {value} => {}
  }
  match move Header.make("", b"ok", configured) {
    Result<Header<'static>, ValueError>.Success {value} => { return false }
    Result<Header<'static>, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.InvalidToken,
        ValueComponent.HeaderName,
        usize.ZERO,
      ) { return false }
    }
  }
  match move Header.make("Bad Name", b"ok", configured) {
    Result<Header<'static>, ValueError>.Success {value} => { return false }
    Result<Header<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidToken, ValueComponent.HeaderName, 3) {
        return false
      }
    }
  }
  match move Header.make("Name", b" trailing ", configured) {
    Result<Header<'static>, ValueError>.Success {value} => { return false }
    Result<Header<'static>, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.InvalidValueByte,
        ValueComponent.HeaderValue,
        usize.ZERO,
      ) { return false }
    }
  }
  let mut candidate: [u8; 1] = [0]
  let mut byte = usize.ZERO
  while byte < 32 {
    candidate[usize.ZERO] = usize.toU8(byte)
    if byte != 9 {
      if !rejectsHeaderValue(&candidate, configured, usize.ZERO) { return false }
    }
    byte = byte + usize.ONE
  }
  candidate[usize.ZERO] = 127
  if !rejectsHeaderValue(&candidate, configured, usize.ZERO) { return false }
  return true
}

fn headerErrors() -> bool {
  let configured = limits(4096)
  let mut exactName = configured
  exactName.maxNameBytes = 4
  match move Header.make("Name", b"", exactName) {
    Result<Header<'static>, ValueError>.Failure {error} => { return false }
    Result<Header<'static>, ValueError>.Success {value} => {}
  }
  exactName.maxNameBytes = 3
  match move Header.make("Name", b"", exactName) {
    Result<Header<'static>, ValueError>.Success {value} => { return false }
    Result<Header<'static>, ValueError>.Failure {error} => {
      if !limitError(move error, ValueComponent.HeaderName, LimitKind.NameBytes, 3, 4) {
        return false
      }
    }
  }
  exactName.maxNameBytes = usize.ZERO
  match move Header.make("N", b"", exactName) {
    Result<Header<'static>, ValueError>.Success {value} => { return false }
    Result<Header<'static>, ValueError>.Failure {error} => {
      if !limitError(
        move error,
        ValueComponent.HeaderName,
        LimitKind.NameBytes,
        usize.ZERO,
        usize.ONE,
      ) { return false }
    }
  }
  let mut exactValue = configured
  exactValue.maxValueBytes = usize.ONE
  match move Header.make("Name", b"x", exactValue) {
    Result<Header<'static>, ValueError>.Failure {error} => { return false }
    Result<Header<'static>, ValueError>.Success {value} => {}
  }
  exactValue.maxValueBytes = usize.ZERO
  return match move Header.make("Name", b"x", exactValue) {
    Result<Header<'static>, ValueError>.Success {value} => false
    Result<Header<'static>, ValueError>.Failure {error} => limitError(
      move error,
      ValueComponent.HeaderValue,
      LimitKind.ValueBytes,
      usize.ZERO,
      usize.ONE,
    )
  }
}

fn zeroCollectionBounds() -> bool {
  let zero = Limits {
    maxMethodBytes: usize.ZERO,
    maxTargetBytes: usize.ZERO,
    maxNameBytes: usize.ZERO,
    maxValueBytes: usize.ZERO,
    maxFields: usize.ZERO,
    maxFieldBytes: usize.ZERO,
    maxOwnedBytes: usize.ZERO,
  }
  let entries: [Header<'static>; 0] = []
  return headersSucceeded(Headers.make(&entries, zero))
}

fn headerCases<'value>(
  firstName: string<'value>,
  firstValue: &'value [u8],
  secondName: string<'value>,
  secondValue: &'value [u8],
  byteName: string<'value>,
  byteValue: &'value [u8],
  emptyName: string<'value>,
  emptyValue: &'value [u8],
  crlfValue: &'value [u8],
) -> bool {
  let configured = limits(4096)
  let first = Header.make(move firstName, move firstValue, configured)
  return match move first {
    Result<Header<'value>, ValueError>.Failure {error} => false
    Result<Header<'value>, ValueError>.Success {value: firstHeader} => {
      let second = Header.make(move secondName, move secondValue, configured)
      return match move second {
        Result<Header<'value>, ValueError>.Failure {error} => false
        Result<Header<'value>, ValueError>.Success {value: secondHeader} => {
          let tabbed = Header.make(move byteName, move byteValue, configured)
          return match move tabbed {
            Result<Header<'value>, ValueError>.Failure {error} => false
            Result<Header<'value>, ValueError>.Success {value: byteHeader} => {
              let empty = Header.make(move emptyName, move emptyValue, configured)
              return match move empty {
                Result<Header<'value>, ValueError>.Failure {error} => false
                Result<Header<'value>, ValueError>.Success {value: emptyHeader} => {
                  return inspectFour(
                    firstHeader,
                    secondHeader,
                    byteHeader,
                    emptyHeader,
                    configured,
                    move crlfValue,
                  )
                }
              }
            }
          }
        }
      }
    }
  }
}

fn headersSucceeded<'value>(result: Result<Headers<'value>, ValueError>) -> bool {
  return match move result {
    Result<Headers<'value>, ValueError>.Failure {error} => false
    Result<Headers<'value>, ValueError>.Success {value} => true
  }
}

fn headersLimitFailed<'value>(
  result: Result<Headers<'value>, ValueError>,
  expected: LimitKind,
  allowed: usize,
  attempted: usize,
  fieldIndex: usize,
) -> bool {
  return match move result {
    Result<Headers<'value>, ValueError>.Success {value} => false
    Result<Headers<'value>, ValueError>.Failure {error} => indexedLimitError(
      move error,
      ValueComponent.Headers,
      expected,
      allowed,
      attempted,
      fieldIndex,
    )
  }
}

fn headersUnindexedLimitFailed<'value>(
  result: Result<Headers<'value>, ValueError>,
  expected: LimitKind,
  allowed: usize,
  attempted: usize,
) -> bool {
  return match move result {
    Result<Headers<'value>, ValueError>.Success {value} => false
    Result<Headers<'value>, ValueError>.Failure {error} => limitError(
      move error,
      ValueComponent.Headers,
      expected,
      allowed,
      attempted,
    )
  }
}

fn inspectFour<'value>(
  first: Header<'value>,
  second: Header<'value>,
  byteHeader: Header<'value>,
  empty: Header<'value>,
  configured: Limits,
  crlfValue: &'value [u8],
) -> bool {
  let entries: [Header<'value>; 4] = [first, second, byteHeader, empty]
  let mut exact = configured
  exact.maxFields = 4
  exact.maxNameBytes = 10
  exact.maxValueBytes = 4
  exact.maxFieldBytes = 42
  if !headersSucceeded(Headers.make(&entries, exact)) { return false }
  exact.maxFields = 3
  if !headersUnindexedLimitFailed(Headers.make(&entries, exact), LimitKind.Fields, 3, 4) {
    return false
  }
  exact.maxFields = 4
  exact.maxFieldBytes = 41
  if !headersLimitFailed(Headers.make(&entries, exact), LimitKind.FieldBytes, 41, 42, 3) {
    return false
  }
  return inspectMade(
    Headers.make(&entries, configured),
    configured,
    move crlfValue,
  )
}

fn inspectMade<'value>(
  made: Result<Headers<'value>, ValueError>,
  configured: Limits,
  crlfValue: &'value [u8],
) -> bool {
  return match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => false
    Result<Headers<'value>, ValueError>.Success {value} => inspectHeaders(
      &value,
      configured,
      move crlfValue,
    )
  }
}

fn nextHeader<'value>(
  iterator: &mut HeaderIterator<'value>,
  expectedName: string,
  expectedValue: &[u8],
) -> bool {
  return match move HeaderIterator.next(move iterator) {
    Option<Header<'value>>.None => false
    Option<Header<'value>>.Some {value} => Header.name(&value) == expectedName
      && equal(Header.value(&value), expectedValue)
  }
}

fn inspectHeaders<'value>(
  headers: &Headers<'value>,
  configured: Limits,
  crlfValue: &'value [u8],
) -> bool {
  if Headers.count(headers) != 4 { return false }
  let mut all = Headers.iter(headers)
  if !nextHeader(&mut all, "Set-Cookie", b"a=1") { return false }
  if !nextHeader(&mut all, "set-cookie", b"b=2") { return false }
  if !nextHeader(&mut all, "X-Bytes", b"a\\tb\\xFF") { return false }
  if !nextHeader(&mut all, "Empty", b"") { return false }
  match move HeaderIterator.next(&mut all) {
    Option<Header<'value>>.Some {value} => { return false }
    Option<Header<'value>>.None => {}
  }
  match move Headers.getFirst(headers, "SET-COOKIE") {
    Option<Header<'value>>.None => { return false }
    Option<Header<'value>>.Some {value} => {
      if Header.name(&value) != "Set-Cookie" || !equal(Header.value(&value), b"a=1") {
        return false
      }
    }
  }
  let mut cookies = Headers.getAll(headers, "SET-COOKIE")
  let first = HeaderIterator.next(&mut cookies)
  match move first {
    Option<Header<'value>>.None => { return false }
    Option<Header<'value>>.Some {value} => {
      if Header.name(&value) != "Set-Cookie" || !equal(Header.value(&value), b"a=1") { return false }
    }
  }
  let second = HeaderIterator.next(&mut cookies)
  match move second {
    Option<Header<'value>>.None => { return false }
    Option<Header<'value>>.Some {value} => {
      if Header.name(&value) != "set-cookie" || !equal(Header.value(&value), b"b=2") { return false }
    }
  }
  match move HeaderIterator.next(&mut cookies) {
    Option<Header<'value>>.Some {value} => { return false }
    Option<Header<'value>>.None => {}
  }
  match move Headers.getUnique(headers, "Set-Cookie") {
    Result<Option<Header<'value>>, ValueError>.Success {value} => { return false }
    Result<Option<Header<'value>>, ValueError>.Failure {error} => {
      if error.component != ValueComponent.Headers || error.offset != usize.ZERO {
        return false
      }
      match move error.fieldIndex {
        Option<usize>.None => { return false }
        Option<usize>.Some {value} => {
          if value != usize.ONE { return false }
        }
      }
      match move error.reason {
        ValueReason.LimitExceeded {limit, allowed, attempted} => {
          if limit != LimitKind.UniqueField || allowed != usize.ONE || attempted != 2 {
            return false
          }
        }
        _ => { return false }
      }
    }
  }
  let mut output: [u8; 58] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
  match move Headers.formatInto(headers, &mut output) {
    Result<usize, ValueError>.Failure {error} => { return false }
    Result<usize, ValueError>.Success {value} => {
      if value != 58 { return false }
      if !equal(
        &output,
        b"Set-Cookie: a=1\\r\\nset-cookie: b=2\\r\\nX-Bytes: a\\tb\\xFF\\r\\nEmpty: \\r\\n",
      ) { return false }
    }
  }
  let mut small: [u8; 57] = [77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77,77]
  match move Headers.formatInto(headers, &mut small) {
    Result<usize, ValueError>.Success {value} => { return false }
    Result<usize, ValueError>.Failure {error} => {
      if !outputError(move error, ValueComponent.Headers, 58, 57) {
        return false
      }
    }
  }
  if !filledWith(&small, 77) { return false }
  return rejectsHeaderValue(move crlfValue, configured, usize.ONE)
}

fn nextMetadata<'value>(
  iterator: &mut MetadataIterator<'value>,
  expected: &[u8],
  expectedRaw: &[u8],
  known: string,
  fieldIndex: usize,
) -> bool {
  match move MetadataIterator.next(move iterator) {
    Result<Option<MetadataToken<'value>>, ValueError>.Failure {error} => {
      drop error
      return false
    }
    Result<Option<MetadataToken<'value>>, ValueError>.Success {value} => {
      match move value {
        Option<MetadataToken<'value>>.None => { return false }
        Option<MetadataToken<'value>>.Some {value: token} => {
          return equal(MetadataToken.token(&token), expected)
            && equal(MetadataToken.raw(&token), expectedRaw)
            && MetadataToken.matches(&token, known)
            && MetadataToken.fieldIndex(&token) == fieldIndex
        }
      }
    }
  }
  return false
}

fn expectMetadataFailure<'value>(
  iterator: &mut MetadataIterator<'value>,
  field: usize,
  offset: usize,
) -> bool {
  match move MetadataIterator.next(move iterator) {
    Result<Option<MetadataToken<'value>>, ValueError>.Success {value} => {
      drop value
      return false
    }
    Result<Option<MetadataToken<'value>>, ValueError>.Failure {error} => {
      return indexedError(
        move error,
        ExpectedReason.InvalidToken,
        ValueComponent.Metadata,
        field,
        offset,
      )
    }
  }
  return false
}

fn inspectMetadata<'headers>(
  made: Result<Headers<'headers>, ValueError>,
  expectedTransferRaw: &[u8],
) -> bool {
  let headers = match move made {
    Result<Headers<'headers>, ValueError>.Failure {error} => { return false }
    Result<Headers<'headers>, ValueError>.Success {value} => value
  }
  let mut connections = Headers.connectionTokens(&headers)
  if !nextMetadata(&mut connections, b"keep-alive", b"keep-alive", "KEEP-ALIVE", usize.ZERO) { return false }
  if !nextMetadata(&mut connections, b"X-Hop", b"X-Hop", "x-hop", usize.ZERO) { return false }
  if !expectMetadataFailure(&mut connections, 3, 5) { return false }
  let mut contents = Headers.contentCodings(&headers)
  if !nextMetadata(&mut contents, b"GZip", b"GZip", "gzip", 1) { return false }
  if !nextMetadata(&mut contents, b"custom", b"custom", "CUSTOM", 1) { return false }
  let mut transfers = Headers.transferCodings(&headers)
  if !nextMetadata(&mut transfers, b"gzip", expectedTransferRaw, "GZIP", 2) { return false }
  if !nextMetadata(&mut transfers, b"chunked", b"chunked", "CHUNKED", 2) { return false }
  if !expectMetadataFailure(&mut transfers, 4, 10) { return false }
  return true
}

fn metadataCases<'value>(
  connection: &'value [u8],
  content: &'value [u8],
  transfer: &'value [u8],
  expectedTransferRaw: &'value [u8],
  badConnection: &'value [u8],
  badTransfer: &'value [u8],
) -> bool {
  let configured = limits(4096)
  let first = match move Header.make("Connection", move connection, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let second = match move Header.make("Content-Encoding", move content, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let third = match move Header.make("Transfer-Encoding", move transfer, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let fourth = match move Header.make("connection", move badConnection, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let fifth = match move Header.make("transfer-encoding", move badTransfer, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  return inspectMetadataFive(
    first,
    second,
    third,
    fourth,
    fifth,
    configured,
    move expectedTransferRaw,
  )
}

fn inspectMetadataFive<'value>(
  first: Header<'value>,
  second: Header<'value>,
  third: Header<'value>,
  fourth: Header<'value>,
  fifth: Header<'value>,
  configured: Limits,
  expectedTransferRaw: &'value [u8],
) -> bool {
  let entries: [Header<'value>; 5] = [first, second, third, fourth, fifth]
  return inspectMetadata(Headers.make(&entries, configured), move expectedTransferRaw)
}

fn rejectsMismatchedTarget<'target, 'headers>(
  target: RequestTarget<'target>,
  made: Result<Headers<'headers>, ValueError>,
) -> bool {
  let headers = match move made {
    Result<Headers<'headers>, ValueError>.Failure {error} => { return false }
    Result<Headers<'headers>, ValueError>.Success {value} => value
  }
  let get = Method.get()
  return mismatchedRequest(RequestHead.make(Version.Http10, get, target, headers))
}

fn targetFailed<'text>(
  result: Result<RequestTarget<'text>, ValueError>,
  expected: ExpectedReason,
  component: ValueComponent,
  offset: usize,
) -> bool {
  return match move result {
    Result<RequestTarget<'text>, ValueError>.Success {value} => false
    Result<RequestTarget<'text>, ValueError>.Failure {error} => unindexedError(
      move error,
      expected,
      component,
      offset,
    )
  }
}

fn validUtf8TargetFailed<'text>(
  decoded: Result<string<'text>, InvalidUtf8>,
  method: &Method,
) -> bool {
  let text = match move decoded {
    Result<string<'text>, InvalidUtf8>.Failure {error} => { return false }
    Result<string<'text>, InvalidUtf8>.Success {value} => value
  }
  return targetFailed(
    RequestTarget.parse(method, text, 256),
    ExpectedReason.InvalidTarget,
    ValueComponent.Target,
    usize.ZERO,
  )
}

fn targets() -> bool {
  let get = Method.get()
  let extension = Method.parse("CUSTOM", 32)
  match move extension {
    Result<Method<'static>, ValueError>.Failure {error} => { return false }
    Result<Method<'static>, ValueError>.Success {value: extensionMethod} => {
      match move RequestTarget.parse(&extensionMethod, "/a%2Fb?x=", 256) {
        Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
        Result<RequestTarget<'static>, ValueError>.Success {value} => {
          if RequestTarget.format(value) != "/a%2Fb?x=" { return false }
        }
      }
      match move RequestTarget.parse(&extensionMethod, "/a%2Fb?x=", 9) {
        Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
        Result<RequestTarget<'static>, ValueError>.Success {value} => {}
      }
      match move RequestTarget.parse(&extensionMethod, "/a%2Fb?x=", 8) {
        Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
        Result<RequestTarget<'static>, ValueError>.Failure {error} => {
          if !limitError(move error, ValueComponent.Target, LimitKind.TargetBytes, 8, 9) {
            return false
          }
        }
      }
    }
  }
  match move RequestTarget.parse(&get, "http://example.com/a", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => {
      if RequestTarget.format(value) != "http://example.com/a" { return false }
    }
  }
  match move RequestTarget.parse(&get, "ftp://example.com/a", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => {
      if RequestTarget.format(value) != "ftp://example.com/a" { return false }
    }
  }
  let connect = Method.connect()
  match move RequestTarget.parse(&connect, "[::1]:443", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => {
      if RequestTarget.format(value) != "[::1]:443" { return false }
      let emptyEntries: [Header<'static>; 0] = []
      if !rejectsMismatchedTarget(value, Headers.make(&emptyEntries, limits(4096))) {
        return false
      }
    }
  }
  let options = Method.options()
  match move RequestTarget.parse(&options, "*", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => {
      if RequestTarget.format(value) != "*" { return false }
      let emptyEntries: [Header<'static>; 0] = []
      if !rejectsMismatchedTarget(value, Headers.make(&emptyEntries, limits(4096))) {
        return false
      }
    }
  }
  match move RequestTarget.parse(&get, "*", 256) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.MethodTargetMismatch,
        ValueComponent.Target,
        usize.ZERO,
      ) { return false }
    }
  }
  match move RequestTarget.parse(&connect, "example.com", 256) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidPort, ValueComponent.Authority, 11) {
        return false
      }
    }
  }
  match move RequestTarget.parse(&connect, "example.com:0", 256) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidPort, ValueComponent.Authority, 13) {
        return false
      }
    }
  }
  match move RequestTarget.parse(&connect, "example.com:65536", 256) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidPort, ValueComponent.Authority, 16) {
        return false
      }
    }
  }
  match move RequestTarget.parse(&connect, ":443", 256) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.InvalidAuthority,
        ValueComponent.Authority,
        usize.ZERO,
      ) { return false }
    }
  }
  match move RequestTarget.parse(&get, "/x#fragment", 256) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidTarget, ValueComponent.Target, 2) {
        return false
      }
    }
  }
  match move RequestTarget.parse(&get, "http://user@example.com/x", 256) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.InvalidAuthority,
        ValueComponent.Authority,
        usize.ZERO,
      ) { return false }
    }
  }
  match move RequestTarget.parse(&get, "/white space", 256) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidTarget, ValueComponent.Target, 6) {
        return false
      }
    }
  }
  if !targetFailed(
    RequestTarget.parse(&get, "/\\t", 256),
    ExpectedReason.InvalidTarget,
    ValueComponent.Target,
    usize.ONE,
  ) { return false }
  let nonAsciiBytes: [u8; 2] = [195,169]
  if !validUtf8TargetFailed(String.fromUtf8(&nonAsciiBytes), &get) { return false }
  match move RequestTarget.parse(&get, "/", usize.ZERO) {
    Result<RequestTarget<'static>, ValueError>.Success {value} => { return false }
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      if !limitError(
        move error,
        ValueComponent.Target,
        LimitKind.TargetBytes,
        usize.ZERO,
        usize.ONE,
      ) { return false }
    }
  }
  match move HttpAuthority.parse("example.com:abc") {
    Result<HttpAuthority<'static>, ValueError>.Success {value} => { return false }
    Result<HttpAuthority<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidPort, ValueComponent.Authority, 12) {
        return false
      }
    }
  }
  match move HttpAuthority.parse("example.com:1:2") {
    Result<HttpAuthority<'static>, ValueError>.Success {value} => { return false }
    Result<HttpAuthority<'static>, ValueError>.Failure {error} => {
      if !unindexedError(move error, ExpectedReason.InvalidPort, ValueComponent.Authority, 13) {
        return false
      }
    }
  }
  match move HttpAuthority.parse("") {
    Result<HttpAuthority<'static>, ValueError>.Failure {error} => { return false }
    Result<HttpAuthority<'static>, ValueError>.Success {value} => {
      if HttpAuthority.host(&value) != "" { return false }
    }
  }
  let emptyQuery = Uri.parse("http://example.com?")
  match move emptyQuery {
    Result<Uri<'static>, ParseError>.Failure {error} => { return false }
    Result<Uri<'static>, ParseError>.Success {value} => {
      let mut output: [u8; 2] = [0,0]
      match move RequestTarget.fromUri(&value, TargetForm.Origin, &mut output) {
        Result<usize, ValueError>.Failure {error} => { return false }
        Result<usize, ValueError>.Success {value: count} => {
          if count != 2 || !equal(&output, b"/?") { return false }
        }
      }
    }
  }
  let withUserinfo = Uri.parse("http://user@example.com/x")
  match move withUserinfo {
    Result<Uri<'static>, ParseError>.Failure {error} => { return false }
    Result<Uri<'static>, ParseError>.Success {value} => {
      let mut output: [u8; 64] = [7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7,7]
      match move RequestTarget.fromUri(&value, TargetForm.Origin, &mut output) {
        Result<usize, ValueError>.Success {value: count} => { return false }
        Result<usize, ValueError>.Failure {error} => {
          if !unindexedError(
            move error,
            ExpectedReason.InvalidAuthority,
            ValueComponent.Authority,
            usize.ZERO,
          ) { return false }
        }
      }
      if !filledWith(&output, 7) { return false }
      let mut hostOutput: [u8; 64] = [9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9,9]
      match move hostForUri(&value, &mut hostOutput) {
        Result<usize, ValueError>.Success {value: count} => { return false }
        Result<usize, ValueError>.Failure {error} => {
          if !unindexedError(
            move error,
            ExpectedReason.InvalidAuthority,
            ValueComponent.Authority,
            usize.ZERO,
          ) { return false }
        }
      }
      if !filledWith(&hostOutput, 9) { return false }
    }
  }
  let parsed = Uri.parse("http://example.com?x=#section")
  return match move parsed {
    Result<Uri<'static>, ParseError>.Failure {error} => false
    Result<Uri<'static>, ParseError>.Success {value} => {
      let mut target: [u8; 4] = [0,0,0,0]
      match move RequestTarget.fromUri(&value, TargetForm.Origin, &mut target) {
        Result<usize, ValueError>.Failure {error} => { return false }
        Result<usize, ValueError>.Success {value: count} => {
          if count != 4 || !equal(&target, b"/?x=") { return false }
        }
      }
      let mut absolute: [u8; 22] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
      match move RequestTarget.fromUri(&value, TargetForm.Absolute, &mut absolute) {
        Result<usize, ValueError>.Failure {error} => { return false }
        Result<usize, ValueError>.Success {value: count} => {
          if count != 22 || !equal(&absolute, b"http://example.com/?x=") { return false }
        }
      }
      let mut small: [u8; 3] = [7,7,7]
      match move RequestTarget.fromUri(&value, TargetForm.Origin, &mut small) {
        Result<usize, ValueError>.Success {value: count} => { return false }
        Result<usize, ValueError>.Failure {error} => {
          if !outputError(move error, ValueComponent.Target, 4, 3) || !filledWith(&small, 7) {
            return false
          }
        }
      }
      let mut smallHost: [u8; 10] = [8,8,8,8,8,8,8,8,8,8]
      match move hostForUri(&value, &mut smallHost) {
        Result<usize, ValueError>.Success {value: count} => { return false }
        Result<usize, ValueError>.Failure {error} => {
          if !outputError(move error, ValueComponent.Host, 11, 10)
            || !filledWith(&smallHost, 8) {
            return false
          }
        }
      }
      let mut host: [u8; 11] = [0,0,0,0,0,0,0,0,0,0,0]
      return match move hostForUri(&value, &mut host) {
        Result<usize, ValueError>.Failure {error} => false
        Result<usize, ValueError>.Success {value: count} => count == 11 && equal(&host, b"example.com")
      }
    }
  }
}

fn requestSucceeded<'value>(result: Result<RequestHead<'value>, ValueError>) -> bool {
  return match move result {
    Result<RequestHead<'value>, ValueError>.Failure {error} => false
    Result<RequestHead<'value>, ValueError>.Success {value} => true
  }
}

fn mismatchedRequest<'value>(result: Result<RequestHead<'value>, ValueError>) -> bool {
  return match move result {
    Result<RequestHead<'value>, ValueError>.Success {value} => false
    Result<RequestHead<'value>, ValueError>.Failure {error} => unindexedError(
      move error,
      ExpectedReason.MethodTargetMismatch,
      ValueComponent.Target,
      usize.ZERO,
    )
  }
}

fn responseSucceeded<'value>(result: Result<ResponseHead<'value>, ValueError>) -> bool {
  return match move result {
    Result<ResponseHead<'value>, ValueError>.Failure {error} => false
    Result<ResponseHead<'value>, ValueError>.Success {value} => true
  }
}

fn reasonByteFailure<'value>(result: Result<ResponseHead<'value>, ValueError>, offset: usize) -> bool {
  return match move result {
    Result<ResponseHead<'value>, ValueError>.Success {value} => false
    Result<ResponseHead<'value>, ValueError>.Failure {error} => unindexedError(
      move error,
      ExpectedReason.InvalidValueByte,
      ValueComponent.ReasonPhrase,
      offset,
    )
  }
}

fn reasonLimitFailure<'value>(
  result: Result<ResponseHead<'value>, ValueError>,
  allowed: usize,
  attempted: usize,
) -> bool {
  return match move result {
    Result<ResponseHead<'value>, ValueError>.Success {value} => false
    Result<ResponseHead<'value>, ValueError>.Failure {error} => limitError(
      move error,
      ValueComponent.ReasonPhrase,
      LimitKind.ValueBytes,
      allowed,
      attempted,
    )
  }
}

fn rejectsReason<'headers, 'reason>(
  headers: &Headers<'headers>,
  status: Status,
  reason: &'reason [u8],
  configured: Limits,
) -> bool {
  return reasonByteFailure(ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&[u8]>(move reason),
    headers.*,
    configured,
  ), usize.ZERO)
}

fn inspectHostAndHeads<'headers, 'reason>(
  made: Result<Headers<'headers>, ValueError>,
  validReason: &'reason [u8],
  emptyReason: &'reason [u8],
  badReason: &'reason [u8],
  longReason: &'reason [u8],
) -> bool {
  let headers = match move made {
    Result<Headers<'headers>, ValueError>.Failure {error} => { return false }
    Result<Headers<'headers>, ValueError>.Success {value} => value
  }
  let get = Method.get()
  let origin = match move RequestTarget.parse(&get, "/resource", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => value
  }
  if !requestSucceeded(RequestHead.make(Version.Http11, get, origin, headers)) { return false }
  let host = match move validateRequestHost(Version.Http11, &origin, &headers) {
    Result<Option<HttpAuthority<'headers>>, ValueError>.Failure {error} => { return false }
    Result<Option<HttpAuthority<'headers>>, ValueError>.Success {value} => value
  }
  match move effectiveAuthority(origin, move host) {
    Result<Option<HttpAuthority<'headers>>, ValueError>.Failure {error} => { return false }
    Result<Option<HttpAuthority<'headers>>, ValueError>.Success {value} => {
      match move value {
        Option<HttpAuthority<'headers>>.None => { return false }
        Option<HttpAuthority<'headers>>.Some {value: authority} => {
          if HttpAuthority.format(&authority) != "host.example" { return false }
        }
      }
    }
  }
  let absolute = match move RequestTarget.parse(&get, "http://target.example/path", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => value
  }
  let hostAgain = match move validateRequestHost(Version.Http11, &absolute, &headers) {
    Result<Option<HttpAuthority<'headers>>, ValueError>.Failure {error} => { return false }
    Result<Option<HttpAuthority<'headers>>, ValueError>.Success {value} => value
  }
  match move effectiveAuthority(absolute, move hostAgain) {
    Result<Option<HttpAuthority<'headers>>, ValueError>.Failure {error} => { return false }
    Result<Option<HttpAuthority<'headers>>, ValueError>.Success {value} => {
      match move value {
        Option<HttpAuthority<'headers>>.None => { return false }
        Option<HttpAuthority<'headers>>.Some {value: authority} => {
          if HttpAuthority.format(&authority) != "target.example" { return false }
        }
      }
    }
  }
  let connect = Method.connect()
  let connectTarget = match move RequestTarget.parse(&connect, "[::1]:443", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => value
  }
  let connectHost = match move validateRequestHost(Version.Http11, &connectTarget, &headers) {
    Result<Option<HttpAuthority<'headers>>, ValueError>.Failure {error} => { return false }
    Result<Option<HttpAuthority<'headers>>, ValueError>.Success {value} => value
  }
  match move effectiveAuthority(connectTarget, move connectHost) {
    Result<Option<HttpAuthority<'headers>>, ValueError>.Failure {error} => { return false }
    Result<Option<HttpAuthority<'headers>>, ValueError>.Success {value} => {
      match move value {
        Option<HttpAuthority<'headers>>.None => { return false }
        Option<HttpAuthority<'headers>>.Some {value: authority} => {
          if HttpAuthority.format(&authority) != "[::1]:443" { return false }
        }
      }
    }
  }
  let options = Method.options()
  let asterisk = match move RequestTarget.parse(&options, "*", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => value
  }
  let asteriskHost = match move validateRequestHost(Version.Http11, &asterisk, &headers) {
    Result<Option<HttpAuthority<'headers>>, ValueError>.Failure {error} => { return false }
    Result<Option<HttpAuthority<'headers>>, ValueError>.Success {value} => value
  }
  match move effectiveAuthority(asterisk, move asteriskHost) {
    Result<Option<HttpAuthority<'headers>>, ValueError>.Failure {error} => { return false }
    Result<Option<HttpAuthority<'headers>>, ValueError>.Success {value} => {
      match move value {
        Option<HttpAuthority<'headers>>.None => { return false }
        Option<HttpAuthority<'headers>>.Some {value: authority} => {
          if HttpAuthority.format(&authority) != "host.example" { return false }
        }
      }
    }
  }
  let status = match move Status.fromCode(299) {
    Result<Status, ValueError>.Failure {error} => { return false }
    Result<Status, ValueError>.Success {value} => value
  }
  let configured = limits(4096)
  if !responseSucceeded(ResponseHead.make(
    Version.Http11,
    status,
    Option.none<&[u8]>(),
    headers,
    configured,
  )) { return false }
  if !responseSucceeded(ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&[u8]>(move validReason),
    headers,
    configured,
  )) { return false }
  if !responseSucceeded(ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&[u8]>(move emptyReason),
    headers,
    configured,
  )) { return false }
  if !reasonByteFailure(ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&[u8]>(move badReason),
    headers,
    configured,
  ), 3) { return false }
  let mut short = configured
  short.maxValueBytes = 3
  if !responseSucceeded(ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&[u8]>(b"abc"),
    headers,
    short,
  )) { return false }
  if !reasonLimitFailure(ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&[u8]>(move longReason),
    headers,
    short,
  ), 3, 4) { return false }
  let mut candidate: [u8; 1] = [0]
  let mut byte = usize.ZERO
  while byte < 32 {
    candidate[usize.ZERO] = usize.toU8(byte)
    if byte != 9 && !rejectsReason(&headers, status, &candidate, configured) { return false }
    byte = byte + usize.ONE
  }
  candidate[usize.ZERO] = 127
  if !rejectsReason(&headers, status, &candidate, configured) { return false }
  return true
}

fn inspectHostFailure<'headers>(
  made: Result<Headers<'headers>, ValueError>,
  expected: ExpectedReason,
  fieldIndex: usize,
  offset: usize,
) -> bool {
  let headers = match move made {
    Result<Headers<'headers>, ValueError>.Failure {error} => { return false }
    Result<Headers<'headers>, ValueError>.Success {value} => value
  }
  let get = Method.get()
  let target = match move RequestTarget.parse(&get, "/", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => value
  }
  return match move RequestHead.make(Version.Http11, get, target, headers) {
    Result<RequestHead<'headers>, ValueError>.Success {value} => false
    Result<RequestHead<'headers>, ValueError>.Failure {error} => indexedError(
      move error,
      expected,
      ValueComponent.Host,
      fieldIndex,
      offset,
    )
  }
}

fn inspectMissingHost<'headers>(made: Result<Headers<'headers>, ValueError>) -> bool {
  let headers = match move made {
    Result<Headers<'headers>, ValueError>.Failure {error} => { return false }
    Result<Headers<'headers>, ValueError>.Success {value} => value
  }
  let get = Method.get()
  let target = match move RequestTarget.parse(&get, "/", 256) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => { return false }
    Result<RequestTarget<'static>, ValueError>.Success {value} => value
  }
  match move RequestHead.make(Version.Http11, get, target, headers) {
    Result<RequestHead<'headers>, ValueError>.Success {value} => { return false }
    Result<RequestHead<'headers>, ValueError>.Failure {error} => {
      if !unindexedError(
        move error,
        ExpectedReason.MissingHost,
        ValueComponent.Host,
        usize.ZERO,
      ) { return false }
    }
  }
  return requestSucceeded(RequestHead.make(Version.Http10, get, target, headers))
}

fn headCases<'value>(
  hostValue: &'value [u8],
  otherHostValue: &'value [u8],
  invalidHostValue: &'value [u8],
  obsTextHostValue: &'value [u8],
  validReason: &'value [u8],
  emptyReason: &'value [u8],
  badReason: &'value [u8],
  longReason: &'value [u8],
) -> bool {
  let configured = limits(4096)
  let host = match move Header.make("Host", move hostValue, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let otherHost = match move Header.make("host", move otherHostValue, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let invalidHost = match move Header.make("HOST", move invalidHostValue, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let obsTextHost = match move Header.make("Host", move obsTextHostValue, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  return inspectHeadPair(
    host,
    otherHost,
    invalidHost,
    obsTextHost,
    configured,
    move validReason,
    move emptyReason,
    move badReason,
    move longReason,
  )
}

fn inspectHeadPair<'value>(
  host: Header<'value>,
  otherHost: Header<'value>,
  invalidHost: Header<'value>,
  obsTextHost: Header<'value>,
  configured: Limits,
  validReason: &'value [u8],
  emptyReason: &'value [u8],
  badReason: &'value [u8],
  longReason: &'value [u8],
) -> bool {
  let one: [Header<'value>; 1] = [host]
  if !inspectHostAndHeads(
    Headers.make(&one, configured),
    move validReason,
    move emptyReason,
    move badReason,
    move longReason,
  ) { return false }
  let duplicate: [Header<'value>; 2] = [host, otherHost]
  if !inspectHostFailure(
    Headers.make(&duplicate, configured),
    ExpectedReason.DuplicateHost,
    usize.ONE,
    usize.ZERO,
  ) { return false }
  let invalid: [Header<'value>; 1] = [invalidHost]
  if !inspectHostFailure(
    Headers.make(&invalid, configured),
    ExpectedReason.InvalidAuthority,
    usize.ZERO,
    3,
  ) { return false }
  let obsText: [Header<'value>; 1] = [obsTextHost]
  if !inspectHostFailure(
    Headers.make(&obsText, configured),
    ExpectedReason.InvalidAuthority,
    usize.ZERO,
    usize.ZERO,
  ) { return false }
  let empty: [Header<'value>; 0] = []
  return inspectMissingHost(Headers.make(&empty, configured))
}

effect fn copiedHeaders<'value>(
  name: string<'value>,
  bytes: &'value [u8],
) -> Result<OwnedHeaders, ValueError>
! OutOfMemoryError ? &mut Allocator {
  let configured = limits(4096)
  let made = Header.make(move name, move bytes, configured)
  return match move made {
    Result<Header<'value>, ValueError>.Failure {error} => Result.failResult<OwnedHeaders, ValueError>(move error)
    Result<Header<'value>, ValueError>.Success {value: header} => {
      let entries = [header]
      return run copyMade(Headers.make(&entries, configured), configured)
    }
  }
}

effect fn ownedHeadersSucceeded<'value>(
  headers: &Headers<'value>,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let copied = run Headers.copy(headers, limits(4096))
  return match move copied {
    Result<OwnedHeaders, ValueError>.Failure {error} => false
    Result<OwnedHeaders, ValueError>.Success {value} => true
  }
}

effect fn ownedRequestSucceeded() -> bool ! OutOfMemoryError ? &mut Allocator {
  let copied = run copiedRequestHead("PATCH", "/owned", b"host.example")
  return match move copied {
    Result<OwnedRequestHead, ValueError>.Failure {error} => false
    Result<OwnedRequestHead, ValueError>.Success {value} => true
  }
}

effect fn ownedResponseSucceeded() -> bool ! OutOfMemoryError ? &mut Allocator {
  let copied = run copiedResponseHead(b"why", b"field")
  return match move copied {
    Result<OwnedResponseHead, ValueError>.Failure {error} => false
    Result<OwnedResponseHead, ValueError>.Success {value} => true
  }
}

effect fn ownedBudgetMade<'value>(
  made: Result<Headers<'value>, ValueError>,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let headers = match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => { return false }
    Result<Headers<'value>, ValueError>.Success {value} => value
  }
  let required = match move Headers.requiredOwnedBytes(&headers) {
    Result<usize, ValueError>.Failure {error} => { return false }
    Result<usize, ValueError>.Success {value} => value
  }
  let exact = run Headers.copy(&headers, limits(required))
  let owned = match move exact {
    Result<OwnedHeaders, ValueError>.Failure {error} => { return false }
    Result<OwnedHeaders, ValueError>.Success {value} => move value
  }
  if OwnedHeaders.ownedBytes(&owned) != required { return false }
  let short = run Headers.copy(&headers, limits(required - usize.ONE))
  return match move short {
    Result<OwnedHeaders, ValueError>.Success {value} => false
    Result<OwnedHeaders, ValueError>.Failure {error} => limitError(
      move error,
      ValueComponent.Headers,
      LimitKind.OwnedBytes,
      required - usize.ONE,
      required,
    )
  }
}

effect fn ownedLimitRejectedMade<'value>(
  made: Result<Headers<'value>, ValueError>,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let headers = match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => { return false }
    Result<Headers<'value>, ValueError>.Success {value} => value
  }
  let required = match move Headers.requiredOwnedBytes(&headers) {
    Result<usize, ValueError>.Failure {error} => { return false }
    Result<usize, ValueError>.Success {value} => value
  }
  return match move (run Headers.copy(&headers, limits(required - usize.ONE))) {
    Result<OwnedHeaders, ValueError>.Success {value} => false
    Result<OwnedHeaders, ValueError>.Failure {error} => limitError(
      move error,
      ValueComponent.Headers,
      LimitKind.OwnedBytes,
      required - usize.ONE,
      required,
    )
  }
}

effect fn ownedLimitRejected<'value>(
  name: string<'value>,
  bytes: &'value [u8],
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let configured = limits(4096)
  let header = match move Header.make(move name, move bytes, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let entries = [header]
  return run ownedLimitRejectedMade(Headers.make(&entries, configured))
}

effect fn ownedBudgetCase<'value>(
  name: string<'value>,
  bytes: &'value [u8],
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let configured = limits(4096)
  let header = match move Header.make(move name, move bytes, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let entries = [header]
  return run ownedBudgetMade(Headers.make(&entries, configured))
}

effect fn rejectedBeforeAllocationMade<'value>(
  made: Result<Headers<'value>, ValueError>,
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let headers = match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => { return false }
    Result<Headers<'value>, ValueError>.Success {value} => value
  }
  let mut forbidden = limits(4096)
  forbidden.maxFields = usize.ZERO
  let copied = run Headers.copy(&headers, forbidden)
  return match move copied {
    Result<OwnedHeaders, ValueError>.Success {value} => false
    Result<OwnedHeaders, ValueError>.Failure {error} => true
  }
}

effect fn rejectedBeforeAllocation<'value>(
  name: string<'value>,
  bytes: &'value [u8],
) -> bool ! OutOfMemoryError ? &mut Allocator {
  let configured = limits(4096)
  let header = match move Header.make(move name, move bytes, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => { return false }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let entries = [header]
  return run rejectedBeforeAllocationMade(Headers.make(&entries, configured))
}

struct RefusingAllocator {
  calls: usize
  failAt: usize
}

effect fn allocate(
  self: &mut RefusingAllocator,
  layout: Layout,
) -> Allocation ! OutOfMemoryError {
  self.calls = self.calls + usize.ONE
  if self.calls == self.failAt { return run Allocator.outOfMemory() }
  let mut system = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut<Allocator>(&mut system)
}

impl Allocator for RefusingAllocator { allocate: RefusingAllocator.allocate }

effect fn allocationFailed(error: OutOfMemoryError) -> bool { return false }

effect fn allocationBoundaries<'value>(headers: &Headers<'value>) -> bool {
  let mut audit = RefusingAllocator {calls: usize.ZERO, failAt: usize.ZERO}
  audit.failAt = usize.ONE
  let rejected = run Effect.catchAll(
    rejectedBeforeAllocation("X-A", b"one") |> Effect.provideMut<Allocator>(&mut audit),
    allocationFailed,
  )
  if !rejected || audit.calls != usize.ZERO { return false }
  audit.calls = usize.ZERO
  let rejectedHeads = run Effect.catchAll(
    rejectedHeadLimits() |> Effect.provideMut<Allocator>(&mut audit),
    allocationFailed,
  )
  if !rejectedHeads || audit.calls != usize.ZERO { return false }
  audit.calls = usize.ZERO
  let rejectedOwned = run Effect.catchAll(
    ownedLimitRejected("X-A", b"one") |> Effect.provideMut<Allocator>(&mut audit),
    allocationFailed,
  )
  if !rejectedOwned || audit.calls != usize.ZERO { return false }
  audit.failAt = usize.ZERO
  let calibrated = run Effect.catchAll(
    ownedHeadersSucceeded(headers) |> Effect.provideMut<Allocator>(&mut audit),
    allocationFailed,
  )
  if !calibrated || audit.calls == usize.ZERO { return false }
  let total = audit.calls
  let mut ordinal = usize.ONE
  while ordinal <= total {
    audit.calls = usize.ZERO
    audit.failAt = ordinal
    let refused = run Effect.catchAll(
      ownedHeadersSucceeded(headers) |> Effect.provideMut<Allocator>(&mut audit),
      allocationFailed,
    )
    if refused || audit.calls != ordinal { return false }
    audit.calls = usize.ZERO
    audit.failAt = usize.ZERO
    let retried = run Effect.catchAll(
      ownedHeadersSucceeded(headers) |> Effect.provideMut<Allocator>(&mut audit),
      allocationFailed,
    )
    if !retried { return false }
    ordinal = ordinal + usize.ONE
  }
  audit.calls = usize.ZERO
  audit.failAt = usize.ZERO
  let calibratedRequest = run Effect.catchAll(
    ownedRequestSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
    allocationFailed,
  )
  if !calibratedRequest || audit.calls == usize.ZERO { return false }
  let requestTotal = audit.calls
  ordinal = usize.ONE
  while ordinal <= requestTotal {
    audit.calls = usize.ZERO
    audit.failAt = ordinal
    let refused = run Effect.catchAll(
      ownedRequestSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
      allocationFailed,
    )
    if refused || audit.calls != ordinal { return false }
    audit.calls = usize.ZERO
    audit.failAt = usize.ZERO
    let retried = run Effect.catchAll(
      ownedRequestSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
      allocationFailed,
    )
    if !retried { return false }
    ordinal = ordinal + usize.ONE
  }
  audit.calls = usize.ZERO
  audit.failAt = usize.ZERO
  let calibratedResponse = run Effect.catchAll(
    ownedResponseSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
    allocationFailed,
  )
  if !calibratedResponse || audit.calls == usize.ZERO { return false }
  let responseTotal = audit.calls
  ordinal = usize.ONE
  while ordinal <= responseTotal {
    audit.calls = usize.ZERO
    audit.failAt = ordinal
    let refused = run Effect.catchAll(
      ownedResponseSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
      allocationFailed,
    )
    if refused || audit.calls != ordinal { return false }
    audit.calls = usize.ZERO
    audit.failAt = usize.ZERO
    let retried = run Effect.catchAll(
      ownedResponseSucceeded() |> Effect.provideMut<Allocator>(&mut audit),
      allocationFailed,
    )
    if !retried { return false }
    ordinal = ordinal + usize.ONE
  }
  return true
}

effect fn copyMade<'value>(
  made: Result<Headers<'value>, ValueError>,
  configured: Limits,
) -> Result<OwnedHeaders, ValueError> ! OutOfMemoryError ? &mut Allocator {
  return match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => Result.failResult<
      OwnedHeaders,
      ValueError,
    >(move error)
    Result<Headers<'value>, ValueError>.Success {value} => run Headers.copy(&value, configured)
  }
}

effect fn copyRequestMade<'value>(
  made: Result<Headers<'value>, ValueError>,
  methodText: string<'value>,
  targetText: string<'value>,
  configured: Limits,
) -> Result<OwnedRequestHead, ValueError> ! OutOfMemoryError ? &mut Allocator {
  let headers = match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<Headers<'value>, ValueError>.Success {value} => value
  }
  let method = match move Method.parse(move methodText, configured.maxMethodBytes) {
    Result<Method<'value>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<Method<'value>, ValueError>.Success {value} => value
  }
  let target = match move RequestTarget.parse(
    &method,
    move targetText,
    configured.maxTargetBytes,
  ) {
    Result<RequestTarget<'value>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<RequestTarget<'value>, ValueError>.Success {value} => value
  }
  let head = match move RequestHead.make(Version.Http11, method, target, headers) {
    Result<RequestHead<'value>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<RequestHead<'value>, ValueError>.Success {value} => value
  }
  return run RequestHead.copy(&head, configured)
}

effect fn copiedRequestHead<'value>(
  methodText: string<'value>,
  targetText: string<'value>,
  hostBytes: &'value [u8],
) -> Result<OwnedRequestHead, ValueError> ! OutOfMemoryError ? &mut Allocator {
  let configured = limits(4096)
  let header = match move Header.make("Host", move hostBytes, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let entries = [header]
  return run copyRequestMade(
    Headers.make(&entries, configured),
    move methodText,
    move targetText,
    configured,
  )
}

fn inspectOwnedRequest(owner: &OwnedRequestHead) -> bool {
  let view = OwnedRequestHead.view(owner)
  let method = RequestHead.method(&view)
  let target = RequestHead.target(&view)
  if Method.format(&method) != "PATCH" || RequestTarget.format(target) != "/owned" {
    return false
  }
  let headers = RequestHead.headers(&view)
  return inspectNamedHeader(&headers, "host", b"host.example")
}

effect fn copyResponseMade<'value>(
  made: Result<Headers<'value>, ValueError>,
  reason: &'value [u8],
  configured: Limits,
) -> Result<OwnedResponseHead, ValueError> ! OutOfMemoryError ? &mut Allocator {
  let headers = match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedResponseHead, ValueError>(move error)
    }
    Result<Headers<'value>, ValueError>.Success {value} => value
  }
  let status = match move Status.fromCode(299) {
    Result<Status, ValueError>.Failure {error} => {
      return Result.failResult<OwnedResponseHead, ValueError>(move error)
    }
    Result<Status, ValueError>.Success {value} => value
  }
  let head = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&'value [u8]>(move reason),
    headers,
    configured,
  ) {
    Result<ResponseHead<'value>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedResponseHead, ValueError>(move error)
    }
    Result<ResponseHead<'value>, ValueError>.Success {value} => value
  }
  return run ResponseHead.copy(&head, configured)
}

effect fn copiedResponseHead<'value>(
  reason: &'value [u8],
  fieldValue: &'value [u8],
) -> Result<OwnedResponseHead, ValueError> ! OutOfMemoryError ? &mut Allocator {
  let configured = limits(4096)
  let header = match move Header.make("X-Owned", move fieldValue, configured) {
    Result<Header<'value>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedResponseHead, ValueError>(move error)
    }
    Result<Header<'value>, ValueError>.Success {value} => value
  }
  let entries = [header]
  return run copyResponseMade(Headers.make(&entries, configured), move reason, configured)
}

fn inspectOwnedResponse(owner: &OwnedResponseHead) -> bool {
  let view = OwnedResponseHead.view(owner)
  let status = ResponseHead.status(&view)
  if Status.code(&status) != 299 { return false }
  match move ResponseHead.reason(&view) {
    Option<&[u8]>.None => { return false }
    Option<&[u8]>.Some {value} => {
      if !equal(value, b"why\\t\\x80") { return false }
    }
  }
  let headers = ResponseHead.headers(&view)
  return inspectNamedHeader(&headers, "x-owned", b"field")
}

effect fn requestCopyWithLimits(
  copyLimits: Limits,
) -> Result<OwnedRequestHead, ValueError> ! OutOfMemoryError ? &mut Allocator {
  let configured = limits(4096)
  let host = match move Header.make("Host", b"host.example", configured) {
    Result<Header<'static>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<Header<'static>, ValueError>.Success {value} => value
  }
  let entries = [host]
  return run requestCopyFromHeaders(Headers.make(&entries, configured), copyLimits)
}

effect fn requestCopyFromHeaders<'headers>(
  made: Result<Headers<'headers>, ValueError>,
  copyLimits: Limits,
) -> Result<OwnedRequestHead, ValueError> ! OutOfMemoryError ? &mut Allocator {
  let headers = match move made {
    Result<Headers<'headers>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<Headers<'headers>, ValueError>.Success {value} => value
  }
  let configured = limits(4096)
  let method = Method.patch()
  let target = match move RequestTarget.parse(&method, "/owned", configured.maxTargetBytes) {
    Result<RequestTarget<'static>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<RequestTarget<'static>, ValueError>.Success {value} => value
  }
  let head = match move RequestHead.make(Version.Http11, method, target, headers) {
    Result<RequestHead<'headers>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedRequestHead, ValueError>(move error)
    }
    Result<RequestHead<'headers>, ValueError>.Success {value} => value
  }
  return run RequestHead.copy(&head, copyLimits)
}

effect fn responseCopyWithLimits(
  copyLimits: Limits,
) -> Result<OwnedResponseHead, ValueError> ! OutOfMemoryError ? &mut Allocator {
  let configured = limits(4096)
  let header = match move Header.make("X-Owned", b"field", configured) {
    Result<Header<'static>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedResponseHead, ValueError>(move error)
    }
    Result<Header<'static>, ValueError>.Success {value} => value
  }
  let entries = [header]
  return run responseCopyFromHeaders(Headers.make(&entries, configured), copyLimits)
}

effect fn responseCopyFromHeaders<'headers>(
  made: Result<Headers<'headers>, ValueError>,
  copyLimits: Limits,
) -> Result<OwnedResponseHead, ValueError> ! OutOfMemoryError ? &mut Allocator {
  let headers = match move made {
    Result<Headers<'headers>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedResponseHead, ValueError>(move error)
    }
    Result<Headers<'headers>, ValueError>.Success {value} => value
  }
  let configured = limits(4096)
  let status = match move Status.fromCode(299) {
    Result<Status, ValueError>.Failure {error} => {
      return Result.failResult<OwnedResponseHead, ValueError>(move error)
    }
    Result<Status, ValueError>.Success {value} => value
  }
  let head = match move ResponseHead.make(
    Version.Http11,
    status,
    Option.some<&[u8]>(b"why"),
    headers,
    configured,
  ) {
    Result<ResponseHead<'headers>, ValueError>.Failure {error} => {
      return Result.failResult<OwnedResponseHead, ValueError>(move error)
    }
    Result<ResponseHead<'headers>, ValueError>.Success {value} => value
  }
  return run ResponseHead.copy(&head, copyLimits)
}

effect fn rejectedHeadLimits() -> bool ! OutOfMemoryError ? &mut Allocator {
  let mut configured = limits(4096)
  configured.maxMethodBytes = 4
  match move (run requestCopyWithLimits(configured)) {
    Result<OwnedRequestHead, ValueError>.Success {value} => { return false }
    Result<OwnedRequestHead, ValueError>.Failure {error} => {
      if !limitError(move error, ValueComponent.Method, LimitKind.MethodBytes, 4, 5) {
        return false
      }
    }
  }
  configured = limits(4096)
  configured.maxTargetBytes = 5
  match move (run requestCopyWithLimits(configured)) {
    Result<OwnedRequestHead, ValueError>.Success {value} => { return false }
    Result<OwnedRequestHead, ValueError>.Failure {error} => {
      if !limitError(move error, ValueComponent.Target, LimitKind.TargetBytes, 5, 6) {
        return false
      }
    }
  }
  configured = limits(4096)
  configured.maxNameBytes = 3
  match move (run requestCopyWithLimits(configured)) {
    Result<OwnedRequestHead, ValueError>.Success {value} => { return false }
    Result<OwnedRequestHead, ValueError>.Failure {error} => {
      if !indexedLimitError(
        move error,
        ValueComponent.HeaderName,
        LimitKind.NameBytes,
        3,
        4,
        usize.ZERO,
      ) { return false }
    }
  }
  configured = limits(4096)
  configured.maxValueBytes = 2
  return match move (run responseCopyWithLimits(configured)) {
    Result<OwnedResponseHead, ValueError>.Success {value} => false
    Result<OwnedResponseHead, ValueError>.Failure {error} => limitError(
      move error,
      ValueComponent.ReasonPhrase,
      LimitKind.ValueBytes,
      2,
      3,
    )
  }
}

effect fn exactHeadLimits() -> bool ! OutOfMemoryError ? &mut Allocator {
  let mut requestLimits = limits(4096)
  requestLimits.maxMethodBytes = 5
  requestLimits.maxTargetBytes = 6
  requestLimits.maxNameBytes = 4
  requestLimits.maxValueBytes = 12
  requestLimits.maxFields = usize.ONE
  requestLimits.maxFieldBytes = 16
  match move (run requestCopyWithLimits(requestLimits)) {
    Result<OwnedRequestHead, ValueError>.Failure {error} => { return false }
    Result<OwnedRequestHead, ValueError>.Success {value} => { drop value }
  }
  let mut responseLimits = limits(4096)
  responseLimits.maxNameBytes = 7
  responseLimits.maxValueBytes = 5
  responseLimits.maxFields = usize.ONE
  responseLimits.maxFieldBytes = 12
  return match move (run responseCopyWithLimits(responseLimits)) {
    Result<OwnedResponseHead, ValueError>.Failure {error} => false
    Result<OwnedResponseHead, ValueError>.Success {value} => true
  }
}

effect fn zeroOwnedBounds() -> bool ! OutOfMemoryError ? &mut Allocator {
  let zero = Limits {
    maxMethodBytes: usize.ZERO,
    maxTargetBytes: usize.ZERO,
    maxNameBytes: usize.ZERO,
    maxValueBytes: usize.ZERO,
    maxFields: usize.ZERO,
    maxFieldBytes: usize.ZERO,
    maxOwnedBytes: usize.ZERO,
  }
  let entries: [Header<'static>; 0] = []
  return match move (run copyMade(Headers.make(&entries, zero), zero)) {
    Result<OwnedHeaders, ValueError>.Failure {error} => false
    Result<OwnedHeaders, ValueError>.Success {value} => OwnedHeaders.ownedBytes(&value) == usize.ZERO
  }
}

fn inspectNamedHeader<'value>(headers: &Headers<'value>, name: string, expected: &[u8]) -> bool {
  return match move Headers.getFirst(headers, name) {
    Option<Header<'value>>.None => false
    Option<Header<'value>>.Some {value} => equal(Header.value(&value), expected)
  }
}

effect fn ownership() -> bool ! OutOfMemoryError ? &mut Allocator {
  let mut nameBytes: [u8; 7] = [88,45,79,119,110,101,100]
  let mut valueBytes: [u8; 3] = [121,101,115]
  let name = unsafe String.fromUtf8Unchecked(&nameBytes)
  let copied = run copiedHeaders(name, &valueBytes)
  let owner = match move copied {
    Result<OwnedHeaders, ValueError>.Failure {error} => { return false }
    Result<OwnedHeaders, ValueError>.Success {value} => move value
  }
  nameBytes[usize.ZERO] = 90
  valueBytes[usize.ZERO] = 110
  let view = OwnedHeaders.view(&owner)
  return inspectOwned(&view)
}

effect fn headOwnership() -> bool ! OutOfMemoryError ? &mut Allocator {
  let mut methodBytes: [u8; 5] = [80,65,84,67,72]
  let mut targetBytes: [u8; 6] = [47,111,119,110,101,100]
  let mut hostBytes: [u8; 12] = [104,111,115,116,46,101,120,97,109,112,108,101]
  let methodText = unsafe String.fromUtf8Unchecked(&methodBytes)
  let targetText = unsafe String.fromUtf8Unchecked(&targetBytes)
  let request = run copiedRequestHead(methodText, targetText, &hostBytes)
  let requestOwner = match move request {
    Result<OwnedRequestHead, ValueError>.Failure {error} => { return false }
    Result<OwnedRequestHead, ValueError>.Success {value} => move value
  }
  methodBytes[usize.ZERO] = 88
  targetBytes[usize.ZERO] = 88
  hostBytes[usize.ZERO] = 88
  if !inspectOwnedRequest(&requestOwner) { return false }

  let mut reason: [u8; 5] = [119,104,121,9,128]
  let mut field: [u8; 5] = [102,105,101,108,100]
  let response = run copiedResponseHead(&reason, &field)
  let responseOwner = match move response {
    Result<OwnedResponseHead, ValueError>.Failure {error} => { return false }
    Result<OwnedResponseHead, ValueError>.Success {value} => move value
  }
  reason[usize.ZERO] = 88
  field[usize.ZERO] = 88
  return inspectOwnedResponse(&responseOwner)
}

fn inspectOwned<'value>(headers: &Headers<'value>) -> bool {
  return match move Headers.getFirst(headers, "x-owned") {
    Option<Header<'value>>.None => false
    Option<Header<'value>>.Some {value} => equal(Header.value(&value), b"yes")
  }
}

effect fn runCases<'value>(allocationHeaders: &Headers<'value>) -> i32
! OutOfMemoryError ? &mut Allocator {
  if !scalars() { return 1 }
  if !scalarErrors() { return 2 }
  if !headerValidation() { return 3 }
  if !headerErrors() { return 4 }
  if !zeroCollectionBounds() { return 5 }
  if !headerCases(
    "Set-Cookie",
    b"a=1",
    "set-cookie",
    b"b=2",
    "X-Bytes",
    b"a\\tb\\xFF",
    "Empty",
    b"",
    b"x\\r\\ny",
  ) { return 6 }
  let transfer: [u8; 28] = [103,122,105,112,59,110,111,116,101,61,34,97,92,34,98,92,92,99,34,44,32,99,104,117,110,107,101,100]
  let transferRaw: [u8; 19] = [103,122,105,112,59,110,111,116,101,61,34,97,92,34,98,92,92,99,34]
  if !metadataCases(
    b"keep-alive, X-Hop",
    b"GZip,custom",
    &transfer,
    &transferRaw,
    b"close;bad=yes",
    b"gzip;level",
  ) { return 7 }
  if !targets() { return 8 }
  if !headCases(
    b"host.example",
    b"other.example",
    b"bad@host",
    b"\\xFF",
    b"ok\\t\\x80",
    b"",
    b"bad\\rreason",
    b"four",
  ) { return 9 }
  if !(run ownership()) { return 10 }
  if !(run headOwnership()) { return 11 }
  if !(run ownedBudgetCase("X-Budget", b"exact")) { return 12 }
  if !(run exactHeadLimits()) { return 13 }
  if !(run zeroOwnedBounds()) { return 14 }
  if !(run allocationBoundaries(allocationHeaders)) { return 15 }
  return 0
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 90 }

fn runWithAllocationHeaders<'value>(
  first: Header<'value>,
  second: Header<'value>,
) -> i32 {
  let configured = limits(4096)
  let entries: [Header<'value>; 2] = [first, second]
  return runWithMadeAllocationHeaders(Headers.make(&entries, configured))
}

fn runWithMadeAllocationHeaders<'value>(
  made: Result<Headers<'value>, ValueError>,
) -> i32 {
  let allocationHeaders = match move made {
    Result<Headers<'value>, ValueError>.Failure {error} => { return 92 }
    Result<Headers<'value>, ValueError>.Success {value} => value
  }
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut program = runCases(&allocationHeaders) |> Effect.provideMut<Allocator>(&mut allocator)
  return run Effect.catchAll(program, recover)
}

pub fn main() -> i32 {
  let configured = limits(4096)
  let first = match move Header.make("X-A", b"one", configured) {
    Result<Header<'static>, ValueError>.Failure {error} => { return 91 }
    Result<Header<'static>, ValueError>.Success {value} => value
  }
  let second = match move Header.make("X-B", b"two", configured) {
    Result<Header<'static>, ValueError>.Failure {error} => { return 91 }
    Result<Header<'static>, ValueError>.Success {value} => value
  }
  return runWithAllocationHeaders(first, second)
}
`
