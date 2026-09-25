import * as Effect from 'effect/Effect'
import * as Result from 'effect/Result'
import type * as Builder from '../Builder.js'
import type * as ByteString from '../ByteString.js'
import * as Constant from '../Constant.js'
import * as FastMathActor from '../FastMath.js'
import * as IntegerMath from '../IntegerMath.js'
import type * as FunctionBodyDescription from '../internal/FunctionBodyDescription.js'
import * as FunctionBodyState from '../internal/FunctionBodyState.js'
import { invalidInput, invalidState, type LlvmError } from '../LlvmError.js'
import * as Type from '../Type.js'
import type * as Value from '../Value.js'
import { type FastMathInput, type FunctionBody, fastMath, sameOperands } from './_internal.js'

/**
 * Integer arithmetic operation names accepted by {@link binary}.
 *
 * @category instructions
 * @since 0.0.0
 */
export type IntegerBinaryKind = FunctionBodyDescription.IntegerBinaryKind

/**
 * Floating arithmetic operation names accepted by {@link binary}.
 *
 * @category instructions
 * @since 0.0.0
 */
export type FloatingBinaryKind = FunctionBodyDescription.FloatingBinaryKind

/**
 * Every arithmetic operation name accepted by {@link binary}.
 *
 * @category instructions
 * @since 0.0.0
 */
export type BinaryKind = FunctionBodyDescription.BinaryKind

/**
 * LLVM integer comparison predicates.
 *
 * @category instructions
 * @since 0.0.0
 */
export type IntegerPredicate = FunctionBodyDescription.IntegerPredicate

/**
 * LLVM floating-point comparison predicates.
 *
 * @category instructions
 * @since 0.0.0
 */
export type FloatingPredicate = FunctionBodyDescription.FloatingPredicate

/**
 * Optional arithmetic promises accepted by {@link binary}.
 *
 * @category instructions
 * @since 0.0.0
 */
export interface BinaryOptions {
  readonly noSignedWrap?: boolean
  readonly noUnsignedWrap?: boolean
  readonly exact?: boolean
  readonly fastMath?: FastMathInput
  readonly integerMath?: IntegerMath.Input
}

/**
 * Appends a type-checked integer or floating binary instruction.
 *
 * **Gotchas**
 *
 * Both operands must have one type. Fast-math flags are limited to floating operations, `exact` to
 * division and right shifts, and no-wrap promises to add, subtract, multiply, and left shift.
 *
 * **Example** (Building an addition)
 *
 * Define an `i32` function that adds its two parameters.
 *
 * ```ts
 * import * as Effect from 'effect/Effect'
 * import * as Block from '@silklang/llvm/Block'
 * import * as Builder from '@silklang/llvm/Builder'
 * import * as FunctionActor from '@silklang/llvm/Function'
 * import * as FunctionBody from '@silklang/llvm/FunctionBody'
 * import * as Type from '@silklang/llvm/Type'
 * import * as Value from '@silklang/llvm/Value'
 *
 * await Effect.runPromise(Effect.gen(function* () {
 *   const builder = yield* Builder.make()
 *   const i32 = yield* Type.integer(builder, 32)
 *   const signature = yield* Type.functionType(builder, i32, [i32, i32])
 *   const add = yield* FunctionActor.declare(builder, 'add', signature)
 *   yield* FunctionActor.buildBody(builder, add, Effect.fnUntraced(function* (body) {
 *     yield* Block.make(body, 'entry')
 *     const left = yield* Value.argument(body, 0)
 *     const right = yield* Value.argument(body, 1)
 *     const sum = yield* FunctionBody.binary(body, 'add', left, right, 'sum')
 *     yield* FunctionBody.returnValue(body, sum)
 *   }))
 * }))
 * ```
 *
 * @category instructions
 * @since 0.0.0
 */
export const binary = (
  self: FunctionBody,
  kind: BinaryKind,
  left: Value.Input,
  right: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: BinaryOptions = {},
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.binary', (draft) =>
    binaryIn(draft, kind, left, right, name, options),
  )

