import * as ConcreteCleanup from './ConcreteCleanup.js'
import * as CallableDeclarationView from './CallableDeclarationView.js'
import {
  authored,
  cleanupForLocal,
  generated,
  ownershipLocal,
  lowerOwnershipPath,
  lowerReferencePlace,
  patternBinding,
  propagationLoanEnds,
  propagationReleases,
} from './CleanupEmission.js'
import * as ConformanceProof from './ConformanceProof.js'
import type {} from './EntryAssembly.js'
import type {} from './Forwarding.js'
import { inlineForwardedRequirement } from './Forwarding.js'
import type { FunctionLowering } from './FunctionLowering.js'
import { invocationCompatibility, invocationFormationContext } from './FunctionLowering.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import * as Lifetime from './Lifetime.js'
import type { ProvidedRequirement } from './Lower.js'
import { borrowKey, patternKey, specializeProvider } from './Lower.js'
import type {} from './LowerExpression.js'
import {
  lowerCallOperand,
  lowerExpression,
  lowerExecution,
  lowerRecoveryInvocationInputs,
} from './LowerExpression.js'
import * as Match from './Match.js'
import * as Ownership from './Ownership.js'
import * as Mir from './Mir.js'
import * as SourceSpan from './SourceSpan.js'
import * as SourceCallView from './SourceCallView.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'
import * as TypeInference from './internal/TypeInference.js'
import * as EffectExecutionContract from './internal/EffectExecutionContract.js'
import {
  baseRunnerKey,
  effectValueByIdentity,
  ensureEffectRunner,
  generatedRunner,
  instanceText,
  providerBindings,
  requirementsFor,
  runtimeRequirementArguments,
} from './ValueType.js'

export const lowerCatchEffectValue = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'EffectCatch' }>,
  availableRequirements: ReadonlyArray<ProvidedRequirement> = fn.activeRequirements ??
    fn.providedRequirements,
): LoweredExpression | undefined => {
  const protected_ = lowerExpression(fn, expression.protected, availableRequirements)
  if (protected_ === 'Transferred') return protected_
  const protectedType =
    protected_ === undefined ? undefined : fn.localTypes.at(protected_.result.ordinal)
  const handler = lowerExpression(fn, expression.handler, availableRequirements)
  if (handler === 'Transferred') return handler
  const handlerType = handler === undefined ? undefined : fn.localTypes.at(handler.result.ordinal)
  if (
    protected_ === undefined ||
    protectedType?._tag !== 'EffectValue' ||
    handler === undefined ||
    handlerType?._tag !== 'CallableValue'
  ) {
    return undefined
  }

  const site = Tir.effectCatchSite(
    Tir.nodeReference(fn.owner.view.artifact, expression),
    fn.owner.key.declaration,
    fn.owner.function.declaration.id.ordinal,
  )
  const semanticType = fn.semantic(expression.type)
  if (!Type.isEffect(semanticType)) return undefined
  const environment = fn.layout.effectEnvironments.find(
    (
      candidate,
    ): candidate is Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }> =>
      candidate._tag === 'EffectEnvironment' &&
      Instances.keyText(candidate.instance) === Instances.keyText(fn.owner.key) &&
      Tir.sameExecutableSite(candidate.site, site) &&
      Type.equals(candidate.effect, semanticType),
  )
  if (environment === undefined || environment.fields.length !== 2) return undefined
  const type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }> = {
    _tag: 'EffectValue',
    type: environment.effect,
    site,
    environment,
  }
  const runner = Tir.effectRunnerId(fn.owner.key.declaration, site)
  const specializationKey = baseRunnerKey(fn.owner.key, site, type.type)
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'MakeEffect',
    destination,
    runner,
    runnerTypeArguments: fn.owner.key.typeArguments,
    captures: [
      {
        source: protected_.result,
        access: environment.fields[0]?.access ?? 'Take',
      },
      { source: handler.result, access: environment.fields[1]?.access ?? 'Take' },
    ],
    type,
    provenance: authored(expression.span),
  })
  if (generatedRunner(fn.generatedRunners, specializationKey) === undefined)
    fn.generatedRunners.push({
      _tag: 'CatchEffectRunner',
      id: runner,
      owner: fn.owner,
      expression,
      type,
      protectedType,
      handlerType,
      specializationKey,
      providedRequirements: [],
    })
  return { result: destination }
}

export interface LoweredValue {
  readonly result: Mir.LocalId
}

/** A successful eager expression either supplies a normal value or leaves its execution context. */
export type LoweredExpression = LoweredValue | 'Transferred'

export interface LoweredPlace {
  readonly root: Mir.LocalId
  readonly selectors: ReadonlyArray<Mir.PlaceSelector>
}

const cancellationFinalizerOf = (
  fn: FunctionLowering,
  effect: Mir.LocalId,
  effectType: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  availableRequirements: ReadonlyArray<ProvidedRequirement>,
): Mir.CancellationFinalizer | undefined => {
  const provided = requirementsFor(availableRequirements, effectType.type)
  if (provided === undefined) return undefined
  const runner = ensureEffectRunner(fn, effectType, provided)
  if (runner === undefined) return undefined
  const runnerInstance =
    effectType.storage?.realization.runnerInstance ?? effectType.environment.instance
  return {
    _tag: 'EffectCancellationFinalizer' as const,
    effect,
    runner,
    runnerTypeArguments:
      effectType.storage?.realization.runnerArguments ??
      effectType.environment.instance.typeArguments,
    ...(runnerInstance.staticArguments.length === 0
      ? {}
      : { runnerStaticArguments: runnerInstance.staticArguments }),
    arguments: runtimeRequirementArguments(provided),
    outcomeType: { _tag: 'EffectOutcome', type: effectType.type },
  }
}

export const lowerRunEffectValue = (
  fn: FunctionLowering,
  effect: Mir.LocalId,
  effectType: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  success: Type.Type,
  span: SourceSpan.SourceSpan,
  availableRequirements: ReadonlyArray<ProvidedRequirement> = fn.activeRequirements ??
    fn.providedRequirements,
  cancellationFinalizer?: Mir.CancellationFinalizer,
): LoweredExpression | undefined => {
  // A success that is itself an Effect is the value the environment's success identity names.
  const semanticSuccess = fn.semantic(success)
  const successType = Type.isEffect(semanticSuccess)
    ? effectValueByIdentity(
        fn.layout,
        effectType.environment.successEffectIdentity ?? '',
        semanticSuccess,
      )
    : fn.type(success)
  if (successType === undefined || successType._tag === 'EffectOutcome') return undefined
  const outcomeType: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
    _tag: 'EffectOutcome',
    type: effectType.type,
  }
  const outcome = fn.alloc(outcomeType)
  const destination = fn.alloc(successType)
  const propagationType =
    Type.failureMembers(effectType.type).length === 0 || fn.effectOutcome === undefined
      ? undefined
      : fn.type(fn.effectOutcome)
  if (propagationType !== undefined && propagationType._tag !== 'EffectOutcome') return undefined
  const tagMappings = Type.failureMembers(effectType.type).flatMap((failure, sourceOrdinal) => {
    const target =
      propagationType === undefined
        ? undefined
        : Type.failureMembers(propagationType.type).findIndex(
            (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(failure),
          )
    return target === undefined || target < 0
      ? []
      : [{ source: sourceOrdinal + 1, target: target + 1 }]
  })
  if (tagMappings.length !== Type.failureMembers(effectType.type).length) return undefined
  const propagationShape =
    propagationType === undefined ? undefined : Layout.callingShape(fn.layout, propagationType.type)
  const provided = requirementsFor(availableRequirements, effectType.type)
  const runner = provided === undefined ? undefined : ensureEffectRunner(fn, effectType, provided)
  if (provided === undefined || runner === undefined) return undefined
  const baseRunner =
    effectType.storage?.realization.runner ??
    Tir.effectRunnerId(effectType.environment.instance.declaration, effectType.site)
  const runnerInstance =
    effectType.storage?.realization.runnerInstance ?? effectType.environment.instance
  const baseRunnerTypeArguments =
    effectType.storage?.realization.runnerArguments ?? effectType.environment.instance.typeArguments
  const failureEnds = propagationLoanEnds(fn, span)
  const releases = propagationReleases(fn, span)
  fn.emit({
    _tag: 'RunEffectValue',
    destination,
    outcome,
    effect,
    runner,
    runnerTypeArguments: baseRunnerTypeArguments,
    ...(runnerInstance.staticArguments.length === 0
      ? {}
      : { runnerStaticArguments: runnerInstance.staticArguments }),
    ...(provided.length === 0
      ? {}
      : {
          runnerBase: {
            declaration: baseRunner,
            typeArguments: baseRunnerTypeArguments,
            ...(runnerInstance.staticArguments.length === 0
              ? {}
              : { staticArguments: runnerInstance.staticArguments }),
          },
        }),
    providers: providerBindings(provided),
    arguments: runtimeRequirementArguments(provided),
    ...(cancellationFinalizer === undefined ? {} : { cancellationFinalizer }),
    outcomeType,
    ...(propagationType === undefined ? {} : { propagationType }),
    tagMappings: tagMappings,
    propagationLaneCount: propagationShape?.laneCount ?? 0,
    ...(Type.failureMembers(effectType.type).length === 0 || failureEnds.length === 0
      ? {}
      : { failureLoanEnds: failureEnds }),
    ...(propagationType === undefined || releases.length === 0 ? {} : { releases }),
    type: successType,
    provenance: authored(span),
  })
  return { result: destination }
}

