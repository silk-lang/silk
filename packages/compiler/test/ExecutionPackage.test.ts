import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as ExecutionPackage from '../src/ExecutionPackage.js'
import * as Lifetime from '../src/Lifetime.js'
import * as SuspensionMode from '../src/SuspensionMode.js'
import * as Target from '../src/Target.js'
import * as Type from '../src/Type.js'

const specialization = (suspension: SuspensionMode.Summary): ExecutionPackage.Specialization =>
  Object.freeze({
    result: 'i32',
    body: Type.effect(
      'i32',
      Object.freeze([]),
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Take',
    ),
    endpoint: Type.unit,
    callback: Type.callable(
      Object.freeze([Type.reference('Shared', Type.unit, Lifetime.staticLifetime)]),
      Type.unit,
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
    ),
    suspension,
  })

it('plans exact direct, nested, and externally parkable combined packages', () => {
  const target = Target.wasm32UnknownUnknown
  const layouts = Object.freeze({
    body: Object.freeze({ size: 8, alignment: 4 }),
    endpoint: Object.freeze({ size: 0, alignment: 1 }),
    callback: Object.freeze({ size: 0, alignment: 1 }),
  })
  const direct = ExecutionPackage.plan(target, specialization(SuspensionMode.direct), layouts)
  const nested = ExecutionPackage.plan(
    target,
    specialization(SuspensionMode.openExecutable(Object.freeze(['Intrinsic.NonParking']))),
    layouts,
  )
  const external = ExecutionPackage.plan(
    target,
    specialization(SuspensionMode.openExecutable(Object.freeze([]))),
    layouts,
  )
  assert.strictEqual(direct._tag, 'ExecutionPackagePlan')
  assert.strictEqual(nested._tag, 'ExecutionPackagePlan')
  assert.strictEqual(external._tag, 'ExecutionPackagePlan')
  if (
    direct._tag !== 'ExecutionPackagePlan' ||
    nested._tag !== 'ExecutionPackagePlan' ||
    external._tag !== 'ExecutionPackagePlan'
  )
    return
  assert.isFalse(direct.initialContinuationSegment)
  assert.isTrue(nested.initialContinuationSegment)
  assert.isTrue(external.initialContinuationSegment)
  // Every package carries one control block at the same offset, so references need no dispatch.
  for (const plan of [direct, nested, external])
    assert.deepEqual(
      plan.components.slice(0, 2).map((component) => [component.role, component.size]),
      [
        ['OwnerRecord', target.pointerSize * 2],
        ['Control', target.pointerSize * ExecutionPackage.controlWords],
      ],
    )
  assert.notStrictEqual(direct.provenance, nested.provenance)
  assert.notStrictEqual(nested.provenance, external.provenance)
  assert.isFalse(direct.components.some((component) => component.role === 'EndpointState'))
})

it('rejects overflow and every mismatched initializer provenance dimension', () => {
  const target = Target.wasm32UnknownUnknown
  const selected = ExecutionPackage.planWithin(
    target,
    specialization(SuspensionMode.direct),
    {
      body: { size: 8, alignment: 8 },
      endpoint: { size: 0, alignment: 1 },
      callback: { size: 0, alignment: 1 },
    },
    4096,
  )
  assert.strictEqual(selected._tag, 'ExecutionPackagePlan')
  if (selected._tag !== 'ExecutionPackagePlan') return
  const accepted = Object.freeze({
    target: selected.target,
    size: selected.size,
    alignment: selected.alignment,
    package: selected.provenance,
  })
  assert.deepEqual(ExecutionPackage.validateInitialization(selected, accepted), {
    _tag: 'Accepted',
    state: 'Unstarted',
  })
  assert.strictEqual(
    ExecutionPackage.validateInitialization(selected, {
      ...accepted,
      target: 'x86_64-unknown-linux-gnu',
    })._tag,
    'Rejected',
  )
  assert.strictEqual(
    ExecutionPackage.validateInitialization(selected, { ...accepted, size: selected.size + 1 })
      ._tag,
    'Rejected',
  )
  assert.strictEqual(
    ExecutionPackage.validateInitialization(selected, {
      ...accepted,
      alignment: selected.alignment * 2,
    })._tag,
    'Rejected',
  )
  assert.strictEqual(
    ExecutionPackage.validateInitialization(selected, { ...accepted, package: 'wrong' })._tag,
    'Rejected',
  )
  assert.strictEqual(
    ExecutionPackage.planWithin(
      target,
      specialization(SuspensionMode.direct),
      {
        body: { size: 4096, alignment: 8 },
        endpoint: { size: 0, alignment: 1 },
        callback: { size: 0, alignment: 1 },
      },
      64,
    )._tag,
    'ExecutionPackageUnavailable',
  )
})

