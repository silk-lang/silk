import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as MirVerification from '../src/MirVerification.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

it.effect(
  'retains external lifetimes through borrowed Vector insertion and ordinary extraction',
  () =>
    Effect.gen(function* () {
      const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.vector { Vector }
struct Entry<'a> { value: &'a mut i32 }
impl<'a> Drop for Entry<'a> { fn drop(self: &mut Entry<'a>) -> () { return () } }
effect fn shared<'a>(value: &'a i32) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut values = Vector<&'a i32>.make()
  run Vector<&'a i32>.append(&mut values, value)
  run Vector<&'a i32>.insert(&mut values, 0, value)
  let old = Vector<&'a i32>.set(&mut values, 0, value)
  let saved = Vector<&'a i32>.remove(&mut values, 0)
  drop values
  return saved.*
}
effect fn exclusive<'a>(value: &'a mut i32) -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut values = Vector<Entry<'a>>.make()
  run Vector<Entry<'a>>.append(&mut values, Entry { value: move value })
  let saved = Vector<Entry<'a>>.remove(&mut values, 0)
  drop values
  return saved.value.*
}
effect fn invalidExtracted() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut source = 1 let mut values = Vector<&i32>.make()
  run Vector<&i32>.append(&mut values, &source)
  let saved = Vector<&i32>.remove(&mut values, 0) drop values
  source = 2 return saved.*
}
effect fn invalidCleanup() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let mut source = 1 let mut values = Vector<Entry>.make()
  run Vector<Entry>.append(&mut values, Entry { value: &mut source })
  source = 2 return 0
}`
      const self = yield* Analysis.ofSource('vector-acceptance/dependent-elements', ascii(source))
      const diagnostics = Analysis.diagnostics(self)
      assert.isFalse(
        diagnostics.some(
          (diagnostic) => diagnostic.span.start < source.indexOf('effect fn invalidExtracted'),
        ),
      )
      for (const name of ['invalidExtracted', 'invalidCleanup']) {
        const start = source.indexOf('source = 2', source.indexOf(`effect fn ${name}`))
        assert.isTrue(
          diagnostics.some(
            (diagnostic) =>
              diagnostic.code === 'OWN0011' &&
              diagnostic.span.start >= source.indexOf(`effect fn ${name}`) &&
              diagnostic.span.end <= start + 'source = 2'.length,
          ),
        )
      }
    }),
)

it.effect('rejects a shared vector read when one union member is move-only', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.vector { Vector }
struct Guard { storage: Allocation }
struct Marker { value: i32 }
fn guarded(storage: Allocation) -> Guard | Marker { return Guard { storage: move storage } }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 1]>()
  let allocation = run Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let mut events = Vector<Guard | Marker>.make()
  let event = guarded(move allocation)
  let appended = run Vector<Guard | Marker>.append(&mut events, move event) |>
    Effect.provideMut(&mut allocator)
  let observed = Vector<Guard | Marker>.get(&events, 0)
  drop observed
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'vector-acceptance/move-only-union-read',
      ascii(source),
    )
    assert.include(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'SEM0083',
    )
  }),
)

it.effect('lowers element cleanup before vector backing-storage cleanup', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'vector-acceptance/drop-order',
      ascii(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.vector { Vector }
struct Entry { value: i32 }
impl Drop for Entry { fn drop(self: &mut Entry) -> () { return () } }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut values = Vector<Entry>.make()
  run Vector<Entry>.append(&mut values, Entry { value: 42 })
    |> Effect.provideMut(&mut allocator)
  drop values
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const releaseBuffer = Analysis.loweredMir(snapshot).functions.find(
      (fn) => fn.id.module === 'silk/vector' && fn.id.name === 'releaseBuffer',
    )
    if (releaseBuffer === undefined) return assert.fail('expected Vector.releaseBuffer MIR')
    const operations = MirVerification.operations(releaseBuffer)
    const elementDrop = operations.findIndex(
      (operation) =>
        operation._tag === 'Call' &&
        operation.target.module === 'silk/slot' &&
        operation.target.name === 'Slot.dropValue',
    )
    const storageDrop = operations.findIndex(
      (operation) => operation._tag === 'Drop' && operation.cleanup._tag === 'RawBufferCleanup',
    )
    assert.isAtLeast(elementDrop, 0)
    assert.isAbove(storageDrop, elementDrop)
  }),
)

it.effect('releases sort scratch while returning the initialized element storage', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'vector-acceptance/sort-scratch-cleanup',
      ascii(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.vector { Vector }
effect fn build() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut values = Vector<i32>.make()
  run Vector<i32>.append(&mut values, 2) |> Effect.provideMut(&mut allocator)
  run Vector<i32>.append(&mut values, 1) |> Effect.provideMut(&mut allocator)
  run Vector<i32>.sort(&mut values) |> Effect.provideMut(&mut allocator)
  return Vector<i32>.get(&values, 0) + Vector<i32>.get(&values, 1)
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const releaseScratch = mir.functions.find(
      (fn) => fn.id.module === 'silk/vector' && fn.id.name === 'releaseScratch',
    )
    if (releaseScratch === undefined) return assert.fail('expected Vector.releaseScratch MIR')

    const operations = MirVerification.operations(releaseScratch)
    const moves = operations.filter((operation) => operation._tag === 'Move')
    const releases = operations.filter((operation) => operation._tag === 'Drop')
    assert.strictEqual(releaseScratch.parameterCount, 2)
    assert.lengthOf(moves, 1)
    assert.strictEqual(moves[0]?.source.ordinal, 1)
    assert.strictEqual(moves[0]?.destination.ordinal, 2)
    assert.strictEqual(releases.length, 1)
    assert.strictEqual(releases[0]?.local.ordinal, 2)
    assert.strictEqual(releases[0]?.cleanup._tag, 'RawBufferCleanup')
    const returns = releaseScratch.regions.flatMap((region) =>
      'outcome' in region && region.outcome._tag === 'Return' ? [region.outcome.value] : [],
    )
    assert.lengthOf(returns, 1)
    assert.strictEqual(returns[0]?.ordinal, 0)
  }),
)
