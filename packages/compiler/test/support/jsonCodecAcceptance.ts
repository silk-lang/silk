/** One native program checks typed JSON conversion and fluent builder lowering. */
export const jsonCodecAcceptanceSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.json_array { JsonArray }
import silk.json_object { JsonObject }
import silk.json_output { JsonOptions }
import silk.json_scanner { JsonError, JsonReason, JsonScanner, JsonSpan, JsonToken }
import silk.json_codec { Deserialize, JsonCodec, Serialize }
import silk.json_text { JsonText }
import silk.json_value { Json, Value }
import silk.option { Option }
import silk.result { Result }
import silk.slice { Slice }
import silk.string { String }
import silk.usize
import silk.vector { Vector }
import silk.writer { Writer, WriterError }

struct Sink { output: Bytes count: usize }
effect fn writeAll(self: &mut Sink, values: &[u8]) -> () ! WriterError {
  let mut output = Bytes.asMutSlice(&mut self.output)
  if values.length > output.length - self.count { fail Writer.failure() }
  let mut index = usize.ZERO
  while index < values.length {
    output[self.count + index] = values[index]
    index = index + usize.ONE
  }
  self.count = self.count + values.length
  return ()
}
effect fn flush(self: &mut Sink) -> () ! WriterError { return () }
impl Writer for Sink { writeAll: Sink.writeAll flush: Sink.flush }

fn equals(sink: &Sink, expected: &[u8]) -> bool {
  if !(sink.count == expected.length) { return false }
  let actual = Bytes.asSlice(&sink.output)
  let mut index = usize.ZERO
  while index < expected.length {
    if !(actual[index] == expected[index]) { return false }
    index = index + usize.ONE
  }
  return true
}

struct Point { x: i32 y: i32 }
struct Segment { start: Point end: Point }

struct Key { text: String offset: usize }

effect fn token(scanner: &mut JsonScanner) -> JsonToken ! JsonError {
  return match move JsonScanner.next(&mut scanner.*) {
    Result<JsonToken, JsonError>.Success { value } => move value
    Result<JsonToken, JsonError>.Failure { error } => { fail move error }
  }
}

effect fn peek(scanner: &mut JsonScanner) -> JsonToken ! JsonError {
  return match move JsonScanner.peek(&mut scanner.*) {
    Result<JsonToken, JsonError>.Success { value } => move value
    Result<JsonToken, JsonError>.Failure { error } => { fail move error }
  }
}

effect fn decodedKey(scanner: &mut JsonScanner, span: JsonSpan, escaped: bool)
  -> Key ! JsonError | OutOfMemoryError ? &mut Allocator {
  let offset = span.offset
  let raw = JsonScanner.slice(&scanner.*, move span)
  let decoded = run JsonText.decode(raw, offset, escaped)
  return Key { text: unsafe String.fromBytesUnchecked(move decoded), offset: offset }
}

effect fn key(scanner: &mut JsonScanner)
  -> Key ! JsonError | OutOfMemoryError ? &mut Allocator {
  let next = run token(&mut scanner.*)
  let member = match move next {
    JsonToken.String { span, escaped } => run decodedKey(&mut scanner.*, move span, escaped)
    _ => { fail JsonError.at(JsonReason.TypeMismatch, JsonScanner.offset(&scanner.*)) }
  }
  let colon = run token(&mut scanner.*)
  match move colon {
    JsonToken.KeySeparator => { return move member }
    _ => { fail JsonError.at(JsonReason.UnexpectedByte, JsonScanner.offset(&scanner.*)) }
  }
}

effect fn finishPoint(x: Option<i32>, y: Option<i32>, offset: usize) -> Point ! JsonError {
  let left = match move x {
    Option<i32>.Some { value } => value
    Option<i32>.None => { fail JsonError.at(JsonReason.MissingField, offset) }
  }
  let right = match move y {
    Option<i32>.Some { value } => value
    Option<i32>.None => { fail JsonError.at(JsonReason.MissingField, offset) }
  }
  return Point { x: left, y: right }
}

