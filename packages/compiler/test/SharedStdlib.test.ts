import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ExecutionAffinity from '../src/ExecutionAffinity.js'
import * as Intrinsic from '../src/Intrinsic.js'
import * as LocalSharedOwnership from '../src/LocalSharedOwnership.js'
import * as Type from '../src/Type.js'
import { ordinaryStorageSource } from './support/ordinaryStorageSource.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(ordinaryStorageSource(value), (character) => character.charCodeAt(0))

const mixedAllocatorConstruction = `import silk.allocator { Allocator }
import silk.allocator { Allocator, OutOfMemoryError, SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.shared { Shared }
struct BadAllocator {}
effect fn badAllocate(self: &mut BadAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  drop layout
  let wrong = Layout.of<u8>()
  return run Intrinsic.systemAllocationAcquire(move wrong)
}
impl Allocator for BadAllocator { allocate: BadAllocator.badAllocate }
effect fn good() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let shared = run (Shared.make<i32>(41)
    |> Effect.provideMut<Allocator>(&mut allocator))
  drop shared
  return 1
}
effect fn bad() -> i32 ! OutOfMemoryError {
  let mut allocator = BadAllocator {}
  let shared = run (Shared.make<i32>(42)
    |> Effect.provideMut<Allocator>(&mut allocator))
  drop shared
  return 1
}
effect fn both() -> i32 ! OutOfMemoryError {
  let first = run good()
  let second = run bad()
  return first + second
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(both(), recover) }`

const unrelatedCallbackShape = `import silk.shared { Shared }
struct Box { value: i32 }
fn delayed(value: &Box) -> Effect<i32> { return effect { return value.value } }
fn unrelated(
  shared: &Shared<Box>,
  callback: once fn(&Box) -> Effect<i32>,
) -> Effect<i32> {
  return effect { return 0 }
}
fn probe(shared: &Shared<Box>) -> Effect<i32> {
  return unrelated(shared, delayed)
}
pub fn main() -> i32 { return 0 }`

const renamedMultiCallbackBoundary = `struct Other<T> { core: Intrinsic.SharedCore<T> }
struct Box { value: i32 }
fn ignored(value: &mut Box) -> i32 { return 0 }
effect fn read(value: &mut Box) -> i32 { return value.value }
fn escaping(value: &mut Box) -> i32 { return run read(move value) }
fn conflict() -> i32 { return 0 }
fn access(
  self: &Other<Box>,
  unused: once fn(&mut Box) -> i32,
  use: once fn(&mut Box) -> i32,
) -> i32 {
  drop unused
  return Intrinsic.sharedWithMut<Box, i32>(&self.core, move use, conflict)
}
fn probe(self: &Other<Box>) -> i32 {
  return access(self, ignored, escaping)
}
pub fn main() -> i32 { return 0 }`

