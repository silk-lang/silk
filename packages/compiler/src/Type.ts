import * as ForeignContract from './ForeignContract.js'
import type * as CallableContract from './CallableContract.js'
import type * as Constraint from './Constraint.js'
import * as Lifetime from './Lifetime.js'
import * as FiniteRow from './FiniteRow.js'
import * as Canonical from './internal/Canonical.js'
import * as RequirementRow from './RequirementRow.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as Scalar from './Scalar.js'
import type * as Location from './Location.js'
import * as SourceSpan from './SourceSpan.js'
import * as TypeCompatibility from './TypeCompatibility.js'

/** The built-in scalar types implemented by the current executable bootstrap surface. */
export type Builtin = Scalar.Spelling

/** The canonical immutable valid-UTF-8 view, distinct from every scalar and byte slice. */
export interface String {
  readonly _tag: 'StringType'
  readonly lifetime: Lifetime.Lifetime
}

/** The empty structural union and uninhabited bottom type. */
export type Bottom = 'never'

/** One canonical nominal struct type, independent of import or source spelling. */
export interface Nominal {
  readonly _tag: 'NominalType'
  readonly module: string
  readonly name: string
  readonly arguments: ReadonlyArray<GenericArgument>
  /** Compiler-minted provenance for sealed nominal identities unavailable to source declarations. */
  readonly sealed?:
    | 'Intrinsic.SharedCore'
    | 'Intrinsic.Execution'
    | 'Intrinsic.Wake'
    | 'Intrinsic.StorageFailure'
    | 'Intrinsic.Type'
    | 'Intrinsic.Fields'
    | 'Intrinsic.Field'
    | 'Intrinsic.StaticSequence'
    | 'Intrinsic.Test'
    | 'Intrinsic.Tests'
    | 'Intrinsic.TestInfo'
}

/** One declaration-owned generic type parameter. Names are provenance, not identity. */
export type ParameterKind =
  | 'Lifetime'
  | 'Value'
  | 'RequirementRow'
  | 'CallableRepresentation'
  | 'EffectRepresentation'

/** Compiler-owned, witness-free obligations admitted only beside one executable bound. */
export type SealedStaticProperty = 'Intrinsic.Detached' | 'Intrinsic.NonParking'

/** Canonical witness-free obligation order used by syntax, keys, and serialized surfaces. */
export const sealedStaticPropertyOrder: ReadonlyArray<SealedStaticProperty> = [
  'Intrinsic.Detached',
  'Intrinsic.NonParking',
]

export interface Parameter {
  readonly _tag: 'TypeParameter'
  readonly owner: {
    readonly module: string
    readonly name: string
  }
  readonly ordinal: number
  readonly name: string
  readonly kind: ParameterKind
  readonly representationBound?: RepresentationBound
  readonly staticProperties: ReadonlyArray<SealedStaticProperty>
}

/** One canonical inline fixed array whose length participates in structural identity. */
export interface FixedArray {
  readonly _tag: 'FixedArrayType'
  readonly element: Type
  readonly length: number
}

/** A lexical runtime-length view whose access permission is checked statically. */
export type BorrowAccess = 'Shared' | 'Exclusive'

export interface Slice {
  readonly _tag: 'SliceType'
  readonly lifetime: Lifetime.Lifetime
  readonly access: BorrowAccess
  readonly element: Type
}

/** A lexical borrow of one complete value. Unlike a Slice, it carries no runtime length. */
export interface Reference {
  readonly _tag: 'ReferenceType'
  readonly lifetime: Lifetime.Lifetime
  readonly access: BorrowAccess
  readonly target: Type
}

/**
 * A qualified raw address. Nullness, extent and minimum alignment describe its representation;
 * initialization, live storage, ownership and retained-address permission remain separate proofs.
 */
export interface Pointer {
  readonly _tag: 'PointerType'
  readonly mutable: boolean
  readonly pointee: Type
  readonly nullable: boolean
  readonly extent: 'Single' | 'Many'
  readonly alignment: 'Natural' | number
  readonly addressSpace: 0
}

/** How a callable environment may be accessed by one invocation. */
export type CallableMode = 'Shared' | 'Exclusive' | 'Take'

/** Access carried by a stored environment lane; copy adds no ownership dependency. */
export type CaptureAccess = 'Copy' | CallableMode

/**
 * Compile-time-only obligations retained by a partially applied generic callable.
 *
 * The binders are nested under the callable value: they are not free parameters of the enclosing
 * function or instance. Constraint and evidence keys keep the type layer independent from the
 * solver implementation while the structured values remain available to a later static call.
 * Origins are diagnostic provenance and deliberately do not participate in semantic identity.
 */
export interface CallableSchema {
  /** Already selected source declaration retained through generic value substitution. */
  readonly source?: { readonly module: string; readonly name: string }
  readonly contract: CallableContract.CallableContract
  readonly binders: ReadonlyArray<Parameter>
  readonly constraints: ReadonlyArray<Constraint.Constraint>
  readonly evidence: ReadonlyArray<Constraint.ConstraintEvidence>
  readonly substitution: Substitution
  readonly contractKey: string
  readonly constraintKeys: ReadonlyArray<string>
  readonly evidenceKeys: ReadonlyArray<string>
  readonly origins: ReadonlyArray<Location.Location>
}

/**
 * Lets the constraint layer specialize schema-owned metadata without introducing a Type ->
 * Constraint runtime cycle. Both callbacks are the same recursive owner-specialization walk used
 * for the callable's ordinary parameter and result types.
 */
export type CallableSchemaOwnerSpecializer = (
  schema: CallableSchema,
  specializeType: (type: Type) => Type,
  specializeArgument: (argument: GenericArgument) => GenericArgument,
) => CallableSchema

/** One structural data-validity requirement carried by an executable contract. */
export interface TypeOutlives {
  readonly type: Type
  readonly lifetime: Lifetime.Lifetime
}

/** One canonical structural callable contract independent of its hidden concrete environment. */
export interface ExecutableLifetimes {
  readonly environment: Lifetime.Lifetime
  readonly lifetimeBinders: ReadonlyArray<Lifetime.Bound>
  readonly lifetimeBounds?: ReadonlyArray<Lifetime.Outlives>
  readonly typeOutlives?: ReadonlyArray<TypeOutlives>
}

export interface Callable extends ExecutableLifetimes {
  readonly lifetimeBounds: ReadonlyArray<Lifetime.Outlives>
  readonly typeOutlives: ReadonlyArray<TypeOutlives>
  readonly _tag: 'CallableType'
  readonly unsafe: boolean
  readonly parameters: ReadonlyArray<Type>
  readonly result: Type
  readonly mode: CallableMode
  readonly schema?: CallableSchema
}

/** A non-capturing synchronous function pointer with one native calling convention. */
export interface ForeignFunction extends ExecutableLifetimes {
  readonly lifetimeBounds: ReadonlyArray<Lifetime.Outlives>
  readonly typeOutlives: ReadonlyArray<TypeOutlives>
  readonly _tag: 'ForeignFunctionType'
  readonly nullable: false
  readonly contract: ForeignContract.ForeignContract
  readonly abi: 'C'
  readonly parameters: ReadonlyArray<Type>
  readonly result: Type
}

/** One compile-time capability requirement. Roles select slots and have no runtime value. */
export interface Requirement extends RequirementRow.Member<Nominal | Parameter> {}

/** One open nominal member lifted into a failure row. */
export interface FailureMemberShape {
  readonly parameter: Parameter
}

/** One open capability key with a retained access demand lifted into a requirement row. */
export interface RequirementMemberShape {
  readonly capability: Parameter
  readonly access: Requirement['access']
  readonly role: RequirementRow.Role
}

export type FailureRow = RowAlgebra.Row<Type, Parameter, FailureMemberShape>
export type RequirementsRow = RowAlgebra.Row<Requirement, Parameter, RequirementMemberShape>

/** One concrete normalized requirement-row argument supplied to a requirement-row parameter. */
export interface RequirementRowArgument {
  readonly _tag: 'RequirementRowArgument'
  readonly row: RequirementsRow
}

/** The complete enclosing executable specialization retained by a source construction identity. */
export interface ExecutableSpecializationOwner {
  readonly declaration: { readonly module: string; readonly name: string }
  readonly typeArguments: ReadonlyArray<GenericArgument>
  /** Canonical identities of the enclosing executable's compile-time value arguments. */
  readonly staticArgumentKeys: ReadonlyArray<string>
}

/** One compiler-only hidden Effect construction identity used for monomorphic specialization. */
export interface EffectIdentityArgument {
  readonly _tag: 'EffectIdentityArgument'
  readonly identity: string
  /** Present for a source site whose runner depends on its enclosing generic specialization. */
  readonly owner?: ExecutableSpecializationOwner
}

/** The path- and span-independent construction site of one callable capture environment. */
export type CallableEnvironmentSite =
  | {
      readonly _tag: 'DeclaredCallableEnvironmentSite'
      readonly declaration: { readonly module: string; readonly name: string }
      readonly ordinal: number
    }
  | {
      readonly _tag: 'RecoveredCallableEnvironmentSite'
      readonly functionOrdinal: number
      readonly ordinal: number
    }

/** The complete specialized identity of one callable capture environment. */
export interface CallableEnvironmentIdentity {
  readonly _tag: 'CallableEnvironmentIdentity'
  readonly site: CallableEnvironmentSite
  readonly owner: ExecutableSpecializationOwner
}

/** One compiler-only hidden callable identity used for monomorphic higher-order lowering. */
export interface CallableIdentityArgument {
  readonly _tag: 'CallableIdentityArgument'
  readonly identity: string
  readonly target:
    | { readonly _tag: 'Declaration'; readonly module: string; readonly name: string }
    | {
        readonly _tag: 'Builtin'
        readonly actor: string
        readonly operation: BuiltinOperation
        readonly intrinsic: { readonly actor: string; readonly name: string }
      }
  readonly typeArguments: ReadonlyArray<GenericArgument>
  readonly environment?: CallableEnvironmentIdentity
}

const nonScalarBuiltinOperations = [
  'LayoutOf',
  'SharedLayout',
  'SharedFromAllocation',
  'SharedClone',
  'SharedWithMut',
  'ExecutionLayout',
  'ExecutionFromAllocation',
  'ExecutionDrive',
  'ExecutionNotifyInitial',
  'ExecutionWake',
  'ExecutionPark',
  'EffectSuspend',
  'EffectFinalize',
  'EffectFinalizeNonParking',
  'EffectUseReleaseNonParking',
  'EffectObserveDiagnostics',
  'EffectObserveUnhandled',
  'StorageAcquire',
  'RawBufferFrom',
  'RawBufferSlot',
  'RawBufferCount',
  'RawBufferRead',
  'RawBufferView',
  'RawBufferViewMut',
  'RawBufferCopy',
  'RawBufferFill',
  'PointerNull',
  'PointerIsNull',
  'PointerAddress',
  'PointerFromRef',
  'PointerFromMutRef',
  'PointerFromSlice',
  'PointerFromMutSlice',
  'PointerAt',
  'PointerAtMut',
  'PointerRead',
  'PointerWrite',
  'PointerReadUnaligned',
  'PointerWriteUnaligned',
  'PointerRequalify',
  'PointerReinterpret',
  'PointerBytes',
  'NativeAssembly',
  'SlotAddress',
  'SlotWrite',
  'SlotTake',
  'SlotCopy',
  'SlotDrop',
  'StringFromUtf8Unchecked',
  'StringUtf8Bytes',
  'SliceView',
  'StringByteLength',
  'StringEqualsExact',
] as const

/** The closed operation vocabulary shared by semantic callable identities and TIR targets. */
export type BuiltinOperation = Scalar.OperationCode | (typeof nonScalarBuiltinOperations)[number]

const builtinOperations: ReadonlySet<string> = new Set([
  ...Scalar.all().flatMap((scalar) => scalar.operations.map((operation) => operation.code)),
  ...nonScalarBuiltinOperations,
])

/** Tests whether external text names one operation from the closed builtin vocabulary. */
export const isBuiltinOperation = (value: string): value is BuiltinOperation =>
  builtinOperations.has(value)

/** A structural contract that may bound one statically known executable representation. */
export type RepresentationBound = Callable | Effect

/** An open reference to one declaration-owned representation parameter. */
export interface RepresentationParameterArgument {
  readonly _tag: 'RepresentationParameterArgument'
  readonly parameter: Parameter
}

/** Stable source identity of one declaration-owned opaque representation family. */
export interface OpaqueFamilyKey {
  readonly _tag: 'OpaqueFamilyKey'
  readonly producer: { readonly module: string; readonly name: string }
  readonly binderOrdinal: number
}

/** One opaque family specialized over every enclosing generic argument. */
export interface OpaqueRepresentationArgument {
  readonly _tag: 'OpaqueRepresentationArgument'
  readonly family: OpaqueFamilyKey
  readonly contract: RepresentationBound
  readonly arguments: ReadonlyArray<GenericArgument>
}

/** One exact callable or Effect construction together with its intrinsic contract. */
export interface ExactRepresentationArgument {
  readonly _tag: 'ExactRepresentationArgument'
  readonly identity: EffectIdentityArgument | CallableIdentityArgument
  readonly contract: RepresentationBound
}

/** A closed finite set of exact Effect representations selected by source control flow. */
export interface CompositeEffectRepresentationArgument {
  readonly _tag: 'CompositeEffectRepresentationArgument'
  readonly contract: Effect
  readonly alternatives: ReadonlyArray<ExactRepresentationArgument>
}

/** A statically known representation supplied to a representation parameter. */
export type RepresentationArgument =
  | RepresentationParameterArgument
  | OpaqueRepresentationArgument
  | ExactRepresentationArgument
  | CompositeEffectRepresentationArgument

/** A deterministic recovery placeholder that never reaches specialization or runtime phases. */
export interface UnavailableGenericArgument {
  readonly _tag: 'UnavailableGenericArgument'
  readonly expectedKind: ParameterKind
  readonly reason: string
}

/** Evidence that one intrinsic representation contract is admissible at a required bound. */
export type RepresentationAdmissibility =
  | { readonly _tag: 'Open' }
  | { readonly _tag: 'Admitted' }
  | { readonly _tag: 'Unavailable'; readonly reason: string }

/** One use of an executable representation under a declaration-owned required bound. */
export interface RepresentationUse {
  readonly requiredBound: RepresentationBound
  readonly argument: RepresentationArgument
  readonly admissibility: RepresentationAdmissibility
}

/** A callable or Effect value whose exact representation participates in static type identity. */
export interface Represented {
  readonly _tag: 'RepresentedType'
  readonly contract: RepresentationBound
  readonly representation: RepresentationUse
}

/** One erased generic argument, including the compiler-only requirement-row kind. */
export type GenericArgument =
  | Lifetime.Lifetime
  | Type
  | RequirementRowArgument
  | EffectIdentityArgument
  | CallableIdentityArgument
  | RepresentationArgument
  | UnavailableGenericArgument

/** One declaration-parameter identity to concrete erased argument mapping. */
export type Substitution = ReadonlyMap<string, GenericArgument>

/** A row-specific explanation for one failed generic decomposition. */
export type InferenceFailure =
  | RowInferenceFailure
  | {
      readonly _tag: 'EnvironmentMismatch'
      readonly longer: string
      readonly shorter: string
    }

export type RowInferenceFailure =
  | { readonly _tag: 'AbsentFailureMember'; readonly member: string }
  | {
      readonly _tag: 'AbsentRequirementMember'
      readonly capability: string
      readonly role: string
      readonly access: Requirement['access']
    }
  | {
      readonly _tag: 'IncompatibleRequirementRole'
      readonly capability: string
      readonly expected: string
      readonly actual: ReadonlyArray<string>
    }
  | {
      readonly _tag: 'IncompatibleRequirementAccess'
      readonly capability: string
      readonly role: string
      readonly expected: Requirement['access']
      readonly actual: ReadonlyArray<Requirement['access']>
    }
  | {
      readonly _tag: 'AmbiguousRequirementRemainder'
      readonly parameters: ReadonlyArray<string>
    }
  | { readonly _tag: 'NonFiniteRequirementRow' }

/** A compiler-private lazy effect contract. Effect values never cross the executable ABI. */
export interface Effect extends ExecutableLifetimes {
  readonly lifetimeBounds: ReadonlyArray<Lifetime.Outlives>
  readonly typeOutlives: ReadonlyArray<TypeOutlives>
  readonly _tag: 'EffectType'
  readonly success: Type
  readonly failureRow: FailureRow
  readonly requirementRow: RequirementsRow
  readonly access: 'Shared' | 'Exclusive' | 'Take'
}

/** One normalized structural union with at least two canonical ordinary members. */
const structuralUnionBrand: unique symbol = Symbol('StructuralUnion')
export interface StructuralUnion {
  readonly _tag: 'StructuralUnionType'
  readonly members: ReadonlyArray<Type>
  readonly [structuralUnionBrand]: true
}

/** The tag convention used by one concrete runtime carrier representation. */
export type FailureCarrierTagPolicy = 'ZeroBased' | 'OneBased'

/** The closed semantic type vocabulary accepted by declaration analysis. */
export type Type =
  | Builtin
  | String
  | Bottom
  | Nominal
  | Parameter
  | FixedArray
  | Slice
  | Reference
  | Pointer
  | Callable
  | ForeignFunction
  | Effect
  | Represented
  | StructuralUnion

/** A semantic type admissible in an ordinary type-parameter argument slot. */
export type OrdinaryType = Exclude<Type, Represented>

/** The typed result of attempting to normalize structural-union inputs. */
export type UnionNormalization =
  | { readonly _tag: 'Normalized'; readonly type: Type }
  | { readonly _tag: 'InvalidMembers'; readonly members: ReadonlyArray<Type> }

/** The canonical lowercase string identity used by source and every compiler phase. */
export const string = (lifetime: Lifetime.Lifetime): String => ({ _tag: 'StringType', lifetime })

/** Constructs one immutable canonical nominal type. */
export const nominal = (
  module: string,
  name: string,
  arguments_: ReadonlyArray<GenericArgument> = [],
): Nominal => ({
  _tag: 'NominalType',
  module,
  name,
  arguments: Array.from(arguments_),
})

const sealedSharedCore = (arguments_: ReadonlyArray<GenericArgument>): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'SharedCore',
  arguments: Array.from(arguments_),
  sealed: 'Intrinsic.SharedCore',
})

const sealedExecution = (arguments_: ReadonlyArray<GenericArgument>): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'Execution',
  arguments: Array.from(arguments_),
  sealed: 'Intrinsic.Execution',
})

const sealedWake = (): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'Wake',
  arguments: [],
  sealed: 'Intrinsic.Wake',
})

const sealedStorageFailure = (): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'StorageFailure',
  arguments: [],
  sealed: 'Intrinsic.StorageFailure',
})

const sealedTypeDescriptor = (arguments_: ReadonlyArray<GenericArgument>): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'Type',
  arguments: Array.from(arguments_),
  sealed: 'Intrinsic.Type',
})

const sealedFieldsDescriptor = (arguments_: ReadonlyArray<GenericArgument>): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'Fields',
  arguments: Array.from(arguments_),
  sealed: 'Intrinsic.Fields',
})

const sealedFieldDescriptor = (arguments_: ReadonlyArray<GenericArgument>): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'Field',
  arguments: Array.from(arguments_),
  sealed: 'Intrinsic.Field',
})

const sealedStaticSequence = (arguments_: ReadonlyArray<GenericArgument>): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'StaticSequence',
  arguments: Array.from(arguments_),
  sealed: 'Intrinsic.StaticSequence',
})

const sealedTestDescriptor = (arguments_: ReadonlyArray<GenericArgument>): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'Test',
  arguments: Array.from(arguments_),
  sealed: 'Intrinsic.Test',
})

const sealedTestCatalog = (): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'Tests',
  arguments: [],
  sealed: 'Intrinsic.Tests',
})

const sealedTestInfo = (): Nominal => ({
  _tag: 'NominalType',
  module: 'Intrinsic',
  name: 'TestInfo',
  arguments: [],
  sealed: 'Intrinsic.TestInfo',
})