impl Serialize for Point {
  effect fn serialize(self: &Self, options: &JsonOptions)
    -> () ! JsonError | WriterError ? &mut Writer {
    return run JsonObject.begin(options)
      |> JsonObject.field("x", &self.x)
      |> JsonObject.field("y", &self.y)
      |> JsonObject.end
  }
}

impl Deserialize for Point {
  effect fn deserialize(scanner: &mut JsonScanner)
    -> Self ! JsonError | OutOfMemoryError ? &mut Allocator {
    let opening = run token(&mut scanner.*)
    match move opening {
      JsonToken.ObjectBegin => {}
      _ => { fail JsonError.at(JsonReason.TypeMismatch, JsonScanner.offset(&scanner.*)) }
    }
    let mut x = Option<i32>.none()
    let mut y = Option<i32>.none()
    let first = run peek(&mut scanner.*)
    match move first {
      JsonToken.ObjectEnd => {
        let closing = run token(&mut scanner.*)
        return run finishPoint(move x, move y, JsonScanner.offset(&scanner.*))
      }
      _ => {}
    }
    while true {
      let member = run key(&mut scanner.*)
      if String.view(&member.text) == "x" {
        match &x {
          Option<i32>.Some { value: _ } => { fail JsonError.at(JsonReason.DuplicateKey, member.offset) }
          Option<i32>.None => {}
        }
        x = Option<i32>.some(run JsonCodec.deserializeOne<i32>(&mut scanner.*))
      } else if String.view(&member.text) == "y" {
        match &y {
          Option<i32>.Some { value: _ } => { fail JsonError.at(JsonReason.DuplicateKey, member.offset) }
          Option<i32>.None => {}
        }
        y = Option<i32>.some(run JsonCodec.deserializeOne<i32>(&mut scanner.*))
      } else {
        fail JsonError.at(JsonReason.UnknownField, member.offset)
      }
      let separator = run token(&mut scanner.*)
      match move separator {
        JsonToken.ObjectEnd => {
          return run finishPoint(move x, move y, JsonScanner.offset(&scanner.*))
        }
        JsonToken.ValueSeparator => {}
        _ => { fail JsonError.at(JsonReason.UnexpectedByte, JsonScanner.offset(&scanner.*)) }
      }
    }
    fail JsonError.at(JsonReason.UnexpectedEnd, JsonScanner.offset(&scanner.*))
  }
}

effect fn finishSegment(start: Option<Point>, end: Option<Point>, offset: usize)
  -> Segment ! JsonError {
  let first = match move start {
    Option<Point>.Some { value } => move value
    Option<Point>.None => { fail JsonError.at(JsonReason.MissingField, offset) }
  }
  let last = match move end {
    Option<Point>.Some { value } => move value
    Option<Point>.None => { fail JsonError.at(JsonReason.MissingField, offset) }
  }
  return Segment { start: move first, end: move last }
}

impl Serialize for Segment {
  effect fn serialize(self: &Self, options: &JsonOptions)
    -> () ! JsonError | WriterError ? &mut Writer {
    return run JsonObject.begin(options)
      |> JsonObject.field("start", &self.start)
      |> JsonObject.field("end", &self.end)
      |> JsonObject.end
  }
}

