import * as Layer from 'effect/Layer'
import * as TestToolchain from './support/TestToolchain.js'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterAll, assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Driver from './support/TestDriver.js'

/**
 * The pinned Unicode conformance data, run through the standard library's own normalizer.
 *
 * Hand-picked examples pass while an implementation is subtly wrong — a composition exclusion left
 * in, a combining class off by one, a blocked mark composed anyway. `NormalizationTest.txt` is the
 * file that catches those, so the whole of it runs here rather than a selection of it.
 *
 * Each case asserts the UAX #15 invariants for the two canonical forms:
 *
 *   NFC(c1) == NFC(c2) == NFC(c3) == c2
 *   NFD(c1) == NFD(c2) == NFD(c3) == c3
 *
 * The compatibility columns are not checked; NFKC and NFKD are out of scope for #42.
 *
 * The corpus travels into the program as one packed byte string the Silk harness walks, rather than
 * as one call statement per case. That is a speed decision with a measured basis: as call
 * statements the corpus costs about 14 ms of analysis per case, four minutes for the file, while a
 * packed corpus makes analysis a constant and hands the work to a compiled binary that finishes it
 * in milliseconds.
 */

const dataRoot = join(dirname(fileURLToPath(import.meta.url)), '..', 'unicode-data')

const destinationRoot = mkdtempSync(join(tmpdir(), 'silk-conformance-'))
afterAll(() => rmSync(destinationRoot, { recursive: true, force: true }))

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

interface Case {
  readonly line: number
  readonly source: ReadonlyArray<number>
  readonly nfc: ReadonlyArray<number>
  readonly nfd: ReadonlyArray<number>
}

const parse = (): ReadonlyArray<Case> => {
  const text = readFileSync(join(dataRoot, 'NormalizationTest.txt'), 'utf8')
  const points = (field: string | undefined) =>
    (field ?? '')
      .split(' ')
      .filter((value) => value !== '')
      .map((value) => Number.parseInt(value, 16))
  const cases: Array<Case> = []
  text.split('\n').forEach((raw, index) => {
    const line = raw.trim()
    if (line === '' || line.startsWith('#') || line.startsWith('@')) return
    const columns = line.split(';')
    cases.push({
      line: index + 1,
      source: points(columns[0]),
      nfc: points(columns[1]),
      nfd: points(columns[2]),
    })
  })
  return cases
}

const utf8 = (points: ReadonlyArray<number>): Uint8Array =>
  new TextEncoder().encode(String.fromCodePoint(...points))

/** One case as `[length][bytes]` for each of the source, NFC, and NFD columns. */
const encode = (entry: Case): ReadonlyArray<number> =>
  [entry.source, entry.nfc, entry.nfd].flatMap((points) => {
    const bytes = utf8(points)
    if (bytes.length > 255)
      throw new Error(`conformance field at line ${entry.line} exceeds a byte`)
    return [bytes.length, ...bytes]
  })

const literal = (bytes: ReadonlyArray<number>): string =>
  `b"${bytes.map((byte) => `\\x${byte.toString(16).padStart(2, '0')}`).join('')}"`

/**
 * The largest failure count a program reports, chosen to stay clear of the exit-status wrap.
 *
 * A process exit status is a byte, so an unsaturated count of exactly 256 would be indistinguishable
 * from a clean run. Reporting at most this many keeps a nonzero number of failures nonzero.
 */
const saturation = 250

/**
 * A program returning the number of failing assertions across its chunk.
 *
 * The harness is ordinary Silk calling the same public API a user program would, comparing with
 * ordinary exact `string` equality — the equality this issue must leave alone.
 */
