import * as AnalysisFixture from './support/AnalysisFixture.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as NativeDiagnosticOutcome from '../src/NativeDiagnosticOutcome.js'
import * as NativeResult from '../src/NativeResult.js'
import * as NativeDiagnosticTransfer from '../src/NativeDiagnosticTransfer.js'
import * as ContinuationTransfer from '../src/ContinuationTransfer.js'
import * as Emitter from '@silklang/llvm/Emitter'
import * as LlvmFunction from '@silklang/llvm/Function'
import * as NativeDiagnosticContext from '../src/NativeDiagnosticContext.js'
import * as NativeDiagnosticFailure from '../src/NativeDiagnosticFailure.js'
import * as NativeCall from '../src/NativeCall.js'
import { readFileSync } from 'node:fs'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as CallableContract from '../src/CallableContract.js'
import * as Intrinsic from '../src/Intrinsic.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Scalar from '../src/Scalar.js'
import * as Type from '../src/Type.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as MirVerification from '../src/MirVerification.js'
import * as Mir from '../src/Mir.js'
import * as MirLinearization from '../src/MirLinearization.js'
import * as NativeFunction from '../src/NativeFunction.js'
import { unreachable } from './support/raise.js'
import * as LlvmBuilder from '@silklang/llvm/Builder'
import * as LlvmType from '@silklang/llvm/Type'
import * as LlvmIrText from '@silklang/llvm/IrText'
import * as NativeDeclare from '../src/NativeDeclare.js'
import * as NativeType from '../src/NativeType.js'

const encoder = new TextEncoder()

const key = (actor: string, operation: string): string => `${actor}.${operation}`

const operationKeys = (snapshot: Analysis.FrontendSnapshot): ReadonlyArray<string> =>
  [...snapshot.semanticOccurrences.modules.values()].flatMap((module) =>
    module.occurrences.flatMap((occurrence) =>
      occurrence.resolution._tag === 'Available' &&
      occurrence.resolution.identity._tag === 'IntrinsicOperationIdentity'
        ? [key(occurrence.resolution.identity.id.actor, occurrence.resolution.identity.id.name)]
        : [],
    ),
  )

const observationWrapper = `fn observing<'env, S, A, ?R, F: fn<'static>(&mut S, u8, usize, usize, string<'static>, string<'static>) -> usize + Intrinsic.NonParking>(state: S, observer: F, body: once Effect<'env; A ? R>) -> once Effect<'env; A ? R> {
  return Intrinsic.observeDiagnostics<S, A, R, F>(move state, move observer, move body)
}`

const acceptedSources = Object.freeze([
  `struct Failure {}
effect fn failed() -> i32 ! Failure { fail Failure {} }
effect fn recover(error: Failure) -> i32 {
  drop error
  let policy = Intrinsic.observeUnhandled()
  return 42
}
pub fn main() -> i32 { return run Intrinsic.catchFailure<Failure>(failed(), recover) }`,
  `${observationWrapper}
struct Observer { count: usize }
fn observer(state: &mut Observer, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize {
  state.count = state.count + 1
  return 0
}
effect fn observed() -> i32 { return 42 }
pub fn main() -> i32 {
  let deferred = observing(Observer { count: 0 }, observer, observed())
  return 0
}`,
  `pub unsafe fn reinterpretStorage(value: ?*mut u8) -> ?*mut i32 {
    unsafe {return Intrinsic.pointerReinterpret<?*mut u8, ?*mut i32>(value)}
  }`,
  ...Scalar.integers().map((scalar, scalarOrdinal) => {
    const calls = scalar.operations.map((operation, operationOrdinal) => {
      const arguments_ = operation.arity === 1 ? '1' : '1, 1'
      return `  let v${operationOrdinal} = ${scalar.spelling}.${operation.spelling}(${arguments_})`
    })
    return `import silk.${scalar.spelling}\npub fn scalar${scalarOrdinal}() -> i32 {\n${calls.join('\n')}\n  return 0\n}`
  }),
  ...Scalar.floats().map((scalar, scalarOrdinal) => {
    const calls = scalar.operations.map((operation, operationOrdinal) => {
      const argument = operation.code === 'FromBits' ? '1' : '1.0'
      const arguments_ = operation.arity === 1 ? argument : `${argument}, ${argument}`
      return `  let v${operationOrdinal} = ${scalar.spelling}.${operation.spelling}(${arguments_})`
    })
    return `import silk.${scalar.spelling}\npub fn floating${scalarOrdinal}() -> i32 {\n${calls.join('\n')}\n  return 0\n}`
  }),
  // Character operations use typed parameters so checked construction receives `u32` while
  // comparison and inspection receive `char`.
  ...Scalar.all()
    .filter((scalar) => scalar.category === 'Character')
    .map((scalar, scalarOrdinal) => {
      const calls = scalar.operations.map((operation, operationOrdinal) => {
        const parameters =
          operation.parameters ?? Array.from({ length: operation.arity }, () => scalar.spelling)
        const arguments_ = parameters.map((parameter, ordinal) => {
          if (parameter === 'u32') return 'number'
          return ordinal === 0 ? 'left' : 'right'
        })
        return `  let v${operationOrdinal} = ${scalar.spelling}.${operation.spelling}(${arguments_.join(', ')})`
      })
      return `import silk.${scalar.spelling}\npub fn character${scalarOrdinal}(number: u32, left: ${scalar.spelling}, right: ${scalar.spelling}) -> i32 {\n${calls.join('\n')}\n  return 0\n}`
    }),
  `import silk.bool
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.i32
import silk.layout { Layout }
import silk.usize
pub fn main() -> i32 {
  let i00 = i32.negate(1)
  let i01 = i32.add(1, 2)
  let i02 = i32.subtract(2, 1)
  let i03 = i32.multiply(2, 3)
  let i04 = i32.divide(4, 2)
  let i05 = i32.remainder(5, 2)
  let i06 = i32.equals(1, 1)
  let i07 = i32.notEquals(1, 2)
  let i08 = i32.lessThan(1, 2)
  let i09 = i32.lessOrEqual(1, 2)
  let i10 = i32.greaterThan(2, 1)
  let i11 = i32.greaterOrEqual(2, 1)
  let u00 = usize.add(1, 2)
  let u01 = usize.subtract(2, 1)
  let u02 = usize.multiply(2, 3)
  let u03 = usize.divide(4, 2)
  let u04 = usize.remainder(5, 2)
  let u05 = usize.equals(1, 1)
  let u06 = usize.notEquals(1, 2)
  let u07 = usize.lessThan(1, 2)
  let u08 = usize.lessOrEqual(1, 2)
  let u09 = usize.greaterThan(2, 1)
  let u10 = usize.greaterOrEqual(2, 1)
  let b00 = bool.equals(true, false)
  let b01 = bool.notEquals(true, false)
  let b02 = bool.not(false)
  let layout = Layout.of<i32>()
  let repeated = Layout.repeat(move layout, 2)
  let made = Layout.make(4, 4)
  let allocator = Allocator.systemAllocatorProvider()
  let unit = ()
  return i00
}`,
  `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
import silk.raw_buffer { RawBuffer }
import silk.slot { Slot }
fn useShared(value: &mut i32) -> i32 { return 42 }
fn conflictShared() -> i32 { return 0 }
effect fn storage() -> i32 ! OutOfMemoryError {
  let mut allocator = Allocator.systemAllocatorProvider()
  let layout = Layout.of<[i32; 2]>()
  let recipe = Effect.provideMut(Allocator.allocate(move layout), &mut allocator)
  let allocation = run recipe
  let coreLayout = Layout.of<i32>()
  let coreRecipe = Allocator.allocate(move coreLayout) |> Intrinsic.bindRequirementMut(&mut allocator)
  let coreAllocation = run coreRecipe
  drop coreAllocation
  let sharedLayout = Intrinsic.sharedLayout<i32>()
  let sharedRecipe = Allocator.allocate(move sharedLayout) |> Intrinsic.bindRequirementMut(&mut allocator)
  let sharedAllocation = run sharedRecipe
  unsafe {
    let shared = Intrinsic.sharedFromAllocation<i32>(move sharedAllocation, 42)
    let cloned = Intrinsic.sharedClone<i32>(&shared)
    let selected = Intrinsic.sharedWithMut<i32, i32>(&cloned, useShared, conflictShared)
    drop shared
    drop cloned
    let mut buffer = RawBuffer.from<i32>(move allocation, 2)
    let count = RawBuffer.count(&buffer)
    let firstSlot = RawBuffer.slot(&mut buffer, 0)
    let firstWrite = Slot.write(move firstSlot, 21)
    let secondSlot = RawBuffer.slot(&mut buffer, 1)
    let secondWrite = Slot.write(move secondSlot, 21)
    let read = RawBuffer.read<i32>(&buffer, 0)
    let copySlot = RawBuffer.slot(&mut buffer, 0)
    let copied = Slot.copy(move copySlot)
    let takeSlot = RawBuffer.slot(&mut buffer, 0)
    let taken = Slot.take(move takeSlot)
    let dropSlot = RawBuffer.slot(&mut buffer, 1)
    let dropped = Slot.dropValue(move dropSlot)
    drop buffer
    return read + copied + taken + selected
  }
  return 0
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(storage(), recover) }`,
  `import silk.allocator { Allocator, OutOfMemoryError }
import silk.execution { Execution }
fn ready(state: &()) -> () { return () }
fn complete(state: (), value: i32) -> () { return () }
fn suspend(state: (), execution: Intrinsic.Execution<i32>) -> () { drop execution return () }
effect fn packaged() -> () ! OutOfMemoryError ? &mut Allocator {
  let execution = run Execution.make(effect { return 42 }, (), ready)
  return run Execution.drive(move execution, (), complete, suspend)
}
pub fn main() -> i32 { return 42 }`,
  `import silk.execution { Execution }
struct Guard {}
fn register(wake: Intrinsic.Wake) -> Guard {
  Intrinsic.wake(move wake)
  return Guard {}
}
effect fn parking() -> () { return run Execution.park(register) }
pub fn main() -> i32 { return 42 }`,
  `import silk.effect { Effect }
import silk.i32
struct Problem {}
service Clock {}
struct FixedClock {}
impl Clock for FixedClock {}
effect fn succeed(value: i32) -> i32 { return value }
effect fn double(value: i32) -> i32 { return value * 2 }
effect fn observe(value: i32) -> i32 { return value }
effect fn risky() -> i32 ! Problem { fail Problem {} }
effect fn recover(error: Problem) -> i32 { return 1 }
effect fn read() -> i32 ? &Clock { return 20 }
effect fn acquire() -> FixedClock { return FixedClock {} }
pub fn main() -> i32 {
  let mapped = succeed(1) |> Effect.map(i32.add(1))
  let chained = mapped |> Effect.flatMap(double)
  let tapped = chained |> Effect.tap(observe)
  let retried = tapped |> Effect.retry(1)
  let handled = risky() |> Effect.catchAll(recover)
  let clock = FixedClock {}
  let provided = read() |> Effect.provide(&clock)
  let acquired = read() |> Effect.provideEffect(acquire())
  let retriedValue = run retried
  let handledValue = run handled
  let providedValue = run provided
  let acquiredValue = run acquired
  return retriedValue + handledValue + providedValue + acquiredValue
}`,
  `struct Opaque {}
fn pointers(value: &mut i32, values: &mut [u8], shared: &i32, view: &[u8]) -> i32 {
  let empty = Intrinsic.pointerNull<Opaque>()
  let missing = Intrinsic.pointerIsNull<?*mut Opaque>(empty)
  let address = Intrinsic.pointerAddress<?*mut Opaque>(empty)
  let constant = Intrinsic.pointerFromRef<i32>(shared)
  let mutable = Intrinsic.pointerFromMutRef<i32>(value)
  let first = Intrinsic.pointerFromSlice<u8>(view)
  let firstMut = Intrinsic.pointerFromMutSlice<u8>(values)
  unsafe {
    let bytes = Intrinsic.pointerBytes<i32>(constant)
    let many = Intrinsic.pointerRequalify<?[*]const u8, [*]const u8>(first)
    let manyMut = Intrinsic.pointerRequalify<?[*]mut u8, [*]mut u8>(firstMut)
    let second = Intrinsic.pointerAt<u8>(many, 1)
    let secondMut = Intrinsic.pointerAtMut<u8>(manyMut, 1)
    Intrinsic.pointerWrite<i32>(mutable, 7)
    Intrinsic.pointerWriteUnaligned<i32>(mutable, 8)
    let unaligned = Intrinsic.pointerReadUnaligned<i32>(constant)
    return Intrinsic.pointerRead<i32>(constant)
  }
  return 0
}`,
  `struct Counter { value: i32 }
fn replace(self: &mut Counter) -> i32 { return Intrinsic.replace(self.value, 42) }
pub fn main() -> i32 {
  let mut counter = Counter { value: 1 }
  return replace(&mut counter)
}`,
  `fn inspect(bytes: &[u8]) -> bool {
  let selected = Intrinsic.sliceView<u8>(bytes, 0, 0)
  unsafe {
    let text = Intrinsic.stringFromUtf8Unchecked(bytes)
    let raw = Intrinsic.stringUtf8Bytes(text)
    let length = Intrinsic.stringByteLength(text)
    return Intrinsic.stringEqualsExact(text, text)
  }
  return false
}`,
  `import silk.effect { Effect }
import silk.result { Result }
struct ResultProblem {}
effect fn succeed() -> i32 ! ResultProblem { return 42 }
pub effect fn main() -> i32 {
  let completed = run Effect.result(succeed())
  return match move completed {
      Result<i32, ResultProblem>.Success { value } => value
      Result<i32, ResultProblem>.Failure { error } => 0
  }
}`,
  `struct CatalogProblem {}
effect fn catalogRisky() -> i32 ! CatalogProblem { fail CatalogProblem {} }
effect fn catalogRecover(error: CatalogProblem) -> i32 { return 1 }
fn inspectCatch() -> once Effect<'static; i32> {
  return Intrinsic.catchFailure<CatalogProblem>(catalogRisky(), catalogRecover)
}
pub fn main() -> i32 { return 42 }`,
  `import silk.effect { Effect }
effect fn protected() -> i32 { return 42 }
effect fn release() -> () { return () }
fn inspectFinalize() -> once Effect<'static; i32> {
  return Intrinsic.finalizeEffectNonParking(protected(), release())
}
pub fn main() -> i32 { return 42 }`,
  `import silk.allocator { Allocator, OutOfMemoryError }
struct SuspendProblem {}
service SuspendClock {}
effect fn suspendDirect(
  deferred: once Effect<i32 ! SuspendProblem ? &SuspendClock>
) -> i32 ! SuspendProblem | OutOfMemoryError ? &SuspendClock | &mut Allocator {
  return run Intrinsic.suspendEffect(move deferred)
}
pub fn main() -> i32 { return 42 }`,
  `import silk.writer { Writer, WriterError }
import silk.writer { Writer, WriterError }
import silk.effect { Effect }
struct Sink {}
impl Writer for Sink {
  effect fn writeAll(self: &mut Self, bytes: &[u8]) -> () ! WriterError ? &mut Writer { return () }
  effect fn flush(self: &mut Self) -> () ! WriterError ? &mut Writer { return () }
}
pub effect fn main() -> () ! WriterError {
  let mut native = Sink {}
  let first = run Effect.provideMut(Writer.writeAll(b"out"), &mut native)
  let second = run Effect.provideMut(Writer.writeAll(b"error"), &mut native)
  return ()
}`,
])

