/**
 * The alpha-normalized head of one conformance declaration, together with the two declaration-time
 * questions a conditional conformance has to answer before any proof is attempted: whether two
 * heads may ever name one provider, and whether following a declaration's requirements can only
 * descend.
 *
 * A head is the pair the source writes as `impl<...> Capability<...> for Provider`. Its identity is
 * alpha-invariant: binder spelling and binder declaration order are provenance, so the normalized
 * form renumbers every parameter by first occurrence in the canonical term. Two declarations that
 * differ only in how they spell or order their binders therefore share one key.
 *
 * Overlap is decided here without consulting a single bound. A head that mentions `S: Decoder<S>`
 * and one that mentions `S: Encoder<S>` cover the same providers as far as coherence is concerned,
 * because whether a bound is satisfiable is a property of the whole program and may change as
 * declarations are added. Deciding coherence on shapes alone keeps it stable, and the answer is
 * deliberately biased toward reporting overlap: a shape this module cannot decompose is treated as
 * overlapping, so a false rejection is preferred to a coherence hole.
 *
 * Termination is likewise structural. Every requirement must name a provider that is a strict
 * structural subterm of the head's provider, may not multiply any binder's occurrences, and may not
 * rewrite a ground argument the interface already fixed. Those three conditions make the provider
 * term a well-founded measure, so proof search needs no fuel and no depth limit.
 */
import * as Lifetime from './Lifetime.js'
import * as Type from './Type.js'

/** The canonical owner every normalized head parameter is renumbered under. */
const normalOwner = { module: '', name: 'impl' }

/** The distinct owner the right side of an overlap question is renumbered under. */
const opposingOwner = { module: '', name: 'impl~' }

/** One interface application a conditional conformance must prove before it admits a witness. */
export interface Requirement {
  readonly capability: Type.Nominal
  readonly provider: Type.Type
}

/**
 * One conformance head reduced to its alpha-invariant canonical form.
 *
 * The requirements are renumbered under the same substitution as the head, so a requirement's
 * provider is a term in the head's own vocabulary and the descent check can compare the two
 * directly. Identity ignores them: `key` reads the head alone, because coherence never consults a
 * bound.
 */
export interface ConformanceHead {
  readonly _tag: 'ConformanceHead'
  readonly capability: Type.Nominal
  readonly provider: Type.Type
  readonly parameters: ReadonlyArray<Type.Parameter>
  readonly requirements: ReadonlyArray<Requirement>
}

/** Why following one declared requirement could fail to descend toward a base witness. */
export type TerminationFailure =
  | {
      readonly _tag: 'ProviderNotStrictSubterm'
      readonly requirement: string
      readonly required: string
      readonly provider: string
    }
  | {
      readonly _tag: 'IncreasingVariableOccurrences'
      readonly requirement: string
      readonly variable: string
      readonly declared: number
      readonly required: number
    }
  | {
      readonly _tag: 'ChangedGroundArgument'
      readonly requirement: string
      readonly ordinal: number
      readonly declared: string
      readonly required: string
    }

/**
 * Why a sealed Drop or Copy head would let a region decide which code runs. Such a head may only
 * give every region position its own unbounded binder; then each region pattern of a type matches
 * it alike, and cleanup or copying never depends on which regions a caller supplied.
 */
export type RegionSelection =
  | { readonly _tag: 'StaticRegion' }
  | { readonly _tag: 'RepeatedRegion'; readonly region: string }
  | { readonly _tag: 'BoundedRegion'; readonly parameter: string }
  | { readonly _tag: 'InterfaceBound'; readonly bound: string }

/**
 * Returns every parameter reachable from the supplied terms in first-occurrence order.
 *
 * `Type.parameters` answers the same question as a canonically sorted set, which is the right
 * answer for identity comparisons but the wrong one for renumbering: normalizing by sorted order
 * would make the normal form depend on parameter spelling, which is exactly the provenance the
 * normal form exists to discard.
 */
const occurringParameters = (terms: ReadonlyArray<Type.Type>): ReadonlyArray<Type.Parameter> => {
  const found = new Map<string, Type.Parameter>()
  const expandedBounds = new Set<string>()
  const visit = (term: Type.Type): void => {
    Type.visit(term, (type) => {
      if (!Type.isParameter(type)) return
      const parameterKey = Type.key(type)
      if (!found.has(parameterKey)) found.set(parameterKey, type)
      if (type.representationBound === undefined || expandedBounds.has(parameterKey)) return
      expandedBounds.add(parameterKey)
      visit(type.representationBound)
    })
  }
  for (const term of terms) visit(term)
  return [...found.values()]
}

