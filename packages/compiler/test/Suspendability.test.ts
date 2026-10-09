import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Backend from '../src/Backend.js'
import * as EntryAssembly from '../src/EntryAssembly.js'
import * as ExecutableProperty from '../src/ExecutableProperty.js'
import * as ExecutionBoundary from '../src/ExecutionBoundary.js'
import * as Tir from '../src/Tir.js'
import * as Instances from '../src/Instances.js'
import * as TypeInference from '../src/internal/TypeInference.js'
import * as Lifetime from '../src/Lifetime.js'
import * as Mir from '../src/Mir.js'
import * as MirVerification from '../src/MirVerification.js'
import * as SourceSpan from '../src/SourceSpan.js'
import * as SuspensionMode from '../src/SuspensionMode.js'
import * as Type from '../src/Type.js'
import { ordinaryStorageSource } from './support/ordinaryStorageSource.js'
import * as Projections from './support/projections.js'

const encoder = new TextEncoder()

it.effect('lowers service calls inside a generic scoped callback with a borrowed capture', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'suspendability/scoped-service-capture',
      encoder.encode(`import silk.effect {Effect}
service Clock { effect fn now() -> i32 ? &mut Clock }
struct ReadyClock {}
impl Clock for ReadyClock { effect fn now(self: &mut Self) -> i32 { return 42 } }
struct Guard<P> { provider: P }
struct Config<'data> { value: &'data i32 }
effect<'env> fn scoped<P: 'env, 'env>(provider: P, config: &Config) -> i32 ? &mut Clock {
  let use = effect fn(owned: &mut Guard<P>) -> i32 ? &mut Clock {
    let value = run Clock.now()
    drop owned
    return value + config.value.*
  }
  let release = effect fn(owned: &mut Guard<P>) -> () { drop owned return () }
  return run Effect.useReleaseNonParking(Guard<P> {provider: move provider}, move use, move release)
}
pub fn main() -> i32 {
  let mut clock = ReadyClock {}
  let value = 0
  let config = Config {value: &value}
  return run scoped((), &config) |> Effect.provideMut<Clock>(&mut clock)
}`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
  }),
)

const snapshot = (source: string) =>
  AnalysisFixture.retainingMain(
    'suspendability/main',
    encoder.encode(ordinaryStorageSource(source)),
  )

const key = (instance: Instances.InstanceKey): string =>
  `${instance.declaration.module}.${instance.declaration.name}<${instance.typeArguments
    .map(Type.genericArgumentKey)
    .join(',')}>`

const names = (self: Analysis.Snapshot): ReadonlyArray<string> =>
  self.instances.instances
    .filter((instance) =>
      SuspensionMode.has(Instances.suspensionOf(self.instances, instance.key), 'NestedTransfer'),
    )
    .map((instance) => key(instance.key))

const effectNames = (self: Analysis.Snapshot): ReadonlyArray<string> =>
  Projections.suspensionFactsOf(self).flatMap((fact) =>
    fact.subject._tag === 'Effect' && SuspensionMode.has(fact.summary, 'NestedTransfer')
      ? [fact.subject.identity]
      : [],
  )

const main = (recipe: string): string => `pub fn main() -> i32 { return run ${recipe} }`

it('fails closed with the first generated-runner lowering provenance', () => {
  const span = SourceSpan.fromOffsets('suspendability/generated-runner', 10, 20)
  assert.isDefined(span)
  if (span === undefined) return
  const runner = Object.freeze({
    _tag: 'CanonicalDeclarationId' as const,
    module: 'suspendability/generated-runner',
    name: 'operation$effect$0$provided$1',
  })
  const base = Object.freeze({
    _tag: 'CanonicalDeclarationId' as const,
    module: 'suspendability/generated-runner',
    name: 'operation$effect$0',
  })
  const owner = Object.freeze({
    _tag: 'InstanceKey' as const,
    declaration: Object.freeze({ ...base }),
    typeArguments: Object.freeze([]),
    evidence: Object.freeze([]),
    staticArguments: Object.freeze([]),
    contractRow: Object.freeze([]),
  })
  const cause = Object.freeze({
    boundary: 'Expression' as const,
    construct: 'CallableSection' as const,
    provenance: Object.freeze({ span, generated: false }),
  })
  const failure = EntryAssembly.unavailableGeneratedEffectRunner({
    runner,
    base,
    owner,
    cause,
  })
  const unreachable = EntryAssembly.unavailableGeneratedEffectRunner({
    runner: Object.freeze({ ...runner, name: 'unreachable$effect$0$provided$1' }),
    base,
    owner,
    cause,
  })
  const retained = new Set([EntryAssembly.generatedEffectRunnerKey(failure.runner, failure.owner)])
  assert.isUndefined(EntryAssembly.unavailableReferencedEffectRunner([unreachable], retained))
  const selected = EntryAssembly.unavailableReferencedEffectRunner([unreachable, failure], retained)
  assert.strictEqual(selected, failure)
  if (selected === undefined) return
  let caught: unknown
  try {
    EntryAssembly.requireGeneratedEffectRunner(selected)
  } catch (cause) {
    caught = cause
  }
  assert.instanceOf(caught, EntryAssembly.GeneratedEffectRunnerLoweringError)
  if (!(caught instanceof EntryAssembly.GeneratedEffectRunnerLoweringError)) return
  assert.strictEqual(caught.failure, failure)
  assert.strictEqual(caught.failure.runner, runner)
  assert.strictEqual(caught.failure.base, base)
  assert.strictEqual(caught.failure.owner, failure.owner)
  assert.strictEqual(caught.failure.cause.provenance.span, span)
})

it('rebinds selected runtime arguments without reopening caller lifetime proofs', () => {
  const owner = { module: 'selected-call', name: 'requireEffect' }
  const env = Type.parameter(owner, 0, 'env', 'Lifetime')
  const bound = Type.effect('i32', [], {
    environment: Lifetime.bound(owner, 0, 'env'),
    lifetimeBinders: [],
  })
  const body = Type.parameter(owner, 1, 'F', 'EffectRepresentation', bound)
  const callRegion = Lifetime.local(owner, 'call', 0)
  const captureRegion = Lifetime.local(owner, 'capture', 1)
  const contract = Type.effect('i32', [], { environment: captureRegion, lifetimeBinders: [] })
  const argument = Type.exactRepresentationArgument(
    Type.effectIdentityArgument('selected'),
    contract,
  )
  const selected = TypeInference.selectedSubstitution([env, body], [callRegion, argument])
  assert.strictEqual(selected?.substitution.get(Type.key(env)), callRegion)
  assert.strictEqual(selected?.substitution.get(Type.key(body)), argument)
  const open = Type.represented(bound, bound, Type.representationParameterArgument(body))
  if (selected !== undefined) {
    const specialized = Type.substitute(open, selected.substitution, selected.compatibility)
    assert.isTrue(Type.isRuntimeConcrete(specialized))
    assert.isFalse(Type.isRuntimeConcrete(Type.substitute(open, selected.substitution)))
    assert.isFalse(
      Lifetime.outlives(
        selected.compatibility.assumptions,
        captureRegion,
        Lifetime.local(owner, 'unrelated', 2),
      ),
    )
  }

  assert.isUndefined(TypeInference.substitution([env, body], [callRegion, argument]))
  assert.isUndefined(TypeInference.selectedSubstitution([env, body], [argument]))
  assert.isUndefined(TypeInference.selectedSubstitution([env, body], [callRegion, 'i32']))
  const wrongResult = Type.effect('bool', [], { environment: captureRegion, lifetimeBinders: [] })
  assert.isUndefined(
    TypeInference.selectedSubstitution(
      [env, body],
      [
        callRegion,
        Type.exactRepresentationArgument(Type.effectIdentityArgument('wrong'), wrongResult),
      ],
    ),
  )
})

