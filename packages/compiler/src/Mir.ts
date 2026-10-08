import type * as Lifetime from './Lifetime.js'
import type * as AuthoredIdentity from './AuthoredIdentity.js'
import type * as ExecutionStorageComponent from './ExecutionStorageComponent.js'
import type * as MachineFunction from './MachineFunction.js'
import type * as NativeAssembly from './NativeAssembly.js'
import type * as CAbi from './CAbi.js'
import type * as CleanupPlan from './CleanupPlan.js'
import type * as DeclarationFacts from './DeclarationFacts.js'
import type * as ExecutionPackage from './ExecutionPackage.js'
import type * as ExecutionTransition from './ExecutionTransition.js'
import * as Tir from './Tir.js'
import * as Instances from './Instances.js'
import * as EffectExecutionContract from './internal/EffectExecutionContract.js'
import * as Layout from './Layout.js'
import * as LayoutVerify from './LayoutVerify.js'
import type * as LocalSharedControlBlock from './LocalSharedControlBlock.js'
import type * as Match from './Match.js'
import type * as MovePath from './MovePath.js'
import { instanceText, operationLocals } from './MirVerification.js'
import type * as Scalar from './Scalar.js'
import type * as SourceSpan from './SourceSpan.js'
import type * as StaticText from './StaticText.js'
import * as StaticValue from './StaticValue.js'
import type {
  SuspensionBorrowIdentity,
  SuspensionClassification,
  SuspensionCompletion,
  SuspensionControlEdge,
  SuspensionPointId,
  SuspensionProviderArgument,
  SuspensionRegion,
  SuspensionRunner,
} from './Suspension.js'
import * as SilkType from './Type.js'
import * as TypeCompatibility from './TypeCompatibility.js'
import * as Effect from 'effect/Effect'
import type * as Realization from './Realization.js'

export type LoweringInput = Realization.MirLoweringInput
export type LoweringResult = Realization.MirLoweringResult

/** Lowers explicit admitted instance/layout artifacts without reopening semantic or source state. */
export const lower = Effect.fn('Mir.lower')(function* (
  input: LoweringInput,
): Effect.fn.Return<LoweringResult> {
  // The implementation is loaded lazily because the MIR data actor is imported by the lowerers.
  const implementation = yield* Effect.promise(() => import('./Realization.js'))
  return yield* implementation.lowerMir(input)
})

/**
 * MIR is the monomorphic, target-aware, backend-neutral structured control DAG. Structural child
 * and continuation references are acyclic. Loop repetition and exit are lexical outcomes rather
 * than graph edges; only a backend-private lowering may introduce a cyclic CFG.
 */

/** Exact lowered operands of one invocation; checked by ownership and MIR verification. */
export interface InvocationUse {
  readonly kind: 'Source' | 'Recovery'
  readonly owner: Lifetime.Owner
  readonly origin: AuthoredIdentity.Anchor
  readonly binder: Lifetime.Bound
  readonly lifetime: Lifetime.Local
  readonly inputs: ReadonlyArray<{
    readonly parameter: number
    /** When present, argument is the retained callable container and this is its original slot. */
    readonly capture?: number
    readonly capturePath?: ReadonlyArray<Tir.InvocationCapturePathStep>
    /** Genuine incoming parameter authority, separate from original formation provenance. */
    readonly header?: { readonly parameter: number; readonly source: AuthoredIdentity.Anchor }
    readonly argument: LocalId
    readonly type: SilkType.Type
    readonly source?: AuthoredIdentity.Anchor
  }>
  readonly result: LocalId
}

/** External referents needed while one actual invocation-produced holder is parked. */
export interface InvocationUseRetention {
  readonly invocation: InvocationUse
  readonly holder: LocalId
  /** Formation captures retain η independently of original invocation inputs. */
  readonly environment: ReadonlyArray<{
    readonly argument: LocalId
    readonly referents: InvocationUseRetention['dependencies'][number]['referents']
    readonly contents: InvocationUseRetention['dependencies'][number]['contents']
  }>
  readonly dependencies: ReadonlyArray<{
    readonly parameter: number
    readonly capture?: number
    readonly capturePath?: ReadonlyArray<Tir.InvocationCapturePathStep>
    readonly argument: LocalId
    readonly referents: ReadonlyArray<{
      readonly root: LocalId
      readonly loan: SuspensionBorrowIdentity
    }>
    /** Header-owned borrowed contents; these are never a second owner of the parameter cell. */
    readonly contents: ReadonlyArray<{
      readonly parameter: number
      readonly path: ReadonlyArray<
        | { readonly _tag: 'Field'; readonly field: DeclarationFacts.FieldId }
        | { readonly _tag: 'Element'; readonly index: number }
        | { readonly _tag: 'Variant'; readonly ordinal: number }
        | { readonly _tag: 'Capture'; readonly ordinal: number }
        | { readonly _tag: 'DeclaredContents'; readonly component: number }
      >
      readonly type: SilkType.Type
      readonly region: Lifetime.Lifetime
    }>
  }>
}

export type ScalarType = {
  readonly [Spelling in SilkType.Builtin]: { readonly _tag: Spelling }
}[SilkType.Builtin]

export type Type =
  | ScalarType
  | { readonly _tag: 'Bottom'; readonly type: SilkType.Bottom }
  | { readonly _tag: 'Nominal'; readonly type: SilkType.Nominal }
  | {
      readonly _tag: 'Enum'
      readonly type: SilkType.Nominal
      readonly representation: Extract<Layout.Representation, { readonly _tag: 'ScalarEnum' }>
    }
  | { readonly _tag: 'FixedArray'; readonly type: SilkType.FixedArray }
  | { readonly _tag: 'String'; readonly type: SilkType.String }
  | { readonly _tag: 'Slice'; readonly type: SilkType.Slice }
  | { readonly _tag: 'Reference'; readonly type: SilkType.Reference }
  | { readonly _tag: 'Pointer'; readonly type: SilkType.Pointer }
  | { readonly _tag: 'ForeignFunction'; readonly type: SilkType.ForeignFunction }
  | { readonly _tag: 'Union'; readonly type: SilkType.StructuralUnion }
  | {
      readonly _tag: 'EnvironmentBorrow'
      readonly type: DeclarationFacts.SemanticType
      readonly access: 'Shared' | 'Exclusive'
    }
  | {
      readonly _tag: 'EffectValue'
      /** Source-checked parameter view; the physical environment remains the actual producer. */
      readonly inputView?: ExecutableInputView
      readonly type: SilkType.Effect
      readonly site: Tir.EffectSiteId
      readonly environment: Extract<
        Layout.EffectEnvironment,
        { readonly _tag: 'EffectEnvironment' }
      >
      readonly storage?: {
        readonly _tag: 'StoredEffectField'
        readonly type: SilkType.Represented
        readonly realization: Extract<
          Layout.Representation,
          { readonly _tag: 'StoredEffectEnvironment' }
        >['realization']
      }
    }
  | {
      readonly _tag: 'EffectComposite'
      readonly type: SilkType.Represented
      readonly contract: SilkType.Effect
      readonly alternatives: ReadonlyArray<Extract<Type, { readonly _tag: 'EffectValue' }>>
    }
  | {
      readonly _tag: 'CallableValue'
      /** Source-checked parameter view; no callable environment is reconstructed. */
      readonly inputView?: ExecutableInputView
      readonly type: SilkType.Callable
      readonly target: Tir.CallableTarget
      readonly typeArguments?: ReadonlyArray<SilkType.GenericArgument>
      readonly site?: Tir.CallableSiteId
      readonly environment?: Extract<
        Layout.CallableEnvironment,
        { readonly _tag: 'CallableEnvironment' }
      >
      readonly storage?: {
        readonly _tag: 'StoredCallableField'
        readonly type: SilkType.Represented
        readonly realization: Extract<
          Layout.Representation,
          { readonly _tag: 'CallableEnvironment' }
        >['realization']
      }
    }
  | { readonly _tag: 'EffectOutcome'; readonly type: SilkType.Effect }

export const semanticType = (self: Type): DeclarationFacts.SemanticType => {
  if (self._tag === 'CallableValue' || self._tag === 'EffectValue')
    return self.storage?.type ?? self.type
  if (self._tag === 'EffectComposite') return self.type
  return self._tag === 'Nominal' ||
    self._tag === 'Enum' ||
    self._tag === 'Bottom' ||
    self._tag === 'FixedArray' ||
    self._tag === 'String' ||
    self._tag === 'Slice' ||
    self._tag === 'Reference' ||
    self._tag === 'Pointer' ||
    self._tag === 'ForeignFunction' ||
    self._tag === 'Union' ||
    self._tag === 'EnvironmentBorrow' ||
    self._tag === 'EffectOutcome'
    ? self.type
    : self._tag
}

/** Distinguishes borrowing a stored view descriptor from reborrowing the memory it denotes. */
export const borrowsDescriptor = (
  self: Extract<Operation, { readonly _tag: 'BeginLoan' }>,
): boolean =>
  !self.reborrow &&
  self.type._tag === 'Reference' &&
  (self.sourceType._tag === 'Reference' || self.sourceType._tag === 'Slice') &&
  SilkType.runtimeKey(self.type.type.target) === SilkType.runtimeKey(semanticType(self.sourceType))

export const typeText = (self: Type): string => SilkType.encode(semanticType(self))
/** Reads the concrete sealed Copy verdict published by target layout. */
export const isCopy = (layout: Layout.Plan, type: DeclarationFacts.SemanticType): boolean =>
  Layout.entry(layout, type)?.copy === true

const callingScalarEquals = (left: Layout.CallingScalar, right: Layout.CallingScalar): boolean =>
  typeof left === 'string'
    ? left === right
    : typeof right !== 'string' &&
      SilkType.runtimeKey(left.element) === SilkType.runtimeKey(right.element) &&
      left.bits === right.bits

export const callingShapeEquals = (
  left: Layout.CallingShape,
  right: Layout.CallingShape,
): boolean =>
  left.laneCount === right.laneCount &&
  left.lanes.length === right.lanes.length &&
  left.lanes.every((lane, ordinal) => {
    const candidate = right.lanes.at(ordinal)
    return (
      candidate !== undefined &&
      callingScalarEquals(lane.type, candidate.type) &&
      lane.path.length === candidate.path.length &&
      lane.path.every((selector, index) => {
        const other = candidate.path.at(index)
        return other !== undefined && LayoutVerify.selectorEquals(selector, other)
      })
    )
  })

export interface LocalId {
  readonly _tag: 'Local'
  readonly ordinal: number
}

export interface RegionId {
  readonly _tag: 'Region'
  readonly ordinal: number
}