/** Replaces one nominal's arguments while preserving compiler-minted sealed provenance. */
export const specializeNominal = (
  self: Nominal,
  arguments_: ReadonlyArray<GenericArgument>,
): Nominal => {
  switch (self.sealed) {
    case 'Intrinsic.SharedCore':
      return sealedSharedCore(arguments_)
    case 'Intrinsic.Execution':
      return sealedExecution(arguments_)
    case 'Intrinsic.Wake':
      return sealedWake()
    case 'Intrinsic.StorageFailure':
      return sealedStorageFailure()
    case 'Intrinsic.Type':
      return sealedTypeDescriptor(arguments_)
    case 'Intrinsic.Fields':
      return sealedFieldsDescriptor(arguments_)
    case 'Intrinsic.Field':
      return sealedFieldDescriptor(arguments_)
    case 'Intrinsic.StaticSequence':
      return sealedStaticSequence(arguments_)
    case 'Intrinsic.Test':
      return sealedTestDescriptor(arguments_)
    case 'Intrinsic.Tests':
      return sealedTestCatalog()
    case 'Intrinsic.TestInfo':
      return sealedTestInfo()
    default:
      return nominal(self.module, self.name, arguments_)
  }
}

export const layout: Nominal = nominal('silk/layout', 'Layout')
export const invalidAlignment: Nominal = nominal('silk/layout', 'InvalidAlignment')
export const layoutOverflow: Nominal = nominal('silk/layout', 'LayoutOverflow')
/** A self-contained affine owner carrying one private active reclaim ticket. */
export const allocation: Nominal = nominal('silk/core', 'Allocation')
/** Opaque affine native file-or-directory handle used only by unsafe OS intrinsics. */
/** Compiler-sealed cleanup capability used only by restricted impl declarations. */
export const dropCapability: Nominal = nominal('silk/core', 'Drop')
/** Compiler-sealed zero-operation property proving that values duplicate without user code. */
export const copyCapability: Nominal = nominal('silk/core', 'Copy')
/** The canonical empty success value used by effect-free cleanup operations. */
export const unit: Nominal = nominal('silk/core', 'Unit')
/** Compiler-checked typed raw storage owned independently from its allocator provider. */
export const rawBuffer = (element: Type): Nominal => nominal('silk/core', 'RawBuffer', [element])
/** A lexical exclusive projection into one RawBuffer element. */
export const slot = (element: Type, lifetime: Lifetime.Lifetime): Nominal =>
  nominal('silk/core', 'Slot', [lifetime, element])
/** The compiler-sealed local strong handle identity. Its representation is intentionally opaque. */
export const sharedCore = (element: Type): Nominal => sealedSharedCore([element])
/** Opaque affine owner-neutral execution identity. Runtime layout belongs to the packaging slice. */
export const execution = (result: Type): Nominal => sealedExecution([result])
/** Opaque affine readiness authority for one local Execution park generation. */
export const wake: Nominal = sealedWake()
/** Sealed host-storage refusal carried only by the primitive allocation boundary. */
export const storageFailure: Nominal = sealedStorageFailure()
/** Static-only aggregate type metadata with no runtime representation. */
export const typeDescriptor = (owner: Type): Nominal => sealedTypeDescriptor([owner])
/** Static-only declaration-ordered field metadata for one aggregate owner. */
export const fieldsDescriptor = (owner: Type): Nominal => sealedFieldsDescriptor([owner])
/** Static-only metadata for one concrete field owner and value type. */
export const fieldDescriptor = (owner: Type, value: Type): Nominal =>
  sealedFieldDescriptor([owner, value])
/** Static-only immutable homogeneous sequence metadata. */
export const staticSequence = (element: Type): Nominal => sealedStaticSequence([element])
/** Static-only descriptor for one exact source test callable. */
export const testDescriptor = (callable: Type): Nominal => sealedTestDescriptor([callable])
/** Static-only heterogeneous catalog returned by test discovery. */
export const testCatalog: Nominal = sealedTestCatalog()
/** Ordinary immutable metadata projected from a static test descriptor. */
export const testInfo: Nominal = sealedTestInfo()
/** Normalizes one or more ordinary failure types to their runtime value union. */
export const failureValue = (failures: ReadonlyArray<Type>): Type => {
  const only = failures.at(0)
  if (failures.length === 1 && only !== undefined) return only
  const normalized = union(failures)
  return normalized._tag === 'Normalized' ? normalized.type : 'never'
}

export const isRawBuffer = (
  self: Type,
): self is Nominal & {
  readonly module: 'silk/core'
  readonly name: 'RawBuffer'
  readonly arguments: readonly [Type]
} => {
  if (!isNominal(self) || self.module !== 'silk/core' || self.name !== 'RawBuffer') return false
  const argument = self.arguments.at(0)
  return self.arguments.length === 1 && argument !== undefined && isTypeArgument(argument)
}

export const isSlot = (
  self: Type,
): self is Nominal & {
  readonly module: 'silk/core'
  readonly name: 'Slot'
  readonly arguments: readonly [Lifetime.Lifetime, Type]
} => {
  if (!isNominal(self) || self.module !== 'silk/core' || self.name !== 'Slot') return false
  const lifetime = self.arguments.at(0)
  const argument = self.arguments.at(1)
  return (
    self.arguments.length === 2 &&
    lifetime !== undefined &&
    Lifetime.isLifetime(lifetime) &&
    argument !== undefined &&
    isTypeArgument(argument)
  )
}

/** Tests the canonical sealed local-shared core identity without consulting source spelling. */
export const isSharedCore = (
  self: Type,
): self is Nominal & {
  readonly module: 'Intrinsic'
  readonly name: 'SharedCore'
  readonly arguments: readonly [Type]
} => {
  if (
    !isNominal(self) ||
    self.module !== 'Intrinsic' ||
    self.name !== 'SharedCore' ||
    self.sealed !== 'Intrinsic.SharedCore'
  )
    return false
  const argument = self.arguments.at(0)
  return self.arguments.length === 1 && argument !== undefined && isTypeArgument(argument)
}

/** Tests the canonical sealed execution identity without consulting source spelling. */
export const isExecution = (
  self: Type,
): self is Nominal & {
  readonly module: 'Intrinsic'
  readonly name: 'Execution'
  readonly arguments: readonly [Type]
} => {
  if (
    !isNominal(self) ||
    self.module !== 'Intrinsic' ||
    self.name !== 'Execution' ||
    self.sealed !== 'Intrinsic.Execution'
  )
    return false
  const argument = self.arguments.at(0)
  return self.arguments.length === 1 && argument !== undefined && isTypeArgument(argument)
}

/** Tests the canonical sealed Wake identity without consulting source spelling. */
export const isWake = (
  self: Type,
): self is Nominal & {
  readonly module: 'Intrinsic'
  readonly name: 'Wake'
  readonly arguments: readonly []
} =>
  isNominal(self) &&
  self.module === 'Intrinsic' &&
  self.name === 'Wake' &&
  self.sealed === 'Intrinsic.Wake' &&
  self.arguments.length === 0

/** Tests whether a type is one of the sealed values erased before runtime TIR. */
export const isStaticPhaseOnly = (self: Type): boolean =>
  isNominal(self) &&
  (self.sealed === 'Intrinsic.Type' ||
    self.sealed === 'Intrinsic.Fields' ||
    self.sealed === 'Intrinsic.Field' ||
    self.sealed === 'Intrinsic.StaticSequence' ||
    self.sealed === 'Intrinsic.Test' ||
    self.sealed === 'Intrinsic.Tests')

/** Tests whether any nested semantic value position contains a phase-only intrinsic nominal. */
export const containsStaticPhaseOnly = (self: Type): boolean => {
  if (typeof self === 'string' || isString(self) || isParameter(self)) return false
  if (isStaticPhaseOnly(self)) return true
  if (isNominal(self))
    return self.arguments.some(
      (argument) => isTypeArgument(argument) && containsStaticPhaseOnly(argument),
    )
  if (isFixedArray(self) || isSlice(self)) return containsStaticPhaseOnly(self.element)
  if (isReference(self)) return containsStaticPhaseOnly(self.target)
  if (isPointer(self)) return containsStaticPhaseOnly(self.pointee)
  if (isCallable(self))
    return self.parameters.some(containsStaticPhaseOnly) || containsStaticPhaseOnly(self.result)
  if (isForeignFunction(self))
    return self.parameters.some(containsStaticPhaseOnly) || containsStaticPhaseOnly(self.result)
  if (isEffect(self))
    return (
      containsStaticPhaseOnly(self.success) ||
      failureMembers(self).some(containsStaticPhaseOnly) ||
      requirementMembers(self).some((requirement) =>
        containsStaticPhaseOnly(requirement.capability),
      )
    )
  if (isRepresented(self)) return containsStaticPhaseOnly(self.contract)
  return self.members.some(containsStaticPhaseOnly)
}

export const intrinsicNominals: ReadonlyMap<string, Nominal> = new Map([
  [allocation.name, allocation],
  [copyCapability.name, copyCapability],
  [dropCapability.name, dropCapability],
  ['RawBuffer', nominal('silk/core', 'RawBuffer')],
  ['Slot', nominal('silk/core', 'Slot')],
  ['Intrinsic.SharedCore', sealedSharedCore([])],
  ['Intrinsic.Execution', sealedExecution([])],
  ['Intrinsic.Wake', sealedWake()],
  ['Intrinsic.StorageFailure', sealedStorageFailure()],
  ['Intrinsic.Type', sealedTypeDescriptor([])],
  ['Intrinsic.Fields', sealedFieldsDescriptor([])],
  ['Intrinsic.Field', sealedFieldDescriptor([])],
  ['Intrinsic.StaticSequence', sealedStaticSequence([])],
  ['Intrinsic.Test', sealedTestDescriptor([])],
  ['Intrinsic.Tests', sealedTestCatalog()],
  ['Intrinsic.TestInfo', sealedTestInfo()],
])

/** Returns the compiler-known generic arity of an intrinsic nominal actor. */
export const intrinsicNominalArity = (self: Nominal): number => {
  if (self.module === 'silk/core' && self.name === 'Slot') return 2
  if (self.sealed === 'Intrinsic.Field') return 2
  if (
    (self.module === 'silk/core' && self.name === 'RawBuffer') ||
    self.sealed === 'Intrinsic.SharedCore' ||
    self.sealed === 'Intrinsic.Execution' ||
    self.sealed === 'Intrinsic.Type' ||
    self.sealed === 'Intrinsic.Fields' ||
    self.sealed === 'Intrinsic.StaticSequence' ||
    self.sealed === 'Intrinsic.Test'
  )
    return 1
  return 0
}

/** Declared binders of the sealed lexical slot, used by ordinary header elaboration. */
export const intrinsicNominalParameters = (self: Nominal): ReadonlyArray<Parameter> | undefined =>
  self.module === 'silk/core' && self.name === 'Slot'
    ? [parameter(self, 0, "'storage", 'Lifetime'), parameter(self, 1, 'T')]
    : undefined
export const intrinsicNominalOrdinal = (self: Nominal): number =>
  [...intrinsicNominals.values()].findIndex(
    (candidate) =>
      candidate.module === self.module &&
      candidate.name === self.name &&
      candidate.sealed === self.sealed,
  )

export const isIntrinsicNominal = (self: Type): boolean =>
  isNominal(self) &&
  [...intrinsicNominals.values()].some(
    (candidate) =>
      candidate.module === self.module &&
      candidate.name === self.name &&
      candidate.sealed === self.sealed,
  )

/** Constructs one declaration-owned generic type parameter. */
export const parameter = (
  owner: { readonly module: string; readonly name: string },
  ordinal: number,
  name: string,
  kind: ParameterKind = 'Value',
  representationBound?: RepresentationBound,
  staticProperties: ReadonlyArray<SealedStaticProperty> = [],
): Parameter => ({
  _tag: 'TypeParameter',
  owner: { module: owner.module, name: owner.name },
  ordinal,
  name,
  kind,
  staticProperties: sealedStaticPropertyOrder.filter((property) =>
    staticProperties.includes(property),
  ),
  ...(representationBound === undefined ? {} : { representationBound }),
})

/** Constructs one immutable canonical fixed-array type. */
export const fixedArray = (element: Type, length: number): FixedArray => ({
  _tag: 'FixedArrayType',
  element,
  length,
})

/** Constructs one canonical lexical slice type. */
export const slice = (
  access: Slice['access'],
  element: Type,
  lifetime: Lifetime.Lifetime,
): Slice => ({ _tag: 'SliceType', access, element, lifetime })

/** Constructs one canonical lexical whole-value reference. */
export const reference = (
  access: Reference['access'],
  target: Type,
  lifetime: Lifetime.Lifetime,
): Reference => ({ _tag: 'ReferenceType', access, target, lifetime })

/** Constructs one canonical raw pointer type. */
export const pointer = ({
  mutable,
  pointee,
  nullable,
  extent,
  alignment,
  addressSpace,
}: Omit<Pointer, '_tag'>): Pointer => ({
  _tag: 'PointerType',
  mutable,
  pointee,
  nullable,
  extent,
  alignment,
  addressSpace,
})

/** True for the explicit minimum alignments admitted by the native data-pointer contract. */
export const isPointerAlignment = (value: number): boolean =>
  Number.isSafeInteger(value) && value > 0 && value <= 536870912 && (value & (value - 1)) === 0

/** Compares the full address contract without conflating it with pointee identity. */
export const samePointerQualifiers = (self: Pointer, that: Pointer): boolean =>
  self.mutable === that.mutable &&
  self.nullable === that.nullable &&
  self.extent === that.extent &&
  self.alignment === that.alignment &&
  self.addressSpace === that.addressSpace

/** A safe immediate weakening; it never changes pointee identity or single/many extent. */
export const pointerQualifiersWeaken = (self: Pointer, that: Pointer): boolean =>
  (!that.mutable || self.mutable) &&
  (!self.nullable || that.nullable) &&
  self.extent === that.extent &&
  self.addressSpace === that.addressSpace &&
  (self.alignment === that.alignment ||
    that.alignment === 1 ||
    (typeof self.alignment === 'number' &&
      typeof that.alignment === 'number' &&
      self.alignment >= that.alignment))

const pointerQualifierKey = (self: Pointer): string =>
  `${self.extent}:${self.mutable ? 'mut' : 'const'}:${self.nullable ? 'nullable' : 'nonnull'}:${self.alignment}:${self.addressSpace}`

/** Constructs one immutable canonical callable contract. */
export const callable = (
  parameters_: ReadonlyArray<Type>,
  result: Type,
  lifetimes: ExecutableLifetimes,
  mode: CallableMode = 'Shared',
  schema?: CallableSchema,
  unsafe = false,
): Callable => ({
  _tag: 'CallableType',
  environment: lifetimes.environment,
  lifetimeBinders: [...lifetimes.lifetimeBinders],
  lifetimeBounds: Lifetime.assumptions(lifetimes.lifetimeBounds ?? []).bounds,
  // A well-formed borrowed input supplies validity of its stored parameters for that borrow.
  typeOutlives: normalizeTypeOutlives([
    ...(lifetimes.typeOutlives ?? []),
    ...parameters_.flatMap((parameter) => {
      if (isReference(parameter))
        return storageParameters(parameter.target).map((type) => ({
          type,
          lifetime: parameter.lifetime,
        }))
      if (isSlice(parameter))
        return storageParameters(parameter.element).map((type) => ({
          type,
          lifetime: parameter.lifetime,
        }))
      return []
    }),
  ]),
  unsafe,
  parameters: Array.from(parameters_),
  result,
  mode,
  ...(schema === undefined
    ? {}
    : {
        schema: {
          ...schema,
          binders: Array.from(schema.binders),
          constraints: Array.from(schema.constraints),
          evidence: Array.from(schema.evidence),
          substitution: new Map(schema.substitution),
          constraintKeys: Array.from(schema.constraintKeys),
          evidenceKeys: Array.from(schema.evidenceKeys),
          origins: Array.from(schema.origins),
        },
      }),
})