it('normalizes direct, nested, external, open, and unavailable graph summaries deterministically', () => {
  const graph: SuspensionMode.Graph = Object.freeze({
    roots: new Map<SuspensionMode.Mode, ReadonlySet<string>>([
      ['NestedTransfer', new Set(['nested'])],
      ['ExternalPark', new Set(['park'])],
    ]),
    dependencies: new Map([
      ['both', new Set(['park', 'nested'])],
      ['owner', new Set(['both'])],
      ['nested', new Set<string>()],
      ['park', new Set<string>()],
      ['direct', new Set<string>()],
    ]),
    permitted: new Map<string, ReadonlySet<SuspensionMode.Mode>>([
      ['open', new Set(['NestedTransfer', 'ExternalPark'])],
    ]),
    unavailable: new Set(['damaged']),
  })
  const first = SuspensionMode.summarize(graph)
  const second = SuspensionMode.summarize(graph)
  assert.strictEqual(
    SuspensionMode.encode(first.get('direct') ?? SuspensionMode.direct),
    'Complete[Direct]',
  )
  assert.deepEqual(first.get('both')?.modes, ['NestedTransfer', 'ExternalPark'])
  assert.deepEqual(first.get('open')?.modes, ['NestedTransfer', 'ExternalPark'])
  assert.strictEqual(first.get('open')?.availability, 'Open')
  assert.strictEqual(first.get('damaged')?.availability, 'Unavailable')
  assert.deepEqual(
    [...first].map(([node, summary]) => `${node}=${SuspensionMode.encode(summary)}`),
    [...second].map(([node, summary]) => `${node}=${SuspensionMode.encode(summary)}`),
  )

  const external = first.get('owner') ?? SuspensionMode.direct
  const delimiter = ExecutionBoundary.delimit(external)
  assert.isTrue(SuspensionMode.has(delimiter.body, 'ExternalPark'))
  assert.strictEqual(SuspensionMode.encode(delimiter.owner), 'Complete[Direct]')
  const nestedOnly = first.get('nested') ?? SuspensionMode.direct
  assert.strictEqual(ExecutableProperty.nonParkingOfSummary(nestedOnly)._tag, 'Satisfied')
  const nonParking = ExecutableProperty.nonParkingOfSummary(external)
  assert.strictEqual(nonParking._tag, 'Unsatisfied')
  assert.deepEqual(
    nonParking._tag === 'Unsatisfied' ? nonParking.causes.map((entry) => entry.path) : [],
    [['owner', 'both', 'park']],
  )
})

it.effect('separates lazy Effect runners from their factory and synchronous siblings', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
fn recipes() -> Effect<'static; i32> {
  let synchronous = effect { return 1 }
  let suspended = delayed()
  return move suspended
}
effect fn delayed() -> i32 {
  return run Effect.suspend(effect { return 2 })
}
${main('recipes()')}`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const recipes = self.instances.instances.find(
      (instance) => instance.key.declaration.name === 'recipes',
    )
    const synchronous = recipes?.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .find((expression) => expression._tag === 'EffectBlock')
    const synchronousIdentity =
      recipes === undefined || synchronous?._tag !== 'EffectBlock'
        ? undefined
        : Instances.effectIdentity(recipes.key, synchronous.site)
    assert.isDefined(synchronousIdentity)
    assert.isFalse(
      synchronousIdentity === undefined
        ? true
        : SuspensionMode.has(
            Instances.effectSuspensionOf(self.instances, synchronousIdentity),
            'NestedTransfer',
          ),
    )
    const delayed = self.instances.instances.find(
      (instance) => instance.key.declaration.name === 'delayed',
    )
    assert.isDefined(delayed?.resultEffect)
    assert.isTrue(
      delayed?.resultEffect === undefined
        ? false
        : SuspensionMode.has(
            Instances.effectSuspensionOf(self.instances, delayed.resultEffect),
            'NestedTransfer',
          ),
    )
  }),
)

it.effect(
  'derives Detached independently from affinity and NonParking independently from nested transfer',
  () =>
    Effect.gen(function* () {
      const self = yield* snapshot(`import silk.effect { Effect }
struct Box { value: i32 }
struct HiddenResult { value: i32 }
fn borrowed(value: &Box) -> Effect<i32> { return effect { return value.value } }
fn copied(value: i32) -> Effect<'static; i32> { return effect { return value } }
fn opaqueProducer() -> some<F: Effect<'static; HiddenResult>> F {
  return effect { return HiddenResult { value: 42 } }
}
effect fn nested(value: i32) -> i32 {
  return run Effect.suspend(effect { return value })
}
fn update(value: &mut Box, delta: i32) -> () { value.value = delta return () }
fn invoke<F: once fn(&mut Box) -> () + Intrinsic.NonParking>(callback: F, value: &mut Box) -> () {
  callback(move value)
  return ()
}
fn apply<'a>(value: &'a mut Box) -> () { invoke(update(42), move value) return () }
fn updateFirst(value: &mut Box) -> () { apply(move value) return () }
fn updateSecond(value: &mut Box) -> () { apply(move value) return () }
pub fn main() -> i32 {
  let mut box = Box { value: 40 }
  let first = borrowed(&box)
  let second = copied(41)
  let opaque = opaqueProducer()
  drop first
  drop second
  drop opaque
  updateFirst(&mut box)
  updateSecond(&mut box)
  return run nested(42)
}`)

      assert.deepEqual(Analysis.diagnostics(self), [])
      assert.strictEqual(
        self.instances.callables.filter(
          (callable) =>
            callable.target._tag === 'DeclarationCallableTarget' &&
            callable.target.declaration.name === 'update',
        ).length,
        1,
      )
      const facts = Analysis.executablePropertiesOf(self).filter(
        (fact) => fact.subject._tag === 'Effect',
      )
      const borrowed = facts.find(
        (fact) =>
          fact.detached._tag === 'Unsatisfied' &&
          fact.detached.causes.some((entry) => entry.reason === 'LexicalLoan'),
      )
      assert.isDefined(borrowed)
      assert.strictEqual(borrowed?.affinity._tag, 'Unrestricted')
      assert.strictEqual(borrowed?.nonParking._tag, 'Satisfied')
      const nested = facts.find((fact) => {
        if (fact.subject._tag !== 'Effect') return false
        return SuspensionMode.has(
          Instances.effectSuspensionOf(self.instances, fact.subject.identity),
          'NestedTransfer',
        )
      })
      assert.isDefined(nested)
      assert.strictEqual(nested?.nonParking._tag, 'Satisfied')
      assert.isTrue(
        facts.some(
          (fact) => fact.detached._tag === 'Satisfied' && fact.nonParking._tag === 'Satisfied',
        ),
      )
      const opaqueProducer = self.instances.effects.find(
        (effect) =>
          Type.isNominal(effect.type.success) && effect.type.success.name === 'HiddenResult',
      )
      assert.isDefined(opaqueProducer)
      assert.strictEqual(
        facts.find(
          (fact) =>
            fact.subject._tag === 'Effect' && fact.subject.identity === opaqueProducer?.identity,
        )?.detached._tag,
        'Satisfied',
      )
    }),
)

it.effect('lowers a selected generic Effect with a borrowed environment', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`struct Box { value: i32 }
fn consume<'env, F: Effect<'env; i32>>(body: F) -> i32 { return run body }
pub fn main() -> i32 {
  let box = Box { value: 42 }
  let view = &box
  return consume(effect { return view.value })
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.isTrue(
      self.instances.instances.some((instance) => instance.key.declaration.name === 'consume'),
    )
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
  }),
)

it.effect('diagnoses a failed concrete sealed-property obligation at the generic application', () =>
  Effect.gen(function* () {
    const source = `struct Box { value: i32 }
fn requireDetached<'env, F: Effect<'env; i32> + Intrinsic.Detached>(body: F) -> i32 {
  drop body
  return 1
}
pub fn main() -> i32 {
  let box = Box { value: 42 }
  let view = &box
  let inner = effect { return view.value }
  return requireDetached(effect { return run inner })
}`
    const self = yield* snapshot(source)
    const diagnostic = Analysis.diagnostics(self).find((candidate) => candidate.code === 'SEM0139')

    assert.deepEqual(
      Analysis.diagnostics(self).map((candidate) => candidate.code),
      ['SEM0139'],
    )
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
      'Effect:',
    )
    assert.strictEqual(
      diagnostic === undefined
        ? undefined
        : source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      'requireDetached(effect { return run inner })',
    )
  }),
)

