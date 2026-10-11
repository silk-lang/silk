import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Json from './support/Json.js'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'

const encoder = new TextEncoder()

const snapshot = (source: string) =>
  AnalysisFixture.retainingMain('order-interface/main', encoder.encode(source))

it.effect('rejects a type with no Order witness', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.order { Order }
fn less<T: Order>(left: &T, right: &T) -> bool { return left < right }
pub fn main() -> bool {
  return less(&true, &false)
}`)
    assert.isTrue(
      Analysis.diagnostics(self).some((diagnostic) =>
        diagnostic.message.includes('does not implement Order'),
      ),
      Json.stringify(Analysis.diagnostics(self).map((diagnostic) => diagnostic.message)),
    )
  }),
)

it.effect('selects one concrete comparison with no runtime dispatch', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.order { Order }
fn less<T: Order>(left: &T, right: &T) -> bool { return left < right }
pub fn main() -> i32 {
  let low: i32 = 1
  let high: i32 = 2
  let ordered = less<i32>(&low, &high)
  if ordered { return 42 }
  return 0
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const operations = Analysis.loweredMir(self).functions.flatMap(MirVerification.operations)
    const comparisons = operations.filter(
      (operation) => operation._tag === 'Binary' && operation.operator === 'LessThan',
    )
    // The selected witness compares twice (before, then after) and results in bool rather than in
    // the bound's type parameter.
    assert.strictEqual(comparisons.length, 2)
    if (comparisons[0]?._tag === 'Binary') assert.deepEqual(comparisons[0].type, { _tag: 'bool' })
    // Interface selection is static: no provider slot and no dispatch reaches the lowered program.
    assert.isFalse(
      operations.some((operation) =>
        ['Switch', 'Provide', 'ServiceCall', 'ServiceEffectConstruct'].includes(operation._tag),
      ),
    )
  }),
)

it.effect('specializes one bound per conforming integer width', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.order { Order }
fn less<T: Order>(left: &T, right: &T) -> bool { return left < right }
pub fn main() -> i32 {
  let narrowLow: u8 = 1
  let narrowHigh: u8 = 2
  let wideLow: i64 = 1
  let wideHigh: i64 = 2
  let narrow = less<u8>(&narrowLow, &narrowHigh)
  let wide = less<i64>(&wideLow, &wideHigh)
  if narrow { if wide { return 42 } }
  return 0
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const operations = Analysis.loweredMir(self).functions.flatMap(MirVerification.operations)
    const comparisons = operations.filter(
      (operation) => operation._tag === 'Binary' && operation.operator === 'LessThan',
    )
    // Two comparisons per width: the two instantiations lower to separate primitives rather than
    // sharing one dispatch through a provider.
    assert.strictEqual(comparisons.length, 4)
    assert.isFalse(
      operations.some((operation) =>
        ['Switch', 'Provide', 'ServiceCall', 'ServiceEffectConstruct'].includes(operation._tag),
      ),
    )
  }),
)