/** Constructs one immutable C ABI function-pointer type. */
export const foreignFunction = (
  parameters_: ReadonlyArray<Type>,
  result: Type,
  contract: ForeignContract.ForeignContract = ForeignContract.conservative,
  lifetimes: ExecutableLifetimes = { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
): ForeignFunction => ({
  _tag: 'ForeignFunctionType',
  environment: lifetimes.environment,
  lifetimeBinders: [...lifetimes.lifetimeBinders],
  lifetimeBounds: Lifetime.assumptions(lifetimes.lifetimeBounds ?? []).bounds,
  typeOutlives: normalizeTypeOutlives(lifetimes.typeOutlives ?? []),
  nullable: false,
  contract,
  abi: 'C',
  parameters: Array.from(parameters_),
  result,
})

const implicitRowOrigin: SourceSpan.SourceSpan = (() => {
  const span = SourceSpan.fromOffsets('$implicit-row', 0, 0)
  if (span === undefined) throw new RangeError('implicit row span is invalid')
  return span
})()

/**
 * The row members one failure type contributes: a structural union spreads into its members,
 * `never` contributes none, and everything else (including a nominal union) is one member. A row
 * spelled through a union alias is therefore the row its members would spell directly.
 */
export const failureLeaves = (failure: Type): ReadonlyArray<Type> => {
  if (isNever(failure)) return []
  return isUnion(failure) ? failure.members : [failure]
}

/** Constructs one normalized compiler-private lazy effect contract. */
export const effect = (
  success: Type,
  failures: ReadonlyArray<Type>,
  lifetimes: ExecutableLifetimes,
  access: Effect['access'] = 'Shared',
  requirements: ReadonlyArray<Requirement> = [],
  requirementParameters: ReadonlyArray<Parameter> = [],
): Effect => {
  const leaves = failures.flatMap(failureLeaves)
  const concreteFailures = leaves.filter(
    (failure) => !(isParameter(failure) && failure.kind === 'Value'),
  )
  const symbolicFailures = leaves.filter(
    (failure): failure is Parameter => isParameter(failure) && failure.kind === 'Value',
  )
  const normalized = FiniteRow.make<Type>(
    {
      collisionKey: key,
      memberKey: key,
      merge: (left) => left,
    },
    concreteFailures,
  )
  const concreteRequirements = requirements.filter((requirement) =>
    isNominal(requirement.capability),
  )
  const symbolicRequirements = requirements.filter((requirement) =>
    isParameter(requirement.capability),
  )
  const normalizedRequirements = FiniteRow.make<Requirement>(
    RequirementRow.policy<Nominal | Parameter>(key),
    concreteRequirements,
  )
  const normalizedRequirementParameters = [
    ...new Map(requirementParameters.map((parameter_) => [key(parameter_), parameter_])).values(),
  ].sort(compare)
  const failureRow = symbolicFailures.reduce<FailureRow>(
    (row, failure) =>
      RowAlgebra.union(
        failureRowPolicy(),
        row,
        RowAlgebra.singleton(failureRowPolicy(), failureMemberShape(failure), implicitRowOrigin),
      ),
    RowAlgebra.concrete(failureRowPolicy(), normalized.members),
  )
  const parameterizedRequirementRow = symbolicRequirements.reduce<RequirementsRow>(
    (row, requirement) =>
      isParameter(requirement.capability)
        ? RowAlgebra.union(
            requirementRowPolicy(),
            row,
            RowAlgebra.singleton(
              requirementRowPolicy(),
              requirementMemberShape(requirement.capability, requirement.access, requirement.role),
              implicitRowOrigin,
            ),
          )
        : row,
    RowAlgebra.concrete(requirementRowPolicy(), normalizedRequirements.members),
  )
  const requirementRow = normalizedRequirementParameters.reduce<RequirementsRow>(
    (row, parameter_) =>
      RowAlgebra.union(
        requirementRowPolicy(),
        row,
        RowAlgebra.parameter<Requirement, Parameter, RequirementMemberShape>(parameter_),
      ),
    parameterizedRequirementRow,
  )
  return {
    _tag: 'EffectType',
    environment: lifetimes.environment,
    lifetimeBinders: [...lifetimes.lifetimeBinders],
    lifetimeBounds: Lifetime.assumptions(lifetimes.lifetimeBounds ?? []).bounds,
    typeOutlives: normalizeTypeOutlives(lifetimes.typeOutlives ?? []),
    success,
    failureRow,
    requirementRow,
    access,
  }
}

/** Symbolic failure-row domain policy. */
export function failureRowPolicy(): RowAlgebra.Policy<
  Type,
  Parameter,
  FailureMemberShape,
  Parameter
> {
  return {
    finite: {
      collisionKey: key,
      memberKey: key,
      merge: (left: Type) => left,
    },
    concreteMemberMaySpecialize: typeMaySpecialize,
    rowParameterKey: key,
    symbolicMemberKey: (member: FailureMemberShape) => key(member.parameter),
    symbolicMemberParameters: (member: FailureMemberShape) => [member.parameter],
    memberParameterKey: key,
    memberWellFormedKey: (member: FailureMemberShape) =>
      Canonical.record('FailureMemberWellFormed', [key(member.parameter)]),
    allowsSetCancellation: true,
  }
}

/** Symbolic requirement-row domain policy with fixed access and role. */
export function requirementRowPolicy(): RowAlgebra.Policy<
  Requirement,
  Parameter,
  RequirementMemberShape,
  Parameter
> {
  return {
    finite: RequirementRow.policy<Nominal | Parameter>(key),
    concreteMemberMaySpecialize: (member: Requirement) => typeMaySpecialize(member.capability),
    concreteMembersAreDisjoint: (left: Requirement, right: Requirement) =>
      left.role !== right.role ||
      (isNominal(left.capability) &&
        isNominal(right.capability) &&
        (left.capability.module !== right.capability.module ||
          left.capability.name !== right.capability.name)),
    rowParameterKey: key,
    symbolicMemberKey: (member: RequirementMemberShape) =>
      Canonical.record('RequirementMemberShape', [
        member.access,
        RequirementRow.roleKey(member.role),
        key(member.capability),
      ]),
    symbolicMemberParameters: (member: RequirementMemberShape) => [member.capability],
    memberParameterKey: key,
    memberWellFormedKey: (member: RequirementMemberShape) =>
      Canonical.record('RequirementMemberWellFormed', [
        member.access,
        RequirementRow.roleKey(member.role),
        key(member.capability),
      ]),
    allowsSetCancellation: false,
  }
}

export const failureMemberShape = (parameter_: Parameter): FailureMemberShape => ({
  parameter: parameter_,
})

export const requirementMemberShape = (
  capability: Parameter,
  access: Requirement['access'],
  role: RequirementRow.Role,
): RequirementMemberShape => ({ capability, access, role })

/** Constructs an Effect directly from symbolic channel rows. */
export const effectWithRows = (
  success: Type,
  failureRow: FailureRow,
  lifetimes: ExecutableLifetimes,
  access: Effect['access'] = 'Shared',
  requirementRow: RequirementsRow = RowAlgebra.concrete(requirementRowPolicy(), []),
): Effect => {
  const concreteFailures = RowAlgebra.concretize(failureRowPolicy(), failureRow)
  const concreteRequirements = RowAlgebra.concretize(requirementRowPolicy(), requirementRow)
  const requirementParameters = RowAlgebra.parameters(requirementRowPolicy(), requirementRow).rows
  const base = effect(
    success,
    concreteFailures._tag === 'Concrete' ? concreteFailures.row.members : [],
    lifetimes,
    access,
    concreteRequirements._tag === 'Concrete' ? concreteRequirements.row.members : [],
    requirementParameters,
  )
  return { ...base, failureRow, requirementRow }
}

/** Constructs one normalized concrete requirement-row generic argument. */
export const requirementRowArgument = (
  requirements: ReadonlyArray<Requirement>,
  parameters: ReadonlyArray<Parameter> = [],
): RequirementRowArgument => {
  const row = parameters.reduce<RequirementsRow>(
    (current, parameter_) =>
      RowAlgebra.union(
        requirementRowPolicy(),
        current,
        RowAlgebra.parameter<Requirement, Parameter, RequirementMemberShape>(parameter_),
      ),
    RowAlgebra.concrete(requirementRowPolicy(), requirements),
  )
  return requirementRowArgumentFromRow(row)
}

/** Constructs one requirement-row argument without flattening computed row expressions. */
export const requirementRowArgumentFromRow = (row: RequirementsRow): RequirementRowArgument => {
  return {
    _tag: 'RequirementRowArgument',
    row,
  }
}

/** Concrete members projected from one symbolic failure row. */
const failureRowOf = (self: Effect | FailureRow): FailureRow =>
  'failureRow' in self ? self.failureRow : self

export const failureMembers = (self: Effect | FailureRow): ReadonlyArray<Type> =>
  RowAlgebra.concreteMembers(failureRowPolicy(), failureRowOf(self))

const isConcreteFailureCarrierMember = (self: Type): boolean => isRuntimeConcrete(self)

/** Selects one ordinary failure member under the carrier's explicit runtime tag convention. */
export const failureCarrierMember = (
  self: Type,
  tag: number,
  policy: FailureCarrierTagPolicy,
): Type | undefined => {
  if (!Number.isSafeInteger(tag)) return undefined
  const ordinal = policy === 'ZeroBased' ? tag : tag - 1
  if (ordinal < 0) return undefined
  if (isUnion(self))
    return policy === 'ZeroBased' && self.members.every(isConcreteFailureCarrierMember)
      ? self.members.at(ordinal)
      : undefined
  if (isEffect(self)) {
    if (policy !== 'OneBased' || !isRuntimeConcrete(self)) return undefined
    const failures = RowAlgebra.concretize(failureRowPolicy(), self.failureRow)
    return failures._tag === 'Concrete' &&
      failures.row.members.every(isConcreteFailureCarrierMember)
      ? failures.row.members.at(ordinal)
      : undefined
  }
  return policy === 'ZeroBased' && ordinal === 0 && isConcreteFailureCarrierMember(self)
    ? self
    : undefined
}

/** Ordinary type parameters used as symbolic members of one failure union. */
export const failureMemberParameters = (self: Effect | FailureRow): ReadonlyArray<Parameter> =>
  RowAlgebra.parameters(failureRowPolicy(), failureRowOf(self)).members

/** Presents one failure union as the ordinary value type carried by its outcome channel. */
export const failureType = (self: Effect | FailureRow): Type => {
  const concrete = failureMembers(self)
  const symbolic = failureMemberParameters(self)
  if (concrete.length === 0 && symbolic.length === 1) return symbolic[0] ?? 'never'
  const normalized = union([...concrete, ...symbolic])
  return normalized._tag === 'Normalized' ? normalized.type : 'never'
}

/** Concrete members projected from one symbolic requirement row. */
export const requirementMembers = (
  self: Effect | RequirementRowArgument,
): ReadonlyArray<Requirement> =>
  RowAlgebra.concreteMembers(
    requirementRowPolicy(),
    self._tag === 'EffectType' ? self.requirementRow : self.row,
  )

/** Concrete requirements retained positively rather than only named by a computed subtraction. */
export const positiveRequirementMembers = (
  self: Effect | RequirementRowArgument,
): ReadonlyArray<Requirement> =>
  RowAlgebra.positiveConcreteMembers(
    requirementRowPolicy(),
    self._tag === 'EffectType' ? self.requirementRow : self.row,
  )

/** Whole-row parameters projected from one symbolic requirement row. */
export const requirementRowParameters = (
  self: Effect | RequirementRowArgument,
): ReadonlyArray<Parameter> =>
  RowAlgebra.parameters(
    requirementRowPolicy(),
    self._tag === 'EffectType' ? self.requirementRow : self.row,
  ).rows

export const effectIdentityArgument = (
  identity: string,
  owner?: ExecutableSpecializationOwner,
): EffectIdentityArgument => ({
  _tag: 'EffectIdentityArgument',
  identity,
  ...(owner === undefined
    ? {}
    : {
        owner: {
          declaration: { ...owner.declaration },
          typeArguments: Array.from(owner.typeArguments),
          staticArgumentKeys: Array.from(owner.staticArgumentKeys),
        },
      }),
})

/** Constructs the stable structural site of one callable capture environment. */
export const callableEnvironmentSite = (
  declaration: { readonly module: string; readonly name: string } | undefined,
  functionOrdinal: number,
  ordinal: number,
): CallableEnvironmentSite =>
  declaration === undefined
    ? {
        _tag: 'RecoveredCallableEnvironmentSite',
        functionOrdinal,
        ordinal,
      }
    : {
        _tag: 'DeclaredCallableEnvironmentSite',
        declaration: { ...declaration },
        ordinal,
      }

/** Constructs the complete specialization identity of one callable capture environment. */
export const callableEnvironmentIdentity = (
  site: CallableEnvironmentSite,
  owner: CallableEnvironmentIdentity['owner'],
): CallableEnvironmentIdentity => ({
  _tag: 'CallableEnvironmentIdentity',
  site,
  owner: {
    declaration: { ...owner.declaration },
    typeArguments: Array.from(owner.typeArguments),
    staticArgumentKeys: Array.from(owner.staticArgumentKeys),
  },
})

export const callableIdentityArgument = (
  identity: string,
  target: CallableIdentityArgument['target'],
  typeArguments: ReadonlyArray<GenericArgument> = [],
  environment?: CallableEnvironmentIdentity,
): CallableIdentityArgument => ({
  _tag: 'CallableIdentityArgument',
  identity: environment === undefined ? identity : callableEnvironmentKey(environment),
  target: target,
  typeArguments: Array.from(typeArguments),
  ...(environment === undefined ? {} : { environment }),
})

/** Constructs an open representation argument owned by one representation parameter. */
export const representationParameterArgument = (
  parameter_: Parameter,
): RepresentationParameterArgument => ({
  _tag: 'RepresentationParameterArgument',
  parameter: parameter_,
})

/** Constructs one opaque family instance from canonical producer and enclosing arguments. */
export const opaqueRepresentationArgument = (
  family: OpaqueFamilyKey,
  contract: RepresentationBound,
  arguments_: ReadonlyArray<GenericArgument>,
): OpaqueRepresentationArgument => ({
  _tag: 'OpaqueRepresentationArgument',
  family: {
    _tag: 'OpaqueFamilyKey',
    producer: { ...family.producer },
    binderOrdinal: family.binderOrdinal,
  },
  contract,
  arguments: Array.from(arguments_),
})

/** Constructs one exact representation argument without mixing its identity with a use bound. */
export const exactRepresentationArgument = (
  identity: EffectIdentityArgument | CallableIdentityArgument,
  contract: RepresentationBound,
): ExactRepresentationArgument => ({ _tag: 'ExactRepresentationArgument', identity, contract })

/** Constructs one canonical finite Effect representation from exact alternatives. */
export const compositeEffectRepresentationArgument = (
  contract: Effect,
  alternatives: ReadonlyArray<ExactRepresentationArgument>,
): CompositeEffectRepresentationArgument => ({
  _tag: 'CompositeEffectRepresentationArgument',
  contract,
  alternatives: [
    ...new Map(
      alternatives.map((alternative) => [genericArgumentKey(alternative), alternative]),
    ).values(),
  ].sort((left, right) => genericArgumentKey(left).localeCompare(genericArgumentKey(right))),
})

/** Reifies one declaration parameter as an open generic argument of the same kind. */
export const parameterArgument = (self: Parameter): GenericArgument => {
  switch (self.kind) {
    case 'Lifetime':
      return Lifetime.bound(self.owner, self.ordinal, self.name)
    case 'Value':
      return self
    case 'RequirementRow':
      return requirementRowArgument([], [self])
    case 'CallableRepresentation':
    case 'EffectRepresentation':
      return representationParameterArgument(self)
  }
}

/** Ranks access modes: Shared(0) < Exclusive(1) < Take(2). */
export const accessRank = (access: CallableMode | Effect['access']): number => {
  switch (access) {
    case 'Shared':
      return 0
    case 'Exclusive':
      return 1
    case 'Take':
      return 2
  }
}

/** True when the supplied access is at least as strong as the required one. */
export const compareAccess = (
  supplied: CallableMode | Effect['access'],
  required: CallableMode | Effect['access'],
): boolean => accessRank(supplied) >= accessRank(required)

/** True when one requirement is satisfied by a supplied requirement with compatible access. */
export const requirementSatisfies = (
  supplied: { readonly access: 'Shared' | 'Exclusive' | 'Take' },
  required: { readonly access: 'Shared' | 'Exclusive' },
): boolean => compareAccess(supplied.access, required.access)

/**
 * Intersects two uses of one representation contract. The result keeps the most restrictive
 * access while rejecting structurally unrelated callable or Effect contracts.
 */
export const intersectRepresentationBounds = (
  left: RepresentationBound,
  right: RepresentationBound,
): RepresentationBound | undefined => {
  if (left._tag === 'CallableType' && right._tag === 'CallableType') {
    let access = right.mode
    if (accessRank(left.mode) <= accessRank(right.mode)) access = left.mode
    const leftShape = callable(
      left.parameters,
      left.result,
      left,
      'Shared',
      left.schema,
      left.unsafe,
    )
    const rightShape = callable(
      right.parameters,
      right.result,
      right,
      'Shared',
      right.schema,
      right.unsafe,
    )
    return equals(leftShape, rightShape)
      ? callable(left.parameters, left.result, left, access, left.schema, left.unsafe)
      : undefined
  }
  if (left._tag === 'EffectType' && right._tag === 'EffectType') {
    let access = right.access
    if (accessRank(left.access) <= accessRank(right.access)) access = left.access
    const leftShape = effectWithRows(
      left.success,
      left.failureRow,
      left,
      'Shared',
      left.requirementRow,
    )
    const rightShape = effectWithRows(
      right.success,
      right.failureRow,
      right,
      'Shared',
      right.requirementRow,
    )
    return equals(leftShape, rightShape)
      ? effectWithRows(left.success, left.failureRow, left, access, left.requirementRow)
      : undefined
  }
  return undefined
}

/** Checks contextual lifetime/quantifier validity and the shared/exclusive/take ordering. */
export const representationAdmissibility = (
  contract: RepresentationBound,
  requiredBound: RepresentationBound,
  context?: TypeCompatibility.Context,
): RepresentationAdmissibility => {
  if (contract._tag !== requiredBound._tag)
    return { _tag: 'Unavailable', reason: 'representation kind mismatch' }
  let structuralContract: RepresentationBound | undefined
  let requiredAccess: CallableMode | Effect['access']
  let actualAccess: CallableMode | Effect['access']
  if (contract._tag === 'CallableType' && requiredBound._tag === 'CallableType') {
    // A safe callable satisfies an unsafe bound (it asks less of the caller); the reverse does not.
    structuralContract = callable(
      contract.parameters,
      contract.result,
      contract,
      requiredBound.mode,
      contract.schema,
      contract.unsafe || requiredBound.unsafe,
    )
    requiredAccess = requiredBound.mode
    actualAccess = contract.mode
  } else if (contract._tag === 'EffectType' && requiredBound._tag === 'EffectType') {
    structuralContract = effectWithRows(
      contract.success,
      contract.failureRow,
      contract,
      requiredBound.access,
      contract.requirementRow,
    )
    requiredAccess = requiredBound.access
    actualAccess = contract.access
  } else {
    return { _tag: 'Unavailable', reason: 'representation kind mismatch' }
  }
  return structuralContract !== undefined &&
    TypeCompatibility.isCompatible(
      TypeCompatibility.check(structuralContract, requiredBound, context),
    ) &&
    compareAccess(requiredAccess, actualAccess)
    ? { _tag: 'Admitted' }
    : { _tag: 'Unavailable', reason: 'representation contract mismatch' }
}

/** Constructs a represented callable or Effect value at one required use bound. */
export const represented = (
  contract: RepresentationBound,
  requiredBound: RepresentationBound,
  argument: RepresentationArgument,
  compatibility?: TypeCompatibility.Context,
): Represented => {
  const admissibility = representationAdmissibility(contract, requiredBound, compatibility)
  let resolvedAdmissibility: RepresentationAdmissibility = admissibility
  if (argument._tag === 'RepresentationParameterArgument' && admissibility._tag === 'Admitted') {
    resolvedAdmissibility = { _tag: 'Open' }
  }
  return {
    _tag: 'RepresentedType',
    contract,
    representation: {
      requiredBound,
      argument,
      admissibility: resolvedAdmissibility,
    },
  }
}

/** Constructs a kinded recovery placeholder for damaged or unresolved generic syntax. */
export const unavailableGenericArgument = (
  expectedKind: ParameterKind,
  reason: string,
): UnavailableGenericArgument => ({ _tag: 'UnavailableGenericArgument', expectedKind, reason })

export const isRequirementRowArgument = (self: GenericArgument): self is RequirementRowArgument =>
  typeof self !== 'string' && self._tag === 'RequirementRowArgument'

export const isEffectIdentityArgument = (self: GenericArgument): self is EffectIdentityArgument =>
  typeof self !== 'string' && self._tag === 'EffectIdentityArgument'

export const isCallableIdentityArgument = (
  self: GenericArgument,
): self is CallableIdentityArgument =>
  typeof self !== 'string' && self._tag === 'CallableIdentityArgument'

export const isRepresentationParameterArgument = (
  self: GenericArgument,
): self is RepresentationParameterArgument =>
  typeof self !== 'string' && self._tag === 'RepresentationParameterArgument'

export const isOpaqueRepresentationArgument = (
  self: GenericArgument,
): self is OpaqueRepresentationArgument =>
  typeof self !== 'string' && self._tag === 'OpaqueRepresentationArgument'

/** Returns the canonical source identity shared by every specialization of one opaque family. */
export const opaqueFamilyKey = (self: OpaqueFamilyKey): string =>
  Canonical.record('OpaqueFamily', [
    Canonical.record('Producer', [self.producer.module, self.producer.name]),
    String(self.binderOrdinal),
  ])

/** Tests family identity without consulting a realization or any source location. */
export const equalsOpaqueFamily = (left: OpaqueFamilyKey, right: OpaqueFamilyKey): boolean =>
  opaqueFamilyKey(left) === opaqueFamilyKey(right)

export const isExactRepresentationArgument = (
  self: GenericArgument,
): self is ExactRepresentationArgument =>
  typeof self !== 'string' && self._tag === 'ExactRepresentationArgument'

export const isCompositeEffectRepresentationArgument = (
  self: GenericArgument,
): self is CompositeEffectRepresentationArgument =>
  typeof self !== 'string' && self._tag === 'CompositeEffectRepresentationArgument'

export const isRepresentationArgument = (self: GenericArgument): self is RepresentationArgument =>
  isRepresentationParameterArgument(self) ||
  isOpaqueRepresentationArgument(self) ||
  isExactRepresentationArgument(self) ||
  isCompositeEffectRepresentationArgument(self)

export const isUnavailableGenericArgument = (
  self: GenericArgument,
): self is UnavailableGenericArgument =>
  typeof self !== 'string' && self._tag === 'UnavailableGenericArgument'

/** Returns the callable/Effect generic kind carried by one representation argument. */
export const representationArgumentKind = (
  self: RepresentationArgument,
): 'CallableRepresentation' | 'EffectRepresentation' => {
  if (self._tag === 'RepresentationParameterArgument') {
    if (self.parameter.kind === 'EffectRepresentation') return 'EffectRepresentation'
    return 'CallableRepresentation'
  }
  if (self.contract._tag === 'EffectType') return 'EffectRepresentation'
  return 'CallableRepresentation'
}

/** Returns the declared executable contract carried by one representation argument. */
export const representationArgumentContract = (
  self: RepresentationArgument,
): RepresentationBound | undefined =>
  self._tag === 'RepresentationParameterArgument'
    ? self.parameter.representationBound
    : self.contract

/** Reifies one executable representation argument as its exact runtime value type. */
export const representedType = (self: GenericArgument): Represented | undefined => {
  if (!isRepresentationArgument(self)) return undefined
  const contract = representationArgumentContract(self)
  return contract === undefined ? undefined : represented(contract, contract, self)
}

export const isHiddenIdentityArgument = (
  self: GenericArgument,
): self is EffectIdentityArgument | CallableIdentityArgument =>
  isEffectIdentityArgument(self) || isCallableIdentityArgument(self)

/** Identifies executable representation evidence appended outside declaration type parameters. */
export const isHiddenExecutableArgument = (
  self: GenericArgument,
): self is
  | EffectIdentityArgument
  | CallableIdentityArgument
  | CompositeEffectRepresentationArgument =>
  isHiddenIdentityArgument(self) || isCompositeEffectRepresentationArgument(self)

export const isTypeArgument = (self: GenericArgument): self is OrdinaryType =>
  !Lifetime.isLifetime(self) &&
  !isRequirementRowArgument(self) &&
  !isHiddenIdentityArgument(self) &&
  !isRepresentationArgument(self) &&
  !isUnavailableGenericArgument(self) &&
  !(isParameter(self) && self.kind !== 'Value') &&
  !(typeof self !== 'string' && self._tag === 'RepresentedType')

/** Reads one ordinary type argument without erasing the other generic argument kinds. */
export const typeArgumentAt = (self: Nominal, ordinal: number): Type | undefined => {
  const argument = self.arguments.at(ordinal)
  return argument !== undefined && isTypeArgument(argument) ? argument : undefined
}

/** Returns the canonical deterministic identity of any erased generic argument. */
const callableEnvironmentSiteKey = (self: CallableEnvironmentSite): string =>
  self._tag === 'DeclaredCallableEnvironmentSite'
    ? `declaration:${self.declaration.module}.${self.declaration.name}:site:${self.ordinal}`
    : `recovered:${self.functionOrdinal}:site:${self.ordinal}`

/** Returns the deterministic identity of one specialized callable capture environment. */
const executableOwnerStaticKey = (self: ExecutableSpecializationOwner): string =>
  self.staticArgumentKeys.length === 0 ? '' : `:static=${Canonical.array(self.staticArgumentKeys)}`

export const callableEnvironmentKey = (self: CallableEnvironmentIdentity): string =>
  `${callableEnvironmentSiteKey(self.site)}:owner=${self.owner.declaration.module}.${self.owner.declaration.name}<${self.owner.typeArguments.map(genericArgumentKey).join(',')}>${executableOwnerStaticKey(self.owner)}`

/** Tests complete callable-environment specialization identity. */
export const equalsCallableEnvironmentIdentity = (
  left: CallableEnvironmentIdentity,
  right: CallableEnvironmentIdentity,
): boolean => callableEnvironmentKey(left) === callableEnvironmentKey(right)

const callableIdentityKey = (self: CallableIdentityArgument): string =>
  [
    'callable-identity:',
    self.identity,
    ':target=',
    self.target._tag === 'Declaration'
      ? `declaration:${self.target.module}.${self.target.name}`
      : `builtin:${self.target.actor}.${self.target.operation}:${self.target.intrinsic.actor}.${self.target.intrinsic.name}`,
    ':arguments=<',
    self.typeArguments.map(genericArgumentKey).join(','),
    '>:environment=',
    self.environment === undefined ? '' : callableEnvironmentKey(self.environment),
  ].join('')

/** Memoized on the argument object itself, like `key`. */
const cachedGenericArgumentKey: unique symbol = Symbol('Type.genericArgumentKey')

export const genericArgumentKey = (self: GenericArgument): string => {
  if (typeof self === 'string') return computeGenericArgumentKey(self)
  const cached: unknown = Reflect.get(self, cachedGenericArgumentKey)
  if (typeof cached === 'string') return cached
  const computed = computeGenericArgumentKey(self)
  if (Object.isExtensible(self))
    Object.defineProperty(self, cachedGenericArgumentKey, { value: computed })
  return computed
}

const computeGenericArgumentKey = (self: GenericArgument): string => {
  if (Lifetime.isLifetime(self)) return Lifetime.key(self)
  if (isUnavailableGenericArgument(self)) return `unavailable:${self.expectedKind}:${self.reason}`
  if (isRepresentationParameterArgument(self))
    return `representation-parameter:${key(self.parameter)}`
  if (isOpaqueRepresentationArgument(self)) {
    return Canonical.record('OpaqueRepresentation', [
      opaqueFamilyKey(self.family),
      Canonical.array(self.arguments.map(genericArgumentKey)),
      key(self.contract),
    ])
  }
  if (isExactRepresentationArgument(self))
    return `exact-representation:${genericArgumentKey(self.identity)}:${key(self.contract)}`
  if (isCompositeEffectRepresentationArgument(self)) {
    return Canonical.record('CompositeEffectRepresentation', [
      key(self.contract),
      Canonical.array(self.alternatives.map(genericArgumentKey)),
    ])
  }
  if (isEffectIdentityArgument(self)) {
    if (self.owner === undefined) return `effect-identity:${self.identity}`
    return `effect-identity:${self.identity}:owner=${self.owner.declaration.module}.${self.owner.declaration.name}<${self.owner.typeArguments.map(genericArgumentKey).join(',')}>${executableOwnerStaticKey(self.owner)}`
  }
  if (isCallableIdentityArgument(self)) return callableIdentityKey(self)
  if (isRequirementRowArgument(self))
    return `requirement-row:${RowAlgebra.key(requirementRowPolicy(), self.row)}`
  return key(self)
}

/** Encodes any erased generic argument for semantic presentation and artifact inspection. */
export const encodeGenericArgument = (self: GenericArgument): string => {
  if (Lifetime.isLifetime(self)) return Lifetime.display(self)
  if (isUnavailableGenericArgument(self))
    return `<unavailable ${self.expectedKind}: ${self.reason}>`
  if (isRepresentationParameterArgument(self)) return self.parameter.name
  if (isOpaqueRepresentationArgument(self))
    return `some(${self.family.producer.module}.${self.family.producer.name}#${self.family.binderOrdinal})`
  if (isExactRepresentationArgument(self))
    return `typeof(${encodeRepresentationOrigin(self.identity)})`
  if (isCompositeEffectRepresentationArgument(self))
    return `oneof(${self.alternatives.map(encodeGenericArgument).join(', ')})`
  if (isEffectIdentityArgument(self)) return `effect@${self.identity}`
  if (isCallableIdentityArgument(self)) return `callable@${self.identity}`
  if (isRequirementRowArgument(self)) {
    return `? ${RowAlgebra.encode(
      requirementRowPolicy(),
      self.row,
      (requirement) =>
        `${requirement.access === 'Exclusive' ? '&mut ' : '&'}${encode(requirement.capability)}${requirement.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(requirement.role)}`}`,
      (parameter_) => parameter_.name,
      (member) =>
        `${member.access === 'Exclusive' ? '&mut ' : '&'}${member.capability.name}${member.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(member.role)}`}`,
    )}`
  }
  return encode(self)
}

