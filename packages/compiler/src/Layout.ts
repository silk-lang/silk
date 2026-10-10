import * as Effect from 'effect/Effect'
import * as CleanupPlan from './CleanupPlan.js'
import * as ConformanceProof from './ConformanceProof.js'
import * as DeclarationFacts from './DeclarationFacts.js'
import * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as DeclarationIndex from './DeclarationIndex.js'
import * as Diagnostic from './Diagnostic.js'
import * as ExecutionPackage from './ExecutionPackage.js'
import * as FieldRealization from './FieldRealization.js'
import * as Tir from './Tir.js'
import * as InstanceDiagnostics from './InstanceDiagnostics.js'
import * as Instances from './Instances.js'
import * as ExecutableInputView from './ExecutableInputView.js'
import * as EffectProducer from './EffectProducer.js'
import { alignUp } from './internal/Align.js'
import type {
  AddressScalar,
  CallingLane,
  CallingScalar,
  CallingShape,
  CallingShapeNode,
  Selector,
} from './internal/CallingShape.js'
import * as Packing from './internal/Packing.js'
import * as TypeInference from './internal/TypeInference.js'
import * as LocalSharedAllocationProvenance from './LocalSharedAllocationProvenance.js'
import * as LocalSharedControlBlock from './LocalSharedControlBlock.js'
import * as Match from './Match.js'
import * as MovePath from './MovePath.js'
import * as OpaqueRealization from './OpaqueRealization.js'
import * as RepresentationField from './RepresentationField.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as Scalar from './Scalar.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as StaticText from './StaticText.js'
import * as SuspensionMode from './SuspensionMode.js'
import * as StaticValue from './StaticValue.js'
import type * as Target from './Target.js'
import type * as SemanticContext from './SemanticContext.js'
import * as Type from './Type.js'
import * as ValueStorage from './ValueStorage.js'
export type { AddressScalar, CallingLane, CallingScalar, CallingShape, CallingShapeNode, Selector }

/** Physical placement shared by every aggregate and hidden-environment field. */
export interface PlacedField extends Packing.PlacedField {}

/** One declaration-ordered physical field within an aggregate representation. */
export interface Field extends PlacedField {
  readonly _tag: 'LayoutField'
  readonly id: DeclarationFacts.FieldId
  readonly name: string
  readonly type: DeclarationFacts.SemanticType
}

/** Static cleanup hook required before structural cleanup; contributes no ABI bytes. */
export interface CleanupHook {
  readonly hook: DeclarationFacts.CanonicalId
  readonly typeArguments: ReadonlyArray<Type.GenericArgument>
}

/** The initial closed representation vocabulary for concrete runtime types. */
export type Representation =
  | {
      readonly _tag: 'SignedInteger'
      readonly bits: Scalar.FixedBits
    }
  | {
      readonly _tag: 'UnsignedInteger'
      readonly bits: Scalar.FixedBits
    }
  | {
      readonly _tag: 'ScalarEnum'
      readonly enum: DeclarationFacts.CanonicalId
      readonly scalar: Scalar.EnumRepresentationSpelling
      readonly bits: Scalar.FixedBits
      readonly signedness: 'Signed' | 'Unsigned'
      readonly members: ReadonlyArray<{
        readonly member: DeclarationFacts.CanonicalEnumMemberId
        readonly discriminant: bigint
      }>
    }
  | {
      readonly _tag: 'Floating'
      readonly bits: 32 | 64
      readonly ieee: true
    }
  | {
      readonly _tag: 'Boolean'
      readonly bits: 32
      readonly falseValue: 0
      readonly trueValue: 1
    }
  | {
      readonly _tag: 'Aggregate'
      readonly fields: ReadonlyArray<Field>
      readonly tailPadding: number
      readonly cleanupHook?: CleanupHook
    }
  | {
      readonly _tag: 'CallableEnvironment'
      readonly realization: FieldRealization.CallableRealization
      readonly fields: ReadonlyArray<CallableEnvironmentField>
      readonly tailPadding: number
    }
  | {
      readonly _tag: 'StoredEffectEnvironment'
      readonly realization: FieldRealization.EffectRealization
      readonly fields: ReadonlyArray<StoredEffectEnvironmentField>
      readonly tailPadding: number
    }
  | {
      readonly _tag: 'Repeated'
      readonly element: DeclarationFacts.SemanticType
      readonly length: number
      readonly stride: number
    }
  | {
      readonly _tag: 'Slice'
      readonly element: DeclarationFacts.SemanticType
      readonly address: {
        readonly bits: 32 | 64
        readonly offset: 0
        readonly size: 4 | 8
        readonly alignment: 4 | 8
      }
      readonly length: {
        readonly type: 'usize'
        readonly offset: number
        readonly size: 4 | 8
      }
      readonly addressPadding: number
      readonly tailPadding: number
      readonly stride: number
    }
  | {
      readonly _tag: 'String'
      readonly storage: {
        readonly provenance: 'Utf8'
        readonly bits: 32 | 64
        readonly offset: 0
        readonly size: 4 | 8
        readonly alignment: 4 | 8
      }
      readonly byteLength: {
        readonly type: 'usize'
        readonly offset: number
        readonly size: 4 | 8
      }
      readonly storagePadding: number
      readonly tailPadding: number
    }
  | {
      readonly _tag: 'Reference'
      readonly target: DeclarationFacts.SemanticType
      readonly address: {
        readonly bits: 32 | 64
        readonly offset: 0
        readonly size: 4 | 8
        readonly alignment: 4 | 8
      }
    }
  | {
      readonly _tag: 'Union'
      readonly tag: {
        readonly bits: 32
        readonly size: 4
      }
      readonly members: ReadonlyArray<{
        readonly type: Type.Type
        readonly ordinal: number
        readonly size: number
        readonly alignment: number
      }>
      readonly payloadOffset: number
      readonly payloadSize: number
      readonly payloadAlignment: number
      readonly tagPadding: number
      readonly tailPadding: number
    }
  | {
      readonly _tag: 'NominalUnion'
      readonly union: DeclarationFacts.CanonicalId
      readonly tag: {
        readonly bits: 32
        readonly size: 4
      }
      readonly variants: ReadonlyArray<{
        readonly variant: DeclarationFacts.CanonicalUnionVariantId
        readonly ordinal: number
        readonly fields: ReadonlyArray<Field>
        readonly size: number
        readonly alignment: number
        readonly tailPadding: number
      }>
      readonly payloadOffset: number
      readonly payloadSize: number
      readonly payloadAlignment: number
      readonly tagPadding: number
      readonly tailPadding: number
      readonly cleanupHook?: CleanupHook
    }

/** One compiler-owned concrete layout entry. */
export interface Entry {
  readonly _tag: 'LayoutEntry'
  readonly type: DeclarationFacts.SemanticType
  /** Concrete sealed Copy evidence carried unchanged into MIR and every backend. */
  readonly copy: boolean
  readonly size: number
  readonly alignment: number
  readonly representation: Representation
  /** Compiler-private inline lanes for one exact executable value with no structural ABI. */
  readonly executable?: {
    readonly _tag: 'Callable' | 'Effect'
    readonly fields: ReadonlyArray<
      PlacedField & {
        readonly capture: number
        readonly type: DeclarationFacts.SemanticType
        readonly access: Type.CaptureAccess
        readonly representation: 'Value' | 'Borrow' | 'Callable'
        readonly offset: number
        readonly size: number
        readonly alignment: number
        readonly padding: number
        readonly effectIdentity?: string
        readonly callableIdentity?: Type.CallableIdentityArgument
      }
    >
  }
}

/** Why one nominal declaration cannot have a concrete physical representation. */
export type UnavailableReason =
  | {
      readonly _tag: 'InvalidDeclaration'
      readonly detail: string
    }
  | {
      readonly _tag: 'UnavailableField'
      readonly field?: DeclarationFacts.FieldId
      readonly detail: string
    }
  | {
      readonly _tag: 'UnavailableDependency'
      readonly dependency: DeclarationFacts.SemanticType
    }

/** One retained nominal layout failure that does not prevent unrelated layouts. */
export interface UnavailableEntry {
  readonly _tag: 'UnavailableLayoutEntry'
  readonly type: DeclarationFacts.SemanticType
  readonly dependencies: ReadonlyArray<Type.Nominal>
  readonly reason: UnavailableReason
  readonly cause?: Diagnostic.CauseIdentity
}

export type CatalogEntry = Entry | UnavailableEntry

/** One valid target-word constant awaiting the selected target's exact range verdict. */
export interface WordConstantLiteral {
  readonly type: WordType
  readonly value: bigint
  readonly span: SourceSpan.SourceSpan
}

/** The integer types whose width is the selected target's word. */
export type WordType = 'usize' | 'isize'

/** Every canonical nominal declaration laid out for one selected target. */
export interface Catalog {
  readonly _tag: 'LayoutCatalog'
  readonly target: Target.Target
  readonly entries: ReadonlyArray<CatalogEntry>
  readonly wordConstants: ReadonlyArray<WordConstantLiteral>
}

/** The concrete layouts reached by one target-aware MIR program. */
export interface Plan {
  readonly _tag: 'LayoutPlan'
  readonly target: Target.Target
  readonly entries: ReadonlyArray<Entry>
  readonly effectEnvironments: ReadonlyArray<EffectEnvironment>
  readonly callableEnvironments: ReadonlyArray<CallableEnvironment>
  readonly callingShapes: ReadonlyArray<CallingShape>
  readonly valueStorage: ReadonlyArray<ValueStorage.Selection>
  readonly staticData?: ReadonlyArray<StaticDataPlacement>
  readonly literalVerdicts: ReadonlyArray<WordLiteralVerdict>
  readonly localSharedAllocationProvenance: LocalSharedAllocationProvenance.Plan
  readonly executionPackages: ExecutionPackage.Module
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}

/** Target placement facts for compiler-owned immutable literal bytes. */
export interface StaticDataPlacement {
  readonly _tag: 'StaticDataPlacement'
  readonly data: StaticText.Data
  readonly alignment: 1
  readonly addressBits: 32 | 64
  readonly lengthBits: 32 | 64
}

/** Target-owned storage for one monomorphized hidden Effect closure environment. */
export type EffectEnvironment =
  | {
      readonly _tag: 'EffectEnvironment'
      readonly instance: Instances.InstanceKey
      readonly site: Tir.EffectSiteId
      readonly effect: Type.Effect
      readonly successEffectIdentity?: string
      readonly fields: ReadonlyArray<EffectEnvironmentField>
      readonly size: number
      readonly alignment: number
      readonly tailPadding: number
    }
  | {
      readonly _tag: 'UnavailableEffectEnvironment'
      readonly instance: Instances.InstanceKey
      readonly site: Tir.EffectSiteId
      readonly effect: Type.Effect
      readonly reason: string
    }

export interface EffectEnvironmentField extends PlacedField {
  readonly source: 'Binding' | 'Parameter' | 'Pattern'
  readonly ordinal: number
  readonly access: Type.CaptureAccess
  readonly type: DeclarationFacts.SemanticType
  readonly representation: 'Value' | 'Borrow' | 'Callable'
  readonly effectIdentity?: string
  /** Canonical environment selected when `effectIdentity` was a representation-site alias. */
  readonly resolvedEffectIdentity?: string
  /** Original checked caller edge selecting the source parameter view of this payload. */
  readonly inputView?: {
    readonly owner: Instances.InstanceKey
    readonly callNode: Tir.NodeId
    readonly view: Tir.ExecutableInputView
  }
  readonly callableIdentity?: Type.CallableIdentityArgument
  readonly providedRequirement?: NonNullable<
    FieldRealization.EffectEnvironmentSlot['providedRequirement']
  >
}

/** One realized Effect slot after target placement inside its enclosing nominal field. */
export interface StoredEffectEnvironmentField extends EffectEnvironmentField {
  readonly capture: number
}

/** Target-owned storage and call-scoped view for one concrete callable section identity. */
export type CallableEnvironment =
  | {
      readonly _tag: 'CallableEnvironment'
      readonly callable: Instances.CallableInstance
      readonly fields: ReadonlyArray<CallableEnvironmentField>
      readonly size: number
      readonly alignment: number
      readonly tailPadding: number
      readonly view: CallableView
    }
  | {
      readonly _tag: 'UnavailableCallableEnvironment'
      readonly callable: Instances.CallableInstance
      readonly reason: string
      readonly view: CallableView
    }

export interface CallableEnvironmentField extends PlacedField {
  readonly ordinal: number
  readonly parameterOrdinal: number
  readonly access: Type.CaptureAccess
  readonly type: DeclarationFacts.SemanticType
  readonly representation: 'Value' | 'Borrow' | 'Callable'
  readonly callableIdentity?: Type.CallableIdentityArgument
}

/** The ephemeral target-local pair passed at indirect callable application. */
export interface CallableView {
  readonly codeOffset: 0
  readonly environmentOffset: number
  readonly size: number
  readonly alignment: number
  readonly pointerBits: 32 | 64
}

/** A target-owned verdict for one reachable exact contextual `usize` or `isize` literal. */
export type WordLiteralVerdict =
  | {
      readonly _tag: 'AvailableWordLiteral'
      readonly type: WordType
      readonly value: bigint
      readonly bits: 32 | 64
      readonly span: SourceSpan.SourceSpan
    }
  | {
      readonly _tag: 'UnavailableWordLiteral'
      readonly type: WordType
      readonly value: bigint
      readonly bits: 32 | 64
      readonly span: SourceSpan.SourceSpan
      readonly cause: Diagnostic.CauseIdentity
    }

/** One member-specific lane transfer between two failure payload carriers. */
export interface FailurePayloadLane {
  readonly sourceOrdinal: number
  readonly source: CallingLane
  readonly member: CallingLane
  readonly targetOrdinal: number
  readonly target: CallingLane
}

/** The exact lanes occupied by one failure member while it moves between carrier rows. */
export interface FailurePayloadRepacking {
  readonly member: Type.Type
  readonly targetPayloadLanes: ReadonlyArray<CallingLane>
  readonly lanes: ReadonlyArray<FailurePayloadLane>
}

/** One deterministic explanation of malformed layout facts. */
export interface Violation {
  readonly _tag: 'LayoutViolation'
  readonly rule:
    | 'NonCanonicalTarget'
    | 'DuplicateType'
    | 'NonCanonicalOrder'
    | 'InvalidScalar'
    | 'InvalidAggregate'
    | 'InvalidCLayout'
    | 'InvalidCallingShape'
    | 'InvalidValueStorage'
    | 'InvalidLiteralVerdict'
    | 'CatalogMismatch'
  readonly type?: DeclarationFacts.SemanticType
  readonly detail: string
}

// Planning entry points

/** Computes every canonical nominal layout before runtime reachability or backend work. */
export const computeTypes = Effect.fn('Layout.computeTypes')(function* (
  target: Target.Target,
  index: DeclarationIndex.Index,
  registry: SemanticContext.Registry,
  opaqueRealizations?: OpaqueRealization.Catalog,
): Effect.fn.Return<Catalog> {
  const state = makeCatalogState(target, index, undefined, opaqueRealizations)
  const { declarations, unionDeclarations, completed } = state
  const referenced = new Map<string, DeclarationFacts.SemanticType>()
  yield* collectDeclaredTypes(index, referenced)
  for (const declaration of declarations) {
    if (declaration.struct.typeParameters.length === 0)
      yield* layoutNominal(state, declaration.type)
  }
  for (const declaration of unionDeclarations) {
    if (declaration.union.typeParameters.length === 0) yield* layoutNominal(state, declaration.type)
  }
  yield* completeCatalog(state, referenced)
  return {
    _tag: 'LayoutCatalog',
    target,
    entries: [...completed.values()].sort((left, right) =>
      compareRuntimeTypes(left.type, right.type),
    ),
    wordConstants: index.modules.flatMap((module) =>
      module.constants.flatMap((constant) => {
        if (constant.declaredType._tag !== 'Resolved' || !isWordType(constant.declaredType.type))
          return []
        const literal = constant.literal
        if (literal._tag !== 'IntegerLiteral') return []
        return [
          {
            type: constant.declaredType.type,
            value: literal.value,
            span: registry.spanOf(literal.anchor),
          },
        ]
      }),
    ),
  }
})

const completeForInstances = Effect.fnUntraced(function* (
  self: Catalog,
  discovery: Instances.Discovery,
  index: DeclarationIndex.Index,
  reached: ReadonlyMap<string, DeclarationFacts.SemanticType>,
  opaqueRealizations?: OpaqueRealization.Catalog,
): Effect.fn.Return<Catalog> {
  const state = makeCatalogState(self.target, index, discovery, opaqueRealizations)
  const referenced = new Map<string, DeclarationFacts.SemanticType>()
  yield* collectDeclaredTypes(index, referenced)
  yield* collectInstanceTypes(discovery, referenced)
  yield* completeCatalog(state, referenced)
  const runtimeReferenced = new Map<string, DeclarationFacts.SemanticType>()
  const visiting = new Set<string>()
  for (const type of reached.values()) yield* addReached(runtimeReferenced, type, visiting)
  for (const key of runtimeReferenced.keys()) {
    if (state.completed.get(key)?._tag === 'UnavailableLayoutEntry') state.completed.delete(key)
  }
  yield* completeCatalog(state, runtimeReferenced)
  // Complete the instance-dependent dependency walk before restoring the pre-reachability
  // decisions. Pre-seeding `completed` would suppress that walk for declaration types that are
  // also roots of concrete executable specializations.
  for (const entry of self.entries) {
    if (entry._tag === 'LayoutEntry') state.completed.set(Type.runtimeKey(entry.type), entry)
  }
  return {
    ...self,
    entries: [...state.completed.values()].sort((left, right) =>
      compareRuntimeTypes(left.type, right.type),
    ),
  }
})

/** Selects runtime-reachable entries while reusing nominal decisions from the catalog. */
export const computeRuntime = Effect.fn('Layout.computeRuntime')(function* (
  self: Catalog,
  discovery: Instances.Discovery,
  index: DeclarationIndex.Index,
  opaqueRealizations?: OpaqueRealization.Catalog,
): Effect.fn.Return<Plan> {
  const reached = yield* collectReachableTypes(discovery)
  const completed = yield* completeForInstances(self, discovery, index, reached, opaqueRealizations)
  const entries = new Map<string, Entry>()
  const state: PlanState = { catalog: completed, entries }
  yield* resolveEntries(state, reached)
  const orderedEntries = [...entries.values()].sort((left, right) =>
    compareRuntimeTypes(left.type, right.type),
  )
  const literals = yield* planLiteralVerdicts(completed.target, discovery, completed.wordConstants)
  const localSharedAllocationProvenance = yield* planLocalSharedAllocation(discovery, index)
  const localSharedDiagnostics = yield* checkLocalSharedLayouts(state, discovery)
  const shapeTypes = yield* collectShapeTypes(orderedEntries, reached)
  const staticData = yield* planStaticData(completed.target, discovery)
  const callablePlans = yield* planCallableEnvironments(completed.target, orderedEntries, discovery)
  const effectPlans = yield* planEffectEnvironments(
    completed.target,
    orderedEntries,
    discovery,
    callablePlans,
  )
  const { executionPackages, executionDiagnostics } = yield* planExecutionPackages(
    state,
    index,
    discovery,
    effectPlans,
    callablePlans,
  )
  const specializedShapeTypes = new Map(
    shapeTypes.map((type) => [Type.runtimeKey(type), type] as const),
  )
  for (const environment of effectPlans)
    specializedShapeTypes.set(Type.runtimeKey(environment.effect), environment.effect)
  const plannedShapes = yield* planCallingShapes(
    completed.target,
    orderedEntries,
    [...specializedShapeTypes.values()].sort(compareRuntimeTypes),
    effectPlans,
    callablePlans,
  )
  const base: Plan = {
    _tag: 'LayoutPlan',
    target: completed.target,
    entries: orderedEntries,
    effectEnvironments: effectPlans,
    callableEnvironments: callablePlans,
    callingShapes: plannedShapes,
    valueStorage: [],
    staticData,
    literalVerdicts: literals.verdicts,
    localSharedAllocationProvenance,
    executionPackages,
    diagnostics: Diagnostic.merge([
      ...literals.diagnostics,
      ...localSharedDiagnostics,
      ...localSharedAllocationProvenance.diagnostics,
      ...executionDiagnostics,
    ]),
  }
  return {
    ...base,
    valueStorage: yield* planValueStorage(base),
  }
})

/** Constructs a scalar plan for hand-built MIR samples and focused tests. */
export const make = Effect.fn('Layout.make')(function* (
  target: Target.Target,
  types: ReadonlyArray<Type.Builtin>,
): Effect.fn.Return<Plan> {
  const entries = new Map(types.map((type) => [Type.runtimeKey(type), scalarEntry(target, type)]))
  const orderedEntries = [...entries.values()].sort((left, right) =>
    compareRuntimeTypes(left.type, right.type),
  )
  return {
    _tag: 'LayoutPlan',
    target,
    entries: orderedEntries,
    effectEnvironments: [],
    callableEnvironments: [],
    callingShapes: yield* planCallingShapes(target, orderedEntries),
    valueStorage: [],
    staticData: [],
    literalVerdicts: [],
    localSharedAllocationProvenance: LocalSharedAllocationProvenance.empty(),
    executionPackages: ExecutionPackage.empty(),
    diagnostics: [],
  }
})

// Catalog construction

type CatalogState = ReturnType<typeof makeCatalogState>

interface AggregateFieldState {
  readonly plans: ReturnType<typeof RepresentationField.plansOf>
  ordinal: number
}

interface InlineEnvironmentLayout {
  readonly fields: ReadonlyArray<StoredEffectEnvironmentField>
  readonly copy: boolean
  readonly size: number
  readonly alignment: number
  readonly tailPadding: number
}

const makeCatalogState = (
  target: Target.Target,
  index: DeclarationIndex.Index,
  discovery?: Instances.Discovery,
  opaqueRealizations?: OpaqueRealization.Catalog,
) => {
  const declarations = index.modules
    .flatMap((module) => module.structs)
    .flatMap((struct) => {
      const type = nominalOf(struct)
      return type === undefined ? [] : [{ struct, type }]
    })
    .sort((left, right) => compareRuntimeTypes(left.type, right.type))
  const generatedDeclarations = [...index.generatedAggregates.values()]
    .flatMap((struct) => {
      const type = nominalOf(struct)
      return type === undefined ? [] : [{ struct, type }]
    })
    .sort((left, right) => compareRuntimeTypes(left.type, right.type))
  const enumDeclarations = index.modules
    .flatMap((module) => module.enums)
    .flatMap((enum_) => {
      const type = nominalOf(enum_)
      return type === undefined ? [] : [{ enum_, type }]
    })
    .sort((left, right) => compareRuntimeTypes(left.type, right.type))
  const unionDeclarations = index.modules
    .flatMap((module) => module.unions)
    .flatMap((union) => {
      const type = nominalOf(union)
      return type === undefined ? [] : [{ union, type }]
    })
    .sort((left, right) => compareRuntimeTypes(left.type, right.type))
  const byType = new Map(
    [...declarations, ...generatedDeclarations].map((declaration) => [
      `${declaration.type.module}\u0000${declaration.type.name}`,
      declaration,
    ]),
  )
  const unionByType = new Map(
    unionDeclarations.map((declaration) => [
      `${declaration.type.module}\u0000${declaration.type.name}`,
      declaration,
    ]),
  )
  const completed = new Map<string, CatalogEntry>()
  for (const declaration of enumDeclarations) {
    const entry = scalarEnumEntry(target, declaration.enum_)
    let cause: Diagnostic.CauseIdentity | undefined
    if (declaration.enum_.validity._tag === 'Invalid') {
      cause = declaration.enum_.validity.causes.at(0)
    } else if (declaration.enum_.representation._tag === 'Unavailable') {
      cause = declaration.enum_.representation.cause
    }
    completed.set(
      Type.runtimeKey(declaration.type),
      entry ??
        unavailable(
          declaration.type,
          [],
          {
            _tag: 'InvalidDeclaration',
            detail: `scalar enum ${Type.encode(declaration.type)} has no valid fixed-width representation plan`,
          },
          cause,
        ),
    )
  }
  const visiting = new Set<string>()
  const callableRealizations =
    discovery === undefined
      ? undefined
      : InstanceDiagnostics.callableFieldRealizations(discovery, index)
  return {
    target,
    index,
    discovery,
    opaqueRealizations,
    declarations,
    unionDeclarations,
    byType,
    unionByType,
    completed,
    visiting,
    callableRealizations,
  }
}

