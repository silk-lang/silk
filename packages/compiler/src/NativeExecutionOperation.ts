import * as Emitter from '@silklang/llvm/Emitter'
import * as NativePlace from './NativePlace.js'
import * as FunctionIndex from './internal/FunctionIndex.js'
import * as NativeArgument from './NativeArgument.js'
import * as CleanupPlan from './CleanupPlan.js'
import * as NativePayload from './NativePayload.js'
import * as NativeDiagnosticTransfer from './NativeDiagnosticTransfer.js'
import * as NativeFrame from './NativeFrame.js'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as NativeDiagnosticFailure from './NativeDiagnosticFailure.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'
import * as ContinuationTransfer from './ContinuationTransfer.js'
import * as NativeExecutionStorage from './NativeExecutionStorage.js'
import * as LlvmBlock from '@silklang/llvm/Block'
import * as FunctionActor from '@silklang/llvm/Function'
import * as LlvmType from '@silklang/llvm/Type'
import * as Value from '@silklang/llvm/Value'
import { suspensionPointKey } from './Backend.js'
import * as CoroutineFrame from './CoroutineFrame.js'
import * as ExecutionPackage from './ExecutionPackage.js'
import * as ExecutionTransition from './ExecutionTransition.js'
import * as Tir from './Tir.js'
import * as Layout from './Layout.js'
import * as LayoutVerify from './LayoutVerify.js'
import * as Mir from './Mir.js'
import type { LinearOperation } from './MirLinearization.js'
import * as MirVerification from './MirVerification.js'
import * as NativeAggregate from './NativeAggregate.js'
import * as NativeCall from './NativeCall.js'
import * as NativeCallable from './NativeCallable.js'
import * as NativeResult from './NativeResult.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeSuspension from './NativeSuspension.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeType from './NativeType.js'
import type * as NativeValue from './NativeValue.js'
import * as ValueStorage from './ValueStorage.js'
import * as SilkType from './Type.js'

type Operation = Extract<
  LinearOperation,
  {
    readonly _tag:
      | 'ExecutionFromAllocation'
      | 'ExecutionDrive'
      | 'ExecutionWake'
      | 'ExecutionPark'
      | 'ExecutionNotifyInitial'
  }
>

const componentOffset = (
  plan: ExecutionPackage.Plan,
  role: ExecutionPackage.Component['role'],
): number | undefined => {
  let cursor = 0
  for (const component of plan.components) {
    cursor = Math.ceil(cursor / component.alignment) * component.alignment
    if (component.role === role) return cursor
    cursor += component.size
  }
  return undefined
}

const targetForCallable = (
  context: Context,
  local: { readonly ordinal: number },
  typeArguments: ReadonlyArray<SilkType.GenericArgument>,
) => {
  const type = context.entry.fn.localTypes.at(local.ordinal)
  if (type?._tag !== 'CallableValue')
    throw new RangeError('LLVM execution callback lost its exact callable identity')
  if (type.target._tag !== 'DeclarationCallableTarget')
    throw new RangeError('LLVM execution callback cannot use a compiler builtin target')
  const declaration = type.target.declaration
  const target = context.declared.find((candidate) =>
    context.program.functions.some(
      (fn) =>
        fn === candidate.fn &&
        candidate.fn.id.module === declaration.module &&
        candidate.fn.id.name === declaration.name &&
        Mir.runtimeArgumentsEqual(candidate.fn.instance.typeArguments, typeArguments),
    ),
  )
  if (target === undefined) throw new RangeError('LLVM execution callback target is unavailable')
  return { type, target }
}

const applyCallable = (
  context: Context,
  local: { readonly _tag: 'Local'; readonly ordinal: number },
  typeArguments: ReadonlyArray<SilkType.GenericArgument>,
  arguments_: ReadonlyArray<ReadonlyArray<Value.Input>>,
  tag: string,
) => {
  const { type, target } = targetForCallable(context, local, typeArguments)
  const values = NativeStorage.materialize(context.storage, local)
  let cursor = 0
  const captures = (type.environment?.fields ?? []).map((field) => {
    const lanes = Layout.callableFieldLanes(context.program.layout, field)
    const selected = values.slice(cursor, cursor + lanes.length)
    cursor += lanes.length
    return { parameterOrdinal: field.parameterOrdinal, items: selected }
  })
  return NativeResult.sourceValues(
    NativeResult.materialize(
      context.storage,
      NativeCall.callValues(
        context.call,
        target,
        NativeArgument.fromValues(Mir.applyOperands(captures, arguments_)),
        tag,
      ),
      `${tag}_source_result`,
    ),
  )
}

const storePackageValue = (
  context: Context,
  base: Value.Input,
  local: { readonly _tag: 'Local'; readonly ordinal: number },
  type: SilkType.Type,
  byteOffset: number,
  tag: string,
) => {
  if (NativeStorage.readLocal(context.storage, local)._tag === 'Empty') return
  const selected = NativeLanePointer.lanePointer(
    context.lanePointers,
    context.body,
    base,
    byteOffset,
    tag,
  )
  NativeStorage.sendPlace(
    context.storage,
    NativePlace.stored(context.program.layout, type, selected),
    local,
  )
}

interface PackageReadContext {
  readonly body: Context['body']
  readonly program: Context['program']
  readonly lanePointers: Context['lanePointers']
  readonly types: Context['types']
}

/** Keeps package cleanup lazy until the owning lifecycle selects this component. */
const packagePayload = (
  context: PackageReadContext,
  base: Value.Input,
  type: SilkType.Type,
  byteOffset: number,
  tag: string,
) => {
  const selected = NativeLanePointer.lanePointer(
    context.lanePointers,
    context.body,
    base,
    byteOffset,
    tag,
  )
  return NativePayload.place(
    context.types,
    NativePlace.stored(context.program.layout, type, selected),
  )
}

const exactEffect = (context: Context, package_: ExecutionPackage.Plan) => {
  const represented = package_.specialization.body
  const contract = SilkType.isRepresented(represented) ? represented.contract : represented
  const representation = SilkType.isRepresented(represented)
    ? represented.representation.argument
    : undefined
  const identity =
    representation !== undefined && SilkType.isExactRepresentationArgument(representation)
      ? representation.identity
      : undefined
  const environment =
    identity !== undefined && SilkType.isEffectIdentityArgument(identity)
      ? Layout.effectEnvironmentByIdentity(
          context.program.layout.effectEnvironments,
          identity,
          SilkType.isRepresented(represented) && SilkType.isEffect(represented.contract)
            ? represented.contract
            : undefined,
        )
      : undefined
  const target =
    environment === undefined
      ? undefined
      : FunctionIndex.nativeCandidates(
          context.declared,
          Tir.effectRunnerId(environment.instance.declaration, environment.site),
        ).find((candidate) =>
          Mir.matchesEffectInstance(
            candidate.fn,
            Tir.effectRunnerId(environment.instance.declaration, environment.site),
            environment.instance.typeArguments,
            environment.instance.staticArguments,
            SilkType.isEffect(contract) ? contract : environment.effect,
          ),
        )
  if (environment === undefined || target === undefined)
    throw new RangeError('LLVM execution drive lost its exact body runner')
  return { environment, target }
}

const bodyOperands = (
  context: Context,
  package_: ExecutionPackage.Plan,
  base: Value.Input,
  tag: string,
) => {
  const { environment, target } = exactEffect(context, package_)
  const bodyOffset = componentOffset(package_, 'BodyEnvironment')
  if (bodyOffset === undefined) throw new RangeError('LLVM execution drive lost body storage')
  const values = NativePlace.loadLanes(
    NativePlace.stored(
      context.program.layout,
      package_.specialization.body,
      NativeLanePointer.lanePointer(
        context.lanePointers,
        context.body,
        base,
        bodyOffset,
        `${tag}_body`,
      ),
    ),
    context,
    tag,
  )
  return { environment, target, values: values }
}

const notifyReady = (
  context: Context,
  package_: ExecutionPackage.Plan,
  base: Value.Input,
  tag: string,
) => {
  context.runtimeFeatures.add('ReadinessNotification')
  const callbackOffset = componentOffset(package_, 'EndpointCallback')
  const endpointOffset = componentOffset(package_, 'EndpointState')
  const callback = package_.specialization.callback
  const representation = SilkType.isRepresented(callback)
    ? callback.representation.argument
    : undefined
  const identity =
    representation !== undefined &&
    SilkType.isExactRepresentationArgument(representation) &&
    SilkType.isCallableIdentityArgument(representation.identity)
      ? representation.identity
      : undefined
  const targetIdentity =
    identity === undefined ? undefined : Tir.callableTargetFromIdentity(identity.target)
  const environment =
    identity?.environment === undefined
      ? undefined
      : Layout.callableEnvironmentByIdentity(context.program.layout, identity.environment)
  let targetArguments: ReadonlyArray<SilkType.GenericArgument>
  if (identity === undefined) {
    targetArguments = []
  } else if (environment === undefined) {
    targetArguments = identity.typeArguments
  } else {
    targetArguments = Layout.callableTargetArguments(environment)
  }
  const target =
    targetIdentity?._tag === 'DeclarationCallableTarget'
      ? context.declared.find(
          (candidate) =>
            candidate.fn.id.module === targetIdentity.declaration.module &&
            candidate.fn.id.name === targetIdentity.declaration.name &&
            Mir.runtimeArgumentsEqual(candidate.fn.instance.typeArguments, targetArguments),
        )
      : undefined
  const callbackLayout = Layout.entry(context.program.layout, package_.specialization.callback)
  const endpointLayout = Layout.entry(context.program.layout, package_.specialization.endpoint)
  if (
    (callbackOffset === undefined && callbackLayout?.size !== 0) ||
    (endpointOffset === undefined && endpointLayout?.size !== 0) ||
    identity === undefined ||
    target === undefined ||
    (identity.environment !== undefined && environment === undefined)
  )
    throw new RangeError('LLVM readiness notification lost its exact package callback authority')
  const captures: Array<{
    readonly parameterOrdinal: number
    readonly items: ReadonlyArray<Value.Input>
  }> = []
  const callbackValues =
    environment === undefined
      ? []
      : NativePlace.loadLanes(
          NativePlace.stored(
            context.program.layout,
            callback,
            NativeLanePointer.lanePointer(
              context.lanePointers,
              context.body,
              base,
              callbackOffset ?? 0,
              `${tag}_callback`,
            ),
          ),
          context,
          `${tag}_callback`,
        )
  let captureOrdinal = 0
  for (const field of environment?.fields ?? []) {
    const count = Layout.callableFieldLanes(context.program.layout, field).length
    captures.push({
      parameterOrdinal: field.parameterOrdinal,
      items: callbackValues.slice(captureOrdinal, captureOrdinal + count),
    })
    captureOrdinal += count
  }
  const endpoint = NativeLanePointer.lanePointer(
    context.lanePointers,
    context.body,
    base,
    endpointOffset ?? 0,
    `${tag}_endpoint`,
  )
  NativeResult.sourceValues(
    NativeResult.materialize(
      context.storage,
      NativeCall.callValues(
        context.call,
        target,
        NativeArgument.fromValues(Mir.applyOperands(captures, [[endpoint]])),
        tag,
      ),
      `${tag}_source_result`,
    ),
  )
}