const encodeRepresentationOrigin = (
  self: EffectIdentityArgument | CallableIdentityArgument,
): string => {
  if (self._tag === 'EffectIdentityArgument') return self.identity
  let target: string
  if (self.target._tag === 'Declaration') target = `${self.target.module}.${self.target.name}`
  else target = `${self.target.actor}.${self.target.operation}`
  const environment =
    self.environment === undefined ? '' : `@${callableEnvironmentKey(self.environment)}`
  return `${target}${environment}`
}

const compareText = (left: string, right: string): number => {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

/** Compares any kinded generic arguments by canonical structural identity. */
export const compareGenericArgument = (left: GenericArgument, right: GenericArgument): number =>
  compareText(genericArgumentKey(left), genericArgumentKey(right))

/** Tests canonical structural equality across all generic argument kinds. */
export const equalsGenericArgument = (left: GenericArgument, right: GenericArgument): boolean =>
  genericArgumentKey(left) === genericArgumentKey(right)

/** Computes one deterministic unsigned FNV-1a hash of a canonical generic argument key. */
export const hashGenericArgument = (self: GenericArgument): number => {
  const value = genericArgumentKey(self)
  let hash = 0x811c9dc5
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return hash >>> 0
}

/** Tests whether a finite union member has an admitted runtime value representation. */
export const isUnionMemberType = (self: Type): boolean => {
  if (isSlot(self)) return false
  if (isSlice(self) || isReference(self)) return self.access === 'Shared'
  if (isCallable(self) || isEffect(self)) return false
  if (isForeignFunction(self)) return true
  if (isRepresented(self)) return self.representation.admissibility._tag !== 'Unavailable'
  if (isFixedArray(self)) return isUnionMemberType(self.element)
  // A nominal member has its own finite identity. Whether one concrete application can be stored
  // depends on its declared fields and representation evidence, so layout/ownership must retain
  // that later diagnostic boundary instead of rejecting the type argument here.
  if (isNominal(self)) return true
  if (isUnion(self)) return self.members.every(isUnionMemberType)
  return true
}

/** Normalizes a finite union of admitted ordinary value types. */
export const union = (inputs: ReadonlyArray<Type>): UnionNormalization => {
  const members: Array<Type> = []
  const invalid: Array<Type> = []
  const visit = (input: Type): void => {
    if (input === 'never') return
    if (isUnion(input)) {
      for (const member of input.members) visit(member)
      return
    }
    if (!isUnionMemberType(input)) {
      invalid.push(input)
      return
    }
    members.push(input)
  }
  for (const input of inputs) visit(input)
  if (invalid.length > 0) return { _tag: 'InvalidMembers', members: invalid }
  const normalized = FiniteRow.make<Type>(
    { collisionKey: key, memberKey: key, merge: (left) => left },
    members,
  ).members
  if (normalized.length === 0) return { _tag: 'Normalized', type: 'never' }
  const singleton = normalized.at(0)
  if (normalized.length === 1 && singleton !== undefined)
    return { _tag: 'Normalized', type: singleton }
  return {
    _tag: 'Normalized',
    type: {
      _tag: 'StructuralUnionType',
      members: normalized,
      [structuralUnionBrand]: true as const,
    },
  }
}

/** Tests whether a semantic type is one of the executable built-in scalars. */
export const isBuiltin = (self: unknown): self is Builtin => Scalar.isSpelling(self)

/** Tests whether a semantic type is the canonical immutable UTF-8 string view. */
export const isString = (self: unknown): self is String =>
  typeof self === 'object' && self !== null && '_tag' in self && self._tag === 'StringType'

/** Tests whether a semantic type is the empty structural union. */
export const isNever = (self: Type): self is Bottom => self === 'never'

/** Tests whether a semantic type is a canonical nominal struct. */
export const isNominal = (self: Type): self is Nominal =>
  typeof self !== 'string' && self._tag === 'NominalType'

/** Tests whether a semantic type is a declaration-owned generic parameter. */
export const isParameter = (self: Type): self is Parameter =>
  typeof self !== 'string' && self._tag === 'TypeParameter'

/** Tests whether a semantic type is a structural fixed array. */
export const isFixedArray = (self: Type): self is FixedArray =>
  typeof self !== 'string' && self._tag === 'FixedArrayType'

/** Tests whether a semantic type is a lexical runtime slice. */
export const isSlice = (self: Type): self is Slice =>
  typeof self !== 'string' && self._tag === 'SliceType'

/** Tests whether a semantic type is a lexical whole-value reference. */
export const isReference = (self: Type): self is Reference =>
  typeof self !== 'string' && self._tag === 'ReferenceType'

/** Tests whether a semantic type is a raw pointer. */
export const isPointer = (self: Type): self is Pointer =>
  typeof self !== 'string' && self._tag === 'PointerType'

/** Tests whether a semantic type is a structural callable contract. */
export const isCallable = (self: Type): self is Callable =>
  typeof self !== 'string' && self._tag === 'CallableType'

/** Tests whether a semantic type is a C ABI function pointer. */
export const isForeignFunction = (self: Type): self is ForeignFunction =>
  typeof self !== 'string' && self._tag === 'ForeignFunctionType'

/** Tests whether a semantic type is a compiler-private lazy effect contract. */
export const isEffect = (self: Type): self is Effect =>
  typeof self !== 'string' && self._tag === 'EffectType'

/** Tests whether a value type carries a statically known executable representation. */
export const isRepresented = (self: Type): self is Represented =>
  typeof self !== 'string' && self._tag === 'RepresentedType'

/** Tests whether a semantic type is a normalized multi-member structural union. */
export const isUnion = (self: Type): self is StructuralUnion =>
  typeof self !== 'string' && self._tag === 'StructuralUnionType'

const semanticTypeTags: ReadonlySet<string> = new Set([
  'StringType',
  'NominalType',
  'TypeParameter',
  'FixedArrayType',
  'SliceType',
  'ReferenceType',
  'PointerType',
  'CallableType',
  'ForeignFunctionType',
  'EffectType',
  'RepresentedType',
  'StructuralUnionType',
])

const hasTypeDiscriminant = (self: unknown): self is Type =>
  isString(self) ||
  isBuiltin(self) ||
  self === 'never' ||
  (typeof self === 'object' &&
    self !== null &&
    '_tag' in self &&
    typeof self._tag === 'string' &&
    semanticTypeTags.has(self._tag))

/**
 * Each immutable type object carries its canonical key once computed, in a non-enumerable
 * property that spreads, clones and structural comparisons never see. Most keyed types are
 * fresh substitution results keyed once: a weak map paid an ephemeron insertion per type and
 * made every major collection trace the table.
 */
const cachedKey: unique symbol = Symbol('Type.key')

/** Returns the canonical deterministic key used for equality and ordering. */
export const key = (self: Type): string => {
  if (typeof self === 'string') return computeKey(self)
  const cached: unknown = Reflect.get(self, cachedKey)
  if (typeof cached === 'string') return cached
  const computed = computeKey(self)
  if (Object.isExtensible(self)) Object.defineProperty(self, cachedKey, { value: computed })
  return computed
}

/**
 * Admits one immutable semantic type from untyped compiler data.
 *
 * Object-shaped types must be canonical values whose complete key traversal succeeds. This keeps malformed lookalikes from crossing static-value admission.
 */
export const fromUnknown = (self: unknown): Type | undefined => {
  if (!hasTypeDiscriminant(self)) return undefined
  try {
    key(self)
    return self
  } catch {
    return undefined
  }
}

/** The canonical identity of one provider's application of an interface. */
export const conformanceKey = (capability: Nominal, provider: Type): string =>
  `${key(capability)}\u0000${key(provider)}`

const computeKey = (self: Type): string => {
  if (isString(self)) return `string<${Lifetime.key(self.lifetime)}>`
  if (isBuiltin(self)) return `builtin:${self}`
  if (isNever(self)) return 'union:'
  if (isNominal(self))
    return `${self.sealed === undefined ? 'nominal' : `sealed:${self.sealed}`}:${self.module}.${self.name}<${self.arguments.map(genericArgumentKey).join(',')}>`
  if (isParameter(self) && self.kind === 'Lifetime')
    return Lifetime.key(Lifetime.bound(self.owner, self.ordinal, self.name))
  if (isParameter(self))
    return `parameter:${self.kind}:${self.owner.module}.${self.owner.name}:${self.ordinal}:properties=${self.staticProperties.join('+')}`
  if (isFixedArray(self)) return `array:${self.length}<${key(self.element)}>`
  if (isSlice(self))
    return `slice:${self.access}<${Lifetime.key(self.lifetime)};${key(self.element)}>`
  if (isReference(self))
    return `reference:${self.access}<${Lifetime.key(self.lifetime)};${key(self.target)}>`
  if (isPointer(self)) return `pointer:${pointerQualifierKey(self)}<${key(self.pointee)}>`
  if (isCallable(self)) {
    const schema = self.schema
    const schemaKey =
      schema === undefined
        ? ''
        : Canonical.record('QuantifiedCallableSchema', [
            schema.source === undefined
              ? ''
              : Canonical.array([schema.source.module, schema.source.name]),
            schema.contractKey,
            Canonical.array(schema.constraintKeys),
            Canonical.array(schema.evidenceKeys),
            Canonical.array(
              [...schema.substitution.entries()]
                .sort(([left], [right]) => compareText(left, right))
                .map(([parameter_, argument]) =>
                  Canonical.record('SubstitutionEntry', [parameter_, genericArgumentKey(argument)]),
                ),
            ),
          ])
    return `${executableLifetimeKey(self)}callable:${self.unsafe ? 'unsafe:' : 'safe:'}${self.mode}<(${self.parameters.map(key).join(',')})->${key(self.result)}>${schemaKey}`
  }
  if (isForeignFunction(self))
    return `foreign:${executableLifetimeKey(self)}C:nonnull:${ForeignContract.key(self.contract)}<(${self.parameters.map(key).join(',')})->${key(self.result)}>`
  if (isEffect(self))
    return `${executableLifetimeKey(self)}effect:${self.access}<${key(self.success)}!${RowAlgebra.key(
      failureRowPolicy(),
      self.failureRow,
    )}?${RowAlgebra.key(requirementRowPolicy(), self.requirementRow)}>`
  // A callable use bound (`fn` versus `once fn`) selects the stored field's invocation and cleanup
  // realization, so one exact callable admitted under two bounds is two field types.
  if (isRepresented(self))
    return `represented:${key(self.contract)}:${
      isCallable(self.representation.requiredBound)
        ? `${key(self.representation.requiredBound)}:`
        : ''
    }${genericArgumentKey(self.representation.argument)}`
  return `union:${self.members.map(key).join('|')}`
}

/** Compares semantic types by canonical identity. */
export const equals = (left: Type, right: Type): boolean => key(left) === key(right)

export interface RepresentationDivergence {
  readonly left: RepresentationArgument
  readonly right: RepresentationArgument
}

const genericArgumentRepresentationDivergence = (
  left: GenericArgument,
  right: GenericArgument,
): RepresentationDivergence | undefined => {
  if (isRepresentationArgument(left) || isRepresentationArgument(right)) {
    if (!isRepresentationArgument(left) || !isRepresentationArgument(right)) return undefined
    if (equalsGenericArgument(left, right)) return undefined
    return { left, right }
  }
  if (isRequirementRowArgument(left) && isRequirementRowArgument(right)) {
    for (
      let ordinal = 0;
      ordinal < Math.min(requirementMembers(left).length, requirementMembers(right).length);
      ordinal += 1
    ) {
      const leftRequirement = requirementMembers(left).at(ordinal)
      const rightRequirement = requirementMembers(right).at(ordinal)
      if (leftRequirement === undefined || rightRequirement === undefined) continue
      const divergence = firstRepresentationDivergence(
        leftRequirement.capability,
        rightRequirement.capability,
      )
      if (divergence !== undefined) return divergence
    }
    return undefined
  }
  return isTypeArgument(left) && isTypeArgument(right)
    ? firstRepresentationDivergence(left, right)
    : undefined
}

/** Finds the first source-independent representation mismatch in structural type order. */
export const firstRepresentationDivergence = (
  left: Type,
  right: Type,
): RepresentationDivergence | undefined => {
  if (isRepresented(left) && isRepresented(right))
    return genericArgumentRepresentationDivergence(
      left.representation.argument,
      right.representation.argument,
    )
  if (isNominal(left) && isNominal(right)) {
    if (left.module !== right.module || left.name !== right.name) return undefined
    for (
      let ordinal = 0;
      ordinal < Math.min(left.arguments.length, right.arguments.length);
      ordinal += 1
    ) {
      const leftArgument = left.arguments.at(ordinal)
      const rightArgument = right.arguments.at(ordinal)
      if (leftArgument === undefined || rightArgument === undefined) continue
      const divergence = genericArgumentRepresentationDivergence(leftArgument, rightArgument)
      if (divergence !== undefined) return divergence
    }
    return undefined
  }
  if (isFixedArray(left) && isFixedArray(right))
    return firstRepresentationDivergence(left.element, right.element)
  if (isSlice(left) && isSlice(right))
    return firstRepresentationDivergence(left.element, right.element)
  if (isReference(left) && isReference(right))
    return firstRepresentationDivergence(left.target, right.target)
  if (isPointer(left) && isPointer(right))
    return firstRepresentationDivergence(left.pointee, right.pointee)
  if (isForeignFunction(left) && isForeignFunction(right)) {
    for (
      let ordinal = 0;
      ordinal < Math.min(left.parameters.length, right.parameters.length);
      ordinal += 1
    ) {
      const leftParameter = left.parameters.at(ordinal)
      const rightParameter = right.parameters.at(ordinal)
      if (leftParameter === undefined || rightParameter === undefined) continue
      const divergence = firstRepresentationDivergence(leftParameter, rightParameter)
      if (divergence !== undefined) return divergence
    }
    return firstRepresentationDivergence(left.result, right.result)
  }
  if (isCallable(left) && isCallable(right)) {
    for (
      let ordinal = 0;
      ordinal < Math.min(left.parameters.length, right.parameters.length);
      ordinal += 1
    ) {
      const leftParameter = left.parameters.at(ordinal)
      const rightParameter = right.parameters.at(ordinal)
      if (leftParameter === undefined || rightParameter === undefined) continue
      const divergence = firstRepresentationDivergence(leftParameter, rightParameter)
      if (divergence !== undefined) return divergence
    }
    return firstRepresentationDivergence(left.result, right.result)
  }
  if (isEffect(left) && isEffect(right)) {
    const success = firstRepresentationDivergence(left.success, right.success)
    if (success !== undefined) return success
    for (
      let ordinal = 0;
      ordinal < Math.min(failureMembers(left).length, failureMembers(right).length);
      ordinal += 1
    ) {
      const leftFailure = failureMembers(left).at(ordinal)
      const rightFailure = failureMembers(right).at(ordinal)
      if (leftFailure === undefined || rightFailure === undefined) continue
      const divergence = firstRepresentationDivergence(leftFailure, rightFailure)
      if (divergence !== undefined) return divergence
    }
    for (
      let ordinal = 0;
      ordinal < Math.min(requirementMembers(left).length, requirementMembers(right).length);
      ordinal += 1
    ) {
      const leftRequirement = requirementMembers(left).at(ordinal)
      const rightRequirement = requirementMembers(right).at(ordinal)
      if (leftRequirement === undefined || rightRequirement === undefined) continue
      const divergence = firstRepresentationDivergence(
        leftRequirement.capability,
        rightRequirement.capability,
      )
      if (divergence !== undefined) return divergence
    }
    return undefined
  }
  if (isUnion(left) && isUnion(right)) {
    for (
      let ordinal = 0;
      ordinal < Math.min(left.members.length, right.members.length);
      ordinal += 1
    ) {
      const leftMember = left.members.at(ordinal)
      const rightMember = right.members.at(ordinal)
      if (leftMember === undefined || rightMember === undefined) continue
      const divergence = firstRepresentationDivergence(leftMember, rightMember)
      if (divergence !== undefined) return divergence
    }
  }
  return undefined
}

const genericArgumentsHaveSameRepresentationShape = (
  left: GenericArgument,
  right: GenericArgument,
): boolean => {
  if (isRepresentationArgument(left) || isRepresentationArgument(right)) {
    if (!isRepresentationArgument(left) || !isRepresentationArgument(right)) return false
    const leftContract = representationArgumentContract(left)
    const rightContract = representationArgumentContract(right)
    return (
      leftContract !== undefined &&
      rightContract !== undefined &&
      haveSameRepresentationShape(leftContract, rightContract)
    )
  }
  if (isRequirementRowArgument(left) || isRequirementRowArgument(right)) {
    return (
      isRequirementRowArgument(left) &&
      isRequirementRowArgument(right) &&
      requirementMembers(left).length === requirementMembers(right).length &&
      requirementRowParameters(left).length === requirementRowParameters(right).length &&
      requirementMembers(left).every((requirement, ordinal) => {
        const compared = requirementMembers(right).at(ordinal)
        return (
          compared !== undefined &&
          requirement.role === compared.role &&
          requirementSatisfies(compared, requirement) &&
          haveSameRepresentationShape(requirement.capability, compared.capability)
        )
      }) &&
      requirementRowParameters(left).every((parameter_, ordinal) => {
        const compared = requirementRowParameters(right).at(ordinal)
        return compared !== undefined && equals(parameter_, compared)
      })
    )
  }
  return isTypeArgument(left) && isTypeArgument(right)
    ? haveSameRepresentationShape(left, right)
    : equalsGenericArgument(left, right)
}

/**
 * Compares the complete value shape of two types while deliberately ignoring concrete executable
 * identities. Producer return checking uses this relation before its opaque-realization pass
 * unifies those identities; ordinary type equality remains identity-sensitive.
 */
export const haveSameRepresentationShape = (left: Type, right: Type): boolean => {
  if (isRepresented(left)) return haveSameRepresentationShape(left.contract, right)
  if (isRepresented(right)) return haveSameRepresentationShape(left, right.contract)
  if (typeof left === 'string' || typeof right === 'string') return left === right
  if (isString(left) || isString(right))
    return isString(left) && isString(right) && Lifetime.equals(left.lifetime, right.lifetime)
  if (isParameter(left) || isParameter(right))
    return isParameter(left) && isParameter(right) && equals(left, right)
  if (isNominal(left) || isNominal(right))
    return (
      isNominal(left) &&
      isNominal(right) &&
      left.module === right.module &&
      left.name === right.name &&
      left.arguments.length === right.arguments.length &&
      left.arguments.every((argument, ordinal) => {
        const compared = right.arguments.at(ordinal)
        return (
          compared !== undefined && genericArgumentsHaveSameRepresentationShape(argument, compared)
        )
      })
    )
  if (isFixedArray(left) || isFixedArray(right))
    return (
      isFixedArray(left) &&
      isFixedArray(right) &&
      left.length === right.length &&
      haveSameRepresentationShape(left.element, right.element)
    )
  if (isSlice(left) || isSlice(right))
    return (
      isSlice(left) &&
      isSlice(right) &&
      left.access === right.access &&
      Lifetime.equals(left.lifetime, right.lifetime) &&
      haveSameRepresentationShape(left.element, right.element)
    )
  if (isReference(left) || isReference(right))
    return (
      isReference(left) &&
      isReference(right) &&
      left.access === right.access &&
      Lifetime.equals(left.lifetime, right.lifetime) &&
      haveSameRepresentationShape(left.target, right.target)
    )
  if (isPointer(left) || isPointer(right))
    return (
      isPointer(left) &&
      isPointer(right) &&
      samePointerQualifiers(left, right) &&
      haveSameRepresentationShape(left.pointee, right.pointee)
    )
  if (isForeignFunction(left) || isForeignFunction(right))
    return (
      isForeignFunction(left) &&
      isForeignFunction(right) &&
      ForeignContract.key(left.contract) === ForeignContract.key(right.contract) &&
      left.parameters.length === right.parameters.length &&
      left.parameters.every((parameter, ordinal) => {
        const compared = right.parameters.at(ordinal)
        return compared !== undefined && haveSameRepresentationShape(parameter, compared)
      }) &&
      haveSameRepresentationShape(left.result, right.result)
    )
  if (isCallable(left) || isCallable(right)) {
    if (!isCallable(left) || !isCallable(right)) return false
    return (
      executableLifetimeKey(left) === executableLifetimeKey(right) &&
      (!left.unsafe || right.unsafe) &&
      compareAccess(right.mode, left.mode) &&
      left.parameters.length === right.parameters.length &&
      left.parameters.every((parameter_, ordinal) => {
        const compared = right.parameters.at(ordinal)
        return compared !== undefined && haveSameRepresentationShape(parameter_, compared)
      }) &&
      haveSameRepresentationShape(left.result, right.result)
    )
  }
  if (isEffect(left) || isEffect(right)) {
    if (!isEffect(left) || !isEffect(right)) return false
    return (
      executableLifetimeKey(left) === executableLifetimeKey(right) &&
      compareAccess(right.access, left.access) &&
      haveSameRepresentationShape(left.success, right.success) &&
      haveSameRepresentationShape(failureType(left), failureType(right)) &&
      requirementMembers(left).length === requirementMembers(right).length &&
      requirementMembers(left).every((requirement, ordinal) => {
        const compared = requirementMembers(right).at(ordinal)
        return (
          compared !== undefined &&
          requirement.role === compared.role &&
          requirementSatisfies(compared, requirement) &&
          haveSameRepresentationShape(requirement.capability, compared.capability)
        )
      }) &&
      requirementRowParameters(left).length === requirementRowParameters(right).length &&
      requirementRowParameters(left).every((parameter_, ordinal) => {
        const compared = requirementRowParameters(right).at(ordinal)
        return compared !== undefined && equals(parameter_, compared)
      })
    )
  }
  if (isUnion(left) || isUnion(right))
    return (
      isUnion(left) &&
      isUnion(right) &&
      left.members.length === right.members.length &&
      left.members.every((member, ordinal) => {
        const compared = right.members.at(ordinal)
        return compared !== undefined && haveSameRepresentationShape(member, compared)
      })
    )
  return false
}

const opaqueEvidenceInGenericArguments = (
  actual: GenericArgument,
  expected: GenericArgument,
  family: OpaqueFamilyKey,
): ReadonlyArray<RepresentationArgument> => {
  if (isOpaqueRepresentationArgument(expected) && equalsOpaqueFamily(expected.family, family))
    return isRepresentationArgument(actual) ? [actual] : []
  if (isTypeArgument(actual) && isTypeArgument(expected))
    return opaqueRepresentationEvidence(actual, expected, family)
  if (isRequirementRowArgument(actual) && isRequirementRowArgument(expected))
    return requirementMembers(expected).flatMap((requirement, ordinal) => {
      const supplied = requirementMembers(actual).at(ordinal)
      return supplied === undefined
        ? []
        : opaqueRepresentationEvidence(supplied.capability, requirement.capability, family)
    })
  return []
}

/**
 * Extracts concrete or dependent representation evidence from the positions occupied by one
 * opaque family in an expected producer result.
 */
export const opaqueRepresentationEvidence = (
  actual: Type,
  expected: Type,
  family: OpaqueFamilyKey,
): ReadonlyArray<RepresentationArgument> => {
  if (
    isRepresented(expected) &&
    isOpaqueRepresentationArgument(expected.representation.argument) &&
    equalsOpaqueFamily(expected.representation.argument.family, family)
  )
    return isRepresented(actual) ? [actual.representation.argument] : []
  if (isRepresented(actual)) return opaqueRepresentationEvidence(actual.contract, expected, family)
  if (isRepresented(expected))
    return opaqueRepresentationEvidence(actual, expected.contract, family)
  if (isNominal(actual) && isNominal(expected))
    return expected.arguments.flatMap((argument, ordinal) => {
      const supplied = actual.arguments.at(ordinal)
      return supplied === undefined
        ? []
        : opaqueEvidenceInGenericArguments(supplied, argument, family)
    })
  if (isFixedArray(actual) && isFixedArray(expected))
    return opaqueRepresentationEvidence(actual.element, expected.element, family)
  if (isSlice(actual) && isSlice(expected))
    return opaqueRepresentationEvidence(actual.element, expected.element, family)
  if (isReference(actual) && isReference(expected))
    return opaqueRepresentationEvidence(actual.target, expected.target, family)
  if (isPointer(actual) && isPointer(expected))
    return opaqueRepresentationEvidence(actual.pointee, expected.pointee, family)
  if (isForeignFunction(actual) && isForeignFunction(expected))
    return [
      ...expected.parameters.flatMap((parameter, ordinal) => {
        const supplied = actual.parameters.at(ordinal)
        return supplied === undefined
          ? []
          : opaqueRepresentationEvidence(supplied, parameter, family)
      }),
      ...opaqueRepresentationEvidence(actual.result, expected.result, family),
    ]
  if (isCallable(actual) && isCallable(expected))
    return [
      ...expected.parameters.flatMap((parameter_, ordinal) => {
        const supplied = actual.parameters.at(ordinal)
        return supplied === undefined
          ? []
          : opaqueRepresentationEvidence(supplied, parameter_, family)
      }),
      ...opaqueRepresentationEvidence(actual.result, expected.result, family),
    ]
  if (isEffect(actual) && isEffect(expected))
    return [
      ...opaqueRepresentationEvidence(actual.success, expected.success, family),
      ...failureMembers(expected).flatMap((failure, ordinal) => {
        const supplied = failureMembers(actual).at(ordinal)
        return supplied === undefined ? [] : opaqueRepresentationEvidence(supplied, failure, family)
      }),
      ...requirementMembers(expected).flatMap((requirement, ordinal) => {
        const supplied = requirementMembers(actual).at(ordinal)
        return supplied === undefined
          ? []
          : opaqueRepresentationEvidence(supplied.capability, requirement.capability, family)
      }),
    ]
  if (isUnion(actual) && isUnion(expected))
    return expected.members.flatMap((member, ordinal) => {
      const supplied = actual.members.at(ordinal)
      return supplied === undefined ? [] : opaqueRepresentationEvidence(supplied, member, family)
    })
  return []
}

interface FoldVisitor<A> {
  readonly descendArgument?: (self: GenericArgument) => boolean
  readonly descend?: (self: Type) => boolean
  readonly type?: (self: Type, inBinderScope: (parameterKey: string) => boolean) => A | undefined
  readonly argument?: (
    self: GenericArgument,
    inBinderScope: (parameterKey: string) => boolean,
  ) => A | undefined
}

/**
 * Folds every semantic type and erased generic argument in deterministic preorder.
 *
 * This is the single structural walk used by Type-owned collectors. Adding a new type or generic
 * argument kind therefore has one exhaustiveness point instead of several subtly different walks.
 */
const fold = <A>(self: Type, visitor: FoldVisitor<A>): ReadonlyArray<A> => {
  const found: Array<A> = []
  const binderScope = new Map<string, number>()
  const inBinderScope = (parameterKey: string): boolean => binderScope.has(parameterKey)
  const pushBinders = (binders: ReadonlyArray<Parameter>): void => {
    for (const binder of binders)
      binderScope.set(key(binder), (binderScope.get(key(binder)) ?? 0) + 1)
  }
  const popBinders = (binders: ReadonlyArray<Parameter>): void => {
    for (const binder of binders) {
      const count = binderScope.get(key(binder)) ?? 0
      if (count <= 1) binderScope.delete(key(binder))
      else binderScope.set(key(binder), count - 1)
    }
  }
  const append = (value: A | undefined): void => {
    if (value !== undefined) found.push(value)
  }
  const visitArgument = (argument: GenericArgument): void => {
    append(visitor.argument?.(argument, inBinderScope))
    if (visitor.descendArgument?.(argument) === false) return
    if (Lifetime.isLifetime(argument) && argument._tag === 'IntersectionLifetime')
      for (const member of argument.members) visitArgument(member)
    else if (isTypeArgument(argument)) visitType(argument)
    else if (isRepresentationParameterArgument(argument)) visitType(argument.parameter)
    else if (isOpaqueRepresentationArgument(argument)) {
      visitType(argument.contract)
      for (const enclosing of argument.arguments) visitArgument(enclosing)
    } else if (isExactRepresentationArgument(argument)) {
      visitArgument(argument.identity)
      visitType(argument.contract)
    } else if (isCompositeEffectRepresentationArgument(argument)) {
      visitType(argument.contract)
      for (const alternative of argument.alternatives) visitArgument(alternative)
    } else if (isEffectIdentityArgument(argument)) {
      for (const typeArgument of argument.owner?.typeArguments ?? []) visitArgument(typeArgument)
    } else if (isCallableIdentityArgument(argument)) {
      for (const typeArgument of argument.typeArguments) visitArgument(typeArgument)
      for (const typeArgument of argument.environment?.owner.typeArguments ?? [])
        visitArgument(typeArgument)
    } else if (isRequirementRowArgument(argument)) {
      for (const requirement of RowAlgebra.concreteMembers(requirementRowPolicy(), argument.row))
        visitType(requirement.capability)
      const parameters_ = RowAlgebra.parameters(requirementRowPolicy(), argument.row)
      for (const parameter_ of [...parameters_.rows, ...parameters_.members]) visitType(parameter_)
    }
  }
  const visitFailureRow = (row: FailureRow): void => {
    for (const failure of RowAlgebra.concreteMembers(failureRowPolicy(), row)) visitType(failure)
    const parameters_ = RowAlgebra.parameters(failureRowPolicy(), row)
    for (const parameter_ of [...parameters_.rows, ...parameters_.members]) visitType(parameter_)
  }
  const visitRequirementRow = (row: RequirementsRow): void => {
    for (const requirement of RowAlgebra.concreteMembers(requirementRowPolicy(), row))
      visitType(requirement.capability)
    const parameters_ = RowAlgebra.parameters(requirementRowPolicy(), row)
    for (const parameter_ of [...parameters_.rows, ...parameters_.members]) visitType(parameter_)
  }
  const visitConstraint = (constraint: Constraint.Constraint): void => {
    switch (constraint._tag) {
      case 'NominalMemberConstraint':
        visitType(constraint.selected)
        visitFailureRow(constraint.source)
        break
      case 'FailureSubsetConstraint':
        visitFailureRow(constraint.selected)
        visitFailureRow(constraint.source)
        break
      case 'RequirementSubsetConstraint':
        visitRequirementRow(constraint.selected)
        visitRequirementRow(constraint.source)
        break
      case 'ProviderSelectionConstraint':
        visitType(constraint.provider)
        visitRequirementRow(constraint.selected)
        visitRequirementRow(constraint.source)
        break
    }
  }
  const visitEvidence = (evidence: Constraint.ConstraintEvidence): void => {
    switch (evidence._tag) {
      case 'Assumed':
        visitConstraint(evidence.wanted)
        for (const argument of evidence.substitution.values()) visitArgument(argument)
        break
      case 'Member':
        visitType(evidence.selected)
        visitFailureRow(evidence.source)
        break
      case 'FailureSubset':
        visitFailureRow(evidence.selected)
        visitFailureRow(evidence.source)
        break
      case 'RequirementSubset':
        visitRequirementRow(evidence.selected)
        visitRequirementRow(evidence.source)
        break
      case 'RequirementSelection':
        visitConstraint(evidence.wanted)
        visitType(evidence.selected.capability)
        visitType(evidence.provider)
        if (evidence.providerMatch._tag === 'Conformance')
          for (const argument of evidence.providerMatch.witness.typeArguments)
            visitArgument(argument)
        break
    }
  }
  const visitContract = (contract: CallableContract.CallableContract): void => {
    visitArgument(contract.environment)
    for (const binder of contract.lifetimeBinders) visitArgument(binder)
    for (const bound of contract.lifetimeBounds) {
      visitArgument(bound.longer)
      visitArgument(bound.shorter)
    }
    for (const bound of contract.typeOutlives) {
      visitType(bound.type)
      visitArgument(bound.lifetime)
    }
    for (const binder of contract.binders) {
      visitType(binder)
      if (binder.representationBound !== undefined) visitType(binder.representationBound)
    }
    for (const parameter_ of contract.parameters) visitType(parameter_.type)
    visitType(contract.result)
    for (const constraint of contract.constraints) visitConstraint(constraint)
  }
  const visitType = (type: Type): void => {
    append(visitor.type?.(type, inBinderScope))
    if (visitor.descend?.(type) === false) return
    if (isNominal(type)) {
      for (const argument of type.arguments) visitArgument(argument)
    } else if (isParameter(type)) {
      if (type.representationBound !== undefined) visitType(type.representationBound)
    } else if (isString(type)) visitArgument(type.lifetime)
    else if (isFixedArray(type)) visitType(type.element)
    else if (isSlice(type)) {
      visitArgument(type.lifetime)
      visitType(type.element)
    } else if (isReference(type)) {
      visitArgument(type.lifetime)
      visitType(type.target)
    } else if (isPointer(type)) visitType(type.pointee)
    else if (isForeignFunction(type)) {
      for (const binder of type.lifetimeBinders)
        binderScope.set(Lifetime.key(binder), (binderScope.get(Lifetime.key(binder)) ?? 0) + 1)
      for (const parameter_ of type.parameters) visitType(parameter_)
      visitType(type.result)
      for (const bound of type.lifetimeBounds) {
        visitArgument(bound.longer)
        visitArgument(bound.shorter)
      }
      for (const binder of type.lifetimeBinders) {
        const count = binderScope.get(Lifetime.key(binder)) ?? 0
        if (count <= 1) binderScope.delete(Lifetime.key(binder))
        else binderScope.set(Lifetime.key(binder), count - 1)
      }
    } else if (isCallable(type)) {
      if (type.schema !== undefined) pushBinders(type.schema.binders)
      visitArgument(type.environment)
      for (const binder of type.lifetimeBinders)
        binderScope.set(Lifetime.key(binder), (binderScope.get(Lifetime.key(binder)) ?? 0) + 1)
      for (const binder of type.lifetimeBinders) visitArgument(binder)
      for (const bound of type.lifetimeBounds) {
        visitArgument(bound.longer)
        visitArgument(bound.shorter)
      }
      for (const bound of type.typeOutlives) {
        visitType(bound.type)
        visitArgument(bound.lifetime)
      }
      for (const parameter_ of type.parameters) visitType(parameter_)
      visitType(type.result)
      if (type.schema !== undefined) {
        visitContract(type.schema.contract)
        for (const binder of type.schema.binders) {
          visitType(binder)
          if (binder.representationBound !== undefined) visitType(binder.representationBound)
        }
        for (const constraint of type.schema.constraints) visitConstraint(constraint)
        for (const evidence of type.schema.evidence) visitEvidence(evidence)
        for (const argument of type.schema.substitution.values()) visitArgument(argument)
        popBinders(type.schema.binders)
      }
      for (const binder of type.lifetimeBinders) {
        const count = binderScope.get(Lifetime.key(binder)) ?? 0
        if (count <= 1) binderScope.delete(Lifetime.key(binder))
        else binderScope.set(Lifetime.key(binder), count - 1)
      }
    } else if (isEffect(type)) {
      visitArgument(type.environment)
      for (const binder of type.lifetimeBinders)
        binderScope.set(Lifetime.key(binder), (binderScope.get(Lifetime.key(binder)) ?? 0) + 1)
      for (const binder of type.lifetimeBinders) visitArgument(binder)
      for (const bound of type.lifetimeBounds) {
        visitArgument(bound.longer)
        visitArgument(bound.shorter)
      }
      for (const bound of type.typeOutlives) {
        visitType(bound.type)
        visitArgument(bound.lifetime)
      }
      visitType(type.success)
      visitFailureRow(type.failureRow)
      visitRequirementRow(type.requirementRow)
      for (const binder of type.lifetimeBinders) {
        const count = binderScope.get(Lifetime.key(binder)) ?? 0
        if (count <= 1) binderScope.delete(Lifetime.key(binder))
        else binderScope.set(Lifetime.key(binder), count - 1)
      }
    } else if (isRepresented(type)) {
      visitArgument(type.representation.argument)
      visitType(type.contract)
      visitType(type.representation.requiredBound)
    } else if (isUnion(type)) {
      for (const member of type.members) visitType(member)
    }
  }
  visitType(self)
  return found
}

const typeMaySpecialize = (self: Type): boolean =>
  lifetimes(self).some((lifetime) => lifetime._tag !== 'StaticLifetime') ||
  parameters(self).length > 0 ||
  fold(self, {
    argument: (argument) =>
      (isEffectIdentityArgument(argument) && argument.owner !== undefined) ||
      (isCallableIdentityArgument(argument) && argument.environment !== undefined)
        ? true
        : undefined,
  }).length > 0

/** Returns every opaque family instance nested in one semantic type. */
export const opaqueRepresentationArguments = (
  self: Type,
): ReadonlyArray<OpaqueRepresentationArgument> =>
  fold(self, {
    argument: (argument) => (isOpaqueRepresentationArgument(argument) ? argument : undefined),
  })

/** Orders semantic types by canonical identity. */
export const compare = (left: Type, right: Type): number => compareText(key(left), key(right))

const executableAccessPrefix = (access: CallableMode | Effect['access']): string => {
  switch (access) {
    case 'Exclusive':
      return 'mut '
    case 'Take':
      return 'once '
    case 'Shared':
      return ''
  }
}

/** Returns the source-facing category of one compiler-minted anonymous aggregate. */
export const anonymousAggregateDisplay = (self: Nominal): string | undefined => {
  if (self.name.startsWith('@AnonymousPositional:')) return 'anonymous tuple'
  if (self.name.startsWith('@AnonymousNamed:')) return 'anonymous record'
  return undefined
}

/** Encodes one type for deterministic compiler facts and diagnostics. */
export const encode = (self: Type): string => {
  if (isString(self)) return `string<${Lifetime.display(self.lifetime)}>`
  if (typeof self === 'string') return self
  if (equals(self, unit)) return '()'
  if (isNominal(self)) {
    const arguments_ =
      self.arguments.length === 0 ? '' : `<${self.arguments.map(encodeGenericArgument).join(', ')}>`
    return `${self.module}.${self.name}${arguments_}`
  }
  if (isParameter(self)) return self.name
  if (isFixedArray(self)) return `Array<${encode(self.element)}, ${self.length}>`
  if (isSlice(self))
    return `&${Lifetime.display(self.lifetime)} ${self.access === 'Exclusive' ? 'mut ' : ''}[${encode(self.element)}]`
  if (isReference(self))
    return `&${Lifetime.display(self.lifetime)} ${self.access === 'Exclusive' ? 'mut ' : ''}${encode(self.target)}`
  if (isPointer(self))
    return `${self.nullable ? '?' : ''}${self.extent === 'Many' ? '[*]' : '*'}${self.mutable ? 'mut' : 'const'} ${self.alignment === 'Natural' ? '' : `align(${self.alignment}) `}${encode(self.pointee)}`
  if (isCallable(self)) {
    const mode = executableAccessPrefix(self.mode)
    const quantified =
      self.lifetimeBinders.length === 0
        ? ''
        : `for<${self.lifetimeBinders
            .map((binder) => {
              const bounds = self.lifetimeBounds
                .filter((bound) => Lifetime.equals(bound.longer, binder))
                .map((bound) => Lifetime.display(bound.shorter))
              return `${Lifetime.display(binder)}${bounds.length === 0 ? '' : `: ${bounds.join(' + ')}`}`
            })
            .join(', ')}> `
    return `${quantified}${self.unsafe ? 'unsafe ' : ''}${mode}fn<${Lifetime.display(self.environment)}>(${self.parameters.map(encode).join(', ')}) -> ${encode(self.result)}`
  }
  if (isForeignFunction(self))
    return `${
      self.lifetimeBinders.length === 0
        ? ''
        : `for<${self.lifetimeBinders
            .map((binder) => {
              const bounds = self.lifetimeBounds
                .filter((bound) => Lifetime.equals(bound.longer, binder))
                .map((bound) => Lifetime.display(bound.shorter))
              return `${Lifetime.display(binder)}${bounds.length === 0 ? '' : `: ${bounds.join(' + ')}`}`
            })
            .join(', ')}> `
    }extern "C" fn(${self.parameters.map(encode).join(', ')}) -> ${encode(self.result)}${ForeignContract.source(
      self.contract,
      self.parameters.map((_, ordinal) => String(ordinal)),
    )}`
  if (isEffect(self)) {
    const access = executableAccessPrefix(self.access)
    const failureMembers = RowAlgebra.encode(
      failureRowPolicy(),
      self.failureRow,
      encode,
      (parameter_) => parameter_.name,
      (member) => member.parameter.name,
    )
    const row = failureMembers.length === 0 ? '' : ` ! ${failureMembers}`
    const requirementMembers = RowAlgebra.encode(
      requirementRowPolicy(),
      self.requirementRow,
      (requirement) =>
        `${requirement.access === 'Exclusive' ? '&mut ' : '&'}${encode(requirement.capability)}${requirement.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(requirement.role)}`}`,
      (parameter_) => parameter_.name,
      (member) =>
        `${member.access === 'Exclusive' ? '&mut ' : '&'}${member.capability.name}${member.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(member.role)}`}`,
    )
    const requirements = requirementMembers.length === 0 ? '' : ` ? ${requirementMembers}`
    return `${access}Effect<${Lifetime.display(self.environment)}; ${encode(self.success)}${row}${requirements}>`
  }
  if (isRepresented(self)) return encode(self.contract)
  return self.members.map(encode).join(' | ')
}

