import * as Emitter from '@silklang/llvm/Emitter'
import * as NativeDiagnosticTransfer from './NativeDiagnosticTransfer.js'
import * as NativeArgument from './NativeArgument.js'
import * as NativeResult from './NativeResult.js'
import type * as NativeReturn from './NativeReturn.js'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as NativeDiagnosticContext from './NativeDiagnosticContext.js'
import * as ContinuationTransfer from './ContinuationTransfer.js'
import * as NativeExecutionStorage from './NativeExecutionStorage.js'
import * as LlvmBlock from '@silklang/llvm/Block'
import * as FunctionActor from '@silklang/llvm/Function'
import * as FunctionBody from '@silklang/llvm/FunctionBody'
import type * as LlvmType from '@silklang/llvm/Type'
import * as Value from '@silklang/llvm/Value'
import { suspensionPointKey } from './Backend.js'
import type * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import * as NativeCall from './NativeCall.js'
import * as NativeLanePointer from './NativeLanePointer.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeFrame from './NativeFrame.js'
import * as NativeType from './NativeType.js'
import * as ValueStorage from './ValueStorage.js'

export interface ReturnContext {
  readonly completion?: NativeReturn.Completion
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly i32: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly entry: NativeLoweringContext.DeclaredFunction
  readonly invocationFrameStorage?: Value.Input
  readonly executionStorage?: NativeExecutionStorage.NativeExecutionStorage
  readonly transferPointer?: Value.Input
  readonly lanePointers: NativeLanePointer.Context
  readonly types: NativeType.LoweringContext
  readonly diagnostic?: NativeDiagnosticContext.NativeDiagnosticContext
}

/** Emits one suspension-step ABI return and releases a completed invocation frame. */
export const returnStep = (
  context: ReturnContext,
  status: bigint,
  values: ReadonlyArray<Value.Input>,
  tag: string,
  diagnostic?: Value.Input,
): FunctionBody.Instruction => {
  if (!context.entry.suspendable)
    throw new RangeError('LLVM synchronous function cannot return a suspension step')
  if (diagnostic !== undefined && context.entry.diagnosticResult === undefined)
    throw new RangeError('LLVM suspension return cannot discard diagnostic ownership')
  if (status === 0n && context.invocationFrameStorage !== undefined) {
    if (context.executionStorage === undefined || context.transferPointer === undefined)
      throw new RangeError('LLVM suspension step lost private frame release')
    NativeExecutionStorage.invoke(
      {
        builder: context.builder,
        body: context.body,
        pointer: context.pointer,
        storage: context.executionStorage,
      },
      'release',
      [
        Emitter.load(
          context.body,
          context.pointer,
          NativeLanePointer.lanePointer(
            context.lanePointers,
            context.body,
            context.transferPointer,
            NativeExecutionStorage.stateOffset(context.types.program.layout.target.pointerSize),
            `${tag}_storage_slot`,
          ),
          `${tag}_storage_state`,
        ),
        Emitter.load(
          context.body,
          context.pointer,
          context.invocationFrameStorage,
          `${tag}_invocation_frame`,
        ),
      ],
      `${tag}_release_invocation_frame`,
    )
  }
  const padded = [...values]
  const resultDiagnostic =
    context.entry.diagnosticResult === undefined
      ? undefined
      : (diagnostic ?? Emitter.nullValue(context.builder, context.entry.diagnosticResult))
  const resultLanes = NativeType.lanesFor(context.types, context.entry.fn.result)
  while (padded.length < resultLanes.length) {
    const lane = resultLanes.at(padded.length)
    if (lane === undefined) break
    padded.push(Emitter.nullValue(context.builder, NativeType.laneType(context.types, lane)))
  }
  if (context.entry.resultStorage !== undefined) {
    NativeResult.store(
      context.body,
      context.entry.resultStorage,
      Emitter.argument(context.body, context.entry.resultStorage.parameter),
      NativeResult.fields(
        {
          values: padded.slice(0, resultLanes.length),
          ...(resultDiagnostic === undefined ? {} : { diagnostic: resultDiagnostic }),
        },
        { resultLaneCount: resultLanes.length, diagnosticResult: resultDiagnostic !== undefined },
      ),
      tag,
    )
    return Emitter.returnValue(
      context.body,
      Emitter.integerUnsigned(context.builder, context.i32, status),
    )
  }
  return Emitter.returnValue(
    context.body,
    Emitter.buildAggregate(
      context.body,
      context.entry.emittedResultType,
      [
        Emitter.integerUnsigned(context.builder, context.i32, status),
        ...NativeResult.fields(
          {
            values: padded.slice(0, resultLanes.length),
            ...(resultDiagnostic === undefined ? {} : { diagnostic: resultDiagnostic }),
          },
          { resultLaneCount: resultLanes.length, diagnosticResult: resultDiagnostic !== undefined },
        ),
      ],
      tag,
    ),
  )
}

