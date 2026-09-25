import * as Emitter from '@silklang/llvm/Emitter'
import * as FunctionBody from '@silklang/llvm/FunctionBody'
import * as Intrinsic from '@silklang/llvm/Intrinsic'
import * as LlvmType from '@silklang/llvm/Type'
import * as Value from '@silklang/llvm/Value'
import * as Mir from './Mir.js'
import type { LinearOperation } from './MirLinearization.js'
import * as NativeArith from './NativeArith.js'
import * as NativeDebug from './NativeDebug.js'
import type { Context } from './NativeOperationContext.js'
import * as NativeStorage from './NativeStorage.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeTranscendental from './NativeTranscendental.js'
import * as NativeType from './NativeType.js'
import * as Scalar from './Scalar.js'
import type * as SourceSpan from './SourceSpan.js'

type Operation = Extract<
  LinearOperation,
  {
    readonly _tag:
      | 'ConvertInteger'
      | 'ConvertScalar'
      | 'ReinterpretScalar'
      | 'FloatUnary'
      | 'FloatTranscendental'
      | 'CheckedScalarOutcome'
      | 'Binary'
  }
>

/**
 * Branches to the shared trap block when a float would truncate outside the integer range or is
 * NaN instead of accepting LLVM poison from `fptosi`/`fptoui`.
 */
export const emitFloatToIntegerGuard = (
  context: Context,
  value: Value.Input,
  source: Scalar.FloatScalar,
  target: Scalar.IntegerScalar,
  name: string,
  span: SourceSpan.SourceSpan,
) => {
  const { body, builder, program } = context
  const floatType = source.spelling === 'f32' ? context.f32 : context.f64
  const pointerBits = program.layout.target.pointerSize === 4 ? 32 : 64
  const range = Scalar.range(target, pointerBits)
  const width = Scalar.bits(target, pointerBits)
  const precision = source.spelling === 'f32' ? 24 : 53
  // The first value at or above `maximum + 1` truncates out of range; that bound is a power of
  // two, exact in either float width.
  const high = Number(range.maximum + 1n)
  // Below the low bound the truncation falls under `minimum`. When `minimum - 1` is exactly
  // representable the test uses it inclusively; otherwise no float lies strictly between
  // `minimum - 1` and `minimum`, so the exclusive test against `minimum` is equivalent.
  const exactLow = target.signedness === 'Unsigned' || width <= precision
  const low = exactLow ? Number(range.minimum - 1n) : Number(range.minimum)
  const constant = source.spelling === 'f32' ? Emitter.floatFromNumber : Emitter.doubleFromNumber
  const lowConstant = constant(builder, floatType, low)
  const highConstant = constant(builder, floatType, high)
  // Unordered predicates make NaN inputs trap as well.
  const below = Emitter.floatingCompare(
    body,
    exactLow ? 'ule' : 'ult',
    value,
    lowConstant,
    `${name}_below`,
  )
  const above = Emitter.floatingCompare(body, 'uge', value, highConstant, `${name}_above`)
  const invalid = Emitter.binary(body, 'or', below, above, `${name}_invalid`)
  const continueBlock = Emitter.block(body, `${name}_ok`)
  Emitter.conditionalBranch(
    body,
    invalid,
    NativeTermination.trapBlock(context.termination, 'arithmetic overflow', span),
    continueBlock,
  )
  Emitter.setInsertionPoint(body, continueBlock)
}

