import * as Effect from 'effect/Effect'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as RuntimeComponent from './RuntimeComponent.js'
import * as Mir from './Mir.js'
import * as MirVerification from './MirVerification.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as StaticValue from './StaticValue.js'
import type * as CleanupPlan from './CleanupPlan.js'
import * as Instances from './Instances.js'
import * as LocalSharedPayloadCleanup from './LocalSharedPayloadCleanup.js'
import * as Type from './Type.js'

/** The target-neutral private frame capability; provider identities remain ordinary source. */
export const capability = 'execution-storage'
export const operations = ['create', 'acquire', 'release', 'destroy'] as const
export type Operation = (typeof operations)[number]

/** Validated source C exports used by one artifact's private storage machinery. */
export interface ExecutionStorageComponent {
  readonly create: Instances.ForeignExport
  readonly acquire: Instances.ForeignExport
  readonly release: Instances.ForeignExport
  readonly destroy: Instances.ForeignExport
}

/** Tests concrete private frame demand after specialization and suspension normalization. */
export const demanded = (program: Mir.Module): boolean =>
  program.functions.some((fn) => (fn.suspension?.regions.length ?? 0) > 0) ||
  program.layout.executionPackages.plans.some((plan) => plan.initialContinuationSegment)

/** Selects a complete catalog entry only after an actual private frame demand. */
export const select = Effect.fn('ExecutionStorageComponent.select')(function* (
  components: ReadonlyArray<RuntimeComponent.RuntimeComponent>,
): Effect.fn.Return<RuntimeComponent.RuntimeComponent, ConfigurationError.ConfigurationError> {
  const candidates = components.filter((component) => component.capability === capability)
  const selected = candidates[0]
  if (selected === undefined || candidates.length !== 1)
    return yield* ConfigurationError.make(
      'ExecutionStorageComponent.select',
      selected === undefined ? 'MissingParameter' : 'ConflictingBindings',
      capability,
      candidates.length === 0
        ? [ConfigurationOrigin.literal('artifact components')]
        : candidates.map((component) => component.origin),
    )
  if (
    selected.bindings.length !== operations.length ||
    operations.some(
      (operation) => !selected.bindings.some((binding) => binding.operation === operation),
    )
  )
    return yield* ConfigurationError.make(
      'ExecutionStorageComponent.select',
      'InvalidInput',
      'execution-storage operations',
      [selected.origin],
      [...operations],
    )
  return selected
})

const pointer = (type: Type.Type): boolean =>
  Type.isPointer(type) &&
  type.mutable &&
  type.nullable &&
  type.extent === 'Single' &&
  type.addressSpace === 0 &&
  type.pointee === 'u8'

const matches = (operation: Operation, type: Type.ForeignFunction): boolean => {
  if (
    type.contract.callbacks.length > 0 ||
    type.contract.borrow.length > 0 ||
    type.contract.noReturn
  )
    return false
  const parameters = type.parameters
  const result =
    operation === 'create' || operation === 'acquire'
      ? pointer(type.result)
      : Type.equals(type.result, Type.unit)
  if (!result) return false
  switch (operation) {
    case 'create':
      return parameters.length === 0
    case 'acquire':
      return (
        parameters.length === 3 &&
        parameters.every((value, index) => (index === 0 ? pointer(value) : value === 'usize'))
      )
    case 'release':
      return parameters.length === 2 && parameters.every(pointer)
    case 'destroy':
      return parameters.length === 1 && parameters.every(pointer)
  }
}

