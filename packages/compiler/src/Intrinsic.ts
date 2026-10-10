import * as Lifetime from './Lifetime.js'
import * as CallableContract from './CallableContract.js'
import * as Constraint from './Constraint.js'
import type * as Tir from './Tir.js'
import * as RowAlgebra from './RowAlgebra.js'
import * as Scalar from './Scalar.js'
import * as SourceSpan from './SourceSpan.js'
import * as Target from './Target.js'
import * as Type from './Type.js'

/** Stable identity of one compiler-provided actor with no source declaration. */
export interface ActorId {
  readonly _tag: 'IntrinsicActorId'
  readonly name: string
}

/** Stable identity of one compiler-provided operation with no source declaration. */
export interface OperationId {
  readonly _tag: 'IntrinsicOperationId'
  readonly actor: string
  readonly name: string
}

/** One named generic parameter used by source-like presentation and completion. */
export interface TypeParameter {
  readonly name: string
}

/** One named value parameter used by source-like presentation and completion. */
export interface ValueParameter {
  readonly name: string
  readonly type: string
  /** A compiler-consumed lane is explicit and never enters an ordinary runtime calling shape. */
  readonly phase?: 'Static'
}

/** Structural reason one source-callable primitive remains compiler-owned. */
export type AdmissionCategory =
  | 'Representation'
  | 'Scalar'
  | 'Ownership'
  | 'Effect'
  | 'Platform'
  | 'Language'

/** Whether an intrinsic executes during static evaluation or in the residual runtime program. */
export type Phase = 'Runtime' | 'StaticOnly' | 'Mixed'

/** Canonical deterministic order for residual runtime targets. */
export const runtimeTargets: ReadonlyArray<Target.Id> = Target.all.map((target) => target.id)

/** Normalizes an availability set to the compiler-owned target order. */
export const normalizeRuntimeTargets = (
  targets: ReadonlyArray<Target.Id>,
): ReadonlyArray<Target.Id> => runtimeTargets.filter((target) => targets.includes(target))

/** A primitive either returns a closed type or constructs an ordinary occurrence-owned pair. */
export type ResultPolicy =
  | { readonly _tag: 'ClosedResult'; readonly type: Type.Type }
  | { readonly _tag: 'GeneratedUsizePair' }

export const closedResult = (type: Type.Type): ResultPolicy => ({ _tag: 'ClosedResult', type })

/** This owned pair is generated at the selected call, never assigned a source declaration. */
export const generatedUsizePair: ResultPolicy = { _tag: 'GeneratedUsizePair' }

/** Only closed results can be named as an intrinsic function item or source witness result. */
export const closedResultType = (self: ResultPolicy): Type.Type | undefined =>
  self._tag === 'ClosedResult' ? self.type : undefined

export const substituteResult = (
  self: ResultPolicy,
  substitution: ReadonlyMap<string, Type.GenericArgument>,
): ResultPolicy =>
  self._tag === 'ClosedResult' ? closedResult(Type.substitute(self.type, substitution)) : self

/** The caller owns the selected occurrence and registers its ordinary aggregate facts. */
export const instantiateResult = (
  self: ResultPolicy,
  substitution: ReadonlyMap<string, Type.GenericArgument>,
  generate: (fields: ReadonlyArray<Type.Type>) => Type.Nominal,
): Type.Type => {
  switch (self._tag) {
    case 'ClosedResult':
      return Type.substitute(self.type, substitution)
    case 'GeneratedUsizePair':
      return generate(['usize', 'usize'])
  }
}

/** The elaboration rule selected by an intrinsic operation identity. */
export type Rule =
  | {
      readonly _tag: 'BuiltinRule'
      readonly operation: Tir.BuiltinOperation
      readonly typeParameters: ReadonlyArray<Type.Parameter>
      readonly parameters: ReadonlyArray<Type.Type>
      readonly result: ResultPolicy
      /** Call preconditions: each stored type must outlive its template region. */
      readonly typeOutlives: ReadonlyArray<Type.TypeOutlives>
    }
  | {
      readonly _tag: 'ContractRule'
      readonly contract: CallableContract.CallableContract
      readonly post: 'BindRequirement' | 'CatchFailure'
      readonly providerMode?: Constraint.ProviderMode
    }
  | { readonly _tag: 'PlaceRule'; readonly operation: 'Replace' }
  | {
      readonly _tag: 'StaticOnlyRule'
      readonly contract: CallableContract.CallableContract
    }
  | {
      /** One shared owner lane plus one descriptor lane consumed while residualizing. */
      readonly _tag: 'MixedFieldProjectionRule'
      readonly contract: CallableContract.CallableContract
      readonly runtimeOwnerParameter: 0
      readonly staticDescriptorParameter: 1
    }
  | {
      /** One compiler-issued test descriptor is consumed while publishing its exact callable. */
      readonly _tag: 'MixedTestFunctionRule'
      readonly contract: CallableContract.CallableContract
      readonly staticDescriptorParameter: 0
    }
  | {
      /** Result and parameter types are derived from the owning canonical enum declaration. */
      readonly _tag: 'EnumValueRule'
    }

/** One compiler-provided operation shared by analysis, presentation, and completion. */
export interface Operation {
  readonly _tag: 'IntrinsicOperation'
  readonly id: OperationId
  readonly spelling: string
  readonly typeParameters: ReadonlyArray<TypeParameter>
  readonly parameters: ReadonlyArray<ValueParameter>
  readonly result: string
  readonly unsafe: boolean
  readonly phase: Phase
  readonly admission?: AdmissionCategory
  readonly consumer?: string
  readonly targets: ReadonlyArray<Target.Id>
  readonly invariant?: string

  readonly rule: Rule
}

/** A target-neutral primitive with one resolved source-call ownership contract. */
export interface BuiltinOperation extends Operation {
  readonly callParameters: ReadonlyArray<Type.Type>
  readonly rule: Extract<Rule, { readonly _tag: 'BuiltinRule' }>
}

/** One compiler-provided source actor or namespace. */
export interface Actor {
  readonly _tag: 'IntrinsicActor'
  readonly id: ActorId
  readonly spelling: string
  readonly kind: 'Type' | 'Namespace'
  readonly operations: ReadonlyArray<Operation>
}

const actorId = (name: string): ActorId => ({ _tag: 'IntrinsicActorId', name })

const operationId = (actor: string, name: string): OperationId => ({
  _tag: 'IntrinsicOperationId',
  actor,
  name,
})

const typeParameter = (name: string): TypeParameter => ({ name })

const valueParameter = (name: string, type: string): ValueParameter => ({ name, type })

const staticValueParameter = (name: string, type: string): ValueParameter => ({
  name,
  type,
  phase: 'Static',
})

const upperInitial = (value: string): string =>
  `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`

const intrinsicSpelling = (family: string, operation: string): string => {
  if (Scalar.isSpelling(family)) return `${family}${upperInitial(operation)}`
  if (family === 'Effect' && operation === 'suspendEffect') return 'suspendEffect'
  if (family === 'Effect' && operation === 'finalizeEffect') return 'finalizeEffect'
  if (family === 'Effect' && operation === 'finalizeEffectNonParking')
    return 'finalizeEffectNonParking'
  if (family === 'Effect' && operation === 'useReleaseNonParking') return 'useReleaseNonParking'
  if (family === 'Effect' && operation === 'observeDiagnostics') return 'observeDiagnostics'
  if (family === 'Effect' && operation === 'observeUnhandled') return 'observeUnhandled'
  if (family === 'Effect' && operation.startsWith('bindRequirement')) return operation
  if (family === 'Effect' && operation === 'catchFailure') return operation
  if (family === 'Execution' && operation === 'relinquish') return 'relinquish'
  if (family === 'Place' && operation === 'replace') return 'replace'
  if (family === 'Storage' && operation === 'acquire') return 'systemAllocationAcquire'
  if (family === 'Os') return `os${upperInitial(operation)}`
  return `${family.slice(0, 1).toLowerCase()}${family.slice(1)}${upperInitial(operation)}`
}

const admission = (family: string): AdmissionCategory => {
  if (Scalar.isSpelling(family)) return 'Scalar'
  if (family === 'Effect') return 'Effect'
  if (family === 'Host' || family === 'Storage' || family === 'Os') return 'Platform'
  if (family === 'Layout' || family === 'string' || family === 'Slice') return 'Representation'
  if (
    family === 'RawBuffer' ||
    family === 'Pointer' ||
    family === 'Slot' ||
    family === 'Shared' ||
    family === 'Execution'
  )
    return 'Ownership'
  return 'Language'
}

/** The canonical standard-library consumer of one OS boundary operation. */
const osConsumer = (spelling: string): string => {
  if (spelling.startsWith('host'))
    return `silk/os_host_input.${spelling.slice(4, 5).toLowerCase()}${spelling.slice(5)}`
  return `silk/os_filesystem.${spelling}`
}

const consumer = (family: string, operation: string): string => {
  if (family === 'Effect' && operation === 'finalizeEffect') return 'silk/effect.ensuring'
  if (family === 'Effect' && operation === 'finalizeEffectNonParking')
    return 'silk/effect.ensuringNonParking'
  if (family === 'Effect' && operation === 'observeUnhandled')
    return 'language:terminal-diagnostic-observation'
  if (family === 'Effect' && operation === 'observeDiagnostics')
    return 'language:lexical-diagnostic-observation'
  if (Scalar.isSpelling(family)) return `silk/${family}.${operation}`
  if (family === 'Effect') return `silk/effect.${operation}`
  if (family === 'Shared')
    return operation === 'layout' || operation === 'fromAllocation'
      ? 'silk/shared.make'
      : `silk/shared.${operation}`
  if (family === 'Execution') {
    if (operation === 'layout' || operation === 'fromAllocation') return 'silk/execution.make'
    if (operation === 'drive' || operation === 'refOf') return 'silk/execution.drive'
    if (operation === 'notify') return 'silk/execution.notifyInitial'
    if (operation === 'live') return 'silk/execution.wake'
    return 'silk/execution.park'
  }
  if (family === 'Storage') return 'silk/allocator.allocate'
  if (family === 'Os') return osConsumer(operation)
  if (family === 'Place') return 'language:place-replacement'
  return `silk/${family.replaceAll(/([a-z])([A-Z])/g, '$1_$2').toLowerCase()}.${operation}`
}

/** The caller obligation of each unsafe pointer primitive, keyed by operation name. */
const pointerInvariants: ReadonlyMap<string, string> = new Map([
  [
    'bytes',
    'caller proves the readable initialized extent for every subsequent byte access; projection grants no extent or ownership',
  ],
  ['at', 'caller proves the pointer and the offset result address elements of one live allocation'],
  [
    'atMut',
    'caller proves the pointer and the offset result address elements of one live allocation',
  ],
  [
    'reinterpret',
    'caller proves destination alignment and storage validity before access, and initialization before reading; no ownership or loan is created',
  ],
  [
    'requalify',
    'caller proves every strengthened pointer qualifier, including alignment, nullness, extent and write access',
  ],
  ['readUnaligned', 'caller proves live readable storage containing an initialized Copy T'],
  ['writeUnaligned', 'caller proves live writable storage for a Copy T'],
  ['read', 'caller proves the pointer is non-null, aligned, and addresses an initialized T'],
  ['write', 'caller proves the pointer is non-null, aligned, and addresses writable storage for T'],
])

