import * as Location from './Location.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as Diagnostic from './Diagnostic.js'
import * as Lifetime from './Lifetime.js'
import * as Type from './Type.js'

/** Declared universal storage obligations; absence of a parameter bound is not static validity. */
export interface Context {
  readonly assumptions: Lifetime.Assumptions
  readonly parameters: ReadonlyMap<string, DeclarationFacts.TypeParameterFact>
  readonly parameterBounds: ReadonlyMap<string, ReadonlyArray<Lifetime.Lifetime>>
  /** Marked expected-input antecedents local to one hidden body/comparison scope. */
  readonly invocationInputs: ReadonlyArray<Type.InvocationInputBound>
  readonly nominals: ReadonlyMap<string, ReadonlyArray<DeclarationFacts.TypeParameterFact>>
  readonly contractNominals: ReadonlySet<string>
  readonly work: {
    readonly declarations: number
    readonly headers: number
    readonly iterations: number
    readonly lifetimeObligations: number
    readonly typeObligations: number
  }
}

export type Prove = (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime) => boolean

const contexts = new WeakMap<ReadonlyArray<DeclarationFacts.ModuleHeaders>, Context>()
const nominalKey = (type: Type.Nominal): string => Type.key(Type.specializeNominal(type, []))

const applicationBounds = (
  parameter: DeclarationFacts.TypeParameterFact,
  contract: boolean,
  bounds: ReadonlyMap<string, ReadonlyArray<Lifetime.Lifetime>>,
  parameterBounds: ReadonlyMap<string, ReadonlyArray<Lifetime.Lifetime>>,
): ReadonlyArray<Lifetime.Lifetime> => {
  if (contract) return parameter.lifetimeBounds ?? []
  if (parameter.type.kind === 'Lifetime') return bounds.get(Type.key(parameter.type)) ?? []
  return parameterBounds.get(Type.key(parameter.type)) ?? []
}

// Each application asks about one binder, while elaboration contexts can contain thousands
// of unrelated bounds. Cache immutable contexts; construction maintains its own growing index.
const lifetimeBoundIndices = new WeakMap<
  Lifetime.Assumptions,
  ReadonlyMap<string, ReadonlyArray<Lifetime.Lifetime>>
>()

const indexLifetimeBounds = (
  assumptions: Lifetime.Assumptions,
): ReadonlyMap<string, ReadonlyArray<Lifetime.Lifetime>> => {
  const previous = lifetimeBoundIndices.get(assumptions)
  if (previous !== undefined) return previous
  const index = new Map<string, Array<Lifetime.Lifetime>>()
  for (const bound of assumptions.bounds) {
    const identity = Lifetime.key(bound.longer)
    const entries = index.get(identity)
    if (entries === undefined) index.set(identity, [bound.shorter])
    else entries.push(bound.shorter)
  }
  lifetimeBoundIndices.set(assumptions, index)
  return index
}

