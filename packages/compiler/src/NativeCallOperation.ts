import * as Emitter from '@silklang/llvm/Emitter'
import type * as NativeValue from './NativeValue.js'
import * as NativeResult from './NativeResult.js'
import * as NativeArgument from './NativeArgument.js'
import * as NativeCallable from './NativeCallable.js'
import * as Value from '@silklang/llvm/Value'
import * as Tir from './Tir.js'
import * as Mir from './Mir.js'
import * as FunctionIndex from './internal/FunctionIndex.js'
import type { LinearOperation } from './MirLinearization.js'
import * as NativeArith from './NativeArith.js'
import * as NativeCall from './NativeCall.js'
import * as NativeDiagnosticOutcome from './NativeDiagnosticOutcome.js'
import * as NativeDebug from './NativeDebug.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeScalarOperation from './NativeScalarOperation.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeType from './NativeType.js'
import * as Scalar from './Scalar.js'

type Operation = Extract<LinearOperation, { readonly _tag: 'ApplyCallable' | 'Call' }>

export const emit = (context: Context, operation: Operation) => {
  const {
    body,
    builder,
    call,
    declared,
    arith,
    debug,
    entry,
    f32,
    f64,
    i32,
    integerTypes,
    program,
    storage: nativeStorage,
    types,
  } = context
  const checkOrdinal = context.state.checkOrdinal
  switch (operation._tag) {
    case 'ApplyCallable': {
      const sourceType =
        operation.callable === undefined
          ? undefined
          : entry.fn.localTypes.at(operation.callable.ordinal)
      const target =
        operation.target ?? (sourceType?._tag === 'CallableValue' ? sourceType.target : undefined)
      if (target === undefined)
        throw new RangeError('Backend callable application lost its hidden identity')
      const callableTarget =
        target._tag === 'BuiltinCallableTarget'
          ? undefined
          : FunctionIndex.nativeCandidates(declared, target.declaration).find((candidate) =>
              Mir.matchesInstance(candidate.fn, target.declaration, operation.typeArguments),
            )
      if (target._tag !== 'BuiltinCallableTarget' && callableTarget === undefined)
        throw new RangeError(
          `Backend cannot resolve callable target ${target.declaration.module}.${target.declaration.name}`,
        )
      const targetUsesEnvironmentBorrows =
        target._tag === 'DeclarationCallableTarget' && Tir.isAnonymousCallableId(target.declaration)
      const captureGroups: Array<{
        readonly parameterOrdinal: number
        readonly value: NativeValue.NativeValue
      }> = []
      if (operation.callable !== undefined) {
        if (sourceType?._tag !== 'CallableValue')
          throw new RangeError('Stored callable application lost its identity')
        if (callableTarget === undefined)
          throw new RangeError('Stored callable has no source declaration')
        captureGroups.push(
          ...NativeCallable.capturedValues(
            context,
            sourceType,
            operation.callable,
            callableTarget.argumentParameters,
            `callable${operation.destination.ordinal}`,
          ),
        )
      } else {
        for (const capture of operation.captures) {
          let value: NativeValue.NativeValue
          if (
            targetUsesEnvironmentBorrows &&
            (capture.access === 'Shared' || capture.access === 'Exclusive')
          ) {
            NativeStorage.ensureAddressRoot(nativeStorage, capture.source)
            const base = NativeStorage.addressOf(nativeStorage, capture.source)
            value = { _tag: 'Direct', values: [base] }
          } else {
            value = NativeStorage.readLocal(nativeStorage, capture.source)
          }
          captureGroups.push({
            parameterOrdinal: capture.parameterOrdinal,
            value,
          })
        }
      }
      const arguments_: NativeArgument.NativeArgument = {
        _tag: 'Values',
        values: Mir.applyOperands(
          captureGroups.map((capture) => ({
            parameterOrdinal: capture.parameterOrdinal,
            items: [capture.value],
          })),
          operation.arguments.map((local) => [NativeStorage.readLocal(nativeStorage, local)]),
        ),
      }
      if (target._tag === 'BuiltinCallableTarget') {
        const supplied = NativeArgument.materialize(
          nativeStorage,
          arguments_,
          `builtin${operation.destination.ordinal}`,
        )
        const first = supplied.at(0)
        const firstLocal = operation.arguments.at(0)
        const firstType =
          firstLocal === undefined ? undefined : entry.fn.localTypes.at(firstLocal.ordinal)
        if (first === undefined || firstType === undefined)
          throw new RangeError('LLVM callable builtin lost its first operand')
        const conversionTarget = Scalar.conversionTarget(target.operation)
        if (conversionTarget !== undefined) {
          const sourceScalar = Scalar.find(firstType._tag)
          if (sourceScalar?.category === 'Floating') {
            const destination =
              integerTypes.get(
                Scalar.bits(conversionTarget, program.layout.target.pointerSize === 4 ? 32 : 64),
              ) ?? i32
            NativeScalarOperation.emitFloatToIntegerGuard(
              context,
              first,
              sourceScalar,
              conversionTarget,
              `callable_convert${operation.destination.ordinal}`,
              operation.provenance.span,
            )
            const result = Emitter.cast(
              body,
              conversionTarget.signedness === 'Signed' ? 'fptosi' : 'fptoui',
              first,
              destination,
              `callable_convert${operation.destination.ordinal}`,
            )
            NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
            break
          }
          if (sourceScalar?.category !== 'Integer')
            throw new RangeError('LLVM callable conversion lost its source type')
          const result = NativeArith.emitIntegerConversion(
            arith,
            first,
            { _tag: sourceScalar.spelling },
            { _tag: conversionTarget.spelling },
            `callable_convert${operation.destination.ordinal}`,
            operation.provenance.span,
          )
          NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
          break
        }
        const floatTarget = Scalar.floatConversionTarget(target.operation)
        if (floatTarget !== undefined) {
          const source = Scalar.find(firstType._tag)
          if (source === undefined || source.category === 'Boolean')
            throw new RangeError('LLVM callable float conversion lost its source type')
          const destination = floatTarget.spelling === 'f32' ? f32 : f64
          let result: Value.Input
          if (source.category === 'Floating') {
            if (source.spelling === floatTarget.spelling) {
              result = first
            } else {
              result = Emitter.cast(
                body,
                source.spelling === 'f64' ? 'fptrunc' : 'fpext',
                first,
                destination,
                `callable_convert${operation.destination.ordinal}`,
              )
            }
          } else {
            result = Emitter.cast(
              body,
              source.signedness === 'Signed' ? 'sitofp' : 'uitofp',
              first,
              destination,
              `callable_convert${operation.destination.ordinal}`,
            )
          }
          NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
          break
        }
        if (target.operation === 'Negate' && Scalar.find(firstType._tag)?.category === 'Floating') {
          const result = Emitter.unary(
            body,
            'fneg',
            first,
            `callable_fneg${operation.destination.ordinal}`,
          )
          NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
          break
        }
        if (
          target.operation === 'Not' ||
          target.operation === 'Negate' ||
          target.operation === 'WrappingNegate' ||
          target.operation === 'SaturatingNegate' ||
          target.operation === 'BitNot'
        ) {
          const firstLane = NativeType.valueLanesFor(types, firstType).at(0)
          if (firstLane === undefined)
            throw new RangeError('LLVM callable unary operation lost its lane')
          const operandType = NativeType.laneType(types, firstLane)
          const zero = Emitter.integerSigned(builder, operandType, 0n)
          if (target.operation !== 'Not') {
            let unaryOperator: Mir.BinaryOperator
            switch (target.operation) {
              case 'Negate':
                unaryOperator = 'Subtract'
                break
              case 'WrappingNegate':
                unaryOperator = 'WrappingSubtract'
                break
              case 'SaturatingNegate':
                unaryOperator = 'SaturatingSubtract'
                break
              case 'BitNot':
                unaryOperator = 'BitXor'
                break
            }
            const right =
              target.operation === 'BitNot'
                ? Emitter.integerSigned(builder, operandType, -1n)
                : first
            const values = [
              NativeArith.emitCallableBinary(
                arith,
                unaryOperator,
                target.operation === 'BitNot' ? first : zero,
                right,
                firstType,
                operation.provenance.span,
                operation.destination.ordinal,
              ),
            ]
            NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
            break
          }
          const boolZero = Emitter.integerSigned(builder, i32, 0n)
          const flag = Emitter.integerCompare(
            body,
            'eq',
            first,
            boolZero,
            `callable_not${operation.destination.ordinal}_flag`,
          )
          const values = [
            Emitter.cast(body, 'zext', flag, i32, `callable_not${operation.destination.ordinal}`),
          ]
          NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
          break
        }
        const second = supplied.at(1)
        if (
          second === undefined ||
          target.operation === 'StorageAcquire' ||
          !Mir.isBinaryOperator(target.operation)
        ) {
          throw new RangeError(
            `LLVM callable builtin ${target.actor}.${target.operation} is unavailable`,
          )
        }
        const values = [
          NativeArith.emitCallableBinary(
            arith,
            target.operation,
            first,
            second,
            firstType,
            operation.provenance.span,
            operation.destination.ordinal,
          ),
        ]
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, values)
        break
      }
      if (callableTarget === undefined) throw new RangeError('Callable target lost its declaration')
      // Callable application has the same completion boundary as an ordinary source call.
      const handle = callableTarget.suspendable ? callableTarget.driver : callableTarget.handle
      if (handle === undefined)
        throw new RangeError('Backend callable application lost its completion driver')
      const resultAddress = NativeResult.allocate(
        body,
        callableTarget,
        `callable${operation.destination.ordinal}_result`,
      )
      const called = Emitter.callDirect(
        body,
        handle,
        NativeResult.argumentsFor(
          callableTarget,
          NativeCall.lowerArguments(call.synchronous, callableTarget, arguments_),
          resultAddress,
        ),
        `callable${operation.destination.ordinal}`,
      )
      // A never-returning callback may inhabit a wider join result type. It produces no
      // payload to store; the enclosing MIR control flow owns its unreachable terminator.
      if (callableTarget.fn.result._tag === 'Bottom') break
      const result = NativeResult.readValue(
        body,
        callableTarget,
        called,
        resultAddress,
        `callable${operation.destination.ordinal}`,
      )
      for (const root of [...nativeStorage.addressRoots].sort((left, right) => left - right)) {
        NativeStorage.reloadAddressRoot(nativeStorage, root)
      }
      NativeStorage.writeValue(
        nativeStorage,
        operation.destination,
        NativeDiagnosticOutcome.accept(call.synchronous.diagnostic, operation.destination, result),
      )
      break
    }
    case 'Call': {
      const target = FunctionIndex.nativeCandidates(declared, operation.target).find((candidate) =>
        Mir.matchesCall(
          candidate.fn,
          operation.target,
          operation.typeArguments,
          operation.staticArguments,
          operation.type,
        ),
      )
      if (target === undefined) {
        throw new RangeError(`Backend cannot resolve call target ${operation.target.name}`)
      }
      // An ordinary call has no suspension control: a suspendable target is driven to
      // completion here, the way the machine root drives the entry.
      const handle = target.suspendable ? target.driver : target.handle
      if (handle === undefined)
        throw new RangeError(
          `Backend cannot drive suspendable call target ${operation.target.name}`,
        )
      const resultAddress = NativeResult.allocate(
        body,
        target,
        `t${operation.destination.ordinal}_result`,
      )
      const result = Emitter.callDirect(
        body,
        handle,
        NativeResult.argumentsFor(
          target,
          NativeCall.lowerArguments(
            call.synchronous,
            target,
            NativeArgument.fromLocals(nativeStorage, operation.arguments),
          ),
          resultAddress,
        ),
        `t${operation.destination.ordinal}`,
      )
      if (target.fn.result._tag === 'Bottom') break
      for (const root of [...nativeStorage.addressRoots].sort((left, right) => left - right)) {
        NativeStorage.reloadAddressRoot(nativeStorage, root)
      }
      if (target.resultLaneCount === 0) {
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [])
        break
      }
      if (result === undefined && target.resultStorage === undefined)
        throw new RangeError('Backend call produced no value')
      if (result !== undefined) {
        const instruction = Emitter.valueInstruction(body, result)
        NativeDebug.locate(debug, operation.provenance.span, instruction)
      }
      const unpacked = NativeResult.readValue(
        body,
        target,
        result,
        resultAddress,
        `t${operation.destination.ordinal}`,
      )
      NativeStorage.writeValue(
        nativeStorage,
        operation.destination,
        NativeDiagnosticOutcome.accept(
          call.synchronous.diagnostic,
          operation.destination,
          unpacked,
        ),
      )
      break
    }
  }
  context.state.checkOrdinal = checkOrdinal
}