/** Builds the renumbering that maps each occurring parameter onto its canonical position. */
const normalization = (
  parameters: ReadonlyArray<Type.Parameter>,
  owner: { readonly module: string; readonly name: string },
): {
  readonly substitution: Type.Substitution
  readonly parameters: ReadonlyArray<Type.Parameter>
} => {
  const placeholders = parameters.map((parameter, position) =>
    Type.parameter(owner, position, `%${position}`, parameter.kind),
  )
  const placeholderSubstitution: Type.Substitution = new Map(
    parameters.map((parameter, position) => {
      const replacement = placeholders.at(position)
      if (replacement === undefined) throw new RangeError('Head normalization lost a parameter')
      return [Type.key(parameter), Type.parameterArgument(replacement)] as const
    }),
  )
  // Representation bounds are terms in the same binder vocabulary as the head. Renumbering only
  // the parameter that owns a bound would leave parameters inside `F: fn(T) -> T` carrying their
  // declaration identities, so alpha-renamed headers could appear disjoint. Build placeholders
  // first, then substitute those identities through every bound before publishing the parameters.
  const normalized = parameters.map((parameter, position) => {
    const substitutedBound =
      parameter.representationBound === undefined
        ? undefined
        : Type.substitute(parameter.representationBound, placeholderSubstitution)
    if (
      substitutedBound !== undefined &&
      !Type.isCallable(substitutedBound) &&
      !Type.isEffect(substitutedBound)
    )
      throw new RangeError('Head normalization changed a representation bound kind')
    return Type.parameter(owner, position, `%${position}`, parameter.kind, substitutedBound)
  })
  return {
    substitution: new Map(
      parameters.map((parameter, position) => {
        const replacement = normalized.at(position)
        if (replacement === undefined) throw new RangeError('Head normalization lost a parameter')
        return [Type.key(parameter), Type.parameterArgument(replacement)] as const
      }),
    ),
    parameters: normalized,
  }
}

/** Renumbers one head's binders by first occurrence so alpha-equivalent heads share one identity. */
export const make = (
  capability: Type.Nominal,
  provider: Type.Type,
  requirements: ReadonlyArray<Requirement> = [],
): ConformanceHead => makeUnder(capability, provider, requirements, normalOwner)

const makeUnder = (
  capability: Type.Nominal,
  provider: Type.Type,
  requirements: ReadonlyArray<Requirement>,
  owner: { readonly module: string; readonly name: string },
): ConformanceHead => {
  // The head's own terms are walked first, so a parameter that only a requirement mentions cannot
  // shift the numbering of one the head names — which is what keeps identity independent of bounds.
  const renumbered = normalization(
    occurringParameters([
      capability,
      provider,
      ...requirements.flatMap((requirement) => [requirement.capability, requirement.provider]),
    ]),
    owner,
  )
  const normalizedCapability = Type.substitute(capability, renumbered.substitution)
  if (!Type.isNominal(normalizedCapability))
    throw new RangeError('Head normalization changed the capability kind')
  return {
    _tag: 'ConformanceHead' as const,
    capability: normalizedCapability,
    provider: Type.substitute(provider, renumbered.substitution),
    parameters: renumbered.parameters,
    requirements: requirements.flatMap((requirement): ReadonlyArray<Requirement> => {
      const normalized = Type.substitute(requirement.capability, renumbered.substitution)
      if (!Type.isNominal(normalized)) return []
      return [
        {
          capability: normalized,
          provider: Type.substitute(requirement.provider, renumbered.substitution),
        },
      ]
    }),
  }
}

/** The canonical alpha-invariant identity of one head. */
export const key = (self: ConformanceHead): string =>
  Type.conformanceKey(self.capability, self.provider)

/** Renders one head the way a diagnostic spells it. */
export const encode = (self: ConformanceHead): string =>
  `${Type.encode(self.capability)} for ${Type.encode(self.provider)}`

const resolve = (type: Type.Type, bindings: ReadonlyMap<string, Type.Type>): Type.Type => {
  let current = type
  const seen = new Set<string>()
  while (Type.isParameter(current)) {
    const parameterKey = Type.key(current)
    if (seen.has(parameterKey)) return current
    seen.add(parameterKey)
    const bound = bindings.get(parameterKey)
    if (bound === undefined) return current
    current = bound
  }
  return current
}

