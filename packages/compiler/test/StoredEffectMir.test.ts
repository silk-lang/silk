import * as Layer from 'effect/Layer'
import * as OpaqueRealization from '../src/OpaqueRealization.js'
import * as AnalysisFixture from './support/AnalysisFixture.js'
import { assert, it } from '@effect/vitest'
import * as Effect from 'effect/Effect'
import * as Analysis from '../src/Analysis.js'
import type * as CleanupPlan from '../src/CleanupPlan.js'
import * as ConformanceProof from '../src/ConformanceProof.js'
import * as Instances from '../src/Instances.js'
import * as CoroutineFrame from '../src/CoroutineFrame.js'
import * as Layout from '../src/Layout.js'
import * as Lifetime from '../src/Lifetime.js'
import type * as Lower from '../src/Lower.js'
import * as Mir from '../src/Mir.js'
import * as MirEncoding from '../src/MirEncoding.js'
import * as MirNormalization from '../src/MirNormalization.js'
import * as MirLinearization from '../src/MirLinearization.js'
import * as NativeOutcomeStorage from '../src/NativeOutcomeStorage.js'
import * as MirVerification from '../src/MirVerification.js'
import * as ProvisionalMir from '../src/ProvisionalMir.js'
import * as SourceFile from '../src/SourceFile.js'
import * as SourceCallView from '../src/SourceCallView.js'
import * as Tir from '../src/Tir.js'
import * as SourceResolver from '../src/SourceResolver.js'
import * as SuspensionMir from '../src/SuspensionMir.js'
import * as SuspensionOwnership from '../src/SuspensionOwnership.js'
import * as Target from '../src/Target.js'
import * as Type from '../src/Type.js'
import * as ValueType from '../src/ValueType.js'
import { unreachable } from './support/raise.js'
import { recoveredProvidedWrite, recoveredWriterModule } from './support/recoveredProvidedWrite.js'

const ascii = (value: string): Uint8Array =>
  Uint8Array.from(value, (character) => character.charCodeAt(0))

it('maps proven providers onto lifetime-erased runner requirements without guessing ambiguity', () => {
  const owner = { module: 'providers', name: 'borrow' }
  const capability = (ordinal: number) =>
    Type.nominal('providers', 'Read', [Lifetime.bound(owner, ordinal, 'borrow')])
  const provide = (ordinal: number): Lower.ProvidedRequirement => {
    const selected = capability(ordinal)
    return {
      capability: selected,
      providerType: selected,
      witness: { _tag: 'IdentityConformanceWitness', capability: selected, provider: selected },
      role: 'DefaultRole',
      access: 'Exclusive',
      requirementAccess: 'Exclusive',
    }
  }
  const requested = capability(0)
  const effect = Type.effect(
    'i32',
    [],
    {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
    },
    'Shared',
    [{ capability: requested, role: 'DefaultRole', access: 'Exclusive' }],
  )
  const caller = provide(1)
  assert.deepEqual(ValueType.requirementsFor([caller], effect), [
    { ...caller, capability: requested },
  ])
  const exact = provide(0)
  assert.deepEqual(ValueType.requirementsFor([caller, exact], effect), [exact])
  assert.strictEqual(ValueType.requirementsFor([caller, provide(2)], effect), undefined)
  assert.strictEqual(ValueType.requirementsFor([{ ...caller, role: 'Other' }], effect), undefined)
  assert.strictEqual(
    ValueType.requirementsFor([{ ...caller, access: 'Shared' }], effect),
    undefined,
  )
  assert.strictEqual(
    ValueType.requirementsFor(
      [{ ...caller, capability: Type.nominal('providers', 'Write') }],
      effect,
    ),
    undefined,
  )
})

const lowerStored = Effect.fnUntraced(function* (
  name: string,
  source: string,
  imports: ReadonlyMap<string, Uint8Array> = new Map(),
  target: Target.Id = Target.wasm32UnknownUnknown.id,
) {
  const configuration = AnalysisFixture.configuration(name, target)
  const frontend = yield* Analysis.make({
    root: name,
    configuration,
  }).pipe(
    Effect.provide(
      SourceResolver.overlay([SourceFile.make(name, ascii(source))]).pipe(
        Layer.provideMerge(SourceResolver.memory(imports)),
      ),
    ),
  )
  const snapshot = yield* Analysis.realize(frontend, configuration, {
    normalizeMir: false,
  }).pipe(Effect.provide(SourceResolver.empty))
  const layout =
    snapshot.layout._tag === 'Available' ? snapshot.layout.value : unreachable('expected layout')
  const module = Analysis.loweredMir(snapshot)
  return Object.freeze({ snapshot, layout, module })
})

const finalizeSuspension = (
  snapshot: Analysis.Snapshot,
  module: Mir.Module,
  layout: Layout.Plan,
): Mir.Module => {
  const provisional = ProvisionalMir.build(snapshot.instances, layout, snapshot.index)
  const normalized = MirNormalization.normalize(module, provisional)
  return CoroutineFrame.apply(
    SuspensionMir.finalize(
      normalized,
      provisional,
      SuspensionOwnership.plan(
        normalized,
        provisional,
        snapshot.index,
        OpaqueRealization.catalogOf(snapshot),
      ),
      snapshot.index,
    ),
  )
}

