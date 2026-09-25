import * as CompilerTrace from './CompilerTrace.js'
import * as AncestorHistory from './AncestorHistory.js'
import type * as ArtifactComposition from './ArtifactComposition.js'
import * as ConfigurationError from './ConfigurationError.js'
import * as ConfigurationOrigin from './ConfigurationOrigin.js'
import type * as ProfileBootstrap from './ProfileBootstrap.js'
import * as CAbi from './CAbi.js'
import * as CleanupPlan from './CleanupPlan.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as Constraint from './Constraint.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as Elaboration from './Elaboration.js'
import * as BodyView from './BodyView.js'
import * as Location from './Location.js'
import * as Provenance from './Provenance.js'
import type * as LifetimeFlow from './LifetimeFlow.js'
import * as ExecutableOrigin from './ExecutableOrigin.js'
import * as Tir from './Tir.js'
import * as FunctionIndex from './internal/FunctionIndex.js'
import * as Graph from './internal/Graph.js'
import type * as Intrinsic from './Intrinsic.js'
import * as TypeInference from './internal/TypeInference.js'
import type * as NameResolution from './NameResolution.js'
import * as Ownership from './Ownership.js'
import * as ProviderSelection from './ProviderSelection.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as Residualization from './Residualization.js'
import type * as TestDiscovery from './TestDiscovery.js'
import * as SemanticContext from './SemanticContext.js'
import * as ResidualOwnership from './ResidualOwnership.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as SourceSpan from './SourceSpan.js'
import * as Specialization from './Specialization.js'
import * as Evaluation from './Evaluation.js'
import * as StaticValue from './StaticValue.js'
import * as SuspensionMode from './SuspensionMode.js'
import type * as Target from './Target.js'
import * as Type from './Type.js'
import type * as TypeCompatibility from './TypeCompatibility.js'

/**
 * Instance discovery: which concrete runtime instances are reachable from artifact roots. Keys
 * are canonical declaration identities plus normalized type and contract-row arguments — both
 * empty in the frozen slice. The worklist records an instance before following it, so ordinary
 * recursion terminates.
 */

/** One normalized concrete instance key. */
export interface InstanceKey {
  readonly _tag: 'InstanceKey'
  readonly declaration: DeclarationFacts.CanonicalId
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly contractRow: ReadonlyArray<string>
  /** Canonical selected-evidence encodings in declaration order. */
  readonly evidence: ReadonlyArray<string>
  readonly staticArguments: ReadonlyArray<StaticValue.Value>
}

/** One discovered instance with its elaborated TIR function. */
export interface Instance {
  readonly _tag: 'Instance'
  readonly key: InstanceKey
  readonly function: Tir.TirFunction
  readonly view: BodyView.BodyView
  readonly substitution: Type.Substitution
  readonly specialization: ConcreteSpecialization
  readonly ownership: Ownership.FunctionOwnership
  readonly resultCallable?: Type.CallableIdentityArgument
  readonly resultEffect?: string
  /** Exact residual application whose compile-time dependency attribution produced this body. */
  readonly residualApplication: string
  readonly effectSuccesses?: ReadonlyArray<{
    readonly site: Tir.EffectSiteId
    readonly identity: string
  }>
}

const concreteSpecializationBrand: unique symbol = Symbol('ConcreteSpecialization')

export type ConcreteEvidence = Exclude<Constraint.ConstraintEvidence, { readonly _tag: 'Assumed' }>

/**
 * The single post-generic frontier consumed by instance-dependent phases. Rows and evidence in
 * this bundle have already been substituted, validated, and reduced to finite concrete values.
 */
export interface ConcreteSpecialization {
  readonly _tag: 'ConcreteSpecialization'
  readonly [concreteSpecializationBrand]: true
  readonly compatibility?: TypeCompatibility.Context
  readonly parameters: ReadonlyArray<Type.Type>
  readonly result: Type.Type
  readonly failureRow?: Type.FailureRow
  readonly requirementRow?: Type.RequirementsRow
  readonly constraints: ReadonlyArray<Constraint.Constraint>
  readonly evidence: ReadonlyArray<ConcreteEvidence>
}

/** One concrete hidden callable-section construction reachable from an instance. */
export interface CallableInstance {
  readonly _tag: 'CallableInstance'
  readonly owner: InstanceKey
  readonly site: Tir.CallableSiteId
  readonly target: Tir.CallableTarget
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly substitution: Type.Substitution
  readonly captureTypes: ReadonlyArray<Type.Type>
  readonly captures: ReadonlyArray<{
    readonly ordinal: number
    readonly parameterOrdinal: number
    readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
    readonly type: Type.Type
    /** Hidden identity of a callable value captured as environment payload rather than data. */
    readonly callableIdentity?: Type.CallableIdentityArgument
  }>
  readonly type: Type.Callable
  readonly mode: Type.CallableMode
}

/** One specialized source Effect construction before any target layout is selected. */
export interface EffectInstance {
  readonly _tag: 'EffectInstance'
  readonly representationIdentity: string
  readonly identity: string
  readonly owner: InstanceKey
  readonly site: Tir.EffectSiteId
  readonly runner: DeclarationFacts.CanonicalId
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  readonly captures: ReadonlyArray<{
    readonly ordinal: number
    readonly source: 'Parameter' | 'Binding' | 'Pattern'
    readonly sourceOrdinal: number
    readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
    readonly type: Type.Type
    readonly effectIdentity?: string
    readonly callableIdentity?: Type.CallableIdentityArgument
    /** Exact selected demand represented by this provider capture, when it binds a requirement. */
    readonly providedRequirement?: {
      readonly capability: Type.Nominal
      readonly role: string
      readonly requirementAccess: Type.Requirement['access']
      readonly providerAccess: 'Shared' | 'Exclusive' | 'Take'
    }
  }>
  readonly type: Type.Effect
  readonly suspension: SuspensionMode.Summary
}

/** One deterministic semantic-inspection entry for an executable node. */
export interface SuspensionFact {
  readonly _tag: 'SuspensionFact'
  readonly subject:
    | { readonly _tag: 'Instance'; readonly key: InstanceKey }
    | { readonly _tag: 'Execution'; readonly key: InstanceKey }
    | { readonly _tag: 'Effect'; readonly identity: string }
  readonly summary: SuspensionMode.Summary
}

/** A lexical provider needed to select one concrete call at a shared source span. */
export interface CallProvider {
  readonly capability: Type.Nominal
  readonly providerType: Type.Nominal
  readonly role: string
}

/** One monomorphic ordinary/effect constructor call with hidden Effect identities resolved. */
export interface CallInstance {
  readonly _tag: 'CallInstance'
  readonly owner: InstanceKey
  /** Published TIR node that selected this target inside the owning instance. */
  readonly node?: Tir.NodeId
  readonly span: Tir.Expression['span']
  readonly target: InstanceKey
  /** Caller-authored metadata aligned with target static arguments, outside instance identity. */
  readonly staticArgumentOrigins?: ReadonlyArray<Evaluation.TextOrigin | undefined>
  readonly resultEffect?: string
  /** Lexical selections used to resolve the target or hidden argument identities at this call. */
  readonly providers?: ReadonlyArray<CallProvider>
}

/** One exact runtime reachability edge used to project a closure from an individual root. */
export interface ExecutionEdge {
  readonly _tag: 'ExecutionEdge'
  readonly kind: 'Runtime' | 'Cleanup' | 'Provider'
  readonly owner: InstanceKey
  readonly target: InstanceKey
  readonly providers?: ReadonlyArray<CallProvider>
}

/** Tests whether a call's provider-dependent identities belong to the current lexical context. */
export const callMatchesProviders = (
  call: CallInstance,
  providers: ReadonlyArray<CallProvider>,
): boolean =>
  (call.providers ?? []).every((expected) => {
    const actual = providers.findLast(
      (candidate) =>
        expected.role === candidate.role && Type.equals(expected.capability, candidate.capability),
    )
    return actual !== undefined && Type.equals(expected.providerType, actual.providerType)
  })

/** One exact sealed intrinsic call retained by executable instance closure. */
export interface IntrinsicCall {
  readonly _tag: 'ReachableIntrinsicCall'
  readonly operation: Intrinsic.OperationId
  readonly span: Tir.Expression['span']
}

/** One reachable foreign (`extern "C"`) declaration, classified for the selected target. */
export interface ForeignCall {
  readonly _tag: 'ReachableForeignCall'
  readonly symbol: string
  readonly signature: CAbi.CAbiSignature
  readonly declaration: DeclarationFacts.CanonicalId
  readonly declarationSpan: SourceSpan.SourceSpan
  /** The first reachable call in canonical order; availability diagnostics point here. */
  readonly callSpan: SourceSpan.SourceSpan
}

/** One `export "C"` function discovered as a native root, with the instance it selects. */
export interface ForeignExport {
  readonly _tag: 'ForeignExport'
  readonly symbol: string
  /** Exact source-level C function-pointer type, including pointer pointees. */
  readonly type: Type.ForeignFunction
  readonly signature: CAbi.CAbiSignature
  readonly key: InstanceKey
  readonly declaration: DeclarationFacts.CanonicalId
  readonly declarationSpan: SourceSpan.SourceSpan
}

/** One target-selected primitive constant value with no runtime storage. */
export interface SelectedConstant {
  readonly _tag: 'SelectedConstant'
  readonly declaration: DeclarationFacts.CanonicalId
  readonly value: StaticValue.Value
}

/** The deterministic discovery result. */
export interface Counters {
  readonly _tag: 'InstanceDiscoveryCounters'
  readonly residualBodies: Residualization.Counters
  readonly residualOwnership: ResidualOwnership.Counters
  /** Interned ancestor-history decision nodes the recursion guard built. */
  readonly ancestryNodes: number
}

/** The deterministic discovery result and work actually performed to obtain it. */
export interface Discovery {
  readonly retention: ReadonlyArray<InstanceKey>
  readonly _tag: 'InstanceDiscovery'
  readonly rootModule: string
  /** Completed declaration facts used to attribute execution-relevant constants and types. */
  readonly declarationIndex?: DeclarationIndex.Index
  /** Source and target-specialized anonymous aggregates required by reachable instances. */
  readonly generatedAggregates: ReadonlyMap<string, DeclarationFacts.StructFact>
  readonly instances: ReadonlyArray<Instance>
  /** Demanded residual specializations rejected before executable reachability. */
  readonly unavailableOwnership: ReadonlyArray<UnavailableResidualOwnership>
  readonly callables: ReadonlyArray<CallableInstance>
  readonly effects: ReadonlyArray<EffectInstance>
  readonly calls: ReadonlyArray<CallInstance>
  /** Complete concrete reachability, including cleanup and provider-selected implementations. */
  readonly executionEdges: ReadonlyArray<ExecutionEdge>
  readonly intrinsics: ReadonlyArray<IntrinsicCall>
  /** Reachable foreign declarations in canonical order; each execution surface admits them. */
  readonly foreignCalls: ReadonlyArray<ForeignCall>
  /** Every closure export in canonical module then declaration order; roots only on native. */
  readonly foreignExports: ReadonlyArray<ForeignExport>
  readonly constants: ReadonlyArray<SelectedConstant>
  /** Exact direct/nested/external-park summaries in canonical subject order. */
  readonly suspension: ReadonlyArray<SuspensionFact>
  /** Exact finalizer and service-operation implementations required to exclude external parking. */
  readonly nonParkingObligations: ReadonlyArray<{
    readonly span: SourceSpan.SourceSpan
    readonly summary: SuspensionMode.Summary
  }>
  /** Function bodies whose executed closure enters diagnostic observation. */
  readonly contextFreeTerminalObservations: ReadonlyArray<SourceSpan.SourceSpan>
  readonly observingExecutions: ReadonlyArray<InstanceKey>
  /** Target-relative diagnostics produced while selecting and residualizing static work. */
  readonly residualizationDiagnostics: ReadonlyArray<Diagnostic.Diagnostic>
  readonly specializationFailures: ReadonlyArray<NonConcreteSpecialization>
  readonly violations: ReadonlyArray<PolymorphicRecursion>
  readonly counters: Counters
  readonly residualBodies: ReadonlyArray<Residualization.Observation>
  readonly residualOwnership: ReadonlyArray<ResidualOwnership.Observation>
}

/** One specialization-keyed unavailable ownership result retained for semantic inspection. */
export interface UnavailableResidualOwnership {
  readonly _tag: 'UnavailableResidualOwnership'
  readonly key: InstanceKey
  readonly ownership: Ownership.FunctionOwnership
}

/** A recursive generic edge that changes an ancestor declaration's concrete arguments. */
export interface PolymorphicRecursion {
  readonly _tag: 'PolymorphicRecursion'
  readonly caller: InstanceKey
  readonly target: InstanceKey
}

export interface NonConcreteSpecialization {
  readonly _tag: 'NonConcreteSpecialization'
  readonly key: InstanceKey
  readonly span: SourceSpan.SourceSpan
}

const requirementBindingsCache = new WeakMap<
  Tir.TirFunction,
  ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>>
>()

export const requirementBindings = (
  fn: Tir.TirFunction,
): ReadonlyArray<Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>> => {
  const cached = requirementBindingsCache.get(fn)
  if (cached !== undefined) return cached
  // Discovery revisits one immutable residual body under different ancestor contexts. Its
  // binding sites are structural; witness selection still runs with each caller's inputs.
  const bindings = fn.statements.flatMap((statement) =>
    Tir.statementExpressions(statement).flatMap((expression) =>
      Tir.expressionTree(expression).flatMap((candidate) =>
        candidate._tag === 'EffectBindRequirement' ? [candidate] : [],
      ),
    ),
  )
  requirementBindingsCache.set(fn, bindings)
  return bindings
}

const selectedRequirement = (
  binding: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>,
  substitution: Type.Substitution,
): Type.Requirement | undefined => {
  return Tir.selectedRequirement(binding.provider, substitution)
}

const requirementBindingWitness = (
  binding: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>,
  substitution: Type.Substitution,
  index: DeclarationIndex.Index,
): DeclarationFacts.ConformanceWitness | undefined => {
  const capability = selectedRequirement(binding, substitution)?.capability
  const provider = Type.substitute(binding.provider.providerType, substitution)
  return capability !== undefined && Type.isNominal(capability) && Type.isNominal(provider)
    ? (binding.provider.witness ?? ConformanceProof.witness(index, provider, capability))
    : undefined
}

