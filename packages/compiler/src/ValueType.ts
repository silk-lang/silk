import type * as ConformanceProof from './ConformanceProof.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type {} from './EntryAssembly.js'
import * as FieldRealization from './FieldRealization.js'
import type {} from './Forwarding.js'
import type { FunctionLowering } from './FunctionLowering.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import type * as Intrinsic from './Intrinsic.js'
import * as EffectExecutionContract from './internal/EffectExecutionContract.js'
import * as Layout from './Layout.js'
import type { ProvidedRequirement } from './Lower.js'
import type {} from './LowerExpression.js'
import * as Mir from './Mir.js'
import * as OpaqueRealization from './OpaqueRealization.js'
import * as Specialization from './Specialization.js'
import * as StaticValue from './StaticValue.js'
import * as Type from './Type.js'

/** One concrete source witness selected before an enclosing Effect block becomes a runner. */
export interface SpecializedWitnessEffectTarget {
  readonly site: Tir.EffectSiteId
  readonly target: ConformanceProof.InterfaceWitnessTarget
}

export interface GeneratedBlockEffectRunner {
  readonly _tag: 'BlockEffectRunner'
  readonly id: DeclarationFacts.CanonicalId
  readonly owner: Instances.Instance
  readonly block: Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }>
  readonly type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>
  readonly specializationKey: string
  readonly providedRequirements: ReadonlyArray<Omit<ProvidedRequirement, 'local'>>
  readonly witnessTargets: ReadonlyArray<SpecializedWitnessEffectTarget>
}

export interface GeneratedWitnessEffectRunner {
  readonly _tag: 'WitnessEffectRunner'
  readonly id: DeclarationFacts.CanonicalId
  readonly owner: Instances.Instance
  readonly expression: Extract<
    Tir.Expression,
    { readonly _tag: 'BuiltinCall' | 'InterfaceOperationCall' }
  >
  readonly target?: ConformanceProof.InterfaceWitnessTarget
  readonly intrinsic?: Intrinsic.Operation
  readonly type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>
  readonly specializationKey: string
  readonly providedRequirements: ReadonlyArray<Omit<ProvidedRequirement, 'local'>>
}

export interface GeneratedBuiltinEffectRunner {
  readonly _tag: 'BuiltinEffectRunner'
  readonly id: DeclarationFacts.CanonicalId
  readonly owner: Instances.Instance
  readonly expression: Extract<Tir.Expression, { readonly _tag: 'BuiltinCall' }>
  readonly type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>
  readonly specializationKey: string
  readonly providedRequirements: ReadonlyArray<Omit<ProvidedRequirement, 'local'>>
}

export interface GeneratedCatchEffectRunner {
  readonly _tag: 'CatchEffectRunner'
  readonly id: DeclarationFacts.CanonicalId
  readonly owner: Instances.Instance
  readonly expression: Extract<Tir.Expression, { readonly _tag: 'EffectCatch' }>
  readonly type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>
  readonly protectedType: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>
  readonly handlerType: Extract<Mir.Type, { readonly _tag: 'CallableValue' }>
  readonly specializationKey: string
  readonly providedRequirements: ReadonlyArray<Omit<ProvidedRequirement, 'local'>>
}

export type GeneratedEffectRunner =
  | GeneratedBlockEffectRunner
  | GeneratedWitnessEffectRunner
  | GeneratedBuiltinEffectRunner
  | GeneratedCatchEffectRunner

export const instanceText = (
  declaration: { readonly module: string; readonly name: string },
  typeArguments: ReadonlyArray<Type.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value> = [],
): string => Specialization.runtimeKey({ declaration, typeArguments, staticArguments })

const runnerSiteKey = (owner: Instances.InstanceKey, site: Tir.EffectSiteId): string =>
  `${instanceText(owner.declaration, owner.typeArguments, owner.staticArguments)}\u0000${Tir.executableSiteKey(site)}`

/** Exact semantic specialization of one generated Effect runner at a physical source site. */
export const baseRunnerKey = (
  owner: Instances.InstanceKey,
  site: Tir.EffectSiteId,
  effect: Type.Effect,
): string => `${runnerSiteKey(owner, site)}\u0000effect:${EffectExecutionContract.key(effect)}`

