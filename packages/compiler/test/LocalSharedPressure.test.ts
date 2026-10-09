import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Json from './support/Json.js'
import * as Analysis from '../src/Analysis.js'
import * as Intrinsic from '../src/Intrinsic.js'

const encoder = new TextEncoder()

const realized = Effect.fnUntraced(function* (name: string, source: string) {
  return yield* Analysis.ofSourceRealized(name, encoder.encode(source), 'wasm32-unknown-unknown')
})

it.effect('rejects a nested owner child that retains Scheduler and Allocator requirements', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
service Scheduler { effect fn join() -> i32 ? &Scheduler }
struct LocalScheduler {}
effect fn join(self: &LocalScheduler) -> i32 { return 42 }
impl Scheduler for LocalScheduler { join: LocalScheduler.join }
effect fn nested() -> i32 ! OutOfMemoryError ? &Scheduler | &mut Allocator {
  let value = run Scheduler.join()
  let storage = run Allocator.allocate(Layout.of<i32>())
  drop storage
  return value
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
fn schedule<F: once Effect<i32> + Intrinsic.Detached>(child: F) -> () {
  drop child
  return ()
}
pub fn main() -> () {
  let scheduler = LocalScheduler {}
  let mut allocator = Allocator.systemAllocatorProvider()
  let child = nested()
    |> Effect.provide<Scheduler>(&scheduler)
    |> Effect.provideMut<Allocator>(&mut allocator)
    |> Effect.catchAll(recover)
  return schedule(move child)
}`
    const snapshot = yield* realized('pressure/independent-execution-nested-owner-rejected', source)
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0139'],
      Json.stringify(diagnostics),
    )
    const diagnostic = diagnostics.at(0)
    assert.strictEqual(diagnostic?.reason._tag, 'UnsatisfiedExecutableProperty')
    assert.strictEqual(
      diagnostic?.reason._tag === 'UnsatisfiedExecutableProperty'
        ? diagnostic.reason.property
        : undefined,
      'Intrinsic.Detached',
    )
    assert.include(
      diagnostic?.reason._tag === 'UnsatisfiedExecutableProperty'
        ? diagnostic.reason.causes.join(';')
        : '',
      'Provider',
    )
    assert.strictEqual(
      diagnostic === undefined
        ? undefined
        : source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      'schedule(move child)',
    )
  }),
)

it.effect('rejects parking through the default source runtime NonParking constraint', () =>
  Effect.gen(function* () {
    const source = `import silk.execution { Execution, Wake }
struct Guard {}
fn register(wake: Wake) -> Guard { drop wake return Guard {} }
pub fn main() -> () { return run Execution.park(register) }`
    const snapshot = yield* realized('pressure/independent-execution-unowned-entry', source)
    const diagnostics = Analysis.diagnostics(snapshot)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0139'],
    )
    const diagnostic = diagnostics.at(0)
    assert.strictEqual(diagnostic?.reason._tag, 'UnsatisfiedExecutableProperty')
    assert.strictEqual(diagnostic?.span.sourceId, 'silk/wasm_start')
    assert.notInclude(
      diagnostics.map((candidate) => candidate.code),
      'SEM0123',
    )
  }),
)

it('keeps pressure-policy spellings out of the compiler privilege inventory', () => {
  assert.isFalse(
    Intrinsic.inventory().some((entry) =>
      /Scheduler|Deferred|Timer|Coroutine|TaskStore|ReadyInbox|Reactor|Allocator|WorkRegistry|SignalQueue|EventLoop|ChannelState/.test(
        `${entry.operation}.${entry.consumer}`,
      ),
    ),
  )
  const privilegedPhases = [
    '../src/NameResolution.ts',
    '../src/DeclarationResolution.ts',
    '../src/CallResolution.ts',
    '../src/Type.ts',
    '../src/ExecutableOrigin.ts',
    '../src/ExecutableProperty.ts',
    '../src/IntrinsicAvailability.ts',
    '../src/Tir.ts',
    '../src/BodyBuilder.ts',
    '../src/EffectLowering.ts',
    '../src/FunctionLowering.ts',
    '../src/Mir.ts',
    '../src/Lower.ts',
    '../src/LowerExpression.ts',
    '../src/LowerBuiltin.ts',
    '../src/LowerStatements.ts',
    '../src/MirNormalization.ts',
    '../src/MirVerification.ts',
    '../src/SuspensionOwnership.ts',
    '../src/ExecutionPackage.ts',
    '../src/NativeProgram.ts',
    '../src/NativeOperation.ts',
    '../src/NativeExecutionOperation.ts',
    '../src/NativeSuspension.ts',
    '../src/Intrinsic.ts',
  ] as const
  const policyActor =
    'Scheduler|Fiber|Deferred|Timer|Coroutine|ReadyInbox|TaskStore|Reactor|WorkRegistry|SignalQueue|EventLoop|ChannelState'
  const policyActorLiteral = new RegExp(`['"](?:${policyActor})['"]`)
  for (const phase of privilegedPhases) {
    const source = readFileSync(new URL(phase, import.meta.url), 'utf8')
    assert.notMatch(
      source,
      /silk\/core\.(?:OutOfMemoryError|Allocator|SystemAllocator)|\b(?:outOfMemoryError|systemAllocator)\b/,
      phase,
    )
    assert.notMatch(source, policyActorLiteral, phase)
  }
})

it.effect('keeps allocator provenance through a generic scoped callback', () =>
  Effect.gen(function* () {
    const source = `import silk.allocator { Allocator, OutOfMemoryError }
import silk.effect { Effect }
import silk.result { Result }
import silk.shared { Shared }
struct Rejection { code: i32 }
struct Lease {}
effect fn memo<'env, A, R, E, ?Requirements>(
  provide: once fn<'env>() -> once Effect<'env; Result<A, R> ! E ? Requirements>
) -> Shared<Result<A, R>> ! E | OutOfMemoryError ? Requirements | &mut Allocator {
  let use = effect fn(resource: &mut Lease) -> Shared<Result<A, R>>
  ! E | OutOfMemoryError ? Requirements | &mut Allocator {
    let answer = run provide()
    return run Shared.make<Result<A, R>>(move answer)
  }
  let release = effect fn(resource: &mut Lease) -> () { return () }
  return run Effect.useReleaseNonParking(Lease {}, move use, move release)
}
effect fn accepted() -> Result<i32, Rejection> {
  return Result.succeed<i32, Rejection>(41)
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let shared = run memo(accepted) |> Effect.provideMut<Allocator>(&mut allocator)
  drop shared
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return -1 }
pub fn main() -> i32 {
  return run Effect.catchAll(program(), recover)
}`
    const snapshot = yield* realized('pressure/generic-scoped-shared-answer', source)
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.isAbove(Analysis.loweredMir(snapshot).functions.length, 0)
  }),
)