const releasePackage = (
  context: Context,
  package_: ExecutionPackage.Plan,
  base: Value.Input,
  tag: string,
) => {
  const cleanup = package_.cleanup
  const allocationOffset = componentOffset(package_, 'AllocationAuthority')
  if (cleanup === undefined || allocationOffset === undefined)
    throw new RangeError('LLVM execution cleanup lost package metadata')
  const callbackOffset = componentOffset(package_, 'EndpointCallback')
  if (callbackOffset !== undefined && CleanupPlan.hasEffect(cleanup.callback))
    NativeAggregate.dropThroughPlan(
      context.cleanup,
      cleanup.callback,
      packagePayload(
        context,
        base,
        package_.specialization.callback,
        callbackOffset,
        `${tag}_callback_load`,
      ),
      `${tag}_callback`,
    )
  const endpointOffset = componentOffset(package_, 'EndpointState')
  if (endpointOffset !== undefined && CleanupPlan.hasEffect(cleanup.endpoint))
    NativeAggregate.dropThroughPlan(
      context.cleanup,
      cleanup.endpoint,
      packagePayload(
        context,
        base,
        package_.specialization.endpoint,
        endpointOffset,
        `${tag}_endpoint_load`,
      ),
      `${tag}_endpoint`,
    )
  NativeAggregate.dropThroughPlan(
    context.cleanup,
    {
      _tag: 'AllocationCleanup' as const,
      type: SilkType.allocation,
      ticket: 'ActiveReclaimTicket' as const,
    },
    packagePayload(context, base, SilkType.allocation, allocationOffset, `${tag}_allocation_load`),
    `${tag}_allocation`,
  )
}

const releaseAllocation = (
  context: Context,
  package_: ExecutionPackage.Plan,
  base: Value.Input,
  tag: string,
) => {
  const allocationOffset = componentOffset(package_, 'AllocationAuthority')
  if (allocationOffset === undefined)
    throw new RangeError('LLVM execution lost allocation authority')
  NativeAggregate.dropThroughPlan(
    context.cleanup,
    {
      _tag: 'AllocationCleanup' as const,
      type: SilkType.allocation,
      ticket: 'ActiveReclaimTicket' as const,
    },
    packagePayload(context, base, SilkType.allocation, allocationOffset, `${tag}_load`),
    tag,
  )
}

interface StoredEndpoints {
  readonly callback?: NativePayload.NativePayload
  readonly endpoint?: NativePayload.NativePayload
}

const loadStoredEndpoints = (
  context: NativeAggregate.Context,
  package_: ExecutionPackage.Plan,
  base: Value.Input,
  tag: string,
): StoredEndpoints => {
  const callbackOffset = componentOffset(package_, 'EndpointCallback')
  const endpointOffset = componentOffset(package_, 'EndpointState')
  return {
    ...(callbackOffset === undefined ||
    package_.cleanup === undefined ||
    !CleanupPlan.hasEffect(package_.cleanup.callback)
      ? {}
      : {
          callback: packagePayload(
            context,
            base,
            package_.specialization.callback,
            callbackOffset,
            `${tag}_callback_load`,
          ),
        }),
    ...(endpointOffset === undefined ||
    package_.cleanup === undefined ||
    !CleanupPlan.hasEffect(package_.cleanup.endpoint)
      ? {}
      : {
          endpoint: packagePayload(
            context,
            base,
            package_.specialization.endpoint,
            endpointOffset,
            `${tag}_endpoint_load`,
          ),
        }),
  }
}

const dropStoredEndpoints = (
  context: NativeAggregate.Context,
  package_: ExecutionPackage.Plan,
  endpoints: StoredEndpoints,
  tag: string,
) => {
  const cleanup = package_.cleanup
  if (cleanup === undefined) throw new RangeError('LLVM execution drop lost package metadata')
  if (endpoints.callback !== undefined)
    NativeAggregate.dropThroughPlan(
      context,
      cleanup.callback,
      endpoints.callback,
      `${tag}_callback`,
    )
  if (endpoints.endpoint !== undefined)
    NativeAggregate.dropThroughPlan(
      context,
      cleanup.endpoint,
      endpoints.endpoint,
      `${tag}_endpoint`,
    )
}

const dropStoredPackage = (
  context: NativeAggregate.Context,
  package_: ExecutionPackage.Plan,
  base: Value.Input,
  options: {
    readonly body: boolean
    readonly endpoints: boolean
    readonly allocation: boolean
  },
  tag: string,
) => {
  const cleanup = package_.cleanup
  if (cleanup === undefined) throw new RangeError('LLVM execution drop lost package metadata')
  if (options.endpoints)
    dropStoredEndpoints(context, package_, loadStoredEndpoints(context, package_, base, tag), tag)
  if (options.body && CleanupPlan.hasEffect(cleanup.body)) {
    const offset = componentOffset(package_, 'BodyEnvironment')
    if (offset === undefined) throw new RangeError('LLVM execution drop lost body storage')
    NativeAggregate.dropThroughPlan(
      context,
      cleanup.body,
      packagePayload(context, base, package_.specialization.body, offset, `${tag}_body_load`),
      `${tag}_body`,
    )
  }
  if (options.allocation) {
    const allocationOffset = componentOffset(package_, 'AllocationAuthority')
    if (allocationOffset === undefined)
      throw new RangeError('LLVM execution drop lost allocation storage')
    NativeAggregate.dropThroughPlan(
      context,
      {
        _tag: 'AllocationCleanup' as const,
        type: SilkType.allocation,
        ticket: 'ActiveReclaimTicket' as const,
      },
      packagePayload(
        context,
        base,
        SilkType.allocation,
        allocationOffset,
        `${tag}_allocation_load`,
      ),
      `${tag}_allocation`,
    )
  }
}

/** Runs one armed nonparking finalizer from its retained frame before consuming those fields. */
const runCancellationFinalizer = (
  context: NativeAggregate.Context,
  owner: Mir.MirFunction,
  layout: Mir.CoroutineFrameTargetStateLayout,
  frame: Value.Input,
  finalizer: Mir.CancellationFinalizer | undefined,
  tag: string,
) => {
  if (finalizer === undefined) return new Set<number>()
  const { body, declared } = context
  const target = FunctionIndex.nativeCandidates(declared, finalizer.runner).find((candidate) =>
    Mir.matchesEffectInstance(
      candidate.fn,
      finalizer.runner,
      finalizer.runnerTypeArguments,
      finalizer.runnerStaticArguments,
      finalizer.outcomeType.type,
    ),
  )
  if (target === undefined)
    throw new RangeError('LLVM cancellation finalizer lost its exact Effect runner')
  const materialize = (local: Mir.LocalId) => {
    const type = owner.localTypes.at(local.ordinal)
    if (type === undefined) throw new RangeError('LLVM cancellation finalizer lost a local type')
    const field = layout.payload.find((candidate) => candidate.local.ordinal === local.ordinal)
    if (field === undefined) {
      if (NativeType.valueLanesFor(context.types, type).length === 0) return []
      throw new RangeError('LLVM cancellation finalizer lost a retained frame field')
    }
    const place = NativeFrame.place(context.storage, frame, field, `${tag}_local${local.ordinal}`)
    return NativePayload.materialize(
      NativePayload.place(context.types, place),
      context,
      `${tag}_local${local.ordinal}_value`,
    )
  }
  let effectValues: ReadonlyArray<Value.Input>
  if (finalizer._tag === 'EffectCancellationFinalizer') {
    effectValues = materialize(finalizer.effect)
  } else {
    const releaseType = owner.localTypes.at(finalizer.release.ordinal)
    if (releaseType?._tag !== 'CallableValue')
      throw new RangeError('LLVM resource finalizer lost its release callable')
    const releaseTarget = FunctionIndex.nativeCandidates(declared, finalizer.releaseTarget).find(
      (candidate) =>
        Mir.matchesInstance(candidate.fn, finalizer.releaseTarget, finalizer.releaseTypeArguments),
    )
    if (releaseTarget === undefined)
      throw new RangeError('LLVM resource finalizer lost its release builder target')
    const releaseValues = materialize(finalizer.release)
    const captures = NativeCallable.capturedArguments(
      context,
      releaseType,
      releaseValues,
      `${tag}_release`,
    )
    const resourceField = layout.payload.find(
      (candidate) => candidate.local.ordinal === finalizer.resource.ordinal,
    )
    if (resourceField === undefined)
      throw new RangeError('LLVM resource finalizer lost its retained resource')
    const resourcePlace = NativeFrame.place(
      context.storage,
      frame,
      resourceField,
      `${tag}_resource`,
    )
    const resourceReference = NativePlace.base(
      resourcePlace,
      context.storage,
      `${tag}_resource_ref`,
    )
    const releaseResult = NativeCall.callValues(
      context.call,
      releaseTarget,
      NativeArgument.fromValues(
        Mir.applyOperands(
          captures.map((capture) => ({
            parameterOrdinal: capture.parameterOrdinal,
            items: capture.values,
          })),
          [[resourceReference]],
        ),
      ),
      `${tag}_build`,
    )
    effectValues = NativeResult.sourceValues(
      NativeResult.materialize(context.storage, releaseResult, `${tag}_source_result`),
    )
  }
  const inputs = [...effectValues, ...Array.from(finalizer.arguments, materialize).flat()]
  const lowered = NativeArgument.lower(
    context.storage,
    target.argumentParameters,
    NativeArgument.fromValues(inputs),
    `${tag}_arguments`,
  )
  const callable = target.suspendable ? target.driver : target.handle
  if (callable === undefined)
    throw new RangeError('LLVM nonparking cancellation finalizer lost its machine driver')
  const resultAddress = NativeResult.allocate(body, target, `${tag}_result`)
  Emitter.callDirect(
    body,
    callable,
    NativeResult.argumentsFor(
      target,
      NativeCall.argumentsFor(context.call.synchronous, target, lowered),
      resultAddress,
    ),
    `${tag}_run`,
  )
  return new Set([
    ...(finalizer._tag === 'EffectCancellationFinalizer'
      ? [finalizer.effect.ordinal]
      : [finalizer.release.ordinal]),
    ...finalizer.arguments.map((local) => local.ordinal),
  ])
}