const collectDeclaredTypes = Effect.fn('Layout.collectDeclaredTypes')(function* (
  index: DeclarationIndex.Index,
  referenced: Map<string, Type.Type>,
): Effect.fn.Return<void> {
  for (const module of index.modules) {
    for (const member of module.members) {
      if (member._tag === 'FunctionDeclaration') {
        for (const parameter of member.parameters) {
          if (parameter.declaredType._tag === 'Resolved')
            yield* addReferenced(referenced, parameter.declaredType.type)
        }
        if (member.returnType._tag === 'Resolved')
          yield* addReferenced(referenced, member.returnType.type)
      } else if (member._tag === 'StructDeclaration') {
        for (const field of member.fields) {
          if (field.declaredType._tag === 'Resolved')
            yield* addReferenced(referenced, field.declaredType.type)
        }
      } else if (member._tag === 'UnionDeclaration') {
        for (const variant of member.variants) {
          for (const field of variant.fields) {
            if (field.declaredType._tag === 'Resolved')
              yield* addReferenced(referenced, field.declaredType.type)
          }
        }
      } else if (member._tag === 'ServiceDeclaration' || member._tag === 'InterfaceDeclaration') {
        for (const operation of member.operations) {
          for (const parameter of operation.parameters)
            if (parameter.declaredType._tag === 'Resolved')
              yield* addReferenced(referenced, parameter.declaredType.type)
          if (operation.returnType._tag === 'Resolved')
            yield* addReferenced(referenced, operation.returnType.type)
        }
      } else if (
        (member._tag === 'ConstantDeclaration' ||
          member._tag === 'PackageParameterDeclaration' ||
          member._tag === 'ForeignStaticDeclaration') &&
        member.declaredType._tag === 'Resolved'
      ) {
        yield* addReferenced(referenced, member.declaredType.type)
      }
    }
  }
})

const collectInstanceTypes = Effect.fn('Layout.collectInstanceTypes')(function* (
  discovery: Instances.Discovery | undefined,
  referenced: Map<string, Type.Type>,
): Effect.fn.Return<void> {
  for (const instance of discovery?.instances ?? []) {
    if (needsInitializationFlags(instance)) yield* addReferenced(referenced, 'bool')
    for (const represented of representedParameterTypes(instance))
      yield* addReferenced(referenced, represented)
    const substitution = instance.substitution
    if (instance.function.contract._tag === 'Contract') {
      for (const parameter of instance.specialization.parameters)
        yield* addReferenced(referenced, parameter)
      yield* addReferenced(referenced, instance.specialization.result)
      for (const failure of RowAlgebra.concreteMembers(
        Type.failureRowPolicy(),
        instance.specialization.failureRow ?? RowAlgebra.concrete(Type.failureRowPolicy(), []),
      ))
        yield* addReferenced(referenced, failure)
      for (const requirement of RowAlgebra.concreteMembers(
        Type.requirementRowPolicy(),
        instance.specialization.requirementRow ??
          RowAlgebra.concrete(Type.requirementRowPolicy(), []),
      ))
        yield* addReferenced(referenced, requirement.capability)
    }
    for (const statement of instance.function.statements) {
      for (const expression of Tir.statementExpressions(statement))
        yield* addSpecializedExpression(referenced, substitution, expression)
      yield* addPatternStatementTypes(referenced, substitution, statement)
    }
  }
  for (const effect of discovery?.effects ?? []) yield* addReferenced(referenced, effect.type)
})

const completeCatalog = Effect.fn('Layout.completeCatalog')(function* (
  state: CatalogState,
  referenced: Map<string, Type.Type>,
): Effect.fn.Return<void> {
  const { completed } = state
  let completedSize = -1
  let referencedSize = -1
  while (completedSize !== completed.size || referencedSize !== referenced.size) {
    completedSize = completed.size
    referencedSize = referenced.size
    for (const entry of completed.values()) yield* addReferenced(referenced, entry.type)
    for (const type of referenced.values()) {
      if (!Type.isBuiltin(type)) yield* layoutType(state, type)
    }
  }
})

const layoutType = Effect.fnUntraced(function* (
  state: CatalogState,
  type: DeclarationFacts.SemanticType,
): Effect.fn.Return<CatalogEntry> {
  const { target, completed } = state
  if (Type.isBuiltin(type)) return scalarEntry(target, type)
  if (Type.isString(type)) {
    const result = stringEntry(target, type)
    completed.set(Type.runtimeKey(type), result)
    return result
  }
  if (Type.isNever(type)) {
    const result = neverEntry()
    completed.set(Type.runtimeKey(type), result)
    return result
  }
  if (Type.isParameter(type)) {
    return unavailable(type, [], {
      _tag: 'InvalidDeclaration',
      detail: `open generic parameter ${Type.encode(type)} has no target layout`,
    })
  }
  if (Type.isNominal(type)) return yield* layoutNominal(state, type)
  if (Type.isSlice(type)) {
    const key = Type.runtimeKey(type)
    const existing = completed.get(key)
    if (existing !== undefined) return existing
    const element = yield* layoutType(state, type.element)
    if (element._tag === 'UnavailableLayoutEntry') {
      const result = unavailable(
        type,
        Type.nominals(type.element),
        { _tag: 'UnavailableDependency', dependency: type.element },
        element.cause,
      )
      completed.set(key, result)
      return result
    }
    const result = sliceEntry(target, type, element)
    completed.set(key, result)
    return result
  }
  if (Type.isReference(type)) {
    const result = referenceEntry(target, type)
    completed.set(Type.runtimeKey(type), result)
    return result
  }
  if (Type.isPointer(type)) {
    const result = pointerEntry(target, type)
    completed.set(Type.runtimeKey(type), result)
    return result
  }
  if (Type.isForeignFunction(type)) {
    const result = foreignFunctionEntry(target, type)
    completed.set(Type.runtimeKey(type), result)
    return result
  }
  const key = Type.runtimeKey(type)
  const existing = completed.get(key)
  if (existing !== undefined) return existing
  if (Type.isUnion(type)) {
    const members: Array<Entry> = []
    for (const member of type.members) {
      const memberLayout = yield* layoutType(state, member)
      if (memberLayout._tag === 'UnavailableLayoutEntry') {
        const result = unavailable(
          type,
          type.members.flatMap(Type.nominals),
          { _tag: 'UnavailableDependency', dependency: member },
          memberLayout.cause,
        )
        completed.set(key, result)
        return result
      }
      members.push(memberLayout)
    }
    const result = unionEntry(type, members)
    completed.set(key, result)
    return result
  }
  if (Type.isEffect(type)) {
    const result = unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'compiler-private effect values have no target layout',
    })
    completed.set(key, result)
    return result
  }
  if (Type.isCallable(type)) {
    const result = unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'callable environment layout is planned from its hidden concrete identity',
    })
    completed.set(key, result)
    return result
  }
  if (Type.isRepresented(type)) {
    return yield* layoutDirectRepresented(state, type)
  }
  const element = yield* layoutType(state, type.element)
  const dependencies = Type.nominals(type.element)
  if (element._tag === 'UnavailableLayoutEntry') {
    const result = unavailable(
      type,
      dependencies,
      { _tag: 'UnavailableDependency', dependency: type.element },
      element.cause,
    )
    completed.set(key, result)
    return result
  }
  const entry = repeatedEntry(type, element)
  if (entry === undefined) {
    const result = unavailable(type, dependencies, {
      _tag: 'InvalidDeclaration',
      detail: `array layout overflows for ${Type.encode(type)}`,
    })
    completed.set(key, result)
    return result
  }
  completed.set(key, entry)
  return entry
})

const layoutNominal = Effect.fn('Layout.layoutNominal')(function* (
  state: CatalogState,
  type: Type.Nominal,
): Effect.fn.Return<CatalogEntry> {
  const { target, index, completed, visiting, byType, unionByType } = state
  const key = Type.runtimeKey(type)
  const existing = completed.get(key)
  if (existing !== undefined) return existing
  if (Type.isSharedCore(type) || Type.isExecution(type) || Type.isExecutionRef(type)) {
    const result: Entry = {
      _tag: 'LayoutEntry',
      type,
      copy: false,
      size: target.pointerSize,
      alignment: target.pointerAlignment,
      representation: {
        _tag: 'Reference',
        target: type,
        address: {
          bits: target.pointerSize === 4 ? 32 : 64,
          offset: 0,
          size: target.pointerSize,
          alignment: target.pointerAlignment,
        },
      },
    }
    completed.set(key, result)
    return result
  }
  if (Type.isIntrinsicNominal(type) || Type.equals(type, Type.unit)) {
    return yield* layoutIntrinsicNominal(state, type)
  }
  const unionDeclaration = unionByType.get(`${type.module}\u0000${type.name}`)
  if (unionDeclaration !== undefined) {
    return yield* layoutNominalUnion(state, type, unionDeclaration)
  }
  const declaration = byType.get(`${type.module}\u0000${type.name}`)
  if (declaration === undefined) {
    return unavailable(type, [], {
      _tag: 'InvalidDeclaration',
      detail: `missing canonical declaration for ${Type.encode(type)}`,
    })
  }
  const parameters = declaration.struct.typeParameters.map((parameter) => parameter.type)
  const substitution = TypeInference.substitution(parameters, type.arguments)
  if (substitution === undefined) {
    return unavailable(type, [], {
      _tag: 'InvalidDeclaration',
      detail: `${Type.encode(type)} has ${type.arguments.length} type arguments; expected ${parameters.length}`,
    })
  }
  const dependencies = dependenciesOf(declaration.struct, substitution)
  if (visiting.has(key)) {
    const result = unavailable(type, dependencies, {
      _tag: 'InvalidDeclaration',
      detail: `recursive dependency for ${Type.encode(type)} was not rejected during declaration analysis`,
    })
    completed.set(key, result)
    return result
  }
  if (declaration.struct.dependency._tag === 'Unavailable') {
    const result = unavailable(
      type,
      dependencies,
      { _tag: 'InvalidDeclaration', detail: `declaration dependencies are unavailable` },
      declaration.struct.dependency.cause,
    )
    completed.set(key, result)
    return result
  }
  visiting.add(key)
  const inputs: Array<Packing.Input<Omit<Field, keyof Packing.PlacedField>>> = []
  let fieldsCopy = true
  let failure: UnavailableEntry | undefined
  for (const field of declaration.struct.fields) {
    if (
      field.state._tag !== 'Unique' ||
      (field.name._tag !== 'Present' && field.member._tag !== 'OrdinalAggregateMember')
    ) {
      failure = unavailable(
        type,
        dependencies,
        {
          _tag: 'UnavailableField',
          field: field.id,
          detail: 'field identity is unavailable',
        },
        field.state._tag === 'Duplicate' ? field.state.cause : undefined,
      )
      break
    }
    if (field.declaredType._tag !== 'Resolved' || field.declaredType.exposureCause !== undefined) {
      let cause: Diagnostic.CauseIdentity | undefined
      if (field.declaredType._tag === 'Unresolved') cause = field.declaredType.cause
      else if (field.declaredType._tag === 'Resolved') cause = field.declaredType.exposureCause
      failure = unavailable(
        type,
        dependencies,
        {
          _tag: 'UnavailableField',
          field: field.id,
          detail: 'field type is unavailable',
        },
        cause,
      )
      break
    }
    const fieldType = Type.substitute(field.declaredType.type, substitution)
    const fieldLayout = yield* layoutAggregateField(state, type, fieldType, field.id)
    if (fieldLayout._tag === 'UnavailableLayoutEntry') {
      failure = unavailable(
        type,
        dependencies,
        { _tag: 'UnavailableDependency', dependency: fieldType },
        fieldLayout.cause,
      )
      break
    }
    fieldsCopy = fieldsCopy && fieldLayout.copy
    let fieldName = ''
    if (field.name._tag === 'Present') fieldName = field.name.spelling
    else if (field.member._tag === 'OrdinalAggregateMember') fieldName = `${field.member.ordinal}`
    inputs.push({
      value: {
        _tag: 'LayoutField' as const,
        id: field.id,
        name: fieldName,
        type: fieldType,
      },
      size: fieldLayout.size,
      alignment: fieldLayout.alignment,
    })
  }
  visiting.delete(key)
  if (failure !== undefined) {
    completed.set(key, failure)
    return failure
  }
  const packed = Packing.pack(inputs)
  const fields = packed.fields.map(({ value, ...placement }) => ({ ...value, ...placement }))
  const cleanup = CleanupPlan.cleanupPlan(index, type)
  const entry: Entry = {
    _tag: 'LayoutEntry',
    type,
    copy:
      ConformanceProof.hasCopyDeclaration(index, type) &&
      fieldsCopy &&
      cleanup._tag !== 'HookCleanup',
    size: packed.size,
    alignment: packed.alignment,
    representation: {
      _tag: 'Aggregate',
      fields: fields,
      tailPadding: packed.tailPadding,
      ...(cleanup._tag === 'HookCleanup'
        ? {
            cleanupHook: {
              hook: cleanup.hook,
              typeArguments: cleanup.typeArguments,
            },
          }
        : {}),
    },
  }
  completed.set(key, entry)
  return entry
})

const layoutIntrinsicNominal = Effect.fn('Layout.layoutIntrinsicNominal')(function* (
  state: CatalogState,
  type: Type.Nominal,
): Effect.fn.Return<CatalogEntry> {
  const { target, completed } = state
  const key = Type.runtimeKey(type)
  const ordinal = Type.equals(type, Type.unit)
    ? Type.intrinsicNominals.size
    : Type.intrinsicNominalOrdinal(type)
  const structId: DeclarationFacts.DeclarationId = {
    _tag: 'DeclarationId',
    sourceId: type.module,
    ordinal,
  }
  let fieldTypes: ReadonlyArray<readonly [string, Type.Type]> = []
  if (Type.equals(type, Type.layout)) {
    fieldTypes = [['bytes', 'usize'] as const, ['alignment', 'usize'] as const]
  } else if (Type.equals(type, Type.invalidAlignment)) {
    fieldTypes = [['alignment', 'usize'] as const]
  } else if (Type.equals(type, Type.allocation)) {
    fieldTypes = [
      ['$base', 'usize'] as const,
      ['$bytes', 'usize'] as const,
      ['$alignment', 'usize'] as const,
      ['$reclaim', 'usize'] as const,
      ['$context', 'usize'] as const,
      ['$active', 'usize'] as const,
    ]
  } else if (Type.isRawBuffer(type)) {
    fieldTypes = [['$allocation', Type.allocation] as const, ['count', 'usize'] as const]
  } else if (Type.isSlot(type)) {
    fieldTypes = [['$address', 'usize'] as const]
  }
  const inputs: Array<Packing.Input<Omit<Field, keyof Packing.PlacedField>>> = []
  for (const [fieldOrdinal, [name, fieldType]] of fieldTypes.entries()) {
    let fieldLayout: CatalogEntry | undefined
    if (Type.isBuiltin(fieldType)) {
      fieldLayout = scalarEntry(target, fieldType)
    } else if (Type.isNominal(fieldType)) {
      fieldLayout = yield* layoutNominal(state, fieldType)
    }
    if (fieldLayout === undefined || fieldLayout._tag === 'UnavailableLayoutEntry') {
      const result = unavailable(
        type,
        Type.nominals(fieldType),
        { _tag: 'UnavailableDependency', dependency: fieldType },
        fieldLayout?.cause,
      )
      completed.set(key, result)
      return result
    }
    inputs.push({
      value: {
        _tag: 'LayoutField' as const,
        id: {
          _tag: 'FieldId' as const,
          owner: {
            _tag: 'StructFieldOwnerId' as const,
            declaration: structId,
          },
          ordinal: fieldOrdinal,
        },
        name,
        type: fieldType,
      },
      size: fieldLayout.size,
      alignment: fieldLayout.alignment,
    })
  }
  const packed = Packing.pack(inputs)
  const fields = packed.fields.map(({ value, ...placement }) => ({ ...value, ...placement }))
  const entry: Entry = {
    _tag: 'LayoutEntry',
    type,
    copy: Type.equals(type, Type.unit),
    size: packed.size,
    alignment: packed.alignment,
    representation: {
      _tag: 'Aggregate',
      fields: fields,
      tailPadding: packed.tailPadding,
    },
  }
  completed.set(key, entry)
  return entry
})

const layoutNominalUnion = Effect.fn('Layout.layoutNominalUnion')(function* (
  state: CatalogState,
  type: Type.Nominal,
  unionDeclaration: NonNullable<ReturnType<CatalogState['unionByType']['get']>>,
): Effect.fn.Return<CatalogEntry> {
  const { index, visiting, completed } = state
  const key = Type.runtimeKey(type)
  const union = unionDeclaration.union
  if (union.canonical._tag !== 'Canonical') {
    const result = unavailable(type, [], {
      _tag: 'InvalidDeclaration',
      detail: `canonical identity is unavailable for ${Type.encode(type)}`,
    })
    completed.set(key, result)
    return result
  }
  const parameters = union.typeParameters.map((parameter) => parameter.type)
  const substitution = TypeInference.substitution(parameters, type.arguments)
  const dependencies = substitution === undefined ? [] : dependenciesOf(union, substitution)
  if (substitution === undefined) {
    return unavailable(type, dependencies, {
      _tag: 'InvalidDeclaration',
      detail: `${Type.encode(type)} has ${type.arguments.length} type arguments; expected ${parameters.length}`,
    })
  }
  if (visiting.has(key)) {
    const result = unavailable(type, dependencies, {
      _tag: 'InvalidDeclaration',
      detail: `recursive dependency for ${Type.encode(type)} was not rejected during declaration analysis`,
    })
    completed.set(key, result)
    return result
  }
  if (union.validity._tag !== 'Valid' || union.dependency._tag === 'Unavailable') {
    let cause: Diagnostic.CauseIdentity | undefined
    if (union.validity._tag === 'Invalid') cause = union.validity.causes.at(0)
    else if (union.dependency._tag === 'Unavailable') cause = union.dependency.cause
    const result = unavailable(
      type,
      dependencies,
      { _tag: 'InvalidDeclaration', detail: `declaration dependencies are unavailable` },
      cause,
    )
    completed.set(key, result)
    return result
  }
  visiting.add(key)
  let fieldsCopy = true
  let failure: UnavailableEntry | undefined
  const variants: Array<
    Extract<
      Representation,
      {
        readonly _tag: 'NominalUnion'
      }
    >['variants'][number]
  > = []
  for (const variant of union.variants) {
    if (variant.canonical._tag !== 'Canonical') {
      failure = unavailable(type, dependencies, {
        _tag: 'InvalidDeclaration',
        detail: `variant identity is unavailable for ${Type.encode(type)}`,
      })
      break
    }
    const inputs: Array<Packing.Input<Omit<Field, keyof Packing.PlacedField>>> = []
    for (const field of variant.fields) {
      if (
        field.state._tag !== 'Unique' ||
        field.name._tag !== 'Present' ||
        field.declaredType._tag !== 'Resolved' ||
        field.declaredType.exposureCause !== undefined
      ) {
        let cause: Diagnostic.CauseIdentity | undefined
        if (field.state._tag === 'Duplicate') cause = field.state.cause
        else if (field.declaredType._tag === 'Unresolved') {
          cause = field.declaredType.cause
        } else if (field.declaredType._tag === 'Resolved') {
          cause = field.declaredType.exposureCause
        }
        failure = unavailable(
          type,
          dependencies,
          { _tag: 'UnavailableField', field: field.id, detail: 'field is unavailable' },
          cause,
        )
        break
      }
      const fieldType = Type.substitute(field.declaredType.type, substitution)
      const fieldLayout = yield* layoutAggregateField(state, type, fieldType, field.id)
      if (fieldLayout._tag === 'UnavailableLayoutEntry') {
        failure = unavailable(
          type,
          dependencies,
          { _tag: 'UnavailableDependency', dependency: fieldType },
          fieldLayout.cause,
        )
        break
      }
      fieldsCopy = fieldsCopy && fieldLayout.copy
      inputs.push({
        value: {
          _tag: 'LayoutField' as const,
          id: field.id,
          name: field.name.spelling,
          type: fieldType,
        },
        size: fieldLayout.size,
        alignment: fieldLayout.alignment,
      })
    }
    if (failure !== undefined) break
    const packed = Packing.pack(inputs)
    variants.push({
      variant: variant.canonical.id,
      ordinal: variant.id.ordinal,
      fields: packed.fields.map(({ value, ...placement }) => ({ ...value, ...placement })),
      size: packed.size,
      alignment: packed.alignment,
      tailPadding: packed.tailPadding,
    })
  }
  visiting.delete(key)
  if (failure !== undefined) {
    completed.set(key, failure)
    return failure
  }
  const payloadAlignment = variants.reduce(
    (maximum, variant) => Math.max(maximum, variant.alignment),
    1,
  )
  const payloadSize = variants.reduce((maximum, variant) => Math.max(maximum, variant.size), 0)
  const payloadOffset = alignUp(4, payloadAlignment)
  const alignment = Math.max(4, payloadAlignment)
  const size = alignUp(payloadOffset + payloadSize, alignment)
  const cleanup = CleanupPlan.cleanupPlan(index, type)
  const entry: Entry = {
    _tag: 'LayoutEntry',
    type,
    copy:
      ConformanceProof.hasCopyDeclaration(index, type) &&
      fieldsCopy &&
      cleanup._tag !== 'HookCleanup',
    size,
    alignment,
    representation: {
      _tag: 'NominalUnion',
      union: union.canonical.id,
      tag: { bits: 32, size: 4 },
      variants: variants,
      payloadOffset,
      payloadSize,
      payloadAlignment,
      tagPadding: payloadOffset - 4,
      tailPadding: size - (payloadOffset + payloadSize),
      ...(cleanup._tag === 'HookCleanup'
        ? {
            cleanupHook: {
              hook: cleanup.hook,
              typeArguments: cleanup.typeArguments,
            },
          }
        : {}),
    },
  }
  completed.set(key, entry)
  return entry
})

const layoutAggregateField = Effect.fnUntraced(function* (
  state: CatalogState,
  type: Type.Nominal,
  fieldType: DeclarationFacts.SemanticType,
  fieldId: DeclarationFacts.FieldId,
): Effect.fn.Return<CatalogEntry> {
  const { index } = state
  const representationPlans = RepresentationField.plansOf(index, type).filter((plan) =>
    RepresentationField.belongsTo(plan.id, fieldId),
  )
  const fields: AggregateFieldState = { plans: representationPlans, ordinal: 0 }
  return yield* visitAggregateField(state, type, fields, fieldType)
})

const visitAggregateField = Effect.fnUntraced(function* (
  state: CatalogState,
  owner: Type.Nominal,
  fields: AggregateFieldState,
  candidate: DeclarationFacts.SemanticType,
): Effect.fn.Return<CatalogEntry> {
  const { target, callableRealizations } = state
  const type = owner
  const representationPlans = fields.plans
  if (Type.isRepresented(candidate)) {
    const plan = representationPlans.at(fields.ordinal)
    fields.ordinal += 1
    const realization =
      plan === undefined || callableRealizations === undefined
        ? undefined
        : FieldRealization.realizationOf(callableRealizations, type, plan.id)
    if (realization === undefined) {
      return unavailable(candidate, Type.nominals(candidate), {
        _tag: 'InvalidDeclaration',
        detail: 'represented executable values remain unavailable to layout',
      })
    }
    return FieldRealization.isCallableRealization(realization)
      ? yield* layoutRepresentedCallable(state, candidate, realization)
      : yield* layoutRepresentedEffect(state, candidate, realization)
  }
  if (Type.isFixedArray(candidate)) {
    const element = yield* visitAggregateField(state, owner, fields, candidate.element)
    if (element._tag === 'UnavailableLayoutEntry') return element
    return (
      repeatedEntry(candidate, element) ??
      unavailable(candidate, Type.nominals(candidate.element), {
        _tag: 'InvalidDeclaration',
        detail: `array layout overflows for ${Type.encode(candidate)}`,
      })
    )
  }
  if (Type.isSlice(candidate)) {
    const element = yield* visitAggregateField(state, owner, fields, candidate.element)
    return element._tag === 'UnavailableLayoutEntry'
      ? element
      : sliceEntry(target, candidate, element)
  }
  return yield* layoutType(state, candidate)
})