export const witnessKey = (witness: DeclarationFacts.ConformanceWitness): string =>
  witness._tag === 'SourceConformanceWitness'
    ? `${witness._tag}:${witness.operations
        .map(
          (operation) =>
            `${operation.name}=${instanceText(operation.implementation, witness.typeArguments)}`,
        )
        .join(',')}`
    : `${witness._tag}:${Type.key(witness.provider)}`

export const providedContractEntry = (requirement: Omit<ProvidedRequirement, 'local'>): string =>
  `provided:${Type.key(requirement.capability)}@${requirement.role}:${requirement.requirementAccess}:${requirement.access}:${Type.key(requirement.providerType)}:${requirement.witness._tag}`

// Runner selection compares the requested site against every generated runner's site.
const effectRunnerSiteKeys = new WeakMap<
  Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  string
>()

const effectRunnerSiteKey = (type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>): string => {
  let key = effectRunnerSiteKeys.get(type)
  if (key === undefined) {
    key = runnerSiteKey(
      type.storage?.realization.runnerInstance ?? type.environment.instance,
      type.storage?.realization.site ?? type.site,
    )
    effectRunnerSiteKeys.set(type, key)
  }
  return key
}

const effectRunnerKey = (type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>): string =>
  baseRunnerKey(
    type.storage?.realization.runnerInstance ?? type.environment.instance,
    type.storage?.realization.site ?? type.site,
    type.type,
  )

export const providedRunnerKey = (
  type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  requirements: ReadonlyArray<ProvidedRequirement>,
): string =>
  `${effectRunnerKey(type)}\u0000${requirements
    .map(
      (requirement) =>
        `${Type.key(requirement.capability)}@${requirement.role}:${requirement.requirementAccess}:${requirement.access}:${Type.key(requirement.providerType)}:${witnessKey(requirement.witness)}`,
    )
    .join('\u0000')}`

const providerRequirementSubtractionMatches = (
  candidate: Type.Effect,
  requested: Type.Effect,
  call: Instances.CallInstance,
  provided: ReadonlyArray<ProvidedRequirement>,
): boolean =>
  EffectExecutionContract.providerSubtractionMatches(
    candidate,
    requested,
    provided.filter((selection) =>
      (call.providers ?? []).some(
        (provider) =>
          provider.role === selection.role &&
          Type.equals(provider.capability, selection.capability) &&
          Type.equals(provider.providerType, selection.providerType),
      ),
    ),
  )

type ConcreteEffectEnvironment = Extract<
  Layout.EffectEnvironment,
  { readonly _tag: 'EffectEnvironment' }
>

interface EffectEnvironmentIndex {
  readonly byInstance: ReadonlyMap<string, ReadonlyArray<ConcreteEffectEnvironment>>
  readonly direct: ReadonlyMap<string, ReadonlyArray<ConcreteEffectEnvironment>>
  readonly success: ReadonlyMap<string, ReadonlyArray<ConcreteEffectEnvironment>>
  readonly representation: ReadonlyMap<string, ReadonlyArray<ConcreteEffectEnvironment>>
}

// Every Effect value lowered in the program is resolved against the whole plan's environments;
// each plan list is grouped once, preserving plan order within every group.
const effectEnvironmentIndexCache = new WeakMap<
  ReadonlyArray<Layout.EffectEnvironment>,
  EffectEnvironmentIndex
>()

const effectEnvironmentIndex = (layout: Layout.Plan): EffectEnvironmentIndex => {
  const cached = effectEnvironmentIndexCache.get(layout.effectEnvironments)
  if (cached !== undefined) return cached
  const byInstance = new Map<string, Array<ConcreteEffectEnvironment>>()
  const direct = new Map<string, Array<ConcreteEffectEnvironment>>()
  const success = new Map<string, Array<ConcreteEffectEnvironment>>()
  const representation = new Map<string, Array<ConcreteEffectEnvironment>>()
  const add = (
    groups: Map<string, Array<ConcreteEffectEnvironment>>,
    key: string,
    environment: ConcreteEffectEnvironment,
  ): void => {
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [environment])
    else group.push(environment)
  }
  for (const environment of layout.effectEnvironments) {
    if (environment._tag !== 'EffectEnvironment') continue
    add(byInstance, Instances.keyText(environment.instance), environment)
    add(direct, Instances.effectIdentity(environment.instance, environment.site), environment)
    if (environment.successEffectIdentity !== undefined)
      add(success, environment.successEffectIdentity, environment)
    add(representation, Tir.effectRepresentationIdentity(environment.site), environment)
  }
  const built = { byInstance, direct, success, representation }
  effectEnvironmentIndexCache.set(layout.effectEnvironments, built)
  return built
}

