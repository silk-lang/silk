export const tomlOutputAcceptanceSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.box { Box }
import silk.effect { Effect }
import silk.option { Option }
import silk.result { Result }
import silk.slice { Slice }
import silk.string { String }
import silk.toml_output { TomlOutput }
import silk.toml_codec { TomlCodec }
import silk.toml_scanner { TomlError, TomlReason }
import silk.toml_value { Toml, TomlChild, TomlEntry, TableKind, Value }
import silk.u8
import silk.usize
import silk.vector { Vector }
import silk.writer { Writer, WriterError }

struct Capture { bytes: [u8; 1024] count: usize limit: usize }
effect fn writeAll(self: &mut Capture, values: &[u8]) -> () ! WriterError {
  if self.count + values.length > self.limit { fail Writer.failure() }
  let mut at = usize.ZERO
  while at < values.length {
    self.bytes[self.count] = values[at]
    self.count = self.count + usize.ONE
    at = at + usize.ONE
  }
}
effect fn flush(self: &mut Capture) -> () ! WriterError { return () }
impl Writer for Capture { writeAll: Capture.writeAll flush: Capture.flush }
fn capture() -> Capture { return Capture { bytes: [${Array(1024).fill(0).join(', ')}], count: usize.ZERO, limit: 1024 } }

fn equal(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut at = usize.ZERO
  while at < left.length {
    if left[at] != right[at] { return false }
    at = at + usize.ONE
  }
  return true
}

fn textIs(value: Option<&Value>, kind: i32, expected: string) -> bool {
  return match move value {
    Option<&Value>.None => false
    Option<&Value>.Some { value: item } => match &item.* {
      Value.String { text } => kind == 1 && String.view(&text) == expected
      Value.Integer { text } => kind == 2 && String.view(&text) == expected
      Value.Float { text } => kind == 3 && String.view(&text) == expected
      Value.LocalTime { text } => kind == 4 && String.view(&text) == expected
      Value.OffsetDateTime { text } => kind == 5 && String.view(&text) == expected
      _ => false
    }
  }
}

fn matchesTree(document: &Value) -> bool {
  if !textIs(Toml.field(document, "quoted.key"), 1, "value") { return false }
  if !textIs(Toml.field(document, "number"), 2, "1_024") { return false }
  if !textIs(Toml.field(document, "float"), 3, "2_5.0") { return false }
  if !textIs(Toml.field(document, "time"), 4, "07:32") { return false }
  if !textIs(Toml.field(document, "offset"), 5, "1979-05-27T07:32Z") { return false }
  if !textIs(Toml.fieldAt(Toml.field(document, "owner"), "name"), 1, "Ada") { return false }
  if !textIs(Toml.fieldAt(Toml.field(document, "inline"), "leaf"), 1, "yes") { return false }
  let items = Toml.field(document, "items")
  return match move items {
    Option<&Value>.None => false
    Option<&Value>.Some { value: array } => {
      let first = Toml.item(array, usize.ZERO)
      let second = Toml.item(array, usize.ONE)
      return match move first {
        Option<&Value>.None => false
        Option<&Value>.Some { value: one } => match move second {
          Option<&Value>.None => false
          Option<&Value>.Some { value: two } => {
            return textIs(Toml.field(one, "label"), 1, "first") &&
              textIs(Toml.field(two, "label"), 1, "second")
          }
        }
      }
    }
  }
}

effect fn preservesTree(input: &[u8]) -> bool ! TomlError | OutOfMemoryError | WriterError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let first = run Toml.parse(input) |> Effect.provideMut<Allocator>(&mut allocator)
  if !matchesTree(&first) { return false }
  let mut output = capture()
  run TomlOutput.write(&first)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.provideMut<Writer>(&mut output)
  let bytes = Slice.view<u8>(&output.bytes, usize.ZERO, output.count)
  let second = run Toml.parse(bytes) |> Effect.provideMut<Allocator>(&mut allocator)
  return matchesTree(&second)
}

effect fn roundTrip(input: &[u8]) -> bool ! TomlError | OutOfMemoryError | WriterError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let first = run Toml.parse(input) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut output = capture()
  run TomlOutput.write(&first)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.provideMut<Writer>(&mut output)
  let bytes = Slice.view<u8>(&output.bytes, usize.ZERO, output.count)
  let second = run Toml.parse(bytes) |> Effect.provideMut<Allocator>(&mut allocator)
  let mut again = capture()
  run TomlOutput.write(&second)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.provideMut<Writer>(&mut again)
  return equal(bytes, Slice.view<u8>(&again.bytes, usize.ZERO, again.count))
}

