import * as ConformanceProof from './ConformanceProof.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as FieldRealization from './FieldRealization.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as TypeInference from './internal/TypeInference.js'
import * as RepresentationField from './RepresentationField.js'
import * as SourceSpan from './SourceSpan.js'
import * as Specialization from './Specialization.js'
import * as Type from './Type.js'

export interface StoredRepresentation {
  readonly path: ReadonlyArray<string>
  readonly contract: Type.RepresentationBound
  readonly open: boolean
}

/** Finds represented storage exclusively through the specialization field-resolution seam. */
export const storedRepresentation = (
  index: DeclarationIndex.Index,
  type: Type.Type,
  kind: 'Callable' | 'Effect',
  seen: ReadonlySet<string> = new Set(),
): StoredRepresentation | undefined => {
  if (Type.isRepresented(type)) {
    if (
      (kind === 'Callable' && !Type.isCallable(type.contract)) ||
      (kind === 'Effect' && !Type.isEffect(type.contract))
    )
      return undefined
    return {
      path: [],
      contract: type.contract,
      open: Type.isRepresentationParameterArgument(type.representation.argument),
    }
  }
  if (Type.isFixedArray(type) || Type.isSlice(type))
    return storedRepresentation(index, type.element, kind, seen)
  if (Type.isUnion(type)) {
    for (const member of type.members) {
      const found = storedRepresentation(index, member, kind, seen)
      if (found !== undefined) return found
    }
    return undefined
  }
  if (!Type.isNominal(type) || Type.isIntrinsicNominal(type)) return undefined
  const typeKey = Type.key(type)
  if (seen.has(typeKey)) return undefined
  const declaration = DeclarationFacts.byCanonical(index, {
    _tag: 'CanonicalDeclarationId',
    module: type.module,
    name: type.name,
  })
  if (declaration?._tag !== 'StructDeclaration' && declaration?._tag !== 'UnionDeclaration')
    return undefined
  const substitution =
    TypeInference.substitution(
      declaration.typeParameters.map((parameter) => parameter.type),
      type.arguments,
    ) ?? new Map()
  const fieldIndex = RepresentationField.resolveFields(index, [type])
  const plans = RepresentationField.plansOf(index, type)
  const next = new Set(seen).add(typeKey)
  const fields =
    declaration._tag === 'StructDeclaration'
      ? declaration.fields.map((field) => ({ field, prefix: [] }))
      : declaration.variants.flatMap((variant) =>
          variant.fields.map((field) => ({
            field,
            prefix: variant.name._tag === 'Present' ? [variant.name.spelling] : [],
          })),
        )
  for (const { field, prefix } of fields) {
    if (field.declaredType._tag !== 'Resolved' || field.name._tag !== 'Present') continue
    const fieldPlans = plans.filter((candidate) =>
      RepresentationField.belongsTo(candidate.id, field.id),
    )
    for (const plan of fieldPlans) {
      const resolution = RepresentationField.lookup(fieldIndex, type, plan.id)
      if (resolution !== undefined) {
        const contract =
          resolution._tag === 'ResolvedRepresentationField'
            ? resolution.argument.contract
            : resolution.reason.requiredBound
        if (
          (kind === 'Callable' && Type.isCallable(contract)) ||
          (kind === 'Effect' && Type.isEffect(contract))
        )
          return {
            path: [...prefix, field.name.spelling],
            contract,
            open: resolution._tag === 'UnavailableRepresentationField',
          }
      }
    }
    const nested = storedRepresentation(
      index,
      Type.substitute(field.declaredType.type, substitution),
      kind,
      next,
    )
    if (nested !== undefined)
      return {
        path: [...prefix, field.name.spelling, ...nested.path],
        contract: nested.contract,
        open: nested.open,
      }
  }
  return undefined
}

