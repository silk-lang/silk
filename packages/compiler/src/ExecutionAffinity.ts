import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as TypeInference from './internal/TypeInference.js'
import * as Type from './Type.js'

/** The closed execution-domain property published for every semantic value shape. */
export type ExecutionAffinity =
  | { readonly _tag: 'Unrestricted' }
  | {
      readonly _tag: 'ParameterDependent'
      readonly parameters: ReadonlyArray<Type.Parameter>
    }
  | { readonly _tag: 'LocalExecution' }
  | { readonly _tag: 'Unavailable'; readonly causes: ReadonlyArray<Diagnostic.CauseIdentity> }

/** One environment component, optionally retaining a canonical borrow-root dependency. */
export interface Component {
  readonly type?: Type.Type
  readonly root?: Type.Type
  readonly cause?: Diagnostic.CauseIdentity
}

export const unrestricted: Extract<ExecutionAffinity, { readonly _tag: 'Unrestricted' }> = {
  _tag: 'Unrestricted',
}
export const localExecution: Extract<ExecutionAffinity, { readonly _tag: 'LocalExecution' }> = {
  _tag: 'LocalExecution',
}

const diagnosticKey = (identity: Diagnostic.CauseIdentity): string =>
  `${identity.phase}\0${identity.code}\0${Diagnostic.causeLabel(identity)}\0${identity.ordinal}`

const diagnosticLabel = (identity: Diagnostic.CauseIdentity): string =>
  `${identity.phase}:${identity.code}@${Diagnostic.causeLabel(identity)}#${identity.ordinal}`

