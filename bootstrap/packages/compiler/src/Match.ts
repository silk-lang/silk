import type * as AuthoredIdentity from './AuthoredIdentity.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as Lifetime from './Lifetime.js'
import * as RowAlgebra from './RowAlgebra.js'
import type * as Tir from './Tir.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'

/** The lexical way a match observes or takes its scrutinee. */
export type Access = 'Copy' | 'Move' | 'Place' | 'Shared' | 'Exclusive'

/** Stable source identity for one match expression. */
export interface MatchId {
  readonly _tag: 'MatchId'
  readonly node: Tir.NodeRef
}

/** Stable source-order identity for one arm. */
export interface ArmId {
  readonly _tag: 'MatchArmId'
  readonly match: MatchId
  readonly ordinal: number
}

/** Stable preorder identity for one pattern below an arm. */
export interface PatternId {
  readonly _tag: 'PatternId'
  readonly arm: ArmId
  readonly ordinal: number
}

/** Stable source-order identity for one leaf binding below an arm. */
export interface BindingId {
  readonly _tag: 'PatternBindingId'
  readonly arm: ArmId
  readonly ordinal: number
}

/** One exact inhabitant in a closed match coverage domain. */
export type CoverageIdentity =
  | { readonly _tag: 'StructuralTypeMember'; readonly type: Type.Type }
  | {
      readonly _tag: 'NominalUnionVariant'
      readonly root: Type.Type
      readonly type: Type.Nominal
      readonly variant: DeclarationFacts.CanonicalUnionVariantId
      readonly variantOrdinal: number
    }
  | {
      readonly _tag: 'EnumMember'
      readonly enum: DeclarationFacts.CanonicalId
      readonly member: DeclarationFacts.CanonicalEnumMemberId
      readonly type: Type.Nominal
    }

/** Creates the coverage identity for one structural type member. */
export const structuralMember = (type: Type.Type): CoverageIdentity => ({
  _tag: 'StructuralTypeMember',
  type,
})

/** Creates the coverage identity for one declared scalar enum member. */
export const enumMember = (
  enum_: DeclarationFacts.CanonicalId,
  member: DeclarationFacts.CanonicalEnumMemberId,
): CoverageIdentity => ({
  _tag: 'EnumMember',
  enum: enum_,
  member,
  type: Type.nominal(enum_.module, enum_.name),
})

/** Creates one leaf selection beneath a nominal-union parent and optional structural root. */
export const nominalUnionVariant = (
  root: Type.Type,
  type: Type.Nominal,
  variant: DeclarationFacts.CanonicalUnionVariantId,
  variantOrdinal: number,
): CoverageIdentity => ({ _tag: 'NominalUnionVariant', root, type, variant, variantOrdinal })

/** Semantic matching retains lifetime identity; runtime matching uses already-checked erased types. */
export type IdentityPhase = 'Semantic' | 'Runtime'

const sameType = (left: Type.Type, right: Type.Type, phase: IdentityPhase): boolean =>
  phase === 'Runtime' ? Type.runtimeKey(left) === Type.runtimeKey(right) : Type.equals(left, right)

/** Tests coverage identity without erasing enum members to types or integers. */
export const identityEquals = (
  self: CoverageIdentity,
  other: CoverageIdentity,
  phase: IdentityPhase = 'Semantic',
): boolean => {
  if (self._tag === 'StructuralTypeMember')
    return other._tag === 'StructuralTypeMember' && sameType(self.type, other.type, phase)
  if (self._tag === 'NominalUnionVariant')
    return (
      other._tag === 'NominalUnionVariant' &&
      sameType(self.root, other.root, phase) &&
      sameType(self.type, other.type, phase) &&
      self.variant.union.module === other.variant.union.module &&
      self.variant.union.name === other.variant.union.name &&
      self.variant.name === other.variant.name &&
      self.variantOrdinal === other.variantOrdinal
    )
  return (
    other._tag === 'EnumMember' &&
    self.enum.module === other.enum.module &&
    self.enum.name === other.enum.name &&
    self.member.name === other.member.name
  )
}

/** Returns the source type selected by one coverage identity. */
export const sourceType = (self: CoverageIdentity): Type.Type =>
  self._tag === 'NominalUnionVariant' ? self.root : self.type

/** Encodes one coverage identity for diagnostics and deterministic snapshots. */
export const encodeIdentity = (self: CoverageIdentity): string => {
  if (self._tag === 'StructuralTypeMember') return Type.encode(self.type)
  if (self._tag === 'NominalUnionVariant')
    return `${Type.encode(self.root)}::${Type.encode(self.type)}.${self.variant.name}`
  return `${self.enum.module}.${self.enum.name}.${self.member.name}`
}

