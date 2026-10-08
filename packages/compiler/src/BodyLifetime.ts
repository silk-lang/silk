import type * as AuthoredHir from './AuthoredHir.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as Lifetime from './Lifetime.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'

/** Capture validity recorded at its actual construction, separate from invocation antecedents. */
export interface Formation {
  readonly origin: AuthoredHir.Anchor
  readonly environment: Lifetime.Local
  readonly lifetimeBounds: ReadonlyArray<Lifetime.Outlives>
  readonly typeOutlives: ReadonlyArray<Type.TypeOutlives>
}

/** A declaration-local, finite authored domain shared by annotation and expression inference. */
export interface BodyLifetime {
  readonly owner: Lifetime.Owner
  readonly points: ReadonlyMap<string, number>
  /** Every registered position by its point key, so a solver can walk the whole domain. */
  readonly anchors: ReadonlyMap<string, AuthoredHir.Anchor>
  readonly constraints: Map<string, Lifetime.Outlives>
  readonly formations: Map<string, Formation>
  readonly activatedConstraints: Array<{
    readonly bound: Lifetime.Outlives
    readonly installed: AuthoredHir.Anchor
    readonly owner?: AuthoredHir.Anchor
  }>
  readonly parameterBounds: ReadonlyMap<string, ReadonlyArray<Lifetime.Lifetime>>
  /** Hidden marked-body input antecedents, separate from universal declaration premises. */
  readonly invocationInputs: ReadonlyArray<Type.InvocationInputBound>
  readonly genericStorage: Map<
    string,
    { readonly lifetime: Lifetime.Local; readonly parameter: Type.Parameter }
  >
}

/** Assigns stable preorder points once, in authored traversal order of the supplied anchors. */
export const make = (
  owner: Lifetime.Owner,
  anchors: Iterable<AuthoredHir.Anchor>,
  parameterBounds: ReadonlyMap<string, ReadonlyArray<Lifetime.Lifetime>> = new Map(),
): BodyLifetime => {
  const points = new Map<string, number>()
  const registered = new Map<string, AuthoredHir.Anchor>()
  for (const anchor of anchors) {
    const key = AuthoredIdentity.anchorKey(anchor)
    if (points.has(key)) continue
    points.set(key, points.size)
    registered.set(key, anchor)
  }
  return {
    owner: { ...owner },
    points,
    anchors: registered,
    constraints: new Map(),
    formations: new Map(),
    activatedConstraints: [],
    parameterBounds,
    invocationInputs: [],
    genericStorage: new Map(),
  }
}

/** Installs the exact rebased hidden contract, never an actual invocation certificate. */
export const withInvocationInputs = (
  self: BodyLifetime,
  expected: Type.Callable,
): BodyLifetime | undefined => {
  const inputs = Type.invocationInputBounds(expected)
  if (inputs === undefined) return undefined
  return { ...self, invocationInputs: [...self.invocationInputs, ...inputs] }
}

/** Only the designated exact input subject may shorten its invocation-local validity. */
export const provesInvocationInput = (
  self: BodyLifetime,
  type: Type.Type,
  lifetime: Lifetime.Lifetime,
  assumptions: Lifetime.Assumptions,
): boolean =>
  self.invocationInputs.some(
    (input) =>
      Type.equals(input.type, type) && Lifetime.outlives(assumptions, input.lifetime, lifetime),
  )

/** Allocates an occurrence region only inside the already registered declaration domain. */
export const region = (
  self: BodyLifetime,
  anchor: AuthoredHir.Anchor,
  role: 'Borrow' | 'Annotation' | 'Environment' | 'Call',
  binderOrdinal = 0,
): Lifetime.Local | undefined => {
  const ordinal = self.points.get(AuthoredIdentity.anchorKey(anchor))
  return ordinal === undefined
    ? undefined
    : Lifetime.local(self.owner, `${role}:${binderOrdinal}`, ordinal)
}

/** Creates one body comparison cache; local obligations are retained for its finite region solve. */
export const compatibility = (
  self: BodyLifetime,
  assumptions: Lifetime.Assumptions,
  nominalVariance: ReadonlyMap<string, ReadonlyArray<TypeCompatibility.Variance>> = new Map(),
): TypeCompatibility.Context => {
  const conditionalAssumptions = Lifetime.mergeAssumptions(
    assumptions,
    Lifetime.assumptions(
      self.invocationInputs.flatMap((input) =>
        Type.storageLifetimes(input.type).map((longer) => ({ longer, shorter: input.lifetime })),
      ),
    ),
  )
  const proves = (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime): boolean => {
    if (Lifetime.outlives(conditionalAssumptions, longer, shorter)) return true
    if (
      [...Lifetime.atoms(longer), ...Lifetime.atoms(shorter)].some(
        (member) => member._tag === 'PlaceholderLifetime',
      )
    )
      return false
    if (
      ![...Lifetime.atoms(longer), ...Lifetime.atoms(shorter)].some(
        (member) => member._tag === 'LocalLifetime',
      )
    )
      return false
    return true
  }
  const declaredTypeOutlives = (type: Type.Type, lifetime: Lifetime.Lifetime): boolean => {
    const parameters = Type.storageParameters(type)
    const bounds = parameters.flatMap((parameter) =>
      (self.parameterBounds.get(Type.key(parameter)) ?? []).map((region) => ({
        type: parameter,
        lifetime: region,
      })),
    )
    return Type.satisfiesOutlives(type, lifetime, bounds, (longer, shorter) =>
      Lifetime.outlives(conditionalAssumptions, longer, shorter),
    )
  }
  return TypeCompatibility.context({
    assumptions: conditionalAssumptions,
    invocationInputs: self.invocationInputs,
    nominalVariance,
    outlives: proves,
    commitOutlives: (longer, shorter) => constrain(self, longer, shorter),
    typeOutlives: (type, lifetime) => {
      if (declaredTypeOutlives(type, lifetime)) return true
      if (Lifetime.atoms(lifetime).some((member) => member._tag === 'PlaceholderLifetime'))
        return false
      if (!Type.storageLifetimes(type).every((region) => proves(region, lifetime))) return false
      return true
    },
    commitTypeOutlives: (type, lifetime) => {
      if (declaredTypeOutlives(type, lifetime)) return
      for (const region of Type.storageLifetimes(type)) constrain(self, region, lifetime)
      for (const parameter of Type.storageParameters(type)) {
        if (parameter.staticProperties.includes('Intrinsic.Detached')) continue
        constrain(self, genericRegion(self, parameter), lifetime)
      }
    },
  })
}

