import * as ConformanceProof from './ConformanceProof.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Instances from './Instances.js'
import * as Mir from './Mir.js'
import * as ProvisionalMir from './ProvisionalMir.js'
import type * as StaticValue from './StaticValue.js'
import type * as SuspensionOwnership from './SuspensionOwnership.js'
import * as Type from './Type.js'

/** Finalizes provisional complete-or-relay control into target-neutral executable MIR facts. */

const samePoint = (left: ProvisionalMir.ControlId, right: ProvisionalMir.ControlId): boolean =>
  left.execution === right.execution &&
  left.sourceId === right.sourceId &&
  left.functionOrdinal === right.functionOrdinal &&
  left.spanStart === right.spanStart &&
  left.spanEnd === right.spanEnd &&
  left.ordinal === right.ordinal &&
  left.port === right.port

const pointOf = (
  owner: Instances.InstanceKey,
  point: ProvisionalMir.ControlId,
): Mir.SuspensionPointId => ({
  _tag: 'SuspensionPointId',
  owner,
  sourceId: point.sourceId,
  spanStart: point.spanStart,
  spanEnd: point.spanEnd,
  ordinal: point.ordinal,
})

const resumeOf = (
  point: Mir.SuspensionPointId,
  path: Mir.ResumePointId['path'],
): Mir.ResumePointId => ({ _tag: 'ResumePointId', point, path })

const runnerOf = (
  runner: ProvisionalMir.Runner,
  index: DeclarationIndex.Index,
  operation?: Extract<
    Mir.Operation,
    { readonly _tag: 'RunEffect' | 'RunEffectValue' | 'CatchEffect' | 'ExecutionPark' }
  >,
  functions: ReadonlyArray<Mir.MirFunction> = [],
): Mir.SuspensionRunner => {
  const arguments_ = operation?._tag === 'ExecutionPark' ? [] : (operation?.arguments ?? [])
  const operationProviders = operation?._tag === 'RunEffectValue' ? operation.providers : []
  // One selection identity for both the dedup and the argument lookup below — two predicates
  // here previously let a provider count as "already selected" yet miss its runtime argument.
  const sameSelection = (
    left: {
      readonly role: string
      readonly requirementAccess: string
      readonly capability: Type.Type
    },
    right: {
      readonly role: string
      readonly requirementAccess: string
      readonly capability: Type.Type
    },
  ): boolean =>
    left.role === right.role &&
    left.requirementAccess === right.requirementAccess &&
    Type.equals(left.capability, right.capability)
  const providersWithRuntimeSelections = [
    ...operationProviders,
    ...runner.providers.filter(
      (provider) => !operationProviders.some((selected) => sameSelection(provider, selected)),
    ),
  ]
  const runtimeProviders = providersWithRuntimeSelections.filter(
    (provider) => provider.witness?._tag === 'SourceConformanceWitness',
  )
  const argumentOffset = Math.max(0, arguments_.length - runtimeProviders.length)
  let runtimeOrdinal = 0
  const providers: ReadonlyArray<Mir.SuspensionProviderArgument> =
    providersWithRuntimeSelections.map((provider) => {
      const hasRuntimeArgument = provider.witness?._tag === 'SourceConformanceWitness'
      const selected =
        operation?._tag === 'RunEffectValue'
          ? operation.providers.find((candidate) => sameSelection(candidate, provider))
          : undefined
      let argument: Mir.LocalId | undefined
      if (hasRuntimeArgument) {
        if (operation?._tag === 'RunEffectValue') {
          argument = selected?.argument
        } else {
          argument = arguments_.at(argumentOffset + runtimeOrdinal)
        }
      } else {
        argument = undefined
      }
      if (hasRuntimeArgument) runtimeOrdinal += 1
      const witness =
        provider.witness ??
        ConformanceProof.witness(index, provider.providerType, provider.capability)
      return {
        ...provider,
        ...(witness === undefined ? {} : { witness }),
        ...(argument === undefined ? {} : { argument }),
        purposes: ['ChildRequirement'] as const,
      }
    })
  let declaration: typeof runner.declaration | undefined
  if (operation === undefined || operation._tag === 'ExecutionPark') {
    declaration = runner.declaration
  } else if (operation._tag === 'RunEffect') {
    declaration = operation.target
  } else {
    declaration = operation.runner
  }
  let typeArguments: ReadonlyArray<Type.GenericArgument>
  if (operation === undefined || operation._tag === 'ExecutionPark') {
    typeArguments = runner.typeArguments
  } else if (operation._tag === 'RunEffect') {
    typeArguments = operation.typeArguments
  } else {
    typeArguments = operation.runnerTypeArguments
  }
  let staticArguments: ReadonlyArray<StaticValue.Value>
  if (operation === undefined || operation._tag === 'ExecutionPark')
    staticArguments = runner.instance?.staticArguments ?? []
  else if (operation._tag === 'RunEffect') staticArguments = operation.staticArguments ?? []
  else if (operation._tag === 'RunEffectValue' || operation._tag === 'CatchEffect')
    staticArguments = operation.runnerStaticArguments ?? []
  else staticArguments = []
  const exact = functions.find((fn) => {
    if (declaration === undefined) return false
    if (operation === undefined || operation._tag === 'ExecutionPark')
      return Mir.matchesInstance(fn, declaration, typeArguments, staticArguments)
    return Mir.matchesEffectInstance(
      fn,
      declaration,
      typeArguments,
      staticArguments,
      operation.outcomeType.type,
      operation._tag === 'RunEffectValue' ? operation.providers : undefined,
    )
  })
  let instance = exact?.instance
  if (
    instance === undefined &&
    runner.instance !== undefined &&
    declaration !== undefined &&
    runner.instance.declaration.module === declaration.module &&
    runner.instance.declaration.name === declaration.name
  )
    instance = runner.instance
  return {
    classification: runner.classification,
    ...(declaration === undefined ? {} : { declaration }),
    ...(instance === undefined ? {} : { instance }),
    ...(runner.effectIdentity === undefined ? {} : { effectIdentity: runner.effectIdentity }),
    typeArguments,
    outcome:
      operation === undefined || operation._tag === 'ExecutionPark'
        ? runner.outcome
        : operation.outcomeType.type,
    captures: runner.captures,
    providers: providers,
  }
}