/**
 * Applies every binding made so far, repeatedly, until the term names no bound parameter.
 *
 * One pass is not enough: a binding may name a parameter that a later binding resolved, so the
 * occurs check has to see the term as it finally stands. The loop is bounded by the number of
 * bindings because `bind` refuses any binding that would close a cycle, which keeps the map acyclic.
 */
const resolveDeep = (type: Type.Type, bindings: ReadonlyMap<string, Type.Type>): Type.Type => {
  let current = type
  for (let step = 0; step <= bindings.size; step += 1) {
    const next = Type.substitute(current, bindings)
    if (Type.equals(next, current)) return current
    current = next
  }
  return current
}

const occurs = (parameter: Type.Parameter, type: Type.Type): boolean =>
  Type.parameters(type).some((candidate) => Type.key(candidate) === Type.key(parameter))

/**
 * Binds one open parameter, refusing a binding that would only be satisfied by an infinite term.
 *
 * The occurs check runs against the fully resolved term rather than the one written at the call, so
 * a pair of bindings that are each individually harmless cannot together demand an infinite term:
 * `S ~ Wrap<T>` followed by `T ~ Wrap<S>` is refused here rather than left for a later traversal to
 * chase forever. That is the difference between reporting two wrappers disjoint and not terminating.
 */
const bind = (
  parameter: Type.Parameter,
  type: Type.Type,
  bindings: Map<string, Type.Type>,
): boolean => {
  const resolved = resolveDeep(type, bindings)
  if (occurs(parameter, resolved)) return false
  if (parameter.kind === 'CallableRepresentation' || parameter.kind === 'EffectRepresentation')
    return true
  bindings.set(Type.key(parameter), resolved)
  return true
}

/** Alpha-normalizes one representation contract independently of declaration ownership. */
const normalizedRepresentationBound = (
  self: Type.RepresentationBound,
): Type.RepresentationBound => {
  const renumbered = normalization(occurringParameters([self]), normalOwner)
  const normalized = Type.substitute(self, renumbered.substitution)
  if (Type.isCallable(normalized) || Type.isEffect(normalized)) return normalized
  throw new RangeError('Representation-bound normalization changed its kind')
}

/**
 * Reports whether two representation arguments could name one concrete representation.
 *
 * A representation parameter admits every representation its bound admits, so two parameters
 * overlap whenever their bounds intersect and a parameter overlaps an exact argument whenever that
 * argument's contract is admissible at the parameter's bound. `#187` owns both answers.
 */
const representationsMayOverlap = (
  left: Type.RepresentationArgument,
  right: Type.RepresentationArgument,
): boolean => {
  if (Type.representationArgumentKind(left) !== Type.representationArgumentKind(right)) return false
  if (Type.isExactRepresentationArgument(left) && Type.isExactRepresentationArgument(right))
    return isOpenArgument(left) || isOpenArgument(right)
      ? true
      : Type.genericArgumentKey(left) === Type.genericArgumentKey(right)
  if (
    Type.isRepresentationParameterArgument(left) &&
    Type.isRepresentationParameterArgument(right)
  ) {
    const leftBound = left.parameter.representationBound
    const rightBound = right.parameter.representationBound
    if (leftBound === undefined || rightBound === undefined) return true
    // A bound that still mentions a head binder denotes a family of contracts. The representation
    // intersection helper answers exact contract intersection, so using declaration identities
    // here would make two alpha-renamed families look disjoint. If either side is still open, a
    // common admissible concrete contract cannot be disproved and coherence must report overlap.
    if (occurringParameters([leftBound]).length > 0 || occurringParameters([rightBound]).length > 0)
      return true
    return Type.intersectRepresentationBounds(leftBound, rightBound) !== undefined
  }
  const open = Type.isRepresentationParameterArgument(left) ? left : right
  const exact = Type.isExactRepresentationArgument(left) ? left : right
  if (!Type.isRepresentationParameterArgument(open) || !Type.isExactRepresentationArgument(exact))
    return true
  const bound = open.parameter.representationBound
  if (bound === undefined) return true
  // The open and exact contracts came from independently normalized heads, so parameters that
  // occupy the same structural positions still carry opposing owners. Normalize each contract in
  // isolation into one shared vocabulary before asking the directional admissibility question.
  const normalizedBound = normalizedRepresentationBound(bound)
  const normalizedContract = normalizedRepresentationBound(exact.contract)
  // A contract that remains open after alpha-normalization denotes a family. Exact admissibility
  // only answers ground equality, so it cannot prove two such families disjoint; coherence must
  // conservatively keep the overlap until specialization supplies their ordinary binders.
  if (occurringParameters([normalizedBound, normalizedContract]).length > 0) return true
  return (
    Type.representationAdmissibility(normalizedContract, normalizedBound)._tag !== 'Unavailable'
  )
}