/** One nested nominal discriminant, addressed from the complete scrutinee. */
export interface PatternTest {
  readonly path: ReadonlyArray<DeclarationFacts.FieldId>
  readonly member: CoverageIdentity
  readonly domain: ReadonlyArray<CoverageIdentity>
  readonly span: SourceSpan.SourceSpan
  /** The authored node `span` presents; presentation stamps the span from it. */
  readonly at?: AuthoredIdentity.Anchor
}

/** One source decision reduced to the facts that affect coverage. */
export interface Decision {
  readonly tests?: ReadonlyArray<PatternTest>
  readonly member?: CoverageIdentity
  readonly universal: boolean
  readonly guarded: boolean
}

/** One arm's immutable canonical coverage transition. */
export interface CoverageTransition {
  readonly before: ReadonlyArray<CoverageIdentity>
  readonly after: ReadonlyArray<CoverageIdentity>
  readonly reachable: boolean
}

/** Complete ordered coverage result for one nominal, structural-union, or scalar-enum scrutinee. */
export interface Coverage {
  readonly initial: ReadonlyArray<CoverageIdentity>
  readonly transitions: ReadonlyArray<CoverageTransition>
  readonly missing: ReadonlyArray<CoverageIdentity>
  readonly exhaustive: boolean
}

/** Tests whether one authored pattern identity selects one canonical coverage leaf. */
export const selects = (
  pattern: CoverageIdentity,
  candidate: CoverageIdentity,
  phase: IdentityPhase = 'Semantic',
): boolean =>
  identityEquals(pattern, candidate, phase) ||
  (pattern._tag === 'StructuralTypeMember' &&
    candidate._tag === 'NominalUnionVariant' &&
    sameType(pattern.type, candidate.root, phase))

/** Returns the canonical structural exact-member set observed by a pattern decision. */
export const membersOf = (type: Type.Type): ReadonlyArray<CoverageIdentity> => {
  if (Type.isUnion(type)) return type.members.map(structuralMember)
  if (Type.isNever(type)) return []
  return [structuralMember(type)]
}

/** Returns the canonical source-ordered member set of one scalar enum. */
export const enumMembersOf = (
  declaration: DeclarationFacts.EnumFact,
): ReadonlyArray<CoverageIdentity> => {
  if (declaration.canonical._tag !== 'Canonical') return []
  const enum_ = declaration.canonical.id
  return declaration.members.flatMap((member) =>
    member.canonical._tag === 'Canonical' ? [enumMember(enum_, member.canonical.id)] : [],
  )
}

/** Folds source decisions over one canonical remaining-member set. */
export const cover = (
  initial: ReadonlyArray<CoverageIdentity>,
  decisions: ReadonlyArray<Decision>,
  phase: IdentityPhase = 'Semantic',
): Coverage => {
  type Constraint = {
    readonly path: PatternTest['path']
    readonly values: ReadonlyArray<CoverageIdentity>
  }
  type Row = ReadonlyArray<Constraint>
  const samePath = (left: PatternTest['path'], right: PatternTest['path']) =>
    left.length === right.length &&
    left.every((field, ordinal) => {
      const other = right.at(ordinal)
      return other !== undefined && DeclarationFacts.sameFieldId(field, other)
    })
  const allowed = (row: Row, test: PatternTest) =>
    row.find((constraint) => samePath(constraint.path, test.path))?.values ?? test.domain
  const constrain = (row: Row, test: PatternTest, values: ReadonlyArray<CoverageIdentity>): Row => [
    ...row.filter((constraint) => !samePath(constraint.path, test.path)),
    { path: test.path, values },
  ]
  const intersects = (row: Row, tests: ReadonlyArray<PatternTest>) =>
    tests.every((test) => allowed(row, test).some((value) => selects(test.member, value, phase)))
  const subtract = (row: Row, tests: ReadonlyArray<PatternTest>): ReadonlyArray<Row> => {
    const residual: Array<Row> = []
    let matched = row
    for (const test of tests) {
      const values = allowed(matched, test)
      const selected = values.filter((value) => selects(test.member, value, phase))
      const other = values.filter((value) => !selects(test.member, value, phase))
      if (other.length > 0) residual.push(constrain(matched, test, other))
      if (selected.length === 0) return residual
      matched = constrain(matched, test, selected)
    }
    return residual
  }
  let spaces = initial.map((member) => ({ member, rows: Array.of<Row>([]) }))
  const remaining = () =>
    spaces.filter((space) => space.rows.length > 0).map((space) => space.member)
  const transitions: Array<CoverageTransition> = []
  for (const decision of decisions) {
    const before = remaining()
    const tests = decision.tests ?? []
    const selected = (member: CoverageIdentity) =>
      decision.universal ||
      (decision.member !== undefined && selects(decision.member, member, phase))
    const reachable = spaces.some(
      (space) => selected(space.member) && space.rows.some((row) => intersects(row, tests)),
    )
    if (reachable && !decision.guarded) {
      spaces = spaces.map((space) =>
        selected(space.member)
          ? { member: space.member, rows: space.rows.flatMap((row) => subtract(row, tests)) }
          : space,
      )
    }
    transitions.push({ before, after: remaining(), reachable })
  }
  const missing = remaining()
  return {
    initial: [...initial],
    transitions: transitions,
    missing,
    exhaustive: missing.length === 0,
  }
}

