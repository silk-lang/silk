import * as CAbi from './CAbi.js'
import * as CleanupPlan from './CleanupPlan.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as Constraint from './Constraint.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as Elaboration from './Elaboration.js'
import * as Tir from './Tir.js'
import * as FunctionIndex from './internal/FunctionIndex.js'
import type * as Instances from './Instances.js'
import * as Intrinsic from './Intrinsic.js'
import * as Lifetime from './Lifetime.js'
import type * as SemanticContext from './SemanticContext.js'
import * as TypeInference from './internal/TypeInference.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as Specialization from './Specialization.js'
import type * as Evaluation from './Evaluation.js'
import * as StaticValue from './StaticValue.js'
import * as SuspensionMode from './SuspensionMode.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as Target from './Target.js'
import * as Type from './Type.js'
import type * as TypeCompatibility from './TypeCompatibility.js'

type Instance = Omit<Instances.Instance, 'ownership'> &
  Partial<Pick<Instances.Instance, 'ownership'>>
type InstanceKey = Instances.InstanceKey
type IntrinsicCall = Instances.IntrinsicCall
type ForeignCall = Instances.ForeignCall

export interface SuspensionGraph {
  readonly contextFreeTerminalObservations: ReadonlyArray<SourceSpan.SourceSpan>
  readonly diagnosticObservations: ReadonlySet<string>
  readonly roots: ReadonlyMap<SuspensionMode.Mode, ReadonlySet<string>>
  readonly dependencies: ReadonlyMap<string, ReadonlySet<string>>
  readonly effectIdentities: ReadonlySet<string>
  readonly permitted: ReadonlyMap<string, ReadonlySet<SuspensionMode.Mode>>
  readonly unavailable: ReadonlySet<string>
  /** Exact finalizer executions required to exclude external parking. */
  readonly nonParkingObligations: ReadonlyArray<{
    readonly node: string
    readonly span: SourceSpan.SourceSpan
  }>
  /** Exact operations and constructor specializations selected by lexical service providers. */
  readonly providedTargets: ReadonlyArray<Omit<Instances.CallInstance, '_tag' | 'resultEffect'>>
}

export interface CallTarget {
  readonly declaration: DeclarationFacts.CanonicalId
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly evidence?: ReadonlyArray<string>
  readonly staticArguments?: ReadonlyArray<StaticValue.Value>
  /** Caller-authored metadata aligned with static arguments and excluded from target identity. */
  readonly staticArgumentOrigins?: ReadonlyArray<Evaluation.TextOrigin | undefined>
  readonly structuralProvider?: Type.Type
  /** Concrete owner whose cleanup plan selected this target; excluded from target identity. */
  readonly cleanupRoot?: Type.Type
}

export const instanceNode = (key: InstanceKey, encode: (key: InstanceKey) => string): string =>
  `instance\u0000${encode(key)}`

export const effectNode = (identity: string): string => `effect\u0000${identity}`

const compareIntrinsicCalls = (left: IntrinsicCall, right: IntrinsicCall): number =>
  Intrinsic.operationText(left.operation).localeCompare(Intrinsic.operationText(right.operation)) ||
  left.span.sourceId.localeCompare(right.span.sourceId) ||
  left.span.start - right.span.start ||
  left.span.end - right.span.end

/** Collects the canonical intrinsic identities retained by reachable concrete instances. */
export const reachableIntrinsics = (
  instances: ReadonlyArray<Instance>,
  index: DeclarationIndex.Index,
): ReadonlyArray<IntrinsicCall> => {
  const retained = new Map<string, IntrinsicCall>()
  for (const instance of instances) {
    for (const statement of instance.function.statements) {
      for (const root of Tir.statementExpressions(statement)) {
        for (const expression of Tir.expressionTree(root)) {
          const selected =
            expression._tag === 'InterfaceOperationCall'
              ? (() => {
                  const capability = Type.substitute(
                    expression.capability,
                    instance.substitution,
                    instance.specialization.compatibility,
                  )
                  return Type.isNominal(capability)
                    ? ConformanceProof.interfaceOperationIntrinsic(
                        index,
                        Type.substitute(
                          expression.provider,
                          instance.substitution,
                          instance.specialization.compatibility,
                        ),
                        capability,
                        expression.operation,
                      )?.id
                    : undefined
                })()
              : undefined
          let operation: Intrinsic.OperationId | undefined
          if (expression._tag === 'BuiltinCall') {
            operation = expression.intrinsic
          } else if (expression._tag === 'EffectCatch') {
            operation = expression.intrinsic
          } else if (
            (expression._tag === 'FunctionItem' || expression._tag === 'CallableSection') &&
            expression.target._tag === 'BuiltinCallableTarget'
          ) {
            operation = expression.target.intrinsic
          } else {
            operation = selected
          }
          if (operation === undefined) continue
          const intrinsic = Intrinsic.findOperationById(operation)
          if (
            intrinsic === undefined ||
            intrinsic.phase === 'StaticOnly' ||
            intrinsic.targets.length === 0
          )
            throw new RangeError(
              `Runtime TIR retained non-runtime intrinsic ${Intrinsic.operationText(operation)}`,
            )
          const span = expression.span
          const key = `${Intrinsic.operationText(operation)}\u0000${span.sourceId}\u0000${span.start}\u0000${span.end}`
          retained.set(key, { _tag: 'ReachableIntrinsicCall', operation, span })
        }
      }
    }
  }
  return [...retained.values()].sort(compareIntrinsicCalls)
}

/** The foreign header a canonical call target names, when it is one. */
export const foreignFact = (
  index: DeclarationIndex.Index,
  target: DeclarationFacts.CanonicalId,
): DeclarationFacts.DeclarationFact | undefined => {
  const fact = DeclarationFacts.byCanonical(index, target)
  return fact?._tag === 'FunctionDeclaration' && fact.foreign !== undefined ? fact : undefined
}

/** Classifies one admitted foreign header's declared parameter and result types for a target. */
export const foreignSignature = (
  fact: DeclarationFacts.DeclarationFact,
  target: Target.Target,
): CAbi.CAbiSignature => {
  const declared = (type: DeclarationFacts.DeclaredTypeFact): Type.Type => {
    if (type._tag !== 'Resolved')
      throw new RangeError(
        `Runtime TIR reached foreign function ${fact.canonical._tag === 'Canonical' ? fact.canonical.id.name : fact.id.ordinal} with an unresolved type`,
      )
    return type.type
  }
  return CAbi.signature(
    fact.parameters.map((parameter) => declared(parameter.declaredType)),
    declared(fact.returnType),
    target,
    fact.foreign?.contract ?? fact.foreignExport?.contract,
    fact.foreign?.variadic ?? false,
  )
}

const compareForeignCalls = (left: ForeignCall, right: ForeignCall): number =>
  left.symbol.localeCompare(right.symbol) ||
  left.declaration.module.localeCompare(right.declaration.module) ||
  left.declaration.name.localeCompare(right.declaration.name)

const compareSpans = (left: Tir.Expression['span'], right: Tir.Expression['span']): number =>
  left.sourceId.localeCompare(right.sourceId) || left.start - right.start || left.end - right.end

/**
 * Collects every foreign declaration retained by reachable concrete instances, one entry per
 * declaration keyed by its first reachable call, classified for the selected target.
 */
export const reachableForeignCalls = (
  instances: ReadonlyArray<Instance>,
  index: DeclarationIndex.Index,
  registry: SemanticContext.Registry,
  target: Target.Target,
): ReadonlyArray<ForeignCall> => {
  const retained = new Map<string, ForeignCall>()
  for (const instance of instances) {
    for (const statement of instance.function.statements) {
      for (const root of Tir.statementExpressions(statement)) {
        for (const expression of Tir.expressionTree(root)) {
          if (expression._tag !== 'Call') continue
          const fact = foreignFact(index, expression.target)
          if (fact?.foreign === undefined || fact.name._tag !== 'Present') continue
          const key = `${expression.target.module} ${expression.target.name}`
          const existing = retained.get(key)
          if (existing !== undefined && compareSpans(existing.callSpan, expression.span) <= 0)
            continue
          retained.set(key, {
            _tag: 'ReachableForeignCall',
            symbol: fact.foreign.symbol,
            signature: foreignSignature(fact, target),
            declaration: expression.target,
            declarationSpan: registry.spanOf(fact.name.anchor),
            callSpan: expression.span,
          })
        }
      }
    }
  }
  return [...retained.values()].sort(compareForeignCalls)
}

/** Computes normalized direct/nested/external-park facts for every execution node. */
export const suspensionSummaries = (
  graph: SuspensionGraph,
): ReadonlyMap<string, SuspensionMode.Summary> => SuspensionMode.summarize(graph)

/** Executions that can enter diagnostic observation, including called cleanup hooks. */
export const observingExecutions = (graph: SuspensionGraph): ReadonlySet<string> => {
  if (graph.diagnosticObservations.size === 0) return new Set<string>()
  const callers = new Map<string, Set<string>>()
  for (const [caller, targets] of graph.dependencies)
    for (const target of targets) {
      const incoming = callers.get(target) ?? new Set<string>()
      incoming.add(caller)
      callers.set(target, incoming)
    }
  const reached = new Set(graph.diagnosticObservations)
  const pending = [...reached]
  for (let cursor = 0; cursor < pending.length; cursor += 1) {
    const node = pending.at(cursor)
    if (node === undefined) continue
    for (const caller of callers.get(node) ?? []) {
      if (reached.has(caller)) continue
      reached.add(caller)
      pending.push(caller)
    }
  }
  return reached
}

export interface Operations {
  readonly specializeInstanceType: (
    type: Type.Type,
    owner: Instances.InstanceKey,
    substitutions: ReadonlyArray<Type.Substitution>,
  ) => Type.Type
  readonly keyOf: (
    declaration: DeclarationFacts.CanonicalId,
    contract: Tir.ContractFact,
    typeParameters?: ReadonlyArray<Type.Parameter>,
    typeArguments?: ReadonlyArray<Type.GenericArgument>,
    staticArguments?: ReadonlyArray<StaticValue.Value>,
    evidence?: ReadonlyArray<string>,
  ) => Instances.InstanceKey
  readonly keyText: (key: Instances.InstanceKey) => string
  readonly requirementBindings: (
    fn: Tir.TirFunction,
  ) => ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>>
  readonly selectedRequirement: (
    binding: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>,
    substitution: Type.Substitution,
  ) => Type.Requirement | undefined
  readonly requirementBindingWitness: (
    binding: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>,
    substitution: Type.Substitution,
    index: DeclarationIndex.Index,
  ) => DeclarationFacts.ConformanceWitness | undefined
  readonly forwardedRequirementBinding: (
    fn: Tir.TirFunction,
  ) => Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }> | undefined
  readonly instanceSubstitution: (
    fn: Tir.TirFunction,
    key: Instances.InstanceKey,
  ) => Type.Substitution | undefined
  readonly effectParameterOrdinals: (
    fn: Tir.TirFunction,
    substitution: Type.Substitution,
  ) => ReadonlyArray<number>
  readonly callableParameterOrdinals: (
    fn: Tir.TirFunction,
    substitution: Type.Substitution,
  ) => ReadonlyArray<number>
  readonly parameterEffectIdentity: (
    fn: Tir.TirFunction,
    key: Instances.InstanceKey,
    ordinal: number,
  ) => string | undefined
  readonly parameterEffectRepresentationArgument: (
    fn: Tir.TirFunction,
    key: Instances.InstanceKey,
    ordinal: number,
  ) => Type.EffectIdentityArgument | Type.CompositeEffectRepresentationArgument | undefined
  readonly parameterCallableIdentity: (
    fn: Tir.TirFunction,
    key: Instances.InstanceKey,
    ordinal: number,
  ) => Type.CallableIdentityArgument | undefined
  readonly effectIdentity: (owner: Instances.InstanceKey, site: Tir.EffectSiteId) => string
  readonly callableIdentity: (self: Instances.CallableInstance) => string
  readonly callableEnvironmentIdentity: (
    self: Instances.CallableInstance,
  ) => Type.CallableEnvironmentIdentity
}

interface ProviderBinding {
  readonly node: string
  readonly execution: string
  readonly protectedTargets: ReadonlyArray<string>
  readonly selected: Type.Requirement
  readonly witness: DeclarationFacts.ConformanceWitness
  readonly providerAccess: 'Shared' | 'Exclusive' | 'Take'
  readonly receiver: Type.Type
}

type ProviderEnvironment = ReadonlyArray<ProviderBinding>

interface ProviderWorklist {
  readonly pending: Array<{ readonly node: string; readonly environment: ProviderEnvironment }>
  readonly queued: Map<string, Set<ProviderEnvironment>>
  readonly extensions: WeakMap<ProviderEnvironment, Map<string, ProviderEnvironment>>
}

// The measured graph enqueued 89,033 traversals for 50,502 distinct states. Intern ordered
// environments and deduplicate on enqueue, retaining FIFO order without rebuilding long keys.
const enqueueProvider = (
  self: ProviderWorklist,
  node: string,
  environment: ProviderEnvironment,
): void => {
  let environments = self.queued.get(node)
  if (environments === undefined) {
    environments = new Set()
    self.queued.set(node, environments)
  }
  if (environments.has(environment)) return
  environments.add(environment)
  self.pending.push({ node, environment })
}

const enterProviderBinding = (
  self: ProviderWorklist,
  environment: ProviderEnvironment,
  binding: ProviderBinding,
): ProviderEnvironment => {
  if (environment.some((candidate) => candidate.node === binding.node)) return environment
  let extensions = self.extensions.get(environment)
  if (extensions === undefined) {
    extensions = new Map()
    self.extensions.set(environment, extensions)
  }
  let extended = extensions.get(binding.node)
  if (extended === undefined) {
    extended = [...environment, binding]
    extensions.set(binding.node, extended)
  }
  return extended
}

const providerWorklist = (bindings: Iterable<ProviderBinding>): ProviderWorklist => {
  const self: ProviderWorklist = {
    pending: [],
    queued: new Map(),
    extensions: new WeakMap(),
  }
  // Every path starts from the same empty environment, so identical binding sequences share
  // identity. Binding order remains significant: service lookup selects the last matching one.
  const empty: ProviderEnvironment = []
  for (const binding of bindings) enqueueProvider(self, binding.node, empty)
  return self
}

// TIR bodies are immutable, and every suspension-graph rebuild, effect-origin query, and binding
// lookup walks the same bodies again; flatten each body once.
const callableBindingsCache = new WeakMap<Tir.TirFunction, ReadonlyMap<number, Tir.Expression>>()
const callableExpressionsCache = new WeakMap<Tir.TirFunction, ReadonlyArray<Tir.Expression>>()

