import * as Emitter from '@silklang/llvm/Emitter'
import * as FunctionActor from '@silklang/llvm/Function'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import { suspensionPointKey } from './Backend.js'
import type * as Mir from './Mir.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeFrame from './NativeFrame.js'
import * as NativeSuspension from './NativeSuspension.js'
import * as NativeType from './NativeType.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'
import * as NativeResult from './NativeResult.js'
import * as NativeArgument from './NativeArgument.js'

export interface DeclaredTarget {
  /** Absent only for compiler-synthesized LLVM helpers with already-physical scalar inputs. */
  readonly argumentParameters?: ReadonlyArray<NativeArgument.Parameter>
  readonly handle: FunctionActor.Function
  readonly resultLaneCount: number
  readonly resultStorage?: NativeResult.Storage
  readonly diagnosticResult?: LlvmType.Type
  readonly suspendable: boolean
  readonly diagnosticParameter?: number
}

export interface SynchronousContext {
  readonly body: Emitter.Body
  readonly storage: NativeStorage.Context
  readonly diagnostic?: NativeDiagnosticContext.NativeDiagnosticContext
}

/** Ordinary calls inherit observation; independently owned execution bodies start a fresh root. */
export const argumentsFor = (
  context: Pick<SynchronousContext, 'diagnostic'>,
  target: Pick<DeclaredTarget, 'diagnosticParameter'>,
  arguments_: ReadonlyArray<Value.Input>,
  observation: 'Inherited' | 'Independent' = 'Inherited',
) => {
  if (target.diagnosticParameter === undefined) return arguments_
  if (context.diagnostic === undefined)
    throw new RangeError('Native call lost its invocation diagnostic context')
  if (arguments_.length !== target.diagnosticParameter)
    throw new RangeError('Native call diagnostic argument is not after its source parameters')
  return [
    ...arguments_,
    observation === 'Independent'
      ? Emitter.nullValue(context.diagnostic.builder, context.diagnostic.pointer)
      : NativeDiagnosticContext.current(context.diagnostic),
    observation === 'Independent'
      ? Emitter.nullValue(context.diagnostic.builder, context.diagnostic.causeType)
      : NativeDiagnosticContext.currentCause(context.diagnostic),
  ]
}

/** Resolves logical arguments before appending the separately borrowed diagnostic context. */
export const lowerArguments = (
  context: SynchronousContext,
  target: Pick<DeclaredTarget, 'diagnosticParameter' | 'argumentParameters'>,
  inputs: NativeArgument.NativeArgument,
  observation: 'Inherited' | 'Independent' = 'Inherited',
) => {
  const arguments_ =
    target.argumentParameters === undefined
      ? NativeArgument.materialize(context.storage, inputs, 'native_helper_arguments')
      : NativeArgument.lower(
          context.storage,
          target.argumentParameters,
          inputs,
          `call_argument${context.storage.sequences.materialize++}`,
        )
  return argumentsFor(context, target, arguments_, observation)
}

/** Calls one synchronous native target and unpacks its ABI result lanes. */
export const callSynchronous = (
  context: SynchronousContext,
  target: DeclaredTarget,
  arguments_: NativeArgument.NativeArgument,
  name: string,
): NativeResult.Received => {
  if (target.suspendable)
    throw new RangeError('LLVM synchronous helper selected a suspendable target')
  const resultAddress = NativeResult.allocate(context.body, target, `${name}_result`)
  const result = Emitter.callDirect(
    context.body,
    target.handle,
    NativeResult.argumentsFor(target, lowerArguments(context, target, arguments_), resultAddress),
    name,
  )
  for (const root of [...context.storage.addressRoots].sort((left, right) => left - right))
    NativeStorage.reloadAddressRoot(context.storage, root)
  const unpacked = NativeResult.readValue(context.body, target, result, resultAddress, name)
  return unpacked
}

/** Runtime inputs consumed by an Effect execution operation. */
export const operationInputs = (
  operation: Extract<
    Mir.Operation,
    { readonly _tag: 'RunEffect' | 'RunEffectValue' | 'CatchEffect' | 'ExecutionPark' }
  >,
): ReadonlyArray<Mir.LocalId> => {
  if (operation._tag === 'ExecutionPark') {
    return [operation.register]
  }
  if (operation._tag === 'RunEffect') {
    return operation.arguments
  }
  return [operation.effect, ...operation.arguments]
}

export interface Context {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly program: Mir.Module
  readonly i8: LlvmType.Type
  readonly i32: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly entry: NativeLoweringContext.DeclaredFunction
  readonly transferPointer?: Value.Input
  readonly invocationFrameStorage?: Value.Input
  readonly resumeThunks: ReadonlyMap<
    string,
    {
      readonly handle: FunctionActor.Function
      readonly layout: Mir.CoroutineFrameTargetStateLayout
    }
  >
  readonly lanePointers: NativeLanePointer.Context
  readonly types: NativeType.LoweringContext
  readonly storage: NativeStorage.Context
  readonly synchronous: SynchronousContext
  readonly returns: NativeSuspension.ReturnContext
}

