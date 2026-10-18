import * as FiniteRow from './FiniteRow.js'
import * as Canonical from './internal/Canonical.js'
import * as SourceSpan from './SourceSpan.js'

export type MemberSubstitution<Member, SymbolicMember, RowParameter = never> =
  | { readonly _tag: 'Residual'; readonly member: SymbolicMember }
  | { readonly _tag: 'Concrete'; readonly member: Member }
  | { readonly _tag: 'ConcreteRow'; readonly members: ReadonlyArray<Member> }
  | { readonly _tag: 'Row'; readonly row: Row<Member, RowParameter, SymbolicMember> }
  | { readonly _tag: 'InvalidSingleton'; readonly reason: string }

/** Domain behavior for one kind-preserving symbolic row algebra. */
export interface Policy<Member, RowParameter, SymbolicMember, MemberParameter> {
  readonly finite: FiniteRow.Policy<Member>
  /** Whether later substitution or executable-owner specialization may change this member's key. */
  readonly concreteMemberMaySpecialize: (member: Member) => boolean
  /** Additional domain evidence that two keys cannot collide under later substitution. */
  readonly concreteMembersAreDisjoint?: (left: Member, right: Member) => boolean
  readonly rowParameterKey: (parameter: RowParameter) => string
  readonly symbolicMemberKey: (member: SymbolicMember) => string
  readonly symbolicMemberParameters: (member: SymbolicMember) => ReadonlyArray<MemberParameter>
  readonly memberParameterKey: (parameter: MemberParameter) => string
  readonly memberWellFormedKey: (member: SymbolicMember) => string
  readonly allowsSetCancellation: boolean
}

export type Expression<Member, RowParameter, SymbolicMember> =
  | { readonly _tag: 'Concrete'; readonly row: FiniteRow.FiniteRow<Member> }
  | { readonly _tag: 'RowParameter'; readonly parameter: RowParameter }
  | { readonly _tag: 'Singleton'; readonly member: SymbolicMember }
  | {
      readonly _tag: 'Union'
      readonly operands: ReadonlyArray<Expression<Member, RowParameter, SymbolicMember>>
    }
  | {
      readonly _tag: 'Without'
      readonly source: Expression<Member, RowParameter, SymbolicMember>
      readonly selected: Expression<Member, RowParameter, SymbolicMember>
    }

export interface MemberWellFormed<SymbolicMember> {
  readonly key: string
  readonly member: SymbolicMember
  readonly origins: ReadonlyArray<SourceSpan.SourceSpan>
}

/** A symbolic row plus retained member-domain obligations erased by safe simplification. */
export interface Row<Member, RowParameter, SymbolicMember> {
  readonly expression: Expression<Member, RowParameter, SymbolicMember>
  readonly memberWellFormed: ReadonlyArray<MemberWellFormed<SymbolicMember>>
}

export interface Substitution<Member, RowParameter, SymbolicMember> {
  readonly row: (parameter: RowParameter) => Row<Member, RowParameter, SymbolicMember> | undefined
  readonly member: (
    member: SymbolicMember,
  ) => MemberSubstitution<Member, SymbolicMember, RowParameter>
}

export interface InvalidMemberSpecialization {
  readonly key: string
  readonly reason: string
  readonly origins: ReadonlyArray<SourceSpan.SourceSpan>
}

export interface DiagnosticLocations {
  readonly primary: SourceSpan.SourceSpan
  readonly secondary: ReadonlyArray<SourceSpan.SourceSpan>
}

export type SubstitutionResult<Member, RowParameter, SymbolicMember> =
  | { readonly _tag: 'Substituted'; readonly row: Row<Member, RowParameter, SymbolicMember> }
  | {
      readonly _tag: 'InvalidMembers'
      readonly invalid: ReadonlyArray<InvalidMemberSpecialization>
    }

export type Concretization<Member> =
  | { readonly _tag: 'Concrete'; readonly row: FiniteRow.FiniteRow<Member> }
  | { readonly _tag: 'Residual'; readonly keys: ReadonlyArray<string> }

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

const canonicalOrigins = (
  origins: Iterable<SourceSpan.SourceSpan>,
): ReadonlyArray<SourceSpan.SourceSpan> => SourceSpan.canonicalize(origins)

