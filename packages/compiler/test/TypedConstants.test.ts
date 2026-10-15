import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Diagnostic from '../src/Diagnostic.js'
import * as FormattedDocument from '../src/FormattedDocument.js'
import * as Lexer from '../src/Lexer.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SyntaxFormatter from '../src/SyntaxFormatter.js'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

it.effect('parses and formats typed constant declarations losslessly', () =>
  Effect.gen(function* () {
    const syntax = Parser.parse(
      Lexer.lex(
        SourceFile.make(
          'constants/syntax',
          encoder.encode('pub   const answer:i32=40\nconst enabled : bool = true'),
        ),
      ),
    )
    assert.deepEqual(syntax.lexicalDiagnostics, [])
    assert.deepEqual(syntax.parserDiagnostics, [])
    assert.deepEqual(
      syntax.root.children.flatMap((child) => (child._tag === 'SyntaxNode' ? [child.kind] : [])),
      ['ConstantDeclaration', 'ConstantDeclaration'],
    )
    assert.strictEqual(
      syntax.tokens.find((token) => token.kind === 'ConstKeyword')?.kind,
      'ConstKeyword',
    )
    const formatted = yield* SyntaxFormatter.format(syntax)
    assert.strictEqual(
      decoder.decode(FormattedDocument.toUint8Array(formatted)),
      'pub const answer: i32 = 40\n\nconst enabled: bool = true\n',
    )
  }),
)

it.effect('accepts computed constant initializers while rejecting mismatched values', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'constants/invalid',
      encoder.encode(`const wrong: bool = 1
const computed: i32 = 40 + 2
const answer: i32 = 42
pub fn main() -> i32 { return move answer }`),
    )
    const invalid = Analysis.diagnostics(snapshot).filter(
      (diagnostic) => diagnostic.code === 'SEM0086',
    )
    assert.strictEqual(invalid.length, 2)
  }),
)

it.effect('reports one deterministic cycle diagnostic for cyclic constants', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'constants/cycle',
      encoder.encode(`const first: i32 = second
const second: i32 = first
pub fn main() -> i32 { return 0 }`),
    )

    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      [Diagnostic.staticEvaluationCycleCode],
    )
  }),
)

it.effect('compiles the raw-string example block that motivated the raw literal form', () =>
  Effect.gen(function* () {
    // Original issue #13 raw literal bodies, with explicit static storage lifetimes.
    const example = String.raw`const decimalPattern: string<'static> = r"\d+\.\d+"
const windowsPath: string<'static> = r"C:\Users\build\output"

const helpText: string<'static> = r"""
Usage: silk build [options]
  --target \path\to\dir
"""

pub fn main() -> i32 { return 0 }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'constants/example',
      encoder.encode(example),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('accepts constant references while retaining string initializer restrictions', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'constants/string-invalid',
      encoder.encode(`const source: string<'static> = "a"
const copied: string<'static> = source
const bytes: string<'static> = b"a"
const escape: string<'static> = "\\q"
pub fn main() -> i32 { return 0 }`),
    )
    const messages = Analysis.diagnostics(snapshot)
      .filter((diagnostic) => diagnostic.code === 'SEM0086')
      .map((diagnostic) => diagnostic.message)
    assert.deepEqual(messages, [
      'Invalid constant: a byte-string literal does not produce a string',
      'Invalid constant: unknown escape sequence',
    ])
  }),
)

it.effect('checks usize constants against the selected target even when unused', () =>
  Effect.gen(function* () {
    const wide = '4294967296'
    const input = `const wide: usize = ${wide}
pub fn main() -> i32 { return 0 }`
    const native = yield* AnalysisFixture.retainingMain(
      'constants/usize',
      encoder.encode(input),
      'aarch64-apple-darwin',
    )
    assert.notInclude(
      Analysis.diagnostics(native).map((diagnostic) => diagnostic.code),
      Diagnostic.integerOutOfRangeCode,
    )

    const wasm = yield* AnalysisFixture.retainingMain(
      'constants/usize',
      encoder.encode(input),
      'wasm32-unknown-unknown',
    )
    const overflow = Analysis.diagnostics(wasm).filter(
      (diagnostic) => diagnostic.code === Diagnostic.integerOutOfRangeCode,
    )
    assert.strictEqual(overflow.length, 1)
    assert.strictEqual(overflow[0]?.span.start, input.indexOf(wide))
  }),
)

it.effect(
  'rejects calling and assigning constants while permitting a borrowed materialization',
  () =>
    Effect.gen(function* () {
      const input = `const answer: i32 = 42
pub fn main() -> i32 {
  let called = answer()
  let borrowed = &mut answer
  answer = 1
  return called
}`
      const snapshot = yield* AnalysisFixture.retainingMain(
        'constants/operations',
        encoder.encode(input),
      )
      const codes = Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code)
      assert.include(codes, Diagnostic.nonCallableApplicationCode)
      assert.include(codes, Diagnostic.invalidAssignmentPlaceCode)
      const occurrence = Analysis.semanticOccurrenceAt(
        snapshot,
        'constants/operations',
        input.indexOf('answer()'),
      )
      assert.strictEqual(occurrence?.resolution._tag, 'Available')
      assert.strictEqual(occurrence?.declaration?.module, 'constants/operations')
      assert.strictEqual(
        occurrence === undefined
          ? undefined
          : Analysis.occurrencePresentation(snapshot, 'constants/operations', occurrence)?.text,
        'const answer: i32',
      )
    }),
)