const builtin = (options: {
  readonly actor: string
  readonly name: string
  readonly operation: Tir.BuiltinOperation
  readonly typeParameters?: ReadonlyArray<string>
  readonly semanticTypeParameters?: ReadonlyArray<Type.Parameter>
  readonly parameters: ReadonlyArray<ValueParameter>
  readonly semanticParameters: ReadonlyArray<Type.Type>
  readonly callParameters?: ReadonlyArray<Type.Type>
  readonly result: string
  readonly semanticResult: ResultPolicy
  readonly typeOutlives?: ReadonlyArray<Type.TypeOutlives>
  readonly unsafe?: boolean
  readonly targets?: ReadonlyArray<Target.Id>
}): BuiltinOperation => {
  const spelling = intrinsicSpelling(options.actor, options.name)
  let invariant: string | undefined
  if (options.unsafe) {
    switch (options.actor) {
      case 'RawBuffer':
        invariant =
          'caller proves raw-buffer bounds, ownership, and initializedness required by the operation'
        break
      case 'Pointer':
        invariant = pointerInvariants.get(options.name)
        break
      case 'Slot':
        invariant =
          'caller proves the selected slot is in bounds and has the initializedness state required by the operation'
        break
      case 'Shared':
        invariant =
          'caller proves the allocation came from the exact shared layout specialization and transfers it and the value exactly once'
        break
      case 'Execution':
        invariant =
          'caller proves the allocation came from the exact execution package layout specialization and transfers it, the body, and the fixed endpoint exactly once'
        break
    }
  }
  return {
    _tag: 'IntrinsicOperation',
    id: operationId('Intrinsic', spelling),
    spelling,
    typeParameters: (options.typeParameters ?? []).map(typeParameter),
    parameters: Array.from(options.parameters),
    callParameters: Array.from(options.callParameters ?? options.semanticParameters),
    result: options.result,
    unsafe: options.unsafe ?? false,
    phase: 'Runtime',
    admission: admission(options.actor),
    consumer: consumer(options.actor, options.name),
    targets: normalizeRuntimeTargets(options.targets ?? runtimeTargets),
    ...(invariant === undefined ? {} : { invariant }),

    rule: {
      _tag: 'BuiltinRule',
      operation: options.operation,
      typeParameters: Array.from(options.semanticTypeParameters ?? []),
      parameters: Array.from(options.semanticParameters),
      result: options.semanticResult,
      typeOutlives: Array.from(options.typeOutlives ?? []),
    },
  }
}

export const isBuiltinOperation = (operation: Operation): operation is BuiltinOperation =>
  operation.rule._tag === 'BuiltinRule' && 'callParameters' in operation

const contractEffect = (options: {
  readonly name: string
  readonly typeParameters: ReadonlyArray<string>
  readonly parameters: ReadonlyArray<ValueParameter>
  readonly result: string
  readonly contract: CallableContract.CallableContract
  readonly post: Extract<Rule, { readonly _tag: 'ContractRule' }>['post']
  readonly providerMode?: Constraint.ProviderMode
  readonly targets?: ReadonlyArray<Target.Id>
}): Operation => {
  const spelling = intrinsicSpelling('Effect', options.name)
  return {
    _tag: 'IntrinsicOperation',
    id: operationId('Intrinsic', spelling),
    spelling,
    typeParameters: options.typeParameters.map(typeParameter),
    parameters: Array.from(options.parameters),
    result: options.result,
    unsafe: false,
    phase: 'Runtime',
    admission: admission('Effect'),
    consumer: consumer('Effect', options.name),
    targets: normalizeRuntimeTargets(options.targets ?? runtimeTargets),
    rule: {
      _tag: 'ContractRule',
      contract: options.contract,
      post: options.post,
      ...(options.providerMode === undefined ? {} : { providerMode: options.providerMode }),
    },
  }
}

const actor = (
  spelling: string,
  kind: Actor['kind'],
  operations: ReadonlyArray<Operation>,
): Actor => ({
  _tag: 'IntrinsicActor',
  id: actorId(spelling),
  spelling,
  kind,
  operations: Array.from(operations),
})

// Intrinsic headers quantify their borrowed inputs and retained environments. A call
// instantiates these declaration-owned regions before validating its selected contract.
const contractLifetime = (name: string): Lifetime.Bound =>
  Lifetime.bound({ module: 'Intrinsic', name }, 0, 'call')

const rawElement = Type.parameter({ module: 'silk/core', name: '$RawStorage' }, 0, 'T')
const rawTypeParameters = [rawElement]
const pointerElement = Type.parameter({ module: 'Intrinsic', name: '$Pointer' }, 0, 'T')
const pointerTypeParameters = [pointerElement]
const pointerSource = Type.parameter({ module: 'Intrinsic', name: '$PointerQualifiers' }, 0, 'From')
const pointerDestination = Type.parameter(
  { module: 'Intrinsic', name: '$PointerQualifiers' },
  1,
  'To',
)
const sharedElement = Type.parameter({ module: 'Intrinsic', name: '$LocalShared' }, 0, 'T')
const sharedResult = Type.parameter({ module: 'Intrinsic', name: '$LocalShared' }, 1, 'A')
const sharedTypeParameters = [sharedElement]
const sharedLifecycleTypeParameters = [sharedElement, sharedResult]
const sharedAccessLifetime = Lifetime.bound(
  { module: 'Intrinsic', name: 'SharedWithMut.use' },
  0,
  'access',
)
const executionPackageOwner = { module: 'Intrinsic', name: '$ExecutionPackage' }
const executionResult = Type.parameter(executionPackageOwner, 0, 'A')
const executionBodyBound = Type.effect(
  executionResult,
  [],
  { environment: Lifetime.staticLifetime, lifetimeBinders: [] },
  'Take',
)
const executionBody = Type.parameter(
  executionPackageOwner,
  1,
  'F',
  'EffectRepresentation',
  executionBodyBound,
  ['Intrinsic.Detached'],
)
const executionEndpoint = Type.parameter(executionPackageOwner, 2, 'O', 'Value', undefined, [
  'Intrinsic.Detached',
])
const executionReadyLifetime = contractLifetime('executionReadyBound')
const executionReadyBound = Type.callable(
  [Type.reference('Shared', executionEndpoint, executionReadyLifetime)],
  Type.unit,
  { environment: Lifetime.staticLifetime, lifetimeBinders: [executionReadyLifetime] },
  'Shared',
)
const executionReady = Type.parameter(
  executionPackageOwner,
  3,
  'R',
  'CallableRepresentation',
  executionReadyBound,
  ['Intrinsic.Detached', 'Intrinsic.NonParking'],
)
const executionPackageTypeParameters = [
  executionResult,
  executionBody,
  executionEndpoint,
  executionReady,
]
const representedExecutionBody = Type.represented(
  executionBodyBound,
  executionBodyBound,
  Type.representationParameterArgument(executionBody),
)
const representedExecutionReady = Type.represented(
  executionReadyBound,
  executionReadyBound,
  Type.representationParameterArgument(executionReady),
)
const executionDriveOwner = { module: 'Intrinsic', name: '$ExecutionDrive' }
const drivenResult = Type.parameter(executionDriveOwner, 0, 'A')
const driveBranch = Type.parameter(executionDriveOwner, 1, 'D')
const completionBound = Type.callable(
  [driveBranch, drivenResult],
  Type.unit,
  { environment: contractLifetime('completionBound'), lifetimeBinders: [] },
  'Take',
)
const completionCallback = Type.parameter(
  executionDriveOwner,
  2,
  'C',
  'CallableRepresentation',
  completionBound,
  ['Intrinsic.NonParking'],
)
const suspensionBound = Type.callable(
  [driveBranch, Type.execution(drivenResult)],
  Type.unit,
  { environment: contractLifetime('suspensionBound'), lifetimeBinders: [] },
  'Take',
)
const suspensionCallback = Type.parameter(
  executionDriveOwner,
  3,
  'S',
  'CallableRepresentation',
  suspensionBound,
  ['Intrinsic.NonParking'],
)
const executionDriveTypeParameters = [
  drivenResult,
  driveBranch,
  completionCallback,
  suspensionCallback,
]
const representedCompletion = Type.represented(
  completionBound,
  completionBound,
  Type.representationParameterArgument(completionCallback),
)
const representedSuspension = Type.represented(
  suspensionBound,
  suspensionBound,
  Type.representationParameterArgument(suspensionCallback),
)
const executionReferenceOwner = { module: 'Intrinsic', name: '$ExecutionRefOf' }
const referencedResult = Type.parameter(executionReferenceOwner, 0, 'A')
const sharedExecutionRef = (name: string) =>
  Type.reference('Shared', Type.executionRef, contractLifetime(name))
