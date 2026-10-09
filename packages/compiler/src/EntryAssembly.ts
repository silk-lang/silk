import * as EffectExecutionContract from './internal/EffectExecutionContract.js'
import * as Data from 'effect/Data'
import * as ConformanceProof from './ConformanceProof.js'
import { generated, indexExits, initializationFlagsOf } from './CleanupEmission.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type { LoweredExpression } from './EffectLowering.js'
import { lowerEffectCatch, lowerRunEffectComposite, lowerRunEffectValue } from './EffectLowering.js'
import type {} from './Forwarding.js'
import { FunctionLowering, type LoweringFailure } from './FunctionLowering.js'
import type * as SemanticContext from './SemanticContext.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as TypeInference from './internal/TypeInference.js'
import type * as Layout from './Layout.js'
import type { ExecutableEffectType, ProvidedRequirement } from './Lower.js'
import { i32, local, mirType, patternKey } from './Lower.js'
import type {} from './LowerExpression.js'
import { lowerExpressionInner } from './LowerExpression.js'
import { lowerSequence } from './LowerStatements.js'
import * as Mir from './Mir.js'
import type * as OpaqueRealization from './OpaqueRealization.js'
import type * as Ownership from './Ownership.js'
import * as RowAlgebra from './RowAlgebra.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

import type {
  GeneratedBlockEffectRunner,
  GeneratedBuiltinEffectRunner,
  GeneratedCatchEffectRunner,
  GeneratedEffectRunner,
  GeneratedWitnessEffectRunner,
} from './ValueType.js'
import {
  callableValueByIdentity,
  resultCallableValueType,
  effectValueByIdentity,
  effectValueType,
  returnedEffectValueType,
  instanceText,
  providedContractEntry,
  representedValueType,
  storedCallableValueType,
  storedEffectValueType,
} from './ValueType.js'
import type { WitnessArguments } from './WitnessLowering.js'
import {
  endWitnessReborrows,
  sourceWitnessArguments,
  witnessEffectContract,
} from './WitnessLowering.js'

/** Preserves only genuine authored input headers, including inputs captured by a real runner. */
const sourceParametersOf = (
  lowering: FunctionLowering,
): NonNullable<Mir.MirFunction['sourceParameters']> =>
  lowering.owner.function.declaration.parameters
    .filter((parameter) => parameter.phase === 'Runtime')
    .flatMap((parameter, runtimeOrdinal) => {
      const physical = lowering.parameterLocals.get(parameter.id.ordinal)
      const selected = lowering.owner.specialization.parameters.at(runtimeOrdinal)
      if (physical === undefined || selected === undefined || parameter.captureAccess !== undefined)
        return []
      const descriptor = lowering.localTypes.at(physical.ordinal)
      if (descriptor === undefined) return []
      // The existing hidden-identity realization selected this complete actual header.
      // Its authored promise alone cannot certify original stored callable inputs.
      const contract = Type.isRepresented(selected) ? selected.contract : selected
      return [
        {
          local: physical,
          parameter: parameter.id.ordinal,
          source: parameter.anchor,
          contract,
          type: Mir.semanticType(descriptor),
        },
      ]
    })

/** An authored callable has source identity even when its signature needs no lifetime annotation. */
const sourceOwnerOf = (lowering: FunctionLowering): Pick<Mir.MirFunction, 'sourceOwner'> => {
  const declaration = lowering.owner.function.declaration
  const canonical = declaration.canonical
  const owner =
    declaration.lifetimeElaboration?.owner ??
    (canonical._tag === 'Canonical' ? canonical.id : undefined)
  return owner === undefined ? {} : { sourceOwner: owner }
}

const publishRunnerSuccess = (
  fn: FunctionLowering,
  id: Mir.RegionId,
  operations: ReadonlyArray<Mir.Operation>,
  success: LoweredExpression,
  type: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }>,
  span: SourceSpan.SourceSpan,
): void => {
  if (success === 'Transferred') {
    fn.publish({
      _tag: 'OperationRegion',
      id,
      operations,
      outcome: {
        _tag: 'Trap',
        reason: 'unreachable runner continuation',
        provenance: generated(span),
      },
    })
    return
  }
  const destination = fn.alloc(type)
  fn.publish({
    _tag: 'OperationRegion',
    id,
    operations: [
      ...operations,
      {
        _tag: 'PackEffectOutcome' as const,
        destination,
        source: success.result,
        tag: 0,
        type,
        provenance: generated(span),
      },
    ],
    outcome: { _tag: 'Return', value: destination, provenance: generated(span) },
  })
}

const runtimeParameterCount = (fn: Tir.TirFunction): number =>
  fn.declaration.parameters.filter((parameter) => parameter.phase === 'Runtime').length

/**
 * A reachable instance whose valid body native lowering does not support yet. Lowering never
 * substitutes a trap stub: the program diagnoses it when emitted code references it.
 */
export interface UnsupportedFunction {
  readonly _tag: 'UnsupportedFunction'
  readonly instance: Instances.InstanceKey
  readonly span: SourceSpan.SourceSpan
}

const unsupportedFunction = (
  instance: Instances.Instance,
  span: SourceSpan.SourceSpan,
): UnsupportedFunction => ({ _tag: 'UnsupportedFunction', instance: instance.key, span })

export interface LoweredGeneratedEffectRunner {
  readonly _tag: 'LoweredGeneratedEffectRunner'
  readonly runner: Mir.MirFunction
}

export interface UnavailableGeneratedEffectRunner {
  readonly _tag: 'UnavailableGeneratedEffectRunner'
  readonly runner: DeclarationFacts.CanonicalId
  readonly base: DeclarationFacts.CanonicalId
  readonly owner: Instances.InstanceKey
  readonly cause: LoweringFailure
}

export type GeneratedEffectRunnerLowering =
  | LoweredGeneratedEffectRunner
  | UnavailableGeneratedEffectRunner