/** Follows executed source calls, including private Effect runners, without executing lazy values. */
const bootstrapDemand = (
  program: Mir.Module,
  root: Mir.MirFunction,
): Mir.MirFunction | undefined => {
  const pending = [root]
  const seen = new Set<Mir.MirFunction>()
  const enqueue = (
    declaration: DeclarationFacts.CanonicalId,
    arguments_: ReadonlyArray<Type.GenericArgument>,
    staticArguments?: ReadonlyArray<StaticValue.Value>,
  ): void => {
    for (const candidate of program.functions) {
      if (Mir.matchesInstance(candidate, declaration, arguments_, staticArguments))
        pending.push(candidate)
    }
  }
  const enqueueEffect = (
    declaration: DeclarationFacts.CanonicalId,
    arguments_: ReadonlyArray<Type.GenericArgument>,
    staticArguments: ReadonlyArray<StaticValue.Value> | undefined,
    effect: Type.Effect,
  ): void => {
    for (const candidate of program.functions) {
      if (Mir.matchesEffectInstance(candidate, declaration, arguments_, staticArguments, effect))
        pending.push(candidate)
    }
  }
  const enqueueSymbol = (symbol: string): void => {
    for (const exported of program.foreignExports) {
      if (exported.symbol !== symbol) continue
      const implementation = program.functions.find(
        (candidate) => Instances.keyText(candidate.instance) === Instances.keyText(exported.key),
      )
      if (implementation !== undefined) pending.push(implementation)
    }
  }
  const seenCleanup = new Set<CleanupPlan.CleanupPlan>()
  const cleanup = (plan: CleanupPlan.CleanupPlan): void => {
    if (seenCleanup.has(plan)) return
    seenCleanup.add(plan)
    switch (plan._tag) {
      case 'AllocationCleanup':
        enqueueSymbol('free')
        break
      case 'RawBufferCleanup':
        cleanup(plan.allocation)
        break
      case 'LocalSharedCoreCleanup':
        enqueue(LocalSharedPayloadCleanup.declaration, [plan.element])
        cleanup(plan.allocation)
        break
      case 'ExecutionRefCleanup':
        cleanup(plan.allocation)
        break
      case 'ExecutionCleanup': {
        const result = Type.typeArgumentAt(plan.type, 0)
        for (const package_ of program.layout.executionPackages.plans) {
          if (result !== undefined && !Type.equals(package_.specialization.result, result)) continue
          if (package_.cleanup === undefined) continue
          cleanup(package_.cleanup.body)
          cleanup(package_.cleanup.endpoint)
          cleanup(package_.cleanup.callback)
        }
        cleanup(plan.allocation)
        break
      }
      case 'HookCleanup':
        enqueue(plan.hook, plan.typeArguments)
        cleanup(plan.inner)
        break
      case 'StructCleanup':
        for (const field of plan.fields) cleanup(field.cleanup)
        break
      case 'NominalUnionCleanup':
        for (const variant of plan.variants)
          for (const field of variant.fields) cleanup(field.cleanup)
        break
      case 'ArrayCleanup':
        cleanup(plan.element)
        break
      case 'UnionCleanup':
        for (const entry of plan.cases) cleanup(entry.cleanup)
        break
      case 'CallableCleanup':
      case 'EffectCleanup':
        for (const slot of plan.slots) cleanup(slot.cleanup)
        break
      case 'EffectCompositeCleanup':
        for (const alternative of plan.alternatives) cleanup(alternative)
        break
      default:
        break
    }
  }
  for (let ordinal = 0; ordinal < pending.length; ordinal += 1) {
    const fn = pending[ordinal]
    if (fn === undefined || seen.has(fn)) continue
    seen.add(fn)
    const callable = (
      local: Mir.LocalId,
      arguments_?: ReadonlyArray<Type.GenericArgument>,
    ): void => {
      const type = fn.localTypes.at(local.ordinal)
      if (type?._tag === 'CallableValue' && type.target._tag === 'DeclarationCallableTarget') {
        enqueue(
          type.target.declaration,
          arguments_ ??
            type.environment?.callable.typeArguments ??
            type.storage?.realization.targetArguments ??
            type.typeArguments ??
            [],
        )
      }
    }
    if ((fn.suspension?.regions.length ?? 0) > 0) return fn
    for (const operation of MirVerification.operations(fn)) {
      if ('cleanup' in operation) cleanup(operation.cleanup)
      if ('releases' in operation)
        for (const release of operation.releases ?? []) cleanup(release.cleanup)
      if ('presentCleanup' in operation) {
        cleanup(operation.presentCleanup)
        cleanup(operation.absentCleanup)
      }
      if ('bodyCleanup' in operation) {
        cleanup(operation.bodyCleanup)
        cleanup(operation.endpointCleanup)
        cleanup(operation.callbackCleanup)
      }
      if ('completionCleanup' in operation) {
        cleanup(operation.completionCleanup)
        cleanup(operation.suspensionCleanup)
      }
      if ('useCleanup' in operation) {
        cleanup(operation.useCleanup)
        cleanup(operation.conflictCleanup)
      }
      switch (operation._tag) {
        case 'Allocate':
          enqueueSymbol('malloc')
          enqueueSymbol('free')
          break
        case 'StringEqualsExact':
          enqueueSymbol('memcmp')
          break
        case 'DiagnosticScope':
          cleanup(operation.stateCleanup)
          cleanup(operation.observerCleanup)
          callable(operation.observer)
          break
        case 'Call':
          enqueue(operation.target, operation.typeArguments, operation.staticArguments)
          break
        case 'RunEffect':
          enqueueEffect(
            operation.target,
            operation.typeArguments,
            operation.staticArguments,
            operation.outcomeType.type,
          )
          break
        case 'RunEffectValue':
        case 'RunStaticEffect':
          enqueueEffect(
            operation.runner,
            operation.runnerTypeArguments,
            operation.runnerStaticArguments,
            operation.outcomeType.type,
          )
          break
        case 'CatchEffect':
          enqueueEffect(
            operation.runner,
            operation.runnerTypeArguments,
            operation.runnerStaticArguments,
            operation.outcomeType.type,
          )
          break
        case 'RunEffectComposite':
          for (const alternative of operation.alternatives)
            enqueueEffect(
              alternative.runner,
              alternative.runnerTypeArguments,
              alternative.runnerStaticArguments,
              alternative.type.type,
            )
          break
        case 'ApplyCallable': {
          const type =
            operation.callable === undefined
              ? undefined
              : fn.localTypes.at(operation.callable.ordinal)
          const target =
            operation.target ?? (type?._tag === 'CallableValue' ? type.target : undefined)
          if (target?._tag === 'DeclarationCallableTarget')
            enqueue(target.declaration, operation.typeArguments)
          break
        }
        case 'ForeignCall':
          enqueueSymbol(operation.symbol)
          break
        case 'CheckedScalar':
          callable(operation.present)
          callable(operation.absent)
          break
        case 'SharedWithMut':
          callable(operation.use)
          callable(operation.onConflict)
          break
        case 'ExecutionDrive': {
          callable(operation.onComplete, operation.completionTypeArguments)
          callable(operation.onSuspend, operation.suspensionTypeArguments)
          // Drive dispatches over the retained packages for this result, just as native emission does.
          const execution = fn.localTypes.at(operation.execution.ordinal)
          const result =
            execution?._tag === 'Nominal' && Type.isExecution(execution.type)
              ? Type.typeArgumentAt(execution.type, 0)
              : undefined
          if (
            result !== undefined &&
            program.layout.executionPackages.plans.some(
              (plan) =>
                plan.initialContinuationSegment && Type.equals(plan.specialization.result, result),
            )
          )
            return fn
          break
        }
        default:
          break
      }
    }
  }
  return undefined
}

