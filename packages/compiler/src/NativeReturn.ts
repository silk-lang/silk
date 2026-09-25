import * as Emitter from '@silklang/llvm/Emitter'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as Block from '@silklang/llvm/Block'
import * as FunctionBody from '@silklang/llvm/FunctionBody'
import * as Value from '@silklang/llvm/Value'
import * as NativeSuspension from './NativeSuspension.js'
import * as NativeResult from './NativeResult.js'
import type * as Mir from './Mir.js'
import * as NativePlace from './NativePlace.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeValue from './NativeValue.js'
import * as NativeAggregate from './NativeAggregate.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'

/** Pending normal exits sharing one stored result conversion and diagnostic cleanup. */
export interface Completion {
  readonly block: Block.Block
  readonly place?: NativePlace.NativePlace
  readonly exits: Array<{
    readonly block: Block.Block
    readonly fields: ReadonlyArray<Value.Input>
  }>
}

/** Shares stored result conversion and diagnostic cleanup across normal exits. */
export const makeCompletion = (
  context: NativePlace.Context,
  entry: NativeLoweringContext.DeclaredFunction,
  hasOutcomes: boolean,
): Completion | undefined => {
  const stored = NativeValue.classify(context.types.program.layout, entry.fn.result) === 'Place'
  if (!stored && !hasOutcomes) return undefined
  let place: NativePlace.NativePlace | undefined
  if (entry.resultStorage?._tag === 'Canonical')
    place = NativeResult.place(entry, Emitter.argument(context.body, entry.resultStorage.parameter))
  else if (stored)
    place = NativePlace.allocate(context, entry.fn.result, 'completion_storage', 'entry')
  return {
    block: Emitter.block(context.body, 'completion'),
    ...(place === undefined ? {} : { place }),
    exits: [],
  }
}

const takeDiagnostic = (context: NativeSuspension.ReturnContext, source?: Mir.LocalId) => {
  const outcome =
    source === undefined ? undefined : context.diagnostic?.outcomes.get(source.ordinal)
  if (context.entry.diagnosticResult === undefined) return undefined
  if (source !== undefined && outcome === undefined)
    throw new RangeError('Native return lost its diagnostic outcome owner')
  return outcome === undefined || context.diagnostic === undefined
    ? Emitter.nullValue(context.builder, context.entry.diagnosticResult)
    : NativeDiagnosticOutcome.take(outcome, context.diagnostic)
}

/** Carries a stored return to the shared boundary without expanding its union at each exit. */
export const completeLocal = (
  context: NativeSuspension.ReturnContext,
  storage: NativeStorage.Context,
  source: Mir.LocalId,
  name: string,
) => {
  const value = NativeStorage.readLocal(storage, source)
  const completion = context.completion
  if (completion?.place !== undefined && value._tag === 'NativePlace') {
    NativePlace.transfer(completion.place, context, value)
    const diagnostic = takeDiagnostic(context, source)
    return enqueue(context, completion, diagnostic === undefined ? [] : [diagnostic])
  }
  return complete(context, NativeStorage.materialize(storage, source), name, source)
}

const enqueue = (
  context: NativeSuspension.ReturnContext,
  completion: Completion,
  fields: ReadonlyArray<Value.Input>,
) => {
  // Emission can move the insertion point internally; name an explicit phi predecessor.
  const exit = Emitter.block(context.body, 'completion_exit')
  Emitter.branch(context.body, exit)
  Emitter.setInsertionPoint(context.body, exit)
  completion.exits.push({ block: exit, fields })
  return Emitter.branch(context.body, completion.block)
}

/** Propagates an outcome while preserving canonical error storage and diagnostic ownership. */
export const propagateFailure = (
  context: NativeSuspension.ReturnContext,
  storage: NativeStorage.Context,
  source: Mir.LocalId,
  sourceTag: Value.Input,
  mappedTag: Value.Input,
  mappings: ReadonlyArray<{ readonly source: number; readonly target: number }>,
  name: string,
) => {
  const sourceType = storage.fn.localTypes.at(source.ordinal)
  const targetType = context.entry.fn.result
  if (sourceType?._tag !== 'EffectOutcome' || targetType._tag !== 'EffectOutcome')
    throw new RangeError('Failure propagation requires outcome types')
  const value = NativeStorage.readLocal(storage, source)
  const completion = context.completion
  if (value._tag === 'NativePlace' && completion?.place !== undefined) {
    NativePlace.copyFailure(completion.place, context, value, mappings)
    NativePlace.storeLane(completion.place, context, 0, mappedTag, `${name}_tag`)
    const diagnostic = takeDiagnostic(context, source)
    return enqueue(context, completion, diagnostic === undefined ? [] : [diagnostic])
  }
  const values = NativeStorage.materialize(storage, source)
  const payload = NativeAggregate.failurePayload(
    {
      builder: context.builder,
      body: context.body,
      program: context.types.program,
      i32: context.i32,
      types: context.types,
      arith: {
        body: context.body,
        pointerBits: context.types.program.layout.target.pointerSize === 4 ? 32 : 64,
        i32: context.i32,
        integerTypes: context.types.integerTypes,
        types: context.types,
      },
    },
    values,
    sourceType.type,
    sourceTag,
    targetType.type,
    mappings,
    `${name}_payload`,
  )
  return complete(context, [mappedTag, ...payload], name, source)
}