it.effect('retains borrowed provider provenance through an ordinary provide wrapper', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
service Clock { effect fn read() -> i32 ? &Clock }
struct FixedClock {}
effect fn read(self: &FixedClock) -> i32 { return 42 }
impl Clock for FixedClock { read: FixedClock.read }
effect fn program() -> i32 ? &Clock { return run Clock.read() }
fn requireDetached<'env, F: Effect<'env; i32> + Intrinsic.Detached>(body: F) -> i32 {
  drop body
  return 1
}
pub fn main() -> i32 {
  let clock = FixedClock {}
  let provided = program() |> Effect.provide(&clock)
  return requireDetached(move provided)
}`
    const self = yield* snapshot(source)

    const diagnostics = Analysis.diagnostics(self)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0139'],
    )
    const diagnostic = diagnostics.at(0)
    assert.strictEqual(diagnostic?.reason._tag, 'UnsatisfiedExecutableProperty')
    assert.strictEqual(
      diagnostic?.reason._tag === 'UnsatisfiedExecutableProperty'
        ? diagnostic.reason.property
        : undefined,
      'Intrinsic.Detached',
    )
    assert.isTrue(
      diagnostic?.reason._tag === 'UnsatisfiedExecutableProperty' &&
        diagnostic.reason.causes.some((cause) => cause.startsWith('ProviderLoan:')),
    )
    assert.strictEqual(
      diagnostic === undefined
        ? undefined
        : source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      'requireDetached(move provided)',
    )
    assert.notInclude(
      diagnostics.map((diagnostic) => diagnostic.code),
      'SEM0071',
    )
  }),
)

it.effect('diagnoses sealed-property obligations on represented nominal fields', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`struct Box { value: i32 }
struct Deferred<'env, F: once Effect<'env; i32> + Intrinsic.Detached> { operation: F }
pub fn main() -> i32 {
  let box = Box { value: 42 }
  let view = &box
  let deferred = Deferred { operation: effect { return view.value } }
  drop deferred
  return 0
}`)

    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      ['SEM0139'],
    )
  }),
)

it.effect('preserves borrowed contents and static strings in captured nominal environments', () =>
  Effect.gen(function* () {
    const source = `struct Box { value: i32 }
struct Text<'a> { value: string<'a> }
tuple Wrapped<T>(T)
struct Deferred<'env, F: once Effect<'env; i32>> { operation: F }
fn requireDetached<'env, F: once Effect<'env; i32> + Intrinsic.Detached>(body: F) -> i32 {
  drop body
  return 1
}
fn staticText<'a: 'static>(text: string<'a>) -> i32 {
  let wrapped = Wrapped(Text { value: text })
  return requireDetached(effect { drop move wrapped return 1 })
}
pub fn main() -> i32 {
  let direct = "static"
  let directResult = requireDetached(effect { drop move direct return 1 })
  let nested = Wrapped(Text { value: "static" })
  let nestedResult = requireDetached(effect { drop move nested return 1 })
  let genericResult = staticText("static")
  let bytes: [u8; 1] = [65]
  unsafe {
    let text = Intrinsic.stringFromUtf8Unchecked(&bytes)
    let borrowed = Wrapped(Text { value: text })
    let rejected = requireDetached(effect { drop move borrowed return 1 })
  }
  let box = Box { value: 42 }
  let view = &box
  let deferred = Deferred { operation: effect { return view.value } }
  return requireDetached(effect { drop deferred return 1 })
}`
    const self = yield* snapshot(source)

    const diagnostics = Analysis.diagnostics(self)
    assert.deepEqual(
      diagnostics.map((diagnostic) => ({
        code: diagnostic.code,
        span: source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      })),
      [
        { code: 'SEM0139', span: 'requireDetached(effect { drop move borrowed return 1 })' },
        { code: 'SEM0139', span: 'requireDetached(effect { drop deferred return 1 })' },
      ],
    )
    const diagnostic = diagnostics.at(1)
    assert.strictEqual(diagnostic?.reason._tag, 'UnsatisfiedExecutableProperty')
    assert.strictEqual(
      diagnostic?.reason._tag === 'UnsatisfiedExecutableProperty'
        ? diagnostic.reason.property
        : undefined,
      'Intrinsic.Detached',
    )
    assert.isTrue(
      diagnostic?.reason._tag === 'UnsatisfiedExecutableProperty' &&
        diagnostic.reason.causes.some((cause) => cause.startsWith('LexicalLoan:')),
    )
    assert.strictEqual(
      diagnostic === undefined
        ? undefined
        : source.slice(diagnostic.span.start, diagnostic.span.end).trim(),
      'requireDetached(effect { drop deferred return 1 })',
    )
  }),
)

it.effect('follows represented executables nested inside nominal union variants', () =>
  Effect.gen(function* () {
    const source = `struct Box { value: i32 }
union Deferred<'env, F: once Effect<'env; i32>> { Empty, Ready { operation: F } }
fn requireDetached<'env, F: once Effect<'env; i32> + Intrinsic.Detached>(body: F) -> i32 {
  drop body
  return 1
}
pub fn main() -> i32 {
  let box = Box { value: 42 }
  let view = &box
  let deferred = Deferred.Ready { operation: effect { return view.value } }
  return requireDetached(effect { drop move deferred return 1 })
}`
    const self = yield* snapshot(source)

    const diagnostics = Analysis.diagnostics(self)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0139'],
    )
    const diagnostic = diagnostics.at(0)
    assert.strictEqual(diagnostic?.reason._tag, 'UnsatisfiedExecutableProperty')
    assert.strictEqual(
      diagnostic?.reason._tag === 'UnsatisfiedExecutableProperty'
        ? diagnostic.reason.property
        : undefined,
      'Intrinsic.Detached',
    )
    assert.isTrue(
      diagnostic?.reason._tag === 'UnsatisfiedExecutableProperty' &&
        diagnostic.reason.causes.some((cause) => cause.startsWith('LexicalLoan:')),
    )
  }),
)

it.effect('closes direct self and mutual cycles over exact execution nodes', () =>
  Effect.gen(function* () {
    const direct = yield* snapshot(`import silk.effect { Effect }
effect fn loop(value: i32) -> i32 {
  if value == 0 { return 0 }
  return run Effect.suspend(loop(value - 1))
}
${main('loop(1)')}`)
    assert.deepEqual(Analysis.diagnostics(direct), [])
    assert.include(names(direct), 'suspendability/main.loop<>')

    const mutual = yield* snapshot(`import silk.effect { Effect }
effect fn even(value: i32) -> i32 {
  if value == 0 { return 1 }
  return run odd(value - 1)
}
effect fn odd(value: i32) -> i32 {
  if value == 0 { return 0 }
  return run Effect.suspend(even(value - 1))
}
${main('even(2)')}`)
    assert.deepEqual(Analysis.diagnostics(mutual), [])
    assert.include(names(mutual), 'suspendability/main.even<>')
    assert.include(names(mutual), 'suspendability/main.odd<>')
  }),
)

it.effect('propagates through concrete Effect.map and flatMap specializations', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
effect fn seed(value: i32) -> i32 {
  return run Effect.suspend(effect { return value })
}
fn increment(value: i32) -> i32 { return value + 1 }
fn next(value: i32) -> Effect<'static; i32> { return seed(value + 1) }
effect fn program() -> i32 {
  let mapped = seed(40) |> Effect.map(increment)
  return run mapped |> Effect.flatMap(next)
}
${main('program()')}`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const suspendable = self.instances.instances.filter((instance) =>
      SuspensionMode.has(Instances.suspensionOf(self.instances, instance.key), 'NestedTransfer'),
    )
    const suspendableKeys = suspendable.map((instance) => Instances.keyText(instance.key)).sort()
    assert.deepEqual(suspendableKeys, [...suspendableKeys].sort())
    assert.deepEqual(effectNames(self), [...effectNames(self)].sort())
    assert.isTrue(
      suspendable.some(
        (instance) =>
          instance.key.declaration.module === 'silk/effect' &&
          instance.key.declaration.name === 'Effect.map' &&
          instance.key.typeArguments.length > 0,
      ),
    )
    assert.isTrue(
      suspendable.some(
        (instance) =>
          instance.key.declaration.module === 'silk/effect' &&
          instance.key.declaration.name === 'Effect.flatMap' &&
          instance.key.typeArguments.length > 0,
      ),
    )
  }),
)

it.effect('propagates through applied callables but not stored callable values', () =>
  Effect.gen(function* () {
    const prelude = `import silk.effect { Effect }
fn suspendAndRecover(value: i32) -> i32 {
  let pending = Effect.suspend(effect { return value })
  return run pending
}`
    const stored = yield* snapshot(`${prelude}
pub fn main() -> i32 { let unused = suspendAndRecover return 42 }`)
    assert.deepEqual(Analysis.diagnostics(stored), [])
    assert.notInclude(names(stored), 'suspendability/main.main<>')
    assert.include(names(stored), 'suspendability/main.suspendAndRecover<>')

    const applied = yield* snapshot(`${prelude}
pub fn main() -> i32 { let callback = suspendAndRecover return callback(42) }`)
    assert.deepEqual(Analysis.diagnostics(applied), [])
    assert.include(names(applied), 'suspendability/main.main<>')
    assert.include(names(applied), 'suspendability/main.suspendAndRecover<>')
  }),
)

it.effect('preserves nested transfer through an exact NonParking callback parameter', () =>
  Effect.gen(function* () {
    const self =
      yield* snapshot(`fn invoke<F: fn<'static>() -> i32 + Intrinsic.NonParking>(body: F) -> i32 {
  return body()
}
fn nested() -> i32 { return run Intrinsic.suspendEffect(effect { return 42 }) }
pub fn main() -> i32 { return invoke(nested) }`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const invoke = self.instances.instances.find(
      (instance) => instance.key.declaration.name === 'invoke',
    )
    assert.isDefined(invoke)
    if (invoke !== undefined)
      assert.isTrue(
        SuspensionMode.has(Instances.suspensionOf(self.instances, invoke.key), 'NestedTransfer'),
      )
    assert.include(names(self), 'suspendability/main.main<>')
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    const artifact = yield* Analysis.codegen(self, { mode: 'debug' })
    assert.include(artifact.ir, '$suspend_step')
  }),
)

it.effect('checks NonParking through an ordinary selected interface operation', () =>
  Effect.gen(function* () {
    const source = `import silk.execution { Execution, Wake }
interface Job<T> { fn code(value: T) -> i32 }
struct Provider {}
fn register(wake: Wake) -> () { drop wake return () }
impl Job<()> for Provider {
  fn code(value: ()) -> i32 { run Execution.park(register) return 42 }
}
fn adapt<P: Job<()>>(provider: P) -> i32 { return Job<()>.code(()) }
fn application() -> i32 { return adapt(Provider {}) }
fn invoke<F: fn<'static>() -> i32 + Intrinsic.NonParking>(body: F) -> i32 { return body() }
pub fn main() -> i32 { return invoke(application) }`
    const self = yield* snapshot(source)
    const diagnostics = Analysis.diagnostics(self)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0139'],
    )
    assert.strictEqual(
      diagnostics.find((diagnostic) => diagnostic.code === 'SEM0139')?.span.start,
      source.indexOf('invoke(application)'),
    )
  }),
)