const mergeObligations = <SymbolicMember>(
  obligations: Iterable<MemberWellFormed<SymbolicMember>>,
): ReadonlyArray<MemberWellFormed<SymbolicMember>> => {
  const merged = new Map<string, MemberWellFormed<SymbolicMember>>()
  for (const obligation of obligations) {
    const existing = merged.get(obligation.key)
    merged.set(obligation.key, {
      key: obligation.key,
      member: existing?.member ?? obligation.member,
      origins: canonicalOrigins([...(existing?.origins ?? []), ...obligation.origins]),
    })
  }
  return [...merged.values()].sort((left, right) => compareText(left.key, right.key))
}

/** Selects one deterministic primary and ordered secondary locations for an obligation failure. */
export const diagnosticLocations = <SymbolicMember>(
  obligation: MemberWellFormed<SymbolicMember>,
  responsible?: SourceSpan.SourceSpan,
): DiagnosticLocations | undefined => {
  const origins = canonicalOrigins(obligation.origins)
  const primary = responsible ?? origins.at(0)
  if (primary === undefined) return undefined
  const primaryKey = SourceSpan.key(primary)
  return {
    primary,
    secondary: origins.filter((origin) => SourceSpan.key(origin) !== primaryKey),
  }
}

const expressionKey = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Expression<Member, RowParameter, SymbolicMember>,
): string => {
  switch (self._tag) {
    case 'Concrete':
      return Canonical.record('Concrete', [FiniteRow.key(policy.finite, self.row)])
    case 'RowParameter':
      return Canonical.record('RowParameter', [policy.rowParameterKey(self.parameter)])
    case 'Singleton':
      return Canonical.record('Singleton', [policy.symbolicMemberKey(self.member)])
    case 'Union':
      return Canonical.record(
        'Union',
        self.operands.map((operand) => expressionKey(policy, operand)),
      )
    case 'Without':
      return Canonical.record('Without', [
        expressionKey(policy, self.source),
        expressionKey(policy, self.selected),
      ])
  }
}

const concreteExpression = <Member>(
  row: FiniteRow.FiniteRow<Member>,
): { readonly _tag: 'Concrete'; readonly row: FiniteRow.FiniteRow<Member> } => ({
  _tag: 'Concrete',
  row,
})

/** Constructs a concrete row. */
export const concrete = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  members: Iterable<Member>,
): Row<Member, RowParameter, SymbolicMember> => ({
  expression: concreteExpression(FiniteRow.make(policy.finite, members)),
  memberWellFormed: [],
})

/** Constructs one open whole-row parameter. */
export const parameter = <Member, RowParameter, SymbolicMember>(
  rowParameter: RowParameter,
): Row<Member, RowParameter, SymbolicMember> => {
  const expression: Expression<Member, RowParameter, SymbolicMember> = {
    _tag: 'RowParameter',
    parameter: rowParameter,
  }
  return {
    expression,
    memberWellFormed: [],
  }
}

/** Lifts one open domain member and retains its singleton-domain validation obligation. */
export const singleton = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  member: SymbolicMember,
  origin: SourceSpan.SourceSpan,
): Row<Member, RowParameter, SymbolicMember> => {
  const key = policy.memberWellFormedKey(member)
  const expression: Expression<Member, RowParameter, SymbolicMember> = {
    _tag: 'Singleton',
    member,
  }
  return {
    expression,
    memberWellFormed: [{ key, member, origins: [origin] }],
  }
}

const normalizeUnionExpression = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  inputs: ReadonlyArray<Expression<Member, RowParameter, SymbolicMember>>,
): Expression<Member, RowParameter, SymbolicMember> => {
  const flattened: Array<Expression<Member, RowParameter, SymbolicMember>> = []
  const concreteMembers: Array<Member> = []
  const visit = (input: Expression<Member, RowParameter, SymbolicMember>): void => {
    if (input._tag === 'Union') {
      for (const operand of input.operands) visit(operand)
      return
    }
    if (input._tag === 'Concrete') {
      concreteMembers.push(...input.row.members)
      return
    }
    flattened.push(input)
  }
  for (const input of inputs) visit(input)
  const finite = FiniteRow.make(policy.finite, concreteMembers)
  if (finite.members.length > 0) flattened.push(concreteExpression(finite))
  const canonical = [
    ...new Map(flattened.map((operand) => [expressionKey(policy, operand), operand])).values(),
  ].sort((left, right) => compareText(expressionKey(policy, left), expressionKey(policy, right)))
  if (canonical.length === 0) return concreteExpression(FiniteRow.empty<Member>())
  const only = canonical.at(0)
  if (canonical.length === 1 && only !== undefined) return only
  return { _tag: 'Union', operands: canonical }
}

