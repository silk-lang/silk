import * as ConformanceProof from './ConformanceProof.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import type * as FieldRealization from './FieldRealization.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as Layout from './Layout.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as Suspension from './Suspension.js'
import * as SuspensionMode from './SuspensionMode.js'
import * as Type from './Type.js'
import * as EffectExecutionContract from './internal/EffectExecutionContract.js'

/**
 * Monomorphic suspension control before normalization and MIR-local liveness. This is deliberately
 * not a `Mir.Module`: verification and LLVM lowering cannot consume provisional control.
 */

export type Classification = Suspension.SuspensionClassification

export type ExecutionKey =
  | {
      readonly _tag: 'InstanceExecution'
      readonly instance: Instances.InstanceKey
      readonly functionOrdinal: number
      readonly identity: string
    }
  | {
      readonly _tag:
        | 'EffectRunnerExecution'
        | 'WitnessEffectRunnerExecution'
        | 'BuiltinEffectRunnerExecution'
      readonly owner: Instances.InstanceKey
      readonly site: Tir.EffectSiteId
      readonly identity: string
      readonly runner: DeclarationFacts.CanonicalId
    }
  | {
      readonly _tag: 'ProvidedEffectRunnerExecution'
      readonly baseKind:
        | 'EffectRunnerExecution'
        | 'WitnessEffectRunnerExecution'
        | 'BuiltinEffectRunnerExecution'
      readonly owner: Instances.InstanceKey
      readonly site: Tir.EffectSiteId
      readonly identity: string
      readonly effectIdentity: string
      readonly runner: DeclarationFacts.CanonicalId
      readonly providers: ReadonlyArray<Provider>
    }

export interface ControlId {
  readonly _tag: 'ProvisionalControlId'
  readonly execution: string
  readonly sourceId: string
  readonly functionOrdinal: number
  readonly spanStart: number
  readonly spanEnd: number
  readonly ordinal: number
  readonly port: 'Origin' | 'Invoke' | 'Complete'
}

export interface Capture extends Suspension.Capture {}

export interface Provider extends Suspension.Provider {}

export interface Runner extends Suspension.RunnerBase<Capture, Provider> {
  readonly execution:
    | ExecutionKey
    | { readonly _tag: 'UnknownExecution'; readonly identity: string }
  readonly providedIdentity?: string
}

export type CompletionPolicy = Suspension.SuspensionCompletion

export type Outcome =
  | {
      readonly _tag: 'SuspendEffect'
      readonly deferred: Runner
      /** An unpublished transfer is created; this does not start the deferred runner. */
      readonly transfer: {
        readonly _tag: 'OriginateTransfer'
      }
      readonly span: SourceSpan.SourceSpan
    }
  | {
      readonly _tag: 'RunSuspendableEffect'
      readonly runner: Runner
      readonly completion: CompletionPolicy
      readonly complete: ControlId
      readonly relay: {
        readonly _tag: 'RelayExistingTransfer'
        readonly preserves: readonly ['Child', 'Origin', 'TypedOutcome']
      }
      readonly span: SourceSpan.SourceSpan
    }
  | { readonly _tag: 'Complete'; readonly policy: CompletionPolicy }

/** One node in the provisional control graph. Transfer relay is a terminal outcome, not an edge. */
export interface Region {
  readonly _tag: 'ProvisionalRegion'
  readonly id: ControlId
  readonly outcome: Outcome
}

export interface Execution {
  readonly _tag: 'ProvisionalExecution'
  readonly key: ExecutionKey
  readonly classification: Classification
  readonly regions: ReadonlyArray<Region>
}

export interface Module {
  readonly _tag: 'ProvisionalMirModule'
  readonly module: string
  readonly executions: ReadonlyArray<Execution>
}

const executionIdentity = (key: ExecutionKey): string => key.identity

const executionInstanceCache = new WeakMap<ExecutionKey, Instances.InstanceKey>()

const executionInstance = (key: ExecutionKey): Instances.InstanceKey => {
  if (key._tag === 'InstanceExecution') {
    return key.instance
  }
  let cached = executionInstanceCache.get(key)
  if (cached === undefined) {
    const kind = key._tag === 'ProvidedEffectRunnerExecution' ? key.baseKind : key._tag
    let siteKind = 'effect-site'
    if (kind === 'WitnessEffectRunnerExecution') siteKind = 'witness-effect-site'
    else if (kind === 'BuiltinEffectRunnerExecution') siteKind = 'builtin-effect-site'
    cached = {
      _tag: 'InstanceKey',
      declaration: key.runner,
      typeArguments: key.owner.typeArguments,
      evidence: key.owner.evidence,
      staticArguments: key.owner.staticArguments,
      contractRow: [
        ...key.owner.contractRow,
        `${siteKind}:${Tir.executableSiteKey(key.site)}`,
        ...(key._tag === 'ProvidedEffectRunnerExecution'
          ? key.providers.map(providedContractEntry)
          : []),
      ],
    }
    executionInstanceCache.set(key, cached)
  }
  return cached
}

const sameSpan = (left: SourceSpan.SourceSpan, right: SourceSpan.SourceSpan): boolean =>
  left.sourceId === right.sourceId && left.start === right.start && left.end === right.end

const providedBaseName = (name: string): string | undefined => {
  const matched = /^(.*)\$provided\$[0-9]+$/.exec(name)
  const base = matched?.at(1)
  return base === undefined || base.length === 0 ? undefined : base
}

const executionIndexCache = new WeakMap<ReadonlyArray<Execution>, Map<string, Execution>>()

const executionIndex = (executions: ReadonlyArray<Execution>): Map<string, Execution> => {
  let index = executionIndexCache.get(executions)
  if (index === undefined) {
    index = new Map()
    for (const execution of executions) {
      const key = Instances.keyText(executionInstance(execution.key))
      if (!index.has(key)) index.set(key, execution)
    }
    executionIndexCache.set(executions, index)
  }
  return index
}

// Finalization asks several questions of each lowered function; both lookups below scan every
// provisional execution, so their answers are retained per published execution list.
const resolvedExecutions = new WeakMap<
  ReadonlyArray<Execution>,
  Map<string, Execution | undefined>
>()
const resolvedProvidedClassifications = new WeakMap<
  ReadonlyArray<Execution>,
  Map<string, Classification | undefined>
>()

const memoizedPerInstance = <A>(
  cache: WeakMap<ReadonlyArray<Execution>, Map<string, A | undefined>>,
  self: Module,
  instance: Instances.InstanceKey,
  compute: (self: Module, instance: Instances.InstanceKey) => A | undefined,
): A | undefined => {
  let answers = cache.get(self.executions)
  if (answers === undefined) {
    answers = new Map()
    cache.set(self.executions, answers)
  }
  const text = Instances.keyText(instance)
  if (answers.has(text)) return answers.get(text)
  const answer = compute(self, instance)
  answers.set(text, answer)
  return answer
}

const executionForInstance = (
  self: Module,
  instance: Instances.InstanceKey,
): Execution | undefined =>
  memoizedPerInstance(resolvedExecutions, self, instance, resolveExecutionForInstance)

const resolveExecutionForInstance = (
  self: Module,
  instance: Instances.InstanceKey,
): Execution | undefined => {
  const exact = executionIndex(self.executions).get(Instances.keyText(instance))
  if (exact !== undefined) return exact
  const baseName = providedBaseName(instance.declaration.name)
  if (baseName === undefined) return undefined
  const candidates = self.executions.filter((execution) => {
    if (execution.key._tag === 'InstanceExecution') return false
    const executionKey = executionInstance(execution.key)
    return (
      executionKey.declaration.module === instance.declaration.module &&
      executionKey.declaration.name === baseName
    )
  })
  const specialized = candidates.find((execution) => {
    const executionKey = executionInstance(execution.key)
    return (
      Instances.keyText({ ...executionKey, declaration: instance.declaration }) ===
      Instances.keyText(instance)
    )
  })
  if (specialized !== undefined) return specialized
  const openInstance: Instances.InstanceKey = {
    ...instance,
    contractRow: instance.contractRow.filter((entry) => !entry.startsWith('provided:')),
  }
  return candidates.find((execution) => {
    const executionKey = executionInstance(execution.key)
    return (
      (execution.key._tag === 'EffectRunnerExecution' ||
        execution.key._tag === 'WitnessEffectRunnerExecution' ||
        execution.key._tag === 'BuiltinEffectRunnerExecution') &&
      Instances.keyText({ ...executionKey, declaration: instance.declaration }) ===
        Instances.keyText(openInstance)
    )
  })
}

/** Resolves the provisional execution corresponding to one exact lowered MIR function. */
export const executionOf = (self: Module, instance: Instances.InstanceKey): Execution | undefined =>
  executionForInstance(self, instance)

const mergeClassifications = (classifications: ReadonlyArray<Classification>): Classification => {
  if (classifications.includes('Suspendable')) {
    return 'Suspendable'
  }
  if (classifications.includes('Unknown')) {
    return 'Unknown'
  }
  if (classifications.includes('Synchronous')) {
    return 'Synchronous'
  }
  return 'Unknown'
}

const providedClassification = (
  self: Module,
  instance: Instances.InstanceKey,
): Classification | undefined =>
  memoizedPerInstance(
    resolvedProvidedClassifications,
    self,
    instance,
    resolveProvidedClassification,
  )

const resolveProvidedClassification = (
  self: Module,
  instance: Instances.InstanceKey,
): Classification | undefined => {
  const baseName = providedBaseName(instance.declaration.name)
  if (baseName === undefined) return undefined
  const classifications = self.executions.flatMap((execution) =>
    execution.regions.flatMap((region) => {
      const outcome = region.outcome
      if (
        outcome._tag !== 'RunSuspendableEffect' ||
        outcome.runner.execution._tag !== 'ProvidedEffectRunnerExecution'
      )
        return []
      // Distinct providers may give the same base runner different suspension behavior.
      const key = executionInstance(outcome.runner.execution)
      return key.declaration.module === instance.declaration.module &&
        key.declaration.name === baseName &&
        Instances.keyText({ ...key, declaration: instance.declaration }) ===
          Instances.keyText(instance)
        ? [outcome.runner.classification]
        : []
    }),
  )
  if (classifications.length > 0) return mergeClassifications(classifications)

  return undefined
}