it.effect('requires an exact nonparking execution for cancellation finalization', () =>
  Effect.gen(function* () {
    const accepted = yield* snapshot(`import silk.effect { Effect }
effect fn protected() -> i32 { return 42 }
effect fn release() -> () { return () }
pub fn main() -> i32 { return run Effect.ensuringNonParking(protected(), release()) }`)
    assert.deepEqual(Analysis.diagnostics(accepted), [])

    const genericAccepted = yield* snapshot(`import silk.effect { Effect }
effect fn protected() -> i32 { return 42 }
effect fn guard<
  'env,
  A,
  E,
  ?R,
  ?S,
  F: once Effect<'env; () ? S> + Intrinsic.NonParking,
>(body: once Effect<'env; A ! E ? R>, finalizer: F) -> A ! E ? R | S {
  return run Effect.ensuringNonParking(move body, move finalizer)
}
effect fn release() -> () { return () }
pub fn main() -> i32 { return run guard(protected(), release()) }`)
    assert.deepEqual(Analysis.diagnostics(genericAccepted), [])

    const rejected = yield* snapshot(`import silk.effect { Effect }
import silk.execution { Execution, Wake }
fn register(wake: Wake) -> () { drop wake return () }
effect fn protected() -> i32 { return 42 }
effect fn release() -> () { run Execution.park(register) return () }
pub fn main() -> i32 { return run Effect.ensuringNonParking(protected(), release()) }`)
    assert.include(
      Analysis.diagnostics(rejected).map((diagnostic) => diagnostic.code),
      'SEM0139',
    )
  }),
)

it.effect('retains one owned resource and forms disjoint use and release loans', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
import silk.execution { Execution, Wake }
struct Resource { value: i32 }
fn register(wake: Wake) -> () { drop wake return () }
effect fn use(resource: &mut Resource) -> i32 {
  resource.value = 41
  run Execution.park(register)
  return resource.value + 1
}
effect fn release(resource: &mut Resource) -> () {
  resource.value = 0
  return ()
}
pub fn main() -> i32 {
  return run Effect.useReleaseNonParking(Resource { value: 0 }, use, release)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const bracket = mir.functions
      .flatMap((fn) => Mir.regionsTree(fn.regions).flatMap(Mir.operationsOf))
      .find(
        (operation) =>
          (operation._tag === 'RunEffectValue' || operation._tag === 'CatchEffect') &&
          operation.cancellationFinalizer?._tag === 'ResourceCancellationFinalizer',
      )
    assert.isDefined(bracket)
    if (
      bracket === undefined ||
      (bracket._tag !== 'RunEffectValue' && bracket._tag !== 'CatchEffect') ||
      bracket.cancellationFinalizer?._tag !== 'ResourceCancellationFinalizer'
    )
      return
    const owner = mir.functions.find((fn) =>
      Mir.regionsTree(fn.regions)
        .flatMap(Mir.operationsOf)
        .some((operation) => operation === bracket),
    )
    assert.isDefined(owner)
    if (owner === undefined) return
    const loans = Mir.regionsTree(owner.regions)
      .flatMap(Mir.operationsOf)
      .filter((operation) => operation._tag === 'BeginLoan')
    assert.lengthOf(loans, 2)
    assert.notStrictEqual(loans.at(0)?.borrow.ordinal, loans.at(1)?.borrow.ordinal)
    assert.strictEqual(loans.at(0)?.root.ordinal, loans.at(1)?.root.ordinal)
    const armed = owner.suspension?.frame?.states.filter(
      (state) => state.cancellationFinalizer?._tag === 'ResourceCancellationFinalizer',
    )
    assert.lengthOf(armed ?? [], 1)

    const rejectedSource = `import silk.effect { Effect }
import silk.execution { Execution, Wake }
struct Resource {}
fn register(wake: Wake) -> () { drop wake return () }
effect fn use(resource: &mut Resource) -> i32 { return 42 }
effect fn release(resource: &mut Resource) -> () {
  run Execution.park(register)
  return ()
}
pub fn main() -> i32 {
  return run Effect.useReleaseNonParking(Resource {}, use, release)
}`
    const rejected = yield* snapshot(rejectedSource)
    const diagnostics = Analysis.diagnostics(rejected)
    assert.deepEqual(
      diagnostics.map((diagnostic) => diagnostic.code),
      ['SEM0139'],
    )
    assert.strictEqual(
      diagnostics.at(0)?.span.start,
      rejectedSource.indexOf('Effect.useReleaseNonParking'),
    )
  }),
)

it.effect('fails closed through unresolved finalizer Effect forwarding shapes', () =>
  Effect.gen(function* () {
    const prelude = `import silk.effect { Effect }
service FinalizerSource {
  effect fn acquire() -> once Effect<'static; ()> ? &FinalizerSource
}
effect fn protected() -> i32 { return 42 }`
    const direct = `${prelude}
pub effect fn main() -> i32 ? &FinalizerSource {
  let finalizer = run FinalizerSource.acquire()
  return run Effect.ensuringNonParking(protected(), move finalizer)
}`
    const forwarded = `${prelude}
fn forward<'env>(finalizer: once Effect<'env; ()>) -> once Effect<'env; ()> {
  return move finalizer
}
pub effect fn main() -> i32 ? &FinalizerSource {
  let finalizer = run FinalizerSource.acquire()
  return run Effect.ensuringNonParking(protected(), forward(move finalizer))
}`
    const stored = `${prelude}
struct Deferred<F: once fn(once Effect<'static; ()>) -> once Effect<'static; ()>> { forward: F }
fn pass(finalizer: once Effect<'static; ()>) -> once Effect<'static; ()> {
  return move finalizer
}
pub effect fn main() -> i32 ? &FinalizerSource {
  let finalizer = run FinalizerSource.acquire()
  let deferred = Deferred { forward: pass }
  return run Effect.ensuringNonParking(protected(), deferred.forward(move finalizer))
}`
    for (const source of [direct, forwarded, stored]) {
      const self = yield* snapshot(source)
      const diagnostics = Analysis.diagnostics(self)
      assert.deepEqual(
        diagnostics.map((diagnostic) => diagnostic.code),
        ['SEM0139'],
      )
      assert.strictEqual(diagnostics.at(0)?.span.start, source.indexOf('Effect.ensuringNonParking'))
    }
  }),
)

it.effect('checks an abstract finalizer service call after concrete provider selection', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
service Duplex { effect fn close() -> () ? &mut Duplex with Intrinsic.nonParking() }
struct MemoryDuplex { closed: bool }
impl Duplex for MemoryDuplex {
  effect fn close(self: &mut Self) -> () { self.closed = true return () }
}
effect fn protected() -> i32 { return 42 }
effect fn release() -> () ? &mut Duplex { return run Duplex.close() }
effect fn scoped() -> i32 ? &mut Duplex {
  return run Effect.ensuringNonParking(protected(), release())
}
pub fn main() -> i32 {
  let mut duplex = MemoryDuplex {closed: false}
  return run scoped() |> Effect.provideMut<Duplex>(&mut duplex)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])

    const parked = yield* snapshot(`import silk.effect { Effect }
import silk.execution { Execution, Wake }
service Duplex { effect fn close() -> () ? &mut Duplex with Intrinsic.nonParking() }
struct ParkingDuplex {}
fn register(wake: Wake) -> () { drop wake return () }
impl Duplex for ParkingDuplex {
  effect fn close(self: &mut Self) -> () { run Execution.park(register) return () }
}
effect fn protected() -> i32 { return 42 }
effect fn release() -> () ? &mut Duplex { return run Duplex.close() }
effect fn scoped() -> i32 ? &mut Duplex {
  return run Effect.ensuringNonParking(protected(), release())
}
pub fn main() -> i32 {
  let mut duplex = ParkingDuplex {}
  return run scoped() |> Effect.provideMut<Duplex>(&mut duplex)
}`)
    assert.include(
      Analysis.diagnostics(parked).map((diagnostic) => diagnostic.code),
      'SEM0139',
    )

    const nested = yield* snapshot(`import silk.effect { Effect }
service Duplex { effect fn close() -> () ? &mut Duplex with Intrinsic.nonParking() }
struct NestedDuplex {}
impl Duplex for NestedDuplex {
  effect fn close(self: &mut Self) -> () { return run Effect.suspend(effect { return () }) }
}
effect fn protected() -> i32 { return 42 }
effect fn release() -> () ? &mut Duplex { return run Duplex.close() }
effect fn scoped() -> i32 ? &mut Duplex {
  return run Effect.ensuringNonParking(protected(), release())
}
pub fn main() -> i32 {
  let mut duplex = NestedDuplex {}
  return run scoped() |> Effect.provideMut<Duplex>(&mut duplex)
}`)
    assert.deepEqual(Analysis.diagnostics(nested), [])
  }),
)

