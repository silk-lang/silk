import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Json from './support/Json.js'
import * as Analysis from '../src/Analysis.js'
import * as Instances from '../src/Instances.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SourceSpan from '../src/SourceSpan.js'
import * as TypeInference from '../src/internal/TypeInference.js'
import * as ProvisionalMir from '../src/ProvisionalMir.js'
import * as Type from '../src/Type.js'
import * as Projections from './support/projections.js'
import { unreachable } from './support/raise.js'

const encoder = new TextEncoder()

const snapshot = (source: string) =>
  AnalysisFixture.retainingMain('provisional-mir/main', encoder.encode(source))

const available = (self: Analysis.Snapshot): ProvisionalMir.Module => {
  const provisional = Projections.provisionalMirOf(self)
  assert.strictEqual(provisional._tag, 'Available')
  if (provisional._tag === 'Available') return provisional.value
  return unreachable('expected provisional MIR')
}

const outcomes = (self: ProvisionalMir.Module): ReadonlyArray<ProvisionalMir.Outcome> =>
  self.executions.flatMap((execution) => execution.regions.map((region) => region.outcome))

it.effect('separates the canonical suspension origin from complete-or-relay callers', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
effect fn delayed(value: i32) -> i32 {
  return run Effect.suspend(effect { return value })
}
pub fn main() -> i32 {
  return run delayed(42)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const provisional = available(self)
    assert.deepEqual(ProvisionalMir.verify(provisional), [])
    const controls = outcomes(provisional)
    const origins = controls.filter((control) => control._tag === 'SuspendEffect')
    const relays = controls.filter((control) => control._tag === 'RunSuspendableEffect')
    assert.lengthOf(origins, 1)
    assert.isAtLeast(relays.length, 1)
    const origin = origins.at(0)
    assert.strictEqual(origin?._tag, 'SuspendEffect')
    if (origin?._tag === 'SuspendEffect') {
      assert.strictEqual(origin.transfer._tag, 'OriginateTransfer')
      assert.strictEqual(origin.span.sourceId, 'silk/effect')
    }
    for (const relay of relays) {
      if (relay._tag !== 'RunSuspendableEffect') continue
      assert.deepEqual(relay.relay, {
        _tag: 'RelayExistingTransfer',
        preserves: ['Child', 'Origin', 'TypedOutcome'],
      })
    }
  }),
)

it.effect('relays the exact selected Effect from an owned interface witness adapter', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
struct Token { value: i32 }
interface Decode { effect<'env> fn decode<'env>(value: Self) -> i32 }
effect fn decode(value: &Token) -> i32 {
  return run Effect.suspend(effect { return value.value })
}
impl Decode for Token { decode: Token.decode }
effect fn program() -> i32 { return run Decode.decode(Token { value: 42 }) }
pub fn main() -> i32 { return run program() }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const provisional = available(self)
    assert.deepEqual(ProvisionalMir.verify(provisional), [])
    const adapter =
      provisional.executions.find(
        (execution) =>
          execution.key._tag === 'WitnessEffectRunnerExecution' &&
          execution.key.runner.name === 'program$effect$0',
      ) ?? unreachable('expected selected witness adapter execution')
    assert.strictEqual(adapter.classification, 'Suspendable')
    const relay = adapter.regions.find(
      (region) => region.outcome._tag === 'RunSuspendableEffect',
    )?.outcome
    assert.strictEqual(relay?._tag, 'RunSuspendableEffect')
    if (relay?._tag !== 'RunSuspendableEffect') return
    assert.strictEqual(relay.runner.classification, 'Suspendable')
    assert.strictEqual(relay.runner.declaration?.name, 'decode$effect$-1')
    assert.strictEqual(relay.runner.instance?.declaration.name, 'decode')
    assert.deepEqual(relay.relay.preserves, ['Child', 'Origin', 'TypedOutcome'])
  }),
)

it.effect('uses ordinary propagation for source-defined combinators', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
effect fn seed(value: i32) -> i32 {
  return run Effect.suspend(effect { return value })
}
fn increment(value: i32) -> i32 { return value + 1 }
effect fn program() -> i32 {
  return run seed(41) |> Effect.map(increment)
}
pub fn main() -> i32 {
  return run program()
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const provisional = available(self)
    assert.deepEqual(ProvisionalMir.verify(provisional), [])
    const relays = outcomes(provisional).filter(
      (control) => control._tag === 'RunSuspendableEffect',
    )
    assert.isAtLeast(relays.length, 1)
    assert.isTrue(relays.every((control) => control.completion._tag === 'Propagate'))
  }),
)

