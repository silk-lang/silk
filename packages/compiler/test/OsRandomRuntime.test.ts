import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Target from '../src/Target.js'
import * as Stdlib from '../src/Stdlib.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()
const nativeSource = `import silk.os_random { OsRandom }
import silk.random { Random }
import silk.effect { Effect }
import silk.u8
pub fn main() -> i32 {
  let mut provider = OsRandom.make()
  let mut bytes = [u8.toU8(9)]
  run Random.fillBytes(&mut bytes) |> Effect.provideMut<Random>(&mut provider)
  return 42
}`

it.effect('selects only the ordinary platform entropy imports with no OS operation', () =>
  Effect.gen(function* () {
    for (const target of Target.native) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'entropy/main',
        encoder.encode(nativeSource),
        target.id,
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
      assert.deepEqual(
        snapshot.instances.foreignCalls.map((call) => call.symbol),
        target.id.includes('apple') ? ['arc4random_buf'] : ['__errno_location', 'getrandom'],
      )
    }
  }),
)

it.effect('rejects reached native entropy construction in Wasm and no-libc selections', () =>
  Effect.gen(function* () {
    const source = `import silk.os_random { OsRandom }
pub fn main() -> i32 { let provider = OsRandom.make() return 42 }`
    const module = Stdlib.find('silk/os_random') ?? unreachable('expected entropy source')
    const text = new TextDecoder().decode(module.bytes)
    const start = text.indexOf('compileError("') + 'compileError("'.length
    const end = text.indexOf('"', start)
    for (const target of Target.all) {
      const snapshot = yield* Analysis.makeRealized({
        root: 'entropy/unavailable',
        configuration: {
          ...AnalysisFixture.configuration('entropy/unavailable', target.id),
          profile: {
            target: target.id,
            artifact: 'object',
            libc: 'none',
            runtime: { kind: 'none' },
            entry: { kind: 'none' },
          },
        },
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([
            SourceFile.make('entropy/unavailable', encoder.encode(source)),
          ]).pipe(Layer.provideMerge(SourceResolver.empty)),
        ),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => [
          diagnostic.code,
          diagnostic.span.sourceId,
          diagnostic.span.start,
          diagnostic.span.end,
        ]),
        [['SEM0177', module.module, start, end]],
      )
      assert.deepEqual(snapshot.instances.foreignCalls, [])
    }
  }),
)

it.effect('keeps portable secure-byte replacement free of native entropy imports', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'entropy/portable',
      encoder.encode(`import silk.os_random { OsRandom }
import silk.random { Random }
import silk.effect { Effect }
import silk.u8
struct Scripted {}
impl Random for Scripted {
  effect fn fillBytes(self: &mut Self, output: &mut [u8]) -> () {
    let mut index: usize = 0
    while index < output.length { output[index] = u8.toU8(42) index = index + 1 }
    return ()
  }
}
pub fn main() -> i32 {
  let mut provider = Scripted {}
  let mut bytes = [u8.toU8(9)]
  run Random.fillBytes(&mut bytes) |> Effect.provideMut<Random>(&mut provider)
  return u8.toI32(bytes[0])
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const artifact = yield* Analysis.codegen(snapshot, { mode: 'release' })
    assert.deepEqual(artifact.foreignImports, [])
    assert.deepEqual(artifact.nativeRuntimeSymbols, [])
  }),
)