it.effect('rejects an initializer whose allocation has different layout provenance', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'execution-package/mismatched-provenance',
      new TextEncoder().encode(`import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
struct Ready {}
fn ready(state: &Ready) -> () { return () }
fn absurd<T>() -> T { let boom = 1 / 0 return absurd<T>() }
effect fn create<
  F: once Effect<'static; i32> + Intrinsic.Detached,
  R: fn<'static>(&Ready) -> () + Intrinsic.Detached + Intrinsic.NonParking
>(body: F, onReady: R) -> Intrinsic.Execution<i32>
! OutOfMemoryError
? &mut Allocator {
  let allocation = run Allocator.allocate(Layout.of<i32>())
  unsafe {
    return Intrinsic.executionFromAllocation<i32, F, Ready, R>(
      move allocation,
      move body,
      Ready {},
      move onReady
    )
  }
  return absurd<Intrinsic.Execution<i32>>()
}
effect fn package() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut creating = create(effect { return 42 }, ready)
    |> Effect.provideMut<Allocator>(&mut allocator)
  let execution = run creating
  drop execution
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(package(), recover) }`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      ['SEM0142'],
    )
  }),
)

it.effect('rejects nested borrowed completion independently of exact environment detachment', () =>
  Effect.gen(function* () {
    const source = `
import silk.allocator { Allocator, OutOfMemoryError }
import silk.execution { Execution }
struct Nested<'a> { values: [&'a i32; 1] }
struct Ready {}
fn ready(state: &Ready) -> () { return () }
effect fn borrowed<'a>(value: &'a i32) -> Nested<'a> { return Nested<'a> { values: [value] } }
effect fn external<'a>(value: &'a i32) -> () ! OutOfMemoryError ? &mut Allocator {
  let execution = run Execution.make(borrowed(value), Ready {}, ready)
  drop execution
  return ()
}
effect fn local<'a>() -> Nested<'a> { let value = 42 return Nested<'a> { values: [&value] } }
pub fn main() -> i32 { return 0 }
`
    const self = yield* Analysis.ofSource(
      'execution-package/outcome-lifetimes',
      new TextEncoder().encode(source),
    )
    const diagnostics = Analysis.diagnostics(self)
    const externalStart = source.indexOf('effect fn external')
    const localStart = source.indexOf('effect fn local')
    assert.isFalse(diagnostics.some((d) => d.span.end <= externalStart))
    assert.isTrue(
      diagnostics.some(
        (d) => d.code === 'SEM0212' && d.span.end > externalStart && d.span.start < localStart,
      ),
    )
    assert.isTrue(
      diagnostics.some(
        (d) =>
          d.code === 'OWN0019' &&
          d.span.start >= localStart &&
          source.slice(d.span.start, d.span.end).trim() === "Nested<'a> { values: [&value] }",
      ),
    )
  }),
)

it.effect('proves execution allocation through a caller-provided allocator', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.execution { Execution }
import silk.effect { Effect }
fn ready(state: &()) -> () {}
effect fn body() -> i32 { return 42 }
effect fn work() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let execution = run Execution.make(body(), (), ready)
  drop execution
  return 42
}
effect fn failed(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(work(), failed) |> Effect.provideMut<Allocator>(&mut allocator)
}`
    const snapshot = yield* AnalysisFixture.retainingMain(
      'execution-package/caller-allocator',
      new TextEncoder().encode(source),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const forged = source
      .replace(
        'pub fn main()',
        `import silk.layout { Layout }
struct WrongAllocator {}
effect fn wrongAllocate(self: &mut WrongAllocator, layout: Layout) -> Allocation ! OutOfMemoryError {
  let mut inner = Allocator.systemAllocatorProvider()
  return run Allocator.allocate(Intrinsic.sharedLayout<i32>()) |> Effect.provideMut<Allocator>(&mut inner)
}
impl Allocator for WrongAllocator { allocate: WrongAllocator.wrongAllocate }
pub fn main()`,
      )
      .replace(
        'let mut allocator = Allocator.systemAllocatorProvider()',
        'let mut allocator = WrongAllocator {}',
      )
    const rejected = yield* AnalysisFixture.retainingMain(
      'execution-package/forged-caller-allocator',
      new TextEncoder().encode(forged),
      'wasm32-unknown-unknown',
    )
    const diagnostics = Analysis.diagnostics(rejected)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0142'],
    )
    const wrongLayout = forged.indexOf('Intrinsic.sharedLayout<i32>()')
    assert.isTrue(
      diagnostics.some(
        (diagnostic) =>
          diagnostic.span.sourceId === 'silk/execution' &&
          diagnostic.relatedSpans?.some(
            ({ span }) =>
              span.sourceId === 'execution-package/forged-caller-allocator' &&
              span.start <= wrongLayout &&
              span.end >= wrongLayout + 'Intrinsic.sharedLayout<i32>()'.length,
          ),
      ),
    )
  }),
)