it.effect('classifies a selected suspending service implementation on the provided runner', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
service Value {
  effect fn get() -> i32 ? &Value
}
struct SuspendedValue { value: i32 }
effect fn get(self: &SuspendedValue) -> i32 {
  return run Effect.suspend(effect { return self.value })
}
impl Value for SuspendedValue { get: SuspendedValue.get }
effect fn read() -> i32 ? &Value {
  return run Value.get()
}
pub fn main() -> i32 {
  let provider = SuspendedValue { value: 42 }
  return run Effect.provide(read(), &provider)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const provisional = available(self)
    assert.deepEqual(ProvisionalMir.verify(provisional), [])
    const selected = outcomes(provisional).find(
      (control) =>
        control._tag === 'RunSuspendableEffect' &&
        control.runner.execution._tag === 'ProvidedEffectRunnerExecution' &&
        control.runner.providers.some((provider) => provider.capability.name === 'Value'),
    )
    assert.strictEqual(selected?._tag, 'RunSuspendableEffect', ProvisionalMir.encode(provisional))
    if (selected?._tag === 'RunSuspendableEffect') {
      assert.strictEqual(selected.runner.classification, 'Suspendable')
      assert.strictEqual(selected.runner.execution._tag, 'ProvidedEffectRunnerExecution')
    }
  }),
)

it.effect('does not contaminate a generic service provider with another specialization', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
service Value<S> {
  effect fn get(value: &S) -> i32 ? &Value<S>
}

struct Token {}
struct Other {}
struct Fixed<S> {}
effect fn get<S>(self: &Fixed<S>, value: &S) -> i32 { return 42 }
impl<S> Value<S> for Fixed<S> { get: Fixed.get }
effect fn read(value: &Token) -> i32 ? &Value<Token> { return run Value.get<Token>(value) }
pub fn main() -> i32 {
  let provider = Fixed<Token> {}
  let token = Token {}
  return run Effect.provide(read(&token), &provider)
}`)
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => `${diagnostic.code}: ${diagnostic.message}`),
      [],
    )
    const token = Type.nominal('provisional-mir/main', 'Token')
    const get = Instances.matchingSpecialization(self.instances, {
      declaration: { module: 'provisional-mir/main', name: 'get' },
      typeArguments: [token],
    }).at(0)
    assert.isDefined(get)
    if (get === undefined) return
    const other = Type.nominal('provisional-mir/main', 'Other')
    const otherArguments = get.key.typeArguments.map((argument) =>
      Type.equalsGenericArgument(argument, token) ? other : argument,
    )
    const substitution = TypeInference.substitution(
      get.function.declaration.typeParameters.map((parameter) => parameter.type),
      otherArguments,
    )
    assert.isDefined(substitution)
    if (substitution === undefined) return
    const otherKey: Instances.InstanceKey = Object.freeze({
      ...get.key,
      typeArguments: Object.freeze(otherArguments),
    })
    const otherInstance: Instances.Instance = Object.freeze({
      ...get,
      key: otherKey,
      substitution,
    })
    const discovery: Instances.Discovery = Object.freeze({
      ...self.instances,
      instances: Object.freeze([...self.instances.instances, otherInstance]),
      suspension: Object.freeze([
        ...self.instances.suspension,
        Object.freeze({
          _tag: 'SuspensionFact' as const,
          subject: Object.freeze({ _tag: 'Instance' as const, key: otherKey }),
          summary: Object.freeze({
            _tag: 'SuspensionModeSummary' as const,
            availability: 'Complete' as const,
            modes: Object.freeze(['NestedTransfer' as const]),
            causes: Object.freeze([]),
          }),
        }),
        Object.freeze({
          _tag: 'SuspensionFact' as const,
          subject: Object.freeze({ _tag: 'Execution' as const, key: otherKey }),
          summary: Object.freeze({
            _tag: 'SuspensionModeSummary' as const,
            availability: 'Complete' as const,
            modes: Object.freeze(['NestedTransfer' as const]),
            causes: Object.freeze([]),
          }),
        }),
      ]),
    })
    assert.strictEqual(self.layout._tag, 'Available')
    if (self.layout._tag !== 'Available') return
    const provisional = ProvisionalMir.build(
      discovery,
      self.layout.value,
      Analysis.declarationIndex(self),
    )
    const provided = outcomes(provisional).filter(
      (
        outcome,
      ): outcome is Extract<ProvisionalMir.Outcome, { readonly _tag: 'RunSuspendableEffect' }> =>
        outcome._tag === 'RunSuspendableEffect' &&
        outcome.runner.execution._tag === 'ProvidedEffectRunnerExecution' &&
        outcome.runner.providers.some((provider) => provider.capability.name === 'Value'),
    )
    assert.lengthOf(provided, 0, ProvisionalMir.encode(provisional))
  }),
)

it.effect('specializes generic suspension captures without retaining type parameters', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
struct Owner { value: i32 }
effect<'env> fn delayed<T: 'env, 'env>(value: T) -> T {
  return run Effect.suspend(effect { return move value })
}
pub fn main() -> i32 {
  let scalarValue = run delayed<i32>(1)
  let ownerValue = run delayed<Owner>(Owner { value: 2 })
  return scalarValue + ownerValue.value
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const provisional = available(self)
    const origins = outcomes(provisional).filter(
      (control): control is Extract<ProvisionalMir.Outcome, { readonly _tag: 'SuspendEffect' }> =>
        control._tag === 'SuspendEffect',
    )
    assert.lengthOf(origins, 2, ProvisionalMir.encode(provisional))
    const captures = origins.flatMap((origin) => origin.deferred.captures)
    assert.isTrue(
      captures.some((capture) => capture.type === 'i32' && capture.access === 'Take'),
      Json.stringify(captures),
    )
    assert.isTrue(
      captures.some(
        (capture) =>
          typeof capture.type !== 'string' &&
          capture.type._tag === 'NominalType' &&
          capture.type.name === 'Owner' &&
          capture.access === 'Take',
      ),
    )
    assert.notInclude(ProvisionalMir.encode(provisional), 'TypeParameter')
  }),
)

it.effect('emits no suspension control for a closed synchronous corpus', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
effect fn seed(value: i32) -> i32 { return value }
fn increment(value: i32) -> i32 { return value + 1 }
pub fn main() -> i32 { return run seed(41) |> Effect.map(increment) }`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = available(self)
    assert.deepEqual(ProvisionalMir.verify(mir), [])
    assert.deepEqual(outcomes(mir), [])
  }),
)

