import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'

const encoder = new TextEncoder()

const snapshot = (source: string) =>
  AnalysisFixture.retainingMain('numeric-interface/main', encoder.encode(source))

it.effect('rejects a type without the static Add conformance', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.numeric { Numeric }
pub fn main() -> bool {
  return Numeric.add(true, false)
}`)
    assert.isTrue(
      Analysis.diagnostics(self).some((diagnostic) =>
        diagnostic.message.includes('bool does not implement Add'),
      ),
    )
  }),
)