const forwardedRequirementBinding = (
  fn: Tir.TirFunction,
): Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }> | undefined => {
  const returned = fn.statements.at(-1)
  if (fn.statements.length !== 1 || returned?._tag !== 'Return') return undefined
  const block = returned.expression
  if (block._tag !== 'EffectBlock' || block.statements.length !== 2) return undefined
  const binding = block.statements.at(0)
  const completed = block.statements.at(1)
  if (
    binding?._tag !== 'Bind' ||
    binding.initializer._tag !== 'EffectBindRequirement' ||
    binding.initializer.protected._tag !== 'Move' ||
    binding.initializer.protected.subject._tag !== 'ParameterReference' ||
    binding.initializer.protected.subject.parameter.ordinal !== 0 ||
    binding.initializer.provider.parameter?.ordinal !== 1 ||
    completed?._tag !== 'Return' ||
    completed.expression._tag !== 'Run' ||
    completed.expression.subject._tag !== 'BindingReference' ||
    completed.expression.subject.binding.ordinal !== binding.binding.ordinal
  )
    return undefined
  return binding.initializer
}

/** Produces empty discovery when frontend errors prevent reachability analysis. */
export const invalid = (rootModule: string): Discovery => ({
  _tag: 'InstanceDiscovery',
  retention: [],
  rootModule,
  generatedAggregates: new Map(),
  instances: [],
  unavailableOwnership: [],
  callables: [],
  effects: [],
  calls: [],
  executionEdges: [],
  intrinsics: [],
  foreignCalls: [],
  foreignExports: [],
  constants: [],
  suspension: [],
  nonParkingObligations: [],
  contextFreeTerminalObservations: [],
  observingExecutions: [],
  residualizationDiagnostics: [],
  specializationFailures: [],
  violations: [],
  counters: {
    _tag: 'InstanceDiscoveryCounters',
    residualBodies: Residualization.noWork,
    residualOwnership: ResidualOwnership.counters(ResidualOwnership.make()),
    ancestryNodes: 0,
  },
  residualBodies: [],
  residualOwnership: [],
})

/**
 * Closes a partial section's binder-owned channels before the type becomes instance identity.
 *
 * A constrained partial section is deliberately open in its target contract's own unapplied
 * binders: its Effect channels close only at application, so its surface mentions binder-owned
 * success/failure types and requirement rows no carrying call can resolve.
 * Elaboration's constrained
 * callable escape gate proves such a value only ever reaches a whole-value relay, an application,
 * or a drop — every other escape is rejected there with its own diagnostic — and the callable
 * itself is erased onto its hidden identity argument. The instance identity therefore closes the
 * schema's unapplied value binders to `never` and requirement binders to empty rows, exactly
 * the shape the erased relay needs, so a proven relay is not re-rejected as unresolved.
 */
const carriedSectionArgument = (argument: Type.GenericArgument): Type.GenericArgument => {
  if (!Type.isTypeArgument(argument)) return argument
  if (!Type.isCallable(argument) || argument.schema === undefined) return argument
  if (Type.isRuntimeConcrete(argument)) return argument
  const closure = new Map<string, Type.GenericArgument>()
  for (const binder of argument.schema.binders) {
    const selected = argument.schema.substitution.get(Type.key(binder))
    if (
      selected !== undefined &&
      !Type.equalsGenericArgument(selected, Type.parameterArgument(binder))
    )
      continue
    if (binder.kind === 'RequirementRow')
      closure.set(Type.key(binder), Type.requirementRowArgument([]))
    else if (binder.kind === 'Value') closure.set(Type.key(binder), 'never')
  }
  if (closure.size === 0) return argument
  const closed = Type.substitute(argument, closure)
  return Type.isRuntimeConcrete(closed) ? closed : argument
}

// Discovery and every suspension-graph rebuild key the same target applications repeatedly. The
// contract row is a function of the contract, its declared parameters, and the exact visible
// arguments, so it is derived once per distinct application.
const contractRows = new WeakMap<Tir.ContractFact, Map<string, ReadonlyArray<string> | undefined>>()

const contractRowOf = (
  contract: Tir.ContractFact,
  typeParameters: ReadonlyArray<Type.Parameter>,
  visibleArguments: ReadonlyArray<Type.GenericArgument>,
): ReadonlyArray<string> | undefined => {
  let rows = contractRows.get(contract)
  if (rows === undefined) {
    rows = new Map()
    contractRows.set(contract, rows)
  }
  const application = `${typeParameters.map(Type.key).join('\u0001')}\u0002${visibleArguments
    .map(Type.genericArgumentKey)
    .join('\u0001')}`
  if (rows.has(application)) return rows.get(application)
  const selected = TypeInference.selectedSubstitution(typeParameters, visibleArguments)
  let row: ReadonlyArray<string> | undefined
  if (selected === undefined) row = undefined
  else if (contract._tag !== 'Contract') row = []
  else {
    const { substitution, compatibility } = selected
    row = [
      ...contract.parameters.map((type) =>
        Type.runtimeKey(Type.substitute(type, substitution, compatibility)),
      ),
      `result:${Type.runtimeKey(Type.substitute(contract.result, substitution))}`,
      ...(contract.failureRow === undefined
        ? []
        : [
            `failures:${Type.runtimeFailureRowKey(Type.substituteFailureRow(contract.failureRow, substitution))}`,
          ]),
      ...(contract.requirementRow === undefined
        ? []
        : [
            `requirements:${Type.runtimeRequirementsRowKey(Type.substituteRequirementsRow(contract.requirementRow, substitution))}`,
          ]),
      ...contract.constraints.map(
        (constraint) =>
          `constraint:${Type.runtimeConstraintKey(Constraint.substitute(constraint, substitution))}`,
      ),
    ]
  }
  rows.set(application, row)
  return row
}

const stagedApplications = new WeakMap<Tir.TirFunction, boolean>()

/** Whether a body contains a staged callable application, whose base resolves by context. */
const stagedApplication = (fn: Tir.TirFunction): boolean => {
  let staged = stagedApplications.get(fn)
  if (staged === undefined) {
    staged = fn.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .some((expression) => expression._tag === 'CallableApply' && expression.staged !== undefined)
    stagedApplications.set(fn, staged)
  }
  return staged
}

const keyOf = (
  declaration: DeclarationFacts.CanonicalId,
  contract: Tir.ContractFact,
  typeParameters: ReadonlyArray<Type.Parameter> = [],
  rawTypeArguments: ReadonlyArray<Type.GenericArgument> = [],
  staticArguments: ReadonlyArray<StaticValue.Value> = [],
  evidence: ReadonlyArray<string> = [],
): InstanceKey => {
  const typeArguments = rawTypeArguments.map(carriedSectionArgument)
  const contractRow = contractRowOf(
    contract,
    typeParameters,
    typeArguments.filter((argument) => !Type.isHiddenExecutableArgument(argument)),
  )
  if (contractRow === undefined)
    throw new RangeError('Instance key type arguments do not match declaration parameters')
  return {
    _tag: 'InstanceKey',
    declaration,
    typeArguments,
    evidence: [...evidence],
    staticArguments: [...staticArguments],
    contractRow,
  }
}

/** Memoized on the key object itself: most keys are fresh and read once or twice. */
const cachedKeyText: unique symbol = Symbol('Instances.keyText')

export const keyText = (key: InstanceKey): string => {
  const cached: unknown = Reflect.get(key, cachedKeyText)
  if (typeof cached === 'string') return cached
  const computed = `${key.declaration.module}\u0000${key.declaration.name}\u0000${Type.runtimeArgumentKeys(
    key.typeArguments,
  ).join('\u0000')}${key.evidence.length === 0 ? '' : `\u0004${key.evidence.join('\u0000')}`}${
    key.staticArguments.length === 0
      ? ''
      : `\u0001${key.staticArguments.map(StaticValue.key).join('\u0000')}`
  }\u0002${key.contractRow.join('\u0000')}`
  if (Object.isExtensible(key)) Object.defineProperty(key, cachedKeyText, { value: computed })
  return computed
}

const siteText = (owner: InstanceKey, span: SourceSpan.SourceSpan): string =>
  `${keyText(owner)}\u0005${span.sourceId}:${span.start}:${span.end}`

// Lowering resolves every call site against the whole program's call list; each list is indexed
// once, on first query, instead of rescanned per site. Discovery arrays are never mutated after
// publication, so the identity-keyed index cannot go stale.
const callSiteIndex = new WeakMap<
  ReadonlyArray<CallInstance>,
  ReadonlyMap<string, ReadonlyArray<CallInstance>>
>()

/** The calls `owner` recorded at `span`, in `calls` order. */
export const callsAtSite = (
  calls: ReadonlyArray<CallInstance>,
  owner: InstanceKey,
  span: SourceSpan.SourceSpan,
): ReadonlyArray<CallInstance> => {
  let index = callSiteIndex.get(calls)
  if (index === undefined) {
    const built = new Map<string, Array<CallInstance>>()
    for (const call of calls) {
      const text = siteText(call.owner, call.span)
      const group = built.get(text)
      if (group === undefined) built.set(text, [call])
      else group.push(call)
    }
    callSiteIndex.set(calls, built)
    index = built
  }
  return index.get(siteText(owner, span)) ?? []
}

interface InstanceIndex {
  readonly byKey: ReadonlyMap<string, Instance>
  readonly byDeclaration: ReadonlyMap<string, ReadonlyArray<Instance>>
}

const instanceIndexCache = new WeakMap<ReadonlyArray<Instance>, InstanceIndex>()

const instanceIndex = (instances: ReadonlyArray<Instance>): InstanceIndex => {
  const cached = instanceIndexCache.get(instances)
  if (cached !== undefined) return cached
  const byKey = new Map<string, Instance>()
  const byDeclaration = new Map<string, Array<Instance>>()
  for (const instance of instances) {
    const text = keyText(instance.key)
    if (!byKey.has(text)) byKey.set(text, instance)
    const declaration = `${instance.key.declaration.module}\u0000${instance.key.declaration.name}`
    const group = byDeclaration.get(declaration)
    if (group === undefined) byDeclaration.set(declaration, [instance])
    else group.push(instance)
  }
  const built = { byKey, byDeclaration }
  instanceIndexCache.set(instances, built)
  return built
}

/** The first instance in `instances` with `key`'s identity. */
export const instanceByKey = (
  instances: ReadonlyArray<Instance>,
  key: InstanceKey,
): Instance | undefined => instanceIndex(instances).byKey.get(keyText(key))

/** Every instance of one declaration, in `instances` order. */
export const instancesOf = (
  instances: ReadonlyArray<Instance>,
  declaration: { readonly module: string; readonly name: string },
): ReadonlyArray<Instance> =>
  instanceIndex(instances).byDeclaration.get(`${declaration.module}\u0000${declaration.name}`) ?? []

/** Identifies the machine body shared by proof contexts with one emitted contract. */
export const runtimeKeyText = (key: InstanceKey): string =>
  `${Specialization.runtimeKey({
    declaration: key.declaration,
    typeArguments: key.typeArguments,
    staticArguments: key.staticArguments,
  })}\u0002${key.contractRow.join('\u0000')}`

const concreteConstraintEvidence = (
  wanted: Constraint.Constraint,
  origin: SourceSpan.SourceSpan,
  index: DeclarationIndex.Index,
): ReadonlyArray<ConcreteEvidence> | undefined => {
  if (wanted._tag !== 'ProviderSelectionConstraint') {
    const proof = Constraint.proveStructural(wanted)
    return proof === undefined ? undefined : [proof]
  }
  const selected = RowAlgebra.concretize(Type.requirementRowPolicy(), wanted.selected)
  const source = RowAlgebra.concretize(Type.requirementRowPolicy(), wanted.source)
  if (
    !Type.isRuntimeConcrete(wanted.provider) ||
    selected._tag !== 'Concrete' ||
    source._tag !== 'Concrete' ||
    selected.row.members.some((requirement) => !Type.isRuntimeConcrete(requirement.capability)) ||
    source.row.members.some((requirement) => !Type.isRuntimeConcrete(requirement.capability))
  )
    return undefined
  const solved = ProviderSelection.solve({
    relations: [{ wanted, origins: [origin] } as ProviderSelection.Relation],
    selected: wanted.selected,
    responsible: origin,
    originKey: SourceSpan.key,
    oracle: {
      match: (provider: Type.Type, capability: Type.Nominal) =>
        ConformanceProof.providerMatch(index, provider, capability),
    },
  })
  return solved._tag === 'Selected' ? solved.evidence : undefined
}

const specializeEvidence = (
  evidence: Constraint.ConstraintEvidence,
  substitution: Type.Substitution,
  origin: SourceSpan.SourceSpan,
  index: DeclarationIndex.Index,
): ReadonlyArray<ConcreteEvidence> | undefined => {
  if (evidence._tag === 'Assumed') {
    const assumed = Constraint.substitute(evidence.wanted, evidence.substitution)
    return concreteConstraintEvidence(Constraint.substitute(assumed, substitution), origin, index)
  }
  if (evidence._tag === 'Member') {
    const selected = Type.substitute(evidence.selected, substitution)
    const source = Type.substituteFailureRow(evidence.source, substitution)
    return concreteConstraintEvidence(Constraint.nominalMember(selected, source), origin, index)
  }
  if (evidence._tag === 'FailureSubset') {
    const selected = Type.substituteFailureRow(evidence.selected, substitution)
    const source = Type.substituteFailureRow(evidence.source, substitution)
    const selectedConcrete = RowAlgebra.concretize(Type.failureRowPolicy(), selected)
    const sourceConcrete = RowAlgebra.concretize(Type.failureRowPolicy(), source)
    if (
      selectedConcrete._tag !== 'Concrete' ||
      sourceConcrete._tag !== 'Concrete' ||
      selectedConcrete.row.members.some((member) => !Type.isRuntimeConcrete(member)) ||
      sourceConcrete.row.members.some((member) => !Type.isRuntimeConcrete(member)) ||
      !RowAlgebra.isKnownSubset(Type.failureRowPolicy(), selected, source)
    )
      return undefined
    return [{ _tag: 'FailureSubset', selected, source } as ConcreteEvidence]
  }
  if (evidence._tag === 'RequirementSubset')
    return concreteConstraintEvidence(
      Constraint.requirementSubset(
        Type.substituteRequirementsRow(evidence.selected, substitution),
        Type.substituteRequirementsRow(evidence.source, substitution),
      ),
      origin,
      index,
    )
  return concreteConstraintEvidence(
    Constraint.substitute(evidence.wanted, substitution),
    origin,
    index,
  )
}