it.effect('converges through a deep suspension chain independently of discovery order', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
effect fn level0(value: i32) -> i32 {
  return run Effect.suspend(effect { return value })
}
effect fn level1(value: i32) -> i32 { return run level0(value) }
effect fn level2(value: i32) -> i32 { return run level1(value) }
effect fn level3(value: i32) -> i32 { return run level2(value) }
effect fn level4(value: i32) -> i32 { return run level3(value) }
effect fn level5(value: i32) -> i32 { return run level4(value) }
effect fn level6(value: i32) -> i32 { return run level5(value) }
effect fn level7(value: i32) -> i32 { return run level6(value) }
pub fn main() -> i32 {
  return run level7(42)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.strictEqual(self.layout._tag, 'Available')
    if (self.layout._tag !== 'Available') return

    const forward = available(self)
    const reversed = ProvisionalMir.build(
      Object.freeze({
        ...self.instances,
        instances: Object.freeze([...self.instances.instances].reverse()),
      }),
      self.layout.value,
      Analysis.declarationIndex(self),
    )
    assert.deepEqual(ProvisionalMir.verify(forward), [])
    assert.deepEqual(ProvisionalMir.verify(reversed), [])
    const compareIdentities = (left: string, right: string): number => {
      if (left < right) return -1
      if (left > right) return 1
      return 0
    }
    const executions = (module_: ProvisionalMir.Module) =>
      [...module_.executions].sort((left, right) =>
        compareIdentities(left.key.identity, right.key.identity),
      )
    // Reusing a body must preserve every control region and nested runner, not just its label.
    assert.deepEqual(executions(forward), executions(reversed))
    assert.isAtLeast(
      outcomes(forward).filter((outcome) => outcome._tag === 'RunSuspendableEffect').length,
      8,
      ProvisionalMir.encode(forward),
    )
  }),
)

