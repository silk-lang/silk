import * as Constraint from './Constraint.js'
import type * as FiniteRow from './FiniteRow.js'
import * as RequirementRow from './RequirementRow.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as ResolutionWork from './ResolutionWork.js'
import * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

export type CandidateStatus =
  | { readonly _tag: 'Unique'; readonly match: Constraint.ProviderMatch }
  | {
      readonly _tag: 'AccessMismatch'
      readonly provider: RequirementRow.ProviderAccess
      readonly required: RequirementRow.Access
    }
  | { readonly _tag: 'Ambiguous'; readonly witnesses: ReadonlyArray<Constraint.WitnessIdentity> }
  | { readonly _tag: 'Invalid'; readonly reason: string }

/**
 * Where a relation was written. The solver never reads an origin: a caller that reports in source
 * coordinates passes spans, and one that reports revision-free passes locations.
 */
export type NonEmptyOrigins<L = SourceSpan.SourceSpan> = readonly [L, ...ReadonlyArray<L>]

export interface Relation<L = SourceSpan.SourceSpan> {
  readonly wanted: Constraint.ProviderSelection
  readonly origins: NonEmptyOrigins<L>
}

export interface CandidateRecord {
  readonly member: Type.Requirement
  readonly status: CandidateStatus
}

export interface RelationCandidates<L = SourceSpan.SourceSpan> {
  readonly constraintKey: string
  readonly wanted: Constraint.ProviderSelection
  readonly origins: NonEmptyOrigins<L>
  readonly candidates: ReadonlyMap<string, CandidateRecord>
}

export interface RelationPayload {
  readonly constraintKey: string
  readonly fullCandidateKeySet: ReadonlyArray<string>
}

export interface DiagnosticLocations<L = SourceSpan.SourceSpan> {
  readonly primary: L
  readonly relations: ReadonlyArray<{
    readonly constraintKey: string
    readonly origins: NonEmptyOrigins<L>
  }>
}

export type SelectionProblem =
  | {
      readonly _tag: 'SelectedRowCardinality'
      readonly count: number
    }
  | {
      readonly _tag: 'ProviderNoMatch'
      readonly constraintKey: string
    }
  | {
      readonly _tag: 'ProviderAccessMismatch'
      readonly memberKey: string
      readonly constraintKey: string
      readonly provider: RequirementRow.ProviderAccess
      readonly required: RequirementRow.Access
    }
  | {
      readonly _tag: 'JointSelectionConflict'
      readonly payload: { readonly relations: ReadonlyArray<RelationPayload> }
    }
  | {
      readonly _tag: 'ConformanceAmbiguity'
      readonly memberKey: string
      readonly constraintKey: string
      readonly witnesses: ReadonlyArray<Constraint.WitnessIdentity>
    }
  | {
      readonly _tag: 'InvalidConformance'
      readonly memberKey: string
      readonly constraintKey: string
      readonly reason: string
    }
  | {
      readonly _tag: 'ProviderAmbiguity'
      readonly payload: {
        readonly survivingCandidates: ReadonlyArray<string>
        readonly relations: ReadonlyArray<RelationPayload>
      }
    }

/** One span-free solver problem paired with diagnostic-only source provenance. */
export interface SelectionDiagnostic<L = SourceSpan.SourceSpan> {
  readonly problem: SelectionProblem
  readonly locations: DiagnosticLocations<L>
}

const diagnostic = <L>(
  problem: SelectionProblem,
  sourceLocations: DiagnosticLocations<L>,
): SelectionDiagnostic<L> => ({ problem: problem, locations: sourceLocations })

export type SelectionDiagnostics<L = SourceSpan.SourceSpan> = readonly [
  SelectionDiagnostic<L>,
  ...ReadonlyArray<SelectionDiagnostic<L>>,
]

export type Result<L = SourceSpan.SourceSpan> =
  | {
      readonly _tag: 'Selected'
      readonly member: Type.Requirement
      readonly evidence: ReadonlyArray<
        Extract<Constraint.ConstraintEvidence, { readonly _tag: 'RequirementSelection' }>
      >
    }
  | { readonly _tag: 'Rejected'; readonly diagnostics: SelectionDiagnostics<L> }