export const unavailableGeneratedEffectRunner = (
  failure: Omit<UnavailableGeneratedEffectRunner, '_tag'>,
): UnavailableGeneratedEffectRunner => ({ _tag: 'UnavailableGeneratedEffectRunner', ...failure })

export const generatedEffectRunnerKey = (
  runner: DeclarationFacts.CanonicalId,
  owner: Instances.InstanceKey,
): string => instanceText(runner, owner.typeArguments, owner.staticArguments)

/** Selects the first failed producer outcome that survived generated-runner reachability pruning. */
export const unavailableReferencedEffectRunner = (
  outcomes: ReadonlyArray<UnavailableGeneratedEffectRunner>,
  retainedRunnerKeys: ReadonlySet<string>,
): UnavailableGeneratedEffectRunner | undefined =>
  outcomes.find((outcome) =>
    retainedRunnerKeys.has(generatedEffectRunnerKey(outcome.runner, outcome.owner)),
  )

export class GeneratedEffectRunnerLoweringError extends Data.TaggedError(
  'GeneratedEffectRunnerLoweringError',
)<{
  readonly failure: UnavailableGeneratedEffectRunner
  readonly message: string
}> {}

export const requireGeneratedEffectRunner = (
  outcome: GeneratedEffectRunnerLowering,
): Mir.MirFunction => {
  if (outcome._tag === 'UnavailableGeneratedEffectRunner')
    throw new GeneratedEffectRunnerLoweringError({
      failure: outcome,
      message: `Generated Effect runner ${outcome.runner.module}:${outcome.runner.name} failed to lower ${outcome.cause.boundary.toLowerCase()} ${outcome.cause.construct}${outcome.cause.reason === undefined ? '' : ` (${outcome.cause.reason._tag})`} at ${outcome.cause.provenance.span.sourceId}:${outcome.cause.provenance.span.start}-${outcome.cause.provenance.span.end}`,
    })
  return outcome.runner
}

const unavailableEffectRunner = (
  spec: GeneratedBlockEffectRunner,
  cause: LoweringFailure,
): UnavailableGeneratedEffectRunner =>
  unavailableGeneratedEffectRunner({
    runner: spec.id,
    base: Tir.effectRunnerId(spec.type.environment.instance.declaration, spec.type.site),
    owner: spec.owner.key,
    cause,
  })

const runnerFallback = (spec: GeneratedBlockEffectRunner): LoweringFailure => ({
  boundary: 'Expression',
  construct: 'EffectBlock',
  provenance: { span: spec.block.span, generated: false },
})

export const planFor = (
  ownership: Ownership.ModuleOwnership | undefined,
  fn: Tir.TirFunction,
): Ownership.FunctionOwnership | undefined =>
  ownership?.functions.find(
    (candidate) => candidate.declaration.id.ordinal === fn.declaration.id.ordinal,
  )

export const bodySpan = (
  fn: Tir.TirFunction,
  registry: SemanticContext.Registry,
): SourceSpan.SourceSpan => fn.statements.at(-1)?.span ?? registry.spanOf(fn.declaration.anchor)

export const returnedEffectBlock = (
  fn: Tir.TirFunction,
): Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }> | undefined => {
  const terminal = fn.statements.at(-1)
  if (terminal?._tag !== 'Return') return undefined
  const returned = terminal.expression
  if (returned._tag === 'EffectBlock') return returned
  if (returned._tag !== 'BindingReference') return undefined
  const binding = fn.statements.find(
    (statement): statement is Extract<Tir.Statement, { readonly _tag: 'Bind' }> =>
      statement._tag === 'Bind' && statement.binding.ordinal === returned.binding.ordinal,
  )
  return binding?.initializer._tag === 'EffectBlock' ? binding.initializer : undefined
}

/** Reads the one represented result shared by all reachable enclosing return sites. */
export const returnedValueType = (
  layout: Layout.Plan,
  opaqueRealizations: OpaqueRealization.Catalog,
  fn: Tir.TirFunction,
  substitution: Type.Substitution,
): ReturnType<typeof representedValueType> => {
  const returned = Tir.returnExpressions(fn.statements).flatMap((expression) =>
    expression._tag === 'Unavailable' || Type.isNever(expression.type)
      ? []
      : [Type.substitute(expression.type, substitution)],
  )
  const first = returned.at(0)
  return first === undefined || !returned.every((type) => Type.equals(type, first))
    ? undefined
    : representedValueType(layout, opaqueRealizations, first, new Map())
}

