import * as Emitter from '@silklang/llvm/Emitter'
import * as NativeType from './NativeType.js'
import type * as NativeLanePointer from './NativeLanePointer.js'
import * as NativeResult from './NativeResult.js'
import * as NativeValue from './NativeValue.js'
import * as Attribute from '@silklang/llvm/Attribute'
import * as NativeForeignGuard from './NativeForeignGuard.js'
import * as NativeCAbi from './NativeCAbi.js'
import type * as Builder from '@silklang/llvm/Builder'
import * as FunctionActor from '@silklang/llvm/Function'
import type * as LlvmError from '@silklang/llvm/LlvmError'
import * as LlvmType from '@silklang/llvm/Type'
import * as Value from '@silklang/llvm/Value'
import * as Effect from 'effect/Effect'
import { BackendError, symbolFor } from './Backend.js'
import type * as CAbi from './CAbi.js'
import type * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import { linearize } from './MirLinearization.js'
import type * as NativeLoweringContext from './NativeLoweringContext.js'
import * as NativeDiagnosticFailure from './NativeDiagnosticFailure.js'
import * as NativeSymbol from './NativeSymbol.js'
import * as SilkType from './Type.js'
import * as NativeArgument from './NativeArgument.js'

export interface DeclarationContext {
  readonly types: NativeType.LoweringContext
  readonly lanePointers: NativeLanePointer.Context
  readonly support?: boolean
  readonly builder: Builder.Builder
  readonly program: Mir.Module
  readonly i32: LlvmType.Type
  readonly pointer: LlvmType.Type
  readonly lanesFor: (type: Mir.Type) => ReadonlyArray<Layout.CallingLane>
  readonly laneType: (lane: Layout.CallingLane) => LlvmType.Type
}

