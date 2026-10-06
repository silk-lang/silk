import * as Layer from 'effect/Layer'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as Tir from '../src/Tir.js'
import * as Lifetime from '../src/Lifetime.js'
import * as CleanupPlan from '../src/CleanupPlan.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Mir from '../src/Mir.js'
import * as Ownership from '../src/Ownership.js'
import * as Type from '../src/Type.js'
import { ordinaryStorageSource } from './support/ordinaryStorageSource.js'
import { independentExecutionFinalizedDestroy } from './support/corpus.js'

it.effect(
  'refuses invalid allocation requests before malloc and retains the nullable cleanup path',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'allocation/preflight',
        ascii(
          `import silk.effect { Effect }
import silk.usize
effect fn acquire(bytes: usize, alignment: usize) -> i32 ! OutOfMemoryError {
  let allocation = run Intrinsic.systemAllocationAcquire(Layout { bytes: bytes, alignment: alignment })
  drop allocation
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 7 }
export "C" fn main(bytes: usize, alignment: usize) -> i32 {
  return run Effect.catchAll(acquire(bytes, alignment), recover)
}`,
        ),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        [],
      )
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
      const artifact = yield* Analysis.codegen(snapshot, { mode: 'release', verifyIr: true })
      assert.match(artifact.ir, /allocation\d+_nonzero_alignment[^]*?icmp ne i64[^]*?br i1/)
      assert.match(artifact.ir, /allocation\d+_alignment_remainder[^]*?and i64[^]*?icmp eq i64/)
      assert.match(artifact.ir, /allocation\d+_aligned[^]*?llvm.uadd.with.overflow.i64/)
      assert.match(
        artifact.ir,
        /allocation\d+_overflowed[^]*?br i1[^]*?allocation\d+_failure[^]*?allocation\d+_request/,
      )
      assert.match(artifact.ir, /allocation\d+_request[^]*?call ptr @malloc/)
      assert.match(
        artifact.ir,
        /allocation\d+_missing[^]*?call void @free\(ptr[^]*?br label %allocation\d+_failure/,
      )
    }),
)

it.effect(
  'proves allocation through directly forwarded Effects without an executable startup root',
  () =>
    Effect.gen(function* () {
      const module = 'allocation/finalized-export'
      const source = independentExecutionFinalizedDestroy.replace(
        'pub fn main()',
        'export "C" fn lifecycle()',
      )
      const snapshot = yield* Analysis.makeRealized({
        root: module,
        configuration: AnalysisFixture.configuration(module, 'wasm32-unknown-unknown', []),
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(module, ascii(source))]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        [],
      )
      const mir = Analysis.loweredMir(snapshot)
      assert.deepEqual(yield* MirVerification.verify(mir), [])
      const finalizers = mir.functions.flatMap((fn) =>
        (fn.suspension?.frame?.states ?? [])
          .flatMap((state) => state.slots)
          .filter(
            (slot) =>
              slot.type._tag === 'EffectValue' &&
              slot.type.environment.instance.declaration.name === 'finalizer',
          ),
      )
      assert.isNotEmpty(finalizers)
      for (const slot of finalizers) {
        assert.strictEqual(slot.access._tag, 'AffineTransfer')
        if (slot.access._tag !== 'AffineTransfer') continue
        assert.strictEqual(slot.access.cleanup._tag, 'EffectCleanup')
        assert.isTrue(CleanupPlan.reclaims(slot.access.cleanup))
      }
    }),
)

it.effect('rejects a callback-dependent Effect environment at a local-shared boundary', () =>
  Effect.gen(function* () {
    const source = ascii(`struct Pair { first: i32 second: i32 }
fn deferred<'a>(value: &'a mut Pair) -> Effect<'a; i32> {
  return effect { return value.first }
}
fn fallback() -> Effect<'static; i32> { return effect { return 0 } }
unsafe fn construct<'scope>(core: &'scope Intrinsic.SharedCore<Pair>) -> () {
  let escaped = Intrinsic.sharedWithMut<Pair, Effect<'scope; i32>>(core, deferred, fallback)
  drop escaped
  return ()
}
pub fn main() -> i32 { return 0 }`)
    const snapshot = yield* Analysis.ofSource('local-shared-lifecycle/escape', source)
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0076'],
    )
  }),
)

