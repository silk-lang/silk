import * as ConformanceGoal from './ConformanceGoal.js'
import * as ResolutionWork from './ResolutionWork.js'
import type * as Constraint from './Constraint.js'
import type {
  CanonicalId,
  CanonicalState,
  ConformanceFact,
  ConformanceWitness,
  ContractFact,
  DeclarationFact,
  FieldFact,
  InterfaceOperationApplicationFact,
  UnionVariantFact,
} from './DeclarationFacts.js'
import { byCanonical, providerOperation } from './DeclarationFacts.js'
import type { Index } from './DeclarationIndex.js'
import { declaredRequirements, memberByNominal } from './DeclarationResolution.js'
import * as Intrinsic from './Intrinsic.js'
import * as TypeInference from './internal/TypeInference.js'
import * as Lifetime from './Lifetime.js'
import * as Specialization from './Specialization.js'
import * as Type from './Type.js'

/** The deterministic result of asking the compiler's one `Copy` authority. */
export type CopyProof =
  | { readonly _tag: 'Copy' }
  | { readonly _tag: 'NotCopy'; readonly reason: string }
  | { readonly _tag: 'UnavailableCopy'; readonly reason: string }

/** Tests whether every value of one concrete type copies freely. */
export const copyType = (
  self: Index,
  type: Type.Type,
  assumptions: ReadonlySet<string> = new Set(),
): boolean => copyProof(self, type, assumptions)._tag === 'Copy'

export const contractByCapability = (
  self: Index,
  capability: Type.Nominal,
): ContractFact | undefined => {
  const declaration = memberByNominal(self.modules, capability)
  return declaration?._tag === 'InterfaceDeclaration' || declaration?._tag === 'ServiceDeclaration'
    ? declaration
    : undefined
}

/** One conformance whose head covers a concrete goal, with the arguments matching it bound. */
interface ConformanceCandidate {
  readonly module: string
  readonly conformance: ConformanceFact
  readonly substitution: Type.Substitution
}

interface IndexedConformance {
  readonly module: string
  readonly conformance: ConformanceFact
}

type ConformanceIndex = ReadonlyMap<string, ReadonlyMap<string, ReadonlyArray<IndexedConformance>>>
// A resolved nominal capability can only match its canonical module and name. Index those
// heads once per immutable module collection, retaining declaration order within each bucket.
// Admission and generic inference still run for each query against its selected candidates.
const conformanceIndices = new WeakMap<Index['modules'], ConformanceIndex>()

const candidatesByCapability = (
  self: Index,
  capability: Type.Nominal,
): ReadonlyArray<IndexedConformance> => {
  let index = conformanceIndices.get(self.modules)
  if (index === undefined) {
    const modules = new Map<string, Map<string, Array<IndexedConformance>>>()
    for (const module of self.modules) {
      for (const conformance of module.conformances) {
        if (
          conformance.capability._tag !== 'Resolved' ||
          !Type.isNominal(conformance.capability.type)
        )
          continue
        const head = conformance.capability.type
        let names = modules.get(head.module)
        if (names === undefined) {
          names = new Map()
          modules.set(head.module, names)
        }
        let entries = names.get(head.name)
        if (entries === undefined) {
          entries = []
          names.set(head.name, entries)
        }
        entries.push({ module: module.module, conformance })
      }
    }
    index = modules
    conformanceIndices.set(self.modules, index)
  }
  return index.get(capability.module)?.get(capability.name) ?? []
}

/** Returns every admitted conformance whose head covers one closed or explicitly symbolic goal. */
export const conformanceCandidates = (
  self: Index,
  goal: ConformanceGoal.ConformanceGoal,
  admission: 'Selectable' | 'Declared' | 'AssumedOpen' = 'Selectable',
): ReadonlyArray<ConformanceCandidate> => {
  const work = ResolutionWork.begin(
    ResolutionWork.ofIndex(self),
    {
      kind: 'ConformanceGoal',
      key: `${admission}:${ConformanceGoal.key(goal)}`,
    },
    'ConformanceDiscovery',
  )
  return candidatesByCapability(self, goal.capability).flatMap(
    ({ module, conformance }): ReadonlyArray<ConformanceCandidate> => {
      ResolutionWork.visit(work)
      if (
        conformance.capability._tag !== 'Resolved' ||
        !Type.isNominal(conformance.capability.type) ||
        conformance.provider._tag !== 'Resolved' ||
        (admission !== 'Declared' && conformance.validity._tag !== 'ValidConformance') ||
        conformance.coherence._tag !== 'Coherent' ||
        conformance.termination._tag !== 'Terminating'
      )
        return []
      const inferred = new Map<string, Type.GenericArgument>()
      const inferHead = (pattern: Type.Type, actual: Type.Type): boolean =>
        admission === 'AssumedOpen'
          ? TypeInference.inferOpenGenericArguments(pattern, actual, inferred).matches
          : TypeInference.infer(pattern, actual, inferred)
      if (!inferHead(conformance.provider.type, goal.provider)) return []
      // The provider may fix a parameter nested in a normalized capability argument (such as
      // E | FixedError). Apply those bindings before matching the second head; comparing the
      // unsubstituted union would reject the same witness when its goal becomes concrete.
      const capabilityPattern = Type.substitute(conformance.capability.type, inferred)
      if (!inferHead(capabilityPattern, goal.capability)) return []
      ResolutionWork.accept(work)
      return [{ module, conformance, substitution: inferred }]
    },
  )
}

const endpointVisible = (
  declaration: { readonly visibility: 'Public' | 'Private'; readonly canonical: CanonicalState },
  requestingModule: string,
): boolean =>
  declaration.visibility === 'Public' ||
  (declaration.canonical._tag === 'Canonical' &&
    declaration.canonical.id.module === requestingModule)

