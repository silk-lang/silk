import { vectors } from '../fixtures/zstd/vectors.js'

interface ZstdVector {
  readonly name: string
  readonly encoded: ReadonlyArray<number>
  readonly decoded: ReadonlyArray<number>
}

const array = (bytes: ReadonlyArray<number>): string => `[${bytes.join(', ')}]`
const byteLiteral = (bytes: ReadonlyArray<number>): string =>
  'b"' + bytes.map((byte) => '\\x' + byte.toString(16).padStart(2, '0')).join('') + '"'
const raw = [40, 181, 47, 253, 32, 3, 25, 0, 0, 97, 98, 99]
const rle = [40, 181, 47, 253, 32, 3, 27, 0, 0, 120]
const skip = [80, 42, 77, 24, 2, 0, 0, 0, 77, 88]
const successes: ReadonlyArray<ZstdVector> = [
  ...vectors,
  {
    name: 'raw-rle-skip-concatenation',
    encoded: [...raw, ...skip, ...rle],
    decoded: [97, 98, 99, 120, 120, 120],
  },
  {
    name: 'explicit-zero-dictionary',
    encoded: [40, 181, 47, 253, 33, 0, 3, ...raw.slice(6)],
    decoded: [97, 98, 99],
  },
]
interface InvalidVector {
  readonly name: string
  readonly encoded: ReadonlyArray<number>
  readonly reason: string
  readonly limits?: string
  readonly consumed?: number
  readonly written?: number
}
const failures: ReadonlyArray<InvalidVector> = [
  { name: 'empty-final', encoded: [], reason: 'Truncated' },
  { name: 'partial-magic', encoded: [40, 181], reason: 'Truncated' },
  { name: 'invalid-magic', encoded: [0, 0, 0, 0], reason: 'InvalidMagic' },
  { name: 'reserved-header', encoded: [40, 181, 47, 253, 40], reason: 'ReservedFrame' },
  { name: 'reserved-block', encoded: [...raw.slice(0, 6), 31, 0, 0], reason: 'ReservedBlock' },
  { name: 'dictionary', encoded: [40, 181, 47, 253, 33, 1, 3], reason: 'UnsupportedDictionary' },
  {
    name: 'content-size',
    consumed: 12,
    written: 3,
    encoded: [40, 181, 47, 253, 32, 4, ...raw.slice(6)],
    reason: 'ContentSize',
  },
  { name: 'truncated-payload', encoded: raw.slice(0, -1), reason: 'Truncated' },
  {
    name: 'missing-checksum',
    consumed: 12,
    written: 3,
    encoded: [40, 181, 47, 253, 36, ...raw.slice(5)],
    reason: 'Truncated',
  },
  {
    name: 'corrupt-checksum',
    consumed: 16,
    written: 3,
    encoded: [40, 181, 47, 253, 36, ...raw.slice(5), 0, 0, 0, 0],
    reason: 'Checksum',
  },
  {
    name: 'malformed-compressed-block',
    encoded: [...raw.slice(0, 6), 13, 0, 0, 255],
    reason: 'MalformedBlock',
  },
  {
    name: 'input-budget',
    consumed: 12,
    written: 3,
    encoded: [...raw, ...raw],
    reason: 'InputLimit',
    limits: 'limits.inputBytes = 12',
  },
  {
    name: 'output-budget',
    consumed: 18,
    written: 3,
    encoded: [...raw, ...raw],
    reason: 'OutputLimit',
    limits: 'limits.outputBytes = 5',
  },
  {
    name: 'frame-budget-includes-skips',
    consumed: 14,
    written: 0,
    encoded: [...skip, ...raw],
    reason: 'FrameLimit',
    limits: 'limits.frames = 1',
  },
  {
    name: 'skip-budget-cumulative',
    consumed: 18,
    written: 0,
    encoded: [...skip, ...skip],
    reason: 'SkippableLimit',
    limits: 'limits.skippableBytes = 3',
  },
  {
    name: 'window-budget',
    consumed: 6,
    written: 0,
    encoded: raw,
    reason: 'WindowLimit',
    limits: 'limits.windowBytes = 2',
  },
]
// Each record contains five little-endian u16 fields, then input and expected bytes.
// Runtime iteration keeps effectful decoder construction at one callsite for every ordinary case.
const word = (value: number): ReadonlyArray<number> => [value & 255, value >>> 8]
const packedCases = [
  ...successes.flatMap((vector) => [
    ...word(vector.encoded.length),
    ...word(vector.decoded.length),
    ...word(vector.encoded.length),
    ...word(vector.decoded.length),
    ...word(0),
    ...vector.encoded,
    ...vector.decoded,
  ]),
  ...failures.flatMap((vector, index) => [
    ...word(vector.encoded.length),
    ...word(0),
    ...word(vector.consumed ?? vector.encoded.length),
    ...word(vector.written ?? 0),
    ...word(index + 1),
    ...vector.encoded,
  ]),
]
const reasonCases = failures
  .map((vector, index) => `  if code == ${index + 1} { return ZstdReason.${vector.reason} }`)
  .join('\n')