/**
 * Reports whether an argument still names a binder, and so stands for more than itself.
 *
 * Canonical keys answer identity, not coverage: two arguments that mention binders live in the two
 * disjoint namespaces this module renumbers into, so their keys can never match even when one
 * instantiation satisfies both. Anything still open is therefore compared by coverage rather than
 * by key, and reports overlap.
 */
const isOpenArgument = (self: Type.GenericArgument): boolean => {
  if (Type.isUnavailableGenericArgument(self)) return true
  if (Type.isTypeArgument(self)) return Type.parameters(self).length > 0
  if (Type.isRepresentationParameterArgument(self)) return true
  if (Type.isExactRepresentationArgument(self)) {
    return Type.parameters(self.contract).length > 0 || isOpenArgument(self.identity)
  }
  if (Type.isCallableIdentityArgument(self)) return self.typeArguments.some(isOpenArgument)
  if (Type.isRequirementRowArgument(self)) {
    return (
      Type.requirementRowParameters(self).length > 0 ||
      Type.requirementMembers(self).some((r) => Type.parameters(r.capability).length > 0)
    )
  }
  return false
}

const unifyArgument = (
  left: Type.GenericArgument,
  right: Type.GenericArgument,
  bindings: Map<string, Type.Type>,
): boolean => {
  // A damaged argument records that a fact was withheld, never that two heads are disjoint.
  if (Type.isUnavailableGenericArgument(left) || Type.isUnavailableGenericArgument(right))
    return true
  if (Type.isTypeArgument(left) && Type.isTypeArgument(right)) return unify(left, right, bindings)
  if (Type.isRepresentationArgument(left) && Type.isRepresentationArgument(right))
    return representationsMayOverlap(left, right)
  if (Type.isRequirementRowArgument(left) && Type.isRequirementRowArgument(right)) {
    if (isOpenArgument(left) || isOpenArgument(right)) return true
    if (Type.requirementMembers(left).length !== Type.requirementMembers(right).length) return false
    return Type.requirementMembers(left).every((requirement, ordinal) => {
      const opposing = Type.requirementMembers(right).at(ordinal)
      // Exclusive requirements accept a shared actual requirement. Therefore access differences
      // cannot prove two closed rows disjoint: both patterns may select the shared form.
      return (
        opposing !== undefined &&
        requirement.role === opposing.role &&
        unify(requirement.capability, opposing.capability, bindings)
      )
    })
  }
  if (Type.isHiddenIdentityArgument(left) && Type.isHiddenIdentityArgument(right)) {
    if (isOpenArgument(left) || isOpenArgument(right)) return true
    return Type.genericArgumentKey(left) === Type.genericArgumentKey(right)
  }
  return false
}

