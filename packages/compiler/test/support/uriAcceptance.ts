// Independently pinned strict examples from RFC 3986 §5.4, in specification order.
// One program shares a parsed base and exercises each vector without recompilation.
const resolutionVectors: ReadonlyArray<readonly [string, string]> = [
  ['g:h', 'g:h'],
  ['g', 'http://a/b/c/g'],
  ['./g', 'http://a/b/c/g'],
  ['g/', 'http://a/b/c/g/'],
  ['/g', 'http://a/g'],
  ['//g', 'http://g'],
  ['?y', 'http://a/b/c/d;p?y'],
  ['g?y', 'http://a/b/c/g?y'],
  ['#s', 'http://a/b/c/d;p?q#s'],
  ['g#s', 'http://a/b/c/g#s'],
  ['g?y#s', 'http://a/b/c/g?y#s'],
  [';x', 'http://a/b/c/;x'],
  ['g;x', 'http://a/b/c/g;x'],
  ['g;x?y#s', 'http://a/b/c/g;x?y#s'],
  ['', 'http://a/b/c/d;p?q'],
  ['.', 'http://a/b/c/'],
  ['./', 'http://a/b/c/'],
  ['..', 'http://a/b/'],
  ['../', 'http://a/b/'],
  ['../g', 'http://a/b/g'],
  ['../..', 'http://a/'],
  ['../../', 'http://a/'],
  ['../../g', 'http://a/g'],
  ['../../../g', 'http://a/g'],
  ['../../../../g', 'http://a/g'],
  ['/./g', 'http://a/g'],
  ['/../g', 'http://a/g'],
  ['g.', 'http://a/b/c/g.'],
  ['.g', 'http://a/b/c/.g'],
  ['g..', 'http://a/b/c/g..'],
  ['..g', 'http://a/b/c/..g'],
  ['./../g', 'http://a/b/g'],
  ['./g/.', 'http://a/b/c/g/'],
  ['g/./h', 'http://a/b/c/g/h'],
  ['g/../h', 'http://a/b/c/h'],
  ['g;x=1/./y', 'http://a/b/c/g;x=1/y'],
  ['g;x=1/../y', 'http://a/b/c/y'],
  ['g?y/./x', 'http://a/b/c/g?y/./x'],
  ['g?y/../x', 'http://a/b/c/g?y/../x'],
  ['g#s/./x', 'http://a/b/c/g#s/./x'],
  ['g#s/../x', 'http://a/b/c/g#s/../x'],
  ['http:g', 'http:g'],
  // Encoded dots remain data; empty delimiters replace inherited components.
  ['%2e/%2E%2e/g?y/../x', 'http://a/b/c/%2e/%2E%2e/g?y/../x'],
  ['?#', 'http://a/b/c/d;p?#'],
]