it.effect('retains an armed cancellation finalizer and its selected provider', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
import silk.execution { Execution, Wake }
fn register(wake: Wake) -> () { drop wake return () }
service Duplex { effect fn close() -> () ? &mut Duplex with Intrinsic.nonParking() }
struct MemoryDuplex { closed: bool }
impl Duplex for MemoryDuplex {
  effect fn close(self: &mut Self) -> () { self.closed = true return () }
}
effect fn protected() -> i32 { run Execution.park(register) return 42 }
effect fn release() -> () ? &mut Duplex { return run Duplex.close() }
effect fn scoped() -> i32 ? &mut Duplex {
  return run Effect.ensuringNonParking(protected(), release())
}
pub fn main() -> i32 {
  let mut duplex = MemoryDuplex {closed: false}
  return run scoped() |> Effect.provideMut<Duplex>(&mut duplex)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const mir = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(mir), [])
    const states = mir.functions.flatMap((fn) => fn.suspension?.frame?.states ?? [])
    const armed = states.filter((state) => state.cancellationFinalizer !== undefined)
    assert.lengthOf(armed, 1)
    const state = armed.at(0)
    assert.isDefined(state)
    const finalizer = state?.cancellationFinalizer
    assert.isDefined(finalizer)
    if (state === undefined || finalizer === undefined) return
    const retained = new Set(state.slots.map((slot) => slot.local.ordinal))
    assert.isNotEmpty(finalizer.arguments)
    for (const provider of finalizer.arguments) assert.isTrue(retained.has(provider.ordinal))
  }),
)

it.effect('keeps synchronous controls empty', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
effect fn seed(value: i32) -> i32 { return value }
fn increment(value: i32) -> i32 { return value + 1 }
pub fn main() -> i32 { return run seed(41) |> Effect.map(increment) }`
    const first = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(first), [])
    assert.deepEqual(names(first), [])
    assert.deepEqual(effectNames(first), [])
  }),
)

it.effect(
  'grants no sealed identity, property, or suspension mode to privileged-looking names',
  () =>
    Effect.gen(function* () {
      const spellings = [
        'Execution',
        'Wake',
        'Detached',
        'NonParking',
        'Scheduler',
        'Fiber',
        'Deferred',
        'Timer',
        'Coroutine',
      ] as const
      const declarations = spellings.map((name) => `struct ${name} { value: i32 }`).join('\n')
      const self = yield* snapshot(`${declarations}
pub fn main() -> i32 { return 42 }`)

      assert.deepEqual(Analysis.diagnostics(self), [])
      for (const name of spellings) {
        const type = Type.nominal('suspendability/main', name)
        assert.isFalse(Type.isExecution(type))
        assert.strictEqual(
          self.index.modules
            .at(-1)
            ?.structs.find(
              (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === name,
            )
            ?.typeParameters.some((parameter) => parameter.staticProperties.length > 0),
          false,
        )
      }
      assert.deepEqual(names(self), [])
      assert.isTrue(
        Analysis.executablePropertiesOf(self).every((fact) => fact.nonParking._tag === 'Satisfied'),
      )
    }),
)

const suspendingAllocator = `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.effect { Effect }
import silk.layout { Layout }
role SharedAudit
role ExclusiveAudit
struct SuspendingAllocator {}

effect fn allocate(
  self: &mut SuspendingAllocator,
  layout: Layout
) -> Allocation ! OutOfMemoryError {
  let delayed = Effect.suspend(effect {
    return run Intrinsic.systemAllocationAcquire(move layout)
  })
  return run delayed
}

impl Allocator for SuspendingAllocator { allocate: SuspendingAllocator.allocate }`

it.effect('keeps shared non-default Allocator demands out of private coroutine storage', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.allocator { Allocator }
import silk.effect { Effect }
${suspendingAllocator}

effect fn work() -> i32
? &Allocator at SharedAudit | &Allocator at ExclusiveAudit {
  return run Effect.suspend(effect { return 42 })
}

pub fn main() -> i32 {
  let sharedAudit = SuspendingAllocator {}
  let mut exclusiveAudit = SuspendingAllocator {}
  return run (work()
    |> Effect.provide<Allocator at SharedAudit>(&sharedAudit)
    |> Effect.provideMut<Allocator at ExclusiveAudit>(&mut exclusiveAudit))
}`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.strictEqual(Analysis.mirOf(self)._tag, 'Available')
  }),
)

it.effect('allows ordinary allocator implementations to suspend', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.allocator { Allocator }
import silk.effect { Effect }
${suspendingAllocator}

effect fn acquire() -> Allocation ! OutOfMemoryError ? &mut Allocator {
  return run Allocator.allocate(Layout.of<i32>())
}
effect fn program() -> i32 ! OutOfMemoryError {
  let mut custom = SuspendingAllocator {}
  let mut pending = acquire() |> Effect.provideMut(&mut custom)
  let allocation = run pending
  drop allocation
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(program(), recover) }`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.strictEqual(Analysis.mirOf(self)._tag, 'Available')
    const entry = self.instances.instances.find(
      (instance) => instance.key.declaration.name === 'main',
    )
    assert.isDefined(entry)
    if (entry === undefined) return
    const summary = Instances.suspensionOf(self.instances, entry.key)
    assert.isTrue(SuspensionMode.has(summary, 'NestedTransfer'))
    assert.isTrue(
      summary.causes.some((entry) =>
        entry.path.some(
          (node) => node.includes('suspendability/main') && node.includes('\u0000allocate\u0000'),
        ),
      ),
    )
  }),
)

it.effect('suspends where a binding scope exit runs a suspending drop hook', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
struct Guard { value: i32 }
impl Drop for Guard {
  fn drop(self: &mut Guard) -> () {
    let resumed = run Effect.suspend(effect { return () })
    return resumed
  }
}
fn hold() -> i32 {
  let guard = Guard {value: 42}
  return guard.value
}
pub fn main() -> i32 { return hold() }`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const hold = self.instances.instances.find(
      (instance) => instance.key.declaration.name === 'hold',
    )
    assert.isDefined(hold)
    if (hold === undefined) return
    assert.isTrue(
      SuspensionMode.has(Instances.suspensionOf(self.instances, hold.key), 'NestedTransfer'),
    )
  }),
)

it.effect('keeps suspension local to the selected provider through nested bindings', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
service Work { effect fn perform() -> i32 ? &mut Work }
struct Suspending {}
effect fn suspendingWork(self: &mut Suspending) -> i32 {
  return run Effect.suspend(effect { return 42 })
}
impl Work for Suspending { perform: Suspending.suspendingWork }
struct Immediate {}
effect fn serviceFreeLeaf() -> i32 { return 1 }
effect fn serviceFreeBranch() -> i32 { return run serviceFreeLeaf() }
effect fn immediateWork(self: &mut Immediate) -> i32 { return run serviceFreeBranch() }
impl Work for Immediate { perform: Immediate.immediateWork }
effect fn read() -> i32 ? &mut Work { return run Work.perform() }
effect fn nested() -> i32 ? &mut Work {
  let mut inner = Immediate {}
  return run read() |> Effect.provideMut<Work>(&mut inner)
}
pub fn main() -> i32 {
  let mut outer = Suspending {}
  let first = run read() |> Effect.provideMut<Work>(&mut outer)
  return first + (run nested() |> Effect.provideMut<Work>(&mut outer))
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const targets = self.instances.calls.map((call) => call.target.declaration.name)
    assert.include(targets, 'suspendingWork')
    assert.include(targets, 'immediateWork')
    assert.include(targets, 'serviceFreeBranch')
    assert.include(targets, 'serviceFreeLeaf')
    for (const [name, suspends] of [
      ['main', true],
      ['nested', false],
    ] as const) {
      const instance = self.instances.instances.find(
        (candidate) => candidate.key.declaration.name === name,
      )
      assert.isDefined(instance)
      if (instance === undefined) continue
      assert.strictEqual(
        SuspensionMode.has(Instances.suspensionOf(self.instances, instance.key), 'NestedTransfer'),
        suspends,
        name,
      )
    }
  }),
)

