import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Tir from '../src/Tir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as Scalar from '../src/Scalar.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as StaticValue from '../src/StaticValue.js'
import { templateFormattingAcceptance } from './support/corpus.js'

const encoder = new TextEncoder()
const ascii = (value: string): Uint8Array => encoder.encode(value)
const fixedWidthIntegers = Scalar.integers().filter((scalar) => scalar.width._tag === 'FixedWidth')
const integerSpellings = [...fixedWidthIntegers.map((scalar) => scalar.spelling), 'usize', 'isize']

const formattingFailureProgram = (body: string): string => `import silk.effect { Effect }
import silk.format { Format }
import silk.writer { Writer, WriterError }
import silk.writer { Writer, WriterError }

struct Sink {}
impl Writer for Sink {
  effect fn writeAll(self: &mut Self, bytes: &[u8]) -> () ! WriterError ? &mut Writer { return () }
  effect fn flush(self: &mut Self) -> () ! WriterError ? &mut Writer { return () }
}

effect fn render() -> () ! WriterError ? &mut Writer {
${body}
}

pub effect fn main() -> () ! WriterError {
  let mut writer = Sink {}
  return run render() |> Effect.provideMut<Writer>(&mut writer)
}`

const byteOffset = (source: string, characterOffset: number): number =>
  encoder.encode(source.slice(0, characterOffset)).length