export interface LoopId {
  readonly _tag: 'Loop'
  readonly ordinal: number
}

export interface Provenance {
  readonly span: SourceSpan.SourceSpan
  readonly generated: boolean
}

export type NormalizationRejection =
  | 'InvocationUse'
  | 'ComplexConstructor'
  | 'DynamicTarget'
  | 'EffectEscapes'
  | 'EffectReused'
  | 'AffineCapture'
  | 'CrossRegionUse'
  | 'SuspendableRunner'
  | 'SuspensionUnknown'

export type NormalizationVerdict =
  | {
      readonly _tag: 'Normalized'
      readonly kind: 'FoldedConstructor' | 'DirectStaticRun'
      readonly function: DeclarationFacts.CanonicalId
      readonly region: RegionId
      readonly local: LocalId
      readonly guards: ReadonlyArray<
        | 'DirectTarget'
        | 'SingleRegion'
        | 'TrivialCleanup'
        | 'SingleUse'
        | 'Synchronous'
        | 'CopyOrShared'
      >
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'Rejected'
      readonly reason: NormalizationRejection
      readonly function: DeclarationFacts.CanonicalId
      readonly region: RegionId
      readonly local: LocalId
      readonly provenance: Provenance
    }

export type BinaryOperator =
  | 'Add'
  | 'Subtract'
  | 'Multiply'
  | 'Divide'
  | 'Remainder'
  | 'Equals'
  | 'NotEquals'
  | 'LessThan'
  | 'LessOrEqual'
  | 'GreaterThan'
  | 'GreaterOrEqual'
  | 'BitAnd'
  | 'BitOr'
  | 'BitXor'
  | 'ShiftLeft'
  | 'ShiftRight'
  | 'RotateLeft'
  | 'RotateRight'
  | 'WrappingAdd'
  | 'WrappingSubtract'
  | 'WrappingMultiply'
  | 'SaturatingAdd'
  | 'SaturatingSubtract'
  | 'SaturatingMultiply'
  | 'TotalOrder'

export const isBinaryOperator = (operation: Tir.BuiltinOperation): operation is BinaryOperator =>
  operation === 'Add' ||
  operation === 'Subtract' ||
  operation === 'Multiply' ||
  operation === 'Divide' ||
  operation === 'Remainder' ||
  operation === 'Equals' ||
  operation === 'NotEquals' ||
  operation === 'LessThan' ||
  operation === 'LessOrEqual' ||
  operation === 'GreaterThan' ||
  operation === 'GreaterOrEqual' ||
  operation === 'BitAnd' ||
  operation === 'BitOr' ||
  operation === 'BitXor' ||
  operation === 'ShiftLeft' ||
  operation === 'ShiftRight' ||
  operation === 'RotateLeft' ||
  operation === 'RotateRight' ||
  operation === 'WrappingAdd' ||
  operation === 'WrappingSubtract' ||
  operation === 'WrappingMultiply' ||
  operation === 'SaturatingAdd' ||
  operation === 'SaturatingSubtract' ||
  operation === 'SaturatingMultiply' ||
  operation === 'TotalOrder'

export type PlaceSelector =
  | {
      readonly _tag: 'VariantSelector'
      readonly ordinal: number
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'FieldSelector'
      readonly field: DeclarationFacts.FieldId
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ElementSelector'
      readonly length: number
      readonly index:
        | { readonly _tag: 'Proven'; readonly value: number }
        | { readonly _tag: 'Runtime'; readonly local: LocalId }
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'SliceElementSelector'
      readonly index: LocalId
      readonly access: SilkType.Slice['access']
      readonly provenance: Provenance
    }

/** One exact nonparking Effect retained for structured cancellation of a protected run. */
export interface EffectCancellationFinalizer {
  readonly _tag: 'EffectCancellationFinalizer'
  readonly effect: LocalId
  readonly runner: DeclarationFacts.CanonicalId
  readonly runnerTypeArguments: ReadonlyArray<SilkType.GenericArgument>
  readonly runnerStaticArguments?: ReadonlyArray<StaticValue.Value>
  readonly arguments: ReadonlyArray<LocalId>
  readonly outcomeType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
}

/** One owned resource and release builder retained until a protected borrow has ended. */
export interface ResourceCancellationFinalizer {
  readonly _tag: 'ResourceCancellationFinalizer'
  readonly resource: LocalId
  readonly release: LocalId
  readonly releaseTarget: DeclarationFacts.CanonicalId
  readonly releaseTypeArguments: ReadonlyArray<SilkType.GenericArgument>
  readonly runner: DeclarationFacts.CanonicalId
  readonly runnerTypeArguments: ReadonlyArray<SilkType.GenericArgument>
  readonly runnerStaticArguments?: ReadonlyArray<StaticValue.Value>
  readonly arguments: ReadonlyArray<LocalId>
  readonly outcomeType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
}

export type CancellationFinalizer = EffectCancellationFinalizer | ResourceCancellationFinalizer

