import * as Lifetime from './Lifetime.js'
import * as FiniteRow from './FiniteRow.js'
import * as Canonical from './internal/Canonical.js'
import * as RowAlgebra from './RowAlgebra.js'
import type * as SourceSpan from './SourceSpan.js'
import * as Type from './Type.js'

export type ProviderMode = 'Shared' | 'Exclusive' | 'Take'

export interface NominalMember {
  readonly _tag: 'NominalMemberConstraint'
  readonly selected: Type.Type
  readonly source: Type.FailureRow
}

export interface FailureSubset {
  readonly _tag: 'FailureSubsetConstraint'
  readonly selected: Type.FailureRow
  readonly source: Type.FailureRow
}

export interface RequirementSubset {
  readonly _tag: 'RequirementSubsetConstraint'
  readonly selected: Type.RequirementsRow
  readonly source: Type.RequirementsRow
}

export interface ProviderSelection {
  readonly _tag: 'ProviderSelectionConstraint'
  readonly mode: ProviderMode
  readonly provider: Type.Type
  readonly selected: Type.RequirementsRow
  readonly source: Type.RequirementsRow
}

export type Constraint = NominalMember | FailureSubset | RequirementSubset | ProviderSelection

export interface Occurrence {
  readonly constraint: Constraint
  readonly origin: SourceSpan.SourceSpan
}

export type WitnessOrigin =
  | {
      readonly _tag: 'SourceWitness'
      readonly declaration: { readonly module: string; readonly name: string }
    }
  | { readonly _tag: 'IntrinsicWitness'; readonly operation: string }

/** Stable witness identity with every specialized generic argument needed for reachability. */
export interface WitnessIdentity {
  readonly origin: WitnessOrigin
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
}

export type ProviderMatch =
  | { readonly _tag: 'Identity' }
  | { readonly _tag: 'Conformance'; readonly witness: WitnessIdentity }

export type ConformanceOutcome =
  | { readonly _tag: 'NoMatch' }
  | { readonly _tag: 'Unique'; readonly match: ProviderMatch }
  | { readonly _tag: 'Ambiguous'; readonly witnesses: ReadonlyArray<WitnessIdentity> }
  | { readonly _tag: 'Invalid'; readonly reason: string }

export type ConstraintEvidence =
  | {
      readonly _tag: 'Assumed'
      readonly wantedKey: string
      readonly wanted: Constraint
      readonly substitution: Type.Substitution
    }
  | {
      readonly _tag: 'Member'
      readonly selected: Type.Nominal
      readonly source: Type.FailureRow
    }
  | {
      readonly _tag: 'FailureSubset'
      readonly selected: Type.FailureRow
      readonly source: Type.FailureRow
    }
  | {
      readonly _tag: 'RequirementSubset'
      readonly selected: Type.RequirementsRow
      readonly source: Type.RequirementsRow
    }
  | {
      readonly _tag: 'RequirementSelection'
      readonly wantedKey: string
      readonly wanted: ProviderSelection
      readonly selected: Type.Requirement
      readonly provider: Type.Type
      readonly providerMatch: ProviderMatch
      readonly providerMode: ProviderMode
    }

export const nominalMember = (selected: Type.Type, source: Type.FailureRow): NominalMember => ({
  _tag: 'NominalMemberConstraint',
  selected,
  source,
})

export const failureSubset = (
  selected: Type.FailureRow,
  source: Type.FailureRow,
): FailureSubset => ({ _tag: 'FailureSubsetConstraint', selected, source })

export const requirementSubset = (
  selected: Type.RequirementsRow,
  source: Type.RequirementsRow,
): RequirementSubset => ({ _tag: 'RequirementSubsetConstraint', selected, source })

/** Proves a selected row obligation from declared evidence without inferring any row arguments. */
export const isImplied = (self: Constraint, givens: ReadonlyArray<Constraint>): boolean => {
  if (givens.some((given) => key(given) === key(self))) return true
  return (
    self._tag === 'RequirementSubsetConstraint' &&
    self.selected.memberWellFormed.length === 0 &&
    self.source.memberWellFormed.length === 0 &&
    RowAlgebra.isKnownSubset(
      Type.requirementRowPolicy(),
      self.selected,
      self.source,
      givens.filter(
        (given): given is RequirementSubset => given._tag === 'RequirementSubsetConstraint',
      ),
    )
  )
}

export const providerSelection = (
  mode: ProviderMode,
  provider: Type.Type,
  selected: Type.RequirementsRow,
  source: Type.RequirementsRow,
): ProviderSelection => ({ _tag: 'ProviderSelectionConstraint', mode, provider, selected, source })