it.effect('ignores unused suspending operations on the selected provider witness', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
service Work {
  effect fn direct() -> i32 ? &mut Work
  effect fn delayed() -> i32 ? &mut Work
}
struct Worker {}
effect fn direct(self: &mut Worker) -> i32 { return 42 }
effect fn delayed(self: &mut Worker) -> i32 {
  return run Effect.suspend(effect { return 0 })
}
impl Work for Worker { direct: Worker.direct delayed: Worker.delayed }
effect fn program() -> i32 ? &mut Work { return run Work.direct() }
pub fn main() -> i32 {
  let mut worker = Worker {}
  return run program() |> Effect.provideMut(&mut worker)
}`)

    assert.deepEqual(Analysis.diagnostics(self), [])
    const entry = self.instances.instances.find(
      (instance) => instance.key.declaration.name === 'main',
    )
    assert.isDefined(entry)
    if (entry === undefined) return
    const summary = Instances.suspensionOf(self.instances, entry.key)
    assert.isFalse(SuspensionMode.has(summary, 'NestedTransfer'))
    const delayed = self.instances.instances.find(
      (instance) => instance.key.declaration.name === 'delayed',
    )
    assert.isUndefined(delayed)
  }),
)

const capturedScopedResourceSource = `import silk.effect { Effect }
struct Resource { value: i32 }
struct Config { value: i32 }
service Probe { effect fn read() -> i32 ? &Probe }
effect fn release(resource: &mut Resource) -> () { return () }
effect fn scoped<'env, A, E, ?R>(
  config: &'env Config,
  callback: for<'call> once fn<'env>(&'call mut Resource) -> once Effect<'call; A ! E ? R>,
) -> A ! E ? R {
  let use = effect fn(resource: &mut Resource) -> A ! E ? R {
    resource.value = config.value
    return run callback(move resource)
  }
  return run Effect.useReleaseNonParking(Resource { value: 0 }, move use, release)
}
effect fn read(resource: &mut Resource) -> i32 ? &Probe {
  return resource.value + run Probe.read()
}
pub effect fn main() -> i32 ? &Probe {
  let config = Config { value: 42 }
  return run scoped(&config, read)
}`

it.effect('preserves symbolic bracket rows without extending captured or resource lifetimes', () =>
  Effect.gen(function* () {
    const direct =
      capturedScopedResourceSource.slice(
        0,
        capturedScopedResourceSource.indexOf('  let use = effect fn'),
      ) +
      '  return run Effect.useReleaseNonParking(Resource { value: 0 }, move callback, release)' +
      capturedScopedResourceSource.slice(
        capturedScopedResourceSource.indexOf('\n}\neffect fn read'),
      )
    const programs = [
      ['captured', capturedScopedResourceSource],
      ['direct', direct],
      [
        'borrowed-generic-resource',
        `import silk.effect { Effect }
struct Resource<'storage, P> { provider: &'storage mut P }
effect fn scoped<'env, A, E, ?R, P>(
  provider: &'env mut P,
  callback: once fn<'env>() -> once Effect<'env; A ! E ? R>,
) -> A ! E ? R {
  let use = effect fn(owned: &mut Resource<'env, P>) -> A ! E ? R {
    drop owned
    return run callback()
  }
  let release = effect fn(owned: &mut Resource<'env, P>) -> () { drop owned return () }
  return run Effect.useReleaseNonParking(
    Resource<'env, P> { provider: move provider }, move use, move release,
  )
}
pub effect fn main() -> i32 {
  let mut provider = 0
  let value = 42
  let callback = effect fn() -> i32 { return value }
  return run scoped(&mut provider, move callback)
}`,
      ],
      [
        'escape',
        `import silk.effect { Effect }
struct Resource { value: i32 }
effect fn use<'scope>(resource: &'scope mut Resource) -> &'scope i32 { return &resource.value }
effect fn release(resource: &mut Resource) -> () { return () }
pub fn main() -> i32 {
  let escaped = run Effect.useReleaseNonParking(Resource { value: 42 }, use, release)
  return escaped.*
}`,
      ],
    ] as const
    for (const [name, program] of programs) {
      const self = yield* snapshot(program)
      const diagnostics = Analysis.diagnostics(self)
      assert.deepEqual(
        diagnostics.map((diagnostic) => diagnostic.code),
        name === 'escape' ? ['SEM0089'] : [],
      )
      if (name === 'escape') {
        assert.strictEqual(
          diagnostics.at(0)?.span.start,
          program.indexOf('Effect.useReleaseNonParking'),
        )
        assert.strictEqual(
          diagnostics.at(0)?.span.end,
          program.indexOf('\n', program.indexOf('Effect.useReleaseNonParking')),
        )
      }
      if (name !== 'escape') {
        const mir = Analysis.loweredMir(self)
        assert.deepEqual(yield* MirVerification.verify(mir), [])
        if (name === 'borrowed-generic-resource') {
          let changed = 0
          const withSourceArgument = (argument: Type.GenericArgument): Mir.Module => ({
            ...mir,
            functions: mir.functions.map((fn) => ({
              ...fn,
              regions: fn.regions.map((region) =>
                region._tag !== 'OperationRegion'
                  ? region
                  : {
                      ...region,
                      operations: region.operations.map((operation): Mir.Operation => {
                        if (
                          operation._tag !== 'BeginLoan' ||
                          operation.sourceType._tag !== 'Nominal' ||
                          operation.sourceType.type.name !== 'Resource'
                        )
                          return operation
                        changed += 1
                        return {
                          ...operation,
                          sourceType: {
                            ...operation.sourceType,
                            type: {
                              ...operation.sourceType.type,
                              arguments: [
                                argument,
                                ...operation.sourceType.type.arguments.slice(1),
                              ],
                            },
                          },
                        }
                      }),
                    },
              ),
            })),
          })
          // Runtime specialization may retain a different proof-only lifetime for the owned resource.
          const equivalent = withSourceArgument(Lifetime.staticLifetime)
          assert.isAbove(changed, 0)
          assert.notInclude(
            (yield* MirVerification.verify(equivalent)).map((violation) => violation.rule),
            'InvalidLoan',
          )
          const different = withSourceArgument('bool')
          assert.include(
            (yield* MirVerification.verify(different)).map((violation) => violation.rule),
            'InvalidLoan',
          )
        }
      }
    }
  }),
)

it.effect('proves a scoped generic provider release through recovered service failure', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
struct CloseError {}
service Transport {
  unsafe effect fn closeRaw() -> () ! CloseError ? &mut Transport with Intrinsic.nonParking()
}
impl Transport {
  effect fn close() -> () ! CloseError ? &mut Transport {
    return run unsafe Transport.closeRaw()
  }
}
struct Other {}
impl Other { unsafe effect fn close(self: &mut Self) -> () ! CloseError { return () } }
impl Transport for Other { closeRaw: Other.close }
struct Provider {}
impl Provider { unsafe effect fn close(self: &mut Self) -> () ! CloseError { return () } }
impl Transport for Provider { closeRaw: Provider.close }
struct Resource<'env, P> { provider: &'env mut P }
effect fn discard(error: CloseError) -> () { drop error return () }
effect fn scoped<'env, P>(provider: &'env mut P) -> i32
where &'env mut P provides &Transport from &mut Transport {
  let use = effect fn(owned: &mut Resource<'env, P>) -> i32 { drop owned return 42 }
  let release = effect fn(owned: &mut Resource<'env, P>) -> () {
    let closed = Transport.close() |> Effect.provideMut<Transport>(&mut owned.provider.*)
    return run Effect.catchAll(move closed, discard)
  }
  return run Effect.useReleaseNonParking(
    Resource<'env, P> { provider: move provider }, move use, move release,
  )
}
pub fn main() -> i32 { let mut provider = Provider {} return run scoped(&mut provider) }`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
  }),
)