export type Join =
  | { readonly _tag: 'Joined'; readonly type: Type.Type }
  | { readonly _tag: 'Incompatible'; readonly types: ReadonlyArray<Type.Type> }

/** Joins reachable arm results using the language's one canonical match-result rule. */
export const join = (
  inputs: ReadonlyArray<Type.Type>,
  lifetimes?: Type.ExecutableLifetimes,
): Join => {
  const contributing = inputs.filter((type) => !Type.isNever(type))
  const first = contributing.at(0)
  if (first === undefined) return { _tag: 'Joined', type: 'never' }
  if (contributing.every((type) => Type.equals(type, first))) {
    return { _tag: 'Joined', type: first }
  }
  if (
    contributing.every(
      (type) => Type.isString(type) || Type.isReference(type) || Type.isSlice(type),
    ) &&
    contributing.every((type) => Type.runtimeKey(type) === Type.runtimeKey(first))
  ) {
    // A shorter view already present in an arm subsumes a longer one. Probe only existing
    // facts: selecting a candidate must never install constraints for rejected alternatives.
    const context = TypeCompatibility.context({
      assumptions: Lifetime.assumptions(lifetimes?.lifetimeBounds ?? []),
    })
    const common = contributing.find((candidate) =>
      contributing.every((type) =>
        TypeCompatibility.isCompatible(TypeCompatibility.check(type, candidate, context)),
      ),
    )
    if (common !== undefined) return { _tag: 'Joined', type: common }
  }
  const effects = contributing.flatMap((type) => {
    const contract = Type.isRepresented(type) ? type.contract : type
    return Type.isEffect(contract) ? [contract] : []
  })
  if (effects.length === contributing.length) {
    const firstEffect = effects.at(0)
    const metadata =
      lifetimes ??
      (firstEffect !== undefined &&
      effects.every(
        (effect) =>
          Lifetime.equals(effect.environment, firstEffect.environment) &&
          effect.lifetimeBinders.length === 0,
      )
        ? {
            environment: firstEffect.environment,
            lifetimeBinders: [],
            lifetimeBounds: effects.flatMap((effect) => effect.lifetimeBounds),
          }
        : undefined)
    if (metadata === undefined) return { _tag: 'Incompatible', types: [...contributing] }
    const success = Type.union(effects.map((effect) => effect.success))
    if (success._tag !== 'Normalized') return { _tag: 'Incompatible', types: [...contributing] }
    const failureRow = effects.reduce(
      (row, effect) => RowAlgebra.union(Type.failureRowPolicy(), row, effect.failureRow),
      RowAlgebra.concrete(Type.failureRowPolicy(), []),
    )
    const requirementRow = effects.reduce(
      (row, effect) => RowAlgebra.union(Type.requirementRowPolicy(), row, effect.requirementRow),
      RowAlgebra.concrete(Type.requirementRowPolicy(), []),
    )
    let access: Type.CallableMode = 'Shared'
    if (effects.some((effect) => effect.access === 'Take')) access = 'Take'
    else if (effects.some((effect) => effect.access === 'Exclusive')) access = 'Exclusive'
    return {
      _tag: 'Joined',
      type: Type.effectWithRows(success.type, failureRow, metadata, access, requirementRow),
    }
  }
  for (const [leftOrdinal, left] of contributing.entries()) {
    for (const right of contributing.slice(leftOrdinal + 1)) {
      if (Type.firstRepresentationDivergence(left, right) !== undefined)
        return { _tag: 'Incompatible', types: [...contributing] }
    }
  }
  const normalized = Type.union(contributing)
  return normalized._tag === 'Normalized'
    ? { _tag: 'Joined', type: normalized.type }
    : { _tag: 'Incompatible', types: [...contributing] }
}