impl Deserialize for Segment {
  effect fn deserialize(scanner: &mut JsonScanner)
    -> Self ! JsonError | OutOfMemoryError ? &mut Allocator {
    let opening = run token(&mut scanner.*)
    match move opening {
      JsonToken.ObjectBegin => {}
      _ => { fail JsonError.at(JsonReason.TypeMismatch, JsonScanner.offset(&scanner.*)) }
    }
    let mut start = Option<Point>.none()
    let mut end = Option<Point>.none()
    let first = run peek(&mut scanner.*)
    match move first {
      JsonToken.ObjectEnd => {
        let closing = run token(&mut scanner.*)
        return run finishSegment(move start, move end, JsonScanner.offset(&scanner.*))
      }
      _ => {}
    }
    while true {
      let member = run key(&mut scanner.*)
      if String.view(&member.text) == "start" {
        match &start {
          Option<Point>.Some { value: _ } => { fail JsonError.at(JsonReason.DuplicateKey, member.offset) }
          Option<Point>.None => {}
        }
        start = Option<Point>.some(run JsonCodec.deserializeOne<Point>(&mut scanner.*))
      } else if String.view(&member.text) == "end" {
        match &end {
          Option<Point>.Some { value: _ } => { fail JsonError.at(JsonReason.DuplicateKey, member.offset) }
          Option<Point>.None => {}
        }
        end = Option<Point>.some(run JsonCodec.deserializeOne<Point>(&mut scanner.*))
      } else {
        fail JsonError.at(JsonReason.UnknownField, member.offset)
      }
      let separator = run token(&mut scanner.*)
      match move separator {
        JsonToken.ObjectEnd => {
          return run finishSegment(move start, move end, JsonScanner.offset(&scanner.*))
        }
        JsonToken.ValueSeparator => {}
        _ => { fail JsonError.at(JsonReason.UnexpectedByte, JsonScanner.offset(&scanner.*)) }
      }
    }
    fail JsonError.at(JsonReason.UnexpectedEnd, JsonScanner.offset(&scanner.*))
  }
}

effect fn rejectsPoint(bytes: &[u8], expected: JsonReason, offset: usize)
  -> bool ! OutOfMemoryError ? &mut Allocator {
  let attempted = run Effect.result(Json.deserialize<Point>(bytes))
  return match move attempted {
    Result<Point, JsonError | OutOfMemoryError>.Success { value: _ } => false
    Result<Point, JsonError | OutOfMemoryError>.Failure { error } => match move error {
      JsonError problem => {
        let exactOffset = match move problem.offset {
          Option<usize>.Some { value } => value == offset
          Option<usize>.None => false
        }
        return problem.reason == expected && exactOffset
      }
      OutOfMemoryError other => false
    }
  }
}

effect fn writeArray(values: &[i32], options: &JsonOptions)
  -> () ! JsonError | WriterError ? &mut Writer {
  return run JsonArray.begin(options)
    |> JsonArray.items(values)
    |> JsonArray.end
}

effect fn writeMaybe(value: &i32, optional: &Option<i32>, options: &JsonOptions)
  -> () ! JsonError | WriterError ? &mut Writer {
  return run JsonObject.begin(options)
    |> JsonObject.field("x", value)
    |> JsonObject.fieldIfSome("maybe", optional)
    |> JsonObject.end
}