export const effectValueType = (
  layout: Layout.Plan,
  instance: Instances.InstanceKey,
  block: Extract<Tir.Expression, { readonly _tag: 'EffectBlock' }>,
  requested: Type.Effect,
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  // Instance and site already identify exactly one block, so the contract check only has to
  // confirm that this environment is the one the requested type asks for.
  const environment = effectEnvironmentIndex(layout)
    .byInstance.get(Instances.keyText(instance))
    ?.find(
      (candidate) =>
        Tir.sameExecutableSite(candidate.site, block.site) &&
        EffectExecutionContract.realizes(candidate.effect, requested),
    )
  if (environment?._tag !== 'EffectEnvironment') return undefined
  return {
    _tag: 'EffectValue',
    type: requested,
    site: block.site,
    environment,
  }
}

export const effectValueAtSite = (
  layout: Layout.Plan,
  instance: Instances.InstanceKey,
  site: Tir.EffectSiteId,
  requested: Type.Effect,
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  const environment = effectEnvironmentIndex(layout)
    .byInstance.get(Instances.keyText(instance))
    ?.find(
      (candidate) =>
        Tir.sameExecutableSite(candidate.site, site) &&
        EffectExecutionContract.equals(candidate.effect, requested),
    )
  return environment?._tag !== 'EffectEnvironment'
    ? undefined
    : { _tag: 'EffectValue', type: environment.effect, site, environment }
}

const effectEnvironmentsByIdentity = (
  layout: Layout.Plan,
  identity: string,
  owner?: Type.ExecutableSpecializationOwner,
): ReadonlyArray<Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }>> => {
  const index = effectEnvironmentIndex(layout)
  const direct = index.direct.get(identity) ?? []
  const success = index.success.get(identity) ?? []
  const recovered = (index.representation.get(identity) ?? []).filter(
    (candidate) =>
      owner !== undefined &&
      candidate.instance.declaration.module === owner.declaration.module &&
      candidate.instance.declaration.name === owner.declaration.name &&
      sameArguments(candidate.instance.typeArguments, owner.typeArguments) &&
      candidate.instance.staticArguments.length === owner.staticArgumentKeys.length &&
      candidate.instance.staticArguments.every(
        (argument, ordinal) => StaticValue.key(argument) === owner.staticArgumentKeys.at(ordinal),
      ),
  )
  if (direct.length > 0) return direct
  return success.length > 0 ? success : recovered
}

export const effectValueByIdentity = (
  layout: Layout.Plan,
  identity: string,
  requested: Type.Effect | undefined,
  owner?: Type.ExecutableSpecializationOwner,
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  const candidates = effectEnvironmentsByIdentity(layout, identity, owner)
  const matching =
    requested === undefined
      ? candidates
      : candidates.filter((candidate) =>
          EffectExecutionContract.equals(candidate.effect, requested),
        )
  const exact = matching.length === 1 ? matching.at(0) : undefined
  return exact === undefined
    ? undefined
    : {
        _tag: 'EffectValue',
        type: requested ?? exact.effect,
        site: exact.site,
        environment: exact,
      }
}

/** Resolves a contextual Effect result only through its already-selected concrete call edge. */
export const effectValueForCall = (
  layout: Layout.Plan,
  call: Instances.CallInstance,
  requested: Type.Effect,
  provided: ReadonlyArray<ProvidedRequirement> = [],
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  if (call.resultEffect === undefined) return undefined
  const candidates = effectEnvironmentsByIdentity(layout, call.resultEffect)
  const exact = candidates.filter((candidate) => Type.equals(candidate.effect, requested))
  const contextual = candidates.filter(
    (candidate) =>
      EffectExecutionContract.equals(candidate.effect, requested) ||
      providerRequirementSubtractionMatches(candidate.effect, requested, call, provided),
  )
  const selected = exact.length === 1 ? exact : contextual
  const environment = selected.length === 1 ? selected.at(0) : undefined
  return environment === undefined
    ? undefined
    : {
        _tag: 'EffectValue',
        type: requested,
        site: environment.site,
        environment,
      }
}