export const lowerInstance = (
  instance: Instances.Instance,
  ownership: Ownership.ModuleOwnership | undefined,
  layout: Layout.Plan,
  index: DeclarationIndex.Index,
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
  effectResults: ReadonlyMap<string, ExecutableEffectType>,
  generatedRunners: Array<GeneratedEffectRunner>,
  opaqueRealizations: OpaqueRealization.Catalog,
  registry: SemanticContext.Registry,
): Mir.MirFunction | UnsupportedFunction => {
  const fn = instance.function
  const plan = planFor(ownership, fn)

  // Every violating ownership plan is published as an OWN diagnostic, and realization lowers MIR
  // only for programs without diagnostics, so a violating plan cannot reach this point.
  if (plan !== undefined && plan.verdict._tag === 'Violation')
    throw new RangeError(
      `Ownership violation reached MIR lowering for ${instance.key.declaration.module}:${instance.key.declaration.name}`,
    )

  const contract = fn.contract
  const callableEnvironment = Tir.isAnonymousCallableId(instance.key.declaration)
    ? layout.callableEnvironments.find(
        (
          candidate,
        ): candidate is Extract<
          Layout.CallableEnvironment,
          { readonly _tag: 'CallableEnvironment' }
        > =>
          candidate._tag === 'CallableEnvironment' &&
          candidate.callable.target._tag === 'DeclarationCallableTarget' &&
          candidate.callable.target.declaration.module === instance.key.declaration.module &&
          candidate.callable.target.declaration.name === instance.key.declaration.name &&
          candidate.callable.typeArguments.length === instance.key.typeArguments.length &&
          candidate.callable.typeArguments.every((argument, ordinal) => {
            const instanceArgument = instance.key.typeArguments.at(ordinal)
            return (
              instanceArgument !== undefined &&
              Type.equalsGenericArgument(argument, instanceArgument)
            )
          }),
      )
    : undefined
  let parameterTypes: Mir.Type[]
  if (contract._tag === 'Contract') {
    parameterTypes = instance.specialization.parameters.flatMap((specialized, ordinal) => {
      const borrowedCapture = callableEnvironment?.fields.find(
        (field) => field.parameterOrdinal === ordinal && field.representation === 'Borrow',
      )
      if (
        borrowedCapture !== undefined &&
        (borrowedCapture.access === 'Shared' || borrowedCapture.access === 'Exclusive')
      ) {
        return [
          {
            _tag: 'EnvironmentBorrow' as const,
            type: borrowedCapture.type,
            access: borrowedCapture.access,
          },
        ]
      }
      const type = contract.parameters.at(ordinal) ?? specialized
      const representedEffect =
        Type.isRepresented(specialized) &&
        Type.isEffect(specialized.contract) &&
        Type.isExactRepresentationArgument(specialized.representation.argument) &&
        Type.isEffectIdentityArgument(specialized.representation.argument.identity)
      if (Type.isEffect(specialized) || representedEffect) {
        const representation = Instances.parameterEffectRepresentationArgument(
          fn,
          instance.key,
          ordinal,
        )
        if (
          Type.isEffect(specialized) &&
          representation !== undefined &&
          Type.isCompositeEffectRepresentationArgument(representation)
        ) {
          const composite = representedValueType(
            layout,
            opaqueRealizations,
            Type.represented(specialized, specialized, representation),
            instance.substitution,
          )
          if (composite !== undefined) return [composite]
        }
        const identity =
          representation !== undefined && Type.isEffectIdentityArgument(representation)
            ? representation.identity
            : undefined
        const effectValue =
          identity === undefined
            ? undefined
            : effectValueByIdentity(layout, identity, EffectExecutionContract.fromType(specialized))
        if (effectValue !== undefined) return [effectValue]
        // A constructor's captured parameter may already be a provided implementation. Its
        // physical capture contract is published by layout under this exact owner and ordinal.
        const captures = layout.effectEnvironments.flatMap((environment) =>
          environment._tag === 'EffectEnvironment' &&
          Instances.keyText(environment.instance) === Instances.keyText(instance.key)
            ? environment.fields.filter(
                (field) =>
                  field.source === 'Parameter' &&
                  field.ordinal === ordinal &&
                  field.effectIdentity === identity,
              )
            : [],
        )
        const capture = captures.at(0)
        if (
          capture !== undefined &&
          Type.isEffect(capture.type) &&
          captures.every((field) => Type.equals(field.type, capture.type))
        ) {
          const captured = effectCaptureValue(capture, layout)
          if (captured !== undefined) return [captured]
        }
        if (Type.isEffect(specialized)) return []
      }
      if (
        Type.isRepresented(specialized) &&
        Type.isCallable(specialized.contract) &&
        Type.isExactRepresentationArgument(specialized.representation.argument) &&
        Type.isCallableIdentityArgument(specialized.representation.argument.identity)
      ) {
        const callable = callableValueByIdentity(
          layout,
          specialized.representation.argument.identity,
          specialized.contract,
        )
        return callable === undefined ? [] : [callable]
      }
      if (Type.isCallable(specialized)) {
        const identity = Instances.parameterCallableIdentity(fn, instance.key, ordinal)
        const callable =
          identity === undefined
            ? undefined
            : callableValueByIdentity(layout, identity, specialized)
        return callable === undefined ? [] : [callable]
      }
      const lowered =
        storedCallableValueType(layout, specialized) ??
        storedEffectValueType(layout, specialized) ??
        representedValueType(layout, opaqueRealizations, type, instance.substitution) ??
        mirType(type, instance.substitution, layout)
      return lowered === undefined ? [] : [lowered]
    })
  } else {
    parameterTypes = Array.from({ length: runtimeParameterCount(fn) }, () => i32)
  }
  const effectOutcome =
    contract._tag === 'Contract' && contract.functionKind === 'Effect'
      ? Type.effectWithRows(
          instance.specialization.result,
          instance.specialization.failureRow ?? RowAlgebra.concrete(Type.failureRowPolicy(), []),
          {
            ...DeclarationFacts.effectLifetimes(fn.declaration),
            environment: Type.substituteLifetime(
              DeclarationFacts.executableLifetimes(fn.declaration).environment,
              instance.substitution,
            ),
          },
          'Shared',
          instance.specialization.requirementRow ??
            RowAlgebra.concrete(Type.requirementRowPolicy(), []),
        )
      : undefined
  const resultEffectType =
    effectOutcome ??
    (contract._tag === 'Contract' && Type.isEffect(instance.specialization.result)
      ? instance.specialization.result
      : undefined)
  const returnedBlock = contract._tag === 'Contract' ? returnedEffectBlock(fn) : undefined
  let hiddenEffectValue: Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined
  if (returnedBlock !== undefined && resultEffectType !== undefined) {
    if (contract._tag === 'Contract' && contract.functionKind !== 'Effect')
      hiddenEffectValue = returnedEffectValueType(layout, instance, returnedBlock)
    else hiddenEffectValue = effectValueType(layout, instance.key, returnedBlock, resultEffectType)
  }
  const hiddenCompositeResult = returnedValueType(
    layout,
    opaqueRealizations,
    fn,
    instance.substitution,
  )
  const specializedEffectValue =
    instance.resultEffect === undefined
      ? undefined
      : effectValueByIdentity(layout, instance.resultEffect, resultEffectType)
  const resultType =
    specializedEffectValue ??
    hiddenEffectValue ??
    hiddenCompositeResult ??
    (contract._tag === 'Contract'
      ? (storedCallableValueType(layout, resultEffectType ?? instance.specialization.result) ??
        storedEffectValueType(layout, resultEffectType ?? instance.specialization.result) ??
        representedValueType(
          layout,
          opaqueRealizations,
          resultEffectType ?? instance.specialization.result,
          new Map(),
        ) ??
        mirType(resultEffectType ?? instance.specialization.result, new Map(), layout) ??
        resultCallableValueType(
          layout,
          instances,
          instance.key.declaration,
          instance.key.typeArguments,
          instance.specialization.result,
        ))
      : i32)
  // Target layout realizes every reachable instance's specialized result type before lowering, and
  // its representation fences reject the types it cannot serve; no known program reaches this.
  if (resultType === undefined)
    throw new RangeError(
      `Result type of ${instance.key.declaration.module}:${instance.key.declaration.name} has no MIR representation after layout`,
    )

  const lowering = new FunctionLowering(
    layout,
    index,
    registry,
    parameterTypes,
    plan,
    instance.substitution,
    effectOutcome,
    instance,
    instances,
    calls,
    effectResults,
    generatedRunners,
    opaqueRealizations,
  )
  lowering.parameterLocals.clear()
  fn.declaration.parameters
    .filter((parameter) => parameter.phase === 'Runtime')
    .forEach((parameter, ordinal) => {
      lowering.parameterLocals.set(parameter.id.ordinal, local(ordinal))
    })
  const terminal: Mir.Outcome = {
    _tag: 'Trap',
    reason: 'body fell through without return',
    provenance: generated(bodySpan(fn, registry)),
  }
  const entry = lowerSequence(lowering, fn.statements, indexExits(plan), undefined, terminal)

  if (
    entry === undefined ||
    lowering.regions.some(
      (region, ordinal) => region === undefined && !lowering.extractedRegions.has(ordinal),
    )
  ) {
    const unavailable = Tir.firstUnavailable(fn)
    return unsupportedFunction(instance, unavailable?.span ?? bodySpan(fn, registry))
  }

  return {
    _tag: 'MirFunction',
    ...(fn.declaration.lifetimeElaboration?.invocationUse === undefined
      ? {}
      : {
          sourceInvocationUse: DeclarationFacts.executableLifetimes(fn.declaration).invocationUse,
        }),
    sourceParameters: sourceParametersOf(lowering),
    ...sourceOwnerOf(lowering),
    id: instance.key.declaration,
    instance: instance.key,
    ...(fn.declaration.machine === undefined ? {} : { machine: fn.declaration.machine }),
    parameterCount: runtimeParameterCount(fn),
    localTypes: [...lowering.localTypes],
    initializationFlags: initializationFlagsOf(lowering),
    result: resultType,
    entry,
    regions: lowering.regions.flatMap((region) => (region === undefined ? [] : [region])),
  }
}