it.effect('allows helper loans consumed before the local-shared callback returns', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.frontend(
      'local-shared-lifecycle/helper-loan',
      ascii(`struct Pair { first: i32 second: i32 }
fn view<'a>(value: &'a mut Pair) -> &'a mut Pair { return move value }
fn selected(value: &mut Pair) -> i32 {
  let borrowed = view(move value)
  return borrowed.first
}
fn fallback() -> i32 { return 0 }
unsafe fn access(core: &Intrinsic.SharedCore<Pair>) -> i32 {
  return Intrinsic.sharedWithMut<Pair, i32>(core, selected, fallback)
}`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
  }),
)

it('classifies inexpressible local-shared escape containers at the ownership-fact tier', () => {
  const narrowed = Type.slice('Shared', 'i32', Lifetime.staticLifetime)
  const genericAggregate = Type.nominal('test', 'Box', [narrowed])
  const failureValue = Type.effect('i32', [Type.nominal('test', 'Problem', [narrowed])], {
    environment: Lifetime.staticLifetime,
    lifetimeBinders: [],
  })
  const storedCallable = Type.callable(
    [],
    narrowed,
    { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    'Take',
  )
  for (const resultType of [narrowed, genericAggregate, failureValue, storedCallable]) {
    assert.isTrue(
      Ownership.localSharedResultEscapes({
        resultType,
        capturesRestrictedParameter: false,
        referencesRestrictedParameter: true,
      }),
    )
  }
  assert.isFalse(
    Ownership.localSharedResultEscapes({
      resultType: 'i32',
      capturesRestrictedParameter: false,
      referencesRestrictedParameter: true,
    }),
  )
})

it.effect('rejects a direct callback-dependent reference at a local-shared boundary', () =>
  Effect.gen(function* () {
    const source = ascii(`struct Pair { first: i32 second: i32 }
fn direct<'a>(value: &'a mut Pair) -> &'a mut Pair { return move value }
fn directConflict<'a>() -> &'a mut Pair { return directConflict() }
unsafe fn directProbe<'scope>(core: &'scope Intrinsic.SharedCore<Pair>) -> &'scope mut Pair {
  return Intrinsic.sharedWithMut<Pair, &'scope mut Pair>(core, direct, directConflict)
}
pub fn main() -> i32 { return 0 }`)
    const snapshot = yield* Analysis.ofSource('local-shared-lifecycle/direct-escape', source)
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0076'],
    )
  }),
)

it.effect('rejects generic aggregate capture and suspension across local-shared access', () =>
  Effect.gen(function* () {
    const source = ascii(`struct Pair { first: i32 second: i32 }
struct Box<A> { value: A }
fn wrap<A>(value: A) -> Box<A> { return Box<A> { value: move value } }
fn deferred<'a>(value: &'a mut Pair) -> Box<Effect<'a; i32>> {
  let escaped = effect { return value.first }
  return wrap<Effect<'a; i32>>(move escaped)
}
fn deferredConflict() -> Box<Effect<'static; i32>> {
  return wrap<Effect<'static; i32>>(effect { return 0 })
}
effect fn read(value: &mut Pair) -> i32 { return value.second }
fn suspended(value: &mut Pair) -> i32 {
  let result = run read(move value)
  return result
}
fn numberConflict() -> i32 { return 0 }
unsafe fn aggregateProbe<'scope>(core: &'scope Intrinsic.SharedCore<Pair>) -> Box<Effect<'scope; i32>> {
  return Intrinsic.sharedWithMut<Pair, Box<Effect<'scope; i32>>>(
    core,
    deferred,
    deferredConflict,
  )
}
unsafe fn suspensionProbe(core: &Intrinsic.SharedCore<Pair>) -> i32 {
  return Intrinsic.sharedWithMut<Pair, i32>(core, suspended, numberConflict)
}
pub fn main() -> i32 { return 0 }`)
    const snapshot = yield* Analysis.ofSource(
      'local-shared-lifecycle/aggregate-suspension-escape',
      source,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot)
        .map((diagnostic) => diagnostic.code)
        .sort(),
      ['OWN0016', 'SEM0076'],
    )
    const diagnostics = Analysis.diagnostics(snapshot).filter(
      (candidate) => candidate.code === 'OWN0016',
    )
    assert.deepEqual(
      diagnostics.map((diagnostic) =>
        diagnostic.reason._tag === 'LocalSharedAccessEscape'
          ? diagnostic.reason.kind
          : diagnostic.reason._tag,
      ),
      ['Suspension'],
    )
    for (const diagnostic of diagnostics) {
      assert.strictEqual(diagnostic.relatedSpans?.length, 1)
      assert.strictEqual(
        diagnostic.relatedSpans?.at(0)?.span.sourceId,
        'local-shared-lifecycle/aggregate-suspension-escape',
      )
    }
  }),
)