const distinctCauses = (
  causes: ReadonlyArray<Diagnostic.CauseIdentity>,
): ReadonlyArray<Diagnostic.CauseIdentity> => {
  const seen = new Set<string>()
  return causes.filter((cause) => {
    const key = diagnosticKey(cause)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const parameters = (inputs: ReadonlyArray<Type.Parameter>): ReadonlyArray<Type.Parameter> => {
  const byIdentity = new Map(inputs.map((parameter) => [Type.key(parameter), parameter]))
  return [...byIdentity.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, parameter]) => parameter)
}

/** Joins recursively derived affinities with unavailable and local outcomes taking precedence. */
export const join = (inputs: ReadonlyArray<ExecutionAffinity>): ExecutionAffinity => {
  const hasUnavailable = inputs.some((input) => input._tag === 'Unavailable')
  const causes = distinctCauses(
    inputs.flatMap((input) => (input._tag === 'Unavailable' ? input.causes : [])),
  )
  if (hasUnavailable) return { _tag: 'Unavailable', causes }
  if (inputs.some((input) => input._tag === 'LocalExecution')) return localExecution
  const dependent = parameters(
    inputs.flatMap((input) => (input._tag === 'ParameterDependent' ? input.parameters : [])),
  )
  return dependent.length === 0
    ? unrestricted
    : { _tag: 'ParameterDependent', parameters: dependent }
}

const unavailable = (causes: ReadonlyArray<Diagnostic.CauseIdentity>): ExecutionAffinity => ({
  _tag: 'Unavailable',
  causes: distinctCauses(causes),
})

const declaredCauses = (
  fact: DeclarationFacts.DeclaredTypeFact,
): ReadonlyArray<Diagnostic.CauseIdentity> => {
  const own = 'cause' in fact && fact.cause !== undefined ? [fact.cause] : []
  switch (fact._tag) {
    case 'FixedArray':
      return [...own, ...declaredCauses(fact.element)]
    case 'Slice':
    case 'Reference':
      return [...own, ...declaredCauses(fact._tag === 'Slice' ? fact.element : fact.target)]
    case 'Pointer':
      return [...own, ...declaredCauses(fact.pointee)]
    case 'Callable':
      return [...own, ...fact.parameters.flatMap(declaredCauses), ...declaredCauses(fact.result)]
    case 'Applied':
      return [...own, ...declaredCauses(fact.target), ...fact.arguments.flatMap(declaredCauses)]
    case 'Effect':
      return [
        ...own,
        ...declaredCauses(fact.success),
        ...fact.failures.flatMap(declaredCauses),
        ...fact.requirements.flatMap((requirement) => declaredCauses(requirement.capability)),
      ]
    case 'Union':
      return [...own, ...fact.members.flatMap(declaredCauses)]
    case 'ExactRepresentation':
      return [...own, ...fact.arguments.flatMap(declaredCauses)]
    default:
      return own
  }
}

const ofTypeInner = (
  index: DeclarationIndex.Index,
  type: Type.Type,
  active: ReadonlySet<string>,
): ExecutionAffinity => {
  if (Type.isSharedCore(type) || Type.isExecution(type) || Type.isWake(type)) return localExecution
  if (Type.isParameter(type)) return { _tag: 'ParameterDependent', parameters: [type] }
  if (Type.isFixedArray(type)) return ofTypeInner(index, type.element, active)
  if (Type.isSlice(type)) return ofTypeInner(index, type.element, active)
  if (Type.isReference(type)) return ofTypeInner(index, type.target, active)
  if (Type.isPointer(type)) return ofTypeInner(index, type.pointee, active)
  if (Type.isForeignFunction(type)) return unrestricted
  if (Type.isUnion(type))
    return join(type.members.map((member) => ofTypeInner(index, member, active)))
  // Callable and Effect contracts describe invocation, not the hidden values retained by a
  // concrete environment. Environment components are inspected through `ofEnvironment`.
  if (Type.isCallable(type) || Type.isEffect(type) || Type.isRepresented(type)) return unrestricted
  if (!Type.isNominal(type)) return unrestricted

  if (Type.isIntrinsicNominal(type))
    return join(
      type.arguments.flatMap((argument) =>
        Type.isTypeArgument(argument) ? [ofTypeInner(index, argument, active)] : [],
      ),
    )
  // Declaration identity, rather than the fully specialized type key, is the recursion
  // boundary. A polymorphically recursive declaration can otherwise keep producing larger
  // specializations before the existing semantic diagnostic rejects it.
  const key = `${type.module}\0${type.name}`
  if (active.has(key)) return unrestricted
  const declaration = DeclarationFacts.byCanonical(index, {
    _tag: 'CanonicalDeclarationId',
    module: type.module,
    name: type.name,
  })
  if (
    declaration === undefined ||
    (declaration._tag !== 'StructDeclaration' && declaration._tag !== 'UnionDeclaration')
  )
    return unrestricted
  const substitution =
    TypeInference.substitution(
      declaration.typeParameters.map((parameter) => parameter.type),
      type.arguments,
    ) ?? new Map()
  const next = new Set(active).add(key)
  const declarationFields =
    declaration._tag === 'StructDeclaration'
      ? declaration.fields
      : declaration.variants.flatMap((variant) => variant.fields)
  const fields = declarationFields.map((field): ExecutionAffinity => {
    if (field.declaredType._tag !== 'Resolved')
      return unavailable(declaredCauses(field.declaredType))
    return ofTypeInner(index, Type.substitute(field.declaredType.type, substitution), next)
  })
  if (declaration.dependency._tag === 'Unavailable' && declaration.dependency.cause !== undefined)
    fields.unshift(unavailable([declaration.dependency.cause]))
  return join(fields)
}

const ofTypeCache = new WeakMap<DeclarationIndex.Index, Map<string, ExecutionAffinity>>()

/** Derives affinity from one canonical semantic type. */
export const ofType = (index: DeclarationIndex.Index, type: Type.Type): ExecutionAffinity => {
  let cache = ofTypeCache.get(index)
  if (cache === undefined) {
    cache = new Map()
    ofTypeCache.set(index, cache)
  }
  const key = Type.key(type)
  let affinity = cache.get(key)
  if (affinity === undefined) {
    affinity = ofTypeInner(index, type, new Set())
    cache.set(key, affinity)
  }
  return affinity
}

/** Derives affinity while preserving causal evidence for a damaged declared type. */
export const ofDeclaredType = (
  index: DeclarationIndex.Index,
  fact: DeclarationFacts.DeclaredTypeFact,
): ExecutionAffinity =>
  fact._tag === 'Resolved' ? ofType(index, fact.type) : unavailable(declaredCauses(fact))

/** Joins an exposed reference or view with the canonical root whose loan it retains. */
export const ofBorrow = (
  index: DeclarationIndex.Index,
  exposed: Type.Type,
  root: Type.Type,
): ExecutionAffinity => join([ofType(index, exposed), ofType(index, root)])

/** Derives one callable, Effect, or frame affinity from its concrete retained components. */
export const ofEnvironment = (
  index: DeclarationIndex.Index,
  components: ReadonlyArray<Component>,
): ExecutionAffinity =>
  join(
    components.map((component) => {
      if (component.type === undefined)
        return unavailable(component.cause === undefined ? [] : [component.cause])
      const exposed = ofType(index, component.type)
      return component.root === undefined ? exposed : join([exposed, ofType(index, component.root)])
    }),
  )

/** Deterministic semantic-inspection encoding with no runtime representation data. */
export const encode = (self: ExecutionAffinity): string => {
  switch (self._tag) {
    case 'Unrestricted':
    case 'LocalExecution':
      return self._tag
    case 'ParameterDependent':
      return `ParameterDependent<${self.parameters.map(Type.key).join(',')}>`
    case 'Unavailable':
      return `Unavailable<${self.causes.map(diagnosticLabel).join(',')}>`
  }
}
