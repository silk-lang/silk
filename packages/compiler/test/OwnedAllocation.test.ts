import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CleanupPlan from '../src/CleanupPlan.js'
import * as MirVerification from '../src/MirVerification.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

it.effect(
  'preserves slot storage lifetimes across ordinary functions and invariant payload writes',
  () =>
    Effect.gen(function* () {
      const source = `import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
fn select<'a, T>(buffer: &'a mut Intrinsic.RawBuffer<T>) -> Intrinsic.Slot<'a, T> { return RawBuffer.slot<T>(move buffer, 0) }
fn take<'a, T>(slot: Intrinsic.Slot<'a, T>) -> T { return unsafe Slot.take<T>(move slot) }
fn invalid<'a>(allocation: Intrinsic.Allocation) -> Intrinsic.Slot<'a, i32> {
  let mut buffer = unsafe RawBuffer.from<i32>(move allocation, 1)
  return select(&mut buffer)
}
fn smuggle<'long, 'short>(slot: Intrinsic.Slot<'short, &'long i32>, value: &'short i32) -> () {
  return Slot.write<&'long i32>(move slot, value)
}`
      const self = yield* Analysis.ofSource('allocation/slot-lifetimes', ascii(source))
      const diagnostics = Analysis.diagnostics(self)
      assert.isFalse(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.span.sourceId === 'allocation/slot-lifetimes' &&
            diagnostic.span.start < source.indexOf('fn invalid'),
        ),
      )
      assert.isTrue(
        diagnostics.some(
          (diagnostic) => diagnostic.code === 'OWN0019' || diagnostic.code === 'SEM0212',
        ),
      )
      assert.isTrue(
        diagnostics.some(
          (diagnostic) =>
            diagnostic.span.start >= source.indexOf('fn smuggle') && diagnostic.code === 'SEM0100',
        ),
      )
    }),
)
it.effect('requires an unsafe boundary for each caller-precondition storage operation', () =>
  Effect.gen(function* () {
    const source = `import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
fn read(buffer: &Intrinsic.RawBuffer<u8>) -> u8 { return RawBuffer.read<u8>(buffer, 0) }
fn take(buffer: &mut Intrinsic.RawBuffer<u8>) -> u8 {
  return Slot.take<u8>(RawBuffer.slot<u8>(&mut buffer.*, 0))
}
fn acknowledged(buffer: &mut Intrinsic.RawBuffer<u8>) -> u8 {
  RawBuffer.fill(&mut buffer.*, 0, 1, 7)
  return unsafe RawBuffer.read<u8>(&buffer.*, 0)
}`
    const self = yield* Analysis.ofSource('allocation/unsafe-storage', ascii(source))
    const missing = Analysis.diagnostics(self)
      .filter((diagnostic) => diagnostic.span.sourceId === 'allocation/unsafe-storage')
      .map((diagnostic) => [diagnostic.code, diagnostic.span.start])
    assert.deepStrictEqual(missing, [
      ['SEM0082', source.indexOf('RawBuffer.read')],
      ['SEM0082', source.indexOf('Slot.take')],
    ])
  }),
)
const sharedReadSource = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let allocation = run Allocator.allocate(Layout.of<[i32; 1]>())
    |> Effect.provideMut(&mut allocator)
  unsafe {
    let mut buffer = RawBuffer.from<i32>(move allocation, 1)
    let written = Slot.write(RawBuffer.slot(&mut buffer, 0), 21)
    let first = RawBuffer.read<i32>(&buffer, 0)
    let second = RawBuffer.read<i32>(&buffer, 0)
    let taken = Slot.take(RawBuffer.slot(&mut buffer, 0))
    drop buffer
    return first + second + taken
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`

const nonCopyReadSource = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
struct Guard { storage: Intrinsic.Allocation }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[Guard; 1]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  let innerLayout = Layout.of<[i32; 1]>()
  let innerRecipe = Allocator.allocate(move innerLayout) |> Effect.provideMut(&mut allocator)
  let payload = run innerRecipe
  unsafe {
    let mut buffer = RawBuffer.from<Guard>(move allocation, 1)
    let element = Guard { storage: move payload }
    let written = Slot.write(RawBuffer.slot(&mut buffer, 0), move element)
    let copied = RawBuffer.read<Guard>(&buffer, 0)
    let taken = Slot.take(RawBuffer.slot(&mut buffer, 0))
    drop copied
    drop taken
    drop buffer
    return 42
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`

const moveOnlyUnionReadSource = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
struct Guard { storage: Intrinsic.Allocation }
struct Marker { value: i32 }

fn guarded(storage: Intrinsic.Allocation) -> Guard | Marker {
  return Guard { storage: move storage }
}

effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[Guard | Marker; 1]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  let innerLayout = Layout.of<[i32; 1]>()
  let innerRecipe = Allocator.allocate(move innerLayout) |> Effect.provideMut(&mut allocator)
  let payload = run innerRecipe
  unsafe {
    let mut buffer = RawBuffer.from<Guard | Marker>(move allocation, 1)
    let event = guarded(move payload)
    let written = Slot.write<Guard | Marker>(RawBuffer.slot(&mut buffer, 0), move event)
    let copied = RawBuffer.read<Guard | Marker>(&buffer, 0)
    let taken = Slot.take(RawBuffer.slot(&mut buffer, 0))
    drop copied
    drop taken
    drop buffer
    return 42
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`

const unsafeProgram = (
  body: string,
  layout = '[i32; 2]',
): string => `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<${layout}>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  unsafe {
    let mut buffer = RawBuffer.from<i32>(move allocation, 2)
${body}
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 {
  return run Effect.catchAll(store(), recover)
}`

it.effect('plans reclaim after repeated shared Copy reads', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'owned-allocation/shared-read',
      ascii(sharedReadSource),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const mir = Analysis.loweredMir(snapshot)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const operations = mir.functions.flatMap(MirVerification.operations)
    assert.strictEqual(
      operations.filter((operation) => operation._tag === 'RawBufferRead').length,
      1,
    )
    assert.isTrue(
      operations.some(
        (operation) => operation._tag === 'Drop' && CleanupPlan.reclaims(operation.cleanup),
      ),
    )
  }),
)

it.effect('rejects shared RawBuffer reads of move-only nominal and union elements', () =>
  Effect.gen(function* () {
    for (const [name, source] of [
      ['move-only', nonCopyReadSource],
      ['move-only-union', moveOnlyUnionReadSource],
    ] as const) {
      const snapshot = yield* AnalysisFixture.retainingMain(
        `owned-allocation/read-${name}`,
        ascii(source),
      )
      assert.include(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        'SEM0083',
      )
    }
  }),
)

it.effect('requires shared rather than exclusive access for RawBuffer.read', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'owned-allocation/read-exclusive',
      ascii(unsafeProgram('    return RawBuffer.read<i32>(&mut buffer, 0)')),
    )
    assert.include(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'SEM0056',
    )
  }),
)
