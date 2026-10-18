import * as Lifetime from '../Lifetime.js'
import * as TypeCompatibility from '../TypeCompatibility.js'
import * as RowAlgebra from '../RowAlgebra.js'
import type {
  Callable,
  Effect,
  ExecutableLifetimes,
  FailureRow,
  GenericArgument,
  Parameter,
  RepresentationArgument,
  RepresentationBound,
  RequirementRowArgument,
  RequirementsRow,
  RowInferenceFailure,
  InferenceFailure,
  InvocationInputBound,
  SealedStaticProperty,
  Substitution,
  TypeOutlives,
  Type,
} from '../Type.js'
import {
  callable,
  callableInputOrdinals,
  compareAccess,
  effectWithRows,
  executableFormationRequirements,
  invocationInputBounds,
  invocationUseState,
  lifetimes,
  encode,
  equals,
  equalsGenericArgument,
  failureMemberParameters,
  failureMembers,
  failureType,
  freeLifetimes,
  failureRowPolicy,
  genericArgumentKey,
  isCallable,
  isEffect,
  isFixedArray,
  isNever,
  isNominal,
  isParameter,
  isPointer,
  pointerQualifiersWeaken,
  samePointerQualifiers,
  isReference,
  isRepresentationArgument,
  isRepresentationParameterArgument,
  isRepresented,
  isRequirementRowArgument,
  isSlice,
  isString,
  isTypeArgument,
  key,
  parameterArgument,
  parameters,
  representationAdmissibility,
  representationArgumentKind,
  requirementMembers,
  requirementRowArgument,
  requirementRowArgumentFromRow,
  requirementRowParameters,
  requirementRowPolicy,
  requirementSatisfies,
  someSubterm,
  string,
  storageLifetimes,
  satisfiesOutlives,
  substitute,
  substituteFailureRow,
  substituteGenericArgument,
  substituteLifetime,
  substituteRequirementsRow,
  union,
} from '../Type.js'

const representationArgumentContract = (
  self: RepresentationArgument,
): RepresentationBound | undefined =>
  self._tag === 'RepresentationParameterArgument'
    ? self.parameter.representationBound
    : self.contract

// These concrete retention edges are conditional on the same expected exact input judgment.
// Executable outcomes/requirements are not stored input contents.
const lifetimesOfInput = (
  input: InvocationInputBound,
  substitution: Substitution,
): ReadonlyArray<Lifetime.Outlives> =>
  storageLifetimes(substitute(input.type, substitution)).map((longer) => ({
    longer,
    shorter: substituteLifetime(input.lifetime, substitution),
  }))

export interface GenericArgumentConflict {
  readonly parameter: Parameter
  readonly previous: GenericArgument
  readonly conflicting: GenericArgument
}

export interface OpenGenericInference {
  readonly matches: boolean
  readonly conflicts: ReadonlyArray<GenericArgumentConflict>
}

export interface LifetimeInference {
  readonly compatibility?: TypeCompatibility.Context
  /** Declaration-owned lifetime variables still open at this inference boundary. */
  readonly inferable?: ReadonlySet<string>
  readonly typeOutlives?: (type: Type, lifetime: Lifetime.Lifetime) => boolean
  /** Checks one selected source-to-expected region relation; invariant positions require both directions. */
  readonly accepts: (
    source: Lifetime.Lifetime,
    target: Lifetime.Lifetime,
    invariant: boolean,
  ) => boolean
}

interface InferenceContext {
  readonly environmentFailure?: (bound: Lifetime.Outlives) => void
  readonly lifetimes?: LifetimeInference | undefined
  readonly invariant?: boolean
  readonly contravariant?: boolean
  readonly allowOpenGenericArguments: boolean
  /** Generic identities this open inference boundary may bind; absence means every pattern binder. */
  readonly inferableGenericArguments?: ReadonlySet<string>
  readonly conflicts?: Array<GenericArgumentConflict>
}

const mayBindGenericArgument = (parameter_: Parameter, context: InferenceContext): boolean =>
  context.inferableGenericArguments === undefined ||
  context.inferableGenericArguments.has(key(parameter_))

const commitTrial = <A>(
  context: InferenceContext,
  evaluate: () => A,
  accepted: (result: A) => boolean,
): A =>
  context.lifetimes?.compatibility === undefined
    ? evaluate()
    : TypeCompatibility.commitWhen(context.lifetimes.compatibility, evaluate, accepted)