const layoutDirectRepresented = Effect.fn('Layout.layoutDirectRepresented')(function* (
  state: CatalogState,
  type: Type.Represented,
  active: ReadonlySet<string> = new Set<string>(),
): Effect.fn.Return<CatalogEntry> {
  const { completed } = state
  const typeKey = Type.runtimeKey(type)
  const existing = completed.get(typeKey)
  if (existing?._tag === 'LayoutEntry') return existing
  if (active.has(typeKey))
    return unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'recursive executable union representation has no finite inline layout',
    })
  const next = new Set(active).add(typeKey)
  const argument = type.representation.argument
  if (Type.isOpaqueRepresentationArgument(argument))
    return yield* layoutOpaqueRepresentation(state, type, argument, next)
  if (Type.isCompositeEffectRepresentationArgument(argument))
    return yield* layoutCompositeRepresentation(state, type, argument, next)
  if (!Type.isExactRepresentationArgument(argument))
    return unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'open executable union member has no finite realization',
    })
  if (Type.isCallable(type.contract) && Type.isCallableIdentityArgument(argument.identity))
    return yield* layoutCallableRepresentation(state, type, argument.identity)
  if (Type.isEffect(type.contract) && Type.isEffectIdentityArgument(argument.identity))
    return yield* layoutEffectRepresentation(state, type, argument.identity)
  return unavailable(type, Type.nominals(type), {
    _tag: 'InvalidDeclaration',
    detail: 'executable union member representation does not match its contract',
  })
})

const layoutOpaqueRepresentation = Effect.fn('Layout.layoutOpaqueRepresentation')(function* (
  state: CatalogState,
  type: Type.Represented,
  argument: Type.OpaqueRepresentationArgument,
  next: ReadonlySet<string>,
): Effect.fn.Return<CatalogEntry> {
  const { opaqueRealizations, completed } = state
  const typeKey = Type.runtimeKey(type)

  const definition =
    opaqueRealizations === undefined
      ? undefined
      : OpaqueRealization.definitionOf(opaqueRealizations, argument)
  const realization = definition?.realization
  if (realization === undefined)
    return unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'opaque executable union member has no finite realization',
    })
  const realized = yield* layoutDirectRepresented(
    state,
    Type.represented(type.contract, type.representation.requiredBound, realization),
    next,
  )
  if (realized._tag === 'UnavailableLayoutEntry') return realized
  const result: Entry = { ...realized, type }
  completed.set(typeKey, result)
  return result
})

const layoutCompositeRepresentation = Effect.fn('Layout.layoutCompositeRepresentation')(function* (
  state: CatalogState,
  type: Type.Represented,
  argument: Type.CompositeEffectRepresentationArgument,
  next: ReadonlySet<string>,
): Effect.fn.Return<CatalogEntry> {
  const { completed } = state
  const typeKey = Type.runtimeKey(type)

  const alternatives = yield* Effect.forEach(
    argument.alternatives,
    Effect.fnUntraced(function* (alternative) {
      return yield* layoutDirectRepresented(
        state,
        Type.represented(type.contract, type.representation.requiredBound, alternative),
        next,
      )
    }),
  )
  const unavailableAlternative = alternatives.find(
    (alternative): alternative is UnavailableEntry => alternative._tag === 'UnavailableLayoutEntry',
  )
  if (unavailableAlternative !== undefined) return unavailableAlternative
  const entries = alternatives.flatMap((alternative) =>
    alternative._tag === 'LayoutEntry' ? [alternative] : [],
  )
  const payloadAlignment = entries.reduce(
    (maximum, alternative) => Math.max(maximum, alternative.alignment),
    1,
  )
  const payloadSize = entries.reduce(
    (maximum, alternative) => Math.max(maximum, alternative.size),
    0,
  )
  const payloadOffset = alignUp(4, payloadAlignment)
  const alignment = Math.max(4, payloadAlignment)
  const size = alignUp(payloadOffset + payloadSize, alignment)
  const result: Entry = {
    _tag: 'LayoutEntry',
    type,
    copy: entries.every((entry) => entry.copy),
    size,
    alignment,
    representation: {
      _tag: 'Aggregate',
      fields: [],
      tailPadding: size,
    },
  }
  completed.set(typeKey, result)
  return result
})

const layoutCallableRepresentation = Effect.fn('Layout.layoutCallableRepresentation')(function* (
  state: CatalogState,
  type: Type.Represented,
  identity: Type.CallableIdentityArgument,
): Effect.fn.Return<CatalogEntry> {
  const { target, discovery, completed } = state
  const typeKey = Type.runtimeKey(type)

  const callable =
    identity.environment === undefined
      ? undefined
      : discovery?.callables.find((candidate) =>
          FieldRealization.matchesIdentity(identity, candidate),
        )
  if (identity.environment !== undefined && callable === undefined)
    return unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'callable union member has no finite environment',
    })
  let copy = true
  const fieldInputs = (yield* Effect.forEach(
    callable?.captures ?? [],
    Effect.fnUntraced(function* (capture) {
      const borrowed = borrowedCapture(capture.access, capture.type)
      const valueLayout = borrowed ? undefined : yield* layoutType(state, capture.type)
      if (valueLayout?._tag === 'UnavailableLayoutEntry') return []
      const fieldSize = borrowed ? target.pointerSize : (valueLayout?.size ?? 0)
      const fieldAlignment = borrowed ? target.pointerAlignment : (valueLayout?.alignment ?? 1)
      copy =
        copy &&
        capture.access !== 'Exclusive' &&
        (capture.access === 'Copy' || capture.access === 'Shared' || valueLayout?.copy === true)
      return [
        {
          value: {
            capture: capture.ordinal,
            type: capture.type,
            access: capture.access,
            representation: borrowed ? ('Borrow' as const) : ('Value' as const),
          },
          size: fieldSize,
          alignment: fieldAlignment,
        },
      ]
    }),
  )).flat()
  if ((callable?.captures.length ?? 0) !== fieldInputs.length)
    return unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'callable union member captures a value without finite layout',
    })
  const packed = Packing.pack(fieldInputs)
  const fields = packed.fields.map(({ value, offset, size, alignment, padding }) => ({
    ...value,
    offset,
    size,
    alignment,
    padding,
  }))
  const result: Entry = {
    _tag: 'LayoutEntry',
    type,
    copy,
    size: packed.size,
    alignment: packed.alignment,
    representation: {
      _tag: 'Aggregate',
      fields: [],
      tailPadding: packed.size,
    },
    executable: {
      _tag: 'Callable',
      fields: fields,
    },
  }
  completed.set(typeKey, result)
  return result
})

const layoutEffectRepresentation = Effect.fn('Layout.layoutEffectRepresentation')(function* (
  state: CatalogState,
  type: Type.Represented,
  identity: Type.EffectIdentityArgument,
): Effect.fn.Return<CatalogEntry> {
  const { discovery, completed } = state
  const typeKey = Type.runtimeKey(type)

  const effect =
    discovery === undefined ? undefined : Instances.representedEffectOf(discovery, identity)
  const environment =
    effect === undefined
      ? undefined
      : yield* layoutEffectSlots(
          state,
          FieldRealization.effectEnvironmentOf(effect),
          new Set([effect.identity]),
        )
  if (environment === undefined)
    return unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'Effect union member has no finite environment',
    })
  const result: Entry = {
    _tag: 'LayoutEntry',
    type,
    copy: environment.copy,
    size: environment.size,
    alignment: environment.alignment,
    representation: {
      _tag: 'Aggregate',
      fields: [],
      tailPadding: environment.size,
    },
    executable: {
      _tag: 'Effect',
      fields: environment.fields.map((field) => ({
        capture: field.capture,
        type: field.type,
        access: field.access,
        representation: field.representation,
        offset: field.offset,
        size: field.size,
        alignment: field.alignment,
        padding: field.padding,
        ...(field.effectIdentity === undefined ? {} : { effectIdentity: field.effectIdentity }),
        ...(field.callableIdentity === undefined
          ? {}
          : { callableIdentity: field.callableIdentity }),
      })),
    },
  }
  completed.set(typeKey, result)
  return result
})

const layoutEffectSlots = Effect.fnUntraced(function* (
  state: CatalogState,
  slots: ReadonlyArray<FieldRealization.EffectEnvironmentSlot>,
  active: ReadonlySet<string>,
): Effect.fn.Return<InlineEnvironmentLayout | undefined> {
  const { target, discovery } = state
  let copy = true
  const fieldInputs: Array<
    Packing.Input<Omit<StoredEffectEnvironmentField, keyof Packing.PlacedField>>
  > = []
  for (const slot of slots) {
    const nestedEffect =
      slot.effectIdentity === undefined || discovery === undefined
        ? undefined
        : effectInstanceByIdentity(discovery, slot.effectIdentity)
    const callableIdentity = slot.callableIdentity
    const nestedCallable =
      callableIdentity === undefined
        ? undefined
        : discovery?.callables.find((candidate) =>
            FieldRealization.matchesIdentity(callableIdentity, candidate),
          )
    const borrowed =
      borrowedCapture(slot.access, slot.type) &&
      nestedEffect === undefined &&
      nestedCallable === undefined
    let nestedLayout:
      | {
          readonly size: number
          readonly alignment: number
          readonly copy: boolean
        }
      | undefined
    if (nestedEffect !== undefined) {
      if (active.has(nestedEffect.identity)) return undefined
      nestedLayout = yield* layoutEffectSlots(
        state,
        FieldRealization.effectEnvironmentOf(nestedEffect),
        new Set([...active, nestedEffect.identity]),
      )
    } else if (nestedCallable !== undefined) {
      let callableCopy = true
      const captureInputs: Array<Packing.Input<undefined>> = []
      for (const capture of nestedCallable.captures) {
        const captureBorrowed = borrowedCapture(capture.access, capture.type)
        const captureLayout = captureBorrowed ? undefined : yield* layoutType(state, capture.type)
        if (captureLayout?._tag === 'UnavailableLayoutEntry') return undefined
        const size = captureBorrowed ? target.pointerSize : (captureLayout?.size ?? 0)
        const alignment = captureBorrowed
          ? target.pointerAlignment
          : (captureLayout?.alignment ?? 1)
        captureInputs.push({ value: undefined, size, alignment })
        callableCopy =
          callableCopy &&
          capture.access !== 'Exclusive' &&
          (capture.access === 'Copy' || capture.access === 'Shared' || captureLayout?.copy === true)
      }
      const packed = Packing.pack(captureInputs)
      nestedLayout = {
        size: packed.size,
        alignment: packed.alignment,
        copy: callableCopy,
      }
    } else if (!borrowed) {
      const candidate = yield* layoutType(state, slot.type)
      if (candidate._tag === 'UnavailableLayoutEntry') return undefined
      nestedLayout = candidate
    }
    const size = borrowed ? target.pointerSize : (nestedLayout?.size ?? 0)
    const alignment = borrowed ? target.pointerAlignment : (nestedLayout?.alignment ?? 1)
    copy =
      copy &&
      slot.access !== 'Exclusive' &&
      (slot.access === 'Copy' ||
        (slot.access === 'Shared' && borrowed) ||
        nestedLayout?.copy === true)
    let representation: 'Borrow' | 'Callable' | 'Value' = 'Value'
    if (borrowed) representation = 'Borrow'
    else if (nestedCallable !== undefined) representation = 'Callable'
    fieldInputs.push({
      value: {
        capture: slot.ordinal,
        source: slot.source,
        ordinal: slot.sourceOrdinal,
        access: slot.access,
        type: nestedEffect?.type ?? slot.type,
        representation,
        ...(slot.effectIdentity === undefined ? {} : { effectIdentity: slot.effectIdentity }),
        ...(slot.callableIdentity === undefined ? {} : { callableIdentity: slot.callableIdentity }),
        ...(slot.providedRequirement === undefined
          ? {}
          : { providedRequirement: slot.providedRequirement }),
      },
      size,
      alignment,
    })
  }
  const packed = Packing.pack(fieldInputs)
  return {
    fields: packed.fields.map(({ value, offset, size, alignment, padding }) => ({
      ...value,
      offset,
      size,
      alignment,
      padding,
    })),
    copy,
    size: packed.size,
    alignment: packed.alignment,
    tailPadding: packed.tailPadding,
  }
})

const layoutRepresentedCallable = Effect.fn('Layout.layoutRepresentedCallable')(function* (
  state: CatalogState,
  type: Type.Represented,
  realization: FieldRealization.CallableRealization,
): Effect.fn.Return<CatalogEntry> {
  const { target, completed } = state
  const key = Type.runtimeKey(type)
  const existing = completed.get(key)
  if (existing !== undefined) return existing
  let copy = true
  const inputs: Array<Packing.Input<Omit<CallableEnvironmentField, keyof Packing.PlacedField>>> = []
  for (const capture of realization.captures) {
    const borrowed = borrowedCapture(capture.access, capture.type)
    const valueLayout = borrowed ? undefined : yield* layoutType(state, capture.type)
    if (valueLayout?._tag === 'UnavailableLayoutEntry') {
      const result = unavailable(
        type,
        Type.nominals(capture.type),
        { _tag: 'UnavailableDependency', dependency: capture.type },
        valueLayout?.cause,
      )
      completed.set(key, result)
      return result
    }
    const size = borrowed ? target.pointerSize : (valueLayout?.size ?? 0)
    const alignment = borrowed ? target.pointerAlignment : (valueLayout?.alignment ?? 1)
    copy =
      copy &&
      capture.access !== 'Exclusive' &&
      (capture.access === 'Copy' || capture.access === 'Shared' || valueLayout?.copy === true)
    inputs.push({
      value: {
        ordinal: capture.ordinal,
        parameterOrdinal: capture.parameterOrdinal,
        access: capture.access,
        type: capture.type,
        representation: borrowed ? ('Borrow' as const) : ('Value' as const),
      },
      size,
      alignment,
    })
  }
  const packed = Packing.pack(inputs)
  const fields = packed.fields.map(({ value, ...placement }) => ({ ...value, ...placement }))
  const result: Entry = {
    _tag: 'LayoutEntry',
    type,
    copy,
    size: packed.size,
    alignment: packed.alignment,
    representation: {
      _tag: 'CallableEnvironment',
      realization,
      fields: fields,
      tailPadding: packed.tailPadding,
    },
  }
  completed.set(key, result)
  return result
})

const layoutRepresentedEffect = Effect.fn('Layout.layoutRepresentedEffect')(function* (
  state: CatalogState,
  type: Type.Represented,
  realization: FieldRealization.EffectRealization,
): Effect.fn.Return<CatalogEntry> {
  const { completed } = state
  const key = Type.runtimeKey(type)
  const existing = completed.get(key)
  if (existing !== undefined) return existing
  const environment = yield* layoutEffectSlots(
    state,
    realization.environment,
    new Set([realization.runnerIdentity]),
  )
  if (environment === undefined) {
    const result = unavailable(type, Type.nominals(type), {
      _tag: 'InvalidDeclaration',
      detail: 'stored Effect environment has an unavailable or recursive capture layout',
    })
    completed.set(key, result)
    return result
  }
  const result: Entry = {
    _tag: 'LayoutEntry',
    type,
    copy: environment.copy,
    size: environment.size,
    alignment: environment.alignment,
    representation: {
      _tag: 'StoredEffectEnvironment',
      realization,
      fields: environment.fields,
      tailPadding: environment.tailPadding,
    },
  }
  completed.set(key, result)
  return result
})

const addReferenced = Effect.fnUntraced(function* (
  referenced: Map<string, Type.Type>,
  type: DeclarationFacts.SemanticType,
): Effect.fn.Return<void> {
  if (!Type.isRuntimeConcrete(type)) return
  const key = Type.runtimeKey(type)
  if (referenced.has(key)) return
  referenced.set(key, type)
  if (Type.isNominal(type)) {
    for (const argument of type.arguments)
      if (Type.isTypeArgument(argument)) yield* addReferenced(referenced, argument)
  }
  if (Type.isFixedArray(type)) yield* addReferenced(referenced, type.element)
  if (Type.isSlice(type)) yield* addReferenced(referenced, type.element)
  else if (Type.isReference(type)) yield* addReferenced(referenced, type.target)
  else if (Type.isPointer(type)) yield* addReferenced(referenced, type.pointee)
  if (Type.isUnion(type))
    for (const member of type.members) yield* addReferenced(referenced, member)
  if (Type.isEffect(type)) {
    yield* addReferenced(referenced, type.success)
    for (const failure of Type.failureMembers(type)) yield* addReferenced(referenced, failure)
  }
  if (Type.isRepresented(type) && Type.isEffect(type.contract)) {
    yield* addReferenced(referenced, type.contract.success)
    for (const failure of Type.failureMembers(type.contract))
      yield* addReferenced(referenced, failure)
  }
})

/** Adds runtime-reached types in dependency order, including exact executable representations. */
const addReached = Effect.fnUntraced(function* (
  referenced: Map<string, Type.Type>,
  type: DeclarationFacts.SemanticType,
  visiting: Set<string>,
): Effect.fn.Return<void> {
  const key = Type.runtimeKey(type)
  if (referenced.has(key) || visiting.has(key)) return
  visiting.add(key)
  if (Type.isNominal(type)) {
    for (const argument of type.arguments)
      if (Type.isTypeArgument(argument)) yield* addReached(referenced, argument, visiting)
  }
  if (Type.isFixedArray(type) || Type.isSlice(type))
    yield* addReached(referenced, type.element, visiting)
  else if (Type.isReference(type)) yield* addReached(referenced, type.target, visiting)
  else if (Type.isPointer(type)) yield* addReached(referenced, type.pointee, visiting)
  if (Type.isUnion(type))
    for (const member of type.members) yield* addReached(referenced, member, visiting)
  if (Type.isEffect(type)) {
    yield* addReached(referenced, type.success, visiting)
    for (const failure of Type.failureMembers(type))
      yield* addReached(referenced, failure, visiting)
  }
  if (Type.isRepresented(type) && Type.isEffect(type.contract)) {
    yield* addReached(referenced, type.contract.success, visiting)
    for (const failure of Type.failureMembers(type.contract))
      yield* addReached(referenced, failure, visiting)
  }
  visiting.delete(key)
  referenced.set(key, type)
})

const addSpecializedExpression = Effect.fnUntraced(function* (
  referenced: Map<string, Type.Type>,
  substitution: Type.Substitution,
  expression: Tir.Expression,
): Effect.fn.Return<void> {
  if (expression._tag === 'Unavailable') return
  yield* addReferenced(referenced, Type.substitute(expression.type, substitution))
  if (expression._tag === 'UnionConvert')
    yield* addReferenced(referenced, Type.substitute(expression.sourceType, substitution))
  for (const child of Tir.expressionTree(expression).slice(1)) {
    if (child._tag !== 'Unavailable')
      yield* addReferenced(referenced, Type.substitute(child.type, substitution))
  }
  for (const child of Tir.expressionTree(expression)) {
    if (child._tag === 'BuiltinCall') {
      if (Scalar.isCheckedOperation(child.operation)) yield* addReferenced(referenced, 'bool')
      for (const argument of child.typeArguments) {
        const specialized = Type.substituteGenericArgument(argument, substitution)
        if (Type.isTypeArgument(specialized)) yield* addReferenced(referenced, specialized)
        else {
          const represented = Type.representedType(specialized)
          if (represented !== undefined) yield* addReferenced(referenced, represented)
        }
      }
    }
    if (child._tag === 'EffectCatch' && child.protected._tag !== 'Unavailable') {
      const protected_ = Type.substitute(child.protected.type, substitution)
      if (Type.isEffect(protected_)) {
        yield* addReferenced(referenced, 'bool')
        yield* addReferenced(referenced, protected_.success)
        yield* addReferenced(referenced, Type.failureValue(Type.failureMembers(protected_)))
      }
    }
  }
})

const addPatternStatementTypes = Effect.fnUntraced(function* (
  referenced: Map<string, Type.Type>,
  substitution: Type.Substitution,
  statement: Tir.Statement,
): Effect.fn.Return<void> {
  if (statement._tag === 'PatternBind' || statement._tag === 'IfLet') {
    yield* addReferenced(referenced, 'bool')
    for (const member of statement.selection.members)
      yield* addReferenced(referenced, Type.substitute(Match.sourceType(member), substitution))
    for (const binding of statement.selection.bindings)
      yield* addReferenced(referenced, Type.substitute(binding.type, substitution))
  }
  if (statement._tag === 'Unsafe')
    for (const nested of statement.statements)
      yield* addPatternStatementTypes(referenced, substitution, nested)
  if (statement._tag === 'If' || statement._tag === 'IfLet') {
    for (const nested of statement.taken)
      yield* addPatternStatementTypes(referenced, substitution, nested)
    for (const nested of statement.otherwise)
      yield* addPatternStatementTypes(referenced, substitution, nested)
  }
  if (statement._tag === 'While')
    for (const nested of statement.body)
      yield* addPatternStatementTypes(referenced, substitution, nested)
})

// Reachability and target planning

interface PlanState {
  readonly catalog: Catalog
  readonly entries: Map<string, Entry>
}

const resolvePlanEntry = (
  state: PlanState,
  type: DeclarationFacts.SemanticType,
): Entry | undefined => {
  const self = state.catalog
  if (Type.isBuiltin(type)) return scalarEntry(self.target, type)
  if (Type.isString(type)) return stringEntry(self.target, type)
  if (Type.isNever(type)) return neverEntry()
  const candidate = catalogEntry(self, type)
  if (candidate?._tag === 'LayoutEntry') return candidate
  if (Type.isSlice(type)) {
    if (candidate?._tag === 'UnavailableLayoutEntry') return undefined
    const element = resolvePlanEntry(state, type.element)
    return element === undefined ? undefined : sliceEntry(self.target, type, element)
  }
  if (Type.isReference(type)) return referenceEntry(self.target, type)
  if (Type.isPointer(type)) return pointerEntry(self.target, type)
  if (!Type.isFixedArray(type) || candidate?._tag === 'UnavailableLayoutEntry') return undefined
  const element = resolvePlanEntry(state, type.element)
  return element === undefined ? undefined : repeatedEntry(type, element)
}

const addPlanEntry = (state: PlanState, type: DeclarationFacts.SemanticType): void => {
  const { entries } = state
  const key = Type.runtimeKey(type)
  if (Type.isEffect(type)) {
    addPlanEntry(state, type.success)
    for (const failure of Type.failureMembers(type)) addPlanEntry(state, failure)
    return
  }
  if (entries.has(key)) return
  const candidate = resolvePlanEntry(state, type)
  if (candidate === undefined) return
  entries.set(key, candidate)
  if (Type.isSharedCore(type)) {
    const element = Type.typeArgumentAt(type, 0)
    if (element !== undefined) addPlanEntry(state, element)
    // The control block embeds the allocation that backs it, so releasing a shared core that
    // nothing in the program ever made (a union alternative, an absent Option) still needs it.
    addPlanEntry(state, Type.allocation)
  }
  if (
    Type.isRepresented(type) &&
    Type.isCompositeEffectRepresentationArgument(type.representation.argument)
  ) {
    for (const alternative of type.representation.argument.alternatives)
      addPlanEntry(
        state,
        Type.represented(type.contract, type.representation.requiredBound, alternative),
      )
  }
  for (const field of candidate.executable?.fields ?? []) addPlanEntry(state, field.type)
  if (candidate.representation._tag === 'Aggregate') {
    for (const field of candidate.representation.fields) addPlanEntry(state, field.type)
  } else if (candidate.representation._tag === 'NominalUnion') {
    for (const variant of candidate.representation.variants)
      for (const field of variant.fields) addPlanEntry(state, field.type)
  } else if (
    candidate.representation._tag === 'CallableEnvironment' ||
    candidate.representation._tag === 'StoredEffectEnvironment'
  ) {
    for (const field of candidate.representation.fields) addPlanEntry(state, field.type)
  } else if (candidate.representation._tag === 'Repeated') {
    addPlanEntry(state, candidate.representation.element)
  } else if (candidate.representation._tag === 'Slice') {
    addPlanEntry(state, candidate.representation.element)
    addPlanEntry(state, 'usize')
  } else if (candidate.representation._tag === 'String') {
    addPlanEntry(state, 'usize')
  } else if (candidate.representation._tag === 'Reference') {
    addPlanEntry(state, candidate.representation.target)
  } else if (candidate.representation._tag === 'Union') {
    for (const member of candidate.representation.members) addPlanEntry(state, member.type)
  }
}