const dropFrames = (
  context: NativeAggregate.Context,
  package_: ExecutionPackage.Plan,
  base: Value.Input,
  tag: string,
) => {
  const continuationOffset = componentOffset(package_, 'InitialContinuationSegment')
  if (continuationOffset === undefined) return
  const { body, builder, executionStorage, lanePointers, pointer, program, usizeType } = context
  if (executionStorage === undefined || usizeType === undefined)
    throw new RangeError('LLVM execution frame cleanup lost runtime support')
  const diagnostic = context.call.synchronous.diagnostic
  const previousObserver =
    diagnostic === undefined ? undefined : NativeDiagnosticContext.current(diagnostic)
  const previousCause =
    diagnostic === undefined ? undefined : NativeDiagnosticContext.currentCause(diagnostic)
  const stateSlot = NativeLanePointer.lanePointer(
    lanePointers,
    body,
    base,
    continuationOffset + NativeExecutionStorage.stateOffset(program.layout.target.pointerSize),
    `${tag}_storage_slot`,
  )
  const storageState = Emitter.load(body, pointer, stateSlot, `${tag}_storage_state`)
  const headStorage = Emitter.alloca(body, pointer, `${tag}_head_slot`)
  Emitter.store(
    body,
    Emitter.load(
      body,
      pointer,
      NativeLanePointer.lanePointer(
        lanePointers,
        body,
        base,
        continuationOffset,
        `${tag}_saved_head_ptr`,
      ),
      `${tag}_saved_head`,
    ),
    headStorage,
  )
  const loop = Emitter.block(body, `${tag}_frame_loop`)
  const finish = Emitter.block(body, `${tag}_frame_finish`)
  Emitter.branch(body, loop)
  Emitter.setInsertionPoint(body, loop)
  const head = Emitter.load(body, pointer, headStorage, `${tag}_head`)
  const address = Emitter.cast(body, 'ptrtoint', head, usizeType, `${tag}_head_address`)
  const present = Emitter.block(body, `${tag}_frame_present`)
  Emitter.conditionalBranch(
    body,
    Emitter.integerCompare(
      body,
      'eq',
      address,
      Emitter.integerUnsigned(builder, usizeType, 0n),
      `${tag}_frames_done`,
    ),
    finish,
    present,
  )
  Emitter.setInsertionPoint(body, present)
  const next = Emitter.load(body, pointer, head, `${tag}_next`)
  if (diagnostic !== undefined)
    Emitter.store(
      body,
      Emitter.load(
        body,
        pointer,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          head,
          program.layout.target.pointerSize * 2,
          `${tag}_observer_ptr`,
        ),
        `${tag}_observer`,
      ),
      diagnostic.current,
    )

  if (diagnostic !== undefined)
    Emitter.store(
      body,
      Emitter.load(
        body,
        diagnostic.causeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          head,
          program.layout.target.pointerSize * 9,
          `${tag}_current_cause_ptr`,
        ),
        `${tag}_current_cause`,
      ),
      diagnostic.cause,
    )

  const resume = Emitter.load(
    body,
    pointer,
    NativeLanePointer.lanePointer(
      lanePointers,
      body,
      head,
      program.layout.target.pointerSize,
      `${tag}_resume_ptr`,
    ),
    `${tag}_resume`,
  )
  const resumeAddress = Emitter.cast(body, 'ptrtoint', resume, usizeType, `${tag}_resume_address`)
  const released = Emitter.block(body, `${tag}_frame_released`)
  let otherwise = present
  for (const [ordinal, generated] of [...context.resumeThunks.values()].entries()) {
    const selected = Emitter.block(body, `${tag}_frame_${ordinal}`)
    const following = Emitter.block(body, `${tag}_frame_${ordinal}_otherwise`)
    if (otherwise !== present) Emitter.setInsertionPoint(body, otherwise)
    const target = Emitter.fromGlobal(builder, Emitter.functionGlobal(builder, generated.handle))
    Emitter.conditionalBranch(
      body,
      Emitter.integerCompare(
        body,
        'eq',
        resumeAddress,
        Emitter.cast(body, 'ptrtoint', target, usizeType, `${tag}_target_${ordinal}_address`),
        `${tag}_frame_${ordinal}_matches`,
      ),
      selected,
      following,
    )
    Emitter.setInsertionPoint(body, selected)
    const owner = program.functions.find((fn) =>
      Mir.matchesInstanceKey(fn, generated.layout.point.owner),
    )
    if (owner === undefined) throw new RangeError('LLVM execution frame cleanup lost its owner')
    const consumed = runCancellationFinalizer(
      context,
      owner,
      generated.layout,
      head,
      generated.region.relay.state?.cancellationFinalizer,
      `${tag}_frame_${ordinal}_finalizer`,
    )
    const releases = CoroutineFrame.cleanupReleases(owner, generated.layout).filter(
      (field) => !consumed.has(field.local.ordinal),
    )
    const initializationValues = new Map<number, Value.Input>()
    const flags = new Set(
      releases.flatMap(
        (field) => field.initialization?.flags.map((flag) => flag.local.ordinal) ?? [],
      ),
    )
    for (const ordinal of flags) {
      const field = generated.layout.payload.find((field) => field.local.ordinal === ordinal)
      if (field === undefined || field.type._tag !== 'bool')
        throw new RangeError('LLVM cancellation lost a retained initialization flag')
      const lanes = ValueStorage.transport(
        program.layout.target,
        NativeType.lanesFor(context.types, field.type),
        field.offset,
      )
      const values = Array.from(lanes.entries, (lane) => {
        return Emitter.load(
          body,
          NativeType.laneType(context.types, lane.lane),
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            head,
            lane.offset,
            `${tag}_flag${ordinal}_ptr`,
          ),
          `${tag}_flag${ordinal}`,
        )
      })
      const value = values.at(0)
      if (value === undefined || values.length !== 1)
        throw new RangeError('LLVM cancellation initialization flag is not scalar')
      initializationValues.set(ordinal, value)
    }
    const scopes = Mir.regionsTree(owner.regions).flatMap((region) =>
      Mir.operationsOf(region).filter((operation) => operation._tag === 'DiagnosticScope'),
    )
    const leftScopes = new Set<number>()
    for (const field of releases) {
      if (diagnostic !== undefined) {
        for (const scope of scopes) {
          if (
            leftScopes.has(scope.destination.ordinal) ||
            (field.local.ordinal !== scope.state.ordinal &&
              field.local.ordinal !== scope.observer.ordinal)
          )
            continue
          const frame = program.coroutineFrames?.entries.find((frame) =>
            Mir.matchesInstanceKey(owner, frame.function),
          )
          const descriptor = frame?.diagnosticScopes.find(
            (field) => field.scope.ordinal === scope.destination.ordinal,
          )
          if (descriptor === undefined)
            throw new RangeError('Cancellation lost its diagnostic descriptor')
          for (const field of frame?.diagnosticOutcomes ?? []) {
            NativeDiagnosticOutcome.releaseForObserver(
              {
                storage: NativeLanePointer.lanePointer(
                  lanePointers,
                  body,
                  head,
                  field.offset,
                  `${tag}_scope_outcome${field.outcome.ordinal}`,
                ),
              },
              diagnostic,
              NativeLanePointer.lanePointer(
                lanePointers,
                body,
                head,
                descriptor.offset,
                `${tag}_scope_observer`,
              ),
            )
          }
          Emitter.store(
            body,
            Emitter.load(
              body,
              pointer,
              NativeLanePointer.lanePointer(
                lanePointers,
                body,
                head,
                descriptor.offset + program.layout.target.pointerSize * 3,
                `${tag}_scope${scope.destination.ordinal}_previous_ptr`,
              ),
              `${tag}_scope${scope.destination.ordinal}_previous`,
            ),
            diagnostic.current,
          )
          Emitter.store(
            body,
            Emitter.load(
              body,
              diagnostic.causeType,
              NativeLanePointer.lanePointer(
                lanePointers,
                body,
                head,
                descriptor.offset + program.layout.target.pointerSize * 4,
                `${tag}_previous_cause_ptr`,
              ),
              `${tag}_previous_cause`,
            ),
            diagnostic.cause,
          )
          leftScopes.add(scope.destination.ordinal)
        }
      }

      NativeAggregate.dropThroughPlan(
        { ...context, initializationValues },
        field.access.cleanup,
        NativePayload.place(
          context.types,
          NativeFrame.place(context.storage, head, field, `${tag}_frame_${ordinal}`),
        ),
        `${tag}_frame_${ordinal}_slot${field.slot}`,
        undefined,
        field.initialization,
      )
    }
    if (diagnostic !== undefined) {
      const frame = program.coroutineFrames?.entries.find((frame) =>
        Mir.matchesInstanceKey(owner, frame.function),
      )
      if (frame === undefined) throw new RangeError('Cancellation lost its outcome storage layout')
      for (const field of frame.diagnosticOutcomes)
        NativeDiagnosticOutcome.release(
          {
            storage: NativeLanePointer.lanePointer(
              lanePointers,
              body,
              head,
              field.offset,
              `${tag}_release_outcome${field.outcome.ordinal}`,
            ),
          },
          diagnostic,
        )
    }
    Emitter.branch(body, released)
    otherwise = following
  }
  Emitter.setInsertionPoint(body, otherwise)
  Emitter.unreachable(body)
  Emitter.setInsertionPoint(body, released)
  NativeExecutionStorage.invoke(
    { builder, body, pointer, storage: executionStorage },
    'release',
    [storageState, head],
    `${tag}_frame_release`,
  )
  Emitter.store(body, next, headStorage)
  Emitter.branch(body, loop)
  Emitter.setInsertionPoint(body, finish)
  if (diagnostic !== undefined && previousObserver !== undefined)
    Emitter.store(body, previousObserver, diagnostic.current)
  if (diagnostic !== undefined && previousCause !== undefined)
    Emitter.store(body, previousCause, diagnostic.cause)
  NativeExecutionStorage.destroy(
    { builder, body, pointer, usizeType, storage: executionStorage },
    stateSlot,
    `${tag}_storage`,
  )
}

// These physical phases hold allocation authority throughout emitted source cleanup.
// A Wake consumed reentrantly records consumption without releasing the package.
const cleanupWithWake = 7n
const cleanupWithoutWake = 8n

const dropActivatedPackage = (
  context: NativeAggregate.Context,
  package_: ExecutionPackage.Plan,
  base: Value.Input,
  tag: string,
) => {
  const { body, builder, usizeType, lanePointers } = context
  if (usizeType === undefined) throw new RangeError('Execution cleanup lost its word type')
  const endpoints = loadStoredEndpoints(context, package_, base, tag)
  const controlOffset = componentOffset(package_, 'WakeControl')
  const phasePointer =
    controlOffset === undefined
      ? undefined
      : NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          controlOffset,
          `${tag}_cleanup_phase_ptr`,
        )
  if (phasePointer !== undefined) {
    const phase = Emitter.load(body, usizeType, phasePointer, `${tag}_cleanup_phase`)
    const registering = Emitter.integerCompare(
      body,
      'eq',
      phase,
      Emitter.integerUnsigned(builder, usizeType, 1n),
      `${tag}_registering_wake`,
    )
    const dormant = Emitter.integerCompare(
      body,
      'eq',
      phase,
      Emitter.integerUnsigned(builder, usizeType, 3n),
      `${tag}_dormant_wake`,
    )
    Emitter.store(
      body,
      Emitter.select(
        body,
        Emitter.binary(body, 'or', registering, dormant, `${tag}_owns_wake`),
        Emitter.integerUnsigned(builder, usizeType, cleanupWithWake),
        Emitter.integerUnsigned(builder, usizeType, cleanupWithoutWake),
        `${tag}_held_phase`,
      ),
      phasePointer,
    )
  }
  Emitter.store(
    body,
    Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Destroyed'))),
    NativeLanePointer.lanePointer(lanePointers, body, base, 0, `${tag}_cleanup_state_ptr`),
  )
  dropFrames(context, package_, base, tag)
  dropStoredEndpoints(context, package_, endpoints, tag)
  const release = Emitter.block(body, `${tag}_release_package`)
  const done = Emitter.block(body, `${tag}_cleanup_done`)
  if (phasePointer === undefined) {
    Emitter.branch(body, release)
  } else {
    const phase = Emitter.load(body, usizeType, phasePointer, `${tag}_cleaned_phase`)
    Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 6n), phasePointer)
    Emitter.conditionalBranch(
      body,
      Emitter.integerCompare(
        body,
        'eq',
        phase,
        Emitter.integerUnsigned(builder, usizeType, cleanupWithoutWake),
        `${tag}_wake_consumed`,
      ),
      release,
      done,
    )
  }
  Emitter.setInsertionPoint(body, release)
  dropStoredPackage(
    context,
    package_,
    base,
    { body: false, endpoints: false, allocation: true },
    `${tag}_allocation`,
  )
  Emitter.branch(body, done)
  Emitter.setInsertionPoint(body, done)
}

const selectPackage = (
  context: NativeAggregate.Context,
  base: Value.Input,
  tag: string,
  emitPlan: (package_: ExecutionPackage.Plan, ordinal: number) => void,
) => {
  const { body, builder, program, usizeType } = context
  if (usizeType === undefined) throw new RangeError('LLVM execution cleanup lost usize')
  const packageOrdinal = Emitter.load(
    body,
    usizeType,
    NativeLanePointer.lanePointer(
      context.lanePointers,
      body,
      base,
      program.layout.target.pointerSize,
      `${tag}_package_ptr`,
    ),
    `${tag}_package`,
  )
  const following = Emitter.block(body, `${tag}_following`)
  let otherwise: LlvmBlock.Block | undefined
  for (const [ordinal, package_] of program.layout.executionPackages.plans.entries()) {
    if (otherwise !== undefined) Emitter.setInsertionPoint(body, otherwise)
    const selected = Emitter.block(body, `${tag}_package_${ordinal}`)
    const next = Emitter.block(body, `${tag}_package_${ordinal}_otherwise`)
    Emitter.conditionalBranch(
      body,
      Emitter.integerCompare(
        body,
        'eq',
        packageOrdinal,
        Emitter.integerUnsigned(builder, usizeType, BigInt(ordinal)),
        `${tag}_package_${ordinal}_matches`,
      ),
      selected,
      next,
    )
    Emitter.setInsertionPoint(body, selected)
    emitPlan(package_, ordinal)
    Emitter.branch(body, following)
    otherwise = next
  }
  if (otherwise === undefined) throw new RangeError('LLVM execution cleanup has no package plans')
  Emitter.setInsertionPoint(body, otherwise)
  Emitter.unreachable(body)
  Emitter.setInsertionPoint(body, following)
}