it.effect(
  'resolves directly bound service runners before classifying neighboring synchronous runs',
  () =>
    Effect.gen(function* () {
      const self = yield* snapshot(`service Value { effect fn get() -> i32 ? &mut Value }
struct Provider {}
effect fn get(self: &mut Provider) -> i32 { return 42 }
impl Value for Provider { get: Provider.get }
effect fn seed(value: i32) -> i32 { return value }
effect fn bound(provider: &mut Provider) -> i32 {
  let value = run Intrinsic.bindRequirementMut(Value.get(), provider)
  return run seed(value)
}
pub fn main() -> i32 {
  let mut provider = Provider {}
  return run bound(&mut provider)
}`)
      assert.deepEqual(Analysis.diagnostics(self), [])
      const provisional = available(self)
      assert.deepEqual(ProvisionalMir.verify(provisional), [])
      assert.deepEqual(outcomes(provisional), [])
      assert.isTrue(
        provisional.executions.every((execution) => execution.classification === 'Synchronous'),
      )
    }),
)

for (const variant of ['composed', 'sequential', 'suspending', 'multiple'] as const)
  it.effect(`preserves per-run control after ${variant} mutable service effects`, () =>
    Effect.gen(function* () {
      const source = `import silk.effect { Effect }
service Input { effect fn count() -> i32 ? &mut Input }
struct Fixed {}
${variant === 'multiple' ? 'struct Other {}\neffect fn otherCount(self: &mut Other) -> i32 { return run Effect.suspend(effect { return 1 }) }\nimpl Input for Other { count: Other.otherCount }' : ''}
struct Problem {}
effect fn count(self: &mut Fixed) -> i32 {
  return ${variant === 'suspending' ? 'run Effect.suspend(effect { return 0 })' : '0'}
}
impl Input for Fixed { count: Fixed.count }
effect fn recover(value: i32) -> i32 ! Problem { fail Problem {} }
effect fn program() -> i32 ! Problem ? &mut Input {
  ${variant === 'sequential' ? 'let first = run Input.count()\n  let second = run Input.count()' : 'let inputs = run Effect.zip(Input.count(), Input.count())\n  let first = inputs.first\n  let second = inputs.second'}
  if first == 0 { return run recover(first) }
  let mut remaining = second
  while remaining > 0 {
    let next = run Input.count()
    remaining = remaining - 1
  }
  return second
}
effect fn finish(error: Problem) -> i32 { return 0 }
pub fn main() -> i32 {
  let mut provider = Fixed {}
  ${variant === 'multiple' ? 'let first = run Effect.catchAll(Effect.provideMut(program(), &mut provider), finish)\n  let mut other = Other {}\n  return first + run Effect.catchAll(Effect.provideMut(program(), &mut other), finish)' : 'return run Effect.catchAll(Effect.provideMut(program(), &mut provider), finish)'}
}`
      const self = yield* snapshot(source)
      assert.deepEqual(
        Analysis.diagnostics(self).map(({ code, span }) => ({ code, span })),
        [],
      )
      const result = self.instances.instances.find(
        (instance) => instance.key.declaration.name === 'program',
      )?.specialization.result
      assert.isDefined(result)
      if (result === undefined) return
      const contract = Type.isRepresented(result) ? result.contract : result
      assert.isTrue(Type.isEffect(contract))
      if (!Type.isEffect(contract)) return
      assert.deepEqual(Type.failureMembers(contract).map(Type.encode), [
        'provisional-mir/main.Problem',
      ])
      assert.deepEqual(
        Type.requirementMembers(contract).map((requirement) => Type.encodeRequirement(requirement)),
        ['&mut provisional-mir/main.Input'],
      )
      const provisional = available(self)
      assert.deepEqual(ProvisionalMir.verify(provisional), [])
      const program = Analysis.loweredMir(self)
      assert.deepEqual(yield* MirVerification.verify(program), [])
      const ownership = Projections.suspensionOwnershipOf(self)
      assert.strictEqual(ownership._tag, 'Available')
      if (ownership._tag === 'Available') {
        assert.deepEqual(ownership.value.violations, [])
        if (variant === 'suspending') assert.isNotEmpty(ownership.value.plans)
      }
      const recoveryStart = source.indexOf(' run recover(first)')
      const recoveryEnd = recoveryStart + ' run recover(first)'.length
      const executions = program.functions.filter((fn) => fn.id.name.startsWith('program$effect$'))
      assert.isNotEmpty(executions)
      for (const fn of executions) {
        const execution = ProvisionalMir.executionOf(provisional, fn.instance)
        assert.isDefined(execution)
        const span =
          SourceSpan.fromOffsets('provisional-mir/main', recoveryStart, recoveryEnd) ??
          unreachable('expected recovery span')
        assert.strictEqual(
          ProvisionalMir.classificationOfRun(provisional, fn.instance, span),
          'Synchronous',
        )
        assert.isUndefined(ProvisionalMir.controlOfRun(provisional, fn.instance, span))
      }
      for (const fn of program.functions)
        for (const operation of MirVerification.operations(fn)) {
          if (
            operation._tag !== 'RunEffect' &&
            operation._tag !== 'RunEffectValue' &&
            operation._tag !== 'CatchEffect' &&
            operation._tag !== 'ExecutionRelinquish'
          )
            continue
          const span = operation.provenance.span
          if (ProvisionalMir.classificationOfRun(provisional, fn.instance, span) !== 'Synchronous')
            assert.isDefined(ProvisionalMir.controlOfRun(provisional, fn.instance, span))
        }
    }),
  )