it('models enumValue as a sealed declaration-dependent rule with no generic type hole', () => {
  const operation = Intrinsic.findOperation('Intrinsic', 'enumValue')
  assert.isDefined(operation)
  if (operation === undefined) return
  assert.strictEqual(operation.rule._tag, 'EnumValueRule')
  assert.deepEqual(operation.typeParameters, [])
  assert.deepEqual(operation.parameters, [{ name: 'value', type: '<owning enum>' }])
  assert.strictEqual(operation.result, '<owning enum representation>')
  assert.strictEqual(operation.consumer, 'language:scalar-enum-value')
})

it('uses one binding contract for inventory, admission, and the proof-only post hook', () => {
  for (const name of ['bindRequirement', 'bindRequirementMut', 'bindRequirementOwned']) {
    const operation = Intrinsic.findOperation('Intrinsic', name)
    const entry = Intrinsic.inventory().find(
      (candidate) => candidate.operation === `Intrinsic.${name}`,
    )
    assert.isDefined(operation)
    assert.isDefined(entry)
    if (operation === undefined || entry === undefined) continue
    assert.strictEqual(operation.rule._tag, 'ContractRule')
    if (operation.rule._tag !== 'ContractRule') continue
    assert.strictEqual(operation.rule.post, 'BindRequirement')
    assert.strictEqual(entry.signature, Intrinsic.signature(operation))
    assert.strictEqual(
      CallableContract.key(operation.rule.contract),
      CallableContract.key(operation.rule.contract),
    )
    assert.deepEqual(Object.keys(operation.rule).sort(), [
      '_tag',
      'contract',
      'post',
      'providerMode',
    ])
  }
})

it.effect(
  'pairs every intrinsic presentation with accepted semantic analysis',
  () =>
    Effect.gen(function* () {
      const observed = new Set<string>()
      for (const [ordinal, source] of acceptedSources.entries()) {
        const snapshot = yield* Analysis.ofSource(
          `intrinsic/accepted-${ordinal}`,
          encoder.encode(source),
        )
        assert.deepEqual(
          Analysis.diagnostics(snapshot),
          [],
          `accepted intrinsic fixture ${ordinal}`,
        )
        for (const operation of operationKeys(snapshot)) observed.add(operation)
      }
      const catalog = Intrinsic.all().flatMap((actor) =>
        actor.operations.flatMap((operation) =>
          operation.rule._tag === 'EnumValueRule' || operation.phase !== 'Runtime'
            ? []
            : [key(actor.spelling, operation.spelling)],
        ),
      )
      assert.deepEqual([...observed].sort(), [...catalog].sort())
    }),
  // This sweep takes about 45s in isolation but can exceed 180s while all four compiler shards
  // saturate the CI host; the timeout is contention headroom, not a performance assertion.
  300_000,
)

it.effect('keeps every intrinsic identifiable and presentable in rejected calls', () =>
  Effect.gen(function* () {
    for (const actor of Intrinsic.all())
      for (const operation of actor.operations) {
        if (
          operation.rule._tag === 'EnumValueRule' ||
          operation.rule._tag === 'StaticOnlyRule' ||
          operation.rule._tag === 'MixedFieldProjectionRule' ||
          operation.rule._tag === 'MixedTestFunctionRule'
        )
          continue
        const arguments_ = operation.parameters.length === 0 ? '0' : ''
        const source =
          operation.rule._tag === 'PlaceRule'
            ? `pub fn main() -> i32 { let mut value = 0 let rejected = Intrinsic.replace(value) return 0 }`
            : `pub fn main() -> i32 { let rejected = ${actor.spelling}.${operation.spelling}(${arguments_}) return 0 }`
        const snapshot = yield* Analysis.ofSource(
          `intrinsic/rejected-${actor.spelling}-${operation.spelling}`,
          encoder.encode(source),
        )
        assert.isAbove(Analysis.diagnostics(snapshot).length, 0)
        assert.include(operationKeys(snapshot), key(actor.spelling, operation.spelling))
        assert.include(Intrinsic.signature(operation), operation.spelling)
      }
  }),
)