const collectReachableTypes = Effect.fn('Layout.collectReachableTypes')(function* (
  discovery: Instances.Discovery,
) {
  const reached = new Map<string, DeclarationFacts.SemanticType>()
  for (const instance of discovery.instances) yield* addFunctionTypes(reached, instance)
  for (const effect of discovery.effects) reached.set(Type.runtimeKey(effect.type), effect.type)
  for (const instance of discovery.instances) {
    for (const expression of instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      if (expression._tag === 'EffectCatch') reached.set(Type.runtimeKey('bool'), 'bool')
      if (
        expression._tag !== 'BuiltinCall' ||
        (expression.operation !== 'ExecutionLayout' &&
          expression.operation !== 'ExecutionFromAllocation')
      )
        continue
      const arguments_ = expression.typeArguments.map((argument) =>
        Instances.concreteEffectRepresentationArgument(
          instance.function,
          instance.key,
          Type.substituteGenericArgument(
            argument,
            instance.substitution,
            instance.specialization.compatibility,
          ),
        ),
      )
      for (const argument of [arguments_.at(0), arguments_.at(2)])
        if (argument !== undefined && Type.isTypeArgument(argument))
          reached.set(Type.runtimeKey(argument), argument)
      for (const argument of [arguments_.at(1), arguments_.at(3)]) {
        const represented = argument === undefined ? undefined : Type.representedType(argument)
        if (represented !== undefined) reached.set(Type.runtimeKey(represented), represented)
      }
    }
  }
  for (const callable of discovery.callables) {
    for (const capture of callable.captures)
      reached.set(Type.runtimeKey(capture.type), capture.type)
  }
  return reached
})

const addFunctionTypes = Effect.fnUntraced(function* (
  types: Map<string, DeclarationFacts.SemanticType>,
  instance: Instances.Instance,
): Effect.fn.Return<void> {
  const fn = instance.function
  for (const represented of representedParameterTypes(instance))
    types.set(Type.runtimeKey(represented), represented)
  if (needsInitializationFlags(instance)) types.set(Type.runtimeKey('bool'), 'bool')
  const substitution = instance.substitution
  for (const parameter of fn.declaration.parameters) {
    if (parameter.declaredType._tag === 'Resolved') {
      const type = Type.substitute(parameter.declaredType.type, substitution)
      types.set(Type.runtimeKey(type), type)
    }
  }
  if (fn.declaration.returnType._tag === 'Resolved') {
    const type = Type.substitute(fn.declaration.returnType.type, substitution)
    types.set(Type.runtimeKey(type), type)
    if (fn.declaration.functionKind === 'Effect') {
      const failures = fn.declaration.failureRow.failures.flatMap((failure) => {
        const specialized = Type.substitute(failure, substitution)
        return Type.isNominal(specialized) ? [specialized] : []
      })
      const requirements = fn.declaration.requirementRow.requirements.flatMap((requirement) => {
        const capability = Type.substitute(requirement.capability, substitution)
        return Type.isNominal(capability) ? [{ ...requirement, capability }] : []
      })
      const outcome = Type.effect(
        type,
        failures,
        DeclarationFacts.effectLifetimes(fn.declaration),
        'Shared',
        requirements,
      )
      types.set(Type.runtimeKey(outcome), outcome)
    }
  }
  yield* addStatementTypes(types, fn.statements, substitution)
})

const addStatementTypes = Effect.fnUntraced(function* (
  types: Map<string, DeclarationFacts.SemanticType>,
  statements: ReadonlyArray<Tir.Statement>,
  substitution: Type.Substitution = new Map(),
): Effect.fn.Return<void> {
  for (const statement of statements) {
    if (statement._tag === 'Unsafe')
      yield* addStatementTypes(types, statement.statements, substitution)
    if (statement._tag === 'Bind')
      yield* addExpressionTypes(types, statement.initializer, substitution)
    if (statement._tag === 'PatternBind') {
      types.set(Type.runtimeKey('bool'), 'bool')
      yield* addExpressionTypes(types, statement.selection.subject, substitution)
      for (const member of statement.selection.members) {
        const type = Type.substitute(Match.sourceType(member), substitution)
        types.set(Type.runtimeKey(type), type)
      }
      for (const binding of statement.selection.bindings) {
        const type = Type.substitute(binding.type, substitution)
        types.set(Type.runtimeKey(type), type)
      }
    }
    if (statement._tag === 'Evaluate')
      yield* addExpressionTypes(types, statement.expression, substitution)
    if (statement._tag === 'Return')
      yield* addExpressionTypes(types, statement.expression, substitution)
    if (statement._tag === 'Fail' || statement._tag === 'Drop')
      yield* addExpressionTypes(types, statement.expression, substitution)
    if (statement._tag === 'If') {
      yield* addExpressionTypes(types, statement.condition, substitution)
      yield* addStatementTypes(types, statement.taken, substitution)
      yield* addStatementTypes(types, statement.otherwise, substitution)
    }
    if (statement._tag === 'IfLet') {
      types.set(Type.runtimeKey('bool'), 'bool')
      yield* addExpressionTypes(types, statement.selection.subject, substitution)
      for (const member of statement.selection.members) {
        const type = Type.substitute(Match.sourceType(member), substitution)
        types.set(Type.runtimeKey(type), type)
      }
      for (const binding of statement.selection.bindings) {
        const type = Type.substitute(binding.type, substitution)
        types.set(Type.runtimeKey(type), type)
      }
      yield* addStatementTypes(types, statement.taken, substitution)
      yield* addStatementTypes(types, statement.otherwise, substitution)
    }
    if (statement._tag === 'Write') {
      yield* addExpressionTypes(types, statement.value, substitution)
      for (const selector of statement.place.selectors) {
        if (selector._tag === 'Index' || selector._tag === 'SliceIndex') {
          yield* addExpressionTypes(types, selector.index, substitution)
        }
      }
    }
    if (statement._tag === 'While') {
      yield* addExpressionTypes(types, statement.condition, substitution)
      yield* addStatementTypes(types, statement.body, substitution)
    }
  }
})

const addExpressionTypes = Effect.fnUntraced(function* (
  types: Map<string, DeclarationFacts.SemanticType>,
  expression: Tir.Expression,
  substitution: Type.Substitution = new Map(),
): Effect.fn.Return<void> {
  if (expression._tag === 'Unavailable') return
  const specialized = Type.substitute(expression.type, substitution)
  types.set(Type.runtimeKey(specialized), specialized)
  if (expression._tag === 'BuiltinCall') {
    if (Scalar.isCheckedOperation(expression.operation)) types.set(Type.runtimeKey('bool'), 'bool')
    for (const argument of expression.typeArguments) {
      const specialized = Type.substituteGenericArgument(argument, substitution)
      const type = Type.isTypeArgument(specialized)
        ? specialized
        : Type.representedType(specialized)
      if (type !== undefined) types.set(Type.runtimeKey(type), type)
    }
  }
  if (expression._tag === 'Move') yield* addExpressionTypes(types, expression.subject, substitution)
  if (expression._tag === 'RuntimeStringView')
    yield* addExpressionTypes(types, expression.source, substitution)
  if (expression._tag === 'ShortCircuit') {
    yield* addExpressionTypes(types, expression.left, substitution)
    yield* addExpressionTypes(types, expression.right, substitution)
  }
  if (expression._tag === 'StringEquality' || expression._tag === 'EnumEquality') {
    yield* addExpressionTypes(types, expression.left, substitution)
    yield* addExpressionTypes(types, expression.right, substitution)
  }
  if (expression._tag === 'EnumValue')
    yield* addExpressionTypes(types, expression.value, substitution)
  if (expression._tag === 'UnionConvert') {
    const sourceType = Type.substitute(expression.sourceType, substitution)
    types.set(Type.runtimeKey(sourceType), sourceType)
    yield* addExpressionTypes(types, expression.source, substitution)
  }
  if (expression._tag === 'Project')
    yield* addExpressionTypes(types, expression.subject, substitution)
  if (expression._tag === 'IndexPlace') {
    yield* addExpressionTypes(types, expression.subject, substitution)
    yield* addExpressionTypes(types, expression.index, substitution)
  }
  if (expression._tag === 'SliceLength') {
    yield* addExpressionTypes(types, expression.slice, substitution)
  }
  if (expression._tag === 'SliceIndexPlace') {
    yield* addExpressionTypes(types, expression.slice, substitution)
    yield* addExpressionTypes(types, expression.index, substitution)
  }
  if (
    (expression._tag === 'SliceBorrow' || expression._tag === 'ValueBorrow') &&
    expression.root._tag === 'TemporarySliceRoot'
  ) {
    yield* addExpressionTypes(types, expression.root.value, substitution)
  }
  if (expression._tag === 'Construct' || expression._tag === 'ConstructUnionVariant') {
    for (const field of expression.fields)
      yield* addExpressionTypes(types, field.value, substitution)
  }
  if (expression._tag === 'ArrayConstruct') {
    for (const element of expression.elements)
      yield* addExpressionTypes(types, element, substitution)
  }
  if (
    expression._tag === 'Call' ||
    expression._tag === 'EffectConstruct' ||
    expression._tag === 'ServiceEffectConstruct' ||
    expression._tag === 'BuiltinCall' ||
    expression._tag === 'InterfaceOperationCall'
  ) {
    for (const argument of expression.arguments)
      yield* addExpressionTypes(types, argument, substitution)
    let contract: DeclarationFacts.InterfaceOperationApplicationFact | undefined
    if (expression._tag === 'InterfaceOperationCall') {
      contract = expression.contract
    } else if (expression._tag === 'BuiltinCall') {
      contract = expression.interfaceOperation?.contract
    }
    for (const operand of contract?.operands ?? []) {
      if (operand.type._tag !== 'Resolved') continue
      const type = Type.substitute(operand.type.type, substitution)
      types.set(Type.runtimeKey(type), type)
    }
  }
  if (expression._tag === 'CallableSection') {
    for (const capture of expression.captures) {
      yield* addExpressionTypes(types, capture.value, substitution)
    }
  }
  if (expression._tag === 'CallableApply' || expression._tag === 'ForeignApply') {
    yield* addExpressionTypes(types, expression.callee, substitution)
    for (const argument of expression.arguments)
      yield* addExpressionTypes(types, argument, substitution)
  }
  if (expression._tag === 'EffectBlock') {
    yield* addStatementTypes(types, expression.statements, substitution)
  }
  if (expression._tag === 'Run') yield* addExpressionTypes(types, expression.subject, substitution)
  if (expression._tag === 'EffectBindRequirement') {
    yield* addExpressionTypes(types, expression.protected, substitution)
    const provider = Type.substitute(expression.provider.providerType, substitution)
    if (Type.isNominal(provider)) {
      types.set(Type.runtimeKey(provider), provider)
      const reference = Type.reference(
        expression.provider.selectionAccess === 'Take'
          ? 'Exclusive'
          : expression.provider.selectionAccess,
        provider,
        Type.substituteLifetime(expression.type.environment, substitution),
      )
      types.set(Type.runtimeKey(reference), reference)
    }
  }
  if (expression._tag === 'EffectCatch') {
    types.set(Type.runtimeKey('never'), 'never')
    types.set(Type.runtimeKey('bool'), 'bool')
    yield* addExpressionTypes(types, expression.protected, substitution)
    yield* addExpressionTypes(types, expression.handler, substitution)
    if (expression.protected._tag !== 'Unavailable') {
      const protected_ = Type.substitute(expression.protected.type, substitution)
      if (Type.isEffect(protected_)) {
        types.set(Type.runtimeKey(protected_.success), protected_.success)
        const failure = Type.failureValue(Type.failureMembers(protected_))
        types.set(Type.runtimeKey(failure), failure)
      }
    }
  }
  if (expression._tag === 'Match') {
    yield* addExpressionTypes(types, expression.scrutinee, substitution)
    for (const member of expression.members) {
      const type = Type.substitute(Match.sourceType(member), substitution)
      types.set(Type.runtimeKey(type), type)
    }
    for (const arm of expression.arms) {
      if (!arm.reachable) continue
      if (arm.member !== undefined) {
        const memberType = Match.sourceType(arm.member)
        types.set(Type.runtimeKey(memberType), memberType)
      }
      for (const binding of arm.bindings) types.set(Type.runtimeKey(binding.type), binding.type)
      if (arm.guard !== undefined) yield* addExpressionTypes(types, arm.guard, substitution)
      if (arm.body._tag === 'Expression')
        yield* addExpressionTypes(types, arm.body.expression, substitution)
      else yield* addStatementTypes(types, arm.body.statements, substitution)
    }
  }
})

const needsInitializationFlags = (instance: Instances.Instance): boolean =>
  instance.ownership.exits.some((exit) =>
    exit.releases.some((release) => MovePath.conditionalPaths(release.initialization).length > 0),
  ) ||
  instance.ownership.transitions.some(
    (transition) =>
      MovePath.conditionalPaths(transition.before).length > 0 ||
      MovePath.conditionalPaths(transition.after).length > 0,
  )

/** Materializes the exact composite parameter view used by MIR, including its required access. */
const representedParameterTypes = (instance: Instances.Instance): ReadonlyArray<Type.Represented> =>
  instance.specialization.parameters.flatMap((parameter, ordinal) => {
    if (!Type.isEffect(parameter)) return []
    const representation = Instances.parameterEffectRepresentationArgument(
      instance.function,
      instance.key,
      ordinal,
    )
    if (
      representation === undefined ||
      !Type.isCompositeEffectRepresentationArgument(representation)
    )
      return []
    const type = Type.substitute(
      Type.represented(parameter, parameter, representation),
      instance.substitution,
      instance.specialization.compatibility,
    )
    return Type.isRepresented(type) ? [type] : []
  })

const resolveEntries = Effect.fn('Layout.resolveEntries')(function* (
  state: PlanState,
  reached: ReadonlyMap<string, Type.Type>,
) {
  yield* Effect.annotateCurrentSpan({ 'reachable.count': reached.size })

  for (const type of reached.values()) addPlanEntry(state, type)
})

const collectShapeTypes = Effect.fn('Layout.collectShapeTypes')(function* (
  orderedEntries: ReadonlyArray<Entry>,
  reached: ReadonlyMap<string, Type.Type>,
) {
  yield* Effect.annotateCurrentSpan({
    'entries.count': orderedEntries.length,
    'reachable.count': reached.size,
  })

  const shaped = new Map(
    orderedEntries.map((entry) => [Type.runtimeKey(entry.type), entry.type] as const),
  )
  for (const type of reached.values()) {
    if (
      Type.isRuntimeConcrete(type) &&
      (Type.isEffect(type) ||
        Type.isNever(type) ||
        (Type.isRepresented(type) &&
          Type.isCompositeEffectRepresentationArgument(type.representation.argument)))
    )
      shaped.set(Type.runtimeKey(type), type)
  }
  const shapeTypes = [...shaped.values()].sort(compareRuntimeTypes)
  return shapeTypes
})

const checkLocalSharedLayouts = Effect.fn('Layout.checkLocalSharedLayouts')(function* (
  state: PlanState,
  discovery: Instances.Discovery,
) {
  yield* Effect.annotateCurrentSpan({ 'instances.count': discovery.instances.length })

  const localSharedDiagnostics: Array<Diagnostic.Diagnostic> = []
  for (const instance of discovery.instances) {
    for (const expression of instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      if (expression._tag !== 'BuiltinCall' || expression.operation !== 'SharedLayout') continue
      const raw = expression.typeArguments.at(0)
      const element =
        raw !== undefined && Type.isTypeArgument(raw)
          ? Type.substitute(raw, instance.substitution, instance.specialization.compatibility)
          : undefined
      const elementLayout = element === undefined ? undefined : resolvePlanEntry(state, element)
      if (
        element !== undefined &&
        elementLayout !== undefined &&
        LocalSharedControlBlock.plan(state.catalog.target, element, elementLayout)._tag ===
          'LocalSharedControlBlockUnavailable'
      )
        localSharedDiagnostics.push(
          Diagnostic.intrinsicTargetUnavailable(
            'Intrinsic.sharedLayout',
            state.catalog.target.id,
            expression.span,
          ),
        )
    }
  }
  return localSharedDiagnostics
})

const planLocalSharedAllocation = Effect.fn('Layout.planLocalSharedAllocation')(
  (discovery: Instances.Discovery, index: DeclarationIndex.Index) =>
    Effect.sync(() => LocalSharedAllocationProvenance.plan(discovery, index)),
)

const planValueStorage = Effect.fn('Layout.planValueStorage')((self: Plan) =>
  Effect.sync(() => ValueStorage.plan(self)),
)

const representedStorageLayout = (
  effectPlans: ReadonlyArray<EffectEnvironment>,
  callablePlans: ReadonlyArray<CallableEnvironment>,
  argument: Type.GenericArgument,
):
  | {
      readonly size: number
      readonly alignment: number
    }
  | undefined => {
  if (Type.isExactRepresentationArgument(argument)) {
    if (Type.isEffectIdentityArgument(argument.identity)) {
      const environment = effectEnvironmentByIdentity(effectPlans, argument.identity)
      return environment === undefined
        ? undefined
        : { size: environment.size, alignment: environment.alignment }
    }
    if (!Type.isCallableIdentityArgument(argument.identity)) return undefined
    const callableIdentity = argument.identity
    const callableEnvironment = callableIdentity.environment
    if (callableEnvironment === undefined) return { size: 0, alignment: 1 }
    const environment = environmentsWithIdentity(callablePlans, callableEnvironment).at(0)
    return environment === undefined
      ? undefined
      : { size: environment.size, alignment: environment.alignment }
  }
  if (Type.isCompositeEffectRepresentationArgument(argument)) {
    const alternatives = argument.alternatives.map((argument) =>
      representedStorageLayout(effectPlans, callablePlans, argument),
    )
    if (alternatives.some((alternative) => alternative === undefined)) return undefined
    const available = alternatives.filter(
      (
        alternative,
      ): alternative is {
        readonly size: number
        readonly alignment: number
      } => alternative !== undefined,
    )
    const payloadAlignment = available.reduce(
      (maximum, alternative) => Math.max(maximum, alternative.alignment),
      1,
    )
    const payloadSize = available.reduce(
      (maximum, alternative) => Math.max(maximum, alternative.size),
      0,
    )
    const alignment = Math.max(4, payloadAlignment)
    const payloadOffset = alignUp(4, payloadAlignment)
    const size = alignUp(payloadOffset + payloadSize, alignment)
    return Number.isSafeInteger(size) ? { size, alignment } : undefined
  }
  return undefined
}

const suspensionOf = (
  discovery: Instances.Discovery,
  argument: Type.GenericArgument,
): SuspensionMode.Summary => {
  if (Type.isExactRepresentationArgument(argument))
    return Type.isEffectIdentityArgument(argument.identity)
      ? Instances.representedEffectSuspensionOf(discovery, argument.identity)
      : SuspensionMode.direct
  if (Type.isCompositeEffectRepresentationArgument(argument))
    return SuspensionMode.join(
      argument.alternatives.map((argument) => suspensionOf(discovery, argument)),
    )
  return SuspensionMode.openExecutable([])
}

const planExecutionPackages = Effect.fn('Layout.planExecutionPackages')(function* (
  state: PlanState,
  index: DeclarationIndex.Index,
  discovery: Instances.Discovery,
  effectPlans: ReadonlyArray<EffectEnvironment>,
  callablePlans: ReadonlyArray<CallableEnvironment>,
) {
  yield* Effect.annotateCurrentSpan({ 'instances.count': discovery.instances.length })

  const executionPlanByKey = new Map<string, ExecutionPackage.Plan>()
  const executionUnavailableByKey = new Map<string, ExecutionPackage.Unavailable>()
  const executionDiagnostics: Array<Diagnostic.Diagnostic> = []
  for (const instance of discovery.instances) {
    for (const expression of instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.expressionTree)) {
      if (
        expression._tag !== 'BuiltinCall' ||
        (expression.operation !== 'ExecutionLayout' &&
          expression.operation !== 'ExecutionFromAllocation')
      )
        continue
      const arguments_ = expression.typeArguments.map((argument) =>
        Instances.concreteEffectRepresentationArgument(
          instance.function,
          instance.key,
          Type.substituteGenericArgument(
            argument,
            instance.substitution,
            instance.specialization.compatibility,
          ),
        ),
      )
      const result = arguments_.at(0)
      const bodyArgument = arguments_.at(1)
      const endpoint = arguments_.at(2)
      const callbackArgument = arguments_.at(3)
      const body = bodyArgument === undefined ? undefined : Type.representedType(bodyArgument)
      const callback =
        callbackArgument === undefined ? undefined : Type.representedType(callbackArgument)
      if (
        result === undefined ||
        !Type.isTypeArgument(result) ||
        bodyArgument === undefined ||
        body === undefined ||
        endpoint === undefined ||
        !Type.isTypeArgument(endpoint) ||
        callback === undefined ||
        callbackArgument === undefined
      )
        continue
      const bodyLayout = representedStorageLayout(effectPlans, callablePlans, bodyArgument)
      const endpointLayout = resolvePlanEntry(state, endpoint)
      const callbackLayout = representedStorageLayout(effectPlans, callablePlans, callbackArgument)
      if (bodyLayout === undefined || endpointLayout === undefined || callbackLayout === undefined)
        continue
      const specialization: ExecutionPackage.Specialization = {
        result,
        body,
        endpoint,
        callback,
        suspension: suspensionOf(discovery, bodyArgument),
      }
      const planned = ExecutionPackage.plan(state.catalog.target, specialization, {
        body: bodyLayout,
        endpoint: endpointLayout,
        callback: callbackLayout,
      })
      const selected =
        planned._tag === 'ExecutionPackagePlan'
          ? {
              ...planned,
              cleanup: {
                body: CleanupPlan.cleanupPlan(index, body),
                endpoint: CleanupPlan.cleanupPlan(index, endpoint),
                callback: CleanupPlan.cleanupPlan(index, callback),
              },
            }
          : planned
      const key = ExecutionPackage.specializationKey(specialization)
      if (selected._tag === 'ExecutionPackagePlan') executionPlanByKey.set(key, selected)
      else {
        executionUnavailableByKey.set(key, selected)
        executionDiagnostics.push(
          Diagnostic.intrinsicTargetUnavailable(
            `Intrinsic.${expression.operation === 'ExecutionLayout' ? 'executionLayout' : 'executionFromAllocation'}`,
            state.catalog.target.id,
            expression.span,
          ),
        )
      }
    }
  }
  const executionPackages: ExecutionPackage.Module = {
    _tag: 'ExecutionPackageModule',
    plans: [...executionPlanByKey.values()].sort((left, right) =>
      left.provenance.localeCompare(right.provenance),
    ),
    unavailable: [...executionUnavailableByKey.values()].sort((left, right) =>
      ExecutionPackage.specializationKey(left.specialization).localeCompare(
        ExecutionPackage.specializationKey(right.specialization),
      ),
    ),
  }
  return { executionPackages, executionDiagnostics }
})

const planStaticData = Effect.fn('Layout.planStaticData')(function* (
  target: Target.Target,
  discovery: Instances.Discovery,
) {
  yield* Effect.annotateCurrentSpan({ 'instances.count': discovery.instances.length })

  const staticDataById = new Map<string, StaticText.Data>()
  for (const instance of discovery.instances) {
    const expressions = instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.runtimeExpressionTree)
    for (const expression of expressions) {
      if (expression._tag === 'StaticStringLiteral' || expression._tag === 'StaticByteViewLiteral')
        staticDataById.set(expression.data.id, expression.data)
    }
  }
  const addressBits: 32 | 64 = target.pointerSize === 4 ? 32 : 64
  const staticData = [...staticDataById.values()]
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((data) => ({
      _tag: 'StaticDataPlacement' as const,
      data,
      alignment: 1 as const,
      addressBits,
      lengthBits: addressBits,
    }))
  return staticData
})

interface WordLiteralState {
  readonly seen: Set<string>
  readonly bits: 32 | 64
  readonly target: Target.Target
  readonly verdicts: Array<WordLiteralVerdict>
  readonly diagnostics: Array<Diagnostic.Diagnostic>
}

export const isWordType = (type: unknown): type is WordType => type === 'usize' || type === 'isize'

/** The inclusive exact range one word type spans on a target of the given width. */
export const wordRange = (
  type: WordType,
  bits: 32 | 64,
): {
  readonly minimum: bigint
  readonly maximum: bigint
} =>
  type === 'usize'
    ? { minimum: 0n, maximum: (1n << BigInt(bits)) - 1n }
    : { minimum: -(1n << BigInt(bits - 1)), maximum: (1n << BigInt(bits - 1)) - 1n }