/** Flattens the logical calling lanes retained across one suspension boundary. */
export const logicalLanes = (
  fn: Mir.MirFunction,
  locals: ReadonlyArray<Mir.LocalId>,
  types: NativeType.LoweringContext,
): ReadonlyArray<Layout.CallingLane> =>
  locals.flatMap((local) => {
    const type = fn.localTypes.at(local.ordinal)
    if (type === undefined) throw new RangeError(`LLVM suspension lost local %${local.ordinal}`)
    return NativeType.lanesFor(types, type)
  })

export interface ThunkContext {
  readonly builder: Emitter.Module
  readonly program: Mir.Module
  readonly i8: LlvmType.Type
  readonly i32: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly usizeType?: LlvmType.Type
  readonly lanePointers: NativeLanePointer.Context
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  readonly originThunks: ReadonlyMap<
    string,
    {
      readonly handle: FunctionActor.Function
      readonly region: Mir.SuspendEffectRegion
      readonly owner: NativeLoweringContext.DeclaredFunction
    }
  >
  readonly resumeThunks: ReadonlyMap<
    string,
    {
      readonly handle: FunctionActor.Function
      readonly region: Mir.RunSuspendableEffectRegion
      readonly owner: NativeLoweringContext.DeclaredFunction
      readonly frame: Mir.CoroutineFrameTargetLayout
      readonly layout: Mir.CoroutineFrameTargetStateLayout
    }
  >
  readonly types: NativeType.LoweringContext
  readonly executionStorage?: NativeExecutionStorage.NativeExecutionStorage
  readonly transferHeaderSize: number
  readonly transferResultOffset: number
  readonly transferStorageSize: number
  readonly childThunkType?: LlvmType.Type
  readonly resumeThunkType?: LlvmType.Type
}