const effectCaptureValue = (
  field: Layout.EffectEnvironmentField,
  layout: Layout.Plan,
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  const identity = field.resolvedEffectIdentity ?? field.effectIdentity
  if (identity === undefined) return undefined
  const ordinary = effectValueByIdentity(
    layout,
    identity,
    EffectExecutionContract.fromType(field.type),
  )
  const inputView = field.inputView
  if (inputView === undefined) return ordinary
  if (
    !Type.isEffect(field.type) ||
    !Type.isEffect(inputView.view.actual) ||
    !Type.isEffect(inputView.view.expected) ||
    !Type.equals({ ...inputView.view.expected, access: field.type.access }, field.type)
  )
    return undefined
  const actual = effectValueByIdentity(layout, identity, inputView.view.actual)
  return actual === undefined ? undefined : { ...actual, type: field.type, inputView }
}

const effectCaptureParameterTypes = (
  fields: ReadonlyArray<Layout.EffectEnvironmentField>,
  layout: Layout.Plan,
  opaqueRealizations: OpaqueRealization.Catalog,
): ReadonlyArray<Mir.Type> =>
  fields.flatMap((field) => {
    if (field.effectIdentity !== undefined) {
      const checked = effectCaptureValue(field, layout)
      if (checked !== undefined) return [checked]
      const resolvedEffectValue =
        field.resolvedEffectIdentity === undefined
          ? undefined
          : effectValueByIdentity(
              layout,
              field.resolvedEffectIdentity,
              EffectExecutionContract.fromType(field.type),
            )
      const effectValue =
        resolvedEffectValue ??
        effectValueByIdentity(
          layout,
          field.effectIdentity,
          EffectExecutionContract.fromType(field.type),
        )
      return effectValue === undefined ? [] : [effectValue]
    }
    if (field.callableIdentity !== undefined && Type.isCallable(field.type)) {
      const callable = callableValueByIdentity(layout, field.callableIdentity, field.type)
      if (callable === undefined) return []
      if (field.inputView === undefined) return [callable]
      const selected = field.inputView.view.invocationSource?.selected
      if (selected === undefined || !Type.equals(selected, field.type)) return []
      return [{ ...callable, type: selected, inputView: field.inputView }]
    }
    if (Type.isRepresented(field.type)) {
      const represented = representedValueType(layout, opaqueRealizations, field.type, new Map())
      return represented === undefined ? [] : [represented]
    }
    // The layout resolves scalar-enum nominals to their Enum representation; without it a
    // captured enum lowers as a bare Nominal and every enum operation in the runner body fails.
    const lowered = mirType(field.type, new Map(), layout)
    if (lowered === undefined) return []
    if (field.representation === 'Value') return [lowered]
    if (field.access !== 'Shared' && field.access !== 'Exclusive') return []
    return [
      {
        _tag: 'EnvironmentBorrow' as const,
        type: field.type,
        access: field.access,
      },
    ]
  })