export const effectCompositeShape = (
  layout: Layout.Plan,
  type: Extract<Mir.Type, { readonly _tag: 'EffectComposite' }>,
): Layout.CallingShape => {
  const shape = Layout.callingShape(layout, type.type)
  if (shape?.tree._tag !== 'EffectCompositeShape')
    throw new RangeError('Effect composite has no canonical calling shape')
  return shape
}

export const callableValueByIdentity = (
  layout: Layout.Plan,
  identity: Type.CallableIdentityArgument,
  type: Type.Callable,
): Extract<Mir.Type, { readonly _tag: 'CallableValue' }> | undefined => {
  const target = Tir.callableTargetFromIdentity(identity.target)
  const environment =
    identity.environment === undefined
      ? undefined
      : layout.callableEnvironments.find(
          (
            candidate,
          ): candidate is Extract<
            Layout.CallableEnvironment,
            { readonly _tag: 'CallableEnvironment' }
          > =>
            candidate._tag === 'CallableEnvironment' &&
            FieldRealization.matchesIdentity(identity, candidate.callable),
        )
  if (identity.environment !== undefined && environment === undefined) return undefined
  const specializedType =
    environment === undefined
      ? { ...type, mode: 'Shared' as const }
      : { ...environment.callable.type, mode: environment.callable.mode }
  return {
    _tag: 'CallableValue',
    type: specializedType,
    target,
    typeArguments: identity.typeArguments,
    ...(environment === undefined ? {} : { site: environment.callable.site, environment }),
  }
}

/** The exact callable a specialized target returns through a structural callable result type. */
export const resultCallableValueType = (
  layout: Layout.Plan,
  instances: ReadonlyArray<Instances.Instance>,
  target: { readonly module: string; readonly name: string },
  typeArguments: ReadonlyArray<Type.GenericArgument>,
  type: Type.Type,
): Extract<Mir.Type, { readonly _tag: 'CallableValue' }> | undefined => {
  const contract = Type.isRepresented(type) ? type.contract : type
  if (!Type.isCallable(contract)) return undefined
  const visible = typeArguments.filter((argument) => !Type.isHiddenExecutableArgument(argument))
  const identities = instances.flatMap((instance) =>
    instance.key.declaration.module === target.module &&
    instance.key.declaration.name === target.name &&
    instance.resultCallable !== undefined &&
    sameArguments(
      instance.key.typeArguments.filter((argument) => !Type.isHiddenExecutableArgument(argument)),
      visible,
    )
      ? [instance.resultCallable]
      : [],
  )
  const identity = identities.at(0)
  return identity === undefined ||
    identities.some((candidate) => !Type.equalsGenericArgument(candidate, identity))
    ? undefined
    : callableValueByIdentity(layout, identity, contract)
}

export const sameArguments = (
  left: ReadonlyArray<Type.GenericArgument>,
  right: ReadonlyArray<Type.GenericArgument>,
): boolean =>
  left.length === right.length &&
  left.every((argument, ordinal) => {
    const candidate = right.at(ordinal)
    return candidate !== undefined && Type.equalsGenericArgument(argument, candidate)
  })