const tirEvidence = (
  view: BodyView.BodyView,
): ReadonlyArray<{
  readonly evidence: Constraint.ConstraintEvidence
  readonly origin: SourceSpan.SourceSpan
}> =>
  view.function.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .flatMap((expression) => {
      let evidence: ReadonlyArray<Constraint.ConstraintEvidence> = []
      if (expression._tag === 'EffectBindRequirement') {
        evidence = BodyView.selectedEvidence(view, expression.provider.evidence)?.constraints ?? []
      } else if (expression._tag === 'EffectCatch') {
        evidence = BodyView.selectedEvidence(view, expression.evidence)?.constraints ?? []
      }
      return evidence.map((proof) => ({ evidence: proof, origin: expression.span }))
    })

const tirSymbolicConformances = (
  fn: Tir.TirFunction,
): ReadonlyArray<ConformanceProof.SymbolicConformanceSelection> =>
  fn.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .flatMap((expression) =>
      expression._tag === 'Call' || expression._tag === 'EffectConstruct'
        ? expression.symbolicConformances
        : [],
    )

export const specialize = (
  view: BodyView.BodyView,
  substitution: Type.Substitution,
  index: DeclarationIndex.Index,
  registry: SemanticContext.Registry,
  compatibility?: TypeCompatibility.Context,
): ConcreteSpecialization | undefined => {
  const fn = view.function
  if (fn.contract._tag !== 'Contract') return undefined
  const parameters = fn.contract.parameters.map((parameter) =>
    Type.substitute(parameter, substitution, compatibility),
  )
  const result = Type.substitute(fn.contract.result, substitution, compatibility)
  if (
    parameters.some((parameter) => !Type.isRuntimeConcrete(parameter)) ||
    !Type.isRuntimeConcrete(result)
  )
    return undefined

  const failureRow =
    fn.contract.failureRow === undefined
      ? undefined
      : Type.substituteFailureRow(fn.contract.failureRow, substitution, compatibility)
  const requirementRow =
    fn.contract.requirementRow === undefined
      ? undefined
      : Type.substituteRequirementsRow(fn.contract.requirementRow, substitution, compatibility)
  if (
    (failureRow !== undefined &&
      (RowAlgebra.concretize(Type.failureRowPolicy(), failureRow)._tag !== 'Concrete' ||
        RowAlgebra.concreteMembers(Type.failureRowPolicy(), failureRow).some(
          (member) => !Type.isRuntimeConcrete(member),
        ))) ||
    (requirementRow !== undefined &&
      (RowAlgebra.concretize(Type.requirementRowPolicy(), requirementRow)._tag !== 'Concrete' ||
        RowAlgebra.concreteMembers(Type.requirementRowPolicy(), requirementRow).some(
          (requirement) => !Type.isRuntimeConcrete(requirement.capability),
        )))
  )
    return undefined

  const origin = registry.spanOf(fn.declaration.anchor)
  const constraints = fn.contract.constraints.map((constraint) =>
    Constraint.substitute(constraint, substitution),
  )
  const concreteEvidence: Array<ConcreteEvidence> = []
  for (const constraint of constraints) {
    const solved = concreteConstraintEvidence(constraint, origin, index)
    if (solved === undefined) return undefined
    concreteEvidence.push(...solved)
  }
  for (const occurrence of tirEvidence(view)) {
    const solved = specializeEvidence(occurrence.evidence, substitution, occurrence.origin, index)
    if (solved === undefined) return undefined
    concreteEvidence.push(...solved)
  }
  for (const symbolic of tirSymbolicConformances(fn)) {
    const provider = Type.substitute(symbolic.provider, substitution, compatibility)
    const capability = Type.substitute(symbolic.capability, substitution, compatibility)
    if (!Type.isRuntimeConcrete(provider) || !Type.isNominal(capability)) return undefined
    const proof = ConformanceProof.prove(index, provider, capability)
    if (
      proof._tag !== 'Proved' ||
      proof.selection._tag !== 'SourceSelection' ||
      proof.selection.module !== symbolic.selection.module ||
      proof.selection.ordinal !== symbolic.selection.ordinal
    )
      return undefined
  }
  const evidence = [
    ...new Map(concreteEvidence.map((proof) => [Constraint.evidenceKey(proof), proof])).values(),
  ].sort((left, right) => {
    const leftKey = Constraint.evidenceKey(left)
    const rightKey = Constraint.evidenceKey(right)
    if (leftKey < rightKey) return -1
    if (leftKey > rightKey) return 1
    return 0
  })
  return {
    _tag: 'ConcreteSpecialization',
    ...(compatibility === undefined ? {} : { compatibility }),
    [concreteSpecializationBrand]: true as const,
    parameters: parameters,
    result,
    ...(failureRow === undefined ? {} : { failureRow }),
    ...(requirementRow === undefined ? {} : { requirementRow }),
    constraints: constraints,
    evidence,
  }
}

/** Returns the exact branded provider proof attached to one specialized TIR binding. */
export const requirementSelection = (
  instance: Instance,
  provider: Extract<Tir.Expression, { readonly _tag: 'EffectBindRequirement' }>['provider'],
): Extract<ConcreteEvidence, { readonly _tag: 'RequirementSelection' }> | undefined => {
  const wantedKeys = new Set(
    (BodyView.selectedEvidence(instance.view, provider.evidence)?.constraints ?? []).flatMap(
      (proof) => {
        let wanted: Constraint.Constraint | undefined
        if (proof._tag === 'Assumed') {
          wanted = Constraint.substitute(
            Constraint.substitute(proof.wanted, proof.substitution),
            instance.substitution,
          )
        } else if (proof._tag === 'RequirementSelection') {
          wanted = Constraint.substitute(proof.wanted, instance.substitution)
        }
        return wanted?._tag === 'ProviderSelectionConstraint' ? [Constraint.key(wanted)] : []
      },
    ),
  )
  return instance.specialization.evidence.find(
    (proof): proof is Extract<ConcreteEvidence, { readonly _tag: 'RequirementSelection' }> =>
      proof._tag === 'RequirementSelection' && wantedKeys.has(proof.wantedKey),
  )
}

const specializationIndexCache = new WeakMap<
  ReadonlyArray<Instance>,
  ReadonlyMap<string, ReadonlyArray<Instance>>
>()

/** Returns every discovered instance with the exact declaration and kinded arguments. */
export const matchingSpecialization = (
  self: Discovery,
  specialization: Specialization.Specialization,
): ReadonlyArray<Instance> => {
  let index = specializationIndexCache.get(self.instances)
  if (index === undefined) {
    const groups = new Map<string, Array<Instance>>()
    for (const instance of self.instances) {
      const identity = Specialization.runtimeKey(instance.key)
      const group = groups.get(identity)
      if (group === undefined) groups.set(identity, [instance])
      else group.push(instance)
    }
    // Keep every match in discovery order: callers must still detect ambiguous targets.
    // Index by the immutable instance array so a new discovery frontier gets a fresh index.
    index = new Map([...groups].map(([identity, instances]) => [identity, instances]))
    specializationIndexCache.set(self.instances, index)
  }
  return index.get(Specialization.runtimeKey(specialization)) ?? []
}

export const effectIdentity = (owner: InstanceKey, site: Tir.EffectSiteId): string =>
  `${keyText(owner)}\u0004${Tir.executableSiteKey(site)}`

// TIR and instance keys are immutable. Hidden-parameter queries repeatedly reconstructed the
// same selected substitution; retain only its immutable map, not mutable proof bookkeeping.
const instanceSubstitutions = new WeakMap<
  Tir.TirFunction,
  WeakMap<InstanceKey, Type.Substitution | undefined>
>()
const instanceSubstitution = (
  fn: Tir.TirFunction,
  key: InstanceKey,
): Type.Substitution | undefined => {
  let cache = instanceSubstitutions.get(fn)
  if (cache?.has(key)) return cache.get(key)
  const substitution = TypeInference.selectedSubstitution(
    fn.declaration.typeParameters.map((parameter) => parameter.type),
    key.typeArguments.filter((argument) => !Type.isHiddenExecutableArgument(argument)),
  )?.substitution
  if (cache === undefined) {
    cache = new WeakMap()
    instanceSubstitutions.set(fn, cache)
  }
  cache.set(key, substitution)
  return substitution
}

interface ExecutableParameters {
  readonly effects: ReadonlyArray<number>
  readonly callables: ReadonlyArray<number>
}
// Effect and callable ordinals inspect the same specialized parameters. Computing both in one
// traversal avoids repeating type substitution, and later hidden-parameter queries reuse it.
const executableParameterCache = new WeakMap<
  Tir.TirFunction,
  WeakMap<Type.Substitution, ExecutableParameters>
>()
const executableParameters = (
  fn: Tir.TirFunction,
  substitution: Type.Substitution,
): ExecutableParameters => {
  let cache = executableParameterCache.get(fn)
  const cached = cache?.get(substitution)
  if (cached !== undefined) return cached
  const effects: Array<number> = []
  const callables: Array<number> = []
  if (fn.contract._tag === 'Contract') {
    for (const [ordinal, parameter] of fn.contract.parameters.entries()) {
      const specialized = Type.substitute(parameter, substitution)
      const contract = Type.isRepresented(specialized) ? specialized.contract : specialized
      if (Type.isEffect(contract)) effects.push(ordinal)
      if (Type.isCallable(specialized)) callables.push(ordinal)
    }
  }
  const result = { effects: effects, callables: callables }
  if (cache === undefined) {
    cache = new WeakMap()
    executableParameterCache.set(fn, cache)
  }
  cache.set(substitution, result)
  return result
}
const effectParameterOrdinals = (
  fn: Tir.TirFunction,
  substitution: Type.Substitution,
): ReadonlyArray<number> => executableParameters(fn, substitution).effects

export const parameterEffectRepresentationArgument = (
  fn: Tir.TirFunction,
  key: InstanceKey,
  ordinal: number,
): Type.EffectIdentityArgument | Type.CompositeEffectRepresentationArgument | undefined => {
  const substitution = instanceSubstitution(fn, key)
  if (substitution === undefined) return undefined
  const position = effectParameterOrdinals(fn, substitution).indexOf(ordinal)
  if (position < 0) return undefined
  return key.typeArguments
    .filter(
      (
        argument,
      ): argument is Type.EffectIdentityArgument | Type.CompositeEffectRepresentationArgument =>
        Type.isEffectIdentityArgument(argument) ||
        Type.isCompositeEffectRepresentationArgument(argument),
    )
    .at(position)
}

export const parameterEffectIdentityArgument = (
  fn: Tir.TirFunction,
  key: InstanceKey,
  ordinal: number,
): Type.EffectIdentityArgument | undefined => {
  const argument = parameterEffectRepresentationArgument(fn, key, ordinal)
  return argument !== undefined && Type.isEffectIdentityArgument(argument) ? argument : undefined
}

export const parameterEffectIdentity = (
  fn: Tir.TirFunction,
  key: InstanceKey,
  ordinal: number,
): string | undefined => parameterEffectIdentityArgument(fn, key, ordinal)?.identity

/** Replaces an owner-scoped represented Effect parameter with its concrete hidden identity. */
export const concreteEffectRepresentationArgument = (
  fn: Tir.TirFunction,
  key: InstanceKey,
  argument: Type.GenericArgument,
): Type.GenericArgument => {
  if (
    !Type.isExactRepresentationArgument(argument) ||
    !Type.isEffect(argument.contract) ||
    !Type.isEffectIdentityArgument(argument.identity) ||
    fn.contract._tag !== 'Contract'
  )
    return argument
  const identities = fn.contract.parameters.flatMap((parameter, ordinal) => {
    const substitution = instanceSubstitution(fn, key)
    if (substitution === undefined) return []
    const specialized = Type.substitute(parameter, substitution)
    if (
      !Type.isRepresented(specialized) ||
      !Type.isEffect(specialized.contract) ||
      !Type.isExactRepresentationArgument(specialized.representation.argument) ||
      !Type.equalsGenericArgument(specialized.representation.argument, argument)
    )
      return []
    const identity = parameterEffectIdentityArgument(fn, key, ordinal)
    return identity === undefined ? [] : [identity]
  })
  const identity = identities.length === 1 ? identities.at(0) : undefined
  return identity === undefined
    ? argument
    : Type.exactRepresentationArgument(identity, argument.contract)
}

const callableParameterOrdinals = (
  fn: Tir.TirFunction,
  substitution: Type.Substitution,
): ReadonlyArray<number> => executableParameters(fn, substitution).callables

export const parameterCallableIdentity = (
  fn: Tir.TirFunction,
  key: InstanceKey,
  ordinal: number,
): Type.CallableIdentityArgument | undefined => {
  const substitution = instanceSubstitution(fn, key)
  if (substitution === undefined) return undefined
  const position = callableParameterOrdinals(fn, substitution).indexOf(ordinal)
  if (position < 0) return undefined
  return key.typeArguments.filter(Type.isCallableIdentityArgument).at(position)
}

export const callableIdentity = (self: CallableInstance): string =>
  `${keyText(self.owner)}\u0001${Tir.executableSiteKey(self.site)}\u0001${Type.runtimeArgumentKeys(self.typeArguments).join('\u0000')}`

/** Returns the canonical specialized identity of one discovered callable environment. */
export const callableEnvironmentIdentity = (
  self: CallableInstance,
): Type.CallableEnvironmentIdentity =>
  Tir.callableEnvironmentIdentity(self.site, {
    declaration: {
      module: self.owner.declaration.module,
      name: self.owner.declaration.name,
    },
    typeArguments: self.owner.typeArguments,
    staticArgumentKeys: self.owner.staticArguments.map(StaticValue.key),
  })

const {
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
} = ExecutableOrigin.make({
  specializeInstanceType: (type, owner, substitutions) =>
    Specialization.specializeType(owner, type, substitutions),
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
  callableIdentity,
  callableEnvironmentIdentity,
})

type CallTarget = ExecutableOrigin.CallTarget

const compareInstanceKeys = (left: InstanceKey, right: InstanceKey): number => {
  const leftText = keyText(left)
  const rightText = keyText(right)
  if (leftText < rightText) return -1
  if (leftText > rightText) return 1
  return 0
}

export type ExecutionGap =
  | { readonly _tag: 'MissingRoot'; readonly root: InstanceKey }
  | { readonly _tag: 'MissingTarget'; readonly edge: ExecutionEdge }
  | { readonly _tag: 'MissingResidualAttribution'; readonly instance: InstanceKey }
  | { readonly _tag: 'IncompleteResidualAttribution'; readonly instance: InstanceKey }