/** @internal */
export const binaryIn = (
  draft: FunctionBodyState.Draft,
  kind: BinaryKind,
  left: Value.Input,
  right: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: BinaryOptions = {},
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.binary'
  const operands = sameOperands(draft, module, left, right, operation)
  if (Result.isFailure(operands)) return Result.fail(operands.failure)
  const floating = kind.startsWith('f')
  const integerMath = IntegerMath.make(
    options.integerMath ?? {
      noSignedWrap: options.noSignedWrap,
      noUnsignedWrap: options.noUnsignedWrap,
      exact: options.exact,
    },
  )
  const valid = floating
    ? FunctionBodyState.isFloatingType(module, operands.success.leftValue.type, operation)
    : FunctionBodyState.isIntegerType(module, operands.success.leftValue.type, operation)
  if (Result.isFailure(valid)) return Result.fail(valid.failure)
  if (!valid.success) {
    return Result.fail(
      invalidInput({
        operation,
        message: `${kind} has incompatible operand types`,
        input: { left, right },
      }),
    )
  }
  const math = fastMath(options.fastMath)
  if (!floating && FastMathActor.toBitcode(math) !== 0) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'Fast-math flags only apply to floating-point binary operations',
        input: kind,
      }),
    )
  }
  if (integerMath.exact && !exactKinds.includes(kind)) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'The exact flag is only valid on division and right shifts',
        input: kind,
      }),
    )
  }
  if ((integerMath.noSignedWrap || integerMath.noUnsignedWrap) && !wrapKinds.includes(kind)) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'No-wrap flags are only valid on add, sub, mul, and shl',
        input: kind,
      }),
    )
  }
  const { leftValue, rightValue } = operands.success
  const integerFlags =
    integerFlagSets[
      (integerMath.noSignedWrap ? 1 : 0) |
        (integerMath.noUnsignedWrap ? 2 : 0) |
        (integerMath.exact ? 4 : 0)
    ] ?? integerMath
  const appended = FunctionBodyState.appendResult(
    draft,
    leftValue.type,
    name,
    (result, finalName) => ({
      _tag: 'Binary',
      kind,
      left: leftValue.operand,
      right: rightValue.operand,
      integerFlags,
      fastMath: math,
      result,
      name: finalName,
    }),
  )
  return appended
}

const exactKinds: ReadonlyArray<BinaryKind> = ['udiv', 'sdiv', 'lshr', 'ashr']
const wrapKinds: ReadonlyArray<BinaryKind> = ['add', 'sub', 'mul', 'shl']

/** Shared flag records indexed by `noSignedWrap | noUnsignedWrap << 1 | exact << 2`. */
const integerFlagSets: ReadonlyArray<FunctionBodyDescription.IntegerFlags> = Array.from(
  { length: 8 },
  (_, bits) => ({
    noSignedWrap: (bits & 1) !== 0,
    noUnsignedWrap: (bits & 2) !== 0,
    exact: (bits & 4) !== 0,
  }),
)

/** @internal */
const integerOperandType = Effect.fnUntraced(function* (
  self: FunctionBody,
  operand: Value.Input,
): Effect.fn.Return<{ readonly builder: Builder.Builder; readonly type: Type.Type }, LlvmError> {
  return yield* FunctionBodyState.mutateModule(self, 'FunctionBody.integerUnary', (draft, module) =>
    Result.gen(function* () {
      const resolved = yield* FunctionBodyState.resolveOperand(
        draft,
        module,
        operand,
        'FunctionBody.integerUnary',
      )
      const description = yield* FunctionBodyState.typeAt(
        module,
        resolved.type,
        'FunctionBody.integerUnary',
      )
      const scalar =
        description._tag === 'Vector'
          ? yield* FunctionBodyState.typeAt(module, description.child, 'FunctionBody.integerUnary')
          : description
      if (scalar._tag !== 'Integer') {
        return yield* Result.fail(
          invalidInput({
            operation: 'FunctionBody.integerUnary',
            message: 'Integer unary operations require an integer scalar or vector',
            input: operand,
          }),
        )
      }
      const type = module.types.handles[resolved.type]
      if (type === undefined) {
        return yield* Result.fail(
          invalidState({
            operation: 'FunctionBody.integerUnary',
            message: 'Operand type handle is missing',
            state: operand,
          }),
        )
      }
      return { builder: draft.builder, type }
    }),
  )
})