/** Emits child, resume, and machine-driver suspension thunks. */
export const emitThunks = (context: ThunkContext) => {
  const {
    builder,
    program,
    i8,
    i32,
    pointer,
    usizeType,
    lanePointers,
    declared,
    originThunks,
    resumeThunks,
    types,
    executionStorage,
    transferHeaderSize,
    transferResultOffset,
    transferStorageSize,
    childThunkType,
    resumeThunkType,
  } = context
  for (const origin of originThunks.values()) {
    Emitter.buildBody(builder, origin.handle, (body) => {
      Emitter.block(body, 'entry')
      const transfer = Emitter.argument(body, 0)
      const target = declared.find((candidate) =>
        origin.region.deferred.instance !== undefined
          ? Mir.matchesEffectInstance(
              candidate.fn,
              origin.region.deferred.instance.declaration,
              origin.region.deferred.instance.typeArguments,
              origin.region.deferred.instance.staticArguments,
              origin.region.deferred.outcome,
              origin.region.deferred.providers,
            )
          : origin.region.deferred.declaration !== undefined &&
            Mir.matchesEffectInstance(
              candidate.fn,
              origin.region.deferred.declaration,
              origin.region.deferred.typeArguments,
              undefined,
              origin.region.deferred.outcome,
              origin.region.deferred.providers,
            ),
      )
      if (target === undefined) throw new RangeError('LLVM child thunk lost deferred runner')
      const argumentLanes = logicalLanes(
        origin.owner.fn,
        NativeCall.operationInputs(origin.region.operation),
        types,
      )
      const packed = ValueStorage.transport(program.layout.target, argumentLanes)
      const arguments_: Array<Value.Input> = []
      for (const [ordinal, lane] of packed.entries.entries()) {
        arguments_.push(
          Emitter.load(
            body,
            NativeType.laneType(types, lane.lane),
            NativeLanePointer.lanePointer(
              lanePointers,
              body,
              transfer,
              transferHeaderSize + lane.offset,
              `child_argument${ordinal}_ptr`,
            ),
            `child_argument${ordinal}`,
          ),
        )
      }
      const physicalArguments = NativeArgument.lower(
        { body, types, lanePointers },
        target.argumentParameters,
        NativeArgument.fromValues(arguments_),
        'child_arguments',
      )
      if (target.diagnosticParameter !== undefined) {
        if (physicalArguments.length !== target.diagnosticParameter)
          throw new RangeError('Child observer argument lost its source lane position')
        const causeType = target.parameterTypes.at(target.diagnosticParameter + 1)
        if (causeType === undefined) throw new RangeError('Child call lost diagnostic cause type')
        physicalArguments.push(
          Emitter.load(
            body,
            pointer,
            NativeLanePointer.lanePointer(
              lanePointers,
              body,
              transfer,
              ContinuationTransfer.observerOffset(program.layout.target.pointerSize),
              'child_observer_ptr',
            ),
            'child_observer',
          ),
          Emitter.load(
            body,
            causeType,
            NativeLanePointer.lanePointer(
              lanePointers,
              body,
              transfer,
              ContinuationTransfer.causeOffset(program.layout.target.pointerSize),
              'child_cause_ptr',
            ),
            'child_cause',
          ),
        )
      }
      const resultAddress = NativeResult.allocate(body, target, 'child_result')
      const callArguments = NativeResult.argumentsFor(target, physicalArguments, resultAddress)
      const result = Emitter.callDirect(
        body,
        target.handle,
        target.suspendable
          ? [
              ...callArguments,
              transfer,
              Emitter.nullValue(builder, pointer),
              Emitter.integerUnsigned(builder, i32, 0n),
            ]
          : callArguments,
        'child_step',
      )
      if (target.resultLaneCount > 0 && target.resultStorage === undefined && result === undefined)
        throw new RangeError('LLVM child thunk lost result')
      let status: Value.Input | undefined
      if (target.suspendable) {
        if (result === undefined) {
          status = undefined
        } else {
          status = NativeResult.status(body, target, result, 'child_status')
        }
      } else {
        status = Emitter.integerUnsigned(builder, i32, 0n)
      }
      if (status === undefined) throw new RangeError('LLVM child thunk lost status')
      const unpacked = NativeResult.read(
        body,
        target,
        result,
        resultAddress,
        'child_result',
        target.suspendable ? 'SuspensionStep' : 'Synchronous',
      )
      const resultLanes = NativeType.lanesFor(types, target.fn.result)
      const resultPacked = ValueStorage.transport(
        program.layout.target,
        resultLanes,
        transferResultOffset,
      )
      for (const [ordinal, lane] of resultPacked.entries.entries()) {
        const value = unpacked.values.at(ordinal)
        if (value === undefined) throw new RangeError('LLVM child thunk lost result lane')
        Emitter.store(
          body,
          Emitter.freeze(body, value, `child_result${ordinal}_stable`),
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            transfer,
            lane.offset,
            `child_result${ordinal}_ptr`,
          ),
        )
      }
      if (unpacked.diagnostic !== undefined)
        NativeDiagnosticTransfer.publish(
          { builder, body, wordSize: program.layout.target.pointerSize, transfer },
          unpacked.diagnostic,
        )
      Emitter.returnValue(body, status)
    })
  }

  for (const resume of resumeThunks.values()) {
    Emitter.buildBody(builder, resume.handle, (body) => {
      Emitter.block(body, 'entry')
      const transfer = Emitter.argument(body, 0)
      const frame = Emitter.argument(body, 1)
      const ordinal = [...resumeThunks.values()]
        .filter((candidate) => candidate.owner === resume.owner)
        .sort((left, right) =>
          suspensionPointKey(left.region.point).localeCompare(
            suspensionPointKey(right.region.point),
          ),
        )
        .indexOf(resume)
      if (ordinal < 0) throw new RangeError('LLVM resume thunk lost dispatch identity')
      const parameters = resume.owner.parameterTypes.slice(
        0,
        resume.owner.diagnosticParameter ??
          resume.owner.resultStorage?.parameter ??
          resume.owner.parameterTypes.length - 3,
      )
      const causeType =
        resume.owner.diagnosticParameter === undefined
          ? undefined
          : resume.owner.parameterTypes.at(resume.owner.diagnosticParameter + 1)
      if (resume.owner.diagnosticParameter !== undefined && causeType === undefined)
        throw new RangeError('Resume call lost diagnostic cause type')
      const resultAddress = NativeResult.allocate(body, resume.owner, 'resume_result')
      const result = Emitter.callDirect(
        body,
        resume.owner.handle,
        [
          ...NativeResult.argumentsFor(
            resume.owner,
            [
              ...Array.from(parameters, (type) => Emitter.nullValue(builder, type)),
              ...(causeType === undefined
                ? []
                : [
                    Emitter.load(
                      body,
                      pointer,
                      NativeLanePointer.lanePointer(
                        lanePointers,
                        body,
                        frame,
                        program.layout.target.pointerSize * 2,
                        'resume_observer_ptr',
                      ),
                      'resume_observer',
                    ),
                    Emitter.load(
                      body,
                      causeType,
                      NativeLanePointer.lanePointer(
                        lanePointers,
                        body,
                        frame,
                        program.layout.target.pointerSize * 3,
                        'resume_cause_ptr',
                      ),
                      'resume_cause',
                    ),
                  ]),
            ],
            resultAddress,
          ),
          transfer,
          frame,
          Emitter.integerUnsigned(builder, i32, BigInt(ordinal + 1)),
        ],
        'resume_step',
      )
      if (result === undefined) throw new RangeError('LLVM resume thunk lost step result')
      const status = NativeResult.status(body, resume.owner, result, 'resume_status')
      const unpacked = NativeResult.read(
        body,
        resume.owner,
        result,
        resultAddress,
        'resume_result',
        'SuspensionStep',
      )
      const resultPacked = ValueStorage.transport(
        program.layout.target,
        NativeType.lanesFor(types, resume.owner.fn.result),
        transferResultOffset,
      )
      for (const [laneOrdinal, lane] of resultPacked.entries.entries()) {
        const value = unpacked.values.at(laneOrdinal)
        if (value === undefined) throw new RangeError('LLVM resume thunk lost result lane')
        Emitter.store(
          body,
          Emitter.freeze(body, value, `resume_result${laneOrdinal}_stable`),
          NativeLanePointer.lanePointer(
            lanePointers,
            body,
            transfer,
            lane.offset,
            `resume_result${laneOrdinal}_ptr`,
          ),
        )
      }
      if (unpacked.diagnostic !== undefined)
        NativeDiagnosticTransfer.publish(
          { builder, body, wordSize: program.layout.target.pointerSize, transfer },
          unpacked.diagnostic,
        )
      Emitter.returnValue(body, status)
    })
  }

  for (const machine of declared) {
    const driver = machine.driver
    if (driver === undefined) continue
    Emitter.buildBody(builder, driver, (body) => {
      Emitter.block(body, 'entry')
      const arguments_: Array<Value.Input> = []
      for (let ordinal = 0; ordinal < machine.parameterTypes.length - 3; ordinal += 1)
        arguments_.push(Emitter.argument(body, ordinal))
      const transfer = Emitter.alloca(body, i8, 'suspend_transfer', {
        count: Emitter.integerUnsigned(builder, i32, BigInt(Math.max(transferStorageSize, 1))),
        alignment: Emitter.alignment(body, program.layout.target.pointerAlignment),
      })
      const nullPointer = Emitter.nullValue(builder, pointer)
      if (executionStorage === undefined || usizeType === undefined)
        throw new RangeError('Suspension driver lost storage component')
      const stateSlot = NativeLanePointer.lanePointer(
        lanePointers,
        body,
        transfer,
        NativeExecutionStorage.stateOffset(program.layout.target.pointerSize),
        'suspend_storage_slot',
      )
      Emitter.store(body, nullPointer, stateSlot)
      Emitter.store(
        body,
        nullPointer,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          transfer,
          program.layout.target.pointerSize * 3,
          'suspend_unowned_execution_slot',
        ),
      )
      Emitter.store(
        body,
        nullPointer,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          transfer,
          program.layout.target.pointerSize,
          'suspend_initial_head_ptr',
        ),
      )
      const initial = Emitter.callDirect(
        body,
        machine.handle,
        [...arguments_, transfer, nullPointer, Emitter.integerUnsigned(builder, i32, 0n)],
        'suspend_initial',
      )
      if (initial === undefined) throw new RangeError('LLVM suspension driver lost initial step')
      const initialStatus = NativeResult.status(body, machine, initial, 'suspend_initial_status')
      const initialComplete = Emitter.block(body, 'suspend_initial_complete')
      const drive = Emitter.block(body, 'suspend_drive')
      Emitter.conditionalBranch(
        body,
        Emitter.integerCompare(
          body,
          'eq',
          initialStatus,
          Emitter.integerUnsigned(builder, i32, 0n),
          'suspend_initial_done',
        ),
        initialComplete,
        drive,
      )
      const returnMachineResult = (completed: NativeResult.NativeResult, tag: string) => {
        NativeExecutionStorage.destroy(
          { builder, body, pointer, usizeType, storage: executionStorage },
          stateSlot,
          `${tag}_storage`,
        )
        if (machine.resultStorage !== undefined) {
          NativeResult.store(
            body,
            machine.resultStorage,
            Emitter.argument(body, machine.resultStorage.parameter),
            NativeResult.fields(completed, {
              resultLaneCount: machine.resultLaneCount,
              diagnosticResult: machine.diagnosticResult !== undefined,
            }),
            tag,
          )
          return Emitter.returnVoid(body)
        }
        const result = NativeResult.pack(
          completed,
          { body },
          {
            resultLaneCount: machine.resultLaneCount,
            diagnosticResult: machine.diagnosticResult !== undefined,
          },
          machine.resultType,
          tag,
        )
        return result === undefined ? Emitter.returnVoid(body) : Emitter.returnValue(body, result)
      }
      Emitter.setInsertionPoint(body, initialComplete)
      const initialResult = NativeResult.read(
        body,
        machine,
        initial,
        machine.resultStorage === undefined
          ? undefined
          : Emitter.argument(body, machine.resultStorage.parameter),
        'suspend_initial_result',
        'SuspensionStep',
      )
      returnMachineResult(initialResult, 'suspend_initial_result')
      Emitter.setInsertionPoint(body, drive)
      const child = Emitter.load(
        body,
        pointer,
        NativeLanePointer.lanePointer(lanePointers, body, transfer, 0, 'suspend_child_ptr'),
        'suspend_child',
      )
      if (childThunkType === undefined || resumeThunkType === undefined)
        throw new RangeError('LLVM driver lost private thunk types')
      const childStatus = Emitter.call(
        body,
        childThunkType,
        child,
        [transfer],
        'suspend_child_status',
      )
      if (childStatus === undefined) throw new RangeError('LLVM driver child returned void')
      const childTransferred = Emitter.block(body, 'suspend_child_transferred')
      const childCompleted = Emitter.block(body, 'suspend_child_completed')
      Emitter.conditionalBranch(
        body,
        Emitter.integerCompare(
          body,
          'eq',
          childStatus,
          Emitter.integerUnsigned(builder, i32, 0n),
          'suspend_child_done',
        ),
        childCompleted,
        childTransferred,
      )
      Emitter.setInsertionPoint(body, childTransferred)
      Emitter.branch(body, drive)
      Emitter.setInsertionPoint(body, childCompleted)
      const parentPointer = NativeLanePointer.lanePointer(
        lanePointers,
        body,
        transfer,
        program.layout.target.pointerSize,
        'suspend_parent_ptr',
      )
      const parent = Emitter.load(body, pointer, parentPointer, 'suspend_parent')
      const finish = Emitter.block(body, 'suspend_finish')
      const resumeParent = Emitter.block(body, 'suspend_resume_parent')
      Emitter.conditionalBranch(
        body,
        Emitter.integerCompare(
          body,
          'eq',
          Emitter.cast(body, 'ptrtoint', parent, usizeType ?? i32, 'suspend_parent_addr'),
          Emitter.integerUnsigned(builder, usizeType ?? i32, 0n),
          'suspend_has_no_parent',
        ),
        finish,
        resumeParent,
      )
      Emitter.setInsertionPoint(body, resumeParent)
      const nextParent = Emitter.load(
        body,
        pointer,
        NativeLanePointer.lanePointer(lanePointers, body, parent, 0, 'suspend_next_parent_ptr'),
        'suspend_next_parent',
      )
      Emitter.store(body, nextParent, parentPointer)
      const appendPointerPointer = NativeLanePointer.lanePointer(
        lanePointers,
        body,
        transfer,
        program.layout.target.pointerSize * 2,
        'suspend_append_ptr_ptr',
      )
      Emitter.store(body, parentPointer, appendPointerPointer)
      const resumeFunction = Emitter.load(
        body,
        pointer,
        NativeLanePointer.lanePointer(
          lanePointers,
          body,
          parent,
          program.layout.target.pointerSize,
          'suspend_resume_ptr',
        ),
        'suspend_resume',
      )
      const resumedStatus = Emitter.call(
        body,
        resumeThunkType,
        resumeFunction,
        [transfer, parent],
        'suspend_resumed_status',
      )
      if (resumedStatus === undefined) throw new RangeError('LLVM resume returned void')
      const resumeTransferred = Emitter.block(body, 'suspend_resume_transferred')
      const resumeCompleted = Emitter.block(body, 'suspend_resume_completed')
      Emitter.conditionalBranch(
        body,
        Emitter.integerCompare(
          body,
          'eq',
          resumedStatus,
          Emitter.integerUnsigned(builder, i32, 0n),
          'suspend_resume_done',
        ),
        resumeCompleted,
        resumeTransferred,
      )
      Emitter.setInsertionPoint(body, resumeTransferred)
      Emitter.branch(body, drive)
      Emitter.setInsertionPoint(body, resumeCompleted)
      Emitter.branch(body, childCompleted)
      Emitter.setInsertionPoint(body, finish)
      const finalValues: Array<Value.Input> = []
      const finalPacked = ValueStorage.transport(
        program.layout.target,
        NativeType.lanesFor(types, machine.fn.result),
        transferResultOffset,
      )
      for (const [ordinal, lane] of finalPacked.entries.entries())
        finalValues.push(
          Emitter.load(
            body,
            NativeType.laneType(types, lane.lane),
            NativeLanePointer.lanePointer(
              lanePointers,
              body,
              transfer,
              lane.offset,
              `suspend_final_result${ordinal}_ptr`,
            ),
            `suspend_final_result${ordinal}`,
          ),
        )
      const diagnostic =
        machine.diagnosticResult === undefined
          ? undefined
          : NativeDiagnosticTransfer.take(
              { builder, body, wordSize: program.layout.target.pointerSize, transfer },
              machine.diagnosticResult,
            )
      returnMachineResult(
        {
          values: finalValues,
          ...(diagnostic === undefined ? {} : { diagnostic }),
        },
        'suspend_final_result',
      )
    })
  }
}