effect fn check() -> i32 ! TomlError | OutOfMemoryError | WriterError {
  if !run preservesTree(b"\\"quoted.key\\" = \\"value\\"\\nnumber = 1_024\\nfloat = 2_5.0\\ntime = 07:32\\noffset = 1979-05-27T07:32Z\\ninline = {\\n leaf = \\"yes\\",\\n}\\n[owner]\\nname = \\"Ada\\"\\n[[items]]\\nlabel = \\"first\\"\\n[[items]]\\nlabel = \\"second\\"\\n") { return 23 }
  if !run roundTrip(b"[[servers]]\\nname = \\"one\\"\\n[servers.meta]\\nflag = true\\n[[servers]]\\nname = \\"two\\"\\n") { return 20 }
  if !run roundTrip(b"title = \\"quote \\\\\\" and \\\\\\\\\\\\\\"\\"\\n") { return 1 }
  if !run roundTrip(b"when = 1979-05-27T07:32Z\\nnumber = 1_000\\nvalues = [1, 2.5, true, { x = \\"y\\" }]\\n") { return 2 }
  if !run roundTrip(b"name = \\"top\\"\\n[owner]\\nname = \\"Ada\\"\\n[[items]]\\nlabel = \\"first\\"\\n[[items]]\\nlabel = \\"second\\"\\n") { return 3 }
  let mut allocator = Allocator.systemAllocatorProvider()
  let typed = run Toml.parse(b"count = 1_024\\nenabled = true\\nratio = 2_5.0\\n")
    |> Effect.provideMut<Allocator>(&mut allocator)
  let count = Toml.field(&typed, "count")
  match move count {
    Option<&Value>.Some { value } => match move TomlCodec.decodeOne<i64>(value) {
      Result<i64, TomlError>.Success { value: decoded } => { if decoded != 1024 { return 5 } }
      Result<i64, TomlError>.Failure { error } => { return 6 }
    }
    Option<&Value>.None => { return 7 }
  }
  let enabled = Toml.field(&typed, "enabled")
  match move enabled {
    Option<&Value>.Some { value } => match move TomlCodec.decodeOne<bool>(value) {
      Result<bool, TomlError>.Success { value: decoded } => { if !decoded { return 8 } }
      Result<bool, TomlError>.Failure { error } => { return 9 }
    }
    Option<&Value>.None => { return 10 }
  }
  let ratio = Toml.field(&typed, "ratio")
  match move ratio {
    Option<&Value>.Some { value } => {
      let decoded = run TomlCodec.deserializeOne<f64>(value)
        |> Effect.provideMut<Allocator>(&mut allocator)
      if decoded != 25.0 { return 11 }
    }
    Option<&Value>.None => { return 13 }
  }
  let mut encoded = capture()
  let amount: i64 = 73
  run TomlCodec.writeOne<i64>(&amount) |> Effect.provideMut<Writer>(&mut encoded)
  if !equal(Slice.view<u8>(&encoded.bytes, usize.ZERO, encoded.count), b"73") { return 14 }
  let names = run Toml.parse(b"label = \\"Ada\\"\\n")
    |> Effect.provideMut<Allocator>(&mut allocator)
  let name = Toml.field(&names, "label")
  match move name {
    Option<&Value>.Some { value } => {
      let owned = run TomlCodec.deserializeOne<String>(value)
        |> Effect.provideMut<Allocator>(&mut allocator)
      if String.view(&owned) != "Ada" { return 15 }
    }
    Option<&Value>.None => { return 16 }
  }
  let invalidText = run String.copy("oops") |> Effect.provideMut<Allocator>(&mut allocator)
  let invalidKey = run String.copy("bad") |> Effect.provideMut<Allocator>(&mut allocator)
  let mut entries = Vector<TomlChild>.make()
  run Vector<TomlChild>.append(&mut entries, TomlChild.Member {
    entry: TomlEntry { key: move invalidKey, value: Value.Integer { text: move invalidText } }
  }) |> Effect.provideMut<Allocator>(&mut allocator)
  let boxed = run Box<Vector<TomlChild>>.make(move entries)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let invalidValue = Value.Table { entries: move boxed, kind: TableKind.Explicit }
  let mut rejectedOutput = capture()
  let rejected = run Effect.result(TomlOutput.write(&invalidValue)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.provideMut<Writer>(&mut rejectedOutput))
  match move rejected {
    Result<(), TomlError | OutOfMemoryError | WriterError>.Success { value: _ } => { return 17 }
    Result<(), TomlError | OutOfMemoryError | WriterError>.Failure { error } => match move error {
      TomlError { reason, offset: _ } => match move reason {
        TomlReason.InvalidNumber => {}
        _ => { return 22 }
      }
      _ => { return 22 }
    }
  }
  if rejectedOutput.count != usize.ZERO { return 18 }
  let mut failing = capture()
  failing.limit = usize.ZERO
  let writerResult = run Effect.result(TomlCodec.writeOne<i64>(&amount)
    |> Effect.provideMut<Writer>(&mut failing))
  match move writerResult {
    Result<(), TomlError | WriterError>.Success { value: _ } => { return 19 }
    Result<(), TomlError | WriterError>.Failure { error: _ } => {}
  }
  let mut floatOutput = capture()
  let whole: f64 = 1.0
  run TomlCodec.writeOne<f64>(&whole) |> Effect.provideMut<Writer>(&mut floatOutput)
  if !equal(Slice.view<u8>(&floatOutput.bytes, usize.ZERO, floatOutput.count), b"1.0") { return 21 }
  return 42
}
effect fn recover(error: TomlError | OutOfMemoryError | WriterError) -> i32 { return 4 }
pub fn main() -> i32 { return run Effect.catchAll(check(), recover) }`