const completionOf = (
  completion: ProvisionalMir.CompletionPolicy,
  operation: LocatedOperation['operation'],
): Mir.SuspensionCompletion => {
  // A finite choice may narrow a reified contract to one failure member, or to an
  // infallible arm. Transport the selected call's exact outcome and projections.
  if (completion._tag === 'Reify') {
    if (operation._tag === 'CatchEffect')
      return {
        _tag: 'Reify',
        outcome: operation.outcomeType.type,
        successType: operation.outcomeType.type.success,
        failureValueType: operation.failureValueType,
        successShape: operation.successShape,
        outcomeShape: operation.outcomeShape,
        failureValueShape: operation.failureValueShape,
      }
    if (
      operation._tag !== 'ExecutionPark' &&
      Type.failureMembers(operation.outcomeType.type).length === 0
    )
      return {
        _tag: 'Propagate',
        outcome: operation.outcomeType.type,
        failureMappings: [],
      }
  }
  return { ...completion }
}

const pathPlanOf = (plan: SuspensionOwnership.ResumePlan): Mir.CoroutineFramePathPlan => ({
  restores: plan.restores,
  loanEnds: plan.loanEnds,
  releases: plan.releases,
})

const descriptorOf = (
  point: Mir.SuspensionPointId,
  runner: Mir.SuspensionRunner,
  plan: SuspensionOwnership.Plan,
): Mir.CoroutineFrameState => ({
  _tag: 'CoroutineFrameState',
  point,
  runner,
  outcome: runner.outcome,
  slots: plan.slots,
  ...(plan.invocationUses.length === 0 ? {} : { invocationUses: plan.invocationUses }),
  ...('cancellationFinalizer' in plan.operation &&
  plan.operation.cancellationFinalizer !== undefined
    ? { cancellationFinalizer: plan.operation.cancellationFinalizer }
    : {}),
  success: {
    ...pathPlanOf(plan.success),
    resume: resumeOf(point, 'Success'),
  },
  failure: {
    ...pathPlanOf(plan.failure),
    resume: resumeOf(point, 'Failure'),
  },
})

interface LocatedOperation {
  readonly region: Mir.RegionId
  readonly operation: Extract<
    Mir.Operation,
    { readonly _tag: 'RunEffect' | 'RunEffectValue' | 'CatchEffect' | 'ExecutionPark' }
  >
}