/** Indexes immutable declaration assumptions by canonical owner, never by binder spelling. */
export const context = (modules: ReadonlyArray<DeclarationFacts.ModuleHeaders>): Context => {
  const cached = contexts.get(modules)
  if (cached !== undefined) return cached
  const work = {
    declarations: 0,
    headers: 0,
    iterations: 0,
    lifetimeObligations: 0,
    typeObligations: 0,
  }
  const parameters = new Map<string, DeclarationFacts.TypeParameterFact>()
  const nominals = new Map<string, ReadonlyArray<DeclarationFacts.TypeParameterFact>>()
  const contractNominals = new Set<string>()
  const storedHeaders: Array<Type.Type> = []
  const executableHeaders: Array<Type.ExecutableLifetimes> = []
  const headerType = (fact: DeclarationFacts.DeclaredTypeFact): Type.Type | undefined => {
    if (fact._tag === 'Resolved') return fact.type
    if (fact._tag === 'Reference') {
      const target = headerType(fact.target)
      return target === undefined ? undefined : Type.reference(fact.access, target, fact.lifetime)
    }
    if (fact._tag === 'Slice') {
      const element = headerType(fact.element)
      return element === undefined ? undefined : Type.slice(fact.access, element, fact.lifetime)
    }
    if (fact._tag === 'FixedArray' && fact.length._tag === 'Available') {
      const element = headerType(fact.element)
      return element === undefined ? undefined : Type.fixedArray(element, fact.length.value)
    }
    return undefined
  }
  const registerInput = (fact: DeclarationFacts.DeclaredTypeFact): void => {
    const type = headerType(fact)
    if (type !== undefined) {
      storedHeaders.push(type)
      work.headers += 1
    }
  }
  const register = (facts: ReadonlyArray<DeclarationFacts.TypeParameterFact>): void => {
    for (const parameter of facts) parameters.set(Type.key(parameter.type), parameter)
  }
  for (const module of modules) {
    for (const member of module.members) {
      work.declarations += 1
      if ('typeParameters' in member) register(member.typeParameters)
      if (member._tag === 'FunctionDeclaration') {
        executableHeaders.push(DeclarationFacts.executableLifetimes(member))
        for (const parameter of member.parameters) registerInput(parameter.declaredType)
        for (const entry of member.requirementRow.entries) registerInput(entry.capability)
      }
      if (member._tag === 'StructDeclaration')
        for (const field of member.fields) registerInput(field.declaredType)
      if (member._tag === 'UnionDeclaration')
        for (const variant of member.variants)
          for (const field of variant.fields) registerInput(field.declaredType)
      if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration')
        for (const operation of member.operations) {
          register(operation.typeParameters)
          executableHeaders.push(DeclarationFacts.executableLifetimes(operation))
          for (const parameter of operation.parameters) registerInput(parameter.declaredType)
          for (const entry of operation.requirementRow.entries) registerInput(entry.capability)
        }
    }
    for (const declaration of [...module.conformances, ...module.inherentImpls])
      register(declaration.typeParameters)
    for (const declaration of module.conformances) {
      registerInput(declaration.provider)
      registerInput(declaration.capability)
      for (const requirement of declaration.requirements) registerInput(requirement.capability)
    }
    for (const declaration of module.inherentImpls) registerInput(declaration.owner)
    for (const declaration of [
      ...module.structs,
      ...module.unions,
      ...module.services,
      ...module.interfaces,
    ]) {
      if (declaration.canonical._tag !== 'Canonical') continue
      nominals.set(
        nominalKey(Type.nominal(declaration.canonical.id.module, declaration.canonical.id.name)),
        declaration.typeParameters,
      )
      if (declaration._tag === 'ServiceDeclaration' || declaration._tag === 'InterfaceDeclaration')
        contractNominals.add(
          nominalKey(Type.nominal(declaration.canonical.id.module, declaration.canonical.id.name)),
        )
    }
  }
  const bounds: Array<Lifetime.Outlives> = []
  const boundsByLonger = new Map<string, Array<Lifetime.Lifetime>>()
  const boundKeys = new Set<string>()
  const parameterBounds = new Map<string, ReadonlyArray<Lifetime.Lifetime>>()
  const add = (argument: Type.GenericArgument, shorter: Lifetime.Lifetime): boolean => {
    if (Lifetime.isLifetime(argument)) {
      const identity = Lifetime.assumptions([{ longer: argument, shorter }]).key
      if (boundKeys.has(identity)) return false
      boundKeys.add(identity)
      bounds.push({ longer: argument, shorter })
      const identityOfLonger = Lifetime.key(argument)
      const previous = boundsByLonger.get(identityOfLonger)
      if (previous === undefined) boundsByLonger.set(identityOfLonger, [shorter])
      else previous.push(shorter)
      work.lifetimeObligations += 1
      return true
    }
    if (!Type.isTypeArgument(argument)) return false
    let changed = false
    for (const lifetime of Type.storageLifetimes(argument))
      changed = add(lifetime, shorter) || changed
    for (const parameter of Type.storageParameters(argument)) {
      const identity = Type.key(parameter)
      const existing = parameterBounds.get(identity) ?? []
      if (existing.some((bound) => Lifetime.equals(bound, shorter))) continue
      parameterBounds.set(identity, [...existing, shorter])
      work.typeObligations += 1
      changed = true
    }
    return changed
  }
  for (const parameter of parameters.values())
    for (const shorter of parameter.lifetimeBounds ?? [])
      add(Type.parameterArgument(parameter.type), shorter)
  for (const header of executableHeaders) {
    for (const bound of header.lifetimeBounds ?? []) add(bound.longer, bound.shorter)
    for (const bound of header.typeOutlives ?? []) add(bound.type, bound.lifetime)
  }
  for (const header of storedHeaders)
    for (const type of Type.storageTypes(header)) {
      if (Type.isReference(type)) add(type.target, type.lifetime)
      else if (Type.isSlice(type)) add(type.element, type.lifetime)
    }
  // Source headers and their region identities are finite; propagation adds only missing edges.
  let changed = true
  while (changed) {
    work.iterations += 1
    changed = false
    for (const header of storedHeaders)
      for (const nominal of Type.nominals(header)) {
        const declared = nominals.get(nominalKey(nominal)) ?? []
        const substitution = new Map<string, Type.GenericArgument>()
        for (const [ordinal, parameter] of declared.entries()) {
          const argument = nominal.arguments.at(ordinal)
          if (argument !== undefined) substitution.set(Type.key(parameter.type), argument)
        }
        for (const [ordinal, parameter] of declared.entries()) {
          const argument = nominal.arguments.at(ordinal)
          if (argument === undefined) continue
          // Adding a bound may extend this same binder's bucket. Process the current snapshot;
          // newly inferred bounds participate in the next fixed-point iteration.
          const implied = [
            ...applicationBounds(
              parameter,
              contractNominals.has(nominalKey(nominal)),
              boundsByLonger,
              parameterBounds,
            ),
          ]
          for (const shorter of implied)
            changed = add(argument, Type.substituteLifetime(shorter, substitution)) || changed
        }
      }
  }
  const result = {
    assumptions: Lifetime.assumptions(bounds),
    parameters,
    parameterBounds,
    invocationInputs: [],
    nominals,
    contractNominals,
    work: work,
  }
  contexts.set(modules, result)
  return result
}