const rejected = <L>(
  diagnostics: ReadonlyArray<SelectionDiagnostic<L>>,
): Extract<Result<L>, { readonly _tag: 'Rejected' }> => {
  const first = diagnostics.at(0)
  if (first === undefined)
    throw new RangeError('Provider selection rejection requires at least one diagnostic')
  const nonEmptyDiagnostics: SelectionDiagnostics<L> = [first, ...diagnostics.slice(1)]
  return {
    _tag: 'Rejected',
    diagnostics: nonEmptyDiagnostics,
  }
}

export interface ConformanceOracle {
  readonly match: (provider: Type.Type, capability: Type.Nominal) => Constraint.ConformanceOutcome
  readonly observation?: {
    readonly work: ResolutionWork.ResolutionWork
    readonly initiator: ResolutionWork.Initiator
  }
}

const compareText = (left: string, right: string): number => {
  if (left < right) {
    return -1
  }
  if (left > right) {
    return 1
  }
  return 0
}

/** The key that makes two origins the same one, and orders them deterministically. */
export type OriginKey<L> = (origin: L) => string

const canonicalOrigins = <L>(
  origins: NonEmptyOrigins<L>,
  key: OriginKey<L>,
): NonEmptyOrigins<L> => {
  const canonical = [...new Map(origins.map((origin) => [key(origin), origin])).entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, origin]) => origin)
  const first = canonical.at(0)
  return first === undefined ? origins : [first, ...canonical.slice(1)]
}

const policy = RequirementRow.policy<NonNullable<Type.Requirement['capability']>>(Type.key)
const memberKey = policy.collisionKey

const providerAccess = (mode: Constraint.ProviderMode): RequirementRow.ProviderAccess =>
  mode === 'Take' ? 'Take' : mode

const candidateStatus = (
  wanted: Constraint.ProviderSelection,
  member: Type.Requirement,
  oracle: ConformanceOracle,
): CandidateStatus | undefined => {
  const access = providerAccess(wanted.mode)
  if (Type.equals(wanted.provider, member.capability))
    return RequirementRow.providerCanSelect(access, member.access)
      ? { _tag: 'Unique', match: { _tag: 'Identity' } }
      : { _tag: 'AccessMismatch', provider: access, required: member.access }
  if (!Type.isNominal(member.capability)) return undefined
  const outcome = oracle.match(wanted.provider, member.capability)
  switch (outcome._tag) {
    case 'NoMatch':
      return undefined
    case 'Unique':
      return RequirementRow.providerCanSelect(access, member.access)
        ? { _tag: 'Unique', match: outcome.match }
        : { _tag: 'AccessMismatch', provider: access, required: member.access }
    case 'Ambiguous':
      return {
        _tag: 'Ambiguous',
        witnesses: [...outcome.witnesses].sort((left, right) =>
          compareText(Constraint.witnessKey(left), Constraint.witnessKey(right)),
        ),
      }
    case 'Invalid':
      return { _tag: 'Invalid', reason: outcome.reason }
  }
}

const concreteSource = (
  wanted: Constraint.ProviderSelection,
): FiniteRow.FiniteRow<Type.Requirement> | undefined => {
  const concrete = RowAlgebra.concretize(Type.requirementRowPolicy(), wanted.source)
  return concrete._tag === 'Concrete' ? concrete.row : undefined
}