const boundAssumedBy = (
  declaration: DeclarationFact,
  provider: Type.Type,
  capability: Type.Nominal,
): boolean =>
  Type.isParameter(provider) &&
  declaration.typeParameters.some(
    (parameter) =>
      Type.equals(parameter.type, provider) &&
      parameter.bounds.some(
        (bound) =>
          bound._tag === 'ResolvedBound' && Type.equals(bound.application.capability, capability),
      ),
  )

/**
 * Whether one open conditional head follows from admitted witnesses and exact caller bounds.
 *
 * This is symbolic admission, not a proof object: concrete instance discovery still closes the
 * ordinary conformance goal and records the canonical witness tree. Every recursive requirement
 * has a strictly smaller provider, as checked when the conformance was admitted.
 */
const assumedConditionalSelection = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
  assumptions: DeclarationFact,
): ConformanceCandidate | undefined => {
  if (Type.isRuntimeConcrete(provider) && Type.isRuntimeConcrete(capability)) return undefined
  const candidates = conformanceCandidates(
    self,
    ConformanceGoal.make(capability, provider),
    'AssumedOpen',
  )
  if (candidates.length !== 1) return undefined
  const selected = candidates.at(0)
  if (selected === undefined) return undefined
  const requirements = declaredRequirements(self.modules, selected.conformance)
  return requirements.length > 0 &&
    requirements.every((requirement) => {
      const requiredCapability = Type.substitute(requirement.capability, selected.substitution)
      const requiredProvider = Type.substitute(requirement.provider, selected.substitution)
      return (
        Type.isNominal(requiredCapability) &&
        (boundAssumedBy(assumptions, requiredProvider, requiredCapability) ||
          prove(self, requiredProvider, requiredCapability)._tag === 'Proved' ||
          assumedConditionalSelection(self, requiredProvider, requiredCapability, assumptions) !==
            undefined)
      )
    })
    ? selected
    : undefined
}

/** Tests whether exact enclosing interface bounds justify one open conditional conformance. */
export const assumedConditionalConformance = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
  assumptions: DeclarationFact,
): boolean => assumedConditionalSelection(self, provider, capability, assumptions) !== undefined

/** One open source conformance selected only from exact enclosing generic assumptions. */
export interface SymbolicConformanceSelection {
  readonly capability: Type.Nominal
  readonly provider: Type.Type
  readonly selection: Extract<ConformanceGoal.Selection, { readonly _tag: 'SourceSelection' }>
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
}

/** A visible conditional head over one already-known nominal provider. */
export interface ConditionalContractCandidate extends SymbolicConformanceSelection {
  readonly requirements: ReadonlyArray<{
    readonly capability: Type.Nominal
    readonly provider: Type.Type
  }>
}

/**
 * Returns conditional source heads after provider-only specialization.
 *
 * These are deliberately not concrete proof objects: their requirements may mention parameters
 * owned by the enclosing declaration. Call resolution may use them only as symbolic candidates and
 * must discharge every returned requirement from exact caller bounds.
 */
export const conditionalContractCandidates = (
  self: Index,
  requestingModule: string,
  provider: Type.Type,
): ReadonlyArray<ConditionalContractCandidate> => {
  if (!Type.isNominal(provider)) return []
  const providerDeclaration = memberByNominal(self.modules, provider)
  if (providerDeclaration === undefined || !endpointVisible(providerDeclaration, requestingModule))
    return []
  return self.modules.flatMap((module) =>
    module.conformances.flatMap((conformance): ReadonlyArray<ConditionalContractCandidate> => {
      if (
        conformance.validity._tag !== 'ValidConformance' ||
        conformance.coherence._tag !== 'Coherent' ||
        conformance.termination._tag !== 'Terminating' ||
        conformance.capability._tag !== 'Resolved' ||
        !Type.isNominal(conformance.capability.type) ||
        conformance.provider._tag !== 'Resolved'
      )
        return []
      const substitution = new Map<string, Type.GenericArgument>()
      if (!TypeInference.infer(conformance.provider.type, provider, substitution)) return []
      const capability = Type.substitute(conformance.capability.type, substitution)
      if (
        !Type.isNominal(capability) ||
        Type.equals(capability, Type.copyCapability) ||
        Type.equals(capability, Type.dropCapability)
      )
        return []
      const contract = contractByCapability(self, capability)
      if (contract === undefined || !endpointVisible(contract, requestingModule)) return []
      const declared = declaredRequirements(self.modules, conformance)
      const requirements = declared.flatMap((requirement) => {
        const requiredCapability = Type.substitute(requirement.capability, substitution)
        return Type.isNominal(requiredCapability)
          ? [
              {
                capability: requiredCapability,
                provider: Type.substitute(requirement.provider, substitution),
              },
            ]
          : []
      })
      if (requirements.length === 0 || requirements.length !== declared.length) return []
      return [
        {
          capability,
          provider,
          selection: {
            _tag: 'SourceSelection' as const,
            module: module.module,
            ordinal: conformance.ordinal,
          },
          typeArguments: conformance.typeParameters
            .filter((parameter) => parameter.duplicateOf === undefined)
            .map((parameter) => substitution.get(Type.key(parameter.type)) ?? parameter.type),
          requirements: requirements,
        },
      ]
    }),
  )
}