const unify = (
  leftTerm: Type.Type,
  rightTerm: Type.Type,
  bindings: Map<string, Type.Type>,
): boolean => {
  const left = resolve(leftTerm, bindings)
  const right = resolve(rightTerm, bindings)
  if (Type.equals(left, right)) return true
  if (Type.isParameter(left) && Type.isParameter(right)) {
    if (left.kind !== right.kind) return false
    return bind(left, right, bindings)
  }
  if (Type.isParameter(left)) return left.kind === 'Value' && bind(left, right, bindings)
  if (Type.isParameter(right)) return right.kind === 'Value' && bind(right, left, bindings)
  if (Type.isNominal(left) && Type.isNominal(right)) {
    if (
      left.module !== right.module ||
      left.name !== right.name ||
      left.arguments.length !== right.arguments.length
    )
      return false
    return left.arguments.every((argument, ordinal) => {
      const opposing = right.arguments.at(ordinal)
      return opposing !== undefined && unifyArgument(argument, opposing, bindings)
    })
  }
  if (Type.isFixedArray(left) && Type.isFixedArray(right))
    return left.length === right.length && unify(left.element, right.element, bindings)
  if (Type.isSlice(left) && Type.isSlice(right))
    return left.access === right.access && unify(left.element, right.element, bindings)
  if (Type.isReference(left) && Type.isReference(right))
    return left.access === right.access && unify(left.target, right.target, bindings)
  if (Type.isPointer(left) && Type.isPointer(right))
    return left.mutable === right.mutable && unify(left.pointee, right.pointee, bindings)
  if (Type.isForeignFunction(left) && Type.isForeignFunction(right))
    return (
      left.parameters.length === right.parameters.length &&
      left.parameters.every((parameter, ordinal) => {
        const other = right.parameters.at(ordinal)
        return other !== undefined && unify(parameter, other, bindings)
      }) &&
      unify(left.result, right.result, bindings)
    )
  if (Type.isCallable(left) && Type.isCallable(right))
    return (
      left.parameters.length === right.parameters.length &&
      left.parameters.every((parameter, ordinal) => {
        const opposing = right.parameters.at(ordinal)
        return opposing !== undefined && unify(parameter, opposing, bindings)
      }) &&
      unify(left.result, right.result, bindings)
    )
  if (Type.isRepresented(left) && Type.isRepresented(right))
    return representationsMayOverlap(left.representation.argument, right.representation.argument)
  if (Type.isEffect(left) && Type.isEffect(right))
    return (
      unify(left.success, right.success, bindings) &&
      unify(Type.failureType(left), Type.failureType(right), bindings) &&
      unifyArgument(
        Type.requirementRowArgument(
          Type.requirementMembers(left),
          Type.requirementRowParameters(left),
        ),
        Type.requirementRowArgument(
          Type.requirementMembers(right),
          Type.requirementRowParameters(right),
        ),
        bindings,
      )
    )
  // A union has no canonical decomposition into cases, so it cannot be shown disjoint here.
  if (Type.isUnion(left) || Type.isUnion(right)) return true
  return false
}

/**
 * Reports whether two heads may ever name one provider under one interface.
 *
 * Bounds are deliberately not consulted. Two heads whose requirements are mutually exclusive today
 * may both become provable when a later declaration adds a conformance, so a coherence answer that
 * read them would not be stable across an evolving program.
 */
export const mayOverlap = (left: ConformanceHead, right: ConformanceHead): boolean => {
  // Identity is stronger than unifiability. This fast path also keeps alpha-equivalent
  // representation bounds from being reinterpreted under the deliberately distinct opposing
  // binder owner used by the general unifier.
  if (key(left) === key(right)) return true
  const opposing = makeUnder(right.capability, right.provider, [], opposingOwner)
  const bindings = new Map<string, Type.Type>()
  return (
    unify(left.capability, opposing.capability, bindings) &&
    unify(left.provider, opposing.provider, bindings)
  )
}

/**
 * Counts every occurrence of each parameter, with multiplicity, across the supplied terms.
 *
 * The map is keyed by the parameter's canonical identity so two spellings of one binder are counted
 * together, and carries the parameter itself so a diagnostic can name it the way the rest of the
 * head is spelled rather than by that internal identity.
 */
const occurrences = (
  terms: ReadonlyArray<Type.Type>,
): ReadonlyMap<string, { readonly parameter: Type.Parameter; readonly count: number }> => {
  const counts = new Map<string, { readonly parameter: Type.Parameter; readonly count: number }>()
  for (const term of terms)
    for (const parameter of occurringParameters([term])) {
      const parameterKey = Type.key(parameter)
      counts.set(parameterKey, {
        parameter,
        count: (counts.get(parameterKey)?.count ?? 0) + countIn(parameter, term),
      })
    }
  return counts
}

const countIn = (parameter: Type.Parameter, term: Type.Type): number => {
  const target = Type.key(parameter)
  let count = 0
  Type.visit(term, (type) => {
    if (Type.isParameter(type) && Type.key(type) === target) count += 1
  })
  return count
}

/**
 * Reports every way one declaration's requirements could fail to descend toward a base witness.
 *
 * The three conditions together make the head's provider term a well-founded measure. Strict
 * subterm descent bounds the depth of any proof by the size of the concrete provider it starts
 * from; non-increasing occurrences stop a requirement from trading depth for width; and holding
 * ground interface arguments fixed stops a requirement from walking an interface's non-provider
 * arguments while the provider stands still. An empty result is the termination proof itself, so no
 * fuel, depth limit, or configurable budget is needed anywhere downstream.
 */