const relationCandidates = <L>(
  relation: Relation<L>,
  oracle: ConformanceOracle,
  key: OriginKey<L>,
  selected?: Type.RequirementsRow,
): RelationCandidates<L> => {
  const candidates = new Map<string, CandidateRecord>()
  const observation = oracle.observation
  const work =
    observation === undefined
      ? undefined
      : ResolutionWork.begin(
          observation.work,
          {
            ...observation.initiator,
            key: `${observation.initiator.key}/${Constraint.key(relation.wanted)}`,
          },
          'ProviderSelection',
        )
  // An explicit selector can name a known member of an otherwise open source row. Never infer
  // a selector from that partial view: an unknown tail could contain another matching member.
  const selectedMembers = selectedFinite(selected)?.members
  const explicitMember = selectedMembers?.length === 1 ? selectedMembers.at(0) : undefined
  const rowPolicy = Type.requirementRowPolicy()
  const sourceMembers =
    concreteSource(relation.wanted)?.members ??
    (explicitMember === undefined
      ? []
      : RowAlgebra.positiveConcreteMembers(rowPolicy, relation.wanted.source).filter(
          (member) =>
            memberKey(member) === memberKey(explicitMember) &&
            RowAlgebra.isKnownSubset(
              rowPolicy,
              RowAlgebra.concrete(rowPolicy, [member]),
              relation.wanted.source,
            ),
        ))
  for (const member of sourceMembers) {
    if (work !== undefined) ResolutionWork.visit(work)
    const status = candidateStatus(relation.wanted, member, oracle)
    if (status !== undefined) {
      if (work !== undefined) ResolutionWork.accept(work)
      candidates.set(memberKey(member), { member, status })
    }
  }
  return {
    constraintKey: Constraint.key(relation.wanted),
    wanted: relation.wanted,
    origins: canonicalOrigins(relation.origins, key),
    candidates: new Map(
      [...candidates.entries()].sort(([left], [right]) => compareText(left, right)),
    ),
  }
}

/** Groups both textual duplicates and post-substitution semantic-key collisions. */
export const groupRelations = <L>(
  relations: ReadonlyArray<Relation<L>>,
  originKey: OriginKey<L>,
): ReadonlyArray<Relation<L>> => {
  const grouped = new Map<string, Relation<L>>()
  for (const relation of relations) {
    const key = Constraint.key(relation.wanted)
    const existing = grouped.get(key)
    const origins: NonEmptyOrigins<L> =
      existing === undefined
        ? relation.origins
        : [existing.origins[0], ...existing.origins.slice(1), ...relation.origins]
    grouped.set(key, {
      wanted: existing?.wanted ?? relation.wanted,
      origins: canonicalOrigins(origins, originKey),
    })
  }
  return [...grouped.entries()]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, relation]) => relation)
}

/** Builds every relation's complete candidate map without emitting diagnostics. */
export const candidates = <L>(
  relations: ReadonlyArray<Relation<L>>,
  oracle: ConformanceOracle,
  originKey: OriginKey<L>,
): ReadonlyArray<RelationCandidates<L>> =>
  groupRelations(relations, originKey).map((relation) =>
    relationCandidates(relation, oracle, originKey),
  )

const payload = <L>(
  relations: ReadonlyArray<RelationCandidates<L>>,
): ReadonlyArray<RelationPayload> =>
  relations.map((relation) => ({
    constraintKey: relation.constraintKey,
    fullCandidateKeySet: [...relation.candidates.keys()],
  }))

const locations = <L>(
  relations: ReadonlyArray<RelationCandidates<L>>,
  responsible: L,
): DiagnosticLocations<L> => {
  return {
    primary: responsible,
    relations: relations.map((relation) => ({
      constraintKey: relation.constraintKey,
      origins: relation.origins,
    })),
  }
}

const selectedFinite = (
  selected: Type.RequirementsRow | undefined,
): FiniteRow.FiniteRow<Type.Requirement> | undefined => {
  if (selected === undefined) return undefined
  const concrete = RowAlgebra.concretize(Type.requirementRowPolicy(), selected)
  return concrete._tag === 'Concrete' ? concrete.row : undefined
}

const candidateAt = <L>(relation: RelationCandidates<L>, key: string): CandidateRecord => {
  const candidate = relation.candidates.get(key)
  if (candidate === undefined)
    throw new RangeError(`Provider selection lost candidate ${key} from a surviving relation`)
  return candidate
}

