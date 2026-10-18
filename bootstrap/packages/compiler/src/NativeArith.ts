import * as Emitter from '@silklang/llvm/Emitter'
import * as FunctionBody from '@silklang/llvm/FunctionBody'
import * as Intrinsic from '@silklang/llvm/Intrinsic'
import * as LlvmType from '@silklang/llvm/Type'
import * as Value from '@silklang/llvm/Value'
import type * as Layout from './Layout.js'
import * as Mir from './Mir.js'
import * as NativeDebug from './NativeDebug.js'
import * as NativeTermination from './NativeTermination.js'
import * as NativeType from './NativeType.js'
import * as Scalar from './Scalar.js'
import type * as SourceSpan from './SourceSpan.js'

export interface LaneContext {
  readonly body: Emitter.Body
  readonly pointerBits: 32 | 64
  readonly i32: LlvmType.Type
  readonly integerTypes: ReadonlyMap<number, LlvmType.Type>
  readonly types: NativeType.LoweringContext
}

/** Reinterprets and resizes one physical ABI lane without changing its semantic bits. */
export const coerceLane = (
  context: LaneContext,
  input: Value.Input,
  source: Layout.CallingLane,
  target: Layout.CallingLane,
  name: string,
): Value.Input => {
  const sourceIsAddress = typeof source.type !== 'string'
  const targetIsAddress = typeof target.type !== 'string'
  if (sourceIsAddress && targetIsAddress) return input
  const scalarBits = (lane: Layout.CallingLane): number => {
    if (typeof lane.type !== 'string') {
      return context.pointerBits
    }
    const scalar = Scalar.find(lane.type) ?? Scalar.defaultInteger
    return scalar.category === 'Boolean' ? 32 : Scalar.bits(scalar, context.pointerBits)
  }
  const sourceBits = scalarBits(source)
  const targetBits = scalarBits(target)
  const sourceScalar = typeof source.type === 'string' ? Scalar.find(source.type) : undefined
  const targetScalar = typeof target.type === 'string' ? Scalar.find(target.type) : undefined
  const sourceFloating = sourceScalar?.category === 'Floating'
  const targetFloating = targetScalar?.category === 'Floating'
  const sourceIntegerType = context.integerTypes.get(sourceBits) ?? context.i32
  const targetIntegerType = context.integerTypes.get(targetBits) ?? context.i32
  if (
    !sourceIsAddress &&
    !targetIsAddress &&
    sourceBits === targetBits &&
    sourceFloating === targetFloating
  )
    return input
  let bits: Value.Input
  if (sourceIsAddress) {
    bits = Emitter.cast(context.body, 'ptrtoint', input, sourceIntegerType, `${name}_bits`)
  } else if (sourceFloating) {
    bits = Emitter.cast(context.body, 'bitcast', input, sourceIntegerType, `${name}_bits`)
  } else {
    bits = input
  }
  if (sourceBits !== targetBits)
    bits = Emitter.cast(
      context.body,
      targetBits > sourceBits ? 'zext' : 'trunc',
      bits,
      targetIntegerType,
      `${name}_width`,
    )
  if (targetIsAddress)
    return Emitter.cast(
      context.body,
      'inttoptr',
      bits,
      NativeType.laneType(context.types, target),
      name,
    )
  return targetFloating
    ? Emitter.cast(context.body, 'bitcast', bits, NativeType.laneType(context.types, target), name)
    : bits
}

export type IntegerPredicate =
  | 'eq'
  | 'ne'
  | 'slt'
  | 'sle'
  | 'sgt'
  | 'sge'
  | 'ult'
  | 'ule'
  | 'ugt'
  | 'uge'

/** Selects the one LLVM integer predicate for a Silk comparison. */
export const comparisonPredicate = (
  operation: Mir.BinaryOperator,
  unsigned: boolean,
): IntegerPredicate | undefined => {
  switch (operation) {
    case 'Equals':
      return 'eq'
    case 'NotEquals':
      return 'ne'
    case 'LessThan':
      return unsigned ? 'ult' : 'slt'
    case 'LessOrEqual':
      return unsigned ? 'ule' : 'sle'
    case 'GreaterThan':
      return unsigned ? 'ugt' : 'sgt'
    case 'GreaterOrEqual':
      return unsigned ? 'uge' : 'sge'
    default:
      return undefined
  }
}