export interface OperationContext {
  readonly diagnostic?: NativeDiagnosticContext.NativeDiagnosticContext
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly program: Mir.Module
  readonly i8: LlvmType.Type
  readonly i32: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly entry: NativeLoweringContext.DeclaredFunction
  readonly lanePointers: NativeLanePointer.Context
  readonly types: NativeType.LoweringContext
  readonly transferHeaderSize: number
  readonly transferResultOffset: number
  readonly transferPointer?: Value.Input
  readonly resumeFrame?: Value.Input
  readonly originThunks: ReadonlyMap<string, { readonly handle: FunctionActor.Function }>
  readonly resumeThunks: ReadonlyMap<
    string,
    {
      readonly handle: FunctionActor.Function
      readonly layout: Mir.CoroutineFrameTargetStateLayout
    }
  >
  readonly suspensionRegions: ReadonlyMap<Mir.Operation, Mir.SuspensionRegion>
  readonly resumeBlocks: ReadonlyMap<string, LlvmBlock.Block>
  readonly storage: NativeStorage.Context
  readonly returns: ReturnContext
}

/** Restores retained relay payloads into current destinations at the verified resume label. */
export const restoreRelayPayload = (
  context: OperationContext,
  region: Mir.RunSuspendableEffectRegion,
  name: string,
) => {
  const { resumeFrame, resumeThunks, storage } = context
  if (resumeFrame === undefined) throw new RangeError('LLVM relay restore lost its frame argument')
  const generated = resumeThunks.get(suspensionPointKey(region.point))
  if (generated === undefined) throw new RangeError('LLVM relay restore lost generated control')
  for (const field of generated.layout.payload) {
    NativeFrame.restore(storage, resumeFrame, field, `${name}_restore${field.slot}`)
  }
}

