import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Stdlib from '../src/Stdlib.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const decoder = new TextDecoder()

/**
 * Modules that used to copy a private `counted` identity to type their own literals and still count
 * with typed literals. `silk/bytes` no longer counts at all.
 */
const previousHolders = [
  'silk/vector',
  'silk/string',
  'silk/filesystem',
  'silk/os_filesystem',
] as const

const sourceText = (module: string): string => {
  const bytes = Stdlib.sources.get(module)
  assert.isDefined(bytes, module)
  return decoder.decode(bytes)
}

/**
 * `silk/usize` owns the shared typed zero and one, so no module has to reintroduce an identity
 * call to keep a bare count off the `i32` default.
 */
it('declares the shared usize counts once and ships no private counted identity', () => {
  for (const entry of Stdlib.manifest)
    assert.notMatch(
      sourceText(entry.module),
      /\bfn\s+counted\b/,
      `${entry.module} still declares a counted identity`,
    )

  const usize = sourceText('silk/usize')
  assert.include(usize, 'pub const ZERO: usize = 0')
  assert.include(usize, 'pub const ONE: usize = 1')

  for (const module of previousHolders)
    assert.match(
      sourceText(module),
      /\busize\.(ZERO|ONE)\b/,
      `${module} names no shared typed count`,
    )
})

const growth = `import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.effect { Effect }
import silk.vector { Vector }

effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut values = Vector<i32>.make()
  run Vector<i32>.append(&mut values, 10) |> Effect.provideMut(&mut allocator)
  run Vector<i32>.append(&mut values, 32) |> Effect.provideMut(&mut allocator)
  return Vector<i32>.get(&values, 0) + Vector<i32>.get(&values, 1)
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`

it.effect('lowers shared typed counts directly without an identity call', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'typed-count-acceptance/growth',
      ascii(growth),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(
      mir.functions.filter((fn) => fn.id.name === 'counted').map((fn) => fn.id.module),
      [],
    )
    assert.isFalse(
      mir.functions.some((fn) =>
        MirVerification.operations(fn).some(
          (operation) => operation._tag === 'Call' && operation.target.name === 'counted',
        ),
      ),
    )
    const made = mir.functions.find(
      (fn) => fn.id.module === 'silk/vector' && fn.id.name === 'Vector.make',
    )
    assert.isDefined(made)
    if (made === undefined) return
    assert.deepEqual(
      MirVerification.operations(made).map((operation) => operation._tag),
      ['ConstructArray', 'Construct', 'ConvertUnion', 'Literal', 'Literal', 'Construct'],
    )
    assert.deepEqual(
      MirVerification.operations(made).flatMap((operation) =>
        operation._tag === 'Literal'
          ? [`${operation.value.toString()} : ${operation.type._tag}`]
          : [],
      ),
      ['0 : usize', '0 : usize'],
    )
  }),
)