const controlId = (
  execution: ExecutionKey,
  span: SourceSpan.SourceSpan,
  ordinal: number,
  port: ControlId['port'],
): ControlId => ({
  _tag: 'ProvisionalControlId',
  execution: executionIdentity(execution),
  sourceId: span.sourceId,
  functionOrdinal:
    execution._tag === 'InstanceExecution'
      ? execution.functionOrdinal
      : execution.site.functionOrdinal,
  spanStart: span.start,
  spanEnd: span.end,
  ordinal,
  port,
})

const classificationOfEffect = (
  discovery: Instances.Discovery,
  identity: string | undefined,
): Classification => {
  if (identity === undefined) {
    return 'Unknown'
  }
  if (suspendableSummary(Instances.effectSuspensionOf(discovery, identity))) {
    return 'Suspendable'
  }
  return 'Synchronous'
}

const suspendableSummary = (summary: SuspensionMode.Summary): boolean =>
  SuspensionMode.has(summary, 'NestedTransfer') || SuspensionMode.has(summary, 'ExternalPark')

const sameDeclaration = (
  left: DeclarationFacts.CanonicalId,
  right: DeclarationFacts.CanonicalId,
): boolean => left.module === right.module && left.name === right.name

const providerKey = (provider: Provider): string =>
  `${Type.key(provider.capability)}@${provider.role}:${provider.requirementAccess}:${provider.access}:${Type.key(provider.providerType)}:${
    provider.witness?._tag ?? 'unknown'
  }`

const providedContractEntry = (provider: Provider): string => `provided:${providerKey(provider)}`

// TIR nodes are immutable. Rewalking and freezing the same trees accounted for 37% of the
// provisional-build CPU profile. Cache queried roots by weak identity so discarded TIR is collectible.
const expressionTrees = new WeakMap<Tir.Expression, ReadonlyArray<Tir.Expression>>()
const statementExpressionLists = new WeakMap<Tir.Statement, ReadonlyArray<Tir.Expression>>()

const expressionTree = (expression: Tir.Expression): ReadonlyArray<Tir.Expression> => {
  const cached = expressionTrees.get(expression)
  if (cached !== undefined) return cached
  const tree = Tir.expressionTree(expression)
  expressionTrees.set(expression, tree)
  return tree
}

const statementExpressions = (statement: Tir.Statement): ReadonlyArray<Tir.Expression> => {
  const cached = statementExpressionLists.get(statement)
  if (cached !== undefined) return cached
  const expressions = Tir.statementExpressions(statement)
  statementExpressionLists.set(statement, expressions)
  return expressions
}

const bindingsOfStatements = (
  statements: ReadonlyArray<Tir.Statement>,
): ReadonlyMap<number, Tir.Expression> =>
  new Map(
    statements.flatMap((statement) => {
      if (statement._tag === 'Bind') {
        return [[statement.binding.ordinal, statement.initializer] as const]
      }
      if (statement._tag === 'If') {
        return [...statement.taken, ...statement.otherwise].flatMap((nested) =>
          nested._tag === 'Bind' ? [[nested.binding.ordinal, nested.initializer] as const] : [],
        )
      }
      return []
    }),
  )

const bindingsOf = (fn: Tir.TirFunction): ReadonlyMap<number, Tir.Expression> =>
  bindingsOfStatements(fn.statements)

type AvailableEnvironment = Extract<
  Layout.EffectEnvironment,
  { readonly _tag: 'EffectEnvironment' }
>

interface BuildLookup {
  readonly instances: ReadonlyMap<string, Instances.Instance>
  readonly calls: ReadonlyMap<string, ReadonlyArray<Instances.CallInstance>>
  readonly environmentsByOwner: ReadonlyMap<string, ReadonlyArray<AvailableEnvironment>>
  readonly environmentsByIdentity: ReadonlyMap<string, ReadonlyArray<AvailableEnvironment>>
}

// CPU profiling found whole-discovery scans and repeated identity encoding dominating runner
// resolution across 22 convergence passes. Build these pure lookup tables once per build;
// classifications remain pass-local, and each candidate bucket retains discovery order.
const buildLookup = (discovery: Instances.Discovery, layout: Layout.Plan): BuildLookup => {
  const instances = new Map<string, Instances.Instance>()
  for (const instance of discovery.instances) {
    const identity = Instances.keyText(instance.key)
    if (!instances.has(identity)) instances.set(identity, instance)
  }
  const calls = new Map<string, Array<Instances.CallInstance>>()
  for (const call of discovery.calls) {
    const owner = Instances.keyText(call.owner)
    const group = calls.get(owner)
    if (group === undefined) calls.set(owner, [call])
    else group.push(call)
  }
  const environmentsByOwner = new Map<string, Array<AvailableEnvironment>>()
  const environmentsByIdentity = new Map<string, Array<AvailableEnvironment>>()
  for (const environment of layout.effectEnvironments) {
    if (environment._tag !== 'EffectEnvironment') continue
    const owner = Instances.keyText(environment.instance)
    const owned = environmentsByOwner.get(owner)
    if (owned === undefined) environmentsByOwner.set(owner, [environment])
    else owned.push(environment)
    const identity = Instances.effectIdentity(environment.instance, environment.site)
    const identified = environmentsByIdentity.get(identity)
    if (identified === undefined) environmentsByIdentity.set(identity, [environment])
    else identified.push(environment)
  }
  return { instances, calls, environmentsByOwner, environmentsByIdentity }
}

interface ClassificationReads {
  readonly values: ReadonlyMap<string, Classification>
  readonly observed: Map<string, Classification | undefined>
}

const readClassification = (
  self: ClassificationReads,
  identity: string,
): Classification | undefined => {
  const classification = self.values.get(identity)
  self.observed.set(identity, classification)
  return classification
}

interface BuildContext {
  readonly lookup: BuildLookup
  readonly discovery: Instances.Discovery
  readonly layout: Layout.Plan
  readonly index: DeclarationIndex.Index
  readonly instance: Instances.Instance
  readonly bindings: ReadonlyMap<number, Tir.Expression>
  readonly effectClassifications: ClassificationReads
  readonly ambientProviders: ReadonlyArray<Provider>
}

const storedEffectRealizationOf = (
  expression: Tir.Expression,
  context: BuildContext,
): FieldRealization.EffectRealization | undefined => {
  if (expression._tag === 'BindingReference') {
    const initializer = context.bindings.get(expression.binding.ordinal)
    return initializer === undefined ? undefined : storedEffectRealizationOf(initializer, context)
  }
  if (expression._tag === 'Move') return storedEffectRealizationOf(expression.subject, context)
  if (expression._tag === 'UnionConvert')
    return storedEffectRealizationOf(expression.source, context)
  if (expression._tag === 'EffectBindRequirement')
    return storedEffectRealizationOf(expression.protected, context)
  if (expression._tag !== 'Project') return undefined
  const represented = Type.substitute(
    expression.type,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  const planned = Layout.entry(context.layout, represented)?.representation
  if (planned?._tag === 'StoredEffectEnvironment') return planned.realization
  return undefined
}

const serviceResultEffectOf = (
  expression: Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }>,
  context: BuildContext,
): string | undefined => {
  const capability = Type.substitute(
    expression.service,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  if (!Type.isNominal(capability)) return undefined
  const provider = context.ambientProviders.find(
    (candidate) =>
      candidate.role === expression.role &&
      Type.equals(candidate.capability, capability) &&
      (expression.access === 'Shared' ||
        candidate.access === 'Exclusive' ||
        candidate.access === 'Take'),
  )
  const implementation =
    provider?.witness?._tag === 'SourceConformanceWitness'
      ? ConformanceProof.witnessOperation(provider.witness, expression.operation)
      : undefined
  if (implementation === undefined || provider?.witness?._tag !== 'SourceConformanceWitness')
    return undefined
  const selectedCalls = (
    context.lookup.calls.get(Instances.keyText(context.instance.key)) ?? []
  ).filter(
    (call) =>
      call.target.declaration.module === implementation.module &&
      call.target.declaration.name === implementation.name &&
      call.span.sourceId === expression.span.sourceId &&
      call.span.start === expression.span.start &&
      call.span.end === expression.span.end,
  )
  const selectedCall = selectedCalls.length === 1 ? selectedCalls.at(0) : undefined
  return selectedCall?.resultEffect
}

const effectIdentityOf = (
  expression: Tir.Expression,
  context: BuildContext,
): string | undefined => {
  if (expression._tag === 'BindingReference') {
    const initializer = context.bindings.get(expression.binding.ordinal)
    return initializer === undefined ? undefined : effectIdentityOf(initializer, context)
  }
  if (expression._tag === 'Move') return effectIdentityOf(expression.subject, context)
  if (expression._tag === 'UnionConvert') return effectIdentityOf(expression.source, context)
  if (expression._tag === 'EffectBindRequirement')
    return effectIdentityOf(expression.protected, {
      ...context,
      ambientProviders: providersOf(expression, context),
    })
  if (expression._tag === 'Project') {
    const realization = storedEffectRealizationOf(expression, context)
    const represented = Type.substitute(
      expression.type,
      context.instance.substitution,
      context.instance.specialization.compatibility,
    )
    const retainedIdentity =
      Type.isRepresented(represented) &&
      Type.isEffect(represented.contract) &&
      Type.isExactRepresentationArgument(represented.representation.argument) &&
      Type.isEffectIdentityArgument(represented.representation.argument.identity)
        ? represented.representation.argument.identity.identity
        : undefined
    return realization?.runnerIdentity ?? retainedIdentity
  }
  if (
    (expression._tag === 'InterfaceOperationCall' || expression._tag === 'BuiltinCall') &&
    expression.witnessEffectSite !== undefined
  )
    return Instances.effectIdentity(context.instance.key, expression.witnessEffectSite)
  if (
    expression._tag === 'BuiltinCall' &&
    Type.isEffect(
      Type.substitute(
        expression.type,
        context.instance.substitution,
        context.instance.specialization.compatibility,
      ),
    )
  )
    return Instances.effectIdentity(
      context.instance.key,
      Tir.builtinEffectSite(
        Tir.nodeReference(context.instance.view.artifact, expression),
        context.instance.key.declaration,
        context.instance.function.declaration.id.ordinal,
      ),
    )
  if (expression._tag === 'EffectBlock')
    return Instances.effectIdentity(context.instance.key, expression.site)
  if (expression._tag === 'EffectCatch')
    return Instances.effectIdentity(
      context.instance.key,
      Tir.effectCatchSite(
        Tir.nodeReference(context.instance.view.artifact, expression),
        context.instance.key.declaration,
        context.instance.function.declaration.id.ordinal,
      ),
    )
  if (expression._tag === 'ParameterReference')
    return Instances.parameterEffectIdentity(
      context.instance.function,
      context.instance.key,
      expression.parameter.ordinal,
    )
  // An erased section applied in place (`effect |> Effect.provideMut(&mut provider)`) is one
  // recorded call of the section's declaration, so its result Effect is identified exactly as a
  // direct call's. Without this, a provided execution that owns such a run has no runner identity
  // for it and its classification stays unknown forever.
  // The piped call is recorded at the same span, so the section's declaration is matched too;
  // together they select at most one record.
  if (
    expression._tag === 'CallableApply' &&
    expression.realization === 'DirectErasedSection' &&
    expression.callee._tag === 'CallableSection' &&
    expression.callee.target._tag === 'DeclarationCallableTarget'
  ) {
    const target = expression.callee.target.declaration
    return (context.lookup.calls.get(Instances.keyText(context.instance.key)) ?? []).find(
      (call) =>
        call.target.declaration.module === target.module &&
        call.target.declaration.name === target.name &&
        call.span.sourceId === expression.span.sourceId &&
        call.span.start === expression.span.start &&
        call.span.end === expression.span.end &&
        Instances.callMatchesProviders(call, context.ambientProviders),
    )?.resultEffect
  }
  if (
    expression._tag === 'Call' ||
    expression._tag === 'EffectConstruct' ||
    expression._tag === 'CallableApply'
  ) {
    return (context.lookup.calls.get(Instances.keyText(context.instance.key)) ?? []).find(
      (call) =>
        call.span.sourceId === expression.span.sourceId &&
        call.span.start === expression.span.start &&
        call.span.end === expression.span.end &&
        Instances.callMatchesProviders(call, context.ambientProviders),
    )?.resultEffect
  }
  if (expression._tag === 'ServiceEffectConstruct')
    return serviceResultEffectOf(expression, context)
  return undefined
}

const providersOf = (
  expression: Tir.Expression,
  context: BuildContext,
): ReadonlyArray<Provider> => {
  if (expression._tag === 'BindingReference') {
    const initializer = context.bindings.get(expression.binding.ordinal)
    return initializer === undefined ? [] : providersOf(initializer, context)
  }
  if (expression._tag === 'Move') return providersOf(expression.subject, context)
  if (expression._tag === 'UnionConvert') return providersOf(expression.source, context)
  if (expression._tag !== 'EffectBindRequirement') return context.ambientProviders
  const proof = Instances.requirementSelection(context.instance, expression.provider)
  if (proof === undefined) return providersOf(expression.protected, context)
  const selected = proof.selected
  const capability = selected.capability
  const providerType = proof.provider
  if (capability === undefined || !Type.isNominal(capability) || !Type.isNominal(providerType))
    return providersOf(expression.protected, context)
  const witness =
    expression.provider.witness ?? ConformanceProof.witness(context.index, providerType, capability)
  return [
    ...providersOf(expression.protected, context),
    {
      capability,
      providerType,
      role: selected.role,
      requirementAccess: selected.access,
      access: expression.provider.selectionAccess,
      ...(witness === undefined ? {} : { witness }),
    },
  ]
}

const witnessExpressionAt = (
  instance: Instances.Instance,
  site: Tir.EffectSiteId,
):
  | Extract<Tir.Expression, { readonly _tag: 'InterfaceOperationCall' | 'BuiltinCall' }>
  | undefined =>
  instance.function.statements
    .flatMap(statementExpressions)
    .flatMap(expressionTree)
    .find(
      (
        expression,
      ): expression is Extract<
        Tir.Expression,
        { readonly _tag: 'InterfaceOperationCall' | 'BuiltinCall' }
      > =>
        (expression._tag === 'InterfaceOperationCall' || expression._tag === 'BuiltinCall') &&
        expression.witnessEffectSite !== undefined &&
        Tir.sameExecutableSite(expression.witnessEffectSite, site),
    )

const builtinExpressionAt = (
  instance: Instances.Instance,
  site: Tir.EffectSiteId,
): Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }> | undefined =>
  instance.function.statements
    .flatMap(statementExpressions)
    .flatMap(expressionTree)
    .find(
      (expression): expression is Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }> =>
        expression._tag === 'BuiltinCall' &&
        expression.witnessEffectSite === undefined &&
        Tir.sameExecutableSite(
          Tir.builtinEffectSite(
            Tir.nodeReference(instance.view.artifact, expression),
            instance.key.declaration,
            instance.function.declaration.id.ordinal,
          ),
          site,
        ),
    )