/** Renders a semantic type without exposing compiler-minted anonymous aggregate spellings. */
export const display = (self: Type): string =>
  encode(self)
    .replace(/(?:[^\s<>,()&|]+\.)?@AnonymousPositional:[0-9a-f]+:n\d+/g, 'anonymous tuple')
    .replace(/(?:[^\s<>,()&|]+\.)?@AnonymousNamed:[0-9a-f]+:n\d+/g, 'anonymous record')

/** Renders one normalized requirement member with its access demand and optional nominal role. */
export const encodeRequirement = (
  self: Requirement,
  encodeCapability: (capability: Type) => string = encode,
): string =>
  `${self.access === 'Exclusive' ? '&mut ' : '&'}${encodeCapability(self.capability)}${self.role === RequirementRow.defaultRole ? '' : ` at ${RequirementRow.roleName(self.role)}`}`

/** One declaration named by an exact representation carried inside a type. */
export interface ExactRepresentationDeclaration {
  readonly module: string
  readonly name: string
}

/**
 * Names every declaration whose exact representation one type carries, in encounter order.
 *
 * An exact representation is reported before descending into its identity arguments and structural
 * contract, because the contract alone does not name the construction the representation fixed.
 */
export const exactRepresentationDeclarations = (
  self: Type,
): ReadonlyArray<ExactRepresentationDeclaration> =>
  fold(self, {
    argument: (argument) =>
      isExactRepresentationArgument(argument) &&
      isCallableIdentityArgument(argument.identity) &&
      argument.identity.target._tag === 'Declaration'
        ? {
            module: argument.identity.target.module,
            name: argument.identity.target.name,
          }
        : undefined,
  })