export const terminationFailures = (self: ConformanceHead): ReadonlyArray<TerminationFailure> => {
  const declaredOccurrences = occurrences([self.capability, self.provider])
  return self.requirements.flatMap((requirement): ReadonlyArray<TerminationFailure> => {
    const spelling = `${Type.encode(requirement.capability)} for ${Type.encode(requirement.provider)}`
    const failures: Array<TerminationFailure> = []
    if (!Type.isStrictStructuralSubterm(requirement.provider, self.provider))
      failures.push({
        _tag: 'ProviderNotStrictSubterm' as const,
        requirement: spelling,
        required: Type.encode(requirement.provider),
        provider: Type.encode(self.provider),
      })
    const requiredOccurrences = occurrences([requirement.capability, requirement.provider])
    for (const [parameterKey, required] of requiredOccurrences) {
      const declared = declaredOccurrences.get(parameterKey)?.count ?? 0
      if (required.count > declared)
        failures.push({
          _tag: 'IncreasingVariableOccurrences' as const,
          requirement: spelling,
          variable: Type.encode(required.parameter),
          declared,
          required: required.count,
        })
    }
    // Only the same interface has positional correspondence to compare. A requirement naming a
    // different interface still descends, because its provider is a strict subterm.
    if (
      requirement.capability.module === self.capability.module &&
      requirement.capability.name === self.capability.name &&
      requirement.capability.arguments.length === self.capability.arguments.length
    )
      for (const [ordinal, declared] of self.capability.arguments.entries()) {
        const required = requirement.capability.arguments.at(ordinal)
        if (required === undefined) continue
        if (!Type.isRuntimeConcreteGenericArgument(declared)) continue
        if (Type.genericArgumentKey(declared) === Type.genericArgumentKey(required)) continue
        failures.push({
          _tag: 'ChangedGroundArgument' as const,
          requirement: spelling,
          ordinal,
          declared: Type.encodeGenericArgument(declared),
          required: Type.encodeGenericArgument(required),
        })
      }
    return failures
  })
}

/** Renders one termination failure as the sentence a diagnostic reports. */
export const describeTermination = (self: TerminationFailure): string => {
  switch (self._tag) {
    case 'ProviderNotStrictSubterm':
      return `requirement ${self.requirement} does not descend: ${self.required} is not a strict subterm of ${self.provider}`
    case 'IncreasingVariableOccurrences':
      return `requirement ${self.requirement} repeats ${self.variable} ${self.required} times where the header uses it ${self.declared}`
    case 'ChangedGroundArgument':
      return `requirement ${self.requirement} rewrites ground argument ${self.ordinal} from ${self.declared} to ${self.required}`
  }
}

/**
 * Returns how a written head selects by region, if it does. `bounded` names the head binders whose
 * region bound the provider's declaration does not imply, and `interfaceBounded` the interface
 * bounds it does not imply, spelled `T: Interface`.
 */
export const regionSelection = (
  capability: Type.Nominal,
  provider: Type.Type,
  bounded: ReadonlyArray<string>,
  interfaceBounded: ReadonlyArray<string>,
): RegionSelection | undefined => {
  const seen = new Set<string>()
  for (const region of [
    ...Type.regionOccurrences(capability),
    ...Type.regionOccurrences(provider),
  ]) {
    if (region._tag === 'StaticLifetime') return { _tag: 'StaticRegion' }
    const regionKey = Lifetime.key(region)
    if (seen.has(regionKey))
      return {
        _tag: 'RepeatedRegion',
        region: region._tag === 'BoundLifetime' ? `'${region.name}` : regionKey,
      }
    seen.add(regionKey)
  }
  const parameter = bounded.at(0)
  if (parameter !== undefined) return { _tag: 'BoundedRegion', parameter }
  const bound = interfaceBounded.at(0)
  return bound === undefined ? undefined : { _tag: 'InterfaceBound', bound }
}

/** Renders one region selection as the clause a diagnostic completes. */
export const describeRegionSelection = (self: RegionSelection): string => {
  switch (self._tag) {
    case 'StaticRegion':
      return "names 'static"
    case 'RepeatedRegion':
      return `names ${self.region} at two positions`
    case 'BoundedRegion':
      return `bounds ${self.parameter} by a region`
    case 'InterfaceBound':
      return `requires ${self.bound}, which a conformance can satisfy for some regions only`
  }
}