const selectPackageFrom = (
  context: NativeAggregate.Context,
  base: Value.Input,
  matching: ReadonlyArray<ExecutionPackage.Plan>,
  tag: string,
  emitPlan: (package_: ExecutionPackage.Plan) => void,
) => {
  const { body, builder, program, usizeType } = context
  if (usizeType === undefined) throw new RangeError('LLVM package selection lost usize')
  const packageOrdinal = Emitter.load(
    body,
    usizeType,
    NativeLanePointer.lanePointer(
      context.lanePointers,
      body,
      base,
      program.layout.target.pointerSize,
      `${tag}_selected_package_ptr`,
    ),
    `${tag}_selected_package`,
  )
  const following = Emitter.block(body, `${tag}_selected_following`)
  let otherwise: LlvmBlock.Block | undefined
  for (const package_ of matching) {
    const ordinal = program.layout.executionPackages.plans.findIndex((candidate) =>
      ExecutionPackage.equals(candidate, package_),
    )
    if (ordinal < 0) throw new RangeError('LLVM package selection lost a matching package ordinal')
    if (otherwise !== undefined) Emitter.setInsertionPoint(body, otherwise)
    const selected = Emitter.block(body, `${tag}_selected_package_${ordinal}`)
    const next = Emitter.block(body, `${tag}_selected_package_${ordinal}_otherwise`)
    Emitter.conditionalBranch(
      body,
      Emitter.integerCompare(
        body,
        'eq',
        packageOrdinal,
        Emitter.integerUnsigned(builder, usizeType, BigInt(ordinal)),
        `${tag}_selected_package_${ordinal}_matches`,
      ),
      selected,
      next,
    )
    Emitter.setInsertionPoint(body, selected)
    emitPlan(package_)
    Emitter.branch(body, following)
    otherwise = next
  }
  if (otherwise === undefined) throw new RangeError('LLVM package selection has no matching plans')
  Emitter.setInsertionPoint(body, otherwise)
  Emitter.unreachable(body)
  Emitter.setInsertionPoint(body, following)
}

/**
 * Drops one opaque Execution through its package state and retained continuation authority.
 * Only the release helper expands this inline; every other cleanup site calls the helper.
 */
const dropExecution = (
  context: NativeAggregate.Context,
  values: ReadonlyArray<Value.Input>,
  tag: string,
) => {
  const base = values.at(0)
  const { body, builder, usizeType } = context
  if (base === undefined || usizeType === undefined)
    throw new RangeError('LLVM Execution cleanup lost its package reference')
  selectPackage(context, base, tag, (package_) =>
    (() => {
      const statePointer = NativeLanePointer.lanePointer(
        context.lanePointers,
        body,
        base,
        0,
        `${tag}_state_ptr`,
      )
      const state = Emitter.load(body, usizeType, statePointer, `${tag}_state`)
      const initial = Emitter.block(body, `${tag}_initial`)
      const notInitial = Emitter.block(body, `${tag}_not_initial`)
      const done = Emitter.block(body, `${tag}_state_done`)
      const unpublished = Emitter.integerCompare(
        body,
        'eq',
        state,
        Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Initial'))),
        `${tag}_is_initial`,
      )
      const initialReady = Emitter.integerCompare(
        body,
        'eq',
        state,
        Emitter.integerUnsigned(
          builder,
          usizeType,
          BigInt(ExecutionTransition.tagOf('InitialReady')),
        ),
        `${tag}_is_initial_ready`,
      )
      Emitter.conditionalBranch(
        body,
        Emitter.binary(body, 'or', unpublished, initialReady, `${tag}_is_initial_any`),
        initial,
        notInitial,
      )
      Emitter.setInsertionPoint(body, initial)
      Emitter.store(
        body,
        Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Destroyed'))),
        statePointer,
      )
      dropStoredPackage(
        context,
        package_,
        base,
        { body: true, endpoints: true, allocation: true },
        `${tag}_initial`,
      )
      Emitter.branch(body, done)

      Emitter.setInsertionPoint(body, notInitial)
      const pending = Emitter.block(body, `${tag}_pending`)
      const inactive = Emitter.block(body, `${tag}_inactive`)
      const running = Emitter.integerCompare(
        body,
        'eq',
        state,
        Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Running'))),
        `${tag}_is_running`,
      )
      const notifying = Emitter.integerCompare(
        body,
        'eq',
        state,
        Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Notifying'))),
        `${tag}_is_notifying`,
      )
      Emitter.conditionalBranch(
        body,
        Emitter.binary(body, 'or', running, notifying, `${tag}_is_pending`),
        pending,
        inactive,
      )
      Emitter.setInsertionPoint(body, pending)
      Emitter.store(
        body,
        Emitter.integerUnsigned(
          builder,
          usizeType,
          BigInt(ExecutionTransition.tagOf('DestroyPending')),
        ),
        statePointer,
      )
      Emitter.branch(body, done)

      Emitter.setInsertionPoint(body, inactive)
      const dormant = Emitter.integerCompare(
        body,
        'eq',
        state,
        Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Dormant'))),
        `${tag}_is_dormant`,
      )
      const eligible = Emitter.integerCompare(
        body,
        'eq',
        state,
        Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Eligible'))),
        `${tag}_is_eligible`,
      )
      const release = Emitter.block(body, `${tag}_release`)
      const invalid = Emitter.block(body, `${tag}_invalid_state`)
      Emitter.conditionalBranch(
        body,
        Emitter.binary(body, 'or', dormant, eligible, `${tag}_is_inactive`),
        release,
        invalid,
      )
      Emitter.setInsertionPoint(body, invalid)
      Emitter.unreachable(body)
      Emitter.setInsertionPoint(body, release)
      dropActivatedPackage(context, package_, base, `${tag}_inactive`)
      Emitter.branch(body, done)
      Emitter.setInsertionPoint(body, done)
    })(),
  )
}

const releaseHelperSymbol = 'silk_execution_release'

/**
 * Declares the module's single out-of-line Execution release when the module constructs any
 * Execution package. The synthetic
 * `DeclaredFunction` only feeds the cleanup contexts: its MIR has one Execution parameter and no
 * roots, and its identity is distinct from every real function so no instance lookup can alias it.
 */
export const declareReleaseHelper = (
  builder: Emitter.Module,
  program: Mir.Module,
  pointer: LlvmType.Type,
  declaredVoidType: LlvmType.Type | undefined,
): NativeLoweringContext.DeclaredFunction | undefined => {
  const source = program.functions
    .flatMap((fn) =>
      MirVerification.operations(fn).flatMap((operation) =>
        operation._tag === 'ExecutionFromAllocation' ? [{ fn, operation }] : [],
      ),
    )
    .at(0)
  if (source === undefined) return undefined
  // Resolved only here: an unneeded void type would perturb every other module's type table.
  const voidType = declaredVoidType ?? Emitter.voidType(builder)
  const diagnostics = Mir.hasDiagnosticObservation(program)
  const parameters = diagnostics
    ? [
        pointer,
        pointer,
        NativeDiagnosticFailure.type({
          builder,
          pointer,
          word: Emitter.integerType(builder, program.layout.target.pointerSize * 8),
        }),
      ]
    : [pointer]
  const executionType = SilkType.execution(source.operation.plan.specialization.result)
  const id = { ...source.fn.id, name: releaseHelperSymbol }
  const { suspension: _suspension, ...base } = source.fn
  const fn: Mir.MirFunction = {
    ...base,
    id,
    instance: { ...source.fn.instance, declaration: id },
    parameterCount: 1,
    localTypes: [{ _tag: 'Nominal' as const, type: executionType }],
  }
  return {
    fn,
    symbol: releaseHelperSymbol,
    publicSymbol: releaseHelperSymbol,
    handle: Emitter.declareFunction(
      builder,
      releaseHelperSymbol,
      Emitter.functionType(builder, voidType, parameters),
      { visibility: 'hidden' },
    ),
    resultType: voidType,
    emittedResultType: voidType,
    resultLaneCount: 0,
    suspendable: false,
    parameterTypes: parameters,
    argumentParameters: NativeArgument.parameters(program.layout, fn, (type) => {
      const shape = Layout.callingShape(program.layout, Mir.semanticType(type))
      if (shape === undefined)
        throw new RangeError('Release helper lost its source parameter shape')
      return shape.lanes
    }),
    ...(diagnostics ? { diagnosticParameter: 1 } : {}),
    linear: [],
  }
}

export interface ReleaseHelperContext {
  readonly builder: Emitter.Module
  readonly program: Mir.Module
  readonly i8: LlvmType.Type
  readonly i32: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly usizeType?: LlvmType.Type
  readonly free?: FunctionActor.Function
  readonly executionStorage?: NativeExecutionStorage.NativeExecutionStorage
  readonly resumeThunks: NativeAggregate.Context['resumeThunks']
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  readonly types: NativeType.LoweringContext
  readonly lanePointers: NativeLanePointer.Context
  readonly helper: NativeLoweringContext.DeclaredFunction
}

/**
 * Defines the Execution release helper body. Every `ExecutionCleanup` in the module calls the
 * helper, so the only inline expansion of `dropExecution` lives here: a coroutine frame that
 * retains another Execution releases it through a runtime call instead of re-expanding the
 * module's whole resume-frame inventory during IR construction.
 */
export const emitReleaseHelper = (context: ReleaseHelperContext) => {
  const {
    builder,
    program,
    i8,
    i32,
    pointer,
    usizeType,
    free,
    executionStorage,
    resumeThunks,
    declared,
    types,
    lanePointers,
    helper,
  } = context
  Emitter.buildBody(builder, helper.handle, (body) => {
    Emitter.block(body, 'entry')
    const base = Emitter.argument(body, 0)
    const diagnostic =
      helper.diagnosticParameter === undefined
        ? undefined
        : NativeDiagnosticContext.make(
            builder,
            body,
            pointer,
            i8,
            usizeType ?? Emitter.integerType(builder, program.layout.target.pointerSize * 8),
            Emitter.argument(body, helper.diagnosticParameter),
            Emitter.argument(body, helper.diagnosticParameter + 1),
          )
    const storage: NativeStorage.Context = {
      builder,
      body,
      byteType: i8,
      offsetType: i32,
      fn: helper.fn,
      layout: program.layout,
      mutableRoots: new Set<number>(),
      blockRoots: new Set<number>(),
      mutableStorage: new Map<number, ReadonlyArray<Value.Input>>(),
      addressRoots: new Set<number>(),
      addressStorage: new Map<number, Value.Input>(),
      transientOutcomes: new Set<number>(),
      locals: new Map<number, NativeValue.NativeValue>(),
      types,
      lanePointers,
      sequences: { materialize: 0, reload: 0 },
    }
    const call: NativeCall.Context = {
      builder,
      body,
      program,
      i8,
      i32,
      pointer,
      entry: helper,
      resumeThunks,
      lanePointers,
      types,
      storage,
      synchronous: {
        body,
        storage,
        ...(diagnostic === undefined ? {} : { diagnostic }),
      },
      returns: { builder, body, i32, pointer, entry: helper, types, lanePointers },
    }
    const cleanup: NativeAggregate.Context = {
      builder,
      body,
      program,
      i8,
      i32,
      pointer,
      ...(usizeType === undefined ? {} : { usizeType }),
      ...(free === undefined ? {} : { free }),
      ...(executionStorage === undefined ? {} : { executionStorage }),
      resumeThunks,
      declared,
      types,
      lanePointers,
      call,
      arith: {
        body,
        pointerBits: program.layout.target.pointerSize === 4 ? 32 : 64,
        i32,
        integerTypes: types.integerTypes,
        types,
      },
      storage,
      executionRelease: helper.handle,
    }
    dropExecution(cleanup, [base], 'execution_release')
    Emitter.returnVoid(body)
  })
}