export const representedValueType = (
  layout: Layout.Plan,
  catalog: OpaqueRealization.Catalog,
  type: Type.Type,
  substitution: Type.Substitution,
):
  | Extract<Mir.Type, { readonly _tag: 'CallableValue' | 'EffectValue' | 'EffectComposite' }>
  | undefined => {
  const specialized = Type.substitute(type, substitution)
  if (!Type.isRepresented(specialized)) return undefined
  const representation = specialized.representation.argument
  if (
    Type.isCompositeEffectRepresentationArgument(representation) &&
    Type.isEffect(specialized.contract)
  ) {
    const alternatives = representation.alternatives.flatMap((alternative) =>
      Type.isEffectIdentityArgument(alternative.identity) && Type.isEffect(alternative.contract)
        ? (effectValueByIdentity(
            layout,
            alternative.identity.identity,
            alternative.contract,
            alternative.identity.owner,
          ) ?? [])
        : [],
    )
    return alternatives.length !== representation.alternatives.length
      ? undefined
      : {
          _tag: 'EffectComposite',
          type: specialized,
          contract: specialized.contract,
          alternatives: alternatives,
        }
  }
  if (Type.isExactRepresentationArgument(representation)) {
    if (
      Type.isCallable(specialized.contract) &&
      Type.isCallableIdentityArgument(representation.identity)
    )
      return callableValueByIdentity(layout, representation.identity, specialized.contract)
    if (
      Type.isEffect(specialized.contract) &&
      Type.isEffectIdentityArgument(representation.identity)
    )
      return effectValueByIdentity(
        layout,
        representation.identity.identity,
        specialized.contract,
        representation.identity.owner,
      )
    return undefined
  }
  const opaque = representation
  if (!Type.isOpaqueRepresentationArgument(opaque)) return undefined
  const definition = OpaqueRealization.definitionOf(catalog, opaque)
  if (definition === undefined) return undefined
  const realization = definition.realization
  if (realization?._tag !== 'ExactRepresentationArgument') return undefined
  if (
    Type.isCallable(specialized.contract) &&
    Type.isCallableIdentityArgument(realization.identity)
  ) {
    const identity = realization.identity
    if (identity.environment === undefined)
      return callableValueByIdentity(layout, identity, specialized.contract)
    const environment = layout.callableEnvironments.find(
      (
        candidate,
      ): candidate is Extract<
        Layout.CallableEnvironment,
        { readonly _tag: 'CallableEnvironment' }
      > =>
        candidate._tag === 'CallableEnvironment' &&
        candidate.callable.owner.declaration.module === definition.construction.producer.module &&
        candidate.callable.owner.declaration.name === definition.construction.producer.name &&
        sameArguments(
          candidate.callable.owner.typeArguments.filter(
            (argument) => !Type.isHiddenExecutableArgument(argument),
          ),
          definition.construction.arguments,
        ) &&
        definition.construction.site ===
          Type.callableEnvironmentKey(Instances.callableEnvironmentIdentity(candidate.callable)),
    )
    return environment === undefined
      ? undefined
      : callableValueByIdentity(
          layout,
          Type.callableIdentityArgument(
            identity.identity,
            identity.target,
            identity.typeArguments,
            Instances.callableEnvironmentIdentity(environment.callable),
          ),
          specialized.contract,
        )
  }
  if (Type.isEffect(specialized.contract) && Type.isEffectIdentityArgument(realization.identity)) {
    const environment = layout.effectEnvironments.find(
      (
        candidate,
      ): candidate is Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }> =>
        candidate._tag === 'EffectEnvironment' &&
        candidate.instance.declaration.module === definition.construction.producer.module &&
        candidate.instance.declaration.name === definition.construction.producer.name &&
        sameArguments(
          candidate.instance.typeArguments.filter(
            (argument) => !Type.isHiddenExecutableArgument(argument),
          ),
          definition.construction.arguments,
        ) &&
        definition.construction.site === Tir.effectRepresentationIdentity(candidate.site) &&
        Type.equals(candidate.effect, specialized.contract),
    )
    return environment === undefined
      ? undefined
      : {
          _tag: 'EffectValue',
          type: specialized.contract,
          site: environment.site,
          environment,
        }
  }
  return undefined
}

export const storedCallableValueType = (
  layout: Layout.Plan,
  type: Type.Type,
): Extract<Mir.Type, { readonly _tag: 'CallableValue' }> | undefined => {
  if (!Type.isRepresented(type) || !Type.isCallable(type.contract)) return undefined
  const representation = Layout.entry(layout, type)?.representation
  if (representation?._tag !== 'CallableEnvironment') return undefined
  const realization = representation.realization
  const environment =
    realization.site === undefined
      ? undefined
      : layout.callableEnvironments.find(
          (
            candidate,
          ): candidate is Extract<
            Layout.CallableEnvironment,
            { readonly _tag: 'CallableEnvironment' }
          > =>
            candidate._tag === 'CallableEnvironment' &&
            FieldRealization.matchesCallable(realization, candidate.callable),
        )
  if (realization.site !== undefined && environment === undefined) return undefined
  return {
    _tag: 'CallableValue',
    type: realization.contract,
    target: Tir.callableTargetFromIdentity(realization.target),
    ...(realization.site === undefined ? {} : { site: realization.site }),
    ...(environment === undefined ? {} : { environment }),
    storage: {
      _tag: 'StoredCallableField',
      type,
      realization,
    },
  }
}