/** Returns every canonical nominal nested in a type, in deterministic preorder. */
export const nominals = (self: Type): ReadonlyArray<Nominal> =>
  fold(self, { type: (type) => (isNominal(type) ? type : undefined) })

/** Visits every structural type occurrence in deterministic pre-order. */
export const visit = (self: Type, visitor: (type: Type) => void): void => {
  fold(self, { type: (type) => visitor(type) })
}

/** Reports whether one type occurs strictly inside another type's structural representation. */
export const isStrictStructuralSubterm = (candidate: Type, whole: Type): boolean => {
  if (equals(candidate, whole)) return false
  let found = false
  visit(whole, (type) => {
    if (equals(candidate, type)) found = true
  })
  return found
}

/** Returns every declaration-owned parameter nested in a type, without duplicates. */
export const parameters = (self: Type): ReadonlyArray<Parameter> => {
  const found = new Map<string, Parameter>()
  fold(self, {
    type: (type, inBinderScope) => {
      if (isParameter(type) && !inBinderScope(key(type))) found.set(key(type), type)
    },
    argument: (argument, inBinderScope) => {
      if (isRepresentationParameterArgument(argument) && !inBinderScope(key(argument.parameter)))
        found.set(key(argument.parameter), argument.parameter)
    },
  })
  return [...found.values()].sort(compare)
}

/** Tests whether a type contains no open generic parameters. */
export const isConcrete = (self: Type): boolean => parameters(self).length === 0

const runtimeAvailableFailureRow = (self: FailureRow): boolean => {
  const concrete = RowAlgebra.concretize(failureRowPolicy(), self)
  const parameters_ = RowAlgebra.parameters(failureRowPolicy(), self)
  return (
    concrete._tag === 'Concrete' &&
    concrete.row.members.every(runtimeAvailable) &&
    parameters_.rows.every(runtimeAvailable) &&
    parameters_.members.every(runtimeAvailable)
  )
}

const runtimeAvailableRequirementRow = (self: RequirementsRow): boolean => {
  const concrete = RowAlgebra.concretize(requirementRowPolicy(), self)
  const parameters_ = RowAlgebra.parameters(requirementRowPolicy(), self)
  return (
    concrete._tag === 'Concrete' &&
    concrete.row.members.every((requirement) => runtimeAvailable(requirement.capability)) &&
    parameters_.rows.every(runtimeAvailable) &&
    parameters_.members.every(runtimeAvailable)
  )
}

const runtimeAvailableGenericArgument = (self: GenericArgument): boolean => {
  if (Lifetime.isLifetime(self)) return true
  if (isUnavailableGenericArgument(self)) return false
  if (isRepresentationParameterArgument(self)) return true
  if (isOpaqueRepresentationArgument(self))
    return runtimeAvailable(self.contract) && self.arguments.every(runtimeAvailableGenericArgument)
  if (isExactRepresentationArgument(self))
    return runtimeAvailable(self.contract) && runtimeAvailableGenericArgument(self.identity)
  if (isCompositeEffectRepresentationArgument(self))
    return (
      runtimeAvailable(self.contract) &&
      self.alternatives.length > 0 &&
      self.alternatives.every(runtimeAvailableGenericArgument)
    )
  if (isEffectIdentityArgument(self))
    return self.owner?.typeArguments.every(runtimeAvailableGenericArgument) ?? true
  if (isCallableIdentityArgument(self))
    return (
      self.typeArguments.every(runtimeAvailableGenericArgument) &&
      (self.environment?.owner.typeArguments.every(runtimeAvailableGenericArgument) ?? true)
    )
  if (isRequirementRowArgument(self)) return runtimeAvailableRequirementRow(self.row)
  return runtimeAvailable(self)
}

const runtimeAvailableConstraint = (constraint: Constraint.Constraint): boolean => {
  switch (constraint._tag) {
    case 'NominalMemberConstraint':
      return runtimeAvailable(constraint.selected) && runtimeAvailableFailureRow(constraint.source)
    case 'FailureSubsetConstraint':
      return (
        runtimeAvailableFailureRow(constraint.selected) &&
        runtimeAvailableFailureRow(constraint.source)
      )
    case 'RequirementSubsetConstraint':
      return (
        runtimeAvailableRequirementRow(constraint.selected) &&
        runtimeAvailableRequirementRow(constraint.source)
      )
    case 'ProviderSelectionConstraint':
      return (
        runtimeAvailable(constraint.provider) &&
        runtimeAvailableRequirementRow(constraint.selected) &&
        runtimeAvailableRequirementRow(constraint.source)
      )
  }
}

/** Checks one blueprint constraint after closing it through the schema substitution. */
const runtimeAvailableConstraintUnder = (
  constraint: Constraint.Constraint,
  substitution: Substitution,
): boolean => {
  switch (constraint._tag) {
    case 'NominalMemberConstraint':
      return runtimeAvailableConstraint({
        ...constraint,
        selected: substitute(constraint.selected, substitution),
        source: substituteFailureRow(constraint.source, substitution),
      })
    case 'FailureSubsetConstraint':
      return runtimeAvailableConstraint({
        ...constraint,
        selected: substituteFailureRow(constraint.selected, substitution),
        source: substituteFailureRow(constraint.source, substitution),
      })
    case 'RequirementSubsetConstraint':
      return runtimeAvailableConstraint({
        ...constraint,
        selected: substituteRequirementsRow(constraint.selected, substitution),
        source: substituteRequirementsRow(constraint.source, substitution),
      })
    case 'ProviderSelectionConstraint':
      return runtimeAvailableConstraint({
        ...constraint,
        provider: substitute(constraint.provider, substitution),
        selected: substituteRequirementsRow(constraint.selected, substitution),
        source: substituteRequirementsRow(constraint.source, substitution),
      })
  }
}

const runtimeAvailableEvidence = (evidence: Constraint.ConstraintEvidence): boolean => {
  switch (evidence._tag) {
    case 'Assumed':
      return (
        runtimeAvailableConstraint(evidence.wanted) &&
        [...evidence.substitution.values()].every(runtimeAvailableGenericArgument)
      )
    case 'Member':
      return runtimeAvailable(evidence.selected) && runtimeAvailableFailureRow(evidence.source)
    case 'FailureSubset':
      return (
        runtimeAvailableFailureRow(evidence.selected) && runtimeAvailableFailureRow(evidence.source)
      )
    case 'RequirementSubset':
      return (
        runtimeAvailableRequirementRow(evidence.selected) &&
        runtimeAvailableRequirementRow(evidence.source)
      )
    case 'RequirementSelection':
      return (
        runtimeAvailableConstraint(evidence.wanted) &&
        runtimeAvailable(evidence.selected.capability) &&
        runtimeAvailable(evidence.provider) &&
        (evidence.providerMatch._tag === 'Conformance'
          ? evidence.providerMatch.witness.typeArguments.every(runtimeAvailableGenericArgument)
          : true)
      )
  }
}

export function runtimeAvailable(self: Type): boolean {
  if (typeof self === 'string' || isString(self) || isParameter(self)) return true
  if (isStaticPhaseOnly(self)) return false
  if (isNominal(self)) return self.arguments.every(runtimeAvailableGenericArgument)
  if (isFixedArray(self) || isSlice(self)) return runtimeAvailable(self.element)
  if (isReference(self)) return runtimeAvailable(self.target)
  if (isPointer(self)) return runtimeAvailable(self.pointee)
  if (isForeignFunction(self))
    return self.parameters.every(runtimeAvailable) && runtimeAvailable(self.result)
  if (isCallable(self))
    return (
      self.parameters.every(runtimeAvailable) &&
      runtimeAvailable(self.result) &&
      // The schema contract is the generic declaration blueprint; its binders, rows, and
      // constraints are symbolic by construction and close through schema.substitution. Runtime
      // availability is therefore decided on the substituted constraints, the evidence, and the
      // substitution itself — never on the raw blueprint.
      (self.schema === undefined ||
        (self.schema.binders.every((binder) => {
          if (binder.kind === 'Lifetime') return true
          const argument = self.schema?.substitution.get(key(binder))
          return (
            argument !== undefined &&
            !equalsGenericArgument(argument, parameterArgument(binder)) &&
            runtimeAvailableGenericArgument(argument)
          )
        }) &&
          self.schema.constraints.every((constraint) =>
            runtimeAvailableConstraintUnder(constraint, self.schema?.substitution ?? new Map()),
          ) &&
          self.schema.evidence.every(runtimeAvailableEvidence) &&
          [...self.schema.substitution.values()].every(runtimeAvailableGenericArgument)))
    )
  if (isEffect(self))
    return (
      runtimeAvailable(self.success) &&
      runtimeAvailableFailureRow(self.failureRow) &&
      runtimeAvailableRequirementRow(self.requirementRow)
    )
  if (isRepresented(self))
    return (
      self.representation.admissibility._tag !== 'Unavailable' &&
      runtimeAvailable(self.contract) &&
      runtimeAvailable(self.representation.requiredBound) &&
      runtimeAvailableGenericArgument(self.representation.argument)
    )
  return self.members.every(runtimeAvailable)
}

/** Tests whether a type is closed, fully available, and safe to expose to runtime consumers. */
export const isRuntimeConcrete = (self: Type): boolean => isConcrete(self) && runtimeAvailable(self)

/** Admits failure values whose generic retained payloads are known to be detached. */
export const isFailureValue = (self: Type): boolean =>
  isRuntimeConcrete(self) ||
  (isParameter(self) && self.kind === 'Value') ||
  (isUnion(self) && self.members.every(isFailureValue)) ||
  (isNominal(self) &&
    runtimeAvailable(self) &&
    parameters(self).every(
      (parameter) =>
        parameter.kind === 'Value' && parameter.staticProperties.includes('Intrinsic.Detached'),
    ))

const isClosedGenericArgument = (self: GenericArgument): boolean => {
  if (Lifetime.isLifetime(self)) return true
  if (isUnavailableGenericArgument(self) || isRepresentationParameterArgument(self)) return false
  if (isOpaqueRepresentationArgument(self))
    return isConcrete(self.contract) && self.arguments.every(isClosedGenericArgument)
  if (isExactRepresentationArgument(self))
    return isConcrete(self.contract) && isClosedGenericArgument(self.identity)
  if (isCompositeEffectRepresentationArgument(self))
    return (
      isConcrete(self.contract) &&
      self.alternatives.length > 0 &&
      self.alternatives.every(isClosedGenericArgument)
    )
  if (isEffectIdentityArgument(self))
    return self.owner?.typeArguments.every(isClosedGenericArgument) ?? true
  if (isCallableIdentityArgument(self))
    return (
      self.typeArguments.every(isClosedGenericArgument) &&
      (self.environment?.owner.typeArguments.every(isClosedGenericArgument) ?? true)
    )
  if (isRequirementRowArgument(self))
    return (
      RowAlgebra.concretize(requirementRowPolicy(), self.row)._tag === 'Concrete' &&
      requirementMembers(self).every((requirement) => isConcrete(requirement.capability))
    )
  return isConcrete(self)
}

/** Tests whether one erased argument is fully closed and contains no unavailable recovery value. */
export const isRuntimeConcreteGenericArgument = (self: GenericArgument): boolean =>
  isClosedGenericArgument(self) && runtimeAvailableGenericArgument(self)

/** True when any nested Type satisfies the predicate (including self). */
export const someSubterm = (self: Type, predicate: (type: Type) => boolean): boolean => {
  return fold(self, { type: (type) => (predicate(type) ? true : undefined) }).length > 0
}