/** Complete concrete work reachable from one exact runtime root. */
export interface ExecutionClosure {
  readonly _tag: 'ExecutionClosure'
  readonly root: InstanceKey
  readonly instances: ReadonlyArray<Instance>
  readonly edges: ReadonlyArray<ExecutionEdge>
  readonly callables: ReadonlyArray<CallableInstance>
  readonly effects: ReadonlyArray<EffectInstance>
  readonly intrinsics: ReadonlyArray<IntrinsicCall>
  readonly foreignCalls: ReadonlyArray<ForeignCall>
  readonly residualBodies: ReadonlyArray<Residualization.Observation>
  readonly gaps: ReadonlyArray<ExecutionGap>
}

/** Projects the complete execution graph rooted at one discovered specialization. */
interface ClosureIndex {
  readonly instances: ReadonlyMap<string, Instance>
  readonly byOwner: ReadonlyMap<string, ReadonlyArray<ExecutionEdge>>
  readonly residuals: ReadonlyMap<string, Residualization.Observation>
}

// Test identity computes one closure per test over the same discovery; index it once.
const closureIndices = new WeakMap<Discovery, ClosureIndex>()

const closureIndex = (self: Discovery): ClosureIndex => {
  let index = closureIndices.get(self)
  if (index === undefined) {
    const byOwner = new Map<string, Array<ExecutionEdge>>()
    for (const edge of self.executionEdges) {
      const key = keyText(edge.owner)
      const owned = byOwner.get(key)
      if (owned === undefined) byOwner.set(key, [edge])
      else owned.push(edge)
    }
    index = {
      instances: new Map(self.instances.map((instance) => [keyText(instance.key), instance])),
      byOwner,
      residuals: new Map(self.residualBodies.map((body) => [body.application, body])),
    }
    closureIndices.set(self, index)
  }
  return index
}

const expressionSpanKeys = new WeakMap<Instance, ReadonlyArray<string>>()

const instanceExpressionSpanKeys = (instance: Instance): ReadonlyArray<string> => {
  let keys = expressionSpanKeys.get(instance)
  if (keys === undefined) {
    keys = instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .map((expression) => SourceSpan.key(expression.span))
    expressionSpanKeys.set(instance, keys)
  }
  return keys
}

export const executionClosure = (
  self: Discovery,
  root: InstanceKey,
  excludedDeclarations: ReadonlySet<string> = new Set(),
): ExecutionClosure => {
  const { instances, byOwner, residuals } = closureIndex(self)
  const selected = new Map<string, Instance>()
  const selectedEdges = new Map<string, ExecutionEdge>()
  const gaps: Array<ExecutionGap> = []
  const pending = [root]
  while (pending.length > 0) {
    const key = pending.shift()
    if (key === undefined) continue
    const encoded = keyText(key)
    if (selected.has(encoded)) continue
    const instance = instances.get(encoded)
    if (instance === undefined) {
      if (encoded === keyText(root)) gaps.push({ _tag: 'MissingRoot', root })
      continue
    }
    selected.set(encoded, instance)
    for (const edge of byOwner.get(encoded) ?? []) {
      const targetDeclaration = `${edge.target.declaration.module}\u0000${edge.target.declaration.name}`
      if (excludedDeclarations.has(targetDeclaration)) continue
      const target = keyText(edge.target)
      selectedEdges.set(`${encoded}\u0005${edge.kind}\u0005${target}`, edge)
      if (!instances.has(target)) gaps.push({ _tag: 'MissingTarget', edge })
      else if (!selected.has(target)) pending.push(edge.target)
    }
  }
  const orderedInstances = [...selected.values()].sort((left, right) =>
    compareInstanceKeys(left.key, right.key),
  )
  const residualBodies: Array<Residualization.Observation> = []
  for (const instance of orderedInstances) {
    const residual = residuals.get(instance.residualApplication)
    if (residual === undefined) {
      gaps.push({ _tag: 'MissingResidualAttribution', instance: instance.key })
      continue
    }
    residualBodies.push(residual)
    if (!residual.complete)
      gaps.push({ _tag: 'IncompleteResidualAttribution', instance: instance.key })
  }
  const owners = new Set(orderedInstances.map((instance) => keyText(instance.key)))
  const spans = new Set(orderedInstances.flatMap(instanceExpressionSpanKeys))
  return {
    _tag: 'ExecutionClosure',
    root,
    instances: orderedInstances,
    edges: [...selectedEdges.values()].sort((left, right) => {
      const owner = compareInstanceKeys(left.owner, right.owner)
      if (owner !== 0) return owner
      const target = compareInstanceKeys(left.target, right.target)
      return target !== 0 ? target : left.kind.localeCompare(right.kind)
    }),
    callables: self.callables
      .filter((callable) => owners.has(keyText(callable.owner)))
      .sort((left, right) => callableIdentity(left).localeCompare(callableIdentity(right))),
    effects: self.effects
      .filter((effect) => owners.has(keyText(effect.owner)))
      .sort((left, right) => left.identity.localeCompare(right.identity)),
    intrinsics: self.intrinsics.filter((call) => spans.has(SourceSpan.key(call.span))),
    foreignCalls: self.foreignCalls.filter((call) => spans.has(SourceSpan.key(call.callSpan))),
    residualBodies,
    gaps,
  }
}

type SuspensionIndex = ReadonlyMap<
  SuspensionFact['subject']['_tag'],
  ReadonlyMap<string, SuspensionMode.Summary>
>

const suspensionIndexCache = new WeakMap<ReadonlyArray<SuspensionFact>, SuspensionIndex>()

// Provisional MIR queries these facts for each execution on every convergence pass. Index the
// immutable fact array once, keeping subject kinds separate and preserving first-match semantics.
const suspensionIndex = (facts: ReadonlyArray<SuspensionFact>): SuspensionIndex => {
  const cached = suspensionIndexCache.get(facts)
  if (cached !== undefined) return cached
  const groups = new Map<SuspensionFact['subject']['_tag'], Map<string, SuspensionMode.Summary>>()
  for (const fact of facts) {
    const subject = fact.subject
    const identity = subject._tag === 'Effect' ? subject.identity : keyText(subject.key)
    let group = groups.get(subject._tag)
    if (group === undefined) {
      group = new Map()
      groups.set(subject._tag, group)
    }
    if (!group.has(identity)) group.set(identity, fact.summary)
  }
  suspensionIndexCache.set(facts, groups)
  return groups
}

/** Returns the complete summary of a function plus any lazy Effect it returns. */
export const suspensionOf = (self: Discovery, key: InstanceKey): SuspensionMode.Summary =>
  suspensionIndex(self.suspension).get('Instance')?.get(keyText(key)) ?? SuspensionMode.direct

/** Returns the summary of executing one function body, excluding its lazy result. */
export const executionSuspensionOf = (self: Discovery, key: InstanceKey): SuspensionMode.Summary =>
  suspensionIndex(self.suspension).get('Execution')?.get(keyText(key)) ?? SuspensionMode.direct

/** Returns the summary of one exact hidden Effect runner. */
export const effectSuspensionOf = (self: Discovery, identity: string): SuspensionMode.Summary =>
  suspensionIndex(self.suspension).get('Effect')?.get(identity) ?? SuspensionMode.direct

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
      return expected !== undefined && Type.equalsGenericArgument(argument, expected)
    })
  )
}

const sameExactOwner = (left: InstanceKey, right: Type.ExecutableSpecializationOwner): boolean =>
  left.declaration.module === right.declaration.module &&
  left.declaration.name === right.declaration.name &&
  left.typeArguments.length === right.typeArguments.length &&
  left.typeArguments.every((argument, ordinal) => {
    const expected = right.typeArguments.at(ordinal)
    return expected !== undefined && Type.equalsGenericArgument(argument, expected)
  }) &&
  left.staticArguments.length === right.staticArgumentKeys.length &&
  left.staticArguments.every(
    (argument, ordinal) => StaticValue.key(argument) === right.staticArgumentKeys.at(ordinal),
  )

/** Resolves an owner-scoped source representation identity to its concrete hidden Effect. */
export const representedEffectOf = (
  self: Discovery,
  identity: Type.EffectIdentityArgument,
): EffectInstance | undefined => {
  const concrete = self.effects.filter((effect) => effect.identity === identity.identity)
  if (concrete.length === 1) return concrete.at(0)
  const represented = self.effects.filter(
    (effect) => effect.representationIdentity === identity.identity,
  )
  const owner = identity.owner
  if (owner === undefined) return represented.length === 1 ? represented.at(0) : undefined
  const exact = represented.filter((effect) => sameExactOwner(effect.owner, owner))
  if (exact.length === 1) return exact.at(0)
  const visible = represented.filter(
    (effect) =>
      effect.owner.declaration.module === owner.declaration.module &&
      effect.owner.declaration.name === owner.declaration.name &&
      sameVisibleTypeArguments(effect.owner.typeArguments, owner.typeArguments) &&
      effect.owner.staticArguments.length === owner.staticArgumentKeys.length &&
      effect.owner.staticArguments.every(
        (argument, ordinal) => StaticValue.key(argument) === owner.staticArgumentKeys.at(ordinal),
      ),
  )
  return visible.length === 1 ? visible.at(0) : undefined
}

/** Resolves the suspension summary of one owner-scoped represented Effect. */
export const representedEffectSuspensionOf = (
  self: Discovery,
  identity: Type.EffectIdentityArgument,
): SuspensionMode.Summary => {
  const selected = representedEffectOf(self, identity)
  return selected?.suspension ?? effectSuspensionOf(self, identity.identity)
}

/**
 * Every admitted `export "C"` header in the loaded closure as a monomorphic root record, in
 * canonical module then declaration order. A rejected header (unresolved result) is skipped.
 */
const exportRoots = (
  index: DeclarationIndex.Index,
  target: Target.Target,
  registry: SemanticContext.Registry,
): ReadonlyArray<ForeignExport> =>
  [...index.modules]
    .sort((left, right) => {
      if (left.module < right.module) return -1
      if (left.module > right.module) return 1
      return 0
    })
    .flatMap((module) =>
      module.declarations.flatMap((fact): ReadonlyArray<ForeignExport> => {
        if (
          fact.foreignExport === undefined ||
          fact.canonical._tag !== 'Canonical' ||
          fact.name._tag !== 'Present' ||
          fact.returnType._tag !== 'Resolved'
        )
          return []
        const parameters = fact.parameters.flatMap((parameter) =>
          parameter.declaredType._tag === 'Resolved' ? [parameter.declaredType.type] : [],
        )
        if (parameters.length !== fact.parameters.length) return []
        return [
          {
            _tag: 'ForeignExport',
            symbol: fact.foreignExport.symbol,
            type: Type.foreignFunction(
              parameters,
              fact.returnType.type,
              fact.foreignExport.contract,
              DeclarationFacts.executableLifetimes(fact),
            ),
            signature: ExecutableOrigin.foreignSignature(fact, target),
            key: keyOf(
              fact.canonical.id,
              Tir.contractOf(fact),
              fact.typeParameters.map((parameter) => parameter.type),
              fact.typeParameters.map((parameter) => Type.parameterArgument(parameter.type)),
            ),
            declaration: fact.canonical.id,
            declarationSpan: registry.spanOf(fact.name.anchor),
          },
        ]
      }),
    )

/**
 * Discovers the reachable instances from the artifact's foreign exports and explicit retention roots. The worklist records an
 * instance before following its calls, so directly and mutually recursive programs terminate.
 */