const provedContracts = (
  self: Index,
  requestingModule: string,
  provider: Type.Type,
  requireRuntimeConcrete: boolean,
  assumptions?: DeclarationFact,
): ReadonlyArray<Type.Nominal> => {
  if (!Type.isNominal(provider) || (requireRuntimeConcrete && !Type.isRuntimeConcrete(provider)))
    return []
  const providerDeclaration = memberByNominal(self.modules, provider)
  if (providerDeclaration === undefined || !endpointVisible(providerDeclaration, requestingModule))
    return []

  const implemented = new Map<string, Type.Nominal>()
  for (const headers of self.modules)
    for (const conformance of headers.conformances) {
      if (
        conformance.validity._tag !== 'ValidConformance' ||
        conformance.coherence._tag !== 'Coherent' ||
        conformance.termination._tag !== 'Terminating' ||
        conformance.capability._tag !== 'Resolved' ||
        !Type.isNominal(conformance.capability.type) ||
        conformance.provider._tag !== 'Resolved'
      )
        continue
      const substitution = new Map<string, Type.GenericArgument>()
      if (!TypeInference.infer(conformance.provider.type, provider, substitution)) continue
      const specialized = Type.substitute(conformance.capability.type, substitution)
      if (
        !Type.isNominal(specialized) ||
        (requireRuntimeConcrete && !Type.isRuntimeConcrete(specialized)) ||
        Type.equals(specialized, Type.copyCapability) ||
        Type.equals(specialized, Type.dropCapability)
      )
        continue
      const contract = contractByCapability(self, specialized)
      if (contract === undefined || !endpointVisible(contract, requestingModule)) continue
      const proof = prove(self, provider, specialized)
      const concretelySelected =
        proof._tag === 'Proved' &&
        proof.selection._tag === 'SourceSelection' &&
        proof.selection.module === conformance.module &&
        proof.selection.ordinal === conformance.ordinal
      const symbolicallySelected =
        assumptions !== undefined &&
        assumedConditionalConformance(self, provider, specialized, assumptions) &&
        conformanceCandidates(
          self,
          ConformanceGoal.make(specialized, provider),
          'AssumedOpen',
        ).some(
          (candidate) =>
            candidate.module === conformance.module &&
            candidate.conformance.ordinal === conformance.ordinal,
        )
      if (!concretelySelected && !symbolicallySelected) continue
      implemented.set(Type.key(specialized), specialized)
    }
  return [...implemented.entries()]
    .sort(([left], [right]) => {
      if (left < right) {
        return -1
      }
      if (left > right) {
        return 1
      }
      return 0
    })
    .map(([, capability]) => capability)
}

/**
 * Returns the proved, endpoint-visible contracts implemented by one concrete nominal provider.
 *
 * This is the shared authority over the same conformance evidence semantic analysis uses. Merely
 * matching a declared header is insufficient: conditional, invalid, incoherent, and ambiguous
 * conformances are admitted only when the ordinary proof selects that exact source declaration.
 *
 * Receiver-call resolution selects a concrete receiver's interface operations through this query,
 * and completion offers the same set, so the two cannot drift into offering a member the resolver
 * then rejects. Changing this filter therefore changes what compiles, not only what an editor
 * shows. Endpoint visibility is applied to the interface declaration rather than the conformance,
 * because coherence is a whole-program property and a conformance carries no module visibility.
 */
export const implementedContracts = (
  self: Index,
  requestingModule: string,
  provider: Type.Type,
): ReadonlyArray<Type.Nominal> => provedContracts(self, requestingModule, provider, true)

/**
 * Returns proved applications for a provider already fixed relative to one generic call.
 *
 * The provider may retain parameters owned by the enclosing declaration; call inference separately
 * proves that none belong to the call being specialized. This query never enumerates providers and
 * never admits a header that the ordinary conformance proof would reject.
 */
export const knownProviderContracts = (
  self: Index,
  requestingModule: string,
  provider: Type.Type,
  assumptions?: DeclarationFact,
): ReadonlyArray<Type.Nominal> =>
  provedContracts(self, requestingModule, provider, false, assumptions)

const proofMemos = new WeakMap<Index, Map<string, ConformanceGoal.Proof>>()

const provedCopy: CopyProof = { _tag: 'Copy' }

export const copyAssumptions = (conformance: ConformanceFact): ReadonlySet<string> =>
  new Set(
    conformance.requirements.flatMap((requirement) =>
      requirement.capability._tag === 'Resolved' &&
      Type.equals(requirement.capability.type, Type.copyCapability)
        ? [Type.key(requirement.parameter)]
        : [],
    ),
  )

const hasDropConformance = (self: Index, provider: Type.Type): boolean =>
  conformanceCandidates(self, ConformanceGoal.make(Type.dropCapability, provider)).length > 0

/** Reports whether one concrete nominal has exactly one admitted empty `Copy` declaration. */
export const hasCopyDeclaration = (self: Index, provider: Type.Type): boolean =>
  conformanceCandidates(self, ConformanceGoal.make(Type.copyCapability, provider)).length === 1

/**
 * Proves whether one semantic type duplicates without user code or cleanup.
 *
 * Nominal fields never imply the answer on their own: an admitted empty `impl Copy` opens the
 * proof, and every reachable field must then close it. Parameters close only through an explicit
 * `Copy` bound. Cycles and damaged executable representations remain unavailable instead of being
 * guessed affine or Copy.
 */
const copyProofMemos = new WeakMap<Index, Map<string, CopyProof>>()

export const copyProof = (
  self: Index,
  type: Type.Type,
  assumptions: ReadonlySet<string> = new Set(),
  active: ReadonlySet<string> = new Set(),
): CopyProof => {
  // A root proof is a pure function of the immutable index, the type and its Copy assumptions;
  // ownership and body checking ask it for the same few types many thousand times.
  if (active.size !== 0) return proveCopy(self, type, assumptions, active)
  let memo = copyProofMemos.get(self)
  if (memo === undefined) {
    memo = new Map()
    copyProofMemos.set(self, memo)
  }
  const key =
    assumptions.size === 0
      ? Type.key(type)
      : `${Type.key(type)}\u0000${[...assumptions].sort().join('\u0000')}`
  let proof = memo.get(key)
  if (proof === undefined) {
    proof = proveCopy(self, type, assumptions, active)
    memo.set(key, proof)
  }
  return proof
}

