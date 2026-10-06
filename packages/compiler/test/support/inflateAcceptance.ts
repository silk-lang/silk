import { readFileSync } from 'node:fs'
import * as Schema from 'effect/Schema'
import { unreachable } from './raise.js'

const vectors = Schema.decodeUnknownSync(
  Schema.Struct({
    vectors: Schema.Array(
      Schema.Struct({
        name: Schema.String,
        format: Schema.Literals(['Raw', 'Zlib', 'Gzip']),
        compressed: Schema.Array(Schema.Finite),
        expected: Schema.optional(Schema.Array(Schema.Finite)),
        expectedPattern: Schema.optional(Schema.Array(Schema.Finite)),
        expectedLength: Schema.optional(Schema.Finite),
      }),
    ),
  }),
)(
  JSON.parse(readFileSync(new URL('../fixtures/inflate-vectors.json', import.meta.url), 'utf8')),
).vectors

const array = (values: ReadonlyArray<number>): string =>
  `let input: [u8; ${values.length}] = [${values.join(', ')}]`

const fixture = (name: string) =>
  vectors.find((vector) => vector.name === name) ?? unreachable(`Missing inflate vector ${name}`)
const zlib = fixture('published-zlib-hello')
const gzip = fixture('gzip-optional-header')
const concatenated = fixture('gzip-concatenated')
const corrupt = (bytes: ReadonlyArray<number>, at: number): number[] =>
  bytes.map((byte, index) => (index === at ? byte ^ 1 : byte))

const invalidCases = [
  // Each gzip member starts with empty history.
  {
    bytes: [
      31, 139, 8, 0, 0, 0, 0, 0, 0, 255, 115, 4, 0, 139, 158, 217, 211, 1, 0, 0, 0, 31, 139, 8, 0,
      0, 0, 0, 0, 0, 255, 3, 2, 0, 167, 49, 160, 102, 3, 0, 0, 0,
    ],
    kind: 'InvalidDistance',
    format: 'Gzip',
  },
  // RFC 1950 CINFO=0 allows only a 256-byte window; distance 257 is invalid.
  {
    bytes: [
      8,
      29,
      0,
      1,
      1,
      254,
      254,
      ...Array.from({ length: 257 }, () => 65),
      3,
      6,
      0,
      0,
      169,
      253,
      66,
      5,
    ],
    kind: 'InvalidDistance',
    format: 'Zlib',
  },
  { bytes: corrupt(gzip.compressed, 39), kind: 'ChecksumMismatch', format: 'Gzip' },
  // A match cannot use a legal-but-empty distance alphabet.
  {
    bytes: [
      13, 192, 1, 4, 0, 0, 0, 0, 16, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 5,
    ],
    kind: 'InvalidHuffman',
    format: 'Raw',
  },
  // reserved-length; independently rejected by zlib.
  { bytes: [27, 3], kind: 'InvalidBlock', format: 'Raw' },
  // reserved-distance; independently rejected by zlib.
  { bytes: [3, 62], kind: 'InvalidDistance', format: 'Raw' },
  // distance-before-history; independently rejected by zlib.
  { bytes: [3, 2], kind: 'InvalidDistance', format: 'Raw' },
  // oversubscribed-code-length-tree; independently rejected by zlib.
  { bytes: [5, 0, 146, 0], kind: 'InvalidHuffman', format: 'Raw' },
  // incomplete-code-length-tree; independently rejected by zlib.
  { bytes: [5, 0, 0, 4], kind: 'InvalidHuffman', format: 'Raw' },
  // repeat-without-previous; independently rejected by zlib.
  { bytes: [5, 0, 2, 36], kind: 'InvalidHuffman', format: 'Raw' },
  // repeat-overflow; independently rejected by zlib.
  { bytes: [5, 0, 128, 228, 255, 31], kind: 'InvalidHuffman', format: 'Raw' },
  // missing-eob; independently rejected by zlib.
  {
    bytes: [
      5, 192, 1, 4, 0, 0, 0, 0, 144, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    ],
    kind: 'InvalidHuffman',
    format: 'Raw',
  },
  // oversubscribed-literal-tree; independently rejected by zlib.
  {
    bytes: [
      5, 192, 1, 4, 0, 0, 0, 0, 144, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 128, 0,
    ],
    kind: 'InvalidHuffman',
    format: 'Raw',
  },
  // incomplete-literal-tree; independently rejected by zlib.
  {
    bytes: [
      5, 128, 1, 4, 0, 0, 0, 64, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
      0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 2,
    ],
    kind: 'InvalidHuffman',
    format: 'Raw',
  },
  { bytes: [7], kind: 'InvalidBlock', format: 'Raw' },
  { bytes: [1, 1, 0, 0, 0, 65], kind: 'InvalidBlock', format: 'Raw' },
  { bytes: [1, 1, 0, 254, 255], kind: 'TruncatedInput', format: 'Raw' },
  { bytes: [120, 0], kind: 'InvalidHeader', format: 'Zlib' },
  { bytes: [120, 32], kind: 'UnsupportedDictionary', format: 'Zlib' },
  { bytes: [31, 139, 8, 224], kind: 'InvalidHeader', format: 'Gzip' },
  { bytes: [31, 139, 9, 0], kind: 'UnsupportedMethod', format: 'Gzip' },
  {
    bytes: corrupt(zlib.compressed, zlib.compressed.length - 1),
    kind: 'ChecksumMismatch',
    format: 'Zlib',
  },
  {
    bytes: corrupt(gzip.compressed, gzip.compressed.length - 8),
    kind: 'ChecksumMismatch',
    format: 'Gzip',
  },
  {
    bytes: corrupt(gzip.compressed, gzip.compressed.length - 4),
    kind: 'SizeMismatch',
    format: 'Gzip',
  },
  { bytes: [...concatenated.compressed, 0], kind: 'InvalidHeader', format: 'Gzip' },
  { bytes: zlib.compressed.slice(0, -1), kind: 'TruncatedInput', format: 'Zlib' },
  { bytes: gzip.compressed.slice(0, -1), kind: 'TruncatedInput', format: 'Gzip' },
]