export const storedEffectValueType = (
  layout: Layout.Plan,
  type: Type.Type,
): Extract<Mir.Type, { readonly _tag: 'EffectValue' }> | undefined => {
  if (!Type.isRepresented(type) || !Type.isEffect(type.contract)) return undefined
  if (Type.isOpaqueRepresentationArgument(type.representation.argument)) return undefined
  const entry = Layout.entry(layout, type)
  const representation = entry?.representation
  if (entry === undefined || representation?._tag !== 'StoredEffectEnvironment') return undefined
  const realization = representation.realization
  const environment: Extract<Layout.EffectEnvironment, { readonly _tag: 'EffectEnvironment' }> = {
    _tag: 'EffectEnvironment',
    instance: realization.runnerInstance,
    site: realization.site,
    effect: realization.contract,
    fields: representation.fields,
    size: entry.size,
    alignment: entry.alignment,
    tailPadding: representation.tailPadding,
  }
  return {
    _tag: 'EffectValue',
    type: realization.contract,
    site: realization.site,
    environment,
    storage: {
      _tag: 'StoredEffectField',
      type,
      realization,
    },
  }
}

export const requirementsFor = (
  available: ReadonlyArray<ProvidedRequirement>,
  effect: Type.Effect,
): ReadonlyArray<ProvidedRequirement> | undefined => {
  const selected = Type.requirementMembers(effect).map((requirement) => {
    if (!Type.isNominal(requirement.capability)) return undefined
    const compatible = available.filter(
      (candidate) =>
        candidate.role === requirement.role &&
        (requirement.access === 'Shared' ||
          candidate.access === 'Exclusive' ||
          candidate.access === 'Take'),
    )
    const exact = compatible.find((candidate) =>
      Type.equals(candidate.capability, requirement.capability),
    )
    // Discovery shares physical runners across proof-only lifetime substitutions. This
    // boundary only maps already-proved providers, never chooses a source conformance.
    const runtimeKey = Type.runtimeKey(requirement.capability)
    const physical =
      exact === undefined
        ? compatible.filter((candidate) => Type.runtimeKey(candidate.capability) === runtimeKey)
        : []
    const candidate = exact ?? (physical.length === 1 ? physical.at(0) : undefined)
    return candidate === undefined
      ? undefined
      : {
          ...candidate,
          capability: requirement.capability,
          requirementAccess: requirement.access,
        }
  })
  return selected.every((candidate) => candidate !== undefined)
    ? selected.flatMap((candidate) => (candidate === undefined ? [] : [candidate]))
    : undefined
}

export const ensureEffectRunner = (
  fn: FunctionLowering,
  type: Extract<Mir.Type, { readonly _tag: 'EffectValue' }>,
  requirements: ReadonlyArray<ProvidedRequirement>,
): DeclarationFacts.CanonicalId | undefined => {
  const key =
    requirements.length === 0 ? effectRunnerKey(type) : providedRunnerKey(type, requirements)
  const existing = fn.generatedRunners.find((candidate) => candidate.specializationKey === key)
  if (existing !== undefined) return existing.id
  // A caller can precede the source declaration that registers its builtin runner. The
  // layout already selects the physical closure; its canonical base id does not depend on
  // registration order. Provider wrappers still require a concrete base recipe below.
  if (
    requirements.length === 0 &&
    EffectExecutionContract.equals(type.environment.effect, type.type)
  )
    return (
      type.storage?.realization.runner ??
      Tir.effectRunnerId(type.environment.instance.declaration, type.site)
    )
  // Layout entries can differ in caller-local proof evidence while selecting the same
  // physical owner and site. Match that identity and the exact execution channels;
  // concreteSpecialization re-solves provider witnesses from these complete runtime
  // arguments; object identity would reject equivalent contextual specializations.
  const site = effectRunnerSiteKey(type)
  const physical = fn.generatedRunners.filter(
    (candidate) =>
      candidate.providedRequirements.length === 0 &&
      effectRunnerSiteKey(candidate.type) === site &&
      EffectExecutionContract.matches(candidate.type.type, type.type, requirements),
  )
  const base = physical.length === 1 ? physical.at(0) : undefined
  if (base === undefined) return undefined
  if (requirements.length === 0) return base.id
  const id: DeclarationFacts.CanonicalId = {
    _tag: 'CanonicalDeclarationId',
    module: base.id.module,
    name: `${base.id.name}$provided$${fn.generatedRunners.length}`,
  }
  fn.generatedRunners.push({
    ...base,
    id,
    type: base.type,
    specializationKey: key,
    providedRequirements: requirements.map(({ local: _local, ...requirement }) => requirement),
  })
  return id
}