it.effect('retains borrowed anonymous effect captures as loans', () =>
  Effect.gen(function* () {
    const { snapshot, layout } = yield* lowerStored(
      'stored-effect-mir/borrowed-provider',
      `import silk.effect {Effect}
struct Marker { value: i32 }
impl Drop for Marker { fn drop(self: &mut Marker) -> () { return () } }
effect fn discard<'env>(provide: once fn<'env>() -> once Effect<'env; i32>) -> i32 {
  if true {
    drop move provide
    return 1
  }
  return run provide()
}
pub fn main() -> i32 {
  let marker = Marker { value: 7 }
  return run discard(effect fn() -> i32 { return marker.value })
}`,
      new Map(),
      Target.aarch64AppleDarwin.id,
    )
    assert.deepEqual(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      [],
    )
    const markerFields = (
      fields: ReadonlyArray<Layout.CallableEnvironmentField | Layout.EffectEnvironmentField>,
    ) =>
      fields
        .filter((field) => Type.encode(field.type).endsWith('.Marker'))
        .map((field) => ({ access: field.access, representation: field.representation }))
    assert.deepEqual(
      layout.callableEnvironments
        .filter((environment) => environment._tag === 'CallableEnvironment')
        .flatMap((environment) => markerFields(environment.fields)),
      [{ access: 'Shared', representation: 'Borrow' }],
    )
    assert.deepEqual(
      layout.effectEnvironments
        .filter((environment) => environment._tag === 'EffectEnvironment')
        .flatMap((environment) => markerFields(environment.fields)),
      [{ access: 'Shared', representation: 'Borrow' }],
    )
  }),
)

const replaceDrop = (
  module: Mir.Module,
  target: Extract<Mir.Operation, { readonly _tag: 'Drop' }>,
  replacement: Extract<Mir.Operation, { readonly _tag: 'Drop' }>,
): Mir.Module =>
  Object.freeze({
    ...module,
    functions: Object.freeze(
      module.functions.map((fn) =>
        Object.freeze({
          ...fn,
          regions: Object.freeze(
            fn.regions.map((region) => {
              if (region._tag === 'OperationRegion') {
                return Object.freeze({
                  ...region,
                  operations: Object.freeze(
                    region.operations.map((operation) =>
                      operation === target ? replacement : operation,
                    ),
                  ),
                })
              }
              if (region._tag === 'CleanupRegion') {
                return Object.freeze({
                  ...region,
                  releases: Object.freeze(
                    region.releases.map((operation) =>
                      operation === target ? replacement : operation,
                    ),
                  ),
                })
              }
              return region
            }),
          ),
        }),
      ),
    ),
  })

const replaceOperation = (
  module: Mir.Module,
  target: Mir.Operation,
  replacement: Mir.Operation,
): Mir.Module =>
  Object.freeze({
    ...module,
    functions: Object.freeze(
      module.functions.map((fn) =>
        Object.freeze({
          ...fn,
          regions: Object.freeze(
            fn.regions.map((region) => {
              if (region._tag !== 'OperationRegion') return region
              return Object.freeze({
                ...region,
                operations: Object.freeze(
                  region.operations.map((operation) =>
                    operation === target ? replacement : operation,
                  ),
                ),
              })
            }),
          ),
        }),
      ),
    ),
  })