it.effect('infers the suspension intrinsic exact Effect channels', () =>
  Effect.gen(function* () {
    const module = 'intrinsic/suspend-rows'
    const source = `struct Problem {}
service Clock {}
fn suspend<'env>(
  deferred: once Effect<'env; i32 ! Problem ? &Clock>
) -> once Effect<'env; i32 ! Problem ? &Clock> {
  return Intrinsic.suspendEffect(move deferred)
}
pub fn main() -> i32 { return 42 }`
    const snapshot = yield* AnalysisFixture.retainingMain(module, encoder.encode(source))
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const suspended = Analysis.expressionsOf(snapshot, module).find(
      (expression) => expression._tag === 'BuiltinCall' && expression.operation === 'EffectSuspend',
    )
    const type = suspended?._tag === 'BuiltinCall' ? suspended.type : undefined
    assert.isTrue(type !== undefined && Type.isEffect(type))
    if (type !== undefined && Type.isEffect(type)) {
      assert.strictEqual(type.access, 'Take')
      assert.strictEqual(type.success, 'i32')
      assert.deepEqual(Type.failureMembers(type).map(Type.encode), [`${module}.Problem`])
      assert.deepEqual(
        Type.requirementMembers(type).map((member) => Type.encode(member.capability)),
        [`${module}.Clock`],
      )
      assert.notStrictEqual(type.environment._tag, 'StaticLifetime')
    }
  }),
)