export const witnessKey = (self: WitnessIdentity): string =>
  Canonical.record('WitnessIdentity', [
    self.origin._tag === 'SourceWitness'
      ? Canonical.record('Source', [self.origin.declaration.module, self.origin.declaration.name])
      : Canonical.record('Intrinsic', [self.origin.operation]),
    Canonical.array(self.typeArguments.map(Type.genericArgumentKey)),
  ])

export const providerMatchKey = (self: ProviderMatch): string =>
  self._tag === 'Identity'
    ? Canonical.record('ProviderIdentity')
    : Canonical.record('ProviderConformance', [witnessKey(self.witness)])

const substitutionKey = (self: Type.Substitution): string =>
  Canonical.array(
    [...self.entries()]
      .sort(([left], [right]) => {
        if (left < right) {
          return -1
        }
        if (left > right) {
          return 1
        }
        return 0
      })
      .map(([parameter, argument]) =>
        Canonical.record('SubstitutionEntry', [parameter, Type.genericArgumentKey(argument)]),
      ),
  )

/** Canonical serialization identity for symbolic and concrete proof data. */
export const evidenceKey = (self: ConstraintEvidence): string => {
  switch (self._tag) {
    case 'Assumed':
      return Canonical.record('AssumedEvidence', [
        self.wantedKey,
        key(self.wanted),
        substitutionKey(self.substitution),
      ])
    case 'Member':
      return Canonical.record('MemberEvidence', [
        Type.key(self.selected),
        RowAlgebra.key(Type.failureRowPolicy(), self.source),
      ])
    case 'FailureSubset':
      return Canonical.record('FailureSubsetEvidence', [
        RowAlgebra.key(Type.failureRowPolicy(), self.selected),
        RowAlgebra.key(Type.failureRowPolicy(), self.source),
      ])
    case 'RequirementSubset':
      return Canonical.record('RequirementSubsetEvidence', [
        RowAlgebra.key(Type.requirementRowPolicy(), self.selected),
        RowAlgebra.key(Type.requirementRowPolicy(), self.source),
      ])
    case 'RequirementSelection':
      return Canonical.record('RequirementSelectionEvidence', [
        self.wantedKey,
        key(self.wanted),
        Type.requirementRowPolicy().finite.collisionKey(self.selected),
        Type.key(self.provider),
        providerMatchKey(self.providerMatch),
        self.providerMode,
      ])
  }
}

/** Span-independent semantic constraint identity. */
const exhaustiveEvidence = (proof: never): never => {
  throw new RangeError(`Unknown constraint evidence: ${String(proof)}`)
}

export const key = (self: Constraint): string => {
  switch (self._tag) {
    case 'NominalMemberConstraint':
      return Canonical.record('NominalMemberConstraint', [
        Type.key(self.selected),
        RowAlgebra.key(Type.failureRowPolicy(), self.source),
      ])
    case 'FailureSubsetConstraint':
      return Canonical.record('FailureSubsetConstraint', [
        RowAlgebra.key(Type.failureRowPolicy(), self.selected),
        RowAlgebra.key(Type.failureRowPolicy(), self.source),
      ])
    case 'RequirementSubsetConstraint':
      return Canonical.record('RequirementSubsetConstraint', [
        RowAlgebra.key(Type.requirementRowPolicy(), self.selected),
        RowAlgebra.key(Type.requirementRowPolicy(), self.source),
      ])
    case 'ProviderSelectionConstraint':
      return Canonical.record('ProviderSelectionConstraint', [
        self.mode,
        Type.key(self.provider),
        RowAlgebra.key(Type.requirementRowPolicy(), self.selected),
        RowAlgebra.key(Type.requirementRowPolicy(), self.source),
      ])
  }
}

export const assumed = (
  wanted: Constraint,
  substitution: Type.Substitution,
): ConstraintEvidence => ({ _tag: 'Assumed', wantedKey: key(wanted), wanted, substitution })

export const requirementSelectionEvidence = (
  wanted: ProviderSelection,
  selected: Type.Requirement,
  providerMatch: ProviderMatch,
): Extract<ConstraintEvidence, { readonly _tag: 'RequirementSelection' }> => ({
  _tag: 'RequirementSelection',
  wantedKey: key(wanted),
  wanted,
  selected,
  provider: wanted.provider,
  providerMatch,
  providerMode: wanted.mode,
})

/**
 * Proves a fully concrete membership/subset wanted without declaration-index services.
 * Provider selection remains in ProviderSelection because it needs a conformance oracle.
 */
