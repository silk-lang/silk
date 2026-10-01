import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import * as Layout from '../src/Layout.js'
import * as Instances from '../src/Instances.js'
import * as LayoutEncode from '../src/LayoutEncode.js'
import * as LayoutVerify from '../src/LayoutVerify.js'
import * as Target from '../src/Target.js'
import * as Tir from '../src/Tir.js'
import * as Type from '../src/Type.js'
import { unreachable } from './support/raise.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

const storedLayout = Effect.fnUntraced(function* (
  name: string,
  source: string,
  target: Target.Target,
) {
  const snapshot = yield* AnalysisFixture.retainingMain(name, ascii(source), target.id)
  const catalog = yield* Layout.computeTypes(target, snapshot.index, snapshot.resolution.contexts)
  const plan = yield* Layout.computeRuntime(catalog, snapshot.instances, snapshot.index)
  return Object.freeze({ snapshot, catalog, plan })
})

const representedEntry = (plan: Layout.Plan): Layout.Entry =>
  plan.entries.find(
    (entry) =>
      Type.isRepresented(entry.type) && entry.representation._tag === 'StoredEffectEnvironment',
  ) ?? unreachable('expected one represented Effect layout')

it.effect('places an owned stored Effect environment inline in its enclosing nominal ABI', () =>
  Effect.gen(function* () {
    const source = `struct Token { value: i32 }
struct Deferred<F: once Effect<i32>> { operation: F }
fn consume(token: Token) -> i32 { return token.value }
pub fn main() -> i32 {
  let token = Token { value: 7 }
  let deferred = Deferred { operation: effect { return consume(move token) } }
  return 0
}`
    for (const target of [Target.wasm32UnknownUnknown, Target.aarch64AppleDarwin]) {
      const { snapshot, catalog, plan } = yield* storedLayout(
        'stored-effect-layout/owned',
        source,
        target,
      )
      const represented = representedEntry(plan)
      const deferred =
        plan.entries.find(
          (entry) => Type.isNominal(entry.type) && entry.type.name === 'Deferred',
        ) ?? unreachable('expected Deferred layout')

      assert.notInclude(
        Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
        'SEM0107',
      )
      assert.strictEqual(snapshot.layoutCatalog._tag, 'Available')
      assert.strictEqual(snapshot.layout._tag, 'Available')
      assert.strictEqual(snapshot.mir._tag, 'Available')
      assert.strictEqual(represented.representation._tag, 'StoredEffectEnvironment')
      if (represented.representation._tag !== 'StoredEffectEnvironment') continue
      assert.deepEqual(
        represented.representation.fields.map((field) => ({
          capture: field.capture,
          access: field.access,
          representation: field.representation,
          offset: field.offset,
          size: field.size,
        })),
        [{ capture: 0, access: 'Take', representation: 'Value', offset: 0, size: 4 }],
      )
      assert.strictEqual(represented.size, 4)
      assert.strictEqual(represented.alignment, 4)
      assert.strictEqual(deferred.representation._tag, 'Aggregate')
      assert.deepEqual(LayoutVerify.verifyCatalog(catalog, snapshot.index), [])
      assert.deepEqual(yield* LayoutVerify.verify(plan), [])
    }
  }),
)

it.effect('keeps exact rows compile-time-only and suspendability in the layout dependency', () =>
  Effect.gen(function* () {
    const { plan } = yield* storedLayout(
      'stored-effect-layout/suspending',
      `import silk.effect { Effect }
struct Deferred<F: Effect<i32>> { operation: F }
effect fn delayed() -> i32 {
  return run Effect.suspend(effect { return 42 })
}
pub fn main() -> i32 {
  let deferred = Deferred { operation: effect { return run delayed() } }
  return 0
}`,
      Target.wasm32UnknownUnknown,
    )
    const represented = representedEntry(plan)

    assert.strictEqual(represented.representation._tag, 'StoredEffectEnvironment')
    if (represented.representation._tag !== 'StoredEffectEnvironment') return
    assert.strictEqual(represented.representation.realization.suspendable, true)
    assert.deepEqual(
      represented.representation.realization.rows.failures.map(Type.encode),
      Type.failureMembers(represented.representation.realization.contract).map(Type.encode),
    )
    assert.deepEqual(
      represented.representation.realization.rows.requirements,
      Type.requirementMembers(represented.representation.realization.contract),
    )
    const shape =
      plan.callingShapes.find((candidate) => Type.equals(candidate.type, represented.type)) ??
      unreachable('expected represented Effect calling shape')
    assert.strictEqual(shape.tree._tag, 'EffectEnvironmentShape')
    assert.strictEqual(shape.laneCount, represented.representation.fields.length)
    assert.include(LayoutEncode.encode(plan), 'suspendable=yes')
  }),
)