const publicEscapeMatrix = `import silk.result { Result }
import silk.shared { Shared }
struct Pair { first: i32 second: i32 }
struct Box<A> { value: A }
fn direct(value: &Pair) -> &Pair { return value }
fn directMut(value: &mut Pair) -> &mut Pair { return move value }
fn narrowedMut(value: &mut Pair) -> &Pair { return move value }
fn generic<A>(value: A) -> A { return move value }
fn viaGeneric(value: &Pair) -> &Pair { return generic<&Pair>(move value) }
fn viaGenericMut(value: &mut Pair) -> &mut Pair { return generic<&mut Pair>(move value) }
fn aggregate(value: &Pair) -> Box<&Pair> { return Box<&Pair> { value: move value } }
fn aggregateMut(value: &mut Pair) -> Box<&mut Pair> {
  return Box<&mut Pair> { value: move value }
}
fn failed(value: &Pair) -> Result<i32, &Pair> {
  return Result.failResult<i32, &Pair>(move value)
}
fn failedMut(value: &mut Pair) -> Result<i32, &mut Pair> {
  return Result.failResult<i32, &mut Pair>(move value)
}
fn delayed(value: &Pair) -> Effect<i32> { return effect { return value.first } }
fn delayedMut(value: &mut Pair) -> Effect<i32> { return effect { return value.first } }
fn readStored(input: i32, value: &Pair) -> i32 { return input + value.first }
fn stored(value: &Pair) -> once fn(i32) -> i32 { return readStored(move value) }
fn storedMut(value: &mut Pair) -> once fn(i32) -> i32 { return readStored(move value) }
effect fn read(value: &Pair) -> i32 { return value.first }
effect fn readMut(value: &mut Pair) -> i32 { return value.first }
fn suspended(value: &Pair) -> i32 { return run read(value) }
fn suspendedMut(value: &mut Pair) -> i32 { return run readMut(move value) }
unsafe fn sharedDirect(self: &Shared<Pair>) -> &Pair {
  return Shared.with<Pair, &Pair>(self, direct)
}
unsafe fn mutDirect(self: &Shared<Pair>) -> &mut Pair {
  return Shared.withMut(self, directMut)
}
unsafe fn mutNarrowed(self: &Shared<Pair>) -> &Pair {
  return Shared.withMut(self, narrowedMut)
}
unsafe fn sharedGeneric(self: &Shared<Pair>) -> &Pair {
  return Shared.with(self, viaGeneric)
}
unsafe fn mutGeneric(self: &Shared<Pair>) -> &mut Pair {
  return Shared.withMut(self, viaGenericMut)
}
unsafe fn sharedAggregate(self: &Shared<Pair>) -> Box<&Pair> {
  return Shared.with(self, aggregate)
}
unsafe fn mutAggregate(self: &Shared<Pair>) -> Box<&mut Pair> {
  return Shared.withMut(self, aggregateMut)
}
fn sharedFailure(self: &Shared<Pair>) -> Result<i32, &Pair> {
  return Shared.with(self, failed)
}
fn mutFailure(self: &Shared<Pair>) -> Result<i32, &mut Pair> {
  return Shared.withMut(self, failedMut)
}
fn sharedEffect(self: &Shared<Pair>) -> Effect<i32> {
  return Shared.with(self, delayed)
}
fn mutEffect(self: &Shared<Pair>) -> Effect<i32> {
  return Shared.withMut(self, delayedMut)
}
fn sharedCallable(self: &Shared<Pair>) -> once fn(i32) -> i32 {
  return Shared.with(self, stored)
}
fn mutCallable(self: &Shared<Pair>) -> once fn(i32) -> i32 {
  return Shared.withMut(self, storedMut)
}
fn sharedSuspension(self: &Shared<Pair>) -> i32 {
  return Shared.with(self, suspended)
}
fn mutSuspension(self: &Shared<Pair>) -> i32 {
  return Shared.withMut(self, suspendedMut)
}
pub fn main() -> i32 { return 0 }`

it.effect('derives affine local ownership through the ordinary Shared wrapper', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'shared-stdlib/facts',
      ascii(`import silk.shared { Shared }
struct Holder<T> { value: Shared<T> }
fn retain(value: Shared<i32>) -> i32 {
  let pending = effect { drop move value return 42 }
  drop pending
  return 42
}
pub fn main() -> i32 { return 42 }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const shared = Type.nominal('silk/shared', 'Shared', ['i32'])
    const holder = Type.nominal('shared-stdlib/facts', 'Holder', ['i32'])
    assert.strictEqual(ExecutionAffinity.ofType(snapshot.index, shared)._tag, 'LocalExecution')
    assert.strictEqual(ExecutionAffinity.ofType(snapshot.index, holder)._tag, 'LocalExecution')
    assert.strictEqual(
      LocalSharedOwnership.count(LocalSharedOwnership.ofType(snapshot.index, shared)),
      1,
    )
    assert.isFalse(Type.isSharedCore(shared))
    const ownership = snapshot.ownership.get('shared-stdlib/facts')
    const retain = ownership?.functions.find(
      (fn) => fn.declaration.name._tag === 'Present' && fn.declaration.name.spelling === 'retain',
    )
    const pending = retain?.bindings.find((binding) => binding.name === 'pending')
    assert.strictEqual(pending?.executionAffinity._tag, 'LocalExecution')
    assert.strictEqual(
      LocalSharedOwnership.count(pending?.localSharedObligations ?? LocalSharedOwnership.none),
      1,
    )
  }),
)

it.effect(
  'rejects a forged allocator even when another caller proves the same make specialization',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'shared-stdlib/mixed-allocators',
        ascii(mixedAllocatorConstruction),
        'wasm32-unknown-unknown',
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        ['SEM0138'],
      )
    }),
)

it.effect(
  'proves an ordinary allocator that reconstructs the measured request through fields',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'shared-stdlib/reconstructed-provider',
        ascii(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.shared { Shared }
struct Parts { requestedAlignment: usize requestedBytes: usize }
struct ReconstructingAllocator {}
fn rebuild(parts: Parts) -> Layout {
  return Layout {alignment: parts.requestedAlignment, bytes: parts.requestedBytes}
}
effect fn allocate(self: &mut ReconstructingAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  let parts = Parts {requestedBytes: layout.bytes, requestedAlignment: layout.alignment}
  return run Intrinsic.systemAllocationAcquire(rebuild(move parts))
}
impl Allocator for ReconstructingAllocator { allocate: ReconstructingAllocator.allocate }
effect fn construct() -> i32 ! OutOfMemoryError {
  let mut allocator = ReconstructingAllocator {}
  let shared = run (Shared.make<i32>(42) |> Effect.provideMut<Allocator>(&mut allocator))
  drop shared
  let mut standard = Allocator.systemAllocatorProvider()
  let sibling = run (Shared.make<i32>(43) |> Effect.provideMut<Allocator>(&mut standard))
  drop sibling
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`),
        'wasm32-unknown-unknown',
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      assert.strictEqual(snapshot.layout._tag, 'Available')
      if (snapshot.layout._tag === 'Available')
        assert.isNotEmpty(snapshot.layout.value.localSharedAllocationProvenance.facts)
    }),
)

