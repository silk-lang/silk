import * as Emitter from '@silklang/llvm/Emitter'
import type * as FunctionActor from '@silklang/llvm/Function'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'
import * as Mir from './Mir.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'

/** Source function handles for the selected, already verified storage contract. */
export interface NativeExecutionStorage {
  readonly diagnosticCauseType?: LlvmType.Type
  readonly create: FunctionActor.Function
  readonly acquire: FunctionActor.Function
  readonly release: FunctionActor.Function
  readonly destroy: FunctionActor.Function
}

/** Binds source implementations directly, without knowing provider module or symbol names. */
export const make = (
  program: Mir.Module,
  declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>,
): NativeExecutionStorage | undefined => {
  const selected = program.executionStorage
  if (selected === undefined) return undefined
  const handle = (
    operation: 'create' | 'acquire' | 'release' | 'destroy',
  ): FunctionActor.Function => {
    const fn = declared.find((entry) => Mir.matchesInstanceKey(entry.fn, selected[operation].key))
    if (fn === undefined || fn.suspendable)
      throw new RangeError('Selected execution storage lost its synchronous source implementation')
    return fn.handle
  }
  const create = declared.find((entry) => Mir.matchesInstanceKey(entry.fn, selected.create.key))
  const diagnosticCauseType =
    create?.diagnosticParameter === undefined
      ? undefined
      : create.parameterTypes.at(create.diagnosticParameter + 1)
  if (Mir.hasDiagnosticObservation(program) && diagnosticCauseType === undefined)
    throw new RangeError('Storage bootstrap lost its diagnostic cause signature')
  return {
    ...(diagnosticCauseType === undefined ? {} : { diagnosticCauseType }),
    create: handle('create'),
    acquire: handle('acquire'),
    release: handle('release'),
    destroy: handle('destroy'),
  }
}

/** The fifth transfer word carries the invocation's storage state. */
export const stateOffset = (pointerSize: number): number => pointerSize * 4

export interface Context {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly pointer: LlvmType.Type
  readonly usizeType: LlvmType.Type
  readonly storage: NativeExecutionStorage
}

/** Storage bootstrap calls disable observation to avoid invoking a storage-dependent observer. */
export const invoke = (
  context: Pick<Context, 'builder' | 'body' | 'pointer' | 'storage'>,
  operation: 'create' | 'acquire' | 'release' | 'destroy',
  arguments_: ReadonlyArray<Value.Input>,
  tag: string,
) => {
  return Emitter.callDirect(
    context.body,
    context.storage[operation],
    context.storage.diagnosticCauseType === undefined
      ? arguments_
      : [
          ...arguments_,
          Emitter.nullValue(context.builder, context.pointer),
          Emitter.nullValue(context.builder, context.storage.diagnosticCauseType),
        ],
    tag,
  )
}

/** Lazily acquires state and traps on private storage exhaustion without changing source rows. */
export const ensure = (context: Context, slot: Value.Input, tag: string): Value.Input => {
  const { builder, body, pointer, usizeType } = context
  const current = Emitter.load(body, pointer, slot, `${tag}_current`)
  const create = Emitter.block(body, `${tag}_create`)
  const ready = Emitter.block(body, `${tag}_ready`)
  Emitter.conditionalBranch(
    body,
    Emitter.integerCompare(
      body,
      'eq',
      Emitter.cast(body, 'ptrtoint', current, usizeType, `${tag}_current_address`),
      Emitter.integerUnsigned(builder, usizeType, 0n),
      `${tag}_absent`,
    ),
    create,
    ready,
  )
  Emitter.setInsertionPoint(body, create)
  const acquired = invoke(context, 'create', [], `${tag}_acquired`)
  if (acquired === undefined) throw new RangeError('Storage creation lost its result')
  const refused = Emitter.block(body, `${tag}_refused`)
  const publish = Emitter.block(body, `${tag}_publish`)
  Emitter.conditionalBranch(
    body,
    Emitter.integerCompare(
      body,
      'eq',
      Emitter.cast(body, 'ptrtoint', acquired, usizeType, `${tag}_acquired_address`),
      Emitter.integerUnsigned(builder, usizeType, 0n),
      `${tag}_exhausted`,
    ),
    refused,
    publish,
  )
  Emitter.setInsertionPoint(body, refused)
  Emitter.intrinsicCall(body, 'trap', [], [])
  Emitter.unreachable(body)
  Emitter.setInsertionPoint(body, publish)
  Emitter.store(body, acquired, slot)
  Emitter.branch(body, ready)
  Emitter.setInsertionPoint(body, ready)
  return Emitter.load(body, pointer, slot, `${tag}_state`)
}

/** Consumes a live state once; an unstarted invocation owns no state and performs no call. */
export const destroy = (context: Context, slot: Value.Input, tag: string): void => {
  const { builder, body, pointer, usizeType } = context
  const state = Emitter.load(body, pointer, slot, `${tag}_state`)
  const empty = Emitter.nullValue(builder, pointer)
  const release = Emitter.block(body, `${tag}_release`)
  const done = Emitter.block(body, `${tag}_done`)
  Emitter.conditionalBranch(
    body,
    Emitter.integerCompare(
      body,
      'eq',
      Emitter.cast(body, 'ptrtoint', state, usizeType, `${tag}_state_address`),
      Emitter.integerUnsigned(builder, usizeType, 0n),
      `${tag}_absent`,
    ),
    done,
    release,
  )
  Emitter.setInsertionPoint(body, release)
  Emitter.store(body, empty, slot)
  invoke(context, 'destroy', [state], `${tag}_destroy`)
  Emitter.branch(body, done)
  Emitter.setInsertionPoint(body, done)
}