/**
 * Appends integer negation as subtraction from a same-typed zero constant.
 *
 * @category instructions
 * @since 0.0.0
 */
export const negate = Effect.fnUntraced(function* (
  self: FunctionBody,
  operand: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Value.Value, LlvmError> {
  const context = yield* integerOperandType(self, operand)
  const zero = yield* Constant.zero(context.builder, context.type)
  return yield* binary(self, 'sub', zero, operand, name)
})

/**
 * Appends integer bitwise complement as XOR with a same-shaped all-ones constant.
 *
 * @category instructions
 * @since 0.0.0
 */
export const bitwiseNot = Effect.fnUntraced(function* (
  self: FunctionBody,
  operand: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.fn.Return<Value.Value, LlvmError> {
  const context = yield* integerOperandType(self, operand)
  const tag = yield* Type.tag(context.builder, context.type)
  const allOnes =
    tag === 'Vector'
      ? yield* Constant.splat(
          context.builder,
          context.type,
          yield* Constant.integerSigned(
            context.builder,
            yield* Type.childType(context.builder, context.type),
            -1,
          ),
        )
      : yield* Constant.integerSigned(context.builder, context.type, -1)
  return yield* binary(self, 'xor', operand, allOnes, name)
})

/**
 * Appends `icmp`, returning `i1` or a same-shaped vector of `i1`.
 *
 * @category instructions
 * @since 0.0.0
 */
export const integerCompare = (
  self: FunctionBody,
  predicate: IntegerPredicate,
  left: Value.Input,
  right: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.integerCompare', (draft) =>
    integerCompareIn(draft, predicate, left, right, name),
  )

/** @internal */
export const integerCompareIn = (
  draft: FunctionBodyState.Draft,
  predicate: IntegerPredicate,
  left: Value.Input,
  right: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.integerCompare'
  const operands = sameOperands(draft, module, left, right, operation)
  if (Result.isFailure(operands)) return Result.fail(operands.failure)
  const { leftValue, rightValue } = operands.success
  const valid = FunctionBodyState.isIntegerType(module, leftValue.type, operation)
  if (Result.isFailure(valid)) return Result.fail(valid.failure)
  if (!valid.success) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'icmp requires integer scalar or vector operands',
        input: { left, right },
      }),
    )
  }
  const type = FunctionBodyState.comparisonType(draft, module, leftValue.type)
  if (Result.isFailure(type)) return Result.fail(type.failure)
  const math = FastMathActor.none
  const appended = FunctionBodyState.appendResult(
    draft,
    type.success,
    name,
    (result, finalName) => ({
      _tag: 'Compare',
      kind: 'integer',
      predicate,
      left: leftValue.operand,
      right: rightValue.operand,
      fastMath: math,
      result,
      name: finalName,
    }),
  )
  return appended
}

/**
 * Appends fast-math-aware `fcmp`, returning `i1` or a same-shaped vector of `i1`.
 *
 * @category instructions
 * @since 0.0.0
 */
export const floatingCompare = (
  self: FunctionBody,
  predicate: FloatingPredicate,
  left: Value.Input,
  right: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: { readonly fastMath?: FastMathInput } = {},
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.floatingCompare', (draft) =>
    floatingCompareIn(draft, predicate, left, right, name, options),
  )

/** @internal */
export const floatingCompareIn = (
  draft: FunctionBodyState.Draft,
  predicate: FloatingPredicate,
  left: Value.Input,
  right: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: { readonly fastMath?: FastMathInput } = {},
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.floatingCompare'
  const operands = sameOperands(draft, module, left, right, operation)
  if (Result.isFailure(operands)) return Result.fail(operands.failure)
  const { leftValue, rightValue } = operands.success
  const valid = FunctionBodyState.isFloatingType(module, leftValue.type, operation)
  if (Result.isFailure(valid)) return Result.fail(valid.failure)
  if (!valid.success) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'fcmp requires floating-point scalar or vector operands',
        input: { left, right },
      }),
    )
  }
  const type = FunctionBodyState.comparisonType(draft, module, leftValue.type)
  if (Result.isFailure(type)) return Result.fail(type.failure)
  const math = fastMath(options.fastMath)
  const appended = FunctionBodyState.appendResult(
    draft,
    type.success,
    name,
    (result, finalName) => ({
      _tag: 'Compare',
      kind: 'floating',
      predicate,
      left: leftValue.operand,
      right: rightValue.operand,
      fastMath: math,
      result,
      name: finalName,
    }),
  )
  return appended
}