it.effect('retains call shapes for an owned generic provider bracket', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
import silk.option { Option }
service Transport { effect fn work() -> i32 ? &mut Transport }
struct Provider {}
impl Provider { effect fn work(self: &mut Self) -> i32 { return 42 } }
impl Transport for Provider { work: Provider.work }
struct UnusedProvider {}
impl UnusedProvider { effect fn work(self: &mut Self) -> i32 { return 7 } }
impl Transport for UnusedProvider { work: UnusedProvider.work }
struct Guard<P> { provider: Option<P> }
effect<'env> fn scoped<P: 'env, 'env>(provider: P) -> i32
where &mut P provides &Transport from &mut Transport {
  let use = effect fn(owned: &mut Guard<P>) -> i32 {
    return match &mut owned.provider {
      Option<P>.None => 0
      Option<P>.Some {value} => run Transport.work()
        |> Effect.provideMut<Transport>(&mut value)
    }
  }
  let release = effect fn(owned: &mut Guard<P>) -> () { drop owned return () }
  return run Effect.useReleaseNonParking(
    Guard<P> {provider: Option.some<P>(move provider)},
    move use,
    move release,
  )
}
pub fn main() -> i32 { return run scoped<Provider>(Provider {}) }`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    const module = Analysis.loweredMir(self)
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const callbackRunners = module.functions.filter(
      (fn) => fn.id.name === 'scoped$callable$0$effect$-1',
    )
    assert.lengthOf(callbackRunners, 1)
    const providedRuns = callbackRunners.flatMap(MirVerification.operations).filter(
      (
        operation,
      ): operation is Extract<
        Mir.Operation,
        {
          readonly _tag: 'RunEffectValue'
        }
      > =>
        operation._tag === 'RunEffectValue' && operation.runner.name === 'Provider.work$effect$-1',
    )
    assert.lengthOf(providedRuns, 1)
    assert.isFalse(module.functions.some((fn) => fn.id.name === 'UnusedProvider.work$effect$-1'))
  }),
)

it.effect('lowers a scoped callback forwarded through a generic acquisition helper', () =>
  Effect.gen(function* () {
    const source = `import silk.effect { Effect }
service Audit { effect fn record() -> () ? &mut Audit }
struct Recorder {}
impl Audit for Recorder { effect fn record(self: &mut Self) -> () { return () } }
struct Provider {}
struct Resource<'env, P> { provider: &'env mut P }
struct Connection<'env, P> { provider: &'env mut P }
effect fn acquireAndUse<'env, 'transport, A, E, ?R, P>(
  provider: &'transport mut P,
  callback: for<'call> once fn<'env>(
    &'call mut Connection<'call, P>
  ) -> once Effect<'call; A ! E ? R>,
) -> A ! E ? R {
  let mut connection = Connection { provider: &mut provider.* }
  return run callback(&mut connection)
}
effect fn scoped<'env, A, E, ?R, P>(
  provider: &'env mut P,
  callback: for<'call> once fn<'env>(
    &'call mut Connection<'call, P>
  ) -> once Effect<'call; A ! E ? R>,
) -> A ! E ? R {
  let use = effect fn(owned: &mut Resource<'env, P>) -> A ! E ? R {
    return run acquireAndUse(&mut owned.provider.*, move callback)
  }
  let release = effect fn(owned: &mut Resource<'env, P>) -> () { drop owned return () }
  return run Effect.useReleaseNonParking(
    Resource<'env, P> { provider: move provider }, move use, move release,
  )
}
effect<'call> fn used<'call, P>(connection: &'call mut Connection<'call, P>) -> i32 ? &mut Audit {
  drop connection
  run Audit.record()
  return 42
}
pub fn main() -> i32 {
  let mut provider = Provider {}
  let mut audit = Recorder {}
  return run scoped(&mut provider, used) |> Effect.provideMut<Audit>(&mut audit)
}`
    const self = yield* snapshot(source)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
  }),
)

it.effect('retains provider contracts for direct and recovered borrowed method calls', () =>
  Effect.gen(function* () {
    const callerOrders = Object.freeze([
      Object.freeze({
        name: 'direct-first',
        body: `let first = run direct(&mut directConnection) |> Effect.provideMut<Audit>(&mut audit)
  return run used(&mut recoveredConnection) |> Effect.provideMut<Audit>(&mut audit)`,
      }),
      Object.freeze({
        name: 'recovered-first',
        body: `let first = run used(&mut recoveredConnection) |> Effect.provideMut<Audit>(&mut audit)
  return run direct(&mut directConnection) |> Effect.provideMut<Audit>(&mut audit)`,
      }),
    ])
    const runnerSymbolsByOrder: Array<ReadonlyArray<string>> = []
    for (const order of callerOrders) {
      const self = yield* snapshot(`import silk.effect { Effect }
import silk.result { Result }
pub struct Fault {}
service Work { effect fn read() -> i32 ! Fault ? &mut Work }
service Audit { effect fn record() -> () ? &mut Audit }
struct Provider {}
impl Work for Provider { effect fn read(self: &mut Self) -> i32 ! Fault { fail Fault {} } }
struct Recorder {}
impl Audit for Recorder { effect fn record(self: &mut Self) -> () { return () } }
effect fn perform(output: &mut [i32]) -> i32 ! Fault ? &mut Work | &mut Audit {
  run Audit.record()
  return run Work.read()
}
struct OperationGuard<'env, P> { provider: &'env mut P completed: bool }
struct Connection<P> { provider: P }
impl<P> Connection<P> {
  effect fn read<'connection>(self: &'connection mut Self, output: &mut [i32]) -> i32 ! Fault ? &mut Audit
  where &mut P provides &Work from &mut Work | &mut Audit {
    if output.length == 0 { return 0 }
    let guard = OperationGuard<'connection, P> {
      provider: &mut self.provider,
      completed: false,
    }
    let use = effect fn(owned: &mut OperationGuard<'connection, P>) -> i32 ! Fault ? &mut Audit {
      let operation = perform(move output)
        |> Effect.provideMut<Work>(&mut owned.provider.*)
      let attempted = run Effect.result(move operation)
      owned.completed = true
      return match move attempted {
        Result<i32, Fault>.Success {value} => value
        Result<i32, Fault>.Failure {error} => { fail move error }
      }
    }
    let release = effect fn(owned: &mut OperationGuard<'connection, P>) -> () {
      drop owned
      return ()
    }
    return run Effect.useReleaseNonParking(move guard, move use, move release)
  }
}
effect fn used(connection: &mut Connection<Provider>) -> i32 ! Fault ? &mut Audit {
  let mut output = [0]
  let first = run Connection.read(&mut connection.*, &mut output)
  let recovered = run Effect.result(Connection.read(&mut connection.*, &mut output))
  drop recovered
  return first
}
effect fn direct(connection: &mut Connection<Provider>) -> i32 ! Fault ? &mut Audit {
  let mut output = [0]
  return run Connection.read(&mut connection.*, &mut output)
}
pub effect fn main() -> i32 ! Fault {
  let mut directConnection = Connection<Provider> {provider: Provider {}}
  let mut recoveredConnection = Connection<Provider> {provider: Provider {}}
  let mut audit = Recorder {}
  ${order.body}
}`)
      assert.deepEqual(Analysis.diagnostics(self), [], order.name)
      const mir = Analysis.loweredMir(self)
      assert.deepEqual(yield* MirVerification.verify(mir), [], order.name)
      const runners = mir.functions.filter(
        (fn) => fn.effectRunner?.base.declaration.name === 'Connection.read$effect$-1',
      )
      assert.isNotEmpty(runners, order.name)
      const runnerSymbols = runners.map(Backend.symbolFor).sort()
      runnerSymbolsByOrder.push(Object.freeze(runnerSymbols))
      assert.strictEqual(new Set(runnerSymbols).size, runners.length, order.name)
      assert.strictEqual(
        new Set(mir.functions.map(Backend.symbolFor)).size,
        mir.functions.length,
        order.name,
      )
      for (const callerName of ['direct', 'used']) {
        const caller = mir.functions.find((fn) => fn.id.name === callerName)
        assert.isDefined(caller, `${order.name}: ${callerName} caller`)
        if (caller === undefined) continue
        const [constructed] = MirVerification.operations(caller).filter(
          (
            operation,
          ): operation is Extract<
            Mir.Operation,
            {
              readonly _tag: 'MakeEffect'
            }
          > => operation._tag === 'MakeEffect',
        )
        assert.isDefined(constructed, `${order.name}: ${callerName} Effect construction`)
        if (constructed === undefined) continue
        assert.lengthOf(constructed.captures, 1, `${order.name}: ${callerName} capture`)
        const specializedCallers = mir.functions.filter(
          (fn) => fn.effectRunner?.base.declaration.name === `${callerName}$effect$-1`,
        )
        assert.lengthOf(
          specializedCallers,
          1,
          `${order.name}: ${callerName} canonical provided runner`,
        )
        const callerRunner = specializedCallers.at(0)
        if (callerRunner === undefined) continue
        assert.strictEqual(
          callerRunner.parameterCount,
          constructed.captures.length + (callerRunner.effectRunner?.providers.length ?? 0),
          `${order.name}: ${callerName} captures and caller providers`,
        )
        const callerProvider = callerRunner.effectRunner?.providers.at(0)
        assert.strictEqual(callerProvider?.capability.name, 'Audit', order.name)
        assert.strictEqual(callerProvider?.providerType.name, 'Recorder', order.name)
        const [providedRun] = MirVerification.operations(callerRunner).filter(
          (
            operation,
          ): operation is Extract<
            Mir.Operation,
            {
              readonly _tag: 'RunEffectValue'
            }
          > =>
            operation._tag === 'RunEffectValue' &&
            operation.runnerBase?.declaration.name === 'Connection.read$effect$-1',
        )
        assert.isDefined(providedRun, `${order.name}: ${callerName} Connection.read run target`)
        if (providedRun === undefined) continue
        assert.match(
          providedRun.runner.name,
          /^Connection\.read\$effect\$-1\$provided\$\d+$/,
          `${order.name}: ${callerName} provided runner identity`,
        )
        assert.strictEqual(
          providedRun.runnerBase?.declaration.name,
          'Connection.read$effect$-1',
          `${order.name}: ${callerName} open runner base`,
        )
        assert.lengthOf(providedRun.providers, 1, `${order.name}: ${callerName} provider count`)
        assert.lengthOf(providedRun.arguments, 1, `${order.name}: ${callerName} provider argument`)
        const provider = providedRun.providers.at(0)
        assert.strictEqual(provider?.capability.name, 'Audit', order.name)
        assert.strictEqual(provider?.providerType.name, 'Recorder', order.name)
        assert.strictEqual(provider?.witness._tag, 'SourceConformanceWitness', order.name)
        const effect = callerRunner.localTypes.at(providedRun.effect.ordinal)
        assert.strictEqual(effect?._tag, 'EffectValue', `${order.name}: ${callerName} Effect value`)
        if (effect?._tag !== 'EffectValue') continue
        assert.isAbove(effect.environment.fields.length, 0, `${order.name}: ${callerName} captures`)
        const selectedRunner = mir.functions.find((fn) =>
          Mir.matchesInstance(
            fn,
            providedRun.runner,
            providedRun.runnerTypeArguments,
            providedRun.runnerStaticArguments ?? Object.freeze([]),
          ),
        )
        assert.isDefined(selectedRunner, `${order.name}: ${callerName} published runner`)
        if (selectedRunner === undefined) continue
        assert.strictEqual(
          selectedRunner.parameterCount,
          effect.environment.fields.length + providedRun.arguments.length,
          `${order.name}: ${callerName} runner captures and providers`,
        )
        assert.include(runners, selectedRunner, order.name)
        const boundProvider = selectedRunner.effectRunner?.providers.at(0)
        assert.strictEqual(boundProvider?.role, provider?.role, order.name)
        assert.strictEqual(boundProvider?.access, provider?.access, order.name)
        assert.strictEqual(
          boundProvider?.requirementAccess,
          provider?.requirementAccess,
          order.name,
        )
        assert.strictEqual(boundProvider?.capability.name, provider?.capability.name, order.name)
        assert.strictEqual(
          boundProvider?.providerType.name,
          provider?.providerType.name,
          order.name,
        )
        assert.strictEqual(boundProvider?.witness._tag, provider?.witness._tag, order.name)
        if (callerName === 'used') {
          const recovered = MirVerification.operations(callerRunner).find(
            (operation) =>
              operation._tag === 'RunEffectValue' &&
              operation.runnerBase?.declaration.name === 'Effect.result$effect$-1',
          )
          assert.isDefined(recovered, `${order.name}: recovered Effect.result run target`)
        }
      }
      const corrupted = {
        ...mir,
        functions: mir.functions.map((fn) =>
          runners.includes(fn) && fn.effectRunner !== undefined
            ? {
                ...fn,
                effectRunner: {
                  ...fn.effectRunner,
                  base: {
                    ...fn.effectRunner.base,
                    typeArguments: fn.effectRunner.base.typeArguments.map((argument) =>
                      Type.isTypeArgument(argument) &&
                      Type.isNominal(argument) &&
                      argument.name === 'Provider'
                        ? Type.nominal('suspendability/main', 'Recorder')
                        : argument,
                    ),
                  },
                },
              }
            : fn,
        ),
      }
      assert.isTrue(
        (yield* MirVerification.verify(corrupted)).some(
          (failure) => failure.rule === 'InvalidEffectOperation',
        ),
        order.name,
      )
    }
    const directFirst = runnerSymbolsByOrder.at(0)
    const recoveredFirst = runnerSymbolsByOrder.at(1)
    assert.isDefined(directFirst)
    assert.isDefined(recoveredFirst)
    if (directFirst !== undefined && recoveredFirst !== undefined) {
      assert.deepEqual(directFirst, recoveredFirst)
    }
  }),
)

it.effect('retains parking control through a provided service implementation', () =>
  Effect.gen(function* () {
    const self = yield* snapshot(`import silk.effect { Effect }