// Generated runners share one physical body across callers whose proven providers differ only in
// proof-only lifetimes. The body was checked in its owner instance, so it lowers against the
// owner's own selection of each source provider; the runner's provider contract keeps the
// caller's proof, which matches it at runtime. A provider the owner selected without a witness
// for this capability is a lowering failure, never a fallback to the caller's selection.
const ownerRequirement = (
  index: DeclarationIndex.Index,
  calls: ReadonlyArray<Instances.CallInstance>,
  owner: Instances.InstanceKey,
  requirement: ProvidedRequirement,
): ProvidedRequirement | undefined => {
  if (requirement.witness._tag !== 'SourceConformanceWitness') return requirement
  const ownerKey = Instances.keyText(owner)
  const runtimeProvider = Type.runtimeKey(requirement.providerType)
  const selected = calls
    .filter((call) => Instances.keyText(call.owner) === ownerKey)
    .flatMap((call) => call.providers ?? [])
    .find(
      (provider) =>
        provider.role === requirement.role &&
        Type.equals(provider.capability, requirement.capability) &&
        Type.runtimeKey(provider.providerType) === runtimeProvider,
    )
  if (selected === undefined || Type.equals(selected.providerType, requirement.providerType))
    return requirement
  const witness = ConformanceProof.witness(index, selected.providerType, requirement.capability)
  return witness?._tag === 'SourceConformanceWitness'
    ? { ...requirement, providerType: selected.providerType, witness }
    : undefined
}

/** Rebinds every provider to the runner owner, or reports that one has no witness there. */
const ownerRequirements = (
  index: DeclarationIndex.Index,
  calls: ReadonlyArray<Instances.CallInstance>,
  owner: Instances.InstanceKey,
  requirements: ReadonlyArray<ProvidedRequirement>,
): ReadonlyArray<ProvidedRequirement> | undefined => {
  const owned = requirements.map((requirement) =>
    ownerRequirement(index, calls, owner, requirement),
  )
  return owned.every((requirement) => requirement !== undefined)
    ? owned.flatMap((requirement) => (requirement === undefined ? [] : [requirement]))
    : undefined
}

export const lowerEffectRunner = (
  spec: GeneratedBlockEffectRunner,
  ownership: Ownership.ModuleOwnership | undefined,
  layout: Layout.Plan,
  index: DeclarationIndex.Index,
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
  effectResults: ReadonlyMap<string, ExecutableEffectType>,
  generatedRunners: Array<GeneratedEffectRunner>,
  opaqueRealizations: OpaqueRealization.Catalog,
  registry: SemanticContext.Registry,
): GeneratedEffectRunnerLowering => {
  const { owner, block, type } = spec
  const id = spec.id
  const instance: Instances.InstanceKey = {
    _tag: 'InstanceKey',
    declaration: id,
    typeArguments: owner.key.typeArguments,
    evidence: owner.key.evidence,
    staticArguments: owner.key.staticArguments,
    contractRow: [
      ...owner.key.contractRow,
      `effect-site:${Tir.executableSiteKey(block.site)}`,
      ...spec.providedRequirements.map(providedContractEntry),
    ],
  }
  const captureParameterTypes = effectCaptureParameterTypes(
    type.environment.fields,
    layout,
    opaqueRealizations,
  )
  if (captureParameterTypes.length !== block.captures.length)
    return unavailableEffectRunner(spec, runnerFallback(spec))
  const owned = ownerRequirements(index, calls, spec.owner.key, spec.providedRequirements)
  if (owned === undefined)
    return unavailableEffectRunner(spec, {
      boundary: 'Expression',
      construct: 'EffectBlock',
      provenance: { span: spec.block.span, generated: false },
      reason: { _tag: 'OwnerProviderWitness' },
    })
  const parameterizedRequirements = owned.filter(
    (requirement) => requirement.witness._tag === 'SourceConformanceWitness',
  )
  const requirementParameterTypes = parameterizedRequirements.flatMap((requirement) => {
    const type = mirType({
      _tag: 'ReferenceType' as const,
      access: requirement.access === 'Take' ? ('Exclusive' as const) : requirement.access,
      target: requirement.providerType,
      lifetime: spec.type.type.environment,
    })
    return type === undefined ? [] : [type]
  })
  if (requirementParameterTypes.length !== parameterizedRequirements.length)
    return unavailableEffectRunner(spec, runnerFallback(spec))
  const parameterTypes = [...captureParameterTypes, ...requirementParameterTypes]
  const plan = planFor(ownership, owner.function)
  const lowering = new FunctionLowering(
    layout,
    index,
    registry,
    parameterTypes,
    plan,
    owner.substitution,
    type.type,
    owner,
    instances,
    calls,
    effectResults,
    generatedRunners,
    opaqueRealizations,
    owned.map((requirement) => {
      const ordinal = parameterizedRequirements.indexOf(requirement)
      return {
        ...requirement,
        ...(ordinal < 0 ? {} : { local: local(captureParameterTypes.length + ordinal) }),
      }
    }),
    spec.witnessTargets,
  )
  lowering.parameterLocals.clear()
  block.captures.forEach((capture, ordinal) => {
    const captureLocal = local(ordinal)
    if (capture.binding !== undefined)
      lowering.bindingLocals.set(capture.binding.ordinal, captureLocal)
    if (capture.parameter !== undefined)
      lowering.parameterLocals.set(capture.parameter.ordinal, captureLocal)
    if (capture.pattern !== undefined)
      lowering.patternLocals.set(patternKey(capture.pattern), captureLocal)
  })
  const terminal: Mir.Outcome = {
    _tag: 'Trap',
    reason: 'effect body fell through without return',
    provenance: generated(block.span),
  }
  const entry = lowerSequence(lowering, block.statements, indexExits(plan), undefined, terminal)
  if (
    entry === undefined ||
    lowering.regions.some(
      (region, ordinal) => region === undefined && !lowering.extractedRegions.has(ordinal),
    )
  )
    return unavailableEffectRunner(spec, lowering.loweringFailure ?? runnerFallback(spec))
  const result: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
    _tag: 'EffectOutcome',
    type: type.type,
  }
  return {
    _tag: 'LoweredGeneratedEffectRunner',
    runner: {
      _tag: 'MirFunction',
      sourceParameters: sourceParametersOf(lowering),
      ...sourceOwnerOf(lowering),
      id,
      instance,
      parameterCount: parameterTypes.length,
      localTypes: [...lowering.localTypes],
      initializationFlags: initializationFlagsOf(lowering),
      result,
      entry,
      regions: lowering.regions.flatMap((region) => (region === undefined ? [] : [region])),
      effectRunner: {
        base: {
          declaration: Tir.effectRunnerId(type.environment.instance.declaration, type.site),
          typeArguments: type.environment.instance.typeArguments,
        },
        providers: spec.providedRequirements.map((requirement) => ({
          capability: requirement.capability,
          providerType: requirement.providerType,
          witness: requirement.witness,
          role: requirement.role,
          requirementAccess: requirement.requirementAccess,
          access: requirement.access,
        })),
      },
    },
  }
}