/**
 * Appends scalar or shape-matched vector `select` after validating its `i1` condition.
 *
 * @category instructions
 * @since 0.0.0
 */
export const select = (
  self: FunctionBody,
  condition: Value.Input,
  onTrue: Value.Input,
  onFalse: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: { readonly fastMath?: FastMathInput } = {},
): Effect.Effect<Value.Value, LlvmError> =>
  FunctionBodyState.mutate(self, 'FunctionBody.select', (draft) =>
    selectIn(draft, condition, onTrue, onFalse, name, options),
  )

/** @internal */
export const selectIn = (
  draft: FunctionBodyState.Draft,
  condition: Value.Input,
  onTrue: Value.Input,
  onFalse: Value.Input,
  name?: ByteString.ByteString | Uint8Array | string,
  options: { readonly fastMath?: FastMathInput } = {},
): Result.Result<Value.Value, LlvmError> => {
  const module = draft.module
  const operation = 'FunctionBody.select'
  const choices = sameOperands(draft, module, onTrue, onFalse, operation)
  if (Result.isFailure(choices)) return Result.fail(choices.failure)
  const { leftValue, rightValue } = choices.success
  const selected = FunctionBodyState.resolveOperand(draft, module, condition, operation)
  if (Result.isFailure(selected)) return Result.fail(selected.failure)
  const conditionType = FunctionBodyState.typeAt(module, selected.success.type, operation)
  if (Result.isFailure(conditionType)) return Result.fail(conditionType.failure)
  const conditionVector =
    conditionType.success._tag === 'Vector' ? conditionType.success : undefined
  const conditionScalar =
    conditionVector === undefined
      ? conditionType
      : FunctionBodyState.typeAt(module, conditionVector.child, operation)
  if (Result.isFailure(conditionScalar)) return Result.fail(conditionScalar.failure)
  if (conditionScalar.success._tag !== 'Integer' || conditionScalar.success.bitWidth !== 1) {
    return Result.fail(
      invalidInput({
        operation,
        message: 'select requires an i1 scalar or vector condition',
        input: condition,
      }),
    )
  }
  if (conditionVector !== undefined) {
    const choiceType = FunctionBodyState.typeAt(module, leftValue.type, operation)
    if (Result.isFailure(choiceType)) return Result.fail(choiceType.failure)
    if (
      choiceType.success._tag !== 'Vector' ||
      choiceType.success.length !== conditionVector.length ||
      choiceType.success.scalable !== conditionVector.scalable
    ) {
      return Result.fail(
        invalidInput({
          operation,
          message: 'Vector select condition and choices must have the same shape',
          input: { condition, onTrue, onFalse },
        }),
      )
    }
  }
  const math = fastMath(options.fastMath)
  if (FastMathActor.toBitcode(math) !== 0) {
    const floating = FunctionBodyState.isFloatingType(module, leftValue.type, operation)
    if (Result.isFailure(floating)) return Result.fail(floating.failure)
    if (!floating.success) {
      return Result.fail(
        invalidInput({
          operation,
          message: 'Fast-math select requires floating-point choices',
          input: { onTrue, onFalse },
        }),
      )
    }
  }
  const conditionOperand = selected.success.operand
  const appended = FunctionBodyState.appendResult(
    draft,
    leftValue.type,
    name,
    (result, finalName) => ({
      _tag: 'Select',
      condition: conditionOperand,
      onTrue: leftValue.operand,
      onFalse: rightValue.operand,
      fastMath: math,
      result,
      name: finalName,
    }),
  )
  return appended
}