// The captured build repeatedly resolves the same expression while finding controls and
// collecting provided runners. Cache only inside the exact build context: providers, bindings,
// substitutions, and classification reads are shared there, and a later pass uses a new context.
// Explicitly resolved runners have additional inputs and bypass this cache.
const runnerCache = new WeakMap<BuildContext, WeakMap<Tir.Expression, Runner>>()
const runnerOf = (
  expression: Tir.Expression,
  context: BuildContext,
  resolved?: {
    readonly identity: string
    readonly effect: Type.Effect
    readonly providers: ReadonlyArray<Provider>
  },
): Runner => {
  if (resolved !== undefined) return computeRunner(expression, context, resolved)
  let cache = runnerCache.get(context)
  const cached = cache?.get(expression)
  if (cached !== undefined) return cached
  const runner = computeRunner(expression, context)
  if (cache === undefined) {
    cache = new WeakMap()
    runnerCache.set(context, cache)
  }
  cache.set(expression, runner)
  return runner
}

const computeRunner = (
  expression: Tir.Expression,
  context: BuildContext,
  resolved?: {
    readonly identity: string
    readonly effect: Type.Effect
    readonly providers: ReadonlyArray<Provider>
  },
): Runner => {
  const stored = resolved === undefined ? storedEffectRealizationOf(expression, context) : undefined
  const identity = resolved?.identity ?? effectIdentityOf(expression, context)
  const expressionType =
    'type' in expression
      ? Type.substitute(
          expression.type,
          context.instance.substitution,
          context.instance.specialization.compatibility,
        )
      : undefined
  const expressionContract =
    expressionType !== undefined && Type.isRepresented(expressionType)
      ? expressionType.contract
      : expressionType
  const requested =
    resolved?.effect ??
    stored?.contract ??
    (expressionContract !== undefined && Type.isEffect(expressionContract)
      ? expressionContract
      : undefined)
  // A generic use bound can retain requirements already absent from its selected capture.
  // Resolve through the exact owner's layout field rather than treating that wider bound as
  // the physical runner contract.
  const captures = (
    context.lookup.environmentsByOwner.get(Instances.keyText(context.instance.key)) ?? []
  ).flatMap((candidate) =>
    candidate.fields.filter(
      (field) =>
        identity !== undefined &&
        (field.effectIdentity === identity || field.resolvedEffectIdentity === identity),
    ),
  )
  const capture = captures.at(0)
  const captureContract =
    capture === undefined ? undefined : EffectExecutionContract.fromType(capture.type)
  const physicalContract =
    captureContract !== undefined &&
    captures.every((field) => {
      const contract = EffectExecutionContract.fromType(field.type)
      return contract !== undefined && EffectExecutionContract.equals(contract, captureContract)
    })
      ? captureContract
      : requested
  const availableProviders = resolved?.providers ?? providersOf(expression, context)
  const environment = (
    identity === undefined ? [] : (context.lookup.environmentsByIdentity.get(identity) ?? [])
  ).find(
    (candidate) =>
      physicalContract === undefined ||
      EffectExecutionContract.matches(candidate.effect, physicalContract, availableProviders) ||
      EffectExecutionContract.providerSubtractionMatches(
        physicalContract,
        candidate.effect,
        availableProviders,
      ),
  )
  const effect =
    resolved?.effect ??
    stored?.contract ??
    (environment?._tag === 'EffectEnvironment' ? environment.effect : requested)
  if (effect === undefined)
    throw new RangeError('Provisional runner requires a resolved Effect contract')
  const providers = Type.requirementMembers(
    environment?._tag === 'EffectEnvironment' ? environment.effect : effect,
  ).flatMap((requirement) => {
    const selected = availableProviders.find(
      (provider) =>
        provider.role === requirement.role &&
        Type.equals(provider.capability, requirement.capability) &&
        (requirement.access === 'Shared' ||
          provider.access === 'Exclusive' ||
          provider.access === 'Take'),
    )
    return selected === undefined ? [] : [{ ...selected, requirementAccess: requirement.access }]
  })
  if (environment?._tag !== 'EffectEnvironment' || identity === undefined) {
    return {
      execution: {
        _tag: 'UnknownExecution',
        identity: `${context.instance.key.declaration.module}:${expression.span.start}`,
      },
      classification: 'Unknown',
      typeArguments: [],
      outcome: effect,
      captures: [],
      providers,
    }
  }
  const environmentOwner = context.lookup.instances.get(Instances.keyText(environment.instance))
  const witness =
    environmentOwner === undefined
      ? undefined
      : witnessExpressionAt(environmentOwner, environment.site)
  let executionKind:
    | 'EffectRunnerExecution'
    | 'WitnessEffectRunnerExecution'
    | 'BuiltinEffectRunnerExecution' = 'EffectRunnerExecution'
  if (witness !== undefined) executionKind = 'WitnessEffectRunnerExecution'
  else if (
    environmentOwner !== undefined &&
    builtinExpressionAt(environmentOwner, environment.site) !== undefined
  )
    executionKind = 'BuiltinEffectRunnerExecution'
  const baseExecution: ExecutionKey = {
    _tag: executionKind,
    owner: stored?.runnerInstance ?? environment.instance,
    site: stored?.site ?? environment.site,
    identity,
    runner:
      stored?.runner ?? Tir.effectRunnerId(environment.instance.declaration, environment.site),
  }
  const providedIdentity =
    providers.length === 0
      ? undefined
      : `${identity}\u0006${providers.map(providerKey).join('\u0000')}`
  const execution: ExecutionKey =
    providedIdentity === undefined
      ? baseExecution
      : {
          _tag: 'ProvidedEffectRunnerExecution',
          baseKind: executionKind,
          owner: environment.instance,
          site: environment.site,
          identity: providedIdentity,
          effectIdentity: identity,
          runner: baseExecution.runner,
          providers,
        }
  let baseClassification: Classification
  if (stored === undefined) {
    baseClassification =
      readClassification(context.effectClassifications, identity) ??
      classificationOfEffect(context.discovery, identity)
  } else if (stored.suspendable) {
    baseClassification = 'Suspendable'
  } else {
    baseClassification = 'Synchronous'
  }
  const providedClassification = (): Classification => {
    const fixedProvided =
      providedIdentity === undefined
        ? undefined
        : readClassification(context.effectClassifications, providedIdentity)
    if (fixedProvided !== undefined) return fixedProvided
    if (providedIdentity === undefined || baseClassification === 'Suspendable')
      return baseClassification
    const owner = context.lookup.instances.get(Instances.keyText(environment.instance))
    if (owner === undefined) return 'Unknown'
    const block = owner.function.statements
      .flatMap(statementExpressions)
      .flatMap(expressionTree)
      .find(
        (candidate) =>
          candidate._tag === 'EffectBlock' &&
          Tir.sameExecutableSite(candidate.site, environment.site),
      )
    // Provider substitution can only change suspendability through service constructions in an
    // explicit effect block. Bound-operation and forwarded environments have no such local
    // constructions; their discovered effect identity already carries the exact witness result.
    if (block?._tag !== 'EffectBlock') return baseClassification
    const specializedContext: BuildContext = {
      ...context,
      instance: owner,
      bindings: new Map([...bindingsOf(owner.function), ...bindingsOfStatements(block.statements)]),
      ambientProviders: providers,
    }
    if (
      block.statements
        .flatMap(statementExpressions)
        .flatMap(expressionTree)
        .some(
          (candidate) =>
            candidate._tag === 'Run' && isSuspendOrigin(candidate.subject, specializedContext),
        )
    )
      return 'Suspendable'
    for (const service of block.statements
      .flatMap(statementExpressions)
      .flatMap(expressionTree)
      .filter(
        (
          candidate,
        ): candidate is Extract<Tir.Expression, { readonly _tag: 'ServiceEffectConstruct' }> =>
          candidate._tag === 'ServiceEffectConstruct',
      )) {
      const resultEffect = serviceResultEffectOf(service, specializedContext)
      if (
        resultEffect !== undefined &&
        (readClassification(context.effectClassifications, resultEffect) === 'Suspendable' ||
          suspendableSummary(Instances.effectSuspensionOf(context.discovery, resultEffect)))
      )
        return 'Suspendable'
      const capability = Type.substitute(
        service.service,
        owner.substitution,
        owner.specialization.compatibility,
      )
      const selected = providers.find(
        (provider) =>
          Type.equals(provider.capability, capability) && provider.role === service.role,
      )
      if (selected?.witness?._tag !== 'SourceConformanceWitness') return 'Unknown'
      const implementation = ConformanceProof.witnessOperation(selected.witness, service.operation)
      if (implementation === undefined) return 'Unknown'
      const candidates = Instances.matchingSpecialization(context.discovery, {
        declaration: implementation,
        typeArguments: selected.witness.typeArguments,
      })
      if (candidates.length === 0) return 'Unknown'
      if (
        candidates.some(
          (candidate) =>
            suspendableSummary(Instances.suspensionOf(context.discovery, candidate.key)) ||
            (candidate.resultEffect !== undefined &&
              suspendableSummary(
                Instances.effectSuspensionOf(context.discovery, candidate.resultEffect),
              )),
        )
      )
        return 'Suspendable'
    }
    return 'Synchronous'
  }
  return {
    execution,
    classification: providedClassification(),
    declaration: execution.runner,
    instance: stored?.runnerInstance ?? environment.instance,
    effectIdentity: identity,
    ...(providedIdentity === undefined ? {} : { providedIdentity }),
    typeArguments: stored?.runnerArguments ?? environment.instance.typeArguments,
    outcome: stored?.contract ?? environment.effect,
    captures: environment.fields.map((field, ordinal) => ({
      ordinal,
      source: field.source,
      sourceOrdinal: field.ordinal,
      access: field.access,
      type: field.type,
    })),
    providers,
  }
}

