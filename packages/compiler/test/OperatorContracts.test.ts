import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Diagnostic from '../src/Diagnostic.js'
import * as Lexer from '../src/Lexer.js'
import * as Parser from '../src/Parser.js'
import * as SourceFile from '../src/SourceFile.js'

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

it.effect('binds operators to the stdlib operator interfaces', () =>
  Effect.gen(function* () {
    // `*` reads only `silk.ops.Multiply`; `Right` selects among conformances, and `==`, `!=`, `<`,
    // and `>=` use `Equal.equals` and `Order.compare` in written order.
    const self = yield* snapshot(`import silk.equal { Equal }
import silk.ops { Multiply }
import silk.order { Order, Ordering }
struct Vector { x: f64 y: f64 }
fn scale(vector: Vector, factor: f64) -> Vector {
  return Vector { x: vector.x * factor, y: vector.y * factor }
}
fn dot(left: Vector, right: Vector) -> f64 { return left.x * right.x + left.y * right.y }
impl Multiply<f64, Vector> for Vector { multiply: Vector.scale }
impl Multiply<Vector, f64> for Vector { multiply: Vector.dot }
struct Rank { value: i32 }
fn sameRank(left: &Rank, right: &Rank) -> bool { return left.value == right.value }
fn compareRank(left: &Rank, right: &Rank) -> Ordering {
  if left.value < right.value { return Ordering.Less }
  if right.value < left.value { return Ordering.Greater }
  return Ordering.Equal
}
impl Equal for Rank { equals: Rank.sameRank }
impl Order for Rank { compare: Rank.compareRank }
pub fn main() -> i32 {
  let scaled = Vector { x: 1.0, y: 2.0 } * 3.0
  let product: f64 = move scaled * Vector { x: 1.0, y: 1.0 }
  if product != 9.0 { return 1 }
  let low = Rank { value: 1 }
  let high = Rank { value: 2 }
  if &low == &high || !(&low != &high) { return 2 }
  if !(&low < &high) || &low >= &high { return 3 }
  return 42
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
  }),
)

it.effect('rejects two conformances that accept the same operands', () =>
  Effect.gen(function* () {
    const source = `import silk.ops { Multiply }
struct Vector { x: f64 }
fn scale(vector: Vector, factor: f64) -> Vector { return Vector { x: vector.x * factor } }
fn measure(vector: Vector, factor: f64) -> f64 { return vector.x * factor }
impl Multiply<f64, Vector> for Vector { multiply: Vector.scale }
impl Multiply<f64, f64> for Vector { multiply: Vector.measure }
pub fn main() -> i32 {
  let scaled = Vector { x: 1.0 } * 2.0
  drop scaled
  return 0
}`
    const self = yield* snapshot(source)
    const operator = source.indexOf('* 2.0')
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => [
        diagnostic.code,
        diagnostic.span.start,
        diagnostic.span.end,
      ]),
      [[Diagnostic.ambiguousOperatorCode, operator, operator + 1]],
    )
  }),
)

it('has no operator declaration syntax', () => {
  const source = 'interface M { operator * fn mul(left: Self, right: i32) -> Self }\n'
  const tree = parse('operator-contracts/marker', source)
  assert.deepEqual(
    tree.parserDiagnostics.map((diagnostic) => [diagnostic.code, diagnostic.span.start]),
    [['PAR0002', source.indexOf('operator')]],
  )
})