export const discover = (
  rootModule: string,
  results: ReadonlyMap<string, Elaboration.Result>,
  index: DeclarationIndex.Index,
  registry: SemanticContext.Registry,
  completion: ProfileBootstrap.Completion,
  resolution: NameResolution.Resolution,
  composition: ArtifactComposition.Resolved,
  trace: CompilerTrace.CompilerTrace = CompilerTrace.none,
  testCatalog?: TestDiscovery.Catalog,
): Discovery => {
  const target = completion.profile.target
  const root = results.get(rootModule)
  if (root === undefined) {
    throw new RangeError(`Instance discovery lost its root module ${rootModule}`)
  }
  const foreignExports = exportRoots(index, target, registry)
  // The root module's own span: its context's first presented entry stands for the whole module.
  const rootContext = registry.contexts.get(rootModule)
  const rootSpan = registry.spanOf(
    rootContext === undefined
      ? { _tag: 'AuthoredAnchor', owner: AuthoredIdentity.module('', rootModule), path: [] }
      : { _tag: 'AuthoredAnchor', owner: rootContext.module.owner, path: [] },
  )
  const retention: Array<InstanceKey> = []
  const rootDiagnostics: Array<Diagnostic.Diagnostic> = []
  for (const selector of composition.retention) {
    const module = results.get(selector.module)
    const lookup =
      module === undefined ? undefined : Elaboration.declarationByName(module, selector.declaration)
    const declaration = lookup?._tag === 'Resolved' ? lookup.declaration : undefined
    if (
      declaration === undefined ||
      declaration.canonical._tag !== 'Canonical' ||
      declaration.phase === 'Static' ||
      declaration.typeParameters.length > 0 ||
      declaration.foreign !== undefined ||
      declaration.returnType._tag !== 'Resolved' ||
      !declaration.failureRow.available ||
      !declaration.requirementRow.available
    ) {
      let related: ReadonlyArray<DeclarationFacts.DeclarationFact> =
        declaration === undefined ? [] : [declaration]
      if (lookup?._tag === 'Ambiguous') related = lookup.declarations
      const origins = [
        selector.origin,
        ...related.map((candidate) =>
          ConfigurationOrigin.snapshot({
            source: selector.module,
            provenance: 'literal',
            span: registry.spanOf(candidate.anchor),
          }),
        ),
      ]
      rootDiagnostics.push(
        Diagnostic.invalidConfiguration(
          ConfigurationError.make(
            'ArtifactComposition.retention',
            'InvalidInput',
            'retention root must name one monomorphic runtime definition',
            origins,
          ),
          selector.origin.span ??
            (related[0] === undefined ? undefined : registry.spanOf(related[0].anchor)) ??
            rootSpan,
        ),
      )
    } else retention.push(keyOf(declaration.canonical.id, Tir.contractOf(declaration)))
  }
  if (rootDiagnostics.length > 0)
    return {
      ...invalid(rootModule),
      foreignExports,
      residualizationDiagnostics: rootDiagnostics,
    }
  const residualization = Residualization.make(
    completion.profile,
    results,
    resolution,
    index,
    undefined,
    completion.values,
    trace,
    testCatalog,
  )
  const residualOwnership = ResidualOwnership.make()
  // Ownership reads spans and evaluation order from the module that authored the body it checks.
  const contextOf = (fn: Tir.TirFunction): SemanticContext.SemanticContext => {
    const context = registry.of(fn.declaration.anchor)
    if (context === undefined)
      throw new RangeError(
        `Instance discovery lost the authored module ${fn.declaration.anchor.owner.module}`,
      )
    return context
  }
  const accessBoundaryPlan = trace('Instances.planAccessBoundaries', () =>
    Ownership.localSharedAccessBoundaryPlan(results),
  )
  interface PreparedInstance {
    readonly instance: Omit<Instance, 'ownership'>
    /** The region proof the body published, which ownership replays. */
    readonly lifetimes?: LifetimeFlow.LifetimeFlow
  }
  interface PreparedUnavailableOwnership {
    readonly key: InstanceKey
    readonly artifact: Tir.ArtifactId
    readonly function: Tir.TirFunction
    readonly causes: Elaboration.BodyResults['causes']
    /** The region proof the body published, which ownership replays. */
    readonly lifetimes?: LifetimeFlow.LifetimeFlow
    readonly diagnostic: Diagnostic.Diagnostic
  }
  const prepared = new Map<string, PreparedInstance>()
  const preparedUnavailableOwnership = new Map<string, PreparedUnavailableOwnership>()
  const residualizationDiagnostics = new Map<string, Diagnostic.Diagnostic>()
  const selectedConstants: Array<SelectedConstant> = []
  for (const module of index.modules) {
    const moduleDiagnostics = Diagnostic.publishAll(
      results.get(module.module)?.diagnostics ?? [],
      registry,
    )
    for (const declaration of module.constants) {
      const declarationSpan = registry.spanOf(declaration.anchor)
      const declarationHasError = moduleDiagnostics.some(
        (diagnostic) =>
          diagnostic.severity === 'error' &&
          declarationSpan.sourceId === diagnostic.span.sourceId &&
          declarationSpan.start <= diagnostic.span.start &&
          diagnostic.span.end <= declarationSpan.end,
      )
      if (declarationHasError) continue
      const selected = Residualization.evaluateConstant(residualization, declaration)
      if (selected._tag === 'Failed') {
        const diagnostic = Diagnostic.publish(
          Evaluation.diagnostic(selected.failure, target.id),
          registry,
        )
        residualizationDiagnostics.set(
          `${diagnostic.code}:${diagnostic.span.sourceId}:${diagnostic.span.start}:${diagnostic.span.end}`,
          diagnostic,
        )
      } else if (declaration.canonical._tag === 'Canonical') {
        selectedConstants.push({
          _tag: 'SelectedConstant',
          declaration: declaration.canonical.id,
          value: selected.value,
        })
      }
    }
  }
  const recordedCallables = new Map<string, CallableInstance>()
  /** Finds the already-discovered environment a hidden callable identity names. */
  const resolveRecordedCallable = (
    identity: Type.CallableIdentityArgument,
  ): CallableInstance | undefined => {
    const environment = identity.environment
    if (environment === undefined) return undefined
    for (const candidate of recordedCallables.values()) {
      if (
        Type.runtimeCallableEnvironmentIdentityKey(environment) ===
          Type.runtimeCallableEnvironmentIdentityKey(callableEnvironmentIdentity(candidate)) &&
        Tir.matchesCallableTargetIdentity(candidate.target, identity.target) &&
        candidate.typeArguments.length === identity.typeArguments.length &&
        candidate.typeArguments.every((argument, ordinal) => {
          const expected = identity.typeArguments.at(ordinal)
          return (
            expected !== undefined &&
            Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(expected)
          )
        })
      )
        return candidate
    }
    return undefined
  }
  const recordedCalls = new Map<string, CallInstance>()
  const providerCalls = new Map<string, CallInstance>()
  const executionEdges = new Map<string, ExecutionEdge>()
  const scheduledContexts = new Map<string, WorkItem>()
  const queuedContexts = new Set<string>()
  const histories = AncestorHistory.make()
  const ancestorValues = new Map<string, Ancestor>()
  interface Ancestor {
    readonly key: InstanceKey
    readonly structuralProvider?: Type.Type
  }
  interface CleanupMeasure {
    /** Concrete owner types whose exact cleanup plans selected this path. */
    readonly roots: ReadonlyArray<Type.Type>
    /** Concrete arguments of the selected hook, usable only within this cleanup frame. */
    readonly frame: ReadonlyArray<Type.Type>
  }
  interface WorkItem {
    readonly key: InstanceKey
    readonly staticArgumentOrigins?: ReadonlyArray<Evaluation.TextOrigin | undefined>
    /** The instance whose body made the call, whose own parameters the origins may name. */
    readonly selectedBy?: InstanceKey
    readonly ancestors: AncestorHistory.History
    /** Ordinary type arguments retained as the finite structural measure of a cleanup path. */
    readonly cleanupMeasure?: CleanupMeasure
  }
  const declarationText = (key: InstanceKey): string =>
    `${key.declaration.module}\u0000${key.declaration.name}`
  const familiesByDeclaration = new Map<string, Set<string>>()
  /** A provider's finite callable target selects which body can continue a generic call cycle. */
  const recursionFamily = (key: InstanceKey): string => {
    const declaration = declarationText(key)
    const targets = key.typeArguments
      .filter(Type.isCallableIdentityArgument)
      .map((argument) => argument.target)
    const family = targets.length === 0 ? declaration : JSON.stringify([declaration, targets])
    let families = familiesByDeclaration.get(declaration)
    if (families === undefined) {
      families = new Set()
      familiesByDeclaration.set(declaration, families)
    }
    families.add(family)
    return family
  }
  const variableArguments = new Map<string, boolean>()
  const emptySubstitution: Type.Substitution = new Map()
  /**
   * The recursion guard compares type arguments, not the route taken through ordinary functions.
   * A declaration with no binders or hidden executable parameters always has the same arguments,
   * so remembering its presence cannot affect that guard. Retain unknown declarations and all
   * specialization-bearing declarations conservatively, including nongeneric functions accepting
   * callable/Effect values: those acquire hidden identity arguments at their call sites.
   */
  const needsAncestor = (key: InstanceKey): boolean => {
    if (key.typeArguments.length > 0) return true
    const declaration = declarationText(key)
    const known = variableArguments.get(declaration)
    if (known !== undefined) return known
    const fn = functionByKey(results, key)
    const needed =
      fn === undefined ||
      fn.declaration.typeParameters.length > 0 ||
      effectParameterOrdinals(fn, emptySubstitution).length > 0 ||
      callableParameterOrdinals(fn, emptySubstitution).length > 0
    variableArguments.set(declaration, needed)
    return needed
  }
  /**
   * Instance keys seen for one finite declaration/provider-target family.
   *
   * `needsAncestor` admits a declaration whose arguments *may* vary. Whether they do is a fact
   * about the program: a family discovery only ever realizes at one instance key has one
   * possible ancestor, equal to every target of it, so every guard below it is admitted and its
   * correlation with the rest of the history decides nothing. Recording it anyway is what made the
   * exact history of a few hundred mutually recursive walkers grow past what a process can hold,
   * because one strongly connected component projects onto itself and nothing else removes it.
   * A family therefore enters the ancestry only once a second instance key proves it
   * discriminating, and discovery restarts so the histories built without it are rebuilt with it.
   */
  const realizedKeys = new Map<string, Set<string>>()
  const discriminating = new Set<string>()
  let discriminatingGrew = false
  const isDiscriminating = (key: InstanceKey): boolean => {
    const family = recursionFamily(key)
    if (discriminating.has(family)) return true
    let keys = realizedKeys.get(family)
    if (keys === undefined) {
      keys = new Set()
      realizedKeys.set(family, keys)
    }
    keys.add(keyText(key))
    if (keys.size < 2) return false
    discriminating.add(family)
    discriminatingGrew = true
    return true
  }
  const withAncestor = (
    history: AncestorHistory.History,
    ancestor: Ancestor,
  ): AncestorHistory.History => {
    if (ancestor.structuralProvider === undefined && !needsAncestor(ancestor.key)) return history
    if (ancestor.structuralProvider === undefined && !isDiscriminating(ancestor.key)) return history
    const value = JSON.stringify([
      keyText(ancestor.key),
      ancestor.structuralProvider === undefined ? null : Type.key(ancestor.structuralProvider),
    ])
    ancestorValues.set(value, ancestor)
    return AncestorHistory.set(histories, history, recursionFamily(ancestor.key), value)
  }
  /**
   * A guard below a call to `T` consults only the ancestors of declarations called beneath `T`.
   * An ancestor declaration `V` already reaches `T`, so it can be consulted again only if `T` also
   * reaches `V`: both lie in one strongly connected component of the declaration call graph. Every
   * other ancestor's correlation is dead to the guard, yet keeping it multiplies exact histories
   * through generic wrappers outside any cycle, such as a test runner's Effect combinators around
   * many recursive walkers. Each successor history is therefore projected onto its target's
   * component.
   *
   * The graph is the declaration-level image of the edges this discovery evaluates, so it covers
   * every dynamic selection (witnesses, callables, Effects, cleanup hooks, providers) without
   * restating how each is chosen. A component can grow after a projection used its smaller
   * predecessor, and that attempt may have missed a guard; discovery then restarts from the roots
   * with the complete graph until no projected component grows. Only the final attempt publishes.
   */
  const callEdges = new Map<string, Set<string>>()
  let cycles = new Map<string, ReadonlySet<string>>()
  let cyclesCurrent = true
  const projectedCycleSizes = new Map<string, number>()
  const reaches = (from: string, to: string): boolean => {
    const seen = new Set([from])
    const stack = [from]
    for (let current = stack.pop(); current !== undefined; current = stack.pop())
      for (const next of callEdges.get(current) ?? []) {
        if (next === to) return true
        if (seen.has(next)) continue
        seen.add(next)
        stack.push(next)
      }
    return false
  }
  const addCallEdge = (caller: InstanceKey, target: InstanceKey): void => {
    const from = declarationText(caller)
    const to = declarationText(target)
    let targets = callEdges.get(from)
    if (targets === undefined) {
      targets = new Set()
      callEdges.set(from, targets)
    }
    if (targets.has(to)) return
    targets.add(to)
    // A new edge merges components only when its target already reaches its caller.
    if (!callEdges.has(to)) {
      callEdges.set(to, new Set())
      return
    }
    if (!cyclesCurrent || from === to) return
    const component = cycles.get(from)
    if (component !== undefined && component === cycles.get(to)) return
    if (reaches(to, from)) cyclesCurrent = false
  }
  const cycleOf = (declaration: string): ReadonlySet<string> => {
    if (!cyclesCurrent) {
      cyclesCurrent = true
      cycles = new Map()
      for (const component of Graph.stronglyConnected(
        callEdges.keys(),
        (from) => callEdges.get(from) ?? [],
      )) {
        const members = new Set(component)
        for (const member of component) cycles.set(member, members)
      }
    }
    let members = cycles.get(declaration)
    if (members === undefined) {
      members = new Set([declaration])
      cycles.set(declaration, members)
    }
    return members
  }
  const successorHistory = (
    history: AncestorHistory.History,
    ancestor: Ancestor,
  ): AncestorHistory.History => {
    const declaration = declarationText(ancestor.key)
    recursionFamily(ancestor.key)
    const cycle = cycleOf(declaration)
    if (!projectedCycleSizes.has(declaration)) projectedCycleSizes.set(declaration, cycle.size)
    const families = new Set(
      [...cycle].flatMap((member) => [...(familiesByDeclaration.get(member) ?? [])]),
    )
    return withAncestor(AncestorHistory.project(histories, history, families), ancestor)
  }
  const cycleGrewAfterProjection = (): boolean => {
    for (const [declaration, size] of projectedCycleSizes)
      if (cycleOf(declaration).size > size) return true
    return false
  }
  const sameArguments = (left: InstanceKey, right: InstanceKey): boolean =>
    left.typeArguments.length === right.typeArguments.length &&
    left.typeArguments.every((argument, index) => {
      const candidate = right.typeArguments.at(index)
      return (
        candidate !== undefined &&
        Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(candidate)
      )
    })
  const typeSize = (type: Type.Type): number => {
    let size = 0
    Type.visit(type, () => {
      size += 1
    })
    return size
  }
  /** A finite set of concrete type shapes cannot grow through a non-increasing call cycle. */
  const nonGrowingTypeArguments = (ancestor: InstanceKey, target: InstanceKey): boolean => {
    if (
      ancestor.typeArguments.length === 0 ||
      ancestor.typeArguments.length !== target.typeArguments.length
    )
      return false
    return ancestor.typeArguments.every((argument, ordinal) => {
      const next = target.typeArguments.at(ordinal)
      return (
        next !== undefined &&
        Type.isTypeArgument(argument) &&
        Type.isTypeArgument(next) &&
        Type.parameters(argument).length === 0 &&
        Type.parameters(next).length === 0 &&
        typeSize(next) <= typeSize(argument)
      )
    })
  }
  const typeArgumentsOf = (key: InstanceKey): ReadonlyArray<Type.Type> =>
    key.typeArguments.filter(Type.isTypeArgument)
  /**
   * Recognizes a field/type-argument subterm without unfolding the same nominal declaration twice.
   * That declaration guard is what makes a recursive shape such as `Bad<Box<T>>` non-descending
   * even though the concrete cleanup plan reaches it through an indirection actor.
   */
  const nominalTypeText = (type: Type.Type): string | undefined =>
    Type.isNominal(type) ? `${type.module}\u0000${type.name}` : undefined
  const sameRuntimeType = (left: Type.Type, right: Type.Type): boolean =>
    Type.runtimeKey(left) === Type.runtimeKey(right)
  // Runtime keys of every subterm of one whole type, shared by repeated subterm queries.
  const runtimeSubtermKeys = new Map<string, ReadonlySet<string>>()
  const isStrictRuntimeStructuralSubterm = (candidate: Type.Type, whole: Type.Type): boolean => {
    const candidateKey = Type.runtimeKey(candidate)
    const wholeKey = Type.runtimeKey(whole)
    if (candidateKey === wholeKey) return false
    let keys = runtimeSubtermKeys.get(wholeKey)
    if (keys === undefined) {
      const collected = new Set<string>()
      Type.visit(whole, (type) => {
        collected.add(Type.runtimeKey(type))
      })
      keys = collected
      runtimeSubtermKeys.set(wholeKey, keys)
    }
    return keys.has(candidateKey)
  }
  /** A witness may delegate to a field's concrete type even when nominal types have no arguments. */
  const isDirectWitnessFieldSubterm = (candidate: Type.Type, whole: Type.Type): boolean => {
    if (!Type.isNominal(whole) || sameRuntimeType(candidate, whole)) return false
    const declaration = DeclarationFacts.byCanonical(index, {
      _tag: 'CanonicalDeclarationId',
      module: whole.module,
      name: whole.name,
    })
    if (declaration?._tag !== 'StructDeclaration' && declaration?._tag !== 'UnionDeclaration')
      return false
    const substitution =
      TypeInference.substitution(
        declaration.typeParameters.map((parameter) => parameter.type),
        whole.arguments,
      ) ?? new Map()
    const fields =
      declaration._tag === 'StructDeclaration'
        ? declaration.fields
        : declaration.variants.flatMap((variant) => variant.fields)
    return fields.some((field) => {
      if (field.declaredType._tag !== 'Resolved') return false
      const type = Type.substitute(field.declaredType.type, substitution)
      return sameRuntimeType(candidate, type) || isStrictRuntimeStructuralSubterm(candidate, type)
    })
  }
  const strictlyDescendsSameNominal = (candidate: Type.Nominal, whole: Type.Nominal): boolean => {
    if (candidate.module !== whole.module || candidate.name !== whole.name) return false
    return (
      candidate.arguments.length === whole.arguments.length &&
      candidate.arguments.every((argument, index) => {
        const parent = whole.arguments.at(index)
        if (parent === undefined) return false
        if (Type.isTypeArgument(argument) && Type.isTypeArgument(parent))
          return (
            sameRuntimeType(argument, parent) || isStrictRuntimeStructuralSubterm(argument, parent)
          )
        return Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(parent)
      }) &&
      candidate.arguments.some((argument, index) => {
        const parent = whole.arguments.at(index)
        return (
          parent !== undefined &&
          Type.isTypeArgument(argument) &&
          Type.isTypeArgument(parent) &&
          isStrictRuntimeStructuralSubterm(argument, parent)
        )
      })
    )
  }
  const concreteWitnessFieldDescent = (ancestor: InstanceKey, target: InstanceKey): boolean => {
    if (ancestor.typeArguments.length !== target.typeArguments.length) return false
    let descended = false
    for (const [ordinal, argument] of ancestor.typeArguments.entries()) {
      const next = target.typeArguments.at(ordinal)
      if (next === undefined) return false
      if (Type.isTypeArgument(argument) && Type.isTypeArgument(next)) {
        if (Type.parameters(argument).length > 0 || Type.parameters(next).length > 0) return false
        if (sameRuntimeType(argument, next)) continue
        const sameNominal =
          Type.isNominal(argument) &&
          Type.isNominal(next) &&
          nominalTypeText(argument) === nominalTypeText(next)
        if (
          !(sameNominal && strictlyDescendsSameNominal(next, argument)) &&
          !(
            !sameNominal &&
            (isStrictRuntimeStructuralSubterm(next, argument) ||
              isDirectWitnessFieldSubterm(next, argument))
          )
        )
          return false
        descended = true
      } else if (
        !(Type.isEffectIdentityArgument(argument) && Type.isEffectIdentityArgument(next)) &&
        Type.runtimeGenericArgumentKey(argument) !== Type.runtimeGenericArgumentKey(next)
      )
        return false
    }
    return descended
  }
  // Instance discovery asks the same cleanup-subterm questions for many instances; the
  // answer depends only on runtime identities and the unfolding path, so memoize it.
  const strictCleanupSubtermCache = new Map<string, boolean>()
  const isStrictCleanupSubterm = (
    candidate: Type.Type,
    whole: Type.Type,
    unfolding: ReadonlyMap<string, Type.Nominal> = new Map(),
  ): boolean => {
    let cacheKey = `${Type.runtimeKey(candidate)}\u0001${Type.runtimeKey(whole)}`
    for (const nominal of unfolding.values()) cacheKey += `\u0001${Type.runtimeKey(nominal)}`
    let cached = strictCleanupSubtermCache.get(cacheKey)
    if (cached === undefined) {
      cached = computeStrictCleanupSubterm(candidate, whole, unfolding)
      strictCleanupSubtermCache.set(cacheKey, cached)
    }
    return cached
  }
  const computeStrictCleanupSubterm = (
    candidate: Type.Type,
    whole: Type.Type,
    unfolding: ReadonlyMap<string, Type.Nominal>,
  ): boolean => {
    if (sameRuntimeType(candidate, whole)) return false
    const candidateDeclaration = nominalTypeText(candidate)
    const wholeDeclaration = nominalTypeText(whole)
    if (candidateDeclaration !== undefined && candidateDeclaration === wholeDeclaration)
      return (
        Type.isNominal(candidate) &&
        Type.isNominal(whole) &&
        strictlyDescendsSameNominal(candidate, whole)
      )
    if (isStrictRuntimeStructuralSubterm(candidate, whole)) return true
    const nominals = new Map<string, Type.Nominal>()
    Type.visit(whole, (type) => {
      if (Type.isNominal(type)) nominals.set(Type.runtimeKey(type), type)
    })
    for (const nominal of nominals.values()) {
      const declarationText = `${nominal.module}\u0000${nominal.name}`
      const prior = unfolding.get(declarationText)
      if (
        prior !== undefined &&
        (sameRuntimeType(nominal, prior) || !strictlyDescendsSameNominal(nominal, prior))
      )
        continue
      const declaration = DeclarationFacts.byCanonical(index, {
        _tag: 'CanonicalDeclarationId',
        module: nominal.module,
        name: nominal.name,
      })
      if (declaration?._tag !== 'StructDeclaration' && declaration?._tag !== 'UnionDeclaration')
        continue
      const substitution =
        TypeInference.substitution(
          declaration.typeParameters.map((parameter) => parameter.type),
          nominal.arguments,
        ) ?? new Map()
      const nextUnfolding = new Map(unfolding).set(declarationText, nominal)
      const fields =
        declaration._tag === 'StructDeclaration'
          ? declaration.fields
          : declaration.variants.flatMap((variant) => variant.fields)
      if (
        fields.some(
          (field) =>
            field.declaredType._tag === 'Resolved' &&
            isStrictCleanupSubterm(
              candidate,
              Type.substitute(field.declaredType.type, substitution),
              nextUnfolding,
            ),
        )
      )
        return true
    }
    return false
  }
  const coveredByCleanupMeasure = (measure: CleanupMeasure, candidate: Type.Type): boolean =>
    measure.roots.some(
      (root) => sameRuntimeType(candidate, root) || isStrictCleanupSubterm(candidate, root),
    )
  const cleanupMeasureOf = (
    roots: ReadonlyArray<Type.Type>,
    frame: ReadonlyArray<Type.Type> = [],
  ): CleanupMeasure => ({
    roots: [...new Map(roots.map((root) => [Type.runtimeKey(root), root])).values()],
    frame,
  })
  const cleanupTransition = (
    measure: CleanupMeasure | undefined,
    target: InstanceKey,
    selectedRoots: ReadonlyArray<Type.Type>,
    ancestor: InstanceKey | undefined,
  ): CleanupMeasure | undefined => {
    if (measure === undefined)
      return selectedRoots.length === 0 ? undefined : cleanupMeasureOf(selectedRoots)
    // Each selected cleanup hook may expose a more deeply owned payload hidden from the
    // original roots by an opaque buffer. Its concrete arguments justify the next cleanup
    // owner, provided a repeated hook family does not grow. Keep the original roots fixed.
    if (selectedRoots.length > 0) {
      const fromRoots = selectedRoots.some((root) => coveredByCleanupMeasure(measure, root))
      const fromFrame =
        (ancestor === undefined || nonGrowingTypeArguments(ancestor, target)) &&
        selectedRoots.some((root) =>
          measure.frame.some(
            (frame) => sameRuntimeType(root, frame) || isStrictCleanupSubterm(root, frame),
          ),
        )
      return fromRoots || fromFrame
        ? cleanupMeasureOf(measure.roots, typeArgumentsOf(target))
        : undefined
    }
    const targetTypes = typeArgumentsOf(target)
    return targetTypes.every(
      (type) =>
        coveredByCleanupMeasure(measure, type) ||
        measure.frame.some(
          (frame) => sameRuntimeType(type, frame) || isStrictCleanupSubterm(type, frame),
        ),
    )
      ? measure
      : undefined
  }
  const sameVisibleArguments = (left: InstanceKey, right: InstanceKey): boolean => {
    const leftVisible = left.typeArguments.filter(
      (argument) => !Type.isHiddenExecutableArgument(argument),
    )
    const rightVisible = right.typeArguments.filter(
      (argument) => !Type.isHiddenExecutableArgument(argument),
    )
    return (
      leftVisible.length === rightVisible.length &&
      leftVisible.every((argument, index) => {
        const candidate = rightVisible.at(index)
        return (
          candidate !== undefined &&
          Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(candidate)
        )
      })
    )
  }
  const runtimeNonTypeArgumentsOf = (key: InstanceKey): ReadonlyArray<Type.GenericArgument> =>
    key.typeArguments.filter(
      (argument) =>
        !Type.isTypeArgument(argument) && Type.runtimeGenericArgumentKey(argument) !== '',
    )
  const sameRuntimeArguments = (
    left: ReadonlyArray<Type.GenericArgument>,
    right: ReadonlyArray<Type.GenericArgument>,
  ): boolean =>
    left.length === right.length &&
    left.every((argument, index) => {
      const candidate = right.at(index)
      return (
        candidate !== undefined &&
        Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(candidate)
      )
    })
  const sameRuntimeNonTypeArguments = (left: InstanceKey, right: InstanceKey): boolean =>
    sameRuntimeArguments(runtimeNonTypeArgumentsOf(left), runtimeNonTypeArgumentsOf(right))
  const sameRuntimeNonCallableArguments = (left: InstanceKey, right: InstanceKey): boolean => {
    const leftNonCallable = runtimeNonTypeArgumentsOf(left).filter(
      (argument) => !Type.isCallableIdentityArgument(argument),
    )
    const rightNonCallable = runtimeNonTypeArgumentsOf(right).filter(
      (argument) => !Type.isCallableIdentityArgument(argument),
    )
    return (
      sameRuntimeArguments(leftNonCallable, rightNonCallable) &&
      isTerminalCallableSpecialization(left, right)
    )
  }
  const isTerminalCallableSpecialization = (ancestor: InstanceKey, target: InstanceKey): boolean =>
    sameVisibleArguments(ancestor, target) &&
    target.typeArguments.some(Type.isCallableIdentityArgument) &&
    target.typeArguments
      .filter(Type.isHiddenIdentityArgument)
      .every(
        (argument) =>
          Type.isCallableIdentityArgument(argument) && argument.environment === undefined,
      )
  const cleanupPermitsSpecialization = (
    ancestor: InstanceKey | undefined,
    target: InstanceKey,
    cleanup: CleanupMeasure | undefined,
  ): boolean =>
    cleanup !== undefined &&
    (ancestor === undefined ||
      sameRuntimeNonTypeArguments(ancestor, target) ||
      sameRuntimeNonCallableArguments(ancestor, target))
  const rootItem = (key: InstanceKey): WorkItem => ({
    key,
    ancestors: withAncestor(histories.initial, { key }),
  })
  const roots: Array<WorkItem> = retention.map(rootItem)
  // Retain exactly the export implementations admitted by the selected target's C contract.
  for (const record of foreignExports)
    if (CAbi.available(target, record.signature)) roots.push(rootItem(record.key))
  const violations: Array<PolymorphicRecursion> = []
  const violationKeys = new Set<string>()
  const specializationFailures = new Map<string, NonConcreteSpecialization>()
  const recordedContexts = new Map<string, Map<string, WorkItem>>()
  // Histories are exact correlated sets. Only the non-history execution context determines
  // a queue bucket; a new canonical history root revisits that bucket's outgoing guards.
  // Static text origins locate diagnostics, not specializations. Retain the first caller's
  // provenance when the bucket grows, as for repeated calls with equal static values.
  const contextText = (item: WorkItem): string =>
    JSON.stringify([
      keyText(item.key),
      item.cleanupMeasure?.roots.map(Type.runtimeKey).sort() ?? null,
      item.cleanupMeasure?.frame.map(Type.runtimeKey).sort() ?? null,
    ])
  const pending: Array<string> = []
  type StaticOrigins = ReadonlyArray<Evaluation.TextOrigin | undefined>
  /** What each call that selected an application wrote for its static text. */
  const selections = new Map<
    string,
    Map<string, { readonly origins: StaticOrigins; readonly caller?: string }>
  >()
  /** Every selection of an application in terms of written literals, through its callers. */
  const writtenSelections = (
    key: string,
    visiting: ReadonlySet<string> = new Set(),
  ): ReadonlyArray<StaticOrigins> => {
    if (visiting.has(key)) return []
    const inner = new Set(visiting).add(key)
    return [...(selections.get(key)?.values() ?? [])].flatMap(({ origins, caller }) => {
      const callers =
        caller !== undefined &&
        origins.some((origin) => origin?.some((segment) => segment.from._tag === 'Parameter'))
          ? writtenSelections(caller, inner)
          : []
      return callers.length === 0
        ? [origins]
        : callers.map((written) =>
            origins.map((origin) =>
              origin === undefined ? undefined : Provenance.substitute(origin, written),
            ),
          )
    })
  }
  /** Diagnostics about a shared body, published once every selecting call is known. */
  const sharedDiagnostics: Array<{
    readonly key: string
    readonly diagnostic: Diagnostic.Located
  }> = []
  /** Body diagnostics wait for the final discovery attempt, which decides the reached keys. */
  const reported: Array<{
    readonly key: string
    readonly diagnostic: Diagnostic.Located
    readonly published: Diagnostic.Diagnostic
  }> = []
  const report = (key: InstanceKey, diagnostic: Diagnostic.Located): Diagnostic.Diagnostic => {
    const published = Diagnostic.publish(diagnostic, registry)
    reported.push({ key: keyText(key), diagnostic, published })
    return published
  }
  const schedule = (item: WorkItem): boolean => {
    if (item.staticArgumentOrigins !== undefined) {
      const caller = item.selectedBy === undefined ? undefined : keyText(item.selectedBy)
      const known = selections.get(keyText(item.key)) ?? new Map()
      known.set(JSON.stringify([caller, item.staticArgumentOrigins]), {
        origins: item.staticArgumentOrigins,
        ...(caller === undefined ? {} : { caller }),
      })
      selections.set(keyText(item.key), known)
    }
    const context = contextText(item)
    const prior = scheduledContexts.get(context)
    const ancestors =
      prior === undefined
        ? item.ancestors
        : AncestorHistory.union(histories, prior.ancestors, item.ancestors)
    if (prior?.ancestors === ancestors) return false
    scheduledContexts.set(context, { ...(prior ?? item), ancestors })
    if (!queuedContexts.has(context)) {
      queuedContexts.add(context)
      pending.push(context)
    }
    return true
  }
  for (const root of roots) schedule(root)
  const cleanupPrepassTargets = (
    fn: Tir.TirFunction,
    substitution: Type.Substitution,
  ): ReadonlyArray<CallTarget> => {
    const types = new Map<string, Type.Type>()
    for (const parameter of fn.declaration.parameters) {
      if (parameter.phase !== 'Runtime' || parameter.declaredType._tag !== 'Resolved') continue
      const type = Type.substitute(parameter.declaredType.type, substitution)
      types.set(Type.key(type), type)
    }
    for (const expression of fn.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      if (expression._tag === 'Unavailable') continue
      const type = Type.substitute(expression.type, substitution)
      types.set(Type.key(type), type)
    }
    return [...types.values()].flatMap((type) =>
      hookCalls(CleanupPlan.cleanupPlan(index, type), index),
    )
  }
  /** Finds concrete provider-owner roots whose cleanup plans select the target. */
  const cleanupRootsOf = (ancestor: InstanceKey, target: InstanceKey): ReadonlyArray<Type.Type> =>
    typeArgumentsOf(ancestor).filter((type) =>
      hookCalls(CleanupPlan.cleanupPlan(index, type), index).some((call) => {
        const fn = FunctionIndex.tirByName(
          results.get(call.declaration.module)?.tir,
          call.declaration.name,
        )
        if (fn === undefined) return false
        const candidate = keyOf(
          call.declaration,
          fn.contract,
          fn.declaration.typeParameters.map((parameter) => parameter.type),
          call.typeArguments,
          call.staticArguments ?? [],
          call.evidence ?? [],
        )
        return keyText(candidate) === keyText(target)
      }),
    )
  /**
   * Residualization, specialization and call targets of one key depend on the key alone; a bucket
   * revisited for a new ancestor history reuses them. Recorded callables are collected per visit,
   * since resolving them reads what earlier visits recorded.
   */
  interface Analyzed {
    readonly fn: Tir.TirFunction
    readonly view: BodyView.BodyView
    readonly substitution: Type.Substitution
    readonly calls: ReadonlyMap<string, CallTarget>
    readonly identityOfCall: (call: CallTarget) => string
    readonly ordinaryIdentities: ReadonlySet<string>
    readonly witnessTargets: ReadonlyArray<CallTarget>
    readonly cleanupRoots: ReadonlyMap<string, ReadonlyArray<Type.Type>>
    /** Each call's concrete target, resolved once for every ancestry context of this key. */
    readonly targetKeys: Map<CallTarget, InstanceKey | undefined>
  }
  const analyzedKeys = new Map<string, Analyzed | undefined>()
  // Without a staged application a body's callables never consult recorded callables, so each
  // key object's realization is shared by every ancestry context that reaches it.
  const contextFreeCallables = new WeakMap<InstanceKey, ReadonlyArray<CallableInstance>>()
  const analyze = (key: InstanceKey): Analyzed | undefined => {
    const text = keyText(key)
    if (analyzedKeys.has(text)) return analyzedKeys.get(text)
    const result = analyzeKey(key)
    analyzedKeys.set(text, result)
    return result
  }
  const selectedWitnessOf = (
    ancestor: InstanceKey,
    implementation: InstanceKey,
    fn: Tir.TirFunction,
  ): boolean => {
    const analyzed = analyze(ancestor)
    if (analyzed === undefined) return false
    return analyzed.witnessTargets.some((call) => {
      if (
        call.declaration.module !== implementation.declaration.module ||
        call.declaration.name !== implementation.declaration.name
      )
        return false
      const targetArguments = call.typeArguments.map((argument) =>
        Type.substituteGenericArgument(argument, analyzed.substitution),
      )
      const selected = keyOf(
        call.declaration,
        fn.contract,
        fn.declaration.typeParameters.map((parameter) => parameter.type),
        targetArguments,
        call.staticArguments ?? [],
        call.evidence ?? [],
      )
      return keyText(selected) === keyText(implementation)
    })
  }
  const analyzeKey = (key: InstanceKey): Analyzed | undefined => {
    const template = functionByKey(results, key)
    if (template === undefined) return undefined
    const application = {
      declaration: key.declaration,
      typeArguments: key.typeArguments,
      evidence: key.evidence,
      contractRow: key.contractRow,
      staticArguments: key.staticArguments,
    }
    const residual = trace(
      'Instances.residualize',
      () => Residualization.residualize(residualization, application),
      { 'function.module': key.declaration.module, 'function.name': key.declaration.name },
    )
    const residualApplication = Residualization.applicationIdentity(residualization, application)
    if (residual._tag === 'StaticFailure') {
      report(key, Evaluation.diagnostic(residual.failure, target.id))
      return undefined
    }
    const selectedCompileError = residual.diagnostics.findIndex(
      (diagnostic) => diagnostic.code === Diagnostic.selectedCompileErrorCode,
    )
    const residualDiagnostics = (
      selectedCompileError < 0
        ? residual.diagnostics
        : residual.diagnostics.slice(0, selectedCompileError + 1)
    ).map((diagnostic) => report(key, diagnostic))
    const residualError = residualDiagnostics.find((diagnostic) => diagnostic.severity === 'error')
    if (residualError !== undefined) {
      preparedUnavailableOwnership.set(keyText(key), {
        key,
        artifact: residual.artifact,
        function: residual.function,
        causes: residual.results.causes,
        ...(residual.results.lifetimes === undefined
          ? {}
          : { lifetimes: residual.results.lifetimes }),
        diagnostic: residualError,
      })
      return undefined
    }
    const fn = residual.function
    const view = BodyView.make(residual)
    const parameters = template.declaration.typeParameters.map((parameter) => parameter.type)
    const selected = TypeInference.selectedSubstitution(
      parameters,
      key.typeArguments.filter((argument) => !Type.isHiddenExecutableArgument(argument)),
    )
    const substitution = selected?.substitution
    // A key whose arguments no longer fit the declaration's binders is as unreachable as one
    // that cannot be made concrete; both are reported rather than silently dropped.
    const specialization =
      substitution === undefined
        ? undefined
        : trace(
            'Instances.specialize',
            () => specialize(view, substitution, index, registry, selected?.compatibility),
            {
              'function.module': key.declaration.module,
              'function.name': key.declaration.name,
            },
          )
    if (substitution === undefined || specialization === undefined) {
      specializationFailures.set(keyText(key), {
        _tag: 'NonConcreteSpecialization',
        key,
        span: registry.spanOf(fn.declaration.anchor),
      })
      return undefined
    }
    if (!prepared.has(keyText(key))) {
      const resultCallable = resultCallableIdentity(fn, key, results, index)
      const resultEffect = resultEffectIdentity(fn, key, results, index)
      prepared.set(keyText(key), {
        ...(residual.results.lifetimes === undefined
          ? {}
          : { lifetimes: residual.results.lifetimes }),
        instance: {
          _tag: 'Instance',
          key,
          residualApplication,
          function: fn,
          view,
          substitution,
          specialization,
          ...(resultCallable === undefined ? {} : { resultCallable }),
          ...(resultEffect === undefined ? {} : { resultEffect }),
        },
      })
    }
    const collected = trace(
      'Instances.collectCallTargets',
      () => {
        const cleanupHooks = cleanupPrepassTargets(fn, substitution)
        const calls = new Map<string, CallTarget>()
        const directCalls = directCallInstances(fn, key, substitution, results, index)
        const callableTargets = callableCallTargets(fn, key, substitution, results, index)
        for (const call of directCalls) {
          recordedCalls.set(
            `${keyText(call.owner)}\u0005${call.span.sourceId}:${call.span.start}:${call.span.end}\u0005${call.node?.ordinal ?? -1}\u0005${keyText(call.target)}`,
            call,
          )
        }
        const cleanupTargets = [...slotDropHookTargets(fn, index, substitution), ...cleanupHooks]
        const witnessTargets = interfaceWitnessTargets(fn, index, substitution)
        const identityOfCall = Specialization.key
        const ordinaryTargets: ReadonlyArray<CallTarget> = [
          ...bodyCallTargets(view, index, substitution),
          ...witnessTargets,
          ...requirementBindingCallTargets(fn, substitution, index),
          ...directCalls.map((call) => ({
            declaration: call.target.declaration,
            typeArguments: call.target.typeArguments,
            evidence: call.target.evidence,
            staticArguments: call.target.staticArguments,
            ...(call.staticArgumentOrigins === undefined
              ? {}
              : { staticArgumentOrigins: call.staticArgumentOrigins }),
          })),
          ...forwardedRequirementCallTargets(directCalls, results, index),
          ...callableTargets,
          ...forwardedRequirementTargets(callableTargets, results, index),
        ]
        return { calls, cleanupTargets, identityOfCall, ordinaryTargets, witnessTargets }
      },
      { 'function.module': key.declaration.module, 'function.name': key.declaration.name },
    )
    const { calls, cleanupTargets, identityOfCall, ordinaryTargets, witnessTargets } = collected
    const ordinaryIdentities = new Set(ordinaryTargets.map(identityOfCall))
    const cleanupRoots = new Map<string, Array<Type.Type>>()
    for (const cleanup of cleanupTargets) {
      if (cleanup.cleanupRoot === undefined) continue
      const identity = identityOfCall(cleanup)
      const roots = cleanupRoots.get(identity) ?? []
      roots.push(cleanup.cleanupRoot)
      cleanupRoots.set(identity, roots)
    }
    const reachableCalls: ReadonlyArray<CallTarget> = [...ordinaryTargets, ...cleanupTargets]
    for (const call of reachableCalls) {
      const identity = identityOfCall(call)
      const existing = calls.get(identity)
      // An ordinary edge must keep the recursion guard even when the same target is also reached
      // through a proved dependency or conditional witness root. Conflicting provider evidence is
      // equally unsafe: descent is granted only where this path has one unambiguous measure.
      if (existing === undefined) {
        calls.set(identity, call)
        continue
      }
      const existingOrdinary = existing.structuralProvider === undefined
      const callOrdinary = call.structuralProvider === undefined
      if (existingOrdinary) continue
      if (callOrdinary) {
        calls.set(identity, {
          declaration: call.declaration,
          typeArguments: call.typeArguments,
          ...(call.evidence === undefined ? {} : { evidence: call.evidence }),
          ...(call.staticArguments === undefined ? {} : { staticArguments: call.staticArguments }),
          ...(call.staticArgumentOrigins === undefined
            ? {}
            : { staticArgumentOrigins: call.staticArgumentOrigins }),
        })
        continue
      }
      if (
        existing.structuralProvider !== undefined &&
        call.structuralProvider !== undefined &&
        !Type.equals(existing.structuralProvider, call.structuralProvider)
      )
        calls.set(identity, {
          declaration: call.declaration,
          typeArguments: call.typeArguments,
          ...(call.evidence === undefined ? {} : { evidence: call.evidence }),
          ...(call.staticArguments === undefined ? {} : { staticArguments: call.staticArguments }),
          ...(call.staticArgumentOrigins === undefined
            ? {}
            : { staticArgumentOrigins: call.staticArgumentOrigins }),
        })
    }
    return {
      fn,
      view,
      substitution,
      calls,
      identityOfCall,
      ordinaryIdentities,
      witnessTargets,
      cleanupRoots,
      targetKeys: new Map(),
    }
  }
  const restartDiscovery = (): void => {
    scheduledContexts.clear()
    queuedContexts.clear()
    pending.length = 0
    recordedContexts.clear()
    recordedCallables.clear()
    providerCalls.clear()
    executionEdges.clear()
    selections.clear()
    violations.length = 0
    violationKeys.clear()
    projectedCycleSizes.clear()
    discriminatingGrew = false
    for (const root of roots) schedule(root)
  }
  trace('Instances.expandWorklist', () => {
    while (true) {
      // A declaration proved discriminating mid-round leaves the guards below it already taken
      // without its ancestry, so the round is abandoned rather than expanded further: without that
      // guard an unbounded specialization would keep scheduling work the restart discards anyway.
      for (let cursor = 0; cursor < pending.length && !discriminatingGrew; cursor += 1) {
        const context = pending[cursor]
        if (context === undefined) continue
        queuedContexts.delete(context)
        const item = scheduledContexts.get(context)
        if (item === undefined) continue
        const key = item.key
        const ownerContexts = recordedContexts.get(keyText(key)) ?? new Map<string, WorkItem>()
        ownerContexts.set(context, item)
        recordedContexts.set(keyText(key), ownerContexts)
        const analyzed = analyze(key)
        if (analyzed === undefined) continue
        const { fn, substitution, calls, identityOfCall, ordinaryIdentities, cleanupRoots } =
          analyzed
        let callables = stagedApplication(fn) ? undefined : contextFreeCallables.get(key)
        if (callables === undefined) {
          callables = concreteCallables(
            fn,
            key,
            substitution,
            results,
            index,
            resolveRecordedCallable,
          )
          if (!stagedApplication(fn)) contextFreeCallables.set(key, callables)
        }
        for (const callable of callables)
          recordedCallables.set(callableIdentity(callable), callable)
        for (const call of calls.values()) {
          const identity = identityOfCall(call)
          const target = call.declaration
          let targetKey = analyzed.targetKeys.get(call)
          if (targetKey === undefined && !analyzed.targetKeys.has(call)) {
            const targetFunction = FunctionIndex.tirByName(
              results.get(target.module)?.tir,
              target.name,
            )
            targetKey =
              targetFunction === undefined
                ? undefined
                : keyOf(
                    target,
                    targetFunction.contract,
                    targetFunction.declaration.typeParameters.map((parameter) => parameter.type),
                    call.typeArguments.map((argument) =>
                      Type.substituteGenericArgument(argument, substitution),
                    ),
                    call.staticArguments ?? [],
                    call.evidence ?? [],
                  )
            analyzed.targetKeys.set(call, targetKey)
          }
          if (targetKey === undefined) continue
          const edgeKind = ordinaryIdentities.has(identity) ? 'Runtime' : 'Cleanup'
          executionEdges.set(`${keyText(key)}\u0005${edgeKind}\u0005${keyText(targetKey)}`, {
            _tag: 'ExecutionEdge',
            kind: edgeKind,
            owner: key,
            target: targetKey,
          })
          addCallEdge(key, targetKey)
          for (const [value, branchHistory] of AncestorHistory.partition(
            histories,
            item.ancestors,
            recursionFamily(targetKey),
          )) {
            const ancestor = value === undefined ? undefined : ancestorValues.get(value)
            const structurallyDescending =
              call.structuralProvider !== undefined &&
              ancestor?.structuralProvider !== undefined &&
              Type.isStrictStructuralSubterm(call.structuralProvider, ancestor.structuralProvider)
            const cleanup = cleanupTransition(
              item.cleanupMeasure,
              targetKey,
              ordinaryIdentities.has(identity) ? [] : (cleanupRoots.get(identity) ?? []),
              ancestor?.key,
            )
            const terminalCallableSpecialization =
              ancestor !== undefined && sameRuntimeNonCallableArguments(ancestor.key, targetKey)
            const cleanupSpecialization = cleanupPermitsSpecialization(
              ancestor?.key,
              targetKey,
              cleanup,
            )
            if (
              ancestor !== undefined &&
              !sameArguments(ancestor.key, targetKey) &&
              !structurallyDescending &&
              !(
                selectedWitnessOf(ancestor.key, key, fn) &&
                (nonGrowingTypeArguments(ancestor.key, targetKey) ||
                  concreteWitnessFieldDescent(ancestor.key, targetKey))
              ) &&
              !cleanupSpecialization &&
              !terminalCallableSpecialization
            ) {
              const violationKey = `${keyText(key)}\u0000${keyText(targetKey)}`
              if (!violationKeys.has(violationKey)) {
                violationKeys.add(violationKey)
                violations.push({ _tag: 'PolymorphicRecursion', caller: key, target: targetKey })
              }
              continue
            }
            schedule({
              key: targetKey,
              ...(call.staticArgumentOrigins === undefined
                ? {}
                : { staticArgumentOrigins: call.staticArgumentOrigins, selectedBy: key }),
              ancestors: successorHistory(branchHistory, {
                key: targetKey,
                ...(call.structuralProvider === undefined
                  ? {}
                  : { structuralProvider: call.structuralProvider }),
              }),
              ...(cleanupSpecialization && cleanup !== undefined
                ? { cleanupMeasure: cleanup }
                : {}),
            })
          }
        }
      }
      if (discriminatingGrew) {
        restartDiscovery()
        continue
      }
      pending.length = 0

      const currentInstances = [...prepared]
        .filter(([text]) => recordedContexts.has(text))
        .map(([, candidate]) => candidate.instance)
      const currentGraph = trace('Instances.rebuildSuspensionGraph', () =>
        suspensionGraph(currentInstances, results, index, [...recordedCallables.values()]),
      )
      providerCalls.clear()
      for (const provided of currentGraph.providedTargets) {
        const target = functionByKey(results, provided.target)
        const resultEffect =
          target === undefined
            ? undefined
            : resultEffectIdentity(target, provided.target, results, index)
        providerCalls.set(
          `${keyText(provided.owner)}\u0005${provided.span.sourceId}:${provided.span.start}:${provided.span.end}\u0005${keyText(provided.target)}`,
          {
            _tag: 'CallInstance',
            owner: provided.owner,
            span: provided.span,
            target: provided.target,
            ...(provided.providers === undefined ? {} : { providers: provided.providers }),
            ...(provided.staticArgumentOrigins === undefined
              ? {}
              : { staticArgumentOrigins: provided.staticArgumentOrigins }),
            ...(resultEffect === undefined ? {} : { resultEffect }),
          },
        )
      }
      let scheduledProvided = false
      for (const provided of currentGraph.providedTargets) {
        executionEdges.set(
          `${keyText(provided.owner)}\u0005Provider\u0005${keyText(provided.target)}`,
          {
            _tag: 'ExecutionEdge',
            kind: 'Provider',
            owner: provided.owner,
            target: provided.target,
            ...(provided.providers === undefined ? {} : { providers: provided.providers }),
          },
        )
        for (const ownerContext of recordedContexts.get(keyText(provided.owner))?.values() ?? []) {
          addCallEdge(provided.owner, provided.target)
          for (const [value, branchHistory] of AncestorHistory.partition(
            histories,
            ownerContext.ancestors,
            recursionFamily(provided.target),
          )) {
            const ancestor = value === undefined ? undefined : ancestorValues.get(value)
            // A cleanup implementation can select another specialization of the same lexical service
            // operation while recursively releasing a field. Admit only targets proved reachable from
            // the providing owner's finite cleanup plan; unrelated provider recursion stays guarded.
            const cleanupRoots = cleanupRootsOf(provided.owner, provided.target)
            const cleanup = cleanupTransition(
              ownerContext.cleanupMeasure,
              provided.target,
              cleanupRoots,
              ancestor?.key,
            )
            const cleanupSpecialization = cleanupPermitsSpecialization(
              ancestor?.key,
              provided.target,
              cleanup,
            )
            if (
              ancestor !== undefined &&
              !sameArguments(ancestor.key, provided.target) &&
              !cleanupSpecialization
            ) {
              const violationKey = `${keyText(provided.owner)}\u0000${keyText(provided.target)}`
              if (!violationKeys.has(violationKey)) {
                violationKeys.add(violationKey)
                violations.push({
                  _tag: 'PolymorphicRecursion',
                  caller: provided.owner,
                  target: provided.target,
                })
              }
              continue
            }
            const item = {
              key: provided.target,
              ...(provided.staticArgumentOrigins === undefined
                ? {}
                : {
                    staticArgumentOrigins: provided.staticArgumentOrigins,
                    selectedBy: provided.owner,
                  }),
              ancestors: successorHistory(branchHistory, { key: provided.target }),
              ...(cleanupSpecialization && cleanup !== undefined
                ? { cleanupMeasure: cleanup }
                : {}),
            }
            if (schedule(item)) scheduledProvided = true
          }
        }
      }
      if (!scheduledProvided) {
        if (!discriminatingGrew && !cycleGrewAfterProjection()) break
        restartDiscovery()
      }
    }
  })
  // Earlier attempts may have analyzed keys the final attempt does not reach.
  const reached = (text: string): boolean => recordedContexts.has(text)
  for (const text of prepared.keys()) if (!reached(text)) prepared.delete(text)
  for (const text of preparedUnavailableOwnership.keys())
    if (!reached(text)) preparedUnavailableOwnership.delete(text)
  for (const text of specializationFailures.keys())
    if (!reached(text)) specializationFailures.delete(text)
  for (const [text, call] of recordedCalls)
    if (!reached(keyText(call.owner))) recordedCalls.delete(text)
  for (const { key, diagnostic, published } of reported) {
    if (!reached(key)) continue
    if (Location.isShared(diagnostic.span)) sharedDiagnostics.push({ key, diagnostic })
    else
      residualizationDiagnostics.set(
        `${published.code}:${published.span.sourceId}:${published.span.start}:${published.span.end}`,
        published,
      )
  }
  // A failure in a shared body is one fact about the application; each call that selects it is a
  // distinct authored mistake, reported at what that call wrote.
  for (const { key, diagnostic } of sharedDiagnostics) {
    const written = writtenSelections(key)
    for (const located of written.length === 0
      ? [diagnostic]
      : written.map((origins) => ({
          ...diagnostic,
          span: Location.substitute(diagnostic.span, origins),
        }))) {
      const published = Diagnostic.publish(located, registry)
      residualizationDiagnostics.set(
        `${published.code}:${published.span.sourceId}:${published.span.start}:${published.span.end}`,
        published,
      )
    }
  }
  // Success identities may resolve through another instance's block, so they are traced only once
  // every instance is prepared.
  const preparedInstances = [...prepared.values()].map((candidate) => candidate.instance)
  const instances = trace('Instances.finalizeInstances', () => {
    const instances = [...prepared.values()].map(({ instance, lifetimes }) => {
      const checked = trace(
        'Instances.checkOwnership',
        () =>
          ResidualOwnership.check(
            residualOwnership,
            Ownership.input(
              instance.function,
              instance.view.artifact,
              lifetimes,
              index,
              accessBoundaryPlan,
              contextOf(instance.function),
              instance.view.causes,
            ),
            Residualization.selectionReason(residualization, instance.key) === undefined
              ? 'UnchangedBody'
              : 'SelectedStaticBody',
          ),
        {
          'function.module': instance.key.declaration.module,
          'function.name': instance.key.declaration.name,
        },
      )
      for (const diagnostic of checked.diagnostics)
        residualizationDiagnostics.set(
          `${diagnostic.code}:${diagnostic.span.sourceId}:${diagnostic.span.start}:${diagnostic.span.end}`,
          diagnostic,
        )
      return {
        ...instance,
        effectSuccesses: trace('Instances.resolveEffectSuccesses', () =>
          effectSuccesses(
            instance.function,
            instance.key,
            instance.substitution,
            results,
            index,
            preparedInstances,
          ),
        ),
        ownership: checked.ownership,
      }
    })
    return instances
  })
  const unavailableOwnership = trace('Instances.checkUnavailableOwnership', () => {
    const unavailableOwnership = [...preparedUnavailableOwnership.values()].map((candidate) => {
      const checked = ResidualOwnership.check(
        residualOwnership,
        Ownership.input(
          candidate.function,
          candidate.artifact,
          candidate.lifetimes,
          index,
          accessBoundaryPlan,
          contextOf(candidate.function),
          candidate.causes,
        ),
        Residualization.selectionReason(residualization, candidate.key) === undefined
          ? 'UnchangedBody'
          : 'SelectedStaticBody',
      )
      for (const diagnostic of checked.diagnostics)
        residualizationDiagnostics.set(
          `${diagnostic.code}:${diagnostic.span.sourceId}:${diagnostic.span.start}:${diagnostic.span.end}`,
          diagnostic,
        )
      return {
        _tag: 'UnavailableResidualOwnership' as const,
        key: candidate.key,
        ownership: {
          ...checked.ownership,
          verdict: {
            _tag: 'Unavailable' as const,
            cause: Diagnostic.identity(candidate.diagnostic),
          },
        },
      }
    })
    return unavailableOwnership
  })
  const finalGraph = trace('Instances.buildFinalSuspensionGraph', () =>
    suspensionGraph(instances, results, index, [...recordedCallables.values()]),
  )
  const summaries = trace('Instances.summarizeSuspension', () =>
    ExecutableOrigin.suspensionSummaries(finalGraph),
  )
  const observing = trace('Instances.findObservingExecutions', () =>
    ExecutableOrigin.observingExecutions(finalGraph),
  )
  const effects = trace('Instances.realizeEffects', () =>
    concreteEffects(instances, summaries, results, index, [...recordedCallables.values()]),
  )
  const knownExecutionNodes = new Set([
    ...instances.map((instance) => instanceNode(instance.key)),
    ...effects.map((effect) => effectNode(effect.identity)),
    ...finalGraph.permitted.keys(),
  ])
  const unavailableSummary: SuspensionMode.Summary = {
    _tag: 'SuspensionModeSummary',
    availability: 'Unavailable',
    modes: [],
    causes: [],
  }
  const summaryOfNode = (node: string): SuspensionMode.Summary =>
    summaries.get(node) ?? SuspensionMode.direct
  const nonParkingSummaryOfNode = (node: string): SuspensionMode.Summary =>
    knownExecutionNodes.has(node)
      ? (summaries.get(node) ?? SuspensionMode.direct)
      : unavailableSummary
  const callInstances = [...recordedCalls.values(), ...providerCalls.values()]
  const generatedAggregates = Residualization.generatedAggregates(residualization)
  return {
    _tag: 'InstanceDiscovery',
    retention: retention,
    rootModule,
    declarationIndex: { ...index, generatedAggregates },
    generatedAggregates,
    instances,
    unavailableOwnership,
    callables: [...recordedCallables.values()],
    effects,
    calls: callInstances,
    executionEdges: [...executionEdges.values()].sort((left, right) => {
      const owner = compareInstanceKeys(left.owner, right.owner)
      if (owner !== 0) return owner
      const target = compareInstanceKeys(left.target, right.target)
      return target !== 0 ? target : left.kind.localeCompare(right.kind)
    }),
    intrinsics: ExecutableOrigin.reachableIntrinsics(instances, index),
    foreignCalls: ExecutableOrigin.reachableForeignCalls(instances, index, registry, target),
    foreignExports,
    constants: selectedConstants,
    contextFreeTerminalObservations: finalGraph.contextFreeTerminalObservations,
    observingExecutions: instances
      .filter((instance) => observing.has(instanceNode(instance.key)))
      .map((instance) => instance.key)
      .sort(compareInstanceKeys),
    suspension: [
      ...instances
        .slice()
        .sort((left, right) => compareInstanceKeys(left.key, right.key))
        .flatMap((instance): ReadonlyArray<SuspensionFact> => {
          const execution = summaryOfNode(instanceNode(instance.key))
          const result =
            instance.resultEffect === undefined
              ? SuspensionMode.direct
              : summaryOfNode(effectNode(instance.resultEffect))
          return [
            {
              _tag: 'SuspensionFact',
              subject: { _tag: 'Instance', key: instance.key },
              summary: SuspensionMode.join([execution, result]),
            },
            {
              _tag: 'SuspensionFact',
              subject: { _tag: 'Execution', key: instance.key },
              summary: execution,
            },
          ]
        }),
      ...[...finalGraph.effectIdentities].sort().map((identity): SuspensionFact => ({
        _tag: 'SuspensionFact',
        subject: { _tag: 'Effect', identity },
        summary: summaryOfNode(effectNode(identity)),
      })),
    ],
    nonParkingObligations: finalGraph.nonParkingObligations.map((obligation) => ({
      span: obligation.span,
      summary: nonParkingSummaryOfNode(obligation.node),
    })),
    residualizationDiagnostics: [...residualizationDiagnostics.values()],
    specializationFailures: [...specializationFailures.values()],
    violations: violations,
    counters: {
      _tag: 'InstanceDiscoveryCounters',
      residualBodies: Residualization.counters(residualization),
      residualOwnership: ResidualOwnership.counters(residualOwnership),
      ancestryNodes: histories.nodes.size,
    },
    residualBodies: Residualization.observations(residualization),
    residualOwnership: ResidualOwnership.observations(residualOwnership),
  }
}