export const proveStructural = (
  self: NominalMember | FailureSubset | RequirementSubset,
):
  | Exclude<ConstraintEvidence, { readonly _tag: 'Assumed' | 'RequirementSelection' }>
  | undefined => {
  switch (self._tag) {
    case 'NominalMemberConstraint': {
      const source = RowAlgebra.concretize(Type.failureRowPolicy(), self.source)
      if (
        !Type.isNominal(self.selected) ||
        !Type.isRuntimeConcrete(self.selected) ||
        source._tag !== 'Concrete' ||
        source.row.members.some((member) => !Type.isRuntimeConcrete(member)) ||
        !FiniteRow.has(Type.failureRowPolicy().finite, source.row, self.selected)
      )
        return undefined
      return { _tag: 'Member', selected: self.selected, source: self.source }
    }
    case 'FailureSubsetConstraint': {
      if (
        self.selected.expression._tag === 'Singleton' &&
        RowAlgebra.isKnownSubset(Type.failureRowPolicy(), self.selected, self.source)
      )
        return {
          _tag: 'FailureSubset',
          selected: self.selected,
          source: self.source,
        }
      const selected = RowAlgebra.concretize(Type.failureRowPolicy(), self.selected)
      const source = RowAlgebra.concretize(Type.failureRowPolicy(), self.source)
      if (
        selected._tag !== 'Concrete' ||
        source._tag !== 'Concrete' ||
        selected.row.members.length === 0 ||
        selected.row.members.some((member) => !Type.isRuntimeConcrete(member)) ||
        source.row.members.some((member) => !Type.isRuntimeConcrete(member)) ||
        !FiniteRow.isSubset(Type.failureRowPolicy().finite, selected.row, source.row)
      )
        return undefined
      return {
        _tag: 'FailureSubset',
        selected: self.selected,
        source: self.source,
      }
    }
    case 'RequirementSubsetConstraint': {
      if (
        self.selected.memberWellFormed.length === 0 &&
        self.source.memberWellFormed.length === 0 &&
        RowAlgebra.isKnownSubset(Type.requirementRowPolicy(), self.selected, self.source)
      )
        return {
          _tag: 'RequirementSubset',
          selected: self.selected,
          source: self.source,
        }
      const selected = RowAlgebra.concretize(Type.requirementRowPolicy(), self.selected)
      const source = RowAlgebra.concretize(Type.requirementRowPolicy(), self.source)
      if (
        selected._tag !== 'Concrete' ||
        source._tag !== 'Concrete' ||
        selected.row.members.some(
          (requirement) => !Type.isRuntimeConcrete(requirement.capability),
        ) ||
        source.row.members.some((requirement) => !Type.isRuntimeConcrete(requirement.capability)) ||
        !FiniteRow.isSubset(Type.requirementRowPolicy().finite, selected.row, source.row)
      )
        return undefined
      return {
        _tag: 'RequirementSubset',
        selected: self.selected,
        source: self.source,
      }
    }
  }
}

/** Applies only independently established substitutions; constraint solving never inverts rows. */
export const substitute = (self: Constraint, substitution: Type.Substitution): Constraint => {
  switch (self._tag) {
    case 'NominalMemberConstraint': {
      const selected = Type.substitute(self.selected, substitution)
      return nominalMember(selected, Type.substituteFailureRow(self.source, substitution))
    }
    case 'FailureSubsetConstraint':
      return failureSubset(
        Type.substituteFailureRow(self.selected, substitution),
        Type.substituteFailureRow(self.source, substitution),
      )
    case 'RequirementSubsetConstraint':
      return requirementSubset(
        Type.substituteRequirementsRow(self.selected, substitution),
        Type.substituteRequirementsRow(self.source, substitution),
      )
    case 'ProviderSelectionConstraint':
      return providerSelection(
        self.mode,
        Type.substitute(self.provider, substitution),
        Type.substituteRequirementsRow(self.selected, substitution),
        Type.substituteRequirementsRow(self.source, substitution),
      )
  }
}

const specializeFailureRow = (
  row: Type.FailureRow,
  specializeType: (type: Type.Type) => Type.Type,
): Type.FailureRow =>
  RowAlgebra.mapConcreteMembers(Type.failureRowPolicy(), row, (failure) => {
    const specialized = specializeType(failure)
    return specialized
  })

const specializeRequirementRow = (
  row: Type.RequirementsRow,
  specializeType: (type: Type.Type) => Type.Type,
): Type.RequirementsRow =>
  RowAlgebra.mapConcreteMembers(Type.requirementRowPolicy(), row, (requirement) => {
    const capability = specializeType(requirement.capability)
    return {
      ...requirement,
      capability:
        Type.isNominal(capability) || Type.isParameter(capability)
          ? capability
          : requirement.capability,
    }
  })

const specializeConstraintExecutableOwner = (
  self: Constraint,
  specializeType: (type: Type.Type) => Type.Type,
): Constraint => {
  switch (self._tag) {
    case 'NominalMemberConstraint':
      return nominalMember(
        specializeType(self.selected),
        specializeFailureRow(self.source, specializeType),
      )
    case 'FailureSubsetConstraint':
      return failureSubset(
        specializeFailureRow(self.selected, specializeType),
        specializeFailureRow(self.source, specializeType),
      )
    case 'RequirementSubsetConstraint':
      return requirementSubset(
        specializeRequirementRow(self.selected, specializeType),
        specializeRequirementRow(self.source, specializeType),
      )
    case 'ProviderSelectionConstraint':
      return providerSelection(
        self.mode,
        specializeType(self.provider),
        specializeRequirementRow(self.selected, specializeType),
        specializeRequirementRow(self.source, specializeType),
      )
  }
}