it.effect('carries lazy construction and exact stored Effect execution through MIR', () =>
  Effect.gen(function* () {
    const name = 'stored-effect-mir/lifecycle'
    const { snapshot, module } = yield* lowerStored(
      name,
      `struct Deferred<F: Effect<'static; i32>> { operation: F }
pub fn main() -> i32 {
  let other = effect { return 0 }
  let ignored = run other
  let deferred = Deferred { operation: effect { return 42 } }
  return run deferred.operation
}`,
    )
    const operations = module.functions.flatMap(MirVerification.operations)
    const make = operations.find((operation) => operation._tag === 'MakeEffect')
    const construct = operations.find((operation) => operation._tag === 'Construct')
    const run = module.functions
      .flatMap((fn) =>
        MirVerification.operations(fn).map((operation) => Object.freeze({ fn, operation })),
      )
      .find(({ fn, operation }) => {
        if (operation._tag !== 'RunEffectValue') return false
        const type = fn.localTypes.at(operation.effect.ordinal)
        return type?._tag === 'EffectValue' && type.storage !== undefined
      })?.operation
    const stored = construct?._tag === 'Construct' ? construct.fields.at(0)?.stored : undefined
    const projected = module.functions
      .flatMap((fn) => fn.localTypes)
      .find((type) => type._tag === 'EffectValue' && type.storage !== undefined)

    assert.notInclude(
      Analysis.diagnostics(snapshot).map((diagnostic) => diagnostic.code),
      'SEM0107',
    )
    assert.strictEqual(snapshot.layoutCatalog._tag, 'Available')
    assert.strictEqual(snapshot.layout._tag, 'Available')
    assert.strictEqual(snapshot.mir._tag, 'Available')
    assert.strictEqual(make?._tag, 'MakeEffect')
    assert.strictEqual(stored?._tag, 'StoredEffectField')
    assert.strictEqual(projected?._tag, 'EffectValue')
    assert.strictEqual(
      projected?._tag === 'EffectValue' ? projected.storage?._tag : undefined,
      'StoredEffectField',
    )
    if (projected?._tag === 'EffectValue') {
      // A stored Effect keeps exact runtime identity, so its unstored view of the same realization
      // does not satisfy it as a returned value in either direction.
      const unstored: Mir.Type = {
        _tag: 'EffectValue',
        type: projected.type,
        site: projected.site,
        environment: projected.environment,
      }
      assert.isTrue(Mir.realizesReturn(projected, projected))
      assert.isFalse(Mir.realizesReturn(projected, unstored))
      assert.isFalse(Mir.realizesReturn(unstored, projected))
    }
    assert.strictEqual(run?._tag, 'RunEffectValue')
    if (run?._tag !== 'RunEffectValue' || stored?._tag !== 'StoredEffectField') return
    const owner =
      module.functions.find((fn) => MirVerification.operations(fn).includes(run)) ??
      unreachable('expected the stored Effect runner owner')
    const blocks = MirLinearization.linearize(owner)
    assert.isTrue(NativeOutcomeStorage.transientLocals(owner, blocks).has(run.outcome.ordinal))
    const diagnosticOnly = blocks.map((block) => ({
      ...block,
      recoveryOutcomes: [run.outcome],
      operations: [
        ...block.operations,
        {
          _tag: 'ReleaseDiagnosticOutcome' as const,
          outcome: run.outcome,
          provenance: run.provenance,
        },
      ],
    }))
    assert.isTrue(
      NativeOutcomeStorage.transientLocals(owner, diagnosticOnly).has(run.outcome.ordinal),
    )
    const repeatedDefinition = blocks.map((block) => ({
      ...block,
      operations: block.operations.flatMap((operation) =>
        operation === run ? [operation, operation] : [operation],
      ),
    }))
    assert.isFalse(
      NativeOutcomeStorage.transientLocals(owner, repeatedDefinition).has(run.outcome.ordinal),
    )
    const returnedOutcome = blocks.map((block) => ({
      ...block,
      terminator:
        block.terminator._tag === 'Return'
          ? { ...block.terminator, value: run.outcome }
          : block.terminator,
    }))
    assert.isFalse(
      NativeOutcomeStorage.transientLocals(owner, returnedOutcome).has(run.outcome.ordinal),
    )
    const borrowedOutcome = blocks.map((block) => ({
      ...block,
      operations: block.operations.map((operation) =>
        operation === run
          ? { ...operation, arguments: [...operation.arguments, run.outcome] }
          : operation,
      ),
    }))
    assert.isFalse(
      NativeOutcomeStorage.transientLocals(owner, borrowedOutcome).has(run.outcome.ordinal),
    )
    assert.deepEqual(run.runner, stored.realization.runner)
    assert.deepEqual(run.runnerTypeArguments, stored.realization.runnerArguments)
    assert.deepEqual(Type.failureMembers(run.outcomeType.type), stored.realization.rows.failures)
    assert.deepEqual(
      Type.requirementMembers(run.outcomeType.type),
      stored.realization.rows.requirements,
    )
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const alternate = operations.find(
      (operation) => operation._tag === 'RunEffectValue' && operation !== run,
    )
    assert.strictEqual(alternate?._tag, 'RunEffectValue')
    if (alternate?._tag !== 'RunEffectValue') return
    const forged = Object.freeze({
      ...run,
      runner: alternate.runner,
      runnerTypeArguments: alternate.runnerTypeArguments,
      arguments: Object.freeze([run.effect]),
    })
    assert.include(
      (yield* MirVerification.verify(replaceOperation(module, run, forged))).map(
        (violation) => violation.rule,
      ),
      'InvalidEffectOperation',
    )
  }),
)