it.effect('rejects consuming the borrowed local-shared receiver in its selected callback', () =>
  Effect.gen(function* () {
    const source = ascii(`fn consume(value: &mut i32, core: Intrinsic.SharedCore<i32>) -> i32 {
  drop core
  return 0
}
fn conflict() -> i32 { return 0 }
unsafe fn probe(core: Intrinsic.SharedCore<i32>) -> i32 {
  return Intrinsic.sharedWithMut<i32, i32>(&core, consume(move core), conflict)
}
pub fn main() -> i32 { return 0 }`)
    const snapshot = yield* AnalysisFixture.retainingMain(
      'local-shared-lifecycle/consume-borrowed-receiver',
      source,
      'wasm32-unknown-unknown',
    )
    assert.include(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'OWN0011',
    )
  }),
)

it.effect('transports exact local-shared allocation provenance through an ordinary helper', () =>
  Effect.gen(function* () {
    const source = ascii(`import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
fn forward(allocation: Allocation) -> Allocation { return move allocation }
effect fn construct() -> i32 ! OutOfMemoryError {
  let layout = Intrinsic.sharedLayout<i32>()
  let acquired = run Intrinsic.systemAllocationAcquire(move layout)
  let allocation = forward(move acquired)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`)
    const snapshot = yield* AnalysisFixture.retainingMain(
      'local-shared-allocation/helper',
      source,
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
  }),
)

it.effect(
  'reconstructs measured descriptors through declared fields and symbolic pattern paths',
  () =>
    Effect.gen(function* () {
      const snapshot = yield* AnalysisFixture.retainingMain(
        'local-shared-allocation/descriptor-fields',
        ascii(`import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
struct Parts { alignmentLabel: usize bytesLabel: usize }
struct Envelope { payload: Parts }
fn envelope(layout: Layout) -> Envelope {
  return Envelope { payload: Parts { bytesLabel: layout.alignment, alignmentLabel: layout.bytes } }
}
fn reconstruct(descriptor: Envelope) -> Layout {
  let Envelope {payload: fields} = move descriptor
  return match move fields {
    Parts {alignmentLabel: size, bytesLabel: alignment} => {
      let rebuilt = Layout {alignment: alignment, bytes: size}
      return move rebuilt
    }
  }
}
fn project(parts: Parts) -> Layout {
  return Layout {alignment: parts.bytesLabel, bytes: parts.alignmentLabel}
}
effect fn construct() -> i32 ! OutOfMemoryError {
  let measured = Intrinsic.sharedLayout<i32>()
  let reconstructed = reconstruct(envelope(move measured))
  let first = run Intrinsic.systemAllocationAcquire(move reconstructed)
  unsafe { let core = Intrinsic.sharedFromAllocation<i32>(move first, 42) drop core }
  let size = Intrinsic.sharedLayout<i32>()
  let alignment = Intrinsic.sharedLayout<i32>()
  let parts = Parts {bytesLabel: alignment.alignment, alignmentLabel: size.bytes}
  let second = run Intrinsic.systemAllocationAcquire(project(move parts))
  unsafe { let core = Intrinsic.sharedFromAllocation<i32>(move second, 42) drop core }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`),
        'wasm32-unknown-unknown',
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const operations = Analysis.loweredMir(snapshot).functions.flatMap((fn) =>
        fn.regions
          .flatMap(Mir.operationsOf)
          .flatMap(Mir.operationTree)
          .filter((operation) => operation._tag === 'SharedFromAllocation'),
      )
      assert.lengthOf(operations, 2)
      assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
    }),
)

it.effect('rejects altered descriptor components and preserves measured mismatch spans', () =>
  Effect.gen(function* () {
    const cases = [
      ['swapped', 'Layout {bytes: measured.alignment, alignment: measured.bytes}'],
      ['mixed', 'Layout {bytes: measured.bytes, alignment: other.alignment}'],
      ['arithmetic', 'Layout {bytes: measured.bytes + 0, alignment: measured.alignment}'],
      ['unknown', 'Layout {bytes: 8, alignment: 8}'],
      ['wrong', 'Layout {bytes: other.bytes, alignment: other.alignment}'],
      ['cycle', 'loopDescriptor(Layout {bytes: measured.bytes, alignment: measured.alignment})'],
    ] as const
    const functions = cases.map(
      ([name, layout]) => `effect fn ${name}() -> i32 ! OutOfMemoryError {
  let measured = Intrinsic.sharedLayout<i32>()
  let other = Intrinsic.sharedLayout<u32>()
  let layout = ${layout}
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe { let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42) drop core }
  return 0
}`,
    )
    const text = `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
fn loopDescriptor(layout: Layout) -> Layout { return loopDescriptor(move layout) }
${functions.join('\n')}
effect fn overwritten() -> i32 ! OutOfMemoryError {
  let measured = Intrinsic.sharedLayout<i32>()
  let mut layout = Layout {bytes: measured.bytes, alignment: measured.alignment}
  layout.bytes = 8
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe { let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42) drop core }
  return 0
}
effect fn construct() -> i32 ! OutOfMemoryError {
  ${cases.map(([name]) => `let ${name}Result = run ${name}()`).join('\n  ')}
  return run overwritten()
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`
    const source = ordinaryStorageSource(text)
    const snapshot = yield* AnalysisFixture.retainingMain(
      'local-shared-allocation/descriptor-controls',
      new TextEncoder().encode(source),
      'wasm32-unknown-unknown',
    )
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      Array(7).fill('SEM0138'),
    )
    for (const diagnostic of diagnostics) {
      assert.strictEqual(diagnostic.relatedSpans?.length, 1)
      assert.strictEqual(diagnostic.span.sourceId, 'local-shared-allocation/descriptor-controls')
      assert.isTrue(
        source.slice(diagnostic.span.start, diagnostic.span.end).includes('sharedFromAllocation'),
      )
      assert.strictEqual(
        diagnostic.relatedSpans?.at(0)?.span.sourceId,
        'local-shared-allocation/descriptor-controls',
      )
    }
    const wrong = diagnostics.find(
      (diagnostic) =>
        diagnostic.reason._tag === 'LocalSharedLayoutMismatch' &&
        diagnostic.reason.actual === 'u32',
    )
    assert.isDefined(wrong)
    const measuredOrigin = wrong?.relatedSpans?.at(0)?.span
    assert.isDefined(measuredOrigin)
    if (measuredOrigin !== undefined)
      assert.strictEqual(
        source.slice(measuredOrigin.start, measuredOrigin.end),
        'Intrinsic.sharedLayout<u32>()',
      )
  }),
)

it.effect('rejects mixed execution measurement specializations through descriptor fields', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'execution-allocation/descriptor-specializations',
      ascii(`import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
struct Ready {}
fn ready(state: &Ready) -> () { return () }
effect fn other() -> i32 { return 41 }
effect fn create<
  F: once Effect<'static; i32> + Intrinsic.Detached,
  G: once Effect<'static; i32> + Intrinsic.Detached,
  R: fn<'static>(&Ready) -> () + Intrinsic.Detached + Intrinsic.NonParking
>(body: F, different: G, onReady: R) -> Intrinsic.Execution<i32> ! OutOfMemoryError {
  let first = Intrinsic.executionLayout<i32, F, Ready, R>()
  let second = Intrinsic.executionLayout<i32, G, Ready, R>()
  drop different
  let layout = Layout {alignment: second.alignment, bytes: first.bytes}
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe {
    return Intrinsic.executionFromAllocation<i32, F, Ready, R>(
      move allocation, move body, Ready {}, move onReady
    )
  }
}
effect fn construct() -> i32 ! OutOfMemoryError {
  let execution = run create(effect { return 42 }, other(), ready)
  drop execution
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0142'],
    )
    const diagnostic = Analysis.diagnostics(snapshot).at(0)
    assert.strictEqual(diagnostic?.relatedSpans?.length, 1)
  }),
)

it.effect('invalidates inherited allocation provenance after a mutable parameter write', () =>
  Effect.gen(function* () {
    const source = ascii(`import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
fn replace(mut allocation: Allocation, replacement: Allocation) -> Allocation {
  allocation = move replacement
  return move allocation
}
effect fn construct() -> i32 ! OutOfMemoryError {
  let firstLayout = Intrinsic.sharedLayout<i32>()
  let first = run Intrinsic.systemAllocationAcquire(move firstLayout)
  let secondLayout = Intrinsic.sharedLayout<i32>()
  let second = run Intrinsic.systemAllocationAcquire(move secondLayout)
  let allocation = replace(move first, move second)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`)
    const snapshot = yield* AnalysisFixture.retainingMain(
      'local-shared-allocation/mutable-parameter',
      source,
      'wasm32-unknown-unknown',
    )

    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0138'],
    )
    const diagnostic = Analysis.diagnostics(snapshot).at(0)
    assert.strictEqual(
      diagnostic?.reason._tag === 'LocalSharedLayoutMismatch'
        ? diagnostic.reason.actual
        : undefined,
      'mutable parameter allocation provenance',
    )
  }),
)

it.effect('invalidates inherited allocation provenance after replacing a mutable parameter', () =>
  Effect.gen(function* () {
    const source = ascii(`import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
fn replace(mut allocation: Allocation, replacement: Allocation) -> Allocation {
  let old = Intrinsic.replace(allocation, move replacement)
  drop old
  return move allocation
}
effect fn construct() -> i32 ! OutOfMemoryError {
  let firstLayout = Intrinsic.sharedLayout<i32>()
  let first = run Intrinsic.systemAllocationAcquire(move firstLayout)
  let secondLayout = Intrinsic.sharedLayout<i64>()
  let second = run Intrinsic.systemAllocationAcquire(move secondLayout)
  let allocation = replace(move first, move second)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`)
    const snapshot = yield* AnalysisFixture.retainingMain(
      'local-shared-allocation/mutable-parameter-replace',
      source,
      'wasm32-unknown-unknown',
    )

    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0138'],
    )
    const diagnostic = Analysis.diagnostics(snapshot).at(0)
    assert.strictEqual(
      diagnostic?.reason._tag === 'LocalSharedLayoutMismatch'
        ? diagnostic.reason.actual
        : undefined,
      'mutable parameter allocation provenance',
    )
  }),
)

it.effect('proves exact local-shared provenance through the selected allocator provider', () =>
  Effect.gen(function* () {
    const source = ascii(`import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
effect fn construct() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let recipe = Allocator.allocate(Intrinsic.sharedLayout<i32>())
    |> Effect.provideMut<Allocator>(&mut allocator)
  let allocation = run recipe
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(construct(), recover) }`)
    const snapshot = yield* AnalysisFixture.retainingMain(
      'local-shared-allocation/provider',
      source,
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(snapshot)), [])
  }),
)

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(ordinaryStorageSource(value), (character) => character.charCodeAt(0))

/** The accepted shape every negative below deviates from in exactly one way. */
const guarded = (body: string): string => `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  unsafe {
    let mut buffer = RawBuffer.from<i32>(move allocation, 2)
${body}
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`

/**
 * The substrate is only sound if the frontend keeps rejecting the programs that would violate
 * it, so each prohibited shape is pinned to the code that rejects it. A regression here would
 * otherwise surface as a trap — or as undefined behaviour in a released backend — rather than
 * as a compile error.
 */
it.effect(
  'rejects every prohibited allocation shape before lowering',
  () =>
    Effect.gen(function* () {
      const cases: ReadonlyArray<readonly [string, string, string]> = [
        [
          'local-shared-layout-provenance-mismatch',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
effect fn store() -> i32 ! OutOfMemoryError {
  let layout = Intrinsic.sharedLayout<i64>()
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'SEM0138',
        ],
        [
          'local-shared-ordinary-layout',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
effect fn store() -> i32 ! OutOfMemoryError {
  let layout = Layout.of<i32>()
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'SEM0138',
        ],
        [
          'local-shared-helper-provenance-mismatch',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
fn forward(allocation: Allocation) -> Allocation { return move allocation }
effect fn store() -> i32 ! OutOfMemoryError {
  let layout = Intrinsic.sharedLayout<u32>()
  let acquired = run Intrinsic.systemAllocationAcquire(move layout)
  let allocation = forward(move acquired)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'SEM0138',
        ],
        [
          'local-shared-conditional-helper-provenance-mismatch',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
fn choose(flag: bool, wrong: Allocation, right: Allocation) -> Allocation {
  if flag {
    drop right
    return move wrong
  }
  drop wrong
  return move right
}
effect fn store() -> i32 ! OutOfMemoryError {
  let wrongLayout = Intrinsic.sharedLayout<u32>()
  let wrong = run Intrinsic.systemAllocationAcquire(move wrongLayout)
  let rightLayout = Intrinsic.sharedLayout<i32>()
  let right = run Intrinsic.systemAllocationAcquire(move rightLayout)
  let allocation = choose(true, move wrong, move right)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'SEM0138',
        ],
        [
          'local-shared-provider-forges-provenance',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
service Forge {
  effect fn allocate(layout: Layout) -> Allocation ! OutOfMemoryError ? &mut Forge
}
struct BadForge {}
effect fn allocate(self: &mut BadForge, layout: Layout) -> Allocation ! OutOfMemoryError {
  drop layout
  return run Intrinsic.systemAllocationAcquire(Layout.of<i32>())
}
impl Forge for BadForge { allocate: BadForge.allocate }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut forge = BadForge {}
  let recipe = Forge.allocate(Intrinsic.sharedLayout<i32>())
    |> Effect.provideMut<Forge>(&mut forge)
  let allocation = run recipe
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'SEM0138',
        ],
        [
          'local-shared-same-spelling-layout',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
fn sharedLayout() -> Layout { return Layout.of<i32>() }
effect fn store() -> i32 ! OutOfMemoryError {
  let layout = sharedLayout()
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop core
  }
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'SEM0138',
        ],
        [
          'local-shared-outside-unsafe',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
effect fn store() -> i32 ! OutOfMemoryError {
  let layout = Intrinsic.sharedLayout<i32>()
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
  drop core
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'SEM0082',
        ],
        [
          'local-shared-reuses-consumed-allocation',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
effect fn store() -> i32 ! OutOfMemoryError {
  let layout = Intrinsic.sharedLayout<i32>()
  let allocation = run Intrinsic.systemAllocationAcquire(move layout)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<i32>(move allocation, 42)
    drop allocation
    drop core
  }
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'OWN0001',
        ],
        [
          'local-shared-reuses-consumed-payload',
          `import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
effect fn store() -> i32 ! OutOfMemoryError {
  let blockLayout = Intrinsic.sharedLayout<Allocation>()
  let block = run Intrinsic.systemAllocationAcquire(move blockLayout)
  let payloadLayout = Intrinsic.sharedLayout<i32>()
  let payload = run Intrinsic.systemAllocationAcquire(move payloadLayout)
  unsafe {
    let core = Intrinsic.sharedFromAllocation<Allocation>(move block, move payload)
    drop payload
    drop core
  }
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'OWN0001',
        ],
        [
          'raw-storage-outside-unsafe',
          `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
effect fn store() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let recipe = Allocator.allocate(move layout) |> Effect.provideMut(&mut allocator)
  let allocation = run recipe
  let mut buffer = Intrinsic.rawBufferFrom<i32>(move allocation, 2)
  drop buffer
  return 1
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(store(), recover) }`,
          'SEM0082',
        ],
        [
          'slot-escapes-its-buffer',
          guarded(`    let slot = RawBuffer.slot(&mut buffer, 0)
    drop buffer
    let value = Slot.take(move slot)
    return value`),
          'OWN0011',
        ],
        [
          'buffer-moves-under-a-live-slot',
          guarded(`    let slot = RawBuffer.slot(&mut buffer, 0)
    let moved = move buffer
    let value = Slot.take(move slot)
    drop moved
    return value`),
          'OWN0011',
        ],
        [
          'foreign-allocator-conformance',
          `import silk.allocator { Allocator }
struct TestAllocator { remaining: i32 }
impl Allocator for TestAllocator { allocate: Foreign.allocate }
pub fn main() -> i32 { return 0 }`,
          'SEM0083',
        ],
        [
          'drop-hook-on-a-copy-type',
          `struct CopyValue { value: i32 }
impl Copy for CopyValue {}
impl Drop for CopyValue { fn drop(self: &mut CopyValue) -> () { return () } }
pub fn main() -> i32 { return 0 }`,
          'SEM0083',
        ],
      ]

      for (const [name, source, code] of cases) {
        const realized =
          code === 'SEM0138'
            ? yield* AnalysisFixture.retainingMain(
                `owned-allocation-negative/${name}`,
                ascii(source),
                'wasm32-unknown-unknown',
              )
            : undefined
        const snapshot =
          realized ?? (yield* Analysis.ofSource(`owned-allocation-negative/${name}`, ascii(source)))
        assert.include(
          Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
          code,
          `${name}\n${Tir.encode(Analysis.rootAnalysis(snapshot).tir)}`,
        )
        if (realized !== undefined)
          assert.throws(() => Analysis.loweredMir(realized), /MIR is unavailable/)
      }
    }),
  // Measured near the 60s floor while the full parallel gate saturates the host; the timeout
  // is headroom for contention, not a performance assertion.
  180_000,
)

it.effect(
  'proves local-shared provenance through stored recipes and nested provider forwarding',
  () =>
    Effect.gen(function* () {
      const module = 'allocation/stored-provider-forwarding'
      const source = `import silk.allocator {Allocator, OutOfMemoryError}
import silk.effect {Effect}
import silk.shared {Shared}

service Marker {
  effect fn mark() -> i32 ? &mut Marker
}
struct FixedMarker {}
impl Marker for FixedMarker {
  effect fn mark(self: &mut Self) -> i32 { drop self return 42 }
}
struct Audit {value: i32}
fn read(audit: &Audit) -> i32 { return audit.value }

effect fn runCases() -> i32 ! OutOfMemoryError ? &mut Allocator | &mut Marker {
  let allocation = Shared.make<Audit>(Audit {value: 42})
  let audit = run move allocation
  let value = Shared.with(&audit, read)
  let marked = run Marker.mark()
  return value + marked
}

effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut marker = FixedMarker {}
  let recipe = runCases()
  let marked = move recipe |> Effect.provideMut<Marker>(&mut marker)
  let provided = move marked |> Effect.provideMut<Allocator>(&mut allocator)
  return run move provided
}
effect fn failed(error: OutOfMemoryError) -> i32 { drop error return -1 }
pub fn main() -> i32 { return run Effect.catchAll(program(), failed) }`
      const snapshot = yield* Analysis.makeRealized({
        root: module,
        configuration: AnalysisFixture.configuration(module, 'wasm32-unknown-unknown'),
      }).pipe(
        Effect.provide(
          SourceResolver.overlay([SourceFile.make(module, ascii(source))]).pipe(
            Layer.provideMerge(SourceResolver.empty),
          ),
        ),
      )
      assert.deepEqual(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        [],
      )
      const mir = Analysis.loweredMir(snapshot)
      assert.isTrue(
        mir.functions
          .flatMap((fn) => fn.regions)
          .flatMap(Mir.operationsOf)
          .flatMap(Mir.operationTree)
          .some((operation) => operation._tag === 'SharedFromAllocation'),
      )
      assert.deepEqual(yield* MirVerification.verify(mir), [])
    }),
)
