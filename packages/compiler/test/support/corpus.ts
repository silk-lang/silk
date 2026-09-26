import type * as RuntimeComponent from '../../src/RuntimeComponent.js'
import { aesGcmAcceptanceSource } from './aesGcmAcceptance.js'
import { borrowedTemporaryStream, borrowedTemporaryLifecycle } from './borrowedTemporaries.js'
import { partialSuspension } from './partialSuspension.js'
import { rsaNativeSource, rsaWasmSource } from './rsaAcceptance.js'
import { x25519AcceptanceSource } from './x25519Acceptance.js'
/**
 * The shared native acceptance corpus: programs with independently pinned process outcomes.
 */
import { readFileSync } from 'node:fs'
import { floatMathPrograms } from './floatMath.js'
import { checkedConversionPrograms } from './checkedConversions.js'
import { renameIndependentPolicy } from './independentPolicyRename.js'
import {
  auditAllocatorSuspension,
  mixedServiceProviderSuspension,
  ownedAllocatorSuspensionFailure,
  ownedAllocatorSuspensionSuccess,
  ownedProviderSuspendedFailure,
  ownedProviderSuspendedSuccess,
} from './ownedAllocatorSuspension.js'
import { recoveredProvidedWrite, recoveredWriterModule } from './recoveredProvidedWrite.js'
import { floatOperationMatrix, integerOperationMatrix } from './scalarOperationMatrix.js'
import { shaAcceptanceSource } from './shaAcceptance.js'
import {
  chacha20Poly1305WasmSource,
  chacha20Poly1305NativeSource,
} from './chacha20Poly1305Acceptance.js'
import { hmacHkdfAcceptanceSource } from './hmacHkdfAcceptance.js'
import { tlsHkdfAcceptanceSource } from './tlsHkdfAcceptance.js'
import {
  tlsRecordAcceptanceSource,
  tlsRecordNativeAcceptanceSource,
} from './tlsRecordAcceptance.js'
import {
  tlsClientClosureControlNativeSource,
  tlsClientCoreNativeSource,
  tlsClientDemandRequestNativeSource,
  tlsClientHandshakePolicyNativeSource,
  tlsClientKeyUpdateNativeSource,
  tlsClientNativeFixtureSource,
  tlsClientNativeOnlySource,
  tlsClientResourcePolicyNativeSource,
  tlsClientWasmSource,
} from './tlsClientAcceptance.js'
import { byteDuplexAcceptanceSource } from './byteDuplexAcceptance.js'
import { bufferedByteIoAcceptanceSource } from './bufferedByteIoAcceptance.js'
import { tlsConnectionAcceptanceSource } from './tlsConnectionAcceptance.js'
import { zstdAcceptanceSource } from './zstdAcceptance.js'
import { inflateAcceptanceSource } from './inflateAcceptance.js'
import { uriAcceptanceSource } from './uriAcceptance.js'
import { httpValuesAcceptanceSource } from './httpValuesAcceptance.js'
import { httpHeadAcceptanceSource } from './httpHeadAcceptance.js'
import { httpBodyAcceptanceSource } from './httpBodyAcceptance.js'
import { httpContentAcceptanceSource } from './httpContentAcceptance.js'
import { httpServerAcceptanceSource } from './httpServerAcceptance.js'
import { websocketUpgradeAcceptanceSource } from './websocketUpgradeAcceptance.js'
import { base64AcceptanceSource } from './base64Acceptance.js'
import { jsonScannerAcceptanceSource } from './jsonScannerAcceptance.js'
import { tomlScannerAcceptanceSource } from './tomlScannerAcceptance.js'
import { tomlValueAcceptanceSource } from './tomlValueAcceptance.js'
import { tomlOutputAcceptanceSource } from './tomlOutputAcceptance.js'
import { utf8DecoderAcceptanceSource } from './utf8DecoderAcceptance.js'
import { jsonReaderAcceptanceSource } from './jsonReaderAcceptance.js'
import { jsonReflectAcceptanceSource } from './jsonReflectAcceptance.js'
import { jsonValueAcceptanceSource } from './jsonValueAcceptance.js'
import { jsonCodecAcceptanceSource } from './jsonCodecAcceptance.js'
import { httpRequestAcceptanceSource } from './httpRequestAcceptance.js'
import { httpClientOwnershipAcceptanceSource } from './httpClientOwnershipAcceptance.js'
import {
  httpClientAcceptanceSource,
  httpClientBoundariesAcceptanceSource,
  httpClientOutputFailuresAcceptanceSource,
  httpRedirectAcceptanceSource,
} from './httpClientAcceptance.js'
import { httpClientContentAcceptanceSource } from './httpClientContentAcceptance.js'
import { httpTransportAcceptanceSource } from './httpTransportAcceptance.js'
import { networkAddressResolutionCorpusProgram } from './networkAddressResolutionAcceptance.js'
import { nativeListenerCorpusProgram } from './nativeListenerAcceptance.js'
import { nativeSocketCorpusProgram } from './nativeSocketAcceptance.js'
import { ecdsaP256AcceptanceSource } from './ecdsaP256Acceptance.js'
import { p256AcceptanceSource } from './p256Acceptance.js'
import { certificateAcceptanceSource } from './certificateAcceptance.js'
import { certificateProfileAcceptanceSource } from './certificateProfileAcceptance.js'
import { certificatePathAcceptanceSource } from './certificatePathAcceptance.js'
import { trustSourceAcceptanceSource } from './trustSourceAcceptance.js'
import { httpsIdentityAcceptanceSource } from './httpsIdentityAcceptance.js'
import { sanAcceptanceSource } from './sanAcceptance.js'
import {
  borrowedBox,
  borrowedStream,
  borrowedFailure,
  affineBorrowedStream,
} from './borrowedOutcomes.js'
import { storedCatchSuspension } from './storedCatchSuspension.js'

// Folded from Transcendental.test.ts: every runtime bit pattern is committed independently of the
// compiler implementation. `referenceBits` records the high-precision oracle; `acceptedBits`
// records an explicitly reviewed result within the four-ulp language tolerance when they differ.
interface TranscendentalVector {
  readonly width: 32 | 64
  readonly inputBits: string
  readonly operation: 'Sin' | 'Cos'
  readonly referenceBits: string
  readonly acceptedBits?: string
}

const transcendentalFixture = JSON.parse(
  readFileSync(new URL('../fixtures/transcendental-vectors.json', import.meta.url), 'utf8'),
) as { readonly vectors: ReadonlyArray<TranscendentalVector> }

const transcendentalVectors: ReadonlyArray<TranscendentalVector> = [
  ...transcendentalFixture.vectors,
  { width: 32, inputBits: '0x00000000', operation: 'Sin', referenceBits: '0x00000000' },
  { width: 32, inputBits: '0x80000000', operation: 'Sin', referenceBits: '0x80000000' },
  { width: 32, inputBits: '0x00000000', operation: 'Cos', referenceBits: '0x3f800000' },
  { width: 32, inputBits: '0x7f800000', operation: 'Sin', referenceBits: '0x7fc00000' },
  { width: 32, inputBits: '0xff800000', operation: 'Cos', referenceBits: '0x7fc00000' },
  { width: 32, inputBits: '0x7fc12345', operation: 'Sin', referenceBits: '0x7fc00000' },
  {
    width: 64,
    inputBits: '0x0000000000000000',
    operation: 'Sin',
    referenceBits: '0x0000000000000000',
  },
  {
    width: 64,
    inputBits: '0x8000000000000000',
    operation: 'Sin',
    referenceBits: '0x8000000000000000',
  },
  {
    width: 64,
    inputBits: '0x0000000000000000',
    operation: 'Cos',
    referenceBits: '0x3ff0000000000000',
  },
  {
    width: 64,
    inputBits: '0x7ff0000000000000',
    operation: 'Sin',
    referenceBits: '0x7ff8000000000000',
  },
  {
    width: 64,
    inputBits: '0xfff0000000000000',
    operation: 'Cos',
    referenceBits: '0x7ff8000000000000',
  },
  {
    width: 64,
    inputBits: '0x7ff8123456789abc',
    operation: 'Sin',
    referenceBits: '0x7ff8000000000000',
  },
]

const localSchedulerImplementation = readFileSync(
  new URL('../../stdlib/silk/local_scheduler.silk', import.meta.url),
  'utf8',
)

const sourceSection = (source: string, start: string, end: string): string => {
  const startOffset = source.indexOf(start)
  const endOffset = source.indexOf(end, startOffset)
  if (startOffset < 0 || endOffset < 0)
    throw new Error(`Cannot find test source section from ${start} to ${end}`)
  return source.slice(startOffset, endOffset)
}

const tlsHkdfSource = readFileSync(
  new URL('../../stdlib/silk/tls_hkdf.silk', import.meta.url),
  'utf8',
)
const tlsHkdfNativeSource = tlsHkdfAcceptanceSource
  .replace(
    'import silk.tls_hkdf',
    `import silk.u64
${sourceSection(tlsHkdfSource, 'fn sha256MessageLengthAdmitted(', 'fn validate(')}
import silk.tls_hkdf`,
  )
  .replace(
    '  return 42\n}',
    `  if !sha256MessageLengthAdmitted(2305843009213693951) { return 21 }
  if sha256MessageLengthAdmitted(2305843009213693952) { return 22 }
  if sha256MessageLengthAdmitted(u64.MAX) { return 23 }
  return 42
}`,
  )

const tlsRecordSource = readFileSync(
  new URL('../../stdlib/silk/tls_record.silk', import.meta.url),
  'utf8',
)
const tlsRecordNativeSource = tlsRecordNativeAcceptanceSource(tlsRecordSource)

const sha2Source = readFileSync(new URL('../../stdlib/silk/sha2.silk', import.meta.url), 'utf8')

const sha2LengthTestSource = `import silk.u64

${sourceSection(sha2Source, 'struct Length64Transition {', 'fn makeState32')}

fn __testLength64Transition() -> bool {
  let carry = length64Transition(7, u64.MAX - 7, 1)
  if carry.overflow || carry.high != 8 || carry.low != 0 { return false }

  let highEdge = length64Transition(u64.MAX - 7, 0, u64.MAX)
  if highEdge.overflow || highEdge.high != u64.MAX || highEdge.low != u64.MAX - 7 {
    return false
  }

  let directOverflow = length64Transition(u64.MAX - 6, 0, u64.MAX)
  let carryOverflow = length64Transition(u64.MAX, u64.MAX - 7, 1)
  return directOverflow.overflow && carryOverflow.overflow
}`

const shaAcceptanceNativeSource = shaAcceptanceSource
  .replace('import silk.sha1', `${sha2LengthTestSource}\n\nimport silk.sha1`)
  .replace(
    '  return 42\n}',
    '  if __testLength64Transition() == false { return 102 }\n  return 42\n}',
  )

/** Canonical-bits transcendental program with independently committed native expectations. */
export const transcendentalCanonicalBits = `import silk.f32
import silk.f64
pub fn main() -> i32 {
${transcendentalVectors
  .map((vector, index) => {
    const inputBits = BigInt(vector.inputBits)
    const expectedBits = BigInt(vector.acceptedBits ?? vector.referenceBits)
    return `  if f${vector.width}.toBits(f${vector.width}.${vector.operation.toLowerCase()}(f${vector.width}.fromBits(${inputBits.toString()}))) != ${expectedBits.toString()} { return ${index + 1} }`
  })
  .join('\n')}
  return 42
}`

/** Process invocations that share one compiled corpus artifact and its expected outcome. */
export interface NativeRun {
  readonly arguments?: ReadonlyArray<string>
  readonly closeStderr?: boolean
}

/** Native compilation profiles required to distinguish one corpus program's contract. */
export interface NativeProfile {
  readonly name: string
  readonly optimization: 'none' | 'speed'
  readonly debug: boolean
}

export interface CorpusProgram {
  readonly name: string
  readonly source: string
  readonly nativeSource?: string
  readonly nativeImports?: Readonly<Record<string, string>>
  readonly nativeComponents?: ReadonlyArray<RuntimeComponent.Input>
  /** C translation units compiled with `compileCObject` and linked as structured object inputs. */
  readonly nativeCSources?: Readonly<Record<string, string>>
  readonly nativeDynamicLibraries?: ReadonlyArray<string>
  readonly nativeStdout?: string
  readonly nativeStderr?: string
  readonly nativeRuns?: ReadonlyArray<NativeRun>
  readonly nativeProfiles?: ReadonlyArray<NativeProfile>
  readonly expected:
    | { readonly _tag: 'Completes'; readonly result: number }
    | { readonly _tag: 'Trap' }
}

export interface InvalidCorpusProgram {
  readonly name: string
  readonly source: string
  readonly codes: ReadonlyArray<string>
}

export const scalarEnumSignedAcceptance = `import silk.i8
enum(i8) Status {
  Unknown = -1,
  Ready = 7,
}
fn copyStatus(value: Status) -> Status {
  let copied = value
  if copied != Status.Ready { return copied }
  return Status.Unknown
}
pub fn main() -> i32 {
  let status = copyStatus(Status.Unknown)
  let raw = Status.value(status)
  if status == Status.Ready { return 1 }
  return match status {
    Status.Unknown => i8.toI32(raw) + 43
    Status.Ready => 2
  }
}`

export const scalarEnumLaneAcceptance = `enum(i8) SignedFlag {
  Negative = -1,
  Positive = 1,
}
enum(u8) ByteFlag {
  Low = 1,
  High = 255,
}
enum(i64) WideCode {
  Selected = 4294967297,
  Other = 9,
}
struct StoredFlags {
  signed: SignedFlag
  unsigned: ByteFlag
}
fn wideIdentity(value: WideCode) -> WideCode { return value }
fn inspect(flags: &StoredFlags) -> i32 {
  if flags.signed != SignedFlag.Negative { return 1 }
  if flags.unsigned != ByteFlag.High { return 2 }
  let selected = wideIdentity(WideCode.Selected)
  if WideCode.value(selected) != 4294967297 { return 3 }
  return match selected {
    WideCode.Selected => 42
    WideCode.Other => 4
  }
}
pub fn main() -> i32 {
  let flags = StoredFlags { signed: SignedFlag.Negative, unsigned: ByteFlag.High }
  return inspect(&flags)
}`

/** A generic Display call selects the interface-owned inline i32 witness in native execution. */
export const scalarDisplayAcceptance = `import silk.effect { Effect }
import silk.format { Format }
import silk.u8
import silk.usize
import silk.writer { Writer, WriterError }

struct Capture { index: usize valid: bool }

effect fn writeAll(self: &mut Capture, bytes: &[u8]) -> () {
  let mut offset = usize.ZERO
  while offset < bytes.length {
    let mut expected = u8.toU8(50)
    if self.index == usize.ZERO { expected = u8.toU8(45) }
    if self.index == usize.ONE { expected = u8.toU8(52) }
    if bytes[offset] != expected { self.valid = false }
    self.index = self.index + usize.ONE
    offset = offset + usize.ONE
  }
  return ()
}

effect fn flush(self: &mut Capture) -> () { return () }

impl Writer for Capture {
  writeAll: Capture.writeAll
  flush: Capture.flush
}

effect fn render() -> i32 ! WriterError {
  let mut capture = Capture { index: usize.ZERO, valid: true }
  let value = -42
  run Format.display<i32>(&value) |> Effect.provideMut<Writer>(&mut capture)
  if !capture.valid { return 1 }
  if capture.index != 3 { return 2 }
  return 42
}

effect fn recover(error: WriterError) -> i32 { return 3 }

pub fn main() -> i32 {
  return run Effect.catchAll(render(), recover)
}`

/** Static template parsing and reflection erase before the shared engine differential. */
export const templateFormattingAcceptance = `import silk.effect { Effect }
import silk.format { Format }
import silk.u8
import silk.usize
import silk.writer { Writer, WriterError }

struct Capture { index: usize valid: bool }
struct Person { pub name: string pub age: i32 }

effect fn writeAll(self: &mut Capture, bytes: &[u8]) -> () {
  let expected = [
    u8.toU8(65), u8.toU8(58), u8.toU8(51), u8.toU8(49), u8.toU8(124),
    u8.toU8(74), u8.toU8(58), u8.toU8(74), u8.toU8(124),
    u8.toU8(123), u8.toU8(110), u8.toU8(97), u8.toU8(109), u8.toU8(101),
    u8.toU8(125), u8.toU8(124), u8.toU8(77), u8.toU8(58), u8.toU8(50),
    u8.toU8(56)
  ]
  let mut offset = usize.ZERO
  while offset < bytes.length {
    if 20 <= self.index || bytes[offset] != expected[self.index] { self.valid = false }
    self.index = self.index + usize.ONE
    offset = offset + usize.ONE
  }
  return ()
}

effect fn flush(self: &mut Capture) -> () { return () }

impl Writer for Capture {
  writeAll: Capture.writeAll
  flush: Capture.flush
}

effect fn render() -> i32 ! WriterError {
  let mut capture = Capture { index: usize.ZERO, valid: true }
  run Format.format("{}:{}", &("A", 31)) |> Effect.provideMut<Writer>(&mut capture)
  run Writer.writeAll(b"|") |> Effect.provideMut<Writer>(&mut capture)
  run Format.format("{name}:{name}", &.{ name: "J" })
    |> Effect.provideMut<Writer>(&mut capture)
  run Writer.writeAll(b"|") |> Effect.provideMut<Writer>(&mut capture)
  run Format.format("{{name}}", &.{ name: "unused" })
    |> Effect.provideMut<Writer>(&mut capture)
  run Writer.writeAll(b"|") |> Effect.provideMut<Writer>(&mut capture)
  let person = Person { name: "M", age: 28 }
  run Format.format("{name}:{age}", &person) |> Effect.provideMut<Writer>(&mut capture)
  if !capture.valid { return 1 }
  if capture.index != 20 { return 2 }
  return 42
}

effect fn recover(error: WriterError) -> i32 { return 3 }

pub fn main() -> i32 {
  return run Effect.catchAll(render(), recover)
}`

/** Formatting options are observed through the real native stdout boundary. */
export const formatOptionsAcceptance = `import silk.os_writer { StdoutWriter }
import silk.effect { Effect }
import silk.format { Alignment, Format, FormatOptions, Sign }
import silk.option { Option }
import silk.usize
import silk.writer { Writer, WriterError }

fn options(
  width: usize,
  alignment: Alignment,
  fill: char,
  sign: Sign,
  zeroPad: bool,
  precision: Option<usize>,
) -> FormatOptions {
  return FormatOptions {
    width: Option.some<usize>(width), alignment: alignment, fill: fill, sign: sign,
    alternate: true, zeroPad: zeroPad, precision: move precision, color: true,
  }
}

fn accessorsHold() -> bool {
  let defaults = Format.makeDefault()
  if Format.hasWidth(&defaults) { return false }
  if Format.width(&defaults) != usize.ZERO { return false }
  if Format.alignment(&defaults) != Alignment.Default { return false }
  if Format.fill(&defaults) != ' ' { return false }
  if Format.sign(&defaults) != Sign.NegativeOnly { return false }
  if Format.alternate(&defaults) { return false }
  if Format.zeroPad(&defaults) { return false }
  if Format.hasPrecision(&defaults) { return false }
  if Format.precision(&defaults) != usize.ZERO { return false }
  if Format.color(&defaults) { return false }
  let explicit = Format.make(
    options(12, Alignment.Left, '*', Sign.Space, true, Option.some<usize>(9)),
  )
  if !Format.hasWidth(&explicit) { return false }
  if Format.width(&explicit) != 12 { return false }
  if Format.alignment(&explicit) != Alignment.Left { return false }
  if Format.fill(&explicit) != '*' { return false }
  if Format.sign(&explicit) != Sign.Space { return false }
  if !Format.alternate(&explicit) { return false }
  if !Format.zeroPad(&explicit) { return false }
  if !Format.hasPrecision(&explicit) { return false }
  if Format.precision(&explicit) != 9 { return false }
  return Format.color(&explicit)
}

effect fn render() -> () ! WriterError ? &mut Writer {
  let negative = 0 - 42
  run Format.displayWith(
    &negative,
    options(8, Alignment.Right, '*', Sign.NegativeOnly, false, Option.some<usize>(4)),
  )
  run Writer.writeAll(b"|")
  let positive = 42
  run Format.displayWith(
    &positive,
    options(6, Alignment.Left, '.', Sign.Always, false, Option.none<usize>()),
  )
  run Writer.writeAll(b"|")
  let zero = 0
  run Format.displayWith(
    &zero,
    options(7, Alignment.Center, '\u{e9}', Sign.NegativeOnly, false, Option.some<usize>(3)),
  )
  run Writer.writeAll(b"|")
  run Format.displayWith(
    &negative,
    options(7, Alignment.Default, ' ', Sign.NegativeOnly, true, Option.none<usize>()),
  )
  run Writer.writeAll(b"|")
  let seven = 0 - 7
  run Format.displayWith(
    &seven,
    options(5, Alignment.Center, '\u{b7}', Sign.NegativeOnly, false, Option.none<usize>()),
  )
  run Writer.writeAll(b"|")
  return run Format.displayWith(
    &positive,
    options(35, Alignment.Right, '_', Sign.NegativeOnly, false, Option.none<usize>()),
  )
}

effect fn build() -> i32 ! WriterError {
  if !accessorsHold() { return 2 }
  let mut writer = StdoutWriter.make()
  run render() |> Effect.provideMut<Writer>(&mut writer)
  return 42
}
effect fn recover(error: WriterError) -> i32 { return 1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`

/**
 * Float presentation is checked through the real Writer boundary: fixed precision against pinned
 * bytes, and the default shortest form against the parser it must round-trip through. Every
 * failure returns its own code so a native run names the case.
 */
export const floatFormattingAcceptance = `import silk.effect { Effect }
import silk.f32
import silk.f64
import silk.format { Alignment, Format, FormatOptions, ParseError, Sign }
import silk.option { Option }
import silk.result { Result }
import silk.slice { Slice }
import silk.string { String, InvalidUtf8 }
import silk.u32
import silk.u64
import silk.usize
import silk.writer { Writer, WriterError }

struct Capture { bytes: [u8; 64] count: usize }

effect fn writeAll(self: &mut Capture, bytes: &[u8]) -> () {
  let mut offset = usize.ZERO
  while offset < bytes.length {
    if self.count < 64 {
      self.bytes[self.count] = bytes[offset]
      self.count = self.count + usize.ONE
    }
    offset = offset + usize.ONE
  }
  return ()
}
effect fn flush(self: &mut Capture) -> () { return () }
impl Writer for Capture { writeAll: Capture.writeAll flush: Capture.flush }

fn capture() -> Capture {
  return Capture { bytes: [
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  ], count: usize.ZERO }
}

fn fixed(precision: usize) -> FormatOptions {
  return FormatOptions {
    width: Option.none<usize>(), alignment: Alignment.Default, fill: ' ',
    sign: Sign.NegativeOnly, alternate: false, zeroPad: false,
    precision: Option.some<usize>(precision), color: false,
  }
}

fn padded(width: usize, alignment: Alignment, fill: char, sign: Sign, precision: Option<usize>)
  -> FormatOptions {
  return FormatOptions {
    width: Option.some<usize>(width), alignment: alignment, fill: fill, sign: sign,
    alternate: false, zeroPad: true, precision: move precision, color: false,
  }
}

fn matches(self: &Capture, expected: &[u8]) -> bool {
  if self.count != expected.length { return false }
  let mut index = usize.ZERO
  while index < self.count {
    if self.bytes[index] != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

effect fn rendersF64(value: f64, options: FormatOptions, expected: &[u8]) -> bool ! WriterError {
  let mut capture = capture()
  run Format.displayWith(&value, move options) |> Effect.provideMut<Writer>(&mut capture)
  return matches(&capture, expected)
}

effect fn rendersF32(value: f32, options: FormatOptions, expected: &[u8]) -> bool ! WriterError {
  let mut capture = capture()
  run Format.displayWith(&value, move options) |> Effect.provideMut<Writer>(&mut capture)
  return matches(&capture, expected)
}

// The default presentation must land on bits identical to its input, which is the round-trip
// guarantee itself rather than a pinned spelling.
effect fn roundTrips(bits: u64) -> bool ! WriterError {
  let value = f64.fromBits(bits)
  let mut capture = capture()
  run Format.display(&value) |> Effect.provideMut<Writer>(&mut capture)
  let bytes = Slice.view<u8>(&capture.bytes, usize.ZERO, capture.count)
  return match move String.fromUtf8(bytes) {
    Result<string, InvalidUtf8>.Failure { error: _ } => false
    Result<string, InvalidUtf8>.Success { value: text } => match move Format.f64Value(text) {
      Result<f64, ParseError>.Failure { error: _ } => false
      Result<f64, ParseError>.Success { value: parsed } => f64.toBits(parsed) == bits
    }
  }
}

effect fn roundTripsF32(bits: u32) -> bool ! WriterError {
  let value = f32.fromBits(bits)
  let mut capture = capture()
  run Format.display(&value) |> Effect.provideMut<Writer>(&mut capture)
  let bytes = Slice.view<u8>(&capture.bytes, usize.ZERO, capture.count)
  return match move String.fromUtf8(bytes) {
    Result<string, InvalidUtf8>.Failure { error: _ } => false
    Result<string, InvalidUtf8>.Success { value: text } => match move Format.f32Value(text) {
      Result<f32, ParseError>.Failure { error: _ } => false
      Result<f32, ParseError>.Success { value: parsed } => f32.toBits(parsed) == bits
    }
  }
}

effect fn check() -> i32 ! WriterError {
  // Fixed precision truncates to the requested fractional digits and pads short expansions.
  if !(run rendersF64(1.5, fixed(2), b"1.50")) { return 1 }
  if !(run rendersF64(0.125, fixed(2), b"0.12")) { return 2 }
  if !(run rendersF64(0.375, fixed(2), b"0.38")) { return 3 }
  // Ties land on the even retained digit in both directions.
  if !(run rendersF64(0.5, fixed(0), b"0")) { return 4 }
  if !(run rendersF64(1.5, fixed(0), b"2")) { return 5 }
  if !(run rendersF64(2.5, fixed(0), b"2")) { return 6 }
  if !(run rendersF64(3.5, fixed(0), b"4")) { return 7 }
  // A carry that escapes every retained digit widens the integer part.
  if !(run rendersF64(9.99, fixed(1), b"10.0")) { return 8 }
  if !(run rendersF64(0.99, fixed(1), b"1.0")) { return 9 }
  // Values below the retained window round to zero, or up to one final unit.
  if !(run rendersF64(0.0001, fixed(2), b"0.00")) { return 10 }
  if !(run rendersF64(0.6, fixed(0), b"1")) { return 11 }
  // 0.1 has no finite binary expansion; its exact decimal tail decides the last digit.
  if !(run rendersF64(0.1, fixed(20), b"0.10000000000000000555")) { return 12 }
  // Zero keeps its sign and still fills every requested place.
  if !(run rendersF64(0.0, fixed(3), b"0.000")) { return 13 }
  if !(run rendersF64(f64.fromBits(9223372036854775808), fixed(3), b"-0.000")) { return 14 }
  if !(run rendersF64(f64.fromBits(9223372036854775808), fixed(0), b"-0")) { return 15 }
  // Default output preserves signed zero without a fractional part.
  if !(run rendersF64(f64.fromBits(9223372036854775808),
    padded(0, Alignment.Default, ' ', Sign.NegativeOnly, Option.none<usize>()), b"-0")) { return 16 }
  // Special values ignore precision and keep only the sign policy.
  if !(run rendersF64(f64.fromBits(9218868437227405312), fixed(4), b"Infinity")) { return 17 }
  if !(run rendersF64(f64.fromBits(18442240474082181120), fixed(4), b"-Infinity")) { return 18 }
  if !(run rendersF64(f64.fromBits(9221120237041090560), fixed(4), b"NaN")) { return 19 }
  // Sign policy and width apply to the fixed form; float padding uses the fill, not zeroes.
  if !(run rendersF64(1.25,
    padded(8, Alignment.Right, '*', Sign.Always, Option.some<usize>(1)), b"****+1.2")) { return 20 }
  if !(run rendersF64(0.0 - 1.25,
    padded(8, Alignment.Left, '.', Sign.NegativeOnly, Option.some<usize>(3)), b"-1.250..")) { return 21 }
  if !(run rendersF64(1.0,
    padded(7, Alignment.Center, '-', Sign.Space, Option.some<usize>(1)), b"- 1.0--")) { return 22 }
  // f32 rounds its own exact expansion, which differs from the f64 nearest to the same literal.
  if !(run rendersF32(f32.fromBits(1), fixed(3), b"0.000")) { return 23 }
  if !(run rendersF32(0.1, fixed(10), b"0.1000000015")) { return 24 }
  // Default output round-trips across subnormals, boundaries, halfway patterns, and a sweep.
  if !(run roundTrips(0)) { return 25 }
  if !(run roundTrips(1)) { return 26 }
  if !(run roundTrips(4503599627370495)) { return 27 }
  if !(run roundTrips(4503599627370496)) { return 28 }
  if !(run roundTrips(9218868437227405311)) { return 29 }
  if !(run roundTrips(4607182418800017408)) { return 30 }
  if !(run roundTripsF32(1)) { return 31 }
  if !(run roundTripsF32(8388607)) { return 32 }
  if !(run roundTripsF32(8388608)) { return 33 }
  if !(run roundTripsF32(2139095039)) { return 34 }
  let mut state = u64.toU64(88172645463325252)
  let mut trial = usize.ZERO
  while trial < 128 {
    state = u64.bitXor(state, u64.shiftLeft(state, 13))
    state = u64.bitXor(state, u64.shiftRight(state, 7))
    state = u64.bitXor(state, u64.shiftLeft(state, 17))
    let candidate = u64.bitAnd(state, 9218868437227405311)
    if !(run roundTrips(candidate)) { return 35 }
    trial = trial + usize.ONE
  }
  return 42
}

effect fn recover(error: WriterError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(check(), recover) }`

/** Closed Effect values survive ordinary passing, storage, capture, return, and specialization. */
export const effectHigherOrderValues = `effect fn succeed(value: i32) -> i32 { return value }
effect fn alternate(value: i32) -> i32 { return value }
fn pass<'env>(self: once Effect<'env; i32>) -> once Effect<'env; i32> { return move self }
fn specialize<'env, A, E, ?R>(self: once Effect<'env; A ! E ? R>) -> once Effect<'env; A ! E ? R> {
  return move self
}
fn wrap<'env>(self: once Effect<'env; i32>) -> once Effect<'env; i32> {
  return effect { return run move self }
}
pub fn main() -> i32 {
  let stored = specialize(pass(succeed(20)))
  let distinct = pass(alternate(0))
  let captured = wrap(succeed(22))
  return (run stored) + (run distinct) + (run captured)
}`

/** Explicit referent projection preserves runtime-indexed reads and writes in native execution. */
export const referenceProjectionAcceptance = `import silk.usize

struct Empty {}
impl Copy for Empty {}
struct Buffer { values: [i32; 3] }
struct Box { value: i32 }

fn readEmpty(value: &Empty) -> Empty { return value.* }

fn update(buffer: &mut Buffer, index: usize) -> i32 {
  buffer.*.values[index] = 42
  return buffer.*.values[index]
}
fn increment(box: &mut Box) -> () { box.value = box.value + 1 }
fn observe(box: &Box) -> i32 { return box.value }
fn read(value: &i32) -> i32 { return value.* }
fn forwarded(value: &i32) -> i32 { return read(&value.*) }
fn twice(box: &mut Box) -> i32 {
  increment(&mut box)
  increment(&mut box)
  return observe(&box) + forwarded(&box.value)
}

pub fn main() -> i32 {
  let empty = Empty {}
  let copied = readEmpty(&empty)
  drop copied
  let mut buffer = Buffer { values: [1, 2, 3] }
  if update(&mut buffer, usize.ONE) != 42 { return 1 }
  let mut box = Box { value: 20 }
  if twice(&mut box) != 44 { return 2 }
  if box.value != 22 { return 3 }
  return 42
}`

/** Statement-form `if let` keeps pattern bindings live on every native success branch. */
export const retainedIfLetMatchAcceptance = `import silk.option { Option }

fn inspect(taken: Option<i32>) -> i32 {
  if let Option<i32>.Some { value: i } = move taken {
    return i
  } else {
    return 0
  }
}

pub fn main() -> i32 {
  return inspect(Option<i32>.Some { value: 42 }) + inspect(Option<i32>.None)
}`

/** A top-level loop header must remain distinct from the LLVM function entry block. */
export const whileEntryBackedgeAcceptance = `import silk.option { Option }

pub fn main() -> i32 {
  while true {
    let taken = Option<i32>.None
    if let Option<i32>.Some { value: i } = move taken {
      if i == 0 { break }
    } else {
      break
    }
  }
  return 42
}`

/** Two independent roots resume in reverse suspension order without sharing a frame stack. */
export const independentExecutionNonLifo = readFileSync(
  new URL('../../conformance/execution-storage/non-lifo.silk', import.meta.url),
  'utf8',
)

export const independentExecutionIllegalDormantDrive = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
struct Empty {}
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored }
struct Guard { wake: Intrinsic.Wake }
fn register(wake: Intrinsic.Wake) -> Guard { return Guard { wake: move wake } }
effect fn body() -> i32 { run Execution.park(register) return 42 }
fn complete(owner: &mut Owner, result: i32) -> () { return () }
fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
fn ready(state: &()) -> () { return () }
effect fn driveOnce(execution: Intrinsic.Execution<i32>, owner: &mut Owner) -> () {
  return run Execution.drive(move execution, move owner, complete, suspend)
}
effect fn driveStored(selected: Empty | Stored, owner: &mut Owner) -> () {
  return match move selected {
    Empty {} => ()
    Stored { execution } => run driveOnce(move execution, move owner)
  }
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut owner = Owner { slot: Empty {} }
  let execution = run Execution.make(body(), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  run driveOnce(move execution, &mut owner)
  let selected = Intrinsic.replace(owner.slot, Empty {})
  run driveStored(move selected, &mut owner)
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

/** Attempts to drive a Dormant execution reentrantly while its fixed endpoint is being notified. */
export const independentExecutionIllegalNotifyingDrive = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.shared { Shared }
struct Empty {}
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard {
  Intrinsic.wake(move wake)
  return Guard {}
}
effect fn body() -> i32 {
  run Execution.park(register)
  return 42
}
fn install(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
fn take(owner: &mut Owner) -> Empty | Stored {
  return Intrinsic.replace(owner.slot, Empty {})
}
fn reentrantComplete(state: &mut (), result: i32) -> () { return () }
fn reentrantSuspend(state: &mut (), execution: Intrinsic.Execution<i32>) -> () {
  drop execution
  return ()
}
effect fn reenter(selected: Empty | Stored, state: &mut ()) -> () {
  return match move selected {
    Empty {} => ()
    Stored { execution } => run Execution.drive(
      move execution,
      move state,
      reentrantComplete,
      reentrantSuspend
    )
  }
}
fn ready(owner: &Shared<Owner>) -> () {
  let selected = Shared.withMut(owner, take)
  let mut state = ()
  run reenter(move selected, &mut state)
  return ()
}
fn complete(state: &mut (), result: i32) -> () { return () }
fn suspend(
  state: &mut (),
  execution: Intrinsic.Execution<i32>,
  owner: Shared<Owner>
) -> () {
  let installing = install(move execution)
  Shared.withMut(&owner, move installing)
  drop owner
  return ()
}
effect fn driveOnce<
  'env, 'state,
  S: once fn<'env>(&'state mut (), Intrinsic.Execution<i32>) -> () + Intrinsic.NonParking
>(
  execution: Intrinsic.Execution<i32>,
  state: &'state mut (),
  onSuspend: S
) -> () {
  return run Execution.drive(move execution, move state, complete, move onSuspend)
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let owner = run Shared.make<Owner>(Owner { slot: Empty {} })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let endpoint = Shared.clone(&owner)
  let suspensionOwner = Shared.clone(&owner)
  let onSuspend = suspend(move suspensionOwner)
  let execution = run Execution.make(body(), move endpoint, ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut state = ()
  run driveOnce(move execution, &mut state, move onSuspend)
  drop owner
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

const fatalCallbackSentinel = `fn callbackSentinel(value: i32) -> () {
  let zero = value - value
  let impossible = 1 / zero
  drop impossible
  return ()
}`

export const independentExecutionIllegalDormantDriveObservable =
  independentExecutionIllegalDormantDrive
    .replace(
      'struct Owner { slot: Empty | Stored }',
      'struct Owner { slot: Empty | Stored callbacks: i32 }',
    )
    .replace('Owner { slot: Empty {} }', 'Owner { slot: Empty {}, callbacks: 0 }')
    .replace(
      'fn complete(owner: &mut Owner, result: i32) -> () { return () }',
      `${fatalCallbackSentinel}
fn complete(owner: &mut Owner, result: i32) -> () { return callbackSentinel(result) }`,
    )
    .replace(
      'fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {',
      `fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  if owner.callbacks != 0 { callbackSentinel(1) }
  owner.callbacks = owner.callbacks + 1`,
    )

export const independentExecutionIllegalNotifyingDriveObservable =
  independentExecutionIllegalNotifyingDrive
    .replace(
      'fn reentrantComplete(state: &mut (), result: i32) -> () { return () }',
      `${fatalCallbackSentinel}
fn reentrantComplete(state: &mut (), result: i32) -> () { return callbackSentinel(result) }`,
    )
    .replace(
      'fn reentrantSuspend(state: &mut (), execution: Intrinsic.Execution<i32>) -> () {',
      `fn reentrantSuspend(state: &mut (), execution: Intrinsic.Execution<i32>) -> () {
  callbackSentinel(1)`,
    )

/** Builds a logical continuation frame so a configured private-stack limit can reject its push. */
export const independentExecutionStackExhaustion = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
struct State { completed: i32 }
effect fn count(value: i32) -> i32 {
  if value == 0 { return 42 }
  let next = run Effect.suspend(effect { return value - 1 })
  return run count(next)
}
effect fn body() -> i32 { return run count(10000) }
fn ready(state: &()) -> () { return () }
fn complete(state: &mut State, value: i32) -> () { state.completed = 1 return () }
fn suspend(state: &mut State, execution: Intrinsic.Execution<i32>) -> () {
  drop execution
  return ()
}
effect fn driveOnce(execution: Intrinsic.Execution<i32>, state: &mut State) -> () {
  return run Execution.drive(move execution, move state, complete, suspend)
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut state = State { completed: 0 }
  let execution = run Execution.make(body(), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  run driveOnce(move execution, &mut state)
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

export const independentExecutionStackExhaustionObservable =
  independentExecutionStackExhaustion.replace(
    'fn complete(state: &mut State, value: i32) -> () { state.completed = 1 return () }',
    `fn complete(state: &mut State, value: i32) -> () {
  let zero = value - value
  let impossible = 1 / zero
  drop impossible
  state.completed = 1
  return ()
}`,
  )

export const independentExecutionMultiplePackages = readFileSync(
  new URL('../../conformance/execution-storage/multiple-packages.silk', import.meta.url),
  'utf8',
)

export const independentExecutionLateCancelledWake = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.shared { Shared }
struct Empty {}
struct Waiting { wake: Intrinsic.Wake }
struct Mailbox { slot: Empty | Waiting }
struct Guard { mailbox: Shared<Mailbox> }
struct ReadyState { called: i32 }
fn install(mailbox: &mut Mailbox, wake: Intrinsic.Wake) -> () {
  let previous = Intrinsic.replace(mailbox.slot, Waiting { wake: move wake })
  drop previous
  return ()
}
fn register(wake: Intrinsic.Wake, mailbox: Shared<Mailbox>) -> Guard {
  let installing = install(move wake)
  Shared.withMut(&mailbox, move installing)
  return Guard { mailbox: move mailbox }
}
fn extract(mailbox: &mut Mailbox) -> Empty | Waiting {
  return Intrinsic.replace(mailbox.slot, Empty {})
}
effect fn body(mailbox: Shared<Mailbox>) -> i32 {
  let registration = register(move mailbox)
  run Execution.park(move registration)
  return 1
}
fn complete(state: &mut (), result: i32) -> () { return () }
fn cancel(state: &mut (), execution: Intrinsic.Execution<i32>) -> () {
  drop execution
  return ()
}
fn markReady(state: &mut ReadyState) -> () {
  state.called = 1
  return ()
}
fn ready(state: &Shared<ReadyState>) -> () {
  Shared.withMut(state, markReady)
  return ()
}
fn readReady(state: &mut ReadyState) -> i32 { return state.called }
effect fn driveOnce(execution: Intrinsic.Execution<i32>, state: &mut ()) -> () {
  return run Execution.drive(move execution, move state, complete, cancel)
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mailbox = run Shared.make<Mailbox>(Mailbox { slot: Empty {} })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let registrationMailbox = Shared.clone(&mailbox)
  let readyState = run Shared.make<ReadyState>(ReadyState { called: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let endpoint = Shared.clone(&readyState)
  let execution = run Execution.make(body(move registrationMailbox), move endpoint, ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut state = ()
  run driveOnce(move execution, &mut state)
  let selected = Shared.withMut(&mailbox, extract)
  drop mailbox
  let result = match move selected {
    Empty {} => 0
    Waiting { wake } => signalLate(move wake)
  }
  let called = Shared.withMut(&readyState, readReady)
  drop readyState
  return result + called * 1000
}
fn signalLate(wake: Intrinsic.Wake) -> i32 {
  Intrinsic.wake(move wake)
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

export const independentExecutionReentrantDestroy = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.shared { Shared }
struct Empty {}
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard {
  Intrinsic.wake(move wake)
  return Guard {}
}
effect fn body() -> i32 {
  run Execution.park(register)
  return 1
}
fn install(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
fn take(owner: &mut Owner) -> Empty | Stored {
  return Intrinsic.replace(owner.slot, Empty {})
}
fn ready(owner: &Shared<Owner>) -> () {
  let selected = Shared.withMut(owner, take)
  drop selected
  return ()
}
fn complete(state: &mut (), result: i32) -> () { return () }
fn suspend(
  state: &mut (),
  execution: Intrinsic.Execution<i32>,
  owner: Shared<Owner>
) -> () {
  let installing = install(move execution)
  Shared.withMut(&owner, move installing)
  drop owner
  return ()
}
effect fn driveOnce<
  'env, 'state,
  S: once fn<'env>(&'state mut (), Intrinsic.Execution<i32>) -> () + Intrinsic.NonParking
>(
  execution: Intrinsic.Execution<i32>,
  state: &'state mut (),
  onSuspend: S
) -> () {
  return run Execution.drive(move execution, move state, complete, move onSuspend)
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let owner = run Shared.make<Owner>(Owner { slot: Empty {} })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let endpoint = Shared.clone(&owner)
  let suspensionOwner = Shared.clone(&owner)
  let onSuspend = suspend(move suspensionOwner)
  let execution = run Execution.make(body(), move endpoint, ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut state = ()
  run driveOnce(move execution, &mut state, move onSuspend)
  drop owner
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

export const independentExecutionLocalReactor = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.shared { Shared }
struct Empty {}
struct Armed { wake: Intrinsic.Wake }
struct Reactor { slot: Empty | Armed }
struct Guard { reactor: Shared<Reactor> }
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored result: i32 }
fn install(reactor: &mut Reactor, wake: Intrinsic.Wake) -> () {
  let previous = Intrinsic.replace(reactor.slot, Armed { wake: move wake })
  drop previous
  return ()
}
fn register(wake: Intrinsic.Wake, reactor: Shared<Reactor>) -> Guard {
  let installing = install(move wake)
  Shared.withMut(&reactor, move installing)
  return Guard { reactor: move reactor }
}
fn extract(reactor: &mut Reactor) -> Empty | Armed {
  return Intrinsic.replace(reactor.slot, Empty {})
}
fn poll(reactor: &Shared<Reactor>) -> () {
  let selected = Shared.withMut(reactor, extract)
  return match move selected {
    Empty {} => ()
    Armed { wake } => Intrinsic.wake(move wake)
  }
}
effect fn body(reactor: Shared<Reactor>) -> i32 {
  let registration = register(move reactor)
  run Execution.park(move registration)
  return 42
}
fn complete(owner: &mut Owner, result: i32) -> () { owner.result = result return () }
fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
fn ready(state: &()) -> () { return () }
effect fn driveOnce(execution: Intrinsic.Execution<i32>, owner: &mut Owner) -> () {
  return run Execution.drive(move execution, move owner, complete, suspend)
}
effect fn finish(selected: Empty | Stored, owner: &mut Owner) -> () {
  return match move selected {
    Empty {} => ()
    Stored { execution } => run driveOnce(move execution, move owner)
  }
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let reactor = run Shared.make<Reactor>(Reactor { slot: Empty {} })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let bodyReactor = Shared.clone(&reactor)
  let execution = run Execution.make(body(move bodyReactor), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut owner = Owner { slot: Empty {}, result: 0 }
  run driveOnce(move execution, &mut owner)
  poll(&reactor)
  let selected = Intrinsic.replace(owner.slot, Empty {})
  run finish(move selected, &mut owner)
  drop reactor
  return owner.result
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

export const independentExecutionRepeatedGenerations = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
struct Empty {}
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored result: i32 }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard { Intrinsic.wake(move wake) return Guard {} }
effect fn body() -> i32 {
  run Execution.park(register)
  run Execution.park(register)
  return 42
}
fn ready(state: &()) -> () { return () }
fn complete(owner: &mut Owner, result: i32) -> () { owner.result = result return () }
fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
effect fn drive(execution: Intrinsic.Execution<i32>, owner: &mut Owner) -> () {
  return run Execution.drive(move execution, move owner, complete, suspend)
}
effect fn driveStored(selected: Empty | Stored, owner: &mut Owner) -> () {
  return match move selected {
    Empty {} => ()
    Stored { execution } => run drive(move execution, move owner)
  }
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut owner = Owner { slot: Empty {}, result: 0 }
  let execution = run Execution.make(body(), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  run drive(move execution, &mut owner)
  let first = Intrinsic.replace(owner.slot, Empty {})
  run driveStored(move first, &mut owner)
  let second = Intrinsic.replace(owner.slot, Empty {})
  run driveStored(move second, &mut owner)
  return owner.result
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

export const independentExecutionEligibleDrop = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
struct Empty {}
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard { Intrinsic.wake(move wake) return Guard {} }
effect fn body() -> i32 { run Execution.park(register) return 1 }
fn ready(state: &()) -> () { return () }
fn complete(owner: &mut Owner, result: i32) -> () { return () }
fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
effect fn drive(execution: Intrinsic.Execution<i32>, owner: &mut Owner) -> () {
  return run Execution.drive(move execution, move owner, complete, suspend)
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut owner = Owner { slot: Empty {} }
  let execution = run Execution.make(body(), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  run drive(move execution, &mut owner)
  let selected = Intrinsic.replace(owner.slot, Empty {})
  drop selected
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

export const independentExecutionParkedTypedFailure = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.result { Result }
struct Failed { code: i32 }
struct Empty {}
struct Stored { execution: Intrinsic.Execution<Result<i32, Failed>> }
struct Owner { slot: Empty | Stored result: i32 }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard { Intrinsic.wake(move wake) return Guard {} }
effect fn failed() -> i32 ! Failed { fail Failed { code: 42 } }
effect fn body() -> Result<i32, Failed> {
  run Execution.park(register)
  return run Effect.result(failed())
}
fn ready(state: &()) -> () { return () }
fn observe(result: Result<i32, Failed>) -> i32 {
  return match move result {
      Result<i32, Failed>.Success { value } => value
      Result<i32, Failed>.Failure { error } => match move error { Failed { code } => code }
  }
}
fn complete(owner: &mut Owner, result: Result<i32, Failed>) -> () {
  owner.result = observe(move result)
  return ()
}
fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<Result<i32, Failed>>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
effect fn drive(execution: Intrinsic.Execution<Result<i32, Failed>>, owner: &mut Owner) -> () {
  return run Execution.drive(move execution, move owner, complete, suspend)
}
effect fn driveStored(selected: Empty | Stored, owner: &mut Owner) -> () {
  return match move selected {
    Empty {} => ()
    Stored { execution } => run drive(move execution, move owner)
  }
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut owner = Owner { slot: Empty {}, result: 0 }
  let execution = run Execution.make(body(), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  run drive(move execution, &mut owner)
  let selected = Intrinsic.replace(owner.slot, Empty {})
  run driveStored(move selected, &mut owner)
  return owner.result
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

/**
 * The outer suspension frame retains a never-driven Execution whose package owns continuation
 * storage. Native cleanup emission used to re-expand the module's frame inventory for that
 * retained handle until the compiler exhausted its heap; the handle is released on the frame's
 * ordinary completion path.
 */
export const frameRetainedExecutionCompletion = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }

fn ready(state: &()) -> () { return () }

effect fn child() -> i32 {
  return run Effect.suspend(effect { return 42 })
}

effect fn holdAcrossSuspension() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let execution = run Execution.make(child(), (), ready)
  let result = run Effect.suspend(effect { return 0 })
  drop execution
  return result
}

effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run holdAcrossSuspension()
    |> Effect.provideMut<Allocator>(&mut allocator)
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }

pub fn main() -> i32 {
  return run Effect.catchAll(program(), recover)
}`

/**
 * An eligible outer Execution is dropped while its parked frame still retains an inner Execution,
 * so frame cleanup must release the nested package through the runtime cleanup path.
 */
export const frameRetainedExecutionAbandonedFrame = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
struct Empty {}
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard { Intrinsic.wake(move wake) return Guard {} }
fn ready(state: &()) -> () { return () }
effect fn child() -> i32 { return run Effect.suspend(effect { return 42 }) }
effect fn holder(execution: Intrinsic.Execution<i32>) -> i32 {
  run Execution.park(register)
  drop execution
  return 1
}
fn complete(owner: &mut Owner, result: i32) -> () { return () }
fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
effect fn drive(execution: Intrinsic.Execution<i32>, owner: &mut Owner) -> () {
  return run Execution.drive(move execution, move owner, complete, suspend)
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut owner = Owner { slot: Empty {} }
  let retained = run Execution.make(child(), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let outer = run Execution.make(holder(move retained), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  run drive(move outer, &mut owner)
  let selected = Intrinsic.replace(owner.slot, Empty {})
  drop selected
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

export const constrainedCallableForwarding = `import silk.effect { Effect }
service Counter {
  effect fn get() -> i32 ? &Counter
}
struct Fixed { value: i32 }
effect fn get(self: &Fixed) -> i32 { return self.value }
impl Counter for Fixed { get: Fixed.get }
effect fn read() -> i32 ? &Counter { return run Counter.get() }
fn forward<F>(value: F) -> F { return move value }
fn forwardAgain<F>(value: F) -> F {
  let forwarded = forward(move value)
  return move forwarded
}
pub fn main() -> i32 {
  let fixed = Fixed { value: 42 }
  let bind = forwardAgain(Effect.provide<Counter>(&fixed))
  return run bind(read())
}`

/** Fixed-seed xoshiro256** known answers pinned for native execution. */
export const seededRandomFingerprint = `import silk.effect { Effect }
import silk.insecure_random { InsecureRandom }
import silk.u64
import silk.usize

fn matches(seed: u64, expected: &[u64]) -> bool {
  let mut provider = InsecureRandom.seeded(seed)
  let mut index = usize.ZERO
  while index < expected.length {
    let actual = run InsecureRandom.nextU64()
      |> Effect.provideMut<InsecureRandom>(&mut provider)
    if actual != expected[index] { return false }
    index = index + usize.ONE
  }
  return true
}

pub fn main() -> i32 {
  let expected = [
    u64.toU64(0x15780b2e0c2ec716),
    u64.toU64(0x6104d9866d113a7e),
    u64.toU64(0xae17533239e499a1),
    u64.toU64(0xecb8ad4703b360a1),
    u64.toU64(0xfde6dc7fe2ec5e64),
    u64.toU64(0xc50da53101795238),
    u64.toU64(0xb82154855a65ddb2),
    u64.toU64(0xd99a2743ebe60087)
  ]
  if !matches(42, &expected) { return 1 }
  return 42
}`

/** Portable secure-provider and stable insecure-seed behavior pinned for native execution. */
export const portableRandomCapabilities = `import silk.effect { Effect }
import silk.insecure_seed { InsecureSeed }
import silk.random { Random }
import silk.u64
import silk.usize

struct ScriptedRandom {
  first: u64
  second: u64
  calls: usize
}

effect fn fill(self: &mut ScriptedRandom, output: &mut [u8]) -> () {
  if output.length == usize.ZERO { return () }
  let mut word = self.second
  if self.calls == usize.ZERO { word = self.first }
  self.calls = self.calls + usize.ONE
  let mut index = usize.ZERO
  while index < output.length {
    output[index] = u64.toU8(u64.bitAnd(word, 255))
    word = u64.shiftRight(word, 8)
    index = index + usize.ONE
  }
  return ()
}

impl Random for ScriptedRandom { fillBytes: ScriptedRandom.fill }

pub fn main() -> i32 {
  let fixed = InsecureSeed.fixed(40, 2)
  let fixedSeed = run InsecureSeed.get()
    |> Effect.provide<InsecureSeed>(&fixed)
  if InsecureSeed.first(&fixedSeed) + InsecureSeed.second(&fixedSeed) != 42 { return 1 }

  let mut random = ScriptedRandom { first: u64.toU64(20), second: u64.toU64(22), calls: usize.ZERO }
  let sampled = run InsecureSeed.fromRandom()
    |> Effect.provideMut<Random>(&mut random)
  let sampledSeed = run InsecureSeed.get()
    |> Effect.provide<InsecureSeed>(&sampled)
  if random.calls != 2 { return 2 }
  if InsecureSeed.first(&sampledSeed) + InsecureSeed.second(&sampledSeed) != 42 { return 3 }
  return 42
}`

/** Failure payloads retain member bits while rows change their widest physical carrier lane. */
export const heterogeneousFailurePayload = `import silk.effect { Effect }
struct Selected { code: i32 }
struct Small { code: i32 }
struct Wide { code: f64 }
effect fn risky() -> i32 ! Selected | Small { fail Small { code: 41 } }
effect fn recoverSelected(problem: Selected) -> i32 ! Wide { return problem.code }
effect fn recoverAny(problem: Small | Wide) -> i32 {
  return match move problem {
    Small { code } => code + 1
    Wide { code } => 0
  }
}
effect fn widenedResidual() -> i32 ! Small | Wide {
  return run Effect.catch<Selected>(risky(), recoverSelected)
}
effect fn completeResidual() -> i32 {
  return run Effect.catchAll(widenedResidual(), recoverAny)
}
pub fn main() -> i32 { return run completeResidual() }
`

/** Detached address payloads survive a row carrier widened by a floating handler failure. */
export const heterogeneousOwnedFailurePayload = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.layout { Layout }
import silk.effect { Effect }
struct Selected { code: i32 }
struct Owned { storage: Allocation }
struct Wide { code: f64 }
effect fn risky() -> i32 ! Selected | Owned | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<i32>()
  let pending = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let storage = run pending
  fail Owned { storage: move storage }
}
effect fn recoverSelected(problem: Selected) -> i32 ! Wide { return problem.code }
fn release(storage: Allocation) -> i32 {
  drop storage
  return 42
}
effect fn recoverAny(problem: Owned | OutOfMemoryError | Wide) -> i32 {
  return match move problem {
    Owned { storage } => release(move storage)
    OutOfMemoryError {} => 0
    Wide { code } => 0
  }
}
effect fn widenedResidual() -> i32 ! Owned | OutOfMemoryError | Wide {
  return run Effect.catch<Selected>(risky(), recoverSelected)
}
effect fn completeResidual() -> i32 {
  return run Effect.catchAll(widenedResidual(), recoverAny)
}
pub fn main() -> i32 { return run completeResidual() }
`

/** Reified residual unions release owned address payloads from a floating carrier when dropped. */
export const heterogeneousOwnedFailureResultDrop = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.layout { Layout }
import silk.effect { Effect }
struct Selected { code: i32 }
struct Owned { storage: Allocation }
struct Wide { code: f64 }
effect fn risky() -> i32 ! Selected | Owned | OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let pending = Allocator.allocate(Layout.of<i32>()) |> Effect.provideMut(&mut allocator)
  let storage = run pending
  fail Owned { storage: move storage }
}
effect fn recoverSelected(problem: Selected) -> i32 ! Wide { return problem.code }
pub fn main() -> i32 {
  let selected = Effect.catch<Selected>(risky(), recoverSelected)
  let completed = run Effect.result(move selected)
  drop completed
  return 42
}
`

const staticCompositionFixture = readFileSync(
  new URL('../fixtures/static-composition/static-composition-acceptance.silk', import.meta.url),
  'utf8',
)

const staticCompositionScenarios: ReadonlyArray<{
  readonly name: string
  readonly selection: string
  readonly result: number
  readonly cleanupWitness: boolean
}> = [
  { name: 'success', selection: 'RunRequest { value: 40 }', result: 42, cleanupWitness: false },
  { name: 'help', selection: 'HelpRequest {}', result: 10, cleanupWitness: false },
  {
    name: 'selection-failure',
    selection: 'SelectionFailureRequest {}',
    result: 20,
    cleanupWitness: false,
  },
  {
    name: 'decode-failure',
    selection: 'DecodeFailureRequest {}',
    result: 30,
    cleanupWitness: false,
  },
  {
    name: 'uncalled-cleanup',
    selection: 'UncalledCleanupRequest { value: 40 }',
    result: 40,
    cleanupWitness: true,
  },
  {
    name: 'called-cleanup',
    selection: 'CalledCleanupRequest { value: 40 }',
    result: 40,
    cleanupWitness: true,
  },
  {
    name: 'suspension',
    selection: 'SuspensionRequest { value: 42 }',
    result: 42,
    cleanupWitness: true,
  },
]

const selectStaticCompositionScenario = (selection: string): string =>
  staticCompositionFixture.replace('RunRequest {value: 40}', selection)

const withTrappingStaticCompositionDrop = (source: string): string =>
  source.replace(
    `    if self.value == 0 {
      let boom = 1 / 0
      return ()
    }
    self.value = 0
    return ()`,
    `    let values = [self.value]
    let index: usize = 1
    self.value = values[index]
    return ()`,
  )

const staticCompositionCorpus: ReadonlyArray<CorpusProgram> = [
  ...staticCompositionScenarios.map((scenario): CorpusProgram => ({
    name: `static-composition-${scenario.name}`,
    source: selectStaticCompositionScenario(scenario.selection),
    expected: { _tag: 'Completes', result: scenario.result },
  })),
  ...staticCompositionScenarios
    .filter((scenario) => scenario.cleanupWitness)
    .map((scenario): CorpusProgram => ({
      name: `static-composition-${scenario.name}-cleanup-witness`,
      source: withTrappingStaticCompositionDrop(
        selectStaticCompositionScenario(scenario.selection),
      ),
      expected: { _tag: 'Trap' },
    })),
]

/** A Silk callee stores through a `*mut i32` parameter; the caller reloads the place afterwards. */
export const outputStorageSource = `import silk.output { Uninitialized, Initialized }
import silk.pointer { Pointer }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }

effect fn exercise() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let safe = run Uninitialized.make<i32>()
  let written = Uninitialized.initialize<i32>(move safe, 20)
  let first = Initialized.into<i32>(move written)
  let mut foreign = run Uninitialized.make<i32>()
  let address = Uninitialized.address<i32>(&mut foreign)
  unsafe {
    Pointer.writeUnaligned<i32>(address, 22)
    let initialized = Uninitialized.assumeInitialized<i32>(move foreign)
    let second = Initialized.into<i32>(move initialized)
    return first + second
  }
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  let exercise = exercise() |> Effect.provideMut<Allocator>(&mut allocator)
  return run Effect.catchAll(move exercise, recover)
}`

const pointerParameterWrite = `import silk.pointer { Pointer }
fn store(target: *mut i32, value: i32) -> () {
  unsafe { Pointer.write(target, value) }
}
pub fn main() -> i32 {
  let mut result = 0
  store(Pointer.fromMutRef(&mut result), 42)
  return result
}`

const hashedMapOrder = (
  seed: number,
  digest: number,
): string => `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.hash { Hash, HashKey, HashSeed, Word }
import silk.hash_map { HashMap }
import silk.i32
import silk.u64
import silk.usize

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut map = HashMap.make<Word, i32>(Hash.seed(${seed}))
  let mut key = 0
  while key < 12 {
    let previous = run HashMap.insert<Word, i32>(&mut map, Hash.word(i32.toU64(key * 7 + 1)), key)
      |> Effect.provideMut(&mut allocator)
    drop previous
    key = key + 1
  }
  let mut index = usize.ZERO
  let mut folded = u64.toU64(0)
  while index < HashMap.bucketCount<Word, i32>(&map) {
    if HashMap.occupiedAt<Word, i32>(&map, index) {
      let held = HashMap.keyAt<Word, i32>(&map, index)
      folded = u64.wrappingAdd(u64.wrappingMultiply(folded, 131), held.value)
    }
    index = index + usize.ONE
  }
  if u64.toI32(u64.remainder(folded, 1000000007)) != ${digest} { return 1 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`

const ownedAllocationTrap = (
  body: string,
  layout = '[i32; 2]',
): string => `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }

effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<${layout}>()
  let allocation = run Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<i32>(move allocation, 2)
${body}
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`

const integerParsingRanges = [
  { spelling: 'i8', minimum: '-128', maximum: '127', below: '-129', above: '128' },
  { spelling: 'i16', minimum: '-32768', maximum: '32767', below: '-32769', above: '32768' },
  {
    spelling: 'i32',
    minimum: '-2147483648',
    maximum: '2147483647',
    below: '-2147483649',
    above: '2147483648',
  },
  {
    spelling: 'i64',
    minimum: '-9223372036854775808',
    maximum: '9223372036854775807',
    below: '-9223372036854775809',
    above: '9223372036854775808',
  },
  { spelling: 'u8', minimum: '0', maximum: '255', below: '-1', above: '256' },
  { spelling: 'u16', minimum: '0', maximum: '65535', below: '-1', above: '65536' },
  {
    spelling: 'u32',
    minimum: '0',
    maximum: '4294967295',
    below: '-1',
    above: '4294967296',
  },
  {
    spelling: 'u64',
    minimum: '0',
    maximum: '18446744073709551615',
    below: '-1',
    above: '18446744073709551616',
  },
] as const

const numberParsingAcceptance = `${integerParsingRanges
  .map(({ spelling }) => `import silk.${spelling}`)
  .join('\n')}
import silk.format { NotANumber, OutOfRange, ParseError }
import silk.result { Result }
import silk.usize

fn parsed<T>(result: Result<T, ParseError>) -> bool {
  return match move result {
    Result<T, ParseError>.Success { value } => true
    Result<T, ParseError>.Failure { error } => false
  }
}
fn outOfRange<T>(result: Result<T, ParseError>) -> bool {
  return match move result {
    Result<T, ParseError>.Success { value } => false
    Result<T, ParseError>.Failure { error } => match move error.reason {
      NotANumber { offset } => false
      OutOfRange nothing => true
    }
  }
}
fn notANumberAt<T>(result: Result<T, ParseError>, expected: usize) -> bool {
  return match move result {
    Result<T, ParseError>.Success { value } => false
    Result<T, ParseError>.Failure { error } => match move error.reason {
      NotANumber { offset } => offset == expected
      OutOfRange nothing => false
    }
  }
}
pub fn main() -> i32 {
${integerParsingRanges
  .flatMap(({ spelling, minimum, maximum, below, above }, index) => [
    `  if !parsed<${spelling}>(${spelling}.parse("${minimum}")) { return ${index * 4 + 1} }`,
    `  if !parsed<${spelling}>(${spelling}.parse("${maximum}")) { return ${index * 4 + 2} }`,
    `  if !outOfRange<${spelling}>(${spelling}.parse("${above}")) { return ${index * 4 + 3} }`,
    spelling.startsWith('i')
      ? `  if !outOfRange<${spelling}>(${spelling}.parse("${below}")) { return ${index * 4 + 4} }`
      : `  if !notANumberAt<${spelling}>(${spelling}.parse("${below}"), usize.ZERO) { return ${index * 4 + 4} }`,
  ])
  .join('\n')}
  if !notANumberAt<u8>(u8.parse(""), usize.ZERO) { return 40 }
  if !notANumberAt<u8>(u8.parse("abc"), usize.ZERO) { return 41 }
  if !notANumberAt<u8>(u8.parse("12x"), 2) { return 42 }
  if !notANumberAt<u8>(u8.parse("1 2"), usize.ONE) { return 43 }
  if !notANumberAt<i32>(i32.parse("+1"), usize.ZERO) { return 44 }
  if !notANumberAt<i32>(i32.parse("-"), usize.ONE) { return 45 }
  if !notANumberAt<i32>(i32.parse("-x"), usize.ONE) { return 46 }
  if !parsed<u8>(u8.parse("007")) { return 47 }
  if !parsed<i32>(i32.parse("-0")) { return 48 }
  return 42
}`

export const narrowEffectRecord = `import silk.effect { Effect }
import silk.u16
import silk.u8
struct Small { first: u16 second: u8 }
struct WideFailure { first: i64 second: i64 }
effect fn build(failNow: bool) -> Small ! WideFailure {
 if failNow { fail WideFailure { first: 1, second: 2 } }
 return Small { first: u16.toU16(32769), second: u8.toU8(241) }
}
effect fn check() -> i32 ! WideFailure {
 let value = run build(false)
 if value.first != u16.toU16(32769) || value.second != u8.toU8(241) { return 0 }
 return 42
}
effect fn recover(error: WideFailure) -> i32 { return 1 }
pub fn main() -> i32 { return run Effect.catchAll(check(), recover) }`

export const corpus: ReadonlyArray<CorpusProgram> = [
  {
    name: 'narrow-record-effect-success-lanes',
    source: narrowEffectRecord,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'package-parameter-final-defaults',
    source: `pub param enabled: bool = true
pub param answer: i32 = choose() where answer == 42
static fn choose() -> i32 { if enabled { return 42 } return 7 }
pub fn main() -> i32 { return answer }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'literal',
    source: 'pub fn main() -> i32 { return 42 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'tuple-record-aggregates',
    source: `tuple Point(i32, i32)
struct Pair { left: i32 right: i32 }
enum Choice { First, Second }
fn identity<T>(value: T) -> T { return move value }
fn sumPair(value: Pair) -> i32 { return value.left + value.right }
fn select(choice: Choice) -> Pair {
  let selected: Pair = match choice {
    Choice.First => .{ left: 20, right: 22 }
    Choice.Second => .{ left: 21, right: 21 }
  }
  return move selected
}
pub fn main() -> i32 {
  let point = Point(20, 22)
  if point.0 + point.1 != 42 { return 1 }
  let coordinates = (20, 22)
  if coordinates.0 + coordinates.1 != 42 { return 2 }
  let record = identity(.{ left: 20, right: 22 })
  if record.left + record.right != 42 { return 3 }
  if sumPair(.{ left: 20, right: 22 }) != 42 { return 4 }
  let selected = select(Choice.First)
  return selected.left + selected.right
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'scalar-enum-signed',
    source: scalarEnumSignedAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'scalar-enum-lanes',
    source: scalarEnumLaneAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'scalar-display',
    source: scalarDisplayAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'template-formatting',
    source: templateFormattingAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'format-options',
    source: formatOptionsAcceptance,
    nativeStdout: `***-0042|+42...|éé000éé|-000042|·-7··|${'_'.repeat(33)}42`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'float-formatting',
    source: floatFormattingAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'number-parsing',
    source: numberParsingAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'retained-if-let-match-binding',
    source: retainedIfLetMatchAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'while-entry-backedge',
    source: whileEntryBackedgeAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'reference-projection',
    source: referenceProjectionAcceptance,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'nominal-result-compound-error',
    source: `struct Data { value: i32 }
union HttpErrorCode { DNSTimeout, DNSError { rcode: i32 } }
struct OutOfMemoryError {}
union Result<A, E> { Success { value: A }, Failure { error: E } }

fn inspect(result: Result<Data, HttpErrorCode | OutOfMemoryError>) -> i32 {
  return match move result {
    Result<Data, HttpErrorCode | OutOfMemoryError>.Success { value } => value.value
    Result<Data, HttpErrorCode | OutOfMemoryError>.Failure { error } => match move error {
      HttpErrorCode.DNSTimeout => 1
      HttpErrorCode.DNSError { rcode } => rcode
      OutOfMemoryError other => 0
    }
  }
}

pub fn main() -> i32 {
  let success = Result<Data, HttpErrorCode | OutOfMemoryError>.Success {
    value: Data { value: 21 },
  }
  let failure = Result<Data, HttpErrorCode | OutOfMemoryError>.Failure {
    error: HttpErrorCode.DNSError { rcode: 21 },
  }
  return inspect(move success) + inspect(move failure)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'nominal-union-represented-copy-drop',
    source: `union Parser<F: once fn<'static>(i32) -> i32> { Empty, Ready { parse: F } }
union Deferred<F: once Effect<'static; i32>> { Empty, Ready { operation: F } }
union Flag { Empty, Value { value: i32 } }
impl Copy for Flag {}
struct Token<'a> { first: i32 second: i32 audit: &'a mut i32 }
impl<'a> Drop for Token<'a> {
  fn drop(self: &mut Token<'a>) -> () {
    self.second = self.first + self.second
    self.audit.* = self.second
    return ()
  }
}
union Owner<'a> { Empty, Present { token: Token<'a>, value: i32 }, Wide { first: i64, second: i64, third: i64 } }

fn increment(value: i32) -> i32 { return value + 1 }
fn parse<F: once fn<'static>(i32) -> i32>(parser: Parser<F>) -> i32 {
  return match move parser {
    Parser<F>.Empty => 0
    Parser<F>.Ready { parse } => parse(19)
  }
}
fn force<F: once Effect<'static; i32>>(deferred: Deferred<F>) -> i32 {
  return match move deferred {
    Deferred<F>.Empty => 0
    Deferred<F>.Ready { operation } => run operation
  }
}
fn copyFlag(flag: Flag) -> i32 {
  let copied = flag
  return match move copied { Flag.Empty => 0 Flag.Value { value } => value }
}
fn consume<'a>(owner: Owner<'a>) -> i32 {
  return match move owner { Owner<'a>.Empty => 0 Owner<'a>.Present { value, .. } => value Owner<'a>.Wide {..} => 0 }
}
pub fn main() -> i32 {
  let parser = Parser.Ready { parse: increment }
  let deferred = Deferred.Ready { operation: effect { return 18 } }
  let mut audit = 0
  let owner = Owner.Present { token: Token {first: 17, second: 25, audit: &mut audit}, value: 2 }
  let consumed = consume(move owner)
  if audit != 42 { return 0 }
  return parse(move parser) + force(move deferred) + copyFlag(Flag.Value { value: 2 }) + consumed
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'seeded-random-fingerprint',
    source: seededRandomFingerprint,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'staged-callable-section',
    source: `fn combine(a: i32, b: i32, c: i32) -> i32 {
  return a * 100 + b * 10 + c
}
pub fn main() -> i32 { return combine(3)(2)(1) }`,
    expected: { _tag: 'Completes', result: 123 },
  },
  // CALLABLE-002: every stage may pass through a binding, keeping the captured suffix in place.
  {
    name: 'staged-callable-bindings',
    source: `fn combine(a: i32, b: i32, c: i32) -> i32 {
  return a * 100 + b * 10 + c
}
pub fn main() -> i32 {
  let withThree = combine(3)
  let withTwoAndThree = withThree(2)
  return withTwoAndThree(1)
}`,
    expected: { _tag: 'Completes', result: 123 },
  },
  // CALLABLE-002: a stage over an erased callable parameter splices the hidden environment.
  {
    name: 'staged-callable-parameter',
    source: `fn combine(a: i32, b: i32, c: i32) -> i32 { return a * 100 + b * 10 + c }
fn stage(f: fn(i32, i32) -> i32) -> i32 {
  let g = f(2)
  return g(1)
}
pub fn main() -> i32 { return stage(combine(3)) - 123 + 42 }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // JUL-72: one source-defined anonymous environment covers Copy, shared, exclusive, and moved
  // captures so the native corpus owns runtime coverage for the feature.
  {
    name: 'anonymous-callable-capture-modes',
    source: `struct Token { value: i32 }
fn consume(token: Token) -> i32 { return token.value }
pub fn main() -> i32 {
  let copied = 2
  let extra = 40
  let shared = Token { value: 10 }
  let mut counter = 0
  let owned = Token { value: 17 }
  let copyStep = fn(base: i32) -> i32 { return base + extra + move copied - 40 }
  let sharedStep = fn() -> i32 { return shared.value }
  let mut mutateStep = fn() -> i32 {
    counter = counter + 1
    return counter
  }
  let consumeStep = fn() -> i32 { return consume(move owned) }
  return copyStep(0) + sharedStep() + sharedStep()
    + mutateStep() + mutateStep() + consumeStep()
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'runtime-indexed-subplace-borrow',
    source: `fn edit(values: &mut [i32]) -> () { values[0] = 40 }
fn change(index: usize) -> i32 {
  let mut matrix = [[1, 2], [3, 4]]
  edit(&mut matrix[index])
  return matrix[index][0] + matrix[index][1]
}
pub fn main() -> i32 { return change(0) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'finite-effect-join',
    source: `enum Flag { No, Yes }
effect fn selected(static value: i32) -> i32 { return value }
effect fn outer(flag: Flag) -> i32 {
  let picked = match move flag {
    Flag.Yes => selected(41)
    Flag.No => selected(42)
  }
  return run picked
}
pub fn main() -> i32 { return run outer(Flag.No) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // Alternatives with different capture arities exercise the composite's unified payload lanes:
  // every executor must place and read alternative captures through the registered calling shape.
  // The aggregate alternative also crosses the private address ABI from composite payload lanes;
  // changing the original Copy value after construction must not change its captured snapshot.
  {
    name: 'finite-effect-join-capture-arity',
    source: `struct First {}
struct Second {}
struct Payload { a: i32 b: i32 c: i32 }
impl Copy for Payload {}
fn choose(input: First | Second, payload: Payload) -> Effect<'static; i32> {
  return match move input {
    First {} => effect { return payload.a + payload.b + payload.c }
    Second {} => effect { return 2 }
  }
}
pub fn main() -> i32 {
  let mut payload = Payload { a: 11, b: 13, c: 16 }
  let captured = choose(First {}, payload)
  payload.a = 100
  let wide = run captured
  let narrow = run choose(Second {}, payload)
  return wide + narrow
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'finite-effect-join-selected-cleanup',
    source: `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.shared { Shared }
struct First {}
struct Second {}
struct Counter { value: i32 }
struct Guard { storage: Allocation counter: Shared<Counter> }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
fn choose(input: First | Second, guard: Guard) -> once Effect<'static; i32> {
  return match move input {
    First {} => effect { drop move guard return 41 }
    Second {} => effect { drop move guard return 42 }
  }
}
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<i32>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let storage = run recipe
  let counter = run Shared.make<Counter>(Counter { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let selected = choose(Second {}, Guard {
    storage: move storage,
    counter: Shared.clone<Counter>(&counter),
  })
  drop selected
  let count = Shared.with<Counter, i32>(&counter, read)
  drop counter
  if count != 1 { return 1 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'constrained-callable-forwarding',
    source: constrainedCallableForwarding,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'identity',
    source: `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { return identity(42) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'second-parameter',
    source: `pub fn second(left: i32, right: i32) -> i32 { return right }
pub fn main() -> i32 { return second(10, 42) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'nested',
    source: `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { return identity(identity(42)) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'nested-siblings',
    source: `pub fn identity(value: i32) -> i32 { return value }
pub fn choose(left: i32, right: i32) -> i32 { return right }
pub fn main() -> i32 { return choose(identity(1), identity(2)) }`,
    expected: { _tag: 'Completes', result: 2 },
  },
  {
    name: 'generic-specializations',
    source: `struct Pair { left: i32 right: i32 }
struct Box<T> { value: T }
fn identity<T>(value: T) -> T { return move value }
pub fn main() -> i32 {
  let scalar = Box<i32> { value: identity(0) }
  let pair = Box<Pair> { value: identity<Pair>(Pair { left: 40, right: 2 }) }
  return scalar.value + pair.value.left + pair.value.right
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'generic-partial-type-arguments',
    source: `struct Box<T> { value: T }
fn pick<A, B>(left: A, right: B) -> A { return move left }
fn phantom<A, B>(value: A) -> A { return move value }
pub fn main() -> i32 {
  let picked = pick<i32>(40, true)
  let boxed = pick<Box<i32>>(Box<i32> { value: 1 }, picked)
  return picked + boxed.value + phantom<i32, bool>(1)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'same-specialization-recursion',
    source: `fn recurse<T>(value: T, remaining: i32) -> i32 {
  if remaining > 0 { return recurse<T>(move value, remaining - 1) }
  return 42
}
pub fn main() -> i32 { return recurse<i32>(1, 4) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'recursive-aggregate-return',
    source: `struct Pair { left: i32 right: i32 }
fn build(remaining: i32) -> Pair {
  if remaining == 0 { return Pair { left: 40, right: 2 } }
  return build(remaining - 1)
}
pub fn main() -> i32 {
  let pair = build(4)
  return pair.left + pair.right
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'recursive-mutable-slice',
    source: `import silk.usize
fn fill(values: &mut [i32], index: usize) -> i32 {
  if index == 4 { return values[0] + values[1] + values[2] + values[3] }
  values[index] = usize.toI32(index) + 9
  return fill(&mut values, index + 1)
}
pub fn main() -> i32 {
  let mut values = [0, 0, 0, 0]
  return fill(&mut values, 0)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'forward-call',
    source: `pub fn main() -> i32 { return answer() }
pub fn answer() -> i32 { return 42 }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'direct-recursion',
    source: `fn countdown(value: i32) -> i32 {
  if value == 0 { return 42 }
  return countdown(value - 1)
}
pub fn main() -> i32 { return countdown(4) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'mutual-recursion',
    source: `fn even(value: i32) -> i32 {
  if value == 0 { return 42 }
  return odd(value - 1)
}
fn odd(value: i32) -> i32 { return even(value - 1) }
pub fn main() -> i32 { return odd(5) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'binding',
    source: `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { let value = identity(42) return value }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'binding-chain',
    source: `pub fn main() -> i32 { let first = 40 let second = 2 return first }`,
    expected: { _tag: 'Completes', result: 40 },
  },
  {
    name: 'moved-binding',
    source: `pub fn identity(value: i32) -> i32 { return value }
pub fn main() -> i32 { let value = 42 return identity(move value) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'arithmetic',
    source: 'import silk.i32\npub fn main() -> i32 { return i32.subtract(i32.multiply(6, 7), 0) }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'duration-arithmetic-overflow',
    source: 'pub fn main() -> i32 { let overflow = 18446744073709551615ns + 1ns return 42 }',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'generic-interface-runtime-contracts',
    source: `import silk.numeric { Numeric }
import silk.order { Order }
struct Box<T> { value: T }
interface Marker { fn mark(value: &Self) -> i32 }
impl<T> Marker for Box<T> { fn mark(value: &Self) -> i32 { return 42 } }
fn throughMarker<T: Marker>(value: &T) -> i32 { return Marker.mark(value) }
interface Blend {
  operator + fn add(left: &Self, right: &Self) -> Self
  operator < fn lessThan(left: &Self, right: &Self) -> bool
}
struct Cell { weight: i32 }
fn cellAdd(left: &Cell, right: &Cell) -> Cell {
  return Cell { weight: left.weight + right.weight }
}
fn cellLess(left: &Cell, right: &Cell) -> bool { return left.weight < right.weight }
impl Blend for Cell { add: Cell.cellAdd lessThan: Cell.cellLess }
impl Order for Cell { lessThan: Cell.cellLess }
fn merged<T: Blend>(left: T, right: T) -> T {
  if (&left) < (&right) { return (&left) + (&right) }
  return (&right) + (&left)
}
interface Mixer { fn mix(left: Self, right: Self) -> Self }
impl Mixer for i32 { mix: Intrinsic.i32WrappingAdd }
impl Mixer for u8 { mix: Intrinsic.u8SaturatingAdd }
fn blend<T: Mixer>(left: T, right: T) -> T { return Mixer.mix(move left, move right) }
unsafe fn raw(value: i32) -> i32 { return value * 2 }
fn safe(value: i32) -> i32 { return value * 3 }
fn prefix<F: unsafe fn(i32) -> i32>(operation: F, value: i32) -> i32 {
  return unsafe operation(value)
}
fn block<F: unsafe fn(i32) -> i32>(operation: F, value: i32) -> i32 {
  unsafe { return operation(value) }
  return 0
}
pub fn main() -> i32 {
  let box = Box { value: true }
  if box.mark() != 42 { return 1 }
  if throughMarker(&box) != 42 { return 5 }
  if Numeric.add<i32>(40, 2) != 42 { return 2 }
  if prefix(raw, 1) != 2 { return 3 }
  if block(safe, 1) != 3 { return 4 }
  let combined = merged<Cell>(Cell { weight: 20 }, Cell { weight: 22 })
  if combined.weight != 42 { return 6 }
  if blend<u8>(200, 100) != 255 { return 7 }
  if blend<i32>(40, 2) != 42 { return 8 }
  if !Order.less<i32>(1, 2) { return 9 }
  if !Order.less<Cell>(Cell { weight: 4 }, Cell { weight: 5 }) { return 10 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'nominal-union-operator-provider',
    source: `struct Narrow {first: i32 second: i32}
struct Wide {first: i64 second: i64}
union Choice { Left { value: Narrow }, Right { value: Wide } }
union ScalarChoice { Value {value: i32} }
fn copyScalar(input: &ScalarChoice) -> ScalarChoice {
  return match &input.* { ScalarChoice.Value {value} => ScalarChoice.Value {value: value} }
}
union Inner { Closed {operation: i32}, Open {operation: i32} }
union Outer { Io {error: Inner}, Other }
fn nested(input: &Outer) -> i32 {
  return match &input.* {
    Outer.Io {error: Inner.Closed {operation}} if false => 99
    Outer.Io {error: Inner.Closed {operation}} => operation
    Outer.Io {error: Inner.Open {operation}} => 0
    Outer.Other => 0
  }
}
struct Choices { values: [Choice; 1] }
interface Merge { operator + fn add(left: Self, right: Self) -> Self }
fn add(left: Choice, right: Choice) -> Choice { return move left }
impl Merge for Choice { add: Choice.add }
fn increment(value: &mut Narrow) -> () {
  value.first = value.first + 1
  value.second = value.second + 1
}
fn readArray(values: &Choices, index: usize) -> i32 {
  return match &values.values[index] {
    Choice.Left {value} => value.first + value.second
    Choice.Right {..} => 0
  }
}
fn readSlice(values: &[Choice], index: usize) -> i32 {
  return match &values[index] {
    Choice.Left {value} => value.first + value.second
    Choice.Right {..} => 0
  }
}
pub fn main() -> i32 {
  let closed = Outer.Io {error: Inner.Closed {operation: 42}}
  let open = Outer.Io {error: Inner.Open {operation: 17}}
  if nested(&closed) != 42 || nested(&open) != 0 { return 2 }
  let original = ScalarChoice.Value {value: 42}
  let copied = copyScalar(&original)
  match move copied { ScalarChoice.Value {value} => { if value != 42 { return 1 } } }
  let mut combined = Choice.Left { value: Narrow {first: 20, second: 20} }
    + Choice.Right { value: Wide {first: 0, second: 0} }
  match &mut combined {
    Choice.Left {value} => { increment(&mut value) }
    Choice.Right {..} => {}
  }
  let mut values = Choices {values: [move combined]}
  let arrayValue = readArray(&values, 0)
  let sliceValue = readSlice(&values.values, 0)
  if arrayValue == sliceValue { return arrayValue }
  return 0
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'usize-array-roundtrip',
    source: `fn second(values: [usize; 2]) -> usize { return values[1] }
pub fn main() -> i32 {
  if second([7, 4294967295]) == 4294967295 { return 42 }
  return 0
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'operator-precedence',
    source: 'pub fn main() -> i32 { return 2 + 5 * 8 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'operator-pipeline',
    source: 'import silk.i32\npub fn main() -> i32 { return 2 |> i32.add(40) }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'operator-interface-contract',
    source: `struct Vector { value: i32 }
fn scale(left: Vector, right: i32) -> Vector {
  return Vector { value: left.value * right }
}
fn dot(left: Vector, right: Vector) -> i32 {
  return left.value * right.value
}
interface Multiply<Right, Output> {
  operator * fn multiply(left: Self, right: Right) -> Output
}
impl Multiply<i32, Vector> for Vector { multiply: Vector.scale }
impl Multiply<Vector, i32> for Vector { multiply: Vector.dot }
fn doubled<T: Multiply<i32, T>>(value: T) -> T { return move value * 2 }
pub fn main() -> i32 {
  let scaled = doubled(Vector { value: 21 })
  let unit = Vector { value: 1 }
  return move scaled * move unit
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'applied-interface-operation-calls',
    source: `interface Encodable<Format> {
  effect fn encode(self: &Self) -> i32
}
struct Numeric {}
struct Textual {}
struct Age { value: i32 }
impl Encodable<Numeric> for Age {
  effect fn encode(self: &Self) -> i32 { return self.value }
}
impl Encodable<Textual> for Age {
  effect fn encode(self: &Self) -> i32 { return 10 }
}
pub fn main() -> i32 {
  let age = Age { value: 32 }
  let numeric = run Encodable<Numeric>.encode(&age)
  let textual = run &age |> Encodable<Textual>.encode
  return numeric + textual
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'closed-operator-surface',
    source: `import silk.i16
import silk.u8
import silk.option { Option }
fn checkedSection() -> Option<u8> {
  let addOne = u8.checkedAdd(1)
  return addOne(u8.add(40, 1))
}
pub fn main() -> i32 {
if 6 * 7 != 42 { return 0 }
if 84 / 2 != 42 { return 0 }
if 85 % 43 != 42 { return 0 }
if 44 - 2 != 42 { return 0 }
if 40 + 2 != 42 { return 0 }
if !(1 < 2) { return 0 }
if !(2 <= 2) { return 0 }
if !(3 > 2) { return 0 }
if !(3 >= 3) { return 0 }
if true != true { return 0 }
if false == true { return 0 }
let overflow = u8.checkedAdd(255, 1)
let overflowed = match move overflow {
  Option<u8>.None => false
  Option<u8>.Some { value } => true
}
if overflowed { return 1 }
let converted = i16.checkedToU8(255)
let convertedValue = match move converted {
  Option<u8>.None => 0
  Option<u8>.Some { value } => u8.toI32(value)
}
if convertedValue != 255 { return 2 }
let sectioned = match move checkedSection() {
  Option<u8>.None => 0
  Option<u8>.Some { value } => u8.toI32(value)
}
if sectioned != 42 { return 3 }
return (40 + 2) * 1
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'unary-bool-pipeline',
    source: 'import silk.bool\npub fn main() -> i32 { if true |> bool.not { return 0 } return 42 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'signed-truncation',
    source: 'import silk.i32\npub fn main() -> i32 { return i32.add(i32.divide(-7, 2), 45) }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'remainder-sign',
    source: 'import silk.i32\npub fn main() -> i32 { return i32.add(i32.remainder(-7, 2), 43) }',
    expected: { _tag: 'Completes', result: 42 },
  },
  // MIN % -1 traps identically everywhere: the quotient overflows even though the mathematical
  // remainder is 0, matching ordinary arithmetic's invalid-remainder trap rule.
  {
    name: 'arith-convergence-remainder-min-trap',
    source: `import silk.i32
pub fn main() -> i32 { return i32.remainder(i32.subtract(-2147483647, 1), -1) }`,
    expected: { _tag: 'Trap' },
  },
  {
    name: 'arith-convergence-remainder-min-trap-i64',
    source: `import silk.i64
pub fn main() -> i32 {
  let minimum = i64.subtract(-9223372036854775807, 1)
  if i64.remainder(minimum, -1) != 0 { return 1 }
  return 2
}`,
    expected: { _tag: 'Trap' },
  },
  // The checked variant answers None exactly where the ordinary operation traps.
  {
    name: 'arith-convergence-checked-remainder-min-none',
    source: `import silk.i32
import silk.option { Option }
pub fn main() -> i32 {
  let minimum = i32.subtract(-2147483647, 1)
  if Option.unwrapOr<i32>(i32.checkedRemainder(minimum, -1), 42) != 42 { return 1 }
  if Option.unwrapOr<i32>(i32.checkedRemainder(7, -1), -1) != 0 { return 2 }
  if Option.unwrapOr<i32>(i32.checkedRemainder(minimum, 2), -1) != 0 { return 3 }
  if Option.unwrapOr<i32>(i32.checkedRemainder(7, 0), 42) != 42 { return 4 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // Rotate counts wrap unsigned modulo the lane width, so negative counts rotate the other way
  // instead of degenerating into a plain shift.
  {
    name: 'arith-convergence-rotate-negative-count',
    source: `import silk.i32
import silk.i64
pub fn main() -> i32 {
  if i32.rotateLeft(5, -1) != i32.rotateLeft(5, 31) { return 1 }
  if i32.rotateLeft(5, -1) != -2147483646 { return 2 }
  if i32.rotateRight(5, -1) != i32.rotateRight(5, 31) { return 3 }
  if i32.rotateLeft(5, 33) != i32.rotateLeft(5, 1) { return 4 }
  if i64.rotateLeft(5, -1) != i64.rotateLeft(5, 63) { return 5 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // Float remainder is exact IEEE fmod on every executor: no intermediate overflow for extreme
  // exponent differences and bit-exact results for ordinary operands.
  {
    name: 'arith-convergence-float-remainder-exact',
    source: `import silk.f32
import silk.f64
fn infinity() -> f64 { return 1e308 * 10.0 }
pub fn main() -> i32 {
  if f64.toBits(f64.remainder(10.5, 3.25)) != 4604930618986332160 { return 1 }
  if f64.toBits(f64.remainder(1e308, 1e-308)) != 708093261633040 { return 2 }
  if f64.remainder(5.0, infinity()) != 5.0 { return 3 }
  if !f64.isNaN(f64.remainder(infinity(), 3.0)) { return 4 }
  if !f64.isNaN(f64.remainder(5.0, 0.0)) { return 5 }
  if !f64.isNaN(f64.remainder(f64.fromBits(9221120237041090560), 3.0)) { return 6 }
  if !f64.isSignNegative(f64.remainder(-5.0, 1.0)) { return 7 }
  if f64.remainder(-5.0, 1.0) != 0.0 { return 8 }
  if f32.toBits(f32.remainder(3.4e38, 1.2e-38)) != 3993146 { return 9 }
  if f32.toBits(f32.remainder(10.5, 3.25)) != 1061158912 { return 10 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // A binding referenced only as an enum-value argument still becomes an effect capture.
  {
    name: 'arith-convergence-effect-enum-value-capture',
    source: `import silk.i8
enum(i8) Status {
  Unknown = -1,
  Ready = 41,
}
pub fn main() -> i32 {
  let status = Status.Ready
  let deferred = effect { return i8.toI32(Status.value(status)) + 1 }
  return run deferred
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'overflow-trap',
    source: 'import silk.i32\npub fn main() -> i32 { return i32.add(2147483647, 1) }',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'float-to-subword-out-of-range-trap',
    source:
      'import silk.f64\nimport silk.u8\npub fn main() -> i32 { return u8.toI32(f64.toU8(300.0)) }',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'operator-negation-overflow-trap',
    source: 'pub fn main() -> i32 { return -(-2147483648) }',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'divide-by-zero-trap',
    source: 'import silk.i32\npub fn main() -> i32 { return i32.divide(1, 0) }',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'minimum-division-trap',
    source: 'import silk.i32\npub fn main() -> i32 { return i32.divide(-2147483648, -1) }',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'branch-taken',
    source: 'import silk.i32\npub fn main() -> i32 { if i32.equals(1, 1) { return 42 } return 0 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'branch-otherwise',
    source: 'import silk.i32\npub fn main() -> i32 { if i32.equals(1, 2) { return 0 } return 42 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'branch-else',
    source:
      'import silk.i32\npub fn main() -> i32 { if i32.lessThan(2, 1) { return 1 } else { return 42 } return 0 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'bool-not',
    source:
      'import silk.bool\nimport silk.i32\npub fn main() -> i32 { if bool.not(i32.equals(1, 2)) { return 42 } return 0 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'operator-bool-not',
    source: 'pub fn main() -> i32 { if !(1 == 2) { return 42 } return 0 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'bool-through-function',
    source: `import silk.i32
pub fn check(flag: bool) -> i32 { if flag { return 42 } return 0 }
pub fn main() -> i32 { return check(i32.greaterOrEqual(3, 3)) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'arm-binding',
    source:
      'import silk.i32\npub fn main() -> i32 { let base = 40 if i32.equals(base, 40) { let bonus = 2 return i32.add(base, bonus) } return 0 }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'array-inferred',
    source: 'pub fn main() -> i32 { let values = [10, 42] return values[1] }',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'array-contextual-empty',
    source: `fn empty() -> [i32; 0] { return [] }
fn consume(values: [i32; 0]) -> i32 { return 42 }
pub fn main() -> i32 { return consume(empty()) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'array-nested',
    source: `fn choose(values: [[i32; 2]; 2], outer: usize, inner: usize) -> i32 { return values[outer][inner] }
pub fn main() -> i32 { return choose([[10, 11], [42, 43]], 1, 0) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'array-indexed-struct-field',
    source: `struct Pair { left: i32 right: i32 }
fn choose(values: [Pair; 2], index: usize) -> i32 { return values[index].left }
pub fn main() -> i32 { return choose([Pair { left: 10, right: 11 }, Pair { left: 42, right: 43 }], 1) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'array-whole-move',
    source: `struct Token { value: i32 }
pub fn main() -> i32 {
  let tokens = [Token { value: 10 }, Token { value: 42 }]
  let moved = move tokens
  return moved[1].value
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'array-upper-index-trap',
    source: `fn choose(values: [i32; 2], index: usize) -> i32 { return values[index] }
pub fn main() -> i32 { return choose([10, 42], 2) }`,
    expected: { _tag: 'Trap' },
  },
  {
    name: 'array-zero-index-trap',
    source: `fn choose(values: [i32; 0], index: usize) -> i32 { return values[index] }
pub fn main() -> i32 { return choose([], 0) }`,
    expected: { _tag: 'Trap' },
  },
  {
    name: 'mutable-scalar-loop',
    source: `pub fn main() -> i32 {
  let mut count = 0
  while count < 42 { count = count + 1 }
  return count
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'mutable-array-loop',
    source: `import silk.usize
pub fn main() -> i32 {
  let mut values = [40, 0]
  let mut index = usize.add(0, 0)
  while index < 2 {
    values[index] = values[index] + 1
    index = index + 1
  }
  return values[0] + values[1]
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'loop-continue-break',
    source: `import silk.usize
pub fn main() -> i32 {
  let mut index = usize.add(0, 0)
  while index < 50 {
    index = index + 1
    if index == 2 { continue }
    if index == 42 { break }
  }
  return usize.toI32(index)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'mutable-struct-loop',
    source: `struct Pair { left: i32 right: i32 }
pub fn main() -> i32 {
  let mut pair = Pair { left: 0, right: 40 }
  while pair.left < 2 { pair.left = pair.left + 1 }
  return pair.left + pair.right
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'match-guarded-union-shared',
    source: `struct Left { value: i32 }
struct Right { value: i32 }
fn inspect(input: Left | Right) -> i32 {
  return match &input {
    Left { value } if false => 0
    Left { value: answer } => answer + 1
    Right { value } => value
  }
}
pub fn main() -> i32 { return inspect(Left { value: 41 }) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'match-move-nested-cleanup',
    source: `struct Token { value: i32 }
struct Box { token: Token discarded: Token }
pub fn main() -> i32 {
  let box = Box { token: Token { value: 42 }, discarded: Token { value: 0 } }
  return match move box {
    Box { token: Token { value }, .. } => value
  }
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'match-universal-fallback',
    source: `struct Left { value: i32 }
struct Right { value: i32 }
fn inspect(input: Left | Right) -> i32 {
  return match &input { Left { value } => value _ => 42 }
}
pub fn main() -> i32 { return inspect(Right { value: 0 }) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'match-exclusive-mutable',
    source: `struct Token { value: i32 }
pub fn main() -> i32 {
  let mut token = Token { value: 42 }
  return match &mut token { Token { value } => value }
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'nested-loops',
    source: `pub fn main() -> i32 {
  let mut outer = 0
  let mut total = 0
  while outer < 6 {
    let mut inner = 0
    while inner < 7 {
      total = total + 1
      inner = inner + 1
    }
    outer = outer + 1
  }
  return total
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'string-owned-scalars',
    source: `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.u32
import silk.string { ScalarCursor, ScalarStep, String }
import silk.option { Option }
import silk.char

fn scalarSum(value: string, cursor: ScalarCursor) -> u32 {
  return match move String.nextScalar(value, move cursor) {
    Option<ScalarStep>.Some { value: step } => continueSum(value, move step)
    Option<ScalarStep>.None => u32.toU32(0)
  }
}

fn continueSum(value: string, step: ScalarStep) -> u32 {
  let scalar = char.toU32(String.scalarValue(&step))
  let cursor = String.nextCursor(move step)
  return scalar + scalarSum(value, move cursor)
}

effect fn build() -> i32 ! OutOfMemoryError {
  let literal = "A\\u{a2}"
  if literal == "A\\u{a2}" {} else { return 1 }
  if literal != "A\\u{a3}" {} else { return 2 }

  let mut allocator = Allocator.systemAllocatorProvider()
  let copying = String.copy(literal) |> Effect.provideMut(&mut allocator)
  let mut owned = run copying
  let appending = String.append(&mut owned, "\\u{20ac}\\u{10348}")
    |> Effect.provideMut(&mut allocator)
  let appended = run appending
  let borrowed = String.view(&owned)
  if borrowed == "A\\u{a2}\\u{20ac}\\u{10348}" {} else { return 3 }
  if scalarSum(borrowed, String.scalarCursor()) == u32.toU32(74967) {} else { return 4 }
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'string-utf8-validation',
    source: `import silk.usize
import silk.string { InvalidUtf8, String }
import silk.result { Result }
fn inspect(bytes: &[u8]) -> i32 {
  return match move String.fromUtf8(bytes) {
    Result<string, InvalidUtf8>.Success { value } => usize.toI32(String.byteLength(value))
    Result<string, InvalidUtf8>.Failure { error } => usize.toI32(error.offset) + 40
  }
}
pub fn main() -> i32 { return inspect(b"ok") + inspect(b"a\\x80") - 1 }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'string-append-rollback',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.string { String }
struct QuotaAllocator { remaining: i32 }
effect fn allocate(self: &mut QuotaAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  if self.remaining == 0 { fail OutOfMemoryError {} }
  self.remaining = self.remaining - 1
  let mut inner = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut inner)
}
impl Allocator for QuotaAllocator { allocate: QuotaAllocator.allocate }
effect fn ignore(error: OutOfMemoryError) -> () { return () }
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = QuotaAllocator { remaining: 1 }
  let mut value = run String.copy("ok") |> Effect.provideMut(&mut allocator)
  let recovered = run Effect.catchAll(
    String.append(&mut value, "\u{1f642}") |> Effect.provideMut(&mut allocator),
    ignore,
  )
  if String.view(&value) != "ok" { return 1 }
  if String.ownedByteLength(&value) != 2 { return 2 }
  return 42
}
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from UnicodeNormalization.test.ts: the two normalized owners compared directly, which
  // native execution answers correctly while WebAssembly support remains incomplete.
  {
    name: 'unicode-compared-directly',
    source: `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.string { String }
import silk.unicode { Unicode }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let left = run Unicode.normalizeNfc("\\u{e9}") |> Effect.provideMut(&mut allocator)
  let right = run Unicode.normalizeNfc("e\\u{301}") |> Effect.provideMut(&mut allocator)
  if String.view(&left) == String.view(&right) {} else { return 1 }
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'unicode-contract-metadata-and-failure',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.unicode { Unicode }

struct EmptyAllocator {}
effect fn allocate(self: &mut EmptyAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  fail OutOfMemoryError {}
}
impl Allocator for EmptyAllocator { allocate: EmptyAllocator.allocate }

effect fn normalizeWithoutMemory() -> i32 ! OutOfMemoryError {
  let mut allocator = EmptyAllocator {}
  let normalized = run Unicode.normalizeNfc("e\u{301}")
    |> Effect.provideMut(&mut allocator)
  drop normalized
  return 1
}
effect fn recovered(error: OutOfMemoryError) -> i32 { return 42 }

pub fn main() -> i32 {
  if "\u{e9}" == "e\u{301}" { return 1 }
  if "\u{fb01}" == "fi" { return 2 }
  if Unicode.dataVersion() != "17.0.0" { return 3 }
  if Unicode.longestDecomposition() != 4 { return 4 }
  return run Effect.catchAll(normalizeWithoutMemory(), recovered)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from CharacterLiteral.test.ts: every accepted escape, multi-byte scalars, and the six
  // comparisons. The source deliberately carries non-ASCII literals.
  {
    name: 'character-literal-acceptance',
    source: `import silk.char { equals, notEquals, lessThan, lessOrEqual, greaterThan, greaterOrEqual }

const asciiSpace: char = ' '
const asciiTab: char = '\\t'
const snowman: char = '\\u{2603}'
const accentByte: u8 = 'é'

fn contextualByte(value: u8) -> bool { return value == 'é' && 'é' == value }

fn eq(left: char, right: char) -> bool { return left == right }
fn ne(left: char, right: char) -> bool { return left != right }
fn lt(left: char, right: char) -> bool { return left < right }
fn le(left: char, right: char) -> bool { return left <= right }
fn gt(left: char, right: char) -> bool { return left > right }
fn ge(left: char, right: char) -> bool { return left >= right }

pub fn main() -> i32 {
  if eq('a', 'a') {} else { return 1 }
  if ne('a', 'b') {} else { return 2 }
  if lt('a', 'b') {} else { return 3 }
  if le('a', 'a') {} else { return 4 }
  if gt('b', 'a') {} else { return 5 }
  if ge('a', 'a') {} else { return 6 }
  if eq('\\n', '\\u{a}') {} else { return 7 }
  if eq('\\r', '\\u{d}') {} else { return 8 }
  if eq('\\t', asciiTab) {} else { return 9 }
  if eq('\\0', '\\u{0}') {} else { return 10 }
  if eq('\\\\', '\\u{5c}') {} else { return 11 }
  if eq('\\'', '\\u{27}') {} else { return 12 }
  if eq('\\"', '"') {} else { return 13 }
  if eq('\\x41', 'A') {} else { return 14 }
  if eq(' ', asciiSpace) {} else { return 15 }
  if eq('é', '\\u{e9}') {} else { return 16 }
  if eq('☃', snowman) {} else { return 17 }
  if lt('é', snowman) {} else { return 18 }
  if gt('😀', snowman) {} else { return 19 }
  if gt('\u{10ffff}', '\u{10000}') {} else { return 26 }
  if gt('\u{e000}', '\u{d7ff}') {} else { return 27 }
  if equals('a', 'a') {} else { return 20 }
  if notEquals('a', 'b') {} else { return 21 }
  if lessThan('a', 'b') {} else { return 22 }
  if lessOrEqual('a', 'b') {} else { return 23 }
  if greaterThan('b', 'a') {} else { return 24 }
  if greaterOrEqual('b', 'a') {} else { return 25 }
  let zero: u8 = '\\0'
  let scalar: u32 = '😀'
  if zero != 0 || scalar != 128512 { return 28 }
  if contextualByte('é') && contextualByte(accentByte) {} else { return 29 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'module-string-constants',
    source: `import silk.usize
import silk.string { String }
const escapedPattern: string<'static> = "\\\\d+\\\\.\\\\d+"
const rawPattern: string<'static> = r"\\d+\\.\\d+"
const windowsPath: string<'static> = r"C:\\Users\\build"
fn sameText(left: string, right: string) -> bool {
  if String.byteLength(left) != String.byteLength(right) { return false }
  let leftBytes = String.utf8Bytes(left)
  let rightBytes = String.utf8Bytes(right)
  let mut index = usize.ZERO
  while index < leftBytes.length {
    if leftBytes[index] != rightBytes[index] { return false }
    index = index + usize.ONE
  }
  return true
}
pub fn main() -> i32 {
  if !sameText(escapedPattern, r"\\d+\\.\\d+") { return 1 }
  if !sameText(rawPattern, "\\\\d+\\\\.\\\\d+") { return 2 }
  if !sameText(rawPattern, escapedPattern) { return 3 }
  if usize.toI32(String.byteLength(rawPattern)) != 8 { return 4 }
  if usize.toI32(String.byteLength(windowsPath)) != 14 { return 5 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'whole-member-layout-extraction',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout, LayoutOverflow }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
fn trapLayout() -> Layout { let boom = 1 / 0 return trapLayout() }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let plan = Layout.repeat(Layout.of<i32>(), 3)
  let layout = match move plan {
    Layout value => move value
    LayoutOverflow overflow => trapLayout()
  }
  let allocation = run Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<i32>(move allocation, 3)
    let written = Slot.write(RawBuffer.slot(&mut buffer, 2), 42)
    let taken = Slot.take(RawBuffer.slot(&mut buffer, 2))
    drop buffer
    return taken
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'whole-member-affine-extraction',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
struct Empty {}
struct Full { storage: Allocation }
fn wrap(cell: Full) -> Empty | Full { return move cell }
fn takeStorage(full: Full) -> Allocation {
  return match move full { Full { storage } => move storage }
}
effect fn fallback() -> Full ! OutOfMemoryError { fail OutOfMemoryError {} }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let allocation = run Allocator.allocate(Layout.of<[i32; 2]>())
    |> Effect.provideMut(&mut allocator)
  let widened = wrap(Full { storage: move allocation })
  let restored = match move widened {
    Empty empty => run fallback()
    Full full => Full { storage: takeStorage(move full) }
  }
  drop restored
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from ShortCircuitOperatorAcceptance.test.ts: the counter proves the right operand of
  // `&&`/`||` runs exactly when short-circuiting says it must.
  {
    name: 'short-circuit-counting',
    source: `struct Flag { value: bool }
fn unwrap(flag: Flag) -> bool { return flag.value }
fn chooseRight(gate: bool, flag: Flag) -> bool { return gate && unwrap(move flag) }
fn chooseLeft(gate: bool, flag: Flag) -> bool { return unwrap(move flag) && gate }

fn bump(counter: &mut [i32], answer: bool) -> bool {
  counter[0] = counter[0] + 1
  return answer
}

fn conjunction(gate: bool) -> i32 {
  let mut counter = [0]
  if gate && bump(&mut counter, true) { return counter[0] }
  return counter[0]
}

fn disjunction(gate: bool) -> i32 {
  let mut counter = [0]
  if gate || bump(&mut counter, true) { return counter[0] }
  return counter[0]
}

pub fn main() -> i32 {
  if chooseRight(false, Flag { value: true }) == false {} else { return 5 }
  if chooseRight(true, Flag { value: true }) {} else { return 6 }
  if chooseLeft(true, Flag { value: true }) {} else { return 7 }
  if chooseLeft(false, Flag { value: true }) == false {} else { return 8 }
  if conjunction(false) == 0 {} else { return 1 }
  if conjunction(true) == 1 {} else { return 2 }
  if disjunction(true) == 0 {} else { return 3 }
  if disjunction(false) == 1 {} else { return 4 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'bitwise-values-and-precedence',
    source: `import silk.u32
pub fn main() -> i32 {
  let a: u32 = 12
  let b: u32 = 10
  if (a & b) != u32.bitAnd(a, b) { return 1 }
  if (a | b) != u32.bitOr(a, b) { return 2 }
  if (a ^ b) != u32.bitXor(a, b) { return 3 }
  if ~a != u32.bitNot(a) { return 4 }
  if u32.toI32(a & b) != 8 { return 5 }
  if u32.toI32(a | b) != 14 { return 6 }
  if u32.toI32(a ^ b) != 6 { return 7 }
  if u32.toI32(1 | 2 ^ 3 & 1) != 3 { return 8 }
  if (6 & 3) == 2 {} else { return 9 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'option-result-combinators',
    source: `import silk.option { Option }
import silk.result { Result }

struct Wide { code: i32 }
struct Token { code: i32 }
fn double(value: i32) -> i32 { return value * 2 }
fn halve(value: i32) -> Option<i32> {
  if value == 0 { return Option.none<i32>() }
  return Option.some<i32>(value / 2)
}
fn addTwo(value: i32) -> i32 { return value + 2 }
fn halfResult(value: i32) -> Result<i32, i32> {
  if value == 0 { return Result.failResult<i32, i32>(9) }
  return Result.succeed<i32, i32>(value / 2)
}
fn widen(error: i32) -> Wide { return Wide { code: error + 30 } }
fn advance(token: Token) -> Token { return Token { code: token.code + 1 } }
fn observeWide(self: Result<i32, Wide>) -> i32 {
  return match move self {
    Result<i32, Wide>.Success { value: success } => success
    Result<i32, Wide>.Failure { error } => error.code
  }
}

pub fn main() -> i32 {
  let mappedSome = Option.map<i32, i32>(Option.some<i32>(20), double)
  let mappedNone = Option.map<i32, i32>(Option.none<i32>(), double)
  let chainedSome = Option.flatMap<i32, i32>(Option.some<i32>(80), halve)
  let chainedNone = Option.flatMap<i32, i32>(Option.some<i32>(0), halve)
  if Option.unwrapOr<i32>(move mappedSome, 0) != 40 { return 1 }
  if Option.unwrapOr<i32>(move mappedNone, 2) != 2 { return 2 }
  if Option.unwrapOr<i32>(move chainedSome, 0) != 40 { return 3 }
  if Option.unwrapOr<i32>(move chainedNone, 2) != 2 { return 4 }

  let mapped = Result.map<i32, i32, i32>(Result.succeed<i32, i32>(36), addTwo)
  let chained = Result.flatMap<i32, i32, i32>(move mapped, halfResult)
  if Result.unwrapOr<i32, i32>(move chained, 0) != 19 { return 5 }
  let carriedFailure = Result.map<i32, i32, i32>(Result.failResult<i32, i32>(7), addTwo)
  if Result.unwrapOr<i32, i32>(move carriedFailure, 23) != 23 { return 6 }
  let changed = Result.mapError<i32, i32, Wide>(Result.failResult<i32, i32>(4), widen)
  if observeWide(move changed) != 34 { return 7 }
  let movedOption = Option.map<Token, Token>(Option.some<Token>(Token { code: 40 }), advance)
  let optionToken = Option.unwrapOr<Token>(move movedOption, Token { code: 0 })
  if optionToken.code != 41 { return 8 }
  let movedResult = Result.map<Token, i32, Token>(
    Result.succeed<Token, i32>(move optionToken),
    advance,
  )
  let resultToken = match move movedResult {
    Result<Token, i32>.Success { value } => move value
    Result<Token, i32>.Failure { error } => Token { code: error }
  }
  if resultToken.code != 42 { return 9 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-higher-order-values',
    source: effectHigherOrderValues,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-source-combinators',
    source: `import silk.effect { Effect }
import silk.result { Result }

struct First { code: i32 }
struct Second { code: i32 }
struct Token { value: i32 }
effect fn succeed(value: i32) -> i32 ! First { return value }
effect fn failFirst() -> i32 ! First { fail First { code: 2 } }
fn addTwo(value: i32) -> i32 { return value + 2 }
effect fn addTwoEffect(value: i32) -> i32 ! Second { return value + 2 }
effect fn preserve(value: i32) -> i32 ! Second { return value }
effect fn recover(error: First) -> i32 ! Second { return error.code + 40 }
fn observeFirst(result: Result<i32, First>) -> i32 {
  return match move result {
    Result<i32, First>.Success { value } => value
    Result<i32, First>.Failure { error } => error.code
  }
}
fn observeBoth(result: Result<i32, First | Second>) -> i32 {
  return match move result {
    Result<i32, First | Second>.Success { value } => value
    Result<i32, First | Second>.Failure { error } => match move error {
      First { code: firstCode } => firstCode
      Second { code: secondCode } => secondCode
    }
  }
}
fn observeSecond(result: Result<i32, Second>) -> i32 {
  return match move result {
    Result<i32, Second>.Success { value } => value
    Result<i32, Second>.Failure { error } => error.code
  }
}
effect fn inner(value: i32) -> i32 { return value * 2 }
effect fn outer(value: i32) -> Effect<'static; i32> { return inner(value) }

pub fn main() -> i32 {
  let mapped = run Effect.result(succeed(40) |> Effect.map(addTwo))
  if observeFirst(move mapped) != 42 { return 1 }
  let chained = run Effect.result(succeed(40) |> Effect.flatMap(addTwoEffect))
  if observeBoth(move chained) != 42 { return 2 }
  let tapped = run Effect.result(succeed(42) |> Effect.tap(preserve))
  if observeBoth(move tapped) != 42 { return 3 }
  let recovered = run Effect.result(failFirst() |> Effect.catchAll(recover))
  if observeSecond(move recovered) != 42 { return 4 }
  let nested = outer(21)
  let flattened = Effect.flatten(move nested)
  let flattenedValue = run flattened
  if flattenedValue != 42 { return 5 }
  let created = Effect.of(42)
  let createdValue = run created
  if createdValue != 42 { return 6 }
  let tokenEffect = Effect.of(Token { value: 42 })
  let token = run tokenEffect
  if token.value != 42 { return 7 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'direct-suspend-continuation',
    source: readFileSync(
      new URL('../../conformance/native-report/direct-suspend-regression.silk', import.meta.url),
      'utf8',
    ),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-suspended-map-flat-map',
    source: `import silk.effect { Effect }
effect fn base() -> i32 { return run Effect.suspend(effect { return 20 }) }
fn double(value: i32) -> i32 { return value * 2 }
effect fn addTwo(value: i32) -> i32 { return value + 2 }
pub fn main() -> i32 {
  return run base() |> Effect.map(double) |> Effect.flatMap(addTwo)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-ensuring-fallible-finalizer',
    source: `import silk.effect { Effect }
struct Problem { code: i32 }
effect fn work() -> i32 ! Problem { fail Problem { code: 42 } }
effect fn stubborn() -> () ! Problem { fail Problem { code: 8 } }
effect fn swallow(problem: Problem) -> () { return () }
effect fn tolerant() -> () { return run Effect.catchAll(stubborn(), swallow) }
effect fn recover(problem: Problem) -> i32 { return problem.code }
pub fn main() -> i32 {
  return run Effect.catchAll(Effect.ensuring(work(), tolerant()), recover)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-string-failure-channel',
    source: `import silk.effect { Effect }
effect fn failText() -> i32 ! string<'static> { fail "oops" }
effect fn recoverText(error: string<'static>) -> i32 { return 42 }
pub fn main() -> i32 { return run Effect.catchAll(failText(), recoverText) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'result-alternate-generic-union',
    source: `import silk.effect { Effect }
union Outcome<A, E> { Good { value: A }, Bad { error: E } }
struct First { code: i32 }
struct Second { code: i32 }
fn good<A, E>(value: A) -> Outcome<A, E> { return Outcome<A, E>.Good { value: move value } }
effect fn bad<A, E>(error: E) -> Outcome<A, E> { return Outcome<A, E>.Bad { error: move error } }
effect fn outcome<A, E>(protected: once Effect<A ! E>) -> Outcome<A, E> {
  let succeeded = Effect.map<A, Outcome<A, E>, E>(move protected, good)
  return run Effect.catchAll<Outcome<A, E>, Outcome<A, E>, E, never>(move succeeded, bad)
}
effect fn choose(kind: i32) -> i32 ! First | Second {
  if kind == 0 { return 5 }
  if kind == 1 { fail First { code: 20 } }
  fail Second { code: 22 }
}
effect fn inspect(kind: i32) -> i32 {
  return match move (run outcome(choose(kind))) {
    Outcome<i32, First | Second>.Good { value } => value
    Outcome<i32, First | Second>.Bad { error } => match move error {
      First { code } => code
      Second { code } => code
    }
  }
}
pub fn main() -> i32 { return (run inspect(0)) + (run inspect(1)) + (run inspect(2)) - 5 }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'result-source-channel-maps',
    source: `import silk.effect { Effect }
import silk.result { Result }
struct First { code: i32 }
struct Second { code: i32 }
struct Adjustment { offset: i32 }
effect fn succeed() -> i32 ! First { return 40 }
effect fn failFirst() -> i32 ! First { fail First { code: 2 } }
fn addTwo(value: i32) -> i32 { return value + 2 }
fn toSecond(error: First, adjustment: Adjustment) -> Second { return Second { code: error.code + adjustment.offset } }
fn observe(result: Result<i32, Second>) -> i32 {
  return match move result {
    Result<i32, Second>.Success { value } => value
    Result<i32, Second>.Failure { error } => error.code
  }
}
pub fn main() -> i32 {
  let success = run Effect.result(succeed() |> Effect.mapError(toSecond(Adjustment { offset: 40 })) |> Effect.map(addTwo))
  let failure = run Effect.result(failFirst() |> Effect.mapBoth(addTwo, toSecond(Adjustment { offset: 40 })))
  return observe(move success) + observe(move failure) - 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-retry-and-provide-effect',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.shared { Shared }

struct Problem { code: i32 }
service Clock { effect fn value() -> i32 ? &Clock }
struct FixedClock { value: i32 }
effect fn clockValue(self: &FixedClock) -> i32 { return self.value }
impl Clock for FixedClock { value: FixedClock.clockValue }
struct Lifecycle { acquired: i32 released: i32 valid: bool }
struct TrackedClock { value: i32 lifecycle: Shared<Lifecycle> }
fn acquire(lifecycle: &mut Lifecycle) -> i32 {
  if lifecycle.acquired != lifecycle.released { lifecycle.valid = false }
  lifecycle.acquired = lifecycle.acquired + 1
  return 0
}
fn release(lifecycle: &mut Lifecycle) -> i32 {
  if lifecycle.acquired != (lifecycle.released + 1) { lifecycle.valid = false }
  lifecycle.released = lifecycle.released + 1
  return 0
}
fn lifecycleAccepted(lifecycle: &Lifecycle) -> bool {
  return lifecycle.valid && lifecycle.acquired == 3 && lifecycle.released == 3
}
effect fn trackedClockValue(self: &TrackedClock) -> i32 { return self.value }
impl Clock for TrackedClock { value: TrackedClock.trackedClockValue }
impl Drop for TrackedClock {
  fn drop(self: &mut TrackedClock) -> () {
    let changed = Shared.withMut<Lifecycle, i32>(&self.lifecycle, release)
    return ()
  }
}
effect fn read() -> i32 ? &Clock { return run Clock.value() }
effect fn nestedRead(inner: &FixedClock) -> i32 ? &Clock {
  let before = run read()
  let inside = run read() |> Effect.provide(inner)
  let after = run read()
  return before + inside + after
}
effect fn makeClock() -> FixedClock { return FixedClock { value: 42 } }
effect fn makeTrackedClock(lifecycle: &Shared<Lifecycle>) -> TrackedClock {
  let changed = Shared.withMut<Lifecycle, i32>(lifecycle, acquire)
  return TrackedClock { value: 42, lifecycle: Shared.clone<Lifecycle>(lifecycle) }
}
effect fn readAndFail() -> i32 ! Problem ? &Clock {
  let value = run Clock.value()
  fail Problem { code: value }
}
effect fn succeed() -> i32 ! Problem { return 42 }
effect fn failAlways() -> i32 ! Problem { fail Problem { code: 2 } }
effect fn recoverProblem(error: Problem) -> i32 { return error.code }
fn addForty(value: i32) -> i32 { return value + 40 }
fn addThirtyNine(value: i32) -> i32 { return value + 39 }
effect fn retryThenSucceed() -> i32 ! Problem {
  let mut count = 0
  let attempt = effect {
    count = count + 1
    if count < 3 { fail Problem { code: count } }
    return count
  }
  return run move attempt |> Effect.retry(2)
}
fn observe(result: Result<i32, Problem>) -> i32 {
  return match move result {
    Result<i32, Problem>.Success { value } => value
    Result<i32, Problem>.Failure { error } => error.code
  }
}

effect fn scenario() -> i32 ! OutOfMemoryError {
  let success = run Effect.result(succeed() |> Effect.retry(3))
  let failure = run Effect.result(failAlways() |> Effect.retry(2))
  if observe(move success) != 42 { return 1 }
  if observe(move failure) != 2 { return 2 }
  let fixed = FixedClock { value: 42 }
  let direct = run read() |> Effect.provide(&fixed)
  if direct != 42 { return 3 }
  let provided = run read() |> Effect.provideEffect(makeClock())
  if provided != 42 { return 4 }
  let outer = FixedClock { value: 20 }
  let inner = FixedClock { value: 2 }
  let nested = run nestedRead(&inner) |> Effect.provide(&outer)
  if nested != 42 { return 5 }
  let mut allocator = Allocator.systemAllocatorProvider()
  let lifecycle = run Shared.make<Lifecycle>(Lifecycle {
    acquired: 0,
    released: 0,
    valid: true,
  }) |> Effect.provideMut<Allocator>(&mut allocator)
  let tracked = readAndFail()
    |> Effect.provideEffect<Clock>(makeTrackedClock(&lifecycle))
    |> Effect.retry(2)
  let trackedResult = run Effect.result(move tracked)
  if observe(move trackedResult) != 42 { return 6 }
  let balanced = Shared.with<Lifecycle, bool>(&lifecycle, lifecycleAccepted)
  drop lifecycle
  if !balanced { return 7 }
  let recoveredMapped = run (
    failAlways()
      |> Effect.catchAll(recoverProblem)
      |> Effect.map(addForty)
  )
  if recoveredMapped != 42 { return 8 }
  let retryMapped = run retryThenSucceed()
    |> Effect.catchAll(recoverProblem)
    |> Effect.map(addThirtyNine)
  if retryMapped != 42 { return 9 }
  return 42
}
effect fn recoverAllocation(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(scenario(), recoverAllocation) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-ensuring-outcomes-and-order',
    source: `import silk.effect { Effect }

struct Problem { code: i32 }
service Journal { effect fn mark(value: i32) -> () ? &mut Journal }
struct MemoryJournal { value: i32 }
effect fn mark(self: &mut MemoryJournal, value: i32) -> () {
  self.value = self.value * 10 + value
  return ()
}
impl Journal for MemoryJournal { mark: MemoryJournal.mark }
effect fn succeed() -> i32 ? &mut Journal { run Journal.mark(1) return 5 }
effect fn failWork() -> i32 ! Problem ? &mut Journal {
  run Journal.mark(1)
  fail Problem { code: 3 }
}
effect fn finalize() -> () ? &mut Journal { return run Journal.mark(2) }
effect fn recover(error: Problem) -> i32 { return error.code }

pub fn main() -> i32 {
  let mut first = MemoryJournal { value: 0 }
  let success = run Effect.ensuring(succeed(), finalize()) |> Effect.provideMut(&mut first)
  if success != 5 { return 1 }
  if first.value != 12 { return 2 }
  let mut second = MemoryJournal { value: 0 }
  let guarded = Effect.ensuring(failWork(), finalize()) |> Effect.catchAll(recover)
  let failure = run guarded |> Effect.provideMut(&mut second)
  if failure != 3 { return 3 }
  if second.value != 12 { return 4 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-ensuring-finalized-choice',
    source: readFileSync(
      new URL('../../conformance/execution-storage/finalized-choice.silk', import.meta.url),
      'utf8',
    ),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-zip-order-and-failures',
    source: `import silk.effect { Effect }
import silk.effect { Pair, Triple }

struct Problem { code: i32 }
service Journal { effect fn mark(value: i32) -> () ? &mut Journal }
struct MemoryJournal { value: i32 }
effect fn mark(self: &mut MemoryJournal, value: i32) -> () {
  self.value = self.value * 10 + value
  return ()
}
impl Journal for MemoryJournal { mark: MemoryJournal.mark }
effect fn first() -> i32 ? &mut Journal { run Journal.mark(1) return 20 }
effect fn second() -> i32 ? &mut Journal { run Journal.mark(2) return 22 }
effect fn third() -> i32 ? &mut Journal { run Journal.mark(3) return 0 }
effect fn failFirst() -> i32 ! Problem ? &mut Journal {
  run Journal.mark(1)
  fail Problem { code: 7 }
}
effect fn failSecond() -> i32 ! Problem ? &mut Journal {
  run Journal.mark(2)
  fail Problem { code: 8 }
}
fn pairValue(pair: Pair<i32, i32>) -> i32 { return pair.first + pair.second }
fn tripleValue(triple: Triple<i32, i32, i32>) -> i32 {
  return triple.first + triple.second + triple.third
}
effect fn recover(error: Problem) -> i32 { return error.code }

pub fn main() -> i32 {
  let mut successLog = MemoryJournal { value: 0 }
  let success = run Effect.zip(first(), second()) |> Effect.map(pairValue)
    |> Effect.provideMut(&mut successLog)
  if success != 42 { return 1 }
  if successLog.value != 12 { return 2 }
  let mut pipedLog = MemoryJournal { value: 0 }
  let piped = run first() |> Effect.zip(second()) |> Effect.map(pairValue)
    |> Effect.provideMut(&mut pipedLog)
  if piped != 42 { return 9 }
  if pipedLog.value != 12 { return 10 }
  let mut tripleLog = MemoryJournal { value: 0 }
  let triple = run Effect.zip3(first(), second(), third()) |> Effect.map(tripleValue)
    |> Effect.provideMut(&mut tripleLog)
  if triple != 42 { return 3 }
  if tripleLog.value != 123 { return 4 }
  let mut firstFailureLog = MemoryJournal { value: 0 }
  let firstFailure = run Effect.zip(failFirst(), second()) |> Effect.map(pairValue)
    |> Effect.catchAll(recover) |> Effect.provideMut(&mut firstFailureLog)
  if firstFailure != 7 { return 5 }
  if firstFailureLog.value != 1 { return 6 }
  let mut secondFailureLog = MemoryJournal { value: 0 }
  let secondFailure = run Effect.zip(first(), failSecond()) |> Effect.map(pairValue)
    |> Effect.catchAll(recover) |> Effect.provideMut(&mut secondFailureLog)
  if secondFailure != 8 { return 7 }
  if secondFailureLog.value != 12 { return 8 }
  let mut middleFailureLog = MemoryJournal { value: 0 }
  let middleFailure = run Effect.zip3(first(), failSecond(), third())
    |> Effect.map(tripleValue)
    |> Effect.catchAll(recover)
    |> Effect.provideMut(&mut middleFailureLog)
  if middleFailure != 8 { return 11 }
  if middleFailureLog.value != 12 { return 12 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from Transcendental.test.ts: bit-exact sin/cos results in native execution.
  {
    name: 'transcendental-canonical-bits',
    source: transcendentalCanonicalBits,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from HashedCollections.test.ts: seeded map growth with checked reads.
  {
    name: 'hashed-map-seeded-order-12345',
    source: hashedMapOrder(12345, 971199974),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'hashed-map-seeded-order-6789',
    source: hashedMapOrder(6789, 434552010),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'hashed-collection-operations',
    source: `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.hash { Hash, HashKey, HashSeed, Word }
import silk.hash_map { HashMap }
import silk.hash_set { HashSet }
import silk.option { Option }
import silk.u64

struct Counter { value: i32 calls: i32 }
impl Copy for Counter {}
struct Key { value: i32 }
impl Copy for Key {}
fn keyEquals(left: &Key, right: &Key) -> bool { return left.value == right.value }
fn keyHash(value: &Key, seed: &HashSeed) -> u64 { return 1 }
impl HashKey for Key { equals: Key.keyEquals hash: Key.keyHash }
fn setFortyTwo(value: &mut Counter) -> () {
  value.value = 42
  value.calls = value.calls + 1
  return ()
}
fn mustNotRun(value: &mut Counter) -> () {
  let boom = 1 / 0
  return ()
}

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut map = HashMap.make<Word, i32>(Hash.seed(12345))
  let first = run HashMap.insert<Word, i32>(&mut map, Hash.word(7), 20)
    |> Effect.provideMut(&mut allocator)
  let second = run HashMap.insert<Word, i32>(&mut map, Hash.word(9), 22)
    |> Effect.provideMut(&mut allocator)
  drop first
  drop second
  if HashMap.length<Word, i32>(&map) != 2 { return 1 }
  if !HashMap.contains<Word, i32>(&map, Hash.word(7)) { return 2 }
  let taken = HashMap.remove<Word, i32>(&mut map, Hash.word(7))
  let removed = Option.unwrapOr<i32>(move taken, 0)
  let held = Option.unwrapOr<i32>(HashMap.get<Word, i32>(&map, Hash.word(9)), 0)
  if removed + held != 42 { return 3 }
  if HashMap.contains<Word, i32>(&map, Hash.word(7)) { return 4 }

  let mut counters = HashMap.make<Word, Counter>(Hash.seed(17))
  let initial = Counter { value: 20, calls: 0 }
  let inserted = run HashMap.insert<Word, Counter>(&mut counters, Hash.word(7), move initial)
    |> Effect.provideMut(&mut allocator)
  drop inserted
  if HashMap.withMut(&mut counters, Hash.word(9), mustNotRun) { return 5 }
  if !HashMap.withMut(&mut counters, Hash.word(7), setFortyTwo) { return 6 }
  let fallback = Counter { value: 0, calls: 0 }
  let changed = Option.unwrapOr<Counter>(
    HashMap.get<Word, Counter>(&counters, Hash.word(7)),
    move fallback,
  )
  if changed.value != 42 || changed.calls != 1 { return 7 }

  let mut collisions = HashMap.make<Key, i32>(Hash.seed(1))
  let keyOne = run HashMap.insert<Key, i32>(&mut collisions, Key { value: 1 }, 10)
    |> Effect.provideMut(&mut allocator)
  let keyTwo = run HashMap.insert<Key, i32>(&mut collisions, Key { value: 2 }, 20)
    |> Effect.provideMut(&mut allocator)
  let keyThree = run HashMap.insert<Key, i32>(&mut collisions, Key { value: 3 }, 30)
    |> Effect.provideMut(&mut allocator)
  drop keyOne
  drop keyTwo
  drop keyThree
  let tombstone = HashMap.remove<Key, i32>(&mut collisions, Key { value: 2 })
  drop tombstone
  let beyondTombstone = Option.unwrapOr<i32>(
    HashMap.get<Key, i32>(&collisions, Key { value: 3 }),
    0,
  )
  if beyondTombstone != 30 { return 11 }
  let replaced = run HashMap.insert<Key, i32>(&mut collisions, Key { value: 1 }, 41)
    |> Effect.provideMut(&mut allocator)
  if Option.unwrapOr<i32>(move replaced, 0) != 10 { return 12 }
  if HashMap.length<Key, i32>(&collisions) != 2 { return 13 }

  let mut set = HashSet.make<Word>(Hash.seed(99))
  let setFirst = run HashSet.insert<Word>(&mut set, Hash.word(7))
    |> Effect.provideMut(&mut allocator)
  let setAgain = run HashSet.insert<Word>(&mut set, Hash.word(7))
    |> Effect.provideMut(&mut allocator)
  if setFirst || !setAgain { return 8 }
  if !HashSet.contains<Word>(&set, Hash.word(7)) { return 9 }
  let setTaken = HashSet.remove<Word>(&mut set, Hash.word(7))
  let gone = match move setTaken {
    Option<Word>.Some { value } => u64.toI32(value.value)
    Option<Word>.None => 0
  }
  if gone != 7 || HashSet.contains<Word>(&set, Hash.word(7)) { return 10 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'hashed-collection-owned-lifecycle',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.hash { Hash, HashKey, HashSeed }
import silk.hash_map { HashMap }
import silk.i32
import silk.shared { Shared }

struct Counts { keys: i32 values: i32 }
fn countKey(counts: &mut Counts) -> i32 {
  counts.keys = counts.keys + 1
  return 0
}
fn countValue(counts: &mut Counts) -> i32 {
  counts.values = counts.values + 1
  return 0
}
fn accepted(counts: &Counts) -> bool {
  return counts.keys == 15 && counts.values == 13
}

struct Key { id: i32 counts: Shared<Counts> }
struct Held { id: i32 counts: Shared<Counts> }
struct Empty {}
struct Filled { payload: Held }
struct Cell { slot: Empty | Filled }
struct Capture { slot: Empty | Filled }
fn keyEquals(left: &Key, right: &Key) -> bool { return left.id == right.id }
fn keyHash(value: &Key, seed: &HashSeed) -> u64 { return i32.toU64(value.id) }
impl HashKey for Key { equals: Key.keyEquals hash: Key.keyHash }
impl Drop for Key {
  fn drop(self: &mut Key) -> () {
    let changed = Shared.withMut<Counts, i32>(&self.counts, countKey)
    return ()
  }
}
impl Drop for Held {
  fn drop(self: &mut Held) -> () {
    let changed = Shared.withMut<Counts, i32>(&self.counts, countValue)
    return ()
  }
}
fn key(id: i32, counts: &Shared<Counts>) -> Key {
  return Key { id: id, counts: Shared.clone<Counts>(counts) }
}
fn held(id: i32, counts: &Shared<Counts>) -> Held {
  return Held { id: id, counts: Shared.clone<Counts>(counts) }
}
fn extractInto(cell: &mut Cell, output: &mut Capture) -> () {
  let previous = Intrinsic.replace(cell.slot, Empty {})
  output.slot = move previous
  return ()
}
fn heldTag(value: Held) -> i32 { return value.id }

effect fn fillAndDrop(counts: Shared<Counts>) -> ()
! OutOfMemoryError
? &mut Allocator {
  let mut map = HashMap.make<Key, Held>(Hash.seed(9))
  let mut index = 0
  while index < 10 {
    let previous = run HashMap.insert<Key, Held>(
      &mut map,
      key(index, &counts),
      held(index, &counts),
    )
    drop previous
    index = index + 1
  }
  drop map
  drop counts
  return ()
}

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counts = run Shared.make<Counts>(Counts { keys: 0, values: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut map = HashMap.make<Key, Held>(Hash.seed(3))
  let first = run HashMap.insert<Key, Held>(&mut map, key(7, &counts), held(11, &counts))
    |> Effect.provideMut(&mut allocator)
  drop first
  let displaced = run HashMap.insert<Key, Held>(&mut map, key(7, &counts), held(31, &counts))
    |> Effect.provideMut(&mut allocator)
  drop displaced
  if HashMap.length<Key, Held>(&map) != 1 { return 1 }
  let removed = HashMap.remove<Key, Held>(&mut map, key(7, &counts))
  drop removed
  if HashMap.length<Key, Held>(&map) != 0 { return 2 }
  drop map

  let mut cells = HashMap.make<Key, Cell>(Hash.seed(6))
  let insertedCell = run HashMap.insert<Key, Cell>(
    &mut cells,
    key(8, &counts),
    Cell { slot: Filled { payload: held(42, &counts) } },
  ) |> Effect.provideMut(&mut allocator)
  drop insertedCell
  let mut capture = Capture { slot: Empty {} }
  let found = HashMap.withMut(
    &mut cells,
    key(8, &counts),
    extractInto(&mut capture),
  )
  if !found { return 3 }
  let extracted = match move capture {
    Capture { slot } => match move slot {
      Empty {} => 0
      Filled { payload } => heldTag(move payload)
    }
  }
  drop cells
  if extracted != 42 { return 4 }

  let fillingCounts = Shared.clone<Counts>(&counts)
  let filled = run fillAndDrop(move fillingCounts) |> Effect.provideMut(&mut allocator)
  drop filled
  let result = Shared.with<Counts, bool>(&counts, accepted)
  drop counts
  if result { return 42 }
  return 5
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'hashed-map-growth',
    source: `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.i32
import silk.hash { Hash }
import silk.hash { HashKey, HashSeed, Word }
import silk.hash_map { HashMap }
import silk.option { Option }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut map = HashMap.make<Word, i32>(Hash.seed(4242))
  let mut key = 0
  while key < 40 {
    let previous = run HashMap.insert<Word, i32>(&mut map, Hash.word(i32.toU64(key)), key * 3)
      |> Effect.provideMut(&mut allocator)
    drop previous
    key = key + 1
  }
  if HashMap.length<Word, i32>(&map) != 40 { return 1 }
  if HashMap.bucketCount<Word, i32>(&map) <= 40 { return 2 }
  let mut probe = 0
  let mut total = 0
  while probe < 40 {
    let found = Option.unwrapOr<i32>(HashMap.get<Word, i32>(&map, Hash.word(i32.toU64(probe))), -1)
    if found != probe * 3 { return 3 }
    total = total + found
    probe = probe + 1
  }
  if total != 2340 { return 4 }
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // A failed rehash is atomic: the original table and all six entries remain observable.
  {
    name: 'hashed-map-failed-growth',
    source: `import silk.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.effect { Effect }
import silk.hash { Hash, Word }
import silk.hash_map { HashMap }
import silk.i32
import silk.layout { Layout }
import silk.option { Option }
import silk.usize

struct Budget { inner: SystemAllocator remaining: usize }

effect fn allocate(self: &mut Budget, layout: Layout) -> Allocation ! OutOfMemoryError {
  if self.remaining == usize.ZERO { fail OutOfMemoryError {} }
  self.remaining = self.remaining - usize.ONE
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut self.inner)
}
impl Allocator for Budget { allocate: Budget.allocate }

effect fn grow(map: &mut HashMap<Word, i32>) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let previous = run HashMap.insert<Word, i32>(move map, Hash.word(6), 106)
  drop previous
  return 0
}
effect fn noRoom(error: OutOfMemoryError) -> i32 { return 1 }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Budget { inner: Allocator.systemAllocatorProvider(), remaining: 2 }
  let mut map = HashMap.make<Word, i32>(Hash.seed(5))
  let mut key = 0
  while key < 6 {
    let previous = run HashMap.insert<Word, i32>(&mut map, Hash.word(i32.toU64(key)), key + 100)
      |> Effect.provideMut(&mut allocator)
    drop previous
    key = key + 1
  }
  if HashMap.length<Word, i32>(&map) != 6 { return 2 }
  let refused = run Effect.catchAll(grow(&mut map), noRoom) |> Effect.provideMut(&mut allocator)
  if refused != 1 { return 3 }
  if HashMap.length<Word, i32>(&map) != 6 { return 4 }
  if HashMap.bucketCount<Word, i32>(&map) != 8 { return 5 }
  if HashMap.contains<Word, i32>(&map, Hash.word(6)) { return 6 }
  let mut probe = 0
  let mut total = 0
  while probe < 6 {
    let found = Option.unwrapOr<i32>(
      HashMap.get<Word, i32>(&map, Hash.word(i32.toU64(probe))),
      -1,
    )
    if found != probe + 100 { return 7 }
    total = total + found
    probe = probe + 1
  }
  if total != 615 { return 8 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from VectorAcceptance.test.ts: growth past the initial capacity with boundary reads.
  {
    name: 'vector-growth-reads',
    source: `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.vector { Vector }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut values = Vector.make<i32>()
  let pending0 = Vector.append<i32>(&mut values, 10) |> Effect.provideMut(&mut allocator)
  let appended0 = run pending0
  let pending1 = Vector.append<i32>(&mut values, 11) |> Effect.provideMut(&mut allocator)
  let appended1 = run pending1
  let pending2 = Vector.append<i32>(&mut values, 12) |> Effect.provideMut(&mut allocator)
  let appended2 = run pending2
  let pending3 = Vector.append<i32>(&mut values, 13) |> Effect.provideMut(&mut allocator)
  let appended3 = run pending3
  let pending4 = Vector.append<i32>(&mut values, 14) |> Effect.provideMut(&mut allocator)
  let appended4 = run pending4
  let pending5 = Vector.append<i32>(&mut values, 15) |> Effect.provideMut(&mut allocator)
  let appended5 = run pending5
  if Vector.length<i32>(&values) == 6 {} else { return 0 }
  if Vector.capacity<i32>(&values) == 8 {} else { return 1 }
  let first = Vector.get<i32>(&values, 0)
  let last = Vector.get<i32>(&values, 5)
  return first + last + 17
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'vector-mutation-views-and-capacity',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.option { Option }
import silk.usize
import silk.vector { Vector }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut values = Vector.make<i32>()
  let a = run Vector.append<i32>(&mut values, 10) |> Effect.provideMut(&mut allocator)
  let b = run Vector.append<i32>(&mut values, 20) |> Effect.provideMut(&mut allocator)
  let c = run Vector.append<i32>(&mut values, 30) |> Effect.provideMut(&mut allocator)
  let d = run Vector.append<i32>(&mut values, 40) |> Effect.provideMut(&mut allocator)
  let originalCapacity = Vector.capacity<i32>(&values)
  let mutable = Vector.asMutSlice<i32>(&mut values)
  mutable[usize.ONE] = 22
  Vector.set<i32>(&mut values, usize.ONE + usize.ONE, 33)
  let shared = Vector.asSlice<i32>(&values)
  if shared[usize.ZERO] != 10 { return 1 }
  if shared[usize.ONE] != 22 { return 2 }
  if shared[usize.ONE + usize.ONE] != 33 { return 3 }
  let removed = Vector.remove<i32>(&mut values, usize.ONE)
  if removed != 22 { return 4 }
  if Vector.get<i32>(&values, usize.ONE) != 33 { return 5 }
  let popped = Vector.pop<i32>(&mut values)
  let poppedValue = match move popped {
    Option<i32>.Some { value } => value
    Option<i32>.None => 0
  }
  if poppedValue != 40 { return 6 }
  if Vector.length<i32>(&values) != 2 { return 10 }
  Vector.truncate<i32>(&mut values, usize.ONE)
  if Vector.length<i32>(&values) != usize.ONE { return 7 }
  Vector.clear<i32>(&mut values)
  if Vector.length<i32>(&values) != usize.ZERO { return 8 }
  if Vector.capacity<i32>(&values) != originalCapacity { return 9 }
  let empty = Vector.pop<i32>(&mut values)
  return match move empty {
    Option<i32>.Some { value } => 10
    Option<i32>.None => 42
  }
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'vector-failed-growth-and-reserve-rollback',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.vector { Vector }
struct QuotaAllocator { remaining: i32 }
effect fn allocate(self: &mut QuotaAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  if self.remaining == 0 { fail OutOfMemoryError {} }
  self.remaining = self.remaining - 1
  let mut inner = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut inner)
}
impl Allocator for QuotaAllocator { allocate: QuotaAllocator.allocate }
effect fn append(values: &mut Vector<i32>, value: i32) -> () ! OutOfMemoryError ? &mut Allocator {
  return run Vector.append<i32>(move values, value)
}
effect fn reserve(values: &mut Vector<i32>) -> () ! OutOfMemoryError ? &mut Allocator {
  return run Vector.reserve<i32>(move values, 100)
}
effect fn rejected(error: OutOfMemoryError) -> () { return () }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = QuotaAllocator { remaining: 1 }
  let mut values = Vector.make<i32>()
  let a = run append(&mut values, 10) |> Effect.provideMut(&mut allocator)
  let b = run append(&mut values, 11) |> Effect.provideMut(&mut allocator)
  let c = run append(&mut values, 12) |> Effect.provideMut(&mut allocator)
  let d = run append(&mut values, 13) |> Effect.provideMut(&mut allocator)
  let growth = run Effect.catchAll(
    append(&mut values, 14) |> Effect.provideMut(&mut allocator),
    rejected,
  )
  drop growth
  if Vector.length<i32>(&values) != 4 || Vector.capacity<i32>(&values) != 4 { return 2 }
  if Vector.get<i32>(&values, 0) != 10 || Vector.get<i32>(&values, 3) != 13 { return 3 }
  let reserved = run Effect.catchAll(
    reserve(&mut values) |> Effect.provideMut(&mut allocator),
    rejected,
  )
  drop reserved
  if Vector.length<i32>(&values) != 4 || Vector.capacity<i32>(&values) != 4 { return 5 }
  if Vector.get<i32>(&values, 0) != 10 || Vector.get<i32>(&values, 3) != 13 { return 6 }
  return 42
}
effect fn outer(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), outer) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'vector-sort-search-stability',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.option { Option }
import silk.order { Order }
import silk.usize
import silk.vector { Vector }

struct Item { key: i32 tag: i32 }
fn itemLess(left: &Item, right: &Item) -> bool { return left.key < right.key }
impl Order for Item { lessThan: Item.itemLess }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut items = Vector.make<Item>()
  let a = run Vector.append<Item>(&mut items, Item { key: 1, tag: 1 }) |> Effect.provideMut(&mut allocator)
  let b = run Vector.append<Item>(&mut items, Item { key: 0, tag: 2 }) |> Effect.provideMut(&mut allocator)
  let c = run Vector.append<Item>(&mut items, Item { key: 1, tag: 3 }) |> Effect.provideMut(&mut allocator)
  let d = run Vector.append<Item>(&mut items, Item { key: 0, tag: 4 }) |> Effect.provideMut(&mut allocator)
  let ordered = run Vector.sort<Item>(&mut items) |> Effect.provideMut(&mut allocator)
  let view = Vector.asSlice<Item>(&items)
  let folded = view[usize.ZERO].tag * 1000 + view[usize.ONE].tag * 100
    + view[usize.ONE + usize.ONE].tag * 10 + view[usize.ONE + usize.ONE + usize.ONE].tag
  if folded != 2413 { return 1 }

  let mut numbers = Vector.make<i32>()
  let n0 = run Vector.append<i32>(&mut numbers, 9) |> Effect.provideMut(&mut allocator)
  let n1 = run Vector.append<i32>(&mut numbers, 2) |> Effect.provideMut(&mut allocator)
  let n2 = run Vector.append<i32>(&mut numbers, 7) |> Effect.provideMut(&mut allocator)
  let n3 = run Vector.append<i32>(&mut numbers, 2) |> Effect.provideMut(&mut allocator)
  let n4 = run Vector.append<i32>(&mut numbers, 5) |> Effect.provideMut(&mut allocator)
  let sorted = run Vector.sort<i32>(&mut numbers) |> Effect.provideMut(&mut allocator)
  let hit = Vector.binarySearch<i32>(&numbers, 7)
  let miss = Vector.binarySearch<i32>(&numbers, 4)
  let duplicate = Vector.binarySearch<i32>(&numbers, 2)
  let below = Vector.binarySearch<i32>(&numbers, -1)
  let above = Vector.binarySearch<i32>(&numbers, 10)
  let hitIndex = match move hit { Option<usize>.Some { value } => usize.toI32(value) _ => -1 }
  let missIndex = match move miss { Option<usize>.Some { value } => usize.toI32(value) _ => -1 }
  let duplicateIndex = match move duplicate { Option<usize>.Some { value } => usize.toI32(value) _ => -1 }
  if hitIndex != 3 { return 2 }
  if missIndex != -1 { return 3 }
  if duplicateIndex != 0 { return 4 }
  let belowIndex = match move below { Option<usize>.Some { value } => usize.toI32(value) _ => -1 }
  let aboveIndex = match move above { Option<usize>.Some { value } => usize.toI32(value) _ => -1 }
  if belowIndex != -1 || aboveIndex != -1 { return 6 }

  let mut already = Vector.make<i32>()
  let a0 = run Vector.append<i32>(&mut already, 1) |> Effect.provideMut(&mut allocator)
  let a1 = run Vector.append<i32>(&mut already, 2) |> Effect.provideMut(&mut allocator)
  let a2 = run Vector.append<i32>(&mut already, 3) |> Effect.provideMut(&mut allocator)
  let alreadySorted = run Vector.sort<i32>(&mut already) |> Effect.provideMut(&mut allocator)
  if Vector.get<i32>(&already, usize.ZERO) != 1 { return 7 }
  if Vector.get<i32>(&already, usize.ONE) != 2 { return 7 }
  if Vector.get<i32>(&already, usize.ONE + usize.ONE) != 3 { return 7 }

  let mut empty = Vector.make<i32>()
  let emptyMiss = Vector.binarySearch<i32>(&empty, 1)
  let emptySorted = run Vector.sort<i32>(&mut empty) |> Effect.provideMut(&mut allocator)
  let mut singleton = Vector.make<i32>()
  let one = run Vector.append<i32>(&mut singleton, 42) |> Effect.provideMut(&mut allocator)
  let singletonSorted = run Vector.sort<i32>(&mut singleton) |> Effect.provideMut(&mut allocator)
  if Vector.get<i32>(&singleton, usize.ZERO) != 42 { return 8 }
  return match move emptyMiss { Option<usize>.Some { value } => 5 _ => 42 }
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'vector-move-only-sort-and-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.order { Order }
import silk.shared { Shared }
import silk.usize
import silk.vector { Vector }

struct Counts { dropped: i32 }
struct Tracked { key: i32 payload: Vector<i32> counts: Shared<Counts> }
fn trackedLess(left: &Tracked, right: &Tracked) -> bool { return left.key < right.key }
impl Order for Tracked { lessThan: Tracked.trackedLess }
fn countDrop(counts: &mut Counts) -> i32 {
  counts.dropped = counts.dropped + 1
  return counts.dropped
}
fn readDrops(counts: &Counts) -> i32 { return counts.dropped }
impl Drop for Tracked {
  fn drop(self: &mut Tracked) -> () {
    let changed = Shared.withMut<Counts, i32>(&self.counts, countDrop)
    return ()
  }
}
effect fn hold(key: i32, counts: &Shared<Counts>) -> Tracked
! OutOfMemoryError
? &mut Allocator {
  let mut payload = Vector.make<i32>()
  let filled = run Vector.append<i32>(&mut payload, key)
  return Tracked {
    key: key,
    payload: move payload,
    counts: Shared.clone<Counts>(counts),
  }
}
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counts = run Shared.make<Counts>(Counts { dropped: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut items = Vector.make<Tracked>()
  let first = run hold(3, &counts) |> Effect.provideMut(&mut allocator)
  let a = run Vector.append<Tracked>(&mut items, move first) |> Effect.provideMut(&mut allocator)
  let second = run hold(1, &counts) |> Effect.provideMut(&mut allocator)
  let b = run Vector.append<Tracked>(&mut items, move second) |> Effect.provideMut(&mut allocator)
  let third = run hold(2, &counts) |> Effect.provideMut(&mut allocator)
  let c = run Vector.append<Tracked>(&mut items, move third) |> Effect.provideMut(&mut allocator)
  let fourth = run hold(5, &counts) |> Effect.provideMut(&mut allocator)
  let d = run Vector.append<Tracked>(&mut items, move fourth) |> Effect.provideMut(&mut allocator)
  let fifth = run hold(4, &counts) |> Effect.provideMut(&mut allocator)
  let e = run Vector.append<Tracked>(&mut items, move fifth) |> Effect.provideMut(&mut allocator)
  let ordered = run Vector.sort<Tracked>(&mut items) |> Effect.provideMut(&mut allocator)
  let view = Vector.asSlice<Tracked>(&items)
  let mut folded = 0
  let mut index = usize.ZERO
  while index < Vector.length<Tracked>(&items) {
    folded = folded * 10 + view[index].key
    index = index + usize.ONE
  }
  if folded != 12345 { return 1 }
  drop items
  let dropped = Shared.with<Counts, i32>(&counts, readDrops)
  drop counts
  if dropped != 5 { return 2 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 99 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'raw-buffer-copy-range',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let sourceLayout = Layout.of<[i32; 4]>()
  let sourceAllocation = run Allocator.allocate(move sourceLayout) |> Effect.provideMut(&mut allocator)
  let targetLayout = Layout.of<[i32; 4]>()
  let targetAllocation = run Allocator.allocate(move targetLayout) |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut source = RawBuffer.from<i32>(move sourceAllocation, 4)
    let mut target = RawBuffer.from<i32>(move targetAllocation, 4)
    let first = Slot.write(RawBuffer.slot(&mut source, 0), 3)
    let second = Slot.write(RawBuffer.slot(&mut source, 1), 5)
    let third = Slot.write(RawBuffer.slot(&mut source, 2), 7)
    let prefix = RawBuffer.view<i32>(&source, 1, 2)
    let copied = RawBuffer.copy<i32>(&mut target, 2, prefix, 2)
    let low = RawBuffer.read<i32>(&target, 2)
    let high = RawBuffer.read<i32>(&target, 3)
    let kept = RawBuffer.read<i32>(&source, 1)
    let clearedFirst = Slot.take(RawBuffer.slot(&mut target, 2))
    let clearedSecond = Slot.take(RawBuffer.slot(&mut target, 3))
    let sourceFirst = Slot.take(RawBuffer.slot(&mut source, 0))
    let sourceSecond = Slot.take(RawBuffer.slot(&mut source, 1))
    let sourceThird = Slot.take(RawBuffer.slot(&mut source, 2))
    drop source
    drop target
    return low * 10 + high * 3 + kept
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 76 },
  },
  {
    name: 'raw-buffer-fill-range',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
import silk.u8
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[u8; 4]>()
  let allocation = run Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<u8>(move allocation, 4)
    let cleared = RawBuffer.fill(&mut buffer, 0, 4, u8.toU8(9))
    let refilled = RawBuffer.fill(&mut buffer, 1, 2, u8.toU8(3))
    let first = RawBuffer.read<u8>(&buffer, 0)
    let second = RawBuffer.read<u8>(&buffer, 1)
    let third = RawBuffer.read<u8>(&buffer, 2)
    let fourth = RawBuffer.read<u8>(&buffer, 3)
    let takenFirst = Slot.take(RawBuffer.slot(&mut buffer, 0))
    let takenSecond = Slot.take(RawBuffer.slot(&mut buffer, 1))
    let takenThird = Slot.take(RawBuffer.slot(&mut buffer, 2))
    let takenFourth = Slot.take(RawBuffer.slot(&mut buffer, 3))
    drop buffer
    return u8.toI32(first) * 8 + u8.toI32(second) * 4 + u8.toI32(third) * 2 + u8.toI32(fourth)
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 99 },
  },
  // folded from OwnedAllocationDispatch.test.ts: quota refusal propagates typed OutOfMemoryError.
  {
    name: 'owned-allocation-quota-refusal',
    source: `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
struct QuotaAllocator { remaining: i32 }

effect fn allocate(self: &mut QuotaAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  if self.remaining == 0 { fail OutOfMemoryError {} }
  self.remaining = self.remaining - 1
  let mut inner = Allocator.systemAllocatorProvider()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut inner)
  let block = run recipe
  return move block
}

impl Allocator for QuotaAllocator { allocate: QuotaAllocator.allocate }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = QuotaAllocator { remaining: 1 }
  let first = Layout.of<[i32; 2]>()
  let recipeA = Allocator.allocate(move first) |> Effect.provideMut(&mut allocator)
  let a = run recipeA
  let second = Layout.of<[i32; 2]>()
  let recipeB = Allocator.allocate(move second) |> Effect.provideMut(&mut allocator)
  let b = run recipeB
  drop a
  drop b
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }

pub fn main() -> i32 {
  return run Effect.catchAll(build(), recover)
}`,
    expected: { _tag: 'Completes', result: 7 },
  },
  // folded from OwnedAllocationAcceptance.test.ts: caller-funded shared-core initialization.
  {
    name: 'local-shared-control-block-allocation',
    source: `import silk.effect { Effect }

effect fn construct() -> i32 ! Intrinsic.StorageFailure {
  let layout = Intrinsic.sharedLayout<i32>()
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 42
}

effect fn recover(error: Intrinsic.StorageFailure) -> i32 { return 0 }

pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-lifecycle-operations',
    source: `import silk.effect { Effect }

fn selected(value: &mut i32) -> i32 { return 21 }
fn conflict() -> i32 { return 0 }

effect fn construct() -> i32 ! Intrinsic.StorageFailure {
  let layout = Intrinsic.sharedLayout<i32>()
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    let clone = Intrinsic.sharedClone<i32>(&core)
    let first = Intrinsic.sharedWithMut<i32, i32>(&core, selected, conflict)
    let second = Intrinsic.sharedWithMut<i32, i32>(&clone, selected, conflict)
    drop clone
    drop core
    return first + second
  }
}

effect fn recover(error: Intrinsic.StorageFailure) -> i32 { return 0 }

pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-standard-library-wrapper',
    source: `import silk.allocator { Allocator }
import silk.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.effect { Effect }
import silk.shared { Shared }

struct Counter { value: i32 }

fn increment(value: &mut Counter) -> i32 {
  value.value = value.value + 1
  return value.value
}

fn read(value: &Counter) -> i32 { return value.value }

effect fn construct() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let first = run (Shared.make<Counter>(Counter { value: 41 })
    |> Effect.provideMut<Allocator>(&mut allocator))
  let second = Shared.clone<Counter>(&first)
  let updated = Shared.withMut<Counter, i32>(&second, increment)
  let answer = Shared.with<Counter, i32>(&first, read)
  drop second
  drop first
  return answer
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }

pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-recursive-cleanup',
    source: `import silk.effect { Effect }

struct Empty {}
struct Node { next: Intrinsic.SharedCore<Node> | Empty }

effect fn construct() -> i32 ! Intrinsic.StorageFailure {
  let firstAllocation = run Intrinsic.systemAllocationAcquire(Intrinsic.sharedLayout<Node>())
  let secondAllocation = run Intrinsic.systemAllocationAcquire(Intrinsic.sharedLayout<Node>())
  let thirdAllocation = run Intrinsic.systemAllocationAcquire(Intrinsic.sharedLayout<Node>())
  unsafe {
    let third = Intrinsic.sharedFromAllocation<Node>(
      move thirdAllocation,
      Node { next: Empty {} },
    )
    let second = Intrinsic.sharedFromAllocation<Node>(
      move secondAllocation,
      Node { next: move third },
    )
    let first = Intrinsic.sharedFromAllocation<Node>(
      move firstAllocation,
      Node { next: move second },
    )
    drop first
    return 42
  }
}

effect fn recover(error: Intrinsic.StorageFailure) -> i32 { return 0 }

pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from SlotLaneWidth.test.ts: u8 lane writes, copies, and takes through a raw buffer.
  {
    name: 'slot-lane-u8',
    source: `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
import silk.u8
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[u8; 4]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  unsafe {
    let mut buffer = RawBuffer.from<u8>(move allocation, 4)
    let firstWritten = Slot.write<u8>(RawBuffer.slot(&mut buffer, 0), 7)
    let secondWritten = Slot.write<u8>(RawBuffer.slot(&mut buffer, 3), 11)
    let firstCopy = Slot.copy(RawBuffer.slot(&mut buffer, 0))
    let secondCopy = Slot.copy(RawBuffer.slot(&mut buffer, 3))
    let firstTake = Slot.take(RawBuffer.slot(&mut buffer, 0))
    let secondTake = Slot.take(RawBuffer.slot(&mut buffer, 3))
    drop buffer
    return 100 + u8.toI32(firstCopy) + u8.toI32(secondCopy) + u8.toI32(firstTake) + u8.toI32(secondTake)
  }
  return 0
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }

pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 136 },
  },
  // folded from SlotLaneWidth.test.ts: f64 lane parity including a negative value.
  {
    name: 'slot-lane-f64',
    source: `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.f64
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[f64; 4]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  unsafe {
    let mut buffer = RawBuffer.from<f64>(move allocation, 4)
    let firstWritten = Slot.write<f64>(RawBuffer.slot(&mut buffer, 0), -7.0)
    let secondWritten = Slot.write<f64>(RawBuffer.slot(&mut buffer, 1), 11.0)
    let firstCopy = Slot.copy(RawBuffer.slot(&mut buffer, 0))
    let secondCopy = Slot.copy(RawBuffer.slot(&mut buffer, 1))
    let firstTake = Slot.take(RawBuffer.slot(&mut buffer, 0))
    let secondTake = Slot.take(RawBuffer.slot(&mut buffer, 1))
    drop buffer
    return 100 + f64.toI32(firstCopy) + f64.toI32(secondCopy) + f64.toI32(firstTake) + f64.toI32(secondTake)
  }
  return 0
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }

pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 108 },
  },
  // folded from BytesAcceptance.test.ts: copy, append, and mutate through byte slices (exit 180).
  {
    name: 'bytes-parity',
    source: `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.u8
import silk.usize
import silk.bytes { Bytes }

fn octet(value: u8) -> u8 { return value }

fn checksum(values: &[u8]) -> i32 {
  let mut index = usize.add(0, 0)
  let mut total = 0
  while index < values.length {
    total = total + u8.toI32(values[index])
    index = index + usize.add(0, 1)
  }
  return total
}

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let source = [octet(0), octet(255), octet(128), octet(1)]
  let copying = Bytes.copy(&source) |> Effect.provideMut(&mut allocator)
  let mut bytes = run copying
  let suffix = [octet(42), octet(7)]
  let appending = Bytes.append(&mut bytes, &suffix) |> Effect.provideMut(&mut allocator)
  let appended = run appending
  let mut writable = Bytes.asMutSlice(&mut bytes)
  writable[1] = octet(2)
  let readable = Bytes.asSlice(&bytes)
  if Bytes.length(&bytes) == 6 {} else { return 1 }
  return checksum(move readable)
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 180 },
  },
  {
    // A source-defined StandardInput provider proves committed counts, partial replacement, EOF,
    // and typed provider failure without any evaluator or OS-host adapter.
    name: 'standard-input-source-provider',
    source: `import silk.effect { Effect }
import silk.standard_input { ReadOutcome, StandardInput, StreamReadError }
import silk.u8
import silk.usize
struct Scripted { bytes: [u8; 5] length: usize offset: usize chunk: usize }
fn scripted() -> Scripted {
  return Scripted {
    bytes: [u8.toU8(10), u8.toU8(20), u8.toU8(30), u8.toU8(40), u8.toU8(50)],
    length: usize.add(0, 5),
    offset: usize.ZERO,
    chunk: usize.add(0, 2),
  }
}
effect fn read(self: &mut Scripted, buffer: &mut [u8]) -> ReadOutcome ! StreamReadError {
  if self.offset == self.length { return StandardInput.endOfInput() }
  let mut limit = self.chunk
  let remaining = self.length - self.offset
  if remaining < limit { limit = remaining }
  if buffer.length < limit { limit = buffer.length }
  let source = self.bytes
  let mut index = usize.ZERO
  while index < limit {
    buffer[index] = source[self.offset + index]
    index = index + usize.ONE
  }
  self.offset = self.offset + limit
  return StandardInput.filled(limit)
}
impl StandardInput for Scripted { read: Scripted.read }
struct Broken {}
effect fn broken(self: &mut Broken, buffer: &mut [u8]) -> ReadOutcome ! StreamReadError {
  fail StandardInput.readFailure()
}
impl StandardInput for Broken { read: Broken.broken }
effect fn verify() -> i32 ! StreamReadError {
  let mut provider = scripted()
  let mut buffer = [u8.toU8(0), u8.toU8(0), u8.toU8(0), u8.toU8(0), u8.toU8(0)]
  let first = run Effect.provideMut(StandardInput.receive(&mut buffer), &mut provider)
  if StandardInput.count(&first) != usize.add(0, 2) { return 1 }
  if buffer[usize.ZERO] != u8.toU8(10) { return 2 }
  if buffer[usize.add(0, 2)] != u8.toU8(0) { return 3 }
  let second = run Effect.provideMut(StandardInput.receive(&mut buffer), &mut provider)
  if StandardInput.count(&second) != usize.add(0, 2) { return 4 }
  if buffer[usize.ZERO] != u8.toU8(30) { return 5 }
  let third = run Effect.provideMut(StandardInput.receive(&mut buffer), &mut provider)
  if StandardInput.count(&third) != usize.ONE { return 6 }
  if buffer[usize.ZERO] != u8.toU8(50) { return 7 }
  let ended = run Effect.provideMut(StandardInput.receive(&mut buffer), &mut provider)
  if !StandardInput.isEndOfInput(&ended) { return 8 }
  if StandardInput.count(&ended) != usize.ZERO { return 9 }
  let mut brokenProvider = Broken {}
  let failed = run Effect.provideMut(StandardInput.receive(&mut buffer), &mut brokenProvider)
  return 10
}
effect fn recover(error: StreamReadError) -> i32 { return 42 }
pub fn main() -> i32 { return run Effect.catchAll(verify(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    // Path construction must publish no partial owner when its selected allocator refuses.
    name: 'path-allocation-quota-refusal',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.filesystem { FileError, Path }
import silk.layout { Layout }
struct QuotaAllocator {}
effect fn allocate(self: &mut QuotaAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  fail OutOfMemoryError {}
}
impl Allocator for QuotaAllocator { allocate: QuotaAllocator.allocate }
effect fn build() -> i32 ! FileError | OutOfMemoryError {
  let mut allocator = QuotaAllocator {}
  let path = run Path.make("/never-owned") |> Effect.provideMut(&mut allocator)
  drop path
  return 1
}
effect fn recover(error: FileError | OutOfMemoryError) -> i32 { return 42 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from StaticByteViewIndexing.test.ts: out-of-bounds static byte read traps.
  {
    name: 'static-byte-view-bounds',
    source: `import silk.u8
import silk.usize
pub fn main() -> i32 {
  let bytes = b"\\x99\\x13\\x1d\\x00"
  let index = usize.add(0, 4)
  return u8.toI32(bytes[index])
}`,
    expected: { _tag: 'Trap' },
  },
  // folded from OwnedAllocationAcceptance.test.ts: guarded slot writes and takes release cleanly.
  {
    name: 'owned-allocation-guard',
    source: `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
union Element { Narrow { first: i32, second: i32 }, Wide { first: i64, second: i64 } }
impl Copy for Element {}
fn score(value: Element) -> i32 {
  return match move value {
    Element.Narrow {first, second} => first + second
    Element.Wide {first, second} => { if first + second == 31 { return 31 } return 0 }
  }
}

effect fn build(count: usize) -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[Element; 4]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  unsafe {
    let mut buffer = RawBuffer.from<Element>(move allocation, 4)
    let head0 = Element.Narrow { first: 10, second: 1 }
    let tail0 = Element.Wide { first: 30, second: 1 }
    let first = Slot.write(RawBuffer.slot(&mut buffer, 0), move head0)
    let second = Slot.write(RawBuffer.slot(&mut buffer, 1), move tail0)
    let head = Slot.take(RawBuffer.slot(&mut buffer, 0))
    let tail = RawBuffer.read<Element>(&buffer, 1)
    drop buffer
    return score(move head) + score(move tail)
  }
  return 0
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }

pub fn main() -> i32 {
  return run Effect.catchAll(build(4), recover)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-allocation-layout-mismatch-trap',
    source: ownedAllocationTrap('    return 0', '[i32; 1]'),
    expected: { _tag: 'Trap' },
  },
  {
    name: 'owned-allocation-slot-bounds-trap',
    source: ownedAllocationTrap('    return Slot.take(RawBuffer.slot(&mut buffer, 2))'),
    expected: { _tag: 'Trap' },
  },
  {
    name: 'owned-allocation-read-bounds-trap',
    source: ownedAllocationTrap('    return RawBuffer.read<i32>(&buffer, 2)'),
    expected: { _tag: 'Trap' },
  },
  {
    name: 'owned-allocation-shared-copy-read',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let allocation = run Allocator.allocate(Layout.of<[i32; 1]>())
    |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<i32>(move allocation, 1)
    let written = Slot.write(RawBuffer.slot(&mut buffer, 0), 21)
    let first = RawBuffer.read<i32>(&buffer, 0)
    let second = RawBuffer.read<i32>(&buffer, 0)
    let taken = Slot.take(RawBuffer.slot(&mut buffer, 0))
    drop buffer
    return first + second + taken
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 63 },
  },
  {
    name: 'owned-allocation-shared-union-read',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
struct Left { value: i32 }
impl Copy for Left {}
struct Right { value: i32 }
impl Copy for Right {}
fn left(value: i32) -> Left | Right { return Left { value: value } }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let allocation = run Allocator.allocate(Layout.of<[Left | Right; 1]>())
    |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<Left | Right>(move allocation, 1)
    let element = left(42)
    let written = Slot.write<Left | Right>(RawBuffer.slot(&mut buffer, 0), move element)
    let copied = RawBuffer.read<Left | Right>(&buffer, 0)
    let taken = Slot.take(RawBuffer.slot(&mut buffer, 0))
    drop taken
    drop buffer
    return match move copied { Left { value } => value Right { value } => value }
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from RuntimeSliceAcceptance.test.ts: exclusive slice writes reach the caller.
  {
    name: 'runtime-slice-exclusive',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
import silk.usize
struct Counter { value: i32 }
struct Token { value: i32 counter: Shared<Counter> }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
impl Drop for Token {
  fn drop(self: &mut Token) -> () {
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
fn replace(values: &mut [Token], index: usize, counter: &Shared<Counter>) -> i32 {
  values[index] = Token { value: 42, counter: Shared.clone<Counter>(counter) }
  return usize.toI32(values.length)
}
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let mut values = [
    Token { value: 1, counter: Shared.clone<Counter>(&counter) },
    Token { value: 2, counter: Shared.clone<Counter>(&counter) },
  ]
  let length = replace(&mut values, 0, &counter)
  if length != 2 { return 0 }
  if values[0].value != 42 { return 1 }
  let replacementCount = Shared.with<Counter, i32>(&counter, read)
  if replacementCount != 1 { return 2 }
  drop values
  let finalCount = Shared.with<Counter, i32>(&counter, read)
  drop counter
  if finalCount != 3 { return 3 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'composed-mutable-provider-identities',
    source: `import silk.effect { Effect }
service Input { effect fn count() -> i32 ? &mut Input }
struct First { value: i32 }
struct Second { value: i32 }
effect fn firstCount(self: &mut First) -> i32 { return self.value + 1 }
effect fn secondCount(self: &mut Second) -> i32 {
  return run Effect.suspend(effect { return self.value * 2 })
}
impl Input for First { count: First.firstCount }
impl Input for Second { count: Second.secondCount }
effect fn composed() -> i32 ? &mut Input {
  let pair = run Effect.zip(Input.count(), Input.count())
  return pair.first + pair.second
}
pub fn main() -> i32 {
  let mut first = First { value: 4 }
  let mut second = Second { value: 8 }
  let left = run Effect.provideMut(composed(), &mut first)
  let right = run Effect.provideMut(composed(), &mut second)
  return left + right
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from EffectRuntime.test.ts: every supported pipeline spelling must preserve the same
  // provision and mapping order. Each result is checked independently before the process exits.
  {
    name: 'effect-pipeline-equivalence',
    source: `import silk.effect { Effect }
service Clock {}
struct FixedClock { marker: i32 }
impl Clock for FixedClock {}
effect fn readGrouped() -> i32 ? &Clock { return 20 }
fn addGrouped(value: i32) -> i32 { return value + 1 }
fn doubleGrouped(value: i32) -> i32 { return value * 2 }
effect fn readReverse() -> i32 ? &Clock { return 20 }
fn addReverse(value: i32) -> i32 { return value + 1 }
fn doubleReverse(value: i32) -> i32 { return value * 2 }
effect fn readProvidedLast() -> i32 ? &Clock { return 20 }
fn addProvidedLast(value: i32) -> i32 { return value + 1 }
fn doubleProvidedLast(value: i32) -> i32 { return value * 2 }
effect fn readDataFirst() -> i32 ? &Clock { return 20 }
fn addDataFirst(value: i32) -> i32 { return value + 1 }
fn doubleDataFirst(value: i32) -> i32 { return value * 2 }
effect fn readStored() -> i32 ? &Clock { return 20 }
fn addStored(value: i32) -> i32 { return value + 1 }
fn doubleStored(value: i32) -> i32 { return value * 2 }
pub fn main() -> i32 {
  let clock = FixedClock { marker: 0 }
  let grouped = run ((readGrouped() |> Effect.provide(&clock)) |> Effect.map(addGrouped))
    |> Effect.map(doubleGrouped)
  if grouped != 42 { return 1 }

  let reverse = run readReverse()
    |> Effect.map(addReverse)
    |> Effect.provide(&clock)
    |> Effect.map(doubleReverse)
  if reverse != 42 { return 2 }

  let providedLast = run readProvidedLast()
    |> Effect.map(addProvidedLast)
    |> Effect.map(doubleProvidedLast)
    |> Effect.provide(&clock)
  if providedLast != 42 { return 3 }

  let dataFirst = run Effect.map(
    Effect.provide(Effect.map(readDataFirst(), addDataFirst), &clock),
    doubleDataFirst
  )
  if dataFirst != 42 { return 4 }

  let mapped = readStored() |> Effect.map(addStored)
  let provided = mapped |> Effect.provide(&clock)
  let mappedAgain = provided |> Effect.map(doubleStored)
  let stored = run mappedAgain
  if stored != 42 { return 5 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from EffectRuntime.test.ts: Effect.retry gives every attempt fresh locals while the
  // exclusive capture persists, and the third attempt's count is the exit (3, not 42).
  {
    name: 'effect-retry-captures',
    source: `import silk.effect { Effect }
struct Problem { code: i32 }
effect fn retrying() -> i32 ! Problem {
  let mut counter = 0
  let work = effect {
    counter = counter + 1
    if counter < 3 { fail Problem { code: counter } }
    return counter
  }
  let retried = move work |> Effect.retry(2)
  return run retried
}
effect fn recover(problem: Problem) -> i32 { return 99 }
pub fn main() -> i32 {
  let handled = retrying() |> Effect.catchAll(recover)
  return run handled
}`,
    expected: { _tag: 'Completes', result: 3 },
  },
  // folded from EffectSuspensionComposition.test.ts: a suspended source inside Effect.retry fails
  // every attempt, and the recovery answers with the failure exit (7).
  {
    name: 'suspension-retry-failure',
    source: `import silk.effect { Effect }
struct Problem { code: i32 }
effect fn attempt() -> i32 ! Problem {
  let observed = run Effect.suspend(effect { return 1 })
  fail Problem { code: observed }
}
effect fn recover(error: Problem) -> i32 { return 7 }
pub fn main() -> i32 {
  return run Effect.catchAll(
    attempt() |> Effect.retry(2),
    recover
  )
}`,
    expected: { _tag: 'Completes', result: 7 },
  },
  {
    name: 'suspension-repeated-states',
    source: `import silk.effect { Effect }
effect fn twice() -> i32 {
  let left = run Effect.suspend(effect { return 40 })
  let right = run Effect.suspend(effect { return 2 })
  return left + right
}
pub fn main() -> i32 { return run twice() }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'stored-catch-suspension',
    source: storedCatchSuspension,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-allocator-suspension-success',
    source: ownedAllocatorSuspensionSuccess,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-allocator-suspension-failure',
    source: ownedAllocatorSuspensionFailure,
    expected: { _tag: 'Completes', result: 7 },
  },
  {
    name: 'audit-allocator-suspension',
    source: auditAllocatorSuspension,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from StoredCallableRuntime.test.ts: an uncalled stored callable owning a Drop guard is
  // cleaned exactly once when a typed failure exits the frame.
  {
    name: 'stored-callable-cleanup-typed-failure',
    source: `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
struct Guard {
  tag: i32
  storage: Allocation
}
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    return ()
  }
}
struct Holder<F: once fn<'static>(i32) -> i32> { step: F }
fn consume(value: i32, guard: Guard) -> i32 { return value + guard.tag }
fn keep<F: once fn<'static>(i32) -> i32>(holder: Holder<F>) -> i32 { return 42 }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  let guard = Guard { tag: 2, storage: move allocation }
  let holder = Holder { step: consume(move guard) }
  fail OutOfMemoryError {}
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 42 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'anonymous-capture-cleanup-count',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Counter { value: i32 }
struct Token { value: i32 counter: Shared<Counter> }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
impl Drop for Token {
  fn drop(self: &mut Token) -> () {
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
fn consume(token: Token) -> i32 { return token.value }
fn add(value: i32, token: Token) -> i32 { return value + consume(move token) }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let sectionToken = Token { value: 2, counter: Shared.clone<Counter>(&counter) }
  let section = add(move sectionToken)
  if section(40) != 42 { return 1 }
  let effectToken = Token { value: 42, counter: Shared.clone<Counter>(&counter) }
  let pending = effect { return consume(move effectToken) }
  let effectResult = run pending
  if effectResult != 42 { return 2 }
  let count = Shared.with<Counter, i32>(&counter, read)
  drop counter
  if count != 2 { return 3 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    // An anonymous body that invokes an outer `once fn` must take that environment; a shared loan
    // let the owner clean the already-consumed capture again.
    name: 'anonymous-forwarded-once-capture-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Counter { value: i32 }
struct Token { counter: Shared<Counter> }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
impl Drop for Token {
  fn drop(self: &mut Token) -> () {
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
fn consume(token: Token) -> i32 {
  drop token
  return 42
}
fn forward(step: once fn() -> i32) -> i32 {
  let invoke = fn() -> i32 { return step() }
  return invoke()
}
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let token = Token { counter: Shared.clone<Counter>(&counter) }
  if forward(fn() -> i32 { return consume(move token) }) != 42 { return 1 }
  let count = Shared.with<Counter, i32>(&counter, read)
  drop counter
  if count != 1 { return 2 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'generic-run-cleanup-counts',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Problem { code: i32 }
struct Counter { value: i32 }
struct Owner { counter: Shared<Counter> }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
impl Drop for Owner {
  fn drop(self: &mut Owner) -> () {
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
fn owner(counter: &Shared<Counter>) -> Owner {
  return Owner { counter: Shared.clone<Counter>(counter) }
}
effect fn acquiring<A, E>(self: once Effect<A ! E>, counter: &Shared<Counter>) -> A ! E {
  let held = owner(counter)
  let value = run move self
  drop held
  return move value
}
effect fn holding<A, E>(self: once Effect<A ! E>, held: Owner) -> A ! E {
  let value = run move self
  drop held
  return move value
}
effect fn failing() -> i32 ! Problem { fail Problem { code: 7 } }
effect fn succeeding() -> i32 ! Problem { return 7 }
effect fn recover(error: Problem) -> i32 { return error.code }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let a = run Effect.catchAll(acquiring(failing(), &counter), recover)
  let b = run Effect.catchAll(acquiring(succeeding(), &counter), recover)
  let c = run Effect.catchAll(holding(failing(), owner(&counter)), recover)
  let d = run Effect.catchAll(holding(succeeding(), owner(&counter)), recover)
  let retried = acquiring(failing(), &counter) |> Effect.retry(2)
  let e = run Effect.catchAll(move retried, recover)
  let count = Shared.with<Counter, i32>(&counter, read)
  drop counter
  if a + b + c + d + e != 35 { return 1 }
  if count != 7 { return 2 }
  return 42
}
effect fn recoverAllocation(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recoverAllocation) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'stored-effect-cleanup-counts',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Problem { code: i32 }
struct Counter { value: i32 sum: i32 }
struct Guard { value: i32 counter: Shared<Counter> }
struct Holder { guard: Guard }
struct Deferred<A, E, ?R, F: once Effect<'static; A ! E ? R>> { operation: F }
fn record(counter: &mut Counter, value: i32) -> i32 {
  counter.value = counter.value + 1
  counter.sum = counter.sum + value
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
fn readSum(counter: &Counter) -> i32 { return counter.sum }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let value = self.value
    let changed = Shared.withMut<Counter, i32>(&self.counter, record(value))
    return ()
  }
}
fn guard(value: i32, counter: &Shared<Counter>) -> Guard {
  return Guard { value: value, counter: Shared.clone<Counter>(counter) }
}
fn consume(held: Guard) -> i32 { return held.value }
fn defer<A, E, ?R, F: once Effect<'static; A ! E ? R>>(operation: F) -> Deferred<A, E, R, F> {
  return Deferred<A, E, R> { operation: move operation }
}
effect fn failing(held: Guard) -> i32 ! Problem {
  let code = held.value
  fail Problem { code: code }
}
effect fn delayed(held: Guard) -> i32 {
  let base = run Effect.suspend(effect { return 40 })
  return base + held.value
}
effect fn recover(error: Problem) -> i32 { return error.code }
effect fn runFailure(counter: &Shared<Counter>) -> i32 ! Problem {
  let failed = defer(failing(guard(7, counter)))
  return run failed.operation
}
effect fn runMovedField(counter: &Shared<Counter>) -> i32 ! Problem {
  let holder = Holder { guard: guard(4, counter) }
  return run failing(move holder.guard)
}
effect fn runSuspended(counter: &Shared<Counter>) -> i32 {
  let suspended = defer(delayed(guard(2, counter)))
  return run suspended.operation
}
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0, sum: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let unrunGuard = guard(1, &counter)
  let unrun = defer(effect { return consume(move unrunGuard) })
  drop unrun
  let failureResult = run Effect.catchAll(runFailure(&counter), recover)
  let movedResult = run Effect.catchAll(runMovedField(&counter), recover)
  let suspensionResult = run runSuspended(&counter)
  let count = Shared.with<Counter, i32>(&counter, read)
  let sum = Shared.with<Counter, i32>(&counter, readSum)
  drop counter
  if failureResult != 7 || suspensionResult != 42 { return 1 }
  if movedResult != 4 { return 4 }
  if sum != 14 { return 2 }
  if count != 4 { return 3 }
  return 42
}
effect fn recoverAllocation(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recoverAllocation) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'drop-hook-structured-exits',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Problem {}
struct Counts { hooks: i32 fields: i32 open: i32 valid: bool }
struct Field { counts: Shared<Counts> }
struct Guard { counts: Shared<Counts> field: Field }
fn hook(counts: &mut Counts) -> i32 {
  counts.hooks = counts.hooks + 1
  counts.open = counts.open + 1
  return counts.hooks
}
fn field(counts: &mut Counts) -> i32 {
  if counts.open != 1 { counts.valid = false }
  counts.fields = counts.fields + 1
  counts.open = counts.open - 1
  return counts.fields
}
fn accepted(counts: &Counts) -> bool {
  return counts.valid && counts.hooks == 6 && counts.fields == 6 && counts.open == 0
}
impl Drop for Field {
  fn drop(self: &mut Field) -> () {
    let changed = Shared.withMut<Counts, i32>(&self.counts, field)
    return ()
  }
}
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let changed = Shared.withMut<Counts, i32>(&self.counts, hook)
    return ()
  }
}
fn guard(counts: &Shared<Counts>) -> Guard {
  return Guard {
    counts: Shared.clone<Counts>(counts),
    field: Field { counts: Shared.clone<Counts>(counts) },
  }
}
fn fallthrough(counts: &Shared<Counts>) -> () { let held = guard(counts) return () }
fn early(counts: &Shared<Counts>) -> () { let held = guard(counts) drop held return () }
fn recurse(counts: &Shared<Counts>, remaining: i32) -> () {
  let held = guard(counts)
  if remaining > 0 { return recurse(counts, remaining - 1) }
  return ()
}
effect fn failing(counts: &Shared<Counts>) -> () ! Problem {
  let held = guard(counts)
  fail Problem {}
}
effect fn recover(error: Problem) -> () { return () }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counts = run Shared.make<Counts>(Counts {
    hooks: 0, fields: 0, open: 0, valid: true,
  }) |> Effect.provideMut<Allocator>(&mut allocator)
  fallthrough(&counts)
  early(&counts)
  run Effect.catchAll(failing(&counts), recover)
  recurse(&counts, 2)
  let result = Shared.with<Counts, bool>(&counts, accepted)
  drop counts
  if !result { return 1 }
  return 42
}
effect fn recoverAllocation(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recoverAllocation) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // folded from DropHookExecution.test.ts: a guard live at a failing run releases through its hook
  // before the typed failure propagates to the recovery (exit 7).
  {
    name: 'drop-hook-failure-propagation',
    source: `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
struct Guard {
  tag: i32
  storage: Allocation
}

impl Drop for Guard {
  fn drop(self: &mut Guard) -> () { return () }
}

struct ExhaustedAllocator { tag: i32 }

effect fn allocate(self: &mut ExhaustedAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  fail OutOfMemoryError {}
}

impl Allocator for ExhaustedAllocator { allocate: ExhaustedAllocator.allocate }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut empty = ExhaustedAllocator { tag: 0 }
  let layout = Layout.of<[i32; 2]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  let guard = Guard { tag: 5, storage: move allocation }
  let second = Layout.of<[i32; 2]>()
  let refused = Allocator.allocate(move second) |> Effect.provideMut(&mut empty)
  let never = run refused
  drop never
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 7 },
  },
  // folded from OpaqueRepresentationEngines.test.ts: opaque callable returns keep their hidden
  // concrete identity, so two captures of the same shape stay distinct.
  {
    name: 'opaque-callable',
    source: `fn add(left: i32, right: i32) -> i32 { return left + right }
fn make(value: i32) -> some<F: fn<'static>(i32) -> i32> F { return add(value) }
pub fn main() -> i32 {
  let first = make(40)
  let second = make(1)
  return first(1) + second(0)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // Finite executable representations remain static even when an ordinary union carries them.
  {
    name: 'ordinary-union-executable-members',
    source: `fn add(left: i32, right: i32) -> i32 { return left + right }
fn selectedCallable() -> typeof(add) | i32 { return add }
fn selectedEffect() -> some<F: Effect<'static; i32>> F | i32 {
  return effect { return 42 }
}
pub fn main() -> i32 {
  drop selectedCallable()
  drop selectedEffect()
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // A non-nominal active payload still owns and releases every droppable element exactly once.
  {
    name: 'ordinary-union-droppable-array',
    source: `struct Token { value: i32 }
impl Drop for Token { fn drop(self: &mut Token) -> () { return () } }
fn accept(value: i32 | [Token; 2]) -> i32 { drop value return 42 }
pub fn main() -> i32 {
  return accept([Token { value: 1 }, Token { value: 2 }])
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // One program covers success bypass, selected recovery, and residual propagation. Keeping the
  // complete branch matrix in the shared corpus proves native execution without a feature-local
  // compile/link test.
  {
    name: 'effect-selective-catch',
    source: `import silk.effect { Effect }
struct Selected { code: i32 }
struct Residual { code: i32 }
effect fn risky(mode: i32) -> i32 ! Selected | Residual {
  if mode == 0 { return 10 }
  if mode == 1 { fail Selected { code: 10 } }
  fail Residual { code: 16 }
}
effect fn recoverSelected(problem: Selected) -> i32 { return problem.code + 4 }
effect fn recoverResidual(problem: Residual) -> i32 { return problem.code + 2 }
effect fn selective(mode: i32) -> i32 ! Residual {
  return run Effect.catch<Selected>(risky(mode), recoverSelected)
}
effect fn completed(mode: i32) -> i32 {
  return run Effect.catchAll(selective(mode), recoverResidual)
}
pub fn main() -> i32 {
  return (run completed(0)) + (run completed(1)) + (run completed(2))
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-selective-catch-direct-stored',
    source: `import silk.effect { Effect }
struct Selected { code: i32 }
struct Residual { code: i32 }
effect fn risky() -> i32 ! Selected | Residual { fail Selected { code: 10 } }
effect fn recoverSelected(problem: Selected) -> i32 { return problem.code + 1 }
effect fn recoverResidual(problem: Residual) -> i32 { return problem.code + 2 }
pub fn main() -> i32 {
  let selected = Intrinsic.catchFailure<Selected>(risky(), recoverSelected)
  return run Effect.catchAll(move selected, recoverResidual)
}`,
    expected: { _tag: 'Completes', result: 11 },
  },
  {
    name: 'effect-selective-catch-cleanup-counts',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Selected {}
struct Counter { count: i32 sum: i32 }
struct Guard { id: i32 counter: Shared<Counter> }
struct Residual { guard: Guard }
fn record(counter: &mut Counter, id: i32) -> i32 {
  counter.count = counter.count + 1
  counter.sum = counter.sum + id
  return counter.count
}
fn readCount(counter: &Counter) -> i32 { return counter.count }
fn readSum(counter: &Counter) -> i32 { return counter.sum }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let id = self.id
    let changed = Shared.withMut<Counter, i32>(&self.counter, record(id))
    return ()
  }
}
fn guard(id: i32, counter: &Shared<Counter>) -> Guard {
  return Guard { id: id, counter: Shared.clone<Counter>(counter) }
}
effect fn succeed() -> i32 ! Selected | Residual { return 10 }
effect fn failResidual(counter: &Shared<Counter>) -> i32 ! Selected | Residual {
  fail Residual { guard: guard(8, counter) }
}
effect fn recoverSelected(error: Selected, held: Guard) -> i32 { return held.id }
effect fn recoverResidual(error: Residual) -> i32 { return 22 }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { count: 0, sum: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)

  let successHandler = guard(1, &counter)
  let successCatch = Intrinsic.catchFailure<Selected>(
    succeed(),
    recoverSelected(move successHandler),
  )
  let first = run Effect.catchAll(move successCatch, recoverResidual)

  let live = guard(2, &counter)
  let residualHandler = guard(4, &counter)
  let residualCatch = Intrinsic.catchFailure<Selected>(
    failResidual(&counter),
    recoverSelected(move residualHandler),
  )
  let second = run Effect.catchAll(move residualCatch, recoverResidual)
  drop live

  let count = Shared.with<Counter, i32>(&counter, readCount)
  let sum = Shared.with<Counter, i32>(&counter, readSum)
  drop counter
  if first != 10 || second != 22 { return 1 }
  if count != 4 || sum != 15 { return 2 }
  return 42
}
effect fn recoverAllocation(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recoverAllocation) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-heterogeneous-failure-payload',
    source: heterogeneousFailurePayload,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-nested-failure-propagation',
    source: `import silk.effect { Effect }
struct Left { code: i32 }
struct Right { code: i32 }
struct Nested { payload: Left | Right }
struct Wide { code: f64 }
effect fn original(mode: i32) -> i32 ! Nested {
  if mode == 0 { fail Nested { payload: Left { code: -17 } } }
  fail Nested { payload: Right { code: 23 } }
}
effect fn widen(mode: i32) -> f64 ! Nested | Wide {
  if mode == 2 { fail Wide { code: 3.5 } }
  let value = run original(mode)
  return 0.0
}
effect fn forward(mode: i32) -> i32 ! Nested | Wide {
  let value = run widen(mode)
  return 0
}
effect fn recover(problem: Nested | Wide) -> i32 {
  return match move problem {
    Nested { payload } => match move payload {
      Left { code } => code + 24
      Right { code } => code
    }
    Wide { code } => {
      if code == 3.5 { return 12 }
      return -1
    }
  }
}
pub fn main() -> i32 {
  let left = run Effect.catchAll(forward(0), recover)
  let right = run Effect.catchAll(forward(1), recover)
  let wide = run Effect.catchAll(forward(2), recover)
  if left != 7 || right != 23 || wide != 12 { return 1 }
  return left + right + wide
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-heterogeneous-owned-failure-payload',
    source: heterogeneousOwnedFailurePayload,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-heterogeneous-owned-failure-result-drop',
    source: heterogeneousOwnedFailureResultDrop,
    expected: { _tag: 'Completes', result: 42 },
  },
  // Affine owned service providers remain in the parent frame while a pre-read scalar suspends,
  // then release exactly once after either success or typed failure.
  {
    name: 'owned-provider-suspended-success',
    source: ownedProviderSuspendedSuccess,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-provider-suspended-failure',
    source: ownedProviderSuspendedFailure,
    expected: { _tag: 'Completes', result: 7 },
  },
  // One service call site is specialized with both a synchronous and a suspendable provider. The
  // outer allocator binding must relay through the intermediate wrappers without contaminating
  // either provider-specific execution classification.
  {
    name: 'mixed-service-provider-suspension',
    source: mixedServiceProviderSuspension,
    expected: { _tag: 'Completes', result: 42 },
  },
  // Two suspendable specializations of the same wrapper differ only in contractRow (which
  // provider satisfies the requirement). Each carries its own coroutine frame entry, so frame
  // lookups must key on the full suspension identity including contractRow — a name-and-type-
  // arguments match selects the wrong specialization's frame.
  {
    name: 'contract-row-suspension-frames',
    source: `import silk.effect { Effect }
service Value {
  effect fn read() -> i32 ? &mut Value
}
struct DelayedA { value: i32 }
effect fn readA(self: &mut DelayedA) -> i32 {
  let value = self.value
  return run Effect.suspend(effect { return value })
}
impl Value for DelayedA { read: DelayedA.readA }
struct DelayedB { value: i32 }
effect fn readB(self: &mut DelayedB) -> i32 {
  let value = self.value + 1
  return run Effect.suspend(effect { return value })
}
impl Value for DelayedB { read: DelayedB.readB }
effect fn use() -> i32 ? &mut Value {
  let base = 1
  let got = run Value.read()
  return got + base
}
effect fn first() -> i32 {
  let mut provider = DelayedA { value: 19 }
  return run Intrinsic.bindRequirementMut<Value>(use(), &mut provider)
}
effect fn second() -> i32 {
  let mut provider = DelayedB { value: 20 }
  return run Intrinsic.bindRequirementMut<Value>(use(), &mut provider)
}
effect fn program() -> i32 {
  return (run first()) + (run second())
}
pub fn main() -> i32 {
  return run program()
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // The float math conformance programs join the corpus so the native differential compiles and
  // runs each one against the independently pinned result.
  ...floatMathPrograms.map((program) => ({
    name: program.name,
    source: program.source,
    expected: { _tag: 'Completes', result: 42 } as const,
  })),
  ...checkedConversionPrograms.map((program) => ({
    name: program.name,
    source: program.source,
    expected: { _tag: 'Completes', result: 42 } as const,
  })),
  // Raw pointer parity: a formed slice pointer offset and written, then observed through the
  // array place; and a Silk callee writing through a `*mut i32` parameter observed by its caller.
  {
    name: 'pointer-slice-offset-write',
    source: `import silk.pointer { Pointer }
pub fn main() -> i32 {
  let mut values = [1, 2, 3, 4]
  let pointer = Pointer.fromMutSlice(&mut values)
  if Pointer.isNullMany(pointer) { return 0 }
  unsafe {
    let many = Intrinsic.pointerRequalify<?[*]mut i32, [*]mut i32>(pointer)
    let third = Pointer.atMut(many, 2)
    Pointer.write(third, 40)
    if Pointer.read(third) != 40 { return 1 }
  }
  return values[2] + values[3] - 2
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-output-storage',
    source: outputStorageSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'pointer-parameter-write',
    source: pointerParameterWrite,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    // A bound method value is a section capturing parameter zero: every receiver mode and a
    // receiver-only member applied with no arguments.
    name: 'bound-method-values',
    source: `pub struct Counter { value: i32 }
impl Counter {
  pub fn read(self: &Self) -> i32 { return self.value }
  pub fn bump(self: &mut Self) -> i32 {
    self.value = self.value + 1
    return self.value
  }
  pub fn add(self: &Self, other: &Self) -> i32 { return self.value + other.value }
  pub fn take(self: Self) -> i32 { return self.value }
}
pub fn main() -> i32 {
  let shared = Counter { value: 10 }
  let read = shared.read
  let mut exclusive = Counter { value: 0 }
  let mut bump = exclusive.bump
  let first = bump()
  let owned = Counter { value: 5 }
  let add = owned.add
  let taken = Counter { value: 20 }
  let take = taken.take
  return read() + shared.read() + first + bump() + add(&shared) + take()
}`,
    expected: { _tag: 'Completes', result: 58 },
  },
  {
    name: 'method-call-matrix',
    source: readFileSync(new URL('../fixtures/method-calls/main.silk', import.meta.url), 'utf8'),
    expected: { _tag: 'Completes', result: 38 },
  },
  {
    name: 'stored-callable-lazy-moved-effect',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Token { value: i32 }
struct Counter { value: i32 }
fn consume(token: Token) -> i32 { return token.value }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let captured = Shared.clone<Counter>(&counter)
  let token = Token { value: 42 }
  let deferred = effect fn() -> i32 {
    let changed = Shared.withMut<Counter, i32>(&captured, increment)
    return consume(move token)
  }
  let pending = deferred()
  let before = Shared.with<Counter, i32>(&counter, read)
  if before != 0 { return 1 }
  let result = run pending
  let after = Shared.with<Counter, i32>(&counter, read)
  drop counter
  if after != 1 { return 2 }
  return result
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'stored-callable-drop-lane-mutation',
    source: `import silk.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.effect { Effect }
import silk.shared { Shared }
struct Cell { value: i32 }
struct Observation { value: i32 }
struct Guard {
  primary: Shared<Cell>
  replacement: Shared<Cell>
  observation: Shared<Observation>
}
fn readCell(cell: &Cell) -> i32 { return cell.value }
fn markObserved(observation: &mut Observation) -> i32 {
  observation.value = 2
  return observation.value
}
fn readObservation(observation: &Observation) -> i32 { return observation.value }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let next = Shared.clone<Cell>(&self.replacement)
    let previous = Intrinsic.replace(self.primary, move next)
    drop previous
    let selected = Shared.with<Cell, i32>(&self.primary, readCell)
    if selected == 2 {
      let observed = Shared.withMut<Observation, i32>(&self.observation, markObserved)
    }
    return ()
  }
}
struct Holder<F: once fn<'static>(i32) -> i32> { step: F }
fn consume(value: i32, guard: Guard) -> i32 { return value }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let primary = run (Shared.make<Cell>(Cell { value: 1 })
    |> Effect.provideMut<Allocator>(&mut allocator))
  let replacement = run (Shared.make<Cell>(Cell { value: 2 })
    |> Effect.provideMut<Allocator>(&mut allocator))
  let observation = run (Shared.make<Observation>(Observation { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator))
  let retainedObservation = Shared.clone<Observation>(&observation)
  let guard = Guard {
    primary: move primary,
    replacement: move replacement,
    observation: move observation,
  }
  let holder = Holder { step: consume(move guard) }
  drop holder
  let selected = Shared.with<Observation, i32>(&retainedObservation, readObservation)
  drop retainedObservation
  if selected != 2 { return 1 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    // FAIL-004: both the protected `i32` and the handler `string` are injected into the recovered
    // `i32 | string`, so the later `match` finds its active member in the native artifact.
    name: 'catch-union-success-match',
    source: `import silk.effect { Effect }
struct NotFoundError {}
effect fn load(flag: bool) -> i32 ! NotFoundError {
  if flag { fail NotFoundError {} }
  return 5
}
effect fn recover(error: NotFoundError) -> string<'static> { return "missing" }
fn handled(flag: bool) -> Effect<'static; i32 | string<'static>> {
  return Effect.catch<NotFoundError>(load(flag), recover)
}
pub fn main() -> i32 {
  let a = run handled(true)
  let b = run handled(false)
  let x = match move a { i32 n => n
    string _ => 100 }
  let y = match move b { i32 n => n
    string _ => 100 }
  return x + y
}`,
    expected: { _tag: 'Completes', result: 105 },
  },
  {
    // FAIL-004: a handler whose success type is `never` contributes no success member; its run
    // diverges through the failure channel instead of copying into the recovered success.
    name: 'catch-never-handler',
    source: `import silk.effect { Effect }
struct NotFoundError {}
struct OtherError {}
effect fn load(flag: bool) -> i32 ! NotFoundError {
  if flag { fail NotFoundError {} }
  return 5
}
effect fn rethrow(error: NotFoundError) -> never ! OtherError { fail OtherError {} }
fn handled(flag: bool) -> Effect<'static; i32 ! OtherError> {
  return Effect.catch<NotFoundError>(load(flag), rethrow)
}
effect fn rec(e: OtherError) -> i32 { return 1 }
pub fn main() -> i32 {
  let a = run Effect.catch<OtherError>(handled(true), rec)
  let b = run Effect.catch<OtherError>(handled(false), rec)
  return a * 10 + b
}`,
    expected: { _tag: 'Completes', result: 15 },
  },
  {
    // EFF-013: distinct return sites join under the declared `once Effect<i32>`; each call runs
    // the alternative its own branch constructed.
    name: 'effect-return-site-join-once',
    source: `struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () { return () }
}
effect fn withToken(t: Token) -> i32 { return t.value }
fn choose(flag: bool) -> once Effect<'static; i32> {
  if flag {
    let t = Token { value: 1 }
    return withToken(move t)
  }
  return effect { return 2 }
}
pub fn main() -> i32 {
  let a = run choose(true)
  let b = run choose(false)
  return a * 10 + b
}`,
    expected: { _tag: 'Completes', result: 12 },
  },
  {
    // EFF-007: a fail-only `effect {}` block has success type `never` and still carries its
    // declared failure through Effect.catch.
    name: 'effect-block-fail-only',
    source: `import silk.effect { Effect }
struct ProblemError {}
fn fallible() -> Effect<'static; i32 ! ProblemError> {
  return effect { fail ProblemError {} }
}
effect fn recover(e: ProblemError) -> i32 { return 7 }
pub fn main() -> i32 {
  return run Effect.catch<ProblemError>(fallible(), recover)
}`,
    expected: { _tag: 'Completes', result: 7 },
  },
  {
    name: 'testing-assertion-and-runtime-filters',
    source: `import silk.effect { Effect }
import silk.testing { AssertionError, Testing }
effect fn exercise() -> i32 ! AssertionError<'static> {
  run Testing.expect(true, "unused")
  if !Testing.matches("src/math.silk", "AddsNumbers", "src/math.silk", "numbers") { return 1 }
  if !Testing.matches("src/math.silk", "AddsNumbers", "", "ADDS") { return 2 }
  if !Testing.matches("src/math.silk", "AddsNumbers", "src/math.silk", "") { return 3 }
  if Testing.matches("src/math.silk", "AddsNumbers", "src/Math.silk", "numbers") { return 4 }
  if Testing.matches("src/math.silk", "AddsNumbers", "src/math.silk", "missing") { return 5 }
  if !Testing.matches("src/meta.silk", "literal[case", "src/meta.silk", "[") { return 6 }
  run Testing.expect(false, "expected failure")
  return 7
}
effect fn recover(error: AssertionError<'static>) -> i32 {
  if Testing.assertionMessage(&error) == "expected failure" { return 42 }
  return 8
}
pub fn main() -> i32 { return run Effect.catchAll(exercise(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
]

/**
 * Native-only extensions to the shared corpus. These programs retain the optimized single
 * compile/link loop for target-specific claims.
 */
const localSharedPressure = readFileSync(
  new URL('../../../../examples/language-pressure/local-shared-slp1/main.silk', import.meta.url),
  'utf8',
)
const renamedLocalSharedPressure = readFileSync(
  new URL(
    '../../../../examples/language-pressure/local-shared-slp1/renamed-main.silk',
    import.meta.url,
  ),
  'utf8',
)
const independentExecutionPressure = (name: string): string =>
  readFileSync(
    new URL(`../fixtures/independent-execution-separation/${name}.silk`, import.meta.url),
    'utf8',
  )
const schedulerFiber = (name: string): string =>
  readFileSync(new URL(`../fixtures/scheduler-fiber/${name}.silk`, import.meta.url), 'utf8')
const localSharedPressureFailure = (ordinal: 0 | 1): string =>
  localSharedPressure.replace(
    ordinal === 0
      ? 'let mut firstAllocator = Allocator.systemAllocatorProvider()'
      : 'let mut secondAllocator = Allocator.systemAllocatorProvider()',
    ordinal === 0
      ? 'let mut firstAllocator = ExhaustedAllocator {}'
      : 'let mut secondAllocator = ExhaustedAllocator {}',
  )

const deterministicSecureRandom = `import silk.effect { Effect }
import silk.random { Random }
import silk.u8
import silk.usize
struct FixedRandom {}
effect fn fixedFill(self: &mut FixedRandom, output: &mut [u8]) -> () {
  let mut index = usize.ZERO
  while index < output.length {
    output[index] = u8.toU8(7)
    index = index + usize.ONE
  }
  return ()
}
impl Random for FixedRandom { fillBytes: FixedRandom.fixedFill }
pub fn main() -> i32 {
  let mut provider = FixedRandom {}
  let mut output = [u8.toU8(0), u8.toU8(0), u8.toU8(0)]
  run Effect.provideMut(Random.fillBytes(&mut output), &mut provider)
  if output[0] != 7 { return 1 }
  if output[1] != 7 { return 2 }
  if output[2] != 7 { return 3 }
  return 42
}`

const independentExecutionLatchedResume = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
struct Empty {}
struct Stored { execution: Intrinsic.Execution<i32> }
struct Owner { slot: Empty | Stored result: i32 }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard {
  Intrinsic.wake(move wake)
  return Guard {}
}
effect fn body() -> i32 {
  run Execution.park(register)
  return 42
}
fn complete(owner: &mut Owner, result: i32) -> () {
  owner.result = result
  return ()
}
fn suspend(owner: &mut Owner, execution: Intrinsic.Execution<i32>) -> () {
  let previous = Intrinsic.replace(owner.slot, Stored { execution: move execution })
  drop previous
  return ()
}
fn ready(state: &()) -> () { return () }
effect fn driveOnce(execution: Intrinsic.Execution<i32>, owner: &mut Owner) -> () {
  return run Execution.drive(move execution, move owner, complete, suspend)
}
effect fn finish(selected: Empty | Stored, owner: &mut Owner) -> () {
  return match move selected {
    Empty {} => ()
    Stored { execution: next } => run finishStored(move next, move owner)
  }
}
effect fn finishStored(execution: Intrinsic.Execution<i32>, owner: &mut Owner) -> () {
  return run Execution.drive(move execution, move owner, complete, suspend)
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut owner = Owner { slot: Empty {}, result: 0 }
  let mut execution = run Execution.make(body(), (), ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  Execution.notifyInitial(&mut execution)
  run driveOnce(move execution, &mut owner)
  let selected = Intrinsic.replace(owner.slot, Empty {})
  run finish(move selected, &mut owner)
  return owner.result
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`

const independentExecutionLatchedDestroy = readFileSync(
  new URL('../../conformance/execution-storage/latched-destroy.silk', import.meta.url),
  'utf8',
)
export const independentExecutionFinalizedDestroy = readFileSync(
  new URL('../../conformance/execution-storage/finalized-destroy.silk', import.meta.url),
  'utf8',
)

const nativeSecureRandom = `import silk.effect { Effect }
import silk.os_random { OsRandom }
import silk.random { Random }
import silk.u8
pub fn main() -> i32 {
  let mut provider = OsRandom.make()
  let mut output = [u8.toU8(0), u8.toU8(0), u8.toU8(0)]
  run Effect.provideMut(Random.fillBytes(&mut output), &mut provider)
  return 42
}`

/**
 * One C function per admitted foreign scalar class plus a void function observed through a second
 * query, so the native leg exercises every C ABI lane shape the classifier can select.
 */
export const foreignScalarFixture = `#include <stdint.h>
#include <stddef.h>
int8_t silk_test_add_i8(int8_t a, int8_t b) { return (int8_t)(a + b); }
uint8_t silk_test_add_u8(uint8_t a, uint8_t b) { return (uint8_t)(a + b); }
int16_t silk_test_add_i16(int16_t a, int16_t b) { return (int16_t)(a + b); }
uint16_t silk_test_add_u16(uint16_t a, uint16_t b) { return (uint16_t)(a + b); }
int32_t silk_test_add_i32(int32_t a, int32_t b) { return a + b; }
uint32_t silk_test_add_u32(uint32_t a, uint32_t b) { return a + b; }
int64_t silk_test_add_i64(int64_t a, int64_t b) { return a + b; }
uint64_t silk_test_add_u64(uint64_t a, uint64_t b) { return a + b; }
intptr_t silk_test_add_isize(intptr_t a, intptr_t b) { return a + b; }
size_t silk_test_add_usize(size_t a, size_t b) { return a + b; }
float silk_test_scale_f32(float value, float factor) { return value * factor; }
double silk_test_scale_f64(double value, double factor) { return value * factor; }
static int32_t silk_test_counter = 0;
void silk_test_touch(void) { silk_test_counter += 1; }
int32_t silk_test_touched(void) { return silk_test_counter; }
`

/** The extern leg of the scalar fixture; `foreignScalarReference` computes the same checksum. */
export const foreignScalarNative = `import silk.i8
import silk.u8
import silk.i16
import silk.u16
import silk.i32
import silk.u32
import silk.i64
import silk.u64
import silk.isize
import silk.usize
import silk.f32
import silk.f64
unsafe extern "C" fn silk_test_add_i8(a: i8, b: i8) -> i8
unsafe extern "C" fn silk_test_add_u8(a: u8, b: u8) -> u8
unsafe extern "C" fn silk_test_add_i16(a: i16, b: i16) -> i16
unsafe extern "C" fn silk_test_add_u16(a: u16, b: u16) -> u16
unsafe extern "C" fn silk_test_add_i32(a: i32, b: i32) -> i32
unsafe extern "C" fn silk_test_add_u32(a: u32, b: u32) -> u32
unsafe extern "C" fn silk_test_add_i64(a: i64, b: i64) -> i64
unsafe extern "C" fn silk_test_add_u64(a: u64, b: u64) -> u64
unsafe extern "C" fn silk_test_add_isize(a: isize, b: isize) -> isize
unsafe extern "C" fn silk_test_add_usize(a: usize, b: usize) -> usize
unsafe extern "C" fn silk_test_scale_f32(value: f32, factor: f32) -> f32
unsafe extern "C" fn silk_test_scale_f64(value: f64, factor: f64) -> f64
unsafe extern "C" fn silk_test_touch() -> ()
unsafe extern "C" fn silk_test_touched() -> i32
pub fn main() -> i32 {
  let mut sum = 0
  sum = sum + i8.toI32(unsafe silk_test_add_i8(i32.toI8(-7), i32.toI8(3)))
  sum = sum + u8.toI32(unsafe silk_test_add_u8(i32.toU8(200), i32.toU8(5)))
  sum = sum + i16.toI32(unsafe silk_test_add_i16(i32.toI16(-300), i32.toI16(50)))
  sum = sum + u16.toI32(unsafe silk_test_add_u16(i32.toU16(60000), i32.toU16(7)))
  sum = sum + unsafe silk_test_add_i32(-11, 4)
  sum = sum + u32.toI32(unsafe silk_test_add_u32(i32.toU32(9), i32.toU32(13)))
  sum = sum + i64.toI32(unsafe silk_test_add_i64(i32.toI64(-21), i32.toI64(6)))
  sum = sum + u64.toI32(unsafe silk_test_add_u64(i32.toU64(17), i32.toU64(23)))
  sum = sum + isize.toI32(unsafe silk_test_add_isize(i32.toIsize(-5), i32.toIsize(2)))
  sum = sum + usize.toI32(unsafe silk_test_add_usize(i32.toUsize(8), i32.toUsize(9)))
  sum = sum + f32.toI32(unsafe silk_test_scale_f32(i32.toF32(3), i32.toF32(7)))
  sum = sum + f64.toI32(unsafe silk_test_scale_f64(i32.toF64(-4), i32.toF64(5)))
  unsafe silk_test_touch()
  unsafe silk_test_touch()
  unsafe silk_test_touch()
  sum = sum + unsafe silk_test_touched() * 10
  return i32.remainder(sum, 256)
}`

/** Pure-Silk control for `foreignScalarNative`: the same checksum without C. */
export const foreignScalarReference = `import silk.i8
import silk.u8
import silk.i16
import silk.u16
import silk.i32
import silk.u32
import silk.i64
import silk.u64
import silk.isize
import silk.usize
import silk.f32
import silk.f64
fn addI8(a: i8, b: i8) -> i8 { return a + b }
fn addU8(a: u8, b: u8) -> u8 { return a + b }
fn addI16(a: i16, b: i16) -> i16 { return a + b }
fn addU16(a: u16, b: u16) -> u16 { return a + b }
fn addI32(a: i32, b: i32) -> i32 { return a + b }
fn addU32(a: u32, b: u32) -> u32 { return a + b }
fn addI64(a: i64, b: i64) -> i64 { return a + b }
fn addU64(a: u64, b: u64) -> u64 { return a + b }
fn addIsize(a: isize, b: isize) -> isize { return a + b }
fn addUsize(a: usize, b: usize) -> usize { return a + b }
fn scaleF32(value: f32, factor: f32) -> f32 { return value * factor }
fn scaleF64(value: f64, factor: f64) -> f64 { return value * factor }
pub fn main() -> i32 {
  let mut sum = 0
  sum = sum + i8.toI32(addI8(i32.toI8(-7), i32.toI8(3)))
  sum = sum + u8.toI32(addU8(i32.toU8(200), i32.toU8(5)))
  sum = sum + i16.toI32(addI16(i32.toI16(-300), i32.toI16(50)))
  sum = sum + u16.toI32(addU16(i32.toU16(60000), i32.toU16(7)))
  sum = sum + addI32(-11, 4)
  sum = sum + u32.toI32(addU32(i32.toU32(9), i32.toU32(13)))
  sum = sum + i64.toI32(addI64(i32.toI64(-21), i32.toI64(6)))
  sum = sum + u64.toI32(addU64(i32.toU64(17), i32.toU64(23)))
  sum = sum + isize.toI32(addIsize(i32.toIsize(-5), i32.toIsize(2)))
  sum = sum + usize.toI32(addUsize(i32.toUsize(8), i32.toUsize(9)))
  sum = sum + f32.toI32(scaleF32(i32.toF32(3), i32.toF32(7)))
  sum = sum + f64.toI32(scaleF64(i32.toF64(-4), i32.toF64(5)))
  let mut touched = 0
  touched = touched + 1
  touched = touched + 1
  touched = touched + 1
  sum = sum + touched * 10
  return i32.remainder(sum, 256)
}`

/** C writes through a Silk-formed `*mut i32` and fills a Silk-formed `*mut u8` buffer. */
export const foreignPointerFixture = `#include <stdint.h>
#include <stddef.h>
void silk_test_store(int32_t *out, int32_t value) { *out = value; }
void silk_test_fill(uint8_t *buffer, size_t length, uint8_t byte) {
  for (size_t index = 0; index < length; index += 1) buffer[index] = byte;
}
`

/** `Pointer.fromMutRef(&mut result)` handed to C; the Silk read afterwards observes the store. */
export const foreignPointerStoreNative = `import silk.pointer { Pointer }
unsafe extern "C" fn silk_test_store(out: *mut i32, value: i32) -> ()
pub fn main() -> i32 {
  let mut result = 0
  unsafe silk_test_store(Pointer.fromMutRef(&mut result), 42)
  return result
}`

/** `Pointer.fromMutSlice(&mut bytes)` plus `bytes.length` handed to C; `bytes[0]` observes the fill. */
export const foreignPointerFillNative = `import silk.i32
import silk.u8
import silk.pointer { Pointer }
unsafe extern "C" fn silk_test_fill(buffer: ?[*]mut u8, length: usize, byte: u8) -> ()
fn fill(bytes: &mut [u8], byte: u8) -> () {
  unsafe silk_test_fill(Pointer.fromMutSlice(&mut bytes), bytes.length, byte)
}
pub fn main() -> i32 {
  let mut bytes = [i32.toU8(0), i32.toU8(0), i32.toU8(0)]
  fill(&mut bytes, i32.toU8(42))
  return u8.toI32(bytes[0]) + u8.toI32(bytes[2]) - 42
}`

/** Pure-Silk control for `foreignPointerFillNative`. */
export const foreignPointerFillReference = `import silk.i32
import silk.u8
import silk.usize
fn fill(bytes: &mut [u8], byte: u8) -> () {
  let mut index = usize.ZERO
  while index < bytes.length {
    bytes[index] = byte
    index = index + 1
  }
}
pub fn main() -> i32 {
  let mut bytes = [i32.toU8(0), i32.toU8(0), i32.toU8(0)]
  fill(&mut bytes, i32.toU8(42))
  return u8.toI32(bytes[0]) + u8.toI32(bytes[2]) - 42
}`

/** A libc call writes through a pointer to a C-layout record and Silk reads the populated fields. */
export const foreignClockRecordNative = `import silk.pointer { Pointer }
extern "C" struct Timespec {
  seconds: i64
  nanoseconds: i64
}
unsafe extern "C" fn clock_gettime(clock: i32, value: *mut Timespec) -> i32
pub fn main() -> i32 {
  let mut value = Timespec { seconds: -1, nanoseconds: -1 }
  if unsafe clock_gettime(0, Pointer.fromMutRef(&mut value)) != 0 { return 1 }
  if value.seconds < 0 { return 2 }
  if value.nanoseconds < 0 { return 3 }
  if value.nanoseconds >= 1000000000 { return 4 }
  return 0
}`

/**
 * The libc round trip: allocate, copy a Silk byte view in, NUL-terminate, compare, write to
 * standard output, free. The backend declares `malloc` as `ptr(i64)`, `free` as `void(ptr)`, and
 * `memcmp` as `i32(ptr, ptr, i64)` on a 64-bit host (`NativeProgram.ts`); these externs classify
 * to exactly those LLVM types (`*mut`/`*const` -> `ptr`, `usize` -> `i64`, `()` -> `void`) so the
 * redeclarations share one entry instead of reporting `ForeignSymbolConflict`.
 */
export const foreignLibcRoundtripNative = `import silk.i32
import silk.isize
import silk.usize
import silk.pointer { Pointer }
unsafe extern "C" fn malloc(size: usize) -> ?*mut u8
unsafe extern "C" fn free(pointer: ?*mut u8) -> ()
unsafe extern "C" fn memcpy(destination: [*]mut u8, source: ?[*]const u8, length: usize) -> [*]mut u8
unsafe extern "C" fn memcmp(left: [*]const u8, right: ?[*]const u8, length: usize) -> i32
unsafe extern "C" fn strlen(text: [*]const u8) -> usize
unsafe extern "C" fn write(descriptor: i32, data: ?[*]const u8, length: usize) -> isize with Intrinsic.foreign(noCapture: ("data",))
pub fn main() -> i32 {
  let bytes = b"hello\\n"
  let length = bytes.length
  let allocated = unsafe malloc(length + 1)
  if Pointer.isNull(allocated) { return 1 }
  unsafe {
    let buffer = Intrinsic.pointerRequalify<?*mut u8, [*]mut u8>(allocated)
    let copied = memcpy(buffer, Pointer.fromSlice(bytes), length)
    Pointer.write(Pointer.atMut(buffer, length), i32.toU8(0))
    if memcmp(buffer, Pointer.fromSlice(bytes), length) != 0 { return 2 }
    if strlen(buffer) != length { return 3 }
    if isize.toI32(write(1, buffer, length)) != usize.toI32(length) { return 4 }
    free(allocated)
  }
  return usize.toI32(length) * 7
}`

/** Pure-Silk control for `foreignLibcRoundtripNative`: the same status without libc. */
export const foreignLibcRoundtripReference = `import silk.usize
pub fn main() -> i32 {
  let bytes = b"hello\\n"
  return usize.toI32(bytes.length) * 7
}`

/** C calls back into an exported Silk function from a Silk-called C function. */
export const foreignExportRoundtripFixture = `#include <stdint.h>
int32_t silk_test_double_v1(int32_t);
int32_t silk_test_roundtrip(int32_t value) { return silk_test_double_v1(value) + 1; }
`

export const foreignExportRoundtripNative = `unsafe extern "C" fn silk_test_roundtrip(value: i32) -> i32
export "C" fn silk_test_double_v1(value: i32) -> i32 { return value * 2 }
pub fn main() -> i32 { return unsafe silk_test_roundtrip(20) }`

export const foreignExportRoundtripReference = `fn double(value: i32) -> i32 { return value * 2 }
fn roundtrip(value: i32) -> i32 { return double(value) + 1 }
pub fn main() -> i32 { return roundtrip(20) }`

/**
 * C calls one export per admitted scalar class plus a void export whose effect (a call back into
 * the fixture's counter) is observed through a second export; the checksum equals
 * `foreignScalarReference`.
 */
export const foreignExportScalarFixture = `#include <stdint.h>
#include <stddef.h>
int8_t silk_test_export_add_i8(int8_t, int8_t);
uint8_t silk_test_export_add_u8(uint8_t, uint8_t);
int16_t silk_test_export_add_i16(int16_t, int16_t);
uint16_t silk_test_export_add_u16(uint16_t, uint16_t);
int32_t silk_test_export_add_i32(int32_t, int32_t);
uint32_t silk_test_export_add_u32(uint32_t, uint32_t);
int64_t silk_test_export_add_i64(int64_t, int64_t);
uint64_t silk_test_export_add_u64(uint64_t, uint64_t);
intptr_t silk_test_export_add_isize(intptr_t, intptr_t);
size_t silk_test_export_add_usize(size_t, size_t);
float silk_test_export_scale_f32(float, float);
double silk_test_export_scale_f64(double, double);
void silk_test_export_touch(void);
int32_t silk_test_export_touched(void);
static int32_t silk_test_export_counter = 0;
void silk_test_export_note(void) { silk_test_export_counter += 1; }
int32_t silk_test_export_noted(void) { return silk_test_export_counter; }
int32_t silk_test_export_checksum(void) {
  int32_t sum = 0;
  sum += silk_test_export_add_i8(-7, 3);
  sum += silk_test_export_add_u8(200, 5);
  sum += silk_test_export_add_i16(-300, 50);
  sum += silk_test_export_add_u16(60000, 7);
  sum += silk_test_export_add_i32(-11, 4);
  sum += (int32_t)silk_test_export_add_u32(9, 13);
  sum += (int32_t)silk_test_export_add_i64(-21, 6);
  sum += (int32_t)silk_test_export_add_u64(17, 23);
  sum += (int32_t)silk_test_export_add_isize(-5, 2);
  sum += (int32_t)silk_test_export_add_usize(8, 9);
  sum += (int32_t)silk_test_export_scale_f32(3.0f, 7.0f);
  sum += (int32_t)silk_test_export_scale_f64(-4.0, 5.0);
  silk_test_export_touch();
  silk_test_export_touch();
  silk_test_export_touch();
  sum += silk_test_export_touched() * 10;
  return ((sum % 256) + 256) % 256;
}
`

export const foreignExportScalarNative = `import silk.i8
import silk.u8
import silk.i16
import silk.u16
import silk.i32
import silk.u32
import silk.i64
import silk.u64
import silk.isize
import silk.usize
import silk.f32
import silk.f64
unsafe extern "C" fn silk_test_export_note() -> ()
unsafe extern "C" fn silk_test_export_noted() -> i32
unsafe extern "C" fn silk_test_export_checksum() -> i32
export "C" fn silk_test_export_add_i8(a: i8, b: i8) -> i8 { return a + b }
export "C" fn silk_test_export_add_u8(a: u8, b: u8) -> u8 { return a + b }
export "C" fn silk_test_export_add_i16(a: i16, b: i16) -> i16 { return a + b }
export "C" fn silk_test_export_add_u16(a: u16, b: u16) -> u16 { return a + b }
export "C" fn silk_test_export_add_i32(a: i32, b: i32) -> i32 { return a + b }
export "C" fn silk_test_export_add_u32(a: u32, b: u32) -> u32 { return a + b }
export "C" fn silk_test_export_add_i64(a: i64, b: i64) -> i64 { return a + b }
export "C" fn silk_test_export_add_u64(a: u64, b: u64) -> u64 { return a + b }
export "C" fn silk_test_export_add_isize(a: isize, b: isize) -> isize { return a + b }
export "C" fn silk_test_export_add_usize(a: usize, b: usize) -> usize { return a + b }
export "C" fn silk_test_export_scale_f32(value: f32, factor: f32) -> f32 { return value * factor }
export "C" fn silk_test_export_scale_f64(value: f64, factor: f64) -> f64 { return value * factor }
export "C" fn silk_test_export_touch() -> () {
  unsafe silk_test_export_note()
  return ()
}
export "C" fn silk_test_export_touched() -> i32 { return unsafe silk_test_export_noted() }
pub fn main() -> i32 { return unsafe silk_test_export_checksum() }`

/** Replacement cleanup: a displaced local, field, array element, and slice element clean once. */
export const replaceCleanupProgram = `import silk.os_writer { StdoutWriter }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
import silk.format { Format }
import silk.writer { Writer, WriterError }

struct Log {
  slots: [i32; 16]
  count: usize
}
struct Tracer {
  id: i32
  log: Shared<Log>
}
fn record(log: &mut Log, id: i32) -> i32 {
  log.slots[log.count] = id
  log.count = log.count + 1
  return 0
}
impl Drop for Tracer {
  fn drop(self: &mut Tracer) -> () {
    let id = self.id
    let r = Shared.withMut<Log, i32>(&self.log, record(id))
    return ()
  }
}
fn encode(log: &Log) -> i32 {
  let mut r = 0
  let mut i: usize = 0
  while i < log.count {
    r = r * 10 + log.slots[i]
    i = i + 1
  }
  return r
}
fn tracer(id: i32, log: &Shared<Log>) -> Tracer {
  return Tracer { id: id, log: Shared.clone<Log>(log) }
}
effect fn printLog(log: &Shared<Log>) -> () ! WriterError {
  let code = Shared.with<Log, i32>(log, encode)
  let mut writer = StdoutWriter.make()
  return run (Format.display(&code) |> Effect.provideMut<Writer>(&mut writer))
}
effect fn makeLog() -> Shared<Log> ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run (Shared.make<Log>(Log { slots: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], count: 0 }) |> Effect.provideMut<Allocator>(&mut allocator))
}
effect fn recoverAny(e: OutOfMemoryError | WriterError) -> i32 { return -1 }
struct Pair {
  first: Tracer
  second: Tracer
}
fn localReplace(log: &Shared<Log>) -> i32 {
  let mut a = tracer(1, log)
  a = tracer(2, log)
  return 0
}
fn fieldReplace(log: &Shared<Log>) -> i32 {
  let mut p = Pair { first: tracer(3, log), second: tracer(4, log) }
  p.first = tracer(5, log)
  return 0
}
fn arrayReplace(log: &Shared<Log>) -> i32 {
  let mut arr = [tracer(6, log)]
  arr[0] = tracer(7, log)
  return 0
}
fn sliceReplace(values: &mut [Tracer], log: &Shared<Log>) -> i32 {
  values[0] = tracer(9, log)
  return 0
}
fn paramReplace(mut t: Tracer, log: &Shared<Log>) -> i32 {
  t = tracer(9, log)
  return 0
}
effect fn body() -> i32 ! OutOfMemoryError | WriterError {
  let log = run makeLog()
  let a = localReplace(&log)
  let b = fieldReplace(&log)
  let c = arrayReplace(&log)
  let mut arr = [tracer(8, &log)]
  let d = sliceReplace(&mut arr, &log)
  drop arr
  run printLog(&log)
  return 0
}
pub fn main() -> i32 {
  return run Effect.catchAll(body(), recoverAny)
}`

/** Replacement cleanup runs at the write, before an explicit drop and scope exit. */
export const replaceDropProgram = `import silk.os_writer { StdoutWriter }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
import silk.format { Format }
import silk.writer { Writer, WriterError }

struct Log {
  slots: [i32; 16]
  count: usize
}
struct Tracer {
  id: i32
  log: Shared<Log>
}
fn record(log: &mut Log, id: i32) -> i32 {
  log.slots[log.count] = id
  log.count = log.count + 1
  return 0
}
impl Drop for Tracer {
  fn drop(self: &mut Tracer) -> () {
    let id = self.id
    let r = Shared.withMut<Log, i32>(&self.log, record(id))
    return ()
  }
}
fn encode(log: &Log) -> i32 {
  let mut r = 0
  let mut i: usize = 0
  while i < log.count {
    r = r * 10 + log.slots[i]
    i = i + 1
  }
  return r
}
fn tracer(id: i32, log: &Shared<Log>) -> Tracer {
  return Tracer { id: id, log: Shared.clone<Log>(log) }
}
effect fn printLog(log: &Shared<Log>) -> () ! WriterError {
  let code = Shared.with<Log, i32>(log, encode)
  let mut writer = StdoutWriter.make()
  return run (Format.display(&code) |> Effect.provideMut<Writer>(&mut writer))
}
effect fn makeLog() -> Shared<Log> ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run (Shared.make<Log>(Log { slots: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0], count: 0 }) |> Effect.provideMut<Allocator>(&mut allocator))
}
effect fn recoverAny(e: OutOfMemoryError | WriterError) -> i32 { return -1 }
fn replaceAndDrop(log: &Shared<Log>) -> i32 {
  let mut a = tracer(1, log)
  let b = tracer(2, log)
  a = tracer(3, log)
  drop b
  let c = tracer(4, log)
  return 0
}
effect fn body() -> i32 ! OutOfMemoryError | WriterError {
  let log = run makeLog()
  let s = replaceAndDrop(&log)
  run printLog(&log)
  return 0
}
pub fn main() -> i32 {
  return run Effect.catchAll(body(), recoverAny)
}`

const algorithmExampleIds = [
  'breadth-first-search',
  'crc-32',
  'fft',
  'game-of-life',
  'matrix-multiplication',
  'quicksort',
  'sieve',
] as const

/** Complete algorithm examples execute as independently pinned native-corpus cases. */
const algorithmExamples: ReadonlyArray<CorpusProgram> = algorithmExampleIds.map((id) => {
  const root = new URL(`../../../../examples/algorithms/${id}/`, import.meta.url)
  const manifest = JSON.parse(readFileSync(new URL('example.json', root), 'utf8')) as {
    readonly source: string
    readonly expected: { readonly entryResult: number }
  }
  return Object.freeze({
    name: `algorithm-${id}`,
    source: readFileSync(new URL(manifest.source, root), 'utf8'),
    expected: Object.freeze({ _tag: 'Completes' as const, result: manifest.expected.entryResult }),
  })
})

const algorithmicFixtureRoot = new URL('../fixtures/algorithmic-acceptance/', import.meta.url)
const algorithmicCompilerFold: CorpusProgram = Object.freeze({
  name: 'algorithmic-compiler-fold',
  source: readFileSync(new URL('app/Main.silk', algorithmicFixtureRoot), 'utf8'),
  nativeImports: Object.freeze({
    'compiler/Coverage': readFileSync(
      new URL('compiler/Coverage.silk', algorithmicFixtureRoot),
      'utf8',
    ),
    'compiler/Member': readFileSync(
      new URL('compiler/Member.silk', algorithmicFixtureRoot),
      'utf8',
    ),
  }),
  expected: Object.freeze({ _tag: 'Completes', result: 42 }),
})

const pressurePrograms: ReadonlyArray<CorpusProgram> = [
  {
    name: 'scanner-owned-token-vector',
    source: readFileSync(
      new URL('../fixtures/scanner-acceptance/Main.silk', import.meta.url),
      'utf8',
    ),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'language-pressure-lexer',
    source: readFileSync(
      new URL('../../../../examples/language-pressure/lexer/main.silk', import.meta.url),
      'utf8',
    ),
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'language-pressure-stack-vm',
    source: readFileSync(
      new URL('../../../../examples/language-pressure/stack-vm/main.silk', import.meta.url),
      'utf8',
    ),
    expected: { _tag: 'Completes', result: 0 },
  },
]

export const httpRedirectCorpusProgram = Object.freeze({
  name: 'http-redirect',
  source: httpRedirectAcceptanceSource,
  expected: { _tag: 'Completes', result: 0 },
} satisfies CorpusProgram)

export const nativeCorpus: ReadonlyArray<CorpusProgram> = [
  {
    name: 'test-exchange-binary-framing',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.test_exchange as TestExchange

effect fn verify() -> i32 ! OutOfMemoryError {
  let plan: [u8; 56] = [
    83, 76, 75, 84, 80, 76, 78, 49,
    1, 0, 0, 0,
    1, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
    0, 0, 0, 0, 0, 0, 0, 0,
  ]
  let mut parsed = TestExchange.openPlan(&plan)
  if !TestExchange.beginPerTest(&mut parsed, 0) { return 1 }
  if !TestExchange.finishPerTest(&mut parsed) { return 2 }

  let mut malformed = plan
  malformed[0] = 0
  let rejected = TestExchange.openPlan(&malformed)
  if !TestExchange.failed(&rejected) { return 3 }

  let mut allocator = Allocator.systemAllocatorProvider()
  let receipt = run TestExchange.beginReceipt(&plan, true, 0)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let bytes = run TestExchange.finishReceipt(move receipt, 0, 0, 0, 0, 0, 0, 0)
    |> Effect.provideMut<Allocator>(&mut allocator)
  if Bytes.length(&bytes) != 140 { return 4 }
  let view = Bytes.asSlice(&bytes)
  if view[0] != 83 || view[7] != 49 || view[8] != 1 || view[12] != 1 { return 5 }
  return 42
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 6 }

pub fn main() -> i32 { return run Effect.catchAll(verify(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'https-san-adapter',
    source: sanAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'https-identity-matrix-v1',
    source: httpsIdentityAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'ecdsa-p256-verification',
    source: ecdsaP256AcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'p256-key-agreement',
    source: p256AcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'certificate-bounded-decoding',
    source: certificateAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'certificate-profile-and-trust-anchor',
    source: certificateProfileAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'certificate-path-validation',
    source: certificatePathAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-trust-snapshots',
    source: trustSourceAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'uri-rfc3986',
    source: uriAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-values',
    source: httpValuesAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-head-parsing',
    source: httpHeadAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'http-body-framing',
    source: httpBodyAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'http-content-decoding',
    source: httpContentAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-server',
    source: httpServerAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-client',
    source: httpClientAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  httpRedirectCorpusProgram,
  {
    name: 'http-client-boundaries',
    source: httpClientBoundariesAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-client-output-failures',
    source: httpClientOutputFailuresAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-client-ownership',
    source: httpClientOwnershipAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-client-content',
    source: httpClientContentAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-client-tls',
    source: httpTransportAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'http-client-request',
    source: httpRequestAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'websocket-upgrade',
    source: websocketUpgradeAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'base64-rfc4648',
    source: base64AcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'json-scanner',
    source: jsonScannerAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'toml-scanner',
    source: tomlScannerAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'toml-value',
    source: tomlValueAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'toml-output',
    source: tomlOutputAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'utf8-decoder',
    source: utf8DecoderAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'format-float-parser',
    source: `import silk.f32
import silk.f64
import silk.format { Format, ParseError }
import silk.result { Result }

fn check64(text: string, expected: u64) -> bool {
  return match move Format.f64Value(text) {
    Result<f64, ParseError>.Success { value } => f64.toBits(value) == expected
    Result<f64, ParseError>.Failure { error } => false
  }
}

fn check32(text: string, expected: u32) -> bool {
  return match move Format.f32Value(text) {
    Result<f32, ParseError>.Success { value } => f32.toBits(value) == expected
    Result<f32, ParseError>.Failure { error } => false
  }
}

fn rejects64(text: string) -> bool {
  return match move Format.f64Value(text) {
    Result<f64, ParseError>.Success { value } => false
    Result<f64, ParseError>.Failure { error } => true
  }
}

pub fn main() -> i32 {
  if !check64("0", 0) { return 1 }
  if !check64("-0.0", 9223372036854775808) { return 2 }
  if !check64("1", 4607182418800017408) { return 3 }
  if !check64("0.1", 4591870180066957722) { return 4 }
  if !check64("9007199254740993", 4845873199050653696) { return 5 }
  if !check64("4.9406564584124654e-324", 1) { return 6 }
  if !check64("1e-325", 0) { return 7 }
  if !check64("1.7976931348623157e308", 9218868437227405311) { return 8 }
  if !check64("1e309", 9218868437227405312) { return 9 }
  if !check64("2.2250738585072014e-308", 4503599627370496) { return 15 }
  if !check64("2.2250738585072011e-308", 4503599627370495) { return 16 }
  if !check64("1234567890123456789012345678901234567890e-340", 105036779111555283) { return 17 }
  if !check64("0.3333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333333", 4599676419421066581) { return 18 }
  if !check64("-1e-100000", 9223372036854775808) { return 19 }
  if !check64("-1e100000", 18442240474082181120) { return 20 }
  if !check32("1", 1065353216) { return 10 }
  if !check32("1.401298464324817e-45", 1) { return 11 }
  if !check32("3.4028234664e38", 2139095039) { return 12 }
  if !check32("1.0000000596046447753906250000000001", 1065353217) { return 13 }
  if !check32("16777217", 1266679808) { return 21 }
  if !check32("1.17549435e-38", 8388608) { return 22 }
  if !rejects64("NaN") || !rejects64("Infinity") || !rejects64("1e") || !rejects64("1x") { return 14 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'json-reader',
    source: jsonReaderAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'json-value',
    source: jsonValueAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'json-codec',
    source: jsonCodecAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'json-reflect',
    source: jsonReflectAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'buffered-byte-io',
    source: bufferedByteIoAcceptanceSource,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    ...networkAddressResolutionCorpusProgram,
    nativeProfiles: [
      { name: 'debug', optimization: 'none', debug: true },
      { name: 'optimized', optimization: 'speed', debug: false },
    ],
  },
  {
    ...nativeSocketCorpusProgram,
    nativeProfiles: [{ name: 'optimized', optimization: 'speed', debug: false }],
  },
  {
    ...nativeListenerCorpusProgram,
    nativeProfiles: [{ name: 'optimized', optimization: 'speed', debug: false }],
  },
  {
    name: 'borrowed-temporary-stream-suspension',
    source: borrowedTemporaryStream,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'borrowed-temporary-owner-lifecycle',
    source: borrowedTemporaryLifecycle,
    nativeCSources: {
      events: `#include <stdint.h>
#include <stdio.h>
void silk_record_event(int32_t value) { printf("%d,", value); }
int32_t silk_finish_events(void) { puts(""); return 42; }
`,
    },
    nativeStdout:
      '90,11,12,21,1,2,90,13,23,3,90,14,24,4,20,90,17,27,27,47,7,10,20,90,17,47,7,10,90,18,28,48,8,90,18,48,8,90,19,29,49,9,90,15,95,5,90,16,26,6,\n',
    expected: { _tag: 'Completes', result: 42 },
  },
  ...[
    { name: 'borrowed-outcome-box', source: borrowedBox },
    { name: 'borrowed-outcome-stream', source: borrowedStream },
    { name: 'borrowed-outcome-failure', source: borrowedFailure },
    { name: 'borrowed-outcome-affine-stream', source: affineBorrowedStream },
  ].map((program): CorpusProgram => ({ ...program, expected: { _tag: 'Completes', result: 42 } })),

  {
    name: 'vector-dependent-elements-cleanup-and-extraction',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.vector { Vector }
import silk.layout { Layout }
struct Quota { remaining: i32 }
effect fn allocate(self: &mut Quota, layout: Layout) -> Allocation ! OutOfMemoryError {
  if self.remaining == 0 { fail OutOfMemoryError {} }
  self.remaining = self.remaining - 1
  let mut system = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut system)
}
impl Allocator for Quota { allocate: Quota.allocate }
effect fn ignoreFailure(error: OutOfMemoryError) -> () { return () }
struct Entry<'a> { value: &'a mut i32 }
impl<'a> Drop for Entry<'a> {
  fn drop(self: &mut Entry<'a>) -> () { self.value.* = self.value.* + 1 return () }
}
struct Outer<'a> { entry: Entry<'a> code: i32 }
effect fn exercise<'a>(a: &'a mut i32, b: &'a mut i32, c: &'a mut i32, d: &'a mut i32, e: &'a mut i32, f: &'a mut i32) -> () ! OutOfMemoryError ? &mut Allocator {
  let mut values = Vector.make<Entry<'a>>()
  run Vector.append<Entry<'a>>(&mut values, Entry { value: move a })
  run Vector.append<Entry<'a>>(&mut values, Entry { value: move b })
  run Vector.insert<Entry<'a>>(&mut values, 1, Entry { value: move c })
  run Vector.append<Entry<'a>>(&mut values, Entry { value: move d })
  run Vector.append<Entry<'a>>(&mut values, Entry { value: move e })
  Vector.set<Entry<'a>>(&mut values, 0, Entry { value: move f })
  let outer = Outer { entry: Vector.remove<Entry<'a>>(&mut values, 1), code: 7 }
  let extracted = move outer.entry
  drop outer
  let last = Vector.pop<Entry<'a>>(&mut values)
  drop values
  drop extracted
  drop last
  return ()
}
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut a = 0 let mut b = 0 let mut c = 0 let mut d = 0 let mut e = 0 let mut f = 0
  let mut parent = &mut a let nested = &mut parent
  nested.*.* = 4 drop nested drop parent
  if a != 4 { return 0 } a = 0
  run exercise(&mut a, &mut b, &mut c, &mut d, &mut e, &mut f) |> Effect.provideMut(&mut allocator)
  if a != 1 || b != 1 || c != 1 || d != 1 || e != 1 || f != 1 { return 0 }
  a = 0 b = 0 c = 0 d = 0 e = 0 f = 0
  let mut quota = Quota { remaining: 1 }
  run Effect.catchAll(exercise(&mut a, &mut b, &mut c, &mut d, &mut e, &mut f), ignoreFailure)
    |> Effect.provideMut(&mut quota)
  let mut references = Vector.make<&i32>()
  run Vector.append<&i32>(&mut references, &a) |> Effect.provideMut(&mut allocator)
  let saved = Vector.remove<&i32>(&mut references, 0)
  drop references
  if saved.* == 1 && b == 1 && c == 1 && d == 1 && e == 1 && f == 0 { return 42 }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'partial-owner-suspension-cancellation-and-restoration',
    source: partialSuspension,
    nativeCSources: {
      drops: `#include <stdint.h>
#include <stdio.h>
static char events[32];
static unsigned count;
void silk_record_drop(int32_t value) {
  if (count < sizeof(events) - 1) events[count++] = (char)('0' + value);
}
int32_t silk_verify_drops(void) { puts(events); return 42; }
`,
    },
    nativeStdout: '1212465465\n',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'partial-owner-cleanup-and-refinement',
    source: `unsafe extern "C" fn silk_record_drop(value: i32) -> ()
unsafe extern "C" fn silk_verify_drops() -> i32
struct Token { value: i32 }
impl Drop for Token {
  fn drop(self: &mut Token) -> () {
    unsafe { silk_record_drop(self.value) }
    return ()
  }
}
struct Pair { left: Token right: Token }
union Packet { Empty, Ready { left: Token, right: Token } }
struct Envelope { packet: Packet footer: Token }
fn conditional(take: bool) -> () {
  let pair = Pair { left: Token { value: 1 }, right: Token { value: 2 } }
  if take { let extracted = move pair.left drop extracted }
  return ()
}
fn restored() -> () {
  let mut pair = Pair { left: Token { value: 3 }, right: Token { value: 4 } }
  let extracted = move pair.left
  drop extracted
  pair.left = Token { value: 5 }
  drop pair
  return ()
}
fn refined(packet: Packet) -> () {
  let envelope = Envelope { packet: move packet, footer: Token { value: 8 } }
  match place envelope.packet {
    Packet.Ready { left, .. } => { let extracted = move left drop extracted }
    Packet.Empty => {}
  }
  drop envelope
  return ()
}
pub fn main() -> i32 {
  conditional(false)
  conditional(true)
  restored()
  refined(Packet.Ready { left: Token { value: 6 }, right: Token { value: 7 } })
  unsafe { return silk_verify_drops() }
}`,
    nativeCSources: {
      drops: `#include <stdint.h>
#include <stdio.h>
static char events[32];
static unsigned count;
void silk_record_drop(int32_t value) {
  if (count < sizeof(events) - 1) events[count++] = (char)('0' + value);
}
int32_t silk_verify_drops(void) { puts(events); return 42; }
`,
    },
    nativeStdout: '1212354678\n',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'match-statement-arm-control',
    source: `struct Left { value: i32 }
struct Right {}
struct Total { value: i32 }
fn identity(value: i32) -> i32 { return value }
fn early(input: Left | Right) -> i32 {
  return identity(match &input {
    Left { value } => { return value }
    Right {} => 0
  }) + 100
}
fn guarded(input: Left | Right) -> i32 {
  return match &input {
    Left { value } if false => 100
    Left { value } if match value { _ => { return value } } => 100
    _ => 0
  }
}
fn deferred(input: Left | Right) -> Effect<'static; i32> {
  match &input {
    Left { value } => { return effect { return value } }
    Right {} => { return effect { return 8 } }
  }
}
effect fn add(total: &mut Total, amount: i32) -> () { total.value = total.value + amount }
effect fn selected() -> i32 {
  let mut total = Total { value: 0 }
  let mut count = 0
  while count < 4 {
    count = count + 1
    match count {
      _ if count == 1 => { continue }
      _ if count == 4 => { break }
      _ => { while true { break } run add(&mut total, count) }
    }
  }
  let input = Left { value: 2 }
  match &input {
    Left { value } => { run add(&mut total, value) run add(&mut total, 3) }
  }
  return total.value
}
pub fn main() -> i32 {
  if early(Left { value: 17 }) != 17 { return 1 }
  if early(Right {}) != 100 { return 2 }
  if guarded(Left { value: 3 }) != 3 { return 3 }
  let result = run selected()
  if result != 10 { return 4 }
  let left = run deferred(Left { value: 7 })
  let right = run deferred(Right {})
  if left != 7 || right != 8 { return 5 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'match-statement-arm-abandoned-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Counts { order: i32 }
struct Guard { counts: Shared<Counts> digit: i32 }
struct Pair { selected: Guard omitted: Guard }
fn read(counts: &Counts) -> i32 { return counts.order }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let digit = self.digit
    Shared.withMut(&self.counts, fn(counts: &mut Counts) -> () {
      counts.order = counts.order * 10 + digit
      return ()
    })
  }
}
fn guard(counts: &Shared<Counts>, digit: i32) -> Guard {
  return Guard { counts: Shared.clone<Counts>(counts), digit: digit }
}
fn uncalled(first: Guard, value: i32) -> i32 { return 99 }
fn early(counts: &Shared<Counts>) -> i32 {
  return uncalled(guard(counts, 1), match move (Pair {
    selected: guard(counts, 2), omitted: guard(counts, 3),
  }) {
    Pair { selected, .. } => { let local = guard(counts, 4) return 17 }
  })
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counts = run Shared.make<Counts>(Counts { order: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  if early(&counts) != 17 { return 1 }
  let order = Shared.with<Counts, i32>(&counts, read)
  drop counts
  if order != 4231 { return 2 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'integer-operation-matrix',
    source: integerOperationMatrix,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'float-operation-matrix',
    source: floatOperationMatrix,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'callable-return-and-borrow-contracts',
    source: `struct Token { value: i32 }
fn inc2(value: i32) -> i32 { return value + 2 }
fn returnedNamed() -> fn<'static>(i32) -> i32 { return inc2 }
fn returnedAnonymous(offset: i32) -> fn<'static>(i32) -> i32 {
  return fn(value: i32) -> i32 { return value + offset }
}
fn combine(left: i32, right: i32) -> i32 { return left * 10 + right }
fn returnedSection() -> fn<'static>(i32) -> i32 { return combine(2) }
fn returnedOnce(token: Token) -> once fn<'static>() -> Token {
  return fn() -> Token { return move token }
}
fn returnedCopyBinding() -> fn<'static>() -> i32 {
  let value = 42
  return fn() -> i32 { return value }
}
fn pass<'env>(operation: fn<'env>(i32) -> i32) -> fn<'env>(i32) -> i32 { return operation }
fn select(value: i32, values: &[i32]) -> i32 { return value + values[0] }
fn returnedBorrow(values: &[i32]) -> fn(i32) -> i32 { return select(&values) }
fn selectMut(value: i32, values: &mut [i32]) -> i32 {
  values[0] = values[0] + 1
  return value + values[0]
}
fn returnedExclusiveBorrow(values: &mut [i32]) -> mut fn(i32) -> i32 {
  return selectMut(&mut values)
}
pub fn main() -> i32 {
  if returnedNamed()(40) != 42 { return 1 }
  if returnedAnonymous(2)(40) != 42 { return 2 }
  if returnedSection()(4) != 42 { return 3 }
  if pass(inc2)(40) != 42 { return 4 }
  let take = returnedOnce(Token { value: 42 })
  let token = take()
  if token.value != 42 { return 5 }
  if returnedCopyBinding()() != 42 { return 6 }
  let values = [40]
  if returnedBorrow(&values)(2) != 42 { return 7 }
  let mut mutableValues = [40]
  let mut callback = returnedExclusiveBorrow(&mut mutableValues)
  let result = callback(1)
  drop callback
  if result != 42 || mutableValues[0] != 41 { return 8 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-provider-shared-dispatch',
    source: `import silk.effect { Effect }
service Counter {
  effect fn get() -> i32 ? &Counter
  effect fn bump() -> () ? &mut Counter
}
struct Cell { value: i32 }
effect fn get(self: &Cell) -> i32 { return self.value }
effect fn bump(self: &mut Cell) -> () { self.value = self.value + 1 }
impl Counter for Cell { get: Cell.get bump: Cell.bump }
effect fn both() -> i32 ? &mut Counter {
  run Counter.bump()
  run Counter.bump()
  return run Counter.get()
}
pub fn main() -> i32 {
  let observed = run Effect.bindRequirementOwned<Counter>(both(), Cell { value: 1 })
  if observed != 3 { return 1 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-allocation-forwarded-provider-mutation',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
struct CountingAllocator { hits: i32 }
effect fn allocate(self: &mut CountingAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  self.hits = self.hits + 1
  let mut inner = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut inner)
}
impl Allocator for CountingAllocator { allocate: CountingAllocator.allocate }
effect fn forwarded(layout: Layout) -> Allocation ! OutOfMemoryError ? &mut Allocator {
  return run Allocator.allocate(move layout)
}
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = CountingAllocator { hits: 0 }
  let block = run forwarded(Layout.of<[i32; 2]>()) |> Effect.provideMut(&mut allocator)
  drop block
  if allocator.hits != 1 { return 2 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 3 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'zero-sized-copy-vector-read',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.vector { Vector }
struct Marker {}
impl Copy for Marker {}
fn observe(value: Marker) -> i32 { return 42 }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut values = Vector.make<Marker>()
  run Vector.append<Marker>(&mut values, Marker {}) |> Effect.provideMut(&mut allocator)
  return observe(Vector.get<Marker>(&values, 0))
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'owned-allocation-provider-matrix',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
struct QuotaAllocator { remaining: i32 calls: i32 }
effect fn allocate(self: &mut QuotaAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  self.calls = self.calls + 1
  if self.remaining == 0 { fail OutOfMemoryError {} }
  self.remaining = self.remaining - 1
  let mut inner = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(move layout) |> Effect.provideMut(&mut inner)
}
impl Allocator for QuotaAllocator { allocate: QuotaAllocator.allocate }
effect fn attempt() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let first = run Allocator.allocate(Layout.of<[i32; 2]>())
  let second = run Allocator.allocate(Layout.of<[i32; 2]>())
  drop first
  drop second
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
fn probe(quota: i32) -> i32 {
  let mut allocator = QuotaAllocator { remaining: quota, calls: 0 }
  let result = run Effect.catchAll(
    attempt() |> Effect.provideMut<Allocator>(&mut allocator),
    recover
  )
  let mut expectedCalls = 2
  if quota == 0 { expectedCalls = 1 }
  if allocator.calls != expectedCalls { return 10 + quota }
  if allocator.remaining != 0 { return 20 + quota }
  return result
}
pub fn main() -> i32 {
  if probe(0) != 7 { return 1 }
  if probe(1) != 7 { return 2 }
  if probe(2) != 42 { return 3 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'scheduler-task-id-boundary',
    source: `${localSchedulerImplementation}

fn requireReserved(selected: ReservedIdentity | Refused) -> u64 {
  return match move selected {
    ReservedIdentity { identity } => identity.value
    Refused {} => u64.MIN
  }
}
fn verifyTaskIdRefusal(selected: ReservedIdentity | Refused, fresh: u64) -> i32 {
  return match move selected {
    ReservedIdentity { identity } => -3
    Refused {} => verifyFreshTaskId(fresh)
  }
}
fn verifyFreshTaskId(fresh: u64) -> i32 {
  if fresh != 0 { return -4 }
  return 42
}
fn taskIdBoundary() -> i32 {
  let mut nearLimit = TaskIdSource { next: 18446744073709551614, exhausted: false }
  let first = requireReserved(reserveIdentityStep(&mut nearLimit))
  let second = requireReserved(reserveIdentityStep(&mut nearLimit))
  let refused = reserveIdentityStep(&mut nearLimit)
  let mut freshSource = TaskIdSource { next: 0, exhausted: false }
  let fresh = requireReserved(reserveIdentityStep(&mut freshSource))
  if first != 18446744073709551614 { return -1 }
  if second != u64.MAX { return -2 }
  return verifyTaskIdRefusal(move refused, fresh)
}
pub fn main() -> i32 { return taskIdBoundary() }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'execution-unused-nominal-union-callback-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.i8
import silk.layout { Layout }
import silk.shared { Shared }
struct Counter { value: i32 }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
struct Guard { left: i8 right: i8 storage: Allocation counter: Shared<Counter> }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    if i8.toI32(self.left) != 19 || i8.toI32(self.right) != 23 { let boom = 1 / 0 }
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
union Choice { Small { marker: i8, guard: Guard }, Wide { value: i64 } }
fn ready(state: &()) -> () { return () }
fn complete(state: (), value: i32) -> () { return () }
fn suspend(state: (), execution: Intrinsic.Execution<i32>, choice: Choice) -> () {
  let unexpected = 1 / 0
  drop execution
  drop choice
  return ()
}
fn suspendWith(choice: Choice) -> some<F: once fn((), Intrinsic.Execution<i32>) -> ()> F {
  return suspend(move choice)
}
effect fn packaged(counter: &Shared<Counter>) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let storage = run Allocator.allocate(Layout.of<i32>())
  let choice = Choice.Small {
    marker: i8.toI8(7),
    guard: Guard {
      left: i8.toI8(19), right: i8.toI8(23), storage: move storage,
      counter: Shared.clone<Counter>(counter),
    },
  }
  let execution = run Execution.make(effect { return 42 }, (), ready)
  let driven = run Execution.drive(move execution, (), complete, suspendWith(move choice))
  let count = Shared.with<Counter, i32>(counter, read)
  if count != 1 { return 1 }
  return 42
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let result = run packaged(&counter) |> Effect.provideMut<Allocator>(&mut allocator)
  drop counter
  return result
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'generic-inline-effect-conformance',
    source: `interface Marker { effect fn mark(value: &Self) -> i32 }
struct Box<T> { value: T }
impl<T> Marker for Box<T> {
  effect fn mark(value: &Self) -> i32 { return 42 }
}
effect fn through<T: Marker>(value: &T) -> i32 { return run Marker.mark(value) }
pub fn main() -> i32 {
  let boxed = Box { value: true }
  return run through(&boxed)
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'bound-inline-scalar-effect-rows',
    source: `import silk.effect { Effect }
import silk.result { Result }
struct Problem { code: i32 }
service Output { effect fn emit(number: i32) -> i32 ? &Output }
struct FixedOutput {}
effect fn emit(self: &FixedOutput, number: i32) -> i32 { return number }
impl Output for FixedOutput { emit: FixedOutput.emit }
interface Present { effect fn present(value: &Self) -> i32 ! Problem ? &Output }
impl Present for i32 {
  effect fn present(value: &Self) -> i32 ! Problem ? &Output { return run Output.emit(42) }
}
fn pending<T: Present>(value: &T) -> Effect<i32 ! Problem ? &Output> {
  return Present.present(value)
}
fn observe(result: Result<i32, Problem>) -> i32 {
  return match move result {
    Result<i32, Problem>.Success { value } => value
    Result<i32, Problem>.Failure { error } => error.code
  }
}
pub fn main() -> i32 {
  let output = FixedOutput {}
  let value = 7
  let provided = pending<i32>(&value) |> Effect.provide(&output)
  return observe(run Effect.result(provided))
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'generic-service-stabilization-contracts',
    source: `import silk.effect { Effect }
interface Hashable { fn hash(value: &Self) -> i32 }
interface Display { fn display(value: &Self) -> i32 }
struct Key { value: i32 }
impl Hashable for Key { fn hash(value: &Self) -> i32 { return value.value } }
impl Display for Key { fn display(value: &Self) -> i32 { return value.value * 2 } }
fn onlyHash<T: Hashable>(value: &T) -> i32 { return Hashable.hash(value) }
fn onlyDisplay<T: Display>(value: &T) -> i32 { return Display.display(value) }
fn forward<T: Hashable>(value: &T) -> i32 { return onlyHash(value) }
fn byValue<T: Hashable>(value: T) -> i32 { return onlyHash<T>(&value) }
fn subset<T: Hashable + Display>(value: &T) -> i32 {
  return onlyDisplay(value) + Display.display(value)
}

interface Wrap { fn wrap(value: &Self) -> i32 }
struct Box<T> { value: T }
struct Leaf { value: i32 }
fn boxSize<T>(value: &Box<T>) -> i32 { return 40 }
impl<T> Wrap for Box<T> {
  fn wrap(value: &Self) -> i32 {
    let inner: &T = &value.value
    return boxSize<T>(value) + 2
  }
}
fn wrapped<T: Wrap>(value: &T) -> i32 { return Wrap.wrap(value) }

interface Printable { fn print(value: &Self) -> i32 }
struct Document { size: i32 }
impl Printable for Document { fn print(value: &Self) -> i32 { return value.size } }
impl<T: Printable> Printable for Box<T> {
  fn print(value: &Self) -> i32 { return value.value.print() + 1 }
}
fn printed<T: Printable>(value: &T) -> i32 { return Printable.print(value) }

interface SchemaInterface {
  fn decode(value: &Self) -> i32
  fn width(value: &Self) -> i32
}
service SchemaService {
  fn decode(value: &Self) -> i32
  fn width(value: &Self) -> i32
}
struct InterfaceSchema {}
struct ServiceSchema {}
fn interfaceWidth(value: &InterfaceSchema) -> i32 { return 32 }
fn serviceWidth(value: &ServiceSchema) -> i32 { return 32 }
impl SchemaInterface for InterfaceSchema {
  fn decode(value: &Self) -> i32 { return 42 }
  width: InterfaceSchema.interfaceWidth
}
impl SchemaService for ServiceSchema {
  fn decode(value: &Self) -> i32 { return 42 }
  width: ServiceSchema.serviceWidth
}
fn useInterface<T: SchemaInterface>(value: &T) -> i32 {
  return SchemaInterface.decode(value) + SchemaInterface.width(value)
}
fn useService<T: SchemaService>(value: &T) -> i32 {
  return SchemaService.decode(value) + SchemaService.width(value)
}

interface Encodable<A> { fn encode(value: &Self) -> A }
struct Age { years: i32 }
impl Encodable<i32> for Age { fn encode(value: &Self) -> i32 { return value.years } }

service Clock {}
service Logger {}
struct SystemClock {}
struct Log {}
impl Clock for SystemClock {}
impl Logger for Log {}
role Primary
effect fn work() -> i32 ? &Clock | &Logger { return 1 }
fn narrowed(clock: &SystemClock) -> Effect<i32 ? Without<&Clock | &Logger, Clock>> {
  return Effect.provide<Clock>(work(), clock)
}
effect fn primaryWork() -> i32 ? &Clock at Primary { return 1 }
fn primaryNarrowed(
  clock: &SystemClock
) -> Effect<i32 ? Without<&Clock at Primary, Clock at Primary>> {
  return Effect.provide<Clock at Primary>(primaryWork(), clock)
}

pub fn main() -> i32 {
  let key = Key { value: 42 }
  if forward(&key) != 42 { return 1 }
  if byValue<Key>(Key { value: 42 }) != 42 { return 2 }
  let half = Key { value: 21 }
  if subset(&half) != 84 { return 3 }
  let boxed = Box { value: Leaf { value: 1 } }
  if wrapped(&boxed) != 42 { return 4 }
  let document = Box { value: Box { value: Document { size: 40 } } }
  if printed(&document) != 42 { return 5 }
  let interfaceSchema = InterfaceSchema {}
  let serviceSchema = ServiceSchema {}
  if useInterface(&interfaceSchema) != 74 || useService(&serviceSchema) != 74 { return 6 }
  let age = Age { years: 42 }
  if Encodable.encode(&age) != 42 { return 7 }
  let clock = SystemClock {}
  let logger = Log {}
  let ordinary = run Effect.provide<Logger>(narrowed(&clock), &logger)
  if ordinary != 1 { return 8 }
  let primary = run primaryNarrowed(&clock)
  if primary != 1 { return 9 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'finite-effect-join-selected-requirement',
    source: `import silk.effect { Effect }
service LeftClock { effect fn read() -> i32 ? &LeftClock }
service RightClock { effect fn read() -> i32 ? &RightClock }
struct Left { value: i32 }
struct Right { value: i32 }
effect fn readLeft(self: &Left) -> i32 { return self.value }
effect fn readRight(self: &Right) -> i32 { return self.value }
impl LeftClock for Left { read: Left.readLeft }
impl RightClock for Right { read: Right.readRight }
effect fn useLeft() -> i32 ? &LeftClock { return run LeftClock.read() }
effect fn useRight() -> i32 ? &RightClock { return run RightClock.read() }
struct First {}
struct Second {}
fn choose(input: First | Second) -> Effect<'static; i32 ? &LeftClock | &RightClock> {
  return match move input {
    First {} => useLeft()
    Second {} => useRight()
  }
}
pub fn main() -> i32 {
  let left = Left { value: 41 }
  let right = Right { value: 42 }
  let selected = choose(Second {})
    |> Effect.provide<LeftClock>(&left)
    |> Effect.provide<RightClock>(&right)
  return run selected
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'role-keyed-service-provider-selection',
    source: `role Left
role Right
service Values {
  effect fn left() -> i32 ? &Values at Left
  effect fn right() -> i32 ? &Values at Right
}
struct Fixed { value: i32 }
effect fn left(self: &Fixed) -> i32 { return self.value }
effect fn right(self: &Fixed) -> i32 { return self.value }
impl Values for Fixed { left: Fixed.left right: Fixed.right }
effect fn total() -> i32 ? &Values at Left | &Values at Right {
  let leftValue = run Values.left()
  let rightValue = run Values.right()
  return leftValue * 10 + rightValue
}
pub fn main() -> i32 {
  let leftProvider = Fixed { value: 4 }
  let rightProvider = Fixed { value: 2 }
  let selected = total()
    |> Intrinsic.bindRequirement<Values at Left>(&leftProvider)
    |> Intrinsic.bindRequirement<Values at Right>(&rightProvider)
  return run selected
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'inherent-member-over-module-projection',
    source: `import counter { Counter, read }
pub fn main() -> i32 {
  let made = Counter.make()
  return read(&made)
}`,
    nativeImports: Object.freeze({
      counter: `pub struct Counter { value: i32 }
pub fn make() -> Counter { return Counter { value: 1 } }
impl Counter { pub fn make() -> Self { return Counter { value: 42 } } }
pub fn read(counter: &Counter) -> i32 { return counter.value }`,
    }),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'execution-body-and-endpoint-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.execution { Execution }
import silk.layout { Layout }
import silk.shared { Shared }
struct Audit { body: i32 endpoint: i32 }
fn recordBody(audit: &mut Audit) -> i32 { audit.body = audit.body + 1 return audit.body }
fn recordEndpoint(audit: &mut Audit) -> i32 {
  audit.endpoint = audit.endpoint + 1
  return audit.endpoint
}
fn readAudit(audit: &Audit) -> i32 { return audit.body * 10 + audit.endpoint }
struct BodyGuard { storage: Allocation audit: Shared<Audit> }
impl Drop for BodyGuard {
  fn drop(self: &mut BodyGuard) -> () {
    let count = Shared.withMut<Audit, i32>(&self.audit, recordBody)
    return ()
  }
}
struct EndpointGuard { storage: Allocation audit: Shared<Audit> }
impl Drop for EndpointGuard {
  fn drop(self: &mut EndpointGuard) -> () {
    let count = Shared.withMut<Audit, i32>(&self.audit, recordEndpoint)
    return ()
  }
}
struct Ready { guard: EndpointGuard }
fn ready(state: &Ready) -> () { return () }
fn readyUnit(state: &()) -> () { return () }
fn complete(state: (), value: i32) -> () { return () }
fn suspend(state: (), execution: Intrinsic.Execution<i32>) -> () {
  drop execution
  return ()
}
effect fn body(guard: BodyGuard) -> i32 {
  let unexpected = 1 / 0
  return unexpected
}
effect fn exercise(audit: &Shared<Audit>) -> () ! OutOfMemoryError ? &mut Allocator {
  let bodyStorage = run Allocator.allocate(Layout.of<i32>())
  let bodyExecution = run Execution.make(
    body(BodyGuard { storage: move bodyStorage, audit: Shared.clone<Audit>(audit) }),
    (), readyUnit
  )
  drop bodyExecution
  let endpointStorage = run Allocator.allocate(Layout.of<i32>())
  let endpointExecution = run Execution.make(
    effect { return 42 },
    Ready {
      guard: EndpointGuard {
        storage: move endpointStorage, audit: Shared.clone<Audit>(audit),
      },
    },
    ready
  )
  let endpointDriven = run Execution.drive(move endpointExecution, (), complete, suspend)
  return ()
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let audit = run Shared.make<Audit>(Audit { body: 0, endpoint: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let exercised = run exercise(&audit) |> Effect.provideMut<Allocator>(&mut allocator)
  let observed = Shared.with<Audit, i32>(&audit, readAudit)
  drop audit
  if observed != 11 { return 1 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 2 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'logging-composition',
    source: `import silk.effect { Effect }
import silk.logger { LogError, LogLevel, Logger }
import silk.os_logger { StdoutLogger }
effect fn logAndKeep(value: i32) -> i32 ! LogError ? &mut Logger {
  let logged = run Effect.logDebug("d{}", &(value,))
  return value
}
effect fn storedLog() -> i32 ! LogError ? &mut Logger {
  let logged = run Effect.log("s", &())
  return 1
}
effect fn value(number: i32) -> i32 { return number }
effect fn composed() -> i32 ! LogError ? &mut Logger {
  let trace = run Effect.logTrace("t", &())
  let direct = run Effect.log("i{}", &(2,))
  let info = run Effect.logInfo("n{name}", &.{ name: "amed" })
  let warning = run Effect.logWarning("w", &())
  let error = run Effect.logError("e", &())
  let level = LogLevel.Warning
  let selected = run Effect.logAt(level, "a", &())
  let stored = storedLog()
  let storedValue = run stored
  let tapped = run (value(20) |> Effect.tap(logAndKeep))
  if storedValue != 1 || tapped != 20 { return 2 }
  return 42
}
effect fn ignore(error: LogError) -> () { return () }
effect fn program() -> i32 ! LogError {
  let mut logger = Logger.inMemoryProvider()
  let result = run composed() |> Effect.provideMut(&mut logger)
  if Logger.length(&logger) != 8 { return 1 }
  if Logger.levelAt(&logger, 0) != LogLevel.Trace { return 3 }
  if Logger.levelAt(&logger, 1) != LogLevel.Info { return 4 }
  if Logger.levelAt(&logger, 2) != LogLevel.Info { return 5 }
  if Logger.levelAt(&logger, 3) != LogLevel.Warning { return 6 }
  if Logger.levelAt(&logger, 4) != LogLevel.Error { return 7 }
  if Logger.levelAt(&logger, 5) != LogLevel.Warning { return 8 }
  if Logger.levelAt(&logger, 6) != LogLevel.Info { return 9 }
  if Logger.levelAt(&logger, 7) != LogLevel.Debug { return 10 }
  if Logger.messageLengthAt(&logger, 0) != 1 || Logger.messageByteAt(&logger, 0, 0) != 116 { return 11 }
  if Logger.messageLengthAt(&logger, 1) != 2 { return 12 }
  if Logger.messageByteAt(&logger, 1, 0) != 105 || Logger.messageByteAt(&logger, 1, 1) != 50 { return 13 }
  if Logger.messageLengthAt(&logger, 2) != 5 { return 14 }
  if Logger.messageByteAt(&logger, 2, 0) != 110 || Logger.messageByteAt(&logger, 2, 1) != 97 { return 15 }
  if Logger.messageByteAt(&logger, 2, 2) != 109 || Logger.messageByteAt(&logger, 2, 3) != 101 { return 16 }
  if Logger.messageByteAt(&logger, 2, 4) != 100 { return 17 }
  if Logger.messageLengthAt(&logger, 3) != 1 || Logger.messageByteAt(&logger, 3, 0) != 119 { return 18 }
  if Logger.messageLengthAt(&logger, 4) != 1 || Logger.messageByteAt(&logger, 4, 0) != 101 { return 19 }
  if Logger.messageLengthAt(&logger, 5) != 1 || Logger.messageByteAt(&logger, 5, 0) != 97 { return 20 }
  if Logger.messageLengthAt(&logger, 6) != 1 || Logger.messageByteAt(&logger, 6, 0) != 115 { return 21 }
  if Logger.messageLengthAt(&logger, 7) != 3 { return 22 }
  if Logger.messageByteAt(&logger, 7, 0) != 100 || Logger.messageByteAt(&logger, 7, 1) != 50 { return 23 }
  if Logger.messageByteAt(&logger, 7, 2) != 48 { return 24 }

  let mut configured = Logger.inMemoryProviderFailAt(0)
  run Effect.catchAll(
    Effect.log("rejected {}", &(1,)) |> Effect.provideMut(&mut configured),
    ignore
  )
  let afterConfiguredFailure = run Effect.logWarning("ok", &())
    |> Effect.provideMut(&mut configured)
  if Logger.attempts(&configured) != 2 || Logger.length(&configured) != 1 { return 25 }
  if Logger.levelAt(&configured, 0) != LogLevel.Warning { return 26 }
  if Logger.messageLengthAt(&configured, 0) != 2 { return 27 }
  if Logger.messageByteAt(&configured, 0, 0) != 111 { return 28 }
  if Logger.messageByteAt(&configured, 0, 1) != 107 { return 29 }

  let mut bounded = Logger.inMemoryProvider()
  run Effect.catchAll(
    Effect.log("xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx{}", &(1,))
      |> Effect.provideMut(&mut bounded),
    ignore
  )
  let afterCapacityFailure = run Effect.logError("ok", &())
    |> Effect.provideMut(&mut bounded)
  if Logger.attempts(&bounded) != 2 || Logger.length(&bounded) != 1 { return 30 }
  if Logger.levelAt(&bounded, 0) != LogLevel.Error { return 31 }
  if Logger.messageLengthAt(&bounded, 0) != 2 { return 32 }
  if Logger.messageByteAt(&bounded, 0, 0) != 111 { return 33 }
  if Logger.messageByteAt(&bounded, 0, 1) != 107 { return 34 }
  let mut stdout = StdoutLogger.make()
  let printed = run Effect.logInfo("stdout {value}", &.{ value: 42 })
    |> Effect.provideMut(&mut stdout)
  return result
}
effect fn recover(error: LogError) -> i32 { return 3 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
    nativeStdout: 'stdout 42',
  },
  {
    name: 'multi-affine-effect-return',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.usize
import silk.vector { Vector }
struct Step { pc: usize opcode: u8 depth: usize top: i32 }
struct VmDiagnostic { pc: usize code: usize }
struct Returned { first: Vector<Step> second: Vector<VmDiagnostic> result: i32 fingerprint: i32 }
effect fn pushStep(values: &mut Vector<Step>, step: Step) -> () ! OutOfMemoryError ? &mut Allocator {
  return run Vector.append<Step>(move values, move step)
}
fn finish(first: Vector<Step>, second: Vector<VmDiagnostic>, result: i32, fingerprint: i32) -> Returned {
  return Returned { first: move first, second: move second, result: result, fingerprint: fingerprint }
}
effect fn build() -> Returned ! OutOfMemoryError ? &mut Allocator {
  let mut first = Vector.make<Step>()
  let mut index = usize.add(0, 0)
  while index < 6 {
    let step = Step { pc: index, opcode: 1, depth: index + 1, top: usize.toI32(index) }
    run pushStep(&mut first, move step)
    index = index + 1
  }
  let second = Vector.make<VmDiagnostic>()
  return finish(move first, move second, 5, 7)
}
fn observeValues(
  first: Vector<Step>,
  second: Vector<VmDiagnostic>,
  result: i32,
  fingerprint: i32
) -> i32 {
  if Vector.length<Step>(&first) != 6 { return 1 }
  if Vector.length<VmDiagnostic>(&second) != 0 { return 2 }
  return result + fingerprint + 30
}
fn observe(returned: Returned) -> i32 {
  return match move returned {
    Returned { first, second, result, fingerprint } =>
      observeValues(move first, move second, result, fingerprint)
  }
}
effect fn execute() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let returned = run build() |> Effect.provideMut(&mut allocator)
  return observe(move returned)
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 3 }
pub fn main() -> i32 { return run Effect.catchAll(execute(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-access-forwarding',
    source: `struct Payload { value: i32 }
fn forwardReusable<'env>(self: mut Effect<'env; i32>) -> mut Effect<'env; i32> { return move self }
fn forwardOnce<'env>(self: once Effect<'env; Payload>) -> once Effect<'env; Payload> { return move self }
pub fn main() -> i32 {
  let mut counter = 40
  let pending = effect { counter = counter + 1 return counter }
  let forwarded = forwardReusable(move pending)
  let first = run forwarded
  let second = run forwarded
  drop forwarded
  let payload = Payload { value: 42 }
  let singlePending = effect { return move payload }
  let single = forwardOnce(move singlePending)
  let result = run single
  if first != 41 || second != 42 || result.value != 42 { return 1 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'opaque-effect',
    source: `fn make(value: i32) -> some<F: Effect<'static; i32>> F {
  return effect { return value }
}
pub fn main() -> i32 { return run make(42) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'slot-nominal-union-cleanup-lanes',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.i8
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.shared { Shared }
import silk.slot { Slot }
struct Counter { value: i32 }
fn increment(counter: &mut Counter) -> i32 {
  counter.value = counter.value + 1
  return counter.value
}
fn read(counter: &Counter) -> i32 { return counter.value }
struct Guard { left: i8 right: i8 counter: Shared<Counter> }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    if i8.toI32(self.left) != 19 || i8.toI32(self.right) != 23 { let boom = 1 / 0 }
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
union Choice { Small { marker: i8, guard: Guard }, Wide { value: i64 } }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 })
    |> Effect.provideMut<Allocator>(&mut allocator)
  let allocation = run Allocator.allocate(Layout.of<[Choice; 1]>())
    |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<Choice>(move allocation, 1)
    let value = Choice.Small {
      marker: i8.toI8(7),
      guard: Guard {
        left: i8.toI8(19), right: i8.toI8(23), counter: Shared.clone<Counter>(&counter),
      },
    }
    let written = Slot.write(RawBuffer.slot(&mut buffer, 0), move value)
    let cleared = Slot.dropValue(RawBuffer.slot(&mut buffer, 0))
    drop buffer
    let count = Shared.with<Counter, i32>(&counter, read)
    drop counter
    if count != 1 { return 2 }
    return 42
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'allocation-metrics-semantics',
    source: `import silk.metrics { Metrics }
pub fn main() -> i32 {
  let mut counts = Metrics.make()
  Metrics.recordAcquire(&mut counts)
  Metrics.recordAcquire(&mut counts)
  Metrics.recordAcquire(&mut counts)
  let peak = Metrics.copy(&counts)
  if peak.acquired != 3 || peak.released != 0 || peak.peakLive != 3 { return 1 }
  if Metrics.live(&peak) != 3 { return 2 }
  Metrics.recordRelease(&mut counts)
  let afterOne = Metrics.copy(&counts)
  if afterOne.acquired != 3 || afterOne.released != 1 || afterOne.peakLive != 3 { return 3 }
  if Metrics.live(&afterOne) != 2 || Metrics.live(&peak) != 3 { return 4 }
  Metrics.recordRelease(&mut counts)
  Metrics.recordRelease(&mut counts)
  if Metrics.live(&counts) != 0 || counts.peakLive != 3 { return 5 }
  Metrics.recordAcquire(&mut counts)
  if Metrics.live(&counts) != 1 || counts.peakLive != 3 { return 6 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'slot-copy-structural-union',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
import silk.u8
struct Left { value: i32 }
impl Copy for Left {}
struct Right { marker: u8 value: i32 }
impl Copy for Right {}
struct EmptyEvent {}
impl Copy for EmptyEvent {}
fn left(value: i32) -> EmptyEvent | Left | Right { return Left { value: value } }
fn right(marker: u8, value: i32) -> EmptyEvent | Left | Right {
  return Right { marker: marker, value: value }
}
fn empty() -> EmptyEvent | Left | Right { return EmptyEvent {} }
fn observed(input: EmptyEvent | Left | Right) -> i32 {
  return match move input {
    EmptyEvent {} => 5
    Left { value } => value
    Right { marker, value } => u8.toI32(marker) + value
  }
}
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let allocation = run Allocator.allocate(Layout.of<[EmptyEvent | Left | Right; 3]>())
    |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<EmptyEvent | Left | Right>(move allocation, 3)
    Slot.write<EmptyEvent | Left | Right>(RawBuffer.slot(&mut buffer, 0), left(7))
    Slot.write<EmptyEvent | Left | Right>(RawBuffer.slot(&mut buffer, 1), right(3, 11))
    Slot.write<EmptyEvent | Left | Right>(RawBuffer.slot(&mut buffer, 2), empty())
    let slotCopy = Slot.copy(RawBuffer.slot(&mut buffer, 0))
    let sharedLeft = RawBuffer.read<EmptyEvent | Left | Right>(&buffer, 0)
    let sharedRight = RawBuffer.read<EmptyEvent | Left | Right>(&buffer, 1)
    let sharedEmpty = RawBuffer.read<EmptyEvent | Left | Right>(&buffer, 2)
    let takenLeft = Slot.take(RawBuffer.slot(&mut buffer, 0))
    let takenRight = Slot.take(RawBuffer.slot(&mut buffer, 1))
    let takenEmpty = Slot.take(RawBuffer.slot(&mut buffer, 2))
    drop buffer
    return observed(move slotCopy) + observed(move sharedLeft) + observed(move sharedRight) +
      observed(move sharedEmpty) + observed(move takenLeft) + observed(move takenRight) +
      observed(move takenEmpty)
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 1 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
    expected: { _tag: 'Completes', result: 59 },
  },
  {
    name: 'packed-subword-reference',
    source: `import silk.i16
import silk.i8
import silk.u16
import silk.u8
struct Packed { first: u8 second: i8 third: u16 fourth: i16 }
fn peek(self: &Packed) -> i32 {
  return u8.toI32(self.first) + i8.toI32(self.second) + u16.toI32(self.third) + i16.toI32(self.fourth)
}
pub fn main() -> i32 {
  let packed = Packed { first: 7, second: -5, third: 200, fourth: -9 }
  if u8.toI32(packed.first) != 7 { return 1 }
  if i8.toI32(packed.second) != -5 { return 2 }
  if u16.toI32(packed.third) != 200 { return 3 }
  if i16.toI32(packed.fourth) != -9 { return 4 }
  if peek(&packed) != 193 { return 5 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'else-if-chain',
    source: `fn classify(value: i32) -> i32 {
  if value < 0 { return 0 }
  else if value < 10 { return 1 }
  else if value < 100 { return 2 }
  else { return 3 }
  return 4
}
pub fn main() -> i32 {
  if classify(0 - 5) != 0 { return 1 }
  if classify(5) != 1 { return 2 }
  if classify(50) != 2 { return 3 }
  if classify(500) != 3 { return 4 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'raw-string-delimiters',
    source: `import silk.usize
import silk.string { String }
pub fn main() -> i32 {
  let single = r"\\n"
  if usize.toI32(String.byteLength(single)) != 2 { return 1 }
  let helpText = r"""
Usage: silk build
  --target \\path\\to\\dir
"""
  let bytes = String.utf8Bytes(helpText)
  if bytes[usize.ZERO] != 10 { return 2 }
  if bytes[usize.add(30, 0)] != 92 { return 3 }
  if usize.toI32(String.byteLength(helpText)) != 43 { return 4 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'effect-entry-evaluate-ordering',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
struct Stop {}
struct Audit { trace: i32 }
fn record(audit: &mut Audit, value: i32) -> i32 {
  audit.trace = audit.trace * 10 + value
  return audit.trace
}
fn read(audit: &Audit) -> i32 { return audit.trace }
effect fn ordered(audit: Shared<Audit>) -> () ! Stop {
  let first = Shared.withMut<Audit, i32>(&audit, record(1))
  run effect { let second = Shared.withMut<Audit, i32>(&audit, record(2)) return () }
  fail Stop {}
  let forbidden = Shared.withMut<Audit, i32>(&audit, record(9))
  return ()
}
effect fn recover(error: Stop) -> () { return () }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let audit = run Shared.make<Audit>(Audit { trace: 0 }) |> Effect.provideMut(&mut allocator)
  run Effect.catchAll(ordered(Shared.clone<Audit>(&audit)), recover)
  let trace = Shared.with<Audit, i32>(&audit, read)
  drop audit
  if trace != 12 { return trace }
  return 42
}
effect fn recoverAllocation(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recoverAllocation) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'box-tree-recursive-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.box { Box }
import silk.effect { Effect }
import silk.shared { Shared }
import silk.usize
struct Counter { value: i32 }
fn increment(counter: &mut Counter) -> i32 { counter.value = counter.value + 1 return counter.value }
fn read(counter: &Counter) -> i32 { return counter.value }
struct Leaf {}
struct Branch { left: Box<Tree> right: Box<Tree> }
struct Shape { kind: Leaf | Branch }
struct Tree { shape: Shape value: i32 counter: Shared<Counter> }
impl Drop for Tree {
  fn drop(self: &mut Tree) -> () {
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
fn leaf(value: i32, counter: &Shared<Counter>) -> Tree {
  return Tree { shape: Shape { kind: Leaf {} }, value: value, counter: Shared.clone(counter) }
}
effect fn branch(left: Tree, right: Tree, value: i32, counter: &Shared<Counter>)
  -> Tree ! OutOfMemoryError ? &mut Allocator {
  let boxedLeft = run Box.make<Tree>(move left)
  let boxedRight = run Box.make<Tree>(move right)
  return Tree {
    shape: Shape { kind: Branch { left: move boxedLeft, right: move boxedRight } },
    value: value,
    counter: Shared.clone(counter)
  }
}
fn total(tree: &Tree) -> i32 { return tree.value + shapeTotal(&tree.shape) }
fn shapeTotal(shape: &Shape) -> i32 {
  return match &shape.kind {
    Leaf nothing => 0
    Branch { left, right } => boxTotal(Box.get<Tree>(&left)) + boxTotal(Box.get<Tree>(&right))
  }
}
fn boxTotal(view: &[Tree]) -> i32 {
  return match &view[usize.ZERO] { Tree { shape, value, counter } => value + shapeTotal(&shape) }
}
effect fn build(counter: &Shared<Counter>) -> Tree ! OutOfMemoryError ? &mut Allocator {
  let left = run branch(leaf(1, counter), leaf(2, counter), 4, counter)
  let right = run branch(leaf(8, counter), leaf(16, counter), 32, counter)
  return run branch(move left, move right, 64, counter)
}
effect fn measure() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 }) |> Effect.provideMut(&mut allocator)
  let built = run build(&counter) |> Effect.provideMut(&mut allocator)
  if total(&built) != 127 { return 1 }
  drop built
  let released = Shared.with<Counter, i32>(&counter, read)
  drop counter
  if released != 7 { return 2 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(measure(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'vector-move-only-cleanup-order',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
import silk.vector { Vector }
struct Audit { count: i32 trace: i32 }
fn record(audit: &mut Audit, value: i32) -> i32 {
  audit.count = audit.count + 1
  audit.trace = audit.trace * 10 + value
  return audit.trace
}
fn count(audit: &Audit) -> i32 { return audit.count }
fn trace(audit: &Audit) -> i32 { return audit.trace }
struct Entry { value: i32 audit: Shared<Audit> }
impl Drop for Entry {
  fn drop(self: &mut Entry) -> () {
    let value = self.value
    let changed = Shared.withMut<Audit, i32>(&self.audit, record(value))
    return ()
  }
}
fn entry(value: i32, audit: &Shared<Audit>) -> Entry {
  return Entry { value: value, audit: Shared.clone(audit) }
}
effect fn append(values: &mut Vector<Entry>, value: i32, audit: &Shared<Audit>)
  -> () ! OutOfMemoryError ? &mut Allocator {
  let appended = run Vector.append<Entry>(move values, entry(value, audit))
  return ()
}
effect fn measure() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let audit = run Shared.make<Audit>(Audit { count: 0, trace: 0 }) |> Effect.provideMut(&mut allocator)
  let mut dropped = Vector.make<Entry>()
  run append(&mut dropped, 3, &audit) |> Effect.provideMut(&mut allocator)
  run append(&mut dropped, 5, &audit) |> Effect.provideMut(&mut allocator)
  run append(&mut dropped, 7, &audit) |> Effect.provideMut(&mut allocator)
  drop dropped
  if Shared.with<Audit, i32>(&audit, trace) != 357 { return 1 }
  let mut replaced = Vector.make<Entry>()
  run append(&mut replaced, 3, &audit) |> Effect.provideMut(&mut allocator)
  run append(&mut replaced, 5, &audit) |> Effect.provideMut(&mut allocator)
  Vector.set<Entry>(&mut replaced, 0, entry(9, &audit))
  if Shared.with<Audit, i32>(&audit, trace) != 3573 { return 2 }
  drop replaced
  if Shared.with<Audit, i32>(&audit, trace) != 357395 { return 3 }
  let mut truncated = Vector.make<Entry>()
  run append(&mut truncated, 3, &audit) |> Effect.provideMut(&mut allocator)
  run append(&mut truncated, 5, &audit) |> Effect.provideMut(&mut allocator)
  run append(&mut truncated, 7, &audit) |> Effect.provideMut(&mut allocator)
  Vector.truncate<Entry>(&mut truncated, 1)
  if Shared.with<Audit, i32>(&audit, trace) != 35739557 { return 4 }
  drop truncated
  let finalTrace = Shared.with<Audit, i32>(&audit, trace)
  let finalCount = Shared.with<Audit, i32>(&audit, count)
  drop audit
  if finalTrace != 357395573 || finalCount != 9 { return 5 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(measure(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'recursive-box-chain-shallow-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.box { Box }
import silk.effect { Effect }
import silk.shared { Shared }
import silk.usize
struct Counter { value: i32 }
fn increment(counter: &mut Counter) -> i32 { counter.value = counter.value + 1 return counter.value }
fn read(counter: &Counter) -> i32 { return counter.value }
struct End {}
struct Link { next: Box<Chain> counter: Shared<Counter> }
impl Drop for Link {
  fn drop(self: &mut Link) -> () {
    let changed = Shared.withMut<Counter, i32>(&self.counter, increment)
    return ()
  }
}
struct Step { kind: End | Link }
struct Chain { step: Step }
fn stepDepth(step: &Step) -> i32 {
  return match &step.kind {
    End nothing => 0
    Link { next, counter } => viewDepth(Box.get<Chain>(&next))
  }
}
fn viewDepth(view: &[Chain]) -> i32 {
  return match &view[usize.ZERO] { Chain { step } => 1 + stepDepth(&step) }
}
effect fn build(depth: i32, counter: &Shared<Counter>)
  -> Chain ! OutOfMemoryError ? &mut Allocator {
  let mut current = Chain { step: Step { kind: End {} } }
  let mut remaining = depth
  while remaining > 0 {
    let taken = Intrinsic.replace(current, Chain { step: Step { kind: End {} } })
    let boxed = run Box.make<Chain>(move taken)
    current = Chain { step: Step { kind: Link {
      next: move boxed,
      counter: Shared.clone(counter)
    } } }
    remaining = remaining - 1
  }
  return move current
}
effect fn measure() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let counter = run Shared.make<Counter>(Counter { value: 0 }) |> Effect.provideMut(&mut allocator)
  let built = run build(64, &counter) |> Effect.provideMut(&mut allocator)
  if stepDepth(&built.step) != 64 { return 1 }
  drop built
  let released = Shared.with<Counter, i32>(&counter, read)
  drop counter
  if released != 64 { return 2 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(measure(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'captured-exclusive-reference-parameters',
    source: `struct Counter { value: i32 }
fn structWork(counter: &mut Counter) -> i32 {
  let mut step = fn() -> i32 {
    counter.value = counter.value + 1
    return counter.value
  }
  let first = step()
  let second = step()
  return first * 10 + second
}
fn scalarWork(counter: &mut i32) -> i32 {
  let mut step = fn() -> i32 { counter.* = counter.* + 1 return counter.* }
  let first = step()
  let second = step()
  return first * 10 + second
}
pub fn main() -> i32 {
  let mut record = Counter { value: 0 }
  if structWork(&mut record) != 12 || record.value != 2 { return 1 }
  let mut scalar = 0
  if scalarWork(&mut scalar) != 12 || scalar != 2 { return 2 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'fallible-weaker-witness-reborrow',
    source: `import silk.effect { Effect }
import silk.result { Result }
struct Problem { code: i32 }
interface Decoder { effect fn decode(value: &mut Self) -> i32 ! Problem }
struct Cell { code: i32 }
effect fn decodeCell(value: &Cell) -> i32 ! Problem { fail Problem { code: 1 } }
impl Decoder for Cell { decode: Cell.decodeCell }
fn pending<T: Decoder>(value: &mut T) -> Effect<i32 ! Problem> { return Decoder.decode(value) }
fn observe(result: Result<i32, Problem>) -> i32 {
  return match move result {
    Result<i32, Problem>.Success { value } => value
    Result<i32, Problem>.Failure { error } => error.code
  }
}
pub fn main() -> i32 {
  let mut cell = Cell { code: 40 }
  let failure = observe(run Effect.result(pending<Cell>(&mut cell)))
  cell.code = cell.code + 1
  if failure != 1 || cell.code != 41 { return 1 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'runtime-slice-shared-subranges',
    source: `import silk.slice { Slice }
fn rebind<'a>(flag: bool, original: &'a [i32], replacement: &'a [i32]) -> bool {
  let mut view = original
  if flag { view = replacement }
  if !flag { view = original }
  if flag { return view.length == 1 && view[0] == 30 }
  return view.length == 3 && view[0] == 10
}
pub fn main() -> i32 {
  let values: [i32; 3] = [10, 20, 30]
  let selected = Slice.view(Slice.view(&values, 1, 2), 1, 1)
  if selected.length != 1 || selected[0] != 30 { return 1 }
  let empty = Slice.view(&values, 3, 0)
  let nestedEmpty = Slice.view(empty, 0, 0)
  if nestedEmpty.length != 0 { return 2 }
  if !rebind(true, &values, selected) { return 3 }
  if !rebind(false, &values, selected) { return 4 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'runtime-slice-offset-bounds-trap',
    source: `import silk.slice { Slice }
fn choose(values: &[i32], offset: usize) -> usize {
  return Slice.view(values, offset, 0).length
}
pub fn main() -> i32 {
  let values = [10, 20]
  let length = choose(&values, 3)
  return 0
}`,
    expected: { _tag: 'Trap' },
  },
  {
    name: 'runtime-slice-length-overflow-trap',
    source: `import silk.slice { Slice }
import silk.usize
fn choose(values: &[i32], length: usize) -> usize {
  return Slice.view(values, 1, length).length
}
pub fn main() -> i32 {
  let values = [10, 20]
  let length = choose(&values, usize.MAX)
  return 0
}`,
    expected: { _tag: 'Trap' },
  },
  {
    name: 'runtime-slice-temporary-and-lexical-borrows',
    source: `fn sum(values: &[i32]) -> i32 { return values[0] + values[1] }
pub fn main() -> i32 {
  if sum(&[40, 2]) != 42 { return 1 }
  let values = [40, 2]
  let view = &values
  if view[0] != 40 || view[1] != 2 { return 2 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'place-replace-scalar-and-affine-union',
    source: `struct Counter { value: i32 }
fn bump(counter: &mut Counter) -> i32 { return Intrinsic.replace(counter.value, 42) }
struct Empty {}
struct Full { value: i32 }
struct Cell { state: Empty | Full }
fn take(cell: &mut Cell) -> i32 {
  let old = Intrinsic.replace(cell.state, Empty {})
  return match move old { Empty {} => 0 Full { value } => value }
}
pub fn main() -> i32 {
  let mut counter = Counter { value: 41 }
  if bump(&mut counter) != 41 || counter.value != 42 { return 1 }
  let mut cell = Cell { state: Full { value: 42 } }
  if take(&mut cell) != 42 { return 2 }
  if take(&mut cell) != 0 { return 3 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'box-accessors-and-consuming-release',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.box { Box }
import silk.effect { Effect }
import silk.usize
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut boxed = run Box.make<i32>(20) |> Effect.provideMut(&mut allocator)
  let borrowed = Box.get<i32>(&boxed)
  if borrowed[usize.ZERO] != 20 { return 1 }
  let mut exclusive = Box.getMut<i32>(&mut boxed)
  exclusive[usize.ZERO] = 22
  if Box.get<i32>(&boxed)[usize.ZERO] != 22 { return 2 }
  let taken = Box.into<i32>(move boxed)
  if taken != 22 { return 3 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'affine-checked-callback-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.shared { Shared }
import silk.u8
union Checked<T> { Present { value: T }, Absent }
struct Audit { selected: i32 dropped: i32 sum: i32 }
fn selected(audit: &mut Audit, marker: i32) -> i32 {
  audit.selected = audit.selected + 1
  return marker
}
fn dropped(audit: &mut Audit, marker: i32) -> i32 {
  audit.dropped = audit.dropped + 1
  audit.sum = audit.sum + marker
  return audit.dropped
}
fn readSelected(audit: &Audit) -> i32 { return audit.selected }
fn readDropped(audit: &Audit) -> i32 { return audit.dropped }
fn readSum(audit: &Audit) -> i32 { return audit.sum }
struct Token { marker: i32 audit: Shared<Audit> }
impl Drop for Token {
  fn drop(self: &mut Token) -> () {
    let marker = self.marker
    let count = Shared.withMut<Audit, i32>(&self.audit, dropped(marker))
    return ()
  }
}
fn present(value: u8, token: Token) -> Checked<u8> {
  let marker = token.marker
  let observed = Shared.withMut<Audit, i32>(&token.audit, selected(marker))
  return Checked<u8>.Present { value: value }
}
fn absent() -> Checked<u8> { return Checked<u8>.Absent }
fn presentWith(token: Token) -> some<F: once fn(u8) -> Checked<u8>> F {
  return present(move token)
}
fn value(checked: Checked<u8>) -> i32 {
  return match move checked {
    Checked<u8>.Present { value } => u8.toI32(value)
    Checked<u8>.Absent => 0
  }
}
effect fn measure() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let audit = run Shared.make<Audit>(Audit { selected: 0, dropped: 0, sum: 0 })
    |> Effect.provideMut(&mut allocator)
  let succeeded = Intrinsic.u8CheckedAdd<Checked<u8>>(
    40, 2, presentWith(Token { marker: 1, audit: Shared.clone(&audit) }), absent,
  )
  let failed = Intrinsic.u8CheckedAdd<Checked<u8>>(
    255, 1, presentWith(Token { marker: 2, audit: Shared.clone(&audit) }), absent,
  )
  if value(move succeeded) != 42 || value(move failed) != 0 { return 1 }
  let selectedCount = Shared.with<Audit, i32>(&audit, readSelected)
  let dropCount = Shared.with<Audit, i32>(&audit, readDropped)
  let dropSum = Shared.with<Audit, i32>(&audit, readSum)
  drop audit
  if selectedCount != 1 || dropCount != 2 || dropSum != 3 { return 2 }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(measure(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'stored-callable-terminal-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.shared { Shared }
struct Problem {}
struct Audit { count: i32 trace: i32 }
fn record(audit: &mut Audit, marker: i32) -> i32 {
  audit.count = audit.count + 1
  audit.trace = audit.trace * 10 + marker
  return audit.trace
}
fn count(audit: &Audit) -> i32 { return audit.count }
fn trace(audit: &Audit) -> i32 { return audit.trace }
struct Token { marker: i32 audit: Shared<Audit> }
impl Drop for Token {
  fn drop(self: &mut Token) -> () {
    let marker = self.marker
    let changed = Shared.withMut<Audit, i32>(&self.audit, record(marker))
    return ()
  }
}
fn consume(value: i32, token: Token) -> i32 { return value + token.marker }
struct Holder<F: once fn<'static>(i32) -> i32> { step: F }
effect fn failWith(audit: &Shared<Audit>) -> () ! Problem {
  let callback = consume(Token { marker: 4, audit: Shared.clone(audit) })
  fail Problem {}
}
effect fn measure() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let audit = run Shared.make<Audit>(Audit { count: 0, trace: 0 })
    |> Effect.provideMut(&mut allocator)
  let uncalled = consume(Token { marker: 1, audit: Shared.clone(&audit) })
  drop uncalled
  if Shared.with<Audit, i32>(&audit, trace) != 1 { return 1 }
  let called = consume(Token { marker: 2, audit: Shared.clone(&audit) })
  if called(40) != 42 { return 2 }
  if Shared.with<Audit, i32>(&audit, trace) != 12 { return 3 }
  let moved = consume(Token { marker: 3, audit: Shared.clone(&audit) })
  let holder = Holder { step: move moved }
  drop holder
  if Shared.with<Audit, i32>(&audit, trace) != 123 { return 4 }
  let failure = run Effect.result(failWith(&audit))
  drop failure
  let finalTrace = Shared.with<Audit, i32>(&audit, trace)
  let finalCount = Shared.with<Audit, i32>(&audit, count)
  drop audit
  if finalTrace != 1234 || finalCount != 4 { return 5 }
  return 42
}
effect fn recoverAllocation(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(measure(), recoverAllocation) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'replace-cleanup',
    source: 'pub fn main() -> i32 { return 0 }',
    nativeSource: replaceCleanupProgram,
    nativeStdout: '123546789',
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'replace-drop',
    source: 'pub fn main() -> i32 { return 0 }',
    nativeSource: replaceDropProgram,
    nativeStdout: '1243',
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'chacha20-poly1305',
    source: chacha20Poly1305WasmSource,
    nativeSource: chacha20Poly1305NativeSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'aes-gcm',
    source: aesGcmAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'x25519',
    source: x25519AcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'rsa-verification',
    source: rsaWasmSource,
    nativeSource: rsaNativeSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'tls-hkdf',
    source: tlsHkdfAcceptanceSource,
    nativeSource: tlsHkdfNativeSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'tls-record',
    source: tlsRecordAcceptanceSource,
    nativeSource: tlsRecordNativeSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'authenticated-tls-client-core',
    source: tlsClientWasmSource,
    nativeSource: tlsClientCoreNativeSource,
    nativeCSources: { tls_client_fixtures: tlsClientNativeFixtureSource },
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'authenticated-tls-client-demand-request',
    source: tlsClientNativeOnlySource,
    nativeSource: tlsClientDemandRequestNativeSource,
    nativeCSources: { tls_client_fixtures: tlsClientNativeFixtureSource },
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'authenticated-tls-client-key-update',
    source: tlsClientNativeOnlySource,
    nativeSource: tlsClientKeyUpdateNativeSource,
    nativeCSources: { tls_client_fixtures: tlsClientNativeFixtureSource },
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'authenticated-tls-client-closure-control',
    source: tlsClientNativeOnlySource,
    nativeSource: tlsClientClosureControlNativeSource,
    nativeCSources: { tls_client_fixtures: tlsClientNativeFixtureSource },
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'authenticated-tls-client-handshake-policy',
    source: tlsClientNativeOnlySource,
    nativeSource: tlsClientHandshakePolicyNativeSource,
    nativeCSources: { tls_client_fixtures: tlsClientNativeFixtureSource },
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'authenticated-tls-client-resource-policy',
    source: tlsClientNativeOnlySource,
    nativeSource: tlsClientResourcePolicyNativeSource,
    nativeCSources: { tls_client_fixtures: tlsClientNativeFixtureSource },
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'bounded-byte-duplex',
    source: byteDuplexAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'authenticated-tls-connection',
    source: tlsConnectionAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'hmac-hkdf',
    source: hmacHkdfAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'bounded-zstd',
    source: zstdAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'fixed-output-sha',
    source: shaAcceptanceSource,
    nativeSource: shaAcceptanceNativeSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'streaming-inflate',
    source: inflateAcceptanceSource,
    expected: { _tag: 'Completes', result: 42 },
  },
  ...corpus,
  ...algorithmExamples,
  algorithmicCompilerFold,
  ...pressurePrograms,
  {
    name: 'foreign-export-roundtrip',
    source: foreignExportRoundtripReference,
    nativeSource: foreignExportRoundtripNative,
    nativeCSources: { silk_test_foreign_export_roundtrip: foreignExportRoundtripFixture },
    expected: { _tag: 'Completes', result: 41 },
  },
  {
    name: 'foreign-export-scalars',
    source: foreignScalarReference,
    nativeSource: foreignExportScalarNative,
    nativeCSources: { silk_test_foreign_export_scalars: foreignExportScalarFixture },
    expected: { _tag: 'Completes', result: 139 },
  },
  {
    name: 'foreign-scalar-fixture',
    source: foreignScalarReference,
    nativeSource: foreignScalarNative,
    nativeCSources: { silk_test_foreign_scalars: foreignScalarFixture },
    expected: { _tag: 'Completes', result: 139 },
  },
  {
    name: 'foreign-libc-abs',
    source: `fn magnitude(value: i32) -> i32 { if value < 0 { return 0 - value } return value }
pub fn main() -> i32 { return magnitude(-42) }`,
    nativeSource: `unsafe extern "C" fn abs(value: i32) -> i32
pub fn main() -> i32 { return unsafe abs(-42) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'foreign-libc-qsort-callback',
    source: 'pub fn main() -> i32 { return 42 }',
    nativeSource: `import silk.pointer { Pointer }
import silk.effect { Effect }
struct Failed {}
struct Guard { counter: *mut i32 }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () { unsafe { Pointer.write(self.counter, Pointer.read(self.counter) + 1) } }
}
unsafe extern "C" fn qsort(base: ?[*]mut i32, count: usize, size: usize, compare: extern "C" fn(*const i32, *const i32) -> i32 with Intrinsic.foreign(memory: "read", locality: "arguments")) -> () with Intrinsic.foreign(callbacks: ("compare",))
unsafe export "C" fn compare(left: *const i32, right: *const i32) -> i32 with Intrinsic.foreign(memory: "read", locality: "arguments") {
  let leftValue = unsafe Pointer.read(left)
  let rightValue = unsafe Pointer.read(right)
  if leftValue < rightValue { return -1 }
  if leftValue > rightValue { return 1 }
  return 0
}
effect fn sorted(failNow: bool, counter: *mut i32) -> i32 ! Failed {
  let guard = Guard { counter: counter }
  let mut values = [4, 2]
  unsafe qsort(Pointer.fromMutSlice(&mut values), 2, 4, compare)
  if failNow { fail Failed {} }
  return values[1] * 10 + values[0]
}
effect fn recover(error: Failed) -> i32 { return 42 }
pub fn main() -> i32 {
  let mut drops = 0
  let counter = Pointer.fromMutRef(&mut drops)
  let normal = run Effect.catchAll(sorted(false, counter), recover)
  let failed = run Effect.catchAll(sorted(true, counter), recover)
  if normal != 42 || failed != 42 || drops != 2 { return 1 }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'foreign-libc-environ-static',
    source: 'pub fn main() -> i32 { return 42 }',
    nativeSource: `import silk.pointer { Pointer }
unsafe extern "C" static environment: ?[*]const ?[*]const u8 as "environ"
pub fn main() -> i32 {
  unsafe { if Pointer.isNullMany(environment) { return 1 } }
  return 42
}`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'foreign-object-libm-order',
    source: 'pub fn main() -> i32 { return 42 }',
    nativeSource: `import silk.i32
unsafe extern "C" fn silk_test_libm_order(value: f64) -> i32
pub fn main() -> i32 { return unsafe silk_test_libm_order(i32.toF64(85)) }`,
    nativeCSources: {
      silk_test_libm_order: `#include <stdint.h>
#include <math.h>
int32_t silk_test_libm_order(double value) { return (int32_t)fmod(value, 43.0); }
`,
    },
    nativeDynamicLibraries: ['m'],
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'pointer-foreign-store',
    source: pointerParameterWrite,
    nativeSource: foreignPointerStoreNative,
    nativeCSources: { silk_test_foreign_pointers: foreignPointerFixture },
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'pointer-foreign-fill',
    source: foreignPointerFillReference,
    nativeSource: foreignPointerFillNative,
    nativeCSources: { silk_test_foreign_pointers: foreignPointerFixture },
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'foreign-c-layout-clock',
    source: 'pub fn main() -> i32 { return 0 }',
    nativeSource: foreignClockRecordNative,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'pointer-libc-roundtrip',
    source: foreignLibcRoundtripReference,
    nativeSource: foreignLibcRoundtripNative,
    nativeStdout: 'hello\n',
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'recovered-provided-write',
    source: 'pub fn main() -> i32 { return 0 }',
    nativeSource: recoveredProvidedWrite,
    nativeImports: { recovered_writer: recoveredWriterModule },
    nativeStdout: 'Hello',
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'native-termination-active-union-member',
    source: `pub struct NotFoundError {}
pub struct OfflineError { code: i32 }

pub effect fn main() ! NotFoundError | OfflineError {
  fail OfflineError { code: 42 }
}`,
    nativeStderr:
      'unhandled error: memory/driver.OfflineError\n  at memory/driver.main (memory/driver:4:54)\n  at silk/effect.Effect.flatMap (silk/effect:294:18)\n',
    // A failed Effect entry must exit with status 1 even when reporting cannot write to fd 2.
    // Unused process arguments must not change either its status or its diagnostic trace.
    nativeRuns: [
      {},
      { closeStderr: true },
      { arguments: ['one', 'two', 'three'] },
      { arguments: ['one', 'two'], closeStderr: true },
    ],
    expected: { _tag: 'Completes', result: 1 },
  },
  {
    name: 'native-effect-entry-success',
    source: `pub struct SomeError { code: i32 }
pub effect fn main() -> () ! SomeError { return () }`,
    nativeStderr: '',
    nativeRuns: [{}, { arguments: ['one', 'two'] }],
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'native-termination-logical-path',
    source: `pub struct NotFoundError {}

effect fn load() -> i32 ! NotFoundError {
  fail NotFoundError {}
}

effect fn middle() -> i32 ! NotFoundError {
  let v = run load()
  return v + 1
}

pub effect fn main() ! NotFoundError {
  let v = run middle()
  return ()
}`,
    nativeStderr:
      'unhandled error: memory/driver.NotFoundError\n  at memory/driver.load (memory/driver:3:42)\n  at memory/driver.middle (memory/driver:8:10)\n  at memory/driver.main (memory/driver:13:10)\n  at silk/effect.Effect.flatMap (silk/effect:294:18)\n',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'native-termination-cleanup-preserves-primary',
    source: `import silk.effect { Effect }
pub struct Primary {}
struct Noise {}
struct Guard {}
effect fn primary() -> () ! Primary {
  fail Primary {}
}
effect fn noise() -> () ! Noise {
  fail Noise {}
}
effect fn recovered(error: Noise) -> () { return () }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    run Effect.catchAll(noise(), recovered)
  }
}
impl Drop for Primary {
  fn drop(self: &mut Primary) -> () {
    run Effect.catchAll(noise(), recovered)
  }
}
pub effect fn main() ! Primary {
  let guard = Guard {}
  run primary()
}`,
    nativeStderr:
      'unhandled error: memory/driver.Primary\n  at memory/driver.primary (memory/driver:5:38)\n  at memory/driver.main (memory/driver:23:23)\n  at silk/effect.Effect.flatMap (silk/effect:294:18)\n',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'native-termination-while-handling',
    source: `import silk.effect { Effect }

pub struct NotFoundError {}
pub struct OfflineError {}

effect fn load() -> i32 ! NotFoundError {
  fail NotFoundError {}
}

effect fn recover(error: NotFoundError) -> i32 ! OfflineError {
  fail OfflineError {}
}

pub effect fn main() ! OfflineError {
  let v = run Effect.catch<NotFoundError>(load(), recover)
  return ()
}`,
    nativeStderr:
      'unhandled error: memory/driver.OfflineError\n  at memory/driver.recover (memory/driver:10:64)\n  at silk/effect.Effect.catch (silk/effect:398:11)\n  at memory/driver.main (memory/driver:15:10)\n  at silk/effect.Effect.flatMap (silk/effect:294:18)\nwhile handling: memory/driver.NotFoundError\n  at memory/driver.load (memory/driver:6:42)\n',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'native-termination-fatal-trap',
    source: `fn calculate(a: i32, b: i32) -> i32 {
  return a / b
}

pub effect fn main() {
  let z = calculate(1, 0)
  return ()
}`,
    nativeStderr:
      'fatal trap: division by zero\n  at memory/driver.calculate (memory/driver:2:9)\n',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'native-termination-cross-module-frame',
    source: 'pub fn main() -> i32 { return 42 }',
    nativeSource: `import errors.kinds { NotFoundError, load }
pub effect fn main() ! NotFoundError {
  let v = run load()
  return ()
}`,
    nativeImports: {
      'errors/kinds': `pub struct NotFoundError { id: i32 }
pub effect fn load() -> i32 ! NotFoundError {
  fail NotFoundError { id: 1 }
}`,
    },
    nativeStderr:
      'unhandled error: errors/kinds.NotFoundError\n  at errors/kinds.load (errors/kinds:2:46)\n  at memory/driver.main (memory/driver:3:10)\n  at silk/effect.Effect.flatMap (silk/effect:294:18)\n',
    expected: { _tag: 'Trap' },
  },
  {
    name: 'standard-stream-ordering',
    source: 'pub fn main() -> i32 { return 0 }',
    nativeSource: `import silk.os_writer { StderrWriter }
import silk.os_writer { StdoutWriter }
import silk.effect { Effect }
import silk.writer { Writer, WriterError }
pub effect fn main() -> () ! WriterError {
  let mut stdout = StdoutWriter.make()
  let mut stderr = StderrWriter.make()
  run Effect.provideMut(Writer.writeAll(Intrinsic.stringUtf8Bytes("heading\\n")), &mut stdout)
  run Effect.provideMut(Writer.writeAll(b"warning\\n"), &mut stderr)
  run Effect.provideMut(Writer.writeAll(Intrinsic.stringUtf8Bytes("row\\n")), &mut stdout)
  return ()
}`,
    nativeStdout: 'heading\nrow\n',
    nativeStderr: 'warning\n',
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'secure-random-provider',
    source: deterministicSecureRandom,
    nativeSource: nativeSecureRandom,
    expected: { _tag: 'Completes', result: 42 },
  },
  // These canonical programs cover the public single-threaded Fiber story through the shared
  // native corpus: root/fork/join, FIFO siblings, repeated yield, nested forks,
  // completion-before-join, typed child failure, structured cancellation, and reuse of one
  // LocalScheduler value.
  {
    name: 'scheduler-fiber-semantics',
    source: schedulerFiber('local-scheduler-semantics'),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'scheduler-fiber-shutdown',
    source: schedulerFiber('local-scheduler-shutdown'),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'scheduler-fiber-nested-cancellation',
    source: schedulerFiber('local-scheduler-nested-cancellation'),
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'scheduler-fiber-timers',
    source: schedulerFiber('local-scheduler-timer-basic'),
    nativeSource: schedulerFiber('local-scheduler-timers-native'),
    expected: { _tag: 'Completes', result: 42 },
  },
  ...[
    { name: 'first-activation', result: 21 },
    { name: 'coroutine', result: 123 },
    { name: 'dormant-cancel', result: 1111 },
    { name: 'selective-ready', result: 22 },
    { name: 'timer', result: 42 },
  ].map((program): CorpusProgram => ({
    name: `independent-execution-separation-${program.name}`,
    source: independentExecutionPressure(program.name),
    expected: { _tag: 'Completes', result: program.result },
  })),
  ...[
    { name: 'timer', source: 'timer', result: 42 },
    { name: 'coroutine', source: 'coroutine', result: 123 },
    { name: 'selective-ready', source: 'selective-ready', result: 22 },
  ].map((program): CorpusProgram => ({
    name: `independent-execution-separation-renamed-${program.name}`,
    source: renameIndependentPolicy(independentExecutionPressure(program.source)),
    expected: { _tag: 'Completes', result: program.result },
  })),
  {
    name: 'independent-execution-non-lifo',
    source: independentExecutionNonLifo,
    expected: { _tag: 'Completes', result: 240 },
  },
  {
    name: 'independent-execution-latched-resume',
    source: independentExecutionLatchedResume,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-latched-destroy',
    source: independentExecutionLatchedDestroy,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-finalized-destroy',
    source: independentExecutionFinalizedDestroy,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-illegal-dormant-drive',
    source: independentExecutionIllegalDormantDrive,
    expected: { _tag: 'Trap' },
  },
  {
    name: 'independent-execution-illegal-notifying-drive',
    source: independentExecutionIllegalNotifyingDrive,
    expected: { _tag: 'Trap' },
  },
  {
    name: 'independent-execution-stack-exhaustion',
    source: independentExecutionStackExhaustion,
    nativeImports: {
      'test/refusing_storage':
        'export "C" fn refuse(state: ?*mut u8, size: usize, alignment: usize) -> ?*mut u8 { return Intrinsic.pointerNull<u8>() }',
    },
    nativeComponents: [
      {
        capability: 'execution-storage',
        bindings: [
          {
            operation: 'create',
            module: 'silk/execution_storage',
            declaration: 'silk_execution_storage_create',
          },
          { operation: 'acquire', module: 'test/refusing_storage', declaration: 'refuse' },
          {
            operation: 'release',
            module: 'silk/execution_storage',
            declaration: 'silk_execution_storage_release',
          },
          {
            operation: 'destroy',
            module: 'silk/execution_storage',
            declaration: 'silk_execution_storage_destroy',
          },
        ],
      },
    ],
    expected: { _tag: 'Trap' },
  },
  {
    name: 'independent-execution-multiple-packages',
    source: independentExecutionMultiplePackages,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-late-cancelled-wake',
    source: independentExecutionLateCancelledWake,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-reentrant-destroy',
    source: independentExecutionReentrantDestroy,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-local-reactor',
    source: independentExecutionLocalReactor,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-repeated-generations',
    source: independentExecutionRepeatedGenerations,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-eligible-drop',
    source: independentExecutionEligibleDrop,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'independent-execution-parked-typed-failure',
    source: independentExecutionParkedTypedFailure,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'frame-retained-execution-completion',
    source: frameRetainedExecutionCompletion,
    expected: { _tag: 'Completes', result: 0 },
  },
  {
    name: 'frame-retained-execution-abandoned-frame',
    source: frameRetainedExecutionAbandonedFrame,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-pressure-success',
    source: localSharedPressure,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-pressure-renamed',
    source: renamedLocalSharedPressure,
    expected: { _tag: 'Completes', result: 42 },
  },
  ...([0, 1] as const).map((ordinal): CorpusProgram => ({
    name: `local-shared-pressure-quota-${ordinal}`,
    source: localSharedPressureFailure(ordinal),
    expected: { _tag: 'Completes', result: 142 },
  })),
  ...(['with', 'withMut'] as const).flatMap((outer): ReadonlyArray<CorpusProgram> =>
    (['with', 'withMut'] as const).map((inner): CorpusProgram => {
      const outerReference = outer === 'with' ? '&Counter' : '&mut Counter'
      const innerCallback = inner === 'with' ? 'read' : 'increment'
      return {
        name: `local-shared-conflict-${outer}-${inner}`,
        source: `import silk.allocator { Allocator }
import silk.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.effect { Effect }
import silk.shared { Shared }
struct Counter { value: i32 }
fn read(value: &Counter) -> i32 { return value.value }
fn increment(value: &mut Counter) -> i32 {
  value.value = value.value + 1
  return value.value
}
fn nested(value: ${outerReference}, alias: Shared<Counter>) -> i32 {
  return Shared.${inner}<Counter, i32>(&alias, ${innerCallback})
}
effect fn conflictCase() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let first = run (Shared.make<Counter>(Counter { value: 41 })
    |> Effect.provideMut<Allocator>(&mut allocator))
  let alias = Shared.clone<Counter>(&first)
  return Shared.${outer}<Counter, i32>(&first, nested(move alias))
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(conflictCase(), recover) }`,
        expected: { _tag: 'Trap' },
      }
    }),
  ),
  {
    name: 'local-shared-nested-owned-result-cleanup',
    source: `import silk.allocator { Allocator, OutOfMemoryError }
import silk.bytes { Bytes }
import silk.effect { Effect }
import silk.result { Result }
import silk.shared { Shared }

struct Rejection { code: i32 }
struct Answer { marker: Bytes retained: Shared<Bytes> }

fn apply<T, F: once fn(&mut T) -> () + Intrinsic.NonParking>(value: &mut T, use: F) -> () {
  return use(move value)
}

effect fn exercise() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let retained = run Shared.make<Bytes>(run Bytes.copy(b"retained"))
  let mut first = run Shared.make<Result<Answer, Rejection>>(
    Result.succeed<Answer, Rejection>(Answer {
      marker: run Bytes.copy(b"marker"),
      retained: move retained,
    }),
  )
  let mut completed = Shared.clone<Result<Answer, Rejection>>(&first)
  apply(&mut first, fn(entry: &mut Shared<Result<Answer, Rejection>>) -> () {
      completed = Shared.clone<Result<Answer, Rejection>>(&entry.*)
      return ()
    })
  drop completed
  drop first
  return 42
}

effect fn withAllocator() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run exercise() |> Effect.provideMut<Allocator>(&mut allocator)
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(withAllocator(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-affine-movement',
    source: `import silk.allocator { Allocator }
import silk.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.shared { Shared }
struct Empty {}
struct Token { storage: Allocation }
struct Mailbox { state: Empty | Token }
fn take(self: &mut Mailbox) -> Empty | Token {
  return Intrinsic.replace(self.state, Empty {})
}
fn consume(value: Empty | Token) -> i32 {
  return match move value {
    Empty {} => 0
    Token { storage } => release(move storage)
  }
}
fn release(storage: Allocation) -> i32 { drop storage return 42 }
effect fn useCell() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let storage = run (Allocator.allocate(Layout.of<i32>())
    |> Effect.provideMut<Allocator>(&mut allocator))
  let mailbox = run (Shared.make<Mailbox>(Mailbox {
    state: Token { storage: move storage }
  }) |> Effect.provideMut<Allocator>(&mut allocator))
  let token = Shared.withMut<Mailbox, Empty | Token>(&mailbox, take)
  drop mailbox
  return consume(move token)
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(useCell(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-two-frame-failure',
    source: `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
struct Problem {}
effect fn failInner(core: Intrinsic.SharedCore<i32>) -> i32 ! Problem {
  let inner = Intrinsic.sharedClone<i32>(&core)
  fail Problem {}
}
effect fn construct() -> i32 ! Problem | Intrinsic.StorageFailure {
  let allocation = run Intrinsic.systemAllocationAcquire(Intrinsic.sharedLayout<i32>())
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    let transferred = Intrinsic.sharedClone<i32>(&core)
    return run failInner(move transferred)
  }
}
effect fn recover(error: Problem | Intrinsic.StorageFailure) -> i32 { return 42 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-construction-exhaustion',
    source: `import silk.allocator { Allocator }
import silk.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.shared { Shared }
struct Token { storage: Allocation }
struct Exhausted {}
effect fn reject(self: &mut Exhausted, layout: Layout) -> Allocation ! OutOfMemoryError {
  fail OutOfMemoryError {}
}
impl Allocator for Exhausted { allocate: Exhausted.reject }
effect fn construct() -> i32 ! OutOfMemoryError {
  let mut system = Allocator.systemAllocatorProvider()
  let payload = run (Allocator.allocate(Layout.of<i32>())
    |> Effect.provideMut<Allocator>(&mut system))
  let token = Token { storage: move payload }
  let mut exhausted = Exhausted {}
  let shared = run (Shared.make<Token>(move token)
    |> Effect.provideMut<Allocator>(&mut exhausted))
  drop shared
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 42 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-clone-drop-during-access',
    source: `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
fn selected(value: &mut i32) -> i32 { return 0 }
fn conflict() -> i32 { return 21 }
fn unused(value: &mut i32, captured: Intrinsic.SharedCore<i32>) -> i32 {
  drop captured
  return 0
}
fn nested(value: &mut i32, core: Intrinsic.SharedCore<i32>) -> i32 {
  let cleanupCore = Intrinsic.sharedClone<i32>(&core)
  return Intrinsic.sharedWithMut<i32, i32>(&core, unused(move cleanupCore), conflict) + 21
}
effect fn construct() -> i32 ! Intrinsic.StorageFailure {
  let allocation = run Intrinsic.systemAllocationAcquire(Intrinsic.sharedLayout<i32>())
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    let nestedCore = Intrinsic.sharedClone<i32>(&core)
    let result = Intrinsic.sharedWithMut<i32, i32>(&core, nested(move nestedCore), conflict)
    drop core
    return result
  }
}
effect fn recover(error: Intrinsic.StorageFailure) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  {
    name: 'local-shared-strong-cycle',
    source: `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
struct Empty {}
struct Bomb {}
impl Drop for Bomb {
  fn drop(self: &mut Bomb) -> () { let boom = 1 / 0 return () }
}
struct Node { bomb: Bomb next: Intrinsic.SharedCore<Node> | Empty }
fn link(value: &mut Node, next: Intrinsic.SharedCore<Node>) -> i32 {
  value.next = move next
  return 0
}
fn conflict() -> i32 { return 0 }
effect fn construct() -> i32 ! Intrinsic.StorageFailure {
  let firstAllocation = run Intrinsic.systemAllocationAcquire(Intrinsic.sharedLayout<Node>())
  let secondAllocation = run Intrinsic.systemAllocationAcquire(Intrinsic.sharedLayout<Node>())
  unsafe {
    let first = Intrinsic.sharedFromAllocation<Node>(
      move firstAllocation,
      Node { bomb: Bomb {}, next: Empty {} },
    )
    let second = Intrinsic.sharedFromAllocation<Node>(
      move secondAllocation,
      Node { bomb: Bomb {}, next: Empty {} },
    )
    let secondEdge = Intrinsic.sharedClone<Node>(&second)
    let firstLink = Intrinsic.sharedWithMut<Node, i32>(&first, link(move secondEdge), conflict)
    let firstEdge = Intrinsic.sharedClone<Node>(&first)
    let secondLink = Intrinsic.sharedWithMut<Node, i32>(&second, link(move firstEdge), conflict)
    if firstLink == 999 { let bomb = Bomb {} drop bomb }
    drop first
    drop second
    return firstLink + secondLink + 42
  }
}
effect fn recover(error: Intrinsic.StorageFailure) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`,
    expected: { _tag: 'Completes', result: 42 },
  },
  // Static-composition runtime parity belongs in the shared native differential rather than a
  // feature-local compile/link loop. Trapping Drop variants causally prove the three cleanup exits.
  ...staticCompositionCorpus,
]

/** Invalid generic programs that must stop before target layout and MIR. */
export const invalidGenericCorpus: ReadonlyArray<InvalidCorpusProgram> = [
  {
    name: 'generic-explicit-arity',
    source:
      'fn identity<T>(value: T) -> T { return move value }\npub fn main() -> i32 { return identity<i32, bool>(42) }',
    codes: ['SEM0051'],
  },
  {
    name: 'generic-explicit-arity-past-prefix',
    source:
      'fn pair<A, B>(left: A, right: B) -> A { return move left }\npub fn main() -> i32 { return pair<i32, bool, u8>(1, true) }',
    codes: ['SEM0051'],
  },
  {
    name: 'generic-uninferred-prefix-remainder',
    source:
      'fn phantom<A, B>(value: A) -> A { return move value }\npub fn main() -> i32 { return phantom<i32>(1) }',
    codes: ['SEM0099'],
  },
  {
    name: 'generic-contradicted-prefix',
    source:
      'fn pair<A, B>(left: A, right: B) -> A { return move left }\npub fn main() -> i32 { return pair<bool>(1, true) }',
    codes: ['SEM0100'],
  },
  {
    name: 'generic-conflicting-inference',
    source:
      'fn same<T>(left: T, right: T) -> T { return move left }\npub fn main() -> i32 { return same(1, true) }',
    codes: ['SEM0052'],
  },
  {
    name: 'generic-polymorphic-recursion',
    source: `fn expand<T>(value: T) -> i32 { return expand<[T; 1]>([move value]) }
pub fn main() -> i32 { return expand<i32>(1) }`,
    codes: ['SEM0053'],
  },
]

/** Phase-owned invalid matching programs shared by diagnostics and release-gate tests. */
export const invalidMatchCorpus: ReadonlyArray<InvalidCorpusProgram> = [
  {
    name: 'match-incomplete',
    source: `struct Left {}
struct Right {}
fn inspect(input: Left | Right) -> i32 { return match &input { Left {} => 1 } }
pub fn main() -> i32 { return 0 }`,
    codes: ['SEM0044'],
  },
  {
    name: 'match-unreachable',
    source: `struct Token {}
fn inspect(input: Token) -> i32 { return match &input { _ => 0 Token {} => 1 } }
pub fn main() -> i32 { return 0 }`,
    codes: ['SEM0043'],
  },
  {
    name: 'match-invalid-member-and-field',
    source: `struct Token { value: i32 }
struct Other {}
fn inspect(input: Token) -> i32 { return match &input { Other {} => 0 Token { value, missing } => value } }
pub fn main() -> i32 { return 0 }`,
    codes: ['SEM0042', 'SEM0022'],
  },
  {
    name: 'match-invalid-guard-and-join',
    source: `struct Left {}
struct Right {}
fn inspect(input: Left | Right) -> i32 { return match &input { Left {} if 1 => 0 Left {} => 0 Right {} => false } }
pub fn main() -> i32 { return 0 }`,
    codes: ['SEM0045'],
  },
  {
    name: 'match-guard-consumes',
    source: `struct Payload {}
struct Box { value: Payload }
fn accept(value: Payload) -> bool { return true }
fn inspect(input: Box) -> i32 { return match move input { Box { value } if accept(move value) => 1 Box { value: fallback } => 0 } }
pub fn main() -> i32 { return 0 }`,
    codes: ['OWN0008'],
  },
  {
    name: 'match-borrow-escape-exclusive-immutable',
    source: `struct Payload {}
struct Box { value: Payload }
fn escape(input: Box) -> Payload { return match &input { Box { value } => value } }
fn exclusive(input: Box) -> i32 { return match &mut input { Box { .. } => 0 } }
pub fn main() -> i32 { return 0 }`,
    codes: ['OWN0006', 'OWN0007'],
  },
  {
    name: 'match-malformed-pattern',
    source: `struct Token { value: i32 }
fn inspect(input: Token) -> i32 { return match &input { Token { value: } 0 } }
pub fn main() -> i32 { return 0 }`,
    codes: ['PAR0001'],
  },
]