export const lowerCatchEffectRunner = (
  spec: GeneratedCatchEffectRunner,
  ownership: Ownership.ModuleOwnership | undefined,
  layout: Layout.Plan,
  index: DeclarationIndex.Index,
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
  effectResults: ReadonlyMap<string, ExecutableEffectType>,
  generatedRunners: Array<GeneratedEffectRunner>,
  opaqueRealizations: OpaqueRealization.Catalog,
  registry: SemanticContext.Registry,
): Mir.MirFunction | undefined => {
  const owned = ownerRequirements(index, calls, spec.owner.key, spec.providedRequirements)
  if (owned === undefined)
    return undefined
  const parameterizedRequirements = owned.filter(
    (requirement) => requirement.witness._tag === 'SourceConformanceWitness',
  )
  const requirementParameterTypes = parameterizedRequirements.flatMap((requirement) => {
    const type = mirType(
      Type.reference(
        requirement.access === 'Take' ? ('Exclusive' as const) : requirement.access,
        requirement.providerType,
        spec.type.type.environment,
      ),
    )
    return type === undefined ? [] : [type]
  })
  if (requirementParameterTypes.length !== parameterizedRequirements.length) return undefined
  const captureParameterTypes = [spec.protectedType, spec.handlerType]
  const parameterTypes = [...captureParameterTypes, ...requirementParameterTypes]
  const instance: Instances.InstanceKey = {
    _tag: 'InstanceKey',
    declaration: spec.id,
    typeArguments: spec.owner.key.typeArguments,
    evidence: spec.owner.key.evidence,
    staticArguments: spec.owner.key.staticArguments,
    contractRow: [
      ...spec.owner.key.contractRow,
      `effect-site:${Tir.executableSiteKey(spec.type.site)}`,
      ...spec.providedRequirements.map(providedContractEntry),
    ],
  }
  const lowering = new FunctionLowering(
    layout,
    index,
    registry,
    parameterTypes,
    planFor(ownership, spec.owner.function),
    spec.owner.substitution,
    spec.type.type,
    spec.owner,
    instances,
    calls,
    effectResults,
    generatedRunners,
    opaqueRealizations,
    owned.map((requirement) => {
      const ordinal = parameterizedRequirements.indexOf(requirement)
      return {
        ...requirement,
        ...(ordinal < 0 ? {} : { local: local(captureParameterTypes.length + ordinal) }),
      }
    }),
  )
  const producer = Tir.nodeReference(spec.owner.view.artifact, spec.expression)
  lowering.incomingCallables.set(1, producer)
  const region = lowering.reserve()
  const [success, operations] = lowering.capture(() =>
    lowerEffectCatch(lowering, spec.expression, spec.expression.span, {
      protected: local(0),
      protectedType: spec.protectedType,
      handler: local(1),
      handlerType: spec.handlerType,
    }),
  )
  const result: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
    _tag: 'EffectOutcome',
    type: spec.type.type,
  }
  if (success === undefined) return undefined
  publishRunnerSuccess(lowering, region, operations, success, result, spec.expression.span)
  return {
    _tag: 'MirFunction',
    sourceParameters: sourceParametersOf(lowering),
    sourceCallableCaptures: [{ local: local(1), producer }],
    ...sourceOwnerOf(lowering),
    id: spec.id,
    instance,
    parameterCount: parameterTypes.length,
    localTypes: [...lowering.localTypes],
    initializationFlags: initializationFlagsOf(lowering),
    result,
    entry: region,
    regions: lowering.regions.flatMap((candidate) => (candidate === undefined ? [] : [candidate])),
    effectRunner: {
      base: {
        declaration: Tir.effectRunnerId(spec.type.environment.instance.declaration, spec.type.site),
        typeArguments: spec.type.environment.instance.typeArguments,
      },
      providers: spec.providedRequirements.map((requirement) => ({
        capability: requirement.capability,
        providerType: requirement.providerType,
        witness: requirement.witness,
        role: requirement.role,
        requirementAccess: requirement.requirementAccess,
        access: requirement.access,
      })),
    },
  }
}