const originateTransfer = (
  context: OperationContext,
  region: Mir.SuspendEffectRegion,
  arguments_: ReadonlyArray<Value.Input>,
  name: string,
) => {
  const {
    builder,
    body,
    entry,
    lanePointers,
    types,
    originThunks,
    program,
    transferHeaderSize,
    transferPointer,
  } = context
  if (transferPointer === undefined)
    throw new RangeError('LLVM suspension origin lost transfer storage')
  const generated = originThunks.get(suspensionPointKey(region.point))
  if (generated === undefined) throw new RangeError('LLVM suspension origin lost thunk')
  Emitter.store(
    body,
    Emitter.fromGlobal(builder, Emitter.functionGlobal(builder, generated.handle)),
    NativeLanePointer.lanePointer(lanePointers, body, transferPointer, 0, `${name}_child`),
  )
  Emitter.store(
    body,
    NativeLanePointer.lanePointer(
      lanePointers,
      body,
      transferPointer,
      program.layout.target.pointerSize,
      `${name}_head`,
    ),
    NativeLanePointer.lanePointer(
      lanePointers,
      body,
      transferPointer,
      program.layout.target.pointerSize * 2,
      `${name}_append_ptr`,
    ),
  )
  Emitter.store(
    body,
    context.diagnostic === undefined
      ? Emitter.nullValue(builder, context.pointer)
      : NativeDiagnosticContext.current(context.diagnostic),
    NativeLanePointer.lanePointer(
      lanePointers,
      body,
      transferPointer,
      ContinuationTransfer.observerOffset(program.layout.target.pointerSize),
      `${name}_observer`,
    ),
  )
  if (context.diagnostic !== undefined)
    Emitter.store(
      body,
      NativeDiagnosticContext.currentCause(context.diagnostic),
      NativeLanePointer.lanePointer(
        lanePointers,
        body,
        transferPointer,
        ContinuationTransfer.causeOffset(program.layout.target.pointerSize),
        `${name}_cause`,
      ),
    )
  const packed = ValueStorage.transport(
    program.layout.target,
    logicalLanes(entry.fn, NativeCall.operationInputs(region.operation), types),
  )
  if (packed.entries.length !== arguments_.length)
    throw new RangeError('LLVM suspension origin argument shape disagrees with its thunk')
  for (const [ordinal, lane] of packed.entries.entries()) {
    const value = arguments_.at(ordinal)
    if (value === undefined) throw new RangeError('LLVM suspension origin lost argument')
    Emitter.store(
      body,
      value,
      NativeLanePointer.lanePointer(
        lanePointers,
        body,
        transferPointer,
        transferHeaderSize + lane.offset,
        `${name}_argument${ordinal}`,
      ),
    )
  }
  returnStep(context.returns, 1n, [], `${name}_originated`)
}