it.effect('anchors malformed, mixed, arity, and field diagnostics to template bytes', () =>
  Effect.gen(function* () {
    const cases = [
      { name: 'unclosed', body: '  return run Format.format("open {", &(1, 2))', marked: '{' },
      { name: 'closing', body: '  return run Format.format("close }", &(1, 2))', marked: '}' },
      {
        name: 'mixed',
        body: '  return run Format.format("first={} next={name}", &(1, 2))',
        marked: '{name}',
      },
      {
        name: 'missing-multibyte',
        body: '  return run Format.format("Olá {missing}", &.{ name: "Julia" })',
        marked: '{missing}',
      },
    ] as const

    for (const testCase of cases) {
      const sourceId = `number-text/template-${testCase.name}`
      const source = formattingFailureProgram(testCase.body)
      const snapshot = yield* AnalysisFixture.retainingMain(
        sourceId,
        encoder.encode(source),
        'wasm32-unknown-unknown',
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.strictEqual(diagnostics.length, 1, testCase.name)
      const diagnostic = diagnostics.at(0)
      assert.strictEqual(diagnostic?.code, 'SEM0177', testCase.name)
      const bodyStart = source.indexOf(testCase.body)
      const markedCharacterStart = source.indexOf(testCase.marked, bodyStart)
      assert.strictEqual(diagnostic?.span.sourceId, sourceId)
      assert.strictEqual(diagnostic?.span.start, byteOffset(source, markedCharacterStart))
      assert.strictEqual(
        diagnostic?.span.end,
        byteOffset(source, markedCharacterStart + testCase.marked.length),
      )
      if (testCase.name === 'missing-multibyte')
        assert.include(diagnostic?.message ?? '', 'available visible fields: name')
    }

    for (const testCase of [
      {
        name: 'arity',
        template: '{}{}{}',
        body: '  return run Format.format("{}{}{}", &(1, 2))',
      },
      {
        name: 'aggregate-kind',
        template: '{}',
        body: '  return run Format.format("{}", &.{ value: 1 })',
      },
    ] as const) {
      const sourceId = `number-text/template-${testCase.name}`
      const source = formattingFailureProgram(testCase.body)
      const snapshot = yield* AnalysisFixture.retainingMain(
        sourceId,
        encoder.encode(source),
        'wasm32-unknown-unknown',
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.strictEqual(diagnostics.length, 1, testCase.name)
      const diagnostic = diagnostics.at(0)
      assert.strictEqual(diagnostic?.code, 'SEM0177', testCase.name)
      const templateCharacterStart = source.lastIndexOf(`"${testCase.template}"`) + 1
      assert.strictEqual(diagnostic?.span.start, byteOffset(source, templateCharacterStart))
      assert.strictEqual(
        diagnostic?.span.end,
        byteOffset(source, templateCharacterStart + testCase.template.length),
      )
    }
  }),
)

it.effect('keeps unreachable invalid templates unevaluated and missing Display ordinary', () =>
  Effect.gen(function* () {
    const unreachable = yield* AnalysisFixture.retainingMain(
      'number-text/template-unreachable',
      encoder.encode(`import silk.format { Format }
import silk.writer { Writer, WriterError }
effect fn ignored() -> () ! WriterError ? &mut Writer {
  return run Format.format("unclosed {", &(1, 2))
}
pub fn main() -> i32 { return 42 }`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(unreachable), [])

    const missingDisplaySource = formattingFailureProgram(
      '  return run Format.format("{enabled}", &.{ enabled: true })',
    )
    const missingDisplay = yield* AnalysisFixture.retainingMain(
      'number-text/template-missing-display',
      encoder.encode(missingDisplaySource),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(missingDisplay).map((diagnostic) => diagnostic.code),
      ['SEM0083'],
    )
  }),
)

it.effect('classifies static template bytes and residualizes only the selected arm', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'number-text/template-byte',
      ascii(`import silk.static_text { StaticText }
import silk.static_sequence { StaticSequence }
import silk.usize
static fn startsOpen(value: string) -> bool {
  let parts = StaticSequence.empty<i32>()
  let length = StaticText.byteLength(value)
  let mut index = usize.ZERO
  while index < length {
    let byte = StaticText.byteAt(value, index)
    if byte == 123 { return true }
    index = index + usize.ONE
  }
  return false
}
pub fn main() -> i32 {
  static if startsOpen("name") { return 0 } else { return 42 }
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const encoded = MirEncoding.encode(Analysis.loweredMir(snapshot))
    assert.include(encoded, 'literal 42 : i32')
    assert.notInclude(encoded, 'literal 0 : i32')
    assert.notInclude(encoded, 'StaticText.byteAt')
  }),
)

it.effect('residualizes borrowed aggregate formatting without allocator machinery', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'number-text/templates-structure',
      ascii(templateFormattingAcceptance),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const formatInstances = Analysis.instancesOf(snapshot).instances.filter(
      (instance) =>
        instance.key.declaration.module === 'silk/format' &&
        instance.key.declaration.name === 'Format.format',
    )
    assert.strictEqual(formatInstances.length, 4)
    assert.strictEqual(
      new Set(
        formatInstances.map((instance) =>
          instance.key.staticArguments.map(StaticValue.presentation).join('|'),
        ),
      ).size,
      4,
    )
    const projectedLoans = formatInstances.flatMap((instance) =>
      instance.ownership.loans.filter((loan) => loan.root._tag === 'Parameter'),
    )
    assert.isAbove(projectedLoans.length, 0)
    assert.isTrue(projectedLoans.every((loan) => loan.access === 'Shared'))
    const residualTir = Tir.encode(
      Object.freeze({
        _tag: 'TirModule',
        module: 'silk/format',
        functions: Object.freeze(formatInstances.map((instance) => instance.function)),
      }),
    )
    const mir = MirEncoding.encode(Analysis.loweredMir(snapshot))
    assert.include(residualTir, 'borrow-value')
    assert.include(mir, 'begin-loan')
    for (const spelling of ['silk/allocator', 'Intrinsic.Fields', 'silk/static_sequence']) {
      assert.notInclude(residualTir, spelling)
      assert.notInclude(mir, spelling)
    }
  }),
)

it.effect('does not expose private fields as named formatting candidates', () =>
  Effect.gen(function* () {
    const module = 'number-text/template-private-field'
    const source = `import model.Person
import silk.effect { Effect }
import silk.format { Format }
import silk.writer { Writer, WriterError }
import silk.writer { Writer, WriterError }

struct Sink {}
impl Writer for Sink {
  effect fn writeAll(self: &mut Self, bytes: &[u8]) -> () ! WriterError ? &mut Writer { return () }
  effect fn flush(self: &mut Self) -> () ! WriterError ? &mut Writer { return () }
}

effect fn render() -> () ! WriterError ? &mut Writer {
  let person = Person.make()
  return run Format.format("{missing}", &person)
}

pub effect fn main() -> () ! WriterError {
  let mut writer = Sink {}
  return run render() |> Effect.provideMut<Writer>(&mut writer)
}`
    const snapshot = yield* Analysis.makeRealized({
      root: module,
      target: 'wasm32-unknown-unknown',
    }).pipe(
      Effect.provide(
        SourceResolver.overlay([SourceFile.make(module, encoder.encode(source))]).pipe(
          Layer.provideMerge(
            SourceResolver.memory(
              new Map([
                [
                  'model/Person',
                  encoder.encode(`pub struct Person { pub name: string<'static> token: i32 }
pub fn make() -> Person { return Person { name: "Julia", token: 42 } }`),
                ],
              ]),
            ),
          ),
        ),
      ),
    )
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0177'],
    )
    const placeholderStart = source.indexOf('{missing}')
    assert.strictEqual(diagnostics.at(0)?.span.sourceId, module)
    assert.strictEqual(diagnostics.at(0)?.span.start, byteOffset(source, placeholderStart))
    assert.strictEqual(
      diagnostics.at(0)?.span.end,
      byteOffset(source, placeholderStart + '{missing}'.length),
    )
    assert.include(diagnostics.at(0)?.message ?? '', 'available visible fields: name')
    assert.isTrue(diagnostics.every((diagnostic) => !diagnostic.message.includes('token')))
  }),
)

it('declares inline Display witnesses without a second string-writing route', () => {
  const source = readFileSync(new URL('../stdlib/silk/format.silk', import.meta.url), 'utf8')
  for (const spelling of integerSpellings) assert.include(source, `impl Display for ${spelling} {`)
  assert.include(
    source,
    `impl<'text> Display for string<'text> {
  /// Writes the string's UTF-8 bytes through the ambient mutable Writer.`,
  )
  assert.include(source, 'return run Format.writeText(&mut formatter, self.*)')
  assert.notInclude(source, 'unsignedText(')
  assert.notInclude(source, 'signedText(')
  assert.notInclude(source, 'OutOfMemoryError')
  assert.notInclude(source, '? &mut Allocator')
})