export const lowerBuiltinEffectRunner = (
  spec: GeneratedBuiltinEffectRunner,
  ownership: Ownership.ModuleOwnership | undefined,
  layout: Layout.Plan,
  index: DeclarationIndex.Index,
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
  effectResults: ReadonlyMap<string, ExecutableEffectType>,
  generatedRunners: Array<GeneratedEffectRunner>,
  opaqueRealizations: OpaqueRealization.Catalog,
  registry: SemanticContext.Registry,
): Mir.MirFunction | undefined => {
  const parameterTypes = effectCaptureParameterTypes(
    spec.type.environment.fields,
    layout,
    opaqueRealizations,
  )
  if (parameterTypes.length !== spec.expression.arguments.length) return undefined
  const owned = ownerRequirements(index, calls, spec.owner.key, spec.providedRequirements)
  if (owned === undefined)
    return undefined
  const parameterizedRequirements = owned.filter(
    (requirement) => requirement.witness._tag === 'SourceConformanceWitness',
  )
  const requirementParameterTypes = parameterizedRequirements.flatMap((requirement) => {
    const type = mirType(
      Type.reference(
        requirement.access === 'Take' ? ('Exclusive' as const) : requirement.access,
        requirement.providerType,
        spec.type.type.environment,
      ),
    )
    return type === undefined ? [] : [type]
  })
  if (requirementParameterTypes.length !== parameterizedRequirements.length) return undefined
  const allParameters = [...parameterTypes, ...requirementParameterTypes]
  const instance: Instances.InstanceKey = {
    _tag: 'InstanceKey',
    declaration: spec.id,
    typeArguments: spec.owner.key.typeArguments,
    evidence: spec.owner.key.evidence,
    staticArguments: spec.owner.key.staticArguments,
    contractRow: [
      ...spec.owner.key.contractRow,
      `builtin-effect-site:${Tir.executableSiteKey(spec.type.site)}`,
    ],
  }
  const lowering = new FunctionLowering(
    layout,
    index,
    registry,
    allParameters,
    planFor(ownership, spec.owner.function),
    spec.owner.substitution,
    spec.type.type,
    spec.owner,
    instances,
    calls,
    effectResults,
    generatedRunners,
    opaqueRealizations,
    owned.map((requirement) => {
      const ordinal = parameterizedRequirements.indexOf(requirement)
      return {
        ...requirement,
        ...(ordinal < 0 ? {} : { local: local(parameterTypes.length + ordinal) }),
      }
    }),
  )
  lowering.builtinEffectRunner = true
  const region = lowering.reserve()
  const [success, operations] = lowering.capture(() =>
    lowerExpressionInner(lowering, {
      _tag: 'Run',
      subject: {
        ...spec.expression,
        arguments: spec.expression.arguments.map((argument, ordinal) => ({
          _tag: 'ParameterReference' as const,
          parameter: {
            _tag: 'TirLocal' as const,
            ordinal,
          },
          type: argument._tag === 'Unavailable' ? ('never' as const) : argument.type,
          span: argument.span,
          origin: argument.origin,
        })),
      },
      type: spec.type.type.success,
      span: spec.expression.span,
      origin: spec.expression.origin,
    }),
  )
  if (success === undefined) return undefined
  const result: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
    _tag: 'EffectOutcome',
    type: spec.type.type,
  }
  publishRunnerSuccess(lowering, region, operations, success, result, spec.expression.span)
  return {
    _tag: 'MirFunction',
    sourceParameters: sourceParametersOf(lowering),
    ...sourceOwnerOf(lowering),
    id: spec.id,
    instance,
    parameterCount: allParameters.length,
    localTypes: [...lowering.localTypes],
    initializationFlags: initializationFlagsOf(lowering),
    result,
    entry: region,
    regions: lowering.regions.flatMap((candidate) => (candidate === undefined ? [] : [candidate])),
    effectRunner: {
      base: {
        declaration: Tir.effectRunnerId(spec.type.environment.instance.declaration, spec.type.site),
        typeArguments: spec.type.environment.instance.typeArguments,
      },
      providers: spec.providedRequirements.map((requirement) => ({
        capability: requirement.capability,
        providerType: requirement.providerType,
        witness: requirement.witness,
        role: requirement.role,
        requirementAccess: requirement.requirementAccess,
        access: requirement.access,
      })),
    },
  }
}