const operationsOf = (fn: Mir.MirFunction): ReadonlyArray<LocatedOperation> =>
  fn.regions.flatMap((region) => {
    let operations: ReadonlyArray<Mir.Operation>
    if (region._tag === 'OperationRegion') {
      operations = region.operations
    } else if (region._tag === 'CleanupRegion') {
      operations = region.releases
    } else {
      operations = []
    }
    return operations
      .flatMap(Mir.operationTree)
      .flatMap((operation) =>
        operation._tag === 'RunEffect' ||
        operation._tag === 'RunEffectValue' ||
        operation._tag === 'CatchEffect' ||
        operation._tag === 'ExecutionPark'
          ? [{ region: region.id, operation }]
          : [],
      )
  })

const sameSpan = (
  operation: Mir.Operation,
  control: Extract<ProvisionalMir.Outcome, { readonly _tag: 'RunSuspendableEffect' }>,
): boolean =>
  operation.provenance.span.sourceId === control.span.sourceId &&
  operation.provenance.span.start === control.span.start &&
  operation.provenance.span.end === control.span.end

const regionsOf = (
  program: Mir.Module,
  provisional: ProvisionalMir.Module,
  fn: Mir.MirFunction,
  execution: ProvisionalMir.Execution | undefined,
  ownership: SuspensionOwnership.Module,
  index: DeclarationIndex.Index,
): ReadonlyArray<Mir.SuspensionRegion> => {
  if (execution === undefined) return []
  const located = operationsOf(fn)
  let expandedOrdinal = Math.max(-1, ...execution.regions.map((region) => region.id.ordinal)) + 1
  return execution.regions.flatMap((region): ReadonlyArray<Mir.SuspensionRegion> => {
    if (region.outcome._tag === 'Complete') return []
    const point = pointOf(fn.instance, region.id)
    if (region.outcome._tag === 'SuspendEffect') {
      const outcome = region.outcome
      const candidate = located.find(
        (entry) =>
          entry.operation.provenance.span.sourceId === outcome.span.sourceId &&
          entry.operation.provenance.span.start === outcome.span.start &&
          entry.operation.provenance.span.end === outcome.span.end,
      )
      if (candidate === undefined || candidate.operation._tag === 'ExecutionPark') return []
      const deferred = runnerOf(outcome.deferred, index, candidate.operation, program.functions)
      return [
        {
          _tag: 'SuspendEffectRegion',
          point,
          ownerRegion: candidate.region,
          operation: candidate.operation,
          deferred,
          transfer: { _tag: 'OriginateTransfer' as const },
          provenance: { span: outcome.span, generated: false },
        },
      ]
    }
    const outcome = region.outcome
    const candidates = located.filter(
      (entry) =>
        sameSpan(entry.operation, outcome) &&
        (outcome.completion._tag === 'Reify'
          ? entry.operation._tag === 'CatchEffect' ||
            (entry.operation._tag !== 'ExecutionPark' &&
              Type.failureMembers(entry.operation.outcomeType.type).length === 0)
          : entry.operation._tag !== 'CatchEffect') &&
        (entry.operation._tag === 'ExecutionPark'
          ? Type.equals(outcome.runner.outcome.success, Type.unit)
          : true),
    )
    return candidates.flatMap((candidate, ordinal): ReadonlyArray<Mir.SuspensionRegion> => {
      const runner = runnerOf(outcome.runner, index, candidate.operation, program.functions)
      // Lowering a selected failure handler can produce a synchronous call at the same
      // source span as its protected suspendable recipe. Only the actual runner can relay.
      if (
        candidate.operation._tag !== 'ExecutionPark' &&
        runner.instance !== undefined &&
        ProvisionalMir.classificationOfExecution(provisional, runner.instance) === 'Synchronous'
      )
        return []
      const selectedPoint = ordinal === 0 ? point : { ...point, ordinal: expandedOrdinal++ }
      const plan = ownership.plans.find(
        (candidatePlan) =>
          Instances.keyText(candidatePlan.function) === Instances.keyText(fn.instance) &&
          samePoint(candidatePlan.point, region.id) &&
          candidatePlan.operation === candidate.operation,
      )
      return [
        {
          _tag: 'RunSuspendableEffectRegion',
          point: selectedPoint,
          ownerRegion: candidate.region,
          operation: candidate.operation,
          runner,
          completion: completionOf(outcome.completion, candidate.operation),
          liveLocals: plan?.slots.map((slot) => slot.local) ?? [],
          complete: { _tag: 'CompleteInCurrentActivation' },
          relay: {
            _tag: 'RelayExistingTransfer',
            preserves: outcome.relay.preserves,
            frame: plan?.frame ?? 'MissingOwnershipPlan',
            ...(plan?.frame === 'StatefulRelay'
              ? { state: descriptorOf(selectedPoint, runner, plan) }
              : {}),
          },
          provenance: candidate.operation.provenance,
        },
      ]
    })
  })
}