export interface OperationContext {
  readonly builder: Emitter.Module
  readonly body: Emitter.Body
  readonly program: Mir.Module
  readonly i32: LlvmType.Type
  readonly integerTypes: Map<number, LlvmType.Type>
  readonly signedOverflowSignatures: Map<
    number,
    { readonly returnType: LlvmType.Type; readonly parameters: ReadonlyArray<LlvmType.Type> }
  >
  readonly unsignedOverflowSignatures: Map<
    number,
    { readonly returnType: LlvmType.Type; readonly parameters: ReadonlyArray<LlvmType.Type> }
  >
  readonly lane: LaneContext
  readonly types: NativeType.LoweringContext
  readonly debug: NativeDebug.LocationContext
  readonly termination: NativeTermination.FunctionContext
}

export const emitCallableBinary = (
  context: OperationContext,
  operator: Mir.BinaryOperator,
  left: Value.Input,
  right: Value.Input,
  operandMirType: Mir.Type,
  span: SourceSpan.SourceSpan,
  nameOrdinal: number,
) => {
  const {
    body,
    builder,
    i32,
    debug,
    program,
    signedOverflowSignatures,
    termination,
    unsignedOverflowSignatures,
    types,
  } = context
  const leftLane = NativeType.valueLanesFor(types, operandMirType).at(0)
  if (leftLane === undefined)
    throw new RangeError('LLVM callable binary operation lost its operand type')
  const semanticOperand = Mir.semanticType(operandMirType)
  const scalar = typeof semanticOperand === 'string' ? Scalar.find(semanticOperand) : undefined
  const unsigned = scalar?.signedness === 'Unsigned'
  const operandType = NativeType.laneType(types, leftLane)
  if (scalar?.category === 'Floating') {
    let predicate: FunctionBody.FloatingPredicate | undefined
    switch (operator) {
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
      const flag = Emitter.floatingCompare(
        body,
        predicate,
        left,
        right,
        `callable_fcmp${nameOrdinal}_flag`,
      )
      return Emitter.cast(body, 'zext', flag, i32, `callable_fcmp${nameOrdinal}`)
    }
    let mnemonic: FunctionBody.FloatingBinaryKind | undefined
    switch (operator) {
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
      throw new RangeError(`LLVM callable float ${operator} is unavailable`)
    const result = Emitter.binary(body, mnemonic, left, right, `callable_float${nameOrdinal}`)
    NativeDebug.locate(debug, span, Emitter.valueInstruction(body, result))
    return result
  }
  const predicate = comparisonPredicate(operator, unsigned)
  if (predicate !== undefined) {
    const flag = Emitter.integerCompare(
      body,
      predicate,
      left,
      right,
      `callable_cmp${nameOrdinal}_flag`,
    )
    const widened = Emitter.cast(body, 'zext', flag, i32, `callable_cmp${nameOrdinal}`)
    NativeDebug.locate(debug, span, Emitter.valueInstruction(body, flag))
    return widened
  }
  if (
    operator === 'BitAnd' ||
    operator === 'BitOr' ||
    operator === 'BitXor' ||
    operator === 'WrappingAdd' ||
    operator === 'WrappingSubtract' ||
    operator === 'WrappingMultiply'
  ) {
    let opcode: 'and' | 'or' | 'xor' | 'add' | 'sub' | 'mul'
    switch (operator) {
      case 'BitAnd':
        opcode = 'and'
        break
      case 'BitOr':
        opcode = 'or'
        break
      case 'BitXor':
        opcode = 'xor'
        break
      case 'WrappingAdd':
        opcode = 'add'
        break
      case 'WrappingSubtract':
        opcode = 'sub'
        break
      case 'WrappingMultiply':
        opcode = 'mul'
        break
    }
    const result = Emitter.binary(body, opcode, left, right, `callable_integer${nameOrdinal}`)
    NativeDebug.locate(debug, span, Emitter.valueInstruction(body, result))
    return result
  }
  if (operator === 'ShiftLeft' || operator === 'ShiftRight') {
    const trapBlock = NativeTermination.trapBlock(termination, 'invalid shift count', span)
    let width: number
    if (scalar === undefined) {
      width = 32
    } else {
      width = Scalar.bits(scalar, program.layout.target.pointerSize === 4 ? 32 : 64)
    }
    const limit = Emitter.integerUnsigned(builder, operandType, BigInt(width))
    const invalid = Emitter.integerCompare(
      body,
      'uge',
      right,
      limit,
      `callable_shift${nameOrdinal}_invalid`,
    )
    const continueBlock = Emitter.block(body, `callable_shift${nameOrdinal}_ok`)
    Emitter.conditionalBranch(body, invalid, trapBlock, continueBlock)
    Emitter.setInsertionPoint(body, continueBlock)
    let opcode: 'shl' | 'lshr' | 'ashr'
    if (operator === 'ShiftLeft') opcode = 'shl'
    else opcode = unsigned ? 'lshr' : 'ashr'
    const result = Emitter.binary(body, opcode, left, right, `callable_shift${nameOrdinal}`)
    NativeDebug.locate(debug, span, Emitter.valueInstruction(body, result))
    return result
  }
  if (operator === 'RotateLeft' || operator === 'RotateRight') {
    const signature = {
      returnType: operandType,
      parameters: [operandType, operandType, operandType],
    }
    const result = Emitter.intrinsicCall(
      body,
      operator === 'RotateLeft' ? 'fshl' : 'fshr',
      [operandType],
      [left, left, right],
      `callable_rotate${nameOrdinal}`,
      { signature },
    )
    if (result === undefined) throw new RangeError('LLVM callable rotate produced no value')
    NativeDebug.locate(debug, span, Emitter.valueInstruction(body, result))
    return result
  }
  if (operator === 'SaturatingAdd' || operator === 'SaturatingSubtract') {
    const signature = {
      returnType: operandType,
      parameters: [operandType, operandType],
    }
    let intrinsic: Intrinsic.Id
    switch (operator) {
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
      `callable_saturating${nameOrdinal}`,
      { signature },
    )
    if (result === undefined)
      throw new RangeError('LLVM callable saturating arithmetic produced no value')
    NativeDebug.locate(debug, span, Emitter.valueInstruction(body, result))
    return result
  }
  if (operator === 'SaturatingMultiply') {
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
      `callable_saturating${nameOrdinal}_pair`,
      { signature },
    )
    if (pair === undefined)
      throw new RangeError('LLVM callable saturating multiply produced no value')
    const wrapped = Emitter.extractValue(
      body,
      pair,
      [0],
      `callable_saturating${nameOrdinal}_wrapped`,
    )
    const overflowed = Emitter.extractValue(
      body,
      pair,
      [1],
      `callable_saturating${nameOrdinal}_overflow`,
    )
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
      const signs = Emitter.binary(
        body,
        'xor',
        left,
        right,
        `callable_saturating${nameOrdinal}_signs`,
      )
      const negative = Emitter.integerCompare(
        body,
        'slt',
        signs,
        zero,
        `callable_saturating${nameOrdinal}_negative`,
      )
      boundary = Emitter.select(
        body,
        negative,
        minimum,
        maximum,
        `callable_saturating${nameOrdinal}_boundary`,
      )
    }
    const result = Emitter.select(
      body,
      overflowed,
      boundary,
      wrapped,
      `callable_saturating${nameOrdinal}`,
    )
    NativeDebug.locate(debug, span, Emitter.valueInstruction(body, result))
    return result
  }
  let result: Value.Value
  if (operator === 'Add' || operator === 'Subtract' || operator === 'Multiply') {
    let intrinsicId: Intrinsic.Id
    switch (operator) {
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
      `callable_arith${nameOrdinal}_pair`,
      { signature: overflowSignature },
    )
    if (pair === undefined)
      throw new RangeError('Backend callable overflow intrinsic produced no value')
    result = Emitter.extractValue(body, pair, [0], `callable_arith${nameOrdinal}`)
    const overflowed = Emitter.extractValue(body, pair, [1], `callable_arith${nameOrdinal}_flag`)
    const continueBlock = Emitter.block(body, `callable_arith${nameOrdinal}_ok`)
    Emitter.conditionalBranch(
      body,
      overflowed,
      NativeTermination.trapBlock(termination, 'arithmetic overflow', span),
      continueBlock,
    )
    Emitter.setInsertionPoint(body, continueBlock)
  } else {
    const zero = Emitter.integerUnsigned(builder, operandType, 0n)
    const zeroDivisor = Emitter.integerCompare(
      body,
      'eq',
      right,
      zero,
      `callable_div${nameOrdinal}_zero`,
    )
    const continueBlock = Emitter.block(body, `callable_div${nameOrdinal}_ok`)
    const nonZero = Emitter.block(body, `callable_div${nameOrdinal}_nonzero`)
    Emitter.conditionalBranch(
      body,
      zeroDivisor,
      NativeTermination.trapBlock(termination, 'division by zero', span),
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
        `callable_div${nameOrdinal}_min`,
      )
      const negativeOneDivisor = Emitter.integerCompare(
        body,
        'eq',
        right,
        negativeOne,
        `callable_div${nameOrdinal}_negone`,
      )
      const overflowCase = Emitter.binary(
        body,
        'and',
        minimumDividend,
        negativeOneDivisor,
        `callable_div${nameOrdinal}_overflow`,
      )
      Emitter.conditionalBranch(
        body,
        overflowCase,
        NativeTermination.trapBlock(termination, 'arithmetic overflow', span),
        continueBlock,
      )
    } else {
      Emitter.branch(body, continueBlock)
    }
    Emitter.setInsertionPoint(body, continueBlock)
    let opcode: 'udiv' | 'sdiv' | 'urem' | 'srem'
    if (operator === 'Divide') opcode = unsigned ? 'udiv' : 'sdiv'
    else opcode = unsigned ? 'urem' : 'srem'
    result = Emitter.binary(body, opcode, left, right, `callable_arith${nameOrdinal}`)
  }
  NativeDebug.locate(debug, span, Emitter.valueInstruction(body, result))
  return result
}