const planLiteralVerdicts = Effect.fn('Layout.planLiteralVerdicts')(function* (
  target: Target.Target,
  discovery: Instances.Discovery,
  constants: ReadonlyArray<WordConstantLiteral>,
): Effect.fn.Return<{
  readonly verdicts: ReadonlyArray<WordLiteralVerdict>
  readonly diagnostics: ReadonlyArray<Diagnostic.Diagnostic>
}> {
  yield* Effect.annotateCurrentSpan({
    'constants.count': constants.length,
    'instances.count': discovery.instances.length,
  })

  const bits: 32 | 64 = target.pointerSize === 4 ? 32 : 64
  const verdicts: Array<WordLiteralVerdict> = []
  const diagnostics: Array<Diagnostic.Diagnostic> = []
  const seen = new Set<string>()

  const state: WordLiteralState = { seen, bits, target, verdicts, diagnostics }
  for (const constant of constants)
    addWordLiteral(state, constant.type, constant.value, constant.span)
  for (const instance of discovery.instances) {
    const expressions = instance.function.statements
      .flatMap(Tir.statementExpressions)
      .flatMap(Tir.runtimeExpressionTree)
    for (const expression of expressions) {
      if (expression._tag !== 'IntegerLiteral' || expression.constant !== undefined) continue
      const type = Type.substitute(
        expression.type,
        instance.substitution,
        instance.specialization.compatibility,
      )
      if (!isWordType(type)) continue
      addWordLiteral(state, type, BigInt(expression.value), expression.span)
    }
  }
  return {
    verdicts: verdicts,
    diagnostics: diagnostics,
  }
})

const addWordLiteral = (
  state: WordLiteralState,
  type: WordType,
  value: bigint,
  span: SourceSpan.SourceSpan,
): void => {
  const { seen, bits, target, verdicts, diagnostics } = state

  const key = `${span.sourceId}:${span.start}:${span.end}:${type}:${value}`
  if (seen.has(key)) return
  seen.add(key)
  const range = wordRange(type, bits)
  if (value >= range.minimum && value <= range.maximum) {
    verdicts.push({
      _tag: 'AvailableWordLiteral',
      type,
      value,
      bits,
      span,
    })
    return
  }
  const diagnostic = Diagnostic.wordLiteralTargetOutOfRange(
    type,
    value.toString(),
    target.id,
    bits,
    span,
  )
  diagnostics.push(diagnostic)
  verdicts.push({
    _tag: 'UnavailableWordLiteral',
    type,
    value,
    bits,
    span,
    cause: Diagnostic.identity(diagnostic),
  })
}

// Executable environment planning

interface EffectEnvironmentState {
  readonly target: Target.Target
  readonly discovery: Instances.Discovery
  readonly callablePlans: ReadonlyArray<CallableEnvironment>
  readonly layouts: ReadonlyMap<string, Entry>
  /** Every planned environment in planning order, repeated by each fixed-point pass. */
  readonly environments: Array<EffectEnvironment>
  /** The first available environment planned at each exact site identity. */
  readonly availableBySite: Map<string, PlannedEffectEnvironment>
  /** The first available environment planned under each success alias. */
  readonly availableBySuccess: Map<string, PlannedEffectEnvironment>
  /** Distinct available environment keys; the fixed point stops once a pass adds none. */
  readonly availableKeys: Set<string>
}

interface PlannedEffectEnvironment {
  readonly ordinal: number
  readonly environment: AvailableEffectEnvironment
}

/**
 * Appends one planned environment and indexes it. Capture resolution asks for the first matching
 * environment once per capture; scanning every planned environment made each pass quadratic.
 */
const recordEffectEnvironment = (
  state: EffectEnvironmentState,
  environment: EffectEnvironment,
): void => {
  const ordinal = state.environments.length
  state.environments.push(environment)
  if (environment._tag !== 'EffectEnvironment') return
  const planned = { ordinal, environment }
  const identity = Instances.effectIdentity(environment.instance, environment.site)
  if (!state.availableBySite.has(identity)) state.availableBySite.set(identity, planned)
  const success = environment.successEffectIdentity
  if (success !== undefined && !state.availableBySuccess.has(success))
    state.availableBySuccess.set(success, planned)
  state.availableKeys.add(environmentKey(environment))
}

/** The first planned environment at `identity`, aliased by it, or at `alias`'s exact site. */
const firstPlannedEffectEnvironment = (
  state: EffectEnvironmentState,
  identity: string,
  alias: string | undefined,
): AvailableEffectEnvironment | undefined => {
  let first: PlannedEffectEnvironment | undefined
  for (const planned of [
    state.availableBySite.get(identity),
    state.availableBySuccess.get(identity),
    alias === undefined ? undefined : state.availableBySite.get(alias),
  ])
    if (planned !== undefined && (first === undefined || planned.ordinal < first.ordinal))
      first = planned
  return first?.environment
}

interface EffectBindings {
  readonly bindingTypes: Map<number, Type.Type>
  readonly patternTypes: Map<string, Type.Type>
}

type EffectFieldDraft = Omit<EffectEnvironmentField, keyof Packing.PlacedField>

type EffectSite = ReturnType<typeof collectEffectSites>[number]

type WitnessEffect = ReturnType<typeof collectWitnessEffects>[number]

type EffectCapturePlan =
  | { readonly _tag: 'Available'; readonly input: Packing.Input<EffectFieldDraft> }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

interface CallableEnvironmentState {
  readonly target: Target.Target
  readonly discovery: Instances.Discovery
  readonly layouts: ReadonlyMap<string, Entry>
  readonly view: CallableView
  readonly planned: Map<Instances.CallableInstance, CallableEnvironment>
  readonly planning: Set<Instances.CallableInstance>
}

const planEffectEnvironments = Effect.fn('Layout.planEffectEnvironments')(function* (
  target: Target.Target,
  entries: ReadonlyArray<Entry>,
  discovery: Instances.Discovery,
  callablePlans: ReadonlyArray<CallableEnvironment>,
): Effect.fn.Return<ReadonlyArray<EffectEnvironment>> {
  const layouts = new Map(
    entries.map((candidate) => [Type.runtimeKey(candidate.type), candidate] as const),
  )
  const environments: Array<EffectEnvironment> = []
  const state: EffectEnvironmentState = {
    target,
    discovery,
    callablePlans,
    layouts,
    environments,
    availableBySite: new Map(),
    availableBySuccess: new Map(),
    availableKeys: new Set(),
  }
  // Effect parameters capture concrete environments supplied elsewhere in the instance graph.
  // Resolve those dependencies to a fixed point: breadth-first discovery is deterministic but is
  // not a topological order once combinators both consume and produce Effects.
  for (let pass = 0; pass <= discovery.instances.length; pass += 1) {
    const availableBefore = state.availableKeys.size
    for (const instance of [...discovery.instances].reverse())
      yield* planInstanceEnvironments(state, instance)
    if (state.availableKeys.size === availableBefore) break
  }
  const resolved = new Map<string, EffectEnvironment>()
  for (const environment of environments) {
    const key = environmentKey(environment)
    const previous = resolved.get(key)
    if (previous === undefined || environment._tag === 'EffectEnvironment')
      resolved.set(key, environment)
  }
  return [...resolved.values()].sort(
    (left, right) =>
      left.instance.declaration.module.localeCompare(right.instance.declaration.module) ||
      left.instance.declaration.name.localeCompare(right.instance.declaration.name) ||
      Tir.compareExecutableSites(left.site, right.site) ||
      Type.key(left.effect).localeCompare(Type.key(right.effect)),
  )
})

const planInstanceEnvironments = Effect.fn('Layout.planInstanceEnvironments')(function* (
  state: EffectEnvironmentState,
  instance: Instances.Instance,
): Effect.fn.Return<void> {
  yield* Effect.annotateCurrentSpan({
    'function.module': instance.key.declaration.module,
    'function.name': instance.key.declaration.name,
  })
  const bindingTypes = new Map<number, DeclarationFacts.SemanticType>()
  const patternTypes = new Map<string, DeclarationFacts.SemanticType>()
  yield* collectEffectBindings(instance, bindingTypes, patternTypes, instance.function.statements)
  const bindings: EffectBindings = { bindingTypes, patternTypes }
  const effectSites = collectEffectSites(instance)
  for (const block of effectSites) yield* planEffectSite(state, instance, bindings, block)
  const witnessEffects = collectWitnessEffects(instance)
  for (const witness of witnessEffects) yield* planWitnessEffect(state, instance, witness)
})

const collectEffectBindings = Effect.fnUntraced(function* (
  instance: Instances.Instance,
  bindingTypes: Map<number, Type.Type>,
  patternTypes: Map<string, Type.Type>,
  statements: ReadonlyArray<Tir.Statement>,
): Effect.fn.Return<void> {
  for (const statement of statements) {
    if (statement._tag === 'PatternBind' || statement._tag === 'IfLet')
      collectEffectPatterns(patternTypes, statement.selection.bindings)
    if (statement._tag === 'Bind' && statement.initializer._tag !== 'Unavailable') {
      bindingTypes.set(
        statement.binding.ordinal,
        Type.substitute(
          statement.initializer.type,
          instance.substitution,
          instance.specialization.compatibility,
        ),
      )
    } else if (statement._tag === 'If' || statement._tag === 'IfLet') {
      yield* collectEffectBindings(instance, bindingTypes, patternTypes, statement.taken)
      yield* collectEffectBindings(instance, bindingTypes, patternTypes, statement.otherwise)
    } else if (statement._tag === 'While')
      yield* collectEffectBindings(instance, bindingTypes, patternTypes, statement.body)
    else if (statement._tag === 'Unsafe')
      yield* collectEffectBindings(instance, bindingTypes, patternTypes, statement.statements)
    for (const expression of Tir.statementExpressions(statement)) {
      for (const child of Tir.expressionTree(expression)) {
        if (child._tag === 'EffectBlock')
          yield* collectEffectBindings(instance, bindingTypes, patternTypes, child.statements)
        if (child._tag === 'Match') {
          for (const arm of child.arms) {
            collectEffectPatterns(patternTypes, arm.bindings)
            if (arm.body._tag === 'Block')
              yield* collectEffectBindings(
                instance,
                bindingTypes,
                patternTypes,
                arm.body.statements,
              )
          }
        }
      }
    }
  }
})

const collectEffectPatterns = (
  patternTypes: Map<string, Type.Type>,
  bindings: ReadonlyArray<Tir.PatternBinding>,
): void => {
  for (const binding of bindings) patternTypes.set(effectPatternKey(binding.id), binding.type)
}

const effectPatternKey = (id: Tir.LocalId): string => `${id.ordinal}`

const collectEffectSites = (instance: Instances.Instance) => {
  const blocks = instance.function.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .filter(
      (
        expression,
      ): expression is Extract<
        Tir.Expression,
        {
          readonly _tag: 'EffectBlock'
        }
      > => expression._tag === 'EffectBlock',
    )
  const catchSites = instance.function.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .flatMap((expression) =>
      expression._tag !== 'EffectCatch'
        ? []
        : [
            {
              site: Tir.effectCatchSite(
                Tir.nodeReference(instance.view.artifact, expression),
                instance.key.declaration,
                instance.function.declaration.id.ordinal,
              ),
              type: expression.type,
              captures: [
                {
                  access: 'Take' as const,
                  pattern: undefined,
                  binding: undefined,
                  parameter: undefined,
                },
                {
                  access: 'Take' as const,
                  pattern: undefined,
                  binding: undefined,
                  parameter: undefined,
                },
              ],
            },
          ],
    )
  const builtinSites = instance.function.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .flatMap((expression) => {
      if (expression._tag !== 'BuiltinCall' || expression.witnessEffectSite !== undefined) return []
      const type = Type.substitute(
        expression.type,
        instance.substitution,
        instance.specialization.compatibility,
      )
      if (!Type.isEffect(type)) return []
      return [
        {
          site: Tir.builtinEffectSite(
            Tir.nodeReference(instance.view.artifact, expression),
            instance.key.declaration,
            instance.function.declaration.id.ordinal,
          ),
          type: expression.type,
          captures: expression.arguments.map((argument) => {
            const specialized =
              argument._tag === 'Unavailable'
                ? undefined
                : Type.substitute(
                    argument.type,
                    instance.substitution,
                    instance.specialization.compatibility,
                  )
            let access: 'Copy' | 'Shared' | 'Exclusive' | 'Take' = 'Take'
            if (
              specialized !== undefined &&
              (Type.isReference(specialized) || Type.isSlice(specialized))
            ) {
              access = specialized.access
            } else if (specialized !== undefined && Type.isCallable(specialized)) {
              access = specialized.mode
            }
            return {
              access,
              pattern: undefined,
              binding: undefined,
              parameter: undefined,
            }
          }),
        },
      ]
    })
  const effectSites = [
    ...blocks.map((block) => ({
      site: block.site,
      type: block.type,
      captures: block.captures,
      producer: block,
    })),
    ...catchSites.map((site) => ({ ...site, producer: undefined })),
    ...builtinSites.map((site) => ({ ...site, producer: undefined })),
  ]

  return effectSites
}

const collectWitnessEffects = (instance: Instances.Instance) => {
  const witnessEffects = instance.function.statements
    .flatMap(Tir.statementExpressions)
    .flatMap(Tir.expressionTree)
    .flatMap((expression) => {
      if (expression._tag !== 'InterfaceOperationCall' && expression._tag !== 'BuiltinCall')
        return []
      if (expression.witnessEffectSite === undefined) return []
      let contract: DeclarationFacts.InterfaceOperationApplicationFact | undefined
      if (expression._tag === 'InterfaceOperationCall') {
        contract = expression.contract
      } else if (expression._tag === 'BuiltinCall') {
        contract = expression.interfaceOperation?.contract
      }
      return contract === undefined
        ? []
        : [{ expression, contract, site: expression.witnessEffectSite }]
    })

  return witnessEffects
}

const planEffectSite = Effect.fn('Layout.planEffectSite')(function* (
  state: EffectEnvironmentState,
  instance: Instances.Instance,
  bindings: EffectBindings,
  block: EffectSite,
): Effect.fn.Return<void> {
  const structuralEffect =
    (block.producer === undefined
      ? undefined
      : EffectProducer.returnedContract(instance, block.producer)) ??
    Type.substitute(block.type, instance.substitution, instance.specialization.compatibility)
  if (!Type.isEffect(structuralEffect)) return
  const effectInstance = firstEffectInstance(
    state.discovery,
    Instances.effectIdentity(instance.key, block.site),
  )
  const realizedSlots =
    effectInstance === undefined ? [] : FieldRealization.effectEnvironmentOf(effectInstance)
  let effect = structuralEffect
  let unavailable: string | undefined
  const fieldInputs: Array<Packing.Input<EffectFieldDraft>> = []
  for (const [captureOrdinal, capture] of block.captures.entries()) {
    const field = yield* planEffectCapture(
      state,
      instance,
      bindings,
      capture,
      captureOrdinal,
      realizedSlots,
    )
    if (field._tag === 'Unavailable') {
      unavailable = field.reason
      break
    }
    fieldInputs.push(field.input)
  }
  if (unavailable === undefined) {
    let access: Type.CallableMode = 'Shared'
    if (fieldInputs.some((field) => field.value.access === 'Take')) {
      access = 'Take'
    } else if (fieldInputs.some((field) => field.value.access === 'Exclusive')) {
      access = 'Exclusive'
    }
    effect = Type.effectWithRows(
      structuralEffect.success,
      structuralEffect.failureRow,
      structuralEffect,
      access,
      structuralEffect.requirementRow,
    )
  }
  if (unavailable !== undefined) {
    recordEffectEnvironment(state, {
      _tag: 'UnavailableEffectEnvironment',
      instance: instance.key,
      site: block.site,
      effect,
      reason: unavailable,
    })
    return
  }
  const packed = placeEffectFields(fieldInputs)
  const successEffectIdentity = (instance.effectSuccesses ?? []).find((success) =>
    Tir.sameExecutableSite(success.site, block.site),
  )?.identity
  recordEffectEnvironment(state, {
    _tag: 'EffectEnvironment',
    instance: instance.key,
    site: block.site,
    effect,
    ...(successEffectIdentity === undefined ? {} : { successEffectIdentity }),
    fields: packed.fields,
    size: packed.size,
    alignment: packed.alignment,
    tailPadding: packed.tailPadding,
  })
})

const planEffectCapture = Effect.fn('Layout.planEffectCapture')(function* (
  state: EffectEnvironmentState,
  instance: Instances.Instance,
  bindings: EffectBindings,
  capture: EffectSite['captures'][number],
  captureOrdinal: number,
  realizedSlots: ReturnType<typeof FieldRealization.effectEnvironmentOf>,
): Effect.fn.Return<EffectCapturePlan> {
  yield* Effect.annotateCurrentSpan({ 'capture.ordinal': captureOrdinal })

  const { target, callablePlans, layouts } = state
  const { bindingTypes, patternTypes } = bindings

  const realized = realizedSlots.find((slot) => slot.ordinal === captureOrdinal)
  let source = realized?.source
  if (source === undefined) {
    if (capture.pattern !== undefined) source = 'Pattern'
    else source = capture.binding === undefined ? 'Parameter' : 'Binding'
  }
  const ordinal =
    realized?.sourceOrdinal ??
    capture.pattern?.ordinal ??
    capture.binding?.ordinal ??
    capture.parameter?.ordinal
  let type = realized?.type
  if (type === undefined && capture.pattern !== undefined) {
    type = patternTypes.get(effectPatternKey(capture.pattern))
  } else if (type === undefined && capture.binding === undefined) {
    if (instance.function.contract._tag === 'Contract' && ordinal !== undefined) {
      type = instance.function.contract.parameters.at(ordinal)
    }
  } else if (type === undefined && ordinal !== undefined) {
    type = bindingTypes.get(ordinal)
  }
  if (ordinal === undefined || type === undefined) {
    return { _tag: 'Unavailable', reason: `capture ${source.toLowerCase()} has no concrete type` }
  }
  const specialized =
    realized?.type ??
    Type.substitute(type, instance.substitution, instance.specialization.compatibility)
  const {
    capturedEffectIdentity,
    capturedEffectEnvironment,
    capturedCompositeRepresentation,
    capturedCompositeLayout,
  } = yield* resolveCapturedEffect(state, instance, source, ordinal, specialized, realized)
  const capturedCallableIdentity =
    realized?.callableIdentity ??
    (Type.isCallable(specialized) && source === 'Parameter'
      ? Instances.parameterCallableIdentity(instance.function, instance.key, ordinal)
      : undefined)
  const capturedCallableEnvironment =
    capturedCallableIdentity === undefined
      ? undefined
      : environmentMatching(callablePlans, capturedCallableIdentity)
  const parameterType = Type.isRepresented(specialized) ? specialized.contract : specialized
  const parameter = instance.function.declaration.parameters
    .filter((entry) => entry.phase === 'Runtime')
    .at(ordinal)
  const capturedCallableType =
    capturedCallableEnvironment === undefined
      ? undefined
      : {
          ...capturedCallableEnvironment.callable.type,
          mode: capturedCallableEnvironment.callable.mode,
        }
  const inputView =
    source !== 'Parameter' ||
    (!Type.isEffect(parameterType) && !Type.isCallable(parameterType)) ||
    (capturedEffectEnvironment === undefined && capturedCallableEnvironment === undefined) ||
    parameter === undefined
      ? undefined
      : state.discovery.calls
          .flatMap((call) => {
            if (
              call.node === undefined ||
              Instances.keyText(call.target) !== Instances.keyText(instance.key)
            )
              return []
            const caller = Instances.instanceByKey(state.discovery.instances, call.owner)
            if (caller?.ownership.verdict._tag !== 'Satisfied') return []
            const callNode = call.node
            return (call.inputViews ?? []).flatMap((view) => {
              if (
                view.parameter.ordinal !== ordinal ||
                AuthoredIdentity.anchorKey(view.parameter.source) !==
                  AuthoredIdentity.anchorKey(parameter.anchor) ||
                !Type.equals(view.expected, parameterType) ||
                !(
                  (Type.isEffect(view.actual) &&
                    Type.isEffect(view.expected) &&
                    capturedEffectEnvironment !== undefined &&
                    !Type.equals(
                      { ...view.expected, access: capturedEffectEnvironment.effect.access },
                      capturedEffectEnvironment.effect,
                    ) &&
                    Type.equals(
                      { ...view.actual, access: capturedEffectEnvironment.effect.access },
                      capturedEffectEnvironment.effect,
                    )) ||
                  (Type.isCallable(view.actual) &&
                    Type.isCallable(view.expected) &&
                    view.invocationSource !== undefined &&
                    capturedCallableType !== undefined &&
                    Type.equals(view.actual, capturedCallableType))
                )
              )
                return []
              const proof = { owner: call.owner, callNode, view }
              return ExecutableInputView.authority(
                state.discovery.instances,
                state.discovery.calls,
                proof,
              ) === undefined
                ? []
                : [proof]
            })
          })
          .at(0)
  let checkedInputType: Type.Type | undefined
  if (inputView !== undefined) {
    if (Type.isEffect(inputView.view.expected))
      checkedInputType = {
        ...inputView.view.expected,
        access: capturedEffectEnvironment?.effect.access ?? inputView.view.expected.access,
      }
    else checkedInputType = inputView.view.invocationSource?.selected
  }
  const fieldType =
    checkedInputType ??
    capturedEffectEnvironment?.effect ??
    (capturedCompositeRepresentation === undefined
      ? undefined
      : Type.represented(
          capturedCompositeRepresentation.contract,
          capturedCompositeRepresentation.contract,
          capturedCompositeRepresentation,
        )) ??
    (capturedCallableEnvironment === undefined
      ? undefined
      : {
          ...capturedCallableEnvironment.callable.type,
          mode: capturedCallableEnvironment.callable.mode,
        }) ??
    (capturedCallableIdentity !== undefined && Type.isCallable(specialized)
      ? { ...specialized, mode: 'Shared' as const }
      : specialized)
  const access =
    capturedEffectEnvironment?.effect.access ??
    capturedCallableEnvironment?.callable.mode ??
    (capturedCallableIdentity === undefined ? capture.access : 'Shared')
  const callable = capturedCallableIdentity !== undefined
  const borrowed =
    borrowedCapture(access, fieldType) && capturedEffectEnvironment === undefined && !callable
  const valueLayout =
    borrowed || callable
      ? undefined
      : (capturedEffectEnvironment ??
        capturedCompositeLayout ??
        layouts.get(Type.runtimeKey(fieldType)))
  if (!borrowed && !callable && valueLayout === undefined) {
    return {
      _tag: 'Unavailable',
      reason: `capture ${source.toLowerCase()} ${ordinal} has no value layout`,
    }
  }
  let size = valueLayout?.size ?? 0
  let alignment = valueLayout?.alignment ?? 1
  if (borrowed) {
    size = target.pointerSize
    alignment = target.pointerAlignment
  } else if (callable) {
    size = capturedCallableEnvironment?.size ?? 0
    alignment = capturedCallableEnvironment?.alignment ?? 1
  }
  let representation: 'Borrow' | 'Callable' | 'Value' = 'Value'
  if (borrowed) representation = 'Borrow'
  else if (callable) representation = 'Callable'
  return {
    _tag: 'Available',
    input: {
      value: {
        source,
        ordinal,
        access,
        type: fieldType,
        representation,
        ...(capturedEffectIdentity === undefined ? {} : { effectIdentity: capturedEffectIdentity }),
        ...(inputView === undefined ? {} : { inputView }),
        ...(capturedEffectEnvironment === undefined
          ? {}
          : {
              resolvedEffectIdentity: Instances.effectIdentity(
                capturedEffectEnvironment.instance,
                capturedEffectEnvironment.site,
              ),
            }),
        ...(capturedCallableIdentity === undefined
          ? {}
          : { callableIdentity: capturedCallableIdentity }),
        ...(realized?.providedRequirement === undefined
          ? {}
          : { providedRequirement: realized.providedRequirement }),
      },
      size,
      alignment,
    },
  }
})