interface SuspensionCallTarget {
  readonly declaration: DeclarationFacts.CanonicalId
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly staticArguments: ReadonlyArray<StaticValue.Value>
}

const suspensionCallTargets = (
  operation: Mir.Operation,
  fn: Mir.MirFunction,
): ReadonlyArray<SuspensionCallTarget> => {
  switch (operation._tag) {
    case 'Call':
    case 'RunEffect':
      return [
        {
          declaration: operation.target,
          typeArguments: operation.typeArguments,
          staticArguments: operation.staticArguments ?? [],
        },
      ]
    case 'RunEffectValue':
    case 'RunStaticEffect':
    case 'CatchEffect':
      return [
        {
          declaration: operation.runner,
          typeArguments: operation.runnerTypeArguments,
          staticArguments: operation.runnerStaticArguments ?? [],
        },
        ...('cancellationFinalizer' in operation && operation.cancellationFinalizer !== undefined
          ? [
              {
                declaration: operation.cancellationFinalizer.runner,
                typeArguments: operation.cancellationFinalizer.runnerTypeArguments,
                staticArguments: operation.cancellationFinalizer.runnerStaticArguments ?? [],
              },
            ]
          : []),
        ...('cancellationFinalizer' in operation &&
        operation.cancellationFinalizer?._tag === 'ResourceCancellationFinalizer'
          ? [
              {
                declaration: operation.cancellationFinalizer.releaseTarget,
                typeArguments: operation.cancellationFinalizer.releaseTypeArguments,
                staticArguments: [],
              },
            ]
          : []),
      ]
    case 'RunEffectComposite':
      return operation.alternatives.map((alternative) => ({
        declaration: alternative.runner,
        typeArguments: alternative.runnerTypeArguments,
        staticArguments: alternative.runnerStaticArguments ?? [],
      }))
    case 'ApplyCallable': {
      const type =
        operation.callable === undefined ? undefined : fn.localTypes.at(operation.callable.ordinal)
      const target = operation.target ?? (type?._tag === 'CallableValue' ? type.target : undefined)
      return target?._tag === 'DeclarationCallableTarget'
        ? [
            {
              declaration: target.declaration,
              typeArguments: operation.typeArguments,
              staticArguments: [],
            },
          ]
        : []
    }
    default:
      return []
  }
}

/** Functions that can originate or relay a transfer through an actual lowered call. */
export const originReachableFunctions = (self: Mir.Module): ReadonlySet<string> => {
  const reachable = new Set(
    self.functions
      .filter((fn) =>
        fn.suspension?.regions.some(
          (region) =>
            region._tag === 'SuspendEffectRegion' ||
            (region._tag === 'RunSuspendableEffectRegion' &&
              region.operation._tag === 'ExecutionPark'),
        ),
      )
      .map((fn) => Instances.keyText(fn.instance)),
  )
  const byDeclaration = new Map<string, Array<Mir.MirFunction>>()
  for (const fn of self.functions) {
    const declarationKey = `${fn.id.module}\u0000${fn.id.name}`
    const bucket = byDeclaration.get(declarationKey)
    if (bucket === undefined) byDeclaration.set(declarationKey, [fn])
    else bucket.push(fn)
  }
  const pending = self.functions
    .filter((fn) => !reachable.has(Instances.keyText(fn.instance)))
    .map((fn) => ({
      key: Instances.keyText(fn.instance),
      targets: [
        ...Mir.topologicalRegions(fn)
          .flatMap(Mir.operationsOf)
          .flatMap(Mir.operationTree)
          .flatMap((operation) => suspensionCallTargets(operation, fn)),
        ...(fn.suspension?.regions ?? []).flatMap((region) =>
          region._tag === 'RunSuspendableEffectRegion' && region.runner.declaration !== undefined
            ? [
                {
                  declaration: region.runner.declaration,
                  typeArguments: region.runner.typeArguments,
                  staticArguments: region.runner.instance?.staticArguments ?? [],
                },
              ]
            : [],
        ),
      ],
    }))
  let changed = true
  while (changed) {
    changed = false
    for (let index = pending.length - 1; index >= 0; index -= 1) {
      const entry = pending[index]
      if (entry === undefined) continue
      const reachesOrigin = entry.targets.some((target) =>
        (
          byDeclaration.get(`${target.declaration.module}\u0000${target.declaration.name}`) ?? []
        ).some(
          (candidate) =>
            reachable.has(Instances.keyText(candidate.instance)) &&
            Mir.matchesInstance(
              candidate,
              target.declaration,
              target.typeArguments,
              target.staticArguments,
            ),
        ),
      )
      if (reachesOrigin) {
        reachable.add(entry.key)
        pending.splice(index, 1)
        changed = true
      }
    }
  }
  return reachable
}