export const emitIntegerConversion = (
  context: OperationContext,
  input: Value.Input,
  sourceType: Mir.ScalarType,
  targetType: Mir.ScalarType,
  name: string,
  span: SourceSpan.SourceSpan,
) => {
  const { body, builder, i32, integerTypes, program, termination } = context
  const source = Scalar.find(sourceType._tag)
  const target = Scalar.find(targetType._tag)
  if (
    source === undefined ||
    source.category !== 'Integer' ||
    target === undefined ||
    target.category !== 'Integer'
  )
    throw new RangeError('LLVM integer conversion lost its scalar types')
  const pointerBits = program.layout.target.pointerSize === 4 ? 32 : 64
  const sourceBits = Scalar.bits(source, pointerBits)
  const targetBits = Scalar.bits(target, pointerBits)
  const sourceRange = Scalar.range(source, pointerBits)
  const targetRange = Scalar.range(target, pointerBits)
  const physicalSource = integerTypes.get(sourceBits) ?? i32
  const physicalTarget = integerTypes.get(targetBits) ?? i32
  const checks: Array<Value.Input> = []
  if (targetRange.minimum > sourceRange.minimum) {
    checks.push(
      Emitter.integerCompare(
        body,
        source.signedness === 'Signed' ? 'slt' : 'ult',
        input,
        source.signedness === 'Signed'
          ? Emitter.integerSigned(builder, physicalSource, targetRange.minimum)
          : Emitter.integerUnsigned(builder, physicalSource, targetRange.minimum),
        `${name}_below`,
      ),
    )
  }
  if (targetRange.maximum < sourceRange.maximum) {
    checks.push(
      Emitter.integerCompare(
        body,
        source.signedness === 'Signed' ? 'sgt' : 'ugt',
        input,
        source.signedness === 'Signed'
          ? Emitter.integerSigned(builder, physicalSource, targetRange.maximum)
          : Emitter.integerUnsigned(builder, physicalSource, targetRange.maximum),
        `${name}_above`,
      ),
    )
  }
  let invalid = checks.at(0)
  for (const [ordinal, check] of checks.slice(1).entries())
    invalid = Emitter.binary(body, 'or', invalid ?? check, check, `${name}_invalid${ordinal}`)
  if (invalid !== undefined) {
    const following = Emitter.block(body, `${name}_ok`)
    Emitter.conditionalBranch(
      body,
      invalid,
      NativeTermination.trapBlock(termination, 'arithmetic overflow', span),
      following,
    )
    Emitter.setInsertionPoint(body, following)
  }
  if (sourceBits === targetBits) return input
  const extension = source.signedness === 'Signed' ? 'sext' : 'zext'
  return Emitter.cast(
    body,
    sourceBits < targetBits ? extension : 'trunc',
    input,
    physicalTarget,
    name,
  )
}