const resolveCapturedEffect = Effect.fn('Layout.resolveCapturedEffect')(function* (
  state: EffectEnvironmentState,
  instance: Instances.Instance,
  source: EffectEnvironmentField['source'],
  ordinal: number,
  specialized: Type.Type,
  realized: ReturnType<typeof FieldRealization.effectEnvironmentOf>[number] | undefined,
) {
  yield* Effect.annotateCurrentSpan({ 'capture.source': source, 'capture.ordinal': ordinal })
  const { discovery, environments } = state
  const representedEffect =
    Type.isRepresented(specialized) &&
    Type.isEffect(specialized.contract) &&
    Type.isExactRepresentationArgument(specialized.representation.argument) &&
    Type.isEffectIdentityArgument(specialized.representation.argument.identity)
  const parameterEffectRepresentation =
    source === 'Parameter'
      ? Instances.parameterEffectRepresentationArgument(instance.function, instance.key, ordinal)
      : undefined
  const capturedEffectIdentity =
    realized?.effectIdentity ??
    ((Type.isEffect(specialized) || representedEffect) &&
    parameterEffectRepresentation !== undefined &&
    Type.isEffectIdentityArgument(parameterEffectRepresentation)
      ? parameterEffectRepresentation.identity
      : undefined)
  const capturedEffectInstance =
    capturedEffectIdentity === undefined
      ? undefined
      : effectInstanceByIdentity(discovery, capturedEffectIdentity)
  const capturedEffectEnvironment =
    capturedEffectIdentity === undefined
      ? undefined
      : firstPlannedEffectEnvironment(
          state,
          capturedEffectIdentity,
          capturedEffectInstance?.identity,
        )
  const capturedCompositeRepresentation =
    parameterEffectRepresentation !== undefined &&
    Type.isCompositeEffectRepresentationArgument(parameterEffectRepresentation)
      ? parameterEffectRepresentation
      : undefined
  const capturedCompositeEnvironments = capturedCompositeRepresentation?.alternatives.map(
    (alternative) =>
      Type.isEffectIdentityArgument(alternative.identity)
        ? effectEnvironmentByIdentity(environments, alternative.identity)
        : undefined,
  )
  const capturedCompositeLayout = capturedCompositeEnvironments?.every(
    (
      candidate,
    ): candidate is Extract<
      EffectEnvironment,
      {
        readonly _tag: 'EffectEnvironment'
      }
    > => candidate !== undefined,
  )
    ? compositeEnvironmentLayout(capturedCompositeEnvironments)
    : undefined
  return {
    capturedEffectIdentity,
    capturedEffectEnvironment,
    capturedCompositeRepresentation,
    capturedCompositeLayout,
  }
})

const planWitnessEffect = Effect.fn('Layout.planWitnessEffect')(function* (
  state: EffectEnvironmentState,
  instance: Instances.Instance,
  witness: WitnessEffect,
): Effect.fn.Return<void> {
  yield* Effect.annotateCurrentSpan({ 'operands.count': witness.contract.operands.length })

  const { layouts } = state

  const structuralEffect = Type.substitute(
    witness.expression.type,
    instance.substitution,
    instance.specialization.compatibility,
  )
  if (!Type.isEffect(structuralEffect)) return
  let unavailable: string | undefined
  const fieldInputs: Array<Packing.Input<EffectFieldDraft>> = []
  for (const [ordinal, operand] of witness.contract.operands.entries()) {
    if (operand.type._tag !== 'Resolved') {
      unavailable = `interface operand ${ordinal} has no concrete type`
      break
    }
    const fieldType = Type.substitute(
      operand.type.type,
      instance.substitution,
      instance.specialization.compatibility,
    )
    const valueLayout = layouts.get(Type.runtimeKey(fieldType))
    if (valueLayout === undefined) {
      unavailable = `interface operand ${ordinal} has no value layout`
      break
    }
    const access =
      Type.isReference(fieldType) || Type.isSlice(fieldType) ? fieldType.access : 'Take'
    fieldInputs.push({
      value: {
        source: 'Parameter',
        ordinal,
        access,
        type: fieldType,
        representation: 'Value',
      },
      size: valueLayout.size,
      alignment: valueLayout.alignment,
    })
  }
  let access: Type.CallableMode = 'Shared'
  if (fieldInputs.some((field) => field.value.access === 'Take')) {
    access = 'Take'
  } else if (fieldInputs.some((field) => field.value.access === 'Exclusive')) {
    access = 'Exclusive'
  }
  const effect = Type.effectWithRows(
    structuralEffect.success,
    structuralEffect.failureRow,
    structuralEffect,
    access,
    structuralEffect.requirementRow,
  )
  if (unavailable !== undefined) {
    recordEffectEnvironment(state, {
      _tag: 'UnavailableEffectEnvironment',
      instance: instance.key,
      site: witness.site,
      effect,
      reason: unavailable,
    })
    return
  }
  const packed = placeEffectFields(fieldInputs)
  recordEffectEnvironment(state, {
    _tag: 'EffectEnvironment',
    instance: instance.key,
    site: witness.site,
    effect,
    fields: packed.fields,
    size: packed.size,
    alignment: packed.alignment,
    tailPadding: packed.tailPadding,
  })
})

const placeEffectFields = (inputs: ReadonlyArray<Packing.Input<EffectFieldDraft>>) => {
  const packed = Packing.pack(inputs)
  return {
    ...packed,
    fields: packed.fields.map(({ value, offset, size, alignment, padding }) => ({
      ...value,
      offset,
      size,
      alignment,
      padding,
    })),
  }
}

const compositeEnvironmentLayout = (
  environments: ReadonlyArray<Extract<EffectEnvironment, { readonly _tag: 'EffectEnvironment' }>>,
) => {
  const payloadAlignment = environments.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.alignment),
    1,
  )
  const payloadSize = environments.reduce(
    (maximum, candidate) => Math.max(maximum, candidate.size),
    0,
  )
  const alignment = Math.max(4, payloadAlignment)
  const payloadOffset = alignUp(4, payloadAlignment)
  return {
    size: alignUp(payloadOffset + payloadSize, alignment),
    alignment,
  }
}

const environmentKey = (environment: EffectEnvironment): string =>
  `${Instances.effectIdentity(environment.instance, environment.site)}\u0000${Type.key(environment.effect)}`

const planCallableEnvironments = Effect.fn('Layout.planCallableEnvironments')(function* (
  target: Target.Target,
  entries: ReadonlyArray<Entry>,
  discovery: Instances.Discovery,
): Effect.fn.Return<ReadonlyArray<CallableEnvironment>> {
  const layouts = new Map(entries.map((entry) => [Type.runtimeKey(entry.type), entry] as const))
  const view = callableView(target)
  const planned = new Map<Instances.CallableInstance, CallableEnvironment>()
  const planning = new Set<Instances.CallableInstance>()
  const state: CallableEnvironmentState = { target, discovery, layouts, view, planned, planning }
  return yield* Effect.forEach(
    discovery.callables,
    Effect.fnUntraced(function* (callable) {
      return yield* planCallableEnvironment(state, callable)
    }),
  )
})

const planCallableEnvironment = Effect.fn('Layout.planCallableEnvironment')(function* (
  state: CallableEnvironmentState,
  callable: Instances.CallableInstance,
): Effect.fn.Return<CallableEnvironment> {
  const { target, discovery, layouts, view, planned, planning } = state
  const cached = planned.get(callable)
  if (cached !== undefined) return cached
  if (planning.has(callable)) {
    return {
      _tag: 'UnavailableCallableEnvironment',
      callable,
      reason: 'recursive callable capture environment has no finite value layout',
      view,
    }
  }
  planning.add(callable)
  const inputs: Array<
    Packing.Input<Omit<CallableEnvironmentField, 'offset' | 'size' | 'alignment' | 'padding'>>
  > = []
  for (const capture of callable.captures) {
    const callableCapture = capture.callableIdentity !== undefined
    const borrowed = !callableCapture && borrowedCapture(capture.access, capture.type)
    const callableIdentity = capture.callableIdentity
    const nestedCallable =
      callableIdentity?.environment === undefined
        ? undefined
        : discovery.callables.find((candidate) =>
            FieldRealization.matchesIdentity(callableIdentity, candidate),
          )
    const nestedEnvironment =
      nestedCallable === undefined
        ? undefined
        : yield* planCallableEnvironment(state, nestedCallable)
    if (
      callableIdentity?.environment !== undefined &&
      nestedEnvironment?._tag !== 'CallableEnvironment'
    ) {
      return unavailableCallableEnvironment(
        state,
        callable,
        `capture ${capture.ordinal} has no concrete callable environment`,
      )
    }
    const valueLayout =
      borrowed || callableCapture ? undefined : layouts.get(Type.runtimeKey(capture.type))
    if (!borrowed && !callableCapture && valueLayout === undefined) {
      return unavailableCallableEnvironment(
        state,
        callable,
        `capture ${capture.ordinal} has no concrete value layout`,
      )
    }
    let size = valueLayout?.size ?? 0
    let alignment = valueLayout?.alignment ?? 1
    if (borrowed) {
      size = target.pointerSize
      alignment = target.pointerAlignment
    } else if (callableCapture) {
      size = nestedEnvironment?._tag === 'CallableEnvironment' ? nestedEnvironment.size : 0
      alignment =
        nestedEnvironment?._tag === 'CallableEnvironment' ? nestedEnvironment.alignment : 1
    }
    let representation: 'Borrow' | 'Callable' | 'Value' = 'Value'
    if (borrowed) representation = 'Borrow'
    else if (callableCapture) representation = 'Callable'
    inputs.push({
      value: {
        ordinal: capture.ordinal,
        parameterOrdinal: capture.parameterOrdinal,
        access: capture.access,
        type: capture.type,
        representation,
        ...(callableIdentity === undefined ? {} : { callableIdentity }),
      },
      size,
      alignment,
    })
  }
  const packed = Packing.pack(inputs)
  const fields: ReadonlyArray<CallableEnvironmentField> = packed.fields.map((field) => ({
    ...field.value,
    ...field,
  }))
  const result: CallableEnvironment = {
    _tag: 'CallableEnvironment',
    callable,
    fields,
    size: packed.size,
    alignment: packed.alignment,
    tailPadding: packed.tailPadding,
    view,
  }
  planning.delete(callable)
  planned.set(callable, result)
  return result
})

const unavailableCallableEnvironment = (
  state: CallableEnvironmentState,
  callable: Instances.CallableInstance,
  reason: string,
): CallableEnvironment => {
  const { view, planning, planned } = state
  const result = {
    _tag: 'UnavailableCallableEnvironment' as const,
    callable,
    reason,
    view,
  }
  planning.delete(callable)
  planned.set(callable, result)
  return result
}

const callableView = (target: Target.Target): CallableView => ({
  codeOffset: 0,
  environmentOffset: target.pointerSize,
  size: target.pointerSize * 2,
  alignment: target.pointerAlignment,
  pointerBits: target.pointerSize === 4 ? 32 : 64,
})

/**
 * Whether one shared or exclusive capture stores a pointer to its source slot. Slice and
 * reference values are already stable borrow descriptors, so a capture of one stores the
 * descriptor inline: the loan it carries survives the short-lived slot it was read from, and the
 * hidden body receives the reference itself rather than a pointer to it.
 */
const borrowedCapture = (access: Type.CaptureAccess, type: Type.Type): boolean =>
  (access === 'Shared' || access === 'Exclusive') && !Type.isSlice(type) && !Type.isReference(type)

const sameExactOwner = (
  left: Instances.InstanceKey,
  right: Type.ExecutableSpecializationOwner,
): boolean =>
  left.declaration.module === right.declaration.module &&
  left.declaration.name === right.declaration.name &&
  left.typeArguments.length === right.typeArguments.length &&
  left.typeArguments.every((argument, ordinal) => {
    const expected = right.typeArguments.at(ordinal)
    return (
      expected !== undefined &&
      Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(expected)
    )
  }) &&
  left.staticArguments.length === right.staticArgumentKeys.length &&
  left.staticArguments.every(
    (argument, ordinal) => StaticValue.key(argument) === right.staticArgumentKeys.at(ordinal),
  )

const sameVisibleOwner = (
  left: Instances.InstanceKey,
  right: Type.ExecutableSpecializationOwner,
): boolean => {
  if (
    left.declaration.module !== right.declaration.module ||
    left.declaration.name !== right.declaration.name
  )
    return false
  const leftVisible = left.typeArguments.filter(
    (argument) => !Type.isHiddenExecutableArgument(argument),
  )
  const rightVisible = right.typeArguments.filter(
    (argument) => !Type.isHiddenExecutableArgument(argument),
  )
  return (
    left.staticArguments.length === right.staticArgumentKeys.length &&
    left.staticArguments.every(
      (argument, ordinal) => StaticValue.key(argument) === right.staticArgumentKeys.at(ordinal),
    ) &&
    leftVisible.length === rightVisible.length &&
    leftVisible.every((argument, ordinal) => {
      const expected = rightVisible.at(ordinal)
      return (
        expected !== undefined &&
        Type.runtimeGenericArgumentKey(argument) === Type.runtimeGenericArgumentKey(expected)
      )
    })
  )
}

const firstEffectInstances = new WeakMap<
  ReadonlyArray<Instances.EffectInstance>,
  ReadonlyMap<string, Instances.EffectInstance>
>()

/** The first discovered Effect instance with one exact identity, indexed once per discovery. */
const firstEffectInstance = (
  discovery: Instances.Discovery,
  identity: string,
): Instances.EffectInstance | undefined => {
  let index = firstEffectInstances.get(discovery.effects)
  if (index === undefined) {
    const built = new Map<string, Instances.EffectInstance>()
    for (const effect of discovery.effects)
      if (!built.has(effect.identity)) built.set(effect.identity, effect)
    firstEffectInstances.set(discovery.effects, built)
    index = built
  }
  return index.get(identity)
}

const effectInstanceByIdentity = (
  discovery: Instances.Discovery,
  identity: string,
): Instances.EffectInstance | undefined => {
  const exact = discovery.effects.filter((candidate) => candidate.identity === identity)
  if (exact.length === 1) return exact.at(0)
  const represented = discovery.effects.filter(
    (candidate) => candidate.representationIdentity === identity,
  )
  return represented.length === 1 ? represented.at(0) : undefined
}

/** Resolves one exact represented Effect environment without arbitrary owner fallback. */
export const effectEnvironmentByIdentity = (
  environments: ReadonlyArray<EffectEnvironment>,
  identity: Type.EffectIdentityArgument,
  requested?: Type.Effect,
):
  | Extract<
      EffectEnvironment,
      {
        readonly _tag: 'EffectEnvironment'
      }
    >
  | undefined => {
  const available = environments.filter(
    (
      candidate,
    ): candidate is Extract<
      EffectEnvironment,
      {
        readonly _tag: 'EffectEnvironment'
      }
    > => candidate._tag === 'EffectEnvironment',
  )
  const concrete = available.filter(
    (candidate) =>
      Instances.effectIdentity(candidate.instance, candidate.site) === identity.identity ||
      candidate.successEffectIdentity === identity.identity,
  )
  const semantic =
    requested === undefined
      ? undefined
      : concrete.find((candidate) => Type.equals(candidate.effect, requested))
  if (semantic !== undefined) return semantic
  // Semantic Effect variants at one physical site share this layout. Callers that require the
  // contract select it separately; this helper owns only the capture placement.
  if (concrete.length > 0) return concrete.at(0)
  const represented = available.filter(
    (candidate) => Tir.effectRepresentationIdentity(candidate.site) === identity.identity,
  )
  const owner = identity.owner
  if (owner === undefined) return represented.length === 1 ? represented.at(0) : undefined
  const exact = represented.filter((candidate) => sameExactOwner(candidate.instance, owner))
  if (exact.length > 0) return exact.at(0)
  const visible = represented.filter((candidate) => sameVisibleOwner(candidate.instance, owner))
  return visible.length === 1 ? visible.at(0) : undefined
}

// Calling-shape planning

interface ShapeContext {
  readonly target: Target.Target
  readonly entries: ReadonlyMap<string, Entry>
  readonly effectEnvironments: ReadonlyArray<EffectEnvironment>
  readonly callableEnvironments: ReadonlyArray<CallableEnvironment>
  readonly active: ReadonlySet<string>
}

export const planCallingShapes = Effect.fn('Layout.planCallingShapes')(function* (
  target: Target.Target,
  entries: ReadonlyArray<Entry>,
  types: ReadonlyArray<DeclarationFacts.SemanticType> = entries.map((entry) => entry.type),
  effectEnvironments: ReadonlyArray<EffectEnvironment> = [],
  callableEnvironments: ReadonlyArray<CallableEnvironment> = [],
): Effect.fn.Return<ReadonlyArray<CallingShape>> {
  yield* Effect.annotateCurrentSpan({ 'types.count': types.length })

  const byType = new Map(entries.map((candidate) => [Type.runtimeKey(candidate.type), candidate]))
  return yield* Effect.forEach(
    types,
    Effect.fnUntraced(function* (type) {
      return yield* planCallingShape(target, type, byType, effectEnvironments, callableEnvironments)
    }),
  )
})

const planCallingShape = Effect.fn('Layout.planCallingShape')(function* (
  target: Target.Target,
  type: DeclarationFacts.SemanticType,
  entries: ReadonlyMap<string, Entry>,
  effectEnvironments: ReadonlyArray<EffectEnvironment>,
  callableEnvironments: ReadonlyArray<CallableEnvironment>,
): Effect.fn.Return<CallingShape> {
  yield* Effect.annotateCurrentSpan({
    type: Type.encode(type),
    'type.kind': typeof type === 'string' ? 'Builtin' : type._tag,
  })
  const tree = yield* shapeNode(type, {
    target,
    entries,
    effectEnvironments,
    callableEnvironments,
    active: new Set<string>(),
  })
  let materialized: ReadonlyArray<CallingLane> | undefined
  return {
    _tag: 'CallingShape' as const,
    type,
    tree,
    laneCount: tree.laneCount,
    get lanes(): ReadonlyArray<CallingLane> {
      materialized ??= materializeLanes(tree)
      return materialized
    },
  }
})

const shapeNode = Effect.fnUntraced(function* (
  type: DeclarationFacts.SemanticType,
  context: ShapeContext,
): Effect.fn.Return<CallingShapeNode> {
  const { target, entries } = context
  if (Type.isBuiltin(type)) {
    return { _tag: 'ScalarShape', type, laneCount: 1 }
  }
  const enumRepresentation = entries.get(Type.runtimeKey(type))?.representation
  if (Type.isNominal(type) && enumRepresentation?._tag === 'ScalarEnum') {
    return {
      _tag: 'ScalarEnumShape',
      type,
      lane: enumRepresentation.scalar,
      laneCount: 1,
    }
  }
  if (Type.isString(type)) {
    return {
      _tag: 'StringShape',
      type,
      storage: {
        type: {
          _tag: 'Address',
          element: type,
          bits: target.pointerSize === 4 ? 32 : 64,
        },
        lane: 0,
      },
      byteLength: { type: 'usize', lane: 1 },
      laneCount: 2,
    }
  }
  if (Type.isNever(type)) {
    return { _tag: 'EmptyShape', type, laneCount: 0 }
  }
  if (Type.isParameter(type)) {
    throw new RangeError(`open generic parameter ${Type.encode(type)} has no calling shape`)
  }
  if (Type.isSlice(type)) {
    return {
      _tag: 'SliceShape',
      type,
      address: {
        type: {
          _tag: 'Address',
          element: type.element,
          bits: target.pointerSize === 4 ? 32 : 64,
        },
        lane: 0,
      },
      length: { type: 'usize', lane: 1 },
      laneCount: 2,
    }
  }
  if (Type.isReference(type)) {
    return {
      _tag: 'ReferenceShape',
      type,
      address: {
        type: {
          _tag: 'Address',
          element: type.target,
          bits: target.pointerSize === 4 ? 32 : 64,
        },
        lane: 0,
      },
      laneCount: 1,
    }
  }
  if (Type.isSharedCore(type) || Type.isExecution(type) || Type.isExecutionRef(type)) {
    return {
      _tag: 'AddressShape',
      type,
      address: {
        type: {
          _tag: 'Address',
          element: type,
          bits: target.pointerSize === 4 ? 32 : 64,
        },
        lane: 0,
      },
      laneCount: 1,
    }
  }
  if (Type.isPointer(type)) {
    return {
      _tag: 'AddressShape',
      type,
      address: {
        type: {
          _tag: 'Address',
          element: type.pointee,
          bits: target.pointerSize === 4 ? 32 : 64,
        },
        lane: 0,
      },
      laneCount: 1,
    }
  }
  if (Type.isForeignFunction(type)) return borrowedShape(context, type)
  if (Type.isCallable(type)) {
    throw new RangeError(
      `callable ${Type.encode(type)} needs a hidden concrete identity before calling-shape planning`,
    )
  }
  if (Type.isRepresented(type)) {
    return yield* representedShape(type, context)
  }
  const candidate = entries.get(Type.runtimeKey(type))
  if (Type.isNominal(type) && candidate?.representation._tag === 'NominalUnion') {
    return yield* nominalUnionShape(type, context, candidate.representation)
  }
  if (Type.isFixedArray(type)) {
    const element = yield* shapeNode(type.element, context)
    const laneCount = element.laneCount * type.length
    if (!Number.isSafeInteger(laneCount)) {
      throw new RangeError(`Calling shape lane count overflows for ${Type.encode(type)}`)
    }
    return {
      _tag: 'RepeatedShape',
      type,
      length: type.length,
      element,
      laneCount,
    }
  }
  if (Type.isUnion(type)) {
    return yield* unionShape(type, context)
  }
  if (Type.isEffect(type)) {
    return yield* outcomeShape(type, context)
  }
  const fields =
    candidate?.representation._tag === 'Aggregate'
      ? yield* Effect.forEach(
          candidate.representation.fields,
          Effect.fnUntraced(function* (field) {
            return { field: field.id, shape: yield* shapeNode(field.type, context) }
          }),
        )
      : []
  return {
    _tag: 'ProductShape',
    type,
    fields: fields,
    laneCount: fields.reduce<number>((total, field) => total + field.shape.laneCount, 0),
  }
})

const representedShape = Effect.fn('Layout.representedShape')(function* (
  type: Type.Represented,
  context: ShapeContext,
): Effect.fn.Return<CallingShapeNode> {
  const { target, entries } = context
  const argument = type.representation.argument
  if (Type.isEffect(type.contract) && Type.isCompositeEffectRepresentationArgument(argument)) {
    const alternatives = yield* Effect.forEach(
      argument.alternatives,
      Effect.fnUntraced(function* (alternative) {
        if (!Type.isEffectIdentityArgument(alternative.identity))
          throw new RangeError('Effect composite retained a non-Effect alternative')
        const identity = alternative.identity
        const environment = effectEnvironmentByIdentity(context.effectEnvironments, identity)
        if (environment === undefined)
          throw new RangeError('Effect composite alternative has no concrete environment')
        const fields = yield* Effect.forEach(
          environment.fields,
          Effect.fnUntraced(function* (field) {
            return {
              capture: field.ordinal,
              shape: yield* executableEnvironmentFieldShape(context, field),
            }
          }),
        )
        return {
          _tag: 'EffectEnvironmentShape' as const,
          type: environment.effect,
          fields: fields,
          laneCount: fields.reduce<number>((total, field) => total + field.shape.laneCount, 0),
        }
      }),
    )
    const alternativeLanes = alternatives.map((alternative) => materializeLanes(alternative))
    const payloadTypes = yield* unifyPayloadTypes(alternatives, target)
    return {
      _tag: 'EffectCompositeShape',
      type,
      alternativeLaneCounts: alternativeLanes.map((lanes) => lanes.length),
      payloadTypes,
      laneCount: payloadTypes.length + 1,
    }
  }
  const entry = entries.get(Type.runtimeKey(type))
  const executable = entry?.executable
  const stored = entry?.representation
  const storedCallable = stored?._tag === 'CallableEnvironment' ? stored : undefined
  const storedEffect = stored?._tag === 'StoredEffectEnvironment' ? stored : undefined
  if (executable === undefined && storedCallable === undefined && storedEffect === undefined) {
    throw new RangeError(
      `represented executable ${Type.encode(type)} is unavailable to calling-shape planning`,
    )
  }
  const kind = executable?._tag ?? (storedCallable === undefined ? 'Effect' : 'Callable')
  let fields: ReadonlyArray<{
    readonly capture: number
    readonly shape: CallingShapeNode
  }>
  if (executable !== undefined) {
    fields = yield* Effect.forEach(
      executable.fields,
      Effect.fnUntraced(function* (field) {
        const shape =
          executable._tag === 'Callable' && field.representation !== 'Borrow'
            ? yield* shapeNode(field.type, context)
            : yield* executableEnvironmentFieldShape(context, field)
        return { capture: field.capture, shape }
      }),
    )
  } else if (storedCallable !== undefined) {
    fields = yield* Effect.forEach(
      storedCallable.fields,
      Effect.fnUntraced(function* (field) {
        return {
          capture: field.ordinal,
          shape: yield* executableEnvironmentFieldShape(context, field),
        }
      }),
    )
  } else {
    fields = yield* Effect.forEach(
      storedEffect?.fields ?? [],
      Effect.fnUntraced(function* (field) {
        return {
          capture: field.capture,
          shape: yield* executableEnvironmentFieldShape(context, field),
        }
      }),
    )
  }
  return {
    _tag:
      kind === 'Callable'
        ? ('CallableEnvironmentShape' as const)
        : ('EffectEnvironmentShape' as const),
    type,
    fields: fields,
    laneCount: fields.reduce<number>((total, field) => total + field.shape.laneCount, 0),
  }
})

