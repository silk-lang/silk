import * as Emitter from '@silklang/llvm/Emitter'
import * as NativePayload from './NativePayload.js'
import * as Layout from './Layout.js'
import type { LinearOperation } from './MirLinearization.js'
import * as NativeAggregate from './NativeAggregate.js'
import * as NativeCallOperation from './NativeCallOperation.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as SilkType from './Type.js'

type Operation = Extract<LinearOperation, { readonly _tag: 'SharedWithMut' }>

const callableArguments = (
  context: Context,
  local: Operation['use'],
): ReadonlyArray<SilkType.GenericArgument> => {
  const type = context.entry.fn.localTypes.at(local.ordinal)
  return type?._tag === 'CallableValue'
    ? ((type.environment === undefined
        ? undefined
        : Layout.callableTargetArguments(type.environment)) ??
        type.storage?.realization.targetArguments ??
        [])
    : []
}

/** Emits one closed local-shared access transition without exposing its state word. */
export const emit = (context: Context, operation: Operation) => {
  const {
    body,
    builder,
    cleanup,
    lanePointers,
    pointer,
    storage: nativeStorage,
    usizeType,
  } = context
  const self = NativeStorage.materialize(nativeStorage, operation.self).at(0)
  if (self === undefined || usizeType === undefined)
    throw new RangeError('LLVM local-shared access lost its borrowed handle')
  const baseAddress = Emitter.load(
    body,
    usizeType,
    self,
    `shared${operation.destination.ordinal}_base_address`,
  )
  const base = Emitter.cast(
    body,
    'inttoptr',
    baseAddress,
    pointer,
    `shared${operation.destination.ordinal}_base`,
  )
  const accessPointer = NativeLanePointer.lanePointer(
    lanePointers,
    body,
    base,
    operation.block.accessOffset,
    `shared${operation.destination.ordinal}_access_ptr`,
  )
  const access = Emitter.load(
    body,
    usizeType,
    accessPointer,
    `shared${operation.destination.ordinal}_access`,
  )
  const available = Emitter.integerCompare(
    body,
    'eq',
    access,
    Emitter.integerUnsigned(builder, usizeType, 0n),
    `shared${operation.destination.ordinal}_available`,
  )
  const useBlock = Emitter.block(body, `shared${operation.destination.ordinal}_use`)
  const conflictBlock = Emitter.block(body, `shared${operation.destination.ordinal}_conflict`)
  const following = Emitter.block(body, `shared${operation.destination.ordinal}_following`)
  Emitter.conditionalBranch(body, available, useBlock, conflictBlock)

  const initialLocals = new Map(nativeStorage.locals)
  const apply = (
    callable: Operation['use'],
    callableType: SilkType.Callable,
    arguments_: ReadonlyArray<Operation['payload']>,
  ) => {
    NativeCallOperation.emit(context, {
      _tag: 'ApplyCallable' as const,
      destination: operation.destination,
      callable,
      typeArguments: callableArguments(context, callable),
      captures: [],
      arguments: arguments_,
      callableType,
      access: 'Take' as const,
      evaluation: 'CalleeThenArguments' as const,
      realization: 'Environment' as const,
      type: operation.type,
      provenance: operation.provenance,
    })
    const realizedCallable = context.entry.fn.localTypes.at(callable.ordinal)
    const diverges =
      realizedCallable?._tag === 'CallableValue' && SilkType.isNever(realizedCallable.type.result)
    if (!diverges) NativeStorage.commitLocal(nativeStorage, operation.destination)
    return diverges
  }

  Emitter.setInsertionPoint(body, useBlock)
  nativeStorage.locals.clear()
  for (const [ordinal, values] of initialLocals) nativeStorage.locals.set(ordinal, values)
  Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 1n), accessPointer)
  NativeStorage.writeLocal(nativeStorage, operation.payload.ordinal, [
    NativeLanePointer.lanePointer(
      lanePointers,
      body,
      base,
      operation.block.valueOffset,
      `shared${operation.destination.ordinal}_payload`,
    ),
  ])
  const useDiverges = apply(operation.use, operation.useType, [operation.payload])
  if (useDiverges) {
    Emitter.unreachable(body)
  } else {
    Emitter.store(body, Emitter.integerUnsigned(builder, usizeType, 0n), accessPointer)
    NativeAggregate.dropThroughPlan(
      cleanup,
      operation.conflictCleanup,
      NativePayload.local(nativeStorage, operation.onConflict),
      `shared${operation.destination.ordinal}_unused_conflict`,
    )
    Emitter.branch(body, following)
  }

  Emitter.setInsertionPoint(body, conflictBlock)
  nativeStorage.locals.clear()
  for (const [ordinal, values] of initialLocals) nativeStorage.locals.set(ordinal, values)
  const conflictDiverges = apply(operation.onConflict, operation.conflictType, [])
  if (conflictDiverges) {
    Emitter.unreachable(body)
  } else {
    NativeAggregate.dropThroughPlan(
      cleanup,
      operation.useCleanup,
      NativePayload.local(nativeStorage, operation.use),
      `shared${operation.destination.ordinal}_unused_use`,
    )
    Emitter.branch(body, following)
  }

  Emitter.setInsertionPoint(body, following)
  NativeStorage.reloadRoots(nativeStorage, `shared${operation.destination.ordinal}_following`)
}