export const emit = (context: Context, operation: Operation) => {
  const {
    body,
    builder,
    arith,
    debug,
    entry,
    f32,
    f64,
    i32,
    integerTypes,
    program,
    signedOverflowSignatures,
    storage: nativeStorage,
    types,
    unsignedOverflowSignatures,
  } = context
  let checkOrdinal = context.state.checkOrdinal
  switch (operation._tag) {
    case 'ConvertInteger': {
      const result = NativeArith.emitIntegerConversion(
        arith,
        NativeStorage.readScalar(nativeStorage, operation.source),
        operation.sourceType,
        operation.type,
        `convert${operation.destination.ordinal}`,
        operation.provenance.span,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
      break
    }
    case 'ConvertScalar': {
      const source = Scalar.find(operation.sourceType._tag)
      const target = Scalar.find(operation.type._tag)
      if (
        source === undefined ||
        target === undefined ||
        source.category === 'Boolean' ||
        target.category === 'Boolean'
      )
        throw new RangeError('LLVM scalar conversion lost its types')
      const sourceValue = NativeStorage.readScalar(nativeStorage, operation.source)
      if (source.category === 'Character' && target.spelling === 'u32') {
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [sourceValue])
        break
      }
      let destinationType: LlvmType.Type
      if (target.category === 'Floating') {
        if (target.spelling === 'f32') {
          destinationType = f32
        } else {
          destinationType = f64
        }
      } else {
        destinationType =
          integerTypes.get(
            Scalar.bits(target, program.layout.target.pointerSize === 4 ? 32 : 64),
          ) ?? i32
      }
      let kind: FunctionBody.CastKind
      if (source.category === 'Floating' && target.category === 'Floating') {
        if (source.spelling === 'f64') {
          kind = 'fptrunc'
        } else {
          kind = 'fpext'
        }
      } else if (source.category === 'Floating' && target.category === 'Integer') {
        emitFloatToIntegerGuard(
          context,
          sourceValue,
          source,
          target,
          `convert${operation.destination.ordinal}`,
          operation.provenance.span,
        )
        if (target.signedness === 'Signed') {
          kind = 'fptosi'
        } else {
          kind = 'fptoui'
        }
      } else if (source.category === 'Integer' && target.category === 'Floating') {
        if (source.signedness === 'Signed') {
          kind = 'sitofp'
        } else {
          kind = 'uitofp'
        }
      } else {
        throw new RangeError('LLVM scalar conversion was not numeric')
      }
      const result = Emitter.cast(
        body,
        kind,
        sourceValue,
        destinationType,
        `convert${operation.destination.ordinal}`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
      break
    }
    case 'ReinterpretScalar': {
      const targetLane = NativeType.lanesFor(types, operation.type).at(0)
      if (targetLane === undefined) throw new RangeError('LLVM reinterpretation lost its lane')
      const result = Emitter.cast(
        body,
        'bitcast',
        NativeStorage.readScalar(nativeStorage, operation.source),
        NativeType.laneType(types, targetLane),
        `reinterpret${operation.destination.ordinal}`,
      )
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
      break
    }
    case 'FloatUnary': {
      const source = Scalar.find(operation.sourceType._tag)
      if (source?.category !== 'Floating')
        throw new RangeError('LLVM float unary lost its source type')
      const subject = NativeStorage.readScalar(nativeStorage, operation.source)
      if (operation.operation === 'Negate') {
        const result = Emitter.unary(body, 'fneg', subject, `fneg${operation.destination.ordinal}`)
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
        break
      }
      if (operation.operation === 'Sqrt') {
        // IEEE-754 mandates a correctly rounded square root, so `llvm.sqrt` is
        // bit-exact on every conforming target.
        const floatType = source.spelling === 'f32' ? f32 : f64
        const signature = {
          returnType: floatType,
          parameters: [floatType],
        }
        const result = Emitter.intrinsicCall(
          body,
          'sqrt',
          [floatType],
          [subject],
          `sqrt${operation.destination.ordinal}`,
          { signature },
        )
        if (result === undefined) throw new RangeError('LLVM square root produced no value')
        NativeDebug.locate(debug, operation.provenance.span, Emitter.valueInstruction(body, result))
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
        break
      }
      const width = source.spelling === 'f32' ? 32 : 64
      const integerType = integerTypes.get(width) ?? i32
      const raw = Emitter.cast(
        body,
        'bitcast',
        subject,
        integerType,
        `floatbits${operation.destination.ordinal}`,
      )
      const fractionBits = source.spelling === 'f32' ? 23 : 52
      const exponentBits = source.spelling === 'f32' ? 8 : 11
      const exponentMask = ((1n << BigInt(exponentBits)) - 1n) << BigInt(fractionBits)
      const fractionMask = (1n << BigInt(fractionBits)) - 1n
      const zero = Emitter.integerUnsigned(builder, integerType, 0n)
      const exponentMaskValue = Emitter.integerUnsigned(builder, integerType, exponentMask)
      const fractionMaskValue = Emitter.integerUnsigned(builder, integerType, fractionMask)
      const exponent = Emitter.binary(
        body,
        'and',
        raw,
        exponentMaskValue,
        `fclass_exp${operation.destination.ordinal}`,
      )
      const fraction = Emitter.binary(
        body,
        'and',
        raw,
        fractionMaskValue,
        `fclass_frac${operation.destination.ordinal}`,
      )
      const exponentZero = Emitter.integerCompare(
        body,
        'eq',
        exponent,
        zero,
        `fclass_exp_zero${operation.destination.ordinal}`,
      )
      const exponentAll = Emitter.integerCompare(
        body,
        'eq',
        exponent,
        exponentMaskValue,
        `fclass_exp_all${operation.destination.ordinal}`,
      )
      const fractionZero = Emitter.integerCompare(
        body,
        'eq',
        fraction,
        zero,
        `fclass_frac_zero${operation.destination.ordinal}`,
      )
      let flag: Value.Input
      if (operation.operation === 'IsSignNegative') {
        flag = Emitter.integerCompare(
          body,
          'slt',
          raw,
          zero,
          `fclass_sign${operation.destination.ordinal}`,
        )
      } else if (operation.operation === 'IsNaN') {
        const fractionNonzero = Emitter.integerCompare(
          body,
          'ne',
          fraction,
          zero,
          `fclass_frac_nonzero${operation.destination.ordinal}`,
        )
        flag = Emitter.binary(
          body,
          'and',
          exponentAll,
          fractionNonzero,
          `fclass_nan${operation.destination.ordinal}`,
        )
      } else if (operation.operation === 'IsInfinite') {
        flag = Emitter.binary(
          body,
          'and',
          exponentAll,
          fractionZero,
          `fclass_inf${operation.destination.ordinal}`,
        )
      } else if (operation.operation === 'IsFinite') {
        flag = Emitter.integerCompare(
          body,
          'ne',
          exponent,
          exponentMaskValue,
          `fclass_finite${operation.destination.ordinal}`,
        )
      } else if (operation.operation === 'IsNormal') {
        const nonzero = Emitter.integerCompare(
          body,
          'ne',
          exponent,
          zero,
          `fclass_nonzero${operation.destination.ordinal}`,
        )
        const finite = Emitter.integerCompare(
          body,
          'ne',
          exponent,
          exponentMaskValue,
          `fclass_notall${operation.destination.ordinal}`,
        )
        flag = Emitter.binary(
          body,
          'and',
          nonzero,
          finite,
          `fclass_normal${operation.destination.ordinal}`,
        )
      } else {
        const fractionNonzero = Emitter.integerCompare(
          body,
          'ne',
          fraction,
          zero,
          `fclass_sub_frac${operation.destination.ordinal}`,
        )
        flag = Emitter.binary(
          body,
          'and',
          exponentZero,
          fractionNonzero,
          `fclass_sub${operation.destination.ordinal}`,
        )
      }
      const result = Emitter.cast(body, 'zext', flag, i32, `fclass${operation.destination.ordinal}`)
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
      break
    }
    case 'FloatTranscendental': {
      const i64Type = integerTypes.get(64)
      const result = NativeTranscendental.emit(
        { builder, i32, ...(i64Type === undefined ? {} : { i64: i64Type }), f32, f64 },
        body,
        operation,
        NativeStorage.readScalar(nativeStorage, operation.source),
      )
      NativeDebug.locate(debug, operation.provenance.span, Emitter.valueInstruction(body, result))
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
      break
    }
    case 'CheckedScalarOutcome': {
      const leftLocal = operation.operands.at(0)
      const rightLocal = operation.operands.at(1)
      const source = Scalar.find(operation.sourceType._tag)
      const target = Scalar.find(operation.valueType._tag)
      const characterConversion =
        operation.operation === 'CheckedConvertToChar' &&
        source?.spelling === 'u32' &&
        target?.category === 'Character'
      if (
        leftLocal === undefined ||
        source?.category !== 'Integer' ||
        (target?.category !== 'Integer' && !characterConversion)
      )
        throw new RangeError('LLVM checked scalar operation lost its scalar types')
      const left = NativeStorage.readScalar(nativeStorage, leftLocal)
      const right =
        rightLocal === undefined ? undefined : NativeStorage.readScalar(nativeStorage, rightLocal)
      const pointerBits = program.layout.target.pointerSize === 4 ? 32 : 64
      const sourceBits = Scalar.bits(source, pointerBits)
      const targetBits = Scalar.bits(target, pointerBits)
      const sourcePhysical = integerTypes.get(sourceBits) ?? i32
      const targetPhysical = integerTypes.get(targetBits) ?? i32
      const name = `checked${operation.value.ordinal}`
      let result: Value.Input
      let invalid: Value.Input
      if (characterConversion) {
        const maximum = Emitter.integerUnsigned(builder, sourcePhysical, 0x10ffffn)
        const surrogateMinimum = Emitter.integerUnsigned(builder, sourcePhysical, 0xd800n)
        const surrogateMaximum = Emitter.integerUnsigned(builder, sourcePhysical, 0xdfffn)
        const aboveMaximum = Emitter.integerCompare(body, 'ugt', left, maximum, `${name}_above`)
        const atLeastSurrogate = Emitter.integerCompare(
          body,
          'uge',
          left,
          surrogateMinimum,
          `${name}_surrogate_minimum`,
        )
        const atMostSurrogate = Emitter.integerCompare(
          body,
          'ule',
          left,
          surrogateMaximum,
          `${name}_surrogate_maximum`,
        )
        const surrogate = Emitter.binary(
          body,
          'and',
          atLeastSurrogate,
          atMostSurrogate,
          `${name}_surrogate`,
        )
        invalid = Emitter.binary(body, 'or', aboveMaximum, surrogate, `${name}_invalid`)
        result = left
      } else if (operation.operation.startsWith('CheckedConvertTo')) {
        if (target.category !== 'Integer')
          throw new RangeError('LLVM checked conversion lost its integer target')
        const sourceRange = Scalar.range(source, pointerBits)
        const targetRange = Scalar.range(target, pointerBits)
        const checks: Array<Value.Input> = []
        if (targetRange.minimum > sourceRange.minimum)
          checks.push(
            Emitter.integerCompare(
              body,
              source.signedness === 'Signed' ? 'slt' : 'ult',
              left,
              source.signedness === 'Signed'
                ? Emitter.integerSigned(builder, sourcePhysical, targetRange.minimum)
                : Emitter.integerUnsigned(builder, sourcePhysical, targetRange.minimum),
              `${name}_below`,
            ),
          )
        if (targetRange.maximum < sourceRange.maximum)
          checks.push(
            Emitter.integerCompare(
              body,
              source.signedness === 'Signed' ? 'sgt' : 'ugt',
              left,
              source.signedness === 'Signed'
                ? Emitter.integerSigned(builder, sourcePhysical, targetRange.maximum)
                : Emitter.integerUnsigned(builder, sourcePhysical, targetRange.maximum),
              `${name}_above`,
            ),
          )
        invalid =
          checks.at(0) ?? Emitter.integerUnsigned(builder, Emitter.integerType(builder, 1), 0n)
        for (const [ordinal, check] of checks.slice(1).entries())
          invalid = Emitter.binary(body, 'or', invalid, check, `${name}_invalid${ordinal}`)
        if (sourceBits === targetBits) {
          result = left
        } else {
          const extension = source.signedness === 'Signed' ? 'sext' : 'zext'
          result = Emitter.cast(
            body,
            sourceBits < targetBits ? extension : 'trunc',
            left,
            targetPhysical,
            `${name}_value`,
          )
        }
      } else if (
        operation.operation === 'CheckedAdd' ||
        operation.operation === 'CheckedSubtract' ||
        operation.operation === 'CheckedMultiply'
      ) {
        if (target.category !== 'Integer')
          throw new RangeError('LLVM checked arithmetic lost its integer target')
        if (right === undefined)
          throw new RangeError('LLVM checked arithmetic lost its right operand')
        const signatures =
          target.signedness === 'Unsigned' ? unsignedOverflowSignatures : signedOverflowSignatures
        let signature = signatures.get(targetBits)
        if (signature === undefined) {
          const i1 = Emitter.integerType(builder, 1)
          signature = {
            returnType: Emitter.structureType(builder, [targetPhysical, i1]),
            parameters: [targetPhysical, targetPhysical],
          }
          signatures.set(targetBits, signature)
        }
        let stem: 'add' | 'sub' | 'mul'
        switch (operation.operation) {
          case 'CheckedAdd':
            stem = 'add'
            break
          case 'CheckedSubtract':
            stem = 'sub'
            break
          case 'CheckedMultiply':
            stem = 'mul'
            break
        }
        const pair = Emitter.intrinsicCall(
          body,
          `${target.signedness === 'Unsigned' ? 'u' : 's'}${stem}.with.overflow`,
          [targetPhysical],
          [left, right],
          `${name}_pair`,
          { signature },
        )
        if (pair === undefined) throw new RangeError('LLVM checked arithmetic produced no outcome')
        result = Emitter.extractValue(body, pair, [0], `${name}_value`)
        invalid = Emitter.extractValue(body, pair, [1], `${name}_invalid`)
      } else if (target.category === 'Integer') {
        if (right === undefined)
          throw new RangeError('LLVM checked division lost its right operand')
        const zero = Emitter.integerUnsigned(builder, targetPhysical, 0n)
        invalid = Emitter.integerCompare(body, 'eq', right, zero, `${name}_zero`)
        if (
          target.signedness === 'Signed' &&
          (operation.operation === 'CheckedDivide' || operation.operation === 'CheckedRemainder')
        ) {
          const range = Scalar.range(target, pointerBits)
          const minimum = Emitter.integerSigned(builder, targetPhysical, range.minimum)
          const negativeOne = Emitter.integerSigned(builder, targetPhysical, -1n)
          const minimumDividend = Emitter.integerCompare(
            body,
            'eq',
            left,
            minimum,
            `${name}_minimum`,
          )
          const negativeDivisor = Emitter.integerCompare(
            body,
            'eq',
            right,
            negativeOne,
            `${name}_negative_one`,
          )
          const overflow = Emitter.binary(
            body,
            'and',
            minimumDividend,
            negativeDivisor,
            `${name}_overflow`,
          )
          invalid = Emitter.binary(body, 'or', invalid, overflow, `${name}_invalid`)
        }
        const one = Emitter.integerUnsigned(builder, targetPhysical, 1n)
        const safeRight = Emitter.select(body, invalid, one, right, `${name}_divisor`)
        let opcode: 'udiv' | 'sdiv' | 'urem' | 'srem'
        if (operation.operation === 'CheckedDivide')
          opcode = target.signedness === 'Unsigned' ? 'udiv' : 'sdiv'
        else opcode = target.signedness === 'Unsigned' ? 'urem' : 'srem'
        result = Emitter.binary(body, opcode, left, safeRight, `${name}_value`)
      } else {
        throw new RangeError('LLVM checked division lost its integer target')
      }
      const zero = Emitter.integerUnsigned(builder, i32, 0n)
      const one = Emitter.integerUnsigned(builder, i32, 1n)
      const valid = Emitter.select(body, invalid, zero, one, `${name}_valid`)
      NativeStorage.writeLocal(nativeStorage, operation.valid.ordinal, [valid])
      NativeStorage.writeLocal(nativeStorage, operation.value.ordinal, [result])
      break
    }
    case 'Binary': {
      const left = NativeStorage.readScalar(nativeStorage, operation.left)
      const right = NativeStorage.readScalar(nativeStorage, operation.right)
      const leftType = entry.fn.localTypes.at(operation.left.ordinal)
      const leftLane =
        leftType === undefined ? undefined : NativeType.valueLanesFor(types, leftType).at(0)
      if (leftType === undefined || leftLane === undefined) {
        throw new RangeError('LLVM binary operation lost its operand type')
      }
      const semanticOperand = Mir.semanticType(leftType)
      const scalar = typeof semanticOperand === 'string' ? Scalar.find(semanticOperand) : undefined
      const unsigned = scalar?.signedness === 'Unsigned'
      const operandType = NativeType.laneType(types, leftLane)
      const ordinal = checkOrdinal
      checkOrdinal += 1
      if (scalar?.category === 'Floating') {
        if (operation.operator === 'TotalOrder') {
          const width = scalar.spelling === 'f32' ? 32 : 64
          const integerType = integerTypes.get(width) ?? i32
          const leftBits = Emitter.cast(
            body,
            'bitcast',
            left,
            integerType,
            `total${ordinal}_left_bits`,
          )
          const rightBits = Emitter.cast(
            body,
            'bitcast',
            right,
            integerType,
            `total${ordinal}_right_bits`,
          )
          const zero = Emitter.integerUnsigned(builder, integerType, 0n)
          const all = Emitter.integerUnsigned(builder, integerType, (1n << BigInt(width)) - 1n)
          const sign = Emitter.integerUnsigned(builder, integerType, 1n << BigInt(width - 1))
          const key = (bits: Value.Input, side: string) => {
            const negative = Emitter.integerCompare(
              body,
              'slt',
              bits,
              zero,
              `total${ordinal}_${side}_negative`,
            )
            const mask = Emitter.select(body, negative, all, sign, `total${ordinal}_${side}_mask`)
            return Emitter.binary(body, 'xor', bits, mask, `total${ordinal}_${side}_key`)
          }
          const leftKey = key(leftBits, 'left')
          const rightKey = key(rightBits, 'right')
          const flag = Emitter.integerCompare(
            body,
            'ule',
            leftKey,
            rightKey,
            `total${ordinal}_flag`,
          )
          const result = Emitter.cast(body, 'zext', flag, i32, `total${ordinal}`)
          NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
          break
        }
        let predicate: FunctionBody.FloatingPredicate | undefined
        switch (operation.operator) {
          case 'Equals':
            predicate = 'oeq'
            break
          case 'NotEquals':
            predicate = 'une'
            break
          case 'LessThan':
            predicate = 'olt'
            break
          case 'LessOrEqual':
            predicate = 'ole'
            break
          case 'GreaterThan':
            predicate = 'ogt'
            break
          case 'GreaterOrEqual':
            predicate = 'oge'
            break
          default:
            predicate = undefined
            break
        }
        if (predicate !== undefined) {
          const flag = Emitter.floatingCompare(body, predicate, left, right, `fcmp${ordinal}_flag`)
          const result = Emitter.cast(body, 'zext', flag, i32, `fcmp${ordinal}`)
          NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
          break
        }
        let mnemonic: FunctionBody.FloatingBinaryKind | undefined
        switch (operation.operator) {
          case 'Add':
            mnemonic = 'fadd'
            break
          case 'Subtract':
            mnemonic = 'fsub'
            break
          case 'Multiply':
            mnemonic = 'fmul'
            break
          case 'Divide':
            mnemonic = 'fdiv'
            break
          case 'Remainder':
            mnemonic = 'frem'
            break
          default:
            mnemonic = undefined
            break
        }
        if (mnemonic === undefined)
          throw new RangeError(`LLVM float operation ${operation.operator} is unavailable`)
        const result = Emitter.binary(body, mnemonic, left, right, `float${ordinal}`)
        NativeDebug.locate(debug, operation.provenance.span, Emitter.valueInstruction(body, result))
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
        break
      }
      const predicate = NativeArith.comparisonPredicate(operation.operator, unsigned)
      if (predicate !== undefined) {
        const flag = Emitter.integerCompare(body, predicate, left, right, `cmp${ordinal}_flag`)
        const widened = Emitter.cast(body, 'zext', flag, i32, `cmp${ordinal}`)
        const instruction = Emitter.valueInstruction(body, flag)
        NativeDebug.locate(debug, operation.provenance.span, instruction)
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [widened])
        break
      }
      if (
        operation.operator === 'BitAnd' ||
        operation.operator === 'BitOr' ||
        operation.operator === 'BitXor' ||
        operation.operator === 'WrappingAdd' ||
        operation.operator === 'WrappingSubtract' ||
        operation.operator === 'WrappingMultiply'
      ) {
        let mnemonic: FunctionBody.BinaryKind
        switch (operation.operator) {
          case 'BitAnd':
            mnemonic = 'and'
            break
          case 'BitOr':
            mnemonic = 'or'
            break
          case 'BitXor':
            mnemonic = 'xor'
            break
          case 'WrappingAdd':
            mnemonic = 'add'
            break
          case 'WrappingSubtract':
            mnemonic = 'sub'
            break
          case 'WrappingMultiply':
            mnemonic = 'mul'
            break
        }
        const result = Emitter.binary(body, mnemonic, left, right, `integer${ordinal}`)
        NativeDebug.locate(debug, operation.provenance.span, Emitter.valueInstruction(body, result))
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
        break
      }
      if (operation.operator === 'ShiftLeft' || operation.operator === 'ShiftRight') {
        const trapBlock = NativeTermination.trapBlock(
          context.termination,
          'invalid shift count',
          operation.provenance.span,
        )
        let width: number
        if (scalar === undefined) {
          width = 32
        } else {
          width = Scalar.bits(scalar, program.layout.target.pointerSize === 4 ? 32 : 64)
        }
        const limit = Emitter.integerUnsigned(builder, operandType, BigInt(width))
        const invalid = Emitter.integerCompare(body, 'uge', right, limit, `shift${ordinal}_invalid`)
        const continueBlock = Emitter.block(body, `shift${ordinal}_ok`)
        Emitter.conditionalBranch(body, invalid, trapBlock, continueBlock)
        Emitter.setInsertionPoint(body, continueBlock)
        let opcode: 'shl' | 'lshr' | 'ashr'
        if (operation.operator === 'ShiftLeft') opcode = 'shl'
        else opcode = unsigned ? 'lshr' : 'ashr'
        const result = Emitter.binary(body, opcode, left, right, `shift${ordinal}`)
        NativeDebug.locate(debug, operation.provenance.span, Emitter.valueInstruction(body, result))
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
        break
      }
      if (operation.operator === 'RotateLeft' || operation.operator === 'RotateRight') {
        const signature = {
          returnType: operandType,
          parameters: [operandType, operandType, operandType],
        }
        const result = Emitter.intrinsicCall(
          body,
          operation.operator === 'RotateLeft' ? 'fshl' : 'fshr',
          [operandType],
          [left, left, right],
          `rotate${ordinal}`,
          { signature },
        )
        if (result === undefined) throw new RangeError('LLVM rotate produced no value')
        NativeDebug.locate(debug, operation.provenance.span, Emitter.valueInstruction(body, result))
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
        break
      }
      if (operation.operator === 'SaturatingAdd' || operation.operator === 'SaturatingSubtract') {
        const signature = {
          returnType: operandType,
          parameters: [operandType, operandType],
        }
        let intrinsic: Intrinsic.Id
        switch (operation.operator) {
          case 'SaturatingAdd':
            intrinsic = unsigned ? 'uadd.sat' : 'sadd.sat'
            break
          case 'SaturatingSubtract':
            intrinsic = unsigned ? 'usub.sat' : 'ssub.sat'
            break
        }
        const result = Emitter.intrinsicCall(
          body,
          intrinsic,
          [operandType],
          [left, right],
          `saturating${ordinal}`,
          { signature },
        )
        if (result === undefined)
          throw new RangeError('LLVM saturating arithmetic produced no value')
        NativeDebug.locate(debug, operation.provenance.span, Emitter.valueInstruction(body, result))
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
        break
      }
      if (operation.operator === 'SaturatingMultiply') {
        let bits: number
        if (scalar === undefined) {
          bits = 32
        } else {
          bits = Scalar.bits(scalar, program.layout.target.pointerSize === 4 ? 32 : 64)
        }
        const signatures = unsigned ? unsignedOverflowSignatures : signedOverflowSignatures
        let signature = signatures.get(bits)
        if (signature === undefined) {
          const i1 = Emitter.integerType(builder, 1)
          signature = {
            returnType: Emitter.structureType(builder, [operandType, i1]),
            parameters: [operandType, operandType],
          }
          signatures.set(bits, signature)
        }
        const pair = Emitter.intrinsicCall(
          body,
          unsigned ? 'umul.with.overflow' : 'smul.with.overflow',
          [operandType],
          [left, right],
          `saturating${ordinal}_pair`,
          { signature },
        )
        if (pair === undefined) throw new RangeError('LLVM saturating multiply produced no value')
        const wrapped = Emitter.extractValue(body, pair, [0], `saturating${ordinal}_wrapped`)
        const overflowed = Emitter.extractValue(body, pair, [1], `saturating${ordinal}_overflow`)
        let range: { readonly minimum: bigint; readonly maximum: bigint }
        if (scalar?.category === 'Integer') {
          range = Scalar.range(scalar, program.layout.target.pointerSize === 4 ? 32 : 64)
        } else {
          range = { minimum: -2147483648n, maximum: 2147483647n }
        }
        const maximum = unsigned
          ? Emitter.integerUnsigned(builder, operandType, range.maximum)
          : Emitter.integerSigned(builder, operandType, range.maximum)
        let boundary: Value.Input = maximum
        if (!unsigned) {
          const zero = Emitter.integerSigned(builder, operandType, 0n)
          const minimum = Emitter.integerSigned(builder, operandType, range.minimum)
          const signs = Emitter.binary(body, 'xor', left, right, `saturating${ordinal}_signs`)
          const negative = Emitter.integerCompare(
            body,
            'slt',
            signs,
            zero,
            `saturating${ordinal}_negative`,
          )
          boundary = Emitter.select(
            body,
            negative,
            minimum,
            maximum,
            `saturating${ordinal}_boundary`,
          )
        }
        const result = Emitter.select(body, overflowed, boundary, wrapped, `saturating${ordinal}`)
        NativeDebug.locate(debug, operation.provenance.span, Emitter.valueInstruction(body, result))
        NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
        break
      }
      let result: Value.Value
      if (
        operation.operator === 'Add' ||
        operation.operator === 'Subtract' ||
        operation.operator === 'Multiply'
      ) {
        let intrinsicId: Intrinsic.Id
        switch (operation.operator) {
          case 'Add':
            intrinsicId = unsigned ? 'uadd.with.overflow' : 'sadd.with.overflow'
            break
          case 'Subtract':
            intrinsicId = unsigned ? 'usub.with.overflow' : 'ssub.with.overflow'
            break
          case 'Multiply':
            intrinsicId = unsigned ? 'umul.with.overflow' : 'smul.with.overflow'
            break
        }
        let bits: number
        if (scalar === undefined) {
          bits = 32
        } else {
          bits = Scalar.bits(scalar, program.layout.target.pointerSize === 4 ? 32 : 64)
        }
        const signatures = unsigned ? unsignedOverflowSignatures : signedOverflowSignatures
        let overflowSignature = signatures.get(bits)
        if (overflowSignature === undefined) {
          const i1 = Emitter.integerType(builder, 1)
          overflowSignature = {
            returnType: Emitter.structureType(builder, [operandType, i1]),
            parameters: [operandType, operandType],
          }
          signatures.set(bits, overflowSignature)
        }
        const pair = Emitter.intrinsicCall(
          body,
          intrinsicId,
          [operandType],
          [left, right],
          `arith${ordinal}_pair`,
          { signature: overflowSignature },
        )
        if (pair === undefined) {
          throw new RangeError('Backend overflow intrinsic produced no value')
        }
        const valuePart = Emitter.extractValue(body, pair, [0], `arith${ordinal}`)
        const overflowed = Emitter.extractValue(body, pair, [1], `arith${ordinal}_flag`)
        const continueBlock = Emitter.block(body, `arith${ordinal}_ok`)
        Emitter.conditionalBranch(
          body,
          overflowed,
          NativeTermination.trapBlock(
            context.termination,
            'arithmetic overflow',
            operation.provenance.span,
          ),
          continueBlock,
        )
        Emitter.setInsertionPoint(body, continueBlock)
        result = valuePart
      } else {
        const zero = Emitter.integerUnsigned(builder, operandType, 0n)
        const zeroDivisor = Emitter.integerCompare(body, 'eq', right, zero, `div${ordinal}_zero`)
        const continueBlock = Emitter.block(body, `div${ordinal}_ok`)
        const nonZero = Emitter.block(body, `div${ordinal}_nonzero`)
        Emitter.conditionalBranch(
          body,
          zeroDivisor,
          NativeTermination.trapBlock(
            context.termination,
            'division by zero',
            operation.provenance.span,
          ),
          nonZero,
        )
        Emitter.setInsertionPoint(body, nonZero)
        if (!unsigned) {
          const minimum = Emitter.integerSigned(
            builder,
            operandType,
            scalar?.category === 'Integer'
              ? Scalar.range(scalar, program.layout.target.pointerSize === 4 ? 32 : 64).minimum
              : -2147483648n,
          )
          const negativeOne = Emitter.integerSigned(builder, operandType, -1n)
          const minimumDividend = Emitter.integerCompare(
            body,
            'eq',
            left,
            minimum,
            `div${ordinal}_min`,
          )
          const negativeOneDivisor = Emitter.integerCompare(
            body,
            'eq',
            right,
            negativeOne,
            `div${ordinal}_negone`,
          )
          const overflowCase = Emitter.binary(
            body,
            'and',
            minimumDividend,
            negativeOneDivisor,
            `div${ordinal}_overflow`,
          )
          Emitter.conditionalBranch(
            body,
            overflowCase,
            NativeTermination.trapBlock(
              context.termination,
              'arithmetic overflow',
              operation.provenance.span,
            ),
            continueBlock,
          )
        } else {
          Emitter.branch(body, continueBlock)
        }
        Emitter.setInsertionPoint(body, continueBlock)
        let opcode: 'udiv' | 'sdiv' | 'urem' | 'srem'
        if (operation.operator === 'Divide') opcode = unsigned ? 'udiv' : 'sdiv'
        else opcode = unsigned ? 'urem' : 'srem'
        result = Emitter.binary(body, opcode, left, right, `arith${ordinal}`)
      }
      const instruction = Emitter.valueInstruction(body, result)
      NativeDebug.locate(debug, operation.provenance.span, instruction)
      NativeStorage.writeLocal(nativeStorage, operation.destination.ordinal, [result])
      break
    }
  }
  context.state.checkOrdinal = checkOrdinal
}