/** Declares every MIR function with its complete synchronous or suspension-aware ABI. */
export const functions = Effect.fn('NativeDeclare.functions')(function* (
  context: DeclarationContext,
): Effect.fn.Return<
  {
    readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
    readonly voidType?: LlvmType.Type
  },
  LlvmError.LlvmError
> {
  let voidType: LlvmType.Type | undefined
  const declared: Array<NativeLoweringContext.DeclaredFunction> = []
  const diagnostics = Mir.hasDiagnosticObservation(context.program)
  const causeType = diagnostics
    ? yield* Emitter.module(context.builder, (builder) =>
        NativeDiagnosticFailure.type({
          builder,
          pointer: context.pointer,
          word: Emitter.integerType(builder, context.program.layout.target.pointerSize * 8),
        }),
      )
    : undefined
  for (const fn of context.program.functions) {
    const resultLanes = context.lanesFor(fn.result)
    const resultLaneCount = resultLanes.length
    const diagnosticResult =
      fn.result._tag === 'EffectOutcome' && SilkType.failureMembers(fn.result.type).length > 0
        ? causeType
        : undefined
    let resultType: LlvmType.Type
    if (diagnosticResult !== undefined) {
      resultType = yield* LlvmType.structure(context.builder, [
        ...resultLanes.map(context.laneType),
        diagnosticResult,
      ])
    } else if (resultLaneCount === 0) {
      const selected = voidType ?? (yield* LlvmType.voidType(context.builder))
      voidType = selected
      resultType = selected
    } else if (resultLaneCount === 1) {
      const lane = resultLanes.at(0)
      if (lane === undefined) throw new RangeError('LLVM result lost its scalar lane')
      resultType = context.laneType(lane)
    } else {
      resultType = yield* LlvmType.structure(context.builder, resultLanes.map(context.laneType))
    }
    const argumentParameters = NativeArgument.parameters(
      context.program.layout,
      fn,
      context.lanesFor,
    )
    const sourceParameters = argumentParameters.flatMap((parameter) =>
      parameter.indirect ? [context.pointer] : parameter.lanes.map(context.laneType),
    )
    const diagnosticParameter =
      diagnostics && fn.machine === undefined ? sourceParameters.length : undefined
    const parameters =
      diagnosticParameter === undefined || causeType === undefined
        ? sourceParameters
        : [...sourceParameters, context.pointer, causeType]
    const suspendable =
      fn.suspension !== undefined && fn.suspension.classification !== 'Synchronous'
    const machineExport =
      fn.machine === undefined
        ? undefined
        : context.program.foreignExports.find((record) => Mir.matchesInstanceKey(fn, record.key))
    const publicSymbol =
      machineExport === undefined
        ? symbolFor(fn)
        : NativeSymbol.foreign(context.program.layout.target, machineExport.symbol)
    const machineAttributes =
      fn.machine === undefined
        ? undefined
        : yield* Attribute.functionSet(context.builder, {
            functionAttributes: yield* Attribute.set(
              context.builder,
              yield* Effect.forEach(['naked', 'noinline', 'noreturn'], (name) =>
                Attribute.flag(context.builder, name),
              ),
            ),
          })
    const canonicalLayout = NativeType.addressLayout(context.program.layout, fn.result)
    let resultStorage: NativeResult.Storage | undefined
    if (
      fn.machine === undefined &&
      resultLaneCount > 0 &&
      NativeValue.classify(context.program.layout, fn.result) === 'Place'
    ) {
      if (!suspendable && canonicalLayout !== undefined) {
        const payload = yield* LlvmType.array(
          context.builder,
          context.lanePointers.byteType,
          canonicalLayout.size,
        )
        resultStorage = {
          _tag: 'Canonical',
          type:
            diagnosticResult === undefined
              ? payload
              : yield* LlvmType.structure(context.builder, [payload, diagnosticResult]),
          parameter: parameters.length,
          logicalType: fn.result,
          alignment: Math.max(
            canonicalLayout.alignment,
            context.program.layout.target.pointerAlignment,
          ),
          types: context.types,
          lanePointers: context.lanePointers,
          ...(diagnosticResult === undefined ? {} : { diagnosticType: diagnosticResult }),
        }
      } else {
        const fields = [
          ...resultLanes.map(context.laneType),
          ...(diagnosticResult === undefined ? [] : [diagnosticResult]),
        ]
        resultStorage = {
          _tag: 'Lanes',
          type: yield* LlvmType.structure(context.builder, fields),
          fields,
          parameter: parameters.length,
        }
      }
    }
    const physicalParameters =
      resultStorage === undefined ? parameters : [...parameters, context.pointer]
    const directResultType =
      resultStorage === undefined
        ? resultType
        : (voidType ??= yield* LlvmType.voidType(context.builder))
    let emittedResultType = directResultType
    if (suspendable) {
      emittedResultType =
        resultStorage === undefined
          ? yield* LlvmType.structure(context.builder, [
              context.i32,
              ...resultLanes.map(context.laneType),
              ...(diagnosticResult === undefined ? [] : [diagnosticResult]),
            ])
          : context.i32
    }
    const parameterTypes = suspendable
      ? [...physicalParameters, context.pointer, context.pointer, context.i32]
      : physicalParameters
    const signature = yield* LlvmType.functionType(
      context.builder,
      emittedResultType,
      parameterTypes,
    )
    const symbol = suspendable ? `${publicSymbol}$suspend_step` : publicSymbol
    const driver = suspendable
      ? yield* FunctionActor.declare(
          context.builder,
          `${publicSymbol}$drive`,
          yield* LlvmType.functionType(context.builder, directResultType, physicalParameters),
          { visibility: 'hidden' },
        )
      : undefined
    declared.push({
      fn,
      symbol,
      publicSymbol,
      handle: yield* FunctionActor.declare(context.builder, symbol, signature, {
        visibility: !context.support && machineExport === undefined ? 'hidden' : 'default',
        ...(context.support ? { linkage: 'internal' as const } : {}),
        ...(machineAttributes === undefined ? {} : { attributes: machineAttributes }),
      }),
      resultType,
      emittedResultType,
      resultLaneCount,
      ...(resultStorage === undefined ? {} : { resultStorage }),
      ...(diagnosticResult === undefined ? {} : { diagnosticResult }),
      suspendable,
      ...(driver === undefined ? {} : { driver }),
      parameterTypes,
      argumentParameters,
      ...(diagnosticParameter === undefined ? {} : { diagnosticParameter }),
      linear: linearize(fn),
    })
  }
  return {
    declared: declared,
    ...(voidType === undefined ? {} : { voidType }),
  }
})

export interface ExportContext {
  readonly support?: boolean
  readonly foreignGuard: NativeForeignGuard.NativeForeignGuard | undefined
  readonly builder: Builder.Builder
  readonly program: Mir.Module
  readonly declared: ReadonlyArray<NativeLoweringContext.DeclaredFunction>
  /** LLVM type for one classified C type; `undefined` for `void`. */
  readonly cType: (type: CAbi.CAbiType) => LlvmType.Type | undefined
}

/**
 * Defines one external C-convention thunk per export that forwards its scalar arguments to the
 * private implementation and returns its result, so the internal ABI never becomes the public one.
 */