const limitCases = failures
  .flatMap((vector, index) =>
    vector.limits === undefined ? [] : [`  if code == ${index + 1} { ${vector.limits} }`],
  )
  .join('\n')
const entropy = vectors.find((vector) => vector.name === 'entropy')
if (entropy === undefined) throw new Error('Missing independent entropy fixture')

/** One compilation and native process; fixed independent bytes protect format and stream contracts. */
export const zstdAcceptanceSource = `import silk.zstd { Zstd, ZstdLimits, ZstdStatus, ZstdProgress, ZstdReason, ZstdError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.u8
import silk.raw_buffer { RawBuffer }
import silk.layout { Layout }

fn configuration() -> ZstdLimits {
  let mut limits = ZstdLimits.make()
  limits.windowBytes = 65536
  return move limits
}
fn progress(result: Result<ZstdProgress, ZstdError>, consumed: usize, written: usize, status: ZstdStatus) -> bool {
  return match move result {
    Result<ZstdProgress, ZstdError>.Success { value } => value.consumed == consumed && value.written == written && value.status == status
    Result<ZstdProgress, ZstdError>.Failure { error } => false
  }
}
fn wordAt(data: &[u8], offset: usize) -> usize {
  return u8.toUsize(data[offset]) + u8.toUsize(data[offset + 1]) * 256
}
fn reasonFor(code: usize) -> ZstdReason {
${reasonCases}
  return ZstdReason.None
}
fn limitsFor(code: usize) -> ZstdLimits {
  let mut limits = configuration()
${limitCases}
  return move limits
}
effect fn buffer(length: usize) -> Intrinsic.RawBuffer<u8> ! OutOfMemoryError ? &mut Allocator {
  let allocation = run Allocator.allocate(Layout { bytes: length, alignment: 1 })
  // The allocation was requested for \`length\` bytes with byte alignment.
  unsafe {
    let mut value = RawBuffer.from<u8>(move allocation, length)
    let initialized = RawBuffer.fill(&mut value, 0, length, 0)
    return move value
  }
}
struct Case {
  inputLength: usize
  outputLength: usize
  consumed: usize
  written: usize
  code: usize
  expectedOffset: usize
}
fn inspectCase(result: Result<ZstdProgress, ZstdError>, decoder: &mut Zstd, output: &[u8], data: &[u8], expected: &Case) -> bool {
  return match move result {
    Result<ZstdProgress, ZstdError>.Success { value } => inspectSuccess(move value, &mut decoder, output, data, expected)
    Result<ZstdProgress, ZstdError>.Failure { error } => expected.code != 0 && error.consumed == expected.consumed && error.written == expected.written && sticky(&mut decoder, move error, reasonFor(expected.code))
  }
}
fn inspectSuccess(actual: ZstdProgress, decoder: &mut Zstd, output: &[u8], data: &[u8], expected: &Case) -> bool {
  if expected.code != 0 || actual.consumed != expected.consumed || actual.written != expected.written || actual.status != ZstdStatus.Finished { return false }
  let mut index: usize = 0
  while index < expected.outputLength {
    if output[index] != data[expected.expectedOffset + index] { return false }
    index = index + 1
  }
  let empty: [u8; 0] = []
  let mut noOutput: [u8; 0] = []
  if !progress(Zstd.step(&mut decoder, &empty, &mut noOutput, true), 0, 0, ZstdStatus.Finished) { return false }
  let extra: [u8; 1] = [0]
  let terminal = Zstd.step(&mut decoder, &extra, &mut noOutput, true)
  return match move terminal {
    Result<ZstdProgress, ZstdError>.Success { value } => false
    Result<ZstdProgress, ZstdError>.Failure { error } => error.reason == ZstdReason.InvalidState && error.consumed == 0 && error.written == 0
  }
}
effect fn cases() -> i32 ! ZstdError | OutOfMemoryError ? &mut Allocator {
  let data = ${byteLiteral(packedCases)}
  let mut input = run buffer(${Math.max(...successes.map((v) => v.encoded.length), ...failures.map((v) => v.encoded.length))})
  let mut output = run buffer(${Math.max(8, ...successes.map((v) => v.decoded.length))})
  let mut offset: usize = 0
  let mut ordinal: i32 = 1
  while offset < data.length {
    let inputLength = wordAt(data, offset)
    let expected = Case { inputLength: inputLength, outputLength: wordAt(data, offset + 2),
      consumed: wordAt(data, offset + 4), written: wordAt(data, offset + 6), code: wordAt(data, offset + 8),
      expectedOffset: offset + 10 + inputLength }
    offset = offset + 10
    let mut index: usize = 0
    while index < inputLength {
      let filled = RawBuffer.fill(&mut input, index, 1, data[offset + index])
      index = index + 1
    }
    let mut decoder = run Zstd.make(limitsFor(expected.code))
    let mut outputLength = expected.outputLength
    if expected.code != 0 { outputLength = 8 }
    // Both buffers are sized for the longest case and zero-filled by \`buffer\`.
    unsafe {
      let result = Zstd.step(&mut decoder, RawBuffer.view<u8>(&input, 0, inputLength), RawBuffer.viewMut<u8>(&mut output, 0, outputLength), true)
      if !inspectCase(move result, &mut decoder, RawBuffer.view<u8>(&output, 0, outputLength), data, &expected) { return ordinal }
    }
    offset = offset + inputLength + expected.outputLength
    ordinal = ordinal + 1
  }
  return 42
}
fn sticky(decoder: &mut Zstd, first: ZstdError, reason: ZstdReason) -> bool {
  if first.reason != reason { return false }
  let empty: [u8; 0] = []
  let mut output: [u8; 1] = [77]
  let result = Zstd.step(&mut decoder, &empty, &mut output, true)
  return match move result {
    Result<ZstdProgress, ZstdError>.Success { value } => false
    Result<ZstdProgress, ZstdError>.Failure { error } => error.reason == first.reason && error.offset == first.offset && error.consumed == 0 && error.written == 0 && output[0] == 77
  }
}
effect fn streaming() -> bool ! ZstdError | OutOfMemoryError ? &mut Allocator {
  let mut decoder = run Zstd.make(configuration())
  let first: [u8; 2] = [40,181]
  let second: [u8; 10] = [47,253,32,3,25,0,0,97,98,99]
  let last: [u8; 10] = ${array(rle)}
  let empty: [u8; 0] = []
  let mut output: [u8; 1] = [0]
  let mut noOutput: [u8; 0] = []
  if !progress(Zstd.step(&mut decoder, &first, &mut output, false), 2, 0, ZstdStatus.NeedInput) { return false }
  if !progress(Zstd.step(&mut decoder, &second, &mut noOutput, false), 10, 0, ZstdStatus.NeedOutput) { return false }
  if !progress(Zstd.step(&mut decoder, &last, &mut output, true), 0, 1, ZstdStatus.NeedOutput) || output[0] != 97 { return false }
  if !progress(Zstd.step(&mut decoder, &last, &mut output, true), 0, 1, ZstdStatus.NeedOutput) || output[0] != 98 { return false }
  if !progress(Zstd.step(&mut decoder, &last, &mut output, true), 10, 1, ZstdStatus.NeedOutput) || output[0] != 99 { return false }
  if !progress(Zstd.step(&mut decoder, &empty, &mut output, true), 0, 1, ZstdStatus.NeedOutput) || output[0] != 120 { return false }
  if !progress(Zstd.step(&mut decoder, &empty, &mut output, true), 0, 1, ZstdStatus.NeedOutput) || output[0] != 120 { return false }
  return progress(Zstd.step(&mut decoder, &empty, &mut output, true), 0, 1, ZstdStatus.Finished) && output[0] == 120
}
struct ChunkProgress {
  input: usize
  output: usize
  finished: bool
}
fn inspectChunk(result: Result<ZstdProgress, ZstdError>, output: &[u8], expected: &[u8], state: &mut ChunkProgress, chunkLength: usize, finalInput: bool) -> bool {
  return match move result {
    Result<ZstdProgress, ZstdError>.Success { value } => inspectProgress(move value, output, expected, &mut state, chunkLength, finalInput)
    Result<ZstdProgress, ZstdError>.Failure { error } => false
  }
}
fn inspectProgress(value: ZstdProgress, output: &[u8], expected: &[u8], state: &mut ChunkProgress, chunkLength: usize, finalInput: bool) -> bool {
  if value.consumed > chunkLength || value.written > output.length || value.written > expected.length - state.output { return false }
  let mut index: usize = 0
  while index < value.written {
    if output[index] != expected[state.output + index] { return false }
    index = index + 1
  }
  state.input = state.input + value.consumed
  state.output = state.output + value.written
  if value.status == ZstdStatus.Finished {
    state.finished = true
    return finalInput && value.consumed == chunkLength && state.output == expected.length
  }
  if value.status == ZstdStatus.NeedInput { return !finalInput && value.consumed == chunkLength }
  return value.written == output.length
}
effect fn chunked(input: &[u8], expected: &[u8]) -> bool ! ZstdError | OutOfMemoryError ? &mut Allocator {
  let mut decoder = run Zstd.make(configuration())
  let allocation = run Allocator.allocate(Layout { bytes: 3, alignment: 1 })
  // The allocation was requested for three bytes with byte alignment, and each view covers only
  // the \`length <= 3\` bytes the loop just wrote.
  unsafe {
    let mut chunk = RawBuffer.from<u8>(move allocation, 3)
    let mut output: [u8; 7] = [0,0,0,0,0,0,0]
    let mut state = ChunkProgress { input: 0, output: 0, finished: false }
    while !state.finished {
      let mut length = input.length - state.input
      if length > 3 { length = 3 }
      let mut index: usize = 0
      while index < length {
        let filled = RawBuffer.fill(&mut chunk, index, 1, input[state.input + index])
        index = index + 1
      }
      let finalInput = state.input + length == input.length
      let result = Zstd.step(&mut decoder, RawBuffer.view<u8>(&chunk, 0, length), &mut output, finalInput)
      if !inspectChunk(move result, &output, expected, &mut state, length, finalInput) { return false }
    }
    return state.input == input.length
  }
}
effect fn boundary() -> bool ! ZstdError | OutOfMemoryError ? &mut Allocator {
  let mut decoder = run Zstd.make(configuration())
  let input: [u8; 12] = ${array(raw)}
  let empty: [u8; 0] = []
  let mut output: [u8; 3] = [0,0,0]
  if !progress(Zstd.step(&mut decoder, &input, &mut output, false), 12, 3, ZstdStatus.NeedInput) { return false }
  return progress(Zstd.step(&mut decoder, &empty, &mut output, true), 0, 0, ZstdStatus.Finished)
}
effect fn invalidConfiguration(limits: ZstdLimits, reason: ZstdReason) -> bool ? &mut Allocator {
  let result = run Effect.result(Zstd.make(move limits))
  return match move result {
    Result<Zstd, ZstdError | OutOfMemoryError>.Success { value } => false
    Result<Zstd, ZstdError | OutOfMemoryError>.Failure { error } => match move error {
      ZstdError failure => failure.reason == reason && failure.consumed == 0 && failure.written == 0 && failure.offset == 0
      OutOfMemoryError failure => false
    }
  }
}
effect fn program() -> i32 ! ZstdError | OutOfMemoryError ? &mut Allocator {
  let result = run cases()
  if result != 42 { return result }
  if !run chunked(${byteLiteral(entropy.encoded)}, ${byteLiteral(entropy.decoded)}) { return 59 }
  if !run streaming() { return 60 }
  if !run boundary() { return 61 }
  let mut workspace = configuration()
  workspace.workspaceBytes = 1
  if !run invalidConfiguration(move workspace, ZstdReason.WorkspaceLimit) { return 62 }
  let mut window = configuration()
  window.windowBytes = 0
  if !run invalidConfiguration(move window, ZstdReason.InvalidConfiguration) { return 63 }
  return 42
}
effect fn recover(error: ZstdError | OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(program(), recover) |> Effect.provideMut<Allocator>(&mut allocator)
}
`