const reifyPolicy = (
  outcome: Type.Effect,
  context: BuildContext,
): Extract<CompletionPolicy, { readonly _tag: 'Reify' }> | undefined => {
  const failureValueType = Type.failureValue(Type.failureMembers(outcome))
  const successType = outcome.success
  const outcomeShape = Layout.callingShape(context.layout, outcome)
  const successShape = Layout.callingShape(context.layout, successType)
  const failureValueShape = Layout.callingShape(context.layout, failureValueType)
  if (outcomeShape === undefined || successShape === undefined || failureValueShape === undefined)
    return undefined
  return {
    _tag: 'Reify',
    outcome,
    successType,
    failureValueType,
    successShape,
    outcomeShape,
    failureValueShape,
  }
}

const isSuspendOrigin = (expression: Tir.Expression, context: BuildContext): boolean => {
  if (expression._tag === 'BindingReference') {
    const initializer = context.bindings.get(expression.binding.ordinal)
    return initializer !== undefined && isSuspendOrigin(initializer, context)
  }
  if (expression._tag === 'Move') return isSuspendOrigin(expression.subject, context)
  if (expression._tag === 'UnionConvert') return isSuspendOrigin(expression.source, context)
  if (expression._tag === 'EffectBindRequirement')
    return isSuspendOrigin(expression.protected, context)
  return expression._tag === 'BuiltinCall' && expression.operation === 'EffectSuspend'
}

const deferredOf = (
  expression: Tir.Expression,
  context: BuildContext,
): Tir.Expression | undefined => {
  if (expression._tag === 'BindingReference') {
    const initializer = context.bindings.get(expression.binding.ordinal)
    return initializer === undefined ? undefined : deferredOf(initializer, context)
  }
  if (expression._tag === 'Move') return deferredOf(expression.subject, context)
  if (expression._tag === 'UnionConvert') return deferredOf(expression.source, context)
  if (expression._tag === 'EffectBindRequirement') return deferredOf(expression.protected, context)
  return expression._tag === 'BuiltinCall' && expression.operation === 'EffectSuspend'
    ? expression.arguments.at(0)
    : undefined
}

const effectCatchOf = (
  expression: Tir.Expression,
  context: BuildContext,
  resolving: ReadonlySet<number> = new Set(),
): Extract<Tir.Expression, { readonly _tag: 'EffectCatch' }> | undefined => {
  if (expression._tag === 'BindingReference') {
    const ordinal = expression.binding.ordinal
    if (resolving.has(ordinal)) return undefined
    const initializer = context.bindings.get(ordinal)
    return initializer === undefined
      ? undefined
      : effectCatchOf(initializer, context, new Set(resolving).add(ordinal))
  }
  if (expression._tag === 'Move') return effectCatchOf(expression.subject, context, resolving)
  return expression._tag === 'EffectCatch' ? expression : undefined
}

const runSpanOfCatch = (
  statements: ReadonlyArray<Tir.Statement>,
  target: Extract<Tir.Expression, { readonly _tag: 'EffectCatch' }>,
  context: BuildContext,
): SourceSpan.SourceSpan =>
  statements
    .flatMap(statementExpressions)
    .flatMap(expressionTree)
    .find(
      (candidate) =>
        candidate._tag === 'Run' && effectCatchOf(candidate.subject, context) === target,
    )?.span ?? target.span