interface DecodeCase {
  readonly bytes: ReadonlyArray<number>
  readonly pattern: ReadonlyArray<number>
  readonly length: number
  readonly format: string
  readonly failure: boolean
  readonly kind: string
  readonly inputWidth?: number
  readonly outputWidth?: number
  readonly inputLimit?: number
  readonly outputLimit?: number
  readonly memberLimit?: number
  readonly headerLimit?: number
  readonly consumed?: number
  readonly written?: number
}

const cases: ReadonlyArray<DecodeCase> = [
  ...vectors.map((vector) => ({
    bytes: vector.compressed,
    pattern: vector.expected ?? vector.expectedPattern ?? [],
    length: vector.expected?.length ?? vector.expectedLength ?? 0,
    format: vector.format,
    failure: false,
    kind: 'InvalidUse',
  })),
  ...invalidCases.map((vector) => ({
    bytes: vector.bytes,
    pattern: [],
    length: 0,
    format: vector.format,
    failure: true,
    kind: vector.kind,
  })),
  ...[
    {
      inputLimit: concatenated.compressed.length - 1,
      kind: 'InputLimit',
      consumed: concatenated.compressed.length - 1,
    },
    {
      outputLimit: (concatenated.expected?.length ?? 0) - 1,
      kind: 'OutputLimit',
      written: (concatenated.expected?.length ?? 0) - 1,
    },
    { memberLimit: 2, kind: 'MemberLimit', consumed: 45, written: 5 },
    { headerLimit: 29, kind: 'HeaderLimit', consumed: 54, written: 5 },
  ].map((cap) => ({
    bytes: concatenated.compressed,
    pattern: [],
    length: 0,
    format: 'Gzip',
    failure: true,
    ...cap,
  })),
  {
    bytes: gzip.compressed,
    pattern: gzip.expected ?? [],
    length: gzip.expected?.length ?? 0,
    format: 'Gzip',
    failure: false,
    kind: 'InvalidUse',
    inputWidth: gzip.compressed.length,
    outputWidth: 7,
    inputLimit: gzip.compressed.length,
    outputLimit: gzip.expected?.length ?? 0,
    memberLimit: 1,
    headerLimit: 41,
  },
  {
    bytes: gzip.compressed,
    pattern: [],
    length: 0,
    format: 'Gzip',
    failure: true,
    kind: 'HeaderLimit',
    headerLimit: 40,
    consumed: 40,
    written: 0,
  },
]
const inputBytes: number[] = []
const expectedBytes: number[] = []
const descriptors = cases
  .map((test, index) => {
    const inputOffset = inputBytes.length
    const expectedOffset = expectedBytes.length
    inputBytes.push(...test.bytes)
    expectedBytes.push(...test.pattern)
    return `if index == ${index} { return Case { inputOffset: ${inputOffset}, inputLength: ${test.bytes.length}, expectedOffset: ${expectedOffset}, patternLength: ${test.pattern.length}, outputLength: ${test.length}, format: Format.${test.format}, failure: ${test.failure}, kind: ErrorKind.${test.kind}, inputWidth: ${test.inputWidth ?? 1}, outputWidth: ${test.outputWidth ?? 1}, inputLimit: ${test.inputLimit ?? 100000}, outputLimit: ${test.outputLimit ?? 100000}, memberLimit: ${test.memberLimit ?? 8}, headerLimit: ${test.headerLimit ?? 1000}, consumed: ${test.consumed ?? 100000}, written: ${test.written ?? 100000} } }`
  })
  .join('\n')