/** Retains one canonical relay frame in the transfer-owned continuation chain. */
export const retainRelay = (
  context: Context,
  suspension: Mir.RunSuspendableEffectRegion,
  name: string,
) => {
  const {
    body,
    builder,
    entry,
    i8,
    i32,
    invocationFrameStorage,
    lanePointers,
    pointer,
    program,
    resumeThunks,
    storage,
    transferPointer,
  } = context
  const continuation = suspension.relay.state
  if (continuation === undefined) return
  if (transferPointer === undefined || invocationFrameStorage === undefined)
    throw new RangeError('LLVM coroutine relay lost transfer or invocation-frame authority')
  const generated = resumeThunks.get(suspensionPointKey(suspension.point))
  if (generated === undefined)
    throw new RangeError('LLVM coroutine relay lost its native frame plan')
  const frame = Emitter.load(body, pointer, invocationFrameStorage, `${name}_invocation_frame`)
  const appendPointerPointer = Emitter.getElementPtr(
    body,
    i8,
    transferPointer,
    [Emitter.integerUnsigned(builder, i32, BigInt(program.layout.target.pointerSize * 2))],
    `${name}_append_ptr_ptr`,
  )
  const appendPointer = Emitter.load(body, pointer, appendPointerPointer, `${name}_append_ptr`)
  const next = Emitter.load(body, pointer, appendPointer, `${name}_next`)
  Emitter.store(
    body,
    next,
    NativeLanePointer.lanePointer(lanePointers, body, frame, 0, `${name}_store_parent`),
  )
  Emitter.store(
    body,
    Emitter.fromGlobal(builder, Emitter.functionGlobal(builder, generated.handle)),
    NativeLanePointer.lanePointer(
      lanePointers,
      body,
      frame,
      program.layout.target.pointerSize,
      `${name}_store_resume`,
    ),
  )
  if (entry.diagnosticParameter !== undefined) {
    const diagnostic = context.synchronous.diagnostic
    if (diagnostic === undefined) throw new RangeError('Relay lost its diagnostic context')
    Emitter.store(
      body,
      NativeDiagnosticContext.current(diagnostic),
      NativeLanePointer.lanePointer(
        lanePointers,
        body,
        frame,
        program.layout.target.pointerSize * 2,
        `${name}_store_observer`,
      ),
    )
    Emitter.store(
      body,
      diagnostic.incomingCause,
      NativeLanePointer.lanePointer(
        lanePointers,
        body,
        frame,
        program.layout.target.pointerSize * 3,
        `${name}_incoming_cause`,
      ),
    )
    Emitter.store(
      body,
      NativeDiagnosticContext.currentCause(diagnostic),
      NativeLanePointer.lanePointer(
        lanePointers,
        body,
        frame,
        program.layout.target.pointerSize * 9,
        `${name}_current_cause`,
      ),
    )
  }
  for (const field of generated.layout.payload) {
    NativeFrame.retain(storage, frame, field, `${name}_payload${field.slot}`)
  }
  Emitter.store(body, frame, appendPointer)
  Emitter.store(
    body,
    NativeLanePointer.lanePointer(lanePointers, body, frame, 0, `${name}_next_append_ptr`),
    appendPointerPointer,
  )
}

export const callValues = (
  context: Context,
  target: NativeLoweringContext.DeclaredFunction,
  arguments_: NativeArgument.NativeArgument,
  name: string,
  suspension?: Mir.RunSuspendableEffectRegion,
) => {
  const { body, builder, entry, i32, storage, pointer, transferPointer } = context
  if (!target.suspendable) return callSynchronous(context.synchronous, target, arguments_, name)
  if (transferPointer === undefined || suspension === undefined)
    throw new RangeError(
      `LLVM suspension-aware call from ${entry.fn.id.module}.${entry.fn.id.name} to ${target.fn.id.module}.${target.fn.id.name} lost transfer control`,
    )
  const resultAddress = NativeResult.allocate(body, target, `${name}_result`)
  const nullPointer = Emitter.nullValue(builder, pointer)
  const result = Emitter.callDirect(
    body,
    target.handle,
    [
      ...NativeResult.argumentsFor(
        target,
        lowerArguments(context.synchronous, target, arguments_),
        resultAddress,
      ),
      transferPointer,
      nullPointer,
      Emitter.integerUnsigned(builder, i32, 0n),
    ],
    name,
  )
  if (result === undefined) throw new RangeError('LLVM suspension step produced no value')
  // The callee may mutate borrowed state before transferring. Refresh it before either
  // consuming a completed result or spilling the caller's continuation payload.
  for (const root of [...storage.addressRoots].sort((left, right) => left - right))
    NativeStorage.reloadAddressRoot(storage, root)
  const status = NativeResult.status(body, target, result, `${name}_status`)
  const completed = Emitter.block(body, `${name}_complete`)
  const transferred = Emitter.block(body, `${name}_transfer`)
  Emitter.conditionalBranch(
    body,
    Emitter.integerCompare(
      body,
      'eq',
      status,
      Emitter.integerUnsigned(builder, i32, 0n),
      `${name}_is_complete`,
    ),
    completed,
    transferred,
  )
  Emitter.setInsertionPoint(body, transferred)
  retainRelay(context, suspension, name)
  const external = Emitter.block(body, `${name}_external`)
  const nested = Emitter.block(body, `${name}_nested`)
  Emitter.conditionalBranch(
    body,
    Emitter.integerCompare(
      body,
      'eq',
      status,
      Emitter.integerUnsigned(builder, i32, 2n),
      `${name}_is_external`,
    ),
    external,
    nested,
  )
  Emitter.setInsertionPoint(body, external)
  NativeSuspension.returnStep(context.returns, 2n, [], `${name}_external`)
  Emitter.setInsertionPoint(body, nested)
  NativeSuspension.returnStep(context.returns, 1n, [], `${name}_relayed`)
  Emitter.setInsertionPoint(body, completed)
  const unpacked = NativeResult.readValue(
    body,
    target,
    result,
    resultAddress,
    name,
    'SuspensionStep',
  )
  return unpacked
}
