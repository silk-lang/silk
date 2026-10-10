import * as ForeignContract from './ForeignContract.js'
import * as Data from 'effect/Data'
import * as Effect from 'effect/Effect'
import * as Fn from 'effect/Function'
import * as CallableContract from './CallableContract.js'
import * as ConformanceHead from './ConformanceHead.js'
import * as ContractConstraint from './Constraint.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as FiniteRow from './FiniteRow.js'
import * as Canonical from './internal/Canonical.js'
import * as Lifetime from './Lifetime.js'
import * as RequirementRow from './RequirementRow.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as Type from './Type.js'

/**
 * The canonical semantic meaning that a module exposes to other modules.
 *
 * The representation is length-framed and contains semantic values only. It deliberately excludes
 * syntax, spans, diagnostic identities, body object graphs, and project-owned object references.
 * Functions requiring static evaluation contribute only a deterministic body-template encoding so
 * downstream invalidation observes semantic body changes without retaining source-owned nodes.
 */
export interface ModuleSurface {
  readonly _tag: 'ModuleSurface'
  readonly module: string
  readonly canonical: string
}

export type DecodeOperation =
  | 'ModuleSurface.decodeSemanticType'
  | 'ModuleSurface.decodeConstraint'
  | 'ModuleSurface.decodeConstraintEvidence'
  | 'ModuleSurface.decodeWitnessIdentity'
  | 'ModuleSurface.decodeProviderMatch'

/** Expected refusal when a serialized semantic value is malformed or internally inconsistent. */
export class ModuleSurfaceDecodeError extends Data.TaggedError('ModuleSurfaceDecodeError')<{
  readonly operation: DecodeOperation
  readonly message: string
  readonly reason: { readonly _tag: 'InvalidEncoding'; readonly detail: string }
}> {}

class InvalidModuleSurfaceEncoding extends Data.TaggedError('InvalidModuleSurfaceEncoding')<{
  readonly message: string
  readonly cause?: unknown
}> {
  constructor(message: string, options?: { readonly cause: unknown }) {
    super(options === undefined ? { message } : { message, cause: options.cause })
  }
}

const record = Canonical.record

const array = Canonical.array

const optional = (value: string | undefined): string =>
  value === undefined ? record('None') : record('Some', [value])

const boolean = (value: boolean): string => record(value ? 'True' : 'False')

const number = (value: number): string => record('Number', [String(value)])

const exhaustive = (value: never): never => {
  throw new RangeError(`Unknown module-surface fact: ${String(value)}`)
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

type SerializedRecord = Readonly<Record<string, unknown>>

const serializedRecord = (value: unknown, context: string): SerializedRecord => {
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new InvalidModuleSurfaceEncoding(`${context} must be a record`)
  return value as SerializedRecord
}

const serializedString = (value: unknown, context: string): string => {
  if (typeof value !== 'string') throw new InvalidModuleSurfaceEncoding(`${context} must be text`)
  return value
}

const serializedBoolean = (value: unknown, context: string): boolean => {
  if (typeof value !== 'boolean')
    throw new InvalidModuleSurfaceEncoding(`${context} must be a boolean`)
  return value
}

const serializedNonNegativeInteger = (value: unknown, context: string): number => {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0)
    throw new InvalidModuleSurfaceEncoding(`${context} must be a non-negative safe integer`)
  return value
}

const serializedArray = (value: unknown, context: string): ReadonlyArray<unknown> => {
  if (!Array.isArray(value)) throw new InvalidModuleSurfaceEncoding(`${context} must be an array`)
  return value
}

const serializedTag = (value: SerializedRecord, context: string): string =>
  serializedString(value.tag, `${context}.tag`)

const decodeParameterKind = (value: unknown, context: string): Type.ParameterKind => {
  const kind = serializedString(value, context)
  if (
    kind !== 'Value' &&
    kind !== 'Lifetime' &&
    kind !== 'RequirementRow' &&
    kind !== 'CallableRepresentation' &&
    kind !== 'EffectRepresentation'
  )
    throw new InvalidModuleSurfaceEncoding(`${context} has an unknown parameter kind`)
  return kind
}

const decodeCallableParameterMode = (
  value: unknown,
  context: string,
): CallableContract.ParameterMode => {
  const mode = serializedString(value, context)
  if (mode !== 'Value' && mode !== 'Shared' && mode !== 'Exclusive' && mode !== 'Take')
    throw new InvalidModuleSurfaceEncoding(`${context} has an unknown parameter mode`)
  return mode
}

const encodeParameter = (value: Type.Parameter): SerializedRecord => {
  // A section binder names an unapplied binder only inside its own section's callable identity;
  // encoding it as an ordinary parameter would collide with the declaration's own parameter.
  if (value.sectionBinder === true)
    throw new RangeError(
      `Section binder ${value.owner.module}.${value.owner.name}:${value.ordinal} cannot cross a module surface`,
    )
  return encodeOrdinaryParameter(value)
}

const encodeOrdinaryParameter = (value: Type.Parameter): SerializedRecord => ({
  tag: 'Parameter',
  owner: { module: value.owner.module, name: value.owner.name },
  ordinal: value.ordinal,
  name: value.name,
  kind: value.kind,
  staticProperties: value.staticProperties,
  ...(value.representationBound === undefined
    ? {}
    : { representationBound: encodeTypeNode(value.representationBound) }),
})

function decodeParameter(value: unknown): Type.Parameter {
  const encoded = serializedRecord(value, 'parameter')
  if (serializedTag(encoded, 'parameter') !== 'Parameter')
    throw new InvalidModuleSurfaceEncoding('parameter has the wrong tag')
  const owner = serializedRecord(encoded.owner, 'parameter.owner')
  const kind = decodeParameterKind(encoded.kind, 'parameter.kind')
  const bound =
    encoded.representationBound === undefined
      ? undefined
      : decodeTypeNode(encoded.representationBound)
  const staticProperties = serializedArray(
    encoded.staticProperties ?? [],
    'parameter.staticProperties',
  ).map((value_) => {
    const property = serializedString(value_, 'parameter.staticProperties[]')
    if (property !== 'Intrinsic.Detached' && property !== 'Intrinsic.NonParking')
      throw new InvalidModuleSurfaceEncoding('parameter has an unknown sealed static property')
    return property
  })
  const canonicalStaticProperties = Type.sealedStaticPropertyOrder.filter((property) =>
    staticProperties.includes(property),
  )
  if (
    staticProperties.length !== canonicalStaticProperties.length ||
    staticProperties.some((property, ordinal) => property !== canonicalStaticProperties.at(ordinal))
  )
    throw new InvalidModuleSurfaceEncoding(
      'parameter sealed static properties must be unique and in canonical order',
    )
  if (
    staticProperties.length > 0 &&
    kind !== 'CallableRepresentation' &&
    kind !== 'EffectRepresentation' &&
    (kind !== 'Value' || staticProperties.some((property) => property !== 'Intrinsic.Detached'))
  )
    throw new InvalidModuleSurfaceEncoding(
      'value parameters may carry only the sealed Intrinsic.Detached property',
    )
  if (bound !== undefined && !Type.isCallable(bound) && !Type.isEffect(bound))
    throw new InvalidModuleSurfaceEncoding(
      'parameter representation bound must be callable or Effect',
    )
  if (
    bound !== undefined &&
    ((kind === 'CallableRepresentation' && !Type.isCallable(bound)) ||
      (kind === 'EffectRepresentation' && !Type.isEffect(bound)) ||
      (kind !== 'CallableRepresentation' && kind !== 'EffectRepresentation'))
  )
    throw new InvalidModuleSurfaceEncoding(
      'parameter representation bound disagrees with its parameter kind',
    )
  return Type.parameter(
    {
      module: serializedString(owner.module, 'parameter.owner.module'),
      name: serializedString(owner.name, 'parameter.owner.name'),
    },
    serializedNonNegativeInteger(encoded.ordinal, 'parameter.ordinal'),
    serializedString(encoded.name, 'parameter.name'),
    kind,
    bound,
    staticProperties,
  )
}

const decodeParameterOfKind = (
  value: unknown,
  expected: Type.ParameterKind,
  context: string,
): Type.Parameter => {
  const parameter = decodeParameter(value)
  if (parameter.kind !== expected)
    throw new InvalidModuleSurfaceEncoding(`${context} must have ${expected} kind`)
  return parameter
}

const decodeRepresentationParameter = (value: unknown): Type.Parameter => {
  const parameter = decodeParameter(value)
  if (parameter.kind !== 'CallableRepresentation' && parameter.kind !== 'EffectRepresentation')
    throw new InvalidModuleSurfaceEncoding(
      'representation parameter argument must have a representation kind',
    )
  return parameter
}

const encodeFailureRow = (value: Type.FailureRow): SerializedRecord =>
  encodeRow(
    value,
    (member) => encodeTypeNode(member),
    encodeParameter,
    (member) => ({ tag: 'FailureMember', parameter: encodeParameter(member.parameter) }),
  )

const encodeRequirement = (value: Type.Requirement): SerializedRecord => ({
  tag: 'Requirement',
  capability: encodeTypeNode(value.capability),
  role: value.role,
  access: value.access,
})

const decodeRequirement = (value: unknown): Type.Requirement => {
  const encoded = serializedRecord(value, 'requirement')
  if (serializedTag(encoded, 'requirement') !== 'Requirement')
    throw new InvalidModuleSurfaceEncoding('requirement has the wrong tag')
  const capability = decodeTypeNode(encoded.capability)
  if (!Type.isNominal(capability) && !Type.isParameter(capability))
    throw new InvalidModuleSurfaceEncoding('requirement capability must be nominal or a parameter')
  const access = serializedString(encoded.access, 'requirement.access')
  if (access !== 'Shared' && access !== 'Exclusive')
    throw new InvalidModuleSurfaceEncoding('requirement access must be Shared or Exclusive')
  return {
    capability,
    role: serializedString(encoded.role, 'requirement.role'),
    access,
  }
}

const encodeRequirementRow = (value: Type.RequirementsRow): SerializedRecord =>
  encodeRow(value, encodeRequirement, encodeParameter, (member) => ({
    tag: 'RequirementMember',
    capability: encodeParameter(member.capability),
    role: member.role,
    access: member.access,
  }))

function encodeRow<Member, RowParameter, SymbolicMember>(
  value: RowAlgebra.Row<Member, RowParameter, SymbolicMember>,
  encodeMember: (member: Member) => unknown,
  encodeRowParameter: (parameter: RowParameter) => unknown,
  encodeSymbolicMember: (member: SymbolicMember) => unknown,
): SerializedRecord {
  const expression = (
    current: RowAlgebra.Expression<Member, RowParameter, SymbolicMember>,
  ): SerializedRecord => {
    switch (current._tag) {
      case 'Concrete':
        return { tag: 'Concrete', members: current.row.members.map(encodeMember) }
      case 'RowParameter':
        return { tag: 'RowParameter', parameter: encodeRowParameter(current.parameter) }
      case 'Singleton':
        return { tag: 'Singleton', member: encodeSymbolicMember(current.member) }
      case 'Union':
        return { tag: 'Union', operands: current.operands.map(expression) }
      case 'Without':
        return {
          tag: 'Without',
          source: expression(current.source),
          selected: expression(current.selected),
        }
    }
  }
  return {
    tag: 'Row',
    expression: expression(value.expression),
    obligations: value.memberWellFormed.map((obligation) => ({
      tag: 'MemberWellFormed',
      key: obligation.key,
      member: encodeSymbolicMember(obligation.member),
    })),
  }
}

