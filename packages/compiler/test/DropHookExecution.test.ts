import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Type from '../src/Type.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

/** One parametric conformance serves two instantiations, each with its own hook instance. */
const parametric = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
struct Guard<T> {
  value: T
  storage: Allocation
}

impl<T> Drop for Guard<T> {
  fn drop(self: &mut Guard<T>) -> () { return () }
}

effect<'env> fn hold<T: 'env, 'env>(value: T) -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  let guard = Guard<T> { value: move value, storage: move allocation }
  return 21
}

effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }

pub fn main() -> i32 {
  let first = run Effect.catchAll(hold<i32>(1), recover)
  let second = run Effect.catchAll(hold<bool>(true), recover)
  return first + second
}`

/** A parametric Drop over a struct that is all-Copy at some instantiation. */
const copyInstantiation = `struct Holder<T> {
  value: T
}

impl<T: Copy> Copy for Holder<T> {}

impl<T> Drop for Holder<T> {
  fn drop(self: &mut Holder<T>) -> () { return () }
}

fn keep<T>(value: T) -> i32 {
  let held = Holder<T> { value: move value }
  return 1
}

pub fn main() -> i32 { return keep<i32>(41) + 1 }`

it.effect('rejects conflicting parametric Copy and Drop declarations', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'drop-hook/copy-instantiation',
      ascii(copyInstantiation),
      'wasm32-unknown-unknown',
    )
    assert.include(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'SEM0083',
    )
  }),
)

it.effect('monomorphizes one parametric Drop conformance per reachable instantiation', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'drop-hook/parametric',
      ascii(parametric),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const instances = Analysis.instancesOf(snapshot).instances.filter((instance) =>
      instance.key.declaration.name.startsWith('drop@impl'),
    )
    assert.strictEqual(instances.length, 2)
    assert.deepEqual(
      instances
        .map((instance) => instance.key.typeArguments)
        .sort((left, right) =>
          left
            .map(Type.encodeGenericArgument)
            .join(',')
            .localeCompare(right.map(Type.encodeGenericArgument).join(',')),
        ),
      [['bool'], ['i32']],
    )
  }),
)