/** Proves structural retained-data validity using explicit bounds for every unknown type. */
export const check = (
  self: Type.Type,
  lifetime: Lifetime.Lifetime,
  scope: Context,
  prove: Prove = (longer, shorter) => Lifetime.outlives(scope.assumptions, longer, shorter),
): boolean => {
  if (
    scope.invocationInputs.some(
      (input) => Type.equals(input.type, self) && prove(input.lifetime, lifetime),
    )
  )
    return true
  if (!Type.storageLifetimes(self).every((retained) => prove(retained, lifetime))) return false
  return Type.storageParameters(self).every((parameter) => {
    if (parameter.staticProperties.includes('Intrinsic.Detached')) return true
    if (parameter.representationBound !== undefined)
      return prove(parameter.representationBound.environment, lifetime)
    const bounds = scope.parameterBounds.get(Type.key(parameter)) ?? []
    if (bounds.some((bound) => Lifetime.outlives(scope.assumptions, bound, lifetime))) return true
    // Inference may retain an obligation while reporting success. Do not select a weaker
    // redundant bound first and thereby constrain a caller's region more than necessary.
    return bounds
      .filter(
        (bound) =>
          !bounds.some(
            (other) =>
              Lifetime.outlives(scope.assumptions, other, bound) &&
              !Lifetime.outlives(scope.assumptions, bound, other),
          ),
      )
      .some((bound) => prove(bound, lifetime))
  })
}

export interface Failure {
  readonly argument: Type.GenericArgument
  readonly required: Lifetime.Lifetime
  readonly ordinal: number
}

/** Input well-formedness is a local precondition, including a nominal's stored-data bounds. */
export const inputLifetimes = (
  inputs: ReadonlyArray<Type.Type>,
  scope: Context,
): Pick<Type.ExecutableLifetimes, 'lifetimeBounds' | 'typeOutlives'> => {
  const lifetimeBounds: Array<Lifetime.Outlives> = []
  const typeOutlives: Array<Type.TypeOutlives> = []
  const add = (argument: Type.GenericArgument, required: Lifetime.Lifetime): void => {
    if (Lifetime.isLifetime(argument)) lifetimeBounds.push({ longer: argument, shorter: required })
    else if (Type.isTypeArgument(argument))
      typeOutlives.push({ type: argument, lifetime: required })
  }
  for (const input of inputs) {
    for (const stored of Type.storageTypes(input)) {
      if (Type.isReference(stored)) add(stored.target, stored.lifetime)
      else if (Type.isSlice(stored)) add(stored.element, stored.lifetime)
    }
    for (const nominal of Type.nominals(input))
      for (const obligation of obligations(nominal, scope))
        add(obligation.argument, obligation.required)
  }
  return {
    lifetimeBounds: Lifetime.assumptions(lifetimeBounds).bounds,
    typeOutlives: Type.normalizeTypeOutlives(typeOutlives),
  }
}

/** Extends a hidden body's context without publishing its invocation-local assumptions. */
export const withInputs = (scope: Context, inputs: ReadonlyArray<Type.Type>): Context => {
  const implied = inputLifetimes(inputs, scope)
  const bounds = [...(implied.lifetimeBounds ?? [])]
  const parameterBounds = new Map(scope.parameterBounds)
  for (const bound of implied.typeOutlives ?? []) {
    for (const longer of Type.storageLifetimes(bound.type))
      bounds.push({ longer, shorter: bound.lifetime })
    for (const parameter of Type.storageParameters(bound.type)) {
      const key = Type.key(parameter)
      const previous = parameterBounds.get(key) ?? []
      if (!previous.some((lifetime) => Lifetime.equals(lifetime, bound.lifetime)))
        parameterBounds.set(key, [...previous, bound.lifetime])
    }
  }
  return {
    ...scope,
    assumptions: Lifetime.mergeAssumptions(scope.assumptions, Lifetime.assumptions(bounds)),
    parameterBounds,
  }
}