/** Specializes every executable-owner identity retained by one nested callable schema. */
export const specializeCallableSchemaExecutableOwner: Type.CallableSchemaOwnerSpecializer = (
  schema,
  specializeType,
  specializeArgument,
) => {
  const constraints = schema.constraints.map((constraint) =>
    specializeConstraintExecutableOwner(constraint, specializeType),
  )
  const specializeSubstitution = (substitution: Type.Substitution): Type.Substitution =>
    new Map(
      [...substitution.entries()].map(([parameter, argument]) => [
        parameter,
        specializeArgument(argument),
      ]),
    )
  const specializeMatch = (match: ProviderMatch): ProviderMatch =>
    match._tag === 'Identity'
      ? match
      : {
          _tag: 'Conformance',
          witness: {
            origin: match.witness.origin,
            typeArguments: match.witness.typeArguments.map(specializeArgument),
          },
        }
  const evidence = schema.evidence.map((proof): ConstraintEvidence => {
    switch (proof._tag) {
      case 'Assumed':
        return assumed(
          specializeConstraintExecutableOwner(proof.wanted, specializeType),
          specializeSubstitution(proof.substitution),
        )
      case 'Member': {
        const selected = specializeType(proof.selected)
        return Type.isNominal(selected)
          ? {
              _tag: 'Member',
              selected,
              source: specializeFailureRow(proof.source, specializeType),
            }
          : proof
      }
      case 'FailureSubset':
        return {
          _tag: 'FailureSubset',
          selected: specializeFailureRow(proof.selected, specializeType),
          source: specializeFailureRow(proof.source, specializeType),
        }
      case 'RequirementSubset':
        return {
          _tag: 'RequirementSubset',
          selected: specializeRequirementRow(proof.selected, specializeType),
          source: specializeRequirementRow(proof.source, specializeType),
        }
      case 'RequirementSelection': {
        const wanted = specializeConstraintExecutableOwner(proof.wanted, specializeType)
        const selectedCapability = specializeType(proof.selected.capability)
        const provider = specializeType(proof.provider)
        if (
          wanted._tag !== 'ProviderSelectionConstraint' ||
          (!Type.isNominal(selectedCapability) && !Type.isParameter(selectedCapability))
        )
          return proof
        return {
          _tag: 'RequirementSelection',
          wantedKey: key(wanted),
          wanted,
          selected: { ...proof.selected, capability: selectedCapability },
          provider,
          providerMatch: specializeMatch(proof.providerMatch),
          providerMode: proof.providerMode,
        }
      }
    }
    return exhaustiveEvidence(proof)
  })
  const contractConstraints = schema.contract.constraints.map((constraint) =>
    specializeConstraintExecutableOwner(constraint, specializeType),
  )
  const contract = {
    ...schema.contract,
    typeOutlives: schema.contract.typeOutlives.map((bound) => ({
      ...bound,
      type: specializeType(bound.type),
    })),
    parameters: schema.contract.parameters.map((parameter) => ({
      ...parameter,
      type: specializeType(parameter.type),
    })),
    result: specializeType(schema.contract.result),
    constraints: contractConstraints,
  }
  const contractKey = Canonical.record('CallableContract', [
    contract.functionKind,
    Lifetime.key(contract.environment),
    Canonical.array(contract.lifetimeBinders.map(Lifetime.key)),
    Lifetime.assumptions(contract.lifetimeBounds).key,
    Type.typeOutlivesKey(contract.typeOutlives),
    contract.unsafe ? 'unsafe' : 'safe',
    Canonical.array(contract.binders.map(Type.key)),
    Canonical.array(
      contract.parameters.map((parameter) =>
        Canonical.record('Parameter', [parameter.mode, Type.key(parameter.type)]),
      ),
    ),
    Type.key(contract.result),
    Canonical.array(contract.constraints.map(key)),
    Canonical.array(
      contract.captures.map((capture) =>
        Canonical.record('Capture', [`${capture.parameter}`, `${capture.capture}`]),
      ),
    ),
    ...(contract.invocationUse === undefined ? [] : [Type.invocationUseKey(contract)]),
  ])
  return {
    ...schema,
    contract,
    constraints: constraints,
    evidence: evidence,
    substitution: specializeSubstitution(schema.substitution),
    contractKey,
    constraintKeys: constraints.map(key),
    evidenceKeys: evidence.map(evidenceKey),
  }
}