it.effect('keeps diagnostic observation infallible and preserves protected requirements', () =>
  Effect.gen(function* () {
    const module = 'intrinsic/observation-rows'
    const snapshot = yield* Analysis.ofSource(
      module,
      encoder.encode(`${observationWrapper}
struct Observer {}
service Clock {}
fn observer(state: &mut Observer, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { return 0 }
fn observe<'env>(body: once Effect<'env; i32 ? &Clock>) -> once Effect<'env; i32 ? &Clock> {
  return observing(Observer {}, observer, move body)
}
pub fn main() -> i32 { return 42 }`),
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    const observed = Analysis.expressionsOf(snapshot, module).find(
      (expression) =>
        expression._tag === 'Call' &&
        Type.isEffect(expression.type) &&
        expression.type.success === 'i32',
    )
    const type = observed?._tag === 'Call' ? observed.type : undefined
    assert.isTrue(type !== undefined && Type.isEffect(type))
    if (type !== undefined && Type.isEffect(type)) {
      assert.strictEqual(type.access, 'Take')
      assert.strictEqual(type.success, 'i32')
      assert.deepEqual(Type.failureMembers(type), [])
      assert.deepEqual(
        Type.requirementMembers(type).map((member) => Type.encode(member.capability)),
        [`${module}.Clock`],
      )
      assert.notStrictEqual(type.environment._tag, 'StaticLifetime')
    }
  }),
)

it.effect('rejects failures escaping the diagnostic observer lifetime', () =>
  Effect.gen(function* () {
    const snapshot = yield* Analysis.ofSource(
      'intrinsic/observation-escaping-failure',
      encoder.encode(`${observationWrapper}
struct Observer {}
struct Failure {}
fn observer(state: &mut Observer, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { return 0 }
effect fn failing() -> i32 ! Failure { fail Failure {} }
pub fn main() -> i32 {
  let observed = observing(Observer {}, observer, failing())
  return 42
}`),
    )
    assert.include(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'SEM0052',
    )
  }),
)

it.effect('rejects terminal observation proven outside selected recovery execution', () =>
  Effect.gen(function* () {
    for (const [name, entry, rejected] of [
      ['direct', 'let policy = terminal() return 42', true],
      ['lazy-body', 'return run lazy()', true],
      ['selected-helper', 'return run Intrinsic.catchFailure<Failure>(failed(), recover)', false],
      [
        'mixed-helper',
        'let policy = terminal() return run Intrinsic.catchFailure<Failure>(failed(), recover)',
        false,
      ],
    ] as const) {
      const source = `struct Failure {}
fn terminal() -> usize { return Intrinsic.observeUnhandled() }
effect fn lazy() -> i32 { let policy = terminal() return 42 }
effect fn failed() -> i32 ! Failure { fail Failure {} }
effect fn recover(error: Failure) -> i32 { drop error let policy = terminal() return 42 }
pub fn main() -> i32 { ${entry} }`
      const frontend = yield* AnalysisFixture.frontend(
        `intrinsic/terminal-${name}`,
        encoder.encode(source),
      )
      assert.deepEqual(Analysis.diagnostics(frontend), [])
      const snapshot = yield* Analysis.realize(frontend, frontend.configuration).pipe(
        Effect.provide(SourceResolver.empty),
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.deepEqual(
        diagnostics.map((entry) => entry.code),
        rejected ? ['SEM0217'] : [],
        name,
      )
      if (rejected)
        assert.deepEqual(
          diagnostics.map((entry) => source.slice(entry.span.start, entry.span.end).trim()),
          ['Intrinsic.observeUnhandled()'],
          name,
        )
    }
  }),
)

it.effect(
  'clears terminal context inside fresh observation but restores the enclosing handler',
  () =>
    Effect.gen(function* () {
      for (const [name, protectedBody, recovery, rejected] of [
        ['fresh-body', 'let policy = terminal() return 42', 'return run fresh()', true],
        ['owner-cleanup', 'return 42', 'return run fresh()', false],
        [
          'restored-handler',
          'return 42',
          'let done = run fresh() let policy = terminal() return 42',
          false,
        ],
        [
          'inner-handler',
          'return run Intrinsic.catchFailure<Failure>(failed(), inner)',
          'return run fresh()',
          false,
        ],
      ] as const) {
        const source = `${observationWrapper}
struct Failure {}
struct State {}
${name === 'owner-cleanup' ? 'impl Drop for State { fn drop(self: &mut State) -> () { let policy = terminal() return () } }' : ''}
fn observer(state: &mut State, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { return 0 }
fn terminal() -> usize { return Intrinsic.observeUnhandled() }
effect fn failed() -> i32 ! Failure { fail Failure {} }
effect fn inner(error: Failure) -> i32 { drop error let policy = terminal() return 42 }
effect fn protectedBody() -> i32 { ${protectedBody} }
effect fn fresh() -> i32 { return run observing(State {}, observer, protectedBody()) }
effect fn recover(error: Failure) -> i32 { drop error ${recovery} }
pub fn main() -> i32 { return run Intrinsic.catchFailure<Failure>(failed(), recover) }`
        const frontend = yield* AnalysisFixture.frontend(
          `intrinsic/terminal-${name}`,
          encoder.encode(source),
        )
        assert.deepEqual(Analysis.diagnostics(frontend), [])
        const snapshot = yield* Analysis.realize(frontend, frontend.configuration).pipe(
          Effect.provide(SourceResolver.empty),
        )
        const diagnostics = Analysis.diagnostics(snapshot)
        assert.deepEqual(
          diagnostics.map((entry) => entry.code),
          rejected ? ['SEM0217'] : [],
          name,
        )
        if (rejected)
          assert.deepEqual(
            diagnostics.map((entry) => source.slice(entry.span.start, entry.span.end).trim()),
            ['Intrinsic.observeUnhandled()'],
          )
      }
    }),
)

it.effect('isolates independent execution bodies while preserving selected drive callbacks', () =>
  Effect.gen(function* () {
    for (const [name, body, callback, readiness, rejected] of [
      ['independent-body', 'let policy = terminal() return 42', 'return ()', 'return ()', true],
      ['drive-callback', 'return 42', 'let policy = terminal() return ()', 'return ()', false],
      ['ready-callback', 'return 42', 'return ()', 'let policy = terminal() return ()', false],
    ] as const) {
      const source = `import silk.effect { Effect }
import silk.allocator { Allocator, OutOfMemoryError }
import silk.execution { Execution }
struct Failure {}
fn terminal() -> usize { return Intrinsic.observeUnhandled() }
effect fn failed() -> i32 ! Failure { fail Failure {} }
effect fn body() -> i32 { ${body} }
fn ready(state: &()) -> () { ${readiness} }
fn complete(state: (), value: i32) -> () { ${callback} }
fn suspended(state: (), execution: Intrinsic.Execution<i32>) -> () { drop execution return () }
effect fn noStorage(error: OutOfMemoryError) -> i32 { drop error return 0 }
effect fn recover(error: Failure) -> i32 ! OutOfMemoryError {
  drop error
  let mut allocator = Allocator.systemAllocatorProvider()
  let mut execution = run Execution.make(body(), (), ready) |> Effect.provideMut<Allocator>(&mut allocator)
  Execution.notifyInitial(&mut execution)
  run Execution.drive(move execution, (), complete, suspended)
  return 42
}
pub fn main() -> i32 {
  return run Intrinsic.catchFailure<OutOfMemoryError>(Intrinsic.catchFailure<Failure>(failed(), recover), noStorage)
}`
      const frontend = yield* AnalysisFixture.frontend(
        `intrinsic/terminal-${name}`,
        encoder.encode(source),
      )
      assert.deepEqual(Analysis.diagnostics(frontend), [])
      const snapshot = yield* Analysis.realize(frontend, frontend.configuration).pipe(
        Effect.provide(SourceResolver.empty),
      )
      const diagnostics = Analysis.diagnostics(snapshot)
      assert.deepEqual(
        diagnostics.map((entry) => entry.code),
        rejected ? ['SEM0217'] : [],
        name,
      )
      if (rejected)
        assert.deepEqual(
          diagnostics.map((entry) => source.slice(entry.span.start, entry.span.end).trim()),
          ['Intrinsic.observeUnhandled()'],
        )
    }
  }),
)

for (const [name, body, rejected] of [
  ['direct', 'return 0', false],
  ['nested-transfer', 'return run Effect.suspend(value())', true],
  ['lazy-only', 'let ignored = Effect.suspend(value()) return 0', false],
  ['cleanup-transfer', 'let guard = Guard {} return 0', true],
  ['explicit-cleanup', 'let guard = Guard {} drop guard return 0', true],
  ['callee-cleanup', 'return helper()', true],
  ['lazy-cleanup', 'let ignored = guarded() return 0', false],
  ['executed-cleanup', 'return run guarded()', true],
  ['replacement-cleanup', 'state.guard = Guard {} return 0', true],
] as const) {
  it.effect(`checks direct observer execution: ${name}`, () =>
    Effect.gen(function* () {
      const state = name === 'replacement-cleanup' ? 'Observer { guard: Guard {} }' : 'Observer {}'
      const call = `observing(${state}, observer, application())`
      const source = `${observationWrapper}
import silk.effect { Effect }
struct Observer { ${name === 'replacement-cleanup' ? 'guard: Guard' : ''} }
effect fn value() -> usize { return 0 }
struct Guard {}
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () { let done = run Effect.suspend(value()) return () }
}
fn helper() -> usize { let guard = Guard {} return 0 }
effect fn guarded() -> usize { let guard = Guard {} return 0 }
fn observer(state: &mut Observer, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { ${body} }
effect fn application() -> i32 { return 42 }
pub fn main() -> i32 {
  let observed = ${call}
  return 0
}`
      const frontend = yield* AnalysisFixture.frontend(
        `intrinsic/observer-${name}`,
        encoder.encode(source),
      )
      assert.deepEqual(Analysis.diagnostics(frontend), [])
      const snapshot = yield* Analysis.realize(frontend, frontend.configuration).pipe(
        Effect.provide(SourceResolver.empty),
      )
      const diagnostics = Analysis.diagnostics(snapshot).filter((entry) => entry.code === 'SEM0216')
      assert.strictEqual(diagnostics.length, rejected ? 1 : 0, name)
      if (rejected) {
        assert.deepEqual(
          diagnostics.map((entry) => entry.reason),
          [{ _tag: 'InvalidDiagnosticObserver', detail: 'NestedTransfer' }],
        )
        assert.deepEqual(
          diagnostics.map((entry) => source.slice(entry.span.start, entry.span.end)),
          [call],
        )
      }
    }),
  )
}

it.effect('rejects observation in the executed callback closure', () =>
  Effect.gen(function* () {
    for (const [name, body, rejected] of [
      ['direct', 'return run observing(State {}, leaf, value())', true],
      ['callee', 'return nested()', true],
      ['cycle', 'return cycleA(1)', true],
      ['cleanup', 'let guard = Guard {} return 0', true],
      [
        'lazy-owned-cleanup',
        'let ignored = observing(Guard {}, guardLeaf, value()) drop ignored return 0',
        true,
      ],
      [
        'lazy-owned-implicit',
        'let ignored = observing(Guard {}, guardLeaf, value()) return 0',
        true,
      ],
      ['parameter-cleanup', 'return discard(observing(Guard {}, guardLeaf, value()))', true],
      ['lazy', 'let ignored = observing(State {}, leaf, value()) drop ignored return 0', false],
      ['lazy-body', 'let ignored = guarded() drop ignored return 0', false],
      ['executed-body', 'return run guarded()', true],
    ] as const) {
      const source = `${observationWrapper}
${observationWrapper.replaceAll('observing', 'nestedObserving')}
struct State {}
effect fn value() -> usize { return 0 }
fn leaf(state: &mut State, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { return 0 }
fn nested() -> usize { return run nestedObserving(State {}, leaf, value()) }
fn cycleA(depth: i32) -> usize { if depth == 0 { return nested() } return cycleB(depth - 1) }
fn cycleB(depth: i32) -> usize { return cycleA(depth) }
fn discard<'env>(body: once Effect<'env; usize>) -> usize { drop body return 0 }
struct Guard {}
impl Drop for Guard { fn drop(self: &mut Guard) -> () { let done = nested() return () } }
fn guardLeaf(state: &mut Guard, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { return 0 }
effect fn guarded() -> usize { let guard = Guard {} return 0 }
fn observer(state: &mut State, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { ${body} }
pub fn main() -> i32 { let done = run observing(State {}, observer, value()) return 0 }`
      const frontend = yield* AnalysisFixture.frontend(
        `intrinsic/observer-recursion-${name}`,
        encoder.encode(source),
      )
      assert.deepEqual(Analysis.diagnostics(frontend), [], name)
      const snapshot = yield* Analysis.realize(frontend, frontend.configuration).pipe(
        Effect.provide(SourceResolver.empty),
      )
      const diagnostics = Analysis.diagnostics(snapshot).filter((entry) => entry.code === 'SEM0216')
      assert.deepEqual(
        Analysis.diagnostics(snapshot).filter((entry) => entry.code !== 'SEM0216'),
        [],
        name,
      )
      assert.strictEqual(diagnostics.length, rejected ? 1 : 0, name)
      if (rejected)
        assert.deepEqual(
          diagnostics.map((entry) => entry.reason),
          [
            {
              _tag: 'InvalidDiagnosticObserver',
              detail: 'callback execution recursively observes diagnostics',
            },
          ],
        )
    }
  }),
)

it.effect('retains distinct protected bodies in owned observer environments', () =>
  Effect.gen(function* () {
    const frontend = yield* AnalysisFixture.frontend(
      'intrinsic/observer-captures',
      encoder.encode(`${observationWrapper}
struct Observer { value: i32 }
impl Drop for Observer { fn drop(self: &mut Observer) -> () { return () } }
fn observer(state: &mut Observer, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>) -> usize { return 0 }
effect fn application() -> i32 { return 42 }
effect fn otherApplication() -> i32 { return 43 }
export "C" fn exported() -> i32 as "observer_abi_probe" { return 42 }
pub fn main() -> i32 {
  let observed = observing(Observer { value: 7 }, observer, application())
  let other = observing(Observer { value: 8 }, observer, otherApplication())
  drop other
  drop observed
  return 42
}`),
      'aarch64-apple-darwin',
    )
    assert.deepEqual(Analysis.diagnostics(frontend), [])
    const snapshot = yield* Analysis.realize(frontend, frontend.configuration).pipe(
      Effect.provide(SourceResolver.empty),
    )
    const environments = snapshot.instances.effects.filter(
      (entry) => entry.owner.declaration.name === 'observing',
    )
    assert.strictEqual(
      snapshot.mir._tag,
      'Available',
      snapshot.mir._tag === 'Unavailable' ? snapshot.mir.error.message : '',
    )
    const scopes = Analysis.loweredMir(snapshot)
      .functions.flatMap(MirVerification.operations)
      .filter((operation) => operation._tag === 'DiagnosticScope')
    assert.strictEqual(scopes.length, 2)
    assert.deepEqual(
      scopes.map((scope) => scope.stateCleanup._tag),
      ['HookCleanup', 'HookCleanup'],
    )
    assert.isTrue(
      scopes.every((scope) =>
        Mir.executionOperations(scope.body).some(
          (operation) =>
            operation._tag === 'RunEffectValue' ||
            operation._tag === 'RunStaticEffect' ||
            operation._tag === 'RunEffect',
        ),
      ),
    )
    for (const fn of Analysis.loweredMir(snapshot).functions) {
      const operations = MirVerification.operations(fn)
      for (const scope of operations.filter((operation) => operation._tag === 'DiagnosticScope')) {
        assert.isFalse(
          operations.some(
            (operation) =>
              operation._tag === 'Drop' && operation.local.ordinal === scope.state.ordinal,
          ),
        )
        const blocks = MirLinearization.linearize(fn)
        assert.isTrue(
          blocks.some(
            (block) =>
              block.recoveryBoundary?.ordinal === scope.destination.ordinal &&
              block.operations.some((operation) => operation._tag === 'RunEffectValue'),
          ),
        )
        const leaving =
          blocks.find((block) =>
            block.operations.some(
              (operation) =>
                operation._tag === 'LeaveDiagnosticScope' &&
                operation.scope.ordinal === scope.destination.ordinal,
            ),
          ) ?? unreachable('expected observation owner cleanup block')
        assert.notStrictEqual(leaving.recoveryBoundary?.ordinal, scope.destination.ordinal)
        const roots = NativeFunction.discoverRoots(fn, blocks)
        assert.isTrue(roots.address.has(scope.state.ordinal))
        assert.isTrue(roots.mutable.has(scope.state.ordinal))
        assert.isTrue(roots.address.has(scope.observer.ordinal))
        assert.isTrue(roots.mutable.has(scope.observer.ordinal))
        const path: Array<MirLinearization.LinearOperation> = []
        const visited = new Set<number>()
        let next = fn.entry
        while (!visited.has(next.ordinal)) {
          visited.add(next.ordinal)
          const block =
            blocks.find((candidate) => candidate.id.ordinal === next.ordinal) ??
            unreachable('observer execution has a missing control target')
          path.push(...block.operations)
          if (block.terminator._tag !== 'Jump') {
            assert.strictEqual(block.terminator._tag, 'Return')
            break
          }
          next = block.terminator.target
        }
        const enter = path.findIndex((operation) => operation._tag === 'EnterDiagnosticScope')
        const run = path.findIndex((operation) => operation._tag === 'RunEffectValue')
        const leave = path.findIndex((operation) => operation._tag === 'LeaveDiagnosticScope')
        const stateDrop = path.findIndex(
          (operation) =>
            operation._tag === 'Drop' && operation.local.ordinal === scope.state.ordinal,
        )
        const observerDrop = path.findIndex(
          (operation) =>
            operation._tag === 'Drop' && operation.local.ordinal === scope.observer.ordinal,
        )
        assert.isAtLeast(enter, 0)
        assert.isAbove(run, enter)
        assert.isAbove(leave, run)
        assert.isAbove(observerDrop, leave)
        assert.isAbove(stateDrop, observerDrop)
      }
    }
    assert.strictEqual(environments.length, 2)
    assert.deepEqual(
      environments.map((entry) => entry.captures.map((capture) => capture.access)),
      [
        ['Take', 'Take', 'Take'],
        ['Take', 'Take', 'Take'],
      ],
    )
    assert.deepEqual(
      environments.map((entry) => entry.type.access),
      ['Take', 'Take'],
    )
    assert.isTrue(
      environments.every((entry) => {
        const capture = entry.captures.at(1)
        if (capture === undefined || !Type.isRepresented(capture.type)) return false
        const argument = capture.type.representation.argument
        return (
          Type.isExactRepresentationArgument(argument) &&
          argument.identity._tag === 'CallableIdentityArgument'
        )
      }),
    )
    assert.isTrue(environments.every((entry) => entry.captures.at(2)?.effectIdentity !== undefined))
    assert.strictEqual(
      new Set(environments.map((entry) => entry.captures.at(2)?.effectIdentity)).size,
      2,
    )
    assert.deepEqual(
      environments.map((entry) => entry.captures.map((capture) => capture.sourceOrdinal)),
      [
        [0, 1, 2],
        [0, 1, 2],
      ],
    )
    const builder = yield* LlvmBuilder.make()
    const i32 = yield* LlvmType.integer(builder, 32)
    const pointer = yield* LlvmType.pointer(builder)
    const types: NativeType.LoweringContext = {
      program: Analysis.loweredMir(snapshot),
      i32,
      f32: yield* LlvmType.float(builder),
      f64: yield* LlvmType.double(builder),
      pointer,
      integerTypes: new Map(
        yield* Effect.forEach([8, 16, 32, 64], (bits) =>
          Effect.map(LlvmType.integer(builder, bits), (type) => [bits, type] as const),
        ),
      ),
    }
    const declarations = yield* NativeDeclare.functions({
      builder,
      types,
      lanePointers: { byteType: yield* LlvmType.integer(builder, 8), offsetType: i32 },
      program: types.program,
      i32,
      pointer,
      lanesFor: (type) => NativeType.lanesFor(types, type),
      laneType: (lane) => NativeType.laneType(types, lane),
    })
    const callbackDeclaration = declarations.declared.find(
      (entry) => entry.fn.id.name === 'observer',
    )
    assert.strictEqual(callbackDeclaration?.diagnosticParameter, 8)
    assert.strictEqual(callbackDeclaration?.parameterTypes.length, 10)
    assert.strictEqual(callbackDeclaration?.parameterTypes.at(8), pointer)
    yield* NativeDeclare.exportThunks({
      support: true,
      foreignGuard: undefined,
      builder,
      program: types.program,
      declared: declarations.declared,
      cType: (type) => (type._tag === 'Void' ? undefined : i32),
    })
    const exported = declarations.declared.find((entry) => entry.fn.id.name === 'exported')
    assert.isDefined(exported)
    const ir = yield* LlvmIrText.render(builder)
    assert.include(ir, 'define i32 @observer_abi_probe()')
    assert.include(
      ir,
      `call i32 @${exported?.symbol}(ptr null, { ptr, i64, ptr, i64, ptr, i64 } zeroinitializer)`,
    )
  }),
)

it.effect('retains the diagnostic state owner across a protected suspension', () =>
  Effect.gen(function* () {
    const frontend = yield* AnalysisFixture.frontend(
      'intrinsic/observer-suspension',
      encoder.encode(`${observationWrapper}
struct Observer { value: i32 }
impl Drop for Observer { fn drop(self: &mut Observer) -> () { return () } }
fn observer(state: &mut Observer, event: u8, first: usize, second: usize, identity: string<'static>, origin: string<'static>, salt: usize) -> usize { return salt }
struct Problem { code: i32 }
effect fn risky() -> i32 ! Problem {
  let resumed = run Intrinsic.suspendEffect(effect { return 0 })
  fail Problem { code: resumed }
}
import silk.effect { Effect }
effect fn recover(problem: Problem) -> i32 {
  let deferred = effect { return 42 + problem.code }
  let offset = run Intrinsic.suspendEffect(effect { return 0 })
  return (run Intrinsic.suspendEffect(deferred)) + offset
}
effect fn application() -> i32 { return run Effect.catchAll(risky(), recover) }
pub fn main() -> i32 { return run observing(Observer { value: 7 }, observer(11), application()) }`),
    )
    assert.deepEqual(Analysis.diagnostics(frontend), [])
    const snapshot = yield* Analysis.realize(frontend, frontend.configuration).pipe(
      Effect.provide(SourceResolver.empty),
    )
    assert.strictEqual(
      snapshot.mir._tag,
      'Available',
      snapshot.mir._tag === 'Unavailable' ? snapshot.mir.error.message : '',
    )
    const fn =
      Analysis.loweredMir(snapshot).functions.find((candidate) =>
        MirVerification.operations(candidate).some(
          (operation) => operation._tag === 'DiagnosticScope',
        ),
      ) ?? unreachable('expected an observer runner')
    const scope =
      MirVerification.operations(fn).find((operation) => operation._tag === 'DiagnosticScope') ??
      unreachable('expected a diagnostic scope')
    const relay = fn.suspension?.regions.find(
      (region) => region._tag === 'RunSuspendableEffectRegion',
    )
    assert.strictEqual(relay?._tag, 'RunSuspendableEffectRegion')
    const module = Analysis.loweredMir(snapshot)
    assert.isTrue(Mir.hasDiagnosticObservation(module))
    const withoutObservation = Object.freeze({ ...module, functions: Object.freeze([]) })
    assert.isFalse(Mir.hasDiagnosticObservation(withoutObservation))
    assert.deepEqual(Mir.coroutineFrameHeaderRoles(withoutObservation), ['Parent', 'State'])
    assert.deepEqual(Mir.diagnosticOutcomeLocals(withoutObservation, fn), [])
    const restoredObservation = Object.freeze({
      ...withoutObservation,
      functions: module.functions,
    })
    assert.isTrue(Mir.hasDiagnosticObservation(restoredObservation))
    assert.isFalse(Mir.hasDiagnosticObservation(withoutObservation))
    assert.isTrue(Mir.hasDiagnosticObservation(module))
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const frames = module.coroutineFrames ?? unreachable('expected observer continuation frames')
    for (const frame of frames.entries) {
      assert.deepEqual(
        frame.header.map((field) => field.role),
        Mir.coroutineFrameHeaderRoles(module),
      )
      assert.strictEqual(frame.header.at(2)?.offset, module.layout.target.pointerSize * 2)
      for (const state of frame.states)
        for (const field of state.payload)
          assert.isAtLeast(field.offset, module.layout.target.pointerSize * 15)
    }
    const metadataFields = frames.entries.flatMap((frame) => frame.diagnosticOutcomes)
    assert.isAbove(metadataFields.length, 0)
    assert.include(MirEncoding.encode(module), 'diagnostic-outcome %')
    const recoveredRunners = module.functions.filter(
      (candidate) =>
        Mir.diagnosticOutcomeLocals(module, candidate).length > 0 &&
        MirLinearization.linearize(candidate).some(
          (block) => (block.recoveryOutcomes?.length ?? 0) > 0,
        ),
    )
    const controlKinds = recoveredRunners.flatMap(
      (candidate) =>
        candidate.suspension?.regions.flatMap((region) => {
          if (region._tag !== 'RunSuspendableEffectRegion') return []
          assert.deepEqual(
            [region.point.sourceId, region.point.spanStart, region.point.spanEnd],
            [
              region.operation.provenance.span.sourceId,
              region.operation.provenance.span.start,
              region.operation.provenance.span.end,
            ],
          )
          assert.isDefined(region.relay.state)
          return [region.operation._tag]
        }) ?? [],
    )
    assert.include(controlKinds, 'CatchEffect')
    assert.include(controlKinds, 'RunEffectValue')
    const recovery =
      module.functions.find((candidate) => candidate.id.name === 'recover$effect$-1') ??
      unreachable('expected the suspended recovery handler')
    const recoveryFrame =
      frames.entries.find((frame) => Mir.matchesInstanceKey(recovery, frame.function)) ??
      unreachable('expected the recovery continuation frame')
    assert.isAtLeast(recoveryFrame.states.length, 2)
    assert.isTrue(
      recoveryFrame.states.every((state) =>
        state.payload.some((field) => field.local.ordinal === 0),
      ),
      'the suspended child borrows the failure payload until it completes',
    )

    for (const frame of frames.entries) {
      const descriptorsEnd = Math.max(
        ...frame.states.map((state) => state.size),
        ...frame.diagnosticScopes.map(
          (field) => field.offset + module.layout.target.pointerSize * Mir.diagnosticScopeWords,
        ),
      )
      for (const field of frame.diagnosticOutcomes) {
        assert.isAtLeast(field.offset, descriptorsEnd)
        assert.isAtLeast(
          frame.size,
          field.offset + module.layout.target.pointerSize * Mir.diagnosticOutcomeWords,
        )
      }
    }
    const invalidOutcomes = {
      ...module,
      coroutineFrames: {
        ...frames,
        entries: frames.entries.map((frame) => ({
          ...frame,
          diagnosticOutcomes: frame.diagnosticOutcomes.map((field) => ({ ...field, offset: 0 })),
        })),
      },
    }
    assert.isAbove((yield* MirVerification.verify(invalidOutcomes)).length, 0)
    const ownedFrame =
      frames.entries.find((frame) => Mir.matchesInstanceKey(fn, frame.function)) ??
      unreachable('expected the observer owner frame')
    const descriptor =
      ownedFrame.diagnosticScopes.find(
        (field) => field.scope.ordinal === scope.destination.ordinal,
      ) ?? unreachable('expected persistent scope descriptor')
    assert.isAtLeast(descriptor.offset, Math.max(...ownedFrame.states.map((state) => state.size)))
    assert.isAtLeast(ownedFrame.size, descriptor.offset + module.layout.target.pointerSize * 10)
    const overlapping = {
      ...module,
      coroutineFrames: {
        ...frames,
        entries: frames.entries.map((frame) =>
          frame === ownedFrame
            ? {
                ...frame,
                diagnosticScopes: frame.diagnosticScopes.map((field) =>
                  field === descriptor ? { ...field, offset: 0 } : field,
                ),
              }
            : frame,
        ),
      },
    }
    assert.isTrue(
      (yield* MirVerification.verify(overlapping)).some(
        (violation) => violation.rule === 'InvalidCoroutineFrame',
      ),
    )
    const state = relay?.relay.state ?? unreachable('expected retained observer state')
    const slot = state.slots.find((candidate) => candidate.local.ordinal === scope.state.ordinal)
    assert.strictEqual(slot?.access._tag, 'AffineTransfer')
    if (slot?.access._tag === 'AffineTransfer')
      assert.strictEqual(slot.access.cleanup._tag, 'HookCleanup')
    assert.isTrue(
      state.failure.releases.some((release) => release.local.ordinal === scope.state.ordinal),
    )
    assert.isTrue(slot !== undefined && state.success.restores.includes(slot.ordinal))
    const callback = state.slots.find(
      (candidate) => candidate.local.ordinal === scope.observer.ordinal,
    )
    assert.strictEqual(callback?.type._tag, 'CallableValue')
    assert.isTrue(callback !== undefined && state.success.restores.includes(callback.ordinal))
  }),
)

it.effect('does not retain provideWith as a compatibility alias', () =>
  Effect.gen(function* () {
    const snapshot = yield* AnalysisFixture.retainingMain(
      'effect/no-provide-with-alias',
      encoder.encode(`import silk.effect { Effect }
service Clock {}
struct FixedClock {}
impl Clock for FixedClock {}
effect fn read() -> i32 ? &Clock { return 1 }
effect fn acquire() -> FixedClock { return FixedClock {} }
pub fn main() -> i32 { return run (read() |> Effect.provideWith(acquire())) }`),
    )
    assert.include(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'SEM0010',
    )
  }),
)

it('admits the Pointer actor with one invariant per unsafe primitive', () => {
  const pointer = Intrinsic.inventory().filter((entry) =>
    entry.operation.startsWith('Intrinsic.pointer'),
  )
  assert.deepEqual(
    pointer.map((entry) => [entry.operation, entry.unsafe, entry.invariant !== undefined]),
    [
      ['Intrinsic.pointerBytes', true, true],
      ['Intrinsic.pointerRequalify', true, true],
      ['Intrinsic.pointerReinterpret', true, true],
      ['Intrinsic.pointerReadUnaligned', true, true],
      ['Intrinsic.pointerWriteUnaligned', true, true],
      ['Intrinsic.pointerNull', false, false],
      ['Intrinsic.pointerIsNull', false, false],
      ['Intrinsic.pointerAddress', false, false],
      ['Intrinsic.pointerFromRef', false, false],
      ['Intrinsic.pointerFromMutRef', false, false],
      ['Intrinsic.pointerFromSlice', false, false],
      ['Intrinsic.pointerFromMutSlice', false, false],
      ['Intrinsic.pointerAt', true, true],
      ['Intrinsic.pointerAtMut', true, true],
      ['Intrinsic.pointerRead', true, true],
      ['Intrinsic.pointerWrite', true, true],
    ],
  )
  assert.isTrue(pointer.every((entry) => entry.admission === 'Ownership'))
  assert.isTrue(
    pointer.every(
      (entry) => JSON.stringify(entry.targets) === JSON.stringify(Intrinsic.runtimeTargets),
    ),
  )
  assert.strictEqual(
    pointer.find((entry) => entry.operation === 'Intrinsic.pointerFromMutSlice')?.signature,
    'fn Intrinsic.pointerFromMutSlice<T>(values: &mut [T]) -> ?[*]mut T',
  )
})

it('keeps catalog ordering stable across fresh reads', () => {
  const first = Intrinsic.all().map((actor) => ({
    actor: actor.spelling,
    operations: actor.operations.map((operation) => operation.spelling),
  }))
  const second = Intrinsic.all().map((actor) => ({
    actor: actor.spelling,
    operations: actor.operations.map((operation) => operation.spelling),
  }))
  assert.deepEqual(second, first)
})

it('indexes every actor and operation without changing catalog identity', () => {
  for (const actor of Intrinsic.all()) {
    assert.strictEqual(Intrinsic.findActor(actor.spelling), actor)
    for (const operation of actor.operations) {
      assert.strictEqual(Intrinsic.findOperation(actor.spelling, operation.spelling), operation)
      assert.strictEqual(Intrinsic.findOperationById(operation.id), operation)
    }
  }
  for (const scalar of Scalar.all())
    for (const operation of scalar.operations) {
      const resolved = Intrinsic.findOperation(scalar.spelling, operation.spelling)
      assert.notStrictEqual(resolved, undefined)
      if (resolved !== undefined)
        assert.strictEqual(resolved, Intrinsic.findOperation('Intrinsic', resolved.spelling))
    }
  assert.strictEqual(Intrinsic.findActor('Missing'), undefined)
  assert.strictEqual(Intrinsic.findOperation('Intrinsic', 'missing'), undefined)
  assert.strictEqual(Intrinsic.findOperation('missing', 'add'), undefined)
  assert.strictEqual(
    Intrinsic.findOperationById({
      _tag: 'IntrinsicOperationId',
      actor: 'Intrinsic',
      name: 'missing',
    }),
    undefined,
  )
})

it('contains no compiler repository identity for the migrated system clock', () => {
  const source = readFileSync(new URL('../src/Intrinsic.ts', import.meta.url), 'utf8')
  assert.notInclude(source, "spelling === 'systemClockNow'")
  assert.notInclude(source, "spelling === 'systemClockResolution'")
  assert.deepEqual(
    Intrinsic.inventory().filter(
      (entry) =>
        entry.operation.includes('SystemClock') ||
        entry.consumer.startsWith('silk/os_system_clock'),
    ),
    [],
  )
})

it('matches the checked intrinsic inventory and records every unsafe invariant', () => {
  const fixture: unknown = JSON.parse(
    readFileSync(new URL('./fixtures/intrinsic-inventory.json', import.meta.url), 'utf8'),
  )
  const entries = Intrinsic.inventory().map((entry) => ({
    operation: entry.operation,
    signature: entry.signature,
    unsafe: entry.unsafe,
    admission: entry.admission,
    consumer: entry.consumer,
    ...(entry.tir === undefined ? {} : { identity: entry.tir }),
    ...(entry.invariant === undefined ? {} : { invariant: entry.invariant }),
  }))
  assert.deepEqual(fixture, { targets: Intrinsic.runtimeTargets, entries })
  assert.deepEqual(
    Intrinsic.all().map((actor) => actor.spelling),
    ['string', 'Intrinsic'],
  )
  assert.isTrue(entries.every((entry) => entry.consumer.length > 0))
  assert.isTrue(entries.filter((entry) => entry.unsafe).every((entry) => 'invariant' in entry))
  assert.deepEqual(
    Intrinsic.inventory()
      .filter((entry) => entry.operation.startsWith('Intrinsic.shared'))
      .map((entry) => entry.operation),
    [
      'Intrinsic.sharedLayout',
      'Intrinsic.sharedFromAllocation',
      'Intrinsic.sharedClone',
      'Intrinsic.sharedWithMut',
    ],
  )
  assert.deepEqual(
    Intrinsic.inventory()
      .filter((entry) => entry.operation.toLowerCase().includes('suspend'))
      .map((entry) => ({
        operation: entry.operation,
        signature: entry.signature,
        targets: entry.targets,
      })),
    [
      {
        operation: 'Intrinsic.suspendEffect',
        signature:
          'fn Intrinsic.suspendEffect<A, E, ?R>(deferred: once Effect<A ! E ? R>) -> Effect<A ! E ? R>',
        targets: Intrinsic.runtimeTargets,
      },
    ],
  )
  const externalParking = Intrinsic.inventory().filter(
    (entry) => entry.consumer === 'language:external-wake-parking',
  )
  assert.deepEqual(
    externalParking.map((entry) => ({
      operation: entry.operation,
      signature: entry.signature,
      unsafe: entry.unsafe,
      targets: entry.targets,
    })),
    [
      {
        operation: 'Intrinsic.wake',
        signature: 'fn Intrinsic.wake(wake: Wake) -> ()',
        unsafe: false,
        targets: Intrinsic.runtimeTargets,
      },
      {
        operation: 'Intrinsic.park',
        signature: 'fn Intrinsic.park<G, F>(register: F) -> Effect<()>',
        unsafe: false,
        targets: Intrinsic.runtimeTargets,
      },
    ],
  )
  assert.isFalse(
    externalParking.some((entry) =>
      /cancel|destroy|scheduler|timer|payload|allocator/i.test(
        `${entry.operation} ${entry.signature} ${entry.tir}`,
      ),
    ),
  )
})

it('classifies targetPointerBits as a static-only u32 intrinsic with no runtime identity', () => {
  const operation = Intrinsic.findOperation('Intrinsic', 'targetPointerBits')
  assert.isDefined(operation)
  if (operation === undefined) return
  assert.deepEqual(
    {
      signature: Intrinsic.signature(operation),
      phase: operation.phase,
      parameters: operation.parameters,
      result: operation.result,
      unsafe: operation.unsafe,
      targets: operation.targets,
      rule: operation.rule,
    },
    {
      signature: 'fn Intrinsic.targetPointerBits() -> u32',
      phase: 'StaticOnly',
      parameters: [],
      result: 'u32',
      unsafe: false,
      targets: [],
      rule: {
        _tag: 'StaticOnlyRule',
        contract: {
          functionKind: 'Function',
          unsafe: false,
          environment: Lifetime.staticLifetime,
          lifetimeBinders: [],
          lifetimeBounds: [],
          typeOutlives: [],
          binders: [],
          parameters: [],
          result: 'u32',
          constraints: [],
          captures: [],
        },
      },
    },
  )
  const entry = Intrinsic.inventory().find(
    (candidate) => candidate.operation === 'Intrinsic.targetPointerBits',
  )
  assert.deepEqual(entry, {
    operation: 'Intrinsic.targetPointerBits',
    signature: 'fn Intrinsic.targetPointerBits() -> u32',
    unsafe: false,
    phase: 'StaticOnly',
    admission: 'Language',
    consumer: 'silk/target.targetPointerBits',
    targets: [],
  })
})

it('keeps reflection metadata and static sequences sealed to static evaluation', () => {
  const operations = [
    ['reflectType', 1],
    ['reflectFields', 1],
    ['reflectTypeKind', 1],
    ['reflectFieldKind', 2],
    ['reflectFieldLabel', 2],
    ['reflectFieldOrdinal', 2],
    ['staticSequenceEmpty', 1],
    ['staticSequenceAppend', 1],
    ['staticSequenceConcat', 1],
    ['staticSequenceLength', 1],
    ['staticSequenceAt', 1],
  ] as const
  for (const [name, arity] of operations) {
    const operation = Intrinsic.findOperation('Intrinsic', name)
    assert.isDefined(operation)
    if (operation === undefined) continue
    assert.strictEqual(operation.phase, 'StaticOnly')
    assert.strictEqual(operation.rule._tag, 'StaticOnlyRule')
    assert.strictEqual(operation.typeParameters.length, arity)
    assert.deepEqual(operation.targets, [])
  }
  for (const [name, arity] of [
    ['Intrinsic.Type', 1],
    ['Intrinsic.Fields', 1],
    ['Intrinsic.Field', 2],
    ['Intrinsic.StaticSequence', 1],
  ] as const) {
    const nominal = Type.intrinsicNominals.get(name)
    assert.isDefined(nominal)
    if (nominal === undefined) continue
    assert.strictEqual(Type.intrinsicNominalArity(nominal), arity)
    assert.isFalse(Type.runtimeAvailable(nominal))
  }
})

it('models borrowField as one mixed shared lane plus one consumed static lane', () => {
  const operation = Intrinsic.findOperation('Intrinsic', 'borrowField')
  assert.isDefined(operation)
  if (operation === undefined) return
  assert.strictEqual(operation.phase, 'Mixed')
  assert.strictEqual(operation.rule._tag, 'MixedFieldProjectionRule')
  assert.deepEqual(operation.parameters, [
    { name: 'owner', type: '&Owner' },
    { name: 'field', type: 'Field<Owner, Value>', phase: 'Static' },
  ])
  if (operation.rule._tag !== 'MixedFieldProjectionRule') return
  assert.deepEqual(
    Type.storageLifetimes(operation.rule.contract.parameters[0]?.type ?? Type.unit),
    Type.storageLifetimes(operation.rule.contract.result),
  )
  assert.strictEqual(
    Intrinsic.signature(operation),
    'fn Intrinsic.borrowField<Owner, Value>(owner: &Owner, static field: Field<Owner, Value>) -> &Value',
  )
  const entry = Intrinsic.inventory().find(
    (candidate) => candidate.operation === 'Intrinsic.borrowField',
  )
  assert.deepEqual(entry, {
    operation: 'Intrinsic.borrowField',
    signature:
      'fn Intrinsic.borrowField<Owner, Value>(owner: &Owner, static field: Field<Owner, Value>) -> &Value',
    unsafe: false,
    phase: 'Mixed',
    admission: 'Language',
    consumer: 'silk/reflect.borrowField',
    targets: [],
  })
})

it.effect(
  'resolves former scalar actor spellings to source wrappers, not compiler identities',
  () =>
    Effect.gen(function* () {
      const source = 'import silk.i32\npub fn main() -> i32 { return i32.add(20, 22) }'
      const snapshot = yield* AnalysisFixture.retainingMain(
        'intrinsic/source-wrapper',
        encoder.encode(source),
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const occurrence = Analysis.semanticOccurrenceAt(
        snapshot,
        'intrinsic/source-wrapper',
        source.indexOf('add'),
      )
      assert.strictEqual(occurrence?.resolution._tag, 'Available')
      if (occurrence?.resolution._tag === 'Available')
        assert.strictEqual(occurrence.resolution.identity._tag, 'DeclarationIdentity')
      assert.strictEqual(occurrence?.declaration?.module, 'silk/i32')
    }),
)

it.effect('rejects numeric operands to raw pointer address observation at the call span', () =>
  Effect.gen(function* () {
    const source = 'pub fn main() -> i32 { let a = Intrinsic.pointerAddress<i32>(1) return 0 }'
    const snapshot = yield* AnalysisFixture.retainingMain(
      'pointer/address-invalid',
      encoder.encode(source),
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((entry) => [entry.code, entry.span.start, entry.span.end]),
      [['SEM0215', 31, 63]],
    )
  }),
)

it.effect('keeps failure metadata attached to its originating observer', () =>
  Effect.gen(function* () {
    for (const bits of [32, 64]) {
      const builder = yield* LlvmBuilder.make()
      const pointer = yield* LlvmType.pointer(builder)
      const byte = yield* LlvmType.integer(builder, 8)
      const word = yield* LlvmType.integer(builder, bits)
      const resultType = yield* LlvmType.structure(builder, [
        pointer,
        word,
        pointer,
        word,
        pointer,
        word,
      ])
      const fn = yield* LlvmFunction.declare(
        builder,
        'failure_metadata',
        yield* LlvmType.functionType(builder, resultType, [pointer, pointer, pointer, pointer]),
      )
      yield* Emitter.module(builder, (builder) =>
        Emitter.buildBody(builder, fn, (body) => {
          Emitter.block(body, 'entry')
          const first = Emitter.argument(body, 0)
          const second = Emitter.argument(body, 1)
          const identity = Object.freeze([
            Emitter.argument(body, 2),
            Emitter.integerUnsigned(builder, word, 7n),
          ] as const)
          const origin = Object.freeze([
            Emitter.argument(body, 3),
            Emitter.integerUnsigned(builder, word, 9n),
          ] as const)
          const context = NativeDiagnosticContext.make(builder, body, pointer, byte, word, first)
          const failure = NativeDiagnosticFailure.produce(context, identity, origin)
          // A later lexical observer must not receive the original pool's handles.
          Emitter.store(body, second, context.current)
          const retained = NativeDiagnosticFailure.retain(failure, context)
          const propagated = NativeDiagnosticFailure.propagate(retained, context, identity)
          const combined = NativeDiagnosticFailure.withCause(propagated, context, failure)
          NativeDiagnosticFailure.release(retained, context)
          NativeDiagnosticFailure.release(propagated, context)
          NativeDiagnosticFailure.release(failure, context)
          assert.strictEqual(combined.observer, failure.observer)
          assert.strictEqual(combined.identity, identity)
          assert.strictEqual(combined.origin, origin)
          NativeDiagnosticFailure.unhandled(combined, context)
          const restored = NativeDiagnosticFailure.unpack(
            context,
            NativeDiagnosticFailure.pack(combined, context),
          )
          Emitter.returnValue(body, NativeDiagnosticFailure.pack(restored, context))
        }),
      )
      const ir = yield* LlvmIrText.render(builder)
      assert.lengthOf(ir.match(/load ptr, ptr %diagnostic_observer_slot/g) ?? [], 1)
      assert.include(ir, `ret { ptr, i${bits}, ptr, i${bits}, ptr, i${bits} }`)
      assert.include(ir, 'diagnostic_cause_invalid_owner:')
      assert.include(ir, 'call void @llvm.trap()')
    }
  }),
)

it.effect('forwards borrowed invocation causes and clears independent execution roots', () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const bits of [32, 64]) {
        const builder = yield* LlvmBuilder.make()
        const pointer = yield* LlvmType.pointer(builder)
        const byte = yield* LlvmType.integer(builder, 8)
        const word = yield* LlvmType.integer(builder, bits)
        const causeType = yield* Emitter.module(builder, (builder) =>
          NativeDiagnosticFailure.type({ builder, pointer, word }),
        )
        const signature = yield* LlvmType.functionType(builder, causeType, [pointer, causeType])
        const callee = yield* LlvmFunction.declare(builder, 'cause_receiver', signature)
        const caller = yield* LlvmFunction.declare(builder, 'cause_caller', signature)
        yield* Emitter.module(builder, (builder) =>
          Emitter.buildBody(builder, caller, (body) => {
            Emitter.block(body, 'entry')
            const incoming = Emitter.argument(body, 1)
            const diagnostic = NativeDiagnosticContext.make(
              builder,
              body,
              pointer,
              byte,
              word,
              Emitter.argument(body, 0),
              incoming,
            )
            assert.strictEqual(diagnostic.incomingCause, incoming)
            const inherited = NativeCall.argumentsFor(
              { diagnostic },
              { diagnosticParameter: 0 },
              [],
            )
            const independent = NativeCall.argumentsFor(
              { diagnostic },
              { diagnosticParameter: 0 },
              [],
              'Independent',
            )
            const result = Emitter.callDirect(body, callee, inherited, 'inherited')
            Emitter.callDirect(body, callee, independent, 'independent')
            Emitter.returnValue(body, result ?? unreachable('expected borrowed cause result'))
          }),
        )
        const ir = yield* LlvmIrText.render(builder)
        const aggregate = `{ ptr, i${bits}, ptr, i${bits}, ptr, i${bits} }`
        assert.include(ir, `store ${aggregate} %v1, ptr %diagnostic_cause_slot`)
        assert.include(
          ir,
          `@cause_receiver(ptr %diagnostic_observer, ${aggregate} %diagnostic_cause)`,
        )
        assert.include(ir, `@cause_receiver(ptr null, ${aggregate} zeroinitializer)`)
        assert.lengthOf(ir.match(/load .*ptr %diagnostic_cause_slot/g) ?? [], 1)
      }
    }),
  ),
)