/** Resolves selected source declarations and checks their precise source-level C contract. */
export const resolve = Effect.fn('ExecutionStorageComponent.resolve')(function* (
  self: RuntimeComponent.RuntimeComponent,
  program: Mir.Module,
): Effect.fn.Return<ExecutionStorageComponent, ConfigurationError.ConfigurationError> {
  const operation = Effect.fnUntraced(function* (name: Operation) {
    const binding = self.bindings.find((entry) => entry.operation === name)
    const exports = program.foreignExports.filter(
      (entry) =>
        entry.declaration.module === binding?.module &&
        entry.declaration.name === binding?.declaration,
    )
    const selected = exports[0]
    if (
      selected === undefined ||
      exports.length !== 1 ||
      selected.signature.variadic ||
      !matches(name, selected.type)
    )
      return yield* ConfigurationError.make(
        'ExecutionStorageComponent.resolve',
        'InvalidInput',
        `${capability}.${name}`,
        [self.origin],
        ['expected one monomorphic C export with the storage operation signature'],
      )
    const implementation = program.functions.find(
      (fn) => Instances.keyText(fn.instance) === Instances.keyText(selected.key),
    )
    const recursive =
      implementation === undefined ? undefined : bootstrapDemand(program, implementation)
    if (recursive !== undefined)
      return yield* ConfigurationError.make(
        'ExecutionStorageComponent.resolve',
        'DependencyCycle',
        capability,
        [self.origin],
        [
          `${binding?.module}.${binding?.declaration} reaches ${recursive.id.module}.${recursive.id.name}, which demands private storage while providing it`,
        ],
      )
    return selected
  })
  return {
    create: yield* operation('create'),
    acquire: yield* operation('acquire'),
    release: yield* operation('release'),
    destroy: yield* operation('destroy'),
  }
})