it.effect('keeps nested owners deterministic without assigning structural Effect an ABI', () =>
  Effect.gen(function* () {
    const source = `struct Deferred<F: Effect<i32>> { operation: F }
struct Boxed<F: Effect<i32>> { inner: Deferred<F> }
pub fn main() -> i32 {
  let deferred = Deferred { operation: effect { return 42 } }
  let boxed = Boxed { inner: move deferred }
  return 0
}`
    const first = yield* storedLayout(
      'stored-effect-layout/nested',
      source,
      Target.wasm32UnknownUnknown,
    )
    const second = yield* storedLayout(
      'stored-effect-layout/nested',
      source,
      Target.wasm32UnknownUnknown,
    )

    assert.strictEqual(LayoutEncode.encode(first.plan), LayoutEncode.encode(second.plan))
    assert.deepEqual(yield* LayoutVerify.verify(first.plan), [])
    assert.isFalse(first.plan.entries.some((entry) => Type.isEffect(entry.type)))
  }),
)

it.effect('shapes nested Effect and callable captures from their concrete environments', () =>
  Effect.gen(function* () {
    const { plan } = yield* storedLayout(
      'stored-effect-layout/nested-executables',
      `import silk.i32
struct Token { value: i32 }
struct Deferred<F: once Effect<i32>> { operation: F }
pub fn main() -> i32 {
  let token = Token { value: 1 }
  let nested = effect { return token.value }
  let transform = i32.add(1)
  let deferred = Deferred { operation: effect {
    let base = run move nested
    return transform(base)
  } }
  return 0
}`,
      Target.wasm32UnknownUnknown,
    )
    const represented = representedEntry(plan)
    const shape = Layout.callingShape(plan, represented.type)

    assert.strictEqual(represented.representation._tag, 'StoredEffectEnvironment')
    assert.strictEqual(shape?.tree._tag, 'EffectEnvironmentShape')
    if (
      represented.representation._tag !== 'StoredEffectEnvironment' ||
      shape?.tree._tag !== 'EffectEnvironmentShape'
    )
      return
    assert.deepEqual(
      shape.tree.fields.map((field) => field.shape._tag),
      ['EffectEnvironmentShape', 'CallableEnvironmentShape'],
    )
    assert.strictEqual(
      shape.laneCount,
      shape.tree.fields.reduce((total, field) => total + field.shape.laneCount, 0),
    )
    const effect =
      plan.effectEnvironments.find((candidate) => candidate._tag === 'EffectEnvironment') ??
      unreachable('expected available Effect environment')
    const alternate = {
      ...effect,
      instance: {
        ...effect.instance,
        declaration: { ...effect.instance.declaration, name: 'alternate' },
      },
    }
    const alias = Instances.effectIdentity(alternate.instance, alternate.site)
    const first = { ...effect, successEffectIdentity: alias }
    const effects: ReadonlyArray<Layout.EffectEnvironment> = [
      {
        _tag: 'UnavailableEffectEnvironment',
        instance: alternate.instance,
        site: alternate.site,
        effect: alternate.effect,
        reason: 'unavailable fixture',
      },
      first,
      alternate,
    ]
    const aliased = { ...plan, effectEnvironments: effects }
    assert.strictEqual(Layout.effectEnvironmentByFieldIdentity(aliased, alias), first)
    assert.strictEqual(
      Layout.effectEnvironmentByFieldIdentity(
        aliased,
        Instances.effectIdentity(first.instance, first.site),
      ),
      first,
    )
    assert.strictEqual(Layout.effectEnvironmentByFieldIdentity(aliased, 'missing'), undefined)
    assert.strictEqual(
      Layout.effectEnvironmentByFieldIdentity(
        { ...aliased, effectEnvironments: [alternate, first] },
        alias,
      ),
      alternate,
    )
    const callable =
      plan.callableEnvironments.find((candidate) => candidate._tag === 'CallableEnvironment') ??
      unreachable('expected available callable environment')
    const second = { ...callable, size: callable.size + 1 }
    const callables: ReadonlyArray<Layout.CallableEnvironment> = [
      {
        _tag: 'UnavailableCallableEnvironment',
        callable: callable.callable,
        view: callable.view,
        reason: 'unavailable fixture',
      },
      callable,
      second,
    ]
    const identity = Instances.callableEnvironmentIdentity(callable.callable)
    const callablePlan = { ...plan, callableEnvironments: callables }
    assert.strictEqual(Layout.callableEnvironmentByIdentity(callablePlan, identity), callable)
    assert.strictEqual(
      Layout.callableEnvironmentByIdentity(
        callablePlan,
        Type.callableEnvironmentIdentity(identity.site, identity.owner),
      ),
      callable,
    )
    assert.strictEqual(
      Layout.callableEnvironmentByIdentity(
        callablePlan,
        Type.callableEnvironmentIdentity(
          { ...identity.site, ordinal: identity.site.ordinal + 1 },
          identity.owner,
        ),
      ),
      undefined,
    )
    assert.strictEqual(
      Layout.callableEnvironmentByIdentity(
        { ...callablePlan, callableEnvironments: [second, callable] },
        identity,
      ),
      second,
    )
    assert.deepEqual(Layout.callableEnvironmentsByIdentity(callablePlan, identity), [
      callable,
      second,
    ])
    assert.deepEqual(Layout.callableEnvironmentsByOwner(callablePlan, callable.callable.owner), [
      callable,
      second,
    ])
    const retained = Type.callableIdentityArgument(
      '',
      Tir.callableTargetIdentity(callable.callable.target),
      callable.callable.typeArguments,
      identity,
    )
    assert.strictEqual(Layout.callableEnvironmentMatching(callablePlan, retained), callable)
    assert.strictEqual(
      Layout.callableEnvironmentMatching(
        { ...callablePlan, callableEnvironments: [second, callable] },
        retained,
      ),
      second,
    )
    assert.strictEqual(
      Layout.callableEnvironmentMatching(
        callablePlan,
        Type.callableIdentityArgument(retained.identity, retained.target, retained.typeArguments),
      ),
      undefined,
    )
    assert.deepEqual(yield* LayoutVerify.verify(plan), [])
  }),
)