it.effect('disables terminal dispatch for absent or foreign observer contexts', () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const bits of [32, 64]) {
        const builder = yield* LlvmBuilder.make()
        const pointer = yield* LlvmType.pointer(builder)
        const byte = yield* LlvmType.integer(builder, 8)
        const word = yield* LlvmType.integer(builder, bits)
        const causeType = yield* Emitter.module(builder, (builder) =>
          NativeDiagnosticFailure.type({ builder, pointer, word }),
        )
        const caller = yield* LlvmFunction.declare(
          builder,
          'terminal_context',
          yield* LlvmType.functionType(builder, word, [pointer, causeType]),
        )
        yield* Emitter.module(builder, (builder) =>
          Emitter.buildBody(builder, caller, (body) => {
            Emitter.block(body, 'entry')
            const context = NativeDiagnosticContext.make(
              builder,
              body,
              pointer,
              byte,
              word,
              Emitter.argument(body, 0),
              Emitter.argument(body, 1),
            )
            Emitter.returnValue(body, NativeDiagnosticContext.unhandled(context))
          }),
        )
        const ir = yield* LlvmIrText.render(builder)
        assert.include(
          ir,
          `%unhandled_selected_observer = icmp eq i${bits} %unhandled_cause_owner_address, %unhandled_current_observer_address`,
        )
        assert.include(
          ir,
          '%unhandled_observer = select i1 %unhandled_selected_observer, ptr %diagnostic_failure0, ptr null',
        )
        assert.include(ir, `icmp ne i${bits} %diagnostic_observer_address, 0`)
        assert.include(ir, `i8 5, i${bits} %diagnostic_failure1, i${bits} 0`)
        assert.match(ir, /phi i(?:32|64).*\[ 0, %diagnostic_disabled \]/)
        assert.lengthOf(ir.match(/load ptr, ptr %diagnostic_observer_slot/g) ?? [], 1)
        assert.lengthOf(ir.match(/call i(?:32|64) /g) ?? [], 1)
      }
    }),
  ),
)