const proveCopy = (
  self: Index,
  type: Type.Type,
  assumptions: ReadonlySet<string>,
  active: ReadonlySet<string>,
): CopyProof => {
  if (
    Type.isBuiltin(type) ||
    Type.isString(type) ||
    Type.isNever(type) ||
    Type.equals(type, Type.unit) ||
    Type.isPointer(type) ||
    Type.isForeignFunction(type)
  )
    return provedCopy
  if (Type.isReference(type) || Type.isSlice(type))
    return type.access === 'Shared'
      ? provedCopy
      : { _tag: 'NotCopy', reason: 'exclusive borrows are affine' }
  if (Type.isParameter(type))
    return assumptions.has(Type.key(type))
      ? provedCopy
      : { _tag: 'NotCopy', reason: `${type.name} has no Copy bound` }
  if (Type.isFixedArray(type)) return copyProof(self, type.element, assumptions, active)
  if (Type.isUnion(type)) {
    for (const member of type.members) {
      const proof = copyProof(self, member, assumptions, active)
      if (proof._tag !== 'Copy') return proof
    }
    return provedCopy
  }
  if (Type.isRepresented(type)) {
    const argument = type.representation.argument
    if (Type.isExactRepresentationArgument(argument)) {
      if (Type.isCallable(argument.contract))
        return argument.contract.mode === 'Shared'
          ? provedCopy
          : {
              _tag: 'NotCopy',
              reason: `${argument.contract.mode.toLowerCase()} callable captures are affine`,
            }
      if (Type.isEffect(argument.contract))
        return argument.contract.access === 'Shared'
          ? provedCopy
          : {
              _tag: 'NotCopy',
              reason: `${argument.contract.access.toLowerCase()} Effect captures are affine`,
            }
      return {
        _tag: 'UnavailableCopy',
        reason: 'the executable representation contract is damaged',
      }
    }
    if (Type.isCompositeEffectRepresentationArgument(argument)) {
      for (const alternative of argument.alternatives) {
        if (!Type.isEffect(alternative.contract) || alternative.contract.access !== 'Shared')
          return {
            _tag: 'NotCopy',
            reason: 'a selected Effect alternative has affine captures',
          }
      }
      return provedCopy
    }
    return {
      _tag: 'UnavailableCopy',
      reason: 'executable Copy depends on its concrete realized captures',
    }
  }
  if (Type.isCallable(type) || Type.isEffect(type))
    return {
      _tag: 'UnavailableCopy',
      reason: 'an open executable contract does not identify its captures',
    }
  if (!Type.isNominal(type) || Type.isIntrinsicNominal(type))
    return { _tag: 'NotCopy', reason: `${Type.encode(type)} is compiler-affine` }

  const declaration = byCanonical(self, {
    _tag: 'CanonicalDeclarationId',
    module: type.module,
    name: type.name,
  })
  if (declaration?._tag === 'EnumDeclaration')
    return declaration.validity._tag === 'Valid'
      ? provedCopy
      : {
          _tag: 'UnavailableCopy',
          reason: `scalar enum ${Type.encode(type)} is invalid`,
        }

  const key = Type.key(type)
  if (active.has(key))
    return {
      _tag: 'UnavailableCopy',
      reason: `recursive Copy proof for ${Type.encode(type)}`,
    }
  const candidates = conformanceCandidates(self, ConformanceGoal.make(Type.copyCapability, type))
  const selected = candidates.at(0)
  if (candidates.length !== 1 || selected === undefined)
    return {
      _tag: candidates.length === 0 ? 'NotCopy' : 'UnavailableCopy',
      reason:
        candidates.length === 0
          ? `${Type.encode(type)} has no valid Copy impl`
          : `${Type.encode(type)} has conflicting Copy evidence`,
    }
  if (hasDropConformance(self, type))
    return {
      _tag: 'NotCopy',
      reason: `${Type.encode(type)} also implements Drop`,
    }
  if (declaration?._tag !== 'StructDeclaration' && declaration?._tag !== 'UnionDeclaration')
    return { _tag: 'NotCopy', reason: `${Type.encode(type)} is not an aggregate` }
  if (declaration.dependency._tag === 'Unavailable')
    return {
      _tag: 'UnavailableCopy',
      reason: `stored fields of ${Type.encode(type)} are unavailable`,
    }
  const substitution =
    TypeInference.substitution(
      declaration.typeParameters.map((parameter) => parameter.type),
      type.arguments,
    ) ?? new Map()
  const nestedAssumptions = new Set([...assumptions, ...copyAssumptions(selected.conformance)])
  const nestedActive = new Set(active).add(key)
  const fields: ReadonlyArray<{
    readonly field: FieldFact
    readonly variant?: UnionVariantFact
  }> =
    declaration._tag === 'StructDeclaration'
      ? declaration.fields.map((field) => ({ field }))
      : declaration.variants.flatMap((variant) =>
          variant.fields.map((field) => ({ field, variant })),
        )
  for (const { field, variant } of fields) {
    if (field.declaredType._tag !== 'Resolved')
      return {
        _tag: 'UnavailableCopy',
        reason: `a stored field of ${Type.encode(type)} is unresolved`,
      }
    const fieldType = Type.substitute(field.declaredType.type, substitution)
    const proof = copyProof(self, fieldType, nestedAssumptions, nestedActive)
    if (proof._tag !== 'Copy')
      return {
        ...proof,
        reason: `${variant === undefined ? '' : `variant ${variant.name._tag === 'Present' ? variant.name.spelling : `#${variant.id.ordinal}`} `}field ${field.name._tag === 'Present' ? field.name.spelling : `#${field.id.ordinal}`} (${Type.encode(fieldType)}): ${proof.reason}`,
      }
  }
  return provedCopy
}

const provedGoal = (
  goal: ConformanceGoal.ConformanceGoal,
  selection: ConformanceGoal.Selection,
  typeArguments: ReadonlyArray<Type.GenericArgument>,
  requirements: ReadonlyArray<ConformanceGoal.Proof>,
): ConformanceGoal.Proof => ({
  _tag: 'Proved' as const,
  goal,
  selection,
  typeArguments: [...typeArguments],
  requirements: [...requirements],
})

