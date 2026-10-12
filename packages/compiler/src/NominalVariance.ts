import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Lifetime from './Lifetime.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'

/** Validated storage variance, with the finite work which produced it. */
export interface NominalVariance {
  readonly summaries: ReadonlyMap<string, ReadonlyArray<TypeCompatibility.Variance>>
  readonly work: {
    readonly declarations: number
    readonly iterations: number
    readonly typeVisits: number
  }
}

const cache = new WeakMap<ReadonlyArray<DeclarationFacts.ModuleHeaders>, NominalVariance>()
type Variance = TypeCompatibility.Variance

const join = (left: Variance, right: Variance): Variance => {
  if (left === 'Bivariant') return right
  if (right === 'Bivariant' || left === right) return left
  return 'Invariant'
}

const compose = (outer: Variance, inner: Variance): Variance => {
  if (outer === 'Bivariant' || inner === 'Bivariant') return 'Bivariant'
  if (outer === 'Invariant' || inner === 'Invariant') return 'Invariant'
  if (outer === 'Covariant') return inner
  return inner === 'Covariant' ? 'Contravariant' : 'Covariant'
}

/** Computes the least conservative storage summary over the finite declared nominal graph. */
export const derive = (index: DeclarationIndex.Index): NominalVariance => {
  const cached = cache.get(index.modules)
  if (cached !== undefined) return cached
  const declarations: ReadonlyArray<DeclarationFacts.StructFact | DeclarationFacts.UnionFact> =
    index.modules.flatMap((module) => [...module.structs, ...module.unions])
  const summaries = new Map<string, ReadonlyArray<Variance>>()
  // A Slot transfers exclusive access to one raw destination; only its outer access can
  // shorten. Its payload remains invariant, just like the destination of &mut T.
  summaries.set(TypeCompatibility.nominalVarianceKey(Type.slot('never', Lifetime.staticLifetime)), [
    'Covariant',
    'Invariant',
  ])
  const identity = (
    declaration: DeclarationFacts.StructFact | DeclarationFacts.UnionFact,
  ): string | undefined =>
    declaration.canonical._tag === 'Canonical'
      ? TypeCompatibility.nominalVarianceKey(
          Type.nominal(declaration.canonical.id.module, declaration.canonical.id.name),
        )
      : undefined
  for (const declaration of declarations) {
    const name = identity(declaration)
    if (name !== undefined)
      summaries.set(
        name,
        declaration.typeParameters.map(() => 'Bivariant'),
      )
  }
  let changed = true
  let iterations = 0
  let typeVisits = 0
  while (changed) {
    changed = false
    iterations += 1
    for (const declaration of declarations) {
      const name = identity(declaration)
      if (name === undefined) continue
      const parameters = new Map(
        declaration.typeParameters.map((parameter, ordinal) => [Type.key(parameter.type), ordinal]),
      )
      const found: Array<Variance> = declaration.typeParameters.map(() => 'Bivariant')
      const visited = new Set<string>()
      const record = (key: string, variance: Variance): void => {
        const ordinal = parameters.get(key)
        if (ordinal === undefined) return
        found[ordinal] = join(found.at(ordinal) ?? 'Bivariant', variance)
      }
      const visitArgument = (argument: Type.GenericArgument, variance: Variance): void => {
        if (Lifetime.isLifetime(argument)) record(Lifetime.key(argument), variance)
        else if (typeof argument !== 'string' && argument._tag === 'TypeParameter')
          record(Type.key(argument), variance)
        else if (
          Type.isTypeArgument(argument) ||
          (typeof argument !== 'string' && argument._tag === 'RepresentedType')
        )
          visit(argument, variance)
        else if (Type.isRepresentationParameterArgument(argument))
          record(Type.key(argument.parameter), 'Invariant')
        else if (Type.isRepresentationArgument(argument)) {
          visit(argument.contract, 'Invariant')
          if (argument._tag === 'OpaqueRepresentationArgument')
            argument.arguments.forEach((value) => visitArgument(value, 'Invariant'))
        }
      }
      const visit = (type: Type.Type, variance: Variance): void => {
        const key = `${variance}:${Type.key(type)}`
        if (visited.has(key)) return
        visited.add(key)
        typeVisits += 1
        if (typeof type === 'string') return
        if (Type.isParameter(type)) {
          record(Type.key(type), variance)
          return
        }
        if (Type.isString(type)) {
          record(Lifetime.key(type.lifetime), variance)
          return
        }
        if (Type.isReference(type)) {
          record(Lifetime.key(type.lifetime), variance)
          visit(type.target, type.access === 'Exclusive' ? 'Invariant' : variance)
        } else if (Type.isSlice(type)) {
          record(Lifetime.key(type.lifetime), variance)
          visit(type.element, type.access === 'Exclusive' ? 'Invariant' : variance)
        } else if (Type.isPointer(type)) visit(type.pointee, 'Invariant')
        else if (Type.isFixedArray(type)) visit(type.element, variance)
        else if (Type.isNominal(type)) {
          const target = summaries.get(TypeCompatibility.nominalVarianceKey(type))
          type.arguments.forEach((argument, ordinal) =>
            visitArgument(argument, compose(variance, target?.at(ordinal) ?? 'Invariant')),
          )
        } else if (Type.isCallable(type) || Type.isForeignFunction(type)) {
          if (Type.isCallable(type)) record(Lifetime.key(type.environment), variance)
          type.parameters.forEach((parameter) =>
            visit(parameter, compose(variance, 'Contravariant')),
          )
          visit(type.result, variance)
        } else if (Type.isEffect(type)) {
          record(Lifetime.key(type.environment), variance)
          visit(type.success, variance)
          Type.failureMembers(type).forEach((failure) => visit(failure, variance))
          Type.requirementMembers(type).forEach((requirement) =>
            visit(requirement.capability, 'Invariant'),
          )
        } else if (Type.isRepresented(type)) {
          visit(type.contract, variance)
          visitArgument(type.representation.argument, 'Invariant')
        } else if (Type.isUnion(type)) type.members.forEach((member) => visit(member, variance))
      }
      const fields =
        declaration._tag === 'StructDeclaration'
          ? declaration.fields
          : declaration.variants.flatMap((variant) => variant.fields)
      for (const field of fields)
        if (field.declaredType._tag === 'Resolved') visit(field.declaredType.type, 'Covariant')
      const previous = summaries.get(name) ?? []
      const next = found.map((variance, ordinal) =>
        join(previous.at(ordinal) ?? 'Bivariant', variance),
      )
      if (next.some((variance, ordinal) => variance !== previous.at(ordinal))) {
        summaries.set(name, next)
        changed = true
      }
    }
  }
  const result = {
    summaries,
    work: { declarations: declarations.length, iterations, typeVisits },
  }
  cache.set(index.modules, result)
  return result
}