it.effect('guards fatal cause handles by their originating observer', () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const bits of [32, 64]) {
        const builder = yield* LlvmBuilder.make()
        const pointer = yield* LlvmType.pointer(builder)
        const byte = yield* LlvmType.integer(builder, 8)
        const word = yield* LlvmType.integer(builder, bits)
        const causeType = yield* Emitter.module(builder, (builder) =>
          NativeDiagnosticFailure.type({ builder, pointer, word }),
        )
        const signature = yield* LlvmType.functionType(builder, word, [pointer, causeType, pointer])
        const caller = yield* LlvmFunction.declare(builder, 'fatal_cause', signature)
        yield* Emitter.module(builder, (builder) =>
          Emitter.buildBody(builder, caller, (body) => {
            Emitter.block(body, 'entry')
            const diagnostic = NativeDiagnosticContext.make(
              builder,
              body,
              pointer,
              byte,
              word,
              Emitter.argument(body, 0),
              Emitter.argument(body, 1),
            )
            const text = Object.freeze([
              Emitter.argument(body, 2),
              Emitter.integerUnsigned(builder, word, 7n),
            ] as const)
            Emitter.returnValue(body, NativeDiagnosticContext.fatal(diagnostic, text, text))
          }),
        )
        const ir = yield* LlvmIrText.render(builder)
        assert.include(
          ir,
          `%fatal_cause_owner_matches = icmp eq i${bits} %fatal_observer_address, %fatal_cause_owner_address`,
        )
        assert.include(
          ir,
          `%fatal_cause_handle = select i1 %fatal_cause_owner_matches, i${bits} %diagnostic_failure1, i${bits} 0`,
        )
        assert.include(ir, `i8 6, i${bits} %fatal_cause_handle, i${bits} 0`)
        assert.lengthOf(ir.match(/load ptr, ptr %diagnostic_observer_slot/g) ?? [], 1)
        assert.lengthOf(ir.match(/call i(?:32|64) /g) ?? [], 1)
      }
    }),
  ),
)