const unprovedGoal = (
  goal: ConformanceGoal.ConformanceGoal,
  failure: ConformanceGoal.Failure,
  trace: ReadonlyArray<ConformanceGoal.ConformanceGoal>,
): ConformanceGoal.Proof => ({
  _tag: 'Unproved' as const,
  goal,
  failure,
  trace: [...trace],
})

const proveGoal = (
  self: Index,
  goal: ConformanceGoal.ConformanceGoal,
  memo: Map<string, ConformanceGoal.Proof>,
  active: ReadonlyArray<ConformanceGoal.ConformanceGoal>,
): ConformanceGoal.Proof => {
  const goalKey = ConformanceGoal.key(goal)
  const completed = memo.get(goalKey)
  if (completed !== undefined) return completed
  // An in-progress goal cannot satisfy itself. Declaration-time descent already proves the search
  // finite, so reaching this means a fact was damaged; the answer recovers the path rather than
  // admitting a coinductive proof, and is deliberately not remembered.
  if (active.some((entry) => ConformanceGoal.key(entry) === goalKey))
    return unprovedGoal(goal, { _tag: 'ActiveCycle' as const }, active)
  const proof = ((): ConformanceGoal.Proof => {
    if (Type.equals(goal.capability, Type.copyCapability)) {
      const copy = copyProof(self, goal.provider)
      if (copy._tag !== 'Copy')
        return unprovedGoal(
          goal,
          { _tag: 'UnavailableWitness' as const, reason: copy.reason },
          active,
        )
      const candidate = conformanceCandidates(self, goal).at(0)
      return candidate === undefined
        ? provedGoal(goal, { _tag: 'IntrinsicSelection' as const }, [], [])
        : provedGoal(
            goal,
            {
              _tag: 'SourceSelection' as const,
              module: candidate.module,
              ordinal: candidate.conformance.ordinal,
            },
            candidate.conformance.typeParameters
              .filter((parameter) => parameter.duplicateOf === undefined)
              .map(
                (parameter) =>
                  candidate.substitution.get(Type.key(parameter.type)) ?? parameter.type,
              ),
            [],
          )
    }
    if (Type.isNominal(goal.provider)) {
      if (Type.equals(goal.provider, goal.capability))
        return provedGoal(goal, { _tag: 'IdentitySelection' as const }, [], [])
    }
    const matching = conformanceCandidates(self, goal)
    const selected = matching.at(0)
    if (matching.length === 0 || selected === undefined)
      return unprovedGoal(goal, { _tag: 'MissingWitness' as const }, active)
    if (matching.length > 1)
      return unprovedGoal(
        goal,
        { _tag: 'AmbiguousWitness' as const, candidates: matching.length },
        active,
      )
    const nested = [...active, goal]
    const requirements: Array<ConformanceGoal.Proof> = []
    for (const requirement of declaredRequirements(self.modules, selected.conformance)) {
      const capability = Type.substitute(requirement.capability, selected.substitution)
      const provider = Type.substitute(requirement.provider, selected.substitution)
      if (!Type.isNominal(capability))
        return unprovedGoal(
          goal,
          {
            _tag: 'UnavailableWitness' as const,
            reason: 'a declared requirement did not resolve to an interface',
          },
          active,
        )
      const proved = proveGoal(self, ConformanceGoal.make(capability, provider), memo, nested)
      // A failed requirement is reported as itself: the goal that has no witness is the useful
      // one, and the chain that asked for it travels with it.
      if (proved._tag === 'Unproved') return proved
      requirements.push(proved)
    }
    return provedGoal(
      goal,
      {
        _tag: 'SourceSelection' as const,
        module: selected.module,
        ordinal: selected.conformance.ordinal,
      },
      selected.conformance.typeParameters
        .filter((parameter) => parameter.duplicateOf === undefined)
        .map((parameter) => selected.substitution.get(Type.key(parameter.type)) ?? parameter.type),
      requirements,
    )
  })()
  if (proof._tag === 'Proved') memo.set(goalKey, proof)
  return proof
}

/**
 * Proves one concrete conformance goal, following every declared requirement to a base witness.
 *
 * The search is finite without a fuel budget or a depth limit. Declaration-time validation proved
 * that each requirement names a strictly smaller provider, so the chain of goals reachable from one
 * concrete provider is bounded by that provider's own term size.
 */
export const prove = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
): ConformanceGoal.Proof => {
  const remembered = proofMemos.get(self)
  const memo = remembered ?? new Map<string, ConformanceGoal.Proof>()
  if (remembered === undefined) proofMemos.set(self, memo)
  return proveGoal(self, ConformanceGoal.make(capability, provider), memo, [])
}

const interfaceConformance = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
): ConformanceFact | undefined => {
  const proof = prove(self, provider, capability)
  if (proof._tag !== 'Proved' || proof.selection._tag !== 'SourceSelection') return undefined
  return selectedConformance(self, proof.selection)
}

const selectedConformance = (
  self: Index,
  selection: Extract<ConformanceGoal.Selection, { readonly _tag: 'SourceSelection' }>,
): ConformanceFact | undefined =>
  self.modules
    .find((module) => module.module === selection.module)
    ?.conformances.find((conformance) => conformance.ordinal === selection.ordinal)

/** Tests whether one nominal provider has a compiler-shipped or source-declared witness. */
export const conforms = (self: Index, provider: Type.Type, capability: Type.Nominal): boolean => {
  if (Type.equals(capability, Type.copyCapability)) {
    return copyType(self, provider)
  }
  if (contractByCapability(self, capability) !== undefined) {
    return prove(self, provider, capability)._tag === 'Proved'
  }
  return witness(self, provider, capability) !== undefined
}

/**
 * Returns, in declaration order, the operations one interface declares that the provider's selected
 * declared conformance leaves unmapped. Rejected declarations remain visible here only to preserve
 * the most specific diagnostic after selection excludes them. An empty result means the declaration
 * covers the whole contract. A capability that is not an interface, or a provider with no single
 * coherent, terminating declaration, has no partial witness to report and returns nothing.
 */