export const make = (operations: Operations) => {
  const {
    specializeInstanceType,
    keyOf,
    keyText,
    requirementBindings,
    selectedRequirement,
    requirementBindingWitness,
    forwardedRequirementBinding,
    instanceSubstitution,
    effectParameterOrdinals,
    callableParameterOrdinals,
    parameterEffectIdentity,
    parameterEffectRepresentationArgument,
    parameterCallableIdentity,
    effectIdentity,
  } = operations
  type InstanceKey = Instances.InstanceKey
  type Instance = Omit<Instances.Instance, 'ownership'> &
    Partial<Pick<Instances.Instance, 'ownership'>>
  type CallInstance = Instances.CallInstance
  type CallableInstance = Instances.CallableInstance
  type EffectInstance = Instances.EffectInstance
  const sameVisibleTypeArguments = (
    left: ReadonlyArray<Type.GenericArgument>,
    right: ReadonlyArray<Type.GenericArgument>,
  ): boolean => {
    const leftVisible = left.filter((argument) => !Type.isHiddenExecutableArgument(argument))
    const rightVisible = right.filter((argument) => !Type.isHiddenExecutableArgument(argument))
    return (
      leftVisible.length === rightVisible.length &&
      leftVisible.every((argument, ordinal) => {
        const expected = rightVisible.at(ordinal)
        return (
          expected !== undefined &&
          Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(expected)
        )
      })
    )
  }
  const sameExactOwner = (left: InstanceKey, right: Type.ExecutableSpecializationOwner): boolean =>
    left.declaration.module === right.declaration.module &&
    left.declaration.name === right.declaration.name &&
    left.typeArguments.length === right.typeArguments.length &&
    left.typeArguments.every((argument, ordinal) => {
      const expected = right.typeArguments.at(ordinal)
      return (
        expected !== undefined &&
        Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(expected)
      )
    }) &&
    left.staticArguments.length === right.staticArgumentKeys.length &&
    left.staticArguments.every(
      (argument, ordinal) => StaticValue.key(argument) === right.staticArgumentKeys.at(ordinal),
    )
  /** Converts proved strict-subterm obligations into the only structurally descending call edges. */
  const witnessDependencyCallTargets = (
    index: DeclarationIndex.Index,
    provider: Type.Type,
    capability: Type.Nominal,
  ): ReadonlyArray<CallTarget> =>
    ConformanceProof.witnessDependencyTargets(index, provider, capability).map((dependency) => ({
      declaration: dependency.implementation,
      typeArguments: dependency.typeArguments,
      ...(dependency.structuralProvider === undefined
        ? {}
        : { structuralProvider: dependency.structuralProvider }),
    }))

  /** Collects every Drop hook a cleanup plan will invoke, so cleanup reaches hook instances. */
  const hookCalls = (
    cleanup: CleanupPlan.CleanupPlan,
    index: DeclarationIndex.Index,
    includeWitnessDependencies = true,
    cleanupRoot: Type.Type = cleanup.type,
    sharedPayloads: ReadonlySet<string> = new Set(),
  ): ReadonlyArray<CallTarget> => {
    const nested = (plan: CleanupPlan.CleanupPlan): ReadonlyArray<CallTarget> =>
      hookCalls(plan, index, includeWitnessDependencies, cleanupRoot, sharedPayloads)
    switch (cleanup._tag) {
      case 'LocalSharedCoreCleanup': {
        // The generated payload helper can invoke hooks hidden behind the opaque shared core.
        // Reentering the same payload on this path would rediscover the same hooks forever.
        const key = Type.key(cleanup.element)
        return sharedPayloads.has(key)
          ? []
          : hookCalls(
              CleanupPlan.cleanupPlan(index, cleanup.element),
              index,
              includeWitnessDependencies,
              cleanupRoot,
              new Set(sharedPayloads).add(key),
            )
      }
      case 'HookCleanup':
        return [
          ...(includeWitnessDependencies
            ? witnessDependencyCallTargets(index, cleanup.type, Type.dropCapability)
            : []),
          { declaration: cleanup.hook, typeArguments: cleanup.typeArguments },
          ...nested(cleanup.inner),
        ].map((call) => ({ ...call, cleanupRoot }))
      case 'StructCleanup':
        return cleanup.fields.flatMap((field) => nested(field.cleanup))
      case 'NominalUnionCleanup':
        return cleanup.variants.flatMap((variant) =>
          variant.fields.flatMap((field) => nested(field.cleanup)),
        )
      case 'ArrayCleanup':
        return nested(cleanup.element)
      case 'UnionCleanup':
        return cleanup.cases.flatMap((entry) => nested(entry.cleanup))
      case 'RawBufferCleanup':
        return nested(cleanup.allocation)
      case 'CallableCleanup':
        return cleanup.slots.flatMap((slot) => nested(slot.cleanup))
      case 'EffectCleanup':
        return cleanup.slots.flatMap((slot) => nested(slot.cleanup))
      case 'EffectCompositeCleanup':
        return cleanup.alternatives.flatMap(nested)
      default:
        return []
    }
  }

  /**
   * Reports whether a call must carry hidden identity arguments to be lowerable.
   *
   * Effect and callable values are both compiler-private: neither has a target layout, and both are
   * erased by monomorphizing the target on the argument's hidden concrete identity. A call passing
   * either therefore cannot be specialized on its explicit type arguments alone — the target would
   * be instantiated without the identity, and lowering would drop the parameter it cannot type.
   *
   * The judgement runs under the caller instance's substitution: an argument whose declared type is
   * a bare type parameter is still an Effect or callable value when the caller's own instance bound
   * that parameter to one, exactly as if the type had been spelled at the call.
   */
  const carriesHiddenIdentity = (
    expression: Extract<Tir.Expression, { readonly _tag: 'Call' | 'EffectConstruct' }>,
    substitution: Type.Substitution,
  ): boolean => {
    const carrier = (type: Type.Type): boolean => {
      const specialized = Type.substitute(type, substitution)
      return Type.isEffect(specialized) || Type.isCallable(specialized)
    }
    return (
      Type.isEffect(Type.substitute(expression.type, substitution)) ||
      expression.arguments.some(
        (argument) => argument._tag !== 'Unavailable' && carrier(argument.type),
      )
    )
  }

  const callTargets = (
    expression: Tir.Expression,
    index: DeclarationIndex.Index,
    substitution: Type.Substitution,
    evidence: Elaboration.BodyResults['evidence'],
  ): ReadonlyArray<CallTarget> => {
    const visit = (child: Tir.Expression): ReadonlyArray<CallTarget> =>
      callTargets(child, index, substitution, evidence)
    if (expression._tag === 'Run') return visit(expression.subject)
    if (expression._tag === 'EffectCatch')
      return [...visit(expression.protected), ...visit(expression.handler)]
    if (expression._tag === 'EffectBindRequirement') {
      // A source-declared witness makes provision dispatch to its qualified operation, so the
      // operation is reachable even though no ordinary call names it.
      const witness = expression.provider.witness
      return [
        ...visit(expression.protected),
        ...(witness?._tag === 'SourceConformanceWitness'
          ? witnessDependencyCallTargets(index, witness.provider, witness.capability)
          : []),
      ]
    }
    if (expression._tag === 'Replace')
      return Tir.expressionChildren(expression).flatMap((child) => visit(child))
    if (expression._tag === 'Move') return visit(expression.subject)
    if (expression._tag === 'RuntimeStringView') return visit(expression.source)
    if (
      expression._tag === 'StringEquality' ||
      expression._tag === 'EnumEquality' ||
      expression._tag === 'ShortCircuit'
    ) {
      return [...visit(expression.left), ...visit(expression.right)]
    }
    if (expression._tag === 'UnionConvert') return visit(expression.source)
    if (expression._tag === 'Project') return visit(expression.subject)
    if (expression._tag === 'IndexPlace') {
      return [...visit(expression.subject), ...visit(expression.index)]
    }
    if (expression._tag === 'SliceLength') return visit(expression.slice)
    if (expression._tag === 'SliceIndexPlace') {
      return [...visit(expression.slice), ...visit(expression.index)]
    }
    if (expression._tag === 'SliceBorrow' || expression._tag === 'ValueBorrow') {
      return Tir.expressionChildren(expression).flatMap((child) => visit(child))
    }
    if (expression._tag === 'Construct' || expression._tag === 'ConstructUnionVariant') {
      return expression.fields.flatMap((field) => visit(field.value))
    }
    if (expression._tag === 'ArrayConstruct') {
      return expression.elements.flatMap(visit)
    }
    if (expression._tag === 'BuiltinCall' || expression._tag === 'InterfaceOperationCall') {
      return expression.arguments.flatMap(visit)
    }
    if (expression._tag === 'FunctionItem') return []
    if (expression._tag === 'CallableSection') {
      return expression.captures.flatMap((capture) => visit(capture.value))
    }
    if (expression._tag === 'CallableApply' || expression._tag === 'ForeignApply') {
      return [...visit(expression.callee), ...expression.arguments.flatMap(visit)]
    }
    if (expression._tag === 'Match') {
      return [
        ...visit(expression.scrutinee),
        ...expression.arms.flatMap((arm) => {
          if (arm.reachable) {
            return [
              ...(arm.guard === undefined ? [] : visit(arm.guard)),
              ...(arm.body._tag === 'Expression'
                ? [arm.body.expression]
                : arm.body.statements.flatMap(Tir.statementExpressions)
              ).flatMap(visit),
            ]
          }
          return []
        }),
      ]
    }
    if (expression._tag === 'EffectBlock') {
      return expression.statements.flatMap((statement) =>
        Tir.statementExpressions(statement).flatMap((child) => visit(child)),
      )
    }
    if (
      expression._tag !== 'Call' &&
      expression._tag !== 'EffectConstruct' &&
      expression._tag !== 'ServiceEffectConstruct'
    )
      return []
    const nested = expression.arguments.flatMap(visit)
    if (expression._tag === 'ServiceEffectConstruct') return nested
    return carriesHiddenIdentity(expression, substitution)
      ? nested
      : [
          {
            declaration: expression.target,
            typeArguments: expression.typeArguments,
            evidence: (evidence.at(expression.evidence.ordinal)?.constraints ?? []).map(
              Type.runtimeEvidenceKey,
            ),
            ...(expression._tag === 'Call' || expression._tag === 'EffectConstruct'
              ? { staticArguments: expression.staticArguments }
              : {}),
            ...((expression._tag === 'Call' || expression._tag === 'EffectConstruct') &&
            expression.staticArgumentOrigins !== undefined
              ? { staticArgumentOrigins: expression.staticArgumentOrigins }
              : {}),
          },
          ...nested,
        ]
  }

  const bodyCallTargets = (
    body: {
      readonly function: Tir.TirFunction
      readonly evidence: Elaboration.BodyResults['evidence']
    },
    index: DeclarationIndex.Index,
    substitution: Type.Substitution,
  ): ReadonlyArray<CallTarget> =>
    body.function.statements.flatMap((statement) =>
      Tir.statementExpressions(statement).flatMap((expression) =>
        callTargets(expression, index, substitution, body.evidence),
      ),
    )

  const requirementBindingCallTargets = (
    fn: Tir.TirFunction,
    substitution: Type.Substitution,
    index: DeclarationIndex.Index,
  ): ReadonlyArray<CallTarget> =>
    (forwardedRequirementBinding(fn) === undefined ? requirementBindings(fn) : []).flatMap(
      (binding) => {
        const witness = requirementBindingWitness(binding, substitution, index)
        return witness?._tag === 'SourceConformanceWitness'
          ? witnessDependencyCallTargets(index, witness.provider, witness.capability)
          : []
      },
    )

  const forwardedRequirementCallTargets = (
    calls: ReadonlyArray<CallInstance>,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
  ): ReadonlyArray<CallTarget> =>
    calls.flatMap((call) => {
      const target = functionByKey(results, call.target)
      const binding = target === undefined ? undefined : forwardedRequirementBinding(target)
      if (target === undefined || binding === undefined) return []
      const substitution = instanceSubstitution(target, call.target)
      if (substitution === undefined) return []
      const witness = requirementBindingWitness(binding, substitution, index)
      return witness?._tag === 'SourceConformanceWitness'
        ? witnessDependencyCallTargets(index, witness.provider, witness.capability)
        : []
    })

  const slotDropHookTargets = (
    fn: Tir.TirFunction,
    index: DeclarationIndex.Index,
    substitution: Type.Substitution,
  ): ReadonlyArray<CallTarget> => {
    const walk = (expression: Tir.Expression): ReadonlyArray<CallTarget> => {
      const own =
        expression._tag === 'BuiltinCall' &&
        (expression.operation === 'SlotDrop' || expression.operation === 'ExecutionPark')
          ? (expression.operation === 'ExecutionPark'
              ? expression.typeArguments.slice(0, 1)
              : expression.typeArguments
            ).flatMap((argument) =>
              (() => {
                const specialized = Type.substituteGenericArgument(argument, substitution)
                return Type.isTypeArgument(specialized)
                  ? hookCalls(CleanupPlan.cleanupPlan(index, specialized), index)
                  : []
              })(),
            )
          : []
      if (expression._tag === 'Match') {
        return [
          ...own,
          ...walk(expression.scrutinee),
          ...expression.arms.flatMap((arm) => {
            if (arm.reachable) {
              return [
                ...(arm.guard === undefined ? [] : walk(arm.guard)),
                ...(arm.body._tag === 'Expression'
                  ? [arm.body.expression]
                  : arm.body.statements.flatMap(Tir.statementExpressions)
                ).flatMap(walk),
              ]
            }
            return []
          }),
        ]
      }
      return [...own, ...Tir.expressionChildren(expression).flatMap(walk)]
    }
    return fn.statements.flatMap((statement) => Tir.statementExpressions(statement).flatMap(walk))
  }

  /**
   * Collects the provider functions static interface operations dispatch to.
   *
   * A source witness is reachable through an operator, a bound qualifier, or an explicitly applied
   * interface qualifier, and through no ordinary call — so discovery has to read the conformance
   * itself. Every spelling walks one conformance because the selected witness does not depend on
   * how the body names the operation; a scalar argument maps the same operation to a sealed
   * intrinsic and contributes no target.
   */
  const interfaceWitnessTargets = (
    fn: Tir.TirFunction,
    index: DeclarationIndex.Index,
    substitution: Type.Substitution,
  ): ReadonlyArray<CallTarget> => {
    const walk = (expression: Tir.Expression): ReadonlyArray<CallTarget> => {
      let selection:
        | {
            readonly capability: Type.Nominal
            readonly provider: Type.Type
            readonly operation: string
            readonly contract: DeclarationFacts.InterfaceOperationApplicationFact
          }
        | undefined
      if (expression._tag === 'BuiltinCall') {
        selection = expression.interfaceOperation
      } else if (expression._tag === 'InterfaceOperationCall') {
        selection = expression
      } else {
        selection = undefined
      }
      const capability =
        selection === undefined ? undefined : Type.substitute(selection.capability, substitution)
      const provider =
        selection === undefined ? undefined : Type.substitute(selection.provider, substitution)
      const target =
        selection === undefined ||
        provider === undefined ||
        capability === undefined ||
        !Type.isNominal(capability)
          ? undefined
          : ConformanceProof.interfaceWitnessTarget(
              index,
              provider,
              capability,
              selection.operation,
              selection.contract,
              substitution,
            )
      const dependencies =
        provider === undefined || capability === undefined || !Type.isNominal(capability)
          ? []
          : witnessDependencyCallTargets(index, provider, capability)
      const concreteOperands =
        expression._tag === 'InterfaceOperationCall' &&
        expression.witnessEffectSite === undefined &&
        expression.arguments.some((argument) => {
          if (argument._tag === 'Unavailable') return false
          const type = Type.substitute(argument.type, substitution)
          return Type.isEffect(type) || Type.isCallable(type)
        })
      // A conditional witness is generic in its header's binders, so the target carries the arguments
      // this specialization proved rather than reaching code through an unsubstituted declaration.
      let own: CallTarget[]
      if (target === undefined && dependencies.length === 0) {
        own = []
      } else {
        own = [
          ...dependencies,
          ...(target === undefined || concreteOperands
            ? []
            : [
                {
                  declaration: target.implementation,
                  typeArguments: target.typeArguments,
                  ...(target.structuralProvider === undefined
                    ? {}
                    : { structuralProvider: target.structuralProvider }),
                },
              ]),
        ]
      }
      if (expression._tag === 'Match') {
        return [
          ...own,
          ...walk(expression.scrutinee),
          ...expression.arms.flatMap((arm) => {
            if (arm.reachable) {
              return [
                ...(arm.guard === undefined ? [] : walk(arm.guard)),
                ...(arm.body._tag === 'Expression'
                  ? [arm.body.expression]
                  : arm.body.statements.flatMap(Tir.statementExpressions)
                ).flatMap(walk),
              ]
            }
            return []
          }),
        ]
      }
      return [...own, ...Tir.expressionChildren(expression).flatMap(walk)]
    }
    return fn.statements.flatMap((statement) => Tir.statementExpressions(statement).flatMap(walk))
  }

  const callableBindings = (fn: Tir.TirFunction): ReadonlyMap<number, Tir.Expression> => {
    const cached = callableBindingsCache.get(fn)
    if (cached !== undefined) return cached
    const bindings = new Map<number, Tir.Expression>()
    const expression = (value: Tir.Expression): void => {
      if (value._tag === 'EffectBlock') {
        statements(value.statements)
        return
      }
      if (value._tag === 'Match') {
        // Expression children flatten block arms and omit the Bind statements whose identities
        // connect a later run or provider binding to its deferred Effect initializer.
        expression(value.scrutinee)
        for (const arm of value.arms) {
          if (arm.guard !== undefined) expression(arm.guard)
          if (arm.body._tag === 'Expression') expression(arm.body.expression)
          else statements(arm.body.statements)
        }
        return
      }
      for (const child of Tir.expressionChildren(value)) expression(child)
    }
    const statements = (body: ReadonlyArray<Tir.Statement>): void => {
      for (const statement of body) {
        if (statement._tag === 'Bind') {
          bindings.set(statement.binding.ordinal, statement.initializer)
          expression(statement.initializer)
        }
        if (statement._tag === 'Unsafe') statements(statement.statements)
        else if (statement._tag === 'If') {
          expression(statement.condition)
          statements(statement.taken)
          statements(statement.otherwise)
        } else if (statement._tag === 'While') {
          expression(statement.condition)
          statements(statement.body)
        } else if (statement._tag !== 'Bind') {
          for (const root of Tir.statementExpressions(statement)) expression(root)
        }
      }
    }
    statements(fn.statements)
    callableBindingsCache.set(fn, bindings)
    return bindings
  }

  /**
   * Follows a callable through a closed, source-visible return chain without inventing a runtime
   * dictionary for its quantified contract. Only exact expression identity is forwarded: branches,
   * computed callables, opaque declarations, and recursion stop the proof.
   */
  const forwardedCallableParameter = (
    fn: Tir.TirFunction,
    results: ReadonlyMap<string, Elaboration.Result>,
    resolving: ReadonlySet<string> = new Set(),
  ): number | undefined => {
    const key_ =
      fn.declaration.canonical._tag === 'Canonical'
        ? `${fn.declaration.canonical.id.module}\u0000${fn.declaration.canonical.id.name}`
        : undefined
    if (key_ === undefined || resolving.has(key_) || fn.contract._tag !== 'Contract')
      return undefined
    const leading = fn.statements.slice(0, -1)
    const returned = fn.statements.at(-1)
    if (
      fn.contract.parameters.length !== 1 ||
      returned?._tag !== 'Return' ||
      leading.some((statement) => statement._tag !== 'Bind')
    )
      return undefined
    const forwardedBindings = new Set<number>()
    const next = new Set(resolving).add(key_)
    const expression = (
      current: Tir.Expression,
      bindings: ReadonlySet<number> = new Set(),
    ): number | undefined => {
      if (current._tag === 'Move') return expression(current.subject, bindings)
      if (current._tag === 'ParameterReference') return current.parameter.ordinal
      if (current._tag === 'BindingReference') {
        const ordinal = current.binding.ordinal
        if (bindings.has(ordinal)) return undefined
        const binding = leading.find(
          (statement) => statement._tag === 'Bind' && statement.binding.ordinal === ordinal,
        )
        if (binding?._tag !== 'Bind') return undefined
        forwardedBindings.add(ordinal)
        return expression(binding.initializer, new Set(bindings).add(ordinal))
      }
      if (current._tag !== 'Call') return undefined
      const target = targetFunction(results, current.target)
      const forwarded =
        target === undefined ? undefined : forwardedCallableParameter(target, results, next)
      const argument = forwarded === undefined ? undefined : current.arguments.at(forwarded)
      return argument === undefined ? undefined : expression(argument, bindings)
    }
    const forwarded = expression(returned.expression)
    return forwarded === undefined ||
      leading.some(
        (statement) =>
          statement._tag !== 'Bind' || !forwardedBindings.has(statement.binding.ordinal),
      )
      ? undefined
      : forwarded
  }

  const staticallyForwardedCallable = (
    expression: Tir.Expression,
    fn: Tir.TirFunction,
    results: ReadonlyMap<string, Elaboration.Result>,
    arguments_: ReadonlyArray<Tir.Expression> = [],
    resolving: ReadonlySet<string> = new Set(),
  ): Tir.Expression | undefined => {
    if (expression._tag === 'Move')
      return staticallyForwardedCallable(expression.subject, fn, results, arguments_, resolving)
    if (expression._tag === 'BindingReference') {
      const initializer = callableBindings(fn).get(expression.binding.ordinal)
      return initializer === undefined
        ? undefined
        : staticallyForwardedCallable(initializer, fn, results, arguments_, resolving)
    }
    if (expression._tag === 'ParameterReference') return arguments_.at(expression.parameter.ordinal)
    if (expression._tag !== 'Call')
      return expression._tag === 'CallableSection' || expression._tag === 'FunctionItem'
        ? expression
        : undefined
    const identity = `${expression.target.module}\u0000${expression.target.name}`
    if (resolving.has(identity)) return undefined
    const target = targetFunction(results, expression.target)
    const forwarded =
      target === undefined ? undefined : forwardedCallableParameter(target, results, resolving)
    const argument = forwarded === undefined ? undefined : expression.arguments.at(forwarded)
    return argument === undefined
      ? undefined
      : staticallyForwardedCallable(
          argument,
          fn,
          results,
          arguments_,
          new Set([...resolving, identity]),
        )
  }

  const callableOriginOf = (
    expression: Tir.Expression,
    context: EffectOriginContext,
  ): Type.CallableIdentityArgument | undefined => {
    if (expression._tag !== 'Unavailable') {
      const specialized = Type.substitute(
        expression.type,
        context.substitution,
        context.compatibility,
      )
      if (
        Type.isRepresented(specialized) &&
        Type.isExactRepresentationArgument(specialized.representation.argument) &&
        Type.isCallableIdentityArgument(specialized.representation.argument.identity)
      )
        return specialized.representation.argument.identity
    }
    if (expression._tag === 'FunctionItem') {
      const target = Tir.callableTargetIdentity(expression.target)
      const typeArguments = expression.typeArguments.map((argument) =>
        Type.substituteGenericArgument(argument, context.substitution, context.compatibility),
      )
      const identity =
        target._tag === 'Declaration'
          ? `declaration:${target.module}:${target.name}`
          : `builtin:${target.actor}:${target.operation}`
      return Type.callableIdentityArgument(identity, target, typeArguments)
    }
    if (expression._tag === 'CallableSection') {
      const typeArguments = expression.typeArguments.map((argument) =>
        Type.substituteGenericArgument(argument, context.substitution, context.compatibility),
      )
      const environment =
        expression.captures.length === 0
          ? undefined
          : Tir.callableEnvironmentIdentity(expression.site, {
              declaration: {
                module: context.owner.declaration.module,
                name: context.owner.declaration.name,
              },
              typeArguments: context.owner.typeArguments,
              staticArgumentKeys: context.owner.staticArguments.map(StaticValue.key),
            })
      const target = Tir.callableTargetIdentity(expression.target)
      const identity =
        target._tag === 'Declaration'
          ? `declaration:${target.module}:${target.name}`
          : `builtin:${target.actor}:${target.operation}`
      return Type.callableIdentityArgument(identity, target, typeArguments, environment)
    }
    if (expression._tag === 'ParameterReference')
      return parameterCallableIdentity(context.fn, context.owner, expression.parameter.ordinal)
    if (expression._tag === 'BindingReference') {
      const initializer = callableBindings(context.fn).get(expression.binding.ordinal)
      return initializer === undefined ? undefined : callableOriginOf(initializer, context)
    }
    if (expression._tag === 'Move') return callableOriginOf(expression.subject, context)
    if (expression._tag === 'Call') {
      const forwarded = staticallyForwardedCallable(expression, context.fn, context.results)
      if (forwarded !== undefined && forwarded !== expression)
        return callableOriginOf(forwarded, context)
      const targetKey = targetKeyOfInvocation(expression, context)
      const target =
        targetKey === undefined ? undefined : targetFunction(context.results, expression.target)
      return targetKey === undefined || target === undefined
        ? undefined
        : resultCallableIdentity(
            target,
            targetKey,
            context.results,
            context.index,
            context.resolving,
          )
    }
    if (expression._tag === 'CallableApply' && expression.staged !== undefined) {
      // A staged application keeps the base's target and names the spliced environment it built.
      const base = callableOriginOf(expression.callee, context)
      return base === undefined
        ? undefined
        : Type.callableIdentityArgument(
            base.identity,
            base.target,
            base.typeArguments,
            Tir.callableEnvironmentIdentity(expression.staged.site, {
              declaration: {
                module: context.owner.declaration.module,
                name: context.owner.declaration.name,
              },
              typeArguments: context.owner.typeArguments,
              staticArgumentKeys: context.owner.staticArguments.map(StaticValue.key),
            }),
          )
    }
    if (expression._tag === 'CallableApply') {
      const targetKey = targetKeyOfInvocation(expression, context)
      if (targetKey === undefined) return undefined
      const target = targetFunction(context.results, targetKey.declaration)
      return target === undefined
        ? undefined
        : resultCallableIdentity(
            target,
            targetKey,
            context.results,
            context.index,
            context.resolving,
          )
    }
    return undefined
  }

  const callableSubstitutionOf = (
    expression: Tir.Expression,
    context: EffectOriginContext,
  ): Type.Substitution => {
    if (expression._tag === 'CallableSection')
      return new Map(
        Array.from(expression.substitution.entries()).map(([key, argument]) => [
          key,
          Type.substituteGenericArgument(argument, context.substitution, context.compatibility),
        ]),
      )
    if (expression._tag === 'BindingReference') {
      const initializer = callableBindings(context.fn).get(expression.binding.ordinal)
      return initializer === undefined ? new Map() : callableSubstitutionOf(initializer, context)
    }
    if (expression._tag === 'Move') return callableSubstitutionOf(expression.subject, context)
    if (expression._tag === 'Call') {
      const forwarded = staticallyForwardedCallable(expression, context.fn, context.results)
      return forwarded === undefined || forwarded === expression
        ? new Map()
        : callableSubstitutionOf(forwarded, context)
    }
    return new Map()
  }

  const appliedCallableOriginOf = (
    expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
    context: EffectOriginContext,
  ): Type.CallableIdentityArgument | undefined => {
    const callable = callableOriginOf(expression.callee, context)
    if (callable?.target._tag !== 'Declaration') return callable
    const declaration: DeclarationFacts.CanonicalId = {
      _tag: 'CanonicalDeclarationId',
      module: callable.target.module,
      name: callable.target.name,
    }
    const target = targetFunction(context.results, declaration)
    if (target === undefined) return callable
    const inferredAtSection = callableSubstitutionOf(expression.callee, context)
    const inferred = target.declaration.typeParameters.map((parameter, ordinal) => {
      const argument =
        expression.substitution.get(Type.key(parameter.type)) ??
        inferredAtSection.get(Type.key(parameter.type)) ??
        (callable.typeArguments.length === target.declaration.typeParameters.length
          ? callable.typeArguments.at(ordinal)
          : undefined)
      return argument === undefined
        ? undefined
        : Type.substituteGenericArgument(argument, context.substitution, context.compatibility)
    })
    if (inferred.some((argument) => argument === undefined)) return callable
    return Type.callableIdentityArgument(
      callable.identity,
      callable.target,
      inferred.filter((argument): argument is Type.GenericArgument => argument !== undefined),
      callable.environment,
    )
  }

  const callableApplicationArgument = (
    expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
    ordinal: number,
    context: EffectOriginContext,
  ): Tir.Expression | undefined => {
    const callable = callableValue(expression.callee, callableBindings(context.fn))
    const section = callable?._tag === 'CallableSection' ? callable : undefined
    if (section === undefined) return expression.arguments.at(ordinal)
    const captured = section.captures.find((capture) => capture.parameterOrdinal === ordinal)
    if (captured !== undefined) return captured.value
    const argumentOrdinal = section.remainingParameters.indexOf(ordinal)
    return argumentOrdinal < 0 ? undefined : expression.arguments.at(argumentOrdinal)
  }

  const resolveTargetKeyOfCallableApply = (
    expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
    context: EffectOriginContext,
  ): InstanceKey | undefined => {
    const callable = appliedCallableOriginOf(expression, context)
    if (callable?.target._tag !== 'Declaration') return undefined
    const declaration: DeclarationFacts.CanonicalId = {
      _tag: 'CanonicalDeclarationId',
      module: callable.target.module,
      name: callable.target.name,
    }
    const target = targetFunction(context.results, declaration)
    if (target === undefined) return undefined
    const parameters = target.declaration.typeParameters.map((parameter) => parameter.type)
    const arguments_ = callableTargetArguments(target, callable.typeArguments)
    if (arguments_ === undefined) return undefined
    const selected = TypeInference.selectedSubstitution(parameters, arguments_)
    if (selected === undefined) return undefined
    const targetSubstitution = selected.substitution
    const hiddenArguments: Array<
      | Type.EffectIdentityArgument
      | Type.CallableIdentityArgument
      | Type.CompositeEffectRepresentationArgument
    > = []
    for (const ordinal of effectParameterOrdinals(target, targetSubstitution)) {
      const argument = callableApplicationArgument(expression, ordinal, context)
      const compositeRepresentation =
        argument === undefined ? undefined : compositeEffectRepresentationOf(argument, context)
      if (compositeRepresentation !== undefined) {
        hiddenArguments.push(compositeRepresentation)
        continue
      }
      let identity = argument === undefined ? undefined : effectOriginOf(argument, context)
      if (identity === undefined) {
        const service = argument === undefined ? undefined : serviceEffectRecipe(argument, context)
        const serviceTarget = forwardedServiceTargetOfCallableApply(
          expression,
          target,
          targetSubstitution,
          ordinal,
          context,
          service,
        )
        const serviceFunction =
          serviceTarget === undefined
            ? undefined
            : targetFunction(context.results, serviceTarget.declaration)
        const serviceIdentity =
          serviceTarget === undefined || serviceFunction === undefined
            ? undefined
            : resultEffectIdentity(
                serviceFunction,
                serviceTarget,
                context.results,
                context.index,
                context.resolving,
              )
        if (argument !== undefined && service !== undefined && serviceIdentity !== undefined) {
          const inheritedResolver = context.resolveServiceEffectIdentity
          identity = effectOriginOf(argument, {
            ...context,
            resolveServiceEffectIdentity: (candidate) =>
              candidate === service.expression ? serviceIdentity : inheritedResolver?.(candidate),
          })
        }
      }
      if (identity === undefined) {
        return undefined
      }
      hiddenArguments.push(Type.effectIdentityArgument(identity))
    }
    for (const ordinal of callableParameterOrdinals(target, targetSubstitution)) {
      const argument = callableApplicationArgument(expression, ordinal, context)
      const identity = argument === undefined ? undefined : callableOriginOf(argument, context)
      if (identity === undefined) return undefined
      hiddenArguments.push(identity)
    }
    const key = keyOf(declaration, target.contract, parameters, [...arguments_, ...hiddenArguments])
    context.recordResolvedCall?.(expression, key)
    return key
  }

  const selectedCompatibility = (
    fn: Tir.TirFunction,
    owner: InstanceKey,
  ): TypeCompatibility.Context | undefined =>
    TypeInference.selectedSubstitution(
      fn.declaration.typeParameters.map((parameter) => parameter.type),
      owner.typeArguments.filter((argument) => !Type.isHiddenExecutableArgument(argument)),
    )?.compatibility

  interface EffectOriginContext {
    readonly fn: Tir.TirFunction
    readonly evidence: Elaboration.BodyResults['evidence']
    readonly owner: InstanceKey
    readonly substitution: Type.Substitution
    readonly compatibility: TypeCompatibility.Context | undefined
    readonly results: ReadonlyMap<string, Elaboration.Result>
    readonly index: DeclarationIndex.Index
    readonly resolving: ReadonlySet<string>
    readonly resolveEffectIdentity?: (identity: Type.EffectIdentityArgument) => string | undefined
    /** The call whose callee body is being traced, so a parameter resolves to its argument. */
    readonly parameterArguments?: {
      readonly arguments: ReadonlyArray<Tir.Expression>
      readonly context: EffectOriginContext
    }
    /** Resolves the success identity of an already-minted effect identity (post-discovery). */
    readonly successOfIdentity?: (
      identity: string,
      resolving: ReadonlySet<string>,
    ) => string | undefined
    readonly serviceRecipesOfIdentity?: (
      identity: string,
      resolving: ReadonlySet<string>,
    ) => ReadonlyArray<ServiceEffectRecipe>
    readonly resolveServiceEffectIdentity?: (
      expression: Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }>,
    ) => string | undefined
    readonly recordResolvedCall?: (
      expression: Extract<
        Tir.Expression,
        { readonly _tag: 'Call' | 'EffectConstruct' | 'CallableApply' }
      >,
      target: InstanceKey,
    ) => void
  }

  interface ServiceEffectRecipe {
    readonly expression: Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }>
    readonly context: EffectOriginContext
  }

  const evidenceOf = (
    results: ReadonlyMap<string, Elaboration.Result>,
    fn: Tir.TirFunction,
  ): Elaboration.BodyResults['evidence'] => {
    for (const result of results.values()) {
      const body = result.bodies.find((candidate) => candidate.function === fn)
      if (body !== undefined) return body.results.evidence
    }
    return []
  }

  function commonOrigin<A>(
    values: ReadonlyArray<A | undefined>,
    key: (value: A) => string,
  ): A | undefined {
    const first = values.at(0)
    return first !== undefined &&
      values.every((value) => value !== undefined && key(value) === key(first))
      ? first
      : undefined
  }

  function resultCallableIdentity(
    fn: Tir.TirFunction,
    owner: InstanceKey,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
    resolving: ReadonlySet<string> = new Set(),
  ): Type.CallableIdentityArgument | undefined {
    const substitution = instanceSubstitution(fn, owner)
    const expressions = Tir.returnExpressions(fn.statements)
    if (substitution === undefined || expressions.length === 0 || fn.contract._tag !== 'Contract')
      return undefined
    const result = Type.substitute(
      fn.contract.result,
      substitution,
      selectedCompatibility(fn, owner),
    )
    const contract = Type.isRepresented(result) ? result.contract : result
    if (!Type.isCallable(contract)) return undefined
    const identity = keyText(owner)
    if (resolving.has(identity)) return undefined
    return commonOrigin(
      expressions.map((expression) =>
        callableOriginOf(expression, {
          fn,
          evidence: evidenceOf(results, fn),
          owner,
          substitution,
          compatibility: selectedCompatibility(fn, owner),
          results,
          index,
          resolving: new Set(resolving).add(identity),
        }),
      ),
      Type.runtimeGenericArgumentKey,
    )
  }

  function serviceEffectRecipes(
    expression: Tir.Expression,
    context: EffectOriginContext,
    resolving: ReadonlySet<number> = new Set(),
  ): ReadonlyArray<ServiceEffectRecipe> {
    if (expression._tag === 'ServiceEffectConstruct') return [{ expression, context }]
    if (expression._tag === 'EffectBlock')
      return expression.statements.flatMap((statement) =>
        Tir.statementExpressions(statement).flatMap((nested) =>
          serviceEffectRecipes(nested, context, resolving),
        ),
      )
    if (expression._tag === 'Run')
      return serviceEffectRecipes(expression.subject, context, resolving)
    if (expression._tag === 'Move')
      return serviceEffectRecipes(expression.subject, context, resolving)
    if (expression._tag === 'UnionConvert')
      return serviceEffectRecipes(expression.source, context, resolving)
    if (expression._tag === 'Match')
      return expression.arms.flatMap((arm) =>
        arm.reachable && arm.body._tag === 'Expression'
          ? serviceEffectRecipes(arm.body.expression, context, resolving)
          : [],
      )
    if (expression._tag === 'EffectCatch')
      return [
        ...serviceEffectRecipes(expression.protected, context, resolving),
        ...serviceEffectRecipes(expression.handler, context, resolving),
      ]
    if (expression._tag === 'Call' || expression._tag === 'EffectConstruct')
      return expression.arguments.flatMap((argument) =>
        serviceEffectRecipes(argument, context, resolving),
      )
    if (expression._tag === 'CallableSection')
      return expression.captures.flatMap((capture) =>
        serviceEffectRecipes(capture.value, context, resolving),
      )
    if (expression._tag === 'ForeignApply')
      return Tir.expressionChildren(expression).flatMap((child) =>
        serviceEffectRecipes(child, context, resolving),
      )
    if (expression._tag === 'CallableApply') {
      const children =
        expression.evaluation === 'LeftThenCallable'
          ? [...expression.arguments, expression.callee]
          : [expression.callee, ...expression.arguments]
      return children.flatMap((child) => serviceEffectRecipes(child, context, resolving))
    }
    if (expression._tag === 'BuiltinCall' || expression._tag === 'InterfaceOperationCall')
      return expression.arguments.flatMap((argument) =>
        serviceEffectRecipes(argument, context, resolving),
      )
    if (expression._tag === 'ParameterReference') {
      const identity = parameterEffectIdentity(
        context.fn,
        context.owner,
        expression.parameter.ordinal,
      )
      return identity === undefined
        ? []
        : (context.serviceRecipesOfIdentity?.(identity, context.resolving) ?? [])
    }
    if (expression._tag !== 'BindingReference') return []
    const ordinal = expression.binding.ordinal
    if (resolving.has(ordinal)) return []
    const initializer = callableBindings(context.fn).get(ordinal)
    return initializer === undefined
      ? []
      : serviceEffectRecipes(initializer, context, new Set(resolving).add(ordinal))
  }

  const serviceEffectRecipe = (
    expression: Tir.Expression,
    context: EffectOriginContext,
  ): ServiceEffectRecipe | undefined => {
    const recipes = serviceEffectRecipes(expression, context)
    return recipes.length === 1 ? recipes.at(0) : undefined
  }

  const constrainedServiceTarget = (
    target: Tir.TirFunction,
    targetSubstitution: Type.Substitution,
    effectParameter: number,
    service: ServiceEffectRecipe,
    context: EffectOriginContext,
  ): InstanceKey | undefined => {
    if (target.contract._tag !== 'Contract') return undefined
    const parameter = target.contract.parameters.at(effectParameter)
    const effect =
      parameter === undefined ? undefined : Type.substitute(parameter, targetSubstitution)
    if (effect === undefined || !Type.isEffect(effect)) return undefined
    for (const constraint of target.contract.constraints) {
      if (constraint._tag !== 'ProviderSelectionConstraint') continue
      const provider = Type.substitute(constraint.provider, targetSubstitution)
      const selected = Type.substituteRequirementsRow(constraint.selected, targetSubstitution)
      const source = Type.substituteRequirementsRow(constraint.source, targetSubstitution)
      const concrete = RowAlgebra.concretize(Type.requirementRowPolicy(), selected)
      const requirement = concrete._tag === 'Concrete' ? concrete.row.members.at(0) : undefined
      const providerParameter = target.contract.parameters
        .map((candidate) => Type.substitute(candidate, targetSubstitution))
        .find((specialized, ordinal) => {
          if (ordinal === effectParameter) return false
          if (constraint.mode === 'Take') return Type.equals(specialized, provider)
          return (
            Type.isReference(specialized) &&
            specialized.access === constraint.mode &&
            Type.equals(specialized.target, provider)
          )
        })
      if (
        !Type.isNominal(provider) ||
        concrete._tag !== 'Concrete' ||
        concrete.row.members.length !== 1 ||
        requirement === undefined ||
        !Type.isNominal(requirement.capability) ||
        !RowAlgebra.equals(Type.requirementRowPolicy(), effect.requirementRow, source) ||
        providerParameter === undefined ||
        !Type.equals(
          Type.substitute(
            service.expression.service,
            service.context.substitution,
            service.context.compatibility,
          ),
          requirement.capability,
        ) ||
        service.expression.role !== requirement.role ||
        (service.expression.access !== 'Shared' &&
          constraint.mode !== 'Exclusive' &&
          constraint.mode !== 'Take')
      )
        continue
      const witness = ConformanceProof.witness(context.index, provider, requirement.capability)
      if (witness?._tag === 'SourceConformanceWitness') {
        const result = Type.substitute(target.contract.result, targetSubstitution)
        if (!Type.isEffect(result)) continue
        return targetKeyOfServiceCall(
          service.expression,
          witness,
          service.context,
          constraint.mode === 'Take'
            ? Type.reference(service.expression.access, provider, result.environment)
            : providerParameter,
        )
      }
    }
    return undefined
  }

  function forwardedServiceTargetOfCallableApply(
    expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
    target: Tir.TirFunction,
    targetSubstitution: Type.Substitution,
    effectParameter: number,
    context: EffectOriginContext,
    serviceOverride?: ServiceEffectRecipe,
  ): InstanceKey | undefined {
    const binding = forwardedRequirementBinding(target)
    const argument = callableApplicationArgument(expression, effectParameter, context)
    const service =
      serviceOverride ??
      (argument === undefined ? undefined : serviceEffectRecipe(argument, context))
    if (service === undefined) return undefined
    if (binding === undefined)
      return constrainedServiceTarget(target, targetSubstitution, effectParameter, service, context)
    const selected = selectedRequirement(binding, targetSubstitution)
    const witness = requirementBindingWitness(binding, targetSubstitution, context.index)
    if (
      selected === undefined ||
      !Type.isNominal(selected.capability) ||
      witness?._tag !== 'SourceConformanceWitness' ||
      !Type.equals(
        Type.substitute(
          service.expression.service,
          service.context.substitution,
          service.context.compatibility,
        ),
        selected.capability,
      ) ||
      service.expression.role !== selected.role ||
      (service.expression.access !== 'Shared' &&
        binding.provider.selectionAccess !== 'Exclusive' &&
        binding.provider.selectionAccess !== 'Take')
    )
      return undefined
    return targetKeyOfServiceCall(
      service.expression,
      witness,
      service.context,
      Type.reference(
        binding.provider.selectionAccess === 'Take'
          ? service.expression.access
          : binding.provider.selectionAccess,
        witness.provider,
        Type.substituteLifetime(binding.type.environment, targetSubstitution),
      ),
    )
  }

  const forwardedServiceTargetOfCall = (
    expression: Extract<Tir.Expression, { readonly _tag: 'Call' | 'EffectConstruct' }>,
    target: Tir.TirFunction,
    targetSubstitution: Type.Substitution,
    effectParameter: number,
    context: EffectOriginContext,
    serviceOverride?: ServiceEffectRecipe,
  ): InstanceKey | undefined => {
    const binding = forwardedRequirementBinding(target)
    const argument = expression.arguments.at(effectParameter)
    const service =
      serviceOverride ??
      (argument === undefined ? undefined : serviceEffectRecipe(argument, context))
    if (service === undefined) return undefined
    if (binding === undefined)
      return constrainedServiceTarget(target, targetSubstitution, effectParameter, service, context)
    const selected = selectedRequirement(binding, targetSubstitution)
    const witness = requirementBindingWitness(binding, targetSubstitution, context.index)
    if (
      selected === undefined ||
      !Type.isNominal(selected.capability) ||
      witness?._tag !== 'SourceConformanceWitness' ||
      !Type.equals(
        Type.substitute(
          service.expression.service,
          service.context.substitution,
          service.context.compatibility,
        ),
        selected.capability,
      ) ||
      service.expression.role !== selected.role ||
      (service.expression.access !== 'Shared' &&
        binding.provider.selectionAccess !== 'Exclusive' &&
        binding.provider.selectionAccess !== 'Take')
    )
      return undefined
    return targetKeyOfServiceCall(
      service.expression,
      witness,
      service.context,
      Type.reference(
        binding.provider.selectionAccess === 'Take'
          ? service.expression.access
          : binding.provider.selectionAccess,
        witness.provider,
        Type.substituteLifetime(binding.type.environment, targetSubstitution),
      ),
    )
  }

  const compositeEffectRepresentationOf = (
    expression: Tir.Expression,
    context: EffectOriginContext,
  ): Type.CompositeEffectRepresentationArgument | undefined => {
    if (expression._tag === 'Unavailable') return undefined
    const specialized = Specialization.specializeType(context.owner, expression.type, [
      context.substitution,
    ])
    const contract = Type.isRepresented(specialized) ? specialized.contract : specialized
    if (!Type.isEffect(contract)) return undefined
    if (
      Type.isRepresented(specialized) &&
      Type.isEffect(specialized.contract) &&
      Type.isCompositeEffectRepresentationArgument(specialized.representation.argument)
    )
      return specialized.representation.argument
    const resolution = `composite\0${keyText(context.owner)}\0${expression.span.sourceId}:${expression.span.start}:${expression.span.end}`
    if (context.resolving.has(resolution)) return undefined
    context = { ...context, resolving: new Set(context.resolving).add(resolution) }
    if (expression._tag === 'BindingReference') {
      const initializer = callableBindings(context.fn).get(expression.binding.ordinal)
      return initializer === undefined
        ? undefined
        : compositeEffectRepresentationOf(initializer, context)
    }
    if (expression._tag === 'ParameterReference') {
      const representation = parameterEffectRepresentationArgument(
        context.fn,
        context.owner,
        expression.parameter.ordinal,
      )
      return representation !== undefined &&
        Type.isCompositeEffectRepresentationArgument(representation)
        ? representation
        : undefined
    }
    if (expression._tag === 'Move')
      return compositeEffectRepresentationOf(expression.subject, context)
    if (expression._tag === 'UnionConvert')
      return compositeEffectRepresentationOf(expression.source, context)
    if (expression._tag === 'Call' || expression._tag === 'EffectConstruct') {
      const targetKey = targetKeyOfInvocation(expression, context)
      const target =
        targetKey === undefined ? undefined : targetFunction(context.results, targetKey.declaration)
      const substitution =
        targetKey === undefined || target === undefined
          ? undefined
          : instanceSubstitution(target, targetKey)
      const returned = target === undefined ? [] : Tir.returnExpressions(target.statements)
      if (
        substitution === undefined ||
        returned.length === 0 ||
        targetKey === undefined ||
        target === undefined
      )
        return undefined
      return commonOrigin(
        returned.map((expression) =>
          compositeEffectRepresentationOf(expression, {
            ...context,
            fn: target,
            owner: targetKey,
            substitution,
            compatibility: selectedCompatibility(target, targetKey),
          }),
        ),
        Type.runtimeGenericArgumentKey,
      )
    }
    if (expression._tag === 'CallableApply') {
      const targetKey = targetKeyOfInvocation(expression, context)
      const target =
        targetKey === undefined ? undefined : targetFunction(context.results, targetKey.declaration)
      const substitution =
        targetKey === undefined || target === undefined
          ? undefined
          : instanceSubstitution(target, targetKey)
      const returned = target === undefined ? [] : Tir.returnExpressions(target.statements)
      if (
        substitution === undefined ||
        returned.length === 0 ||
        targetKey === undefined ||
        target === undefined
      )
        return undefined
      return commonOrigin(
        returned.map((expression) =>
          compositeEffectRepresentationOf(expression, {
            ...context,
            fn: target,
            owner: targetKey,
            substitution,
            compatibility: selectedCompatibility(target, targetKey),
          }),
        ),
        Type.runtimeGenericArgumentKey,
      )
    }
    return undefined
  }

  const callTargetCache = new WeakMap<
    EffectOriginContext,
    WeakMap<Tir.Expression, InstanceKey | undefined>
  >()

  const canCacheCallTarget = (context: EffectOriginContext): boolean => {
    // Resolving a parameter can re-enter its caller. Preserve provider-selection bookkeeping
    // and resolved-call recording throughout that chain, even if this context has no callback.
    for (
      let current: EffectOriginContext | undefined = context;
      current !== undefined;
      current = current.parameterArguments?.context
    ) {
      if (
        current.recordResolvedCall !== undefined ||
        current.resolveServiceEffectIdentity !== undefined
      )
        return false
    }
    return true
  }

  // Call-target resolution accounted for over a third of suspension-graph CPU samples.
  // Callable applications share this cache: repeated queries retain the exact owner,
  // substitution, and recursion state. Unresolved results are stable within that context too.
  const targetKeyOfInvocation = (
    expression: Extract<
      Tir.Expression,
      { readonly _tag: 'Call' | 'EffectConstruct' | 'CallableApply' }
    >,
    context: EffectOriginContext,
  ): InstanceKey | undefined => {
    const cacheable = canCacheCallTarget(context)
    let targets = cacheable ? callTargetCache.get(context) : undefined
    if (targets?.has(expression)) return targets.get(expression)
    const target =
      expression._tag === 'CallableApply'
        ? resolveTargetKeyOfCallableApply(expression, context)
        : resolveTargetKeyOfCall(expression, context)
    if (cacheable) {
      if (targets === undefined) {
        targets = new WeakMap()
        callTargetCache.set(context, targets)
      }
      targets.set(expression, target)
    }
    return target
  }

  const resolveTargetKeyOfCall = (
    expression: Extract<Tir.Expression, { readonly _tag: 'Call' | 'EffectConstruct' }>,
    context: EffectOriginContext,
  ): InstanceKey | undefined => {
    const target = targetFunction(context.results, expression.target)
    if (target === undefined) return undefined
    // The frontend records lexical owners before hidden callback/Effect arguments exist.
    // Close those owners over this exact discovered instance before retaining call arguments.
    const typeArguments = expression.typeArguments.map((argument) =>
      Type.specializeExecutableOwner(
        Type.substituteGenericArgument(argument, context.substitution, context.compatibility),
        {
          declaration: context.owner.declaration,
          typeArguments: context.owner.typeArguments,
          staticArgumentKeys: context.owner.staticArguments.map(StaticValue.key),
        },
        Constraint.specializeCallableSchemaExecutableOwner,
      ),
    )
    const selected = TypeInference.selectedSubstitution(
      target.declaration.typeParameters.map((parameter) => parameter.type),
      typeArguments,
    )
    if (selected === undefined) return undefined
    const targetSubstitution = selected.substitution
    const hiddenArguments: Array<
      | Type.EffectIdentityArgument
      | Type.CallableIdentityArgument
      | Type.CompositeEffectRepresentationArgument
    > = []
    for (const ordinal of effectParameterOrdinals(target, targetSubstitution)) {
      const argument = expression.arguments.at(ordinal)
      const compositeRepresentation =
        argument === undefined ? undefined : compositeEffectRepresentationOf(argument, context)
      if (compositeRepresentation !== undefined) {
        hiddenArguments.push(compositeRepresentation)
        continue
      }
      let identity = argument === undefined ? undefined : effectOriginOf(argument, context)
      if (identity === undefined) {
        const service = argument === undefined ? undefined : serviceEffectRecipe(argument, context)
        const serviceTarget = forwardedServiceTargetOfCall(
          expression,
          target,
          targetSubstitution,
          ordinal,
          context,
          service,
        )
        const serviceFunction =
          serviceTarget === undefined
            ? undefined
            : targetFunction(context.results, serviceTarget.declaration)
        const serviceIdentity =
          serviceTarget === undefined || serviceFunction === undefined
            ? undefined
            : resultEffectIdentity(
                serviceFunction,
                serviceTarget,
                context.results,
                context.index,
                context.resolving,
              )
        if (argument !== undefined && service !== undefined && serviceIdentity !== undefined) {
          const inheritedResolver = context.resolveServiceEffectIdentity
          identity = effectOriginOf(argument, {
            ...context,
            resolveServiceEffectIdentity: (candidate) =>
              candidate === service.expression ? serviceIdentity : inheritedResolver?.(candidate),
          })
        }
      }
      if (identity === undefined) return undefined
      hiddenArguments.push(Type.effectIdentityArgument(identity))
    }
    for (const ordinal of callableParameterOrdinals(target, targetSubstitution)) {
      const argument = expression.arguments.at(ordinal)
      const identity = argument === undefined ? undefined : callableOriginOf(argument, context)
      if (identity === undefined) return undefined
      hiddenArguments.push(identity)
    }
    const key = keyOf(
      expression.target,
      target.contract,
      target.declaration.typeParameters.map((parameter) => parameter.type),
      [...typeArguments, ...hiddenArguments],
      expression.staticArguments,
      (context.evidence.at(expression.evidence.ordinal)?.constraints ?? []).map(
        Type.runtimeEvidenceKey,
      ),
    )
    context.recordResolvedCall?.(expression, key)
    return key
  }

  function targetKeyOfServiceCall(
    expression: Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }>,
    witness: Extract<
      DeclarationFacts.ConformanceWitness,
      { readonly _tag: 'SourceConformanceWitness' }
    >,
    context: EffectOriginContext,
    receiver: Type.Type,
  ): InstanceKey | undefined {
    const operation = ConformanceProof.witnessOperation(witness, expression.operation)
    const target = operation === undefined ? undefined : targetFunction(context.results, operation)
    if (operation === undefined || target === undefined) return undefined
    if (target.contract._tag !== 'Contract') return undefined
    const conformance = context.index.modules
      .find((module) => module.module === witness.module)
      ?.conformances.find((candidate) => candidate.ordinal === witness.ordinal)
    const conformanceSubstitution =
      conformance === undefined
        ? undefined
        : TypeInference.substitution(
            conformance.typeParameters.map((parameter) => parameter.type),
            witness.typeArguments,
          )
    // Conformance mappings can reference the service operation's own generic binders. Resolve
    // those at this invocation before using the mapping to seed implementation inference.
    const service = context.index.modules
      .find((module) => module.module === expression.service.module)
      ?.services.find(
        (service) =>
          service.canonical._tag === 'Canonical' &&
          service.canonical.id.name === expression.service.name,
      )
    const serviceOperation = service?.operations.find(
      (candidate) =>
        candidate.name._tag === 'Present' && candidate.name.spelling === expression.operation,
    )
    const operationSubstitution =
      service === undefined || serviceOperation === undefined
        ? undefined
        : TypeInference.substitution(
            [...service.typeParameters, ...serviceOperation.typeParameters].map(
              (parameter) => parameter.type,
            ),
            expression.typeArguments.map((argument) =>
              Type.substituteGenericArgument(argument, context.substitution, context.compatibility),
            ),
          )
    if (operationSubstitution === undefined) return undefined
    const mapped = conformance?.operations.find(
      (candidate) =>
        candidate.name._tag === 'Present' && candidate.name.spelling === expression.operation,
    )?.targetArguments
    const targetSubstitution = new Map<string, Type.GenericArgument>()
    const invocationLifetimes = new Set(
      DeclarationFacts.executableLifetimes(target.declaration).lifetimeBinders.map(
        Type.genericArgumentKey,
      ),
    )
    for (const [ordinal, parameter] of target.declaration.typeParameters.entries()) {
      const argument = mapped?.at(ordinal)
      // Witness checking instantiates invocation lifetimes only to compare contracts. The
      // selected invocation derives those lifetimes from its actual provider and arguments.
      if (
        invocationLifetimes.has(Type.key(parameter.type)) ||
        argument === undefined ||
        conformanceSubstitution === undefined
      )
        continue
      const specialized = Type.substituteGenericArgument(
        Type.substituteGenericArgument(argument, conformanceSubstitution),
        operationSubstitution,
      )
      if (
        Type.genericArgumentKey(specialized) !==
        Type.genericArgumentKey(Type.parameterArgument(parameter.type))
      )
        targetSubstitution.set(Type.key(parameter.type), specialized)
    }
    const actualParameters = [
      receiver,
      ...expression.arguments.flatMap((argument) =>
        argument._tag === 'Unavailable'
          ? []
          : [Type.substitute(argument.type, context.substitution, context.compatibility)],
      ),
    ]
    if (actualParameters.length !== target.contract.parameters.length) return undefined
    for (const [ordinal, parameter] of target.contract.parameters.entries()) {
      const actual = actualParameters.at(ordinal)
      if (actual === undefined) return undefined
      // The service invocation and conformance already prove argument compatibility. A helper
      // result may carry a coerced body-local lifetime rather than the provider's selected
      // lifetime; discovery must retain that admitted call without re-proving region equality.
      // Only lifetime-erased equality can recover failed inference, never a different value type.
      if (
        !TypeInference.infer(parameter, actual, targetSubstitution) &&
        Type.runtimeKey(Type.substitute(parameter, targetSubstitution)) !== Type.runtimeKey(actual)
      )
        return undefined
    }
    const typeArguments = target.declaration.typeParameters.flatMap((parameter) => {
      const argument = targetSubstitution.get(Type.key(parameter.type))
      return argument === undefined ? [] : [argument]
    })
    if (typeArguments.length !== target.declaration.typeParameters.length) return undefined
    const hiddenArguments: Array<
      | Type.EffectIdentityArgument
      | Type.CallableIdentityArgument
      | Type.CompositeEffectRepresentationArgument
    > = []
    for (const ordinal of effectParameterOrdinals(target, targetSubstitution)) {
      const argument = ordinal === 0 ? undefined : expression.arguments.at(ordinal - 1)
      const compositeRepresentation =
        argument === undefined ? undefined : compositeEffectRepresentationOf(argument, context)
      if (compositeRepresentation !== undefined) {
        hiddenArguments.push(compositeRepresentation)
        continue
      }
      const identity = argument === undefined ? undefined : effectOriginOf(argument, context)
      if (identity === undefined) return undefined
      hiddenArguments.push(Type.effectIdentityArgument(identity))
    }
    for (const ordinal of callableParameterOrdinals(target, targetSubstitution)) {
      const argument = ordinal === 0 ? undefined : expression.arguments.at(ordinal - 1)
      const identity = argument === undefined ? undefined : callableOriginOf(argument, context)
      if (identity === undefined) return undefined
      hiddenArguments.push(identity)
    }
    return keyOf(
      operation,
      target.contract,
      target.declaration.typeParameters.map((parameter) => parameter.type),
      [...typeArguments, ...hiddenArguments],
      expression.staticArguments,
    )
  }

  // Discovery, every suspension-graph rebuild, and provider selection ask for the same result
  // identities. An unguarded query depends only on the compilation, the body, and the exact
  // application, so its answer is retained; cycle-guarded queries are recomputed.
  const resultEffectIdentities = new WeakMap<
    ReadonlyMap<string, Elaboration.Result>,
    WeakMap<DeclarationIndex.Index, WeakMap<Tir.TirFunction, Map<string, string | undefined>>>
  >()
  const resultEffectIdentity = (
    fn: Tir.TirFunction,
    owner: InstanceKey,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
    resolving: ReadonlySet<string> = new Set(),
  ): string | undefined => {
    if (resolving.size > 0) return computeResultEffectIdentity(fn, owner, results, index, resolving)
    let byIndex = resultEffectIdentities.get(results)
    if (byIndex === undefined) {
      byIndex = new WeakMap()
      resultEffectIdentities.set(results, byIndex)
    }
    let byFunction = byIndex.get(index)
    if (byFunction === undefined) {
      byFunction = new WeakMap()
      byIndex.set(index, byFunction)
    }
    let byOwner = byFunction.get(fn)
    if (byOwner === undefined) {
      byOwner = new Map()
      byFunction.set(fn, byOwner)
    }
    const application = `${keyText(owner)}\u0003${owner.typeArguments.map(Type.genericArgumentKey).join('\u0001')}`
    if (byOwner.has(application)) return byOwner.get(application)
    const identity = computeResultEffectIdentity(fn, owner, results, index, resolving)
    byOwner.set(application, identity)
    return identity
  }

  const computeResultEffectIdentity = (
    fn: Tir.TirFunction,
    owner: InstanceKey,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
    resolving: ReadonlySet<string>,
  ): string | undefined => {
    const substitution = instanceSubstitution(fn, owner)
    const expressions = Tir.returnExpressions(fn.statements)
    if (substitution === undefined || expressions.length === 0) return undefined
    if (fn.contract._tag !== 'Contract') return undefined
    const result = Type.substitute(
      fn.contract.result,
      substitution,
      selectedCompatibility(fn, owner),
    )
    const contract = Type.isRepresented(result) ? result.contract : result
    if (!Type.isEffect(contract)) return undefined
    const identity = keyText(owner)
    if (resolving.has(identity)) return undefined
    return commonOrigin(
      expressions.map((expression) =>
        effectOriginOf(expression, {
          fn,
          evidence: evidenceOf(results, fn),
          owner,
          substitution,
          compatibility: selectedCompatibility(fn, owner),
          results,
          index,
          resolving: new Set(resolving).add(identity),
        }),
      ),
      (identity) => identity,
    )
  }

  const effectOriginOf = (
    expression: Tir.Expression,
    context: EffectOriginContext,
  ): string | undefined => {
    const exactIdentity = (type: Type.Type): string | undefined => {
      const specialized = Specialization.specializeType(context.owner, type, [context.substitution])
      return Type.isRepresented(specialized) &&
        Type.isEffect(specialized.contract) &&
        Type.isExactRepresentationArgument(specialized.representation.argument) &&
        Type.isEffectIdentityArgument(specialized.representation.argument.identity)
        ? (context.resolveEffectIdentity?.(specialized.representation.argument.identity) ??
            specialized.representation.argument.identity.identity)
        : undefined
    }
    if (
      expression._tag !== 'Unavailable' &&
      expression._tag !== 'Call' &&
      expression._tag !== 'EffectConstruct' &&
      expression._tag !== 'ServiceEffectConstruct'
    ) {
      const identity = exactIdentity(expression.type)
      if (identity !== undefined) return identity
    }
    if (expression._tag === 'Call' || expression._tag === 'EffectConstruct') {
      const target = targetFunction(context.results, expression.target)
      if (target !== undefined && forwardedRequirementBinding(target) !== undefined) {
        const identity = exactIdentity(expression.type)
        if (identity !== undefined) return identity
      }
    }
    if (expression._tag === 'Project') {
      const declaration = DeclarationFacts.byCanonical(context.index, {
        _tag: 'CanonicalDeclarationId',
        module: expression.nominal.module,
        name: expression.nominal.name,
      })
      const field =
        declaration?._tag === 'StructDeclaration'
          ? declaration.fields.find(
              (candidate) => candidate.id.ordinal === expression.field.ordinal,
            )
          : undefined
      const substitution =
        declaration?._tag === 'StructDeclaration'
          ? TypeInference.substitution(
              declaration.typeParameters.map((parameter) => parameter.type),
              expression.nominal.arguments,
            )
          : undefined
      if (field?.declaredType._tag === 'RepresentationParameter' && substitution !== undefined) {
        const argument = substitution.get(Type.key(field.declaredType.parameter))
        if (
          argument !== undefined &&
          Type.isExactRepresentationArgument(argument) &&
          Type.isEffectIdentityArgument(argument.identity)
        )
          return context.resolveEffectIdentity?.(argument.identity) ?? argument.identity.identity
      }
      if (field?.declaredType._tag === 'Resolved' && substitution !== undefined) {
        const projected = Type.substitute(field.declaredType.type, substitution)
        const identity = exactIdentity(projected)
        if (identity !== undefined) return identity
      }
    }
    if (expression._tag === 'EffectBlock') return effectIdentity(context.owner, expression.site)
    if (expression._tag === 'EffectCatch')
      return effectIdentity(
        context.owner,
        Tir.effectCatchSite(
          Tir.nodeReference(Tir.functionArtifact(context.fn), expression),
          context.owner.declaration,
          context.fn.declaration.id.ordinal,
        ),
      )
    if (expression._tag === 'BuiltinCall' && expression.witnessEffectSite === undefined) {
      const specialized = Specialization.specializeType(context.owner, expression.type, [
        context.substitution,
      ])
      if (Type.isEffect(specialized))
        return effectIdentity(
          context.owner,
          Tir.builtinEffectSite(
            Tir.nodeReference(Tir.functionArtifact(context.fn), expression),
            context.owner.declaration,
            context.fn.declaration.id.ordinal,
          ),
        )
    }
    if (
      (expression._tag === 'InterfaceOperationCall' || expression._tag === 'BuiltinCall') &&
      expression.witnessEffectSite !== undefined
    )
      return effectIdentity(context.owner, expression.witnessEffectSite)
    if (expression._tag === 'ParameterReference')
      return parameterEffectIdentity(context.fn, context.owner, expression.parameter.ordinal)
    if (expression._tag === 'BindingReference') {
      const initializer = callableBindings(context.fn).get(expression.binding.ordinal)
      return initializer === undefined ? undefined : effectOriginOf(initializer, context)
    }
    if (expression._tag === 'Move') return effectOriginOf(expression.subject, context)
    // A return-site join has no single exact identity; its composite representation is read
    // from the expression type instead.
    if (expression._tag === 'UnionConvert')
      return expression.conversion === 'EffectJoin'
        ? undefined
        : effectOriginOf(expression.source, context)
    if (expression._tag === 'Run') return successEffectOriginOf(expression.subject, context)
    if (expression._tag === 'Match') {
      const identities = expression.arms.flatMap((arm) => {
        if (!arm.reachable) return []
        const identity =
          arm.body._tag === 'Expression' ? effectOriginOf(arm.body.expression, context) : undefined
        return identity === undefined ? [] : [identity]
      })
      return identities.length !== 0 && new Set(identities).size === 1
        ? identities.at(0)
        : undefined
    }
    if (expression._tag === 'ServiceEffectConstruct')
      return context.resolveServiceEffectIdentity?.(expression)
    if (expression._tag === 'CallableApply') {
      const targetKey = targetKeyOfInvocation(expression, context)
      if (targetKey === undefined) return undefined
      const target = targetFunction(context.results, targetKey.declaration)
      if (target === undefined) return undefined
      return resultEffectIdentity(
        target,
        targetKey,
        context.results,
        context.index,
        context.resolving,
      )
    }
    if (expression._tag !== 'Call' && expression._tag !== 'EffectConstruct') return undefined
    const targetKey = targetKeyOfInvocation(expression, context)
    const target =
      targetKey === undefined ? undefined : targetFunction(context.results, expression.target)
    if (targetKey === undefined || target === undefined) return undefined
    return resultEffectIdentity(
      target,
      targetKey,
      context.results,
      context.index,
      context.resolving,
    )
  }

  /**
   * The hidden identity of the Effect one Effect value succeeds with: what `run expression` yields
   * when the success itself is an Effect. Traced through the producer's body; a parameter resolves
   * to the caller's argument while a call chain is open, otherwise through the minted identity.
   */
  const successEffectOriginOf = (
    expression: Tir.Expression,
    context: EffectOriginContext,
  ): string | undefined => {
    if (expression._tag === 'EffectBlock') {
      return commonOrigin(
        Tir.returnExpressions(expression.statements).map((returned) =>
          effectOriginOf(returned, context),
        ),
        (identity) => identity,
      )
    }
    if (expression._tag === 'BindingReference') {
      const initializer = callableBindings(context.fn).get(expression.binding.ordinal)
      return initializer === undefined ? undefined : successEffectOriginOf(initializer, context)
    }
    if (expression._tag === 'Move') return successEffectOriginOf(expression.subject, context)
    if (expression._tag === 'UnionConvert') return successEffectOriginOf(expression.source, context)
    if (expression._tag === 'EffectBindRequirement')
      return successEffectOriginOf(expression.protected, context)
    if (expression._tag === 'Match') {
      const identities = expression.arms.flatMap((arm) => {
        if (!arm.reachable) return []
        const identity =
          arm.body._tag === 'Expression'
            ? successEffectOriginOf(arm.body.expression, context)
            : undefined
        return identity === undefined ? [] : [identity]
      })
      return identities.length !== 0 && new Set(identities).size === 1
        ? identities.at(0)
        : undefined
    }
    if (expression._tag === 'ParameterReference') {
      const ordinal = expression.parameter.ordinal
      const argument = context.parameterArguments?.arguments.at(ordinal)
      if (context.parameterArguments !== undefined && argument !== undefined)
        return successEffectOriginOf(argument, context.parameterArguments.context)
      const identity = parameterEffectIdentity(context.fn, context.owner, ordinal)
      return identity === undefined
        ? undefined
        : context.successOfIdentity?.(identity, context.resolving)
    }
    if (expression._tag !== 'Call' && expression._tag !== 'EffectConstruct') return undefined
    const targetKey = targetKeyOfInvocation(expression, context)
    const target =
      targetKey === undefined ? undefined : targetFunction(context.results, expression.target)
    if (targetKey === undefined || target === undefined) return undefined
    const substitution = instanceSubstitution(target, targetKey)
    const returned = Tir.returnExpressions(target.statements)
    if (substitution === undefined || returned.length === 0) return undefined
    const marker = `success:${keyText(targetKey)}`
    if (context.resolving.has(marker)) return undefined
    return commonOrigin(
      returned.map((result) =>
        successEffectOriginOf(result, {
          fn: target,
          evidence: evidenceOf(context.results, target),
          owner: targetKey,
          substitution,
          compatibility: selectedCompatibility(target, targetKey),
          results: context.results,
          index: context.index,
          resolving: new Set(context.resolving).add(marker),
          ...(context.resolveEffectIdentity === undefined
            ? {}
            : { resolveEffectIdentity: context.resolveEffectIdentity }),
          ...(context.successOfIdentity === undefined
            ? {}
            : { successOfIdentity: context.successOfIdentity }),
          parameterArguments: { arguments: expression.arguments, context },
        }),
      ),
      (identity) => identity,
    )
  }

  /**
   * Resolves a minted effect identity to its success identity once every instance is known: a block
   * whose success is a parameter's success has no caller to trace through, so the parameter's
   * identity is followed to the block that minted it, in that block's own instance.
   */
  const successIdentityResolver = (
    instances: ReadonlyArray<Pick<Instance, 'key' | 'function' | 'substitution'>>,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
  ): NonNullable<EffectOriginContext['successOfIdentity']> => {
    const successOfIdentity = (
      identity: string,
      resolving: ReadonlySet<string>,
    ): string | undefined => {
      if (resolving.has(identity)) return undefined
      for (const instance of instances) {
        for (const block of callableExpressions(instance.function)) {
          if (block._tag !== 'EffectBlock' || effectIdentity(instance.key, block.site) !== identity)
            continue
          return successEffectOriginOf(block, {
            fn: instance.function,
            evidence: evidenceOf(results, instance.function),
            owner: instance.key,
            substitution: instance.substitution,
            compatibility: selectedCompatibility(instance.function, instance.key),
            results,
            index,
            resolving: new Set(resolving).add(identity),
            successOfIdentity,
          })
        }
      }
      return undefined
    }
    return successOfIdentity
  }

  const effectSuccesses = (
    fn: Tir.TirFunction,
    owner: InstanceKey,
    substitution: Type.Substitution,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
    instances: ReadonlyArray<Pick<Instance, 'key' | 'function' | 'substitution'>>,
  ): NonNullable<Instance['effectSuccesses']> => {
    const context: EffectOriginContext = {
      fn,
      evidence: evidenceOf(results, fn),
      owner,
      substitution,
      compatibility: selectedCompatibility(fn, owner),
      results,
      index,
      resolving: new Set<string>(),
      successOfIdentity: successIdentityResolver(instances, results, index),
    }
    return callableExpressions(fn).flatMap((expression) => {
      if (expression._tag !== 'EffectBlock') return []
      const success = Type.substitute(expression.type.success, substitution, context.compatibility)
      if (!Type.isEffect(success)) return []
      const identity = successEffectOriginOf(expression, context)
      return identity === undefined ? [] : [{ site: expression.site, identity }]
    })
  }

  const interfaceCallOf = (
    expression: Extract<
      Tir.Expression,
      { readonly _tag: 'InterfaceOperationCall' | 'BuiltinCall' }
    >,
    context: EffectOriginContext,
  ): Extract<Tir.Expression, { readonly _tag: 'Call' }> | undefined => {
    const bound =
      expression._tag === 'InterfaceOperationCall' ? expression : expression.interfaceOperation
    if (bound === undefined || expression.witnessEffectSite !== undefined) return undefined
    const capability = Type.substitute(
      bound.capability,
      context.substitution,
      context.compatibility,
    )
    if (!Type.isNominal(capability)) return undefined
    const witness = ConformanceProof.interfaceWitnessTarget(
      context.index,
      Type.substitute(bound.provider, context.substitution, context.compatibility),
      capability,
      bound.operation,
      bound.contract,
      context.substitution,
    )
    if (witness === undefined) return undefined
    return {
      _tag: 'Call',
      target: witness.implementation,
      symbolicConformances: [],
      typeArguments: witness.typeArguments,
      evidence: { _tag: 'TirEvidence' as const, ordinal: -1 },
      staticArguments: [],
      arguments: expression.arguments,
      loanEnds: expression.loanEnds,
      heldLoans: expression._tag === 'BuiltinCall' ? expression.heldLoans : [],
      type: expression.type,
      span: expression.span,
      origin: expression.origin,
    }
  }

  const directCallInstances = (
    fn: Tir.TirFunction,
    owner: InstanceKey,
    substitution: Type.Substitution,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
  ): ReadonlyArray<CallInstance> => {
    const expressions = fn.statements.flatMap(Tir.statementExpressions).flatMap(Tir.expressionTree)
    const expressionOrder = new Map(expressions.map((expression, ordinal) => [expression, ordinal]))
    const calls = new Map<string, { readonly call: CallInstance; readonly ordinal: number }>()
    const record = (
      expression: Extract<
        Tir.Expression,
        { readonly _tag: 'Call' | 'EffectConstruct' | 'CallableApply' }
      >,
      target: InstanceKey,
    ): void => {
      const ordinal = expressionOrder.get(expression)
      // Origin inference may inspect a callee's returned expression. Those calls belong to that
      // callee's discovery pass, not to the owner whose argument identity is currently inferred.
      if (ordinal === undefined) return
      const targetFn = targetFunction(results, target.declaration)
      if (targetFn === undefined) return
      const resultEffect = resultEffectIdentity(targetFn, target, results, index)
      const span = expression.span
      calls.set(
        `${span.sourceId}:${span.start}:${span.end}\u0000${expression.id?.ordinal ?? -1}\u0000${keyText(target)}`,
        {
          call: {
            _tag: 'CallInstance',
            owner,
            ...(expression.id === undefined ? {} : { node: expression.id }),
            span,
            target,
            ...((expression._tag === 'Call' || expression._tag === 'EffectConstruct') &&
            expression.staticArgumentOrigins !== undefined
              ? { staticArgumentOrigins: expression.staticArgumentOrigins }
              : {}),
            ...(resultEffect === undefined ? {} : { resultEffect }),
          },
          ordinal,
        },
      )
    }
    const context: EffectOriginContext = {
      fn,
      evidence: evidenceOf(results, fn),
      owner,
      substitution,
      compatibility: selectedCompatibility(fn, owner),
      results,
      index,
      resolving: new Set<string>(),
      recordResolvedCall: (expression, target) => {
        if (expression._tag === 'CallableApply') {
          if (
            Type.isEffect(expression.type) ||
            target.typeArguments.some(Type.isHiddenExecutableArgument)
          )
            record(expression, target)
          return
        }
        if (carriesHiddenIdentity(expression, substitution)) record(expression, target)
      },
    }
    expressions.forEach((expression) => {
      if (
        (expression._tag === 'InterfaceOperationCall' || expression._tag === 'BuiltinCall') &&
        expression.witnessEffectSite === undefined
      ) {
        const call = interfaceCallOf(expression, context)
        if (call === undefined) return
        if (!carriesHiddenIdentity(call, substitution)) return
        const ordinal = expressionOrder.get(expression)
        if (ordinal === undefined) return
        // Use the ordinary call-origin machinery to preserve executable operand identities.
        // The synthetic call shares its authored interface call's place in discovery order.
        expressionOrder.set(call, ordinal)
        targetKeyOfInvocation(call, context)
        return
      }
      if (expression._tag === 'CallableApply') {
        targetKeyOfInvocation(expression, context)
        return
      }
      if (expression._tag !== 'Call' && expression._tag !== 'EffectConstruct') return
      // Calls carrying neither an Effect nor a callable value remain on the original
      // finite-specialization path. Resolving them here as well would bypass its
      // polymorphic-recursion guard.
      if (!carriesHiddenIdentity(expression, substitution)) return
      targetKeyOfInvocation(expression, context)
    })
    return [...calls.values()]
      .sort((left, right) => left.ordinal - right.ordinal)
      .map(({ call }) => call)
  }

  const callableValue = (
    expression: Tir.Expression,
    bindings: ReadonlyMap<number, Tir.Expression>,
  ): Extract<Tir.Expression, { readonly _tag: 'FunctionItem' | 'CallableSection' }> | undefined => {
    if (expression._tag === 'FunctionItem' || expression._tag === 'CallableSection')
      return expression
    if (expression._tag === 'BindingReference') {
      const initializer = bindings.get(expression.binding.ordinal)
      return initializer === undefined ? undefined : callableValue(initializer, bindings)
    }
    if (expression._tag === 'Move') return callableValue(expression.subject, bindings)
    return undefined
  }

  const mergeSubstitution = (
    first: Type.Substitution,
    second: Type.Substitution,
  ): Type.Substitution => new Map([...first, ...second])

  const callableExpressions = (fn: Tir.TirFunction): ReadonlyArray<Tir.Expression> => {
    const cached = callableExpressionsCache.get(fn)
    if (cached !== undefined) return cached
    const expressions = fn.statements.flatMap((statement) =>
      Tir.statementExpressions(statement).flatMap(Tir.expressionTree),
    )
    callableExpressionsCache.set(fn, expressions)
    return expressions
  }

  const declarationTarget = (
    target: Tir.CallableTarget,
  ): DeclarationFacts.CanonicalId | undefined =>
    target._tag === 'DeclarationCallableTarget' ? target.declaration : undefined

  function targetFunction(
    results: ReadonlyMap<string, Elaboration.Result>,
    target: DeclarationFacts.CanonicalId,
  ): Tir.TirFunction | undefined {
    return FunctionIndex.tirByName(results.get(target.module)?.tir, target.name)
  }

  // A quantified function item omits its invocation regions; those universal proofs do not
  // create runtime specializations. Keep declaration order and require every other argument.
  const callableTargetArguments = (
    fn: Tir.TirFunction,
    arguments_: ReadonlyArray<Type.GenericArgument>,
  ): ReadonlyArray<Type.GenericArgument> | undefined => {
    const parameters = fn.declaration.typeParameters
    if (arguments_.length === parameters.length) return arguments_
    const invocationBinders = new Set(
      DeclarationFacts.executableLifetimes(fn.declaration).lifetimeBinders.map(Lifetime.key),
    )
    // Anonymous declarations also retain outer lifetimes. Only their own invocation
    // binders may be absent; captured outer arguments still select the environment.
    const invocation = (parameter: DeclarationFacts.TypeParameterFact): boolean => {
      const argument = Type.parameterArgument(parameter.type)
      const owner = fn.declaration.canonical
      return (
        owner._tag === 'Canonical' &&
        parameter.type.owner.module === owner.id.module &&
        parameter.type.owner.name === owner.id.name &&
        Lifetime.isLifetime(argument) &&
        invocationBinders.has(Lifetime.key(argument))
      )
    }
    if (arguments_.length !== parameters.filter((parameter) => !invocation(parameter)).length)
      return undefined
    let ordinal = 0
    const complete: Array<Type.GenericArgument> = []
    for (const parameter of parameters) {
      const argument = invocation(parameter)
        ? Type.parameterArgument(parameter.type)
        : arguments_.at(ordinal++)
      if (argument === undefined) return undefined
      complete.push(argument)
    }
    return complete
  }

  const targetArguments = (
    target: Tir.CallableTarget,
    substitution: Type.Substitution,
    results: ReadonlyMap<string, Elaboration.Result>,
  ): ReadonlyArray<Type.GenericArgument> | undefined => {
    const declaration = declarationTarget(target)
    if (declaration === undefined) return []
    const fn = targetFunction(results, declaration)
    if (fn === undefined) return undefined
    const invocationBinders = new Set(
      DeclarationFacts.executableLifetimes(fn.declaration).lifetimeBinders.map(Lifetime.key),
    )
    const arguments_ = fn.declaration.typeParameters.flatMap((parameter) => {
      const declared = Type.parameterArgument(parameter.type)
      const type =
        substitution.get(Type.key(parameter.type)) ??
        (Lifetime.isLifetime(declared) && invocationBinders.has(Lifetime.key(declared))
          ? declared
          : undefined)
      return type === undefined ? [] : [type]
    })
    return arguments_.length === fn.declaration.typeParameters.length ? arguments_ : undefined
  }

  const callableCallTargets = (
    fn: Tir.TirFunction,
    owner: InstanceKey,
    ownerSubstitution: Type.Substitution,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
  ): ReadonlyArray<CallTarget> => {
    const bindings = callableBindings(fn)
    const targets: Array<CallTarget> = []
    const context: EffectOriginContext = {
      fn,
      evidence: evidenceOf(results, fn),
      owner,
      substitution: ownerSubstitution,
      compatibility: selectedCompatibility(fn, owner),
      results,
      index,
      resolving: new Set<string>(),
    }
    for (const expression of callableExpressions(fn)) {
      if (expression._tag === 'CallableApply') {
        const key = targetKeyOfInvocation(expression, context)
        if (key !== undefined) {
          targets.push({ declaration: key.declaration, typeArguments: key.typeArguments })
          continue
        }
        // A finite Effect composite deliberately has no single hidden effect identity. Preserve
        // the ordinary specialization edge for such applications so lowering can recover the
        // result representation from the specialized declaration, while exact callable/effect
        // identities above continue to select their fully specialized target.
        const fallback =
          callableValue(expression.callee, bindings) ??
          staticallyForwardedCallable(expression.callee, fn, results)
        if (fallback?._tag === 'FunctionItem' || fallback?._tag === 'CallableSection') {
          const declaration = declarationTarget(fallback.target)
          const substitution =
            fallback._tag === 'CallableSection'
              ? mergeSubstitution(fallback.substitution, expression.substitution)
              : expression.substitution
          const arguments_ = targetArguments(fallback.target, substitution, results)
          if (declaration !== undefined && arguments_ !== undefined)
            targets.push({ declaration, typeArguments: arguments_ })
        }
        continue
      }
      const value =
        expression._tag === 'FunctionItem' || expression._tag === 'CallableSection'
          ? expression
          : undefined
      if (
        value === undefined ||
        (value._tag !== 'FunctionItem' && value._tag !== 'CallableSection')
      )
        continue
      const declaration = declarationTarget(value.target)
      if (declaration === undefined) continue
      const target = targetFunction(results, declaration)
      if (target === undefined) continue
      const substitution = value._tag === 'CallableSection' ? value.substitution : new Map()
      let arguments_: ReadonlyArray<Type.GenericArgument> | undefined
      if (value._tag === 'FunctionItem') {
        arguments_ = callableTargetArguments(
          target,
          value.typeArguments.map((argument) =>
            Type.substituteGenericArgument(argument, ownerSubstitution),
          ),
        )
      } else {
        arguments_ = targetArguments(value.target, substitution, results)
      }
      if (arguments_ === undefined) continue
      const selected = TypeInference.selectedSubstitution(
        target.declaration.typeParameters.map((parameter) => parameter.type),
        arguments_,
      )
      if (selected === undefined) continue
      const targetSubstitution = selected.substitution
      const hidden: Array<Type.EffectIdentityArgument | Type.CallableIdentityArgument> = []
      let complete = true
      for (const ordinal of effectParameterOrdinals(target, targetSubstitution)) {
        const capture =
          value._tag === 'CallableSection'
            ? value.captures.find((candidate) => candidate.parameterOrdinal === ordinal)
            : undefined
        const identity = capture === undefined ? undefined : effectOriginOf(capture.value, context)
        if (identity === undefined) {
          complete = false
          break
        }
        hidden.push(Type.effectIdentityArgument(identity))
      }
      if (!complete) continue
      for (const ordinal of callableParameterOrdinals(target, targetSubstitution)) {
        const capture =
          value._tag === 'CallableSection'
            ? value.captures.find((candidate) => candidate.parameterOrdinal === ordinal)
            : undefined
        const identity =
          capture === undefined ? undefined : callableOriginOf(capture.value, context)
        if (identity === undefined) {
          complete = false
          break
        }
        hidden.push(identity)
      }
      if (complete) targets.push({ declaration, typeArguments: [...arguments_, ...hidden] })
    }
    return targets
  }

  const forwardedRequirementTargets = (
    targets: ReadonlyArray<CallTarget>,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
  ): ReadonlyArray<CallTarget> =>
    targets.flatMap((target) => {
      const fn = targetFunction(results, target.declaration)
      const binding = fn === undefined ? undefined : forwardedRequirementBinding(fn)
      if (fn === undefined || binding === undefined) return []
      const selected = TypeInference.selectedSubstitution(
        fn.declaration.typeParameters.map((parameter) => parameter.type),
        target.typeArguments.filter((argument) => !Type.isHiddenExecutableArgument(argument)),
      )
      if (selected === undefined) return []
      const witness = requirementBindingWitness(binding, selected.substitution, index)
      return witness?._tag === 'SourceConformanceWitness'
        ? witnessDependencyCallTargets(index, witness.provider, witness.capability)
        : []
    })

  const concreteCallables = (
    fn: Tir.TirFunction,
    owner: InstanceKey,
    ownerSubstitution: Type.Substitution,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
    resolveCallable: (identity: Type.CallableIdentityArgument) => CallableInstance | undefined,
  ): ReadonlyArray<CallableInstance> => {
    const expressions = callableExpressions(fn)
    const bindings = callableBindings(fn)
    const sections = expressions.flatMap((expression) =>
      expression._tag === 'CallableSection' ? [expression] : [],
    )
    // Discovery asks once per ancestry context; most bodies construct no callable at all.
    if (
      sections.length === 0 &&
      !expressions.some(
        (expression) => expression._tag === 'CallableApply' && expression.staged !== undefined,
      )
    )
      return []
    const seen = new Set<string>()
    const instances: Array<CallableInstance> = []
    const context: EffectOriginContext = {
      fn,
      evidence: evidenceOf(results, fn),
      owner,
      substitution: ownerSubstitution,
      compatibility: selectedCompatibility(fn, owner),
      results,
      index,
      resolving: new Set<string>(),
    }
    for (const section of sections) {
      const site = Tir.executableSiteKey(section.site)
      if (seen.has(site)) continue
      seen.add(site)
      const applications = expressions.flatMap((expression) =>
        expression._tag === 'CallableApply' &&
        (callableValue(expression.callee, bindings) ??
          staticallyForwardedCallable(expression.callee, fn, results)) === section
          ? [expression]
          : [],
      )
      const candidates: ReadonlyArray<Type.Substitution> =
        applications.length === 0
          ? [new Map()]
          : applications.map((application) => application.substitution)
      for (const applicationSubstitution of candidates) {
        const raw = mergeSubstitution(section.substitution, applicationSubstitution)
        const substitution = new Map(
          [...raw].map(([parameter, argument]) => [
            parameter,
            Type.substituteGenericArgument(argument, ownerSubstitution),
          ]),
        )
        const type = specializeInstanceType(section.type, owner, [ownerSubstitution, substitution])
        const arguments_ = targetArguments(section.target, substitution, results)
        const captureTypes = section.captures.flatMap((capture) =>
          capture.value._tag === 'Unavailable'
            ? []
            : [
                specializeInstanceType(capture.value.type, owner, [
                  ownerSubstitution,
                  substitution,
                ]),
              ],
        )
        if (
          !Type.isCallable(type) ||
          !Type.isRuntimeConcrete(type) ||
          arguments_ === undefined ||
          arguments_.some((argument) => !Type.isRuntimeConcreteGenericArgument(argument)) ||
          captureTypes.length !== section.captures.length ||
          captureTypes.some((capture) => !Type.isRuntimeConcrete(capture))
        ) {
          continue
        }
        instances.push({
          _tag: 'CallableInstance',
          owner,
          site: section.site,
          target: section.target,
          typeArguments: arguments_,
          substitution,
          captureTypes: captureTypes,
          captures: section.captures.flatMap((capture, ordinal) => {
            const type_ = captureTypes.at(ordinal)
            const callableIdentity =
              type_ !== undefined && Type.isCallable(type_)
                ? callableOriginOf(capture.value, {
                    fn,
                    evidence: evidenceOf(results, fn),
                    owner,
                    substitution: ownerSubstitution,
                    compatibility: selectedCompatibility(fn, owner),
                    results,
                    index,
                    resolving: new Set<string>(),
                  })
                : undefined
            if (type_ === undefined) {
              return []
            }
            return [
              {
                ordinal: capture.ordinal,
                parameterOrdinal: capture.parameterOrdinal,
                access: capture.access,
                type: type_,
                ...(callableIdentity === undefined ? {} : { callableIdentity }),
              },
            ]
          }),
          type,
          mode: section.mode,
        })
      }
    }
    // A staged application splices the base value's environment ahead of its own captures, so
    // its instance lists every capture the target will receive. Bases resolve in source order:
    // a section or earlier stage of this body, or a callable this instance was specialized on.
    for (const expression of expressions) {
      if (expression._tag !== 'CallableApply' || expression.staged === undefined) continue
      const staged = expression.staged
      const site = Tir.executableSiteKey(staged.site)
      if (seen.has(site)) continue
      seen.add(site)
      const identity = callableOriginOf(expression.callee, context)
      if (identity === undefined) continue
      const environment = identity.environment
      const base =
        environment === undefined
          ? undefined
          : (instances.find(
              (candidate) =>
                Type.runtimeCallableEnvironmentIdentityKey(environment) ===
                Type.runtimeCallableEnvironmentIdentityKey(
                  Tir.callableEnvironmentIdentity(candidate.site, {
                    declaration: candidate.owner.declaration,
                    typeArguments: candidate.owner.typeArguments,
                    staticArgumentKeys: candidate.owner.staticArguments.map(StaticValue.key),
                  }),
                ),
            ) ?? resolveCallable(identity))
      if (environment !== undefined && base === undefined) continue
      const calleeType =
        expression.callee._tag === 'Unavailable'
          ? undefined
          : specializeInstanceType(expression.callee.type, owner, [ownerSubstitution])
      const type = specializeInstanceType(expression.type, owner, [ownerSubstitution])
      if (
        calleeType === undefined ||
        !Type.isCallable(calleeType) ||
        !Type.isCallable(type) ||
        !Type.isRuntimeConcrete(type)
      )
        continue
      const baseCaptures = base?.captures ?? []
      const remaining = Array.from(
        { length: baseCaptures.length + calleeType.parameters.length },
        (_, ordinal) => ordinal,
      ).filter((ordinal) => !baseCaptures.some((capture) => capture.parameterOrdinal === ordinal))
      const offset = remaining.length - expression.arguments.length
      const captures: Array<CallableInstance['captures'][number]> = [...baseCaptures]
      const captureTypes: Array<Type.Type> = [...(base?.captureTypes ?? [])]
      let complete = true
      for (const [ordinal, argument] of expression.arguments.entries()) {
        const capture = staged.captures.at(ordinal)
        const parameterOrdinal = remaining.at(offset + ordinal)
        if (
          argument._tag === 'Unavailable' ||
          capture === undefined ||
          parameterOrdinal === undefined
        ) {
          complete = false
          break
        }
        const captureType = specializeInstanceType(argument.type, owner, [ownerSubstitution])
        if (!Type.isRuntimeConcrete(captureType)) {
          complete = false
          break
        }
        const callableIdentity = Type.isCallable(captureType)
          ? callableOriginOf(argument, context)
          : undefined
        captures.push({
          ordinal: baseCaptures.length + ordinal,
          parameterOrdinal,
          access: capture.access,
          type: captureType,
          ...(callableIdentity === undefined ? {} : { callableIdentity }),
        })
        captureTypes.push(captureType)
      }
      if (!complete) continue
      instances.push({
        _tag: 'CallableInstance',
        owner,
        site: staged.site,
        target: Tir.callableTargetFromIdentity(identity.target),
        typeArguments: identity.typeArguments,
        substitution: base?.substitution ?? new Map(),
        captureTypes: captureTypes,
        captures: captures,
        type,
        mode: type.mode,
      })
    }
    return instances
  }

  /**
   * Collects specialized semantic facts for every source Effect construction. Represented fields
   * consume these published facts instead of recovering a runner from construction syntax.
   */
  const concreteEffects = (
    instances: ReadonlyArray<Instance>,
    suspension: ReadonlyMap<string, SuspensionMode.Summary>,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
    callables: ReadonlyArray<CallableInstance>,
  ): ReadonlyArray<EffectInstance> => {
    const effects = new Map<string, EffectInstance>()
    for (const instance of instances) {
      const bindings = callableBindings(instance.function)
      const context: EffectOriginContext = {
        fn: instance.function,
        evidence: instance.view.evidence,
        owner: instance.key,
        substitution: instance.substitution,
        compatibility: selectedCompatibility(instance.function, instance.key),
        results,
        index,
        resolving: new Set<string>(),
      }
      const blocks = callableExpressions(instance.function).flatMap((expression) =>
        expression._tag === 'EffectBlock' ? [expression] : [],
      )
      for (const block of blocks) {
        const specializedType = specializeInstanceType(block.type, instance.key, [
          instance.substitution,
        ])
        if (!Type.isEffect(specializedType) || !Type.isRuntimeConcrete(specializedType)) continue
        const providedRequirements = block.statements
          .flatMap(Tir.statementExpressions)
          .flatMap(Tir.expressionTree)
          .flatMap((expression) => {
            if (expression._tag !== 'EffectBindRequirement') return []
            const selected = selectedRequirement(expression, instance.substitution)
            return selected !== undefined && Type.isNominal(selected.capability)
              ? [
                  {
                    parameter: expression.provider.parameter?.ordinal,
                    capability: selected.capability,
                    role: selected.role,
                    requirementAccess: selected.access,
                    providerAccess: expression.provider.selectionAccess,
                  },
                ]
              : []
          })
          .sort((left, right) => {
            const leftKey = `${left.parameter ?? -1}\0${Type.runtimeKey(left.capability)}\0${left.role}`
            const rightKey = `${right.parameter ?? -1}\0${Type.runtimeKey(right.capability)}\0${right.role}`
            if (leftKey < rightKey) {
              return -1
            }
            if (leftKey > rightKey) {
              return 1
            }
            return 0
          })
        const captures = block.captures.flatMap((capture, ordinal) => {
          let source: 'Pattern' | 'Binding' | 'Parameter'
          if (capture.pattern !== undefined) source = 'Pattern'
          else if (capture.binding !== undefined) source = 'Binding'
          else source = 'Parameter'
          const sourceOrdinal =
            capture.pattern?.ordinal ?? capture.binding?.ordinal ?? capture.parameter?.ordinal
          const initializer =
            sourceOrdinal === undefined || source !== 'Binding'
              ? undefined
              : bindings.get(sourceOrdinal)
          let sourceType: Type.Type | undefined
          if (sourceOrdinal === undefined) {
            sourceType = undefined
          } else if (capture.pattern !== undefined) {
            const pattern = capture.pattern
            const reference = callableExpressions(instance.function).find(
              (expression) =>
                expression._tag === 'PatternBindingReference' &&
                expression.binding.ordinal === pattern.ordinal,
            )
            sourceType = reference?._tag === 'PatternBindingReference' ? reference.type : undefined
          } else if (source === 'Parameter') {
            if (instance.function.contract._tag === 'Contract') {
              const runtimeOrdinal = instance.function.declaration.parameters
                .filter((parameter) => parameter.phase === 'Runtime')
                .findIndex((parameter) => parameter.id.ordinal === sourceOrdinal)
              sourceType =
                runtimeOrdinal < 0
                  ? undefined
                  : instance.function.contract.parameters.at(runtimeOrdinal)
            } else {
              sourceType = undefined
            }
          } else if (initializer === undefined || initializer._tag === 'Unavailable') {
            sourceType = undefined
          } else {
            sourceType = initializer.type
          }
          if (sourceOrdinal === undefined || sourceType === undefined) return []
          const specialized = specializeInstanceType(sourceType, instance.key, [
            instance.substitution,
          ])
          if (!Type.isRuntimeConcrete(specialized)) return []
          let capturedEffectIdentity: string | undefined
          const representedEffect =
            Type.isRepresented(specialized) &&
            Type.isEffect(specialized.contract) &&
            Type.isExactRepresentationArgument(specialized.representation.argument) &&
            Type.isEffectIdentityArgument(specialized.representation.argument.identity)
          if (Type.isEffect(specialized) || representedEffect) {
            if (source === 'Parameter') {
              capturedEffectIdentity = parameterEffectIdentity(
                instance.function,
                instance.key,
                sourceOrdinal,
              )
            } else if (initializer === undefined) {
              capturedEffectIdentity = undefined
            } else {
              capturedEffectIdentity = effectOriginOf(initializer, context)
            }
          } else {
            capturedEffectIdentity = undefined
          }
          let capturedCallableIdentity: Type.CallableIdentityArgument | undefined
          if (Type.isCallable(specialized)) {
            if (source === 'Parameter') {
              capturedCallableIdentity = parameterCallableIdentity(
                instance.function,
                instance.key,
                sourceOrdinal,
              )
            } else if (initializer === undefined) {
              capturedCallableIdentity = undefined
            } else {
              capturedCallableIdentity = callableOriginOf(initializer, context)
            }
          } else {
            capturedCallableIdentity = undefined
          }
          let providedRequirement:
            | Readonly<{
                parameter: number | undefined
                capability: Type.Nominal
                role: string
                requirementAccess: Type.Requirement['access']
                providerAccess: 'Take' | 'Exclusive' | 'Shared'
              }>
            | undefined
          if (source === 'Parameter') {
            providedRequirement =
              providedRequirements.find((requirement) => requirement.parameter === sourceOrdinal) ??
              instance.specialization.evidence
                .flatMap((evidence) => {
                  if (
                    evidence._tag !== 'RequirementSelection' ||
                    !Type.isNominal(evidence.selected.capability)
                  )
                    return []
                  const providerMatches = Type.isReference(specialized)
                    ? Type.equals(specialized.target, evidence.provider) &&
                      specialized.access === evidence.providerMode
                    : evidence.providerMode === 'Take' &&
                      Type.equals(specialized, evidence.provider)
                  return providerMatches
                    ? [
                        {
                          parameter: sourceOrdinal,
                          capability: evidence.selected.capability,
                          role: evidence.selected.role,
                          requirementAccess: evidence.selected.access,
                          providerAccess: evidence.providerMode,
                        },
                      ]
                    : []
                })
                .at(0)
          } else {
            providedRequirement = undefined
          }
          return [
            {
              ordinal,
              source,
              sourceOrdinal,
              access: capture.access,
              type: specialized,
              ...(capturedEffectIdentity === undefined
                ? {}
                : { effectIdentity: capturedEffectIdentity }),
              ...(capturedCallableIdentity === undefined
                ? {}
                : { callableIdentity: capturedCallableIdentity }),
              ...(providedRequirement === undefined
                ? {}
                : {
                    providedRequirement: {
                      capability: providedRequirement.capability,
                      role: providedRequirement.role,
                      requirementAccess: providedRequirement.requirementAccess,
                      providerAccess: providedRequirement.providerAccess,
                    },
                  }),
            },
          ]
        })
        if (captures.length !== block.captures.length) continue
        const identity = effectIdentity(instance.key, block.site)
        effects.set(identity, {
          _tag: 'EffectInstance',
          representationIdentity: Tir.effectRepresentationIdentity(block.site),
          identity,
          owner: instance.key,
          site: block.site,
          runner: Tir.effectRunnerId(instance.key.declaration, block.site),
          typeArguments: [...instance.key.typeArguments],
          captures: captures,
          type: specializedType,
          suspension: suspension.get(effectNode(identity)) ?? SuspensionMode.direct,
        })
      }
      const catches = callableExpressions(instance.function).flatMap((expression) =>
        expression._tag === 'EffectCatch' ? [expression] : [],
      )
      for (const catch_ of catches) {
        if (catch_.protected._tag === 'Unavailable' || catch_.handler._tag === 'Unavailable')
          continue
        const type = specializeInstanceType(catch_.type, instance.key, [instance.substitution])
        const protectedType = specializeInstanceType(catch_.protected.type, instance.key, [
          instance.substitution,
        ])
        const handlerType = specializeInstanceType(catch_.handler.type, instance.key, [
          instance.substitution,
        ])
        const protectedIdentity = effectOriginOf(catch_.protected, context)
        const handlerIdentity = callableOriginOf(catch_.handler, context)
        if (
          !Type.isEffect(type) ||
          !Type.isRuntimeConcrete(type) ||
          !Type.isEffect(protectedType) ||
          !Type.isCallable(handlerType) ||
          protectedIdentity === undefined ||
          handlerIdentity === undefined
        )
          continue
        const site = Tir.effectCatchSite(
          Tir.nodeReference(instance.view.artifact, catch_),
          instance.key.declaration,
          instance.function.declaration.id.ordinal,
        )
        const identity = effectIdentity(instance.key, site)
        effects.set(identity, {
          _tag: 'EffectInstance',
          representationIdentity: Tir.effectRepresentationIdentity(site),
          identity,
          owner: instance.key,
          site,
          runner: Tir.effectRunnerId(instance.key.declaration, site),
          typeArguments: [...instance.key.typeArguments],
          captures: [
            {
              ordinal: 0,
              source: 'Binding' as const,
              sourceOrdinal: 0,
              access: 'Take' as const,
              type: protectedType,
              effectIdentity: protectedIdentity,
            },
            {
              ordinal: 1,
              source: 'Binding' as const,
              sourceOrdinal: 1,
              access: 'Take' as const,
              type: handlerType,
              callableIdentity: handlerIdentity,
            },
          ],
          type,
          suspension: suspension.get(effectNode(identity)) ?? SuspensionMode.direct,
        })
      }
      const builtins = callableExpressions(instance.function).flatMap((expression) =>
        expression._tag === 'BuiltinCall' && expression.witnessEffectSite === undefined
          ? [expression]
          : [],
      )
      for (const builtin of builtins) {
        const type = specializeInstanceType(builtin.type, instance.key, [instance.substitution])
        if (!Type.isEffect(type) || !Type.isRuntimeConcrete(type)) continue
        const captures = builtin.arguments.flatMap((argument, ordinal) => {
          if (argument._tag === 'Unavailable') return []
          const specialized = specializeInstanceType(argument.type, instance.key, [
            instance.substitution,
          ])
          if (!Type.isRuntimeConcrete(specialized)) return []
          const effectIdentity = Type.isEffect(specialized)
            ? effectOriginOf(argument, context)
            : undefined
          const callableIdentity = Type.isCallable(specialized)
            ? callableOriginOf(argument, context)
            : undefined
          let access: 'Copy' | 'Shared' | 'Exclusive' | 'Take' = 'Take'
          if (Type.isReference(specialized) || Type.isSlice(specialized)) {
            access = specialized.access
          } else if (Type.isCallable(specialized)) {
            access = specialized.mode
          }
          return [
            {
              ordinal,
              source: 'Binding' as const,
              sourceOrdinal: ordinal,
              access,
              type: specialized,
              ...(effectIdentity === undefined ? {} : { effectIdentity }),
              ...(callableIdentity === undefined ? {} : { callableIdentity }),
            },
          ]
        })
        if (captures.length !== builtin.arguments.length) continue
        const site = Tir.builtinEffectSite(
          Tir.nodeReference(instance.view.artifact, builtin),
          instance.key.declaration,
          instance.function.declaration.id.ordinal,
        )
        const identity = effectIdentity(instance.key, site)
        effects.set(identity, {
          _tag: 'EffectInstance',
          representationIdentity: Tir.effectRepresentationIdentity(site),
          identity,
          owner: instance.key,
          site,
          runner: Tir.effectRunnerId(instance.key.declaration, site),
          typeArguments: [...instance.key.typeArguments],
          captures: captures,
          type,
          suspension: suspension.get(effectNode(identity)) ?? SuspensionMode.direct,
        })
      }
    }
    const callableFor = (identity: Type.CallableIdentityArgument): CallableInstance | undefined =>
      callables.find(
        (candidate) =>
          identity.environment !== undefined &&
          Type.runtimeCallableEnvironmentIdentityKey(identity.environment) ===
            Type.runtimeCallableEnvironmentIdentityKey(
              Tir.callableEnvironmentIdentity(candidate.site, {
                declaration: candidate.owner.declaration,
                typeArguments: candidate.owner.typeArguments,
                staticArgumentKeys: candidate.owner.staticArguments.map(StaticValue.key),
              }),
            ) &&
          Tir.matchesCallableTargetIdentity(candidate.target, identity.target) &&
          identity.typeArguments.length === candidate.typeArguments.length &&
          identity.typeArguments.every((argument, ordinal) => {
            const expected = candidate.typeArguments.at(ordinal)
            return (
              expected !== undefined &&
              Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(expected)
            )
          }),
      )
    let refined = new Map(effects)
    for (let pass = 0; pass <= effects.size; pass += 1) {
      let changed = false
      const next = new Map(refined)
      for (const [identity, effect] of refined) {
        if (!('root' in effect.site)) continue
        const captures = effect.captures.map((capture) => {
          if (capture.source !== 'Parameter' || capture.access !== 'Take') return capture
          const capturedEffect =
            capture.effectIdentity === undefined ? undefined : refined.get(capture.effectIdentity)
          const capturedCallable =
            capture.callableIdentity === undefined
              ? undefined
              : callableFor(capture.callableIdentity)
          const copy =
            capturedEffect?.type.access === 'Shared' ||
            capturedCallable?.mode === 'Shared' ||
            (capture.effectIdentity === undefined &&
              capture.callableIdentity === undefined &&
              ConformanceProof.copyType(index, capture.type))
          return copy ? { ...capture, access: 'Copy' as const } : capture
        })
        let access: 'Take' | 'Exclusive' | 'Shared'
        if (captures.some((capture) => capture.access === 'Take')) {
          access = 'Take'
        } else if (captures.some((capture) => capture.access === 'Exclusive')) {
          access = 'Exclusive'
        } else {
          access = 'Shared'
        }
        if (
          access === effect.type.access &&
          captures.every((capture, ordinal) => capture === effect.captures.at(ordinal))
        )
          continue
        changed = true
        next.set(identity, {
          ...effect,
          captures: captures,
          type: Type.effectWithRows(
            effect.type.success,
            effect.type.failureRow,
            effect.type,
            access,
            effect.type.requirementRow,
          ),
        })
      }
      refined = next
      if (!changed) break
    }
    return [...refined.values()].sort((left, right) => left.identity.localeCompare(right.identity))
  }

  const functionByKey = (
    results: ReadonlyMap<string, Elaboration.Result>,
    key: InstanceKey,
  ): Tir.TirFunction | undefined =>
    FunctionIndex.tirByName(results.get(key.declaration.module)?.tir, key.declaration.name)

  const instanceNode = (key: InstanceKey): string => `instance\u0000${keyText(key)}`

  const suspensionGraph = (
    instances: ReadonlyArray<Instance>,
    results: ReadonlyMap<string, Elaboration.Result>,
    index: DeclarationIndex.Index,
    callables: ReadonlyArray<CallableInstance>,
  ): SuspensionGraph => {
    const nestedRoots = new Set<string>()
    const diagnosticObservations = new Set<string>()
    const recoveryExecutions = new Set<string>()
    const unresolvedDiagnosticExecutions = new Set<string>()
    const readinessExecutions = new Set<string>()
    const readinessCallbacks = new Set<string>()
    let unresolvedReadiness = false
    const terminalObservations: Array<{
      readonly execution: string
      readonly span: SourceSpan.SourceSpan
    }> = []
    let unresolvedRecovery = false
    const externalRoots = new Set<string>()
    const dependencies = new Map<string, Set<string>>()
    const diagnosticDependencies = new Map<string, Set<string>>()
    const effectIdentities = new Set<string>()
    const permitted = new Map<string, Set<SuspensionMode.Mode>>()
    const unavailable = new Set<string>()
    const nonParkingObligations = new Map<
      string,
      SuspensionGraph['nonParkingObligations'][number]
    >()
    const providedTargets = new Map<string, SuspensionGraph['providedTargets'][number]>()
    let cleanupEffects: ReadonlyMap<string, EffectInstance> | undefined
    const effectForCleanup = (identity: string): EffectInstance | undefined => {
      cleanupEffects ??= new Map(
        concreteEffects(instances, new Map(), results, index, []).map((effect) => [
          effect.identity,
          effect,
        ]),
      )
      return cleanupEffects.get(identity)
    }
    // A constructor carrying service Effects has no concrete argument identity until traversal
    // reaches it with a lexical provider. Keep that dependency so discovery can revisit the call.
    const deferredCalls = new Map<
      string,
      {
        readonly expression: Extract<Tir.Expression, { readonly _tag: 'Call' | 'EffectConstruct' }>
        readonly context: EffectOriginContext
      }
    >()
    const serviceCalls = new Map<
      string,
      {
        readonly service: Type.Nominal
        readonly role: string
        readonly access: 'Shared' | 'Exclusive'
        readonly operation: string
        readonly nonParking: boolean
        readonly expression: Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }>
        readonly context: EffectOriginContext
      }
    >()
    const providerBindings = new Map<string, ProviderBinding>()
    // Effect blocks grouped by representation identity, in instance then body order.
    let blocksByRepresentation:
      | Map<string, Array<{ readonly owner: InstanceKey; readonly identity: string }>>
      | undefined
    const resolveEffectIdentity = (identity: Type.EffectIdentityArgument): string | undefined => {
      if (blocksByRepresentation === undefined) {
        blocksByRepresentation = new Map()
        for (const instance of instances)
          for (const expression of callableExpressions(instance.function)) {
            if (expression._tag !== 'EffectBlock') continue
            const representation = Tir.effectRepresentationIdentity(expression.site)
            const block = {
              owner: instance.key,
              identity: effectIdentity(instance.key, expression.site),
            }
            const group = blocksByRepresentation.get(representation)
            if (group === undefined) blocksByRepresentation.set(representation, [block])
            else group.push(block)
          }
      }
      const candidates = blocksByRepresentation.get(identity.identity) ?? []
      const owner = identity.owner
      if (owner === undefined)
        return candidates.length === 1 ? candidates.at(0)?.identity : undefined
      const exact = candidates.filter((candidate) => sameExactOwner(candidate.owner, owner))
      if (exact.length === 1) return exact.at(0)?.identity
      const visible = candidates.filter(
        (candidate) =>
          candidate.owner.declaration.module === owner.declaration.module &&
          candidate.owner.declaration.name === owner.declaration.name &&
          sameVisibleTypeArguments(candidate.owner.typeArguments, owner.typeArguments) &&
          candidate.owner.staticArguments.length === owner.staticArgumentKeys.length &&
          candidate.owner.staticArguments.every(
            (argument, ordinal) =>
              StaticValue.key(argument) === owner.staticArgumentKeys.at(ordinal),
          ),
      )
      return visible.length === 1 ? visible.at(0)?.identity : undefined
    }
    const successOfIdentity = successIdentityResolver(instances, results, index)
    let instancesByResultEffect: Map<string, Array<Instance>> | undefined
    const serviceRecipesOfIdentity = (
      identity: string,
      resolving: ReadonlySet<string>,
    ): ReadonlyArray<ServiceEffectRecipe> => {
      if (resolving.has(identity)) return []
      if (instancesByResultEffect === undefined) {
        instancesByResultEffect = new Map()
        for (const instance of instances) {
          if (instance.resultEffect === undefined) continue
          const group = instancesByResultEffect.get(instance.resultEffect)
          if (group === undefined) instancesByResultEffect.set(instance.resultEffect, [instance])
          else group.push(instance)
        }
      }
      const candidates = instancesByResultEffect.get(identity) ?? []
      const candidate = candidates.length === 1 ? candidates.at(0) : undefined
      const expressions =
        candidate === undefined ? [] : Tir.returnExpressions(candidate.function.statements)
      if (candidate === undefined || expressions.length === 0) return []
      const recipeContext: EffectOriginContext = {
        fn: candidate.function,
        evidence: candidate.view.evidence,
        owner: candidate.key,
        substitution: candidate.substitution,
        compatibility: candidate.specialization.compatibility,
        results,
        index,
        resolving: new Set(resolving).add(identity),
        resolveEffectIdentity,
        successOfIdentity,
        serviceRecipesOfIdentity,
      }
      return expressions.flatMap((expression) => serviceEffectRecipes(expression, recipeContext))
    }
    const addDependency = (
      owner: string,
      target: string,
      diagnosticContext: 'Inherited' | 'Independent' = 'Inherited',
    ): void => {
      const targets = dependencies.get(owner) ?? new Set<string>()
      targets.add(target)
      dependencies.set(owner, targets)
      if (diagnosticContext === 'Inherited') {
        const inherited = diagnosticDependencies.get(owner) ?? new Set<string>()
        inherited.add(target)
        diagnosticDependencies.set(owner, inherited)
      }
    }
    const instancesByKey = new Map<string, Instance>()
    for (const instance of instances) {
      const identity = keyText(instance.key)
      if (!instancesByKey.has(identity)) instancesByKey.set(identity, instance)
    }
    const executionNodeForKey = (key: InstanceKey): string => {
      const result = instancesByKey.get(keyText(key))?.resultEffect
      return result === undefined ? instanceNode(key) : effectNode(result)
    }
    const serviceCallNode = (
      owner: InstanceKey,
      expression: Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }>,
    ): string =>
      `service\0${keyText(owner)}\0${expression.span.sourceId}:${expression.span.start}:${expression.span.end}`
    const providerBindingNode = (
      owner: InstanceKey,
      expression: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>,
    ): string =>
      `provider\0${keyText(owner)}\0${expression.span.sourceId}:${expression.span.start}:${expression.span.end}`
    for (const instance of instances) {
      const context: EffectOriginContext = {
        fn: instance.function,
        evidence: instance.view.evidence,
        owner: instance.key,
        substitution: instance.substitution,
        compatibility: selectedCompatibility(instance.function, instance.key),
        results,
        index,
        resolving: new Set<string>(),
        resolveEffectIdentity,
        successOfIdentity,
        serviceRecipesOfIdentity,
      }
      const deferredCallNode = (
        expression: Extract<Tir.Expression, { readonly _tag: 'Call' | 'EffectConstruct' }>,
      ): string => {
        const node = `call\0${keyText(instance.key)}\0${expression.span.sourceId}:${expression.span.start}:${expression.span.end}`
        deferredCalls.set(node, { expression, context })
        return node
      }
      const bindings = callableBindings(instance.function)

      const effectOrigins = (expression: Tir.Expression): ReadonlyArray<string> => {
        if (expression._tag === 'EffectBindRequirement') return effectOrigins(expression.protected)
        if (expression._tag === 'BindingReference') {
          const initializer = bindings.get(expression.binding.ordinal)
          return initializer === undefined ? [] : effectOrigins(initializer)
        }
        if (expression._tag === 'Move') return effectOrigins(expression.subject)
        if (expression._tag === 'UnionConvert') return effectOrigins(expression.source)
        if (expression._tag === 'Match') {
          return [
            ...new Set(
              expression.arms.flatMap((arm) =>
                arm.reachable && arm.body._tag === 'Expression'
                  ? effectOrigins(arm.body.expression)
                  : [],
              ),
            ),
          ]
        }
        const composite = compositeEffectRepresentationOf(expression, context)
        if (composite !== undefined)
          return composite.alternatives.flatMap((alternative) => {
            if (!Type.isEffectIdentityArgument(alternative.identity)) return []
            const identity = resolveEffectIdentity(alternative.identity)
            return identity === undefined ? [] : [identity]
          })
        const identity = effectOriginOf(expression, context)
        return identity === undefined ? [] : [identity]
      }

      const selectedInterfaceEffectTarget = (
        expression: Extract<
          Tir.Expression,
          { readonly _tag: 'InterfaceOperationCall' | 'BuiltinCall' }
        >,
      ): InstanceKey | undefined => {
        const bound =
          expression._tag === 'InterfaceOperationCall' ? expression : expression.interfaceOperation
        if (bound === undefined || expression.witnessEffectSite === undefined) return undefined
        const capability = Type.substitute(
          bound.capability,
          instance.substitution,
          instance.specialization.compatibility,
        )
        const provider = Type.substitute(
          bound.provider,
          instance.substitution,
          instance.specialization.compatibility,
        )
        if (!Type.isNominal(capability)) return undefined
        const selected = ConformanceProof.interfaceWitnessTarget(
          index,
          provider,
          capability,
          bound.operation,
          bound.contract,
          instance.substitution,
        )
        const target =
          selected === undefined ? undefined : targetFunction(results, selected.implementation)
        return selected === undefined || target === undefined
          ? undefined
          : keyOf(
              selected.implementation,
              target.contract,
              target.declaration.typeParameters.map((parameter) => parameter.type),
              selected.typeArguments,
            )
      }

      const callableApplicationTarget = (expression: Tir.Expression): string | undefined => {
        const origin = callableOriginOf(expression, context)
        if (origin?.target._tag !== 'Declaration') return undefined
        const declaration: DeclarationFacts.CanonicalId = {
          _tag: 'CanonicalDeclarationId',
          module: origin.target.module,
          name: origin.target.name,
        }
        const target = targetFunction(results, declaration)
        const arguments_ =
          target === undefined ? undefined : callableTargetArguments(target, origin.typeArguments)
        if (target === undefined || arguments_ === undefined) return undefined
        // Builtin callback edges use the same captured callable identities as the concrete
        // environment's runtime target. Omitting them loses the callback's provider graph.
        const environment = origin.environment
        const captured =
          environment === undefined
            ? undefined
            : callables.find(
                (candidate) =>
                  Type.runtimeCallableEnvironmentIdentityKey(
                    operations.callableEnvironmentIdentity(candidate),
                  ) === Type.runtimeCallableEnvironmentIdentityKey(environment) &&
                  Tir.matchesCallableTargetIdentity(candidate.target, origin.target) &&
                  sameVisibleTypeArguments(candidate.typeArguments, arguments_),
              )
        if (environment !== undefined && captured === undefined) return undefined
        const capturedCallables = (captured?.captures ?? [])
          .slice()
          .sort((left, right) => left.parameterOrdinal - right.parameterOrdinal)
          .flatMap((capture) =>
            capture.callableIdentity === undefined ? [] : [capture.callableIdentity],
          )
        const selectedKey = keyOf(
          declaration,
          target.contract,
          target.declaration.typeParameters.map((parameter) => parameter.type),
          [...arguments_, ...capturedCallables],
        )
        return executionNodeForKey(selectedKey)
      }
      const addBuiltinCallbacks = (
        expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>,
        execution: string,
      ): void => {
        let ordinals: ReadonlyArray<number>
        switch (expression.operation) {
          case 'ExecutionDrive':
            ordinals = [2, 3]
            break
          case 'ExecutionPark':
            ordinals = [0]
            break
          case 'SharedWithMut':
            ordinals = [1, 2]
            break
          case 'EffectUseReleaseNonParking':
            ordinals = [1, 2]
            break
          default:
            ordinals = []
        }
        for (const ordinal of ordinals) {
          const argument = expression.arguments.at(ordinal)
          const target = argument === undefined ? undefined : callableApplicationTarget(argument)
          if (target === undefined) unresolvedDiagnosticExecutions.add(execution)
          else addDependency(execution, target)
        }
        if (
          expression.operation === 'ExecutionDrive' ||
          expression.operation === 'ExecutionNotifyInitial' ||
          expression.operation === 'ExecutionWake'
        )
          readinessExecutions.add(execution)
        if (expression.operation === 'ExecutionFromAllocation') {
          const callback = expression.arguments.at(3)
          const target = callback === undefined ? undefined : callableApplicationTarget(callback)
          if (target === undefined) unresolvedReadiness = true
          else readinessCallbacks.add(target)
        }
      }

      const executionTargets = (expression: Tir.Expression): ReadonlyArray<string> => {
        if (expression._tag === 'EffectBindRequirement')
          return [providerBindingNode(instance.key, expression)]
        if (expression._tag === 'BindingReference') {
          const initializer = bindings.get(expression.binding.ordinal)
          return initializer === undefined ? [] : executionTargets(initializer)
        }
        if (expression._tag === 'Move') return executionTargets(expression.subject)
        if (expression._tag === 'UnionConvert') return executionTargets(expression.source)
        if (expression._tag === 'Match') {
          return [
            ...new Set(
              expression.arms.flatMap((arm) =>
                arm.reachable && arm.body._tag === 'Expression'
                  ? executionTargets(arm.body.expression)
                  : [],
              ),
            ),
          ]
        }
        if (
          (expression._tag === 'InterfaceOperationCall' || expression._tag === 'BuiltinCall') &&
          expression.witnessEffectSite !== undefined
        ) {
          const identity = effectIdentity(instance.key, expression.witnessEffectSite)
          const execution = effectNode(identity)
          effectIdentities.add(identity)
          const targetKey = selectedInterfaceEffectTarget(expression)
          if (targetKey !== undefined) addDependency(execution, executionNodeForKey(targetKey))
          return [execution]
        }
        if (expression._tag === 'BuiltinCall') {
          const type = Type.substitute(
            expression.type,
            instance.substitution,
            instance.specialization.compatibility,
          )
          if (Type.isEffect(type)) {
            const site = Tir.builtinEffectSite(
              Tir.nodeReference(instance.view.artifact, expression),
              instance.key.declaration,
              instance.function.declaration.id.ordinal,
            )
            const identity = effectIdentity(instance.key, site)
            const execution = effectNode(identity)
            effectIdentities.add(identity)
            addBuiltinCallbacks(expression, execution)
            if (expression.operation === 'EffectSuspend') nestedRoots.add(execution)
            else if (expression.operation === 'ExecutionPark') externalRoots.add(execution)
            else if (expression.operation === 'EffectObserveDiagnostics') {
              diagnosticObservations.add(execution)
              // Scope exit restores the enclosing context before either owner is dropped.
              for (const argument of expression.arguments.slice(0, 2)) {
                if (argument._tag === 'Unavailable') continue
                addCleanup(
                  CleanupPlan.cleanupPlan(
                    index,
                    Type.substitute(argument.type, instance.substitution, context.compatibility),
                  ),
                  execution,
                )
              }
            }
            for (const [ordinal, argument] of expression.arguments.entries())
              for (const target of executionTargets(argument))
                if (target !== execution)
                  addDependency(
                    execution,
                    target,
                    expression.operation === 'EffectObserveDiagnostics' && ordinal === 2
                      ? 'Independent'
                      : 'Inherited',
                  )
            return [execution]
          }
        }
        if (expression._tag === 'EffectConstruct') {
          const target = targetKeyOfInvocation(expression, context)
          const targetFn =
            target === undefined ? undefined : targetFunction(results, target.declaration)
          const identity =
            target === undefined || targetFn === undefined
              ? undefined
              : resultEffectIdentity(targetFn, target, results, index)
          if (identity !== undefined) {
            return [effectNode(identity)]
          }
          if (target === undefined) return [deferredCallNode(expression)]
          return [instanceNode(target)]
        }
        if (expression._tag === 'ServiceEffectConstruct') {
          const service = Type.substitute(
            expression.service,
            instance.substitution,
            instance.specialization.compatibility,
          )
          if (!Type.isNominal(service)) return []
          const node = serviceCallNode(instance.key, expression)
          const operation = index.modules
            .find((module) => module.module === service.module)
            ?.services.find(
              (candidate) =>
                candidate.canonical._tag === 'Canonical' &&
                candidate.canonical.id.name === service.name,
            )
            ?.operations.find(
              (candidate) =>
                candidate.name._tag === 'Present' &&
                candidate.name.spelling === expression.operation,
            )
          const nonParking = operation?.staticProperties.includes('Intrinsic.NonParking') === true
          serviceCalls.set(node, {
            service,
            role: expression.role,
            access: expression.access,
            operation: expression.operation,
            nonParking,
            expression,
            context,
          })
          if (nonParking) permitted.set(node, new Set<SuspensionMode.Mode>(['NestedTransfer']))
          return [node]
        }
        return effectOrigins(expression).map(effectNode)
      }

      const nonParkingExecutionTargets = (
        expression: Tir.Expression,
      ): { readonly targets: ReadonlyArray<string>; readonly complete: boolean } => {
        if (expression._tag === 'BindingReference') {
          const initializer = bindings.get(expression.binding.ordinal)
          return initializer === undefined
            ? { targets: [], complete: false }
            : nonParkingExecutionTargets(initializer)
        }
        if (expression._tag === 'Move') return nonParkingExecutionTargets(expression.subject)
        if (expression._tag === 'UnionConvert') return nonParkingExecutionTargets(expression.source)
        if (expression._tag === 'Match') {
          const reachable = expression.arms.filter((arm) => arm.reachable)
          const selected = reachable.map((arm) =>
            arm.body._tag === 'Expression'
              ? nonParkingExecutionTargets(arm.body.expression)
              : {
                  targets: [] as ReadonlyArray<string>,
                  complete: false,
                },
          )
          return {
            targets: [...new Set(selected.flatMap((candidate) => candidate.targets))],
            complete:
              selected.length === reachable.length &&
              selected.length > 0 &&
              selected.every((candidate) => candidate.complete),
          }
        }
        const composite = compositeEffectRepresentationOf(expression, context)
        if (composite !== undefined) {
          const identities = composite.alternatives.map((alternative) =>
            Type.isEffectIdentityArgument(alternative.identity)
              ? resolveEffectIdentity(alternative.identity)
              : undefined,
          )
          return {
            targets: [
              ...new Set(
                identities.flatMap((identity) =>
                  identity === undefined ? [] : [effectNode(identity)],
                ),
              ),
            ],
            complete:
              identities.length > 0 && identities.every((identity) => identity !== undefined),
          }
        }
        const targets = executionTargets(expression)
        return { targets, complete: targets.length > 0 }
      }

      const carriesNonParkingProof = (expression: Tir.Expression): boolean =>
        expression._tag !== 'Unavailable' &&
        Type.isRepresented(expression.type) &&
        Type.isRepresentationParameterArgument(expression.type.representation.argument) &&
        expression.type.representation.argument.parameter.staticProperties.includes(
          'Intrinsic.NonParking',
        )

      const isSuspensionSubject = (expression: Tir.Expression): boolean => {
        if (expression._tag === 'BuiltinCall') return expression.operation === 'EffectSuspend'
        if (expression._tag === 'BindingReference') {
          const initializer = bindings.get(expression.binding.ordinal)
          return initializer !== undefined && isSuspensionSubject(initializer)
        }
        if (expression._tag === 'Move') return isSuspensionSubject(expression.subject)
        if (expression._tag === 'UnionConvert') return isSuspensionSubject(expression.source)
        if (expression._tag === 'EffectBindRequirement')
          return isSuspensionSubject(expression.protected)
        return false
      }

      const isExternalParkSubject = (expression: Tir.Expression): boolean => {
        if (expression._tag === 'BuiltinCall' && expression.operation === 'ExecutionPark')
          return true
        if (expression._tag === 'BindingReference') {
          const initializer = bindings.get(expression.binding.ordinal)
          return initializer !== undefined && isExternalParkSubject(initializer)
        }
        if (expression._tag === 'Move') return isExternalParkSubject(expression.subject)
        if (expression._tag === 'UnionConvert') return isExternalParkSubject(expression.source)
        return false
      }

      const recordForwardedServiceTargets = (
        expression: Extract<Tir.Expression, { readonly _tag: 'Call' | 'EffectConstruct' }>,
        execution: string,
      ): void => {
        const wrapperKey = targetKeyOfInvocation(expression, context)
        const wrapper =
          wrapperKey === undefined ? undefined : targetFunction(results, wrapperKey.declaration)
        const wrapperSubstitution =
          wrapper === undefined || wrapperKey === undefined
            ? undefined
            : instanceSubstitution(wrapper, wrapperKey)
        if (wrapper === undefined || wrapperSubstitution === undefined) return
        for (const ordinal of effectParameterOrdinals(wrapper, wrapperSubstitution)) {
          const argument = expression.arguments.at(ordinal)
          for (const service of argument === undefined
            ? []
            : serviceEffectRecipes(argument, context)) {
            const target = forwardedServiceTargetOfCall(
              expression,
              wrapper,
              wrapperSubstitution,
              ordinal,
              context,
              service,
            )
            if (target === undefined) continue
            const span = service.expression.span
            providedTargets.set(
              `${keyText(instance.key)}\0${keyText(target)}\0${span.sourceId}:${span.start}:${span.end}`,
              {
                owner: instance.key,
                target,
                span,
                ...(service.expression.staticArgumentOrigins === undefined
                  ? {}
                  : { staticArgumentOrigins: service.expression.staticArgumentOrigins }),
              },
            )
            addDependency(execution, executionNodeForKey(target))
          }
        }
      }

      const recordForwardedCallableServiceTargets = (
        expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
        execution: string,
      ): void => {
        const wrapperKey = targetKeyOfInvocation(expression, context)
        const wrapper =
          wrapperKey === undefined ? undefined : targetFunction(results, wrapperKey.declaration)
        const wrapperSubstitution =
          wrapper === undefined || wrapperKey === undefined
            ? undefined
            : instanceSubstitution(wrapper, wrapperKey)
        if (wrapper === undefined || wrapperSubstitution === undefined) return
        for (const ordinal of effectParameterOrdinals(wrapper, wrapperSubstitution)) {
          const argument = callableApplicationArgument(expression, ordinal, context)
          for (const service of argument === undefined
            ? []
            : serviceEffectRecipes(argument, context)) {
            const target = forwardedServiceTargetOfCallableApply(
              expression,
              wrapper,
              wrapperSubstitution,
              ordinal,
              context,
              service,
            )
            if (target === undefined) continue
            const span = service.expression.span
            providedTargets.set(
              `${keyText(instance.key)}\0${keyText(target)}\0${span.sourceId}:${span.start}:${span.end}`,
              {
                owner: instance.key,
                target,
                span,
                ...(service.expression.staticArgumentOrigins === undefined
                  ? {}
                  : { staticArgumentOrigins: service.expression.staticArgumentOrigins }),
              },
            )
            addDependency(execution, executionNodeForKey(target))
          }
        }
      }

      const cleanupRegions = new Map<number, string>()
      const addCleanup = (cleanup: CleanupPlan.CleanupPlan, execution: string): void => {
        for (const hook of hookCalls(cleanup, index, false)) {
          const target = targetFunction(results, hook.declaration)
          if (target === undefined) continue
          const targetKey = keyOf(
            hook.declaration,
            target.contract,
            target.declaration.typeParameters.map((parameter) => parameter.type),
            hook.typeArguments.map((argument) =>
              Type.substituteGenericArgument(
                argument,
                instance.substitution,
                instance.specialization.compatibility,
              ),
            ),
          )
          addDependency(execution, instanceNode(targetKey))
        }
      }
      const recordRegions = (statement: Tir.Statement, execution: string): void => {
        cleanupRegions.set(statement.region.ordinal, execution)
        if (statement._tag === 'Unsafe') {
          for (const child of statement.statements) recordRegions(child, execution)
        } else if (statement._tag === 'While') {
          for (const child of statement.body) recordRegions(child, execution)
        } else if (statement._tag === 'If') {
          for (const child of [...statement.taken, ...statement.otherwise])
            recordRegions(child, execution)
        } else if (statement._tag === 'Drop' && statement.expression._tag !== 'Unavailable') {
          addCleanup(
            CleanupPlan.cleanupPlan(
              index,
              Type.substitute(statement.expression.type, instance.substitution),
            ),
            execution,
          )
          for (const identity of effectOrigins(statement.expression))
            addOwnedEffectCleanup(identity, execution)
        }
      }
      const addOwnedEffectCleanup = (
        identity: string,
        execution: string,
        visited: ReadonlySet<string> = new Set(),
      ): void => {
        if (visited.has(identity)) return
        const next = new Set(visited).add(identity)
        for (const capture of effectForCleanup(identity)?.captures ?? []) {
          if (capture.access === 'Shared' || capture.access === 'Exclusive') continue
          addCleanup(CleanupPlan.cleanupPlan(index, capture.type), execution)
          if (capture.effectIdentity !== undefined)
            addOwnedEffectCleanup(capture.effectIdentity, execution, next)
        }
      }
      const scanExpression = (expression: Tir.Expression, execution: string): void => {
        if (expression._tag === 'EffectBlock') {
          const identity = effectIdentity(instance.key, expression.site)
          effectIdentities.add(identity)
          scanStatements(expression.statements, effectNode(identity))
          return
        }
        if (expression._tag === 'EffectCatch') {
          const site = Tir.effectCatchSite(
            Tir.nodeReference(instance.view.artifact, expression),
            instance.key.declaration,
            instance.function.declaration.id.ordinal,
          )
          const identity = effectIdentity(instance.key, site)
          const catchExecution = effectNode(identity)
          effectIdentities.add(identity)
          for (const target of executionTargets(expression.protected))
            addDependency(catchExecution, target)
          const handler = callableOriginOf(expression.handler, context)
          if (handler?.target._tag === 'Declaration') {
            const declaration: DeclarationFacts.CanonicalId = {
              _tag: 'CanonicalDeclarationId',
              module: handler.target.module,
              name: handler.target.name,
            }
            const target = targetFunction(results, declaration)
            const targetKey =
              target === undefined
                ? undefined
                : keyOf(
                    declaration,
                    target.contract,
                    target.declaration.typeParameters.map((parameter) => parameter.type),
                    handler.typeArguments,
                  )
            const handlerEffect =
              target === undefined || targetKey === undefined
                ? undefined
                : resultEffectIdentity(target, targetKey, results, index)
            // Both applying the handler and running its returned Effect inherit the selected
            // failure. Seeding both is conservative when construction itself performs work.
            if (targetKey !== undefined) recoveryExecutions.add(instanceNode(targetKey))
            else unresolvedRecovery = true
            if (handlerEffect !== undefined) {
              recoveryExecutions.add(effectNode(handlerEffect))
              addDependency(catchExecution, effectNode(handlerEffect))
            } else if (targetKey !== undefined)
              addDependency(catchExecution, instanceNode(targetKey))
          }
          if (handler?.target._tag !== 'Declaration') unresolvedRecovery = true
          scanExpression(expression.protected, catchExecution)
          scanExpression(expression.handler, catchExecution)
          return
        }
        if (expression._tag === 'EffectBindRequirement') {
          const bindingExecution =
            instance.resultEffect === undefined ? execution : effectNode(instance.resultEffect)
          const protectedTargets = executionTargets(expression.protected)
          const node = providerBindingNode(instance.key, expression)
          addDependency(bindingExecution, node)
          for (const target of protectedTargets) addDependency(node, target)
          const selected = selectedRequirement(expression, instance.substitution)
          const witness =
            requirementBindingWitness(expression, instance.substitution, index) ??
            expression.provider.witness
          if (
            selected !== undefined &&
            Type.isNominal(selected.capability) &&
            witness !== undefined
          )
            providerBindings.set(node, {
              node,
              execution: bindingExecution,
              protectedTargets,
              selected,
              witness,
              providerAccess: expression.provider.selectionAccess,
              receiver: Type.reference(
                expression.provider.selectionAccess === 'Take'
                  ? 'Exclusive'
                  : expression.provider.selectionAccess,
                witness.provider,
                Type.substituteLifetime(expression.type.environment, instance.substitution),
              ),
            })
        } else if (expression._tag === 'Call') {
          const target = targetKeyOfInvocation(expression, context)
          addDependency(
            execution,
            target === undefined ? deferredCallNode(expression) : instanceNode(target),
          )
          recordForwardedServiceTargets(expression, execution)
        } else if (expression._tag === 'EffectConstruct') {
          const target = targetKeyOfInvocation(expression, context)
          addDependency(
            execution,
            target === undefined ? deferredCallNode(expression) : instanceNode(target),
          )
          recordForwardedServiceTargets(expression, execution)
        } else if (
          (expression._tag === 'InterfaceOperationCall' || expression._tag === 'BuiltinCall') &&
          expression.witnessEffectSite !== undefined
        ) {
          for (const target of executionTargets(expression)) addDependency(execution, target)
        } else if (expression._tag === 'BuiltinCall') {
          const selectedCall = interfaceCallOf(expression, context)
          if (selectedCall !== undefined) {
            const target = targetKeyOfInvocation(selectedCall, context)
            addDependency(
              execution,
              target === undefined ? deferredCallNode(selectedCall) : instanceNode(target),
            )
          }
          if (expression.operation === 'EffectObserveUnhandled')
            terminalObservations.push({ execution, span: expression.span })
          const targets = executionTargets(expression)
          if (expression.operation === 'EffectFinalizeNonParking') {
            const finalizer = expression.arguments.at(1)
            if (finalizer === undefined || !carriesNonParkingProof(finalizer)) {
              const resolved =
                finalizer === undefined
                  ? {
                      targets: [] as ReadonlyArray<string>,
                      complete: false,
                    }
                  : nonParkingExecutionTargets(finalizer)
              if (!resolved.complete) {
                const node = `nonparking-finalizer\u0000${expression.span.sourceId}:${expression.span.start}:${expression.span.end}`
                unavailable.add(node)
                nonParkingObligations.set(node, { node, span: expression.span })
              }
              for (const node of resolved.targets)
                nonParkingObligations.set(
                  `${node}\u0000${expression.span.sourceId}:${expression.span.start}:${expression.span.end}`,
                  { node, span: expression.span },
                )
            }
          }
          if (expression.operation === 'EffectUseReleaseNonParking') {
            const release = expression.arguments.at(2)
            if (release === undefined || !carriesNonParkingProof(release)) {
              const node = release === undefined ? undefined : callableApplicationTarget(release)
              if (node === undefined) {
                const unavailableNode = `nonparking-resource-release\u0000${expression.span.sourceId}:${expression.span.start}:${expression.span.end}`
                unavailable.add(unavailableNode)
                nonParkingObligations.set(unavailableNode, {
                  node: unavailableNode,
                  span: expression.span,
                })
              } else {
                nonParkingObligations.set(
                  `${node}\u0000${expression.span.sourceId}:${expression.span.start}:${expression.span.end}`,
                  { node, span: expression.span },
                )
              }
            }
          }
          if (!Type.isEffect(Type.substitute(expression.type, instance.substitution)))
            addBuiltinCallbacks(expression, execution)
          // Observation starts when its returned Effect runs. Construction only records the
          // deferred node; argument evaluation is still scanned in the enclosing execution.
          if (expression.operation !== 'EffectObserveDiagnostics')
            for (const target of targets) addDependency(execution, target)
        } else if (expression._tag === 'InterfaceOperationCall') {
          const selectedCall = interfaceCallOf(expression, context)
          if (selectedCall !== undefined) {
            const target = targetKeyOfInvocation(selectedCall, context)
            addDependency(
              execution,
              target === undefined ? deferredCallNode(selectedCall) : instanceNode(target),
            )
          }
        } else if (expression._tag === 'ServiceEffectConstruct') {
          for (const target of executionTargets(expression)) addDependency(execution, target)
        } else if (expression._tag === 'CallableApply') {
          const target = targetKeyOfInvocation(expression, context)
          if (target !== undefined) addDependency(execution, instanceNode(target))
          else unresolvedDiagnosticExecutions.add(execution)
          recordForwardedCallableServiceTargets(expression, execution)
        } else if (expression._tag === 'Run') {
          if (isSuspensionSubject(expression.subject)) {
            nestedRoots.add(execution)
          } else if (isExternalParkSubject(expression.subject)) {
            externalRoots.add(execution)
          } else {
            const targets = executionTargets(expression.subject)
            if (targets.length === 0) unresolvedDiagnosticExecutions.add(execution)
            for (const target of targets) addDependency(execution, target)
          }
        }
        for (const child of Tir.expressionChildren(expression)) scanExpression(child, execution)
      }
      const scanStatements = (
        statements: ReadonlyArray<Tir.Statement>,
        execution: string,
      ): void => {
        for (const statement of statements) {
          recordRegions(statement, execution)
          for (const expression of Tir.statementExpressions(statement))
            scanExpression(expression, execution)
        }
      }
      scanStatements(instance.function.statements, instanceNode(instance.key))
      // Cleanup executes in the region that exits, including deferred Effect regions.
      // Merely constructing a lazy Effect must not execute that body's destructors.
      for (const exit of instance.ownership?.exits ?? []) {
        const execution =
          exit.region === undefined ? undefined : cleanupRegions.get(exit.region.ordinal)
        if (execution === undefined) continue
        for (const release of [...exit.releases, ...exit.temporaries])
          addCleanup(release.cleanup, execution)
        for (const release of exit.releases) {
          const site = release.binding.site
          if (site._tag === 'Let') {
            const initializer = bindings.get(site.binding.ordinal)
            for (const identity of initializer === undefined ? [] : effectOrigins(initializer))
              addOwnedEffectCleanup(identity, execution)
          } else if (site._tag === 'Parameter') {
            const identity = parameterEffectIdentity(
              instance.function,
              instance.key,
              site.parameter.ordinal,
            )
            if (identity !== undefined) addOwnedEffectCleanup(identity, execution)
          }
        }
        for (const match of exit.matches)
          for (const entry of match.cleanup) addCleanup(entry.cleanup, execution)
      }
      for (const replacement of instance.ownership?.replacements ?? []) {
        const execution = cleanupRegions.get(replacement.region.ordinal)
        if (execution !== undefined) addCleanup(replacement.cleanup, execution)
      }
    }

    const providers = providerWorklist(providerBindings.values())
    const selectedEdges: Array<readonly [string, string]> = []
    for (let ordinal = 0; ordinal < providers.pending.length; ordinal += 1) {
      const current = providers.pending[ordinal]
      if (current === undefined) continue
      const entered = providerBindings.get(current.node)
      const environment =
        entered === undefined
          ? current.environment
          : enterProviderBinding(providers, current.environment, entered)
      const deferredCall = deferredCalls.get(current.node)
      if (deferredCall !== undefined) {
        const selectedBindings = new Map<string, ProviderBinding>()
        const context: EffectOriginContext = {
          ...deferredCall.context,
          resolveServiceEffectIdentity: (expression) => {
            const service = Type.substitute(
              expression.service,
              deferredCall.context.substitution,
              deferredCall.context.compatibility,
            )
            const binding = environment.findLast(
              (candidate) =>
                Type.equals(service, candidate.selected.capability) &&
                expression.role === candidate.selected.role &&
                (expression.access === 'Shared' ||
                  candidate.providerAccess === 'Exclusive' ||
                  candidate.providerAccess === 'Take'),
            )
            if (binding?.witness._tag !== 'SourceConformanceWitness') return undefined
            selectedBindings.set(binding.node, binding)
            const target = targetKeyOfServiceCall(
              expression,
              binding.witness,
              deferredCall.context,
              binding.receiver,
            )
            const fn =
              target === undefined ? undefined : targetFunction(results, target.declaration)
            return target === undefined || fn === undefined
              ? undefined
              : resultEffectIdentity(fn, target, results, index)
          },
        }
        const target = targetKeyOfInvocation(deferredCall.expression, context)
        if (target !== undefined) {
          const span = deferredCall.expression.span
          providedTargets.set(
            `${keyText(context.owner)}\0${keyText(target)}\0${span.sourceId}:${span.start}:${span.end}`,
            {
              owner: context.owner,
              target,
              span,
              ...(deferredCall.expression.staticArgumentOrigins === undefined
                ? {}
                : { staticArgumentOrigins: deferredCall.expression.staticArgumentOrigins }),
              providers: [...selectedBindings.values()].map((binding) => ({
                capability: binding.witness.capability,
                providerType: binding.witness.provider,
                role: binding.selected.role,
              })),
            },
          )
          const targetNode = executionNodeForKey(target)
          // Keep provider-selected suspension on its lexical invocation, not the shared open call.
          for (const binding of selectedBindings.values())
            selectedEdges.push([binding.execution, targetNode])
          enqueueProvider(providers, targetNode, environment)
        }
      }
      const serviceCall = serviceCalls.get(current.node)
      if (serviceCall !== undefined) {
        const binding = environment.findLast(
          (candidate) =>
            Type.equals(serviceCall.service, candidate.selected.capability) &&
            serviceCall.role === candidate.selected.role &&
            (serviceCall.access === 'Shared' ||
              candidate.providerAccess === 'Exclusive' ||
              candidate.providerAccess === 'Take'),
        )
        if (binding?.witness._tag === 'SourceConformanceWitness') {
          const target = targetKeyOfServiceCall(
            serviceCall.expression,
            binding.witness,
            serviceCall.context,
            binding.receiver,
          )
          if (target !== undefined) {
            providedTargets.set(
              `${keyText(serviceCall.context.owner)}\0${keyText(target)}\0${serviceCall.expression.span.sourceId}:${serviceCall.expression.span.start}:${serviceCall.expression.span.end}`,
              {
                owner: serviceCall.context.owner,
                target,
                span: serviceCall.expression.span,
                providers: [
                  {
                    capability: binding.witness.capability,
                    providerType: binding.witness.provider,
                    role: binding.selected.role,
                  },
                ],
                ...(serviceCall.expression.staticArgumentOrigins === undefined
                  ? {}
                  : { staticArgumentOrigins: serviceCall.expression.staticArgumentOrigins }),
              },
            )
            const targetNode = executionNodeForKey(target)
            if (serviceCall.nonParking)
              nonParkingObligations.set(
                `${targetNode}\u0000${serviceCall.expression.span.sourceId}:${serviceCall.expression.span.start}:${serviceCall.expression.span.end}`,
                { node: targetNode, span: serviceCall.expression.span },
              )
            selectedEdges.push([binding.execution, targetNode])
            enqueueProvider(providers, targetNode, environment)
          } else if (serviceCall.nonParking) {
            const node = `nonparking-provider\u0000${serviceCall.expression.span.sourceId}:${serviceCall.expression.span.start}:${serviceCall.expression.span.end}`
            unavailable.add(node)
            nonParkingObligations.set(node, { node, span: serviceCall.expression.span })
          }
        }
      }
      for (const target of dependencies.get(current.node) ?? [])
        enqueueProvider(providers, target, environment)
    }
    for (const [owner, target] of selectedEdges) addDependency(owner, target)

    // Package readiness is selected dynamically. Every retained endpoint is a possible
    // target, while the independently started body is never an inherited-context edge.
    for (const execution of readinessExecutions) {
      for (const callback of readinessCallbacks) addDependency(execution, callback)
      if (unresolvedReadiness) unresolvedDiagnosticExecutions.add(execution)
    }

    // A fresh observer's protected execution cannot inherit the enclosing selected
    // failure. Argument construction and owner cleanup remain in the enclosing context.
    // Unresolved execution prevents an absence proof rather than guessing a target.
    const potentiallySelected = new Set(recoveryExecutions)
    const pendingSelected = [...potentiallySelected]
    for (let ordinal = 0; ordinal < pendingSelected.length; ordinal++) {
      const execution = pendingSelected[ordinal]
      if (execution === undefined) continue
      for (const target of diagnosticDependencies.get(execution) ?? []) {
        if (potentiallySelected.has(target)) continue
        potentiallySelected.add(target)
        pendingSelected.push(target)
      }
    }
    const contextFreeTerminalObservations =
      unresolvedRecovery ||
      [...potentiallySelected].some(
        (execution) =>
          unresolvedDiagnosticExecutions.has(execution) || deferredCalls.has(execution),
      )
        ? []
        : terminalObservations
            .filter(({ execution }) => !potentiallySelected.has(execution))
            .map(({ span }) => span)

    return {
      contextFreeTerminalObservations,
      roots: new Map<SuspensionMode.Mode, ReadonlySet<string>>([
        ['NestedTransfer', nestedRoots],
        ['ExternalPark', externalRoots],
      ]),
      diagnosticObservations,
      dependencies,
      effectIdentities,
      permitted,
      unavailable,
      nonParkingObligations: [...nonParkingObligations.values()],
      providedTargets: [...providedTargets.values()],
    }
  }

  return {
    functionByKey,
    instanceNode,
    effectNode,
    hookCalls,
    bodyCallTargets,
    interfaceWitnessTargets,
    requirementBindingCallTargets,
    forwardedRequirementCallTargets,
    slotDropHookTargets,
    directCallInstances,
    callableCallTargets,
    forwardedRequirementTargets,
    resultCallableIdentity,
    resultEffectIdentity,
    effectSuccesses,
    concreteCallables,
    concreteEffects,
    suspensionGraph,
  }
}
