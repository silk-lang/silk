import * as Emitter from '@silklang/llvm/Emitter'
import type * as FunctionActor from '@silklang/llvm/Function'
import type * as LlvmType from '@silklang/llvm/Type'
import type * as Value from '@silklang/llvm/Value'

/**
 * The module's one out-of-line observer dispatch. Every diagnostic event calls it instead of
 * expanding the absent-observer branch, the descriptor loads, the indirect callback and the
 * handle join at the event site: large effect bodies emit thousands of events, and that inline
 * diamond made up a large share of their blocks.
 */
export interface NativeDiagnosticDispatch {
  helper: Helper | undefined
}

interface Helper {
  readonly handle: FunctionActor.Function
  readonly pointer: LlvmType.Type
  readonly word: LlvmType.Type
  readonly recordType: LlvmType.Type
  readonly callbackType: LlvmType.Type
}

/** Types of one invocation's observer descriptor and callback, shared by the whole module. */
export interface Types {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly pointer: LlvmType.Type
  readonly byte: LlvmType.Type
  readonly word: LlvmType.Type
  readonly recordType: LlvmType.Type
  readonly callbackType: LlvmType.Type
}

export const make = (): NativeDiagnosticDispatch => ({ helper: undefined })

const symbol = 'silk_diagnostic_dispatch'

/**
 * Dispatches one event to `observer`, or yields zero when observation is disabled. Arguments
 * follow the callback ABI after its dispatch, state and captures fields.
 */
export const call = (
  self: NativeDiagnosticDispatch,
  types: Types,
  observer: Value.Input,
  event: 0 | 1 | 2 | 3 | 4 | 5 | 6,
  first: Value.Input,
  second: Value.Input,
  identity: readonly [Value.Input, Value.Input],
  origin: readonly [Value.Input, Value.Input],
): Value.Input => {
  const { builder, body, pointer, byte, word } = types
  self.helper ??= {
    handle: Emitter.declareFunction(
      builder,
      symbol,
      Emitter.functionType(builder, word, [
        pointer,
        byte,
        word,
        word,
        pointer,
        word,
        pointer,
        word,
      ]),
      {
        linkage: 'internal',
        attributes: Emitter.functionAttributes(builder, {
          functionAttributes: Emitter.attributeSet(builder, [
            Emitter.flagAttribute(builder, 'noinline'),
          ]),
        }),
      },
    ),
    pointer,
    word,
    recordType: types.recordType,
    callbackType: types.callbackType,
  }
  const handle = Emitter.callDirect(
    body,
    self.helper.handle,
    [
      observer,
      Emitter.integerUnsigned(builder, byte, BigInt(event)),
      first,
      second,
      ...identity,
      ...origin,
    ],
    'diagnostic_handle',
  )
  if (handle === undefined) throw new RangeError('Diagnostic dispatch returned no handle')
  return handle
}

/** Defines the dispatch body once every function that may call it has been emitted. */
export const emitBody = (self: NativeDiagnosticDispatch, builder: Emitter.Module): void => {
  const helper = self.helper
  if (helper === undefined) return
  const { pointer, word, recordType, callbackType } = helper
  Emitter.buildBody(builder, helper.handle, (body) => {
    const entry = Emitter.block(body, 'entry')
    const enabled = Emitter.block(body, 'enabled')
    const complete = Emitter.block(body, 'complete')
    const argument = (ordinal: number) => Emitter.argument(body, ordinal)
    const observer = argument(0)
    const zero = Emitter.integerUnsigned(builder, word, 0n)
    Emitter.setInsertionPoint(body, entry)
    Emitter.conditionalBranch(
      body,
      Emitter.integerCompare(
        body,
        'ne',
        Emitter.cast(body, 'ptrtoint', observer, word, 'observer_address'),
        zero,
      ),
      enabled,
      complete,
    )
    Emitter.setInsertionPoint(body, enabled)
    const index = Emitter.integerType(builder, 32)
    const field = (ordinal: 0 | 1 | 2) =>
      Emitter.load(
        body,
        pointer,
        Emitter.getElementPtr(body, recordType, observer, [
          Emitter.integerUnsigned(builder, index, 0n),
          Emitter.integerUnsigned(builder, index, BigInt(ordinal)),
        ]),
      )
    const dispatch = field(0)
    const state = field(1)
    const captures = field(2)
    const result = Emitter.call(
      body,
      callbackType,
      dispatch,
      [
        captures,
        state,
        argument(1),
        argument(2),
        argument(3),
        argument(4),
        argument(5),
        argument(6),
        argument(7),
      ],
      'result',
    )
    if (result === undefined) throw new RangeError('Diagnostic callback returned no handle')
    Emitter.branch(body, complete)
    Emitter.setInsertionPoint(body, complete)
    const joined = Emitter.phi(body, word, 'handle')
    Emitter.addPhiIncoming(body, joined, result, enabled)
    Emitter.addPhiIncoming(body, joined, zero, entry)
    Emitter.sealPhi(body, joined)
    Emitter.returnValue(body, Emitter.phiValue(body, joined))
  })
}