function decodeRow<Member, RowParameter, SymbolicMember, MemberParameter>(
  value: unknown,
  policy: RowAlgebra.Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  decodeMember: (member: unknown) => Member,
  decodeRowParameter: (parameter: unknown) => RowParameter,
  decodeSymbolicMember: (member: unknown) => SymbolicMember,
): RowAlgebra.Row<Member, RowParameter, SymbolicMember> {
  const encoded = serializedRecord(value, 'row')
  if (serializedTag(encoded, 'row') !== 'Row')
    throw new InvalidModuleSurfaceEncoding('row has the wrong tag')
  const requiredObligations = new Map<string, SymbolicMember>()
  const expression = (input: unknown): RowAlgebra.Row<Member, RowParameter, SymbolicMember> => {
    const current = serializedRecord(input, 'row.expression')
    switch (serializedTag(current, 'row.expression')) {
      case 'Concrete':
        return RowAlgebra.concrete(
          policy,
          serializedArray(current.members, 'row.expression.members').map(decodeMember),
        )
      case 'RowParameter':
        return RowAlgebra.parameter(decodeRowParameter(current.parameter))
      case 'Singleton': {
        const member = decodeSymbolicMember(current.member)
        requiredObligations.set(policy.memberWellFormedKey(member), member)
        const singletonExpression: RowAlgebra.Expression<Member, RowParameter, SymbolicMember> = {
          _tag: 'Singleton',
          member,
        }
        const singleton: RowAlgebra.Row<Member, RowParameter, SymbolicMember> = {
          expression: singletonExpression,
          memberWellFormed: [],
        }
        return singleton
      }
      case 'Union':
        return serializedArray(current.operands, 'row.expression.operands').reduce<
          RowAlgebra.Row<Member, RowParameter, SymbolicMember>
        >(
          (row, operand) => RowAlgebra.union(policy, row, expression(operand)),
          RowAlgebra.concrete(policy, []),
        )
      case 'Without':
        return RowAlgebra.without(policy, expression(current.source), expression(current.selected))
      default:
        throw new InvalidModuleSurfaceEncoding(
          `unknown row expression ${serializedTag(current, 'row.expression')}`,
        )
    }
  }
  const normalized = expression(encoded.expression)
  const obligations = new Map<string, RowAlgebra.MemberWellFormed<SymbolicMember>>()
  for (const obligation of serializedArray(encoded.obligations, 'row.obligations')) {
    const current = serializedRecord(obligation, 'row.obligation')
    if (serializedTag(current, 'row.obligation') !== 'MemberWellFormed')
      throw new InvalidModuleSurfaceEncoding('row obligation has the wrong tag')
    const member = decodeSymbolicMember(current.member)
    const encodedKey = serializedString(current.key, 'row.obligation.key')
    const expectedKey = policy.memberWellFormedKey(member)
    if (encodedKey !== expectedKey)
      throw new InvalidModuleSurfaceEncoding('row obligation has inconsistent key branding')
    obligations.set(expectedKey, { key: expectedKey, member, origins: [] })
  }
  for (const key of requiredObligations.keys())
    if (!obligations.has(key))
      throw new InvalidModuleSurfaceEncoding('row singleton is missing its member obligation')
  return {
    expression: normalized.expression,
    memberWellFormed: [...obligations.values()].sort((left, right) =>
      compareText(left.key, right.key),
    ),
  }
}

const decodeFailureRow = (value: unknown): Type.FailureRow =>
  decodeRow(
    value,
    Type.failureRowPolicy(),
    decodeTypeNode,
    () => {
      throw new InvalidModuleSurfaceEncoding('failure rows cannot contain whole-row parameters')
    },
    (member) => {
      const encoded = serializedRecord(member, 'failure member')
      if (serializedTag(encoded, 'failure member') !== 'FailureMember')
        throw new InvalidModuleSurfaceEncoding('failure member has the wrong tag')
      return Type.failureMemberShape(
        decodeParameterOfKind(encoded.parameter, 'Value', 'failure member parameter'),
      )
    },
  )

const decodeRequirementRow = (value: unknown): Type.RequirementsRow =>
  decodeRow(
    value,
    Type.requirementRowPolicy(),
    decodeRequirement,
    (parameter) => decodeParameterOfKind(parameter, 'RequirementRow', 'requirement row parameter'),
    (member) => {
      const encoded = serializedRecord(member, 'requirement member')
      if (serializedTag(encoded, 'requirement member') !== 'RequirementMember')
        throw new InvalidModuleSurfaceEncoding('requirement member has the wrong tag')
      const access = serializedString(encoded.access, 'requirement member access')
      if (access !== 'Shared' && access !== 'Exclusive')
        throw new InvalidModuleSurfaceEncoding(
          'requirement member access must be Shared or Exclusive',
        )
      return Type.requirementMemberShape(
        decodeParameterOfKind(encoded.capability, 'Value', 'requirement member capability'),
        access,
        serializedString(encoded.role, 'requirement member role'),
      )
    },
  )

const encodeSubstitution = (value: Type.Substitution): ReadonlyArray<unknown> =>
  [...value.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([parameter_, argument]) => ({
      tag: 'SubstitutionEntry',
      parameter: parameter_,
      argument: encodeGenericArgumentNode(argument),
    }))

const genericArgumentMatchesKind = (
  argument: Type.GenericArgument,
  kind: Type.ParameterKind,
): boolean => {
  if (Type.isUnavailableGenericArgument(argument)) return argument.expectedKind === kind
  switch (kind) {
    case 'Lifetime':
      return Lifetime.isLifetime(argument)
    case 'Value':
      return Type.isTypeArgument(argument)
    case 'RequirementRow':
      return Type.isRequirementRowArgument(argument)
    default:
      return (
        Type.isRepresentationArgument(argument) &&
        Type.representationArgumentKind(argument) === kind
      )
  }
}

const decodeSubstitution = (
  value: unknown,
  parameters: ReadonlyArray<Type.Parameter>,
  context: string,
): Type.Substitution => {
  const domain = new Map<string, Type.Parameter>()
  for (const parameter of parameters) {
    const key_ = Type.key(parameter)
    if (domain.has(key_))
      throw new InvalidModuleSurfaceEncoding(`${context} has a duplicate parameter domain`)
    domain.set(key_, parameter)
  }

  const substitution = new Map<string, Type.GenericArgument>()
  let previous: string | undefined
  for (const entry of serializedArray(value, context)) {
    const encoded = serializedRecord(entry, `${context} entry`)
    if (serializedTag(encoded, `${context} entry`) !== 'SubstitutionEntry')
      throw new InvalidModuleSurfaceEncoding(`${context} entry has the wrong tag`)
    const key_ = serializedString(encoded.parameter, `${context} parameter`)
    if (substitution.has(key_))
      throw new InvalidModuleSurfaceEncoding(`${context} contains a duplicate parameter`)
    if (previous !== undefined && compareText(previous, key_) >= 0)
      throw new InvalidModuleSurfaceEncoding(`${context} entries are not in canonical order`)
    const parameter = domain.get(key_)
    if (parameter === undefined)
      throw new InvalidModuleSurfaceEncoding(`${context} contains an unknown parameter`)
    const argument = decodeGenericArgumentNode(encoded.argument)
    if (!genericArgumentMatchesKind(argument, parameter.kind))
      throw new InvalidModuleSurfaceEncoding(`${context} argument has the wrong kind`)
    substitution.set(key_, argument)
    previous = key_
  }
  return substitution
}

const parametersInFailureRow = (row: Type.FailureRow): ReadonlyArray<Type.Parameter> =>
  Type.parameters(
    Type.effectWithRows(
      Type.unit,
      row,
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      RowAlgebra.concrete(Type.requirementRowPolicy(), []),
    ),
  )