/** Every nested C function-pointer type in deterministic preorder, including `self`. */
export const foreignFunctions = (self: Type): ReadonlyArray<ForeignFunction> =>
  fold(self, { type: (type) => (isForeignFunction(type) ? type : undefined) })

/** Tests whether a type contains a lexical borrow at any depth. */
export const containsBorrow = (self: Type): boolean =>
  someSubterm(self, (type) => isString(type) || isSlice(type) || isReference(type) || isSlot(type))

/** Tests whether this type is one direct lexical view rather than owned storage containing one. */
export const isViewBorrow = (self: Type): self is String | Slice | Reference =>
  isString(self) || isSlice(self) || isReference(self)

/** Tests whether a value may carry a lexical view through data or control flow. */
export const containsViewBorrow = (self: Type): boolean => someSubterm(self, isViewBorrow)

/**
 * Tests whether a type stores one statically known callable environment anywhere inside it.
 *
 * A nominal that stores a callable names it in its own arguments, so the whole environment — and
 * every borrow it captured — travels with any value of that type. Ownership uses this to keep a
 * stored capture's loan alive for as long as the enclosing value holds the callable, exactly as it
 * does for a callable bound directly.
 */
export const containsCallableRepresentation = (self: Type): boolean =>
  someSubterm(
    self,
    (type) =>
      (isRepresented(type) && isCallable(type.contract)) ||
      (isNominal(type) &&
        type.arguments.some(
          (argument) =>
            isExactRepresentationArgument(argument) &&
            isCallableIdentityArgument(argument.identity),
        )),
  )

/** Tests whether a value stores one statically known Effect environment anywhere inside it. */
export const containsEffectRepresentation = (self: Type): boolean =>
  someSubterm(
    self,
    (type) =>
      (isRepresented(type) && isEffect(type.contract)) ||
      (isNominal(type) &&
        type.arguments.some(
          (argument) =>
            (isExactRepresentationArgument(argument) &&
              isEffectIdentityArgument(argument.identity)) ||
            isCompositeEffectRepresentationArgument(argument),
        )),
  )

/** Tests for either concrete executable environment carried through an enclosing value. */
export const containsExecutableRepresentation = (self: Type): boolean =>
  containsCallableRepresentation(self) || containsEffectRepresentation(self)

/** Tests for reference, slice, or slot wrappers anywhere in the semantic type. */
export const containsBorrowWrapper = (self: Type): boolean =>
  someSubterm(self, (type) => isSlice(type) || isReference(type) || isSlot(type))

/** Applies one substitution while preserving invalid lifted-member specialization as data. */
export const specializeFailureRow = (
  self: FailureRow,
  substitution: Substitution,
  compatibility?: TypeCompatibility.Context,
): RowAlgebra.SubstitutionResult<Type, Parameter, FailureMemberShape> => {
  const concrete = RowAlgebra.mapConcreteMembers(failureRowPolicy(), self, (failure) => {
    return substitute(failure, substitution, compatibility)
  })
  const result = RowAlgebra.substitute(failureRowPolicy(), concrete, {
    row: (parameter_) => {
      void parameter_
      return undefined
    },
    member: (member) => {
      const replacement = substitution.get(key(member.parameter))
      if (replacement === undefined) return { _tag: 'Residual', member }
      if (isTypeArgument(replacement) && isParameter(replacement) && replacement.kind === 'Value')
        return {
          _tag: 'Residual',
          member: failureMemberShape(replacement),
        }
      if (isTypeArgument(replacement) && !isUnion(replacement) && !isNever(replacement))
        return { _tag: 'Concrete', member: replacement }
      if (isTypeArgument(replacement) && isUnion(replacement)) {
        const row = replacement.members.reduce<FailureRow>(
          (current, failure) =>
            RowAlgebra.union(
              failureRowPolicy(),
              current,
              isParameter(failure) && failure.kind === 'Value'
                ? RowAlgebra.singleton(
                    failureRowPolicy(),
                    failureMemberShape(failure),
                    implicitRowOrigin,
                  )
                : RowAlgebra.concrete(failureRowPolicy(), [failure]),
            ),
          RowAlgebra.concrete(failureRowPolicy(), []),
        )
        return { _tag: 'Row', row }
      }
      if (isTypeArgument(replacement) && isNever(replacement))
        return { _tag: 'ConcreteRow', members: [] }
      return {
        _tag: 'InvalidSingleton',
        reason: `failure member ${member.parameter.name} did not specialize to an ordinary type`,
      }
    },
  })
  return result
}

export const substituteFailureRow = (
  self: FailureRow,
  substitution: Substitution,
  compatibility?: TypeCompatibility.Context,
): FailureRow => {
  const result = specializeFailureRow(self, substitution, compatibility)
  return result._tag === 'Substituted' ? result.row : self
}

/** Applies one substitution while preserving invalid lifted capability specialization as data. */
export const specializeRequirementsRow = (
  self: RequirementsRow,
  substitution: Substitution,
  compatibility?: TypeCompatibility.Context,
): RowAlgebra.SubstitutionResult<Requirement, Parameter, RequirementMemberShape> => {
  const concrete = RowAlgebra.mapConcreteMembers(requirementRowPolicy(), self, (requirement) => {
    const capability = substitute(requirement.capability, substitution, compatibility)
    return isNominal(capability) || isParameter(capability)
      ? { ...requirement, capability }
      : requirement
  })
  const result = RowAlgebra.substitute(requirementRowPolicy(), concrete, {
    row: (parameter_) => {
      const replacement = substitution.get(key(parameter_))
      if (replacement === undefined || !isRequirementRowArgument(replacement)) return undefined
      return replacement.row
    },
    member: (member) => {
      const replacement = substitution.get(key(member.capability))
      if (replacement === undefined) return { _tag: 'Residual', member }
      if (isTypeArgument(replacement) && isNominal(replacement))
        return {
          _tag: 'Concrete',
          member: {
            capability: replacement,
            access: member.access,
            role: member.role,
          },
        }
      if (isTypeArgument(replacement) && isParameter(replacement) && replacement.kind === 'Value')
        return {
          _tag: 'Residual',
          member: requirementMemberShape(replacement, member.access, member.role),
        }
      return {
        _tag: 'InvalidSingleton',
        reason: `requirement capability ${member.capability.name} did not specialize to one nominal`,
      }
    },
  })
  return result
}

export const substituteRequirementsRow = (
  self: RequirementsRow,
  substitution: Substitution,
  compatibility?: TypeCompatibility.Context,
): RequirementsRow => {
  const result = specializeRequirementsRow(self, substitution, compatibility)
  return result._tag === 'Substituted' ? result.row : self
}

/**
 * Replaces declaration-owned parameters recursively through one canonical type. Runtime discovery
 * may pass the finite compatibility context carried by an already checked selected invocation;
 * ordinary type formation omits it and must prove representation admissibility in its own context.
 */
export const substitute = (
  self: Type,
  substitution: Substitution,
  compatibility?: TypeCompatibility.Context,
): Type => {
  if (
    (isCallable(self) || isEffect(self) || isForeignFunction(self)) &&
    self.lifetimeBinders.length > 0
  ) {
    const bound = new Set(self.lifetimeBinders.map(Lifetime.key))
    substitution = new Map([...substitution].filter(([identity]) => !bound.has(identity)))
  }
  if (isString(self)) {
    const lifetime = substituteLifetime(self.lifetime, substitution)
    return Lifetime.equals(lifetime, self.lifetime) ? self : string(lifetime)
  }
  if (isParameter(self)) {
    const replacement = substitution.get(key(self))
    return replacement !== undefined && isTypeArgument(replacement) ? replacement : self
  }
  if (isNominal(self))
    return specializeNominal(
      self,
      self.arguments.map((argument) =>
        substituteGenericArgument(argument, substitution, compatibility),
      ),
    )
  if (isFixedArray(self))
    return fixedArray(substitute(self.element, substitution, compatibility), self.length)
  if (isSlice(self))
    return slice(
      self.access,
      substitute(self.element, substitution, compatibility),
      substituteLifetime(self.lifetime, substitution),
    )
  if (isReference(self))
    return reference(
      self.access,
      substitute(self.target, substitution, compatibility),
      substituteLifetime(self.lifetime, substitution),
    )
  if (isPointer(self))
    return pointer({ ...self, pointee: substitute(self.pointee, substitution, compatibility) })
  if (isForeignFunction(self))
    return foreignFunction(
      self.parameters.map((parameter_) => substitute(parameter_, substitution, compatibility)),
      substitute(self.result, substitution, compatibility),
      self.contract,
      substituteExecutableLifetimes(self, substitution, compatibility),
    )
  if (isCallable(self))
    return callable(
      self.parameters.map((parameter_) => substitute(parameter_, substitution, compatibility)),
      substitute(self.result, substitution, compatibility),
      substituteExecutableLifetimes(self, substitution, compatibility),
      self.mode,
      self.schema === undefined
        ? undefined
        : {
            ...self.schema,
            substitution: new Map([
              ...[...self.schema.substitution.entries()].map(
                ([parameter_, argument]) =>
                  [
                    parameter_,
                    substituteGenericArgument(argument, substitution, compatibility),
                  ] as const,
              ),
              ...self.schema.binders.flatMap((binder) => {
                const replacement = substitution.get(key(binder))
                return replacement === undefined ? [] : ([[key(binder), replacement]] as const)
              }),
            ]),
          },
      self.unsafe,
    )
  if (isEffect(self)) {
    const success = substitute(self.success, substitution, compatibility)
    return effectWithRows(
      success,
      substituteFailureRow(self.failureRow, substitution, compatibility),
      substituteExecutableLifetimes(self, substitution, compatibility),
      self.access,
      substituteRequirementsRow(self.requirementRow, substitution, compatibility),
    )
  }
  if (isRepresented(self)) {
    const requiredBound = substitute(self.representation.requiredBound, substitution, compatibility)
    const contextualContract = substitute(self.contract, substitution, compatibility)
    if (!isCallable(requiredBound) && !isEffect(requiredBound)) return self
    const open = self.representation.argument
    const replacement =
      open._tag === 'RepresentationParameterArgument'
        ? substitution.get(key(open.parameter))
        : undefined
    const argument =
      replacement !== undefined && isRepresentationArgument(replacement)
        ? replacement
        : substituteGenericArgument(open, substitution, compatibility)
    if (!isRepresentationArgument(argument)) return self
    const intrinsicContract =
      argument._tag === 'RepresentationParameterArgument'
        ? argument.parameter.representationBound
        : argument.contract
    const contract =
      intrinsicContract === undefined ||
      (replacement === undefined && argument._tag === 'RepresentationParameterArgument')
        ? contextualContract
        : substitute(intrinsicContract, substitution, compatibility)
    if (!isCallable(contract) && !isEffect(contract)) return self
    return represented(contract, requiredBound, argument, compatibility)
  }
  if (isUnion(self)) {
    const normalized = union(
      self.members.map((member) => substitute(member, substitution, compatibility)),
    )
    return normalized._tag === 'Normalized' ? normalized.type : self
  }
  return self
}

/** Substitutes nested value parameters inside any erased generic argument. */
export const substituteGenericArgument = (
  self: GenericArgument,
  substitution: Substitution,
  compatibility?: TypeCompatibility.Context,
): GenericArgument => {
  if (Lifetime.isLifetime(self)) return substituteLifetime(self, substitution)
  if (isUnavailableGenericArgument(self)) return self
  if (isRepresentationParameterArgument(self)) {
    const replacement = substitution.get(key(self.parameter))
    if (replacement !== undefined) return replacement
    const bound = self.parameter.representationBound
    if (bound === undefined) return self
    const applied = substitute(bound, substitution, compatibility)
    if (!isCallable(applied) && !isEffect(applied)) return self
    return representationParameterArgument({ ...self.parameter, representationBound: applied })
  }
  if (isOpaqueRepresentationArgument(self)) {
    const contract = substitute(self.contract, substitution, compatibility)
    if (!isCallable(contract) && !isEffect(contract)) return self
    return opaqueRepresentationArgument(
      self.family,
      contract,
      self.arguments.map((argument) =>
        substituteGenericArgument(argument, substitution, compatibility),
      ),
    )
  }
  if (isCompositeEffectRepresentationArgument(self)) {
    const contract = substitute(self.contract, substitution, compatibility)
    if (!isEffect(contract)) return self
    const alternatives = self.alternatives.flatMap((alternative) => {
      const specialized = substituteGenericArgument(alternative, substitution, compatibility)
      if (
        isExactRepresentationArgument(specialized) &&
        isEffect(specialized.contract) &&
        isEffectIdentityArgument(specialized.identity)
      )
        return [specialized]
      return []
    })
    if (alternatives.length !== self.alternatives.length) return self
    return compositeEffectRepresentationArgument(contract, alternatives)
  }
  if (isExactRepresentationArgument(self)) {
    const contract = substitute(self.contract, substitution, compatibility)
    if (!isCallable(contract) && !isEffect(contract)) return self
    const identity = substituteGenericArgument(self.identity, substitution, compatibility)
    if (!isCallableIdentityArgument(identity) && !isEffectIdentityArgument(identity)) return self
    return exactRepresentationArgument(identity, contract)
  }
  if (isEffectIdentityArgument(self)) {
    let owner: ExecutableSpecializationOwner | undefined
    if (self.owner !== undefined) {
      owner = {
        declaration: self.owner.declaration,
        typeArguments: self.owner.typeArguments.map((argument) =>
          substituteGenericArgument(argument, substitution, compatibility),
        ),
        staticArgumentKeys: self.owner.staticArgumentKeys,
      }
    }
    return effectIdentityArgument(self.identity, owner)
  }
  if (isCallableIdentityArgument(self)) {
    let environment: CallableEnvironmentIdentity | undefined
    if (self.environment !== undefined) {
      environment = callableEnvironmentIdentity(self.environment.site, {
        declaration: self.environment.owner.declaration,
        typeArguments: self.environment.owner.typeArguments.map((argument) =>
          substituteGenericArgument(argument, substitution, compatibility),
        ),
        staticArgumentKeys: self.environment.owner.staticArgumentKeys,
      })
    }
    return callableIdentityArgument(
      self.identity,
      self.target,
      self.typeArguments.map((argument) =>
        substituteGenericArgument(argument, substitution, compatibility),
      ),
      environment,
    )
  }
  if (isRequirementRowArgument(self)) {
    return requirementRowArgumentFromRow(
      substituteRequirementsRow(self.row, substitution, compatibility),
    )
  }
  return substitute(self, substitution, compatibility)
}

const sameExecutableOwnerDeclaration = (
  left: ExecutableSpecializationOwner,
  right: ExecutableSpecializationOwner,
): boolean =>
  left.declaration.module === right.declaration.module &&
  left.declaration.name === right.declaration.name

/**
 * Replaces a source executable owner's open specialization with one complete discovered instance.
 * This stays a semantic type transformation: it neither inspects construction syntax nor creates a
 * second representation identity.
 */
export function specializeExecutableOwner(
  self: Type,
  owner: ExecutableSpecializationOwner,
  specializeSchema?: CallableSchemaOwnerSpecializer,
): Type
export function specializeExecutableOwner(
  self: GenericArgument,
  owner: ExecutableSpecializationOwner,
  specializeSchema?: CallableSchemaOwnerSpecializer,
): GenericArgument
export function specializeExecutableOwner(
  self: GenericArgument,
  owner: ExecutableSpecializationOwner,
  specializeSchema?: CallableSchemaOwnerSpecializer,
): GenericArgument {
  const specializeOwner = (
    current: ExecutableSpecializationOwner,
  ): ExecutableSpecializationOwner =>
    sameExecutableOwnerDeclaration(current, owner)
      ? owner
      : {
          declaration: current.declaration,
          typeArguments: current.typeArguments.map(specializeArgument),
          staticArgumentKeys: current.staticArgumentKeys,
        }
  const specializeArgument = (argument: GenericArgument): GenericArgument => {
    if (Lifetime.isLifetime(argument)) return argument
    if (isUnavailableGenericArgument(argument) || isRepresentationParameterArgument(argument))
      return argument
    if (isOpaqueRepresentationArgument(argument)) {
      const contract = specializeType(argument.contract)
      return isCallable(contract) || isEffect(contract)
        ? opaqueRepresentationArgument(
            argument.family,
            contract,
            argument.arguments.map(specializeArgument),
          )
        : argument
    }
    if (isExactRepresentationArgument(argument)) {
      const contract = specializeType(argument.contract)
      const identity = specializeArgument(argument.identity)
      return (isCallableIdentityArgument(identity) || isEffectIdentityArgument(identity)) &&
        (isCallable(contract) || isEffect(contract))
        ? exactRepresentationArgument(identity, contract)
        : argument
    }
    if (isCompositeEffectRepresentationArgument(argument)) {
      const contract = specializeType(argument.contract)
      if (!isEffect(contract)) return argument
      const alternatives = argument.alternatives.flatMap((alternative) => {
        const specialized = specializeArgument(alternative)
        return isExactRepresentationArgument(specialized) &&
          isEffect(specialized.contract) &&
          isEffectIdentityArgument(specialized.identity)
          ? [specialized]
          : []
      })
      return alternatives.length === argument.alternatives.length
        ? compositeEffectRepresentationArgument(contract, alternatives)
        : argument
    }
    if (isEffectIdentityArgument(argument))
      return effectIdentityArgument(
        argument.identity,
        argument.owner === undefined ? undefined : specializeOwner(argument.owner),
      )
    if (isCallableIdentityArgument(argument))
      return callableIdentityArgument(
        argument.identity,
        argument.target,
        argument.typeArguments.map(specializeArgument),
        argument.environment === undefined
          ? undefined
          : callableEnvironmentIdentity(
              argument.environment.site,
              specializeOwner(argument.environment.owner),
            ),
      )
    if (isRequirementRowArgument(argument))
      return requirementRowArgumentFromRow(
        RowAlgebra.mapConcreteMembers(requirementRowPolicy(), argument.row, (requirement) => {
          const capability = specializeType(requirement.capability)
          return {
            ...requirement,
            capability:
              isNominal(capability) || isParameter(capability)
                ? capability
                : requirement.capability,
          }
        }),
      )
    return specializeType(argument)
  }
  const specializeType = (type: Type): Type => {
    if (isNominal(type)) return specializeNominal(type, type.arguments.map(specializeArgument))
    if (isFixedArray(type)) return fixedArray(specializeType(type.element), type.length)
    if (isSlice(type)) return slice(type.access, specializeType(type.element), type.lifetime)
    if (isReference(type)) return reference(type.access, specializeType(type.target), type.lifetime)
    if (isPointer(type)) return pointer({ ...type, pointee: specializeType(type.pointee) })
    if (isForeignFunction(type))
      return foreignFunction(
        type.parameters.map(specializeType),
        specializeType(type.result),
        type.contract,
        type,
      )
    if (isCallable(type))
      return callable(
        type.parameters.map(specializeType),
        specializeType(type.result),
        {
          ...type,
          typeOutlives: type.typeOutlives.map((bound) => ({
            ...bound,
            type: specializeType(bound.type),
          })),
        },
        type.mode,
        type.schema === undefined
          ? undefined
          : (specializeSchema?.(type.schema, specializeType, specializeArgument) ?? type.schema),
        type.unsafe,
      )
    if (isEffect(type))
      return effectWithRows(
        specializeType(type.success),
        RowAlgebra.mapConcreteMembers(failureRowPolicy(), type.failureRow, (failure) => {
          const specialized = specializeType(failure)
          return specialized
        }),
        {
          ...type,
          typeOutlives: type.typeOutlives.map((bound) => ({
            ...bound,
            type: specializeType(bound.type),
          })),
        },
        type.access,
        RowAlgebra.mapConcreteMembers(
          requirementRowPolicy(),
          type.requirementRow,
          (requirement) => {
            const capability = specializeType(requirement.capability)
            return {
              ...requirement,
              capability:
                isNominal(capability) || isParameter(capability)
                  ? capability
                  : requirement.capability,
            }
          },
        ),
      )
    if (isRepresented(type)) {
      const contract = specializeType(type.contract)
      const requiredBound = specializeType(type.representation.requiredBound)
      const argument = specializeArgument(type.representation.argument)
      return (isCallable(contract) || isEffect(contract)) &&
        (isCallable(requiredBound) || isEffect(requiredBound)) &&
        isRepresentationArgument(argument)
        ? represented(contract, requiredBound, argument)
        : type
    }
    if (isUnion(type)) {
      const normalized = union(type.members.map(specializeType))
      return normalized._tag === 'Normalized' ? normalized.type : type
    }
    return type
  }
  return specializeArgument(self)
}