/** Completes one invocation through its declared synchronous or suspension result ABI. */
export const complete = (
  context: NativeSuspension.ReturnContext,
  values: ReadonlyArray<Value.Input>,
  name: string,
  source?: Mir.LocalId,
): FunctionBody.Instruction => {
  if (values.length !== context.entry.resultLaneCount)
    throw new RangeError('Native completion does not match its declared result lanes')
  const diagnostic = takeDiagnostic(context, source)
  return completeResult(
    context,
    { values, ...(diagnostic === undefined ? {} : { diagnostic }) },
    name,
  )
}

/** Consumes an already owned result and releases the invocation's remaining outcome references. */
export const completeResult = (
  context: NativeSuspension.ReturnContext,
  incoming: NativeResult.Received,
  name: string,
): FunctionBody.Instruction => {
  if ('place' in incoming && context.completion?.place !== undefined) {
    if ((incoming.diagnostic !== undefined) !== (context.entry.diagnosticResult !== undefined))
      throw new RangeError('Completion lost diagnostic ownership')
    NativePlace.transfer(context.completion.place, context, incoming.place)
    return enqueue(
      context,
      context.completion,
      incoming.diagnostic === undefined ? [] : [incoming.diagnostic],
    )
  }
  const result = NativeResult.materialize(context, incoming, name)
  if (
    result.values.length !== context.entry.resultLaneCount ||
    (result.diagnostic !== undefined) !== (context.entry.diagnosticResult !== undefined)
  )
    throw new RangeError('Native completion does not match its declared result ABI')
  if (context.completion !== undefined) {
    if (context.completion.place !== undefined) {
      NativePlace.storeLanes(context.completion.place, context, result.values, name)
      return enqueue(
        context,
        context.completion,
        result.diagnostic === undefined ? [] : [result.diagnostic],
      )
    }
    return enqueue(
      context,
      context.completion,
      NativeResult.fields(result, {
        resultLaneCount: context.entry.resultLaneCount,
        diagnosticResult: context.entry.diagnosticResult !== undefined,
      }),
    )
  }
  return emitResult(context, result, name)
}

/**
 * Seals normal exits after the body is emitted. Repeating all outcome releases at every
 * return made Token.write alone expand to 26,203 LLVM blocks in the self-hosted CLI.
 * Canonical storage preserves aggregate payloads; phis join direct values and diagnostic
 * ownership through one cleanup. Stored payloads cross into ABI lanes only after the join.
 * Suspensions and traps keep their separate exits; only completed invocations join here.
 */
export const emitCompletion = (context: NativeSuspension.ReturnContext) => {
  const completion = context.completion
  if (completion === undefined) return
  Emitter.setInsertionPoint(context.body, completion.block)
  const first = completion.exits.at(0)
  if (first === undefined) {
    Emitter.unreachable(context.body)
    return
  }
  const fields: Array<Value.Input> = []
  for (const [ordinal, input] of first.fields.entries()) {
    const phi = Emitter.phi(
      context.body,
      Emitter.inputType(context.body, input),
      `completion_lane${ordinal}`,
    )
    for (const exit of completion.exits) {
      const value = exit.fields.at(ordinal)
      if (value === undefined) throw new RangeError('Native completion lost a result lane')
      Emitter.addPhiIncoming(context.body, phi, value, exit.block)
    }
    Emitter.sealPhi(context.body, phi)
    fields.push(Emitter.phiValue(context.body, phi))
  }
  if (context.entry.resultStorage?._tag === 'Canonical') {
    if (context.entry.diagnosticResult !== undefined) {
      const diagnostic = fields.at(0)
      if (diagnostic === undefined) throw new RangeError('Completion lost its diagnostic result')
      NativeResult.storeDiagnostic(
        context.body,
        context.entry.resultStorage,
        Emitter.argument(context.body, context.entry.resultStorage.parameter),
        diagnostic,
        'completion',
      )
    }
    if (context.diagnostic !== undefined)
      for (const outcome of context.diagnostic.outcomes.values())
        NativeDiagnosticOutcome.release(outcome, context.diagnostic)
    Emitter.returnVoid(context.body)
    return
  }
  const values =
    completion.place === undefined
      ? fields.slice(0, context.entry.resultLaneCount)
      : NativePlace.loadLanes(completion.place, context, 'completion_value')
  const diagnostic = fields.at(completion.place === undefined ? context.entry.resultLaneCount : 0)
  emitResult(
    context,
    {
      values,
      ...(diagnostic === undefined ? {} : { diagnostic }),
    },
    'completion_result',
  )
}

const emitResult = (
  context: NativeSuspension.ReturnContext,
  result: NativeResult.NativeResult,
  name: string,
) => {
  if (context.diagnostic !== undefined)
    for (const outcome of context.diagnostic.outcomes.values())
      NativeDiagnosticOutcome.release(outcome, context.diagnostic)
  if (context.entry.suspendable)
    return NativeSuspension.returnStep(context, 0n, result.values, name, result.diagnostic)
  if (context.entry.resultStorage !== undefined) {
    NativeResult.store(
      context.body,
      context.entry.resultStorage,
      Emitter.argument(context.body, context.entry.resultStorage.parameter),
      NativeResult.fields(result, {
        resultLaneCount: context.entry.resultLaneCount,
        diagnosticResult: context.entry.diagnosticResult !== undefined,
      }),
      name,
    )
    return Emitter.returnVoid(context.body)
  }
  const packed = NativeResult.pack(
    result,
    context,
    {
      resultLaneCount: context.entry.resultLaneCount,
      diagnosticResult: context.entry.diagnosticResult !== undefined,
    },
    context.entry.resultType,
    name,
  )
  return packed === undefined
    ? Emitter.returnVoid(context.body)
    : Emitter.returnValue(context.body, packed)
}