effect fn check() -> i32 ! JsonError | OutOfMemoryError | WriterError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let options = JsonOptions.compact()
  let point = Point { x: 3, y: 4 }
  let restored = run Json.deserialize<Point>(b"{\\"x\\":3,\\"y\\":4}")
    |> Effect.provideMut<Allocator>(&mut allocator)
  if !(restored.x == 3 && restored.y == 4) { return 5 }
  if !(run rejectsPoint(b"{\\"x\\":1,\\"\\\\u0078\\":2,\\"y\\":3}", JsonReason.DuplicateKey, 7)
    |> Effect.provideMut<Allocator>(&mut allocator)) { return 11 }
  if !(run rejectsPoint(b"{\\"x\\":1}", JsonReason.MissingField, 6)
    |> Effect.provideMut<Allocator>(&mut allocator)) { return 12 }
  if !(run rejectsPoint(b"{\\"z\\":1,\\"x\\":3,\\"y\\":4}", JsonReason.UnknownField, 1)
    |> Effect.provideMut<Allocator>(&mut allocator)) { return 13 }
  if !(run rejectsPoint(b"{\\"x\\":true,\\"y\\":4}", JsonReason.TypeMismatch, 5)
    |> Effect.provideMut<Allocator>(&mut allocator)) { return 14 }
  let mut storage = Bytes.make()
  run Bytes.append(&mut storage, b"................................................................................................")
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut sink = Sink { output: move storage, count: usize.ZERO }
  run Json.serialize<Point>(&point, &options) |> Effect.provideMut<Writer>(&mut sink)
  if !equals(&sink, b"{\\"x\\":3,\\"y\\":4}") { return 6 }
  let stored = Bytes.asSlice(&sink.output)
  let encoded = Slice.view<u8>(stored, usize.ZERO, sink.count)
  let roundTrip = run Json.deserialize<Point>(encoded)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if !(roundTrip.x == point.x && roundTrip.y == point.y) { return 10 }
  drop encoded
  drop stored
  sink.count = usize.ZERO
  let segment = Segment {
    start: Point { x: -2, y: 7 },
    end: Point { x: 11, y: 19 }
  }
  run Json.serialize<Segment>(&segment, &options) |> Effect.provideMut<Writer>(&mut sink)
  if !equals(&sink, b"{\\"start\\":{\\"x\\":-2,\\"y\\":7},\\"end\\":{\\"x\\":11,\\"y\\":19}}") { return 19 }
  let segmentBytes = Bytes.asSlice(&sink.output)
  let serializedSegment = Slice.view<u8>(segmentBytes, usize.ZERO, sink.count)
  let decodedSegment = run Json.deserialize<Segment>(serializedSegment)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if !(decodedSegment.start.x == segment.start.x && decodedSegment.start.y == segment.start.y &&
    decodedSegment.end.x == segment.end.x && decodedSegment.end.y == segment.end.y) { return 20 }
  drop serializedSegment
  drop segmentBytes
  sink.count = usize.ZERO
  let value: i32 = 1
  let values = [value]
  run writeArray(&values, &options) |> Effect.provideMut<Writer>(&mut sink)
  if !equals(&sink, b"[1]") { return 7 }
  sink.count = usize.ZERO
  let absent = Option<i32>.none()
  run writeMaybe(&point.x, &absent, &options) |> Effect.provideMut<Writer>(&mut sink)
  if !equals(&sink, b"{\\"x\\":3}") { return 8 }
  sink.count = usize.ZERO
  let included = Option<i32>.some(4)
  run writeMaybe(&point.x, &included, &options) |> Effect.provideMut<Writer>(&mut sink)
  if !equals(&sink, b"{\\"x\\":3,\\"maybe\\":4}") { return 9 }
  sink.count = usize.ZERO
  let text = run Json.deserialize<String>(b"\\"a\\\\u0062\\"")
    |> Effect.provideMut<Allocator>(&mut allocator)
  if !(String.view(&text) == "ab") { return 1 }
  let numbers = run Json.deserialize<Vector<i32>>(b"[1,2]")
    |> Effect.provideMut<Allocator>(&mut allocator)
  if !(Vector<i32>.length(&numbers) == 2) { return 2 }
  run Json.serialize<Vector<i32>>(&numbers, &options) |> Effect.provideMut<Writer>(&mut sink)
  let tree = run Json.deserialize<Value>(b"{\\"a\\":1}")
    |> Effect.provideMut<Allocator>(&mut allocator)
  run Json.serialize<Value>(&tree, &options) |> Effect.provideMut<Writer>(&mut sink)
  let overflow = Json.decode<f64>(b"1e999")
  match move overflow {
    Result<f64, JsonError>.Success { value: _ } => { return 15 }
    Result<f64, JsonError>.Failure { error } => {
      if !(error.reason == JsonReason.NumberOutOfRange) { return 16 }
    }
  }
  let trailing = Json.decode<i32>(b"1 2")
  match move trailing {
    Result<i32, JsonError>.Success { value: _ } => { return 17 }
    Result<i32, JsonError>.Failure { error } => {
      if !(error.reason == JsonReason.TrailingContent) { return 18 }
    }
  }
  let optional = Json.decode<Option<i32>>(b"null")
  return match move optional {
    Result<Option<i32>, JsonError>.Failure { error: _ } => 3
    Result<Option<i32>, JsonError>.Success { value: decoded } => match move decoded {
      Option<i32>.None => 0
      Option<i32>.Some { value: present } => 4
    }
  }
}

effect fn recover(error: JsonError | OutOfMemoryError | WriterError) -> i32 { return 90 }
pub fn main() -> i32 { return run Effect.catchAll(check(), recover) }
`