const nominalUnionShape = Effect.fn('Layout.nominalUnionShape')(function* (
  type: Type.Nominal,
  context: ShapeContext,
  representation: Extract<
    Representation,
    {
      readonly _tag: 'NominalUnion'
    }
  >,
): Effect.fn.Return<CallingShapeNode> {
  const { target } = context
  const variants = yield* Effect.forEach(
    representation.variants,
    Effect.fnUntraced(function* (variant) {
      const fields = yield* Effect.forEach(
        variant.fields,
        Effect.fnUntraced(function* (field) {
          return {
            field: field.id,
            shape: yield* shapeNode(field.type, context),
          }
        }),
      )
      const shape: CallingShapeNode = {
        _tag: 'ProductShape',
        type,
        fields,
        laneCount: fields.reduce<number>((total, field) => total + field.shape.laneCount, 0),
      }
      return {
        variant: variant.variant,
        ordinal: variant.ordinal,
        shape,
        payloadSlots: Array.from({ length: shape.laneCount }, (_, slot) => slot),
      }
    }),
  )
  const payloadLaneCount = variants.reduce(
    (maximum, variant) => Math.max(maximum, variant.shape.laneCount),
    0,
  )
  return {
    _tag: 'NominalUnionShape',
    type,
    tag: { type: 'i32', lane: 0 },
    payloadLaneCount,
    payloadTypes: yield* unifyPayloadTypes(
      variants.map((variant) => variant.shape),
      target,
    ),
    zeroFill: true,
    variants,
    laneCount: 1 + payloadLaneCount,
  }
})

const unionShape = Effect.fn('Layout.unionShape')(function* (
  type: Type.StructuralUnion,
  context: ShapeContext,
): Effect.fn.Return<CallingShapeNode> {
  const { target } = context
  const members = yield* Effect.forEach(
    type.members,
    Effect.fnUntraced(function* (member, ordinal) {
      const shape = yield* shapeNode(member, context)
      return {
        member,
        ordinal,
        shape,
        payloadSlots: Array.from({ length: shape.laneCount }, (_, slot) => slot),
      }
    }),
  )
  const payloadLaneCount = members.reduce(
    (maximum, member) => Math.max(maximum, member.shape.laneCount),
    0,
  )
  const payloadTypes = yield* unifyPayloadTypes(
    members.map((member) => member.shape),
    target,
  )
  return {
    _tag: 'SumShape',
    type,
    tag: { type: 'i32', lane: 0 },
    payloadLaneCount,
    payloadTypes,
    zeroFill: true,
    members,
    laneCount: 1 + payloadLaneCount,
  }
})

const outcomeShape = Effect.fn('Layout.outcomeShape')(function* (
  type: Type.Effect,
  context: ShapeContext,
): Effect.fn.Return<CallingShapeNode> {
  const { target } = context
  const success = yield* shapeNode(type.success, context)
  const failures = yield* Effect.forEach(
    Type.failureMembers(type),
    Effect.fnUntraced(function* (failure, index) {
      return {
        type: failure,
        tag: index + 1,
        shape: yield* shapeNode(failure, context),
      }
    }),
  )
  const variants = [success, ...failures.map((failure) => failure.shape)]
  const payloadLaneCount = variants.reduce(
    (maximum, variant) => Math.max(maximum, variant.laneCount),
    0,
  )
  const payloadTypes = yield* unifyPayloadTypes(variants, target)
  return {
    _tag: 'OutcomeShape',
    type,
    success,
    failures: failures,
    payloadLaneCount,
    payloadTypes,
    laneCount: 1 + payloadLaneCount,
  }
})

const executableEnvironmentFieldShape = Effect.fnUntraced(function* (
  context: ShapeContext,
  field: Pick<
    EffectEnvironmentField,
    'representation' | 'type' | 'callableIdentity' | 'effectIdentity'
  >,
): Effect.fn.Return<CallingShapeNode> {
  if (field.representation === 'Borrow') return borrowedShape(context, field.type)
  if (field.callableIdentity !== undefined) {
    const identity = field.callableIdentity
    if (identity.environment === undefined) {
      return {
        _tag: 'CallableEnvironmentShape',
        type: field.type,
        fields: [],
        laneCount: 0,
      }
    }
    const environment = environmentMatching(context.callableEnvironments, identity)
    if (environment === undefined)
      throw new RangeError(
        `callable environment ${Type.runtimeGenericArgumentKey(identity)} is unavailable to calling-shape planning`,
      )
    const nested = withActiveShape(context, `callable:${Type.runtimeGenericArgumentKey(identity)}`)
    const fields = yield* Effect.forEach(
      environment.fields,
      Effect.fnUntraced(function* (capture) {
        return {
          capture: capture.ordinal,
          shape: yield* executableEnvironmentFieldShape(nested, capture),
        }
      }),
    )
    return {
      _tag: 'CallableEnvironmentShape',
      type: field.type,
      fields: fields,
      laneCount: fields.reduce((total, capture) => total + capture.shape.laneCount, 0),
    }
  }
  if (field.effectIdentity !== undefined) {
    const environment = context.effectEnvironments.find(
      (
        candidate,
      ): candidate is Extract<
        EffectEnvironment,
        {
          readonly _tag: 'EffectEnvironment'
        }
      > =>
        candidate._tag === 'EffectEnvironment' &&
        (Instances.effectIdentity(candidate.instance, candidate.site) === field.effectIdentity ||
          candidate.successEffectIdentity === field.effectIdentity),
    )
    if (environment === undefined)
      throw new RangeError(
        `Effect environment ${field.effectIdentity} is unavailable to calling-shape planning`,
      )
    const nested = withActiveShape(context, `effect:${field.effectIdentity}`)
    const fields = yield* Effect.forEach(
      environment.fields,
      Effect.fnUntraced(function* (capture) {
        return {
          capture: capture.ordinal,
          shape: yield* executableEnvironmentFieldShape(nested, capture),
        }
      }),
    )
    return {
      _tag: 'EffectEnvironmentShape',
      type: field.type,
      fields: fields,
      laneCount: fields.reduce((total, capture) => total + capture.shape.laneCount, 0),
    }
  }
  return yield* shapeNode(field.type, context)
})

const withActiveShape = (context: ShapeContext, identity: string): ShapeContext => {
  if (context.active.has(identity))
    throw new RangeError(`recursive executable environment ${identity} has no calling shape`)
  return { ...context, active: new Set([...context.active, identity]) }
}

const borrowedShape = (
  context: ShapeContext,
  type: DeclarationFacts.SemanticType,
): Extract<
  CallingShapeNode,
  {
    readonly _tag: 'AddressShape'
  }
> => ({
  _tag: 'AddressShape',
  type,
  address: {
    type: {
      _tag: 'Address',
      element: type,
      bits: context.target.pointerSize === 4 ? 32 : 64,
    },
    lane: 0,
  },
  laneCount: 1,
})

/** Chooses one deterministic scalar carrier for each payload lane across tagged variants. */
export const unifyPayloadTypes = Effect.fn('Layout.unifyPayloadTypes')(function* (
  variants: ReadonlyArray<CallingShapeNode>,
  target: Target.Target,
): Effect.fn.Return<ReadonlyArray<Type.Builtin>> {
  const payloadLaneCount = variants.reduce(
    (maximum, variant) => Math.max(maximum, variant.laneCount),
    0,
  )
  yield* Effect.annotateCurrentSpan({
    'variants.count': variants.length,
    'payload.lanes': payloadLaneCount,
  })
  const typesByVariant = variants.map(payloadScalarTypes)
  return Array.from({ length: payloadLaneCount }, (_, slot): Type.Builtin => {
    const candidates = typesByVariant.flatMap((types) => {
      const type = types.at(slot)
      return type === undefined ? [] : [type]
    })
    return (
      candidates
        .sort((left, right) => {
          const leftScalar = Scalar.find(left)
          const rightScalar = Scalar.find(right)
          const pointerBits = target.pointerSize === 4 ? 32 : 64
          const leftBits = leftScalar === undefined ? 32 : Scalar.bits(leftScalar, pointerBits)
          const rightBits = rightScalar === undefined ? 32 : Scalar.bits(rightScalar, pointerBits)
          return rightBits - leftBits || compareRuntimeTypes(left, right)
        })
        .at(0) ?? 'i32'
    )
  })
})

/**
 * Projects carrier types without allocating the selector paths needed by emitted values.
 * Kept pure inside traced unification: the 1,527-lane captured program spent ~2.5 s
 * repeatedly materializing full lanes, versus <1 ms projecting scalar types once.
 */
const payloadScalarTypes = (node: CallingShapeNode): ReadonlyArray<Type.Builtin> => {
  switch (node._tag) {
    case 'EmptyShape':
      return []
    case 'ScalarShape':
      return [node.type]
    case 'ScalarEnumShape':
      return [node.lane]
    case 'SliceShape':
    case 'StringShape':
      return ['usize', 'usize']
    case 'ReferenceShape':
    case 'AddressShape':
      return ['usize']
    case 'ProductShape':
    case 'CallableEnvironmentShape':
    case 'EffectEnvironmentShape':
      return node.fields.flatMap((field) => payloadScalarTypes(field.shape))
    case 'SumShape':
    case 'NominalUnionShape':
    case 'OutcomeShape':
      return [
        'i32',
        ...Array.from(
          { length: node.payloadLaneCount },
          (_, slot) => node.payloadTypes.at(slot) ?? 'i32',
        ),
      ]
    case 'EffectCompositeShape':
      return [
        'i32',
        ...node.payloadTypes.map((type) => (typeof type === 'string' ? type : 'usize')),
      ]
    case 'RepeatedShape': {
      if (node.length === 0) return []
      const element = payloadScalarTypes(node.element)
      return Array.from({ length: node.length }, () => element).flat()
    }
  }
}

// Lane expansion backs the lazy synchronous CallingShape.lanes getter. Keep this
// per-lane loop pure; its planning callers provide the Effect tracing boundary.
const materializeLanes = (
  node: CallingShapeNode,
  path: ReadonlyArray<Selector> = [],
): ReadonlyArray<CallingLane> => {
  if (node._tag === 'EmptyShape') return []
  if (node._tag === 'ScalarShape') {
    return [{ _tag: 'CallingLane', path, type: node.type }]
  }
  if (node._tag === 'ScalarEnumShape') {
    return [{ _tag: 'CallingLane', path, type: node.lane }]
  }
  if (node._tag === 'SliceShape') {
    return [
      {
        _tag: 'CallingLane',
        path: [...path, { _tag: 'SliceAddressSelector' }],
        type: node.address.type,
      },
      {
        _tag: 'CallingLane',
        path: [...path, { _tag: 'SliceLengthSelector' }],
        type: 'usize',
      },
    ]
  }
  if (node._tag === 'StringShape') {
    return [
      {
        _tag: 'CallingLane',
        path: [...path, { _tag: 'StringStorageSelector' }],
        type: node.storage.type,
      },
      {
        _tag: 'CallingLane',
        path: [...path, { _tag: 'StringByteLengthSelector' }],
        type: 'usize',
      },
    ]
  }
  if (node._tag === 'ReferenceShape' || node._tag === 'AddressShape') {
    return [
      {
        _tag: 'CallingLane',
        path: [...path, { _tag: 'ReferenceAddressSelector' }],
        type: node.address.type,
      },
    ]
  }
  if (node._tag === 'ProductShape') {
    return node.fields.flatMap((field) => materializeLanes(field.shape, [...path, field.field]))
  }
  if (node._tag === 'CallableEnvironmentShape' || node._tag === 'EffectEnvironmentShape') {
    const selectorTag =
      node._tag === 'CallableEnvironmentShape'
        ? ('CallableCaptureSelector' as const)
        : ('EffectCaptureSelector' as const)
    return node.fields.flatMap((field) =>
      materializeLanes(field.shape, [...path, { _tag: selectorTag, ordinal: field.capture }]),
    )
  }
  if (node._tag === 'SumShape') {
    return [
      {
        _tag: 'CallingLane' as const,
        path: [...path, { _tag: 'UnionTagSelector' as const }],
        type: 'i32' as const,
      },
      ...Array.from({ length: node.payloadLaneCount }, (_, slot) => ({
        _tag: 'CallingLane' as const,
        path: [...path, { _tag: 'UnionPayloadSelector' as const, slot }],
        type: node.payloadTypes.at(slot) ?? ('i32' as const),
      })),
    ]
  }
  if (node._tag === 'NominalUnionShape') {
    return [
      {
        _tag: 'CallingLane' as const,
        path: [...path, { _tag: 'NominalUnionTagSelector' as const }],
        type: 'i32' as const,
      },
      ...Array.from({ length: node.payloadLaneCount }, (_, slot) => ({
        _tag: 'CallingLane' as const,
        path: [...path, { _tag: 'NominalUnionPayloadSelector' as const, slot }],
        type: node.payloadTypes.at(slot) ?? ('i32' as const),
      })),
    ]
  }
  if (node._tag === 'OutcomeShape') {
    return [
      {
        _tag: 'CallingLane' as const,
        path: [...path, { _tag: 'UnionTagSelector' as const }],
        type: 'i32' as const,
      },
      ...Array.from({ length: node.payloadLaneCount }, (_, slot) => ({
        _tag: 'CallingLane' as const,
        path: [...path, { _tag: 'UnionPayloadSelector' as const, slot }],
        type: node.payloadTypes.at(slot) ?? ('i32' as const),
      })),
    ]
  }
  if (node._tag === 'EffectCompositeShape') {
    return [
      {
        _tag: 'CallingLane' as const,
        path: [...path, { _tag: 'UnionTagSelector' as const }],
        type: 'i32' as const,
      },
      ...node.payloadTypes.map((type, slot) => ({
        _tag: 'CallingLane' as const,
        path: [...path, { _tag: 'UnionPayloadSelector' as const, slot }],
        type,
      })),
    ]
  }
  const lanes: Array<CallingLane> = []
  for (let index = 0; index < node.length; index += 1) {
    const selector: Selector = { _tag: 'ElementSelector', index }
    lanes.push(...materializeLanes(node.element, [...path, selector]))
  }
  return lanes
}

// Layout queries and lane projections

/**
 * Both lookups run once per lowered operation. Their physical indexes erase lifetime proof
 * arguments while retaining the original semantic types on entries for inspection.
 */
const entryIndexCache = new WeakMap<ReadonlyArray<Entry>, Map<string, Entry>>()

const callingShapeIndexCache = new WeakMap<ReadonlyArray<CallingShape>, Map<string, CallingShape>>()

const indexByTypeKey = <
  A extends {
    readonly type: DeclarationFacts.SemanticType
  },
>(
  cache: WeakMap<ReadonlyArray<A>, Map<string, A>>,
  values: ReadonlyArray<A>,
): Map<string, A> => {
  let index = cache.get(values)
  if (index === undefined) {
    index = new Map()
    for (const value of values) {
      const key = Type.runtimeKey(value.type)
      if (!index.has(key)) index.set(key, value)
    }
    cache.set(values, index)
  }
  return index
}

/** Looks up one canonical runtime-plan entry. */
export const entry = (self: Plan, type: DeclarationFacts.SemanticType): Entry | undefined =>
  indexByTypeKey(entryIndexCache, self.entries).get(Type.runtimeKey(type))

/** Looks up one compiler-owned calling shape by logical type. */
export const callingShape = (
  self: Plan,
  type: DeclarationFacts.SemanticType,
): CallingShape | undefined => {
  const physical = indexByTypeKey(callingShapeIndexCache, self.callingShapes).get(
    Type.runtimeKey(type),
  )
  if (physical === undefined || Type.equals(physical.type, type)) return physical
  return {
    _tag: 'CallingShape',
    type,
    tree: physical.tree,
    laneCount: physical.laneCount,
    get lanes(): ReadonlyArray<CallingLane> {
      return physical.lanes
    },
  }
}

// Runtime planning resolves every referenced type through the catalog; index its entries once
// instead of scanning them per lookup. The first entry for a runtime key wins, as before.
const catalogEntryIndexCache = new WeakMap<ReadonlyArray<CatalogEntry>, Map<string, CatalogEntry>>()

/** Looks up one available or unavailable nominal catalog entry. */
export const catalogEntry = (
  self: Catalog,
  type: DeclarationFacts.SemanticType,
): CatalogEntry | undefined =>
  indexByTypeKey(catalogEntryIndexCache, self.entries).get(Type.runtimeKey(type))

/**
 * Plans the bit-exact movement of one nominal failure payload between two tagged carriers.
 *
 * Carrier slots are deliberately not treated as the member's value type: a row containing an
 * `f64` member can make the slot wider than an `i32` member which occupies that same slot. The
 * member lane is therefore retained as the normalization point between the source and target
 * carriers, and lanes outside this member's shape are omitted so consumers zero-fill them.
 */
export const failurePayloadRepacking = (
  self: Plan,
  sourceType: DeclarationFacts.SemanticType,
  sourceTag: number,
  targetType: Type.Effect,
  targetTag: number,
): FailurePayloadRepacking | undefined => {
  const sourceMember = Type.failureCarrierMember(
    sourceType,
    sourceTag,
    Type.isEffect(sourceType) ? 'OneBased' : 'ZeroBased',
  )
  const targetMember = Type.failureCarrierMember(targetType, targetTag, 'OneBased')
  if (sourceMember === undefined || targetMember === undefined) return undefined
  const sourceShape = callingShape(self, sourceType)
  const targetShape = callingShape(self, targetType)
  if (sourceShape === undefined || targetShape?.tree._tag !== 'OutcomeShape') return undefined
  if (!(Type.runtimeKey(sourceMember) === Type.runtimeKey(targetMember))) return undefined
  const memberShape = callingShape(self, sourceMember)
  if (memberShape === undefined) return undefined
  const sourceOffset = Type.isNominal(sourceType) ? 0 : 1
  const targetPayloadLanes = targetShape.lanes.slice(1)
  const lanes: Array<FailurePayloadLane> = []
  for (const [ordinal, member] of memberShape.lanes.entries()) {
    const source = sourceShape.lanes.at(sourceOffset + ordinal)
    const target = targetPayloadLanes.at(ordinal)
    if (source === undefined || target === undefined) return undefined
    lanes.push({
      sourceOrdinal: sourceOffset + ordinal,
      source,
      member,
      targetOrdinal: ordinal,
      target,
    })
  }
  return {
    member: sourceMember,
    targetPayloadLanes,
    lanes: lanes,
  }
}

/** A callable environment the plan could place. */
export type AvailableCallableEnvironment = Extract<
  CallableEnvironment,
  { readonly _tag: 'CallableEnvironment' }
>

type AvailableEffectEnvironment = Extract<EffectEnvironment, { readonly _tag: 'EffectEnvironment' }>

// Published plans never mutate their environment arrays. MIR/backend lane queries repeatedly
// resolve the same identities; whole-array Effect scans consumed 4% of a cold selfhost profile window.
// Key the indexes by the arrays so a derived plan replacing either frontier gets a fresh index.
// Callable buckets keep every available environment in plan order, so a lookup that refines the
// bucket with the caller's own predicate selects exactly what a whole-array scan would.
interface CallableEnvironmentIndex {
  readonly byIdentity: ReadonlyMap<string, ReadonlyArray<AvailableCallableEnvironment>>
  readonly byOwner: ReadonlyMap<string, ReadonlyArray<AvailableCallableEnvironment>>
}

const callableEnvironmentIndexes = new WeakMap<
  ReadonlyArray<CallableEnvironment>,
  CallableEnvironmentIndex
>()

const effectEnvironmentIndexes = new WeakMap<
  ReadonlyArray<EffectEnvironment>,
  ReadonlyMap<string, AvailableEffectEnvironment>
>()

const appendBucket = <A>(buckets: Map<string, Array<A>>, key: string, value: A): void => {
  const bucket = buckets.get(key)
  if (bucket === undefined) buckets.set(key, [value])
  else bucket.push(value)
}

const callableEnvironmentIndex = (
  environments: ReadonlyArray<CallableEnvironment>,
): CallableEnvironmentIndex => {
  const cached = callableEnvironmentIndexes.get(environments)
  if (cached !== undefined) return cached
  const byIdentity = new Map<string, Array<AvailableCallableEnvironment>>()
  const byOwner = new Map<string, Array<AvailableCallableEnvironment>>()
  for (const candidate of environments) {
    if (candidate._tag !== 'CallableEnvironment') continue
    appendBucket(
      byIdentity,
      Type.runtimeCallableEnvironmentIdentityKey(
        Instances.callableEnvironmentIdentity(candidate.callable),
      ),
      candidate,
    )
    appendBucket(byOwner, Instances.keyText(candidate.callable.owner), candidate)
  }
  const built: CallableEnvironmentIndex = { byIdentity, byOwner }
  callableEnvironmentIndexes.set(environments, built)
  return built
}

const environmentsWithIdentity = (
  environments: ReadonlyArray<CallableEnvironment>,
  identity: Type.CallableEnvironmentIdentity,
): ReadonlyArray<AvailableCallableEnvironment> =>
  callableEnvironmentIndex(environments).byIdentity.get(
    Type.runtimeCallableEnvironmentIdentityKey(identity),
  ) ?? []

const environmentMatching = (
  environments: ReadonlyArray<CallableEnvironment>,
  identity: Type.CallableIdentityArgument,
): AvailableCallableEnvironment | undefined =>
  identity.environment === undefined
    ? undefined
    : environmentsWithIdentity(environments, identity.environment).find((candidate) =>
        FieldRealization.matchesIdentity(identity, candidate.callable),
      )

/** Resolves one canonical callable-environment identity in this target's runtime plan. */
export const callableEnvironmentByIdentity = (
  self: Plan,
  identity: Type.CallableEnvironmentIdentity,
): AvailableCallableEnvironment | undefined =>
  environmentsWithIdentity(self.callableEnvironments, identity).at(0)

/** Every available environment with one canonical runtime identity, in plan order. */
export const callableEnvironmentsByIdentity = (
  self: Plan,
  identity: Type.CallableEnvironmentIdentity,
): ReadonlyArray<AvailableCallableEnvironment> =>
  environmentsWithIdentity(self.callableEnvironments, identity)

/** Every available environment whose callable is owned by one specialization, in plan order. */
export const callableEnvironmentsByOwner = (
  self: Plan,
  owner: Instances.InstanceKey,
): ReadonlyArray<AvailableCallableEnvironment> =>
  callableEnvironmentIndex(self.callableEnvironments).byOwner.get(Instances.keyText(owner)) ?? []

/** The first planned environment matching a retained callable identity's target and arguments. */
export const callableEnvironmentMatching = (
  self: Plan,
  identity: Type.CallableIdentityArgument,
): AvailableCallableEnvironment | undefined =>
  environmentMatching(self.callableEnvironments, identity)

/** Resolves the Effect environment a capture field's identity names, including success carriers. */
export const effectEnvironmentByFieldIdentity = (
  self: Plan,
  identity: string,
):
  | Extract<
      EffectEnvironment,
      {
        readonly _tag: 'EffectEnvironment'
      }
    >
  | undefined => {
  let index = effectEnvironmentIndexes.get(self.effectEnvironments)
  if (index === undefined) {
    const built = new Map<string, AvailableEffectEnvironment>()
    for (const candidate of self.effectEnvironments) {
      if (candidate._tag !== 'EffectEnvironment') continue
      const key = Instances.effectIdentity(candidate.instance, candidate.site)
      if (!built.has(key)) built.set(key, candidate)
      const success = candidate.successEffectIdentity
      if (success !== undefined && !built.has(success)) built.set(success, candidate)
    }
    effectEnvironmentIndexes.set(self.effectEnvironments, built)
    index = built
  }
  return index.get(identity)
}

/** Materializes the ABI lanes of one Effect environment capture field. */
export const effectFieldLanes = (
  self: Plan,
  field: EffectEnvironmentField,
): ReadonlyArray<CallingLane> => {
  if (field.representation === 'Borrow') {
    return [
      {
        _tag: 'CallingLane' as const,
        path: [],
        type: {
          _tag: 'Address' as const,
          element: field.type,
          bits: self.target.pointerSize === 4 ? 32 : 64,
        },
      },
    ]
  }
  if (field.callableIdentity !== undefined) {
    const captured =
      field.callableIdentity.environment === undefined
        ? undefined
        : callableEnvironmentByIdentity(self, field.callableIdentity.environment)
    return captured?._tag === 'CallableEnvironment' ? callableEnvironmentLanes(self, captured) : []
  }
  if (field.effectIdentity !== undefined) {
    const captured = effectEnvironmentByFieldIdentity(self, field.effectIdentity)
    return captured !== undefined ? effectEnvironmentLanes(self, captured) : []
  }
  return callingShape(self, field.type)?.lanes ?? []
}