const collectNominals = (
  index: DeclarationIndex.Index,
  type: Type.Type,
  into: Map<string, Type.Nominal>,
  seen: Set<string>,
): void => {
  if (Type.isFixedArray(type) || Type.isSlice(type)) {
    collectNominals(index, type.element, into, seen)
    return
  }
  if (Type.isUnion(type)) {
    for (const member of type.members) collectNominals(index, member, into, seen)
    return
  }
  if (!Type.isNominal(type) || Type.isIntrinsicNominal(type)) return
  const typeKey = Type.key(type)
  if (seen.has(typeKey)) return
  seen.add(typeKey)
  if (!into.has(typeKey) && RepresentationField.plansOf(index, type).length > 0)
    into.set(typeKey, type)
  const declaration = DeclarationFacts.byCanonical(index, {
    _tag: 'CanonicalDeclarationId',
    module: type.module,
    name: type.name,
  })
  if (declaration?._tag !== 'StructDeclaration' && declaration?._tag !== 'UnionDeclaration') return
  const substitution =
    TypeInference.substitution(
      declaration.typeParameters.map((parameter) => parameter.type),
      type.arguments,
    ) ?? new Map()
  const fields =
    declaration._tag === 'StructDeclaration'
      ? declaration.fields
      : declaration.variants.flatMap((variant) => variant.fields)
  for (const field of fields) {
    if (field.declaredType._tag !== 'Resolved') continue
    collectNominals(index, Type.substitute(field.declaredType.type, substitution), into, seen)
  }
}

/** Every reachable nominal carrying a represented field, in deterministic type-key order. */
export const representedNominals = (
  self: Instances.Discovery,
  index: DeclarationIndex.Index,
): ReadonlyArray<Type.Nominal> => {
  const found = new Map<string, Type.Nominal>()
  for (const instance of self.instances) {
    const expressions = instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
    for (const expression of expressions) {
      if (
        expression._tag !== 'Construct' &&
        expression._tag !== 'ConstructUnionVariant' &&
        expression._tag !== 'ArrayConstruct'
      )
        continue
      collectNominals(
        index,
        Specialization.specializeType(instance.key, expression.type, [instance.substitution]),
        found,
        new Set(),
      )
    }
  }
  return [...found.entries()]
    .sort(([left], [right]) => {
      if (left < right) return -1
      if (left > right) return 1
      return 0
    })
    .map(([, nominal]) => nominal)
}

/** Realizes every reachable represented executable field. */
export const callableFieldRealizations = (
  self: Instances.Discovery,
  index: DeclarationIndex.Index,
): FieldRealization.Index =>
  FieldRealization.realize(
    index,
    RepresentationField.resolveFields(index, representedNominals(self, index)),
    self.callables,
    self.effects,
  )

const compareCallSites = (left: Instances.CallInstance, right: Instances.CallInstance): number => {
  if (left.span.sourceId === right.span.sourceId) {
    return left.span.start - right.span.start || left.span.end - right.span.end
  }
  return left.span.sourceId < right.span.sourceId ? -1 : 1
}

interface StoredExecutable {
  readonly path: ReadonlyArray<string>
  readonly contract: Type.RepresentationBound
  readonly represented: boolean
  readonly open: boolean
}

const storedExecutable = (
  index: DeclarationIndex.Index,
  type: Type.Type,
  kind: 'Callable' | 'Effect',
): StoredExecutable | undefined => {
  const bare = DeclarationFacts.storedExecutable(index, type, kind)
  if (bare !== undefined)
    return {
      path: bare.path,
      contract: bare.contract,
      represented: false,
      open: false,
    }
  const represented = storedRepresentation(index, type, kind)
  return represented === undefined
    ? undefined
    : {
        ...represented,
        represented: true,
      }
}

interface StoredExecutableViolationKey {
  readonly aggregate: Type.Type
  readonly path: ReadonlyArray<string>
  readonly contract: Type.RepresentationBound
  readonly represented: boolean
  readonly span: SourceSpan.SourceSpan
  readonly constructionSpan: SourceSpan.SourceSpan
}

const sameStoredExecutableViolationKey = (
  left: StoredExecutableViolationKey,
  right: StoredExecutableViolationKey,
): boolean =>
  Type.equals(left.aggregate, right.aggregate) &&
  left.path.length === right.path.length &&
  left.path.every((part, index) => part === right.path[index]) &&
  Type.equals(left.contract, right.contract) &&
  left.represented === right.represented &&
  SourceSpan.equals(left.span, right.span) &&
  SourceSpan.equals(left.constructionSpan, right.constructionSpan)

/**
 * Rejects reachable constructions that retain bare or represented callable values, then those
 * that retain represented Effect values.
 */