const suspensionOwner = { module: 'silk/core', name: '$EffectSuspend' }
const observationOwner = { module: 'Intrinsic', name: '$ObserveDiagnostics' }
const observationState = Type.parameter(observationOwner, 0, 'S')
const observationSuccess = Type.parameter(observationOwner, 1, 'A')
const observationRequirement = Type.parameter(observationOwner, 2, 'R', 'RequirementRow')
const observationBorrow = contractLifetime('observationState')
const observationCallbackBound = Type.callable(
  [
    Type.reference('Exclusive', observationState, observationBorrow),
    'u8',
    'usize',
    'usize',
    Type.string(Lifetime.staticLifetime),
    Type.string(Lifetime.staticLifetime),
  ],
  'usize',
  { environment: Lifetime.staticLifetime, lifetimeBinders: [observationBorrow] },
  'Shared',
)
const observationCallback = Type.parameter(
  observationOwner,
  3,
  'F',
  'CallableRepresentation',
  observationCallbackBound,
  ['Intrinsic.NonParking'],
)
const observationEnvironment = contractLifetime('observeDiagnostics')
const observedEffect = Type.effectWithRows(
  observationSuccess,
  RowAlgebra.concrete(Type.failureRowPolicy(), []),
  { environment: observationEnvironment, lifetimeBinders: [] },
  'Take',
  RowAlgebra.parameter<Type.Requirement, Type.Parameter, Type.RequirementMemberShape>(
    observationRequirement,
  ),
)
const suspensionSuccess = Type.parameter(suspensionOwner, 0, 'A')
const suspensionFailure = Type.parameter(suspensionOwner, 1, 'E')
const suspensionRequirement = Type.parameter(suspensionOwner, 2, 'R', 'RequirementRow')
const suspensionTypeParameters = [suspensionSuccess, suspensionFailure, suspensionRequirement]
const bindingOwner = { module: 'silk/core', name: '$BindRequirement' }
const bindingSelected = Type.parameter(bindingOwner, 0, 'S', 'RequirementRow')
const bindingSuccess = Type.parameter(bindingOwner, 1, 'A')
const bindingProvider = Type.parameter(bindingOwner, 2, 'P')
const bindingFailure = Type.parameter(bindingOwner, 3, 'E')
const bindingRequirements = Type.parameter(bindingOwner, 4, 'R', 'RequirementRow')
const bindingTypeParameters = [
  bindingSelected,
  bindingSuccess,
  bindingProvider,
  bindingFailure,
  bindingRequirements,
]
const intrinsicContractOrigin = (() => {
  const span = SourceSpan.fromOffsets('$intrinsic-contract', 0, 0)
  if (span === undefined) throw new RangeError('intrinsic contract span is invalid')
  return span
})()
const bindingFailureRow = RowAlgebra.singleton(
  Type.failureRowPolicy(),
  Type.failureMemberShape(bindingFailure),
  intrinsicContractOrigin,
)
const bindingRequirementRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(bindingRequirements)
const bindingSelectedRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(bindingSelected)
const bindingContract = (mode: Constraint.ProviderMode): CallableContract.CallableContract => {
  const provider =
    mode === 'Take'
      ? bindingProvider
      : Type.reference(mode, bindingProvider, contractLifetime('provider'))
  return CallableContract.make({
    environment: contractLifetime('bindingContract'),
    lifetimeBinders: [],
    lifetimeBounds:
      mode === 'Take'
        ? []
        : [{ longer: contractLifetime('provider'), shorter: contractLifetime('bindingContract') }],
    functionKind: 'Effect',
    binders: bindingTypeParameters,
    parameters: [
      {
        type: Type.effectWithRows(
          bindingSuccess,
          bindingFailureRow,
          { environment: contractLifetime('bindingContract'), lifetimeBinders: [] },
          'Take',
          bindingRequirementRow,
        ),
        mode: 'Take' as const,
      },
      { type: provider, mode },
    ],
    result: Type.effectWithRows(
      bindingSuccess,
      bindingFailureRow,
      { environment: contractLifetime('bindingContract'), lifetimeBinders: [] },
      'Shared',
      RowAlgebra.without(Type.requirementRowPolicy(), bindingRequirementRow, bindingSelectedRow),
    ),
    constraints: [
      Constraint.providerSelection(
        mode,
        bindingProvider,
        bindingSelectedRow,
        bindingRequirementRow,
      ),
    ],
  })
}
const finalizationOwner = { module: 'Intrinsic', name: '$FinalizeEffect' }
const finalizationSuccess = Type.parameter(finalizationOwner, 0, 'A')
const finalizationFailure = Type.parameter(finalizationOwner, 1, 'E')
const finalizationProtectedRequirements = Type.parameter(
  finalizationOwner,
  2,
  'R',
  'RequirementRow',
)
const finalizationFinalizerRequirements = Type.parameter(
  finalizationOwner,
  3,
  'S',
  'RequirementRow',
)
const finalizationFailureRow = RowAlgebra.singleton(
  Type.failureRowPolicy(),
  Type.failureMemberShape(finalizationFailure),
  intrinsicContractOrigin,
)
const finalizationProtectedRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(finalizationProtectedRequirements)
const finalizationFinalizerRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(finalizationFinalizerRequirements)
const finalizationEnvironment = {
  environment: contractLifetime('finalizeEffect'),
  lifetimeBinders: [],
}
const nonParkingFinalizationOwner = {
  module: 'Intrinsic',
  name: '$FinalizeEffectNonParking',
}
const nonParkingFinalizationSuccess = Type.parameter(nonParkingFinalizationOwner, 0, 'A')
const nonParkingFinalizationFailure = Type.parameter(nonParkingFinalizationOwner, 1, 'E')
const nonParkingFinalizationProtectedRequirements = Type.parameter(
  nonParkingFinalizationOwner,
  2,
  'R',
  'RequirementRow',
)
const nonParkingFinalizationFinalizerRequirements = Type.parameter(
  nonParkingFinalizationOwner,
  3,
  'S',
  'RequirementRow',
)
const nonParkingFinalizationFailureRow = RowAlgebra.singleton(
  Type.failureRowPolicy(),
  Type.failureMemberShape(nonParkingFinalizationFailure),
  intrinsicContractOrigin,
)
const nonParkingFinalizationProtectedRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(nonParkingFinalizationProtectedRequirements)
const nonParkingFinalizationFinalizerRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(nonParkingFinalizationFinalizerRequirements)
const nonParkingFinalizationEnvironment = {
  environment: contractLifetime('finalizeEffectNonParking'),
  lifetimeBinders: [],
}
const nonParkingResourceOwner = {
  module: 'Intrinsic',
  name: '$UseReleaseNonParking',
}
const nonParkingResource = Type.parameter(nonParkingResourceOwner, 0, 'Resource')
const nonParkingResourceSuccess = Type.parameter(nonParkingResourceOwner, 1, 'A')
const nonParkingResourceFailure = Type.parameter(nonParkingResourceOwner, 2, 'E')
const nonParkingResourceUseRequirements = Type.parameter(
  nonParkingResourceOwner,
  3,
  'R',
  'RequirementRow',
)
const nonParkingResourceReleaseRequirements = Type.parameter(
  nonParkingResourceOwner,
  4,
  'S',
  'RequirementRow',
)
const nonParkingResourceFailureRow = RowAlgebra.singleton(
  Type.failureRowPolicy(),
  Type.failureMemberShape(nonParkingResourceFailure),
  intrinsicContractOrigin,
)
const nonParkingResourceUseRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(nonParkingResourceUseRequirements)
const nonParkingResourceReleaseRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(nonParkingResourceReleaseRequirements)
const nonParkingResourceEnvironment = contractLifetime('useReleaseNonParking')
const nonParkingResourceAccess = Lifetime.bound(
  { module: 'Intrinsic', name: 'UseReleaseNonParking.access' },
  0,
  'access',
)
const nonParkingResourceUse = Type.callable(
  [Type.reference('Exclusive', nonParkingResource, nonParkingResourceAccess)],
  Type.effectWithRows(
    nonParkingResourceSuccess,
    nonParkingResourceFailureRow,
    {
      environment: Lifetime.intersection([nonParkingResourceAccess, nonParkingResourceEnvironment]),
      lifetimeBinders: [],
    },
    'Take',
    nonParkingResourceUseRow,
  ),
  { environment: nonParkingResourceEnvironment, lifetimeBinders: [nonParkingResourceAccess] },
  'Take',
)
const nonParkingResourceRelease = Type.callable(
  [Type.reference('Exclusive', nonParkingResource, nonParkingResourceAccess)],
  Type.effectWithRows(
    Type.unit,
    RowAlgebra.concrete(Type.failureRowPolicy(), []),
    {
      environment: Lifetime.intersection([nonParkingResourceAccess, nonParkingResourceEnvironment]),
      lifetimeBinders: [],
    },
    'Take',
    nonParkingResourceReleaseRow,
  ),
  { environment: nonParkingResourceEnvironment, lifetimeBinders: [nonParkingResourceAccess] },
  'Take',
)
const catchOwner = { module: 'silk/core', name: '$CatchFailure' }
const catchSelected = Type.parameter(catchOwner, 0, 'S')
const catchSuccess = Type.parameter(catchOwner, 1, 'A')
const catchHandlerSuccess = Type.parameter(catchOwner, 2, 'B')
const catchProtectedFailure = Type.parameter(catchOwner, 3, 'E')
const catchHandlerFailure = Type.parameter(catchOwner, 4, 'F')
const catchProtectedRequirements = Type.parameter(catchOwner, 5, 'R', 'RequirementRow')
const catchHandlerRequirements = Type.parameter(catchOwner, 6, 'Q', 'RequirementRow')
const catchTypeParameters = [
  catchSelected,
  catchSuccess,
  catchHandlerSuccess,
  catchProtectedFailure,
  catchHandlerFailure,
  catchProtectedRequirements,
  catchHandlerRequirements,
]
const catchProtectedFailureRow = RowAlgebra.singleton(
  Type.failureRowPolicy(),
  Type.failureMemberShape(catchProtectedFailure),
  intrinsicContractOrigin,
)
const catchHandlerFailureRow = RowAlgebra.singleton(
  Type.failureRowPolicy(),
  Type.failureMemberShape(catchHandlerFailure),
  intrinsicContractOrigin,
)
const catchProtectedRequirementRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(catchProtectedRequirements)
const catchHandlerRequirementRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(catchHandlerRequirements)
const suspensionFailureRow = RowAlgebra.singleton(
  Type.failureRowPolicy(),
  Type.failureMemberShape(suspensionFailure),
  intrinsicContractOrigin,
)
const suspensionRequirementRow = RowAlgebra.parameter<
  Type.Requirement,
  Type.Parameter,
  Type.RequirementMemberShape
>(suspensionRequirement)
const catchSelectedRow = RowAlgebra.singleton(
  Type.failureRowPolicy(),
  Type.failureMemberShape(catchSelected),
  intrinsicContractOrigin,
)
const catchJoinedSuccess = Type.union([catchSuccess, catchHandlerSuccess])
if (catchJoinedSuccess._tag !== 'Normalized')
  throw new RangeError('catch success parameters must form an ordinary union')