/** One scalar lane's storage root and byte base within an executable environment. */
export interface EnvironmentLanePlacement {
  readonly lane: CallingLane
  readonly byteOffset: number
  /** The ordinary value whose selector path supplies the remainder of the byte offset. */
  readonly root?: DeclarationFacts.SemanticType
}

const ordinaryLanePlacements = (
  self: Plan,
  type: DeclarationFacts.SemanticType,
  byteOffset: number,
): ReadonlyArray<EnvironmentLanePlacement> =>
  (callingShape(self, type)?.lanes ?? []).map((lane) => ({ lane, byteOffset, root: type }))

/** Places every scalar lane stored by one hidden Effect environment. */
export const effectEnvironmentLanePlacements = (
  self: Plan,
  environment: Extract<
    EffectEnvironment,
    {
      readonly _tag: 'EffectEnvironment'
    }
  >,
  byteOffset = 0,
): ReadonlyArray<EnvironmentLanePlacement> =>
  environment.fields.flatMap((field) => effectFieldLanePlacements(self, field, byteOffset))

/** Places every scalar lane stored by one Effect capture field. */
export const effectFieldLanePlacements = (
  self: Plan,
  field: EffectEnvironmentField,
  byteOffset = 0,
): ReadonlyArray<EnvironmentLanePlacement> => {
  const fieldOffset = byteOffset + field.offset
  if (field.representation === 'Borrow') {
    const [lane] = effectFieldLanes(self, field)
    return lane === undefined ? [] : [{ lane, byteOffset: fieldOffset }]
  }
  if (field.callableIdentity !== undefined) {
    const captured =
      field.callableIdentity.environment === undefined
        ? undefined
        : callableEnvironmentByIdentity(self, field.callableIdentity.environment)
    return captured === undefined
      ? []
      : callableEnvironmentLanePlacements(self, captured, fieldOffset)
  }
  if (field.effectIdentity !== undefined) {
    const captured = effectEnvironmentByFieldIdentity(self, field.effectIdentity)
    return captured === undefined
      ? []
      : effectEnvironmentLanePlacements(self, captured, fieldOffset)
  }
  return ordinaryLanePlacements(self, field.type, fieldOffset)
}

/** Materializes the ABI lanes of one hidden Effect environment separately from its outcome. */
export const effectEnvironmentLanes = (
  self: Plan,
  environment: Extract<
    EffectEnvironment,
    {
      readonly _tag: 'EffectEnvironment'
    }
  >,
): ReadonlyArray<CallingLane> =>
  environment.fields.flatMap((field) => effectFieldLanes(self, field))

/** Materializes the ABI lanes of one hidden callable capture environment. */
export const callableEnvironmentLanes = (
  self: Plan,
  environment: Extract<
    CallableEnvironment,
    {
      readonly _tag: 'CallableEnvironment'
    }
  >,
): ReadonlyArray<CallingLane> =>
  environment.fields.flatMap((field) => callableFieldLanes(self, field))

/** Reconstructs the complete specialized target key of one callable environment. */
export const callableTargetArguments = (
  environment: Extract<
    CallableEnvironment,
    {
      readonly _tag: 'CallableEnvironment'
    }
  >,
): ReadonlyArray<Type.GenericArgument> => [
  ...environment.callable.typeArguments,
  ...environment.callable.captures
    .filter(
      (
        capture,
      ): capture is typeof capture & {
        readonly callableIdentity: Type.CallableIdentityArgument
      } => capture.callableIdentity !== undefined,
    )
    .sort((left, right) => left.parameterOrdinal - right.parameterOrdinal)
    .map((capture) => capture.callableIdentity),
]

/** Materializes the ABI lanes stored for one hidden callable capture field. */
export const callableFieldLanes = (
  self: Plan,
  field: CallableEnvironmentField,
): ReadonlyArray<CallingLane> => {
  if (field.representation === 'Borrow') {
    return [
      {
        _tag: 'CallingLane' as const,
        path: [],
        type: {
          _tag: 'Address' as const,
          element: field.type,
          bits: self.target.pointerSize === 4 ? 32 : 64,
        },
      },
    ]
  }
  if (field.callableIdentity !== undefined) {
    const environment =
      field.callableIdentity.environment === undefined
        ? undefined
        : callableEnvironmentByIdentity(self, field.callableIdentity.environment)
    return environment === undefined ? [] : callableEnvironmentLanes(self, environment)
  }
  return callingShape(self, field.type)?.lanes ?? []
}

/** Places every scalar lane stored by one hidden callable environment. */
export const callableEnvironmentLanePlacements = (
  self: Plan,
  environment: Extract<
    CallableEnvironment,
    {
      readonly _tag: 'CallableEnvironment'
    }
  >,
  byteOffset = 0,
): ReadonlyArray<EnvironmentLanePlacement> =>
  environment.fields.flatMap((field) => callableFieldLanePlacements(self, field, byteOffset))

/** Places every scalar lane stored by one callable capture field. */
export const callableFieldLanePlacements = (
  self: Plan,
  field: CallableEnvironmentField,
  byteOffset = 0,
): ReadonlyArray<EnvironmentLanePlacement> => {
  const fieldOffset = byteOffset + field.offset
  if (field.representation === 'Borrow') {
    const [lane] = callableFieldLanes(self, field)
    return lane === undefined ? [] : [{ lane, byteOffset: fieldOffset }]
  }
  if (field.callableIdentity?.environment !== undefined) {
    const captured = callableEnvironmentByIdentity(self, field.callableIdentity.environment)
    return captured === undefined
      ? []
      : callableEnvironmentLanePlacements(self, captured, fieldOffset)
  }
  return ordinaryLanePlacements(self, field.type, fieldOffset)
}

/** The logical lane and byte range occupied by one capture in a specialized environment. */
export interface CallableCaptureRange {
  readonly laneOffset: number
  readonly laneCount: number
  readonly byteOffset: number
}

/** Resolves one owned capture's runtime range from its canonical environment identity. */
export const callableCaptureRange = (
  self: Plan,
  identity: Type.CallableEnvironmentIdentity,
  capture: number,
): CallableCaptureRange | undefined => {
  const environment = callableEnvironmentByIdentity(self, identity)
  if (environment === undefined) return undefined
  let laneOffset = 0
  for (const field of environment.fields) {
    const laneCount = callableFieldLanes(self, field).length
    if (field.ordinal === capture) return { laneOffset, laneCount, byteOffset: field.offset }
    laneOffset += laneCount
  }
  return undefined
}

const fieldSlice = (
  node: CallingShapeNode,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
  offset = 0,
):
  | {
      readonly offset: number
      readonly length: number
    }
  | undefined => {
  const [field, ...rest] = path
  if (field === undefined) return { offset, length: node.laneCount }
  if (node._tag === 'NominalUnionShape') {
    const variant = node.variants.find(
      (variant) =>
        variant.shape._tag === 'ProductShape' &&
        variant.shape.fields.some((candidate) =>
          DeclarationFacts.sameFieldId(candidate.field, field),
        ),
    )
    return variant === undefined ? undefined : fieldSlice(variant.shape, path, offset + 1)
  }
  if (node._tag !== 'ProductShape') return undefined
  let fieldOffset = offset
  for (const candidate of node.fields) {
    if (DeclarationFacts.sameFieldId(candidate.field, field)) {
      return fieldSlice(candidate.shape, rest, fieldOffset)
    }
    fieldOffset += candidate.shape.laneCount
  }
  return undefined
}

/** Physical calling-lane slots for one logical member payload field path. */
export const memberFieldSlots = (
  shape: CallingShape,
  member: Type.Type,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
): ReadonlyArray<number> | undefined => {
  if (path.length === 0 && Type.runtimeKey(shape.type) === Type.runtimeKey(member))
    return Array.from({ length: shape.laneCount }, (_, ordinal) => ordinal)
  let selected:
    | {
        readonly shape: CallingShapeNode
        readonly physicalOffset: number
      }
    | undefined
  if (
    shape.tree._tag === 'ProductShape' &&
    Type.runtimeKey(shape.tree.type) === Type.runtimeKey(member)
  ) {
    selected = { shape: shape.tree, physicalOffset: 0 }
  } else if (shape.tree._tag === 'SumShape') {
    const candidate = shape.tree.members.find(
      (entry) => Type.runtimeKey(entry.member) === Type.runtimeKey(member),
    )
    if (candidate !== undefined) {
      selected = { shape: candidate.shape, physicalOffset: 1 }
    }
  }
  if (selected === undefined) return undefined
  const slice = fieldSlice(selected.shape, path)
  return slice === undefined
    ? undefined
    : Array.from(
        { length: slice.length },
        (_, ordinal) => selected.physicalOffset + slice.offset + ordinal,
      )
}

/** Canonical match leaves described by a realized calling shape. */
export const coverageMembers = (shape: CallingShape): ReadonlyArray<Match.CoverageIdentity> => {
  if (shape.tree._tag === 'NominalUnionShape') return coverageVariants(shape.type, shape.tree)
  if (shape.tree._tag !== 'SumShape') return Match.membersOf(shape.type)
  return shape.tree.members.flatMap((member) =>
    member.shape._tag === 'NominalUnionShape'
      ? coverageVariants(member.member, member.shape)
      : [Match.structuralMember(member.member)],
  )
}

/** Resolves a pattern field path through canonical variant and aggregate owners. */
export const coveragePath = (
  layout: Plan,
  root: Type.Type,
  member: Match.CoverageIdentity,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
):
  | {
      readonly type: Type.Type
      readonly selectors: ReadonlyArray<
        | {
            readonly _tag: 'Variant'
            readonly ordinal: number
          }
        | {
            readonly _tag: 'Field'
            readonly field: DeclarationFacts.FieldId
          }
      >
    }
  | undefined => {
  let current = root
  const selectors: Array<
    | {
        readonly _tag: 'Variant'
        readonly ordinal: number
      }
    | {
        readonly _tag: 'Field'
        readonly field: DeclarationFacts.FieldId
      }
  > = []
  if (
    Type.isUnion(current) &&
    Type.runtimeKey(current) !== Type.runtimeKey(Match.sourceType(member))
  ) {
    const selected = Match.sourceType(member)
    const ordinal = current.members.findIndex(
      (candidate) => Type.runtimeKey(candidate) === Type.runtimeKey(selected),
    )
    if (ordinal < 0) return undefined
    selectors.push({ _tag: 'Variant', ordinal })
    current = selected
  }
  for (const [ordinal, id] of path.entries()) {
    const representation = entry(layout, current)?.representation
    let field: Field | undefined
    if (representation?._tag === 'NominalUnion') {
      const variant = representation.variants.find(
        (candidate) =>
          (ordinal !== 0 ||
            member._tag !== 'NominalUnionVariant' ||
            candidate.ordinal === member.variantOrdinal) &&
          candidate.fields.some((field) => DeclarationFacts.sameFieldId(field.id, id)),
      )
      field = variant?.fields.find((candidate) => DeclarationFacts.sameFieldId(candidate.id, id))
      if (variant !== undefined) selectors.push({ _tag: 'Variant', ordinal: variant.ordinal })
    } else if (representation?._tag === 'Aggregate') {
      field = representation.fields.find((candidate) =>
        DeclarationFacts.sameFieldId(candidate.id, id),
      )
    }
    if (field === undefined) return undefined
    selectors.push({ _tag: 'Field', field: id })
    current = field.type
  }
  return { type: current, selectors }
}

/** Physical calling-lane slots for a field selected by one exact match coverage identity. */
export const coverageFieldSlots = (
  shape: CallingShape,
  member: Match.CoverageIdentity,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
): ReadonlyArray<number> | undefined => {
  if (member._tag !== 'NominalUnionVariant')
    return memberFieldSlots(shape, Match.sourceType(member), path)
  let selected:
    | {
        readonly shape: CallingShapeNode
        readonly physicalOffset: number
      }
    | undefined
  if (
    shape.tree._tag === 'NominalUnionShape' &&
    Type.runtimeKey(shape.tree.type) === Type.runtimeKey(member.type)
  ) {
    if (path.length === 0)
      return Array.from({ length: shape.tree.laneCount }, (_, ordinal) => ordinal)
    const variant = shape.tree.variants.find(
      (candidate) =>
        candidate.ordinal === member.variantOrdinal &&
        candidate.variant.union.module === member.variant.union.module &&
        candidate.variant.union.name === member.variant.union.name &&
        candidate.variant.name === member.variant.name,
    )
    if (variant !== undefined) selected = { shape: variant.shape, physicalOffset: 1 }
  } else if (shape.tree._tag === 'SumShape') {
    const outer = shape.tree.members.find(
      (candidate) => Type.runtimeKey(candidate.member) === Type.runtimeKey(member.root),
    )
    if (outer?.shape._tag === 'NominalUnionShape') {
      if (path.length === 0)
        return Array.from({ length: outer.shape.laneCount }, (_, ordinal) => 1 + ordinal)
      const variant = outer.shape.variants.find(
        (candidate) =>
          candidate.ordinal === member.variantOrdinal &&
          candidate.variant.union.module === member.variant.union.module &&
          candidate.variant.union.name === member.variant.union.name &&
          candidate.variant.name === member.variant.name,
      )
      if (variant !== undefined) selected = { shape: variant.shape, physicalOffset: 2 }
    }
  }
  if (selected === undefined) return undefined
  const slice = fieldSlice(selected.shape, path)
  return slice === undefined
    ? undefined
    : Array.from(
        { length: slice.length },
        (_, ordinal) => selected.physicalOffset + slice.offset + ordinal,
      )
}

/** Selects a binding's full carrier when cleanup retains the original matched value. */
export const coverageBindingSlots = (
  shape: CallingShape,
  member: Match.CoverageIdentity,
  path: ReadonlyArray<DeclarationFacts.FieldId>,
  type: DeclarationFacts.SemanticType,
): ReadonlyArray<number> | undefined =>
  path.length === 0 && Type.runtimeKey(type) === Type.runtimeKey(shape.type)
    ? Array.from({ length: shape.laneCount }, (_, ordinal) => ordinal)
    : coverageFieldSlots(shape, member, path)

const coverageVariants = (
  root: Type.Type,
  node: Extract<
    CallingShapeNode,
    {
      readonly _tag: 'NominalUnionShape'
    }
  >,
): ReadonlyArray<Match.CoverageIdentity> =>
  node.variants.map((variant) =>
    Match.nominalUnionVariant(root, node.type, variant.variant, variant.ordinal),
  )

// Value layout constructors

const compareRuntimeTypes = (left: Type.Type, right: Type.Type): number => {
  const leftKey = Type.runtimeKey(left)
  const rightKey = Type.runtimeKey(right)
  if (leftKey < rightKey) return -1
  if (leftKey > rightKey) return 1
  return 0
}

export const scalarEntry = (target: Target.Target, type: Type.Builtin): Entry => {
  const scalar = Scalar.find(type)
  if (scalar === undefined) throw new RangeError(`Layout lost scalar catalog entry for ${type}`)
  const layout = Scalar.resolveLayout(scalar, target)
  const bits = Scalar.bits(scalar, target.pointerSize === 4 ? 32 : 64)
  let representation: Representation
  if (scalar.category === 'Boolean') {
    representation = { _tag: 'Boolean', bits: 32, falseValue: 0, trueValue: 1 }
  } else if (scalar.category === 'Floating') {
    representation = { _tag: 'Floating', bits: bits as 32 | 64, ieee: true }
  } else if (scalar.signedness === 'Signed') {
    representation = { _tag: 'SignedInteger', bits }
  } else {
    representation = { _tag: 'UnsignedInteger', bits }
  }
  return {
    _tag: 'LayoutEntry',
    type,
    copy: true,
    size: layout.size,
    alignment: layout.alignment,
    representation,
  }
}

const repeatedEntry = (type: Type.FixedArray, element: Entry): Entry | undefined => {
  const stride = alignUp(element.size, element.alignment)
  const size = stride * type.length
  if (!Number.isSafeInteger(stride) || !Number.isSafeInteger(size)) return undefined
  return {
    _tag: 'LayoutEntry',
    type,
    copy: element.copy,
    size,
    alignment: element.alignment,
    representation: {
      _tag: 'Repeated',
      element: type.element,
      length: type.length,
      stride,
    },
  }
}

export const sliceEntry = (target: Target.Target, type: Type.Slice, element: Entry): Entry => {
  const addressBits: 32 | 64 = target.pointerSize === 4 ? 32 : 64
  const lengthOffset = alignUp(target.pointerSize, target.pointerAlignment)
  const alignment = target.pointerAlignment
  const contentSize = lengthOffset + target.pointerSize
  const size = alignUp(contentSize, alignment)
  return {
    _tag: 'LayoutEntry',
    type,
    copy: type.access === 'Shared',
    size,
    alignment,
    representation: {
      _tag: 'Slice',
      element: type.element,
      address: {
        bits: addressBits,
        offset: 0,
        size: target.pointerSize,
        alignment: target.pointerAlignment,
      },
      length: { type: 'usize', offset: lengthOffset, size: target.pointerSize },
      addressPadding: lengthOffset - target.pointerSize,
      tailPadding: size - contentSize,
      stride: alignUp(element.size, element.alignment),
    },
  }
}

export const stringEntry = (target: Target.Target, type: Type.String): Entry => {
  const addressBits: 32 | 64 = target.pointerSize === 4 ? 32 : 64
  const byteLengthOffset = alignUp(target.pointerSize, target.pointerAlignment)
  const alignment = target.pointerAlignment
  const contentSize = byteLengthOffset + target.pointerSize
  const size = alignUp(contentSize, alignment)
  return {
    _tag: 'LayoutEntry',
    type,
    copy: true,
    size,
    alignment,
    representation: {
      _tag: 'String',
      storage: {
        provenance: 'Utf8',
        bits: addressBits,
        offset: 0,
        size: target.pointerSize,
        alignment: target.pointerAlignment,
      },
      byteLength: {
        type: 'usize',
        offset: byteLengthOffset,
        size: target.pointerSize,
      },
      storagePadding: byteLengthOffset - target.pointerSize,
      tailPadding: size - contentSize,
    },
  }
}

export const referenceEntry = (target: Target.Target, type: Type.Reference): Entry => ({
  _tag: 'LayoutEntry',
  type,
  copy: type.access === 'Shared',
  size: target.pointerSize,
  alignment: target.pointerAlignment,
  representation: {
    _tag: 'Reference',
    target: type.target,
    address: {
      bits: target.pointerSize === 4 ? 32 : 64,
      offset: 0,
      size: target.pointerSize,
      alignment: target.pointerAlignment,
    },
  },
})

/** A raw pointer is one Copy address lane; the pointee's layout is never embedded. */
export const pointerEntry = (target: Target.Target, type: Type.Pointer): Entry => ({
  _tag: 'LayoutEntry',
  type,
  copy: true,
  size: target.pointerSize,
  alignment: target.pointerAlignment,
  representation: {
    _tag: 'Reference',
    target: type.pointee,
    address: {
      bits: target.pointerSize === 4 ? 32 : 64,
      offset: 0,
      size: target.pointerSize,
      alignment: target.pointerAlignment,
    },
  },
})

/** A C function pointer is one Copy address lane with no embedded pointee layout. */
export const foreignFunctionEntry = (target: Target.Target, type: Type.ForeignFunction): Entry => ({
  _tag: 'LayoutEntry',
  type,
  copy: true,
  size: target.pointerSize,
  alignment: target.pointerAlignment,
  representation: {
    _tag: 'Reference',
    target: type,
    address: {
      bits: target.pointerSize === 4 ? 32 : 64,
      offset: 0,
      size: target.pointerSize,
      alignment: target.pointerAlignment,
    },
  },
})

export const unionEntry = (type: Type.StructuralUnion, members: ReadonlyArray<Entry>): Entry => {
  const payloadAlignment = members.reduce(
    (maximum, member) => Math.max(maximum, member.alignment),
    1,
  )
  const payloadSize = members.reduce((maximum, member) => Math.max(maximum, member.size), 0)
  const payloadOffset = alignUp(4, payloadAlignment)
  const alignment = Math.max(4, payloadAlignment)
  const contentSize = payloadOffset + payloadSize
  const size = alignUp(contentSize, alignment)
  return {
    _tag: 'LayoutEntry',
    type,
    copy: members.every((member) => member.copy),
    size,
    alignment,
    representation: {
      _tag: 'Union',
      tag: { bits: 32, size: 4 },
      members: type.members.map((member, ordinal) => {
        const layout = members.at(ordinal)
        return {
          type: member,
          ordinal,
          size: layout?.size ?? 0,
          alignment: layout?.alignment ?? 1,
        }
      }),
      payloadOffset,
      payloadSize,
      payloadAlignment,
      tagPadding: payloadOffset - 4,
      tailPadding: size - contentSize,
    },
  }
}

// `never` has no values or calling lanes, but generic aggregates still need a compositional
// physical fact for impossible fields such as `Failure<never>`. This entry is never materialized
// as a value; it only lets the enclosing representation remain well-defined.
export const neverEntry = (): Entry => ({
  _tag: 'LayoutEntry',
  type: 'never',
  copy: true,
  size: 0,
  alignment: 1,
  representation: {
    _tag: 'Aggregate',
    fields: [],
    tailPadding: 0,
  },
})

const nominalOf = (
  declaration: DeclarationFacts.StructFact | DeclarationFacts.UnionFact | DeclarationFacts.EnumFact,
): Type.Nominal | undefined =>
  declaration.canonical._tag === 'Canonical'
    ? Type.nominal(declaration.canonical.id.module, declaration.canonical.id.name)
    : undefined

export const scalarEnumEntry = (
  target: Target.Target,
  declaration: DeclarationFacts.EnumFact,
): Entry | undefined => {
  if (
    declaration.canonical._tag !== 'Canonical' ||
    declaration.validity._tag !== 'Valid' ||
    declaration.representation._tag !== 'Available'
  )
    return undefined
  const scalar = declaration.representation.scalar
  const layout = Scalar.resolveLayout(scalar, target)
  const members = declaration.members.flatMap((member) =>
    member.canonical._tag === 'Canonical' && member.discriminant._tag === 'Available'
      ? [
          {
            member: member.canonical.id,
            discriminant: member.discriminant.value,
          },
        ]
      : [],
  )
  if (members.length !== declaration.members.length) return undefined
  return {
    _tag: 'LayoutEntry',
    type: Type.nominal(declaration.canonical.id.module, declaration.canonical.id.name),
    copy: true,
    size: layout.size,
    alignment: layout.alignment,
    representation: {
      _tag: 'ScalarEnum',
      enum: declaration.canonical.id,
      scalar: scalar.spelling,
      bits: Scalar.bits(scalar, target.pointerSize === 4 ? 32 : 64),
      signedness: scalar.signedness,
      members: members,
    },
  }
}

const dependenciesOf = (
  aggregate: DeclarationFacts.StructFact | DeclarationFacts.UnionFact,
  substitution: Type.Substitution = new Map(),
): ReadonlyArray<Type.Nominal> => {
  const dependencies = new Map<string, Type.Nominal>()
  const fields =
    aggregate._tag === 'StructDeclaration'
      ? aggregate.fields
      : aggregate.variants.flatMap((variant) => variant.fields)
  for (const field of fields) {
    let types: ReadonlyArray<Type.Nominal> = []
    if (field.declaredType._tag === 'Resolved') {
      types = Type.nominals(Type.substitute(field.declaredType.type, substitution))
    } else if (
      field.declaredType._tag === 'Unresolved' &&
      field.declaredType.candidate !== undefined
    ) {
      types = [field.declaredType.candidate]
    }
    for (const type of types) dependencies.set(Type.runtimeKey(type), type)
  }
  return [...dependencies.values()].sort(compareRuntimeTypes)
}

const unavailable = (
  type: DeclarationFacts.SemanticType,
  dependencies: ReadonlyArray<Type.Nominal>,
  reason: UnavailableReason,
  cause?: Diagnostic.CauseIdentity,
): UnavailableEntry => ({
  _tag: 'UnavailableLayoutEntry',
  type,
  dependencies,
  reason: reason,
  ...(cause === undefined ? {} : { cause }),
})