export const lowerRunEffectComposite = (
  fn: FunctionLowering,
  effect: Mir.LocalId,
  effectType: Extract<Mir.Type, { readonly _tag: 'EffectComposite' }>,
  success: Type.Type,
  span: SourceSpan.SourceSpan,
  availableRequirements: ReadonlyArray<ProvidedRequirement> = fn.activeRequirements ??
    fn.providedRequirements,
): LoweredExpression | undefined => {
  const successType = fn.type(success)
  if (
    successType === undefined ||
    successType._tag === 'EffectOutcome' ||
    successType._tag === 'EffectValue' ||
    successType._tag === 'EffectComposite'
  )
    return undefined
  const outcomeType: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
    _tag: 'EffectOutcome',
    type: effectType.contract,
  }
  const outcome = fn.alloc(outcomeType)
  const destination = fn.alloc(successType)
  const propagationType =
    Type.failureMembers(effectType.contract).length === 0 || fn.effectOutcome === undefined
      ? undefined
      : fn.type(fn.effectOutcome)
  if (propagationType !== undefined && propagationType._tag !== 'EffectOutcome') return undefined
  const alternatives = effectType.alternatives.flatMap((alternative) => {
    const provided = requirementsFor(availableRequirements, alternative.type)
    if (provided === undefined) return []
    const runner = ensureEffectRunner(fn, alternative, provided)
    if (runner === undefined) return []
    const runnerTypeArguments =
      alternative.storage?.realization.runnerArguments ??
      alternative.environment.instance.typeArguments
    const runnerInstance =
      alternative.storage?.realization.runnerInstance ?? alternative.environment.instance
    const tagMappings = Type.failureMembers(alternative.type).flatMap((failure, sourceOrdinal) => {
      const target = Type.failureMembers(effectType.contract).findIndex(
        (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(failure),
      )
      return target < 0 ? [] : [{ source: sourceOrdinal + 1, target: target + 1 }]
    })
    return tagMappings.length !== Type.failureMembers(alternative.type).length
      ? []
      : [
          {
            type: alternative,
            runner,
            runnerTypeArguments,
            ...(runnerInstance.staticArguments.length === 0
              ? {}
              : { runnerStaticArguments: runnerInstance.staticArguments }),
            tagMappings,
            arguments: runtimeRequirementArguments(provided),
          },
        ]
  })
  if (alternatives.length !== effectType.alternatives.length) return undefined
  const outerMappings = Type.failureMembers(effectType.contract).flatMap(
    (failure, sourceOrdinal) => {
      const target =
        propagationType === undefined
          ? undefined
          : Type.failureMembers(propagationType.type).findIndex(
              (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(failure),
            )
      return target === undefined || target < 0
        ? []
        : [{ source: sourceOrdinal + 1, target: target + 1 }]
    },
  )
  if (outerMappings.length !== Type.failureMembers(effectType.contract).length) return undefined
  const propagationShape =
    propagationType === undefined ? undefined : Layout.callingShape(fn.layout, propagationType.type)
  const arguments_ = [
    ...new Map(
      alternatives
        .flatMap((alternative) => alternative.arguments)
        .map((argument) => [argument.ordinal, argument] as const),
    ).values(),
  ].sort((left, right) => left.ordinal - right.ordinal)
  fn.emit({
    _tag: 'RunEffectComposite',
    destination,
    outcome,
    effect,
    alternatives: alternatives,
    arguments: arguments_,
    outcomeType,
    ...(propagationType === undefined ? {} : { propagationType }),
    tagMappings: outerMappings,
    propagationLaneCount: propagationShape?.laneCount ?? 0,
    ...(Type.failureMembers(effectType.contract).length === 0
      ? {}
      : { failureLoanEnds: propagationLoanEnds(fn, span) }),
    ...(propagationType === undefined ? {} : { releases: propagationReleases(fn, span) }),
    type: successType,
    provenance: authored(span),
  })
  return { result: destination }
}

export interface CaughtEffect {
  readonly outcome: Mir.LocalId
  readonly valid: Mir.LocalId
  readonly success: Mir.LocalId
  readonly failure: Mir.LocalId
  readonly failureValueType: Type.Type
}

export const runCaughtEffectValue = (
  fn: FunctionLowering,
  effect: Mir.LocalId,
  effectType: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  span: SourceSpan.SourceSpan,
  availableRequirements: ReadonlyArray<ProvidedRequirement> = fn.activeRequirements ??
    fn.providedRequirements,
  cancellationFinalizer?: Mir.CancellationFinalizer,
): CaughtEffect | undefined => {
  const provided = requirementsFor(availableRequirements, effectType.type)
  if (provided === undefined) return undefined
  const runner = ensureEffectRunner(fn, effectType, provided)
  if (runner === undefined) return undefined
  const outcomeType: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
    _tag: 'EffectOutcome',
    type: effectType.type,
  }
  const failureValueType = Type.failureValue(Type.failureMembers(effectType.type))
  const boolType = fn.type('bool')
  const successType = fn.type(effectType.type.success)
  const failureType = fn.type(failureValueType)
  const outcomeShape = Layout.callingShape(fn.layout, effectType.type)
  const successShape = Layout.callingShape(fn.layout, effectType.type.success)
  const failureValueShape = Layout.callingShape(fn.layout, failureValueType)
  if (
    boolType?._tag !== 'bool' ||
    successType === undefined ||
    successType._tag === 'EffectOutcome' ||
    failureType === undefined ||
    failureType._tag === 'EffectOutcome' ||
    outcomeShape === undefined ||
    successShape === undefined ||
    failureValueShape === undefined ||
    Type.failureMembers(effectType.type).length === 0
  )
    return undefined
  const outcome = fn.alloc(outcomeType)
  const valid = fn.alloc(boolType)
  const success = fn.alloc(successType)
  const failure = fn.alloc(failureType)
  const runnerInstance =
    effectType.storage?.realization.runnerInstance ?? effectType.environment.instance
  fn.emit({
    _tag: 'CatchEffect' as const,
    destination: valid,
    outcome,
    successValue: success,
    failureValue: failure,
    effect,
    runner,
    runnerTypeArguments:
      effectType.storage?.realization.runnerArguments ??
      effectType.environment.instance.typeArguments,
    ...(runnerInstance.staticArguments.length === 0
      ? {}
      : { runnerStaticArguments: runnerInstance.staticArguments }),
    arguments: runtimeRequirementArguments(provided),
    ...(cancellationFinalizer === undefined ? {} : { cancellationFinalizer }),
    outcomeType,
    failureValueType,
    successShape,
    outcomeShape,
    failureValueShape,
    type: boolType,
    provenance: authored(span),
  })
  return {
    outcome,
    valid,
    success,
    failure,
    failureValueType,
  }
}

/** Selects one exact capture environment before invoking a composition on it. */
const lowerWithEffectValue = (
  fn: FunctionLowering,
  source: Mir.LocalId,
  composite: Extract<Mir.Type, { readonly _tag: 'EffectComposite' }>,
  success: Type.Type,
  span: SourceSpan.SourceSpan,
  use: (
    value: Mir.LocalId,
    type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  ) => LoweredExpression | undefined,
): LoweredExpression | undefined => {
  const resultType = fn.type(success)
  const boolType = fn.type('bool')
  const resultShape = Layout.callingShape(fn.layout, success)
  if (
    resultType === undefined ||
    resultType._tag === 'EffectOutcome' ||
    boolType?._tag !== 'bool' ||
    resultShape === undefined
  )
    return undefined
  const select = (ordinal: number): LoweredExpression | undefined => {
    const type = composite.alternatives.at(ordinal)
    if (type === undefined) return 'Transferred'
    const destination = fn.alloc(type)
    const matched = fn.alloc(boolType)
    fn.emit({
      _tag: 'UnpackEffectComposite',
      destination,
      matched,
      source,
      alternative: ordinal,
      type,
      provenance: generated(span),
    })
    const taken = lowerExecution(fn, span, () => use(destination, type))
    const otherwise = lowerExecution(fn, span, () => select(ordinal + 1))
    if (taken === undefined || otherwise === undefined) return undefined
    const result = fn.alloc(resultType)
    fn.emit({
      _tag: 'Conditional',
      destination: result,
      condition: matched,
      taken,
      otherwise,
      type: resultType,
      resultShape,
      provenance: generated(span),
    })
    return { result }
  }
  return select(0)
}