/** Drops one affine Wake, cancelling or finally discharging its generation authority. */
export const dropWake = (
  context: NativeAggregate.Context,
  values: ReadonlyArray<Value.Input>,
  tag: string,
) => {
  const base = values.at(0)
  const { body, builder, usizeType } = context
  if (base === undefined || usizeType === undefined)
    throw new RangeError('LLVM Wake cleanup lost its package reference')
  const packages = context.program.layout.executionPackages.plans.filter(
    (candidate) => candidate.readinessStorage,
  )
  selectPackageFrom(context, base, packages, tag, (package_) =>
    (() => {
      const controlOffset = componentOffset(package_, 'WakeControl')
      if (controlOffset === undefined) throw new RangeError('Wake package lacks control state')
      const phasePointer = NativeLanePointer.lanePointer(
        context.lanePointers,
        body,
        base,
        controlOffset,
        `${tag}_phase_ptr`,
      )
      const phase = Emitter.load(body, usizeType, phasePointer, `${tag}_phase`)
      const late = Emitter.block(body, `${tag}_late`)
      const cancel = Emitter.block(body, `${tag}_cancel`)
      const done = Emitter.block(body, `${tag}_done`)
      Emitter.conditionalBranch(
        body,
        Emitter.integerCompare(
          body,
          'eq',
          phase,
          Emitter.integerUnsigned(builder, usizeType, 6n),
          `${tag}_is_late`,
        ),
        late,
        cancel,
      )
      Emitter.setInsertionPoint(body, late)
      dropStoredPackage(
        context,
        package_,
        base,
        { body: false, endpoints: false, allocation: true },
        `${tag}_late`,
      )
      Emitter.branch(body, done)
      Emitter.setInsertionPoint(body, cancel)
      const held = Emitter.integerCompare(
        body,
        'eq',
        phase,
        Emitter.integerUnsigned(builder, usizeType, cleanupWithWake),
        `${tag}_cleanup_active`,
      )
      Emitter.store(
        body,
        Emitter.select(
          body,
          held,
          Emitter.integerUnsigned(builder, usizeType, cleanupWithoutWake),
          Emitter.integerUnsigned(builder, usizeType, 6n),
          `${tag}_consumed_phase`,
        ),
        phasePointer,
      )
      Emitter.branch(body, done)
      Emitter.setInsertionPoint(body, done)
    })(),
  )
}