export const storedExecutableViolations = (
  self: Instances.Discovery,
  index: DeclarationIndex.Index,
): ReadonlyArray<Diagnostic.Diagnostic> => {
  const fieldRealizations = callableFieldRealizations(self, index)
  const specializingCalls = new Map<string, Instances.CallInstance>()
  for (const call of self.calls) {
    const target = Instances.keyText(call.target)
    const current = specializingCalls.get(target)
    if (current === undefined || compareCallSites(call, current) < 0)
      specializingCalls.set(target, call)
  }
  const found = {
    Callable: [] as Array<Diagnostic.Diagnostic>,
    Effect: [] as Array<Diagnostic.Diagnostic>,
  }
  const reported = {
    Callable: [] as Array<StoredExecutableViolationKey>,
    Effect: [] as Array<StoredExecutableViolationKey>,
  }
  // Most constructions retain no executable storage, and one aggregate type recurs across many
  // constructions; remember which types were proved free of it.
  const executableFree = { Callable: new Set<string>(), Effect: new Set<string>() }
  const storedExecutableOf = (
    type: Type.Type,
    kind: 'Callable' | 'Effect',
  ): StoredExecutable | undefined => {
    const typeKey = Type.key(type)
    if (executableFree[kind].has(typeKey)) return undefined
    const stored = storedExecutable(index, type, kind)
    if (stored === undefined) executableFree[kind].add(typeKey)
    return stored
  }
  const violation = (
    instance: Instances.Instance,
    expression: Extract<
      Tir.Expression,
      { readonly _tag: 'Construct' | 'ConstructUnionVariant' | 'ArrayConstruct' }
    >,
    aggregate: Type.Type,
    kind: 'Callable' | 'Effect',
  ): Diagnostic.Diagnostic | undefined => {
    const stored = storedExecutableOf(aggregate, kind)
    if (stored === undefined) return undefined
    if (
      stored.represented &&
      Type.isNominal(aggregate) &&
      FieldRealization.supportsInstance(fieldRealizations, aggregate)
    )
      return undefined
    const declared = storedExecutableOf(expression.type, kind)
    const specializing =
      declared === undefined || declared.open
        ? specializingCalls.get(Instances.keyText(instance.key))
        : undefined
    const span = specializing?.span ?? expression.span
    const key: StoredExecutableViolationKey = {
      aggregate,
      path: stored.path,
      contract: stored.contract,
      represented: stored.represented,
      span,
      constructionSpan: expression.span,
    }
    if (reported[kind].some((candidate) => sameStoredExecutableViolationKey(candidate, key)))
      return undefined
    reported[kind].push(key)
    const path = stored.path.length === 0 ? undefined : stored.path.join('.')
    const related = specializing === undefined ? undefined : expression.span
    if (
      (kind === 'Callable' && Type.isCallable(stored.contract)) ||
      (kind === 'Effect' && !stored.represented && Type.isEffect(stored.contract))
    )
      return Diagnostic.storedCallableConstruction(
        Type.encode(aggregate),
        path,
        Type.encode(stored.contract),
        span,
        related,
        stored.represented,
        kind === 'Callable' ? 'callable' : 'Effect',
      )
    if (kind === 'Effect' && Type.isEffect(stored.contract))
      return Diagnostic.storedRepresentedEffectConstruction(
        Type.encode(aggregate),
        path,
        Type.encode(stored.contract),
        span,
        related,
      )
    return undefined
  }
  // One walk serves both kinds: specializing each construction's type dominates the check.
  for (const instance of self.instances)
    for (const expression of instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      if (
        expression._tag !== 'Construct' &&
        expression._tag !== 'ConstructUnionVariant' &&
        expression._tag !== 'ArrayConstruct'
      )
        continue
      const aggregate = Specialization.specializeType(instance.key, expression.type, [
        instance.substitution,
      ])
      for (const kind of ['Callable', 'Effect'] as const) {
        const diagnostic = violation(instance, expression, aggregate, kind)
        if (diagnostic !== undefined) found[kind].push(diagnostic)
      }
    }
  return [...found.Callable, ...found.Effect]
}