export const lowerWitnessEffectRunner = (
  spec: GeneratedWitnessEffectRunner,
  ownership: Ownership.ModuleOwnership | undefined,
  layout: Layout.Plan,
  index: DeclarationIndex.Index,
  instances: ReadonlyArray<Instances.Instance>,
  calls: ReadonlyArray<Instances.CallInstance>,
  effectResults: ReadonlyMap<string, ExecutableEffectType>,
  generatedRunners: Array<GeneratedEffectRunner>,
  opaqueRealizations: OpaqueRealization.Catalog,
  registry: SemanticContext.Registry,
): Mir.MirFunction | undefined => {
  const parameterTypes = effectCaptureParameterTypes(
    spec.type.environment.fields,
    layout,
    opaqueRealizations,
  )
  if (parameterTypes.length !== spec.type.environment.fields.length) return undefined
  const owned = ownerRequirements(index, calls, spec.owner.key, spec.providedRequirements)
  if (owned === undefined)
    return undefined
  const parameterizedRequirements = owned.filter(
    (requirement) => requirement.witness._tag === 'SourceConformanceWitness',
  )
  const requirementParameterTypes = parameterizedRequirements.flatMap((requirement) => {
    const type = mirType(
      Type.reference(
        requirement.access === 'Take' ? ('Exclusive' as const) : requirement.access,
        requirement.providerType,
        spec.type.type.environment,
      ),
    )
    return type === undefined ? [] : [type]
  })
  if (requirementParameterTypes.length !== parameterizedRequirements.length) return undefined
  const allParameters = [...parameterTypes, ...requirementParameterTypes]
  const instance: Instances.InstanceKey = {
    _tag: 'InstanceKey',
    declaration: spec.id,
    typeArguments: spec.owner.key.typeArguments,
    evidence: spec.owner.key.evidence,
    staticArguments: spec.owner.key.staticArguments,
    contractRow: [
      ...spec.owner.key.contractRow,
      `witness-effect-site:${Tir.executableSiteKey(spec.type.site)}`,
      ...spec.providedRequirements.map(providedContractEntry),
    ],
  }
  const lowering = new FunctionLowering(
    layout,
    index,
    registry,
    allParameters,
    planFor(ownership, spec.owner.function),
    spec.owner.substitution,
    spec.type.type,
    spec.owner,
    instances,
    calls,
    effectResults,
    generatedRunners,
    opaqueRealizations,
    owned.map((requirement) => {
      const ordinal = parameterizedRequirements.indexOf(requirement)
      return {
        ...requirement,
        ...(ordinal < 0 ? {} : { local: local(parameterTypes.length + ordinal) }),
      }
    }),
  )
  const region = lowering.reserve()
  const [returned, operations] = lowering.capture((): Mir.LocalId | 'Transferred' | undefined => {
    let success: LoweredExpression | undefined
    let reborrows: WitnessArguments['reborrows'] = []
    if (spec.target !== undefined) {
      const declaration = DeclarationFacts.byCanonical(index, spec.target.implementation)
      if (declaration?._tag !== 'FunctionDeclaration') return undefined
      const arguments_ = sourceWitnessArguments(
        lowering,
        spec.target,
        parameterTypes.map((_, ordinal) => local(ordinal)),
        Tir.nodeReference(lowering.owner.view.artifact, spec.expression),
        spec.expression.span,
      )
      if (arguments_ === undefined) return undefined
      reborrows = arguments_.reborrows
      if (declaration.functionKind === 'Ordinary') {
        const binders = declaration.typeParameters
          .filter((parameter) => parameter.duplicateOf === undefined)
          .map((parameter) => parameter.type)
        const substitution = TypeInference.substitution(binders, spec.target.typeArguments)
        const result =
          substitution === undefined || declaration.returnType._tag !== 'Resolved'
            ? undefined
            : lowering.type(Type.substitute(declaration.returnType.type, substitution))
        if (result === undefined) return undefined
        const destination = lowering.alloc(result)
        lowering.emit({
          _tag: 'Call',
          destination,
          target: spec.target.implementation,
          typeArguments: spec.target.typeArguments,
          arguments: arguments_.arguments,
          type: result,
          provenance: generated(spec.expression.span),
        })
        success = { result: destination }
      } else {
        const effectType = effectResults.get(
          instanceText(spec.target.implementation, spec.target.typeArguments),
        )
        if (effectType === undefined) return undefined
        const effect = lowering.alloc(effectType)
        lowering.emit({
          _tag: 'Call',
          destination: effect,
          target: spec.target.implementation,
          typeArguments: spec.target.typeArguments,
          arguments: arguments_.arguments,
          type: effectType,
          provenance: generated(spec.expression.span),
        })
        success =
          effectType._tag === 'EffectValue'
            ? lowerRunEffectValue(
                lowering,
                effect,
                effectType,
                spec.type.type.success,
                spec.expression.span,
              )
            : lowerRunEffectComposite(
                lowering,
                effect,
                effectType,
                spec.type.type.success,
                spec.expression.span,
              )
      }
    } else if (spec.intrinsic?.rule._tag === 'BuiltinRule') {
      const contract = witnessEffectContract(spec.expression)
      if (contract === undefined) return undefined
      success = lowerExpressionInner(lowering, {
        _tag: 'BuiltinCall',
        operation: spec.intrinsic.rule.operation,
        intrinsic: spec.intrinsic.id,
        typeArguments: [],
        arguments: contract.operands.map((operand) => ({
          _tag: 'ParameterReference' as const,
          parameter: {
            _tag: 'TirLocal' as const,
            ordinal: operand.parameter.id.ordinal,
          },
          type: operand.type._tag === 'Resolved' ? operand.type.type : 'never',
          span: spec.expression.span,
          origin: spec.expression.origin,
        })),
        loanEnds: [],
        heldLoans: [],
        type: spec.type.type.success,
        span: spec.expression.span,
        origin: spec.expression.origin,
      })
    }
    if (success === 'Transferred') return success
    if (success === undefined) return undefined
    endWitnessReborrows(lowering, reborrows, spec.expression.span)
    const outcome: Extract<Mir.Type, { readonly _tag: 'EffectOutcome' }> = {
      _tag: 'EffectOutcome',
      type: spec.type.type,
    }
    const destination = lowering.alloc(outcome)
    lowering.emit({
      _tag: 'PackEffectOutcome',
      destination,
      source: success.result,
      tag: 0,
      type: outcome,
      provenance: generated(spec.expression.span),
    })
    return destination
  })
  if (returned === undefined) return undefined
  lowering.publish({
    _tag: 'OperationRegion',
    id: region,
    operations,
    outcome:
      returned === 'Transferred'
        ? {
            _tag: 'Trap',
            reason: 'unreachable runner continuation',
            provenance: generated(spec.expression.span),
          }
        : {
            _tag: 'Return',
            value: returned,
            provenance: generated(spec.expression.span),
          },
  })
  return {
    _tag: 'MirFunction',
    sourceParameters: sourceParametersOf(lowering),
    ...sourceOwnerOf(lowering),
    id: spec.id,
    instance,
    parameterCount: allParameters.length,
    localTypes: [...lowering.localTypes],
    initializationFlags: initializationFlagsOf(lowering),
    result: { _tag: 'EffectOutcome', type: spec.type.type },
    entry: region,
    regions: lowering.regions.flatMap((candidate) => (candidate === undefined ? [] : [candidate])),
    effectRunner: {
      base: {
        declaration: Tir.effectRunnerId(spec.type.environment.instance.declaration, spec.type.site),
        typeArguments: spec.type.environment.instance.typeArguments,
      },
      providers: spec.providedRequirements.map((requirement) => ({
        capability: requirement.capability,
        providerType: requirement.providerType,
        witness: requirement.witness,
        role: requirement.role,
        requirementAccess: requirement.requirementAccess,
        access: requirement.access,
      })),
    },
  }
}

/** Lowers the discovered instances into one MIR program module in discovery order. */
