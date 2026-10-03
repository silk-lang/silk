import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

/**
 * SERV-009 / EFF-004: provision applies to one Effect layer. An `effect fn` whose success value is
 * an Effect carrying a requirement row hands that inner Effect out of `run` unprovided; the caller
 * provides it separately. The inner `read()` therefore observes the provider given to it, never the
 * one given to the outer execution; the native corpus row `nested-effect-row-provide-each-layer`
 * pins that runtime result.
 */
const counter = `import silk.effect { Effect }
service Counter {
  effect fn get() -> i32 ? &Counter
}
struct Cell { n: i32 }
impl Cell {
  effect fn getImpl(self: &Self) -> i32 { return self.n }
}
impl Counter for Cell { get: Cell.getImpl }
effect fn read() -> i32 ? &Counter { return run Counter.get() }`

/** Providing the outer layer does not close the inner Effect's requirement row. */
const innerNotClosed = `${counter}
effect fn outer() -> Effect<'static; i32 ? &Counter> ? &Counter {
  return read()
}
pub fn main() -> i32 {
  let a = Cell { n: 1 }
  let inner = run Effect.provide<Counter>(outer(), &a)
  return run inner
}`

it.effect('reports SEM0071 when only the outer layer is provided', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'effect-typing/inner-not-closed',
      ascii(innerNotClosed),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0071'],
    )
  }),
)