const genericRegion = (self: BodyLifetime, parameter: Type.Parameter): Lifetime.Local => {
  const identity = Type.key(parameter)
  const previous = self.genericStorage.get(identity)
  if (previous !== undefined) return previous.lifetime
  const lifetime = Lifetime.local(self.owner, `GenericStorage:${identity}`, 0)
  self.genericStorage.set(identity, { lifetime, parameter })
  return lifetime
}

/** Retains one selected compatibility obligation without starting resolution or code emission. */
export const constrain = (
  self: BodyLifetime,
  longer: Lifetime.Lifetime,
  shorter: Lifetime.Lifetime,
): void => {
  const bound = { longer, shorter }
  const normalized = Lifetime.assumptions([bound])
  self.constraints.set(normalized.key, bound)
}

/** Defers concrete storage obligations until a successful assignment installs its incoming value. */
export const activatedCompatibility = (
  self: BodyLifetime,
  base: TypeCompatibility.Context,
  installed: AuthoredHir.Anchor,
  owner?: AuthoredHir.Anchor,
): TypeCompatibility.Context => {
  const retain = (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime): void => {
    // A caller-owned universal lifetime remains a whole-contract requirement.
    if (shorter._tag !== 'LocalLifetime') {
      base.commitOutlives?.(longer, shorter)
      return
    }
    self.activatedConstraints.push({
      bound: { longer, shorter },
      installed,
      ...(owner === undefined ? {} : { owner }),
    })
  }
  return {
    ...base,
    commitOutlives: retain,
    commitTypeOutlives: (type, lifetime) => {
      for (const region of Type.storageLifetimes(type)) retain(region, lifetime)
      for (const parameter of Type.storageParameters(type)) {
        if (!parameter.staticProperties.includes('Intrinsic.Detached'))
          retain(genericRegion(self, parameter), lifetime)
      }
    },
  }
}

/** Derives environment validity from every retained semantic dependency, including nested views. */
export const environment = (
  self: BodyLifetime | undefined,
  anchor: AuthoredHir.Anchor,
  retained: ReadonlyArray<Type.Type>,
  borrowed: ReadonlyArray<AuthoredHir.Anchor> = [],
): Type.ExecutableLifetimes | undefined => {
  const dependencies: Array<Lifetime.Lifetime> = [
    ...new Map(
      retained.flatMap(Type.storageLifetimes).map((lifetime) => [Lifetime.key(lifetime), lifetime]),
    ).values(),
  ].filter((lifetime) => lifetime._tag !== 'StaticLifetime')
  const retainedParameters = retained
    .flatMap(Type.storageParameters)
    .filter((parameter) => !parameter.staticProperties.includes('Intrinsic.Detached'))
  for (const parameter of retainedParameters) {
    if (self === undefined) return undefined
    const bounds = self.parameterBounds.get(Type.key(parameter)) ?? []
    if (bounds.some((bound) => bound._tag === 'StaticLifetime')) continue
    dependencies.push(genericRegion(self, parameter))
  }
  if (dependencies.length === 0 && borrowed.length === 0)
    return {
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      lifetimeBounds: [],
    }
  if (self === undefined) return undefined
  for (const occurrence of borrowed) {
    const dependency = region(self, occurrence, 'Borrow')
    if (dependency === undefined) return undefined
    dependencies.push(dependency)
  }
  const lifetime = region(self, anchor, 'Environment')
  if (lifetime === undefined) return undefined
  const lifetimeBounds = dependencies.map((longer) => ({ longer, shorter: lifetime }))
  for (const bound of lifetimeBounds) constrain(self, bound.longer, bound.shorter)
  const typeOutlives = retainedParameters.map((type) => ({ type, lifetime }))
  self.formations.set(Lifetime.key(lifetime), {
    origin: anchor,
    environment: lifetime,
    lifetimeBounds,
    typeOutlives,
  })
  return {
    environment: lifetime,
    lifetimeBinders: [],
    lifetimeBounds,
    typeOutlives,
  }
}