it.effect('retains provider-specific parking through a generic interface handler', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect {Effect}
import silk.execution { Execution, Wake }
import silk.result {Result}
struct ParkGuard {wake: Wake}
fn retainWake(wake: Wake) -> ParkGuard { return ParkGuard {wake: move wake} }
service Clock { effect fn wait() -> () ? &mut Clock }
struct Fixed {}
impl Clock for Fixed { effect fn wait(self: &mut Self) -> () { return () } }
struct Parking {}
impl Clock for Parking { effect fn wait(self: &mut Self) -> () { run Execution.park(retainWake) return () } }
union Problem {Bad}
service Io { effect fn flush() -> () ! Problem ? &mut Io | &mut Clock }
effect fn flushIo() -> () ! Problem ? &mut Io | &mut Clock {
 let result = run Effect.result(Io.flush())
 match move result {
  Result.Success {value} => { drop value return () }
  Result.Failure {error} => { fail error }
 }
}
struct Inner {}
impl Io for Inner { effect fn flush(self: &mut Self) -> () ! Problem ? &mut Clock { return () } }
struct Transport {mode: i32 inner: Inner}
impl Transport {
 effect fn flush(self: &mut Self) -> () ! Problem ? &mut Clock {
  if self.mode == 4 { fail Problem.Bad }
  if self.mode == 5 { run Clock.wait() }
  return run flushIo() |> Effect.provideMut<Io>(&mut self.inner)
 }
}
impl Io for Transport { flush: Transport.flush }
effect fn useTransport() -> i32 ! Problem ? &mut Clock {
 let mut transport = Transport {mode: 5, inner: Inner {}}
 run flushIo() |> Effect.provideMut<Io>(&mut transport)
 return 42
}
interface Handler { effect<'env> fn handle<'env>(self: Self) -> i32 ! Problem ? &mut Clock }
struct HandlerValue {}
impl Handler for HandlerValue { effect fn handle(self: Self) -> i32 ! Problem ? &mut Clock { drop self return run useTransport() } }
effect<'env> fn withHandler<H: Handler + 'env, 'env>(handler: H) -> i32 ! Problem ? &mut Clock { return run Handler.handle(move handler) }
effect fn all() -> i32 ! Problem {
 let mut fixed = Fixed {}
 let first = run withHandler(HandlerValue {}) |> Effect.provideMut<Clock>(&mut fixed)
 let mut parking = Parking {}
 return first + (run withHandler(HandlerValue {}) |> Effect.provideMut<Clock>(&mut parking))
}
effect fn recover(error: Problem) -> i32 { drop error return 199 }
pub fn main() -> i32 { return run Effect.catchAll(all(), recover) }
`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const provisional = available(self)
    assert.deepEqual(ProvisionalMir.verify(provisional), [])
    const program = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(program), [])
    const flushes = program.functions.filter((fn) =>
      fn.id.name.startsWith('Transport.flush$effect$'),
    )
    assert.lengthOf(flushes, 2)
    for (const fn of flushes) {
      const parking =
        fn.effectRunner?.providers.some(
          (provider) =>
            Type.isNominal(provider.providerType) && provider.providerType.name === 'Parking',
        ) ?? false
      const execution = ProvisionalMir.executionOf(provisional, fn.instance)
      assert.strictEqual(execution?.key._tag, 'ProvidedEffectRunnerExecution')
      assert.strictEqual(execution?.classification, parking ? 'Suspendable' : 'Synchronous')
      const wait =
        MirVerification.operations(fn).find(
          (operation) =>
            operation._tag === 'RunEffectValue' && operation.runner.name.includes('.wait$effect$'),
        ) ?? unreachable('expected the selected clock operation')
      assert.strictEqual(
        fn.suspension?.regions.some((region) => region.operation === wait) ?? false,
        parking,
      )
    }
  }),
)