it.effect('preserves local executable identities through recursively nested Effects', () =>
  Effect.gen(function* () {
    const { plan } = yield* storedLayout(
      'stored-effect-layout/deep-nested-executables',
      `import silk.i32
struct Deferred<F: once Effect<i32>> { operation: F }
pub fn main() -> i32 {
  let deepest = effect { return 1 }
  let transform = i32.add(1)
  let middle = effect {
    let base = run move deepest
    return transform(base)
  }
  let deferred = Deferred { operation: effect { return run move middle } }
  return 0
}`,
      Target.wasm32UnknownUnknown,
    )
    const represented = representedEntry(plan)
    const shape = Layout.callingShape(plan, represented.type)

    assert.strictEqual(shape?.tree._tag, 'EffectEnvironmentShape')
    if (shape?.tree._tag !== 'EffectEnvironmentShape') return
    const middle = shape.tree.fields.at(0)?.shape
    assert.strictEqual(middle?._tag, 'EffectEnvironmentShape')
    if (middle?._tag !== 'EffectEnvironmentShape') return
    assert.deepEqual(
      middle.fields.map((field) => field.shape._tag),
      ['EffectEnvironmentShape', 'CallableEnvironmentShape'],
    )
    assert.deepEqual(yield* LayoutVerify.verify(plan), [])
  }),
)