/** Associative, commutative, idempotent symbolic union. */
export const union = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  left: Row<Member, RowParameter, SymbolicMember>,
  right: Row<Member, RowParameter, SymbolicMember>,
): Row<Member, RowParameter, SymbolicMember> => ({
  expression: normalizeUnionExpression(policy, [left.expression, right.expression]),
  memberWellFormed: mergeObligations([...left.memberWellFormed, ...right.memberWellFormed]),
})

/** Forward-only symbolic difference. It never binds either operand. */
export const without = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  source: Row<Member, RowParameter, SymbolicMember>,
  selected: Row<Member, RowParameter, SymbolicMember>,
): Row<Member, RowParameter, SymbolicMember> => {
  const obligations = mergeObligations([...source.memberWellFormed, ...selected.memberWellFormed])
  const sourceKey = expressionKey(policy, source.expression)
  const selectedKey = expressionKey(policy, selected.expression)
  if (sourceKey === selectedKey)
    return {
      expression: concreteExpression(FiniteRow.empty<Member>()),
      memberWellFormed: obligations,
    }
  if (source.expression._tag === 'Concrete' && source.expression.row.members.length === 0)
    return { expression: source.expression, memberWellFormed: obligations }
  if (selected.expression._tag === 'Concrete' && selected.expression.row.members.length === 0)
    return { expression: source.expression, memberWellFormed: obligations }
  if (source.expression._tag === 'Concrete' && selected.expression._tag === 'Concrete') {
    const differenceKey = policy.finite.differenceKey ?? policy.finite.collisionKey
    const selectedMembers = selected.expression.row.members
    const selectedKeys = new Set(selectedMembers.map(differenceKey))
    // Equal keys stay equal under substitution. A surviving key is safe only when it
    // cannot later collide with a selected key; unrelated nominal heads/roles prove that
    // even when either service contains borrowed lifetimes or generic arguments.
    const stable = source.expression.row.members.every(
      (member) =>
        selectedKeys.has(differenceKey(member)) ||
        selectedMembers.every(
          (other) =>
            policy.concreteMembersAreDisjoint?.(member, other) === true ||
            (!policy.concreteMemberMaySpecialize(member) &&
              !policy.concreteMemberMaySpecialize(other)),
        ),
    )
    if (stable)
      return {
        expression: concreteExpression(
          FiniteRow.difference(policy.finite, source.expression.row, selected.expression.row),
        ),
        memberWellFormed: obligations,
      }
  }
  if (policy.allowsSetCancellation && source.expression._tag === 'Union') {
    const remaining = source.expression.operands.filter(
      (operand) => expressionKey(policy, operand) !== selectedKey,
    )
    if (remaining.length !== source.expression.operands.length) {
      const remainder: Row<Member, RowParameter, SymbolicMember> = {
        expression: normalizeUnionExpression(policy, remaining),
        memberWellFormed: source.memberWellFormed,
      }
      return without(policy, remainder, selected)
    }
  }
  return {
    expression: {
      _tag: 'Without',
      source: source.expression,
      selected: selected.expression,
    },
    memberWellFormed: obligations,
  }
}

/** Span-independent definitional identity, including retained validation obligations. */
export const key = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
): string =>
  Canonical.record('RowAlgebra', [
    expressionKey(policy, self.expression),
    Canonical.array(self.memberWellFormed.map((obligation) => obligation.key)),
  ])

export const equals = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  left: Row<Member, RowParameter, SymbolicMember>,
  right: Row<Member, RowParameter, SymbolicMember>,
): boolean => key(policy, left) === key(policy, right)

/**
 * Proves a subset relation from normalized row structure and declared subset assumptions.
 *
 * This is intentionally forward-only: exact operands and concrete finite subsets are provable,
 * as are unions composed entirely from such operands. Declared subset assumptions can establish
 * exclusion of a member, but are never inverted or used to bind either side.
 */