it.effect('binds provider-specialized runs to their exact generated runner and witness', () =>
  Effect.gen(function* () {
    const { module } = yield* lowerStored(
      'stored-effect-mir/provided-runner',
      `import silk.effect { Effect }
service Counter<A> { effect fn get() -> A ? &Counter<A> }
service Meter { effect fn read() -> i32 ? &Meter }
struct Fixed<T> { value: T }
effect fn get<T>(self: &Fixed<T>) -> i32 { return 42 }
effect fn read(self: &Fixed<i32>) -> i32 { return self.value }
impl<T> Counter<i32> for Fixed<T> { get: Fixed.get }
impl Meter for Fixed<i32> { read: Fixed.read }
effect fn count<A>() -> A ? &Counter<A> { return run Counter.get<A>() }
effect fn measure() -> i32 ? &Meter { return run Meter.read() }
pub fn main() -> i32 {
  let fixed = Fixed<i32> { value: 42 }
  let other = Fixed<bool> { value: true }
  let ignored = run (count<i32>() |> Effect.provide(&fixed))
  let alsoIgnored = run (measure() |> Effect.provide(&fixed))
  return run (count<i32>() |> Effect.provide(&other))
}`,
    )
    const providedRuns = module.functions.flatMap((fn) =>
      MirVerification.operations(fn).flatMap((operation) => {
        if (operation._tag !== 'RunEffectValue' || operation.providers.length !== 1) return []
        return [operation]
      }),
    )
    const counter = providedRuns.find(
      (operation) => operation.providers.at(0)?.capability.name === 'Counter',
    )
    const meter = providedRuns.find(
      (operation) => operation.providers.at(0)?.capability.name === 'Meter',
    )

    assert.strictEqual(counter?._tag, 'RunEffectValue')
    assert.strictEqual(meter?._tag, 'RunEffectValue')
    assert.deepEqual(yield* MirVerification.verify(module), [])
    if (counter?._tag !== 'RunEffectValue' || meter?._tag !== 'RunEffectValue') return
    const wrongWrapper = Object.freeze({
      ...counter,
      runner: meter.runner,
      runnerTypeArguments: meter.runnerTypeArguments,
    })
    assert.include(
      (yield* MirVerification.verify(replaceOperation(module, counter, wrongWrapper))).map(
        (violation) => violation.rule,
      ),
      'InvalidEffectOperation',
    )
    const counterProvider = counter.providers.at(0)
    const meterProvider = meter.providers.at(0)
    if (counterProvider === undefined || meterProvider === undefined) return
    const wrongWitness = Object.freeze({
      ...counter,
      providers: Object.freeze([
        Object.freeze({ ...counterProvider, witness: meterProvider.witness }),
      ]),
    })
    assert.include(
      (yield* MirVerification.verify(replaceOperation(module, counter, wrongWitness))).map(
        (violation) => violation.rule,
      ),
      'InvalidEffectOperation',
    )
  }),
)

