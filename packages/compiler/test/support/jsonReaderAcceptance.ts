const documentBytes = [
  ...new TextEncoder().encode('{"a":[true,false,null,-12.3e+4,"\\uD834\\uDD1E","€"]}'),
]
const largeTokenBytes = [...new TextEncoder().encode('["abcdef"]')]

/** One native program checks one-byte fills, raw token views, capacity, and sticky end. */
export const jsonReaderAcceptanceSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.buffered_input { BufferedInput, BufferError }
import silk.byte_duplex { ByteDuplex }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.json_reader { JsonReader, JsonReadToken }
import silk.json_scanner { JsonError, JsonReason, JsonScanner, JsonToken }
import silk.memory_byte_duplex { MemoryByteDuplex, MemoryReadEvent, MemoryWriteEvent }
import silk.monotonic_clock { MonotonicClock }
import silk.option { Option }
import silk.result { Result }
import silk.system_clock { Instant, SystemClock }
import silk.u64
import silk.usize
import silk.vector { Vector }

struct FixedClock {}
impl MonotonicClock for FixedClock {
  effect fn now(self: &mut Self) -> Instant { return SystemClock.make(0, 0) }
  effect fn getResolution(self: &mut Self) -> u64 { return u64.toU64(1) }
  effect fn waitUntil(self: &mut Self, when: Instant) -> () { drop when return () }
  effect fn waitFor(self: &mut Self, howLong: u64) -> () { drop howLong return () }
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

fn sameToken(left: JsonToken, right: JsonToken, raw: &[u8], scanner: &JsonScanner) -> bool {
  return match move left {
    JsonToken.ObjectBegin => match move right {
      JsonToken.ObjectBegin => raw.length == usize.ZERO
      _ => false
    }
    JsonToken.ObjectEnd => match move right {
      JsonToken.ObjectEnd => raw.length == usize.ZERO
      _ => false
    }
    JsonToken.ArrayBegin => match move right {
      JsonToken.ArrayBegin => raw.length == usize.ZERO
      _ => false
    }
    JsonToken.ArrayEnd => match move right {
      JsonToken.ArrayEnd => raw.length == usize.ZERO
      _ => false
    }
    JsonToken.KeySeparator => match move right {
      JsonToken.KeySeparator => raw.length == usize.ZERO
      _ => false
    }
    JsonToken.ValueSeparator => match move right {
      JsonToken.ValueSeparator => raw.length == usize.ZERO
      _ => false
    }
    JsonToken.String { span, escaped } => match move right {
      JsonToken.String { span: expected, escaped: expectedEscaped } =>
        span.offset == expected.offset && span.length == expected.length
          && escaped == expectedEscaped && equal(raw, JsonScanner.slice(scanner, expected))
      _ => false
    }
    JsonToken.Number { span } => match move right {
      JsonToken.Number { span: expected } =>
        span.offset == expected.offset && span.length == expected.length
          && equal(raw, JsonScanner.slice(scanner, expected))
      _ => false
    }
    JsonToken.True => match move right {
      JsonToken.True => equal(raw, b"true")
      _ => false
    }
    JsonToken.False => match move right {
      JsonToken.False => equal(raw, b"false")
      _ => false
    }
    JsonToken.Null => match move right {
      JsonToken.Null => equal(raw, b"null")
      _ => false
    }
    JsonToken.EndOfInput => match move right {
      JsonToken.EndOfInput => raw.length == usize.ZERO
      _ => false
    }
  }
}

fn isEnd(token: &JsonToken) -> bool {
  return match &token.* {
    JsonToken.EndOfInput => true
    _ => false
  }
}

effect fn transport(bytes: &[u8]) -> MemoryByteDuplex
! OutOfMemoryError
? &mut Allocator {
  let copied = run Bytes.copy(bytes)
  let mut reads = Vector<MemoryReadEvent>.make()
  run Vector<MemoryReadEvent>.append(&mut reads, MemoryReadEvent.Data {
    readyAt: SystemClock.make(0, 0),
    bytes: move copied,
  })
  return run MemoryByteDuplex.make(
    move reads, Vector<MemoryWriteEvent>.make(), usize.ONE, bytes.length + usize.ONE, Option<i32>.none(),
  )
}

effect fn compare(bytes: &[u8]) -> bool
! OutOfMemoryError | BufferError | JsonError
? &mut Allocator {
  let mut source = run transport(bytes)
  let mut clock = FixedClock {}
  let mut input = run BufferedInput.make(usize.ONE)
  let mut reader = JsonReader.make()
  let mut scanner = JsonScanner.make(bytes)
  let mut scratch: [u8; 32] = [0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0]
  let mut count = usize.ZERO
  while true {
    let token = run JsonReader.next(
      &mut reader, &mut input, &mut scratch, Option<Instant>.none(),
    )
      |> Effect.provideMut<ByteDuplex>(&mut source)
      |> Effect.provideMut<MonotonicClock>(&mut clock)
    let expected = JsonScanner.next(&mut scanner)
    let expectedToken = match move expected {
      Result<JsonToken, JsonError>.Failure { error } => { drop error return false }
      Result<JsonToken, JsonError>.Success { value } => value
    }
    let end = isEnd(&token.token)
    let same = sameToken(move token.token, move expectedToken, token.raw, &scanner)
    drop token.raw
    if !same { return false }
    count = count + usize.ONE
    if end { break }
  }
  if count != 18 { return false }
  let again = run JsonReader.next(
    &mut reader, &mut input, &mut scratch, Option<Instant>.none(),
  )
    |> Effect.provideMut<ByteDuplex>(&mut source)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  return isEnd(&again.token) && again.raw.length == usize.ZERO
}

fn offsetIs(option: Option<usize>, expected: usize) -> bool {
  return match move option {
    Option<usize>.Some { value: present } => present == expected
    Option<usize>.None => false
  }
}

effect fn capacity() -> bool
! OutOfMemoryError | BufferError | JsonError
? &mut Allocator {
  let exactBytes: [u8; 5] = [102, 97, 108, 115, 101]
  let mut exactSource = run transport(&exactBytes)
  let mut exactInput = run BufferedInput.make(usize.ONE)
  let mut exactReader = JsonReader.make()
  let mut exactScratch: [u8; 5] = [0, 0, 0, 0, 0]
  let mut clock = FixedClock {}
  let exact = run JsonReader.next(
    &mut exactReader, &mut exactInput, &mut exactScratch, Option<Instant>.none(),
  )
    |> Effect.provideMut<ByteDuplex>(&mut exactSource)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  let exactFits = match move exact.token {
    JsonToken.False => equal(exact.raw, b"false")
    _ => false
  }
  drop exact.raw
  if !exactFits { return false }
  let bytes: [u8; ${largeTokenBytes.length}] = [${largeTokenBytes.join(', ')}]
  let mut source = run transport(&bytes)
  let mut input = run BufferedInput.make(usize.ONE)
  let mut reader = JsonReader.make()
  let mut scratch: [u8; 3] = [0, 0, 0]
  let first = run JsonReader.next(
    &mut reader, &mut input, &mut scratch, Option<Instant>.none(),
  )
    |> Effect.provideMut<ByteDuplex>(&mut source)
    |> Effect.provideMut<MonotonicClock>(&mut clock)
  if !isArrayBegin(&first.token) || first.raw.length != usize.ZERO { return false }
  drop first
  let attempted = run Effect.result(JsonReader.next(
    &mut reader, &mut input, &mut scratch, Option<Instant>.none(),
  )
    |> Effect.provideMut<ByteDuplex>(&mut source)
    |> Effect.provideMut<MonotonicClock>(&mut clock))
  let failed = match move attempted {
    Result.Success { value } => {
      drop value
      return false
    }
    Result.Failure { error } => match move error {
      JsonError { reason, offset, required: _, available } =>
        reason == JsonReason.TokenTooLarge
          && offsetIs(move offset, usize.ONE) && offsetIs(move available, 3)
      _ => false
    }
  }
  if !failed { return false }
  let terminal = run Effect.result(JsonReader.next(
    &mut reader, &mut input, &mut scratch, Option<Instant>.none(),
  )
    |> Effect.provideMut<ByteDuplex>(&mut source)
    |> Effect.provideMut<MonotonicClock>(&mut clock))
  return match move terminal {
    Result.Success { value } => {
      drop value
      return false
    }
    Result.Failure { error } => match move error {
      BufferError.Terminal => true
      _ => false
    }
  }
}

fn isArrayBegin(token: &JsonToken) -> bool {
  return match &token.* {
    JsonToken.ArrayBegin => true
    _ => false
  }
}

effect fn syntax() -> bool
! OutOfMemoryError | BufferError
? &mut Allocator {
  let bytes: [u8; 4] = [91, 49, 44, 93]
  let mut source = run transport(&bytes)
  let mut clock = FixedClock {}
  let mut input = run BufferedInput.make(usize.ONE)
  let mut reader = JsonReader.make()
  let mut scratch: [u8; 1] = [0]
  while true {
    let stepped = run Effect.result(JsonReader.next(
      &mut reader, &mut input, &mut scratch, Option<Instant>.none(),
    )
      |> Effect.provideMut<ByteDuplex>(&mut source)
      |> Effect.provideMut<MonotonicClock>(&mut clock))
    match move stepped {
      Result.Success { value } => {
        let end = isEnd(&value.token)
        drop value
        if end { return false }
      }
      Result.Failure { error } => {
        match move error {
          JsonError { reason, offset, required, available } => {
            drop required
            drop available
            return reason == JsonReason.UnexpectedByte && offsetIs(move offset, 3)
          }
          _ => { return false }
        }
      }
    }
  }
  return false
}

effect fn program() -> i32
! OutOfMemoryError | BufferError | JsonError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let document: [u8; ${documentBytes.length}] = [${documentBytes.join(', ')}]
  let same = run compare(&document) |> Effect.provideMut<Allocator>(&mut allocator)
  if !same { return 1 }
  let failed = run capacity() |> Effect.provideMut<Allocator>(&mut allocator)
  if !failed { return 2 }
  let rejected = run syntax() |> Effect.provideMut<Allocator>(&mut allocator)
  if !rejected { return 4 }
  return 0
}

effect fn failed(error: OutOfMemoryError | BufferError | JsonError) -> i32 {
  return match move error {
    JsonError { reason, offset, required, available } => {
      drop reason
      drop offset
      drop required
      drop available
      return 30
    }
    OutOfMemoryError {} => 32
    BufferError.ReadFailed { progress, error: cause } => {
      drop progress
      drop cause
      return 40
    }
    BufferError.InvalidReadCount { count, limit } => {
      drop count
      drop limit
      return 41
    }
    BufferError.InvalidConsumption { requested, available } => {
      drop requested
      drop available
      return 42
    }
    BufferError.BufferTooSmall { requested, capacity } => {
      drop requested
      drop capacity
      return 43
    }
    BufferError.Terminal => 44
    _ => 31
  }
}

pub fn main() -> i32 { return run Effect.catchAll(program(), failed) }
`