export const runtimeRequirementArguments = (
  requirements: ReadonlyArray<ProvidedRequirement> | undefined,
): ReadonlyArray<Mir.LocalId> =>
  requirements?.flatMap((requirement) =>
    requirement.witness._tag !== 'SourceConformanceWitness' || requirement.local === undefined
      ? []
      : [requirement.local],
  ) ?? []

export const providerBindings = (
  requirements: ReadonlyArray<ProvidedRequirement> | undefined,
): Extract<Mir.Operation, { readonly _tag: 'RunEffectValue' }>['providers'] =>
  requirements?.map((requirement) => ({
    capability: requirement.capability,
    providerType: requirement.providerType,
    witness: requirement.witness,
    role: requirement.role,
    requirementAccess: requirement.requirementAccess,
    access: requirement.access,
    ...(requirement.witness._tag === 'SourceConformanceWitness' && requirement.local !== undefined
      ? { argument: requirement.local }
      : {}),
  })) ?? []

export const sameSite = (left: Tir.CallableSiteId, right: Tir.CallableSiteId): boolean =>
  Tir.sameExecutableSite(left, right)

const recontextualizedCallableEnvironment = (
  fn: FunctionLowering,
  section: Extract<Tir.Expression, { readonly _tag: 'CallableSection' }>,
  type: Type.Callable,
  substitution: Type.Substitution,
  environment: Extract<Layout.CallableEnvironment, { readonly _tag: 'CallableEnvironment' }>,
): Extract<Layout.CallableEnvironment, { readonly _tag: 'CallableEnvironment' }> | undefined => {
  // A second proof context can select the same runtime closure while giving its borrowed captures
  // distinct source lifetimes. Rebind only semantic owner/type facts after proving every runtime
  // type unchanged; physical placement and callable identity stay canonical.
  if (Type.runtimeKey(environment.callable.type) !== Type.runtimeKey(type)) return undefined
  const captureTypes = section.captures.flatMap((capture) =>
    capture.value._tag === 'Unavailable'
      ? []
      : [Type.substitute(fn.semantic(capture.value.type), substitution)],
  )
  if (
    captureTypes.some((capture) => !Type.isRuntimeConcrete(capture)) ||
    captureTypes.length !== environment.callable.captures.length ||
    captureTypes.some((capture, ordinal) => {
      const planned = environment.callable.captures.at(ordinal)
      return planned === undefined || Type.runtimeKey(capture) !== Type.runtimeKey(planned.type)
    })
  )
    return undefined
  const captures = environment.callable.captures.map((capture, ordinal) => ({
    ...capture,
    type: captureTypes.at(ordinal) ?? capture.type,
  }))
  const fields = environment.fields.map((field) => {
    const capture = captures.find((candidate) => candidate.ordinal === field.ordinal)
    return capture === undefined ? field : { ...field, type: capture.type }
  })
  return {
    ...environment,
    callable: {
      ...environment.callable,
      owner: fn.owner.key,
      captureTypes: captureTypes,
      captures: captures,
      type,
      mode: type.mode,
    },
    fields: fields,
  }
}