/** Adds only explicitly marked expected-input conditions; this does not prove an actual call. */
export const withInvocationInputs = (
  scope: Context,
  expected: Type.Callable,
): Context | undefined => {
  const inputs = Type.invocationInputBounds(expected)
  if (inputs === undefined) return undefined
  return {
    ...scope,
    invocationInputs: [...scope.invocationInputs, ...inputs],
    assumptions: Lifetime.mergeAssumptions(
      scope.assumptions,
      Lifetime.assumptions(
        inputs.flatMap((input) =>
          Type.storageLifetimes(input.type).map((longer) => ({ longer, shorter: input.lifetime })),
        ),
      ),
    ),
  }
}

const obligations = (self: Type.Nominal, scope: Context): ReadonlyArray<Failure> => {
  const parameters = scope.nominals.get(nominalKey(self)) ?? []
  const substitution = new Map<string, Type.GenericArgument>()
  for (const [ordinal, parameter] of parameters.entries()) {
    const argument = self.arguments.at(ordinal)
    if (argument !== undefined) substitution.set(Type.key(parameter.type), argument)
  }
  return parameters.flatMap((parameter, ordinal) => {
    const argument = self.arguments.at(ordinal)
    if (argument === undefined) return []
    // A capability or interface stores no operation arguments. Operation-local assumptions
    // remain available to bodies but are not preconditions of applying the enclosing contract.
    const requiredBounds = applicationBounds(
      parameter,
      scope.contractNominals.has(nominalKey(self)),
      indexLifetimeBounds(scope.assumptions),
      scope.parameterBounds,
    )
    return requiredBounds.map((bound) => ({
      argument,
      required: Type.substituteLifetime(bound, substitution),
      ordinal,
    }))
  })
}

/** Checks one already selected nominal application; this operation performs no lookup search. */
export const application = (
  self: Type.Nominal,
  scope: Context,
  prove: Prove = (longer, shorter) => Lifetime.outlives(scope.assumptions, longer, shorter),
): ReadonlyArray<Failure> =>
  obligations(self, scope).filter(({ argument, required }) => {
    if (Lifetime.isLifetime(argument)) return !prove(argument, required)
    if (Type.isTypeArgument(argument)) return !check(argument, required, scope, prove)
    if (Type.isRepresentationArgument(argument)) {
      const represented = Type.representedType(argument)
      return represented === undefined || !check(represented, required, scope, prove)
    }
    return true
  })

/** Validates resolved headers after all parameter-implied assumptions are available. */
export const moduleDiagnostics = (
  self: DeclarationFacts.ModuleHeaders,
  scope: Context,
): ReadonlyArray<Diagnostic.Located> => {
  const diagnostics = new Map<string, Diagnostic.Located>()
  const inspect = (fact: DeclarationFacts.DeclaredTypeFact): void => {
    if (fact._tag !== 'Resolved') return
    for (const nominal of Type.nominals(fact.type))
      for (const failure of application(nominal, scope)) {
        const diagnostic = Diagnostic.unsatisfiedLifetimeBound(
          Type.encodeGenericArgument(failure.argument),
          Lifetime.display(failure.required),
          Location.at(fact.anchor),
        )
        diagnostics.set(
          `${Type.key(nominal)}:${failure.ordinal}:${Lifetime.key(failure.required)}:${AuthoredIdentity.anchorKey(fact.anchor)}`,
          diagnostic,
        )
      }
  }
  const inspectOperation = (
    operation: DeclarationFacts.DeclarationFact | DeclarationFacts.ServiceOperationFact,
  ): void => {
    for (const parameter of operation.parameters) inspect(parameter.declaredType)
    inspect(operation.returnType)
    for (const member of operation.failureRow.members) inspect(member)
    for (const entry of operation.requirementRow.entries) inspect(entry.capability)
  }
  for (const member of self.members) {
    if (member._tag === 'FunctionDeclaration') inspectOperation(member)
    else if (member._tag === 'ConstantDeclaration' || member._tag === 'PackageParameterDeclaration')
      inspect(member.declaredType)
    else if (member._tag === 'StructDeclaration')
      for (const field of member.fields) inspect(field.declaredType)
    else if (member._tag === 'UnionDeclaration')
      for (const variant of member.variants)
        for (const field of variant.fields) inspect(field.declaredType)
    else if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration')
      for (const operation of member.operations) inspectOperation(operation)
  }
  for (const declaration of self.conformances) {
    inspect(declaration.provider)
    inspect(declaration.capability)
    for (const requirement of declaration.requirements) inspect(requirement.capability)
    if (declaration.hook !== undefined) {
      inspect(declaration.hook.parameterType)
      inspect(declaration.hook.returnType)
      for (const member of declaration.hook.failureRow.members) inspect(member)
      for (const entry of declaration.hook.requirementRow.entries) inspect(entry.capability)
    }
  }
  for (const declaration of self.inherentImpls) inspect(declaration.owner)
  return [...diagnostics.values()]
}