/** Solves one conjunctive selected-row variable after all ordinary substitutions are known. */
export const solve = <L>(options: {
  readonly relations: ReadonlyArray<Relation<L>>
  readonly selected?: Type.RequirementsRow
  readonly responsible: L
  readonly originKey: OriginKey<L>
  readonly oracle: ConformanceOracle
}): Result<L> => {
  if (options.relations.length === 0)
    throw new RangeError('Provider selection requires at least one relation')
  const maps = groupRelations(options.relations, options.originKey).map((relation) =>
    relationCandidates(relation, options.oracle, options.originKey, options.selected),
  )
  const selected = selectedFinite(options.selected)
  if (options.selected !== undefined && (selected === undefined || selected.members.length !== 1))
    return rejected([
      diagnostic(
        { _tag: 'SelectedRowCardinality', count: selected?.members.length ?? 0 },
        locations(maps, options.responsible),
      ),
    ])

  const selectedMember = selected?.members.at(0)
  let considered: ReadonlyArray<RelationCandidates<L>>
  if (selectedMember === undefined) {
    considered = maps
  } else {
    considered = maps.map((relation) => {
      const key = memberKey(selectedMember)
      const candidate = relation.candidates.get(key)
      return {
        ...relation,
        candidates: new Map(candidate === undefined ? [] : [[key, candidate]]),
      }
    })
  }
  const empty = considered.filter((relation) => relation.candidates.size === 0)
  if (empty.length > 0)
    return rejected(
      empty.map((relation) =>
        diagnostic(
          { _tag: 'ProviderNoMatch', constraintKey: relation.constraintKey },
          locations([relation], options.responsible),
        ),
      ),
    )

  const firstRelation = considered.at(0)
  if (firstRelation === undefined)
    throw new RangeError('Provider selection lost its first candidate relation')
  const firstKeys = new Set(firstRelation.candidates.keys())
  const surviving = [...firstKeys]
    .filter((key) => considered.every((relation) => relation.candidates.has(key)))
    .sort(compareText)
  if (surviving.length === 0)
    return rejected([
      diagnostic(
        {
          _tag: 'JointSelectionConflict',
          payload: { relations: payload(considered) },
        },
        locations(considered, options.responsible),
      ),
    ])

  const statusDiagnostics: Array<SelectionDiagnostic<L>> = []
  for (const key of surviving)
    for (const relation of considered) {
      const status = candidateAt(relation, key).status
      if (status._tag === 'AccessMismatch')
        statusDiagnostics.push(
          diagnostic(
            {
              _tag: 'ProviderAccessMismatch',
              memberKey: key,
              constraintKey: relation.constraintKey,
              provider: status.provider,
              required: status.required,
            },
            locations([relation], options.responsible),
          ),
        )
      if (status._tag === 'Ambiguous')
        statusDiagnostics.push(
          diagnostic(
            {
              _tag: 'ConformanceAmbiguity',
              memberKey: key,
              constraintKey: relation.constraintKey,
              witnesses: status.witnesses,
            },
            locations([relation], options.responsible),
          ),
        )
      if (status._tag === 'Invalid')
        statusDiagnostics.push(
          diagnostic(
            {
              _tag: 'InvalidConformance',
              memberKey: key,
              constraintKey: relation.constraintKey,
              reason: status.reason,
            },
            locations([relation], options.responsible),
          ),
        )
    }
  if (statusDiagnostics.length > 0) return rejected(statusDiagnostics)
  if (surviving.length > 1)
    return rejected([
      diagnostic(
        {
          _tag: 'ProviderAmbiguity',
          payload: {
            survivingCandidates: surviving,
            relations: payload(considered),
          },
        },
        locations(considered, options.responsible),
      ),
    ])

  const survivingKey = surviving.at(0)
  if (survivingKey === undefined)
    throw new RangeError('Provider selection lost its surviving candidate key')
  const first = candidateAt(firstRelation, survivingKey)
  const evidence = considered.flatMap((relation) => {
    const candidate = candidateAt(relation, survivingKey)
    if (candidate.status._tag !== 'Unique')
      throw new RangeError('Provider selection retained a non-unique surviving candidate')
    return [
      Constraint.requirementSelectionEvidence(
        relation.wanted,
        candidate.member,
        candidate.status.match,
      ),
    ]
  })
  return {
    _tag: 'Selected',
    member: first.member,
    evidence: evidence,
  }
}