const catchHandlerRunner = (
  expression: Extract<Tir.Expression, { readonly _tag: 'EffectCatch' }>,
  context: BuildContext,
): Runner | undefined => {
  if (expression.handler._tag === 'Unavailable') return undefined
  const catchIdentity = effectIdentityOf(expression, context)
  const catchEffect = context.discovery.effects.find(
    (candidate) => candidate.identity === catchIdentity,
  )
  // The catch environment always stores [protected effect, handler callable], but the handler is
  // selected by its callable identity rather than by position so a capture-layout change cannot
  // silently misclassify the handler as synchronous.
  const callableIdentity = catchEffect?.captures.find(
    (capture) => capture.callableIdentity !== undefined,
  )?.callableIdentity
  const handlerType = Type.substitute(
    expression.handler.type,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  if (
    callableIdentity?.target._tag !== 'Declaration' ||
    !Type.isCallable(handlerType) ||
    !Type.isEffect(handlerType.result)
  )
    return undefined
  const declaration: DeclarationFacts.CanonicalId = {
    _tag: 'CanonicalDeclarationId',
    module: callableIdentity.target.module,
    name: callableIdentity.target.name,
  }
  const identities = [
    ...new Set(
      Instances.matchingSpecialization(context.discovery, {
        declaration,
        typeArguments: callableIdentity.typeArguments,
      }).flatMap((candidate) =>
        candidate.resultEffect === undefined ? [] : [candidate.resultEffect],
      ),
    ),
  ]
  const identity = identities.length === 1 ? identities.at(0) : undefined
  return identity === undefined
    ? undefined
    : runnerOf(expression.handler, context, {
        identity,
        effect: handlerType.result,
        providers: context.ambientProviders,
      })
}

const callableIdentityOf = (
  expression: Tir.Expression,
  context: BuildContext,
): Type.CallableIdentityArgument | undefined => {
  if (expression._tag === 'Unavailable') return undefined
  const specialized = Type.substitute(
    expression.type,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  if (
    Type.isRepresented(specialized) &&
    Type.isExactRepresentationArgument(specialized.representation.argument) &&
    Type.isCallableIdentityArgument(specialized.representation.argument.identity)
  )
    return specialized.representation.argument.identity
  if (expression._tag === 'BindingReference') {
    const initializer = context.bindings.get(expression.binding.ordinal)
    return initializer === undefined ? undefined : callableIdentityOf(initializer, context)
  }
  if (expression._tag === 'Move') return callableIdentityOf(expression.subject, context)
  if (expression._tag === 'UnionConvert') return callableIdentityOf(expression.source, context)
  if (expression._tag === 'ParameterReference')
    return Instances.parameterCallableIdentity(
      context.instance.function,
      context.instance.key,
      expression.parameter.ordinal,
    )
  if (expression._tag !== 'CallableSection' && expression._tag !== 'FunctionItem') return undefined
  const target = Tir.callableTargetIdentity(expression.target)
  const callable =
    expression._tag !== 'CallableSection'
      ? undefined
      : context.discovery.callables.find(
          (candidate) =>
            Instances.keyText(candidate.owner) === Instances.keyText(context.instance.key) &&
            Tir.executableSiteKey(candidate.site) === Tir.executableSiteKey(expression.site),
        )
  if (
    expression._tag === 'CallableSection' &&
    expression.captures.length > 0 &&
    callable === undefined
  )
    return undefined
  return Type.callableIdentityArgument(
    target._tag === 'Declaration'
      ? `declaration:${target.module}:${target.name}`
      : `builtin:${target.actor}:${target.operation}`,
    target,
    callable?.typeArguments ??
      expression.typeArguments.map((argument) =>
        Type.substituteGenericArgument(
          argument,
          context.instance.substitution,
          context.instance.specialization.compatibility,
        ),
      ),
    callable === undefined ? undefined : Instances.callableEnvironmentIdentity(callable),
  )
}

const builtinEffectCallbackRunner = (
  expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>,
  argumentOrdinal: number,
  context: BuildContext,
): Runner | undefined => {
  const argument = expression.arguments.at(argumentOrdinal)
  if (argument === undefined || argument._tag === 'Unavailable') return undefined
  const callableIdentity = callableIdentityOf(argument, context)
  const specialized = Type.substitute(
    argument.type,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  const callableType = Type.isRepresented(specialized) ? specialized.contract : specialized
  if (
    callableIdentity?.target._tag !== 'Declaration' ||
    !Type.isCallable(callableType) ||
    !Type.isEffect(callableType.result)
  )
    return undefined
  const declaration: DeclarationFacts.CanonicalId = {
    _tag: 'CanonicalDeclarationId',
    module: callableIdentity.target.module,
    name: callableIdentity.target.name,
  }
  const environment =
    callableIdentity.environment === undefined
      ? undefined
      : Layout.callableEnvironmentByIdentity(context.layout, callableIdentity.environment)
  if (callableIdentity.environment !== undefined && environment?._tag !== 'CallableEnvironment')
    return undefined
  const typeArguments =
    environment?._tag === 'CallableEnvironment'
      ? Layout.callableTargetArguments(environment)
      : callableIdentity.typeArguments
  const identities = [
    ...new Set(
      Instances.matchingSpecialization(context.discovery, {
        declaration,
        typeArguments,
      }).flatMap((candidate) =>
        candidate.resultEffect === undefined ? [] : [candidate.resultEffect],
      ),
    ),
  ]
  const identity = identities.length === 1 ? identities.at(0) : undefined
  return identity === undefined
    ? undefined
    : runnerOf(argument, context, {
        identity,
        effect: callableType.result,
        providers: context.ambientProviders,
      })
}

const controlsOfCatch = (
  expression: Extract<Tir.Expression, { readonly _tag: 'EffectCatch' }>,
  execution: ExecutionKey,
  context: BuildContext,
  ordinalOffset = 0,
  runSpan = expression.span,
): ReadonlyArray<Region> => {
  const regions: Array<Region> = []
  if (expression.protected._tag === 'Unavailable') return regions
  const protectedEffect = Type.substitute(
    expression.protected.type,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  const resultEffect = Type.substitute(
    expression.type,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  if (!Type.isEffect(protectedEffect) || !Type.isEffect(resultEffect)) return []

  const protectedRunner = runnerOf(expression.protected, context)
  const selected = Type.substitute(
    expression.selected,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  if (Type.isNever(selected)) {
    if (protectedRunner.classification === 'Synchronous') return regions
    const policy: Extract<CompletionPolicy, { readonly _tag: 'Propagate' }> = {
      _tag: 'Propagate',
      outcome: protectedRunner.outcome,
      failureMappings: Type.failureMembers(protectedRunner.outcome).map((_failure, source) => ({
        source: source + 1,
        target: source + 1,
      })),
    }
    const id = controlId(execution, runSpan, ordinalOffset, 'Invoke')
    const complete = controlId(execution, runSpan, ordinalOffset, 'Complete')
    return [
      {
        _tag: 'ProvisionalRegion',
        id,
        outcome: {
          _tag: 'RunSuspendableEffect',
          runner: protectedRunner,
          completion: policy,
          complete,
          relay: {
            _tag: 'RelayExistingTransfer',
            preserves: ['Child', 'Origin', 'TypedOutcome'] as const,
          },
          span: runSpan,
        },
      },
      {
        _tag: 'ProvisionalRegion',
        id: complete,
        outcome: { _tag: 'Complete', policy },
      },
    ]
  }
  const protectedPolicy = reifyPolicy(protectedRunner.outcome, context)
  if (protectedRunner.classification !== 'Synchronous' && protectedPolicy !== undefined) {
    const id = controlId(execution, expression.span, ordinalOffset, 'Invoke')
    const complete = controlId(execution, expression.span, ordinalOffset, 'Complete')
    regions.push(
      {
        _tag: 'ProvisionalRegion',
        id,
        outcome: {
          _tag: 'RunSuspendableEffect',
          runner: protectedRunner,
          completion: protectedPolicy,
          complete,
          relay: {
            _tag: 'RelayExistingTransfer',
            preserves: ['Child', 'Origin', 'TypedOutcome'] as const,
          },
          span: expression.span,
        },
      },
      {
        _tag: 'ProvisionalRegion',
        id: complete,
        outcome: { _tag: 'Complete', policy: protectedPolicy },
      },
    )
  }

  const handlerRunner = catchHandlerRunner(expression, context)
  if (
    handlerRunner?.classification !== 'Suspendable' &&
    handlerRunner?.classification !== 'Unknown'
  )
    return regions
  const mappings = Type.failureMembers(handlerRunner.outcome).flatMap((failure, source) => {
    const target = Type.failureMembers(resultEffect).findIndex((candidate) =>
      Type.equals(candidate, failure),
    )
    return target < 0 ? [] : [{ source: source + 1, target: target + 1 }]
  })
  if (mappings.length !== Type.failureMembers(handlerRunner.outcome).length) return regions
  const policy: Extract<CompletionPolicy, { readonly _tag: 'Propagate' }> = {
    _tag: 'Propagate',
    outcome: handlerRunner.outcome,
    failureMappings: mappings,
  }
  // The selected handler executes at the enclosing Run span. CatchEffect itself uses the
  // protected expression span; conflating them loses the handler's exact ownership control.
  const id = controlId(execution, runSpan, ordinalOffset + 1, 'Invoke')
  const complete = controlId(execution, runSpan, ordinalOffset + 1, 'Complete')
  regions.push(
    {
      _tag: 'ProvisionalRegion',
      id,
      outcome: {
        _tag: 'RunSuspendableEffect',
        runner: handlerRunner,
        completion: policy,
        complete,
        relay: {
          _tag: 'RelayExistingTransfer',
          preserves: ['Child', 'Origin', 'TypedOutcome'] as const,
        },
        span: runSpan,
      },
    },
    {
      _tag: 'ProvisionalRegion',
      id: complete,
      outcome: { _tag: 'Complete', policy },
    },
  )
  return regions
}

const controlsOfExpressions = (
  expressions: ReadonlyArray<Tir.Expression>,
  execution: ExecutionKey,
  executionClassification: Classification,
  context: BuildContext,
): ReadonlyArray<Region> => {
  const regions: Array<Region> = []
  let ordinal = 0
  const maySpecializeProviders =
    execution._tag === 'ProvidedEffectRunnerExecution' ||
    expressions
      .flatMap(expressionTree)
      .some((candidate) => candidate._tag === 'EffectBindRequirement')
  const visit = (expression: Tir.Expression): void => {
    if (expression._tag === 'EffectBlock') return
    if (expression._tag === 'Run') {
      const idOrdinal = ordinal
      ordinal += 1
      if (
        expression.subject._tag === 'BuiltinCall' &&
        (expression.subject.operation === 'EffectFinalize' ||
          expression.subject.operation === 'EffectFinalizeNonParking')
      ) {
        for (const [inputOrdinal, argument] of expression.subject.arguments.entries()) {
          const runner = runnerOf(argument, context)
          if (runner.classification === 'Synchronous') continue
          const policy =
            inputOrdinal === 0 && Type.failureMembers(runner.outcome).length > 0
              ? reifyPolicy(runner.outcome, context)
              : {
                  _tag: 'Propagate' as const,
                  outcome: runner.outcome,
                  failureMappings: [],
                }
          if (policy === undefined) continue
          const id = controlId(execution, argument.span, idOrdinal + inputOrdinal, 'Invoke')
          const complete = controlId(execution, argument.span, idOrdinal + inputOrdinal, 'Complete')
          regions.push(
            {
              _tag: 'ProvisionalRegion',
              id,
              outcome: {
                _tag: 'RunSuspendableEffect',
                runner,
                completion: policy,
                complete,
                relay: {
                  _tag: 'RelayExistingTransfer',
                  preserves: ['Child', 'Origin', 'TypedOutcome'] as const,
                },
                span: argument.span,
              },
            },
            {
              _tag: 'ProvisionalRegion',
              id: complete,
              outcome: { _tag: 'Complete', policy },
            },
          )
        }
        ordinal += 1
        for (const child of Tir.expressionChildren(expression.subject)) visit(child)
        return
      }
      if (
        expression.subject._tag === 'BuiltinCall' &&
        expression.subject.operation === 'EffectUseReleaseNonParking'
      ) {
        for (const [offset, argumentOrdinal] of [1, 2].entries()) {
          const argument = expression.subject.arguments.at(argumentOrdinal)
          const runner = builtinEffectCallbackRunner(expression.subject, argumentOrdinal, context)
          if (
            argument === undefined ||
            runner === undefined ||
            runner.classification === 'Synchronous'
          )
            continue
          const policy =
            offset === 0 && Type.failureMembers(runner.outcome).length > 0
              ? reifyPolicy(runner.outcome, context)
              : {
                  _tag: 'Propagate' as const,
                  outcome: runner.outcome,
                  failureMappings: [],
                }
          if (policy === undefined) continue
          const id = controlId(execution, argument.span, idOrdinal + offset, 'Invoke')
          const complete = controlId(execution, argument.span, idOrdinal + offset, 'Complete')
          regions.push(
            {
              _tag: 'ProvisionalRegion',
              id,
              outcome: {
                _tag: 'RunSuspendableEffect',
                runner,
                completion: policy,
                complete,
                relay: {
                  _tag: 'RelayExistingTransfer',
                  preserves: ['Child', 'Origin', 'TypedOutcome'] as const,
                },
                span: argument.span,
              },
            },
            {
              _tag: 'ProvisionalRegion',
              id: complete,
              outcome: { _tag: 'Complete', policy },
            },
          )
        }
        ordinal += 1
        for (const child of Tir.expressionChildren(expression.subject)) visit(child)
        return
      }
      const caught = effectCatchOf(expression.subject, context)
      if (caught !== undefined) {
        regions.push(...controlsOfCatch(caught, execution, context, idOrdinal, expression.span))
        ordinal += 1
        return
      }
      if (
        execution._tag === 'BuiltinEffectRunnerExecution' &&
        isSuspendOrigin(expression.subject, context)
      ) {
        const deferred = deferredOf(expression.subject, context)
        if (deferred !== undefined) {
          const id = controlId(execution, expression.span, idOrdinal, 'Origin')
          regions.push({
            _tag: 'ProvisionalRegion',
            id,
            outcome: {
              _tag: 'SuspendEffect',
              deferred: runnerOf(deferred, context),
              transfer: { _tag: 'OriginateTransfer' },
              span: expression.span,
            },
          })
        }
      } else {
        const protected_ = expression.subject
        const storedSuspendable =
          storedEffectRealizationOf(protected_, context)?.suspendable === true
        const runner = runnerOf(protected_, context)
        const fixedClassification = readClassification(
          context.effectClassifications,
          effectIdentityOf(protected_, context) ?? '',
        )
        // The concrete fixed point proves that no call or run in this execution can transfer.
        // Stored Effects add their realization's suspendability dependency after the ordinary
        // execution fixed point, so that exact runner may still require relay control here.
        if (
          executionClassification === 'Synchronous' &&
          !maySpecializeProviders &&
          !storedSuspendable &&
          (fixedClassification === undefined || fixedClassification === 'Synchronous')
        ) {
          for (const child of Tir.expressionChildren(expression)) visit(child)
          return
        }
        if (runner.classification !== 'Synchronous') {
          const policy = {
            _tag: 'Propagate' as const,
            outcome: runner.outcome,
            failureMappings: Type.failureMembers(runner.outcome).map((_failure, source) => ({
              source: source + 1,
              target: source + 1,
            })),
          }
          if (policy !== undefined) {
            const id = controlId(execution, expression.span, idOrdinal, 'Invoke')
            const complete = controlId(execution, expression.span, idOrdinal, 'Complete')
            regions.push(
              {
                _tag: 'ProvisionalRegion',
                id,
                outcome: {
                  _tag: 'RunSuspendableEffect',
                  runner,
                  completion: policy,
                  complete,
                  relay: {
                    _tag: 'RelayExistingTransfer',
                    preserves: ['Child', 'Origin', 'TypedOutcome'] as const,
                  },
                  span: expression.span,
                },
              },
              {
                _tag: 'ProvisionalRegion',
                id: complete,
                outcome: { _tag: 'Complete', policy },
              },
            )
          }
        }
      }
    }
    for (const child of Tir.expressionChildren(expression)) visit(child)
  }
  for (const expression of expressions) visit(expression)
  return regions
}

const controlsOf = (
  statements: ReadonlyArray<Tir.Statement>,
  execution: ExecutionKey,
  classification: Classification,
  context: BuildContext,
): ReadonlyArray<Region> =>
  controlsOfExpressions(
    statements.flatMap(statementExpressions),
    execution,
    classification,
    context,
  )

const builtinExecution = (
  expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>,
  context: BuildContext,
): Execution | undefined => {
  const effect = Type.substitute(
    expression.type,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  if (!Type.isEffect(effect)) return undefined
  const site = Tir.builtinEffectSite(
    Tir.nodeReference(context.instance.view.artifact, expression),
    context.instance.key.declaration,
    context.instance.function.declaration.id.ordinal,
  )
  const identity = Instances.effectIdentity(context.instance.key, site)
  const key: ExecutionKey = {
    _tag: 'BuiltinEffectRunnerExecution',
    owner: context.instance.key,
    site,
    identity,
    runner: Tir.effectRunnerId(context.instance.key.declaration, site),
  }
  const classification = classificationOfEffect(context.discovery, identity)
  const regions = controlsOfExpressions(
    [
      {
        _tag: 'Run',
        subject: expression,
        type: effect.success,
        span: expression.span,
        origin: expression.origin,
      },
    ],
    key,
    classification,
    context,
  )
  return {
    _tag: 'ProvisionalExecution',
    key,
    classification: classificationWithRegions(classification, regions),
    regions,
  }
}

const providedRunnersOf = (
  expressions: ReadonlyArray<Tir.Expression>,
  context: BuildContext,
): ReadonlyArray<Runner> => {
  const runners: Array<Runner> = []
  const visit = (expression: Tir.Expression): void => {
    if (expression._tag === 'EffectBlock') return
    if (expression._tag === 'EffectCatch') {
      const protectedRunner = runnerOf(expression.protected, context)
      const handler = catchHandlerRunner(expression, context)
      for (const runner of [protectedRunner, handler])
        if (runner?.execution._tag === 'ProvidedEffectRunnerExecution') runners.push(runner)
    }
    if (expression._tag === 'Run') {
      const protected_ = expression.subject
      if (
        protected_._tag === 'BuiltinCall' &&
        protected_.operation === 'EffectUseReleaseNonParking'
      ) {
        // Directly run brackets do not construct a retained Effect environment. Follow both
        // callback arguments even when their open execution is currently synchronous: a selected
        // provider in a nested callback can introduce parking during the classification fixpoint.
        for (const ordinal of [1, 2]) {
          const callback = builtinEffectCallbackRunner(protected_, ordinal, context)
          if (callback?.execution._tag === 'ProvidedEffectRunnerExecution') runners.push(callback)
        }
      }
      const runner = runnerOf(protected_, context)
      if (runner.execution._tag === 'ProvidedEffectRunnerExecution') runners.push(runner)
    }
    for (const child of Tir.expressionChildren(expression)) visit(child)
  }
  for (const expression of expressions) visit(expression)
  return runners
}

/** The adapter itself runs the selected implementation's returned Effect. */
const witnessExecution = (
  expression: Extract<Tir.Expression, { readonly _tag: 'InterfaceOperationCall' | 'BuiltinCall' }>,
  context: BuildContext,
  providedKey?: Extract<ExecutionKey, { readonly _tag: 'ProvidedEffectRunnerExecution' }>,
): { readonly execution: Execution; readonly selectedRunner?: Runner } | undefined => {
  const site = expression.witnessEffectSite
  const bound =
    expression._tag === 'InterfaceOperationCall' ? expression : expression.interfaceOperation
  if (site === undefined || bound === undefined) return undefined
  const capability = Type.substitute(
    bound.capability,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  const provider = Type.substitute(
    bound.provider,
    context.instance.substitution,
    context.instance.specialization.compatibility,
  )
  if (!Type.isNominal(capability)) return undefined
  const selected = ConformanceProof.interfaceWitnessTarget(
    context.index,
    provider,
    capability,
    bound.operation,
    bound.contract,
    context.instance.substitution,
  )
  const key: ExecutionKey = providedKey ?? {
    _tag: 'WitnessEffectRunnerExecution',
    owner: context.instance.key,
    site,
    identity: Instances.effectIdentity(context.instance.key, site),
    runner: Tir.effectRunnerId(context.instance.key.declaration, site),
  }
  const regions: Array<Region> = []
  let classification: Classification = 'Unknown'
  let selectedRunner: Runner | undefined
  if (selected === undefined) {
    const intrinsic = ConformanceProof.interfaceOperationIntrinsic(
      context.index,
      provider,
      capability,
      bound.operation,
    )
    if (intrinsic?.rule._tag !== 'BuiltinRule') return undefined
    classification = classificationOfEffect(context.discovery, key.identity)
  } else {
    const candidates = Instances.matchingSpecialization(context.discovery, {
      declaration: selected.implementation,
      typeArguments: selected.typeArguments,
    })
    const target = candidates.length === 1 ? candidates.at(0) : undefined
    if (target === undefined) return undefined
    if (target.function.declaration.functionKind === 'Ordinary') {
      classification = suspendableSummary(
        Instances.executionSuspensionOf(context.discovery, target.key),
      )
        ? 'Suspendable'
        : 'Synchronous'
    } else if (target.resultEffect !== undefined) {
      const result = target.specialization.result
      const effect = Type.isRepresented(result) ? result.contract : result
      if (!Type.isEffect(effect)) return undefined
      const runner = runnerOf(expression, context, {
        identity: target.resultEffect,
        effect,
        providers: context.ambientProviders,
      })
      if (runner.execution._tag === 'UnknownExecution') return undefined
      selectedRunner = runner
      classification = runner.classification
      if (classification !== 'Synchronous') {
        const policy: CompletionPolicy = {
          _tag: 'Propagate',
          outcome: runner.outcome,
          failureMappings: Type.failureMembers(runner.outcome).map((_failure, ordinal) => ({
            source: ordinal + 1,
            target: ordinal + 1,
          })),
        }
        const complete = controlId(key, expression.span, 0, 'Complete')
        regions.push(
          {
            _tag: 'ProvisionalRegion',
            id: controlId(key, expression.span, 0, 'Invoke'),
            outcome: {
              _tag: 'RunSuspendableEffect',
              runner,
              completion: policy,
              complete,
              relay: {
                _tag: 'RelayExistingTransfer',
                preserves: ['Child', 'Origin', 'TypedOutcome'] as const,
              },
              span: expression.span,
            },
          },
          {
            _tag: 'ProvisionalRegion',
            id: complete,
            outcome: { _tag: 'Complete', policy },
          },
        )
      }
    }
  }
  return {
    execution: {
      _tag: 'ProvisionalExecution',
      key,
      classification,
      regions: regions,
    },
    ...(selectedRunner === undefined ? {} : { selectedRunner }),
  }
}

const classificationWithRegions = (
  base: Classification,
  regions: ReadonlyArray<Region>,
): Classification =>
  regions.reduce<Classification>((classification, region) => {
    if (region.outcome._tag !== 'RunSuspendableEffect') return classification
    if (region.outcome.runner.classification === 'Suspendable') return 'Suspendable'
    return classification === 'Synchronous' ? 'Unknown' : classification
  }, base)

interface BuildFragment {
  readonly executions: ReadonlyArray<Execution>
  readonly providedRunners: ReadonlyArray<Runner>
  readonly dependencies: ReadonlyMap<string, Classification | undefined>
}

interface ProvidedBuild {
  readonly runner: Runner
  readonly fragment: BuildFragment
}

interface BuildState {
  readonly discovery: Instances.Discovery
  readonly layout: Layout.Plan
  readonly index: DeclarationIndex.Index
  readonly lookup: BuildLookup
  readonly instanceBuilds: Map<Instances.Instance, BuildFragment>
  readonly providedBuilds: Map<string, ProvidedBuild>
}

const buildContext = (
  state: BuildState,
  instance: Instances.Instance,
  classifications: ReadonlyMap<string, Classification>,
  providers: ReadonlyArray<Provider>,
): BuildContext => ({
  discovery: state.discovery,
  layout: state.layout,
  index: state.index,
  lookup: state.lookup,
  instance,
  bindings: bindingsOf(instance.function),
  effectClassifications: { values: classifications, observed: new Map() },
  ambientProviders: providers,
})

const buildFragment = (
  context: BuildContext,
  executions: Array<Execution>,
  providedRunners: Array<Runner>,
): BuildFragment => ({
  executions: executions,
  providedRunners: providedRunners,
  dependencies: context.effectClassifications.observed,
})

// A 22-pass build reconstructed 63,136 executions to produce 2,888 final executions. Reuse
// fragments only while every classification read is unchanged. Missing entries are dependencies
// too: discovering a formerly unknown runner must invalidate its consumers on the next pass.
const canReuseBuild = (
  fragment: BuildFragment,
  classifications: ReadonlyMap<string, Classification>,
): boolean => {
  for (const [identity, previous] of fragment.dependencies) {
    if (classifications.get(identity) !== previous) return false
  }
  return true
}

const buildInstance = (context: BuildContext): BuildFragment => {
  const { discovery, instance } = context
  const executions: Array<Execution> = []
  const providedRunners: Array<Runner> = []
  const instanceKey: ExecutionKey = {
    _tag: 'InstanceExecution',
    instance: instance.key,
    functionOrdinal: instance.function.declaration.id.ordinal,
    identity: Instances.keyText(instance.key),
  }
  const instanceClassification: Classification = suspendableSummary(
    Instances.executionSuspensionOf(discovery, instance.key),
  )
    ? 'Suspendable'
    : 'Synchronous'
  const instanceRegions = controlsOf(
    instance.function.statements,
    instanceKey,
    instanceClassification,
    context,
  )
  providedRunners.push(
    ...providedRunnersOf(instance.function.statements.flatMap(statementExpressions), context),
  )
  executions.push({
    _tag: 'ProvisionalExecution',
    key: instanceKey,
    classification: classificationWithRegions(instanceClassification, instanceRegions),
    regions: instanceRegions,
  })
  const expressions = instance.function.statements
    .flatMap(statementExpressions)
    .flatMap(expressionTree)
  // Suspension always owns a generated runner: its terminal origin must not
  // discard the caller's continuation. Other directly run builtins stay inline.
  const directlyRunBuiltins = new Set(
    expressions.flatMap((expression) =>
      expression._tag === 'Run' && expression.subject._tag === 'BuiltinCall'
        ? [expression.subject]
        : [],
    ),
  )
  for (const expression of expressions) {
    if (
      (expression._tag === 'InterfaceOperationCall' || expression._tag === 'BuiltinCall') &&
      expression.witnessEffectSite !== undefined
    ) {
      const execution = witnessExecution(expression, context)
      if (execution !== undefined) {
        executions.push(execution.execution)
        if (execution.selectedRunner?.execution._tag === 'ProvidedEffectRunnerExecution')
          providedRunners.push(execution.selectedRunner)
      }
      continue
    }
    if (expression._tag === 'BuiltinCall') {
      if (directlyRunBuiltins.has(expression) && expression.operation !== 'EffectSuspend') continue
      const execution = builtinExecution(expression, context)
      if (execution !== undefined) executions.push(execution)
      continue
    }
    if (expression._tag !== 'EffectBlock' && expression._tag !== 'EffectCatch') continue
    const site =
      expression._tag === 'EffectBlock'
        ? expression.site
        : Tir.effectCatchSite(
            Tir.nodeReference(instance.view.artifact, expression),
            instance.key.declaration,
            instance.function.declaration.id.ordinal,
          )
    const identity = Instances.effectIdentity(instance.key, site)
    const key: ExecutionKey = {
      _tag: 'EffectRunnerExecution',
      owner: instance.key,
      site,
      identity,
      runner: Tir.effectRunnerId(instance.key.declaration, site),
    }
    const runnerClassification =
      readClassification(context.effectClassifications, identity) ??
      classificationOfEffect(discovery, identity)
    const runnerContext: BuildContext = {
      ...context,
      bindings:
        expression._tag === 'EffectBlock'
          ? new Map([...context.bindings, ...bindingsOfStatements(expression.statements)])
          : context.bindings,
    }
    const regions =
      expression._tag === 'EffectBlock'
        ? controlsOf(expression.statements, key, runnerClassification, runnerContext)
        : controlsOfCatch(
            expression,
            key,
            runnerContext,
            0,
            runSpanOfCatch(instance.function.statements, expression, runnerContext),
          )
    if (expression._tag === 'EffectBlock')
      providedRunners.push(
        ...providedRunnersOf(expression.statements.flatMap(statementExpressions), runnerContext),
      )
    else
      providedRunners.push(
        ...regions.flatMap((region) =>
          region.outcome._tag === 'RunSuspendableEffect' &&
          region.outcome.runner.execution._tag === 'ProvidedEffectRunnerExecution'
            ? [region.outcome.runner]
            : [],
        ),
      )
    const specializedClassification = classificationWithRegions(runnerClassification, regions)
    executions.push({
      _tag: 'ProvisionalExecution',
      key,
      classification: specializedClassification,
      regions,
    })
  }
  return buildFragment(context, executions, providedRunners)
}

// Provider-specialized runners are distinct executions. Transparent bodies may omit their own
// execution while still discovering nested provided runners; both outputs belong to the cache.
const buildProvidedRunner = (runner: Runner, context: BuildContext): BuildFragment => {
  const executions: Array<Execution> = []
  const providedRunners: Array<Runner> = []
  const key = runner.execution
  if (key._tag !== 'ProvidedEffectRunnerExecution')
    return buildFragment(context, executions, providedRunners)
  const owner = context.instance
  // A witness adapter has no authored Effect block. Follow its selected implementation
  // with the same lexical providers so nested service calls retain their transfer control.
  if (key.baseKind === 'WitnessEffectRunnerExecution') {
    const witness = witnessExpressionAt(owner, key.site)
    if (witness === undefined) return buildFragment(context, executions, providedRunners)
    const selected = witnessExecution(witness, context, key)
    if (selected === undefined) return buildFragment(context, executions, providedRunners)
    executions.push(selected.execution)
    if (selected.selectedRunner?.execution._tag === 'ProvidedEffectRunnerExecution')
      providedRunners.push(selected.selectedRunner)
    return buildFragment(context, executions, providedRunners)
  }
  const body = owner.function.statements
    .flatMap(statementExpressions)
    .flatMap(expressionTree)
    .find((candidate) => {
      if (candidate._tag === 'EffectBlock') return Tir.sameExecutableSite(candidate.site, key.site)
      if (candidate._tag !== 'EffectCatch') return false
      return Tir.sameExecutableSite(
        Tir.effectCatchSite(
          Tir.nodeReference(owner.view.artifact, candidate),
          owner.key.declaration,
          owner.function.declaration.id.ordinal,
        ),
        key.site,
      )
    })
  if (body?._tag !== 'EffectBlock' && body?._tag !== 'EffectCatch')
    return buildFragment(context, executions, providedRunners)
  const specializesProviderDispatch =
    body._tag === 'EffectCatch' ||
    body.statements
      .flatMap(statementExpressions)
      .flatMap(expressionTree)
      .some(
        (expression) =>
          expression._tag === 'ServiceEffectConstruct' ||
          expression._tag === 'EffectBindRequirement',
      )
  const runnerContext: BuildContext = {
    ...context,
    bindings:
      body._tag === 'EffectBlock'
        ? new Map([...context.bindings, ...bindingsOfStatements(body.statements)])
        : context.bindings,
  }
  const regions =
    body._tag === 'EffectBlock'
      ? controlsOf(body.statements, key, runner.classification, runnerContext)
      : controlsOfCatch(
          body,
          key,
          runnerContext,
          0,
          runSpanOfCatch(owner.function.statements, body, runnerContext),
        )
  providedRunners.push(
    ...providedRunnersOf(
      body._tag === 'EffectBlock' ? body.statements.flatMap(statementExpressions) : [body],
      runnerContext,
    ),
  )
  const relaysProvidedRunner = regions.some(
    (region) =>
      region.outcome._tag === 'RunSuspendableEffect' &&
      region.outcome.runner.execution._tag === 'ProvidedEffectRunnerExecution',
  )
  // A provider can affect this block either at a local service/binding operation or through a
  // nested provided runner. Always scan transparent blocks above, but reuse their open
  // execution when the provider changes neither local dispatch nor relay control. In
  // particular, this avoids duplicating direct suspension origins whose allocator provider is
  // consumed only by the suspension primitive itself.
  if (!specializesProviderDispatch && !relaysProvidedRunner)
    return buildFragment(context, executions, providedRunners)
  const execution: Execution = {
    _tag: 'ProvisionalExecution',
    key,
    classification: classificationWithRegions(runner.classification, regions),
    regions,
  }
  executions.push(execution)
  for (const region of regions) {
    const outcome = region.outcome
    if (
      outcome._tag === 'RunSuspendableEffect' &&
      outcome.runner.execution._tag === 'ProvidedEffectRunnerExecution'
    )
      providedRunners.push(outcome.runner)
  }
  return buildFragment(context, executions, providedRunners)
}

const buildPass = (
  state: BuildState,
  classifications: ReadonlyMap<string, Classification>,
): Module => {
  const executions: Array<Execution> = []
  const pendingProvided: Array<Runner> = []
  for (const instance of state.discovery.instances) {
    let fragment = state.instanceBuilds.get(instance)
    if (fragment === undefined || !canReuseBuild(fragment, classifications)) {
      fragment = buildInstance(buildContext(state, instance, classifications, []))
      state.instanceBuilds.set(instance, fragment)
    }
    executions.push(...fragment.executions)
    pendingProvided.push(...fragment.providedRunners)
  }

  // Reassemble the same breadth-first worklist on every pass, including cached outputs. This
  // preserves discovery order and the first occurrence of each provider-specialized identity.
  const represented = new Set(executions.map((execution) => executionIdentity(execution.key)))
  const visitedProvided = new Set<string>()
  for (let ordinal = 0; ordinal < pendingProvided.length; ordinal += 1) {
    const runner = pendingProvided.at(ordinal)
    if (runner?.execution._tag !== 'ProvidedEffectRunnerExecution') continue
    const key = runner.execution
    if (visitedProvided.has(key.identity)) continue
    visitedProvided.add(key.identity)
    if (represented.has(key.identity)) continue
    const owner = state.lookup.instances.get(Instances.keyText(key.owner))
    if (owner === undefined) continue
    let cached = state.providedBuilds.get(key.identity)
    if (
      cached === undefined ||
      cached.runner.execution !== key ||
      cached.runner.classification !== runner.classification ||
      !canReuseBuild(cached.fragment, classifications)
    ) {
      cached = {
        runner,
        fragment: buildProvidedRunner(
          runner,
          buildContext(state, owner, classifications, key.providers),
        ),
      }
      state.providedBuilds.set(key.identity, cached)
    }
    const fragment = cached.fragment
    for (const execution of fragment.executions) represented.add(executionIdentity(execution.key))
    executions.push(...fragment.executions)
    pendingProvided.push(...fragment.providedRunners)
  }
  return {
    _tag: 'ProvisionalMirModule',
    module: state.discovery.rootModule,
    executions: executions,
  }
}

const classificationsOf = (self: Module): ReadonlyMap<string, Classification> => {
  const candidates = new Map<string, Array<Classification>>()
  const record = (identity: string, classification: Classification): void => {
    const current = candidates.get(identity) ?? []
    current.push(classification)
    candidates.set(identity, current)
  }
  for (const execution of self.executions) {
    if (execution.key._tag !== 'InstanceExecution')
      record(execution.key.identity, execution.classification)
    for (const region of execution.regions)
      if (region.outcome._tag === 'RunSuspendableEffect')
        record(region.outcome.runner.execution.identity, region.outcome.runner.classification)
  }
  return new Map(
    [...candidates].map(([identity, classifications]) => [
      identity,
      mergeClassifications(classifications),
    ]),
  )
}
const sameClassifications = (
  left: ReadonlyMap<string, Classification>,
  right: ReadonlyMap<string, Classification>,
): boolean =>
  left.size === right.size &&
  [...left].every(([identity, classification]) => right.get(identity) === classification)

const joinClassifications = (
  current: ReadonlyMap<string, Classification>,
  observed: ReadonlyMap<string, Classification>,
): ReadonlyMap<string, Classification> => {
  const joined = new Map(current)
  for (const [identity, classification] of observed) {
    const previous = joined.get(identity)
    joined.set(
      identity,
      previous === undefined ? classification : mergeClassifications([previous, classification]),
    )
  }
  return joined
}

/** Builds deterministic provisional control without producing executable final MIR. */
export const build = (
  discovery: Instances.Discovery,
  layout: Layout.Plan,
  index: DeclarationIndex.Index,
): Module => {
  const state: BuildState = {
    discovery,
    layout,
    index,
    lookup: buildLookup(discovery, layout),
    instanceBuilds: new Map(),
    providedBuilds: new Map(),
  }
  let classifications: ReadonlyMap<string, Classification> = new Map()
  let result = buildPass(state, classifications)
  const transitions = new Map<string, number>()
  // Each pass exhausts its finite provider-specialization worklist. Across passes, newly observed
  // identities come only from the finite specialized TIR/provider facts, while the joined safety
  // classification for each actual identity is monotone:
  // absent -> synchronous -> unknown -> suspendable.
  for (;;) {
    const next = joinClassifications(classifications, classificationsOf(result))
    if (sameClassifications(classifications, next)) return result
    for (const [identity, classification] of next) {
      if (classifications.get(identity) === classification) continue
      const count = (transitions.get(identity) ?? 0) + 1
      if (count > 3)
        throw new RangeError(`Provisional MIR classification exceeded its lattice for ${identity}`)
      transitions.set(identity, count)
    }
    classifications = next
    result = buildPass(state, classifications)
  }
}

/** Returns the exact provisional execution classification for one lowered MIR function. */
export const classificationOfExecution = (
  self: Module,
  instance: Instances.InstanceKey,
): Classification =>
  executionForInstance(self, instance)?.classification ??
  providedClassification(self, instance) ??
  'Unknown'

/**
 * Returns the selected runner classification at one source run. The lookup is deliberately scoped
 * by the exact monomorphic execution before comparing spans, so generic specializations and hidden
 * Effect runners at the same source site cannot share a normalization decision.
 */
export const classificationOfRun = (
  self: Module,
  instance: Instances.InstanceKey,
  span: SourceSpan.SourceSpan,
): Classification => {
  const execution = executionForInstance(self, instance)
  const control = execution?.regions.find(
    (region) =>
      region.outcome._tag === 'RunSuspendableEffect' && sameSpan(region.outcome.span, span),
  )
  let selected: Classification
  if (control?.outcome._tag === 'RunSuspendableEffect') {
    selected = control.outcome.runner.classification
  } else if (execution === undefined) {
    selected = 'Unknown'
  } else if (
    execution.classification === 'Synchronous' &&
    providedClassification(self, instance) === 'Suspendable'
  ) {
    selected = 'Suspendable'
  } else {
    // Control construction records every unknown or suspendable run in this execution.
    // An unknown sibling can widen the execution summary without changing this run.
    selected = 'Synchronous'
  }
  return selected
}

/** Explicit transfer origins cannot be normalized into synchronous direct calls. */
export const isOriginOfRun = (
  self: Module,
  instance: Instances.InstanceKey,
  span: SourceSpan.SourceSpan,
): boolean =>
  executionForInstance(self, instance)?.regions.some(
    (region) => region.outcome._tag === 'SuspendEffect' && sameSpan(region.outcome.span, span),
  ) ?? false

export interface RunControl {
  readonly id: ControlId
  readonly outcome: Extract<Outcome, { readonly _tag: 'RunSuspendableEffect' }>
}

/** Returns the exact provisional complete-or-relay control associated with one lowered source run. */
export const controlOfRun = (
  self: Module,
  instance: Instances.InstanceKey,
  span: SourceSpan.SourceSpan,
): RunControl | undefined => {
  const execution = executionForInstance(self, instance)
  const region = execution?.regions.find(
    (candidate) =>
      candidate.outcome._tag === 'RunSuspendableEffect' && sameSpan(candidate.outcome.span, span),
  )
  return region?.outcome._tag === 'RunSuspendableEffect'
    ? { id: region.id, outcome: region.outcome }
    : undefined
}

/** Returns the classification of an exact generated runner identity, if provisional facts name it. */
export const classificationOfRunner = (
  self: Module,
  runner: DeclarationFacts.CanonicalId,
  typeArguments: ReadonlyArray<Type.GenericArgument>,
): Classification => {
  const argumentKey = typeArguments.map(Type.genericArgumentKey).join('\u0000')
  const candidates = self.executions.flatMap((execution) => {
    if (
      execution.key._tag !== 'InstanceExecution' &&
      sameDeclaration(execution.key.runner, runner) &&
      execution.key.owner.typeArguments.map(Type.genericArgumentKey).join('\u0000') === argumentKey
    )
      return [execution.classification]
    return execution.regions.flatMap((region) => {
      const outcome = region.outcome
      return outcome._tag === 'RunSuspendableEffect' &&
        outcome.runner.declaration !== undefined &&
        sameDeclaration(outcome.runner.declaration, runner) &&
        outcome.runner.typeArguments.map(Type.genericArgumentKey).join('\u0000') === argumentKey
        ? [outcome.runner.classification]
        : []
    })
  })
  return mergeClassifications(candidates)
}

const controlIdText = (id: ControlId): string =>
  `${id.execution}@${id.sourceId}:${id.functionOrdinal}:${id.spanStart}:${id.spanEnd}#${id.ordinal}.${id.port}`

/** Deterministic inspection encoding with no compatibility promise. */
export const encode = (self: Module): string =>
  [
    `provisional-mir ${self.module}`,
    ...self.executions.flatMap((execution) => [
      `execution ${executionIdentity(execution.key)} ${execution.classification.toLowerCase()}`,
      ...execution.regions.map((region) => {
        const outcome = region.outcome
        if (outcome._tag === 'SuspendEffect')
          return `  ${controlIdText(region.id)} suspend child=${outcome.deferred.effectIdentity ?? 'unknown'} transfer=unpublished`
        if (outcome._tag === 'RunSuspendableEffect')
          return `  ${controlIdText(region.id)} run runner=${outcome.runner.effectIdentity ?? 'unknown'} completion=${outcome.completion._tag.toLowerCase()} complete=${controlIdText(outcome.complete)} relay=existing(${outcome.relay.preserves.join(',')})`
        return `  ${controlIdText(region.id)} complete policy=${outcome.policy._tag.toLowerCase()}`
      }),
    ]),
    '',
  ].join('\n')

export interface Violation {
  readonly _tag: 'ProvisionalMirViolation'
  readonly execution: string
  readonly detail: string
}

/** Verifies the provisional graph without making it consumable by final-MIR backends. */
export const verify = (self: Module): ReadonlyArray<Violation> => {
  const violations: Array<Violation> = []
  for (const execution of self.executions) {
    const identity = executionIdentity(execution.key)
    const regions = new Map<string, Region>()
    for (const region of execution.regions) {
      const key = controlIdText(region.id)
      if (regions.has(key)) {
        violations.push({
          _tag: 'ProvisionalMirViolation',
          execution: identity,
          detail: `duplicate provisional region ${key}`,
        })
      }
      regions.set(key, region)
    }
    for (const region of execution.regions) {
      const outcome = region.outcome
      if (outcome._tag !== 'RunSuspendableEffect') continue
      const target = regions.get(controlIdText(outcome.complete))
      if (target?.outcome._tag !== 'Complete') {
        violations.push({
          _tag: 'ProvisionalMirViolation',
          execution: identity,
          detail: `suspendable run ${controlIdText(region.id)} has a dangling Complete target`,
        })
      } else if (target.outcome.policy._tag !== outcome.completion._tag) {
        violations.push({
          _tag: 'ProvisionalMirViolation',
          execution: identity,
          detail: `suspendable run ${controlIdText(region.id)} changes its Complete policy`,
        })
      }
      if (outcome.runner.classification === 'Synchronous') {
        violations.push({
          _tag: 'ProvisionalMirViolation',
          execution: identity,
          detail: `synchronous runner appears in suspendable control ${controlIdText(region.id)}`,
        })
      }
    }
  }
  return violations
}
