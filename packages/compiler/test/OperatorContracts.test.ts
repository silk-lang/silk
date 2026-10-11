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

const snapshot = (source: string) =>
  AnalysisFixture.retainingMain('operator-contracts/main', encoder.encode(source))

const parse = (id: string, source: string) =>
  Parser.parse(Lexer.lex(SourceFile.make(id, encoder.encode(source))))

it.effect('accepts homogeneous enum equality and diagnoses nominal boundary violations', () =>
  Effect.gen(function* () {
    const source = `enum Status { Ready, Waiting }
enum Mode { Ready, Waiting }
fn same(left: Status, right: Status) -> bool { return left == right }
fn notSame(left: Status, right: Status) -> bool { return left != right }
fn crossEqual(left: Status, right: Mode) -> bool { return left == right }
fn crossNotEqual(left: Status, right: Mode) -> bool { return left != right }
fn enumInteger(left: Status) -> bool { return left == 0 }
fn integerEnum(right: Status) -> bool { return 0 != right }
fn less(left: Status, right: Status) -> bool { return left < right }
fn lessEqual(left: Status, right: Status) -> bool { return left <= right }
fn greater(left: Status, right: Status) -> bool { return left > right }
fn greaterEqual(left: Status, right: Status) -> bool { return left >= right }
fn integerToEnum() -> Status { return 0 }
fn enumToInteger() -> u8 { return Status.Ready }`
    const self = yield* Analysis.ofSource('operator-contracts/enums', encoder.encode(source))
    const equalities = Analysis.expressionsOf(self, 'operator-contracts/enums').filter(
      (expression) => expression._tag === 'EnumEquality',
    )
    assert.strictEqual(equalities.length, 2)
    assert.strictEqual(
      equalities.every((expression) => expression.type === 'bool'),
      true,
    )

    const spanAfter = (marker: string, text: string): Array<number> => {
      const markerStart = source.indexOf(marker)
      const returnStart = source.indexOf('return', markerStart)
      const start = source.indexOf(text, returnStart)
      return [start, start + text.length]
    }
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => ({
        code: diagnostic.code,
        span: [diagnostic.span.start, diagnostic.span.end],
        related: diagnostic.relatedSpans?.map((related) => [related.span.start, related.span.end]),
      })),
      [
        {
          code: Diagnostic.crossEnumEqualityCode,
          span: spanAfter('fn crossEqual', '=='),
          related: undefined,
        },
        {
          code: Diagnostic.crossEnumEqualityCode,
          span: spanAfter('fn crossNotEqual', '!='),
          related: undefined,
        },
        {
          code: Diagnostic.enumIntegerMismatchCode,
          span: spanAfter('fn enumInteger', '=='),
          related: undefined,
        },
        {
          code: Diagnostic.enumIntegerMismatchCode,
          span: spanAfter('fn integerEnum', '!='),
          related: undefined,
        },
        {
          code: Diagnostic.enumOrderingCode,
          span: spanAfter('fn less(', '<'),
          related: undefined,
        },
        {
          code: Diagnostic.enumOrderingCode,
          span: spanAfter('fn lessEqual', '<='),
          related: undefined,
        },
        {
          code: Diagnostic.enumOrderingCode,
          span: spanAfter('fn greater(', '>'),
          related: undefined,
        },
        {
          code: Diagnostic.enumOrderingCode,
          span: spanAfter('fn greaterEqual', '>='),
          related: undefined,
        },
        {
          code: Diagnostic.enumIntegerMismatchCode,
          span: spanAfter('fn integerToEnum', '0'),
          related: undefined,
        },
        {
          code: Diagnostic.enumIntegerMismatchCode,
          span: spanAfter('fn enumToInteger', 'Status.Ready'),
          related: undefined,
        },
      ],
    )
  }),
)

it.effect('does not grant operator syntax to a conventional operation name', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`struct Value { raw: i32 }
fn multiply(left: Value, right: Value) -> Value {
  drop right
  return move left
}
interface Named { fn multiply(left: Self, right: Self) -> Self }
impl Named for Value { multiply: Value.multiply }
pub fn main() -> i32 {
  let left = Value { raw: 1 }
  let right = Value { raw: 2 }
  let value = move left * move right
  return value.raw
}`)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      [Diagnostic.operatorNotApplicableCode],
    )
  }),
)

it.effect('rejects control markers, service markers, and ambiguous marked contracts', () =>
  Effect.gen(function* () {
    const invalid = yield* snapshot(`interface Invalid {
  operator && fn both(left: Self, right: Self) -> bool
  operator * fn scale(left: i32, right: Wrapped<Self>) -> i32
}
struct Wrapped<T> { value: T }
service Runtime {
  operator + fn add(left: i32, right: i32) -> i32
}
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(
      Analysis.diagnostics(invalid).map((diagnostic) => diagnostic.code),
      [
        Diagnostic.invalidOperatorContractCode,
        Diagnostic.invalidOperatorContractCode,
        Diagnostic.invalidOperatorContractCode,
      ],
    )

    const ambiguous = yield* snapshot(`struct Value { raw: i32 }
fn first(left: Value, right: Value) -> Value {
  drop right
  return move left
}
fn second(left: Value, right: Value) -> Value {
  drop left
  return move right
}
interface First { operator + fn apply(left: Self, right: Self) -> Self }
interface Second { operator + fn apply(left: Self, right: Self) -> Self }
impl First for Value { apply: Value.first }
impl Second for Value { apply: Value.second }
pub fn main() -> i32 {
  let left = Value { raw: 1 }
  let right = Value { raw: 2 }
  let value = move left + move right
  return value.raw
}`)
    assert.deepEqual(
      Analysis.diagnostics(ambiguous).map((diagnostic) => diagnostic.code),
      [Diagnostic.ambiguousOperatorCode],
    )
  }),
)

it.effect('rejects a marker whose arity does not match the operator', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`interface Invalid {
  operator + fn add(value: Self) -> Self
}
pub fn main() -> i32 { return 0 }`)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      [Diagnostic.invalidOperatorContractCode],
    )
  }),
)

it.effect('formats the contextual marker before ordinary and effect contracts', () =>
  Effect.gen(function* () {
    const ordinary = yield* SyntaxFormatter.format(
      parse(
        'operator-contracts/format',
        'interface M{operator   * fn  mul(left:Self,right:i32)->Self}',
      ),
    )
    assert.strictEqual(
      new TextDecoder().decode(FormattedDocument.toUint8Array(ordinary)),
      'interface M {\n  operator * fn mul(left: Self, right: i32) -> Self\n}\n',
    )
    const effectful = yield* SyntaxFormatter.format(
      parse(
        'operator-contracts/effect-format',
        'interface M{operator * effect fn mul(left:Self,right:i32)->Self}',
      ),
    )
    assert.strictEqual(
      new TextDecoder().decode(FormattedDocument.toUint8Array(effectful)),
      'interface M {\n  operator * effect fn mul(left: Self, right: i32) -> Self\n}\n',
    )
  }),
)