export const isKnownSubset = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  candidate: Row<Member, RowParameter, SymbolicMember>,
  container: Row<Member, RowParameter, SymbolicMember>,
  assumptions: ReadonlyArray<{
    readonly selected: Row<Member, RowParameter, SymbolicMember>
    readonly source: Row<Member, RowParameter, SymbolicMember>
  }> = [],
): boolean => {
  const row = (expression: Expression<Member, RowParameter, SymbolicMember>) => ({
    expression,
    memberWellFormed: [],
  })
  const disjoint = (
    left: Expression<Member, RowParameter, SymbolicMember>,
    right: Expression<Member, RowParameter, SymbolicMember>,
  ): boolean => {
    if (left._tag === 'Concrete' && right._tag === 'Concrete')
      return left.row.members.every((a) =>
        right.row.members.every(
          (b) =>
            policy.concreteMembersAreDisjoint?.(a, b) === true ||
            (!policy.concreteMemberMaySpecialize(a) &&
              !policy.concreteMemberMaySpecialize(b) &&
              (policy.finite.differenceKey ?? policy.finite.collisionKey)(a) !==
                (policy.finite.differenceKey ?? policy.finite.collisionKey)(b)),
        ),
      )
    return assumptions.some(
      (given) =>
        given.selected.memberWellFormed.length === 0 &&
        given.source.memberWellFormed.length === 0 &&
        given.source.expression._tag === 'Without' &&
        isKnownSubset(policy, row(left), given.selected) &&
        isKnownSubset(policy, row(right), row(given.source.expression.selected)),
    )
  }
  const prove = (
    left: Expression<Member, RowParameter, SymbolicMember>,
    right: Expression<Member, RowParameter, SymbolicMember>,
  ): boolean => {
    if (expressionKey(policy, left) === expressionKey(policy, right)) return true
    if (left._tag === 'Concrete' && left.row.members.length === 0) return true
    if (
      assumptions.some(
        (given) =>
          given.selected.memberWellFormed.length === 0 &&
          given.source.memberWellFormed.length === 0 &&
          expressionKey(policy, left) === expressionKey(policy, given.selected.expression) &&
          expressionKey(policy, right) === expressionKey(policy, given.source.expression),
      )
    )
      return true
    if (left._tag === 'Union') return left.operands.every((operand) => prove(operand, right))
    if (left._tag === 'Without') {
      // Subtraction can only remove requirements. Keep the symbolic expression intact, but
      // prove against its upper bound after removing members with an already identical key.
      if (prove(left.source, right)) return true
      if (left.source._tag === 'Union')
        return left.source.operands.every((source) =>
          prove({ _tag: 'Without', source, selected: left.selected }, right),
        )
      if (left.source._tag === 'Concrete' && left.selected._tag === 'Concrete')
        return prove(
          concreteExpression(
            FiniteRow.difference(policy.finite, left.source.row, left.selected.row),
          ),
          right,
        )
    }
    if (right._tag === 'Union') return right.operands.some((operand) => prove(left, operand))
    if (right._tag === 'Without') return prove(left, right.source) && disjoint(left, right.selected)
    if (left._tag === 'Concrete' && right._tag === 'Concrete')
      return FiniteRow.isSubset(policy.finite, left.row, right.row)
    return false
  }
  return prove(candidate.expression, container.expression)
}

/** Finds both whole-row parameters and parameters retained inside symbolic member obligations. */
export const parameters = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
): {
  readonly rows: ReadonlyArray<RowParameter>
  readonly members: ReadonlyArray<MemberParameter>
} => {
  const rows = new Map<string, RowParameter>()
  const members = new Map<string, MemberParameter>()
  const visit = (expression: Expression<Member, RowParameter, SymbolicMember>): void => {
    switch (expression._tag) {
      case 'Concrete':
        return
      case 'RowParameter':
        rows.set(policy.rowParameterKey(expression.parameter), expression.parameter)
        return
      case 'Singleton':
        for (const parameter of policy.symbolicMemberParameters(expression.member))
          members.set(policy.memberParameterKey(parameter), parameter)
        return
      case 'Union':
        for (const operand of expression.operands) visit(operand)
        return
      case 'Without':
        visit(expression.source)
        visit(expression.selected)
        return
    }
  }
  visit(self.expression)
  for (const obligation of self.memberWellFormed)
    for (const parameter of policy.symbolicMemberParameters(obligation.member))
      members.set(policy.memberParameterKey(parameter), parameter)
  return {
    rows: [...rows.values()].sort((left, right) =>
      compareText(policy.rowParameterKey(left), policy.rowParameterKey(right)),
    ),
    members: [...members.values()].sort((left, right) =>
      compareText(policy.memberParameterKey(left), policy.memberParameterKey(right)),
    ),
  }
}