export const unmappedInterfaceOperations = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
): ReadonlyArray<string> => {
  const interface_ = contractByCapability(self, capability)
  const declared = conformanceCandidates(
    self,
    ConformanceGoal.make(capability, provider),
    'Declared',
  )
  const conformance = declared.length === 1 ? declared.at(0)?.conformance : undefined
  if (interface_ === undefined || conformance === undefined) return []
  const mapped = new Set(
    conformance.operations.flatMap((mapping) =>
      mapping.name._tag === 'Present' ? [mapping.name.spelling] : [],
    ),
  )
  return interface_.operations.flatMap((operation) =>
    operation.name._tag === 'Present' && !mapped.has(operation.name.spelling)
      ? [operation.name.spelling]
      : [],
  )
}

/**
 * Selects the compiler-known operation one provider's interface conformance maps an operation to.
 *
 * An operator on a bound-typed operand needs no witness: its lowering is width-neutral, and the
 * specialized operand type alone selects the concrete instruction. An operation no operator spells
 * has no such lowering, so its call reads the witness the specialization selected — two providers
 * of one interface may map one operation to two unrelated instructions, and only the conformance
 * says which. A provider with no single conformance, or a mapping that is not a two-segment
 * `Intrinsic` path, selects nothing.
 */
export const interfaceOperationIntrinsic = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
  operation: string,
): Intrinsic.Operation | undefined => {
  const mapping = interfaceConformance(self, provider, capability)?.operations.find(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === operation,
  )
  const target = mapping?.target
  if (
    target?._tag !== 'TypePath' ||
    target.segments.length !== 2 ||
    target.segments.at(0)?.spelling !== 'Intrinsic'
  )
    return undefined
  return Intrinsic.findOperation('Intrinsic', target.segments.at(1)?.spelling ?? '')
}

/**
 * Selects the canonical source function that an interface conformance maps one operation to.
 *
 * Nothing is returned when the mapping names a sealed intrinsic instead. Inline implementations
 * are selected by their conformance identity rather than by their synthesized source spelling, so
 * scalar and nominal providers share the same stable lookup.
 */
export const interfaceWitnessImplementation = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
  operation: string,
): CanonicalId | undefined => {
  const conformance = interfaceConformance(self, provider, capability)
  return conformance === undefined
    ? undefined
    : witnessImplementation(self, provider, conformance, operation)
}

const witnessImplementation = (
  self: Index,
  provider: Type.Type,
  conformance: ConformanceFact,
  operation: string,
): CanonicalId | undefined => {
  const mapping = conformance.operations.find(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === operation,
  )
  if (mapping?.form === 'Inline') {
    const declaration = self.modules
      .find((module) => module.module === conformance.module)
      ?.declarations.find(
        (candidate) =>
          candidate.conformanceImplementation?.ordinal === conformance.ordinal &&
          candidate.conformanceImplementation.operation === operation,
      )
    return declaration?.canonical._tag === 'Canonical' ? declaration.canonical.id : undefined
  }
  if (!Type.isNominal(provider)) return undefined
  const target = mapping?.target
  if (
    target?._tag !== 'TypePath' ||
    target.segments.length !== 2 ||
    target.segments.at(0)?.spelling !== provider.name
  )
    return undefined
  const targetName = target.segments.at(1)?.spelling
  const module = self.modules.find((module) => module.module === provider.module)
  const declaration =
    module === undefined || targetName === undefined
      ? undefined
      : providerOperation(module, provider.name, targetName)
  return declaration?.canonical._tag === 'Canonical' ? declaration.canonical.id : undefined
}

/** One source witness together with the arguments its own specialization needs. */
export interface InterfaceWitnessTarget {
  readonly implementation: CanonicalId
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
  /** Exact source declaration selected again for this concrete goal. */
  readonly selection: Extract<ConformanceGoal.Selection, { readonly _tag: 'SourceSelection' }>
  /** Exact concrete specialization of that source declaration. */
  readonly conformanceTypeArguments: ReadonlyArray<Type.GenericArgument>
  /** The concrete provider whose terminating conditional proof selected this target. */
  readonly structuralProvider?: Type.Type
}

const invocationLifetimeSubstitution = (
  mapping: ConformanceFact['operations'][number],
  application: InterfaceOperationApplicationFact | undefined,
  headerSubstitution: Type.Substitution,
  applicationSubstitution: Type.Substitution,
): Type.Substitution | undefined => {
  const contract = mapping.contract
  if (contract === undefined || application === undefined) return new Map()
  const binders = contract.lifetimes.lifetimeBinders
  if (binders.length === 0) return new Map()
  if (contract.operands.length !== application.operands.length) return undefined
  const inferred = new Map(headerSubstitution)
  const lifetimes: TypeInference.LifetimeInference = {
    inferable: new Set(binders.map(Lifetime.key)),
    accepts: (source: Lifetime.Lifetime, target: Lifetime.Lifetime, invariant: boolean) =>
      Lifetime.equals(source, target) && (!invariant || Lifetime.equals(target, source)),
  }
  // This reconstructs invocation binders for an already-proved witness, not a new compatibility
  // check. Admitted application lifetimes can differ from the header's retained proof context.
  // Preserve inferred binders only when every non-lifetime part still has the same runtime shape.
  const inferInvocation = (pattern: Type.Type, actual: Type.Type): boolean =>
    TypeInference.infer(pattern, actual, inferred, lifetimes) ||
    Type.runtimeKey(Type.substitute(pattern, inferred)) === Type.runtimeKey(actual)
  for (const [ordinal, operand] of contract.operands.entries()) {
    const actual = application.operands.at(ordinal)
    if (operand.type._tag !== 'Resolved' || actual?.type._tag !== 'Resolved') return undefined
    if (
      !inferInvocation(
        Type.substitute(operand.type.type, headerSubstitution),
        Type.substitute(actual.type.type, applicationSubstitution),
      )
    )
      return undefined
  }
  if (
    contract.success._tag !== 'Resolved' ||
    application.success._tag !== 'Resolved' ||
    !inferInvocation(
      Type.substitute(contract.success.type, headerSubstitution),
      Type.substitute(application.success.type, applicationSubstitution),
    )
  )
    return undefined
  const substitution = new Map<string, Type.GenericArgument>()
  // A synthesized environment proof can be absent from the implementation's arguments. Only
  // invocation binders forwarded to the selected implementation need a concrete call-site value.
  const forwarded = new Set(
    (mapping.targetArguments ?? []).flatMap(TypeInference.argumentLifetimes).map(Lifetime.key),
  )
  for (const binder of binders) {
    const selected = inferred.get(Lifetime.key(binder))
    if (selected === undefined) {
      if (forwarded.has(Lifetime.key(binder))) return undefined
      continue
    }
    if (!Lifetime.isLifetime(selected)) return undefined
    substitution.set(Lifetime.key(binder), selected)
  }
  return substitution
}