export const exportThunks = Effect.fn('NativeDeclare.exportThunks')(function* (
  context: ExportContext,
): Effect.fn.Return<
  ReadonlyMap<string, FunctionActor.Function>,
  BackendError | LlvmError.LlvmError
> {
  const thunks = new Map<string, FunctionActor.Function>()
  for (const record of context.program.foreignExports) {
    const implementation = context.declared.find((entry) =>
      Mir.matchesInstanceKey(entry.fn, record.key),
    )
    if (implementation === undefined)
      throw new RangeError(`LLVM export ${record.symbol} lost its implementation`)
    if (implementation.suspendable)
      throw new RangeError(`LLVM export ${record.symbol} forwards to a suspendable implementation`)
    if (implementation.fn.machine !== undefined) {
      thunks.set(record.symbol, implementation.handle)
      continue
    }
    const parameters = record.signature.parameters.map(context.cType)
    if (parameters.some((type) => type === undefined))
      throw new RangeError(`LLVM export ${record.symbol} has a void parameter`)
    const resultType =
      context.cType(record.signature.result) ?? (yield* LlvmType.voidType(context.builder))
    const attributes = yield* Emitter.module(context.builder, (builder) =>
      NativeCAbi.attributes(builder, record.signature),
    )
    const guard = context.foreignGuard
    if (guard === undefined && !context.support)
      throw new RangeError('Export thunk lost its fatal unwind guard')
    const groups =
      attributes === undefined
        ? undefined
        : yield* Attribute.functionSetEntries(context.builder, attributes)
    const functions =
      groups === undefined
        ? []
        : yield* Attribute.entries(context.builder, groups.functionAttributes)
    const guardedAttributes = yield* Attribute.functionSet(context.builder, {
      ...groups,
      functionAttributes: yield* Attribute.set(context.builder, [
        ...functions,
        yield* Attribute.flag(context.builder, 'noinline'),
        yield* Attribute.flag(context.builder, 'nounwind'),
      ]),
    })
    const thunk = yield* FunctionActor.declare(
      context.builder,
      NativeSymbol.foreign(context.program.layout.target, record.symbol),
      yield* LlvmType.functionType(
        context.builder,
        resultType,
        parameters.flatMap((type) => (type === undefined ? [] : [type])),
      ),
      {
        attributes: guardedAttributes,
        ...(guard === undefined ? {} : { personality: guard.personality }),
      },
    ).pipe(
      Effect.mapError(
        (cause) =>
          new BackendError({
            operation: 'Backend.emit',
            backend: 'LLVM',
            message: `exported function ${record.symbol} conflicts with another declaration of that symbol: ${cause.message}`,
            reason: { _tag: 'ForeignSymbolConflict', symbol: record.symbol },
          }),
      ),
    )
    yield* Emitter.module(context.builder, (builder) =>
      Emitter.buildBody(builder, thunk, (body) => {
        Emitter.block(body, 'entry')
        const arguments_: Array<Value.Input> = []
        for (let ordinal = 0; ordinal < parameters.length; ordinal += 1)
          arguments_.push(Emitter.argument(body, ordinal))
        if (implementation.diagnosticParameter !== undefined) {
          const causeType = implementation.parameterTypes.at(implementation.diagnosticParameter + 1)
          if (causeType === undefined)
            throw new RangeError('C export lost its empty diagnostic cause')
          arguments_.push(
            Emitter.nullValue(builder, Emitter.pointerType(builder)),
            Emitter.nullValue(builder, causeType),
          )
        }
        const resultAddress = NativeResult.allocate(body, implementation, 'export_result')
        const physicalArguments = NativeResult.argumentsFor(
          implementation,
          arguments_,
          resultAddress,
        )
        const exportResult = (value: Value.Input | undefined) => {
          if (implementation.resultStorage === undefined) return value
          const result = NativeResult.read(
            body,
            implementation,
            value,
            resultAddress,
            'export_result',
          )
          return NativeResult.pack(
            result,
            { body },
            {
              resultLaneCount: implementation.resultLaneCount,
              diagnosticResult: implementation.diagnosticResult !== undefined,
            },
            implementation.resultType,
            'export_result',
          )
        }
        if (context.support) {
          const result = Emitter.callDirect(
            body,
            implementation.handle,
            physicalArguments,
            'forward',
          )
          if (record.signature.result._tag === 'Void') return Emitter.returnVoid(body)
          const exported = exportResult(result)
          if (exported === undefined) throw new RangeError('LLVM support export lost its result')
          return Emitter.returnValue(body, exported)
        }
        if (guard === undefined) throw new RangeError('Export thunk lost its fatal unwind guard')
        const normal = Emitter.block(body, 'returned')
        const unwind = Emitter.block(body, 'foreign_unwind')
        const implementationProperties = Emitter.functionProperties(builder, implementation.handle)
        const callee = Emitter.fromGlobal(
          builder,
          Emitter.functionGlobal(builder, implementation.handle),
        )
        const result = Emitter.invoke(
          body,
          implementationProperties.type,
          callee,
          physicalArguments,
          normal,
          unwind,
          'forward',
        )
        Emitter.setInsertionPoint(body, unwind)
        Emitter.cleanupLandingPad(body, 'exception')
        Emitter.callDirect(body, guard.trap, [])
        Emitter.unreachable(body)
        Emitter.setInsertionPoint(body, normal)
        if (record.signature.result._tag === 'Void') return Emitter.returnVoid(body)
        const exported = exportResult(result)
        if (exported === undefined) throw new RangeError('LLVM export thunk lost its result')
        return Emitter.returnValue(body, exported)
      }),
    )
    thunks.set(record.symbol, thunk)
  }
  return thunks
})