const parametersInRequirementRow = (row: Type.RequirementsRow): ReadonlyArray<Type.Parameter> =>
  Type.parameters(
    Type.effectWithRows(
      Type.unit,
      RowAlgebra.concrete(Type.failureRowPolicy(), []),
      { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
      'Shared',
      row,
    ),
  )

const constraintParameters = (
  value: ContractConstraint.Constraint,
): ReadonlyArray<Type.Parameter> => {
  let parameters: ReadonlyArray<Type.Parameter>
  switch (value._tag) {
    case 'NominalMemberConstraint':
      parameters = [...Type.parameters(value.selected), ...parametersInFailureRow(value.source)]
      break
    case 'FailureSubsetConstraint':
      parameters = [
        ...parametersInFailureRow(value.selected),
        ...parametersInFailureRow(value.source),
      ]
      break
    case 'RequirementSubsetConstraint':
      parameters = [
        ...parametersInRequirementRow(value.selected),
        ...parametersInRequirementRow(value.source),
      ]
      break
    case 'ProviderSelectionConstraint':
      parameters = [
        ...Type.parameters(value.provider),
        ...parametersInRequirementRow(value.selected),
        ...parametersInRequirementRow(value.source),
      ]
      break
  }
  return [
    ...new Map(parameters.map((parameter) => [Type.key(parameter), parameter])).values(),
  ].sort(Type.compare)
}

const encodeExecutableOwner = (value: Type.ExecutableSpecializationOwner): SerializedRecord => ({
  tag: 'ExecutableOwner',
  declaration: { module: value.declaration.module, name: value.declaration.name },
  typeArguments: value.typeArguments.map(encodeGenericArgumentNode),
  staticArgumentKeys: value.staticArgumentKeys,
})

const decodeExecutableOwner = (value: unknown): Type.ExecutableSpecializationOwner => {
  const encoded = serializedRecord(value, 'executable owner')
  if (serializedTag(encoded, 'executable owner') !== 'ExecutableOwner')
    throw new InvalidModuleSurfaceEncoding('executable owner has the wrong tag')
  const declaration = serializedRecord(encoded.declaration, 'executable owner declaration')
  return {
    declaration: {
      module: serializedString(declaration.module, 'executable owner module'),
      name: serializedString(declaration.name, 'executable owner name'),
    },
    typeArguments: serializedArray(encoded.typeArguments, 'executable owner arguments').map(
      decodeGenericArgumentNode,
    ),
    staticArgumentKeys: serializedArray(
      encoded.staticArgumentKeys,
      'executable owner static arguments',
    ).map((key) => serializedString(key, 'executable owner static argument')),
  }
}

function encodeLifetime(value: Lifetime.Lifetime): SerializedRecord {
  switch (value._tag) {
    case 'IntersectionLifetime':
      return { tag: 'IntersectionLifetime', members: value.members.map(encodeLifetime) }
    case 'StaticLifetime':
      return { tag: 'StaticLifetime' }
    case 'BoundLifetime':
      return {
        tag: 'BoundLifetime',
        owner: value.owner,
        binder: value.binder,
        ordinal: value.ordinal,
        name: value.name,
      }
    case 'LocalLifetime':
      return {
        tag: 'LocalLifetime',
        owner: value.owner,
        context: value.context,
        ordinal: value.ordinal,
      }
    case 'PlaceholderLifetime':
      return {
        tag: 'PlaceholderLifetime',
        parameter: encodeLifetime(value.parameter),
        universe: value.universe,
      }
  }
}

function decodeLifetime(value: unknown): Lifetime.Lifetime {
  const encoded = serializedRecord(value, 'lifetime')
  const tag = serializedTag(encoded, 'lifetime')
  if (tag === 'StaticLifetime') return Lifetime.staticLifetime
  if (tag === 'IntersectionLifetime')
    return Lifetime.intersection(
      serializedArray(encoded.members, 'intersection members').map(decodeLifetime),
    )
  if (tag === 'PlaceholderLifetime') {
    const parameter = decodeLifetime(encoded.parameter)
    if (parameter._tag !== 'BoundLifetime')
      throw new InvalidModuleSurfaceEncoding('placeholder parameter must be a lifetime binder')
    return Lifetime.placeholder(
      parameter,
      serializedString(encoded.universe, 'placeholder universe'),
    )
  }
  const ownerRecord = serializedRecord(encoded.owner, 'lifetime owner')
  const owner = {
    module: serializedString(ownerRecord.module, 'lifetime owner module'),
    name: serializedString(ownerRecord.name, 'lifetime owner name'),
  }
  const ordinal = serializedNonNegativeInteger(encoded.ordinal, 'lifetime ordinal')
  if (tag === 'BoundLifetime')
    return Lifetime.bound(
      owner,
      ordinal,
      serializedString(encoded.name, 'lifetime name'),
      serializedArray(encoded.binder, 'lifetime binder path').map((part) =>
        serializedNonNegativeInteger(part, 'lifetime binder ordinal'),
      ),
    )
  if (tag === 'LocalLifetime')
    return Lifetime.local(owner, serializedString(encoded.context, 'lifetime context'), ordinal)
  throw new InvalidModuleSurfaceEncoding(`unknown lifetime tag ${tag}`)
}

const encodeExecutableLifetimes = (
  value: Type.ExecutableLifetimes,
  parameterCount?: number,
): SerializedRecord => {
  if (
    Type.invocationUseState(value) !== 'Closed' ||
    (value.invocationUse !== undefined && parameterCount === undefined) ||
    !Type.invocationUseValid(value.invocationUse, parameterCount ?? 0, value.lifetimeBinders, {
      state: 'Closed',
    })
  )
    throw new InvalidModuleSurfaceEncoding('invalid closed invocation-use metadata')
  return {
    environment: encodeLifetime(value.environment),
    lifetimeBinders: value.lifetimeBinders.map(encodeLifetime),
    lifetimeBounds: (value.lifetimeBounds ?? []).map((bound) => ({
      longer: encodeLifetime(bound.longer),
      shorter: encodeLifetime(bound.shorter),
    })),
    typeOutlives: (value.typeOutlives ?? []).map((bound) => ({
      type: encodeTypeNode(bound.type),
      lifetime: encodeLifetime(bound.lifetime),
    })),
    ...(value.invocationUse === undefined
      ? {}
      : {
          invocationUse: {
            lifetime: encodeLifetime(value.invocationUse.lifetime),
            parameters: Array.from(value.invocationUse.parameters),
          },
        }),
  }
}

const decodeExecutableLifetimes = (
  encoded: SerializedRecord,
  parameterCount?: number,
): Type.ExecutableLifetimes => {
  const lifetimeBinders = serializedArray(encoded.lifetimeBinders, 'lifetime binders').map(
    (value) => {
      const lifetime = decodeLifetime(value)
      if (lifetime._tag !== 'BoundLifetime')
        throw new InvalidModuleSurfaceEncoding('executable lifetime binder must be universal')
      return lifetime
    },
  )
  if (new Set(lifetimeBinders.map(Lifetime.key)).size !== lifetimeBinders.length)
    throw new InvalidModuleSurfaceEncoding('executable lifetime binders must be distinct')
  const invocationUse =
    encoded.invocationUse === undefined
      ? undefined
      : (() => {
          const usage = serializedRecord(encoded.invocationUse, 'invocation use')
          return {
            lifetime: decodeLifetime(usage.lifetime),
            parameters: serializedArray(usage.parameters, 'invocation use parameters').map(
              (parameter) => serializedNonNegativeInteger(parameter, 'invocation use parameter'),
            ),
          }
        })()
  if (
    (invocationUse !== undefined && parameterCount === undefined) ||
    !Type.invocationUseValid(invocationUse, parameterCount ?? 0, lifetimeBinders, {
      state: 'Closed',
    })
  )
    throw new InvalidModuleSurfaceEncoding('invalid closed invocation-use metadata')
  return {
    environment: decodeLifetime(encoded.environment),
    lifetimeBinders,
    ...(invocationUse === undefined ? {} : { invocationUse }),
    lifetimeBounds: serializedArray(encoded.lifetimeBounds, 'lifetime bounds').map((value) => {
      const bound = serializedRecord(value, 'lifetime bound')
      return { longer: decodeLifetime(bound.longer), shorter: decodeLifetime(bound.shorter) }
    }),
    typeOutlives: serializedArray(encoded.typeOutlives, 'type outlives bounds').map((value) => {
      const bound = serializedRecord(value, 'type outlives bound')
      return { type: decodeTypeNode(bound.type), lifetime: decodeLifetime(bound.lifetime) }
    }),
  }
}

function encodeGenericArgumentNode(value: Type.GenericArgument): SerializedRecord {
  if (Lifetime.isLifetime(value))
    return { tag: 'LifetimeArgument', lifetime: encodeLifetime(value) }
  if (Type.isRequirementRowArgument(value))
    return { tag: 'RequirementRowArgument', row: encodeRequirementRow(value.row) }
  if (Type.isEffectIdentityArgument(value))
    return {
      tag: 'EffectIdentityArgument',
      identity: value.identity,
      ...(value.owner === undefined ? {} : { owner: encodeExecutableOwner(value.owner) }),
    }
  if (Type.isCallableIdentityArgument(value))
    return {
      tag: 'CallableIdentityArgument',
      identity: value.identity,
      target: value.target,
      typeArguments: value.typeArguments.map(encodeGenericArgumentNode),
      ...(value.environment === undefined
        ? {}
        : {
            environment: {
              tag: 'CallableEnvironment',
              site: value.environment.site,
              owner: encodeExecutableOwner(value.environment.owner),
            },
          }),
    }
  if (Type.isRepresentationParameterArgument(value))
    return { tag: 'RepresentationParameterArgument', parameter: encodeParameter(value.parameter) }
  if (Type.isOpaqueRepresentationArgument(value))
    return {
      tag: 'OpaqueRepresentationArgument',
      family: value.family,
      contract: encodeTypeNode(value.contract),
      arguments: value.arguments.map(encodeGenericArgumentNode),
    }
  if (Type.isExactRepresentationArgument(value))
    return {
      tag: 'ExactRepresentationArgument',
      identity: encodeGenericArgumentNode(value.identity),
      contract: encodeTypeNode(value.contract),
    }
  if (Type.isCompositeEffectRepresentationArgument(value))
    return {
      tag: 'CompositeEffectRepresentationArgument',
      contract: encodeTypeNode(value.contract),
      alternatives: value.alternatives.map(encodeGenericArgumentNode),
    }
  if (Type.isUnavailableGenericArgument(value))
    return { tag: 'UnavailableGenericArgument', ...value }
  return { tag: 'TypeArgument', type: encodeTypeNode(value) }
}

function decodeCallableTarget(value: unknown): Type.CallableIdentityArgument['target'] {
  const target = serializedRecord(value, 'callable target')
  const targetTag = serializedString(target._tag, 'callable target tag')
  switch (targetTag) {
    case 'Declaration':
      return {
        _tag: 'Declaration',
        module: serializedString(target.module, 'callable target module'),
        name: serializedString(target.name, 'callable target name'),
      }
    case 'Builtin': {
      const operation = serializedString(target.operation, 'callable target operation')
      if (!Type.isBuiltinOperation(operation))
        throw new InvalidModuleSurfaceEncoding(`unknown callable target operation ${operation}`)
      const intrinsic = serializedRecord(target.intrinsic, 'callable target intrinsic')
      return {
        _tag: 'Builtin',
        actor: serializedString(target.actor, 'callable target actor'),
        operation,
        intrinsic: {
          actor: serializedString(intrinsic.actor, 'intrinsic actor'),
          name: serializedString(intrinsic.name, 'intrinsic name'),
        },
      }
    }
    default:
      throw new InvalidModuleSurfaceEncoding(`unknown callable target ${targetTag}`)
  }
}

function decodeCallableEnvironment(value: unknown): Type.CallableEnvironmentIdentity | undefined {
  if (value === undefined) return undefined
  const current = serializedRecord(value, 'callable environment')
  if (serializedTag(current, 'callable environment') !== 'CallableEnvironment')
    throw new InvalidModuleSurfaceEncoding('callable environment has the wrong tag')
  const site = serializedRecord(current.site, 'callable environment site')
  const siteTag = serializedString(site._tag, 'callable environment site tag')
  let decodedSite: Type.CallableEnvironmentSite
  switch (siteTag) {
    case 'DeclaredCallableEnvironmentSite': {
      const declaration = serializedRecord(site.declaration, 'callable environment declaration')
      decodedSite = {
        _tag: 'DeclaredCallableEnvironmentSite',
        declaration: {
          module: serializedString(declaration.module, 'environment module'),
          name: serializedString(declaration.name, 'environment name'),
        },
        ordinal: serializedNonNegativeInteger(site.ordinal, 'environment ordinal'),
      }
      break
    }
    case 'RecoveredCallableEnvironmentSite':
      decodedSite = {
        _tag: 'RecoveredCallableEnvironmentSite',
        functionOrdinal: serializedNonNegativeInteger(
          site.functionOrdinal,
          'environment function ordinal',
        ),
        ordinal: serializedNonNegativeInteger(site.ordinal, 'environment ordinal'),
      }
      break
    default:
      throw new InvalidModuleSurfaceEncoding(`unknown callable environment site ${siteTag}`)
  }
  return {
    _tag: 'CallableEnvironmentIdentity',
    site: decodedSite,
    owner: decodeExecutableOwner(current.owner),
  }
}

function decodeGenericArgumentNode(value: unknown): Type.GenericArgument {
  const encoded = serializedRecord(value, 'generic argument')
  switch (serializedTag(encoded, 'generic argument')) {
    case 'RequirementRowArgument':
      return Type.requirementRowArgumentFromRow(decodeRequirementRow(encoded.row))
    case 'EffectIdentityArgument':
      return Type.effectIdentityArgument(
        serializedString(encoded.identity, 'effect identity'),
        encoded.owner === undefined ? undefined : decodeExecutableOwner(encoded.owner),
      )
    case 'CallableIdentityArgument': {
      const decodedTarget = decodeCallableTarget(encoded.target)
      const environment = decodeCallableEnvironment(encoded.environment)
      return Type.callableIdentityArgument(
        serializedString(encoded.identity, 'callable identity'),
        decodedTarget,
        serializedArray(encoded.typeArguments, 'callable identity arguments').map(
          decodeGenericArgumentNode,
        ),
        environment,
      )
    }
    case 'RepresentationParameterArgument':
      return Type.representationParameterArgument(decodeRepresentationParameter(encoded.parameter))
    case 'OpaqueRepresentationArgument': {
      const contract = decodeTypeNode(encoded.contract)
      if (!Type.isCallable(contract) && !Type.isEffect(contract))
        throw new InvalidModuleSurfaceEncoding(
          'opaque representation contract must be callable or Effect',
        )
      const family = serializedRecord(encoded.family, 'opaque family')
      if (serializedString(family._tag, 'opaque family tag') !== 'OpaqueFamilyKey')
        throw new InvalidModuleSurfaceEncoding('opaque family has the wrong tag')
      const producer = serializedRecord(family.producer, 'opaque family producer')
      return Type.opaqueRepresentationArgument(
        {
          _tag: 'OpaqueFamilyKey',
          producer: {
            module: serializedString(producer.module, 'opaque producer module'),
            name: serializedString(producer.name, 'opaque producer name'),
          },
          binderOrdinal: serializedNonNegativeInteger(
            family.binderOrdinal,
            'opaque binder ordinal',
          ),
        },
        contract,
        serializedArray(encoded.arguments, 'opaque arguments').map(decodeGenericArgumentNode),
      )
    }
    case 'ExactRepresentationArgument': {
      const identity = decodeGenericArgumentNode(encoded.identity)
      const contract = decodeTypeNode(encoded.contract)
      if (
        !(
          (Type.isCallableIdentityArgument(identity) && Type.isCallable(contract)) ||
          (Type.isEffectIdentityArgument(identity) && Type.isEffect(contract))
        )
      )
        throw new InvalidModuleSurfaceEncoding(
          'exact representation has an invalid identity or contract',
        )
      return Type.exactRepresentationArgument(identity, contract)
    }
    case 'CompositeEffectRepresentationArgument': {
      const contract = decodeTypeNode(encoded.contract)
      const alternatives = serializedArray(encoded.alternatives, 'composite alternatives').map(
        decodeGenericArgumentNode,
      )
      if (
        !Type.isEffect(contract) ||
        alternatives.some(
          (alternative) =>
            !Type.isExactRepresentationArgument(alternative) ||
            !Type.isEffect(alternative.contract) ||
            !Type.isEffectIdentityArgument(alternative.identity),
        )
      )
        throw new InvalidModuleSurfaceEncoding('composite Effect representation is invalid')
      return Type.compositeEffectRepresentationArgument(
        contract,
        alternatives.filter(Type.isExactRepresentationArgument),
      )
    }
    case 'UnavailableGenericArgument':
      return Type.unavailableGenericArgument(
        decodeParameterKind(encoded.expectedKind, 'unavailable expected kind'),
        serializedString(encoded.reason, 'unavailable reason'),
      )
    case 'LifetimeArgument':
      return decodeLifetime(encoded.lifetime)
    case 'TypeArgument':
      return decodeTypeNode(encoded.type)
    default:
      throw new InvalidModuleSurfaceEncoding(
        `unknown generic argument ${serializedTag(encoded, 'generic argument')}`,
      )
  }
}

function encodeTypeNode(value: Type.Type): unknown {
  if (typeof value === 'string') return { tag: 'Atom', value }
  if (Type.isString(value)) return { tag: 'String', lifetime: encodeLifetime(value.lifetime) }
  if (Type.isNominal(value))
    return {
      tag: 'Nominal',
      module: value.module,
      name: value.name,
      arguments: value.arguments.map(encodeGenericArgumentNode),
    }
  if (Type.isParameter(value)) return encodeParameter(value)
  if (Type.isFixedArray(value))
    return { tag: 'FixedArray', element: encodeTypeNode(value.element), length: value.length }
  if (Type.isSlice(value))
    return {
      tag: 'Slice',
      access: value.access,
      element: encodeTypeNode(value.element),
      lifetime: encodeLifetime(value.lifetime),
    }
  if (Type.isReference(value))
    return {
      tag: 'Reference',
      access: value.access,
      target: encodeTypeNode(value.target),
      lifetime: encodeLifetime(value.lifetime),
    }
  if (Type.isPointer(value))
    return {
      tag: 'Pointer',
      mutable: value.mutable,
      nullable: value.nullable,
      extent: value.extent,
      alignment: value.alignment,
      addressSpace: value.addressSpace,
      pointee: encodeTypeNode(value.pointee),
    }
  if (Type.isCallable(value)) {
    if (
      value.schema !== undefined &&
      (value.invocationUse !== undefined ||
        value.schema.contract.invocationUse !== undefined ||
        value.schema.invocationAdapter !== undefined) &&
      !callableSchemaMatches(value, value.schema)
    )
      throw new InvalidModuleSurfaceEncoding(
        'callable signature disagrees with its specialized schema contract',
      )
    return {
      tag: 'Callable',
      ...encodeExecutableLifetimes(value, value.parameters.length),
      unsafe: value.unsafe,
      mode: value.mode,
      parameters: value.parameters.map(encodeTypeNode),
      result: encodeTypeNode(value.result),
      ...(value.schema === undefined
        ? {}
        : {
            schema: {
              tag: 'CallableSchema',
              ...(value.schema.source === undefined ? {} : { source: value.schema.source }),
              contract: encodeCallableContract(value.schema.contract),
              ...(value.schema.invocationAdapter === undefined
                ? {}
                : {
                    invocationAdapter: {
                      binder: encodeLifetime(value.schema.invocationAdapter.binder),
                      originalInputs: Array.from(value.schema.invocationAdapter.originalInputs),
                      parameters: Array.from(value.schema.invocationAdapter.parameters),
                      lifetimes: value.schema.invocationAdapter.lifetimes.map((slot) => ({
                        parameter: encodeParameter(slot.parameter),
                        lifetime: encodeLifetime(slot.lifetime),
                      })),
                    },
                  }),
              binders: value.schema.binders.map(encodeParameter),
              constraints: value.schema.constraints.map(encodeConstraintNode),
              evidence: value.schema.evidence.map(encodeConstraintEvidenceNode),
              substitution: encodeSubstitution(value.schema.substitution),
              contractKey: value.schema.contractKey,
              constraintKeys: value.schema.constraintKeys,
              evidenceKeys: value.schema.evidenceKeys,
            },
          }),
    }
  }
  if (Type.isForeignFunction(value))
    return {
      tag: 'ForeignFunction',
      ...encodeExecutableLifetimes(value),
      nullable: false,
      contract: value.contract,
      parameters: value.parameters.map(encodeTypeNode),
      result: encodeTypeNode(value.result),
    }
  if (Type.isEffect(value))
    return {
      tag: 'Effect',
      ...encodeExecutableLifetimes(value),
      success: encodeTypeNode(value.success),
      failureRow: encodeFailureRow(value.failureRow),
      requirementRow: encodeRequirementRow(value.requirementRow),
      access: value.access,
    }
  if (Type.isRepresented(value))
    return {
      tag: 'Represented',
      contract: encodeTypeNode(value.contract),
      requiredBound: encodeTypeNode(value.representation.requiredBound),
      argument: encodeGenericArgumentNode(value.representation.argument),
      admissibility: value.representation.admissibility,
    }
  return { tag: 'Union', members: value.members.map(encodeTypeNode) }
}

function encodeCallableContract(value: CallableContract.CallableContract): SerializedRecord {
  const originalInputs = Type.callableInputOrdinals(value)
  if (value.invocationUse !== undefined && originalInputs === undefined)
    throw new InvalidModuleSurfaceEncoding('invalid marked callable capture suffix')
  return {
    tag: 'CallableContract',
    ...encodeExecutableLifetimes(value, originalInputs?.length ?? value.parameters.length),
    functionKind: value.functionKind,
    unsafe: value.unsafe,
    binders: value.binders.map(encodeParameter),
    parameters: value.parameters.map((parameter) => ({
      tag: 'CallableParameter',
      type: encodeTypeNode(parameter.type),
      mode: parameter.mode,
    })),
    result: encodeTypeNode(value.result),
    constraints: value.constraints.map(encodeConstraintNode),
    captures: value.captures.map((capture) => ({
      tag: 'CaptureRelationship',
      parameter: capture.parameter,
      capture: capture.capture,
    })),
  }
}

function decodeCallableContract(value: unknown): CallableContract.CallableContract {
  const encoded = serializedRecord(value, 'callable contract')
  if (serializedTag(encoded, 'callable contract') !== 'CallableContract')
    throw new InvalidModuleSurfaceEncoding('callable contract has the wrong tag')
  const functionKind = serializedString(encoded.functionKind, 'callable contract function kind')
  if (functionKind !== 'Function' && functionKind !== 'Effect')
    throw new InvalidModuleSurfaceEncoding('callable contract has an invalid function kind')
  const parameters = serializedArray(encoded.parameters, 'callable contract parameters').map(
    (value_) => {
      const parameter = serializedRecord(value_, 'callable contract parameter')
      if (serializedTag(parameter, 'callable contract parameter') !== 'CallableParameter')
        throw new InvalidModuleSurfaceEncoding('callable contract parameter has the wrong tag')
      return {
        type: decodeTypeNode(parameter.type),
        mode: decodeCallableParameterMode(parameter.mode, 'callable contract parameter mode'),
      }
    },
  )
  const captures = serializedArray(encoded.captures, 'callable contract captures').map((value_) => {
    const capture = serializedRecord(value_, 'callable contract capture')
    if (serializedTag(capture, 'callable contract capture') !== 'CaptureRelationship')
      throw new InvalidModuleSurfaceEncoding('callable contract capture has the wrong tag')
    const parameter = serializedNonNegativeInteger(
      capture.parameter,
      'callable contract capture parameter',
    )
    const captured = serializedNonNegativeInteger(
      capture.capture,
      'callable contract capture ordinal',
    )
    if (parameter >= parameters.length)
      throw new InvalidModuleSurfaceEncoding('callable contract capture is out of bounds')
    return { parameter, capture: captured }
  })
  let inputCount = parameters.length
  if (encoded.invocationUse !== undefined) {
    inputCount -= captures.length
    if (
      inputCount < 0 ||
      !captures.every(
        (capture, ordinal) =>
          capture.capture === ordinal && capture.parameter === inputCount + ordinal,
      )
    )
      throw new InvalidModuleSurfaceEncoding('invalid marked callable capture suffix')
  }
  return CallableContract.make({
    ...decodeExecutableLifetimes(encoded, inputCount),
    functionKind,
    unsafe: serializedBoolean(encoded.unsafe, 'callable contract unsafe qualifier'),
    binders: serializedArray(encoded.binders, 'callable contract binders').map(decodeParameter),
    parameters,
    result: decodeTypeNode(encoded.result),
    constraints: serializedArray(encoded.constraints, 'callable contract constraints').map(
      decodeConstraintNode,
    ),
    captures,
  })
}

const sameKeys = (left: ReadonlyArray<string>, right: ReadonlyArray<string>): boolean =>
  left.length === right.length && left.every((key_, ordinal) => key_ === right.at(ordinal))

const sameTypes = (left: ReadonlyArray<Type.Type>, right: ReadonlyArray<Type.Type>): boolean =>
  left.length === right.length &&
  left.every((type, ordinal) => {
    const other = right.at(ordinal)
    return other !== undefined && Type.equals(type, other)
  })

const callableSchemaMatches = (callable: Type.Callable, schema: Type.CallableSchema): boolean => {
  const { parameters, result } = callable
  const contractParameters = schema.contract.parameters.map((parameter) =>
    Type.substitute(parameter.type, schema.substitution),
  )
  const adapter = schema.invocationAdapter
  if (adapter !== undefined) {
    if (
      adapter.binder._tag !== 'BoundLifetime' ||
      !Type.invocationAdapterValid(callable.invocationUse, parameters.length, schema)
    )
      return false
    const mapped = adapter.parameters.map((ordinal) => contractParameters.at(ordinal))
    if (
      !mapped.every((parameter, ordinal) => {
        const visible = parameters.at(ordinal)
        return parameter !== undefined && visible !== undefined && Type.equals(parameter, visible)
      })
    )
      return false
    // Original target obligations remain selected obligations, rather than becoming use premises.
    const selectedBounds = schema.contract.lifetimeBounds.map((bound) => ({
      longer: Type.substituteLifetime(bound.longer, schema.substitution),
      shorter: Type.substituteLifetime(bound.shorter, schema.substitution),
    }))
    const selectedTypeBounds = schema.contract.typeOutlives.map((bound) => ({
      type: Type.substitute(bound.type, schema.substitution),
      lifetime: Type.substituteLifetime(bound.lifetime, schema.substitution),
    }))
    if (
      !selectedBounds.every((bound) =>
        callable.lifetimeBounds.some(
          (retained) =>
            Lifetime.equals(bound.longer, retained.longer) &&
            Lifetime.equals(bound.shorter, retained.shorter),
        ),
      )
    )
      return false
    if (
      !selectedTypeBounds.every((bound) =>
        callable.typeOutlives.some(
          (retained) =>
            Type.equals(bound.type, retained.type) &&
            Lifetime.equals(bound.lifetime, retained.lifetime),
        ),
      )
    )
      return false
    return Type.equals(result, Type.substitute(schema.contract.result, schema.substitution))
  }
  const usage = callable.invocationUse
  const originalUsage = schema.contract.invocationUse
  if (
    (usage === undefined) !== (originalUsage === undefined) ||
    (usage !== undefined &&
      originalUsage !== undefined &&
      !Lifetime.equals(usage.lifetime, originalUsage.lifetime))
  )
    return false
  const leading = contractParameters.at(0)
  const fullReference = sameTypes(parameters, contractParameters)
  const leadingSection =
    parameters.length === 1 &&
    leading !== undefined &&
    Type.equals(parameters.at(0) ?? 'never', leading)
  return (
    (fullReference || leadingSection) &&
    Type.equals(result, Type.substitute(schema.contract.result, schema.substitution))
  )
}

function decodeCallableSchemaNode(value: unknown): Type.CallableSchema {
  const current = serializedRecord(value, 'callable schema')
  if (serializedTag(current, 'callable schema') !== 'CallableSchema')
    throw new InvalidModuleSurfaceEncoding('callable schema has the wrong tag')
  const contract = decodeCallableContract(current.contract)
  const binders = serializedArray(current.binders, 'schema binders').map(decodeParameter)
  const constraints = serializedArray(current.constraints, 'schema constraints').map(
    decodeConstraintNode,
  )
  const evidence = serializedArray(current.evidence, 'schema evidence').map(
    decodeConstraintEvidenceNode,
  )
  const contractKey = serializedString(current.contractKey, 'schema contract key')
  const constraintKeys = serializedArray(current.constraintKeys, 'schema constraint keys').map(
    (key_) => serializedString(key_, 'schema constraint key'),
  )
  const evidenceKeys = serializedArray(current.evidenceKeys, 'schema evidence keys').map((key_) =>
    serializedString(key_, 'schema evidence key'),
  )
  if (contractKey !== CallableContract.key(contract))
    throw new InvalidModuleSurfaceEncoding('callable schema has inconsistent contract branding')
  if (
    !sameKeys(binders.map(Type.key), contract.binders.map(Type.key)) ||
    !sameKeys(
      constraints.map(ContractConstraint.key),
      contract.constraints.map(ContractConstraint.key),
    )
  )
    throw new InvalidModuleSurfaceEncoding('callable schema disagrees with its branded contract')
  if (!sameKeys(constraintKeys, constraints.map(ContractConstraint.key)))
    throw new InvalidModuleSurfaceEncoding('callable schema has inconsistent constraint branding')
  if (!sameKeys(evidenceKeys, evidence.map(ContractConstraint.evidenceKey)))
    throw new InvalidModuleSurfaceEncoding('callable schema has inconsistent evidence branding')
  const substitution = decodeSubstitution(
    current.substitution,
    contract.binders,
    'callable schema substitution',
  )
  const invocationAdapter =
    current.invocationAdapter === undefined
      ? undefined
      : (() => {
          const adapter = serializedRecord(current.invocationAdapter, 'invocation adapter')
          const binder = decodeLifetime(adapter.binder)
          if (binder._tag !== 'BoundLifetime')
            throw new InvalidModuleSurfaceEncoding(
              'closed invocation adapter must retain its original binder',
            )
          return {
            binder,
            originalInputs: serializedArray(
              adapter.originalInputs,
              'original invocation inputs',
            ).map((ordinal) => serializedNonNegativeInteger(ordinal, 'original invocation input')),
            parameters: serializedArray(adapter.parameters, 'invocation adapter parameters').map(
              (ordinal) => serializedNonNegativeInteger(ordinal, 'invocation adapter parameter'),
            ),
            lifetimes: serializedArray(adapter.lifetimes, 'invocation adapter lifetime slots').map(
              (value) => {
                const slot = serializedRecord(value, 'invocation adapter lifetime slot')
                const parameter = decodeParameterOfKind(
                  slot.parameter,
                  'Lifetime',
                  'invocation adapter slot',
                )
                return { parameter, lifetime: decodeLifetime(slot.lifetime) }
              },
            ),
          }
        })()
  const source =
    current.source === undefined ? undefined : serializedRecord(current.source, 'schema source')
  return {
    ...(source === undefined
      ? {}
      : {
          source: {
            module: serializedString(source.module, 'schema source module'),
            name: serializedString(source.name, 'schema source name'),
          },
        }),
    contract,
    ...(invocationAdapter === undefined ? {} : { invocationAdapter }),
    binders,
    constraints,
    evidence,
    substitution,
    contractKey,
    constraintKeys,
    evidenceKeys,
    origins: [],
  }
}

function decodeTypeNode(value: unknown): Type.Type {
  const encoded = serializedRecord(value, 'type')
  switch (serializedTag(encoded, 'type')) {
    case 'Atom': {
      const atom = serializedString(encoded.value, 'type atom')
      if (!Type.isBuiltin(atom) && atom !== 'never')
        throw new InvalidModuleSurfaceEncoding(`unknown type atom ${atom}`)
      return atom
    }
    case 'String':
      return Type.string(decodeLifetime(encoded.lifetime))
    case 'Nominal':
      return Type.nominal(
        serializedString(encoded.module, 'nominal module'),
        serializedString(encoded.name, 'nominal name'),
        serializedArray(encoded.arguments, 'nominal arguments').map(decodeGenericArgumentNode),
      )
    case 'Parameter':
      return decodeParameterOfKind(encoded, 'Value', 'ordinary type parameter')
    case 'FixedArray':
      return Type.fixedArray(
        decodeTypeNode(encoded.element),
        serializedNonNegativeInteger(encoded.length, 'array length'),
      )
    case 'Slice': {
      const access = serializedString(encoded.access, 'slice access')
      if (access !== 'Shared' && access !== 'Exclusive')
        throw new InvalidModuleSurfaceEncoding('slice access must be Shared or Exclusive')
      return Type.slice(access, decodeTypeNode(encoded.element), decodeLifetime(encoded.lifetime))
    }
    case 'Reference': {
      const access = serializedString(encoded.access, 'reference access')
      if (access !== 'Shared' && access !== 'Exclusive')
        throw new InvalidModuleSurfaceEncoding('reference access must be Shared or Exclusive')
      return Type.reference(
        access,
        decodeTypeNode(encoded.target),
        decodeLifetime(encoded.lifetime),
      )
    }
    case 'Pointer': {
      const extent = serializedString(encoded.extent, 'pointer extent')
      if (extent !== 'Single' && extent !== 'Many')
        throw new InvalidModuleSurfaceEncoding('pointer extent must be Single or Many')
      const alignment =
        encoded.alignment === 'Natural'
          ? 'Natural'
          : serializedNonNegativeInteger(encoded.alignment, 'pointer alignment')
      if (alignment !== 'Natural' && !Type.isPointerAlignment(alignment))
        throw new InvalidModuleSurfaceEncoding('invalid pointer alignment')
      const addressSpace = serializedNonNegativeInteger(
        encoded.addressSpace,
        'pointer address space',
      )
      if (addressSpace !== 0)
        throw new InvalidModuleSurfaceEncoding('unsupported pointer address space')
      return Type.pointer({
        mutable: serializedBoolean(encoded.mutable, 'pointer mutability'),
        nullable: serializedBoolean(encoded.nullable, 'pointer nullability'),
        extent,
        alignment,
        addressSpace,
        pointee: decodeTypeNode(encoded.pointee),
      })
    }
    case 'Callable': {
      const mode = serializedString(encoded.mode, 'callable mode')
      if (mode !== 'Shared' && mode !== 'Exclusive' && mode !== 'Take')
        throw new InvalidModuleSurfaceEncoding('invalid callable mode')
      const parameters = serializedArray(encoded.parameters, 'callable parameters').map(
        decodeTypeNode,
      )
      const result = decodeTypeNode(encoded.result)
      const schema =
        encoded.schema === undefined ? undefined : decodeCallableSchemaNode(encoded.schema)
      const callable = Type.callable(
        parameters,
        result,
        decodeExecutableLifetimes(encoded, parameters.length),
        mode,
        schema,
        serializedBoolean(encoded.unsafe, 'callable unsafe qualifier'),
      )
      if (schema !== undefined && !callableSchemaMatches(callable, schema))
        throw new InvalidModuleSurfaceEncoding(
          'callable signature disagrees with its specialized schema contract',
        )
      return callable
    }
    case 'ForeignFunction': {
      const parameters = serializedArray(encoded.parameters, 'foreign function parameters').map(
        decodeTypeNode,
      )
      const result = decodeTypeNode(encoded.result)
      const contractType = (type: Type.Type): string => {
        if (Type.isForeignFunction(type)) return 'extern "C" fn()'
        if (Type.isPointer(type) || Type.isReference(type)) return `pointer<${Type.key(type)}>`
        return Type.equals(type, Type.unit) ? 'void' : Type.encode(type)
      }
      const contract = ForeignContract.inspect(
        encoded.contract,
        parameters.map(contractType),
        contractType(result),
      )
      if (
        encoded.nullable !== false ||
        contract === undefined ||
        !ForeignContract.acceptsTypes(contract, parameters, result)
      )
        throw new InvalidModuleSurfaceEncoding('invalid native function pointer contract')
      return Type.foreignFunction(parameters, result, contract, decodeExecutableLifetimes(encoded))
    }
    case 'Effect': {
      const access = serializedString(encoded.access, 'effect access')
      if (access !== 'Shared' && access !== 'Exclusive' && access !== 'Take')
        throw new InvalidModuleSurfaceEncoding('invalid Effect access')
      return Type.effectWithRows(
        decodeTypeNode(encoded.success),
        decodeFailureRow(encoded.failureRow),
        decodeExecutableLifetimes(encoded),
        access,
        decodeRequirementRow(encoded.requirementRow),
      )
    }
    case 'Represented': {
      const contract = decodeTypeNode(encoded.contract)
      const requiredBound = decodeTypeNode(encoded.requiredBound)
      const argument = decodeGenericArgumentNode(encoded.argument)
      if (
        (!Type.isCallable(contract) && !Type.isEffect(contract)) ||
        (!Type.isCallable(requiredBound) && !Type.isEffect(requiredBound)) ||
        !Type.isRepresentationArgument(argument)
      )
        throw new InvalidModuleSurfaceEncoding('invalid represented type')
      return Type.represented(contract, requiredBound, argument)
    }
    case 'Union': {
      const members = serializedArray(encoded.members, 'union members').map(decodeTypeNode)
      const normalized = Type.union(members)
      if (normalized._tag !== 'Normalized')
        throw new InvalidModuleSurfaceEncoding('invalid structural union')
      return normalized.type
    }
    default:
      throw new InvalidModuleSurfaceEncoding(`unknown type ${serializedTag(encoded, 'type')}`)
  }
}

function encodeConstraintNode(value: ContractConstraint.Constraint): SerializedRecord {
  switch (value._tag) {
    case 'NominalMemberConstraint':
      return {
        tag: value._tag,
        selected: encodeTypeNode(value.selected),
        source: encodeFailureRow(value.source),
      }
    case 'FailureSubsetConstraint':
      return {
        tag: value._tag,
        selected: encodeFailureRow(value.selected),
        source: encodeFailureRow(value.source),
      }
    case 'RequirementSubsetConstraint':
      return {
        tag: value._tag,
        selected: encodeRequirementRow(value.selected),
        source: encodeRequirementRow(value.source),
      }
    case 'ProviderSelectionConstraint':
      return {
        tag: value._tag,
        mode: value.mode,
        provider: encodeTypeNode(value.provider),
        selected: encodeRequirementRow(value.selected),
        source: encodeRequirementRow(value.source),
      }
  }
}

function decodeConstraintNode(value: unknown): ContractConstraint.Constraint {
  const encoded = serializedRecord(value, 'constraint')
  switch (serializedTag(encoded, 'constraint')) {
    case 'NominalMemberConstraint':
      return ContractConstraint.nominalMember(
        decodeTypeNode(encoded.selected),
        decodeFailureRow(encoded.source),
      )
    case 'FailureSubsetConstraint':
      return ContractConstraint.failureSubset(
        decodeFailureRow(encoded.selected),
        decodeFailureRow(encoded.source),
      )
    case 'RequirementSubsetConstraint':
      return ContractConstraint.requirementSubset(
        decodeRequirementRow(encoded.selected),
        decodeRequirementRow(encoded.source),
      )
    case 'ProviderSelectionConstraint': {
      const mode = serializedString(encoded.mode, 'provider mode')
      if (mode !== 'Shared' && mode !== 'Exclusive' && mode !== 'Take')
        throw new InvalidModuleSurfaceEncoding('invalid provider mode')
      return ContractConstraint.providerSelection(
        mode,
        decodeTypeNode(encoded.provider),
        decodeRequirementRow(encoded.selected),
        decodeRequirementRow(encoded.source),
      )
    }
    default:
      throw new InvalidModuleSurfaceEncoding(
        `unknown constraint ${serializedTag(encoded, 'constraint')}`,
      )
  }
}

function encodeWitnessIdentityNode(value: ContractConstraint.WitnessIdentity): SerializedRecord {
  return {
    tag: 'WitnessIdentity',
    origin:
      value.origin._tag === 'SourceWitness'
        ? {
            tag: 'SourceWitness',
            module: value.origin.declaration.module,
            name: value.origin.declaration.name,
          }
        : { tag: 'IntrinsicWitness', operation: value.origin.operation },
    typeArguments: value.typeArguments.map(encodeGenericArgumentNode),
  }
}

function decodeWitnessOriginNode(
  origin: SerializedRecord,
  originTag: string,
): ContractConstraint.WitnessIdentity['origin'] {
  switch (originTag) {
    case 'SourceWitness':
      return {
        _tag: 'SourceWitness',
        declaration: {
          module: serializedString(origin.module, 'witness module'),
          name: serializedString(origin.name, 'witness name'),
        },
      }
    case 'IntrinsicWitness':
      return {
        _tag: 'IntrinsicWitness',
        operation: serializedString(origin.operation, 'witness operation'),
      }
    default:
      throw new InvalidModuleSurfaceEncoding(`unknown witness origin ${originTag}`)
  }
}

function decodeWitnessIdentityNode(value: unknown): ContractConstraint.WitnessIdentity {
  const encoded = serializedRecord(value, 'witness identity')
  if (serializedTag(encoded, 'witness identity') !== 'WitnessIdentity')
    throw new InvalidModuleSurfaceEncoding('witness identity has the wrong tag')
  const origin = serializedRecord(encoded.origin, 'witness origin')
  const originTag = serializedTag(origin, 'witness origin')
  const typeArguments = serializedArray(encoded.typeArguments, 'witness arguments').map(
    decodeGenericArgumentNode,
  )
  if (typeArguments.some((argument) => !Type.isRuntimeConcreteGenericArgument(argument)))
    throw new InvalidModuleSurfaceEncoding('witness identity retains an open runtime argument')
  return {
    origin: decodeWitnessOriginNode(origin, originTag),
    typeArguments,
  }
}

function encodeProviderMatchNode(value: ContractConstraint.ProviderMatch): SerializedRecord {
  return value._tag === 'Identity'
    ? { tag: 'Identity' }
    : { tag: 'Conformance', witness: encodeWitnessIdentityNode(value.witness) }
}

function decodeProviderMatchNode(value: unknown): ContractConstraint.ProviderMatch {
  const encoded = serializedRecord(value, 'provider match')
  const tag = serializedTag(encoded, 'provider match')
  if (tag === 'Identity') return { _tag: 'Identity' }
  if (tag === 'Conformance')
    return {
      _tag: 'Conformance',
      witness: decodeWitnessIdentityNode(encoded.witness),
    }
  throw new InvalidModuleSurfaceEncoding(`unknown provider match ${tag}`)
}

function encodeConstraintEvidenceNode(
  value: ContractConstraint.ConstraintEvidence,
): SerializedRecord {
  switch (value._tag) {
    case 'Assumed':
      return {
        tag: value._tag,
        wantedKey: value.wantedKey,
        wanted: encodeConstraintNode(value.wanted),
        substitution: encodeSubstitution(value.substitution),
      }
    case 'Member':
      return {
        tag: value._tag,
        selected: encodeTypeNode(value.selected),
        source: encodeFailureRow(value.source),
      }
    case 'FailureSubset':
      return {
        tag: value._tag,
        selected: encodeFailureRow(value.selected),
        source: encodeFailureRow(value.source),
      }
    case 'RequirementSubset':
      return {
        tag: value._tag,
        selected: encodeRequirementRow(value.selected),
        source: encodeRequirementRow(value.source),
      }
    case 'RequirementSelection':
      return {
        tag: value._tag,
        wantedKey: value.wantedKey,
        wanted: encodeConstraintNode(value.wanted),
        selected: encodeRequirement(value.selected),
        provider: encodeTypeNode(value.provider),
        providerMatch: encodeProviderMatchNode(value.providerMatch),
        providerMode: value.providerMode,
      }
  }
}

function decodeConstraintEvidenceNode(value: unknown): ContractConstraint.ConstraintEvidence {
  const encoded = serializedRecord(value, 'constraint evidence')
  switch (serializedTag(encoded, 'constraint evidence')) {
    case 'Assumed': {
      const wanted = decodeConstraintNode(encoded.wanted)
      const wantedKey = serializedString(encoded.wantedKey, 'assumed wanted key')
      if (wantedKey !== ContractConstraint.key(wanted))
        throw new InvalidModuleSurfaceEncoding('assumed evidence has inconsistent wanted branding')
      return ContractConstraint.assumed(
        wanted,
        decodeSubstitution(
          encoded.substitution,
          constraintParameters(wanted),
          'assumed evidence substitution',
        ),
      )
    }
    case 'Member': {
      const selected = decodeTypeNode(encoded.selected)
      if (!Type.isNominal(selected))
        throw new InvalidModuleSurfaceEncoding('member evidence must select a nominal')
      const proof = ContractConstraint.proveStructural(
        ContractConstraint.nominalMember(selected, decodeFailureRow(encoded.source)),
      )
      if (proof?._tag !== 'Member')
        throw new InvalidModuleSurfaceEncoding('member evidence does not prove membership')
      return proof
    }
    case 'FailureSubset': {
      const proof = ContractConstraint.proveStructural(
        ContractConstraint.failureSubset(
          decodeFailureRow(encoded.selected),
          decodeFailureRow(encoded.source),
        ),
      )
      if (proof?._tag !== 'FailureSubset')
        throw new InvalidModuleSurfaceEncoding('failure subset evidence does not prove inclusion')
      return proof
    }
    case 'RequirementSubset': {
      const proof = ContractConstraint.proveStructural(
        ContractConstraint.requirementSubset(
          decodeRequirementRow(encoded.selected),
          decodeRequirementRow(encoded.source),
        ),
      )
      if (proof?._tag !== 'RequirementSubset')
        throw new InvalidModuleSurfaceEncoding(
          'requirement subset evidence does not prove inclusion',
        )
      return proof
    }
    case 'RequirementSelection': {
      const wanted = decodeConstraintNode(encoded.wanted)
      if (wanted._tag !== 'ProviderSelectionConstraint')
        throw new InvalidModuleSurfaceEncoding(
          'requirement selection evidence has the wrong wanted',
        )
      const wantedKey = serializedString(encoded.wantedKey, 'selection wanted key')
      if (wantedKey !== ContractConstraint.key(wanted))
        throw new InvalidModuleSurfaceEncoding(
          'requirement selection evidence has inconsistent wanted branding',
        )
      const providerMode = serializedString(encoded.providerMode, 'evidence provider mode')
      if (providerMode !== 'Shared' && providerMode !== 'Exclusive' && providerMode !== 'Take')
        throw new InvalidModuleSurfaceEncoding('invalid evidence provider mode')
      const provider = decodeTypeNode(encoded.provider)
      if (providerMode !== wanted.mode || !Type.equals(provider, wanted.provider))
        throw new InvalidModuleSurfaceEncoding(
          'requirement selection evidence is inconsistent with its wanted',
        )
      const selected = decodeRequirement(encoded.selected)
      const selectedRow = RowAlgebra.concretize(Type.requirementRowPolicy(), wanted.selected)
      const sourceRow = RowAlgebra.concretize(Type.requirementRowPolicy(), wanted.source)
      if (
        !Type.isRuntimeConcrete(provider) ||
        !Type.isRuntimeConcrete(selected.capability) ||
        !Type.isNominal(selected.capability) ||
        selectedRow._tag !== 'Concrete' ||
        selectedRow.row.members.some((member) => !Type.isRuntimeConcrete(member.capability)) ||
        selectedRow.row.members.length !== 1 ||
        !FiniteRow.has(Type.requirementRowPolicy().finite, selectedRow.row, selected) ||
        sourceRow._tag !== 'Concrete' ||
        sourceRow.row.members.some((member) => !Type.isRuntimeConcrete(member.capability)) ||
        !FiniteRow.has(Type.requirementRowPolicy().finite, sourceRow.row, selected) ||
        !RequirementRow.providerCanSelect(providerMode, selected.access)
      )
        throw new InvalidModuleSurfaceEncoding(
          'requirement selection evidence does not prove one exact source member',
        )
      const providerMatch = decodeProviderMatchNode(encoded.providerMatch)
      const identityMatch = Type.equals(provider, selected.capability)
      if ((providerMatch._tag === 'Identity') !== identityMatch)
        throw new InvalidModuleSurfaceEncoding(
          'requirement selection provider match is inconsistent with provider identity',
        )
      // Module surfaces deliberately own declaration-index-neutral witness identities. This
      // boundary can prove exact provider identity and the selected row relationship; a distinct
      // conformance witness is authenticated later when the declaration index re-solves the wanted.
      return ContractConstraint.requirementSelectionEvidence(wanted, selected, providerMatch)
    }
    default:
      throw new InvalidModuleSurfaceEncoding(
        `unknown constraint evidence ${serializedTag(encoded, 'constraint evidence')}`,
      )
  }
}

const parse = (value: string): unknown => {
  try {
    return JSON.parse(value)
  } catch (cause) {
    throw new InvalidModuleSurfaceEncoding('Invalid module-surface semantic encoding', { cause })
  }
}

const decode = Effect.fnUntraced(function* <A>(
  operation: DecodeOperation,
  value: string,
  decodeValue: (encoded: unknown) => A,
): Effect.fn.Return<A, ModuleSurfaceDecodeError> {
  return yield* Effect.try({
    try: () => decodeValue(parse(value)),
    catch: (cause) => {
      if (!(cause instanceof InvalidModuleSurfaceEncoding)) throw cause
      const detail = cause.message
      return new ModuleSurfaceDecodeError({
        operation,
        message: `Invalid module-surface semantic encoding: ${detail}`,
        reason: { _tag: 'InvalidEncoding', detail },
      })
    },
  })
})

/** Encodes one semantic type as a deterministic, structured module-surface value. */
export const encodeSemanticType = (value: Type.Type): string =>
  JSON.stringify(encodeTypeNode(value))

/** Decodes one structured semantic type, excluding source-location metadata by construction. */
export const decodeSemanticType = Effect.fn('ModuleSurface.decodeSemanticType')(function* (
  value: string,
): Effect.fn.Return<Type.Type, ModuleSurfaceDecodeError> {
  return yield* decode('ModuleSurface.decodeSemanticType', value, decodeTypeNode)
})

/** Encodes and decodes checked constraints without collapsing them to an opaque key. */
export const encodeConstraint = (value: ContractConstraint.Constraint): string =>
  JSON.stringify(encodeConstraintNode(value))
export const decodeConstraint = Effect.fn('ModuleSurface.decodeConstraint')(function* (
  value: string,
): Effect.fn.Return<ContractConstraint.Constraint, ModuleSurfaceDecodeError> {
  return yield* decode('ModuleSurface.decodeConstraint', value, decodeConstraintNode)
})

/** Encodes and decodes exact-wanted-branded constraint evidence. */
export const encodeConstraintEvidence = (value: ContractConstraint.ConstraintEvidence): string =>
  JSON.stringify(encodeConstraintEvidenceNode(value))
export const decodeConstraintEvidence = Effect.fn('ModuleSurface.decodeConstraintEvidence')(
  function* (
    value: string,
  ): Effect.fn.Return<ContractConstraint.ConstraintEvidence, ModuleSurfaceDecodeError> {
    return yield* decode(
      'ModuleSurface.decodeConstraintEvidence',
      value,
      decodeConstraintEvidenceNode,
    )
  },
)

/** Encodes and decodes specialization-complete conformance witness identity. */
export const encodeWitnessIdentity = (value: ContractConstraint.WitnessIdentity): string =>
  JSON.stringify(encodeWitnessIdentityNode(value))
export const decodeWitnessIdentity = Effect.fn('ModuleSurface.decodeWitnessIdentity')(function* (
  value: string,
): Effect.fn.Return<ContractConstraint.WitnessIdentity, ModuleSurfaceDecodeError> {
  return yield* decode('ModuleSurface.decodeWitnessIdentity', value, decodeWitnessIdentityNode)
})

/** Encodes and decodes exact-identity versus conformance provider matches. */
export const encodeProviderMatch = (value: ContractConstraint.ProviderMatch): string =>
  JSON.stringify(encodeProviderMatchNode(value))
export const decodeProviderMatch = Effect.fn('ModuleSurface.decodeProviderMatch')(function* (
  value: string,
): Effect.fn.Return<ContractConstraint.ProviderMatch, ModuleSurfaceDecodeError> {
  return yield* decode('ModuleSurface.decodeProviderMatch', value, decodeProviderMatchNode)
})

const type = (value: Type.Type): string => record('Type', [Type.key(value)])

const canonicalId = (value: DeclarationFacts.CanonicalId): string =>
  record('CanonicalId', [value.module, value.name])

const declarationIdOrdinal = (value: DeclarationFacts.DeclarationId): string =>
  record('DeclarationOrdinal', [number(value.ordinal)])

const name = (value: DeclarationFacts.DeclaredName): string =>
  value._tag === 'Present' ? record('PresentName', [value.spelling]) : record('UnavailableName')

const canonicalState = (value: DeclarationFacts.CanonicalState): string => {
  switch (value._tag) {
    case 'Canonical':
      return record('Canonical', [canonicalId(value.id)])
    case 'Duplicate':
      return record('Duplicate', [canonicalId(value.original)])
    case 'Unidentified':
      return record('Unidentified')
    default:
      return exhaustive(value)
  }
}

const typePath = (value: DeclarationFacts.TypePathFact): string =>
  record('TypePath', [value.spelling, array(value.segments.map((segment) => segment.spelling))])

const arrayLength = (value: DeclarationFacts.ArrayLengthFact): string => {
  switch (value._tag) {
    case 'Available':
      return record('AvailableLength', [number(value.value)])
    case 'OutOfRange':
      return record('OutOfRangeLength', [value.spelling])
    case 'Unavailable':
      return record('UnavailableLength')
    default:
      return exhaustive(value)
  }
}

const requirementRoleFact = (value: DeclarationFacts.RequirementRoleFact): string => {
  switch (value._tag) {
    case 'DefaultRole':
      return record('DefaultRole')
    case 'UnresolvedRole':
      return record('UnresolvedRole', [typePath(value.path)])
    case 'ResolvedRole':
      return record('ResolvedRole', [value.role])
    default:
      return exhaustive(value)
  }
}

const executableLifetimeSignature = (value: Type.ExecutableLifetimes): string =>
  record('ExecutableLifetimes', [
    Lifetime.key(value.environment),
    array(value.lifetimeBinders.map(Lifetime.key)),
    Lifetime.assumptions(value.lifetimeBounds ?? []).key,
    Type.typeOutlivesKey(value.typeOutlives ?? []),
    ...(value.invocationUse === undefined ? [] : [Type.invocationUseKey(value)]),
  ])

const declaredType = (value: DeclarationFacts.DeclaredTypeFact): string => {
  switch (value._tag) {
    case 'Lifetime':
      return record('Lifetime', [Lifetime.key(value.lifetime)])
    case 'Resolved':
      return record('ResolvedType', [type(value.type), boolean(value.exposureCause !== undefined)])
    case 'Unresolved':
      return record('UnresolvedType', [
        value.spelling,
        typePath(value.path),
        optional(value.candidate === undefined ? undefined : type(value.candidate)),
        boolean(value.cause !== undefined),
      ])
    case 'FixedArray':
      return record('FixedArrayType', [declaredType(value.element), arrayLength(value.length)])
    case 'Slice':
      return record('SliceType', [
        value.access,
        Lifetime.key(value.lifetime),
        declaredType(value.element),
        boolean(value.cause !== undefined),
      ])
    case 'Reference':
      return record('ReferenceType', [
        value.access,
        Lifetime.key(value.lifetime),
        declaredType(value.target),
        boolean(value.cause !== undefined),
      ])
    case 'Pointer':
      return record('PointerType', [
        boolean(value.mutable),
        boolean(value.nullable),
        value.extent,
        String(value.alignment),
        String(value.addressSpace),
        declaredType(value.pointee),
        boolean(value.cause !== undefined),
      ])
    case 'Callable':
      return record('CallableType', [
        value.mode,
        executableLifetimeSignature(value.lifetimes),
        array(value.parameters.map(declaredType)),
        declaredType(value.result),
        boolean(value.cause !== undefined),
      ])
    case 'ForeignFunction':
      return record('ForeignFunctionType', [
        executableLifetimeSignature(value.lifetimes),
        ForeignContract.key(value.contract),
        array(value.parameters.map(declaredType)),
        declaredType(value.result),
        boolean(value.cause !== undefined),
      ])
    case 'Applied':
      return record('AppliedType', [
        declaredType(value.target),
        array(value.arguments.map(declaredType)),
        optional(
          value.requirementRow === undefined
            ? undefined
            : record('RequirementRowArgument', [
                array(
                  value.requirementRow.requirements.map((requirement) =>
                    record('Requirement', [
                      declaredType(requirement.capability),
                      requirementRoleFact(requirement.role),
                      requirement.access,
                    ]),
                  ),
                ),
                array(value.requirementRow.parameters.map(type)),
              ]),
        ),
        boolean(value.cause !== undefined),
      ])
    case 'Effect':
      return record('EffectType', [
        executableLifetimeSignature(value.lifetimes),
        declaredType(value.success),
        array(value.failures.map(declaredType)),
        array(
          value.requirements.map((requirement) =>
            record('Requirement', [
              declaredType(requirement.capability),
              requirementRoleFact(requirement.role),
              requirement.access,
            ]),
          ),
        ),
        array(value.requirementParameters.map(type)),
        boolean(value.cause !== undefined),
      ])
    case 'Union':
      return record('UnionType', [
        array(value.members.map(declaredType)),
        boolean(value.cause !== undefined),
      ])
    case 'ExactRepresentation':
      return record('ExactRepresentationType', [
        typePath(value.item),
        array(value.arguments.map(declaredType)),
        boolean(value.cause !== undefined),
      ])
    case 'RepresentationParameter':
      return record('RepresentationParameterType', [type(value.parameter)])
    case 'Unavailable':
      return record('UnavailableType', [boolean(value.cause !== undefined)])
    default:
      return exhaustive(value)
  }
}

const opaqueResult = (value: DeclarationFacts.OpaqueResultFact | undefined): string | undefined =>
  value === undefined
    ? undefined
    : record('OpaqueResult', [
        Type.opaqueFamilyKey(value.family),
        value.publicSignature.bound,
        value.publicSignature.result,
        array(value.publicSignature.enclosingKinds),
      ])

const parameter = (value: DeclarationFacts.ParameterFact): string =>
  record('Parameter', [
    number(value.id.ordinal),
    name(value.name),
    value.phase,
    declaredType(value.declaredType),
  ])

const rowExpression = (value: DeclarationFacts.RowExpressionDecision): string => {
  switch (value._tag) {
    case 'EmptyRowExpression':
      return record('EmptyRowExpression')
    case 'RowParameterExpression':
      return record('RowParameterExpression', [type(value.parameter)])
    case 'FailureMemberExpression':
      return record('FailureMemberExpression', [declaredType(value.member)])
    case 'RequirementMemberExpression':
      return record('RequirementMemberExpression', [
        declaredType(value.capability),
        value.access,
        requirementRoleFact(value.role),
      ])
    case 'UnionRowExpression':
      return record('UnionRowExpression', [array(value.operands.map(rowExpression))])
    case 'WithoutRowExpression':
      return record('WithoutRowExpression', [
        rowExpression(value.source),
        rowExpression(value.selected),
      ])
    case 'UnavailableRowExpression':
      return record('UnavailableRowExpression')
    default:
      return exhaustive(value)
  }
}

const constraint = (value: DeclarationFacts.ConstraintFact): string =>
  value._tag === 'MembershipConstraint'
    ? record('MembershipConstraint', [
        value.domain,
        rowExpression(value.selected),
        rowExpression(value.source),
      ])
    : record('ProviderConstraint', [
        value.mode,
        declaredType(value.provider),
        rowExpression(value.selected),
        rowExpression(value.source),
      ])

const failureRow = (value: DeclarationFacts.FailureRowFact): string =>
  record('FailureRow', [
    boolean(value.available),
    array(value.members.map(declaredType)),
    array(value.parameters.map(type)),
    array(value.failures.map(type)),
    rowExpression(value.expression),
    RowAlgebra.key(Type.failureRowPolicy(), value.row),
  ])

const requirementRow = (value: DeclarationFacts.RequirementRowFact): string =>
  record('RequirementRow', [
    boolean(value.available),
    array(
      value.entries.map((entry) =>
        record('RequirementEntry', [
          declaredType(entry.capability),
          requirementRoleFact(entry.role),
          entry.access,
        ]),
      ),
    ),
    rowExpression(value.expression),
    RowAlgebra.key(Type.requirementRowPolicy(), value.row),
    array(value.parameters.map(type)),
    array(
      value.requirements.map((requirement) =>
        record('ResolvedRequirement', [
          type(requirement.capability),
          requirement.role,
          requirement.access,
        ]),
      ),
    ),
  ])

const interfaceOperand = (value: DeclarationFacts.InterfaceOperandFact): string =>
  record('InterfaceOperand', [
    number(value.parameter.id.ordinal),
    declaredType(value.type),
    value.access,
  ])

const interfaceOperationContract = (
  value: DeclarationFacts.InterfaceOperationContractFact,
): string =>
  record(value._tag, [
    name(value.declaration.name),
    optional(value.provider === undefined ? undefined : type(value.provider)),
    value.functionKind,
    array(value.operands.map(interfaceOperand)),
    declaredType(value.success),
    failureRow(value.failureRow),
    requirementRow(value.requirementRow),
    array(value.declaration.constraints.map(constraint)),
    array(value.declaration.constraintContracts.map(ContractConstraint.key)),
    value.receiverAccess,
  ])

const interfaceOperationApplication = (
  value: DeclarationFacts.InterfaceOperationApplicationFact,
): string =>
  record(value._tag, [
    name(value.declaration.name),
    type(value.capability),
    type(value.provider),
    value.functionKind,
    array(value.operands.map(interfaceOperand)),
    declaredType(value.success),
    failureRow(value.failureRow),
    requirementRow(value.requirementRow),
    array(value.declaration.constraints.map(constraint)),
    array(value.declaration.constraintContracts.map(ContractConstraint.key)),
    value.receiverAccess,
  ])

const interfaceApplication = (value: DeclarationFacts.InterfaceApplicationFact): string =>
  record('InterfaceApplication', [
    value.declaration.module,
    value.declaration.name,
    type(value.capability),
    type(value.provider),
    boolean(value.providerMatches),
    value.visibility,
    boolean(value.available),
    array(value.operations.map(interfaceOperationApplication)),
  ])

const bound = (value: DeclarationFacts.BoundFact): string => {
  return value._tag === 'ResolvedBound'
    ? record('ResolvedBound', [value.spelling, interfaceApplication(value.application)])
    : record('UnresolvedBound', [value.spelling, declaredType(value.application)])
}

const typeParameter = (value: DeclarationFacts.TypeParameterFact): string =>
  record('TypeParameter', [
    type(value.type),
    value.type.kind === 'Lifetime' ? record('LifetimeBinder') : name(value.name),
    array((value.lifetimeBounds ?? []).map(Lifetime.key)),
    optional(value.duplicateOf === undefined ? undefined : type(value.duplicateOf)),
    array(value.bounds.map(bound)),
  ])

const declaration = (
  value: DeclarationFacts.DeclarationFact,
  includeImplementation = true,
  includeOrdinal = true,
): string =>
  record('FunctionDeclaration', [
    includeOrdinal ? declarationIdOrdinal(value.id) : record('StableDeclaration'),
    canonicalState(value.canonical),
    value.visibility,
    value.phase,
    value.functionKind,
    executableLifetimeSignature(DeclarationFacts.executableLifetimes(value)),
    boolean(value.unsafe),
    optional(
      value.machine === undefined
        ? undefined
        : record('MachineFunction', [
            boolean(value.machine.naked),
            boolean(value.machine.noReturn),
          ]),
    ),
    optional(
      value.foreign === undefined
        ? undefined
        : record('Foreign', [
            value.foreign.abi,
            value.foreign.symbol,
            ForeignContract.key(value.foreign.contract),
          ]),
    ),
    optional(
      value.foreignExport === undefined
        ? undefined
        : record('ForeignExport', [
            value.foreignExport.abi,
            value.foreignExport.symbol,
            ForeignContract.key(value.foreignExport.contract),
          ]),
    ),
    array(value.typeParameters.map(typeParameter)),
    number(value.parameterCount),
    array(value.parameters.map(parameter)),
    name(value.name),
    declaredType(value.returnType),
    optional(opaqueResult(value.opaqueResult)),
    failureRow(value.failureRow),
    requirementRow(value.requirementRow),
    array(value.constraints.map(constraint)),
    array(value.constraintContracts.map(ContractConstraint.key)),
    optional(
      !includeImplementation || value.bodyTemplate === undefined
        ? undefined
        : record('FunctionBodyTemplate', [value.bodyTemplate.canonical]),
    ),
    optional(
      value.associatedMember === undefined
        ? undefined
        : record('AssociatedMember', [
            number(value.associatedMember.ordinal),
            value.associatedMember.ownerSpelling,
            value.associatedMember.name,
            boolean(value.associatedMember.receiver),
          ]),
    ),
  ])

const fieldState = (value: DeclarationFacts.FieldState): string => {
  switch (value._tag) {
    case 'Unique':
      return record('UniqueField', [number(value.id.ordinal)])
    case 'Duplicate':
      return record('DuplicateField', [number(value.original.ordinal)])
    case 'Unidentified':
      return record('UnidentifiedField')
    default:
      return exhaustive(value)
  }
}

const field = (value: DeclarationFacts.FieldFact): string =>
  record('StructField', [
    number(value.id.ordinal),
    value.member._tag === 'LabeledAggregateMember'
      ? record('LabeledAggregateMember', [value.member.label])
      : record('OrdinalAggregateMember', [number(value.member.ordinal)]),
    fieldState(value.state),
    value.visibility,
    name(value.name),
    declaredType(value.declaredType),
  ])

const structDependency = (value: DeclarationFacts.StructDependency): string =>
  record(value._tag === 'Available' ? 'AvailableStructDependency' : 'UnavailableStructDependency', [
    array(value.types.map(type)),
  ])

const structLayout = (value: DeclarationFacts.StructFact['layout']): string => {
  switch (value._tag) {
    case 'Silk':
      return record('SilkStructLayout')
    case 'Foreign':
      return record('ForeignStructLayout', [value.abi])
    case 'InvalidForeign':
      return record('InvalidForeignStructLayout', [optional(value.abi)])
  }
}

const enumMemberCanonicalState = (value: DeclarationFacts.EnumMemberCanonicalState): string => {
  switch (value._tag) {
    case 'Canonical':
      return record('CanonicalEnumMember', [
        value.id.enum.module,
        value.id.enum.name,
        value.id.name,
      ])
    case 'Duplicate':
      return record('DuplicateEnumMember', [
        value.original.enum.module,
        value.original.enum.name,
        value.original.name,
      ])
    case 'Unidentified':
      return record('UnidentifiedEnumMember')
    default:
      return exhaustive(value)
  }
}

const enumRepresentation = (value: DeclarationFacts.EnumRepresentationFact): string =>
  value._tag === 'Available'
    ? record('AvailableEnumRepresentation', [value.scalar.spelling, boolean(value.explicit)])
    : record('UnavailableEnumRepresentation', [boolean(value.explicit), optional(value.spelling)])

const enumDiscriminant = (value: DeclarationFacts.EnumDiscriminantFact): string =>
  value._tag === 'Available'
    ? record('AvailableEnumDiscriminant', [value.source, value.value.toString()])
    : record('UnavailableEnumDiscriminant', [value.source, optional(value.attempted?.toString())])

const enumMember = (value: DeclarationFacts.EnumMemberFact): string =>
  record('EnumMember', [
    number(value.id.ordinal),
    enumMemberCanonicalState(value.canonical),
    name(value.name),
    enumDiscriminant(value.discriminant),
  ])

const enumAssociatedOperation = (value: DeclarationFacts.EnumAssociatedOperationFact): string =>
  record('EnumAssociatedOperation', [
    value.id.enum.module,
    value.id.enum.name,
    value.id.name,
    type(value.parameter),
    value.result.spelling,
    value.intrinsic.actor,
    value.intrinsic.name,
  ])

const enumDeclaration = (value: DeclarationFacts.EnumFact): string =>
  record('EnumDeclaration', [
    declarationIdOrdinal(value.id),
    canonicalState(value.canonical),
    value.visibility,
    name(value.name),
    enumRepresentation(value.representation),
    array(value.members.map(enumMember)),
    array(value.associatedOperations.map(enumAssociatedOperation)),
    value.validity._tag,
  ])

const struct = (value: DeclarationFacts.StructFact): string =>
  record('StructDeclaration', [
    declarationIdOrdinal(value.id),
    canonicalState(value.canonical),
    value.visibility,
    structLayout(value.layout),
    array(value.typeParameters.map(typeParameter)),
    name(value.name),
    value.aggregateKind,
    array(value.fields.map(field)),
    structDependency(value.dependency),
  ])

const unionVariantCanonicalState = (value: DeclarationFacts.UnionVariantCanonicalState): string => {
  switch (value._tag) {
    case 'Canonical':
      return record('CanonicalUnionVariant', [value.id.name])
    case 'Duplicate':
      return record('DuplicateUnionVariant', [value.original.name])
    case 'Unidentified':
      return record('UnidentifiedUnionVariant')
    default:
      return exhaustive(value)
  }
}

const unionVariant = (value: DeclarationFacts.UnionVariantFact): string =>
  record('UnionVariant', [
    number(value.id.ordinal),
    unionVariantCanonicalState(value.canonical),
    name(value.name),
    value.kind,
    array(value.fields.map(field)),
  ])

const unionDeclaration = (value: DeclarationFacts.UnionFact): string =>
  record('UnionDeclaration', [
    declarationIdOrdinal(value.id),
    canonicalState(value.canonical),
    value.visibility,
    array(value.typeParameters.map(typeParameter)),
    name(value.name),
    array(value.variants.map(unionVariant)),
    structDependency(value.dependency),
    value.validity._tag,
  ])

const serviceOperationState = (value: DeclarationFacts.ServiceOperationState): string => {
  switch (value._tag) {
    case 'Unique':
      return record('UniqueServiceOperation', [value.id.name])
    case 'Duplicate':
      return record('DuplicateServiceOperation', [value.original.name])
    case 'Unidentified':
      return record('UnidentifiedServiceOperation')
    default:
      return exhaustive(value)
  }
}

const serviceOperation = (value: DeclarationFacts.ServiceOperationFact): string =>
  record('ServiceOperation', [
    declarationIdOrdinal(value.id),
    serviceOperationState(value.state),
    value.functionKind,
    boolean(value.unsafe),
    array(value.staticProperties),
    optional(value.operator?.operator),
    array(value.typeParameters.map(typeParameter)),
    number(value.parameterCount),
    array(value.parameters.map(parameter)),
    name(value.name),
    declaredType(value.returnType),
    optional(opaqueResult(value.opaqueResult)),
    failureRow(value.failureRow),
    requirementRow(value.requirementRow),
    array(value.constraints.map(constraint)),
    array(value.constraintContracts.map(ContractConstraint.key)),
  ])

const service = (value: DeclarationFacts.ServiceFact | DeclarationFacts.InterfaceFact): string =>
  record(value._tag, [
    declarationIdOrdinal(value.id),
    canonicalState(value.canonical),
    value.visibility,
    array(value.typeParameters.map(typeParameter)),
    name(value.name),
    array(value.operations.map(serviceOperation)),
    ...(value._tag === 'InterfaceDeclaration'
      ? [array(value.operationContracts.map(interfaceOperationContract))]
      : []),
  ])

const constantLiteral = (value: DeclarationFacts.ConstantLiteralFact): string => {
  switch (value._tag) {
    case 'BooleanLiteral':
      return record('BooleanLiteral', [boolean(value.value)])
    case 'CharacterLiteral':
      return record('CharacterLiteral', [value.value.toString()])
    case 'IntegerLiteral':
      return record('IntegerLiteral', [value.value.toString()])
    case 'DurationLiteral':
      return record('DurationLiteral', [value.value.toString()])
    case 'FloatingLiteral':
      return record('FloatingLiteral', [value.spelling])
    case 'StringLiteral':
      return record('StringLiteral', [value.data.id])
    case 'Malformed':
      return record('MalformedLiteral', [value.detail])
    case 'Unavailable':
      return record('UnavailableLiteral')
    default:
      return exhaustive(value)
  }
}

const constant = (value: DeclarationFacts.ConstantFact): string =>
  record(value._tag, [
    declarationIdOrdinal(value.id),
    canonicalState(value.canonical),
    value.visibility,
    array(value.typeParameters.map(typeParameter)),
    name(value.name),
    declaredType(value.declaredType),
    record('StaticExpressionTemplate', [value.initializerTemplate.canonical]),
    constantLiteral(value.literal),
    ...(value._tag === 'PackageParameterDeclaration'
      ? [String(value.hasDefault), optional(value.predicateTemplate?.canonical)]
      : []),
  ])

const foreignStatic = (value: DeclarationFacts.ForeignStaticFact): string =>
  record('ForeignStaticDeclaration', [
    declarationIdOrdinal(value.id),
    canonicalState(value.canonical),
    value.direction,
    name(value.name),
    value.foreign.symbol,
    declaredType(value.declaredType),
    optional(value.initializerTemplate?.canonical),
    optional(value.literal === undefined ? undefined : constantLiteral(value.literal)),
  ])

const member = (value: DeclarationFacts.MemberFact): string => {
  switch (value._tag) {
    case 'FunctionDeclaration':
      return declaration(value)
    case 'StructDeclaration':
      return struct(value)
    case 'UnionDeclaration':
      return unionDeclaration(value)
    case 'EnumDeclaration':
      return enumDeclaration(value)
    case 'ServiceDeclaration':
      return service(value)
    case 'InterfaceDeclaration':
      return service(value)
    case 'PackageParameterDeclaration':
    case 'ConstantDeclaration':
      return constant(value)
    case 'ForeignStaticDeclaration':
      return foreignStatic(value)
    case 'RoleDeclaration':
      return record('RoleDeclaration', [
        declarationIdOrdinal(value.id),
        canonicalState(value.canonical),
        value.visibility,
        name(value.name),
      ])
    case 'AliasDeclaration':
      // The target is the erased canonical type, so two spellings of one type surface equally.
      return record('AliasDeclaration', [
        declarationIdOrdinal(value.id),
        canonicalState(value.canonical),
        value.visibility,
        name(value.name),
        declaredType(value.target),
      ])
    default:
      return exhaustive(value)
  }
}

const dropHook = (value: DeclarationFacts.DropHookFact): string =>
  record('DropHook', [
    name(value.name),
    value.functionKind,
    number(value.typeParameterCount),
    number(value.parameterCount),
    name(value.parameterName),
    declaredType(value.parameterType),
    declaredType(value.returnType),
    failureRow(value.failureRow),
    requirementRow(value.requirementRow),
  ])

const conformance = (value: DeclarationFacts.ConformanceFact): string =>
  record('Conformance', [
    value.module,
    number(value.ordinal),
    array(value.typeParameters.map(typeParameter)),
    declaredType(value.capability),
    declaredType(value.provider),
    value.visibility,
    array(
      value.requirements.map((requirement) =>
        record('ConformanceRequirement', [
          requirement.spelling,
          declaredType(requirement.capability),
        ]),
      ),
    ),
    array(value.constraints.map(constraint)),
    array(
      value.operations.map((operation) =>
        record('ConformanceOperation', [
          name(operation.name),
          operation.target._tag === 'TypePath'
            ? typePath(operation.target)
            : record('UnavailableTarget'),
          optional(
            operation.contract === undefined
              ? undefined
              : interfaceOperationApplication(operation.contract),
          ),
        ]),
      ),
    ),
    optional(value.hook === undefined ? undefined : dropHook(value.hook)),
    // Coherence, termination, and completed validation are facts a later edit can change without
    // touching header spelling, so the surface has to carry them or invalidation would be missed.
    record('ConformanceCoherence', [
      value.coherence._tag,
      ...(value.coherence._tag === 'Overlapping'
        ? [value.coherence.module, number(value.coherence.ordinal)]
        : []),
    ]),
    record('ConformanceTermination', [
      value.termination._tag,
      ...(value.termination._tag === 'NonTerminating'
        ? [array(value.termination.failures.map(ConformanceHead.describeTermination))]
        : []),
    ]),
    record('ConformanceValidity', [value.validity._tag]),
  ])

const inherentImpl = (value: DeclarationFacts.InherentImplFact): string =>
  record('InherentImpl', [
    value.module,
    number(value.ordinal),
    array(value.typeParameters.map(typeParameter)),
    value.ownerSpelling,
    declaredType(value.owner),
    record('InherentImplValidity', [value.validity._tag]),
  ])

/** Encodes the semantic input of one resolved declaration without implementation or source identity. */
export const memberSignature = (value: DeclarationFacts.MemberFact): string =>
  value._tag === 'FunctionDeclaration'
    ? declaration(value, false, false)
    : member({ ...value, id: { ...value.id, ordinal: 0 } })

/** Encodes explicitly consumed static syntax independently of an ordinary callable signature. */
export const memberImplementation = (value: DeclarationFacts.MemberFact): string => {
  if (value._tag !== 'FunctionDeclaration') return memberSignature(value)
  let canonical = value.bodyTemplate?.canonical ?? ''
  for (const parameter of value.typeParameters)
    if (parameter.type.kind === 'Lifetime' && parameter.name._tag === 'Present')
      canonical = canonical.replaceAll(
        JSON.stringify(['Token', 'Lifetime', parameter.name.spelling]),
        JSON.stringify(['Token', 'Lifetime', `@${parameter.type.ordinal}`]),
      )
  return canonical
}

/** Encodes the implementation and provider discovery catalog consumed by body resolution. */
export const resolutionSignature = (index: DeclarationIndex.Index): string =>
  array(
    index.modules.map((module) =>
      record('ResolutionCatalog', [
        module.module,
        array(module.conformances.map(conformance)),
        array(module.inherentImpls.map(inherentImpl)),
      ]),
    ),
  )

/** Construct the exact surface for one module's completed headers. */
export const make = (headers: DeclarationFacts.ModuleHeaders): ModuleSurface => ({
  _tag: 'ModuleSurface',
  module: headers.module,
  canonical: record('ModuleSurface', [
    headers.module,
    array(
      headers.publications.map((publication) =>
        record('Publication', [publication.module, publication.original, publication.spelling]),
      ),
    ),
    array(headers.members.map(member)),
    array(headers.conformances.map(conformance)),
    array(headers.inherentImpls.map(inherentImpl)),
  ]),
})

/** Construct canonically ordered surfaces for a completed declaration index. */
export const fromIndex = (index: DeclarationIndex.Index): ReadonlyMap<string, ModuleSurface> =>
  new Map(
    [...index.modules]
      .sort((left, right) => compareText(left.module, right.module))
      .map((headers) => {
        const surface = make(headers)
        if (headers.publications.length === 0) return [headers.module, surface]
        return [
          headers.module,
          {
            ...surface,
            canonical: record('PublishedSurface', [
              surface.canonical,
              array(
                headers.publications.map((publication) => {
                  const result = DeclarationFacts.publishedMember(
                    index,
                    headers.module,
                    publication.spelling,
                  )
                  return record(publication.spelling, [
                    result._tag,
                    result._tag === 'Resolved' ? member(result.declaration) : '',
                  ])
                }),
              ),
            ]),
          },
        ]
      }),
  )

/** Compare complete canonical semantic representations. */
export const equals: {
  (that: ModuleSurface): (self: ModuleSurface) => boolean
  (self: ModuleSurface, that: ModuleSurface): boolean
} = Fn.dual(
  2,
  (self: ModuleSurface, that: ModuleSurface): boolean =>
    self.module === that.module && self.canonical === that.canonical,
)