const catchInvocation = Lifetime.bound(
  { module: 'Intrinsic', name: 'catchFailure.handler' },
  0,
  'call',
)
const catchContract = CallableContract.make({
  environment: contractLifetime('catchContract'),
  lifetimeBinders: [],
  functionKind: 'Effect',
  binders: catchTypeParameters,
  parameters: [
    {
      type: Type.effectWithRows(
        catchSuccess,
        catchProtectedFailureRow,
        { environment: contractLifetime('catchContract'), lifetimeBinders: [] },
        'Take',
        catchProtectedRequirementRow,
      ),
      mode: 'Take' as const,
    },
    {
      type: Type.callable(
        [catchSelected],
        Type.effectWithRows(
          catchHandlerSuccess,
          catchHandlerFailureRow,
          {
            environment: Lifetime.intersection([
              catchInvocation,
              contractLifetime('catchContract'),
            ]),
            lifetimeBinders: [],
          },
          'Take',
          catchHandlerRequirementRow,
        ),
        {
          environment: contractLifetime('catchContract'),
          lifetimeBinders: [catchInvocation],
          invocationUse: { lifetime: catchInvocation, parameters: [0] },
        },
        'Take',
      ),
      mode: 'Take' as const,
    },
  ],
  result: Type.effectWithRows(
    catchJoinedSuccess.type,
    RowAlgebra.union(
      Type.failureRowPolicy(),
      RowAlgebra.without(Type.failureRowPolicy(), catchProtectedFailureRow, catchSelectedRow),
      catchHandlerFailureRow,
    ),
    { environment: contractLifetime('catchContract'), lifetimeBinders: [] },
    'Shared',
    RowAlgebra.union(
      Type.requirementRowPolicy(),
      catchProtectedRequirementRow,
      catchHandlerRequirementRow,
    ),
  ),
  constraints: [Constraint.failureSubset(catchSelectedRow, catchProtectedFailureRow)],
})
const byteSlice = Type.slice('Shared', 'u8', contractLifetime('byteSlice'))
const scalarOperation = (scalar: Scalar.Scalar, operation: Scalar.Operation): Operation => {
  let concreteResult: Type.Type
  switch (operation.result) {
    case 'Self':
    case 'OptionSelf':
      concreteResult = scalar.spelling
      break
    case 'Boolean':
      concreteResult = Scalar.boolean.spelling
      break
    case 'OptionTarget':
      concreteResult = Scalar.conversionTarget(operation.code)?.spelling ?? scalar.spelling
      break
    default:
      concreteResult = operation.result
      break
  }
  const checked = operation.result === 'OptionSelf' || operation.result === 'OptionTarget'
  const carrierOwner = {
    module: 'Intrinsic',
    name: `$${scalar.spelling}.${operation.spelling}`,
  }
  const carrierResult = Type.parameter(carrierOwner, 0, 'R')
  const result = checked ? 'R' : concreteResult
  const semanticResult = checked ? carrierResult : concreteResult
  const parameterNames = operation.arity === 1 ? ['value'] : ['left', 'right']
  const semanticParameters = operation.parameters ?? parameterNames.map(() => scalar.spelling)
  const borrowed = operation.code === 'LessThan'
  const contractParameters = borrowed
    ? semanticParameters.map((type) =>
        Type.reference('Shared', type, contractLifetime('contractParameters')),
      )
    : semanticParameters
  const carrierParameters = checked
    ? [
        valueParameter('present', `once fn(${concreteResult}) -> R`),
        valueParameter('absent', 'once fn() -> R'),
      ]
    : []
  const semanticCarrierParameters = checked
    ? [
        Type.callable(
          [concreteResult],
          carrierResult,
          { environment: contractLifetime('semanticCarrierParameters'), lifetimeBinders: [] },
          'Take',
        ),
        Type.callable(
          [],
          carrierResult,
          { environment: contractLifetime('semanticCarrierParameters'), lifetimeBinders: [] },
          'Take',
        ),
      ]
    : []
  return builtin({
    actor: scalar.spelling,
    name: operation.spelling,
    operation: operation.code,
    ...(checked
      ? {
          typeParameters: ['R'],
          semanticTypeParameters: [carrierResult],
        }
      : {}),
    parameters: [
      ...parameterNames.map((name, ordinal) => {
        const type = semanticParameters.at(ordinal) ?? scalar.spelling
        return valueParameter(name, borrowed ? `&${type}` : type)
      }),
      ...carrierParameters,
    ],
    semanticParameters: [...semanticParameters, ...semanticCarrierParameters],
    callParameters: [...contractParameters, ...semanticCarrierParameters],
    result,
    semanticResult: closedResult(semanticResult),
  })
}

const scalarOperations = (scalar: Scalar.Scalar): ReadonlyArray<Operation> =>
  scalar.operations.map((operation) => scalarOperation(scalar, operation))

const stringOperations = [
  {
    ...builtin({
      actor: 'string',
      name: 'fromUtf8Unchecked',
      operation: 'StringFromUtf8Unchecked',
      parameters: [valueParameter('bytes', '&[u8]')],
      semanticParameters: [byteSlice],
      result: 'string',
      semanticResult: closedResult(Type.string(byteSlice.lifetime)),
      unsafe: true,
    }),
    invariant:
      'bytes remain live and immutable for the returned view lifetime and contain complete valid UTF-8',
  },
  builtin({
    actor: 'string',
    name: 'utf8Bytes',
    operation: 'StringUtf8Bytes',
    parameters: [valueParameter('value', 'string')],
    semanticParameters: [Type.string(byteSlice.lifetime)],
    result: '&[u8]',
    semanticResult: closedResult(byteSlice),
  }),
  builtin({
    actor: 'string',
    name: 'byteLength',
    operation: 'StringByteLength',
    parameters: [valueParameter('value', 'string')],
    semanticParameters: [Type.string(contractLifetime('byteLength'))],
    result: 'usize',
    semanticResult: closedResult('usize'),
  }),
  builtin({
    actor: 'string',
    name: 'equalsExact',
    operation: 'StringEqualsExact',
    parameters: [valueParameter('left', 'string'), valueParameter('right', 'string')],
    semanticParameters: [
      Type.string(contractLifetime('equalsExact')),
      Type.string(contractLifetime('equalsExact')),
    ],
    result: 'bool',
    semanticResult: closedResult('bool'),
  }),
]

const stringActor = actor('string', 'Type', [])

const profileOperations: ReadonlyArray<Operation> = [
  ...[
    'targetArchitecture',
    'targetOperatingSystem',
    'targetAbi',
    'targetObjectFormat',
    'targetEndianness',
  ].map((name) => ({
    name,
    result: "string<'static>",
    type: Type.string(Lifetime.staticLifetime),
    arguments: [],
  })),
  ...['targetPointerBits', 'targetPointerAlignment'].map((name) => ({
    name,
    result: 'u32',
    type: 'u32' as const,
    arguments: [],
  })),
  {
    name: 'profileText',
    result: "string<'static>",
    type: Type.string(Lifetime.staticLifetime),
    arguments: ['key'],
  },
  { name: 'profileFlag', result: 'bool', type: 'bool' as const, arguments: ['key'] },
  { name: 'profileContains', result: 'bool', type: 'bool' as const, arguments: ['key', 'value'] },
].map((operation): Operation => ({
  _tag: 'IntrinsicOperation',
  id: operationId('Intrinsic', operation.name),
  spelling: operation.name,
  typeParameters: [],
  parameters: operation.arguments.map((name) => valueParameter(name, "string<'static>")),
  result: operation.result,
  unsafe: false,
  phase: 'StaticOnly',
  admission: 'Language',
  consumer: `silk/target.${operation.name}`,
  targets: [],
  rule: {
    _tag: 'StaticOnlyRule',
    contract: CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      parameters: operation.arguments.map(() => ({
        type: Type.string(Lifetime.staticLifetime),
        mode: 'Value',
      })),
      result: operation.type,
    }),
  },
}))

const staticTextOperation = (
  name: string,
  parameters: ReadonlyArray<ValueParameter>,
  semanticParameters: ReadonlyArray<Type.Type>,
  result: string,
  semanticResult: Type.Type,
): Operation => ({
  _tag: 'IntrinsicOperation',
  id: operationId('Intrinsic', name),
  spelling: name,
  typeParameters: [],
  parameters,
  result,
  unsafe: false,
  phase: 'StaticOnly',
  admission: 'Language',
  consumer: `silk/static_text.${name.replace('staticText', '').replace(/^./, (value) => value.toLowerCase())}`,
  targets: [],
  rule: {
    _tag: 'StaticOnlyRule',
    contract: CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      parameters: semanticParameters.map((type) => ({ type, mode: 'Value' as const })),
      result: semanticResult,
    }),
  },
})

const staticTextOperations = [
  staticTextOperation(
    'staticTextByteLength',
    [valueParameter('value', 'string')],
    [Type.string(contractLifetime('staticTextOperations'))],
    'usize',
    'usize',
  ),
  staticTextOperation(
    'staticTextByteAt',
    [valueParameter('value', 'string'), valueParameter('index', 'usize')],
    [Type.string(contractLifetime('staticTextOperations')), 'usize'],
    'u8',
    'u8',
  ),
  staticTextOperation(
    'staticTextConcat',
    [valueParameter('left', 'string'), valueParameter('right', 'string')],
    [
      Type.string(contractLifetime('staticTextOperations')),
      Type.string(contractLifetime('staticTextOperations')),
    ],
    'string',
    Type.string(Lifetime.staticLifetime),
  ),
  staticTextOperation(
    'staticTextSlice',
    [
      valueParameter('value', 'string'),
      valueParameter('start', 'usize'),
      valueParameter('end', 'usize'),
    ],
    [Type.string(contractLifetime('staticTextOperations')), 'usize', 'usize'],
    'string',
    Type.string(Lifetime.staticLifetime),
  ),
]

const staticGenericOperation = (input: {
  readonly name: string
  readonly typeParameters: ReadonlyArray<Type.Parameter>
  readonly parameters: ReadonlyArray<ValueParameter>
  readonly semanticParameters: ReadonlyArray<Type.Type>
  readonly result: string
  readonly semanticResult: Type.Type
  readonly consumer: string
}): Operation => ({
  _tag: 'IntrinsicOperation',
  id: operationId('Intrinsic', input.name),
  spelling: input.name,
  typeParameters: input.typeParameters.map((parameter) => typeParameter(parameter.name)),
  parameters: input.parameters,
  result: input.result,
  unsafe: false,
  phase: 'StaticOnly',
  admission: 'Language',
  consumer: input.consumer,
  targets: [],
  rule: {
    _tag: 'StaticOnlyRule',
    contract: CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      binders: input.typeParameters,
      parameters: input.semanticParameters.map((type) => ({ type, mode: 'Value' as const })),
      result: input.semanticResult,
    }),
  },
})

const reflectionOwner = Type.parameter({ module: 'Intrinsic', name: 'reflect' }, 0, 'Owner')
const reflectionValue = Type.parameter({ module: 'Intrinsic', name: 'reflect' }, 1, 'Value')
const projectionOwner = Type.parameter({ module: 'Intrinsic', name: 'borrowField' }, 0, 'Owner')
const projectionValue = Type.parameter({ module: 'Intrinsic', name: 'borrowField' }, 1, 'Value')
const sequenceElement = Type.parameter(
  { module: 'Intrinsic', name: 'staticSequence' },
  0,
  'Element',
)
const testCallable = Type.parameter({ module: 'Intrinsic', name: 'test' }, 0, 'F')

const reflectionOperations = [
  staticGenericOperation({
    name: 'reflectType',
    typeParameters: [reflectionOwner],
    parameters: [],
    semanticParameters: [],
    result: 'Type<Owner>',
    semanticResult: Type.typeDescriptor(reflectionOwner),
    consumer: 'silk/reflect.type',
  }),
  staticGenericOperation({
    name: 'reflectFields',
    typeParameters: [reflectionOwner],
    parameters: [],
    semanticParameters: [],
    result: 'Fields<Owner>',
    semanticResult: Type.fieldsDescriptor(reflectionOwner),
    consumer: 'silk/reflect.fields',
  }),
  staticGenericOperation({
    name: 'reflectTypeKind',
    typeParameters: [reflectionOwner],
    parameters: [valueParameter('descriptor', 'Type<Owner>')],
    semanticParameters: [Type.typeDescriptor(reflectionOwner)],
    result: 'u8',
    semanticResult: 'u8',
    consumer: 'silk/reflect.typeKind',
  }),
  staticGenericOperation({
    name: 'reflectFieldKind',
    typeParameters: [reflectionOwner, reflectionValue],
    parameters: [valueParameter('field', 'Field<Owner, Value>')],
    semanticParameters: [Type.fieldDescriptor(reflectionOwner, reflectionValue)],
    result: 'u8',
    semanticResult: 'u8',
    consumer: 'silk/reflect.fieldKind',
  }),
  staticGenericOperation({
    name: 'reflectFieldLabel',
    typeParameters: [reflectionOwner, reflectionValue],
    parameters: [valueParameter('field', 'Field<Owner, Value>')],
    semanticParameters: [Type.fieldDescriptor(reflectionOwner, reflectionValue)],
    result: 'string',
    semanticResult: Type.string(contractLifetime('reflectFieldLabel')),
    consumer: 'silk/reflect.fieldLabel',
  }),
  staticGenericOperation({
    name: 'reflectFieldOrdinal',
    typeParameters: [reflectionOwner, reflectionValue],
    parameters: [valueParameter('field', 'Field<Owner, Value>')],
    semanticParameters: [Type.fieldDescriptor(reflectionOwner, reflectionValue)],
    result: 'usize',
    semanticResult: 'usize',
    consumer: 'silk/reflect.fieldOrdinal',
  }),
]