const program = (cases: ReadonlyArray<Case>): string => `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.u8
import silk.usize
import silk.result { Result }
import silk.string { String, InvalidUtf8 }
import silk.unicode { Unicode }
import silk.vector { Vector }

/// Copies one length-prefixed field out of the corpus so it can be validated into text.
effect fn field(
  data: &[u8],
  start: usize,
  count: usize,
) -> Vector<u8> ! OutOfMemoryError ? &mut Allocator {
  let mut buffer = Vector<u8>.make()
  let mut index = usize.ZERO
  while index < count {
    let appended = run Vector<u8>.append(&mut buffer, data[start + index])
    index = index + usize.ONE
  }
  return move buffer
}

fn same(left: &[u8], right: &[u8]) -> bool {
  if left.length != right.length { return false }
  let mut index = usize.ZERO
  while index < left.length {
    if left[index] != right[index] { return false }
    index = index + usize.ONE
  }
  return true
}

/// Normalizes one input both ways and checks it against the expected forms.
///
/// Comparison is on bytes so the conformance fixture checks the exact encoded normalization forms.
/// Exact \`string\` equality itself is checked in \`UnicodeNormalization.test.ts\`.
effect fn checkFrom(
  text: string,
  nfc: &[u8],
  nfd: &[u8],
) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut failures = 0
  let composed = run Unicode.normalizeNfc(text)
  if same(String.ownedUtf8Bytes(&composed), nfc) {} else { failures = failures + 1 }
  let decomposed = run Unicode.normalizeNfd(text)
  if same(String.ownedUtf8Bytes(&decomposed), nfd) {} else { failures = failures + 1 }
  return failures
}

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let data = ${literal(cases.flatMap(encode))}
  let mut offset = usize.ZERO
  let mut remaining = usize.add(0, ${cases.length})
  let mut failures = 0
  while usize.ZERO < remaining {
    let sourceLength = u8.toUsize(data[offset])
    let sourceBytes = run field(data, offset + usize.ONE, sourceLength)
      |> Effect.provideMut(&mut allocator)
    offset = offset + usize.ONE + sourceLength
    let nfcLength = u8.toUsize(data[offset])
    let nfcBytes = run field(data, offset + usize.ONE, nfcLength)
      |> Effect.provideMut(&mut allocator)
    offset = offset + usize.ONE + nfcLength
    let nfdLength = u8.toUsize(data[offset])
    let nfdBytes = run field(data, offset + usize.ONE, nfdLength)
      |> Effect.provideMut(&mut allocator)
    offset = offset + usize.ONE + nfdLength
    let sourceText = match move String.fromUtf8(Vector<u8>.asSlice(&sourceBytes)) {
        Result<string, InvalidUtf8>.Success { value } => value
        Result<string, InvalidUtf8>.Failure { error } => ""
    }
    let fromSource = run checkFrom(
      sourceText,
      Vector<u8>.asSlice(&nfcBytes),
      Vector<u8>.asSlice(&nfdBytes),
    ) |> Effect.provideMut(&mut allocator)
    let nfcText = match move String.fromUtf8(Vector<u8>.asSlice(&nfcBytes)) {
        Result<string, InvalidUtf8>.Success { value } => value
        Result<string, InvalidUtf8>.Failure { error } => ""
    }
    let fromNfc = run checkFrom(
      nfcText,
      Vector<u8>.asSlice(&nfcBytes),
      Vector<u8>.asSlice(&nfdBytes),
    ) |> Effect.provideMut(&mut allocator)
    let nfdText = match move String.fromUtf8(Vector<u8>.asSlice(&nfdBytes)) {
        Result<string, InvalidUtf8>.Success { value } => value
        Result<string, InvalidUtf8>.Failure { error } => ""
    }
    let fromNfd = run checkFrom(
      nfdText,
      Vector<u8>.asSlice(&nfcBytes),
      Vector<u8>.asSlice(&nfdBytes),
    ) |> Effect.provideMut(&mut allocator)
    failures = failures + fromSource + fromNfc + fromNfd
    remaining = remaining - usize.ONE
  }
  // The count leaves this program as a process exit status, which is a byte, so exactly 256 failing
  // assertions would arrive as a 0 and read as a pass. Saturating below the wrap keeps every value
  // the test can observe honest: an exact count under ${saturation}, or ${saturation} meaning at
  // least that many.
  if failures > ${saturation} { return ${saturation} }
  return failures
}

effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }

pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`

/**
 * Compiles the whole corpus into one native binary and returns its failure count.
 *
 * The corpus runs as one native program so every case shares a single compile/link operation.
 */
const failuresIn = (name: string, cases: ReadonlyArray<Case>) =>
  Effect.gen(function* () {
    const source = program(cases)
    const compiled = yield* Driver.compile({
      compilation: { root: name },
      toolchain: yield* TestToolchain.configured,
      optimization: 'release',
      artifactKind: 'NativeExecutable',
      destination: join(destinationRoot, name.replaceAll('/', '-')),
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make(name, ascii(source))]).pipe(
          Layer.provideMerge(SourceResolver.empty),
        ),
      ),
    )
    if ('diagnostics' in compiled)
      assert.deepEqual(
        compiled.diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          span: diagnostic.span,
        })),
        [],
      )
    if (compiled._tag === 'VerificationFailed') assert.deepEqual(compiled.error.violations, [])
    assert.strictEqual(compiled._tag, 'Compiled', `${name} did not compile`)
    if (compiled._tag !== 'Compiled') return Number.NaN
    const run = spawnSync(compiled.path, [], { encoding: 'utf8' })
    assert.isNull(run.signal, `${name} died on ${run.signal}`)
    return run.status ?? Number.NaN
  })

const spell = (points: ReadonlyArray<number>) =>
  points.map((point) => point.toString(16).toUpperCase().padStart(4, '0')).join(' ')

/** How many failing cases to name individually before the report stops paying for detail. */
const narrowLimit = 15

it.effect(
  'normalizes every case in the pinned Unicode conformance data',
  () =>
    Effect.gen(function* () {
      const cases = parse()
      assert.isAbove(cases.length, 19_000, 'the conformance corpus was read')

      const failures = yield* failuresIn('unicode-conformance/corpus', cases)
      if (failures === 0) return

      // A run only fails while something is wrong, so paying for per-case re-runs to name the
      // offenders costs nothing on a healthy suite and is the whole value on a sick one.
      const failing: Array<string> = []
      for (const entry of cases) {
        if (failing.length >= narrowLimit) break
        const single = yield* failuresIn(`unicode-conformance/line-${entry.line}`, [entry])
        if (single === 0) continue
        failing.push(
          `line ${entry.line}: ${spell(entry.source)} ; NFC ${spell(entry.nfc)} ; NFD ${spell(entry.nfd)} (${single}/6 assertions failed)`,
        )
      }
      assert.fail(
        `${failures} failing assertions across ${cases.length} conformance cases` +
          `${failures === saturation ? ' (count saturated)' : ''}; first ${failing.length}:\n${failing.join('\n')}`,
      )
    }),
  1_800_000,
)