it.effect('retains admitted service targets through argument lifetime coercions', () =>
  Effect.gen(function* () {
    const { snapshot, module } = yield* lowerStored(
      'stored-effect-mir/service-argument-lifetime',
      `import silk.effect { Effect }
struct Request<'a> { value: &'a i32 }
service Read<'a> { effect fn get(request: Request<'a>) -> i32 ? &Read<'a> }
struct Holder<'a> { value: &'a i32 }
impl<'a> Read<'a> for Holder<'a> {
  effect fn get(self: &Self, request: Request<'a>) -> i32 { return request.value.* }
}
fn request<'a>(value: &'a i32) -> Request<'a> { return Request<'a> { value: value } }
effect fn read<'a>(value: &'a i32) -> i32 ? &Read<'a> {
  let request = request(value)
  return run Read.get<'a>(move request)
}
pub fn main() -> i32 {
  let value = 42
  let provider = Holder { value: &value }
  return run read(&value) |> Effect.provide(&provider)
}`,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(module), [])
    assert.isTrue(module.functions.some((fn) => fn.id.name.startsWith('impl@0.get$effect$')))
    const discovery = Analysis.instancesOf(snapshot)
    const caller =
      discovery.instances.find((candidate) => candidate.key.declaration.name === 'read') ??
      unreachable('expected original service caller')
    const subject = caller.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .find(
        (node): node is Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }> =>
          node._tag === 'ServiceEffectConstruct',
      )
    if (subject === undefined) return unreachable('expected held original service operation')
    const call = discovery.calls.find(
      (candidate) =>
        Instances.keyText(candidate.owner) === Instances.keyText(caller.key) &&
        candidate.node?.ordinal === subject.id?.ordinal,
    )
    if (call === undefined) return unreachable('expected source-owned service call')
    const implementation = discovery.instances.find(
      (candidate) => Instances.keyText(candidate.key) === Instances.keyText(call.target),
    )
    if (implementation === undefined) return unreachable('expected physical service implementation')
    const environment = module.layout.effectEnvironments.find(
      (candidate) =>
        candidate._tag === 'EffectEnvironment' &&
        Instances.keyText(candidate.instance) === Instances.keyText(call.target) &&
        Instances.effectIdentity(candidate.instance, candidate.site) === call.resultEffect,
    )
    if (environment?._tag !== 'EffectEnvironment')
      return unreachable('expected physical service environment')
    const receiver = implementation.specialization.parameters.at(0)
    if (receiver === undefined || !Type.isReference(receiver) || !Type.isNominal(receiver.target))
      return unreachable('expected selected provider receiver')
    const capability = Type.substitute(subject.service, caller.substitution)
    if (!Type.isNominal(capability)) return unreachable('expected original Read capability')
    const index = Analysis.declarationIndex(snapshot)
    const witness = ConformanceProof.witness(index, receiver.target, capability)
    if (witness?._tag !== 'SourceConformanceWitness')
      return unreachable('expected original checked service witness')
    const binding = {
      capability,
      providerType: receiver.target,
      witness,
      role: subject.role,
      access: subject.access,
      requirementAccess: subject.access,
    }
    const held = {
      owner: caller,
      index,
      calls: discovery.calls,
      instances: discovery.instances,
      layout: module.layout,
      semantic: (type: Type.Type) => Type.substitute(type, caller.substitution),
    }
    const view =
      SourceCallView.service(held, subject, call, binding, environment.effect) ??
      unreachable('expected checked public service input admission')
    assert.deepEqual(view.operationMapping.contract?.source.declaration.id, view.sourceOperation.id)
    assert.strictEqual(view.conformance.validity._tag, 'ValidConformance')
    assert.strictEqual(view.sourceParameters.length, subject.arguments.length)
    // The public input and physical implementation preserve their distinct original lifetimes.
    assert.isFalse(
      Type.equals(
        view.sourceParameters.at(0) ?? unreachable('expected original public input'),
        view.implementationParameters.at(1) ?? unreachable('expected physical input'),
      ),
    )
    const sourceParameter = view.sourceParameters.at(0)
    if (sourceParameter === undefined || !Type.isNominal(sourceParameter))
      return unreachable('expected original Request input')
    assert.isTrue(
      Type.equalsGenericArgument(
        sourceParameter.arguments.at(0) ?? unreachable('expected public input region'),
        capability.arguments.at(0) ?? unreachable('expected public capability region'),
      ),
    )
    const copiedOwner = { ...caller, function: { ...caller.function } }
    assert.isUndefined(
      SourceCallView.service(
        { ...held, owner: copiedOwner },
        subject,
        call,
        binding,
        environment.effect,
      ),
    )
    const copiedSubject = { ...subject }
    assert.isUndefined(
      SourceCallView.service(held, copiedSubject, call, binding, environment.effect),
    )
    const foreignTarget = {
      ...call,
      target: { ...call.target, declaration: { ...call.target.declaration, name: 'foreign' } },
    }
    assert.isUndefined(
      SourceCallView.service(
        {
          ...held,
          calls: held.calls.map((candidate) => (candidate === call ? foreignTarget : candidate)),
        },
        subject,
        foreignTarget,
        binding,
        environment.effect,
      ),
    )
    const originalMappingContract =
      view.operationMapping.contract ?? unreachable('expected original typed operation mapping')
    const copiedMapping = {
      ...view.operationMapping,
      contract: {
        ...originalMappingContract,
        source: {
          ...originalMappingContract.source,
          declaration: {
            ...view.sourceOperation,
            id: { ...view.sourceOperation.id, ordinal: view.sourceOperation.id.ordinal + 1 },
          },
        },
      },
    }
    const foreignMapping = {
      ...held.index,
      modules: held.index.modules.map((entry) => ({
        ...entry,
        conformances: entry.conformances.map((candidate) =>
          candidate === view.conformance
            ? {
                ...candidate,
                operations: candidate.operations.map((mapping) =>
                  mapping === view.operationMapping ? copiedMapping : mapping,
                ),
              }
            : candidate,
        ),
      })),
    }
    assert.isUndefined(
      SourceCallView.service(
        { ...held, index: foreignMapping },
        subject,
        call,
        binding,
        environment.effect,
      ),
    )
    const changedHeader = {
      ...view.sourceOperation,
      parameters: view.sourceOperation.parameters.map((parameter) => ({
        ...parameter,
        declaredType:
          parameter.declaredType._tag === 'Resolved'
            ? { ...parameter.declaredType, type: Type.unit }
            : parameter.declaredType,
      })),
    }
    const changedSourceHeader = {
      ...held.index,
      modules: held.index.modules.map((entry) => ({
        ...entry,
        services: entry.services.map((service) =>
          service === view.sourceService
            ? {
                ...service,
                operations: service.operations.map((operation) =>
                  operation === view.sourceOperation ? changedHeader : operation,
                ),
              }
            : service,
        ),
      })),
    }
    assert.isUndefined(
      SourceCallView.service(
        { ...held, index: changedSourceHeader },
        subject,
        call,
        binding,
        environment.effect,
      ),
    )

    const run =
      module.functions
        .flatMap(MirVerification.operations)
        .find(
          (operation) =>
            operation._tag === 'RunEffectValue' &&
            operation.providers.some((provider) => provider.capability.name === 'Read'),
        ) ?? unreachable('expected provided read')
    if (run._tag !== 'RunEffectValue') return
    const provider = run.providers.at(0) ?? unreachable('expected read provider')
    const withWitnessCapability = (capability: Type.Nominal): Mir.Module => {
      const witness = { ...provider.witness, capability }
      const replaced = module.functions.flatMap(MirVerification.operations).reduce(
        (current, operation) =>
          operation._tag === 'RunEffectValue' &&
          operation.runner.module === run.runner.module &&
          operation.runner.name === run.runner.name
            ? replaceOperation(current, operation, {
                ...operation,
                providers: operation.providers.map((bound) => ({ ...bound, witness })),
              })
            : current,
        module,
      )
      return {
        ...replaced,
        functions: replaced.functions.map((fn) =>
          fn.id.module === run.runner.module &&
          fn.id.name === run.runner.name &&
          fn.effectRunner !== undefined
            ? {
                ...fn,
                effectRunner: {
                  ...fn.effectRunner,
                  providers: fn.effectRunner.providers.map((bound) => ({ ...bound, witness })),
                },
              }
            : fn,
        ),
      }
    }
    const proofContext = Type.nominal(provider.capability.module, 'Read', [
      Lifetime.local({ module: provider.capability.module, name: 'main' }, 'witness', 0),
    ])
    assert.deepEqual(yield* MirVerification.verify(withWitnessCapability(proofContext)), [])
    assert.include(
      (yield* MirVerification.verify(
        withWitnessCapability(Type.nominal(provider.capability.module, 'Read', ['i32'])),
      )).map((violation) => violation.rule),
      'InvalidEffectOperation',
    )
  }),
)