const borrowFieldOperation: Operation = {
  _tag: 'IntrinsicOperation',
  id: operationId('Intrinsic', 'borrowField'),
  spelling: 'borrowField',
  typeParameters: [typeParameter('Owner'), typeParameter('Value')],
  parameters: [
    valueParameter('owner', '&Owner'),
    staticValueParameter('field', 'Field<Owner, Value>'),
  ],
  result: '&Value',
  unsafe: false,
  phase: 'Mixed',
  admission: 'Language',
  consumer: 'silk/reflect.borrowField',
  targets: [],

  rule: {
    _tag: 'MixedFieldProjectionRule',
    contract: CallableContract.make({
      environment: Lifetime.staticLifetime,
      lifetimeBinders: [],
      functionKind: 'Function',
      binders: [projectionOwner, projectionValue],
      parameters: [
        {
          type: Type.reference('Shared', projectionOwner, contractLifetime('borrowFieldOperation')),
          mode: 'Value',
        },
        {
          type: Type.fieldDescriptor(projectionOwner, projectionValue),
          mode: 'Value',
        },
      ],
      result: Type.reference('Shared', projectionValue, contractLifetime('borrowFieldOperation')),
    }),
    runtimeOwnerParameter: 0,
    staticDescriptorParameter: 1,
  },
}

const testOperations: ReadonlyArray<Operation> = [
  {
    _tag: 'IntrinsicOperation',
    id: operationId('Intrinsic', 'tests'),
    spelling: 'tests',
    typeParameters: [],
    parameters: [],
    result: 'Tests',
    unsafe: false,
    phase: 'StaticOnly',
    admission: 'Language',
    consumer: 'language:test-discovery',
    targets: [],
    rule: {
      _tag: 'StaticOnlyRule',
      contract: CallableContract.make({
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
        functionKind: 'Function',
        parameters: [],
        result: Type.testCatalog,
      }),
    },
  },
  staticGenericOperation({
    name: 'testInfo',
    typeParameters: [testCallable],
    parameters: [valueParameter('descriptor', 'Test<F>')],
    semanticParameters: [Type.testDescriptor(testCallable)],
    result: 'TestInfo',
    semanticResult: Type.testInfo,
    consumer: 'language:test-discovery',
  }),
  {
    _tag: 'IntrinsicOperation',
    id: operationId('Intrinsic', 'testFunction'),
    spelling: 'testFunction',
    typeParameters: [typeParameter('F')],
    parameters: [staticValueParameter('descriptor', 'Test<F>')],
    result: 'F',
    unsafe: false,
    phase: 'Mixed',
    admission: 'Language',
    consumer: 'language:test-discovery',
    targets: [],
    rule: {
      _tag: 'MixedTestFunctionRule',
      contract: CallableContract.make({
        environment: Lifetime.staticLifetime,
        lifetimeBinders: [],
        functionKind: 'Function',
        binders: [testCallable],
        parameters: [{ type: Type.testDescriptor(testCallable), mode: 'Value' as const }],
        result: testCallable,
      }),
      staticDescriptorParameter: 0,
    },
  },
]

const staticSequenceOperations = [
  staticGenericOperation({
    name: 'staticSequenceEmpty',
    typeParameters: [sequenceElement],
    parameters: [],
    semanticParameters: [],
    result: 'StaticSequence<Element>',
    semanticResult: Type.staticSequence(sequenceElement),
    consumer: 'silk/static_sequence.empty',
  }),
  staticGenericOperation({
    name: 'staticSequenceAppend',
    typeParameters: [sequenceElement],
    parameters: [
      valueParameter('self', 'StaticSequence<Element>'),
      valueParameter('value', 'Element'),
    ],
    semanticParameters: [Type.staticSequence(sequenceElement), sequenceElement],
    result: 'StaticSequence<Element>',
    semanticResult: Type.staticSequence(sequenceElement),
    consumer: 'silk/static_sequence.append',
  }),
  staticGenericOperation({
    name: 'staticSequenceConcat',
    typeParameters: [sequenceElement],
    parameters: [
      valueParameter('left', 'StaticSequence<Element>'),
      valueParameter('right', 'StaticSequence<Element>'),
    ],
    semanticParameters: [
      Type.staticSequence(sequenceElement),
      Type.staticSequence(sequenceElement),
    ],
    result: 'StaticSequence<Element>',
    semanticResult: Type.staticSequence(sequenceElement),
    consumer: 'silk/static_sequence.concat',
  }),
  staticGenericOperation({
    name: 'staticSequenceLength',
    typeParameters: [sequenceElement],
    parameters: [valueParameter('self', 'StaticSequence<Element>')],
    semanticParameters: [Type.staticSequence(sequenceElement)],
    result: 'usize',
    semanticResult: 'usize',
    consumer: 'silk/static_sequence.length',
  }),
  staticGenericOperation({
    name: 'staticSequenceAt',
    typeParameters: [sequenceElement],
    parameters: [
      valueParameter('self', 'StaticSequence<Element>'),
      valueParameter('index', 'usize'),
    ],
    semanticParameters: [Type.staticSequence(sequenceElement), 'usize'],
    result: 'Element',
    semanticResult: sequenceElement,
    consumer: 'silk/static_sequence.at',
  }),
]

const assemblyResult = Type.parameter({ module: 'Intrinsic', name: 'assembly' }, 0, 'Result')
const assemblyInputs = Type.parameter({ module: 'Intrinsic', name: 'assembly' }, 1, 'Inputs')
const assemblyParameters = [
  Type.string(Lifetime.staticLifetime),
  Type.string(Lifetime.staticLifetime),
  Type.string(Lifetime.staticLifetime),
  Type.string(Lifetime.staticLifetime),
  'bool',
  'bool',
  assemblyInputs,
] satisfies ReadonlyArray<Type.Type>
const assemblyOperation: BuiltinOperation = {
  _tag: 'IntrinsicOperation',
  id: operationId('Intrinsic', 'assembly'),
  spelling: 'assembly',
  typeParameters: [typeParameter('Result')],
  parameters: [
    staticValueParameter('template', 'string'),
    staticValueParameter('constraints', 'string'),
    staticValueParameter('clobbers', 'string'),
    staticValueParameter('memory', 'string'),
    staticValueParameter('sideEffects', 'bool'),
    staticValueParameter('noReturn', 'bool'),
    valueParameter('inputs', 'Inputs'),
  ],
  callParameters: assemblyParameters,
  result: 'Result',
  unsafe: true,
  phase: 'Mixed',
  admission: 'Platform',
  consumer: 'language:selected-native-machine-code',
  invariant:
    'caller proves machine effects, register and stack preservation, pointer validity, and absence of unwinding',
  targets: normalizeRuntimeTargets(['aarch64-unknown-linux-gnu', 'x86_64-unknown-linux-gnu']),
  rule: {
    _tag: 'BuiltinRule',
    operation: 'NativeAssembly',
    typeParameters: [assemblyResult],
    parameters: assemblyParameters,
    result: closedResult(assemblyResult),
    typeOutlives: [],
  },
}

const enumValueOperation: Operation = {
  _tag: 'IntrinsicOperation',
  id: operationId('Intrinsic', 'enumValue'),
  spelling: 'enumValue',
  typeParameters: [],
  parameters: [valueParameter('value', '<owning enum>')],
  result: '<owning enum representation>',
  unsafe: false,
  phase: 'Runtime',
  admission: 'Representation',
  consumer: 'language:scalar-enum-value',
  targets: runtimeTargets,
  rule: { _tag: 'EnumValueRule' },
}

const replaceOperation: Operation = {
  _tag: 'IntrinsicOperation',
  id: operationId('Intrinsic', 'replace'),
  spelling: 'replace',
  typeParameters: [typeParameter('T')],
  parameters: [valueParameter('place', '&mut T'), valueParameter('value', 'T')],
  result: 'T',
  unsafe: false,
  phase: 'Runtime',
  admission: admission('Place'),
  consumer: consumer('Place', 'replace'),
  targets: runtimeTargets,
  rule: { _tag: 'PlaceRule', operation: 'Replace' },
}