export const callableValueType = (
  fn: FunctionLowering,
  section: Extract<Tir.Expression, { readonly _tag: 'CallableSection' }>,
  applicationSubstitution: Type.Substitution = new Map(),
): Extract<Mir.Type, { readonly _tag: 'CallableValue' }> | undefined => {
  const substitution = new Map([...section.substitution, ...applicationSubstitution])
  const expected = Type.substitute(fn.semantic(section.type), substitution)
  if (!Type.isCallable(expected)) return undefined
  const identity = Tir.callableEnvironmentIdentity(section.site, {
    declaration: fn.owner.key.declaration,
    typeArguments: fn.owner.key.typeArguments,
    staticArgumentKeys: fn.owner.key.staticArguments.map(StaticValue.key),
  })
  const identityKey = Type.runtimeCallableEnvironmentIdentityKey(identity)
  const candidates = fn.layout.callableEnvironments.filter(
    (
      candidate,
    ): candidate is Extract<Layout.CallableEnvironment, { readonly _tag: 'CallableEnvironment' }> =>
      candidate._tag === 'CallableEnvironment' &&
      Type.runtimeCallableEnvironmentIdentityKey(
        Instances.callableEnvironmentIdentity(candidate.callable),
      ) === identityKey &&
      (!Type.isRuntimeConcrete(expected) ||
        Type.runtimeKey(candidate.callable.type) === Type.runtimeKey(expected)),
  )
  const planned =
    candidates.find(
      (candidate) =>
        !Type.isRuntimeConcrete(expected) || Type.equals(candidate.callable.type, expected),
    ) ?? candidates.at(0)
  const environment =
    planned === undefined ||
    !Type.isRuntimeConcrete(expected) ||
    Type.equals(planned.callable.type, expected)
      ? planned
      : recontextualizedCallableEnvironment(fn, section, expected, substitution, planned)
  if (environment === undefined) {
    return section.captures.length === 0 &&
      Type.isCallable(expected) &&
      Type.isRuntimeConcrete(expected)
      ? {
          _tag: 'CallableValue',
          type: expected,
          target: section.target,
          site: section.site,
          typeArguments: section.typeArguments.map((argument) => fn.semanticArgument(argument)),
        }
      : undefined
  }
  return {
    _tag: 'CallableValue',
    type: environment.callable.type,
    target: environment.callable.target,
    site: section.site,
    environment,
  }
}

/** The environment-bearing value type a staged application builds at its own site. */
export const stagedCallableValueType = (
  fn: FunctionLowering,
  expression: Extract<Tir.Expression, { readonly _tag: 'CallableApply' }>,
  site: Tir.CallableSiteId,
): Extract<Mir.Type, { readonly _tag: 'CallableValue' }> | undefined => {
  const expected = fn.semantic(expression.type)
  const candidates = fn.layout.callableEnvironments.filter(
    (
      candidate,
    ): candidate is Extract<Layout.CallableEnvironment, { readonly _tag: 'CallableEnvironment' }> =>
      candidate._tag === 'CallableEnvironment' &&
      Instances.keyText(candidate.callable.owner) === Instances.keyText(fn.owner.key) &&
      sameSite(candidate.callable.site, site) &&
      (!Type.isRuntimeConcrete(expected) || Type.equals(candidate.callable.type, expected)),
  )
  const environment = candidates.length === 1 ? candidates.at(0) : undefined
  return environment === undefined
    ? undefined
    : {
        _tag: 'CallableValue',
        type: environment.callable.type,
        target: environment.callable.target,
        site,
        environment,
      }
}

export const directCallableSectionValueType = (
  fn: FunctionLowering,
  section: Extract<Tir.Expression, { readonly _tag: 'CallableSection' }>,
  applicationSubstitution: Type.Substitution,
): Extract<Mir.Type, { readonly _tag: 'CallableValue' }> | undefined => {
  // Resolve application arguments before the enclosing instance: an argument may
  // still refer to a captured generic parameter of the anonymous callable.
  const type = fn.semantic(
    Type.substitute(section.type, new Map([...section.substitution, ...applicationSubstitution])),
  )
  return Type.isCallable(type) && Type.isRuntimeConcrete(type)
    ? { _tag: 'CallableValue', type, target: section.target }
    : undefined
}

export const functionItemValueType = (
  fn: FunctionLowering,
  item: Extract<Tir.Expression, { readonly _tag: 'FunctionItem' }>,
  applicationSubstitution: Type.Substitution = new Map(),
): Extract<Mir.Type, { readonly _tag: 'CallableValue' }> | undefined => {
  const type = Type.substitute(
    fn.semantic(item.type),
    applicationSubstitution,
    fn.owner.specialization.compatibility,
  )
  return Type.isCallable(type) && Type.isRuntimeConcrete(type)
    ? {
        _tag: 'CallableValue',
        type,
        target: item.target,
        typeArguments: item.typeArguments.map((argument) => fn.semanticArgument(argument)),
      }
    : undefined
}