it.effect('retains provided runner contracts through typed-failure recovery', () =>
  Effect.gen(function* () {
    const { snapshot, module } = yield* lowerStored(
      'stored-effect-mir/recovered-provided-write',
      recoveredProvidedWrite,
      new Map([['recovered_writer', ascii(recoveredWriterModule)]]),
      Target.aarch64AppleDarwin.id,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const providedRun = module.functions.flatMap(MirVerification.operations).find(
      (
        operation,
      ): operation is Extract<
        Mir.Operation,
        {
          readonly _tag: 'RunEffectValue'
        }
      > =>
        operation._tag === 'RunEffectValue' &&
        operation.runnerBase !== undefined &&
        operation.runnerBase.declaration.name.includes('impl@0.writeAll'),
    )
    assert.isDefined(providedRun)
    if (providedRun === undefined || providedRun.runnerBase === undefined) return
    assert.strictEqual(providedRun.providers.length, 1)
    assert.strictEqual(providedRun.providers.at(0)?.capability.name, 'RecoveredWriter')
    assert.strictEqual(providedRun.providers.at(0)?.providerType.name, 'StdoutWriter')
    assert.strictEqual(providedRun.providers.at(0)?.role, 'DefaultRole')
    assert.strictEqual(providedRun.providers.at(0)?.requirementAccess, 'Exclusive')
    assert.strictEqual(providedRun.providers.at(0)?.access, 'Exclusive')

    const retainedRunner = module.functions.find(
      (fn) => fn.id.module === providedRun.runner.module && fn.id.name === providedRun.runner.name,
    )
    assert.isDefined(retainedRunner)
    assert.deepEqual(retainedRunner?.effectRunner?.base, providedRun.runnerBase)
    assert.deepEqual(
      retainedRunner?.effectRunner?.providers,
      providedRun.providers.map(({ argument: _argument, ...provider }) => provider),
    )
  }),
)

it.effect('selects the innermost mutable provider for a nested lexical service binding', () =>
  Effect.gen(function* () {
    const name = 'stored-effect-mir/nested-mutable-provider'
    const { snapshot, module } = yield* lowerStored(
      name,
      `import silk.effect { Effect }
service Input { effect fn count() -> i32 ? &mut Input }
struct Memory { value: i32 }
effect fn memoryCount(self: &mut Memory) -> i32 { return self.value }
impl Input for Memory { count: Memory.memoryCount }
effect fn read() -> i32 ? &mut Input { return run Input.count() }
effect fn nested(inner: &mut Memory) -> i32 ? &mut Input {
  let outerBefore = run read()
  let nested = run read() |> Effect.provideMut<Input>(move inner)
  let outerAfter = run read()
  return outerBefore * 100 + nested * 10 + outerAfter
}
pub fn main() -> i32 {
  let mut outer = Memory { value: 3 }
  let mut inner = Memory { value: 7 }
  return run nested(&mut inner) |> Effect.provideMut<Input>(&mut outer)
}`,
    )
    assert.deepEqual(Analysis.diagnostics(snapshot), [])
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const nestedRunners = module.functions.filter((fn) => fn.id.name.startsWith('nested$effect$'))
    const selected = nestedRunners.flatMap((fn) =>
      MirVerification.operations(fn).flatMap((operation) =>
        operation._tag === 'RunEffectValue' && operation.runner.name.startsWith('read$effect$')
          ? [{ fn, operation }]
          : [],
      ),
    )
    assert.strictEqual(selected.length, 3)
    const first = selected.at(0) ?? unreachable('expected first outer provider run')
    assert.strictEqual(first.fn.parameterCount, 2)
    assert.deepEqual(
      selected.map(({ operation }) => operation.arguments.map((argument) => argument.ordinal)),
      [[1], [0], [1]],
    )
    assert.deepEqual(
      selected.map(({ operation }) =>
        operation.providers.map((provider) => provider.argument?.ordinal),
      ),
      [[1], [0], [1]],
    )
  }),
)

it.effect(
  'materializes nested intrinsic Effect captures with their executable representation',
  () =>
    Effect.gen(function* () {
      const { snapshot, module } = yield* lowerStored(
        'stored-effect-mir/nested-intrinsic-effect',
        `import silk.effect { Effect }
effect<'env> fn pass<'env, A, E, ?R>(self: once Effect<'env; A ! E ? R>) -> A ! E ? R {
  return run move self
}
pub fn main() -> i32 {
  return run Intrinsic.suspendEffect(effect { return 42 }) |> pass
}`,
      )
      assert.deepEqual(Analysis.diagnostics(snapshot), [])
      const layout =
        snapshot.layout._tag === 'Available'
          ? snapshot.layout.value
          : unreachable('expected layout')
      const provisional = ProvisionalMir.build(snapshot.instances, layout, snapshot.index)
      const intrinsic =
        provisional.executions.find(
          (execution) => execution.key._tag === 'BuiltinEffectRunnerExecution',
        ) ?? unreachable('expected intrinsic runner execution')
      assert.strictEqual(intrinsic.classification, 'Suspendable')
      assert.isTrue(intrinsic.regions.some((region) => region.outcome._tag === 'SuspendEffect'))
      assert.deepEqual(yield* MirVerification.verify(module), [])
    }),
)

it.effect('resolves unrun stored Effect cleanup before MIR', () =>
  Effect.gen(function* () {
    const { module } = yield* lowerStored(
      'stored-effect-mir/unrun-cleanup',
      `struct Token { value: i32 }
struct Deferred<F: once Effect<'static; i32>> { operation: F }
fn consume(token: Token) -> i32 { return token.value }
pub fn main() -> i32 {
  let token = Token { value: 1 }
  let deferred = Deferred { operation: effect { return consume(move token) } }
  return 0
}`,
    )
    const cleanups = module.functions
      .flatMap(MirVerification.operations)
      .flatMap((operation) => (operation._tag === 'Drop' ? [operation.cleanup] : []))

    assert.notInclude(
      cleanups.map((cleanup) => cleanup._tag),
      'RepresentedEffectCleanup',
    )
    assert.include(
      cleanups.flatMap((cleanup) =>
        cleanup._tag === 'StructCleanup'
          ? cleanup.fields.map((field) => field.cleanup._tag)
          : [cleanup._tag],
      ),
      'EffectCleanup',
    )
    assert.deepEqual(yield* MirVerification.verify(module), [])
    const drop = module.functions.flatMap(MirVerification.operations).find(
      (
        operation,
      ): operation is Extract<
        Mir.Operation,
        {
          readonly _tag: 'Drop'
        }
      > =>
        operation._tag === 'Drop' &&
        operation.cleanup._tag === 'StructCleanup' &&
        operation.cleanup.fields.some((field) => field.cleanup._tag === 'EffectCleanup'),
    )
    assert.isDefined(drop)
    if (drop === undefined || drop.cleanup._tag !== 'StructCleanup') return
    const structCleanup = drop.cleanup
    const field = structCleanup.fields.find(
      (candidate) => candidate.cleanup._tag === 'EffectCleanup',
    )
    assert.strictEqual(field?.cleanup._tag, 'EffectCleanup')
    if (field?.cleanup._tag !== 'EffectCleanup') return
    const slot = field.cleanup.slots.at(0) ?? unreachable('expected owned stored Effect slot')
    const withEffectCleanup = (
      cleanup: Extract<
        CleanupPlan.CleanupPlan,
        {
          readonly _tag: 'EffectCleanup'
        }
      >,
    ): Extract<
      Mir.Operation,
      {
        readonly _tag: 'Drop'
      }
    > =>
      Object.freeze({
        ...drop,
        cleanup: Object.freeze({
          ...structCleanup,
          fields: Object.freeze(
            structCleanup.fields.map((candidate) =>
              candidate === field ? Object.freeze({ ...candidate, cleanup }) : candidate,
            ),
          ),
        }),
      })
    const malformed = [
      Object.freeze({ ...field.cleanup, slots: Object.freeze([]) }),
      Object.freeze({
        ...field.cleanup,
        slots: Object.freeze([Object.freeze({ ...slot, laneOffset: slot.laneOffset + 1 })]),
      }),
      Object.freeze({
        ...field.cleanup,
        slots: Object.freeze([Object.freeze({ ...slot, laneCount: slot.laneCount + 1 })]),
      }),
      Object.freeze({
        ...field.cleanup,
        slots: Object.freeze([
          Object.freeze({
            ...slot,
            cleanup: Object.freeze({ _tag: 'NoCleanup' as const, type: slot.cleanup.type }),
          }),
        ]),
      }),
    ]
    for (const cleanup of malformed) {
      assert.include(
        (yield* MirVerification.verify(replaceDrop(module, drop, withEffectCleanup(cleanup)))).map(
          (violation) => violation.rule,
        ),
        'InvalidAggregateOperation',
      )
    }
  }),
)

it.effect('retains stored runners across suspension and resume planning', () =>
  Effect.gen(function* () {
    const lowered = yield* lowerStored(
      'stored-effect-mir/suspending',
      `import silk.effect { Effect }
struct Deferred<F: Effect<'static; i32>> { operation: F }
effect fn delayed() -> i32 {
  return run Effect.suspend(effect { return 42 })
}
pub fn main() -> i32 {
  let deferred = Deferred { operation: effect { return run delayed() } }
  return run deferred.operation
}`,
    )
    const module = finalizeSuspension(lowered.snapshot, lowered.module, lowered.layout)
    const run = module.functions
      .flatMap(MirVerification.operations)
      .find((operation) => operation._tag === 'RunEffectValue')
    const suspension = module.functions.flatMap((fn) => fn.suspension?.regions ?? [])
    for (const fn of module.functions) {
      const transient = NativeOutcomeStorage.transientLocals(fn, MirLinearization.linearize(fn))
      for (const region of fn.suspension?.regions ?? []) {
        if (region.operation._tag !== 'ExecutionPark')
          assert.isFalse(transient.has(region.operation.outcome.ordinal))
        if (region._tag === 'RunSuspendableEffectRegion') {
          for (const local of region.liveLocals) assert.isFalse(transient.has(local.ordinal))
          for (const slot of region.relay.state?.slots ?? [])
            assert.isFalse(transient.has(slot.local.ordinal))
        }
      }
    }

    assert.strictEqual(run?._tag, 'RunEffectValue')
    assert.include(
      suspension.map((region) => region._tag),
      'SuspendEffectRegion',
    )
    assert.include(
      suspension.map((region) => region._tag),
      'RunSuspendableEffectRegion',
    )
    const storedRunner =
      module.functions.find(
        (fn) => fn.id.module === 'stored-effect-mir/suspending' && fn.id.name === 'main$effect$0',
      ) ?? unreachable('expected stored Effect runner')
    const storedRelay =
      storedRunner.suspension?.regions.find(
        (region) => region._tag === 'RunSuspendableEffectRegion',
      ) ?? unreachable('expected stored Effect suspension relay')
    const relayTarget =
      storedRelay.runner.declaration ?? unreachable('expected stored Effect relay target')
    assert.isTrue(
      module.functions.some((fn) =>
        Mir.matchesInstance(fn, relayTarget, storedRelay.runner.typeArguments),
      ),
      'the stored Effect relay must target a realized runner in the origin-reachable chain',
    )
    assert.isTrue(
      module.functions.some((fn) =>
        fn.suspension?.regions.some((region) => region._tag === 'SuspendEffectRegion'),
      ),
      'the reachable chain must terminate in an explicit suspension origin',
    )
    assert.deepEqual(yield* MirVerification.verify(module), [])
    assert.include(MirEncoding.encode(module), 'stored-effect-mir/suspending.main$effect$0')
  }),
)

it.effect('keeps typed-failure releases on stored Effect propagation paths', () =>
  Effect.gen(function* () {
    const { module } = yield* lowerStored(
      'stored-effect-mir/failure-cleanup',
      `import silk.allocator { Allocator }
import silk.allocator { OutOfMemoryError }
import silk.allocator { Allocator }
import silk.allocator { SystemAllocator }
import silk.effect { Effect }
import silk.layout { Layout }
struct Token { value: i32 }
struct Deferred<F: once Effect<'static; i32>> { operation: F }
fn consume(token: Token) -> i32 { return token.value }
effect fn build() -> i32 ! OutOfMemoryError {
  let token = Token { value: 1 }
  let deferred = Deferred { operation: effect { return consume(move token) } }
  let mut allocator = Allocator.systemAllocatorProvider()
  let allocation = run Allocator.allocate(Layout.of<[i32; 2]>()) |> Effect.provideMut(&mut allocator)
  return 42
}
effect fn recover(error: OutOfMemoryError) -> i32 { return 0 }
pub fn main() -> i32 { return run Effect.catchAll(build(), recover) }`,
    )
    const propagating = module.functions
      .flatMap(MirVerification.operations)
      .flatMap((operation) =>
        (operation._tag === 'RunEffect' || operation._tag === 'RunEffectValue') &&
        operation.releases !== undefined
          ? [operation]
          : [],
      )
    const cleanupTags = propagating.flatMap((operation) =>
      (operation.releases ?? []).flatMap((release) =>
        release.cleanup._tag === 'StructCleanup'
          ? release.cleanup.fields.map((field) => field.cleanup._tag)
          : [release.cleanup._tag],
      ),
    )

    assert.include(cleanupTags, 'EffectCleanup')
    assert.deepEqual(yield* MirVerification.verify(module), [])
    assert.isFalse(
      module.layout.entries.some(
        (entry) => Type.isEffect(entry.type) && entry.representation._tag !== 'Aggregate',
      ),
    )
  }),
)