/** Rejects reachable Drop-hook instances whose concrete provider is Copy. */
export const copyDropViolations = (
  self: Instances.Discovery,
  index: DeclarationIndex.Index,
  registry: SemanticContext.Registry,
): ReadonlyArray<Diagnostic.Diagnostic> =>
  self.instances.flatMap((instance) => {
    if (!instance.key.declaration.name.startsWith('drop@impl#')) return []
    if (instance.key.typeArguments.length === 0) return []
    const parameter = instance.function.declaration.parameters.at(0)
    if (parameter?.declaredType._tag !== 'Resolved') return []
    const selfType = Type.substitute(
      parameter.declaredType.type,
      instance.substitution,
      instance.specialization.compatibility,
    )
    if (!Type.isReference(selfType)) return []
    return ConformanceProof.copyType(index, selfType.target)
      ? [
          Diagnostic.invalidDropHook(
            `Copy type ${Type.encode(selfType.target)} cannot implement Drop`,
            registry.spanOf(instance.function.declaration.anchor),
          ),
        ]
      : []
  })

/** Rejects concrete requirement bindings whose provider does not implement the capability. */
export const requirementBindingViolations = (
  self: Instances.Discovery,
  index: DeclarationIndex.Index,
): ReadonlyArray<Diagnostic.Diagnostic> =>
  self.instances.flatMap((instance) =>
    Instances.requirementBindings(instance.function).flatMap((binding) => {
      const proof = Instances.requirementSelection(instance, binding.provider)
      const capability = proof?.selected.capability
      const provider =
        proof?.provider ??
        Type.substitute(
          binding.provider.providerType,
          instance.substitution,
          instance.specialization.compatibility,
        )
      if (
        capability !== undefined &&
        Type.isNominal(capability) &&
        ConformanceProof.witness(index, provider, capability) !== undefined
      )
        return []
      return [
        Diagnostic.invalidEffectProvision(
          `provider type ${Type.encode(provider)} does not match ${capability === undefined ? 'one concrete selected requirement' : Type.encode(capability)}`,
          binding.provider.span,
        ),
      ]
    }),
  )

/** Rejects reachable bound calls whose selected witness has no lowerable implementation. */
export const unlowerableWitnessViolations = (
  self: Instances.Discovery,
  index: DeclarationIndex.Index,
): ReadonlyArray<Diagnostic.Diagnostic> =>
  self.instances.flatMap((instance) =>
    instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)
      .flatMap((expression) => {
        if (expression._tag !== 'InterfaceOperationCall') return []
        const capability = Type.substitute(
          expression.capability,
          instance.substitution,
          instance.specialization.compatibility,
        )
        const provider = Type.substitute(
          expression.provider,
          instance.substitution,
          instance.specialization.compatibility,
        )
        if (!Type.isNominal(capability)) return []
        const intrinsic = ConformanceProof.interfaceOperationIntrinsic(
          index,
          provider,
          capability,
          expression.operation,
        )
        const witness = ConformanceProof.interfaceWitnessImplementation(
          index,
          provider,
          capability,
          expression.operation,
        )
        if (intrinsic?.rule._tag === 'BuiltinRule' || witness !== undefined) return []
        return [
          Diagnostic.unlowerableBoundWitness(
            `${capability.name}.${expression.operation}`,
            Type.encode(provider),
            expression.span,
          ),
        ]
      }),
  )

/** Produces semantic diagnostics for every finite-discovery violation. */
export const violationDiagnostics = (
  self: Instances.Discovery,
  registry: SemanticContext.Registry,
): ReadonlyArray<Diagnostic.Diagnostic> => [
  ...self.specializationFailures.map((failure) =>
    Diagnostic.nonConcreteSpecialization(
      `${failure.key.declaration.module}.${failure.key.declaration.name}`,
      failure.span,
    ),
  ),
  ...self.violations.flatMap((violation) => {
    const caller = self.instances.find(
      (instance) => Instances.keyText(instance.key) === Instances.keyText(violation.caller),
    )
    if (caller === undefined) return []
    const callerText = `${violation.caller.declaration.name}<${violation.caller.typeArguments
      .map(Type.encodeGenericArgument)
      .join(', ')}>`
    const targetText = `${violation.target.declaration.name}<${violation.target.typeArguments
      .map(Type.encodeGenericArgument)
      .join(', ')}>`
    return [
      Diagnostic.polymorphicRecursion(
        callerText,
        targetText,
        registry.spanOf(caller.function.declaration.anchor),
      ),
    ]
  }),
]
import type * as SemanticContext from './SemanticContext.js'