/** Produces final MIR. Provisional control and ownership facts are consumed, never embedded. */
export const finalize = (
  program: Mir.Module,
  provisional: ProvisionalMir.Module,
  ownership: SuspensionOwnership.Module,
  index: DeclarationIndex.Index,
): Mir.Module => {
  const functions = program.functions.map((fn) => {
    const execution = ProvisionalMir.executionOf(provisional, fn.instance)
    const classification = ProvisionalMir.classificationOfExecution(provisional, fn.instance)
    const regions = regionsOf(program, provisional, fn, execution, ownership, index)
    const states = regions
      .flatMap((region) =>
        region._tag === 'RunSuspendableEffectRegion' && region.relay.state !== undefined
          ? [region.relay.state]
          : [],
      )
      .sort(
        (left, right) =>
          left.point.sourceId.localeCompare(right.point.sourceId) ||
          left.point.spanStart - right.point.spanStart ||
          left.point.ordinal - right.point.ordinal,
      )
    if (regions.length === 0 && (classification === 'Synchronous' || execution === undefined))
      return fn
    return {
      ...fn,
      suspension: {
        classification,
        regions,
        ...(states.length === 0
          ? {}
          : {
              frame: {
                _tag: 'CoroutineFrameDescriptor' as const,
                function: fn.instance,
                states,
              },
            }),
      },
    }
  })
  // Unknown provisional runners are conservative discovery facts. In closed MIR, only actual
  // calls to a retained origin require a transfer ABI; an independently managed execution must
  // not keep suspension machinery alive in an otherwise synchronous part of the program.
  const reachable = originReachableFunctions({ ...program, functions })
  return {
    ...program,
    functions: functions.map((fn, ordinal) => {
      if (!reachable.has(Instances.keyText(fn.instance))) return program.functions[ordinal] ?? fn
      if (fn.suspension === undefined) return fn
      const regions = fn.suspension.regions.filter(
        (region) =>
          region._tag === 'SuspendEffectRegion' ||
          region.operation._tag === 'ExecutionPark' ||
          functions.some(
            (candidate) =>
              reachable.has(Instances.keyText(candidate.instance)) &&
              region.runner.declaration !== undefined &&
              Mir.matchesInstance(
                candidate,
                region.runner.declaration,
                region.runner.typeArguments,
                region.runner.instance?.staticArguments,
              ),
          ),
      )
      const retainedStates = new Set(
        regions.flatMap((region) =>
          region._tag === 'RunSuspendableEffectRegion' && region.relay.state !== undefined
            ? [region.relay.state]
            : [],
        ),
      )
      const states = fn.suspension.frame?.states.filter((state) => retainedStates.has(state)) ?? []
      return {
        ...fn,
        suspension: {
          classification: fn.suspension.classification,
          regions: regions,
          ...(states.length === 0
            ? {}
            : {
                frame: {
                  _tag: 'CoroutineFrameDescriptor' as const,
                  function: fn.instance,
                  states: states,
                },
              }),
        },
      }
    }),
  }
}

/** Stable inspection summary for focused finalization tests. */
export const summary = (program: Mir.Module): string =>
  program.functions
    .flatMap((fn) =>
      (fn.suspension?.regions ?? []).map(
        (region) =>
          `${Instances.keyText(fn.instance)}:${region._tag}:${region.point.sourceId}:${region.point.spanStart}:${region.point.ordinal}:${region._tag === 'RunSuspendableEffectRegion' ? (region.relay.state?.slots.map((slot) => `${slot.ordinal}:${slot.local.ordinal}:${Type.encode(Mir.semanticType(slot.type))}`).join(',') ?? 'tail') : 'origin'}`,
      ),
    )
    .join('\n')