export type Operation =
  | {
      readonly _tag: 'NativeAssembly'
      readonly assembly: NativeAssembly.NativeAssembly
      readonly destination: LocalId
      readonly arguments: ReadonlyArray<LocalId>
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      /** Updates a compiler-owned Boolean presence flag without reading an owned value. */
      readonly _tag: 'SetInitialized'
      readonly flag: LocalId
      readonly initialized: boolean
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ForeignStaticLoad'
      readonly destination: LocalId
      readonly declaration: DeclarationFacts.CanonicalId
      readonly direction: 'Import' | 'Export'
      readonly symbol: string
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ForeignFunctionAddress'
      readonly destination: LocalId
      readonly target: Tir.CallableTarget
      readonly symbol: string
      readonly type: Extract<Type, { readonly _tag: 'ForeignFunction' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'Literal'
      readonly destination: LocalId
      readonly type: Type
      readonly value: number | bigint
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'EnumConstant'
      readonly destination: LocalId
      readonly enum: DeclarationFacts.CanonicalId
      readonly member: DeclarationFacts.CanonicalEnumMemberId
      readonly discriminant: bigint
      readonly representation: Extract<Layout.Representation, { readonly _tag: 'ScalarEnum' }>
      readonly type: Extract<Type, { readonly _tag: 'Enum' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'EnumValue'
      readonly destination: LocalId
      readonly source: LocalId
      readonly enum: DeclarationFacts.CanonicalId
      readonly representation: Extract<Layout.Representation, { readonly _tag: 'ScalarEnum' }>
      readonly type: ScalarType
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'EnumEquality'
      readonly destination: LocalId
      readonly left: LocalId
      readonly right: LocalId
      readonly enum: DeclarationFacts.CanonicalId
      readonly negated: boolean
      readonly representation: Extract<Layout.Representation, { readonly _tag: 'ScalarEnum' }>
      readonly type: Extract<Type, { readonly _tag: 'bool' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'StaticView'
      readonly destination: LocalId
      readonly data: string
      readonly length: number
      readonly type: Extract<Type, { readonly _tag: 'Slice' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'StaticString'
      readonly destination: LocalId
      readonly data: string
      readonly byteLength: number
      readonly type: Extract<Type, { readonly _tag: 'String' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'StringFromUtf8Unchecked'
      readonly destination: LocalId
      readonly bytes: LocalId
      readonly heldLoans: ReadonlyArray<Tir.BorrowId>
      readonly authorization: 'Unsafe'
      readonly type: Extract<Type, { readonly _tag: 'String' }>
      readonly provenance: Provenance
    }
  | {
      /** Bounds-checked shared subrange retaining the source slice's backing storage. */
      readonly _tag: 'SliceView'
      readonly destination: LocalId
      readonly slice: LocalId
      readonly offset: LocalId
      readonly length: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly stride: number
      readonly heldLoans: ReadonlyArray<Tir.BorrowId>
      readonly type: Extract<Type, { readonly _tag: 'Slice' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'StringUtf8Bytes'
      readonly destination: LocalId
      readonly string: LocalId
      readonly heldLoans: ReadonlyArray<Tir.BorrowId>
      readonly type: Extract<Type, { readonly _tag: 'Slice' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'StringByteLength'
      readonly destination: LocalId
      readonly string: LocalId
      readonly type: Extract<Type, { readonly _tag: 'usize' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'StringEqualsExact'
      readonly destination: LocalId
      readonly left: LocalId
      readonly right: LocalId
      readonly negated: boolean
      readonly type: Extract<Type, { readonly _tag: 'bool' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'Binary'
      readonly operator: BinaryOperator
      readonly destination: LocalId
      readonly left: LocalId
      readonly right: LocalId
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ConvertInteger'
      readonly destination: LocalId
      readonly source: LocalId
      readonly sourceType: ScalarType
      readonly type: ScalarType
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ConvertScalar'
      readonly destination: LocalId
      readonly source: LocalId
      readonly sourceType: ScalarType
      readonly type: ScalarType
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ReinterpretScalar'
      readonly destination: LocalId
      readonly source: LocalId
      readonly sourceType: ScalarType
      readonly type: ScalarType
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'FloatUnary'
      readonly operation:
        | 'Negate'
        | 'Sqrt'
        | 'IsNaN'
        | 'IsInfinite'
        | 'IsFinite'
        | 'IsNormal'
        | 'IsSubnormal'
        | 'IsSignNegative'
      readonly destination: LocalId
      readonly source: LocalId
      readonly sourceType: ScalarType
      readonly type: ScalarType
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'FloatTranscendental'
      readonly operation: 'Sin' | 'Cos'
      readonly destination: LocalId
      readonly source: LocalId
      readonly sourceType: ScalarType
      readonly type: ScalarType
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'CheckedScalar'
      readonly operation: Scalar.OperationCode
      readonly destination: LocalId
      readonly valid: LocalId
      readonly value: LocalId
      readonly operands: ReadonlyArray<LocalId>
      readonly present: LocalId
      readonly absent: LocalId
      readonly presentCleanup: CleanupPlan.CleanupPlan
      readonly absentCleanup: CleanupPlan.CleanupPlan
      readonly sourceType: ScalarType
      readonly valueType: ScalarType
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ValidateLayout'
      readonly destination: LocalId
      readonly bytes: LocalId
      readonly alignment: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Union' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'RepeatLayout'
      readonly destination: LocalId
      readonly layout: LocalId
      readonly count: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Union' }>
      readonly provenance: Provenance
    }
  | {
      /** Creates one logical heap block and its self-contained reclaim ticket. */
      readonly _tag: 'Allocate'
      readonly destination: LocalId
      readonly layout: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly failure: SilkType.Nominal
      readonly propagationType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly failureTag: number
      readonly provenance: Provenance
    }
  | {
      /** Invokes a runtime native C address under its exact classified signature. */
      readonly _tag: 'ForeignIndirectCall'
      readonly destination: LocalId
      readonly callee: LocalId
      readonly signature: CAbi.CAbiSignature
      readonly arguments: ReadonlyArray<LocalId>
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      /** Calls one foreign (`extern "C"`) symbol directly under its classified C signature. */
      readonly _tag: 'ForeignCall'
      readonly variadicArguments: ReadonlyArray<CAbi.VariadicArgument>
      readonly destination: LocalId
      readonly symbol: string
      readonly abi: 'C'
      readonly signature: CAbi.CAbiSignature
      readonly arguments: ReadonlyArray<LocalId>
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'RawBufferFrom'
      readonly destination: LocalId
      readonly allocation: LocalId
      readonly count: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly stride: number
      readonly elementAlignment: number
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Consumes one exact allocation and T into one initialized local-shared control block. */
      readonly _tag: 'SharedFromAllocation'
      readonly destination: LocalId
      readonly allocation: LocalId
      readonly value: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly block: LocalSharedControlBlock.Plan
      readonly allocationBlock: LocalSharedControlBlock.Plan
      /** Stable index into the canonical target-layout allocation-provenance plan. */
      readonly allocationFact: number
      /** Canonical allocation-layout origin retained from target planning. */
      readonly allocationProvenance: SourceSpan.SourceSpan
      readonly allocationAccess: 'Take'
      readonly valueAccess: 'Take'
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Consumes every input into one exact Initial execution package without running source. */
      readonly _tag: 'ExecutionFromAllocation'
      readonly destination: LocalId
      readonly allocation: LocalId
      readonly body: LocalId
      readonly endpoint: LocalId
      readonly callback: LocalId
      readonly plan: ExecutionPackage.Plan
      readonly bodyCleanup: CleanupPlan.CleanupPlan
      readonly endpointCleanup: CleanupPlan.CleanupPlan
      readonly callbackCleanup: CleanupPlan.CleanupPlan
      /** Stable index into the canonical target-layout allocation-provenance plan. */
      readonly allocationFact: number
      /** Canonical execution-layout origin retained from target planning. */
      readonly allocationProvenance: SourceSpan.SourceSpan
      readonly allocationAccess: 'Take'
      readonly bodyAccess: 'Take'
      readonly endpointAccess: 'Take'
      readonly callbackAccess: 'Take'
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Enters one verified execution activation and invokes exactly one take-once outcome. */
      readonly _tag: 'ExecutionDrive'
      readonly destination: LocalId
      /** Private result slot populated before the completion callback consumes it. */
      readonly result: LocalId
      readonly execution: LocalId
      readonly branch: LocalId
      readonly onComplete: LocalId
      readonly onSuspend: LocalId
      readonly executionAccess: 'Take'
      readonly branchAccess: 'Take'
      readonly completionAccess: 'Take'
      readonly suspensionAccess: 'Take'
      readonly completionCleanup: CleanupPlan.CleanupPlan
      readonly suspensionCleanup: CleanupPlan.CleanupPlan
      readonly completionTypeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly suspensionTypeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Publishes one Initial package exactly once and invokes its fixed readiness endpoint. */
      readonly _tag: 'ExecutionNotifyInitial'
      readonly destination: LocalId
      readonly execution: LocalId
      readonly executionAccess: 'Exclusive'
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Consumes the generation's sole affine Wake readiness authority. */
      readonly _tag: 'ExecutionWake'
      readonly destination: LocalId
      readonly wake: LocalId
      readonly wakeAccess: 'Take'
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Registers one Wake and retains the returned guard before relinquishing this execution. */
      readonly _tag: 'ExecutionPark'
      readonly destination: LocalId
      /** Private guard slot retained by the execution-owned suspension state. */
      readonly guard: LocalId
      readonly register: LocalId
      readonly registerAccess: 'Take'
      readonly guardCleanup: CleanupPlan.CleanupPlan
      readonly registerCleanup: CleanupPlan.CleanupPlan
      readonly registrationTypeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Allocation-free compare-before-increment of one local strong count. */
      readonly _tag: 'SharedClone'
      readonly destination: LocalId
      readonly self: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly block: LocalSharedControlBlock.Plan
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** One closed access transition which invokes exactly one take-once callback. */
      readonly _tag: 'SharedWithMut'
      readonly destination: LocalId
      readonly payload: LocalId
      readonly self: LocalId
      readonly use: LocalId
      readonly onConflict: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly block: LocalSharedControlBlock.Plan
      readonly useType: SilkType.Callable
      readonly conflictType: SilkType.Callable
      readonly useCleanup: CleanupPlan.CleanupPlan
      readonly conflictCleanup: CleanupPlan.CleanupPlan
      /** Compiler-owned identity of the callback-scoped exclusive payload loan. */
      readonly loan: Tir.BorrowId
      /** Must remain empty: no result or executable state may retain `loan`. */
      readonly retainedLoans: ReadonlyArray<Tir.BorrowId>
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'RawBufferCount'
      readonly destination: LocalId
      readonly buffer: LocalId
      readonly type: Extract<Type, { readonly _tag: 'usize' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'RawBufferSlot'
      readonly destination: LocalId
      readonly buffer: LocalId
      readonly index: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Bounds-checked non-consuming read through a shared RawBuffer borrow. */
      readonly _tag: 'RawBufferRead'
      readonly destination: LocalId
      readonly buffer: LocalId
      readonly index: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      /** Allocation-free view over a caller-proven initialized RawBuffer range. */
      readonly _tag: 'RawBufferView'
      readonly destination: LocalId
      readonly buffer: LocalId
      readonly offset: LocalId
      readonly length: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly stride: number
      readonly access: SilkType.Slice['access']
      readonly type: Extract<Type, { readonly _tag: 'Slice' }>
      readonly provenance: Provenance
    }
  | {
      /**
       * Bulk ownership transfer of a caller-proven range into raw storage. The result is as if
       * the range travelled through an intermediate buffer, so an overlapping source and
       * destination is a correct move rather than undefined behavior.
       */
      readonly _tag: 'RawBufferCopy'
      readonly destination: LocalId
      readonly buffer: LocalId
      readonly offset: LocalId
      readonly source: LocalId
      readonly length: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly stride: number
      /**
       * True when the element type is structurally Copy. A move of a Copy element leaves the
       * source range readable, which is what the byte-level backends do for every element type.
       */
      readonly retainsSource: boolean
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** Sets a caller-proven byte range of raw storage to one repeated byte value. */
      readonly _tag: 'RawBufferFill'
      readonly destination: LocalId
      readonly buffer: LocalId
      readonly offset: LocalId
      readonly length: LocalId
      readonly value: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      /** The null `*mut T` address. */
      readonly _tag: 'PointerNull'
      readonly destination: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Pointer' }>
      readonly provenance: Provenance
    }
  | {
      /** Tests one pointer lane against null into a `bool` destination. */
      readonly _tag: 'PointerIsNull'
      readonly destination: LocalId
      readonly pointer: LocalId
      readonly provenance: Provenance
    }
  | {
      /** Observes a raw data address as unsigned target-width `usize` without accessing storage. */
      readonly _tag: 'PointerAddress'
      readonly destination: LocalId
      readonly pointer: LocalId
      readonly provenance: Provenance
    }
  | {
      /**
       * Forms a pointer from the address lane of a reference or slice local. Formation is an
       * ordinary read of the borrow: the result holds no loan and keeps nothing alive.
       */
      readonly _tag: 'PointerFromStorage'
      readonly destination: LocalId
      readonly source: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Pointer' }>
      readonly provenance: Provenance
    }
  | {
      /**
       * Reinterprets an unchanged raw address with a different pointee under an unsafe
       * caller proof of alignment, initialization and lifetime. It holds no loan.
       */
      readonly _tag: 'PointerReinterpret'
      readonly destination: LocalId
      readonly source: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Pointer' }>
      readonly provenance: Provenance
    }
  | {
      /**
       * Forms a pointer from the address lane of a reference or slice local. Formation is an
       * ordinary read of the borrow: the result holds no loan and keeps nothing alive.
       */
      readonly _tag: 'PointerRequalify'
      readonly destination: LocalId
      readonly source: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Pointer' }>
      readonly provenance: Provenance
    }
  | {
      /** Projects the same address as readonly bytes without loading or claiming an extent. */
      readonly _tag: 'PointerBytes'
      readonly destination: LocalId
      readonly source: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Pointer' }>
      readonly provenance: Provenance
    }
  | {
      /** Advances a pointer by `count` elements of the pointee; validity is the caller's obligation. */
      readonly _tag: 'PointerAt'
      readonly destination: LocalId
      readonly pointer: LocalId
      readonly count: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Pointer' }>
      readonly provenance: Provenance
    }
  | {
      /** Copies the Copy pointee out of the addressed storage. */
      readonly _tag: 'PointerRead'
      readonly destination: LocalId
      readonly pointer: LocalId
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      /** Stores one Copy value through a `*mut` pointer into a unit destination. */
      readonly _tag: 'PointerWrite'
      readonly destination: LocalId
      readonly pointer: LocalId
      readonly value: LocalId
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'SlotWrite'
      readonly destination: LocalId
      readonly slot: LocalId
      readonly value: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'SlotTake'
      readonly destination: LocalId
      readonly slot: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      /** Non-consuming read of an initialized slot; verified for Copy element types only. */
      readonly _tag: 'SlotCopy'
      readonly destination: LocalId
      readonly slot: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'SlotDrop'
      readonly destination: LocalId
      readonly slot: LocalId
      readonly element: DeclarationFacts.SemanticType
      readonly cleanup: CleanupPlan.CleanupPlan
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'Move'
      readonly destination: LocalId
      readonly source: LocalId
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'BeginLoan'
      readonly borrow: Tir.BorrowId
      readonly destination: LocalId
      readonly root: LocalId
      readonly selectors: ReadonlyArray<PlaceSelector>
      readonly sourceType: Type
      readonly type: Extract<Type, { readonly _tag: 'Slice' | 'Reference' }>
      readonly access: SilkType.BorrowAccess
      readonly reborrow: boolean
      readonly suspendsParent: boolean
      readonly provenance: Provenance
    }
  | EndLoanOperation
  | {
      readonly _tag: 'SliceLength'
      readonly destination: LocalId
      readonly slice: LocalId
      readonly type: Extract<Type, { readonly _tag: 'usize' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ConvertUnion'
      readonly destination: LocalId
      readonly source: LocalId
      readonly sourceType: Exclude<Type, { readonly _tag: 'EffectOutcome' }>
      /** Instantiated source proof, including executable identity, before layout erasure. */
      readonly sourceSemantic: SilkType.Type
      readonly targetType: Extract<Type, { readonly _tag: 'Union' }>
      readonly conversion: 'Inject' | 'Widen'
      readonly mappings: ReadonlyArray<TypeCompatibility.MemberMapping>
      readonly sourceShape: Layout.CallingShape
      readonly targetShape: Layout.CallingShape
      readonly access: 'Copy' | 'Owned'
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'Call'
      readonly invocationUse?: InvocationUse
      readonly destination: LocalId
      readonly target: DeclarationFacts.CanonicalId
      readonly typeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly staticArguments?: ReadonlyArray<StaticValue.Value>
      readonly arguments: ReadonlyArray<LocalId>
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'MakeEffect'
      /** Exact call replaced by constructor folding; its invocation proof remains source-owned. */
      readonly invocationSource?: Extract<Operation, { readonly _tag: 'Call' | 'ApplyCallable' }>
      readonly destination: LocalId
      readonly runner: DeclarationFacts.CanonicalId
      readonly runnerTypeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly captures: ReadonlyArray<{
        readonly source: LocalId
        readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
      }>
      readonly type: Extract<Type, { readonly _tag: 'EffectValue' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'MakeCallable'
      readonly destination: LocalId
      readonly target: Tir.CallableTarget
      readonly typeArguments: ReadonlyArray<SilkType.GenericArgument>
      /**
       * A callable value of the same target whose environment fields are spliced ahead of
       * `captures`; a staged section over a callable value (CALLABLE-002).
       */
      readonly base?: LocalId
      readonly captures: ReadonlyArray<{
        readonly ordinal: number
        readonly parameterOrdinal: number
        readonly source: LocalId
        readonly sourceOrigin?: AuthoredIdentity.Anchor
        readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
      }>
      readonly type: Extract<Type, { readonly _tag: 'CallableValue' }>
      readonly provenance: Provenance
    }
  | {
      /** Projects inert capture lanes; only the matching branch may consume the selected value. */
      readonly _tag: 'UnpackEffectComposite'
      readonly destination: LocalId
      readonly matched: LocalId
      readonly source: LocalId
      readonly alternative: number
      readonly type: Extract<Type, { readonly _tag: 'EffectValue' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'PackEffectComposite'
      readonly destination: LocalId
      readonly source: LocalId
      readonly alternative: number
      readonly type: Extract<Type, { readonly _tag: 'EffectComposite' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ApplyCallable'
      readonly invocationUse?: InvocationUse
      readonly destination: LocalId
      readonly callable?: LocalId
      readonly target?: Tir.CallableTarget
      readonly typeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly captures: ReadonlyArray<{
        readonly ordinal: number
        readonly parameterOrdinal: number
        readonly source: LocalId
        readonly sourceOrigin?: AuthoredIdentity.Anchor
        readonly access: 'Copy' | 'Shared' | 'Exclusive' | 'Take'
      }>
      readonly arguments: ReadonlyArray<LocalId>
      readonly callableType: SilkType.Callable
      readonly access: SilkType.CallableMode
      readonly evaluation: 'CalleeThenArguments' | 'LeftThenCallable'
      readonly realization: 'Environment' | 'DirectErasedSection'
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'PackEffectOutcome'
      readonly destination: LocalId
      readonly source: LocalId
      readonly tag: number
      readonly type: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly provenance: Provenance
    }
  | {
      /** Dynamically packs one member of an ordinary failure union into the Effect E channel. */
      readonly _tag: 'PackEffectFailureUnion'
      readonly destination: LocalId
      readonly source: LocalId
      readonly sourceType: Extract<Type, { readonly _tag: 'Union' }>
      readonly mappings: ReadonlyArray<{ readonly source: number; readonly target: number }>
      readonly type: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly provenance: Provenance
    }
  | {
      /** Propagates one already-materialized failure through the enclosing Effect runner. */
      readonly _tag: 'PropagateEffectFailure'
      readonly source: LocalId
      /** Original caught outcome owns diagnostics separately from the selected payload. */
      readonly outcome: LocalId
      readonly sourceType: Type
      readonly propagationType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly tagMappings: ReadonlyArray<{
        readonly source: number
        readonly target: number
      }>
      readonly propagationLaneCount: number
      /** Owners still live at this site, released before the failure outcome propagates. */
      readonly releases?: ReadonlyArray<DropOperation>
      readonly type: Extract<Type, { readonly _tag: 'Bottom' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'UnpackEffectSuccess'
      readonly destination: LocalId
      readonly source: LocalId
      readonly type: Exclude<Type, { readonly _tag: 'EffectOutcome' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'RunEffect'
      readonly destination: LocalId
      readonly outcome: LocalId
      readonly target: DeclarationFacts.CanonicalId
      readonly typeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly staticArguments?: ReadonlyArray<StaticValue.Value>
      readonly arguments: ReadonlyArray<LocalId>
      readonly outcomeType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly propagationType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly tagMappings: ReadonlyArray<{
        readonly source: number
        readonly target: number
      }>
      /** Caller-owned loans ended only when this run propagates a typed failure. */
      readonly failureLoanEnds?: ReadonlyArray<EndLoanOperation>
      /** Owners still live at this site, released before a failure outcome propagates. */
      readonly releases?: ReadonlyArray<DropOperation>
      readonly propagationLaneCount: number
      readonly type: Exclude<Type, { readonly _tag: 'EffectOutcome' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'RunEffectValue'
      readonly destination: LocalId
      readonly outcome: LocalId
      readonly effect: LocalId
      readonly runner: DeclarationFacts.CanonicalId
      readonly runnerTypeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly runnerStaticArguments?: ReadonlyArray<StaticValue.Value>
      /** Exact unsupplied runner retained when `runner` is a statically provided specialization. */
      readonly runnerBase?: {
        readonly declaration: DeclarationFacts.CanonicalId
        readonly typeArguments: ReadonlyArray<SilkType.GenericArgument>
        readonly staticArguments?: ReadonlyArray<StaticValue.Value>
      }
      /** Ordered compile-time provider selections proving the exact requirement row. */
      readonly providers: ReadonlyArray<{
        readonly capability: SilkType.Nominal
        readonly providerType: SilkType.Nominal
        readonly witness: DeclarationFacts.ConformanceWitness
        readonly role: string
        readonly requirementAccess: SilkType.Requirement['access']
        readonly access: 'Shared' | 'Exclusive' | 'Take'
        readonly argument?: LocalId
      }>
      /** Statically selected service-provider references appended after the Effect captures. */
      readonly arguments: ReadonlyArray<LocalId>
      /** Armed exact-once release retained only while this protected run can be cancelled. */
      readonly cancellationFinalizer?: CancellationFinalizer
      readonly outcomeType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly propagationType?: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly tagMappings: ReadonlyArray<{
        readonly source: number
        readonly target: number
      }>
      readonly propagationLaneCount: number
      /** Caller-owned loans ended only when this run propagates or traps on a typed failure. */
      readonly failureLoanEnds?: ReadonlyArray<EndLoanOperation>
      /** Owners still live at this site, released before a failure outcome propagates. */
      readonly releases?: ReadonlyArray<DropOperation>
      readonly type: Exclude<Type, { readonly _tag: 'EffectOutcome' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'RunEffectComposite'
      readonly destination: LocalId
      readonly outcome: LocalId
      readonly effect: LocalId
      readonly alternatives: ReadonlyArray<{
        readonly type: Extract<Type, { readonly _tag: 'EffectValue' }>
        readonly runner: DeclarationFacts.CanonicalId
        readonly runnerTypeArguments: ReadonlyArray<SilkType.GenericArgument>
        readonly runnerStaticArguments?: ReadonlyArray<StaticValue.Value>
        readonly tagMappings: ReadonlyArray<{ readonly source: number; readonly target: number }>
        readonly arguments: ReadonlyArray<LocalId>
      }>
      readonly arguments: ReadonlyArray<LocalId>
      readonly outcomeType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly propagationType?: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly tagMappings: ReadonlyArray<{ readonly source: number; readonly target: number }>
      readonly propagationLaneCount: number
      readonly failureLoanEnds?: ReadonlyArray<EndLoanOperation>
      readonly releases?: ReadonlyArray<DropOperation>
      readonly type: Exclude<Type, { readonly _tag: 'EffectOutcome' }>
      readonly provenance: Provenance
    }
  | {
      /** Runs a statically selected Effect directly from its proven local capture values. */
      readonly _tag: 'RunStaticEffect'
      readonly destination: LocalId
      readonly outcome: LocalId
      readonly runner: DeclarationFacts.CanonicalId
      readonly runnerTypeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly runnerStaticArguments?: ReadonlyArray<StaticValue.Value>
      readonly captures: ReadonlyArray<{
        readonly source: LocalId
        readonly access: 'Copy' | 'Shared'
      }>
      readonly arguments: ReadonlyArray<LocalId>
      readonly outcomeType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly propagationType?: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly tagMappings: ReadonlyArray<{ readonly source: number; readonly target: number }>
      readonly propagationLaneCount: number
      /** Caller-owned loans ended only when this run propagates or traps on a typed failure. */
      readonly failureLoanEnds?: ReadonlyArray<EndLoanOperation>
      readonly releases?: ReadonlyArray<DropOperation>
      readonly type: Exclude<Type, { readonly _tag: 'EffectOutcome' }>
      readonly provenance: Provenance
    }
  | {
      /** Runs the protected Effect and exposes its channels only to the enclosing catch lowering. */
      readonly _tag: 'CatchEffect'
      readonly destination: LocalId
      readonly outcome: LocalId
      readonly successValue: LocalId
      readonly failureValue: LocalId
      readonly effect: LocalId
      readonly runner: DeclarationFacts.CanonicalId
      readonly runnerTypeArguments: ReadonlyArray<SilkType.GenericArgument>
      readonly runnerStaticArguments?: ReadonlyArray<StaticValue.Value>
      readonly arguments: ReadonlyArray<LocalId>
      /** Armed exact-once release retained only while this protected run can be cancelled. */
      readonly cancellationFinalizer?: CancellationFinalizer
      readonly outcomeType: Extract<Type, { readonly _tag: 'EffectOutcome' }>
      readonly failureValueType: SilkType.Type
      readonly successShape: Layout.CallingShape
      readonly outcomeShape: Layout.CallingShape
      readonly failureValueShape: Layout.CallingShape
      readonly type: Extract<Type, { readonly _tag: 'bool' }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'Construct'
      readonly destination: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly fields: ReadonlyArray<{
        readonly field: DeclarationFacts.FieldId
        readonly value: LocalId
        readonly stored?:
          | Extract<Type, { readonly _tag: 'CallableValue' }>['storage']
          | Extract<Type, { readonly _tag: 'EffectValue' }>['storage']
      }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ConstructUnionVariant'
      readonly destination: LocalId
      readonly type: Extract<Type, { readonly _tag: 'Nominal' }>
      readonly variant: DeclarationFacts.CanonicalUnionVariantId
      readonly variantOrdinal: number
      readonly fields: ReadonlyArray<{
        readonly field: DeclarationFacts.FieldId
        readonly value: LocalId
        readonly stored?:
          | Extract<Type, { readonly _tag: 'CallableValue' }>['storage']
          | Extract<Type, { readonly _tag: 'EffectValue' }>['storage']
      }>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ConstructArray'
      readonly destination: LocalId
      readonly type: Extract<Type, { readonly _tag: 'FixedArray' }>
      readonly elements: ReadonlyArray<LocalId>
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'Project'
      readonly destination: LocalId
      readonly source: LocalId
      readonly field: DeclarationFacts.FieldId
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'ReadPlace'
      readonly destination: LocalId
      readonly root: LocalId
      readonly selectors: ReadonlyArray<PlaceSelector>
      readonly type: Type
      /** Set when a paired same-place write licenses reading a non-Copy value out. */
      readonly consume?: boolean
      /** Exact canonical path for an owned extraction, distinct from paired borrowed replacement. */
      readonly ownershipPath?: MovePath.Path
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'CheckPlace'
      readonly root: LocalId
      readonly selectors: ReadonlyArray<PlaceSelector>
      readonly type: Type
      readonly provenance: Provenance
    }
  | {
      readonly _tag: 'WritePlace'
      readonly root: LocalId
      readonly selectors: ReadonlyArray<PlaceSelector>
      readonly source: LocalId
      readonly rootType: Type
      readonly type: Type
      readonly mutable: true
      readonly replacement: 'Copy' | 'Owned'
      readonly commit: 'AfterCleanup'
      readonly provenance: Provenance
    }
  | DropOperation
  | MatchOperation
  | ConditionalOperation
  | DiagnosticScopeOperation
  | {
      readonly _tag: 'DiagnosticUnhandled'
      readonly destination: LocalId
      readonly type: Extract<Type, { readonly _tag: 'usize' }>
      readonly provenance: Provenance
    }
  | ShortCircuitOperation

/** One owned lexical observer around execution of its protected infallible Effect. */
export interface DiagnosticScopeOperation {
  readonly _tag: 'DiagnosticScope'
  readonly destination: LocalId
  readonly state: LocalId
  readonly observer: LocalId
  readonly body: Execution
  readonly stateCleanup: CleanupPlan.CleanupPlan
  readonly observerCleanup: CleanupPlan.CleanupPlan
  readonly type: Exclude<Type, { readonly _tag: 'EffectOutcome' }>
  readonly resultShape: Layout.CallingShape
  readonly provenance: Provenance
}

/** One compiler-owned structured conditional whose branches may produce any value type. */
export interface ConditionalOperation {
  readonly _tag: 'Conditional'
  readonly destination: LocalId
  readonly condition: LocalId
  readonly taken: Execution
  readonly otherwise: Execution
  readonly type: Exclude<Type, { readonly _tag: 'EffectOutcome' }>
  readonly resultShape: Layout.CallingShape
  readonly provenance: Provenance
}

/**
 * One compiler-owned conditional evaluation: `&&` and `||`. `left` is already evaluated when the
 * operation runs; `right` holds the operations that evaluate the right operand and the local
 * carrying its value. `&&` evaluates `right` only when `left` is true and otherwise yields false;
 * `||` evaluates `right` only when `left` is false and otherwise yields true. The right operand
 * is pure by elaboration, so skipping it performs and releases nothing.
 */
export interface ShortCircuitOperation {
  readonly _tag: 'ShortCircuit'
  readonly operator: 'And' | 'Or'
  readonly destination: LocalId
  readonly left: LocalId
  readonly right: Execution
  readonly type: Extract<Type, { readonly _tag: 'bool' }>
  readonly provenance: Provenance
}

/** Releases one owned local through its cleanup plan. */
export interface DropOperation {
  readonly _tag: 'Drop'
  readonly local: LocalId
  /** Optional owned destination projection; cleanup observes only its initialized remainder. */
  readonly selectors?: ReadonlyArray<PlaceSelector>
  readonly cleanup: CleanupPlan.CleanupPlan
  readonly initialization?: {
    readonly state: MovePath.State
    readonly flags: ReadonlyArray<{ readonly path: MovePath.Path; readonly local: LocalId }>
  }
  /** Exact target plan for an opaque local-shared core drop. Absent for every other cleanup. */
  readonly localShared?: {
    readonly element: SilkType.Type
    readonly block: LocalSharedControlBlock.Plan
  }
  readonly provenance: Provenance
}

/** Ends one caller-owned loan on the dynamic path that contains this operation. */
export interface EndLoanOperation {
  readonly _tag: 'EndLoan'
  readonly borrow: Tir.BorrowId
  readonly slice: LocalId
  readonly provenance: Provenance
}

export interface MatchBinding {
  readonly id: Tir.LocalId
  readonly destination: LocalId
  readonly path: ReadonlyArray<DeclarationFacts.FieldId>
  readonly type: Type
  readonly access: Match.Access
  readonly provenance: Provenance
}

/** A nested acyclic region graph with a value only on its normal completion paths. */
export interface Execution {
  readonly entry: RegionId
  readonly regions: ReadonlyArray<Region>
  readonly result?: LocalId
  /** Failure whose selected handler is being applied and executed in this region graph. */
  readonly recoveryOutcome?: LocalId
  /** Checked primitive recipe before a concrete offered handler's designation is opened. */
  readonly recoveryInvocation?: Tir.RecoveryInvocationRecipe
}

export interface MatchArm {
  readonly tests?: ReadonlyArray<
    Match.PatternTest & {
      readonly shape: Layout.CallingShape
      readonly selectors: ReadonlyArray<PlaceSelector>
    }
  >
  readonly id: Match.ArmId
  readonly member?: Match.CoverageIdentity
  readonly universal: boolean
  readonly before: ReadonlyArray<Match.CoverageIdentity>
  readonly after: ReadonlyArray<Match.CoverageIdentity>
  readonly bindings: ReadonlyArray<MatchBinding>
  readonly cleanupBindings: ReadonlyArray<{
    readonly destination: LocalId
    readonly path: ReadonlyArray<DeclarationFacts.FieldId>
    readonly type: Type
  }>
  readonly guard?: { readonly execution: Execution }
  readonly selected: {
    readonly access: Match.Access
    readonly execution: Execution
    readonly cleanup: ReadonlyArray<{
      readonly destination: LocalId
      readonly path: ReadonlyArray<DeclarationFacts.FieldId>
      readonly cleanup: CleanupPlan.CleanupPlan
    }>
    readonly endBorrow: boolean
  }
  readonly provenance: Provenance
}

/** One compiler-owned structured selection. Child operations form an acyclic expression DAG. */
export interface MatchOperation {
  readonly _tag: 'Match'
  readonly id: Match.MatchId
  readonly destination?: LocalId
  readonly scrutinee: LocalId
  /** Discriminant-only selection addresses this owned subtree without copying its payload. */
  readonly selectors?: ReadonlyArray<PlaceSelector>
  readonly scrutineeType: Type
  readonly scrutineeShape: Layout.CallingShape
  readonly access: Match.Access
  /** Statement patterns retain selected locals beyond this operation; expression matches do not. */
  readonly retainsBindings: boolean
  readonly members: ReadonlyArray<Match.CoverageIdentity>
  readonly decisions: ReadonlyArray<{
    readonly member: Match.CoverageIdentity
    readonly candidates: ReadonlyArray<Match.ArmId>
  }>
  readonly arms: ReadonlyArray<MatchArm>
  readonly type: Type
  readonly resultShape: Layout.CallingShape
  readonly provenance: Provenance
}

export type Outcome =
  | { readonly _tag: 'Complete'; readonly provenance: Provenance }
  | { readonly _tag: 'Forward'; readonly target: RegionId; readonly provenance: Provenance }
  | { readonly _tag: 'Return'; readonly value: LocalId; readonly provenance: Provenance }
  | { readonly _tag: 'Trap'; readonly reason: string; readonly provenance: Provenance }
  | { readonly _tag: 'Repeat'; readonly loop: LoopId; readonly provenance: Provenance }
  | { readonly _tag: 'Exit'; readonly loop: LoopId; readonly provenance: Provenance }
  | { readonly _tag: 'Yield'; readonly provenance: Provenance }

interface RegionBase {
  readonly id: RegionId
  readonly ownerLoop?: LoopId
}

export interface OperationRegion extends RegionBase {
  readonly _tag: 'OperationRegion'
  readonly operations: ReadonlyArray<Operation>
  readonly outcome: Outcome
}

export interface CleanupRegion extends RegionBase {
  readonly _tag: 'CleanupRegion'
  readonly releases: ReadonlyArray<Extract<Operation, { readonly _tag: 'Drop' | 'EndLoan' }>>
  readonly outcome: Outcome
}

export interface ConditionalRegion extends RegionBase {
  readonly _tag: 'ConditionalRegion'
  readonly condition: LocalId
  readonly taken: RegionId
  readonly otherwise: RegionId
  readonly following?: RegionId
  readonly provenance: Provenance
}

export interface LoopRegion extends RegionBase {
  readonly _tag: 'LoopRegion'
  readonly loop: LoopId
  readonly parent?: LoopId
  readonly condition: RegionId
  readonly conditionValue: LocalId
  readonly body: RegionId
  readonly following: RegionId
  readonly provenance: Provenance
}

export type Region = OperationRegion | CleanupRegion | ConditionalRegion | LoopRegion

export type {
  SuspensionBorrowIdentity,
  SuspensionClassification,
  SuspensionCompletion,
  SuspensionControlEdge,
  SuspensionPointId,
  SuspensionProviderArgument,
  SuspensionRegion,
  SuspensionRunner,
}

export interface ResumePointId {
  readonly _tag: 'ResumePointId'
  readonly point: SuspensionPointId
  readonly path: 'Success' | 'Failure'
}

export type CoroutineFrameAccess =
  | { readonly _tag: 'Copy' }
  | {
      readonly _tag: 'BorrowedDependency'
      readonly access: 'Shared' | 'Exclusive'
      readonly root: LocalId
      readonly loan: SuspensionBorrowIdentity
    }
  | { readonly _tag: 'AffineTransfer'; readonly cleanup: CleanupPlan.CleanupPlan }

export interface CoroutineFrameSlot {
  readonly ordinal: number
  readonly local: LocalId
  readonly type: Type
  readonly access: CoroutineFrameAccess
  readonly initialization?: DropOperation['initialization']
}

export interface CoroutineFrameRelease {
  readonly local: LocalId
  readonly cleanup: CleanupPlan.CleanupPlan
  readonly initialization?: DropOperation['initialization']
}

export interface CoroutineFramePathPlan {
  readonly restores: ReadonlyArray<number>
  readonly loanEnds: ReadonlyArray<SuspensionBorrowIdentity>
  readonly releases: ReadonlyArray<CoroutineFrameRelease>
}

export interface CoroutineFrameState {
  readonly _tag: 'CoroutineFrameState'
  readonly point: SuspensionPointId
  readonly runner: SuspensionRunner
  readonly outcome: SilkType.Effect
  readonly slots: ReadonlyArray<CoroutineFrameSlot>
  readonly invocationUses?: ReadonlyArray<InvocationUseRetention>
  /** Present exactly when cancellation must run an armed nonparking finalizer before cleanup. */
  readonly cancellationFinalizer?: CancellationFinalizer
  readonly success: CoroutineFramePathPlan & { readonly resume: ResumePointId }
  readonly failure: CoroutineFramePathPlan & { readonly resume: ResumePointId }
}

/** One reusable logical frame owned by one specialized suspendable invocation. */
export interface CoroutineFrameDescriptor {
  readonly _tag: 'CoroutineFrameDescriptor'
  readonly function: Instances.InstanceKey
  readonly states: ReadonlyArray<CoroutineFrameState>
}

export type CoroutineFrameHeaderRole =
  | 'Parent'
  | 'State'
  | 'Observer'
  | 'IncomingCauseObserver'
  | 'IncomingCauseHandle'
  | 'IncomingCauseIdentity'
  | 'IncomingCauseIdentityLength'
  | 'IncomingCauseOrigin'
  | 'IncomingCauseOriginLength'
  | 'CurrentCauseObserver'
  | 'CurrentCauseHandle'
  | 'CurrentCauseIdentity'
  | 'CurrentCauseIdentityLength'
  | 'CurrentCauseOrigin'
  | 'CurrentCauseOriginLength'

export interface CoroutineFrameHeaderField {
  readonly _tag: 'CoroutineFrameHeaderField'
  readonly role: CoroutineFrameHeaderRole
  readonly offset: number
  readonly size: number
  readonly alignment: number
}

export interface CoroutineFramePayloadField {
  readonly _tag: 'CoroutineFramePayloadField'
  readonly slot: number
  readonly local: LocalId
  readonly type: Type
  readonly access: CoroutineFrameAccess
  readonly initialization?: DropOperation['initialization']
  readonly offset: number
  readonly size: number
  readonly alignment: number
  readonly padding: number
}

export interface CoroutineFrameTargetStateLayout {
  readonly _tag: 'CoroutineFrameTargetStateLayout'
  readonly point: SuspensionPointId
  readonly size: number
  readonly alignment: number
  readonly payload: ReadonlyArray<CoroutineFramePayloadField>
  readonly tailPadding: number
}

/** One maximum physical frame plan shared by every mutually-exclusive state of an invocation. */
export interface CoroutineFrameTargetLayout {
  readonly _tag: 'CoroutineFrameTargetLayout'
  readonly function: Instances.InstanceKey
  readonly size: number
  readonly alignment: number
  readonly header: ReadonlyArray<CoroutineFrameHeaderField>
  readonly states: ReadonlyArray<CoroutineFrameTargetStateLayout>
  /** Non-owning descriptors kept outside mutually exclusive retained payloads. */
  readonly diagnosticScopes: ReadonlyArray<{
    readonly scope: LocalId
    readonly offset: number
  }>
  /** Owned metadata has independent storage after the non-owning scope descriptors. */
  readonly diagnosticOutcomes: ReadonlyArray<{
    readonly outcome: LocalId
    readonly offset: number
  }>
}

export interface CoroutineFramePlan {
  readonly _tag: 'CoroutineFramePlan'
  readonly target: Layout.Plan['target']
  readonly entries: ReadonlyArray<CoroutineFrameTargetLayout>
}

export type SuspendEffectRegion = Extract<
  SuspensionRegion,
  { readonly _tag: 'SuspendEffectRegion' }
>

export type RunSuspendableEffectRegion = Extract<
  SuspensionRegion,
  { readonly _tag: 'RunSuspendableEffectRegion' }
>

/** A selected call-edge view, authenticated against the separate held source catalog. */
export interface ExecutableInputView {
  readonly owner: Instances.InstanceKey
  readonly callNode: Tir.NodeId
  readonly view: Tir.ExecutableInputView
}

/** Original source and selected instance records, retained independently of physical descriptors. */
export interface ExecutableInputViewSource {
  readonly caller: Instances.Instance
  readonly callee: Instances.Instance
  readonly call: Instances.CallInstance
  readonly original: Tir.ExecutableInputView
  readonly selected: Tir.ExecutableInputView
}

export interface MirFunction {
  /** Original source lifetime owner, preserved for generated runners and callable bodies. */
  readonly sourceOwner?: Lifetime.Owner
  /** The original source callable role; generated Effect runners never acquire this role. */
  readonly sourceInvocationUse?: SilkType.InvocationUse
  /** Checked authored inputs mapped to their actual physical header slots. */
  readonly sourceParameters?: ReadonlyArray<{
    readonly local: LocalId
    readonly parameter: number
    readonly source: AuthoredIdentity.Anchor
    /** Authored promise before selection of the concrete hidden representation. */
    readonly contract: SilkType.Type
    /** Complete selected semantic header, including the actual callable schema. */
    readonly type: SilkType.Type
  }>
  readonly machine?: MachineFunction.MachineFunction
  readonly initializationFlags?: ReadonlyArray<{
    readonly root: LocalId
    readonly flags: NonNullable<DropOperation['initialization']>['flags']
  }>
  readonly _tag: 'MirFunction'
  readonly id: DeclarationFacts.CanonicalId
  readonly instance: Instances.InstanceKey
  readonly parameterCount: number
  readonly localTypes: ReadonlyArray<Type>
  readonly result: Type
  readonly entry: RegionId
  readonly regions: ReadonlyArray<Region>
  /** Static origin of a generated Effect runner, including every selected provider witness. */
  readonly effectRunner?: {
    readonly base: {
      readonly declaration: DeclarationFacts.CanonicalId
      readonly typeArguments: ReadonlyArray<SilkType.GenericArgument>
    }
    readonly providers: ReadonlyArray<{
      readonly capability: SilkType.Nominal
      readonly providerType: SilkType.Nominal
      readonly witness: DeclarationFacts.ConformanceWitness
      readonly role: string
      readonly requirementAccess: SilkType.Requirement['access']
      readonly access: 'Shared' | 'Exclusive' | 'Take'
    }>
  }
  readonly suspension?: {
    readonly classification: SuspensionClassification
    readonly regions: ReadonlyArray<SuspensionRegion>
    readonly frame?: CoroutineFrameDescriptor
  }
}

export interface Module {
  /** Held checked call graph for semantic views whose physical layout is shared. */
  readonly executableInputViews?: ReadonlyArray<ExecutableInputViewSource>
  /** Source component selected only for reachable private frame storage. */
  readonly executionStorage?: ExecutionStorageComponent.ExecutionStorageComponent
  /** Explicit artifact roots preserved through optimization without creating foreign exports. */
  readonly retainedRoots?: ReadonlyArray<Instances.InstanceKey>
  readonly _tag: 'MirModule'
  readonly module: string
  readonly intrinsics: ReadonlyArray<Instances.IntrinsicCall>
  /** Reachable foreign declarations copied from discovery; every availability site reads it. */
  readonly foreignCalls: ReadonlyArray<Instances.ForeignCall>
  /** Native export roots with the C signature each thunk publishes. */
  readonly foreignExports: ReadonlyArray<Instances.ForeignExport>
  /** Resolved C data declarations retained for native import/export emission. */
  readonly foreignStatics: ReadonlyArray<{
    readonly declaration: DeclarationFacts.CanonicalId
    readonly declarationSpan: SourceSpan.SourceSpan
    readonly direction: 'Import' | 'Export'
    readonly symbol: string
    readonly type: SilkType.Type
    readonly literal?: DeclarationFacts.ConstantLiteralFact
  }>
  readonly layout: Layout.Plan
  readonly staticData?: ReadonlyArray<StaticText.Data>
  readonly functions: ReadonlyArray<MirFunction>
  /** Complete logical lifecycle authority verified before backend lowering. */
  readonly executionTransitions: ReadonlyArray<ExecutionTransition.Authority>
  readonly normalization?: ReadonlyArray<NormalizationVerdict>
  readonly coroutineFrames?: CoroutineFramePlan
}

/**
 * Orders one callable application's operands by parameter: each capture sits at its parameter
 * ordinal and the supplied arguments fill the remaining ordinals in order, so a trailing section
 * and a bound method value (parameter zero captured) apply through one rule.
 */
export const applyOperands = <T>(
  captures: ReadonlyArray<{ readonly parameterOrdinal: number; readonly items: ReadonlyArray<T> }>,
  arguments_: ReadonlyArray<ReadonlyArray<T>>,
): ReadonlyArray<T> => {
  const slots = new Map<number, ReadonlyArray<T>>()
  for (const capture of captures) slots.set(capture.parameterOrdinal, capture.items)
  let ordinal = 0
  for (const argument of arguments_) {
    while (slots.has(ordinal)) ordinal += 1
    slots.set(ordinal, argument)
    ordinal += 1
  }
  return [...slots.entries()]
    .sort(([left], [right]) => left - right)
    .flatMap(([, items]) => [...items])
}

/**
 * Checks an operand at an already selected emitted-function boundary. Source lifetime proofs were
 * checked before lowering; one emitted instance can serve calls from different lifetime domains.
 * Access and callable mode adaptations still use the ordinary compatibility relation.
 */
export const acceptsRuntimeOperand = (actual: SilkType.Type, expected: SilkType.Type): boolean =>
  SilkType.runtimeKey(actual) === SilkType.runtimeKey(expected) ||
  TypeCompatibility.isCompatible(TypeCompatibility.check(actual, expected)) ||
  (SilkType.isReference(actual) &&
    SilkType.isReference(expected) &&
    expected.access === 'Shared' &&
    actual.access === 'Exclusive' &&
    SilkType.runtimeKey(actual.target) === SilkType.runtimeKey(expected.target)) ||
  (SilkType.isSlice(actual) &&
    SilkType.isSlice(expected) &&
    expected.access === 'Shared' &&
    actual.access === 'Exclusive' &&
    SilkType.runtimeKey(actual.element) === SilkType.runtimeKey(expected.element)) ||
  (SilkType.isEffect(actual) &&
    SilkType.isEffect(expected) &&
    SilkType.compareAccess(expected.access, actual.access) &&
    SilkType.runtimeKey({ ...actual, access: expected.access }) ===
      SilkType.runtimeKey(expected)) ||
  // A selected function item retains its declaration schema for specialization. A plain callback
  // parameter carries only the applied signature; its checked schema is not a runtime operand.
  (SilkType.isCallable(actual) &&
    SilkType.isCallable(expected) &&
    expected.schema === undefined &&
    (!actual.unsafe || expected.unsafe) &&
    SilkType.compareAccess(expected.mode, actual.mode) &&
    actual.parameters.length === expected.parameters.length &&
    actual.parameters.every((parameter, ordinal) => {
      const compared = expected.parameters.at(ordinal)
      return compared !== undefined && acceptsRuntimeOperand(compared, parameter)
    }) &&
    acceptsRuntimeOperand(actual.result, expected.result))

/** Compares emitted generic arguments after erasing lifetime-only parameter positions. */
export const runtimeArgumentsEqual = (
  left: ReadonlyArray<SilkType.GenericArgument>,
  right: ReadonlyArray<SilkType.GenericArgument>,
): boolean => {
  const actual = SilkType.runtimeArgumentKeys(left)
  const expected = SilkType.runtimeArgumentKeys(right)
  return (
    actual.length === expected.length &&
    actual.every((key, ordinal) => key === expected.at(ordinal))
  )
}

/** Tests whether a MIR function realizes one concrete call target. */
export const matchesInstance = (
  fn: MirFunction,
  declaration: DeclarationFacts.CanonicalId,
  typeArguments: ReadonlyArray<SilkType.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value> = [],
): boolean =>
  fn.id.module === declaration.module &&
  fn.id.name === declaration.name &&
  runtimeArgumentsEqual(fn.instance.typeArguments, typeArguments) &&
  fn.instance.staticArguments.length === staticArguments.length &&
  fn.instance.staticArguments.every((argument, index) => {
    const expected = staticArguments.at(index)
    return expected !== undefined && StaticValue.key(argument) === StaticValue.key(expected)
  })

/**
 * Tests whether a returned value physically realizes its function's declared result.
 *
 * Unstored Effect values pinned to one site and environment instance name one machine, so only
 * their executable contract has to agree: run access and executable lifetime proofs are non-runtime
 * facts, and a realized `never` success widens into the declared success (EFF-007), while a
 * declared `never` success accepts only a realized `never`. Stored Effects and every other type
 * keep exact runtime identity.
 */
export const realizesReturn = (returned: Type, result: Type): boolean => {
  if (
    returned._tag !== 'EffectValue' ||
    result._tag !== 'EffectValue' ||
    returned.storage !== undefined ||
    result.storage !== undefined
  )
    return SilkType.runtimeKey(semanticType(returned)) === SilkType.runtimeKey(semanticType(result))
  const realized = SilkType.isNever(returned.type.success)
    ? { ...returned.type, success: result.type.success }
    : returned.type
  return (
    EffectExecutionContract.equals(realized, result.type) &&
    Tir.sameExecutableSite(returned.site, result.site) &&
    Instances.runtimeKeyText(returned.environment.instance) ===
      Instances.runtimeKeyText(result.environment.instance)
  )
}

/** Tests whether one concrete MIR function realizes a call's exact physical result contract. */
export const matchesCall = (
  fn: MirFunction,
  declaration: DeclarationFacts.CanonicalId,
  typeArguments: ReadonlyArray<SilkType.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value> | undefined,
  result: Type,
): boolean =>
  matchesInstance(fn, declaration, typeArguments, staticArguments) &&
  (result._tag === 'EffectValue' && fn.result._tag === 'EffectValue'
    ? // The site and environment instance below already pin one realization, so the contract only
      // has to confirm it: a fail-only block reaches its declared result type through `never`.
      EffectExecutionContract.realizes(result.type, fn.result.type) &&
      Tir.sameExecutableSite(result.site, fn.result.site) &&
      Instances.runtimeKeyText(result.environment.instance) ===
        Instances.runtimeKeyText(fn.result.environment.instance)
    : SilkType.runtimeKey(semanticType(result)) === SilkType.runtimeKey(semanticType(fn.result)))

/** Filters the concrete declaration before comparing its exact semantic Effect contract. */
export const matchesEffectInstance = (
  fn: MirFunction,
  declaration: DeclarationFacts.CanonicalId,
  typeArguments: ReadonlyArray<SilkType.GenericArgument>,
  staticArguments: ReadonlyArray<StaticValue.Value> | undefined,
  effect: SilkType.Effect,
  providers?: ReadonlyArray<EffectExecutionContract.RequirementAuthorization>,
): boolean =>
  fn.result._tag === 'EffectOutcome' &&
  matchesInstance(fn, declaration, typeArguments, staticArguments) &&
  EffectExecutionContract.matches(
    fn.result.type,
    effect,
    providers ?? fn.effectRunner?.providers ?? [],
  )

/** Tests exact concrete instance identity, including the resolved contract row. */
export const matchesInstanceKey = (fn: MirFunction, key: Instances.InstanceKey): boolean =>
  instanceText(fn.instance) === instanceText(key)

export const conformanceWitnessMatches = (
  left: DeclarationFacts.ConformanceWitness,
  right: DeclarationFacts.ConformanceWitness,
): boolean => {
  if (
    left._tag !== right._tag ||
    !SilkType.equals(left.capability, right.capability) ||
    !SilkType.equals(left.provider, right.provider)
  )
    return false
  if (left._tag !== 'SourceConformanceWitness') return true
  if (right._tag !== 'SourceConformanceWitness') return false
  return (
    left.module === right.module &&
    left.ordinal === right.ordinal &&
    left.typeArguments.length === right.typeArguments.length &&
    left.typeArguments.every((argument, ordinal) => {
      const expected = right.typeArguments.at(ordinal)
      return expected !== undefined && SilkType.equalsGenericArgument(argument, expected)
    }) &&
    left.operations.length === right.operations.length &&
    left.operations.every((operation, ordinal) => {
      const expected = right.operations.at(ordinal)
      return (
        expected !== undefined &&
        operation.name === expected.name &&
        operation.implementation.module === expected.implementation.module &&
        operation.implementation.name === expected.implementation.name
      )
    })
  )
}

export interface ControlEdge {
  readonly _tag: 'ControlEdge'
  readonly from: RegionId
  readonly to: RegionId
  readonly kind: 'Forward' | 'Taken' | 'Otherwise' | 'Following' | 'Condition' | 'Body'
}

/** Every local retained or referenced by finalized suspension control. */
export const suspensionLocals = (self: MirFunction): ReadonlyArray<LocalId> =>
  (self.suspension?.regions ?? []).flatMap((region) => {
    if (region._tag === 'SuspendEffectRegion')
      return [
        ...operationLocals(region.operation),
        ...region.deferred.providers.flatMap((provider) =>
          provider.argument === undefined ? [] : [provider.argument],
        ),
      ]
    const descriptor = region.relay.state
    return [
      ...operationLocals(region.operation),
      ...region.liveLocals,
      ...(descriptor?.slots.flatMap((slot) => [
        slot.local,
        ...(slot.access._tag === 'BorrowedDependency' ? [slot.access.root] : []),
      ]) ?? []),
      ...(descriptor?.failure.releases.map((release) => release.local) ?? []),
      ...region.runner.providers.flatMap((provider) =>
        provider.argument === undefined ? [] : [provider.argument],
      ),
    ]
  })

const outcomeTarget = (
  outcome: Outcome,
): ReadonlyArray<readonly [RegionId, ControlEdge['kind']]> =>
  outcome._tag === 'Forward' ? [[outcome.target, 'Forward']] : []

export const regionTargets = (
  region: Region,
): ReadonlyArray<readonly [RegionId, ControlEdge['kind']]> => {
  switch (region._tag) {
    case 'OperationRegion':
    case 'CleanupRegion':
      return outcomeTarget(region.outcome)
    case 'ConditionalRegion':
      return [
        [region.taken, 'Taken'],
        [region.otherwise, 'Otherwise'],
        ...(region.following === undefined ? [] : ([[region.following, 'Following']] as const)),
      ]
    case 'LoopRegion':
      return [
        [region.condition, 'Condition'],
        [region.body, 'Body'],
        [region.following, 'Following'],
      ]
  }
}

export const controlEdges = (self: MirFunction): ReadonlyArray<ControlEdge> =>
  self.regions.flatMap((region) =>
    regionTargets(region).map(([to, kind]) => ({
      _tag: 'ControlEdge' as const,
      from: region.id,
      to,
      kind,
    })),
  )

/** Canonical parent-before-child traversal over structural edges only. */
export const topologicalRegions = (
  self: Pick<MirFunction, 'entry' | 'regions'>,
): ReadonlyArray<Region> => {
  const byId = new Map(self.regions.map((region) => [region.id.ordinal, region] as const))
  const visited = new Set<number>()
  const ordered: Array<Region> = []
  // Explicit stack: a straight-line function is one region per statement, so region depth is
  // authored length and must not become JavaScript stack depth.
  const visit = (root: RegionId): void => {
    const pending: Array<Array<RegionId>> = [[root]]
    while (pending.length > 0) {
      const frame = pending.at(-1) ?? []
      const id = frame.shift()
      if (id === undefined) {
        pending.pop()
        continue
      }
      if (visited.has(id.ordinal)) continue
      visited.add(id.ordinal)
      const region = byId.get(id.ordinal)
      if (region === undefined) continue
      ordered.push(region)
      pending.push(regionTargets(region).map(([target]) => target))
    }
  }
  visit(self.entry)
  for (const region of [...self.regions].sort(
    (left, right) => left.id.ordinal - right.id.ordinal,
  )) {
    visit(region.id)
  }
  return ordered
}

export interface Violation {
  readonly _tag: 'Violation'
  readonly rule:
    | 'InvalidLayout'
    | 'InvalidInstance'
    | 'MissingTypeLayout'
    | 'MissingEntryRegion'
    | 'DuplicateRegionIdentity'
    | 'UnknownRegionTarget'
    | 'StructuralCycle'
    | 'InvalidLexicalOwner'
    | 'InvalidLoopTarget'
    | 'UndeclaredLocal'
    | 'InvalidReturn'
    | 'InvalidAggregateOperation'
    | 'InvalidIntegerOperation'
    | 'InvalidLayoutOperation'
    | 'InvalidAllocationOperation'
    | 'InvalidForeignCall'
    | 'InvalidForeignOperation'
    | 'InvalidNativeAssembly'
    | 'InvalidMachineFunction'
    | 'InvalidRawStorageOperation'
    | 'InvalidPointerOperation'
    | 'InvalidLocalSharedOperation'
    | 'InvalidExecutionOperation'
    | 'InvalidCallShape'
    | 'InvalidCallableOperation'
    | 'InvalidEffectOperation'
    | 'InvalidNormalization'
    | 'InvalidArtifactRoot'
    | 'InvalidInitializationState'
    | 'InvalidWrite'
    | 'InvalidLoan'
    | 'InvalidSliceOperation'
    | 'InvalidStringOperation'
    | 'InvalidEnumOperation'
    | 'InvalidMatchLayout'
    | 'InvalidMatchDecision'
    | 'InvalidMatchBinding'
    | 'InvalidMatchGuard'
    | 'InvalidMatchOwnership'
    | 'InvalidMatchJoin'
    | 'CyclicMatchOperation'
    | 'InvalidSuspension'
    | 'InvalidCoroutineFrame'
    | 'OrphanSuspensionMachinery'
  readonly function?: DeclarationFacts.CanonicalId
  readonly region?: RegionId
  /** The exact authored/generated operation that caused a local-shared rejection. */
  readonly provenance?: Provenance
  readonly localSharedReason?:
    | 'CleanupContract'
    | 'InitializationContract'
    | 'CloneContract'
    | 'AccessContract'
  readonly detail: string
}

export const operationsOf = (region: Region): ReadonlyArray<Operation> => {
  if (region._tag === 'OperationRegion') return region.operations
  if (region._tag === 'CleanupRegion') return region.releases
  return []
}

/** Structural operations inside one nested execution, preserving region order. */
export const executionOperations = (execution: Execution): ReadonlyArray<Operation> =>
  topologicalRegions(execution).flatMap(operationsOf)

/** Maps operation sequences while retaining the nested region and outcome graph. */
export const mapExecutionOperations = (
  execution: Execution,
  transform: (operations: ReadonlyArray<Operation>) => ReadonlyArray<Operation>,
): Execution => ({
  ...execution,
  regions: execution.regions.map((region): Region => {
    if (region._tag === 'OperationRegion')
      return { ...region, operations: transform(region.operations) }
    if (region._tag !== 'CleanupRegion') return region
    const releases = transform(region.releases)
    const cleanup = releases.filter(
      (operation): operation is Extract<Operation, { readonly _tag: 'Drop' | 'EndLoan' }> =>
        operation._tag === 'Drop' || operation._tag === 'EndLoan',
    )
    if (cleanup.length !== releases.length)
      throw new RangeError('Cleanup region transformation introduced a non-cleanup operation')
    return { ...region, releases: cleanup }
  }),
})

/** All nested region identities, without flattening the authored execution boundaries. */
export const regionsTree = (regions: ReadonlyArray<Region>): ReadonlyArray<Region> => {
  const found: Array<Region> = []
  const seen = new Set<Region>()
  const operation = (value: Operation): void => {
    if (value._tag === 'Match')
      for (const arm of value.arms) {
        if (arm.guard !== undefined) visit(topologicalRegions(arm.guard.execution))
        visit(topologicalRegions(arm.selected.execution))
      }
    else if (value._tag === 'DiagnosticScope') visit(topologicalRegions(value.body))
    else if (value._tag === 'ShortCircuit') visit(topologicalRegions(value.right))
    else if (value._tag === 'Conditional') {
      visit(topologicalRegions(value.taken))
      visit(topologicalRegions(value.otherwise))
    }
  }
  const visit = (items: ReadonlyArray<Region>): void => {
    for (const region of items) {
      if (seen.has(region)) continue
      seen.add(region)
      found.push(region)
      operationsOf(region).forEach(operation)
    }
  }
  visit(regions)
  return found
}

export const operationChildren = (operation: Operation): ReadonlyArray<Operation> => {
  if (operation._tag === 'DiagnosticScope') return executionOperations(operation.body)
  if (operation._tag === 'Conditional')
    return [...executionOperations(operation.taken), ...executionOperations(operation.otherwise)]
  if (operation._tag === 'ShortCircuit') return executionOperations(operation.right)
  if (operation._tag === 'Match') {
    return operation.arms.flatMap((arm) => [
      ...(arm.guard === undefined ? [] : executionOperations(arm.guard.execution)),
      ...executionOperations(arm.selected.execution),
    ])
  }
  if (
    operation._tag === 'RunEffect' ||
    operation._tag === 'RunEffectValue' ||
    operation._tag === 'RunStaticEffect'
  ) {
    return [...(operation.failureLoanEnds ?? []), ...(operation.releases ?? [])]
  }
  return []
}

/** One operation and all structurally nested operations in deterministic source order. */
export const operationTree = (operation: Operation): ReadonlyArray<Operation> => {
  const seen = new Set<Operation>()
  const walk = (current: Operation): ReadonlyArray<Operation> => {
    if (seen.has(current)) return []
    seen.add(current)
    return [current, ...operationChildren(current).flatMap(walk)]
  }
  return walk(operation)
}

const diagnosticObservationByModule = new WeakMap<Module, boolean>()

/**
 * Whether internal invocations carry a lexical diagnostic observer.
 *
 * This is a module-wide fact, shared by every function's ABI and frame planning.
 * Compute it once per immutable MIR snapshot: repeated scans accounted for 1.3s
 * in the self-hosted compiler's cold-build profile. A transformed module has a
 * new identity and therefore derives its own fact; weak ownership does not keep
 * completed compilation snapshots alive. Both positive and negative results are
 * retained.
 */
export const hasDiagnosticObservation = (module: Module): boolean => {
  const known = diagnosticObservationByModule.get(module)
  if (known !== undefined) return known
  const observed = module.functions.some((fn) =>
    regionsTree(fn.regions).some((region) =>
      operationsOf(region).some((operation) => operation._tag === 'DiagnosticScope'),
    ),
  )
  diagnosticObservationByModule.set(module, observed)
  return observed
}

/** Four descriptor pointers followed by the six-field enclosing cause. */
export const diagnosticScopeWords = 10

/** Observer, opaque handle, and the two static pointer/length pairs. */
export const diagnosticOutcomeWords = 6

/** Internal failure outcomes that require independent metadata ownership. */
export const diagnosticOutcomeLocals = (module: Module, fn: MirFunction): ReadonlyArray<LocalId> =>
  hasDiagnosticObservation(module)
    ? fn.localTypes.flatMap((type, ordinal) =>
        type._tag === 'EffectOutcome' && SilkType.failureMembers(type.type).length > 0
          ? [{ _tag: 'Local' as const, ordinal }]
          : [],
      )
    : []

/** Shared physical header roles for layout construction and verification. */
export const coroutineFrameHeaderRoles = (
  module: Module,
): ReadonlyArray<CoroutineFrameHeaderRole> =>
  hasDiagnosticObservation(module)
    ? [
        'Parent',
        'State',
        'Observer',
        'IncomingCauseObserver',
        'IncomingCauseHandle',
        'IncomingCauseIdentity',
        'IncomingCauseIdentityLength',
        'IncomingCauseOrigin',
        'IncomingCauseOriginLength',
        'CurrentCauseObserver',
        'CurrentCauseHandle',
        'CurrentCauseIdentity',
        'CurrentCauseIdentityLength',
        'CurrentCauseOrigin',
        'CurrentCauseOriginLength',
      ]
    : ['Parent', 'State']

/** Lexical descriptor identities in deterministic local order. */
export const diagnosticScopeLocals = (fn: MirFunction): ReadonlyArray<LocalId> =>
  [
    ...new Map(
      regionsTree(fn.regions).flatMap((region) =>
        operationsOf(region).flatMap((operation) =>
          operation._tag === 'DiagnosticScope'
            ? [[operation.destination.ordinal, operation.destination] as const]
            : [],
        ),
      ),
    ).values(),
  ].sort((left, right) => left.ordinal - right.ordinal)

export const callArgumentCompatible = (actual: Type, expected: Type): boolean => {
  const actualSemantic = semanticType(actual)
  const expectedSemantic = semanticType(expected)
  const actualContract =
    SilkType.isRepresented(actualSemantic) &&
    (SilkType.isCallable(actualSemantic.contract) || SilkType.isEffect(actualSemantic.contract))
      ? actualSemantic.contract
      : actualSemantic
  const expectedContract =
    SilkType.isRepresented(expectedSemantic) &&
    (SilkType.isCallable(expectedSemantic.contract) || SilkType.isEffect(expectedSemantic.contract))
      ? expectedSemantic.contract
      : expectedSemantic
  if (acceptsRuntimeOperand(actualContract, expectedContract)) return true
  if (
    actual._tag !== 'EffectValue' ||
    expected._tag !== 'EffectValue' ||
    actual.storage !== undefined ||
    expected.storage?._tag !== 'StoredEffectField'
  )
    return false
  const realization = expected.storage.realization
  return (
    SilkType.equals(actual.type, realization.contract) &&
    Tir.sameExecutableSite(actual.site, realization.site) &&
    instanceText(actual.environment.instance) === instanceText(realization.runnerInstance)
  )
}

// Executable captures carry a semantic view of an already selected physical closure. Running
// that closure consumes the capture; outer access and invocation lifetime proofs do not select
// another machine. Keep the source identity and all execution channels exact.
export const executionArgumentCompatible = (actual: Type, expected: Type): boolean => {
  if (actual._tag === 'EffectValue' && expected._tag === 'EffectValue')
    return (
      EffectExecutionContract.equals(actual.type, expected.type) &&
      Tir.sameExecutableSite(actual.site, expected.site) &&
      instanceText(actual.environment.instance) === instanceText(expected.environment.instance) &&
      actual.storage === expected.storage
    )
  if (
    actual._tag === 'CallableValue' &&
    expected._tag === 'CallableValue' &&
    SilkType.isEffect(actual.type.result) &&
    SilkType.isEffect(expected.type.result)
  )
    return (
      Tir.sameCallableTarget(actual.target, expected.target) &&
      runtimeArgumentsEqual(actual.typeArguments ?? [], expected.typeArguments ?? []) &&
      actual.environment === expected.environment &&
      actual.type.unsafe === expected.type.unsafe &&
      SilkType.compareAccess(expected.type.mode, actual.type.mode) &&
      actual.type.parameters.length === expected.type.parameters.length &&
      actual.type.parameters.every((parameter, ordinal) => {
        const compared = expected.type.parameters.at(ordinal)
        return compared !== undefined && acceptsRuntimeOperand(compared, parameter)
      }) &&
      EffectExecutionContract.equals(actual.type.result, expected.type.result)
    )
  return callArgumentCompatible(actual, expected)
}