it.effect('keeps private return metadata separate from source result lanes', () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const bits of [32, 64]) {
        const builder = yield* LlvmBuilder.make()
        const pointer = yield* LlvmType.pointer(builder)
        const word = yield* LlvmType.integer(builder, bits)
        const payloadType = yield* LlvmType.integer(builder, 32)
        const diagnosticType = yield* Emitter.module(builder, (builder) =>
          NativeDiagnosticFailure.type({ builder, pointer, word }),
        )
        const resultType = yield* LlvmType.structure(builder, [payloadType, diagnosticType])
        const signature = yield* LlvmType.functionType(builder, resultType, [
          payloadType,
          diagnosticType,
        ])
        const receiver = yield* LlvmFunction.declare(builder, 'result_receiver', signature)
        const producer = yield* LlvmFunction.declare(builder, 'result_producer', signature)
        const stepReceiver = yield* LlvmFunction.declare(
          builder,
          'result_step_receiver',
          yield* LlvmType.functionType(
            builder,
            yield* LlvmType.structure(builder, [payloadType, payloadType, diagnosticType]),
            [payloadType, diagnosticType],
          ),
        )
        const shape = { resultLaneCount: 1, diagnosticResult: true }
        yield* Emitter.module(builder, (builder) =>
          Emitter.buildBody(builder, producer, (body) => {
            Emitter.block(body, 'entry')
            const values = [Emitter.argument(body, 0)]
            const diagnostic = Emitter.argument(body, 1)
            assert.throws(() => NativeResult.sourceValues({ values, diagnostic }), /cannot discard/)
            assert.throws(
              () => NativeResult.fields({ values }, shape),
              /diagnostic ownership shape/,
            )
            assert.throws(
              () =>
                NativeResult.fields({ values, diagnostic }, { ...shape, diagnosticResult: false }),
              /diagnostic ownership shape/,
            )
            assert.throws(
              () => NativeResult.fields({ values: [], diagnostic }, shape),
              /source lane count/,
            )
            const called = Emitter.callDirect(
              body,
              receiver,
              NativeResult.fields({ values, diagnostic }, shape),
              'returned',
            )
            const unpacked = NativeResult.unpack(body, shape, called, 'returned')
            const stepped = Emitter.callDirect(
              body,
              stepReceiver,
              NativeResult.fields(unpacked, shape),
              'stepped',
            )
            const resumed = NativeResult.unpack(body, shape, stepped, 'resumed', 'SuspensionStep')
            const transfer = {
              builder,
              body,
              wordSize: bits / 8,
              transfer: Emitter.alloca(body, Emitter.integerType(builder, 8), 'transfer', {
                count: Emitter.integerUnsigned(
                  builder,
                  payloadType,
                  BigInt((ContinuationTransfer.headerWords * bits) / 8),
                ),
              }),
            }
            NativeDiagnosticTransfer.publish(
              transfer,
              resumed.diagnostic ?? unreachable('expected resumed metadata'),
            )
            const packed = NativeResult.pack(
              {
                ...resumed,
                diagnostic: NativeDiagnosticTransfer.take(transfer, diagnosticType),
              },
              { body },
              shape,
              resultType,
              'forwarded',
            )
            Emitter.returnValue(body, packed ?? unreachable('expected private return aggregate'))
          }),
        )
        const ir = yield* LlvmIrText.render(builder)
        const metadata = `{ ptr, i${bits}, ptr, i${bits}, ptr, i${bits} }`
        assert.include(ir, `@result_receiver(i32 %v0, ${metadata} %v1)`)
        assert.include(ir, `%returned_0 = extractvalue { i32, ${metadata} } %returned, 0`)
        assert.include(ir, `%returned_diagnostic = extractvalue { i32, ${metadata} } %returned, 1`)
        assert.include(ir, `%resumed_0 = extractvalue { i32, i32, ${metadata} } %stepped, 1`)
        assert.include(
          ir,
          `%resumed_diagnostic = extractvalue { i32, i32, ${metadata} } %stepped, 2`,
        )
        assert.include(ir, `ret { i32, ${metadata} } %forwarded`)
        assert.include(ir, `store ${metadata} %resumed_diagnostic, ptr %transfer_diagnostic_ptr`)
        assert.include(ir, `load ${metadata}, ptr %transfer_diagnostic_ptr`)
        assert.include(ir, `store ${metadata} zeroinitializer, ptr %transfer_diagnostic_ptr`)
      }
    }),
  ),
)