it.effect('does not infer access-boundary privilege from an unrelated wrapper shape', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'shared-stdlib/unrelated-shape',
      ascii(unrelatedCallbackShape),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it.effect('propagates the sealed access edge through a renamed multi-callback wrapper', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'shared-stdlib/renamed-multi-callback',
      ascii(renamedMultiCallbackBoundary),
      'wasm32-unknown-unknown',
    )
    const diagnostics = Analysis.diagnostics(snapshot).filter(
      (diagnostic) => diagnostic.code === 'OWN0016',
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => ({
        code: diagnostic.code,
        span: renamedMultiCallbackBoundary.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [{ code: 'OWN0016', span: 'run read(move value)' }],
    )
    assert.strictEqual(diagnostics.length, 1)
    assert.strictEqual(diagnostics.at(0)?.span.sourceId, 'shared-stdlib/renamed-multi-callback')
    assert.strictEqual(diagnostics.at(0)?.relatedSpans?.length, 1)
    assert.strictEqual(
      diagnostics.at(0)?.relatedSpans?.at(0)?.span.sourceId,
      'shared-stdlib/renamed-multi-callback',
    )
  }),
)

it.effect(
  'rejects dependent callback results and suspended borrows through both public access operations',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'shared-stdlib/public-escape',
        ascii(publicEscapeMatrix),
        'wasm32-unknown-unknown',
      )
      const diagnostics = Analysis.diagnostics(snapshot).filter(
        (diagnostic) => diagnostic.code === 'OWN0016',
      )
      // The callback's universally quantified input cannot determine the caller's result
      // lifetime. Those signatures reject before access analysis; suspension still reaches it.
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => [
          diagnostic.code,
          publicEscapeMatrix.slice(diagnostic.span.start, diagnostic.span.end).trim(),
        ]),
        [
          ['OWN0016', 'run read(value)'],
          ['OWN0016', 'run readMut(move value)'],
          ['SEM0076', 'direct'],
          ['SEM0052', 'Shared.withMut(self, directMut)'],
          ['SEM0052', 'Shared.withMut(self, narrowedMut)'],
          ['SEM0052', 'Shared.with(self, viaGeneric)'],
          ['SEM0052', 'Shared.withMut(self, viaGenericMut)'],
          ['SEM0052', 'Shared.with(self, aggregate)'],
          ['SEM0052', 'Shared.withMut(self, aggregateMut)'],
          ['SEM0052', 'Shared.with(self, failed)'],
          ['SEM0052', 'Shared.withMut(self, failedMut)'],
          ['SEM0052', 'Shared.with(self, delayed)'],
          ['SEM0052', 'Shared.withMut(self, delayedMut)'],
          ['SEM0052', 'Shared.with(self, stored)'],
          ['SEM0052', 'Shared.withMut(self, storedMut)'],
        ],
      )
      assert.deepEqual(
        diagnostics.map((diagnostic) =>
          diagnostic.reason._tag === 'LocalSharedAccessEscape'
            ? diagnostic.reason.kind
            : diagnostic.reason._tag,
        ),
        ['Suspension', 'Suspension'],
      )
      for (const diagnostic of diagnostics) {
        assert.strictEqual(diagnostic.span.sourceId, 'shared-stdlib/public-escape')
        assert.strictEqual(diagnostic.relatedSpans?.length, 1)
        assert.strictEqual(
          diagnostic.relatedSpans?.at(0)?.span.sourceId,
          'shared-stdlib/public-escape',
        )
      }
      assert.strictEqual(snapshot.mir._tag, 'Unavailable')
    }),
)

it('maps every sealed local-shared primitive to the ordinary Shared consumer that actually calls it', () => {
  assert.deepEqual(
    Intrinsic.inventory()
      .filter((entry) => entry.operation.startsWith('Intrinsic.shared'))
      .map((entry) => [entry.operation, entry.consumer]),
    [
      ['Intrinsic.sharedLayout', 'silk/shared.make'],
      ['Intrinsic.sharedFromAllocation', 'silk/shared.make'],
      ['Intrinsic.sharedClone', 'silk/shared.clone'],
      ['Intrinsic.sharedWithMut', 'silk/shared.withMut'],
    ],
  )
})