/** Adds structural constraints from one declared type pattern to one supplied concrete type. */
const bindGenericArgument = (
  parameter_: Parameter,
  actual: GenericArgument,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean => {
  const identity = key(parameter_)
  if (!mayBindGenericArgument(parameter_, context))
    return genericArgumentKey(parameterArgument(parameter_)) === genericArgumentKey(actual)
  const existing = inferred.get(identity)
  if (existing === undefined) {
    inferred.set(identity, actual)
    return true
  }
  if (genericArgumentKey(existing) === genericArgumentKey(actual)) return true
  context.conflicts?.push({ parameter: parameter_, previous: existing, conflicting: actual })
  return false
}

const commitInference = (
  target: Map<string, GenericArgument>,
  source: ReadonlyMap<string, GenericArgument>,
): void => {
  target.clear()
  for (const [identity, argument] of source) target.set(identity, argument)
}

/** Finds the first deterministic complete matching of normalized row members. */
const inferRowMembers = <Member>(
  pattern: ReadonlyArray<Member>,
  actual: ReadonlyArray<Member>,
  inferred: ReadonlyMap<string, GenericArgument>,
  matches: (pattern: Member, actual: Member, inferred: Map<string, GenericArgument>) => boolean,
  complete: (remaining: ReadonlyArray<Member>, inferred: Map<string, GenericArgument>) => boolean,
  context: InferenceContext,
): ReadonlyMap<string, GenericArgument> | undefined => {
  const search = (
    position: number,
    remaining: ReadonlyArray<Member>,
    current: ReadonlyMap<string, GenericArgument>,
  ): ReadonlyMap<string, GenericArgument> | undefined => {
    const member = pattern.at(position)
    if (member === undefined) {
      const completed = new Map(current)
      return complete(remaining, completed) ? completed : undefined
    }
    for (const [candidatePosition, candidate] of remaining.entries()) {
      const found = commitTrial(
        context,
        () => {
          const trial = new Map(current)
          if (!matches(member, candidate, trial)) return undefined
          return search(
            position + 1,
            remaining.filter((_, index) => index !== candidatePosition),
            trial,
          )
        },
        (result) => result !== undefined,
      )
      if (found !== undefined) return found
    }
    return undefined
  }
  return search(0, actual, inferred)
}

/** Infers one normalized internal failure expression through ordinary type parameters. */
const inferFailureRow = (
  pattern: FailureRow,
  actual: FailureRow,
  inferred: Map<string, GenericArgument>,
  allowOpenActual: boolean,
  context: InferenceContext,
): boolean => {
  if (RowAlgebra.key(failureRowPolicy(), pattern) === RowAlgebra.key(failureRowPolicy(), actual)) {
    // An open witness receiver still supplies evidence when its failure row is identical to
    // the implementation's pattern. Retain those identity bindings, just as inferType does
    // for ordinary parameters, rather than leaving the witness binders unresolved.
    return (
      !context.allowOpenGenericArguments ||
      RowAlgebra.parameters(failureRowPolicy(), pattern).members.every((parameter) =>
        bindGenericArgument(parameter, parameter, inferred, context),
      )
    )
  }
  const substitutedPattern = substituteFailureRow(pattern, inferred)
  if (
    RowAlgebra.key(failureRowPolicy(), substitutedPattern) ===
    RowAlgebra.key(failureRowPolicy(), actual)
  )
    return true
  if (pattern.expression._tag === 'Singleton') {
    const parameter = pattern.expression.member.parameter
    const normalized = union([...failureMembers(actual), ...failureMemberParameters(actual)])
    if (normalized._tag !== 'Normalized') return false
    if (someSubterm(normalized.type, (part) => isParameter(part) && key(part) === key(parameter)))
      return false
    return bindGenericArgument(parameter, normalized.type, inferred, context)
  }
  if (!allowOpenActual && RowAlgebra.concretize(failureRowPolicy(), actual)._tag !== 'Concrete')
    return false
  if (
    pattern.expression._tag === 'Without' ||
    (pattern.expression._tag === 'Union' &&
      pattern.expression.operands.some(
        (operand) => operand._tag === 'Without' || operand._tag === 'Singleton',
      ))
  )
    return false
  const memberContext = { ...context, allowOpenGenericArguments: false }
  const matched = inferRowMembers(
    failureMembers(pattern),
    failureMembers(actual),
    inferred,
    (failure, supplied, trial) => inferType(failure, supplied, trial, memberContext),
    (remaining, trial) => {
      void trial
      return remaining.length === 0
    },
    context,
  )
  if (matched === undefined) return false
  const trial = new Map(matched)
  commitInference(inferred, trial)
  return true
}

/** Infers one normalized requirement-row argument, assigning at most one open remainder. */
const inferRequirementRowArgument = (
  pattern: RequirementRowArgument,
  actual: RequirementRowArgument,
  inferred: Map<string, GenericArgument>,
  allowOpenActual: boolean,
  context: InferenceContext,
): boolean => {
  if (genericArgumentKey(pattern) === genericArgumentKey(actual))
    return (
      !context.allowOpenGenericArguments ||
      (requirementRowParameters(pattern).every((parameter_) =>
        bindGenericArgument(parameter_, parameterArgument(parameter_), inferred, context),
      ) &&
        requirementMembers(pattern).every((requirement) =>
          inferType(requirement.capability, requirement.capability, inferred, context),
        ))
    )
  const substitutedPattern = requirementRowArgumentFromRow(
    substituteRequirementsRow(pattern.row, inferred),
  )
  if (genericArgumentKey(substitutedPattern) === genericArgumentKey(actual)) return true
  if (pattern.row.expression._tag === 'RowParameter') {
    // Occurs check: R may never bind to a row that still mentions R.
    if (
      RowAlgebra.containsRowParameter(
        requirementRowPolicy(),
        actual.row,
        pattern.row.expression.parameter,
      )
    )
      return false
    return bindGenericArgument(pattern.row.expression.parameter, actual, inferred, context)
  }
  if (
    !allowOpenActual &&
    RowAlgebra.concretize(requirementRowPolicy(), actual.row)._tag !== 'Concrete'
  )
    return false
  if (substitutedPattern.row.expression._tag === 'Union') {
    const rowParameters = substitutedPattern.row.expression.operands.filter(
      (operand): operand is Extract<typeof operand, { readonly _tag: 'RowParameter' }> =>
        operand._tag === 'RowParameter' && mayBindGenericArgument(operand.parameter, context),
    )
    const fixed = substitutedPattern.row.expression.operands.filter(
      (operand) =>
        operand._tag !== 'RowParameter' || !mayBindGenericArgument(operand.parameter, context),
    )
    const actualOperands =
      actual.row.expression._tag === 'Union'
        ? [...actual.row.expression.operands]
        : [actual.row.expression]
    if (rowParameters.length === 1) {
      const remaining = [...actualOperands]
      let matched = true
      for (const operand of fixed) {
        const operandKey = RowAlgebra.key(requirementRowPolicy(), {
          expression: operand,
          memberWellFormed: [],
        })
        const index = remaining.findIndex(
          (candidate) =>
            RowAlgebra.key(requirementRowPolicy(), {
              expression: candidate,
              memberWellFormed: [],
            }) === operandKey,
        )
        if (index < 0) {
          matched = false
          break
        }
        remaining.splice(index, 1)
      }
      const parameter_ = rowParameters.at(0)?.parameter
      if (matched && parameter_ !== undefined) {
        const remainder = remaining.reduce<RequirementsRow>(
          (row, expression) =>
            RowAlgebra.union(requirementRowPolicy(), row, {
              expression,
              memberWellFormed: [],
            }),
          RowAlgebra.concrete(requirementRowPolicy(), []),
        )
        // Occurs check: the open remainder may not itself mention the parameter being bound.
        if (RowAlgebra.containsRowParameter(requirementRowPolicy(), remainder, parameter_))
          return false
        return bindGenericArgument(
          parameter_,
          requirementRowArgumentFromRow(remainder),
          inferred,
          context,
        )
      }
    }
  }
  if (
    pattern.row.expression._tag === 'Without' ||
    pattern.row.expression._tag === 'Singleton' ||
    (pattern.row.expression._tag === 'Union' &&
      pattern.row.expression.operands.some(
        (operand) => operand._tag === 'Without' || operand._tag === 'Singleton',
      ))
  )
    return false
  const memberContext = { ...context, allowOpenGenericArguments: false }
  const matched = inferRowMembers(
    requirementMembers(pattern),
    requirementMembers(actual),
    inferred,
    (requirement, supplied, trial) => {
      if (!requirementSatisfies(requirement, supplied) || requirement.role !== supplied.role)
        return false
      return inferType(requirement.capability, supplied.capability, trial, memberContext)
    },
    (remaining, trial) => {
      if (requirementRowParameters(pattern).length === 0)
        return remaining.length === 0 && requirementRowParameters(actual).length === 0
      const parameter_ = requirementRowParameters(pattern).at(0)
      return (
        requirementRowParameters(pattern).length === 1 &&
        parameter_ !== undefined &&
        bindGenericArgument(
          parameter_,
          requirementRowArgument(remaining, requirementRowParameters(actual)),
          trial,
          context,
        )
      )
    },
    context,
  )
  if (matched === undefined) return false
  const trial = new Map(matched)
  commitInference(inferred, trial)
  return true
}

/** Infers declaration-bound or body-local regions without inventing a longer validity. */
const inferLifetime = (
  pattern: Lifetime.Lifetime,
  actual: Lifetime.Lifetime,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean => {
  const identity = Lifetime.key(pattern)
  const previous = inferred.get(identity)
  if (previous === undefined && context.lifetimes?.inferable?.has(identity)) {
    inferred.set(identity, actual)
    return true
  }
  if (Lifetime.equals(pattern, actual) && previous === undefined) {
    if (
      context.lifetimes === undefined &&
      (pattern._tag === 'BoundLifetime' || pattern._tag === 'LocalLifetime')
    )
      inferred.set(identity, actual)
    return true
  }
  if (context.lifetimes !== undefined) {
    const expected = previous === undefined ? substituteLifetime(pattern, inferred) : previous
    return (
      Lifetime.isLifetime(expected) &&
      context.lifetimes.accepts(
        context.contravariant === true ? expected : actual,
        context.contravariant === true ? actual : expected,
        context.invariant ?? false,
      )
    )
  }
  if (pattern._tag !== 'BoundLifetime' && pattern._tag !== 'LocalLifetime') return false
  if (previous !== undefined)
    return Lifetime.isLifetime(previous) && Lifetime.equals(previous, actual)
  inferred.set(identity, actual)
  return true
}

const inferGenericArgument = (
  pattern: GenericArgument,
  actual: GenericArgument,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean => {
  if (Lifetime.isLifetime(pattern) || Lifetime.isLifetime(actual))
    return (
      Lifetime.isLifetime(pattern) &&
      Lifetime.isLifetime(actual) &&
      inferLifetime(pattern, actual, inferred, context)
    )
  if (isRepresentationParameterArgument(pattern))
    return (
      isRepresentationArgument(actual) &&
      bindGenericArgument(pattern.parameter, actual, inferred, context)
    )
  if (isRequirementRowArgument(pattern) && isRequirementRowArgument(actual))
    return inferRequirementRowArgument(
      pattern,
      actual,
      inferred,
      context.allowOpenGenericArguments,
      context,
    )
  if (isTypeArgument(pattern) && isTypeArgument(actual))
    return inferType(pattern, actual, inferred, context)
  return genericArgumentKey(pattern) === genericArgumentKey(actual)
}

const inferFailureRows = (
  pattern: Effect,
  actual: Effect,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean => inferFailureRow(pattern.failureRow, actual.failureRow, inferred, true, context)

const inferRequirementRows = (
  pattern: Effect,
  actual: Effect,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean =>
  inferRequirementRowArgument(
    requirementRowArgumentFromRow(pattern.requirementRow),
    requirementRowArgumentFromRow(actual.requirementRow),
    inferred,
    true,
    context,
  )

/** Explains a failed Effect-row decomposition without replacing ordinary type diagnostics. */
const rowInferenceFailure = (pattern: Type, actual: Type): RowInferenceFailure | undefined => {
  // A generic forwarding site may preserve the exact caller-owned row identity. It is open, but
  // it requires no decomposition or inference, so rejecting it as non-finite would make ordinary
  // wrappers less expressive than the declaration they forward to.
  if (equals(pattern, actual)) return undefined
  if (isNominal(pattern) && isNominal(actual)) {
    if (
      pattern.module !== actual.module ||
      pattern.name !== actual.name ||
      pattern.arguments.length !== actual.arguments.length
    )
      return undefined
    for (const [index, argument] of pattern.arguments.entries()) {
      const supplied = actual.arguments.at(index)
      if (supplied === undefined) continue
      if (!isTypeArgument(argument) || !isTypeArgument(supplied)) continue
      const failure = rowInferenceFailure(argument, supplied)
      if (failure !== undefined) return failure
    }
    return undefined
  }
  if (isFixedArray(pattern) && isFixedArray(actual))
    return rowInferenceFailure(pattern.element, actual.element)
  if (isSlice(pattern) && isSlice(actual))
    return rowInferenceFailure(pattern.element, actual.element)
  if (isReference(pattern) && isReference(actual))
    return rowInferenceFailure(pattern.target, actual.target)
  if (isPointer(pattern) && isPointer(actual))
    return rowInferenceFailure(pattern.pointee, actual.pointee)
  if (isCallable(pattern) && isCallable(actual)) {
    for (const [index, parameter_] of pattern.parameters.entries()) {
      const supplied = actual.parameters.at(index)
      if (supplied === undefined) continue
      const failure = rowInferenceFailure(parameter_, supplied)
      if (failure !== undefined) return failure
    }
    return rowInferenceFailure(pattern.result, actual.result)
  }
  if (!isEffect(pattern) || !isEffect(actual)) return undefined
  if (requirementRowParameters(actual).length !== 0) return { _tag: 'NonFiniteRequirementRow' }
  for (const failure of [...failureMembers(pattern), ...failureMemberParameters(pattern)]) {
    if (
      ![...failureMembers(actual), ...failureMemberParameters(actual)].some((supplied) =>
        infer(failure, supplied, new Map()),
      )
    )
      return { _tag: 'AbsentFailureMember', member: encode(failure) }
  }
  if (requirementRowParameters(pattern).length > 1)
    return {
      _tag: 'AmbiguousRequirementRemainder',
      parameters: requirementRowParameters(pattern).map((parameter_) => parameter_.name),
    }
  for (const requirement of requirementMembers(pattern)) {
    const capabilityMatches = requirementMembers(actual).filter((supplied) =>
      infer(requirement.capability, supplied.capability, new Map()),
    )
    if (capabilityMatches.length === 0)
      return {
        _tag: 'AbsentRequirementMember',
        capability: encode(requirement.capability),
        role: requirement.role,
        access: requirement.access,
      }
    const roleMatches = capabilityMatches.filter((supplied) => supplied.role === requirement.role)
    if (roleMatches.length === 0)
      return {
        _tag: 'IncompatibleRequirementRole',
        capability: encode(requirement.capability),
        expected: requirement.role,
        actual: [...new Set(capabilityMatches.map((supplied) => supplied.role))].sort(),
      }
    if (!roleMatches.some((supplied) => requirementSatisfies(requirement, supplied)))
      return {
        _tag: 'IncompatibleRequirementAccess',
        capability: encode(requirement.capability),
        role: requirement.role,
        expected: requirement.access,
        actual: [...new Set(roleMatches.map((supplied) => supplied.access))].sort(),
      }
  }
  return undefined
}

/** Reports the failed environment proof before considering a later symbolic row. */
export const inferenceFailure = (
  pattern: Type,
  actual: Type,
  inferred: Substitution = new Map(),
  lifetimes?: LifetimeInference,
): InferenceFailure | undefined => {
  let failure: Lifetime.Outlives | undefined
  const diagnose = () =>
    inferType(pattern, actual, new Map(inferred), {
      allowOpenGenericArguments: false,
      lifetimes,
      environmentFailure: (bound) => {
        failure ??= bound
      },
    })
  const matched =
    lifetimes?.compatibility === undefined
      ? diagnose()
      : TypeCompatibility.commitWhen(lifetimes.compatibility, diagnose, () => false)
  if (matched) return undefined
  if (failure !== undefined)
    return {
      _tag: 'EnvironmentMismatch',
      longer: Lifetime.display(failure.longer),
      shorter: Lifetime.display(failure.shorter),
    }
  return rowInferenceFailure(pattern, actual)
}

const inferEnvironment = (
  pattern: Lifetime.Lifetime,
  actual: Lifetime.Lifetime,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean => {
  if (inferLifetime(pattern, actual, inferred, context)) return true
  const expected = substituteLifetime(pattern, inferred)
  context.environmentFailure?.({
    longer: context.contravariant ? expected : actual,
    shorter: context.contravariant ? actual : expected,
  })
  return false
}

/** Includes hidden representation identities when checking whether a rigid region escaped. */
export const argumentLifetimes = (argument: GenericArgument): ReadonlyArray<Lifetime.Lifetime> => {
  if (Lifetime.isLifetime(argument)) return Lifetime.atoms(argument)
  if (
    (typeof argument !== 'string' && argument._tag === 'TypeParameter') ||
    isTypeArgument(argument)
  )
    return lifetimes(argument)
  switch (argument._tag) {
    case 'RequirementRowArgument': {
      const parameters_ = RowAlgebra.parameters(requirementRowPolicy(), argument.row)
      return [
        ...RowAlgebra.concreteMembers(requirementRowPolicy(), argument.row).flatMap((member) =>
          lifetimes(member.capability),
        ),
        ...[...parameters_.rows, ...parameters_.members].flatMap(lifetimes),
      ]
    }
    case 'UnavailableGenericArgument':
      return []
    case 'RepresentedType':
      return lifetimes(argument)
    case 'RepresentationParameterArgument':
      return lifetimes(argument.parameter)
    case 'OpaqueRepresentationArgument':
      return [...lifetimes(argument.contract), ...argument.arguments.flatMap(argumentLifetimes)]
    case 'ExactRepresentationArgument':
      return [...lifetimes(argument.contract), ...argumentLifetimes(argument.identity)]
    case 'CompositeEffectRepresentationArgument':
      return [...lifetimes(argument.contract), ...argument.alternatives.flatMap(argumentLifetimes)]
    case 'EffectIdentityArgument':
      return argument.owner?.typeArguments.flatMap(argumentLifetimes) ?? []
    case 'CallableIdentityArgument':
      return [
        ...argument.typeArguments.flatMap(argumentLifetimes),
        ...(argument.environment?.owner.typeArguments.flatMap(argumentLifetimes) ?? []),
      ]
  }
}

/** Opens one finite outer binder in a rigid universe and commits only nonescaping inference. */
const inferQuantifiedExecutable = (
  pattern: Callable | Effect,
  actual: Callable | Effect,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean => {
  if (isCallable(pattern) && isCallable(actual)) {
    if (invocationInputBounds(pattern) === undefined || invocationInputBounds(actual) === undefined)
      return false
    if (actual.invocationUse !== undefined && pattern.invocationUse === undefined) return false
  }
  if (
    isCallable(pattern) &&
    isCallable(actual) &&
    pattern.lifetimeBinders.length === 0 &&
    actual.lifetimeBinders.length > 0
  ) {
    const expected = substitute(pattern, inferred)
    const instantiated = isCallable(expected)
      ? instantiateOfferedCallable(actual, expected, context.lifetimes?.compatibility)
      : undefined
    return instantiated !== undefined && inferType(pattern, instantiated, inferred, context)
  }
  if (
    pattern.lifetimeBinders.length !== actual.lifetimeBinders.length &&
    !(
      isCallable(pattern) &&
      isCallable(actual) &&
      pattern.invocationUse !== undefined &&
      actual.lifetimeBinders.length === 0
    )
  )
    return false
  const nested = (type: Type): boolean =>
    someSubterm(
      type,
      (part) => (isCallable(part) || isEffect(part)) && part.lifetimeBinders.length > 0,
    )
  if (
    !isCallable(pattern) ||
    !isCallable(actual) ||
    [...pattern.parameters, pattern.result, ...actual.parameters, actual.result].some(nested)
  )
    return false
  const patternSubstitution = new Map<string, GenericArgument>()
  const actualSubstitution = new Map<string, GenericArgument>()
  const universe = `inference:${key(pattern)}:${key(actual)}`
  const actualData = actual.lifetimeBinders.filter(
    (binder) =>
      actual.invocationUse === undefined || !Lifetime.equals(binder, actual.invocationUse.lifetime),
  )
  const actualUse = actual.invocationUse?.lifetime
  let dataOrdinal = 0
  for (const [ordinal, binder] of pattern.lifetimeBinders.entries()) {
    let supplied: Lifetime.Bound | undefined
    if (actual.invocationUse === undefined) supplied = actual.lifetimeBinders.at(ordinal)
    else if (
      pattern.invocationUse !== undefined &&
      Lifetime.equals(binder, pattern.invocationUse.lifetime)
    )
      supplied = actual.lifetimeBinders.find(
        (entry) => actualUse !== undefined && Lifetime.equals(entry, actualUse),
      )
    else supplied = actualData.at(dataOrdinal++)
    if (supplied === undefined && actual.lifetimeBinders.length !== 0) return false
    const rigid = Lifetime.placeholder(binder, universe)
    patternSubstitution.set(Lifetime.key(binder), rigid)
    if (supplied !== undefined) actualSubstitution.set(Lifetime.key(supplied), rigid)
  }
  const open = (self: Callable | Effect, substitution: Substitution): Callable | Effect => {
    const metadata = {
      environment: self.environment,
      lifetimeBinders: [],
      ...(self.invocationUse === undefined
        ? {}
        : {
            invocationUse: {
              ...self.invocationUse,
              lifetime: substituteLifetime(self.invocationUse.lifetime, substitution),
            },
          }),
      typeOutlives: self.typeOutlives.map((bound) => ({
        type: substitute(bound.type, substitution),
        lifetime: substituteLifetime(bound.lifetime, substitution),
      })),
      lifetimeBounds: self.lifetimeBounds.map((bound) => ({
        longer: substituteLifetime(bound.longer, substitution),
        shorter: substituteLifetime(bound.shorter, substitution),
      })),
    }
    return isCallable(self)
      ? callable(
          self.parameters.map((parameter_) => substitute(parameter_, substitution)),
          substitute(self.result, substitution),
          metadata,
          self.mode,
          self.schema,
          self.unsafe,
          'Opened',
        )
      : effectWithRows(
          substitute(self.success, substitution),
          substituteFailureRow(self.failureRow, substitution),
          metadata,
          self.access,
          substituteRequirementsRow(self.requirementRow, substitution),
        )
  }
  const trial = new Map(inferred)
  // Expected invocation preconditions stay in scope while checking the returned Effect.
  // Only the rigid comparison uses these assumptions; the escape check below still prevents
  // an invocation binder from entering the caller's specialization.
  const openedPattern = open(pattern, patternSubstitution)
  const expectedInputs = isCallable(openedPattern) ? invocationInputBounds(openedPattern) : []
  if (expectedInputs === undefined) return false
  // Captured data already establishes formation facts. Preserve those while checking the
  // returned Effect, without assuming any precondition that mentions an invocation binder.
  const formation = executableFormationRequirements(actual)
  const proves = (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime): boolean => {
    if (
      Lifetime.outlives(
        Lifetime.assumptions(
          [
            ...openedPattern.lifetimeBounds,
            ...expectedInputs.flatMap((input) => lifetimesOfInput(input, trial)),
            ...formation.lifetimeBounds,
          ].map((bound) => ({
            longer: substituteLifetime(bound.longer, trial),
            shorter: substituteLifetime(bound.shorter, trial),
          })),
        ),
        longer,
        shorter,
      )
    )
      return true
    // Separate rigid invocation proofs from free local-region obligations before delegating.
    // A meet may contain both, while the caller's region solver must never absorb a placeholder.
    if (longer._tag === 'IntersectionLifetime')
      return longer.members.every((member) => proves(member, shorter))
    if (shorter._tag === 'IntersectionLifetime')
      return shorter.members.some((member) => proves(longer, member))
    return context.lifetimes?.accepts(longer, shorter, false) ?? false
  }
  const scoped: InferenceContext = {
    ...context,
    lifetimes: {
      ...context.lifetimes,
      accepts: (longer, shorter, invariant) =>
        proves(longer, shorter) && (!invariant || proves(shorter, longer)),
      typeOutlives: (type, lifetime) =>
        expectedInputs.some(
          (input) =>
            equals(substitute(input.type, trial), type) &&
            proves(substituteLifetime(input.lifetime, trial), lifetime),
        ) ||
        satisfiesOutlives(
          type,
          lifetime,
          [...openedPattern.typeOutlives, ...formation.typeOutlives].map((bound) => ({
            type: substitute(bound.type, trial),
            lifetime: substituteLifetime(bound.lifetime, trial),
          })),
          proves,
        ) ||
        (context.lifetimes?.typeOutlives?.(type, lifetime) ?? false),
    },
  }
  if (!inferType(openedPattern, open(actual, actualSubstitution), trial, scoped)) return false
  for (const [identity, argument] of trial) {
    if (inferred.has(identity)) continue
    const regions = argumentLifetimes(argument)
    if (
      regions.some(
        (region) => region._tag === 'PlaceholderLifetime' && region.universe === universe,
      )
    )
      return false
  }
  commitInference(inferred, trial)
  return true
}

/**
 * Instantiates an offered outer invocation binder at one already selected monomorphic signature.
 * Only that binder's variables may be solved; surrounding parameters remain rigid. The caller
 * still checks the offered signature, bounds and variance in the source-to-expected direction.
 */
export const instantiateOfferedCallable = (
  source: Callable,
  target: Callable,
  compatibility: TypeCompatibility.Context = TypeCompatibility.context(),
): Callable | undefined => {
  const expectedInputs = invocationInputBounds(target)
  if (expectedInputs === undefined || invocationInputBounds(source) === undefined) return undefined
  if (source.invocationUse !== undefined && target.invocationUse === undefined) return undefined
  const nested = (type: Type): boolean =>
    someSubterm(
      type,
      (part) => (isCallable(part) || isEffect(part)) && part.lifetimeBinders.length > 0,
    )
  if (
    source.lifetimeBinders.length === 0 ||
    target.lifetimeBinders.length !== 0 ||
    source.parameters.length !== target.parameters.length ||
    [...source.parameters, source.result, ...target.parameters, target.result].some(nested)
  )
    return undefined
  const inferable = new Set(source.lifetimeBinders.map(Lifetime.key))
  const inferred = new Map<string, GenericArgument>(
    parameters(source).map((parameter_) => [key(parameter_), parameterArgument(parameter_)]),
  )
  const context: InferenceContext = {
    allowOpenGenericArguments: false,
    lifetimes: {
      compatibility,
      inferable,
      accepts: (longer, shorter, invariant) =>
        TypeCompatibility.isCompatible(
          TypeCompatibility.check(string(longer), string(shorter), compatibility),
        ) &&
        (!invariant ||
          TypeCompatibility.isCompatible(
            TypeCompatibility.check(string(shorter), string(longer), compatibility),
          )),
    },
  }
  if (source.invocationUse !== undefined && target.invocationUse !== undefined)
    inferred.set(Lifetime.key(source.invocationUse.lifetime), target.invocationUse.lifetime)
  const sites = [...source.parameters, source.result]
  const expectedSites = [...target.parameters, target.result]
  for (const [ordinal, site] of sites.entries()) {
    const expected = expectedSites.at(ordinal)
    if (expected === undefined || !inferType(site, expected, inferred, context)) return undefined
  }
  const substitution = new Map<string, GenericArgument>()
  for (const binder of source.lifetimeBinders) {
    const selected = inferred.get(Lifetime.key(binder))
    if (selected === undefined || !Lifetime.isLifetime(selected)) return undefined
    substitution.set(Lifetime.key(binder), selected)
  }
  // Discharge invocation preconditions while their binders are still known. Once opened, those
  // predicates are free and must never be reclassified as assumed formation evidence.
  const formation = executableFormationRequirements(source)
  const boundsContext = {
    ...compatibility,
    invocationInputs: [...compatibility.invocationInputs, ...expectedInputs],
    typeBounds: [...compatibility.typeBounds, ...target.typeOutlives, ...formation.typeOutlives],
    assumptions: Lifetime.assumptions([
      ...compatibility.assumptions.bounds,
      ...target.lifetimeBounds,
      ...expectedInputs.flatMap((input) => lifetimesOfInput(input, new Map())),
      ...formation.lifetimeBounds,
    ]),
  }
  if (
    !source.lifetimeBounds.every((bound) =>
      TypeCompatibility.isCompatible(
        TypeCompatibility.check(
          string(substituteLifetime(bound.longer, substitution)),
          string(substituteLifetime(bound.shorter, substitution)),
          boundsContext,
        ),
      ),
    ) ||
    !source.typeOutlives.every((bound) =>
      TypeCompatibility.typeOutlives(boundsContext, {
        type: substitute(bound.type, substitution),
        lifetime: substituteLifetime(bound.lifetime, substitution),
      }),
    )
  )
    return undefined
  const opened = callable(
    source.parameters,
    source.result,
    {
      ...source,
      lifetimeBinders: [],
      ...(source.invocationUse === undefined
        ? {}
        : {
            invocationUse: {
              ...source.invocationUse,
              lifetime: substituteLifetime(source.invocationUse.lifetime, substitution),
            },
          }),
    },
    source.mode,
    source.schema,
    source.unsafe,
    'Opened',
  )
  const instantiated = substitute(opened, substitution)
  return isCallable(instantiated) ? instantiated : undefined
}

/** A named item's original slots closed over an explicitly marked, deferred invocation domain. */
export interface InvocationCallableAdapter {
  readonly callable: Callable
  readonly substitution: Substitution
}

/**
 * Opens a checked callable at one authentic finite use. Only original lifetime binders are
 * selected here; input ownership and cleanup remain obligations of the actual invocation.
 * The returned substitution also opens the semantic result of its unchanged physical value.
 */
export const openInvocationCallable = (
  source: Callable,
  inputs: ReadonlyArray<Type>,
  use: Lifetime.Local,
  compatibility: TypeCompatibility.Context = TypeCompatibility.context(),
): InvocationCallableAdapter | undefined => {
  const conditions = invocationInputBounds(source)
  const usage = source.invocationUse
  if (
    conditions === undefined ||
    invocationUseState(source) !== 'Closed' ||
    source.parameters.length !== inputs.length ||
    (usage !== undefined && usage.lifetime._tag !== 'BoundLifetime')
  )
    return undefined
  return TypeCompatibility.commitWhen(
    compatibility,
    () => {
      const selected = new Map<string, GenericArgument>()
      if (usage !== undefined) selected.set(Lifetime.key(usage.lifetime), use)
      const inferable = new Set(
        source.lifetimeBinders
          .filter((binder) => usage === undefined || !Lifetime.equals(binder, usage.lifetime))
          .map(Lifetime.key),
      )
      // Retained source selections are evidence only for the exact original data slot.
      // An identity selection is still unresolved, not permission to default it to κ.
      for (const binder of source.lifetimeBinders) {
        if (!inferable.has(Lifetime.key(binder))) continue
        const retained = source.schema?.substitution.get(Lifetime.key(binder))
        if (
          retained !== undefined &&
          Lifetime.isLifetime(retained) &&
          !Lifetime.atoms(retained).some((atom) => inferable.has(Lifetime.key(atom)))
        )
          selected.set(Lifetime.key(binder), retained)
      }
      const inference: InferenceContext = {
        allowOpenGenericArguments: false,
        inferableGenericArguments: new Set<string>(),
        lifetimes: {
          compatibility,
          inferable,
          accepts: (longer, shorter, invariant) =>
            TypeCompatibility.isCompatible(
              TypeCompatibility.check(string(longer), string(shorter), compatibility),
            ) &&
            (!invariant ||
              TypeCompatibility.isCompatible(
                TypeCompatibility.check(string(shorter), string(longer), compatibility),
              )),
          typeOutlives: (type, lifetime) =>
            TypeCompatibility.typeOutlives(compatibility, { type, lifetime }),
        },
      }
      for (const [ordinal, parameter_] of source.parameters.entries()) {
        const input = inputs.at(ordinal)
        if (input === undefined || !inferType(parameter_, input, selected, inference))
          return undefined
      }
      const opened = callable(
        source.parameters,
        source.result,
        {
          ...source,
          lifetimeBinders: [],
          ...(usage === undefined
            ? {}
            : {
                invocationUse: {
                  ...usage,
                  lifetime: use,
                },
              }),
        },
        source.mode,
        source.schema,
        source.unsafe,
        'Opened',
      )
      // Check the whole opened semantic record, including retained schema selections.
      // An unused data binder can disappear, but a result-only dependency cannot acquire
      // a scope from output context or from the designated use by default.
      const needed = new Set(freeLifetimes(opened).map(Lifetime.key))
      if (
        source.lifetimeBinders.some((binder) => {
          if (!needed.has(Lifetime.key(binder))) return false
          const value = selected.get(Lifetime.key(binder))
          return (
            value === undefined ||
            !Lifetime.isLifetime(value) ||
            Lifetime.atoms(value).some((atom) => inferable.has(Lifetime.key(atom)))
          )
        })
      )
        return undefined
      if (
        !conditions.every((condition) => {
          const input = inputs.at(condition.parameter)
          return (
            input !== undefined &&
            TypeCompatibility.typeOutlives(compatibility, {
              type: input,
              lifetime: substituteLifetime(condition.lifetime, selected),
            })
          )
        }) ||
        !source.lifetimeBounds.every((bound) =>
          TypeCompatibility.isCompatible(
            TypeCompatibility.check(
              string(substituteLifetime(bound.longer, selected)),
              string(substituteLifetime(bound.shorter, selected)),
              compatibility,
            ),
          ),
        ) ||
        !source.typeOutlives.every((bound) =>
          TypeCompatibility.typeOutlives(compatibility, {
            type: substitute(bound.type, selected),
            lifetime: substituteLifetime(bound.lifetime, selected),
          }),
        )
      )
        return undefined
      const instantiated = substitute(opened, selected, compatibility)
      const original = new Set(source.lifetimeBinders.map(Lifetime.key))
      if (
        !isCallable(instantiated) ||
        freeLifetimes(instantiated).some((region) => original.has(Lifetime.key(region))) ||
        !instantiated.parameters.every((parameter_, ordinal) => {
          const input = inputs.at(ordinal)
          return (
            input !== undefined &&
            TypeCompatibility.isCompatible(
              TypeCompatibility.check(input, parameter_, compatibility),
            )
          )
        })
      )
        return undefined
      return { callable: instantiated, substitution: selected }
    },
    (result) => result !== undefined,
  )
}

/** Genuine outer call binders and selections, supplied only by its argument-checking context. */
export interface InvocationConsumer {
  readonly binders: ReadonlyArray<Parameter>
  readonly substitution: Substitution
}

/**
 * Proves a generic item's conditional signature without publishing the private comparison region.
 * Original declaration bindings remain in the schema; the expected binder closes their dependency
 * until a real invocation supplies its finite input-use region.
 */
export const adaptInvocationCallable = (
  source: Callable,
  expected: Callable,
  binders: ReadonlyArray<Parameter>,
  initial: Substitution,
  compatibility: TypeCompatibility.Context = TypeCompatibility.context(),
  consumer?: InvocationConsumer,
  originalVisibleOrdinals?: ReadonlyArray<number>,
): InvocationCallableAdapter | undefined => {
  const usage = expected.invocationUse
  const sourceInputs =
    source.schema === undefined ? undefined : callableInputOrdinals(source.schema.contract)
  const visible = originalVisibleOrdinals ?? source.parameters.map((_, ordinal) => ordinal)
  if (
    visible.length !== source.parameters.length ||
    new Set(visible).size !== visible.length ||
    visible.some(
      (ordinal) =>
        !Number.isSafeInteger(ordinal) ||
        ordinal < 0 ||
        (sourceInputs !== undefined && !sourceInputs.includes(ordinal)),
    ) ||
    (originalVisibleOrdinals !== undefined && sourceInputs === undefined)
  )
    return undefined
  if (
    usage === undefined ||
    source.invocationUse !== undefined ||
    usage.lifetime._tag !== 'BoundLifetime' ||
    invocationInputBounds(expected) === undefined ||
    invocationInputBounds(source) === undefined ||
    source.parameters.length !== expected.parameters.length ||
    source.lifetimeBinders.some(
      (binder) =>
        !binders.some(
          (parameter_) =>
            parameter_.kind === 'Lifetime' && key(parameter_) === Lifetime.key(binder),
        ),
    )
  )
    return undefined
  const nested = (type: Type): boolean =>
    someSubterm(
      type,
      (part) => (isCallable(part) || isEffect(part)) && part.lifetimeBinders.length > 0,
    )
  if ([...source.parameters, source.result, ...expected.parameters, expected.result].some(nested))
    return undefined
  const universe = `invocation-adapter:${key(source)}:${key(expected)}`
  const opening = new Map<string, GenericArgument>()
  const closing = new Map<string, GenericArgument>()
  for (const binder of expected.lifetimeBinders) {
    const rigid = Lifetime.placeholder(binder, universe)
    opening.set(Lifetime.key(binder), rigid)
    closing.set(Lifetime.key(rigid), binder)
  }
  const promised = callable(
    expected.parameters.map((parameter_) => substitute(parameter_, opening)),
    substitute(expected.result, opening),
    {
      environment: expected.environment,
      lifetimeBinders: [],
      invocationUse: {
        ...usage,
        lifetime: substituteLifetime(usage.lifetime, opening),
      },
      lifetimeBounds: expected.lifetimeBounds.map((bound) => ({
        longer: substituteLifetime(bound.longer, opening),
        shorter: substituteLifetime(bound.shorter, opening),
      })),
      typeOutlives: expected.typeOutlives.map((bound) => ({
        type: substitute(bound.type, opening),
        lifetime: substituteLifetime(bound.lifetime, opening),
      })),
    },
    expected.mode,
    expected.schema,
    expected.unsafe,
    'Opened',
  )
  const inputs = invocationInputBounds(promised)
  if (inputs === undefined) return undefined
  const sourcePattern = callable(
    source.parameters,
    source.result,
    { ...source, lifetimeBinders: [] },
    source.mode,
    source.schema,
    source.unsafe,
  )
  const scoped: TypeCompatibility.Context = {
    ...compatibility,
    invocationInputs: [...compatibility.invocationInputs, ...inputs],
    typeBounds: [...compatibility.typeBounds, ...promised.typeOutlives],
    assumptions: Lifetime.mergeAssumptions(
      compatibility.assumptions,
      Lifetime.assumptions([
        ...promised.lifetimeBounds,
        ...inputs.flatMap((input) => lifetimesOfInput(input, new Map())),
      ]),
    ),
  }
  return TypeCompatibility.commitWhen(
    scoped,
    () => {
      const trial = new Map(initial)
      const own = new Set(binders.map(key))
      // Only unsolved original outer output binders are advisory holes. A caller-owned
      // rigid parameter, an explicit selection and an offered binder remain fixed.
      const pending = new Set(
        (consumer?.binders ?? [])
          .filter(
            (binder) =>
              (binder.kind === 'Value' || binder.kind === 'RequirementRow') &&
              !consumer?.substitution.has(key(binder)),
          )
          .map(key),
      )
      if ([...pending].some((identity) => own.has(identity))) return undefined
      const mentionsPending = (site: Type): boolean =>
        parameters(site).some((binder) => pending.has(key(binder)))
      const mentionsPendingRequirements = (site: Effect): boolean =>
        requirementRowParameters(site).some((binder) => pending.has(key(binder))) ||
        requirementMembers(site).some((requirement) => mentionsPending(requirement.capability))
      const inference: InferenceContext = {
        allowOpenGenericArguments: false,
        inferableGenericArguments: own,
        lifetimes: {
          compatibility: scoped,
          inferable: new Set(
            binders
              .filter((binder) => binder.kind === 'Lifetime')
              .map((binder) => genericArgumentKey(parameterArgument(binder))),
          ),
          accepts: (longer, shorter, invariant) =>
            TypeCompatibility.isCompatible(
              TypeCompatibility.check(string(shorter), string(longer), scoped),
            ) &&
            (!invariant ||
              TypeCompatibility.isCompatible(
                TypeCompatibility.check(string(longer), string(shorter), scoped),
              )),
          typeOutlives: (type, lifetime) =>
            TypeCompatibility.typeOutlives(scoped, { type, lifetime }),
        },
      }
      for (const [ordinal, site] of source.parameters.entries()) {
        const wanted = promised.parameters.at(ordinal)
        if (wanted === undefined || !inferType(site, wanted, trial, inference)) return undefined
      }
      // Infer the offered declaration's own demanded result holes without asking a
      // selected offered value to become an unsolved outer consumer parameter.
      // Directional access and fixed output compatibility belong to the full proof below.
      const learnFixedOutput = (site: Type, wanted: Type): boolean => {
        if (mentionsPending(wanted)) return true
        const attempt = new Map(trial)
        if (inferType(site, wanted, attempt, inference)) {
          commitInference(trial, attempt)
          return true
        }
        return !parameters(substitute(site, trial)).some(
          (binder) => own.has(key(binder)) && !trial.has(key(binder)),
        )
      }
      if (isEffect(source.result) && isEffect(promised.result)) {
        if (
          !inferEnvironment(
            source.result.environment,
            promised.result.environment,
            trial,
            inference,
          ) ||
          !learnFixedOutput(source.result.success, promised.result.success) ||
          !learnFixedOutput(failureType(source.result), failureType(promised.result))
        )
          return undefined
        if (!mentionsPendingRequirements(promised.result)) {
          const requirementTrial = new Map(trial)
          if (inferRequirementRows(source.result, promised.result, requirementTrial, inference))
            commitInference(trial, requirementTrial)
        }
      } else if (!learnFixedOutput(source.result, promised.result)) return undefined
      if (binders.some((binder) => !trial.has(key(binder)))) return undefined
      const selected = substitute(sourcePattern, trial)
      if (!isCallable(selected)) return undefined
      // These equations are private comparison evidence, not published consumer
      // selections. The ordinary outer argument pass infers from the retained actual
      // result and independently checks the complete applied contract afterwards.
      const consumerTrial = new Map(consumer?.substitution)
      const outputInference: InferenceContext = {
        ...inference,
        inferableGenericArguments: pending,
        lifetimes:
          inference.lifetimes === undefined
            ? undefined
            : {
                ...inference.lifetimes,
                inferable: new Set<string>(),
              },
      }
      if (isEffect(promised.result) && isEffect(selected.result)) {
        if (
          mentionsPending(promised.result.success) &&
          !inferType(
            promised.result.success,
            selected.result.success,
            consumerTrial,
            outputInference,
          )
        )
          return undefined
        if (
          mentionsPending(failureType(promised.result)) &&
          !inferFailureRows(promised.result, selected.result, consumerTrial, outputInference)
        )
          return undefined
        if (
          mentionsPendingRequirements(promised.result) &&
          !inferRequirementRows(promised.result, selected.result, consumerTrial, outputInference)
        )
          return undefined
      } else if (
        mentionsPending(promised.result) &&
        !inferType(promised.result, selected.result, consumerTrial, outputInference)
      )
        return undefined
      const projected = substitute(promised, consumerTrial)
      if (!isCallable(projected)) return undefined
      // Callable comparison accepts already-proven independent formation facts. A named
      // adapter must establish those facts here, before comparison can assume them.
      const independent = executableFormationRequirements(selected)
      if (
        !independent.typeOutlives.every((bound) => TypeCompatibility.typeOutlives(scoped, bound)) ||
        !independent.lifetimeBounds.every((bound) =>
          TypeCompatibility.isCompatible(
            TypeCompatibility.check(string(bound.longer), string(bound.shorter), scoped),
          ),
        )
      )
        return undefined
      // The expected conditional domain, not the offered obligations, supplies the premise.
      const offered = callable(
        selected.parameters,
        selected.result,
        {
          ...selected,
          lifetimeBinders: [],
          ...(promised.invocationUse === undefined
            ? {}
            : { invocationUse: promised.invocationUse }),
        },
        selected.mode,
        selected.schema,
        selected.unsafe,
        'Opened',
      )
      if (!TypeCompatibility.isCompatible(TypeCompatibility.check(offered, projected, scoped)))
        return undefined
      const reclosed = new Map<string, GenericArgument>()
      for (const [identity, argument] of trial) {
        if (!own.has(identity)) {
          if (!initial.has(identity)) return undefined
          reclosed.set(identity, argument)
          continue
        }
        const closed = substituteGenericArgument(argument, closing)
        if (
          argumentLifetimes(closed).some(
            (region) => region._tag === 'PlaceholderLifetime' && region.universe === universe,
          )
        )
          return undefined
        reclosed.set(identity, closed)
      }
      // Context may select only slots the original evaluated producer left deferred.
      // An authored or earlier-stage selection remains the same source-owned argument.
      if (
        [...initial].some(([identity, argument]) => {
          const selected = reclosed.get(identity)
          return selected === undefined || !equalsGenericArgument(argument, selected)
        }) ||
        binders.some(
          (binder) =>
            binder.kind === 'Lifetime' &&
            !initial.has(key(binder)) &&
            !source.lifetimeBinders.some((original) => Lifetime.key(original) === key(binder)),
        )
      )
        return undefined
      const closedSource = substitute(sourcePattern, reclosed)
      if (!isCallable(closedSource)) return undefined
      const originalInputs =
        closedSource.schema === undefined
          ? undefined
          : callableInputOrdinals(closedSource.schema.contract)
      if (closedSource.schema !== undefined && originalInputs === undefined) return undefined
      const adaptedSchema =
        closedSource.schema === undefined || originalInputs === undefined
          ? undefined
          : {
              ...closedSource.schema,
              substitution: new Map([...closedSource.schema.substitution, ...reclosed]),
              invocationAdapter: {
                binder: usage.lifetime,
                originalInputs,
                parameters: Array.from(visible),
                lifetimes: binders.flatMap((parameter_) => {
                  const selectedLifetime = reclosed.get(key(parameter_))
                  return parameter_.kind === 'Lifetime' &&
                    selectedLifetime !== undefined &&
                    Lifetime.isLifetime(selectedLifetime) &&
                    Lifetime.atoms(selectedLifetime).some((atom) =>
                      Lifetime.equals(atom, usage.lifetime),
                    )
                    ? [{ parameter: parameter_, lifetime: selectedLifetime }]
                    : []
                }),
              },
            }
      const adapted = callable(
        closedSource.parameters,
        closedSource.result,
        {
          ...closedSource,
          lifetimeBinders: expected.lifetimeBinders,
          invocationUse: usage,
        },
        closedSource.mode,
        adaptedSchema,
        closedSource.unsafe,
        'Closed',
      )
      return { callable: adapted, substitution: reclosed }
    },
    (result) => result !== undefined,
  )
}

/**
 * Checks a stored suffix against its authentic formation environment without selecting the
 * future use binder. The caller owns that environment's real capture/loan provenance.
 */
export const stagedInvocationParameter = (
  self: Callable,
  ordinal: number,
  formation: ExecutableLifetimes,
): Type | undefined => {
  if (
    !Number.isSafeInteger(ordinal) ||
    ordinal < 0 ||
    invocationInputBounds(self) === undefined ||
    invocationUseState(self) !== 'Closed'
  )
    return undefined
  const parameter_ = self.parameters.at(ordinal)
  const usage = self.invocationUse
  if (parameter_ === undefined || usage === undefined) return parameter_
  if (
    usage.lifetime._tag !== 'BoundLifetime' ||
    formation.lifetimeBinders.length !== 0 ||
    formation.invocationUse !== undefined ||
    Lifetime.atoms(formation.environment).some(
      (atom) => atom._tag === 'PlaceholderLifetime' || Lifetime.equals(atom, usage.lifetime),
    )
  )
    return undefined
  // This is only a parameter checking view. Neither the original callable nor the caller's
  // inference substitution receives κ→η; the result and pending target bounds stay original.
  return substitute(parameter_, new Map([[Lifetime.key(usage.lifetime), formation.environment]]))
}

/** Invocation preconditions need implication; independent formation facts travel with the value. */
const inferExecutableBounds = (
  pattern: Callable | Effect,
  actual: Callable | Effect,
  inferred: Substitution,
  context: InferenceContext,
): boolean => {
  const expectedInputs = isCallable(pattern) ? invocationInputBounds(pattern) : []
  const actualInputs = isCallable(actual) ? invocationInputBounds(actual) : []
  if (expectedInputs === undefined || actualInputs === undefined) return false
  if (isCallable(pattern) && isCallable(actual) && actual.invocationUse !== undefined) {
    if (
      pattern.invocationUse === undefined ||
      !Lifetime.equals(
        substituteLifetime(pattern.invocationUse.lifetime, inferred),
        substituteLifetime(actual.invocationUse.lifetime, inferred),
      )
    )
      return false
  }
  const formation = executableFormationRequirements(actual)
  const expected = Lifetime.assumptions(
    [
      ...pattern.lifetimeBounds,
      ...expectedInputs.flatMap((input) => lifetimesOfInput(input, inferred)),
      ...formation.lifetimeBounds,
    ].map((bound) => ({
      longer: substituteLifetime(bound.longer, inferred),
      shorter: substituteLifetime(bound.shorter, inferred),
    })),
  )
  const expectedTypes = [...pattern.typeOutlives, ...formation.typeOutlives].map((bound) => ({
    type: substitute(bound.type, inferred),
    lifetime: substituteLifetime(bound.lifetime, inferred),
  }))
  const proves = (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime): boolean =>
    Lifetime.outlives(expected, longer, shorter) ||
    (context.lifetimes?.accepts(longer, shorter, false) ?? false)
  return (
    actual.typeOutlives.every((bound) => {
      const type = substitute(bound.type, inferred)
      const lifetime = substituteLifetime(bound.lifetime, inferred)
      return (
        expectedInputs.some(
          (input) =>
            equals(substitute(input.type, inferred), type) &&
            proves(substituteLifetime(input.lifetime, inferred), lifetime),
        ) ||
        satisfiesOutlives(type, lifetime, expectedTypes, proves) ||
        (context.lifetimes?.typeOutlives?.(type, lifetime) ?? false)
      )
    }) &&
    actual.lifetimeBounds.every((bound) => {
      const longer = substituteLifetime(bound.longer, inferred)
      const shorter = substituteLifetime(bound.shorter, inferred)
      return (
        Lifetime.outlives(expected, longer, shorter) ||
        (context.lifetimes?.accepts(longer, shorter, false) ?? false)
      )
    })
  )
}

const inferType = (
  pattern: Type,
  actual: Type,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean =>
  commitTrial(
    context,
    () => inferSelectedType(pattern, actual, inferred, context),
    (matched) => matched,
  )

const inferSelectedType = (
  pattern: Type,
  actual: Type,
  inferred: Map<string, GenericArgument>,
  context: InferenceContext,
): boolean => {
  // A diverging expression satisfies every expected result without replacing a generic already
  // inferred from a value argument. When it is the only evidence (including an explicit `never`
  // type argument), retain it so exact specialization keys remain complete.
  if (isNever(actual)) {
    if (!isParameter(pattern)) return true
    return inferred.has(key(pattern))
      ? true
      : bindGenericArgument(pattern, actual, inferred, context)
  }
  if (isParameter(pattern)) {
    const fixed = inferred.get(key(pattern))
    if (
      pattern.kind === 'Value' &&
      fixed !== undefined &&
      isTypeArgument(fixed) &&
      context.lifetimes !== undefined
    ) {
      const comparison =
        context.lifetimes.compatibility ??
        TypeCompatibility.context({
          outlives: (source, target) =>
            context.lifetimes?.accepts(source, target, context.invariant ?? false) ?? false,
          typeOutlives: context.lifetimes.typeOutlives,
        })
      const source = context.contravariant ? fixed : actual
      const target = context.contravariant ? actual : fixed
      if (
        TypeCompatibility.isCompatible(TypeCompatibility.check(source, target, comparison)) &&
        (!context.invariant ||
          TypeCompatibility.isCompatible(TypeCompatibility.check(target, source, comparison)))
      )
        return true
    }
    return pattern.kind === 'Value' && bindGenericArgument(pattern, actual, inferred, context)
  }
  if (isNominal(pattern) && isNominal(actual)) {
    if (
      pattern.module !== actual.module ||
      pattern.name !== actual.name ||
      pattern.arguments.length !== actual.arguments.length
    )
      return false
    return pattern.arguments.every((argument, index) => {
      const supplied = actual.arguments.at(index)
      return supplied !== undefined && inferGenericArgument(argument, supplied, inferred, context)
    })
  }
  if (isString(pattern) && isString(actual))
    return inferLifetime(pattern.lifetime, actual.lifetime, inferred, context)
  if (isFixedArray(pattern) && isFixedArray(actual)) {
    return (
      pattern.length === actual.length &&
      inferType(pattern.element, actual.element, inferred, context)
    )
  }
  if (isSlice(pattern) && isSlice(actual)) {
    return (
      pattern.access === actual.access &&
      inferLifetime(pattern.lifetime, actual.lifetime, inferred, context) &&
      inferType(
        pattern.element,
        actual.element,
        inferred,
        pattern.access === 'Exclusive' ? { ...context, invariant: true } : context,
      ) &&
      (context.lifetimes !== undefined ||
        pattern.access !== 'Exclusive' ||
        equals(substitute(pattern.element, inferred), actual.element))
    )
  }
  if (isReference(pattern) && isReference(actual)) {
    return (
      pattern.access === actual.access &&
      inferLifetime(pattern.lifetime, actual.lifetime, inferred, context) &&
      inferType(
        pattern.target,
        actual.target,
        inferred,
        pattern.access === 'Exclusive' ? { ...context, invariant: true } : context,
      ) &&
      (context.lifetimes !== undefined ||
        pattern.access !== 'Exclusive' ||
        equals(substitute(pattern.target, inferred), actual.target))
    )
  }
  if (isPointer(pattern) && isPointer(actual)) {
    // Inference admits only the same immediate qualifier weakening as ordinary compatibility.
    return (
      (context.invariant
        ? samePointerQualifiers(actual, pattern)
        : pointerQualifiersWeaken(actual, pattern)) &&
      inferType(pattern.pointee, actual.pointee, inferred, { ...context, invariant: true })
    )
  }
  if (isCallable(pattern) && isCallable(actual)) {
    if (pattern.lifetimeBinders.length !== 0 || actual.lifetimeBinders.length !== 0)
      return inferQuantifiedExecutable(pattern, actual, inferred, context)
    return (
      inferEnvironment(pattern.environment, actual.environment, inferred, context) &&
      (!actual.unsafe || pattern.unsafe) &&
      compareAccess(pattern.mode, actual.mode) &&
      pattern.parameters.length === actual.parameters.length &&
      pattern.parameters.every((parameter_, index) => {
        const supplied = actual.parameters.at(index)
        return (
          supplied !== undefined &&
          inferType(parameter_, supplied, inferred, {
            ...context,
            contravariant: !context.contravariant,
          })
        )
      }) &&
      inferType(pattern.result, actual.result, inferred, context) &&
      inferExecutableBounds(pattern, actual, inferred, context)
    )
  }
  if (isEffect(pattern) && isEffect(actual)) {
    if (pattern.lifetimeBinders.length !== 0 || actual.lifetimeBinders.length !== 0)
      return inferQuantifiedExecutable(pattern, actual, inferred, context)
    return (
      inferEnvironment(pattern.environment, actual.environment, inferred, context) &&
      compareAccess(pattern.access, actual.access) &&
      inferType(pattern.success, actual.success, inferred, context) &&
      inferFailureRows(pattern, actual, inferred, context) &&
      inferRequirementRows(pattern, actual, inferred, context) &&
      inferExecutableBounds(pattern, actual, inferred, context)
    )
  }
  if (isRepresented(pattern) && isRepresented(actual)) {
    if (!inferType(pattern.contract, actual.contract, inferred, context)) return false
    return inferGenericArgument(
      pattern.representation.argument,
      actual.representation.argument,
      inferred,
      context,
    )
  }
  return equals(pattern, actual)
}

export const infer = (
  pattern: Type,
  actual: Type,
  inferred: Map<string, GenericArgument>,
  lifetimes?: LifetimeInference,
): boolean => inferType(pattern, actual, inferred, { allowOpenGenericArguments: false, lifetimes })

/** Infers through generic arguments that remain open over an enclosing declaration. */
export const inferOpenGenericArguments = (
  pattern: Type,
  actual: Type,
  inferred: Map<string, GenericArgument>,
  inferableGenericArguments?: ReadonlySet<string>,
): OpenGenericInference => {
  const conflicts: Array<GenericArgumentConflict> = []
  const matches = inferType(pattern, actual, inferred, {
    allowOpenGenericArguments: true,
    ...(inferableGenericArguments === undefined ? {} : { inferableGenericArguments }),
    conflicts,
  })
  return { matches, conflicts: conflicts }
}

/**
 * Binds the supplied prefix independently in the lifetime and ordinary generic namespaces.
 * Omitted lifetime arguments remain open while an ordinary prefix such as `<A>` binds the first
 * ordinary parameter. Kind mismatches and excess arguments in either namespace are rejected.
 */
export const prefixSubstitution = (
  declared: ReadonlyArray<Parameter>,
  arguments_: ReadonlyArray<GenericArgument>,
): Substitution | undefined => bindPrefix(declared, arguments_)

const bindPrefix = (
  declared: ReadonlyArray<Parameter>,
  arguments_: ReadonlyArray<GenericArgument>,
  representationContext?: TypeCompatibility.Context,
): Substitution | undefined => {
  if (arguments_.length > declared.length) return undefined
  const result = new Map<string, GenericArgument>()
  const lifetimeParameters = declared.filter((parameter) => parameter.kind === 'Lifetime')
  const ordinaryParameters = declared.filter((parameter) => parameter.kind !== 'Lifetime')
  let lifetimeOrdinal = 0
  let ordinaryOrdinal = 0
  const supplied: Array<{ readonly parameter: Parameter; readonly argument: GenericArgument }> = []
  for (const argument of arguments_) {
    const parameter = Lifetime.isLifetime(argument)
      ? lifetimeParameters.at(lifetimeOrdinal++)
      : ordinaryParameters.at(ordinaryOrdinal++)
    if (parameter === undefined) return undefined
    supplied.push({ parameter, argument })
    result.set(key(parameter), argument)
  }
  for (const { parameter: parameter_, argument } of supplied) {
    const rawRepresentationContract = isRepresentationArgument(argument)
      ? representationArgumentContract(argument)
      : undefined
    const substitutedRepresentationContract =
      rawRepresentationContract === undefined
        ? undefined
        : substitute(rawRepresentationContract, result)
    const representationContract =
      substitutedRepresentationContract !== undefined &&
      (isCallable(substitutedRepresentationContract) || isEffect(substitutedRepresentationContract))
        ? substitutedRepresentationContract
        : undefined
    const substitutedRepresentationBound =
      parameter_.representationBound === undefined
        ? undefined
        : substitute(parameter_.representationBound, result)
    const requiredRepresentationBound =
      substitutedRepresentationBound !== undefined &&
      (isCallable(substitutedRepresentationBound) || isEffect(substitutedRepresentationBound))
        ? substitutedRepresentationBound
        : undefined
    let suppliedStaticProperties: ReadonlyArray<SealedStaticProperty> | undefined
    if (isRepresentationArgument(argument) && argument._tag === 'RepresentationParameterArgument') {
      suppliedStaticProperties = argument.parameter.staticProperties
    } else if (isTypeArgument(argument) && isParameter(argument)) {
      suppliedStaticProperties = argument.staticProperties
    }
    const preservesStaticProperties =
      suppliedStaticProperties === undefined ||
      parameter_.staticProperties.every((property) => suppliedStaticProperties.includes(property))
    if (
      (parameter_.kind === 'Lifetime' && !Lifetime.isLifetime(argument)) ||
      (parameter_.kind === 'Value' && !isTypeArgument(argument)) ||
      (parameter_.kind === 'RequirementRow' && !isRequirementRowArgument(argument)) ||
      ((parameter_.kind === 'CallableRepresentation' ||
        parameter_.kind === 'EffectRepresentation') &&
        (!isRepresentationArgument(argument) ||
          representationArgumentKind(argument) !== parameter_.kind ||
          requiredRepresentationBound === undefined ||
          representationContract === undefined ||
          !preservesStaticProperties ||
          representationAdmissibility(
            representationContract,
            requiredRepresentationBound,
            representationContext,
          )._tag !== 'Admitted'))
    )
      return undefined
  }
  return result
}

/** Builds a substitution from ordered parameters and arguments when their arities match. */
export const substitution = (
  declared: ReadonlyArray<Parameter>,
  arguments_: ReadonlyArray<GenericArgument>,
): Substitution | undefined =>
  declared.length !== arguments_.length ? undefined : prefixSubstitution(declared, arguments_)

/** Replays a complete original declaration tuple without reordering its source slots. */
export const orderedSubstitution = (
  declared: ReadonlyArray<Parameter>,
  arguments_: ReadonlyArray<GenericArgument>,
): Substitution | undefined => {
  if (
    declared.length !== arguments_.length ||
    declared.some((parameter, ordinal) => {
      const argument = arguments_.at(ordinal)
      if (argument === undefined) return true
      switch (parameter.kind) {
        case 'Lifetime':
          return !Lifetime.isLifetime(argument)
        case 'Value':
          return !isTypeArgument(argument)
        case 'RequirementRow':
          return !isRequirementRowArgument(argument)
        case 'CallableRepresentation':
        case 'EffectRepresentation':
          return (
            !isRepresentationArgument(argument) ||
            representationArgumentKind(argument) !== parameter.kind
          )
      }
    })
  )
    return undefined
  // Prefix admission still checks the exact representation contracts and static properties.
  return bindPrefix(declared, arguments_)
}

/** Exact semantic arguments and the selected call's proven representation lifetime relations. */
export interface SelectedSubstitution {
  readonly substitution: Substitution
  readonly compatibility: TypeCompatibility.Context
}

/**
 * Rebinds a complete invocation selected by semantic checking. Only Instances and ExecutableOrigin
 * may use this boundary: the caller must supply already checked TIR arguments. Kind, access and
 * representation structure are verified again; only their accepted lifetime relations are carried
 * forward as explicit assumptions. Detached and NonParking obligations remain independently checked.
 */
export const selectedSubstitution = (
  declared: ReadonlyArray<Parameter>,
  arguments_: ReadonlyArray<GenericArgument>,
): SelectedSubstitution | undefined => {
  if (declared.length !== arguments_.length) return undefined
  const bounds: Array<Lifetime.Outlives> = []
  const typeBounds: Array<TypeOutlives> = []
  const collect = TypeCompatibility.context({
    outlives: () => true,
    commitOutlives: (longer, shorter) => {
      bounds.push({ longer, shorter })
    },
    typeOutlives: () => true,
    commitTypeOutlives: (type, lifetime) => {
      typeBounds.push({ type, lifetime })
    },
  })
  const substitution = bindPrefix(declared, arguments_, collect)
  return substitution === undefined
    ? undefined
    : {
        substitution,
        compatibility: TypeCompatibility.context({
          assumptions: Lifetime.assumptions(bounds),
          typeBounds,
        }),
      }
}