it.effect('moves outcome metadata before invoking a replaced owner callback', () =>
  Effect.scoped(
    Effect.gen(function* () {
      for (const bits of [32, 64]) {
        const builder = yield* LlvmBuilder.make()
        const pointer = yield* LlvmType.pointer(builder)
        const byte = yield* LlvmType.integer(builder, 8)
        const word = yield* LlvmType.integer(builder, bits)
        const metadata = yield* Emitter.module(builder, (builder) =>
          NativeDiagnosticFailure.type({ builder, pointer, word }),
        )
        const signature = yield* LlvmType.functionType(builder, metadata, [pointer, metadata])
        const fn = yield* LlvmFunction.declare(builder, 'replace_outcome', signature)
        yield* Emitter.module(builder, (builder) =>
          Emitter.buildBody(builder, fn, (body) => {
            Emitter.block(body, 'entry')
            const context = NativeDiagnosticContext.make(
              builder,
              body,
              pointer,
              byte,
              word,
              Emitter.nullValue(builder, pointer),
            )
            const slot = { storage: Emitter.argument(body, 0) }
            const incoming = Emitter.argument(body, 1)
            context.outcomes.set(0, slot)
            NativeDiagnosticOutcome.accept(
              context,
              { _tag: 'Local', ordinal: 0 },
              {
                values: [],
                diagnostic: incoming,
              },
            )
            Emitter.returnValue(body, NativeDiagnosticOutcome.take(slot, context))
          }),
        )
        const releaseOwner = yield* LlvmFunction.declare(
          builder,
          'release_owned_outcome',
          yield* LlvmType.functionType(builder, yield* LlvmType.voidType(builder), [
            pointer,
            pointer,
          ]),
        )
        yield* Emitter.module(builder, (builder) =>
          Emitter.buildBody(builder, releaseOwner, (body) => {
            Emitter.block(body, 'entry')
            const context = NativeDiagnosticContext.make(
              builder,
              body,
              pointer,
              byte,
              word,
              Emitter.nullValue(builder, pointer),
            )
            NativeDiagnosticOutcome.releaseForObserver(
              { storage: Emitter.argument(body, 0) },
              context,
              Emitter.argument(body, 1),
            )
            Emitter.returnVoid(body)
          }),
        )
        const ir = yield* LlvmIrText.render(builder)
        const aggregate = `{ ptr, i${bits}, ptr, i${bits}, ptr, i${bits} }`
        const emptied = ir.indexOf(`store ${aggregate} zeroinitializer, ptr %v0`)
        const published = ir.indexOf(`store ${aggregate} %v1, ptr %v0`)
        const released = ir.indexOf(`i8 4, i${bits} %diagnostic_failure1`)
        assert.isAtLeast(emptied, 0)
        assert.isAbove(published, emptied)
        assert.isAbove(released, published)
        assert.isAbove(ir.lastIndexOf(`store ${aggregate} zeroinitializer, ptr %v0`), released)
        assert.lengthOf(ir.match(/call i(?:32|64) /g) ?? [], 2)
        assert.include(ir, `icmp eq i${bits} %outcome_owner_address, %outcome_scope_address`)
        assert.include(ir, 'label %outcome_release_selected, label %outcome_release_following')
        assert.notInclude(ir, 'load ptr, ptr %diagnostic_observer_slot')
      }
    }),
  ),
)