export const uriAcceptanceSource = `import silk.uri { Uri, OwnedUri }
import silk.uri_reference { UriReference, OwnedUriReference, ParseError, ParseReason, Component, HostKind }
import silk.uri_percent { UriPercent, DecodeError, Decoded }
import silk.uri_percent { PercentComponent }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.writer { Writer, WriterError }
import silk.result { Result }
import silk.option { Option }
import silk.string { String, InvalidUtf8 }
import silk.bytes { Bytes }
import silk.slice { Slice }
import silk.uri_components { UriComponents, ComponentValue, Authority, Host, Serialization }
import silk.usize

fn present(actual: Option<string>, expected: string) -> bool {
  return match move actual {
    Option<string>.Some { value } => value == expected
    Option<string>.None => false
  }
}

fn absent(actual: Option<string>) -> bool {
  return match move actual {
    Option<string>.Some { value } => false
    Option<string>.None => true
  }
}

fn ownedMatches(value: OwnedUri, expected: string) -> bool {
  let view = OwnedUri.view(&value)
  return Uri.format(&view) == expected
}

effect fn resolves<'base, 'text>(base: &Uri<'base>, text: string<'text>, expected: string) -> bool
! OutOfMemoryError ? &mut Allocator {
  let parsed = UriReference.parse(text)
  return match move parsed {
    Result<UriReference<'text>, ParseError>.Failure { error } => false
    Result<UriReference<'text>, ParseError>.Success { value } => {
      let resolved = run Uri.resolveOwned(base, &value)
      return match move resolved {
        Result<OwnedUri, ParseError>.Failure { error } => false
        Result<OwnedUri, ParseError>.Success { value: target } => ownedMatches(move target, expected)
      }
    }
  }
}

effect fn vectors<'base>(base: &Uri<'base>) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let references: [string<'static>; ${resolutionVectors.length}] = [${resolutionVectors.map(([reference]) => JSON.stringify(reference)).join(', ')}]
  let expected: [string<'static>; ${resolutionVectors.length}] = [${resolutionVectors.map(([, expected]) => JSON.stringify(expected)).join(', ')}]
  let mut index: usize = 0
  while index < ${resolutionVectors.length} {
    if !(run resolves(base, references[index], expected[index])) { return usize.toI32(index) + 1 }
    index = index + 1
  }
  return 0
}

effect fn copiedInput() -> Result<OwnedUriReference, ParseError>
! OutOfMemoryError ? &mut Allocator {
  let input = run String.copy("x:/owned?query")
  return run UriReference.parseOwned(String.view(&input))
}

effect fn ownedInput() -> bool ! OutOfMemoryError ? &mut Allocator {
  let parsed = run copiedInput()
  return match move parsed {
    Result<OwnedUriReference, ParseError>.Failure { error } => false
    Result<OwnedUriReference, ParseError>.Success { value } => {
      let view = OwnedUriReference.view(&value)
      return UriReference.format(&view) == "x:/owned?query"
    }
  }
}

effect fn emptyBasePath() -> bool ! OutOfMemoryError ? &mut Allocator {
  let parsed = Uri.parse("x://host?old#discard")
  return match move parsed {
    Result<Uri<'static>, ParseError>.Failure { error } => false
    Result<Uri<'static>, ParseError>.Success { value } => {
      if Uri.scheme(&value) != "x" || Uri.path(&value) != "" { return false }
      if !present(Uri.authority(&value), "host") || !present(Uri.host(&value), "host") { return false }
      if !present(Uri.query(&value), "old") || !present(Uri.fragment(&value), "discard") { return false }
      if !absent(Uri.userinfo(&value)) || !absent(Uri.port(&value)) { return false }
      return run resolves(&value, "g", "x://host/g")
    }
  }
}

// Literal RFC recomposition can expose an authority after dot removal. Revalidation owns
// the resulting component interpretation and reports offsets in the recomposed serialization.
effect fn recomposedAuthority<'base>(base: &Uri<'base>) -> bool ! OutOfMemoryError ? &mut Allocator {
  let parsed = UriReference.parse("/a/..//g")
  return match move parsed {
    Result<UriReference<'static>, ParseError>.Failure { error } => false
    Result<UriReference<'static>, ParseError>.Success { value: reference } => {
      let resolved = run Uri.resolveOwned(base, &reference)
      return match move resolved {
        Result<OwnedUri, ParseError>.Failure { error } => false
        Result<OwnedUri, ParseError>.Success { value } => {
          let view = OwnedUri.view(&value)
          return Uri.format(&view) == "x://g" && present(Uri.authority(&view), "g")
        }
      }
    }
  }
}

effect fn recomposition() -> bool ! OutOfMemoryError ? &mut Allocator {
  let parsedBase = Uri.parse("x:a")
  return match move parsedBase {
    Result<Uri<'static>, ParseError>.Failure { error } => false
    Result<Uri<'static>, ParseError>.Success { value: base } => {
      if !(run recomposedAuthority(&base)) { return false }
      let invalid = UriReference.parse("/a/..//g:h")
      return match move invalid {
        Result<UriReference<'static>, ParseError>.Failure { error } => false
        Result<UriReference<'static>, ParseError>.Success { value: reference } => {
          let resolved = run Uri.resolveOwned(&base, &reference)
          return match move resolved {
            Result<OwnedUri, ParseError>.Success { value } => false
            Result<OwnedUri, ParseError>.Failure { error } => error.reason == ParseReason.InvalidPort && error.component == Component.Port && error.offset == 6
          }
        }
      }
    }
  }
}

fn emptyComponents() -> bool {
  let parsed = UriReference.parse("x://@:/%2e?")
  return match move parsed {
    Result<UriReference<'static>, ParseError>.Failure { error } => false
    Result<UriReference<'static>, ParseError>.Success { value } => {
      return UriReference.format(&value) == "x://@:/%2e?"
        && present(UriReference.scheme(&value), "x")
        && present(UriReference.authority(&value), "@:")
        && present(UriReference.userinfo(&value), "")
        && present(UriReference.host(&value), "")
        && present(UriReference.port(&value), "")
        && UriReference.path(&value) == "/%2e"
        && present(UriReference.query(&value), "")
        && absent(UriReference.fragment(&value))
    }
  }
}

fn roundtrip<'text>(text: string<'text>) -> bool {
  let parsed = UriReference.parse(text)
  return match move parsed {
    Result<UriReference<'text>, ParseError>.Failure { error } => false
    Result<UriReference<'text>, ParseError>.Success { value } => UriReference.format(&value) == text
  }
}

fn hostKind<'text>(text: string<'text>, expected: HostKind) -> bool {
  let parsed = UriReference.parse(text)
  return match move parsed {
    Result<UriReference<'text>, ParseError>.Failure { error } => false
    Result<UriReference<'text>, ParseError>.Success { value } => {
      if UriReference.format(&value) != text { return false }
      return match move UriReference.hostKind(&value) {
        Option<HostKind>.None => false
        Option<HostKind>.Some { value: actual } => actual == expected
      }
    }
  }
}

fn badReference<'text>(text: string<'text>, reason: ParseReason, component: Component, offset: usize) -> bool {
  let parsed = UriReference.parse(text)
  return match move parsed {
    Result<UriReference<'text>, ParseError>.Success { value } => false
    Result<UriReference<'text>, ParseError>.Failure { error } => error.reason == reason && error.component == component && error.offset == offset
  }
}

fn missingScheme() -> bool {
  let parsed = Uri.parse("relative/path")
  return match move parsed {
    Result<Uri<'static>, ParseError>.Success { value } => false
    Result<Uri<'static>, ParseError>.Failure { error } => error.reason == ParseReason.MissingScheme && error.component == Component.Scheme && error.offset == 0
  }
}

effect fn encoded(raw: &[u8], component: PercentComponent, expected: string) -> bool
! OutOfMemoryError ? &mut Allocator {
  let text = run UriPercent.encodeOwned(raw, move component)
  return String.view(&text) == expected
}

effect fn percentBytes() -> bool ! OutOfMemoryError ? &mut Allocator {
  let decoded = run UriPercent.decodeOwned("%FF+%00")
  return match move decoded {
    Result<Bytes, DecodeError>.Failure { error } => false
    Result<Bytes, DecodeError>.Success { value } => decodedBytes(move value)
  }
}

fn decodedBytes(value: Bytes) -> bool {
  let bytes = Bytes.asSlice(&value)
  if bytes.length != 3 { return false }
  if bytes[0] != 255 || bytes[1] != 43 || bytes[2] != 0 { return false }
  return match move String.fromUtf8(bytes) {
    Result<string, InvalidUtf8>.Success { value: text } => false
    Result<string, InvalidUtf8>.Failure { error } => true
  }
}

effect fn badDecode(text: string, offset: usize) -> bool ! OutOfMemoryError ? &mut Allocator {
  let decoded = run UriPercent.decodeOwned(text)
  return match move decoded {
    Result<Bytes, DecodeError>.Success { value } => false
    Result<Bytes, DecodeError>.Failure { error } => error.offset == offset
  }
}

fn bytesText(value: &Bytes, expected: string) -> bool {
  return match move String.fromUtf8(Bytes.asSlice(value)) {
    Result<string, InvalidUtf8>.Failure { error } => false
    Result<string, InvalidUtf8>.Success { value: text } => text == expected
  }
}

fn decodedUnit(value: Result<(), DecodeError>) -> bool {
  return match move value {
    Result<(), DecodeError>.Success { value: _ } => true
    Result<(), DecodeError>.Failure { error } => false
  }
}

fn parsedUnit(value: Result<(), ParseError>) -> bool {
  return match move value {
    Result<(), ParseError>.Success { value: _ } => true
    Result<(), ParseError>.Failure { error } => false
  }
}

effect fn percentReuse() -> bool ! OutOfMemoryError {
  let mut audit = UriAllocationAudit { calls: 0, lastBytes: usize.ZERO, reject: false }
  let mut output = run Bytes.copy(b"previous output long enough") |> Effect.provideMut<Allocator>(&mut audit)
  audit.reject = true
  let encoded = run UriPercent.encodeInto(&mut output, b"a/b", PercentComponent.PathSegment) |> Effect.provideMut<Allocator>(&mut audit)
  if !bytesText(&output, "a%2Fb") { return false }
  let decoded = run UriPercent.decodeInto(&mut output, "%41+") |> Effect.provideMut<Allocator>(&mut audit)
  if !decodedUnit(move decoded) || !bytesText(&output, "A+") { return false }
  let rejected = run UriPercent.decodeInto(&mut output, "%0G") |> Effect.provideMut<Allocator>(&mut audit)
  let correct = match move rejected {
    Result<(), DecodeError>.Success { value: _ } => false
    Result<(), DecodeError>.Failure { error } => error.offset == 0
  }
  return correct && bytesText(&output, "A+") && audit.calls == 1
}

fn percentInPlace() -> bool {
  let mut bytes: [u8; 7] = [37, 70, 70, 43, 37, 48, 48]
  let decoded = UriPercent.decodeInPlace(&mut bytes)
  let length = match move decoded {
    Result<usize, DecodeError>.Success { value } => value
    Result<usize, DecodeError>.Failure { error } => usize.ZERO
  }
  if length != 3 || bytes[0] != 255 || bytes[1] != 43 || bytes[2] != 0 { return false }
  let mut malformed: [u8; 4] = [97, 37, 52, 90]
  let rejected = UriPercent.decodeInPlace(&mut malformed)
  let correct = match move rejected {
    Result<usize, DecodeError>.Success { value } => false
    Result<usize, DecodeError>.Failure { error } => error.offset == 1
  }
  return correct && malformed[0] == 97 && malformed[1] == 37 && malformed[2] == 52 && malformed[3] == 90
}

fn borrowedDecoded(value: Decoded<'static>) -> bool {
  return match move value {
    Decoded<'static>.Borrowed { values } => values.length == 2 && values[0] == 65 && values[1] == 43
    Decoded<'static>.Owned { value: bytes } => false
  }
}

effect fn percentBorrowing() -> bool ! OutOfMemoryError ? &mut Allocator {
  let unchanged = run UriPercent.decodeOrBorrow("A+")
  let borrowed = match move unchanged {
    Result<Decoded<'static>, DecodeError>.Failure { error } => false
    Result<Decoded<'static>, DecodeError>.Success { value } => borrowedDecoded(move value)
  }
  if !borrowed { return false }
  let escaped = run UriPercent.decodeOrBorrow("%41")
  return match move escaped {
    Result<Decoded<'static>, DecodeError>.Failure { error } => false
    Result<Decoded<'static>, DecodeError>.Success { value } => {
      return match move value {
        Decoded<'static>.Borrowed { values } => false
        Decoded<'static>.Owned { value: bytes } => bytesText(&bytes, "A")
      }
    }
  }
}

effect fn resolvesInto<'base>(base: &Uri<'base>) -> bool ! OutOfMemoryError {
  let mut audit = UriAllocationAudit { calls: 0, lastBytes: usize.ZERO, reject: false }
  let mut output = run Bytes.copy(b"previous output with reusable capacity") |> Effect.provideMut<Allocator>(&mut audit)
  audit.reject = true
  let reference = match move UriReference.parse("../g") {
    Result<UriReference<'static>, ParseError>.Success { value } => value
    Result<UriReference<'static>, ParseError>.Failure { error } => { return false }
  }
  let first = run Uri.resolveInto(&mut output, base, &reference) |> Effect.provideMut<Allocator>(&mut audit)
  if !parsedUnit(move first) || !bytesText(&output, "http://a/b/g") { return false }
  let empty = match move UriReference.parse("?#") {
    Result<UriReference<'static>, ParseError>.Success { value } => value
    Result<UriReference<'static>, ParseError>.Failure { error } => { return false }
  }
  let second = run Uri.resolveInto(&mut output, base, &empty) |> Effect.provideMut<Allocator>(&mut audit)
  if !parsedUnit(move second) || audit.calls != 1 { return false }
  // Successful URI resolution proves these bytes are valid ASCII; transfer the completed storage.
  let text = unsafe String.fromBytesUnchecked(move output)
  return match move OwnedUri.fromString(move text) {
    Result<OwnedUri, ParseError>.Success { value } => ownedMatches(move value, "http://a/b/c/d;p?#")
    Result<OwnedUri, ParseError>.Failure { error } => false
  }
}

effect fn vectorsAndReuse<'base>(base: &Uri<'base>) -> i32 ! OutOfMemoryError ? &mut Allocator {
  if !(run resolvesInto(base)) { return 179 }
  return run vectors(base)
}

effect fn serializedMatches<'text>(components: &UriComponents<'text>, selection: Serialization, expected: string)
-> bool ! OutOfMemoryError ? &mut Allocator {
  let result = run UriComponents.serializeOwned(components, selection)
  return match move result {
    Result<String, ParseError>.Failure { error } => false
    Result<String, ParseError>.Success { value } => String.view(&value) == expected
  }
}

effect fn componentsModified() -> bool ! OutOfMemoryError ? &mut Allocator {
  let parsed = match move UriReference.parse("x://u:p@EXAMPLE.com:0007/a%2f?#") {
    Result<UriReference<'static>, ParseError>.Success { value } => value
    Result<UriReference<'static>, ParseError>.Failure { error } => { return false }
  }
  let mut components = UriComponents.fromReference(&parsed)
  if !(run serializedMatches(&components, Serialization.Full, "x://u:p@EXAMPLE.com:0007/a%2f?#")) { return false }
  if !(run serializedMatches(&components, Serialization.WithoutAuthentication, "x://EXAMPLE.com:0007/a%2f?#")) { return false }
  if !(run serializedMatches(&components, Serialization.PathAndQuery, "/a%2f?")) { return false }
  components.path = ComponentValue<'static>.Raw { bytes: b"/a b/c?d" }
  components.query = Option<ComponentValue<'static>>.some(ComponentValue<'static>.Encoded { text: "%2f" })
  let built = run UriComponents.buildOwned(&components)
  return match move built {
    Result<OwnedUriReference, ParseError>.Failure { error } => false
    Result<OwnedUriReference, ParseError>.Success { value } => {
      let view = OwnedUriReference.view(&value)
      return UriReference.format(&view) == "x://u:p@EXAMPLE.com:0007/a%20b/c%3Fd?%2f#"
    }
  }
}

effect fn constructedAuthority() -> bool ! OutOfMemoryError ? &mut Allocator {
  let mut components = UriComponents<'static>.make()
  components.authority = Option<Authority<'static>>.some(Authority<'static> {
    userinfo: Option<ComponentValue<'static>>.some(ComponentValue<'static>.Raw { bytes: b"u@:p" }),
    host: Host<'static>.RegName { value: ComponentValue<'static>.Raw { bytes: b"name:host" } },
    port: Option<string<'static>>.some("")
  })
  components.path = ComponentValue<'static>.Raw { bytes: b"/a?b" }
  if !(run serializedMatches(&components, Serialization.Full, "//u%40:p@name%3Ahost:/a%3Fb")) { return false }
  components.authority = Option<Authority<'static>>.some(Authority<'static> {
    userinfo: Option<ComponentValue<'static>>.none(),
    host: Host<'static>.IpLiteral { text: "[::1]" },
    port: Option<string<'static>>.none()
  })
  return run serializedMatches(&components, Serialization.Full, "//[::1]/a%3Fb")
}

effect fn componentBoundaries() -> bool ! OutOfMemoryError ? &mut Allocator {
  let mut components = UriComponents<'static>.make()
  components.path = ComponentValue<'static>.Raw { bytes: b"a:b/c:d" }
  if !(run serializedMatches(&components, Serialization.Full, "a%3Ab/c:d")) { return false }
  components.query = Option<ComponentValue<'static>>.some(ComponentValue<'static>.Encoded { text: "a#b" })
  let mut output = run Bytes.copy(b"unchanged")
  let rejected = run UriComponents.serializeInto(&mut output, &components, Serialization.Full)
  let correct = match move rejected {
    Result<(), ParseError>.Success { value: _ } => false
    Result<(), ParseError>.Failure { error } => error.component == Component.Query && error.offset == 1
  }
  if !correct || !bytesText(&output, "unchanged") { return false }
  components.query = Option<ComponentValue<'static>>.none()
  let reused = run UriComponents.serializeInto(&mut output, &components, Serialization.Full)
  if !parsedUnit(move reused) || !bytesText(&output, "a%3Ab/c:d") { return false }
  components.path = ComponentValue<'static>.Encoded { text: "a:b" }
  let pathRejected = run UriComponents.serializeInto(&mut output, &components, Serialization.Full)
  return match move pathRejected {
    Result<(), ParseError>.Success { value: _ } => false
    Result<(), ParseError>.Failure { error } => error.component == Component.Path && error.offset == 1 && bytesText(&output, "a%3Ab/c:d")
  }
}

effect fn adoptedInput() -> bool ! OutOfMemoryError ? &mut Allocator {
  let text = run String.copy("x:/transferred")
  let bytes = String.intoBytes(move text)
  let validated = String.fromBytes(move bytes)
  let adopted = match move validated {
    Result<String, InvalidUtf8>.Failure { error } => { return false }
    Result<String, InvalidUtf8>.Success { value } => OwnedUri.fromString(move value)
  }
  return match move adopted {
    Result<OwnedUri, ParseError>.Failure { error } => false
    Result<OwnedUri, ParseError>.Success { value } => {
      let text = OwnedUri.intoString(move value)
      return String.view(&text) == "x:/transferred"
    }
  }
}

struct UriWriterAudit {
  bytes: [u8; 16]
  count: usize
}

effect fn writeAll(self: &mut UriWriterAudit, values: &[u8]) -> () ! WriterError {
  let mut index = usize.ZERO
  while index < values.length {
    self.bytes[self.count] = values[index]
    self.count = self.count + usize.ONE
    index = index + usize.ONE
  }
}

effect fn flush(self: &mut UriWriterAudit) -> () ! WriterError { return () }
impl Writer for UriWriterAudit { writeAll: UriWriterAudit.writeAll flush: UriWriterAudit.flush }

effect fn writerEncoding() -> bool ! WriterError {
  let mut writer = UriWriterAudit { bytes: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], count: usize.ZERO }
  let written = run UriPercent.encodeToWriter(b"a/b%2f", PercentComponent.PathSegment)
    |> Effect.provideMut<Writer>(&mut writer)
  return writerMatches(move writer)
}

fn writerMatches(writer: UriWriterAudit) -> bool {
  let count = writer.count
  let bytes = Slice.view<u8>(&writer.bytes, usize.ZERO, count)
  return match move String.fromUtf8(bytes) {
    Result<string, InvalidUtf8>.Success { value } => value == "a%2Fb%252f"
    Result<string, InvalidUtf8>.Failure { error } => false
  }
}

effect fn writerFailed(error: WriterError) -> bool { return false }

struct UriAllocationAudit {
 calls: i32
 lastBytes: usize
 reject: bool
}
effect fn allocate(self: &mut UriAllocationAudit, layout: Layout) -> Intrinsic.Allocation ! OutOfMemoryError {
  self.calls = self.calls + 1
  self.lastBytes = layout.bytes
  if self.reject { return run Allocator.outOfMemory() }
  let mut inner = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut inner)
}
impl Allocator for UriAllocationAudit { allocate: UriAllocationAudit.allocate }

// Owned storage must request precisely the emitted byte count, once; a second growth is observable.
effect fn ownedPercentAllocationContract() -> bool ! OutOfMemoryError {
  let mut audit = UriAllocationAudit {calls: 0, lastBytes: usize.ZERO, reject: false}
  let raw = b"a/b%2f"
  let encoded = run UriPercent.encodeOwned(&raw, PercentComponent.PathSegment) |> Effect.provideMut(&mut audit)
  if String.view(&encoded) != "a%2Fb%252f" || audit.calls != 1 || audit.lastBytes != 10 { return false }
  let decoded = run UriPercent.decodeOwned("%FF+%00") |> Effect.provideMut(&mut audit)
  return match move decoded {
    Result<Bytes, DecodeError>.Success {value} => Bytes.length(&value) == 3 && audit.calls == 2 && audit.lastBytes == 3
    Result<Bytes, DecodeError>.Failure {error: _} => false
  }
}


effect fn check() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let parsed = Uri.parse("http://a/b/c/d;p?q")
  let result = match move parsed {
    Result<Uri<'static>, ParseError>.Failure { error } => 100
    Result<Uri<'static>, ParseError>.Success { value } => run vectorsAndReuse(&value)
  }
  if result != 0 { return result }
  if !(emptyComponents()) { return 101 }
  if !(roundtrip("mailto:person@example.com")) { return 102 }
  if !(roundtrip("urn:example:thing")) { return 103 }
  if !(roundtrip("//user:pass@EXAMPLE.com:999999/a%2f?+#")) { return 104 }
  if !(roundtrip("a/b:c")) { return 105 }
  let segment = b"a/b%2f"
  if !(run encoded(&segment, PercentComponent.PathSegment, "a%2Fb%252f")) { return 106 }
  let delimiters = b"a:b@c/?#%+"
  if !(run encoded(&delimiters, PercentComponent.Userinfo, "a:b%40c%2F%3F%23%25+")) { return 107 }
  if !(run encoded(&delimiters, PercentComponent.RegName, "a%3Ab%40c%2F%3F%23%25+")) { return 108 }
  if !(run encoded(&delimiters, PercentComponent.FirstPathSegment, "a%3Ab@c%2F%3F%23%25+")) { return 109 }
  if !(run encoded(&delimiters, PercentComponent.Query, "a:b@c/?%23%25+")) { return 110 }
  if !(run encoded(&delimiters, PercentComponent.Fragment, "a:b@c/?%23%25+")) { return 111 }
  if !(run percentBytes()) { return 112 }
  if !(run badDecode("a%", 1)) { return 113 }
  if !(run badDecode("a%0G", 1)) { return 114 }
  if !(run ownedInput()) { return 115 }
  if !(run emptyBasePath()) { return 116 }
  if !(missingScheme()) { return 117 }
  if !(run recomposition()) { return 118 }
  if !(run percentReuse()) { return 170 }
  if !percentInPlace() { return 171 }
  if !(run percentBorrowing()) { return 172 }
  if !(run componentsModified()) { return 173 }
  if !(run constructedAuthority()) { return 174 }
  if !(run componentBoundaries()) { return 175 }
  if !(run adoptedInput()) { return 176 }
  if !(run ownedPercentAllocationContract()) { return 181 }
  if !(run Effect.catchAll(writerEncoding(), writerFailed)) { return 183 }
  if !(run encoded(&delimiters, PercentComponent.Path, "a:b@c/%3F%23%25+")) { return 177 }
  if !(run encoded(&delimiters, PercentComponent.Unreserved, "a%3Ab%40c%2F%3F%23%25%2B")) { return 178 }
  if !(hostKind("//127.0.0.1:999999", HostKind.Ipv4)) { return 120 }
  if !(hostKind("//01.2.3.4", HostKind.RegName)) { return 121 }
  if !(hostKind("//[::ffff:192.0.2.1]", HostKind.Ipv6)) { return 122 }
  if !(hostKind("//[vF.a:b]", HostKind.IpvFuture)) { return 123 }
  if !(hostKind("//[1:2:3:4:5:6:7:8]", HostKind.Ipv6)) { return 124 }
  if !(hostKind("//[::]", HostKind.Ipv6)) { return 125 }
  if !(hostKind("//[1:2:3:4:5:6:7::]", HostKind.Ipv6)) { return 126 }
  if !(hostKind("//[1:2:3:4:5:6:192.0.2.1]", HostKind.Ipv6)) { return 127 }
  if !(badReference("%", ParseReason.InvalidPercentEscape, Component.Path, 0)) { return 140 }
  if !(badReference("/%0G", ParseReason.InvalidPercentEscape, Component.Path, 3)) { return 141 }
  if !(badReference("a b", ParseReason.InvalidCharacter, Component.Path, 1)) { return 142 }
  if !(badReference("a#b#c", ParseReason.InvalidCharacter, Component.Fragment, 3)) { return 143 }
  if !(badReference("//[::1", ParseReason.InvalidHost, Component.Host, 6)) { return 144 }
  if !(badReference("1x:a", ParseReason.InvalidScheme, Component.Scheme, 0)) { return 145 }
  if !(badReference("/é", ParseReason.InvalidCharacter, Component.Path, 1)) { return 146 }
  if !(badReference("//[1:2:3:4:5:6:7]", ParseReason.InvalidHost, Component.Host, 16)) { return 147 }
  if !(badReference("//[1:2:3:4:5:6:7:8:9]", ParseReason.InvalidHost, Component.Host, 19)) { return 148 }
  if !(badReference("//[1::2::3]", ParseReason.InvalidHost, Component.Host, 8)) { return 149 }
  if !(badReference("//[::ffff:256.1.1.1]", ParseReason.InvalidHost, Component.Host, 10)) { return 150 }
  if !(badReference("//[fe80::1%25eth0]", ParseReason.InvalidHost, Component.Host, 10)) { return 151 }
  if !(badReference("//[v.a]", ParseReason.InvalidHost, Component.Host, 4)) { return 152 }
  if !(badReference("//[v1.]", ParseReason.InvalidHost, Component.Host, 6)) { return 153 }
  if !(badReference("//[1:2:3:4:5:6:7::8]", ParseReason.InvalidHost, Component.Host, 19)) { return 154 }
  if !(badReference("//h:x", ParseReason.InvalidPort, Component.Port, 4)) { return 155 }
  if !(badReference("//u@v@h", ParseReason.InvalidCharacter, Component.Authority, 5)) { return 156 }
  if !(badReference("//[::]x", ParseReason.InvalidHost, Component.Host, 6)) { return 157 }
  return 0
}

effect fn allocated() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run check() |> Effect.provideMut<Allocator>(&mut allocator)
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 250 }

pub fn main() -> i32 { return run Effect.catchAll(allocated(), recover) }
`