const inferredTargetArguments = (
  conformance: ConformanceFact,
  mapping: ConformanceFact['operations'][number],
  proof: Extract<ConformanceGoal.Proof, { readonly _tag: 'Proved' }>,
  application: InterfaceOperationApplicationFact | undefined,
  applicationSubstitution: Type.Substitution,
): ReadonlyArray<Type.GenericArgument> | undefined => {
  if (mapping.targetArguments === undefined) return undefined
  const headerParameters = conformance.typeParameters
    .filter((parameter) => parameter.duplicateOf === undefined)
    .map((parameter) => parameter.type)
  const headerSubstitution = TypeInference.substitution(headerParameters, proof.typeArguments)
  if (headerSubstitution === undefined) return undefined
  const invocationSubstitution = invocationLifetimeSubstitution(
    mapping,
    application,
    headerSubstitution,
    applicationSubstitution,
  )
  if (invocationSubstitution === undefined) return undefined
  const arguments_ = mapping.targetArguments.map((argument) =>
    Type.substituteGenericArgument(
      Type.substituteGenericArgument(argument, headerSubstitution),
      invocationSubstitution,
    ),
  )
  return arguments_.every(Type.isRuntimeConcreteGenericArgument) ? arguments_ : undefined
}

/**
 * Selects the provider's own function one interface operation maps to, with its type arguments.
 *
 * A conditional conformance's witness is generic in the header's binders, so naming the function is
 * not enough to reach code: the call needs the arguments this specialization bound. They come from
 * the proof rather than from the call site, because the proof is what decided which header covers
 * this provider.
 */
export const interfaceWitnessTarget = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
  operation: string,
  application?: InterfaceOperationApplicationFact,
  applicationSubstitution: Type.Substitution = new Map(),
): InterfaceWitnessTarget | undefined => {
  return selectedInterfaceTarget(
    self,
    prove(self, provider, capability),
    operation,
    application,
    applicationSubstitution,
  )
}

/** Reads an operation target from an existing proof without initiating conformance discovery. */
export const selectedInterfaceTarget = (
  self: Index,
  proof: ConformanceGoal.Proof,
  operation: string,
  application?: InterfaceOperationApplicationFact,
  applicationSubstitution: Type.Substitution = new Map(),
): InterfaceWitnessTarget | undefined => {
  const provider = proof.goal.provider
  if (proof._tag !== 'Proved' || proof.selection._tag !== 'SourceSelection') return undefined
  const conformance = selectedConformance(self, proof.selection)
  if (conformance === undefined) return undefined
  const mapping = conformance.operations.find(
    (candidate) => candidate.name._tag === 'Present' && candidate.name.spelling === operation,
  )
  if (mapping === undefined) return undefined
  const implementation = witnessImplementation(self, provider, conformance, operation)
  const typeArguments = inferredTargetArguments(
    conformance,
    mapping,
    proof,
    application,
    applicationSubstitution,
  )
  if (implementation === undefined || typeArguments === undefined) return undefined
  return {
    implementation,
    typeArguments,
    selection: proof.selection,
    conformanceTypeArguments: proof.typeArguments,
    ...(proof.requirements.length > 0 ? { structuralProvider: provider } : {}),
  }
}

/**
 * Selects every source witness implementation a proved conditional witness rests on.
 *
 * The result is innermost first, deduplicated by concrete implementation specialization, and does
 * not include the root witness. Discovery consumes it independently of the selected operation's
 * body: a declared requirement is part of admitting the witness even when that operation never
 * invokes the required interface itself.
 */
export const witnessDependencyTargets = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
): ReadonlyArray<InterfaceWitnessTarget> => {
  const proof = prove(self, provider, capability)
  if (proof._tag !== 'Proved') return []
  const found = new Map<string, InterfaceWitnessTarget>()
  const visit = (dependency: ConformanceGoal.Proof): void => {
    if (dependency._tag !== 'Proved') return
    for (const requirement of dependency.requirements) visit(requirement)
    if (dependency.selection._tag !== 'SourceSelection') return
    const conformance = selectedConformance(self, dependency.selection)
    if (conformance === undefined) return
    for (const mapping of conformance.operations) {
      if (mapping.name._tag !== 'Present') continue
      const implementation = witnessImplementation(
        self,
        dependency.goal.provider,
        conformance,
        mapping.name.spelling,
      )
      const typeArguments = inferredTargetArguments(
        conformance,
        mapping,
        dependency,
        undefined,
        new Map(),
      )
      if (implementation === undefined || typeArguments === undefined) continue
      const identity = Specialization.key({
        declaration: implementation,
        typeArguments,
      })
      if (!found.has(identity))
        found.set(identity, {
          implementation,
          typeArguments,
          selection: dependency.selection,
          conformanceTypeArguments: dependency.typeArguments,
          structuralProvider: dependency.goal.provider,
        })
    }
  }
  for (const requirement of proof.requirements) visit(requirement)
  return [...found.values()]
}