export const emitOrigin = (
  context: OperationContext,
  operation: Extract<
    Mir.Operation,
    { readonly _tag: 'RunEffect' | 'RunEffectValue' | 'CatchEffect' }
  >,
  arguments_: NativeArgument.NativeArgument,
  name: string,
) => {
  const { body, builder, storage: nativeStorage, suspensionRegions, types } = context
  const suspension = suspensionRegions.get(operation)
  if (suspension?._tag !== 'SuspendEffectRegion') return false
  originateTransfer(
    context,
    suspension,
    NativeArgument.materialize(nativeStorage, arguments_, name),
    name,
  )
  Emitter.setInsertionPoint(body, Emitter.block(body, `${name}_unreachable_continuation`))
  const outcomeValues = Array.from(NativeType.lanesFor(types, operation.outcomeType), (lane) =>
    Emitter.nullValue(builder, NativeType.laneType(types, lane)),
  )
  const destinationValues = Array.from(NativeType.lanesFor(types, operation.type), (lane) =>
    Emitter.nullValue(builder, NativeType.laneType(types, lane)),
  )
  NativeStorage.writeLocal(nativeStorage, operation.outcome.ordinal, outcomeValues)
  NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, destinationValues)
  return true
}

export const joinOutcome = (
  context: OperationContext,
  operation: Extract<
    Mir.Operation,
    { readonly _tag: 'RunEffect' | 'RunEffectValue' | 'CatchEffect' }
  >,
  completedResult: NativeResult.Received,
  name: string,
) => {
  const {
    body,
    builder,
    i8,
    i32,
    program,
    resumeBlocks,
    resumeFrame,
    resumeThunks,
    suspensionRegions,
    storage: nativeStorage,
    transferPointer,
    transferResultOffset,
    types,
  } = context
  const completedValues = NativeDiagnosticOutcome.accept(
    context.returns.diagnostic,
    operation.outcome,
    completedResult,
  )
  const suspension = suspensionRegions.get(operation)
  const descriptor =
    suspension?._tag === 'RunSuspendableEffectRegion' ? suspension.relay.state : undefined
  if (descriptor === undefined) return completedValues
  if (transferPointer === undefined || resumeFrame === undefined)
    throw new RangeError('LLVM coroutine resume lost private arguments')
  const generated = resumeThunks.get(suspensionPointKey(descriptor.point))
  const resumeBlock = resumeBlocks.get(suspensionPointKey(descriptor.point))
  if (generated === undefined || resumeBlock === undefined)
    throw new RangeError('LLVM coroutine resume lost generated control')
  NativeStorage.writeValue(nativeStorage, operation.outcome, completedValues)
  NativeStorage.commitLocal(nativeStorage, operation.outcome)
  const following = Emitter.block(body, `${name}_joined`)
  Emitter.branch(body, following)
  Emitter.setInsertionPoint(body, resumeBlock)
  if (completedResult.diagnostic !== undefined) {
    const diagnosticContext = context.returns.diagnostic
    if (diagnosticContext === undefined)
      throw new RangeError('Resumed result lost its diagnostic context')
    NativeDiagnosticOutcome.accept(diagnosticContext, operation.outcome, {
      values: [],
      diagnostic: NativeDiagnosticTransfer.take(
        { builder, body, wordSize: program.layout.target.pointerSize, transfer: transferPointer },
        diagnosticContext.causeType,
      ),
    })
  }
  for (const field of generated.layout.payload) {
    NativeFrame.restore(nativeStorage, resumeFrame, field, `${name}_restore${field.slot}`)
  }
  const outcomePacked = ValueStorage.transport(
    program.layout.target,
    NativeType.lanesFor(types, operation.outcomeType),
    transferResultOffset,
  )
  const resumed: Array<Value.Input> = []
  for (const [ordinal, lane] of outcomePacked.entries.entries()) {
    resumed.push(
      Emitter.load(
        body,
        NativeType.laneType(types, lane.lane),
        Emitter.getElementPtr(
          body,
          i8,
          transferPointer,
          [Emitter.integerUnsigned(builder, i32, BigInt(lane.offset))],
          `${name}_resume_outcome${ordinal}_ptr`,
        ),
        `${name}_resume_outcome${ordinal}`,
      ),
    )
  }
  NativeStorage.writeJoin(nativeStorage, operation.outcome, resumed)
  Emitter.branch(body, following)
  Emitter.setInsertionPoint(body, following)
  for (const field of generated.layout.payload)
    NativeStorage.reloadLocal(nativeStorage, field.local, `${name}_joined_payload${field.slot}`)
  // Synchronous completion and resumption both reach this block through memory-backed roots.
  // Re-root the complete mutable cache here so later success/failure dispatch never retains an
  // SSA value defined only by the synchronous completion arm.
  NativeStorage.reloadRoots(nativeStorage, `${name}_joined`)
  return NativeStorage.readLocal(nativeStorage, operation.outcome)
}