const byteLiteral = (values: ReadonlyArray<number>): string =>
  'b"' + values.map((value) => '\\x' + value.toString(16).padStart(2, '0')).join('') + '"'

export const inflateAcceptanceSource = `
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.inflate { Decoder, Format, Status, Limits, Progress, DecodeError, ErrorKind }
import silk.result { Result }
import silk.slice { Slice }
import silk.vector { Vector }
import silk.usize

fn limits() -> Limits {
  return Limits { maxInputBytes: 100000, maxOutputBytes: 100000, maxMembers: 8, maxHeaderBytes: 1000, maxMemoryBytes: 65536 }
}

struct Observation {
  consumed: usize
  written: usize
  status: Status
  failed: bool
  kind: ErrorKind
}

fn observation(outcome: Result<Progress, DecodeError>) -> Observation {
  return match move outcome {
    Result<Progress, DecodeError>.Success { value } => Observation { consumed: value.consumed, written: value.written, status: value.status, failed: false, kind: ErrorKind.InvalidUse }
    Result<Progress, DecodeError>.Failure { error } => Observation { consumed: error.consumed, written: error.written, status: Status.Finished, failed: true, kind: error.kind }
  }
}

fn advance(decoder: &mut Decoder, input: &[u8], output: &mut [u8], finalInput: bool, first: bool) -> Observation {
  if first {
    let mut empty: [u8; 0] = []
    return observation(Decoder.step(&mut decoder, input, &mut empty, finalInput))
  }
  return observation(Decoder.step(&mut decoder, input, &mut output, finalInput))
}

effect fn verify(input: &[u8], expected: &[u8], expectedLength: usize, format: Format, inputWidth: usize, outputWidth: usize, cap: Limits, expectFailure: bool, expectedKind: ErrorKind, failureInput: usize, failureOutput: usize) -> i32
! OutOfMemoryError | DecodeError ? &mut Allocator {
  let inputLimit = cap.maxInputBytes
  let outputLimit = cap.maxOutputBytes
  let mut decoder = run Decoder.make(format, move cap)
  let mut chunk = Vector.make<u8>()
  run Vector.reserve<u8>(&mut chunk, inputWidth)
  let mut output = Vector.make<u8>()
  run Vector.reserve<u8>(&mut output, outputWidth)
  let mut fill = usize.ZERO
  while fill < outputWidth {
    run Vector.append<u8>(&mut output, 0)
    fill = fill + 1
  }
  let mut loaded = usize.ZERO
  let mut written = usize.ZERO
  let mut consumed = usize.ZERO
  let mut calls = usize.ZERO
  while calls < input.length * 8 + expectedLength * 4 + 100 {
    calls = calls + 1
    if Vector.length<u8>(&chunk) == 0 {
      let mut count = usize.ZERO
      while count < inputWidth && loaded < input.length {
        run Vector.append<u8>(&mut chunk, input[loaded])
        loaded = loaded + 1
        count = count + 1
      }
    }
    let available = Vector.length<u8>(&chunk)
    let outcome = advance(&mut decoder, Vector.asSlice<u8>(&chunk), Vector.asMutSlice<u8>(&mut output), loaded == input.length, calls == 1)
    if outcome.consumed > available || outcome.written > outputWidth { return 1 }
    consumed = consumed + outcome.consumed
    let mut index = usize.ZERO
    while index < outcome.written {
      if !expectFailure {
        if written >= expectedLength || expected.length == 0 { return 2 }
        if Vector.get<u8>(&output, index) != expected[usize.remainder(written, expected.length)] { return 3 }
      }
      written = written + 1
      index = index + 1
    }
    if outcome.failed {
      if !expectFailure || outcome.kind != expectedKind { return 4 }
      if failureInput != 100000 && consumed != failureInput { return 12 }
      if failureOutput != 100000 && written != failureOutput { return 13 }
      if expectedKind == ErrorKind.InputLimit && usize.toU64(consumed) != inputLimit { return 10 }
      if expectedKind == ErrorKind.OutputLimit && usize.toU64(written) != outputLimit { return 11 }
      let empty: [u8; 0] = []
      let again = observation(Decoder.step(&mut decoder, &empty, Vector.asMutSlice<u8>(&mut output), true))
      if !again.failed || again.kind != ErrorKind.InvalidUse || again.consumed != 0 || again.written != 0 { return 5 }
      return 0
    }
    if outcome.status == Status.Finished {
      if expectFailure || written != expectedLength || consumed != input.length { return 6 }
      let empty: [u8; 0] = []
      let again = observation(Decoder.step(&mut decoder, &empty, Vector.asMutSlice<u8>(&mut output), true))
      if again.failed || again.status != Status.Finished || again.consumed != 0 || again.written != 0 { return 7 }
      return 0
    }
    if outcome.status == Status.NeedInput && (outcome.consumed != available || loaded == input.length) { return 8 }
    let remaining = available - outcome.consumed
    index = usize.ZERO
    while index < remaining {
      let byte = Vector.get<u8>(&chunk, index + outcome.consumed)
      Vector.set<u8>(&mut chunk, index, byte)
      index = index + 1
    }
    Vector.truncate<u8>(&mut chunk, remaining)
  }
  return 9
}

struct Case {
  inputOffset: usize
  inputLength: usize
  expectedOffset: usize
  patternLength: usize
  outputLength: usize
  format: Format
  failure: bool
  kind: ErrorKind
  inputWidth: usize
  outputWidth: usize
  inputLimit: u64
  outputLimit: u64
  memberLimit: u64
  headerLimit: u64
  consumed: usize
  written: usize
}

fn selectCase(index: usize) -> Case {
  ${descriptors}
  return Case { inputOffset: 0, inputLength: 0, expectedOffset: 0, patternLength: 0, outputLength: 0, format: Format.Raw, failure: true, kind: ErrorKind.InvalidUse, inputWidth: 1, outputWidth: 1, inputLimit: 0, outputLimit: 0, memberLimit: 1, headerLimit: 0, consumed: 0, written: 0 }
}

// One verify call site prevents per-fixture optimizer specialization of the decoder.
effect fn suite() -> i32 ! OutOfMemoryError | DecodeError ? &mut Allocator {
  let bytes = ${byteLiteral(inputBytes)}
  let patterns = ${byteLiteral(expectedBytes)}
  let mut input = Vector.make<u8>()
  let mut expected = Vector.make<u8>()
  let mut caseIndex: usize = 0
  while caseIndex < ${cases.length} {
    let selected = selectCase(caseIndex)
    Vector.clear<u8>(&mut input)
    Vector.clear<u8>(&mut expected)
    let mut index: usize = 0
    while index < selected.inputLength {
      run Vector.append<u8>(&mut input, bytes[selected.inputOffset + index])
      index = index + 1
    }
    index = 0
    while index < selected.patternLength {
      run Vector.append<u8>(&mut expected, patterns[selected.expectedOffset + index])
      index = index + 1
    }
    let cap = Limits { maxInputBytes: selected.inputLimit, maxOutputBytes: selected.outputLimit, maxMembers: selected.memberLimit, maxHeaderBytes: selected.headerLimit, maxMemoryBytes: 65536 }
    let result = run verify(Vector.asSlice<u8>(&input), Vector.asSlice<u8>(&expected), selected.outputLength, selected.format, selected.inputWidth, selected.outputWidth, move cap, selected.failure, selected.kind, selected.consumed, selected.written)
    if result != 0 { return usize.toI32(caseIndex) + 100 }
    caseIndex = caseIndex + 1
  }
  return 0
}

fn constructorError(outcome: Result<Decoder, OutOfMemoryError | DecodeError>) -> ErrorKind {
  return match move outcome {
    Result<Decoder, OutOfMemoryError | DecodeError>.Success { value } => unexpectedDecoder(move value)
    Result<Decoder, OutOfMemoryError | DecodeError>.Failure { error } => match move error {
      OutOfMemoryError e => ErrorKind.InvalidUse
      DecodeError e => e.kind
    }
  }
}

fn unexpectedDecoder(decoder: Decoder) -> ErrorKind {
  drop decoder
  return ErrorKind.InvalidUse
}

effect fn constructionLimits() -> i32 ? &mut Allocator {
  let mut cap = limits()
  cap.maxMemoryBytes = 65535
  let memory = run Effect.result(Decoder.make(Format.Raw, move cap))
  if constructorError(move memory) != ErrorKind.MemoryLimit { return 1 }
  let mut noMembers = limits()
  noMembers.maxMembers = 0
  let members = run Effect.result(Decoder.make(Format.Gzip, move noMembers))
  if constructorError(move members) != ErrorKind.MemberLimit { return 2 }
  return 0
}

effect fn terminalSuffix(input: &[u8], format: Format, expectedConsumed: usize) -> i32
! OutOfMemoryError | DecodeError ? &mut Allocator {
  let mut decoder = run Decoder.make(format, limits())
  let mut output: [u8; 16] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
  let outcome = observation(Decoder.step(&mut decoder, input, &mut output, true))
  if outcome.failed || outcome.status != Status.Finished || outcome.consumed != expectedConsumed { return 1 }
  return 0
}

effect fn lifecycle() -> i32 ! OutOfMemoryError | DecodeError ? &mut Allocator {
  let raw: [u8; 3] = [3,0,255]
  if (run terminalSuffix(&raw, Format.Raw, 2)) != 0 { return 1 }
  let zlib: [u8; ${zlib.compressed.length + 1}] = [${zlib.compressed.join(',')},255]
  if (run terminalSuffix(&zlib, Format.Zlib, ${zlib.compressed.length})) != 0 { return 2 }
  ${array(concatenated.compressed)}
  let mut gzipDecoder = run Decoder.make(Format.Gzip, limits())
  let mut output: [u8; 16] = [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0]
  let memberBoundary = observation(Decoder.step(&mut gzipDecoder, &input, &mut output, false))
  if memberBoundary.failed || memberBoundary.status != Status.NeedInput || memberBoundary.consumed != ${concatenated.compressed.length} { return 3 }
  let empty: [u8; 0] = []
  let end = observation(Decoder.step(&mut gzipDecoder, &empty, &mut output, true))
  if end.failed || end.status != Status.Finished || end.written != 0 || end.consumed != 0 { return 4 }

  let stored: [u8; 6] = [1,1,0,254,255,65]
  let mut noOutput: [u8; 0] = []
  let mut first = run Decoder.make(Format.Raw, limits())
  let pending = observation(Decoder.step(&mut first, &stored, &mut noOutput, true))
  if pending.failed || pending.status != Status.NeedOutput || pending.written != 0 { return 5 }
  let wrongFlag = observation(Decoder.step(&mut first, &empty, &mut output, false))
  if !wrongFlag.failed || wrongFlag.kind != ErrorKind.InvalidUse || wrongFlag.consumed != 0 { return 6 }
  let mut second = run Decoder.make(Format.Raw, limits())
  let pendingAgain = observation(Decoder.step(&mut second, &stored, &mut noOutput, true))
  let wrongLength = observation(Decoder.step(&mut second, &stored, &mut output, true))
  if !wrongLength.failed || wrongLength.kind != ErrorKind.InvalidUse || wrongLength.consumed != 0 { return 7 }
  return 0
}

// These helpers are ordinary functions: reset and every subsequent step require no allocator.
fn resetSucceeded(outcome: Result<(), DecodeError>) -> bool {
  return match move outcome {
    Result<(), DecodeError>.Success { value } => true
    Result<(), DecodeError>.Failure { error } => false
  }
}

fn resetRejected(outcome: Result<(), DecodeError>, kind: ErrorKind) -> bool {
  return match move outcome {
    Result<(), DecodeError>.Success { value } => false
    Result<(), DecodeError>.Failure { error } => error.kind == kind && error.consumed == 0 && error.written == 0
  }
}

// A single byte of output exercises continuation without allocating per-stream buffers.
fn finishResetStream(decoder: &mut Decoder, input: &[u8], pattern: &[u8], length: usize) -> bool {
  let mut output: [u8; 1] = [0]
  let mut consumed: usize = 0
  let mut written: usize = 0
  let mut calls: usize = 0
  while calls < input.length + length + 2 {
    calls = calls + 1
    let suffix = Slice.view<u8>(input, consumed, input.length - consumed)
    let outcome = observation(Decoder.step(&mut decoder, suffix, &mut output, true))
    if outcome.failed || outcome.consumed > suffix.length || outcome.written > 1 { return false }
    consumed = consumed + outcome.consumed
    if outcome.written == 1 {
      if written >= length || pattern.length == 0 { return false }
      if output[0] != pattern[usize.remainder(written, pattern.length)] { return false }
      written = written + 1
    }
    if outcome.status == Status.Finished { return consumed == input.length && written == length }
    if outcome.status != Status.NeedOutput { return false }
  }
  return false
}

fn rejectedResetContinuation(decoder: &mut Decoder) -> bool {
  let mut attempt: usize = 0
  while attempt < 2 {
    if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return false }
    let mut output: [u8; 1] = [0]
    // Fixed literal A crosses this byte boundary, leaving a partial Huffman traversal.
    let first = observation(Decoder.step(&mut decoder, b"\\x73", &mut output, false))
    if first.failed || first.status != Status.NeedInput || first.consumed != 1 || first.written != 0 { return false }
    let mut invalid = limits()
    let mut kind = ErrorKind.MemoryLimit
    if attempt == 0 {
      invalid.maxMemoryBytes = 65535
    } else {
      invalid.maxMembers = 0
      kind = ErrorKind.MemberLimit
    }
    if !resetRejected(Decoder.reset(&mut decoder, Format.Gzip, move invalid), kind) { return false }
    // Each rejected reset must preserve the original format, reservoir and symbol continuation.
    if !finishResetStream(&mut decoder, b"\\x04\\x00", b"A", 1) { return false }
    attempt = attempt + 1
  }
  return true
}

fn resetStreams(decoder: &mut Decoder) -> i32 {
  if !rejectedResetContinuation(&mut decoder) { return 1 }

  let zlib = ${byteLiteral(zlib.compressed)}
  let hello = ${byteLiteral(zlib.expected ?? [])}
  let gzip = ${byteLiteral(gzip.compressed)}
  let greeting = ${byteLiteral(gzip.expected ?? [])}
  let concatenated = ${byteLiteral(concatenated.compressed)}
  let joined = ${byteLiteral(concatenated.expected ?? [])}
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Gzip, limits())) { return 2 }
  if !finishResetStream(&mut decoder, concatenated, joined, ${concatenated.expected?.length ?? 0}) { return 3 }
  // Starting at a completed multi-member stream makes cumulative member state observable.
  let cap = Limits { maxInputBytes: ${gzip.compressed.length}, maxOutputBytes: ${gzip.expected?.length ?? 0}, maxMembers: 1, maxHeaderBytes: 41, maxMemoryBytes: 65536 }
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Gzip, move cap)) { return 4 }
  // Exact limits and the optional-header fixture witness all counters, CRCs and member size.
  if !finishResetStream(&mut decoder, gzip, greeting, ${gzip.expected?.length ?? 0}) { return 5 }
  let mut repetition: usize = 0
  while repetition < 2 {
    if !resetSucceeded(Decoder.reset(&mut decoder, Format.Zlib, limits())) { return 6 }
    if !finishResetStream(&mut decoder, zlib, hello, ${zlib.expected?.length ?? 0}) { return 7 }
    repetition = repetition + 1
  }

  let mut output: [u8; 2] = [0, 0]
  // Old output must not become a dictionary for the next independent raw stream.
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return 8 }
  let stale = observation(Decoder.step(&mut decoder, b"\\x03\\x02", &mut output, true))
  if !stale.failed || stale.kind != ErrorKind.InvalidDistance || stale.written != 0 { return 9 }
  // Recover a poisoned decoder, then fail only after writing caller-owned provisional output.
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return 10 }
  let failed = observation(Decoder.step(&mut decoder, b"\\x01\\x02\\x00\\xfd\\xff\\x41", &mut output, true))
  if !failed.failed || failed.kind != ErrorKind.TruncatedInput || failed.written != 1 || output[0] != 65 { return 11 }
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Zlib, limits())) { return 12 }
  if output[0] != 65 { return 13 }
  if !finishResetStream(&mut decoder, zlib, hello, ${zlib.expected?.length ?? 0}) { return 14 }

  // Abandon a final-input stream while output is blocked; the final suffix latch must disappear.
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return 15 }
  let mut empty: [u8; 0] = []
  let pending = observation(Decoder.step(&mut decoder, b"\\x01\\x01\\x00\\xfe\\xff\\x41", &mut empty, true))
  if pending.failed || pending.status != Status.NeedOutput { return 16 }
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Zlib, limits())) { return 17 }
  if !finishResetStream(&mut decoder, zlib, hello, ${zlib.expected?.length ?? 0}) { return 18 }

  // Abandonment also preserves a prefix already written into caller storage.
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return 27 }
  let abandoned = observation(Decoder.step(&mut decoder, b"\\x01\\x02\\x00\\xfd\\xff\\x41", &mut output, false))
  if abandoned.failed || abandoned.status != Status.NeedInput || abandoned.written != 1 || output[0] != 65 { return 28 }
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return 29 }
  if output[0] != 65 { return 30 }

  // A partial fixed symbol leaves non-default Huffman continuation fields.
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return 19 }
  let partial = observation(Decoder.step(&mut decoder, b"\\x73", &mut output, false))
  if partial.failed || partial.status != Status.NeedInput || partial.written != 0 { return 20 }
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return 21 }
  if !finishResetStream(&mut decoder, b"\\x73\\x04\\x00", b"A", 1) { return 22 }

  // CINFO=0 narrows zlib history to 256. A fresh raw stream permits distance 257.
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Zlib, limits())) { return 23 }
  let narrowed = observation(Decoder.step(&mut decoder, b"\\x08\\x1d", &mut output, false))
  if narrowed.failed || narrowed.status != Status.NeedInput || narrowed.consumed != 2 { return 24 }
  if !resetSucceeded(Decoder.reset(&mut decoder, Format.Raw, limits())) { return 25 }
  let wide = ${byteLiteral([0, 1, 1, 254, 254, ...Array.from({ length: 257 }, () => 65), 3, 6, 0, 0])}
  if !finishResetStream(&mut decoder, wide, b"A", 260) { return 26 }
  return 0
}

effect fn resetLifecycle() -> i32 ! OutOfMemoryError | DecodeError ? &mut Allocator {
  let mut decoder = run Decoder.make(Format.Raw, limits())
  return resetStreams(&mut decoder)
}

effect fn exercise() -> i32 ! OutOfMemoryError | DecodeError ? &mut Allocator {
  let checked = run suite()
  if checked != 0 { return checked }
  if (run constructionLimits()) != 0 { return 65 }
  if (run lifecycle()) != 0 { return 66 }
  let reset = run resetLifecycle()
  if reset != 0 { return 200 + reset }
  return 42
}

effect fn recover(error: OutOfMemoryError | DecodeError) -> i32 { return 99 }

pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  let work = exercise() |> Effect.provideMut<Allocator>(&mut allocator)
  return run Effect.catchAll(move work, recover)
}
`