export const emit = (context: Context, operation: Operation) => {
  const { body, builder, i32, lanePointers, pointer, program, storage, usizeType } = context
  if (usizeType === undefined) throw new RangeError('LLVM execution lowering requires usize')
  switch (operation._tag) {
    case 'ExecutionFromAllocation': {
      context.runtimeFeatures.add('ExecutionPackage')
      if (operation.plan.readinessStorage) context.runtimeFeatures.add('ExternalWakeCell')
      const allocation = NativeStorage.materialize(storage, operation.allocation)
      const baseAddress = allocation.at(0)
      const bytes = allocation.at(1)
      const alignment = allocation.at(2)
      if (baseAddress === undefined || bytes === undefined || alignment === undefined)
        throw new RangeError('LLVM execution initialization lost allocation authority')
      const bytesMismatch = Emitter.integerCompare(
        body,
        'ne',
        bytes,
        Emitter.integerUnsigned(builder, usizeType, BigInt(operation.plan.size)),
        `execution${operation.destination.ordinal}_bytes_mismatch`,
      )
      const alignmentMismatch = Emitter.integerCompare(
        body,
        'ne',
        alignment,
        Emitter.integerUnsigned(builder, usizeType, BigInt(operation.plan.alignment)),
        `execution${operation.destination.ordinal}_alignment_mismatch`,
      )
      const invalid = Emitter.binary(
        body,
        'or',
        bytesMismatch,
        alignmentMismatch,
        `execution${operation.destination.ordinal}_invalid`,
      )
      const rejected = Emitter.block(body, `execution${operation.destination.ordinal}_trap`)
      const accepted = Emitter.block(body, `execution${operation.destination.ordinal}_accepted`)
      Emitter.conditionalBranch(body, invalid, rejected, accepted)
      Emitter.setInsertionPoint(body, rejected)
      Emitter.unreachable(body)
      Emitter.setInsertionPoint(body, accepted)
      const base = Emitter.cast(
        body,
        'inttoptr',
        baseAddress,
        pointer,
        `execution${operation.destination.ordinal}_base`,
      )
      const storeWord = (offset: number, value: Value.Input) => {
        Emitter.store(
          body,
          value,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            base,
            offset,
            `execution${operation.destination.ordinal}_${offset}_ptr`,
          ),
        )
      }
      const packageOrdinal = program.layout.executionPackages.plans.findIndex((candidate) =>
        ExecutionPackage.equals(candidate, operation.plan),
      )
      if (packageOrdinal < 0)
        throw new RangeError('LLVM execution initialization lost its package ordinal')
      const zero = Emitter.integerUnsigned(builder, usizeType, 0n)
      storeWord(0, zero)
      storeWord(
        program.layout.target.pointerSize,
        Emitter.integerUnsigned(builder, usizeType, BigInt(packageOrdinal)),
      )
      for (const role of ['WakeControl', 'InitialContinuationSegment'] as const) {
        const offset = componentOffset(operation.plan, role)
        if (offset === undefined) continue
        for (
          let word = 0;
          word < (role === 'InitialContinuationSegment' ? ContinuationTransfer.headerWords : 4);
          word += 1
        )
          storeWord(offset + word * program.layout.target.pointerSize, zero)
      }
      const allocationOffset = componentOffset(operation.plan, 'AllocationAuthority')
      const bodyOffset = componentOffset(operation.plan, 'BodyEnvironment')
      if (allocationOffset === undefined || bodyOffset === undefined)
        throw new RangeError('LLVM execution initialization lost package components')
      const allocationLanes = Layout.callingShape(program.layout, SilkType.allocation)?.lanes ?? []
      for (const [ordinal, lane] of allocationLanes.entries()) {
        const value = allocation.at(ordinal)
        const offset = LayoutVerify.laneOffset(program.layout, SilkType.allocation, lane.path)
        if (value === undefined || offset === undefined)
          throw new RangeError('LLVM execution initialization lost allocation lane')
        storeWord(allocationOffset + offset, value)
      }
      storePackageValue(
        context,
        base,
        operation.body,
        operation.plan.specialization.body,
        bodyOffset,
        `execution${operation.destination.ordinal}_body`,
      )
      const endpointOffset = componentOffset(operation.plan, 'EndpointState')
      if (endpointOffset !== undefined)
        storePackageValue(
          context,
          base,
          operation.endpoint,
          operation.plan.specialization.endpoint,
          endpointOffset,
          `execution${operation.destination.ordinal}_endpoint`,
        )
      const callbackOffset = componentOffset(operation.plan, 'EndpointCallback')
      if (callbackOffset !== undefined)
        storePackageValue(
          context,
          base,
          operation.callback,
          operation.plan.specialization.callback,
          callbackOffset,
          `execution${operation.destination.ordinal}_callback`,
        )
      NativeStorage.writeLocal(storage, operation.destination.ordinal, [base])
      return
    }
    case 'ExecutionPark': {
      context.runtimeFeatures.add('DormantContinuation')
      context.runtimeFeatures.add('ExternalWakeCell')
      const transfer = context.call.transferPointer
      const region = context.suspensionRegions.get(operation)
      const packages = program.layout.executionPackages.plans.filter(
        (candidate) => candidate.readinessStorage,
      )
      if (
        transfer === undefined ||
        region?._tag !== 'RunSuspendableEffectRegion' ||
        packages.length === 0
      )
        throw new RangeError('LLVM park lost external transfer authority')
      const baseAddress = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          transfer,
          program.layout.target.pointerSize * 3,
          `park${operation.destination.ordinal}_active_ptr`,
        ),
        `park${operation.destination.ordinal}_active`,
      )
      const base = Emitter.cast(
        body,
        'inttoptr',
        baseAddress,
        pointer,
        `park${operation.destination.ordinal}_base`,
      )
      const controlStorage = Emitter.alloca(
        body,
        pointer,
        `park${operation.destination.ordinal}_control_slot`,
      )
      const storedPackage = Emitter.load(
        body,
        usizeType,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          program.layout.target.pointerSize,
          `park${operation.destination.ordinal}_package_ptr`,
        ),
        `park${operation.destination.ordinal}_package`,
      )
      const packageSelected = Emitter.block(
        body,
        `park${operation.destination.ordinal}_package_selected`,
      )
      let packageOtherwise: LlvmBlock.Block | undefined
      for (const package_ of packages) {
        const ordinal = program.layout.executionPackages.plans.findIndex((candidate) =>
          ExecutionPackage.equals(candidate, package_),
        )
        const control = componentOffset(package_, 'WakeControl')
        if (ordinal < 0 || control === undefined)
          throw new RangeError('LLVM park lost a wake-control package ordinal')
        if (packageOtherwise !== undefined) Emitter.setInsertionPoint(body, packageOtherwise)
        const selected = Emitter.block(
          body,
          `park${operation.destination.ordinal}_package_${ordinal}`,
        )
        const otherwise = Emitter.block(
          body,
          `park${operation.destination.ordinal}_package_${ordinal}_otherwise`,
        )
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            storedPackage,
            Emitter.integerUnsigned(builder, usizeType, BigInt(ordinal)),
            `park${operation.destination.ordinal}_package_${ordinal}_matches`,
          ),
          selected,
          otherwise,
        )
        Emitter.setInsertionPoint(body, selected)
        Emitter.store(
          body,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            base,
            control,
            `park${operation.destination.ordinal}_package_${ordinal}_control`,
          ),
          controlStorage,
        )
        Emitter.branch(body, packageSelected)
        packageOtherwise = otherwise
      }
      if (packageOtherwise === undefined)
        throw new RangeError('LLVM park lost every wake-control package')
      Emitter.setInsertionPoint(body, packageOtherwise)
      Emitter.unreachable(body)
      Emitter.setInsertionPoint(body, packageSelected)
      const phasePointer = Emitter.load(
        body,
        pointer,
        controlStorage,
        `park${operation.destination.ordinal}_phase_ptr`,
      )
      const generationPointer = NativeLanePointer.lanePointer(
        lanePointers,
        body,
        phasePointer,
        program.layout.target.pointerSize,
        `park${operation.destination.ordinal}_generation_ptr`,
      )
      const generation = Emitter.load(
        body,
        usizeType,
        generationPointer,
        `park${operation.destination.ordinal}_generation`,
      )
      Emitter.store(
        body,
        Emitter.binary(
          body,
          'add',
          generation,
          Emitter.integerUnsigned(builder, usizeType, 1n),
          `park${operation.destination.ordinal}_next_generation`,
        ),
        generationPointer,
      )
      Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 1n), phasePointer)
      const guard = applyCallable(
        context,
        operation.register,
        operation.registrationTypeArguments,
        [[base]],
        `park${operation.destination.ordinal}_register`,
      )
      NativeStorage.writeLocal(storage, operation.guard.ordinal, guard)
      const phase = Emitter.load(
        body,
        usizeType,
        phasePointer,
        `park${operation.destination.ordinal}_phase`,
      )
      const latched = Emitter.integerCompare(
        body,
        'eq',
        phase,
        Emitter.integerUnsigned(builder, usizeType, 2n),
        `park${operation.destination.ordinal}_latched`,
      )
      const keepLatched = Emitter.block(body, `park${operation.destination.ordinal}_keep_latched`)
      const dormant = Emitter.block(body, `park${operation.destination.ordinal}_dormant`)
      const relinquish = Emitter.block(body, `park${operation.destination.ordinal}_relinquish`)
      Emitter.conditionalBranch(body, latched, keepLatched, dormant)
      Emitter.setInsertionPoint(body, keepLatched)
      Emitter.branch(body, relinquish)
      Emitter.setInsertionPoint(body, dormant)
      Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 3n), phasePointer)
      Emitter.branch(body, relinquish)
      Emitter.setInsertionPoint(body, relinquish)
      NativeCall.retainRelay(context.call, region, `park${operation.destination.ordinal}`)
      NativeSuspension.returnStep(
        context.call.returns,
        2n,
        [],
        `park${operation.destination.ordinal}_external`,
      )
      const resumeBlock = context.suspension.resumeBlocks.get(suspensionPointKey(region.point))
      if (resumeBlock === undefined)
        throw new RangeError('LLVM park lost its verified resume label')
      Emitter.setInsertionPoint(body, resumeBlock)
      NativeSuspension.restoreRelayPayload(
        context.suspension,
        region,
        `park${operation.destination.ordinal}`,
      )
      NativeAggregate.dropThroughPlan(
        context.cleanup,
        operation.guardCleanup,
        NativePayload.local(storage, operation.guard),
        `park${operation.destination.ordinal}_guard`,
      )
      NativeStorage.writeLocal(storage, operation.destination.ordinal, [])
      return
    }
    case 'ExecutionDrive': {
      context.runtimeFeatures.add('ExecutionDrive')
      const executionType = context.entry.fn.localTypes.at(operation.execution.ordinal)
      const executionResult =
        executionType?._tag === 'Nominal' && SilkType.isExecution(executionType.type)
          ? SilkType.typeArgumentAt(executionType.type, 0)
          : undefined
      const matchingPackages = program.layout.executionPackages.plans.filter(
        (package_) =>
          executionResult !== undefined &&
          SilkType.equals(package_.specialization.result, executionResult),
      )
      if (matchingPackages.length === 0)
        throw new RangeError('LLVM execution drive lost every result package specialization')
      const base = NativeStorage.materialize(storage, operation.execution).at(0)
      if (base === undefined)
        throw new RangeError('LLVM execution drive lost its package reference')
      const emitDirectPackage = (package_: ExecutionPackage.Plan) => {
        if (package_.specialization.suspension.modes.length !== 0)
          throw new RangeError('LLVM direct execution selected a suspendable package')
        const statePointer = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          0,
          `drive${operation.destination.ordinal}_direct_state_ptr`,
        )
        const packagePointer = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          program.layout.target.pointerSize,
          `drive${operation.destination.ordinal}_direct_package_ptr`,
        )
        const packageOrdinal = program.layout.executionPackages.plans.findIndex((candidate) =>
          ExecutionPackage.equals(candidate, package_),
        )
        if (packageOrdinal < 0)
          throw new RangeError('LLVM direct execution lost its package ordinal')
        const state = Emitter.load(
          body,
          usizeType,
          statePointer,
          `drive${operation.destination.ordinal}_direct_state`,
        )
        const storedPackage = Emitter.load(
          body,
          usizeType,
          packagePointer,
          `drive${operation.destination.ordinal}_direct_package`,
        )
        const unpublished = Emitter.integerCompare(
          body,
          'eq',
          state,
          Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Initial'))),
          `drive${operation.destination.ordinal}_direct_initial`,
        )
        const initialReady = Emitter.integerCompare(
          body,
          'eq',
          state,
          Emitter.integerUnsigned(
            builder,
            usizeType,
            BigInt(ExecutionTransition.tagOf('InitialReady')),
          ),
          `drive${operation.destination.ordinal}_direct_initial_ready`,
        )
        const validState = Emitter.binary(
          body,
          'or',
          unpublished,
          initialReady,
          `drive${operation.destination.ordinal}_direct_ready`,
        )
        const validPackage = Emitter.integerCompare(
          body,
          'eq',
          storedPackage,
          Emitter.integerUnsigned(builder, usizeType, BigInt(packageOrdinal)),
          `drive${operation.destination.ordinal}_direct_valid_package`,
        )
        const valid = Emitter.binary(
          body,
          'and',
          validState,
          validPackage,
          `drive${operation.destination.ordinal}_direct_valid`,
        )
        const accepted = Emitter.block(
          body,
          `drive${operation.destination.ordinal}_direct_accepted`,
        )
        Emitter.conditionalBranch(
          body,
          valid,
          accepted,
          NativeTermination.trapBlock(
            context.termination,
            'invalid execution drive',
            operation.provenance.span,
          ),
        )
        Emitter.setInsertionPoint(body, accepted)
        Emitter.store(
          body,
          Emitter.integerUnsigned(builder, usizeType, BigInt(ExecutionTransition.tagOf('Running'))),
          statePointer,
        )
        const executable = bodyOperands(
          context,
          package_,
          base,
          `drive${operation.destination.ordinal}_direct_body`,
        )
        if (executable.target.suspendable)
          throw new RangeError('LLVM direct execution selected a suspendable body')
        const resultAddress = NativeResult.allocate(
          body,
          executable.target,
          `drive${operation.destination.ordinal}_direct_result`,
        )
        const started = Emitter.callDirect(
          body,
          executable.target.handle,
          NativeResult.argumentsFor(
            executable.target,
            NativeCall.lowerArguments(
              context.call.synchronous,
              executable.target,
              NativeArgument.fromValues(executable.values),
              'Independent',
            ),
            resultAddress,
          ),
          `drive${operation.destination.ordinal}_direct_started`,
        )
        const completedResult = NativeResult.read(
          body,
          executable.target,
          started,
          resultAddress,
          `drive${operation.destination.ordinal}_direct_result`,
        )
        const outcome = NativeDiagnosticOutcome.consume(
          context.call.synchronous.diagnostic,
          completedResult,
        )
        const outcomeTag = outcome.at(0)
        if (outcomeTag === undefined)
          throw new RangeError('LLVM direct execution body lost its outcome tag')
        const succeeded = Emitter.block(
          body,
          `drive${operation.destination.ordinal}_direct_succeeded`,
        )
        const failed = Emitter.block(body, `drive${operation.destination.ordinal}_direct_failed`)
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            outcomeTag,
            Emitter.integerSigned(builder, i32, 0n),
            `drive${operation.destination.ordinal}_direct_success`,
          ),
          succeeded,
          failed,
        )
        Emitter.setInsertionPoint(body, failed)
        Emitter.unreachable(body)
        Emitter.setInsertionPoint(body, succeeded)
        const resultValues = outcome.slice(1)
        NativeStorage.writeLocal(storage, operation.result.ordinal, resultValues)
        NativeAggregate.dropThroughPlan(
          context.cleanup,
          operation.suspensionCleanup,
          NativePayload.local(storage, operation.onSuspend),
          `drive${operation.destination.ordinal}_direct_unused_suspend`,
        )
        Emitter.store(
          body,
          Emitter.integerUnsigned(
            builder,
            usizeType,
            BigInt(ExecutionTransition.tagOf('Completed')),
          ),
          statePointer,
        )
        releasePackage(
          context,
          package_,
          base,
          `drive${operation.destination.ordinal}_direct_complete`,
        )
        NativeStorage.writeLocal(
          storage,
          operation.destination.ordinal,
          applyCallable(
            context,
            operation.onComplete,
            operation.completionTypeArguments,
            [NativeStorage.materialize(storage, operation.branch), resultValues],
            `drive${operation.destination.ordinal}_direct_on_complete`,
          ),
        )
      }
      const emitPackage = (package_: ExecutionPackage.Plan) => {
        if (!package_.initialContinuationSegment) {
          emitDirectPackage(package_)
          return
        }
        const continuationOffset = componentOffset(package_, 'InitialContinuationSegment')
        const childThunkType = context.childThunkType
        const resumeThunkType = context.resumeThunkType
        if (
          base === undefined ||
          continuationOffset === undefined ||
          childThunkType === undefined ||
          resumeThunkType === undefined
        )
          throw new RangeError('LLVM execution drive lost independent suspension storage')
        const baseAddress = Emitter.cast(
          body,
          'ptrtoint',
          base,
          usizeType,
          `drive${operation.destination.ordinal}_base_address`,
        )
        const transfer = Emitter.alloca(
          body,
          context.suspension.i8,
          `drive${operation.destination.ordinal}_transfer`,
          {
            count: Emitter.integerUnsigned(
              builder,
              i32,
              BigInt(Math.max(context.transferStorageSize, 1)),
            ),
            alignment: Emitter.alignment(body, program.layout.target.pointerAlignment),
          },
        )
        const statePointer = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          0,
          `drive${operation.destination.ordinal}_state_ptr`,
        )
        const packagePointer = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          program.layout.target.pointerSize,
          `drive${operation.destination.ordinal}_package_ptr`,
        )
        const packageOrdinal = program.layout.executionPackages.plans.findIndex((candidate) =>
          ExecutionPackage.equals(candidate, package_),
        )
        if (packageOrdinal < 0) throw new RangeError('LLVM execution drive lost package ordinal')
        const storedPackage = Emitter.load(
          body,
          usizeType,
          packagePointer,
          `drive${operation.destination.ordinal}_package`,
        )
        const state = Emitter.load(
          body,
          usizeType,
          statePointer,
          `drive${operation.destination.ordinal}_state`,
        )
        const unpublished = Emitter.integerCompare(
          body,
          'eq',
          state,
          Emitter.integerUnsigned(builder, usizeType, 0n),
          `drive${operation.destination.ordinal}_initial`,
        )
        const initialReady = Emitter.integerCompare(
          body,
          'eq',
          state,
          Emitter.integerUnsigned(
            builder,
            usizeType,
            BigInt(ExecutionTransition.tagOf('InitialReady')),
          ),
          `drive${operation.destination.ordinal}_initial_ready`,
        )
        const initial = Emitter.binary(
          body,
          'or',
          unpublished,
          initialReady,
          `drive${operation.destination.ordinal}_initial_any`,
        )
        const eligible = Emitter.integerCompare(
          body,
          'eq',
          state,
          Emitter.integerUnsigned(builder, usizeType, 4n),
          `drive${operation.destination.ordinal}_eligible`,
        )
        const validState = Emitter.binary(
          body,
          'or',
          initial,
          eligible,
          `drive${operation.destination.ordinal}_valid_state`,
        )
        const validPackage = Emitter.integerCompare(
          body,
          'eq',
          storedPackage,
          Emitter.integerUnsigned(builder, usizeType, BigInt(packageOrdinal)),
          `drive${operation.destination.ordinal}_valid_package`,
        )
        const valid = Emitter.binary(
          body,
          'and',
          validState,
          validPackage,
          `drive${operation.destination.ordinal}_valid`,
        )
        const accepted = Emitter.block(body, `drive${operation.destination.ordinal}_accepted`)
        Emitter.conditionalBranch(
          body,
          valid,
          accepted,
          NativeTermination.trapBlock(
            context.termination,
            'invalid execution drive',
            operation.provenance.span,
          ),
        )
        Emitter.setInsertionPoint(body, accepted)
        const storageComponent = context.cleanup.executionStorage
        if (storageComponent === undefined)
          throw new RangeError('Execution drive lost storage component')
        const storedStateSlot = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          continuationOffset +
            NativeExecutionStorage.stateOffset(program.layout.target.pointerSize),
          `drive${operation.destination.ordinal}_stored_storage_slot`,
        )
        const transferStateSlot = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          transfer,
          NativeExecutionStorage.stateOffset(program.layout.target.pointerSize),
          `drive${operation.destination.ordinal}_transfer_storage_slot`,
        )
        Emitter.store(
          body,
          Emitter.load(
            body,
            pointer,
            storedStateSlot,
            `drive${operation.destination.ordinal}_storage_state`,
          ),
          transferStateSlot,
        )
        Emitter.store(
          body,
          baseAddress,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            transfer,
            program.layout.target.pointerSize * 3,
            `drive${operation.destination.ordinal}_active`,
          ),
        )
        Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 1n), statePointer)
        const statusStorage = Emitter.alloca(
          body,
          i32,
          `drive${operation.destination.ordinal}_status_slot`,
        )
        const initialBlock = Emitter.block(body, `drive${operation.destination.ordinal}_start`)
        const resumeBlock = Emitter.block(body, `drive${operation.destination.ordinal}_resume`)
        const loop = Emitter.block(body, `drive${operation.destination.ordinal}_loop`)
        const operationFollowing = Emitter.block(
          body,
          `drive${operation.destination.ordinal}_following`,
        )
        const headPointer = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          transfer,
          program.layout.target.pointerSize,
          `drive${operation.destination.ordinal}_head_ptr`,
        )
        const appendPointerPointer = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          transfer,
          program.layout.target.pointerSize * 2,
          `drive${operation.destination.ordinal}_append_ptr_ptr`,
        )
        Emitter.conditionalBranch(body, initial, initialBlock, resumeBlock)

        Emitter.setInsertionPoint(body, initialBlock)
        const nullPointer = Emitter.nullValue(builder, pointer)
        Emitter.store(body, nullPointer, headPointer)
        Emitter.store(body, headPointer, appendPointerPointer)
        const executable = bodyOperands(
          context,
          package_,
          base,
          `drive${operation.destination.ordinal}_body`,
        )
        const resultAddress = NativeResult.allocate(
          body,
          executable.target,
          `drive${operation.destination.ordinal}_result`,
        )
        const callArguments = NativeResult.argumentsFor(
          executable.target,
          NativeCall.lowerArguments(
            context.call.synchronous,
            executable.target,
            NativeArgument.fromValues(executable.values),
            'Independent',
          ),
          resultAddress,
        )
        const started = Emitter.callDirect(
          body,
          executable.target.handle,
          executable.target.suspendable
            ? [...callArguments, transfer, nullPointer, Emitter.integerUnsigned(builder, i32, 0n)]
            : callArguments,
          `drive${operation.destination.ordinal}_started`,
        )
        const outcomeLanes = NativeType.lanesFor(context.types, executable.target.fn.result)
        const initialResult = NativeResult.read(
          body,
          executable.target,
          started,
          resultAddress,
          `drive${operation.destination.ordinal}_initial_result`,
          executable.target.suspendable ? 'SuspensionStep' : 'Synchronous',
        )
        const startedValues = initialResult.values
        if (initialResult.diagnostic !== undefined)
          NativeDiagnosticTransfer.publish(
            { builder, body, wordSize: program.layout.target.pointerSize, transfer },
            initialResult.diagnostic,
          )
        const packedOutcome = ValueStorage.transport(
          program.layout.target,
          outcomeLanes,
          context.suspension.transferResultOffset,
        )
        for (const [ordinal, lane] of packedOutcome.entries.entries()) {
          const value = startedValues.at(ordinal)
          if (value === undefined) throw new RangeError('LLVM execution body lost an outcome lane')
          Emitter.store(
            body,
            value,
            NativeLanePointer.lanePointer(
              lanePointers,
              body,
              transfer,
              lane.offset,
              `drive${operation.destination.ordinal}_initial_result${ordinal}_ptr`,
            ),
          )
        }
        const startedStatus =
          executable.target.suspendable && started !== undefined
            ? NativeResult.status(
                body,
                executable.target,
                started,
                `drive${operation.destination.ordinal}_initial_status`,
              )
            : Emitter.integerUnsigned(builder, i32, 0n)
        Emitter.store(body, startedStatus, statusStorage)
        Emitter.branch(body, loop)

        Emitter.setInsertionPoint(body, resumeBlock)
        const savedHead = Emitter.load(
          body,
          pointer,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            base,
            continuationOffset,
            `drive${operation.destination.ordinal}_saved_head_ptr`,
          ),
          `drive${operation.destination.ordinal}_saved_head`,
        )
        const savedNext = Emitter.load(
          body,
          pointer,
          savedHead,
          `drive${operation.destination.ordinal}_saved_next`,
        )
        Emitter.store(body, savedNext, headPointer)
        Emitter.store(body, headPointer, appendPointerPointer)
        const resumeFunction = Emitter.load(
          body,
          pointer,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            savedHead,
            program.layout.target.pointerSize,
            `drive${operation.destination.ordinal}_resume_fn_ptr`,
          ),
          `drive${operation.destination.ordinal}_resume_fn`,
        )
        const resumed = Emitter.call(
          body,
          resumeThunkType,
          resumeFunction,
          [transfer, savedHead],
          `drive${operation.destination.ordinal}_resumed`,
        )
        if (resumed === undefined) throw new RangeError('LLVM execution resume returned no status')
        Emitter.store(body, resumed, statusStorage)
        Emitter.branch(body, loop)

        Emitter.setInsertionPoint(body, loop)
        const status = Emitter.load(
          body,
          i32,
          statusStorage,
          `drive${operation.destination.ordinal}_status`,
        )
        const external = Emitter.block(body, `drive${operation.destination.ordinal}_external`)
        const notExternal = Emitter.block(
          body,
          `drive${operation.destination.ordinal}_not_external`,
        )
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            status,
            Emitter.integerUnsigned(builder, i32, 2n),
            `drive${operation.destination.ordinal}_is_external`,
          ),
          external,
          notExternal,
        )

        Emitter.setInsertionPoint(body, notExternal)
        const child = Emitter.block(body, `drive${operation.destination.ordinal}_child`)
        const completed = Emitter.block(
          body,
          `drive${operation.destination.ordinal}_completed_step`,
        )
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            status,
            Emitter.integerUnsigned(builder, i32, 1n),
            `drive${operation.destination.ordinal}_is_child`,
          ),
          child,
          completed,
        )
        Emitter.setInsertionPoint(body, child)
        const childFunction = Emitter.load(
          body,
          pointer,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            transfer,
            0,
            `drive${operation.destination.ordinal}_child_ptr`,
          ),
          `drive${operation.destination.ordinal}_child_fn`,
        )
        const childStatus = Emitter.call(
          body,
          childThunkType,
          childFunction,
          [transfer],
          `drive${operation.destination.ordinal}_child_step`,
        )
        if (childStatus === undefined)
          throw new RangeError('LLVM execution child returned no status')
        Emitter.store(body, childStatus, statusStorage)
        Emitter.branch(body, loop)

        Emitter.setInsertionPoint(body, completed)
        const head = Emitter.load(
          body,
          pointer,
          headPointer,
          `drive${operation.destination.ordinal}_head`,
        )
        const finish = Emitter.block(body, `drive${operation.destination.ordinal}_finish`)
        const resumeParent = Emitter.block(
          body,
          `drive${operation.destination.ordinal}_resume_parent`,
        )
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            Emitter.cast(
              body,
              'ptrtoint',
              head,
              usizeType,
              `drive${operation.destination.ordinal}_head_address`,
            ),
            Emitter.integerUnsigned(builder, usizeType, 0n),
            `drive${operation.destination.ordinal}_at_root`,
          ),
          finish,
          resumeParent,
        )
        Emitter.setInsertionPoint(body, resumeParent)
        const next = Emitter.load(
          body,
          pointer,
          head,
          `drive${operation.destination.ordinal}_next_head`,
        )
        Emitter.store(body, next, headPointer)
        Emitter.store(body, headPointer, appendPointerPointer)
        const parentResume = Emitter.load(
          body,
          pointer,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            head,
            program.layout.target.pointerSize,
            `drive${operation.destination.ordinal}_parent_resume_ptr`,
          ),
          `drive${operation.destination.ordinal}_parent_resume`,
        )
        const parentStatus = Emitter.call(
          body,
          resumeThunkType,
          parentResume,
          [transfer, head],
          `drive${operation.destination.ordinal}_parent_step`,
        )
        if (parentStatus === undefined)
          throw new RangeError('LLVM execution parent returned no status')
        Emitter.store(body, parentStatus, statusStorage)
        Emitter.branch(body, loop)

        Emitter.setInsertionPoint(body, finish)
        if (executable.target.diagnosticResult !== undefined)
          NativeDiagnosticOutcome.consume(context.call.synchronous.diagnostic, {
            values: [],
            diagnostic: NativeDiagnosticTransfer.take(
              { builder, body, wordSize: program.layout.target.pointerSize, transfer },
              executable.target.diagnosticResult,
            ),
          })
        NativeExecutionStorage.destroy(
          { builder, body, pointer, usizeType, storage: storageComponent },
          transferStateSlot,
          `drive${operation.destination.ordinal}_storage`,
        )
        Emitter.store(body, Emitter.nullValue(builder, pointer), storedStateSlot)
        const outcome: Array<Value.Input> = []
        for (const [ordinal, lane] of packedOutcome.entries.entries())
          outcome.push(
            Emitter.load(
              body,
              NativeType.laneType(context.types, lane.lane),
              NativeLanePointer.lanePointer(
                lanePointers,
                body,
                transfer,
                lane.offset,
                `drive${operation.destination.ordinal}_outcome${ordinal}_ptr`,
              ),
              `drive${operation.destination.ordinal}_outcome${ordinal}`,
            ),
          )
        const outcomeTag = outcome.at(0)
        if (outcomeTag === undefined)
          throw new RangeError('LLVM execution body lost its outcome tag')
        const succeeded = Emitter.block(body, `drive${operation.destination.ordinal}_succeeded`)
        const failed = Emitter.block(body, `drive${operation.destination.ordinal}_failed`)
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            outcomeTag,
            Emitter.integerSigned(builder, i32, 0n),
            `drive${operation.destination.ordinal}_success`,
          ),
          succeeded,
          failed,
        )
        Emitter.setInsertionPoint(body, failed)
        Emitter.unreachable(body)
        Emitter.setInsertionPoint(body, succeeded)
        const resultValues = outcome.slice(1)
        NativeStorage.writeLocal(storage, operation.result.ordinal, resultValues)
        NativeAggregate.dropThroughPlan(
          context.cleanup,
          operation.suspensionCleanup,
          NativePayload.local(storage, operation.onSuspend),
          `drive${operation.destination.ordinal}_unused_suspend`,
        )
        Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 5n), statePointer)
        releasePackage(context, package_, base, `drive${operation.destination.ordinal}_complete`)
        NativeStorage.writeLocal(
          storage,
          operation.destination.ordinal,
          applyCallable(
            context,
            operation.onComplete,
            operation.completionTypeArguments,
            [NativeStorage.materialize(storage, operation.branch), resultValues],
            `drive${operation.destination.ordinal}_on_complete`,
          ),
        )
        Emitter.branch(body, operationFollowing)

        Emitter.setInsertionPoint(body, external)
        Emitter.store(
          body,
          Emitter.load(
            body,
            pointer,
            transferStateSlot,
            `drive${operation.destination.ordinal}_parked_storage`,
          ),
          storedStateSlot,
        )
        const transferredHead = Emitter.load(
          body,
          pointer,
          headPointer,
          `drive${operation.destination.ordinal}_transferred_head`,
        )
        const transferredAppend = Emitter.load(
          body,
          pointer,
          appendPointerPointer,
          `drive${operation.destination.ordinal}_transferred_append`,
        )
        Emitter.store(
          body,
          transferredHead,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            base,
            continuationOffset,
            `drive${operation.destination.ordinal}_store_head`,
          ),
        )
        Emitter.store(
          body,
          transferredAppend,
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            base,
            continuationOffset + program.layout.target.pointerSize,
            `drive${operation.destination.ordinal}_store_append`,
          ),
        )
        NativeAggregate.dropThroughPlan(
          context.cleanup,
          operation.completionCleanup,
          NativePayload.local(storage, operation.onComplete),
          `drive${operation.destination.ordinal}_unused_complete`,
        )
        const suspendedResult = applyCallable(
          context,
          operation.onSuspend,
          operation.suspensionTypeArguments,
          [NativeStorage.materialize(storage, operation.branch), [base]],
          `drive${operation.destination.ordinal}_on_suspend`,
        )
        const controlOffset = componentOffset(package_, 'WakeControl')
        if (controlOffset === undefined) {
          Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 2n), statePointer)
        } else {
          const phasePointer = NativeLanePointer.lanePointer(
            lanePointers,
            body,
            base,
            controlOffset,
            `drive${operation.destination.ordinal}_phase_ptr`,
          )
          const phase = Emitter.load(
            body,
            usizeType,
            phasePointer,
            `drive${operation.destination.ordinal}_phase`,
          )
          const following = Emitter.block(body, `drive${operation.destination.ordinal}_suspended`)
          const destroyedAfterSuspend = Emitter.block(
            body,
            `drive${operation.destination.ordinal}_destroyed_after_suspend`,
          )
          const retainedAfterSuspend = Emitter.block(
            body,
            `drive${operation.destination.ordinal}_retained_after_suspend`,
          )
          const stateAfterSuspend = Emitter.load(
            body,
            usizeType,
            statePointer,
            `drive${operation.destination.ordinal}_state_after_suspend`,
          )
          Emitter.conditionalBranch(
            body,
            Emitter.integerCompare(
              body,
              'eq',
              stateAfterSuspend,
              Emitter.integerUnsigned(builder, usizeType, 7n),
              `drive${operation.destination.ordinal}_destroy_pending_after_suspend`,
            ),
            destroyedAfterSuspend,
            retainedAfterSuspend,
          )
          Emitter.setInsertionPoint(body, destroyedAfterSuspend)
          dropActivatedPackage(
            context.cleanup,
            package_,
            base,
            `drive${operation.destination.ordinal}_destroyed_after_suspend`,
          )
          Emitter.branch(body, following)

          Emitter.setInsertionPoint(body, retainedAfterSuspend)
          const notify = Emitter.block(body, `drive${operation.destination.ordinal}_notify`)
          const dormant = Emitter.block(body, `drive${operation.destination.ordinal}_dormant`)
          Emitter.conditionalBranch(
            body,
            Emitter.integerCompare(
              body,
              'eq',
              phase,
              Emitter.integerUnsigned(builder, usizeType, 2n),
              `drive${operation.destination.ordinal}_latched`,
            ),
            notify,
            dormant,
          )
          Emitter.setInsertionPoint(body, dormant)
          Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 3n), phasePointer)
          Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 2n), statePointer)
          Emitter.branch(body, following)
          Emitter.setInsertionPoint(body, notify)
          Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 3n), statePointer)
          Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 4n), phasePointer)
          notifyReady(context, package_, base, `drive${operation.destination.ordinal}_ready`)
          const stateAfterNotify = Emitter.load(
            body,
            usizeType,
            statePointer,
            `drive${operation.destination.ordinal}_state_after_notify`,
          )
          const destroyedAfterNotify = Emitter.block(
            body,
            `drive${operation.destination.ordinal}_destroyed_after_notify`,
          )
          const eligibleAfterNotify = Emitter.block(
            body,
            `drive${operation.destination.ordinal}_eligible_after_notify`,
          )
          Emitter.conditionalBranch(
            body,
            Emitter.integerCompare(
              body,
              'eq',
              stateAfterNotify,
              Emitter.integerUnsigned(builder, usizeType, 7n),
              `drive${operation.destination.ordinal}_destroy_pending_after_notify`,
            ),
            destroyedAfterNotify,
            eligibleAfterNotify,
          )
          Emitter.setInsertionPoint(body, destroyedAfterNotify)
          dropActivatedPackage(
            context.cleanup,
            package_,
            base,
            `drive${operation.destination.ordinal}_destroyed_after_notify`,
          )

          Emitter.branch(body, following)
          Emitter.setInsertionPoint(body, eligibleAfterNotify)
          Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 5n), phasePointer)
          Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 4n), statePointer)
          Emitter.branch(body, following)
          Emitter.setInsertionPoint(body, following)
        }
        NativeStorage.writeLocal(storage, operation.destination.ordinal, suspendedResult)
        Emitter.branch(body, operationFollowing)
        Emitter.setInsertionPoint(body, operationFollowing)
      }
      if (matchingPackages.length === 1) {
        const selected = matchingPackages.at(0)
        if (selected === undefined) throw new RangeError('LLVM execution drive lost its package')
        emitPackage(selected)
        return
      }
      selectPackageFrom(
        context.cleanup,
        base,
        matchingPackages,
        `drive${operation.destination.ordinal}`,
        emitPackage,
      )
      return
    }
    case 'ExecutionNotifyInitial': {
      context.runtimeFeatures.add('ReadinessNotification')
      const reference = NativeStorage.materialize(storage, operation.execution).at(0)
      if (reference === undefined)
        throw new RangeError('LLVM initial readiness lost its Execution reference')
      const baseAddress = Emitter.load(
        body,
        usizeType,
        reference,
        `notify_initial${operation.destination.ordinal}_base_address`,
      )
      const base = Emitter.cast(
        body,
        'inttoptr',
        baseAddress,
        context.pointer,
        `notify_initial${operation.destination.ordinal}_base`,
      )
      selectPackage(
        context.cleanup,
        base,
        `notify_initial${operation.destination.ordinal}`,
        (package_) =>
          (() => {
            const statePointer = NativeLanePointer.lanePointer(
              lanePointers,
              body,
              base,
              0,
              `notify_initial${operation.destination.ordinal}_state_ptr`,
            )
            const current = Emitter.load(
              body,
              usizeType,
              statePointer,
              `notify_initial${operation.destination.ordinal}_state`,
            )
            const accepted = Emitter.block(
              body,
              `notify_initial${operation.destination.ordinal}_accepted`,
            )
            const rejected = Emitter.block(
              body,
              `notify_initial${operation.destination.ordinal}_rejected`,
            )
            Emitter.conditionalBranch(
              body,
              Emitter.integerCompare(
                body,
                'eq',
                current,
                Emitter.integerUnsigned(
                  builder,
                  usizeType,
                  BigInt(ExecutionTransition.tagOf('Initial')),
                ),
                `notify_initial${operation.destination.ordinal}_is_initial`,
              ),
              accepted,
              rejected,
            )
            Emitter.setInsertionPoint(body, rejected)
            Emitter.unreachable(body)
            Emitter.setInsertionPoint(body, accepted)
            Emitter.store(
              body,
              Emitter.integerUnsigned(
                builder,
                usizeType,
                BigInt(ExecutionTransition.tagOf('InitialReady')),
              ),
              statePointer,
            )
            notifyReady(
              context,
              package_,
              base,
              `notify_initial${operation.destination.ordinal}_ready`,
            )
          })(),
      )
      NativeStorage.writeLocal(storage, operation.destination.ordinal, [])
      return
    }
    case 'ExecutionWake': {
      context.runtimeFeatures.add('ExternalWakeCell')
      const packages = program.layout.executionPackages.plans.filter(
        (candidate) => candidate.readinessStorage,
      )
      const base = NativeStorage.materialize(storage, operation.wake).at(0)
      if (packages.length === 0 || base === undefined)
        throw new RangeError('LLVM Wake lost its exact package authority')
      const emitPackage = (package_: ExecutionPackage.Plan) => {
        const controlOffset = componentOffset(package_, 'WakeControl')
        if (controlOffset === undefined)
          throw new RangeError('LLVM Wake package lost its control authority')
        const phasePointer = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          controlOffset,
          `wake${operation.destination.ordinal}_phase_ptr`,
        )
        const statePointer = NativeLanePointer.lanePointer(
          lanePointers,
          body,
          base,
          0,
          `wake${operation.destination.ordinal}_state_ptr`,
        )
        const phase = Emitter.load(
          body,
          usizeType,
          phasePointer,
          `wake${operation.destination.ordinal}_phase`,
        )
        const registering = Emitter.block(body, `wake${operation.destination.ordinal}_registering`)
        const notRegistering = Emitter.block(
          body,
          `wake${operation.destination.ordinal}_not_registering`,
        )
        const following = Emitter.block(body, `wake${operation.destination.ordinal}_following`)
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            phase,
            Emitter.integerUnsigned(builder, usizeType, 1n),
            `wake${operation.destination.ordinal}_is_registering`,
          ),
          registering,
          notRegistering,
        )
        Emitter.setInsertionPoint(body, registering)
        Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 2n), phasePointer)
        Emitter.branch(body, following)

        Emitter.setInsertionPoint(body, notRegistering)
        const dormant = Emitter.block(body, `wake${operation.destination.ordinal}_dormant`)
        const notDormant = Emitter.block(body, `wake${operation.destination.ordinal}_not_dormant`)
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            phase,
            Emitter.integerUnsigned(builder, usizeType, 3n),
            `wake${operation.destination.ordinal}_is_dormant`,
          ),
          dormant,
          notDormant,
        )
        Emitter.setInsertionPoint(body, dormant)
        Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 3n), statePointer)
        Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 4n), phasePointer)
        notifyReady(context, package_, base, `wake${operation.destination.ordinal}_ready`)
        const stateAfterNotify = Emitter.load(
          body,
          usizeType,
          statePointer,
          `wake${operation.destination.ordinal}_state_after_notify`,
        )
        const destroyed = Emitter.block(body, `wake${operation.destination.ordinal}_destroyed`)
        const eligibleBlock = Emitter.block(body, `wake${operation.destination.ordinal}_eligible`)
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            stateAfterNotify,
            Emitter.integerUnsigned(builder, usizeType, 7n),
            `wake${operation.destination.ordinal}_destroy_pending`,
          ),
          destroyed,
          eligibleBlock,
        )
        Emitter.setInsertionPoint(body, destroyed)
        dropActivatedPackage(
          context.cleanup,
          package_,
          base,
          `wake${operation.destination.ordinal}_destroy`,
        )

        Emitter.branch(body, following)
        Emitter.setInsertionPoint(body, eligibleBlock)
        Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 5n), phasePointer)
        Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 4n), statePointer)
        Emitter.branch(body, following)

        Emitter.setInsertionPoint(body, notDormant)
        const cleanup = Emitter.block(body, `wake${operation.destination.ordinal}_during_cleanup`)
        const settled = Emitter.block(body, `wake${operation.destination.ordinal}_settled`)
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            phase,
            Emitter.integerUnsigned(builder, usizeType, cleanupWithWake),
            `wake${operation.destination.ordinal}_cleanup_active`,
          ),
          cleanup,
          settled,
        )
        Emitter.setInsertionPoint(body, cleanup)
        Emitter.store(
          body,
          Emitter.integerUnsigned(builder, usizeType, cleanupWithoutWake),
          phasePointer,
        )
        Emitter.branch(body, following)
        Emitter.setInsertionPoint(body, settled)
        const cancelled = Emitter.block(body, `wake${operation.destination.ordinal}_cancelled`)
        const invalid = Emitter.block(body, `wake${operation.destination.ordinal}_invalid`)
        Emitter.conditionalBranch(
          body,
          Emitter.integerCompare(
            body,
            'eq',
            phase,
            Emitter.integerUnsigned(builder, usizeType, 6n),
            `wake${operation.destination.ordinal}_is_cancelled`,
          ),
          cancelled,
          invalid,
        )
        Emitter.setInsertionPoint(body, cancelled)
        releaseAllocation(
          context,
          package_,
          base,
          `wake${operation.destination.ordinal}_late_release`,
        )
        Emitter.branch(body, following)
        Emitter.setInsertionPoint(body, invalid)
        Emitter.unreachable(body)
        Emitter.setInsertionPoint(body, following)
      }
      if (packages.length === 1) {
        const selected = packages.at(0)
        if (selected === undefined) throw new RangeError('LLVM Wake lost its package')
        emitPackage(selected)
      } else {
        selectPackageFrom(
          context.cleanup,
          base,
          packages,
          `wake${operation.destination.ordinal}`,
          emitPackage,
        )
      }
      NativeStorage.writeLocal(storage, operation.destination.ordinal, [])
      return
    }
  }
}