/** Selects the unique compiler-shipped or source-declared witness for one provider. */
export const witness = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
): ConformanceWitness | undefined => {
  if (!Type.isNominal(provider)) return undefined
  if (Type.equals(provider, capability)) {
    return { _tag: 'IdentityConformanceWitness', capability, provider }
  }
  // Proof selection is the single authority for matching both the provider and capability heads.
  // Repeating only provider inference here would lose capability binders and could select a header
  // whose requirements failed.
  const proof = prove(self, provider, capability)
  if (proof._tag !== 'Proved' || proof.selection._tag !== 'SourceSelection') return undefined
  const conformance = selectedConformance(self, proof.selection)
  if (conformance === undefined) return undefined
  const member = memberByNominal(self.modules, capability)
  const contract =
    member?._tag === 'InterfaceDeclaration' || member?._tag === 'ServiceDeclaration'
      ? member
      : undefined
  const mappedNames = new Set(
    conformance.operations.flatMap((mapping) =>
      mapping.name._tag === 'Present' ? [mapping.name.spelling] : [],
    ),
  )
  const completeContract =
    contract !== undefined &&
    conformance.hook === undefined &&
    mappedNames.size === conformance.operations.length &&
    contract.operations.every(
      (operation) => operation.name._tag === 'Present' && mappedNames.has(operation.name.spelling),
    ) &&
    conformance.operations.length === contract.operations.length
  let operations: readonly Readonly<{ name: string; implementation: CanonicalId }>[]
  if (contract === undefined) {
    operations = []
  } else {
    operations = contract.operations.flatMap((operation) => {
      const name = operation.name._tag === 'Present' ? operation.name.spelling : undefined
      const implementation =
        name === undefined ? undefined : witnessImplementation(self, provider, conformance, name)
      return name === undefined || implementation === undefined
        ? []
        : [
            {
              name,
              implementation,
            },
          ]
    })
  }
  const completeOperationSet =
    contract === undefined || operations.length === contract.operations.length
  return Type.equals(capability, Type.dropCapability) || (completeContract && completeOperationSet)
    ? {
        _tag: 'SourceConformanceWitness',
        module: conformance.module,
        ordinal: conformance.ordinal,
        capability,
        provider,
        operations,
        typeArguments: proof.typeArguments,
      }
    : undefined
}

/** Adapts declaration-owned witnesses into the neutral constraint-solver result domain. */
export const providerMatch = (
  self: Index,
  provider: Type.Type,
  capability: Type.Nominal,
  assumptions?: DeclarationFact,
): Constraint.ConformanceOutcome => {
  const assumed =
    assumptions === undefined
      ? undefined
      : assumedConditionalSelection(self, provider, capability, assumptions)
  if (assumed !== undefined)
    return {
      _tag: 'Unique',
      match: {
        _tag: 'Conformance',
        witness: {
          origin: {
            _tag: 'SourceWitness',
            declaration: {
              module: assumed.module,
              name: `conformance#${assumed.conformance.ordinal}`,
            },
          },
          typeArguments: assumed.conformance.typeParameters
            .filter((parameter) => parameter.duplicateOf === undefined)
            .map(
              (parameter) =>
                assumed.substitution.get(Type.key(parameter.type)) ??
                Type.parameterArgument(parameter.type),
            ),
        },
      },
    }
  const proof = prove(self, provider, capability)
  if (proof._tag === 'Unproved') {
    if (proof.failure._tag === 'MissingWitness') return { _tag: 'NoMatch' }
    if (proof.failure._tag === 'AmbiguousWitness') {
      const goal = ConformanceGoal.make(capability, provider)
      return {
        _tag: 'Ambiguous',
        witnesses: conformanceCandidates(self, goal).map((candidate) => ({
          origin: {
            _tag: 'SourceWitness' as const,
            declaration: {
              module: candidate.module,
              name: `conformance#${candidate.conformance.ordinal}`,
            },
          },
          typeArguments: candidate.conformance.typeParameters
            .filter((parameter) => parameter.duplicateOf === undefined)
            .map(
              (parameter) => candidate.substitution.get(Type.key(parameter.type)) ?? parameter.type,
            ),
        })),
      }
    }
    return {
      _tag: 'Invalid',
      reason:
        proof.failure._tag === 'UnavailableWitness'
          ? proof.failure.reason
          : 'conformance selection reached an active cycle',
    }
  }
  const selected = witness(self, provider, capability)
  if (selected === undefined)
    return {
      _tag: 'Invalid',
      reason: 'the selected conformance does not provide a complete service implementation',
    }
  if (selected._tag === 'IdentityConformanceWitness')
    return {
      _tag: 'Unique',
      match: { _tag: 'Identity' },
    }
  if (selected._tag === 'IntrinsicConformanceWitness')
    return {
      _tag: 'Unique',
      match: {
        _tag: 'Conformance',
        witness: {
          origin: {
            _tag: 'IntrinsicWitness',
            operation: `${Type.key(selected.provider)}=>${Type.key(selected.capability)}`,
          },
          typeArguments: [],
        },
      },
    }
  return {
    _tag: 'Unique',
    match: {
      _tag: 'Conformance',
      witness: {
        origin: {
          _tag: 'SourceWitness',
          declaration: {
            module: selected.module,
            name: `conformance#${selected.ordinal}`,
          },
        },
        typeArguments: selected.typeArguments,
      },
    },
  }
}

/** Selects one mapped source implementation from a declaration-shaped witness. */
export const witnessOperation = (
  self: Extract<ConformanceWitness, { readonly _tag: 'SourceConformanceWitness' }>,
  name: string,
): CanonicalId | undefined =>
  self.operations.find((operation) => operation.name === name)?.implementation