/** Holds the protected outcome through finalization without selecting a recovery cause. */
export const lowerFinalizedEffect = (
  fn: FunctionLowering,
  protectedValue: Mir.LocalId,
  protectedType: Extract<Mir.Type, { readonly _tag: 'EffectValue' | 'EffectComposite' }>,
  finalizer: Mir.LocalId,
  finalizerType: Extract<Mir.Type, { readonly _tag: 'EffectValue' | 'EffectComposite' }>,
  span: SourceSpan.SourceSpan,
  protectedSpan: SourceSpan.SourceSpan,
  finalizerSpan: SourceSpan.SourceSpan,
  availableRequirements: ReadonlyArray<ProvidedRequirement>,
  cancellationSafe = false,
): LoweredExpression | undefined => {
  if (protectedType._tag === 'EffectComposite')
    return lowerWithEffectValue(
      fn,
      protectedValue,
      protectedType,
      protectedType.contract.success,
      protectedSpan,
      (value, type) =>
        lowerFinalizedEffect(
          fn,
          value,
          type,
          finalizer,
          finalizerType,
          span,
          protectedSpan,
          finalizerSpan,
          availableRequirements,
          cancellationSafe,
        ),
    )
  let cancellationFinalizer: Mir.CancellationFinalizer | undefined
  if (cancellationSafe && finalizerType._tag === 'EffectValue')
    cancellationFinalizer = cancellationFinalizerOf(
      fn,
      finalizer,
      finalizerType,
      availableRequirements,
    )
  if (cancellationSafe && cancellationFinalizer === undefined) return undefined
  const finalize = (): LoweredExpression | undefined =>
    finalizerType._tag === 'EffectComposite'
      ? lowerWithEffectValue(
          fn,
          finalizer,
          finalizerType,
          Type.unit,
          finalizerSpan,
          (value, type) =>
            lowerRunEffectValue(fn, value, type, Type.unit, finalizerSpan, availableRequirements),
        )
      : lowerRunEffectValue(
          fn,
          finalizer,
          finalizerType,
          Type.unit,
          finalizerSpan,
          availableRequirements,
        )
  const failures = Type.failureMembers(protectedType.type)
  if (failures.length === 0) {
    const protectedResult = lowerRunEffectValue(
      fn,
      protectedValue,
      protectedType,
      protectedType.type.success,
      protectedSpan,
      availableRequirements,
      cancellationFinalizer,
    )
    if (protectedResult === undefined || protectedResult === 'Transferred') return protectedResult
    const finalized = finalize()
    return finalized === undefined || finalized === 'Transferred' ? finalized : protectedResult
  }
  const caught = runCaughtEffectValue(
    fn,
    protectedValue,
    protectedType,
    protectedSpan,
    availableRequirements,
    cancellationFinalizer,
  )
  if (caught === undefined || fn.effectOutcome === undefined) return undefined
  const successType = fn.localTypes.at(caught.success.ordinal)
  const failureType = fn.localTypes.at(caught.failure.ordinal)
  const propagationType = fn.type(fn.effectOutcome)
  const successShape = Layout.callingShape(fn.layout, protectedType.type.success)
  const propagationShape = Layout.callingShape(fn.layout, fn.effectOutcome)
  if (
    successType === undefined ||
    successType._tag === 'EffectOutcome' ||
    failureType === undefined ||
    failureType._tag === 'EffectOutcome' ||
    propagationType?._tag !== 'EffectOutcome' ||
    successShape === undefined ||
    propagationShape === undefined
  )
    return undefined
  const propagatedFailures = Type.failureMembers(propagationType.type)
  const tagMappings = failures.flatMap((failure, source) => {
    const target = propagatedFailures.findIndex(
      (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(failure),
    )
    return target < 0 ? [] : [{ source, target: target + 1 }]
  })
  if (tagMappings.length !== failures.length) return undefined
  const taken = lowerExecution(fn, span, () => {
    const finalized = finalize()
    return finalized === undefined || finalized === 'Transferred'
      ? finalized
      : { result: caught.success }
  })
  const otherwise = lowerExecution(fn, span, () => {
    const finalized = finalize()
    if (finalized === undefined || finalized === 'Transferred') return finalized
    const bottom = fn.type('never')
    if (bottom?._tag !== 'Bottom') return undefined
    const releases = propagationReleases(fn, span)
    fn.emit({
      _tag: 'PropagateEffectFailure',
      source: caught.failure,
      outcome: caught.outcome,
      sourceType: failureType,
      propagationType,
      tagMappings: tagMappings,
      propagationLaneCount: propagationShape.laneCount,
      ...(releases.length === 0 ? {} : { releases }),
      type: bottom,
      provenance: generated(span),
    })
    return 'Transferred'
  })
  if (taken === undefined || otherwise === undefined) return undefined
  const destination = fn.alloc(successType)
  fn.emit({
    _tag: 'Conditional',
    destination,
    condition: caught.valid,
    taken,
    otherwise,
    type: successType,
    resultShape: successShape,
    provenance: generated(span),
  })
  return { result: destination }
}

const callableTargetArguments = (
  callable: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
): ReadonlyArray<Type.GenericArgument> =>
  callable.environment === undefined
    ? (callable.storage?.realization.targetArguments ?? callable.typeArguments ?? [])
    : Layout.callableTargetArguments(callable.environment)

export const callableEffectValue = (
  fn: FunctionLowering,
  callable: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  if (callable.target._tag !== 'DeclarationCallableTarget') return undefined
  const result = fn.effectResults.get(
    instanceText(callable.target.declaration, callableTargetArguments(callable)),
  )
  if (result?._tag !== 'EffectValue') return undefined
  const schema = callable.type.schema
  if (schema === undefined) return result
  const source = schema.source
  if (
    source === undefined ||
    source.module !== callable.target.declaration.module ||
    source.name !== callable.target.declaration.name
  )
    return undefined
  // Machine sharing erases lifetime arguments. The actual operand retains the original source
  // selection, so its proof header must not inherit another invocation's finite regions.
  const selected = Type.substitute(schema.contract.result, schema.substitution)
  if (!Type.isEffect(selected)) return undefined
  const fields = result.environment.fields.map((field) => {
    if (field.source !== 'Parameter') return field
    const parameter = schema.contract.parameters.at(field.ordinal)
    return parameter === undefined
      ? undefined
      : { ...field, type: Type.substitute(parameter.type, schema.substitution) }
  })
  if (fields.some((field) => field === undefined)) return undefined
  const selectedResult = { ...selected, access: result.type.access }
  return {
    ...result,
    type: selectedResult,
    environment: {
      ...result.environment,
      effect: selectedResult,
      fields: fields.flatMap((field) => (field === undefined ? [] : [field])),
    },
  }
}

/** The offered designation belongs to the actual producer, independently of its required view. */
const callableInvocationBinder = (
  fn: FunctionLowering,
  callable: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
): { readonly binder?: Lifetime.Bound } | undefined => {
  let usage: Type.InvocationUse | undefined
  if (callable.environment !== undefined) {
    usage = callable.environment.callable.type.invocationUse
  } else {
    const source = CallableDeclarationView.original(fn.index, callable)
    if (source === undefined) return undefined
    usage = source.contract.invocationUse
  }
  if (usage === undefined) return {}
  return usage.lifetime._tag === 'BoundLifetime' ? { binder: usage.lifetime } : undefined
}

const resourceCancellationFinalizerOf = (
  fn: FunctionLowering,
  resource: Mir.LocalId,
  release: Mir.LocalId,
  releaseType: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
  releaseEffectType: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  availableRequirements: ReadonlyArray<ProvidedRequirement>,
): Mir.ResourceCancellationFinalizer | undefined => {
  if (releaseType.target._tag !== 'DeclarationCallableTarget') return undefined
  const provided = requirementsFor(availableRequirements, releaseEffectType.type)
  if (provided === undefined) return undefined
  const runner = ensureEffectRunner(fn, releaseEffectType, provided)
  if (runner === undefined) return undefined
  const runnerInstance =
    releaseEffectType.storage?.realization.runnerInstance ?? releaseEffectType.environment.instance
  return {
    _tag: 'ResourceCancellationFinalizer',
    resource,
    release,
    releaseTarget: releaseType.target.declaration,
    releaseTypeArguments: callableTargetArguments(releaseType),
    runner,
    runnerTypeArguments:
      releaseEffectType.storage?.realization.runnerArguments ??
      releaseEffectType.environment.instance.typeArguments,
    ...(runnerInstance.staticArguments.length === 0
      ? {}
      : { runnerStaticArguments: runnerInstance.staticArguments }),
    arguments: runtimeRequirementArguments(provided),
    outcomeType: { _tag: 'EffectOutcome', type: releaseEffectType.type },
  }
}

const beginResourceLoan = (
  fn: FunctionLowering,
  resource: Mir.LocalId,
  resourceType: Mir.Type,
  callbackType: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
  call: Tir.NodeRef,
  span: SourceSpan.SourceSpan,
): { readonly borrow: Tir.BorrowId; readonly reference: Mir.LocalId } | undefined => {
  const parameter = callbackType.type.parameters.at(0)
  const referenceType = parameter === undefined ? undefined : fn.type(parameter)
  if (referenceType?._tag !== 'Reference' || referenceType.type.access !== 'Exclusive')
    return undefined
  const borrow = fn.freshSyntheticBorrow(call)
  const reference = fn.alloc(referenceType)
  fn.emit({
    _tag: 'BeginLoan' as const,
    borrow,
    destination: reference,
    root: resource,
    selectors: [],
    sourceType: resourceType,
    type: referenceType,
    access: 'Exclusive' as const,
    reborrow: false,
    suspendsParent: false,
    provenance: generated(span),
  })
  fn.loanLocals.set(borrowKey(borrow), reference)
  return { borrow, reference }
}

const applyResourceEffectBuilder = (
  fn: FunctionLowering,
  callable: Mir.LocalId,
  callableType: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>,
  effectType: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  reference: Mir.LocalId,
  span: SourceSpan.SourceSpan,
): Mir.LocalId => {
  const destination = fn.alloc(effectType)
  fn.emit({
    _tag: 'ApplyCallable' as const,
    destination,
    callable,
    typeArguments: callableTargetArguments(callableType),
    captures: [],
    arguments: [reference],
    callableType: callableType.type,
    access: callableType.type.mode,
    evaluation: 'CalleeThenArguments' as const,
    realization: 'Environment' as const,
    type: effectType,
    provenance: generated(span),
  })
  return destination
}

/** Lowers an owned-resource bracket without forming simultaneous use and release borrows. */
export const lowerUseReleaseNonParking = (
  fn: FunctionLowering,
  resourceExpression: Tir.Expression,
  useExpression: Tir.Expression,
  releaseExpression: Tir.Expression,
  span: SourceSpan.SourceSpan,
  availableRequirements: ReadonlyArray<ProvidedRequirement>,
): LoweredExpression | undefined => {
  const resource = lowerExpression(fn, resourceExpression, availableRequirements)
  if (resource === undefined || resource === 'Transferred') return resource
  const use = lowerExpression(fn, useExpression, availableRequirements)
  if (use === undefined || use === 'Transferred') return use
  const release = lowerExpression(fn, releaseExpression, availableRequirements)
  if (release === undefined || release === 'Transferred') return release
  const resourceType = fn.localTypes.at(resource.result.ordinal)
  const useType = fn.localTypes.at(use.result.ordinal)
  const releaseType = fn.localTypes.at(release.result.ordinal)
  const useEffectType =
    useType?._tag === 'CallableValue' ? callableEffectValue(fn, useType) : undefined
  const releaseEffectType =
    releaseType?._tag === 'CallableValue' ? callableEffectValue(fn, releaseType) : undefined
  if (
    resourceType === undefined ||
    resourceType._tag === 'EffectOutcome' ||
    useType?._tag !== 'CallableValue' ||
    releaseType?._tag !== 'CallableValue' ||
    useEffectType === undefined ||
    releaseEffectType === undefined
  )
    return undefined
  const useLoan = beginResourceLoan(
    fn,
    resource.result,
    resourceType,
    useType,
    Tir.nodeReference(fn.owner.view.artifact, useExpression),
    useExpression.span,
  )
  if (useLoan === undefined) return undefined
  const protectedValue = applyResourceEffectBuilder(
    fn,
    use.result,
    useType,
    useEffectType,
    useLoan.reference,
    useExpression.span,
  )
  const cancellationFinalizer = resourceCancellationFinalizerOf(
    fn,
    resource.result,
    release.result,
    releaseType,
    releaseEffectType,
    availableRequirements,
  )
  if (cancellationFinalizer === undefined) return undefined

  const releaseResource = (): LoweredExpression | undefined => {
    const releaseLoan = beginResourceLoan(
      fn,
      resource.result,
      resourceType,
      releaseType,
      Tir.nodeReference(fn.owner.view.artifact, releaseExpression),
      releaseExpression.span,
    )
    if (releaseLoan === undefined) return undefined
    const releaseValue = applyResourceEffectBuilder(
      fn,
      release.result,
      releaseType,
      releaseEffectType,
      releaseLoan.reference,
      releaseExpression.span,
    )
    const finalized = lowerRunEffectValue(
      fn,
      releaseValue,
      releaseEffectType,
      Type.unit,
      releaseExpression.span,
      availableRequirements,
    )
    if (finalized === undefined || finalized === 'Transferred') return finalized
    endLoan(fn, releaseLoan.borrow, releaseExpression.span)
    const cleanup = cleanupForLocal(
      fn,
      ConcreteCleanup.forType(fn, Mir.semanticType(resourceType)),
      resourceType,
    )
    if (cleanup._tag !== 'NoCleanup')
      fn.emit({
        _tag: 'Drop' as const,
        local: resource.result,
        cleanup,
        provenance: generated(span),
      })
    return finalized
  }

  const failures = Type.failureMembers(useEffectType.type)
  if (failures.length === 0) {
    const protectedResult = lowerRunEffectValue(
      fn,
      protectedValue,
      useEffectType,
      useEffectType.type.success,
      useExpression.span,
      availableRequirements,
      cancellationFinalizer,
    )
    if (protectedResult === undefined || protectedResult === 'Transferred') return protectedResult
    endLoan(fn, useLoan.borrow, useExpression.span)
    const finalized = releaseResource()
    return finalized === undefined || finalized === 'Transferred' ? finalized : protectedResult
  }

  const caught = runCaughtEffectValue(
    fn,
    protectedValue,
    useEffectType,
    useExpression.span,
    availableRequirements,
    cancellationFinalizer,
  )
  if (caught === undefined || fn.effectOutcome === undefined) return undefined
  endLoan(fn, useLoan.borrow, useExpression.span)
  const successType = fn.localTypes.at(caught.success.ordinal)
  const failureType = fn.localTypes.at(caught.failure.ordinal)
  const propagationType = fn.type(fn.effectOutcome)
  const successShape = Layout.callingShape(fn.layout, useEffectType.type.success)
  const propagationShape =
    propagationType?._tag === 'EffectOutcome'
      ? Layout.callingShape(fn.layout, propagationType.type)
      : undefined
  if (
    successType === undefined ||
    successType._tag === 'EffectOutcome' ||
    failureType === undefined ||
    failureType._tag === 'EffectOutcome' ||
    propagationType?._tag !== 'EffectOutcome' ||
    successShape === undefined ||
    propagationShape === undefined
  )
    return undefined
  const propagatedFailures = Type.failureMembers(propagationType.type)
  const tagMappings = failures.flatMap((failure, source) => {
    const target = propagatedFailures.findIndex(
      (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(failure),
    )
    return target < 0 ? [] : [{ source, target: target + 1 }]
  })
  if (tagMappings.length !== failures.length) return undefined
  const taken = lowerExecution(fn, span, () => {
    const finalized = releaseResource()
    return finalized === undefined || finalized === 'Transferred'
      ? finalized
      : { result: caught.success }
  })
  const otherwise = lowerExecution(fn, span, () => {
    const finalized = releaseResource()
    if (finalized === undefined || finalized === 'Transferred') return finalized
    const bottom = fn.type('never')
    if (bottom?._tag !== 'Bottom') return undefined
    const releases = propagationReleases(fn, span)
    fn.emit({
      _tag: 'PropagateEffectFailure' as const,
      source: caught.failure,
      outcome: caught.outcome,
      sourceType: failureType,
      propagationType,
      tagMappings: tagMappings,
      propagationLaneCount: propagationShape.laneCount,
      ...(releases.length === 0 ? {} : { releases }),
      type: bottom,
      provenance: generated(span),
    })
    return 'Transferred' as const
  })
  if (taken === undefined || otherwise === undefined) return undefined
  const destination = fn.alloc(successType)
  fn.emit({
    _tag: 'Conditional' as const,
    destination,
    condition: caught.valid,
    taken,
    otherwise,
    type: successType,
    resultShape: successShape,
    provenance: generated(span),
  })
  return { result: destination }
}

/**
 * Injects a run result into the recovered success type. A `never` source diverged before producing
 * a value, so it flows through unchanged; a member of the `A | B` union is injected or widened.
 */
const injectSuccess = (
  fn: FunctionLowering,
  source: Mir.LocalId,
  from: Type.Type,
  to: Type.Type,
  span: SourceSpan.SourceSpan,
): Mir.LocalId | undefined => {
  if (Type.equals(from, to) || Type.isNever(from)) return source
  const conversion = TypeCompatibility.check(from, to)
  const sourceType = fn.type(from)
  const targetType = fn.type(to)
  const sourceShape = Layout.callingShape(fn.layout, from)
  const targetShape = Layout.callingShape(fn.layout, to)
  if (
    (conversion._tag !== 'Inject' && conversion._tag !== 'Widen') ||
    sourceType === undefined ||
    sourceType._tag === 'EffectOutcome' ||
    targetType?._tag !== 'Union' ||
    sourceShape === undefined ||
    targetShape === undefined
  )
    return undefined
  const destination = fn.alloc(targetType)
  fn.emit({
    _tag: 'ConvertUnion' as const,
    destination,
    source,
    sourceType,
    sourceSemantic: from,
    targetType,
    conversion: conversion._tag,
    mappings: conversion.mappings,
    sourceShape,
    targetShape,
    access: 'Owned' as const,
    provenance: generated(span),
  })
  return destination
}

export const lowerEffectCatch = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'EffectCatch' }>,
  runSpan: SourceSpan.SourceSpan,
  captured?: {
    readonly protected: Mir.LocalId
    readonly protectedType: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>
    readonly handler: Mir.LocalId
    readonly handlerType: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>
  },
  availableRequirements: ReadonlyArray<ProvidedRequirement> = fn.activeRequirements ??
    fn.providedRequirements,
): LoweredExpression | undefined => {
  if (expression.protected._tag === 'Unavailable') return undefined
  let protected_: LoweredExpression | undefined
  if (captured === undefined) {
    if (expression.protected._tag === 'ServiceEffectConstruct') {
      protected_ = lowerServiceEffectValue(fn, expression.protected, availableRequirements)
    } else {
      protected_ = lowerExpression(fn, expression.protected, availableRequirements)
    }
  } else {
    protected_ = { result: captured.protected }
  }
  if (protected_ === 'Transferred') return protected_
  const protectedType =
    captured?.protectedType ??
    (protected_ === undefined ? undefined : fn.localTypes.at(protected_.result.ordinal))
  if (protected_ === undefined || protectedType?._tag !== 'EffectValue') return undefined

  // Both operands are formed before the protected Effect starts, matching ordinary call
  // evaluation even though the handler is invoked only on the selected failure path.
  const handler =
    captured === undefined
      ? lowerExpression(fn, expression.handler, availableRequirements)
      : { result: captured.handler }
  if (handler === 'Transferred') return handler
  const handlerType =
    captured?.handlerType ??
    (handler === undefined ? undefined : fn.localTypes.at(handler.result.ordinal))
  const physicalHandlerEffectType =
    handlerType?._tag === 'CallableValue' ? callableEffectValue(fn, handlerType) : undefined
  if (
    handler === undefined ||
    handlerType?._tag !== 'CallableValue' ||
    physicalHandlerEffectType === undefined
  )
    return undefined
  const unusedHandlerDrop = (): ReadonlyArray<Mir.DropOperation> => {
    const cleanup = cleanupForLocal(
      fn,
      ConcreteCleanup.forType(fn, Mir.semanticType(handlerType)),
      handlerType,
    )
    return cleanup._tag === 'NoCleanup'
      ? []
      : [
          {
            _tag: 'Drop' as const,
            local: handler.result,
            cleanup,
            provenance: generated(runSpan),
          },
        ]
  }

  const selected = fn.semantic(expression.selected)
  const recipe = expression.recoveryInvocation
  if (recipe === undefined || !Type.equals(fn.semantic(recipe.selected), selected)) return undefined
  const offered = callableInvocationBinder(fn, handlerType)
  if (offered === undefined) return undefined
  const closedBinder = offered.binder ?? handlerType.type.invocationUse?.lifetime ?? recipe.binder
  if (closedBinder._tag !== 'BoundLifetime') return undefined
  const baseCompatibility = invocationFormationContext(
    fn,
    handlerType,
    closedBinder,
    invocationCompatibility(fn),
  )
  if (baseCompatibility === undefined) return undefined
  // This is the checked recipe's exact conditional input, not formation captures or a new
  // declaration bound. Actual failure storage and cleanup are discharged by invocation retention.
  const compatibility: TypeCompatibility.Context = {
    ...baseCompatibility,
    invocationInputs: [
      ...baseCompatibility.invocationInputs,
      { parameter: recipe.parameter, type: selected, lifetime: recipe.lifetime },
    ],
    assumptions: Lifetime.mergeAssumptions(
      baseCompatibility.assumptions,
      Lifetime.assumptions(
        Type.retention(selected).regions.map((longer) => ({
          longer,
          shorter: recipe.lifetime,
        })),
      ),
    ),
  }
  const opened = TypeInference.openInvocationCallable(
    handlerType.type,
    [selected],
    recipe.lifetime,
    compatibility,
  )
  if (opened === undefined) return undefined
  const resultSubstitution = new Map(opened.substitution)
  if (offered.binder !== undefined)
    resultSubstitution.set(Lifetime.key(offered.binder), recipe.lifetime)
  // The physical body can be shared with another caller's finite lifetime tuple. Read this
  // named operand's result from its original header and complete actual source arguments;
  // keep the physical environment, runner and body arguments as selected by layout.
  const originalHandler =
    handlerType.type.schema === undefined &&
    handlerType.environment === undefined &&
    handlerType.storage === undefined
      ? CallableDeclarationView.original(fn.index, handlerType)
      : undefined
  const originalResult =
    originalHandler === undefined
      ? undefined
      : Type.substitute(originalHandler.contract.result, originalHandler.substitution)
  const handlerResult = Type.substitute(
    originalResult !== undefined && Type.isEffect(originalResult)
      ? { ...originalResult, access: physicalHandlerEffectType.type.access }
      : physicalHandlerEffectType.type,
    resultSubstitution,
    compatibility,
  )
  const declaredHandlerResult = opened.callable.result
  if (!Type.isEffect(handlerResult) || !Type.isEffect(declaredHandlerResult)) return undefined
  // Invoking an Effect function captures its actual inputs. An owned input strengthens the
  // constructed computation's access even when the declaration's bare return contract is shared.
  // Read those captures from this exact source producer, independently of the result descriptor.
  const captureAccesses = physicalHandlerEffectType.environment.fields.map((field) => field.access)
  let invocationAccess: Type.CaptureAccess = 'Shared'
  if (declaredHandlerResult.access === 'Take' || captureAccesses.includes('Take'))
    invocationAccess = 'Take'
  else if (declaredHandlerResult.access === 'Exclusive' || captureAccesses.includes('Exclusive'))
    invocationAccess = 'Exclusive'
  const invokedHandlerResult: Type.Effect = { ...declaredHandlerResult, access: invocationAccess }
  if (
    !TypeCompatibility.isCompatible(
      TypeCompatibility.check(handlerResult, invokedHandlerResult, compatibility),
    )
  )
    return undefined
  const handlerEffectType = { ...physicalHandlerEffectType, type: handlerResult }
  const sourceBinder = offered.binder
  const recoveryInvocation = (
    argument: Mir.LocalId,
    result: Mir.LocalId,
  ): Mir.InvocationUse | undefined => {
    const actual = fn.localTypes.at(argument.ordinal)
    if (actual === undefined || !Type.equals(Mir.semanticType(actual), selected)) return undefined
    const retained = lowerRecoveryInvocationInputs(
      fn,
      handler.result,
      argument,
      selected,
      sourceBinder ?? recipe.binder,
    )
    if (retained === undefined) return undefined
    return {
      kind: 'Recovery',
      owner: recipe.owner,
      origin: recipe.origin,
      binder: retained.binder,
      lifetime: recipe.lifetime,
      inputs: retained.inputs,
      result,
    }
  }
  const protectedEffect = fn.semantic(expression.protected.type)
  const resultEffect = fn.semantic(expression.type)
  if (!Type.isEffect(protectedEffect) || !Type.isEffect(resultEffect)) return undefined
  if (Type.isNever(selected)) {
    const succeeded = lowerRunEffectValue(
      fn,
      protected_.result,
      protectedType,
      protectedEffect.success,
      runSpan,
      availableRequirements,
    )
    if (succeeded === 'Transferred') return succeeded
    if (succeeded === undefined) return undefined
    for (const drop of unusedHandlerDrop()) fn.emit(drop)
    const destination = injectSuccess(
      fn,
      succeeded.result,
      protectedEffect.success,
      resultEffect.success,
      expression.span,
    )
    if (destination === undefined) return undefined
    endRunLoans(fn, runSpan)
    return { result: destination }
  }
  const protectedFailures = Type.failureMembers(protectedEffect)
  const selectedMembers: ReadonlyArray<Type.Type> = Type.isUnion(selected)
    ? selected.members
    : [selected]
  if (
    selectedMembers.some(
      (member) => !protectedFailures.some((failure) => Type.equals(failure, member)),
    )
  )
    return undefined

  const caught = runCaughtEffectValue(
    fn,
    protected_.result,
    protectedType,
    expression.span,
    availableRequirements,
  )
  if (caught === undefined) return undefined
  // The handler runs with its own success type; `never` diverges and a member of `A | B` is
  // injected so both paths meet the recovered union (FAIL-004).
  const runHandler = (applied: Mir.LocalId): LoweredExpression | undefined => {
    const handled = lowerRunEffectValue(
      fn,
      applied,
      handlerEffectType,
      handlerEffectType.type.success,
      runSpan,
      availableRequirements,
    )
    if (handled === 'Transferred') return handled
    if (handled === undefined) return undefined
    const result = injectSuccess(
      fn,
      handled.result,
      handlerEffectType.type.success,
      resultEffect.success,
      expression.span,
    )
    return result === undefined ? undefined : { result }
  }
  const [takenResult, takenOperations] = fn.capture(() => {
    for (const drop of unusedHandlerDrop()) fn.emit(drop)
    return injectSuccess(
      fn,
      caught.success,
      protectedEffect.success,
      resultEffect.success,
      expression.span,
    )
  })
  if (takenResult === undefined) return undefined
  const taken = lowerExecution(fn, expression.span, () => {
    for (const operation of takenOperations) fn.emit(operation)
    return { result: takenResult }
  })
  if (taken === undefined) return undefined

  const successType = fn.type(resultEffect.success)
  const successShape = Layout.callingShape(fn.layout, resultEffect.success)
  const failureValueMir = fn.type(caught.failureValueType)
  if (
    successType === undefined ||
    successType._tag === 'EffectOutcome' ||
    successShape === undefined ||
    failureValueMir === undefined ||
    failureValueMir._tag === 'EffectOutcome'
  )
    return undefined

  if (failureValueMir._tag !== 'Nominal' && failureValueMir._tag !== 'Union') {
    const onlyFailure = protectedFailures.at(0)
    if (
      protectedFailures.length !== 1 ||
      onlyFailure === undefined ||
      !selectedMembers.some((candidate) => Type.equals(candidate, onlyFailure))
    )
      return undefined
    const otherwise = lowerExecution(fn, expression.span, () => {
      const applied = fn.alloc(handlerEffectType)
      const invocationUse = recoveryInvocation(caught.failure, applied)
      if (invocationUse === undefined) return undefined
      fn.emit({
        _tag: 'ApplyCallable' as const,
        invocationUse,
        destination: applied,
        callable: handler.result,
        typeArguments: callableTargetArguments(handlerType),
        captures: [],
        arguments: [caught.failure],
        callableType: opened.callable,
        access: handlerType.type.mode,
        evaluation: 'CalleeThenArguments' as const,
        realization: 'Environment' as const,
        type: handlerEffectType,
        provenance: generated(expression.span),
      })
      return runHandler(applied)
    })
    if (otherwise === undefined) return undefined
    const destination = fn.alloc(successType)
    fn.emit({
      _tag: 'Conditional' as const,
      destination,
      condition: caught.valid,
      taken,
      otherwise: {
        ...otherwise,
        recoveryOutcome: caught.outcome,
        recoveryInvocation: { ...recipe, selected },
      },
      type: successType,
      resultShape: successShape,
      provenance: generated(expression.span),
    })
    endRunLoans(fn, runSpan)
    return { result: destination }
  }

  const failureMembers =
    failureValueMir._tag === 'Nominal' ? [failureValueMir.type] : failureValueMir.type.members
  const innerMatch: Match.MatchId = {
    _tag: 'MatchId',
    node: Tir.nodeReference(fn.owner.view.artifact, expression),
  }
  const failureShape = Layout.callingShape(fn.layout, caught.failureValueType)
  if (failureShape === undefined) return undefined
  // A failure-row member may itself be a nominal union. Layout expands its variants into
  // distinct decisions, while the catch arm still binds and handles the entire member.
  const failureCoverage = Layout.coverageMembers(failureShape)
  const coverage = Match.cover(
    failureCoverage,
    failureMembers.map((member) => ({
      member: Match.structuralMember(member),
      universal: false,
      guarded: false,
    })),
    'Runtime',
  )
  const innerArms: Array<Mir.MatchArm> = []
  for (const [ordinal, member] of failureMembers.entries()) {
    const transition = coverage.transitions.at(ordinal)
    if (transition === undefined) return undefined
    const memberCoverage = Match.structuralMember(member)
    const armId: Match.ArmId = {
      _tag: 'MatchArmId',
      match: innerMatch,
      ordinal,
    }
    const bindingId: Tir.LocalId = {
      _tag: 'TirLocal',
      ordinal,
    }
    const memberType = fn.type(member)
    if (memberType === undefined || memberType._tag === 'EffectOutcome') return undefined
    const bound = fn.alloc(memberType)
    const selectedExecution = lowerExecution(fn, expression.span, () => {
      if (
        selectedMembers.some((candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(member))
      ) {
        let handlerArgument = bound
        if (!Type.equals(member, selected)) {
          const selectedType = fn.type(selected)
          const sourceShape = Layout.callingShape(fn.layout, member)
          const targetShape = Layout.callingShape(fn.layout, selected)
          const conversion = TypeCompatibility.check(member, selected)
          if (
            selectedType?._tag !== 'Union' ||
            sourceShape === undefined ||
            targetShape === undefined ||
            conversion._tag !== 'Inject'
          )
            return undefined
          handlerArgument = fn.alloc(selectedType)
          fn.emit({
            _tag: 'ConvertUnion' as const,
            destination: handlerArgument,
            source: bound,
            sourceType: memberType,
            sourceSemantic: member,
            targetType: selectedType,
            conversion: 'Inject' as const,
            mappings: conversion.mappings,
            sourceShape,
            targetShape,
            access: 'Owned' as const,
            provenance: generated(expression.span),
          })
        }
        const applied = fn.alloc(handlerEffectType)
        const invocationUse = recoveryInvocation(handlerArgument, applied)
        if (invocationUse === undefined) return undefined
        fn.emit({
          _tag: 'ApplyCallable' as const,
          invocationUse,
          destination: applied,
          callable: handler.result,
          typeArguments: callableTargetArguments(handlerType),
          captures: [],
          arguments: [handlerArgument],
          callableType: opened.callable,
          access: handlerType.type.mode,
          evaluation: 'CalleeThenArguments' as const,
          realization: 'Environment' as const,
          type: handlerEffectType,
          provenance: generated(expression.span),
        })
        return runHandler(applied)
      }
      // A fully handled catch is valid in an ordinary function. Only an unselected
      // failure needs an enclosing Effect outcome through which it can propagate.
      const propagationEffect = fn.effectOutcome
      const propagationType =
        propagationEffect === undefined ? undefined : fn.type(propagationEffect)
      const propagationShape =
        propagationEffect === undefined
          ? undefined
          : Layout.callingShape(fn.layout, propagationEffect)
      if (
        propagationEffect === undefined ||
        propagationType?._tag !== 'EffectOutcome' ||
        propagationShape === undefined
      )
        return undefined
      const target = Type.failureMembers(propagationEffect).findIndex(
        (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(member),
      )
      const bottom = fn.type('never')
      if (target < 0 || bottom?._tag !== 'Bottom') return undefined
      for (const drop of unusedHandlerDrop()) fn.emit(drop)
      const releases = propagationReleases(fn, runSpan)
      fn.emit({
        _tag: 'PropagateEffectFailure' as const,
        source: bound,
        outcome: caught.outcome,
        sourceType: memberType,
        propagationType,
        tagMappings: [{ source: 0, target: target + 1 }],
        propagationLaneCount: propagationShape.laneCount,
        ...(releases.length === 0 ? {} : { releases }),
        type: bottom,
        provenance: generated(expression.span),
      })
      return 'Transferred'
    })
    if (selectedExecution === undefined) return undefined
    innerArms.push({
      id: armId,
      member: memberCoverage,
      universal: false,
      before: transition.before,
      after: transition.after,
      bindings: [
        {
          id: bindingId,
          destination: bound,
          path: [],
          type: memberType,
          access: 'Move' as const,
          provenance: generated(expression.span),
        },
      ],
      cleanupBindings: [],
      selected: {
        access: 'Move' as const,
        execution: selectedMembers.some((candidate) => Type.equals(candidate, member))
          ? {
              ...selectedExecution,
              recoveryOutcome: caught.outcome,
              recoveryInvocation: { ...recipe, selected },
            }
          : selectedExecution,
        cleanup: [],
        endBorrow: false,
      },
      provenance: generated(expression.span),
    })
  }
  const innerResult = fn.alloc(successType)
  const innerOperation: Mir.MatchOperation = {
    _tag: 'Match',
    id: innerMatch,
    destination: innerResult,
    scrutinee: caught.failure,
    scrutineeType: failureValueMir,
    scrutineeShape: failureShape,
    access: 'Move',
    retainsBindings: false,
    members: failureCoverage,
    decisions: failureCoverage.map((member) => ({
      member,
      candidates: innerArms
        .filter((arm) => arm.member !== undefined && Match.selects(arm.member, member, 'Runtime'))
        .map((arm) => arm.id),
    })),
    arms: innerArms,
    type: successType,
    resultShape: successShape,
    provenance: generated(expression.span),
  }
  const otherwise = lowerExecution(fn, expression.span, () => {
    fn.emit(innerOperation)
    return { result: innerResult }
  })
  if (otherwise === undefined) return undefined
  const destination = fn.alloc(successType)
  fn.emit({
    _tag: 'Conditional' as const,
    destination,
    condition: caught.valid,
    taken,
    otherwise,
    type: successType,
    resultShape: successShape,
    provenance: generated(expression.span),
  })
  endRunLoans(fn, runSpan)
  return { result: destination }
}
export const lowerPlacePath = (
  fn: FunctionLowering,
  expression: Tir.Expression,
  availableRequirements: ReadonlyArray<ProvidedRequirement> = fn.activeRequirements ??
    fn.providedRequirements,
): LoweredPlace | 'Transferred' | undefined => {
  if (expression._tag === 'ReferentPlace') {
    const root = lowerExpression(fn, expression.subject, availableRequirements)
    if (root === 'Transferred') return root
    return root === undefined ? undefined : { root: root.result, selectors: [] }
  }
  if (expression._tag === 'Project') {
    const path = lowerPlacePath(fn, expression.subject, availableRequirements)
    if (path === 'Transferred') return path
    const subject =
      path === undefined
        ? undefined
        : lowerReferencePlace(fn, path.root, path.selectors, authored(expression.span))
    if (subject === undefined) return undefined
    return {
      root: subject.root,
      selectors: [
        ...subject.selectors,
        {
          _tag: 'FieldSelector' as const,
          field: expression.field,
          provenance: { span: expression.span, generated: false },
        },
      ],
    }
  }
  if (expression._tag === 'IndexPlace') {
    const path = lowerPlacePath(fn, expression.subject, availableRequirements)
    if (path === 'Transferred') return path
    const subject =
      path === undefined
        ? undefined
        : lowerReferencePlace(fn, path.root, path.selectors, authored(expression.span))
    if (subject === undefined) return undefined
    const index:
      | Extract<Mir.PlaceSelector, { readonly _tag: 'ElementSelector' }>['index']
      | 'Transferred'
      | undefined =
      expression.bounds._tag === 'Proven'
        ? { _tag: 'Proven', value: expression.bounds.index }
        : (() => {
            const lowered = lowerExpression(fn, expression.index, availableRequirements)
            if (lowered === 'Transferred') return lowered
            return lowered === undefined
              ? undefined
              : { _tag: 'Runtime' as const, local: lowered.result }
          })()
    if (index === 'Transferred') return index
    if (index === undefined) return undefined
    return {
      root: subject.root,
      selectors: [
        ...subject.selectors,
        {
          _tag: 'ElementSelector' as const,
          length: expression.array.length,
          index,
          provenance: { span: expression.span, generated: false },
        },
      ],
    }
  }
  if (expression._tag === 'SliceIndexPlace') {
    // A slice descriptor is a value boundary, not inline aggregate storage. Materialize
    // it before indexing so nested projections retain the pointer and runtime length.
    const subject = lowerExpression(fn, expression.slice, availableRequirements)
    if (subject === 'Transferred') return subject
    const index = lowerExpression(fn, expression.index, availableRequirements)
    if (index === 'Transferred') return index
    if (subject === undefined || index === undefined) return undefined
    return {
      root: subject.result,
      selectors: [
        {
          _tag: 'SliceElementSelector',
          index: index.result,
          access: expression.access,
          provenance: authored(expression.span),
        },
      ],
    }
  }
  const root = lowerExpression(fn, expression, availableRequirements)
  if (root === 'Transferred') return root
  return root === undefined ? undefined : { root: root.result, selectors: [] }
}

/** The concrete Effect a borrowed Effect parameter lends, named by its hidden identity. */
const referentEffectValue = (
  fn: FunctionLowering,
  expression: Extract<
    Tir.Expression,
    { readonly _tag: 'ReferentPlace' | 'Project' | 'IndexPlace' | 'SliceIndexPlace' }
  >,
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  if (expression._tag !== 'ReferentPlace' || expression.subject._tag !== 'ParameterReference')
    return undefined
  const contract = fn.semantic(expression.type)
  if (!Type.isEffect(contract)) return undefined
  const identity = Instances.parameterEffectIdentityArgument(
    fn.owner.function,
    fn.owner.key,
    expression.subject.parameter.ordinal,
  )
  return identity === undefined
    ? undefined
    : effectValueByIdentity(
        fn.layout,
        identity.identity,
        EffectExecutionContract.fromType(contract),
        identity.owner,
      )
}

export const lowerPlace = (
  fn: FunctionLowering,
  expression: Extract<
    Tir.Expression,
    { readonly _tag: 'ReferentPlace' | 'Project' | 'IndexPlace' | 'SliceIndexPlace' }
  >,
  availableRequirements: ReadonlyArray<ProvidedRequirement> = fn.activeRequirements ??
    fn.providedRequirements,
): LoweredExpression | undefined => {
  const path = lowerPlacePath(fn, expression, availableRequirements)
  if (path === 'Transferred') return path
  const place = path === undefined ? undefined : lowerReferencePlace(fn, path.root, path.selectors)
  const type = referentEffectValue(fn, expression) ?? fn.type(expression.type)
  if (place === undefined || type === undefined) return undefined
  const destination = fn.alloc(type)
  fn.emit({
    _tag: 'ReadPlace',
    destination,
    root: place.root,
    selectors: place.selectors,
    type,
    ...((type._tag === 'CallableValue' &&
      type.storage !== undefined &&
      type.type.mode === 'Take') ||
    (type._tag === 'EffectValue' && type.storage !== undefined && type.type.access === 'Take') ||
    ('access' in expression && expression.access === 'ConsumeRequested')
      ? { consume: true as const }
      : {}),
    provenance: { span: expression.span, generated: false },
  })
  return { result: destination }
}

export const endLoans = (
  fn: FunctionLowering,
  loans: ReadonlyArray<Tir.BorrowId>,
  span: SourceSpan.SourceSpan,
): void => {
  for (const authored of loans) {
    const borrow = fn.recipeBorrow(authored)
    endLoan(fn, borrow, span)
  }
}

/** Ends one authored or synthetic loan exactly once. */
export const endLoan = (
  fn: FunctionLowering,
  borrow: Tir.BorrowId,
  span: SourceSpan.SourceSpan,
): void => {
  const key = borrowKey(borrow)
  const held = fn.loanLocals.get(key)
  if (held === undefined) return
  fn.emit({
    _tag: 'EndLoan',
    borrow,
    slice: held,
    provenance: generated(span),
  })
  fn.loanLocals.delete(key)
}

// Run and expression sites scan the function's loans in ownership order, once per site. The
// origin filters are per function, so each owner keeps its filtered loans: the selfhost lowering
// profile spent about 40 s rescanning and probing every loan at each site.
const runLoanFacts = new WeakMap<Ownership.FunctionOwnership, ReadonlyArray<Ownership.LoanFact>>()
const returnedViewLoanFacts = new WeakMap<
  Ownership.FunctionOwnership,
  ReadonlyArray<Ownership.LoanFact>
>()

const ownershipLoans = (
  cache: WeakMap<Ownership.FunctionOwnership, ReadonlyArray<Ownership.LoanFact>>,
  ownership: Ownership.FunctionOwnership | undefined,
  admits: (loan: Ownership.LoanFact) => boolean,
): ReadonlyArray<Ownership.LoanFact> => {
  if (ownership === undefined) return []
  let loans = cache.get(ownership)
  if (loans === undefined) {
    loans = ownership.loans.filter(admits)
    cache.set(ownership, loans)
  }
  return loans
}

export const endRunLoans = (fn: FunctionLowering, span: SourceSpan.SourceSpan): void => {
  // A constructed effect holds its argument borrows until the run that consumes it: ownership
  // records that end site, so every lowering path for run must release them here.
  const loans = ownershipLoans(
    runLoanFacts,
    fn.ownership,
    (loan) =>
      loan.origin === 'EffectCapture' ||
      loan.origin === 'CallableCapture' ||
      loan.origin === 'ReturnedCallableCapture' ||
      loan.origin === 'ValueBorrow' ||
      loan.origin === 'InterfaceOperand',
  )
  for (const loan of loans) {
    // Only a held loan can end, so the rest of the scan is inert once none remain.
    if (fn.loanLocals.size === 0) return
    if (loan.endSpan.sourceId !== span.sourceId || loan.endSpan.end > span.end) {
      continue
    }
    endLoan(fn, fn.recipeBorrow(loan.id), span)
  }
}

export const dropOwnedProvider = (
  fn: FunctionLowering,
  local_: Mir.LocalId,
  type: Type.Nominal,
  span: SourceSpan.SourceSpan,
): void => {
  const cleanup = ConcreteCleanup.forType(fn, type)
  if (cleanup._tag === 'NoCleanup') return
  fn.emit({
    _tag: 'Drop',
    local: local_,
    cleanup,
    provenance: generated(span),
  })
}

export const endReturnedViewLoans = (fn: FunctionLowering, span: SourceSpan.SourceSpan): void => {
  const loans = ownershipLoans(
    returnedViewLoanFacts,
    fn.ownership,
    (loan) =>
      !loan.cleanupOnly &&
      (loan.origin === 'ReturnedView' || loan.origin === 'ReturnedCallableCapture'),
  )
  for (const loan of loans) {
    if (fn.loanLocals.size === 0) return
    if (
      loan.endSpan.sourceId !== span.sourceId ||
      loan.endSpan.start < span.start ||
      loan.endSpan.end > span.end
    ) {
      continue
    }
    endLoan(fn, fn.recipeBorrow(loan.id), span)
  }
}

export const retainedEffectLoans = (
  fn: FunctionLowering,
  expression: Tir.Expression,
): ReadonlyArray<Tir.BorrowId> => {
  const retained = new Map<string, Tir.BorrowId>()
  for (const child of Tir.expressionTree(expression)) {
    if (child._tag === 'BindingReference') {
      for (const borrow of fn.effectLoanEnds.get(child.binding.ordinal) ?? [])
        retained.set(borrowKey(borrow), borrow)
    }
    if (child._tag === 'SliceBorrow' || child._tag === 'ValueBorrow') {
      retained.set(borrowKey(child.borrow), child.borrow)
      continue
    }
    if (
      (child._tag === 'BuiltinCall' || child._tag === 'InterfaceOperationCall') &&
      child.witnessEffectSite !== undefined
    ) {
      const call = Tir.nodeReference(fn.owner.view.artifact, child)
      for (const loan of fn.ownership?.loans ?? []) {
        if (loan.origin === 'InterfaceOperand' && Tir.nodeRefEquals(loan.id.call, call))
          retained.set(borrowKey(loan.id), loan.id)
      }
    }
    if (child._tag !== 'CallableSection') continue
    for (const capture of child.captures) {
      if (capture.value._tag !== 'SliceBorrow' && capture.value._tag !== 'ValueBorrow') continue
      retained.set(borrowKey(capture.value.borrow), capture.value.borrow)
    }
  }
  return [...retained.values()]
}

export const borrowedWriteRoot = (
  fn: FunctionLowering,
  root: Tir.BorrowedWritePlace['root'],
): Mir.LocalId | undefined =>
  root._tag === 'ParameterSliceRoot'
    ? fn.parameterLocals.get(root.parameter.ordinal)
    : fn.bindingLocals.get(root.binding.ordinal)

/** Resolves a discriminant-only pattern alias to its original owned storage. */
export const patternPlace = (
  fn: FunctionLowering,
  binding: Tir.LocalId,
  span: SourceSpan.SourceSpan,
):
  | { readonly root: Mir.LocalId; readonly selectors: ReadonlyArray<Mir.PlaceSelector> }
  | undefined => {
  const place = patternBinding(fn, binding)?.place
  if (place === undefined) return undefined
  const root = ownershipLocal(fn, place.root)
  if (root === undefined) return undefined
  const selectors = lowerOwnershipPath(fn, root, place.path, span)
  return selectors === undefined ? undefined : { root, selectors }
}

export const ownedWriteRoot = (
  fn: FunctionLowering,
  root: Tir.OwnedWriteRoot,
): Mir.LocalId | undefined => {
  switch (root._tag) {
    case 'ParameterWriteRoot':
      return fn.parameterLocals.get(root.parameter.ordinal)
    case 'BindingWriteRoot':
      return fn.bindingLocals.get(root.binding.ordinal)
    case 'PatternWriteRoot': {
      const place = patternBinding(fn, root.binding)?.place
      return place === undefined
        ? fn.patternLocals.get(patternKey(root.binding))
        : ownershipLocal(fn, place.root)
    }
  }
}

export const lowerServiceEffectValue = (
  fn: FunctionLowering,
  subject: Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }>,
  availableRequirements: ReadonlyArray<ProvidedRequirement>,
): LoweredExpression | undefined => {
  const service = fn.semantic(subject.service)
  const provided = availableRequirements.find(
    (requirement) =>
      requirement.role === subject.role &&
      Type.equals(requirement.capability, service) &&
      (subject.access === 'Shared' ||
        requirement.access === 'Exclusive' ||
        requirement.access === 'Take'),
  )
  if (provided?.witness._tag !== 'SourceConformanceWitness' || provided.local === undefined)
    return undefined
  const target = ConformanceProof.witnessOperation(provided.witness, subject.operation)
  if (target === undefined) return undefined
  const loweredArguments: Array<Mir.LocalId> = []
  for (const argument of subject.arguments) {
    const lowered = lowerCallOperand(fn, argument, availableRequirements)
    if (lowered === 'Transferred' || lowered === undefined) return lowered
    loweredArguments.push(lowered.result)
  }
  const call = fn.call(subject, target, undefined, subject.staticArguments, availableRequirements)
  if (
    call === undefined ||
    call.target.declaration.module !== target.module ||
    call.target.declaration.name !== target.name
  )
    return undefined
  const typeArguments = call.target.typeArguments
  const semanticType = fn.semantic(subject.type)
  const effectValue =
    (call.resultEffect === undefined
      ? undefined
      : effectValueByIdentity(fn.layout, call.resultEffect, undefined)) ??
    fn.effectResults.get(Instances.keyText(call.target))
  // A selected source provider implements the service requirement itself. Its physical Effect
  // retains the original provider inputs and environment; only that exact witnessed row member
  // may differ from the authored service contract.
  const witnessedProvider =
    SourceCallView.serves(provided, subject.access) &&
    Type.equals(provided.witness.capability, service) &&
    Type.equals(provided.witness.provider, provided.providerType) &&
    (call.providers ?? []).every(
      (provider) =>
        provider.role !== provided.role ||
        !Type.equals(provider.capability, provided.capability) ||
        Type.equals(provider.providerType, provided.providerType),
    )
  const physicalContract =
    effectValue === undefined ? undefined : EffectExecutionContract.fromType(effectValue.type)
  if (
    effectValue === undefined ||
    effectValue._tag !== 'EffectValue' ||
    Instances.keyText(effectValue.environment.instance) !== Instances.keyText(call.target) ||
    call.resultEffect !==
      Instances.effectIdentity(effectValue.environment.instance, effectValue.site) ||
    physicalContract === undefined ||
    !Type.isEffect(semanticType) ||
    !witnessedProvider ||
    SourceCallView.service(fn, subject, call, provided, physicalContract) === undefined
  )
    return undefined
  const effect = fn.alloc(effectValue)
  fn.emit({
    _tag: 'Call',
    destination: effect,
    target,
    typeArguments,
    ...(call.target.staticArguments.length === 0
      ? {}
      : { staticArguments: call.target.staticArguments }),
    arguments: [provided.local, ...loweredArguments],
    type: effectValue,
    provenance: authored(subject.span),
  })
  return { result: effect }
}

interface LoweredProvidedEffect {
  readonly requirement: ProvidedRequirement
  readonly ownedProvider?: Mir.LocalId
  readonly loan?: Tir.BorrowId
}

const prepareProvidedEffect = (
  fn: FunctionLowering,
  providerFact: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>['provider'],
  call: Tir.NodeRef,
): LoweredProvidedEffect | undefined => {
  const selected = specializeProvider(fn, providerFact)
  if (selected === undefined) return undefined
  let provider: Mir.LocalId | undefined
  if (providerFact.binding !== undefined) {
    provider = fn.bindingLocals.get(providerFact.binding.ordinal)
  } else if (providerFact.parameter !== undefined) {
    provider = fn.parameterLocals.get(providerFact.parameter.ordinal)
  } else {
    provider = undefined
  }
  const ownedProvider = providerFact.selectionAccess === 'Take' ? provider : undefined
  if (selected.witness._tag !== 'SourceConformanceWitness')
    return {
      requirement: selected,
      ...(ownedProvider === undefined ? {} : { ownedProvider }),
    }

  const access =
    providerFact.selectionAccess === 'Take' ? ('Exclusive' as const) : providerFact.selectionAccess
  const forwardedType =
    providerFact.parameter === undefined || provider === undefined
      ? undefined
      : fn.localTypes.at(provider.ordinal)
  if (
    provider !== undefined &&
    forwardedType?._tag === 'Reference' &&
    forwardedType.type.access === access &&
    Type.equals(forwardedType.type.target, selected.providerType)
  )
    return {
      requirement: { ...selected, local: provider },
      ...(ownedProvider === undefined ? {} : { ownedProvider }),
    }

  if (provider === undefined) return undefined
  const providerType = fn.type(selected.providerType)
  const referenceType = fn.type(
    Type.reference(
      access,
      selected.providerType,
      forwardedType?._tag === 'Reference'
        ? forwardedType.type.lifetime
        : Lifetime.local(fn.owner.key.declaration, 'retained-provider', provider.ordinal),
    ),
  )
  const authoredLoan = fn.ownership?.loans.find(
    (candidate) =>
      (candidate.origin === 'EffectCapture' ||
        candidate.origin === 'CallableCapture' ||
        candidate.origin === 'ReturnedCallableCapture' ||
        candidate.origin === 'ValueBorrow') &&
      candidate.access === access &&
      candidate.startSpan.start === providerFact.span.start &&
      candidate.startSpan.end === providerFact.span.end,
  )
  const borrow = fn.beginRecipeBorrow(authoredLoan?.id ?? fn.freshSyntheticBorrow(call))
  if (
    provider === undefined ||
    providerType?._tag !== 'Nominal' ||
    referenceType?._tag !== 'Reference' ||
    borrow === undefined
  )
    return undefined
  const reference = fn.alloc(referenceType)
  fn.emit({
    _tag: 'BeginLoan',
    borrow,
    destination: reference,
    root: provider,
    selectors: [],
    sourceType: providerType,
    type: referenceType,
    access,
    reborrow: false,
    suspendsParent: false,
    provenance: authored(providerFact.span),
  })
  fn.loanLocals.set(borrowKey(borrow), reference)
  return {
    requirement: { ...selected, local: reference },
    loan: borrow,
    ...(ownedProvider === undefined ? {} : { ownedProvider }),
  }
}

/**
 * Brackets one provided requirement for catch handling or immediate execution. The actor that begins
 * a provider loan also ends it, removes its tracking entry, and drops a taken provider after the
 * protected lowering has finished.
 */
export const lowerProvidedEffect = <A>(
  fn: FunctionLowering,
  providerFact: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>['provider'],
  call: Tir.NodeRef,
  use: (requirement: ProvidedRequirement) => A | undefined,
): A | 'Transferred' | undefined => {
  const provided = prepareProvidedEffect(fn, providerFact, call)
  if (provided === undefined) return undefined
  const result = use(provided.requirement)
  if (result === 'Transferred') return result
  if (result === undefined) return undefined
  if (provided.loan !== undefined) endLoans(fn, [provided.loan], providerFact.span)
  if (provided.ownedProvider !== undefined)
    dropOwnedProvider(
      fn,
      provided.ownedProvider,
      provided.requirement.providerType,
      providerFact.span,
    )
  return result
}

type ForwardedRequirement = Exclude<ReturnType<typeof inlineForwardedRequirement>, undefined>

/** Brackets the provider introduced by an inlined forwarding wrapper. */
const lowerForwardedProvider = <A>(
  fn: FunctionLowering,
  forwarded: ForwardedRequirement,
  loanEndSpan: SourceSpan.SourceSpan,
  availableRequirements: ReadonlyArray<ProvidedRequirement>,
  use: (requirement: ProvidedRequirement) => A | undefined,
): A | 'Transferred' | undefined => {
  const provider = lowerExpression(fn, forwarded.provider, availableRequirements)
  if (provider === 'Transferred') return provider
  if (provider === undefined) return undefined
  const providerBorrow =
    forwarded.provider._tag === 'ValueBorrow'
      ? fn.recipeBorrow(forwarded.provider.borrow)
      : undefined
  let runtimeProvider = provider.result
  let ownedLoan: Tir.BorrowId | undefined
  if (
    forwarded.selection.access === 'Take' &&
    forwarded.selection.witness._tag === 'SourceConformanceWitness'
  ) {
    const providerType = fn.type(forwarded.selection.providerType)
    const referenceType = fn.type(
      Type.reference(
        'Exclusive',
        forwarded.selection.providerType,
        Lifetime.local(fn.owner.key.declaration, 'owned-provider', provider.result.ordinal),
      ),
    )
    if (providerType?._tag !== 'Nominal' || referenceType?._tag !== 'Reference') return undefined
    const borrow = fn.freshSyntheticBorrow(
      Tir.nodeReference(fn.owner.view.artifact, forwarded.provider),
    )
    const reference = fn.alloc(referenceType)
    fn.emit({
      _tag: 'BeginLoan',
      borrow,
      destination: reference,
      root: provider.result,
      selectors: [],
      sourceType: providerType,
      type: referenceType,
      access: 'Exclusive',
      reborrow: false,
      suspendsParent: false,
      provenance: authored(forwarded.provider.span),
    })
    fn.loanLocals.set(borrowKey(borrow), reference)
    runtimeProvider = reference
    ownedLoan = borrow
  }
  const result = use({ ...forwarded.selection, local: runtimeProvider })
  if (result === 'Transferred') return result
  if (result === undefined) return undefined
  if (providerBorrow !== undefined) endLoans(fn, [providerBorrow], loanEndSpan)
  if (ownedLoan !== undefined) endLoans(fn, [ownedLoan], forwarded.provider.span)
  if (forwarded.selection.access === 'Take')
    dropOwnedProvider(
      fn,
      provider.result,
      forwarded.selection.providerType,
      forwarded.provider.span,
    )
  return result
}

export const lowerEffectExecution = (
  fn: FunctionLowering,
  subject: Tir.Expression,
  success: Type.Type,
  span: SourceSpan.SourceSpan,
  availableRequirements: ReadonlyArray<ProvidedRequirement> = fn.activeRequirements ??
    fn.providedRequirements,
): LoweredExpression | undefined => {
  if (subject._tag === 'Match') {
    return lowerExpression(
      fn,
      {
        ...subject,
        arms: subject.arms.map((arm) =>
          arm.body._tag === 'Block'
            ? arm
            : {
                ...arm,
                body: {
                  ...arm.body,
                  type: success,
                  expression: {
                    _tag: 'Run' as const,
                    subject: arm.body.expression,
                    type: success,
                    span: arm.body.span,
                    origin: arm.body.origin,
                  },
                },
              },
        ),
        type: success,
      },
      availableRequirements,
    )
  }
  if (subject._tag === 'BindingReference') {
    const storedRecipe = fn.effectRecipes.get(subject.binding.ordinal)
    if (storedRecipe !== undefined)
      return lowerEffectExecution(fn, storedRecipe, success, span, availableRequirements)
  }
  if (subject._tag === 'Move' && subject.subject._tag === 'BindingReference') {
    const storedRecipe = fn.effectRecipes.get(subject.subject.binding.ordinal)
    if (storedRecipe !== undefined)
      return lowerEffectExecution(fn, storedRecipe, success, span, availableRequirements)
  }

  const forwarded = inlineForwardedRequirement(fn, subject)
  if (forwarded !== undefined) {
    return lowerForwardedProvider(fn, forwarded, span, availableRequirements, (requirement) => {
      const result = lowerEffectExecution(fn, forwarded.binding.protected, success, span, [
        requirement,
        ...availableRequirements,
      ])
      if (result === 'Transferred') return result
      if (result === undefined) return undefined
      endRunLoans(fn, span)
      if (
        forwarded.binding.protected._tag === 'EffectConstruct' ||
        forwarded.binding.protected._tag === 'ServiceEffectConstruct'
      )
        endLoans(fn, forwarded.binding.protected.loanEnds, span)
      return result
    })
  }

  if (subject._tag === 'EffectBindRequirement') {
    return lowerProvidedEffect(
      fn,
      subject.provider,
      Tir.nodeReference(fn.owner.view.artifact, subject),
      (requirement) => {
        const result = lowerEffectExecution(fn, subject.protected, success, span, [
          requirement,
          ...availableRequirements,
        ])
        if (result === 'Transferred') return result
        if (result === undefined) return undefined
        endRunLoans(fn, span)
        if (
          subject.protected._tag === 'EffectConstruct' ||
          subject.protected._tag === 'ServiceEffectConstruct'
        )
          endLoans(fn, subject.protected.loanEnds, span)
        return result
      },
    )
  }
  if (subject._tag === 'ServiceEffectConstruct') {
    const lowered = lowerServiceEffectValue(fn, subject, availableRequirements)
    if (lowered === 'Transferred') return lowered
    const effectValue = lowered === undefined ? undefined : fn.localTypes.at(lowered.result.ordinal)
    if (lowered === undefined || effectValue?._tag !== 'EffectValue') return undefined
    const result = lowerRunEffectValue(
      fn,
      lowered.result,
      effectValue,
      success,
      span,
      availableRequirements,
    )
    if (result === 'Transferred') return result
    if (result !== undefined) {
      endRunLoans(fn, span)
      endLoans(fn, subject.loanEnds, span)
    }
    return result
  }

  if (subject._tag === 'BuiltinCall' && Type.isEffect(subject.type)) {
    const run = {
      _tag: 'Run' as const,
      subject,
      type: success,
      span,
      origin: subject.origin,
    }
    return lowerExpression(fn, run, availableRequirements)
  }

  const lowered = lowerExpression(fn, subject, availableRequirements)
  if (lowered === 'Transferred') return lowered
  const loweredType = lowered === undefined ? undefined : fn.localTypes.at(lowered.result.ordinal)
  if (lowered === undefined || loweredType === undefined) return undefined
  if (loweredType._tag === 'EffectComposite')
    return lowerRunEffectComposite(
      fn,
      lowered.result,
      loweredType,
      success,
      span,
      availableRequirements,
    )
  if (loweredType._tag !== 'EffectValue') return undefined
  return lowerRunEffectValue(fn, lowered.result, loweredType, success, span, availableRequirements)
}

/**
 * Redirects one bound operator to the provider's own function when specialization lands on a type
 * whose conformance maps the operation to source rather than to a sealed intrinsic.
 *
 * Operator syntax lowers values through the compiler-known scalar shape, while the bound records
 * the ordinary interface contract the operator spells. A source witness therefore receives each
 * operand exactly as that contract declares it: borrowed operands create call-scoped loans, while
 * value operands remain values. This is contract-directed lowering, not a witness-side adapter.
 */