const intrinsicOperations = [
  ...Scalar.all().flatMap(scalarOperations),
  ...stringOperations,
  builtin({
    actor: 'Slice',
    name: 'view',
    operation: 'SliceView',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [
      valueParameter('values', '&[T]'),
      valueParameter('offset', 'usize'),
      valueParameter('length', 'usize'),
    ],
    semanticParameters: [
      Type.slice('Shared', rawElement, contractLifetime('sliceView')),
      'usize',
      'usize',
    ],
    result: '&[T]',
    semanticResult: closedResult(Type.slice('Shared', rawElement, contractLifetime('sliceView'))),
  }),
  builtin({
    actor: 'Layout',
    name: 'of',
    operation: 'LayoutOf',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [],
    semanticParameters: [],
    result: 'Layout',
    semanticResult: closedResult(Type.layout),
  }),
  builtin({
    actor: 'Execution',
    name: 'layout',
    operation: 'ExecutionLayout',
    typeParameters: ['A', 'F', 'O', 'R'],
    semanticTypeParameters: executionPackageTypeParameters,
    parameters: [],
    semanticParameters: [],
    result: 'Layout',
    semanticResult: closedResult(Type.layout),
  }),
  builtin({
    actor: 'Execution',
    name: 'fromAllocation',
    operation: 'ExecutionFromAllocation',
    typeParameters: ['A', 'F', 'O', 'R'],
    semanticTypeParameters: executionPackageTypeParameters,
    parameters: [
      valueParameter('allocation', 'Allocation'),
      valueParameter('body', 'F'),
      valueParameter('readyState', 'O'),
      valueParameter('onReady', 'R'),
    ],
    semanticParameters: [
      Type.allocation,
      representedExecutionBody,
      executionEndpoint,
      representedExecutionReady,
    ],
    result: 'Execution<A>',
    semanticResult: closedResult(Type.execution(executionResult)),
    unsafe: true,
  }),
  builtin({
    actor: 'Execution',
    name: 'drive',
    operation: 'ExecutionDrive',
    typeParameters: ['A', 'D', 'C', 'S'],
    semanticTypeParameters: executionDriveTypeParameters,
    parameters: [
      valueParameter('execution', 'Execution<A>'),
      valueParameter('branchState', 'D'),
      valueParameter('onComplete', 'C'),
      valueParameter('onSuspend', 'S'),
    ],
    semanticParameters: [
      Type.execution(drivenResult),
      driveBranch,
      representedCompletion,
      representedSuspension,
    ],
    result: 'Effect<()>',
    semanticResult: closedResult(
      Type.effect(
        Type.unit,
        [],
        { environment: contractLifetime('drive'), lifetimeBinders: [] },
        'Take',
      ),
    ),
  }),
  builtin({
    actor: 'Execution',
    name: 'relinquish',
    operation: 'ExecutionRelinquish',
    parameters: [],
    semanticParameters: [],
    result: 'Effect<()>',
    semanticResult: closedResult(
      Type.effect(
        Type.unit,
        [],
        { environment: contractLifetime('relinquish'), lifetimeBinders: [] },
        'Take',
      ),
    ),
  }),
  builtin({
    actor: 'Execution',
    name: 'current',
    operation: 'ExecutionCurrent',
    parameters: [],
    semanticParameters: [],
    result: 'Effect<ExecutionRef>',
    semanticResult: closedResult(
      Type.effect(
        Type.executionRef,
        [],
        { environment: contractLifetime('current'), lifetimeBinders: [] },
        'Take',
      ),
    ),
  }),
  builtin({
    actor: 'Execution',
    name: 'refOf',
    operation: 'ExecutionRefOf',
    typeParameters: ['A'],
    semanticTypeParameters: [referencedResult],
    parameters: [valueParameter('execution', '&Execution<A>')],
    semanticParameters: [
      Type.reference('Shared', Type.execution(referencedResult), contractLifetime('refOf')),
    ],
    result: 'ExecutionRef',
    semanticResult: closedResult(Type.executionRef),
  }),
  builtin({
    actor: 'Execution',
    name: 'load',
    operation: 'ExecutionLoad',
    parameters: [valueParameter('reference', '&ExecutionRef'), valueParameter('word', 'usize')],
    semanticParameters: [sharedExecutionRef('load'), 'usize'],
    result: 'usize',
    semanticResult: closedResult('usize'),
  }),
  builtin({
    actor: 'Execution',
    name: 'store',
    operation: 'ExecutionStore',
    parameters: [
      valueParameter('reference', '&ExecutionRef'),
      valueParameter('word', 'usize'),
      valueParameter('value', 'usize'),
    ],
    semanticParameters: [sharedExecutionRef('store'), 'usize', 'usize'],
    result: '()',
    semanticResult: closedResult(Type.unit),
  }),
  builtin({
    actor: 'Execution',
    name: 'notify',
    operation: 'ExecutionNotify',
    parameters: [valueParameter('reference', '&ExecutionRef')],
    semanticParameters: [sharedExecutionRef('notify')],
    result: '()',
    semanticResult: closedResult(Type.unit),
  }),
  builtin({
    actor: 'Execution',
    name: 'live',
    operation: 'ExecutionLive',
    parameters: [valueParameter('reference', '&ExecutionRef')],
    semanticParameters: [sharedExecutionRef('live')],
    result: 'bool',
    semanticResult: closedResult('bool'),
  }),
  builtin({
    actor: 'Shared',
    name: 'layout',
    operation: 'SharedLayout',
    typeParameters: ['T'],
    semanticTypeParameters: sharedTypeParameters,
    parameters: [],
    semanticParameters: [],
    result: 'Layout',
    semanticResult: closedResult(Type.layout),
  }),
  builtin({
    actor: 'Shared',
    name: 'fromAllocation',
    operation: 'SharedFromAllocation',
    typeParameters: ['T'],
    semanticTypeParameters: sharedTypeParameters,
    parameters: [valueParameter('allocation', 'Allocation'), valueParameter('value', 'T')],
    semanticParameters: [Type.allocation, sharedElement],
    result: 'SharedCore<T>',
    semanticResult: closedResult(Type.sharedCore(sharedElement)),
    unsafe: true,
  }),
  builtin({
    actor: 'Shared',
    name: 'clone',
    operation: 'SharedClone',
    typeParameters: ['T'],
    semanticTypeParameters: sharedTypeParameters,
    parameters: [valueParameter('self', '&SharedCore<T>')],
    semanticParameters: [
      Type.reference('Shared', Type.sharedCore(sharedElement), contractLifetime('clone')),
    ],
    result: 'SharedCore<T>',
    semanticResult: closedResult(Type.sharedCore(sharedElement)),
  }),
  builtin({
    actor: 'Shared',
    name: 'withMut',
    operation: 'SharedWithMut',
    typeParameters: ['T', 'A'],
    semanticTypeParameters: sharedLifecycleTypeParameters,
    parameters: [
      valueParameter('self', '&SharedCore<T>'),
      valueParameter('use', 'once fn(&mut T) -> A'),
      valueParameter('onConflict', 'once fn() -> A'),
    ],
    semanticParameters: [
      Type.reference('Shared', Type.sharedCore(sharedElement), contractLifetime('withMut')),
      Type.callable(
        [Type.reference('Exclusive', sharedElement, sharedAccessLifetime)],
        sharedResult,
        { environment: contractLifetime('withMut'), lifetimeBinders: [sharedAccessLifetime] },
        'Take',
      ),
      Type.callable(
        [],
        sharedResult,
        { environment: contractLifetime('withMut'), lifetimeBinders: [] },
        'Take',
      ),
    ],
    result: 'A',
    semanticResult: closedResult(sharedResult),
  }),
  builtin({
    actor: 'Storage',
    name: 'acquire',
    operation: 'StorageAcquire',
    parameters: [valueParameter('layout', 'Layout')],
    semanticParameters: [Type.layout],
    result: 'Effect<Allocation ! Intrinsic.StorageFailure>',
    semanticResult: closedResult(
      Type.effect(
        Type.allocation,
        [Type.storageFailure],
        { environment: contractLifetime('acquire'), lifetimeBinders: [] },
        undefined,
        [],
      ),
    ),
  }),
  builtin({
    actor: 'RawBuffer',
    name: 'from',
    operation: 'RawBufferFrom',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('allocation', 'Allocation'), valueParameter('count', 'usize')],
    semanticParameters: [Type.allocation, 'usize'],
    result: 'RawBuffer<T>',
    semanticResult: closedResult(Type.rawBuffer(rawElement)),
    unsafe: true,
  }),
  builtin({
    actor: 'RawBuffer',
    name: 'view',
    operation: 'RawBufferView',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [
      valueParameter('buffer', '&RawBuffer<T>'),
      valueParameter('offset', 'usize'),
      valueParameter('length', 'usize'),
    ],
    semanticParameters: [
      Type.reference('Shared', Type.rawBuffer(rawElement), contractLifetime('view')),
      'usize',
      'usize',
    ],
    result: '&[T]',
    semanticResult: closedResult(Type.slice('Shared', rawElement, contractLifetime('view'))),
    unsafe: true,
  }),
  builtin({
    actor: 'RawBuffer',
    name: 'viewMut',
    operation: 'RawBufferViewMut',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [
      valueParameter('buffer', '&mut RawBuffer<T>'),
      valueParameter('offset', 'usize'),
      valueParameter('length', 'usize'),
    ],
    semanticParameters: [
      Type.reference('Exclusive', Type.rawBuffer(rawElement), contractLifetime('viewMut')),
      'usize',
      'usize',
    ],
    result: '&mut [T]',
    semanticResult: closedResult(Type.slice('Exclusive', rawElement, contractLifetime('viewMut'))),
    unsafe: true,
  }),
  builtin({
    actor: 'RawBuffer',
    name: 'slot',
    operation: 'RawBufferSlot',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('buffer', '&mut RawBuffer<T>'), valueParameter('index', 'usize')],
    semanticParameters: [
      Type.reference('Exclusive', Type.rawBuffer(rawElement), contractLifetime('slot')),
      'usize',
    ],
    result: 'Slot<T>',
    semanticResult: closedResult(Type.slot(rawElement, contractLifetime('slot'))),
    unsafe: true,
  }),
  builtin({
    actor: 'RawBuffer',
    name: 'count',
    operation: 'RawBufferCount',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('buffer', '&RawBuffer<T>')],
    semanticParameters: [
      Type.reference('Shared', Type.rawBuffer(rawElement), contractLifetime('count')),
    ],
    result: 'usize',
    semanticResult: closedResult('usize'),
  }),
  builtin({
    actor: 'RawBuffer',
    name: 'read',
    operation: 'RawBufferRead',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('buffer', '&RawBuffer<T>'), valueParameter('index', 'usize')],
    semanticParameters: [
      Type.reference('Shared', Type.rawBuffer(rawElement), contractLifetime('read')),
      'usize',
    ],
    result: 'T',
    semanticResult: closedResult(rawElement),
    unsafe: true,
  }),
  builtin({
    actor: 'RawBuffer',
    name: 'copy',
    operation: 'RawBufferCopy',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [
      valueParameter('destination', '&mut RawBuffer<T>'),
      valueParameter('destinationOffset', 'usize'),
      valueParameter('source', '&[T]'),
      valueParameter('length', 'usize'),
    ],
    semanticParameters: [
      Type.reference('Exclusive', Type.rawBuffer(rawElement), contractLifetime('copy')),
      'usize',
      Type.slice('Shared', rawElement, contractLifetime('copy')),
      'usize',
    ],
    result: '()',
    semanticResult: closedResult(Type.unit),
    unsafe: true,
  }),
  builtin({
    actor: 'RawBuffer',
    name: 'fill',
    operation: 'RawBufferFill',
    parameters: [
      valueParameter('buffer', '&mut RawBuffer<u8>'),
      valueParameter('offset', 'usize'),
      valueParameter('length', 'usize'),
      valueParameter('value', 'u8'),
    ],
    semanticParameters: [
      Type.reference('Exclusive', Type.rawBuffer('u8'), contractLifetime('fill')),
      'usize',
      'usize',
      'u8',
    ],
    result: '()',
    semanticResult: closedResult(Type.unit),
    unsafe: true,
  }),
  builtin({
    actor: 'Pointer',
    name: 'bytes',
    operation: 'PointerBytes',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('pointer', '?*const T')],
    semanticParameters: [
      Type.pointer({
        mutable: false,
        pointee: rawElement,
        nullable: true,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ],
    result: '?[*]const u8',
    semanticResult: closedResult(
      Type.pointer({
        mutable: false,
        pointee: 'u8',
        nullable: true,
        extent: 'Many',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
    unsafe: true,
  }),
  builtin({
    actor: 'Pointer',
    name: 'requalify',
    operation: 'PointerRequalify',
    typeParameters: ['From', 'To'],
    semanticTypeParameters: [pointerSource, pointerDestination],
    parameters: [valueParameter('pointer', 'From')],
    semanticParameters: [pointerSource],
    result: 'To',
    semanticResult: closedResult(pointerDestination),
    unsafe: true,
  }),
  builtin({
    actor: 'Pointer',
    name: 'reinterpret',
    operation: 'PointerReinterpret',
    typeParameters: ['From', 'To'],
    semanticTypeParameters: [pointerSource, pointerDestination],
    parameters: [valueParameter('pointer', 'From')],
    semanticParameters: [pointerSource],
    result: 'To',
    semanticResult: closedResult(pointerDestination),
    unsafe: true,
  }),
  builtin({
    actor: 'Slot',
    name: 'address',
    operation: 'SlotAddress',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('slot', 'Slot<T>')],
    semanticParameters: [Type.slot(rawElement, contractLifetime('slotAccess'))],
    result: '*mut T',
    semanticResult: closedResult(
      Type.pointer({
        mutable: true,
        pointee: rawElement,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
  }),
  builtin({
    actor: 'Pointer',
    name: 'readUnaligned',
    operation: 'PointerReadUnaligned',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('pointer', '*const align(1) T')],
    semanticParameters: [
      Type.pointer({
        mutable: false,
        pointee: pointerElement,
        nullable: false,
        extent: 'Single',
        alignment: 1,
        addressSpace: 0,
      }),
    ],
    result: 'T',
    semanticResult: closedResult(pointerElement),
    unsafe: true,
  }),
  builtin({
    actor: 'Pointer',
    name: 'writeUnaligned',
    operation: 'PointerWriteUnaligned',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('pointer', '*mut align(1) T'), valueParameter('value', 'T')],
    semanticParameters: [
      Type.pointer({
        mutable: true,
        pointee: pointerElement,
        nullable: false,
        extent: 'Single',
        alignment: 1,
        addressSpace: 0,
      }),
      pointerElement,
    ],
    result: '()',
    semanticResult: closedResult(Type.unit),
    unsafe: true,
  }),
  builtin({
    actor: 'Pointer',
    name: 'null',
    operation: 'PointerNull',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [],
    semanticParameters: [],
    result: '?*mut T',
    semanticResult: closedResult(
      Type.pointer({
        mutable: true,
        pointee: pointerElement,
        nullable: true,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
  }),
  builtin({
    actor: 'Pointer',
    name: 'isNull',
    operation: 'PointerIsNull',
    typeParameters: ['P'],
    semanticTypeParameters: [pointerSource],
    parameters: [valueParameter('pointer', 'P')],
    semanticParameters: [pointerSource],
    result: 'bool',
    semanticResult: closedResult('bool'),
  }),
  builtin({
    actor: 'Pointer',
    name: 'address',
    operation: 'PointerAddress',
    typeParameters: ['P'],
    semanticTypeParameters: [pointerSource],
    parameters: [valueParameter('pointer', 'P')],
    semanticParameters: [pointerSource],
    result: 'usize',
    semanticResult: closedResult('usize'),
  }),
  builtin({
    actor: 'Pointer',
    name: 'fromRef',
    operation: 'PointerFromRef',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('value', '&T')],
    semanticParameters: [Type.reference('Shared', pointerElement, contractLifetime('fromRef'))],
    result: '*const T',
    semanticResult: closedResult(
      Type.pointer({
        mutable: false,
        pointee: pointerElement,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
  }),
  builtin({
    actor: 'Pointer',
    name: 'fromMutRef',
    operation: 'PointerFromMutRef',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('value', '&mut T')],
    semanticParameters: [
      Type.reference('Exclusive', pointerElement, contractLifetime('fromMutRef')),
    ],
    result: '*mut T',
    semanticResult: closedResult(
      Type.pointer({
        mutable: true,
        pointee: pointerElement,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
  }),
  builtin({
    actor: 'Pointer',
    name: 'fromSlice',
    operation: 'PointerFromSlice',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('values', '&[T]')],
    semanticParameters: [Type.slice('Shared', pointerElement, contractLifetime('fromSlice'))],
    result: '?[*]const T',
    semanticResult: closedResult(
      Type.pointer({
        mutable: false,
        pointee: pointerElement,
        nullable: true,
        extent: 'Many',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
  }),
  builtin({
    actor: 'Pointer',
    name: 'fromMutSlice',
    operation: 'PointerFromMutSlice',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('values', '&mut [T]')],
    semanticParameters: [Type.slice('Exclusive', pointerElement, contractLifetime('fromMutSlice'))],
    result: '?[*]mut T',
    semanticResult: closedResult(
      Type.pointer({
        mutable: true,
        pointee: pointerElement,
        nullable: true,
        extent: 'Many',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
  }),
  builtin({
    actor: 'Pointer',
    name: 'at',
    operation: 'PointerAt',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('pointer', '[*]const T'), valueParameter('count', 'usize')],
    semanticParameters: [
      Type.pointer({
        mutable: false,
        pointee: pointerElement,
        nullable: false,
        extent: 'Many',
        alignment: 'Natural',
        addressSpace: 0,
      }),
      'usize',
    ],
    result: '*const T',
    semanticResult: closedResult(
      Type.pointer({
        mutable: false,
        pointee: pointerElement,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
    unsafe: true,
  }),
  builtin({
    actor: 'Pointer',
    name: 'atMut',
    operation: 'PointerAtMut',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('pointer', '[*]mut T'), valueParameter('count', 'usize')],
    semanticParameters: [
      Type.pointer({
        mutable: true,
        pointee: pointerElement,
        nullable: false,
        extent: 'Many',
        alignment: 'Natural',
        addressSpace: 0,
      }),
      'usize',
    ],
    result: '*mut T',
    semanticResult: closedResult(
      Type.pointer({
        mutable: true,
        pointee: pointerElement,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ),
    unsafe: true,
  }),
  builtin({
    actor: 'Pointer',
    name: 'read',
    operation: 'PointerRead',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('pointer', '*const T')],
    semanticParameters: [
      Type.pointer({
        mutable: false,
        pointee: pointerElement,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
    ],
    result: 'T',
    semanticResult: closedResult(pointerElement),
    unsafe: true,
  }),
  builtin({
    actor: 'Pointer',
    name: 'write',
    operation: 'PointerWrite',
    typeParameters: ['T'],
    semanticTypeParameters: pointerTypeParameters,
    parameters: [valueParameter('pointer', '*mut T'), valueParameter('value', 'T')],
    semanticParameters: [
      Type.pointer({
        mutable: true,
        pointee: pointerElement,
        nullable: false,
        extent: 'Single',
        alignment: 'Natural',
        addressSpace: 0,
      }),
      pointerElement,
    ],
    result: '()',
    semanticResult: closedResult(Type.unit),
    unsafe: true,
  }),
  builtin({
    actor: 'Slot',
    name: 'write',
    operation: 'SlotWrite',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('slot', 'Slot<T>'), valueParameter('value', 'T')],
    semanticParameters: [Type.slot(rawElement, contractLifetime('slotAccess')), rawElement],
    result: '()',
    semanticResult: closedResult(Type.unit),
    unsafe: true,
  }),
  builtin({
    actor: 'Slot',
    name: 'take',
    operation: 'SlotTake',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('slot', 'Slot<T>')],
    semanticParameters: [Type.slot(rawElement, contractLifetime('slotAccess'))],
    result: 'T',
    semanticResult: closedResult(rawElement),
    unsafe: true,
  }),
  builtin({
    actor: 'Slot',
    name: 'copy',
    operation: 'SlotCopy',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('slot', 'Slot<T>')],
    semanticParameters: [Type.slot(rawElement, contractLifetime('slotAccess'))],
    result: 'T',
    semanticResult: closedResult(rawElement),
    unsafe: true,
  }),
  builtin({
    actor: 'Slot',
    name: 'drop',
    operation: 'SlotDrop',
    typeParameters: ['T'],
    semanticTypeParameters: rawTypeParameters,
    parameters: [valueParameter('slot', 'Slot<T>')],
    semanticParameters: [Type.slot(rawElement, contractLifetime('slotAccess'))],
    result: '()',
    semanticResult: closedResult(Type.unit),
    unsafe: true,
  }),
  builtin({
    actor: 'Effect',
    name: 'finalizeEffect',
    operation: 'EffectFinalize',
    typeParameters: ['A', 'E', '?R', '?S'],
    semanticTypeParameters: [
      finalizationSuccess,
      finalizationFailure,
      finalizationProtectedRequirements,
      finalizationFinalizerRequirements,
    ],
    parameters: [
      valueParameter('protected', 'once Effect<A ! E ? R>'),
      valueParameter('finalizer', 'once Effect<() ? S>'),
    ],
    semanticParameters: [
      Type.effectWithRows(
        finalizationSuccess,
        finalizationFailureRow,
        finalizationEnvironment,
        'Take',
        finalizationProtectedRow,
      ),
      Type.effectWithRows(
        Type.unit,
        RowAlgebra.concrete(Type.failureRowPolicy(), []),
        finalizationEnvironment,
        'Take',
        finalizationFinalizerRow,
      ),
    ],
    result: 'once Effect<A ! E ? R | S>',
    semanticResult: closedResult(
      Type.effectWithRows(
        finalizationSuccess,
        finalizationFailureRow,
        finalizationEnvironment,
        'Take',
        RowAlgebra.union(
          Type.requirementRowPolicy(),
          finalizationProtectedRow,
          finalizationFinalizerRow,
        ),
      ),
    ),
  }),
  builtin({
    actor: 'Effect',
    name: 'finalizeEffectNonParking',
    operation: 'EffectFinalizeNonParking',
    typeParameters: ['A', 'E', '?R', '?S'],
    semanticTypeParameters: [
      nonParkingFinalizationSuccess,
      nonParkingFinalizationFailure,
      nonParkingFinalizationProtectedRequirements,
      nonParkingFinalizationFinalizerRequirements,
    ],
    parameters: [
      valueParameter('protected', 'once Effect<A ! E ? R>'),
      valueParameter('finalizer', 'once Effect<() ? S>'),
    ],
    semanticParameters: [
      Type.effectWithRows(
        nonParkingFinalizationSuccess,
        nonParkingFinalizationFailureRow,
        nonParkingFinalizationEnvironment,
        'Take',
        nonParkingFinalizationProtectedRow,
      ),
      Type.effectWithRows(
        Type.unit,
        RowAlgebra.concrete(Type.failureRowPolicy(), []),
        nonParkingFinalizationEnvironment,
        'Take',
        nonParkingFinalizationFinalizerRow,
      ),
    ],
    result: 'once Effect<A ! E ? R | S>',
    semanticResult: closedResult(
      Type.effectWithRows(
        nonParkingFinalizationSuccess,
        nonParkingFinalizationFailureRow,
        nonParkingFinalizationEnvironment,
        'Take',
        RowAlgebra.union(
          Type.requirementRowPolicy(),
          nonParkingFinalizationProtectedRow,
          nonParkingFinalizationFinalizerRow,
        ),
      ),
    ),
  }),
  builtin({
    actor: 'Effect',
    name: 'useReleaseNonParking',
    operation: 'EffectUseReleaseNonParking',
    typeParameters: ['Resource', 'A', 'E', '?R', '?S'],
    semanticTypeParameters: [
      nonParkingResource,
      nonParkingResourceSuccess,
      nonParkingResourceFailure,
      nonParkingResourceUseRequirements,
      nonParkingResourceReleaseRequirements,
    ],
    parameters: [
      valueParameter('resource', 'Resource'),
      valueParameter(
        'use',
        "for<'scope> once fn<'env>(&'scope mut Resource) -> once Effect<'scope & 'env; A ! E ? R>",
      ),
      valueParameter(
        'release',
        "for<'scope> once fn<'env>(&'scope mut Resource) -> once Effect<'scope & 'env; () ? S>",
      ),
    ],
    semanticParameters: [nonParkingResource, nonParkingResourceUse, nonParkingResourceRelease],
    result: 'once Effect<A ! E ? R | S>',
    semanticResult: closedResult(
      Type.effectWithRows(
        nonParkingResourceSuccess,
        nonParkingResourceFailureRow,
        { environment: nonParkingResourceEnvironment, lifetimeBinders: [] },
        'Take',
        RowAlgebra.union(
          Type.requirementRowPolicy(),
          nonParkingResourceUseRow,
          nonParkingResourceReleaseRow,
        ),
      ),
    ),
  }),
  builtin({
    actor: 'Effect',
    name: 'observeDiagnostics',
    operation: 'EffectObserveDiagnostics',
    typeParameters: ['S', 'A', '?R', 'F'],
    semanticTypeParameters: [
      observationState,
      observationSuccess,
      observationRequirement,
      observationCallback,
    ],
    parameters: [
      valueParameter('state', 'S'),
      valueParameter('observer', 'F'),
      valueParameter('protected', 'once Effect<A ? R>'),
    ],
    semanticParameters: [
      observationState,
      Type.represented(
        observationCallbackBound,
        observationCallbackBound,
        Type.representationParameterArgument(observationCallback),
      ),
      observedEffect,
    ],
    result: 'once Effect<A ? R>',
    semanticResult: closedResult(observedEffect),
    // The observation stores its state for the whole returned Effect.
    typeOutlives: [{ type: observationState, lifetime: observationEnvironment }],
  }),
  builtin({
    actor: 'Effect',
    name: 'observeUnhandled',
    operation: 'EffectObserveUnhandled',
    typeParameters: [],
    semanticTypeParameters: [],
    parameters: [],
    semanticParameters: [],
    result: 'usize',
    semanticResult: closedResult('usize'),
  }),
  builtin({
    actor: 'Effect',
    name: 'suspendEffect',
    operation: 'EffectSuspend',
    typeParameters: ['A', 'E', '?R'],
    semanticTypeParameters: suspensionTypeParameters,
    parameters: [valueParameter('deferred', 'once Effect<A ! E ? R>')],
    semanticParameters: [
      Type.effectWithRows(
        suspensionSuccess,
        suspensionFailureRow,
        { environment: contractLifetime('suspendEffect'), lifetimeBinders: [] },
        'Take',
        suspensionRequirementRow,
      ),
    ],
    result: 'Effect<A ! E ? R>',
    semanticResult: closedResult(
      Type.effectWithRows(
        suspensionSuccess,
        suspensionFailureRow,
        { environment: contractLifetime('suspendEffect'), lifetimeBinders: [] },
        'Take',
        suspensionRequirementRow,
      ),
    ),
  }),
  contractEffect({
    name: 'bindRequirement',
    post: 'BindRequirement',
    providerMode: 'Shared',
    typeParameters: ['?S', 'A', 'P', 'E', '?R'],
    parameters: [
      valueParameter('protected', 'once Effect<A ! E ? R>'),
      valueParameter('provider', '&P'),
    ],
    result: 'Effect<A ! E ? Without<R, S>>',
    contract: bindingContract('Shared'),
  }),
  contractEffect({
    name: 'bindRequirementMut',
    post: 'BindRequirement',
    providerMode: 'Exclusive',
    typeParameters: ['?S', 'A', 'P', 'E', '?R'],
    parameters: [
      valueParameter('protected', 'once Effect<A ! E ? R>'),
      valueParameter('provider', '&mut P'),
    ],
    result: 'Effect<A ! E ? Without<R, S>>',
    contract: bindingContract('Exclusive'),
  }),
  contractEffect({
    name: 'bindRequirementOwned',
    post: 'BindRequirement',
    providerMode: 'Take',
    typeParameters: ['?S', 'A', 'P', 'E', '?R'],
    parameters: [
      valueParameter('protected', 'once Effect<A ! E ? R>'),
      valueParameter('provider', 'P'),
    ],
    result: 'Effect<A ! E ? Without<R, S>>',
    contract: bindingContract('Take'),
  }),
  contractEffect({
    name: 'catchFailure',
    post: 'CatchFailure',
    typeParameters: ['S', 'A', 'B', 'E', 'F', '?R', '?Q'],
    parameters: [
      valueParameter('protected', 'once Effect<A ! E ? R>'),
      valueParameter(
        'handler',
        "for<use 'call> once fn<'env>(S) -> once Effect<'call & 'env; B ! F ? Q>",
      ),
    ],
    result: 'Effect<A | B ! Without<E, S> | F ? R | Q>',
    contract: catchContract,
  }),
  ...profileOperations,
  ...staticTextOperations,
  ...reflectionOperations,
  borrowFieldOperation,
  ...testOperations,
  ...staticSequenceOperations,
  assemblyOperation,
  enumValueOperation,
  replaceOperation,
]

const operations = [stringActor, actor('Intrinsic', 'Namespace', intrinsicOperations)]

const actorsBySpelling: ReadonlyMap<string, Actor> = new Map(
  operations.map((actor_): readonly [string, Actor] => [actor_.spelling, actor_]),
)

const operationsByActorSpelling: ReadonlyMap<string, ReadonlyMap<string, Operation>> = new Map(
  operations.map((actor_): readonly [string, ReadonlyMap<string, Operation>] => [
    actor_.spelling,
    new Map(
      actor_.operations.map((operation): readonly [string, Operation] => [
        operation.spelling,
        operation,
      ]),
    ),
  ]),
)

const operationsById: ReadonlyMap<string, ReadonlyMap<string, Operation>> = (() => {
  const actors = new Map<string, Map<string, Operation>>()
  for (const operation of intrinsicOperations) {
    const actor = actors.get(operation.id.actor)
    if (actor === undefined)
      actors.set(operation.id.actor, new Map([[operation.id.name, operation]]))
    else actor.set(operation.id.name, operation)
  }
  return actors
})()

/** Every intrinsic actor in stable presentation and completion order. */
export const all = (): ReadonlyArray<Actor> => operations

/** Finds an intrinsic actor by its accepted source spelling. */
export const findActor = (spelling: string): Actor | undefined => actorsBySpelling.get(spelling)

/** Finds an intrinsic operation by actor and member source spelling. */
export const findOperation = (actor_: string, spelling: string): Operation | undefined =>
  operationsByActorSpelling.get(actor_)?.get(spelling) ??
  (Scalar.isSpelling(actor_)
    ? operationsByActorSpelling.get('Intrinsic')?.get(`${actor_}${upperInitial(spelling)}`)
    : undefined)

/** Finds one sealed operation by its canonical compiler identity. */
export const findOperationById = (id: OperationId): Operation | undefined =>
  operationsById.get(id.actor)?.get(id.name)

/** Stable textual form of one sealed operation identity. */
export const operationText = (id: OperationId): string => `${id.actor}.${id.name}`

/** One deterministic audit record spanning source identity and execution surfaces. */
export interface InventoryEntry {
  readonly operation: string
  readonly signature: string
  readonly unsafe: boolean
  readonly phase: Phase
  readonly invariant?: string
  readonly admission: AdmissionCategory
  readonly consumer: string
  readonly tir?: string
  readonly mir?: string
  readonly targets: ReadonlyArray<Target.Id>
}

/** Publishes the closed intrinsic inventory used by verification and release review. */
export const inventory = (): ReadonlyArray<InventoryEntry> =>
  intrinsicOperations.map((operation) => {
    if (operation.admission === undefined || operation.consumer === undefined)
      throw new RangeError(`Intrinsic ${operation.spelling} is missing admission metadata`)
    if (operation.phase === 'Runtime' && operation.targets.length === 0)
      throw new RangeError(`Runtime intrinsic ${operation.spelling} has no execution target`)
    if (operation.phase === 'StaticOnly' && operation.targets.length !== 0)
      throw new RangeError(`Non-runtime intrinsic ${operation.spelling} has a runtime target`)
    const staticParameters = operation.parameters.flatMap((parameter, ordinal) =>
      parameter.phase === 'Static' ? [ordinal] : [],
    )
    if (
      operation.phase === 'Mixed' &&
      operation.rule._tag === 'BuiltinRule' &&
      operation.rule.operation === 'NativeAssembly'
    ) {
      if (
        staticParameters.length !== 6 ||
        staticParameters.some((ordinal, index) => ordinal !== index) ||
        operation.parameters.length !== 7
      )
        throw new RangeError('Assembly metadata lanes are invalid')
    } else if (operation.phase === 'Mixed' && operation.rule._tag === 'MixedFieldProjectionRule') {
      if (
        operation.rule._tag !== 'MixedFieldProjectionRule' ||
        staticParameters.length !== 1 ||
        staticParameters.at(0) !== operation.rule.staticDescriptorParameter ||
        operation.parameters.at(operation.rule.runtimeOwnerParameter)?.phase === 'Static'
      )
        throw new RangeError(`Mixed intrinsic ${operation.spelling} has an invalid calling shape`)
    } else if (operation.phase === 'Mixed') {
      if (
        operation.rule._tag !== 'MixedTestFunctionRule' ||
        staticParameters.length !== 1 ||
        staticParameters.at(0) !== operation.rule.staticDescriptorParameter
      )
        throw new RangeError(`Mixed intrinsic ${operation.spelling} has an invalid calling shape`)
    } else if (staticParameters.length !== 0) {
      throw new RangeError(`Whole-phase intrinsic ${operation.spelling} declares a static lane`)
    }
    const normalizedTargets = normalizeRuntimeTargets(operation.targets)
    if (
      normalizedTargets.length !== operation.targets.length ||
      normalizedTargets.some((target, index) => operation.targets.at(index) !== target)
    )
      throw new RangeError(`Intrinsic ${operation.spelling} has non-normalized target metadata`)
    let identity: string | undefined
    switch (operation.rule._tag) {
      case 'BuiltinRule':
        identity = operation.rule.operation
        break
      case 'ContractRule':
        identity = `${operation.rule._tag}.${operation.rule.post}`
        break
      case 'EnumValueRule':
        identity = operation.rule._tag
        break
      case 'StaticOnlyRule':
      case 'MixedFieldProjectionRule':
      case 'MixedTestFunctionRule':
        identity = undefined
        break
      default:
        identity = `${operation.rule._tag}.${operation.rule.operation}`
        break
    }
    return {
      operation: `Intrinsic.${operation.spelling}`,
      signature: signature(operation),
      unsafe: operation.unsafe,
      phase: operation.phase,
      ...(operation.invariant === undefined ? {} : { invariant: operation.invariant }),
      admission: operation.admission,
      consumer: operation.consumer,
      ...(identity === undefined ? {} : { tir: identity, mir: identity }),
      targets: operation.targets,
    }
  })

/** Renders the source-like signature shared by hover and completion detail. */
export const signature = (self: Operation): string => {
  const typeParameters =
    self.typeParameters.length === 0
      ? ''
      : `<${self.typeParameters.map((parameter) => parameter.name).join(', ')}>`
  const parameters = self.parameters
    .map(
      (parameter) =>
        `${parameter.phase === 'Static' ? 'static ' : ''}${parameter.name}: ${parameter.type}`,
    )
    .join(', ')
  return `${self.unsafe ? 'unsafe ' : ''}fn ${self.id.actor}.${self.spelling}${typeParameters}(${parameters}) -> ${self.result}`
}