import silk.execution { Execution, Wake }
import silk.allocator { Allocator, OutOfMemoryError }
service Clock { effect fn wait() -> () ? &mut Clock }
service Transport { effect fn read() -> i32 ? &mut Transport | &mut Clock }
struct Guard { wake: Wake }
fn register(wake: Wake) -> Guard { return Guard { wake: move wake } }
struct ParkingClock {}
impl Clock for ParkingClock {
  effect fn wait(self: &mut Self) -> () { run Execution.park(register) return () }
}
struct ReadyClock {}
impl Clock for ReadyClock { effect fn wait(self: &mut Self) -> () { return () } }
struct Reader {}
impl Transport for Reader {
  effect fn read(self: &mut Self) -> i32 ? &mut Clock { run Clock.wait() return 42 }
}
effect fn read() -> i32 ? &mut Transport | &mut Clock { return run Transport.read() }
struct Lease<'env, P> { provider: &'env mut P }
effect fn scoped<'env, A, E, ?R, P>(
  provider: &'env mut P,
  callback: for<'call> once fn<'env>(&'call mut P) -> once Effect<'call; A ! E ? R>,
) -> A ! E ? R | &mut Clock
where &'env mut P provides &Transport from &mut Transport | &mut Clock {
  let use = effect fn(owned: &mut Lease<'env, P>) -> A ! E ? R | &mut Clock {
    let readValue = run read() |> Effect.provideMut<Transport>(&mut owned.provider.*)
    return run callback(&mut owned.provider.*)
  }
  let release = effect fn(owned: &mut Lease<'env, P>) -> () { drop owned return () }
  return run Effect.useReleaseNonParking(Lease<'env, P> { provider: move provider }, move use, move release)
}
effect<'call> fn callback<'call, P>(provider: &'call mut P) -> i32 { drop provider return 42 }
effect fn recovered(reader: &mut Reader) -> i32 ? &mut Clock {
  let result = run Effect.result(scoped(&mut reader.*, callback))
  drop result
  return 42
}
effect fn program() -> i32 {
  let mut clock = ParkingClock {}
  let mut reader = Reader {}
  return run recovered(&mut reader) |> Effect.provideMut<Clock>(&mut clock)
}
effect fn immediate() -> i32 {
  let mut clock = ReadyClock {}
  let mut reader = Reader {}
  return run recovered(&mut reader) |> Effect.provideMut<Clock>(&mut clock)
}
fn ready(state: &()) -> () { return () }
fn completed(state: &mut i32, value: i32) -> () { state.* = value return () }
fn parked(state: &mut i32, execution: Intrinsic.Execution<i32>) -> () {
  drop move execution
  state.* = 42
  return ()
}
effect fn canceled() -> i32 ! OutOfMemoryError ? &mut Allocator {
  let immediateValue = run immediate()
  let execution = run Execution.make(program(), (), ready)
  let mut state = 0
  run Execution.drive(move execution, &mut state, completed, parked)
  return state
}
effect fn failed(error: OutOfMemoryError) -> i32 { drop error return -1 }
pub fn main() -> i32 {
  let mut allocator = Allocator.systemAllocatorProvider()
  return run Effect.catchAll(canceled(), failed) |> Effect.provideMut<Allocator>(&mut allocator)
}`)
    assert.deepEqual(Analysis.diagnostics(self), [])
    assert.deepEqual(yield* MirVerification.verify(Analysis.loweredMir(self)), [])
    for (const name of ['.read$effect$', 'recovered$effect$']) {
      const readers = Analysis.loweredMir(self).functions.filter(
        (fn) =>
          fn.id.name.includes(name) &&
          fn.instance.contractRow.some((entry) => entry.startsWith('provided:')),
      )
      const parkedReader = readers.find((fn) =>
        fn.instance.contractRow.some((entry) => entry.includes('.ParkingClock<>')),
      )
      const immediateReader = readers.find((fn) =>
        fn.instance.contractRow.some((entry) => entry.includes('.ReadyClock<>')),
      )
      assert.isDefined(parkedReader)
      assert.isDefined(immediateReader)
      assert.strictEqual(parkedReader?.suspension?.classification, 'Suspendable')
      assert.isTrue(
        parkedReader?.suspension?.regions.some(
          (region) => region._tag === 'RunSuspendableEffectRegion',
        ),
      )
      assert.isUndefined(immediateReader?.suspension)
    }
  }),
)

it.effect('retains a nonparking release that does not capture its generic sibling callback', () =>
  Effect.gen(function* () {
    const self = yield* AnalysisFixture.retainingMain(
      'suspendability/uncaptured-callback',
      encoder.encode(`import silk.effect {Effect}
struct Box {value: i32}
effect fn bracket<'env, A, E, ?R>(
  resource: Box,
  flag: bool,
  callback: for<'scope> once fn<'env>(&'scope mut Box) -> once Effect<'scope & 'env; A ! E ? R>,
) -> A ! E ? R {
  let use = effect fn(owned: &mut Box) -> A ! E ? R {
    return run callback(move owned)
  }
  let release = effect fn(owned: &mut Box) -> () {
    if flag { owned.value = 0 }
    return ()
  }
  return run Effect.useReleaseNonParking(move resource, move use, move release)
}
effect fn read(owned: &mut Box) -> i32 { return owned.value }
pub fn main() -> i32 { return run bracket(Box {value: 42}, true, read) }
`),
      'wasm32-unknown-unknown',
    )
    assert.deepEqual(
      Analysis.diagnostics(self).map((diagnostic) => diagnostic.code),
      [],
    )
    const mir = Analysis.loweredMir(self)
    assert.isTrue(mir.functions.some((fn) => fn.id.name === 'main'))
    assert.deepEqual(yield* MirVerification.verify(mir), [])
  }),
)