/** Collects every free semantic lifetime without conflating it with a value type parameter. */
export const freeLifetimes = (self: Type): ReadonlyArray<Lifetime.Lifetime> => [
  ...new Map(
    fold(self, {
      argument: (argument, inBinderScope) =>
        Lifetime.isLifetime(argument) &&
        argument._tag !== 'IntersectionLifetime' &&
        !inBinderScope(Lifetime.key(argument))
          ? argument
          : undefined,
    }).map((lifetime) => [Lifetime.key(lifetime), lifetime]),
  ).values(),
]

/** Facts guaranteed when an executable value is formed, independent of its invocation binders. */
export const executableFormationRequirements = (
  self: Callable | Effect,
): {
  readonly lifetimeBounds: ReadonlyArray<Lifetime.Outlives>
  readonly typeOutlives: ReadonlyArray<TypeOutlives>
} => {
  const invocation = new Set([
    ...self.lifetimeBinders.map(Lifetime.key),
    ...(isCallable(self) ? (self.schema?.binders.map(key) ?? []) : []),
  ])
  // Inference opens invocation binders to rigid placeholders before comparing contracts. Those
  // placeholders still denote invocation requirements even after the binder list has been opened.
  const independent = (lifetime: Lifetime.Lifetime): boolean =>
    Lifetime.atoms(lifetime).every(
      (member) => member._tag !== 'PlaceholderLifetime' && !invocation.has(Lifetime.key(member)),
    )
  return {
    lifetimeBounds: self.lifetimeBounds.filter(
      (bound) => independent(bound.longer) && independent(bound.shorter),
    ),
    typeOutlives: self.typeOutlives.filter(
      (bound) =>
        independent(bound.lifetime) &&
        freeLifetimes(bound.type).every(independent) &&
        parameters(bound.type).every((parameter) => !invocation.has(key(parameter))),
    ),
  }
}

const representationStorageLifetime = (
  argument: RepresentationArgument,
): Lifetime.Lifetime | undefined =>
  isRepresentationParameterArgument(argument) &&
  argument.parameter.staticProperties.includes('Intrinsic.Detached')
    ? Lifetime.staticLifetime
    : representationArgumentContract(argument)?.environment

/** Collects retained data validity, keeping executable environments independent of their outcomes. */
export const storageLifetimes = (self: Type): ReadonlyArray<Lifetime.Lifetime> => [
  ...new Map(
    fold(self, {
      type: (type) => {
        if (isCallable(type) || isEffect(type)) return type.environment
        if (isRepresented(type))
          return isRepresentationParameterArgument(type.representation.argument) &&
            type.representation.argument.parameter.staticProperties.includes('Intrinsic.Detached')
            ? Lifetime.staticLifetime
            : type.contract.environment
        if (isParameter(type) && type.representationBound !== undefined)
          return type.staticProperties.includes('Intrinsic.Detached')
            ? Lifetime.staticLifetime
            : type.representationBound.environment
        return undefined
      },
      argument: (argument) => {
        if (Lifetime.isLifetime(argument)) return argument
        if (isRepresentationArgument(argument)) return representationStorageLifetime(argument)
        return undefined
      },
      descendArgument: (argument) =>
        !isRepresentationArgument(argument) && !isHiddenIdentityArgument(argument),
      descend: (type) =>
        !isCallable(type) && !isEffect(type) && !isRepresented(type) && !isForeignFunction(type),
    }).map((lifetime) => [Lifetime.key(lifetime), lifetime]),
  ).values(),
]

/** Lists retained type nodes while keeping executable invocation contracts outside storage. */
export const storageTypes = (self: Type): ReadonlyArray<Type> =>
  fold(self, {
    type: (type) => type,
    descendArgument: (argument) =>
      !isRepresentationArgument(argument) && !isHiddenIdentityArgument(argument),
    descend: (type) =>
      !isCallable(type) && !isEffect(type) && !isRepresented(type) && !isForeignFunction(type),
  })

/** Collects every nominal declaration mentioned anywhere in one resolved semantic type. */
export const nominalTypes = (self: Type): ReadonlyArray<Nominal> => [
  ...new Map(
    fold(self, {
      type: (type) => (isNominal(type) ? type : undefined),
    }).map((type) => [key(type), type]),
  ).values(),
]

/** Collects unknown stored type parameters, excluding hypothetical executable signatures. */
export const storageParameters = (self: Type): ReadonlyArray<Parameter> => [
  ...new Map(
    fold(self, {
      type: (type) =>
        isParameter(type) && type.kind === 'Value' && type.representationBound === undefined
          ? type
          : undefined,
      descendArgument: (argument) =>
        !isRepresentationArgument(argument) && !isHiddenIdentityArgument(argument),
      descend: (type) =>
        !isCallable(type) && !isEffect(type) && !isRepresented(type) && !isForeignFunction(type),
    }).map((parameter) => [key(parameter), parameter]),
  ).values(),
]

/** Collects all distinct region identities, including locally quantified lifetime binders. */
export const lifetimes = (self: Type): ReadonlyArray<Lifetime.Lifetime> => [
  ...new Map(
    fold(self, {
      argument: (argument) => (Lifetime.isLifetime(argument) ? argument : undefined),
    }).map((lifetime) => [Lifetime.key(lifetime), lifetime]),
  ).values(),
]

/** Substitutes semantic regions using the same canonical keys as generic argument substitution. */
export const substituteLifetimes = (
  self: Type,
  substitution: ReadonlyMap<string, Lifetime.Lifetime>,
): Type => substitute(self, substitution)

/** Substitutes only region arguments; an incorrectly kinded entry cannot become a lifetime. */
export const substituteLifetime = (
  self: Lifetime.Lifetime,
  substitution: Substitution,
): Lifetime.Lifetime => {
  const replacement = substitution.get(Lifetime.key(self))
  if (replacement !== undefined && Lifetime.isLifetime(replacement)) return replacement
  return self._tag === 'IntersectionLifetime'
    ? Lifetime.intersection(self.members.map((member) => substituteLifetime(member, substitution)))
    : self
}

/** Canonicalizes data-validity predicates without dropping them from semantic identity. */
export const normalizeTypeOutlives = (
  bounds: ReadonlyArray<TypeOutlives>,
): ReadonlyArray<TypeOutlives> =>
  [
    ...new Map(
      bounds.map((bound) => [
        Canonical.record('TypeOutlives', [key(bound.type), Lifetime.key(bound.lifetime)]),
        { ...bound },
      ]),
    ).entries(),
  ]
    .sort(([left], [right]) => compareText(left, right))
    .map(([, bound]) => bound)

export const typeOutlivesKey = (bounds: ReadonlyArray<TypeOutlives>): string =>
  Canonical.array(
    normalizeTypeOutlives(bounds).map((bound) =>
      Canonical.record('TypeOutlives', [key(bound.type), Lifetime.key(bound.lifetime)]),
    ),
  )

/** Proves retained-data validity from known predicates and a caller-owned region proof. */
export const satisfiesOutlives = (
  self: Type,
  lifetime: Lifetime.Lifetime,
  bounds: ReadonlyArray<TypeOutlives>,
  proves: (longer: Lifetime.Lifetime, shorter: Lifetime.Lifetime) => boolean,
): boolean => {
  const assumed = (type: Type): boolean =>
    bounds.some(
      (bound) =>
        (equals(bound.type, type) ||
          storageParameters(bound.type).some((parameter) => equals(parameter, type))) &&
        proves(bound.lifetime, lifetime),
    )
  if (assumed(self)) return true
  if (!storageLifetimes(self).every((region) => proves(region, lifetime))) return false
  return storageParameters(self).every(
    (parameter) => parameter.staticProperties.includes('Intrinsic.Detached') || assumed(parameter),
  )
}

const executableLifetimeKey = (self: ExecutableLifetimes): string =>
  Canonical.record('ExecutableLifetimes', [
    Lifetime.key(self.environment),
    Canonical.array(self.lifetimeBinders.map(Lifetime.key)),
    Lifetime.assumptions(self.lifetimeBounds ?? []).key,
    typeOutlivesKey(self.typeOutlives ?? []),
  ])

const substituteExecutableLifetimes = (
  self: ExecutableLifetimes,
  substitution: Substitution,
  compatibility?: TypeCompatibility.Context,
): ExecutableLifetimes => ({
  environment: substituteLifetime(self.environment, substitution),
  lifetimeBinders: self.lifetimeBinders,
  typeOutlives: (self.typeOutlives ?? []).map((bound) => ({
    type: substitute(bound.type, substitution, compatibility),
    lifetime: substituteLifetime(bound.lifetime, substitution),
  })),
  lifetimeBounds: (self.lifetimeBounds ?? []).map((bound) => ({
    longer: substituteLifetime(bound.longer, substitution),
    shorter: substituteLifetime(bound.shorter, substitution),
  })),
})

export const runtimeArgumentKeys = (self: ReadonlyArray<GenericArgument>): ReadonlyArray<string> =>
  self.flatMap((argument) =>
    Lifetime.isLifetime(argument) ? [] : [runtimeGenericArgumentKey(argument)],
  )

const runtimeSubstitutionKey = (self: Substitution): string =>
  Canonical.array(
    [...self]
      .filter(([, argument]) => !Lifetime.isLifetime(argument))
      .sort(([left], [right]) => compareText(left, right))
      .map(([parameter, argument]) =>
        Canonical.record('Entry', [parameter, runtimeGenericArgumentKey(argument)]),
      ),
  )

const runtimeRowKey = <Member, SymbolicMember>(
  self: RowAlgebra.Expression<Member, Parameter, SymbolicMember>,
  memberKey: (member: Member) => string,
  symbolicKey: (member: SymbolicMember) => string,
): string => {
  switch (self._tag) {
    case 'Concrete':
      return Canonical.record(
        'Concrete',
        [...new Set(self.row.members.map(memberKey))].sort(compareText),
      )
    case 'RowParameter':
      return Canonical.record('Parameter', [runtimeKey(self.parameter)])
    case 'Singleton':
      return Canonical.record('Singleton', [symbolicKey(self.member)])
    case 'Union':
      return Canonical.record(
        'Union',
        [
          ...new Set(
            self.operands.map((operand) => runtimeRowKey(operand, memberKey, symbolicKey)),
          ),
        ].sort(compareText),
      )
    case 'Without':
      return Canonical.record('Without', [
        runtimeRowKey(self.source, memberKey, symbolicKey),
        runtimeRowKey(self.selected, memberKey, symbolicKey),
      ])
  }
}

export const runtimeFailureRowKey = (self: FailureRow): string =>
  runtimeRowKey(self.expression, runtimeKey, (member) => runtimeKey(member.parameter))

const runtimeRequirementKey = (self: Requirement): string =>
  Canonical.record('Requirement', [
    self.access,
    RequirementRow.roleKey(self.role),
    runtimeKey(self.capability),
  ])

export const runtimeRequirementsRowKey = (self: RequirementsRow): string =>
  runtimeRowKey(self.expression, runtimeRequirementKey, (member) =>
    Canonical.record('Requirement', [
      member.access,
      RequirementRow.roleKey(member.role),
      runtimeKey(member.capability),
    ]),
  )

export const runtimeConstraintKey = (self: Constraint.Constraint): string => {
  switch (self._tag) {
    case 'NominalMemberConstraint':
      return Canonical.record(self._tag, [
        runtimeKey(self.selected),
        runtimeFailureRowKey(self.source),
      ])
    case 'FailureSubsetConstraint':
      return Canonical.record(self._tag, [
        runtimeFailureRowKey(self.selected),
        runtimeFailureRowKey(self.source),
      ])
    case 'RequirementSubsetConstraint':
      return Canonical.record(self._tag, [
        runtimeRequirementsRowKey(self.selected),
        runtimeRequirementsRowKey(self.source),
      ])
    case 'ProviderSelectionConstraint':
      return Canonical.record(self._tag, [
        self.mode,
        runtimeKey(self.provider),
        runtimeRequirementsRowKey(self.selected),
        runtimeRequirementsRowKey(self.source),
      ])
  }
}

const runtimeWitnessKey = (self: Constraint.ProviderMatch): string =>
  self._tag === 'Identity'
    ? 'Identity'
    : Canonical.record('Conformance', [
        self.witness.origin._tag === 'SourceWitness'
          ? Canonical.record('Source', [
              self.witness.origin.declaration.module,
              self.witness.origin.declaration.name,
            ])
          : Canonical.record('Intrinsic', [self.witness.origin.operation]),
        Canonical.array(runtimeArgumentKeys(self.witness.typeArguments)),
      ])

export const runtimeEvidenceKey = (self: Constraint.ConstraintEvidence): string => {
  switch (self._tag) {
    case 'Assumed':
      return Canonical.record(self._tag, [
        runtimeConstraintKey(self.wanted),
        runtimeSubstitutionKey(self.substitution),
      ])
    case 'Member':
      return Canonical.record(self._tag, [
        runtimeKey(self.selected),
        runtimeFailureRowKey(self.source),
      ])
    case 'FailureSubset':
      return Canonical.record(self._tag, [
        runtimeFailureRowKey(self.selected),
        runtimeFailureRowKey(self.source),
      ])
    case 'RequirementSubset':
      return Canonical.record(self._tag, [
        runtimeRequirementsRowKey(self.selected),
        runtimeRequirementsRowKey(self.source),
      ])
    case 'RequirementSelection':
      return Canonical.record(self._tag, [
        runtimeConstraintKey(self.wanted),
        runtimeRequirementKey(self.selected),
        runtimeKey(self.provider),
        self.providerMode,
        runtimeWitnessKey(self.providerMatch),
      ])
  }
}

const runtimeCallableSchemaKey = (self: CallableSchema): string =>
  Canonical.record('Schema', [
    self.contract.functionKind,
    self.contract.unsafe ? 'unsafe' : 'safe',
    Canonical.array(
      self.contract.binders.filter((binder) => binder.kind !== 'Lifetime').map(runtimeKey),
    ),
    Canonical.array(
      self.contract.parameters.map((parameter) =>
        Canonical.record('Parameter', [parameter.mode, runtimeKey(parameter.type)]),
      ),
    ),
    runtimeKey(self.contract.result),
    Canonical.array(self.contract.constraints.map(runtimeConstraintKey)),
    Canonical.array(
      self.contract.captures.map((capture) =>
        Canonical.record('Capture', [`${capture.parameter}`, `${capture.capture}`]),
      ),
    ),
    Canonical.array(self.constraints.map(runtimeConstraintKey)),
    Canonical.array(self.evidence.map(runtimeEvidenceKey)),
    runtimeSubstitutionKey(self.substitution),
  ])

const runtimeOwnerKey = (self: ExecutableSpecializationOwner): string =>
  Canonical.record('Owner', [
    self.declaration.module,
    self.declaration.name,
    Canonical.array(runtimeArgumentKeys(self.typeArguments)),
    Canonical.array(self.staticArgumentKeys),
  ])

/** Erases proof-only owner arguments from a physical callable environment identity. */
export const runtimeCallableEnvironmentIdentityKey = (self: CallableEnvironmentIdentity): string =>
  Canonical.record('Environment', [
    callableEnvironmentSiteKey(self.site),
    runtimeOwnerKey(self.owner),
  ])

/**
 * Encodes runtime-relevant generic identity. A bare lifetime returns the empty marker; enclosing
 * argument lists omit those entries entirely. This key never participates in semantic equality.
 */
export const runtimeGenericArgumentKey = (self: GenericArgument): string => {
  if (Lifetime.isLifetime(self)) return ''
  if (isUnavailableGenericArgument(self)) return genericArgumentKey(self)
  if (isRepresentationParameterArgument(self))
    return Canonical.record('RepresentationParameter', [runtimeKey(self.parameter)])
  if (isRequirementRowArgument(self)) return runtimeRequirementsRowKey(self.row)
  if (isOpaqueRepresentationArgument(self))
    return Canonical.record('Opaque', [
      opaqueFamilyKey(self.family),
      runtimeKey(self.contract),
      Canonical.array(runtimeArgumentKeys(self.arguments)),
    ])
  if (isExactRepresentationArgument(self))
    return Canonical.record('Exact', [
      runtimeGenericArgumentKey(self.identity),
      runtimeKey(self.contract),
    ])
  if (isCompositeEffectRepresentationArgument(self))
    return Canonical.record('CompositeEffect', [
      runtimeKey(self.contract),
      Canonical.array(
        [...new Set(self.alternatives.map(runtimeGenericArgumentKey))].sort(compareText),
      ),
    ])
  if (isEffectIdentityArgument(self))
    return Canonical.record('EffectIdentity', [
      self.identity,
      self.owner === undefined ? '' : runtimeOwnerKey(self.owner),
    ])
  if (isCallableIdentityArgument(self))
    return Canonical.record('CallableIdentity', [
      self.identity,
      self.target._tag === 'Declaration'
        ? Canonical.record('Declaration', [self.target.module, self.target.name])
        : Canonical.record('Builtin', [
            self.target.actor,
            self.target.operation,
            self.target.intrinsic.actor,
            self.target.intrinsic.name,
          ]),
      Canonical.array(runtimeArgumentKeys(self.typeArguments)),
      self.environment === undefined ? '' : runtimeCallableEnvironmentIdentityKey(self.environment),
    ])
  return runtimeKey(self)
}

/** Memoized on the type object itself, like `key`. */
const cachedRuntimeKey: unique symbol = Symbol('Type.runtimeKey')

/**
 * Encodes a layout/instance type identity with all lifetime proof arguments erased.
 * Like semantic keys, runtime keys are memoized on the immutable type object in a
 * non-enumerable property: instance keys and layouts key many fresh substitution results
 * exactly once, where a weak map paid an ephemeron insertion each and grew every major GC.
 */
export const runtimeKey = (self: Type): string => {
  if (typeof self === 'string') return key(self)
  const cached: unknown = Reflect.get(self, cachedRuntimeKey)
  if (typeof cached === 'string') return cached
  const computed = computeRuntimeKey(self)
  if (Object.isExtensible(self)) Object.defineProperty(self, cachedRuntimeKey, { value: computed })
  return computed
}

const computeRuntimeKey = (self: Exclude<Type, string>): string => {
  if (isString(self)) return 'string'
  if (isParameter(self)) return self.kind === 'Lifetime' ? '' : key(self)
  if (isNominal(self))
    return Canonical.record('Nominal', [
      self.module,
      self.name,
      self.sealed ?? '',
      Canonical.array(runtimeArgumentKeys(self.arguments)),
    ])
  if (isFixedArray(self))
    return Canonical.record('Array', [`${self.length}`, runtimeKey(self.element)])
  if (isSlice(self)) return Canonical.record('Slice', [self.access, runtimeKey(self.element)])
  if (isReference(self))
    return Canonical.record('Reference', [self.access, runtimeKey(self.target)])
  if (isPointer(self))
    return Canonical.record('Pointer', [pointerQualifierKey(self), runtimeKey(self.pointee)])
  if (isForeignFunction(self))
    return Canonical.record('ForeignFunction', [
      self.abi,
      'nonnull',
      ForeignContract.key(self.contract),
      Canonical.array(self.parameters.map(runtimeKey)),
      runtimeKey(self.result),
    ])
  if (isCallable(self))
    return Canonical.record('Callable', [
      self.unsafe ? 'unsafe' : 'safe',
      self.mode,
      Canonical.array(self.parameters.map(runtimeKey)),
      runtimeKey(self.result),
      self.schema === undefined ? '' : runtimeCallableSchemaKey(self.schema),
    ])
  if (isEffect(self))
    return Canonical.record('Effect', [
      self.access,
      runtimeKey(self.success),
      runtimeFailureRowKey(self.failureRow),
      runtimeRequirementsRowKey(self.requirementRow),
    ])
  if (isRepresented(self))
    return Canonical.record('Represented', [
      runtimeKey(self.contract),
      runtimeKey(self.representation.requiredBound),
      runtimeGenericArgumentKey(self.representation.argument),
    ])
  return Canonical.record('Union', [...new Set(self.members.map(runtimeKey))].sort(compareText))
}
