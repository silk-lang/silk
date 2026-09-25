import * as NativeAssemblyOperation from './NativeAssemblyOperation.js'
import * as NativeDiagnosticScope from './NativeDiagnosticScope.js'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as CleanupPlan from './CleanupPlan.js'
import type * as Mir from './Mir.js'
import type { LinearOperation } from './MirLinearization.js'
import * as NativeCallOperation from './NativeCallOperation.js'
import * as NativeEffectOperation from './NativeEffectOperation.js'
import * as NativeExecutionOperation from './NativeExecutionOperation.js'
import * as NativeForeignOperation from './NativeForeignOperation.js'
import * as NativeLocalSharedOperation from './NativeLocalSharedOperation.js'
import * as NativeMemoryOperation from './NativeMemoryOperation.js'
import type * as NativeOperationContext from './NativeOperationContext.js'
import * as NativePlaceOperation from './NativePlaceOperation.js'
import * as NativePointerOperation from './NativePointerOperation.js'
import * as NativeScalarOperation from './NativeScalarOperation.js'
import type * as NativeTermination from './NativeTermination.js'
import * as NativeValueOperation from './NativeValueOperation.js'
/** Whether one MIR operation requires the native allocation ABI. */
export const needsAllocation = (operation: Mir.Operation): boolean =>
  operation._tag === 'Allocate' ||
  operation._tag === 'RawBufferFrom' ||
  operation._tag === 'SharedFromAllocation' ||
  operation._tag === 'SharedClone' ||
  operation._tag === 'SharedWithMut' ||
  operation._tag === 'RawBufferCount' ||
  operation._tag === 'RawBufferSlot' ||
  operation._tag === 'RawBufferRead' ||
  operation._tag === 'SliceView' ||
  operation._tag === 'RawBufferView' ||
  operation._tag === 'RawBufferCopy' ||
  operation._tag === 'RawBufferFill' ||
  operation._tag === 'SlotWrite' ||
  operation._tag === 'SlotTake' ||
  operation._tag === 'SlotCopy' ||
  operation._tag === 'SlotDrop' ||
  (operation._tag === 'Drop' && CleanupPlan.reclaims(operation.cleanup))

/** Dispatch-only native operation context; each sibling actor owns its lowering behavior. */
export interface LoweringContext {
  readonly value: NativeOperationContext.Context
  readonly memory: NativeOperationContext.Context
  readonly place: NativeOperationContext.Context
  readonly scalar: NativeOperationContext.Context
  readonly effect: NativeOperationContext.Context
  readonly execution: NativeOperationContext.Context
  readonly call: NativeOperationContext.Context
}
/** Mutable per-function dispatch state shared by cohesive operation actors. */
export interface State extends NativeTermination.TrapState {
  checkOrdinal: number
}

export const emit = (context: LoweringContext, operation: LinearOperation) => {
  switch (operation._tag) {
    case 'ReleaseDiagnosticOutcome':
      return NativeDiagnosticOutcome.releaseLocal(
        context.call.termination.diagnostic,
        operation.outcome,
      )
    case 'EnterDiagnosticScope':
    case 'LeaveDiagnosticScope':
      return NativeDiagnosticScope.emit(context.call, operation)
    case 'NativeAssembly':
      return NativeAssemblyOperation.emit(context.call, operation)
    case 'BindMatch':
    case 'Literal':
    case 'EnumConstant':
    case 'EnumValue':
    case 'EnumEquality':
    case 'StaticView':
    case 'StaticString':
    case 'StringFromUtf8Unchecked':
    case 'StringUtf8Bytes':
    case 'StringByteLength':
    case 'StringEqualsExact':
      return NativeValueOperation.emit(context.value, operation)
    case 'Allocate':
    case 'RawBufferFrom':
    case 'SharedFromAllocation':
    case 'SharedClone':
    case 'RawBufferCount':
    case 'RawBufferSlot':
    case 'RawBufferRead':
    case 'SliceView':
    case 'RawBufferView':
    case 'RawBufferCopy':
    case 'RawBufferFill':
    case 'SlotWrite':
    case 'ValidateLayout':
    case 'RepeatLayout':
    case 'SlotTake':
    case 'SlotCopy':
    case 'SlotDrop':
      return NativeMemoryOperation.emit(context.memory, operation)
    case 'SharedWithMut':
      return NativeLocalSharedOperation.emit(context.call, operation)
    case 'ExecutionFromAllocation':
    case 'ExecutionDrive':
    case 'ExecutionNotifyInitial':
    case 'ExecutionWake':
    case 'ExecutionPark':
      return NativeExecutionOperation.emit(context.execution, operation)
    case 'Move':
    case 'SetInitialized':
    case 'BeginLoan':
    case 'EndLoan':
    case 'SliceLength':
    case 'ConvertUnion':
    case 'Construct':
    case 'ConstructUnionVariant':
    case 'ConstructArray':
    case 'Project':
    case 'ReadPlace':
    case 'CheckPlace':
    case 'WritePlace':
      return NativePlaceOperation.emit(context.place, operation)
    case 'ConvertInteger':
    case 'ConvertScalar':
    case 'ReinterpretScalar':
    case 'FloatUnary':
    case 'FloatTranscendental':
    case 'CheckedScalarOutcome':
    case 'Binary':
      return NativeScalarOperation.emit(context.scalar, operation)
    case 'Drop':
    case 'MakeEffect':
    case 'MakeCallable':
    case 'PackEffectComposite':
    case 'UnpackEffectComposite':
    case 'PackEffectOutcome':
    case 'PackEffectFailureUnion':
    case 'UnpackEffectSuccess':
    case 'RunEffect':
    case 'RunEffectComposite':
    case 'RunEffectValue':
    case 'RunStaticEffect':
    case 'CatchEffect':
    case 'DiagnosticUnhandled':
      return NativeEffectOperation.emit(context.effect, operation)
    case 'ApplyCallable':
    case 'Call':
      return NativeCallOperation.emit(context.call, operation)
    case 'ForeignIndirectCall':
    case 'ForeignCall':
    case 'ForeignStaticLoad':
    case 'ForeignFunctionAddress':
      return NativeForeignOperation.emit(context.call, operation)
    case 'PointerNull':
    case 'PointerAddress':
    case 'PointerIsNull':
    case 'PointerBytes':
    case 'PointerReinterpret':
    case 'PointerRequalify':
    case 'PointerFromStorage':
    case 'PointerAt':
    case 'PointerRead':
    case 'PointerWrite':
      return NativePointerOperation.emit(context.memory, operation)
  }
}