/** Occurs check for a whole-row parameter, including retained obligations. */
export const containsRowParameter = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
  parameter_: RowParameter,
): boolean =>
  parameters(policy, self).rows.some(
    (candidate) => policy.rowParameterKey(candidate) === policy.rowParameterKey(parameter_),
  )

/** Collects every concrete member mentioned by an open expression, without interpreting difference. */
export const concreteMembers = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
): ReadonlyArray<Member> => {
  const members: Array<Member> = []
  const visit = (expression: Expression<Member, RowParameter, SymbolicMember>): void => {
    switch (expression._tag) {
      case 'Concrete':
        members.push(...expression.row.members)
        return
      case 'RowParameter':
      case 'Singleton':
        return
      case 'Union':
        for (const operand of expression.operands) visit(operand)
        return
      case 'Without':
        visit(expression.source)
        visit(expression.selected)
        return
    }
  }
  visit(self.expression)
  return FiniteRow.make(policy.finite, members).members
}

/** Collects concrete members retained positively by an open expression. */
export const positiveConcreteMembers = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
): ReadonlyArray<Member> => {
  const visit = (
    expression: Expression<Member, RowParameter, SymbolicMember>,
  ): ReadonlyArray<Member> => {
    switch (expression._tag) {
      case 'Concrete':
        return expression.row.members
      case 'RowParameter':
      case 'Singleton':
        return []
      case 'Union':
        return expression.operands.flatMap(visit)
      case 'Without':
        return expression.selected._tag === 'Concrete'
          ? FiniteRow.difference(
              policy.finite,
              FiniteRow.make(policy.finite, visit(expression.source)),
              expression.selected.row,
            ).members
          : visit(expression.source)
    }
  }
  return FiniteRow.make(policy.finite, visit(self.expression)).members
}

/** Rewrites concrete members structurally and renormalizes substitution-created collisions. */
export const mapConcreteMembers = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
  map: (member: Member) => Member,
): Row<Member, RowParameter, SymbolicMember> => {
  const visit = (
    expression: Expression<Member, RowParameter, SymbolicMember>,
  ): Row<Member, RowParameter, SymbolicMember> => {
    switch (expression._tag) {
      case 'Concrete':
        return concrete(policy, expression.row.members.map(map))
      case 'RowParameter':
      case 'Singleton':
        return { expression, memberWellFormed: [] }
      case 'Union': {
        let result = concrete<Member, RowParameter, SymbolicMember, MemberParameter>(policy, [])
        for (const operand of expression.operands) result = union(policy, result, visit(operand))
        return result
      }
      case 'Without':
        return without(policy, visit(expression.source), visit(expression.selected))
    }
  }
  const mapped = visit(self.expression)
  return {
    expression: mapped.expression,
    memberWellFormed: self.memberWellFormed,
  }
}

/** Applies independent row/member substitutions and renormalizes every concrete collision. */
export const substitute = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
  substitution: Substitution<Member, RowParameter, SymbolicMember>,
): SubstitutionResult<Member, RowParameter, SymbolicMember> => {
  const invalid = new Map<string, InvalidMemberSpecialization>()
  const substituteExpression = (
    expression: Expression<Member, RowParameter, SymbolicMember>,
  ): Row<Member, RowParameter, SymbolicMember> => {
    switch (expression._tag) {
      case 'Concrete':
        return { expression, memberWellFormed: [] }
      case 'RowParameter':
        return (
          substitution.row(expression.parameter) ?? {
            expression,
            memberWellFormed: [],
          }
        )
      case 'Singleton': {
        const result = substitution.member(expression.member)
        if (result._tag === 'Concrete') return concrete(policy, [result.member])
        if (result._tag === 'ConcreteRow') return concrete(policy, result.members)
        if (result._tag === 'Row')
          return {
            expression: result.row.expression,
            memberWellFormed: [],
          }
        if (result._tag === 'Residual') {
          const residualExpression: Expression<Member, RowParameter, SymbolicMember> = {
            _tag: 'Singleton',
            member: result.member,
          }
          return {
            expression: residualExpression,
            memberWellFormed: [],
          }
        }
        return {
          expression: concreteExpression(FiniteRow.empty<Member>()),
          memberWellFormed: [],
        }
      }
      case 'Union': {
        let result = concrete<Member, RowParameter, SymbolicMember, MemberParameter>(policy, [])
        for (const operand of expression.operands)
          result = union(policy, result, substituteExpression(operand))
        return result
      }
      case 'Without':
        return without(
          policy,
          substituteExpression(expression.source),
          substituteExpression(expression.selected),
        )
    }
  }

  let substituted = substituteExpression(self.expression)
  const obligations: Array<MemberWellFormed<SymbolicMember>> = [...substituted.memberWellFormed]
  for (const obligation of self.memberWellFormed) {
    const result = substitution.member(obligation.member)
    if (result._tag === 'InvalidSingleton') {
      invalid.set(obligation.key, {
        key: obligation.key,
        reason: result.reason,
        origins: obligation.origins,
      })
      continue
    }
    if (result._tag === 'Residual')
      obligations.push({
        key: policy.memberWellFormedKey(result.member),
        member: result.member,
        origins: obligation.origins,
      })
    if (result._tag === 'Row')
      obligations.push(
        ...result.row.memberWellFormed.map((mapped) => ({
          key: mapped.key,
          member: mapped.member,
          origins: obligation.origins,
        })),
      )
  }
  if (invalid.size > 0)
    return {
      _tag: 'InvalidMembers',
      invalid: [...invalid.values()].sort((left, right) => compareText(left.key, right.key)),
    }
  substituted = {
    expression: substituted.expression,
    memberWellFormed: mergeObligations(obligations),
  }
  return { _tag: 'Substituted', row: substituted }
}

/** Exposes a finite row only when no symbolic expression or validation obligation remains. */
export const concretize = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
): Concretization<Member> => {
  if (self.expression._tag === 'Concrete' && self.memberWellFormed.length === 0)
    return { _tag: 'Concrete', row: self.expression.row }
  return {
    _tag: 'Residual',
    keys: [
      expressionKey(policy, self.expression),
      ...self.memberWellFormed.map((obligation) => obligation.key),
    ],
  }
}

/** Deterministic structural presentation for diagnostics and semantic surfaces. */
export const encode = <Member, RowParameter, SymbolicMember, MemberParameter>(
  policy: Policy<Member, RowParameter, SymbolicMember, MemberParameter>,
  self: Row<Member, RowParameter, SymbolicMember>,
  member: (member: Member) => string,
  rowParameter: (parameter: RowParameter) => string,
  symbolicMember: (member: SymbolicMember) => string,
): string => {
  const visit = (expression: Expression<Member, RowParameter, SymbolicMember>): string => {
    switch (expression._tag) {
      case 'Concrete':
        return FiniteRow.encode(policy.finite, expression.row, member)
      case 'RowParameter':
        return rowParameter(expression.parameter)
      case 'Singleton':
        return symbolicMember(expression.member)
      case 'Union': {
        const rank = (operand: Expression<Member, RowParameter, SymbolicMember>): number => {
          if (operand._tag === 'Concrete') {
            return 0
          }
          if (operand._tag === 'Singleton') {
            return 1
          }
          if (operand._tag === 'RowParameter') {
            return 2
          }
          return 3
        }
        return expression.operands
          .map((operand, ordinal) => ({ operand, ordinal }))
          .sort(
            (left, right) =>
              rank(left.operand) - rank(right.operand) || left.ordinal - right.ordinal,
          )
          .map(({ operand }) => visit(operand))
          .join(' | ')
      }
      case 'Without':
        return `Without<${visit(expression.source)}, ${visit(expression.selected)}>`
    }
  }
  return visit(self.expression)
}
